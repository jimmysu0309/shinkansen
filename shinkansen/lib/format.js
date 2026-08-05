// format.js — 共用格式化工具函式
// 由 popup.js 與 options.js 共用，消除重複程式碼。
//
// 注意：金額邏輯(formatUSD / formatTWD)與 lib/format-currency.js(content script
// 用的 UMD 版)是同一份事實的雙實作，改任一份要兩份一起改(drift guard 見
// test/jest-unit/exchange-rate-and-format.test.cjs)。唯一刻意差異：formatMoney
// 對缺 rate 的 TWD——ESM 版顯示 NT$ 0、UMD 版 fallback 31.6(2026-06-09 評估保留)。

/**
 * 格式化 bytes 為人類可讀的 B / KB / MB 字串。
 */
export function formatBytes(b) {
  if (b < 1024) return b + ' B';
  // 閾值判斷用「捨入後值」：1048570 bytes 直接用原值判斷會落在 KB 檔位，
  // 顯示成 '1024.0 KB'（應為 '1.00 MB'）——進位縫隙。
  const kb = (b / 1024).toFixed(1);
  if (Number(kb) < 1024) return kb + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}

/**
 * 格式化 token 數為 K / M 字串。
 */
export function formatTokens(n) {
  if (n < 1_000) return String(n);
  // 同 formatBytes：999999 用原值判斷會顯示 '1000.0K'（應為 '1.00M'）。
  const k = (n / 1_000).toFixed(1);
  if (Number(k) < 1_000) return k + 'K';
  return (n / 1_000_000).toFixed(2) + 'M';
}

/**
 * 格式化美金金額。
 */
export function formatUSD(n) {
  if (!n) return '$0';
  if (n < 0.01) return '$' + n.toFixed(4);
  if (n < 1) return '$' + n.toFixed(3);
  return '$' + n.toFixed(2);
}

/**
 * 格式化台幣金額（USD × rate → NT$)。一位小數；極小值（< NT$ 0.1）用 3 位小數，
 * 避免一筆便宜翻譯顯示成 `NT$ 0.0` 看不出費用。
 *
 * @param {number} usd - USD 金額
 * @param {number} rate - 1 USD = X TWD 的匯率
 */
export function formatTWD(usd, rate) {
  // 防禦性：rate 缺失 / 0 / NaN 都視為「不能換算」，顯示 'NT$ 0' 比 'NT$ 0.000' 乾淨；
  // 上游（content.js / popup / options）有 fallback 31.6，正常情況不會走到這條
  if (!usd || !rate) return 'NT$ 0';
  const twd = usd * rate;
  if (twd < 0.1) return 'NT$ ' + twd.toFixed(3);
  return 'NT$ ' + twd.toFixed(1);
}

/**
 * 依 displayCurrency 設定 dispatch 到 formatUSD / formatTWD。
 * popup / options / toast 統一走這個入口，避免多處各自 if/else。
 *
 * @param {number} usd - 內部恆以 USD 為基準
 * @param {{ currency: 'USD'|'TWD', rate: number }} opts
 */
export function formatMoney(usd, opts = {}) {
  const currency = opts.currency || 'USD';
  if (currency === 'TWD') {
    return formatTWD(usd, opts.rate || 0);
  }
  return formatUSD(usd);
}

/**
 * 解析使用者輸入的數字。空字串/非法字元走 default，合法有限數字（含 0、負數）保留。
 *
 * 取代 `Number(v) || default`（舊寫法會把 0 當 falsy 改回預設值，造成
 *「使用者輸入 0 → 設定頁顯示預設值」的 UI 體感 bug)。
 */
export function parseUserNum(rawValue, defaultValue) {
  const v = String(rawValue ?? '').trim();
  if (v === '') return defaultValue;
  const n = Number(v);
  return Number.isFinite(n) ? n : defaultValue;
}

/**
 * 把 ms timestamp 格式化為 YYYYMMDD（本地時區）。
 */
export function formatYmd(ts) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

/**
 * 把 ms timestamp 格式化為 YYYYMMDD-HHMMSS（本地時區），供匯出檔名用
 * （設定備份 shinkansen-settings-、Log 備份 shinkansen-log-）。到秒避免
 * 同一天多次匯出檔名重複。
 *
 * issue #54：必須用本地時區（getFullYear/getHours... 系列），不可用
 * `toISOString()`——那是 UTC，台灣（UTC+8）使用者看到的檔名時間會比實際
 * 早 8 小時（例如本地早上 6 點匯出，檔名卻是前一天晚上 10 點）。
 */
export function formatYmdHms(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
         `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 組用量紀錄 CSV 匯出檔名（`shinkansen-usage-YYYYMMDD-YYYYMMDD.csv`)。
 *
 * 從 timestamp 構檔名，避開 v1.5.7 已移除的 `usage-from`/`usage-to` 元素 id —
 * 直接讀那兩個 id 會在 `$().value` 拿到 null 拋 TypeError。
 */
export function buildUsageCsvFilename(fromMs, toMs) {
  return `shinkansen-usage-${formatYmd(fromMs)}-${formatYmd(toMs)}.csv`;
}
