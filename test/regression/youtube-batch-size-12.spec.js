// Regression: v1.9.19 字幕批次大小 8 → 12 + adaptive ramp 拉到 16 + playbackRate-aware lead
//
// 鎖三件事:
//   1. 非 ASR 路徑用 BATCH=12 切批(17 segs + leadMs=0 → [1, 12, 4],不是舊 [1, 8, 8])
//   2. wallLead ≥ 15s → batch 0 拉到 16(原本上限 8);wallLead<15s ≥10s → 12
//   3. leadMs 邊界判斷走 wall time(除以 playbackRate)——
//      playbackRate=2 + 影片 lead=12s → wallLead=6s → firstBatchSize=4(不是 12)
//
// 為什麼這條規則:Gemini 直接基準測試(tools/probe-subtitle-batch-size.js)量到
//   size 8→12 elapsed median 持平(2.7→2.5s)但 input token / 段省 26%(194→143);
//   size 12→16 elapsed 升 60%(2.5→4.0s)但 token 再省 18%,留給 batch 0 lead 充裕時用。
//   playbackRate 不修則 2x 速 + lead=11s 時 code 認為 lead 大選大批,實際 wall buffer 只剩 5.5s。
//
// SANITY CHECK 紀錄(已驗證,2026-05-16 Claude Code 端):
//   - case 1:把 content-youtube.js 非 ASR 路徑 BATCH=12 改回 8 → batch 1+ 變 [8, 8] 而非 [12, 4],
//     case 1 toEqual([12, 4]) fail。還原後 pass。
//   - case 2 / case 3 結構相同(都驗 wallLead-aware ramp),改 BATCH 即影響 case 1 驗到的同一段邏輯;
//     ramp / playbackRate 邏輯由 case 2 / 3 直接斷言 firstBatchSize 鎖死,SANITY 一併保證。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-streaming-inject';

// 共用 mock:攔截 STREAM 與 BATCH 兩種訊息,記錄 size。STREAM 立即 fire DONE 讓 batch 0 完成。
const setupMock = `
  window.__sizes = [];
  window.__listeners = [];
  const origAdd = browser.runtime.onMessage.addListener.bind(browser.runtime.onMessage);
  browser.runtime.onMessage.addListener = (fn) => { window.__listeners.push(fn); return origAdd(fn); };

  chrome.runtime.sendMessage = async function(msg) {
    if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH_STREAM') {
      const texts = (msg.payload && msg.payload.texts) || [];
      const streamId = msg.payload.streamId;
      window.__sizes.push({ type: 'STREAM', n: texts.length });
      setTimeout(() => {
        for (const fn of window.__listeners) fn({ type: 'STREAMING_FIRST_CHUNK', payload: { streamId } });
        for (let i = 0; i < texts.length; i++) {
          for (const fn of window.__listeners) {
            fn({ type: 'STREAMING_SEGMENT', payload: { streamId, segmentIdx: i, translation: '[ZH] ' + texts[i] } });
          }
        }
        for (const fn of window.__listeners) {
          fn({ type: 'STREAMING_DONE', payload: { streamId, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0 }, totalSegments: texts.length, hadMismatch: false, finishReason: 'STOP' } });
        }
      }, 20);
      return { ok: true, started: true };
    }
    if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
      const texts = (msg.payload && msg.payload.texts) || [];
      window.__sizes.push({ type: 'BATCH', n: texts.length });
      await new Promise(r => setTimeout(r, 20));
      return {
        ok: true, result: texts.map(t => '[ZH] ' + t),
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
      };
    }
    return { ok: true };
  };
`;

const seedSegs = (windowStartMs, n) => `
  const segs = [];
  for (let i = 0; i < ${n}; i++) {
    segs.push({
      startMs: ${windowStartMs} + i * 800,
      endMs:   ${windowStartMs} + i * 800 + 600,
      text: 'line ' + i,
      normText: 'line ' + i,
      groupId: null,
    });
  }
  window.__SK.YT.rawSegments = segs;
  window.__SK.YT.active = true;
  window.__SK.YT.videoId = 'test';
  window.__SK.YT.videoEl = document.querySelector('video');
`;

test('youtube-batch-size-12 (case 1): 17 segs + leadMs=0 → [STREAM 1, BATCH 12, BATCH 4]', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await evaluate(setupMock);

  // currentTime=0 + windowStartMs=0 → leadMs=0(緊急)→ firstBatchSize=1
  // 後續批次 BATCH=12 → [1, 12, 4]
  await evaluate(seedSegs(0, 17));
  await evaluate(`
    Object.defineProperty(window.__SK.YT.videoEl, 'currentTime', { get: () => 0, configurable: true });
    Object.defineProperty(window.__SK.YT.videoEl, 'playbackRate', { get: () => 1, configurable: true });
  `);

  await evaluate(`window.__SK.translateWindowFrom(0);`);
  await page.waitForTimeout(300);

  const sizes = await evaluate(`window.__sizes`);
  const streamSizes = sizes.filter(r => r.type === 'STREAM').map(r => r.n);
  const batchSizes  = sizes.filter(r => r.type === 'BATCH').map(r => r.n).sort((a, b) => b - a);

  expect(streamSizes, `batch 0 應走 STREAM,size=1(實際:${JSON.stringify(sizes)})`).toEqual([1]);
  expect(batchSizes, `batch 1+ 應為 [12, 4](BATCH=12 切剩 16 → 12+4)`).toEqual([12, 4]);

  await page.close();
});

