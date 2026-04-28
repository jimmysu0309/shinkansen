// content.js — Shinkansen Content Script 主模組
// 職責：Debug Bridge、translatePage、restorePage、translateUnits、
// 編輯模式、訊息處理、Debug API、初始化。
// 注意：content script 不支援 ES module import。
// v1.1.9: 拆分為 7 個檔案，本檔為主協調層，依賴 content-ns/toast/detect/serialize/inject/spa。

(function(SK) {
  if (!SK || SK.disabled) return;  // v1.5.2: iframe gate（見 content-ns.js）

  const STATE = SK.STATE;

  // ─── v0.88: Debug Bridge ──────────────────────────────
  window.addEventListener('shinkansen-debug-request', (e) => {
    const { action, afterSeq } = (e.detail || {});
    const respond = (detail) => {
      window.dispatchEvent(new CustomEvent('shinkansen-debug-response', { detail }));
    };

    // v1.5.4: 全部走 Promise 風格——Chrome 88+ 跟 Firefox 全版本都支援，
    // 而 callback 風格 Firefox 不認；此前混用會在 Firefox 直接壞。
    // Chrome 端兩種寫法走同一條 native code path，效能 0 影響。
    const forwardToBackground = (type, extraPayload) => {
      const msg = extraPayload === undefined ? { type } : { type, payload: extraPayload };
      browser.runtime.sendMessage(msg)
        .then((res) => respond(res || { ok: true }))
        .catch((err) => respond({ ok: false, error: err?.message || String(err) }));
    };

    if (action === 'GET_LOGS') {
      forwardToBackground('GET_LOGS', { afterSeq: afterSeq || 0 });
    } else if (action === 'CLEAR_LOGS') {
      forwardToBackground('CLEAR_LOGS');
    } else if (action === 'CLEAR_CACHE') {
      forwardToBackground('CLEAR_CACHE');
    } else if (action === 'TRANSLATE') {
      respond({ ok: true, triggered: true });
      SK.translatePage();
    } else if (action === 'RESTORE') {
      if (STATE.translated) {
        restorePage();
        respond({ ok: true, restored: true });
      } else {
        respond({ ok: false, error: 'not translated' });
      }
    } else if (action === 'CLEAR_RPD') {
      forwardToBackground('CLEAR_RPD');
    } else if (action === 'GET_PERSISTED_LOGS') {
      // v1.2.52: 讀取跨 service worker 重啟仍保留的持久化 log
      forwardToBackground('GET_PERSISTED_LOGS');
    } else if (action === 'CLEAR_PERSISTED_LOGS') {
      // v1.2.52: 清除持久化 log（測試前呼叫，避免舊資料干擾）
      forwardToBackground('CLEAR_PERSISTED_LOGS');
    } else if (action === 'GET_STATE') {
      respond({
        ok: true,
        translated: STATE.translated,
        translating: STATE.translating,
        segmentCount: STATE.originalHTML.size,
      });
    } else if (action === 'GET_YT_DEBUG') {
      // 暴露 YT 字幕翻譯的內部狀態，供除錯比對用
      const YT = SK.YT;
      if (!YT) { respond({ ok: false, error: 'SK.YT not available' }); return; }
      const rawNorms    = YT.rawSegments.map(s => s.normText);
      const rawTexts    = YT.rawSegments.map(s => s.text);
      const rawStartMs  = YT.rawSegments.map(s => s.startMs);
      const rawGroupIds = YT.rawSegments.map(s => s.groupId);
      const mapKeys     = Array.from(YT.captionMap.keys());
      const rawSet      = new Set(rawNorms);
      const onTheFlyKeys = mapKeys.filter(k => !rawSet.has(k));
      respond({
        ok: true,
        active:           YT.active,
        translating:      YT.translating,
        rawCount:         YT.rawSegments.length,
        rawNormTexts:     rawNorms,
        rawTexts:         rawTexts,
        rawStartMs:       rawStartMs,
        rawGroupIds:      rawGroupIds,
        captionMapSize:   YT.captionMap.size,
        captionMapKeys:   mapKeys,
        onTheFlyKeys:     onTheFlyKeys,
        translatedUpToMs: YT.translatedUpToMs,
        ytConfig:         YT.config,
      });
    } else {
      respond({ ok: false, error: 'unknown action: ' + action });
    }
  });

  // ─── 延遲 Rescan 機制 ────────────────────────────────

  let rescanAttempts = 0;
  let rescanTimer = null;

  SK.cancelRescan = function cancelRescan() {
    if (rescanTimer) {
      clearTimeout(rescanTimer);
      rescanTimer = null;
    }
    rescanAttempts = 0;
  };

  function scheduleRescanForLateContent() {
    SK.cancelRescan();
    rescanTimer = setTimeout(rescanTick, SK.RESCAN_DELAYS_MS[0]);
  }

  async function rescanTick() {
    rescanTimer = null;
    if (!STATE.translated) return;
    // v1.8.5: 「只翻文章開頭」啟用時,延遲 rescan 不掃新段落 — 使用者明確只想要文章開頭。
    if (STATE.partialModeActive) {
      SK.sendLog('info', 'translate', 'partialMode: skip rescan');
      return;
    }
    const newUnits = SK.collectParagraphs();
    if (newUnits.length > 0) {
      try {
        const { done, failures } = await SK.translateUnits(newUnits);
        if (!STATE.translated) return;
        if (done > 0) {
          SK.sendLog('info', 'translate', 'rescan caught new units', { done, failures: failures.length, attempt: rescanAttempts + 1 });
        }
      } catch (err) {
        SK.sendLog('warn', 'translate', 'rescan failed', { error: err.message });
      }
    }
    rescanAttempts += 1;
    if (rescanAttempts < SK.RESCAN_DELAYS_MS.length) {
      rescanTimer = setTimeout(rescanTick, SK.RESCAN_DELAYS_MS[rescanAttempts]);
    }
  }

  // ─── 並行執行器 ──────────────────────────────────────

  // 每批 API 呼叫逾時門檻：超過此時間視為逾時，以 error 記錄並繼續下一批。
  // 防止 Gemini API 無回應時整頁翻譯永久卡住。
  const BATCH_TIMEOUT_MS = 90_000;

  // v1.6.19: 把 Promise.race 包成 helper,sendMessage 先 settle 時 clearTimeout
  // 釋放 timer。舊版每個 batch 都留一個 90s timer 直到 fire(雖然 race 已 settle
  // 後 reject 被忽略,但 timer 物件 + Error 物件占住到 fire 才 GC,長頁面 50+
  // batch 累積成 timer leak)。
  function sendMessageWithTimeout(message, timeoutMs) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`批次逾時（${timeoutMs / 1000}s）`)),
        timeoutMs,
      );
    });
    return Promise.race([browser.runtime.sendMessage(message), timeoutPromise])
      .finally(() => clearTimeout(timer));
  }

  async function runWithConcurrency(jobs, maxConcurrent, workerFn) {
    const n = Math.min(maxConcurrent, jobs.length);
    if (n === 0) return;
    let cursor = 0;
    const workers = [];
    for (let w = 0; w < n; w++) {
      workers.push((async () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (STATE.abortController?.signal.aborted) return;
          const idx = cursor++;
          if (idx >= jobs.length) return;
          await workerFn(jobs[idx]);
        }
      })());
    }
    await Promise.all(workers);
  }

  // ─── Greedy 打包 ─────────────────────────────────────

  // v1.7.2: 加入 firstMaxUnits / firstMaxChars 讓 batch 0 用較小的 limit。
  // batch 0 序列等 Gemini,token 少回送快;batch 1+ 並行不吃序列延遲,維持原 limit 衝吞吐。
  // 兩個新參數預設 null = 走舊行為(全部 batch 用同 limit),向下相容 translateUnitsGoogle / 字幕路徑。
  function packBatches(texts, units, slotsList, maxUnits, maxChars, firstMaxUnits = null, firstMaxChars = null) {
    const jobs = [];
    let cur = null;
    const flush = () => {
      if (cur && cur.texts.length > 0) jobs.push(cur);
      cur = null;
    };
    // 「正在切第一批」= jobs 還沒 push 任何 batch + (firstMaxUnits / firstMaxChars 有值)
    const limU = () => (jobs.length === 0 && firstMaxUnits != null) ? firstMaxUnits : maxUnits;
    const limC = () => (jobs.length === 0 && firstMaxChars != null) ? firstMaxChars : maxChars;
    for (let i = 0; i < texts.length; i++) {
      const len = (texts[i] || '').length;
      if (len > limC()) {
        flush();
        jobs.push({
          start: i,
          texts: [texts[i]],
          units: [units[i]],
          slots: [slotsList[i]],
          chars: len,
          oversized: true,
        });
        continue;
      }
      if (cur && (cur.chars + len > limC() || cur.texts.length >= limU())) {
        flush();
      }
      if (!cur) cur = { start: i, texts: [], units: [], slots: [], chars: 0 };
      cur.texts.push(texts[i]);
      cur.units.push(units[i]);
      cur.slots.push(slotsList[i]);
      cur.chars += len;
    }
    flush();
    return jobs;
  }

  // ─── translateUnits ──────────────────────────────────

  SK.translateUnits = async function translateUnits(units, { onProgress, glossary, signal, modelOverride, engine, ignorePartialMode } = {}) {
    const total = units.length;
    const tu_entry = Date.now();
    const serialized = units.map(unit => {
      if (unit.kind === 'fragment') {
        return SK.serializeFragmentWithPlaceholders(unit);
      }
      const el = unit.el;
      // v1.2.4: 移除 containsMedia 強制 slots:[] 的早返回。
      // 含媒體元素（如 <img> emoji + <a> 連結）的段落應正常序列化 slots，
      // 讓 LLM 能保留 <a> 佔位符，injection path B 的 fragment 注入已支援此情境。
      if (!SK.hasPreservableInline(el)) {
        return { text: el.innerText.trim(), slots: [] };
      }
      return SK.serializeWithPlaceholders(el);
    });
    const texts = serialized.map(s => s.text);
    const slotsList = serialized.map(s => s.slots);
    SK.sendLog('info', 'translate', 'milestone:tu_serialize_done', { t: Date.now() - tu_entry, units: total });

    // v1.1.9: 合併讀取設定（減少 browser.storage.sync.get 呼叫次數）
    let maxConcurrent = SK.DEFAULT_MAX_CONCURRENT;
    let maxUnitsPerBatch = SK.DEFAULT_UNITS_PER_BATCH;
    let maxCharsPerBatch = SK.DEFAULT_CHARS_PER_BATCH;
    // v1.8.3: partialMode(只翻文章開頭,節省費用)
    let partialMode = { enabled: false, maxUnits: 25 };
    try {
      const batchCfg = await browser.storage.sync.get(['maxConcurrentBatches', 'maxUnitsPerBatch', 'maxCharsPerBatch', 'partialMode']);
      if (Number.isFinite(batchCfg.maxConcurrentBatches) && batchCfg.maxConcurrentBatches > 0) {
        maxConcurrent = batchCfg.maxConcurrentBatches;
      }
      if (Number.isFinite(batchCfg.maxUnitsPerBatch) && batchCfg.maxUnitsPerBatch >= 1) {
        maxUnitsPerBatch = batchCfg.maxUnitsPerBatch;
      }
      if (Number.isFinite(batchCfg.maxCharsPerBatch) && batchCfg.maxCharsPerBatch >= 500) {
        maxCharsPerBatch = batchCfg.maxCharsPerBatch;
      }
      if (batchCfg.partialMode && typeof batchCfg.partialMode === 'object') {
        if (typeof batchCfg.partialMode.enabled === 'boolean') partialMode.enabled = batchCfg.partialMode.enabled;
        if (Number.isFinite(batchCfg.partialMode.maxUnits) && batchCfg.partialMode.maxUnits >= 5 && batchCfg.partialMode.maxUnits <= 50) {
          partialMode.maxUnits = batchCfg.partialMode.maxUnits;
        }
      }
    } catch (_) { /* 保持 default */ }
    SK.sendLog('info', 'translate', 'milestone:tu_storage_loaded', { t: Date.now() - tu_entry, partialMode });

    let done = 0;
    const pageUsage = {
      inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUSD: 0,
      billedInputTokens: 0, billedCostUSD: 0,
      cacheHits: 0,
    };
    // v1.8.3: partialMode 啟用時,第一批 limit 用使用者設定的 maxUnits;chars 仍用 BATCH0_CHARS 內部限制
    // v1.8.8: ignorePartialMode 路徑(「翻譯剩餘段落」按鈕)走全頁翻譯,batch 0 用標準 BATCH0_UNITS
    const partialModeActive = partialMode.enabled && !ignorePartialMode;
    const firstBatchUnits = partialModeActive ? partialMode.maxUnits : SK.BATCH0_UNITS;
    const jobs = packBatches(texts, units, slotsList, maxUnitsPerBatch, maxCharsPerBatch, firstBatchUnits, SK.BATCH0_CHARS);
    SK.sendLog('info', 'translate', 'milestone:tu_packed', { t: Date.now() - tu_entry, batches: jobs.length });
    // v1.8.8 instrumentation: packBatches 詳情(每批 unit 數 / chars)
    SK.sendLog('info', 'translate', 'packBatches detail', {
      totalBatches: jobs.length,
      batchSizes: jobs.map((j, i) => ({ idx: i, units: j.texts.length, chars: j.chars })),
      partialMode,
      firstBatchUnits,
    });
    const failures = [];
    let rpdWarning = false;
    let hadAnyMismatch = false;

    const t0All = Date.now();
    SK.sendLog('info', 'translate', 'translateUnits start', { batches: jobs.length, total, maxConcurrent });

    const runBatch = async (job) => {
      if (signal?.aborted) return;
      const batchIdx = jobs.indexOf(job);
      const t0 = Date.now();
      SK.sendLog('info', 'translate', `batch ${batchIdx + 1}/${jobs.length} start`, { units: job.texts.length, chars: job.chars });
      try {
        // v1.5.7: engine='openai-compat' 時走 TRANSLATE_BATCH_CUSTOM 走 lib/openai-compat.js；
        // 預設 'gemini' 維持既有 TRANSLATE_BATCH 行為。
        const messageType = engine === 'openai-compat' ? 'TRANSLATE_BATCH_CUSTOM' : 'TRANSLATE_BATCH';
        const response = await sendMessageWithTimeout({
          type: messageType,
          // v1.4.12: modelOverride 來自 preset 快速鍵，覆蓋全域 geminiConfig.model（僅 Gemini 路徑生效，
          // OpenAI-compat 路徑以 customProvider 整組為準）
          payload: { texts: job.texts, glossary: glossary || null, modelOverride: modelOverride || null },
        }, BATCH_TIMEOUT_MS);
        const elapsed = Date.now() - t0;
        const cacheHit = response?.usage?.cacheHits || 0;
        const apiCalls = job.texts.length - cacheHit;
        SK.sendLog('info', 'translate', `batch ${batchIdx + 1}/${jobs.length} done`, { elapsed, cacheHits: cacheHit, apiCalls });
        if (!response?.ok) throw new Error(response?.error || '未知錯誤');
        const translations = response.result;
        if (response.usage) {
          pageUsage.inputTokens += response.usage.inputTokens || 0;
          pageUsage.outputTokens += response.usage.outputTokens || 0;
          pageUsage.cachedTokens += response.usage.cachedTokens || 0;
          pageUsage.costUSD += response.usage.costUSD || 0;
          pageUsage.billedInputTokens += response.usage.billedInputTokens || 0;
          pageUsage.billedCostUSD += response.usage.billedCostUSD || 0;
          pageUsage.cacheHits += response.usage.cacheHits || 0;
        }
        if (response.rpdExceeded) rpdWarning = true;
        if (response.hadMismatch) hadAnyMismatch = true;
        // v1.8.10 A:strip LLM 偷懶殘留的 SEP / «N» 標記
        translations.forEach((tr, j) => SK.injectTranslation(job.units[j], SK.sanitizeMarkers(tr), job.slots[j]));
        done += job.texts.length;
        if (onProgress) onProgress(done, total, hadAnyMismatch);
      } catch (err) {
        const elapsed = Date.now() - t0;
        SK.sendLog('error', 'translate', `batch ${batchIdx + 1}/${jobs.length} FAILED`, { elapsed, start: job.start, error: err.message });
        failures.push({ start: job.start, count: job.texts.length, error: err.message });
      }
    };

    // v1.8.0: Streaming 版 batch 0。透過 STREAMING_* onMessage listener 收 SW 推來的
    // first_chunk / segment / done / error / aborted 訊息。回傳兩個 promise 讓主流程協調:
    //   firstChunkPromise:第一個 SSE chunk 抵達時 resolve(主流程在此時同步 dispatch batch 1+)
    //   donePromise:streaming 完整結束(成功/失敗/abort)時 resolve/reject
    // 1.5 秒沒收到 first_chunk 視為 streaming 失敗,呼叫端 fallback 走 non-streaming runBatch。
    const FIRST_CHUNK_TIMEOUT_MS = 1500;
    const runBatch0Streaming = (job) => {
      const streamId = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const t0 = Date.now();
      SK.sendLog('info', 'translate', `batch 1/${jobs.length} stream start`, { streamId, units: job.texts.length, chars: job.chars });

      let firstChunkResolve, doneResolve, doneReject;
      const firstChunkPromise = new Promise((r) => { firstChunkResolve = r; });
      const donePromise = new Promise((res, rej) => { doneResolve = res; doneReject = rej; });

      // v1.8.0 instrumentation:第一個 segment inject 時間(對應使用者首字延遲)
      let firstSegmentInjectedT = null;

      // v1.8.0: abort 傳播 — 使用者按 Option+S 取消 → 通知 SW 中斷 streaming + 清理 listener
      const abortHandler = () => {
        SK.sendLog('info', 'translate', `batch 1/${jobs.length} stream abort triggered`, { streamId });
        browser.runtime.sendMessage({ type: 'STREAMING_ABORT', payload: { streamId } }).catch(() => {});
        // 解開 main 流程的 await(SW 端會回傳 STREAMING_ABORTED 但本地 listener 已移除,
        // 為防卡死直接在這裡 resolve)
        try { browser.runtime.onMessage.removeListener(onMessage); } catch (_) {}
        firstChunkResolve(false);
        doneResolve({ ok: false, aborted: true });
      };
      if (signal) {
        if (signal.aborted) {
          // 進入 streaming 之前就已 aborted,直接走 abort path
          abortHandler();
        } else {
          signal.addEventListener('abort', abortHandler, { once: true });
        }
      }

      const onMessage = (message) => {
        if (!message || message.payload?.streamId !== streamId) return;
        if (message.type === 'STREAMING_FIRST_CHUNK') {
          firstChunkResolve(true);
        } else if (message.type === 'STREAMING_SEGMENT') {
          const idx = message.payload.segmentIdx;
          // v1.8.10 A:strip LLM 偷懶殘留的 SEP / «N» 標記
          const tr = SK.sanitizeMarkers(message.payload.translation);
          if (typeof idx === 'number' && idx >= 0 && idx < job.texts.length && tr) {
            try {
              SK.injectTranslation(job.units[idx], tr, job.slots[idx]);
              done += 1;
              if (onProgress) onProgress(done, total, hadAnyMismatch);
              if (firstSegmentInjectedT === null) {
                firstSegmentInjectedT = Date.now() - t0;
                SK.sendLog('info', 'translate', `batch 1/${jobs.length} stream first segment injected`, { streamId, idx, t: firstSegmentInjectedT });
              }
            } catch (injectErr) {
              SK.sendLog('warn', 'translate', 'streaming inject failed', { idx, error: injectErr.message });
            }
          }
        } else if (message.type === 'STREAMING_DONE') {
          const elapsed = Date.now() - t0;
          const usage = message.payload.usage || {};
          // v1.8.10 B:hadMismatch=true(LLM 偷懶把 N 段合併成 1 段)時 reject,
          // 觸發既有 mid-failure catch 重翻 batch 0 走 non-streaming(整批 resolve 後一次 split)。
          // segment 0 可能已被 streaming 注入合併譯文(A 已 sanitize),retry 會用乾淨版本覆蓋。
          // v1.8.10 B:hadMismatch=true(LLM 偷懶把 N 段合併成 1 段)時 reject,
          // 觸發既有 mid-failure catch 重翻 batch 0 走 non-streaming(整批 resolve 後一次 split)。
          // segment 0 可能已被 streaming 注入合併譯文(A 已 sanitize),retry 會用乾淨版本覆蓋。
          if (message.payload.hadMismatch) {
            SK.sendLog('warn', 'translate', `batch 1/${jobs.length} stream DONE with hadMismatch, triggering retry`, { elapsed, totalSegments: message.payload.totalSegments });
            browser.runtime.onMessage.removeListener(onMessage);
            firstChunkResolve(true);
            doneReject(new Error('streaming hadMismatch'));
            return;
          }
          pageUsage.inputTokens += usage.inputTokens || 0;
          pageUsage.outputTokens += usage.outputTokens || 0;
          pageUsage.cachedTokens += usage.cachedTokens || 0;
          pageUsage.billedInputTokens += usage.billedInputTokens || 0;
          pageUsage.billedCostUSD += usage.billedCostUSD || 0;
          SK.sendLog('info', 'translate', `batch 1/${jobs.length} stream done`, { elapsed, totalSegments: message.payload.totalSegments, hadMismatch: false });
          browser.runtime.onMessage.removeListener(onMessage);
          firstChunkResolve(true);  // 防 first_chunk 漏訊息卡死主流程
          doneResolve({ ok: true });
        } else if (message.type === 'STREAMING_ERROR') {
          const elapsed = Date.now() - t0;
          SK.sendLog('error', 'translate', `batch 1/${jobs.length} stream FAILED`, { elapsed, error: message.payload.error });
          browser.runtime.onMessage.removeListener(onMessage);
          firstChunkResolve(false);
          doneReject(new Error(message.payload.error || 'streaming failed'));
        } else if (message.type === 'STREAMING_ABORTED') {
          SK.sendLog('info', 'translate', `batch 1/${jobs.length} stream aborted`, { streamId });
          browser.runtime.onMessage.removeListener(onMessage);
          firstChunkResolve(false);
          doneResolve({ ok: false, aborted: true });
        }
      };
      browser.runtime.onMessage.addListener(onMessage);

      // 觸發 streaming(SW 內 fire-and-forget,sendMessage 立刻 resolve)
      browser.runtime.sendMessage({
        type: 'TRANSLATE_BATCH_STREAM',
        payload: { texts: job.texts, glossary: glossary || null, modelOverride: modelOverride || null, streamId },
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

      // first_chunk 1.5 秒 timeout fallback
      const firstChunkOrTimeout = Promise.race([
        firstChunkPromise.then((v) => ({ kind: v ? 'first_chunk' : 'failed' })),
        new Promise((r) => setTimeout(() => r({ kind: 'timeout' }), FIRST_CHUNK_TIMEOUT_MS)),
      ]);

      return { firstChunkOrTimeout, donePromise, streamId, cleanup: () => { try { browser.runtime.onMessage.removeListener(onMessage); } catch (_) {} } };
    };

    // v1.8.0: streaming 適用範圍——僅 Gemini 文章翻譯路徑。OpenAI-compat / 其他 engine 仍走 v1.7.x 序列 batch 0 路徑。
    const useStreaming = engine !== 'openai-compat';

    if (jobs.length > 0) {
      let batch0NeedsFallback = false;
      // v1.8.3: partialMode 啟用時,只跑 batch 0,不 dispatch jobs.slice(1)
      // v1.8.8: ignorePartialMode 路徑(「翻譯剩餘段落」按鈕)要翻完所有 batch
      const skipBatch1Plus = partialModeActive;
      SK.sendLog('info', 'translate', 'main flow start', {
        useStreaming, skipBatch1Plus, jobsCount: jobs.length, t: Date.now() - tu_entry,
      });
      if (skipBatch1Plus && jobs.length > 1) {
        SK.sendLog('info', 'translate', 'partialMode: skip batch 1+', { totalBatches: jobs.length, skipped: jobs.length - 1, batch0Units: jobs[0].texts.length });
      }

      if (useStreaming) {
        const stream = runBatch0Streaming(jobs[0]);
        const r = await stream.firstChunkOrTimeout;
        SK.sendLog('info', 'translate', 'stream firstChunkOrTimeout result', { kind: r.kind, t: Date.now() - tu_entry });
        if (r.kind === 'first_chunk') {
          // streaming 已開始流入 — 同步 dispatch batch 1+ 並行(partialMode 啟用時跳過)
          const willParallel = jobs.length > 1 && !signal?.aborted && !skipBatch1Plus;
          SK.sendLog('info', 'translate', 'parallel batches dispatch decision', { willParallel, count: willParallel ? jobs.length - 1 : 0 });
          const parallelP = willParallel
            ? runWithConcurrency(jobs.slice(1), maxConcurrent, runBatch)
            : Promise.resolve();
          try {
            await stream.donePromise;
            SK.sendLog('info', 'translate', 'after await stream.donePromise', { t: Date.now() - tu_entry });
          } catch (streamErr) {
            // streaming 中途失敗 — fallback 對 batch 0 重送 non-streaming
            SK.sendLog('warn', 'translate', 'streaming mid-failure, retrying batch 0 non-streaming', { error: streamErr.message });
            await runBatch(jobs[0]);
          }
          await parallelP;
          SK.sendLog('info', 'translate', 'after await parallelP', { t: Date.now() - tu_entry, doneSoFar: done });
        } else {
          // first_chunk 1.5s 沒到(timeout 或 STREAMING_ERROR 在 first_chunk 前發生)
          // → 中斷 streaming,fallback 走 v1.7.x 序列 batch 0 + 並行 batch 1+
          stream.cleanup();
          if (r.kind === 'timeout') {
            SK.sendLog('warn', 'translate', 'streaming first_chunk timeout, falling back to non-streaming', { streamId: stream.streamId });
            browser.runtime.sendMessage({ type: 'STREAMING_ABORT', payload: { streamId: stream.streamId } }).catch(() => {});
          }
          batch0NeedsFallback = true;
        }
      } else {
        batch0NeedsFallback = true;
      }

      if (batch0NeedsFallback) {
        // v1.7.1 行為:序列跑 batch 0 → 並行 batch 1+(partialMode 啟用時跳過 batch 1+)
        await runBatch(jobs[0]);
        if (jobs.length > 1 && !signal?.aborted && !skipBatch1Plus) {
          await runWithConcurrency(jobs.slice(1), maxConcurrent, runBatch);
        }
      }
    }

    SK.sendLog('info', 'translate', 'translateUnits complete', { elapsed: Date.now() - t0All, done, total, failures: failures.length });

    return { done, total, failures, pageUsage, rpdWarning };
  };

  // ─── Google Docs 偵測 ────────────────────────────────

  function isGoogleDocsEditorPage() {
    return location.hostname === 'docs.google.com'
      && /^\/document\/d\/[^/]+\/(edit|preview|view)/.test(location.pathname);
  }

  function isGoogleDocsMobileBasic() {
    return location.hostname === 'docs.google.com'
      && /^\/document\/d\/[^/]+\/mobilebasic/.test(location.pathname);
  }

  function getGoogleDocsMobileBasicUrl() {
    const match = location.pathname.match(/^\/document\/d\/([^/]+)/);
    if (!match) return null;
    return `https://docs.google.com/document/d/${match[1]}/mobilebasic`;
  }

  // ─── translatePage ───────────────────────────────────

  SK.translatePage = async function translatePage(options = {}) {
    // v1.2.12: YouTube 頁面的 Option+S 翻譯頁面內容（說明、留言等），
    // 字幕翻譯改由 popup toggle 或 autoTranslate 設定控制，與快捷鍵無關。
    // v1.4.12: options.modelOverride / options.slot 由 preset 快速鍵注入，
    // modelOverride 覆蓋 geminiConfig.model，slot 用於 STICKY_SET。
    // v1.4.13: options.label 由 preset 傳入，在 loading toast 顯示讓使用者知道目前哪個 preset 在跑。
    const labelPrefix = options.label ? `[${options.label}] ` : '';

    // v1.8.8 instrumentation: 入口 STATE 狀態
    SK.sendLog('info', 'translate', 'translatePage entry', {
      ignorePartialMode: !!options.ignorePartialMode,
      stateTranslated: STATE.translated,
      statePartialModeActive: STATE.partialModeActive,
      alreadyMarkedCount: document.querySelectorAll('[data-shinkansen-translated]').length,
    });
    // v1.8.7: options.ignorePartialMode = true 從「翻譯剩餘段落」按鈕觸發,
    // 不走 restorePage 早退,直接重翻整頁(前面已翻好的段落會從 cache fast path 命中)
    if (STATE.translated && !options.ignorePartialMode) {
      restorePage();
      return;
    }
    // ignorePartialMode 路徑:STATE.translated=true 進來時,先靜默重置 translated state
    // 讓後續流程能跑完整翻譯(否則 STATE.translated=true 會讓 translateUnits 內 inject 邏輯異常)
    if (STATE.translated && options.ignorePartialMode) {
      SK.sendLog('info', 'translate', 'ignorePartialMode: re-translate without restorePage', { previousPartialMode: STATE.partialModeActive });
      // 不 clear DOM,只重置 translated flag — 已注入的譯文保留,後續 cache fast path 會原樣覆蓋(冪等)
      STATE.translated = false;
    }

    if (isGoogleDocsEditorPage()) {
      const mobileUrl = getGoogleDocsMobileBasicUrl();
      if (mobileUrl) {
        SK.sendLog('info', 'translate', 'Google Docs detected, redirecting to mobilebasic', { mobileUrl });
        SK.showToast('loading', '偵測到 Google Docs，正在開啟可翻譯的閱讀版⋯');
        browser.runtime.sendMessage({
          type: 'OPEN_GDOC_MOBILE',
          payload: { url: mobileUrl },
        }).catch(() => {});
        return;
      }
    }

    if (STATE.translating) {
      SK.sendLog('info', 'translate', 'aborting in-progress translation');
      STATE.abortController?.abort();
      SK.showToast('loading', '正在取消翻譯⋯');
      return;
    }

    if (!navigator.onLine) {
      SK.showToast('error', '目前處於離線狀態，無法翻譯。請確認網路連線後再試', { autoHideMs: 5000 });
      return;
    }

    // v1.7.x instrumentation: 用 entryTime 量化 translatePage 各階段相對時間
    const entryTime = Date.now();

    // v1.1.9: 合併所有設定讀取為單一 browser.storage.sync.get(null)
    let settings = {};
    try {
      settings = await browser.storage.sync.get(null);
    } catch (_) { /* 讀取失敗用 default */ }
    SK.sendLog('info', 'translate', 'milestone:storage_loaded', { t: Date.now() - entryTime });

    // 頁面層級繁中偵測
    {
      const skipCheck = settings.skipTraditionalChinesePage === false;
      if (!skipCheck) {
        const contentRoot =
          document.querySelector('article') ||
          document.querySelector('main') ||
          document.querySelector('[role="main"]') ||
          document.body;
        const pageSample = (contentRoot.innerText || '').slice(0, 2000);
        if (pageSample.length > 20 && SK.isTraditionalChinese(pageSample)) {
          SK.showToast('error', '此頁面已是繁體中文，不需翻譯', { autoHideMs: 3000 });
          return;
        }
      }
    }
    SK.sendLog('info', 'translate', 'milestone:zh_check_done', { t: Date.now() - entryTime });

    // v1.5.0: 讀顯示模式設定，寫進 STATE.translatedMode 鎖定本次翻譯用的模式。
    // 同一頁中途切模式不會即時生效（避免半翻半改），需重新觸發翻譯。
    {
      const mode = settings.displayMode;
      STATE.translatedMode = (mode === 'dual') ? 'dual' : 'single';
      STATE.displayMode = STATE.translatedMode;
      // 雙語視覺標記樣式
      const ms = settings.translationMarkStyle;
      SK.currentMarkStyle = (ms && SK.VALID_MARK_STYLES.has(ms)) ? ms : SK.DEFAULT_MARK_STYLE;
      // 雙語模式才注入 wrapper CSS（單語模式不需要）
      if (STATE.translatedMode === 'dual') SK.ensureDualWrapperStyle?.();
    }

    STATE.translating = true;
    STATE.abortController = new AbortController();
    const translateStartTime = Date.now();
    const abortSignal = STATE.abortController.signal;

    const t_collect_start = Date.now();
    let units = SK.collectParagraphs();
    if (units.length === 0) {
      SK.showToast('error', '找不到可翻譯的內容', { autoHideMs: 3000 });
      STATE.translating = false;
      STATE.abortController = null;
      return;
    }
    SK.sendLog('info', 'translate', 'milestone:collect_done', { t: Date.now() - entryTime, dt: Date.now() - t_collect_start, segments: units.length });

    // v1.8.6: partialMode 啟用時跳過 prioritizeUnits,走純 DOM 順序。
    // 為什麼:partialMode 對使用者語意是「翻頁面 DOM 前 N 段」(視覺上連續中文,
    // 不夾雜),不是「prioritize 認為最重要的 N 段散落各處」。在 Ghost / Substack
    // 等部落格,prioritizeUnits 會把短內文段(score < 5,例如「I feel nothing
    // when I see an LLM's output」這種 ~150 字 + 1 個逗號)排到 tier 1 後面,
    // partialMode truncate 25 段全給 tier 0 → 中間夾雜未翻段落。
    // Trade-off: Wikipedia / GitHub 等「DOM 前段是 nav / chrome」的網站開
    // partialMode 會翻到導覽列(回到 v1.7.0 之前行為),但這類網站非 partialMode
    // 主要使用情境(使用者比較會在文章型部落格 / 新聞站開節省模式)。
    const pm = settings.partialMode;
    // v1.8.7: options.ignorePartialMode = true(從「翻譯剩餘段落」按鈕觸發)時忽略 toggle,
    // 即使使用者 toggle 仍開啟也走完整翻譯。toggle 本身不被改寫,下次翻新頁面仍走節省模式。
    const pmActive = !options.ignorePartialMode
      && !!(pm && pm.enabled === true && Number.isFinite(pm.maxUnits) && pm.maxUnits >= 1);
    const viewportOnlyActive = !options.ignorePartialMode && pm?.viewportOnly === true;
    STATE.partialModeActive = pmActive || viewportOnlyActive;

    if (viewportOnlyActive) {
      const before = units.length;
      units = units.filter(SK.isUnitInViewport);
      SK.sendLog('info', 'translate', 'viewportOnly: filter units', { total: before, kept: units.length, skipped: before - units.length });
      if (units.length === 0) {
        SK.showToast('error', '可視範圍內找不到可翻譯的內容', { autoHideMs: 3000 });
        STATE.translating = false;
        STATE.abortController = null;
        return;
      }
    }

    if (!pmActive && !viewportOnlyActive) {
      // v1.7.1: 把內文核心(main/article 後代、長段落)推到 array 前面,
      // 配合下方 translateUnits 的「序列 batch 0 + 並行 rest」,
      // 讓使用者最快看到的譯文是文章開頭而不是 nav / 短連結。
      // 排序在 truncate 之前,使用者超量時優先丟棄低優先級段落(寧丟 nav 不丟內文)。
      const t_priority_start = Date.now();
      units = SK.prioritizeUnits(units);
      SK.sendLog('info', 'translate', 'milestone:prioritize_done', { t: Date.now() - entryTime, dt: Date.now() - t_priority_start });
    } else {
      SK.sendLog('info', 'translate', viewportOnlyActive ? 'viewportOnly: skip prioritizeUnits, use DOM order' : 'partialMode: skip prioritizeUnits, use DOM order', { totalUnits: units.length });
    }

    // 超大頁面防護
    let maxTotalUnits = SK.DEFAULT_MAX_TOTAL_UNITS;
    {
      const v = settings.maxTranslateUnits;
      if (Number.isFinite(v) && v >= 0) maxTotalUnits = v;
    }

    let truncatedCount = 0;
    if (maxTotalUnits > 0 && units.length > maxTotalUnits) {
      truncatedCount = units.length - maxTotalUnits;
      SK.sendLog('warn', 'translate', 'page truncated', { total: units.length, limit: maxTotalUnits, skipped: truncatedCount });
      units = units.slice(0, maxTotalUnits);
    }

    // v1.8.5: partialMode 啟用時 truncate units 到 maxUnits,讓 toast 顯示實際翻譯段數
    // (25 / 25 而非 25 / 227),且 packBatches 自然只切 1 批。
    let pmSkippedCount = 0;  // v1.8.7: 用於 success toast「翻譯剩餘段落」按鈕判斷
    if (pmActive && !viewportOnlyActive && units.length > pm.maxUnits) {
      pmSkippedCount = units.length - pm.maxUnits;
      SK.sendLog('info', 'translate', 'partialMode: truncate units', { total: units.length, kept: pm.maxUnits, skipped: pmSkippedCount });
      units = units.slice(0, pm.maxUnits);
    }

    const total = units.length;

    // ─── 術語表前置流程 ────────────────────────────
    let glossaryEnabled = true;
    let skipThreshold = SK.GLOSSARY_SKIP_THRESHOLD_DEFAULT;
    let blockingThreshold = SK.GLOSSARY_BLOCKING_THRESHOLD_DEFAULT;
    let glossaryTimeout = SK.GLOSSARY_TIMEOUT_DEFAULT;
    {
      const gc = settings.glossary;
      if (gc) {
        glossaryEnabled = gc.enabled !== false;
        skipThreshold = gc.skipThreshold ?? skipThreshold;
        blockingThreshold = gc.blockingThreshold ?? blockingThreshold;
        glossaryTimeout = gc.timeoutMs ?? glossaryTimeout;
      }
    }

    const t_preser_start = Date.now();
    const preSerialized = units.map(unit => {
      if (unit.kind === 'fragment') return { text: (unit.parent?.innerText || '').trim() };
      return { text: (unit.el?.innerText || '').trim() };
    });
    const preTexts = preSerialized.map(s => s.text);
    SK.sendLog('info', 'translate', 'milestone:preserialize_done', { t: Date.now() - entryTime, dt: Date.now() - t_preser_start });

    // 估算批次數
    let estUnitsPerBatch = SK.DEFAULT_UNITS_PER_BATCH;
    let estCharsPerBatch = SK.DEFAULT_CHARS_PER_BATCH;
    {
      const uv = settings.maxUnitsPerBatch;
      const cv = settings.maxCharsPerBatch;
      if (Number.isFinite(uv) && uv >= 1) estUnitsPerBatch = uv;
      if (Number.isFinite(cv) && cv >= 500) estCharsPerBatch = cv;
    }

    let batchCount = 0;
    {
      let chars = 0, segs = 0;
      for (const t of preTexts) {
        const len = t.length;
        if (len > estCharsPerBatch) { batchCount++; chars = 0; segs = 0; continue; }
        if (chars + len > estCharsPerBatch || segs >= estUnitsPerBatch) {
          batchCount++; chars = 0; segs = 0;
        }
        chars += len; segs++;
      }
      if (segs > 0) batchCount++;
    }

    let glossary = null;
    SK.sendLog('info', 'translate', 'milestone:glossary_decision', { t: Date.now() - entryTime, glossaryEnabled, skip: !glossaryEnabled || batchCount <= skipThreshold, batchCount, skipThreshold, blockingThreshold });

    if (glossaryEnabled && batchCount > skipThreshold) {
      const compressedText = SK.extractGlossaryInput(units);
      const inputHash = await SK.sha1(compressedText);
      SK.sendLog('info', 'glossary', 'glossary preprocessing', { batchCount, mode: batchCount > blockingThreshold ? 'blocking' : 'fire-and-forget', compressedChars: compressedText.length, hash: inputHash.slice(0, 8) });

      if (batchCount > blockingThreshold) {
        SK.showToast('loading', '建立術語表⋯', { progress: 0, startTimer: true });
        try {
          const glossaryResult = await Promise.race([
            browser.runtime.sendMessage({
              type: 'EXTRACT_GLOSSARY',
              payload: { compressedText, inputHash },
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('術語表逾時')), glossaryTimeout)
            ),
          ]);
          if (glossaryResult?.ok && glossaryResult.glossary?.length > 0) {
            glossary = glossaryResult.glossary;
            SK.sendLog('info', 'glossary', 'glossary ready', { terms: glossary.length, fromCache: !!glossaryResult.fromCache });
          } else if (glossaryResult?.ok) {
            SK.sendLog('warn', 'glossary', 'glossary returned empty', { fromCache: glossaryResult.fromCache, diag: glossaryResult._diag, inputTokens: glossaryResult.usage?.inputTokens || 0, outputTokens: glossaryResult.usage?.outputTokens || 0 });
          } else {
            SK.sendLog('warn', 'glossary', 'glossary returned not ok', { error: glossaryResult?.error, diag: glossaryResult?._diag });
          }
        } catch (err) {
          SK.sendLog('warn', 'glossary', 'glossary failed/timeout, proceeding without', { error: err.message });
        }
      } else {
        const glossaryPromise = browser.runtime.sendMessage({
          type: 'EXTRACT_GLOSSARY',
          payload: { compressedText, inputHash },
        }).then(res => {
          if (res?.ok && res.glossary?.length > 0) {
            SK.sendLog('info', 'glossary', 'glossary arrived (async)', { terms: res.glossary.length });
            return res.glossary;
          }
          return null;
        }).catch(err => {
          SK.sendLog('warn', 'glossary', 'glossary async failed', { error: err.message });
          return null;
        });
        STATE._glossaryPromise = glossaryPromise;
      }
    }

    SK.showToast('loading', `${labelPrefix}翻譯中… 0 / ${total}`, {
      progress: 0,
      startTimer: true,
    });

    try {
      if (!glossary && STATE._glossaryPromise) {
        try {
          glossary = await Promise.race([
            STATE._glossaryPromise,
            new Promise(resolve => setTimeout(() => resolve(null), 2000)),
          ]);
        } catch (_) { /* ignore */ }
        STATE._glossaryPromise = null;
      }

      SK.sendLog('info', 'translate', 'milestone:before_translate_units', { t: Date.now() - entryTime });
      const { done, failures, pageUsage, rpdWarning } = await SK.translateUnits(units, {
        glossary,
        signal: abortSignal,
        modelOverride: options.modelOverride || null,
        // v1.5.7: engine='openai-compat' 走自訂 Provider 的 chat.completions endpoint
        engine: options.engine || 'gemini',
        // v1.8.8: 「翻譯剩餘段落」路徑要繞過 partialMode 的 skip batch 1+ 邏輯
        ignorePartialMode: !!options.ignorePartialMode || viewportOnlyActive,
        onProgress: (d, t, mismatch) => SK.showToast('loading', `${labelPrefix}翻譯中… ${d} / ${t}`, {
          progress: d / t,
          mismatch: !!mismatch,
        }),
      });

      if (abortSignal.aborted) {
        SK.sendLog('info', 'translate', 'translation aborted', { done, total });
        if (STATE.originalHTML.size > 0) {
          STATE.originalHTML.forEach((originalHTML, el) => {
            el.innerHTML = originalHTML;
            el.removeAttribute('data-shinkansen-translated');
          });
          STATE.originalHTML.clear();
        }
        STATE.translated = false;
        SK.showToast('success', '已取消翻譯', { progress: 1, stopTimer: true, autoHideMs: 2000 });
        return;
      }

      if (failures.length) {
        const failedSegs = failures.reduce((s, f) => s + f.count, 0);
        const firstErr = failures[0].error;
        SK.showToast('error', `翻譯部分失敗:${failedSegs} / ${total} 段失敗`, {
          stopTimer: true,
          detail: firstErr.slice(0, 120),
        });
      }

      STATE.translated = true;
      STATE.translatedBy = 'gemini';  // v1.4.0
      STATE.stickyTranslate = true;
      STATE.stickySlot = options.slot ?? null;  // v1.4.12: 記錄 preset slot 供 SPA 續翻 + 跨 tab 繼承
      browser.runtime.sendMessage({ type: 'SET_BADGE_TRANSLATED' }).catch(() => {});
      // v1.4.11 跨 tab sticky（v1.4.12 改存 preset slot）：opener 鏈中新開的 tab 繼承同 slot
      if (options.slot != null) {
        browser.runtime.sendMessage({ type: 'STICKY_SET', payload: { slot: options.slot } }).catch(() => {});
      }

      if (!failures.length) {
        const totalTokens = pageUsage.inputTokens + pageUsage.outputTokens;
        // v1.8.7: partialMode + 有剩餘未翻段落 → 訊息對齊「節省模式」語意
        let successMsg;
        if (pmActive && pmSkippedCount > 0) {
          successMsg = `已翻譯前 ${total} 段（共 ${total + pmSkippedCount} 段）`;
        } else if (truncatedCount > 0) {
          successMsg = `翻譯完成 （${total} 段，另有 ${truncatedCount} 段因頁面過長被略過）`;
        } else {
          successMsg = `翻譯完成 （${total} 段）`;
        }
        let detail;
        if (totalTokens > 0) {
          const billedTotalTokens = pageUsage.billedInputTokens + pageUsage.outputTokens;
          let line1 = `${SK.formatTokens(billedTotalTokens)} tokens`;
          let line2 = SK.formatUSD(pageUsage.billedCostUSD);
          if (pageUsage.cachedTokens > 0 && pageUsage.inputTokens > 0) {
            const hitPct = (pageUsage.cachedTokens / pageUsage.inputTokens) * 100;
            const savedPct = pageUsage.costUSD > 0
              ? ((pageUsage.costUSD - pageUsage.billedCostUSD) / pageUsage.costUSD) * 100
              : 0;
            line1 += ` (${hitPct.toFixed(0)}% hit)`;
            line2 += ` (${savedPct.toFixed(0)}% saved)`;
          }
          detail = `${line1}\n${line2}`;
        } else if (pageUsage.cacheHits === total) {
          detail = '全部快取命中 · 本次未計費';
        }
        SK.sendLog('info', 'translate', 'page translation usage', {
          segments: total,
          inputTokens: pageUsage.inputTokens,
          cachedTokens: pageUsage.cachedTokens,
          outputTokens: pageUsage.outputTokens,
          billedInputTokens: pageUsage.billedInputTokens,
          billedTotalTokens: pageUsage.billedInputTokens + pageUsage.outputTokens,
          implicitCacheHitRate: pageUsage.inputTokens > 0
            ? `${((pageUsage.cachedTokens / pageUsage.inputTokens) * 100).toFixed(1)}%`
            : 'n/a',
          billedCostUSD: pageUsage.billedCostUSD,
          localCacheHitSegments: pageUsage.cacheHits,
          url: location.href,
        });
        // v1.6.1: 翻譯成功 toast 順帶顯示「有新版可下載」（每日節流）。
        // v1.6.5: 同時也帶 welcome notice（CWS 剛升級提示，每日節流）。
        const updateNotice = await SK.maybeBuildUpdateNotice();
        const welcomeNotice = await SK.maybeBuildWelcomeNotice();
        // v1.8.7: partialMode 翻完後若有剩餘段落,toast 顯示「翻譯剩餘段落」按鈕。
        // 點按 → 觸發 ignorePartialMode 路徑(忽略 toggle 一次,但不改 toggle 設定),
        // 前面已翻好的 N 段從 cache fast path 命中,只後段打 API。toast 常駐直到使用者點按或關閉。
        const action = (pmActive && pmSkippedCount > 0) ? {
          label: '翻譯剩餘段落',
          onClick: () => {
            SK.translatePage({
              ...options,
              ignorePartialMode: true,
            });
          },
        } : null;
        // v1.8.8 instrumentation: success toast fire 前的 state
        SK.sendLog('info', 'translate', 'about to fire success toast', {
          successMsg, total, pmActive, pmSkippedCount, hasAction: !!action,
          ignorePartialMode: !!options.ignorePartialMode,
          done, failures: failures.length,
        });
        SK.showToast('success', successMsg, {
          progress: 1,
          stopTimer: true,
          detail,
          updateNotice,
          welcomeNotice,
          action,
        });
      }

      // 記錄用量到 IndexedDB
      if (done > 0) {
        browser.runtime.sendMessage({
          type: 'LOG_USAGE',
          payload: {
            url: location.href,
            title: document.title,
            inputTokens: pageUsage.inputTokens,
            outputTokens: pageUsage.outputTokens,
            cachedTokens: pageUsage.cachedTokens,
            billedInputTokens: pageUsage.billedInputTokens,
            billedCostUSD: pageUsage.billedCostUSD,
            segments: total,
            cacheHits: pageUsage.cacheHits,
            durationMs: Date.now() - translateStartTime,
            timestamp: Date.now(),
            // v1.5.7: 帶上實際使用的 engine + model（preset modelOverride / openai-compat 引擎），
            // 讓 background 端 LOG_USAGE handler 寫進紀錄的 model 欄位真實對應該批 API 走的模型。
            // 之前缺這兩欄，handler 永遠 fallback 全域 geminiConfig.model，導致 Alt+A/S 切換不同
            // preset 模型在用量紀錄看到同一個。
            engine: options.engine || 'gemini',
            model: options.modelOverride || null,
          },
        }).catch(() => {});
      }

      if (rpdWarning) {
        setTimeout(() => {
          SK.showToast('error', '提醒：今日 API 請求次數已超過預算上限', {
            detail: '翻譯仍可正常使用，但請留意用量。每日計數於太平洋時間午夜重置（約台灣時間下午 3 點）',
            autoHideMs: 6000,
          });
        }, 1500);
      }

      scheduleRescanForLateContent();
      SK.startSpaObserver();
    } catch (err) {
      SK.sendLog('error', 'translate', 'translatePage error', { error: err.message || String(err) });
      if (!abortSignal.aborted) {
        SK.showToast('error', `翻譯失敗:${err.message}`, { stopTimer: true });
      }
    } finally {
      STATE.translating = false;
      STATE.abortController = null;
    }
  };

  // ─── restorePage ─────────────────────────────────────

  function restorePage() {
    if (editModeActive) toggleEditMode(false);
    SK.cancelRescan();
    SK.stopSpaObserver();

    // v1.5.0: dual 模式還原——只移除 wrapper，原文未動所以不需 innerHTML 還原。
    // v1.5.3: 改呼叫 SK.removeDualWrappers()——它同時清除 wrapper 與原段落上的
    // data-shinkansen-dual-source attribute。先前手寫 querySelectorAll 只刪 wrapper、
    // 沒清 attribute，導致下一輪 translatePage 時 injectDual 入口的
    // `if (hasAttribute('data-shinkansen-dual-source')) return;` 命中所有段落，
    // 全部早期 return，使用者「按 Opt+A 翻譯 → 再按還原 → 再按只看到原文」。
    // single 模式維持原本反向覆寫 originalHTML 邏輯。
    if (STATE.translatedMode === 'dual') {
      SK.removeDualWrappers?.();
      // dual 也可能有少數 fallback 元素走了 single 路徑（fragment unit 不支援 dual），
      // 一併還原。
      STATE.originalHTML.forEach((originalHTML, el) => {
        el.innerHTML = originalHTML;
        el.removeAttribute('data-shinkansen-translated');
      });
    } else {
      STATE.originalHTML.forEach((originalHTML, el) => {
        el.innerHTML = originalHTML;
        el.removeAttribute('data-shinkansen-translated');
      });
    }
    STATE.originalHTML.clear();
    STATE.translatedHTML.clear();
    STATE.translationCache?.clear?.();  // v1.5.0
    STATE.translated = false;
    STATE.translatedBy = null;  // v1.4.0
    STATE.translatedMode = null;  // v1.5.0
    STATE.stickyTranslate = false;
    STATE.stickySlot = null;    // v1.4.12
    STATE.partialModeActive = false;  // v1.8.5
    browser.runtime.sendMessage({ type: 'CLEAR_BADGE' }).catch(() => {});
    // v1.4.11: 清除跨 tab sticky（只影響當前 tab，不影響樹中其他 tab）
    browser.runtime.sendMessage({ type: 'STICKY_CLEAR' }).catch(() => {});
    SK.showToast('success', '已還原原文', { progress: 1, autoHideMs: 2000 });
  }

  // ─── v1.4.0: Google Translate 批次送出 ──────────────────────
  // 與 SK.translateUnits 相同架構，但送 TRANSLATE_BATCH_GOOGLE 訊息，
  // 不走術語表（Google MT 無 LLM 語意支援），回傳含 chars 的用量資訊。
  //
  // v1.4.2 格式保留：使用 serializeForGoogleTranslate 專用序列化，只標記
  // <a> 連結（【N】/【/N】）與 atomic 元素（【*N】），其餘 span/b/i/abbr 直接取文字。
  // 相比 v1.4.1 的 serializeWithPlaceholders+⟦→【 轉換，本版大幅減少標記數量
  // （通常 2-4 個，而非 10+），Google MT 不再被過多標記搞亂位置。
  SK.translateUnitsGoogle = async function translateUnitsGoogle(units, { onProgress, signal } = {}) {
    const total = units.length;

    // ── 序列化：只標 <a> 連結與 atomic 元素（footnote sup 等），其餘取純文字 ──
    // 使用 Google Translate 專用序列化（【N】標記），避免 Gemini 路徑的 ⟦N⟧ 標記
    // 在 Google MT 下位置錯亂（⟦⟧ 是數學符號；【】是 CJK 標點，Google MT 原樣保留）。
    const serialized = units.map(unit => {
      if (unit.kind === 'fragment') {
        return SK.serializeFragmentForGoogleTranslate(unit);
      }
      return SK.serializeForGoogleTranslate(unit.el);
    });

    const texts = serialized.map(s => s.text);
    const slotsList = serialized.map(s => s.slots);

    let done = 0;
    let totalChars = 0;
    const failures = [];

    const jobs = packBatches(texts, units, slotsList, 20, 4000, SK.BATCH0_UNITS, SK.BATCH0_CHARS);
    const t0All = Date.now();
    SK.sendLog('info', 'translate', 'translateUnitsGoogle start', { batches: jobs.length, total });

    const runBatch = async (job) => {
      if (signal?.aborted) return;
      const batchIdx = jobs.indexOf(job);
      try {
        const response = await sendMessageWithTimeout({
          type: 'TRANSLATE_BATCH_GOOGLE',
          payload: { texts: job.texts },
        }, BATCH_TIMEOUT_MS);
        if (!response?.ok) throw new Error(response?.error || '未知錯誤');
        totalChars += response.usage?.chars || 0;
        const translations = response.result;
        translations.forEach((tr, j) => {
          const unit = job.units[j];
          if (!tr) return;
          const slots = job.slots[j];
          // 【N】/【/N】/【*N】 換回 ⟦N⟧/⟦/N⟧/⟦*N⟧，走現有 deserializeWithPlaceholders
          const restored = slots?.length
            ? SK.restoreGoogleTranslateMarkers(tr)
            : tr;
          SK.injectTranslation(unit, restored, slots || []);
        });
        done += job.texts.length;
        if (onProgress) onProgress(done, total);
      } catch (err) {
        SK.sendLog('error', 'translate', `google batch ${batchIdx + 1} FAILED`, { error: err.message });
        failures.push({ start: job.start, count: job.texts.length, error: err.message });
      }
    };

    // v1.7.1: 與 translateUnits 同樣的「序列 batch 0 + 並行 rest」策略
    if (jobs.length > 0) {
      await runBatch(jobs[0]);
      if (jobs.length > 1 && !signal?.aborted) {
        await runWithConcurrency(jobs.slice(1), 5, runBatch);
      }
    }

    SK.sendLog('info', 'translate', 'translateUnitsGoogle complete', {
      elapsed: Date.now() - t0All, done, total, failures: failures.length, chars: totalChars,
    });

    return { done, total, failures, chars: totalChars };
  };

  // ─── v1.4.0: Google Translate 翻譯整頁 ──────────────────────
  SK.translatePageGoogle = async function translatePageGoogle(gtOptions = {}) {
    // v1.4.12: gtOptions.slot 由 preset 快速鍵注入，供 STICKY_SET
    // v1.4.13: gtOptions.label 顯示於 loading toast
    const labelPrefix = gtOptions.label ? `[${gtOptions.label}] ` : '';
    // 若同一引擎已翻譯 → 還原（toggle）
    // v1.8.7: ignorePartialMode 豁免,讓「翻譯剩餘段落」按鈕能在已翻譯狀態重觸發
    if (STATE.translated && STATE.translatedBy === 'google' && !gtOptions.ignorePartialMode) {
      restorePage();
      return;
    }
    if (STATE.translated && gtOptions.ignorePartialMode) {
      STATE.translated = false;
    }

    // 若正在翻譯中（任何引擎）→ 中止
    if (STATE.translating) {
      STATE.abortController?.abort();
      SK.showToast('loading', '正在取消翻譯⋯');
      return;
    }

    // 若 Gemini 翻譯已完成 → 先還原，再用 Google 翻
    if (STATE.translated) {
      restorePage();
    }

    if (!navigator.onLine) {
      SK.showToast('error', '目前處於離線狀態，無法翻譯。請確認網路連線後再試', { autoHideMs: 5000 });
      return;
    }

    // 繁中偵測（與 Gemini 相同邏輯）
    let settings = {};
    try { settings = await browser.storage.sync.get(null); } catch (_) {}
    {
      const skipCheck = settings.skipTraditionalChinesePage === false;
      if (!skipCheck) {
        const contentRoot =
          document.querySelector('article') ||
          document.querySelector('main') ||
          document.querySelector('[role="main"]') ||
          document.body;
        const pageSample = (contentRoot.innerText || '').slice(0, 2000);
        if (pageSample.length > 20 && SK.isTraditionalChinese(pageSample)) {
          SK.showToast('error', '此頁面已是繁體中文，不需翻譯', { autoHideMs: 3000 });
          return;
        }
      }
    }

    // v1.5.0: 顯示模式（與 Gemini 路徑相同邏輯）
    {
      const mode = settings.displayMode;
      STATE.translatedMode = (mode === 'dual') ? 'dual' : 'single';
      STATE.displayMode = STATE.translatedMode;
      const ms = settings.translationMarkStyle;
      SK.currentMarkStyle = (ms && SK.VALID_MARK_STYLES.has(ms)) ? ms : SK.DEFAULT_MARK_STYLE;
      if (STATE.translatedMode === 'dual') SK.ensureDualWrapperStyle?.();
    }

    STATE.translating = true;
    STATE.abortController = new AbortController();
    const translateStartTime = Date.now();
    const abortSignal = STATE.abortController.signal;

    let units = SK.collectParagraphs();
    if (units.length === 0) {
      SK.showToast('error', '找不到可翻譯的內容', { autoHideMs: 3000 });
      STATE.translating = false;
      STATE.abortController = null;
      return;
    }

    // v1.8.6: partialMode 啟用時跳過 prioritizeUnits 走 DOM 順序(同 translatePage Gemini 路徑)
    // v1.8.7: ignorePartialMode 豁免
    const pm = settings.partialMode;
    const pmActive = !gtOptions.ignorePartialMode
      && !!(pm && pm.enabled === true && Number.isFinite(pm.maxUnits) && pm.maxUnits >= 1);
    const viewportOnlyActive = !gtOptions.ignorePartialMode && pm?.viewportOnly === true;
    STATE.partialModeActive = pmActive || viewportOnlyActive;
    if (viewportOnlyActive) {
      units = units.filter(SK.isUnitInViewport);
      if (units.length === 0) {
        SK.showToast('error', '可視範圍內找不到可翻譯的內容', { autoHideMs: 3000 });
        STATE.translating = false;
        STATE.abortController = null;
        return;
      }
    }
    if (!pmActive && !viewportOnlyActive) {
      // v1.7.1: 與 translatePage 同樣的優先級排序(內文核心優先)
      units = SK.prioritizeUnits(units);
    }

    // 超大頁面防護（沿用相同上限設定）
    let maxTotalUnits = SK.DEFAULT_MAX_TOTAL_UNITS;
    const v = settings.maxTranslateUnits;
    if (Number.isFinite(v) && v >= 0) maxTotalUnits = v;
    let truncatedCount = 0;
    if (maxTotalUnits > 0 && units.length > maxTotalUnits) {
      truncatedCount = units.length - maxTotalUnits;
      units = units.slice(0, maxTotalUnits);
    }
    // v1.8.5/8.6: partialMode 啟用時 truncate(同 Gemini 路徑)
    if (pmActive && !viewportOnlyActive && units.length > pm.maxUnits) {
      units = units.slice(0, pm.maxUnits);
    }
    const total = units.length;

    SK.showToast('loading', `${labelPrefix}Google 翻譯中… 0 / ${total}`, { progress: 0, startTimer: true });

    try {
      const { done, failures, chars } = await SK.translateUnitsGoogle(units, {
        signal: abortSignal,
        onProgress: (d, t) => SK.showToast('loading', `${labelPrefix}Google 翻譯中… ${d} / ${t}`, {
          progress: d / t,
        }),
      });

      if (abortSignal.aborted) {
        if (STATE.originalHTML.size > 0) {
          STATE.originalHTML.forEach((originalHTML, el) => {
            el.innerHTML = originalHTML;
            el.removeAttribute('data-shinkansen-translated');
          });
          STATE.originalHTML.clear();
        }
        STATE.translated = false;
        SK.showToast('success', '已取消翻譯', { progress: 1, stopTimer: true, autoHideMs: 2000 });
        return;
      }

      if (failures.length) {
        const failedSegs = failures.reduce((s, f) => s + f.count, 0);
        SK.showToast('error', `翻譯部分失敗：${failedSegs} / ${total} 段失敗`, {
          stopTimer: true,
          detail: failures[0].error.slice(0, 120),
        });
      }

      STATE.translated = true;
      STATE.translatedBy = 'google';  // v1.4.0
      STATE.stickyTranslate = true;
      STATE.stickySlot = gtOptions.slot ?? null;  // v1.4.12
      browser.runtime.sendMessage({ type: 'SET_BADGE_TRANSLATED' }).catch(() => {});
      // v1.4.11 跨 tab sticky（v1.4.12 改存 preset slot）：opener 鏈中新開的 tab 繼承同 slot
      if (gtOptions.slot != null) {
        browser.runtime.sendMessage({ type: 'STICKY_SET', payload: { slot: gtOptions.slot } }).catch(() => {});
      }

      if (!failures.length) {
        const successMsg = truncatedCount > 0
          ? `Google 翻譯完成（${total} 段，另有 ${truncatedCount} 段因頁面過長被略過）`
          : `Google 翻譯完成（${total} 段）`;
        // v1.6.1: 同 Gemini 路徑 — 成功 toast 順帶顯示「有新版可下載」
        // v1.6.5: 同時帶 welcome notice
        const updateNotice = await SK.maybeBuildUpdateNotice();
        const welcomeNotice = await SK.maybeBuildWelcomeNotice();
        SK.showToast('success', successMsg, {
          progress: 1,
          stopTimer: true,
          detail: `${chars.toLocaleString()} 字元 · 免費`,
          updateNotice,
          welcomeNotice,
        });
      }

      // 記錄用量（engine 欄位由 background 的 handleTranslateGoogle 寫入）
      SK.sendLog('info', 'translate', 'google page translation done', {
        segments: total, chars, elapsed: Date.now() - translateStartTime, url: location.href,
      });

      scheduleRescanForLateContent();
      SK.startSpaObserver();
    } catch (err) {
      SK.sendLog('error', 'translate', 'translatePageGoogle error', { error: err.message || String(err) });
      if (!abortSignal.aborted) {
        SK.showToast('error', `翻譯失敗：${err.message}`, { stopTimer: true });
      }
    } finally {
      STATE.translating = false;
      STATE.abortController = null;
    }
  };

  // ─── 編輯譯文模式 ────────────────────────────────────

  let editModeActive = false;

  function toggleEditMode(forceState) {
    if (!STATE.translated && forceState !== false) {
      return { ok: false, error: 'translation not complete' };
    }
    const enable = typeof forceState === 'boolean' ? forceState : !editModeActive;
    const els = document.querySelectorAll('[data-shinkansen-translated]');
    if (els.length === 0) return { ok: false, error: 'no translated elements' };

    for (const el of els) {
      if (enable) {
        el.setAttribute('contenteditable', 'true');
        el.classList.add('shinkansen-editable');
      } else {
        el.removeAttribute('contenteditable');
        el.classList.remove('shinkansen-editable');
        // v1.5.5: 結束編輯時把使用者編輯後的 innerHTML 寫回 guard 快取，
        // 否則下一次 Content Guard sweep 會把編輯蓋回原譯文。
        if (STATE.translatedHTML.has(el)) {
          STATE.translatedHTML.set(el, el.innerHTML);
        }
      }
    }
    editModeActive = enable;
    SK.sendLog('info', 'system', enable ? 'edit mode ON' : 'edit mode OFF', { elements: els.length });
    return { ok: true, editing: editModeActive, elements: els.length };
  }

  // ─── 訊息接收 ────────────────────────────────────────

  // v1.4.12: 依 preset slot 觸發對應 engine + model 翻譯。
  // 行為：閒置 → 啟動對應 preset；翻譯中 → abort；已翻譯 → restorePage（任一 slot）。
  async function handleTranslatePreset(slot) {
    // 已翻譯：任意 preset 快速鍵皆取消翻譯（統一還原）
    if (STATE.translated) {
      restorePage();
      return;
    }
    // 翻譯中：abort
    if (STATE.translating) {
      SK.sendLog('info', 'translate', 'aborting in-progress translation (preset key)');
      STATE.abortController?.abort();
      SK.showToast('loading', '正在取消翻譯⋯');
      return;
    }
    // 閒置：讀 preset 定義。若 storage 還沒寫入（例如從 v1.4.11 升級第一次按快捷鍵）
    // 就 fallback 到 SK.DEFAULT_PRESETS，避免「按鍵無反應」。
    let presets = SK.DEFAULT_PRESETS;
    try {
      const { translatePresets } = await browser.storage.sync.get('translatePresets');
      if (Array.isArray(translatePresets) && translatePresets.length > 0) {
        presets = translatePresets;
      }
    } catch { /* 讀取失敗沿用 DEFAULT_PRESETS */ }
    const preset = presets.find(p => p.slot === slot);
    if (!preset) {
      SK.sendLog('warn', 'translate', 'preset not found for slot', { slot });
      return;
    }
    if (preset.engine === 'google') {
      SK.translatePageGoogle({ slot, label: preset.label || null });
    } else if (preset.engine === 'openai-compat') {
      // v1.5.7: 自訂 OpenAI-compatible Provider。model / baseUrl / API Key 全部從
      // settings.customProvider 拿（preset.model 略過），preset 只決定 engine + label。
      SK.translatePage({ engine: 'openai-compat', slot, label: preset.label || null });
    } else {
      SK.translatePage({ modelOverride: preset.model || null, slot, label: preset.label || null });
    }
  }
  // 掛到 SK 讓 content-spa.js（SPA 導航續翻）也能呼叫
  SK.handleTranslatePreset = handleTranslatePreset;

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'TRANSLATE_PRESET') {
      handleTranslatePreset(Number(msg.payload?.slot));
      return;
    }
    if (msg?.type === 'TOGGLE_TRANSLATE') {
      // v1.4.12: 舊訊息保留（popup 按鈕用），映射為 preset slot 2（Flash，推薦預設）
      handleTranslatePreset(2);
      return;
    }
    if (msg?.type === 'TOGGLE_EDIT_MODE') {
      sendResponse(toggleEditMode());
      return true;
    }
    if (msg?.type === 'GET_STATE') {
      sendResponse({ ok: true, translated: STATE.translated, editing: editModeActive });
      return true;
    }
    // v1.2.12: YouTube 字幕翻譯開關（popup toggle 用）
    if (msg?.type === 'GET_SUBTITLE_STATE') {
      sendResponse({ ok: true, active: SK.YT?.active ?? false });
      return true;
    }
    // v1.4.0: Google Translate 快捷鍵（Opt+G）
    if (msg?.type === 'TOGGLE_TRANSLATE_GOOGLE') {
      SK.translatePageGoogle();
      return;
    }
    // v1.5.0: 顯示模式切換通知。若已翻譯，提示使用者重新翻譯以套用。
    // 沒翻譯時不需提示——下次 translatePage 會自動讀新的 displayMode。
    if (msg?.type === 'MODE_CHANGED') {
      const mode = msg.mode === 'dual' ? 'dual' : 'single';
      if (STATE.translated) {
        const desc = mode === 'dual' ? '雙語對照' : '單語覆蓋';
        SK.showToast('success', `顯示模式已切換為「${desc}」，請按快速鍵重新翻譯以套用`, {
          autoHideMs: 5000,
        });
      }
      return;
    }
    // v1.4.21: popup 勾選狀態直接決定「應該啟或停」，不再走 toggle 翻面
    if (msg?.type === 'SET_SUBTITLE') {
      const enabled = !!msg.payload?.enabled;
      const active = !!(SK.YT && SK.YT.active);
      if (enabled && !active) {
        SK.translateYouTubeSubtitles?.().catch(err => {
          SK.sendLog('warn', 'system', 'SET_SUBTITLE start failed', { error: err.message });
        });
      } else if (!enabled && active) {
        try { SK.stopYouTubeTranslation?.(); }
        catch (err) {
          SK.sendLog('warn', 'system', 'SET_SUBTITLE stop failed', { error: err.message });
        }
      }
      // 其餘兩種（enabled 與當前狀態相同）no-op
      return;
    }
  });

  window.__shinkansen_translate = SK.translatePage;

  // ─── Debug API ────────────────────────────────────────

  function buildSelectorPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 6) {
      let s = cur.tagName.toLowerCase();
      if (cur.id) {
        s += '#' + cur.id;
        parts.unshift(s);
        break;
      }
      if (cur.className && typeof cur.className === 'string') {
        const cls = cur.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) s += '.' + cls;
      }
      parts.unshift(s);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function unitSummary(unit, i) {
    if (unit.kind === 'fragment') {
      let text = '';
      let n = unit.startNode;
      while (n) {
        text += n.textContent || '';
        if (n === unit.endNode) break;
        n = n.nextSibling;
      }
      const trimmed = text.trim();
      return {
        index: i,
        kind: 'fragment',
        tag: unit.el.tagName,
        id: unit.el.id || null,
        textLength: trimmed.length,
        textPreview: trimmed.slice(0, 200),
        hasMedia: false,
        selectorPath: buildSelectorPath(unit.el),
      };
    }
    const el = unit.el;
    return {
      index: i,
      kind: 'element',
      tag: el.tagName,
      id: el.id || null,
      textLength: (el.innerText || '').trim().length,
      textPreview: (el.innerText || '').trim().slice(0, 200),
      hasMedia: SK.containsMedia(el),
      selectorPath: buildSelectorPath(el),
    };
  }

  window.__shinkansen = {
    get version() { return browser.runtime.getManifest().version; },
    collectParagraphs() {
      return SK.collectParagraphs().map(unitSummary);
    },
    collectParagraphsWithStats() {
      const stats = {};
      const units = SK.collectParagraphs(document.body, stats);
      return {
        units: units.map(unitSummary),
        skipStats: stats,
      };
    },
    serialize(el) { return SK.serializeWithPlaceholders(el); },
    deserialize(text, slots) { return SK.deserializeWithPlaceholders(text, slots); },
    testInject(el, translation) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) {
        throw new Error('testInject: el must be an Element');
      }
      const { text, slots } = SK.serializeWithPlaceholders(el);
      const unit = { kind: 'element', el };
      SK.injectTranslation(unit, translation, slots);
      return { sourceText: text, slotCount: slots.length };
    },
    // v1.5.0: 雙語注入測試入口。可選 markStyle 覆蓋預設。
    testInjectDual(el, translation, opts) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) {
        throw new Error('testInjectDual: el must be an Element');
      }
      SK.ensureDualWrapperStyle?.();
      if (opts && opts.markStyle && SK.VALID_MARK_STYLES.has(opts.markStyle)) {
        SK.currentMarkStyle = opts.markStyle;
      } else if (!SK.currentMarkStyle) {
        SK.currentMarkStyle = SK.DEFAULT_MARK_STYLE;
      }
      const { text, slots } = SK.serializeWithPlaceholders(el);
      const unit = { kind: 'element', el };
      SK.injectDual(unit, translation, slots);
      // 將 STATE.translatedMode 設為 dual 讓 restorePage 等路徑能正確分派
      STATE.translatedMode = 'dual';
      STATE.translated = true;
      return {
        sourceText: text,
        slotCount: slots.length,
        wrapperPresent: !!STATE.translationCache.get(el),
      };
    },
    testRestoreDual() {
      // 提供 spec 模擬 restorePage 的 dual 分支
      SK.removeDualWrappers?.();
      STATE.translationCache?.clear?.();
      STATE.translated = false;
      STATE.translatedMode = null;
    },
    // v1.5.3: 暴露真正的 restorePage 給 spec 直接測（不走 testRestoreDual 簡化版）。
    // 用途：驗 restorePage 的 dual 分支會清乾淨原段落上的 data-shinkansen-dual-source
    // attribute，避免下一輪 translatePage 時 injectDual 入口因 attribute 殘留早期 return。
    testRestorePage() {
      restorePage();
    },
    selectBestSlotOccurrences(text) {
      return SK.selectBestSlotOccurrences(text);
    },
    getState() {
      return {
        translated: STATE.translated,
        translating: STATE.translating,
        stickyTranslate: STATE.stickyTranslate,
        replacedCount: STATE.originalHTML.size,
        cacheSize: STATE.cache.size,
        guardCacheSize: STATE.translatedHTML.size,
      };
    },
    setTestState(overrides) {
      if ('translated' in overrides) STATE.translated = !!overrides.translated;
      if ('stickyTranslate' in overrides) STATE.stickyTranslate = !!overrides.stickyTranslate;
      // v1.5.0: 暴露 translatedMode 給 spec 切換 dispatcher 行為
      if ('translatedMode' in overrides) {
        const m = overrides.translatedMode;
        STATE.translatedMode = (m === 'dual' || m === 'single') ? m : null;
      }
    },
    testRunContentGuard() {
      return SK.testRunContentGuard();
    },
    // v1.5.5: 暴露 toggleEditMode 給 spec 測編輯模式進出對 guard 快取的同步
    testToggleEditMode(forceState) {
      return toggleEditMode(forceState);
    },
    testGoogleDocsUrl(urlString) {
      try {
        const url = new URL(urlString);
        const isEditor = url.hostname === 'docs.google.com'
          && /^\/document\/d\/[^/]+\/(edit|preview|view)/.test(url.pathname);
        const isMobileBasic = url.hostname === 'docs.google.com'
          && /^\/document\/d\/[^/]+\/mobilebasic/.test(url.pathname);
        const match = url.pathname.match(/^\/document\/d\/([^/]+)/);
        const mobileBasicUrl = match
          ? `https://docs.google.com/document/d/${match[1]}/mobilebasic`
          : null;
        return { isEditor, isMobileBasic, mobileBasicUrl };
      } catch { return { isEditor: false, isMobileBasic: false, mobileBasicUrl: null }; }
    },
  };

  // ─── 初始化 ──────────────────────────────────────────

  browser.runtime.sendMessage({ type: 'CLEAR_BADGE' }).catch(() => {});

  SK.sendLog('info', 'system', 'content script ready', { version: browser.runtime.getManifest().version, url: location.href });

  // 首次載入時的自動翻譯
  (async () => {
    try {
      // v1.2.11: YouTube 字幕自動翻譯（優先於一般 auto-translate）
      // v1.4.13: 使用者沒設過 ytSubtitle 時視為 true（對齊 DEFAULT_SETTINGS.ytSubtitle.autoTranslate=true）
      if (SK.isYouTubePage?.()) {
        const saved = await browser.storage.sync.get('ytSubtitle');
        const ytAutoOn = (saved.ytSubtitle?.autoTranslate !== false);
        if (ytAutoOn) {
          SK.sendLog('info', 'system', 'YouTube auto-subtitle enabled, activating on load');
          // 稍微延遲，等 content script 完成初始化、XHR 攔截器就位
          setTimeout(() => {
            SK.translateYouTubeSubtitles?.().catch(err => {
              SK.sendLog('warn', 'system', 'YouTube auto-subtitle failed', { error: err.message });
            });
          }, 800);
        }
        return; // YouTube 頁面不走一般 auto-translate
      }

      // v1.4.18: 只有 reload 清 sticky——使用者按 reload 才是「我想要新鮮狀態」訊號。
      // 瀏覽器前進後退（back_forward）是歷史切換，應延續既有 sticky：使用者在 A 翻譯
      // 後點連結到 B 會自動翻譯，按返回鍵回 A 同樣該自動翻譯（一致的「翻譯會跟著我的
      // 瀏覽上下文」心智模型）。v1.4.12–v1.4.17 曾一併把 back_forward 歸類成「放棄翻譯」
      // 造成返回頁面顯示英文，v1.4.18 分開處理。
      // （新 tab 開啟的 navigation.type 為 'navigate'，仍走下方 STICKY_QUERY 繼承 opener）
      let navType = null;
      try {
        navType = performance.getEntriesByType('navigation')?.[0]?.type || null;
      } catch { /* 舊環境不支援，視為 navigate */ }
      if (navType === 'reload') {
        await browser.runtime.sendMessage({ type: 'STICKY_CLEAR' }).catch(() => {});
        SK.sendLog('info', 'system', 'page reload, sticky cleared', { navType, url: location.href });
      } else {
        // v1.4.11 跨 tab sticky（v1.4.12 改傳 preset slot）：opener tab 的 preset 延用到此 tab
        const stickyResp = await browser.runtime.sendMessage({ type: 'STICKY_QUERY' }).catch(() => null);
        if (stickyResp?.shouldTranslate && stickyResp.slot != null) {
          SK.sendLog('info', 'system', 'sticky translate inherited from opener tab, triggering preset', { slot: stickyResp.slot, url: location.href });
          handleTranslatePreset(Number(stickyResp.slot));
          return;
        }
      }

      const { autoTranslate = false, autoTranslateSlot } = await browser.storage.sync.get(['autoTranslate', 'autoTranslateSlot']);
      if (!autoTranslate) return;
      if (await SK.isDomainWhitelisted()) {
        // v1.6.13: 走指定 preset slot 而非裸 translatePage(),讓白名單行為跟使用者
        // 期待的「按下對應快速鍵」一致(走 preset.model 的 modelOverride)。
        // 沒設過 / 範圍外時 fallback slot 2,跟 v1.6.12 之前的行為等價。
        const n = Number(autoTranslateSlot);
        const slot = [1, 2, 3].includes(n) ? n : 2;
        SK.sendLog('info', 'system', 'domain in auto-translate list, translating on load', { url: location.href, slot });
        if (typeof SK.handleTranslatePreset === 'function') {
          SK.handleTranslatePreset(slot);
        } else {
          // 防禦性 fallback(理論上 SK.handleTranslatePreset 永遠在 content.js 內 export)
          SK.translatePage({ label: '自動翻譯' });
        }
      }
    } catch (err) {
      SK.sendLog('warn', 'system', 'auto-translate check failed on load', { error: err.message });
    }
  })();

})(window.__SK);
