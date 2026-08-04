// content-youtube.js — Shinkansen YouTube 字幕翻譯模組（isolated world）
// v1.3.12：MAIN world XHR monkey-patch 攔截架構（從 v1.3.8 恢復）
//
// 依賴：window.__SK（content-ns.js）、SK.sendLog、SK.showToast、SK.hideToast
// 載入順序：必須在 content.js 之前、content-ns.js 之後
// 外部介面：SK.YT（狀態物件）、SK.translateYouTubeSubtitles、SK.stopYouTubeTranslation、SK.isYouTubePage
//
// 核心設計（v1.3.12）：
//   1. content-youtube-main.js（MAIN world）XHR monkey-patch 攔截 YouTube 播放器自己的
//      /api/timedtext 請求，取得含 POT 的完整 response，以 shinkansen-yt-captions CustomEvent
//      傳入 isolated world → rawSegments[{text,normText,startMs}]
//   2. 按時間視窗翻譯（預設 30 秒一批），video.timeupdate 驅動觸發下一批
//   3. 在剩餘時間 < lookaheadS（預設 10 秒）時提前翻譯下一批
//   4. observer 提前啟動，支援 on-the-fly 備援（XHR 尚未到來時逐條即時翻譯）
//   5. 字幕翻譯設定（prompt/temperature/windowSizeS/lookaheadS）從 ytSubtitle settings 讀取

