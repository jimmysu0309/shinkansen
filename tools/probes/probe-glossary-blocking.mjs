// probe-glossary-blocking.mjs — blocking 模式(>blockingThreshold 批)下的術語表快取三輪驗證
// + dump gloss_ 實際條目(驗證 tech 類 target 是否自帶（原文）對照)。
// 用法:node tools/probe-glossary-blocking.mjs

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..', '..', 'shinkansen');
const TARGET_URL = process.env.TARGET_URL
  || 'https://www.newyorker.com/magazine/2026/07/06/the-tick-that-hunts-down-its-hosts-including-us';
const PROFILE = path.resolve(os.tmpdir(), 'shinkansen-probe-glossary-blocking-profile');
const KEY_PATH = path.join(os.homedir(), '.shinkansen-test-key');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getIsolatedEvaluator(page) {
  const cdp = await page.context().newCDPSession(page);
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
  await cdp.send('Runtime.enable');
  await sleep(800);
  const target = contexts.filter((c) => c?.auxData?.type === 'isolated').find((c) => /Shinkansen/i.test(c.name || ''));
  if (!target) throw new Error('找不到 Shinkansen isolated world');
  return async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { contextId: target.id, expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('evaluate 失敗: ' + r.exceptionDetails.text);
    return r.result.value;
  };
}

async function bridge(evaluate, action, extra = {}, timeoutMs = 90000) {
  return await evaluate(`
    new Promise((resolve) => {
      const onResp = (e) => { window.removeEventListener('shinkansen-debug-response', onResp); resolve(e.detail); };
      window.addEventListener('shinkansen-debug-response', onResp);
      window.dispatchEvent(new CustomEvent('shinkansen-debug-request',
        { detail: Object.assign({ action: ${JSON.stringify(action)} }, ${JSON.stringify(extra)}) }));
      setTimeout(() => { window.removeEventListener('shinkansen-debug-response', onResp); resolve({ ok: false, error: 'TIMEOUT' }); }, ${timeoutMs});
    })
  `);
}

async function runOnce(evaluate, label) {
  await bridge(evaluate, 'CLEAR_LOGS');
  const t0 = Date.now();
  await bridge(evaluate, 'TRANSLATE');
  for (let i = 0; i < 480; i++) {
    const st = await bridge(evaluate, 'GET_STATE');
    if (!st.translating && st.translated && st.segmentCount > 0) break;
    await sleep(500);
  }
  const t1 = Date.now();
  const logs = await bridge(evaluate, 'GET_LOGS', { afterSeq: 0 });
  const all = (logs && logs.logs) || [];
  const gl = all.filter((l) => l.category === 'glossary').map((l) => `${l.message} ${JSON.stringify(l.data || {}).slice(0, 180)}`);
  const cache = all.filter((l) => /cache lookup/.test(l.message)).map((l) => l.data);
  const hits = cache.reduce((a, c) => a + (c?.hits || 0), 0);
  const misses = cache.reduce((a, c) => a + (c?.misses || 0), 0);
  const usage = await bridge(evaluate, 'GET_USAGE_STATS', { from: t0, to: t1 + 3000 });
  console.log(`\n[${label}] 耗時 ${(t1 - t0) / 1000}s | tc hits=${hits} misses=${misses} | usage=${JSON.stringify(usage?.stats?.count)}req $${usage?.stats?.totalBilledCostUSD}`);
  for (const g of gl) console.log(`  [gloss] ${g}`);
  return { hits, misses };
}

async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  const apiKey = fs.readFileSync(KEY_PATH, 'utf8').trim();

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`,
      '--no-first-run', '--no-default-browser-check'],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  for (const p of ctx.pages()) { try { await p.close(); } catch { /* ignore */ } }

  const page = await ctx.newPage();
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(3000);
  let evaluate = await getIsolatedEvaluator(page);

  await evaluate(`chrome.storage.local.set({ apiKey: ${JSON.stringify(apiKey)} })`);
  // blockingThreshold: 0 → 任何頁都走 blocking(模擬 Jimmy 的 19 批長文路徑)
  await evaluate(`chrome.storage.sync.set({ glossary: { enabled: true, blockingThreshold: 0 } })`);
  await sleep(500);

  for (const label of ['round1', 'round2', 'round3']) {
    if (label !== 'round1') {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(3000);
      evaluate = await getIsolatedEvaluator(page);
    }
    await runOnce(evaluate, label);
  }

  // dump gloss_ 條目(isolated world 有 chrome.storage.local 權限)
  const gloss = await evaluate(`
    chrome.storage.local.get(null).then((all) => {
      const out = {};
      for (const k of Object.keys(all)) if (k.startsWith('gloss_')) out[k] = all[k];
      return JSON.stringify(out).slice(0, 4000);
    })
  `);
  console.log('\n===== gloss_ 條目 =====');
  console.log(gloss);

  await ctx.close();
}

main().catch((e) => { console.error('[probe] FAILED:', e); process.exit(1); });
