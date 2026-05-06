// Regression: v1.8.10 B — streaming STREAMING_DONE 帶 hadMismatch=true → batch 0 整批 non-streaming retry
//
// 鎖兩條路徑:
//   1. 文章翻譯(content.js runBatch0Streaming):mock TRANSLATE_BATCH_STREAM emit FIRST_CHUNK + 1 SEGMENT(idx=0,
//      帶合併 garbage),DONE 帶 hadMismatch=true → 主流程 catch streamErr → runBatch(jobs[0]) non-streaming retry。
//   2. 字幕翻譯(content-youtube.js _runBatch0Streaming):同上,但訊息名是 TRANSLATE_SUBTITLE_BATCH_STREAM。
//
// 兩條路徑共用「streaming hadMismatch → reject donePromise → 既有 mid-failure catch」結構。
//
// SANITY CHECK 紀錄(已驗證,2026-04-29):
//   把 STREAMING_DONE handler 的 `if (message.payload.hadMismatch) { ... doneReject ... return; }`
//   整段拿掉(回到 v1.8.9 行為:hadMismatch 只記旗標、仍 doneResolve),retry batch 計數變 0,case 1/2 fail。
//   還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE_ARTICLE = 'translate-priority-sort';
const FIXTURE_SUBTITLE = 'youtube-streaming-inject';

const setupCollector = `
  window.__streamCount = 0;
  window.__retryCount = 0;
  window.__retryTexts = null;

  window.__listeners = [];
  const origAdd = browser.runtime.onMessage.addListener.bind(browser.runtime.onMessage);
  const origRemove = browser.runtime.onMessage.removeListener.bind(browser.runtime.onMessage);
  browser.runtime.onMessage.addListener = (fn) => { window.__listeners.push(fn); return origAdd(fn); };
  browser.runtime.onMessage.removeListener = (fn) => {
    const i = window.__listeners.indexOf(fn);
    if (i >= 0) window.__listeners.splice(i, 1);
    return origRemove(fn);
  };
`;

