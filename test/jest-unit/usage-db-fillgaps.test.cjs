'use strict';

/**
 * 批次 8 F3（code review 2026-08-03）:lib/usage-db.js fillGaps 的 from 空值語意。
 *
 * 背景 bug(latent):
 *   `const from = new Date(fromTs || Date.now() - 30 * 86400000)` 把 fromTs=0
 *   (epoch,語意「全部」)與 undefined 都當 falsy → 範圍默默縮成 30 天視窗。
 *   getAggregated 對「更早的 bucket」建了 entry 卻不 push 進輸出——折線圖悄悄少段。
 *   現行 options 一律帶 from 所以沒踩;未來呼叫端傳「全部」(from 省略或 0)就觸發。
 *
 * 修法(usage-db.js fillGaps):
 *   - fromTs 用 `??` 判 nullish:0 是合法值(epoch 起算)。
 *   - 完全沒帶 from(undefined/null)時取「最早 bucket 的 period key」起算,
 *     建了的 bucket 不再掉出輸出;完全沒資料才退 30 天預設視窗。
 *
 * 本 spec 鎖的訊號層:fillGaps 對 fromTs 空值的輸出範圍(bucket 完整性)。
 * 不驗:getAggregated 的 IndexedDB 查詢層(usage-db-reconnect.test.cjs 另涵蓋連線層)。
 *
 * SANITY CHECK 紀錄(已驗證,2026-08-05):
 *   把 usage-db.js fillGaps 改回 `const from = new Date(fromTs || Date.now() - 30*86400000)`
 *   → 「undefined 取最早 bucket」與「fromTs=0 視為 epoch」兩 case fail(60 天前 bucket
 *   掉出輸出)→ 還原後全綠。
 */

const path = require('path');
const fs = require('fs');
const vm = require('vm');

// 同 usage-db-reconnect.test.cjs 的 loadEsm pattern:fillGaps 是 function declaration
// (非 export),strip 後 hoist 到 context object 上 → ctx.fillGaps 直接可呼叫。
function loadUsageDb(sandbox = {}) {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../shinkansen/lib/usage-db.js'),
    'utf-8',
  );
  const stripped = src
    .replace(/^import\s+[^;]+;?\s*$/gm, '')
    .replace(/^export\s+(const|let)\s+/gm, 'var ')
    .replace(/^export\s+(function|async\s+function)\s+/gm, '$1 ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout,
    Promise, Date, Number, String, Object, Array, Math, JSON, Map,
    ...sandbox,
  });
  vm.runInNewContext(stripped, ctx, { filename: 'usage-db.js' });
  return ctx;
}

function bucket(period) {
  return { period, totalTokens: 10, billedCostUSD: 0.1, count: 1 };
}

describe('批次 8 F3 fillGaps from 空值語意', () => {
  const ctx = loadUsageDb();

  // 固定 to,測試不依賴當下日期
  const to = new Date(2026, 7, 5).getTime(); // 2026-08-05 local

  test('fromTs=undefined + 有 60 天前 bucket → 取最早 bucket 起算,不掉出輸出', () => {
    const buckets = new Map([
      ['2026-06-06', bucket('2026-06-06')], // 60 天前(> 30 天預設視窗)
      ['2026-08-01', bucket('2026-08-01')],
    ]);
    const result = ctx.fillGaps(buckets, undefined, to, 'day');
    expect(result[0].period).toBe('2026-06-06');
    expect(result.find((r) => r.period === '2026-06-06').totalTokens).toBe(10);
    expect(result.find((r) => r.period === '2026-08-01').totalTokens).toBe(10);
    // 中間空檔有補零 bucket(fillGaps 原本職責不受影響)
    expect(result.find((r) => r.period === '2026-07-15').totalTokens).toBe(0);
  });

  test('fromTs=0 視為 epoch(合法值),不縮成 30 天視窗', () => {
    // groupBy=month 讓 epoch 起算的迴圈量可控(~680 個月)
    const buckets = new Map([
      ['1970-01', { period: '1970-01', totalTokens: 5, billedCostUSD: 0, count: 1 }],
    ]);
    const result = ctx.fillGaps(buckets, 0, to, 'month');
    expect(result[0].period).toBe('1970-01');
    expect(result[0].totalTokens).toBe(5);
  });

  test('fromTs=undefined + 完全沒資料 → 退 30 天預設視窗(原行為保留)', () => {
    const result = ctx.fillGaps(new Map(), undefined, undefined, 'day');
    // 30 天視窗 → 31±1 個 bucket(起訖日界)
    expect(result.length).toBeGreaterThanOrEqual(30);
    expect(result.length).toBeLessThanOrEqual(32);
    expect(result.every((r) => r.totalTokens === 0)).toBe(true);
  });

  test('對照組:fromTs 有值照常運作(不受修法影響)', () => {
    const from = new Date(2026, 7, 1).getTime();
    const buckets = new Map([['2026-08-03', bucket('2026-08-03')]]);
    const result = ctx.fillGaps(buckets, from, to, 'day');
    expect(result[0].period).toBe('2026-08-01');
    expect(result.length).toBe(5); // 08-01 ~ 08-05
    expect(result.find((r) => r.period === '2026-08-03').totalTokens).toBe(10);
  });
});
