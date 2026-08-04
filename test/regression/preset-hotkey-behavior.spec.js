// Regression: preset hotkey behavior（v1.4.12 三組 preset 快速鍵 + 統一取消邏輯）
//
// 驗證 content.js 的 `handleTranslatePreset(slot)`：
//   行為 (a) 閒置：依 preset 的 engine + model 啟動翻譯
//              - slot 1: Gemini Flash (gemini-3-flash-preview)
//              - slot 2: Gemini Flash Lite (gemini-3.1-flash-lite)
//              - slot 3: Google Translate (no modelOverride)
//              （v2.0.78 批次 4 B4：test 環境 storage 未寫入 → 走 content-ns.js
//                fallback；v1.10.67 storage.js 對調 slot 1/2 後 fallback 漏跟，
//                本 spec 原斷言鎖在漂移的舊 fallback 上，隨 B4 修正一併對齊）
//   行為 (b) 翻譯中：呼叫任一 slot 都 abort（`STATE.abortController.abort()`）
//   行為 (c) 已翻譯（v1.10.57 起以 DOM marker / SK.isPageTranslated 為裁決源，非
//            STATE.translated 旗標）：呼叫任一 slot 都 restorePage（STATE.translated 翻 false）
//
// 策略：不走 chrome.commands 真實鍵盤路徑（Playwright 無法模擬 extension 快速鍵），
// 改直接呼叫 `window.__SK.handleTranslatePreset(slot)`——這是 content.js 把真實
// command + message 路徑派送到同一個函式的入口，能覆蓋實際的行為分支。
// 同時 stub `SK.translatePage` / `SK.translatePageGoogle` 攔截啟動時的 engine 分流，
// 驗證 `modelOverride` / `slot` / `label` payload 正確。
//
// SANITY 紀錄（已驗證）：
//   (i)  把 handleTranslatePreset 的 `if (preset.engine === 'google')` 分支
//        改成 `if (false)` 後，slot 3 仍走 translatePage（非 Google），test #3 fail。
//   (ii) 把 `preset.model || null` 改成 `null`，slot 1/2 的 modelOverride 變成 null，
//        test #1/#2 fail。
//   (iii) 把「已翻譯 → restorePage」分支 gate 成 `if (false)`，test #4 fail
//         （STATE.translated 不會翻 false）。
//   (iv) 把 `STATE.abortController?.abort()` 註解掉，test #5 fail（abort 未觸發）。
//   全部分支各自驗過後還原，full suite pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'br-paragraph';  // 任意 fixture 即可，測試不依賴頁面內容

async function setupEvaluatorAndStubs(page) {
  const { evaluate } = await getShinkansenEvaluator(page);
  // Stub SK.translatePage / SK.translatePageGoogle：記錄呼叫參數，不實際跑翻譯流程。
  // 保留原函式於 __orig_* 以便之後 restore（同一 page 多次 test 時需要）。
  await evaluate(`
    (() => {
      window.__tpCalls = [];
      window.__tpgCalls = [];
      window.__SK.translatePage = async function(options) {
        window.__tpCalls.push(options || {});
      };
      window.__SK.translatePageGoogle = async function(gtOptions) {
        window.__tpgCalls.push(gtOptions || {});
      };
    })()
  `);
  return { evaluate };
}

test('preset-hotkey-behavior: idle + slot 1 → translatePage(Gemini Flash) 呼叫，translatePageGoogle 不呼叫', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await setupEvaluatorAndStubs(page);

  await evaluate(`window.__SK.STATE.translated = false; window.__SK.STATE.translating = false;`);
  await evaluate(`window.__SK.handleTranslatePreset(1)`);

  const tpCalls = await evaluate(`JSON.stringify(window.__tpCalls)`);
  const tpgCalls = await evaluate(`JSON.stringify(window.__tpgCalls)`);
  const tp = JSON.parse(tpCalls);
  const tpg = JSON.parse(tpgCalls);

  expect(tp.length, `translatePage 應被呼叫 1 次，實際 ${tp.length}`).toBe(1);
  expect(tpg.length, `translatePageGoogle 不應被呼叫，實際 ${tpg.length}`).toBe(0);
  expect(tp[0].slot).toBe(1);
  expect(tp[0].modelOverride).toBe('gemini-3-flash-preview');
  expect(tp[0].label).toBe('Flash');

  await page.close();
});

test('preset-hotkey-behavior: idle + slot 2 → translatePage(Gemini Flash Lite)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await setupEvaluatorAndStubs(page);

  await evaluate(`window.__SK.STATE.translated = false; window.__SK.STATE.translating = false;`);
  await evaluate(`window.__SK.handleTranslatePreset(2)`);

  const tp = JSON.parse(await evaluate(`JSON.stringify(window.__tpCalls)`));
  const tpg = JSON.parse(await evaluate(`JSON.stringify(window.__tpgCalls)`));

  expect(tp.length).toBe(1);
  expect(tpg.length).toBe(0);
  expect(tp[0].slot).toBe(2);
  expect(tp[0].modelOverride).toBe('gemini-3.1-flash-lite');
  expect(tp[0].label).toBe('Flash Lite');

  await page.close();
});

