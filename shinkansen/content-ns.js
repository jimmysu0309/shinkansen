// content-ns.js — Shinkansen 命名空間、共用狀態、常數、工具函式
// 這是 content script 拆分後的第一個檔案，建立 window.__SK 命名空間，
// 後續子模組透過 (function(SK) { ... })(window.__SK) 存取共用資源。
// 注意：content script 不支援 ES module import，所有邏輯透過全域命名空間共用。

// Safari / Firefox 相容性 shim（v1.3.16）
// content script 不能 import ES module，改用全域方式讓後續所有 content script 繼承。
globalThis.browser = globalThis.browser ?? globalThis.chrome;

// ─── v1.5.2: iframe gate（pure function 設計，給 spec unit-test 用） ───
// manifest 開 `all_frames: true` 讓 content script 也注入 iframe（為了翻 BBC 等
// 站點嵌入的 Flourish / Datawrapper 等第三方圖表 iframe），但 0×0 廣告 iframe、
// reCAPTCHA、cookie consent、Cxense / DoubleClick 等技術性 iframe 不該被翻——
// 否則一個 BBC 文章頁就會跑 11 份 content script、CPU 與第三方 widget 都受傷。
// gate 條件：iframe 內的可見尺寸 >= 200×100 才啟動 content script，否則 SK.disabled = true。
function _sk_shouldDisableInFrame(isFrame, width, height, visible) {
  if (!isFrame) return false;            // 主 frame 永遠啟動
  if (!visible) return true;             // 不可見 → 跳過
  if (width < 200 || height < 100) return true;  // 太小 → 視為廣告/分析 iframe
  return false;
}

function _sk_isCurrentFrameDisabled() {
  const isFrame = window !== window.top;
  if (!isFrame) return false;
  const html = document.documentElement;
  let visible = !!html;
  if (html) {
    const cs = window.getComputedStyle?.(html);
    if (cs && (cs.visibility === 'hidden' || cs.display === 'none')) visible = false;
  }
  return _sk_shouldDisableInFrame(isFrame, window.innerWidth, window.innerHeight, visible);
}

