// Probe：JRead 語料庫回報的翻譯端問題，用現行版本重現（2026-11-28）。
// 每站翻譯前後量：段內 <style> 數、首段開頭、模型回話字樣、原文譯文並列、整段沒翻。
// 用法：node tools/probes/probe-jread-translate-triage.mjs [siteKey...]
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = process.env.EXT_PATH || path.resolve(__dirname, '..', '..', 'shinkansen');
const PROFILE = path.resolve(os.tmpdir(), 'shinkansen-probe-triage-profile'); // 專用 profile，key 由下方種入

const SITES = {
  enwiki: 'https://en.wikipedia.org/wiki/Large_language_model',
  guardian: 'https://www.theguardian.com/society/2026/oct/07/sugar-rations-health-blood-pressure-ageing',
  quanta: 'https://www.quantamagazine.org/the-ai-revolution-in-math-has-arrived-20260413/',
  wikihow: 'https://www.wikihow.com/Tie-a-Tie',
  arwiki: 'https://ar.wikipedia.org/wiki/%D9%82%D9%87%D9%88%D8%A9',
  aeon: 'https://aeon.co/essays/when-we-turned-time-into-a-line-we-reimagined-past-and-future',
  jest: 'https://jestjs.io/docs/getting-started',
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

const MEASURE = () => {
  const body = document.body;
  const styleInBody = body.querySelectorAll('style').length;
  const styleInRef = document.querySelectorAll('.mw-reference-text style, .reference-text style').length;
  const cs1MaintVisible = [...document.querySelectorAll('.cs1-maint')].filter((e) => e.checkVisibility()).length;
  const firstPara = (document.querySelector('article p, main p, .post__content p, [data-gu-name=body] p')?.innerText || '').slice(0, 50);
  const tr = [...document.querySelectorAll('[data-shinkansen-translated]')];
  const modelReply = tr.filter((e) => /請提供|請給我|需要翻譯的|原文是什麼|沒有提供/.test(e.innerText)).map((e) => e.innerText.slice(0, 80));
  // 原文譯文並列：譯文元素裡同時有 ≥30 個連續拉丁字母詞段與 ≥10 個 CJK 字
  const sideBySide = tr.filter((e) => {
    const t = e.innerText || '';
    const cjk = (t.match(/[一-鿿]/g) || []).length;
    const latinRun = /(?:[A-Za-z]{2,}[ ,.'’-]+){8,}/.test(t);
    return cjk >= 10 && latinRun;
  }).map((e) => e.innerText.slice(0, 120));
  // 整段沒翻：主文 p / li 有 ≥60 字母的英文、沒有 CJK、沒被標 translated、看得見
  const root = document.querySelector('main, article, #content, [role=main]') || body;
  const untranslated = [...root.querySelectorAll('p, li, h2, h3, dd, td, figcaption')].filter((e) => {
    if (e.closest('[data-shinkansen-translated], pre, code, nav, footer')) return false;
    if (e.querySelector('p, li, div')) return false;
    if (!e.checkVisibility()) return false;
    const t = (e.innerText || '').trim();
    return (t.match(/[A-Za-z]/g) || []).length >= 60 && !/[一-鿿]/.test(t);
  }).map((e) => e.tagName + ': ' + e.innerText.slice(0, 90));
  return { styleInBody, styleInRef, cs1MaintVisible, firstPara, translated: tr.length, modelReply, sideBySide: sideBySide.slice(0, 12), sideBySideCount: sideBySide.length, untranslatedCount: untranslated.length, untranslated: untranslated.slice(0, 8) };
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
  try {
    step(key, 'goto');
    await page.goto(SITES[key], { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3500);
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
    for (let i = 0; i < 360; i++) {
      st = await bridge('GET_STATE');
      if (st && st.translated && !st.translating) break;
      await sleep(500);
    }
    await sleep(2000);
    step(key, 'measure');
    const after = await withTimeout(page.evaluate(MEASURE), 60000, 'measure');
    console.log(JSON.stringify({ key, model, trRes, version: st0?.version, done: st?.translated, before: { styleInBody: before.styleInBody, styleInRef: before.styleInRef, cs1MaintVisible: before.cs1MaintVisible, firstPara: before.firstPara }, after }, null, 2));
  } catch (e) {
    console.log(key, 'ERROR', e.message);
  }
  await ctx.close();
}
