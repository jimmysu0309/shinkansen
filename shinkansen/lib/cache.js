// cache.js — 持久化翻譯快取
// 存在 browser.storage.local,key 為 SHA-1(原文） 加 'tc_' 前綴。
// 版本變更時會由 background.js 主動呼叫 clearAll() 清空。
//
// v0.85: 新增 LRU 淘汰機制。快取值從純字串改為 { v: 譯文, t: 時間戳 } 結構，
// 寫入時若 browser.storage.local 配額滿，依時間戳排序刪除最舊的條目騰出空間。
// 讀取時向下相容舊格式（純字串）。

import { browser } from './compat.js';
import { debugLog } from './logger.js';

const KEY_PREFIX = 'tc_';
const GLOSSARY_PREFIX = 'gloss_';   // v0.69: 術語表快取
const VERSION_KEY = '__cacheVersion';

// browser.storage.local 預設配額 10MB。保留 512KB 給非快取資料（設定、使用量統計、
// API key、RPD 計數、debug log 等），快取最多佔 9.5MB。
const CACHE_QUOTA_BYTES = 9.5 * 1024 * 1024; // 9,961,472
// 每次 LRU 淘汰時一次性騰出的目標空間（避免每次寫入都觸發淘汰）
const EVICTION_TARGET_BYTES = 1 * 1024 * 1024; // 1MB

// ─── Eviction check 節流 ──────────────────────────────────
// 避免每次 setBatch 都觸發完整的 storage 掃描。
let lastEvictionCheckTime = 0;
const EVICTION_CHECK_INTERVAL_MS = 30_000; // 最多每 30 秒檢查一次

// ─── LRU 時間戳批次更新（降低寫入頻率） ────────────────────
// getBatch 讀取時不立刻寫回時間戳，而是累積到 pendingTouches，
// 由 debounce 計時器統一 flush，減少 browser.storage.local.set 呼叫次數。
const pendingTouches = {};
let touchFlushTimer = null;
const TOUCH_FLUSH_DELAY_MS = 5000; // 5 秒後統一 flush

function scheduleTouchFlush() {
  if (touchFlushTimer) return; // 已排程，不重複
  touchFlushTimer = setTimeout(flushTouches, TOUCH_FLUSH_DELAY_MS);
}

// v1.8.20: 防止 flushTouches 把舊 value 覆蓋掉中間被 setBatch 寫進的新 value。
// 原本 pendingTouches[k] 存的是 read 當下的 (v, t) 物件,5 秒後直接 set 寫回——
// 若 setBatch 在這 5s 內寫了新譯文 V',flush 會把舊 V 蓋上去 → 下次重翻取到舊值。
// 改成 flush 前重讀 storage,逐筆比對 value 一致才更新 timestamp;不一致(已被改)就 skip。
async function flushTouches() {
  touchFlushTimer = null;
  const snapshot = { ...pendingTouches };
  const keys = Object.keys(snapshot);
  if (!keys.length) return;
  for (const k of keys) delete pendingTouches[k];
  try {
    const current = await browser.storage.local.get(keys);
    const updates = {};
    for (const k of keys) {
      const cur = current[k];
      if (cur == null) continue; // 已被淘汰,不重建
      const curV = extractValue(cur);
      const wantV = snapshot[k]?.v;
      if (curV !== wantV) continue; // 已被 setBatch 換新譯文,放棄這次 touch
      updates[k] = { v: curV, t: Date.now() };
    }
    if (Object.keys(updates).length) {
      browser.storage.local.set(updates).catch(() => {});
    }
  } catch (_) { /* fire-and-forget */ }
}

// v1.8.14: hashText LRU memo
// SHA-1 對單段不貴,但 batch 20 段 → 40 次 digest;1000 段一頁 → 2000 次。
// SubtleCrypto 是 async API 會 yield 多次,影響 streaming first-chunk 延遲。
// 同一段原文常在 getBatch + setBatch 被 hash 兩次,memo 命中率高。
const _hashCache = new Map();
const _HASH_CACHE_MAX = 500;

async function hashText(text) {
  const cached = _hashCache.get(text);
  if (cached !== undefined) {
    // LRU: 命中時搬到尾端(最新)
    _hashCache.delete(text);
    _hashCache.set(text, cached);
    return cached;
  }
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-1', buf);
  const hex = Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  _hashCache.set(text, hex);
  if (_hashCache.size > _HASH_CACHE_MAX) {
    // Map.keys() 第一個 = 最舊
    _hashCache.delete(_hashCache.keys().next().value);
  }
  return hex;
}

