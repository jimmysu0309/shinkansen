// Regression: inject-a3-unwrap-preserve-ws（code review 2026-08-03 批次 4 A3——
// SPAN-unwrap 等長對齊路徑漏用 preserveWsTextMutate）
//
// Fixture: test/regression/fixtures/inject-a3-unwrap-preserve-ws.html
// 結構：framework-managed 段落，帶 class 的 SPAN 包 text + paired anchor。
//   strict 對齊：src [inline SPAN, inline A, inline SPAN] vs tgt [text, A, text]
//   型別不符 → fail；SPAN-unwrap：src [text, A, text] vs tgt 等長同型 → 對齊成功。
// Bug：三條同型 text-mutation 路徑（strict / SPAN-unwrap / segment 1-to-1）唯獨
//   unwrap 路徑裸寫 `t.node.nodeValue`——Google MT 慣性吃掉 leading space 與
//   trailing \n（v1.9.31 加 preserveWsTextMutate 的原始動機場景），mutate 後
//   pre-wrap 段的視覺換行 / 間距結構破壞。
// 修法：unwrap 路徑套同一 helper（tgt 自帶 ws 優先，否則 fallback src ws）。
//
// SANITY 紀錄（已驗證，2026-08-04）：暫時把 unwrap 路徑改回
// `newValue: t.node.nodeValue` 裸值 → 「trailing \n 應保留」「leading space 應保留」
// 斷言 fail → 還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'inject-a3-unwrap-preserve-ws';
const TARGET_SELECTOR = '#tweet';

test('A3: SPAN-unwrap 對齊的 text mutate 保留 src leading space 與 trailing \\n', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 強制 framework-managed → 走 A3 nodeValue mutate 路徑（同 inject-a3-* 既有慣例）
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);

  const result = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      const mainNode = el.querySelector('.text-main').firstChild;
      const tailNode = el.querySelector('.text-tail').firstChild;
      const anchor = el.querySelector('.ext-link');
      const srcTailBefore = tailNode.nodeValue;   // ' tail words here\\n'

      const { text: sourceText, slots } = window.__SK.serializeForGoogleTranslate(el);
      // 模擬 Google MT 輸出：主文翻譯 + paired marker 保留，但吃掉了 tail 段的
      // leading space 與 trailing \\n(GMT 慣性行為)
      const fake = '全新的世界你好【0】連結文字【/0】尾端字句';
      const restored = window.__SK.restoreGoogleTranslateMarkers(fake);
      const unit = { kind: 'element', el };
      window.__SK.injectTranslation(unit, restored, slots);

      return {
        sourceText,
        slotCount: slots.length,
        srcTailBefore,
        // 核心觀測：同一批 text node（same ref）被 mutate 後的值
        mainAfter: mainNode.nodeValue,
        tailAfter: tailNode.nodeValue,
        anchorText: anchor.textContent,
        anchorStillInPlace: el.contains(anchor),
        dualWrapper: !!el.parentElement.querySelector('shinkansen-translation'),
      };
    })()
  `);

  expect(result.slotCount, '前置：anchor 應產 1 個 paired slot').toBe(1);
  expect(result.srcTailBefore.endsWith('\n'), '前置：src tail 原文帶 trailing \\n').toBe(true);
  expect(result.dualWrapper, 'A3 對齊成功不得 fallback dual wrapper').toBe(false);
  expect(result.anchorStillInPlace, '原 anchor 應留在原位（nodeValue mutate single）').toBe(true);
  expect(result.anchorText).toBe('連結文字');
  expect(result.mainAfter, '主文段 mutate 為譯文').toBe('全新的世界你好');
  // 核心：Google MT 吃掉的 leading space / trailing \n 由 preserveWsTextMutate 補回
  expect(result.tailAfter, 'tail 段 leading space 應保留（Google MT 吃掉 → 從 src 補回）')
    .toMatch(/^ /);
  expect(result.tailAfter, 'tail 段 trailing \\n 應保留（pre-wrap 視覺換行來源）')
    .toMatch(/\n$/);
  expect(result.tailAfter.trim()).toBe('尾端字句');

  await page.close();
});
