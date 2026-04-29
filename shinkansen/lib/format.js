// format.js — 共用格式化工具函式
// 由 popup.js 與 options.js 共用，消除重複程式碼。

/**
 * 格式化 bytes 為人類可讀的 B / KB / MB 字串。
 */
export function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}

/**
 * 格式化 token 數為 K / M 字串。
 */
export function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
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
 * 解析使用者輸入的數字。空字串/非法字元走 default,合法有限數字(含 0、負數)保留。
 *
 * 取代 `Number(v) || default`(舊寫法會把 0 當 falsy 改回預設值,造成
 *「使用者輸入 0 → 設定頁顯示預設值」的 UI 體感 bug)。
 */
export function parseUserNum(rawValue, defaultValue) {
  const v = String(rawValue ?? '').trim();
  if (v === '') return defaultValue;
  const n = Number(v);
  return Number.isFinite(n) ? n : defaultValue;
}

/**
 * 把 ms timestamp 格式化為 YYYYMMDD(本地時區)。
 */
export function formatYmd(ts) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

/**
 * 組用量紀錄 CSV 匯出檔名(`shinkansen-usage-YYYYMMDD-YYYYMMDD.csv`)。
 *
 * 從 timestamp 構檔名,避開 v1.5.7 已移除的 `usage-from`/`usage-to` 元素 id —
 * 直接讀那兩個 id 會在 `$().value` 拿到 null 拋 TypeError。
 */
export function buildUsageCsvFilename(fromMs, toMs) {
  return `shinkansen-usage-${formatYmd(fromMs)}-${formatYmd(toMs)}.csv`;
}
