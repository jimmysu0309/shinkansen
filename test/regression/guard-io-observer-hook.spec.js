// Regression: guard-io-observer-hook (對應 v1.8.20 Content Guard IO observer 不同步修復)
//
// Fixture: test/regression/fixtures/guard-io-observer.html
//
// Bug 根因(v1.8.14 IO subset 設計缺口):
//   `initGuardIntersectionObserver` 只 observe 啟動當下 STATE.translatedHTML 的元素,
//   後續 `injectTranslation`/`injectDual` 寫進 STATE 的新譯段沒有對應的 observe(),
//   `guardVisibleSet` 永遠不收新元素 → guard sweep(走 IO subset)對它們完全失效。
//   `const candidates = guardVisibleSet ? guardVisibleSet : ...` 因 guardVisibleSet
//   永遠 truthy(空 Set 也算)從不 fallback 全表分支。
//
// 修法(content-spa.js + content-inject.js):
//   1. 加 SK._guardObserveEl(el) hook,observer 已啟動時把 el 加進訂閱
//   2. 5 處 STATE.translatedHTML.set 後 + dual translationCache.set 後 + dual swap key 後
//      呼叫該 hook
//
// 斷言:
//   - 啟動 IO observer 後對兩個段落分別 testInject
//   - SK._guardObserveEl 被各 call 一次,參數元素正確
//
// SANITY 紀錄(已驗證):
//   把 content-inject.js 內 `SK._guardObserveEl?.(el);` 5 行全部註解掉 → calls.length === 0,
//   spec 在 "_guardObserveEl 至少各被呼叫 1 次" 那條斷言 fail。還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { loadFixtureResponse, getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'guard-io-observer';

test('guard-io-observer-hook: injectTranslation 後 SK._guardObserveEl 把新譯段加進 IO 訂閱', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-a', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const translation = loadFixtureResponse(FIXTURE);

  // 啟動 IO observer 並安裝 spy 紀錄 _guardObserveEl 呼叫
  await evaluate(`
    (() => {
      window.__SK.initGuardIntersectionObserver();
      window.__sk_observe_calls = [];
      const orig = window.__SK._guardObserveEl;
      window.__SK._guardObserveEl = function (el) {
        window.__sk_observe_calls.push(el?.id || el?.tagName || 'unknown');
        return orig.call(this, el);
      };
    })()
  `);

  // 對 #target-a 注入(模擬 batch 1)
  await runTestInject(evaluate, '#target-a', translation);

  // 對 #target-b 注入(模擬 SPA rescan 後 batch 2)
  await runTestInject(evaluate, '#target-b', translation);

  // 驗 _guardObserveEl 兩個元素各被呼叫一次
  const calls = await evaluate(`JSON.stringify(window.__sk_observe_calls)`);
  const callsArr = JSON.parse(calls);
  expect(callsArr, '_guardObserveEl 至少各被呼叫 1 次').toEqual(
    expect.arrayContaining(['target-a', 'target-b']),
  );

  await page.close();
});
