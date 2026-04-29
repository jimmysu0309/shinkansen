// Regression: inject-fragment-attribute-and-cache (對應 v1.8.20 fragment 路徑漏寫
// data-shinkansen-translated + STATE.translatedHTML 修復)
//
// Bug: 既有 injectFragmentTranslation 完成 inject 後從未寫 attribute 也沒寫 STATE,
// 導致 dual 模式下 fragment 段落 Content Guard 保護不到 + SPA observer 重複偵測
// → 重複翻譯 + 視覺重疊(XenForo / Discourse 類論壇 + dual mode)。
//
// 修法: injectFragmentTranslation 結尾補 setAttribute + STATE.translatedHTML.set
//      + SK._guardObserveEl?.(el)。
//
// 斷言: fragment unit + 無 slots inject 後,el 應該:
//   1. 有 data-shinkansen-translated="1" attribute
//   2. STATE.translatedHTML 含 el 對應 entry
//
// SANITY 紀錄(已驗證): 把 injectFragmentTranslation 結尾新增的 4 行
// (setAttribute / STATE.translatedHTML.set / SK._guardObserveEl) 全部註解 →
// "data-shinkansen-translated 應為 '1'" 條斷言 fail。還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'inject-fragment-no-slots-newline';

test('fragment 注入後應寫 data-shinkansen-translated + STATE.translatedHTML', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 走 fragment unit + 無 slots 路徑 inject
  const result = await evaluate(`
    (() => {
      const el = document.querySelector('#target');
      const startNode = el.firstChild;
      const endNode = startNode;
      const unit = { kind: 'fragment', el, startNode, endNode };
      window.__SK.injectTranslation(unit, '譯文段一\\\\n譯文段二', []);
      return {
        attr: el.getAttribute('data-shinkansen-translated'),
        inGuardCache: window.__SK.STATE.translatedHTML.has(el),
        innerHtmlPreview: el.innerHTML.slice(0, 200),
      };
    })()
  `);

  expect(result.attr, 'data-shinkansen-translated 應為 "1"').toBe('1');
  expect(result.inGuardCache, 'STATE.translatedHTML 應含此元素').toBe(true);
  expect(result.innerHtmlPreview).toContain('譯文段一');
  expect(result.innerHtmlPreview).toContain('譯文段二');

  await page.close();
});
