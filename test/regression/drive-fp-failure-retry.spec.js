// Regression: drive-fp-failure-retry（code review 2026-08-03 批次 3 C3——
// Drive `_lastCaptionsFp` 在翻譯全失敗時也 latch，封死唯一重試入口）
//
// Bug：fingerprint 在翻譯開始「前」寫入；`_runOneBatchLlm` / `_runOneBatchGoogle`
// 失敗（無 API key、網路斷、`!res.ok`）只 log 就 return，fp 不回滾。使用者沒設
// key → 批次全失敗、`DRIVE.entries` 空 → 設好 key 後重按 CC 重觸發 timedtext →
// 同 payload 被 fp 判 duplicate skip → 到 reload 前永遠翻不出來。
//
// 修法：整支跑完若 `DRIVE.entries.length === 0` 且 fp 仍是本輪值（await 期間換軌
// 進來的新 payload 已 re-latch，不可誤清）→ 清 `_lastCaptionsFp` 開放重試。
//
// 驅動方式：同 drive-captions-pipeline-guards.spec.js——SK._driveHandleCaptionsMessage
// seam + mock chrome.runtime.sendMessage。
//
// SANITY 紀錄（已驗證，2026-08-04）：暫時把 content-drive.js 收尾的
// `if (DRIVE.entries.length === 0 && DRIVE._lastCaptionsFp === _fp)` 整段註解掉 →
// case 1 fail（第二次同 payload 被 fp 判重 skip，calls 停在 1、entries 維持空）
// → 還原 → 全 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'drive-bilingual-overlay';

const JSON3_TWO_SEGS = JSON.stringify({
  events: [
    { tStartMs: 0,    segs: [{ utf8: 'hello' }] },
    { tStartMs: 3000, segs: [{ utf8: 'world' }] },
  ],
});

async function setupPage(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);
  return { page, evaluate };
}

test('case 1: 全批失敗 → fp 回滾 → 同 payload 重觸發可重試（修好 key 後翻得出來）', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);

  // 第一輪：模擬沒設 API key，批次全失敗
  await evaluate(`
    window.__llmCalls = 0;
    window.__mockOk = false;
    chrome.runtime.sendMessage = async function (msg) {
      if (!msg || !String(msg.type).startsWith('TRANSLATE_DRIVE_')) return { ok: true };
      window.__llmCalls++;
      if (!window.__mockOk) return { ok: false, error: 'apiKeyMissing' };
      return { ok: true, result: ['[{"s":0,"e":3000,"t":"譯文"}]'], usage: {} };
    };
  `);
  await evaluate(`window.__SK._driveHandleCaptionsMessage({ payload: { json3: ${JSON.stringify(JSON3_TWO_SEGS)} } })`);
  const after1 = await evaluate(`({ calls: window.__llmCalls, entries: window.__SK.DRIVE.entries.length, fp: window.__SK.DRIVE._lastCaptionsFp })`);
  expect(after1.calls, '第一輪應送出批次').toBeGreaterThan(0);
  expect(after1.entries, '全失敗後 entries 應為空').toBe(0);
  expect(after1.fp, '全失敗後 fp 必須回滾（重試入口不得封死）').toBeFalsy();

  // 第二輪：使用者修好 key（mock 改成功），同 payload 重觸發 → 必須真的重翻
  await evaluate(`window.__mockOk = true`);
  await evaluate(`window.__SK._driveHandleCaptionsMessage({ payload: { json3: ${JSON.stringify(JSON3_TWO_SEGS)} } })`);
  const after2 = await evaluate(`({ calls: window.__llmCalls, entries: window.__SK.DRIVE.entries.length })`);
  expect(after2.calls, '同 payload 第二次不得被 fp 判重 skip').toBeGreaterThan(after1.calls);
  expect(after2.entries, '重試後譯文應上 overlay').toBeGreaterThan(0);
  await page.close();
});

test('case 2: 對照組——成功輪之後同 payload 仍被 fp 判重（防重入不得被修法弄壞）', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);

  await evaluate(`
    window.__llmCalls = 0;
    chrome.runtime.sendMessage = async function (msg) {
      if (!msg || !String(msg.type).startsWith('TRANSLATE_DRIVE_')) return { ok: true };
      window.__llmCalls++;
      return { ok: true, result: ['[{"s":0,"e":3000,"t":"譯文"}]'], usage: {} };
    };
  `);
  await evaluate(`window.__SK._driveHandleCaptionsMessage({ payload: { json3: ${JSON.stringify(JSON3_TWO_SEGS)} } })`);
  const after1 = await evaluate(`({ calls: window.__llmCalls, entries: window.__SK.DRIVE.entries.length })`);
  expect(after1.entries, '成功輪 entries 非空').toBeGreaterThan(0);

  await evaluate(`window.__SK._driveHandleCaptionsMessage({ payload: { json3: ${JSON.stringify(JSON3_TWO_SEGS)} } })`);
  const after2 = await evaluate(`({ calls: window.__llmCalls, entries: window.__SK.DRIVE.entries.length })`);
  expect(after2.calls, '成功後同 payload 仍應被判重，不重翻').toBe(after1.calls);
  expect(after2.entries, '判重時 entries 不疊加').toBe(after1.entries);
  await page.close();
});