if (window.__shinkansen_loaded) {
  // 防止重複載入（SPA 框架可能重新注入 content script）
} else if (_sk_isCurrentFrameDisabled()) {
  // 在不合格 iframe 內（廣告/分析/cookie consent 等），不建立完整命名空間
  window.__shinkansen_loaded = true;
  window.__SK = { disabled: true, shouldDisableInFrame: _sk_shouldDisableInFrame };
} else {
  window.__shinkansen_loaded = true;

  // ─── 命名空間初始化 ─────────────────────────────────────
  window.__SK = {};
  const SK = window.__SK;
  SK.disabled = false;
  SK.shouldDisableInFrame = _sk_shouldDisableInFrame;

  // ─── 共用狀態 ──────────────────────────────────────────
  SK.STATE = {
    translated: false,
    translatedBy: null,      // v1.4.0: 'gemini' | 'google' | null
    translating: false,      // v0.80: 翻譯進行中（防止重複觸發 + 支援中途取消）
    abortController: null,   // v0.80: AbortController，翻譯中按 Alt+S 或離開頁面時 abort
    cache: new Map(),       // 段落文字 → 譯文
    // 記錄每個被替換過的元素與它原本的 innerHTML，供還原使用。
    // v0.36 起改為 Map，key 是 element，value 是 originalHTML。這樣同一個
    // element 被多個 fragment 單位改動時，只會快照一次「真正的原始 HTML」，
    // 不會被後續 fragment 的中途狀態污染。
    originalHTML: new Map(), // el → originalHTML
    // v1.0.14: 儲存翻譯後的 innerHTML，用於偵測框架覆寫並重新套用。
    translatedHTML: new Map(), // el → translatedHTML
    // 儲存 inject 前 element 的 textContent。當 SPA framework 把
    // 整個被翻譯的 element detach 換成新 element(例如 YouTube 的 yt-attributed-string
    // 在 model 更新時整個 host span 被替換)時,onSpaObserverMutations 用 originalText
    // 比對 mutation 的 addedNodes 找出對應的新 element,從 translatedHTML 拿譯文 re-apply。
    // 沒這條 fallback 的話,新 element 不在 translatedHTML 也不在 originalHTML,
    // Content Guard 完全認不出它,使用者捲動觸發 re-render 後譯文就永久消失。
    originalText: new Map(), // el → snapshot 的 textContent.trim()
    // v1.0.23: 續翻模式
    stickyTranslate: false,
    // v1.4.12: 記錄本次翻譯使用的 preset slot（1/2/3），供 SPA 導航續翻 + 跨 tab sticky 用。
    // null = 非 preset 觸發（例如 autoTranslate 白名單、popup 按鈕舊路徑）。
    stickySlot: null,
    // v1.5.0: 雙語對照模式
    // displayMode：本次翻譯要用的模式（'single' 覆蓋 / 'dual' 雙語對照），讀自 storage 的設定值
    // translatedMode：本次實際翻譯時用的模式（restorePage 依此分派 single / dual 還原邏輯）
    // translationCache：dual 模式下，原段落 → wrapper 的對照表，供 Content Guard 在 SPA 刪掉
    //   wrapper 時 re-append 用。Map<originalEl, wrapperEl>
    displayMode: 'single',
    translatedMode: null,
    translationCache: new Map(),
    // viewportOnly：只翻目前可視範圍，捲動後再補翻進入 viewport 的段落。
    viewportOnlyActive: false,
    viewportScrollTimer: null,
    viewportScrollTranslating: false,
    viewportTranslateOptions: null,
  };

  // v1.4.12: content script 在 storage.sync.translatePresets 尚未寫入時的 fallback
  // （例如從 v1.4.11 升級但使用者還未開過設定頁 / onInstalled 沒觸發）。
  // 內容必須與 lib/storage.js DEFAULT_SETTINGS.translatePresets 保持一致。
  SK.DEFAULT_PRESETS = [
    { slot: 1, engine: 'gemini', model: 'gemini-3.1-flash-lite-preview', label: 'Flash Lite' },
    { slot: 2, engine: 'gemini', model: 'gemini-3-flash-preview', label: 'Flash' },
    { slot: 3, engine: 'google', model: null, label: 'Google MT' },
  ];

  // ─── v0.88: 統一 Log 系統 ─────────────────────────────
  SK.sendLog = function sendLog(level, category, message, data) {
    try {
      browser.runtime.sendMessage({
        type: 'LOG',
        payload: { level, category, message, data },
      }).catch(() => {}); // fire-and-forget
    } catch { /* 靜默 */ }
  };

  // ─── v1.8.19: 安全版 runtime.sendMessage ─────────────────
  // Extension reload / 更新時, 已載入頁面的 orphan content script 失去 extension
  // 連線通道, 此後任何 chrome.runtime.* 呼叫會 SYNC throw "Extension context
  // invalidated" — 不是 promise reject! 既有 caller 的 `.catch()` 接不到, 會洩漏
  // uncaught error 到 chrome://extensions/ 錯誤面板, 污染真實 bug 的能見度。
  //
  // 此 helper 用三層防護把 sync throw 統一變 async resolve(undefined):
  //   1. chrome.runtime.id 在 context 死掉時變 undefined → fast path return
  //   2. 進入 sendMessage 前同步 try/catch 接住 sync throw
  //   3. async reject 不主動吞(維持原 caller 的 .catch 行為), 讓真實業務錯誤
  //      仍能被 caller 看到; 只把 invalidated 錯誤吞掉
  //
  // caller 端 invalidated 時拿到 undefined, 配合 `if (!res?.ok)` 防禦即可。
  SK.safeSendMessage = function safeSendMessage(msg) {
    if (!globalThis.chrome?.runtime?.id) return Promise.resolve(undefined);
    try {
      return browser.runtime.sendMessage(msg).catch((err) => {
        const m = String(err?.message || err);
        if (m.includes('Extension context invalidated') || m.includes('Receiving end does not exist')) {
          return undefined;
        }
        throw err;
      });
    } catch (err) {
      const m = String(err?.message || err);
      if (m.includes('Extension context invalidated')) return Promise.resolve(undefined);
      return Promise.reject(err);
    }
  };

  // ─── 共用常數 ──────────────────────────────────────────

  // Block-level 標籤集合（v1.1.9 統一為 Set，移除舊版 Array 重複定義）
  SK.BLOCK_TAGS_SET = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'LI', 'BLOCKQUOTE', 'DD', 'DT',
    'FIGCAPTION', 'CAPTION', 'TH', 'TD',
    'SUMMARY',
    'PRE',     // v1.0.8: 從 HARD_EXCLUDE_TAGS 移來
    'FOOTER',  // v1.0.9: 內容 footer 需要被 walker 接受
  ]);

  // querySelector 用的 block tag 選擇器字串（預先組好，containsBlockDescendant 用）
  SK.BLOCK_TAG_SELECTOR = Array.from(SK.BLOCK_TAGS_SET).join(',');

  // v1.4.9: 「container-like」非 BLOCK_TAGS_SET 的 tag——可能扮演段落容器角色，
  // 與 inline element（A/SPAN/B/I/...）區分。BBCode Case B 的 DIV 偵測用此白名單，
  // 避免誤抓 inline 元素內的短文字。
  SK.CONTAINER_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE']);

  // 直接排除（純技術性元素 + 我們自己注入的譯文 wrapper）
  // v1.5.2: SHINKANSEN-TRANSLATION 加入 HARD_EXCLUDE。
  // 真實場景：BBC byline 翻譯後譯文是「《Inside Health》主持人，BBC Radio 4」，
  // CJK 字元佔比 < 50%（人名 / 節目名保留英文），不會被 isTraditionalChinese 認定，
  // 所以 isCandidateText 把譯文當「新英文段落」回傳。SPA observer 看到這個
  // 「新段落」就 translateUnits + injectDual 又疊一個 wrapper——每次 BBC 頁面
  // 自然 mutation 觸發 observer，wrapper 再疊一層，視覺上呈現「慢慢長出第二、第三個」。
  // 把 wrapper 整個 tag 標記為 HARD_EXCLUDE，detector 完全跳過 wrapper 子樹即可根治。
  SK.HARD_EXCLUDE_TAGS = new Set([
    'SCRIPT', 'STYLE', 'CODE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'BUTTON', 'SELECT',
    'SHINKANSEN-TRANSLATION',
  ]);

  // 語意容器排除
  SK.SEMANTIC_CONTAINER_EXCLUDE_TAGS = new Set(['FOOTER']);

  // ARIA role 排除
  // 'tree' / 'treeitem' 是 W3C ARIA 階層 widget 語意(file tree / 分類選擇器 /
  // taxonomy navigator)。本質載的是識別字 listing,不是 prose——典型場景:
  // GitHub 新版 Files sidebar、IDE 檔案瀏覽器、cloud storage UI。誤翻會把檔名
  // 翻成中文+ 連帶 SVG icon 因 innerHTML clean-slate 一併消失。結構性通則,
  // 不依賴站點 class。
  SK.EXCLUDE_ROLES = new Set(['banner', 'contentinfo', 'search', 'grid', 'tree', 'treeitem']);

  // 豁免 isInteractiveWidgetContainer 檢查的標籤
  SK.WIDGET_CHECK_EXEMPT_TAGS = new Set([
    'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  ]);

  // 補抓 selector
  SK.INCLUDE_BY_SELECTOR = [
    '#siteSub',
    '#contentSub',
    '#contentSub2',
    '#coordinates',
    '.hatnote',
    '.mw-redirectedfrom',
    '.dablink',
    '[role="note"]',
    '.thumbcaption',
    '[data-testid="tweetText"]',
    '[data-testid="card.layoutLarge.detail"] > div',
    '[data-testid="card.layoutSmall.detail"] > div',
    '.wp-block-post-navigation-link',
  ].join(',');

  // ─── Placeholder 協定常數 ─────────────────────────────
  SK.PH_OPEN = '\u27E6';   // ⟦
  SK.PH_CLOSE = '\u27E7';  // ⟧

  // 需要保留外殼的 inline tag
  SK.PRESERVE_INLINE_TAGS = new Set([
    'A', 'STRONG', 'B', 'EM', 'I', 'CODE', 'MARK', 'U', 'S',
    'SUB', 'SUP', 'KBD', 'ABBR', 'CITE', 'Q', 'SMALL',
    'DEL', 'INS', 'VAR', 'SAMP', 'TIME',
  ]);

  // Google Translate 專用行內標籤白名單（加標記保留外殼）
  // 刻意排除 SPAN（最常見的亂碼來源）、ABBR（純樣式用途）
  SK.GT_INLINE_TAGS = new Set([
    'A', 'B', 'STRONG', 'I', 'EM', 'SMALL', 'U', 'S',
    'SUB', 'SUP', 'MARK', 'DEL', 'INS', 'CITE', 'Q',
  ]);

  // LLM 替代括號字元
  SK.BRACKET_ALIASES_OPEN = ['\u2770'];  // ❰
  SK.BRACKET_ALIASES_CLOSE = ['\u2771']; // ❱

  // 字幕翻譯訊息類型路由 — engine + ASR 兩維對應 background handler。
  // 統一在這裡定義,避免 content-youtube.js 多處 inline 三元式 drift(同一份事實多路徑)。
  // - 非 ASR(人工字幕 / heuristic 整句字幕):google / openai-compat / Gemini 三路
  // - ASR LLM(JSON timestamp 模式):Google MT 不支援 JSON 包裝,只有 Gemini / openai-compat
  //   兩路;engine='google' 在 ASR LLM 下走 Gemini fallback
  SK.getSubtitleBatchType = function getSubtitleBatchType(engine, asr) {
    if (asr) {
      if (engine === 'openai-compat') return 'TRANSLATE_ASR_SUBTITLE_BATCH_CUSTOM';
      return 'TRANSLATE_ASR_SUBTITLE_BATCH';
    }
    if (engine === 'google')        return 'TRANSLATE_SUBTITLE_BATCH_GOOGLE';
    if (engine === 'openai-compat') return 'TRANSLATE_SUBTITLE_BATCH_CUSTOM';
    return 'TRANSLATE_SUBTITLE_BATCH';
  };

  // 術語表抽取訊息類型路由 — 對齊字幕路由的單一資料源原則。
  // engine='openai-compat' 走 EXTRACT_GLOSSARY_CUSTOM(自訂 Provider chat.completions);
  // 其餘(含 google,因為術語表抽取是 LLM 任務,Google MT 不適用)走 EXTRACT_GLOSSARY(Gemini)。
  // engine='google' 走 Gemini 路徑會吃 settings.apiKey,使用者沒填時 background 會回
  // _diag 提示;這是已知 trade-off — 翻譯主路徑用 Google MT 但仍想要 LLM 抽術語表的
  // 使用者必須額外填 Gemini Key。
  SK.getGlossaryExtractType = function getGlossaryExtractType(engine) {
    if (engine === 'openai-compat') return 'EXTRACT_GLOSSARY_CUSTOM';
    return 'EXTRACT_GLOSSARY';
  };

  // v1.8.10: 防禦式清理 LLM 沒照規則回時殘留的多段協定標記。
  // 規格參見 lib/system-instruction.js DELIMITER 與 «N» 序號 prefix:
  //   - <<<SHINKANSEN_SEP>>>:多段譯文之間的分隔符
  //   - «N»(N 為數字):每段譯文開頭的序號標記
  // 正常情況下 lib/gemini.js parser 已 split + 移除標記;但 LLM 偷懶把 N 段合併
  // 成 1 段回傳時(hadMismatch=true 路徑),分隔符與內段序號會殘留進譯文 string。
  // 寫入 captionMap / DOM 之前先清理,避免使用者看到刺眼的英文標記。
  // 跟 hadMismatch retry(B 路徑)是分層防禦——這條當最後一道防線。
  SK.sanitizeMarkers = function sanitizeMarkers(text) {
    if (text == null) return text;
    return String(text)
      .replace(/\s*<<<SHINKANSEN_SEP>>>\s*/g, ' ')
      .replace(/«\d+»\s*/g, '')
      .trim();
  };

  // ─── 翻譯流程常數 ─────────────────────────────────────
  // 注意：content script 無法 import ES module，以下兩個值鏡像 lib/constants.js，
  // 修改時必須同步更新 lib/constants.js（lib/gemini.js 與 lib/storage.js 的單一來源）。
  SK.DEFAULT_UNITS_PER_BATCH = 20;
  SK.DEFAULT_CHARS_PER_BATCH = 3500;
  SK.DEFAULT_MAX_CONCURRENT = 10;
  SK.DEFAULT_MAX_TOTAL_UNITS = 1000;
  // v1.7.2: batch 0 專用較小 limit;batch 1+ 仍用 DEFAULT_*_PER_BATCH 維持並行吞吐。
  // v1.8.0: streaming 路徑下 batch 0 size 不影響首字延遲(實測 10/20/30u 的 first_slot_close
  // 都在 1.0-1.2 秒,差距 < 100ms)。擴大到 25 unit / 3700 chars 涵蓋更多文章開頭——
  // 使用者首字看到的譯文範圍從「H1 + 副標 + 開頭幾段」變成「H1 + 副標 + 整段內文前 25 段」。
  // 完整實測見 reports/streaming-probe-2026-04-28.md §2-§5。
  SK.BATCH0_UNITS = 25;
  SK.BATCH0_CHARS = 3700;

  // SPA 動態載入常數
  SK.SPA_OBSERVER_DEBOUNCE_MS = 1000;
  SK.SPA_OBSERVER_MAX_RESCANS = Infinity;
  SK.SPA_OBSERVER_MAX_UNITS = 50;
  SK.SPA_NAV_SETTLE_MS = 800;

  // 術語表常數
  // v1.7.3: blockingThreshold 從 5 提高到 10——中等長度頁面(6-10 批)走 fire-and-forget
  // 不阻塞首字,省下 EXTRACT_GLOSSARY 1.5-7.4 秒等待。長頁(>10 批)仍 blocking。
  // 必須跟 lib/storage.js DEFAULT_SETTINGS.glossary.blockingThreshold 同步。
  SK.GLOSSARY_SKIP_THRESHOLD_DEFAULT = 1;
  SK.GLOSSARY_BLOCKING_THRESHOLD_DEFAULT = 10;
  SK.GLOSSARY_TIMEOUT_DEFAULT = 60000;

  // Rescan 常數
  SK.RESCAN_DELAYS_MS = [1200, 3000];

  // CJK 字元匹配 pattern（serialize 用）
  SK.CJK_CHAR = '[\\u3400-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef]';

  // ─── v1.5.0 雙語對照模式常數 ─────────────────────────
  SK.TRANSLATION_WRAPPER_TAG = 'shinkansen-translation';
  SK.DEFAULT_MARK_STYLE = 'tint';
  // 視覺標記合法值（options 頁 radio + content.js sanitize）
  SK.VALID_MARK_STYLES = new Set(['tint', 'bar', 'dashed', 'none']);

  // ─── v1.8.52 雙語對照強調色常數 ─────────────────────
  // auto = 維持各 mark 預設配色;其餘 7 token 套單一色到三種 mark
  // 注意:token 清單與 hex 對照表要跟 options.js / docs 同步。
  SK.DUAL_ACCENT_DEFAULT = 'auto';
  SK.DUAL_ACCENT_TOKENS = ['auto', 'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'pink'];
  SK.DUAL_ACCENT_HEX_MAP = {
    blue:   '#3B82F6',
    green:  '#10B981',
    yellow: '#F59E0B',
    orange: '#F97316',
    red:    '#EF4444',
    purple: '#A855F7',
    pink:   '#EC4899',
  };
  SK.DUAL_ACCENT_HEX_RE = /^#[0-9a-fA-F]{6}$/;
  /**
   * 把使用者設定值正規化:
   *   - 'auto' 或非字串 / 不認得 → 'auto'
   *   - 已知 token → 原樣回傳
   *   - 6 碼 hex(去頭尾空白後通過 re）→ 統一回大寫(避免 cache key 漂移）
   */
  SK.sanitizeDualAccent = function sanitizeDualAccent(value) {
    if (typeof value !== 'string') return 'auto';
    const v = value.trim();
    if (SK.DUAL_ACCENT_TOKENS.includes(v)) return v;
    if (SK.DUAL_ACCENT_HEX_RE.test(v)) return v.toUpperCase();
    return 'auto';
  };
  /**
   * 把 accent 值解析為 RGB triplet(供 inline style 用 CSS rgb() 函式套色）。
   * - 'auto' 回傳 null(呼叫端不寫 inline style，走原 CSS 預設）
   * - 認得的 token 走 hex map
   * - 自訂 hex 直接 parse
   * 解不開回 null。
   */
  SK.dualAccentToRgb = function dualAccentToRgb(value) {
    const norm = SK.sanitizeDualAccent(value);
    if (norm === 'auto') return null;
    const hex = SK.DUAL_ACCENT_HEX_MAP[norm] || norm;
    if (!SK.DUAL_ACCENT_HEX_RE.test(hex)) return null;
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
  };
  // 顯示模式合法值
  SK.VALID_DISPLAY_MODES = new Set(['single', 'dual']);
  // 計算「最近的 block 祖先」用的 display 值（雙語模式 inline 段落 wrapper 用）
  SK.BLOCK_DISPLAY_VALUES = new Set([
    'block', 'flex', 'grid', 'table', 'list-item', 'flow-root',
  ]);

  // ─── 共用工具函式 ──────────────────────────────────────

  /** SHA-1 hash（content script 版本，不依賴 ES module import） */
  SK.sha1 = async function sha1(text) {
    const buf = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-1', buf);
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  };

  // 過濾隱藏元素
  SK.isVisible = function isVisible(el) {
    if (!el) return false;
    if (el.tagName === 'BODY') return true;
    if (el.offsetParent === null) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
    }
    const style = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
    if (style) {
      if (style.visibility === 'hidden' || style.display === 'none') return false;
    }
    return true;
  };

  // 是否含有需要保留的媒體元素
  SK.containsMedia = function containsMedia(el) {
    return !!el.querySelector('img, picture, video, svg, canvas, audio');
  };

  // 是否含有 block 後代（v1.1.9 重構：用 querySelector 取代 getElementsByTagName 迴圈）
  SK.containsBlockDescendant = function containsBlockDescendant(el) {
    return !!el.querySelector(SK.BLOCK_TAG_SELECTOR);
  };

  // 內容是否「有實質文字」
  SK.hasSubstantiveContent = function hasSubstantiveContent(el) {
    const txt = (el.innerText || el.textContent || '');
    return /[A-Za-zÀ-ÿ\u0400-\u04FF\u3400-\u9fff0-9]/.test(txt);
  };

  // 「原子保留」子樹
  SK.isAtomicPreserve = function isAtomicPreserve(el) {
    if (el.tagName === 'SUP' && el.classList && el.classList.contains('reference')) return true;
    // v1.4.10: <hr> 是區塊分隔線，序列化時保留為 ⟦*N⟧，避免 clean slate 注入後丟失
    if (el.tagName === 'HR') return true;
    return false;
  };

  // SPAN 通常是樣式 hook,只在帶 class 或 inline style 時才保留
  SK.isPreservableInline = function isPreservableInline(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName;
    if (tag === 'SUP' && el.classList && el.classList.contains('reference')) return false;
    let matchesTag = false;
    if (SK.PRESERVE_INLINE_TAGS.has(tag)) {
      matchesTag = true;
    } else if (tag === 'SPAN') {
      if (el.hasAttribute('class')) matchesTag = true;
      else {
        const style = el.getAttribute('style');
        if (style && style.trim()) matchesTag = true;
      }
    }
    if (!matchesTag) return false;
    if (!SK.hasSubstantiveContent(el)) return false;
    return true;
  };

  // 段落內是否有任何需要保留的 inline 元素
  SK.hasPreservableInline = function hasPreservableInline(el) {
    const all = el.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      // Inline <code>(非 PRE 內)算需要保留——CODE 在 HARD_EXCLUDE_TAGS 是給 walker
      // 擋整個 code 區塊用,但段落內 inline <code> 必須當 atomic slot 保留(否則
      // serializer 後面會跳過整顆,grey background 一併消失)。必須先於 HARD_EXCLUDE。
      if (n.tagName === 'CODE'
          && !(n.parentElement && n.parentElement.tagName === 'PRE')) return true;
      if (SK.HARD_EXCLUDE_TAGS.has(n.tagName)) continue;
      if (SK.isAtomicPreserve(n)) return true;
      if (SK.isPreservableInline(n)) return true;
    }
    return false;
  };

  // 判斷一個 node 是否可以納入 inline-run
  SK.isInlineRunNode = function isInlineRunNode(child) {
    if (child.nodeType === Node.TEXT_NODE) return true;
    if (child.nodeType !== Node.ELEMENT_NODE) return false;
    if (SK.HARD_EXCLUDE_TAGS.has(child.tagName)) return false;
    if (SK.BLOCK_TAGS_SET.has(child.tagName)) return false;
    if (SK.containsBlockDescendant(child)) return false;
    return true;
  };

  /**
   * 收集可見的文字節點（過濾技術節點與隱藏祖先）。
   * 用於 inject 路徑的「最長文字節點就地替換」。
   */
  SK.collectVisibleTextNodes = function collectVisibleTextNodes(el) {
    const textNodes = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let p = node.parentElement;
        while (p && p !== el) {
          if (SK.HARD_EXCLUDE_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
          if (p.tagName === 'PRE' && p.querySelector('code')) return NodeFilter.FILTER_REJECT;
          const cs = p.ownerDocument?.defaultView?.getComputedStyle?.(p);
          if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) {
            return NodeFilter.FILTER_REJECT;
          }
          p = p.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeValue && n.nodeValue.trim()) textNodes.push(n);
    }
    return textNodes;
  };

  SK.findLongestTextNode = function findLongestTextNode(textNodes) {
    let main = textNodes[0];
    for (const t of textNodes) {
      if (t.nodeValue.length > main.nodeValue.length) main = t;
    }
    return main;
  };

  // v1.6.5: 「今日」鍵字串 'YYYY-MM-DD'——**本地時區**而非 UTC。鏡像 lib/update-check.js
  // 的 localTodayKey()。content script 不能 import ES module，且必須與 lib 端用同樣
  // 算法（不然 toast / popup / background 之間 today 不一致導致節流失效或重複提示）。
  // 修改此函式時必須同步更新 shinkansen/lib/update-check.js 的 localTodayKey()。
  SK.localTodayKey = function localTodayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  // v1.6.1: 翻譯成功 toast 顯示「有新版可下載」前的判斷 helper。
  // 同時檢查：(1) storage.local.updateAvailable 有版本資訊；(2) 今日尚未顯示過；
  // (3) 使用者沒勾「不再顯示更新提示」。三條件全成立才回傳 { version, releaseUrl }，
  // 否則回 null（toast 隱藏 update notice 區塊）。
  // v1.6.5: 翻譯成功 toast 顯示「🎉 已升級至 vX.Y」前的判斷 helper。
  // 同時檢查：(1) storage.local.welcomeNotice 有版本資訊；(2) 沒被永久 dismissed
  // （popup 端「知道了」按鈕標記）；(3) 今日尚未顯示過。三條件全成立才回傳 { version }。
  SK.maybeBuildWelcomeNotice = async function maybeBuildWelcomeNotice() {
    try {
      const { welcomeNotice } = await browser.storage.local.get('welcomeNotice');
      if (!welcomeNotice || !welcomeNotice.version) return null;
      if (welcomeNotice.dismissed === true) return null;
      if (welcomeNotice.lastNoticeShownDate === SK.localTodayKey()) return null;
      return { version: welcomeNotice.version };
    } catch {
      return null;
    }
  };

  // v1.6.5: 鏡像 lib/update-check.js 的 isWorthNotifying（content script 不能 import）。
  // 修改此函式時必須同步更新 lib/update-check.js。
  function isWorthNotifying(latest, current) {
    const parse = v => {
      const c = String(v || '').replace(/^v/, '').split('-')[0];
      const p = c.split('.').map(s => parseInt(s, 10) || 0);
      while (p.length < 3) p.push(0);
      return p.slice(0, 3);
    };
    const a = parse(latest);
    const b = parse(current);
    if (a[0] > b[0]) return true;
    if (a[0] < b[0]) return false;
    return a[1] > b[1];
  }

  SK.maybeBuildUpdateNotice = async function maybeBuildUpdateNotice() {
    try {
      const { disableUpdateNotice } = await browser.storage.sync.get('disableUpdateNotice');
      if (disableUpdateNotice === true) return null;
      const { updateAvailable } = await browser.storage.local.get('updateAvailable');
      if (!updateAvailable || !updateAvailable.version) return null;
      if (updateAvailable.lastNoticeShownDate === SK.localTodayKey()) return null;
      // v1.6.5: belt-and-suspenders — 必須 storage.version 真的 > 當前 manifest.version 才提示。
      // 即使 storage 殘留 stale 資料（測試殘留 / update-check 還沒清），toast 也不會錯誤顯示。
      const currentVersion = browser.runtime.getManifest().version;
      if (!isWorthNotifying(updateAvailable.version, currentVersion)) return null;
      // v1.6.3: 三層 fallback URL（同 popup / options click handler）—— storage 缺 releaseUrl
      // 也能跳到合理頁面，不會因為一個欄位缺失整個提示就失效
      const releaseUrl = updateAvailable.releaseUrl
        || `https://github.com/jimmysu0309/shinkansen/releases/tag/v${updateAvailable.version}`;
      return { version: updateAvailable.version, releaseUrl };
    } catch {
      return null;
    }
  };
}
