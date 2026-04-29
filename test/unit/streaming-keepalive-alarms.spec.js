// Unit test: streaming SW keep-alive 走 chrome.alarms 而非 setInterval (v1.8.20 修)
//
// 原 v1.8.14 用 setInterval 每 20s 呼叫 chrome.runtime.getPlatformInfo() 嘗試續命,
// 但 setInterval 在 SW 真被 unload 時會跟 module-level state 一起死亡 →
// 一旦 SW 被收,Map / interval 都消失 → 取消按鈕無響應 + STREAMING_DONE/ERROR 訊息發不出。
//
// v1.8.20 改 chrome.alarms.create:alarms 是持久排程,SW 收回後到觸發點仍會被喚醒。
// 本 spec 直接讀 background.js 原始碼,驗:
//   1. 不再有 setInterval 呼 getPlatformInfo 的字串
//   2. 改用 chrome.alarms.create + onAlarm listener
//   3. period 設為 chrome 最低 0.5 分鐘(30 秒)
//
// 為何不 import background.js 直接跑 mock fetch:它依賴 chrome.runtime / browser.alarms
// 全套 API,且檔案大量副作用(註冊 listener),mock 工程比驗收益大很多。改用「行為合約」
// grep 驗法(類似 forbidden-terms-cache-key.spec.js 的策略)鎖死關鍵 API 不被退回 setInterval。
//
// SANITY 紀錄(已驗證):把 background.js 的 alarms.create 改回 setInterval 後 spec 全 fail。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BACKGROUND_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../shinkansen/background.js'),
  'utf8',
);

test('_startStreamKeepAlive 不再用 setInterval 呼 getPlatformInfo(SW unload 時會死)', () => {
  // 不能完全禁掉 setInterval 全檔出現(可能 inFlightStreams 以外用途有),
  // 但 keep-alive 用途的 setInterval(... getPlatformInfo ...) 必須消失
  const keepAliveSetIntervalRe = /setInterval\(\s*\(\s*\)\s*=>\s*\{[^}]*getPlatformInfo/;
  expect(keepAliveSetIntervalRe.test(BACKGROUND_SRC)).toBe(false);
});

test('_startStreamKeepAlive 改用 browser.alarms.create + 名稱常數', () => {
  expect(BACKGROUND_SRC).toContain('_STREAM_KEEPALIVE_ALARM');
  expect(BACKGROUND_SRC).toMatch(/browser\.alarms\.create\(\s*_STREAM_KEEPALIVE_ALARM/);
});

test('alarm period 設成 0.5 分鐘(Chrome 最低週期)', () => {
  // 0.5 是 Chrome 規定的最低值;0.4 之類會被 clamp 到 1 或更高,違反「希望 30 秒」設計意圖
  expect(BACKGROUND_SRC).toMatch(/_STREAM_KEEPALIVE_PERIOD_MIN\s*=\s*0\.5\b/);
});

test('註冊 browser.alarms.onAlarm.addListener(SW 喚醒後處理 idle 清理)', () => {
  expect(BACKGROUND_SRC).toMatch(/browser\.alarms\.onAlarm\.addListener\(/);
});

test('_stopStreamKeepAliveIfIdle 在 inFlightStreams 空時 clear alarm(避免無限喚醒)', () => {
  const stopFn = BACKGROUND_SRC.match(
    /function _stopStreamKeepAliveIfIdle\(\)\s*\{[^}]*\}/s,
  );
  expect(stopFn, '應有 _stopStreamKeepAliveIfIdle 函式').toBeTruthy();
  expect(stopFn[0]).toMatch(/inFlightStreams\.size\s*===\s*0/);
  expect(stopFn[0]).toMatch(/browser\.alarms\.clear\(\s*_STREAM_KEEPALIVE_ALARM/);
});
