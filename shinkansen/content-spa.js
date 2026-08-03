// content-spa.js — Shinkansen SPA 導航支援 + Content Guard
// 負責：SPA 導航偵測（History API 攔截 + URL 輪詢 + hashchange）、
// MutationObserver 動態段落偵測、Content Guard 週期性修復。

(function(SK) {
  if (!SK || SK.disabled) return;  // v1.5.2: iframe gate（見 content-ns.js）

  const STATE = SK.STATE;

  let spaLastUrl = location.href;
  let spaObserver = null;
  let spaObserverDebounceTimer = null;
  // maxWait timer:即使 mutation 連續來 idle timer 一直 reset,從第一次 arm 起算
  // 最多 SK.SPA_OBSERVER_MAX_WAIT_MS 強制 fire。避免使用者連續滑 virtualized
  // timeline(Twitter / Reddit / Threads)時譯文永遠出不來。
  let spaObserverMaxWaitTimer = null;
  let spaObserverRescanCount = 0;
  let contentGuardInterval = null;
  const GUARD_SWEEP_INTERVAL_MS = 1000;

  // v1.10.65: 外部暫停旗標——JRead 閱讀模式啟動時透過 'jread-reader-mode' CustomEvent
  // 叫 Shinkansen 暫停 content guard。為什麼需要:JRead 進閱讀模式會把被翻譯的
  // articleEl 重排成閱讀卡片,guard 每秒 sweep 會把它誤判成「譯文被 SPA 覆蓋」而重建
  // 子節點 → 使用者畫面每秒閃一下(只在 translate-first 後進閱讀模式才發生)。閱讀卡片
  // 就是 articleEl 本身、在 guard 管轄區內,JRead 端無法閃避,故由 guard 端在閱讀模式
  // 期間讓位。runContentGuard / onSpaObserverMutations 入口都 check 此旗標。
  // 退出閱讀模式時 JRead 送 active:false 恢復。SK.setContentGuardPaused 是唯一寫入點。
  // v2.0.57: 讓位範圍收斂——只停會重建子樹的 innerHTML / dual 軌與 mutation reconcile,
  // nv 軌(純 nodeValue 重套,不動結構不閃)在暫停期間保留 sweep(reapplyOnly);
  // 恢復時 setContentGuardPaused(false) 立即跑一次全量 nv reconcile 補課。
  // Why:閱讀模式期間 NYT React 對 figure 間歇 re-render 把圖說 text node 打回英文,
  // 整段早退讓 guard 全盲、退出後也接不回(2026-07-16 JRead 端 cage probe 診斷)。
  let contentGuardExternallyPaused = false;

  // v1.8.14: Guard sweep 改用 IntersectionObserver 維護「viewport 附近」的子集,
  // sweep 只走子集而非整份 STATE.translatedHTML。長文(Wikipedia 千段)從每秒
  // 1000 次字串相等比對 + 部分 rect 算降到通常 < 30 個 entry 的子集。
  let guardIntersectionObserver = null;
  let guardVisibleSet = null; // Set<Element>,IO callback 維護


  // ─── 重置翻譯狀態 ────────────────────────────────────

  function resetForSpaNavigation() {
    if (STATE.translating && STATE.abortController) {
      STATE.abortController.abort();
      STATE.translating = false;
      STATE.abortController = null;
    }
    SK.cancelRescan();
    // v1.10.46(批次 2-4):SPA 換頁時 abort in-flight 的 rescan 批次——舊頁 rescan 的
    // 晚到回應不得注入新頁(translateUnitsByProvider 統一掛的 rescan signal 在此失效)
    SK.abortRescanRuns?.();
    stopSpaObserver();
    // v1.10.57: SPA 子頁導航時站點常保留部分舊節點(header / nav / 共用區塊)。這些節點仍
    // 掛 marker + 顯示譯文,但下面馬上要 clear originalHTML/translatedHTML → 還原資料消失
    // → 孤兒譯文。隨後 sticky 續翻時 collectParagraphs 看到的是譯文(isAlreadyInTarget 全跳)
    // → 空翻 → STATE.translated 永遠回不來 → popup / icon 與畫面永久不一致(殭屍狀態,
    // 「已翻譯頁面點 url 延伸子孫 url」實測重現)。解法:clear 之前先把仍 connected 的注入
    // 節點還原回原文,讓續翻看到原文正常翻;已翻過的舊內容重翻走 cache hit(近乎零成本),
    // 只有子頁真新內容才打 API。single / dual / nodeValue mutate 三種注入痕跡都要清。
    let _spaStripped = 0;
    STATE.originalHTML.forEach((originalHTML, el) => {
      if (!el.isConnected) return;
      // AMO source review: originalHTML 來自本 extension 翻譯前自存的原始 DOM 字串,純還原用。
      el.innerHTML = originalHTML;
      el.removeAttribute('data-shinkansen-translated');
      SK.restoreLocaleStyling?.(el);
      _spaStripped++;
    });
    // dual wrapper(同時清 data-shinkansen-dual-source attribute)
    if (STATE.translatedMode === 'dual' || (STATE.translationCache && STATE.translationCache.size > 0)) {
      SK.removeDualWrappers?.();
    }
    // framework-managed nodeValue mutate:還原仍 connected 的 text node + 清 marker
    if (STATE.nodeValueMutateBackup && STATE.nodeValueMutateBackup.size > 0) {
      STATE.nodeValueMutateBackup.forEach((backup, el) => {
        backup.forEach(({ node, originalValue }) => {
          if (node && node.isConnected) { try { node.nodeValue = originalValue; } catch (_) {} }
        });
        try {
          el.removeAttribute('data-shinkansen-nodevalue-mutated');
          SK.restoreLocaleStyling?.(el);
        } catch (_) {}
      });
    }
    STATE.originalHTML.clear();
    STATE.translatedHTML.clear();
    STATE.translatedHTMLByText?.clear?.();
    STATE.originalText?.clear?.();
    STATE.translationCache?.clear?.();
    STATE.nodeValueMutateBackup?.clear?.();
    STATE.originalLang?.clear?.();
    STATE.originalFontFamily?.clear?.();
    SK.restoreDocLang?.();  // v2.0.73:SPA 換頁後新內容是原文,<html lang> 還原原值
    STATE.cache.clear();
    STATE.translated = false;
    STATE._glossaryPromise = null;
    SK.safeSendMessage({ type: 'CLEAR_BADGE' }).catch(() => {});
    SK.hideToast();
    SK.sendLog('info', 'spa', 'SPA navigation detected, state reset', { url: location.href, stickyTranslate: STATE.stickyTranslate, strippedConnected: _spaStripped });
  }

  // ─── 自動翻譯網站名單比對 ────────────────────────────

  SK.isDomainWhitelisted = async function isDomainWhitelisted() {
    try {
      const { domainRules } = await browser.storage.sync.get('domainRules');
      if (!domainRules?.whitelist?.length) return false;
      // 比對規則(含使用者貼整段網址時的正規化)統一走 lib/domain-utils.js 單一來源,
      // 讓 `https://stratechery.com/`、`stratechery.com/`、`stratechery.com` 三者等價。
      return window.__SKDomain.matchDomain(location.hostname, domainRules.whitelist);
    } catch (err) {
      SK.sendLog('warn', 'system', 'isDomainWhitelisted: failed to read storage', { error: err.message });
      return false;
    }
  };

  // ─── SPA 導航處理 ────────────────────────────────────

  // v2.0.66：純 hash 變動的「內容換掉了」判別門檻——settle 後原已翻譯元素
  // detach 比例 ≥ 此值視為視圖真的換掉（hash-router 導航），< 此值視為
  // in-page 錨點（內容沒換）。取 0.2：hash-router 換視圖 detach 的是主內容區
  // 的大宗翻譯單位，遠超 2 成；錨點場景則是 0。
  const SPA_HASH_NAV_DETACH_RATIO = 0.2;

  async function handleSpaNavigation() {
    const newUrl = location.href;
    if (newUrl === spaLastUrl) return;
    const prevUrl = spaLastUrl;
    spaLastUrl = newUrl;
    // v2.0.66：純 hash 變動（pathname + search 都沒變）需要二段判別——不能一律
    // 當導航，也不能一律跳過：
    //   - in-page anchor / TOC 跳轉 / 站方 selection-share 錨點（archive 類雙擊
    //     選字把選取範圍寫進 '#selection-…'；站方從 main world 呼叫 history API，
    //     isolated world 的 history patch 攔不到，由 hashchange / URL 輪詢撿到）：
    //     內容沒換，reset 會整頁還原譯文——編輯模式下段落是 contenteditable 被
    //     偵測層排除 → sticky 重翻抓到 0 段 → 整頁卡原文、無法編輯（2026-07-27
    //     archive 鏡像實測：雙擊選字 → 連續 6 次 state reset → translated=0）
    //   - hash-routing SPA（Gmail `#inbox` → `#inbox/<id>`）：視圖整個換掉，必須
    //     照舊 reset ＋ sticky 續翻（v1.0.23 既有行為，spa-sticky-translate /
    //     spa-url-polling jest 鎖定）
    // 判別器用「行為」不用 URL 形狀（§8）：等 SPA_NAV_SETTLE_MS 後看原本已翻譯的
    // 元素還剩多少 connected——幾乎全數健在（detach 比例 < 門檻）= 內容沒換 =
    // 錨點，跳過 reset；相當比例 detach = 視圖真的換掉 = 導航，落回 reset 流程。
    // 頁面沒有任何翻譯痕跡時不等待、直接當導航（自動翻譯白名單的 hash-router
    // 首翻不受影響）。search 有變仍一律視為導航（YouTube /watch?v=… 換片走 query）。
    try {
      const a = new URL(prevUrl);
      const b = new URL(newUrl);
      if (a.pathname === b.pathname && a.search === b.search) {
        const tracked = Array.from(document.querySelectorAll(
          '[data-shinkansen-translated], [data-shinkansen-dual-source]'));
        if (tracked.length > 0) {
          await new Promise(r => setTimeout(r, SK.SPA_NAV_SETTLE_MS));
          if (spaLastUrl !== newUrl) return; // 期間又有新導航，交給較新的那輪處理
          const detached = tracked.filter(el => !el.isConnected).length;
          if (detached / tracked.length < SPA_HASH_NAV_DETACH_RATIO) {
            SK.sendLog('info', 'spa', 'hash-only URL change with content intact, skipping SPA reset',
              { newUrl, oldUrl: prevUrl, tracked: tracked.length, detached });
            return;
          }
          SK.sendLog('info', 'spa', 'hash-only URL change with content swapped, treating as navigation',
            { newUrl, oldUrl: prevUrl, tracked: tracked.length, detached });
        }
      }
    } catch (_) { /* URL 解析失敗（理論上不會）→ 照舊當導航處理 */ }
    const wasSticky = STATE.stickyTranslate;
    const prevSlot = STATE.stickySlot;  // v1.4.12: 記錄續翻用的 preset slot
    resetForSpaNavigation();

    await new Promise(r => setTimeout(r, SK.SPA_NAV_SETTLE_MS));

    if (wasSticky) {
      // v1.4.12: 上次若由 preset 快速鍵觸發就按同 slot 續翻，保留 engine+model；
      // 舊路徑（例如 autoTranslate 白名單）stickySlot 為 null，fallback 舊行為
      if (prevSlot != null && typeof SK.handleTranslatePreset === 'function') {
        SK.sendLog('info', 'spa', 'SPA nav: sticky translate active, re-triggering preset', { url: location.href, slot: prevSlot });
        SK.handleTranslatePreset(prevSlot);
      } else {
        // stickySlot=null 路徑(Opt+G 走 Google MT、autoTranslate 舊路徑)依 translationContext replay
        // 對應 provider,不再硬走 Gemini。translationContext 在 resetForSpaNavigation 故意不清。
        SK.sendLog('info', 'spa', 'SPA nav: sticky translate active, replay by provider (no preset slot)', { url: location.href, provider: STATE.translationContext?.provider || null });
        if (typeof SK.replayTranslateByProvider === 'function') {
          SK.replayTranslateByProvider();
        } else {
          SK.translatePage();
        }
      }
      return;
    }

    try {
      const { autoTranslate = false, autoTranslateSlot, autoConvertZh = false } = await browser.storage.sync.get(['autoTranslate', 'autoTranslateSlot', 'autoConvertZh']);
      if (autoTranslate && await SK.isDomainWhitelisted()) {
        // v1.6.13: 走指定 preset slot,讓 SPA 導航的白名單觸發跟使用者期待的快速鍵一致。
        const n = Number(autoTranslateSlot);
        const slot = [1, 2, 3].includes(n) ? n : 2;
        SK.sendLog('info', 'spa', 'SPA nav: domain in auto-translate list, translating', { url: location.href, slot });
        if (typeof SK.handleTranslatePreset === 'function') {
          SK.handleTranslatePreset(slot);
        } else {
          SK.translatePage();
        }
        return;
      }
      // 簡繁自動互轉:SPA 導航後對新頁重跑本地轉換檢查(與初載路徑同語意;
      // 不適用頁在 convertOnly 內靜默結束)
      if (autoConvertZh) {
        SK.sendLog('info', 'spa', 'SPA nav: autoConvertZh on, trying local zh-convert', { url: location.href });
        SK.translatePage({ convertOnly: true });
        return;
      }
    } catch (err) {
      SK.sendLog('warn', 'spa', 'SPA nav: auto-translate list check failed', { error: err.message });
    }
  }

  // ─── History API 攔截 ─────────────────────────────────
  // 防止 content script 重複執行時（例如 extension reload）產生雙層 patch，
  // 導致 _origPushState 指向已被 patch 的版本，形成循環呼叫。

  if (!history.pushState.__sk_patched) {
    const _origPushState = history.pushState.bind(history);
    const _origReplaceState = history.replaceState.bind(history);

    history.pushState = function (...args) {
      _origPushState(...args);
      handleSpaNavigation();
    };
    // v1.8.20: replaceState 在 pathname 變動時也視為 SPA navigation。
    // React Router shallow routing、Notion、Twitter/X 部分路徑用 replaceState 換內容,
    // 原版只更新 spaLastUrl 不 reset → 新內容用舊 STATE 跑,新段落不會被翻。
    // 純 query string / hash 變動(pathname 不變)維持只更 lastUrl 不 reset 的行為。
    history.replaceState = function (...args) {
      const oldPath = location.pathname;
      _origReplaceState(...args);
      spaLastUrl = location.href;
      if (location.pathname !== oldPath) {
        handleSpaNavigation();
      }
    };
    history.pushState.__sk_patched = true;
  }
  window.addEventListener('popstate', () => handleSpaNavigation());
  window.addEventListener('hashchange', () => handleSpaNavigation());

  // ─── URL 輪詢（SPA 導航 safety net） ─────────────────

  const SPA_URL_POLL_MS = 500;
  let spaUrlPollTimer = setInterval(() => {
    // v1.10.39(code review 2026-06-09 M1):本 interval 是模組唯一沒被 stopSpaObserver
    // 收斂的週期工作。orphan content script(extension reload / 更新後舊腳本還活著)時
    // context 失效,輪詢仍每 500ms 跑(handleSpaNavigation 內 storage / sendMessage 雖被
    // try/catch 接住,但 timer 本身空轉耗電)。偵測到 context 失效就自我清除。
    // 偵測法鏡像 content-ns.js safeSendMessage 的 orphan 判斷(chrome.runtime.id 失效變 undefined)。
    if (!globalThis.chrome?.runtime?.id) {
      clearInterval(spaUrlPollTimer);
      spaUrlPollTimer = null;
      return;
    }
    // v1.6.10: 分頁隱藏時跳過 URL 輪詢——背景分頁不會由使用者觸發導航,
    // pushState patch + popstate + hashchange 三條 listener 仍活躍,真正
    // 主動觸發的 SPA 導航不會漏接。輪詢只是萬一上述 patch 沒套到的 safety
    // net,在隱藏分頁完全無作用,純消耗 CPU。從 visible 切回時的 catch-up
    // 由下方 visibilitychange listener 補一次。
    if (document.hidden) return;
    if (location.href !== spaLastUrl) {
      if (STATE.translated && !STATE.stickyTranslate && document.querySelector('[data-shinkansen-translated]')) {
        SK.sendLog('info', 'spa', 'URL changed while translated content present — scroll-based update, skipping reset', { newUrl: location.href, oldUrl: spaLastUrl });
        spaLastUrl = location.href;
        return;
      }
      handleSpaNavigation();
    }
  }, SPA_URL_POLL_MS);

  // v1.6.10: 分頁從隱藏切回可見時補一次 URL 同步——萬一 hidden 期間頁面
  // 透過 setTimeout 觸發 pushState 而 monkey-patch 因時序未生效（極端情境）,
  // 切回前景時這次 catch-up 會抓到 URL 變化並走 handleSpaNavigation。
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && location.href !== spaLastUrl) {
      handleSpaNavigation();
    }
  });

  // ─── MutationObserver（動態段落偵測） ─────────────────

  // v1.2.1: 記錄在此 SPA session 內已翻譯過的文字,避免 widget 週期性重設 DOM 造成無限循環。
  // 改成 Map<text, lastSeenMs> + TTL,從「永久鎖」變「冷卻鎖」:
  //   - TTL 內(1.5 秒)的同段原文視為已 seen → SPA rescan skip(防 widget 高頻 burst,
  //     例如某些 SPA 每秒重設 DOM)
  //   - 超過 TTL 再次出現 → 允許重 inject(典型場景:YouTube hover description 觸發
  //     yt-attributed-string re-render 把譯文抹回原文,使用者下次 hover 應該重看到中文)
  // SPA rescan 走 cache lookup 路徑,同段原文翻過一次後 cache 永遠 hit,後續 inject 0 API
  // 成本,即使 TTL 過期重 inject 也不會爆 cost。
  // v1.9.8: 1500 → 30000(30 秒)。原 1.5s 是給 YouTube hover description 短時間
  // 重 render 場景設,但 X / Reddit / Threads / Mastodon 等虛擬化 timeline scroll
  // 上下間隔常常 > 1.5s,過期後同段 fragment 推文(by-text reuse 不收 fragment)被
  // 當「新 unit」反覆進 translateUnitsByProvider → 偶有 cache miss(virtualization
  // mount/unmount 後序列化結果微差)→ 真打 API + success toast 干擾。
  // YouTube hover 場景 30s 內 byText cache 已存,inject 路徑直接 reuse 不依賴 seen-text,
  // 行為不變。中期方案是讓 fragment unit 也走 by-text reuse(SPEC-PRIVATE 記)。
  const SPA_OBSERVER_SEEN_TEXTS_TTL_MS = 30_000;
  const spaObserverSeenTexts = new Map();
  function isSeenTextRecent(text) {
    const ts = spaObserverSeenTexts.get(text);
    if (ts == null) return false;
    if (Date.now() - ts > SPA_OBSERVER_SEEN_TEXTS_TTL_MS) {
      spaObserverSeenTexts.delete(text); // 過期 entry 順手 GC,Map 不會無止盡長
      return false;
    }
    return true;
  }
  // 給 spec 用
  SK._spaObserverSeenTexts = spaObserverSeenTexts;
  SK._isSeenTextRecent = isSeenTextRecent;
  SK._SPA_OBSERVER_SEEN_TEXTS_TTL_MS = SPA_OBSERVER_SEEN_TEXTS_TTL_MS;

  // Debug Bridge 用:暴露 SPA observer 內部狀態以判斷 rescan 是否 fire / 為何 silent
  SK._spaDebug = function _spaDebug() {
    return {
      observerActive: !!spaObserver,
      debounceArmed: !!spaObserverDebounceTimer,
      maxWaitArmed: !!spaObserverMaxWaitTimer,
      rescanCount: spaObserverRescanCount,
      seenTextsSize: spaObserverSeenTexts.size,
      contentGuardActive: !!contentGuardInterval,
      contentGuardExternallyPaused: contentGuardExternallyPaused, // v1.10.65: JRead 閱讀模式期間 true
      guardVisibleSetSize: guardVisibleSet ? guardVisibleSet.size : null,
      stateTranslated: STATE.translated,
      stateTranslating: STATE.translating,
      stickyTranslate: STATE.stickyTranslate,
      partialModeActive: STATE.partialModeActive,
      mutationBatchesSeen: _dbgMutationBatchesSeen,
      hasNewContentTrueCount: _dbgHasNewContentTrueCount,
      debounceArmedCount: _dbgDebounceArmedCount,
      earlyReturnNotTranslated: _dbgEarlyReturnNotTranslated,
      earlyReturnMaxRescans: _dbgEarlyReturnMaxRescans,
    };
  };

  // v1.10.65: 外部（JRead 閱讀模式）暫停 / 恢復 content guard 的唯一寫入點。
  // paused=true:runContentGuard / onSpaObserverMutations 入口讓位（早退），停止把
  // JRead 重排的 articleEl 誤判成「譯文被覆蓋」而每秒重建 → 消除畫面每秒閃動。
  // 不停 interval / 不 stopSpaObserver（恢復後無需重建、立即接續）。idempotent。
  SK.setContentGuardPaused = function setContentGuardPaused(paused) {
    const wasPaused = contentGuardExternallyPaused;
    contentGuardExternallyPaused = !!paused;
    SK.sendLog('info', 'spa', 'content guard ' + (contentGuardExternallyPaused ? 'paused' : 'resumed') + ' (JRead reader mode)');
    // v2.0.57(洞 2): unpause 補課——盲窗/暫停期間發生的 nv-mutate 回退,恢復當下
    // 立即跑一次全量 reconcile(ignoreViewport=true,不等 viewport / 下一次 1s sweep)。
    // 洞 1 的暫停期 nv sweep(reapplyOnly)已涵蓋大多數,這條是雙保險,同時接住
    // reapplyOnly 刻意跳過的「內容已變」entry(此處走完整版,可 unmark+rescan)。
    // 編輯模式 contenteditable 豁免在 runContentGuardNvMutate 迴圈內,不會被打破。
    if (wasPaused && !contentGuardExternallyPaused && STATE.translated
        && STATE.translatedMode !== 'dual') {
      try { runContentGuardNvMutate(true); } catch (_) {}
    }
  };

  // mousedown capture: framework 的 click handler 跑之前先把 nodeValue mutate
  // 的 text node 還原為英文原文。React reconciliation 用 fiber 跟 DOM diff 決定要
  // 更新什麼；nodeValue mutate 把 DOM text 改成中文,fiber 仍記「截斷英文」→
  // reconcile 算出錯誤的 diff → 展開後中間段落消失。在 mousedown(早於 click)
  // 還原,React 看到正確 DOM,reconcile 結果正確。還原後 SPA rescan 會重新翻譯。
  let _preClickListenerAdded = false;
  function addPreClickRestore() {
    if (_preClickListenerAdded) return;
    if (typeof window === 'undefined') return;
    _preClickListenerAdded = true;
    window.addEventListener('mousedown', (e) => {
      if (!STATE.nodeValueMutateBackup || STATE.nodeValueMutateBackup.size === 0) return;
      const target = e.target;
      if (!target || target.nodeType !== Node.ELEMENT_NODE) return;
      const nvEl = target.closest?.('[data-shinkansen-nodevalue-mutated]');
      if (!nvEl) return;
      const backup = STATE.nodeValueMutateBackup.get(nvEl);
      if (!backup) return;
      for (const entry of backup) {
        if (entry?.node?.isConnected && typeof entry.originalValue === 'string') {
          entry.node.nodeValue = entry.originalValue;
        }
      }
      nvEl.removeAttribute('data-shinkansen-nodevalue-mutated');
      nvEl.removeAttribute('data-shinkansen-translated');
      STATE.nodeValueMutateBackup.delete(nvEl);
      STATE.originalText.delete(nvEl);
      STATE.originalHTML?.delete?.(nvEl);
      // 清 seenTexts entry（還原後 innerText 是英文原文）讓後續 rescan 能重翻
      const _restoredText = (nvEl.innerText || '').trim();
      if (_restoredText) spaObserverSeenTexts.delete(_restoredText);
      SK.sendLog?.('info', 'spa', 'pre-click restore: nodeValue mutate backup restored for click target');
      // 主動排程 rescan：pre-click restore 清掉所有 STATE 後 nodeValue mutate
      // 元素完全失去 Content Guard 保護（不在 STATE.translatedHTML），且 React
      // 的 click re-render 不一定產出 childList mutations 觸發 hasNewContent。
      // 500ms 讓 React commit phase 完成後再 rescan + re-translate。
      setTimeout(() => {
        if (!STATE.translated) return;
        triggerSpaObserverRescan();
      }, 500);
    }, { capture: true, passive: true });
  }

  SK.startSpaObserver = function startSpaObserver() {
    if (spaObserver) return;
    spaObserverRescanCount = 0;
    spaObserverSeenTexts.clear();
    addPreClickRestore();
    spaObserver = new MutationObserver(onSpaObserverMutations);
    // v1.9.27: 加 characterData 監聽,讓 framework 用 textNode.replaceData() partial
    // update text node 的場景(X 推文點「顯示更多」→ React 改 tweetText 子 text node
    // nodeValue,**不** fire childList)能被 dual-aware detect 捕捉,觸發重翻新展開
    // 內容。原 config 只 childList,完全錯過此場景。
    spaObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    if (!contentGuardInterval) {
      contentGuardInterval = setInterval(runContentGuard, GUARD_SWEEP_INTERVAL_MS);
    }
    initGuardIntersectionObserver();
    // v1.9.28 Layer 14:host 命中 PRESCAN_HOSTS 就啟動 IntersectionObserver pre-scan,
    // 跟 SPA observer 共存(SPA observer 處理 selector 抓不到的 link card / OG preview
    // 等 fallback,prescan 處理 viewport 即將進入的命中 selector 元素)。
    startPrescanObserver();
    SK.sendLog('info', 'spa', 'SPA observer started');
  };

  // v1.8.14: 把 STATE.translatedHTML 與 STATE.translationCache 的元素全部 observe,
  // IO callback 維護 guardVisibleSet,sweep 用該 set 做 subset。
  function initGuardIntersectionObserver() {
    if (guardIntersectionObserver) return;
    if (typeof IntersectionObserver === 'undefined') return; // Safari 舊版 fallback
    guardVisibleSet = new Set();
    guardIntersectionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) guardVisibleSet.add(entry.target);
        else guardVisibleSet.delete(entry.target);
      }
    }, { rootMargin: '500px' }); // 與舊 rect.bottom < -500 / top > innerHeight + 500 對齊

    if (STATE.translatedHTML) {
      for (const el of STATE.translatedHTML.keys()) {
        if (el.isConnected) guardIntersectionObserver.observe(el);
      }
    }
    if (STATE.translationCache) {
      for (const el of STATE.translationCache.keys()) {
        if (el && el.isConnected) guardIntersectionObserver.observe(el);
      }
    }
  }
  SK.initGuardIntersectionObserver = initGuardIntersectionObserver;

  function teardownGuardIntersectionObserver() {
    if (guardIntersectionObserver) {
      guardIntersectionObserver.disconnect();
      guardIntersectionObserver = null;
    }
    guardVisibleSet = null;
  }

  // ─── v1.9.28 Layer 14:IntersectionObserver pre-scan ────
  //
  // 對 PRESCAN_HOSTS 命中的 host(X / Twitter)觀察 selector(`[data-testid="tweetText"]
  // :not([data-shinkansen-translated])`)元素 → 元素「即將進 viewport(rootMargin 1000px)」
  // 時觸發 `triggerSpaObserverRescan`,跳過 SPA observer 1s debounce + 2s maxWait 時序鏈。
  //
  // Why:SPEC-PRIVATE §25.20 Finding 3 stall 100% × 5/5(sy=10465「I love your works ❤」
  // 推文 user dwell window 內永遠沒翻完)。v1.9.27 兩次嘗試(Phase 5 debounce 250 / maxWait
  // 500)都沒解。POC 數據(SPEC-PRIVATE §25.20.10)實測 IO `rootMargin:1000px` fire 比
  // user dwell on 該 tweet 早約 3.3s,API 1.5-2s 內 inject 完成。
  //
  // 走同條 `spaObserverRescan` 主體:by-text reuse / seen-texts TTL / tiny silent /
  // 800ms loading delay 全 inherit,不另開 pipeline。
  //
  // 不會回到 §25.20.5 over-fire:IO 只看 selector 命中元素 + unobserve 一次性 fire,
  // POC 實測 19+ tweet 收進約 10 個 callback(瀏覽器原生合成 + 100ms 微 batch)。
  let prescanIO = null;
  let prescanMO = null;
  let prescanScheduledTimer = null;
  let _dbgPrescanFires = 0;
  let _dbgPrescanScheduled = 0;
  let _dbgPrescanObserved = 0;

  function schedulePrescanRescan() {
    if (prescanScheduledTimer) return; // 100ms 微 batch window 內合成
    _dbgPrescanScheduled++;
    prescanScheduledTimer = setTimeout(() => {
      prescanScheduledTimer = null;
      if (!STATE.translated) return;
      SK.sendLog?.('info', 'spa', 'prescan IO triggered rescan');
      // 重用既有 triggerSpaObserverRescan:disarm SPA observer 兩條 timer + reset idle gate
      // + 跑 spaObserverRescan(by-text reuse / seen-texts TTL / tiny silent / 800ms 全套)
      triggerSpaObserverRescan();
    }, SK.PRESCAN_BATCH_WINDOW_MS || 100);
  }

  function startPrescanObserver() {
    if (prescanIO) return; // already running
    if (typeof IntersectionObserver === 'undefined') return; // Safari 舊版 fallback
    const config = typeof SK.getPrescanConfig === 'function' ? SK.getPrescanConfig() : null;
    if (!config) return; // host 沒命中,不啟動
    _dbgPrescanFires = 0;
    _dbgPrescanScheduled = 0;
    _dbgPrescanObserved = 0;

    prescanIO = new IntersectionObserver((entries) => {
      let fired = false;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        // 一次性:fire 後 unobserve,避免 unmount/remount 重 fire。
        // 同 element 若被 X virtualization unmount + remount(全新 element)會走
        // prescanMO 路徑重 observe + 重 fire 一次,by-text reuse 攔 cache hit 不重打 API。
        try { prescanIO.unobserve(e.target); } catch (_) {}
        // v1.9.28 候選 第二輪 B:從 seenTexts 30s TTL 名單豁免該 tweet,讓後續
        // schedulePrescanRescan → spaObserverRescan → collectParagraphs 收到該
        // tweet 後不被 isSeenTextRecent filter 擋。
        // Why:SPA observer 第一輪 rescan 對該 tweet 已 markSeen(防 widget 高頻
        // 重 inject),30s 內後續 rescan 看到該 tweet 直接 filter 掉。對 X 串尾
        // 「I love your works」場景:第一輪 SPA rescan 走 mutation debounce 慢
        // 一拍,user dwell window 過了沒翻完。後續 prescan IO trigger 的 rescan
        // 看到該 tweet 在 seenTexts 內,被 filter 掉 → 永遠補不上。explicit
        // delete 讓 prescan 路徑「重啟翻譯資格」。
        try {
          const text = (e.target?.innerText || '').trim();
          if (text) spaObserverSeenTexts.delete(text);
        } catch (_) {}
        _dbgPrescanFires++;
        fired = true;
      }
      if (fired) schedulePrescanRescan();
    }, { rootMargin: config.rootMargin || '1000px' });

    // 初始 register:頁面載入時已 mount 的命中元素
    try {
      const initial = document.querySelectorAll(config.selector);
      for (const el of initial) {
        prescanIO.observe(el);
        _dbgPrescanObserved++;
      }
    } catch (_) { /* selector 解析失敗 → 不啟動 MO,prescan 形同 no-op */ }

    // MO 攔 X virtualization 後續 mount:tweet 進 DOM 時加 io.observe()。
    // 走 selector match 過濾,避免每 mutation 都檢查;:not([data-shinkansen-translated])
    // 排除已翻段(常見 v1.9.27 _detectAndUnmarkExpandedNodeValueMutate 重 mark 路徑)。
    prescanMO = new MutationObserver((muts) => {
      if (!prescanIO) return;
      for (const m of muts) {
        if (m.type !== 'childList') continue;
        for (const n of m.addedNodes) {
          if (!n || n.nodeType !== 1) continue;
          let matches;
          try {
            matches = n.matches?.(config.selector)
              ? [n]
              : (n.querySelectorAll ? n.querySelectorAll(config.selector) : []);
          } catch (_) { continue; }
          for (const t of matches) {
            try { prescanIO.observe(t); _dbgPrescanObserved++; } catch (_) {}
          }
        }
      }
    });
    prescanMO.observe(document.body, { childList: true, subtree: true });

    SK.sendLog?.('info', 'spa', 'prescan IO started', { host: config.host, initial: _dbgPrescanObserved });
  }

  function stopPrescanObserver() {
    if (prescanIO) { try { prescanIO.disconnect(); } catch (_) {} prescanIO = null; }
    if (prescanMO) { try { prescanMO.disconnect(); } catch (_) {} prescanMO = null; }
    if (prescanScheduledTimer) { clearTimeout(prescanScheduledTimer); prescanScheduledTimer = null; }
  }

  // 給 spec / Debug Bridge 用
  SK._prescanDebug = function _prescanDebug() {
    return {
      active: !!prescanIO,
      observed: _dbgPrescanObserved,
      fires: _dbgPrescanFires,
      scheduled: _dbgPrescanScheduled,
      scheduledTimerArmed: !!prescanScheduledTimer,
    };
  };
  SK._startPrescanObserver = startPrescanObserver;
  SK._stopPrescanObserver = stopPrescanObserver;

  // SPA virtualization 對抗:inject 完成同步把 originalText → savedHTML 寫進 STATE.translatedHTMLByText,
  // 之後 SPA observer rescan 看到 textContent 命中此 cache 的「全新 element」,直接 inject 既有譯文,
  // 不送 API、不重翻、譯文一致(典型場景:Twitter / Reddit / Threads / Mastodon virtualized timeline
  // 滑出 viewport 後使用者滑回頂,React unmount 原 element + 重 mount 全新 element)。
  SK._recordTranslatedByText = function _recordTranslatedByText(el, savedHTML) {
    if (!STATE.translatedHTMLByText) return;
    if (!el || !savedHTML) return;
    const orig = STATE.originalText && STATE.originalText.get(el);
    if (!orig) return;
    STATE.translatedHTMLByText.set(orig, savedHTML);
  };

  // SPA observer rescan 收進的 newUnits 預檢:對 element unit 用 textContent 查 byText cache,
  // 命中 → reuse 既有譯文 inject + 加 attribute + 補 STATE.translatedHTML,從 newUnits 移除。
  // fragment unit 暫不適用(by-text key 對應 fragment 文字而非 el.textContent,
  // fragment inject 路徑替換 startNode→endNode 區間不是整個 innerHTML,reuse 邏輯複雜)。
  // 暴露給 spec 跟 spaObserverRescan 共用。
  SK.spaByTextReuse = function spaByTextReuse(units) {
    const reused = [];
    const remaining = [];
    if (!STATE.translatedHTMLByText || STATE.translatedHTMLByText.size === 0) {
      return { reused, remaining: units.slice() };
    }
    for (const unit of units) {
      if (unit.kind !== 'element' || !unit.el || !unit.el.isConnected) {
        remaining.push(unit);
        continue;
      }
      if (unit.el.hasAttribute('data-shinkansen-translated')) {
        // 已被別的 path inject 過(防同 batch 內重複)— 不收進 reused 也不送 newUnits
        continue;
      }
      const text = (unit.el.textContent || '').trim();
      const savedHTML = STATE.translatedHTMLByText.get(text);
      if (!savedHTML) { remaining.push(unit); continue; }
      try {
        // 覆寫前先快照原文——此刻 el 顯示的正是 remount 後的原文。少這步的話
        // restorePage / resetForSpaNavigation 都以 STATE.originalHTML 為迭代源，
        // reuse 注入的元素不在其中 → 按還原後殘留殭屍譯文段
        SK.snapshotOnce?.(unit.el);
        // AMO source review: savedHTML 來自 STATE.translatedHTMLByText(本 extension 自存
        // 的 inject 後 innerHTML),無 user input 流入。see BUILD.md §innerHTML
        unit.el.innerHTML = savedHTML;
        unit.el.setAttribute('data-shinkansen-translated', '1');
        STATE.translatedHTML.set(unit.el, savedHTML);
        STATE.originalText?.set?.(unit.el, text);
        SK._guardObserveEl?.(unit.el);
        reused.push(unit);
      } catch (_) {
        // innerHTML write 失敗(罕見,例如 contenteditable 父限制)→ 丟回 remaining 走正常翻譯
        remaining.push(unit);
      }
    }
    return { reused, remaining };
  };

  // v1.8.20: injection 路徑寫入 STATE 後呼叫此 hook,把新元素加進 IO 訂閱。
  // 修 v1.8.14 IO subset 設計缺口:`initGuardIntersectionObserver` 只 observe 啟動快照,
  // 後續 SPA rescan 翻新一批的譯段從未進 `guardVisibleSet` → guard sweep(走 IO subset)
  // 對它們完全失效。
  SK._guardObserveEl = function _guardObserveEl(el) {
    if (!el) return;
    if (!guardIntersectionObserver) return; // observer 未啟動(尚未進 SPA 觀察狀態)
    if (!el.isConnected) return;
    try { guardIntersectionObserver.observe(el); } catch (_) { /* el 可能不是 Element */ }
  };


  function stopSpaObserver() {
    if (spaObserverDebounceTimer) {
      clearTimeout(spaObserverDebounceTimer);
      spaObserverDebounceTimer = null;
    }
    if (spaObserverMaxWaitTimer) {
      clearTimeout(spaObserverMaxWaitTimer);
      spaObserverMaxWaitTimer = null;
    }
    if (contentGuardInterval) {
      clearInterval(contentGuardInterval);
      contentGuardInterval = null;
    }
    if (spaObserver) {
      spaObserver.disconnect();
      spaObserver = null;
    }
    teardownGuardIntersectionObserver();
    stopPrescanObserver();
    spaObserverRescanCount = 0;
    spaObserverSeenTexts.clear();
  }
  SK.stopSpaObserver = stopSpaObserver;

  // ─── Content Guard ────────────────────────────────────

  function runContentGuard() {
    if (!STATE.translated) return;
    // v1.6.10: 分頁隱藏時跳過——使用者看不到的內容無需即時修復,且 sweep
    // 每秒一次,每個 entry 都呼叫 getBoundingClientRect 強制 layout,長頁
    // (上百 entry) 在背景分頁是純浪費 CPU + 電力。切回前景時下一次 sweep
    // 在 1 秒內就會修復,使用者無感知差異。
    if (document.hidden) return;
    // v2.0.57(洞 1): JRead 閱讀模式讓位從「整段早退」改成「只停 innerHTML / dual 軌,
    // 保留 nv 軌」。v1.10.65 要防的每秒閃動來源是 innerHTML / dual 軌把 JRead 重排
    // 誤判成「譯文被覆蓋」而重建子樹;nv 軌(runContentGuardNvMutate)是純 text node
    // nodeValue 重套、不動元素結構,不會閃。整段早退會讓「閱讀模式期間 framework 把
    // 譯文打回原文」(NYT React figcaption 實測)進入盲窗、英文一直掛在畫面上。
    // reapplyOnly=true:暫停期間只做零 API 的原地重套,不走 unmark+rescan(rescan 是
    // 完整 inject pipeline、會動結構);內容已變的 entry 留給 resume 補課
    // (setContentGuardPaused(false) 的全量 reconcile)。
    if (contentGuardExternallyPaused) {
      if (STATE.translatedMode !== 'dual') runContentGuardNvMutate(false, true);
      return;
    }
    // v1.5.0: dual 模式分派——監看 wrapper 被 SPA 刪除後 re-append。
    if (STATE.translatedMode === 'dual') {
      runContentGuardDual(false);
      return;
    }
    // v1.9.27: 混合模式(single 全局 + framework-managed element 走 dual)場景,
    // STATE.translationCache 會有項。先跑 dual sweep 守 wrapper,再跑 single
    // sweep 守 innerHTML。互不打架(分別走 STATE.translatedHTML / translationCache)。
    if (STATE.translationCache && STATE.translationCache.size > 0) {
      runContentGuardDual(false);
    }
    runContentGuardNvMutate(false);
    let restored = 0;
    // v1.8.14: 優先走 IO subset(viewport 附近的 entry),沒 IO 時 fallback 全表
    const candidates = guardVisibleSet
      ? guardVisibleSet
      : STATE.translatedHTML.keys();
    for (const el of candidates) {
      const savedHTML = STATE.translatedHTML.get(el);
      if (savedHTML == null) continue; // IO subset 可能含已被 restorePage 清掉的元素
      if (!el.isConnected) continue;
      if (el.innerHTML === savedHTML) continue;
      // v1.5.5: 編輯模式下使用者正在改譯文，innerHTML 偏離 savedHTML 是預期的，
      // guard 不能覆蓋——否則每秒一次 sweep 會把使用者剛打的字蓋回去。
      if (el.getAttribute('contenteditable') === 'true') continue;
      // IO subset 已過濾 viewport,fallback 路徑才需 rect 防護
      if (!guardVisibleSet) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom < -500 || rect.top > window.innerHeight + 500) continue;
      }
      // AMO source review: savedHTML 來自 STATE.translatedHTML(本 extension 自己用
      // el.innerHTML 讀出來再存的譯後 DOM 字串),沒有 user input 流入。see BUILD.md §innerHTML
      el.innerHTML = savedHTML;
      restored++;
    }
    if (restored > 0) {
      SK.sendLog('info', 'guard', `Content guard restored ${restored} overwritten nodes`);
    }
  }

  // v1.10.49: nv-mutate 元素巡檢 — detectAndUnmarkExpandedNodeValueMutate Path E
  // 的週期性補位。A4 是 observer batch 反應式:framework 還原譯文的 mutation 若落
  // 在注入期間 / debounce 視窗外被漏看(2026-06-12 Medium 劃線 highlight hydration
  // 實測:5 段 nv-mutate 元素被 React 整批換新 text node 還原成英文,attribute 留
  // 在元素上,A4 沒收到 batch → 永遠卡「標 translated 但顯示原文」),需要跟
  // innerHTML guard / dual wrapper guard 同等級的 1s sweep 兜底。
  // 只處理「backup node 全部 detach」(framework 整批換新)——connected 但值變了
  // 的場景留給 A4 Path B(batch 內有 characterData 事件,且 sweep 搶先重寫會跟
  // X show-more 展開重翻打架,把完整原文蓋回截斷版譯文)。
  // 兩條修復路徑(以「重 render 後的內容」分流):
  //   1. 同內容重 render(current textContent === STATE.originalText)→ 直接把
  //      STATE.nvMutateTranslation 記錄的譯文重套(nvReapplySaved:先試 raw+slots
  //      A3 同構配對保留 inline 結構,配對不成 fallback 純文字 slots=[]),零 API、
  //      冪等,sweep 每秒一次直到贏過 framework 的 hydration 波
  //      (§15「reapply on detach+reattach」戰術)。unmark→rescan→重打 API 在
  //      hydration 波內會反覆被還原直到重試上限耗盡,實測救不回來。
  //   2. 內容已變(X show-more 展開等)→ unmark + rescan 重翻(不可重套舊譯文,
  //      會把新內容蓋掉)。
  // 每元素干預上限 8 次:防 framework 持續重 render 的無限 ping-pong(重套免
  // API 成本低,上限放寬到足以撐過 Medium hydration 多波重 render)。
  // v2.0.57(洞 3):上限從 lifetime 計數改「滾動停損」——距上次介入超過
  // NV_GUARD_INTERVENE_DECAY_MS 就歸零重計。lifetime 上限在長閱讀 session 會被
  // 偶發重繪慢慢耗盡(NYT 滾動 lazy-load 每次重繪吃 1 次),之後 sweep 永久跳過
  // 該元素 =「標 translated、畫面永遠原文」終態;真正要防的「站方持續對抗」
  // ping-pong 是高頻連續介入,60s 視窗內照樣 8 次就停。上限打滿後 lastT 不再更新,
  // 60s 後自動重新放行 → 最壞情況從「無限迴圈」變「每分鐘最多 8 次」受控頻率,
  // 終態也因此可自癒。
  const NV_GUARD_INTERVENE_MAX = 8;
  const NV_GUARD_INTERVENE_DECAY_MS = 60_000;
  const nvGuardInterveneCount = new WeakMap(); // el → { n, lastT }
  function nvGuardTryIntervene(el) {
    const now = Date.now();
    const rec = nvGuardInterveneCount.get(el);
    const n = (rec && now - rec.lastT <= NV_GUARD_INTERVENE_DECAY_MS) ? rec.n : 0;
    if (n >= NV_GUARD_INTERVENE_MAX) return false;
    nvGuardInterveneCount.set(el, { n: n + 1, lastT: now });
    return true;
  }

  // v2.0.57(洞 3):不依賴 backup node refs / 值的「回到原文」判準。
  // backup 的 originalValue 在多輪 guard 重建後可能是 stale 混合值(重建當下畫面
  // 是「部分英文 + 部分譯文」,originalValue 就存成那個混合態),之後 framework 再
  // 用 reuse-node 方式把全段打回原文時:node 沒 detach(allDetached 不成立)、
  // curText 也比對不到任何 stale originalValue(nvMutateRevertedToOriginal 不成立)
  // → 舊閘門永久跳過,卡「標 translated、畫面英文」終態(NYT figcaption + JRead
  // 閱讀模式實測)。本判準直接拿 el.textContent 對 STATE.originalText 全等(空白
  // 正規化後),不經任何 node ref,framework 換新 node / reuse node / 部分重繪一律涵蓋。
  function nvRevertedToOrigText(origText, curText) {
    if (!origText || !curText) return false;
    if (curText === origText) return true;
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    return norm(curText) === norm(origText);
  }

  // 2026-07-02: 判斷 nv-mutate 元素「譯文被 framework 打回原文(全部或部分)」。
  // 以「症狀」為準,涵蓋 framework 重繪的各種節點處理方式:
  //   - 換新 node(backup 全 detach)、reuse node 只 reset nodeValue(backup 仍 connected)、
  //     只重繪「部分」text node(多 text node 元素常見:圖說「說明 span + 來源 span」,
  //     framework 只把說明 span 打回英文,來源 span 仍是譯文 → 混合)。
  // 判準:元素現在的可見文字含有「某個 backup 節點的原文值」(說明該段回到原文),
  //   且整體長度沒明顯變長(排除 X show-more 這類「原文還在 + 新增大量內容」→ 那要重翻,
  //   不是重套舊譯文)。健康譯文(顯示中文、無原文值)與換新內容(不含 backup 原文值)
  //   都不會命中,故不會誤把好譯文或新內容重套。
  // Why 不是只比 curText === origText:真實案例(NYT React figcaption)是「部分還原」,
  //   curText 是「英文說明 + 中文來源」的混合,不等於全英文 origText,舊判準漏接 → 卡英文。
  function nvMutateRevertedToOriginal(backup, origText, curText) {
    if (!origText || !curText) return false;
    if (curText.length > origText.length * 1.3) return false; // 明顯變長 = 展開/新增,非還原
    return backup.some(e => {
      const ov = (e && typeof e.originalValue === 'string') ? e.originalValue.trim() : '';
      return ov.length >= 4 && curText.includes(ov);
    });
  }

  // v2.0.59: 「現況即譯文」判準——現在的可見文字去除全部空白後與純文字譯文全等。
  // Why:nvMutateRevertedToOriginal 以「curText 含 backup originalValue 片段」判 reverted,
  // 譯文保留原文專有名詞(人名 / 品牌名逐字出現在譯文)時會對健康譯文誤報 → sweep
  // 對「已是譯文」的 DOM 重套。首翻 A3 對齊過的段落在譯文態 DOM 上重跑 A3 配對
  // 必失敗(真實 Verge probe:okOnOrig=true / okOnTranslated=false,frag 文字 run 與
  // 譯文態 text node 分佈不同)→ fallback 純文字 flatten,好譯文的 <a> 被打成空殼。
  // 健康譯文直接跳過不動才是 no-op 正解;空白分佈允許不同(A3 各 node 首尾空白保留
  // 自原文、flatten 版無此空白),故去空白比對。
  function nvTextEqualsPlain(curText, plain) {
    if (!curText || !plain) return false;
    return curText.replace(/\s+/g, '') === plain.replace(/\s+/g, '');
  }

  // v2.0.59: 健康譯文第一訊號——backup 完好:所有 backup text node 仍 connected 且
  // nodeValue 就是當初寫入的譯文值。成立 = 譯文原封沒被 framework 動過,guard 不該
  // 介入(reverted 的 includes 判準在此仍可能誤報,見 nvTextEqualsPlain 註解)。
  // 重套成功後 backup 都會以新 refs 重建,故「剛重套完的下一輪 sweep」此判準即成立,
  // 不受譯文變體(slot 去重 / 自由 text 捨棄)造成的字面差異影響。
  function nvBackupIntact(backup) {
    return !!(backup && backup.length > 0 && backup.every(e =>
      e && e.node && e.node.isConnected &&
      typeof e.translatedValue === 'string' && e.node.nodeValue === e.translatedValue));
  }

  // v2.0.59: nv 重套統一入口。rec 來自 STATE.nvMutateTranslation({ plain, raw, slots })。
  // A3 同構注入成功的段落,framework 打回原文後結構與首翻相同——先以帶佔位符的
  // 原始譯文 + slots 重走 A3 配對,text node 各自套譯文、<a> 等 inline 結構保留;
  // 配對不成(部分還原的混合態等)才 fallback 純文字重套(slots=[] Case 3b flatten,
  // 原行為)。修 The Verge「guard 補課後段落內連結消失」(2026-07-16 回報)。
  function nvReapplySaved(el, rec) {
    if (!rec) return false;
    if (rec.raw && rec.slots
        && SK.tryInjectNodeValueMutate?.(el, rec.raw, rec.slots)) return true;
    return !!(rec.plain && SK.tryInjectNodeValueMutate?.(el, rec.plain, []));
  }

  function runContentGuardNvMutate(ignoreViewport, reapplyOnly) {
    if (!STATE.nodeValueMutateBackup || STATE.nodeValueMutateBackup.size === 0) return 0;
    let reapplied = 0;
    let unmarked = 0;
    for (const [el, backup] of STATE.nodeValueMutateBackup) {
      if (!el || !el.isConnected) continue;
      if (!backup || backup.length === 0) continue;
      // v2.0.57: 編輯模式豁免(對齊 innerHTML / mutation-driven 軌)——使用者正在
      // 編輯的元素不重套、不 unmark,否則 sweep 會把使用者剛改的字蓋回譯文。
      if (el.getAttribute?.('contenteditable') === 'true') continue;
      const origText = STATE.originalText?.get?.(el);
      const savedTranslation = STATE.nvMutateTranslation?.get?.(el);
      const curText = (el.textContent || '').trim();
      // v2.0.59: 健康譯文守門(見 nvBackupIntact / nvTextEqualsPlain)——畫面已是
      // 譯文就不介入,防 reverted 誤報(譯文保留原文專有名詞)把好譯文重套成 flatten
      if (nvBackupIntact(backup)
          || (savedTranslation && nvTextEqualsPlain(curText, savedTranslation.plain))) continue;
      const allDetached = backup.every(entry => !entry?.node?.isConnected);
      // reverted:譯文被 framework 打回原文(全部或部分,不論換新 node / reset nodeValue /
      // 只重繪部分節點)。取代原本只認「backup 全 detach」的判準——後者漏掉多 text node
      // 元素被「部分重繪 / reuse-node reset」打回原文的形(2026-07-02 NYT figcaption 實測)。
      const reverted = nvMutateRevertedToOriginal(backup, origText, curText);
      // v2.0.57(洞 3):revertedToOrig 完全不依賴 backup refs / 值——backup 在多輪
      // 重建後 originalValue 可能 stale(見 nvRevertedToOrigText 註解),只靠上兩個
      // 判準會永久跳過「畫面已回到原文」的元素。
      const revertedToOrig = nvRevertedToOrigText(origText, curText);
      // 介入條件:framework 換過整批 node(allDetached)或元素顯示出原文(reverted /
      // revertedToOrig)。健康譯文(沒被框架動過、顯示中文)皆不成立 → 跳過維持 no-op。
      // 「全 detach + 內容換新(非還原)」落到下方 path 2 unmark 重翻;
      // 「部分 detach + 展開新內容(X show-more)」三判準皆 false → 跳過,交給 A4。
      if (!allDetached && !reverted && !revertedToOrig) continue;
      if (!ignoreViewport) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom < -500 || rect.top > window.innerHeight + 500) continue;
      }
      if (!nvGuardTryIntervene(el)) continue;

      if (savedTranslation && (reverted || revertedToOrig)) {
        // 路徑 1:譯文被打回原文 → 重套譯文。先清 stale backup 讓
        // tryInjectNodeValueMutate 以「現在的原文 node」重建 backup(新 refs)。
        const prevBackup = STATE.nodeValueMutateBackup.get(el);
        STATE.nodeValueMutateBackup.delete(el);
        if (nvReapplySaved(el, savedTranslation)) {
          el.setAttribute('data-shinkansen-nodevalue-mutated', '1');
          el.setAttribute('data-shinkansen-translated', '1');
          reapplied++;
          continue;
        }
        // 重套失敗(結構特殊):reapplyOnly(JRead 暫停期間)把舊 backup 放回——
        // 不放回的話 map entry 消失,resume 補課就看不到這個元素(新終態)。
        if (reapplyOnly) {
          STATE.nodeValueMutateBackup.set(el, prevBackup);
          continue;
        }
        // 完整模式 → fall through 走 unmark 路徑
      } else if (reapplyOnly) {
        // 暫停期間不走 unmark+rescan(會動結構),留給 resume 補課
        continue;
      }
      // 路徑 2:內容已變 / 無譯文紀錄 → unmark + rescan 重翻
      el.removeAttribute('data-shinkansen-nodevalue-mutated');
      el.removeAttribute('data-shinkansen-translated');
      STATE.nodeValueMutateBackup.delete(el);
      STATE.originalText?.delete?.(el);
      STATE.originalHTML?.delete?.(el);
      // 清 seenTexts entry(元素現在顯示原文)讓 rescan 能重翻
      const txt = (el.innerText || '').trim();
      if (txt) spaObserverSeenTexts.delete(txt);
      unmarked++;
    }
    if (reapplied > 0 || unmarked > 0) {
      SK.sendLog('info', 'guard',
        `Content guard nv-mutate: ${reapplied} reapplied, ${unmarked} unmarked for retranslation`);
    }
    if (unmarked > 0) {
      setTimeout(() => {
        if (!STATE.translated) return;
        triggerSpaObserverRescan();
      }, 100);
    }
    return reapplied + unmarked;
  }
  SK._testRunContentGuardNvMutate = function(reapplyOnly) { return runContentGuardNvMutate(true, !!reapplyOnly); };

  /**
   * v1.5.0: 雙語模式 Content Guard——遍歷 STATE.translationCache，
   * 若 wrapper 已被 SPA framework 從 DOM 上拔掉（!isConnected），就依
   * insertMode 把同一個 wrapper element 重新插回去。
   *
   * @param {boolean} ignoreViewport  測試用：略過 viewport 檢查強制全掃
   * @returns {number} 修復數量
   */
  function runContentGuardDual(ignoreViewport) {
    if (!STATE.translationCache || STATE.translationCache.size === 0) return 0;
    let restored = 0;
    for (const [el, info] of STATE.translationCache) {
      if (!el || !el.isConnected) continue;
      const { wrapper, insertMode } = info;
      if (!wrapper) continue;
      if (wrapper.isConnected) continue;  // wrapper 還在 DOM，不需修

      if (!ignoreViewport) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom < -500 || rect.top > window.innerHeight + 500) continue;
      }

      // 依當初的 insertMode 重插（與 SK.injectDual 保持一致）
      if (insertMode === 'append') {
        el.appendChild(wrapper);
      } else if (insertMode === 'afterend-block-ancestor') {
        const blockAncestor = SK.findBlockAncestor?.(el);
        if (blockAncestor && blockAncestor !== el.ownerDocument.body) {
          const wrapperTagUpper = SK.TRANSLATION_WRAPPER_TAG.toUpperCase();
          let insertPoint = blockAncestor;
          let sib = blockAncestor.nextElementSibling;
          while (sib && sib.tagName === wrapperTagUpper) {
            insertPoint = sib;
            sib = sib.nextElementSibling;
          }
          insertPoint.insertAdjacentElement('afterend', wrapper);
        } else {
          el.insertAdjacentElement('afterend', wrapper);
        }
      } else {
        // 'afterend' 或舊資料無記錄
        el.insertAdjacentElement('afterend', wrapper);
      }
      restored++;
    }
    if (restored > 0) {
      SK.sendLog('info', 'guard', `Content guard re-appended ${restored} dual wrappers`);
    }
    return restored;
  }

  // 暴露給 Debug API
  SK.testRunContentGuard = function testRunContentGuard() {
    if (!STATE.translated) return 0;
    if (STATE.translatedMode === 'dual') {
      return runContentGuardDual(true);
    }
    let restored = 0;
    // v1.9.27: 混合模式下也 sweep dual wrapper(對應 production runContentGuard)
    if (STATE.translationCache && STATE.translationCache.size > 0) {
      restored += runContentGuardDual(true);
    }
    for (const [el, savedHTML] of STATE.translatedHTML) {
      if (!el.isConnected) continue;
      if (el.innerHTML === savedHTML) continue;
      // v1.5.5: 與 runContentGuard 對齊——編輯模式 contenteditable 元素不修復
      if (el.getAttribute('contenteditable') === 'true') continue;
      // AMO source review: savedHTML 來自 STATE.translatedHTML(本 extension 自存),無 user input。
      el.innerHTML = savedHTML;
      restored++;
    }
    return restored;
  };

  // v1.6.10: 給 regression spec 直接呼叫真正的 production runContentGuard
  // （含所有 gate:STATE.translated / document.hidden / viewport rect）。
  // 與 testRunContentGuard 的差別:test 版繞過 viewport 檢查,本 hook 不繞過任何
  // 條件,用來驗證 hidden gate 行為。runContentGuard 沒回傳值,spec 需透過
  // 「修復後元素 textContent」斷言。
  SK._testRunContentGuardProd = function() { runContentGuard(); };

  // Debug counters(對應 SK._spaDebug 暴露)— 不寫 log 以免 flood
  let _dbgMutationBatchesSeen = 0;
  let _dbgHasNewContentTrueCount = 0;
  let _dbgDebounceArmedCount = 0;
  let _dbgEarlyReturnNotTranslated = 0;
  let _dbgEarlyReturnMaxRescans = 0;
  function onSpaObserverMutations(mutations) {
    _dbgMutationBatchesSeen++;
    // v1.10.65: JRead 閱讀模式期間讓位（同 runContentGuard）——不 stopSpaObserver、
    // 只跳過本批 reconcile，退出閱讀模式恢復後續 mutation 照常處理。也擋掉 JRead
    // 進閱讀模式重排 articleEl 觸發的這批 mutation 被當成「譯文被覆蓋」回寫。
    if (contentGuardExternallyPaused) return;
    if (!STATE.translated) { _dbgEarlyReturnNotTranslated++; stopSpaObserver(); return; }
    if (spaObserverRescanCount >= SK.SPA_OBSERVER_MAX_RESCANS) { _dbgEarlyReturnMaxRescans++; return; }

    // mutation-driven 譯文守護(高頻路徑):
    // 框架(典型 YouTube yt-attributed-string)在 hover 觸發 re-render 時會在
    // 譯後 element 自身的 childList 跑 burst(實測一次 hover ~80 個 mutation events
    // 在 1 秒內,每秒一次 Content Guard sweep 跟不上)。在 mutation callback 入口
    // 直接查 m.target 是否為 STATE.translatedHTML 的 key 且 innerHTML 已偏離,
    // 當下回寫譯文。比每秒 sweep 高頻且 inline。
    //
    // v1.9.17 F2: 改為 RAF defer 並加 user interaction blackout。Sync inline 改 DOM
    // 會在 React commit phase 期間 fire(MutationObserver callback 在 microtask queue,
    // 緊接著 React 同步 commit task),React 後續 reconcile 找不到原 child → throw
    // NotFoundError → React Router fallback render 500 page(Medium 留言點「更多」
    // 展開的真實 case)。RAF 在下次 paint 之前 fire,React commit 必已完。Blackout
    // window 內(click 後 2s)完全跳過 sync restore,讓 framework 自己處理新內容,
    // Shinkansen 等 armSpaObserverRescan debounce 1s + idle gate 完整 inject path。
    const win = typeof window !== 'undefined' ? window : null;
    const deferredRestore = () => {
      const sinceInteraction = Date.now() - (SK._lastInteractionT || 0);
      if (sinceInteraction < SK.USER_INTERACTION_BLACKOUT_MS) {
        // Blackout 內:不 sync restore。Framework re-render 自己處理 DOM,
        // 之後 armSpaObserverRescan 走 idle gate 安全 inject 新譯文。
        return;
      }
      restoreOnInnerMutation(mutations);
      // detect-replacement:框架把整個被翻譯的 element detach 換上一個渲染原文的新 element。
      // Content Guard 對這 case 失效——舊 el !isConnected 直接 continue,新 el 不在
      // STATE.translatedHTML 也認不出。跨 mutation 累積 removed + added 對比文字(真實
      // framework 常用 mutation A: remove only / mutation B: add only 的拆分模式),
      // 找到配對就把譯文 reapply 到新 element 並把 STATE 的 key 從舊 el 轉到新 el。
      reapplyOnDetachReattach(mutations);
    };
    if (win && typeof win.requestAnimationFrame === 'function') {
      win.requestAnimationFrame(deferredRestore);
    } else {
      deferredRestore();
    }

    // v1.9.27: detect 「使用者點按鈕後 framework in-place 改 dual-source element 內容
    // 做展開」(典型:X 推文點顯示更多)。沿 mutation target 往上找 translationCache key
    // element,滿足「textContent 顯著變長 + startsWith origText」就 remove wrapper +
    // clear STATE,讓下游 collectParagraphs 把它當新段落重收 + 重翻 + dual inject。
    // 必須 layer 1(framework-managed → dual fallback inject)配合使用,否則此 detect
    // 對 single inject 的 element 不適用。
    const hadDualExpandedUnmark = detectAndUnmarkExpandedDual(mutations);
    const hadNvMutateExpandedUnmark = detectAndUnmarkExpandedNodeValueMutate(mutations);

    const hasNewContent = hadDualExpandedUnmark || hadNvMutateExpandedUnmark || mutations.some(m =>
      m.type === 'childList' && m.addedNodes.length > 0 &&
      // 排除已翻譯節點內部的變動
      !(m.target.nodeType === 1 && m.target.closest?.('[data-shinkansen-translated]')) &&
      // v1.2.13: 排除 YouTube 字幕容器的 DOM 變動（字幕翻譯替換文字時不觸發 SPA rescan）
      !(m.target.nodeType === 1 && m.target.closest?.('.ytp-caption-window-container, .ytp-caption-segment')) &&
      Array.from(m.addedNodes).some(n =>
        n.nodeType === Node.ELEMENT_NODE && n.textContent.trim().length > 10 &&
        !n.classList?.contains('ytp-caption-segment') &&
        !n.closest?.('.ytp-caption-window-container')
      )
    );
    if (!hasNewContent) return;
    _dbgHasNewContentTrueCount++;
    _dbgDebounceArmedCount++;
    armSpaObserverRescan();
  }

  // v1.9.27: dual mode expanded element detect + unmark。對應 layer B 修法
  // (per-element framework-managed → dual fallback inject):當使用者點按鈕後
  // X 推文等 React-managed element 內 text node 透過 replaceData 變長,需要
  // 重翻並更新 sibling wrapper 內譯文。
  //
  // 守門:
  //   - currentText.length > origText.length * 1.5:顯著變長才視為「展開」,
  //     避免 framework 改 1-2 個 token 誤判
  //   - startsWith(origText):確認展開後文字以原本短版為 prefix,排除「替換成
  //     另一段不同內容」這種 framework 錯誤 path
  //
  // 操作:remove wrapper + remove data-shinkansen-dual-source attribute + 清
  //   STATE.translationCache / originalText / originalHTML entry。下游
  //   collectParagraphs 重收 + injectDual(line 718 attribute dedup pass)重 inject。
  function detectAndUnmarkExpandedDual(mutations) {
    if (!STATE.translationCache || STATE.translationCache.size === 0) return false;
    if (!STATE.originalText) return false;

    const candidates = new Set();
    for (const m of mutations) {
      let t = m.target;
      if (!t) continue;
      if (t.nodeType !== Node.ELEMENT_NODE) t = t.parentElement;
      while (t && t.nodeType === Node.ELEMENT_NODE) {
        if (STATE.translationCache.has(t)) { candidates.add(t); break; }
        t = t.parentElement;
      }
    }
    if (candidates.size === 0) return false;

    let unmarked = 0;
    for (const el of candidates) {
      if (!el.isConnected) continue;
      const origText = STATE.originalText.get(el);
      if (!origText) continue;
      const currentText = (el.textContent || '').trim();
      if (currentText.length <= origText.length * 1.5) continue;
      if (!currentText.startsWith(origText)) continue;

      // remove wrapper sibling + clear STATE,讓 collectParagraphs / injectDual 重跑
      const info = STATE.translationCache.get(el);
      if (info?.wrapper) {
        try { info.wrapper.remove(); } catch (_) {}
      }
      el.removeAttribute('data-shinkansen-dual-source');
      STATE.translationCache.delete(el);
      STATE.originalText.delete(el);
      STATE.originalHTML?.delete?.(el);
      unmarked++;
    }
    if (unmarked > 0) {
      SK.sendLog('info', 'spa', `detect-expanded-dual: ${unmarked} element(s) unmarked for retranslation`);
    }
    return unmarked > 0;
  }
  SK._detectAndUnmarkExpandedDual = detectAndUnmarkExpandedDual;

  // 給 spec 用的測試 hook
  SK._testNvMutateStubSetup = function _testNvMutateStubSetup(el, origText, backupEntries) {
    if (!STATE.nodeValueMutateBackup) STATE.nodeValueMutateBackup = new Map();
    STATE.nodeValueMutateBackup.set(el, backupEntries);
    STATE.originalText.set(el, origText);
  };

  // v1.9.27 Layer A4: detect-expand 對 nodeValue mutate 路徑(Layer A3 inject 的 element)。
  // 對應 dual map 的 detectAndUnmarkExpandedDual 同套邏輯,只是換 map:
  // STATE.nodeValueMutateBackup 取代 STATE.translationCache。
  //
  // 兩條 unmark 觸發 path:
  //   (A) Full reset path:textContent 顯著變長 + startsWith origText(framework
  //       把 tt 整段 reset 回完整原文,典型:X / Threads / Reddit 顯示更多 整段 re-mount)
  //   (B) Partial reset path(v1.9.30+):任一 backup text node 的 nodeValue 不再
  //       === 當初 mutate set 的 translatedValue(framework 只 reset 部分 text node,
  //       中文 prefix 保留 + 後段被改成新英文,典型 X timeline view truncated 推文
  //       點顯示更多 — X 只 reset 截斷處 text node 為展開後完整英文,前面已翻 SPAN
  //       不動)。
  function detectAndUnmarkExpandedNodeValueMutate(mutations) {
    if (!STATE.nodeValueMutateBackup || STATE.nodeValueMutateBackup.size === 0) return false;
    if (!STATE.originalText) return false;

    const candidates = new Set();
    // 方法 1:從 mutation target 往上找 backup 元素(framework 在 element 自身或子樹改動)
    for (const m of mutations) {
      let t = m.target;
      if (!t) continue;
      if (t.nodeType !== Node.ELEMENT_NODE) t = t.parentElement;
      while (t && t.nodeType === Node.ELEMENT_NODE) {
        if (STATE.nodeValueMutateBackup.has(t)) { candidates.add(t); break; }
        t = t.parentElement;
      }
    }
    // 方法 2:mutation target 找不到時(framework 替換上層 wrapper,mutation target
    // 在 backup 元素的祖先而非自身/後代),全量掃描 backup 元素的 textContent
    // 是否顯著變長。典型案例:X 點「顯示更多」替換 article 級 wrapper,mutation
    // target 是 article 的 parent,走不到 backup 裡的 tweetText。
    if (candidates.size === 0) {
      for (const [el] of STATE.nodeValueMutateBackup) {
        if (!el.isConnected) continue;
        const origText = STATE.originalText.get(el);
        if (!origText) continue;
        const curLen = (el.textContent || '').trim().length;
        if (curLen > origText.length * 1.5) {
          candidates.add(el);
        }
      }
    }
    if (candidates.size === 0) return false;

    let unmarked = 0;
    for (const el of candidates) {
      if (!el.isConnected) continue;
      const origText = STATE.originalText.get(el);
      if (!origText) continue;

      let trigger = null;

      // Path (A): full reset — framework 把整段 reset 回完整原文
      const currentText = (el.textContent || '').trim();
      if (currentText.length > origText.length * 1.5 && currentText.startsWith(origText)) {
        trigger = 'full-reset';
      }

      // Path (B): partial reset — 任一 backup text node nodeValue 已被 framework
      // 改寫(不再 === 當初 set 的 translatedValue)。對應 X show more 部分 reset。
      if (!trigger) {
        const backup = STATE.nodeValueMutateBackup.get(el);
        if (backup && backup.length > 0) {
          for (const entry of backup) {
            if (!entry || !entry.node || !entry.node.isConnected) continue;
            if (typeof entry.translatedValue !== 'string') continue;
            if (entry.node.nodeValue !== entry.translatedValue) {
              trigger = 'partial-reset';
              break;
            }
          }
        }
      }

      // Path (C): textContent 顯著變長 + 至少一個 backup text node 仍保持
      // translatedValue — framework 展開內容時只 append 新子元素,不 reset 已翻譯
      // 的舊 text node。Path A 失敗(currentText 以翻譯語言開頭),Path B 失敗(舊
      // text node 仍持 translatedValue)。「仍持 translatedValue」同時是 Path C 的
      // 必要守門:區分「展開新內容」(舊翻譯保留 + 新原文加入)vs「完全替換成不同
      // 文字」(舊翻譯不在了)。
      if (!trigger && currentText.length > origText.length * 1.5) {
        const backup = STATE.nodeValueMutateBackup.get(el);
        if (backup && backup.length > 0) {
          const hasRetainedTranslation = backup.some(entry =>
            entry?.node?.isConnected &&
            typeof entry.translatedValue === 'string' &&
            entry.node.nodeValue === entry.translatedValue
          );
          if (hasRetainedTranslation) {
            trigger = 'expanded-content';
          }
        }
      }

      // Path (D): attribute stripped — framework re-render 時把
      // data-shinkansen-nodevalue-mutated attribute 拔掉(React reconciliation
      // 不認識 custom attribute 會清除),但 DOM element ref 不變、
      // STATE.nodeValueMutateBackup 仍有記錄。典型場景:X 推文點「顯示更多」
      // React re-render 保留同一 element + 加 children + strip attributes。
      // Path A/B/C 都可能不觸發(CJK 翻譯比英文短,length ratio 不到 1.5x;
      // backup text node 仍持 translatedValue),attribute 消失是明確訊號。
      if (!trigger && !el.hasAttribute('data-shinkansen-nodevalue-mutated')) {
        trigger = 'attr-stripped';
      }

      // Path (E) v1.10.49: 整批 text node 被 framework 換新 — React 重 render
      // 子樹時用「新的」text node 物件呈現原文(典型:Medium 劃線 highlight
      // hydration 把段落子節點換成 <mark> 包裹的新 text node),當初 mutate 的
      // node 全部 detach。Path B 對 !isConnected entry 直接 skip 看不到差異,
      // element ref 沒變所以 attribute 也沒被 strip(Path D 不觸發),元素永遠卡
      // 在「標 translated 但顯示英文原文」(2026-06-12 Medium Outkast 段實測,
      // 含 3 個 <mark> 劃線)。判準取保守的「全部 detach」:部分 detach 的混合
      // 場景交由 Path B/C 的值比對處理,避免誤殺 X show-more 部分重建。
      if (!trigger) {
        const backupE = STATE.nodeValueMutateBackup.get(el);
        if (backupE && backupE.length > 0 &&
            backupE.every(entry => !entry?.node?.isConnected)) {
          trigger = 'nodes-replaced';
        }
      }

      if (!trigger) continue;

      // v1.10.49: unmark 前先試「重套譯文」——framework 把譯文重 render 回原文
      // (現在的 textContent 仍等於原文)時,直接把記錄的純文字譯文套回(零 API)。
      // Medium 劃線 highlight hydration 實測:hydration 多波重 render,
      // unmark→rescan→重打 API 的循環在波內反覆被還原直到重試上限耗盡,留下
      // 「標 translated 但顯示英文」;重套是冪等操作,跟 guard 的 1s sweep
      // (runContentGuardNvMutate)同款,sweep 到 framework 收手為止。
      // 內容已變(X show-more 等)不重套——curText !== origText 自然走 unmark。
      // 2026-07-02:重套判準改用 nvMutateRevertedToOriginal——不再硬要求 backup node
      // 全 detach、也不再只認「全等於 origText」。framework 重用 node 只 reset nodeValue、
      // 或只重繪「部分」text node(多 text node 圖說常見:說明 span 回英文、來源 span 仍中文)
      // 時,舊條件(_allDetached / _cur === origText)都不成立 → 卡「標 translated 顯示原文」。
      // v2.0.59: 健康譯文守門只加在 1s sweep(runContentGuardNvMutate),A4 這裡不加——
      // Path C(展開內容 unmark 重翻)/ Path D(attr-stripped selective restore)的觸發
      // 態 backup 可能仍完好,閘門會搶走這兩條設計語意(spa-detect-expanded-nv-mutate
      // spec 鎖定);A4 必須先有 trigger(framework 真的動過 DOM)才會走到這,誤報面
      // 遠小於每秒空轉的 sweep。
      {
        const _saved = STATE.nvMutateTranslation?.get?.(el);
        const _cur = (el.textContent || '').trim();
        const _backupNow = STATE.nodeValueMutateBackup.get(el);
        // v2.0.57(洞 3):判準與停損跟 runContentGuardNvMutate 對齊——
        // nvRevertedToOrigText 不依賴 backup 值;nvGuardTryIntervene 滾動停損。
        if (_saved && _backupNow
            && (nvRevertedToOrigText(origText, _cur) || nvMutateRevertedToOriginal(_backupNow, origText, _cur))
            && nvGuardTryIntervene(el)) {
          STATE.nodeValueMutateBackup.delete(el);
          if (nvReapplySaved(el, _saved)) {
            el.setAttribute('data-shinkansen-nodevalue-mutated', '1');
            el.setAttribute('data-shinkansen-translated', '1');
            SK.sendLog?.('info', 'spa', `detect-expanded-nv-mutate: reapplied translation (was ${trigger})`);
            continue;
          }
          // 重套失敗 → fall through 走原 unmark 路徑(backup 已刪,下方還原迴圈自然跳過)
        }
      }

      // 還原 backup text node 為原文,確保 collectParagraphs 收到乾淨的 source text。
      // Selective restore:只還原仍持 translatedValue 的 node。如果 framework
      // 已把 text node 改成展開後完整原文(nodeValue !== translatedValue),不覆蓋
      // ——否則截斷版覆蓋完整版,中間段落消失(X 推文「顯示更多」真實案例)。
      const _backup = STATE.nodeValueMutateBackup.get(el);
      if (_backup) {
        for (const entry of _backup) {
          if (!entry?.node?.isConnected || typeof entry.originalValue !== 'string') continue;
          if (typeof entry.translatedValue === 'string' &&
              entry.node.nodeValue !== entry.translatedValue) {
            continue;
          }
          entry.node.nodeValue = entry.originalValue;
        }
      }

      // unmark + clear STATE,讓 collectParagraphs / Layer A3 inject 重跑
      el.removeAttribute('data-shinkansen-nodevalue-mutated');
      el.removeAttribute('data-shinkansen-translated');
      STATE.nodeValueMutateBackup.delete(el);
      STATE.originalText.delete(el);
      STATE.originalHTML?.delete?.(el);
      unmarked++;
      SK.sendLog?.('info', 'spa', `detect-expanded-nv-mutate: unmark via ${trigger}`);
    }
    if (unmarked > 0) {
      SK.sendLog('info', 'spa', `detect-expanded-nv-mutate: ${unmarked} element(s) unmarked for retranslation`);
    }
    return unmarked > 0;
  }
  SK._detectAndUnmarkExpandedNodeValueMutate = detectAndUnmarkExpandedNodeValueMutate;

  // Idle debounce + maxWait combined:
  //   - idle timer 每次 mutation reset(SPA_OBSERVER_DEBOUNCE_MS)
  //   - maxWait timer 第一次 arm 時設,連續 mutation 不 reset(SPA_OBSERVER_MAX_WAIT_MS)
  //   - 哪個先 fire 就 trigger rescan,另一個 cancel
  // Why:Twitter / Reddit / Threads 等 virtualized scroll 站,使用者連續滑動期間
  // mutation 不停,純 debounce 永遠被 reset → rescan 不 fire → 譯文遲遲不出現。
  // maxWait 保證即使連續滑也至少 SPA_OBSERVER_MAX_WAIT_MS 一次 fire,使用者體感
  // 「滑動期間譯文也會週期性追上」。
  function armSpaObserverRescan() {
    // v1.9.27 Layer 13:per-host fast profile(X / Threads / Reddit / Mastodon)
    // 把 1s/2s 縮到 250ms/500ms,對應虛擬化 timeline 邊滑邊讀 UX。SPEC-PRIVATE §25.20。
    const timing = (typeof SK.getObserverTiming === 'function')
      ? SK.getObserverTiming()
      : { debounce: SK.SPA_OBSERVER_DEBOUNCE_MS, maxWait: SK.SPA_OBSERVER_MAX_WAIT_MS };
    if (spaObserverDebounceTimer) clearTimeout(spaObserverDebounceTimer);
    spaObserverDebounceTimer = setTimeout(triggerSpaObserverRescan, timing.debounce);
    if (!spaObserverMaxWaitTimer) {
      spaObserverMaxWaitTimer = setTimeout(triggerSpaObserverRescan, timing.maxWait);
    }
  }

  function triggerSpaObserverRescan() {
    if (spaObserverDebounceTimer) { clearTimeout(spaObserverDebounceTimer); spaObserverDebounceTimer = null; }
    if (spaObserverMaxWaitTimer) { clearTimeout(spaObserverMaxWaitTimer); spaObserverMaxWaitTimer = null; }
    // v1.9.17: reset idle gate,讓本次 rescan 引發的 inject 重新等 framework idle。
    // SPA rescan 是 framework re-render 觸發(典型:使用者點 React button 展開內容),
    // 此時 React 還在 commit / reconciliation phase,sync inject 會撞 removeChild
    // NotFoundError(Medium 留言「more」點下後變 500 page 的真實 case)。等 RIC idle
    // = React commit 已完。本檔 line 540 SPA_OBSERVER_DEBOUNCE_MS 1 秒 debounce 不夠,
    // 因 React streaming 多階段 commit 可能跨多個 microtask + fetch 延遲。
    SK._idleGateReached = false;
    SK._idleGatePromise = null;
    spaObserverRescan();
  }
  // 給 spec / debug 用
  SK._armSpaObserverRescan = armSpaObserverRescan;
  SK._SPA_OBSERVER_MAX_WAIT_MS = SK.SPA_OBSERVER_MAX_WAIT_MS;

  /**
   * 偵測「譯後 element 被框架整個替換」並把譯文 reapply 到新 element。
   *
   * Why:Content Guard 走 STATE.translatedHTML.keys() 比對 innerHTML,
   * 預設 element 還在 DOM 上;遇到 framework detach + add 新 element 時舊 key
   * isConnected=false 直接 continue,新 element 又不在 Map 裡,譯文永久消失。
   *
   * Reapply 條件(跨 mutation 累積):
   *   1. 整批 mutations 內所有 removedNodes 是 STATE.translatedHTML 的 key 的 → 累積成
   *      removedTrans 候選清單(帶 savedHTML + originalText)
   *   2. 整批 mutations 內所有 addedNodes(任何 element type)→ 累積成 addedAll 清單
   *   3. 用 originalText 對 added.textContent.trim() 比對找配對
   * 跨 mutation 累積是必要的:真實 framework(YouTube hover 觸發 yt-attributed-string
   * re-render)觀察到 mutation A: remove only / mutation B: add only 的拆分模式,
   * 同 mutation 內找不到配對。不額外打 API,純從 STATE 拿譯文。
   */
  function reapplyOnDetachReattach(mutations) {
    if (!STATE.translatedHTML || STATE.translatedHTML.size === 0) return;
    if (!STATE.originalText) return;
    const removedTrans = [];
    const addedAll = [];
    for (const m of mutations) {
      if (m.type !== 'childList') continue;
      for (const r of m.removedNodes) {
        if (r.nodeType !== Node.ELEMENT_NODE) continue;
        const savedHTML = STATE.translatedHTML.get(r);
        if (savedHTML == null) continue;
        const originalText = STATE.originalText.get(r);
        if (!originalText) continue;
        removedTrans.push({ el: r, savedHTML, originalText });
      }
      for (const a of m.addedNodes) {
        if (a.nodeType !== Node.ELEMENT_NODE) continue;
        addedAll.push(a);
      }
    }
    if (removedTrans.length === 0 || addedAll.length === 0) return;
    let restored = 0;
    for (const r of removedTrans) {
      for (const added of addedAll) {
        const addedText = (added.textContent || '').trim();
        if (addedText !== r.originalText) continue;
        try {
          // AMO source review: r.savedHTML 來自 STATE.translatedHTML(本 extension 自存),無 user input。
          added.innerHTML = r.savedHTML;
        } catch (_) { continue; }
        added.setAttribute('data-shinkansen-translated', '1');
        STATE.translatedHTML.delete(r.el);
        STATE.translatedHTML.set(added, r.savedHTML);
        STATE.originalText.delete(r.el);
        STATE.originalText.set(added, r.originalText);
        if (STATE.originalHTML.has(r.el)) {
          STATE.originalHTML.set(added, STATE.originalHTML.get(r.el));
          STATE.originalHTML.delete(r.el);
        }
        SK._guardObserveEl?.(added);
        restored++;
        break;
      }
    }
    if (restored > 0) {
      SK.sendLog('info', 'guard', `reapply on detach+reattach: ${restored} segments`);
    }
  }
  SK._reapplyOnDetachReattach = reapplyOnDetachReattach;

  /**
   * mutation-driven 譯文守護:任何 STATE.translatedHTML 的 key 在 mutation 中
   * 自身的 childList 被改 + innerHTML 偏離 savedHTML → 當下立刻回寫。
   *
   * Why:Content Guard 既有 setInterval 1000ms sweep 對「framework 高頻 burst
   * re-render」(典型 YouTube yt-attributed-string hover 觸發約 1 秒內 80 個
   * mutation events)反應太慢,期間譯文已恢復成原文使用者看見。在 mutation
   * callback 內 inline 處理即時回寫。
   *
   * v1.8.26:加 per-element 200ms cooldown(`_justRestoredAt`)防自我餵食迴圈。
   * 原版只靠 `target.innerHTML === savedHTML` 比字串擋迴圈,但 Firefox 對 innerHTML
   * setter/getter round-trip 在某些 edge case 不嚴格相等(例如 `&nbsp;` 與 ` `、
   * attribute 順序、self-closing tag、whitespace normalize 差異),guard 失效後
   * 「寫回 → mutation → 讀回 ≠ savedHTML → 又寫回」每秒上萬次,記憶體每秒 +1GB
   * (Wikipedia + Firefox 實機驗證,seq 跑到 250 萬+,GET_LOGS 全是 `mutation-driven
   * restore: 1 segments`)。Chrome 序列化穩定不踩雷,加 cooldown 對 Chrome 行為零影響
   * (正常 framework re-render 同 element 200ms 內不應該需要重複寫)。
   *
   * 結構性通則(§8):cooldown 描述「同一 element 在極短時間窗內不重複寫回」這個
   * 結構特徵,不綁瀏覽器 / 站點 / class。Firefox 上把暴量 cap 在 5次/秒/element,
   * 把無限迴圈轉成「最差也是 1 秒幾次」可控頻率。
   */
  const RESTORE_COOLDOWN_MS = 200;
  const _justRestoredAt = new WeakMap();
  function restoreOnInnerMutation(mutations) {
    if (!STATE.translatedHTML || STATE.translatedHTML.size === 0) return;
    const targets = new Set();
    for (const m of mutations) {
      if (m.type !== 'childList') continue;
      const t = m.target;
      if (!t || t.nodeType !== Node.ELEMENT_NODE) continue;
      if (!STATE.translatedHTML.has(t)) continue;
      targets.add(t);
    }
    if (targets.size === 0) return;
    const now = Date.now();
    let restored = 0;
    for (const target of targets) {
      const lastTs = _justRestoredAt.get(target);
      if (lastTs != null && now - lastTs < RESTORE_COOLDOWN_MS) continue;
      const savedHTML = STATE.translatedHTML.get(target);
      if (savedHTML == null) continue;
      if (!target.isConnected) continue;
      if (target.innerHTML === savedHTML) continue;
      // v1.5.5 對齊 runContentGuard / testRunContentGuard：編輯模式元素不回寫——
      // interaction blackout 只蓋得住「使用者打字引發」的 mutation，第三方 framework
      // 背景 mutation 進到這裡會把使用者編輯內容整段蓋掉
      if (target.getAttribute('contenteditable') === 'true') continue;
      // AMO source review: savedHTML 來自 STATE.translatedHTML(本 extension 自存),無 user input。
      target.innerHTML = savedHTML;
      _justRestoredAt.set(target, now);
      restored++;
    }
    if (restored > 0) {
      SK.sendLog('info', 'guard', `mutation-driven restore: ${restored} segments`);
    }
  }
  SK._restoreOnInnerMutation = restoreOnInnerMutation;

  /**
   * 子層 element 寫進 STATE.translatedHTML 後,把所有「contains(el)」的 ancestor 的
   * savedHTML 同步更新成當下最新 innerHTML。
   *
   * Why:Content Guard sweep 會比對每個 STATE.translatedHTML key 的 innerHTML 跟
   * savedHTML,不同就強制 `el.innerHTML = savedHTML` 還原。但 fragment inject 完成
   * 時凍結的 savedHTML 含「子段落還沒被 inject 的英文原文」,後續子段落 inject 把
   * 子層改成中文後 ancestor 的 savedHTML 沒同步 → sweep 強制覆寫整個 ancestor,
   * 子層中文被打回 stale 英文,原子層 element 連同 sk attribute 一起被 detach 變孤兒。
   *
   * 真實案例:forum.miata.net showpost 的 postbitcontrol2 (DIV) 同時含主貼文 inline
   * 文字 + BR + 子層 DIV.bbcodestyle > TABLE > TR > TD > DIV (引用區塊)。主貼文走
   * fragment unit、引用區塊走 element unit,fragment 先 inject 凍結 savedHTML 含舊
   * 引文英文,引文 inject 後 sweep 把譯文打回去。
   *
   * 結構性通則(§8):描述「父子層 inject 時序差」的結構特徵,不綁站點 / class。
   * 任何 block-like ancestor 同時被 collectParagraphs 抓成段落 + 子樹中含其他
   * 獨立段落的場景都會踩到(XenForo bbWrapper / Wikipedia 含子標題 / Substack
   * 含內嵌引文 etc)。
   */
  SK.refreshAncestorSavedHTML = function refreshAncestorSavedHTML(el) {
    if (!STATE.translatedHTML || STATE.translatedHTML.size === 0) return;
    if (!el || !el.parentNode) return;
    const ancestors = [];
    for (const ancestor of STATE.translatedHTML.keys()) {
      if (ancestor === el) continue;
      if (ancestor.contains && ancestor.contains(el)) {
        ancestors.push(ancestor);
      }
    }
    for (const ancestor of ancestors) {
      STATE.translatedHTML.set(ancestor, ancestor.innerHTML);
    }
  };

  /**
   * 決定 SPA rescan 完成後該顯示哪種 toast(或不顯示)。
   *
   * Why:framework re-render 同一段譯後內容(典型 YouTube hover description)觸發
   * SPA rescan 走 cache 路徑 reapply 譯文,這個 inject 是 0 API 成本——但若仍跳
   * 「已翻 N 段新內容」success toast,使用者會誤以為又花了 token。純 cache hit 場景
   * 應 silent(把 loading toast 藏掉、不顯示 success toast),使用者看到內容回到中文
   * 就是足夠回饋。
   *
   * @param {{ done: number, failedCount: number, pageUsage: { cacheHits?: number } | null, totalRequested: number, isTinyRescan?: boolean }} args
   * @returns {{ type: 'silent' } | { type: 'error', msg: string } | { type: 'success', msg: string }}
   */
  function pickRescanToast({ done, failedCount, pageUsage, totalRequested, isTinyRescan }) {
    if (failedCount > 0) {
      return { type: 'error', msg: SK.t('toast.rescanPartialFailed', { failed: failedCount, total: totalRequested }) };
    }
    // v1.9.27:tiny rescan(1-2 unit 且 < 200 char)走靜默路徑。X / Threads / Reddit
    // 邊滑邊 lazy mount link card / OG preview / 推文 metadata 一直觸發迷你 rescan,
    // 真彈 toast「已翻 1 段新內容」對體感雜訊極差(SPEC-PRIVATE §25.20.6)。
    if (isTinyRescan) return { type: 'silent' };
    // v1.9.8: silent 條件從「全部 cache hit」放寬到「有任何 cache hit」。
    // SPA rescan 是 scroll / lazy-load 被動觸發,使用者沒按按鈕、沒期待 toast 回饋;
    // 在 X / Reddit / Threads 等虛擬化 timeline 場景 mount/unmount 同段推文常產出
    // 「2 hit + 1 miss」這類混合,逐段 toast 噪音化。pageUsage.cacheHits > 0 暗示
    // 「使用者之前翻過部分內容、現在的 rescan 主要在 reuse 舊資料」,silent 合適。
    // pageUsage.cacheHits === 0 才是真正「全新翻 N 段」場景,保留 success toast 通知。
    const hasAnyCacheHit = pageUsage && pageUsage.cacheHits > 0 && done > 0;
    if (hasAnyCacheHit) return { type: 'silent' };
    return { type: 'success', msg: SK.t('toast.rescanDone', { done }) };
  }
  SK._pickRescanToast = pickRescanToast;

  /** 從 unit 提取原始文字（用於 seen-text 去重） */
  function unitText(unit) {
    if (unit.kind === 'fragment') {
      let t = '';
      let n = unit.startNode;
      while (n) {
        t += n.textContent || '';
        if (n === unit.endNode) break;
        n = n.nextSibling;
      }
      return t.trim();
    }
    return (unit.el?.innerText || '').trim();
  }

  // v1.10.15:把「cap 到 MAX_UNITS + 標記 seen」抽成純函式,鎖住一條 invariant——
  // 「被 cap 丟掉的 overflow unit 絕不可被標進 seenTexts」。
  // 原 bug:rescan 先把「全部找到的 unit」標 seen,再 slice 到 MAX_UNITS。當一次
  // collectParagraphs 抓到 > 50 個(典型:YouTube 留言批次 lazy-load,一次進來 64 則),
  // 被 slice 丟掉的 14 則已經在 seenTexts 內 → 後續 rescan 被 isSeenTextRecent 擋住
  // 30s TTL → 使用者停止捲動後那批永遠不翻,造成留言區交錯漏翻。
  // 改成只把「本輪實際要翻的 ≤MAX_UNITS 個」標 seen;overflow 不標,下一輪 rescan
  // 仍能重新收進來。
  function capUnitsAndMarkSeen(units, now) {
    const capped = units.length > SK.SPA_OBSERVER_MAX_UNITS;
    const kept = capped ? units.slice(0, SK.SPA_OBSERVER_MAX_UNITS) : units;
    kept.forEach(unit => spaObserverSeenTexts.set(unitText(unit), now));
    return { kept, capped };
  }
  SK._capUnitsAndMarkSeen = capUnitsAndMarkSeen;

  async function spaObserverRescan() {
    spaObserverDebounceTimer = null;
    if (!STATE.translated) {
      SK.sendLog('info', 'spa', 'SPA rescan fired but STATE.translated=false, skipping');
      return;
    }
    // v1.8.5: 「只翻文章開頭」啟用時,SPA observer 偵測到新內容也不翻 — 使用者明確只想要文章開頭。
    if (STATE.partialModeActive) {
      SK.sendLog('info', 'spa', 'partialMode: skip SPA observer rescan');
      return;
    }
    if (spaObserverRescanCount >= SK.SPA_OBSERVER_MAX_RESCANS) {
      SK.sendLog('info', 'spa', 'SPA observer: reached max rescans, stopping NEW translations only', { maxRescans: SK.SPA_OBSERVER_MAX_RESCANS });
      return;
    }
    spaObserverRescanCount++;

    let newUnits = SK.collectParagraphs();
    if (STATE.translatedMode === 'dual' && SK.consolidateDualInlineUnits) {
      newUnits = SK.consolidateDualInlineUnits(newUnits);
    }
    if (newUnits.length === 0) {
      SK.sendLog('info', 'spa', `SPA rescan #${spaObserverRescanCount}: collectParagraphs returned 0 units (all already attribute-marked or filtered)`);
      return;
    }

    // by-text reuse:對 element unit 用原 textContent 查 STATE.translatedHTMLByText,命中
    // 直接 reuse 既有譯文 inject 進新 element + 加 attribute + 補 STATE.translatedHTML,
    // 從 newUnits 移除。修「Twitter / Reddit / Threads virtualization unmount + remount 全新
    // element 重翻」bug。0 API 成本,且譯文跟初翻一致(避免 cache miss 重打 API 譯文略差)。
    {
      const { reused, remaining } = SK.spaByTextReuse(newUnits);
      if (reused.length > 0) {
        SK.sendLog('info', 'spa', `SPA rescan #${spaObserverRescanCount}: by-text reuse ${reused.length} units (no API call)`);
      }
      newUnits = remaining;
      if (newUnits.length === 0) {
        SK.sendLog('info', 'spa', `SPA rescan #${spaObserverRescanCount}: all units served from by-text cache, no API`);
        return;
      }
    }

    // v1.2.1: 過濾掉 TTL 內已翻譯過的文字,防止頁面 widget 週期性重設 DOM 造成無限迴圈。
    // TTL 過期允許重 inject(典型場景:YouTube hover 把譯文抹回原文後使用者重 hover)。
    newUnits = newUnits.filter(unit => !isSeenTextRecent(unitText(unit)));
    if (newUnits.length === 0) {
      SK.sendLog('info', 'spa', 'SPA observer rescan: all units already seen in this session, skipping');
      return;
    }
    // 在翻譯前先記錄,防止注入自身觸發的 mutation 再次進入迴圈;TTL 內第二次出現會被擋住。
    // v1.10.15:cap 與標記 seen 順序修正——只把「本輪實際要翻的 ≤MAX_UNITS 個」標進
    // seenTexts(見 capUnitsAndMarkSeen),overflow 不標,留給下一輪 rescan。
    const now = Date.now();
    const totalFound = newUnits.length;
    const { kept, capped } = capUnitsAndMarkSeen(newUnits, now);
    newUnits = kept;
    if (capped) {
      SK.sendLog('warn', 'spa', 'SPA observer rescan capped', { found: totalFound, cap: SK.SPA_OBSERVER_MAX_UNITS });
      // overflow 沒標 seen,但下一輪 rescan 仍要靠 mutation 觸發;使用者已停止捲動時
      // 無新 mutation → overflow 卡住不翻。主動再 arm 一次 rescan 把剩下的接住
      // (本輪 50 則注入完成 + 下一輪 collectParagraphs 會重新抓到那些未標記的 element)。
      armSpaObserverRescan();
    }

    SK.sendLog('info', 'spa', `SPA observer rescan #${spaObserverRescanCount}`, { newUnits: newUnits.length });
    // v1.9.28:watchdog 用 t0 計時(loading toast 顯示 30s 沒結束 → dump 診斷)
    const _watchdog_t0 = performance.now();
    // 延後顯示 loading toast,避開「cache hit 場景 streaming fast path < 50ms 完成 silent」
    // 造成的 flash:timer 在 translateUnits 結束時 clearTimeout 取消;真送 API 通常 >
    // delay 才會 fire 顯示。
    //
    // v1.9.27:「tiny rescan 不彈 loading toast」— X 滑到串尾,X 對推文內嵌的 link
    // card / OG preview / 推文 metadata 等小元素 lazy mount 進 DOM,SPA observer 抓到
    // 1 個 < 100 char 的新 unit 送 API,toast「翻譯新內容 1/1 18 秒」對使用者體感雜訊
    // 極差(SPEC-PRIVATE §25.20.6)。tiny rescan(1-2 unit 且總字數 < 200)走靜默翻譯
    // 不彈 loading toast;翻完成功才彈 success(2s 自動消)。
    //
    // v1.9.27:delay 從 200ms → 800ms(SPEC-PRIVATE §25.20.7)。原 200ms 對「純 cache
    // hit」夠快但對「混合 cache + 1 API」仍會 flash 顯示 loading toast。Jimmy 要求
    // 「cache 的內容不顯示 toast」。延長到 800ms 把「混合 cache + 1 API 短譯文」這類
    // 場景也涵蓋(SW cache lookup + 1 短 API call 通常 < 800ms)。純 API 翻 3+ 段才會
    // 撐到 800ms 後彈 loading toast 給 user 看進度。Trade-off:純 API 但很快(< 800ms)
    // 完成的 rescan 也不彈 loading,user 看到內容變中文足夠回饋。
    const totalChars = newUnits.reduce((sum, u) => sum + (unitText(u).length || 0), 0);
    const isTinyRescan = newUnits.length <= 2 && totalChars < 200;
    // v1.9.28:loading toast 改成「lazy fire on first onProgress」。
    // Why:原 800ms 後無條件 showToast('loading', '0/N', startTimer) 在 SW sleep /
    // stream hang case → 0/N 永遠不變、timer 一路跑到 timeout(8s 仍嫌長)。
    // 改成只有 onProgress 真的有進度進來時才彈,沒進度進來(SW 沒回應)→
    // 完全不彈 toast → silent timeout 8s 後悄悄收場,user 體感無干擾。
    let loadingShown = false;
    let watchdogTimer = null;
    const loadingTimer = null; // 不再用 800ms 預先彈 toast,改 lazy
    const tryShowLoadingToast = (d, t) => {
      if (loadingShown || isTinyRescan) return;
      loadingShown = true;
      SK.showToast('loading', SK.t('toast.translateNew', { done: d, total: t }), { progress: d / t, startTimer: true });
      // watchdog 在 loading toast 真的顯示後才 schedule(8s timeout 已足夠 cover,watchdog 30s 仍保留作極端 case 紀錄)
      watchdogTimer = setTimeout(() => {
        const diag = {
          rescanId: spaObserverRescanCount,
          dt: Math.round(performance.now() - _watchdog_t0),
          prescan: typeof SK._prescanDebug === 'function' ? SK._prescanDebug() : null,
          spa: typeof SK._spaDebug === 'function' ? SK._spaDebug() : null,
          stateTranslating: STATE.translating,
          hasAbort: !!STATE.abortController,
          newUnitsSample: newUnits.slice(0, 3).map(u => (u.el?.innerText || '').trim().slice(0, 40)),
        };
        SK.sendLog('warn', 'spa', 'rescan watchdog: 30s no progress', diag);
      }, 30000);
    };
    // v1.9.28:onProgress race guard。await return / catch 後 set true,後續
    // SW 殘留 STREAMING_PROGRESS message 觸發的 onProgress 不再蓋 success/error toast。
    let _progressClosed = false;
    // v1.9.28:總體 8s timeout 兜底。Root cause:MV3 SW 30s idle 後 sleep,sleep 期間
    // in-flight stream.donePromise 等不到 STREAMING_DONE message 永遠 pending,
    // 用戶看到「翻譯新內容 0/4 8 分 40 秒」這種 toast 卡死。
    // 8s 涵蓋 Gemini stream typical firstChunk 1.2s + response ~5s(SPEC-PRIVATE
    // §25.20.4),正常 rescan 不誤殺;SW sleep / stream hang 異常 case 最多 8s
    // toast 就 silent hide,user 體感「過去了沒翻到」遠優於「卡 30 秒進度 0」。
    // timeout → silent hide toast,不彈 error(避免假錯誤打擾);user 滑回該 viewport
    // 時下一次 SPA mutation 會重新 trigger rescan,by-text reuse 命中即可補上譯文。
    const _RESCAN_TIMEOUT_MS = 8000;
    try {
      const { done, failures, pageUsage } = await Promise.race([
        SK.translateUnitsByProvider(newUnits, {
          onProgress: (d, t) => {
            if (_progressClosed) return;
            // v1.9.28:lazy fire loading toast,只有真的有進度進來才彈
            tryShowLoadingToast(d, t);
            // toast 已 show 後持續 update progress
            if (loadingShown) {
              SK.showToast('loading', SK.t('toast.translateNew', { done: d, total: t }), { progress: d / t });
            }
          },
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('SK_RESCAN_TIMEOUT')), _RESCAN_TIMEOUT_MS)),
      ]);
      _progressClosed = true;
      clearTimeout(loadingTimer);
      if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
      if (!STATE.translated) return;
      if (done > 0) {
        SK.sendLog('info', 'spa', `SPA observer rescan #${spaObserverRescanCount} done`, { done, failures: failures.length });
        const failedCount = failures.length;
        const decision = pickRescanToast({ done, failedCount, pageUsage, totalRequested: newUnits.length, isTinyRescan });
        if (decision.type === 'silent') {
          // loading toast 從未顯示就直接 silent;只有當它已 fire 才需 hideToast
          if (loadingShown) SK.hideToast();
        } else if (decision.type === 'error') {
          SK.showToast('error', decision.msg, { stopTimer: true });
        } else {
          SK.showToast('success', decision.msg, { progress: 1, stopTimer: true, autoHideMs: 2000 });
        }
      }
    } catch (err) {
      _progressClosed = true;
      clearTimeout(loadingTimer);
      if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
      if (err.message === 'SK_RESCAN_TIMEOUT') {
        // SW sleep / stream hang 兜底:silent hide,不彈 error toast(假錯誤體感差)。
        // 下一次 SPA mutation 觸發 rescan + by-text reuse 命中可補上。
        SK.sendLog('warn', 'spa', 'SPA rescan 30s timeout, silent hide', { units: newUnits.length });
        if (loadingShown) SK.hideToast();
      } else {
        SK.sendLog('warn', 'spa', 'SPA observer rescan failed', { error: err.message });
        SK.showToast('error', SK.t('toast.translateNewFailed', { error: err.message }), { stopTimer: true });
      }
    }
  }

  // ─── 頁面離開時取消進行中的翻譯 ──────────────────────
  window.addEventListener('beforeunload', () => {
    if (STATE.translating && STATE.abortController) {
      STATE.abortController.abort();
    }
  });

})(window.__SK);
