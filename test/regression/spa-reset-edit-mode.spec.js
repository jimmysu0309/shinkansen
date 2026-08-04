// Regression: spa-reset-edit-mode（code review 2026-08-03 批次 3 B2——
// SPA 導航 reset 完全不處理編輯模式）
//
// Fixture: 重用 edit-mode-close-no-markers.html（單一可翻段落）
// Bug：編輯中點連結觸發 SPA 導航後，resetForSpaNavigation 對編輯模式零處理：
//      殘存共用元素（header 等）的 `contenteditable="true"` 與 `shinkansen-editable`
//      class 沒被清（innerHTML 還原不動元素自身 attribute）、edit bar 續留、
//      editModeActive 停 true。後續 sticky 續翻時 collectParagraphs 排除
//      contenteditable 元素 → 那些段落永不再翻。對照 restorePage 有
//      `if (editModeActive) toggleEditMode(false)`——同一份事實雙 path drift。
// 修法：reset 路徑開頭（marker 剝除之前，toggleEditMode 靠 marker 找元素）呼叫
//      SK.exitEditModeIfActive()。
//
// 訊號層：驗「SPA reset 後 contenteditable / editable class / edit bar 狀態已清」；
// 不驗真實站點 SPA framework 的 pushState 時序（fixture 用 content-spa patch 過的
// history.pushState 觸發，與 inject-spa-nav-drift.spec.js 同手法）。
//
// SANITY 紀錄（已驗證，2026-08-04）：暫時把 content-spa.js resetForSpaNavigation 的
// `SK.exitEditModeIfActive?.()` 註解掉 → 「contenteditable 應被清除」與
// 「edit bar 應隱藏」斷言 fail → 還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'edit-mode-close-no-markers';
const TARGET_SELECTOR = 'p#target';

test('spa-reset-edit-mode: 編輯中 SPA 導航 → 編輯模式收尾（attribute / bar / 狀態全清）', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 步驟 1：注入譯文 + 進入編輯模式
  await runTestInject(evaluate, TARGET_SELECTOR, '這是注入的譯文段落');
  await evaluate(`window.__shinkansen.setTestState({ translated: true })`);
  const enterResp = JSON.parse(await evaluate(`JSON.stringify(window.__shinkansen.testToggleEditMode(true))`));
  expect(enterResp.editing, '應進入編輯模式').toBe(true);

  const editing = await page.evaluate(() => {
    const el = document.querySelector('p#target');
    return {
      contenteditable: el.getAttribute('contenteditable'),
      editableClass: el.classList.contains('shinkansen-editable'),
    };
  });
  expect(editing.contenteditable, '編輯模式下段落應為 contenteditable').toBe('true');
  expect(editing.editableClass).toBe(true);
  const barBefore = JSON.parse(await evaluate(`JSON.stringify(window.__shinkansen.testEditBarState())`));
  expect(barBefore.visible, '編輯模式下 edit bar 應顯示').toBe(true);

  // 步驟 2：SPA 導航（content-spa.js patch 過的 pushState，resetForSpaNavigation
  // 在第一個 await 之前同步跑完）
  await evaluate(`history.pushState({}, '', '/spa-child'); 'ok'`);

  // 輪詢等 reset 套用（marker 歸零為完成訊號）
  const start = Date.now();
  let after = null;
  while (Date.now() - start < 3000) {
    after = await page.evaluate(() => {
      const el = document.querySelector('p#target');
      return {
        markers: document.querySelectorAll('[data-shinkansen-translated]').length,
        contenteditable: el.getAttribute('contenteditable'),
        editableClass: el.classList.contains('shinkansen-editable'),
      };
    });
    if (after.markers === 0) break;
    await page.waitForTimeout(50);
  }

  expect(after.markers, 'SPA reset 後 marker 應清空').toBe(0);
  // 核心：元素自身 attribute 必須被清（innerHTML 還原動不到它們）
  expect(after.contenteditable, 'SPA reset 後 contenteditable 應被清除').toBeNull();
  expect(after.editableClass, 'SPA reset 後 shinkansen-editable class 應被清除').toBe(false);

  const barAfter = JSON.parse(await evaluate(`JSON.stringify(window.__shinkansen.testEditBarState())`));
  expect(barAfter.visible, 'SPA reset 後 edit bar 應隱藏').toBe(false);

  // editModeActive 已歸 false：零標記下「開啟」會被擋（若卡 true，forceState=true
  // 走 enable 路徑同樣被零標記擋，故用回傳值 editing 檢查現值）
  const stateResp = JSON.parse(await evaluate(`JSON.stringify(window.__shinkansen.testToggleEditMode(false))`));
  expect(stateResp.editing, 'reset 後 editModeActive 應為 false').toBe(false);

  await page.close();
});
