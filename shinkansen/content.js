// content.js — Shinkansen Content Script 主模組
// 職責：Debug Bridge、translatePage、restorePage、translateUnits、
// 編輯模式、訊息處理、Debug API、初始化。
// 注意：content script 不支援 ES module import。
// v1.1.9: 拆分為 7 個檔案，本檔為主協調層，依賴 content-ns/toast/detect/serialize/inject/spa。

(function(SK) {
  if (!SK || SK.disabled) return;  // v1.5.2: iframe gate（見 content-ns.js）

  const STATE = SK.STATE;

  // ─── v1.10.65: JRead 閱讀模式握手 ──────────────────────
  // JRead 進 / 出閱讀模式時 dispatch 'jread-reader-mode' CustomEvent（跨 extension
  // content script、同 shinkansen-debug-request 機制）。閱讀模式期間暫停 content guard：
  // JRead 把被翻譯的 articleEl 重排成閱讀卡片，guard 每秒 sweep 會誤判成「譯文被覆蓋」
  // 而重建子節點 → 畫面每秒閃動（只在 translate-first 後進閱讀模式）。閱讀卡片即 articleEl
  // 本身、在 guard 管轄區內，JRead 端無法閃避，故由 guard 端讓位。詳見 content-spa.js
  // setContentGuardPaused / contentGuardExternallyPaused 註解。
  window.addEventListener('jread-reader-mode', (e) => {
    const active = !!(e && e.detail && e.detail.active);
    if (typeof SK.setContentGuardPaused === 'function') SK.setContentGuardPaused(active);
  });

  // ─── v0.88: Debug Bridge ──────────────────────────────
  // 已知限制（刻意不修）：response 的 object detail 在 Firefox main world 讀屬性
  // 會 throw Permission denied（Xray 安全模型，同 content-youtube.js bridgeRequest
  // 註解）→ Firefox 上 Debug Bridge 回讀不可用。消費者（cage / debug-harness /
  // CLAUDE.md 文件片段）全是 Chromium-only tooling，改 JSON 字串反而破既有讀法。
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
      SK.safeSendMessage(msg)
        .then((res) => respond(res || { ok: true }))
        .catch((err) => respond({ ok: false, error: err?.message || String(err) }));
    };

    if (action === 'GET_LOGS') {
      forwardToBackground('GET_LOGS', { afterSeq: afterSeq || 0 });
    } else if (action === 'CLEAR_LOGS') {
      forwardToBackground('CLEAR_LOGS');
    } else if (action === 'CLEAR_CACHE') {
      // v1.8.53: forward 給 background 清 storage 之外，也 reset YT in-memory state,
      // 讓「清快取後拖進度條」name + behavior 一致（translatedWindows / captionMap /
      // displayCues 不清的話 onSeeked guard 會擋住「翻譯中…」status + 重翻 API)
      try { SK.YT?._resetTranslationStateForCacheClear?.(); } catch (_) {}
      forwardToBackground('CLEAR_CACHE');
    } else if (action === 'TRANSLATE') {
      respond({ ok: true, triggered: true });
      SK.translatePage();
    } else if (action === 'TRANSLATE_ENGINE') {
      // Debug Bridge:指定翻譯引擎觸發整頁翻譯
      // engine: 'gemini'(預設,等同 TRANSLATE)| 'google'(Google MT)| 'openai-compat'
      const eng = (e.detail && e.detail.engine) || 'gemini';
      respond({ ok: true, triggered: true, engine: eng });
      if (eng === 'google') {
        SK.translatePageGoogle({ label: 'Google MT (debug bridge)' });
      } else if (eng === 'openai-compat') {
        SK.translatePage({ engine: 'openai-compat', label: 'OpenAI-compat (debug bridge)' });
      } else {
        SK.translatePage();
      }
    } else if (action === 'GET_SPA_DEBUG') {
      // Debug Bridge:暴露 SPA observer 內部狀態(含 mutation/rescan counters)
      const info = SK._spaDebug ? SK._spaDebug() : null;
      respond({ ok: true, spa: info });
    } else if (action === 'RESTORE') {
      if (SK.isPageTranslated()) {
        restorePage();
        respond({ ok: true, restored: true });
      } else {
        respond({ ok: false, error: 'not translated' });
      }
    } else if (action === 'TOGGLE_EDIT_MODE') {
      // Debug Bridge:切換編輯譯文模式(等同 popup 按鈕)。cage / harness 進不了
      // extension 的 popup 頁,沒這條就無法自動化驗編輯模式相關 bug(例 Content
      // Guard 編輯豁免與 framework revert 的互動)。僅 dev tail(四段版本)啟用,
      // 與 GET_CACHE_PEEK 同款 gate——bridge 對任意網頁常開,行為開關不對商店版
      // 開放。detail.force = true/false 指定開關,省略 = toggle
      let _editDevTail = false;
      try {
        const _rt = (typeof browser !== 'undefined' && browser.runtime) || (typeof chrome !== 'undefined' && chrome.runtime);
        _editDevTail = String(_rt?.getManifest?.().version || '').split('.').length >= 4;
      } catch (_) { /* orphan context 取不到版本 → 視同商店版拒絕 */ }
      if (!_editDevTail) {
        respond({ ok: false, error: 'TOGGLE_EDIT_MODE disabled in release build (dev tail only)' });
      } else {
        const _force = (e.detail && typeof e.detail.force === 'boolean') ? e.detail.force : undefined;
        respond(toggleEditMode(_force));
      }
    } else if (action === 'GET_PERSISTED_LOGS') {
      // v1.2.52: 讀取跨 service worker 重啟仍保留的持久化 log
      forwardToBackground('GET_PERSISTED_LOGS');
    } else if (action === 'CLEAR_PERSISTED_LOGS') {
      // v1.2.52: 清除持久化 log（測試前呼叫，避免舊資料干擾）
      forwardToBackground('CLEAR_PERSISTED_LOGS');
    } else if (action === 'GET_STATE') {
      // YT 頁多附 yt 子物件(精簡版供「一鍵全看」),完整 raw / captionMap 內容仍走 GET_YT_DEBUG
      const out = {
        ok: true,
        translated: STATE.translated,             // 記憶體 raw flag(供 drift 偵測對照)
        pageTranslated: SK.isPageTranslated?.(),   // v1.10.57: DOM 裁決源(單一真相)
        translating: STATE.translating,
        segmentCount: STATE.originalHTML.size,
      };
      // 附 manifest version——cage / harness 在 RELOAD_EXTENSION 後以此判斷
      // 「載入的是 working tree(dev tail 四段)還是商店版(三段)」,
      // 不用依賴 isolated world evaluate(cage 的 javascript_tool 走 main world 搆不到)
      try {
        const _rt = (typeof browser !== 'undefined' && browser.runtime) || (typeof chrome !== 'undefined' && chrome.runtime);
        out.version = _rt?.getManifest?.().version || null;
      } catch (_) {
        out.version = null;  // orphan content script:context 已失效
      }
      if (SK.isYouTubePage?.() && SK.YT) {
        out.yt = {
          active:          SK.YT.active,
          translating:     SK.YT.translating,
          rawCount:        SK.YT.rawSegments?.length ?? 0,
          captionMapSize:  SK.YT.captionMap?.size ?? 0,
          captionLang:     SK.YT.captionLang,
          isAsr:           SK.YT.isAsr,
          displayCuesLen:  SK.YT.displayCues?.length ?? 0,
          ytConfig:        SK.YT.config,
        };
      }
      respond(out);
    } else if (action === 'GET_STORAGE') {
      // Debug Bridge:暴露 storage.sync 設定供除錯讀取
      // (Chrome for Claude / 主世界 javascript_tool 拿不到 chrome.storage,需 isolated 端橋接)
      // v2.0.53:整段包 try/catch——extension reload 後的 orphan content script
      // 碰 chrome.storage 會「同步」throw「Extension context invalidated」,
      // .catch 接不到 → uncaught 累積在 chrome://extensions 錯誤清單。
      // respond 走 DOM CustomEvent,context 失效後仍可用,改回明確錯誤訊息
      //(其餘 bridge action 經 safeSendMessage,該層已有同款防護)
      const keys = (e.detail && e.detail.keys) || null;  // null = 全部 key
      try {
        const _storage = (typeof browser !== 'undefined' && browser.storage) || (typeof chrome !== 'undefined' && chrome.storage);
        if (!_storage || !_storage.sync) {
          respond({ ok: false, error: 'storage.sync unavailable in this context' });
        } else {
          _storage.sync.get(keys)
            .then((data) => respond({ ok: true, sync: data }))
            .catch((err) => respond({ ok: false, error: err?.message || String(err) }));
        }
      } catch (err) {
        const m = err?.message || String(err);
        respond({
          ok: false,
          error: m.includes('Extension context invalidated')
            ? 'extension 已重載,此分頁的 content script 已失效——請重新整理頁面後再試'
            : m,
        });
      }
    } else if (action === 'SET_GLOSSARY_ENABLED') {
      // Debug Bridge:撥「術語表一致化」開關,寫入路徑等同 popup toggle
      //(讀 glossary 物件 → 改 enabled → 寫回,保留其餘欄位)。
      // 刻意只開放這一顆布林、不做通用 SET_STORAGE——bridge 對任意網頁常開,
      // 通用寫入會讓惡意頁面能改 prompt / customProvider.baseUrl 等敏感設定;
      // 單一布林最壞情況只是雜訊。供 cage / harness 自動化測試術語表路徑
      //(cage 進不了 extension 的 popup / options 頁,沒有這條就得請使用者手撥)
      const _enabled = !!(e.detail && e.detail.enabled);
      try {
        const _storage = (typeof browser !== 'undefined' && browser.storage) || (typeof chrome !== 'undefined' && chrome.storage);
        if (!_storage || !_storage.sync) {
          respond({ ok: false, error: 'storage.sync unavailable in this context' });
        } else {
          _storage.sync.get('glossary')
            .then((data) => {
              const gc = (data && data.glossary) || {};
              gc.enabled = _enabled;
              return _storage.sync.set({ glossary: gc });
            })
            .then(() => respond({ ok: true, enabled: _enabled }))
            .catch((err) => respond({ ok: false, error: err?.message || String(err) }));
        }
      } catch (err) {
        respond({ ok: false, error: err?.message || String(err) });
      }
    } else if (action === 'GET_CACHE_STATS') {
      // Debug Bridge:cache 池健康度快照(唯讀)。tc_ / gloss_ / bookgloss_ 條數、
      // bytes 佔用、tc_ 最舊/最新時間戳——診斷 LRU eviction(9.5MB 池被大量翻譯
      // churn 掉導致「同頁隔天全部 cache miss」)時的直接證據。
      // getBytesInUse 是 Chromium-only,沒有時 bytes 回 null(Firefox bridge 回讀本就不可用)
      try {
        const _storage = (typeof browser !== 'undefined' && browser.storage) || (typeof chrome !== 'undefined' && chrome.storage);
        if (!_storage || !_storage.local) {
          respond({ ok: false, error: 'storage.local unavailable in this context' });
        } else {
          _storage.local.get(null)
            .then((all) => {
              const stats = { tc: 0, gloss: 0, bookgloss: 0, other: 0, tcOldestT: null, tcNewestT: null, glossOldestT: null };
              for (const k of Object.keys(all)) {
                if (k.startsWith('tc_')) {
                  stats.tc++;
                  const t = all[k] && all[k].t;
                  if (typeof t === 'number') {
                    if (stats.tcOldestT === null || t < stats.tcOldestT) stats.tcOldestT = t;
                    if (stats.tcNewestT === null || t > stats.tcNewestT) stats.tcNewestT = t;
                  }
                } else if (k.startsWith('gloss_')) {
                  stats.gloss++;
                  const t = all[k] && all[k].t;
                  if (typeof t === 'number' && (stats.glossOldestT === null || t < stats.glossOldestT)) stats.glossOldestT = t;
                } else if (k.startsWith('bookgloss_')) {
                  stats.bookgloss++;
                } else {
                  stats.other++;
                }
              }
              const respondWith = (bytes) => respond({ ok: true, bytes, stats });
              if (typeof _storage.local.getBytesInUse === 'function') {
                _storage.local.getBytesInUse(null).then(respondWith).catch(() => respondWith(null));
              } else {
                respondWith(null);
              }
            })
            .catch((err) => respond({ ok: false, error: err?.message || String(err) }));
        }
      } catch (err) {
        respond({ ok: false, error: err?.message || String(err) });
      }
    } else if (action === 'GET_CACHE_PEEK') {
      // Debug Bridge:tc_ 快取條目內容查詢（唯讀）。detail.contains = 子字串，
      // 掃 storage.local 所有 tc_ entry,value（譯文）或 key 含該字串的回傳
      // {key, v, t}。診斷「壞譯文寫進快取」類 bug（例 echo 原文進快取）時，
      // GET_CACHE_STATS 只有條數看不到內容，必須能對單條 entry 驗屍。
      // 上限 detail.limit（預設 5）防整池 dump。
      //
      // v2.0.78（隱私 gate）：bridge 對所有頁面常開，快取是全域池（內含使用者在
      // Gmail / 內部文件等其他站翻過的內容全文)——惡意頁 dispatch bridge 事件
      // 換關鍵字反覆探測即可跨站撈譯文。僅 dev tail 版本(四段版本號 = unpacked
      // working tree）啟用；商店版（三段）直接回 error。除錯本來就跑 dev tail，
      // 除錯能力不受影響。
      let _isDevTail = false;
      try {
        const _rt = (typeof browser !== 'undefined' && browser.runtime) || (typeof chrome !== 'undefined' && chrome.runtime);
        _isDevTail = String(_rt?.getManifest?.().version || '').split('.').length >= 4;
      } catch (_) { /* orphan context 等取不到版本 → 視同商店版拒絕 */ }
      if (!_isDevTail) {
        respond({ ok: false, error: 'GET_CACHE_PEEK disabled in release build (dev tail only)' });
        return;
      }
      const _contains = String((e.detail && e.detail.contains) || '');
      const _limit = Math.max(1, Math.min(20, (e.detail && e.detail.limit) || 5));
      try {
        const _storage = (typeof browser !== 'undefined' && browser.storage) || (typeof chrome !== 'undefined' && chrome.storage);
        if (!_storage || !_storage.local || !_contains) {
          respond({ ok: false, error: !_contains ? 'contains 必填' : 'storage.local unavailable in this context' });
        } else {
          _storage.local.get(null)
            .then((all) => {
              const hits = [];
              for (const k of Object.keys(all)) {
                if (!k.startsWith('tc_')) continue;
                const entry = all[k];
                const v = (entry && typeof entry === 'object') ? entry.v : entry; // 向下相容純字串舊格式
                if (typeof v === 'string' && (v.includes(_contains) || k.includes(_contains))) {
                  hits.push({ key: k, v, t: entry && entry.t });
                  if (hits.length >= _limit) break;
                }
              }
              respond({ ok: true, hits });
            })
            .catch((err) => respond({ ok: false, error: err?.message || String(err) }));
        }
      } catch (err) {
        respond({ ok: false, error: err?.message || String(err) });
      }
    } else if (action === 'GET_USAGE_STATS') {
      // DEBUG(v1.10.18.x):用量統計查詢。usage-db 在背景(extension origin)的 IndexedDB,
      // content script / cage 都讀不到,故中繼給 background 的 QUERY_USAGE_STATS。
      // detail.from / detail.to 為 ms epoch 時間範圍(省略 = 全部)。回傳 stats 含
      // totalInputTokens / totalOutputTokens / totalBilledInputTokens / totalBilledCostUSD
      // / byModel——對帳 Google 帳單 + 看有沒有套 cache 折扣(input vs billedInput 差)用。
      forwardToBackground('QUERY_USAGE_STATS', { from: e.detail?.from, to: e.detail?.to });
    } else if (action === 'YT_TRANSLATE') {
      // Debug Bridge:觸發 YouTube 字幕翻譯(等同 Alt+S 在 YT 頁的行為)
      if (!SK.isYouTubePage?.()) {
        respond({ ok: false, error: 'not on YouTube page' });
      } else {
        respond({ ok: true, triggered: true });
        SK.translateYouTubeSubtitles?.({ source: 'debug' }).catch((err) => {
          SK.sendLog('warn', 'system', 'YT_TRANSLATE failed', { error: err?.message });
        });
      }
    } else if (action === 'YT_STOP') {
      // Debug Bridge:停掉 YouTube 字幕翻譯(乾淨重啟測試循環)
      try { SK.stopYouTubeTranslation?.(); respond({ ok: true }); }
      catch (err) { respond({ ok: false, error: err?.message || String(err) }); }
    } else if (action === 'RELOAD_EXTENSION') {
      // DEBUG: hot reload extension(讀磁碟新 code),sendResponse 同步先回再讓
      // background 重啟 SW；此 tab 的 content script 會變成 orphan，下次 navigate
      // 重新注入新 code。
      forwardToBackground('RELOAD_EXTENSION');
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
        // v1.8.53 debug：看哪條 guard 擋住 onSeeked → translateWindowFrom
        ccPaused:                  YT.ccPaused,
        translatingWindowsSize:    YT.translatingWindows?.size ?? -1,
        translatingWindowsArray:   YT.translatingWindows ? Array.from(YT.translatingWindows) : [],
        translatedWindowsSize:     YT.translatedWindows?.size ?? -1,
        translatedWindowsArray:    YT.translatedWindows ? Array.from(YT.translatedWindows).slice(0, 10) : [],
        displayCuesLen:            YT.displayCues?.length ?? -1,
        // v2.0.54 debug:cue 時間軸內容(除錯 ASR 分句時間對齊必需;原本只有 len,
        // 實機驗「太早消失/太晚出現」時拿不到 s/e)。text 截短防 payload 過大
        displayCues:               (YT.displayCues || []).slice(0, 400).map(c => c ? ({
          startMs: c.startMs, endMs: c.endMs,
          targetText: String(c.targetText || '').slice(0, 40),
        }) : null),
        captionLang:               YT.captionLang,
        isAsr:                     YT.isAsr,
      });
    } else {
      respond({ ok: false, error: 'unknown action: ' + action });
    }
  });

  // ─── 延遲 Rescan 機制 ────────────────────────────────

  let rescanAttempts = 0;
  let rescanTimer = null;

  // v1.10.46(批次 2-4):rescan 注入路徑的 abort 訊號。
  // rescanTick(本檔)/ spaObserverRescan(content-spa.js)呼叫 translateUnitsByProvider
  // 原本不帶 signal → translateUnits 的注入前 `signal?.aborted` guard 全是 undefined
  // 放行——使用者還原頁面後,晚到的 rescan 批次仍把譯文注回乾淨頁面(DOM 帶
  // data-shinkansen-translated 但 STATE.translated=false 的殭屍狀態)。
  // 這顆 controller 由 translateUnitsByProvider 統一掛上(呼叫端沒自帶 signal 時),
  // restorePage / restoreOriginalHTMLAndReset / resetForSpaNavigation 時 abort。
  let rescanAbortController = null;

  SK.getRescanSignal = function getRescanSignal() {
    if (!rescanAbortController || rescanAbortController.signal.aborted) {
      rescanAbortController = new AbortController();
    }
    return rescanAbortController.signal;
  };

  SK.abortRescanRuns = function abortRescanRuns() {
    if (rescanAbortController) {
      rescanAbortController.abort();
      rescanAbortController = null;
    }
  };

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
    // v1.8.5: 「只翻文章開頭」啟用時，延遲 rescan 不掃新段落 — 使用者明確只想要文章開頭。
    if (STATE.partialModeActive) {
      SK.sendLog('info', 'translate', 'partialMode: skip rescan');
      return;
    }
    let newUnits = SK.collectParagraphs();
    if (STATE.translatedMode === 'dual' && SK.consolidateDualInlineUnits) {
      newUnits = SK.consolidateDualInlineUnits(newUnits);
    }
    if (newUnits.length > 0) {
      try {
        const { done, failures } = await SK.translateUnitsByProvider(newUnits);
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
  // 釋放 timer。舊版每個 batch 都留一個 90s timer 直到 fire（雖然 race 已 settle
  // 後 reject 被忽略，但 timer 物件 + Error 物件占住到 fire 才 GC，長頁面 50+
  // batch 累積成 timer leak)。
  function sendMessageWithTimeout(message, timeoutMs) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(SK.t('error.batchTimeout', { s: timeoutMs / 1000 }))),
        timeoutMs,
      );
    });
    return Promise.race([SK.safeSendMessage(message), timeoutPromise])
      .finally(() => clearTimeout(timer));
  }

  // v1.10.46(批次 2-4):改收 signal 參數,不再讀全域 STATE.abortController——
  // 全域那顆只屬於「當前主翻譯 run」,rescan run 讀它等於跨輪耦合(主 run 結束後
  // 為 null,rescan 永遠不會停;新主 run 開跑時 rescan 又誤讀新輪的 controller)。
  async function runWithConcurrency(jobs, maxConcurrent, workerFn, signal) {
    const n = Math.min(maxConcurrent, jobs.length);
    if (n === 0) return;
    let cursor = 0;
    const workers = [];
    for (let w = 0; w < n; w++) {
      workers.push((async () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (signal?.aborted) return;
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
  // batch 0 序列等 Gemini,token 少回送快；batch 1+ 並行不吃序列延遲，維持原 limit 衝吞吐。
  // 兩個新參數預設 null = 走舊行為（全部 batch 用同 limit)，向下相容 translateUnitsGoogle / 字幕路徑。
  function packBatches(texts, units, slotsList, maxUnits, maxChars, firstMaxUnits = null, firstMaxChars = null) {
    const jobs = [];
    let cur = null;
    // v1.8.14: flush 時寫入 idx，呼叫端用 job.idx 取代 jobs.indexOf(job)(O(N²) → O(1))
    const flush = () => {
      if (cur && cur.texts.length > 0) {
        cur.idx = jobs.length;
        jobs.push(cur);
      }
      cur = null;
    };
    // 「正在切第一批」= jobs 還沒 push 任何 batch + (firstMaxUnits / firstMaxChars 有值）
    const limU = () => (jobs.length === 0 && firstMaxUnits != null) ? firstMaxUnits : maxUnits;
    const limC = () => (jobs.length === 0 && firstMaxChars != null) ? firstMaxChars : maxChars;
    for (let i = 0; i < texts.length; i++) {
      const len = (texts[i] || '').length;
      if (len > limC()) {
        flush();
        jobs.push({
          idx: jobs.length, // v1.8.14
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

  SK.translateUnits = async function translateUnits(units, { onProgress, glossary, signal, modelOverride, engine, ignorePartialMode, convertDirection, convertOnly } = {}) {
    const tu_entry = Date.now();
    // 術語表對照「只出現一次」裁剪規則(content-inject.js):同一 glossary 參照
    //(主 run 後的 rescan / SPA 續批帶 ctx.glossary 同一顆)不重建、seen 延續;
    // 無 glossary 的 run 傳 null = 清規則
    SK.setAnnotationDedupeRules?.(glossary || null);
    let serialized = units.map(unit => {
      if (unit.kind === 'fragment') {
        return SK.serializeFragmentWithPlaceholders(unit);
      }
      const el = unit.el;
      // v1.2.4: 移除 containsMedia 強制 slots:[] 的早返回。
      // 含媒體元素（如 <img> emoji + <a> 連結）的段落應正常序列化 slots，
      // 讓 LLM 能保留 <a> 佔位符，injection path B 的 fragment 注入已支援此情境。
      if (!SK.hasPreservableInline(el)) {
        // innerText 兜底：SVG 等非 HTML 元素沒有 innerText(偵測端已擋，這裡防禦
        // 其他來源的 unit),undefined.trim() 會讓整批序列化 throw、全頁翻譯失敗
        return { text: (el.innerText ?? el.textContent ?? '').trim(), slots: [] };
      }
      return SK.serializeWithPlaceholders(el);
    });
    // ─── 空字串 unit 防護（v1.10.50，協定層通則）──────────────
    // 候選元素序列化後可能是空字串（典型：textContent 全來自 HARD_EXCLUDE 子樹的
    // <li><script>，isCandidateText 看 textContent 通過、serializer 卻全數排除）。
    // 空段送 LLM 沒有任何可譯內容，模型會自由發揮編出無關長文注入回頁面，且
    // cache key = sha1('') 是固定值，幻覺譯文會跨頁汙染所有空段。一律送 API 前
    // 丟棄：不送、不注入、不標 translated（元素維持原樣）。
    // 本 guard 驗「協定層不送空 payload」這一層；偵測端另有 hardExcludeInflated
    // REJECT（content-detect.js）在收集時就擋，雙層各自獨立（工作流原則 §3）。
    {
      const _preFilter = units.length;
      const _kept = [];
      for (let i = 0; i < serialized.length; i++) {
        if ((serialized[i].text || '').trim()) _kept.push(i);
      }
      if (_kept.length < _preFilter) {
        units = _kept.map(i => units[i]);
        serialized = _kept.map(i => serialized[i]);
        SK.sendLog('warn', 'translate', 'empty-text units dropped before API', {
          dropped: _preFilter - _kept.length, kept: _kept.length,
        });
      }
    }
    let total = units.length;
    const texts = serialized.map(s => s.text);
    const slotsList = serialized.map(s => s.slots);
    SK.sendLog('info', 'translate', 'milestone:tu_serialize_done', { t: Date.now() - tu_entry, units: total });

    // ─── v1.8.39: 段落 hash dedup ──────────────────────────
    // 同 text 內容的段（典型例子：Medium 文章 60 張圖每張的 alt 都是
    // "Press enter or click to view image in full size"）只送 1 段給 API,
    // 翻完後 broadcast inject 到所有 dup 原始位置。slots 仍按各 dup 自己的
    // （因為同 text 內容的 placeholder 結構必相同，只是綁的 DOM 元素不同）。
    //
    // 實作：把 packBatches 收到的 texts/units/slotsList 替換成 unique 子集，
    // runBatch 內 inject 時透過 origIndicesByText 把譯文 broadcast 到所有 dup unit。
    const origIndicesByText = new Map();  // text → [orig idx 0, orig idx 1, ...]
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      let arr = origIndicesByText.get(t);
      if (!arr) { arr = []; origIndicesByText.set(t, arr); }
      arr.push(i);
    }
    const uniqueIndices = Array.from(origIndicesByText.values()).map(arr => arr[0]);
    uniqueIndices.sort((a, b) => a - b);  // 保持原順序，讓 partialMode「前 N 段」概念維持
    const dedupSavedCount = total - uniqueIndices.length;
    if (dedupSavedCount > 0) {
      SK.sendLog('info', 'translate', 'milestone:dedup_done', {
        t: Date.now() - tu_entry,
        original: total,
        unique: uniqueIndices.length,
        saved: dedupSavedCount,
      });
    }
    const dedupedTexts = uniqueIndices.map(i => texts[i]);
    const dedupedUnits = uniqueIndices.map(i => units[i]);
    const dedupedSlots = uniqueIndices.map(i => slotsList[i]);

    // ─── 簡繁本地轉換分流 ──────────────────────────────
    // convertDirection('cn2twp' / 'twp2cn',translatePage 依 target 決定)非空時,
    // 偵測為「相反中文變體」的段落不送 LLM,改送 CONVERT_ZH_LOCAL 走 OpenCC 字典
    // 本地轉換(免費、即時、不需 API Key、不寫 tc_ 快取)。佔位符 ⟦N⟧ 非漢字,
    // 轉換不影響序列化協定。同頁其餘語言段落照走 LLM batch(混合頁兩路並存)。
    // convertOnly(簡繁自動互轉路徑)= 只跑本地轉換組;不可轉換段落整批跳過並自
    // total 扣除——自動路徑的承諾是「絕不悄悄打 API」,漏網段落寧可不翻。
    const llmPickIdx = [];
    const convPickIdx = [];
    if (convertDirection) {
      // isConvertibleVariant:含 detectTextLang 強訊號 + 中英混排品牌標題放寬
      //(cjkRatio ≥ 0.3 且變體特徵單邊乾淨),見 content-detect.js 註解
      for (let i = 0; i < dedupedTexts.length; i++) {
        (SK.isConvertibleVariant(dedupedTexts[i], convertDirection) ? convPickIdx : llmPickIdx).push(i);
      }
      SK.sendLog('info', 'translate', 'milestone:zh_convert_partition', {
        t: Date.now() - tu_entry, direction: convertDirection, convertOnly: !!convertOnly,
        convertible: convPickIdx.length, llm: llmPickIdx.length,
      });
    } else {
      for (let i = 0; i < dedupedTexts.length; i++) llmPickIdx.push(i);
    }
    if (convertOnly && llmPickIdx.length > 0) {
      // 自動互轉路徑混到不可轉換段落(translatePage 端已預過濾,這裡是雙層防護的
      // 協定層):跳過且從進度 total 扣掉對應的原始 unit 數(含 dup broadcast 份)
      let skippedOrig = 0;
      for (const i of llmPickIdx) {
        skippedOrig += (origIndicesByText.get(dedupedTexts[i])?.length || 1);
      }
      total -= skippedOrig;
      SK.sendLog('info', 'translate', 'convertOnly: non-convertible units skipped (no API)', { skippedUnique: llmPickIdx.length, skippedOrig });
    }
    const llmTexts = (convertOnly ? [] : llmPickIdx.map(i => dedupedTexts[i]));
    const llmUnits = (convertOnly ? [] : llmPickIdx.map(i => dedupedUnits[i]));
    const llmSlots = (convertOnly ? [] : llmPickIdx.map(i => dedupedSlots[i]));

    // v1.1.9: 合併讀取設定（減少 browser.storage.sync.get 呼叫次數）
    let maxConcurrent = SK.DEFAULT_MAX_CONCURRENT;
    let maxUnitsPerBatch = SK.DEFAULT_UNITS_PER_BATCH;
    let maxCharsPerBatch = SK.DEFAULT_CHARS_PER_BATCH;
    // v1.8.3: partialMode（只翻文章開頭，節省費用）
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
    // streaming batch 0 已注入的 done 計數——mid-failure fallback 重跑整批前要扣回，
    // 否則 done 重複累計會讓進度 toast 顯示超過 total(例 32/25)
    let batch0StreamDone = 0;
    let convertedCount = 0;  // 簡繁本地轉換注入段數(含 dup broadcast),供 toast 標示免費成果
    const pageUsage = {
      inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUSD: 0,
      billedInputTokens: 0, billedCostUSD: 0,
      cacheHits: 0,
    };
    // v1.8.3: partialMode 啟用時，第一批 limit 用使用者設定的 maxUnits;chars 仍用 BATCH0_CHARS 內部限制
    // v1.8.8: ignorePartialMode 路徑（「翻譯剩餘段落」按鈕）走全頁翻譯，batch 0 用標準 BATCH0_UNITS
    const partialModeActive = partialMode.enabled && !ignorePartialMode;
    const firstBatchUnits = partialModeActive ? partialMode.maxUnits : SK.BATCH0_UNITS;
    // v1.8.39: packBatches 收 deduped 版本（不含重複 text)，減少 batch 數與 API token
    // 簡繁分流後只包 LLM 側段落;本地轉換組另走 runZhConvert(不進 packBatches)
    const jobs = packBatches(llmTexts, llmUnits, llmSlots, maxUnitsPerBatch, maxCharsPerBatch, firstBatchUnits, SK.BATCH0_CHARS);
    SK.sendLog('info', 'translate', 'milestone:tu_packed', { t: Date.now() - tu_entry, batches: jobs.length });
    // v1.8.8 instrumentation: packBatches 詳情（每批 unit 數 / chars)
    // v1.8.39: log 欄位改名強調「上限 vs 實際」差異——歷史命名 `firstBatchUnits` 容易被誤讀成
    // 「batch 0 的實際段數」（其實是傳給 packBatches 的段數上限），曾跟 batch 0 stream start
    // 的 units=23 對不上引發誤判。新欄位：
    //   firstBatchUnitLimit / firstBatchCharLimit  → packBatches 切批時用的兩個上限
    //   firstBatchActualUnits / firstBatchActualChars → jobs[0] 真正包到的數字
    // 兩者差異（例如 limit=25, actual=23）代表 packBatches 在 char 上限提前 flush，屬正常 greedy 行為。
    SK.sendLog('info', 'translate', 'packBatches detail', {
      totalBatches: jobs.length,
      batchSizes: jobs.map((j, i) => ({ idx: i, units: j.texts.length, chars: j.chars })),
      partialMode,
      firstBatchUnitLimit: firstBatchUnits,
      firstBatchCharLimit: SK.BATCH0_CHARS,
      firstBatchActualUnits: jobs[0]?.texts.length || 0,
      firstBatchActualChars: jobs[0]?.chars || 0,
    });
    const failures = [];
    let hadAnyMismatch = false;

    const t0All = Date.now();
    SK.sendLog('info', 'translate', 'translateUnits start', { batches: jobs.length, total, maxConcurrent });

    const runBatch = async (job) => {
      if (signal?.aborted) return;
      const batchIdx = job.idx; // v1.8.14: 取代 jobs.indexOf(job)
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
        if (!response?.ok) throw new Error(SK.i18n.bgErrorMessage(response) || SK.t('common.errorUnknown'));
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
        if (response.hadMismatch) hadAnyMismatch = true;
        // v1.8.10 A:strip LLM 偷懶殘留的 SEP / «N» 標記
        // v1.8.39: dedup broadcast — 同一份譯文 broadcast 到所有 dup 原始位置，
        // 讓 60 段重複的 image alt 只翻 1 次但 inject 60 個 element。
        // v1.9.17: 首次 inject 等 idle gate(機制同 streaming path,見 content-ns.js
        // SK.ensureFirstInjectIdle 註解)。本路徑是 non-streaming retry / fallback,
        // 整批一次性 inject,只需在進入 forEach 前 await 一次 gate。
        const performBatchInject = () => {
          // v1.10.20: 取消已立即還原原文，晚到的批次回應不得再注入（會把譯文注回乾淨頁面）
          if (signal?.aborted) return;
          let injectedThisBatch = 0;
          // v1.10.46: 同輪同 el 去重——收集層若混入「同 el 雙 unit」(補抓 pass 漏
          // seen.add / fragment+element 雙收),broadcast 會對同 el 注入兩次,第二次
          // _preText 已是譯文 → echo 判定誤判 → 沖回原文。規則:
          //   element unit:同 el 已注入過(element 或 fragment)→ skip
          //   fragment unit:同 el 已整顆 element 注入過 → skip;
          //                  其他 fragment 注入過不擋(同 el 多 run 是合法的)
          const injectedEls = new Set();          // element unit 注入過的 el
          const fragmentInjectedEls = new Set();  // fragment unit 注入過的容器 el
          const shouldSkipDupInject = (u) => {
            if (!u?.el) return false;
            if (u.kind === 'element') {
              if (injectedEls.has(u.el) || fragmentInjectedEls.has(u.el)) return true;
              injectedEls.add(u.el);
            } else if (u.kind === 'fragment') {
              if (injectedEls.has(u.el)) return true;
              fragmentInjectedEls.add(u.el);
            }
            return false;
          };
          translations.forEach((tr, j) => {
            const sanitized = SK.sanitizeMarkers(tr);
            const uniqueText = job.texts[j];
            const allOrigIndices = origIndicesByText.get(uniqueText);
            if (allOrigIndices && allOrigIndices.length > 0) {
              for (const origIdx of allOrigIndices) {
                const u = units[origIdx];
                if (shouldSkipDupInject(u)) { injectedThisBatch++; continue; }  // 跳過注入但計入進度
                SK.injectTranslation(u, sanitized, slotsList[origIdx]);
                injectedThisBatch++;
              }
            } else {
              // 防呆 fallback:dedup map 沒命中（理論上不會發生）→ 退回單次 inject
              SK.injectTranslation(job.units[j], sanitized, job.slots[j]);
              injectedThisBatch++;
            }
          });
          done += injectedThisBatch;
          if (onProgress) onProgress(done, total, hadAnyMismatch);
        };
        if (SK._idleGateReached) {
          performBatchInject();
        } else {
          await SK.ensureFirstInjectIdle();
          performBatchInject();
        }
      } catch (err) {
        const elapsed = Date.now() - t0;
        SK.sendLog('error', 'translate', `batch ${batchIdx + 1}/${jobs.length} FAILED`, { elapsed, start: job.start, error: err.message });
        failures.push({ start: job.start, count: job.texts.length, error: err.message });
      }
    };

    // v1.8.0: Streaming 版 batch 0。透過 STREAMING_* onMessage listener 收 SW 推來的
    // first_chunk / segment / done / error / aborted 訊息。回傳兩個 promise 讓主流程協調：
    //   firstChunkPromise：第一個 SSE chunk 抵達時 resolve（主流程在此時同步 dispatch batch 1+)
    //   donePromise:streaming 完整結束（成功/失敗/abort）時 resolve/reject
    // v1.9.21: timeout 從 1.5s → 3s。原 1.5s 來自 reports/streaming-probe Flash first_chunk
    // 實測 936-991ms + 50% margin,但偶發網路 / API 高峰 / Pro 模型 TTFT 1-3s 容易誤判
    // fallback(浪費已產生 token + 多等 ~1.5s)。3s 留 200% margin,真正卡死的 case 也只
    // 多等 1.5s 才 fallback 接住,trade-off 划算。
    const FIRST_CHUNK_TIMEOUT_MS = 3000;
    const runBatch0Streaming = (job) => {
      const streamId = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const t0 = Date.now();
      SK.sendLog('info', 'translate', `batch 1/${jobs.length} stream start`, { streamId, units: job.texts.length, chars: job.chars });

      let firstChunkResolve, doneResolve, doneReject;
      const firstChunkPromise = new Promise((r) => { firstChunkResolve = r; });
      const donePromise = new Promise((res, rej) => { doneResolve = res; doneReject = rej; });
      // 防 unhandled rejection：某些 fallback 路徑（first_chunk timeout / safeSendMessage 回
      // !resp.started / SW 端 STREAMING_ERROR 在 first_chunk 前）會略過 `await donePromise`
      // 但 reject 仍會到達 → 「Uncaught (in promise) Error: streaming failed to start」這類
      // 誤訊息洩漏到 chrome://extensions/ 錯誤面板。掛 noop catch 是新建 chain,
      // 不影響真正在某處 await + try/catch 接到 reject 的路徑。
      donePromise.catch(() => {});

      // v1.10.53: streaming idle watchdog —— 網頁路徑補上 YT _runBatch0Streaming 同款守衛
      // (v1.10.46 只加在字幕路徑,網頁主翻譯路徑漏掉,正是 Christie's 拍品專文「最後一段
      // 無法結束」的成因之一)。first_chunk 之後 `await stream.donePromise` 沒有任何 timeout:
      // Gemini 中途 stall(flash-lite 在長 segment runaway / 靜默)或 SW 中途死亡時,
      // STREAMING_DONE / ERROR 永不到 → donePromise 永久 pending → 整頁卡在「翻譯中」結束不了。
      // 每收到本 stream 任何訊息重置計時;逾時 → 通知 SW abort(止血 + 省 token)+ reject
      // donePromise 讓呼叫端走既有 mid-failure non-streaming fallback。
      // 20s:健康串流 chunk 間距 < 1s,20s 無動靜視為卡死。SK._streamIdleTimeoutMs 為
      // regression spec 縮短逾時的 override seam(與 YT 共用同一 seam)。
      const STREAM_IDLE_TIMEOUT_MS = 20000;
      let _idleTimer = null;
      const _resetIdleWatchdog = () => {
        clearTimeout(_idleTimer);
        _idleTimer = setTimeout(() => {
          try { browser.runtime.onMessage.removeListener(onMessage); } catch (_) {}
          SK.sendLog('warn', 'translate', `batch 1/${jobs.length} streaming idle watchdog fired (stall / SW dead mid-stream?)`, { streamId });
          SK.safeSendMessage({ type: 'STREAMING_ABORT', payload: { streamId } }).catch(() => {});
          firstChunkResolve(false);
          doneReject(new Error('streaming idle timeout'));
        }, SK._streamIdleTimeoutMs || STREAM_IDLE_TIMEOUT_MS);
      };
      const _clearIdleWatchdog = () => { clearTimeout(_idleTimer); _idleTimer = null; };

      // v1.8.0 instrumentation：第一個 segment inject 時間（對應使用者首字延遲）
      let firstSegmentInjectedT = null;
      // v1.9.29-DEV instrument(Finding 4 streaming inject 段拆解):量 firstChunk → first inject 2.5s gap 內部組成
      let firstSegMsgLogged = false;
      let idleGateInstrumented = false;
      // v2.0.69:序號標記二次對齊(gemini.js realignByMarkers)會對「錯位段」補發同 idx
      // 的修正版 STREAMING_SEGMENT——重複 idx 照樣注入(覆蓋錯位譯文)但不重複累加
      // done / batch0StreamDone,避免進度計數超過 total
      const streamSeenIdx = new Set();

      // v1.8.0: abort 傳播 — 使用者按 Option+S 取消 → 通知 SW 中斷 streaming + 清理 listener
      const abortHandler = () => {
        SK.sendLog('info', 'translate', `batch 1/${jobs.length} stream abort triggered`, { streamId });
        _clearIdleWatchdog();
        SK.safeSendMessage({ type: 'STREAMING_ABORT', payload: { streamId } }).catch(() => {});
        // 解開 main 流程的 await(SW 端會回傳 STREAMING_ABORTED 但本地 listener 已移除，
        // 為防卡死直接在這裡 resolve)
        try { browser.runtime.onMessage.removeListener(onMessage); } catch (_) {}
        firstChunkResolve(false);
        doneResolve({ ok: false, aborted: true });
      };
      if (signal) {
        if (signal.aborted) {
          // 進入 streaming 之前就已 aborted，直接走 abort path。
          // v1.10.20: 並且 early return 不 dispatch——原本沒 return 會照樣往下送
          // TRANSLATE_BATCH_STREAM，SW 端白跑一整個 batch 0 的 LLM 請求
          // （取消當下落在 pre-try await 區間時就會踩到，真實環境白花 token）。
          abortHandler();
          return { firstChunkOrTimeout: Promise.resolve({ kind: 'failed' }), donePromise, streamId, cleanup: () => {} };
        }
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      const onMessage = (message) => {
        if (!message || message.payload?.streamId !== streamId) return;
        _resetIdleWatchdog(); // 本 stream 有任何動靜 = SW 還活著、串流還在進
        if (message.type === 'STREAMING_FIRST_CHUNK') {
          firstChunkResolve(true);
        } else if (message.type === 'STREAMING_SEGMENT') {
          const idx = message.payload.segmentIdx;
          // v1.9.29-DEV instrument: 量 STREAMING_SEGMENT 第一次抵達 cs 的時點(扣 stream start 起)
          if (!firstSegMsgLogged) {
            SK.sendLog('info', 'translate', 'milestone:stream_first_seg_msg', { streamId, idx, t: Date.now() - t0 });
            firstSegMsgLogged = true;
          }
          // v1.8.10 A:strip LLM 偷懶殘留的 SEP / «N» 標記
          const tr = SK.sanitizeMarkers(message.payload.translation);
          if (typeof idx === 'number' && idx >= 0 && idx < job.texts.length && tr) {
            // v2.0.69:realign 補發的重複 idx 不重複計數(見 streamSeenIdx 宣告註解)
            const isReinject = streamSeenIdx.has(idx);
            streamSeenIdx.add(idx);
            const tallySeg = () => { if (!isReinject) { done += 1; batch0StreamDone += 1; } };
            // v1.9.17: 首次 inject 等 framework hydration idle(idle gate 機制見
            // content-ns.js SK.ensureFirstInjectIdle 註解)。idle reach 後直接通過,
            // 後續 segments 不再等。translate API call 與 hydration 並行跑,通常
            // API 比 hydration 慢 → 等 API 回來時 gate 早已 reach,wall-time 不變。
            const performInject = () => {
              // v1.10.20: abort 後 listener 已移除，但 idle gate 排隊中的 .then(performInject)
              // 仍可能在「取消已立即還原」之後才執行——注入前再檢查一次
              if (signal?.aborted) return;
              try {
                // v1.8.39: dedup broadcast(streaming 路徑）— 同 text 翻譯結果 broadcast 到所有 dup unit
                const uniqueText = job.texts[idx];
                const allOrigIndices = origIndicesByText.get(uniqueText);
                if (allOrigIndices && allOrigIndices.length > 0) {
                  // v1.10.46: 同 segment broadcast 範圍內同 el 去重(規則同非 streaming
                  // 路徑 shouldSkipDupInject——同 el 注入兩次會被 echo 判定沖回原文;
                  // fragment 同 el 多 run 合法不擋,element vs fragment 互斥)
                  const injectedEls = new Set();
                  const fragmentInjectedEls = new Set();
                  for (const origIdx of allOrigIndices) {
                    const u = units[origIdx];
                    if (u?.el) {
                      if (u.kind === 'element') {
                        if (injectedEls.has(u.el) || fragmentInjectedEls.has(u.el)) { tallySeg(); continue; }
                        injectedEls.add(u.el);
                      } else if (u.kind === 'fragment') {
                        if (injectedEls.has(u.el)) { tallySeg(); continue; }
                        fragmentInjectedEls.add(u.el);
                      }
                    }
                    SK.injectTranslation(u, tr, slotsList[origIdx]);
                    tallySeg();
                  }
                } else {
                  SK.injectTranslation(job.units[idx], tr, job.slots[idx]);
                  tallySeg();
                }
                if (onProgress) onProgress(done, total, hadAnyMismatch);
                if (firstSegmentInjectedT === null) {
                  firstSegmentInjectedT = Date.now() - t0;
                  SK.sendLog('info', 'translate', `batch 1/${jobs.length} stream first segment injected`, { streamId, idx, t: firstSegmentInjectedT });
                }
              } catch (injectErr) {
                SK.sendLog('warn', 'translate', 'streaming inject failed', { idx, error: injectErr.message });
              }
            };
            if (SK._idleGateReached) {
              performInject();
            } else if (!idleGateInstrumented) {
              // v1.9.29-DEV instrument: idle gate 第一次啟動(setTimeout 1500ms 開始等)
              idleGateInstrumented = true;
              const gateStartT = Date.now() - t0;
              SK.sendLog('info', 'translate', 'milestone:stream_idle_gate_start', { streamId, idx, t: gateStartT, waitMs: SK.FIRST_INJECT_HYDRATION_WAIT_MS });
              SK.ensureFirstInjectIdle().then(() => {
                SK.sendLog('info', 'translate', 'milestone:stream_idle_gate_resolved', { streamId, t: Date.now() - t0, dt: Date.now() - t0 - gateStartT });
                performInject();
              });
            } else {
              // idx > 0 共享同一條 gate promise,不重複 log
              SK.ensureFirstInjectIdle().then(performInject);
            }
          }
        } else if (message.type === 'STREAMING_DONE') {
          const elapsed = Date.now() - t0;
          const usage = message.payload.usage || {};
          // v1.8.10 B:hadMismatch=true(LLM 偷懶把 N 段合併成 1 段）時 reject,
          // 觸發既有 mid-failure catch 重翻 batch 0 走 non-streaming（整批 resolve 後一次 split)。
          // segment 0 可能已被 streaming 注入合併譯文（A 已 sanitize),retry 會用乾淨版本覆蓋。
          if (message.payload.hadMismatch) {
            // _anomaly：進低流量異常 ring（lib/logger.js），供「翻好的字被另一版
            // 中文覆蓋」類回報事後排查（2026-07-27 scotto.me 排查缺口——一般
            // persisted ring 100 筆數小時內被日常 log 擠光）。injectedSoFar =
            // 已串流上屏、即將被 non-streaming 重翻覆蓋的段數
            SK.sendLog('warn', 'translate', `batch 1/${jobs.length} stream DONE with hadMismatch, triggering retry`, { elapsed, totalSegments: message.payload.totalSegments, injectedSoFar: batch0StreamDone, _anomaly: true });
            _clearIdleWatchdog();
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
          // streaming fast path(background.js allHit 走 cache 不打 API）會帶 usage.cacheHits=texts.length,
          // 沒帶 cacheHits 的真送 API streaming 視為 0 hit。漏接此欄位會讓 pickRescanToast 判定不到
          // 純 cache hit,SPA rescan toast 一律跳「已翻 N 段新內容」誤導使用者以為又花了 token。
          pageUsage.cacheHits += usage.cacheHits || 0;
          SK.sendLog('info', 'translate', `batch 1/${jobs.length} stream done`, { elapsed, totalSegments: message.payload.totalSegments, hadMismatch: false });
          _clearIdleWatchdog();
          browser.runtime.onMessage.removeListener(onMessage);
          firstChunkResolve(true);  // 防 first_chunk 漏訊息卡死主流程
          doneResolve({ ok: true });
        } else if (message.type === 'STREAMING_ERROR') {
          const elapsed = Date.now() - t0;
          SK.sendLog('error', 'translate', `batch 1/${jobs.length} stream FAILED`, { elapsed, error: message.payload.error });
          _clearIdleWatchdog();
          browser.runtime.onMessage.removeListener(onMessage);
          firstChunkResolve(false);
          doneReject(new Error(SK.i18n.bgErrorMessage(message.payload) || 'streaming failed'));
        } else if (message.type === 'STREAMING_ABORTED') {
          SK.sendLog('info', 'translate', `batch 1/${jobs.length} stream aborted`, { streamId });
          _clearIdleWatchdog();
          browser.runtime.onMessage.removeListener(onMessage);
          firstChunkResolve(false);
          doneResolve({ ok: false, aborted: true });
        }
      };
      browser.runtime.onMessage.addListener(onMessage);
      _resetIdleWatchdog(); // listener 掛上即開始計時(涵蓋 first_chunk 已到但 SEGMENT 永不到的情境)

      // 觸發 streaming(SW 內 fire-and-forget,sendMessage 立刻 resolve)
      SK.safeSendMessage({
        type: 'TRANSLATE_BATCH_STREAM',
        payload: { texts: job.texts, glossary: glossary || null, modelOverride: modelOverride || null, streamId },
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

      // first_chunk 1.5 秒 timeout fallback
      const firstChunkOrTimeout = Promise.race([
        firstChunkPromise.then((v) => ({ kind: v ? 'first_chunk' : 'failed' })),
        new Promise((r) => setTimeout(() => r({ kind: 'timeout' }), FIRST_CHUNK_TIMEOUT_MS)),
      ]);

      return { firstChunkOrTimeout, donePromise, streamId, cleanup: () => { _clearIdleWatchdog(); try { browser.runtime.onMessage.removeListener(onMessage); } catch (_) {} } };
    };

    // ─── 簡繁本地轉換執行 ─────────────────────────────
    // 先於 LLM batch 跑完(轉換近即時,使用者最快看到成果;失敗不阻斷 LLM 側)。
    // 注入與 LLM 路徑同一條 injectTranslation + dup broadcast + idle gate,
    // 僅資料來源不同(單一資料源:注入行為不分岔)。
    const runZhConvert = async () => {
      if (convPickIdx.length === 0) return;
      const t0c = Date.now();
      // 單訊息上限:佔位符序列化後長段落也在數十 KB 級,400 段一包遠低於
      // runtime message 限制;分包讓進度條在超長頁有階段回饋
      const CONV_CHUNK = 400;
      // 同輪同 el 去重(與 performBatchInject 同規則的精簡版:conv 組只有
      // element / fragment unit 各注入一次的需求)
      const _convInjectedEls = new Set();
      for (let off = 0; off < convPickIdx.length; off += CONV_CHUNK) {
        if (signal?.aborted) return;
        const idxChunk = convPickIdx.slice(off, off + CONV_CHUNK);
        const chunkTexts = idxChunk.map(i => dedupedTexts[i]);
        const response = await sendMessageWithTimeout({
          type: 'CONVERT_ZH_LOCAL',
          payload: { texts: chunkTexts, direction: convertDirection },
        }, 30000);
        if (!response?.ok) throw new Error(SK.i18n.bgErrorMessage(response) || SK.t('common.errorUnknown'));
        if (!SK._idleGateReached) await SK.ensureFirstInjectIdle();
        if (signal?.aborted) return;
        let injectedThisChunk = 0;
        response.result.forEach((converted, j) => {
          const uniqueText = chunkTexts[j];
          const allOrigIndices = origIndicesByText.get(uniqueText) || [];
          for (const origIdx of allOrigIndices) {
            const u = units[origIdx];
            if (u?.el && _convInjectedEls.has(u.el)) { injectedThisChunk++; continue; }
            if (u?.el) _convInjectedEls.add(u.el);
            SK.injectTranslation(u, converted, slotsList[origIdx]);
            injectedThisChunk++;
          }
        });
        done += injectedThisChunk;
        convertedCount += injectedThisChunk;
        if (onProgress) onProgress(done, total, hadAnyMismatch);
      }
      SK.sendLog('info', 'translate', 'local zh-convert done', {
        direction: convertDirection, uniqueSegments: convPickIdx.length,
        injected: convertedCount, elapsed: Date.now() - t0c,
      });
    };
    try {
      await runZhConvert();
    } catch (err) {
      // 理論上不會發生(本地轉換無網路 / 無金鑰依賴);防禦 SW 死亡 / 打包缺檔。
      // 記為 failure 讓 translatePage 走既有部分失敗 toast,LLM 側照常執行。
      SK.sendLog('error', 'translate', 'local zh-convert FAILED', { error: err.message, _anomaly: true });
      failures.push({ start: 0, count: convPickIdx.length, error: err.message });
    }

    // v1.8.0: streaming 適用範圍——僅 Gemini 文章翻譯路徑。OpenAI-compat / 其他 engine 仍走 v1.7.x 序列 batch 0 路徑。
    const useStreaming = engine !== 'openai-compat';

    if (jobs.length > 0) {
      let batch0NeedsFallback = false;
      // v1.8.3: partialMode 啟用時，只跑 batch 0，不 dispatch jobs.slice(1)
      // v1.8.8: ignorePartialMode 路徑（「翻譯剩餘段落」按鈕）要翻完所有 batch
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
          // streaming 已開始流入 — 同步 dispatch batch 1+ 並行（partialMode 啟用時跳過）
          const willParallel = jobs.length > 1 && !signal?.aborted && !skipBatch1Plus;
          SK.sendLog('info', 'translate', 'parallel batches dispatch decision', { willParallel, count: willParallel ? jobs.length - 1 : 0 });
          const parallelP = willParallel
            ? runWithConcurrency(jobs.slice(1), maxConcurrent, runBatch, signal)
            : Promise.resolve();
          try {
            await stream.donePromise;
            SK.sendLog('info', 'translate', 'after await stream.donePromise', { t: Date.now() - tu_entry });
          } catch (streamErr) {
            // streaming 中途失敗 — fallback 對 batch 0 重送 non-streaming。
            // 先扣回 streaming 已計入的 done(runBatch 會對整批重新累計)，否則
            // done 重複累計讓進度顯示超過 total
            const injectedSoFar = batch0StreamDone;
            done -= batch0StreamDone;
            batch0StreamDone = 0;
            // _anomaly + injectedSoFar：同 hadMismatch 路徑——重翻會覆蓋已上屏譯文
            SK.sendLog('warn', 'translate', 'streaming mid-failure, retrying batch 0 non-streaming', { error: streamErr.message, injectedSoFar, _anomaly: true });
            await runBatch(jobs[0]);
          }
          await parallelP;
          SK.sendLog('info', 'translate', 'after await parallelP', { t: Date.now() - tu_entry, doneSoFar: done });
        } else {
          // first_chunk 1.5s 沒到（timeout 或 STREAMING_ERROR 在 first_chunk 前發生）
          // → 中斷 streaming,fallback 走 v1.7.x 序列 batch 0 + 並行 batch 1+
          stream.cleanup();
          if (r.kind === 'timeout') {
            SK.sendLog('warn', 'translate', 'streaming first_chunk timeout, falling back to non-streaming', { streamId: stream.streamId, _anomaly: true });
            SK.safeSendMessage({ type: 'STREAMING_ABORT', payload: { streamId: stream.streamId } }).catch(() => {});
          }
          batch0NeedsFallback = true;
        }
      } else {
        batch0NeedsFallback = true;
      }

      if (batch0NeedsFallback) {
        // v1.7.1 行為：序列跑 batch 0 → 並行 batch 1+(partialMode 啟用時跳過 batch 1+)
        await runBatch(jobs[0]);
        if (jobs.length > 1 && !signal?.aborted && !skipBatch1Plus) {
          await runWithConcurrency(jobs.slice(1), maxConcurrent, runBatch, signal);
        }
      }
    }

    SK.sendLog('info', 'translate', 'translateUnits complete', { elapsed: Date.now() - t0All, done, total, convertedCount, failures: failures.length });

    return { done, total, failures, pageUsage, convertedCount };
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

    // v2.0.79: 嵌入式播放器 frame 靜默結束(GitHub issue #58)。快速鍵指令是廣播給
    // 分頁內所有 frame,嵌入的 YouTube / Vimeo 播放器會各自跑一輪把播放器 UI 送去翻,
    // 使用者按一次卻付兩份錢。判準見 content-ns.js isEmbeddedPlayerFrame（結構通則）。
    if (SK.isEmbeddedPlayerFrame?.(document, window)) {
      SK.sendLog('info', 'translate', 'embedded player frame, skip translate', { url: location.href });
      return;
    }

    // v1.8.8 instrumentation: 入口 STATE 狀態
    SK.sendLog('info', 'translate', 'translatePage entry', {
      ignorePartialMode: !!options.ignorePartialMode,
      stateTranslated: STATE.translated,
      statePartialModeActive: STATE.partialModeActive,
      alreadyMarkedCount: document.querySelectorAll('[data-shinkansen-translated]').length,
    });
    // v1.8.7: options.ignorePartialMode = true 從「翻譯剩餘段落」按鈕觸發，
    // 不走 restorePage 早退，直接重翻整頁（前面已翻好的段落會從 cache fast path 命中）
    if (STATE.translated && !options.ignorePartialMode) {
      restorePage();
      return;
    }
    // ignorePartialMode 路徑：STATE.translated=true 進來時，先靜默重置 translated state
    // 讓後續流程能跑完整翻譯（否則 STATE.translated=true 會讓 translateUnits 內 inject 邏輯異常）
    if (STATE.translated && options.ignorePartialMode) {
      SK.sendLog('info', 'translate', 'ignorePartialMode: re-translate without restorePage', { previousPartialMode: STATE.partialModeActive });
      // 不 clear DOM，只重置 translated flag — 已注入的譯文保留，後續 cache fast path 會原樣覆蓋（冪等）
      STATE.translated = false;
    }

    if (isGoogleDocsEditorPage()) {
      // convertOnly(簡繁自動互轉)背景路徑不觸發 Google Docs 導向——toggle 開著
      // 的使用者每次開 Docs 都被自動導到 mobilebasic 是嚴重干擾;導向留給手動翻譯
      if (options.convertOnly) return;
      const mobileUrl = getGoogleDocsMobileBasicUrl();
      if (mobileUrl) {
        SK.sendLog('info', 'translate', 'Google Docs detected, redirecting to mobilebasic', { mobileUrl });
        SK.showToast('loading', SK.t('toast.detectGoogleDocs'));
        SK.safeSendMessage({
          type: 'OPEN_GDOC_MOBILE',
          payload: { url: mobileUrl },
        }).catch(() => {});
        return;
      }
    }

    if (STATE.translating) {
      // v1.10.20: controller 未 aborted 才是真正「翻譯中」→ 取消。
      // 已 aborted = 上一輪取消還在等 in-flight 批次收尾（unwind 中），此時使用者
      // 再按 = 想重新翻譯 → 放行往下開新一輪（identity-guarded releaseRunState
      // 確保舊輪收尾不會清掉新一輪的 state，舊輪注入已被自己的 signal guard 擋住）。
      // 否則快速反復按會卡死在「每按都跳已取消、永遠不能重翻」。
      if (STATE.abortController && !STATE.abortController.signal.aborted) {
        abortInProgressTranslation();
        return;
      }
    }

    if (!navigator.onLine) {
      // 本地簡繁轉換不需網路(字典在 extension 內,CONVERT_ZH_LOCAL 不出網),
      // convertOnly 離線照常執行;手動翻譯維持離線提示
      if (!options.convertOnly) {
        SK.showToast('error', SK.t('toast.offline'), { autoHideMs: 5000 });
        return;
      }
    }

    // v1.10.20: run state（translating + abortController）必須在第一個 await 之前
    // 同步設定——否則兩次快速按鍵會雙雙通過上方 translating 檢查，spawn 兩條並行
    // 翻譯（zombie run：取消只 abort 最後寫入 STATE 的 controller，另一條殺不掉，
    // 且多條 run 的 finally 互踩共用 state）。實測 probe：rapid toggle 下卡死。
    STATE.translating = true;
    const myAbortController = new AbortController();
    STATE.abortController = myAbortController;
    const abortSignal = myAbortController.signal;
    SK.safeSendMessage({ type: 'SET_BADGE_TRANSLATED' }).catch(() => {});

    // v1.7.x instrumentation: 用 entryTime 量化 translatePage 各階段相對時間
    const entryTime = Date.now();

    // v1.1.9: 合併所有設定讀取為單一 browser.storage.sync.get(null)
    let settings = {};
    try {
      settings = await browser.storage.sync.get(null);
    } catch (_) { /* 讀取失敗用 default */ }
    SK.sendLog('info', 'translate', 'milestone:storage_loaded', { t: Date.now() - entryTime });

    // P1: 注入 STATE.targetLanguage(供 content-detect.js isCandidateText 走 target-aware)
    const TARGET = (typeof settings.targetLanguage === 'string' && ['zh-TW','zh-CN','en','ja','ko','es','fr','de'].includes(settings.targetLanguage))
      ? settings.targetLanguage : 'zh-TW';
    STATE.targetLanguage = TARGET;

    // 簡繁本地轉換方向:target 為中文變體時,偵測為相反變體的段落走 OpenCC 本地
    // 轉換(translateUnits 內分流),其他 target 無方向可言 → null(全走 LLM)。
    const convertDirection = TARGET === 'zh-TW' ? 'cn2twp' : (TARGET === 'zh-CN' ? 'twp2cn' : null);
    // convertOnly(簡繁自動互轉 / rescan replay 路徑):只跑免費本地轉換,絕不打 API。
    const convertOnly = !!options.convertOnly;
    if (convertOnly && !convertDirection) {
      // 防禦:toggle 開著但 target 已切到非中文(popup 會藏 toggle,這裡擋 race)
      SK.sendLog('info', 'translate', 'convertOnly: target not Chinese, skip', { target: TARGET });
      releaseRunState(myAbortController);
      SK.safeSendMessage({ type: 'CLEAR_BADGE' }).catch(() => {});
      return;
    }

    // v1.9.26:原「頁面層級整頁同 target skip」機制移除——`document.querySelector('article')`
    // 第一個 sampling 在 SPA 多 article 站(X / Twitter)會被「先載入的繁中 article」或
    // 「Shinkansen 上輪殘留譯文 DOM」誤導整頁 skip;且 X 自家繁中 UI 字串(「4 小時前」
    // 等)混入 article container 會讓 detectTextLang trad 命中,簡中原文被誤判 zh-Hant
    // fallback。整頁 skip 是早期 optimization,paragraph-level isCandidateText 已涵蓋
    // 「逐段判 target lang 跳過」語意,移除整頁 skip 後 X 多 article SPA 場景簡中內容
    // 可正常翻;對純繁中網頁 paragraph 全 skip 結果相同(只少跳一個 toast)。
    // 對應移除:storage.skipTraditionalChinesePage / options.html#skipTraditionalChinesePage /
    // options.js _renderLangDetectLabels / i18n options.langDetect.* + toast.alreadyInTarget。

    // v1.5.0: 讀顯示模式設定，寫進 STATE.translatedMode 鎖定本次翻譯用的模式。
    // 同一頁中途切模式不會即時生效（避免半翻半改），需重新觸發翻譯。
    {
      const mode = settings.displayMode;
      STATE.translatedMode = (mode === 'dual') ? 'dual' : 'single';
      STATE.displayMode = STATE.translatedMode;
      // 雙語視覺標記樣式
      const ms = settings.translationMarkStyle;
      SK.currentMarkStyle = (ms && SK.VALID_MARK_STYLES.has(ms)) ? ms : SK.DEFAULT_MARK_STYLE;
      // v1.8.52: 強調色（token / hex / 'auto'），sanitize 後給 injectDual 套到 wrapper
      SK.currentDualAccent = SK.sanitizeDualAccent?.(settings.dualAccentColor) ?? 'auto';
      // 雙語模式才注入 wrapper CSS（單語模式不需要）
      if (STATE.translatedMode === 'dual') SK.ensureDualWrapperStyle?.();
    }

    // v1.8.41：把 displayCurrency + 最新匯率灌進 SK.currencyState，讓 toast line2
    // 的 SK.formatMoney 知道用 USD 還是 TWD 顯示。匯率讀 storage.local.exchangeRate
    // (background.js 每天 fetch 一次寫進去），失敗則用 fallback 31.6。
    {
      const currency = settings.displayCurrency === 'USD' ? 'USD' : 'TWD';
      let rate = window.__SKFormat.FALLBACK_USD_TWD_RATE;
      try {
        const { exchangeRate } = await browser.storage.local.get('exchangeRate');
        if (exchangeRate && Number.isFinite(exchangeRate.rate) && exchangeRate.rate > 0) {
          rate = exchangeRate.rate;
        }
      } catch (_) { /* 用 fallback */ }
      SK.currencyState = { currency, rate };
    }

    const translateStartTime = Date.now();

    const t_collect_start = Date.now();
    let units = SK.collectParagraphs();
    if (units.length === 0) {
      // convertOnly(簡繁自動互轉)是背景自動行為,收不到段落靜默結束即可——
      // SPA 頁 document_idle 時常還沒渲染,collect=0 是常態,每次 refresh 跳
      // 「沒有可翻譯的內容」error toast 會變成噪音(LetterFeed 英文頁實測回報)。
      // 手動翻譯維持跳 toast(使用者主動操作需要回饋)
      if (!convertOnly) {
        SK.showToast('error', SK.t('toast.noContent'), { autoHideMs: 3000 });
      } else {
        SK.sendLog('info', 'translate', 'convertOnly: no units at collect (page not rendered yet?), silent exit');
      }
      SK.safeSendMessage({ type: 'CLEAR_BADGE' }).catch(() => {}); // run 開頭已 SET_BADGE，沒翻成不可留紅點
      releaseRunState(myAbortController);
      return;
    }
    SK.sendLog('info', 'translate', 'milestone:collect_done', { t: Date.now() - entryTime, dt: Date.now() - t_collect_start, segments: units.length });

    // dual mode:把共用同一 block ancestor 的 inline element unit 合併成一個
    // element unit(用 block ancestor 當 el),讓 LLM 拿到完整上下文、inject 只
    // 產一個 wrapper。single mode 逐 SPAN nodeValue mutate 不碎片,不需合併。
    if (STATE.translatedMode === 'dual' && SK.consolidateDualInlineUnits) {
      units = SK.consolidateDualInlineUnits(units);
    }

    // convertOnly:預過濾出可本地轉換的段落。頁面沒有可轉換段(例如純英文頁 /
    // 已是 target 變體)→ 靜默結束——自動互轉是背景行為,不該對不適用頁跳 toast。
    // translateUnits 內另有同判準的協定層防護(雙層各自獨立,工作流原則 §3)。
    if (convertOnly) {
      units = units.filter(u => SK.isConvertibleVariant((u.el?.innerText || '').trim(), convertDirection));
      if (units.length === 0) {
        SK.sendLog('info', 'translate', 'convertOnly: no convertible units, silent exit');
        releaseRunState(myAbortController);
        SK.safeSendMessage({ type: 'CLEAR_BADGE' }).catch(() => {});
        return;
      }
    }

    // v1.8.6: partialMode 啟用時跳過 prioritizeUnits，走純 DOM 順序。
    // 為什麼：partialMode 對使用者語意是「翻頁面 DOM 前 N 段」（視覺上連續中文，
    // 不夾雜），不是「prioritize 認為最重要的 N 段散落各處」。在 Ghost / Substack
    // 等部落格，prioritizeUnits 會把短內文段（score < 5，例如「I feel nothing
    // when I see an LLM's output」這種 ~150 字 + 1 個逗號）排到 tier 1 後面，
    // partialMode truncate 25 段全給 tier 0 → 中間夾雜未翻段落。
    // Trade-off: Wikipedia / GitHub 等「DOM 前段是 nav / chrome」的網站開
    // partialMode 會翻到導覽列（回到 v1.7.0 之前行為），但這類網站非 partialMode
    // 主要使用情境（使用者比較會在文章型部落格 / 新聞站開節省模式）。
    const pm = settings.partialMode;
    // v1.8.7: options.ignorePartialMode = true（從「翻譯剩餘段落」按鈕觸發）時忽略 toggle,
    // 即使使用者 toggle 仍開啟也走完整翻譯。toggle 本身不被改寫，下次翻新頁面仍走節省模式。
    // convertOnly 不套 partialMode——本地轉換免費,「節省費用」語意不適用
    const pmActive = !options.ignorePartialMode && !convertOnly
      && !!(pm && pm.enabled === true && Number.isFinite(pm.maxUnits) && pm.maxUnits >= 1);
    STATE.partialModeActive = pmActive;

    if (!pmActive) {
      // v1.7.1: 把內文核心（main/article 後代、長段落）推到 array 前面，
      // 配合下方 translateUnits 的「序列 batch 0 + 並行 rest」,
      // 讓使用者最快看到的譯文是文章開頭而不是 nav / 短連結。
      // 排序在 truncate 之前，使用者超量時優先丟棄低優先級段落（寧丟 nav 不丟內文）。
      const t_priority_start = Date.now();
      units = SK.prioritizeUnits(units);
      SK.sendLog('info', 'translate', 'milestone:prioritize_done', { t: Date.now() - entryTime, dt: Date.now() - t_priority_start });
    } else {
      SK.sendLog('info', 'translate', 'partialMode: skip prioritizeUnits, use DOM order', { totalUnits: units.length });
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

    // v1.8.5: partialMode 啟用時 truncate units 到 maxUnits，讓 toast 顯示實際翻譯段數
    // (25 / 25 而非 25 / 227)，且 packBatches 自然只切 1 批。
    let pmSkippedCount = 0;  // v1.8.7: 用於 success toast「翻譯剩餘段落」按鈕判斷
    if (pmActive && units.length > pm.maxUnits) {
      pmSkippedCount = units.length - pm.maxUnits;
      SK.sendLog('info', 'translate', 'partialMode: truncate units', { total: units.length, kept: pm.maxUnits, skipped: pmSkippedCount });
      units = units.slice(0, pm.maxUnits);
    }

    const total = units.length;

    // ─── 術語表前置流程 ────────────────────────────
    // glossaryEnabled 走 SK.resolveGlossaryEnabled 單一資料源(fallback 對齊
    // DEFAULT_SETTINGS.glossary.enabled=false)。settings 走 storage.sync.get(null)
    // 原始讀取、不經 getSettings() 合併預設,全新安裝時 settings.glossary 為 undefined。
    const glossaryEnabled = SK.resolveGlossaryEnabled(settings);
    let skipThreshold = SK.GLOSSARY_SKIP_THRESHOLD_DEFAULT;
    let blockingThreshold = SK.GLOSSARY_BLOCKING_THRESHOLD_DEFAULT;
    let glossaryTimeout = SK.GLOSSARY_TIMEOUT_DEFAULT;
    {
      const gc = settings.glossary;
      if (gc) {
        skipThreshold = gc.skipThreshold ?? skipThreshold;
        blockingThreshold = gc.blockingThreshold ?? blockingThreshold;
        glossaryTimeout = gc.timeoutMs ?? glossaryTimeout;
      }
    }

    const t_preser_start = Date.now();
    const preSerialized = units.map(unit => {
      // v1.10.46: fragment unit 沒有 parent 欄位,讀 unit.el(之前 unit.parent 永遠
      // undefined → fragment 估 0 字,批次數估算失真)
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

    // 簡繁分流下可本地轉換的段落不進 LLM batch——批次數估算與術語表輸入都只算
    // LLM 側,否則簡體內容會虛增 batchCount 觸發術語表、且術語表 API 輸入含大量
    // 根本不會送 LLM 的文字(浪費 token)。convertOnly 時全部段落可轉換 →
    // llmPreTexts 為空 → batchCount=0 → 術語表自然跳過。
    // 批次 8 B6:判準統一用 isConvertibleVariant——實際分流(translateUnits 的
    // partition)走放寬版(含中英混排品牌標題),這裡若用 detectTextLang 嚴格版,
    // 放寬命中的段落會被算進 batchCount(虛增可能誤觸發 blocking 門檻)與術語表
    // 輸入(API 輸入含不送 LLM 的文字,浪費 token)。同一份「哪些段落走本地轉換」
    // 事實必須單一判準(工作流原則 §5)。
    const _isConvertible = convertDirection
      ? preTexts.map(t => SK.isConvertibleVariant(t, convertDirection))
      : null;
    const llmPreTexts = _isConvertible ? preTexts.filter((_, i) => !_isConvertible[i]) : preTexts;

    let batchCount = 0;
    {
      let chars = 0, segs = 0;
      for (const t of llmPreTexts) {
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

    // crypto.subtle 只在 secure context 存在——http:// 頁面上 SK.sha1 會 throw,
    // 而這裡還在 try/finally 保護區之前，炸掉會讓 STATE.translating 永久卡 true
    // (loading toast 掛死、下一次快速鍵只會走 abort)。無法算 hash 就跳過術語表，
    // 主翻譯照常走。
    if (glossaryEnabled && batchCount > skipThreshold && !(crypto && crypto.subtle)) {
      SK.sendLog('warn', 'glossary', 'crypto.subtle unavailable (insecure context) — skipping glossary');
    }
    if (glossaryEnabled && batchCount > skipThreshold && crypto && crypto.subtle) {
      const compressedText = SK.extractGlossaryInput(_isConvertible ? units.filter((_, i) => !_isConvertible[i]) : units);
      const inputHash = await SK.sha1(compressedText);
      SK.sendLog('info', 'glossary', 'glossary preprocessing', { batchCount, mode: batchCount > blockingThreshold ? 'blocking' : 'fire-and-forget', compressedChars: compressedText.length, hash: inputHash.slice(0, 8) });

      // 依 options.engine 路由（openai-compat → CUSTOM，其餘走 Gemini)。同字幕路徑由
      // SK.getSubtitleBatchType 收斂單一資料源，術語表也對齊不重複 inline 三元式。
      const _glossaryMsgType = SK.getGlossaryExtractType(options?.engine);
      if (batchCount > blockingThreshold) {
        SK.showToast('loading', SK.t('toast.glossaryBuilding'), { progress: 0, startTimer: true });
        try {
          const glossaryResult = await Promise.race([
            SK.safeSendMessage({
              type: _glossaryMsgType,
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
        // Fire-and-forget:背景抽術語表、不 blocking 首字,但仍顯示「建立術語表」toast
        // 讓使用者知道有在運作(翻譯進度 toast 之前會短等最多 2s,見下方 glossary-await,
        // 這段期間本 toast 維持可見)。中頁(skipThreshold < 批次 <= blockingThreshold)走此路。
        SK.showToast('loading', SK.t('toast.glossaryBuilding'), { progress: 0, startTimer: true });
        const glossaryPromise = SK.safeSendMessage({
          type: _glossaryMsgType,
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

    // Fire-and-forget 術語表:翻譯前短等(最多 2s)讓它趕上,期間讓上方「建立術語表」
    // toast 維持可見;等到 / 逾時後才切成翻譯進度 toast。移到翻譯進度 toast 之前(原本
    // 在其後)是為了讓中頁的 glossaryBuilding toast 真的被看見。Blocking 路徑 glossary
    // 已就緒 → 此段 no-op;短頁 / 停用術語表 → STATE._glossaryPromise 為空 → no-op。
    if (!glossary && STATE._glossaryPromise) {
      try {
        glossary = await Promise.race([
          STATE._glossaryPromise,
          new Promise(resolve => setTimeout(() => resolve(null), 2000)),
        ]);
      } catch (_) { /* ignore */ }
      STATE._glossaryPromise = null;
    }

    SK.showToast('loading', SK.t('toast.translateProgress', { prefix: labelPrefix, done: 0, total }), {
      progress: 0,
      startTimer: true,
    });

    // v1.9.28:onProgress race guard。await return / catch 後 set true,後續
    // SW 殘留 STREAMING_PROGRESS message 觸發的 onProgress 不再蓋 success/error toast。
    let _progressClosed = false;

    try {
      SK.sendLog('info', 'translate', 'milestone:before_translate_units', { t: Date.now() - entryTime });
      const { done, failures, pageUsage, convertedCount } = await SK.translateUnits(units, {
        glossary,
        signal: abortSignal,
        modelOverride: options.modelOverride || null,
        // v1.5.7: engine='openai-compat' 走自訂 Provider 的 chat.completions endpoint
        engine: options.engine || 'gemini',
        // 簡繁本地轉換分流(target 為中文變體時相反變體段落走 OpenCC,不送 LLM)
        convertDirection,
        convertOnly,
        // v1.8.8: 「翻譯剩餘段落」路徑要繞過 partialMode 的 skip batch 1+ 邏輯
        ignorePartialMode: !!options.ignorePartialMode,
        onProgress: (d, t, mismatch) => {
          if (_progressClosed) return;
          SK.showToast('loading', SK.t('toast.translateProgress', { prefix: labelPrefix, done: d, total: t }), {
            progress: d / t,
            mismatch: !!mismatch,
          });
        },
      });
      _progressClosed = true;

      if (abortSignal.aborted) {
        const restoredEarly = _earlyRestoredAborts.has(myAbortController);
        // v1.10.46: identity guard——SPA 導航 reset 會 abort 舊輪並清掉（或換掉）
        // STATE.abortController；舊輪 in-flight 批次最長 90s 後才 settle 回來,此時
        // STATE.originalHTML 裡已是新頁備份,無條件還原會把新頁譯文整批沖回原文
        // + 跳莫名「已取消」toast。只有「STATE.abortController 還是自己這輪的
        // controller」（= abort 來源沒接手頁面 state）才允許 unwind 還原。
        const stillOwnsRun = STATE.abortController === myAbortController;
        SK.sendLog('info', 'translate', 'translation aborted', { done, total, restoredEarly, stillOwnsRun });
        // v1.10.20: 快速鍵取消已在按下當下立即還原 + 跳「已取消」toast
        // (abortInProgressTranslation)，unwind 只收尾不重複。
        if (!restoredEarly && stillOwnsRun) {
          restoreOriginalHTMLAndReset();
          SK.showToast('success', SK.t('toast.cancelled'), { progress: 1, stopTimer: true, autoHideMs: 2000 });
        }
        return;
      }

      if (failures.length) {
        const failedSegs = failures.reduce((s, f) => s + f.count, 0);
        const firstErr = failures[0].error;
        SK.showToast('error', SK.t('toast.partialFailed', { failed: failedSegs, total }), {
          stopTimer: true,
          detail: firstErr.slice(0, 120),
        });
      }

      // 全數批次失敗(done=0，典型：API key 沒填 / 失效)→ 頁面實際一段都沒翻，
      // 不可走成功後流程：標 translated 會讓下一次快速鍵誤走 restorePage(對乾淨頁
      // 跳「已還原」要按兩次才重翻);sticky / rescan / SPA observer 會對注定失敗的
      // 頁面反覆重送 API;badge 紅點也不該亮著。
      if (done === 0 && failures.length > 0) {
        SK.safeSendMessage({ type: 'CLEAR_BADGE' }).catch(() => {});
        return;
      }

      // 批次 8 B7:convertOnly 全段被協定層跳過(done=0 且無失敗)也不可標 translated——
      // pre-filter(innerText 判可轉換)與 partition(序列化文字判)兩層分歧時全部進
      // llmPickIdx 被 skip → done=0 落入成功路徑:translated=true 會讓 autoConvert
      // 不再重試、快速鍵要先按一次「還原」才能重翻,實際頁面一段都沒轉。
      if (convertOnly && done === 0) {
        SK.safeSendMessage({ type: 'CLEAR_BADGE' }).catch(() => {});
        SK.sendLog('info', 'translate', 'convertOnly: done=0 (all skipped) — not marking translated');
        return;
      }

      STATE.translated = true;
      // v2.0.73:single mode 整頁已是譯文,<html lang> 對齊 target(下游 scraper / a11y 讀頁面層級 lang)
      if (STATE.translatedMode === 'single') SK.applyDocTargetLang?.();
      if (convertOnly) {
        // 簡繁自動互轉:記 provider 供 rescan 續走本地轉換(translateUnitsByProvider
        // 分流),但不設 stickyTranslate / 跨 tab sticky——SPA 導航後由 autoConvertZh
        // 檢查自行 re-trigger,免費路徑不得經 sticky replay 觸發 LLM 整頁翻譯
        STATE.translatedBy = 'opencc-local';
        STATE.translationContext = { provider: 'opencc-local', convertDirection };
      } else {
        // openai-compat 視為獨立 provider 記錄,避免 rescan / SPA nav 把它誤當 Gemini replay。
        const _providerUsed = options.engine === 'openai-compat' ? 'openai-compat' : 'gemini';
        STATE.translatedBy = _providerUsed;  // v1.4.0
        // 把本次翻譯參數記下供 SPA observer rescan / 延遲 rescan / SPA nav replay 重放同引擎+模型+術語表。
        STATE.translationContext = {
          provider: _providerUsed,
          engine: options.engine || null,
          modelOverride: options.modelOverride || null,
          glossary: glossary || null,
          convertDirection,  // rescan 對混合頁新內容延續簡繁分流
        };
        STATE.stickyTranslate = true;
        STATE.stickySlot = options.slot ?? null;  // v1.4.12: 記錄 preset slot 供 SPA 續翻 + 跨 tab 繼承
        // v1.4.11 跨 tab sticky（v1.4.12 改存 preset slot）：opener 鏈中新開的 tab 繼承同 slot
        if (options.slot != null) {
          SK.safeSendMessage({ type: 'STICKY_SET', payload: { slot: options.slot } }).catch(() => {});
        }
      }

      if (!failures.length) {
        const totalTokens = pageUsage.inputTokens + pageUsage.outputTokens;
        // v1.8.7: partialMode + 有剩餘未翻段落 → 訊息對齊「節省模式」語意
        let successMsg;
        if (convertOnly) {
          // 簡繁自動互轉:標示「免費、未使用 API」——讓使用者每次都看見這個價值
          successMsg = SK.t('toast.zhConvertDone', { total });
        } else if (pmActive && pmSkippedCount > 0) {
          successMsg = SK.t('toast.donePartial', { total, all: total + pmSkippedCount });
        } else if (truncatedCount > 0) {
          successMsg = SK.t('toast.doneTruncated', { total, truncated: truncatedCount });
        } else {
          successMsg = SK.t('toast.done', { total });
        }
        let detail;
        if (totalTokens > 0) {
          const billedTotalTokens = pageUsage.billedInputTokens + pageUsage.outputTokens;
          let line1 = `${SK.formatTokens(billedTotalTokens)} tokens`;
          let line2 = SK.formatMoney(pageUsage.billedCostUSD);
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
          detail = SK.t('toast.allCacheHit');
        }
        if (convertOnly) {
          detail = SK.t('toast.zhConvertFree');
        } else if ((convertedCount || 0) > 0) {
          // 混合頁:標示其中免費本地轉換的段數(未計費)
          const _convLine = SK.t('toast.zhConvertPartial', { count: convertedCount });
          detail = detail ? `${detail}\n${_convLine}` : _convLine;
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
        // v1.8.7: partialMode 翻完後若有剩餘段落，toast 顯示「翻譯剩餘段落」按鈕。
        // 點按 → 觸發 ignorePartialMode 路徑（忽略 toggle 一次，但不改 toggle 設定）,
        // 前面已翻好的 N 段從 cache fast path 命中，只後段打 API。toast 常駐直到使用者點按或關閉。
        const action = (pmActive && pmSkippedCount > 0) ? {
          label: SK.t('toast.translateRemaining'),
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

      // 記錄用量到 IndexedDB(convertOnly 純本地轉換零 API 用量,不寫紀錄——
      // usage-db 是 API 對帳工具,0 token entry 只會稀釋統計)
      if (done > 0 && !convertOnly) {
        SK.safeSendMessage({
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

      scheduleRescanForLateContent();
      SK.startSpaObserver();
    } catch (err) {
      _progressClosed = true;
      SK.sendLog('error', 'translate', 'translatePage error', { error: err.message || String(err) });
      if (!abortSignal.aborted) {
        SK.showToast('error', SK.t('toast.translateFailed', { error: err.message }), { stopTimer: true });
      }
      // run 開頭已 SET_BADGE；整輪 throw 且頁面未標 translated → 紅點不可殘留
      if (!STATE.translated) SK.safeSendMessage({ type: 'CLEAR_BADGE' }).catch(() => {});
    } finally {
      _progressClosed = true;
      releaseRunState(myAbortController);
    }
  };

  // v2.0.78（批次 3 B3）：single / dual / nv-mutate 三軌注入痕跡還原的共用步驟。
  // restorePage 與 restoreOriginalHTMLAndReset（取消翻譯的立即還原）先前是同一份事實
  // 雙實作：取消路徑只迭代 originalHTML（single 軌），dual sibling wrapper 與
  // framework-managed nodeValue 譯文全數殘留——「已取消」toast 跳了但頁面留譯文，
  // `isPageTranslated()` = true 而 `STATE.translated` = false（v1.10.57 要消滅的殭屍態）；
  // 殘留 data-shinkansen-dual-source 讓下一輪 injectDual 對這些段落早退。收斂成單一
  // 函式雙路徑共用。回傳 skip 掉的 detached 數供 caller log。
  // SPA reset（content-spa.js:resetForSpaNavigation）另有 STATE.cache / badge / toast
  // 生命週期差異，維持獨立實作不抽進來。
  function restoreInjectedDom() {
    // dual wrapper（同時清原段落的 data-shinkansen-dual-source attribute）。
    // 混合模式（single 全局 + framework-managed 段走 dual）下 translationCache 有項
    // 即代表有 wrapper 要清（v1.9.27）
    if (STATE.translatedMode === 'dual' || (STATE.translationCache && STATE.translationCache.size > 0)) {
      SK.removeDualWrappers?.();
    }
    // framework-managed nodeValue mutate：對 el 內存的每個 {node, originalValue} 寫回。
    // v2.0.85: detached node 也照寫——framework（React 等）會 detach / reattach 同一節點,
    // 只寫 connected 會讓 reattach 回來的節點帶著譯文殭屍殘留
    if (STATE.nodeValueMutateBackup && STATE.nodeValueMutateBackup.size > 0) {
      STATE.nodeValueMutateBackup.forEach((backup, el) => {
        backup.forEach(({ node, originalValue }) => {
          if (node) {
            try { node.nodeValue = originalValue; } catch (_) {}
          }
        });
        try {
          el.removeAttribute('data-shinkansen-nodevalue-mutated');
          SK.restoreLocaleStyling?.(el);
        } catch (_) {}
      });
      STATE.nodeValueMutateBackup.clear();
    }
    // single 軌：innerHTML 還原。v2.0.85: detached el 也照樣還原（v1.8.20 起原本跳過）——
    // SPA framework（React 等）會 detach 後 reattach「同一個」節點（例如留言區小元件
    // re-render），跳過會讓 reattach 回來的節點帶著譯文 + marker 殭屍殘留：
    // isPageTranslated() 判 true 但還原 Map 已清空 → restorePage 殭屍保底 location.reload()
    // （使用者症狀：toggle 第三下頁面閃一下 reload、沒翻譯）。對 detached 節點寫
    // innerHTML / 清 attribute 無副作用：真被 framework 丟棄的節點多寫一次無害，
    // 會 reattach 的節點回來就是乾淨原文。detached 數仍回報供 caller log 觀察。
    let detached = 0;
    STATE.originalHTML.forEach((originalHTML, el) => {
      if (!el.isConnected) detached++;
      // AMO source review: originalHTML 來自 STATE.originalHTML（本 extension 翻譯前用
      // el.innerHTML 讀出來自存的原始 DOM 字串），純還原用，無 user input 流入。
      el.innerHTML = originalHTML;
      el.removeAttribute('data-shinkansen-translated');
      SK.restoreLocaleStyling?.(el);
    });
    STATE.originalHTML.clear();
    STATE.translatedHTML?.clear?.();
    STATE.translatedHTMLByText?.clear?.();
    STATE.originalText?.clear?.();
    STATE.originalLang?.clear?.();
    STATE.originalFontFamily?.clear?.();
    STATE.translationCache?.clear?.();  // v1.5.0
    SK.restoreDocLang?.();  // v2.0.73：還原 <html lang> 原值
    // v2.0.85: Map 已全清,此時 DOM 上還掛注入痕跡的節點都是簿記追不到的無主殘留
    // (站點 clone / 換回舊節點),掃掉才不會讓 isPageTranslated() 永遠 true
    SK.sweepOrphanTranslationMarkers?.();
    return detached;
  }

  // v1.8.14: abort 路徑共用的「還原 + clear + translated=false」。
  // Gemini abort(L840)+ Google abort(L1219）兩處原本各自寫一份。
  function restoreOriginalHTMLAndReset() {
    // v1.10.46（批次 2-4）：還原時 abort in-flight 的 rescan 批次（同 restorePage）
    SK.abortRescanRuns();
    const detached = restoreInjectedDom();
    if (detached > 0) {
      SK.sendLog?.('warn', 'system', 'restoreOriginalHTMLAndReset: restored detached elements (framework may reattach)', { detached });
    }
    STATE.translated = false;
    // v1.10.20: 翻譯開始時就會點亮 icon badge（SET_BADGE_TRANSLATED），
    // abort 取消後頁面已還原為原文，badge 必須跟著清，否則紅點殘留
    // （popup 顯示「就緒」但 icon 仍顯示翻譯中）。restorePage 路徑本就有清，
    // 這條 abort 共用 helper 先前漏掉。
    SK.safeSendMessage({ type: 'CLEAR_BADGE' }).catch(() => {});
  }

  // v1.10.20: 快速鍵取消翻譯改為「按下當下立即還原原文」，不等 in-flight 批次 unwind。
  // 原行為：取消分支只 abort() + 跳「取消中」toast，真正還原要等主流程
  // `await translateUnits` 自己 unwind 回來（非 streaming 批次沒有網路層取消機制，
  // 大批次 + 慢模型可能等數秒～十幾秒），與使用者「按了就該馬上恢復原文」的期待不符。
  // 三個取消入口（translatePage / translatePageGoogle / handleTranslatePreset）共用本 helper。
  // 配套：三條注入路徑（Gemini performBatchInject / Google forEach / streaming performInject）
  // 注入前都檢查 signal.aborted，擋掉「還原後晚到的批次回應把譯文注回乾淨頁面」。
  // _earlyRestoredAborts 讓主流程 unwind 後的 abort 分支知道「已還原 + 已跳 toast」不重複做。
  // 用 per-controller WeakSet 而非 boolean flag：取消後使用者可立刻開新一輪
  // （舊輪還在 unwind），boolean 會被錯的 run 消費；WeakSet 各輪認自己的 controller。
  const _earlyRestoredAborts = new WeakSet();

  function abortInProgressTranslation() {
    SK.sendLog('info', 'translate', 'aborting in-progress translation (immediate restore)');
    const ac = STATE.abortController;
    if (ac) {
      _earlyRestoredAborts.add(ac);
      ac.abort();
    }
    restoreOriginalHTMLAndReset();
    SK.showToast('success', SK.t('toast.cancelled'), { progress: 1, stopTimer: true, autoHideMs: 2000 });
  }

  // v1.10.20: run state 釋放走 identity guard——只有「STATE.abortController 還是
  // 自己這輪的 controller」才能清 translating / abortController。取消後使用者立刻
  // 開新一輪時，舊輪的 finally / 早退路徑不得踩掉新一輪的 state。
  function releaseRunState(myAC) {
    if (STATE.abortController === myAC) {
      STATE.translating = false;
      STATE.abortController = null;
    }
  }

  // ─── restorePage ─────────────────────────────────────

  function restorePage() {
    // v1.10.57: 殭屍頁保底 —— DOM 有 marker 但所有還原資料 Map 已空,代表頁面顯示著
    // 我們已無素材還原的孤兒譯文(Part B 後 SPA nav 不該再產生此狀態,留作其他未知路徑的
    // belt-and-suspenders)。innerHTML 還原無素材可用,唯一乾淨回到原文的方式是重載頁面。
    const _noRestoreData = STATE.originalHTML.size === 0
      && (!STATE.translationCache || STATE.translationCache.size === 0)
      && (!STATE.nodeValueMutateBackup || STATE.nodeValueMutateBackup.size === 0);
    if (_noRestoreData && SK.isPageTranslated()) {
      SK.sendLog?.('warn', 'system', 'restorePage: markers present but no restore data, reloading to original');
      // reload 前先清 marker,避免重載前的瞬間 isPageTranslated 仍判為已翻譯
      document.querySelectorAll('[data-shinkansen-translated], [data-shinkansen-nodevalue-mutated]')
        .forEach((el) => {
          el.removeAttribute('data-shinkansen-translated');
          el.removeAttribute('data-shinkansen-nodevalue-mutated');
        });
      STATE.translated = false;
      SK.safeSendMessage({ type: 'CLEAR_BADGE' }).catch(() => {});
      location.reload();
      return;
    }
    if (editModeActive) toggleEditMode(false);
    SK.cancelRescan();
    // v1.10.46(批次 2-4):還原時 abort in-flight 的 rescan 批次,擋掉晚到回應再注入
    SK.abortRescanRuns();
    SK.stopSpaObserver();
    // 術語表對照裁剪 seen 狀態跟頁面翻譯生命週期綁定:還原即歸零,
    // 下一輪 translatePage 重新「第一次出現保留對照」
    SK.clearAnnotationDedupeRules?.();

    // v1.5.0 起的 dual wrapper / v1.9.27 nodeValue mutate / single innerHTML 三軌還原
    // 與 Map 清理收斂到 restoreInjectedDom()（v2.0.78 批次 3 B3，與取消翻譯路徑
    // restoreOriginalHTMLAndReset 共用，歷史演進註解見該函式）
    const restoreDetached = restoreInjectedDom();
    if (restoreDetached > 0) {
      SK.sendLog?.('warn', 'system', 'restorePage: restored detached elements (framework may reattach)', { detached: restoreDetached });
    }
    STATE.translated = false;
    STATE.translatedBy = null;  // v1.4.0
    STATE.translationContext = null;
    STATE.translatedMode = null;  // v1.5.0
    STATE.stickyTranslate = false;
    STATE.stickySlot = null;    // v1.4.12
    STATE.partialModeActive = false;  // v1.8.5
    SK.safeSendMessage({ type: 'CLEAR_BADGE' }).catch(() => {});
    // v1.4.11: 清除跨 tab sticky（只影響當前 tab，不影響樹中其他 tab）
    SK.safeSendMessage({ type: 'STICKY_CLEAR' }).catch(() => {});
    SK.showToast('success', SK.t('toast.restored'), { progress: 1, autoHideMs: 2000 });
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
    // Google MT 路徑無術語表:清掉前一輪(若有)的對照裁剪規則,避免跨引擎殘影
    SK.clearAnnotationDedupeRules?.();
    // ── 序列化：只標 <a> 連結與 atomic 元素（footnote sup 等），其餘取純文字 ──
    // 使用 Google Translate 專用序列化（【N】標記），避免 Gemini 路徑的 ⟦N⟧ 標記
    // 在 Google MT 下位置錯亂（⟦⟧ 是數學符號；【】是 CJK 標點，Google MT 原樣保留）。
    let serialized = units.map(unit => {
      if (unit.kind === 'fragment') {
        return SK.serializeFragmentForGoogleTranslate(unit);
      }
      return SK.serializeForGoogleTranslate(unit.el);
    });

    // 空字串 unit 防護(v1.10.50 協定層通則，與 Gemini 路徑 translateUnits 對齊——
    // 該防護是雙層設計的 protocol 層，只做在單一 engine 會 drift)：序列化後為空的
    // 段不送 API、不注入、不標 translated
    {
      const _preFilter = units.length;
      const _kept = [];
      for (let i = 0; i < serialized.length; i++) {
        if ((serialized[i].text || '').trim()) _kept.push(i);
      }
      if (_kept.length < _preFilter) {
        units = _kept.map(i => units[i]);
        serialized = _kept.map(i => serialized[i]);
        SK.sendLog('warn', 'translate', 'empty-text units dropped before API (google)', {
          dropped: _preFilter - _kept.length, kept: _kept.length,
        });
      }
    }
    const total = units.length;

    const texts = serialized.map(s => s.text);
    const slotsList = serialized.map(s => s.slots);

    let done = 0;
    let totalChars = 0;
    let totalCacheHits = 0;
    const failures = [];

    const jobs = packBatches(texts, units, slotsList, 20, 4000, SK.BATCH0_UNITS, SK.BATCH0_CHARS);
    const t0All = Date.now();
    SK.sendLog('info', 'translate', 'translateUnitsGoogle start', { batches: jobs.length, total });

    const runBatch = async (job) => {
      if (signal?.aborted) return;
      const batchIdx = job.idx; // v1.8.14: 取代 jobs.indexOf(job)
      try {
        const response = await sendMessageWithTimeout({
          type: 'TRANSLATE_BATCH_GOOGLE',
          payload: { texts: job.texts },
        }, BATCH_TIMEOUT_MS);
        if (!response?.ok) throw new Error(SK.i18n.bgErrorMessage(response) || SK.t('common.errorUnknown'));
        totalChars += response.usage?.chars || 0;
        totalCacheHits += response.usage?.cacheHits || 0;
        const translations = response.result;
        // v1.9.17: 首次 inject 等 idle gate(機制同 streaming path,見 content-ns.js
        // SK.ensureFirstInjectIdle 註解)。
        if (!SK._idleGateReached) {
          await SK.ensureFirstInjectIdle();
        }
        // v1.10.20: 取消已立即還原原文，晚到的批次回應不得再注入（同 Gemini 路徑）
        if (signal?.aborted) return;
        translations.forEach((tr, j) => {
          const unit = job.units[j];
          if (!tr) return;
          const slots = job.slots[j];
          // 【N】/【/N】/【*N】 換回 ⟦N⟧/⟦/N⟧/⟦*N⟧，走現有 deserializeWithPlaceholders
          let restored = slots?.length
            ? SK.restoreGoogleTranslateMarkers(tr)
            : tr;
          // CJK↔slot 空格補齊:Google MT 翻成 CJK 時常吃掉 marker 前後空格,
          // 導致譯文跟 URL/mention 視覺黏在一起(「傳聞如下https://…透過@user」)。
          // 只對 opening ⟦N⟧ / ⟦*N⟧ 前(CJK→slot 邊界)和
          // closing ⟦/N⟧ / atomic ⟦*N⟧ 後(slot→CJK 邊界)補空格;
          // 不動 ⟦N⟧ 後(slot 內容起始)與 ⟦/N⟧ 前(slot 內容結尾)。
          if (slots?.length && SK.ensureCJKSlotSpacing) {
            restored = SK.ensureCJKSlotSpacing(restored);
          }
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
        await runWithConcurrency(jobs.slice(1), 5, runBatch, signal);
      }
    }

    SK.sendLog('info', 'translate', 'translateUnitsGoogle complete', {
      elapsed: Date.now() - t0All, done, total, failures: failures.length, chars: totalChars,
      cacheHits: totalCacheHits,
    });

    return { done, total, failures, chars: totalChars, cacheHits: totalCacheHits };
  };

  // ─── Provider-aware rescan / SPA replay router ──────────────────────
  // rescanTick(content.js)/ spaObserverRescan(content-spa.js)/ SPA nav fallback 統一過這兩個 router,
  // 依 STATE.translationContext 分流到首次翻譯時使用的 provider + 參數,
  // 避免「首翻用 Google MT / openai-compat,rescan 卻 fallback 到預設 Gemini」這類 drift
  // (對應 CLAUDE.md 全域 §5 單一資料源原則)。

  // 增量翻譯路徑:回傳 { done, total, failures, pageUsage? }。
  // v1.9.8: Google MT 路徑改回 pageUsage: { cacheHits },讓 pickRescanToast 能
  // 正確判別「純 cache hit 應 silent」。先前回 null 讓 SPA rescan 每次撈 cache
  // 都跳「已翻譯 N 段新內容」success toast,在 X / Threads 等不斷 lazy-load 的
  // 站滑動時被使用者體感為「不斷彈 toast 干擾」。
  SK.translateUnitsByProvider = async function translateUnitsByProvider(units, opts = {}) {
    // v1.10.46(批次 2-4):rescan 呼叫端(rescanTick / spaObserverRescan / SPA nav
    // fallback)都不自帶 signal——統一在這個 router 掛 rescan AbortController,
    // restorePage / SPA reset abort 它之後,晚到批次的注入前 `signal?.aborted` guard
    // 才真的擋得住(原本 signal=undefined 全放行,還原後零星段落又變回譯文)。
    if (!opts.signal) opts = { ...opts, signal: SK.getRescanSignal() };
    const ctx = STATE.translationContext;
    if (!ctx) {
      // 防禦性:理論上 rescan 一定在 translated=true 之後觸發,context 應已 set;
      // 若意外無 context,fallback 走預設 Gemini path(舊行為)。
      SK.sendLog?.('warn', 'translate', 'translateUnitsByProvider: no translationContext, fallback to default gemini');
      return SK.translateUnits(units, opts);
    }
    if (ctx.provider === 'google') {
      const r = await SK.translateUnitsGoogle(units, opts);
      return { ...r, pageUsage: { cacheHits: r.cacheHits || 0 } };
    }
    // 簡繁自動互轉的 rescan:新內容只走本地轉換(convertOnly 保證不打 API)
    if (ctx.provider === 'opencc-local') {
      return SK.translateUnits(units, {
        ...opts,
        convertDirection: ctx.convertDirection,
        convertOnly: true,
      });
    }
    // gemini / openai-compat 共用 SK.translateUnits,以 engine 欄位區分。
    return SK.translateUnits(units, {
      ...opts,
      engine: ctx.engine || undefined,
      modelOverride: ctx.modelOverride || undefined,
      glossary: ctx.glossary || undefined,
      // 混合頁首翻帶簡繁分流時,rescan 新內容延續同方向分流
      convertDirection: ctx.convertDirection || undefined,
    });
  };

  // SPA nav fallback(stickyTranslate=true 但 stickySlot=null)用:依首翻 provider 重新整頁翻譯。
  // 主要 cover 走 Opt+G (Google MT 無 slot) 或 autoTranslate 舊路徑的 SPA 換頁情境。
  SK.replayTranslateByProvider = function replayTranslateByProvider() {
    const ctx = STATE.translationContext;
    if (!ctx) return SK.translatePage();
    if (ctx.provider === 'google') return SK.translatePageGoogle();
    // 防禦:convertOnly run 不設 sticky,理論上不會走到這;若意外到達,維持免費承諾
    if (ctx.provider === 'opencc-local') return SK.translatePage({ convertOnly: true });
    return SK.translatePage({
      engine: ctx.engine || undefined,
      modelOverride: ctx.modelOverride || undefined,
    });
  };

  // ─── v1.4.0: Google Translate 翻譯整頁 ──────────────────────
  SK.translatePageGoogle = async function translatePageGoogle(gtOptions = {}) {
    // v1.4.12: gtOptions.slot 由 preset 快速鍵注入，供 STICKY_SET
    // v1.4.13: gtOptions.label 顯示於 loading toast
    const labelPrefix = gtOptions.label ? `[${gtOptions.label}] ` : '';
    // v2.0.79: 嵌入式播放器 frame 靜默結束（同 translatePage,見 issue #58）
    if (SK.isEmbeddedPlayerFrame?.(document, window)) {
      SK.sendLog('info', 'translate', 'embedded player frame, skip translate (google)', { url: location.href });
      return;
    }
    // 若同一引擎已翻譯 → 還原（toggle）
    // v1.8.7: ignorePartialMode 豁免，讓「翻譯剩餘段落」按鈕能在已翻譯狀態重觸發
    if (STATE.translated && STATE.translatedBy === 'google' && !gtOptions.ignorePartialMode) {
      restorePage();
      return;
    }
    if (STATE.translated && gtOptions.ignorePartialMode) {
      STATE.translated = false;
    }

    // 若正在翻譯中（任何引擎）→ 中止（立即還原原文，不等 in-flight 批次）
    // v1.10.20: controller 已 aborted = 上一輪取消收尾中 → 放行開新一輪（同 Gemini 路徑）
    if (STATE.translating) {
      if (STATE.abortController && !STATE.abortController.signal.aborted) {
        abortInProgressTranslation();
        return;
      }
    }

    // 若 Gemini 翻譯已完成 → 先還原，再用 Google 翻
    if (STATE.translated) {
      restorePage();
    }

    if (!navigator.onLine) {
      SK.showToast('error', SK.t('toast.offline'), { autoHideMs: 5000 });
      return;
    }

    // v1.10.20: run state 在第一個 await 之前同步設定（同 Gemini 路徑，防雙重進入）
    STATE.translating = true;
    const myAbortController = new AbortController();
    STATE.abortController = myAbortController;
    const abortSignal = myAbortController.signal;
    SK.safeSendMessage({ type: 'SET_BADGE_TRANSLATED' }).catch(() => {});

    // 繁中偵測（與 Gemini 相同邏輯）
    let settings = {};
    try { settings = await browser.storage.sync.get(null); } catch (_) {}
    // P1: 注入 STATE.targetLanguage(同 Gemini 路徑)
    const TARGET = (typeof settings.targetLanguage === 'string' && ['zh-TW','zh-CN','en','ja','ko','es','fr','de'].includes(settings.targetLanguage))
      ? settings.targetLanguage : 'zh-TW';
    STATE.targetLanguage = TARGET;
    // v1.9.26:整頁同 target skip 移除(同 Gemini 路徑,見上方註解)

    // v1.5.0: 顯示模式（與 Gemini 路徑相同邏輯）
    {
      const mode = settings.displayMode;
      STATE.translatedMode = (mode === 'dual') ? 'dual' : 'single';
      STATE.displayMode = STATE.translatedMode;
      const ms = settings.translationMarkStyle;
      SK.currentMarkStyle = (ms && SK.VALID_MARK_STYLES.has(ms)) ? ms : SK.DEFAULT_MARK_STYLE;
      SK.currentDualAccent = SK.sanitizeDualAccent?.(settings.dualAccentColor) ?? 'auto';
      if (STATE.translatedMode === 'dual') SK.ensureDualWrapperStyle?.();
    }

    const translateStartTime = Date.now();

    let units = SK.collectParagraphs();
    if (STATE.translatedMode === 'dual' && SK.consolidateDualInlineUnits) {
      units = SK.consolidateDualInlineUnits(units);
    }
    if (units.length === 0) {
      SK.showToast('error', SK.t('toast.noContent'), { autoHideMs: 3000 });
      SK.safeSendMessage({ type: 'CLEAR_BADGE' }).catch(() => {}); // 同 Gemini 路徑
      releaseRunState(myAbortController);
      return;
    }

    // v1.8.6: partialMode 啟用時跳過 prioritizeUnits 走 DOM 順序（同 translatePage Gemini 路徑）
    // v1.8.7: ignorePartialMode 豁免
    const pm = settings.partialMode;
    const pmActive = !gtOptions.ignorePartialMode
      && !!(pm && pm.enabled === true && Number.isFinite(pm.maxUnits) && pm.maxUnits >= 1);
    STATE.partialModeActive = pmActive;
    if (!pmActive) {
      // v1.7.1: 與 translatePage 同樣的優先級排序（內文核心優先）
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
    // v1.8.5/8.6: partialMode 啟用時 truncate（同 Gemini 路徑）
    if (pmActive && units.length > pm.maxUnits) {
      units = units.slice(0, pm.maxUnits);
    }
    const total = units.length;

    SK.showToast('loading', SK.t('toast.translateProgressGoogle', { prefix: labelPrefix, done: 0, total }), { progress: 0, startTimer: true });

    // v1.9.28:onProgress race guard,同 translatePage 修法
    let _progressClosed = false;

    try {
      const { done, failures, chars } = await SK.translateUnitsGoogle(units, {
        signal: abortSignal,
        onProgress: (d, t) => {
          if (_progressClosed) return;
          SK.showToast('loading', SK.t('toast.translateProgressGoogle', { prefix: labelPrefix, done: d, total: t }), {
            progress: d / t,
          });
        },
      });
      _progressClosed = true;

      if (abortSignal.aborted) {
        // v1.10.20: 同 Gemini 路徑——快速鍵取消已立即還原，unwind 不重複
        // v1.10.46: identity guard 同 Gemini 路徑——SPA reset 打斷後不得還原新頁
        if (!_earlyRestoredAborts.has(myAbortController) && STATE.abortController === myAbortController) {
          restoreOriginalHTMLAndReset();
          SK.showToast('success', SK.t('toast.cancelled'), { progress: 1, stopTimer: true, autoHideMs: 2000 });
        }
        return;
      }

      if (failures.length) {
        const failedSegs = failures.reduce((s, f) => s + f.count, 0);
        SK.showToast('error', SK.t('toast.partialFailed', { failed: failedSegs, total }), {
          stopTimer: true,
          detail: failures[0].error.slice(0, 120),
        });
      }

      // 全數批次失敗 → 不標 translated / 不 sticky / 不 rescan(同 Gemini 路徑)
      if (done === 0 && failures.length > 0) {
        SK.safeSendMessage({ type: 'CLEAR_BADGE' }).catch(() => {});
        return;
      }

      STATE.translated = true;
      // v2.0.73:同 Gemini 路徑,single mode 對齊 <html lang>
      if (STATE.translatedMode === 'single') SK.applyDocTargetLang?.();
      STATE.translatedBy = 'google';  // v1.4.0
      // 同 Gemini 路徑記錄 provider context 供 rescan / SPA nav replay。Google MT 無 model / glossary 參數。
      STATE.translationContext = { provider: 'google' };
      STATE.stickyTranslate = true;
      STATE.stickySlot = gtOptions.slot ?? null;  // v1.4.12
      // v1.4.11 跨 tab sticky（v1.4.12 改存 preset slot）：opener 鏈中新開的 tab 繼承同 slot
      if (gtOptions.slot != null) {
        SK.safeSendMessage({ type: 'STICKY_SET', payload: { slot: gtOptions.slot } }).catch(() => {});
      }

      if (!failures.length) {
        const successMsg = truncatedCount > 0
          ? SK.t('toast.googleDoneTruncated', { total, truncated: truncatedCount })
          : SK.t('toast.googleDone', { total });
        // v1.6.1: 同 Gemini 路徑 — 成功 toast 順帶顯示「有新版可下載」
        // v1.6.5: 同時帶 welcome notice
        const updateNotice = await SK.maybeBuildUpdateNotice();
        const welcomeNotice = await SK.maybeBuildWelcomeNotice();
        SK.showToast('success', successMsg, {
          progress: 1,
          stopTimer: true,
          detail: SK.t('toast.googleFreeDetail', { chars: chars.toLocaleString() }),
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
      _progressClosed = true;
      SK.sendLog('error', 'translate', 'translatePageGoogle error', { error: err.message || String(err) });
      if (!abortSignal.aborted) {
        SK.showToast('error', SK.t('toast.translateFailed', { error: err.message }), { stopTimer: true });
      }
      if (!STATE.translated) SK.safeSendMessage({ type: 'CLEAR_BADGE' }).catch(() => {});
    } finally {
      _progressClosed = true;
      releaseRunState(myAbortController);
    }
  };

  // ─── 編輯譯文模式 ────────────────────────────────────

  let editModeActive = false;

  // ─── 編輯模式浮動工具列（提示 + 復原 + 完成）─────────────
  // v2.0.66：進入編輯模式後頁面下方置中顯示深色工具列。「完成」= 結束編輯
  //（等同 popup 的「結束編輯」，不用重開 popup）；「復原」= 逐段撤銷——每個
  // 段落在本次編輯 session 內第一次被改動時（beforeinput，改動前）快照
  // innerHTML，按復原以 LIFO 順序整段還原。樣式走 closed Shadow DOM +
  // Constructable Stylesheet（CSP-safe，同 content-toast.js 的 v1.10.63 教訓）。
  let editBarHost = null;
  let editBarEls = null; // { bar, hint, undoBtn, doneBtn }
  const editPreEditHTML = new Map(); // el → 進入編輯後首次改動前的 innerHTML
  const editUndoOrder = [];          // 首次改動順序 stack（LIFO 復原）

  const EDIT_BAR_CSS = `
      :host, * { box-sizing: border-box; }
      .bar {
        position: fixed;
        /* 頁面下方置中；iOS Safari 加 home indicator 安全區位移 */
        bottom: calc(24px + env(safe-area-inset-bottom, 0px));
        left: 50%;
        transform: translateX(-50%);
        display: none;
        align-items: center;
        gap: 12px;
        max-width: calc(100vw - 32px);
        padding: 10px 12px 10px 16px;
        background: rgba(28, 33, 43, .96);
        color: #e8eaed;
        border-radius: 12px;
        box-shadow: 0 8px 28px rgba(0, 0, 0, .35);
        font: 14px -apple-system, 'PingFang TC', 'Microsoft JhengHei', sans-serif;
        white-space: nowrap;
      }
      .bar.show { display: flex; }
      .hint {
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .btn {
        cursor: pointer;
        font: inherit;
        font-weight: 600;
        border: none;
        border-radius: 8px;
        padding: 6px 14px;
        background: transparent;
        user-select: none;
        -webkit-user-select: none;
      }
      .btn-undo { color: #9aa0a6; }
      .btn-undo:not(:disabled):hover { color: #ffffff; background: rgba(255, 255, 255, .08); }
      .btn-undo:disabled { opacity: .45; cursor: default; }
      .btn-done { background: #2f6fed; color: #ffffff; }
      .btn-done:hover { background: #2861d4; }
  `;

  function ensureEditBar() {
    if (editBarEls) return editBarEls;
    editBarHost = document.createElement('div');
    editBarHost.id = 'shinkansen-edit-bar-host';
    editBarHost.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
    const shadow = editBarHost.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(EDIT_BAR_CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const styleEl = document.createElement('style');
      styleEl.textContent = EDIT_BAR_CSS;
      shadow.appendChild(styleEl);
    }
    const bar = document.createElement('div');
    bar.className = 'bar';
    const hint = document.createElement('span');
    hint.className = 'hint';
    const undoBtn = document.createElement('button');
    undoBtn.className = 'btn btn-undo';
    undoBtn.addEventListener('click', editBarUndo);
    const doneBtn = document.createElement('button');
    doneBtn.className = 'btn btn-done';
    doneBtn.addEventListener('click', () => toggleEditMode(false));
    bar.append(hint, undoBtn, doneBtn);
    shadow.appendChild(bar);
    editBarEls = { bar, hint, undoBtn, doneBtn };
    return editBarEls;
  }

  function updateEditBarUndoState() {
    if (editBarEls) editBarEls.undoBtn.disabled = editUndoOrder.length === 0;
  }

  function showEditBar() {
    const els = ensureEditBar();
    // 文字每次顯示時套用（UI 語言可能在 session 中切換）
    els.hint.textContent = SK.t('editbar.hint');
    els.undoBtn.textContent = SK.t('editbar.undo');
    els.doneBtn.textContent = SK.t('editbar.done');
    updateEditBarUndoState();
    if (!editBarHost.isConnected) {
      (document.body || document.documentElement).appendChild(editBarHost);
    }
    els.bar.classList.add('show');
  }

  function hideEditBar() {
    if (editBarEls) editBarEls.bar.classList.remove('show');
  }

  // 編輯模式貼上一律降為純文字(v2.0.71):瀏覽器 rich paste 會把來源的 inline
  // style(font-family / color 等 span)帶進譯文段,格式跟著「來源」走而非目標
  // 段落。純文字插入 = 繼承游標處樣式,格式主權留給頁面 CSS;代價是「複製既有
  // 斜體再貼」失去 inline 標記(編輯場景以文字修正為主,可接受)。
  // 與 translate-doc/index.js onPreviewEditablePaste 是同一份事實的雙實作
  //(content script IIFE vs ES module 隔離),改這裡必同步那邊。
  // execCommand 走瀏覽器原生插入(游標 / 選取取代 / undo stack 都對),且會觸發
  // beforeinput(insertText)→ onEditBeforeInput 快照照常運作
  function onEditPaste(e) {
    const t = e.target;
    const node = t && (t.nodeType === Node.ELEMENT_NODE ? t : t.parentElement);
    const el = node?.closest?.('[data-shinkansen-translated][contenteditable="true"]');
    if (!el) return;
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    // Chromium 對 execCommand 的改動不發 beforeinput——貼上是本段首次改動時,
    // 快照要在插入前自己補,復原(editBarUndo)才涵蓋純貼上的編輯
    snapshotEditEl(el);
    document.execCommand('insertText', false, text);
  }

  // 連結邊界補位(lib/edit-link-repair.js 共用模組):刪掉 <a> 內的字後緊接著
  // 打字,Chromium 會把新字插在連結外(邊界刻意設計)——事後把插入段搬回連結內。
  // 與 translate-doc/index.js EPUB 預覽編輯共用同一份實作。
  const editLinkRepair = window.__SKEditLinkRepair.createEditLinkRepair({
    isEditableHost: (el) => el.hasAttribute('data-shinkansen-translated'),
  });

  // 首次改動時快照該段落的原始譯文(beforeinput 路徑與 paste 路徑共用)
  function snapshotEditEl(el) {
    if (!el || editPreEditHTML.has(el)) return;
    editPreEditHTML.set(el, el.innerHTML);
    editUndoOrder.push(el);
    updateEditBarUndoState();
  }

  // beforeinput 在 DOM 改動「之前」發火——首次改動時快照該段落的原始譯文
  function onEditBeforeInput(e) {
    const t = e.target;
    if (!t || t.nodeType !== Node.ELEMENT_NODE) return;
    const el = t.closest?.('[data-shinkansen-translated][contenteditable="true"]');
    if (!el) return;
    snapshotEditEl(el);
    editLinkRepair.onBeforeInput(e);
  }

  function editBarUndo() {
    const el = editUndoOrder.pop();
    if (el && editPreEditHTML.has(el)) {
      if (el.isConnected) el.innerHTML = editPreEditHTML.get(el);
      editPreEditHTML.delete(el);
    }
    // innerHTML 整段還原後 pending anchor 已 detach,順手清補位狀態
    editLinkRepair.reset();
    updateEditBarUndoState();
  }

  function resetEditUndoStack() {
    editPreEditHTML.clear();
    editUndoOrder.length = 0;
    editLinkRepair.reset();
  }

  function toggleEditMode(forceState) {
    if (!STATE.translated && forceState !== false) {
      return { ok: false, error: 'translation not complete' };
    }
    const enable = typeof forceState === 'boolean' ? forceState : !editModeActive;
    const els = document.querySelectorAll('[data-shinkansen-translated]');
    // v2.0.77:零標記只擋「開啟」。關閉路徑必須永遠可走——SPA reset / framework
    // detach 把 marker 清光後,使用者仍要能結束編輯模式,否則 beforeinput / paste
    // listener 與 edit bar 永久殘留,editModeActive 卡 true 只能重載頁面。
    if (enable && els.length === 0) return { ok: false, error: 'no translated elements' };

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
          SK.refreshAncestorSavedHTML?.(el);
        }
      }
    }
    // v2.0.66: 浮動工具列 + 逐段復原 stack 隨編輯模式開關
    resetEditUndoStack();
    if (enable) {
      document.addEventListener('beforeinput', onEditBeforeInput, true);
      document.addEventListener('paste', onEditPaste, true);
      // 連結邊界補位:插入落地後(input / IME compositionend)修,游標明確移動
      //(pointerdown / 導航鍵)清意圖
      document.addEventListener('input', editLinkRepair.onInput, true);
      document.addEventListener('compositionend', editLinkRepair.onCompositionEnd, true);
      document.addEventListener('pointerdown', editLinkRepair.onPointerDown, true);
      document.addEventListener('keydown', editLinkRepair.onKeyDown, true);
      showEditBar();
    } else {
      document.removeEventListener('beforeinput', onEditBeforeInput, true);
      document.removeEventListener('paste', onEditPaste, true);
      document.removeEventListener('input', editLinkRepair.onInput, true);
      document.removeEventListener('compositionend', editLinkRepair.onCompositionEnd, true);
      document.removeEventListener('pointerdown', editLinkRepair.onPointerDown, true);
      document.removeEventListener('keydown', editLinkRepair.onKeyDown, true);
      hideEditBar();
    }
    editModeActive = enable;
    SK.sendLog('info', 'system', enable ? 'edit mode ON' : 'edit mode OFF', { elements: els.length });
    return { ok: true, editing: editModeActive, elements: els.length };
  }

  // v2.0.78（批次 3 B2）：給 content-spa.js resetForSpaNavigation 用的編輯模式收尾。
  // restorePage 有 `if (editModeActive) toggleEditMode(false)`，SPA 導航 reset 漏掉
  // （同一份事實雙 path drift）：編輯中點連結後殘存共用元素（header 等）的
  // contenteditable / shinkansen-editable 沒被清（innerHTML 還原不動元素自身 attribute）、
  // edit bar 續留、editModeActive 卡 true——後續 sticky 續翻時 collectParagraphs 排除
  // contenteditable 元素，那些段落永不再翻。idle 時零成本 no-op。
  SK.exitEditModeIfActive = function exitEditModeIfActive() {
    if (editModeActive) toggleEditMode(false);
  };

  // ─── 訊息接收 ────────────────────────────────────────

  // v1.4.12: 依 preset slot 觸發對應 engine + model 翻譯。
  // 行為：閒置 → 啟動對應 preset；翻譯中 → abort；已翻譯 → restorePage（任一 slot）。
  async function handleTranslatePreset(slot, opts = {}) {
    // opts.force（懸浮按鈕長按選單選引擎時帶）：直接用指定 preset 重新翻譯，而非 toggle 還原。
    // 一般入口（短按 / 快速鍵 / popup）維持 toggle 語意：已譯 → 還原。
    const force = opts.force === true;
    // v1.10.57: 翻譯中判斷必須在「已翻譯」之前 —— 已翻譯改以 DOM marker 為準
    // (SK.isPageTranslated),而翻譯途中譯文是逐段注入的,marker 會提前出現,
    // 若先判 isPageTranslated 會把「翻譯中按鍵取消」誤導成 restorePage。
    // 翻譯中：abort（立即還原原文，不等 in-flight 批次）
    // v1.10.20: controller 已 aborted = 上一輪取消收尾中 → 放行往下開新一輪
    // （translatePage / translatePageGoogle 入口會同步接管 run state）
    if (STATE.translating) {
      if (STATE.abortController && !STATE.abortController.signal.aborted) {
        abortInProgressTranslation();
        return;
      }
    }
    // 已翻譯（以 DOM 注入痕跡為準，不信 STATE.translated）：
    //   - 一般入口：任意 preset 觸發皆還原（toggle）
    //   - force（長按選單選引擎）：先還原既有譯文，再 fall through 用新 preset 重新翻譯，
    //     避免在已注入的譯文上再疊一層；換引擎=重譯，不是 toggle 回原文。
    if (SK.isPageTranslated()) {
      restorePage();
      if (!force) return;
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
      // v1.4.12: 舊訊息保留（popup 按鈕用），映射為 preset slot 2（同 Alt+S 主快速鍵；
      // 模型依 translatePresets slot 2 設定，v1.10.67 起預設 Flash Lite）
      handleTranslatePreset(2);
      return;
    }
    if (msg?.type === 'TOGGLE_EDIT_MODE') {
      sendResponse(toggleEditMode());
      return true;
    }
    if (msg?.type === 'GET_STATE') {
      // v1.10.57: popup / icon 顯示狀態以 DOM 注入痕跡為準,不信記憶體 STATE.translated
      // (SPA 子頁導航殘留 marker 時 STATE.translated 會說謊)。
      sendResponse({ ok: true, translated: SK.isPageTranslated(), editing: editModeActive });
      return true;
    }
    // 送到 Instapaper:擷取當前頁面完整 HTML（含已就地替換的譯文）。
    // popup 按鈕路徑與 Alt+I 快捷鍵（background onCommand）都透過此 action 拿 payload，
    // 再由 popup / background 做 OAuth 簽章 + fetch（content 不持有 consumer secret）。
    if (msg?.type === 'EXTRACT_PAGE_HTML') {
      // 只有最上層 frame 回應。content script 以 all_frames 注入,頁內嵌入的 youtube /
      // 廣告 iframe 也跑同一個 listener;browser.tabs.sendMessage 未指定 frameId 會廣播到
      // 所有 frame,某個 iframe（youtube 嵌入頁）先回應就會把「影片嵌入頁的文件」當主文
      // 送出 → Instapaper 存成影片（readtrung 實測:youtube-nocookie iframe frame 回了
      // 它自己的影片頁,347 字 = 影片標題,整篇文章被換掉）。非頂層 frame 不回應。
      if (window.top !== window) return false;
      try {
        sendResponse({ ok: true, ...SK.extractPageHtml(document) });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message });
      }
      return true;
    }
    // 送到 Instapaper 快捷鍵（Alt+I）路徑的回饋：background 做完 OAuth + fetch 後
    // broadcast 狀態，由 content 用 toast 顯示（快捷鍵無 popup，回饋走 content toast）。
    if (msg?.type === 'INSTAPAPER_TOAST') {
      const MAP = {
        sending:          { kind: 'loading', key: 'instapaper.sending' },
        summarizing:      { kind: 'loading', key: 'instapaper.summarizing' },
        sent:             { kind: 'success', key: 'instapaper.sent' },
        'not-enabled':    { kind: 'error',   key: 'instapaper.notEnabled' },
        'failed-auth':    { kind: 'error',   key: 'instapaper.failedAuth' },
        'failed-network': { kind: 'error',   key: 'instapaper.failedNetwork' },
        failed:           { kind: 'error',   key: 'instapaper.failed' },
      };
      const e = MAP[msg.status] || MAP.failed;
      try { SK.showToast(e.kind, SK.t(e.key), e.kind === 'loading' ? {} : { autoHideMs: 4000 }); } catch (_) {}
      return;
    }
    // v1.8.53: background CLEAR_CACHE 完成後 broadcast，清 YT in-memory 翻譯狀態
    // (popup「清除翻譯快取」按鈕走這條，bypass 了 Debug Bridge)。idempotent。
    if (msg?.type === 'YT_RESET_AFTER_CACHE_CLEAR') {
      try { SK.YT?._resetTranslationStateForCacheClear?.(); } catch (_) {}
      return;
    }
    // v1.5.0: 顯示模式切換通知。若已翻譯，提示使用者重新翻譯以套用。
    // 沒翻譯時不需提示——下次 translatePage 會自動讀新的 displayMode。
    if (msg?.type === 'MODE_CHANGED') {
      const mode = msg.mode === 'dual' ? 'dual' : 'single';
      if (STATE.translated) {
        // 批次 5-7d：desc 改走 dict（原硬編繁中，en 使用者會看到中文夾在英文模板裡）
        const desc = SK.t(mode === 'dual' ? 'popup.label.modeDual' : 'popup.label.modeSingle');
        SK.showToast('success', SK.t('toast.modeChanged', { desc }), {
          autoHideMs: 5000,
        });
      }
      return;
    }
    // 簡繁自動互轉 toggle(popup):勾選狀態直接決定當前頁動作——勾選立即對本頁跑
    // convertOnly(不適用頁面在 convertOnly 內靜默結束);取消勾選只在「本頁是本地
    // 轉換結果」(translatedBy 'opencc-local')時還原,不得動到 LLM 翻譯成果
    if (msg?.type === 'SET_AUTO_CONVERT_ZH') {
      const enabled = !!msg.payload?.enabled;
      if (enabled) {
        if (!STATE.translated && !STATE.translating) {
          SK.translatePage({ convertOnly: true }).catch(err => {
            SK.sendLog('warn', 'system', 'SET_AUTO_CONVERT_ZH convert failed', { error: err.message });
          });
        }
      } else if (STATE.translated && STATE.translatedBy === 'opencc-local') {
        restorePage();
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
    // v1.5.0: 雙語注入測試入口。可選 markStyle / dualAccentColor 覆蓋預設。
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
      // v1.8.52: 強調色入口（'auto' / token / hex；無覆蓋時保留前一輪設定或回 auto）
      if (opts && 'dualAccentColor' in opts) {
        SK.currentDualAccent = SK.sanitizeDualAccent?.(opts.dualAccentColor) ?? 'auto';
      } else if (!SK.currentDualAccent) {
        SK.currentDualAccent = 'auto';
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
    // v2.0.78（批次 3 B3）：暴露取消翻譯的立即還原 helper 給 spec 直接驅動
    //（快速鍵取消入口在 handleTranslatePreset 內層，spec 構造 in-flight 時序成本高）
    testAbortRestore() {
      restoreOriginalHTMLAndReset();
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
    // v2.0.66: 編輯模式浮動工具列 test hooks——bar 在 closed Shadow DOM 內，
    // spec 無法從 DOM 查詢，走這裡讀狀態 / 觸發按鈕等效行為
    testEditBarState() {
      return {
        hostConnected: !!(editBarHost && editBarHost.isConnected),
        visible: !!(editBarEls && editBarEls.bar.classList.contains('show')),
        hintText: editBarEls ? editBarEls.hint.textContent : null,
        undoDisabled: editBarEls ? editBarEls.undoBtn.disabled : null,
        undoStackSize: editUndoOrder.length,
      };
    },
    testEditBarUndo() {
      editBarUndo();
      return { undoStackSize: editUndoOrder.length };
    },
    testEditBarDone() {
      // 等同按下工具列「完成」
      return toggleEditMode(false);
    },
    // 連結邊界補位 test hook——spec 用 _setPending / _repair 模擬 IME 提交路徑
    //(Playwright 無法產生真實 composition 事件)
    testEditLinkRepair() {
      return editLinkRepair;
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

  SK.safeSendMessage({ type: 'CLEAR_BADGE' }).catch(() => {});

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
          // v1.8.16: source: 'auto' 防 reload 後跟 yt-navigate-finish 路徑 race
          //          （兩條鬧鐘都 fire，後到那條看 active 別誤觸 toggle stop)
          setTimeout(() => {
            SK.translateYouTubeSubtitles?.({ source: 'auto' }).catch(err => {
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
        await SK.safeSendMessage({ type: 'STICKY_CLEAR' }).catch(() => {});
        SK.sendLog('info', 'system', 'page reload, sticky cleared', { navType, url: location.href });
      } else {
        // v1.4.11 跨 tab sticky（v1.4.12 改傳 preset slot）：opener tab 的 preset 延用到此 tab
        const stickyResp = await SK.safeSendMessage({ type: 'STICKY_QUERY' }).catch(() => null);
        if (stickyResp?.shouldTranslate && stickyResp.slot != null) {
          SK.sendLog('info', 'system', 'sticky translate inherited from opener tab, triggering preset', { slot: stickyResp.slot, url: location.href });
          handleTranslatePreset(Number(stickyResp.slot));
          return;
        }
      }

      const { autoTranslate = false, autoTranslateSlot, autoConvertZh = false } = await browser.storage.sync.get(['autoTranslate', 'autoTranslateSlot', 'autoConvertZh']);
      if (autoTranslate && await SK.isDomainWhitelisted()) {
        // v1.6.13: 走指定 preset slot 而非裸 translatePage()，讓白名單行為跟使用者
        // 期待的「按下對應快速鍵」一致（走 preset.model 的 modelOverride)。
        // 沒設過 / 範圍外時 fallback slot 2，跟 v1.6.12 之前的行為等價。
        const n = Number(autoTranslateSlot);
        const slot = [1, 2, 3].includes(n) ? n : 2;
        SK.sendLog('info', 'system', 'domain in auto-translate list, translating on load', { url: location.href, slot });
        if (typeof SK.handleTranslatePreset === 'function') {
          SK.handleTranslatePreset(slot);
        } else {
          // 防禦性 fallback（理論上 SK.handleTranslatePreset 永遠在 content.js 內 export)
          SK.translatePage({ label: SK.t('toast.autoTranslateLabel') });
        }
        return; // 白名單完整翻譯是超集(簡繁段落在 translateUnits 內自動分流),不重複觸發
      }
      // 簡繁自動互轉:toggle 開啟時對可轉換頁自動本地轉換(免費,不打 API)。
      // 適用性判定在 translatePage convertOnly 路徑內——target 非中文變體或頁面
      // 無相反變體段落時靜默結束,不跳 toast 不留 badge
      if (autoConvertZh) {
        SK.sendLog('info', 'system', 'autoConvertZh on, trying local zh-convert on load', { url: location.href });
        SK.translatePage({ convertOnly: true });
      }
    } catch (err) {
      SK.sendLog('warn', 'system', 'auto-translate check failed on load', { error: err.message });
    }
  })();

})(window.__SK);
