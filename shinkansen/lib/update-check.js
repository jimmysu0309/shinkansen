// update-check.js — GitHub Releases 更新檢查（v1.6.1 起）
//
// 為什麼有這個檔：手動從 GitHub 載入未封裝（unpacked）安裝的使用者沒有 Chrome
// Web Store 的自動更新機制，可能不知道有新版可下載。本模組透過 GitHub Releases
// API 拿最新 tag，比對 manifest.version，發現有新版就寫進 storage.local 的
// `updateAvailable` 物件，由 popup / 設定頁 / toast 三處讀取顯示提示。
//
// 觸發時機（在 background.js 註冊）：
//   - chrome.runtime.onStartup（Chrome 啟動時）
//   - chrome.alarms 'update-check' 24h 定時（Chrome 一直開著的備援）
//   - SW 第一次喚醒 fire-and-forget（背景模組載入時最早可跑的點）
//
// 對 Chrome Web Store 安裝（installType='normal'）的使用者跳過——CWS 走原生
// 自動更新機制不需要這層提示。只對 'development'（unpacked）與 'sideload'
// 兩種需要手動安裝的情境觸發。
//
// GitHub API rate limit：未驗證 60 req/hr/IP，本模組 24h 才一次離爆量很遠。

import { browser } from './compat.js';
import { debugLog } from './logger.js';

const GITHUB_RELEASES_URL =
  'https://api.github.com/repos/jimmysu0309/shinkansen/releases/latest';
const STORAGE_KEY = 'updateAvailable';

/**
 * 取「今日」鍵字串 'YYYY-MM-DD' — **使用本地時區**而非 UTC。
 * 重要：絕對不要用 `new Date().toISOString().slice(0,10)`——那是 UTC 日期，
 * 台灣（UTC+8）使用者凌晨 0–8 點之間仍是 UTC 昨天，會讓節流判斷出錯（剛 dismiss
 * 過幾小時又看到提示）。所有與 lastNoticeShownDate 比對的地方都要用此 helper。
 */
export function localTodayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 把 'v1.6.0' / '1.6.0' 字串解析成 [major, minor, patch] 陣列；
 * 任何非數字段視為 0，避免 'v1.6.0-beta' 解析爆掉。
 */