test('youtube-batch-size-12 (case 2): wallLead=20s + playbackRate=1 → firstBatchSize=16', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await evaluate(setupMock);

  // segs 在 [30000, 50000),currentTime=10 → videoNow=10000,windowStartMs=30000
  // leadMs = 30000 - 10000 = 20000;playbackRate=1 → wallLead=20000 ≥ 15000 → firstBatchSize=16
  await evaluate(seedSegs(30000, 20));
  await evaluate(`
    Object.defineProperty(window.__SK.YT.videoEl, 'currentTime', { get: () => 10, configurable: true });
    Object.defineProperty(window.__SK.YT.videoEl, 'playbackRate', { get: () => 1, configurable: true });
  `);

  await evaluate(`window.__SK.translateWindowFrom(30000);`);
  await page.waitForTimeout(200);

  const sizes = await evaluate(`window.__sizes`);
  expect(sizes[0]?.n, `batch 0 應為 16 條(wallLead=20s ≥ 15s),實際:${JSON.stringify(sizes.slice(0, 3))}`).toBe(16);

  const debug = await evaluate(`({ lastLeadMs: window.__SK.YT.lastLeadMs, firstBatchSize: window.__SK.YT.firstBatchSize })`);
  expect(debug.firstBatchSize, `YT.firstBatchSize debug 欄位應 = 16`).toBe(16);
  expect(debug.lastLeadMs, `YT.lastLeadMs 應 ≈ 20000(wall time)`).toBeGreaterThanOrEqual(19000);

  await page.close();
});

test('youtube-batch-size-12 (case 3): playbackRate=2 + 影片 lead=12s → wallLead=6s → firstBatchSize=4', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await evaluate(setupMock);

  // segs 在 [30000, 50000),currentTime=18 → videoNow=18000,windowStartMs=30000
  // 影片 leadMs = 30000 - 18000 = 12000;playbackRate=2 → wallLead = 6000
  // 新 ramp:wallLead<10s → 4(沒有 playbackRate fix 時會誤命中 wallLead<15s → 12)
  await evaluate(seedSegs(30000, 20));
  await evaluate(`
    Object.defineProperty(window.__SK.YT.videoEl, 'currentTime', { get: () => 18, configurable: true });
    Object.defineProperty(window.__SK.YT.videoEl, 'playbackRate', { get: () => 2, configurable: true });
  `);

  await evaluate(`window.__SK.translateWindowFrom(30000);`);
  await page.waitForTimeout(200);

  const sizes = await evaluate(`window.__sizes`);
  expect(sizes[0]?.n, `batch 0 應為 4 條(wallLead=6s,playbackRate=2 修正後),實際:${JSON.stringify(sizes.slice(0, 3))}`).toBe(4);

  const debug = await evaluate(`({ lastLeadMs: window.__SK.YT.lastLeadMs, firstBatchSize: window.__SK.YT.firstBatchSize })`);
  expect(debug.firstBatchSize, `YT.firstBatchSize 應 = 4`).toBe(4);
  expect(debug.lastLeadMs, `YT.lastLeadMs 應 ≈ 6000(wall time,除過 playbackRate)`).toBeGreaterThanOrEqual(5500);
  expect(debug.lastLeadMs, `YT.lastLeadMs 應 ≈ 6000,不該是 12000`).toBeLessThanOrEqual(6500);

  await page.close();
});

// ── 批次 8 C6(code review 2026-08-03)──
// lead-time → batch 0 ladder 原本 heuristic / 非 ASR 兩處逐字鏡像,且 videoNowMs
// fallback 已 drift(heuristic fallback windowStartMs=緊急、非 ASR fallback 0=從容)。
// 修法:抽 _calcAdaptiveBatch0 單一資料源,fallback 統一 windowStartMs(videoEl 不在
// 時無從得知播放位置,保守當緊急處理)。上方 case 1-3 走真實 translateWindowFrom 路徑
// 已覆蓋 ladder 本體;這裡鎖 fallback 統一 + seam 存在。
//
// SANITY 紀錄(已驗證,2026-08-05):把 _calcAdaptiveBatch0 的 fallback 改回
// `: 0`(非 ASR 舊 drift 行為)→ 「無 videoEl fallback 緊急」case fail
// (windowStartMs=30000 → leadMs=30000 → firstBatchSize=16)→ 還原後 pass。
test('C6: videoEl 不存在 → fallback windowStartMs(緊急,batch0=1),兩路徑不再 drift', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const r = await evaluate(`
    (() => {
      const saved = window.__SK.YT.videoEl;
      window.__SK.YT.videoEl = null;
      const out = window.__SK._calcAdaptiveBatch0(30000);
      window.__SK.YT.videoEl = saved;
      return out;
    })()
  `);
  expect(r.videoNowMs, 'fallback 應取 windowStartMs').toBe(30000);
  expect(r.leadMs, 'leadMs 應為 0(緊急)').toBe(0);
  expect(r.firstBatchSize, '無 videoEl 一律當緊急 → batch0 = 1').toBe(1);

  await page.close();
});
