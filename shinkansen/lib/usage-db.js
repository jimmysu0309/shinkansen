// usage-db.js — 翻譯用量紀錄 IndexedDB 封裝（v0.86 新增）
// 職責：持久化每次翻譯的 token 用量、費用、網站資訊，
//       並提供時間範圍查詢、聚合統計、CSV 匯出。
// 選用 IndexedDB 而非 chrome.storage.local，因為後者 10MB 上限
// 已被翻譯快取佔用大部分，而 IndexedDB 容量遠大於此。

const DB_NAME = 'shinkansen-usage';
const DB_VERSION = 1;
const STORE_NAME = 'translations';

/** 取得或建立 IndexedDB 連線（singleton Promise） */
let _dbPromise = null;
let _db = null; // 目前 resolve 出來的連線,供 onclose / onversionchange 比對是否仍是當前連線
function getDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      _db = db;
      // v1.10.39(code review 2026-06-09 M4):連線被外部關閉時把 singleton 失效,讓下次
      // getDB 重建。否則 _dbPromise 會 cache 著死連線,後續 db.transaction() 一律丟
      // InvalidStateError → 所有 usage 寫入靜默失敗直到 SW 重啟。比對 _db === db 確保
      // 只在「關閉的是當前連線」時才失效(避免舊連線的晚到 onclose 誤殺新連線)。
      //   - onclose:瀏覽器強制關閉連線(例如儲存空間壓力)
      //   - onversionchange:其他 context 升級 DB → 主動關閉本連線讓升級進行
      db.onclose = () => { if (_db === db) { _db = null; _dbPromise = null; } };
      db.onversionchange = () => {
        try { db.close(); } catch (_) { /* 略 */ }
        if (_db === db) { _db = null; _dbPromise = null; }
      };
      resolve(db);
    };
    req.onerror = () => {
      _dbPromise = null;
      reject(req.error);
    };
  });
  return _dbPromise;
}

/**
 * 寫入一筆翻譯用量紀錄。
 * @param {Object} record
 * @param {string} record.url — 翻譯頁面的完整 URL
 * @param {string} record.title — 頁面標題
 * @param {string} record.model — Gemini 模型 ID
 * @param {number} record.inputTokens — 原始輸入 token 數
 * @param {number} record.outputTokens — 輸出 token 數
 * @param {number} record.cachedTokens — Gemini implicit cache 命中 token 數
 * @param {number} record.billedInputTokens — 計費輸入 token 數
 * @param {number} record.billedCostUSD — 實際計費金額（USD）
 * @param {number} record.segments — 翻譯段落數
 * @param {number} record.cacheHits — 本地快取命中段落數
 * @param {number} record.durationMs — 翻譯耗時（毫秒）
 * @param {number} record.timestamp — Date.now()
 * @param {string} [record.engine] — v1.4.0: 翻譯引擎 'gemini' | 'google'（舊紀錄無此欄位則為 Gemini）
 * @param {number} [record.chars] — v1.4.0: Google Translate 用，翻譯字元數
 */
export async function logTranslation(record) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * v1.4.18: 合併同一支 YouTube 影片的用量紀錄。
 * 規則：若 (videoId + model) 在 mergeWindowMs 內已有紀錄 → 累加 tokens/segments/
 * cacheHits/durationMs，timestamp 更新為最新；否則新建。換 model 或超過視窗都
 * 會拆成新紀錄。
 *
 * 在 background.js 的 LOG_USAGE handler 為 YouTube 分流呼叫；網頁翻譯仍走
 * logTranslation（一頁一筆即為自然單位）。
 *
 * @param {Object} record — 同 logTranslation 的 shape，需含 `videoId`、`model`、`timestamp`
 * @param {number} [mergeWindowMs=3600000] — 合併視窗（預設 1 小時）
 * @returns {Promise<number>} 被寫入 / 更新的紀錄 id
 */