function parseVersion(v) {
  const cleaned = String(v || '').replace(/^v/, '').split('-')[0];
  const parts = cleaned.split('.').map(s => parseInt(s, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

/**
 * 判斷 latest 是否「嚴格大於」current。三段式 major.minor.patch 逐位比。
 * @returns {boolean} latest > current
 */
function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

/**
 * 判斷是否值得提示使用者更新。**只有 major 或 minor 升級才提示**，patch 級小修
 * 不打擾使用者（例如 1.6.4 → 1.6.5 不提示、1.6.4 → 1.7.0 / 2.0.0 才提示）。
 * 設計理由：頻繁的 patch 提示會讓使用者疲勞、忽略真正重要的版本。
 * @returns {boolean} 是否該顯示更新提示
 */
function isWorthNotifying(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (a[0] > b[0]) return true;       // major 升
  if (a[0] < b[0]) return false;
  if (a[1] > b[1]) return true;       // minor 升
  return false;                        // 同 major.minor，patch 級差異不提示
}

/**
 * 是否為「需要手動更新」的安裝來源（非 Chrome Web Store）。
 *
 * 判斷依據:`chrome.runtime.getManifest().update_url`。CWS 安裝時 Chrome
 * 會自動 inject 一個 update_url 欄位(指向 CWS 自動更新端點),自家
 * manifest.json 不寫此欄位 → 有 update_url = CWS,沒有 = unpacked / sideload。
 *
 * 為什麼不用 `chrome.management.getSelf()`:那需要 'management' permission,
 * CWS 審查會把它當敏感權限額外 review(它能列舉/disable 其他 extension)。
 * 我們只需要判斷「是不是 CWS 安裝」,不需要那個權限的所有能力。
 *
 * @returns {boolean}
 */
function isManualInstall() {
  try {
    const updateUrl = browser.runtime.getManifest().update_url;
    return !updateUrl;
  } catch (err) {
    // 理論上不會發生(getManifest 是同步且永遠可用)。保守估計算手動安裝。
    debugLog('warn', 'update-check', 'getManifest failed', { error: err.message });
    return true;
  }
}

/**
 * 對外主函式：檢查 GitHub 是否有新版。
 *
 * 行為：
 *   - 非手動安裝（CWS）→ 直接 return（CWS 自動更新）
 *   - fetch 失敗 / 非 200 → 寫 log 不寫 storage（避免清掉舊偵測結果）
 *   - latest > current → 寫 storage.updateAvailable
 *   - latest === current → 清 storage.updateAvailable（之前可能有殘留）
 *
 * @returns {Promise<{ checked: boolean, hasUpdate: boolean, version?: string, releaseUrl?: string, error?: string }>}
 */
export async function checkForUpdate() {
  if (!isManualInstall()) {
    return { checked: false, hasUpdate: false, error: 'CWS install — skipped' };
  }
  const currentVersion = browser.runtime.getManifest().version;
  let resp;
  // v1.8.20: AbortController 15s timeout——MV3 SW 30s idle 上限,網路差時若不主動 abort
  // 會被強制終止,fire-and-forget 訊息可能被吞;15s 留 buffer 給後續 JSON parse + storage 寫入
  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), 15_000);
  try {
    resp = await fetch(GITHUB_RELEASES_URL, {
      headers: { 'Accept': 'application/vnd.github+json' },
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const isAbort = err?.name === 'AbortError';
    debugLog('warn', 'update-check', isAbort ? 'fetch timeout' : 'fetch failed', { error: err.message });
    return { checked: false, hasUpdate: false, error: isAbort ? 'timeout' : err.message };
  }
  clearTimeout(timeoutId);
  if (!resp.ok) {
    debugLog('warn', 'update-check', `GitHub API ${resp.status}`, { status: resp.status });
    return { checked: false, hasUpdate: false, error: `HTTP ${resp.status}` };
  }
  let json;
  try {
    json = await resp.json();
  } catch (err) {
    debugLog('warn', 'update-check', 'response not JSON', { error: err.message });
    return { checked: false, hasUpdate: false, error: 'invalid JSON' };
  }
  const latestTag = json?.tag_name || '';
  const latestVersion = String(latestTag).replace(/^v/, '');
  const releaseUrl = json?.html_url || `https://github.com/jimmysu0309/shinkansen/releases/tag/${latestTag}`;

  // v1.6.4: 只對 major / minor 升級提示——patch 級小修不打擾使用者。
  if (isWorthNotifying(latestVersion, currentVersion)) {
    const payload = {
      version: latestVersion,
      releaseUrl,
      checkedAt: Date.now(),
    };
    // 不要直接覆蓋 lastNoticeShownDate，保留它（每日節流跨 update check）
    const existing = await browser.storage.local.get(STORAGE_KEY);
    const merged = {
      ...payload,
      lastNoticeShownDate: existing[STORAGE_KEY]?.lastNoticeShownDate || null,
    };
    await browser.storage.local.set({ [STORAGE_KEY]: merged });
    debugLog('info', 'update-check', 'new version detected', {
      current: currentVersion, latest: latestVersion,
    });
    return { checked: true, hasUpdate: true, version: latestVersion, releaseUrl };
  }

  // 沒有新版 → 清掉之前可能的 stale 紀錄
  await browser.storage.local.remove(STORAGE_KEY);
  debugLog('info', 'update-check', 'up-to-date', {
    current: currentVersion, latest: latestVersion,
  });
  return { checked: true, hasUpdate: false, version: latestVersion };
}

/**
 * 標記「今天已顯示過更新提示」。toast / banner 點擊「下次再說」時呼叫。
 * 用於每日節流——同一天 toast 不再重複出現，但隔天又會。
 */
export async function markUpdateNoticeShown() {
  const existing = await browser.storage.local.get(STORAGE_KEY);
  const cur = existing[STORAGE_KEY];
  if (!cur) return;
  await browser.storage.local.set({
    [STORAGE_KEY]: { ...cur, lastNoticeShownDate: localTodayKey() },
  });
}

/**
 * 是否「今日尚未顯示過 toast 提示」——content-toast.js 用此判斷是否在成功 toast
 * 加更新通知一行。
 */
export async function shouldShowTodayNotice() {
  const { [STORAGE_KEY]: cur } = await browser.storage.local.get(STORAGE_KEY);
  if (!cur || !cur.version) return null;
  if (cur.lastNoticeShownDate === localTodayKey()) return null;
  return { version: cur.version, releaseUrl: cur.releaseUrl };
}

// 匯出供測試
export { parseVersion, isNewer, isWorthNotifying };
