// content-x.js — Shinkansen X（Twitter）影片字幕翻譯
//
// 執行環境：isolated world，run_at: document_idle，<all_urls> + all_frames: true。
// gate 只在 x.com / twitter.com top frame 啟動 runtime；純函式與翻譯 pipeline 定義在 gate 之前
// 並暴露 SK._x*，讓 regression spec 在 localServer fixture 頁直接驅動（同 content-drive.js 慣例）。
//
// 資料來源（2026-10-19 實測 x.com 播放器）：
//   - 影片走 HLS，master playlist `video.twimg.com/amplify_video/<mediaId>/pl/<hash>.m3u8`；
//     使用者上傳的影片是 `video.twimg.com/ext_tw_video/<mediaId>/pu/pl/<hash>.m3u8`（多一層 /pu/，
//     2026-11-15 實測；部分也帶自動字幕軌）
//     帶 `#EXT-X-MEDIA:TYPE=SUBTITLES`（X 自動產生的 ASR 字幕軌，NAME 如「en (auto-generated)」）
//     → 字幕 playlist → 整支一個 WebVTT（cue 為 ~1 秒 ASR 碎片，帶 <X-word-ms> 字級時間標記）
//   - <video> 是 MSE blob: src，對不到 m3u8；改用 poster 屬性
//     `pbs.twimg.com/<amplify_video_thumb|ext_tw_video_thumb>/<mediaId>/...` 取 mediaId，
//     再從 PerformanceObserver 蒐集到的 master m3u8 URL 以 mediaId 對應
//   - video.twimg.com 對 x.com 開 CORS，content script 直接 fetch
//
// 翻譯：VTT 碎片 → rawSegments → SK.ASR（YouTube / Drive 共用的 LLM 合句 + 時間軸對齊協定）。
// 顯示：在 <video> 上 addTextTrack 掛一條譯文字幕軌（瀏覽器原生 cue 渲染，外觀同 X 自家字幕，
//       全螢幕 / 時間軸捲動不必追位置）；X 的 CC 鈕兼當譯文字幕開關（見 _syncWithNativeTracks）。
// 觸發（產品決策 2026-10-19）：影片「有聲音播放」時才翻——時間軸自動靜音播放不翻，避免滑過就燒 API。
//       2026-11-15 起連「翻多少」也跟著播放走：只翻播放位置往後 LOOKAHEAD_MS 內的批次，暫停 /
//       靜音 / 滑走（X 會暫停）就不再派新批，繼續播或拖動時間軸再接著翻（見 _pickDemanded）。
// 設定：共用 ytSubtitle（autoTranslate / engine / model），雙語跟隨 displayMode === 'dual'。
//
// 派批迴圈與逐批狀態（pending / done / failed）走 SK.ASR.runTranscript，與 content-drive.js 共用。
// 仍是雙實作的部分：單批函式（_runBatchLlm / _runBatchGoogle ↔ Drive 的 _runOneBatchLlm /
// _runOneBatchGoogle）結構相同、狀態容器不同。改 SK.ASR 協定用法（resolveEntryTimeline /
// splitLongCue / batchEndMs）、stale run 判定時兩邊要一起改。

