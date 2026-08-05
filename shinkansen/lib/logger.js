// logger.js — Shinkansen 統一 Log 系統（v0.88 重構）
//
// 所有 log 一律寫入記憶體 buffer（上限 1000 筆）。
// 效能相關分類（youtube / api / translate）同時非同步寫入
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
// 只持久化效能 / 流程除錯相關分類，避免 storage 爆滿。
// translate（v1.8.56 加入）：翻譯主流程的 main flow start / batch start / batch done /
// stream firstChunkOrTimeout 等 log。原本只在記憶體 buffer 1000 筆環形保留，SW idle 重啟
// 就丟失，使用者翻完文章切走幾分鐘回來看 Log 分頁就空白（上一輪 v1.8.55 撈 yt_debug_log
// 只看到 api，看不出哪一篇文章 / 哪一次觸發，診斷盲區明顯）。加入後 persisted
// 會包含這些訊號，代價是更頻繁 storage write（每筆 translate log 都進 _persistQueue）。
const PERSIST_CATEGORIES = new Set(['youtube', 'api', 'translate']);
const PERSIST_KEY = 'yt_debug_log';
const PERSIST_MAX = 100;

// ─── 異常事件 ring（2026-07-27）──────────────────────────────
// 帶 data._anomaly 標記的 log 另存低流量 ring。動機：一般 persisted ring 100 筆
// 被 translate / api 高頻 log 快速擠掉（一次整頁翻譯 ~40 筆），使用者回報「翻好
// 的字被覆蓋」等偶發異常時，隔幾小時再查 GET_PERSISTED_LOGS 已無痕跡
//（scotto.me 排查實例）。異常 ring 只收顯式標記的低頻事件，可保留數天等級的
// 回查窗口。上限 30 筆夠用——這類事件一天通常個位數
const ANOMALY_KEY = 'anomaly_log';
const ANOMALY_MAX = 30;
let _pendingAnomaly = [];

// v1.8.20: 序列化寫入避免平行 read-modify-write race(promise chain 排隊)。
// 2026-07-08: 加 debounce 批次 flush——翻譯熱路徑每批產多筆 translate/api
// log，原本每筆都是「get 整包 100 筆陣列 → push → set 整包寫回」，一分鐘內上百次
// 全陣列重寫(每次 set 還 fire storage.onChanged 到所有 context)。改記憶體累積
// 300ms 統一 flush 一次(一次 get + 一次 set 寫入全部 pending)。SW 被殺時最後一批
// pending 可能掉，persisted log 本就 best-effort，可接受。
let _persistQueue = Promise.resolve();
let _pendingPersist = [];
let _persistFlushTimer = null;
const PERSIST_FLUSH_MS = 300;

function flushPersistLogs() {
  _persistFlushTimer = null;
  if (_pendingPersist.length === 0 && _pendingAnomaly.length === 0) return;
  const batch = _pendingPersist;
  _pendingPersist = [];
  const anomalyBatch = _pendingAnomaly;
  _pendingAnomaly = [];
  _persistQueue = _persistQueue.then(async () => {
    try {
      const result = await browser.storage.local.get(PERSIST_KEY);
      const logs = result[PERSIST_KEY] || [];
      logs.push(...batch);
      if (logs.length > PERSIST_MAX) logs.splice(0, logs.length - PERSIST_MAX);
      await browser.storage.local.set({ [PERSIST_KEY]: logs });
    } catch (_) { /* 寫入失敗不影響記憶體 buffer 也不卡 queue */ }
    if (anomalyBatch.length === 0) return;
    try {
      const result = await browser.storage.local.get(ANOMALY_KEY);
      const logs = result[ANOMALY_KEY] || [];
      logs.push(...anomalyBatch);
      if (logs.length > ANOMALY_MAX) logs.splice(0, logs.length - ANOMALY_MAX);
      await browser.storage.local.set({ [ANOMALY_KEY]: logs });
    } catch (_) { /* 同上 */ }
  });
}

function persistLog(entry) {
  // 異常 ring 分流：顯式標記優先於分類過濾（異常事件不受 PERSIST_CATEGORIES 限制）
  if (entry.data && entry.data._anomaly === true) {
    _pendingAnomaly.push(entry);
    if (_pendingAnomaly.length > ANOMALY_MAX) {
      _pendingAnomaly.splice(0, _pendingAnomaly.length - ANOMALY_MAX);
    }
    if (!_persistFlushTimer) {
      _persistFlushTimer = setTimeout(flushPersistLogs, PERSIST_FLUSH_MS);
    }
  }
  if (!PERSIST_CATEGORIES.has(entry.category)) return;
  _pendingPersist.push(entry);
  if (_pendingPersist.length > PERSIST_MAX) {
    _pendingPersist.splice(0, _pendingPersist.length - PERSIST_MAX);
  }
  if (!_persistFlushTimer) {
    _persistFlushTimer = setTimeout(flushPersistLogs, PERSIST_FLUSH_MS);
  }
}

/** 取得持久化 log（唯讀，不清除 storage；清除走 Debug Bridge CLEAR_PERSISTED_LOGS）。 */
export async function getPersistedLogs() {
  // 先 flush pending(300ms debounce 中的批次)，讀取端才不會少最後幾筆
  if (_persistFlushTimer) { clearTimeout(_persistFlushTimer); }
  flushPersistLogs();
  await _persistQueue;
  const result = await browser.storage.local.get(PERSIST_KEY);
  return result[PERSIST_KEY] || [];
}

/** 取得異常事件 ring（帶 data._anomaly 標記的低頻事件，見 ANOMALY_KEY 註解）。 */
export async function getAnomalyLogs() {
  if (_persistFlushTimer) { clearTimeout(_persistFlushTimer); }
  flushPersistLogs();
  await _persistQueue;
  const result = await browser.storage.local.get(ANOMALY_KEY);
  return result[ANOMALY_KEY] || [];
}

/** 清除持久化 log storage（含異常 ring）。 */
export async function clearPersistedLogs() {
  // pending 批次一併丟棄——否則清除後 300ms flush 會把剛清掉的 log 寫回 storage
  _pendingPersist = [];
  _pendingAnomaly = [];
  if (_persistFlushTimer) { clearTimeout(_persistFlushTimer); _persistFlushTimer = null; }
  await _persistQueue;
  await browser.storage.local.remove(PERSIST_KEY);
  await browser.storage.local.remove(ANOMALY_KEY);
}

/**
 * 寫入一筆 log。不管 debugLog 開關都會進 buffer。
 *
 * @param {string} level   'info' | 'warn' | 'error'
 * @param {string} category 分類 key（translate / api / cache / glossary / spa / system）
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
    // v1.10.46(批次 2-7):截斷後不可再 JSON.parse——切到 3000 字的 JSON 字串幾乎必
    // 非法,parse throw → 走 catch 回 String(data) = "[object Object]",大 payload 在
    // Log 分頁全部無資訊。改回傳 preview 物件,保留可讀前段 + 原始長度。
    if (s.length > 3000) return { _truncated: true, originalLength: s.length, preview: s.slice(0, 3000) };
    return JSON.parse(s);
  } catch {
    return String(data);
  }
}