/**
 * 估算一個 storage entry 的大小（bytes）。
 * browser.storage.local 的計費方式是 JSON.stringify(key) + JSON.stringify(value)。
 */
function estimateEntrySize(key, value) {
  const valStr = typeof value === 'string' ? value : JSON.stringify(value);
  return key.length + valStr.length;
}

/**
 * 從快取值中提取譯文。
 * 向下相容：v0.85 以前存的是純字串，v0.85 起存 { v, t }。
 */
function extractValue(stored) {
  if (stored == null) return null;
  if (typeof stored === 'string') return stored; // 舊格式
  if (typeof stored === 'object' && stored.v != null) return stored.v; // 新格式
  return null;
}

/**
 * 包裝快取值為 LRU 結構。
 */
function wrapValue(translation) {
  return { v: translation, t: Date.now() };
}

/**
 * 提取 entry 的時間戳（用於 LRU 排序）。
 * 舊格式（純字串）沒有時間戳，視為最舊（t = 0）。
 */
function extractTimestamp(stored) {
  if (stored != null && typeof stored === 'object' && typeof stored.t === 'number') {
    return stored.t;
  }
  return 0; // 舊格式，最先被淘汰
}

/**
 * LRU 淘汰：刪除最舊的快取條目，騰出至少 targetBytes 空間。
 * 只淘汰 tc_ 和 gloss_ 前綴的快取條目，不動其他 storage 資料。
 *
 * v1.8.14: preFetchedAll 可由呼叫端傳入既已 get(null) 的 entries,避免
 * proactiveEvictionCheck 內「getCacheUsageBytes 一次 + evictOldest 又一次」雙掃。
 */
async function evictOldest(targetBytes, preFetchedAll = null) {
  const all = preFetchedAll || await browser.storage.local.get(null);
  const cacheEntries = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(KEY_PREFIX) || key.startsWith(GLOSSARY_PREFIX)) {
      cacheEntries.push({
        key,
        size: estimateEntrySize(key, value),
        t: extractTimestamp(value),
      });
    }
  }
  // 依時間戳升序排列（最舊的在前面）
  cacheEntries.sort((a, b) => a.t - b.t);

  let freed = 0;
  const toRemove = [];
  for (const entry of cacheEntries) {
    if (freed >= targetBytes) break;
    toRemove.push(entry.key);
    freed += entry.size;
  }

  if (toRemove.length > 0) {
    await browser.storage.local.remove(toRemove);
    debugLog('info', 'cache', 'LRU eviction', { removed: toRemove.length, freedKB: +(freed / 1024).toFixed(1) });
  }
  return { removed: toRemove.length, freedBytes: freed };
}

/**
 * 計算目前 storage.local 用量(bytes)。
 *
 * v1.8.14: 優先用 Chrome 原生 storage.local.getBytesInUse(null),不需把整份 storage
 * 拉進記憶體。回傳的是「整個 local 用量」(包含 cache 以外的設定 / RPD / log 等),
 * 但 cache 占大宗(9.5MB / 10MB),拿來判斷 quota 接近時夠用。
 *
 * Fallback:若 getBytesInUse 不支援(極舊瀏覽器)走 get(null) 加總。
 */
async function getCacheUsageBytes() {
  if (typeof browser.storage.local.getBytesInUse === 'function') {
    return browser.storage.local.getBytesInUse(null);
  }
  // Fallback(舊瀏覽器):走原本的全表 get + 加總
  const all = await browser.storage.local.get(null);
  let bytes = 0;
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(KEY_PREFIX) || key.startsWith(GLOSSARY_PREFIX)) {
      bytes += estimateEntrySize(key, value);
    }
  }
  return bytes;
}

/**
 * 包裝 browser.storage.local.set() 的寫入，處理配額滿的情況。
 * 若寫入失敗且錯誤訊息包含 QUOTA_BYTES，觸發 LRU 淘汰後重試一次。
 */
async function safeStorageSet(updates) {
  try {
    await browser.storage.local.set(updates);
  } catch (err) {
    const msg = err?.message || '';
    // browser.storage 配額滿的錯誤訊息包含 "QUOTA_BYTES" 或 "quota"
    if (msg.includes('QUOTA_BYTES') || msg.toLowerCase().includes('quota')) {
      debugLog('warn', 'cache', 'storage quota exceeded, triggering LRU eviction');
      await evictOldest(EVICTION_TARGET_BYTES);
      // 重試一次
      try {
        await browser.storage.local.set(updates);
      } catch (retryErr) {
        // 淘汰後仍然寫不進去（可能單筆就超過上限）→ 靜默放棄，不 crash
        debugLog('error', 'cache', 'storage write failed after eviction', { error: retryErr.message });
      }
    } else {
      // 非配額問題 → 靜默放棄，不讓快取寫入問題中斷翻譯流程
      debugLog('error', 'cache', 'storage write failed', { error: msg });
    }
  }
}

