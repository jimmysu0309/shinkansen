// edit-link-repair.js — contenteditable 連結邊界補位（跨環境共用單一資料源）
//
// 共用於兩處，確保「刪連結內文字後打字補回連結」邏輯只有一份：
//   - content.js（網頁編輯譯文模式，document 層 capture listener）
//   - translate-doc/index.js（EPUB 預覽編輯，逐段落 listener）
//
// 問題背景：Chromium contenteditable 的刻意設計——游標落在 <a> 的邊界（連結第
// 一個字之前 / 最後一個字之後）時，打字一律插在連結「外面」。使用者「刪掉連結
// 內的字、緊接著打替換字」（例：<a>貴公司</a> 刪「貴」補「你們」）語意上是替換
// 連結文字，但補的字掉到連結外，連結被拆散。
//
// 修法（結構性通則，不碰站點 / 內容判斷）：
//   1. beforeinput 刪除類事件用 getTargetRanges() 偵測「這次刪除動到某個 <a>
//      的內文」→ 記下該 anchor（pendingAnchor）
//   2. 之後的文字插入落地後（input insertText / IME 的 compositionend），若插入
//      內容落在該 anchor「外面」的緊鄰邊界 → 整段搬進 anchor 內對應側、游標跟移
//   3. 使用者明確移動游標（pointerdown / 方向鍵）= 放棄補位意圖，清 pending
//
// 為什麼是「事後搬移」不是 beforeinput preventDefault 攔截：中文輸入法的
// insertCompositionText 事件不可取消（cancelable=false），攔截路線對 IME 輸入
// （主要客群）根本行不通；事後搬移對 IME / 英數直打 / execCommand 貼上一體適用。
//
// 為什麼不無條件把「連結邊界打字」全部收進連結：使用者單純點在連結旁打字
//（沒先刪連結內的字）通常「不」想要連結——Chromium 預設行為對那種情境是對的。
// 只有「先刪連結內文字」建立了替換意圖，才啟動補位。
//
// 跨環境匯出：content script / translate-doc 頁走 window 全域、Node require 走
// module.exports（單元測試可直接驗 repair 純 DOM 邏輯）。
(function (global) {
  'use strict';

  // 明確移動游標的導航鍵——按了視同放棄「替換連結文字」意圖
  var NAV_KEYS = { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1, Home: 1, End: 1, PageUp: 1, PageDown: 1 };

  // opts.isEditableHost(el)：限定哪些 contenteditable host 歸這個 instance 管
  //（content.js 傳 [data-shinkansen-translated] 過濾；EPUB 預覽用預設全收）
  function createEditLinkRepair(opts) {
    var isEditableHost = (opts && opts.isEditableHost) || function () { return true; };

    var pendingAnchor = null; // 最近一次刪除動到內文的 <a>；null = 無補位意圖

    function reset() { pendingAnchor = null; }

    function closestEditable(node) {
      var el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
      if (!el || !el.closest) return null;
      var host = el.closest('[contenteditable="true"]');
      return host && isEditableHost(host) ? host : null;
    }

    // node 所在的最近 <a>（限 host 內部；host 本身是 <a> 的畸形結構不算）
    function anchorOf(node, host) {
      var el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
      if (!el || !el.closest) return null;
      var a = el.closest('a');
      return a && a !== host && host.contains(a) ? a : null;
    }

    // 跳過空 text node 的相鄰 sibling（瀏覽器編輯操作常留空節點殘渣）
    function nextSkipEmpty(node) {
      var n = node.nextSibling;
      while (n && n.nodeType === Node.TEXT_NODE && n.data === '') n = n.nextSibling;
      return n;
    }
    function prevSkipEmpty(node) {
      var n = node.previousSibling;
      while (n && n.nodeType === Node.TEXT_NODE && n.data === '') n = n.previousSibling;
      return n;
    }

    // 插入落地後檢查：data 落在 pendingAnchor 外的緊鄰邊界 → 搬進 anchor。
    // 嚴格條件（插入段必須恰好貼著 anchor 邊界、游標緊跟在插入段之後）讓
    // 「pending 殘留 + 游標其實在別處」的組合自然不命中，不會誤搬。
    function repair(data) {
      var anchor = pendingAnchor;
      if (!anchor || !anchor.isConnected || !data) return false;
      var doc = anchor.ownerDocument;
      var sel = (doc.defaultView || global).getSelection();
      if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
      var node = sel.focusNode;
      var offset = sel.focusOffset;
      if (!node || node.nodeType !== Node.TEXT_NODE) return false;
      // 瀏覽器已插在連結內（游標原本就在連結中段）——不用修
      if (anchor.contains(node)) return true;
      // 插入內容必須剛好結束在游標處
      if (offset < data.length || node.data.slice(offset - data.length, offset) !== data) return false;

      var t;
      if (offset === node.data.length && nextSkipEmpty(node) === anchor) {
        // start 邊界：插入段在 node 尾端、node 緊鄰 anchor 之前 → 搬進 anchor 開頭
        node.deleteData(offset - data.length, data.length);
        if (node.data === '') node.remove();
        t = anchor.firstChild;
        if (t && t.nodeType === Node.TEXT_NODE) {
          t.insertData(0, data);
        } else {
          t = doc.createTextNode(data);
          anchor.insertBefore(t, anchor.firstChild);
        }
        sel.collapse(t, data.length);
        return true;
      }
      if (offset === data.length && prevSkipEmpty(node) === anchor) {
        // end 邊界：插入段佔據 node 開頭、node 緊鄰 anchor 之後 → 搬進 anchor 尾端
        node.deleteData(0, data.length);
        if (node.data === '') node.remove();
        t = anchor.lastChild;
        if (t && t.nodeType === Node.TEXT_NODE) {
          t.appendData(data);
        } else {
          t = doc.createTextNode(data);
          anchor.appendChild(t);
        }
        sel.collapse(t, t.data.length);
        return true;
      }
      return false;
    }

    // beforeinput：刪除類事件記下「動到哪個 <a> 的內文」。
    // 沒動到連結的刪除也會把舊 pending 清掉（意圖已轉移）。
    function onBeforeInput(e) {
      if (!e.inputType || e.inputType.indexOf('delete') !== 0) return;
      var host = closestEditable(e.target);
      if (!host) return;
      var ranges = typeof e.getTargetRanges === 'function' ? e.getTargetRanges() : [];
      var found = null;
      for (var i = 0; i < ranges.length && !found; i++) {
        found = anchorOf(ranges[i].startContainer, host) || anchorOf(ranges[i].endContainer, host);
      }
      pendingAnchor = found;
    }

    // input：英數直打 / execCommand insertText 落地後修。
    // IME 過程的 insertCompositionText 不在此處理（組字未定），等 compositionend。
    function onInput(e) {
      if (e.inputType !== 'insertText' && e.inputType !== 'insertReplacementText') return;
      if (e.isComposing) return;
      if (!closestEditable(e.target)) return;
      repair(e.data || '');
    }

    // compositionend：IME 提交後修（e.data = 本次組字提交的完整字串）
    function onCompositionEnd(e) {
      if (!closestEditable(e.target)) return;
      repair(e.data || '');
    }

    function onPointerDown() { reset(); }

    function onKeyDown(e) { if (NAV_KEYS[e.key]) reset(); }

    return {
      onBeforeInput: onBeforeInput,
      onInput: onInput,
      onCompositionEnd: onCompositionEnd,
      onPointerDown: onPointerDown,
      onKeyDown: onKeyDown,
      reset: reset,
      // test hooks：spec 直接驗 repair 純 DOM 邏輯（模擬 IME 提交路徑）
      _repair: repair,
      _getPending: function () { return pendingAnchor; },
      _setPending: function (a) { pendingAnchor = a; }
    };
  }

  var api = { createEditLinkRepair: createEditLinkRepair };
  if (typeof window !== 'undefined') window.__SKEditLinkRepair = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
