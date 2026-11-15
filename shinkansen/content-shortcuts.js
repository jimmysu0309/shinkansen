// content-shortcuts.js — 自訂快速鍵 content script（捕捉 keydown → 本地 dispatch）
//
// 動機：Safari（含 iOS / iPadOS）沒有使用者自訂快速鍵入口（Chrome 有
// chrome://extensions/shortcuts;Firefox 有 about:addons),iPad 外接鍵盤使用者
// 完全無法改鍵。Safari 也不支援 commands.update()——manifest suggested_key 是死的。
// 唯一通用解是 content script 層自己攔 keydown:options 錄製的組合存
// storage.sync.customShortcuts，這裡比對命中後直接呼叫 SK.handleTranslatePreset(slot)。
//
// 為何本地 dispatch（不繞 background）：SK.handleTranslatePreset 已含完整 toggle
// 邏輯（閒置→翻譯 / 翻譯中→abort / 已翻譯→restore），跟 commands onCommand 的
// Alt+S 與四指 tap 同一條決策入口（單一資料源）。content 端直接呼叫 = 零訊息
// 往返，也避開 iOS Safari background 被系統回收後不再喚醒的問題。
//
// 與 manifest 預設鍵的關係：預設鍵在 browser 層、程式停不掉，兩者並存。
// shortcut-utils.validate 拒絕「自訂值 == 預設值」避免同一按鍵雙觸發。
//
// 已知限制（與 browser 層快速鍵的差異）:
//   - 位址列 / devtools focus 時頁面收不到 keydown，自訂鍵無效
//   - content script 沒注入的頁（chrome:// 等）無效
//   這些情境 manifest 預設鍵（browser 層，桌面）仍然有效，作為 fallback。
(function (SK) {
  'use strict';
  if (!SK || SK.disabled) return;  // iframe gate（見 content-ns.js）：被擋的 frame 不掛 listener
  const SC = window.__SKShortcuts;
  if (!SC) return;
  if (SK.customShortcuts) return; // 防重複注入（SPA 導航再注入保險）

  // slot → shortcut 物件（null = 未自訂）。storage 載回前是 null（整張表還沒到，
  // keydown 全放行——不能用空表代替，否則載入競態時誤判「未設定」）。
  let table = null;

  function loadTable() {
    // context invalidated guard（extension reload 後舊 content script 殘留）
    if (!browser || !browser.storage || !browser.storage.sync) return;
    try {
      browser.storage.sync.get({ customShortcuts: {} }).then((values) => {
        table = SC.sanitizeTable(values && values.customShortcuts);
      }).catch(() => { /* context 失效 race,silently no-op */ });
    } catch (_) { /* context 失效 race */ }
  }

  // options 改鍵即時生效（不必 reload 頁面 / extension）
  if (browser.storage && browser.storage.onChanged) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !('customShortcuts' in changes)) return;
      table = SC.sanitizeTable(changes.customShortcuts.newValue);
    });
  }

  function onKeyDown(e) {
    if (!table) return;
    // 2026-09-11 code review §3.3-2：按住不放的 auto-repeat keydown 不觸發——每個 repeat
    // 都會再進 handleTranslatePreset，變成「翻譯 / 取消」交替閃動。browser 層 commands
    // 本身對長按只觸發一次，這裡對齊。
    if (e.repeat) return;
    // IME 組字第一階段不攔——但僅在「沒按 ⌥/⌃」時。
    // macOS Safari 把 ⌥（Option）當成特殊字元組字鍵,按 ⌥+任何字母 的 keydown 都會
    // 回報 keyCode 229 / isComposing（Chrome 只有真正的 dead key 如 ⌥E/⌥U 才會）。
    // 但此刻使用者是在按含 ⌥ 的自訂快速鍵,不是在打中文;有 ⌥/⌃ 修飾鍵就照常比對,
    // 否則 Safari 上所有 ⌥ 自訂鍵都會被這條 guard 吃掉永遠觸發不了。真正的 CJK IME
    // 組字不會按著 ⌥/⌃,所以無修飾鍵時仍跳過。
    if ((e.isComposing || e.keyCode === 229) && !e.altKey && !e.ctrlKey) return;
    for (const slot of SC.SLOTS) {
      const s = table[slot];
      if (s && SC.matches(e, s)) {
        // preventDefault：擋掉 macOS ⌥+字母的 dead-key 字元輸入；
        // stopImmediatePropagation：擋掉 page JS 同 phase listener（與 browser 層
        // 快速鍵「頁面收不到」的行為對齊）。
        e.preventDefault();
        e.stopImmediatePropagation();
        if (typeof SK.handleTranslatePreset === 'function') {
          SK.sendLog && SK.sendLog('info', 'system', 'custom shortcut matched', { slot });
          SK.handleTranslatePreset(Number(slot));
        }
        return;
      }
    }
  }
  // 注意：input / textarea focus 時也觸發——與 browser 層 commands 行為一致
  // （組合必含 ⌥/⌃,validate 已擋掉會干擾打字的單鍵 / ⇧ 組合）。
  window.addEventListener('keydown', onKeyDown, true);

  SK.customShortcuts = { installed: true };
  loadTable();
})(window.__SK);