/**
 * 主動檢查：若快取已超過配額的 90%，提前淘汰，避免下次寫入才觸發。
 * 在 setBatch 之後呼叫（非同步，不阻塞翻譯流程）。
 * v1.0.4: 新增節流，最多每 30 秒檢查一次（避免大量寫入時反覆掃描 storage）。
 */
async function proactiveEvictionCheck() {
  const now = Date.now();
  if (now - lastEvictionCheckTime < EVICTION_CHECK_INTERVAL_MS) return;
  lastEvictionCheckTime = now;
  try {
    const usage = await getCacheUsageBytes();
    if (usage > CACHE_QUOTA_BYTES * 0.9) {
      debugLog('info', 'cache', 'proactive eviction triggered', { usageMB: +(usage / 1024 / 1024).toFixed(2) });
      await evictOldest(EVICTION_TARGET_BYTES);
    }
  } catch (err) {
    debugLog('warn', 'cache', 'proactive eviction check failed', { error: err.message });
  }
}

/**
 * v1.5.6: 把 keySuffix 參數正規化為單一字串。
 * 兩種接受形式：
 *   - 字串：直接當 suffix（既有 v0.70 ~ v1.4.x API，向下相容）
 *   - 物件：{ baseSuffix, glossaryHash, forbiddenHash }
 *           → baseSuffix + (glossaryHash ? '_g' + ... : '') + (forbiddenHash ? '_b' + ... : '')
 *           空字串 / null hash 一律不附加，向下相容既有快取。
 * 實作位置：放這邊可以讓 getBatch / setBatch 共用同一條規則，避免兩端組鍵不一致。
 */
function resolveKeySuffix(arg) {
  if (arg == null) return '';
  if (typeof arg === 'string') return arg;
  if (typeof arg !== 'object') return '';
  let s = arg.baseSuffix || '';
  if (arg.glossaryHash) s += '_g' + arg.glossaryHash;
  if (arg.forbiddenHash) s += '_b' + arg.forbiddenHash;
  return s;
}

/**
 * v1.5.6: 計算 forbiddenTerms 清單的穩定 hash（前 12 字元 SHA-1 hex）。
 * 排序後 JSON.stringify 確保「同一份清單不同順序」會得到相同 hash，
 * 讓使用者只是把清單裡某條搬位置不會重打整批 API。
 * 空清單回傳空字串，呼叫端可直接拿來當 forbiddenHash 欄位（resolveKeySuffix 會略過空值）。
 *
 * @param {Array<{forbidden:string, replacement:string}>} terms
 * @returns {Promise<string>} 12 字元 hex，或 ''（清單空時）
 */
export async function hashForbiddenTerms(terms) {
  if (!Array.isArray(terms) || terms.length === 0) return '';
  const sorted = [...terms]
    .filter(t => t && t.forbidden)
    .sort((a, b) => String(a.forbidden).localeCompare(String(b.forbidden)));
  if (sorted.length === 0) return '';
  const canonical = JSON.stringify(
    sorted.map(t => ({ forbidden: String(t.forbidden), replacement: String(t.replacement || '') })),
  );
  const full = await hashText(canonical);
  return full.slice(0, 12);
}

/**
 * 一次取多段譯文。回傳與輸入等長的陣列，缺的位置為 null。
 * @param {string[]} texts 原文陣列
 * @param {string|{baseSuffix?:string, glossaryHash?:string, forbiddenHash?:string}} [keySuffix='']
 *        可選的 key 後綴。字串 = 既有 API；物件 = v1.5.6 起的結構化 API。
 */
export async function getBatch(texts, keySuffix = '') {
  if (!texts.length) return [];
  const suffix = resolveKeySuffix(keySuffix);
  const hashes = await Promise.all(texts.map(hashText));
  const keys = hashes.map(h => KEY_PREFIX + h + suffix);
  const stored = await browser.storage.local.get(keys);
  // v0.85 → v1.0.4: 讀取時累積命中條目的時間戳到 pendingTouches，
  // 由 debounce 計時器統一 flush，減少寫入頻率（原本每次 getBatch 都寫一次）。
  const results = keys.map(k => {
    if (!(k in stored)) return null;
    const val = extractValue(stored[k]);
    if (val != null) {
      pendingTouches[k] = wrapValue(val);
    }
    return val;
  });
  if (Object.keys(pendingTouches).length > 0) {
    scheduleTouchFlush();
  }
  return results;
}

