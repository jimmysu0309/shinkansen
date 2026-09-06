// shortcut-utils.js — 自訂快速鍵 helper（跨環境共用單一資料源）
//
// 共用於三處，確保「比對 / 驗證 / 格式化」邏輯只有一份：
//   - content-shortcuts.js（content script,keydown capture 比對命中後本地 dispatch）
//   - options/options.js（recorder 錄製 / 顯示 / 驗證 / 衝突檢查）
//   - test/regression/*.spec.js（Node require 直接驗純函式）
//
// 背景：Safari（含 iOS / iPadOS）沒有 chrome://extensions/shortcuts 這類使用者
// 自訂快速鍵入口，iOS 的 commands API 更殘缺（getAll 缺席）。自訂快速鍵因此走
// content script 層：options 錄一組 {code+modifiers} 存 storage.sync.customShortcuts,
// content-shortcuts.js 在頁面 keydown capture phase 比對命中後直接呼叫
// SK.handleTranslatePreset(slot)——與 manifest 預設鍵（browser 層）並存。
//
// shortcut 物件形狀（storage.sync.customShortcuts 的 value）:
//   { code: 'KeyS', alt: true, shift: false, ctrl: false, meta: false } | null
// 用 e.code（實體鍵位）不用 e.key——macOS 上 ⌥S 的 e.key 會是變換後字元（dead-key），
// 跨鍵盤配置不穩定；e.code 是實體位置、不受 modifier 影響。
//
// 詞彙表：用 slot（2 / 1 / 3，與 translatePresets 同編號）當 command key。
// 顯示順序 [2, 1, 3] = 主要預設 → 預設 2 → 預設 3。
//
// 跨環境匯出：content script / options 走 window 全域、Node require 走 module.exports。
(function (global) {
  'use strict';

  // 三組 preset 的 slot 編號（顯示順序：主要預設先）。同時是 customShortcuts 表 key。
  var SLOTS = [2, 1, 3];

  // manifest.json commands 的 suggested_key 鏡像（瀏覽器層預設鍵）。
  // command id 0 → slot 2（主要，Alt+S）、id 1 → slot 1（預設 2，Alt+A）、
  // id 3 → slot 3（預設 3，Alt+D），見 background.js COMMAND_ID_TO_SLOT。
  // regression spec 有 forcing function 守這份鏡像與 manifest 逐欄一致——
  // 改 manifest suggested_key 沒同步這裡會 fail。
  // 用途：（1）options 顯示「⌥S（預設）」（2）validate 拒絕「自訂值 == 預設值」
  // （兩層同時觸發會 toggle 兩次 = 視覺上沒反應）。
  var MANIFEST_DEFAULTS = {
    2: { code: 'KeyS', alt: true, shift: false, ctrl: false, meta: false },
    1: { code: 'KeyA', alt: true, shift: false, ctrl: false, meta: false },
    3: { code: 'KeyD', alt: true, shift: false, ctrl: false, meta: false }
  };

  // 純 modifier 鍵的 e.code——按下這些時組合還沒完成，eventToShortcut 回 null
  var MODIFIER_CODES = {
    AltLeft: 1, AltRight: 1,
    ShiftLeft: 1, ShiftRight: 1,
    ControlLeft: 1, ControlRight: 1,
    MetaLeft: 1, MetaRight: 1,
    CapsLock: 1
  };

  // e.code → 顯示字元。沒列的 fallback 用原始 code 字串。
  var KEY_LABELS = {
    Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
    BracketLeft: '[', BracketRight: ']', Backquote: '`',
    Minus: '-', Equal: '=', Backslash: '\\',
    Space: 'Space', Enter: '↵', Tab: '⇥',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Backspace: '⌫', Delete: '⌦',
    Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn'
  };

  function keyLabel(code) {
    if (KEY_LABELS[code]) return KEY_LABELS[code];
    var m = /^Key([A-Z])$/.exec(code);
    if (m) return m[1];
    m = /^Digit(\d)$/.exec(code);
    if (m) return m[1];
    return code; // F1-F12 / Numpad* 等直接顯示原 code
  }

  // KeyboardEvent → shortcut 物件；純 modifier 鍵（組合未完成）回 null
  function eventToShortcut(e) {
    if (!e || !e.code || MODIFIER_CODES[e.code]) return null;
    return {
      code: e.code,
      alt: !!e.altKey,
      shift: !!e.shiftKey,
      ctrl: !!e.ctrlKey,
      meta: !!e.metaKey
    };
  }

  // KeyboardEvent 是否命中 shortcut。modifier 全欄位嚴格比對——
  // ⌥S 不可命中 ⌥⇧S（多按 shift 是不同組合）。
  function matches(e, s) {
    if (!s || !s.code || !e) return false;
    return e.code === s.code &&
      !!e.altKey === !!s.alt &&
      !!e.shiftKey === !!s.shift &&
      !!e.ctrlKey === !!s.ctrl &&
      !!e.metaKey === !!s.meta;
  }

  function shortcutEquals(a, b) {
    if (!a || !b) return false;
    return a.code === b.code &&
      !!a.alt === !!b.alt &&
      !!a.shift === !!b.shift &&
      !!a.ctrl === !!b.ctrl &&
      !!a.meta === !!b.meta;
  }

  // 顯示用字串。modifier 順序固定 ⌃⌥⇧⌘（macOS 慣例）。
  function format(s) {
    if (!s || !s.code) return '';
    var out = '';
    if (s.ctrl) out += '⌃';
    if (s.alt) out += '⌥';
    if (s.shift) out += '⇧';
    if (s.meta) out += '⌘';
    return out + keyLabel(s.code);
  }

  // 把 browser.commands.getAll() 回的「瀏覽器層快速鍵字串」（如 "Alt+S" /
  // "Ctrl+Shift+S"）在 Mac 上正規化成 Mac 修飾鍵符號（⌃⌥⇧⌘、去掉 +），與設定頁
  // recorder 的 format() 顯示一致；非 Mac 原樣回（Alt 在 Windows / Linux 就是 Alt，
  // 不該顯示成 ⌥ Option）。Safari（macOS）回的是 "Alt+S" → Mac 上要轉成 "⌥S"；
  // Chrome macOS 多半已回 "⌥S"（無 Alt 字樣 → replace 不命中、保持不變）。
  // 純字串轉換（非物件），給 popup 顯示 built-in command 快速鍵用。
  function macifyCommandShortcut(str, isMac) {
    if (!str || typeof str !== 'string') return str || '';
    if (!isMac) return str;
    return str
      .replace(/\bCommand\b|\bCmd\b|\bMeta\b/gi, '⌘')
      .replace(/\bControl\b|\bCtrl\b/gi, '⌃')
      .replace(/\bOption\b|\bAlt\b/gi, '⌥')
      .replace(/\bShift\b/gi, '⇧')
      .replace(/\s*\+\s*/g, '');
  }

  // 錄製驗證。回 { ok: boolean, reason?: string }。opts.requireCtrl=true（Safari）時必含 ⌃。
  // 規則（全是結構性通則，非站點 / 鍵位特判）：
  //   - 拒絕 ESC —— 保留給其他用途，且 recorder 用 ESC 取消錄製
  //   - opts.requireCtrl（Safari = Mac / iPad / iPhone 皆傳 true）—— Safari 把 ⌥ Option
  //     與 ⌘ Command 路由到系統鍵盤指令層，不以 keydown 傳給網頁 content script
  //     （iPad / iPhone 真機 probe 實證：按 ⌥+鍵 / ⌘+鍵 網頁完全收不到 keydown，只有 ⌃
  //     收得到；macOS Safari 雖收得到 ⌥，但為「同一組自訂鍵跨 Apple 裝置都能動」一致性
  //     也統一要求 ⌃）→ 自訂鍵必含 ⌃ Control。Chrome / Firefox 無此限，⌥ / ⌘ 皆可。
  //   - 至少含一個修飾鍵（⌥ / ⌃ / ⌘）—— 單鍵或只加 ⇧ 會在打字 / 閱讀操作時誤觸
  //   - 拒絕與內建預設鍵相同 —— browser 層停不掉，兩層同時觸發 = toggle 兩次
  // 註：Chrome 的 ⌘ 多數組合會被瀏覽器 / 系統攔走（⌘L、⌘R 等），允許設但不保證觸發；
  //    這是依產品需求「Chrome 接受 ⌥ & ⌘」的取捨。
  function validate(s, opts) {
    opts = opts || {};
    if (!s || !s.code) return { ok: false, reason: 'shortcut.invalid.needKey' };
    if (s.code === 'Escape') return { ok: false, reason: 'shortcut.invalid.esc' };
    if (opts.requireCtrl && !s.ctrl) return { ok: false, reason: 'shortcut.invalid.safariNeedCtrl' };
    if (!s.alt && !s.ctrl && !s.meta) return { ok: false, reason: 'shortcut.invalid.needMod' };
    for (var i = 0; i < SLOTS.length; i++) {
      var def = MANIFEST_DEFAULTS[SLOTS[i]];
      if (def && shortcutEquals(s, def)) {
        return { ok: false, reason: 'shortcut.invalid.isDefault', detail: format(def) };
      }
    }
    return { ok: true };
  }

  // storage 讀回值消毒：缺欄 / 型別錯 / 殘缺物件一律折回 null（= 未自訂）,
  // 防 sync 髒資料讓 keydown 比對 throw。
  function sanitize(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.code !== 'string' || !raw.code) return null;
    return {
      code: raw.code,
      alt: !!raw.alt,
      shift: !!raw.shift,
      ctrl: !!raw.ctrl,
      meta: !!raw.meta
    };
  }

  // 整張表消毒：保證三個 slot key 都在、value 是合法 shortcut 或 null
  function sanitizeTable(raw) {
    var table = {};
    for (var i = 0; i < SLOTS.length; i++) {
      var slot = SLOTS[i];
      table[slot] = raw && typeof raw === 'object' ? sanitize(raw[slot]) : null;
    }
    return table;
  }

  // 懸停翻譯修飾鍵：單選。兩種顯示方式各綁一個鍵，所以只認一個 true；
  // 「一個都沒選」是合法值＝停用該種顯示方式（兩種都沒選就是整個功能關閉）。
  var HOVER_MOD_KEYS = ['alt', 'shift', 'ctrl', 'meta'];

  function hoverModifierFromKey(key) {
    return {
      alt: key === 'alt',
      shift: key === 'shift',
      ctrl: key === 'ctrl',
      meta: key === 'meta'
    };
  }

  // 取出這組修飾鍵對應的鍵名，沒選任何鍵回空字串
  function hoverModifierKey(m) {
    if (!m || typeof m !== 'object') return '';
    for (var i = 0; i < HOVER_MOD_KEYS.length; i++) {
      if (m[HOVER_MOD_KEYS[i]] === true) return HOVER_MOD_KEYS[i];
    }
    return '';
  }

  function sanitizeHoverModifier(raw) {
    var key = (typeof raw === 'string') ? raw : hoverModifierKey(raw);
    return hoverModifierFromKey(HOVER_MOD_KEYS.indexOf(key) === -1 ? '' : key);
  }

  // 懸停翻譯：比對目前鍵盤修飾鍵是否與設定一致（不要求一般鍵 code）
  function modifiersMatchEvent(e, m) {
    if (!e || !m) return false;
    // 一個都沒勾 = 該組停用,不比對(否則「沒按任何修飾鍵」會被判成命中)
    if (!(m.alt || m.shift || m.ctrl || m.meta)) return false;
    return !!e.altKey === !!m.alt &&
      !!e.shiftKey === !!m.shift &&
      !!e.ctrlKey === !!m.ctrl &&
      !!e.metaKey === !!m.meta;
  }

  function isModifierKeyCode(code) {
    return !!MODIFIER_CODES[code];
  }

  var api = {
    SLOTS: SLOTS,
    MANIFEST_DEFAULTS: MANIFEST_DEFAULTS,
    keyLabel: keyLabel,
    eventToShortcut: eventToShortcut,
    matches: matches,
    shortcutEquals: shortcutEquals,
    format: format,
    macifyCommandShortcut: macifyCommandShortcut,
    validate: validate,
    sanitize: sanitize,
    sanitizeTable: sanitizeTable,
    sanitizeHoverModifier: sanitizeHoverModifier,
    hoverModifierKey: hoverModifierKey,
    HOVER_MOD_KEYS: HOVER_MOD_KEYS,
    modifiersMatchEvent: modifiersMatchEvent,
    isModifierKeyCode: isModifierKeyCode
  };
  if (typeof window !== 'undefined') window.__SKShortcuts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
