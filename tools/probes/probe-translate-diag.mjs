// Probe：翻譯後抓指定段落的 DOM / 偵測結果 / 相關 log（JRead 回報的首字殘留、整段沒翻）
// 用法：node tools/probes/probe-translate-diag.mjs <url> <段落文字片段>...
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..', '..', 'shinkansen');
const PROFILE = path.resolve(os.tmpdir(), process.env.PROFILE_NAME || 'shinkansen-probe-diag-profile');
const [URL, ...needles] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: { width: 1280, height: 900 },
  args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-first-run', '--mute-audio'] });
let sw = ctx.serviceWorkers()[0]; if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
const apiKey = fs.readFileSync(path.join(os.homedir(), '.shinkansen-test-key'), 'utf8').trim();
await sw.evaluate((k) => new Promise((res) => chrome.storage.local.set({ apiKey: k }, res)), apiKey);
for (const p of ctx.pages()) { try { await p.close(); } catch {} }
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
await sleep(4000);
await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 1500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 80)); } window.scrollTo(0, 0); });
const bridge = (detail) => page.evaluate((d) => new Promise((resolve) => {
  window.addEventListener('shinkansen-debug-response', (e) => resolve(JSON.parse(JSON.stringify(e.detail))), { once: true });
  window.dispatchEvent(new CustomEvent('shinkansen-debug-request', { detail: d }));
  setTimeout(() => resolve({ ok: false, error: 'TIMEOUT' }), 8000);
}), detail);
const find = (ns) => page.evaluate((ns) => ns.map((n) => {
  const els = [...document.querySelectorAll('p, li, h1, h2, h3, h4, td, dd, figcaption, div')].filter((e) => (e.textContent || '').includes(n));
  const el = els.sort((a, b) => a.textContent.length - b.textContent.length)[0];
  return el ? { n, tag: el.tagName, attrs: [...el.attributes].map((a) => a.name + '=' + a.value.slice(0, 40)).join(' '), html: el.outerHTML.slice(0, 900) } : { n, missing: true };
}), ns);
const before = await find(needles);
const extraBefore = process.env.EVAL ? await page.evaluate(process.env.EVAL) : null;
await bridge({ action: 'CLEAR_CACHE' }); await bridge({ action: 'CLEAR_LOGS' });
// 譯前先標記目標段落，翻譯後用標記找回
await page.evaluate((ns) => ns.forEach((n, i) => {
  const els = [...document.querySelectorAll('p, li, h1, h2, h3, h4, td, dd, figcaption, div')].filter((e) => (e.textContent || '').includes(n));
  const el = els.sort((a, b) => a.textContent.length - b.textContent.length)[0];
  if (el) el.setAttribute('data-probe-mark', String(i));
}), needles);
await bridge({ action: 'TRANSLATE' });
for (let i = 0; i < 360; i++) { const st = await bridge({ action: 'GET_STATE' }); if (st && st.translated && !st.translating) break; await sleep(500); }
await sleep(2000);
const after = await page.evaluate((n) => [...Array(n).keys()].map((i) => {
  const el = document.querySelector(`[data-probe-mark="${i}"]`);
  return el ? { i, attrs: [...el.attributes].map((a) => a.name + '=' + a.value.slice(0, 40)).join(' '), html: el.outerHTML.slice(0, 900) } : { i, gone: true };
}), needles.length);
// EVAL：額外在翻譯前後各跑一次的 main world 表達式（回傳可 JSON 化的值）
const extraAfter = process.env.EVAL ? await page.evaluate(process.env.EVAL) : null;
const logs = await bridge({ action: 'GET_LOGS', afterSeq: 0 });
const entries = logs?.logs || logs?.entries || [];
const rel = entries.filter((e) => needles.some((n) => JSON.stringify(e).includes(n.slice(0, 25))) || /error|warn|echo|fail|revert/i.test(e.level + ' ' + e.message));
console.log(JSON.stringify({ extraBefore, extraAfter, before, after, logCount: entries.length, relevantLogs: rel.slice(0, 40).map((e) => ({ level: e.level, cat: e.category, msg: e.message, data: JSON.stringify(e.data || '').slice(0, 300) })) }, null, 2));
await ctx.close();
