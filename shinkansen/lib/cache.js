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
const SCAN_PREFIX = 'scanr_';       // v2.0.11: 一致性掃描譯名對照快取（EPUB）
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
const TOUCH_MIN_AGE_MS = 24 * 60 * 60 * 1000; // 時間戳超過一天才更新（見 getBatch）

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
 * browser.storage.local 的計費方式是 JSON.stringify(key) + JSON.stringify(value)，
 * 且配額以 UTF-8 bytes 計——CJK 字元一個佔 3 bytes，不能用 string.length（UTF-16
 * code unit 數）直接當 bytes，否則譯文以繁中為主的 entry 會低估 ~3 倍，
 * evictOldest 一次多刪 ~2 倍的已付費快取、stats() 顯示值也失真。
 * 單次遍歷近似（不跑 TextEncoder 省 allocation）：ASCII 1 byte、其餘 3 bytes。
 */
function estimateUtf8Bytes(str) {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    bytes += str.charCodeAt(i) > 0x7f ? 3 : 1;
  }
  return bytes;
}

function estimateEntrySize(key, value) {
  const valStr = typeof value === 'string' ? value : JSON.stringify(value);
  return estimateUtf8Bytes(key) + estimateUtf8Bytes(valStr);
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
    if (key.startsWith(KEY_PREFIX) || key.startsWith(GLOSSARY_PREFIX) || key.startsWith(SCAN_PREFIX)) {
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
  const candidates = []; // { key, size, t }——保留 t 以便 remove 前比對是否被 touch
  for (const entry of cacheEntries) {
    if (freed >= targetBytes) break;
    candidates.push(entry);
    freed += entry.size;
  }

  if (candidates.length === 0) {
    return { removed: 0, freedBytes: 0 };
  }

  // v1.10.39: 防 LRU 淘汰 race(code review 2026-06-09 H3)。
  // 淘汰名單由本函式開頭的 get(null) 快照算出,但 snapshot 與下面 remove 之間,
  // flushTouches(timestamp 寫回)或 setBatch(改寫譯文)可能把某候選 entry 的 t
  // 更新成最新 → 它已不再是「最舊」,用 stale 快照淘汰會誤刪剛變最熱的 entry。
  // remove 前重讀候選的當前值,只刪「t 仍與快照一致」(期間沒被 touch / 改寫)的。
  // 誤刪後果僅是 cache miss(多打一次 API),但能避免就避免。
  const candidateKeys = candidates.map(c => c.key);
  let confirmed = candidateKeys;
  let confirmedFreed = freed;
  try {
    const fresh = await browser.storage.local.get(candidateKeys);
    confirmed = [];
    confirmedFreed = 0;
    for (const c of candidates) {
      const cur = fresh[c.key];
      if (cur == null) continue;                       // 期間已被別處刪掉
      if (extractTimestamp(cur) !== c.t) continue;     // 期間被 touch / 改寫 → 不是最舊,跳過
      confirmed.push(c.key);
      confirmedFreed += c.size;
    }
  } catch (_) {
    // 重讀失敗 → 退回用快照名單(維持原行為,寧可淘汰也不要 quota 爆掉)
    confirmed = candidateKeys;
    confirmedFreed = freed;
  }

  if (confirmed.length > 0) {
    await browser.storage.local.remove(confirmed);
    debugLog('info', 'cache', 'LRU eviction', { removed: confirmed.length, freedKB: +(confirmedFreed / 1024).toFixed(1) });
  }
  return { removed: confirmed.length, freedBytes: confirmedFreed };
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
    if (key.startsWith(KEY_PREFIX) || key.startsWith(GLOSSARY_PREFIX) || key.startsWith(SCAN_PREFIX)) {
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

// keySuffix 一律是字串（background buildCacheKeySuffix 組好的完整後綴）。
// 2026-09-12 批次 6：v1.5.6 的 { baseSuffix, glossaryHash, forbiddenHash } 物件形式自 v1.10.46
// 三條路徑收斂到 buildCacheKeySuffix 後無呼叫端，移除；getBatch / setBatch 共用這條保證兩端組鍵一致
function resolveKeySuffix(arg) {
  return (typeof arg === 'string') ? arg : '';
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
    // 時間戳還新（一天內寫過 / 讀過）的不回寫：LRU 淘汰順序精確到「天」就夠用，
    // 省掉「同一頁當天再開一次就把所有命中條目整包重寫」（實測 1,700 條一次 55–180ms 的背景寫入）
    if (val != null && Date.now() - extractTimestamp(stored[k]) > TOUCH_MIN_AGE_MS) {
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
export async function getGlossary(inputHash, suffix = '') {
  // P1: suffix 帶 _lang<x>(非 zh-TW target)區隔 glossary cache。
  // 空字串維持既有 key 結構,zh-TW 使用者升級後 cache 仍 hit。
  const key = GLOSSARY_PREFIX + inputHash + suffix;
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
 * @param {string} suffix P1: cache key 後綴(非 zh-TW target 用,維持向下相容)
 */
export async function setGlossary(inputHash, glossary, suffix = '') {
  const key = GLOSSARY_PREFIX + inputHash + suffix;
  await safeStorageSet({ [key]: { v: glossary, t: Date.now() } });
}

/**
 * v2.0.11: 一致性掃描譯名對照快取（同 payload 同結果，續翻後重掃不重複計費）。
 * 內容指紋為 key，跟 gloss_ 同 { v, t } 格式、同 LRU 淘汰池。
 */
export async function getScanRenderings(inputHash) {
  const key = SCAN_PREFIX + inputHash;
  const stored = await browser.storage.local.get(key);
  const entry = stored[key];
  if (entry && typeof entry === 'object' && Array.isArray(entry.v)) {
    safeStorageSet({ [key]: { v: entry.v, t: Date.now() } }).catch(() => {});
    return entry.v;
  }
  return null;
}

export async function setScanRenderings(inputHash, renderings) {
  const key = SCAN_PREFIX + inputHash;
  await safeStorageSet({ [key]: { v: renderings, t: Date.now() } });
}

/** v0.69: 計算文字 SHA-1（匯出給 background 使用）。 */
export { hashText };

/**
 * 清除所有翻譯快取與術語表快取（保留版本標記等其他 local storage 內容）。
 */
export async function clearAll() {
  const all = await browser.storage.local.get(null);
  const toRemove = Object.keys(all).filter(k => k.startsWith(KEY_PREFIX) || k.startsWith(GLOSSARY_PREFIX) || k.startsWith(SCAN_PREFIX));
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
  // 2026-09-14 批次 7 §6.3：每次開 popup 都 storage.local.get(null) 把整池（可達 9.5MB）
  // 反序列化進記憶體只為數條數 / 估 bytes。Chrome 130+ / Firefox 135+ 有 getKeys()
  //（只回 key 清單不載值），bytes 改問原生 getBytesInUse(keys)（Firefox local 沒有
  // getBytesInUse → 走舊法）。原生 bytes 是 storage 實際佔用（key + JSON 序列化值），
  // 與舊估算（ASCII 1 / 其他 3 bytes 近似）同量級但不逐 byte 相等；此值只供 popup /
  // Debug Bridge 顯示，不參與 eviction 判斷（evictOldest 走 getCacheUsageBytes）。
  const area = browser.storage.local;
  if (typeof area.getKeys === 'function' && typeof area.getBytesInUse === 'function') {
    try {
      const keys = await area.getKeys();
      const tcEntries = keys.filter(k => k.startsWith(KEY_PREFIX));
      const glossEntries = keys.filter(k => k.startsWith(GLOSSARY_PREFIX));
      const [bytes, glossaryBytes] = await Promise.all([
        tcEntries.length ? area.getBytesInUse(tcEntries) : 0,
        glossEntries.length ? area.getBytesInUse(glossEntries) : 0,
      ]);
      return { count: tcEntries.length, bytes, glossaryCount: glossEntries.length, glossaryBytes };
    } catch (_) {
      // 落回全表掃描（下方）
    }
  }
  const all = await area.get(null);
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
 * W7:清除所有文件翻譯快取(cacheTag '_doc' 的 entries),不影響網頁 / 字幕 /
 * 術語表快取。translate-doc/settings.html「進階」區塊用。
 *
 * cache key 結構（見 background.js buildCacheKeySuffix）:
 *   tc_<sha1(40hex)> + cacheTag（'_doc' / '_oc_doc'）+ 可選 '_g<hash>' + 可選 '_b<hash>'
 *   + '_m<model>' + 可選 '_lang<tl>' + 可選 '_t<temp>'
 * cacheTag 緊接在 sha1 之後，用錨定 regex 比對——不可用 /_doc(_m|$)/ 這種
 * 「_doc 後面必接 _m」的假設：forbiddenTerms / glossary 非空時 '_doc' 後接的是
 * '_b' / '_g'，會整批漏清（zh-TW 預設就有 26 條 forbiddenTerms，等於預設使用者
 * 按「清除文件翻譯記憶」實際清 0 筆）。
 *
 * @returns {Promise<number>} 清除的 entry 數
 */
export async function clearDocTranslationCache() {
  const all = await browser.storage.local.get(null);
  // v2.0.11: bookgloss_ 是 EPUB 全書術語表持久化 key(translate-doc 頁寫入)，
  // 屬文件翻譯 cache 範疇，「清除文件翻譯快取」一併清
  const docKeys = Object.keys(all).filter((k) =>
    /^tc_[0-9a-f]{40}(?:_oc)?_doc(?:_|$)/.test(k) || k.startsWith('bookgloss_'));
  if (docKeys.length > 0) {
    await browser.storage.local.remove(docKeys);
  }
  return docKeys.length;
}

/**
 * 一次性 migration:清掉所有 tc_* 翻譯 cache(不含 glossary_*)。
 * flagKey 在 storage.local 設過後不再清,確保 onInstalled / onStartup 兩處
 * 都呼叫也只跑一次。W7(PDF inline rich text marker)用此清掉舊 plainText
 * sha1 對應的 cache,讓所有 PDF 重新打 API。網頁 cache 共用 tc_ 前綴無法精準
 * 分,一併清掉是 W7 prompt 變動的代價。
 *
 * @param {string} flagKey 例 '__shinkansen_w7_cache_migrated'
 * @returns {Promise<{ cleared: number, ranMigration: boolean }>}
 */
export async function migrateClearTranslationCacheOnce(flagKey) {
  const flagged = await browser.storage.local.get(flagKey);
  if (flagged[flagKey]) return { cleared: 0, ranMigration: false };
  const all = await browser.storage.local.get(null);
  const tcKeys = Object.keys(all).filter((k) => k.startsWith(KEY_PREFIX));
  if (tcKeys.length > 0) {
    await browser.storage.local.remove(tcKeys);
  }
  await browser.storage.local.set({ [flagKey]: true });
  return { cleared: tcKeys.length, ranMigration: true };
}

/**
 * 一次性 migration:只清掉 Google MT 路徑的翻譯 cache(tc_<sha1>_gt[...])。
 * Gemini / openai-compat 路徑(tc_<sha1>'' / _yt / _doc / _oc_*)不動,避免使用者
 * 為了清 Google MT garbage 損失 Gemini 已付費翻譯結果。
 *
 * 觸發時機:v1.9.8 修了「混批 Google MT 把英文段攪成 garbage」(英文殘骸 +
 * 漢字殘渣),這類 garbage 已寫進 cache。新版只阻止下一次 fetch 被混批拖垮,
 * 既有 garbage entry 還躺在 storage,SPA rescan / 重翻同頁撈 cache hit 仍會
 * 直接吐 garbage。本 migration 一次性掃掉 Google MT cache,讓所有 Google MT
 * 翻譯下次重打 API 走新分群路徑。Gemini cache 不受影響。
 *
 * Key 結構:`tc_<sha1 40 hex>_gt[_drive|_yt|_lang<x>...]`。
 * 過濾用正則 /^tc_[0-9a-f]{40}_gt/ 從 sha1 後第一格認 `_gt` 邊界,Gemini /
 * openai-compat 等其他 provider suffix(''/'_yt'/'_oc_yt'/'_doc' etc.)不會誤刪。
 *
 * @param {string} flagKey 例 '__shinkansen_v198_google_mt_cache_cleared'
 * @returns {Promise<{ cleared: number, ranMigration: boolean }>}
 */
export async function migrateClearGoogleMtCacheOnce(flagKey) {
  const flagged = await browser.storage.local.get(flagKey);
  if (flagged[flagKey]) return { cleared: 0, ranMigration: false };
  const all = await browser.storage.local.get(null);
  const gtRe = /^tc_[0-9a-f]{40}_gt/;
  const gtKeys = Object.keys(all).filter((k) => gtRe.test(k));
  if (gtKeys.length > 0) {
    await browser.storage.local.remove(gtKeys);
  }
  await browser.storage.local.set({ [flagKey]: true });
  return { cleared: gtKeys.length, ranMigration: true };
}

/**
 * 一次性 migration：只清掉 LLM 文件翻譯（PDF / EPUB 等）的翻譯 cache（cacheTag '_doc' / '_oc_doc'）。
 * 網頁、字幕、Google MT、術語表（含 EPUB 全書術語表 bookgloss_）都不動。
 *
 * 用在文件翻譯專用的提示變動時：cache key 不含提示文字，舊提示產的譯文會一直 cache hit，
 * 使用者升級後看不到修正。清的範圍只限文件翻譯，不讓使用者為此損失網頁翻譯的快取。
 * 比對方式與 clearDocTranslationCache 相同（cacheTag 緊接在 sha1 之後，錨定比對）。
 *
 * @param {string} flagKey 例 '__shinkansen_v269_doc_cache_cleared'
 * @returns {Promise<{ cleared: number, ranMigration: boolean }>}
 */
export async function migrateClearDocTranslationCacheOnce(flagKey) {
  const flagged = await browser.storage.local.get(flagKey);
  if (flagged[flagKey]) return { cleared: 0, ranMigration: false };
  const all = await browser.storage.local.get(null);
  const docRe = /^tc_[0-9a-f]{40}(?:_oc)?_doc(?:_|$)/;
  const docKeys = Object.keys(all).filter((k) => docRe.test(k));
  if (docKeys.length > 0) {
    await browser.storage.local.remove(docKeys);
  }
  await browser.storage.local.set({ [flagKey]: true });
  return { cleared: docKeys.length, ranMigration: true };
}

/**
 * 一次性 migration：清掉網頁翻譯與影片字幕的翻譯 cache（tc_* 當中不屬於 LLM 文件翻譯的全部）。
 * LLM 文件翻譯（cacheTag '_doc' / '_oc_doc'）、術語表（含 EPUB 全書術語表 bookgloss_）都不動——
 * 整本書的譯文重翻成本高，文件翻譯的快取另由 migrateClearDocTranslationCacheOnce 視需要處理。
 *
 * 用在網頁 / 字幕路徑累積了一批會改變譯文的修正時：cache key 不含這些修正，舊譯文會一直
 * cache hit，使用者升級後看不到修正。
 * 「是不是文件翻譯」的比對方式與 clearDocTranslationCache 相同（cacheTag 緊接在 sha1 之後，錨定比對）。
 *
 * @param {string} flagKey 例 '__shinkansen_v270_page_subtitle_cache_cleared'
 * @returns {Promise<{ cleared: number, ranMigration: boolean }>}
 */
export async function migrateClearPageAndSubtitleCacheOnce(flagKey) {
  const flagged = await browser.storage.local.get(flagKey);
  if (flagged[flagKey]) return { cleared: 0, ranMigration: false };
  const all = await browser.storage.local.get(null);
  const docRe = /^tc_[0-9a-f]{40}(?:_oc)?_doc(?:_|$)/;
  const keys = Object.keys(all).filter((k) => k.startsWith(KEY_PREFIX) && !docRe.test(k));
  if (keys.length > 0) {
    await browser.storage.local.remove(keys);
  }
  await browser.storage.local.set({ [flagKey]: true });
  return { cleared: keys.length, ranMigration: true };
}

/**
 * 比對 manifest 版本與儲存版本,版本變更時更新標記。
 *
 * v1.8.45 起改成「不清快取」:過去版本變更會 clearAll(),理由是 prompt / cache
 * key 結構改後可能有 stale entry。但 cache key 本身已含 model / glossary hash /
 * forbidden hash 各自決定 miss/hit,prompt 改若要強制 miss 應由使用者手動「清除
 * 快取」按鈕觸發。每次版本變更自動清會讓累積翻譯白白浪費 API 費,違反 Jimmy 的
 * 體驗預期。
 *
 * 回傳 changed 表示版本標記是否更新(永遠不清快取)。
 */
export async function checkVersionAndClear(currentVersion) {
  const stored = await browser.storage.local.get(VERSION_KEY);
  if (stored[VERSION_KEY] !== currentVersion) {
    await browser.storage.local.set({ [VERSION_KEY]: currentVersion });
    return { cleared: false, changed: true, oldVersion: stored[VERSION_KEY] };
  }
  return { cleared: false, changed: false };
}
