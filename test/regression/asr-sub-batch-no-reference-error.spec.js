// Regression: v1.8.13 review 找到的 bug — _runAsrSubBatch 用未定義的 `domSegs`
//
// 修法位置:shinkansen/content-youtube.js _runAsrSubBatch 結尾 SK.sendLog(...)
//   舊: domSegmentCount: domSegs.length    ← `domSegs` 在此 scope 內未定義
//   新: 整行刪除
//
// 觸發場景:ASR 模式(YouTube auto-generated captions)。每跑一個子批,
// _runAsrSubBatch 內前面的工作(_upsertDisplayCue / _updateOverlay / 寫 captionMap)
// 都先做完,結尾 SK.sendLog(...) 那行讀 `domSegs.length` 拋 ReferenceError,
// 被 caller _runAsrWindow 的 try/catch 吞掉。可見副作用:
//   1. caller 的 `YT.lastApiMs = _batchApiMs[0]` 沒被設 → debug 面板計時失準
//   2. 子批 1+ 走 Promise.allSettled,全部 rejected → log 一直噴 "asr sub-batch N failed"
//   3. 字幕本身已先寫進 captionMap + overlay,user 看不出來
//
// 結構通則 / 測法:
//   暴露 SK._runAsrSubBatch 給 spec 直接呼叫;mock browser.runtime.sendMessage 回正常
//   ASR 結構;設定最小 SK.YT state(non-asr / no videoEl 讓 _updateOverlay early return);
//   try/await/catch 包住,期待 promise 不 reject(亦即不拋未捕獲的 ReferenceError)。
//
// SANITY CHECK 已完成(2026-04-28):
//   把 `domSegmentCount: domSegs.length` 加回 SK.sendLog payload 後,error.name === 'ReferenceError'
//   且 message 含 'domSegs' → 測試 fail。還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-streaming-inject';

test('asr sub-batch 不拋未捕獲的 ReferenceError(domSegs)', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // Mock browser.runtime.sendMessage:回 1 條 ASR 結構回應 + usage
  await evaluate(`
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_ASR_SUBTITLE_BATCH') {
        return {
          ok: true,
          result: ['[{"s":1000,"e":2000,"t":"你好"}]'],
          usage: {
            inputTokens: 1, outputTokens: 1, cachedTokens: 0,
            billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0,
          },
        };
      }
      return { ok: true };
    };
  `);

  // 設定最小 SK.YT state — _updateOverlay 在 !isAsr 時 early return,不需 DOM
  await evaluate(`
    Object.assign(window.__SK.YT, {
      active: true,
      isAsr: false,
      videoEl: null,
      captionMap: new Map(),
      displayCues: [],
      sessionStartTime: Date.now(),
      sessionUsage: {
        inputTokens: 0, outputTokens: 0, cachedTokens: 0,
        billedInputTokens: 0, billedCostUSD: 0, segments: 0, cacheHits: 0,
      },
      videoId: 'test',
      config: {},
    });
  `);

  // 直接呼叫暴露出的 _runAsrSubBatch,捕捉拋出的 error
  const errorInfo = await evaluate(`
    (async () => {
      const subSegs = [{ startMs: 1000, normText: 'hello', text: 'hello' }];
      const batchApiMs = [0];
      try {
        await window.__SK._runAsrSubBatch(subSegs, 0, Date.now(), batchApiMs);
        return null;
      } catch (e) {
        return { name: e.name, message: e.message };
      }
    })()
  `);

  expect(
    errorInfo,
    `_runAsrSubBatch 不應拋出未捕獲的 ReferenceError;實際:${JSON.stringify(errorInfo)}`,
  ).toBeNull();

  await page.close();
});
