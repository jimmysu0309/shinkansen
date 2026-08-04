// Unit test: drive-subtitle 用量紀錄的 background 路由 + usage-db 合併層
// (code review 2026-08-03 批次 2 C2 的第二層——content 端發 LOG_USAGE 那層由
// test/regression/drive-usage-log.spec.js 驅動)
//
// 驗三件事：
//   (1) shouldSkipUsageRecord 不跳過 drive-subtitle(行為斷言——它走 upsert 累計
//       合併路徑，單次 record 為 0 不代表整支影片為 0，同 youtube-subtitle 豁免)
//   (2) background.js LOG_USAGE handler 的 upsert 路由條件涵蓋 drive-subtitle
//       (source 斷言，比照 usage-path-architecture.spec.js 手法——upsert 真寫入
//       需要完整 IndexedDB transaction/cursor 模擬，ROI 低)
//   (3) usage-db.js upsertYouTubeUsage 的合併鍵含 source(v.source === record.source,
//       非寫死 'youtube-subtitle')——Drive 與 YouTube 紀錄不互相合併
//
// 訊號層界定：(2)(3) 為 source 斷言，鎖「路由條件與合併鍵的寫法」，不驗 IndexedDB
// 真實寫入 / cursor 掃描行為(該層由既有 usage-db-reconnect.test.cjs 覆蓋連線層)。
//
// SANITY 紀錄(已驗證，2026-08-04)：暫時把 usage-db.js shouldSkipUsageRecord 的
// `|| record.source === 'drive-subtitle'` 拿掉 → case 1 fail(zero-usage drive record
// 被 skip)；把 upsert 合併鍵改回 `v.source === 'youtube-subtitle'` → case 3 fail
// → 還原 → 全 pass。
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const { shouldSkipUsageRecord } = await import('../../shinkansen/lib/usage-db.js');

test('C2(1): shouldSkipUsageRecord 不跳過 drive-subtitle(同 youtube-subtitle 豁免)', () => {
  // 全 0 record——一般 source 會被 skip;upsert 累計來源不可 skip
  const zeroDrive = { source: 'drive-subtitle', inputTokens: 0, outputTokens: 0, chars: 0, billedCostUSD: 0 };
  expect(shouldSkipUsageRecord(zeroDrive)).toBe(false);
  // 對照組：youtube-subtitle 既有豁免不變、一般 source 全 0 照 skip
  expect(shouldSkipUsageRecord({ source: 'youtube-subtitle', inputTokens: 0, outputTokens: 0 })).toBe(false);
  expect(shouldSkipUsageRecord({ source: 'page', inputTokens: 0, outputTokens: 0, chars: 0, billedCostUSD: 0 })).toBe(true);
});

test('C2(2): background LOG_USAGE handler 的 upsert 路由涵蓋 drive-subtitle', () => {
  const src = readFileSync(join(ROOT, 'shinkansen', 'background.js'), 'utf8');
  // 路由條件必須同時認 youtube-subtitle 與 drive-subtitle(且以 videoId 為 upsert 前提)
  expect(src).toMatch(/record\.source === 'youtube-subtitle' \|\| record\.source === 'drive-subtitle'\) && record\.videoId/);
});

test('C2(3): upsertYouTubeUsage 合併鍵含 source(非寫死 youtube-subtitle)', () => {
  const src = readFileSync(join(ROOT, 'shinkansen', 'lib', 'usage-db.js'), 'utf8');
  expect(src).toMatch(/v\.source === record\.source && v\.videoId === videoId && v\.model === model/);
  // 寫死舊值的合併鍵不得殘留
  expect(src).not.toMatch(/v\.source === 'youtube-subtitle' && v\.videoId/);
});
