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

// ─── v1.10.59: 非 HTML 文件 gate（pure function 設計，給 spec unit-test 用） ───
// RSS/Atom/純 XML feed（如 rsshub.app/<route>）等被 Chrome 直接渲染的文件，content
// script 一樣會被注入，但這類 XMLDocument 的 createElement('div') 產出的是 namespace
// 為 null 的通用 Element，沒有 .style / attachShadow 等 HTMLElement 能力 →
// content-toast.js 第 9 行 `toastHost.style.cssText = ...` 會直接 throw（Cannot set
// properties of undefined），整條 content script 在此中斷。
//
// 判別不能看 documentElement.namespaceURI：Chrome 的 XML viewer 會在 XMLDocument 上
// 注入一個 namespace 為 xhtml 的 `<html>` pretty-print wrapper（root 看起來像 HTML），
// 但 document 本身仍是 XMLDocument、createElement('div') 仍是無 .style 的通用 Element。
// 所以直接測「這份文件能不能造出帶 .style 的 div」這個 content script 真正依賴的能力
// ——結構性通則，對任何文件型別都成立，不綁站點 / contentType 白名單。
function _sk_isNonHtmlDocument(doc) {
  try {
    const probe = doc && doc.createElement('div');
    return !probe || !probe.style;  // 無 .style = 無 HTMLElement 能力 = 非 HTML 文件
  } catch (_e) {
    return true;  // createElement 都 throw 的文件更不該跑 content script
  }
}

