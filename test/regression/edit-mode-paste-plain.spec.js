// Regression: v2.0.71 網頁編輯譯文模式貼上降純文字——貼上格式跟「目標」走,不跟來源。
//
// Fixture: 重用 test/regression/fixtures/edit-mode-guard-skip.html(p#target)
// 症狀:編輯譯文模式下從外部(原文頁 / 其他網站)copy 貼進譯文段,瀏覽器 rich
// paste 帶著來源 inline style(font-family 等 span)進段落,格式跟來源不跟目標。
// 修法:編輯模式開啟時 document 掛 capture paste listener(onEditPaste),命中
// [data-shinkansen-translated][contenteditable] 時取 text/plain 走 execCommand
// insertText 插入(繼承游標處樣式)。與 translate-doc/index.js
// onPreviewEditablePaste 為同一份事實的雙實作(EPUB 側已有 epub-translate.spec.js
// 「預覽編輯貼上降純文字」case + SANITY ㊻ 覆蓋)。
//
// 訊號層:驗「真剪貼簿放 rich HTML → 真實 ControlOrMeta+V → 進 DOM 的是純文字 +
// 復原快照照常運作」整條;不驗跨 app 系統剪貼簿互通。
//
// SANITY 紀錄(已驗證 2026-07-30):把 content.js toggleEditMode 內
//   `document.addEventListener('paste', onEditPaste, true)` 註解掉 →
//   「外來樣式沒跟進來」not.toContain('font-family') fail(rich 預設插入把
//   <span style="font-family:Georgia…"> 帶進 DOM)。還原 → 全綠。
import { test, expect } from '../fixtures/extension.js';
import { loadFixtureResponse, getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'edit-mode-guard-skip';
const TARGET_SELECTOR = 'p#target';

test('edit-mode-paste-plain: rich paste 進譯文段降為純文字(格式跟目標不跟來源)', async ({
  context,
  localServer,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const translation = loadFixtureResponse(FIXTURE);

  await runTestInject(evaluate, TARGET_SELECTOR, translation);
  await evaluate(`window.__shinkansen.setTestState({ translated: true })`);
  const enter = JSON.parse(await evaluate(`JSON.stringify(window.__shinkansen.testToggleEditMode(true))`));
  expect(enter.editing).toBe(true);

  // 真剪貼簿放 rich HTML(text/html + text/plain 雙格式,同真實複製行為)
  await page.evaluate(async () => {
    const html = '<span style="font-family:Georgia, serif; font-style:italic">Auto Express</span>';
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob(['Auto Express'], { type: 'text/plain' }),
    })]);
  });

  // 游標移到譯文段尾(click 位置不定,固定插入點讓斷言穩定)再真實貼上
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }, TARGET_SELECTOR);
  await page.keyboard.press('ControlOrMeta+v');

  const after = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return { html: el.innerHTML, text: el.textContent };
  }, TARGET_SELECTOR);
  expect(after.text, '內容有貼進來').toContain('Auto Express');
  expect(after.html, '外來樣式沒跟進來').not.toContain('font-family');
  expect(after.html, '外來 span 沒跟進來').not.toContain('<span');

  // execCommand insertText 觸發 beforeinput → 復原快照照常運作
  const bar = JSON.parse(await evaluate(`JSON.stringify(window.__shinkansen.testEditBarState())`));
  expect(bar.undoStackSize, '貼上算首次改動,復原 stack 應有 1 筆').toBe(1);
  await evaluate(`window.__shinkansen.testEditBarUndo()`);
  const restored = await evaluate(`document.querySelector('${TARGET_SELECTOR}').textContent`);
  expect(String(restored), '復原後應回到原譯文').toBe(translation);

  // 結束編輯後 listener 移除:再貼上不攔截(非編輯模式的 contenteditable 不歸我們管)
  await evaluate(`window.__shinkansen.testToggleEditMode(false)`);
  const pasteListenerGone = await evaluate(`
    (() => {
      const el = document.querySelector('${TARGET_SELECTOR}');
      return el.getAttribute('contenteditable') === null;
    })()
  `);
  expect(pasteListenerGone, '結束編輯後段落不再 contenteditable').toBe(true);

  await page.close();
});