(function (SK) {
  if (!SK || SK.disabled) return;

  const BATCH_SIZE = 30;
  const MAX_CONCURRENT = 3;
  const TRACK_LABEL = 'Shinkansen';
  // 只翻播放位置往後這段時間內的批次（一批 30 個 ASR 片段，約半分鐘到一分鐘）
  const LOOKAHEAD_MS = 180000;
  // 失敗批次：最多試 MAX_BATCH_ATTEMPTS 次，第 n 次失敗後等 5s × 4^(n-1) 才放回佇列
  const MAX_BATCH_ATTEMPTS = 3;
  const _batchBackoffMs = (attempts) => 5000 * Math.pow(4, Math.max(0, attempts - 1));

  const XV = SK.XV = SK.XV || {
    // mediaId → master m3u8 URL（PerformanceObserver 蒐集）
    masterUrls: new Map(),
    // mediaId → { status, rawSegments, entries, runId, sourceLang, videos:Set, batches, batchState, running }
    //   status: 'idle' | 'loading'（抓字幕中）| 'ready'（字幕已就緒，譯文隨播放逐批補）
    //         | 'done'（全部批次完成）| 'none'（無字幕軌）| 'skip'（已是目標語言）
    media: new Map(),
    bilingualMode: false,
    autoTranslate: true,
    engine: 'gemini',
    model: '',
  };

  // ─── 純函式（spec 直接驗）────────────────────────────

  // poster URL → mediaId（amplify_video_thumb / ext_tw_video_thumb；tweet_video_thumb 是 GIF 無聲不處理）
  function mediaIdFromPoster(poster) {
    const m = String(poster || '').match(/\/(?:amplify_video_thumb|ext_tw_video_thumb)\/(\d+)\//);
    return m ? m[1] : null;
  }

  // master m3u8 URL → mediaId。只認 /pl/<hash>.m3u8（master）；/pl/avc1/…、/pl/mp4a/…、/pl/s0/…
  // 是子 playlist，多一層目錄不會命中。ext_tw_video（使用者上傳）在 mediaId 後多一層 /pu/
  function mediaIdFromMasterUrl(url) {
    const m = String(url || '').match(/^https:\/\/video\.twimg\.com\/(?:amplify_video|ext_tw_video)\/(\d+)\/(?:pu\/)?pl\/[A-Za-z0-9_-]+\.m3u8(?:\?|$)/);
    return m ? m[1] : null;
  }

  function _parseHlsAttrs(s) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
    return out;
  }

  // master playlist 文字 → 字幕軌清單 [{ uri(絕對), lang, name, isDefault }]
  function parseMasterSubtitles(text, baseUrl) {
    const tracks = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      if (!line.startsWith('#EXT-X-MEDIA:')) continue;
      const a = _parseHlsAttrs(line.slice('#EXT-X-MEDIA:'.length));
      if (a.TYPE !== 'SUBTITLES' || !a.URI) continue;
      let uri;
      try { uri = new URL(a.URI, baseUrl).href; } catch { continue; }
      tracks.push({ uri, lang: a.LANGUAGE || '', name: a.NAME || '', isDefault: a.DEFAULT === 'YES' });
    }
    return tracks;
  }

  // media playlist 文字 → 片段 URL 清單（非 # 開頭的行）
  function parseMediaPlaylist(text, baseUrl) {
    const urls = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      try { urls.push(new URL(line, baseUrl).href); } catch { /* 略過壞行 */ }
    }
    return urls;
  }

  function _vttTimeToMs(t) {
    const m = String(t).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
    if (!m) return NaN;
    return ((+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + +m[4].padEnd(3, '0');
  }

  const _ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

  // WebVTT 文字 → rawSegments [{ text, startMs, endMs }]，startMs 嚴格遞增
  // （SK.ASR 協定以 startMs 當片段 id，重複會讓 resolveEntryTimeline 對齊失準——同 parseJson3 perLineTiming）
  function parseVtt(text) {
    const segs = [];
    const blocks = String(text || '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
    for (const block of blocks) {
      const lines = block.split('\n');
      const ti = lines.findIndex(l => l.includes('-->'));
      if (ti < 0) continue;   // WEBVTT 標頭 / NOTE / STYLE
      const [a, b] = lines[ti].split('-->');
      const startMs = _vttTimeToMs(a);
      const endMs = _vttTimeToMs(String(b).trim().split(/\s+/)[0]);
      if (!Number.isFinite(startMs)) continue;
      const body = lines.slice(ti + 1).join(' ')
        .replace(/<[^>]*>/g, '')
        .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, k) => _ENTITIES[k])
        .replace(/\s+/g, ' ')
        .trim();
      if (!body) continue;
      segs.push({ text: body, startMs, endMs: Number.isFinite(endMs) ? endMs : startMs + 1000 });
    }
    segs.sort((x, y) => x.startMs - y.startMs);
    for (let i = 1; i < segs.length; i++) {
      if (segs[i].startMs <= segs[i - 1].startMs) segs[i].startMs = segs[i - 1].startMs + 1;
    }
    return segs;
  }

  // 雙語原文：rawSegments 起點落在 [startMs, endMs) 的片段接起來（同 content-drive.js _findOverlappingSrcText）
  function overlappingSrcText(rawSegments, startMs, endMs, lang) {
    const bits = (rawSegments || [])
      .filter(s => s.startMs >= startMs && s.startMs < endMs)
      .map(s => s.text);
    if (!bits.length) return '';
    return typeof SK.ASR?.joinSegTexts === 'function' ? SK.ASR.joinSegTexts(bits, lang) : bits.join(' ');
  }

  // entries → 原生 text track cue 清單 [{ startSec, endSec, text }]
  // 時間語意與 SK.ASR.findActiveCueIdx 一致：整段提前 ASR_CUE_LEAD_MS、區間尾 clamp 到下一則起點
  // （原生 track 允許 cue 重疊，不 clamp 會兩則同時疊著顯示）
  function buildCueList(entries, rawSegments, bilingual, lang) {
    const lead = SK.ASR_CUE_LEAD_MS || 0;
    const out = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const next = entries[i + 1];
      const effEnd = next ? Math.min(e.endMs, next.startMs) : e.endMs;
      const start = Math.max(0, e.startMs - lead);
      const end = Math.max(start + 1, effEnd - lead);
      let text = e.text;
      if (bilingual) {
        const src = overlappingSrcText(rawSegments, e.startMs, e.endMs, lang);
        if (src) text = `${src}\n${text}`;
      }
      out.push({ startSec: start / 1000, endSec: end / 1000, text });
    }
    return out;
  }

  // 字幕軌語言已是目標語言 → 不翻（同 YouTube 字幕 SKIP_LANGS_BY_TARGET，單一資料源在 content-youtube.js）
  function isLangAlreadyTarget(lang, target) {
    const set = SK.ASR?.skipLangsByTarget?.[target || 'zh-TW'];
    return !!(set && lang && set.has(lang));
  }

  SK._xMediaIdFromPoster = mediaIdFromPoster;
  SK._xMediaIdFromMasterUrl = mediaIdFromMasterUrl;
  SK._xParseMasterSubtitles = parseMasterSubtitles;
  SK._xParseMediaPlaylist = parseMediaPlaylist;
  SK._xParseVtt = parseVtt;
  SK._xBuildCueList = buildCueList;

  // ─── 原生字幕軌渲染 ─────────────────────────────────

  // 譯文軌在第一次有 cue 可畫時建立並設 showing；之後 showing / disabled 交給使用者
  // （X 的 CC 鈕，見 _syncWithNativeTracks）與 autoTranslate 開關決定，重繪 cue 不改 mode
  function _ourTrack(video) {
    if (!video._skXTrack) {
      const lang = SK.STATE?.targetLanguage || 'zh-TW';
      video._skXTrack = video.addTextTrack('subtitles', TRACK_LABEL, lang);
      video._skXCues = [];
      video._skXCreatedAt = Date.now();
      video._skXTrack.mode = 'showing';
      _watchNativeTracks(video);
      // X 收到 addtrack 會依它自己的「字幕關」狀態把所有 track（含剛加的譯文軌）設 disabled
      // （實測：建立後立即被關、change 事件可能在 listener 之前就派完），建立初期補設兩次
      for (const ms of [300, 1000]) setTimeout(() => _syncWithNativeTracks(video), ms);
    }
    return video._skXTrack;
  }
  // 建立後這段時間內譯文軌被設 disabled = X 播放器初始化，不是使用者按 CC
  const _INIT_GRACE_MS = 1500;

  // X 的 CC 鈕當譯文字幕開關用（2026-10-19 實測 X 播放器行為）：
  //   - X 依「有沒有任一 track 是 showing」決定按鈕顯示 Show / Hide captions
  //   - 新 track 加入時 X 會依自身狀態把它設 disabled → 建立後 _INIT_GRACE_MS 內視為初始化、重新打開
  //   - 按「Hide captions」→ X 把所有 track（含譯文軌）設 disabled → 尊重，不自動重開
  //   - 按「Show captions」→ X 只開自己的原文軌、把其他 track（譯文軌）設 disabled
  //     → 這裡接手：原文軌改 hidden、譯文軌改 showing，畫面上只有譯文（雙語模式譯文 cue 已含原文）
  // 防呆：X 若反覆把原文軌設回 showing（互搶），1 秒內超過 10 次就放手
  function _syncWithNativeTracks(video) {
    const ours = video._skXTrack;
    if (!ours || !XV.autoTranslate) return;
    const others = Array.from(video.textTracks).filter(t => t !== ours && t.mode === 'showing');
    if (!others.length) {
      if (ours.mode === 'disabled' && Date.now() - video._skXCreatedAt < _INIT_GRACE_MS) ours.mode = 'showing';
      return;
    }
    const now = Date.now();
    const g = video._skXGuard || (video._skXGuard = { t: now, n: 0, gaveUp: false });
    if (g.gaveUp) return;
    if (now - g.t > 1000) { g.t = now; g.n = 0; }
    if (++g.n > 10) {
      g.gaveUp = true;
      SK.sendLog('warn', 'x', 'native caption track keeps re-showing — stop taking over');
      return;
    }
    for (const t of others) {
      t.mode = 'hidden';
      // 記下被我們藏起來的原文軌：關閉字幕翻譯 / 讓位時要還給使用者（見 _restoreNativeTracks）
      (video._skXHiddenTracks || (video._skXHiddenTracks = new Set())).add(t);
    }
    if (ours.mode !== 'showing') ours.mode = 'showing';
  }

  // 關閉字幕翻譯（或讓位給另一份 Shinkansen）時，把先前為了只顯示譯文而藏起來的原文軌打開。
  // 原本只關譯文軌：使用者本來開著 X 的字幕、被我們換成譯文，一關翻譯畫面上就什麼字幕都沒有，
  // 要自己再按兩次 CC 才回得來
  function _restoreNativeTracks(video) {
    const hidden = video._skXHiddenTracks;
    if (!hidden || !hidden.size) return;
    for (const t of hidden) { try { if (t.mode === 'hidden') t.mode = 'showing'; } catch (_) {} }
    hidden.clear();
  }

  // 同一個 <video> 元素換了影片（X 的時間軸 / 全螢幕播放器會重用元素、只換 poster 與來源）：
  // 把它從舊影片的紀錄移除並清掉舊譯文 cue，否則舊影片的譯文會照舊時間點浮在新影片上
  function _bindVideoMedia(video, mediaId) {
    const prev = video._skXMediaId;
    if (prev && prev !== mediaId) {
      XV.media.get(prev)?.videos.delete(video);
      if (video._skXTrack) {
        for (const c of (video._skXCues || [])) { try { video._skXTrack.removeCue(c); } catch (_) {} }
        video._skXCues = [];
      }
    }
    video._skXMediaId = mediaId;
  }

  function _watchNativeTracks(video) {
    try {
      video.textTracks.addEventListener('change', () => _syncWithNativeTracks(video));
    } catch (_) { /* 舊瀏覽器無 TextTrackList change 事件：只在 render 時同步一次 */ }
  }

  function _renderVideo(video, rec) {
    if (!XV.autoTranslate) {
      if (video._skXTrack) video._skXTrack.mode = 'disabled';
      _restoreNativeTracks(video);
      return;
    }
    if (!rec.entries.length) return;
    const track = _ourTrack(video);
    // track.cues 在 disabled 時是 null，自己記已加的 cue 才能在使用者關掉字幕時照樣換新
    for (const c of video._skXCues) { try { track.removeCue(c); } catch (_) {} }
    video._skXCues = [];
    const Cue = window.VTTCue || window.TextTrackCue;
    for (const c of buildCueList(rec.entries, rec.rawSegments, XV.bilingualMode, rec.sourceLang)) {
      try {
        const cue = new Cue(c.startSec, c.endSec, SK.escapeCueText(c.text));
        track.addCue(cue);
        video._skXCues.push(cue);
      } catch (_) { /* 單則失敗不影響其他 */ }
    }
    _syncWithNativeTracks(video);
  }

  function _renderMedia(rec) {
    for (const v of rec.videos) {
      if (!v.isConnected) { rec.videos.delete(v); continue; }
      _renderVideo(v, rec);
    }
  }

  function _renderAll() {
    for (const rec of XV.media.values()) _renderMedia(rec);
  }
  SK._xRenderAll = _renderAll;

  // ─── 用量記帳（同 content-drive.js _logDriveUsage；source='x-subtitle' 走 upsert 合併）──
  function _logUsage(mediaId, segCount, usage, engineLabel) {
    if (!usage || ((usage.inputTokens || 0) === 0 && (usage.cacheHits || 0) === 0)) return;
    SK.safeSendMessage({
      type: 'LOG_USAGE',
      payload: {
        url: location.href,
        title: document.title,
        source: 'x-subtitle',
        videoId: mediaId,
        engine: engineLabel,
        model: XV.model || undefined,
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        cachedTokens: usage.cachedTokens || 0,
        billedInputTokens: usage.billedInputTokens || 0,
        billedCostUSD: usage.billedCostUSD || 0,
        segments: segCount,
        cacheHits: usage.cacheHits || 0,
        durationMs: 0,
        timestamp: Date.now(),
      },
    }).catch(() => {});
  }

  // ─── 批次翻譯（與 content-drive.js 同構，見檔頭「雙實作」說明）──────

  async function _runBatchLlm(rec, mediaId, batch, label, msgType, engineLabel, runId) {
    const batchEndMs = SK.ASR.batchEndMs(batch[batch.length - 1].startMs, rec.rawSegments);
    let res;
    try {
      res = await SK.safeSendMessage({
        type: msgType,
        payload: { texts: [SK.ASR.buildLlmInput(batch)], glossary: null, sourceLanguage: rec.sourceLang || 'en' },
      });
    } catch (e) {
      SK.sendLog('warn', 'x', `batch ${label} ${engineLabel} sendMessage failed`, { error: e?.message || String(e) });
      return false;
    }
    if (!res?.ok) {
      SK.sendLog('warn', 'x', `batch ${label} ${engineLabel} failed`, { error: res?.error || 'unknown' });
      return false;
    }
    _logUsage(mediaId, batch.length, res.usage, engineLabel);   // 已付費就記帳，parse 失敗也一樣
    if (runId !== rec.runId) return false;
    let entries;
    try {
      entries = SK.ASR.parseLlmOutput(res.result?.[0] || '', batch, batchEndMs);
    } catch (e) {
      SK.sendLog('warn', 'x', `batch ${label} parse failed (${engineLabel})`, { error: e?.message || String(e) });
      return false;
    }
    const { cues, droppedCount } = SK.ASR.resolveEntryTimeline(entries, batch, batchEndMs);
    const starts = batch.map(s => s.startMs);
    for (const cue of cues) {
      for (const piece of SK.ASR.splitLongCue(cue.startMs, cue.endMs, cue.text, starts)) {
        rec.entries.push({ startMs: piece.startMs, endMs: piece.endMs, text: piece.text });
      }
    }
    rec.entries.sort((a, b) => a.startMs - b.startMs);
    SK.sendLog('info', 'x', `batch ${label} done (${engineLabel})`, {
      mediaId, llmEntryCount: entries.length, droppedMisaligned: droppedCount, totalEntries: rec.entries.length,
    });
    return true;
  }

  async function _runBatchGoogle(rec, mediaId, batch, label, runId) {
    let res;
    try {
      res = await SK.safeSendMessage({ type: 'TRANSLATE_X_BATCH_GOOGLE', payload: { texts: batch.map(s => s.text), glossary: null } });
    } catch (e) {
      SK.sendLog('warn', 'x', `batch ${label} google sendMessage failed`, { error: e?.message || String(e) });
      return false;
    }
    if (!res?.ok) {
      SK.sendLog('warn', 'x', `batch ${label} google failed`, { error: res?.error || 'unknown' });
      return false;
    }
    if (runId !== rec.runId) return false;
    const tr = Array.isArray(res.result) ? res.result : [];
    for (let i = 0; i < batch.length; i++) {
      const text = String(tr[i] || '').trim();
      if (!text) continue;
      const next = batch[i + 1];
      const endMs = next ? next.startMs : SK.ASR.batchEndMs(batch[i].startMs, rec.rawSegments);
      rec.entries.push({ startMs: batch[i].startMs, endMs, text });
    }
    rec.entries.sort((a, b) => a.startMs - b.startMs);
    SK.sendLog('info', 'x', `batch ${label} done (google)`, { mediaId, totalEntries: rec.entries.length });
    return true;
  }

  // ─── 依播放位置派批（Y-2）─────────────────────────────
  // 「有聲播放中」：播放中 + 非靜音 + 音量 > 0（與 _maybeStart 的觸發判定同一條）
  function _isAudible(v) {
    return !!v && v.isConnected !== false && !v.paused && !v.muted && v.volume > 0;
  }
  // 下一個該翻的批次：有聲播放中的影片，播放位置之後 LOOKAHEAD_MS 內、最接近播放位置的
  // pending 批次。沒有影片在有聲播放、或這段範圍內都翻完了 → -1（不派新批）。
  // 已播過的批次不補翻（往回拖時間軸才會落回範圍內）
  function _pickDemanded(rec) {
    const state = rec.batchState;
    if (!state) return -1;
    const times = [];
    for (const v of rec.videos) if (_isAudible(v)) times.push((v.currentTime || 0) * 1000);
    if (!times.length) return -1;
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < state.length; i++) {
      if (state[i].status !== 'pending') continue;
      const start = rec.batches[i][0].startMs;
      const end = i + 1 < rec.batches.length ? rec.batches[i + 1][0].startMs : Infinity;
      for (const t of times) {
        if (end <= t || start > t + LOOKAHEAD_MS) continue;
        const dist = Math.max(0, start - t);
        if (dist < bestDist) { bestDist = dist; best = i; }
      }
    }
    return best;
  }

  // status === 'ready' 的 rec：把目前播放位置需要的批次翻掉；每批完成即重繪 cue。
  // 同一 rec 同時只有一輪在跑；沒有需求就直接返回，之後由 play / timeupdate / seeked 再叫起
  async function _pump(mediaId, rec) {
    if (rec.running || rec.status !== 'ready' || !XV.autoTranslate) return;
    // 失敗批次過了等待時間就放回佇列（Y-3：缺的批次補得回來；次數有上限，不會無限重打）
    SK.ASR.reviveFailedBatches(rec.batchState, { maxAttempts: MAX_BATCH_ATTEMPTS, backoffMs: _batchBackoffMs });
    if (_pickDemanded(rec) < 0) return;
    rec.running = true;
    const engine = XV.engine;   // 每輪開始前 latch，同一輪內切設定不跨批混用
    const runId = rec.runId;
    const total = rec.batches.length;
    let summary;
    try {
      summary = await SK.ASR.runTranscript({
        state: rec.batchState,
        maxConcurrent: MAX_CONCURRENT,
        shouldStop: () => !XV.autoTranslate || runId !== rec.runId,
        pickNext: () => _pickDemanded(rec),
        runBatch: async (idx) => {
          const label = `${idx + 1}/${total}`;
          let ok;
          if (engine === 'google') {
            ok = await _runBatchGoogle(rec, mediaId, rec.batches[idx], label, runId);
          } else if (engine === 'openai-compat') {
            ok = await _runBatchLlm(rec, mediaId, rec.batches[idx], label, 'TRANSLATE_X_ASR_SUBTITLE_BATCH_CUSTOM', 'openai-compat', runId);
          } else {
            ok = await _runBatchLlm(rec, mediaId, rec.batches[idx], label, 'TRANSLATE_X_ASR_SUBTITLE_BATCH', 'gemini', runId);
          }
          if (runId === rec.runId) _renderMedia(rec);
          return ok;
        },
      });
    } finally {
      rec.running = false;
    }
    // 全部批次都完成才是 done；有 pending（還沒播到）或 failed（待重試）就留在 ready
    if (summary.done === total) rec.status = 'done';
    SK.sendLog('info', 'x', 'transcript pump finished', {
      mediaId, totalEntries: rec.entries.length, status: rec.status, batches: summary,
    });
  }
  SK._xPump = _pump;
  SK._xPickDemanded = _pickDemanded;

  async function _fetchText(url) {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.text();
  }

  // video + master URL → 抓字幕、翻譯、掛 cue。同一 mediaId 多個 <video>（引用推文等）共用一份譯文
  async function startForVideo(video, mediaId, masterUrl) {
    let rec = XV.media.get(mediaId);
    if (!rec) {
      rec = { status: 'idle', rawSegments: [], entries: [], runId: 0, sourceLang: '', videos: new Set(), batches: [], batchState: null, running: false };
      XV.media.set(mediaId, rec);
    }
    _bindVideoMedia(video, mediaId);
    rec.videos.add(video);
    if (rec.status === 'done') { _renderVideo(video, rec); return; }
    if (rec.status === 'ready') { _renderVideo(video, rec); _pump(mediaId, rec); return; }
    if (rec.status !== 'idle') return;
    rec.status = 'loading';
    try {
      const tracks = parseMasterSubtitles(await _fetchText(masterUrl), masterUrl);
      if (!tracks.length) {
        rec.status = 'none';
        SK.sendLog('info', 'x', 'no subtitle track in master playlist', { mediaId });
        return;
      }
      const target = SK.STATE?.targetLanguage || 'zh-TW';
      if (tracks.some(t => isLangAlreadyTarget(t.lang, target))) {
        rec.status = 'skip';
        SK.sendLog('info', 'x', 'subtitle already in target language — skip', { mediaId, langs: tracks.map(t => t.lang), target });
        return;
      }
      const track = tracks.find(t => t.isDefault) || tracks[0];
      const segUrls = parseMediaPlaylist(await _fetchText(track.uri), track.uri);
      const raw = [];
      for (const u of segUrls) raw.push(...parseVtt(await _fetchText(u)));
      raw.sort((a, b) => a.startMs - b.startMs);
      for (let i = 1; i < raw.length; i++) {
        if (raw[i].startMs <= raw[i - 1].startMs) raw[i].startMs = raw[i - 1].startMs + 1;
      }
      rec.rawSegments = raw;
      rec.sourceLang = track.lang || 'en';
      SK.sendLog('info', 'x', 'subtitle fetched', { mediaId, name: track.name, lang: track.lang, segments: raw.length });
      if (!raw.length) { rec.status = 'none'; return; }
      rec.batches = [];
      for (let i = 0; i < raw.length; i += BATCH_SIZE) rec.batches.push(raw.slice(i, i + BATCH_SIZE));
      rec.batchState = SK.ASR.createBatchState(rec.batches.length);
      rec.entries = [];
      rec.runId++;
      rec.status = 'ready';
      SK.sendLog('info', 'x', 'transcript ready — translating on demand', {
        mediaId, totalSegments: raw.length, totalBatches: rec.batches.length, engine: XV.engine, sourceLang: rec.sourceLang,
      });
      await _pump(mediaId, rec);
    } catch (e) {
      // 抓字幕階段失敗才回 idle（下次有聲播放重抓）；字幕已就緒後的錯誤留在 ready 由批次重試處理
      if (rec.status === 'loading') rec.status = 'idle';
      rec.running = false;
      SK.sendLog('warn', 'x', 'subtitle pipeline failed', { mediaId, error: e?.message || String(e) });
    }
  }
  SK._xStartForVideo = startForVideo;
  SK._xSetAutoTranslate = (enabled) => { const changed = _setAutoTranslate(enabled); if (changed) _renderAll(); return changed; };
  SK._xSetEngine = (v) => { XV.engine = SK._driveNormalizeEngine ? SK._driveNormalizeEngine(v) : 'gemini'; };

  // 同頁另一份較高版 Shinkansen 勝出時讓位（content-ns.js _instanceStandDown 呼叫）
  SK.stopXSubtitles = function stopXSubtitles() {
    // 讓位是這個 instance 在本頁的終局：之後設定變更 / 選單開關都不可再把它翻回啟用
    //（原本 onChanged 一來就重開，兩份又同時翻、各掛一條譯文軌）
    XV.stoodDown = true;
    XV.autoTranslate = false;
    _renderAll();
  };

  // ─── Runtime gate ───────────────────────────────────
  if (!/(^|\.)(x|twitter)\.com$/.test(location.hostname)) return;
  if (window.top !== window) return;

  function _recordMaster(name) {
    const id = mediaIdFromMasterUrl(name);
    if (id && !XV.masterUrls.has(id)) XV.masterUrls.set(id, name);
  }
  // buffered:true 補抓 content script 注入前已載入的；之後的請求即使 resource timing buffer
  // 滿了（X 請求很多，預設 250 筆）observer 仍收得到
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) _recordMaster(e.name);
    }).observe({ type: 'resource', buffered: true });
  } catch (_) {
    for (const e of performance.getEntriesByType('resource')) _recordMaster(e.name);
  }

  async function _waitMasterUrl(mediaId) {
    for (let i = 0; i < 10; i++) {
      const url = XV.masterUrls.get(mediaId);
      if (url) return url;
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }

  // 有聲播放判定：播放中 + 非靜音 + 音量 > 0
  async function _maybeStart(video) {
    if (!XV.autoTranslate) return;
    if (video.paused || video.muted || video.volume === 0) return;
    const mediaId = mediaIdFromPoster(video.getAttribute('poster'));
    if (!mediaId) return;
    _bindVideoMedia(video, mediaId);
    const rec = XV.media.get(mediaId);
    if (rec && rec.videos.has(video) && rec.status !== 'idle') {
      if (rec.status === 'ready') _pump(mediaId, rec);   // 繼續播 / 取消靜音 → 接著翻
      return;
    }
    if (!SK.isInstanceLeader()) return;
    const masterUrl = await _waitMasterUrl(mediaId);
    if (!masterUrl) {
      SK.sendLog('warn', 'x', 'master playlist not observed for video', { mediaId });
      return;
    }
    startForVideo(video, mediaId, masterUrl);
  }

  // media 事件不冒泡，capture 階段在 document 收全頁所有 <video>
  for (const ev of ['play', 'playing', 'volumechange']) {
    document.addEventListener(ev, (e) => {
      if (e.target instanceof HTMLVideoElement) _maybeStart(e.target);
    }, true);
  }
  // 播放推進 / 拖動時間軸：只對「字幕已就緒、還有批次沒翻」的影片接著派批。
  // 不走 _maybeStart——timeupdate 每秒約 4 次，沒對到 master playlist 的影片不該反覆等待重試
  for (const ev of ['timeupdate', 'seeked']) {
    document.addEventListener(ev, (e) => {
      const video = e.target;
      if (!(video instanceof HTMLVideoElement) || !_isAudible(video)) return;
      const mediaId = mediaIdFromPoster(video.getAttribute('poster'));
      const rec = mediaId && XV.media.get(mediaId);
      if (rec && rec.status === 'ready' && !rec.running && rec.videos.has(video)) _pump(mediaId, rec);
    }, true);
  }

  (async () => {
    try {
      const { ytSubtitle = {}, displayMode } = await browser.storage.sync.get(['ytSubtitle', 'displayMode']);
      XV.autoTranslate = !XV.stoodDown && ytSubtitle.autoTranslate !== false;
      SK._xSetEngine(ytSubtitle.engine);
      XV.model = ytSubtitle.model || '';
      XV.bilingualMode = displayMode === 'dual';
    } catch { /* 維持預設 */ }
  })();

  // 使用者改了設定（換引擎 / 模型 / 重開開關）：失敗批次的嘗試次數歸零，下次播放重新試
  function _resetFailedBatches() {
    for (const rec of XV.media.values()) {
      if (rec.batchState) SK.ASR.reviveFailedBatches(rec.batchState, { resetAttempts: true });
    }
  }

  // 本分頁的字幕翻譯開關。兩個來源共用：設定頁改全域 ytSubtitle.autoTranslate（onChanged）、
  // 工具列圖示選單的開關（SET_TAB_SUBTITLE，只影響本分頁、不寫 storage）。回傳是否有變動
  function _setAutoTranslate(enabled) {
    if (enabled && XV.stoodDown) return false;
    if (enabled === XV.autoTranslate) return false;
    XV.autoTranslate = enabled;
    if (enabled) {
      _resetFailedBatches();
      // 使用者明確重開：已有譯文軌的影片恢復顯示
      document.querySelectorAll('video').forEach(v => {
        if (v._skXTrack) v._skXTrack.mode = 'showing';
        _maybeStart(v);
      });
    }
    return true;
  }

  // 工具列圖示選單 ↔ 本分頁（與 YouTube 的 SET_SUBTITLE 同語意：只影響當前分頁，
  // 不改全域設定）。GET 讓選單顯示本分頁實際狀態而非全域設定值。
  // 訊息型別與 content-drive.js 共用（兩站不會同頁，各自 host gate 後才註冊）
  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'GET_TAB_SUBTITLE') {
      sendResponse({ enabled: XV.autoTranslate });
      return;
    }
    if (msg?.type === 'SET_TAB_SUBTITLE') {
      sendResponse({ enabled: SK._xSetTabSubtitle(msg.payload?.enabled) });
    }
  });

  // 本分頁開關的單一入口：工具列圖示選單（SET_TAB_SUBTITLE）與 Debug Bridge（X_SET_SUBTITLE，
  // dev tail 才開）共用。只改本分頁狀態、不寫 storage
  SK._xSetTabSubtitle = (enabled) => {
    if (_setAutoTranslate(!!enabled)) _renderAll();
    return XV.autoTranslate;
  };

  // Debug Bridge GET_X_DEBUG 用：本分頁 X 影片字幕的狀態快照（唯讀）
  SK._xDebugState = () => ({
    autoTranslate: XV.autoTranslate,
    stoodDown: !!XV.stoodDown,
    bilingualMode: XV.bilingualMode,
    engine: XV.engine,
    media: [...XV.media.entries()].map(([id, rec]) => ({
      id,
      status: rec.status,
      sourceLang: rec.sourceLang || null,
      rawCount: rec.rawSegments ? rec.rawSegments.length : 0,
      entryCount: rec.entries ? rec.entries.length : 0,
      videoCount: rec.videos ? rec.videos.size : 0,
      running: !!rec.running,
    })),
    videos: [...document.querySelectorAll('video')].map((v) => ({
      mediaId: mediaIdFromPoster(v.getAttribute('poster')),
      paused: v.paused,
      currentTime: Math.round(v.currentTime),
      tracks: [...v.textTracks].map((t) => ({
        label: t.label, language: t.language, kind: t.kind, mode: t.mode,
        cues: t.cues ? t.cues.length : null,
        ours: t === v._skXTrack,
        firstCue: t.cues && t.cues.length ? String(t.cues[0].text || '').slice(0, 60) : null,
      })),
    })),
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    let rerender = false;
    if (changes.ytSubtitle) {
      const v = changes.ytSubtitle.newValue || {};
      if (_setAutoTranslate(v.autoTranslate !== false)) rerender = true;
      SK._xSetEngine(v.engine);
      XV.model = v.model || '';
      _resetFailedBatches();
    }
    if (changes.displayMode) {
      const bi = changes.displayMode.newValue === 'dual';
      if (bi !== XV.bilingualMode) { XV.bilingualMode = bi; rerender = true; }
    }
    if (rerender) _renderAll();
  });

  SK.sendLog('info', 'x', 'content-x.js ready', { href: location.href.slice(0, 200) });

})(window.__SK);