if (window.__shinkansen_loaded) {
  // 防止重複載入（SPA 框架可能重新注入 content script）
} else if (_sk_isCurrentFrameDisabled() || _sk_isNonHtmlDocument(document)) {
  // 在不合格 iframe 內（廣告/分析/cookie consent 等）或非 HTML 文件（RSS/XML feed 等），
  // 不建立完整命名空間，避免在沒有 HTMLElement 能力的文件上注入時 throw
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
    translatedBy: null,      // v1.4.0: 'gemini' | 'google' | 'openai-compat' | null
    // 記錄本次成功翻譯使用的完整 provider 上下文,供 SPA observer rescan / 延遲 rescan /
    // SPA nav 換頁延續翻譯時 replay 同一引擎與參數。
    // null = 尚未成功翻譯;restorePage 清空。resetForSpaNavigation 故意不清(SPA 換頁要記得引擎)。
    // shape: { provider: 'gemini'|'google'|'openai-compat', engine?, modelOverride?, glossary? }
    translationContext: null,
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
    // 在 model 更新時整個 host span 被替換）時，onSpaObserverMutations 用 originalText
    // 比對 mutation 的 addedNodes 找出對應的新 element，從 translatedHTML 拿譯文 re-apply。
    // 沒這條 fallback 的話，新 element 不在 translatedHTML 也不在 originalHTML,
    // Content Guard 完全認不出它，使用者捲動觸發 re-render 後譯文就永久消失。
    originalText: new Map(), // el → snapshot 的 textContent.trim()
    // by-text secondary cache:原始 textContent → savedHTML(已 inject 的 innerHTML)。
    // 用於對抗 SPA virtualization(Twitter / Reddit / Threads / Mastodon)。virtualization
    // 把被翻譯的 element 完全 unmount,使用者再滑回來時 React 建立全新 element 沒有 attribute
    // 也不在 translatedHTML 內 → SPA observer 視為新內容 → 走 collectParagraphs + translateUnits
    // → 即使 cache hit 也會重新 inject + 短暫 flicker;若 serialize 後 placeholder index 微差導致
    // cache miss,還會真打 API 重翻一次,且譯文可能跟原本不同(token / batch context 影響)。
    // 修法:inject 完成同步把 originalText → savedHTML 寫進此 Map;SPA observer rescan 時
    // 用此 Map 預檢 newUnits,命中就 reuse 既有譯文 inject 進新 element,0 API + 譯文一致。
    translatedHTMLByText: new Map(),
    // v1.9.27 Layer A1: nodeValue mutate backup。framework-managed element 走
    // nodeValue mutate path 後,記錄每個 mutated text node 的 original value,
    // restorePage 還原時逐個寫回。Map<el, [{node, originalValue}]>。
    nodeValueMutateBackup: new Map(),
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
    // P1 (v1.8.59): 翻譯目標語言。content.js translatePage 開始時從 storage 注入。
    //   預設 'zh-TW' 維持 v1.8.58 之前行為——content-detect.js isCandidateText 的
    //   isAlreadyInTarget 檢查在 STATE 尚未 hydrate 前 fallback 到 zh-TW(跳繁中段)。
    targetLanguage: 'zh-TW',
    // 注入前 element 的 lang attribute 原值(null = 原本沒設)。譯文注入時把 el lang
    // 設為 targetLanguage 讓瀏覽器選對 CJK 字形變體(避免 zh-TW 頁面下日文譯文用到
    // 中文字形變體 → 視覺不協調),restorePage / abort 路徑用這份還原回原 lang。
    originalLang: new Map(), // el → string | null
    // 注入前 element 的 inline style.fontFamily 原值(空字串 = 原本沒設 inline)。
    // 譯文注入時若 target 是 CJK locale,會把 LOCALE_FONT_PREPEND 對應字體 stack
    // prepend 到 inline fontFamily,確保站點 hardcode 單一 locale 字體
    // (例 upmedia.mg 的 "Noto Serif TC")的情境下,日 / 韓 / 簡中譯文仍能用到對應
    // locale 字形變體。restore 時還原此原值。
    originalFontFamily: new Map(), // el → string
    // v2.0.73:<html lang> 原值備份(undefined = 本輪沒動過;{ orig: string|null },
    // orig null = 原本沒設 attribute)。single mode 翻譯成功後把 documentElement.lang
    // 設為 targetLanguage——per-element lang(originalLang)只蓋注入段落,讀「整份文件」
    // 的下游 scraper(Readwise Reader / Instapaper 等)看的是頁面層級 lang。
    // restorePage / SPA 導航還原。dual mode 不動(頁面同時含原文與譯文,標 target 語意不對)。
    docLangBackup: undefined,
  };

  // v1.10.57:「這頁是否已翻譯」單一裁決源 —— 以 DOM 注入痕跡為準,不信記憶體
  // STATE.translated boolean。SPA 子頁導航時 resetForSpaNavigation 會把 STATE.translated
  // 歸零,但站點保留的舊節點(header / nav / 共用區塊)仍掛 marker + 顯示譯文,造成
  // 「STATE 說沒翻、畫面是譯文」的殭屍狀態 → popup / icon 顯示錯、toggle 走錯動作。
  // 此函式涵蓋三種注入痕跡:single(data-shinkansen-translated)、dual(shinkansen-translation
  // wrapper)、framework-managed nodeValue mutate(data-shinkansen-nodevalue-mutated)。
  SK.TRANSLATED_MARKER_SELECTOR =
    '[data-shinkansen-translated], shinkansen-translation, [data-shinkansen-nodevalue-mutated]';
  SK.isPageTranslated = function isPageTranslated() {
    return !!document.querySelector(SK.TRANSLATED_MARKER_SELECTOR);
  };

  // v1.4.12: content script 在 storage.sync.translatePresets 尚未寫入時的 fallback
  // （例如從 v1.4.11 升級但使用者還未開過設定頁 / onInstalled 沒觸發）。
  // 內容必須與 lib/storage.js DEFAULT_SETTINGS.translatePresets 保持一致。
  SK.DEFAULT_PRESETS = [
    { slot: 1, engine: 'gemini', model: 'gemini-3.1-flash-lite', label: 'Flash Lite' },
    { slot: 2, engine: 'gemini', model: 'gemini-3-flash-preview', label: 'Flash' },
    { slot: 3, engine: 'google', model: null, label: 'Google MT' },
  ];

  // ─── v1.9.17: 首次 inject hydration wait gate(2026-05-20 已停用,值改 0)──────────
  //
  // 【歷史脈絡】v1.9.17 修 SPA framework(Medium React 18 + streaming hydration /
  // Substack / Notion 等)page reload 後 hydration 期間,Shinkansen auto-translate
  // 早於 hydration 完成就 inject DOM → 移走 React reconciliation 認為仍掛在 parent
  // 的 child → React 內部 removeChild 找不到 child → throw NotFoundError → React
  // Router error boundary fallback render「500 系統出狀況」error page。
  //
  // 【2026-05-20 對照實驗結果】Finding 4 instrument-first 5-run 分析發現此 1500ms
  // gate 是 OP first-paint 3.9s 中**固定 64% 的延遲源頭**。對照實驗(SPEC-PRIVATE
  // §25.20.12):暫時 disable gate(本常數設 0)+ reload + 跑 3 種 Medium 場景
  // (cache hit / 404 page / 真實 cold API),全部沒重現 React 500 race,h1 完整
  // 翻成中文,errors:[]。判斷 Medium 自 v1.9.17 至今(~2026-05-13 → 2026-05-20)
  // React 版本升級已內部解掉這條 race,gate 已成 dead code。
  //
  // 【決策】常數改 0(等同跳過 gate),保留 `SK.ensureFirstInjectIdle` machinery
  // 跟 streaming inject 路徑的 gate 呼叫(content.js:559-578),萬一未來新 SPA
  // 站再出現相同 race,只需把這條常數改回 1500 就能一鍵 rollback,不需重新
  // implement gate 機制。
  //
  // 【為什麼不直接刪整套 gate 程式碼】保留 ensureFirstInjectIdle 機制等於保留
  // 「未來如果某個 site 又出 hydration race,可以 host-scoped 加回 gate」的退路。
  // 完全刪掉等於下次踩到同樣 race 要從 git history 撈回來重 implement。
  //
  // 【效能改進】Finding 4 5-run 實測:
  // - X 手動 TRANSLATE:OP first-paint 3.9s → 預估 2.4s(-38%)
  // - Medium auto-translate cache hit:1.5s → ~50ms(-97%)
  // - Medium auto-translate cold API:8.5s → 預估 7s(-18%)
  SK.FIRST_INJECT_HYDRATION_WAIT_MS = 0;
  SK._idleGateReached = false;
  SK._idleGatePromise = null;

  // v1.9.17 F2: user interaction blackout window — click / 按鍵後 2 秒內 framework
  // re-render 旺盛期,Shinkansen 任何 sync restore 都可能撞 React commit phase
  // removeChild race。此 timestamp 由本檔 init 區 mousedown/pointerdown/keydown
  // capture listener 維護;content-spa.js onSpaObserverMutations 內 sync DOM modify
  // 對 blackout window 內 mutation 完全跳過(讓 framework 自己處理,Shinkansen 等
  // armSpaObserverRescan debounce 1s 後 + idle gate 走完整 inject path)。
  SK.USER_INTERACTION_BLACKOUT_MS = 2000;
  SK._lastInteractionT = 0;

  // v1.10.39(code review 2026-06-09 L2):字幕 / Drive 最後一條 cue 沒有「下一條 startMs」
  // 可推 endMs 時,用 startMs + 此值當保守結尾。原本這個 magic 1500 在 content-drive.js
  // (×3)+ content-youtube.js(×2)各自寫死 → 任一處調整其他不會跟著改。集中成共用常數。
  SK.ASR_LAST_CUE_FALLBACK_MS = 1500;
  // v2.0.54:批次末條 e 改查 rawSegments 真實後繼片段起點,此值是延伸上限——
  // 後繼起點離末條起點超過 5s 代表真實靜默(音樂/停頓),cue 不該 linger 整段靜默
  SK.ASR_LAST_CUE_MAX_EXTEND_MS = 5000;
  // v2.0.54:ASR 視窗尾端「延伸到句尾標點」的上限(詳見 content-youtube.js
  // _collectAsrWindowSegs)。real-data(cXot3z7ZPOo):被 150s 邊界切斷的句子到句尾
  // 標點需再收 4 條片段(+10.8s),12s 上限涵蓋這類長句,同時擋住無標點軌的無界延伸
  SK.ASR_WINDOW_MAX_TAIL_EXTEND_MS = 12000;
  // v2.0.54:LLM 合句譯文超過此字元數時 code 端保底拆成多個顯示 cue(詳見
  // content-youtube.js _splitLongAsrCue)。prompt 已要求單句 ≤35 全形字,此值取 40
  // 留容差:36-40 字仍是兩行內,不值得切;>40 在窄播放器會折出第三行
  SK.ASR_CUE_MAX_CHARS = 40;
  // 拆分後每片最短顯示時長;cue 時長不夠拆 N 片時自動減片數,避免字幕閃跳
  SK.ASR_CUE_MIN_PIECE_MS = 1200;
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const markInteraction = () => { SK._lastInteractionT = Date.now(); };
    // capture phase + passive: 確保最早 fire,不阻塞網頁 listener。
    ['mousedown', 'pointerdown', 'keydown'].forEach((evt) => {
      window.addEventListener(evt, markInteraction, { capture: true, passive: true });
    });
  }
  SK.ensureFirstInjectIdle = function ensureFirstInjectIdle() {
    if (SK._idleGateReached) return Promise.resolve();
    if (SK._idleGatePromise) return SK._idleGatePromise;
    // Playwright / WebDriver 自動化環境跳過 gate,避免 1500ms wait 拖累既有 spec 的 mock
    // timing 期待。Production 環境 navigator.webdriver 為 false / undefined,正常走 gate。
    if (typeof navigator !== 'undefined' && navigator.webdriver === true) {
      SK._idleGateReached = true;
      return Promise.resolve();
    }
    SK._idleGatePromise = new Promise((resolve) => {
      const markDone = () => {
        SK._idleGateReached = true;
        SK._idleGatePromise = null;
        resolve();
      };
      setTimeout(markDone, SK.FIRST_INJECT_HYDRATION_WAIT_MS);
    });
    return SK._idleGatePromise;
  };

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
  // Extension reload / 更新時， 已載入頁面的 orphan content script 失去 extension
  // 連線通道， 此後任何 chrome.runtime.* 呼叫會 SYNC throw "Extension context
  // invalidated" — 不是 promise reject! 既有 caller 的 `.catch()` 接不到， 會洩漏
  // uncaught error 到 chrome://extensions/ 錯誤面板， 污染真實 bug 的能見度。
  //
  // 此 helper 用三層防護把 sync throw 統一變 async resolve(undefined):
  //   1. chrome.runtime.id 在 context 死掉時變 undefined → fast path return
  //   2. 進入 sendMessage 前同步 try/catch 接住 sync throw
  //   3. async reject 不主動吞（維持原 caller 的 .catch 行為), 讓真實業務錯誤
  //      仍能被 caller 看到； 只把 invalidated 錯誤吞掉
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
  SK.CONTAINER_TAG_SELECTOR = Array.from(SK.CONTAINER_TAGS).join(',');

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
  // 'tree' / 'treeitem' 是 W3C ARIA 階層 widget 語意（file tree / 分類選擇器 /
  // taxonomy navigator)。本質載的是識別字 listing，不是 prose——典型場景：
  // GitHub 新版 Files sidebar、IDE 檔案瀏覽器、cloud storage UI。誤翻會把檔名
  // 翻成中文+ 連帶 SVG icon 因 innerHTML clean-slate 一併消失。結構性通則，
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
  // 統一在這裡定義，避免 content-youtube.js 多處 inline 三元式 drift(同一份事實多路徑)。
  // - 非 ASR(人工字幕 / heuristic 整句字幕):google / openai-compat / Gemini 三路
  // - ASR LLM(JSON timestamp 模式):Google MT 不支援 JSON 包裝，只有 Gemini / openai-compat
  //   兩路；engine='google' 在 ASR LLM 下走 Gemini fallback
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
  // 其餘（含 google，因為術語表抽取是 LLM 任務，Google MT 不適用）走 EXTRACT_GLOSSARY(Gemini)。
  // engine='google' 走 Gemini 路徑會吃 settings.apiKey，使用者沒填時 background 會回
  // _diag 提示；這是已知 trade-off — 翻譯主路徑用 Google MT 但仍想要 LLM 抽術語表的
  // 使用者必須額外填 Gemini Key。
  SK.getGlossaryExtractType = function getGlossaryExtractType(engine) {
    if (engine === 'openai-compat') return 'EXTRACT_GLOSSARY_CUSTOM';
    return 'EXTRACT_GLOSSARY';
  };

  // 術語表是否啟用 — 單一資料源,fallback 對齊 storage.js DEFAULT_SETTINGS.glossary.enabled(false)。
  // 翻譯路徑(content.js)走 storage.sync.get(null) 原始讀取、不經 getSettings() 合併預設,
  // 全新安裝時 settings.glossary 為 undefined。此處 undefined → false,避免「從沒進設定頁存過檔」
  // 的全新使用者無聲啟用術語表(設定頁顯示「關」卻照建)。有 glossary 物件時沿用既有語意
  // (enabled !== false),維持「存過檔的使用者」行為不變。
  SK.resolveGlossaryEnabled = function resolveGlossaryEnabled(settings) {
    const gc = settings && settings.glossary;
    if (!gc) return false;
    return gc.enabled !== false;
  };

  // v1.8.10: 防禦式清理 LLM 沒照規則回時殘留的多段協定標記。
  // 規格參見 lib/system-instruction.js 的 DELIMITER 與兩種序號標記格式：
  //   - <<<SHINKANSEN_SEP>>>：多段譯文之間的分隔符
  //   - «N»(N 為數字):COMPACT 格式段序號（Gemini 路徑用)
  //   - <<<SHINKANSEN_SEG-N>>>:STRONG 格式段序號（自訂 OpenAI-compat 預設用、弱模型不誤翻)
  // 正常情況下 adapter parser 已 split + 移除標記；但 LLM 偷懶把 N 段合併
  // 成 1 段回傳時（hadMismatch=true 路徑)，分隔符與內段序號會殘留進譯文 string。
  // 寫入 captionMap / DOM 之前先清理，避免使用者看到刺眼的標記。
  // 跟 hadMismatch retry(B 路徑）是分層防禦——這條當最後一道防線。
  // 兩種格式都 strip：跨 engine 切換時的 cache race / 防禦式雙保險。
  SK.sanitizeMarkers = function sanitizeMarkers(text) {
    if (text == null) return text;
    return String(text)
      // v2.0.70: `i` flag — 模型偶發改寫 token 大小寫(<<<SHINKansen_SEP>>>),
      // 協定 token 不可能合法出現在譯文,大小寫變體一律清
      .replace(/\s*<<<SHINKANSEN_SEP>>>\s*/gi, ' ')
      .replace(/<<<SHINKANSEN_SEG-\d+>>>\s*/gi, '')
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
  // v1.8.0: streaming 路徑下 batch 0 size 不影響首字延遲（實測 10/20/30u 的 first_slot_close
  // 都在 1.0-1.2 秒，差距 < 100ms)。擴大到 25 unit / 3700 chars 涵蓋更多文章開頭——
  // 使用者首字看到的譯文範圍從「H1 + 副標 + 開頭幾段」變成「H1 + 副標 + 整段內文前 25 段」。
  // 完整實測見 reports/streaming-probe-2026-04-28.md §2-§5。
  SK.BATCH0_UNITS = 25;
  SK.BATCH0_CHARS = 3700;

  // v1.10.53: Case B 超長區塊(純文字 + 多個 <br>、無 block 子孫)切分門檻。
  // 「整篇文章塞在一個 <div> 用 <br><br> 分段」(Christie's 拍品專文等)原本整塊當單一
  // element 單元 → 變成 2 萬字單一 streaming segment,Gemini flash/flash-lite 串流極慢
  // 甚至 stall「無法結束」。文字超過此值且能按段落切出 ≥2 段時,改切成多個 fragment 平行翻。
  // 取 DEFAULT_CHARS_PER_BATCH:超過單批 char 上限的單元本來就無法併批、只能自己一批,
  // 切分後反而能塞回正常批次平行吞吐。
  SK.BR_BLOCK_SPLIT_CHARS = 3500;

  // SPA 動態載入常數
  SK.SPA_OBSERVER_DEBOUNCE_MS = 1000;
  // maxWait:即使 mutation 連續來 debounce 持續被 reset,從第一次 arm 起算最多
  // 等 2 秒就強制 fire 一次 rescan。對抗 Twitter / Threads / Reddit / Mastodon 等
  // virtualized scroll 站「使用者連續滑動 → debounce 永遠 reset → 譯文遲遲不出現」
  // 體感問題。設 2000ms 是體感與 batching 效率的折衷:debounce 1s + maxWait 2s
  // 表示「使用者停手 1s 內 fire,連續滑也每 2s fire」,batch 仍有合併機會不會退化成
  // 每 mutation 一個 API call。
  SK.SPA_OBSERVER_MAX_WAIT_MS = 2000;

  // v1.9.27 Layer 13:per-host fast profile 機制(預設關)
  // 兩次嘗試都沒救 Finding 3 X 串尾 stall(SPEC-PRIVATE §25.20.5 + §25.20.9):
  //   1. debounce 250/maxWait 500 → 連續 mutation 各 fire 迷你 batch,toast 18s 體感差
  //   2. debounce 1000/maxWait 500 → over-fire 沒發生但 stall 沒解(2/2 runs sy=10465 仍 100%)
  // Root cause 不在 timing,在 detect 路徑(SPA observer 第一輪 mount 後沒抓到該 tweet,
  // 後續 rescan 補但 > 3s window)。正解需 IntersectionObserver rootMargin pre-scan(下輪做)。
  // 架構保留(常數 + getObserverTiming),FAST_HOSTS 暫空。
  SK.SPA_OBSERVER_FAST_DEBOUNCE_MS = SK.SPA_OBSERVER_DEBOUNCE_MS;
  SK.SPA_OBSERVER_FAST_MAX_WAIT_MS = 500;
  SK.SPA_OBSERVER_FAST_HOSTS = [];  // 暫空,兩次嘗試都無效,留架構供未來 IntersectionObserver 路線用
  // 子域名(如 www.x.com / m.reddit.com)由 endsWith('.' + host) 攔截
  SK.getObserverTiming = function getObserverTiming(hostnameOverride) {
    const host = (hostnameOverride ?? location.hostname ?? '').toLowerCase();
    if (!host) return { debounce: SK.SPA_OBSERVER_DEBOUNCE_MS, maxWait: SK.SPA_OBSERVER_MAX_WAIT_MS, host: '', profile: 'default' };
    const isFast = SK.SPA_OBSERVER_FAST_HOSTS.some(h => host === h || host.endsWith('.' + h));
    return isFast
      ? { debounce: SK.SPA_OBSERVER_FAST_DEBOUNCE_MS, maxWait: SK.SPA_OBSERVER_FAST_MAX_WAIT_MS, host, profile: 'fast' }
      : { debounce: SK.SPA_OBSERVER_DEBOUNCE_MS, maxWait: SK.SPA_OBSERVER_MAX_WAIT_MS, host, profile: 'default' };
  };
  SK.SPA_OBSERVER_MAX_RESCANS = Infinity;
  SK.SPA_OBSERVER_MAX_UNITS = 50;
  SK.SPA_NAV_SETTLE_MS = 800;

  // v1.9.28 Layer 14:IntersectionObserver pre-scan(SPEC-PRIVATE §25.20.9 Finding 3 正解)
  // POC 數據(2026-05-19 aimikoda 串實測):IO `rootMargin:1000px` fire 比 user dwell on
  // 該 tweet 早約 3.3s,API 1.5-2s 內 inject → user dwell window 開始已是中文。MO mount
  // 觸發 io.observe,IO `isIntersecting:true` callback 走 100ms 微 batch → 直接呼叫
  // `triggerSpaObserverRescan`,跳過 SPA observer debounce 1s + maxWait 2s 整條時序鏈。
  // 走同條 spaObserverRescan 主體 → tiny silent / by-text reuse / seen-texts TTL /
  // 800ms loading delay 全 inherit。
  //
  // 為什麼不會回到 §25.20.5 over-fire bug:IO 只觀察 selector 命中元素,且每個元素
  // unobserve 後不重 fire;Phase 5 fast debounce 失敗是因為 mutation 對整片 DOM noise
  // 開 fire。POC 實測 19+ tweet 收進 ~10 個 IO callback batch(瀏覽器原生合成)。
  SK.PRESCAN_BATCH_WINDOW_MS = 100;
  SK.PRESCAN_ROOT_MARGIN = '1000px';
  // 子域名(如 www.x.com / m.twitter.com)由 endsWith('.' + host) 攔截
  SK.PRESCAN_HOSTS = ['x.com', 'twitter.com'];
  // 每個 host 對應的 selector — 沒對到 selector 即使 host 命中也不啟動。
  // `:not([data-shinkansen-translated])` 排除已翻段,避免重複 enqueue。
  SK.PRESCAN_SELECTORS = {
    'x.com':       '[data-testid="tweetText"]:not([data-shinkansen-translated])',
    'twitter.com': '[data-testid="tweetText"]:not([data-shinkansen-translated])',
  };
  SK.getPrescanConfig = function getPrescanConfig(hostnameOverride) {
    const host = (hostnameOverride ?? location.hostname ?? '').toLowerCase();
    if (!host) return null;
    const matched = SK.PRESCAN_HOSTS.find(h => host === h || host.endsWith('.' + h));
    if (!matched) return null;
    const selector = SK.PRESCAN_SELECTORS[matched];
    if (!selector) return null;
    return { host, matched, selector, rootMargin: SK.PRESCAN_ROOT_MARGIN, batchWindowMs: SK.PRESCAN_BATCH_WINDOW_MS };
  };

  // 術語表常數
  // v1.7.3: blockingThreshold 從 5 提高到 10——中等長度頁面（6-10 批）走 fire-and-forget
  // 不阻塞首字，省下 EXTRACT_GLOSSARY 1.5-7.4 秒等待。長頁（>10 批）仍 blocking。
  // 必須跟 lib/storage.js DEFAULT_SETTINGS.glossary.blockingThreshold 同步。
  SK.GLOSSARY_SKIP_THRESHOLD_DEFAULT = 1;
  SK.GLOSSARY_BLOCKING_THRESHOLD_DEFAULT = 10;
  SK.GLOSSARY_TIMEOUT_DEFAULT = 60000;

  // Rescan 常數
  SK.RESCAN_DELAYS_MS = [1200, 3000];

  // CJK 字元匹配 pattern（serialize 用）
  SK.CJK_CHAR = '[\\u3400-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef]';

  // ─── locale-aware 字體 fallback ──────────────────────
  // 站點若 hardcode 單一 locale 字體(例 upmedia.mg 的 "Noto Serif TC" 開頭 stack)
  // 涵蓋 CJK 漢字 codepoint 卻只有該 locale 字形變體,單純設 lang attribute 無法
  // 換到目標 locale 字形(因為瀏覽器停在第一順位字體不再 fallback)。對 CJK target
  // 譯文 prepend 對應 locale 字體 stack,讓瀏覽器優先選對 locale 字體。
  // 站點原 stack 仍保留在 prepend 之後當 fallback,系統沒裝這些字體時不影響顯示。
  // 歐語 target(en/es/fr/de)沒 Han variant 問題,不在表中 → applyTargetLocaleStyling
  // 跳過 prepend。
  // 每 locale 兩組 stack:sans-serif / serif。applyTargetLocaleStyling 偵測站點原
  // font-family 屬於哪種風格,挑對應 stack prepend,避免「站點 serif 但譯文變 sans」
  // 之類視覺不一致(例 upmedia.mg 用 Noto Serif TC,日文譯文應用 Hiragino Mincho 系)。
  // Stack 順序:macOS 字體 → Windows 字體 → Linux/通用 Noto CJK fallback。
  // 瀏覽器依序選第一個系統有的字體,因此 macOS 用戶走 Hiragino / PingFang 等 Apple 字體,
  // Windows 用戶走 Yu Gothic / Microsoft JhengHei / MingLiU 等內建字體,Linux 用戶
  // 走 Noto CJK 系列(若已安裝)。三個平台都應有正確 locale 字形變體。
  SK.LOCALE_FONT_PREPEND = {
    ja: {
      'sans-serif': '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", "Meiryo", "MS Gothic", "Noto Sans CJK JP", "Noto Sans JP"',
      'serif': '"Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "MS Mincho", "Noto Serif CJK JP", "Noto Serif JP"',
    },
    ko: {
      'sans-serif': '"Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans CJK KR", "Noto Sans KR"',
      'serif': '"AppleMyungjo", "Batang", "BatangChe", "Gungsuh", "Noto Serif CJK KR", "Noto Serif KR"',
    },
    'zh-TW': {
      'sans-serif': '"PingFang TC", "Heiti TC", "Microsoft JhengHei", "Noto Sans CJK TC", "Noto Sans TC"',
      'serif': '"Songti TC", "LiSong Pro", "MingLiU", "PMingLiU", "Noto Serif CJK TC", "Noto Serif TC"',
    },
    'zh-CN': {
      'sans-serif': '"PingFang SC", "Heiti SC", "Microsoft YaHei", "DengXian", "Noto Sans CJK SC", "Noto Sans SC"',
      'serif': '"Songti SC", "STSong", "SimSun", "NSimSun", "Noto Serif CJK SC", "Noto Serif SC"',
    },
  };

  // 偵測 font-family stack 屬於 serif 還是 sans-serif 風格,以決定 prepend 哪組 locale 字體。
  // 策略:取第一個顯式字體名(去引號 trim),命中 serif 標記詞 → serif,否則一律 sans-serif。
  // serif 標記詞涵蓋常見 serif 字體 family 名(Times / Georgia / Mincho / Songti / Sung /
  // Ming / 宋 / 明朝)+ 通用 generic family `serif`。先排除 `sans-serif` 整字 token
  // 避免子字串誤命中。
  SK.detectFontStyle = function detectFontStyle(fontFamily) {
    if (!fontFamily || typeof fontFamily !== 'string') return 'sans-serif';
    const firstFont = (fontFamily.split(',')[0] || '').replace(/^["']|["']$/g, '').trim();
    if (!firstFont) return 'sans-serif';
    if (/sans-serif/i.test(firstFont)) return 'sans-serif';
    if (/serif|mincho|songti|sungti|\bsung\b|\bming\b|times|georgia|palatino|garamond|cambria|宋|明朝/i.test(firstFont)) {
      return 'serif';
    }
    return 'sans-serif';
  };

  // 把 BCP 47 lang code 正規化成 LOCALE_FONT_PREPEND 的 key(zh-TW / zh-CN / ja / ko)。
  // 涵蓋常見 BCP 47 變體:zh-Hant-TW / zh-Hans-CN / ja-JP / ko-KR / zh-HK 等。
  // 'zh' 不帶 region 視為 ambiguous → 回 null(讓 caller 不 prepend 而非猜地區)。
  // 不認識的 lang code(en / fr / 空字串)也回 null。
  SK.normalizeLangCode = function normalizeLangCode(lang) {
    if (!lang || typeof lang !== 'string') return null;
    const lower = lang.toLowerCase();
    if (lower === 'ja' || lower.startsWith('ja-')) return 'ja';
    if (lower === 'ko' || lower.startsWith('ko-')) return 'ko';
    // zh 變體:Hant / TW / HK / MO → zh-TW;Hans / CN / SG → zh-CN
    if (lower.includes('hant') || lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-mo') return 'zh-TW';
    if (lower.includes('hans') || lower === 'zh-cn' || lower === 'zh-sg') return 'zh-CN';
    return null;
  };

  // ─── v1.5.0 雙語對照模式常數 ─────────────────────────
  SK.TRANSLATION_WRAPPER_TAG = 'shinkansen-translation';
  SK.DEFAULT_MARK_STYLE = 'tint';
  // 視覺標記合法值（options 頁 radio + content.js sanitize）
  SK.VALID_MARK_STYLES = new Set(['tint', 'bar', 'dashed', 'none']);

  // ─── v1.8.52 雙語對照強調色常數 ─────────────────────
  // auto = 維持各 mark 預設配色；其餘 7 token 套單一色到三種 mark
  // 注意：token 清單與 hex 對照表要跟 options.js / docs 同步。
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
   * 把使用者設定值正規化：
   *   - 'auto' 或非字串 / 不認得 → 'auto'
   *   - 已知 token → 原樣回傳
   *   - 6 碼 hex(去頭尾空白後通過 re）→ 統一回大寫（避免 cache key 漂移）
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
    const style = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
    if (style) {
      if (style.visibility === 'hidden' || style.display === 'none') return false;
    }
    let rect = null;
    if (el.offsetParent === null) {
      rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
    }
    // sr-only / visually-hidden a11y pattern:`position:absolute` + 1×1 rect
    //(藉 `clip: rect(0,0,0,0)` / `clip-path: inset(...)` 把可視範圍裁掉)。
    // 對 sighted user 完全不可見，翻譯後 wrapper 不繼承裁切 → 反而暴露原本該隱
    // 藏的譯文（zerobyte 截圖案例)，需擋掉。
    if (style && style.position === 'absolute') {
      if (!rect) rect = el.getBoundingClientRect();
      if (rect.width <= 1 && rect.height <= 1) return false;
    }
    return true;
  };

  // 是否含有需要保留的媒體元素
  SK.containsMedia = function containsMedia(el) {
    return !!el.querySelector('img, picture, video, svg, canvas, audio');
  };

  // ─── v2.0.61 media-like 判定(AMP / web component lazy 升級通則) ───
  // 「media-like」= 傳統媒體 tag + embed 類,再加「無文字自訂元素」(tag 含 '-')。
  // Why:AMP 等框架對視窗外元件 lazy 升級,升級前 <amp-img> 無子節點、升級後
  // (responsive layout)也可能只有空 sizer——兩種狀態 querySelector 都掃不到媒體
  // 後代,但它就是媒體 / widget 載體,清掉 = 圖片蒸發(historyvshollywood 內文圖)。
  // 「無文字」守門:有文字的自訂元素(文字型 web component)照常走文字流翻譯。
  SK.MEDIA_TAG_SELECTOR = 'img, picture, video, svg, canvas, audio, iframe, embed, object';
  SK.isMediaLikeElement = function isMediaLikeElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.matches?.(SK.MEDIA_TAG_SELECTOR)) return true;
    return el.tagName.includes('-') && (el.textContent || '').trim() === '';
  };
  // containsMediaLike:自身或後代含 media-like。後代自訂元素 CSS 選不到
  //(選擇器語法沒有「tag 名含 -」),逐一掃 querySelectorAll('*')——呼叫端子樹
  // 都很小(inline run 子節點 / 段落直屬子樹,已排除 block 子孫),成本可接受。
  SK.containsMediaLike = function containsMediaLike(el) {
    if (SK.isMediaLikeElement(el)) return true;
    if (el.querySelector && el.querySelector(SK.MEDIA_TAG_SELECTOR)) return true;
    if (!el.querySelectorAll) return false;
    for (const d of el.querySelectorAll('*')) {
      if (d.tagName.includes('-') && (d.textContent || '').trim() === '') return true;
    }
    return false;
  };

  // 是否含有 block 後代（v1.1.9 重構：用 querySelector 取代 getElementsByTagName 迴圈）
  SK.containsBlockDescendant = function containsBlockDescendant(el) {
    return !!el.querySelector(SK.BLOCK_TAG_SELECTOR);
  };

  // 「實質文字」字元集(單一資料源:hasSubstantiveContent 與 content-detect.js
  // inline fragment 收集共用)。v2.0.52 補假名 \u3040-\u30FF(含片假名延伸
  // \u31F0-\u31FF、半形片假名 \uFF66-\uFF9D)與諺文 \uAC00-\uD7A3——原字元集
  // 只有拉丁 / 西里爾 / 漢字 / 數字,純假名文字(日文小說對白「いえ、いいんです」)
  // 被判「無實質文字」:EPUB 錨點政策把帶 id 的純假名元素當原子保留 ⟦*N⟧(整段
  // 永不送翻),網頁路徑純假名 inline run 也不收集。
  SK.SUBSTANTIVE_CHAR_RE = /[A-Za-zÀ-ÿ\u0400-\u04FF\u3040-\u30FF\u31F0-\u31FF\u3400-\u9fff\uAC00-\uD7A3\uFF66-\uFF9D0-9]/;

  SK.hasSubstantiveText = function hasSubstantiveText(txt) {
    return SK.SUBSTANTIVE_CHAR_RE.test(txt || '');
  };

  // 內容是否「有實質文字」
  SK.hasSubstantiveContent = function hasSubstantiveContent(el) {
    return SK.hasSubstantiveText(el.innerText || el.textContent || '');
  };

  // 「原子保留」子樹
  SK.isAtomicPreserve = function isAtomicPreserve(el) {
    if (el.tagName === 'SUP' && el.classList && el.classList.contains('reference')) return true;
    // v1.4.10: <hr> 是區塊分隔線，序列化時保留為 ⟦*N⟧，避免 clean slate 注入後丟失
    if (el.tagName === 'HR') return true;
    return false;
  };

  // SPAN 通常是樣式 hook，只在帶 class 或 inline style 時才保留
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
      // Inline <code>(非 PRE 內）算需要保留——CODE 在 HARD_EXCLUDE_TAGS 是給 walker
      // 擋整個 code 區塊用，但段落內 inline <code> 必須當 atomic slot 保留（否則
      // serializer 後面會跳過整顆，grey background 一併消失)。必須先於 HARD_EXCLUDE。
      if (n.tagName === 'CODE'
          && !(n.parentElement && n.parentElement.tagName === 'PRE')) return true;
      // Inline <button>(段落內含 text 的 SPA read-more 觸發按鈕)同 inline CODE 模式:
      // BUTTON 在 HARD_EXCLUDE_TAGS 擋 form / dialog widget,inline 用法必須開洞保留。
      // 必須先於 HARD_EXCLUDE 檢查。
      if (n.tagName === 'BUTTON' && SK.hasSubstantiveContent(n)) return true;
      if (SK.HARD_EXCLUDE_TAGS.has(n.tagName)) continue;
      if (SK.isAtomicPreserve(n)) return true;
      if (SK.isPreservableInline(n)) return true;
    }
    return false;
  };

  // 判斷一個 node 是否可以納入 inline-run
  // v2.0.6:「無文字 + 含媒體 + block-level display」= 結構性媒體群組,不是行內文字流。
  // 典型:讀者頭像列 `<div class="reader" style="display:flex"><span><img>×N</span></div>`,
  // 媒體尺寸靠祖先範圍 CSS(`.reader img { width:0.2rem }`)撐。若被 extractInlineFragments
  // 併進 inline run,fragment 序列化把 IMG 當 atomic slot deep clone、把 .reader / span
  // 包裹層當透明容器拍平,注入時 clean-rebuild 成扁平 IMG siblings → `.reader img` 祖先
  // 鏈斷掉 → 媒體失去尺寸(頭像從 18px 爆成原生 110px)。
  //
  // 行內 emoji(`<span style="display:inline"><img></span>` 夾在 prose text 之間)display
  // 是 inline-level → 不符本條 → 仍留在 run 走 atomic slot 保留位置。差別在 computed
  // display:block-level(block/flex/grid/table…)是媒體「群組」,inline-level 才是行內媒體。
  //
  // 結構性通則(§8):依「無 translatable 文字 + 含保留媒體 + block-level display」判斷,
  // 不綁站點 / class / hostname。任何用 block 容器分組頭像 / 縮圖 / icon 列的站點都套用。
  SK.isTextlessBlockMediaGroup = function isTextlessBlockMediaGroup(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if ((el.textContent || '').trim().length > 0) return false;
    if (!SK.containsMedia(el)) return false;
    const cs = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
    if (!cs) return false;
    const d = cs.display;
    // inline-level display → 行內媒體,不排除;其餘(block-level)→ 媒體群組,排除
    if (d === 'inline' || d === 'inline-block' || d === 'inline-flex'
        || d === 'inline-grid' || d === 'inline-table' || d === 'contents') return false;
    return true;
  };

  // v2.0.61:isBlockMediaGroup——isTextlessBlockMediaGroup 的放寬版,允許帶文字。
  // 「block-level display + 含 media-like」= 圖(或 widget)+ 圖說的結構群組,不是
  // 行內文字流;被 extractInlineFragments 併進 run 的話,fragment 注入 startNode..
  // endNode 整段移除重建會把整顆群組(含媒體)換成純譯文 text node
  //(historyvshollywood `<div class="featdv"><amp-img/>圖說</div>` 實例)。
  // 斷開 run 後群組由 walker 遞迴當 element 候選,媒體走 inject 端保留路徑。
  // 行內 emoji / 行內媒體 wrapper(inline-level display)不受影響,仍留在 run。
  SK.isBlockMediaGroup = function isBlockMediaGroup(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (!SK.containsMediaLike(el)) return false;
    const cs = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
    if (!cs) return false;
    const d = cs.display;
    if (d === 'inline' || d === 'inline-block' || d === 'inline-flex'
        || d === 'inline-grid' || d === 'inline-table' || d === 'contents') return false;
    return true;
  };

  SK.isInlineRunNode = function isInlineRunNode(child) {
    if (child.nodeType === Node.TEXT_NODE) return true;
    if (child.nodeType !== Node.ELEMENT_NODE) return false;
    if (SK.HARD_EXCLUDE_TAGS.has(child.tagName)) return false;
    if (SK.BLOCK_TAGS_SET.has(child.tagName)) return false;
    if (SK.containsBlockDescendant(child)) return false;
    // v2.0.61:從 isTextlessBlockMediaGroup 換成放寬版 isBlockMediaGroup
    //(帶圖說文字的媒體群組也要斷 run;textless 版為其子集,語意見各自註解)
    if (SK.isBlockMediaGroup(child)) return false;
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

  // v1.9.27: 偵測 element 是否被 framework(React / Vue)直接管理。
  // 用途:inject 時若 element 被 framework 接管,改子樹會破 framework 的 DOM
  // node ref(典型 React fiber),導致使用者後續點按鈕(X 推文「顯示更多」/
  // Reddit/Threads/Medium 留言「展開」)後 framework click handler 失效
  // 或 silent bail out(facebook/react#11538 同類)。
  //
  // 對應 facebook/react#11538 系列 issue:framework 認知的 DOM ref 在外部
  // mutation 後變孤兒,framework reconcile 失敗。修法是「不動 element 子樹」=
  // 退回 dual mode(sibling 加 wrapper),由 SK.injectTranslation 入口分派。
  //
  // 偵測必須走 main world bridge:Chrome content script isolated world 看不到
  // main world expando 屬性(`__reactFiber$xxx` / `__vue_app__` 等),
  // `for(k in el)` 對 isolated world 直接 reactKeysFound=0(Chrome for Claude
  // 2026-05-19 在真實 X 推文上 probe 驗證)。修法:content-fw-detect-main.js
  // 跑在 world: MAIN,監聽 CustomEvent bridge,sync dispatch detect 結果(primitive
  // string,跨 world clone safe)。
  //
  // 結構性通則(§8):描述「element 被前端 framework instance 直接接管」這個
  // runtime 特徵,不綁站點 / class / hostname。X / Threads / Reddit / Medium
  // 留言 / Mastodon CW 等所有 React-based SPA 上的同類問題都套用。
  const _fwQueryCache = new WeakMap();
  SK.isFrameworkManaged = function isFrameworkManaged(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (_fwQueryCache.has(el)) return _fwQueryCache.get(el);
    let result = false;
    const handler = (e) => {
      const r = e?.detail?.result;
      if (r === 'react' || r === 'vue') result = true;
    };
    el.addEventListener('shinkansen-fw-detect-response', handler, { once: true });
    try {
      el.dispatchEvent(new CustomEvent('shinkansen-fw-detect-request', { bubbles: true }));
    } catch (_) {
      // dispatch 失敗(極罕見)→ 視為非 framework-managed
    } finally {
      // once: true 已自動 remove,這層只是保險(處理 dispatch 拋例外的情境)
      el.removeEventListener('shinkansen-fw-detect-response', handler);
    }
    // v1.10.39(code review 2026-06-09 M3):只快取 true。result=false 可能是「查詢時機
    // 早於 React/Vue fiber 掛載」(streaming hydration:Medium / Substack / Notion)的假陰性,
    // 永久快取會讓該 element 後續被框架接管後仍走 single innerHTML 注入 → 撞 fiber 孤兒
    // (本機制原本就是要避免的)。false 不快取 → 下次該 element 再被查時重新偵測。
    if (result) _fwQueryCache.set(el, result);
    return result;
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
      // MAS build:不顯示 update notice toast(同 popup banner 守衛理由 — Apple
      // Review Guideline 2.3.10 + 同 Bundle ID 覆蓋風險,見 lib/distribution.js)。
      // defense in depth — checkForUpdate 已 gate,storage 正常不會有資料,但
      // 從 Developer ID 切 MAS 的使用者可能殘留 storage。SK.IS_MAS_BUILD 由
      // lib/distribution-cs.js 設(content-ns.js 之後注入)。
      if (SK.IS_MAS_BUILD) return null;
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

  // ─── 送到 Instapaper:擷取當前頁面完整 HTML ──────────────
  // 把使用者眼前這頁（single mode 已就地換成譯文的 DOM）clone 後剝除技術性節點
  // 與擴充自己注入的 UI chrome，序列化成乾淨 HTML 送 Instapaper Full API 的 content
  // 參數，由 Instapaper 端 readability 抽正文。回 { url, title, html }。
  //
  // 純函式（吃 doc 參數）方便 regression spec 在 isolated world 直接驗。
  // 剝除清單:
  //   - 技術性:script / style / noscript / template / link
  //   - 媒體嵌入:iframe / video / audio / object / embed（見下方「為何剝媒體嵌入」）
  //   - 擴充 UI:#shinkansen-toast-host（toast shadow host）、#shinkansen-dual-style（dual 模式注入樣式）
  //   - 保留 <shinkansen-translation> wrapper（dual 模式譯文本體，是要送的內容）
  // 用 outerHTML（HTML 序列化）而非 XMLSerializer:後者會塞 xmlns 與把 void element
  // 改成 XML 自閉合，對下游 reader 是噪音；outerHTML 產出的是乾淨 HTML5。
  //
  // 為何剝媒體嵌入（iframe / video 等）:下游 reader（Instapaper）的正文抽取器會把
  // 影片嵌入「升級」成整篇主要內容——實測 Christie's 文章頁內嵌 Brightcove 播放器
  // iframe 時，Instapaper 抽到的是播放器 UI（字幕設定對話框 + 影片檔名當標題），整篇
  // 19K 字文章被丟掉。一般無影片頁面不受影響（譯文正常送達），只有含影片嵌入的頁面
  // 會被綁架。剝掉媒體嵌入只留文字正文是結構性通則（非站點特判），讓 reader 抽到文章。
  SK.STRIP_FOR_EXTRACT = 'script, style, noscript, template, link, iframe, video, audio, object, embed, #shinkansen-toast-host, #shinkansen-dual-style';

  // 挑「譯文標題」送下游 reader。
  // 為何不用 document.title:single mode 譯文是就地替換 body DOM,**不動 <head><title>**
  //（也不動 og:title 等 meta）→ document.title 永遠是原文標題。實測送到 Instapaper 標題
  // 全是未翻譯原文。譯文標題真正所在是頁面內容區的主標題（已就地翻成譯文)。
  //
  // 為何不只看 <h1>:不少 CMS（WordPress 主題等）把文章主標放 <h2>/<h3>（class
  // post-title / entry-title）而非 <h1>,整頁可能一個 <h1> 都沒有。實測 Stratechery
  // 週報頁 h1 數 = 0,主標是 <main> 內第一個 <h2>(「Fable 的現狀、…」),舊版只查 h1
  // → fallback 到 document.title → 送出原文標題。改成「內容區第一個標題」的結構性通則
  //（非站點特判,§8）:main/article 內主標通常是文件序第一個 heading。
  //
  // 優先序:
  //   1. 內容區（main/article）內的 <h1>
  //   2. 內容區內第一個 <h2>–<h6>（排除 nav/footer 內的）—— CMS 主標在 h2 的情況
  //   3. 任一 <h1>（沒 main/article 容器時;可能是站名 banner,但仍比原文 title 好）
  //   4. 退回 document.title（沒任何可用標題;single mode 不動 <head>,永遠原文）
  SK.pickExtractTitle = function pickExtractTitle(doc) {
    doc = doc || document;
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const container = doc.querySelector('main') || doc.querySelector('article');
    if (container) {
      const h1text = norm(container.querySelector('h1') && container.querySelector('h1').textContent);
      if (h1text) return h1text;
      for (const h of container.querySelectorAll('h2, h3, h4, h5, h6')) {
        if (h.closest('nav, footer')) continue; // 站內導覽 / 頁尾標題不是文章主標
        const t = norm(h.textContent);
        if (t) return t;
      }
    }
    const anyH1 = doc.querySelector('h1');
    const a = norm(anyH1 && anyH1.textContent);
    if (a) return a;
    return doc.title || '';
  };

  // 用 vendored Readability（lib/readability.js）在「譯文 DOM 的 clone」上抽乾淨正文，
  // 取代舊「整頁 documentElement strip」。舊法把整頁 SPA 噪音 + 影片嵌入 facade 一起送
  // Instapaper，下游 readability 會被影片塊綁架（見 PLAN-send-to-instapaper.md）。
  // Readability 跑 clone、不動 live 譯文頁（§15）；抽完套 JRead 驗證過的硬化薄層。
  // 標題仍取譯文主 <h1>（pickExtractTitle）:single mode 不動 <head><title>，Readability
  // 預設偏好 <title> 會拿到未翻譯原文，故主用 h1、Readability title 只當 fallback。
  // Readability 抽不到（罕見結構 / 未載入）時退回 legacy 整頁 strip，至少有內容可送。
  SK.extractPageHtml = function extractPageHtml(doc) {
    doc = doc || document;
    const url = (doc.location && doc.location.href) || '';
    const Rdb = (typeof Readability !== 'undefined') ? Readability
      : (typeof window !== 'undefined' && window.Readability) ? window.Readability : null;
    if (!Rdb) return SK.extractPageHtmlLegacy(doc);
    let parsed = null;
    try {
      const clone = doc.cloneNode(true);
      // 先剝我方注入的 UI host，避免被 Readability 當內容評分
      clone.querySelectorAll('#shinkansen-toast-host, #shinkansen-dual-style').forEach((el) => el.remove());
      // 先剝媒體嵌入（再跑 Readability）:Readability 的 videos regex 會「保留」youtube
      // 等影片 iframe 當內容,而譯文是中文(字元數遠少於英文)→ 整篇正文的字數分數驟降,
      // 一個被保留的影片 iframe 就可能反超整篇文章被選成 article（實測譯文 readtrung
      // 被內嵌 youtube 影片塊綁架成 347 字)。嵌入對下游 reader 本來就要剝（§3 媒體嵌入
      // 會綁架正文）,提前到 Readability 之前剝掉,讓評分只在真正的文字內容間比。
      // 結構性通則:剝通用嵌入 tag（非站點 class）。
      clone.querySelectorAll('iframe, video, audio, object, embed, lite-youtube').forEach((el) => el.remove());
      parsed = new Rdb(clone, { charThreshold: 200 }).parse();
    } catch (_) { parsed = null; }
    if (!parsed || !parsed.content) return SK.extractPageHtmlLegacy(doc);
    const title = (SK.pickExtractTitle(doc) || parsed.title || doc.title || "")
      .replace(/\s+/g, ' ').trim();
    const body = SK.hardenExtractedHtml(parsed.content, title, doc);
    const html = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>'
      + SK.escapeHtmlText(title) + '</title></head><body>' + body + '</body></html>';
    // text:給「送到 Instapaper」的摘要用的純文字(Readability 已抽好正文 textContent)。
    // 折疊空白即可,長度上限交給 summarizeArticle 統一截斷(單一資料源)。已翻譯頁 = 譯文,
    // 未翻譯頁 = 原文,兩者都餵得進摘要 prompt。
    const text = (parsed.textContent || '').replace(/\s+/g, ' ').trim();
    return { url, title, html, text };
  };

  // 把 Readability 輸出的正文 HTML 再硬化一層，對齊 JRead extractReaderPayload 已驗證的
  // 下游修法（下游 reader 會 re-sanitize / re-parse，這些殘留會壞掉呈現）:
  //   1. 剝媒體嵌入（iframe/video/...）：防影片塊在下游 re-parse 時再次綁架正文
  //   2. 去重主標題：下游用 title 欄位另渲染主標，body 內同文 heading 會重複
  //   3. 段落 div→p：下游砍 inline style 後，靠 margin 撐間距的 leaf div 會擠在一起
  //   4. 空殼修剪：剝節點後留下的空殼在下游渲染成空 bullet
  SK.hardenExtractedHtml = function hardenExtractedHtml(htmlString, title, doc) {
    doc = doc || document;
    const root = doc.createElement('div');
    root.innerHTML = String(htmlString || '');
    // 0. 剝註解節點（Readability 會保留 HTML 註解，是下游噪音，且可能含原站嵌入殘留）
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_COMMENT, null);
    const comments = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) comments.push(n);
    comments.forEach((c) => c.remove());
    // 1. 剝媒體嵌入
    root.querySelectorAll('iframe, video, audio, object, embed, canvas').forEach((el) => el.remove());
    // 2. 去重主標題（折疊空白 + 大小寫後與 title 全文相等的 h1-h6）
    const fold = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const ft = fold(title);
    if (ft) {
      root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
        if (fold(h.textContent) === ft) h.remove();
      });
    }
    // 3. 段落 div → p（只含 text / inline 子節點的 leaf div，轉 p 不違反 HTML 規則）
    const INLINE = new Set(['A', 'SPAN', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'SUB', 'SUP',
      'MARK', 'SMALL', 'CODE', 'BR', 'WBR', 'ABBR', 'TIME', 'CITE', 'Q', 'LABEL']);
    Array.from(root.querySelectorAll('div')).forEach((div) => {
      const onlyInline = Array.from(div.childNodes).every((n) =>
        n.nodeType === 3 || (n.nodeType === 1 && INLINE.has(n.tagName)));
      if (onlyInline && (div.textContent || '').trim()) {
        const p = doc.createElement('p');
        while (div.firstChild) p.appendChild(div.firstChild);
        div.replaceWith(p);
      }
    });
    // 4. 空殼修剪（post-order：沒有非空白文字、也沒有媒體子孫的元素整個移除，逐層塌）
    const KEEP = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION',
      'COLGROUP', 'COL', 'BR', 'HR', 'WBR', 'IMG', 'PICTURE', 'SOURCE', 'TRACK', 'SVG']);
    const MEDIA_SEL = 'img, picture, svg';
    (function prune(node) {
      Array.from(node.children).forEach(prune);
      if (node === root) return;
      // SVG(及其他 foreignObject 類)元素的 tagName 是小寫，不 toUpperCase 的話
      // KEEP 的 'SVG' 永遠比不中 → 無文字的 inline SVG 圖整顆被空殼修剪刪掉
      // (MEDIA_SEL querySelector 只查後代，護不住 svg 自身)
      if (KEEP.has(node.tagName.toUpperCase())) return;
      if ((node.textContent || '').trim()) return;
      if (node.querySelector(MEDIA_SEL)) return;
      node.remove();
    })(root);
    return root.innerHTML;
  };

  SK.escapeHtmlText = function escapeHtmlText(s) {
    return String(s || '').replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  };

  // legacy fallback：舊「整頁 documentElement strip」。Readability 抽不到時用，確保至少
  // 有內容可送（雖可能含較多噪音）。STRIP_FOR_EXTRACT / pickExtractTitle 仍為此服務。
  SK.extractPageHtmlLegacy = function extractPageHtmlLegacy(doc) {
    doc = doc || document;
    const root = doc.documentElement;
    if (!root) return { url: '', title: '', html: '' };
    const clone = root.cloneNode(true);
    clone.querySelectorAll(SK.STRIP_FOR_EXTRACT).forEach((el) => el.remove());
    const title = SK.pickExtractTitle(doc);
    // 移除 content 內與標題重複的主標題 <h1>:下游 reader（Instapaper）會用 title 參數
    // 另外渲染一行標題,若 body 又留同字的主 <h1> 就會出現「重複標題」。只移除「正規化
    // 後文字 === title」的那個主 h1（用 pickExtractTitle 的同優先序定位）,其他 h1 不動。
    try {
      const dupH1 = clone.querySelector('main h1') || clone.querySelector('article h1') || clone.querySelector('h1');
      if (dupH1) {
        const t = (dupH1.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t === title) dupH1.remove();
      }
    } catch (_) { /* 移除失敗不影響其餘擷取 */ }
    // 同步把 clone 的 <head><title> 改成譯文標題,讓下游 reader 即使從 content 的
    // <title> 抽標題（而非用 title 參數）也拿到譯文版,雙保險。
    try {
      let titleEl = clone.querySelector('title');
      if (!titleEl) {
        const head = clone.querySelector('head');
        if (head) { titleEl = doc.createElement('title'); head.insertBefore(titleEl, head.firstChild); }
      }
      if (titleEl && title) titleEl.textContent = title;
    } catch (_) { /* 改 <title> 失敗不影響 title 參數 */ }
    const html = '<!DOCTYPE html>\n' + clone.outerHTML;
    // text:摘要用純文字(legacy 路徑從 strip 後的 clone 取,含較多噪音但有總比沒有好)
    const text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    return {
      url: (doc.location && doc.location.href) || '',
      title,
      html,
      text,
    };
  };
}
