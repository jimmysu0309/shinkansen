// Regression: detect-perf-text-sampling(對應 code review 2026-08-03 A8 + A9,dev tail 2.0.81.1 修)
//
// Fixture: test/regression/fixtures/detect-perf-text-sampling.html
//
// A8:acceptNode 順序中 isDateLikeText 在 block 判斷之前,對所有未被更早條件擋掉
//   的元素無條件 `(el.textContent || '').trim()`——近 root 的深層 wrapper 每層都
//   串接整棵子樹文字 → 長頁(1MB 文字、深度 20)單次 collectParagraphs 數十 MB
//   字串 churn,SPA rescan 反覆跑。
//   修法(content-detect.js isDateLikeText):childElementCount > 3 廉價早退 +
//   TreeWalker 有界取樣(原始字元超過 _DATE_SAMPLE_CAP=200 即放棄),全程不讀
//   textContent。
//
// A9:全頁轉換後每個段落帶 marker,每輪 rescan 的殭屍 reconcile 對每個 marked
//   元素取全文跑 isConvertibleVariant(內部兩趟字元掃描)≈ 每輪重掃整頁文字兩遍。
//   修法(content-detect.js collectParagraphs reconcile):比照 footer 放行取樣
//   `.slice(0, 400)`。
//
// 本 spec 鎖的訊號層:驗「取樣守門的行為契約」(不讀 textContent / 取樣長度上限 /
//   日期 skip 與 reconcile 功能不因取樣而破壞)。不驗真實長頁的絕對耗時(效能
//   數字受環境影響,flaky);reconcile 的功能面另有 inject-zh-convert-local case 7/7b。
//
// SANITY 紀錄(已驗證,2026-08-05):
//   ① isDateLikeText 暫時 revert 回 `(el.textContent || '').trim()` 舊實作 →
//      「deep-chain 不得讀 textContent」斷言 fail(reads=1)→ 還原後 pass。
//   ② reconcile 暫時拿掉 `.slice(0, 400)` → 「殭屍元素取樣長度 ≤ 400」斷言
//      fail(zombieMaxLen=520,= 全文長)→ 還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'detect-perf-text-sampling';

test('A8: isDateLikeText 廉價守門 + 有界取樣,不 materialize 整棵子樹', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const fn = window.__SK._isDateLikeText;
      if (typeof fn !== 'function') return { seamMissing: true };

      // 功能面:日期 cell 判定不因取樣而破壞
      const dateCell = fn(document.getElementById('date-cell'));
      const datePadded = fn(document.getElementById('date-cell-padded'));
      const textCell = fn(document.getElementById('text-cell'));
      // 守門面:多直接子元素 wrapper 廉價早退
      const wideWrapper = fn(document.getElementById('wide-wrapper'));

      // 深層單子鏈 wrapper:instrument textContent getter,驗證全程沒讀
      const desc = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
      let reads = 0;
      Object.defineProperty(Node.prototype, 'textContent', {
        configurable: true,
        get() { reads++; return desc.get.call(this); },
        set(v) { desc.set.call(this, v); },
      });
      let deepChain;
      try {
        deepChain = fn(document.getElementById('deep-chain'));
      } finally {
        Object.defineProperty(Node.prototype, 'textContent', desc);
      }
      return { dateCell, datePadded, textCell, wideWrapper, deepChain, reads };
    })()
  `);

  expect(result.seamMissing, 'SK._isDateLikeText 測試 seam 應存在').toBeFalsy();

  // 斷言 1(功能保留):日期 cell 照常判 dateLike
  expect(result.dateCell, '短日期 cell 應判 true').toBe(true);
  // 斷言 2(取樣不破壞 trim 語意):縮排 padding 讓原始長度 ≥ 30,trim 後仍是日期
  expect(result.datePadded, '空白 padding 的日期 cell 應判 true').toBe(true);
  // 斷言 3(對照組):一般文字 cell 判 false
  expect(result.textCell, '一般文字 cell 應判 false').toBe(false);
  // 斷言 4(廉價守門):childElementCount > 3 的 wrapper 直接 false
  expect(result.wideWrapper, '多子元素 wrapper 應被守門判 false').toBe(false);
  // 斷言 5(核心):深層單子鏈 wrapper 判 false,且全程不讀 textContent
  expect(result.deepChain, '深層 wrapper 應判 false').toBe(false);
  expect(
    result.reads,
    `isDateLikeText 不得 materialize textContent(實際讀取 ${result.reads} 次)`,
  ).toBe(0);

  await page.close();
});

test('A9: 殭屍 reconcile 的 isConvertibleVariant 取樣長度 ≤ 400', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#zombie-long', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const zombie = document.getElementById('zombie-long');
      const fullLen = zombie.textContent.length;
      const orig = SK.isConvertibleVariant;
      const zombieLens = [];
      SK.isConvertibleVariant = function (text, dir) {
        if (typeof text === 'string' && text.startsWith('简化字样本开头')) {
          zombieLens.push(text.length);
        }
        return orig(text, dir);
      };
      let hadMarkerBefore = zombie.hasAttribute('data-shinkansen-translated');
      try {
        SK.collectParagraphs(document.body, {});
      } finally {
        SK.isConvertibleVariant = orig;
      }
      return {
        fullLen,
        hadMarkerBefore,
        zombieCalls: zombieLens.length,
        zombieMaxLen: zombieLens.length ? Math.max.apply(null, zombieLens) : 0,
        markerCleared: !zombie.hasAttribute('data-shinkansen-translated'),
      };
    })()
  `);

  // 前置條件:fixture 的殭屍段全文必須顯著長於 400,取樣斷言才有意義
  expect(result.fullLen, '殭屍段全文長度應 > 400(前置條件)').toBeGreaterThan(400);
  expect(result.hadMarkerBefore, '殭屍段收集前應帶 marker(前置條件)').toBe(true);
  // 斷言 1(核心):reconcile 有對殭屍段跑 isConvertibleVariant,且取樣長度 ≤ 400
  expect(result.zombieCalls, 'reconcile 應對殭屍段呼叫 isConvertibleVariant').toBeGreaterThan(0);
  expect(
    result.zombieMaxLen,
    `reconcile 取樣長度應 ≤ 400(實際 ${result.zombieMaxLen} / 全文 ${result.fullLen})`,
  ).toBeLessThanOrEqual(400);
  // 斷言 2(功能保留):取樣後殭屍 marker 照常被 reconcile 清掉
  expect(result.markerCleared, '殭屍 marker 應被 reconcile 清除').toBe(true);

  await page.close();
});
