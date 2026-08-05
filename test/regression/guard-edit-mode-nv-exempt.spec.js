// Regression: guard-edit-mode-nv-exempt——編輯模式下點擊 / 打字讓譯文被打回原文
//(2026-08-05 Jimmy 回報「進入編輯模式,點擊具有 Content Guard 的頁面,譯文就會
// 被打回原文而無法編輯」,New Yorker 實頁重現)。
//
// Fixture: 重用 test/regression/fixtures/inject-nodevalue-mutate-a3.html
// Bug(兩條 path,都是 nv-mutate 軌「編輯模式豁免」漏洞):
//   1. addPreClickRestore(mousedown capture):點到 nv 元素立刻還原原文 + unmark
//      ——本意是讓 React click reconciliation 看到原文 DOM,但編輯模式的點擊是
//      「放游標」,還原 = 點一下譯文就變原文
//   2. detectAndUnmarkExpandedNodeValueMutate(A4 observer):使用者打字讓 backup
//      node 的 nodeValue ≠ translatedValue,被 Path B 誤判 partial-reset →
//      「還原為原文」迴圈 + unmark。三條 sweep 軌(innerHTML / nv / dual)都有
//      contenteditable 豁免,A4 與 pre-click 漏了
// 修法:pre-click / A4 / dual A4 三處加 contenteditable === 'true' 豁免,
// 對齊 sweep 軌既有語意(v1.5.5 / v2.0.57)。
//
// 訊號層:驗「synthetic mousedown / mock mutation batch → production 函式的
// 豁免分支」+ 負向對照(非編輯模式偵測照常);不驗真實 framework revert 時序
//(New Yorker 實頁已人工驗過:修法前點擊+打字必翻回英文,修法後譯文健在)。
//
// SANITY 紀錄(已驗證 2026-08-05):三處豁免逐一註解破壞——A4 →「編輯中元素不
//   unmark」fired 收到 'true' fail;pre-click →「編輯中元素不還原」text 收到英文
//   原文 fail(= 使用者回報症狀);dual A4 → 對應 case fail。各負向對照維持綠
//  (豁免不外溢)。還原 → 5 條全綠。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'inject-nodevalue-mutate-a3';

async function setupPage(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  return { page, evaluate };
}

// 共用 stub:#target 的 span text node 假裝已走 nv-mutate 注入(原文→譯文),
// editable=true 時模擬編輯模式(contenteditable 屬性即豁免判準)
const STUB = (editable) => `
  (() => {
    const el = document.querySelector('#target');
    const textNode = el.querySelector('span').firstChild;
    const SK = window.__SK;
    SK.STATE.translated = true;
    const origValue = 'Original english sentence for the paragraph body';
    textNode.nodeValue = '這段是中文譯文';
    SK._testNvMutateStubSetup(el, origValue, [
      { node: textNode, originalValue: origValue, translatedValue: '這段是中文譯文' },
    ]);
    el.setAttribute('data-shinkansen-nodevalue-mutated', '1');
    el.setAttribute('data-shinkansen-translated', '1');
    ${editable ? `el.setAttribute('contenteditable', 'true');` : ''}
    return true;
  })()
`;

test('A4:編輯中元素(contenteditable)使用者打字不觸發 unmark / 還原', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);
  await evaluate(STUB(true));
  const result = await evaluate(`
    (() => {
      const el = document.querySelector('#target');
      const textNode = el.querySelector('span').firstChild;
      // 模擬使用者在編輯模式打字:nodeValue 偏離 translatedValue(Path B 誤判形)
      textNode.nodeValue = '這段是中文譯文加了使用者的字';
      const fired = window.__SK._detectAndUnmarkExpandedNodeValueMutate([{ target: textNode, type: 'characterData' }]);
      return JSON.stringify({
        fired,
        text: textNode.nodeValue,
        marker: el.hasAttribute('data-shinkansen-translated'),
        nvAttr: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
        backupKept: window.__SK.STATE.nodeValueMutateBackup.has(el),
      });
    })()
  `);
  const r = JSON.parse(result);
  expect(String(r.fired), 'A4:編輯中元素不 unmark').toBe('false');
  expect(r.text, '使用者編輯不被還原成原文').toBe('這段是中文譯文加了使用者的字');
  expect(r.marker, 'translated marker 應維持').toBe(true);
  expect(r.nvAttr, 'nv attribute 應維持').toBe(true);
  expect(r.backupKept, 'backup 應保留').toBe(true);
  await page.close();
});