test('preset-hotkey-behavior: idle + slot 3 → translatePageGoogle 呼叫，translatePage 不呼叫', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await setupEvaluatorAndStubs(page);

  await evaluate(`window.__SK.STATE.translated = false; window.__SK.STATE.translating = false;`);
  await evaluate(`window.__SK.handleTranslatePreset(3)`);

  const tp = JSON.parse(await evaluate(`JSON.stringify(window.__tpCalls)`));
  const tpg = JSON.parse(await evaluate(`JSON.stringify(window.__tpgCalls)`));

  expect(tp.length, `translatePage 不應被呼叫，實際 ${tp.length}`).toBe(0);
  expect(tpg.length, `translatePageGoogle 應被呼叫 1 次，實際 ${tpg.length}`).toBe(1);
  expect(tpg[0].slot).toBe(3);
  expect(tpg[0].label).toBe('Google MT');

  await page.close();
});

test('preset-hotkey-behavior: translated + any slot → restorePage（STATE.translated 翻 false），translatePage/Google 不呼叫', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await setupEvaluatorAndStubs(page);

  // v1.10.57: 「已翻譯」的裁決源改為 DOM 注入痕跡(SK.isPageTranslated),不再是
  // STATE.translated 旗標。真實已翻譯頁面必有 marker —— 用 testInject 注入真譯文
  // (同時填 STATE.originalHTML 供 restorePage 還原),才能正確走 toggle → restore 分支。
  await evaluate(`window.__shinkansen.testInject(document.querySelector('#target'), '譯文測試')`);

  // 把 STATE 擺成「已翻譯」
  await evaluate(`
    window.__SK.STATE.translated = true;
    window.__SK.STATE.translatedBy = 'gemini';
    window.__SK.STATE.stickySlot = 1;
    window.__SK.STATE.translating = false;
  `);

  // 測 slot 2（跨 slot：即使按不同於啟動 slot 的鍵也要還原）
  await evaluate(`window.__SK.handleTranslatePreset(2)`);

  const afterState = JSON.parse(await evaluate(`JSON.stringify({
    translated: window.__SK.STATE.translated,
    translatedBy: window.__SK.STATE.translatedBy,
    stickySlot: window.__SK.STATE.stickySlot,
  })`));
  const tp = JSON.parse(await evaluate(`JSON.stringify(window.__tpCalls)`));
  const tpg = JSON.parse(await evaluate(`JSON.stringify(window.__tpgCalls)`));

  expect(afterState.translated, 'restorePage 後 STATE.translated 應為 false').toBe(false);
  expect(afterState.translatedBy, 'restorePage 後 translatedBy 應為 null').toBeNull();
  expect(afterState.stickySlot, 'restorePage 後 stickySlot 應為 null').toBeNull();
  expect(tp.length, '已翻譯按鍵時 translatePage 不應被呼叫').toBe(0);
  expect(tpg.length, '已翻譯按鍵時 translatePageGoogle 不應被呼叫').toBe(0);

  await page.close();
});

test('preset-hotkey-behavior: translating + any slot → abortController.abort() 被呼叫，translatePage/Google 不呼叫', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await setupEvaluatorAndStubs(page);

  // 擺成「翻譯中」+ 裝 real AbortController 觀測 abort 事件
  await evaluate(`
    (() => {
      window.__aborted = false;
      const ac = new AbortController();
      ac.signal.addEventListener('abort', () => { window.__aborted = true; });
      window.__SK.STATE.translated = false;
      window.__SK.STATE.translating = true;
      window.__SK.STATE.abortController = ac;
    })()
  `);

  // 測 slot 3（跨 engine：Google 引擎的 slot 也要 abort 目前進行中的翻譯）
  await evaluate(`window.__SK.handleTranslatePreset(3)`);

  const aborted = await evaluate(`window.__aborted`);
  const tp = JSON.parse(await evaluate(`JSON.stringify(window.__tpCalls)`));
  const tpg = JSON.parse(await evaluate(`JSON.stringify(window.__tpgCalls)`));

  expect(aborted, '翻譯中按鍵時 abortController.abort() 應被呼叫').toBe(true);
  expect(tp.length, '翻譯中按鍵時 translatePage 不應被呼叫').toBe(0);
  expect(tpg.length, '翻譯中按鍵時 translatePageGoogle 不應被呼叫').toBe(0);

  await page.close();
});
