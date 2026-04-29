// logger.js — Shinkansen 統一 Log 系統（v0.88 重構）
//
// 所有 log 一律寫入記憶體 buffer（上限 1000 筆）。
// 效能相關分類（youtube / api / rate-limit）同時非同步寫入
// browser.storage.local（key: yt_debug_log，上限 100 筆），
// 確保 service worker 重啟後仍可回查這些記錄。
//
// debugLog 開關只控制「是否同時印到 DevTools console」，
// 不管開關如何，log 都會進記憶體 buffer 供設定頁 Log 分頁檢視。
//
// 分類（category）：
//   translate  — 翻譯流程（段落偵測、分批、注入）
//   api        — Gemini API 請求/回應
//   cache      — 快取命中/淘汰/配額
//   rate-limit — Rate limiter 配額/等待
//   glossary   — 術語表擷取
//   spa        — SPA 偵測/rescan/observer
//   system     — Extension 啟動/版本/設定變更/badge
//   youtube    — YouTube 字幕翻譯流程

import { browser } from './compat.js';
import { getSettingsCached } from './storage.js';

const MAX_LOGS = 1000;

/** 記憶體環形 buffer — background service worker 的全域狀態 */
const logBuffer = [];

/** 自增序號，供 polling 差量拉取 */
let logSeq = 0;

// ─── 持久化 Log（v1.2.52）──────────────────────────────────
// 只持久化效能除錯相關分類，避免 storage 爆滿。
const PERSIST_CATEGORIES = new Set(['youtube', 'api', 'rate-limit']);
const PERSIST_KEY = 'yt_debug_log';
const PERSIST_MAX = 100;

// v1.8.20: 序列化 persistLog 寫入,避免平行 log 踩 read-modify-write race。
// 多筆 log 在短時間內進來時(rate-limit + api 同時觸發很常見),原本 N 個獨立的
// get → set 會互相覆蓋,後寫的吃掉前寫的 → log 遺失。改 promise chain 排隊。
let _persistQueue = Promise.resolve();
function persistLog(entry) {
  if (!PERSIST_CATEGORIES.has(entry.category)) return;
  _persistQueue = _persistQueue.then(async () => {
    try {
      const result = await browser.storage.local.get(PERSIST_KEY);
      const logs = result[PERSIST_KEY] || [];
      logs.push(entry);
      if (logs.length > PERSIST_MAX) logs.splice(0, logs.length - PERSIST_MAX);
      await browser.storage.local.set({ [PERSIST_KEY]: logs });
    } catch (_) { /* 寫入失敗不影響記憶體 buffer 也不卡 queue */ }
  });
}

/** 取得持久化 log 並清除 storage。 */
export async function getPersistedLogs() {
  const result = await browser.storage.local.get(PERSIST_KEY);
  return result[PERSIST_KEY] || [];
}

/** 清除持久化 log storage。 */
export async function clearPersistedLogs() {
  await browser.storage.local.remove(PERSIST_KEY);
}

/**
 * 寫入一筆 log。不管 debugLog 開關都會進 buffer。
 *
 * @param {string} level   'info' | 'warn' | 'error'
 * @param {string} category 分類 key（translate / api / cache / rate-limit / glossary / spa / system）
 * @param {string} message  摘要訊息
 * @param {object} [data]   結構化附加資料
 */
export function debugLog(level, category, message, data) {
  const entry = {
    seq: ++logSeq,
    t: new Date().toISOString(),
    level,
    category: category || 'system',
    message,
    data: sanitize(data),
  };

  // 寫入記憶體 buffer（同步，保證不遺漏）
  logBuffer.push(entry);
  while (logBuffer.length > MAX_LOGS) logBuffer.shift();

  // 持久化至 browser.storage.local（僅限效能除錯分類，fire-and-forget）
  persistLog(entry);

  // 有開 debugLog 才印 console（非同步讀設定，不阻塞 buffer 寫入）
  // v1.8.14: 改用 getSettingsCached 避免每筆 log 都打 storage IPC
  getSettingsCached().then(settings => {
    if (settings.debugLog) {
      const tag = `[Shinkansen][${category}]`;
      if (level === 'error') console.error(tag, message, data);
      else if (level === 'warn') console.warn(tag, message, data);
      else console.log(tag, message, data);
    }
  }).catch(() => {
    // getSettings 失敗不影響 buffer 寫入
  });
}

/**
 * 取得 buffer 中 seq > afterSeq 的所有 log（差量拉取）。
 * @param {number} [afterSeq=0] 上次拉到的最大 seq
 * @returns {{ logs: Array, latestSeq: number }}
 */
export function getLogs(afterSeq = 0) {
  const filtered = afterSeq > 0
    ? logBuffer.filter(e => e.seq > afterSeq)
    : logBuffer.slice();
  return {
    logs: filtered,
    latestSeq: logSeq,
  };
}

/** 清空 buffer（供設定頁「清除」按鈕使用）。 */
export function clearLogs() {
  logBuffer.length = 0;
  // 不重置 logSeq，避免 polling 端誤以為沒有新 log
}

function sanitize(data) {
  if (data == null) return undefined;
  try {
    const s = JSON.stringify(data);
    if (s.length > 3000) return JSON.parse(s.slice(0, 3000) + '…(截斷)');
    return JSON.parse(s);
  } catch {
    return String(data);
  }
}
