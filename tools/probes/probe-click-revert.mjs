// probe-click-revert：翻譯完成後點擊內文，觀察譯文是否被站方還原成原文。
//   TARGET_URL=<url> node tools/probes/probe-click-revert.mjs
// 需要 ~/.shinkansen-test-key；模型固定 lite。輸出：點擊前後目標段落的文字、
// 點擊期間段落子樹的 mutation 紀錄、Shinkansen log 中 guard / restore 相關條目。
// 這支只驗「點擊後 DOM 文字是否回到原文」這一層，不驗選取行為本身（選取要真人拖曳）。
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const EXT_PATH = process.env.EXT_PATH || path.join(ROOT, 'shinkansen');
const TARGET_URL = process.env.TARGET_URL;
const PARA_SELECTOR = process.env.PARA_SELECTOR || 'article p';
const PROFILE = path.join(os.tmpdir(), 'shinkansen-probe-click-profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isolatedEvaluator(page) {
  const cdp = await page.context().newCDPSession(page);
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
  await cdp.send('Runtime.enable');
  await sleep(500);
  const t = contexts.find((c) => c?.auxData?.type === 'isolated' && /Shinkansen/i.test(c.name || ''));
  if (!t) throw new Error('找不到 Shinkansen isolated world');
  return async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { contextId: t.id, expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + '\n' + expression);
    return r.result.value;
  };
}
const bridge = (ev, action, extra = {}) => ev(`new Promise((res) => {
  const h = (e) => { window.removeEventListener('shinkansen-debug-response', h); res(e.detail); };
  window.addEventListener('shinkansen-debug-response', h);
  window.dispatchEvent(new CustomEvent('shinkansen-debug-request', { detail: Object.assign({ action: ${JSON.stringify(action)} }, ${JSON.stringify(extra)}) }));
  setTimeout(() => res({ ok: false, error: 'TIMEOUT' }), 60000);
})`);

fs.rmSync(PROFILE, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio'],
});
let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 10000 });
const key = fs.readFileSync(path.join(os.homedir(), '.shinkansen-test-key'), 'utf8').trim();
await sw.evaluate((k) => new Promise((r) => chrome.storage.local.set({ apiKey: k }, r)), key);
await sw.evaluate(() => new Promise((r) => chrome.storage.sync.set({ geminiConfig: { model: 'gemini-3.1-flash-lite' } }, r)));
for (const p of ctx.pages()) { try { await p.close(); } catch { /* ignore */ } }

const page = await ctx.newPage();
await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
await sleep(4000);
const ev = await isolatedEvaluator(page);
console.log('version', await ev('chrome.runtime.getManifest().version'));
await bridge(ev, 'CLEAR_CACHE'); await bridge(ev, 'CLEAR_LOGS');
console.log('TRANSLATE', JSON.stringify(await bridge(ev, 'TRANSLATE')));
for (let i = 0; i < 60; i++) {
  await sleep(1500);
  const s = await bridge(ev, 'GET_STATE');
  if (s && s.translated && !s.translating) break;
}
await sleep(1500);

// 主世界掛 mutation 紀錄在第一個已翻譯的目標段落
const info = await page.evaluate((sel) => {
  const ps = [...document.querySelectorAll(sel)].filter((p) => p.hasAttribute('data-shinkansen-translated') && p.textContent.length > 60);
  const p = ps[1] || ps[0];
  if (!p) return null;
  p.setAttribute('data-probe-target', '1');
  window.__muts = [];
  new MutationObserver((ms) => {
    for (const m of ms) {
      window.__muts.push({ t: Math.round(performance.now()), type: m.type,
        target: m.target.nodeName + (m.target.className && typeof m.target.className === 'string' ? '.' + m.target.className.split(' ')[0] : ''),
        added: [...m.addedNodes].map((n) => n.nodeName + ':' + (n.textContent || '').slice(0, 40)),
        removed: [...m.removedNodes].map((n) => n.nodeName + ':' + (n.textContent || '').slice(0, 40)),
        attr: m.attributeName });
    }
  }).observe(p.parentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  const r = p.getBoundingClientRect();
  return { before: p.textContent.slice(0, 120), html: p.outerHTML.slice(0, 600), name: p.getAttribute('name'), parentTag: p.parentElement.tagName };
}, PARA_SELECTOR);
console.log('TARGET', JSON.stringify(info, null, 1));
if (!info) {
  console.log('DIAG', JSON.stringify(await page.evaluate(() => ({ title: document.title, ps: document.querySelectorAll('p').length,
    tr: document.querySelectorAll('[data-shinkansen-translated]').length, art: !!document.querySelector('article'),
    sample: [...document.querySelectorAll('p')].slice(0, 6).map((p) => p.textContent.slice(0, 60)) }))));
  await page.screenshot({ path: path.join(ROOT, '.playwright-mcp', 'click-revert-after.png') });
}
if (info) {
  const loc = page.locator('[data-probe-target="1"]');
  await loc.scrollIntoViewIfNeeded();
  await sleep(500);
  const box = await loc.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + 10);
  await sleep(2500);
  const after = await page.evaluate(() => {
    const p = document.querySelector('[data-probe-target="1"]');
    const sel = getSelection();
    return { stillAttached: !!p, after: p ? p.textContent.slice(0, 120) : null,
      translatedCount: document.querySelectorAll('[data-shinkansen-translated]').length,
      muts: window.__muts.slice(0, 40), selection: sel && sel.toString().slice(0, 40) };
  });
  console.log('AFTER', JSON.stringify(after, null, 1));
  const logs = await bridge(ev, 'GET_LOGS', { afterSeq: 0 });
  const arr = (logs && (logs.logs || logs.entries)) || [];
  console.log('LOGS', JSON.stringify(arr.filter((l) => /guard|restore|spa|mutation|rescan|revert/i.test(JSON.stringify(l))).slice(-30).map((l) => [l.category || l.cat, l.message || l.msg, JSON.stringify(l.data || {}).slice(0, 200)])));
  await page.screenshot({ path: path.join(ROOT, '.playwright-mcp', 'click-revert-after.png') });
}
await ctx.close();
