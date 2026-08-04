// Regression: restore-cancel-dual-cleanup（code review 2026-08-03 批次 3 B3——
// 取消翻譯的立即還原只覆蓋 single 軌，dual wrapper 與 nv-mutate 軌殘留譯文）
//
// Fixture: 重用 dual-inline-button-preserved.html
// Bug：restoreOriginalHTMLAndReset（快速鍵取消翻譯的立即還原）只迭代
//      STATE.originalHTML（single 軌）——dual 模式取消後「已取消」toast 跳出，但
//      已注入的 <shinkansen-translation> sibling wrapper 全數留在頁面；
//      framework-managed（nv-mutate）段落也維持譯文。`isPageTranslated()` = true 而
//      `STATE.translated` = false（v1.10.57 要消滅的殭屍態）；殘留
//      data-shinkansen-dual-source 讓下一輪 injectDual 對這些段落早退。
//      對照 restorePage 有完整四步——同一份事實雙實作 drift。
// 修法：抽 restoreInjectedDom() 共用函式（dual wrapper / nv-mutate / single
//      innerHTML / Map 清理），restorePage 與 restoreOriginalHTMLAndReset 雙路徑收斂。
//
// 驅動方式：testInjectDual 建 dual 狀態 + 手工構造 nv-mutate backup，走
// testAbortRestore seam（真實取消入口在 handleTranslatePreset 內層，in-flight
// 時序構造成本高；seam 直接呼叫同一個 restoreOriginalHTMLAndReset）。
//
// 訊號層：驗還原後的 DOM / STATE 終態；不驗「取消當下 in-flight 批次晚到回應」
//（該層由既有 badge-clear-on-abort.spec.js 與注入前 signal.aborted 檢查覆蓋）。
//
// SANITY 紀錄（已驗證，2026-08-04）：暫時把 restoreOriginalHTMLAndReset 內
// `restoreInjectedDom()` 改回只跑舊版 originalHTML 迴圈（dual / nv-mutate 不清）→
// 「wrapper 應全移除」「nv-mutate 文字應還原」「isPageTranslated 應為 false」斷言
// fail → 還原 → 全 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'dual-inline-button-preserved';

test('restore-cancel-dual-cleanup: 取消還原清乾淨 dual wrapper + nv-mutate + 殭屍態', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 步驟 1：建 dual 注入狀態（wrapper + translationCache + dual-source attribute）
  // 與 nv-mutate 狀態（text node 改寫 + backup + marker）
  const before = await evaluate(`
    (() => {
      const el = document.querySelector('#target-1');
      window.__shinkansen.testInjectDual(el, '閱讀完整文章⟦0⟧顯示更多⟦/0⟧了解全部細節。');

      // nv-mutate 軌：模擬 framework-managed 段落的 nodeValue 直改 + backup
      const nvEl = document.querySelector('#target-2');
      const textNode = Array.from(nvEl.childNodes).find(n => n.nodeType === 3 && n.nodeValue.trim());
      const originalValue = textNode.nodeValue;
      textNode.nodeValue = '殘留的譯文';
      nvEl.setAttribute('data-shinkansen-nodevalue-mutated', '1');
      window.__SK.STATE.nodeValueMutateBackup.set(nvEl, [{ node: textNode, originalValue }]);

      return {
        wrappers: document.querySelectorAll('shinkansen-translation').length,
        dualSource: el.hasAttribute('data-shinkansen-dual-source'),
        cacheSize: window.__SK.STATE.translationCache.size,
        nvText: textNode.nodeValue,
        pageTranslated: window.__SK.isPageTranslated(),
      };
    })()
  `);
  expect(before.wrappers, '前置：dual wrapper 已注入').toBeGreaterThan(0);
  expect(before.cacheSize, '前置：translationCache 有項').toBeGreaterThan(0);
  expect(before.nvText).toBe('殘留的譯文');
  expect(before.pageTranslated, '前置：頁面呈已翻譯態').toBe(true);

  // 步驟 2：取消翻譯的立即還原
  await evaluate(`window.__shinkansen.testAbortRestore(); 'ok'`);

  const after = await evaluate(`
    (() => {
      const el = document.querySelector('#target-1');
      const nvEl = document.querySelector('#target-2');
      const textNode = Array.from(nvEl.childNodes).find(n => n.nodeType === 3 && n.nodeValue.trim());
      return {
        wrappers: document.querySelectorAll('shinkansen-translation').length,
        dualSource: el.hasAttribute('data-shinkansen-dual-source'),
        cacheSize: window.__SK.STATE.translationCache.size,
        nvBackupSize: window.__SK.STATE.nodeValueMutateBackup.size,
        nvMarker: nvEl.hasAttribute('data-shinkansen-nodevalue-mutated'),
        nvText: textNode ? textNode.nodeValue : null,
        pageTranslated: window.__SK.isPageTranslated(),
        stateTranslated: window.__SK.STATE.translated,
      };
    })()
  `);

  expect(after.wrappers, '取消還原後 dual wrapper 應全移除').toBe(0);
  expect(after.dualSource, 'data-shinkansen-dual-source 應清除（否則下輪 injectDual 早退）').toBe(false);
  expect(after.cacheSize, 'translationCache 應清空').toBe(0);
  expect(after.nvText, 'nv-mutate 文字應還原為原文').not.toBe('殘留的譯文');
  expect(after.nvMarker, 'nv-mutate marker 應清除').toBe(false);
  expect(after.nvBackupSize, 'nodeValueMutateBackup 應清空').toBe(0);
  // 殭屍態檢查：DOM 判定與 STATE 一致
  expect(after.pageTranslated, '還原後 isPageTranslated 應為 false（不留殭屍態）').toBe(false);
  expect(after.stateTranslated).toBe(false);

  await page.close();
});
