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
    // v1.6.20 G 路徑:ASR 字幕 overlay 用顯示單位 [{ startMs, endMs, sourceText, targetText }]。
    //   onVideoTimeUpdate 根據 video.currentTime 找出當前該顯示的 cue 寫入 overlay。
    //   整句進整句出,不依賴 YouTube 原生 caption-segment(避免 ASR 一字一字跳)。
    displayCues:              [],
  };

  // ─── 工具 ──────────────────────────────────────────────────

  SK.isYouTubePage = function isYouTubePage() {
    return location.hostname === 'www.youtube.com'
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
    const seen = new Set();
    let groupCounter = 0;
    for (const ev of (json.events || [])) {
      if (!ev.segs) continue;
      const full = ev.segs.map(s => s.utf8 || '').join('');
      // YouTube 以 \n 分隔同一 event 內的多行歌詞；DOM 每行獨立渲染為一個 .ytp-caption-segment
      // 拆行後分別建立條目，確保 normText 與 DOM 字幕對齊，避免落入 on-the-fly
      // preserveLineBreaks 開啟時，同一 event 的多行共用 groupId，供整組送翻
      const lines = full.split('\n').map(l => l.trim()).filter(Boolean);
      const groupId = lines.length > 1 ? groupCounter++ : null;
      for (const line of lines) {
        if (seen.has(line)) continue;
        seen.add(line);
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
    const seen = new Set();
    for (const el of els) {
      const t = el.textContent.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
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

  window.addEventListener('shinkansen-yt-captions', async (e) => {
    const { url, responseText } = e.detail || {};
    if (!responseText) return;

    const segments = parseCaptionResponse(responseText);
    if (segments.length === 0) return;

    const YT = SK.YT;
    YT.rawSegments = segments;
    // D' 模式偵測：URL 含 kind=asr 即為 YouTube 自動產生字幕，
    // 走「LLM 自由合句 + 時間戳對齊」路徑(timestamp mode)
    // 而非逐條翻譯——後者對 1-3 字短條無法產生有意義譯文。
    try {
      const u = new URL(url, location.href);
      YT.isAsr = u.searchParams.get('kind') === 'asr';
    } catch (_) {
      YT.isAsr = false;
    }
    // G 路徑:ASR 字幕一進來就 enable hiding mode + 預建 overlay 容器,
    //         避免使用者啟動翻譯瞬間還看到原生英文字幕跳動。
    // commit 5c:bilingualMode=true → 不隱藏原生 CC(中英對照);false=純中文(既有行為)
    if (YT.isAsr) {
      const cfg = YT.config || await getYtConfig();
      _ensureOverlay();
      _applyBilingualMode(cfg.bilingualMode === true);
    }
    const lastMs = segments[segments.length - 1]?.startMs ?? 0;
    SK.sendLog('info', 'youtube', 'XHR captions captured', {
      segmentCount: segments.length,
      lastMs,
      isAsr: YT.isAsr,
      urlSnippet: url ? url.substring(url.indexOf('/api/timedtext'), Math.min(url.length, url.indexOf('/api/timedtext') + 60)) : '',
    });

    if (YT.active) {
      // translateYouTubeSubtitles 已啟動但在等待（rawSegments 剛被填入）
      // 直接觸發當前視窗的翻譯
      const video = document.querySelector('video');
      const currentMs = video ? Math.floor(video.currentTime * 1000) : 0;
      const config = YT.config || await getYtConfig();
      const windowSizeMs = (config.windowSizeS || 30) * 1000;
      const windowStartMs = Math.floor(currentMs / windowSizeMs) * windowSizeMs;
      _debugUpdate(`XHR 攔截 ${segments.length} 條字幕（至 ${Math.round(lastMs / 1000)}s），開始翻譯`);
      if (!_hasVisibleChineseCaption()) showCaptionStatus('翻譯中…');
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

  async function forceSubtitleReload() {
    const btn = document.querySelector('.ytp-subtitles-button');
    if (!btn) {
      SK.sendLog('warn', 'youtube', 'forceSubtitleReload: CC button not found');
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
      return;
    }
    SK.sendLog('info', 'youtube', 'forceSubtitleReload: toggling CC to force new XHR');
    btn.click(); // 關閉 CC → 播放器清空字幕狀態
    await new Promise(r => setTimeout(r, 200));
    if (SK.YT.active) btn.click(); // 重新開啟 CC → 播放器重新抓字幕，觸發 /api/timedtext XHR
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
  // 我們以「下一條 startMs」當作本條的 endMs;最後一條用 startMs + 1500ms 當保守 endMs。
  // LLM 收到緊湊 JSON 陣列,自由合句後回傳同格式陣列。
  //
  // 解析容錯:LLM 可能用 ```json fence 包,先剝;陣列驗證寬鬆——
  //   1. 每個 entry 的 s 必須等於某條原始 segment 的 startMs(否則該 entry 丟棄)
  //   2. e 不強制驗(觀察 LLM 偶爾會給出非輸入值,但 s 對齊就足以決定 captionMap 寫入位置)
  // captionMap 寫入慣例:該 entry 的 [s, e] 內所有 windowSegs → 第一條 normText 存譯文,
  // 其餘存空字串(視覺等同合併成單行,跟 buildTranslationUnits preserve=true 慣例一致)。

  function _stripJsonFence(s) {
    if (!s) return s;
    const m = s.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (m) return m[1].trim();
    return s.trim();
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
    'mhm', 'um', '>>', '- ',
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
      const endMs = next ? next[0].tStartMs : group[group.length - 1].tStartMs + 1500;
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
          /* cue rows:用 span + display:inline-block,寬度 shrink-to-fit 內容
             v1.8.2: padding 從 0.15em 0.7em 縮成 0.05em 0.3em — 對齊 YouTube 原生
             字幕緊貼文字的視覺比例(原本左右各多出近半字寬,上下也鬆) */
          .cue {
            display: inline-block;
            max-width: 100%;
            padding: 0.05em 0.3em;
            background: rgba(0, 0, 0, 0.75);   /* 對齊 YouTube 原生 */
            color: #fff;
            line-height: 1.45;
            border-radius: 3px;
            white-space: pre-wrap;
            text-align: center;
            box-sizing: border-box;
          }
          .src {
            font-size: calc(var(--sk-cue-size, 18px) * 0.78);
            opacity: 0.75;
          }
          .tgt {
            font-size: var(--sk-cue-size, 18px);
          }
          .src[hidden], .tgt:empty { display: none; }
        </style>
        <div class="window">
          <span class="cue src" hidden></span>
          <span class="cue tgt"></span>
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
        if (_ASR_PUNCT_RE.test(rest[i])) { cutIdx = i + 1; break; }
      }
      // 2. 找不到 → 從門檻+1 往後找最近標點(允許首行稍長)
      if (cutIdx < 0) {
        for (let i = maxLine + 1; i < rest.length - 1; i++) {
          if (_ASR_PUNCT_RE.test(rest[i])) { cutIdx = i + 1; break; }
        }
      }
      // 3. 全句沒標點 → 按 maxLine 硬切(不依賴 CSS wrap,確保視覺絕對折行)
      if (cutIdx < 0) cutIdx = maxLine;
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
  function _setSegmentText(el, text) {
    const str = text == null ? '' : String(text);
    if (!str) {
      if (el.textContent !== '') el.textContent = '';
      return;
    }
    const wrapped = _wrapTargetText(str);
    if (wrapped.indexOf('\n') >= 0) {
      // 有切點:用 innerHTML + <br>(textContent 走不出 <br>,設 \n 也會被
      // YouTube 既有 white-space: nowrap 吞掉)。先 escape 防 XSS。
      const html = _escapeHtml(wrapped).replace(/\n/g, '<br>');
      if (el.innerHTML !== html) el.innerHTML = html;
    } else {
      if (el.textContent !== wrapped) el.textContent = wrapped;
    }
  }

  // 暴露給 spec 用
  SK._setSegmentText = _setSegmentText;

  function _setOverlayContent(targetText, sourceText) {
    const host = _ensureOverlay();
    if (!host || !host.shadowRoot) return;
    const tgtEl = host.shadowRoot.querySelector('.tgt');
    const srcEl = host.shadowRoot.querySelector('.src');
    if (!targetText) {
      if (tgtEl.innerHTML !== '') tgtEl.innerHTML = '';
      host.style.display = 'none';
      return;
    }
    const wrapped = _wrapTargetText(targetText);
    // 用 innerHTML + <br> 寫入(比 textContent + \n + white-space:pre-wrap 更穩定,
    // 不受 inline-block 的 wrap 行為差異影響)。先 escape HTML 字元防注入。
    const html = _escapeHtml(wrapped).replace(/\n/g, '<br>');
    if (tgtEl.innerHTML !== html) tgtEl.innerHTML = html;
    // source 暫不顯示(避免跟原生 ASR caption 三層字幕重疊;之後可加 toggle)
    if (sourceText !== undefined && srcEl) srcEl.hidden = true;
    host.style.display = 'block';
  }

  // 暴露給 spec 用
  SK._wrapTargetTextForOverlay = _wrapTargetText;

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
      .${_ASR_PLAYER_CLASS} .caption-window,
      .${_ASR_PLAYER_CLASS} .ytp-caption-window-rollup,
      .${_ASR_PLAYER_CLASS} .ytp-caption-window-container .caption-window {
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

  // commit 5c:統一切 bilingualMode 的副作用 — 字幕隱藏/顯示 + overlay 位置調整。
  // 雙語模式中文 overlay 要避開原生英文 CC(原生位置約 30-40px from bottom),把
  // overlay --sk-cue-bottom 推到 90px 在英文上方。純中文模式(原生 CC 已隱藏)
  // overlay 回預設 30px 佔據原生 CC 的視覺位置。
  function _applyBilingualMode(bilingual) {
    _setAsrHidingMode(!bilingual);
    // commit 5c.6:用 host attribute + CSS rule(_setAsrHidingMode 內注入的 stylesheet)
    // 控制 overlay 位置,讓 chrome 顯示時的 :not(.ytp-autohide) selector 可以再上抬,
    // 避免 inline style override 卡住自動上抬邏輯。
    const host = document.querySelector(_OVERLAY_TAG);
    if (host) {
      if (bilingual) {
        host.setAttribute('bilingual', 'true');
      } else {
        host.removeAttribute('bilingual');
      }
      // 清除 commit 5c.1 之前可能殘留的 inline style override(避免擋住 attr CSS rule)
      host.style.removeProperty('--sk-cue-bottom');
    }
    // commit 5c.3:即時切到雙語時把已顯示的「翻譯中…」清掉(雙語下這 status 不該存在)
    if (bilingual) hideCaptionStatus();
  }

  // 讀 YouTube 原生字幕字體大小(已套用使用者字幕設定 + player size 自適應比例)。
  // 多重 fallback:首選 caption-segment、退而 caption-window、最後用 video 高度 4.5%。
  function _readNativeCaptionFontSize() {
    const seg = document.querySelector('.ytp-caption-segment');
    if (seg) {
      const fz = parseFloat(getComputedStyle(seg).fontSize);
      if (Number.isFinite(fz) && fz > 0) return fz;
    }
    const win = document.querySelector('.caption-window');
    if (win) {
      const fz = parseFloat(getComputedStyle(win).fontSize);
      if (Number.isFinite(fz) && fz > 0) return fz;
    }
    const video = document.querySelector('video');
    if (video && video.offsetHeight) return Math.round(video.offsetHeight * 0.045);
    return 18;
  }

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
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      const nextStart = (i + 1 < cues.length) ? cues[i + 1].startMs : Infinity;
      const effectiveEnd = Math.min(c.endMs, nextStart);
      if (currentMs >= c.startMs && currentMs <= effectiveEnd) return c;
    }
    return null;
  }

  function _updateOverlay() {
    const YT = SK.YT;
    if (!YT.active || !YT.isAsr) return;
    if (!YT.videoEl) return;
    // 動態同步 native caption font-size / font-family 到 overlay
    // (fullscreen / theatre / 字幕大小設定 / 使用者字型選擇變更時自動跟上)
    const host = _ensureOverlay();
    if (host) {
      const nativeFz = _readNativeCaptionFontSize();
      host.style.setProperty('--sk-cue-size', nativeFz + 'px');
      const nativeFf = _readNativeCaptionFontFamily();
      if (nativeFf) host.style.setProperty('--sk-cue-font-family', nativeFf);
    }
    const currentMs = YT.videoEl.currentTime * 1000;
    const cue = _findActiveCue(currentMs);
    // v1.8.20: ASR + 純中文模式下,replaceSegmentEl L1909 會 early return 跳過
    // L1934 的 hideCaptionStatus → 「翻譯中…」永遠殘留。改在 overlay 寫入時若有
    // 中文 cue 命中,就主動 hide(冪等,沒 status indicator 時直接 return)。
    if (cue && cue.targetText) hideCaptionStatus();
    _setOverlayContent(cue ? cue.targetText : '');
  }

  // 中文閱讀時間補償:LLM 自由分句把多段 ASR 合成一句中文,中文密度高,
  // 原 endMs(=該句最後一個 ASR 片段的 startMs)往往讓使用者讀不完。
  //   每字 200ms + 最低 800ms 下限(實測校準:250/1000 偏長 ~0.5s)。
  //   超過下一句 startMs 時由 _findActiveCue 自動 clamp,不會視覺重疊。
  const _ASR_READ_MS_PER_CHAR = 200;
  const _ASR_MIN_READ_MS       = 800;

  // 加入 cue 到 displayCues。
  //   - 同 startMs upsert(progressive 模式 LLM 覆蓋 heuristic 用)
  //   - opts.replaceRange=true(LLM 路徑用):清除 startMs 落在 (新 cue.startMs, LLM 原始 endMs)
  //     範圍內的舊 cue,避免 progressive 模式下「LLM 沒同 startMs」的 heuristic cue 殘留 →
  //     視覺上預設分句 / AI 分句疊來疊去。**用 LLM 原始 endMs 不用延長後 adjustedEnd**:
  //     閱讀延長只是「給使用者讀完已有譯文的時間」,不該擴張 LLM 認為涵蓋的範圍。誤用 adjustedEnd
  //     會把 LLM 沒 cover 的中段 heuristic cue 清掉,造成中段字幕消失。
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
    if (opts && opts.replaceRange) {
      for (let i = cues.length - 1; i >= 0; i--) {
        const c = cues[i];
        if (c.startMs > startMs && c.startMs < llmEndMs) cues.splice(i, 1);
      }
    }

    const idx = cues.findIndex(c => c.startMs === startMs);
    if (idx >= 0) cues[idx] = next;
    else cues.push(next);

    cues.sort((a, b) => a.startMs - b.startMs);
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
  function _splitAsrSubBatches(windowSegs, videoNowMs, windowStartMs) {
    if (windowSegs.length <= 5) return [windowSegs];

    const GAP_MS = 500;          // 自然停頓判斷門檻

    // Lead-time-aware:緊急情況下 skip 已過去的 segments,從 videoNowMs 之後第一條開始
    const leadMs = (typeof windowStartMs === 'number' && typeof videoNowMs === 'number')
      ? windowStartMs - videoNowMs : Infinity;
    const sub0Start = leadMs <= 0 ? videoNowMs : windowSegs[0].startMs;
    const segs = leadMs <= 0
      ? windowSegs.filter(s => s.startMs >= sub0Start)
      : windowSegs;
    if (segs.length <= 5) return [segs];
    const n = segs.length;

    // 依 leadMs 決定子批 0 跨度上限:緊急 4s、即將 6s、從容 8s
    const sub0Max = leadMs <= 0     ? 4000
                  : leadMs < 5000   ? 6000
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

    const cuts = [];
    const cut1 = findCutIdx(0, sub0Min, sub0Max);
    if (cut1 > 0) cuts.push(cut1);
    if (cut1 > 0) {
      const cut2 = findCutIdx(cut1, 8000, 15000);
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
    const startMsSet = new Set(subSegs.map(s => s.startMs));
    const lastSeg = subSegs[subSegs.length - 1];
    const inputArr = subSegs.map((seg, i) => {
      const next = subSegs[i + 1];
      // 子批內最後一條 fallback +1500ms(子批間不重疊)
      const endMs = next ? next.startMs : seg.startMs + 1500;
      return { s: seg.startMs, e: endMs, t: seg.text };
    });
    const inputJson = JSON.stringify(inputArr);

    const res = await SK.safeSendMessage({
      type: 'TRANSLATE_ASR_SUBTITLE_BATCH',
      payload: { texts: [inputJson], glossary: null },
    });
    const elapsed = Date.now() - _t0Window;
    if (batchApiMsRef) batchApiMsRef[batchIdx] = elapsed;

    if (!res?.ok) throw new Error(res?.error || 'ASR translation failed');
    _logWindowUsage(subSegs.length, res.usage);

    const rawText = res.result?.[0] || '';
    const entries = _parseAsrResponse(rawText);

    let writtenCount = 0;
    let droppedCount = 0;
    for (const entry of entries) {
      const sStart = Number(entry.s);
      const sEnd   = Number(entry.e);
      const trans  = String(entry.t || '').trim();
      if (!Number.isFinite(sStart) || !trans) { droppedCount++; continue; }
      if (!startMsSet.has(sStart)) { droppedCount++; continue; }
      const validEnd = Number.isFinite(sEnd) && sEnd >= sStart ? sEnd : sStart;
      const covered = subSegs.filter(seg => seg.startMs >= sStart && seg.startMs <= validEnd);
      if (covered.length === 0) { droppedCount++; continue; }
      YT.captionMap.set(covered[0].normText, trans);
      for (let k = 1; k < covered.length; k++) {
        YT.captionMap.set(covered[k].normText, '');
      }
      // G 路徑:寫 displayCues 給 overlay 用(progressive 模式覆蓋 heuristic 寫的同 startMs)
      const sourceText = covered.map(seg => seg.text).join(' ');
      _upsertDisplayCue(sStart, validEnd, sourceText, trans, { replaceRange: true });
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
    const subBatches = _splitAsrSubBatches(windowSegs, videoNowMs, windowStartMs);
    YT.lastLeadMs = windowStartMs - videoNowMs;          // debug 面板用
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
  // 跟非 ASR 路徑共用 TRANSLATE_SUBTITLE_BATCH 訊息(因為翻譯單位已經是「英文整句」,
  // 跟人工字幕一樣的形態,不用 ASR 專用的 JSON timestamp prompt)。
  async function _runAsrHeuristicWindow(windowSegs, windowStartMs) {
    const YT = SK.YT;
    if (!YT.active) return;

    const sentences = _heuristicMergeAsr(windowSegs);
    if (sentences.length === 0) return;

    SK.sendLog('info', 'youtube', 'asr heuristic merged', {
      windowStartMs, windowSegCount: windowSegs.length,
      sentenceCount: sentences.length,
      avgSegsPerSentence: (windowSegs.length / sentences.length).toFixed(1),
    });

    // _cue 帶 cue 時間範圍,翻譯回來後 push 到 displayCues 給 overlay 用
    const units = sentences.map(s => ({
      text: s.text,
      keys: s.sourceSegs.map(seg => seg.normText),
      _cue: { startMs: s.startMs, endMs: s.endMs, sourceText: s.text },
    }));

    const BATCH = 8;
    const videoNowMs = YT.videoEl ? YT.videoEl.currentTime * 1000 : windowStartMs;
    const leadMs = windowStartMs - videoNowMs;
    const firstBatchSize = leadMs <= 0    ? 1
                         : leadMs < 5000  ? 2
                         : leadMs < 10000 ? 4
                         : BATCH;
    YT.firstBatchSize = firstBatchSize;
    YT.lastLeadMs = leadMs;

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

    const _runBatch = (batchUnits, b) =>
      SK.safeSendMessage({
        type: 'TRANSLATE_SUBTITLE_BATCH',
        payload: { texts: batchUnits.map(u => u.text), glossary: null },
      }).then(res => {
        const elapsed = Date.now() - _t0;
        _batchApiMs[b] = elapsed;
        if (!res?.ok) throw new Error(res?.error || '翻譯失敗');
        _logWindowUsage(batchUnits.length, res.usage);
        for (let j = 0; j < batchUnits.length; j++) {
          const unit = batchUnits[j];
          // v1.8.10 A:strip LLM 偷懶殘留的 SEP / «N» 標記
          const trans = SK.sanitizeMarkers(String(res.result[j] || unit.text).trim());
          let normTrans = trans;
          if (unit.keys.length === 1) {
            YT.captionMap.set(unit.keys[0], trans);
          } else {
            normTrans = trans.replace(/\\n/g, ' ').replace(/\n/g, ' ').trim();
            YT.captionMap.set(unit.keys[0], normTrans);
            for (let k = 1; k < unit.keys.length; k++) {
              YT.captionMap.set(unit.keys[k], '');
            }
          }
          // G 路徑:寫 displayCues 給 overlay 用
          if (unit._cue) {
            _upsertDisplayCue(unit._cue.startMs, unit._cue.endMs, unit._cue.sourceText, normTrans);
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

  // ─── 時間視窗翻譯 ──────────────────────────────────────────

  async function translateWindowFrom(windowStartMs) {
    const YT = SK.YT;
    if (YT.translatingWindows.has(windowStartMs)) return;  // v1.2.54: per-window 防重入
    if (!YT.active) return;

    // 取得設定
    const config = await getYtConfig();
    const windowSizeMs = (config.windowSizeS || 30) * 1000;
    const windowEndMs  = windowStartMs + windowSizeMs;

    // 標記「已排程翻譯到此位置」，防止 timeupdate 重複觸發
    YT.translatedUpToMs = windowEndMs;
    YT.translatingWindows.add(windowStartMs);  // v1.2.54: 加入 Set，允許其他視窗並行

    // v1.3.5: try-finally 確保 translatingWindows.delete 無論如何都會執行
    // （涵蓋：正常完成、!YT.active 提前 return、catch 繼續後到達 finally）
    try {

    // v1.2.48: 若此視窗已確實翻過（Set 精確記錄），直接推進不送 API。
    // 舊版用 captionMapCoverageUpToMs（高水位線）判斷，但高水位線不保證連續覆蓋：
    // 若使用者從中間開始看，前段從未翻過，向後拖時高水位線誤判「已翻」導致字幕空白。
    if (YT.translatedWindows.has(windowStartMs)) return;  // try-finally 會清理

    // 找出本視窗內的字幕（[windowStartMs, windowEndMs)）
    const windowSegs = YT.rawSegments.filter(
      s => s.startMs >= windowStartMs && s.startMs < windowEndMs
    );

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
      const asrMode = config.asrMode || 'progressive';  // 預設 progressive(混合模式)

      if (asrMode === 'heuristic' || asrMode === 'progressive') {
        try {
          await _runAsrHeuristicWindow(windowSegs, windowStartMs);
        } catch (err) {
          SK.sendLog('error', 'youtube', 'asr heuristic translation failed', { error: err.message });
        }
      }

      if (asrMode === 'llm' || asrMode === 'progressive') {
        if (asrMode === 'progressive') {
          // fire-and-forget:LLM 結果回來後寫入 captionMap 會覆蓋 heuristic 版本
          // (兩條路徑都用同一組 windowSegs.normText 當 key,LLM 路徑的 entry.s/e 區間 ⊆ heuristic 合句區間)
          _runAsrWindow(windowSegs, windowStartMs, windowEndMs).catch(err => {
            SK.sendLog('error', 'youtube', 'asr llm overlay failed', { error: err.message });
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
      const BATCH = 8;
      const preserve = true; // v1.2.38 起固定開啟，已移除設定頁 toggle
      const units = buildTranslationUnits(windowSegs, preserve);
      try {
        // 1. 切好每批的 units（批次索引 = 時間順序，batch 0 最早出現）
        // v1.2.50: 自適應首批大小（adaptive first batch size）
        // 以「視窗起點距影片當前位置的 lead time」決定 batch 0 的條數：
        //   lead ≤ 0（影片已超過視窗起點，緊急）→ 1 條：最小 payload，最快回傳
        //   lead < 5s → 2 條；lead < 10s → 4 條；lead ≥ 10s → 8 條（正常）
        // 首批條數愈少，input/output tokens 愈少，API 回傳愈快，
        // 第一條字幕出現的延遲從 ~10s（batch=8）有望降至 ~5s（batch=1）。
        // 其餘批次仍用 BATCH=8 並行送出，不影響後續字幕速度。
        const videoNowMs = YT.videoEl ? YT.videoEl.currentTime * 1000 : 0;
        const leadMs = windowStartMs - videoNowMs;
        const firstBatchSize = leadMs <= 0    ? 1
                             : leadMs < 5000  ? 2
                             : leadMs < 10000 ? 4
                             : BATCH;
        YT.firstBatchSize = firstBatchSize;
        YT.lastLeadMs     = leadMs;
        SK.sendLog('info', 'youtube', 'adaptive batch0', {
          leadMs: Math.round(leadMs), firstBatchSize, totalUnits: units.length,
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

        // 批次處理器（每批完成後立刻注入 captionMap 並替換 DOM 字幕）
        // v1.4.0: 依 config.engine 路由到對應的翻譯 handler
        // v1.5.8: 加 'openai-compat' 第三引擎，走自訂模型 / customProvider 共用設定
        const _subtitleMsgType =
          config.engine === 'google'        ? 'TRANSLATE_SUBTITLE_BATCH_GOOGLE' :
          config.engine === 'openai-compat' ? 'TRANSLATE_SUBTITLE_BATCH_CUSTOM' :
                                              'TRANSLATE_SUBTITLE_BATCH';

        const _injectBatchResult = (batchUnits, results, b, elapsed) => {
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
              for (let k = 1; k < unit.keys.length; k++) YT.captionMap.set(unit.keys[k], '');
            }
          }
          const domSegs = document.querySelectorAll('.ytp-caption-segment');
          domSegs.forEach(replaceSegmentEl);
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
            if (!res?.ok) throw new Error(res?.error || '翻譯失敗');
            _logWindowUsage(batchUnits.length, res.usage);
            _injectBatchResult(batchUnits, res.result || [], b, elapsed);
          });

        // v1.8.9: Streaming batch 0(只人工字幕、只 Gemini engine)
        // 收 STREAMING_SEGMENT 立刻寫 captionMap + replaceSegmentEl,首字延遲從整批 resolve 砍成 SSE 首段
        // FIRST_CHUNK_TIMEOUT_MS=1500 跟文章翻譯路徑一致。Google MT / OpenAI-compat 維持原非 streaming。
        const _streamSubtitleEnabled = !config.engine || config.engine === 'gemini';
        const FIRST_CHUNK_TIMEOUT_MS = 1500;

        const _runBatch0Streaming = (batchUnits) => {
          const streamId = `yt_stream_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
          let firstChunkResolve, doneResolve, doneReject;
          const firstChunkPromise = new Promise(r => { firstChunkResolve = r; });
          const donePromise = new Promise((res, rej) => { doneResolve = res; doneReject = rej; });
          // 確保「first_chunk failed → 主流程不 await donePromise」時 donePromise 的 reject 不會冒成 unhandled
          donePromise.catch(() => {});

          const onMessage = (message) => {
            if (!message || message.payload?.streamId !== streamId) return;
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
              // v1.8.10 B:hadMismatch=true(LLM 偷懶把 N 段合併成 1 段)時 reject,
              // 觸發既有 mid-failure catch 重翻 batch 0 走 non-streaming(整批 resolve 後一次 split)。
              // segment 0 可能已被 streaming 注入合併譯文(A 已 sanitize),retry 會用乾淨版本覆蓋。
              if (message.payload.hadMismatch) {
                SK.sendLog('warn', 'youtube', 'streaming DONE with hadMismatch, triggering retry', { elapsed, totalSegments: message.payload.totalSegments });
                browser.runtime.onMessage.removeListener(onMessage);
                firstChunkResolve(true);
                doneReject(new Error('streaming hadMismatch'));
                return;
              }
              _logWindowUsage(batchUnits.length, message.payload.usage || {});
              browser.runtime.onMessage.removeListener(onMessage);
              firstChunkResolve(true);
              doneResolve({ ok: true });
            } else if (message.type === 'STREAMING_ERROR') {
              browser.runtime.onMessage.removeListener(onMessage);
              firstChunkResolve(false);
              doneReject(new Error(message.payload.error || 'streaming failed'));
            } else if (message.type === 'STREAMING_ABORTED') {
              browser.runtime.onMessage.removeListener(onMessage);
              firstChunkResolve(false);
              doneResolve({ ok: false, aborted: true });
            }
          };
          browser.runtime.onMessage.addListener(onMessage);

          SK.safeSendMessage({
            type: 'TRANSLATE_SUBTITLE_BATCH_STREAM',
            payload: { texts: batchUnits.map(u => u.text), glossary: null, streamId },
          }).then((resp) => {
            if (!resp?.started) {
              browser.runtime.onMessage.removeListener(onMessage);
              firstChunkResolve(false);
              doneReject(new Error(resp?.error || 'streaming failed to start'));
            }
          }).catch((err) => {
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
            cleanup: () => { try { browser.runtime.onMessage.removeListener(onMessage); } catch (_) {} },
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
              YT.batchApiMs = _batchApiMs;
              return;
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
      }
    }

    // v1.2.46/v1.2.48: 記錄此視窗已翻完
    YT.captionMapCoverageUpToMs = Math.max(YT.captionMapCoverageUpToMs, windowEndMs);
    YT.translatedWindows.add(windowStartMs); // Set 精確記錄，供 seek-back 跳過判斷用

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
      YT.translatingWindows.delete(windowStartMs);
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
    if (!YT.translatedWindows.has(newWindowStart) && !_hasVisibleChineseCaption()) {
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
  }

  // ─── MutationObserver：即時替換字幕 ──────────────────────

  // 判斷字串是否已含中日韓字元（表示已翻譯完成）
  // 用途：el.textContent 賦值會觸發 characterData mutation，若不跳過中文譯文會形成迴圈
  const RE_CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;


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
    // 已含中日韓字元 → 這是我們設置的譯文被 characterData mutation 觸發回呼，直接跳過
    if (RE_CJK.test(original)) return;
    const key = normText(original);

    // 快取命中 → 瞬間替換
    const cached = SK.YT.captionMap.get(key);
    if (cached !== undefined) {
      if (el.textContent !== cached) {
        // v1.2.51: 第一次 cache hit = 使用者第一次「看到」翻譯字幕的時刻
        const YT = SK.YT;
        if (cached && !YT._firstCacheHitLogged) {
          YT._firstCacheHitLogged = true;
          SK.sendLog('info', 'youtube', '🎯 first translated subtitle visible', {
            sessionOffsetMs: Date.now() - YT.sessionStartTime,  // 距 session 啟動幾 ms
            videoNowMs: Math.round((YT.videoEl?.currentTime || 0) * 1000),
            captionMapSize: YT.captionMap.size,
            key: key.slice(0, 40),
          });
        }
        // v1.2.58: 每次中文字幕出現都呼叫 hideCaptionStatus（冪等，無提示時直接 return）
        // 修正：seek 後 _firstCacheHitLogged 已為 true，但 showCaptionStatus 可能已再次顯示，
        // 只靠 !_firstCacheHitLogged gate 會導致新顯示的提示永遠不被移除。
        if (cached) hideCaptionStatus();
        // commit 5c.4:雙語模式(非 ASR 路徑)寫「原文 + 譯文兩行」<br> 串接。
        // commit 5c.5:跳過 _wrapTargetText 自動切點 — 它依字數限制(中文 15-35 字)切,
        // 對英文寬鬆但對中文常硬切兩行(image 22:中文長句被切,英文沒切)。直接寫
        // innerHTML + <br>,讓 caption-window 的 CSS word-wrap 依實際容器寬度自然處理。
        const isBilingual = SK.YT.config?.bilingualMode === true;
        if (isBilingual && cached) {
          const html = `${_escapeHtml(original)}<br>${_escapeHtml(cached)}`;
          if (el.innerHTML !== html) el.innerHTML = html;
        } else {
          // v1.8.9: 過長譯文比照 ASR 走 _wrapTargetText 切點 + <br>,避免衝出 video 寬
          _setSegmentText(el, cached);
        }
        // 同步展開字幕框（不用 rAF——新版 expandCaptionLine 純設 style，不需量測 layout；
        // 若用 rAF，瀏覽器會先 paint 出「中文 + 舊 315px 容器」再展開，造成一幀閃爍）
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

  async function flushOnTheFly() {
    const YT = SK.YT;
    if (YT.pendingQueue.size === 0 || YT.flushing) return;
    if (!YT.active) return; // v1.8.20: 進場 guard,session 已 stop 直接放棄
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
      const res = await SK.safeSendMessage({
        type: 'TRANSLATE_SUBTITLE_BATCH',
        payload: { texts, glossary: null },
      });
      if (!res?.ok) throw new Error(res?.error || '翻譯失敗');
      // v1.8.20: await 後再次檢查 active——stop 在 await 期間發生時放棄寫入,
      // 否則寫進已被 stopYouTubeTranslation 重置的新 captionMap 污染下個 session。
      if (!SK.YT.active) {
        YT.flushing = false;
        return;
      }
      // v1.2.39: 累積並記錄 on-the-fly 批次用量
      _logWindowUsage(texts.length, res.usage);

      for (let i = 0; i < texts.length; i++) {
        const key = texts[i];
        // v1.8.10 A:strip LLM 偷懶殘留的 SEP / «N» 標記
        const trans = SK.sanitizeMarkers(res.result[i] || texts[i]);
        YT.captionMap.set(key, trans);
        for (const el of (queue.get(key) || [])) {
          if (document.contains(el) && normText(el.textContent) === key) {
            // commit 5c.4:雙語模式(非 ASR)寫「原文 + 譯文兩行」
            // commit 5c.5:雙語跳過 _wrapTargetText,讓 CSS word-wrap 自然處理
            const isBilingual = YT.config?.bilingualMode === true;
            if (isBilingual && trans) {
              const original = el.textContent.trim();
              const html = `${_escapeHtml(original)}<br>${_escapeHtml(trans)}`;
              if (el.innerHTML !== html) el.innerHTML = html;
            } else {
              // v1.8.9: 過長譯文比照 ASR 走 _wrapTargetText 切點 + <br>
              _setSegmentText(el, trans);
            }
          }
        }
      }
    } catch (err) {
      SK.sendLog('warn', 'youtube', 'on-the-fly flush error', { error: err.message });
    }

    YT.flushing = false;
    if (YT.pendingQueue.size > 0) setTimeout(flushOnTheFly, 100);
  }

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
    if (YT.videoEl) {
      YT.videoEl.removeEventListener('timeupdate',  onVideoTimeUpdate);
      YT.videoEl.removeEventListener('seeked',      onVideoSeeked);    // v1.3.1: 補漏
      YT.videoEl.removeEventListener('ratechange',  onVideoRateChange); // v1.3.1: 補漏
      YT.videoEl = null;
    }
    YT.active             = false;
    YT.translatingWindows = new Set();  // v1.2.54
    YT.translatedWindows  = new Set();  // v1.3.5: 補齊（原僅在 translateYouTubeSubtitles 重置）
    YT.translatedUpToMs   = 0;
    YT.rawSegments        = [];         // v1.3.5: 補齊（原僅在 yt-navigate-finish 重置）
    YT.captionMap         = new Map();
    YT.pendingQueue       = new Map();
    YT.flushing           = false;       // v1.8.20: 確保下個 session 重啟後 flushOnTheFly 不被舊 flag 卡住
    YT.isAsr              = false;
    YT.displayCues        = [];         // G 路徑:清 overlay 顯示單位
    _setAsrHidingMode(false);
    _removeOverlay();
    hideCaptionStatus(); // v1.2.55
    _debugRemove();
    SK.sendLog('info', 'youtube', 'stopped');
  }

  SK.stopYouTubeTranslation = stopYouTubeTranslation;

  // ─── 主入口：Alt+S ─────────────────────────────────────────

  // v1.8.16: source 區分使用者明示 toggle vs 自動啟動。
  //   'manual'(預設,Alt+S / popup):active 時 toggle 還原(再按一次語義)
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
      SK.showToast('success', '已還原原文字幕');
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
    YT.displayCues               = [];        // G 路徑:啟動時清空 overlay cue,等本影片字幕回來

    // 提前掛 video 監聽器，不等字幕資料回來（使用者可能在等待期間拖進度條）
    attachVideoListener();

    const config = await getYtConfig();
    _debugUpdate('字幕翻譯已啟動，等待 CC 字幕資料…');

    // observer 提前啟動：captionMap 尚空時 cache miss → 字幕保持原文
    // 待 shinkansen-yt-captions 填入 rawSegments 後，translateWindowFrom 寫入 captionMap，字幕瞬間替換
    startCaptionObserver();

    if (YT.rawSegments.length > 0) {
      // 已有快取（interceptor 在 activate 之前就攔截到了）→ 直接開始翻譯
      _debugUpdate(`已有 ${YT.rawSegments.length} 條字幕，開始翻譯`);
      if (!_hasVisibleChineseCaption()) showCaptionStatus('翻譯中…');
      const video = document.querySelector('video');
      const currentMs = video ? Math.floor(video.currentTime * 1000) : 0;
      const windowSizeMs = (config.windowSizeS || 30) * 1000;
      const windowStartMs = Math.floor(currentMs / windowSizeMs) * windowSizeMs;
      await translateWindowFrom(windowStartMs);
      // hideCaptionStatus 由第一條中文字幕出現時觸發（replaceSegmentEl 內呼叫）
    } else {
      // 尚未攔截到字幕：CC 可能還沒開，或播放器尚未發出 XHR
      // → shinkansen-yt-captions 事件的 handler 會在字幕到來時接手翻譯
      showCaptionStatus('等待字幕資料…');

      // 1 秒後若仍無 XHR → 主動 toggle CC 讓播放器重新抓字幕
      setTimeout(() => {
        if (SK.YT.active && SK.YT.rawSegments.length === 0) {
          forceSubtitleReload();
        }
      }, 1000);

      // 5 秒後若仍無資料 → 判斷是否 CC 根本沒開
      setTimeout(() => {
        if (SK.YT.active && SK.YT.rawSegments.length === 0) {
          if (SK.YT.captionMap.size > 0) {
            // on-the-fly 在運作 → 提示由 hideCaptionStatus 自然消失
            hideCaptionStatus();
          } else {
            // captionMap 也是空的 → CC 可能真的沒開
            hideCaptionStatus();
            SK.showToast('success', '字幕翻譯已開啟。請開啟 YouTube 字幕（CC），翻譯將自動開始。');
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

  window.addEventListener('yt-navigate-finish', async () => {
    const YT = SK.YT;
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
  });

  // commit 5c:bilingualMode 即時切換(toggle 不需要 reload 影片頁)
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.ytSubtitle) return;
    const newVal = changes.ytSubtitle.newValue || {};
    const newBilingual = newVal.bilingualMode === true;
    if (SK.YT.config) SK.YT.config.bilingualMode = newBilingual;
    // 只在 ASR 字幕已啟用時即時 reapply(避免 ASR 還沒啟動就動 player class)
    if (SK.YT.isAsr && SK.YT.active) {
      _applyBilingualMode(newBilingual);
      SK.sendLog('info', 'youtube', 'bilingualMode toggled live', { bilingual: newBilingual });
    }
  });

  // ─── 對外 export:給 content-drive.js(Drive ASR commit 3+)共用 ─────
  // parseJson3:json3 → raw segments [{text, normText, startMs, groupId}]
  // mergeAsr:啟發式合句(kle/Ile/Lle 三段)→ [{startMs, endMs, text, sourceSegs}]
  // Drive ASR 路徑跟 YouTube ASR 路徑共用同一份字幕格式與合句啟發式,
  // 只差注入路徑(player same-frame DOM vs cross-origin iframe 浮層)。
  SK.ASR = {
    parseJson3,
    mergeAsr: _heuristicMergeAsr,
    parseAsrResponse: _parseAsrResponse,
  };

})(window.__SK);
