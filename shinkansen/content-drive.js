// content-drive.js — Shinkansen Drive 影片 ASR 字幕翻譯(top frame 入口)
// commit 4b/5 — 路徑 A(top frame 浮層)
//
// 執行環境:isolated world,run_at: document_idle,<all_urls> + all_frames: true。
// gate 只在 Drive viewer 的 top frame(drive.google.com/file/...)啟動實際邏輯;
// iframe 內的偵測由獨立的 content-drive-iframe.js 處理。
//
// 進度:
//   commit 1:iframe 內 PerformanceObserver + background fetch + relay top frame ✅
//   commit 2:top frame listener + parseJson3 raw dump ✅
//   commit 3:抽 SK.ASR helper(parseJson3 / mergeAsr / parseAsrResponse)✅
//   commit 4a:接 LLM(TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH)+ 譯文 dump(前 30 段)✅
//   commit 4b(本檔):overlay UI(<shinkansen-drive-overlay> + Shadow DOM)+
//                    YouTube IFrame Player API postMessage 時間軸 + 譯文 entries
//                    push 給 overlay + rAF render loop ✅
//   commit 5(待):整支切批 lazy-load + popup toggle + integration

(function (SK) {
  if (!SK || SK.disabled) return;

  if (location.hostname !== 'drive.google.com') return;
  if (!location.pathname.startsWith('/file/')) return;
  if (window.top !== window) return;

  // ─── SK.DRIVE 全域 state ──────────────────────────────
  // entries: LLM 譯文,按 startMs 排序;rAF loop 內依 currentTimeMs 找 active entry
  const DRIVE = SK.DRIVE = SK.DRIVE || {
    entries: [],
    currentTimeMs: 0,
    currentEntryIdx: -1,
    overlayHost: null,
    overlayCueEl: null,
    iframeEl: null,
    registeredListening: false,
  };

  // commit 5a:整支切批,30 段一批,throttled max 3 並行
  const BATCH_SIZE = 30;
  const MAX_CONCURRENT = 3;

  // ─── ytSubtitle 設定追蹤(autoTranslate + engine)──────
  // commit 5a':共用 YouTube 字幕設定塊,user 不需要為 Drive 額外設定。
  // commit 5b:engine 分流(預設 'gemini' 走 D' LLM 合句,'google' 走 GT 逐段翻免費)。
  let _autoTranslateEnabled = true;
  let _engine = 'gemini';
  let _bilingualMode = false; // commit 5c:false=純中文(關 player CC)/ true=中英對照
  (async () => {
    try {
      const { ytSubtitle = {} } = await browser.storage.sync.get('ytSubtitle');
      _autoTranslateEnabled = ytSubtitle.autoTranslate !== false;
      _engine = ytSubtitle.engine === 'google' ? 'google' : 'gemini';
      _bilingualMode = ytSubtitle.bilingualMode === true;
      SK.sendLog('info', 'drive', 'settings loaded (from ytSubtitle)', {
        autoTranslate: _autoTranslateEnabled,
        engine: _engine,
        bilingual: _bilingualMode,
      });
    } catch { /* 維持預設 */ }
  })();
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.ytSubtitle) return;
    const newVal = changes.ytSubtitle.newValue || {};
    const nextEnabled = newVal.autoTranslate !== false;
    if (nextEnabled !== _autoTranslateEnabled) {
      _autoTranslateEnabled = nextEnabled;
      SK.sendLog('info', 'drive', 'autoTranslate setting changed', { enabled: nextEnabled });
    }
    const nextEngine = newVal.engine === 'google' ? 'google' : 'gemini';
    if (nextEngine !== _engine) {
      _engine = nextEngine;
      SK.sendLog('info', 'drive', 'engine setting changed', { engine: nextEngine });
    }
    const nextBilingual = newVal.bilingualMode === true;
    if (nextBilingual !== _bilingualMode) {
      _bilingualMode = nextBilingual;
      // commit 5c:即時切 player CC(loadModule / unloadModule),不用 reload
      if (nextBilingual) {
        _enablePlayerCaptions();
      } else {
        _disablePlayerCaptions();
      }
      SK.sendLog('info', 'drive', 'bilingualMode toggled live', { bilingual: nextBilingual });
    }
  });

  // ─── 單語模式:關掉 YouTube embed player 的原生 CC ─────
  // 透過 IFrame Player API postMessage 'command' func='unloadModule' arg='captions'。
  // 必須在 player onReady 之後送(timing 由 onMessage listener 控制)。
  // 注意:必須等 timedtext 已被 PerformanceObserver 捕捉**之後**才 unload,否則 player
  // 不再 fetch timedtext = iframe 偵測不到 URL = 字幕翻譯 pipeline 直接斷。
  function _disablePlayerCaptions() {
    if (!DRIVE.iframeEl?.contentWindow) return;
    try {
      DRIVE.iframeEl.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: 'unloadModule', args: ['captions'] }),
        'https://youtube.googleapis.com'
      );
      SK.sendLog('info', 'drive', 'sent unloadModule captions (single-language mode)');
    } catch (e) {
      SK.sendLog('warn', 'drive', 'unloadModule captions failed', { error: e?.message || String(e) });
    }
  }
  // commit 5c:雙語模式下重新載入 player captions(對應 toggle 從 single-language 切到 bilingual)
  // commit 5c.8:revert 5c.7 的 setOption 自動啟動 captions(那條 onReady 時送 setOption
  // 對 Drive 不 work,可能 protocol timing 不對,需未來 dedicated 一輪 debug)。回到只送
  // loadModule —— 雙語 toggle 切換場景仍 work(此時 user 已按過 CC,captions module reload OK)。
  function _enablePlayerCaptions() {
    if (!DRIVE.iframeEl?.contentWindow) return;
    try {
      DRIVE.iframeEl.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: 'loadModule', args: ['captions'] }),
        'https://youtube.googleapis.com'
      );
      SK.sendLog('info', 'drive', 'sent loadModule captions (bilingual mode)');
    } catch (e) {
      SK.sendLog('warn', 'drive', 'loadModule captions failed', { error: e?.message || String(e) });
    }
  }

  // ─── overlay UI ──────────────────────────────────────
  // <shinkansen-drive-overlay>:position:fixed,動態追蹤 youtube embed iframe rect 對齊。
  // Shadow DOM 隔離 Drive 既有 CSS。pointer-events:none 不擋互動。
  const _OVERLAY_TAG = 'shinkansen-drive-overlay';

  function _findPlayerIframe() {
    return document.querySelector('iframe[src*="youtube.googleapis.com/embed"]');
  }

  function _ensureOverlay() {
    if (DRIVE.overlayHost && document.body.contains(DRIVE.overlayHost)) return DRIVE.overlayHost;
    const host = document.createElement(_OVERLAY_TAG);
    Object.assign(host.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '99999',
      display: 'none',
      left: '0px', top: '0px', width: '0px', height: '0px',
    });
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host {
          font-family: "PingFang TC", "Microsoft JhengHei", "微軟正黑體",
                       "Heiti TC", "Noto Sans CJK TC", sans-serif;
        }
        .container {
          position: absolute;
          left: 0; right: 0;
          bottom: 22%;          /* iframe 高度 22%:在原生英文 ASR(約 8-12%)上方,
                                   形成雙語對照不重疊。commit 5c.8 revert 5c.7 動態上抬:
                                   cross-origin iframe 監測 chrome show/hide 不可靠,先固定 22%
                                   留 v1.8.16 重做 */
          display: flex;
          justify-content: center;
          padding: 0 24px;
          box-sizing: border-box;
        }
        .cue {
          display: inline-block;
          max-width: 100%;
          padding: 0.15em 0.5em;
          background: rgba(0, 0, 0, 0.78);
          color: #fff;
          font-size: 22px;
          line-height: 1.5;
          border-radius: 4px;
          white-space: pre-wrap;
          text-align: center;
          box-sizing: border-box;
          letter-spacing: 0.02em;
        }
        .cue:empty { display: none; }
      </style>
      <div class="container"><span class="cue"></span></div>
    `;
    document.body.appendChild(host);
    DRIVE.overlayHost = host;
    DRIVE.overlayCueEl = shadow.querySelector('.cue');
    return host;
  }

  // ─── iframe rect 追蹤 ────────────────────────────────
  // Drive viewer 通常不 scroll,但 sidebar 開合會 resize iframe。rAF loop 持續校正,
  // 比 ResizeObserver 簡單(且 rAF loop 本來就要跑來 render cue)。
  function _updateOverlayPosition() {
    const iframe = DRIVE.iframeEl;
    const host = DRIVE.overlayHost;
    if (!iframe || !host) return;
    const rect = iframe.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) {
      host.style.display = 'none';
      return;
    }
    host.style.left = `${rect.left}px`;
    host.style.top = `${rect.top}px`;
    host.style.width = `${rect.width}px`;
    host.style.height = `${rect.height}px`;
    host.style.display = 'block';
  }

  // ─── postMessage 時間軸 ───────────────────────────────
  // YouTube IFrame Player API protocol:
  //   iframe → parent: {event:'onReady', ...}(player ready 通知)
  //   parent → iframe: {event:'listening', id:..., channel:'widget'}(parent 註冊)
  //   iframe → parent: {event:'infoDelivery', info:{currentTime, duration, ...}}(註冊後持續推送)
  // Drive 的 embed iframe URL 已 enablejsapi=1,player 啟動後會 fire onReady,
  // 我們收到後送 listening 註冊;之後 infoDelivery 每 250ms 左右推一次 currentTime。
  let _initialMessagesLogged = 0;
  const _MAX_INITIAL_LOGS = 5;

  function _listenPlayerMessages() {
    window.addEventListener('message', (e) => {
      if (e.origin !== 'https://youtube.googleapis.com') return;
      let data = e.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { return; }
      }
      if (!data || typeof data !== 'object') return;

      // 前幾個 message dump 出來方便驗 protocol(iframe 跑哪種版本可能有差異)
      if (_initialMessagesLogged < _MAX_INITIAL_LOGS) {
        _initialMessagesLogged++;
        SK.sendLog('info', 'drive', 'player message received', {
          event: data.event,
          hasInfo: !!data.info,
          hasCurrentTime: typeof data.info?.currentTime === 'number',
          dataKeys: Object.keys(data).slice(0, 8),
        });
      }

      if (data.event === 'onReady' && !DRIVE.registeredListening) {
        DRIVE.registeredListening = true;
        try {
          DRIVE.iframeEl?.contentWindow?.postMessage(
            JSON.stringify({ event: 'listening', id: 'shinkansen-drive', channel: 'widget' }),
            'https://youtube.googleapis.com'
          );
          SK.sendLog('info', 'drive', 'sent listening register');
        } catch (err) {
          SK.sendLog('warn', 'drive', 'listening register failed', { error: err?.message });
        }
        // commit 5c.8 revert 5c.7:auto-enable CC 不 work,user 仍需手動按 CC 一次觸發
        // timedtext 請求(留 v1.8.16 dedicated 一輪 debug protocol)
      }

      if (data.event === 'infoDelivery' && typeof data.info?.currentTime === 'number') {
        DRIVE.currentTimeMs = Math.floor(data.info.currentTime * 1000);
      }
    });
  }

  // ─── active entry finder + render ───────────────────
  // commit 4b entries 數量小(11 句),linear search 即可。commit 5 整支翻完
  // (~250 句)再考慮 binary search。
  function _findActiveEntryIdx() {
    const t = DRIVE.currentTimeMs;
    const entries = DRIVE.entries;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (t >= e.startMs && t < e.endMs) return i;
    }
    return -1;
  }

  function _renderActiveCue() {
    if (!DRIVE.overlayCueEl) return;
    const idx = _findActiveEntryIdx();
    if (idx === DRIVE.currentEntryIdx) return;
    DRIVE.currentEntryIdx = idx;
    DRIVE.overlayCueEl.textContent = idx === -1 ? '' : DRIVE.entries[idx].text;
  }

  // ─── 主 rAF loop:rect 追蹤 + render cue ─────────────
  function _startRenderLoop() {
    function loop() {
      _updateOverlayPosition();
      _renderActiveCue();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }

  // ─── 單批翻譯:Gemini D' 模式(LLM 自由合句 + 時間戳對齊) ────
  async function _runOneBatchGemini(batch, batchIdx, totalBatches) {
    if (batch.length === 0) return;

    const inputArr = batch.map((seg, i) => {
      const next = batch[i + 1];
      const endMs = next ? next.startMs : seg.startMs + 1500;
      return { s: seg.startMs, e: endMs, t: seg.text };
    });
    const inputJson = JSON.stringify(inputArr);

    let res;
    try {
      res = await SK.safeSendMessage({
        type: 'TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH',
        payload: { texts: [inputJson], glossary: null },
      });
    } catch (e) {
      SK.sendLog('warn', 'drive', `batch ${batchIdx + 1}/${totalBatches} gemini sendMessage failed`, {
        error: e?.message || String(e),
      });
      return;
    }

    if (!res?.ok) {
      SK.sendLog('warn', 'drive', `batch ${batchIdx + 1}/${totalBatches} gemini failed`, {
        error: res?.error || 'unknown',
      });
      return;
    }

    const rawText = res.result?.[0] || '';
    let entries;
    try {
      entries = SK.ASR.parseAsrResponse(rawText);
    } catch (e) {
      SK.sendLog('warn', 'drive', `batch ${batchIdx + 1}/${totalBatches} parseAsrResponse failed`, {
        error: e?.message || String(e),
        rawHead: rawText.slice(0, 200),
      });
      return;
    }

    let pushedCount = 0;
    for (const entry of entries) {
      const sStart = Number(entry.s);
      const sEnd = Number(entry.e);
      const text = String(entry.t || '').trim();
      if (!Number.isFinite(sStart) || !Number.isFinite(sEnd) || sEnd < sStart || !text) continue;
      DRIVE.entries.push({ startMs: sStart, endMs: sEnd, text });
      pushedCount++;
    }
    DRIVE.entries.sort((a, b) => a.startMs - b.startMs);

    SK.sendLog('info', 'drive', `batch ${batchIdx + 1}/${totalBatches} done (gemini)`, {
      llmEntryCount: entries.length,
      pushedToOverlay: pushedCount,
      totalOverlayEntries: DRIVE.entries.length,
      usage: res.usage,
    });
  }

  // ─── 單批翻譯:Google Translate 模式(逐段翻、不合句、免費) ──
  // input/output 都是 N 條 1:1 對應(ASR 不合句),時間戳沿用 raw segment 的 startMs。
  async function _runOneBatchGoogle(batch, batchIdx, totalBatches) {
    if (batch.length === 0) return;

    const texts = batch.map(seg => seg.text);

    let res;
    try {
      res = await SK.safeSendMessage({
        type: 'TRANSLATE_DRIVE_BATCH_GOOGLE',
        payload: { texts, glossary: null },
      });
    } catch (e) {
      SK.sendLog('warn', 'drive', `batch ${batchIdx + 1}/${totalBatches} google sendMessage failed`, {
        error: e?.message || String(e),
      });
      return;
    }

    if (!res?.ok) {
      SK.sendLog('warn', 'drive', `batch ${batchIdx + 1}/${totalBatches} google failed`, {
        error: res?.error || 'unknown',
      });
      return;
    }

    const translations = Array.isArray(res.result) ? res.result : [];
    let pushedCount = 0;
    for (let i = 0; i < batch.length; i++) {
      const seg = batch[i];
      const text = String(translations[i] || '').trim();
      if (!text) continue;
      const next = batch[i + 1];
      const endMs = next ? next.startMs : seg.startMs + 1500;
      DRIVE.entries.push({ startMs: seg.startMs, endMs, text });
      pushedCount++;
    }
    DRIVE.entries.sort((a, b) => a.startMs - b.startMs);

    SK.sendLog('info', 'drive', `batch ${batchIdx + 1}/${totalBatches} done (google)`, {
      inputCount: batch.length,
      translatedCount: translations.length,
      pushedToOverlay: pushedCount,
      totalOverlayEntries: DRIVE.entries.length,
      usage: res.usage,
    });
  }

  // ─── DRIVE_ASR_CAPTIONS handler ───────────────────────
  async function _handleCaptionsMessage(message) {
    if (!_autoTranslateEnabled) {
      SK.sendLog('info', 'drive', 'autoTranslate off — skipping captions');
      return;
    }
    const { json3 } = message.payload || {};
    if (!json3) {
      SK.sendLog('warn', 'drive', 'DRIVE_ASR_CAPTIONS payload missing json3');
      return;
    }
    if (!SK.ASR?.parseJson3 || !SK.ASR?.parseAsrResponse) {
      SK.sendLog('warn', 'drive', 'SK.ASR helpers not available (load order issue?)');
      return;
    }
    const rawSegments = SK.ASR.parseJson3(json3);
    SK.sendLog('info', 'drive', 'asr segments parsed', {
      count: rawSegments.length,
      firstStartMs: rawSegments[0]?.startMs,
      lastStartMs: rawSegments[rawSegments.length - 1]?.startMs,
    });

    if (rawSegments.length === 0) return;

    // commit 5c:單語模式下,timedtext 已被 PerformanceObserver 捕捉(ASR_CAPTIONS 都送進來了),
    // 這時關 player CC 安全 — 不會影響字幕翻譯 pipeline。
    if (!_bilingualMode) {
      _disablePlayerCaptions();
    }

    // commit 5a:整支切批 throttled 並行
    const batches = [];
    for (let i = 0; i < rawSegments.length; i += BATCH_SIZE) {
      batches.push(rawSegments.slice(i, i + BATCH_SIZE));
    }
    const totalBatches = batches.length;

    SK.sendLog('info', 'drive', 'starting full transcript translation', {
      totalSegments: rawSegments.length,
      totalBatches,
      maxConcurrent: MAX_CONCURRENT,
      engine: _engine,
    });

    let nextBatchIdx = 0;
    async function _worker() {
      while (true) {
        const idx = nextBatchIdx++;
        if (idx >= totalBatches) return;
        // 設定途中被關閉就停止後續批次(已送的 in-flight 仍會完成)
        if (!_autoTranslateEnabled) {
          SK.sendLog('info', 'drive', 'autoTranslate turned off mid-translation, stopping');
          return;
        }
        // engine 切換在 worker 開始前 latch(避免一輪內混用 google/gemini 結果)
        if (_engine === 'google') {
          await _runOneBatchGoogle(batches[idx], idx, totalBatches);
        } else {
          await _runOneBatchGemini(batches[idx], idx, totalBatches);
        }
      }
    }

    const tStart = Date.now();
    await Promise.all(Array(MAX_CONCURRENT).fill(0).map(_worker));
    SK.sendLog('info', 'drive', 'full transcript translation completed', {
      totalBatches,
      totalEntries: DRIVE.entries.length,
      elapsedMs: Date.now() - tStart,
    });
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'DRIVE_ASR_CAPTIONS') return;
    _handleCaptionsMessage(message).catch(err => {
      SK.sendLog('warn', 'drive', 'DRIVE_ASR_CAPTIONS handler exception', {
        error: err?.message || String(err),
      });
    });
  });

  // ─── 初始化:等 iframe 載入 → 掛 overlay + listener + render loop ──
  function _init(retries = 0) {
    const iframe = _findPlayerIframe();
    if (!iframe) {
      if (retries < 20) {
        // iframe 可能晚於 document_idle 才插入(Drive 動態載入 player)
        setTimeout(() => _init(retries + 1), 500);
      } else {
        SK.sendLog('warn', 'drive', 'player iframe not found after retries', { retries });
      }
      return;
    }
    DRIVE.iframeEl = iframe;
    _ensureOverlay();
    _listenPlayerMessages();
    _startRenderLoop();
    SK.sendLog('info', 'drive', 'overlay & message listener attached', {
      iframeRect: { width: iframe.offsetWidth, height: iframe.offsetHeight },
      retriesUntilFound: retries,
    });
  }

  setTimeout(() => _init(), 500);

  SK.sendLog('info', 'drive', 'content-drive.js top frame ready', {
    href: location.href.slice(0, 200),
  });

})(window.__SK);
