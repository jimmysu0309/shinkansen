// Regression: spa-hash-only-no-reset（對應 v2.0.66 修的「站方寫 URL hash 觸發整頁譯文還原」bug）
//
// Fixture: 重用 test/regression/fixtures/spa-navigation.html（#app + #initial-content）
// 結構：頁面在翻譯完成狀態下，URL 發生「純 hash 變動」（pathname + search 不變）。
//   真實案例結構：站方 selection-share 錨點（雙擊選字 → '#selection-…'）/ TOC
//   in-page anchor。站方從 main world 寫 hash，content script 在 isolated world
//   的 history patch 攔不到，由 hashchange listener / URL 輪詢進 handleSpaNavigation。
// Bug：handleSpaNavigation 對純 hash 變動照走 resetForSpaNavigation → 整頁譯文還原。
//   編輯模式下段落是 contenteditable，偵測層排除（content-detect.js isInExcluded
//   contenteditable gate）→ sticky 重翻抓到 0 段 → 整頁卡原文、無法編輯
//   （2026-07-27 archive 鏡像實測：雙擊選字 → 連續 6 次 state reset → translated=0）。
// 修法：handleSpaNavigation 入口對「純 hash 變動」（pathname + search 都沒變）走
//   二段判別：先等 SPA_NAV_SETTLE_MS，再看原本已翻譯的元素還剩多少 connected——
//   幾乎全數健在（detach 比例 < 門檻）= 內容沒換 = in-page 錨點，跳過 reset；
//   相當比例 detach = 視圖真的換掉（Gmail 類 hash-routing SPA）= 導航，照舊
//   reset ＋ sticky 續翻（v1.0.23 既有行為，jest spa-sticky-translate /
//   spa-url-polling 鎖定）。單一判準覆蓋 hashchange / popstate / pushState /
//   URL 輪詢全部入口。
//
// 訊號層界定：本 spec 驗「純 hash 變動＋內容沒換不 reset / 內容換掉仍 reset /
//   pathname 變動仍 reset」的分流邏輯，涵蓋兩個入口：(1) hashchange 事件
//   （isolated world 收得到）；(2) main world history API 寫 hash——不 fire
//   hashchange、也繞過 isolated world 的 history patch，只有 URL 輪詢（500ms
//   safety net）撿得到，即站方 selection-share script 的真實繞過形態。
//   不驗真實站方 script 的選字→寫 hash 行為本身。
//
// SANITY 紀錄（已驗證，2026-07-27）：暫時把 content-spa.js handleSpaNavigation 的
//   hash-only 判斷改成 `if (false && …)` → Case 1（hashchange 入口）與 Case 2
//   （main world 寫 hash，URL 輪詢入口）都在「originalHTML 不應被清空」fail
//   （replacedCount 收到 0）；對照組（pathname 變動 reset）在破壞態仍 pass。
//   還原修法後全綠。二段判別改版後重驗：把 skip 分支改 `if (false && …)` →
//   Case 1 / Case 2 同點 fail，還原全綠（含新增的內容換掉 reset case）。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'spa-navigation';

test('spa-hash-only-no-reset: 純 hash 變動不觸發 SPA reset，譯文保留', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // ── 模擬翻譯完成：testInject 讓 STATE.originalHTML / translated 有記錄
  await evaluate(`
    (() => {
      const el = document.querySelector('#initial-content');
      el.setAttribute('data-shinkansen-translated', '1');
      window.__shinkansen.testInject(el, '快速的棕色狐狸跳過了懶狗。這個段落包含足夠的文字，可以被內容腳本偵測為翻譯候選。');
    })()
  `);
  // testInject 只記 STATE.originalHTML（replacedCount），不設 STATE.translated —
  // reset 訊號以 replacedCount + DOM marker 為準（resetForSpaNavigation 會把兩者都清掉）
  const afterInject = JSON.parse(await evaluate(
    `JSON.stringify(window.__shinkansen.getState())`
  ));
  expect(afterInject.replacedCount).toBeGreaterThan(0);

  // ── 觸發純 hash 變動（同 pathname + search）：fires hashchange → handleSpaNavigation
  await evaluate(`location.hash = '#selection-1617.0-1617.10'`);
  // 等超過 SPA_NAV_SETTLE_MS(800ms) + URL 輪詢(500ms)，讓「若會 reset」有充分時間發生
  await page.waitForTimeout(1600);

  // ── 斷言：純 hash 變動後翻譯狀態與 DOM 注入痕跡都不動
  const afterHash = JSON.parse(await evaluate(
    `JSON.stringify(window.__shinkansen.getState())`
  ));
  expect(afterHash.replacedCount, '純 hash 變動後 originalHTML 不應被清空').toBeGreaterThan(0);
  const markerCount = Number(await evaluate(
    `document.querySelectorAll('[data-shinkansen-translated]').length`
  ));
  expect(markerCount, '純 hash 變動後譯文 DOM marker 應保留').toBeGreaterThan(0);

  // ── 連續第二次 hash 變動（模擬使用者反覆選字）也不 reset
  await evaluate(`location.hash = '#selection-200.3-200.9'`);
  await page.waitForTimeout(1200);
  const afterHash2 = JSON.parse(await evaluate(
    `JSON.stringify(window.__shinkansen.getState())`
  ));
  expect(afterHash2.replacedCount, '第二次 hash 變動後 originalHTML 仍不應被清空').toBeGreaterThan(0);

  await page.close();
});

