// content-hover.js — 懸停翻譯：按住修飾鍵、游標停在段落上即翻譯該段（issue #67）
//
// 行為：
//   - 設定 `hoverTranslateModifier`（'off' | 'shift' | 'alt' | 'ctrl'，預設 'off'）決定
//     修飾鍵。按住該鍵移動滑鼠，游標在同一段落上停留 REST_MS 後，只翻譯游標所在的那個段落，
//     譯文原地注入。顯示方式由 `hoverTranslateMode`（'single' | 'dual'，預設 'dual'）決定，
//     獨立於整頁 displayMode——懸停情境是「邊讀原文邊看譯文」，預設雙語。
//   - 放開修飾鍵即停止；已翻譯的段落再懸停不重翻（偵測層對已標記元素一律跳過）。
//   - 同時只跑一件；等待回應期間該段落畫虛線外框當回饋，不彈 toast（單段翻譯通常 1–2 秒，
//     快取命中則立即）。整批失敗才彈錯誤 toast。
//
// 為何重用 rescan 路徑而不另寫注入：段落偵測（collectParagraphs 帶 root + includeRoot）、
// 序列化、注入、快取、術語表裁剪、還原簿記（STATE.originalHTML）都是既有整頁翻譯的同一條
// pipeline；懸停翻譯只是「翻游標下那一個 unit」，等同 SPA rescan 對新內容的子集翻譯。
// 全頁已翻譯（STATE.translationContext 存在）時延用同一引擎；未翻譯時依主要預設（slot 2，
// 等同 Alt+S）解析引擎 / 模型。abort signal 走 SK.getRescanSignal()：使用者按快速鍵還原
// 整頁時 restorePage 會 abort 它，晚到的懸停批次不會把譯文注回乾淨頁面。
//
// 與整頁 toggle 的接縫（content.js handleTranslatePreset）：懸停翻過幾段、整頁未翻時按
// 快速鍵 = 翻剩下的段落（不是還原）；整頁翻完後再按才還原（含懸停翻過的段落，簿記同一份）。
// STATE.hoverTranslated 由本檔在成功後設 true，restorePage / 取消 / SPA reset 歸零。
//
// 已知限制：
//   - 觸控裝置無 hover 事件（iPad 接觸控板 / 滑鼠可用）
//   - 未整頁翻譯時 Content Guard 未武裝，框架重繪把懸停譯文抹掉不會自動補回
//   - closed shadow root 內的段落抓不到（web spec 限制，與整頁翻譯相同）
(function (SK) {
  'use strict';
  if (!SK || SK.disabled) return;  // iframe gate（見 content-ns.js）：被擋的 frame 不掛 listener
  if (SK.hoverTranslate) return; // 防重複注入
  const STATE = SK.STATE;

  const REST_MS = 150;            // 游標停留多久才觸發
  const MAX_SCOPE_HOPS = 4;       // 往上找 block 祖先最多幾層
  const VALID_MODES = ['off', 'shift', 'alt', 'ctrl'];
  const MOD_EVENT_PROP = { shift: 'shiftKey', alt: 'altKey', ctrl: 'ctrlKey' };
  const MOD_KEY_NAME = { shift: 'Shift', alt: 'Alt', ctrl: 'Control' };
  const PENDING_ATTR = 'data-shinkansen-hover-pending';
  const PENDING_OVERLAY_ID = 'shinkansen-hover-pending-overlay';

  // 初始值必須與 lib/storage.js DEFAULT_SETTINGS.hoverTranslateModifier / hoverTranslateMode 同值（本檔不走 merge）
  let mode = 'off';
  let displayMode = 'dual'; // 懸停譯文顯示方式，獨立於整頁 displayMode
  let lastX = -1;
  let lastY = -1;
  let armed = false;      // 修飾鍵目前按著
  let restTimer = null;
  let inflight = null;    // 進行中的翻譯 Promise
  let rerunAfter = false; // 進行中又移到別段：完成後再排一次

  function normalizeMode(v) {
    return (typeof v === 'string' && VALID_MODES.includes(v)) ? v : 'off';
  }

  function normalizeDisplay(v) {
    return v === 'single' ? 'single' : 'dual';
  }

  function loadMode() {
    if (!browser || !browser.storage || !browser.storage.sync) return;
    try {
      browser.storage.sync.get(['hoverTranslateModifier', 'hoverTranslateMode']).then((s) => {
        mode = normalizeMode(s && s.hoverTranslateModifier);
        displayMode = normalizeDisplay(s && s.hoverTranslateMode);
      }).catch(() => { /* context 失效 race，維持預設 */ });
    } catch (_) { /* context 失效 race */ }
  }
  if (browser.storage && browser.storage.onChanged) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if ('hoverTranslateModifier' in changes) {
        mode = normalizeMode(changes.hoverTranslateModifier.newValue);
        if (mode === 'off') disarm();
      }
      if ('hoverTranslateMode' in changes) {
        displayMode = normalizeDisplay(changes.hoverTranslateMode.newValue);
      }
    });
  }

  function disarm() {
    armed = false;
    if (restTimer) { clearTimeout(restTimer); restTimer = null; }
  }

  function schedule() {
    if (restTimer) clearTimeout(restTimer);
    restTimer = setTimeout(() => { restTimer = null; fire(); }, REST_MS);
  }

  function onMouseMove(e) {
    lastX = e.clientX;
    lastY = e.clientY;
    if (mode === 'off') return;
    // mousemove 自帶修飾鍵狀態：keydown 沒收到（例如按鍵時焦點在別的 frame）也對得起來
    armed = !!e[MOD_EVENT_PROP[mode]];
    if (!armed) { if (restTimer) { clearTimeout(restTimer); restTimer = null; } return; }
    schedule();
  }

  function onKeyDown(e) {
    if (mode === 'off' || e.repeat) return;
    if (e.key !== MOD_KEY_NAME[mode]) return;
    armed = true;
    // 游標可能已經停在段落上才按鍵
    if (lastX >= 0) schedule();
  }

  function onKeyUp(e) {
    if (mode === 'off') return;
    if (e.key === MOD_KEY_NAME[mode]) disarm();
  }

  // ─── 找游標下的翻譯單位 ─────────────────────────────
  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    // open shadow root 逐層往內找（closed 拿不到，停在 host）
    let guard = 0;
    while (el && el.shadowRoot && guard++ < 8) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function isInlineDisplay(el) {
    const d = (SK.getCS ? SK.getCS(el) : getComputedStyle(el)).display || '';
    return d === 'inline' || d.startsWith('inline-') || d === 'contents';
  }

  function nearestBlock(el) {
    let n = el;
    while (n && n.nodeType === Node.ELEMENT_NODE && n !== document.body && isInlineDisplay(n)) {
      n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
    }
    return n && n.nodeType === Node.ELEMENT_NODE ? n : null;
  }

  function parentOf(el) {
    return el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
  }

  function rectContains(rects, x, y) {
    for (const r of rects) {
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
    return false;
  }

  function unitContainsPoint(unit, target, x, y) {
    if (unit.kind === 'fragment') {
      // fragment 是同一容器內的兄弟節點區段：用 range 的 client rects 判點是否落在其中
      try {
        const range = document.createRange();
        range.setStartBefore(unit.startNode);
        range.setEndAfter(unit.endNode);
        return rectContains(range.getClientRects(), x, y);
      } catch (_) { return false; }
    }
    return unit.el === target || (unit.el && unit.el.contains(target));
  }

  // 跨 shadow boundary 的 closest：target 在自家 UI（toast / 懸浮按鈕）的 shadow root 內時，
  // 一般 closest 比不到 light DOM 的 host id，會往上空跑整輪偵測（2026-10-07 批次 6 §4.5）
  function closestComposed(el, selector) {
    let n = el;
    while (n && n.nodeType === Node.ELEMENT_NODE) {
      const hit = n.closest(selector);
      if (hit) return hit;
      const root = n.getRootNode ? n.getRootNode() : null;
      n = root && root.host ? root.host : null;
    }
    return null;
  }

  // pathTo：游標下能命中的單元只可能在 target 的祖先鏈上（元素單元用 DOM containment、fragment
  // 的容器也是祖先），偵測層只走這條鏈，鏈外子樹整段跳過。沒有它時游標停在段落間空白 / 圖片上，
  // 四個 hop 各對一層更大的容器整掃（Wikipedia 長條目一次 rest 約 300ms；2026-10-07 批次 6 E-1）
  function collectScoped(scope, target) {
    let units = [];
    try {
      units = SK.collectParagraphs(scope, null, { includeRoot: true, pathTo: target }) || [];
    } catch (_) { return []; }
    if (STATE.translatedMode === 'dual' && SK.consolidateDualInlineUnits) {
      units = SK.consolidateDualInlineUnits(units);
    }
    return units;
  }

  function findUnitAt(x, y) {
    const target = deepElementFromPoint(x, y);
    if (!target || target === document.documentElement || target === document.body) return null;
    // 自家 UI（toast / 懸浮按鈕）與已翻譯內容一律跳過
    if (closestComposed(target, '#shinkansen-toast-host, #shinkansen-floating-host, [data-shinkansen-translated], [data-shinkansen-dual-source], ' + SK.TRANSLATION_WRAPPER_TAG)) return null;
    let scope = nearestBlock(target);
    for (let hop = 0; scope && hop < MAX_SCOPE_HOPS; hop++) {
      if (scope === document.body || scope === document.documentElement) break;
      const units = collectScoped(scope, target);
      const hit = units.find((u) => unitContainsPoint(u, target, x, y));
      if (hit) return hit;
      // 候選段落可能是游標所在 block 的祖先（例如 block 只是段落內的 inline-block 排版容器）
      const up = parentOf(scope);
      scope = up ? nearestBlock(up) : null;
    }
    return null;
  }

  // ─── 翻譯 ─────────────────────────────────────────
  async function resolveRunner() {
    // 全頁已翻譯：延用同一引擎（rescan 同款）。opencc-local 只做簡繁轉換，不算引擎
    const ctx = STATE.translationContext;
    if (ctx && ctx.provider !== 'opencc-local') {
      return (units, signal) => SK.translateUnitsByProvider(units, { signal });
    }
    // 未翻譯：依主要預設（slot 2，等同 Alt+S）決定引擎 / 模型
    let presets = SK.DEFAULT_PRESETS;
    try {
      const { translatePresets } = await browser.storage.sync.get('translatePresets');
      if (Array.isArray(translatePresets) && translatePresets.length > 0) presets = translatePresets;
    } catch { /* 沿用 DEFAULT_PRESETS */ }
    const preset = presets.find((p) => p.slot === 2) || presets[0] || {};
    const target = STATE.targetLanguage;
    const convertDirection = target === 'zh-TW' ? 'cn2twp' : (target === 'zh-CN' ? 'twp2cn' : null);
    if (preset.engine === 'google') {
      return (units, signal) => SK.translateUnitsGoogle(units, { signal });
    }
    if (preset.engine === 'openai-compat') {
      return (units, signal) => SK.translateUnits(units, { engine: 'openai-compat', convertDirection, signal });
    }
    return (units, signal) => SK.translateUnits(units, { modelOverride: preset.model || null, engine: 'gemini', convertDirection, signal });
  }

  async function translateUnit(unit) {
    const el = unit.el;
    const runner = await resolveRunner();
    // resolveRunner 內可能 await storage（讀 presets）：同上，整頁翻譯在這段期間開跑就讓位。
    // 這裡是取 rescan signal 之前的最後一個 await——translatePage 開跑時 abort 的是「當時」
    // 的 signal，晚於 abort 才取得的新 signal 不會被殺，所以要靠這條重判擋住
    if (STATE.translating) return;
    const clearPending = showPending(unit);
    const signal = SK.getRescanSignal();
    try {
      const r = await runner([unit], signal);
      if (signal.aborted) return;
      const done = r?.done || 0;
      const failures = r?.failures || [];
      if (done > 0) {
        STATE.hoverTranslated = true;
        SK.sendLog?.('info', 'translate', 'hover translate done', { kind: unit.kind || 'element', tag: el?.tagName });
      } else if (failures.length) {
        SK.sendLog?.('warn', 'translate', 'hover translate failed', { error: failures[0]?.error });
        SK.showToast?.('error', SK.t('toast.partialFailed', { failed: 1, total: 1 }), {
          detail: String(failures[0]?.error || '').slice(0, 120), autoHideMs: 4000,
        });
      }
    } finally {
      clearPending();
    }
  }

  // 等待回應期間的虛線外框。元素單元直接掛 PENDING_ATTR；fragment 的 el 是整個容器（含其他
  // 段落 / 已譯段），掛在容器上會框住整塊，改用 range 的 client rects 畫絕對定位 overlay
  //（pointer-events:none、無文字，不進偵測；完成即移除，不留在 DOM）。2026-10-07 批次 6 §4.4
  function showPending(unit) {
    const el = unit.el;
    if (unit.kind !== 'fragment') {
      if (el && el.setAttribute) { el.setAttribute(PENDING_ATTR, ''); ensurePendingStyle(); }
      return () => { if (el && el.removeAttribute) el.removeAttribute(PENDING_ATTR); };
    }
    let host = null;
    try {
      const range = document.createRange();
      range.setStartBefore(unit.startNode);
      range.setEndAfter(unit.endNode);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      const parent = document.documentElement;
      if (rects.length > 0 && parent) {
        host = document.createElement('div');
        host.id = PENDING_OVERLAY_ID;
        host.setAttribute('aria-hidden', 'true');
        host.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;';
        const sx = window.scrollX || 0;
        const sy = window.scrollY || 0;
        for (const r of rects) {
          const box = document.createElement('div');
          box.style.cssText = `position:absolute;left:${r.left + sx}px;top:${r.top + sy}px;width:${r.width}px;height:${r.height}px;`
            + 'outline:2px dashed rgba(64,128,255,.7);outline-offset:2px;';
          host.appendChild(box);
        }
        parent.appendChild(host);
      }
    } catch (_) { /* range 失效：不畫框 */ }
    return () => { if (host && host.parentNode) host.parentNode.removeChild(host); };
  }

  async function fire() {
    if (!armed || mode === 'off') return;
    if (SK.INSTANCE?.stoodDown) return;
    if (SK.isInstanceLeader && !SK.isInstanceLeader()) return;
    if (STATE.translating) return; // 整頁翻譯進行中不插隊
    if (inflight) { rerunAfter = true; return; }
    inflight = (async () => {
      // 先讀設定：目標語言 / 雙語標記樣式決定偵測與注入行為，整頁未翻譯時才套（已翻譯頁鎖定本輪）
      if (!SK.isPageTranslated()) {
        let settings = {};
        try { settings = await browser.storage.sync.get(null); } catch (_) { /* 用預設 */ }
        SK.applyTranslateDisplaySettings?.(settings);
      }
      // 上方 await 期間整頁翻譯可能已開跑（Alt+S）：translatePage 同步設 translating 後也在
      // await storage，誰先 resolve 不保證——若本輪晚回還無條件寫 translatedMode，會把整頁剛
      // 鎖定的 single 蓋成懸停的 dual，整頁每一段都注成雙語。await 之後必須重判
      if (!armed || STATE.translating) return;
      // 懸停譯文的顯示方式獨立於整頁 displayMode：注入層（content-inject.js）與 dual 合併
      // （consolidateDualInlineUnits）都讀 STATE.translatedMode，本輪暫時切成懸停設定，結束後
      // 還原成整頁的鎖定值（混合 single / dual 的還原簿記本就支援，translationCache 有項即清
      // wrapper）。若期間整頁翻譯開跑 / 完成 / 被還原，translatedMode 已由那條路徑接管，不覆蓋。
      const prevMode = STATE.translatedMode;
      const wasTranslated = STATE.translated;
      STATE.translatedMode = displayMode;
      if (displayMode === 'dual') SK.ensureDualWrapperStyle?.();
      try {
        const unit = findUnitAt(lastX, lastY);
        if (!unit) return;
        // 注入層以單元自帶的模式為準：請求在途時全域 translatedMode 若被背景簡繁轉換 run
        // 改寫回整頁設定，這段仍照懸停設定注入
        unit.injectMode = displayMode;
        await translateUnit(unit);
      } finally {
        if (!STATE.translating && STATE.translated === wasTranslated && STATE.translatedMode === displayMode) {
          STATE.translatedMode = prevMode;
        }
      }
    })().catch((err) => {
      SK.sendLog?.('warn', 'translate', 'hover translate error', { error: err?.message });
    }).finally(() => {
      inflight = null;
      if (rerunAfter) { rerunAfter = false; if (armed) schedule(); }
    });
    return inflight;
  }

  let _styleDone = false;
  function ensurePendingStyle() {
    if (_styleDone || !document.head) return;
    _styleDone = true;
    const st = document.createElement('style');
    st.id = 'shinkansen-hover-style';
    st.textContent = `[${PENDING_ATTR}]{outline:2px dashed rgba(64,128,255,.7)!important;outline-offset:2px!important}`;
    document.head.appendChild(st);
  }

  window.addEventListener('mousemove', onMouseMove, { capture: true, passive: true });
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', disarm);

  SK.hoverTranslate = {
    installed: true,
    // spec / 除錯用
    getMode: () => mode,
    getDisplayMode: () => displayMode,
    isArmed: () => armed,
    findUnitAt,
    fire,
  };
  loadMode();
})(window.__SK);
