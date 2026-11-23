// probe-dual-promote-sites.mjs — 雙語模式下「整顆容器 fragment 升格」在真實網站的視覺檢查。
// 用法:node tools/probes/probe-dual-promote-sites.mjs <url> <tag>
// 流程:全新 profile、靜音、displayMode dual、lite 模型 → 翻譯前找出會被升格的容器並標記 →
//   整頁翻譯 → 對每個被升格容器(最多 6 個)捲進畫面截圖 + 回報原文是否保留 / 有無 wrapper。
// 驗:被升格段落的 DOM 形態 + 截圖(需人眼看)。不驗:未升格段落、其他網站。
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const EXT = path.join(ROOT, 'shinkansen');
const [URL, TAG = 'site'] = process.argv.slice(2);
const OUT = path.join(ROOT, '.playwright-mcp', 'dual-promote');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const prof = path.join(os.tmpdir(), 'shinkansen-probe-dp-' + Date.now());
const ctx = await chromium.launchPersistentContext(prof, {
  headless: false, viewport: { width: 1280, height: 900 }, locale: 'en-US',
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--mute-audio', '--no-first-run'],
});
try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const key = fs.readFileSync(path.join(os.homedir(), '.shinkansen-test-key'), 'utf8').trim();
  await sw.evaluate(([k]) => new Promise(r => chrome.storage.local.set({ apiKey: k }, r)), [key]);
  await sw.evaluate(() => new Promise(r => chrome.storage.sync.get('geminiConfig', (o) => {
    chrome.storage.sync.set({ displayMode: 'dual', targetLanguage: 'zh-TW',
      geminiConfig: { ...(o.geminiConfig || {}), model: 'gemini-3.1-flash-lite' } }, r);
  })));
  for (const p of ctx.pages()) await p.close().catch(() => {});
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(5000);
  const cdp = await ctx.newCDPSession(page);
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', e => contexts.push(e.context));
  await cdp.send('Runtime.enable'); await sleep(500);
  const iso = contexts.find(c => c.auxData?.type === 'isolated' && /Shinkansen/i.test(c.name || ''));
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { contextId: iso.id, expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const bridge = (action) => ev(`new Promise(res=>{const h=e=>{window.removeEventListener('shinkansen-debug-response',h);res(e.detail)};window.addEventListener('shinkansen-debug-response',h);window.dispatchEvent(new CustomEvent('shinkansen-debug-request',{detail:{action:${JSON.stringify(action)}}}));setTimeout(()=>res({timeout:true}),60000)})`);

  // 翻譯前:找出會被升格的容器(collect 時是 fragment、consolidate 後變 element 且 el 相同)
  const pre = await ev(`(() => {
    const units = window.__SK.collectParagraphs();
    const fragEls = new Set(units.filter(u => u.kind === 'fragment').map(u => u.el));
    const after = window.__SK.consolidateDualInlineUnits(units.slice());
    let n = 0; const list = [];
    for (const u of after) {
      if (u.kind === 'element' && fragEls.has(u.el)) {
        u.el.setAttribute('data-probe-promoted', String(n));
        list.push({ n, tag: u.el.tagName, text: (u.el.textContent || '').trim().slice(0, 80) });
        n++;
      }
    }
    return { units: units.length, fragments: units.filter(u => u.kind === 'fragment').length, promoted: list };
  })()`);
  console.log(`[${TAG}] units=${pre.units} fragments=${pre.fragments} promoted=${pre.promoted.length}`);

  await bridge('CLEAR_CACHE');
  await bridge('TRANSLATE');
  for (let i = 0; i < 120; i++) { const s = await bridge('GET_STATE'); if (!s.translating && s.translated) break; await sleep(1000); }
  await sleep(2000);

  const res = await ev(`(() => {
    const tag = window.__SK.TRANSLATION_WRAPPER_TAG; const out = [];
    document.querySelectorAll('[data-probe-promoted]').forEach(el => {
      // wrapper 位置:el 後 / block 祖先後
      let w = null;
      if (el.nextElementSibling?.tagName.toLowerCase() === tag) w = el.nextElementSibling;
      if (!w) { const b = window.__SK.findBlockAncestor?.(el); let s = b?.nextElementSibling; while (s && s.tagName.toLowerCase() === tag) { w = s; s = s.nextElementSibling; } }
      out.push({ n: el.getAttribute('data-probe-promoted'), tag: el.tagName, dualSource: el.hasAttribute('data-shinkansen-dual-source'),
        translatedAttr: el.hasAttribute('data-shinkansen-translated'), next: (el.nextElementSibling ? el.nextElementSibling.tagName : null), parent: el.parentElement.tagName + '.' + el.parentElement.className, cache: !!window.__SK.STATE.translationCache.get(el), cacheWrapperConnected: !!window.__SK.STATE.translationCache.get(el)?.wrapper?.isConnected, cacheMode: window.__SK.STATE.translationCache.get(el)?.insertMode, wrapRect: (() => { const w = el.nextElementSibling; if (!w) return null; const r = w.getBoundingClientRect(); const cs = getComputedStyle(w); const ci = w.firstElementChild ? getComputedStyle(w.firstElementChild) : null; return { h: Math.round(r.height), w: Math.round(r.width), display: cs.display, vis: cs.visibility, op: cs.opacity, innerTag: w.firstElementChild?.tagName, innerDisplay: ci?.display, innerColor: ci?.color, innerFont: ci?.fontSize, ovf: cs.overflow }; })(), elDisplay: getComputedStyle(el).display, text: el.textContent.trim().slice(0, 60), wrapper: w ? w.textContent.trim().slice(0, 60) : null });
    });
    return out;
  })()`);
  for (const r of res) console.log(`[${TAG}]`, JSON.stringify(r));

  await page.screenshot({ path: path.join(OUT, `${TAG}-top.png`) });
  const anc = await ev(`(() => { const out = []; document.querySelectorAll('[data-probe-promoted]').forEach(el => { const hits = []; for (const [k] of window.__SK.STATE.translatedHTML) { if (k !== el && k.contains(el)) hits.push(k.tagName + '.' + (k.className || '') + ' txt=' + (k.textContent || '').trim().slice(0, 50).replace(/\s+/g, ' ')); } out.push({ n: el.getAttribute('data-probe-promoted'), ancestorsInTranslatedHTML: hits }); }); return out; })()`);
  for (const a of anc) console.log(`[${TAG}] anc`, JSON.stringify(a));
  const pick = res.filter(r => r.dualSource).slice(0, 4);
  for (const r of pick) {
    await ev(`document.querySelector('[data-probe-promoted="${r.n}"]').scrollIntoView({block:'center'}), null`);
    await sleep(800);
    await page.screenshot({ path: path.join(OUT, `${TAG}-p${r.n}.png`) });
    const geo = await ev(`(() => { const el = document.querySelector('[data-probe-promoted="${r.n}"]'); const w = el.nextElementSibling; const a = el.getBoundingClientRect(); const b = w ? w.getBoundingClientRect() : null; const hit = b ? document.elementFromPoint(b.left + 20, b.top + b.height / 2) : null; return { elTop: Math.round(a.top), elBottom: Math.round(a.bottom), wTop: b && Math.round(b.top), wH: b && Math.round(b.height), hitTag: hit && hit.tagName, hitInWrapper: !!(hit && w && w.contains(hit)), hitText: hit && (hit.textContent || '').slice(0, 40), wHTML: w ? w.outerHTML.slice(0, 500) : null, wTag: w && w.tagName, elHTML: el.outerHTML.slice(0, 200) }; })()`);
    console.log(`[${TAG}] geo p${r.n}`, JSON.stringify(geo));
    try { await page.locator(`[data-probe-promoted="${r.n}"]`).locator('xpath=..').screenshot({ path: path.join(OUT, `${TAG}-p${r.n}-el.png`) }); } catch (e) { console.log('el shot fail', e.message.slice(0, 80)); }
  }
  const logs = await ev(`new Promise(res=>{const h=e=>{window.removeEventListener('shinkansen-debug-response',h);res(e.detail)};window.addEventListener('shinkansen-debug-response',h);window.dispatchEvent(new CustomEvent('shinkansen-debug-request',{detail:{action:'GET_LOGS',afterSeq:0}}));setTimeout(()=>res({}),20000)})`);
  fs.writeFileSync(path.join(OUT, `${TAG}-logs.json`), JSON.stringify(logs, null, 1));
  console.log(`[${TAG}] screenshots: ${pick.map(r => `${TAG}-p${r.n}.png`).join(', ')}`);
} finally {
  await ctx.close();
  fs.rmSync(prof, { recursive: true, force: true });
}
