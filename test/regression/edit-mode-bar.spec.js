// Feature spec: edit-mode-bar（v2.0.66 編輯模式浮動工具列：提示 + 復原 + 完成）
//
// Fixture: 重用 test/regression/fixtures/edit-mode-guard-skip.html（p#target）
// 功能：進入編輯模式（toggleEditMode(true)）後頁面頂端顯示浮動工具列——
//   「完成」= 結束編輯（等同 popup「結束編輯」）；「復原」= 逐段撤銷：每個段落
//   在本次編輯 session 內第一次被改動時（beforeinput，改動前）快照 innerHTML，
//   按復原以 LIFO 順序整段還原。結束編輯時 stack 清空、listener 移除。
//
// 訊號層界定：bar 在 closed Shadow DOM 內，spec 走 __shinkansen.testEditBar*
//   hooks 讀狀態 / 觸發按鈕等效行為；「真實打字 → beforeinput 快照」用 Playwright
//   鍵盤真打驗證（trusted event 進 isolated world listener）。不驗視覺樣式
//  （深色 bar 排版由人眼驗收）。
//
// SANITY 紀錄（已驗證，2026-07-27）：暫時把 content.js toggleEditMode 內
//   `showEditBar()` 呼叫註解掉 → 「進入編輯模式後工具列應顯示」fail
//   （visible 收到 false）；還原後全綠。
import { test, expect } from '../fixtures/extension.js';
import { loadFixtureResponse, getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'edit-mode-guard-skip';
const TARGET_SELECTOR = 'p#target';

test('edit-mode-bar: 進出編輯模式顯示/隱藏工具列，復原逐段還原、完成結束編輯', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const translation = loadFixtureResponse(FIXTURE);

  // 注入譯文 + 模擬翻譯完成
  await runTestInject(evaluate, TARGET_SELECTOR, translation);
  await evaluate(`window.__shinkansen.setTestState({ translated: true })`);

  // ── 進入編輯模式：工具列顯示、復原初始 disabled
  const enter = JSON.parse(await evaluate(`JSON.stringify(window.__shinkansen.testToggleEditMode(true))`));
  expect(enter.editing).toBe(true);
  let bar = JSON.parse(await evaluate(`JSON.stringify(window.__shinkansen.testEditBarState())`));
  expect(bar.visible, '進入編輯模式後工具列應顯示').toBe(true);
  expect(bar.hostConnected, '工具列 host 應掛在 DOM 上').toBe(true);
  expect(bar.hintText, '提示文字應非空').toBeTruthy();
  expect(bar.undoDisabled, '尚未編輯時復原鈕應 disabled').toBe(true);

  // ── 真實打字（trusted beforeinput → 首次改動快照）
  // 用 focus() + 鍵盤真打（同樣走 trusted beforeinput），不依賴 page.click 的
  // 座標命中——避免固定定位的工具列與段落重疊時攔截點擊造成 flaky
  await page.evaluate((sel) => document.querySelector(sel).focus(), TARGET_SELECTOR);
  await page.keyboard.type('XYZ');
  const editedText = await evaluate(`document.querySelector('${TARGET_SELECTOR}').textContent`);
  expect(String(editedText), '打字後段落應含編輯內容').toContain('XYZ');
  bar = JSON.parse(await evaluate(`JSON.stringify(window.__shinkansen.testEditBarState())`));
  expect(bar.undoStackSize, '首次改動後復原 stack 應有 1 筆').toBe(1);
  expect(bar.undoDisabled, '有可復原項目時復原鈕應啟用').toBe(false);

  // ── 復原：整段還原回進入編輯模式時的譯文
  await evaluate(`window.__shinkansen.testEditBarUndo()`);
  const restoredText = await evaluate(`document.querySelector('${TARGET_SELECTOR}').textContent`);
  expect(String(restoredText), '復原後應回到原譯文').toBe(translation);
  bar = JSON.parse(await evaluate(`JSON.stringify(window.__shinkansen.testEditBarState())`));
  expect(bar.undoStackSize, '復原後 stack 應清空').toBe(0);
  expect(bar.undoDisabled, 'stack 空時復原鈕應回到 disabled').toBe(true);

  // ── 再編輯一次，然後按「完成」：結束編輯、保留編輯內容、工具列隱藏
  await page.evaluate((sel) => document.querySelector(sel).focus(), TARGET_SELECTOR);
  await page.keyboard.type('ABC');
  const done = JSON.parse(await evaluate(`JSON.stringify(window.__shinkansen.testEditBarDone())`));
  expect(done.editing, '完成後應離開編輯模式').toBe(false);
  bar = JSON.parse(await evaluate(`JSON.stringify(window.__shinkansen.testEditBarState())`));
  expect(bar.visible, '完成後工具列應隱藏').toBe(false);
  expect(bar.undoStackSize, '完成後 stack 應清空').toBe(0);
  const afterDone = await evaluate(`
    (() => {
      const el = document.querySelector('${TARGET_SELECTOR}');
      return JSON.stringify({
        editable: el.getAttribute('contenteditable'),
        text: el.textContent,
      });
    })()
  `);
  const parsed = JSON.parse(afterDone);
  expect(parsed.editable, '完成後 contenteditable 應移除').toBe(null);
  expect(parsed.text, '完成後編輯內容應保留').toContain('ABC');

  // ── 結束編輯後打字不再進 undo stack（listener 已移除）
  await evaluate(`
    document.querySelector('${TARGET_SELECTOR}').dispatchEvent(
      new InputEvent('beforeinput', { bubbles: true, cancelable: true })
    )
  `);
  bar = JSON.parse(await evaluate(`JSON.stringify(window.__shinkansen.testEditBarState())`));
  expect(bar.undoStackSize, '結束編輯後 beforeinput 不應再累積 stack').toBe(0);

  await page.close();
});
