'use strict';

/**
 * v1.10.46 批次 5-6（code review 2026-06-11）：save() 的 parseUserNum fallback 引用
 * DEFAULTS 單一資料源。
 *
 * 症狀：options.js save() 的 fallback 是字面值手抄,maxConcurrentBatches 已 drift
 * （寫死 10 vs DEFAULTS/storage.js 的 30）→ 使用者清空該欄位存檔,實際存進 10,
 * 併發掉到 1/3 且無提示。
 *
 * 為什麼是 source 斷言（訊號層次,CLAUDE.md 工作流原則 §3）：save() 綁整頁 DOM
 * （數十個 $('id')）,行為級要真 options 頁。本 spec 鎖「fallback 是 DEFAULTS 引用,
 * 不是數字字面值」這個結構性事實;不鎖 save() 端到端寫進 storage 的值。
 * 例外:cp-inputPerMTok / cp-outputPerMTok 的 0 是刻意 sentinel（空欄 = 無計價）,
 * 不在檢查清單。
 *
 * SANITY 紀錄（已驗證,2026-06-11）：暫時把 maxConcurrentBatches fallback 改回 10 →
 * 對應 case fail；還原 → pass。
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../shinkansen/options/options.js'), 'utf-8'
);

// 這些欄位的 parseUserNum fallback 必須引用 DEFAULTS,不可數字字面值
const FIELDS = [
  ['maxRetries', 'DEFAULTS.maxRetries'],
  ['maxConcurrentBatches', 'DEFAULTS.maxConcurrentBatches'],
  ['maxUnitsPerBatch', 'DEFAULTS.maxUnitsPerBatch'],
  ['maxCharsPerBatch', 'DEFAULTS.maxCharsPerBatch'],
  ['maxTranslateUnits', 'DEFAULTS.maxTranslateUnits'],
  ['partialModeMaxUnits', 'DEFAULTS.partialMode.maxUnits'],
];

describe('5-6: parseUserNum fallback 引用 DEFAULTS', () => {
  for (const [id, defaultsRef] of FIELDS) {
    test(`$('${id}') fallback = ${defaultsRef}（非字面值）`, () => {
      const re = new RegExp(`parseUserNum\\(\\$\\('${id}'\\)\\.value, ([^)]+)\\)`);
      const m = SRC.match(re);
      expect(m).toBeTruthy(); // null = 找不到該欄位的 parseUserNum 呼叫
      expect(m[1]).toBe(defaultsRef);
    });
  }

  test('glossaryTimeout fallback 從 DEFAULTS.glossary.timeoutMs 換算,非字面值 60', () => {
    expect(SRC).toMatch(/parseUserNum\(\$\('glossaryTimeout'\)\.value, \(DEFAULTS\.glossary\.timeoutMs \?\? 60000\) \/ 1000\)/);
  });

  test('cp-fetchTimeout fallback 引用 DEFAULTS.customProvider.fetchTimeoutSec', () => {
    expect(SRC).toMatch(/parseUserNum\(\$\('cp-fetchTimeout'\)\.value, DEFAULTS\.customProvider\?\.fetchTimeoutSec \?\? 90\)/);
  });
});