/**
 * 一次寫多段譯文。texts 與 translations 必須等長。
 * @param {string[]} texts 原文陣列
 * @param {string[]} translations 譯文陣列
 * @param {string|{baseSuffix?:string, glossaryHash?:string, forbiddenHash?:string}} [keySuffix='']
 *        同 getBatch — 字串或結構化物件兩種形式皆可。
 */
export async function setBatch(texts, translations, keySuffix = '') {
  if (!texts.length) return;
  const suffix = resolveKeySuffix(keySuffix);
  const hashes = await Promise.all(texts.map(hashText));
  const updates = {};
  for (let i = 0; i < texts.length; i++) {
    if (translations[i]) {
      updates[KEY_PREFIX + hashes[i] + suffix] = wrapValue(translations[i]);
    }
  }
  if (Object.keys(updates).length) {
    await safeStorageSet(updates);
    // 非同步檢查是否需要提前淘汰（不阻塞翻譯流程）
    proactiveEvictionCheck().catch(() => {});
  }
}

/**
 * v0.69: 取得術語表快取。
 * @param {string} inputHash 壓縮後輸入文字的 SHA-1 hash
 * @returns {Promise<Array|null>} 快取命中時回傳術語陣列，否則 null
 */
export async function getGlossary(inputHash) {
  const key = GLOSSARY_PREFIX + inputHash;
  const stored = await browser.storage.local.get(key);
  if (!(key in stored)) return null;
  const entry = stored[key];
  // v0.85: 向下相容 — 舊格式直接是 Array，新格式是 { v: Array, t: number }
  if (Array.isArray(entry)) return entry;
  if (entry && typeof entry === 'object' && Array.isArray(entry.v)) {
    // v1.8.20: 走 safeStorageSet,讓 quota 滿時觸發 LRU eviction 後重試,
    // 否則 timestamp 永遠寫不進去 → 活躍 glossary 被當最舊先淘汰。
    safeStorageSet({ [key]: { v: entry.v, t: Date.now() } }).catch(() => {});
    return entry.v;
  }
  return null;
}

/**
 * v0.69: 寫入術語表快取。
 * @param {string} inputHash 壓縮後輸入文字的 SHA-1 hash
 * @param {Array} glossary 術語陣列
 */
export async function setGlossary(inputHash, glossary) {
  const key = GLOSSARY_PREFIX + inputHash;
  await safeStorageSet({ [key]: { v: glossary, t: Date.now() } });
}

/** v0.69: 計算文字 SHA-1（匯出給 background 使用）。 */
export { hashText };

/**
 * 清除所有翻譯快取與術語表快取（保留版本標記等其他 local storage 內容）。
 */
export async function clearAll() {
  const all = await browser.storage.local.get(null);
  const toRemove = Object.keys(all).filter(k => k.startsWith(KEY_PREFIX) || k.startsWith(GLOSSARY_PREFIX));
  if (toRemove.length) {
    await browser.storage.local.remove(toRemove);
  }
  return toRemove.length;
}

/**
 * 取得目前快取的條目數與大致大小（bytes)。
 * v0.69: 新增 glossaryCount / glossaryBytes 分開統計術語表快取。
 * v0.85: 向下相容新舊格式的大小估算。
 */
export async function stats() {
  const all = await browser.storage.local.get(null);
  const tcEntries = Object.keys(all).filter(k => k.startsWith(KEY_PREFIX));
  const glossEntries = Object.keys(all).filter(k => k.startsWith(GLOSSARY_PREFIX));
  let bytes = 0;
  for (const k of tcEntries) {
    bytes += estimateEntrySize(k, all[k]);
  }
  let glossaryBytes = 0;
  for (const k of glossEntries) {
    glossaryBytes += estimateEntrySize(k, all[k]);
  }
  return {
    count: tcEntries.length,
    bytes,
    glossaryCount: glossEntries.length,
    glossaryBytes,
  };
}

/**
 * 比對 manifest 版本與儲存版本，若不同則清空快取並更新版本標記。
 * 回傳 true 代表有清空動作。
 */
export async function checkVersionAndClear(currentVersion) {
  const stored = await browser.storage.local.get(VERSION_KEY);
  if (stored[VERSION_KEY] !== currentVersion) {
    const removed = await clearAll();
    await browser.storage.local.set({ [VERSION_KEY]: currentVersion });
    return { cleared: true, removed, oldVersion: stored[VERSION_KEY] };
  }
  return { cleared: false };
}
