// content-drive.js — Shinkansen Drive 影片 ASR 字幕翻譯(top frame 入口)
// commit 4b/5 — 路徑 A(top frame 浮層)
//
// 執行環境:isolated world,run_at: document_idle,<all_urls> + all_frames: true。
// gate 只在 Drive viewer 的 top frame(drive.google.com/file/...)啟動實際 runtime;
// 但 overlay helpers 在 module top 即定義並暴露 SK._drive*,讓 regression spec 也能呼叫。
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
//   v1.8.54:雙語比照 YouTube ASR 樣式 — overlay 改 .cue-block > .src + .tgt
//            共用一塊黑底,native CC 一律關掉(雙語也走 unloadModule),中英並排
//            來源:rawSegments 依 [entry.startMs, entry.endMs) 區間 join 出對應原文

(function (SK) {
  if (!SK || SK.disabled) return;

  // ─── SK.DRIVE 全域 state ──────────────────────────────
  // entries: LLM/Google 譯文,按 startMs 排序;rAF loop 內依 currentTimeMs 找 active entry
  // rawSegments: 原始 ASR 英文 segments(parseJson3 直接輸出),雙語模式從這裡撈對應時段原文
  // bilingualMode: false=純中文 / true=中英對照(放 DRIVE 是讓 spec 能直接設)
  const DRIVE = SK.DRIVE = SK.DRIVE || {
    entries: [],
    rawSegments: [],
    bilingualMode: false,
    currentTimeMs: 0,
    currentEntryIdx: -1,
    overlayHost: null,
    overlayTgtEl: null,
    overlaySrcEl: null,
    iframeEl: null,
    registeredListening: false,
  };

  // ─── overlay UI helpers(top-level,gate 之前定義,讓 spec 能呼叫)──
  // <shinkansen-drive-overlay>:position:fixed,動態追蹤 youtube embed iframe rect 對齊。
  // Shadow DOM 隔離 Drive 既有 CSS。pointer-events:none 不擋互動。
  // v1.8.54:結構從 .cue 單塊改 .cue-block > .src + .tgt 比照 content-youtube.js 雙語 overlay,
  //          中英共用一塊黑底,layout 不再分裂。
  const _OVERLAY_TAG = 'shinkansen-drive-overlay';

  function _ensureOverlay() {
    if (DRIVE.overlayHost && document.body.contains(DRIVE.overlayHost)) return DRIVE.overlayHost;
    const host = document.createElement(_OVERLAY_TAG);
    // v1.8.54:host 加 popover="manual",讓 fullscreen 時可呼叫 showPopover() 提升到
    //          top layer(跟 fullscreen iframe 同層),否則跨來源 iframe 進 fullscreen 後
    //          body 上的 fixed positioned overlay 會被 iframe 遮住。
    //          非 fullscreen 時不 showPopover(),走原本 fixed positioning 對齊 iframe rect。
    host.setAttribute('popover', 'manual');
    Object.assign(host.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '99999',
      display: 'none',
      left: '0px', top: '0px', width: '0px', height: '0px',
      // popover user agent default(border / padding / inset / background)清掉
      border: 'none',
      padding: '0',
      margin: '0',
      background: 'transparent',
      overflow: 'visible',
      inset: 'auto',
    });
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host {
          font-family: "PingFang TC", "Microsoft JhengHei", "微軟正黑體",
                       "Heiti TC", "Noto Sans CJK TC", sans-serif;
        }
        /* 預設 22%(非 fullscreen)避開 YouTube embed 控制列;fullscreen 時
           _updateOverlayPosition 會把 --sk-cue-bottom 設成 8%(視覺更貼近底部,
           跟 native CC 全螢幕位置一致)。cross-origin iframe 監測 chrome show/hide
           不可靠,所以兩個值都靠 fullscreen state 切,不依賴控制列偵測 */
        .container {
          position: absolute;
          left: 0; right: 0;
          bottom: var(--sk-cue-bottom, 22%);
          display: flex;
          justify-content: center;
          padding: 0 24px;
          box-sizing: border-box;
        }
        /* v1.8.54:.cue-block 共用黑底,讓 .src(英文)+ .tgt(中文)兩行包在同一塊;
           單塊背景跟 YouTube ASR 雙語視覺一致(原本 .src/.tgt 各自 inline-block 兩塊分離)。 */
        .cue-block {
          display: inline-block;
          max-width: 100%;
          padding: 0.15em 0.5em;
          background: rgba(0, 0, 0, 0.78);
          color: #fff;
          border-radius: 4px;
          text-align: center;
          box-sizing: border-box;
          letter-spacing: 0.02em;
        }
        .src, .tgt {
          display: block;
          /* v1.8.54:字級跟著 host 高度動態縮放(_updateOverlayPosition 內依 height × 0.04 設
             --sk-cue-size CSS variable),fullscreen 時 host 改對齊 viewport,字級自動放大 */
          font-size: var(--sk-cue-size, 22px);
          white-space: pre-wrap;
        }
        /* 英文行距緊縮(2 行原文不會過寬),中文 1.45 易讀 */
        .src { line-height: 1.05; }
        .tgt { line-height: 1.45; }
        .src[hidden], .tgt:empty { display: none; }
      </style>
      <div class="container">
        <div class="cue-block">
          <span class="src" hidden></span>
          <span class="tgt"></span>
        </div>
      </div>
    `;
    document.body.appendChild(host);
    DRIVE.overlayHost = host;
    DRIVE.overlaySrcEl = shadow.querySelector('.src');
    DRIVE.overlayTgtEl = shadow.querySelector('.tgt');
    return host;
  }

  // ─── active entry finder + 雙語原文撈取 ───────────────
  // commit 4b entries 數量小(11 句),linear search 即可。commit 5 整支翻完
  // (~250 句)再考慮 binary search。
  function _findActiveEntryIdx() {
    const t = DRIVE.currentTimeMs;
    const entries = DRIVE.entries;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      // effectiveEnd clamp 到下一條 startMs(對齊 content-youtube.js _findActiveCue):
      // 批尾 fallback endMs(+1500ms)或 LLM 給的 e 值跨 entry 重疊時，first-match 會
      // 讓上一句多掛、吃掉下一句開頭
      const nextStart = entries[i + 1] ? entries[i + 1].startMs : Infinity;
      const effectiveEnd = Math.min(e.endMs, nextStart);
      if (t >= e.startMs && t < effectiveEnd) return i;
    }
    return -1;
  }

  // 從 rawSegments 撈 [startMs, endMs) 區間的英文 join 出來。
  // Google 路徑 1:1 對應(每個 entry 包一個 raw segment);
  // Gemini 路徑 LLM 自由合句,一個 entry 可能涵蓋多個 raw segments,join with ' '。
  // raw segment 只有 startMs(parseJson3 不給 endMs),用 startMs 落在區間內判定。
  function _findOverlappingSrcText(startMs, endMs) {
    const segs = DRIVE.rawSegments;
    if (!segs || !segs.length) return '';
    const bits = [];
    for (const seg of segs) {
      if (seg.startMs >= startMs && seg.startMs < endMs) {
        const t = (seg.text || '').trim();
        if (t) bits.push(t);
      }
    }
    return bits.join(' ');
  }

  // v1.8.54:雙語走 .src + .tgt 兩行,純中文只寫 .tgt 並把 .src hidden。
  // entries idx 不變時不重 commit DOM(避免每幀 layout thrash);
  // 但 bilingualMode toggle live 時要強制重渲染 — toggle handler 會把
  // currentEntryIdx 設成 sentinel(-2)讓下一幀必走完整路徑。
  function _renderActiveCue() {
    const tgtEl = DRIVE.overlayTgtEl;
    const srcEl = DRIVE.overlaySrcEl;
    if (!tgtEl) return;
    const idx = _findActiveEntryIdx();
    if (idx === DRIVE.currentEntryIdx) return;
    DRIVE.currentEntryIdx = idx;

    if (idx === -1) {
      if (tgtEl.textContent !== '') tgtEl.textContent = '';
      if (srcEl) {
        if (srcEl.textContent !== '') srcEl.textContent = '';
        srcEl.hidden = true;
      }
      return;
    }

    const entry = DRIVE.entries[idx];
    const tgt = entry.text || '';
    if (tgtEl.textContent !== tgt) tgtEl.textContent = tgt;

    if (srcEl) {
      if (DRIVE.bilingualMode) {
        const src = _findOverlappingSrcText(entry.startMs, entry.endMs);
        if (src) {
          if (srcEl.textContent !== src) srcEl.textContent = src;
          srcEl.hidden = false;
        } else {
          if (srcEl.textContent !== '') srcEl.textContent = '';
          srcEl.hidden = true;
        }
      } else {
        if (srcEl.textContent !== '') srcEl.textContent = '';
        srcEl.hidden = true;
      }
    }
  }

  // 把 popup engine 設定原值轉為 Drive 路徑接受的三選一,未知值 fallback 'gemini'。
  // 定義在 runtime gate 之前讓 regression spec 也能驗(localServer 主機名 ≠ drive.google.com)。
  function _normalizeDriveEngine(v) {
    if (v === 'google') return 'google';
    if (v === 'openai-compat') return 'openai-compat';
    return 'gemini';
  }

  // 暴露給 spec 用(drive-bilingual-overlay 路徑 A regression / drive-engine-normalize)
  SK._driveEnsureOverlay = _ensureOverlay;
  SK._driveRenderActiveCue = _renderActiveCue;
  SK._driveFindOverlappingSrcText = _findOverlappingSrcText;
  SK._driveNormalizeEngine = _normalizeDriveEngine;

  // ─── 翻譯 pipeline（v1.10.46 起定義在 runtime gate 之前）──────────
  // 跟 overlay helpers 同理：純函式 + module state，不掛任何 listener，在非 Drive 頁
  // 零成本；移到 gate 前讓 regression spec（localServer fixture）能直接驅動
  // _handleCaptionsMessage 驗重入 guard / entry 對齊 / engine latch。
  // runtime 接線（storage 設定載入、onMessage 註冊、iframe _init）仍在 gate 之後。

  // commit 5a:整支切批,30 段一批,throttled max 3 並行
  const BATCH_SIZE = 30;
  const MAX_CONCURRENT = 3;

  // ─── ytSubtitle 設定追蹤(autoTranslate + engine + bilingualMode)──
  // commit 5a':共用 YouTube 字幕設定塊,user 不需要為 Drive 額外設定。
  // commit 5b:engine 分流('gemini' 走 D' LLM 合句 / 'google' 走 GT 逐段翻免費 /
  //          'openai-compat' 走 OpenAI-compat ASR LLM,跟 Gemini D' 模式對齊只是換 provider)。
  // v1.8.54:bilingualMode 從本地 let 改放 DRIVE.bilingualMode,讓 _renderActiveCue 同源讀取
  let _autoTranslateEnabled = true;
  let _engine = 'gemini';
  // v2.0.78:LOG_USAGE 記帳的 model 欄位——沿用 ytSubtitle.model override（跟翻譯
  // 實際走的 background geminiOverrides.model 同源）；空值時 background LOG_USAGE
  // handler 自己 fallback geminiConfig.model
  let _ytModel = '';

  // ─── 關掉 YouTube embed player 的原生 CC ──────────────
  // 透過 IFrame Player API postMessage 'command' func='unloadModule' arg='captions'。
  // 必須在 player onReady 之後送(timing 由 onMessage listener 控制)。
  // 注意:必須等 timedtext 已被 PerformanceObserver 捕捉**之後**才 unload,否則 player
  // 不再 fetch timedtext = iframe 偵測不到 URL = 字幕翻譯 pipeline 直接斷。
  // v1.8.54:雙語也走 overlay(中英並排),native CC 一律關 — 不再有「雙語=保留 native CC」分支。
  function _disablePlayerCaptions() {
    if (!DRIVE.iframeEl?.contentWindow) return;
    try {
      DRIVE.iframeEl.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: 'unloadModule', args: ['captions'] }),
        'https://youtube.googleapis.com'
      );
      SK.sendLog('info', 'drive', 'sent unloadModule captions');
    } catch (e) {
      SK.sendLog('warn', 'drive', 'unloadModule captions failed', { error: e?.message || String(e) });
    }
  }

  // ─── 用量記帳(v2.0.78)────────────────────────────────
  // Drive LLM 路徑成功批次比照 content-youtube.js _logWindowUsage 發 LOG_USAGE——
  // 之前只把 res.usage 丟進 sendLog,usage-db 完全沒這筆(整支影片的 Gemini token
  // 在用量儀表板 / GET_USAGE_STATS 對帳隱形，系統性低估）。Google 路徑不經此函式
  // （免費，chars 記帳已由 background handleTranslateGoogle 的 upsertGoogleUsage 落地）。
  // source='drive-subtitle' + videoId=Drive 檔案 id 走 background 的 upsert 合併路徑
  // （一支影片多批合成一筆，同 YouTube）。
  function _logDriveUsage(segCount, usage, engineLabel) {
    if (!usage || ((usage.inputTokens || 0) === 0 && (usage.cacheHits || 0) === 0)) return;
    const u = usage;
    const fileId = (location.pathname.match(/\/file\/([^/]+)/) || [])[1] || '';
    SK.safeSendMessage({
      type: 'LOG_USAGE',
      payload: {
        url:   location.href,
        title: document.title,
        source: 'drive-subtitle',
        videoId: fileId,                  // upsert 合併 key(缺值時 fallback 逐筆寫入)
        engine: engineLabel,              // 'openai-compat' 時 background 端改從 customProvider.model 解析
        model: _ytModel || undefined,
        inputTokens:      u.inputTokens     || 0,
        outputTokens:     u.outputTokens    || 0,
        cachedTokens:     u.cachedTokens    || 0,
        billedInputTokens: u.billedInputTokens || 0,
        billedCostUSD:    u.billedCostUSD   || 0,
        segments:         segCount,
        cacheHits:        u.cacheHits       || 0,
        durationMs:       0,
        timestamp:        Date.now(),
      },
    }).catch(() => {});
  }

  // ─── 單批翻譯：LLM D' 模式（自由合句 + 時間戳對齊）─────────
  // Gemini 與 OpenAI-compat（自訂 Provider）共用同一條核心，只差送的 message type
  // （background 走 handleTranslate / handleTranslateCustom）與 log 標籤；兩者都用同一份
  // ASR JSON timestamp 協定 + parseAsrResponse，跟 YouTube ASR 自訂 Provider 路徑同源。
  async function _runOneBatchLlm(batch, batchIdx, totalBatches, msgType, engineLabel) {
    if (batch.length === 0) return;

    // v2.0.54:批次末條 e 改查 DRIVE.rawSegments 真實後繼片段起點(跟 YT _runAsrSubBatch
    // 同源修法,固定 +1500ms 讓每批最後一句系統性提早消失)
    const lastSeg = batch[batch.length - 1];
    const batchEndMs = SK.ASR.batchEndMs(lastSeg.startMs, DRIVE.rawSegments);
    const inputArr = batch.map((seg, i) => {
      const next = batch[i + 1];
      const endMs = next ? next.startMs : batchEndMs;
      return { s: seg.startMs, e: endMs, t: seg.text };
    });
    const inputJson = JSON.stringify(inputArr);

    let res;
    try {
      res = await SK.safeSendMessage({
        type: msgType,
        payload: { texts: [inputJson], glossary: null },
      });
    } catch (e) {
      SK.sendLog('warn', 'drive', `batch ${batchIdx + 1}/${totalBatches} ${engineLabel} sendMessage failed`, {
        error: e?.message || String(e),
      });
      return;
    }

    if (!res?.ok) {
      SK.sendLog('warn', 'drive', `batch ${batchIdx + 1}/${totalBatches} ${engineLabel} failed`, {
        error: res?.error || 'unknown',
      });
      return;
    }

    // 記帳放在 parse 之前——API 已回應即已付費，parseAsrResponse 失敗丟棄結果錢也花了
    _logDriveUsage(batch.length, res.usage, engineLabel);

    const rawText = res.result?.[0] || '';
    let entries;
    try {
      entries = SK.ASR.parseAsrResponse(rawText);
    } catch (e) {
      SK.sendLog('warn', 'drive', `batch ${batchIdx + 1}/${totalBatches} parseAsrResponse failed (${engineLabel})`, {
        error: e?.message || String(e),
        rawHead: rawText.slice(0, 200),
      });
      return;
    }

    // v2.0.54: 驗證 + 顯示區間收斂到 SK.ASR.resolveEntryTimeline(YT _runAsrSubBatch 同源,
    // 避免同協定雙實作 drift)——entry.s 必須等於某條原始 startMs(幻覺丟棄),顯示區間由
    // 片段時間軸分割決定、不採信 LLM 的 e(挑錯 e 造成句尾提早消失);零長度區間不會產生
    const { cues, droppedCount } = SK.ASR.resolveEntryTimeline(entries, batch, batchEndMs);
    let pushedCount = 0;
    const _batchStarts = batch.map(seg => seg.startMs);
    for (const cue of cues) {
      // v2.0.54:超長合句過 splitLongCue 保底拆分(LLM 無視 prompt 字數上限時
      // 浮層會折出 3+ 行;與 YT overlay 同源修法)。batchStarts 供切點吸附到
      // 真實片段起點(函式內只取 cue 區間內的)
      for (const piece of SK.ASR.splitLongCue(cue.startMs, cue.endMs, cue.text, _batchStarts)) {
        DRIVE.entries.push({ startMs: piece.startMs, endMs: piece.endMs, text: piece.text });
        pushedCount++;
      }
    }
    DRIVE.entries.sort((a, b) => a.startMs - b.startMs);
    // 並行批次 push+sort 會移動既有索引——currentEntryIdx 是純數字索引，不失效的話
    // 可能命中「同索引不同 entry」而跳過重繪(overlay 卡舊譯文)。設 sentinel 讓下一幀必走完整路徑
    DRIVE.currentEntryIdx = -2;

    SK.sendLog('info', 'drive', `batch ${batchIdx + 1}/${totalBatches} done (${engineLabel})`, {
      llmEntryCount: entries.length,
      pushedToOverlay: pushedCount,
      droppedMisaligned: droppedCount,
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
      // v2.0.54:批次末條同 LLM 路徑改查 rawSegments 真實後繼片段起點
      const endMs = next ? next.startMs : SK.ASR.batchEndMs(seg.startMs, DRIVE.rawSegments);
      DRIVE.entries.push({ startMs: seg.startMs, endMs, text });
      pushedCount++;
    }
    DRIVE.entries.sort((a, b) => a.startMs - b.startMs);
    // 並行批次 push+sort 會移動既有索引——currentEntryIdx 是純數字索引，不失效的話
    // 可能命中「同索引不同 entry」而跳過重繪(overlay 卡舊譯文)。設 sentinel 讓下一幀必走完整路徑
    DRIVE.currentEntryIdx = -2;

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
    if (!SK.ASR?.parseJson3 || !SK.ASR?.parseAsrResponse || !SK.ASR?.resolveEntryTimeline) {
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

    // v1.10.46: 重入 guard——同一支字幕重複送進來（iframe reload / PerformanceObserver
    // 重複捕捉）時不重翻：entries 疊加 + 整支重翻 token ×2。指紋 = 條數 + 首尾 startMs。
    const _fp = `${rawSegments.length}|${rawSegments[0].startMs}|${rawSegments[rawSegments.length - 1].startMs}`;
    if (DRIVE._lastCaptionsFp === _fp) {
      SK.sendLog('info', 'drive', 'duplicate captions payload — skipping retranslation', { fp: _fp });
      return;
    }
    DRIVE._lastCaptionsFp = _fp;

    // 換軌(fingerprint 不同的新 payload)時清舊軌譯文——不清的話新舊兩軌 entries
    // 疊加共存，同一時間點重疊區間 first-match 隨排序交錯命中，overlay 在新舊譯文
    // 之間跳動；雙語 .src 又從新軌 rawSegments 撈，出現源文配舊軌譯文的錯配
    DRIVE.entries = [];
    DRIVE.currentEntryIdx = -2;

    // v1.8.54:存 raw segments 給雙語 overlay .src 撈對應時段原文
    DRIVE.rawSegments = rawSegments;

    // commit 5c:timedtext 已被 PerformanceObserver 捕捉(ASR_CAPTIONS 都送進來了),
    // 這時關 player CC 安全 — 不會影響字幕翻譯 pipeline。
    // v1.8.54:雙語也走 overlay(中英並排於 .cue-block 共用黑底),native CC 一律關。
    _disablePlayerCaptions();

    // commit 5a:整支切批 throttled 並行
    const batches = [];
    for (let i = 0; i < rawSegments.length; i += BATCH_SIZE) {
      batches.push(rawSegments.slice(i, i + BATCH_SIZE));
    }
    const totalBatches = batches.length;

    // v1.10.46: engine 在整支翻譯開始前 latch 成 const——原註解宣稱 latch 但實作每批
    // 重讀 _engine,mid-run 切設定會跨批混用 google / gemini / openai-compat 結果
    const engine = _engine;

    SK.sendLog('info', 'drive', 'starting full transcript translation', {
      totalSegments: rawSegments.length,
      totalBatches,
      maxConcurrent: MAX_CONCURRENT,
      engine,
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
        if (engine === 'google') {
          await _runOneBatchGoogle(batches[idx], idx, totalBatches);
        } else if (engine === 'openai-compat') {
          await _runOneBatchLlm(batches[idx], idx, totalBatches, 'TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH_CUSTOM', 'openai-compat');
        } else {
          await _runOneBatchLlm(batches[idx], idx, totalBatches, 'TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH', 'gemini');
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
    // v2.0.78（批次 3 C3）：翻譯全失敗（無 API key / 網路斷 / !res.ok 都只 log 就
    // return）時回滾 fingerprint——fp 在翻譯開始「前」latch，全失敗不回滾的話，
    // 使用者設好 key 後重按 CC 重觸發同一 payload 會被 fp 判 duplicate skip，
    // 到 reload 前永遠翻不出來（fp 判重是唯一重試入口）。只在 fp 仍是本輪值時清
    // （await 期間換軌進來的新 payload 已 re-latch，不可誤清）
    if (DRIVE.entries.length === 0 && DRIVE._lastCaptionsFp === _fp) {
      DRIVE._lastCaptionsFp = null;
      SK.sendLog('warn', 'drive', 'translation yielded no entries — fingerprint cleared for retry', { fp: _fp });
    }
  }

  // 暴露給 spec 用（drive captions pipeline regression：重入 guard / entry 對齊 / engine latch）
  SK._driveHandleCaptionsMessage = _handleCaptionsMessage;
  SK._driveSetEngine = (v) => { _engine = _normalizeDriveEngine(v); };
  SK._driveSetAutoTranslate = (v) => { _autoTranslateEnabled = v !== false; };

  // ─── Runtime gate ───────────────────────────────────
  // 只在 Drive viewer top frame 啟動實際 runtime(message listener / batch 翻譯 / iframe 偵測)。
  // 上面定義的 helpers 在 spec 環境也存在(localServer 跑 fixture page)。
  if (location.hostname !== 'drive.google.com') return;
  if (!location.pathname.startsWith('/file/')) return;
  if (window.top !== window) return;

  // ─── ytSubtitle 設定載入（pipeline state 定義在 gate 前，這裡只做 runtime 接線）──
  (async () => {
    try {
      // v2.0.85:字幕雙語對照與整頁「顯示模式」合併——bilingualMode 唯一來源是
      // displayMode === 'dual'(舊 ytSubtitle.bilingualMode 殘留 key 忽略)
      const { ytSubtitle = {}, displayMode } = await browser.storage.sync.get(['ytSubtitle', 'displayMode']);
      _autoTranslateEnabled = ytSubtitle.autoTranslate !== false;
      _engine = _normalizeDriveEngine(ytSubtitle.engine);
      _ytModel = ytSubtitle.model || '';
      DRIVE.bilingualMode = displayMode === 'dual';
      SK.sendLog('info', 'drive', 'settings loaded (from ytSubtitle)', {
        autoTranslate: _autoTranslateEnabled,
        engine: _engine,
        bilingual: DRIVE.bilingualMode,
      });
    } catch { /* 維持預設 */ }
  })();
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.ytSubtitle) {
      const newVal = changes.ytSubtitle.newValue || {};
      const nextEnabled = newVal.autoTranslate !== false;
      if (nextEnabled !== _autoTranslateEnabled) {
        _autoTranslateEnabled = nextEnabled;
        SK.sendLog('info', 'drive', 'autoTranslate setting changed', { enabled: nextEnabled });
      }
      const nextEngine = _normalizeDriveEngine(newVal.engine);
      if (nextEngine !== _engine) {
        _engine = nextEngine;
        SK.sendLog('info', 'drive', 'engine setting changed', { engine: nextEngine });
      }
      _ytModel = newVal.model || '';
    }
    // v2.0.85:bilingual 即時切換改監聽 displayMode(與 content-youtube.js 同款導出)
    if (changes.displayMode) {
      const nextBilingual = changes.displayMode.newValue === 'dual';
      if (nextBilingual !== DRIVE.bilingualMode) {
        DRIVE.bilingualMode = nextBilingual;
        // v1.8.54:雙語/純中文都走 overlay(native CC 一律關),切換時不再 loadModule/unloadModule;
        //         只把 currentEntryIdx 設成 sentinel,下一幀 _renderActiveCue 重 commit src/tgt。
        DRIVE.currentEntryIdx = -2;
        SK.sendLog('info', 'drive', 'bilingualMode toggled live (displayMode)', { bilingual: nextBilingual });
      }
    }
  });

  function _findPlayerIframe() {
    return document.querySelector('iframe[src*="youtube.googleapis.com/embed"]');
  }

  // ─── fullscreen 處理 ──────────────────────────────────
  // 跨來源 iframe(youtube.googleapis.com/embed)進 fullscreen 時,從 parent 角度
  // iframe element 被提升到 top layer。我們的 overlay host 是 body 的 child,跟 iframe
  // 同層 → 被 fullscreen 蓋住。解法:host 加 popover="manual" attr,fullscreenchange
  // 事件觸發時 showPopover() 把 host 也提升到 top layer(popover 後加進 top layer
  // 會疊在 fullscreen element 上面)。退出 fullscreen 時 hidePopover() 還原 normal flow。
  function _handleFullscreenChange() {
    const host = DRIVE.overlayHost;
    if (!host) return;
    const fsElem = document.fullscreenElement;
    const isFs = !!fsElem;
    try {
      if (isFs) {
        if (typeof host.showPopover === 'function') host.showPopover();
      } else {
        if (typeof host.hidePopover === 'function') host.hidePopover();
      }
    } catch (e) {
      // 已 open / 已 close 的 popover 重複呼叫會 throw,吞掉即可
    }
    SK.sendLog('info', 'drive', 'fullscreenchange', { isFs, fsElemTag: fsElem?.tagName });
  }

  // ─── iframe rect 追蹤 ────────────────────────────────
  // Drive viewer 通常不 scroll,但 sidebar 開合會 resize iframe。rAF loop 持續校正,
  // 比 ResizeObserver 簡單(且 rAF loop 本來就要跑來 render cue)。
  // v1.8.54:fullscreen 時 host 對齊整個 viewport(iframe element 在 parent layout 的
  //          rect 沒變大,但視覺已被瀏覽器接管成全螢幕),否則會繼續用原本 iframe rect
  //          → host width 仍是小尺寸 → 字級看起來偏小。
  //          字級依 host height × 0.04 動態縮放(下限 16px / 上限 56px),跟 YouTube
  //          native CC 縮放邏輯一致。
  function _updateOverlayPosition() {
    const iframe = DRIVE.iframeEl;
    const host = DRIVE.overlayHost;
    if (!iframe || !host) return;
    let left, top, width, height;
    const isFs = !!document.fullscreenElement;
    if (isFs) {
      left = 0; top = 0;
      width = window.innerWidth;
      height = window.innerHeight;
    } else {
      const rect = iframe.getBoundingClientRect();
      left = rect.left; top = rect.top;
      width = rect.width; height = rect.height;
    }
    if (width < 100 || height < 100) {
      host.style.display = 'none';
      return;
    }
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    host.style.width = `${width}px`;
    host.style.height = `${height}px`;
    host.style.display = 'block';
    const fontSize = Math.max(16, Math.min(56, Math.round(height * 0.04)));
    host.style.setProperty('--sk-cue-size', `${fontSize}px`);
    // fullscreen 拉近底部(8% ≈ native CC 全螢幕位置),非 fullscreen 維持 22% 避開 YouTube 控制列
    host.style.setProperty('--sk-cue-bottom', isFs ? '8%' : '22%');
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
    // v1.10.39(code review 2026-06-09):防重複綁定。_init 正常只跑一次,但加 guard
    // 確保即使被多次呼叫也不疊加 message listener(infoDelivery 每 250ms 推,疊加會放大 currentTimeMs 寫入)。
    if (DRIVE._msgListenerInstalled) return;
    DRIVE._msgListenerInstalled = true;
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
        // 已知 limitation:Drive embed(youtube.googleapis.com/embed)不吃任何自動開字幕指令。
        //   試過 fail 的解法:
        //     - URL 參數 cc_load_policy=1 → 加上後 CC 按鈕直接灰掉(player 被破壞)
        //     - setOption('captions','reload',true) boolean+先 loadModule+延遲 1.5s → 完全沒反應
        //     - commit 5c.7 setOption track 路徑 → revert 5c.8
        //   user 必須手按 CC 一次觸發 timedtext fetch → 翻譯 pipeline 才啟動。
        //   公開 youtube.com/embed 可能可以,但 Drive 的 internal embed endpoint 不行。
      }

      if (data.event === 'infoDelivery' && typeof data.info?.currentTime === 'number') {
        DRIVE.currentTimeMs = Math.floor(data.info.currentTime * 1000);
      }
    });
  }

  // ─── 主 rAF loop:rect 追蹤 + render cue ─────────────
  // 每幀做 getBoundingClientRect(_updateOverlayPosition)讓 overlay 平順跟隨 Drive
  // 頁捲動,所以維持 per-frame。但 v1.10.39(code review 2026-06-09 M2)補兩道收斂:
  //   1. orphan content script(extension reload)→ 自我停止,避免空轉耗電(同 M1 / safeSendMessage 偵測法)
  //   2. 防重複啟動(_init 萬一被呼叫多次也只跑一條 loop)
  // 註:不在 _autoTranslateEnabled=false 時暫停——暫停後需可靠的 resume 觸發,風險高於
  //     收益(Drive 是 niche 路徑),故只收斂「永遠回不來」的 orphan 情境。
  function _startRenderLoop() {
    if (DRIVE.renderLoopRunning) return; // 已在跑,不重複啟動
    DRIVE.renderLoopRunning = true;
    function loop() {
      if (!globalThis.chrome?.runtime?.id) { // orphan → 停止
        DRIVE.renderLoopRunning = false;
        DRIVE.renderLoopId = null;
        return;
      }
      _updateOverlayPosition();
      _renderActiveCue();
      DRIVE.renderLoopId = requestAnimationFrame(loop);
    }
    DRIVE.renderLoopId = requestAnimationFrame(loop);
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
    // v1.8.54:fullscreen 時 host 提升到 top layer(popover),才不會被 fullscreen iframe 遮住
    document.addEventListener('fullscreenchange', _handleFullscreenChange);
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
