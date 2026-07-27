// Unit test: 異常事件 ring 訊號接線（2026-07-27）
//
// 背景：使用者回報「翻好的中文被另一版中文覆蓋」（scotto.me 實例），排查時
// persisted ring（yt_debug_log，100 筆）已被日常 translate / api log 擠光，
// 事後拿不到證據。修法：串流重翻覆蓋類事件標 `_anomaly: true` → lib/logger.js
// 另存低流量 anomaly_log ring（30 筆），GET_PERSISTED_LOGS 回 `anomalies` 欄位。
//
// 驗的層次：source 接線斷言（訊號點有標記、ring 分流存在、bridge 回傳欄位、
// 清除含 anomaly ring）。不驗 storage 實際讀寫時序（logger 跑在 SW，unit 環境
// 無 browser.storage；端到端由 harness probe 手動驗過：isolated world sendLog
// _anomaly → GET_PERSISTED_LOGS anomalies 回讀命中）。
//
// SANITY 紀錄（已驗證，2026-07-27）：
//   - content.js hadMismatch sendLog 拿掉 `_anomaly: true` → 「三個訊號點」case fail
//   - logger.js persistLog 的 anomaly 分流 if 改 `false &&` → 「persistLog 分流」case fail
//   → 各自還原後全綠
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = fs.readFileSync(path.resolve(__dirname, '../../shinkansen/content.js'), 'utf-8');
const LOGGER = fs.readFileSync(path.resolve(__dirname, '../../shinkansen/lib/logger.js'), 'utf-8');
const BG = fs.readFileSync(path.resolve(__dirname, '../../shinkansen/background.js'), 'utf-8');

test('content.js 三個串流異常訊號點都帶 _anomaly 標記', () => {
  const anomalyCalls = CONTENT.match(/_anomaly: true/g) || [];
  expect(anomalyCalls.length, 'content.js 應有 ≥3 處 _anomaly 標記（hadMismatch / mid-failure / first_chunk timeout）').toBeGreaterThanOrEqual(3);
  // 兩條重翻覆蓋路徑必帶 injectedSoFar（被覆蓋段數 = 症狀直接訊號）
  expect(CONTENT).toMatch(/hadMismatch, triggering retry`, \{[^}]*injectedSoFar[^}]*_anomaly: true/);
  expect(CONTENT).toMatch(/mid-failure, retrying batch 0 non-streaming', \{[^}]*injectedSoFar[^}]*_anomaly: true/);
});

test('logger.js persistLog 對 _anomaly entry 分流進 anomaly ring', () => {
  expect(LOGGER).toMatch(/const ANOMALY_KEY = 'anomaly_log';/);
  expect(LOGGER).toMatch(/const ANOMALY_MAX = 30;/);
  // 分流條件在 PERSIST_CATEGORIES 過濾之前（異常事件不受分類限制）。
  // 鎖完整活條件字串——`if (false && entry.data…)` 之類的失效改法不可矇混
  //（第一版只 indexOf('_anomaly === true') 被 SANITY 抓到矇混漏洞）
  const persistFnBody = LOGGER.slice(LOGGER.indexOf('function persistLog('));
  const anomalyIdx = persistFnBody.indexOf('if (entry.data && entry.data._anomaly === true) {');
  const categoryIdx = persistFnBody.indexOf('PERSIST_CATEGORIES.has');
  expect(anomalyIdx, 'persistLog 缺活的 _anomaly 分流條件').toBeGreaterThan(-1);
  expect(anomalyIdx, '_anomaly 分流必須在 PERSIST_CATEGORIES 過濾之前').toBeLessThan(categoryIdx);
});

test('GET_PERSISTED_LOGS 回傳 anomalies 欄位；CLEAR 連 anomaly ring 一起清', () => {
  expect(BG).toMatch(/getAnomalyLogs\(\)/);
  expect(BG).toMatch(/return \{ logs, count: logs\.length, anomalies \};/);
  expect(LOGGER).toMatch(/export async function getAnomalyLogs\(\)/);
  const clearFnBody = LOGGER.slice(LOGGER.indexOf('export async function clearPersistedLogs('));
  expect(clearFnBody).toMatch(/remove\(ANOMALY_KEY\)/);
});