export async function upsertYouTubeUsage(record, mergeWindowMs = 3600000) {
  const videoId = record?.videoId;
  const model = record?.model;
  if (!videoId || !model) {
    // 缺 key 欄位就 fallback 到一般 add，避免誤合併
    return logTranslation(record);
  }
  const now = record.timestamp || Date.now();
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('timestamp');
    // 用 timestamp 索引反向掃視窗內的紀錄，找首個 videoId+model 相符者。
    // lowerBound 確保只走視窗內，避免整表掃描。
    const range = IDBKeyRange.lowerBound(now - mergeWindowMs);
    const req = index.openCursor(range, 'prev');
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const v = cursor.value;
        // v2.0.78：合併鍵含 source——Drive 字幕（source='drive-subtitle'）同走此 upsert，
        // 與 YouTube 紀錄不互相合併（理論上 videoId 空間也不重疊，雙保險）
        if (v.source === record.source && v.videoId === videoId && v.model === model) {
          const merged = {
            ...v,
            inputTokens:       (v.inputTokens       || 0) + (record.inputTokens       || 0),
            outputTokens:      (v.outputTokens      || 0) + (record.outputTokens      || 0),
            cachedTokens:      (v.cachedTokens      || 0) + (record.cachedTokens      || 0),
            billedInputTokens: (v.billedInputTokens || 0) + (record.billedInputTokens || 0),
            billedCostUSD:     (v.billedCostUSD     || 0) + (record.billedCostUSD     || 0),
            segments:          (v.segments          || 0) + (record.segments          || 0),
            cacheHits:         (v.cacheHits         || 0) + (record.cacheHits         || 0),
            durationMs:        (v.durationMs        || 0) + (record.durationMs        || 0),
            timestamp:         now,
            title:             record.title || v.title,
            url:               record.url   || v.url,
          };
          const putReq = cursor.update(merged);
          putReq.onsuccess = () => resolve(v.id);
          putReq.onerror = () => reject(putReq.error);
          return;
        }
        cursor.continue();
      } else {
        // 視窗內無相符紀錄 → 新建
        const addReq = store.add(record);
        addReq.onsuccess = () => resolve(addReq.result);
        addReq.onerror = () => reject(addReq.error);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * v1.5.7: 合併同一篇 URL 的 Google Translate 用量紀錄。
 * 翻譯一篇文章常分 5–20 批送出，每批 1 個 URL；如果照 logTranslation 寫，會在用量
 * 紀錄表炸出十幾筆同 URL/同分鐘的 Google MT entry，無法閱讀。改用「(url + 'google',
 * 1 小時視窗)」合併成一筆——同一頁短時間多次按翻譯也會合併，跨頁與超過視窗會拆。
 *
 * 對齊 v1.4.18 upsertYouTubeUsage 設計，但合併鍵從 videoId+model 換成
 * url+engine（model 永遠 'google-translate'，不需要再判 model 變化）。
 *
 * @param {Object} record — 必須含 url、engine='google'、timestamp
 * @param {number} [mergeWindowMs=180000] 預設 3 分鐘——一篇文章從按下快速鍵到所有
 *   批次完成通常 < 1 分鐘；3 分鐘留給「翻完馬上重翻一次」這類連續操作合併。超過
 *   3 分鐘代表使用者可能離開又回來，當作不同工作 session 拆開記錄。
 * @returns {Promise<number>} 被寫入 / 更新的紀錄 id
 */
export async function upsertGoogleUsage(record, mergeWindowMs = 180000) {
  const url = record?.url;
  if (!url || record?.engine !== 'google') {
    return logTranslation(record);
  }
  const now = record.timestamp || Date.now();
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('timestamp');
    const range = IDBKeyRange.lowerBound(now - mergeWindowMs);
    const req = index.openCursor(range, 'prev');
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const v = cursor.value;
        if (v.engine === 'google' && v.url === url) {
          const merged = {
            ...v,
            chars:     (v.chars     || 0) + (record.chars     || 0),
            segments:  (v.segments  || 0) + (record.segments  || 0),
            cacheHits: (v.cacheHits || 0) + (record.cacheHits || 0),
            durationMs:(v.durationMs|| 0) + (record.durationMs|| 0),
            timestamp: now,
            // title 用最新非空的（首批可能拿到 title，後續批次來自同 URL 也保留）
            title:     record.title || v.title || '',
          };
          const putReq = cursor.update(merged);
          putReq.onsuccess = () => resolve(v.id);
          putReq.onerror = () => reject(putReq.error);
          return;
        }
        cursor.continue();
      } else {
        const addReq = store.add(record);
        addReq.onsuccess = () => resolve(addReq.result);
        addReq.onerror = () => reject(addReq.error);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * 依時間範圍查詢紀錄（按時間倒序）。
 * @param {Object} opts
 * @param {number} [opts.from] — 起始 timestamp（含）
 * @param {number} [opts.to] — 結束 timestamp（含）
 * @returns {Promise<Array>}
 */
export async function query({ from, to } = {}) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('timestamp');
    const lower = from ?? 0;
    const upper = to ?? Date.now();
    const range = IDBKeyRange.bound(lower, upper);
    const results = [];
    const req = index.openCursor(range, 'prev'); // 倒序
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * 依時間範圍取得彙總統計。
 * @returns {Promise<{ count, totalInputTokens, totalOutputTokens, totalBilledCostUSD, byModel }>}
 */
export async function getStats({ from, to } = {}) {
  const records = await query({ from, to });
  const stats = {
    count: records.length,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalBilledInputTokens: 0,
    totalBilledCostUSD: 0,
    totalSegments: 0,
    byModel: {},
  };
  for (const r of records) {
    stats.totalInputTokens += r.inputTokens || 0;
    stats.totalOutputTokens += r.outputTokens || 0;
    stats.totalBilledInputTokens += r.billedInputTokens || 0;
    stats.totalBilledCostUSD += r.billedCostUSD || 0;
    stats.totalSegments += r.segments || 0;
    const m = r.model || 'unknown';
    if (!stats.byModel[m]) stats.byModel[m] = { count: 0, billedCostUSD: 0 };
    stats.byModel[m].count++;
    stats.byModel[m].billedCostUSD += r.billedCostUSD || 0;
  }
  return stats;
}

/**
 * 依時間範圍與粒度（日/週/月）聚合資料，供折線圖使用。
 * @param {Object} opts
 * @param {number} opts.from
 * @param {number} opts.to
 * @param {'day'|'week'|'month'} opts.groupBy
 * @returns {Promise<Array<{ period: string, totalTokens: number, billedCostUSD: number, count: number }>>}
 */
export async function getAggregated({ from, to, groupBy = 'day' } = {}) {
  const records = await query({ from, to });
  const buckets = new Map(); // period string → aggregated data

  for (const r of records) {
    const d = new Date(r.timestamp);
    let period;
    if (groupBy === 'day') {
      period = fmtDate(d);
    } else if (groupBy === 'week') {
      period = fmtWeekStart(d);
    } else {
      period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    if (!buckets.has(period)) {
      buckets.set(period, { period, totalTokens: 0, billedCostUSD: 0, count: 0 });
    }
    const b = buckets.get(period);
    b.totalTokens += (r.billedInputTokens || 0) + (r.outputTokens || 0);
    b.billedCostUSD += r.billedCostUSD || 0;
    b.count++;
  }

  // 填補空白期間（讓折線圖不跳空）
  const result = fillGaps(buckets, from, to, groupBy);
  return result;
}

/**
 * 匯出 CSV 字串。
 */
export async function exportCSV({ from, to } = {}) {
  const records = await query({ from, to });
  // 按時間正序（CSV 慣例）
  records.reverse();
  const header = '時間,網站標題,URL,模型,輸入 tokens,輸出 tokens,計費輸入 tokens,費用（USD）,段落數,本地快取命中,耗時（秒）';
  const rows = records.map(r => {
    const time = new Date(r.timestamp).toLocaleString('zh-TW', { hour12: false });
    // CSV 欄位含逗號或引號時需要 escape
    const title = csvEscape(r.title || '');
    const url = csvEscape(r.url || '');
    const model = r.model || '';
    const duration = r.durationMs ? (r.durationMs / 1000).toFixed(1) : '';
    const cost = r.billedCostUSD ? r.billedCostUSD.toFixed(6) : '0';
    return `${time},${title},${url},${model},${r.inputTokens || 0},${r.outputTokens || 0},${r.billedInputTokens || 0},${cost},${r.segments || 0},${r.cacheHits || 0},${duration}`;
  });
  // 加 BOM 讓 Excel 正確辨識 UTF-8
  return '\uFEFF' + header + '\n' + rows.join('\n');
}

/**
 * 刪除指定時間之前的紀錄。
 * @param {number} beforeTimestamp
 * @returns {Promise<number>} 刪除筆數
 */
export async function clearBefore(beforeTimestamp) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('timestamp');
    const range = IDBKeyRange.upperBound(beforeTimestamp);
    let count = 0;
    const req = index.openCursor(range);
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        count++;
        cursor.continue();
      } else {
        resolve(count);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * 清除所有紀錄。
 * @returns {Promise<void>}
 */
export async function clearAll() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ─── 工具函式 ───────────────────────────────────────────

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 取得該日期所在週的週一日期字串 */
function fmtWeekStart(d) {
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = (day === 0 ? -6 : 1) - day; // 回推到週一
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
  return fmtDate(monday);
}

/** 填補空白期間，讓折線圖不跳空 */
function fillGaps(buckets, fromTs, toTs, groupBy) {
  const result = [];
  const from = new Date(fromTs || Date.now() - 30 * 86400000);
  const to = new Date(toTs || Date.now());

  if (groupBy === 'day') {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    while (d <= to) {
      const key = fmtDate(d);
      result.push(buckets.get(key) || { period: key, totalTokens: 0, billedCostUSD: 0, count: 0 });
      d.setDate(d.getDate() + 1);
    }
  } else if (groupBy === 'week') {
    // 從 from 的週一開始
    const d = new Date(from);
    const day = d.getDay();
    const diff = (day === 0 ? -6 : 1) - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    while (d <= to) {
      const key = fmtDate(d);
      result.push(buckets.get(key) || { period: key, totalTokens: 0, billedCostUSD: 0, count: 0 });
      d.setDate(d.getDate() + 7);
    }
  } else {
    // month
    const d = new Date(from.getFullYear(), from.getMonth(), 1);
    while (d <= to) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      result.push(buckets.get(key) || { period: key, totalTokens: 0, billedCostUSD: 0, count: 0 });
      d.setMonth(d.getMonth() + 1);
    }
  }
  return result;
}

function csvEscape(str) {
  let s = str;
  // 防 CSV 公式注入：title/url 來自任意網頁(<title> 攻擊者可控),Excel 對
  // =/+/-/@ 開頭的 cell 會當公式解析(=HYPERLINK / =cmd| 類)。前置單引號中和。
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * v1.8.39: 判斷是否該跳過寫入此 record。
 * 「整頁本地 cache 全命中、沒打任何 API」的紀錄(token / chars / cost 全為 0)
 * 對使用者沒有資訊價值,只會塞滿用量列表。
 *
 * 不跳過 youtube-subtitle:它走 upsertYouTubeUsage 累計合併路徑,單次 record 為 0
 * 不代表整支影片為 0(可能是先 cache hit 後才有 API call 累進來)。
 *
 * @param {Object} record — 待寫入的紀錄
 * @returns {boolean} true = 跳過寫入
 */
export function shouldSkipUsageRecord(record) {
  if (!record) return true;
  // drive-subtitle（v2.0.78）同 youtube-subtitle 走 upsert 累計合併路徑，不跳過
  if (record.source === 'youtube-subtitle' || record.source === 'drive-subtitle') return false;
  const ip = Number(record.inputTokens) || 0;
  const op = Number(record.outputTokens) || 0;
  const ch = Number(record.chars) || 0;
  const cost = Number(record.billedCostUSD) || 0;
  return ip === 0 && op === 0 && ch === 0 && cost === 0;
}