test('spa-hash-only-no-reset: main world 寫純 hash（繞過 patch，走 URL 輪詢）也不 reset', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    (() => {
      const el = document.querySelector('#initial-content');
      el.setAttribute('data-shinkansen-translated', '1');
      window.__shinkansen.testInject(el, '快速的棕色狐狸跳過了懶狗。這個段落包含足夠的文字，可以被內容腳本偵測為翻譯候選。');
    })()
  `);
  expect(JSON.parse(await evaluate(
    `JSON.stringify(window.__shinkansen.getState())`
  )).replacedCount).toBeGreaterThan(0);

  // main world 的 history API：不經 isolated world patch、pushState 也不 fire
  // hashchange → 只剩 URL 輪詢會發現 URL 變了（站方 script 寫 hash 的真實形態）
  await page.evaluate(() => {
    history.pushState({}, '', location.pathname + location.search + '#selection-42.0-42.7');
  });
  // 等超過輪詢間隔(500ms) + SPA_NAV_SETTLE_MS(800ms)
  await page.waitForTimeout(1600);

  const afterMainWorldHash = JSON.parse(await evaluate(
    `JSON.stringify(window.__shinkansen.getState())`
  ));
  expect(afterMainWorldHash.replacedCount, 'main world 純 hash 變動後 originalHTML 不應被清空')
    .toBeGreaterThan(0);
  const markerCount = Number(await evaluate(
    `document.querySelectorAll('[data-shinkansen-translated]').length`
  ));
  expect(markerCount, 'main world 純 hash 變動後譯文 DOM marker 應保留').toBeGreaterThan(0);

  await page.close();
});

test('spa-hash-only-no-reset: 純 hash 變動但內容換掉（hash-router 導航）仍 reset', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    (() => {
      const el = document.querySelector('#initial-content');
      el.setAttribute('data-shinkansen-translated', '1');
      window.__shinkansen.testInject(el, '快速的棕色狐狸跳過了懶狗。這個段落包含足夠的文字，可以被內容腳本偵測為翻譯候選。');
    })()
  `);
  expect(JSON.parse(await evaluate(
    `JSON.stringify(window.__shinkansen.getState())`
  )).replacedCount).toBeGreaterThan(0);

  // 純 hash 變動 + 視圖換掉（模擬 Gmail 類 hash-routing SPA：hash 導航後
  // framework 把主內容整塊換新）→ 二段判別 settle 後 detach 比例 100% → 判導航
  await evaluate(`location.hash = '#route-2'`);
  await page.evaluate(() => {
    const app = document.querySelector('#app');
    app.innerHTML = '<p id="new-view">Fresh view content mounted by the hash router after navigation.</p>';
  });
  await page.waitForTimeout(1600);

  const afterSwap = JSON.parse(await evaluate(
    `JSON.stringify(window.__shinkansen.getState())`
  ));
  expect(afterSwap.replacedCount, '內容換掉的 hash 導航應照舊 reset（originalHTML 清空）').toBe(0);

  await page.close();
});

test('spa-hash-only-no-reset: pathname 變動（帶 hash）仍觸發 reset（對照組）', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    (() => {
      const el = document.querySelector('#initial-content');
      el.setAttribute('data-shinkansen-translated', '1');
      window.__shinkansen.testInject(el, '快速的棕色狐狸跳過了懶狗。這個段落包含足夠的文字，可以被內容腳本偵測為翻譯候選。');
    })()
  `);
  expect(JSON.parse(await evaluate(
    `JSON.stringify(window.__shinkansen.getState())`
  )).replacedCount).toBeGreaterThan(0);

  // pathname 變動 + 順便帶 hash：guard 不可誤把「有 hash 的真導航」放行
  // （content script 的 pushState patch 在 isolated world，同 world 呼叫走 patch 版）
  await evaluate(`history.pushState({}, '', '/new-page#section-2')`);
  await page.waitForTimeout(1200);

  const afterPush = JSON.parse(await evaluate(
    `JSON.stringify(window.__shinkansen.getState())`
  ));
  expect(afterPush.replacedCount, 'pathname 變動後 originalHTML 應被清空').toBe(0);
  const markerAfterPush = Number(await evaluate(
    `document.querySelectorAll('[data-shinkansen-translated]').length`
  ));
  expect(markerAfterPush, 'pathname 變動後譯文 DOM marker 應被清掉').toBe(0);

  await page.close();
});
