// format-currency.js — 金額格式化 + fallback 匯率常數（content script 與 Node 測試共用）
//
// content script 不能 import ES module，故用 UMD 寫法（掛 window.__SKFormat + module.exports），
// 比照 lib/shortcut-utils.js。content 世界的金額格式化（content-toast.js / content.js）統一走這份
// 單一來源，避免各自硬編 31.6 與重複定義 formatUSD / formatTWD。
//
// popup / options 走 ES module 的 lib/format.js（同邏輯）——因為帶 export 的 ES module 檔不能
// 同時當 classic content script 載入，兩個世界無法共用同一檔，這是已知架構限制。改其中一份金額
// 邏輯時兩份要一起改。
(function (global) {
  'use strict';

  // 1 USD = X TWD 的 fallback 匯率（background.js 每天 fetch 真實匯率寫進 storage，
  // 讀不到時才用這個保守值）。lib/exchange-rate.js 的 FALLBACK_USD_TWD_RATE 是 ES module
  // 世界的同一個常數。
  var FALLBACK_USD_TWD_RATE = 31.6;

  function formatUSD(n) {
    if (!n) return '$0';
    if (n < 0.01) return '$' + n.toFixed(4);
    if (n < 1) return '$' + n.toFixed(3);
    return '$' + n.toFixed(2);
  }

  // v1.8.41：TWD 格式化（USD × rate → NT$，一位小數；極小值 < NT$ 0.1 用 3 位）
  // rate 防禦與 lib/format.js formatTWD 對齊——直呼且 rate undefined 時不可顯示 NT$ NaN
  function formatTWD(usd, rate) {
    if (!usd || !rate) return 'NT$ 0';
    var twd = usd * rate;
    if (twd < 0.1) return 'NT$ ' + twd.toFixed(3);
    return 'NT$ ' + twd.toFixed(1);
  }

  // 依 state 自動選擇 USD / TWD 顯示。state = { currency: 'USD'|'TWD', rate }。
  function formatMoney(usd, state) {
    var st = state || {};
    if (st.currency === 'TWD') return formatTWD(usd, st.rate || FALLBACK_USD_TWD_RATE);
    return formatUSD(usd);
  }

  /*
   * 實際顯示用的幣別（code review 2026-11-15 O-1）。幣別選項只在繁中介面出現（設定頁
   * _updateCurrencySectionVisibility），其他介面語言的使用者沒有地方可改，存下來的值
   *（預設 TWD）也不是他們選的 → 非繁中介面一律 USD；繁中介面照存下來的選擇，沒存過為 TWD。
   * uiLang 傳「已解析的介面語言」（I18N.getUiLanguage 的結果），不是 'auto'。
   * ES module 世界的同一份實作在 lib/format.js（雙實作，改任一份兩份一起改）。
   */
  function resolveDisplayCurrency(savedCurrency, uiLang) {
    if (uiLang !== 'zh-TW') return 'USD';
    return savedCurrency === 'USD' ? 'USD' : 'TWD';
  }

  var api = {
    FALLBACK_USD_TWD_RATE: FALLBACK_USD_TWD_RATE,
    formatUSD: formatUSD,
    formatTWD: formatTWD,
    formatMoney: formatMoney,
    resolveDisplayCurrency: resolveDisplayCurrency,
  };
  if (typeof window !== 'undefined') window.__SKFormat = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
