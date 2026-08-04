// Regression: youtube-onthefly-gen-guard（code review 2026-08-03 批次 3 C1——
// flushOnTheFly 是 captionSourceGen 守門漏掉的第四個寫回點）
//
// Bug：其他三個 async 寫回點（_runAsrSubBatch / heuristic _runBatch /
// _injectBatchResult）都做「active + captionSourceGen」雙守門，on-the-fly 路徑
// await 回來後只查 `if (!SK.YT.active)`。SPA 換片 stop（gen bump）→ 500ms
// auto-restart 把 active 翻回 true → 舊影片 in-flight 批次 resolve 時通過檢查，
// 把舊影片譯文寫進新 session 的 captionMap。
//
// 修法：進場時快照 `_myGen = YT.captionSourceGen`，await 後比對失配即丟棄
//（同其他三點的既有 pattern）。
//
// 驅動方式：同 youtube-batch-missing-result-guard.spec.js——mock
// SK.safeSendMessage 在 await 期間模擬「stop（gen bump）+ auto-restart
// （active 翻回 true）」，直接呼叫 SK._flushOnTheFly seam。
//
// 訊號層：驗「gen 失配時不寫 captionMap」；不驗真實 YouTube SPA 換片時序
//（yt-navigate-finish / 500ms auto-restart 是 YouTube 端行為，fixture 模擬不出）。
//
// SANITY 紀錄（已驗證，2026-08-04）：暫時把 content-youtube.js flushOnTheFly 的
// await 後檢查改回只查 `!SK.YT.active`（拿掉 `_myGen !== captionSourceGen`）→
// case 1 fail（captionMap 收到 2 筆舊影片譯文）→ 還原 → 全 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-streaming-inject';

const SESSION_USAGE = `{ inputTokens: 0, outputTokens: 0, cachedTokens: 0, billedInputTokens: 0, billedCostUSD: 0, segments: 0, cacheHits: 0 }`;

async function setupPage(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  return { page, evaluate };
}

test('case 1: await 期間換片（gen bump + active 翻回 true）→ 舊批次結果丟棄不寫 captionMap', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);

  const r = await evaluate(`
    (async () => {
      Object.assign(window.__SK.YT, {
        active: true, flushing: false, captionSourceGen: 0,
        pendingQueue: new Map([['old video line', []], ['another line', []]]),
        captionMap: new Map(),
        sessionStartTime: Date.now(), sessionUsage: ${SESSION_USAGE},
        config: {},
      });
      window.__SK.safeSendMessage = async function () {
        // 模擬 await 期間 SPA 換片：stop bump gen → 500ms auto-restart 把 active 翻回 true
        window.__SK.YT.captionSourceGen = 1;
        window.__SK.YT.active = true;
        return { ok: true, result: ['舊影片譯文一', '舊影片譯文二'], usage: ${SESSION_USAGE} };
      };
      await window.__SK._flushOnTheFly();
      return {
        size: window.__SK.YT.captionMap.size,
        flushing: window.__SK.YT.flushing,
      };
    })()
  `);

  expect(r.size, 'gen 失配的舊批次不得寫入新 session 的 captionMap').toBe(0);
  expect(r.flushing, '丟棄路徑必須釋放 flushing flag（否則下批永久卡住）').toBe(false);
  await page.close();
});

test('case 2: 對照組——gen 未變時照常寫入（守門不誤殺正常批次）', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);

  const r = await evaluate(`
    (async () => {
      Object.assign(window.__SK.YT, {
        active: true, flushing: false, captionSourceGen: 0,
        pendingQueue: new Map([['hello world', []]]),
        captionMap: new Map(),
        sessionStartTime: Date.now(), sessionUsage: ${SESSION_USAGE},
        config: {},
      });
      window.__SK.safeSendMessage = async function () {
        return { ok: true, result: ['正常譯文'], usage: ${SESSION_USAGE} };
      };
      await window.__SK._flushOnTheFly();
      return {
        size: window.__SK.YT.captionMap.size,
        val: window.__SK.YT.captionMap.get('hello world'),
      };
    })()
  `);

  expect(r.size, '同 gen 批次照常寫入').toBe(1);
  expect(r.val).toBe('正常譯文');
  await page.close();
});
