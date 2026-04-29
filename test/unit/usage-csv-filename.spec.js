// Unit test: lib/format.js formatYmd + buildUsageCsvFilename
//
// 原 bug(v1.8.13 review 找到):options.js 用量分頁的「匯出 CSV」按鈕讀
// `$('usage-from').value` / `$('usage-to').value`,但 v1.5.7 起 HTML 已把日期欄位
// 拆成 `usage-from-date` / `usage-from-hour` / `usage-from-min`(同 to),
// `usage-from`/`usage-to` 兩個 id 整個 HTML 不存在 → `$()` 回傳 null,`.value`
// 拋 TypeError → CSV 匯出按鈕一按必炸,使用者下載不到檔案。
//
// 修法:檔名改用 getUsageDateRange() 已算好的 ms 時間戳格式化
// (`shinkansen-usage-YYYYMMDD-YYYYMMDD.csv`)。helper 抽到 lib/format.js export,
// 讓本 unit test 可直接 ESM import 驗。
//
// SANITY 已驗(2026-04-28):把 buildUsageCsvFilename body 改成讀 `$('usage-from').value`
// 風格(throw TypeError 模擬)→ 任一 test fail。還原後 pass。

import { test, expect } from '@playwright/test';
import { formatYmd, buildUsageCsvFilename } from '../../shinkansen/lib/format.js';

test.describe('formatYmd', () => {
  test('一般日期 → YYYYMMDD', () => {
    // 2026-04-28 12:00 本地時間
    const ts = new Date(2026, 3, 28, 12, 0).getTime();
    expect(formatYmd(ts)).toBe('20260428');
  });

  test('月日補零', () => {
    const ts = new Date(2026, 0, 5, 0, 0).getTime(); // 2026-01-05
    expect(formatYmd(ts)).toBe('20260105');
  });

  test('跨年邊界', () => {
    const ts = new Date(2025, 11, 31, 23, 59).getTime(); // 2025-12-31
    expect(formatYmd(ts)).toBe('20251231');
  });
});

test.describe('buildUsageCsvFilename', () => {
  test('回傳 shinkansen-usage-FROM-TO.csv 格式', () => {
    const from = new Date(2026, 3, 1).getTime();
    const to = new Date(2026, 3, 28).getTime();
    expect(buildUsageCsvFilename(from, to)).toBe('shinkansen-usage-20260401-20260428.csv');
  });

  test('同一天的 from / to 會展開成兩個相同日期', () => {
    const ts = new Date(2026, 3, 28).getTime();
    expect(buildUsageCsvFilename(ts, ts)).toBe('shinkansen-usage-20260428-20260428.csv');
  });

  test('不依賴任何 DOM(純函式) — 可在 Node 環境直接執行', () => {
    // 原 bug 的觸發點是 `$('usage-from').value` 拋 TypeError,
    // 此 test 證明新 helper 完全沒讀 DOM。
    const from = Date.now() - 30 * 86400000;
    const to = Date.now();
    const filename = buildUsageCsvFilename(from, to);
    expect(filename).toMatch(/^shinkansen-usage-\d{8}-\d{8}\.csv$/);
  });
});