test('A4 負向對照:非編輯模式同樣的偏離照常偵測(豁免不外溢)', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);
  await evaluate(STUB(false));
  const result = await evaluate(`
    (() => {
      const el = document.querySelector('#target');
      const textNode = el.querySelector('span').firstChild;
      textNode.nodeValue = '這段是中文譯文被框架改動';
      const fired = window.__SK._detectAndUnmarkExpandedNodeValueMutate([{ target: textNode, type: 'characterData' }]);
      return JSON.stringify({ fired, marker: el.hasAttribute('data-shinkansen-translated') });
    })()
  `);
  const r = JSON.parse(result);
  expect(String(r.fired), '非編輯模式 Path B 應照常 fire').toBe('true');
  expect(r.marker, '非編輯模式應 unmark').toBe(false);
  await page.close();
});

test('pre-click restore:編輯中元素 mousedown 不還原原文', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);
  await evaluate(STUB(true));
  // pre-click listener 由 startSpaObserver 掛上(真實翻譯流程會啟動;stub 情境要自己啟)
  await evaluate(`window.__SK.startSpaObserver()`);
  const result = await evaluate(`
    (() => {
      const el = document.querySelector('#target');
      const textNode = el.querySelector('span').firstChild;
      // pre-click listener 掛在 isolated world 的 window(capture),同 world
      // dispatch 真實 MouseEvent 走整條 listener 路徑
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      return JSON.stringify({
        text: textNode.nodeValue,
        marker: el.hasAttribute('data-shinkansen-translated'),
        nvAttr: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
      });
    })()
  `);
  const r = JSON.parse(result);
  expect(r.text, 'pre-click:編輯中元素不還原').toBe('這段是中文譯文');
  expect(r.marker, 'marker 應維持').toBe(true);
  expect(r.nvAttr, 'nv attribute 應維持').toBe(true);
  await page.close();
});

test('pre-click restore 負向對照:非編輯模式 mousedown 照常還原(既有行為不變)', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);
  await evaluate(STUB(false));
  await evaluate(`window.__SK.startSpaObserver()`);
  const result = await evaluate(`
    (() => {
      const el = document.querySelector('#target');
      const textNode = el.querySelector('span').firstChild;
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      return JSON.stringify({
        text: textNode.nodeValue,
        marker: el.hasAttribute('data-shinkansen-translated'),
      });
    })()
  `);
  const r = JSON.parse(result);
  expect(r.text, '非編輯模式 pre-click 應還原原文').toBe('Original english sentence for the paragraph body');
  expect(r.marker, '非編輯模式應 unmark').toBe(false);
  await page.close();
});

test('dual A4:編輯中元素不 unmark(對齊 nv 軌豁免)', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);
  const result = await evaluate(`
    (() => {
      const el = document.querySelector('#target');
      const SK = window.__SK;
      SK.STATE.translated = true;
      const origText = 'Original english sentence';
      if (!SK.STATE.translationCache) SK.STATE.translationCache = new Map();
      SK.STATE.translationCache.set(el, { wrapper: null });
      SK.STATE.originalText.set(el, origText);
      el.setAttribute('contenteditable', 'true');
      // 觸發形:textContent 顯著變長 + startsWith origText
      el.querySelector('span').firstChild.nodeValue = origText + ' expanded content '.repeat(10);
      const fired = SK._detectAndUnmarkExpandedDual([{ target: el, type: 'childList' }]);
      return JSON.stringify({ fired, cacheKept: SK.STATE.translationCache.has(el) });
    })()
  `);
  const r = JSON.parse(result);
  expect(String(r.fired), 'dual A4:編輯中元素不 unmark').toBe('false');
  expect(r.cacheKept, 'translationCache 應保留').toBe(true);
  await page.close();
});
