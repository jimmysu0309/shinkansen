// Probe：翻譯後「看不到的元素被攤平成看得見的文字」（sr-only「▢」、核取方塊、
// hover 才顯示的 headerlink「¶」、腳註回跳「↩」）。四站翻譯前後量同一組指標。
// 用法：node tools/probes/probe-hidden-flatten.mjs [siteKey...]
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = process.env.EXT_PATH || path.resolve(__dirname, '..', '..', 'shinkansen');
const PROFILE = path.resolve(os.tmpdir(), 'shinkansen-probe-hidden-profile'); // 專用 profile，key 由下方種入

const SITES = {
  woks: 'https://thewoksoflife.com/beef-with-broccoli-all-purpose-stir-fry-sauce/',
  qiita: 'https://qiita.com/Qiita/items/c686397e4a0f4f11683d',
  python: 'https://docs.python.org/3/tutorial/introduction.html',
  squidfunk: 'https://squidfunk.github.io/mkdocs-material/setup/changing-the-colors/',
};
const pick = process.argv.slice(2);
const keys = pick.length ? pick : Object.keys(SITES);

const step = (...a) => console.error('[step]', new Date().toISOString().slice(11, 19), ...a);
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + label)), ms))]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getIsolatedEvaluator(page) {
  const cdp = await page.context().newCDPSession(page);
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
  await cdp.send('Runtime.enable');
  await sleep(800);
  const target = contexts.filter((c) => c?.auxData?.type === 'isolated')
    .find((c) => /Shinkansen/i.test(c.name || ''));
  if (!target) throw new Error('找不到 Shinkansen isolated world');
  return async (expr) => {
    const res = await cdp.send('Runtime.evaluate', {
      expression: expr, contextId: target.id, returnByValue: true, awaitPromise: true,
    });
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
    return res.result.value;
  };
}

// 量測：在 main world 跑（只讀 DOM）
const MEASURE = () => {
  const visibleText = (ch) => {
    let n = 0; const samples = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = w.nextNode())) {
      if (!t.nodeValue.includes(ch)) continue;
      const p = t.parentElement;
      if (!p || !p.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      // sr-only：元素自身 1×1 + clip；往上找任一祖先 ≤1px 就算看不到
      let hidden = false;
      for (let e = p; e && e !== document.body; e = e.parentElement) {
        const rr = e.getBoundingClientRect();
        if (rr.width <= 1 || rr.height <= 1) { hidden = true; break; }
      }
      if (hidden) continue;
      n++;
      if (samples.length < 3) samples.push(p.tagName + '.' + (p.className || '') + ': ' + (p.closest('li,p,h1,h2,h3,h4,h5,h6,div')?.innerText || '').slice(0, 60));
    }
    return { n, samples };
  };
  return {
    checkbox: document.querySelectorAll('input[type=checkbox]').length,
    wprmCheckbox: document.querySelectorAll('.wprm-checkbox, .wprm-checkbox-container').length,
    headerlink: document.querySelectorAll('a.headerlink').length,
    backrefLinks: [...document.querySelectorAll('a')].filter((a) => a.textContent.includes('↩')).length,
    visibleBox: visibleText('▢'),
    visiblePilcrow: visibleText('¶'),
    visibleBackref: visibleText('↩'),
    translatedCount: document.querySelectorAll('[data-shinkansen-translated]').length,
  };
};

for (const key of keys) {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-first-run', '--mute-audio'],
  });
  // 種 API key（profile 裡不一定有）+ 印目前模型
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const apiKey = fs.readFileSync(path.join(os.homedir(), '.shinkansen-test-key'), 'utf8').trim();
  await sw.evaluate((k) => new Promise((res) => chrome.storage.local.set({ apiKey: k }, res)), apiKey);
  const model = await sw.evaluate(() => new Promise((res) => chrome.storage.sync.get('geminiConfig', (r) => res(r.geminiConfig?.model || '(default)'))));
  for (const p of ctx.pages()) { try { await p.close(); } catch { /* ignore */ } }
  const page = await ctx.newPage();
  page.on('crash', () => step(key, 'PAGE CRASH'));
  page.on('close', () => step(key, 'PAGE CLOSE'));
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) step(key, 'NAV', f.url().slice(0, 100)); });
  ctx.on('page', (p2) => step(key, 'NEW PAGE', p2.url()));
  try {
    step(key, 'goto');
    await page.goto(SITES[key], { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3000);
    // 捲到底再回頂，觸發 lazy 內容
    step(key, 'scroll');
    await withTimeout(page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 1500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 80)); } window.scrollTo(0, 0); }), 30000, 'scroll');
    step(key, 'isolated');
    // Debug Bridge 是 main ↔ isolated 的 CustomEvent，main world 直接派送即可
    //（isolated world 的 CDP evaluate 在 qiita 上會無回應卡住）
    const bridge = (action) => withTimeout(page.evaluate((a) => new Promise((resolve) => {
      window.addEventListener('shinkansen-debug-response', (e) => resolve(JSON.parse(JSON.stringify(e.detail))), { once: true });
      window.dispatchEvent(new CustomEvent('shinkansen-debug-request', { detail: { action: a } }));
      setTimeout(() => resolve({ ok: false, error: 'TIMEOUT' }), 8000);
    }), action), 20000, 'bridge ' + action);
    const st0 = await bridge('GET_STATE');
    const before = await withTimeout(page.evaluate(MEASURE), 60000, 'measure-before');
    await bridge('CLEAR_CACHE');
    step(key, 'translate');
    const trRes = await bridge('TRANSLATE');
    let st;
    for (let i = 0; i < 240; i++) {
      st = await bridge('GET_STATE');
      if (st && st.translated && !st.translating) break;
      await sleep(500);
    }
    await sleep(1500);
    step(key, 'measure');
    const after = await withTimeout(page.evaluate(MEASURE), 60000, 'measure');
    // 抽一列樣本 DOM
    const sample = await page.evaluate((k) => {
      const sel = { woks: 'li.wprm-recipe-ingredient', qiita: 'li:has(input[type=checkbox]), .footnotes li, li', python: 'h2', squidfunk: 'h2' }[k];
      const el = document.querySelector(sel);
      return el ? el.outerHTML.slice(0, 700) : null;
    }, key);
    console.log(JSON.stringify({ key, model, trRes, version: st0?.version, translated: st?.translated, before, after, sample }, null, 2));
    // 目標區塊截圖（肉眼驗：勾選框、隱藏字元、錨點）
    const shotSel = { woks: '.wprm-recipe-ingredients-container', qiita: 'li:has(> input[type=checkbox])', python: 'h2', squidfunk: 'h2' }[key];
    const loc = page.locator(shotSel).first();
    if (key === 'qiita') { await loc.evaluate((e) => e.closest('ul').scrollIntoView({ block: 'center' })); await page.locator('ul:has(> li > input[type=checkbox])').first().screenshot({ path: path.resolve(__dirname, '..', '..', '.playwright-mcp', `hidden-flatten-${key}.png`) }); }
    else { await loc.scrollIntoViewIfNeeded(); await loc.screenshot({ path: path.resolve(__dirname, '..', '..', '.playwright-mcp', `hidden-flatten-${key}.png`) }); }
    if (key === 'python' || key === 'squidfunk') { await loc.hover(); await loc.screenshot({ path: path.resolve(__dirname, '..', '..', '.playwright-mcp', `hidden-flatten-${key}-hover.png`) }); }
  } catch (e) {
    console.log(key, 'ERROR', e.message);
  }
  await ctx.close();
}
