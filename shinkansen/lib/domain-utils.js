// domain-utils.js — 自動翻譯網站名單的網域正規化 + 比對（content script 與 Node 測試共用）
//
// content script 不能 import ES module，故用 UMD 寫法（掛 window.__SKDomain + module.exports），
// 比照 lib/format-currency.js / lib/shortcut-utils.js。content-spa.js 的白名單比對統一走這份
// 單一來源，避免比對規則散落多處 drift。
//
// 背景：使用者在 options「自動翻譯網站」每行填一個網域，但實際常貼完整網址
//（`https://stratechery.com/`）。比對時的 location.hostname 只有 `stratechery.com`，
// 協定與尾斜線會讓 exact-match 永遠不命中。normalizeDomainEntry 把使用者任意形式的輸入
//（含協定 / 路徑 / query / hash / 尾斜線 / 埠號 / www. / 尾端點）收斂成純主機名，
// 讓 `https://stratechery.com/`、`stratechery.com/`、`stratechery.com` 三者等價。
(function (global) {
  'use strict';

  // 把一行白名單輸入正規化成純主機名。保留萬用字元前綴 `*.`（比對子網域用）。
  // 結構性通則：只看 URL 語法特徵（協定 / 路徑分隔 / 埠號 / www.），非站點特判。
  function normalizeDomainEntry(raw) {
    var s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!s) return '';
    // 保留萬用字元前綴 `*.`，其餘照網域正規化後再接回
    var wildcard = '';
    if (s.indexOf('*.') === 0) { wildcard = '*.'; s = s.slice(2); }
    // 去掉協定（https:// / http:// / 任意 scheme://）
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    // 去掉路徑 / query / hash，只留主機名（含可能的埠號）
    s = s.split(/[/?#]/)[0];
    // 去掉埠號與使用者輸入殘留的尾端點
    s = s.replace(/:\d+$/, '').replace(/\.+$/, '');
    return wildcard + s;
  }

  // hostname 是否命中白名單。比對規則：
  //   - `*.example.com`：命中 example.com 自身與所有子網域
  //   - 一般網域：兩邊都去掉開頭 `www.` 再 exact-match
  //     （讓 `culpium.com` 與 `www.culpium.com` 互通；要匹配所有子網域請用 `*.culpium.com`）
  function matchDomain(hostname, whitelist) {
    if (!hostname || !Array.isArray(whitelist) || !whitelist.length) return false;
    var host = String(hostname).toLowerCase();
    var normHost = host.replace(/^www\./, '');
    return whitelist.some(function (raw) {
      var pattern = normalizeDomainEntry(raw);
      if (!pattern) return false;
      if (pattern.indexOf('*.') === 0) {
        var suffix = pattern.slice(1);       // ".example.com"
        return host === pattern.slice(2) || host.endsWith(suffix);
      }
      return normHost === pattern.replace(/^www\./, '');
    });
  }

  // byDomain 物件（網域專用術語表等「以網域字串為 key」的設定）中，hostname 命中
  // 哪些 key。key 是使用者輸入的任意形式（可能含協定 / www. / 尾斜線），比對規則
  // 與 matchDomain 完全一致（單一資料源）：`*.` 萬用字元、www. 互通、輸入正規化。
  // 回傳排序後的命中 key 陣列（多 key 命中時呼叫端合併順序穩定）。
  function matchingDomainKeys(hostname, byDomain) {
    if (!hostname || !byDomain || typeof byDomain !== 'object' || Array.isArray(byDomain)) return [];
    return Object.keys(byDomain).filter(function (key) {
      return matchDomain(hostname, [key]);
    }).sort();
  }

  var api = {
    normalizeDomainEntry: normalizeDomainEntry,
    matchDomain: matchDomain,
    matchingDomainKeys: matchingDomainKeys
  };
  // global = window（頁面 / content script）或 globalThis（MV3 service worker 的
  // ES module import 副作用載入——SW 沒有 window，background.js 走 globalThis.__SKDomain）
  global.__SKDomain = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
