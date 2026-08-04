// Regression: spa-seen-texts-sweep-bytext-lru(對應 code review 2026-08-03 B8,dev tail 2.0.81.1 修)
//
// Fixture: 重用 test/regression/fixtures/guard-overwrite.html(只需一個有段落的頁)
//
// Bug(B8,記憶體):長 session 兩個無上限成長點——
//   (1) spaObserverSeenTexts 過期 entry 只在「同 text 再被 isSeenTextRecent 查到」
//       時 GC,X / Reddit 無限捲動數小時累積數千條全文 key 永不釋放;
//   (2) STATE.translatedHTMLByText 每段存 originalText → innerHTML 永不修剪,
//       可達數十 MB。
// 修法(content-spa.js):
//   (1) spaObserverRescan 開頭 sweepExpiredSeenTexts 順掃整批清過期 entry;
//   (2) _recordTranslatedByText 加 TRANSLATED_BY_TEXT_MAX=1000 上限,Map 插入序
//       即 LRU 序(重複 set 先 delete、spaByTextReuse 命中 touch 重插),超限淘汰最舊。
//
// 本 spec 鎖的訊號層:驗「sweep 接在真實 rescan 路徑上」與「LRU cap / touch 的
//   淘汰契約」。不驗長 session 真實記憶體用量(環境相依)。
//
// SANITY 紀錄(已驗證,2026-08-05):
//   ① spaObserverRescan 內 sweepExpiredSeenTexts 呼叫註解掉 → 「rescan 後過期
//      entry 應被清」斷言 fail(hasStale=true)→ 還原後 pass。
//   ② _recordTranslatedByText 的 while 淘汰迴圈註解掉 → 「size 不得超過上限」
//      斷言 fail(size=1005)→ 還原後 pass。
//   ③ spaByTextReuse 的 LRU touch 兩行註解掉 → 「touch 過的 entry 應存活」斷言
//      fail(survived=false)→ 還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('B8-1: 真實 rescan 路徑會 sweep spaObserverSeenTexts 過期 entry', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (async () => {
      const SK = window.__SK;
      SK.stopSpaObserver();
      SK.STATE.translated = true;   // 讓 spaObserverRescan 不在入口 early return
      SK.startSpaObserver();
      const TTL = SK._SPA_OBSERVER_SEEN_TEXTS_TTL_MS;
      const m = SK._spaObserverSeenTexts;
      m.clear();
      m.set('stale-entry-text', Date.now() - TTL - 5000);
      m.set('fresh-entry-text', Date.now());
      const before = SK._spaDebug().rescanCount;
      SK._armSpaObserverRescan();
      const start = Date.now();
      while (Date.now() - start < 8000) {
        if (SK._spaDebug().rescanCount > before) break;
        await new Promise(r => setTimeout(r, 50));
      }
      const fired = SK._spaDebug().rescanCount > before;
      // sweep 在 rescan 開頭同步執行,rescanCount 增加即已跑完
      const hasStale = m.has('stale-entry-text');
      const hasFresh = m.has('fresh-entry-text');
      SK.stopSpaObserver();
      SK.STATE.translated = false;
      m.clear();
      return { fired, hasStale, hasFresh };
    })()
  `);

  expect(result.fired, 'rescan 應有 fire(前置條件)').toBe(true);
  // 核心:過期 entry 被整批 sweep,不必等同 text 再被查到
  expect(result.hasStale, 'rescan 後過期 entry 應被 sweep 清掉').toBe(false);
  // 對照組:未過期 entry 不得誤刪
  expect(result.hasFresh, '未過期 entry 應保留').toBe(true);

  await page.close();
});

test('B8-2: translatedHTMLByText 有條數上限,超限淘汰最舊', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const MAX = SK._TRANSLATED_BY_TEXT_MAX;
      const m = SK.STATE.translatedHTMLByText;
      m.clear();
      for (let i = 0; i < MAX + 5; i++) {
        const el = document.createElement('p');
        SK.STATE.originalText.set(el, 'lru-key-' + i);
        SK._recordTranslatedByText(el, '<b>t' + i + '</b>');
      }
      const out = {
        MAX,
        size: m.size,
        oldestEvicted: !m.has('lru-key-0') && !m.has('lru-key-4'),
        boundaryKept: m.has('lru-key-5'),
        newestKept: m.has('lru-key-' + (MAX + 4)),
      };
      m.clear();
      return out;
    })()
  `);

  expect(result.MAX, '上限 seam 應存在且為 1000').toBe(1000);
  expect(result.size, `cache 條數不得超過上限(實際 ${result.size})`).toBe(result.MAX);
  expect(result.oldestEvicted, '最舊 5 條應被淘汰').toBe(true);
  expect(result.boundaryKept, '邊界內第 6 條應保留').toBe(true);
  expect(result.newestKept, '最新 entry 應保留').toBe(true);

  await page.close();
});

test('B8-3: spaByTextReuse 命中 = LRU touch,熱 entry 不被容量淘汰', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('p#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const MAX = SK._TRANSLATED_BY_TEXT_MAX;
      const m = SK.STATE.translatedHTMLByText;
      m.clear();
      for (let i = 0; i < MAX; i++) m.set('touch-key-' + i, '<b>v</b>');
      // 命中最舊 entry(touch-key-0)→ touch 重插到最新
      const el = document.createElement('p');
      el.textContent = 'touch-key-0';
      document.body.appendChild(el);
      const { reused } = SK.spaByTextReuse([{ kind: 'element', el }]);
      const reusedCount = reused.length;
      SK.STATE.translatedHTML.delete(el);
      SK.STATE.originalText.delete(el);
      SK.STATE.originalHTML && SK.STATE.originalHTML.delete(el);
      el.remove();
      // 再塞一條新 entry 溢出容量 → 淘汰的應是原第二舊(touch-key-1),
      // touch-key-0 因 touch 存活
      const el2 = document.createElement('p');
      SK.STATE.originalText.set(el2, 'touch-key-new');
      SK._recordTranslatedByText(el2, '<b>new</b>');
      const out = {
        reusedCount,
        survived: m.has('touch-key-0'),
        evictedSecond: !m.has('touch-key-1'),
        size: m.size,
      };
      m.clear();
      return out;
    })()
  `);

  expect(result.reusedCount, 'byText reuse 應命中(前置條件)').toBe(1);
  expect(result.survived, 'touch 過的最舊 entry 應存活').toBe(true);
  expect(result.evictedSecond, '未 touch 的原第二舊 entry 應被淘汰').toBe(true);

  await page.close();
});
