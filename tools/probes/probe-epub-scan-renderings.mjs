// probe：真 API 驗證 SCAN_TERM_RENDERINGS（v2.0.11 一致性掃描的對照抽取）。
// 驗三件事：①真 Gemini 回應能解析出對齊的 renderings；②usage 帶 billedCostUSD；
// ③同 inputHash 第二發吃 scanr_ 快取（fromCache=true、費用 0）。
// 需 ~/.shinkansen-test-key；模型走術語表設定預設（Flash Lite 級）省錢。
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

const items = [{
  term: 'Poole',
  samples: [
    { blockId: 'b1', text: '管家普爾打開了門，望向霧氣瀰漫的街道。' },
    { blockId: 'b2', text: '霧散之後，普勒走到市場，為宅邸買了麵包和蠟燭。' },
    { blockId: 'b3', text: '天剛亮，普爾就收拾好行李，在大門旁等他的主人下來。' },
  ],
}];

const send = (nonce) => page.evaluate(async ({ items, nonce }) => {
  const buf = new TextEncoder().encode(JSON.stringify(items) + nonce);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  const inputHash = Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return chrome.runtime.sendMessage({ type: 'SCAN_TERM_RENDERINGS', payload: { items, inputHash } });
}, { items, nonce });

const nonce = String(Date.now());
const first = await send(nonce);
console.log('[probe] 1st ok:', first?.ok, 'fromCache:', first?.fromCache, '_diag:', first?._diag || null);
console.log('[probe] 1st usage:', JSON.stringify(first?.usage));
console.log('[probe] 1st renderings:', JSON.stringify(first?.renderings));
const r = first?.renderings?.[0]?.renderings || [];
const okAlign = r.length === 3 && r[0].includes('普爾') && r[1].includes('普勒') && r[2].includes('普爾');
const okCost = Number.isFinite(first?.usage?.billedCostUSD) && first.usage.billedCostUSD > 0;

const second = await send(nonce);
console.log('[probe] 2nd fromCache:', second?.fromCache, 'billedCostUSD:', second?.usage?.billedCostUSD);
const okCache = second?.fromCache === true && second?.usage?.billedCostUSD === 0;

console.log((okAlign && okCost && okCache)
  ? '[probe] PASS（對齊 / 計費 / 快取三項全過）'
  : `[probe] FAIL align=${okAlign} cost=${okCost} cache=${okCache}`);
await ctx.close();
