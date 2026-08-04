// content-floating-icon.js — 懸浮翻譯控制按鈕（floating action button）
//
// 設計（SPEC-PRIVATE §28）：
// - 頁面左／右緣的常駐浮動 icon，用 menu bar「新」icon（icons/icon-128.png 經
//   chrome.runtime.getURL 載入；該檔已列入 manifest web_accessible_resources）。
// - 短按（放開前長按計時器未觸發、未拖移）= popupButtonSlot 對應的預設翻譯，走
//   SK.handleTranslatePreset(slot)。與 popup 工具列按鈕同一份事實（popupButtonSlot）、
//   同一條 path，本身含 toggle：未譯→翻、已譯→還原、翻譯中→中止。
// - 長按（壓住達 LONGPRESS_MS、未拖移）= 跳出三 preset 選單，點任一列 →
//   handleTranslatePreset(該 slot) + 收選單；點選單外 / 捲動 = 收選單。
// - 拖移（pointermove 超過 DRAG_THRESHOLD_PX）= 進入拖移模式，放開時吸附最近的左／右
//   緣，垂直位置存比例（floatingIconPos = { edge, offsetY }），視窗縮放後按比例還原。
// - 只有 iPadOS 渲染時把 top 夾離上下角落 CORNER_DEADZONE_PX：iPadOS 視窗右下角是縮放
//   拖曳把手、上方角落是系統手勢區，按鈕停太靠近會被 OS 攔走觸控而拖不出來。iPhone（無
//   視窗縮放角）與桌面瀏覽器不設禁制區。預設右下角（offsetY=1）在 iPadOS 上即落在這條
//   安全極限、儘量靠近角落但不進保留區。
// - enable / 透明度 / 尺寸 / 位置走 storage.sync，onChanged 即時生效（比照 content-toast.js）。
//   floatingIcon 預設值：未設過（非 boolean）時一律預設開啟（不分平台），使用者在 options
//   明確設過則尊重該設定。floatingIconSize：icon 邊長 16 小 / 24 中（預設）/ 32 大（觸控好點）。
//   長按開選單時暫時拉到全不透明，收起再還原使用者設定的透明度。
// - 比照 toast 用獨立 Shadow DOM host（closed）+ adoptedStyleSheets（CSP-safe），掛在
//   documentElement，不注入文章內容 → 不破壞 Readwise 擷取（CLAUDE.md §15）。
// - 只在 top frame 放一顆（window === window.top）；iframe / SK.disabled / 非 HTML
//   文件（XMLDocument，attachShadow 會 throw）一律早退。
(function (SK) {
  'use strict';
  if (!SK || SK.disabled) return;        // iframe gate（content-ns.js）
  if (window !== window.top) return;     // 只在主 frame 放一顆

  const LONGPRESS_MS = 500;              // 壓住達此毫秒 = 長按 → 開選單；之前放開 = 短按
  const DRAG_THRESHOLD_PX = 8;           // pointer 位移超過此距離 = 進入拖移（取消短按 / 長按）
  const DEFAULT_ICON_SIZE = 24;          // icon 視覺尺寸預設「中」（方形 icon 顯示邊長）；使用者可選 16 / 32
  const HIT_PADDING = 16;                // icon 外圍透明可點 padding（觸控好點）
  const EDGE_MARGIN = 6;                 // 吸附邊緣時與視窗邊的間距
  const DEFAULT_OPACITY = 0.7;
  const DEFAULT_POS = { edge: 'right', offsetY: 1 };   // 預設右下角（edge=right、offsetY=1 到底）
  // iPadOS 角落 OS 保留區邊長。iPadOS 視窗右下角是縮放拖曳把手、上方角落是 Control
  // Center 等系統手勢區：按鈕停太靠近角落會被 OS 攔走觸控，使用者再也按不到 / 拖不出來。
  // 按鈕 x 永遠貼左／右緣，故只需把 y 夾離上下角落這段距離。
  const CORNER_DEADZONE_PX = 44;
  // 角落禁制區只針對 iPadOS。判斷：真觸控（maxTouchPoints ≥ 1）+ iPad UA 訊號。iPadOS 13+
  // 桌面模式把 UA 偽裝成 Macintosh，但 maxTouchPoints 仍 ≥ 1（桌面 Mac = 0），故「Macintosh
  // + 觸控」視為 iPad。iPhone / iPod 先排除——它們的 UA 也帶「like Mac OS X」字串，若只比對
  // Mac OS X 會誤判（故只認 Macintosh，且不比對 Mac OS X）。Android（UA 帶 Android）、桌面
  // （maxTouchPoints = 0）皆排除——它們沒有 iPad 的視窗縮放角／系統手勢角問題。純函式吃
  // (ua, touchPoints) 方便 regression 直接驗各平台 UA 分支；可被 setIPadOSForTest 覆寫驗夾邊。
  function isIPadOSEnv(ua, touchPoints) {
    if (!((touchPoints || 0) >= 1)) return false;
    ua = ua || '';
    if (/iPhone|iPod/.test(ua)) return false;
    return /iPad/.test(ua) || /Macintosh/.test(ua);
  }
  let isIPadOS = isIPadOSEnv(
    (typeof navigator !== 'undefined' && navigator.userAgent) || '',
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints) || 0
  );
  // icon 尺寸為使用者可調（floatingIconSize：16 / 24 / 32），故 hitSize 跟著變動（非常數）。
  let iconSize = DEFAULT_ICON_SIZE;      // 目前 icon 邊長
  let hitSize = iconSize + HIT_PADDING;  // 目前按鈕可點 footprint（= icon + 透明 padding）

  // ─── Shadow DOM host（CSP-safe，比照 content-toast.js）──────────────────
  let host, shadow, btn, menuEl;
  try {
    host = document.createElement('div');
    host.id = 'shinkansen-floating-host';
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483600; display: none;';
    shadow = host.attachShadow({ mode: 'closed' });
  } catch (_e) {
    // 非 HTML 文件（XMLDocument 等）attachShadow / style 會 throw → 不放 icon
    return;
  }

  const iconUrl = (() => {
    // icon-48.png = 工具列「新」方形 icon（icon-128.png 是火車商店圖，不是這顆）
    try { return browser.runtime.getURL('icons/icon-48.png'); }
    catch (_e) { return ''; }
  })();

  const CSS = `
    :host, * { box-sizing: border-box; }
    /* 列印 / 存 PDF 時隱藏懸浮按鈕：host 是 position:fixed 元素,不擋掉會被印進輸出
       （使用者實測在 Google 試算表列印印出了這顆）。inline display:block 用 !important 蓋掉。 */
    @media print { :host { display: none !important; } }
    .fab {
      position: relative;
      width: var(--fab-hit, 32px);
      height: var(--fab-hit, 32px);
      border: none;
      padding: 0;
      background: none;            /* 不加圓框 / 白底，直接用工具列方形 icon 本體 */
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      touch-action: none;          /* 自行處理拖移，禁瀏覽器捲動 / 手勢介入 */
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none; /* iOS 長按按鈕禁 callout（copy / 分享）選取片 */
      -webkit-tap-highlight-color: transparent;
      transition: transform .15s ease, filter .15s ease;
    }
    .fab:active { transform: scale(.92); }
    .fab img {
      width: var(--fab-icon, 16px);
      height: var(--fab-icon, 16px);
      display: block;
      /* drop-shadow 讓 icon 在淺色 / 同色頁面也看得見，但不是圓框 */
      filter: drop-shadow(0 1px 3px rgba(0,0,0,.4));
      pointer-events: none;
      -webkit-user-drag: none;
      user-drag: none;
    }
    .fab.dragging img { filter: drop-shadow(0 4px 10px rgba(0,0,0,.45)); }
    /* 長按選單 */
    .menu {
      position: absolute;
      bottom: 0;
      min-width: 168px;
      background: #ffffff;
      border-radius: 12px;
      box-shadow: 0 8px 28px rgba(0,0,0,.22);
      padding: 6px;
      display: none;
      flex-direction: column;
      gap: 2px;
      font: 13px -apple-system, 'PingFang TC', 'Microsoft JhengHei', sans-serif;
    }
    .menu.show { display: flex; }
    .menu.side-left  { left: calc(var(--fab-hit, 32px) + 8px); }
    .menu.side-right { right: calc(var(--fab-hit, 32px) + 8px); }
    /* 垂直翻轉:預設 bottom:0 從按鈕底緣向上長;按鈕靠視窗頂緣時向上空間不足,
       openMenu 量測後加 .v-down 改從按鈕頂緣向下長(對稱 side-left/right 的水平處理) */
    .menu.v-down { bottom: auto; top: 0; }
    .menu-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 12px;
      border-radius: 8px;
      background: none;
      border: none;
      width: 100%;
      text-align: left;
      color: #1d1d1f;
      font: inherit;
      cursor: pointer;
      white-space: nowrap;
    }
    .menu-item:hover { background: #f0f0f3; }
    .menu-divider { height: 1px; background: #e5e5ea; margin: 4px 8px; }
    .menu-item.feature .slot.feature-icon { font-size: 13px; line-height: 1; }
    /* YouTube 字幕開關列的「CC」徽章：兩字母縮到 18px 徽章內 */
    .menu-item.yt-subtitle .slot.yt-icon { font-size: 9px; font-weight: 700; letter-spacing: -.5px; }
    .menu-item .slot {
      flex: 0 0 auto;
      width: 18px;
      height: 18px;
      border-radius: 5px;
      background: #0071e3;
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .menu-item .label { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  `;

  shadow.innerHTML = `
    <button class="fab" id="fab" type="button" aria-label="Shinkansen">
      ${iconUrl ? `<img src="${iconUrl}" alt="">` : ''}
    </button>
    <div class="menu" id="menu" role="menu"></div>
  `;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
  } catch (_e) {
    const styleEl = document.createElement('style');
    styleEl.textContent = CSS;
    shadow.prepend(styleEl);
  }
  btn = shadow.getElementById('fab');
  menuEl = shadow.getElementById('menu');
  document.documentElement.appendChild(host);

  // ─── 設定狀態 ───────────────────────────────────────────────────────────
  let pos = { ...DEFAULT_POS };   // offsetY = 0(頂)…1(底) 比例
  let currentOpacity = DEFAULT_OPACITY;        // 使用者設定的透明度（選單開啟時暫時拉到 1，關閉還原）

  function resolveEnabled(v) {
    // 未設過（非 boolean）→ 一律預設開啟（不分平台）
    return typeof v === 'boolean' ? v : true;
  }

  // disable → 重新 enable 時按鈕回到預設位置（比照 JRead floating-icon.js v0.8.161）：
  // 使用者把按鈕拖到不順手的角落後，到設定關掉再開即重置。初始載入（lastEnabled = null）
  // 不重置，尊重 storage 存的位置；只有 false→true 的轉移才 applyPos(null)+persist。
  let lastEnabled = null;
  function applyEnabled(enabled) {
    if (lastEnabled === false && enabled === true) {
      applyPos(null);     // sanitizePos(null) → 預設位置（右下角）
      persistPos();
    }
    lastEnabled = enabled;
    host.style.display = enabled ? 'block' : 'none';
    if (!enabled) closeMenu();
  }

  function applyOpacity(v) {
    if (typeof v === 'number') currentOpacity = Math.max(0.1, Math.min(1, v));
    // 選單開啟時保持全不透明，讓使用者看清選單；關閉後才套回使用者設定值
    host.style.opacity = menuOpen ? '1' : String(currentOpacity);
  }

  // floatingIconSize：16（小）/ 24（中，預設）/ 32（大）。設 CSS 變數驅動 .fab 與 .fab img
  // 尺寸，並更新 hitSize 供 applyPos / 拖移 clamp 計算。未設 / 非合法值 fallback 預設 24（中）；
  // 16 是合法選項故必須列進白名單，否則會被 fallback 吃掉變 24。
  function applySize(v) {
    iconSize = (v === 16 || v === 24 || v === 32) ? v : DEFAULT_ICON_SIZE;
    hitSize = iconSize + HIT_PADDING;
    host.style.setProperty('--fab-icon', iconSize + 'px');
    host.style.setProperty('--fab-hit', hitSize + 'px');
    applyPos(pos);   // 尺寸變了重貼邊，避免超出視窗
  }

  function sanitizePos(p) {
    const edge = (p && (p.edge === 'left' || p.edge === 'right')) ? p.edge : DEFAULT_POS.edge;
    let offsetY = p && typeof p.offsetY === 'number' ? p.offsetY : DEFAULT_POS.offsetY;
    if (!(offsetY >= 0 && offsetY <= 1)) offsetY = DEFAULT_POS.offsetY;
    return { edge, offsetY };
  }

  // iPadOS：把 top 夾到「按鈕 hit 區不碰上下角落 OS 保留區」範圍，避免停進 iPadOS 視窗
  // 縮放把手 / 系統手勢角落而再也拖不出來。純函式（吃 viewportH / hit / ipad）方便
  // regression 直接驗，不依賴實機平台。非 iPadOS（iPhone / 桌面）只夾在可視範圍、不留角落間距。
  function cornerClampTop(top, viewportH, hit, ipad) {
    const maxFree = Math.max(0, viewportH - hit);          // 不夾角落時 top 的合法上限
    if (!ipad) return Math.max(0, Math.min(maxFree, top));
    const minTop = CORNER_DEADZONE_PX;                     // 離頂部角落安全距
    const maxTop = viewportH - hit - CORNER_DEADZONE_PX;   // 離底部角落安全距
    // 視窗太矮（maxTop < minTop）夾不出安全區 → 置中，至少不卡在角落極端
    if (maxTop < minTop) return Math.max(0, Math.min(maxFree, Math.round(maxFree / 2)));
    return Math.max(minTop, Math.min(maxTop, top));
  }

  // 依 pos 把 host 貼到邊緣（offsetY 比例 → top px）
  function applyPos(p) {
    pos = sanitizePos(p);
    const rawTop = Math.round(pos.offsetY * Math.max(0, window.innerHeight - hitSize));
    const top = cornerClampTop(rawTop, window.innerHeight, hitSize, isIPadOS);
    host.style.top = top + 'px';
    host.style.bottom = 'auto';
    if (pos.edge === 'left') {
      host.style.left = EDGE_MARGIN + 'px';
      host.style.right = 'auto';
    } else {
      host.style.right = EDGE_MARGIN + 'px';
      host.style.left = 'auto';
    }
    // 選單開口方向：icon 在右緣 → 往左展；在左緣 → 往右展
    menuEl.classList.toggle('side-left', pos.edge === 'left');
    menuEl.classList.toggle('side-right', pos.edge === 'right');
  }

  function persistPos() {
    try { browser.storage.sync.set({ floatingIconPos: pos }); } catch (_e) {}
  }

  // ─── 長按選單 ───────────────────────────────────────────────────────────
  let menuOpen = false;
  let outsideHandler = null;

  function pickPopupSlot(raw) {
    const n = Number(raw);
    return [1, 2, 3].includes(n) ? n : 2;   // 與 lib/storage.js pickPopupSlot 同義（content script 不能 import）
  }

  async function buildMenu() {
    let presets = SK.DEFAULT_PRESETS || [];
    try {
      const { translatePresets } = await browser.storage.sync.get('translatePresets');
      if (Array.isArray(translatePresets) && translatePresets.length > 0) presets = translatePresets;
    } catch (_e) {}
    const ordered = [1, 2, 3].map(slot => presets.find(p => p.slot === slot)).filter(Boolean);
    menuEl.textContent = '';
    for (const p of ordered) {
      const item = document.createElement('button');
      item.className = 'menu-item';
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.dataset.slot = String(p.slot);
      const slotBadge = document.createElement('span');
      slotBadge.className = 'slot';
      slotBadge.textContent = String(p.slot);
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = p.label || p.model || p.engine || ('Preset ' + p.slot);
      item.appendChild(slotBadge);
      item.appendChild(label);
      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        runPreset(p.slot, true);   // 選單選引擎 → 強制重譯，不先還原原文
      });
      menuEl.appendChild(item);
    }
    // 分隔線 +（YouTube 影片頁）字幕翻譯開關 +「功能選單」
    const divider = document.createElement('div');
    divider.className = 'menu-divider';
    menuEl.appendChild(divider);
    // YouTube 影片頁：加「啟動 / 關閉字幕翻譯」列。狀態依 SK.YT.active 決定 label
    //（已翻→「關閉字幕翻譯」；未翻→「啟動字幕翻譯」）。選單每次開啟重建，label 恆為最新狀態。
    if (typeof SK.isYouTubePage === 'function' && SK.isYouTubePage()) {
      const ytActive = !!(SK.YT && SK.YT.active);
      const ytItem = document.createElement('button');
      ytItem.className = 'menu-item yt-subtitle';
      ytItem.type = 'button';
      ytItem.setAttribute('role', 'menuitem');
      ytItem.dataset.yt = 'subtitle';
      ytItem.dataset.active = ytActive ? '1' : '0';
      const ytIcon = document.createElement('span');
      ytIcon.className = 'slot yt-icon';
      ytIcon.textContent = 'CC';
      const ytLabel = document.createElement('span');
      ytLabel.className = 'label';
      const ytKey = ytActive ? 'floating.ytSubtitleOff' : 'floating.ytSubtitleOn';
      ytLabel.textContent = (typeof SK.t === 'function')
        ? SK.t(ytKey)
        : (ytActive ? '關閉字幕翻譯' : '啟動字幕翻譯');
      ytItem.appendChild(ytIcon);
      ytItem.appendChild(ytLabel);
      ytItem.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        toggleYtSubtitle();
      });
      menuEl.appendChild(ytItem);
    }
    const featureItem = document.createElement('button');
    featureItem.className = 'menu-item feature';
    featureItem.type = 'button';
    featureItem.setAttribute('role', 'menuitem');
    featureItem.dataset.feature = 'menu';
    const fIcon = document.createElement('span');
    fIcon.className = 'slot feature-icon';
    fIcon.textContent = '☰';
    const fLabel = document.createElement('span');
    fLabel.className = 'label';
    fLabel.textContent = (typeof SK.t === 'function' ? SK.t('floating.featureMenu') : '功能選單');
    featureItem.appendChild(fIcon);
    featureItem.appendChild(fLabel);
    featureItem.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      openFeaturePanel();
    });
    menuEl.appendChild(featureItem);
  }

  async function openMenu() {
    if (host.style.display === 'none') return;
    await buildMenu();
    menuEl.classList.add('show');
    // 垂直方向選邊:按鈕拖到視窗頂緣時,預設向上長的選單會超出畫面點不到(review
    // D3)。.show 後可量測選單高度,向上空間(host 底緣到 viewport 頂)放不下就翻
    // 向下長。同一 task 內同步完成,不會閃爍
    menuEl.classList.remove('v-down');
    try {
      const hostRect = host.getBoundingClientRect();
      if (hostRect.bottom - menuEl.offsetHeight < 0) menuEl.classList.add('v-down');
    } catch (_e) { /* 量測失敗維持預設向上 */ }
    menuOpen = true;
    host.style.opacity = '1';   // 選單開啟時拉到全不透明，讓使用者看清選單（task：長按降透明度）
    // 點選單外 / 捲動 → 收
    outsideHandler = (ev) => {
      const path = ev.composedPath ? ev.composedPath() : [];
      if (path.includes(host)) return;
      closeMenu();
    };
    document.addEventListener('pointerdown', outsideHandler, true);
    window.addEventListener('scroll', closeMenu, { passive: true, capture: true });
  }

  function closeMenu() {
    if (!menuOpen) return;
    menuEl.classList.remove('show');
    menuOpen = false;
    host.style.opacity = String(currentOpacity);   // 選單收起，還原使用者設定的透明度
    if (outsideHandler) {
      document.removeEventListener('pointerdown', outsideHandler, true);
      outsideHandler = null;
    }
    window.removeEventListener('scroll', closeMenu, true);
  }

  // ─── 功能選單入口 ─────────────────────────────────────────────────────────
  // Safari（macOS / iOS）不能在網頁裡 iframe 載入擴充頁（safari-web-extension:// 在 https
  // 頁的 iframe 是 Safari 已知限制，iOS 上會整頁 refresh）→ 改叫原生工具列 popup
  // （background 的 browser.action.openPopup()，Safari 16+ 支援），失敗則 background 退而
  // 開新分頁載入 popup.html。皆無 iframe → 不 refresh。
  // 非 Safari（Chrome / Firefox）維持頁內 iframe 浮層（openFeaturePanelIframe）：在頁內用
  // closed Shadow DOM + iframe 載入真正的 popup.html?panel=1 當浮層，維持單一資料源
  // （CLAUDE.md §5）。popup.js 偵測 ?panel=1 → 關閉動作改 postMessage('shinkansen-close-panel')。
  let panelHost = null, panelFrame = null, panelMsgHandler = null, panelKeyHandler = null;

  // Safari runtime 偵測：getURL 的 scheme 為 safari-web-extension://（content script 可用）
  function isSafariRuntime() {
    try { return (browser.runtime.getURL('') || '').startsWith('safari-web-extension://'); }
    catch (_e) { return false; }
  }

  function openFeaturePanel() {
    if (isSafariRuntime()) {
      // Safari：交給 background 開原生 popup / 新分頁；不退回 iframe（iframe 會整頁 refresh）
      try {
        if (SK && typeof SK.safeSendMessage === 'function') {
          SK.safeSendMessage({ type: 'OPEN_FEATURE_MENU' }).catch(() => {});
        }
      } catch (_e) {}
      return;
    }
    openFeaturePanelIframe();
  }

  const PANEL_CSS = `
    :host, * { box-sizing: border-box; }
    .backdrop {
      position: fixed; inset: 0;
      background: rgba(0,0,0,.4);
      display: flex; align-items: center; justify-content: center;
      padding: 16px;
      -webkit-tap-highlight-color: transparent;
    }
    .frame {
      border: none;
      width: min(94vw, 360px);
      height: min(86vh, 620px);
      max-height: 86vh;
      border-radius: 16px;
      background: #fff;
      box-shadow: 0 18px 56px rgba(0,0,0,.4);
      overflow: hidden;
    }
  `;

  function closeFeaturePanel() {
    if (!panelHost) return;
    try { panelHost.remove(); } catch (_e) {}
    panelHost = null;
    panelFrame = null;
    if (panelMsgHandler) { window.removeEventListener('message', panelMsgHandler); panelMsgHandler = null; }
    if (panelKeyHandler) { window.removeEventListener('keydown', panelKeyHandler, true); panelKeyHandler = null; }
  }

  function openFeaturePanelIframe() {
    if (panelHost) return;   // 已開著不重複開
    let popupUrl = '';
    try { popupUrl = browser.runtime.getURL('popup/popup.html') + '?panel=1'; } catch (_e) { return; }
    let pHost, pShadow;
    try {
      pHost = document.createElement('div');
      pHost.id = 'shinkansen-panel-host';
      pHost.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483640;';
      pShadow = pHost.attachShadow({ mode: 'closed' });
    } catch (_e) { return; }
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    const frame = document.createElement('iframe');
    frame.className = 'frame';
    frame.setAttribute('title', 'Shinkansen');
    frame.src = popupUrl;
    backdrop.appendChild(frame);
    // 點浮層外圍（backdrop 本體、非 iframe）→ 收
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) closeFeaturePanel();
    });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(PANEL_CSS);
      pShadow.adoptedStyleSheets = [sheet];
    } catch (_e) {
      const styleEl = document.createElement('style');
      styleEl.textContent = PANEL_CSS;
      pShadow.appendChild(styleEl);
    }
    pShadow.appendChild(backdrop);
    document.documentElement.appendChild(pHost);
    panelHost = pHost;
    panelFrame = frame;
    // popup.js（?panel=1）postMessage（驗 source 為本 iframe）：
    //   close-panel → 收浮層；panel-size → 依 popup 內容高度 / 寬度收緊 iframe（避免留白），
    //   高度夾在 [200, 86vh]、寬度夾在 [240, 94vw] 之間（內容比框小才縮、永不超出視窗）。
    panelMsgHandler = (ev) => {
      if (!panelFrame || ev.source !== panelFrame.contentWindow || !ev.data) return;
      if (ev.data.type === 'shinkansen-close-panel') {
        closeFeaturePanel();
      } else if (ev.data.type === 'shinkansen-panel-size') {
        if (typeof ev.data.height === 'number') {
          const capH = Math.round(window.innerHeight * 0.86);
          panelFrame.style.height = Math.max(200, Math.min(ev.data.height, capH)) + 'px';
        }
        // 寬度收緊到 popup 內容寬（桌面 280px），消除外框比內容寬的左右白邊（issue 1）
        if (typeof ev.data.width === 'number' && ev.data.width > 0) {
          const capW = Math.round(window.innerWidth * 0.94);
          panelFrame.style.width = Math.max(240, Math.min(ev.data.width, capW)) + 'px';
        }
      }
    };
    window.addEventListener('message', panelMsgHandler);
    panelKeyHandler = (ev) => { if (ev.key === 'Escape') closeFeaturePanel(); };
    window.addEventListener('keydown', panelKeyHandler, true);
  }

  // ─── 翻譯觸發 ───────────────────────────────────────────────────────────
  // force=true（長按選單選引擎）：直接用該 preset 重新翻譯，不先還原原文（換引擎=重譯）。
  // 短按走 force=false，維持 toggle 語意（已譯→還原）。
  function runPreset(slot, force) {
    if (typeof SK.handleTranslatePreset === 'function') {
      SK.handleTranslatePreset(slot, { force: force === true });
    }
  }

  // YouTube 字幕翻譯開關（長按選單「啟動 / 關閉字幕翻譯」列）：與 popup SET_SUBTITLE
  // 同一份事實——已啟動→停（顯示原生字幕）；未啟動→開始翻譯。不持久化 autoTranslate，
  // 只切當前影片，比照 content.js 的 SET_SUBTITLE handler。
  function toggleYtSubtitle() {
    const active = !!(SK.YT && SK.YT.active);
    if (active) {
      try { SK.stopYouTubeTranslation?.(); } catch (_e) {}
    } else {
      try { SK.translateYouTubeSubtitles?.().catch(() => {}); } catch (_e) {}
    }
  }

  // v1.8.20 popup 按鈕同型修法：短按冷卻——觸控使用者習慣性快速連點兩下時，
  // 第二下會被 toggle 語意解讀成「翻譯中 → 中止」，體感是「按了沒反應 / 翻譯自己停了」
  let _shortPressCooldown = false;

  async function handleShortPress() {
    if (_shortPressCooldown) return;
    _shortPressCooldown = true;
    setTimeout(() => { _shortPressCooldown = false; }, 400);
    let slot = 2;
    try {
      const { popupButtonSlot } = await browser.storage.sync.get('popupButtonSlot');
      slot = pickPopupSlot(popupButtonSlot);
    } catch (_e) {}
    runPreset(slot);
  }

  // ─── pointer 狀態機（短按 / 拖移吸附 / 長按）─────────────────────────────
  let press = null;  // { id, startX, startY, timer, moved, longFired }

  function clearPressTimer() {
    if (press && press.timer) { clearTimeout(press.timer); press.timer = null; }
  }

  btn.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;  // 只認主鍵
    e.preventDefault();
    closeMenu();
    try { btn.setPointerCapture(e.pointerId); } catch (_e) {}
    press = { id: e.pointerId, startX: e.clientX, startY: e.clientY, timer: null, moved: false, longFired: false };
    press.timer = setTimeout(() => {
      if (!press || press.moved) return;
      press.longFired = true;
      press.timer = null;
      openMenu();
    }, LONGPRESS_MS);
  });

  btn.addEventListener('pointermove', (e) => {
    if (!press || e.pointerId !== press.id) return;
    const dx = e.clientX - press.startX;
    const dy = e.clientY - press.startY;
    if (!press.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
      press.moved = true;
      clearPressTimer();
      closeMenu();
      btn.classList.add('dragging');
    }
    if (press.moved) {
      // 自由跟手（拖移期間），放開再吸附
      const half = hitSize / 2;
      const left = Math.max(0, Math.min(window.innerWidth - hitSize, e.clientX - half));
      const top = Math.max(0, Math.min(window.innerHeight - hitSize, e.clientY - half));
      host.style.left = left + 'px';
      host.style.right = 'auto';
      host.style.top = top + 'px';
      host.style.bottom = 'auto';
    }
  });

  function endPress(e) {
    if (!press || e.pointerId !== press.id) return;
    clearPressTimer();
    try { btn.releasePointerCapture(e.pointerId); } catch (_e) {}
    const { moved, longFired } = press;
    press = null;
    btn.classList.remove('dragging');
    if (moved) {
      // 吸附最近邊緣：pointer 在視窗左半 → 左緣，右半 → 右緣
      const edge = e.clientX < window.innerWidth / 2 ? 'left' : 'right';
      const offsetY = Math.max(0, Math.min(1,
        (e.clientY - hitSize / 2) / Math.max(1, window.innerHeight - hitSize)));
      applyPos({ edge, offsetY });
      persistPos();
      return;
    }
    if (longFired) return;        // 長按已開選單，放開不再短按
    handleShortPress();
  }

  btn.addEventListener('pointerup', endPress);
  btn.addEventListener('pointercancel', (e) => {
    if (!press || e.pointerId !== press.id) return;
    clearPressTimer();
    press = null;
    btn.classList.remove('dragging');
  });

  // 視窗縮放：按既有比例重新貼邊（拖移中不干擾）
  window.addEventListener('resize', () => {
    if (press && press.moved) return;
    applyPos(pos);
  }, { passive: true });

  // ─── 初始化：讀 storage + onChanged 即時生效 ─────────────────────────────
  browser.storage.sync.get(['floatingIcon', 'floatingIconOpacity', 'floatingIconSize', 'floatingIconPos']).then((s) => {
    applyOpacity(s.floatingIconOpacity);
    applySize(s.floatingIconSize);
    applyPos(s.floatingIconPos);
    applyEnabled(resolveEnabled(s.floatingIcon));
  }).catch(() => {
    applyOpacity(undefined);
    applySize(undefined);
    applyPos(undefined);
    applyEnabled(resolveEnabled(undefined));
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.floatingIcon) applyEnabled(resolveEnabled(changes.floatingIcon.newValue));
    if (changes.floatingIconOpacity) applyOpacity(changes.floatingIconOpacity.newValue);
    if (changes.floatingIconSize) applySize(changes.floatingIconSize.newValue);
    if (changes.floatingIconPos) applyPos(changes.floatingIconPos.newValue);
  });

  // regression spec（isolated world）用：暴露內部 handler 與狀態
  SK._floating = {
    host, btn, menuEl,
    openMenu, closeMenu, buildMenu,
    handleShortPress,
    // 測試 seam:讓 spec 在連續兩次 handleShortPress 之間重置冷卻(真實使用者的
    // 快速連點就是要被冷卻擋下,spec 驗路由時需繞過)
    _resetShortPressCooldown: () => { _shortPressCooldown = false; },
    runPreset,
    toggleYtSubtitle,
    applyEnabled, applyOpacity, applySize, applyPos,
    resolveEnabled, pickPopupSlot,
    cornerClampTop, CORNER_DEADZONE_PX, isIPadOSEnv,
    openFeaturePanel, openFeaturePanelIframe, closeFeaturePanel, isSafariRuntime,
    isPanelOpen: () => !!panelHost,
    getPanelFrameSrc: () => (panelFrame ? panelFrame.src : null),
    getPanelFrameSize: () => (panelFrame ? { w: panelFrame.style.width, h: panelFrame.style.height } : null),
    isMenuOpen: () => menuOpen,
    getOpacity: () => host.style.opacity,
    getIconSize: () => iconSize,
    getPos: () => ({ ...pos }),
    getTop: () => host.style.top,
    // regression 用：覆寫 iPadOS 旗標以驗角落夾邊路徑（實機 Chromium maxTouchPoints=0）
    setIPadOSForTest: (v) => { isIPadOS = !!v; applyPos(pos); },
  };
})(window.__SK);
