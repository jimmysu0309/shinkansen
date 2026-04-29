// content-spa.js — Shinkansen SPA 導航支援 + Content Guard
// 負責：SPA 導航偵測（History API 攔截 + URL 輪詢 + hashchange）、
// MutationObserver 動態段落偵測、Content Guard 週期性修復。

(function(SK) {
  if (!SK || SK.disabled) return;  // v1.5.2: iframe gate（見 content-ns.js）

  const STATE = SK.STATE;

  let spaLastUrl = location.href;
  let spaObserver = null;
  let spaObserverDebounceTimer = null;
  let spaObserverRescanCount = 0;
  let contentGuardInterval = null;
  const GUARD_SWEEP_INTERVAL_MS = 1000;

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
    stopSpaObserver();
    STATE.originalHTML.clear();
    STATE.translatedHTML.clear();
    STATE.cache.clear();
    STATE.translated = false;
    STATE._glossaryPromise = null;
    SK.safeSendMessage({ type: 'CLEAR_BADGE' }).catch(() => {});
    SK.hideToast();
    SK.sendLog('info', 'spa', 'SPA navigation detected, state reset', { url: location.href, stickyTranslate: STATE.stickyTranslate });
  }

  // ─── 自動翻譯網站名單比對 ────────────────────────────

  SK.isDomainWhitelisted = async function isDomainWhitelisted() {
    try {
      const { domainRules } = await browser.storage.sync.get('domainRules');
      if (!domainRules?.whitelist?.length) return false;
      const hostname = location.hostname;
      return domainRules.whitelist.some(pattern => {
        if (pattern.startsWith('*.')) {
          const suffix = pattern.slice(1);
          return hostname === pattern.slice(2) || hostname.endsWith(suffix);
        }
        return hostname === pattern;
      });
    } catch (err) {
      SK.sendLog('warn', 'system', 'isDomainWhitelisted: failed to read storage', { error: err.message });
      return false;
    }
  };

  // ─── SPA 導航處理 ────────────────────────────────────

  async function handleSpaNavigation() {
    const newUrl = location.href;
    if (newUrl === spaLastUrl) return;
    spaLastUrl = newUrl;
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
        SK.sendLog('info', 'spa', 'SPA nav: sticky translate active, auto-translating (no preset slot)', { url: location.href });
        SK.translatePage();
      }
      return;
    }

    try {
      const { autoTranslate = false, autoTranslateSlot } = await browser.storage.sync.get(['autoTranslate', 'autoTranslateSlot']);
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
  setInterval(() => {
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

  // v1.2.1: 記錄在此 SPA session 內已翻譯過的文字，避免 widget 週期性重設 DOM 造成無限循環
  const spaObserverSeenTexts = new Set();

  SK.startSpaObserver = function startSpaObserver() {
    if (spaObserver) return;
    spaObserverRescanCount = 0;
    spaObserverSeenTexts.clear();
    spaObserver = new MutationObserver(onSpaObserverMutations);
    spaObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
    if (!contentGuardInterval) {
      contentGuardInterval = setInterval(runContentGuard, GUARD_SWEEP_INTERVAL_MS);
    }
    initGuardIntersectionObserver();
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
    if (contentGuardInterval) {
      clearInterval(contentGuardInterval);
      contentGuardInterval = null;
    }
    if (spaObserver) {
      spaObserver.disconnect();
      spaObserver = null;
    }
    teardownGuardIntersectionObserver();
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
    // v1.5.0: dual 模式分派——監看 wrapper 被 SPA 刪除後 re-append。
    if (STATE.translatedMode === 'dual') {
      runContentGuardDual(false);
      return;
    }
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
      el.innerHTML = savedHTML;
      restored++;
    }
    if (restored > 0) {
      SK.sendLog('info', 'guard', `Content guard restored ${restored} overwritten nodes`);
    }
  }

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
          blockAncestor.insertAdjacentElement('afterend', wrapper);
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
    for (const [el, savedHTML] of STATE.translatedHTML) {
      if (!el.isConnected) continue;
      if (el.innerHTML === savedHTML) continue;
      // v1.5.5: 與 runContentGuard 對齊——編輯模式 contenteditable 元素不修復
      if (el.getAttribute('contenteditable') === 'true') continue;
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

  function onSpaObserverMutations(mutations) {
    if (!STATE.translated) { stopSpaObserver(); return; }
    if (spaObserverRescanCount >= SK.SPA_OBSERVER_MAX_RESCANS) return;

    const hasNewContent = mutations.some(m =>
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

    if (spaObserverDebounceTimer) clearTimeout(spaObserverDebounceTimer);
    spaObserverDebounceTimer = setTimeout(spaObserverRescan, SK.SPA_OBSERVER_DEBOUNCE_MS);
  }

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

  async function spaObserverRescan() {
    spaObserverDebounceTimer = null;
    if (!STATE.translated) return;
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
    if (newUnits.length === 0) return;

    // v1.2.1: 過濾掉此 SPA session 內已翻譯過的文字，防止頁面 widget 週期性重設 DOM 造成無限迴圈
    newUnits = newUnits.filter(unit => !spaObserverSeenTexts.has(unitText(unit)));
    if (newUnits.length === 0) {
      SK.sendLog('info', 'spa', 'SPA observer rescan: all units already seen in this session, skipping');
      return;
    }
    // 在翻譯前先記錄，防止注入自身觸發的 mutation 再次進入迴圈
    newUnits.forEach(unit => spaObserverSeenTexts.add(unitText(unit)));

    if (newUnits.length > SK.SPA_OBSERVER_MAX_UNITS) {
      SK.sendLog('warn', 'spa', 'SPA observer rescan capped', { found: newUnits.length, cap: SK.SPA_OBSERVER_MAX_UNITS });
      newUnits = newUnits.slice(0, SK.SPA_OBSERVER_MAX_UNITS);
    }

    SK.sendLog('info', 'spa', `SPA observer rescan #${spaObserverRescanCount}`, { newUnits: newUnits.length });
    SK.showToast('loading', `翻譯新內容… 0 / ${newUnits.length}`, { progress: 0, startTimer: true });
    try {
      const { done, failures } = await SK.translateUnits(newUnits, {
        onProgress: (d, t) => SK.showToast('loading', `翻譯新內容… ${d} / ${t}`, {
          progress: d / t,
        }),
      });
      if (!STATE.translated) return;
      if (done > 0) {
        SK.sendLog('info', 'spa', `SPA observer rescan #${spaObserverRescanCount} done`, { done, failures: failures.length });
        const failedCount = failures.length;
        if (failedCount > 0) {
          SK.showToast('error', `新內容翻譯部分失敗:${failedCount} / ${newUnits.length} 段`, { stopTimer: true });
        } else {
          SK.showToast('success', `已翻譯 ${done} 段新內容`, { progress: 1, stopTimer: true, autoHideMs: 2000 });
        }
      }
    } catch (err) {
      SK.sendLog('warn', 'spa', 'SPA observer rescan failed', { error: err.message });
      SK.showToast('error', `新內容翻譯失敗:${err.message}`, { stopTimer: true });
    }
  }

  // ─── 頁面離開時取消進行中的翻譯 ──────────────────────
  window.addEventListener('beforeunload', () => {
    if (STATE.translating && STATE.abortController) {
      STATE.abortController.abort();
    }
  });

})(window.__SK);
