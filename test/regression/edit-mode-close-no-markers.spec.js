// Regression: edit-mode-close-no-markers（對應 v2.0.77 修的「編輯模式永久卡死」
// bug——CODE-REVIEW-2026-08-03 B1）
//
// Fixture: test/regression/fixtures/edit-mode-close-no-markers.html
// 結構：單一翻譯段落。進入編輯模式後 data-shinkansen-translated marker 被外力
//       清光(重現 SPA 導航 reset 剝 marker / framework 把已翻元素整批 detach)。
// Bug：toggleEditMode 的 `els.length === 0 → return { ok:false }` 早退在
//      enable / disable 判斷之前執行——關閉路徑也被擋:editModeActive 卡 true、
//      beforeinput / paste capture listener 與 edit bar 永久殘留,UI 無法恢復。
// 修法：零標記只擋「開啟」(enable && els.length === 0),關閉路徑永遠可走。
//
// 訊號層：驗 toggleEditMode 狀態機(回傳值 ok / editing);不驗 edit bar 的
//        Shadow DOM 視覺與 listener 移除後的實際輸入行為(前者 closed shadow
//        內省不到,後者由既有 guard-edit-mode-skip.spec.js 的正常路徑覆蓋)。
//
// SANITY 紀錄（已驗證 2026-08-03）：content.js toggleEditMode 的
// `if (enable && els.length === 0)` 暫改回 `if (els.length === 0)` →
// 「零標記時關閉編輯模式應成功」斷言 fail(ok 收到 false、editing 卡 true)
// → 還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'edit-mode-close-no-markers';
const TARGET_SELECTOR = 'p#target';

test('edit-mode-close-no-markers: marker 全消失後仍可關閉編輯模式', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 步驟 1:注入譯文 + 模擬翻譯完成(marker 就位)
  await runTestInject(evaluate, TARGET_SELECTOR, '這是注入的譯文段落');
  await evaluate(`window.__shinkansen.setTestState({ translated: true })`);
  const markerCount = await page.evaluate(
    () => document.querySelectorAll('[data-shinkansen-translated]').length,
  );
  expect(markerCount, '注入後應有 translated marker').toBeGreaterThanOrEqual(1);

  // 步驟 2:進入編輯模式
  const enterResp = JSON.parse(await evaluate(`JSON.stringify(window.__shinkansen.testToggleEditMode(true))`));
  expect(enterResp.editing, '應進入編輯模式').toBe(true);

  // 步驟 3:外力清光 marker(重現 SPA reset / framework detach 後的狀態)
  await page.evaluate(() => {
    document.querySelectorAll('[data-shinkansen-translated]')
      .forEach((el) => el.removeAttribute('data-shinkansen-translated'));
  });

  // 步驟 4:關閉編輯模式——零標記不可擋關閉路徑
  const exitResp = JSON.parse(await evaluate(`JSON.stringify(window.__shinkansen.testToggleEditMode(false))`));
  expect(exitResp.ok, '零標記時關閉編輯模式應成功').toBe(true);
  expect(exitResp.editing, '關閉後 editModeActive 應為 false').toBe(false);

  // 對照組:零標記時「開啟」仍應被擋(早退保留在 enable 路徑)
  const reenterResp = JSON.parse(await evaluate(`JSON.stringify(window.__shinkansen.testToggleEditMode(true))`));
  expect(reenterResp.ok, '零標記時開啟編輯模式應維持被擋').toBe(false);
  await page.close();
});
