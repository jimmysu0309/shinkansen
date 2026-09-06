// probe：真 API 驗證 EXTRACT_GLOSSARY 回應 usage 帶 billedCostUSD（v2.0.11
// 「本書累計費用含術語表抽取」的 background 端環節；頁面端累加由
// epub-translate.spec.js 以 stub 驗）。inputHash 摻 timestamp 避開 gloss_ 快取。
// 需 ~/.shinkansen-test-key；模型鎖 lite 省錢。
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const EXT = path.resolve(import.meta.dirname, '../../shinkansen');
const KEY_PATH = path.join(os.homedir(), '.shinkansen-test-key');
const API_KEY = fs.readFileSync(KEY_PATH, 'utf-8').trim();

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-probe-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--no-first-run', '--no-default-browser-check'],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;

const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/translate-doc/index.html`, { waitUntil: 'domcontentloaded' });
await page.evaluate(async (key) => {
  await chrome.storage.local.set({ apiKey: key });
  await chrome.storage.sync.set({ targetLanguage: 'zh-TW' });
}, API_KEY);

const res = await page.evaluate(async (nonce) => {
  const text = 'Richard Enfield walked with Mr. Utterson through the streets of London. '
    + 'Enfield told the lawyer a strange story about a door and a man named Edward Hyde. '
    + 'Utterson listened carefully, thinking of his old friend Henry Jekyll.';
  const buf = new TextEncoder().encode(text + nonce);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  const inputHash = Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return chrome.runtime.sendMessage({
    type: 'EXTRACT_GLOSSARY',
    payload: { compressedText: text, inputHash },
  });
}, String(Date.now()));

console.log('[probe] ok:', res?.ok, 'fromCache:', res?.fromCache, '_diag:', res?._diag || null, 'error:', res?.error || null);
console.log('[probe] usage:', JSON.stringify(res?.usage));
console.log('[probe] glossary terms:', Array.isArray(res?.glossary) ? res.glossary.length : null);
const billed = res?.usage?.billedCostUSD;
console.log(Number.isFinite(billed) && billed > 0
  ? `[probe] PASS billedCostUSD=${billed}`
  : `[probe] FAIL billedCostUSD=${billed}`);
await ctx.close();