(function(SK) {
  if (!SK || SK.disabled) return;  // v1.5.2: iframe gate（見 content-ns.js）

  // ─── 預設設定（storage 讀不到時用這組） ────────────────────
  const DEFAULT_YT_CONFIG = {
    windowSizeS: 30,
    lookaheadS:  10,
    debugToast:  false,
    onTheFly:    false,          // v1.2.49: cache miss 時是否送 on-the-fly API 翻譯
    // preserveLineBreaks 已移除 toggle（v1.2.38），永遠 true（見 translateWindowFrom）
  };

  // ─── Debug 狀態面板 ─────────────────────────────────────
  // 開啟 ytSubtitle.debugToast 後，頁面左上角顯示即時狀態面板。

  let _debugEl        = null;
  let _debugInterval  = null;
  let _lastEvent      = '—';
  // debugToast 開啟時，記錄已 log 過的 miss key，避免同一條字幕重複刷 log
  let _debugMissedKeys = new Set();

  function _debugRender() {
    if (!_debugEl) return;
    const YT = SK.YT;
    const maxMs = YT.rawSegments.length > 0
      ? YT.rawSegments[YT.rawSegments.length - 1].startMs : 0;
    const video   = YT.videoEl || document.querySelector('video');
    const curS    = video ? video.currentTime.toFixed(1) : '0.0';
    const speed   = video ? `${video.playbackRate}x` : '—';
    const config  = YT.config || DEFAULT_YT_CONFIG;
    // v1.2.40: buffer = translatedUpToMs - video.currentTime（正數=超前備妥，負數=字幕追不上）
    // v1.2.59: 若當前視窗 API 還在飛（translatingWindows）且尚未完成（translatedWindows 不含），
    //          buffer 顯示「翻譯中…」，不顯示因 translatedUpToMs 提前佔位造成的虛假正值。
    const bufMs   = video ? YT.translatedUpToMs - video.currentTime * 1000 : 0;
    const _curWinStart = video
      ? Math.floor(video.currentTime * 1000 / ((config.windowSizeS || 30) * 1000)) * ((config.windowSizeS || 30) * 1000)
      : 0;
    const _curWinTranslating = YT.translatingWindows?.has(_curWinStart);
    const _curWinDone        = YT.translatedWindows?.has(_curWinStart);
    const bufStr  = (_curWinTranslating && !_curWinDone)
      ? '翻譯中…'
      : bufMs >= 0
        ? `+${(bufMs / 1000).toFixed(1)}s ✓`
        : `${(bufMs / 1000).toFixed(1)}s ⚠️ 落後`;
    // v1.2.43: 各批次耗時，格式如「5230 / 7110 / 16770ms」，進行中的批次顯示「…」
    const batchArr = YT.batchApiMs || [];
    const batchStr = batchArr.length === 0
      ? (YT.lastApiMs > 0 ? `${YT.lastApiMs}ms` : '—')
      : batchArr.map(t => t > 0 ? `${t}` : '…').join(' / ') + 'ms';
    _debugEl.textContent = [
      '🔍 Shinkansen 字幕 Debug',
      `active      : ${YT.active}`,
      `translating : ${YT.translatingWindows.size > 0}（${YT.translatingWindows.size} 視窗）`,
      `speed       : ${speed}`,
      `rawSegments : ${YT.rawSegments.length} 條（涵蓋 ${Math.round(maxMs/1000)}s）`,
      `captionMap  : ${YT.captionMap.size} 條`,
      `translated↑ : ${Math.round(YT.translatedUpToMs/1000)}s`,
      `coverage    : ${YT.captionMapCoverageUpToMs > 0 ? Math.round(YT.captionMapCoverageUpToMs/1000) + 's' : '—'}`,
      `video now   : ${curS}s`,
      `buffer      : ${bufStr}`,
      `batch API   : ${batchStr}`,
      `batch0 size : ${(() => { const lead = YT.lastLeadMs; const s = YT.firstBatchSize || 8; const tag = lead <= 0 ? `⚠️ lead ${(lead/1000).toFixed(1)}s` : `lead +${(lead/1000).toFixed(1)}s`; return `${s} 條（${tag}）`; })()}`,
      `on-the-fly  : ${YT.onTheFlyTotal} 條`,
      `stale skip  : ${YT.staleSkipCount > 0 ? `⚠️ ${YT.staleSkipCount} 次` : '0'}`,
      `window/look : ${config.windowSizeS}s / ${config.lookaheadS}s`,
      `adapt look  : ${YT.adaptiveLookaheadMs > 0 ? Math.round(YT.adaptiveLookaheadMs / 1000) + 's' : '—'}`,
      `事件        : ${_lastEvent}`,
    ].join('\n');
  }

  function _debugUpdate(eventLabel) {
    const YT = SK.YT;
    if (!YT.config?.debugToast) return;
    _lastEvent = eventLabel;

    if (!_debugEl) {
      _debugEl = document.createElement('div');
      _debugEl.id = '__sk-yt-debug';
      Object.assign(_debugEl.style, {
        position:   'fixed',
        top:        '8px',
        left:       '8px',
        background: 'rgba(0,0,0,0.88)',
        color:      '#39ff14',
        fontFamily: 'monospace',
        fontSize:   '11px',
        lineHeight: '1.65',
        padding:    '8px 12px',
        borderRadius: '6px',
        zIndex:     '2147483647',
        maxWidth:   '340px',
        pointerEvents: 'none',
        whiteSpace: 'pre',
      });
      document.body.appendChild(_debugEl);
      // 啟動 500ms 重繪 timer，讓 video now / captionMap 等欄位即時更新
      _debugInterval = setInterval(_debugRender, 500);
    }

    _debugRender();
  }

  function _debugRemove() {
    if (_debugInterval) { clearInterval(_debugInterval); _debugInterval = null; }
    if (_debugEl) { _debugEl.remove(); _debugEl = null; }
    _lastEvent = '—';
    _debugMissedKeys.clear();
  }

  // ─── 字幕區狀態提示（取代 toast）─────────────────────────
  // 在 .ytp-caption-window-container 內注入一個仿原生字幕樣式的提示元素，
  // 用 setInterval 追蹤 .caption-window 位置，貼在英文字幕正上方。
  // 第一條中文字幕出現（_firstCacheHitLogged）時自動移除。

  let _captionStatusEl    = null;
  let _captionStatusTimer = null;

  function _updateCaptionStatusPosition() {
    if (!_captionStatusEl) return;
    const container = _captionStatusEl.parentElement;
    if (!container) return;

    const captionWindow = document.querySelector('.caption-window');
    if (captionWindow) {
      const contRect  = container.getBoundingClientRect();
      const capRect   = captionWindow.getBoundingClientRect();
      // 若字幕容器在畫面外（播放器未展示）則略過
      if (capRect.height === 0) return;
      const ourH      = _captionStatusEl.offsetHeight || 28;
      const relTop    = capRect.top  - contRect.top - ourH - 4;
      const relLeft   = capRect.left - contRect.left + capRect.width / 2;
      _captionStatusEl.style.top    = Math.max(2, relTop) + 'px';
      _captionStatusEl.style.bottom = '';
      _captionStatusEl.style.left   = relLeft + 'px';
    } else {
      // 尚無英文字幕：貼在字幕區預設底部位置
      _captionStatusEl.style.top    = '';
      _captionStatusEl.style.bottom = '8%';
      _captionStatusEl.style.left   = '50%';
    }
  }

  // v1.8.16: 螢幕上若已有中文字幕(ASR overlay 命中當前 cue / 非 ASR DOM segment
  // 已替換成中文),不顯示「翻譯中…」避免覆蓋實質內容打擾使用者。
  function _hasVisibleChineseCaption() {
    const YT = SK.YT;
    if (YT.isAsr) {
      const video = document.querySelector('video');
      const currentMs = video ? Math.floor(video.currentTime * 1000) : 0;
      const cue = _findActiveCue(currentMs);
      return !!(cue && cue.text && /[一-鿿]/.test(cue.text));
    }
    const segs = document.querySelectorAll('.ytp-caption-segment');
    for (const s of segs) {
      if (/[一-鿿]/.test(s.textContent || '')) return true;
    }
    return false;
  }

  function showCaptionStatus(text) {
    // commit 5c.3:雙語模式不顯示「翻譯中…」status — 原生英文 CC 已經給 user
    // feedback,中文 overlay 也會在 LLM 回後顯示,status indicator 多餘且會夾在
    // overlay 跟原生 CC 中間造成三層觀感(image 21 bug)。
    if (SK.YT.config?.bilingualMode === true) return;
    // 注入目標：.ytp-caption-window-container > 我們的 div
    // 退而求其次用 #movie_player，仍在播放器範圍內
    const container =
      document.querySelector('.ytp-caption-window-container') ||
      document.querySelector('#movie_player');
    if (!container) return;

    if (!_captionStatusEl) {
      _captionStatusEl = document.createElement('div');
      _captionStatusEl.id = '__sk-yt-caption-status';
      // 讀取現有字幕的字型大小，若尚無字幕則用 14px
      const seg      = document.querySelector('.ytp-caption-segment');
      const fontSize = seg ? getComputedStyle(seg).fontSize : '14px';
      Object.assign(_captionStatusEl.style, {
        position:      'absolute',
        zIndex:        '99',
        background:    'rgba(8, 8, 8, 0.75)',
        color:         '#fff',
        fontFamily:    '"YouTube Noto", Roboto, Arial, Helvetica, sans-serif',
        fontSize,
        lineHeight:    '1.5',
        padding:       '0.1em 0.45em',
        borderRadius:  '2px',
        pointerEvents: 'none',
        whiteSpace:    'nowrap',
        transform:     'translateX(-50%)',
        // 初始預設位置
        bottom:        '8%',
        left:          '50%',
      });
      container.appendChild(_captionStatusEl);

      // v1.3.5: 250ms 追蹤——每秒 4 次足夠追蹤字幕位置，節省 60% 定時器開銷（原 100ms）
      if (_captionStatusTimer) clearInterval(_captionStatusTimer);
      _captionStatusTimer = setInterval(_updateCaptionStatusPosition, 250);
      _updateCaptionStatusPosition(); // 立刻更新一次
    }

    _captionStatusEl.textContent = text;
  }

  function hideCaptionStatus() {
    if (_captionStatusTimer) {
      clearInterval(_captionStatusTimer);
      _captionStatusTimer = null;
    }
    if (_captionStatusEl) {
      _captionStatusEl.remove();
      _captionStatusEl = null;
    }
  }

  // ─── 狀態 ──────────────────────────────────────────────────
  SK.YT = {
    captionMap:       new Map(),   // normText(原文) → 譯文
    rawSegments:      [],          // [{text, normText, startMs}] sorted by startMs
    pendingQueue:     new Map(),   // on-the-fly 備案：normText → [DOM element]
    observer:         null,
    batchTimer:       null,
    flushing:         false,
    active:           false,
    videoId:          null,
    isAsr:            false,        // 本影片字幕是否為 YouTube 自動產生（kind=asr）。
                                    //   true → translateWindowFrom 走 ASR 合句路徑（D' 模式,timestamp mode）。
                                    //   shinkansen-yt-captions listener 依 URL search param kind=asr 偵測。
    captionLang:      null,         // v1.8.40: caption URL 的 lang 參數,例如 'en' / 'zh-Hant' / 'zh-CN' / 'ja'
                                    //   用於 translateWindowFrom 判斷是否該 skip(已是繁中字幕就不送 Gemini 翻譯)。
                                    //   shinkansen-yt-captions listener 從 URL searchParams.get('lang') 抓。
    captionSourceId:  null,         // v1.10.46: 字幕來源身份 `videoId|lang|kind`。XHR listener 比對：
                                    //   身份變更（使用者手動切 CC 軌 / chooser 切軌）= 舊軌視窗簿記與譯文全部失效，
                                    //   重置 translatedWindows / captionMap / displayCues 等；同軌 re-fetch(seek /
                                    //   CC toggle 重抓）身份相同 → 不重置，保留已翻進度。
    captionSourceGen: 0,            // v1.10.46: 來源世代計數。translateWindowFrom 開頭快照，結尾比對——
                                    //   in-flight 舊軌批次完成時世代已變 → 不得標 translatedWindows
                                    //   （否則新軌在該視窗被「已翻」誤跳過，完全不翻）。
    translatingWindows: new Set(), // v1.2.54: 正在翻譯中的視窗 startMs 集合（允許不同視窗並行）
    translatedUpToMs: 0,           // 已翻譯涵蓋到的時間點（ms）
    config:           null,        // ytSubtitle settings 快取
    videoEl:          null,        // video element（timeupdate 監聽對象）
    // v1.2.39: 本次影片 session 的累積用量（用於 LOG_USAGE）
    sessionUsage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, billedInputTokens: 0, billedCostUSD: 0, segments: 0, cacheHits: 0 },
    sessionStartTime: 0,
    // v1.2.40: debug 面板診斷資料
    lastApiMs:           0,    // 第一批完成的耗時（ms），用於 buffer 監控
    batchApiMs:          [],   // v1.2.43: 各批次完成耗時陣列，debug 面板逐批顯示
    adaptiveLookaheadMs: 0,    // v1.2.44: 自適應 lookahead（根據上次 API 耗時動態調整）
    staleSkipCount:          0,    // v1.2.45: API 完成時 video 已超過 window end 的次數（追趕跳位）
    captionMapCoverageUpToMs: 0,   // v1.2.46: 實際翻過最遠的位置（僅供 debug 顯示）
    translatedWindows:    new Set(), // v1.2.48: 精確記錄已翻視窗的 windowStartMs 集合
    onTheFlyTotal:            0,   // 本 session 累計落入 on-the-fly 的字幕條數
    firstBatchSize:           8,   // v1.2.50: 最近一次視窗實際使用的首批大小（debug 用）
    lastLeadMs:               0,   // v1.2.50: 最近一次視窗起點距影片位置的 ms（負數=緊急）
    _firstCacheHitLogged:     false, // v1.2.51: 本 session 是否已記錄第一次 cache hit
    _autoCcToggled:           false, // v1.6.20 A 路徑:本 session 是否已自動開過 CC(避免重複)
    _errorNotified:           false, // 本 session 是否已顯示過翻譯錯誤(避免每個視窗重複彈)
    // v1.6.20 G 路徑:ASR 字幕 overlay 用顯示單位 [{ startMs, endMs, sourceText, targetText }]。
    //   onVideoTimeUpdate 根據 video.currentTime 找出當前該顯示的 cue 寫入 overlay。
    //   整句進整句出,不依賴 YouTube 原生 caption-segment(避免 ASR 一字一字跳)。
    displayCues:              [],
    // v2.0.54:ASR 視窗收集已取走的片段 startMs 集合(視窗尾端延伸到句尾標點後,
    // 下一視窗開頭跳過已取走片段——每片段只送翻一次)。詳見 _collectAsrWindowSegs。
    asrSegConsumed:           new Set(),
    // CC 按鈕關閉時暫停送 API(captionMap / rawSegments / active 不變,只擋 onVideoTimeUpdate
    // 等驅動點)。CC 重開時自動續翻並把 translatedUpToMs 對齊當前 currentTime 視窗,避免
    // 暫停期間使用者拖進度條造成虛假超前。
    ccPaused:                 false,
    _ccButtonObserver:        null,
    // mweb(m.youtube.com)auto-CC 有界重試(擋「CC 操作落在廣告播放期間」時序,
    // 詳見 _scheduleMwebCcRetry 註解)
    _mwebCcRetryTimer:        null,
    _mwebCcRetries:           0,
  };

  // ─── 工具 ──────────────────────────────────────────────────

  SK.isYouTubePage = function isYouTubePage() {
    // m.youtube.com(行動版)v1.10.25 起支援:mweb 用同一套 html5 player 核心,
    // /api/timedtext XHR 格式同桌面(fmt=json3),#movie_player API 齊全(已 probe 實證)。
    // 差異點(CC 按鈕不存在 / SPA 事件名不同)在各依賴點以結構特徵 fallback 處理。
    return (location.hostname === 'www.youtube.com' || location.hostname === 'm.youtube.com')
      && location.pathname.startsWith('/watch');
  };

  function normText(t) {
    return t.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function getVideoIdFromUrl() {
    return new URL(location.href).searchParams.get('v') || null;
  }

  async function getYtConfig() {
    if (SK.YT.config) return SK.YT.config;
    const saved = await browser.storage.sync.get('ytSubtitle');
    SK.YT.config = { ...DEFAULT_YT_CONFIG, ...(saved.ytSubtitle || {}) };
    return SK.YT.config;
  }

  // ─── 時間字串轉 ms（TTML 格式 "HH:MM:SS.mmm"） ────────────

  function parseTimeToMs(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.split(':');
    const secs = parts.reduce((acc, p) => acc * 60 + parseFloat(p || 0), 0);
    return Math.round(secs * 1000);
  }

  // ─── 字幕解析：JSON3（含時間戳）────────────────────────────

  // input 可為 JSON 字串(YouTube 路徑,XHR responseText)或已 parse 的 object
  // (Drive 路徑,background fetch 後已 res.json() 過)。
  function parseJson3(input) {
    const json = typeof input === 'string' ? JSON.parse(input) : input;
    const segments = [];
    let groupCounter = 0;
    for (const ev of (json.events || [])) {
      if (!ev.segs) continue;
      const full = ev.segs.map(s => s.utf8 || '').join('');
      // YouTube 以 \n 分隔同一 event 內的多行歌詞；DOM 每行獨立渲染為一個 .ytp-caption-segment
      // 拆行後分別建立條目，確保 normText 與 DOM 字幕對齊，避免落入 on-the-fly
      // preserveLineBreaks 開啟時，同一 event 的多行共用 groupId，供整組送翻
      // v1.10.46: 不做全軌文字 dedup——副歌歌詞 / [Music] 等重複行第二次以後若被丟，
      // 該行第二次出現的時段不在任何 rawSegments → non-ASR seek 到該視窗不送翻、
      // ASR displayCues 出現空窗。重複文字落到 captionMap 是同 key 覆寫，本來就安全。
      const lines = full.split('\n').map(l => l.trim()).filter(Boolean);
      const groupId = lines.length > 1 ? groupCounter++ : null;
      for (const line of lines) {
        segments.push({ text: line, normText: normText(line), startMs: ev.tStartMs || 0, groupId });
      }
    }
    return segments.sort((a, b) => a.startMs - b.startMs);
  }

  // ─── 字幕解析：XML/TTML（含時間戳）────────────────────────

  function parseTtml(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const els = doc.querySelectorAll('text, p');
    const segments = [];
    for (const el of els) {
      const t = el.textContent.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const begin = el.getAttribute('begin') || '0';
      const startMs = begin.includes(':') ? parseTimeToMs(begin) : parseInt(begin, 10) || 0;
      segments.push({ text: t, normText: normText(t), startMs });
    }
    return segments.sort((a, b) => a.startMs - b.startMs);
  }

  // ─── 自動偵測格式並解析 ────────────────────────────────────

  function parseCaptionResponse(responseText) {
    if (!responseText) return [];
    try { return parseJson3(responseText); } catch (_) {}
    try { return parseTtml(responseText); } catch (_) {}
    return [];
  }

  // ─── v1.3.12: MAIN world XHR 攔截結果接收 ────────────────────
  // content-youtube-main.js 的 monkey-patch 攔截 YouTube 播放器自己的 /api/timedtext 請求，
  // 把 responseText 以 CustomEvent 傳進 isolated world。
  //
  // 為什麼不主動 fetch：YouTube 的 /api/timedtext URL 含 exp=xpv 實驗旗標，
  // 所有主動 fetch（包含 MAIN world same-origin、service worker、isolated world）
  // 都會得到 HTTP 200 但 body 為空——必須由播放器自己帶 POT 發出請求，我們攔截它的 response。

  // v1.10.46: 字幕來源失效 → 清空全部視窗簿記與譯文，bump generation 讓 in-flight
  // 舊軌批次完成後不得標 translatedWindows（translateWindowFrom 內世代比對）。
  // 呼叫點：XHR listener 偵測到來源身份變更 / chooser 'switch' 主動切軌。
  function _resetCaptionSourceBookkeeping(reason, extra) {
    const YT = SK.YT;
    YT.captionSourceGen = (YT.captionSourceGen || 0) + 1;
    YT.translatedWindows  = new Set();
    YT.translatingWindows = new Set();
    YT.captionMap         = new Map();
    YT.pendingQueue       = new Map();
    YT.displayCues        = [];
    YT.translatedUpToMs   = 0;
    YT.captionMapCoverageUpToMs = 0;
    YT.asrSegConsumed     = new Set();  // v2.0.54: 換軌後片段時間軸全新,取用紀錄一併歸零
    SK.sendLog('info', 'youtube', `caption source bookkeeping reset (${reason})`, {
      gen: YT.captionSourceGen, ...(extra || {}),
    });
  }

  window.addEventListener('shinkansen-yt-captions', async (e) => {
    const { url, responseText } = e.detail || {};
    if (!responseText) return;

    const segments = parseCaptionResponse(responseText);
    if (segments.length === 0) return;

    const YT = SK.YT;
    // D' 模式偵測：URL 含 kind=asr 即為 YouTube 自動產生字幕，
    // 走「LLM 自由合句 + 時間戳對齊」路徑(timestamp mode)
    // 而非逐條翻譯——後者對 1-3 字短條無法產生有意義譯文。
    // v1.8.40: 順便抓 lang 參數,讓 translateWindowFrom 能判斷字幕原語言。
    //          字幕本身是繁中(zh-Hant / zh-TW / zh-HK / zh-MO)就 skip 翻譯。
    try {
      const u = new URL(url, location.href);
      YT.isAsr = u.searchParams.get('kind') === 'asr';
      YT.captionLang = u.searchParams.get('lang') || null;
    } catch (_) {
      YT.isAsr = false;
      YT.captionLang = null;
    }
    // v1.10.46: 來源身份比對——使用者手動切 CC 軌（雙語流程官方指引就是教這樣切）時，
    // 舊軌的 translatedWindows 純時間 key 會讓新軌在已翻視窗被誤跳過（完全不翻）、
    // 舊軌譯文 / displayCues 殘顯。身份變更即重置；同軌 re-fetch 身份相同不受影響。
    const _sourceId = `${getVideoIdFromUrl() || ''}|${YT.captionLang || ''}|${YT.isAsr ? 'asr' : 'manual'}`;
    if (YT.captionSourceId && YT.captionSourceId !== _sourceId) {
      _resetCaptionSourceBookkeeping('source switched', { from: YT.captionSourceId, to: _sourceId });
    }
    YT.captionSourceId = _sourceId;
    YT.rawSegments = segments;
    // v1.8.40: 換影片/換字幕來源時 reset skip-log 旗標,避免跨影片不再 log skip 原因
    YT._skipLoggedForLang = false;
    // G 路徑:翻譯啟動時才 enable hiding mode + 預建 overlay 容器,
    //         避免使用者啟動翻譯瞬間還看到原生英文字幕跳動。
    //         翻譯未啟動(YT.active=false)時不碰原生字幕。
    if (YT.active) {
      const cfg = YT.config || await getYtConfig();
      if (YT.isAsr) _ensureOverlay();
      _applyBilingualMode(cfg.bilingualMode === true);
    }
    const lastMs = segments[segments.length - 1]?.startMs ?? 0;
    SK.sendLog('info', 'youtube', 'XHR captions captured', {
      segmentCount: segments.length,
      lastMs,
      isAsr: YT.isAsr,
      captionLang: YT.captionLang,
      urlSnippet: url ? url.substring(url.indexOf('/api/timedtext'), Math.min(url.length, url.indexOf('/api/timedtext') + 60)) : '',
    });

    if (YT.active && !YT.ccPaused) {
      // translateYouTubeSubtitles 已啟動但在等待（rawSegments 剛被填入）
      // 直接觸發當前視窗的翻譯
      const video = document.querySelector('video');
      const currentMs = video ? Math.floor(video.currentTime * 1000) : 0;
      const config = YT.config || await getYtConfig();
      const windowSizeMs = (config.windowSizeS || 30) * 1000;
      const windowStartMs = Math.floor(currentMs / windowSizeMs) * windowSizeMs;
      _debugUpdate(`XHR 攔截 ${segments.length} 條字幕（至 ${Math.round(lastMs / 1000)}s），開始翻譯`);
      if (_shouldShowTranslatingStatus()) showCaptionStatus('翻譯中…');
      translateWindowFrom(windowStartMs);
    }
  });

  // ─── 強制重載字幕（CC toggle）────────────────────────────────
  // rawSegments=0 時，CC 字幕資料可能已存在 YouTube 播放器記憶體中，
  // 不會重新發出 /api/timedtext XHR。
  // 解法：把 CC 按鈕關掉再打開，強迫播放器重新抓一次字幕，讓 monkey-patch 有機會攔截。
  //
  // v1.6.20 A 路徑:CC 關著時自動點開(使用者勾「自動翻譯字幕」即代表想看翻譯,
  //                直接幫他開 CC)。每 session 只自動開一次,使用者後續手動關 CC 我們不再補開。

  // ─── isolated↔main bridge request helper ─────────────────────
  // dispatch eventName → 等 resultEventName 回事件；timeoutMs 內沒回 resolve null。
  // 送出的 detail 一律 JSON.stringify 成字串：Firefox 的 isolated→main object detail
  // 被 Xray 安全模型擋下（main 端讀屬性直接 throw Permission denied），primitive
  // 字串跨 compartment 可讀；Chrome 行為不變（main 端雙格式相容讀，見
  // content-youtube-main.js parseBridgeDetail）。回程（main→isolated）的 object
  // detail 兩瀏覽器都可讀（content script 有 Xray vision），不需轉字串。
  function bridgeRequest(eventName, resultEventName, detail, timeoutMs) {
    return new Promise((resolve) => {
      const handler = (e) => {
        window.removeEventListener(resultEventName, handler);
        clearTimeout(timer);
        resolve(e?.detail || null);
      };
      const timer = setTimeout(() => {
        window.removeEventListener(resultEventName, handler);
        resolve(null);
      }, timeoutMs);
      window.addEventListener(resultEventName, handler);
      window.dispatchEvent(new CustomEvent(eventName, detail == null ? undefined : { detail: JSON.stringify(detail) }));
    });
  }

  // mweb(m.youtube.com)CC control bridge 呼叫:沒有 .ytp-subtitles-button 可點,
  // 改走 MAIN world 的 #movie_player captions module API(content-youtube-main.js)。
  // 回傳 { op, ok, ccOn, error };bridge 沒回(理論上不會)以 timeout 保底。
  async function _ccControlViaBridge(op, timeoutMs = 2000) {
    const res = await bridgeRequest('shinkansen-yt-cc-control', 'shinkansen-yt-cc-control-result', { op }, timeoutMs);
    return res || { op, ok: false, error: 'bridge-timeout' };
  }

  // auto-CC 有界重試：CC 操作可能落在廣告播放期間（SPA 切片 / 初載都可能先跑
  // 廣告)——此時 enable 會吃 stale-player-response / no-caption-track、reload 作用在
  // 廣告 player 上,廣告結束後沒人補開 CC → 管線靜默卡死(sim 實測:SPA 切片到帶
  // 廣告影片,字幕永遠不出現)。解法:只要 active 且 rawSegments 還是 0,每 3s 清
  // _autoCcToggled 再跑一次 forceSubtitleReload,上限 20 次(60s,蓋過常見廣告長度)。
  // rawSegments 一進來(timedtext 攔到)重試自然停止;stop / SPA reset 清 timer。
  // v1.10.46: 機制平台共用——桌面（.ytp-subtitles-button）路徑各分支結尾同樣排重試，
  // bridge 確認有字幕但 5s 沒 XHR（tick5）也排；函式名保留 Mweb 前綴是歷史緣由。
  const MWEB_CC_RETRY_MS = 3000;
  const MWEB_CC_MAX_RETRIES = 20;

  function _scheduleMwebCcRetry() {
    const YT = SK.YT;
    if (YT._mwebCcRetryTimer) return; // 已有排程,不重複
    if ((YT._mwebCcRetries || 0) >= MWEB_CC_MAX_RETRIES) return;
    YT._mwebCcRetryTimer = setTimeout(() => {
      YT._mwebCcRetryTimer = null;
      if (!YT.active || YT.rawSegments.length > 0) return; // 已停止 / 字幕已到 → 不再試
      YT._mwebCcRetries = (YT._mwebCcRetries || 0) + 1;
      YT._autoCcToggled = false; // 允許 enable 分支再跑(廣告期間那次不算數)
      SK.sendLog('info', 'youtube', 'mweb CC retry', { attempt: YT._mwebCcRetries });
      forceSubtitleReload();
    }, MWEB_CC_RETRY_MS);
  }

  function _clearMwebCcRetry() {
    const YT = SK.YT;
    if (YT._mwebCcRetryTimer) {
      clearTimeout(YT._mwebCcRetryTimer);
      YT._mwebCcRetryTimer = null;
    }
    YT._mwebCcRetries = 0;
  }

  async function forceSubtitleReload() {
    const btn = document.querySelector('.ytp-subtitles-button');
    if (!btn) {
      // 結構特徵 fallback:CC 按鈕不存在(mweb 播放器 UI 沒有此按鈕)→ player API 路徑。
      // 邏輯對齊下方按鈕路徑:CC 關 → 自動開啟;CC 開 → 強迫重發 XHR。
      // 每個分支結束都排一次有界重試(見 _scheduleMwebCcRetry 註解,擋廣告時序)。
      const status = await _ccControlViaBridge('status');
      if (!status.ok) {
        SK.sendLog('warn', 'youtube', 'forceSubtitleReload: no CC button + bridge status failed', {
          error: status.error,
        });
        _scheduleMwebCcRetry();
        return;
      }
      if (!status.ccOn) {
        if (SK.YT._autoCcToggled) {
          SK.sendLog('info', 'youtube', 'forceSubtitleReload(api): CC off + already auto-toggled, skip');
          return;
        }
        SK.YT._autoCcToggled = true;
        const res = await _ccControlViaBridge('enable');
        SK.sendLog(res.ok ? 'info' : 'warn', 'youtube', 'forceSubtitleReload(api): auto-enable CC', {
          ok: res.ok, error: res.error || null,
        });
        _scheduleMwebCcRetry();
        return;
      }
      const res = await _ccControlViaBridge('reload');
      SK.sendLog(res.ok ? 'info' : 'warn', 'youtube', 'forceSubtitleReload(api): reload captions module', {
        ok: res.ok, error: res.error || null,
      });
      _scheduleMwebCcRetry();
      return;
    }
    const isOn = btn.getAttribute('aria-pressed') === 'true';
    if (!isOn) {
      // A 路徑:CC 沒開 → 主動點一次開啟。每 session 只開一次,尊重使用者後續手動關。
      if (SK.YT._autoCcToggled) {
        SK.sendLog('info', 'youtube', 'forceSubtitleReload: CC off + already auto-toggled, skip');
        return;
      }
      SK.sendLog('info', 'youtube', 'forceSubtitleReload: CC off, auto-clicking to open');
      SK.YT._autoCcToggled = true;
      btn.click();
      _scheduleMwebCcRetry(); // v1.10.46: 有界重試平台共用——廣告期點開沒效時 3s 後再催（見 _scheduleMwebCcRetry 註解）
      return;
    }
    SK.sendLog('info', 'youtube', 'forceSubtitleReload: toggling CC to force new XHR');
    btn.click(); // 關閉 CC → 播放器清空字幕狀態
    await new Promise(r => setTimeout(r, 200));
    if (SK.YT.active) btn.click(); // 重新開啟 CC → 播放器重新抓字幕，觸發 /api/timedtext XHR
    _scheduleMwebCcRetry(); // v1.10.46: 同上，toggle 落在廣告期沒觸發 XHR 時繼續有界催
  }

  // ─── 翻譯單位建構（preserveLineBreaks 模式用）────────────
  // preserve=false：每條 segment 各自一個單位（現有行為）
  // preserve=true ：同一 groupId 的 segment 合成一個單位，以空格串接後整組送翻
  //   （不用 \n 串接，避免 LLM 誤輸出 literal \n 字串進譯文）
  //   翻完後第一個 key 存完整合併譯文，其餘 key 存空字串讓 DOM segment 視覺消失

  function buildTranslationUnits(segs, preserve) {
    if (!preserve) {
      return segs.map(s => ({ text: s.text, keys: [s.normText] }));
    }
    const units = [];
    let i = 0;
    while (i < segs.length) {
      const seg = segs[i];
      if (seg.groupId != null) {
        // 收集所有相鄰且 groupId 相同的 segment
        const group = [seg];
        let j = i + 1;
        while (j < segs.length && segs[j].groupId === seg.groupId) {
          group.push(segs[j]);
          j++;
        }
        units.push({ text: group.map(s => s.text).join(' '), keys: group.map(s => s.normText) });
        i = j;
      } else {
        units.push({ text: seg.text, keys: [seg.normText] });
        i++;
      }
    }
    return units;
  }

  // ─── ASR 模式視窗翻譯(D',timestamp mode) ─────
  //
  // 輸入 windowSegs 的每條 segment 只有 startMs(YouTube ASR 不給 dur)。
  // 我們以「下一條 startMs」當作本條的 endMs;子批最後一條查 YT.rawSegments 的真實
  // 後繼片段起點(cap +ASR_LAST_CUE_MAX_EXTEND_MS 防長靜默 linger),整軌最後一條
  // 才用 startMs + SK.ASR_LAST_CUE_FALLBACK_MS 保守值。
  // LLM 收到緊湊 JSON 陣列,自由合句後回傳同格式陣列。
  //
  // 解析容錯:LLM 可能用 ```json fence 包,先剝;陣列驗證規則——
  //   1. 每個 entry 的 s 必須等於某條原始 segment 的 startMs(否則該 entry 丟棄)
  //   2. e 完全不採信,顯示區間由「有效 entries 依 s 排序後的時間軸分割」決定:
  //      entry i 涵蓋 [s_i, s_{i+1}),最後一個 entry 涵蓋到子批末片段的真實後繼起點。
  //      real-data 校準(2026-07-12,gemini-3.1-flash-lite × 真實 ASR 軌 69 entries):
  //      e 值 100% 是合法輸入值,但 ~4% 挑到「句中片段」而非句尾片段的 e →
  //      句尾 2-4s 字幕提早消失 + 尾片段 uncovered;偶發 s 幻覺(~1.4%)整句被丟。
  //      以片段時間軸為單一資料源分割,LLM 的 e 不再影響顯示。
  // captionMap 寫入慣例:該 entry 分割區間內所有 windowSegs → 第一條 normText 存譯文,
  // 其餘存空字串(視覺等同合併成單行,跟 buildTranslationUnits preserve=true 慣例一致)。

  function _stripJsonFence(s) {
    if (!s) return s;
    const m = s.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (m) return m[1].trim();
    return s.trim();
  }

  // v2.0.54: 批次末片段的顯示終點(YT 子批 / Drive 批次 / heuristic 視窗尾組共用)。
  // 原本一律 lastStartMs + FALLBACK(1500ms),但真實 ASR 相鄰片段間隔中位數 ~1.7s
  // (p90 2.6s),固定 1500 讓每個子批的最後一句系統性提早消失(real-data:32% 短收 >1s)。
  // 改查 rawSegments 真實後繼片段起點;cap +MAX_EXTEND 防止把長靜默(音樂/停頓)
  // 也算進顯示時間;整軌最後一片段(無後繼)才退回 FALLBACK。
  function _asrBatchEndMs(lastStartMs, rawSegments) {
    const next = (rawSegments || []).find(s => s && s.startMs > lastStartMs);
    if (next) return Math.min(next.startMs, lastStartMs + SK.ASR_LAST_CUE_MAX_EXTEND_MS);
    return lastStartMs + SK.ASR_LAST_CUE_FALLBACK_MS;
  }

  // v2.0.54: ASR JSON 協定 entry → 顯示時間軸解析(YT _runAsrSubBatch 與 Drive
  // _runOneBatchLlm 共用,避免同協定雙實作 drift)。取代舊 _normalizeAsrEntry 的
  // 逐條驗證:改以「片段時間軸」為單一資料源做分割。
  //   - s 必須等於某條原始 segment 的 startMs(LLM 幻覺時間戳防禦,同舊規則)
  //   - e 完全不採信:有效 entries 依 s 排序去重(同 s 後者覆蓋前者,對齊
  //     _upsertDisplayCue 同 startMs upsert 語意)後,entry i 的顯示區間 =
  //     [s_i, s_{i+1});最後一個 entry 到 batchEndMs
  //   - s 是幻覺值但落在批次時間範圍內 → 不顯示該 entry,但把該 s 當保守邊界
  //     (cap 前一 entry 的 endMs):LLM 認為那裡有新句子開始,寧可留空窗給
  //     heuristic cue / 空白,也不讓前一句的譯文 linger 蓋到下一句語音上
  // 回 { cues: [{startMs, endMs, text}...] 依 startMs 排序, droppedCount }。
  function _resolveAsrEntryTimeline(entries, subSegs, batchEndMs) {
    const startMsSet = new Set(subSegs.map(seg => seg && seg.startMs));
    const spanStart = subSegs[0] ? subSegs[0].startMs : 0;
    const valid = [];
    const caps = [];
    let droppedCount = 0;
    for (const entry of entries) {
      const s = Number(entry.s);
      const text = String(entry.t || '').trim();
      if (!Number.isFinite(s) || !text) { droppedCount++; continue; }
      if (!startMsSet.has(s)) {
        droppedCount++;
        if (s > spanStart && s < batchEndMs) caps.push(s);
        continue;
      }
      valid.push({ s, text });
    }
    valid.sort((a, b) => a.s - b.s);
    const dedup = [];
    for (const v of valid) {
      if (dedup.length && dedup[dedup.length - 1].s === v.s) dedup[dedup.length - 1] = v;
      else dedup.push(v);
    }
    caps.sort((a, b) => a - b);
    const cues = [];
    for (let i = 0; i < dedup.length; i++) {
      const cur = dedup[i];
      const nextS = i + 1 < dedup.length ? dedup[i + 1].s : batchEndMs;
      const cap = caps.find(c => c > cur.s && c < nextS);
      const endMs = cap != null ? cap : nextS;
      if (endMs <= cur.s) continue; // 防禦:batchEndMs 異常小時不產生零長度 cue
      cues.push({ startMs: cur.s, endMs, text: cur.text });
    }
    return { cues, droppedCount };
  }

  function _parseAsrResponse(text) {
    const stripped = _stripJsonFence(text);
    // 從第一個 [ 開始 parse(防止 LLM 在前面加說明文字)
    const start = stripped.indexOf('[');
    if (start < 0) throw new Error('ASR response: no array found');
    const parsed = JSON.parse(stripped.slice(start));
    if (!Array.isArray(parsed)) throw new Error('ASR response: not an array');
    return parsed;
  }

  // v2.0.54(症狀:句尾詞跨視窗重複,例「…181 匹馬力」/「馬力,但…」):
  // ASR 視窗是純時間對齊切分(floor 到 windowSizeMs),邊界常落在句中;前後視窗
  // 各自獨立送 LLM、互看不到——前窗看到殘句會腦補句尾(「It makes 181」→
  // 「它輸出 181 匹馬力」),後窗把殘餘片段(「horsepower, but…」)忠實翻出
  // 「馬力,但…」,拼起來語意重複(real-data:cXot3z7ZPOo 的 150s 視窗邊界
  // 正好切在「181 ⟷ horsepower」之間)。
  // 修法:視窗末片段文字未收在句尾標點時,尾端繼續收片段直到「句尾標點」或
  // +ASR_WINDOW_MAX_TAIL_EXTEND_MS 上限;consumed(YT.asrSegConsumed)記錄已被
  // 取走的片段 startMs,下一視窗開頭跳過——每片段只送翻一次,不重複計費。
  // ASR 軌沒標點的影片延伸只會打到上限(邊界後移但不比現況差),殘句另由 prompt
  // 「殘句照字面翻、不可補完」規則第二層兜底。
  // 句尾判定:. ! ? 。 ! ? …(允許尾隨引號 / 括號);半形逗號結尾視為句未完。
  const _ASR_SENTENCE_END_RE = /[.!?。！？…]["')\]」』]*$/;

  function _collectAsrWindowSegs(rawSegments, windowStartMs, windowEndMs, consumed) {
    const maxMs = windowEndMs + SK.ASR_WINDOW_MAX_TAIL_EXTEND_MS;
    const segs = [];
    for (const seg of (rawSegments || [])) {
      if (!seg || seg.startMs < windowStartMs) continue;
      // 已被前一視窗延伸取走:視窗本體內 → 跳過續掃;延伸區 → 停(下一視窗領地)
      if (consumed && consumed.has(seg.startMs)) {
        if (seg.startMs >= windowEndMs) break;
        continue;
      }
      if (seg.startMs < windowEndMs) { segs.push(seg); continue; }
      // ── 延伸區(startMs ≥ windowEndMs)──
      if (segs.length === 0) break;                                   // 視窗本體沒片段,不延伸
      if (_ASR_SENTENCE_END_RE.test(segs[segs.length - 1].text.trim())) break;  // 句已收尾
      if (seg.startMs > maxMs) break;                                 // 延伸上限
      segs.push(seg);
    }
    return segs;
  }
  SK._collectAsrWindowSegs = _collectAsrWindowSegs;   // regression spec 直接驅動用

  // v2.0.54(症狀:LLM 無視 prompt 的 35 字上限,50+ 字合一句 → overlay 折成 3+ 行):
  // code 端保底——超長譯文 cue 依標點均衡拆成多個顯示 cue。
  // 時間分配:字元占比只當初估,切點會**吸附到 segStarts 內最近的原始片段起點**
  // (真實語音 onset,±SNAP 容差)——純占比切點是猜的,句內換片會落在語音中間,
  // 使用者感知「時間對齊不準」;吸附後句內切換發生在新片段開口的瞬間。
  // 句內沒有可用 onset(整句只涵蓋一個長片段)才留占比近似;跨語言語序重排造成的
  // 誤差是天生極限,吸附只保證「切在真實開口點」。
  // 只拆顯示 cue:captionMap 仍寫整句(非 ASR 注入路徑與語意查詢不受影響),
  // iOS 全螢幕字幕軌從 displayCues 鏡像、自動跟進拆分結果。
  // cue 時長不足以讓每片 ≥ ASR_CUE_MIN_PIECE_MS 時自動減片數(避免字幕閃跳)。
  const _ASR_SPLIT_SNAP_MS = 2000;   // 切點吸附到片段起點的容差

  function _splitLongAsrCue(startMs, endMs, text, segStarts) {
    const t = String(text || '').trim();
    const total = t.length;
    const whole = [{ startMs, endMs, text: t }];
    if (total <= SK.ASR_CUE_MAX_CHARS) return whole;
    const durMs = endMs - startMs;
    let n = Math.ceil(total / SK.ASR_CUE_MAX_CHARS);
    n = Math.min(n, Math.max(1, Math.floor(durMs / SK.ASR_CUE_MIN_PIECE_MS)));
    if (n <= 1) return whole;
    const SEARCH = 12;   // 理想切點左右找標點的範圍(字元)
    const pieces = [];
    let pos = 0;
    for (let k = 1; k < n; k++) {
      const ideal = Math.round((total * k) / n);
      let cut = -1;
      let bestDist = Infinity;
      const lo = Math.max(pos + 1, ideal - SEARCH);
      const hi = Math.min(total - 2, ideal + SEARCH);
      for (let i = lo; i <= hi; i++) {
        if (_isSentencePunctAt(t, i)) {
          const d = Math.abs(i + 1 - ideal);
          if (d < bestDist) { bestDist = d; cut = i + 1; }
        }
      }
      if (cut < 0) cut = ideal;          // 附近沒標點 → 均分硬切(寧可切也不要第三行)
      // v2.0.63:切點落在拉丁單字／數字 run 內時吸附到 run 邊緣(Union 不切成 Un|ion)
      cut = _snapCutOutOfWord(t, cut, pos, total);
      if (cut <= pos || cut >= total) continue;
      pieces.push(t.slice(pos, cut));
      pos = cut;
    }
    if (pos < total) pieces.push(t.slice(pos));
    if (pieces.length <= 1) return whole;
    // 時間分配:字元占比初估 → 吸附到 cue 區間內最近的片段起點(真實語音 onset)
    const onsets = (segStarts || [])
      .filter(ms => Number.isFinite(ms) && ms > startMs && ms < endMs)
      .sort((a, b) => a - b);
    const out = [];
    let acc = 0;
    let cursor = startMs;
    for (let i = 0; i < pieces.length; i++) {
      acc += pieces[i].length;
      let end;
      if (i === pieces.length - 1) {
        end = endMs;   // 末片收在原 endMs
      } else {
        end = startMs + Math.round(durMs * acc / total);
        let best = null;
        let bestDist = _ASR_SPLIT_SNAP_MS + 1;
        for (const onset of onsets) {
          if (onset <= cursor) continue;
          const d = Math.abs(onset - end);
          if (d < bestDist) { bestDist = d; best = onset; }
        }
        if (best != null && bestDist <= _ASR_SPLIT_SNAP_MS) end = best;
      }
      const pt = pieces[i].trim();
      if (pt && end > cursor) out.push({ startMs: cursor, endMs: end, text: pt });
      cursor = end;
    }
    return out.length ? out : whole;
  }

  // ─── 啟發式 ASR 合句(F/E 模式) ─────
  //
  // pipeline:split(初切)→ merge(合併)→ compact(短句吞併)→ 包成 units
  //
  // 為什麼免 LLM:
  //   - 純啟發式 ~ms 級執行,秒出合句結果
  //   - 翻譯成本只在「翻譯」這一步,合句不耗 token
  //
  // 限制:
  //   - 詞彙列表是英文專用。其他語言需另寫詞彙列表(目前 ASR XHR URL 一律 lang=en)。
  //   - 啟發式不像 LLM 能看上下文,某些模糊邊界會切錯——這就是 progressive mode 用 LLM 覆蓋的價值。

  const _ASR_BREAK_WORDS = new Set([
    // v1.10.46: '-'(speaker-change dash)——比對端先 .trim() 再查表，原 '- '（含尾空格）永不命中
    'mhm', 'um', '>>', '-',
    'in fact', 'such as', 'or even', 'get me', "well i'm",
    "i didn't", 'i know', 'i need', 'i will', "i'll", 'i mean',
    'you are', 'what does', 'no problem', 'as we', 'if you',
    'hello', 'okay', 'oh', 'yep', 'yes', 'hey', 'hi', 'yeah',
    'essentially', 'because', 'and', 'but', 'which', 'so',
    'where', 'what', 'now', 'or', 'how', 'after',
  ]);
  const _ASR_SKIP_WORDS = new Set(['uh']);
  const _ASR_END_WORDS = ['in', 'is', 'and', 'are', 'not', 'an', 'a', 'some', 'the',
    'but', 'our', 'for', 'of', 'if', 'his', 'her', 'my', 'noticed', 'come',
    'mean', 'why', 'this', 'has', 'make', 'gpt', 'p.m', 'a.m'];
  const _ASR_START_WORDS = ['or', 'to', 'in', 'has', 'of', 'are', 'is', 'lines',
    'with', 'days', 'years', 'tokens'];
  const _ASR_BREAK_MINI_TIME = 300;
  const _ASR_MIN_INTERVAL = 1000;       // gap < 此值視為同句
  const _ASR_MIN_WORD_LENGTH = 3;       // 短句吞併:條數 ≤ 此值才考慮合到前句
  const _ASR_SENTENCE_MIN_WORD = 20;    // 合句總條數上限(吞併用)
  const _ASR_MAX_WORDS = 30;            // Ile 合併後 word 上限

  function _heuristicMergeAsr(rawSegments) {
    if (!rawSegments?.length) return [];

    // 統一格式:每條包 utf8 / tStartMs / isBreak / 原始 ref(供組裝結果用)
    const events = rawSegments.map(s => ({
      utf8: s.text,
      tStartMs: s.startMs,
      isBreak: false,
      _src: s,
    }));

    // ─── kle: 初切 ──────────────────────────
    function kle(evs) {
      if (!evs.length) return [];
      let baseMs = evs[0].tStartMs;
      const out = [];
      let cur = [];
      const pushBreak = (lead, group) => { baseMs = lead.tStartMs; out.push(cur); cur = group; group[0].isBreak = true; };
      for (let i = 0; i < evs.length; i++) {
        const c = evs[i];
        const next = evs[i + 1];
        const m = c.tStartMs - baseMs;
        const cTrim = c.utf8.trim().toLowerCase();
        if (_ASR_BREAK_WORDS.has(cTrim) && m > _ASR_BREAK_MINI_TIME) {
          pushBreak(c, [c]); continue;
        }
        if (next && _ASR_BREAK_WORDS.has((c.utf8 + next.utf8).trim().toLowerCase()) && m > _ASR_BREAK_MINI_TIME) {
          pushBreak(c, [c, next]); i++; continue;
        }
        if (_ASR_SKIP_WORDS.has(cTrim) && next) {
          baseMs = next.tStartMs; cur.push(next); i++; continue;
        }
        if (m <= _ASR_MIN_INTERVAL) {
          baseMs = c.tStartMs; cur.push(c); continue;
        }
        out.push(cur); cur = [c]; baseMs = c.tStartMs;
      }
      if (cur.length) out.push(cur);
      return out.filter(g => g.length > 0);
    }

    // ─── Ile: 合併(上群結尾命中 endWords 或下群開頭命中 startWords + 時間近)──
    function Ile(groups) {
      if (groups.length <= 1) return groups;
      const startRe = new RegExp(`^\\s*(${_ASR_START_WORDS.join('|')})$`, 'i');
      const endRe = new RegExp(`\\b(${_ASR_END_WORDS.join('|')})\\s*$`, 'i');
      const result = [groups[0]];
      for (let u = 0; u < groups.length - 1; u++) {
        const cur = result[result.length - 1];
        const last = groups[u][groups[u].length - 1];
        const nextFirst = groups[u + 1][0];
        const gap = nextFirst.tStartMs - last.tStartMs;
        const matched = nextFirst.utf8.match(startRe) || last.utf8.match(endRe);
        if (matched && !nextFirst.isBreak && gap <= _ASR_MIN_INTERVAL) {
          const wordCount = [...cur, ...groups[u + 1]].map(e => e.utf8).join('').split(/\s+/).filter(Boolean).length;
          if (wordCount <= _ASR_MAX_WORDS) {
            cur.push(...groups[u + 1]);
            continue;
          }
        }
        result.push(groups[u + 1]);
      }
      return result;
    }

    // ─── Lle: 短句吞併(從尾到頭,小群組合到前一群) ────
    function Lle(groups) {
      const out = [...groups];
      for (let a = out.length - 1; a > 0; a--) {
        const o = out[a];
        const s = out[a - 1];
        if (o.length <= 0 || o.length > _ASR_MIN_WORD_LENGTH) continue;
        if (o.length + s.length >= _ASR_SENTENCE_MIN_WORD) continue;
        if (o[0].tStartMs - s[s.length - 1].tStartMs > _ASR_MIN_INTERVAL) continue;
        if (o[0].isBreak) continue;
        s.push(...o);
        out.splice(a, 1);
      }
      return out;
    }

    const split    = kle(events);
    const merged   = Ile(split);
    const compact  = Lle(merged);

    return compact.map((group, idx) => {
      const text = group.map(e => e.utf8).join('').replace(/\n/g, ' ').trim();
      const startMs = group[0].tStartMs;
      const next = compact[idx + 1];
      const endMs = next ? next[0].tStartMs : group[group.length - 1].tStartMs + SK.ASR_LAST_CUE_FALLBACK_MS;
      return {
        startMs,
        endMs,
        text,
        sourceSegs: group.map(e => e._src),
      };
    }).filter(s => s.text.length > 0);
  }

  // 暴露給 spec 端用(只對自家 spec 開放,不影響 production behaviour)
  SK._heuristicMergeAsr = _heuristicMergeAsr;

  // ─── Caption track 自動選擇（目標語原生 → en manual → en ASR) ─────────
  //
  // 目的：YouTube 帳號 auto-translate caption 偏好被套用到所有影片時，Shinkansen 拿到的
  //       不是原始 ASR，而是 YT 已自翻譯後的字幕文字。靠 `/api/timedtext` URL `lang` 參數
  //       也認不出來（URL `lang=en` + `tlang=zh-Hans`,Shinkansen 認 en 但 body 是 zh-Hans）。
  //
  // 三優先序（taken from caption track metadata, not text content):
  //   1) target lang 原生 track（任 kind,zh-TW target → zh-TW / zh-Hant / zh-HK)
  //      → activeTrack 已是該 native 軌(同 kind 且沒 translation)→ action='skip'
  //         (YT 已在顯示原生中文,Shinkansen 不必動)
  //      → activeTrack 不是該 native 軌(常見:影片同時有 native EN + native zh-Hant,
  //         YT 帳號預設顯示 EN)→ action='switch-to-native' 主動切到 native 軌
  //         單語:caller 切完 stopYouTubeTranslation(讓 YT 顯示原生中文)
  //         雙語:caller 切完不 stop(留 Shinkansen 監聽,使用者後續手動切到非 target
  //              軌時自動翻譯;_applyBilingualMode 在 captionLang=target 時不藏 native CC)
  //   1.5) 模糊 base-lang 原生候選(zh-TW / zh-CN target 的 `zh` 軌,手動優先於 ASR)
  //      → activeTrack 已是該軌(同 kind 無 translation)→ action='noop'(下游內容偵測接手)
  //      → 否則 action='switch'(非 switch-to-native:繁簡未定,不可盲目 stop,
  //         切軌後由 _shouldSkipBecauseAlreadyInTarget 內容偵測決定 skip 或翻譯)
  //   2) 影片原始語 manual track（kind=''，creator-uploaded）→ action='switch'
  //   3) 影片原始語 ASR track（kind='asr'）→ action='switch'
  //   都沒命中 / activeTrack 已對得上目標 → action='noop'，留 YT 既有行為
  //
  // 影片原始語從 captionTracks 中找出唯一 kind='asr' 的 track 的 languageCode 動態決定
  // （YouTube 一支影片只會自動產生一條 ASR，語言對應原始口說語）。沒 ASR 軌（罕見：
  // 創作者只上手動字幕沒讓 YT 跑 ASR）→ 無法可靠決定 sourceLang → noop。
  //
  // Pure function：單純看 tracks + activeTrack + targetLanguage，不 mutate STATE、不 dispatch。
  // 副作用由 _runCaptionTrackChooser 包裹 + activate flow 決定。
  // 回傳的 sourceLanguage 給 caller 傳遞給 background ASR prompt {sourceLanguage} placeholder 用。
  const _TARGET_NATIVE_LANGS = {
    'zh-TW': ['zh-TW', 'zh-Hant', 'zh-HK'],
    'zh-CN': ['zh-CN', 'zh-Hans'],
    'en':    ['en', 'en-US', 'en-GB'],
    'ja':    ['ja', 'ja-JP'],
    'ko':    ['ko', 'ko-KR'],
    'es':    ['es', 'es-ES', 'es-MX'],
    'fr':    ['fr', 'fr-FR', 'fr-CA'],
    'de':    ['de', 'de-DE'],
  };

  // 模糊 base-lang:URL / track metadata 不足以分辨繁簡(YouTube 對部分人工字幕只標
  // base lang `zh`,不附 -Hant / -Hans variant),target=zh-TW / zh-CN 時必須看字幕
  // 內容才能決定要不要 skip。其他 target(en / ja / ko / es / fr / de)沒有此類歧義。
  // 共用於兩處(單一資料源,避免 drift):
  //   1) chooser P1.5:`zh` 軌視為「可能原生」候選 → action='switch' 切過去,
  //      讓下游內容偵測決定 skip 或翻譯
  //   2) _shouldSkipBecauseAlreadyInTarget:captionLang=`zh` 時抽字幕內容補判
  const _AMBIGUOUS_LANGS_BY_TARGET = {
    'zh-TW': new Set(['zh']),
    'zh-CN': new Set(['zh']),
  };

  function _resolveTargetNativeLangs(targetLanguage) {
    return _TARGET_NATIVE_LANGS[targetLanguage] || [targetLanguage];
  }

  // tracks: [{ languageCode, kind: '' | 'asr', isTranslatable?, vssId?, name? }]
  // activeTrack: { languageCode, kind, translationLanguageCode } | null
  // targetLanguage: 'zh-TW' / 'zh-CN' / 'en' / ...
  // 回傳： { action: 'skip' | 'switch' | 'switch-to-native' | 'noop', track?: <選中的 track>, reason }
  function _chooseBestCaptionTrack(tracks, activeTrack, targetLanguage) {
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return { action: 'noop', reason: 'no-tracks' };
    }
    const targetLangs = _resolveTargetNativeLangs(targetLanguage);

    // P1: target lang 原生 track（任 kind)。不分單語/雙語都優先切到 native target;
    // bilingualMode 下使用者後續手動切到非 target 軌時 Shinkansen 才接管翻譯+overlay。
    const p1 = tracks.find(t => targetLangs.includes(t.languageCode));
    if (p1) {
      const activeIsP1 = activeTrack
        && activeTrack.languageCode === p1.languageCode
        && (activeTrack.kind || '') === (p1.kind || '')
        && !activeTrack.translationLanguageCode;
      if (activeIsP1) {
        return { action: 'skip', track: p1, reason: 'p1-active-already-native' };
      }
      return { action: 'switch-to-native', track: p1, reason: 'p1-switch-to-native' };
    }

    // P1.5: 模糊 base-lang 原生候選(zh-TW / zh-CN target 的 `zh` 軌,手動優先於 ASR)。
    // metadata 分不出繁簡,不能走 'switch-to-native'(單語 caller 會盲目 stop,若軌
    // 實際是簡中就留一版沒翻的簡中);改回 'switch' 切過去,由下游
    // _shouldSkipBecauseAlreadyInTarget 抽字幕內容補判:已是 target → skip 顯示原生,
    // 不是(如簡中對 zh-TW)→ 照常翻譯。
    // 位置在 ASR 推導之前:有 `zh` 軌時優先用它(創作者人工中文字幕品質高於
    // 「切到源語 ASR 再 LLM 翻譯」,且省 token);也涵蓋「只有一條 `zh` 手動軌、
    // 沒 ASR 軌」的影片(否則 no-source-asr-track noop,YT 帳號 auto-translate
    // 偏好會讓字幕停在英文自翻軌,Shinkansen 再把英文翻回中文)。
    const ambigSet = _AMBIGUOUS_LANGS_BY_TARGET[targetLanguage];
    if (ambigSet) {
      const p1b = tracks.find(t => ambigSet.has(t.languageCode) && (!t.kind || t.kind === ''))
               || tracks.find(t => ambigSet.has(t.languageCode));
      if (p1b) {
        const activeIsP1b = activeTrack
          && activeTrack.languageCode === p1b.languageCode
          && (activeTrack.kind || '') === (p1b.kind || '')
          && !activeTrack.translationLanguageCode;
        if (activeIsP1b) {
          return { action: 'noop', track: p1b, sourceLanguage: p1b.languageCode, reason: 'p1b-ambiguous-native-active' };
        }
        return { action: 'switch', track: p1b, sourceLanguage: p1b.languageCode, reason: 'p1b-ambiguous-native' };
      }
    }

    // 從唯一 ASR track 動態推導影片原始語（一支影片 YT 只會產一條 ASR）
    const asrTrack = tracks.find(t => t.kind === 'asr');
    if (!asrTrack) {
      // 沒 ASR 軌 → 無法可靠決定 sourceLang（rare：創作者只上手動字幕）→ noop
      return { action: 'noop', reason: 'no-source-asr-track' };
    }
    const sourceLang = asrTrack.languageCode;

    // P2: 原始語 manual track（creator-uploaded，品質高過 ASR）
    const p2 = tracks.find(t => t.languageCode === sourceLang && (!t.kind || t.kind === ''));
    const desired = p2 || asrTrack;

    // 當前 active track 已是目標 track 且沒被自翻譯 → 不必再切
    const alreadyOnTarget = activeTrack
      && activeTrack.languageCode === desired.languageCode
      && (activeTrack.kind || '') === (desired.kind || '')
      && !activeTrack.translationLanguageCode;
    if (alreadyOnTarget) {
      return { action: 'noop', track: desired, sourceLanguage: sourceLang, reason: 'already-on-target' };
    }

    return {
      action: 'switch',
      track: desired,
      sourceLanguage: sourceLang,
      reason: p2 ? 'p2-source-manual' : 'p3-source-asr',
    };
  }

  SK._chooseBestCaptionTrack = _chooseBestCaptionTrack;

  // 包裹 pure function 的 side-effectful wrapper:dispatch 兩條 bridge event,
  // 處理 retry / timeout，在 'switch' / 'switch-to-native' 命中時實際呼叫 setOption。
  // 回傳：'skip' / 'switch' / 'switch-to-native' / 'noop'（由 caller 決定接續行為）。
  async function _runCaptionTrackChooser(targetLanguage) {
    // Step 1:query player response bridge 拿 tracks + activeTrack
    const detail = await bridgeRequest('shinkansen-yt-query-player-response', 'shinkansen-yt-player-response', null, 1500);
    if (!detail || !detail.playerResponseAvailable) {
      SK.sendLog('debug', 'youtube', 'chooser: bridge query failed / no player response', {});
      return 'noop';
    }
    const currentVideoId = getVideoIdFromUrl();
    if (detail.videoId && currentVideoId && detail.videoId !== currentVideoId) {
      SK.sendLog('debug', 'youtube', 'chooser: videoId mismatch (stale)', { bridge: detail.videoId, url: currentVideoId });
      return 'noop';
    }

    // Step 2：跑 pure function
    const decision = _chooseBestCaptionTrack(detail.captionTracks, detail.activeTrack, targetLanguage);
    SK.sendLog('info', 'youtube', 'caption track chooser', {
      action:         decision.action,
      reason:         decision.reason,
      pickedLang:     decision.track?.languageCode,
      pickedKind:     decision.track?.kind,
      activeLang:     detail.activeTrack?.languageCode,
      activeKind:     detail.activeTrack?.kind,
      activeTransLang:detail.activeTrack?.translationLanguageCode,
      targetLanguage,
      trackCount:     detail.captionTracks?.length || 0,
    });

    // Step 3:'switch' 或 'switch-to-native' 命中 → dispatch setOption bridge + 等回應
    if (decision.action === 'switch' || decision.action === 'switch-to-native') {
      await bridgeRequest('shinkansen-yt-set-caption-track', 'shinkansen-yt-set-caption-track-result', {
        languageCode: decision.track.languageCode,
        kind: decision.track.kind || '',
      }, 1000);
    }

    return decision.action;
  }

  SK._runCaptionTrackChooser = _runCaptionTrackChooser;

  // ─── ASR overlay 字幕容器(G 路徑) ─────────────────────────
  //
  // 為什麼:ASR 字幕在 YouTube 原生 DOM 是「rolling captions」,每秒 append 1-3 個
  //         `.ytp-caption-segment`,我們若在 segment 上 textContent 替換中文,就會
  //         隨原生 DOM 變動而閃爍跳動。
  // 解法:完全旁路原生 caption-segment,在 #movie_player 上 overlay 自家容器,
  //       用 video.timeupdate 驅動,根據 currentTime 找出當前 active cue 整句寫入。
  //       整句進整句出,中段不變動。
  //
  // DOM:custom element <shinkansen-yt-overlay> + Shadow DOM 隔離 CSS。
  //
  // displayCues 寫入時機:
  //   - heuristic 路徑:_runAsrHeuristicWindow 翻完一批就 push
  //   - LLM 路徑:_runAsrSubBatch 翻完一批就 push
  //   - progressive 模式:後寫覆蓋前寫(同 startMs 用 dedup map)

  const _OVERLAY_TAG = 'shinkansen-yt-overlay';

  function _getPlayerRoot() {
    return document.querySelector('#movie_player')
        || document.querySelector('.html5-video-player')
        || null;
  }

  function _ensureOverlay() {
    const root = _getPlayerRoot();
    if (!root) return null;
    let host = root.querySelector(_OVERLAY_TAG);
    if (host && host.shadowRoot) return host;
    if (!host) {
      host = document.createElement(_OVERLAY_TAG);
      // host 撐滿 player container,作為「畫布」;真正的字幕視窗用內部 .window 控位置
      Object.assign(host.style, {
        position: 'absolute',
        inset: '0',                 // top/right/bottom/left 都 0
        zIndex: '60',               // 高於原生 ytp-caption-window
        pointerEvents: 'none',
        display: 'none',
      });
      root.appendChild(host);
    }
    if (!host.shadowRoot) {
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          :host {
            font-family: var(--sk-cue-font-family,
              "PingFang TC", "Microsoft JhengHei", "微軟正黑體",
              "Heiti TC", "Noto Sans CJK TC", sans-serif);
          }
          /* .window:絕對定位的字幕視窗,水平居中於 player,垂直 bottom 由 CSS variable 控制
             (chrome 顯示時上移避開控制列,見全域 CSS 規則 .html5-video-player:not(.ytp-autohide) ...) */
          .window {
            position: absolute;
            bottom: var(--sk-cue-bottom, 30px);
            transition: bottom 0.25s ease;
            left: 0;
            right: 0;
            display: flex;
            flex-direction: column;
            align-items: center;        /* horizontal center 內部 cue rows */
            gap: 4px;
            padding: 0 24px;
            box-sizing: border-box;
          }
          /* v1.8.42:cue-block 是 .src + .tgt 的共用容器,黑底 background 改放這層,
             讓 non-ASR 雙語下英文 + 中文兩行**共用同一塊黑底**(原本 .src/.tgt 各自
             inline-block + 各自 background → 兩塊分開的視覺汙染)。
             ASR 雙語下 .src 仍 hidden,cue-block 內只有 .tgt → 黑底範圍剛好包 .tgt,
             視覺跟舊版一致 */
          .cue-block {
            display: inline-block;
            max-width: 100%;
            padding: 0.05em 0.3em;
            background: rgba(0, 0, 0, 0.75);   /* 對齊 YouTube 原生 */
            color: #fff;
            border-radius: 3px;
            text-align: center;
            box-sizing: border-box;
          }
          .src, .tgt {
            display: block;
            font-size: var(--sk-cue-size, 18px);
            font-style: var(--sk-cue-font-style, normal);
            font-weight: var(--sk-cue-font-weight, normal);
            white-space: pre-wrap;
          }
          /* v1.8.42:.src 內 <br> 換行(2 行原文)用 1.05 緊縮行距,避免英文兩行間隙過寬;
             .tgt 中文 1.45 易讀;.src 跟 .tgt 之間的間距由 block 元素自然 baseline 決定 */
          .src { line-height: 0.95; }
          .tgt { line-height: 1.45; }
          .src[hidden], .tgt:empty { display: none; }
        </style>
        <div class="window">
          <div class="cue-block">
            <span class="src" hidden></span>
            <span class="tgt"></span>
          </div>
        </div>
      `;
    }
    return host;
  }

  // 譯文過長時依標點拆行(LLM 自由分句可能合很長,例如 50+ 字一句)
  // 邏輯:
  //   - 切點門檻動態計算:目標一行視覺寬約 video 寬 50%(clamp [12, 25] 字)
  //     公式:videoWidth × 0.5 / (fontSize × 0.8)  ← 中英混合平均字寬 ≈ fontSize × 0.8
  //   - 字數 ≤ 切點門檻 → 不拆
  //   - 先從 idx=門檻 往前找最近標點(讓首行 ≤ 門檻)
  //   - 找不到 → 從 idx=門檻+1 往後找最近標點(允許首行稍長,優先依標點切)
  //   - 完全沒標點 → 不拆(讓 CSS max-width 自動 word-wrap)
  //   - 標點集合:中文 ,。;:!?、 / 半形 ,;:!?
  //   - 多行遞迴處理(超長譯文最多 3-4 行)
  // 用 unicode escape 確保字符集純淨,避免肉眼看不見的 hidden char(空格 / ZWSP 等)混入
  // 對應:半形 , . : ; ! ?(0x21-0x3F)+ 全形 , . : ; ! ?(0xFF01-0xFF1F)+ 、 。(0x3001-0x3002)
  const _ASR_PUNCT_RE = /[\u002C\u002E\u003A\u003B\u0021\u003F\uFF0C\uFF0E\uFF1A\uFF1B\uFF01\uFF1F\u3001\u3002]/;

  // v2.0.63(症狀:「Union Chapel」被硬切成「…倫敦 Un」+「ion Chapel…」兩條 cue):
  // 拉丁字母／數字的連續 run 是不可分割 token,切點不可落在 run 內部,CJK 逐字可切
  // 不受影響。字元集:A-Za-z0-9 + U+00C0-024F(Latin-1 Supplement / Extended-A/B
  // 補充字母,café、naïve)+ 直撇號 U+0027 + 彎撇號 U+2019(don't 兩種寫法)
  const _ASR_WORD_CHAR_RE = /[A-Za-z0-9À-ɏ'’]/;

  // t[i] 是否屬於 word token:字母數字本身,或夾在字母數字之間的 . / -
  // (GPT-4、3.5、U.S. 整串視為同一 token)
  function _isWordCharAt(t, i) {
    const c = t[i];
    if (c == null) return false;
    if (_ASR_WORD_CHAR_RE.test(c)) return true;
    return /[.\-]/.test(c) &&
      /[A-Za-z0-9]/.test(t[i - 1] || '') && /[A-Za-z0-9]/.test(t[i + 1] || '');
  }

  // 切點 cut 落在拉丁 word run 內時吸附到 run 較近一側邊緣。
  // lo/hi:cut 的合法開區間(lo < cut < hi);run 佔滿整個合法區間時維持原切點
  // (寧可切也不要不拆——與硬切 fallback 同哲學,避免超長不折沖出畫面)。
  function _snapCutOutOfWord(t, cut, lo, hi) {
    if (cut <= lo || cut >= hi) return cut;
    if (!_isWordCharAt(t, cut - 1) || !_isWordCharAt(t, cut)) return cut;
    let s = cut;
    while (s > 0 && _isWordCharAt(t, s - 1)) s--;
    let e = cut;
    while (e < t.length && _isWordCharAt(t, e)) e++;
    const sOk = s > lo;
    const eOk = e < hi;
    if (sOk && eOk) return (cut - s <= e - cut) ? s : e;
    if (sOk) return s;
    if (eOk) return e;
    return cut;
  }
  SK._snapCutOutOfWord = _snapCutOutOfWord;   // regression spec 直接驅動用

  // 「句間標點」判定:半形 , . : 夾在字母數字之間時是小數點／縮寫／千分位
  // (3.5、9,999、p.m.),屬 token 內部,不可當切點候選
  function _isSentencePunctAt(t, i) {
    if (!_ASR_PUNCT_RE.test(t[i])) return false;
    if (/[,.:]/.test(t[i]) &&
        /[A-Za-z0-9]/.test(t[i - 1] || '') && /[A-Za-z0-9]/.test(t[i + 1] || '')) return false;
    return true;
  }

  function _calcMaxLineChars() {
    const video = document.querySelector('video');
    const fontSize = _readNativeCaptionFontSize() || 18;
    const videoWidth = (video && video.offsetWidth) || 800;
    // 中文字寬 ≈ fontSize(全形),英文字寬 ≈ fontSize × 0.55,中英混合平均 ≈ ×0.8
    const avgCharWidth = fontSize * 0.8;
    // 目標單行視覺寬度約 video 寬 70%(留 30% 給左右邊距)
    const targetWidth = videoWidth * 0.7;
    return Math.max(15, Math.min(35, Math.round(targetWidth / avgCharWidth)));
  }

  function _wrapTargetText(text) {
    const maxLine = _calcMaxLineChars();
    if (!text || text.length <= maxLine) return text;
    const lines = [];
    let rest = String(text);
    while (rest.length > maxLine) {
      let cutIdx = -1;
      // 1. 從門檻往前找最近標點(讓首行 ≤ 門檻)
      for (let i = Math.min(rest.length - 2, maxLine); i >= 1; i--) {
        if (_isSentencePunctAt(rest, i)) { cutIdx = i + 1; break; }
      }
      // 2. 找不到 → 從門檻+1 往後找最近標點(允許首行稍長)
      if (cutIdx < 0) {
        for (let i = maxLine + 1; i < rest.length - 1; i++) {
          if (_isSentencePunctAt(rest, i)) { cutIdx = i + 1; break; }
        }
      }
      // 3. 全句沒標點 → 按 maxLine 硬切(不依賴 CSS wrap,確保視覺絕對折行)
      if (cutIdx < 0) cutIdx = maxLine;
      // v2.0.63:折行點落在拉丁單字／數字 run 內時吸附到 run 邊緣(Union 不折成 Un|ion)
      cutIdx = _snapCutOutOfWord(rest, cutIdx, 0, rest.length);
      lines.push(rest.slice(0, cutIdx).trim());
      rest = rest.slice(cutIdx).trim();
    }
    if (rest) lines.push(rest);
    return lines.join('\n');
  }

  function _escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 寫譯文進原生 .ytp-caption-segment(非 ASR 路徑共用)。
  // 譯文中文化後常比英文原文長 1.3-1.8 倍,YouTube 原生 caption-window 視覺寬度
  // 不夠時 expandCaptionLine 會把外層 max-content 撐開但同時 segment 設 nowrap,
  // 導致中文長句沖出畫面。比照 ASR overlay 改用 _wrapTargetText 計算切點 + <br> 注入。
  // el → 我們最後注入的可見文字(el.textContent 快照)。replaceSegmentEl 用來判斷
  // 「這次 characterData 回呼是不是自己注入觸發的」——取代舊的 RE_CJK 字元集猜測
  // (那會誤殺 ja/ko 源語的原文：單語模式譯文永遠注入不進去但 API 照燒；target=en
  // 時注入的英文根本不含 CJK，防自我迴圈也完全失效)
  const _injectedSegmentText = new WeakMap();

  function _setSegmentText(el, text) {
    const str = text == null ? '' : String(text);
    if (!str) {
      if (el.textContent !== '') el.textContent = '';
      _injectedSegmentText.set(el, '');
      return;
    }
    const wrapped = _wrapTargetText(str);
    if (wrapped.indexOf('\n') >= 0) {
      // 有切點:用 innerHTML + <br>(textContent 走不出 <br>,設 \n 也會被
      // YouTube 既有 white-space: nowrap 吞掉)。先 escape 防 XSS。
      const html = _escapeHtml(wrapped).replace(/\n/g, '<br>');
      // AMO source review: html = _escapeHtml(text) + 自家加入的 <br>。原文已 escape,
      // <br> 是 dev 自己控的 literal,無 user input 流入。
      if (el.innerHTML !== html) el.innerHTML = html;
    } else {
      if (el.textContent !== wrapped) el.textContent = wrapped;
    }
    // 套用使用者「字幕大小」scale 到原生 segment（內建字幕單語 path 也吃旋鈕,scale=100 不碰）
    _applyScaleToSegment(el);
    _injectedSegmentText.set(el, el.textContent);
  }

  // 暴露給 spec 用
  SK._setSegmentText = _setSegmentText;

  function _setOverlayContent(targetText, sourceText) {
    const host = _ensureOverlay();
    if (!host || !host.shadowRoot) return;
    // v1.9.22:子元素被外部清掉時(過去 _resetTranslationStateForCacheClear bug 會把
    // .window.textContent='' 砍掉所有子元素),tgtEl 會是 null。重建 .cue-block 結構讓
    // 後續邏輯能繼續走,不直接 throw TypeError。
    let tgtEl = host.shadowRoot.querySelector('.tgt');
    let srcEl = host.shadowRoot.querySelector('.src');
    if (!tgtEl) {
      const win = host.shadowRoot.querySelector('.window');
      if (!win) return; // 整個 .window 都沒了 → 放棄此次寫入
      win.innerHTML = '<div class="cue-block"><span class="src" hidden></span><span class="tgt"></span></div>';
      tgtEl = host.shadowRoot.querySelector('.tgt');
      srcEl = host.shadowRoot.querySelector('.src');
      if (!tgtEl) return; // 還是失敗就放棄(不該發生)
    }
    if (!targetText) {
      if (tgtEl.innerHTML !== '') tgtEl.innerHTML = '';
      if (srcEl) {
        if (srcEl.innerHTML !== '') srcEl.innerHTML = '';
        srcEl.hidden = true;
      }
      host.style.display = 'none';
      return;
    }
    const wrapped = _wrapTargetText(targetText);
    // 用 innerHTML + <br> 寫入(比 textContent + \n + white-space:pre-wrap 更穩定,
    // 不受 inline-block 的 wrap 行為差異影響)。先 escape HTML 字元防注入。
    const html = _escapeHtml(wrapped).replace(/\n/g, '<br>');
    // AMO source review: html = _escapeHtml(text) + 自家 <br>,user input 已 escape。
    if (tgtEl.innerHTML !== html) tgtEl.innerHTML = html;
    // v1.8.42:有傳 sourceText 就顯示原文(non-ASR 雙語把 native CC 藏起來,中英
    //         都搬到 overlay 同一塊;ASR 雙語不傳 sourceText,native CC 仍可見不重複)
    if (srcEl) {
      if (sourceText) {
        const srcHtml = _escapeHtml(String(sourceText)).replace(/\n/g, '<br>');
        if (srcEl.innerHTML !== srcHtml) srcEl.innerHTML = srcHtml;
        srcEl.hidden = false;
      } else {
        if (srcEl.innerHTML !== '') srcEl.innerHTML = '';
        srcEl.hidden = true;
      }
    }
    host.style.display = 'block';
  }

  // 暴露給 spec 用
  SK._wrapTargetTextForOverlay = _wrapTargetText;
  SK._setOverlayContent = _setOverlayContent;
  SK._splitAsrSubBatches = (windowSegs, videoNowMs, windowStartMs, playbackRate) =>
    _splitAsrSubBatches(windowSegs, videoNowMs, windowStartMs, playbackRate);

  // v1.8.42:non-ASR 雙語模式 overlay 同步 helper。收集當前 visible
  // .ytp-caption-segment 對應的譯文,join 後寫到獨立 overlay,並動態量測
  // native .caption-window 的 top,把 overlay --sk-cue-bottom 設為
  // (playerBottom - cwTop + gap)。讓中文永遠貼在英文 CC 整 block 上方,
  // 不論英文 1 行 / 2 行 / 多行都不會撞。caption mutation 與 bilingual
  // toggle 進入時呼叫;ASR / 純中文模式 short-circuit。
  function _updateNonAsrBilingualOverlay() {
    const YT = SK.YT;
    if (!YT.active || YT.isAsr) return;
    if (YT.config?.bilingualMode !== true) return;

    // 收集 visible segment 譯文 + 對應原文。multi-segment 字幕(2 行原文)在
    // captionMap 走 dedup:第一個 segment 存合併譯文,後續 segment 存空字串
    // (見 translateWindowFrom 的 covered[0]=trans, covered[k>=1]='')。
    // 所以 srcBits 一律收英文(不論 cached 是否空字串),保留 visible 行;
    // transBits 只收非空 cached(自動 dedup,避免一個合併譯文重複 N 次)。
    const segs = document.querySelectorAll('.ytp-caption-segment');
    const transBits = [];
    const srcBits = [];
    for (const seg of segs) {
      const txt = (seg.textContent || '').trim();
      if (!txt) continue;
      // 不能用 RE_CJK 過濾源文 — 那會誤殺 ja / ko / zh-Hans / 俄等非 zh-TW 但含 CJK chars 的源語。
      // 「我們自己注入的 zh-TW 譯文」這個 case(toggle bilingual off→on 殘留)由
      // captionMap lookup 自然處理:注入的 zh 文本 normText 不會 match 任何 captionMap key
      // (key 是原文 normText)→ cached===undefined → continue,自動排除。
      const cached = YT.captionMap.get(normText(txt));
      // 只在 captionMap 已知此 key(命中 - 不論 cached 為空或譯文)才把源文搬上 overlay,
      // 避免把「尚未翻譯」的 segment 推上 overlay 造成只有源文沒譯文的閃爍
      if (cached === undefined) continue;
      srcBits.push(txt);
      if (cached) transBits.push(cached);
    }
    const joinedTrans = transBits.join('\n');
    const joinedSrc = srcBits.join('\n');
    // v1.8.42:把英文原文也送進 overlay .src(native CC 藏起來,中英並存於 overlay
    //         同一個 wrapper,視覺上只剩一塊黑底,不再有「原生英文 1+2 行 + 中文」三塊)
    _setOverlayContent(joinedTrans, joinedSrc);

    const host = document.querySelector(_OVERLAY_TAG);
    if (!host) return;

    // v1.8.42:字型大小 / family / style 同步到 native CC,讓中文跟英文視覺對齊
    //         (ASR 路徑 _updateOverlay 已做這件事;non-ASR 雙語也要做,否則
    //         中文用預設 18px,英文用 native 36px,大小差好幾倍)
    const nativeFz = _readNativeCaptionFontSize();
    if (nativeFz) host.style.setProperty('--sk-cue-size', _scaledCueSizePx(nativeFz) + 'px');
    const nativeFf = _readNativeCaptionFontFamily();
    if (nativeFf) host.style.setProperty('--sk-cue-font-family', nativeFf);
    // native CC 的 font-style(italic / normal)— 旁白等敘述字幕常用 italic,
    // 中文跟著 italic 視覺較一致;讀第一個 caption-segment 的 computed style
    const seg = document.querySelector('.ytp-caption-segment');
    if (seg) {
      const cs = getComputedStyle(seg);
      if (cs.fontStyle) host.style.setProperty('--sk-cue-font-style', cs.fontStyle);
      if (cs.fontWeight) host.style.setProperty('--sk-cue-font-weight', cs.fontWeight);
    }

    _updateOverlayAnchor();
  }
  SK._updateNonAsrBilingualOverlay = _updateNonAsrBilingualOverlay;

  // v1.8.42:overlay 動態 anchor — 對齊原生 caption-window 的 bottom。native CC 已藏
  //         (visibility:hidden 不影響 layout),所以 cwBottom 仍能讀到正確位置;
  //         controls 顯示時 YouTube 自己會把 cw 上推,anchor 自動跟著走。
  //         ASR / non-ASR 雙語模式共用此 helper。
  function _updateOverlayAnchor() {
    const host = document.querySelector(_OVERLAY_TAG);
    if (!host) return;
    const player = _getPlayerRoot();
    const cw = document.querySelector('.caption-window');
    if (player && cw) {
      const playerRect = player.getBoundingClientRect();
      const cwRect = cw.getBoundingClientRect();
      if (playerRect.height > 0 && cwRect.height > 0) {
        const bottom = Math.max(0, Math.round(playerRect.bottom - cwRect.bottom));
        host.style.setProperty('--sk-cue-bottom', bottom + 'px');
        return;
      }
    }
    // 沒 caption-window → 清掉動態 anchor 讓 stylesheet fallback 接管(ASR 雙語走
    // host[bilingual] CSS rule 90px,純中文走 host CSS rule 30px)
    host.style.removeProperty('--sk-cue-bottom');
  }

  function _removeOverlay() {
    const root = _getPlayerRoot();
    if (!root) return;
    root.querySelectorAll(_OVERLAY_TAG).forEach(el => el.remove());
  }

  // 控制原生 YouTube 字幕的隱藏(ASR 模式專用)。
  // 由 player root 的 class 控制,讓 stop / SPA 移除 class 即可恢復原生顯示。
  // 用 class + 全域 style 而非 inline style:避免每個 caption-window 個別處理 mutation 競爭。
  const _ASR_PLAYER_CLASS = 'shinkansen-asr-active';
  const _ASR_HIDE_CSS_ID  = 'shinkansen-asr-hide-css';
  // CC 關閉(ccPaused)期間隱藏所有字幕殘留:
  //   - non-ASR 走原生 .caption-window,YouTube 隱藏 CC 後 element 仍可能殘留中文 textContent
  //   - ASR overlay 由 _updateOverlay 內的 ccPaused 分支自行清空,不靠這條 class
  // 用 visibility/opacity 而非 display:none:保留 layout 讓 _readNativeCaptionFontSize
  // 等讀取邏輯不會在 CC 重開時瞬間錯亂。
  const _CC_PAUSED_PLAYER_CLASS = 'shinkansen-cc-paused';
  // v1.8.16:stylesheet 注入從 _setAsrHidingMode 抽出獨立 helper,
  // bilingual=true 也走「不隱藏原生 CC + overlay 上抬 90px」的 CSS rule(host[bilingual]),
  // 這條 rule 必須跟 .ytp-autohide 規則同份 stylesheet 一起注入,reload 後直接進雙語
  // (從沒走過 active=true 分支)否則拿不到 90px 上抬,中英 CC 重疊在原生 30px 高度。
  function _ensureAsrStylesheet() {
    if (document.getElementById(_ASR_HIDE_CSS_ID)) return;
    const style = document.createElement('style');
    style.id = _ASR_HIDE_CSS_ID;
    // 用 visibility/opacity 隱藏(而非 display:none),保留 layout —— 我們需要讀
    // .ytp-caption-segment 的 computed font-size 當作 overlay 字體基準。
    // pointer-events:none 避免使用者誤點(雖然 absolute positioned 沒互動性)。
    style.textContent = `
      /* v1.8.53: 不對 .ytp-caption-window-container 自身設 visibility:hidden + opacity:0—
         我們自家的 #__sk-yt-caption-status append 在它內部,父層 opacity:0 會
         compound 到整個子樹的 visual rendering(opacity 不繼承,但 rendering 上
         child_visual_opacity = child × parent),導致 status 設 visibility:visible +
         opacity:1 仍看不到(getComputedStyle 看 child 自己的值,反映不出父層 fade)。
         改成只對真正要藏的子元素(.caption-window / .ytp-caption-window-rollup)個別設,
         container 本身只保留 pointer-events: none 防誤點。 */
      .${_ASR_PLAYER_CLASS} .ytp-caption-window-container,
      .${_CC_PAUSED_PLAYER_CLASS} .ytp-caption-window-container {
        pointer-events: none !important;
      }
      .${_ASR_PLAYER_CLASS} .caption-window,
      .${_ASR_PLAYER_CLASS} .ytp-caption-window-rollup,
      .${_ASR_PLAYER_CLASS} .ytp-caption-window-container .caption-window,
      .${_CC_PAUSED_PLAYER_CLASS} .caption-window,
      .${_CC_PAUSED_PLAYER_CLASS} .ytp-caption-window-rollup,
      .${_CC_PAUSED_PLAYER_CLASS} .ytp-caption-window-container .caption-window {
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
      /* 控制列(chrome)顯示時讓 overlay 上移避開進度條:
         YouTube 在 chrome 隱藏時加 .ytp-autohide 到 .html5-video-player,顯示時移除。
         :not(.ytp-autohide) 命中代表 chrome 顯示中,把 CSS variable 推給 host element,
         shadow DOM 內 .window 透過 var() 自動繼承 → bottom 從預設 30px 改為 60px。 */
      .html5-video-player:not(.ytp-autohide) ${_OVERLAY_TAG} {
        --sk-cue-bottom: calc(60px + var(--sk-cue-size, 22px));
      }
      /* commit 5c.6:雙語模式(host[bilingual] attr)overlay 從預設 30px 推到 90px
         避開原生英文 CC(原生 30-40px from bottom)。chrome 顯示時再多推一段
         避開控制列 + 已上抬的原生 CC(YouTube 自己把原生 CC 推到約 82px)。 */
      ${_OVERLAY_TAG}[bilingual] {
        --sk-cue-bottom: 90px;
      }
      .html5-video-player:not(.ytp-autohide) ${_OVERLAY_TAG}[bilingual] {
        --sk-cue-bottom: calc(140px + var(--sk-cue-size, 22px));
      }
    `;
    document.head.appendChild(style);
  }

  function _setAsrHidingMode(active) {
    const root = _getPlayerRoot();
    if (!root) return;
    _ensureAsrStylesheet();
    if (active) {
      root.classList.add(_ASR_PLAYER_CLASS);
    } else {
      root.classList.remove(_ASR_PLAYER_CLASS);
    }
  }

  // ccPaused 切換時加/移 class 到 player root,讓 stylesheet 隱藏原生 .caption-window
  // (含已被替換成中文的 textContent)。non-ASR / ASR / bilingual 三種模式共用此規則。
  function _setCcPausedHidingMode(active) {
    const root = _getPlayerRoot();
    if (!root) return;
    _ensureAsrStylesheet();
    if (active) {
      root.classList.add(_CC_PAUSED_PLAYER_CLASS);
    } else {
      root.classList.remove(_CC_PAUSED_PLAYER_CLASS);
    }
  }

  // commit 5c:統一切 bilingualMode 的副作用 — 字幕隱藏/顯示 + overlay 位置調整。
  // ASR 路徑:雙語不藏 native(中英並存)、純中文藏 native(由我們的 overlay 取代)。
  // non-ASR 路徑:不動 native CC(_setAsrHidingMode 對 non-ASR 純中文模式會把
  //              已被替換成中文的 segment 一起藏起來,所以 isAsr 才呼叫)。
  // v1.8.42:non-ASR 雙語也走獨立 overlay(過去把譯文 innerHTML <br> 接在 segment
  //         內,2 行英文時擠掉第二行)。bilingual=true 時建 overlay + 設 attr +
  //         呼叫 _updateNonAsrBilingualOverlay 立即同步;bilingual=false 退出時
  //         清 overlay 並對 visible segment 重跑 replaceSegmentEl 寫入中文。
  function _applyBilingualMode(bilingual) {
    // v1.8.42:四種組合的 native CC 藏/不藏 truth table
    //   ASR + 雙語     :藏(英文 + 中文都搬到 overlay 同一塊;ASR cue 已知 sourceText)
    //   ASR + 純中文   :藏(中文 overlay 取代)
    //   non-ASR + 雙語  :藏(英文 + 中文都搬到 overlay 同一塊)
    //   non-ASR + 純中文:不藏(native segment 內已被替換成中文)
    // 動態例外:caption 已是 target lang(skip-translate 路徑)→ overlay 不會有內容,
    //         強制不藏 native CC,避免整片空白(OHAjc-ayhus 類:全 manual + active=target + bilingual)
    const captionInTarget = _shouldSkipBecauseAlreadyInTarget();
    const shouldHideNative = (bilingual || SK.YT.isAsr) && !captionInTarget;
    _setAsrHidingMode(shouldHideNative);
    // 確保 host 存在(ASR 在 captionsXHR 已 _ensureOverlay 過,non-ASR 雙語進入這條路徑首次需要)
    if (bilingual) _ensureOverlay();
    // commit 5c.6:用 host attribute + CSS rule(_setAsrHidingMode 內注入的 stylesheet)
    // 控制 ASR 雙語 overlay 位置;non-ASR 雙語則靠 _updateNonAsrBilingualOverlay
    // 動態 inline style 覆蓋此固定值。
    const host = document.querySelector(_OVERLAY_TAG);
    if (host) {
      if (bilingual) {
        host.setAttribute('bilingual', 'true');
      } else {
        host.removeAttribute('bilingual');
      }
      // 清除 inline style override(避免擋住 attr CSS rule;non-ASR 動態 anchor 後續會重設)
      host.style.removeProperty('--sk-cue-bottom');
      // 退出雙語清掉 overlay 內容(避免最後一句中文卡在畫面上)
      if (!bilingual) _setOverlayContent('');
    }
    // commit 5c.3:即時切到雙語時把已顯示的「翻譯中…」清掉(雙語下這 status 不該存在)
    if (bilingual) hideCaptionStatus();

    // v1.8.42:non-ASR 雙語進入時 / live toggle 進入時,立即 sync overlay 一次
    // (current visible segment 的譯文寫到 overlay,不等下一次 caption mutation)
    if (bilingual && !SK.YT.isAsr && SK.YT.active) {
      _updateNonAsrBilingualOverlay();
    }
    // non-ASR 退出雙語回純中文:對 visible segment 重跑 replaceSegmentEl
    // (此時雙語=false,replaceSegmentEl 會走 _setSegmentText 把英文換成中文)。
    // _injectedSegmentText 比對確保已是我們注入譯文的不會被誤改。
    if (!bilingual && !SK.YT.isAsr && SK.YT.active) {
      document.querySelectorAll('.ytp-caption-segment').forEach((el) => {
        try { replaceSegmentEl(el); } catch (_) {}
      });
    }
  }
  // 暴露給 spec 用(youtube-bilingual-overlay 路徑 A regression)
  SK._applyBilingualMode = _applyBilingualMode;

  // 讀 YouTube 原生字幕字體大小(已套用使用者字幕設定 + player size 自適應比例)。
  // 多重 fallback:首選 caption-segment、退而 caption-window、再退「上次讀到的有效值」、
  // 最後才用 video 高度 4.5%。
  //
  // v1.10.26：人聲停止但影片繼續時 YouTube 把原生 .ytp-caption-segment / .caption-window
  //   從 DOM 移除（無字幕空窗），但我們的 ASR overlay 因「中文閱讀時間補償」延長 endMs
  //   還在顯示譯文。這段空窗期過去會掉到 video.offsetHeight × 0.045 啟發式——這個值約等於
  //   YouTube 預設 100% 字幕大小，完全忽略使用者的字幕大小設定（例：設 50% 的人會看到字
  //   突然跳成 ~100%＋）。結構性修法：原生字幕字體大小是「單一事實」，來源元素短暫消失時
  //   保留上次讀到的有效值，不用無視使用者設定的影片高度啟發式重算（CLAUDE.md §8）。
  let _lastGoodCaptionFontSize = 0;
  function _readNativeCaptionFontSize() {
    const seg = document.querySelector('.ytp-caption-segment');
    if (seg) {
      // 若該 segment 已被非 ASR 單語 path 套過字級 scale,inline 字級是「base × scale」,
      // 要讀回我們存的 YouTube 原始基準(dataset.skBaseFs)避免回授;沒套過才讀 computed。
      const baseAttr = seg.dataset ? parseFloat(seg.dataset.skBaseFs) : NaN;
      const fz = (Number.isFinite(baseAttr) && baseAttr > 0)
        ? baseAttr
        : parseFloat(getComputedStyle(seg).fontSize);
      if (Number.isFinite(fz) && fz > 0) { _lastGoodCaptionFontSize = fz; return fz; }
    }
    const win = document.querySelector('.caption-window');
    if (win) {
      const fz = parseFloat(getComputedStyle(win).fontSize);
      if (Number.isFinite(fz) && fz > 0) { _lastGoodCaptionFontSize = fz; return fz; }
    }
    // 空窗期:原生字幕元素暫時不在 DOM,沿用上次讀到的有效值(保住使用者字幕大小設定)
    if (_lastGoodCaptionFontSize > 0) return _lastGoodCaptionFontSize;
    // 從沒讀到過任何原生字幕(首次 fallback):才用 video 高度啟發式估一個
    const video = document.querySelector('video');
    if (video && video.offsetHeight) return Math.round(video.offsetHeight * 0.045);
    return 18;
  }
  // 暴露給 spec 用(youtube-caption-fontsize-gap 路徑 A regression)
  SK._readNativeCaptionFontSize = _readNativeCaptionFontSize;
  SK._resetCaptionFontSizeCache = () => { _lastGoodCaptionFontSize = 0; };

  // 讀 YouTube 原生字幕的 font-family(YouTube 用 inline style 設定,預設 sans-serif,
  // 走系統字型 → macOS=PingFang TC、Windows=Microsoft JhengHei、Linux=Noto Sans CJK TC)。
  // 使用者自訂(設定面板選 Monospace / Serif 等)也會被讀到。
  function _readNativeCaptionFontFamily() {
    const seg = document.querySelector('.ytp-caption-segment');
    if (seg) {
      const ff = getComputedStyle(seg).fontFamily;
      if (ff) return ff;
    }
    const win = document.querySelector('.caption-window');
    if (win) {
      const ff = getComputedStyle(win).fontFamily;
      if (ff) return ff;
    }
    return '"PingFang TC", "Microsoft JhengHei", "微軟正黑體", "Heiti TC", "Noto Sans CJK TC", sans-serif';
  }

  // displayCues 找當前命中的 cue。資料量典型 < 200,linear scan 足夠。
  // 若使用者拖進度條跳到很遠位置,timeupdate 觸發後會自動命中新 cue。
  //
  // v1.6.21:effectiveEnd clamp 到「下一個 cue 的 startMs」,避免閱讀補償延長(_upsertDisplayCue
  // 內) 造成的 endMs 跟下一句重疊;若無下一句,沿用 cue.endMs。
  function _findActiveCue(currentMs) {
    const cues = SK.YT.displayCues;
    // v1.8.14: _upsertDisplayCue 已用 findIndex upsert + sort,同 startMs 只留一筆,
    // 所以 cues[i+1].startMs 必嚴格大於 cues[i].startMs(若 i+1 存在)。
    // 從原本 O(N²) 內 loop 簡化為 O(N) 線性掃描。
    // v1.9.22:加 c / next null guard,跟 _upsertDisplayCue 同一個 sparse array 防禦。
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      if (!c) continue;
      const next = cues[i + 1];
      const nextStart = (next) ? next.startMs : Infinity;
      const effectiveEnd = Math.min(c.endMs, nextStart);
      if (currentMs >= c.startMs && currentMs <= effectiveEnd) return c;
    }
    return null;
  }

  function _updateOverlay() {
    const YT = SK.YT;
    if (!YT.active || !YT.isAsr) return;
    // CC 關閉時清空 overlay(避免最後一條中文 cue 卡在畫面上)。
    // 不在 _observeCcButton 一次性清掉就好的原因:timeupdate 仍會觸發,
    // 若這裡不擋住會被 _findActiveCue → _setOverlayContent 重新寫回。
    if (YT.ccPaused) {
      _setOverlayContent('');
      return;
    }
    if (!YT.videoEl) return;
    // 動態同步 native caption font-size / font-family 到 overlay
    // (fullscreen / theatre / 字幕大小設定 / 使用者字型選擇變更時自動跟上)
    const host = _ensureOverlay();
    if (host) {
      const nativeFz = _readNativeCaptionFontSize();
      host.style.setProperty('--sk-cue-size', _scaledCueSizePx(nativeFz) + 'px');
      const nativeFf = _readNativeCaptionFontFamily();
      if (nativeFf) host.style.setProperty('--sk-cue-font-family', nativeFf);
    }
    const currentMs = YT.videoEl.currentTime * 1000;
    const cue = _findActiveCue(currentMs);
    // v1.8.20: ASR + 純中文模式下,replaceSegmentEl L1909 會 early return 跳過
    // L1934 的 hideCaptionStatus → 「翻譯中…」永遠殘留。改在 overlay 寫入時若有
    // 中文 cue 命中,就主動 hide(冪等,沒 status indicator 時直接 return)。
    if (cue && cue.targetText) hideCaptionStatus();
    // v1.8.42:ASR 雙語把 sourceText(英文)也寫進 overlay .src,跟 non-ASR 雙語視覺一致
    //         (中英都在同一塊黑底)。純中文模式 sourceText=undefined,.src 自動 hidden。
    const isBilingual = YT.config?.bilingualMode === true;
    const targetText = cue ? cue.targetText : '';
    const sourceText = (isBilingual && cue) ? cue.sourceText : undefined;
    _setOverlayContent(targetText, sourceText);
    // ASR 雙語 native CC 已藏,overlay 對齊 native cw bottom 取代視覺位置
    if (isBilingual && cue) _updateOverlayAnchor();
  }

  // 中文閱讀時間補償:LLM 自由分句把多段 ASR 合成一句中文,中文密度高,
  // 原 endMs(=該句最後一個 ASR 片段的 startMs)往往讓使用者讀不完。
  //   每字 200ms + 最低 800ms 下限(實測校準:250/1000 偏長 ~0.5s)。
  //   超過下一句 startMs 時由 _findActiveCue 自動 clamp,不會視覺重疊。
  const _ASR_READ_MS_PER_CHAR = 200;
  const _ASR_MIN_READ_MS       = 800;

  // 加入 cue 到 displayCues。
  //   - 同 startMs upsert(progressive 模式 LLM 覆蓋 heuristic 用)
  //   - opts.replaceRange=true(LLM 路徑用):清除 startMs 落在 (新 cue.startMs, 傳入 endMs)
  //     範圍內的舊 cue,避免 progressive 模式下「LLM 沒同 startMs」的 heuristic cue 殘留 →
  //     視覺上預設分句 / AI 分句疊來疊去。v2.0.54 起傳入 endMs = 時間軸分割區間終點
  //     (_resolveAsrEntryTimeline,= 下一個 LLM cue 的 startMs),清除範圍恰等於本句
  //     實際涵蓋範圍。**不可用延長後 adjustedEnd**:閱讀延長只是「給使用者讀完已有譯文
  //     的時間」,不該擴張清除範圍——會把本句沒 cover 的中段 heuristic cue 清掉。
  //   - 寫完按 startMs 排序,確保 _findActiveCue 找 nextStart 順序正確
  // endMs 自動延長至少夠中文閱讀時間(用於顯示 cue 的 endMs)。
  function _upsertDisplayCue(startMs, endMs, sourceText, targetText, opts) {
    const cues = SK.YT.displayCues;
    const trans = String(targetText || '');
    const llmEndMs = Number(endMs) || 0;          // LLM 原始 endMs(供 replaceRange 用)
    const idealReadMs = Math.max(_ASR_MIN_READ_MS, trans.length * _ASR_READ_MS_PER_CHAR);
    const adjustedEnd = Math.max(llmEndMs, Number(startMs) + idealReadMs);
    const next = { startMs, endMs: adjustedEnd, sourceText: sourceText || '', targetText: trans };

    // LLM 路徑清除被覆蓋的舊 cues(heuristic 殘留)。
    // 範圍上限用 llmEndMs 不用 adjustedEnd——避免清掉 LLM 沒 cover 的中段 heuristic。
    // v1.9.22:加 `c &&` 防禦 — 實機 log 看到 'asr llm overlay failed: Cannot read
    // properties of undefined (reading startMs)' × 6 次,代表這個 cues 陣列偶爾出現
    // undefined slot(疑似 race condition 或 sparse array)。null check 比追根因
    // 安全 — 反正 undefined cue 本來就該被忽略。
    if (opts && opts.replaceRange) {
      for (let i = cues.length - 1; i >= 0; i--) {
        const c = cues[i];
        if (c && c.startMs > startMs && c.startMs < llmEndMs) cues.splice(i, 1);
      }
    }

    const idx = cues.findIndex(c => c && c.startMs === startMs);
    if (idx >= 0) cues[idx] = next;
    else cues.push(next);

    // 排序前過濾掉 undefined / null slot(防 sparse array;sort comparator 對 undefined
    // 行為未定義,且可能整個 throw)
    if (cues.some(c => !c)) {
      const filtered = cues.filter(c => !!c);
      cues.length = 0;
      cues.push(...filtered);
    }
    cues.sort((a, b) => a.startMs - b.startMs);
    _scheduleIosFsTrackRefresh();   // iOS 原生全螢幕字幕軌跟著 displayCues 變更刷新
  }

  // ─── iOS 原生全螢幕字幕軌(native TextTrack fallback) ─────────
  //
  // 問題:iPhone / iPad Safari 按全螢幕走 video.webkitEnterFullscreen() 進「原生
  //       播放器」(系統 AVPlayer 層),只把 <video> 元素本身搬進去——所有疊在
  //       影片上的 DOM(我們的 shinkansen-yt-overlay、甚至 YouTube 自己的 caption
  //       div)全部留在後面被蓋住 → 全螢幕字幕整個消失。Element.requestFullscreen()
  //       在 iPhone 不支援,桌面那套「讓整個 #movie_player 進 top layer」用不了。
  //
  // 解法:原生播放器唯一吃得進去的文字是 <video> 的 native TextTrack。把 displayCues
  //       鏡像成一條 VTTCue TextTrack 掛在 video 上,平常 mode='hidden'(交給 DOM
  //       overlay 顯示),偵測到 webkitbeginfullscreen 才切 'showing' 讓原生播放器
  //       渲染,webkitendfullscreen 再切回 'hidden'。
  //
  // 取捨:全螢幕字幕外觀由 iOS 系統字幕設定(設定→輔助使用→字幕)控制,無法照搬
  //       overlay 那塊「中英共用黑底」。但「看得到」遠勝「消失」,屬 iPhone 平台硬限制。
  //
  // 訊號層次(本模組驗到哪、沒驗到哪 — 見 CLAUDE.md 工作流原則 §3):
  //   - 自動測得到:_buildIosFsTrackCues 的 cue 組裝(雙語 src\ntgt / 純譯文 / ms→s
  //     換算 / endMs clamp 到下一句)→ 有 regression spec。
  //   - 自動測不到:_isIOSSafari gate、webkitbegin/endfullscreen 真實切換、原生播放器
  //     渲染 → 只能 iPhone 實機驗(harness 是桌面 Chromium,_isIOSSafari()=false)。
  //     進 PENDING_REGRESSION。

  const _IOS_FS_TRACK_MARKER = 'shinkansen-yt-fs';
  let _iosFsBeginHandler = null;
  let _iosFsEndHandler   = null;
  let _iosFsRefreshPending = false;

  // iOS Safari 偵測:iPhone/iPad UA,或 iPadOS 13+ 偽裝成 Mac(用 maxTouchPoints 判)。
  function _isIOSSafari() {
    const ua = navigator.userAgent || '';
    if (/iP(hone|ad|od)/.test(ua)) return true;
    // iPadOS 桌面版 UA 偽裝成 MacIntel,但有觸控點
    return navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
  }

  // 從 displayCues 組裝原生字幕軌的 cue 陣列:[{ startSec, endSec, text }]。
  //   - 雙語:text = sourceText + '\n' + targetText(原文上、譯文下,跟 overlay 同序)
  //   - 純譯文:text = targetText
  //   - endSec clamp 到下一句 startMs(比照 _findActiveCue,避免閱讀補償延長造成原生
  //     播放器同時顯示兩句)
  function _buildIosFsTrackCues() {
    const YT = SK.YT;
    const isBilingual = YT.config?.bilingualMode === true;
    // ASR 路徑把顯示單位寫進 displayCues(_upsertDisplayCue),非 ASR(原生 / 人工字幕)
    // 路徑不寫 displayCues——譯文存在 captionMap(key=normText),平常注入回 .ytp-caption-segment
    // DOM。所以 displayCues 為空時改用 rawSegments(時間軸)+ captionMap(譯文)組裝,
    // 否則 iOS 原生全螢幕只剩 ASR 有字幕、原生字幕翻譯整個消失。
    // 用「displayCues 是否有資料」分流而非 isAsr 旗標:資料導向,且讓既有 ASR cue 組裝測試不動。
    if (YT.displayCues && YT.displayCues.length) {
      return _buildIosFsCuesFromDisplayCues(isBilingual);
    }
    return _buildIosFsCuesFromRawSegments(isBilingual);
  }
  SK._buildIosFsTrackCues = _buildIosFsTrackCues;   // regression spec 用

  // ASR(及任何已寫 displayCues 的路徑)：直接從顯示單位組 cue。
  function _buildIosFsCuesFromDisplayCues(isBilingual) {
    const src = SK.YT.displayCues;
    const out = [];
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (!c || !c.targetText) continue;
      const next = src[i + 1];
      const nextStart = next ? next.startMs : Infinity;
      const endMs = Math.min(c.endMs, nextStart);
      if (!(endMs > c.startMs)) continue;     // 退化區間跳過(VTTCue 要 end > start)
      let text = String(c.targetText);
      if (isBilingual && c.sourceText) text = String(c.sourceText) + '\n' + text;
      out.push({ startSec: c.startMs / 1000, endSec: endMs / 1000, text });
    }
    return out;
  }

  // 非 ASR(原生 / 人工字幕)：rawSegments 帶時間軸,captionMap 帶譯文。先依 groupId 把多行
  // 字幕合成顯示單位(跟 buildTranslationUnits preserve=true / captionMap 寫入慣例一致:
  // 第一行 key 存合併譯文,其餘存空字串),再 join captionMap。
  //   - endMs:rawSegments 不帶 dur,用下一個顯示單位的 startMs 當結尾;最後一句沿用
  //     保守 4s(避免原生播放器同時疊兩句又不會瞬間消失)。
  //   - 未翻到(captionMap 無 key)/ dedup 後續行(空字串)→ 跳過。
  const _IOS_FS_LAST_CUE_MS = 4000;
  function _buildIosFsCuesFromRawSegments(isBilingual) {
    const YT = SK.YT;
    const segs = YT.rawSegments;
    const cap = YT.captionMap;
    if (!segs || !segs.length || !cap || !cap.size) return [];
    // 1) 合成顯示單位 [{ startMs, srcText, key }]
    const units = [];
    let i = 0;
    while (i < segs.length) {
      const seg = segs[i];
      if (!seg) { i++; continue; }
      if (seg.groupId != null) {
        const group = [seg];
        let j = i + 1;
        while (j < segs.length && segs[j] && segs[j].groupId === seg.groupId) { group.push(segs[j]); j++; }
        units.push({ startMs: group[0].startMs, srcText: group.map(s => s.text).join(' '), key: group[0].normText });
        i = j;
      } else {
        units.push({ startMs: seg.startMs, srcText: seg.text, key: seg.normText });
        i++;
      }
    }
    // 2) join 譯文 + 算 endMs
    const out = [];
    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      const trans = cap.get(u.key);
      if (!trans) continue;     // undefined(未翻)或 ''(dedup 後續行)→ 跳過
      const next = units[k + 1];
      const endMs = next ? next.startMs : (u.startMs + _IOS_FS_LAST_CUE_MS);
      if (!(endMs > u.startMs)) continue;
      let text = String(trans);
      if (isBilingual && u.srcText) text = String(u.srcText) + '\n' + text;
      out.push({ startSec: u.startMs / 1000, endSec: endMs / 1000, text });
    }
    return out;
  }
  SK._buildIosFsCuesFromRawSegments = _buildIosFsCuesFromRawSegments;   // regression spec 用

  // 把 cue 陣列灌進「我們的」native TextTrack(find-or-create + 清舊 cue + 重灌)。
  function _ensureIosFsTrack(video, cues, showNow) {
    let track = null;
    const list = video.textTracks;
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].__skCreateBy === _IOS_FS_TRACK_MARKER) { track = list[i]; break; }
    }
    if (!track) {
      const lang = SK.STATE?.targetLanguage || 'zh-TW';
      track = video.addTextTrack('subtitles', 'Shinkansen', lang);
      track.__skCreateBy = _IOS_FS_TRACK_MARKER;
    } else {
      while (track.cues && track.cues.length) track.removeCue(track.cues[0]);
    }
    track.mode = showNow ? 'showing' : 'hidden';
    for (const c of cues) {
      try { track.addCue(new VTTCue(c.startSec, c.endSec, c.text)); } catch (e) { /* 單 cue 失敗不影響其他 */ }
    }
    return track;
  }
  SK._ensureIosFsTrack = _ensureIosFsTrack;   // regression spec 用(Chromium 也支援 addTextTrack/VTTCue)

  // 把非我們的字幕軌全壓 hidden,避免原生全螢幕跟 YouTube native track 疊字。
  function _hideForeignTextTracks(video) {
    const list = video.textTracks;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t && t.__skCreateBy !== _IOS_FS_TRACK_MARKER && t.mode !== 'disabled') {
        try { t.mode = 'hidden'; } catch (e) {}
      }
    }
  }

  // ─── YouTube 字幕字級 scale（全平台統一旋鈕,2026-06-08）──────────────────────
  // ytSubtitle.captionScale（%,預設 100 = 跟隨各平台原生字幕大小,桌面零改變）。
  // 設定在 popup（只在 YouTube 影片頁顯示),一個值套兩條渲染路徑:
  //   - 桌面 / macOS / iOS 視窗內：乘到 overlay 的 --sk-cue-size（原生字級 px × scale/100）
  //   - iPhone / iPad 原生全螢幕：overlay 被系統播放器取代,改注入 video::cue { font-size: scale% }
  //     （真機驗證 iOS 原生全螢幕吃網頁 ::cue;Safari 18.2 起系統預設字幕樣式可被網頁覆寫,
  //      研究背景見 SPEC-PRIVATE §26.8）。只設 font-size,顏色 / 底色交回系統字幕設定。
  let _ytCaptionScale = 100;
  // 純函式:原生字級 px × scale → overlay 用 px。抽出供 regression 鎖對映。
  function _scaledCueSizePx(nativeFz) {
    return Math.round(nativeFz * _ytCaptionScale / 100);
  }
  SK._scaledCueSizePx = _scaledCueSizePx;   // regression spec 用
  // 非 ASR 單語 path:中文寫進 YouTube 原生 .ytp-caption-segment（大小由 YouTube inline 控）。
  // 把 scale 套到 segment inline 字級,讓「字幕大小」旋鈕對內建字幕也生效(否則只有 overlay
  // 路徑 = ASR / 雙語吃旋鈕,內建字幕單語不吃 → 使用者看到不一致)。
  //   - dataset.skBaseFs 捕捉 YouTube 原始基準一次(之後 inline 被我們覆寫成 base×scale,
  //     不能再從 inline 讀回);新字幕行 = 新 segment 帶 YouTube 新基準,全螢幕 / resize 自然跟上
  //     (僅切換當下那一句延遲到下一句才套新大小,次秒級)。
  //   - scale === 100 且從沒套過 → 完全不碰(預設零改變);套過再回 100 → 還原 base。
  function _applyScaleToSegment(el) {
    if (!el || !el.style) return;
    if (_ytCaptionScale === 100 && el.dataset.skBaseFs == null) return;
    if (el.dataset.skBaseFs == null) el.dataset.skBaseFs = el.style.fontSize || '';
    const base = parseFloat(el.dataset.skBaseFs);
    if (!Number.isFinite(base) || base <= 0) return;   // YouTube 沒給 inline 字級 → 不動
    const px = (_ytCaptionScale === 100 ? base : Math.round(base * _ytCaptionScale / 100)) + 'px';
    if (el.style.fontSize !== px) el.style.fontSize = px;
  }
  SK._applyScaleToSegment = _applyScaleToSegment;   // regression spec 用
  // scale≠100 時持續把畫面上「任何」字幕 segment 套成設定大小 —— 不論是 Shinkansen 譯文,
  // 還是 YouTube 自家字幕 / 帳號層級自動翻譯（這種情況 Shinkansen 沒接手寫字幕,光靠
  // _setSegmentText hook 接不到新字幕行）。使用者在 popup 設「字幕大小」就期望畫面字幕即此
  // 大小,不該因字幕來源不同而失效。rAF 合併避免高頻 mutation 狂呼;_applyScaleToSegment
  // idempotent + 值相同不重設,observer 不會自觸發迴圈。scale=100 停掉 observer 並還原 base。
  let _captionScaleObserver = null;
  let _captionScaleRaf = 0;
  function _applyScaleToAllSegments() {
    document.querySelectorAll('.ytp-caption-segment').forEach(_applyScaleToSegment);
  }
  function _startCaptionScaleObserver(retries) {
    if (_captionScaleObserver) { _applyScaleToAllSegments(); return; }
    const root = document.querySelector('#movie_player');
    if (!root) {
      // 播放器還沒就緒（page load 初期）→ 短重試,避免去觀察整個 body（太重）
      if ((retries == null ? 10 : retries) > 0) {
        setTimeout(() => _startCaptionScaleObserver((retries == null ? 10 : retries) - 1), 1000);
      }
      return;
    }
    _captionScaleObserver = new MutationObserver(() => {
      if (_captionScaleRaf) return;             // 合併同一幀內的多個 mutation
      _captionScaleRaf = requestAnimationFrame(() => { _captionScaleRaf = 0; _applyScaleToAllSegments(); });
    });
    _captionScaleObserver.observe(root, { childList: true, subtree: true });
    _applyScaleToAllSegments();
  }
  function _stopCaptionScaleObserver() {
    if (_captionScaleObserver) { _captionScaleObserver.disconnect(); _captionScaleObserver = null; }
    if (_captionScaleRaf) { cancelAnimationFrame(_captionScaleRaf); _captionScaleRaf = 0; }
  }
  // 純函式:scale → iOS 原生全螢幕 ::cue font-size CSS。抽出供 regression 鎖對映（iOS 原生
  // 全螢幕實際渲染那層 harness 碰不到,只能測 CSS 生成,屬訊號層次 path B,見 spec 註解）。
  function _buildIosFsCueCss(scale) {
    return `video::cue,\nvideo::-webkit-media-text-track-display {\n  font-size: ${scale}% !important;\n}`;
  }
  SK._buildIosFsCueCss = _buildIosFsCueCss;   // regression spec 用
  function _ensureIosFsCueStyle() {
    const existing = document.getElementById('sk-ios-fs-cue-style');
    // scale = 100（預設）→ 完全不覆寫原生字幕渲染:移除任何既有 style,把全螢幕字級交回
    // iOS 系統字幕設定(依影片大小算出的原生字級)。無條件注入 `font-size: 100% !important`
    // 會壓掉系統的字級基準,iPhone 原生全螢幕字幕會縮到看不見 → 使用者看到的就是「字幕消失」。
    // 等同 v1.10.27(實機驗收正常那版)「不注入任何 cue style」的已驗證良好狀態。
    if (_ytCaptionScale === 100) {
      if (existing) existing.remove();
      return;
    }
    let st = existing;
    if (!st) {
      st = document.createElement('style');
      st.id = 'sk-ios-fs-cue-style';
      (document.head || document.documentElement).appendChild(st);
    }
    st.textContent = _buildIosFsCueCss(_ytCaptionScale);
  }
  // 設定變更即時套用:更新 scale → 重套 overlay --sk-cue-size（視窗內,全平台）+ iOS ::cue style。
  // overlay 在播放中每幀 timeupdate 也會以 _scaledCueSizePx 重套;此處額外做一次即時 reflow,
  // 讓暫停 / 非播放時改設定也立刻生效。
  function _applyYtCaptionScale(scale) {
    const n = Number(scale);
    if (Number.isFinite(n) && n >= 50 && n <= 400) _ytCaptionScale = Math.round(n);
    if (document.getElementById('sk-ios-fs-cue-style')) _ensureIosFsCueStyle();
    const host = document.querySelector(_OVERLAY_TAG);
    if (host) {
      const nativeFz = _readNativeCaptionFontSize();
      if (nativeFz) host.style.setProperty('--sk-cue-size', _scaledCueSizePx(nativeFz) + 'px');
    }
    // 原生 segment:scale≠100 啟動持續 observer（含立即套用一次）;=100 停掉 observer + 還原 base。
    if (_ytCaptionScale !== 100) {
      _startCaptionScaleObserver();
    } else {
      _stopCaptionScaleObserver();
      document.querySelectorAll('.ytp-caption-segment').forEach(_applyScaleToSegment);  // 還原 base
    }
  }
  SK._applyYtCaptionScale = _applyYtCaptionScale;   // regression spec 用

  // 主入口:重建 iOS 全螢幕字幕軌 + 綁定全螢幕進出事件。只在 iOS Safari 跑,其他平台直接 return。

  function _refreshIosFsTrack() {
    if (!_isIOSSafari()) return;
    const video = SK.YT.videoEl || document.querySelector('video');
    if (!video || typeof video.addTextTrack !== 'function') return;
    try {
      _ensureIosFsCueStyle();
      _hideForeignTextTracks(video);
      const inFs = video.webkitPresentationMode === 'fullscreen';
      const track = _ensureIosFsTrack(video, _buildIosFsTrackCues(), inFs);
      // 重綁前先移除舊 handler(video 元素可能跨 session 沿用)
      if (_iosFsBeginHandler) video.removeEventListener('webkitbeginfullscreen', _iosFsBeginHandler);
      if (_iosFsEndHandler)   video.removeEventListener('webkitendfullscreen',   _iosFsEndHandler);
      _iosFsBeginHandler = () => { try { track.mode = 'showing'; } catch (e) {} };
      _iosFsEndHandler   = () => { try { track.mode = 'hidden';  } catch (e) {} };
      video.addEventListener('webkitbeginfullscreen', _iosFsBeginHandler);
      video.addEventListener('webkitendfullscreen',   _iosFsEndHandler);
    } catch (e) {
      SK.sendLog?.('warn', 'youtube', 'ios fs track refresh failed: ' + e.message);
    }
  }

  // debounce:一批 _upsertDisplayCue 會連 push 數十條,300ms 合併成一次重建。
  function _scheduleIosFsTrackRefresh() {
    if (!_isIOSSafari()) return;
    if (_iosFsRefreshPending) return;
    _iosFsRefreshPending = true;
    setTimeout(() => { _iosFsRefreshPending = false; _refreshIosFsTrack(); }, 300);
  }

  // 停止時清掉我們的字幕軌 cue + 解綁全螢幕事件(TextTrack 本身無法移除,清空 cue
  // + mode='disabled' 即等同關閉)。
  function _teardownIosFsTrack() {
    const video = SK.YT.videoEl || document.querySelector('video');
    if (!video) return;
    try {
      if (_iosFsBeginHandler) video.removeEventListener('webkitbeginfullscreen', _iosFsBeginHandler);
      if (_iosFsEndHandler)   video.removeEventListener('webkitendfullscreen',   _iosFsEndHandler);
      _iosFsBeginHandler = null;
      _iosFsEndHandler   = null;
      const list = video.textTracks;
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (t && t.__skCreateBy === _IOS_FS_TRACK_MARKER) {
          while (t.cues && t.cues.length) t.removeCue(t.cues[0]);
          try { t.mode = 'disabled'; } catch (e) {}
        }
      }
    } catch (e) {}
  }

  // ─── ASR 子批切分(gap-aware + lead-time aware streaming) ────
  //
  // 為什麼切子批:整視窗 30s 一次送(50-90 條)首條中文要 8-15s 才出來,影片已超過。
  // 為什麼不純時間切:5s/15s 切點落在句子中間機率 ~50%,LLM 在子批內無法完整合句。
  // 解法:在 [minSpanMs, maxSpanMs] 區間內找最接近的 gap > GAP_MS 的位置切——
  //       gap 是 ASR 的自然停頓(換氣 / 句末),切在這裡幾乎不破壞合句。
  //       找不到 gap → 用 maxSpanMs 強制切(罕見:長獨白)。
  //
  // **lead-time aware**(D'-adaptive):leadMs = windowStartMs - videoNowMs
  //   - leadMs ≤ 0(緊急,使用者按 Alt+S 時當前位置已在視窗中段)→
  //       子批 0 從 videoNowMs 開始(skip 已過去的 segments,使用者已聽過),
  //       跨 2-4s 找 gap,典型 2-4 條,API ~1.5-2.5s 回。
  //   - 0 < leadMs < 5000 → 子批 0 從 windowStart 開始,跨 3-6s 找 gap。
  //   - leadMs ≥ 5000 → 子批 0 從 windowStart 開始,跨 3-8s(原行為)。
  //   對照原非 ASR 路徑的 adaptive batch 0 by lead time(content-youtube.js translateWindowFrom),
  //   思路一致:首批 payload 隨 lead 縮放,確保緊急時最快回填。
  //
  // windowSegs < 5 條 → 不切,整批一發(over-engineering 沒意義,API 也不會慢多少)
  function _splitAsrSubBatches(windowSegs, videoNowMs, windowStartMs, playbackRate) {
    // v1.9.22:空 input 直接回空 subBatches(原本 `return [windowSegs]` 變 `[[]]`,
    // 下游 _runAsrWindow line 1736 `subBatches.map(b => b[0].startMs)` 對空 b throw)
    if (windowSegs.length === 0) return [];
    if (windowSegs.length <= 5) return [windowSegs];

    const GAP_MS = 500;          // 自然停頓判斷門檻

    // Lead-time-aware:緊急情況下 skip 已過去的 segments,從 videoNowMs 之後第一條開始
    const leadMs = (typeof windowStartMs === 'number' && typeof videoNowMs === 'number')
      ? windowStartMs - videoNowMs : Infinity;
    // v1.9.19: wallLeadMs = 影片 lead / 播放速度,真實 wall-clock buffer。
    //          2x 速時 lead=10s 影片 = 5s wall buffer,API 還是吃 wall time,所以
    //          batch size 邊界判斷必須走 wall,否則高速 + 中等 lead 會選太大的批挨延遲。
    const rate = (typeof playbackRate === 'number' && playbackRate > 0) ? playbackRate : 1;
    const wallLeadMs = leadMs / rate;
    const sub0Start = leadMs <= 0 ? videoNowMs : windowSegs[0].startMs;
    const segs = leadMs <= 0
      ? windowSegs.filter(s => s.startMs >= sub0Start)
      : windowSegs;
    // v1.9.22:filter 後可能變空(seek 到視窗最尾,所有 segs 都 < videoNowMs)。
    //          這條才是「30% rapid-seek 觸發 asr llm overlay failed」的真正 root cause。
    if (segs.length === 0) return [];
    if (segs.length <= 5) return [segs];
    const n = segs.length;

    // 依 wallLeadMs 決定子批 0 跨度上限(影片時間單位):緊急 4s、即將 6s、從容 8s
    // sub0Max 是「子批 0 涵蓋幾秒影片」(影片時間),boundary 判斷走 wall time
    const sub0Max = leadMs <= 0       ? 4000
                  : wallLeadMs < 5000 ? 6000
                                      : 8000;
    const sub0Min = Math.min(2000, sub0Max - 1000);

    function findCutIdx(fromIdx, minSpanMs, maxSpanMs) {
      const baseMs = segs[fromIdx].startMs;
      let bestIdx = -1;
      let bestGap = 0;
      for (let i = fromIdx + 1; i < n; i++) {
        const span = segs[i].startMs - baseMs;
        if (span < minSpanMs) continue;
        if (span > maxSpanMs) break;
        const gap = segs[i].startMs - segs[i - 1].startMs;
        if (gap >= GAP_MS && gap > bestGap) {
          bestGap = gap;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) {
        for (let i = fromIdx + 1; i < n; i++) {
          const span = segs[i].startMs - baseMs;
          if (span >= maxSpanMs) { bestIdx = i; break; }
        }
      }
      return bestIdx;
    }

    // v2.0.54:句尾標點感知切分。start-to-start 間隔 = 片段語音長度 + 停頓,長片段
    // (5s+)會被 gap 邏輯誤判成「自然停頓」而切在句中(real-data cXot3z7ZPOo:
    // 146.8s「…It makes 181」→152.5s「horsepower…」間隔 5.68s 全是語音,gap 切分
    // 正好把句子切進兩個獨立 LLM 呼叫——前批腦補句尾、後批殘句起頭,邊界詞重複;
    // prompt 殘句規則實測 flash-lite 不服從,必須結構性避免)。
    // 有句尾標點的軌:只在「前一片段收在句尾標點」處切,範圍內取最晚(批大一點、
    // 接縫少一點),超出 maxSpan 可放寬 SLACK 找第一個;完全找不到就回 -1 = 不切
    // (整批送——句子完整優先於並行度,絕不回退到假 gap)。無標點軌:維持 gap 邏輯。
    const PUNCT_CUT_SLACK_MS = 5000;
    const hasPunct = segs.some(s => _ASR_SENTENCE_END_RE.test((s.text || '').trim()));

    function findPunctCutIdx(fromIdx, minSpanMs, maxSpanMs) {
      const baseMs = segs[fromIdx].startMs;
      let best = -1;
      for (let i = fromIdx + 1; i < n; i++) {
        const span = segs[i].startMs - baseMs;
        if (span > maxSpanMs + PUNCT_CUT_SLACK_MS) break;
        if (!_ASR_SENTENCE_END_RE.test((segs[i - 1].text || '').trim())) continue;
        if (span < minSpanMs) continue;
        if (span <= maxSpanMs) { best = i; continue; }  // 範圍內取最晚
        if (best < 0) best = i;                          // 放寬區取第一個
        break;
      }
      return best;
    }

    const _findCut = hasPunct ? findPunctCutIdx : findCutIdx;
    const cuts = [];
    const cut1 = _findCut(0, sub0Min, sub0Max);
    if (cut1 > 0) cuts.push(cut1);
    if (cut1 > 0) {
      const cut2 = _findCut(cut1, 8000, 15000);
      if (cut2 > cut1) cuts.push(cut2);
    }

    if (cuts.length === 0) return [segs];
    const batches = [];
    let prev = 0;
    for (const c of cuts) {
      batches.push(segs.slice(prev, c));
      prev = c;
    }
    batches.push(segs.slice(prev));
    return batches.filter(b => b.length > 0);
  }

  // 將「整批 windowSegs + 第幾批 + 計時起點」交給 Gemini 翻譯,並寫回 captionMap。
  // 抽出來成獨立 async function,讓 _runAsrWindow 可以對「子批 0 await + 子批 1+ allSettled」
  // 套用跟原 _runBatch 同樣的串流注入 pattern。
  async function _runAsrSubBatch(subSegs, batchIdx, _t0Window, batchApiMsRef) {
    const YT = SK.YT;
    // 世代快照：await 回來後 SPA 換片 / stop-restart 會換掉 captionMap / displayCues
    // (物件同一個 YT，屬性換新)，不比對就把舊影片的譯文與 cue 寫進新影片 session
    const _myGen = YT.captionSourceGen || 0;
    const lastSeg = subSegs[subSegs.length - 1];
    // v2.0.54:子批末條 e 改用 rawSegments 真實後繼片段起點(下一子批首條 = 本值,
    // 子批間仍不重疊),不再固定 +1500ms——固定值讓 LLM 對末句時距的認知系統性偏短
    const batchEndMs = _asrBatchEndMs(lastSeg.startMs, YT.rawSegments);
    const inputArr = subSegs.map((seg, i) => {
      const next = subSegs[i + 1];
      const endMs = next ? next.startMs : batchEndMs;
      return { s: seg.startMs, e: endMs, t: seg.text };
    });
    const inputJson = JSON.stringify(inputArr);

    // 依 ytSubtitle.engine 路由：openai-compat → CUSTOM，其餘(含 google，因 Google MT
    // 不支援 JSON timestamp 模式) → Gemini ASR handler
    const _asrMsgType = SK.getSubtitleBatchType(SK.YT.config?.engine, true);
    const res = await SK.safeSendMessage({
      type: _asrMsgType,
      payload: {
        texts: [inputJson],
        glossary: null,
        // background ASR prompt 注入 {sourceLanguage} 用;captionLang 從 /api/timedtext URL
        // `lang` 參數抓(v1.8.40 起)。chooser 切到原始 ASR 後此值 = 影片口說語(en/ja/ko/...)。
        sourceLanguage: SK.YT.captionLang || 'en',
      },
    });
    const elapsed = Date.now() - _t0Window;
    if (batchApiMsRef) batchApiMsRef[batchIdx] = elapsed;

    if (!res?.ok) throw new Error(SK.i18n.bgErrorMessage(res) || 'ASR translation failed');
    // 對齊 STREAMING_SEGMENT / flushOnTheFly 的防禦：session 已停或世代已換 → 丟棄結果
    if (!YT.active || _myGen !== (YT.captionSourceGen || 0)) {
      SK.sendLog('info', 'youtube', 'asr sub-batch result discarded (session changed)', {
        batchIdx, gen: _myGen, currentGen: YT.captionSourceGen, active: YT.active,
      });
      return;
    }
    _logWindowUsage(subSegs.length, res.usage);

    const rawText = res.result?.[0] || '';
    const entries = _parseAsrResponse(rawText);

    // v2.0.54:顯示時間軸改由 _resolveAsrEntryTimeline 以片段時間軸分割(不採信 LLM 的 e),
    // 修「AI 分句字幕太早消失 / 下一句太晚出現」:LLM 挑錯句中片段的 e 時,舊邏輯讓
    // 句尾片段 uncovered + cue 提早收
    const { cues, droppedCount } = _resolveAsrEntryTimeline(entries, subSegs, batchEndMs);
    let writtenCount = 0;
    for (const cue of cues) {
      // v1.9.22: 加 `seg &&` null guard 跟 displayCues 同樣 sparse 防禦原則
      const covered = subSegs.filter(seg => seg && seg.startMs >= cue.startMs && seg.startMs < cue.endMs);
      if (covered.length === 0) continue;
      YT.captionMap.set(covered[0].normText, cue.text);
      for (let k = 1; k < covered.length; k++) {
        // v1.10.46: rawSegments 不再全軌 dedup,covered 內可能有同 normText 的重複行
        // （例如「yeah yeah」連續兩條）——同 key 不可用空字串把剛寫入的譯文抹掉
        if (covered[k].normText !== covered[0].normText) YT.captionMap.set(covered[k].normText, '');
      }
      // G 路徑:寫 displayCues 給 overlay 用(progressive 模式覆蓋 heuristic 寫的同 startMs)。
      // v2.0.54:超長合句先過 _splitLongAsrCue 保底拆分(只拆顯示 cue,上面 captionMap
      // 已寫整句;拆出的每片各自 replaceRange 清掉自己區間內的 heuristic 殘留)
      const sourceText = covered.map(seg => seg.text).join(' ');
      const _segStarts = covered.map(seg => seg.startMs);
      for (const piece of _splitLongAsrCue(cue.startMs, cue.endMs, cue.text, _segStarts)) {
        _upsertDisplayCue(piece.startMs, piece.endMs, sourceText, piece.text, { replaceRange: true });
      }
      writtenCount++;
    }

    // overlay 立刻 render 當前 active cue
    _updateOverlay();

    SK.sendLog('info', 'youtube', 'asr sub-batch done', {
      batchIdx,
      batchSize: subSegs.length,
      elapsedMs: elapsed,
      sessionOffsetMs: Date.now() - YT.sessionStartTime,
      entriesReturned: entries.length,
      entriesWritten: writtenCount,
      entriesDropped: droppedCount,
      captionMapSize: YT.captionMap.size,
    });
  }
  SK._runAsrSubBatch = _runAsrSubBatch;

  async function _runAsrWindow(windowSegs, windowStartMs, windowEndMs) {
    const YT = SK.YT;
    if (!YT.active) return;

    // 1. gap-aware + lead-time aware split:把 windowSegs 切成 1-3 個子批。
    //    緊急時(video 已過 windowStart)子批 0 從當前播放位置開始 + skip 已過去 segments
    const videoNowMs = YT.videoEl ? Math.floor(YT.videoEl.currentTime * 1000) : windowStartMs;
    // v1.9.19: 把 playbackRate 傳進去讓 sub0Max boundary 判斷走 wall time
    const playbackRate = YT.videoEl?.playbackRate || 1;
    const subBatches = _splitAsrSubBatches(windowSegs, videoNowMs, windowStartMs, playbackRate);
    YT.lastLeadMs = (windowStartMs - videoNowMs) / playbackRate;  // debug 面板用,記 wall-time
    YT.firstBatchSize = subBatches[0]?.length ?? 0;       // debug 面板用
    SK.sendLog('info', 'youtube', 'asr window start', {
      windowStartMs, windowEndMs, videoNowMs,
      leadMs: windowStartMs - videoNowMs,
      segCount: windowSegs.length,
      subBatches: subBatches.map(b => b.length),
      subBatchSpans: subBatches.map(b => `${Math.round(b[0].startMs/1000)}–${Math.round(b[b.length-1].startMs/1000)}s`),
    });

    // 2. 子批 0 先 await(暖 Gemini implicit cache + 最快回填當前播放位置),
    //    子批 1+ Promise.allSettled 並行(失敗一批不拖累其他)。
    //    跟原路徑(_runBatch)的 streaming 慣例一致。
    const _t0 = Date.now();
    const _batchApiMs = new Array(subBatches.length).fill(0);

    if (subBatches.length === 0) return;

    try {
      await _runAsrSubBatch(subBatches[0], 0, _t0, _batchApiMs);
      YT.lastApiMs = _batchApiMs[0]; // 第一批 = 最快字幕回填
    } catch (err) {
      SK.sendLog('error', 'youtube', 'asr sub-batch 0 failed', { error: err.message });
      _notifyTranslationError(err.message);
    }
    if (!YT.active) {
      YT.batchApiMs = _batchApiMs;
      return;
    }
    if (subBatches.length > 1) {
      const settled = await Promise.allSettled(
        subBatches.slice(1).map((sb, i) => _runAsrSubBatch(sb, i + 1, _t0, _batchApiMs))
      );
      settled.forEach((r, i) => {
        if (r.status === 'rejected') {
          SK.sendLog('error', 'youtube', `asr sub-batch ${i + 1} failed`, {
            error: r.reason?.message || String(r.reason),
          });
        }
      });
    }

    YT.batchApiMs = _batchApiMs;

    SK.sendLog('info', 'youtube', 'asr window done', {
      windowStartMs, windowEndMs,
      totalElapsedMs: Date.now() - _t0,
      sessionOffsetMs: Date.now() - YT.sessionStartTime,
      subBatchTimings: _batchApiMs,
      captionMapSize: YT.captionMap.size,
    });
  }

  // ─── F 模式:啟發式合句後逐句翻譯(reuse 既有 batch streaming pattern) ─────
  //
  // 流程:
  //   1. _heuristicMergeAsr(windowSegs) → 英文整句 [{startMs, endMs, text, sourceSegs[]}]
  //   2. 包成 units({ text: 整句, keys: 整句內所有原始 normText[] })
  //      跟 buildTranslationUnits preserve=true 慣例一致——keys[0] 存譯文,keys[1..] 空字串
  //   3. adaptive batch 0(lead-time)+ batch 1+ allSettled streaming
  //   4. 各批 .then 立刻寫 captionMap + replaceSegmentEl
  //
  // 跟非 ASR 路徑共用「一般字幕」訊息(因為翻譯單位已經是「英文整句」，跟人工字幕
  // 一樣形態，不用 ASR 專用的 JSON timestamp prompt)。實際訊息類型依 engine 由
  // SK.getSubtitleBatchType 路由：google → _GOOGLE / openai-compat → _CUSTOM / 其餘 → Gemini。
  async function _runAsrHeuristicWindow(windowSegs, windowStartMs, options) {
    const YT = SK.YT;
    if (!YT.active) return;

    const sentences = _heuristicMergeAsr(windowSegs);
    if (sentences.length === 0) return;

    // v2.0.54:視窗尾組 endMs 同 LLM 路徑改用 rawSegments 真實後繼片段起點
    // (_heuristicMergeAsr 只看得到 windowSegs,尾組原本固定 +1500ms 系統性提早收)
    const _lastSentence = sentences[sentences.length - 1];
    _lastSentence.endMs = _asrBatchEndMs(windowSegs[windowSegs.length - 1].startMs, YT.rawSegments);

    SK.sendLog('info', 'youtube', 'asr heuristic merged', {
      windowStartMs, windowSegCount: windowSegs.length,
      sentenceCount: sentences.length,
      avgSegsPerSentence: (windowSegs.length / sentences.length).toFixed(1),
    });

    // _cue 帶 cue 時間範圍,翻譯回來後 push 到 displayCues 給 overlay 用
    // (segStarts = 該句涵蓋片段的真實起點,給超長譯文拆分的切點吸附用)
    const units = sentences.map(s => ({
      text: s.text,
      keys: s.sourceSegs.map(seg => seg.normText),
      _cue: {
        startMs: s.startMs, endMs: s.endMs, sourceText: s.text,
        segStarts: s.sourceSegs.map(seg => seg.startMs),
      },
    }));

    // v1.9.19: BATCH 8 → 12(token 攤提 ~26%,elapsed median 幾乎不變),
    //          batch 0 ramp 上限拉到 16(lead 充裕時更省 token),boundary 改走 wall time
    //          (除以 playbackRate),否則 2x 速 + 中等 lead 會誤選大批挨延遲。
    // v1.9.22: isUrgent(translateWindowFrom 傳入,代表 wallLead < 10s — seek 或緊跟著影片
    //          的情境)時 batch 1+ 縮到 4。原因:seek 後 batch 0 已 adaptive 縮到 1-4 條
    //          快速顯示前幾條,但接下來 batch 1 size=12 要 ~3-5s 才完,使用者中間視覺
    //          上像 freeze。縮到 4 讓「第 5-N 條」中文也快點冒,代價是 token 攤提變差
    //          (143 t/seg → 194 t/seg,+35%),但 isUrgent 場景 token 不是優先考量。
    const BATCH = options?.isUrgent ? 4 : 12;
    const videoNowMs = YT.videoEl ? YT.videoEl.currentTime * 1000 : windowStartMs;
    const leadMs = windowStartMs - videoNowMs;
    const playbackRate = YT.videoEl?.playbackRate || 1;
    const wallLeadMs = leadMs / playbackRate;
    const firstBatchSize = leadMs <= 0        ? 1
                         : wallLeadMs < 5000   ? 2
                         : wallLeadMs < 10000  ? 4
                         : wallLeadMs < 15000  ? 12
                         : 16;
    YT.firstBatchSize = firstBatchSize;
    YT.lastLeadMs = wallLeadMs;

    const batches = [];
    if (units.length > 0) {
      batches.push(units.slice(0, Math.min(firstBatchSize, units.length)));
      for (let i = firstBatchSize; i < units.length; i += BATCH) {
        batches.push(units.slice(i, i + BATCH));
      }
    }

    if (!YT.active) return;
    const _t0 = Date.now();
    const _batchApiMs = new Array(batches.length).fill(0);
    // 世代快照——await 回來後 SPA 換片 / stop-restart 時丟棄結果(同 _runAsrSubBatch)
    const _myGen = YT.captionSourceGen || 0;

    // 依 ytSubtitle.engine 路由(同非 ASR 字幕，單元已是英文整句不走 ASR JSON 模式)
    const _heuristicMsgType = SK.getSubtitleBatchType(SK.YT.config?.engine, false);

    const _runBatch = (batchUnits, b) =>
      SK.safeSendMessage({
        type: _heuristicMsgType,
        payload: { texts: batchUnits.map(u => u.text), glossary: null },
      }).then(res => {
        const elapsed = Date.now() - _t0;
        _batchApiMs[b] = elapsed;
        if (!res?.ok) throw new Error(SK.i18n.bgErrorMessage(res) || SK.t('common.errorUnknown'));
        if (!YT.active || _myGen !== (YT.captionSourceGen || 0)) {
          SK.sendLog('info', 'youtube', 'asr heuristic batch result discarded (session changed)', {
            batchIdx: b, gen: _myGen, currentGen: YT.captionSourceGen, active: YT.active,
          });
          return;
        }
        _logWindowUsage(batchUnits.length, res.usage);
        // v1.10.39(code review 2026-06-09 M8):防 res.ok=true 但 res.result 缺失時
        // res.result[j] 直接 throw(對齊非 ASR 主路徑 _injectBatchResult 的 res.result || [])
        const results = res.result || [];
        for (let j = 0; j < batchUnits.length; j++) {
          const unit = batchUnits[j];
          // v1.8.10 A:strip LLM 偷懶殘留的 SEP / «N» 標記
          const trans = SK.sanitizeMarkers(String(results[j] || unit.text).trim());
          let normTrans = trans;
          if (unit.keys.length === 1) {
            YT.captionMap.set(unit.keys[0], trans);
          } else {
            normTrans = trans.replace(/\\n/g, ' ').replace(/\n/g, ' ').trim();
            YT.captionMap.set(unit.keys[0], normTrans);
            for (let k = 1; k < unit.keys.length; k++) {
              // v1.10.46: 同 normText 重複行不可用空字串抹掉剛寫入的譯文（dedup 移除後可能出現）
              if (unit.keys[k] !== unit.keys[0]) YT.captionMap.set(unit.keys[k], '');
            }
          }
          // G 路徑:寫 displayCues 給 overlay 用
          // v2.0.54:heuristic 合句(上限 30 words)譯文也可能超長,同過保底拆分
          if (unit._cue) {
            for (const piece of _splitLongAsrCue(unit._cue.startMs, unit._cue.endMs, normTrans, unit._cue.segStarts)) {
              _upsertDisplayCue(piece.startMs, piece.endMs, unit._cue.sourceText, piece.text);
            }
          }
        }
        // overlay 立刻 render 當前 active cue(若有)
        _updateOverlay();
        SK.sendLog('info', 'youtube', 'asr heuristic batch done', {
          batchIdx: b, batchSize: batchUnits.length, elapsedMs: elapsed,
          sessionOffsetMs: Date.now() - YT.sessionStartTime,
          captionMapSize: YT.captionMap.size,
        });
      });

    if (batches.length > 0) {
      try {
        await _runBatch(batches[0], 0);
        YT.lastApiMs = _batchApiMs[0];
      } catch (err) {
        SK.sendLog('error', 'youtube', 'asr heuristic batch 0 failed', { error: err.message });
        _notifyTranslationError(err.message);
      }
      if (!YT.active) { YT.batchApiMs = _batchApiMs; return; }
      if (batches.length > 1) {
        const settled = await Promise.allSettled(
          batches.slice(1).map((bu, i) => _runBatch(bu, i + 1))
        );
        settled.forEach((r, i) => {
          if (r.status === 'rejected') {
            SK.sendLog('error', 'youtube', `asr heuristic batch ${i + 1} failed`, {
              error: r.reason?.message || String(r.reason),
            });
          }
        });
      }
    }
    YT.batchApiMs = _batchApiMs;

    SK.sendLog('info', 'youtube', 'asr heuristic window done', {
      sentences: sentences.length,
      totalElapsedMs: Date.now() - _t0,
      sessionOffsetMs: Date.now() - YT.sessionStartTime,
      captionMapSize: YT.captionMap.size,
    });
  }
  // 暴露給 spec 端直接驅動 heuristic 批次路徑(M8 res.result 缺失防禦回歸測試用),
  // 不影響 production behaviour。
  SK._runAsrHeuristicWindow = _runAsrHeuristicWindow;

  // ─── 時間視窗翻譯 ──────────────────────────────────────────

  // v1.8.40: 字幕已是目標語言時不送 LLM 翻譯
  // YouTube /api/timedtext URL 帶 lang= 參數(例如 'en' / 'zh-Hant' / 'ja')
  // 明確匹配 target → 直接 skip,避免浪費 token 翻自己。
  // P1 (v1.8.59): 依 STATE.targetLanguage 決定 skip 集合(取代原寫死 zh-TW 集合)。
  // v2.0.72: target=zh-TW 時簡中系(zh-Hans / zh-CN / zh-SG)也 skip——繁中使用者
  // 可直接閱讀簡中字幕,簡轉繁的 API 花費與轉換誤差不值得(產品決策,2026-07-30)。
  // 注意:僅字幕路徑;整頁翻譯的簡中段落仍照翻(content-detect.js isAlreadyInTarget 不動)。
  const SKIP_LANGS_BY_TARGET = {
    'zh-TW': new Set(['zh-Hant', 'zh-TW', 'zh-HK', 'zh-MO', 'zh-Hans', 'zh-CN', 'zh-SG']),
    'zh-CN': new Set(['zh-Hans', 'zh-CN', 'zh-SG']),
    'en':    new Set(['en', 'en-US', 'en-GB', 'en-CA', 'en-AU', 'en-IE', 'en-NZ']),
    'ja':    new Set(['ja', 'ja-JP']),
    'ko':    new Set(['ko', 'ko-KR']),
    'es':    new Set(['es', 'es-ES', 'es-MX', 'es-AR', 'es-CL', 'es-CO', 'es-419']),
    'fr':    new Set(['fr', 'fr-FR', 'fr-CA', 'fr-BE', 'fr-CH']),
    'de':    new Set(['de', 'de-DE', 'de-AT', 'de-CH']),
  };
  // 模糊 lang(`zh`)的定義上移到 chooser 區塊的 _AMBIGUOUS_LANGS_BY_TARGET
  // (chooser P1.5 與本 skip 判斷共用同一份,單一資料源)
  function _sampleCaptionText() {
    const segs = SK.YT.rawSegments;
    if (!segs || segs.length === 0) return '';
    // 取前 30 條串接,夠 SK.detectTextLang 的簡體特徵字比例統計
    return segs.slice(0, 30).map(s => s.text || '').join('').slice(0, 500);
  }
  function _shouldSkipBecauseAlreadyInTarget() {
    const captionLang = SK.YT.captionLang;
    if (!captionLang) return false;
    const target = SK.STATE?.targetLanguage || 'zh-TW';
    const skipSet = SKIP_LANGS_BY_TARGET[target];
    if (skipSet && skipSet.has(captionLang)) return true;
    // 模糊 lang fallback:用內容偵測補判
    const ambig = _AMBIGUOUS_LANGS_BY_TARGET[target];
    if (ambig && ambig.has(captionLang)) {
      const sample = _sampleCaptionText();
      if (sample) {
        // v2.0.72: target=zh-TW 對模糊 `zh` 軌,內容偵測到繁中「或簡中」都 skip
        // (跟上面 skip set 的簡中系決策一致;不動 isAlreadyInTarget——那是整頁翻譯共用,
        //  整頁的簡中段落仍要翻)。
        if (target === 'zh-TW' && typeof SK.detectTextLang === 'function') {
          const detected = SK.detectTextLang(sample);
          if (detected === 'zh-Hant' || detected === 'zh-Hans') return true;
        } else if (typeof SK.isAlreadyInTarget === 'function' && SK.isAlreadyInTarget(sample, target)) {
          return true;
        }
      }
    }
    return false;
  }
  // P1 deprecation alias:既有 spec(youtube-skip-already-zh-hant.spec.js)reference 此舊名
  function _shouldSkipBecauseAlreadyTraditionalChinese() {
    return _shouldSkipBecauseAlreadyInTarget();
  }

  // v1.8.53: 字幕已是繁中(skip 路徑)時根本不會送 API,captionMap 永遠空,
  // replaceSegmentEl 的 cached 永遠 undefined → hideCaptionStatus 永不觸發,
  // 「翻譯中…」status 永遠殘留。在 show 觸發點預先擋掉。
  function _shouldShowTranslatingStatus() {
    if (_shouldSkipBecauseAlreadyTraditionalChinese()) return false;
    if (_hasVisibleChineseCaption()) return false;
    return true;
  }

  function _notifyTranslationError(errorMessage) {
    const YT = SK.YT;
    if (YT._errorNotified) return;
    YT._errorNotified = true;
    hideCaptionStatus();
    SK.showToast('error', SK.t('toast.translateFailed', { error: errorMessage }), { autoHideMs: 8000 });
  }

  // v1.9.19: 暴露給 regression spec(youtube-batch-size-12.spec.js)直接驅動指定視窗,
  //          不必繞 translateYouTubeSubtitles 才能測 leadMs > 0 的批次大小分流。
  SK.translateWindowFrom = (windowStartMs) => translateWindowFrom(windowStartMs);

  async function translateWindowFrom(windowStartMs) {
    const YT = SK.YT;
    if (YT.translatingWindows.has(windowStartMs)) return;  // v1.2.54: per-window 防重入
    if (!YT.active) return;
    // v1.8.40: 字幕原文已是目標可讀語言(含 zh-TW target 的簡中,v2.0.72)→ 跳過整個
    // 翻譯流程,記一次 log 讓使用者在 debug 面板看得到原因
    if (_shouldSkipBecauseAlreadyTraditionalChinese()) {
      if (!YT._skipLoggedForLang) {
        SK.sendLog('info', 'youtube', 'skip translate: caption already readable for target', {
          captionLang: YT.captionLang,
          videoId: YT.videoId,
        });
        YT._skipLoggedForLang = true;
      }
      // v1.8.53: 防 race—captionsXHR / activate 比 captionLang 設定早走過 show 路徑時,
      // 走到這裡已知 skip,主動清掉殘留 status
      hideCaptionStatus();
      return;
    }

    // v1.10.46: 快照來源世代——本視窗翻譯期間若字幕來源切換（generation bump）,
    // 結尾不得把 windowStartMs 標進（新軌的）translatedWindows，否則新軌該視窗被誤跳過。
    const _myCaptionGen = YT.captionSourceGen || 0;

    // 取得設定
    const config = await getYtConfig();
    const windowSizeMs = (config.windowSizeS || 30) * 1000;
    const windowEndMs  = windowStartMs + windowSizeMs;

    // 標記「已排程翻譯到此位置」，防止 timeupdate 重複觸發
    YT.translatedUpToMs = windowEndMs;
    // v1.10.46: 快照 Set 本身——來源切換（_resetCaptionSourceBookkeeping）會換新 Set,
    // 舊 run 的 finally 必須刪「自己加進的那個」，不可誤刪新 run 在新 Set 的同 key 標記
    const _myTranslatingWindows = YT.translatingWindows;
    _myTranslatingWindows.add(windowStartMs);  // v1.2.54: 加入 Set，允許其他視窗並行

    // v1.3.5: try-finally 確保 translatingWindows.delete 無論如何都會執行
    // （涵蓋：正常完成、!YT.active 提前 return、catch 繼續後到達 finally）
    try {

    // v1.2.48: 若此視窗已確實翻過（Set 精確記錄），直接推進不送 API。
    // 舊版用 captionMapCoverageUpToMs（高水位線）判斷，但高水位線不保證連續覆蓋：
    // 若使用者從中間開始看，前段從未翻過，向後拖時高水位線誤判「已翻」導致字幕空白。
    if (YT.translatedWindows.has(windowStartMs)) return;  // try-finally 會清理

    // v1.9.22: 翻譯成功判斷 — 記錄起始 captionMap.size + displayCues.length,
    // 翻完比對若都沒長 = 整批 batches 全失敗(SW context invalidated / Gemini reject /
    // rate limit / 15s timeout × maxRetries 全部用光)。失敗時不加 translatedWindows,
    // 讓下次 seek 可重試;若加了 translatedWindows 又沒譯文,使用者拖到此視窗會看到
    // 空白(status 不顯示因 !translatedWindows.has=false,翻譯不重試因同 guard)。
    const _cmSizeBefore = YT.captionMap.size;
    const _cuesCountBefore = YT.displayCues.length;

    // 找出本視窗內的字幕（[windowStartMs, windowEndMs)）。
    // v2.0.54:ASR 走 _collectAsrWindowSegs——尾端延伸到句尾標點(邊界不切在句中)
    // + asrSegConsumed 去重(已被前一視窗延伸取走的片段本視窗跳過,每片段只送翻一次)。
    // 非 ASR(人工字幕)本就整句一條,維持純時間切分。
    const _myConsumedSet = YT.isAsr ? YT.asrSegConsumed : null;
    const windowSegs = YT.isAsr
      ? _collectAsrWindowSegs(YT.rawSegments, windowStartMs, windowEndMs, _myConsumedSet)
      : YT.rawSegments.filter(
          s => s.startMs >= windowStartMs && s.startMs < windowEndMs
        );
    // 收集後立即標記取用(同步,搶在其他並行視窗收集之前),失敗時於收尾釋放
    if (_myConsumedSet) windowSegs.forEach(s => _myConsumedSet.add(s.startMs));

    SK.sendLog('info', 'youtube', 'translateWindow start', {
      windowStartMs, windowEndMs, segCount: windowSegs.length,
      sessionOffsetMs: Date.now() - YT.sessionStartTime,  // v1.2.51: 距 session 啟動的 ms
    });
    if (config.debugToast && windowSegs.length > 0) {
      SK.sendLog('info', 'youtube-debug', 'translateWindow texts', {
        window: `${Math.round(windowStartMs/1000)}–${Math.round(windowEndMs/1000)}s`,
        texts: windowSegs.map(s => ({ ms: s.startMs, norm: s.normText })),
      });
    }
    _debugUpdate(`翻譯視窗 ${Math.round(windowStartMs/1000)}–${Math.round(windowEndMs/1000)}s（${windowSegs.length} 條）`);

    if (windowSegs.length > 0 && YT.isAsr) {
      // ASR 字幕(YouTube 自動語音辨識)有三種合句模式,由 ytSubtitle.asrMode 決定:
      //   - 'heuristic'   = F:啟發式合句 + 既有 TRANSLATE_SUBTITLE_BATCH(逐句翻)。延遲低、精度中。
      //   - 'llm'         = D':LLM 自由合句 + timestamp mode(_runAsrWindow)。延遲高、精度最高。
      //   - 'progressive' = E:先 heuristic 顯示(秒出),同時 fire-and-forget LLM 跑覆蓋。
      // v2.0.79:字幕引擎選 Google Translate(免費)時強制 heuristic —— LLM 合句路徑
      //(_runAsrWindow → TRANSLATE_ASR_SUBTITLE_BATCH)固定打 Gemini(Google MT 不支援
      // JSON timestamp 合句模式),使用者選了免費引擎卻仍被扣 Gemini token,且 AI 分句
      // 預設開啟 → 「引擎改成 Google 還是在燒我的 API」(GitHub issue #58)。
      // options 端同步把「AI 分句」toggle 停用並說明,兩邊是同一份事實。
      const asrMode = (config.engine === 'google')
        ? 'heuristic'
        : (config.asrMode || 'progressive');  // 預設 progressive(混合模式)

      // v1.9.22:seek / 緊急場景的 ASR 加速 — 算 wallLead(視窗起點距影片當前位置的
      // wall-clock ms,負數=video 已過視窗起點;這是 seek 進入此視窗的特徵)。
      //   wallLead < 10s 視為「使用者馬上要看到」→ 傳 isUrgent 給 _runAsrHeuristicWindow:
      //   batch 1+ 改 BATCH=4(原 12),讓使用者快點看到第 2-N 條中文。
      //   LLM(_runAsrWindow)仍照常 fire-and-forget 跑 — LLM 提供更聰明的句子切分,
      //   即使使用者已滑過,停下時也能看到精緻版。(原 v1.9.22 草案曾跳 LLM,但發現
      //   使用者抱怨「分句變糙」,改回保留 LLM)。
      const _videoNowMs = YT.videoEl ? YT.videoEl.currentTime * 1000 : 0;
      const _wallLead = (windowStartMs - _videoNowMs) / (YT.videoEl?.playbackRate || 1);
      const _isUrgent = _wallLead < 10000;

      if (asrMode === 'heuristic' || asrMode === 'progressive') {
        try {
          await _runAsrHeuristicWindow(windowSegs, windowStartMs, { isUrgent: _isUrgent });
        } catch (err) {
          SK.sendLog('error', 'youtube', 'asr heuristic translation failed', { error: err.message });
        }
      }

      if (asrMode === 'llm' || asrMode === 'progressive') {
        if (asrMode === 'progressive') {
          // fire-and-forget:LLM 結果回來後寫入 captionMap 會覆蓋 heuristic 版本
          // (兩條路徑都用同一組 windowSegs.normText 當 key,LLM 路徑的 entry.s/e 區間 ⊆ heuristic 合句區間)
          _runAsrWindow(windowSegs, windowStartMs, windowEndMs).catch(err => {
            SK.sendLog('error', 'youtube', 'asr llm overlay failed', {
              error: err.message,
              // v1.9.22:保留前 5 行 stack,便於下次再爆時定位
              stack: (err.stack || '').split('\n').slice(0, 5).join(' | '),
            });
          });
        } else {
          try {
            await _runAsrWindow(windowSegs, windowStartMs, windowEndMs);
          } catch (err) {
            SK.sendLog('error', 'youtube', 'asr window translation failed', { error: err.message });
          }
        }
      }
    } else if (windowSegs.length > 0) {
      // v1.2.42: 串流注入（streaming injection）——各批次一完成就立刻寫入 captionMap，
      // 不等其他批次。原本 Promise.all 後統一注入：所有批次都需等最慢那批（T_max）。
      // 改用 .then() 串流：第一批 T₁ 秒可用，第二批 T₂ 秒可用（T₁ ≤ T₂ ≤ T₃），
      // 早出現的字幕（batch 0）最快備妥，後續 timeupdate 觸發替換時命中率更高。
      // lastApiMs 改記最快完成批次的耗時（buffer 最關鍵的是第一批何時好）。
      // v1.2.47: 字幕批次大小從 20 降為 8。
      // 頁面翻譯的 CHUNK_SIZE=20 是針對「段落」設計，每段落數百字，密度高。
      // 字幕段落極短（平均 3-5 字），密度低（~0.6 條/秒）：
      //   20 條/批 × 0.6 條/秒 ≈ 33 秒的字幕 → 30 秒視窗只有 1 批，並行無效。
      //   8 條/批 × 0.6 條/秒 ≈ 13 秒的字幕 → 30 秒視窗有 2–3 批，串流注入生效。
      // 另一效果：每批 input tokens 減半，API 處理時間從 ~17s 降至 ~7s，
      // adapt look 自然收斂到更小值，buffer overrun 次數減少。
      // v1.9.19: BATCH 8 → 12。直接 Gemini benchmark 量到 size=8/12/16 的 median elapsed
      //   分別 2.7s / 2.5s / 4.0s,input token / 段在 size=8 是 194 t,size=12 降到 143 t
      //   (~26% 攤提),size=16 降到 117 t(再 18%)。12 是 elapsed 持平處的甜蜜點:
      //   token 攤提 ~26% 但 elapsed 不變,純贏;再往上 16 elapsed 跳 60%,留給 batch 0
      //   adaptive ramp(lead 充裕時)。
      const BATCH = 12;
      const preserve = true; // v1.2.38 起固定開啟，已移除設定頁 toggle
      const units = buildTranslationUnits(windowSegs, preserve);
      try {
        // 1. 切好每批的 units（批次索引 = 時間順序，batch 0 最早出現）
        // v1.2.50: 自適應首批大小（adaptive first batch size）
        // v1.9.19: ramp 上限拉到 16(lead 充裕時),boundary 改走 wall time
        //          (除以 playbackRate)——2x 速時 lead=10s 影片 = 5s wall,batch 邊界判斷
        //          走 wall 才不會選太大的批。緊急條件(leadMs ≤ 0)仍走 video time(相對位置)。
        // 以「視窗起點距影片當前位置的 wall lead time」決定 batch 0 的條數：
        //   lead ≤ 0（影片已超過視窗起點，緊急）→ 1 條：最小 payload，最快回傳
        //   wallLead < 5s → 2 條；< 10s → 4 條；< 15s → 12 條；≥ 15s → 16 條
        // 首批條數愈少，input/output tokens 愈少，API 回傳愈快，
        // 第一條字幕出現的延遲從 ~10s（batch=8）有望降至 ~5s（batch=1）。
        // 其餘批次用 BATCH=12 並行送出。
        const videoNowMs = YT.videoEl ? YT.videoEl.currentTime * 1000 : 0;
        const leadMs = windowStartMs - videoNowMs;
        const playbackRate = YT.videoEl?.playbackRate || 1;
        const wallLeadMs = leadMs / playbackRate;
        const firstBatchSize = leadMs <= 0        ? 1
                             : wallLeadMs < 5000   ? 2
                             : wallLeadMs < 10000  ? 4
                             : wallLeadMs < 15000  ? 12
                             : 16;
        YT.firstBatchSize = firstBatchSize;
        YT.lastLeadMs     = wallLeadMs;
        SK.sendLog('info', 'youtube', 'adaptive batch0', {
          leadMs: Math.round(leadMs),
          wallLeadMs: Math.round(wallLeadMs),
          playbackRate,
          firstBatchSize,
          totalUnits: units.length,
        });
        const batches = [];
        if (units.length > 0) {
          batches.push(units.slice(0, Math.min(firstBatchSize, units.length)));
          for (let i = firstBatchSize; i < units.length; i += BATCH) {
            batches.push(units.slice(i, i + BATCH));
          }
        }

        // 2. 使用者還原時中止
        if (!YT.active) return;  // v1.3.5: try-finally 會清理

        // 3. 串流注入：各批次一完成立刻注入 captionMap。
        // v1.2.56: batch 0 先 await，再並行送其餘批次。
        // 根本原因：並行送出時所有批次同時命中 Gemini implicit cache 冷路徑，
        // 小批次（1-3 units）剛好 1.5s 跑完，大批次（8 units）冷路徑需 13s；
        // 讓 batch 0（adaptive size，1-4 units）先完成暖熱 cache，
        // 再並行送 batch 1+，使大批次走暖路徑（~2s）。
        // 效果：第一視窗首條字幕從 ~13s 降至 ~3.5s；後續視窗 cache 已熱，
        // batch 0（2s）+ batch 1+（2s 並行）= 4s，比純並行（2s）多 2s 但仍在
        // adaptive lookahead 預警範圍內，使用者感知不受影響。
        const _t0 = Date.now();
        // v1.2.43: 每個視窗重置 batchApiMs，預先填好 placeholder 確保順序對齊
        // v1.3.5: 使用局部 _batchApiMs 收集計時，視窗完成後才同步至 YT.batchApiMs，
        // 避免多視窗並行翻譯時互相覆蓋共用陣列。進行中各批次顯示 '…'，完成後顯示實際 ms。
        const _batchApiMs = new Array(batches.length).fill(0);

        // 批次處理器(每批完成後立刻注入 captionMap 並替換 DOM 字幕)
        // 依 config.engine 路由到對應的翻譯 handler:
        //   google → _GOOGLE / openai-compat → _CUSTOM / 其餘 → Gemini
        // (v1.4.0 引入 google,v1.5.8 引入 openai-compat,routing 統一收斂到 SK.getSubtitleBatchType)
        const _subtitleMsgType = SK.getSubtitleBatchType(config.engine, false);

        const _injectBatchResult = (batchUnits, results, b, elapsed) => {
          // await 後才被呼叫——session 已停或世代已換(SPA 換片 / 軌道切換)就丟棄，
          // 不把舊影片譯文寫進新 session 的 captionMap(對齊 ASR 兩條路徑的守門)
          if (!YT.active || _myCaptionGen !== (YT.captionSourceGen || 0)) {
            SK.sendLog('info', 'youtube', 'non-asr batch result discarded (session changed)', {
              batchIdx: b, gen: _myCaptionGen, currentGen: YT.captionSourceGen, active: YT.active,
            });
            return;
          }
          for (let j = 0; j < batchUnits.length; j++) {
            const unit     = batchUnits[j];
            // v1.8.10 A:寫 captionMap 之前先 strip LLM 偷懶殘留的 SEP / «N» 標記
            const rawTrans = SK.sanitizeMarkers(results[j] || unit.text);
            if (unit.keys.length === 1) {
              YT.captionMap.set(unit.keys[0], rawTrans);
            } else {
              // 多行群組：合併為單行顯示
              const merged = rawTrans.replace(/\\n/g, ' ').replace(/\n/g, ' ').trim();
              YT.captionMap.set(unit.keys[0], merged);
              // v1.10.46: 同 normText 重複行不可用空字串抹掉剛寫入的譯文（dedup 移除後可能出現）
              for (let k = 1; k < unit.keys.length; k++) {
                if (unit.keys[k] !== unit.keys[0]) YT.captionMap.set(unit.keys[k], '');
              }
            }
          }
          const domSegs = document.querySelectorAll('.ytp-caption-segment');
          domSegs.forEach(replaceSegmentEl);
          // iOS 原生全螢幕字幕軌:非 ASR 不寫 displayCues,改在 captionMap 更新後刷新
          // (從 rawSegments + captionMap 重組 cue)。非 iOS 平台 _scheduleIosFsTrackRefresh
          // 內部 early return,零成本。
          _scheduleIosFsTrackRefresh();
          SK.sendLog('info', 'youtube', `batch done`, {
            batchIdx: b,
            batchSize: batchUnits.length,
            elapsedMs: elapsed,
            sessionOffsetMs: Date.now() - YT.sessionStartTime,
            domSegmentCount: domSegs.length,
            captionMapSize: YT.captionMap.size,
          });
        };

        const _runBatch = (batchUnits, b) =>
          SK.safeSendMessage({
            type: _subtitleMsgType,
            payload: { texts: batchUnits.map(u => u.text), glossary: null },
          }).then(res => {
            const elapsed = Date.now() - _t0;
            _batchApiMs[b] = elapsed;
            if (!res?.ok) throw new Error(SK.i18n.bgErrorMessage(res) || SK.t('common.errorUnknown'));
            _logWindowUsage(batchUnits.length, res.usage);
            _injectBatchResult(batchUnits, res.result || [], b, elapsed);
          });

        // v1.8.9: Streaming batch 0(只人工字幕、只 Gemini engine)
        // 收 STREAMING_SEGMENT 立刻寫 captionMap + replaceSegmentEl,首字延遲從整批 resolve 砍成 SSE 首段
        // v1.9.21: FIRST_CHUNK_TIMEOUT_MS 1500 → 3000 跟文章翻譯路徑一致(留 200% margin,
        // 避免偶發網路慢 / Pro 模型 TTFT 1-3s 誤判 fallback)。Google MT / OpenAI-compat 維持原非 streaming。
        const _streamSubtitleEnabled = !config.engine || config.engine === 'gemini';
        const FIRST_CHUNK_TIMEOUT_MS = 3000;
        // v1.10.46: streaming idle watchdog 上限。字幕批次 ≤16 條短句，正常整批 < 10s;
        // 20s 沒任何 SEGMENT / DONE / ERROR = SW 已死，reject 走 non-streaming fallback。
        // SK._streamIdleTimeoutMs 為 regression spec 縮短逾時用的 override seam。
        const STREAM_IDLE_TIMEOUT_MS = 20000;

        const _runBatch0Streaming = (batchUnits) => {
          const streamId = `yt_stream_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
          let firstChunkResolve, doneResolve, doneReject;
          const firstChunkPromise = new Promise(r => { firstChunkResolve = r; });
          const donePromise = new Promise((res, rej) => { doneResolve = res; doneReject = rej; });
          // 確保「first_chunk failed → 主流程不 await donePromise」時 donePromise 的 reject 不會冒成 unhandled
          donePromise.catch(() => {});

          // v1.10.46: idle watchdog——first_chunk 之後 SW 中途死亡（iOS 有實證）時
          // STREAMING_DONE / ERROR 永不到，await donePromise 永久 pending → 該 windowStartMs
          // 永久留在 translatingWindows,seek 回此視窗到 reload 前都空白。
          // 每收到本 stream 任何訊息重置計時；逾時 reject 讓呼叫端走既有 non-streaming fallback。
          let _idleTimer = null;
          const _resetIdleWatchdog = () => {
            clearTimeout(_idleTimer);
            _idleTimer = setTimeout(() => {
              try { browser.runtime.onMessage.removeListener(onMessage); } catch (_) {}
              SK.sendLog('warn', 'youtube', 'streaming idle watchdog fired (SW dead mid-stream?)', { streamId });
              firstChunkResolve(false);
              doneReject(new Error('streaming idle timeout'));
            }, SK._streamIdleTimeoutMs || STREAM_IDLE_TIMEOUT_MS);
          };
          const _clearIdleWatchdog = () => { clearTimeout(_idleTimer); _idleTimer = null; };

          const onMessage = (message) => {
            if (!message || message.payload?.streamId !== streamId) return;
            _resetIdleWatchdog(); // 本 stream 有任何動靜 = SW 還活著
            if (message.type === 'STREAMING_FIRST_CHUNK') {
              firstChunkResolve(true);
            } else if (message.type === 'STREAMING_SEGMENT') {
              if (!YT.active) return;
              const idx = message.payload.segmentIdx;
              const tr = message.payload.translation;
              if (typeof idx === 'number' && idx >= 0 && idx < batchUnits.length && tr) {
                _injectBatchResult([batchUnits[idx]], [tr], 0, Date.now() - _t0);
              }
            } else if (message.type === 'STREAMING_DONE') {
              const elapsed = Date.now() - _t0;
              _batchApiMs[0] = elapsed;
              // v1.8.10 B:hadMismatch=true(LLM 偷懶把 N 段合併成 1 段)時 reject,
              // 觸發既有 mid-failure catch 重翻 batch 0 走 non-streaming(整批 resolve 後一次 split)。
              // segment 0 可能已被 streaming 注入合併譯文(A 已 sanitize),retry 會用乾淨版本覆蓋。
              if (message.payload.hadMismatch) {
                SK.sendLog('warn', 'youtube', 'streaming DONE with hadMismatch, triggering retry', { elapsed, totalSegments: message.payload.totalSegments });
                _clearIdleWatchdog();
                browser.runtime.onMessage.removeListener(onMessage);
                firstChunkResolve(true);
                doneReject(new Error('streaming hadMismatch'));
                return;
              }
              _logWindowUsage(batchUnits.length, message.payload.usage || {});
              _clearIdleWatchdog();
              browser.runtime.onMessage.removeListener(onMessage);
              firstChunkResolve(true);
              doneResolve({ ok: true });
            } else if (message.type === 'STREAMING_ERROR') {
              _clearIdleWatchdog();
              browser.runtime.onMessage.removeListener(onMessage);
              firstChunkResolve(false);
              doneReject(new Error(SK.i18n.bgErrorMessage(message.payload) || 'streaming failed'));
            } else if (message.type === 'STREAMING_ABORTED') {
              _clearIdleWatchdog();
              browser.runtime.onMessage.removeListener(onMessage);
              firstChunkResolve(false);
              doneResolve({ ok: false, aborted: true });
            }
          };
          browser.runtime.onMessage.addListener(onMessage);
          _resetIdleWatchdog(); // listener 掛上即開始計時（涵蓋 first_chunk 已到但 SEGMENT 永不到的情境）

          SK.safeSendMessage({
            type: 'TRANSLATE_SUBTITLE_BATCH_STREAM',
            payload: { texts: batchUnits.map(u => u.text), glossary: null, streamId },
          }).then((resp) => {
            if (!resp?.started) {
              _clearIdleWatchdog();
              browser.runtime.onMessage.removeListener(onMessage);
              firstChunkResolve(false);
              doneReject(new Error(resp?.error || 'streaming failed to start'));
            }
          }).catch((err) => {
            _clearIdleWatchdog();
            browser.runtime.onMessage.removeListener(onMessage);
            firstChunkResolve(false);
            doneReject(err);
          });

          const firstChunkOrTimeout = Promise.race([
            firstChunkPromise.then(v => ({ kind: v ? 'first_chunk' : 'failed' })),
            new Promise(r => setTimeout(() => r({ kind: 'timeout' }), FIRST_CHUNK_TIMEOUT_MS)),
          ]);

          return {
            firstChunkOrTimeout,
            donePromise,
            streamId,
            cleanup: () => {
              _clearIdleWatchdog();
              try { browser.runtime.onMessage.removeListener(onMessage); } catch (_) {}
            },
          };
        };

        // v1.2.56: batch 0 先 await（暖熱 cache），再並行送 batch 1+
        // v1.6.19: 後續批次改用 allSettled——任一批 reject 不再讓整批字幕沒寫回，
        // 成功的批次保留(captionMap.set 在 _runBatch 的 .then 內已自己寫過),失敗只 log。
        // v1.8.9: Streaming batch 0(gemini)— first_chunk 抵達後同步 dispatch batch 1+,
        // mid-failure / first_chunk timeout 走 _runBatch non-streaming fallback。
        if (batches.length > 0) {
          let batch0NeedsFallback = false;
          if (_streamSubtitleEnabled) {
            const stream = _runBatch0Streaming(batches[0]);
            const r = await stream.firstChunkOrTimeout;
            if (r.kind === 'first_chunk') {
              const willParallel = batches.length > 1 && YT.active;
              const parallelP = willParallel
                ? Promise.allSettled(batches.slice(1).map((bu, i) => _runBatch(bu, i + 1)))
                : Promise.resolve([]);
              try {
                await stream.donePromise;
                YT.lastApiMs = _batchApiMs[0];
              } catch (streamErr) {
                SK.sendLog('warn', 'youtube', 'streaming mid-failure, retrying batch 0 non-streaming', { error: streamErr.message });
                try {
                  await _runBatch(batches[0], 0);
                  YT.lastApiMs = _batchApiMs[0];
                } catch (err) {
                  SK.sendLog('error', 'youtube', 'batch 0 fallback failed', { error: err.message });
                  _notifyTranslationError(err.message);
                }
              }
              const settled = await parallelP;
              settled.forEach((rr, i) => {
                if (rr.status === 'rejected') {
                  SK.sendLog('error', 'youtube', `batch ${i + 1} failed`, {
                    error: rr.reason?.message || String(rr.reason),
                  });
                }
              });
              // v1.10.46: 移除原本的提前 return——它跳過底部共同收尾，streaming 成功的
              // 視窗永遠不進 translatedWindows（seek-back 整批重送）、過期追趕 /
              // adaptive lookahead 也不跑。batch0NeedsFallback=false 會自然跳過
              // 下方 fallback 區塊，直接走共同收尾。
            } else {
              stream.cleanup();
              if (r.kind === 'timeout') {
                SK.sendLog('warn', 'youtube', 'streaming first_chunk timeout, falling back to non-streaming', { streamId: stream.streamId });
                SK.safeSendMessage({ type: 'STREAMING_ABORT', payload: { streamId: stream.streamId } }).catch(() => {});
              }
              batch0NeedsFallback = true;
            }
          } else {
            batch0NeedsFallback = true;
          }

          if (batch0NeedsFallback) {
            try {
              await _runBatch(batches[0], 0);
              YT.lastApiMs = _batchApiMs[0]; // batch 0 是第一個完成的，記錄其耗時
            } catch (err) {
              SK.sendLog('error', 'youtube', 'batch 0 failed', { error: err.message });
              _notifyTranslationError(err.message);
            }
            if (!YT.active) {
              YT.batchApiMs = _batchApiMs;  // v1.6.19: abort 也要同步,debug 面板才能反映 batch 0 耗時
              return;  // v1.3.5: try-finally 會清理
            }
            if (batches.length > 1) {
              const settled = await Promise.allSettled(
                batches.slice(1).map((bu, i) => _runBatch(bu, i + 1))
              );
              settled.forEach((r, i) => {
                if (r.status === 'rejected') {
                  SK.sendLog('error', 'youtube', `batch ${i + 1} failed`, {
                    error: r.reason?.message || String(r.reason),
                  });
                }
              });
            }
          }
        }

        // v1.3.5: 所有批次完成，將局部計時陣列同步至共用狀態供 debug 面板讀取
        YT.batchApiMs = _batchApiMs;
      } catch (err) {
        SK.sendLog('error', 'youtube', 'window translation failed', { error: err.message });
        _notifyTranslationError(err.message);
      }
    }

    // v1.2.46/v1.2.48: 記錄此視窗已翻完
    YT.captionMapCoverageUpToMs = Math.max(YT.captionMapCoverageUpToMs, windowEndMs);
    // v1.9.22: 只有「真的有譯文進帳」或「視窗本來就沒字幕」才加 translatedWindows。
    // 全 batches 失敗時不加,下次 seek 此視窗會重跑翻譯(避免「靜默空白」bug)。
    const _windowProducedTranslation =
      YT.captionMap.size > _cmSizeBefore ||
      YT.displayCues.length > _cuesCountBefore;
    // v1.10.46: 世代比對——in-flight 期間來源已切換的批次不得標 translatedWindows
    if (_myCaptionGen !== (YT.captionSourceGen || 0)) {
      SK.sendLog('info', 'youtube', 'window finished after caption source switch — not marking translated', {
        windowStartMs, gen: _myCaptionGen, currentGen: YT.captionSourceGen,
      });
    } else if (windowSegs.length === 0 || _windowProducedTranslation) {
      YT.translatedWindows.add(windowStartMs); // Set 精確記錄,供 seek-back 跳過判斷用
    } else {
      // v2.0.54:視窗沒產出 → 釋放本視窗取走的片段,retry 時重新收集(含尾端延伸)。
      // 不釋放的話片段永遠掛在 asrSegConsumed,重試視窗收不到片段 → 永久空白。
      if (_myConsumedSet) windowSegs.forEach(s => _myConsumedSet.delete(s.startMs));
      SK.sendLog('warn', 'youtube', 'window translation produced nothing — leaving open for retry', {
        windowStartMs, segCount: windowSegs.length,
        captionMapSize: YT.captionMap.size,
        displayCuesLen: YT.displayCues.length,
      });
    }

    // v1.2.45: 過期視窗追趕機制——API 完成時若 video 已超過 translatedUpToMs（window end），
    // 代表這個視窗的字幕早就過了，直接把翻譯起點跳到 video 現在所在的視窗邊界，
    // 讓 translating = false 後 timeupdate 立刻觸發翻譯「現在」的內容，而不是繼續翻過期的視窗。
    // 不過期時此區塊完全不執行，對正常流程零影響。
    const catchUpVideoMs = YT.videoEl ? Math.floor(YT.videoEl.currentTime * 1000) : 0;
    if (catchUpVideoMs > YT.translatedUpToMs) {
      const catchUpNewStart = Math.floor(catchUpVideoMs / windowSizeMs) * windowSizeMs;
      YT.staleSkipCount++;
      SK.sendLog('warn', 'youtube', '⚠️ 視窗過期，跳位追趕', {
        videoNowMs: catchUpVideoMs,
        windowEnd:  YT.translatedUpToMs,
        jumpTo:     catchUpNewStart,
        staleSkipCount: YT.staleSkipCount,
      });
      YT.translatedUpToMs = catchUpNewStart;
      _debugUpdate(`⚠️ 過期跳位 → ${Math.round(catchUpNewStart / 1000)}s（第 ${YT.staleSkipCount} 次）`);
    }

    // v1.2.44: 自適應 lookahead——根據剛完成視窗的 API 耗時動態調整下次觸發點。
    // 若 lastApiMs > 設定值，下次提前觸發，確保 buffer 不會被 API 耗時吃光。
    // 取 lastApiMs × 1.3（安全餘量 30%）與設定值的較大者，上限 60 秒。
    if (YT.lastApiMs > 0) {
      const configLookaheadMs = (YT.config?.lookaheadS ?? DEFAULT_YT_CONFIG.lookaheadS) * 1000;
      const playbackRate = YT.videoEl?.playbackRate || 1;
      const needed = Math.ceil(YT.lastApiMs * 1.3 * playbackRate);
      YT.adaptiveLookaheadMs = Math.min(Math.max(needed, configLookaheadMs), 60000);
    }

    _debugUpdate(`視窗 ${Math.round(windowStartMs/1000)}–${Math.round(windowEndMs/1000)}s 完成（captionMap: ${YT.captionMap.size}）`);

    // 檢查是否還有未翻譯的字幕
    const maxMs = YT.rawSegments.length > 0
      ? YT.rawSegments[YT.rawSegments.length - 1].startMs
      : 0;
    if (YT.translatedUpToMs <= maxMs && YT.active) {
      SK.sendLog('info', 'youtube', 'more captions remain', {
        translatedUpToMs: YT.translatedUpToMs, maxMs,
      });
    }

    } finally {
      // v1.3.5: 統一清理——無論正常完成、!YT.active 提前 return 或例外，
      // 都確保此視窗從「翻譯中」Set 移除，防止 per-window 防重入鎖死。
      _myTranslatingWindows.delete(windowStartMs);
    }
  }

  // ─── video.timeupdate 驅動（觸發下一視窗）────────────────

  function onVideoTimeUpdate() {
    const YT = SK.YT;
    // G 路徑:每次 timeupdate 都更新 overlay,根據 currentTime 切換 active cue。
    // 寫在最前面,即使 rawSegments 還沒到也能跑(沒 cue 就 hide overlay)。
    _updateOverlay();
    // v1.2.54: 移除 translating guard — translateWindowFrom 內部用 translatingWindows Set 防重入，
    // 讓 timeupdate 可在當前視窗翻譯進行中提前啟動下一個視窗（消除英文字幕間隙）
    if (!YT.active || YT.rawSegments.length === 0) return;
    // CC 關閉時暫停送 API(_observeCcButton 在 CC 重開時會重置 translatedUpToMs + 立刻續翻)
    if (YT.ccPaused) return;

    const video = YT.videoEl;
    if (!video) return;

    const config = YT.config || DEFAULT_YT_CONFIG;
    // v1.2.44: effectiveLookaheadMs 取設定值與自適應值的較大者。
    // 自適應值在每個視窗完成後根據上次 API 耗時 × 1.3 更新，確保下次觸發足夠早。
    // 速度愈快，play-time lookahead 也需要等比例放大，讓 real-time 餘量維持不變。
    const configLookaheadMs = (config.lookaheadS || 10) * 1000 * (video.playbackRate || 1);
    const lookaheadMs = Math.max(configLookaheadMs, YT.adaptiveLookaheadMs || 0);

    const currentMs = video.currentTime * 1000;

    // 所有字幕都翻完了
    const maxMs = YT.rawSegments[YT.rawSegments.length - 1].startMs;
    if (YT.translatedUpToMs > maxMs) return;

    // 若距離已翻譯邊界不足 lookaheadMs，或已超過，立刻翻下一批
    if (currentMs >= YT.translatedUpToMs - lookaheadMs) {
      _debugUpdate(`timeupdate 觸發下一批（now: ${Math.round(currentMs/1000)}s，up to: ${Math.round(YT.translatedUpToMs/1000)}s）`);
      translateWindowFrom(YT.translatedUpToMs);
    }
  }

  // ─── video.ratechange 驅動（切換播放速度時重新檢查是否需要立刻翻譯）──
  // 切速後 lookaheadMs 改變（乘以新 playbackRate），當前位置可能已進入新的
  // 預警範圍但 timeupdate 還沒觸發；直接在 ratechange 時做一次檢查。

  function onVideoRateChange() {
    const YT = SK.YT;
    if (!YT.active || YT.rawSegments.length === 0) return;  // v1.2.54: 移除 translating guard
    if (YT.ccPaused) return;
    const video = YT.videoEl;
    if (!video) return;

    const config = YT.config || DEFAULT_YT_CONFIG;
    const configLookaheadMs = (config.lookaheadS || 10) * 1000 * (video.playbackRate || 1);
    const lookaheadMs = Math.max(configLookaheadMs, YT.adaptiveLookaheadMs || 0);
    const currentMs   = video.currentTime * 1000;
    const maxMs       = YT.rawSegments[YT.rawSegments.length - 1].startMs;
    if (YT.translatedUpToMs > maxMs) return;

    if (currentMs >= YT.translatedUpToMs - lookaheadMs) {
      _debugUpdate(`ratechange(${video.playbackRate}x) 觸發下一批`);
      translateWindowFrom(YT.translatedUpToMs);
    }
  }

  // ─── video.seeked 驅動（跳轉後重設翻譯起點）──────────────
  // 向前跳：新位置超出 translatedUpToMs → captionMap 缺對應條目，需立刻翻譯。
  // 向後跳：新位置在已翻範圍內 → captionMap 仍有效，但 translatedUpToMs 須重置，
  //         否則 buffer 顯示暴衝（+1345s 等不合理數字）。
  // v1.2.46：統一重置 translatedUpToMs；translateWindowFrom 內有 captionMapCoverageUpToMs
  //          跳過判斷，向後拖後重播已翻範圍不會重複送 API。

  function onVideoSeeked() {
    const YT = SK.YT;
    _updateOverlay(); // G 路徑:跳轉後立刻刷新 overlay,不等 timeupdate
    if (!YT.active || YT.rawSegments.length === 0) return;
    // CC 暫停時不更新 translatedUpToMs,避免暫停期間拖進度條導致重開時跳到無關位置;
    // _observeCcButton 在 CC 重開時會用當下 currentTime 重設起點。
    if (YT.ccPaused) return;
    const video = YT.videoEl;
    if (!video) return;

    const currentMs    = video.currentTime * 1000;
    const config       = YT.config || DEFAULT_YT_CONFIG;
    const windowSizeMs = (config.windowSizeS || 30) * 1000;
    const newWindowStart = Math.floor(currentMs / windowSizeMs) * windowSizeMs;

    // 不論向前或向後，一律重設翻譯起點（向後拖時讓 buffer 顯示回到合理值）
    YT.translatedUpToMs = newWindowStart;
    _debugUpdate(`seeked → 重設翻譯起點 ${Math.round(newWindowStart/1000)}s`);
    // v1.2.57: 若跳到尚未翻譯的視窗，立刻顯示「翻譯中…」提示
    // （translateWindowFrom 內部有防重入，已翻視窗會直接 return，不需要提示）
    // v1.8.16: 若當前畫面已有中文字幕,跳過提示避免打擾
    // v1.8.53: 字幕原文已是繁中(skip translate 路徑)也跳過,避免 status 永遠殘留
    if (!YT.translatedWindows.has(newWindowStart) && _shouldShowTranslatingStatus()) {
      showCaptionStatus('翻譯中…');
    }
    // v1.2.54: translateWindowFrom 內部用 translatingWindows Set 防重入，無需外部 guard
    translateWindowFrom(newWindowStart);
  }

  function attachVideoListener() {
    const YT = SK.YT;
    const video = document.querySelector('video');
    if (!video || YT.videoEl === video) return;
    if (YT.videoEl) {
      YT.videoEl.removeEventListener('timeupdate', onVideoTimeUpdate);
      YT.videoEl.removeEventListener('seeked',     onVideoSeeked);
      YT.videoEl.removeEventListener('ratechange', onVideoRateChange);
    }
    YT.videoEl = video;
    video.addEventListener('timeupdate', onVideoTimeUpdate);
    video.addEventListener('seeked',     onVideoSeeked);
    video.addEventListener('ratechange', onVideoRateChange);
    _observeCcButton();
  }

  // ─── CC 按鈕監聽:暫停 / 續翻送 API ─────────────────────────
  // 使用者按關 CC 不應該繼續燒 token。MutationObserver 監聽 .ytp-subtitles-button
  // 的 aria-pressed 屬性:
  //   true  → false  : YT.ccPaused = true,onVideoTimeUpdate / RateChange / Seeked 直接 return
  //   false → true   : YT.ccPaused = false,把 translatedUpToMs 對齊當前 currentTime 的視窗起點
  //                    後立刻 translateWindowFrom 補齊(暫停期間 currentTime 已推進,不重設會
  //                    跳過中間)
  // 註:forceSubtitleReload 自動點開 CC 也會走這裡,流程一致(關 → 開 = 從暫停恢復)。

  function _observeCcButton() {
    const YT = SK.YT;
    if (YT._ccButtonObserver) {
      YT._ccButtonObserver.disconnect();
      YT._ccButtonObserver = null;
    }
    const btn = document.querySelector('.ytp-subtitles-button');
    if (!btn) return;
    YT.ccPaused = btn.getAttribute('aria-pressed') !== 'true';
    // 啟動時若 CC 是關的,立即套用隱藏 class(避免之前殘留的 caption-window 中文字幕在
    // 翻譯啟動瞬間又被看到)
    _setCcPausedHidingMode(YT.ccPaused);
    YT._ccButtonObserver = new MutationObserver(() => {
      const isOn = btn.getAttribute('aria-pressed') === 'true';
      const wasPaused = YT.ccPaused;
      const nextPaused = !isOn;
      if (wasPaused === nextPaused) return;
      YT.ccPaused = nextPaused;
      _setCcPausedHidingMode(nextPaused);
      if (nextPaused) {
        // 主動清掉 ASR overlay 殘留(_updateOverlay 在 ccPaused 時也會清,這裡是即時保險)
        if (YT.isAsr) _setOverlayContent('');
        // 「翻譯中…」status 在 CC 關閉後不該繼續顯示(CC 關 = 使用者明確要求隱藏字幕,
        // 此時 status indicator 殘留會違反「關 CC = 看不到任何字幕相關 UI」的預期)。
        hideCaptionStatus();
        SK.sendLog('info', 'youtube', 'cc paused (api hold)');
        return;
      }
      // CC 重開:對齊當前 currentTime 視窗 + 立刻續翻
      const video = YT.videoEl;
      if (!YT.active || !video) return;
      // ASR overlay 立刻依 currentTime 寫回(不等下一次 timeupdate)
      if (YT.isAsr) _updateOverlay();
      const config = YT.config || DEFAULT_YT_CONFIG;
      const windowSizeMs = (config.windowSizeS || 30) * 1000;
      const currentMs = video.currentTime * 1000;
      const newWindowStart = Math.floor(currentMs / windowSizeMs) * windowSizeMs;
      YT.translatedUpToMs = newWindowStart;
      SK.sendLog('info', 'youtube', 'cc resumed (api on)', {
        atMs: Math.round(currentMs),
        windowStartMs: newWindowStart,
      });
      if (YT.rawSegments.length > 0) {
        translateWindowFrom(newWindowStart);
      }
    });
    YT._ccButtonObserver.observe(btn, {
      attributes: true,
      attributeFilter: ['aria-pressed'],
    });
  }

  // ─── MutationObserver：即時替換字幕 ──────────────────────

  // ─── 字幕行展開（防止長譯文折行 + 維持置中）──────────────────────
  // 注入中文譯文後無條件展開字幕框：
  //   方法 A：segment 設 nowrap，確保文字不在 segment 內折行
  //   方法 B：向上走遍所有 block 容器，全部設 width: max-content
  //   方法 C：到達 caption-window 時修正置中定位——
  //     YouTube 原本用「left: 50% + margin-left: -固定寬/2」置中，
  //     寬度改為 max-content 後 margin-left 算法失效導致偏右；
  //     改為清除 margin-left，改用 transform: translateX(-50%) 置中，
  //     讓容器永遠以自身寬度的一半為中心點對齊 left: 50%。

  function expandCaptionLine(el) {
    // 方法 A：segment 自身設 nowrap，覆蓋 YouTube 預設的 pre-wrap
    el.style.whiteSpace = 'nowrap';
    // 方法 B + C：向上走所有 block 容器
    let node = el.parentElement;
    while (node && !node.classList.contains('ytp-caption-window-container')) {
      const display = getComputedStyle(node).display;
      if (display !== 'inline' && display !== 'inline-block') {
        node.style.maxWidth = 'none';
        node.style.width = 'max-content';
        if (node.classList.contains('caption-window')) {
          // YouTube 的 margin-left 是 -固定寬/2，寬度改後不再準確；
          // 改用 transform 置中，自動適應任意寬度
          node.style.marginLeft = '0';
          node.style.transform = 'translateX(-50%)';
          break; // caption-window 是最外需修改的層，到此為止
        }
      }
      node = node.parentElement;
    }
  }

  function replaceSegmentEl(el) {
    if (!SK.YT.active) return;
    // commit 5c.2:ASR 路徑雙語模式下保留英文 segment(中文由 overlay 顯示),否則
    // overlay 中文 + segment 中文 = 三層觀感(image 20)
    // commit 5c.4:非 ASR 路徑(人工字幕)沒有 G overlay,雙語應走「英文 + 譯文兩行」
    // 寫進 segment 的設計;單純 return 會只剩英文(image 22 bug)。所以只 gate ASR。
    if (SK.YT.config?.bilingualMode === true && SK.YT.isAsr === true) return;
    const original = el.textContent.trim();
    if (!original) return;
    const key = normText(original);

    // 快取命中(= 已知原文)→ 瞬間替換。先查 captionMap 再做自我迴圈判斷——
    // 舊寫法用 RE_CJK 一刀擋「含 CJK 的 original」防自己注入的譯文觸發回呼，但
    // ja/ko 源語的人工字幕原文本身就含 CJK，單語模式譯文永遠注入不進去(token 照燒
    // 字幕卻停在原文);target=en 時注入的英文不含 CJK，該防禦其實也擋不到。改比對
    // _injectedSegmentText(el 上最後注入的可見文字快照)，語言無關。
    const cached = SK.YT.captionMap.get(key);
    if (cached === undefined && _injectedSegmentText.get(el) === el.textContent) {
      return; // 自己注入譯文觸發的 characterData 回呼
    }
    if (cached !== undefined) {
      const YT = SK.YT;
      const isBilingual = YT.config?.bilingualMode === true;
      // v1.2.51: 第一次 cache hit = 使用者第一次「看到」翻譯字幕的時刻
      // (雙語 non-ASR 下 segment textContent 永遠保留英文,不能用 textContent 判,改靠 _firstCacheHitLogged 旗標 idempotent)
      if (cached && !YT._firstCacheHitLogged) {
        YT._firstCacheHitLogged = true;
        SK.sendLog('info', 'youtube', '🎯 first translated subtitle visible', {
          sessionOffsetMs: Date.now() - YT.sessionStartTime,
          videoNowMs: Math.round((YT.videoEl?.currentTime || 0) * 1000),
          captionMapSize: YT.captionMap.size,
          key: key.slice(0, 40),
        });
      }
      // v1.2.58: 每次中文字幕出現都呼叫 hideCaptionStatus(冪等)
      if (cached) hideCaptionStatus();

      // v1.8.42:雙語 non-ASR 改走獨立 overlay,不論 cached 是 trans 或 ''(multi-segment
      //         dedup),segment 都不動,讓 native 原文保留;由 _updateNonAsrBilingualOverlay
      //         收集 visible segments 寫到 overlay。純中文 non-ASR 把 cached 寫入 segment,
      //         空字串就清空(避免 multi-segment dedup 後續 segment 保留英文殘留)。
      if (isBilingual) {
        if (cached) _updateNonAsrBilingualOverlay();
      } else if (el.textContent !== cached) {
        _setSegmentText(el, cached);
        if (cached) expandCaptionLine(el);
      }
      return;
    }

    // 快取未命中(尚未翻譯到的視窗 / 子批 streaming 中)
    // ASR 模式(G 路徑):原生字幕已由 _setAsrHidingMode(true) 注入的 CSS 完全隱藏,
    // 我們的 overlay(<shinkansen-yt-overlay>)在 #movie_player 上自家渲染,
    // 不需要再動原生 caption-segment 的 textContent。直接 return 避免跟 YouTube
    // rolling captions append/update 競爭。
    if (SK.YT.isAsr) return;

    // 非 ASR(人工字幕)路徑:走 onTheFly 備案(若使用者開啟設定),否則保留原文等預翻命中快取
    // v1.2.49: onTheFly 關閉時不送 API,等預翻完成自然命中快取即可
    if (!SK.YT.config?.onTheFly) return;

    // v1.2.40: 計入 debug 面板的 on-the-fly 累計（每個 key 只算一次，避免同一字幕重複計）
    if (!_debugMissedKeys.has(key)) SK.YT.onTheFlyTotal++;
    if (SK.YT.config?.debugToast && !_debugMissedKeys.has(key)) {
      _debugMissedKeys.add(key);
      SK.sendLog('warn', 'youtube-debug', 'captionMap miss → on-the-fly', {
        domText: original,
        normKey: key,
        captionMapSize: SK.YT.captionMap.size,
        rawSegCount: SK.YT.rawSegments.length,
      });
    }
    if (!SK.YT.pendingQueue.has(key)) SK.YT.pendingQueue.set(key, []);
    SK.YT.pendingQueue.get(key).push(el);
    clearTimeout(SK.YT.batchTimer);
    SK.YT.batchTimer = setTimeout(flushOnTheFly, 300);
  }

  // 暴露給 spec 用(直接驗 cache-hit 路徑,不必走 translateYouTubeSubtitles 全流程)
  SK._replaceSegmentEl = replaceSegmentEl;

  // v1.8.53: CLEAR_CACHE 連帶清 in-memory 翻譯狀態。
  // Why:CLEAR_CACHE 原本只清 chrome.storage.local,但 captionMap / translatedWindows /
  //   displayCues 是 in-memory state。使用者「清快取後拖進度條」期待全部重來,實際:
  //     - translatedWindows.has(window) 仍 true → onSeeked guard 擋住「翻譯中…」status
  //     - 同 Set 也擋 translateWindowFrom 重發 API
  //     - captionMap 仍有 stale 譯文(但 storage 已清,下次 reload 會 cache miss)
  //   結果使用者拖到任意位置:看不到翻譯中、也不會重翻。
  // 不清 rawSegments / active / sessionUsage / translatingWindows—讓當前 session 延續,
  // in-flight 的 API call 完成後寫進新 Map / Set 也合法(reference 替換不影響 await 後的 .set/.add)。
  SK.YT._resetTranslationStateForCacheClear = function _resetTranslationStateForCacheClear() {
    const YT = SK.YT;
    if (!YT) return;
    YT.captionMap                = new Map();
    YT.translatedWindows         = new Set();
    YT.displayCues               = [];
    YT.translatedUpToMs          = 0;
    YT.captionMapCoverageUpToMs  = 0;
    // v2.0.54:不清會讓清快取後的重翻視窗把所有片段當「已取走」→ 收 0 條、字幕永久
    // 空白(cage 實測踩到:CLEAR_CACHE 後 translatedWindows=[120000,150000] 但
    // displayCues=0)。asrSegConsumed 必須跟 captionMap / translatedWindows 同生命週期
    YT.asrSegConsumed            = new Set();
    YT._firstCacheHitLogged      = false;
    hideCaptionStatus();
    // ASR overlay 內可能殘留中文 cue 文字(displayCues 已清,但渲染還在)。
    // v1.9.22:走 _setOverlayContent('') 而非直接砍 .window.textContent。後者會把
    // .cue-block / .src / .tgt 子元素一起銷毀,下次 _setOverlayContent 呼叫時
    // querySelector('.tgt') 回 null → `tgtEl.innerHTML` throw TypeError(實測使用者
    // CLEAR_CACHE 後拖進度條觸發,console 滿屏紅字)。_setOverlayContent('') 只清
    // 兩個 span 的 innerHTML,結構保留可重複使用。
    if (YT.isAsr) {
      _setOverlayContent('');
    }
    // sync ccPaused 從 CC button 當下 aria-pressed,避免 stale 旗標擋住後續
    // onVideoTimeUpdate / onVideoSeeked(_observeCcButton 的 MutationObserver 偶爾 race)
    const ccBtn = document.querySelector('.ytp-subtitles-button');
    if (ccBtn) YT.ccPaused = ccBtn.getAttribute('aria-pressed') !== 'true';
    SK.sendLog('info', 'youtube', 'CLEAR_CACHE: in-memory translation state reset', {
      videoId: YT.videoId,
      ccPaused: YT.ccPaused,
    });
    // 立刻從當前位置重啟翻譯—使用者「清快取重看」期待立刻看到「翻譯中…」+ 譯文,
    // 不該等 onVideoTimeUpdate 250ms tick(且 lookahead 邏輯在 translatedUpToMs=0 時
    // 行為微妙,直接以 currentTime 為起點最直觀)。
    if (YT.active && YT.rawSegments.length > 0 && !YT.ccPaused) {
      const video = YT.videoEl || document.querySelector('video');
      const config = YT.config || DEFAULT_YT_CONFIG;
      const windowSizeMs = (config.windowSizeS || 30) * 1000;
      const currentMs = video ? Math.floor(video.currentTime * 1000) : 0;
      const windowStartMs = Math.floor(currentMs / windowSizeMs) * windowSizeMs;
      YT.translatedUpToMs = windowStartMs;
      if (_shouldShowTranslatingStatus()) showCaptionStatus('翻譯中…');
      // 不 await—讓 reset call site 立刻回返;翻譯流程在背景跑
      translateWindowFrom(windowStartMs);
    }
  };

  async function flushOnTheFly() {
    const YT = SK.YT;
    if (YT.pendingQueue.size === 0 || YT.flushing) return;
    if (!YT.active) return; // v1.8.20: 進場 guard,session 已 stop 直接放棄
    // v2.0.78（批次 3 C1）：世代快照——其他三個 async 寫回點（_runAsrSubBatch /
    // heuristic _runBatch / _injectBatchResult）都做 active + captionSourceGen 雙守門，
    // on-the-fly 原本只查 active：SPA 換片 stop（gen bump）→ 500ms auto-restart 把
    // active 翻回 true → 舊批次 resolve 通過檢查，把舊影片譯文寫進新 session 的 captionMap
    const _myGen = YT.captionSourceGen || 0;
    YT.flushing = true;

    const queue = new Map(YT.pendingQueue);
    YT.pendingQueue.clear();
    const texts = Array.from(queue.keys());

    if (YT.config?.debugToast) {
      SK.sendLog('info', 'youtube-debug', 'flushOnTheFly batch', {
        count: texts.length,
        texts,
      });
    }

    try {
      // 依 ytSubtitle.engine 路由(on-the-fly 用人工字幕資料，跟非 ASR 字幕同性質)
      const _onTheFlyMsgType = SK.getSubtitleBatchType(YT.config?.engine, false);
      const res = await SK.safeSendMessage({
        type: _onTheFlyMsgType,
        payload: { texts, glossary: null },
      });
      if (!res?.ok) throw new Error(SK.i18n.bgErrorMessage(res) || SK.t('common.errorUnknown'));
      // v1.8.20: await 後再次檢查 active——stop 在 await 期間發生時放棄寫入，
      // 否則寫進已被 stopYouTubeTranslation 重置的新 captionMap 污染下個 session。
      // v2.0.78：補 gen 比對（stop 後 auto-restart 會把 active 翻回 true，只查 active 擋不住）
      if (!SK.YT.active || _myGen !== (SK.YT.captionSourceGen || 0)) {
        YT.flushing = false;
        return;
      }
      // v1.2.39: 累積並記錄 on-the-fly 批次用量
      _logWindowUsage(texts.length, res.usage);

      // v1.10.39(code review 2026-06-09 M8):防 res.ok=true 但 res.result 缺失 throw
      const results = res.result || [];
      for (let i = 0; i < texts.length; i++) {
        const key = texts[i];
        // v1.8.10 A:strip LLM 偷懶殘留的 SEP / «N» 標記
        const trans = SK.sanitizeMarkers(results[i] || texts[i]);
        YT.captionMap.set(key, trans);
        const isBilingual = YT.config?.bilingualMode === true;
        for (const el of (queue.get(key) || [])) {
          if (document.contains(el) && normText(el.textContent) === key) {
            // v1.8.42:雙語 non-ASR 不動 segment innerHTML(讓 native 原文保留),
            //         由 _updateNonAsrBilingualOverlay 收集寫到 overlay;純中文 trans
            //         是 '' 也要寫入 segment(清空,避免 multi-segment dedup 後續
            //         segment 保留英文殘留)。
            if (isBilingual) {
              if (trans) _updateNonAsrBilingualOverlay();
            } else {
              _setSegmentText(el, trans);
            }
          }
        }
      }
      // iOS 原生全螢幕字幕軌:on-the-fly 也更新了 captionMap → 刷新(非 iOS early return)
      _scheduleIosFsTrackRefresh();
    } catch (err) {
      SK.sendLog('warn', 'youtube', 'on-the-fly flush error', { error: err.message });
      _notifyTranslationError(err.message);
    }

    YT.flushing = false;
    if (YT.pendingQueue.size > 0) setTimeout(flushOnTheFly, 100);
  }
  // 暴露給 spec 端直接驅動 on-the-fly 批次路徑(M8 res.result 缺失防禦回歸測試用),
  // 不影響 production behaviour。
  SK._flushOnTheFly = flushOnTheFly;

  function startCaptionObserver() {
    const YT = SK.YT;
    if (YT.observer) { YT.observer.disconnect(); YT.observer = null; }

    // 先替換現有字幕
    document.querySelectorAll('.ytp-caption-segment').forEach(replaceSegmentEl);

    YT.observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.classList.contains('ytp-caption-segment')) {
            replaceSegmentEl(node);
          } else {
            node.querySelectorAll?.('.ytp-caption-segment').forEach(replaceSegmentEl);
          }
        }
        if (m.type === 'characterData') {
          const parent = m.target.parentElement;
          if (parent?.classList?.contains('ytp-caption-segment')) {
            replaceSegmentEl(parent);
          }
        }
      }
      // v1.8.42:雙語 non-ASR 模式下,native caption-window 內容 / 行數變動會觸發
      //         上面的 mutation;順手重算 overlay anchor 與內容,確保中文永遠
      //         貼在當前英文 CC 上方(2 行 → 行數變化撐高 cw → anchor 跟著上抬)。
      if (YT.config?.bilingualMode === true && !YT.isAsr) {
        _updateNonAsrBilingualOverlay();
      }
    });

    const root =
      document.querySelector('.ytp-caption-window-container') ||
      document.querySelector('#movie_player') ||
      document.body;

    YT.observer.observe(root, { childList: true, subtree: true, characterData: true });
    SK.sendLog('info', 'youtube', 'caption observer started', {
      root: root.className || root.tagName,
      translatedUpToMs: YT.translatedUpToMs,
    });
    _debugUpdate(`Observer 已啟動（root: ${root.className?.slice(0,30) || root.tagName}）`);
  }

  // ─── v1.2.39: 用量累積與紀錄 ──────────────────────────────
  // 每次 TRANSLATE_SUBTITLE_BATCH 回傳後，累積到 YT.sessionUsage；
  // 同時立刻送出 LOG_USAGE（逐批紀錄，方便查看每段字幕的費用細目）。

  function _logWindowUsage(batchTexts, usage) {
    if (!usage || (usage.inputTokens === 0 && usage.cacheHits === 0)) return;
    const YT = SK.YT;
    const u = usage;

    // 累積 session 合計
    YT.sessionUsage.inputTokens     += u.inputTokens     || 0;
    YT.sessionUsage.outputTokens    += u.outputTokens    || 0;
    YT.sessionUsage.cachedTokens    += u.cachedTokens    || 0;
    YT.sessionUsage.billedInputTokens += u.billedInputTokens || 0;
    YT.sessionUsage.billedCostUSD   += u.billedCostUSD   || 0;
    YT.sessionUsage.segments        += batchTexts;
    YT.sessionUsage.cacheHits       += u.cacheHits       || 0;

    // 取得本次使用的模型名稱（from config，若設定了 ytModel 就帶入）
    const model = (YT.config?.model) || undefined;

    SK.safeSendMessage({
      type: 'LOG_USAGE',
      payload: {
        url:   location.href,
        title: document.title,
        source: 'youtube-subtitle',
        videoId: YT.videoId || getVideoIdFromUrl(),  // v1.4.18: 合併用 key
        model,
        inputTokens:      u.inputTokens     || 0,
        outputTokens:     u.outputTokens    || 0,
        cachedTokens:     u.cachedTokens    || 0,
        billedInputTokens: u.billedInputTokens || 0,
        billedCostUSD:    u.billedCostUSD   || 0,
        segments:         batchTexts,
        cacheHits:        u.cacheHits       || 0,
        durationMs:       0,  // 字幕翻譯是串流式，不計整頁耗時
        timestamp:        Date.now(),
      },
    }).catch(() => {});
  }

  // ─── 停止 ─────────────────────────────────────────────────

  function stopYouTubeTranslation() {
    const YT = SK.YT;
    clearTimeout(YT.batchTimer);
    YT.batchTimer = null;
    if (YT.observer) { YT.observer.disconnect(); YT.observer = null; }
    _teardownIosFsTrack();   // iOS 全螢幕字幕軌:清 cue + 解綁 fullscreen 事件(須在 videoEl 清空前)
    if (YT.videoEl) {
      YT.videoEl.removeEventListener('timeupdate',  onVideoTimeUpdate);
      YT.videoEl.removeEventListener('seeked',      onVideoSeeked);    // v1.3.1: 補漏
      YT.videoEl.removeEventListener('ratechange',  onVideoRateChange); // v1.3.1: 補漏
      YT.videoEl = null;
    }
    YT.active             = false;
    // 世代 bump:stop / SPA 換片後 500ms auto-restart 會把 active 翻回 true,
    // 只靠 active 檢查擋不住舊影片 in-flight 批次寫進新 session——所有 async
    // 寫回點(_runAsrSubBatch / heuristic _runBatch / _injectBatchResult /
    // translateWindowFrom 收尾)都比對此世代，失配即丟棄
    YT.captionSourceGen   = (YT.captionSourceGen || 0) + 1;
    YT.translatingWindows = new Set();  // v1.2.54
    YT.translatedWindows  = new Set();  // v1.3.5: 補齊（原僅在 translateYouTubeSubtitles 重置）
    YT.translatedUpToMs   = 0;
    YT.rawSegments        = [];         // v1.3.5: 補齊（原僅在 yt-navigate-finish 重置）
    YT.captionMap         = new Map();
    YT.pendingQueue       = new Map();
    YT.flushing           = false;       // v1.8.20: 確保下個 session 重啟後 flushOnTheFly 不被舊 flag 卡住
    YT.isAsr              = false;
    YT.captionLang        = null;       // v1.10.46: 補漏——殘留會讓下支影片 activation 早期用舊 lang 跑 already-in-target 判斷
    YT.captionSourceId    = null;       // v1.10.46: 來源身份隨 session 結束失效
    YT.displayCues        = [];         // G 路徑:清 overlay 顯示單位
    YT.asrSegConsumed     = new Set();  // v2.0.54: captionMap 已清,取用紀錄留著會讓重啟後片段永遠不再送翻
    YT.ccPaused           = false;
    if (YT._ccButtonObserver) {
      YT._ccButtonObserver.disconnect();
      YT._ccButtonObserver = null;
    }
    _clearMwebCcRetry(); // mweb auto-CC 重試排程一併停掉
    _setCcPausedHidingMode(false);
    _setAsrHidingMode(false);
    _removeOverlay();
    hideCaptionStatus(); // v1.2.55
    _debugRemove();
    SK.sendLog('info', 'youtube', 'stopped');
  }

  SK.stopYouTubeTranslation = stopYouTubeTranslation;

  // 沒字幕 toast 顯示前先看影片標題語言:若標題已是目標語言 → silent skip
  // (影片大概就是 target 語言發音,使用者本來就不需要翻譯字幕,toast 變干擾)。
  // og:title YouTube 每個 watch page 都有,內容是純標題不含 " - YouTube" 後綴。
  function _maybeShowNoSubtitleToast() {
    const target = SK.STATE?.targetLanguage || 'zh-TW';
    const ogEl = document.querySelector('meta[property="og:title"]');
    const ogTitle = (ogEl && ogEl.getAttribute('content')) || '';
    const titleIsTarget = ogTitle
      && typeof SK.isAlreadyInTarget === 'function'
      && SK.isAlreadyInTarget(ogTitle, target);
    if (titleIsTarget) {
      SK.sendLog('info', 'youtube', 'no-subtitle toast silenced (title already in target)', {
        target, ogTitleSample: ogTitle.slice(0, 40),
      });
      return;
    }
    SK.showToast('error', SK.t('toast.subtitleNotAvailable'), { autoHideMs: 5000 });
  }
  SK._maybeShowNoSubtitleToast = _maybeShowNoSubtitleToast;  // 暴露給 spec

  // ─── 主入口:popup toggle / SPA auto-restart ─────────────
  // 字幕翻譯由 popup「翻譯字幕」勾選驅動,或由 content-script init / SPA nav 在
  // 自動續啟動偏好開啟時觸發。Alt+S 是「頁面文字翻譯」(handleTranslatePreset),
  // 跟字幕翻譯互不相關。

  // v1.8.16: source 區分使用者明示 toggle vs 自動啟動。
  //   'manual'(預設,popup toggle / SET_SUBTITLE):active 時 toggle 還原(再按一次語義)
  //   'auto'(content-script init / SPA nav restart):active 時 no-op,
  //     避免兩條自動鬧鐘在 reload 後 race 互相關掉對方。
  SK.translateYouTubeSubtitles = async function translateYouTubeSubtitles({ source = 'manual' } = {}) {
    const YT = SK.YT;

    if (YT.active) {
      if (source === 'auto') {
        SK.sendLog('info', 'youtube', 'auto-activate skipped (already active)', { rawSegments: YT.rawSegments.length });
        return;
      }
      // manual:再按一次還原
      stopYouTubeTranslation();
      SK.showToast('success', SK.t('toast.subtitleRestored'));
      setTimeout(() => SK.hideToast(), 2000);
      return;
    }

    YT.active  = true;
    YT.videoId = getVideoIdFromUrl();
    YT.config  = null; // 強制重新讀取設定
    // v1.2.39: 重置用量累積器
    YT.sessionUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, billedInputTokens: 0, billedCostUSD: 0, segments: 0, cacheHits: 0 };
    YT.sessionStartTime = Date.now();
    // v1.2.40: 重置 debug 診斷欄位
    YT.lastApiMs           = 0;
    YT.batchApiMs          = [];   // v1.2.43
    YT.adaptiveLookaheadMs = 0;    // v1.2.44
    YT.staleSkipCount            = 0;    // v1.2.45
    YT.captionMapCoverageUpToMs  = 0;    // v1.2.46
    YT.translatedWindows         = new Set(); // v1.2.48
    YT.translatingWindows        = new Set(); // v1.2.54
    YT.onTheFlyTotal             = 0;
    YT.firstBatchSize            = 8;         // v1.2.50
    YT.lastLeadMs                = 0;         // v1.2.50
    YT._firstCacheHitLogged      = false;     // v1.2.51
    YT._autoCcToggled            = false;     // v1.6.20 A 路徑:每次啟動翻譯重置 auto-CC 旗標
    _clearMwebCcRetry();                      // mweb auto-CC 重試計數 / 排程歸零(新影片重新計)
    YT._errorNotified            = false;
    YT.ccPaused                  = false;     // attachVideoListener → _observeCcButton 會依 CC 實際狀態重設
    YT.displayCues               = [];        // G 路徑:啟動時清空 overlay cue,等本影片字幕回來

    // 提前掛 video 監聽器，不等字幕資料回來（使用者可能在等待期間拖進度條）
    attachVideoListener();

    const config = await getYtConfig();
    _debugUpdate('字幕翻譯已啟動，等待 CC 字幕資料…');

    // v1.8.42:確保 player root class / stylesheet / overlay 狀態對齊雙語設定。
    //         captionsXHR 可能在 user 按 translate 之前已被 browser cache、本 session
    //         不再觸發,line 558 的 _applyBilingualMode 沒機會跑;這裡補一次,
    //         讓 _setAsrHidingMode(true) 把 native CC 藏掉(雙語下中英都搬 overlay)
    _applyBilingualMode(config.bilingualMode === true);

    // observer 提前啟動：captionMap 尚空時 cache miss → 字幕保持原文
    // 待 shinkansen-yt-captions 填入 rawSegments 後，translateWindowFrom 寫入 captionMap，字幕瞬間替換
    startCaptionObserver();

    // ─── Caption track 自動選擇（P1 native skip / P2-3 switch to original) ───
    // 解 YT 帳號 auto-translate 偏好套用到全部影片時 Shinkansen 拿到的不是原始 ASR
    // 而是 YT 已翻譯後 zh-Hans 字幕的問題（_chooseBestCaptionTrack 註解詳述）。
    if (config.preferOriginalTrack !== false) {
      const { targetLanguage = 'zh-TW' } = await browser.storage.sync.get('targetLanguage');
      const action = await _runCaptionTrackChooser(targetLanguage);
      // skip / switch-to-native:YT 顯示 native target,Shinkansen 沒翻譯工作
      // - 單語:stopYouTubeTranslation 清監聽(target 顯示就是終點)
      // - 雙語:留 Shinkansen 監聽,等使用者手動切到非 target 軌 → XHR interceptor 抓到後
      //        translateWindowFrom(line 586 自動觸發)→ captionMap 寫入 → _applyBilingualMode
      //        在 caption 非 target 時自動藏 native + 顯示 overlay
      //        順帶 fire 一次提示 toast 告訴使用者「要看雙語請從 CC 選單切」
      if (action === 'skip' || action === 'switch-to-native') {
        const isBilingual = config.bilingualMode === true;
        SK.sendLog('info', 'youtube', `activation ${isBilingual ? 'kept-listening-for-bilingual' : 'skipped'} (${action})`, { action, isBilingual });
        if (!isBilingual) {
          stopYouTubeTranslation();
        } else if (action === 'switch-to-native' && typeof SK.showToast === 'function') {
          // 一次性 hint:讓使用者知道為什麼 bilingual 沒立刻啟動
          SK.showToast('info', '已自動切到原生繁中字幕。如需雙語對照,請從 YT CC 選單手動切到要對照的源語(如英文或日文)', {
            autoHideMs: 7000,
          });
        }
        return;
      }
      if (action === 'switch') {
        // 清掉 YT 自翻譯軌可能已塞進來的舊 rawSegments，並重置全部視窗簿記
        // (v1.10.46: 原本只清 rawSegments / captionMap，漏 translatedWindows / displayCues 等
        //  → in-flight 舊軌完成仍標 translatedWindows，新軌已翻視窗被誤跳過）。
        // setOption 後新 track 的 /api/timedtext 會回新 caption,XHR listener wholesale 覆蓋。
        YT.rawSegments = [];
        YT.captionSourceId = null; // 新軌 XHR 進來時建立新身份（避免再次觸發 reset）
        _resetCaptionSourceBookkeeping('chooser switch');
      }
    }

    if (YT.rawSegments.length > 0) {
      // 已有快取（interceptor 在 activate 之前就攔截到了）→ 直接開始翻譯
      _debugUpdate(`已有 ${YT.rawSegments.length} 條字幕，開始翻譯`);
      if (_shouldShowTranslatingStatus()) showCaptionStatus('翻譯中…');
      const video = document.querySelector('video');
      const currentMs = video ? Math.floor(video.currentTime * 1000) : 0;
      const windowSizeMs = (config.windowSizeS || 30) * 1000;
      const windowStartMs = Math.floor(currentMs / windowSizeMs) * windowSizeMs;
      await translateWindowFrom(windowStartMs);
      // hideCaptionStatus 由第一條中文字幕出現時觸發（replaceSegmentEl 內呼叫）
    } else {
      // 尚未攔截到字幕：CC 可能還沒開，或播放器尚未發出 XHR
      // → shinkansen-yt-captions 事件的 handler 會在字幕到來時接手翻譯

      // v1.9.9 早期判定 + 等待狀態延後:
      //   A) ytInitialPlayerResponse bridge poll(videoId 對 URL 比對防 stale):
      //      確認沒字幕 → 立即 silent / toast + 不顯示「等待字幕資料」+ cancel 1s/5s tick。
      //   B) bridge 確認「有字幕」/「給上(unknown)」→ 顯示等待狀態,跑原 1s + 5s tick。
      //
      // SPA 導航後 ytInitialPlayerResponse 可能 lag 於 URL — 不重 retry 會把舊影片資料
      // 當新影片的權威訊號用(例:中文無字幕影片 → 英文有字幕影片,bridge 還回舊的
      // captionTracks=null,新影片被誤判為「沒字幕 + 中文標題 silent」,完全不翻)。
      let noCaptionsConfirmed = false;
      let captionsConfirmedByBridge = false; // v1.10.46: bridge 確認「有字幕軌」——tick5 不得誤報「沒有字幕」
      let bridgeFinalDecision = false; // 任何 trust 的 bridge response(no-captions / has-captions)都算「不必再 retry」
      let tick1Handle = null;
      let tick5Handle = null;
      let bridgeAttempts = 0;
      const MAX_BRIDGE_ATTEMPTS = 4;
      const BRIDGE_RETRY_MS = 200;
      const activateVideoId = getVideoIdFromUrl();
      // 世代快照：tick1/tick5/65s timer 是 closure 區域變數，stop 拿不到——SPA 換片
      // stop → 500ms auto-restart 後 active 又是 true，舊 session 的 timer 光看 active
      // 擋不住，會拿舊 session 的 captionsConfirmedByBridge 對新影片誤判「沒有字幕」。
      // 靠 stop 的 captionSourceGen bump 讓舊 timer fire 時自我作廢
      const _sessionGen = SK.YT.captionSourceGen || 0;
      const _sessionAlive = () => SK.YT.active && (SK.YT.captionSourceGen || 0) === _sessionGen;

      const showWaitingStatus = () => {
        // 只有「已確認沒字幕」才該禁止 show;「有字幕」決定要 show 等待是預期行為
        if (noCaptionsConfirmed || !SK.YT.active) return;
        if (SK.YT.rawSegments.length > 0) return; // captions 已到達(skip/translate)
        showCaptionStatus('等待字幕資料…');
      };

      const queryAndDecide = () => {
        if (bridgeFinalDecision || !_sessionAlive()) return;
        if (bridgeAttempts >= MAX_BRIDGE_ATTEMPTS) {
          showWaitingStatus(); // 給上 → 顯示等待狀態,讓 1s/5s tick 接手
          return;
        }
        bridgeAttempts++;
        const handler = (e) => {
          window.removeEventListener('shinkansen-yt-player-response', handler);
          if (bridgeFinalDecision || !SK.YT.active) return;
          const detail = e?.detail || {};
          const currentVideoId = getVideoIdFromUrl();
          // videoId mismatch / playerResponse 不可用 → stale,retry
          const videoIdMatch = detail.videoId
            && currentVideoId
            && detail.videoId === currentVideoId
            && currentVideoId === activateVideoId; // activate 後若 URL 又變過,放棄這次決定
          if (!videoIdMatch || !detail.playerResponseAvailable) {
            setTimeout(queryAndDecide, BRIDGE_RETRY_MS);
            return;
          }
          // videoId 對上 + playerResponse 可讀 = trust 此 response
          const tracks = detail.captionTracks;
          const hasCaptions = Array.isArray(tracks) && tracks.length > 0;
          bridgeFinalDecision = true; // trust 之後就不再 retry
          if (hasCaptions) {
            captionsConfirmedByBridge = true; // v1.10.46: tick5 據此延長等待而非彈「沒有字幕」
            showWaitingStatus(); // 有字幕要等 → 顯示等待狀態
            return;
          }
          // 確認沒字幕(playerCaptionsTracklistRenderer 缺失或 captionTracks=[])
          noCaptionsConfirmed = true;
          if (tick1Handle) clearTimeout(tick1Handle);
          if (tick5Handle) clearTimeout(tick5Handle);
          hideCaptionStatus(); // 防呆:萬一前一輪 attempt 已 fall back showStatus 過
          _maybeShowNoSubtitleToast();
          SK.sendLog('info', 'youtube', 'no-captions confirmed via ytInitialPlayerResponse', {
            videoId: currentVideoId, attempts: bridgeAttempts,
          });
        };
        window.addEventListener('shinkansen-yt-player-response', handler);
        window.dispatchEvent(new CustomEvent('shinkansen-yt-query-player-response'));
        // bridge listener 沒回(test fixture without bridge) safety net
        setTimeout(() => {
          window.removeEventListener('shinkansen-yt-player-response', handler);
          if (bridgeFinalDecision || !_sessionAlive()) return;
          if (bridgeAttempts >= MAX_BRIDGE_ATTEMPTS) {
            showWaitingStatus();
            return;
          }
          setTimeout(queryAndDecide, BRIDGE_RETRY_MS);
        }, BRIDGE_RETRY_MS);
      };
      queryAndDecide();

      // 1 秒後若仍無 XHR → 主動 toggle CC 讓播放器重新抓字幕
      // (noCaptionsConfirmed 在 no-captions branch 已 cancel 此 tick;走到 = 有字幕 / 未決,
      //  讓 forceSubtitleReload 觸發 XHR)
      tick1Handle = setTimeout(() => {
        if (_sessionAlive() && SK.YT.rawSegments.length === 0) {
          forceSubtitleReload();
        }
      }, 1000);

      // 5 秒後若仍無資料 → fallback 判定「沒字幕」並考慮 toast
      tick5Handle = setTimeout(() => {
        if (_sessionAlive() && SK.YT.rawSegments.length === 0) {
          // v1.10.46: bridge 已確認本影片有字幕軌（常見：preroll 廣告期播放器還沒發
          // timedtext XHR)→ 不彈「沒有字幕」誤報，維持等待狀態，交給有界 CC retry
          // 繼續催（rawSegments 一進來自動停；上限 60s，擋無限重試）。
          if (captionsConfirmedByBridge) {
            _scheduleMwebCcRetry();
            // retry 預算（60s）跑完的最後檢查：仍沒字幕才收尾，不讓「等待字幕資料…」掛死
            tick5Handle = setTimeout(() => {
              if (_sessionAlive() && SK.YT.rawSegments.length === 0) {
                hideCaptionStatus();
                _maybeShowNoSubtitleToast();
              }
            }, 65000);
            return;
          }
          if (SK.YT.captionMap.size > 0) {
            hideCaptionStatus();
          } else {
            hideCaptionStatus();
            _maybeShowNoSubtitleToast();
          }
        }
      }, 5000);
    }

    SK.sendLog('info', 'youtube', 'activated', {
      videoId: YT.videoId,
      rawSegments: YT.rawSegments.length,
      windowSizeS: config.windowSizeS,
      lookaheadS:  config.lookaheadS,
    });
  };

  // ─── SPA 導航重置 ──────────────────────────────────────────

  // 桌面 www fire 'yt-navigate-finish';mweb(m.youtube.com)不 fire 它,改 fire
  // 'state-navigateend'(probe 實證)。同一 handler 掛兩個事件名:各平台只會 fire
  // 自己那個,且 handler 開頭的同 videoId guard 讓萬一重複 fire 也是 no-op。
  async function _onYtSpaNavigate() {
    const YT = SK.YT;
    // v1.8.68: YouTube SPA 在 quality 切換 / ad break 結束 / player re-mount /
    // theatre-fullscreen 切換等情境會 fire 假性 yt-navigate-finish(同一影片頁、
    // videoId 沒變)。原本一律走 reset path → captionMap / displayCues / overlay
    // 全清 + force reload XHR(~10 秒)→ 使用者看到「中文字幕閃一下變回英文一陣子
    // 才回到中文」。同 videoId + 翻譯仍 active 時跳過 reset 即可,真正的影片切換
    // (newVideoId !== YT.videoId)、離開 watch 頁(newVideoId === null)仍走原路徑。
    const _newVideoId = getVideoIdFromUrl();
    if (YT.active && _newVideoId && _newVideoId === YT.videoId) {
      // v1.10.46: 假導航的觸發情境（player re-mount / quality 切換）正是 video element
      // 可能被重建的情境——舊 element 上的 timeupdate / seeked 監聽全斷，字幕推進停擺。
      // attachVideoListener 冪等（同 element early return），補一次成本近零。
      attachVideoListener();
      SK.sendLog('info', 'youtube', 'SPA nav skipped (same videoId, still active)', { videoId: _newVideoId });
      return;
    }
    const wasActive = YT.active;  // v1.3.1: 記錄是否需要在新影片自動重啟
    if (YT.active) stopYouTubeTranslation(); // stopYouTubeTranslation 內已呼叫 hideCaptionStatus + _debugRemove
    hideCaptionStatus(); // v1.2.55: 確保 SPA 導航後殘留的提示也清掉
    _debugRemove(); // 確保即使非 active 狀態也清掉面板（內含 _debugMissedKeys.clear()）
    YT.rawSegments        = [];
    YT.captionMap         = new Map();
    YT.pendingQueue       = new Map();      // v1.3.5: 確保清理 on-the-fly 佇列
    YT.translatedUpToMs   = 0;
    YT.translatedWindows  = new Set();      // v1.3.5: 明確重置（原在 translateYouTubeSubtitles 重置）
    YT.translatingWindows = new Set();      // v1.3.5: 防止 SPA nav 期間的殘留視窗阻塞
    YT.isAsr              = false;
    YT.captionLang        = null;           // v1.10.46: 補漏——新影片 activation 早期不可用前一支影片的 lang
    YT.captionSourceId    = null;           // v1.10.46: 來源身份跨影片失效
    YT.displayCues        = [];             // G 路徑:SPA nav 清 overlay 顯示單位
    _setAsrHidingMode(false);
    _removeOverlay();
    YT.config             = null;
    YT.videoId            = getVideoIdFromUrl();
    SK.sendLog('info', 'youtube', 'SPA navigation reset', { wasActive, newVideoId: YT.videoId });

    // v1.3.1: SPA 導航後自動重啟字幕翻譯
    // 條件：之前字幕翻譯已啟動（wasActive），或 ytSubtitle.autoTranslate 設定開啟
    // 若導航到非 watch 頁（例如首頁），略過。
    // 延遲 500ms 等 YouTube 播放器初始化並發出新字幕 XHR
    if (!SK.isYouTubePage?.()) return;
    try {
      const saved = await browser.storage.sync.get('ytSubtitle');
      const shouldRestart = wasActive || saved.ytSubtitle?.autoTranslate;
      if (shouldRestart) {
        SK.sendLog('info', 'youtube', 'SPA nav: will restart subtitle translation', {
          wasActive, autoTranslate: saved.ytSubtitle?.autoTranslate,
        });
        setTimeout(() => {
          // v1.8.16: 改傳 source: 'auto',若 active 走 no-op 而非 toggle stop。
          //   原本就有 !SK.YT.active 前置 guard,但兩條保險(前置 guard + source='auto')
          //   覆蓋 setTimeout 排隊期間 active 才被另一條 caller 拉起的 race。
          if (SK.isYouTubePage?.()) {
            SK.translateYouTubeSubtitles?.({ source: 'auto' }).catch(err => {
              SK.sendLog('warn', 'youtube', 'SPA nav auto-subtitle restart failed', { error: err.message });
            });
          }
        }, 500);
      }
    } catch (err) {
      SK.sendLog('warn', 'youtube', 'SPA nav autoTranslate check failed', { error: err.message });
    }
  }
  window.addEventListener('yt-navigate-finish', _onYtSpaNavigate);   // 桌面 www
  window.addEventListener('state-navigateend', _onYtSpaNavigate);    // 行動版 mweb

  // commit 5c:bilingualMode 即時切換(toggle 不需要 reload 影片頁)
  // v1.8.42:non-ASR 也支援 toggle live,_applyBilingualMode 內會分流處理
  //         (ASR 動 player class、non-ASR 重跑 segment;內部都有 active guard)。
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.ytSubtitle) return;
    const newVal = changes.ytSubtitle.newValue || {};
    const newBilingual = newVal.bilingualMode === true;
    if (SK.YT.config) SK.YT.config.bilingualMode = newBilingual;
    if (SK.YT.active) {
      _applyBilingualMode(newBilingual);
      SK.sendLog('info', 'youtube', 'bilingualMode toggled live', { bilingual: newBilingual, isAsr: SK.YT.isAsr });
    }
    // 字幕字級 scale:設定變更即時套用(overlay --sk-cue-size + iOS ::cue,見 _applyYtCaptionScale)
    if ('captionScale' in newVal) _applyYtCaptionScale(newVal.captionScale);
  });

  // 字幕字級 scale 初值:模組載入時讀一次
  browser.storage.sync.get('ytSubtitle').then((s) => {
    const sc = s?.ytSubtitle?.captionScale;
    if (sc != null) _applyYtCaptionScale(sc);
  }).catch(() => { /* 預設 100 */ });

  // ─── 對外 export:給 content-drive.js(Drive ASR commit 3+)共用 ─────
  // parseJson3:json3 → raw segments [{text, normText, startMs, groupId}]
  // mergeAsr:啟發式合句(kle/Ile/Lle 三段)→ [{startMs, endMs, text, sourceSegs}]
  // Drive ASR 路徑跟 YouTube ASR 路徑共用同一份字幕格式與合句啟發式,
  // 只差注入路徑(player same-frame DOM vs cross-origin iframe 浮層)。
  SK.ASR = {
    parseJson3,
    mergeAsr: _heuristicMergeAsr,
    parseAsrResponse: _parseAsrResponse,
    // v2.0.54: entry 驗證 + 顯示時間軸分割（YT / Drive 共用,取代 normalizeAsrEntry
    // 逐條驗證——LLM 的 e 不再採信,詳見 _resolveAsrEntryTimeline 註解)
    resolveEntryTimeline: _resolveAsrEntryTimeline,
    batchEndMs: _asrBatchEndMs,
    // v2.0.54: 超長合句 code 端保底拆分(YT overlay / Drive 浮層共用,詳見
    // _splitLongAsrCue 註解)
    splitLongCue: _splitLongAsrCue,
  };

})(window.__SK);