test('streaming-batch-0-mismatch-retry (case 1): 文章 streaming hadMismatch=true → TRANSLATE_BATCH retry', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE_ARTICLE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(setupCollector);
  await evaluate(`
    chrome.storage.sync.get = async function() {
      return { maxConcurrentBatches: 5, maxUnitsPerBatch: 10, maxCharsPerBatch: 100000 };
    };
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') {
        window.__streamCount += 1;
        const streamId = msg.payload.streamId;
        // 50ms FIRST_CHUNK + 1 個合併譯文 SEGMENT,150ms DONE 帶 hadMismatch=true(LLM 偷懶 6 段合 1 段)
        setTimeout(() => {
          for (const fn of window.__listeners) fn({ type: 'STREAMING_FIRST_CHUNK', payload: { streamId } });
          for (const fn of window.__listeners) {
            fn({ type: 'STREAMING_SEGMENT', payload: {
              streamId, segmentIdx: 0,
              translation: '<<<SHINKANSEN_SEG-1>>> 合併內容 <<<SHINKANSEN_SEP>>> <<<SHINKANSEN_SEG-2>>> 跑進來了 <<<SHINKANSEN_SEP>>> <<<SHINKANSEN_SEG-3>>> 全部塞進 idx 0',
            } });
          }
        }, 50);
        setTimeout(() => {
          for (const fn of window.__listeners) {
            fn({ type: 'STREAMING_DONE', payload: {
              streamId, totalSegments: 1, hadMismatch: true,
              usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0 },
              finishReason: 'STOP',
            } });
          }
        }, 150);
        return { ok: true, started: true };
      }
      if (msg && msg.type === 'STREAMING_ABORT') return { ok: true };
      if (msg && msg.type === 'TRANSLATE_BATCH') {
        window.__retryCount += 1;
        window.__retryTexts = (msg.payload.texts || []).slice();
        await new Promise(r => setTimeout(r, 30));
        const texts = msg.payload.texts || [];
        return {
          ok: true,
          result: texts.map(t => '[CLEAN] ' + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  // 25 fake units → batch 0=25 走 streaming
  await evaluate(`
    (() => {
      const root = document.createElement('div');
      root.id = '__fake-root';
      for (let i = 0; i < 25; i++) {
        const p = document.createElement('p');
        p.textContent = 'fake unit ' + i + ' here we have some text to translate';
        root.appendChild(p);
      }
      document.body.appendChild(root);
      window.__fakeUnits = Array.from(root.children).map(el => ({ kind: 'element', el }));
      window.__SK.STATE.abortController = new AbortController();
      window.__translateP = window.__SK.translateUnits(window.__fakeUnits, {
        signal: window.__SK.STATE.abortController.signal,
      }).catch(() => null);
      return null;
    })()
  `);

  // 等 streaming(50/150ms)+ retry(30ms)+ 餘裕
  await page.waitForTimeout(500);

  const result = await evaluate(`({
    streamCount: window.__streamCount,
    retryCount: window.__retryCount,
    retryTextsLength: window.__retryTexts ? window.__retryTexts.length : 0,
  })`);

  expect(result.streamCount, 'batch 0 走 streaming 1 次').toBe(1);
  expect(result.retryCount, 'hadMismatch=true 後應 retry batch 0 via TRANSLATE_BATCH').toBeGreaterThanOrEqual(1);
  expect(
    result.retryTextsLength,
    `retry 應送整批 25 texts(實際:${result.retryTextsLength})`,
  ).toBe(25);

  await page.close();
});

test('streaming-batch-0-mismatch-retry (case 2): 字幕 streaming hadMismatch=true → TRANSLATE_SUBTITLE_BATCH retry', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE_SUBTITLE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await evaluate(setupCollector);
  await evaluate(`
    window.__retryCleanCaptionMap = null;
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH_STREAM') {
        window.__streamCount += 1;
        const streamId = msg.payload.streamId;
        setTimeout(() => {
          for (const fn of window.__listeners) fn({ type: 'STREAMING_FIRST_CHUNK', payload: { streamId } });
          for (const fn of window.__listeners) {
            fn({ type: 'STREAMING_SEGMENT', payload: {
              streamId, segmentIdx: 0,
              translation: '<<<SHINKANSEN_SEG-1>>> 第一句中文 <<<SHINKANSEN_SEP>>> <<<SHINKANSEN_SEG-2>>> 第二句中文',
            } });
          }
        }, 50);
        setTimeout(() => {
          for (const fn of window.__listeners) {
            fn({ type: 'STREAMING_DONE', payload: {
              streamId, totalSegments: 1, hadMismatch: true,
              usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0 },
              finishReason: 'STOP',
            } });
          }
        }, 150);
        return { ok: true, started: true };
      }
      if (msg && msg.type === 'STREAMING_ABORT') return { ok: true };
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        window.__retryCount += 1;
        const texts = msg.payload.texts || [];
        await new Promise(r => setTimeout(r, 30));
        return {
          ok: true,
          result: texts.map((_, i) => '[CLEAN] line ' + i),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  // 9 條 → batch 0=1, batch 1=8
  await evaluate(`
    const segs = [];
    for (let i = 0; i < 9; i++) {
      segs.push({ startMs: i * 1000, endMs: (i * 1000) + 800, text: 'line ' + i, normText: 'line ' + i, groupId: null });
    }
    window.__SK.YT.rawSegments = segs;
  `);
  await evaluate(`window.__SK.translateYouTubeSubtitles();`);
  await page.waitForTimeout(500);

  const result = await evaluate(`({
    streamCount: window.__streamCount,
    retryCount: window.__retryCount,
    captionMapLine0: window.__SK.YT.captionMap.get('line 0'),
  })`);

  expect(result.streamCount, 'batch 0 走 streaming 1 次').toBe(1);
  expect(result.retryCount, 'hadMismatch=true 後 retry batch 0 應觸發(+ batch 1 並行,共 ≥ 2 次)').toBeGreaterThanOrEqual(2);
  expect(
    result.captionMapLine0,
    `retry 後 line 0 應為乾淨譯文(實際:${result.captionMapLine0})`,
  ).toBe('[CLEAN] line 0');

  await page.close();
});
