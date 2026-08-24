// content-hover.js — 按住修飾鍵 + 指標懸停 → 翻譯游標所在的段落
// 兩組修飾鍵各對應一種顯示方式：一組出浮動提示（不動 DOM），另一組就地套用
(function (SK) {
  'use strict';
  if (!SK || SK.disabled) return;
  if (SK.isEmbeddedPlayerFrame?.(document, window)) return;

  const SC = window.__SKShortcuts;
  if (!SC) return;
  if (SK._hoverTranslateInstalled) return;
  SK._hoverTranslateInstalled = true;

  const DEBOUNCE_MS = 300;
  const CACHE_MAX = 200;
  // 429 之後的冷卻：繼續打只會讓限流一直續期
  const COOLDOWN_MS = 60_000;
  // 段落字數上限——findBlockAncestor 可能落在整篇文章的容器上，
  // 沒上限的話一次 hover 就把整篇送進翻譯
  const MAX_BLOCK_CHARS = 4000;
  // 浮動提示不能捲動（host 是 pointer-events: none），超過這個長度的段落
  // 譯文塞不進畫面，直接不顯示
  const MAX_TOOLTIP_CHARS = 1200;
  // caret hit-test 會強制同步 layout，每幀最多做一次
  const HITTEST_MIN_MS = 16;
  const TOOLTIP_Z = 2147483646;

  // 兩組都沒綁鍵時整個功能關閉——pointermove 的快速 return 用這個旗標
  let enabled = false;
  let tooltipModifier = SC.sanitizeHoverModifier(null);
  let inlineModifier = SC.sanitizeHoverModifier(null);
  // null / 'tooltip' / 'inline'——按下的是哪一組修飾鍵
  let armedMode = null;
  let displayMode = 'single';
  let markStyle = null;
  let dualAccent = null;

  let pendingTimer = 0;
  let lastHitTestAt = 0;
  let lastTextKey = '';
  let lastBlock = null;
  let inflightKey = '';
  let requestGen = 0;
  let cooldownUntil = 0;
  let cooldownMsg = '';
  // 原文 → 譯文；游標在同一段來回掃時不重打 API
  const cache = new Map();

  let host = null;
  let tooltipEl = null;
  let msgEl = null;
  // tooltip 量測值：內容變更才重量，避免每次 move 都 write-then-read 觸發 layout
  let tipW = 0;
  let tipH = 0;

  function shouldActivate(e) {
    if (!enabled) return false;
    if (e && e.pointerType === 'touch') return false;
    return true;
  }

  function hideTooltipVisual() {
    if (host) host.style.display = 'none';
    if (tooltipEl) tooltipEl.classList.remove('show', 'loading', 'error');
  }

  function hideTooltip() {
    hideTooltipVisual();
    clearTimeout(pendingTimer);
    inflightKey = '';
    requestGen += 1;
  }

  function resetHover() {
    hideTooltip();
    lastTextKey = '';
    lastBlock = null;
  }

  function disarm() {
    armedMode = null;
    resetHover();
  }

  // 兩組都比對：先浮動提示再就地套用。單選 + modifiersMatchEvent 要求四個旗標
  // 精確相等，所以兩組不會互相誤觸，同時按住兩個鍵也不會命中任何一組。
  function updateArmFromEvent(e) {
    const next = !shouldActivate(e) ? null
      : SC.modifiersMatchEvent(e, tooltipModifier) ? 'tooltip'
        : SC.modifiersMatchEvent(e, inlineModifier) ? 'inline'
          : null;
    if (next === armedMode) return;
    armedMode = next;
    // 換組或放開時把上一輪的狀態收乾淨
    resetHover();
  }

  function ensureHost() {
    if (host) return true;
    try {
      host = document.createElement('div');
      host.id = 'shinkansen-hover-host';
      host.style.cssText = 'all: initial; position: fixed; z-index: ' + TOOLTIP_Z + '; display: none; pointer-events: none;';
      const shadow = host.attachShadow({ mode: 'closed' });
      const cssText =
        ':host, * { box-sizing: border-box; }' +
        '.tip { position: fixed; display: none; max-width: min(320px, calc(100vw - 40px)); min-width: 120px;' +
        // 段落譯文可能很長，host 是 pointer-events: none 沒辦法捲，先擋住不讓它爆出畫面
        ' max-height: 50vh; overflow: hidden;' +
        ' padding: 10px 12px; background: #fff; color: #1d1d1f; border-radius: 10px;' +
        ' box-shadow: 0 8px 28px rgba(0,0,0,.18); font: 13px -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif; line-height: 1.45; }' +
        '.tip.show { display: block; }' +
        '.tip.loading { color: #86868b; }' +
        '.tip.error { color: #ff3b30; }';
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(cssText);
        shadow.adoptedStyleSheets = [sheet];
      } catch (_) {
        const style = document.createElement('style');
        style.textContent = cssText;
        shadow.appendChild(style);
      }
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'tip';
      tooltipEl.setAttribute('role', 'tooltip');
      tooltipEl.setAttribute('aria-live', 'polite');
      msgEl = document.createElement('div');
      tooltipEl.appendChild(msgEl);
      shadow.appendChild(tooltipEl);
      document.documentElement.appendChild(host);
      return true;
    } catch (_) {
      host = null;
      return false;
    }
  }

  function positionTooltip(clientX, clientY) {
    if (!tooltipEl || !host) return;
    const pad = 12;
    const offset = 14;
    host.style.display = 'block';
    tooltipEl.classList.add('show');
    // 尺寸只在文字換過之後量一次，之後跟著游標移動都用快取值
    if (!tipW || !tipH) {
      const rect = tooltipEl.getBoundingClientRect();
      tipW = rect.width;
      tipH = rect.height;
    }
    let left = clientX + offset;
    let top = clientY + offset;
    if (left + tipW > window.innerWidth - pad) left = Math.max(pad, clientX - tipW - offset);
    if (top + tipH > window.innerHeight - pad) top = Math.max(pad, clientY - tipH - offset);
    tooltipEl.style.left = left + 'px';
    tooltipEl.style.top = top + 'px';
  }

  function t(key) {
    return (typeof SK.t === 'function') ? SK.t(key) : key;
  }

  function showState(state, text, x, y) {
    if (!ensureHost()) return;
    tooltipEl.classList.remove('loading', 'error');
    if (state === 'loading') {
      tooltipEl.classList.add('loading');
      msgEl.textContent = text || t('hover.tooltip.loading');
    } else if (state === 'error') {
      tooltipEl.classList.add('error');
      msgEl.textContent = text || t('hover.tooltip.error');
    } else {
      msgEl.textContent = text || '';
    }
    tipW = 0;
    tipH = 0;
    positionTooltip(x, y);
  }

  function caretHit(x, y) {
    const doc = document;
    let node = null;
    let offset = 0;
    if (typeof doc.caretPositionFromPoint === 'function') {
      const pos = doc.caretPositionFromPoint(x, y);
      if (pos) { node = pos.offsetNode; offset = pos.offset; }
    } else if (typeof doc.caretRangeFromPoint === 'function') {
      const range = doc.caretRangeFromPoint(x, y);
      if (range) { node = range.startContainer; offset = range.startOffset; }
    }
    if (!node) return null;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const kids = node.childNodes;
      const past = offset >= kids.length;
      const child = past ? kids[kids.length - 1] : kids[offset];
      if (child && child.nodeType === Node.TEXT_NODE) {
        node = child;
      } else {
        // 容器空白處：退回容器內第一個 text node
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const first = walker.nextNode();
        if (!first) return null;
        node = first;
      }
    }
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    if (!(node.textContent || '').trim()) return null;
    return node;
  }

  // 就地套用模式：找出游標所在的區塊元素，跳過已翻過的段落與譯文 wrapper 本身。
  // 只做 closest / findBlockAncestor，序列化留到去抖之後才做（它會走整棵子樹）。
  function blockAt(node) {
    const el = node?.parentElement;
    if (!el || typeof SK.findBlockAncestor !== 'function') return null;
    const wrapperTag = SK.TRANSLATION_WRAPPER_TAG;
    if (wrapperTag && el.closest(wrapperTag)) return null;
    if (el.closest('[data-shinkansen-translated], [data-shinkansen-dual-source]')) return null;
    const block = SK.findBlockAncestor(el);
    if (!block || block === document.body) return null;
    if (block.hasAttribute('data-shinkansen-translated')
      || block.hasAttribute('data-shinkansen-dual-source')) return null;
    return block;
  }

  // 浮動提示只要純文字：textContent 不像 innerText 會強制同步 layout，
  // 段落層級用它足夠（隱藏元素在正文段落裡罕見）
  function blockText(block) {
    return (block.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // 就地套用要序列化那條（placeholder + slots），段落內的連結／粗體才能在譯文還原
  function serializeBlock(block) {
    if (typeof SK.serializeWithPlaceholders === 'function') {
      const { text, slots } = SK.serializeWithPlaceholders(block);
      return { text: (text || '').trim(), slots };
    }
    return { text: (block.innerText || block.textContent || '').trim(), slots: [] };
  }

  // 套用全文翻譯的顯示模式：single = 取代原文，dual = 雙語對照
  function injectInline(target, translation) {
    if (!target?.el?.isConnected) return;
    const unit = { kind: 'element', el: target.el };
    if (displayMode !== 'dual') {
      SK.injectTranslation?.(unit, translation, target.slots);
      return;
    }
    // 使用者沒跑過全文翻譯時，這兩個全域還沒被 content.js 設過
    SK.currentMarkStyle = (markStyle && SK.VALID_MARK_STYLES?.has(markStyle))
      ? markStyle : SK.DEFAULT_MARK_STYLE;
    SK.currentDualAccent = SK.sanitizeDualAccent?.(dualAccent) ?? 'auto';
    SK.ensureDualWrapperStyle?.();
    SK.injectDual?.(unit, translation, target.slots);
  }

  async function requestTranslate(text, x, y, target) {
    const key = text;
    if (key === inflightKey) return;
    if (Date.now() < cooldownUntil) {
      showState('error', cooldownMsg, x, y);
      return;
    }
    inflightKey = key;
    const gen = ++requestGen;
    showState('loading', null, x, y);

    try {
      const resp = await SK.safeSendMessage({
        type: 'TRANSLATE_BATCH',
        payload: { texts: [sentence] },
      });
      // 先存快取再判丟棄——被丟棄的回應仍是有效譯文，丟掉等於白花一次配額
      if (resp?.ok && resp.result?.[0]) {
        if (cache.size >= CACHE_MAX) cache.clear();
        cache.set(key, resp.result[0]);
      } else if (/\b429\b/.test(String(resp?.error || ''))) {
        cooldownUntil = Date.now() + COOLDOWN_MS;
        cooldownMsg = (SK.i18n && typeof SK.i18n.bgErrorMessage === 'function')
          ? SK.i18n.bgErrorMessage(resp)
          : t('hover.tooltip.error');
      }
      // 就地套用的譯文要寫進頁面，不因游標移開而丟棄——只要目標段落還在 DOM
      if (target && resp?.ok && resp.result?.[0]) {
        hideTooltipVisual();
        injectInline(target, resp.result[0]);
        return;
      }
      if (gen !== requestGen || !armedMode || lastTextKey !== key) return;
      if (!resp?.ok || !resp.result?.[0]) {
        const errText = (SK.i18n && typeof SK.i18n.bgErrorMessage === 'function')
          ? SK.i18n.bgErrorMessage(resp)
          : t('hover.tooltip.error');
        showState('error', errText, x, y);
        return;
      }
      showState('success', resp.result[0], x, y);
    } catch (_) {
      if (gen === requestGen && armedMode && lastTextKey === key) showState('error', null, x, y);
    } finally {
      if (inflightKey === key) inflightKey = '';
    }
  }

  function showBlockTooltip(block, x, y) {
    if (!block.isConnected) return;
    const text = blockText(block);
    if (!text) return;
    if (text.length > MAX_TOOLTIP_CHARS) { showState('error', t('hover.tooltip.tooLong'), x, y); return; }
    lastTextKey = text;
    const cached = cache.get(text);
    if (cached) { showState('success', cached, x, y); return; }
    requestTranslate(text, x, y, null);
  }

  // 去抖之後才序列化 + 發請求：游標掃過途中的段落不會付出序列化與 API 成本
  function translateBlock(block, x, y) {
    if (!block.isConnected) return;
    const { text, slots } = serializeBlock(block);
    if (!text) return;
    if (text.length > MAX_BLOCK_CHARS) { showState('error', t('hover.tooltip.tooLong'), x, y); return; }
    lastTextKey = text;
    const target = { el: block, slots };
    const cached = cache.get(text);
    if (cached) { hideTooltipVisual(); injectInline(target, cached); return; }
    requestTranslate(text, x, y, target);
  }

  function onPointerMove(e) {
    if (!enabled || e.pointerType === 'touch') return;
    updateArmFromEvent(e);
    if (!armedMode) return;
    // caret hit-test 強制同步 layout，限制在每幀一次
    const now = e.timeStamp || Date.now();
    if (now - lastHitTestAt < HITTEST_MIN_MS) return;
    lastHitTestAt = now;

    const node = caretHit(e.clientX, e.clientY);
    if (!node) { resetHover(); return; }
    const block = blockAt(node);
    if (!block) { resetHover(); return; }
    // 同一段落內移動不重算——取文字／序列化都要走整棵子樹
    if (block === lastBlock) {
      if (tooltipEl && tooltipEl.classList.contains('show')) positionTooltip(e.clientX, e.clientY);
      return;
    }
    lastBlock = block;
    const x = e.clientX;
    const y = e.clientY;
    const inline = armedMode === 'inline';
    // 去抖：游標停下來才取文字並發請求，掃過途中的段落不付出成本
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(
      () => (inline ? translateBlock(block, x, y) : showBlockTooltip(block, x, y)), DEBOUNCE_MS);
  }

  // 按下／放開修飾鍵都重新判定是哪一組（或都不是）
  function onModifierKey(e) {
    if (SC.isModifierKeyCode(e.code)) updateArmFromEvent(e);
  }

  function applySettings(st) {
    tooltipModifier = SC.sanitizeHoverModifier(st.hoverTranslateModifier);
    inlineModifier = SC.sanitizeHoverModifier(st.hoverTranslateInlineModifier);
    const tipKey = SC.hoverModifierKey(tooltipModifier);
    // 兩組撞同一個鍵時停用第二組（options 端已互斥，這裡擋舊值／手改 storage）
    if (tipKey && tipKey === SC.hoverModifierKey(inlineModifier)) {
      inlineModifier = SC.sanitizeHoverModifier(null);
    }
    enabled = !!(tipKey || SC.hoverModifierKey(inlineModifier));
    displayMode = st.displayMode === 'dual' ? 'dual' : 'single';
    markStyle = st.translationMarkStyle || null;
    dualAccent = st.dualAccentColor || null;
    if (!enabled) disarm();
  }

  function loadSettings() {
    if (!browser?.storage?.sync) return;
    browser.storage.sync.get([
      'hoverTranslateModifier', 'hoverTranslateInlineModifier',
      'displayMode', 'translationMarkStyle', 'dualAccentColor',
    ]).then((st) => { applySettings(st || {}); }).catch(() => {});
  }

  // keydown / keyup 用 capture：頁面自己攔快速鍵時仍要能解除 armed 狀態
  window.addEventListener('keydown', onModifierKey, true);
  window.addEventListener('keyup', onModifierKey, true);
  window.addEventListener('blur', disarm);
  window.addEventListener('pointermove', onPointerMove, { passive: true, capture: true });

  if (browser.storage?.onChanged) {
    browser.storage.onChanged.addListener((ch, area) => {
      if (area !== 'sync') return;
      if ('hoverTranslateModifier' in ch || 'hoverTranslateInlineModifier' in ch
        || 'displayMode' in ch || 'translationMarkStyle' in ch || 'dualAccentColor' in ch) loadSettings();
    });
  }

  loadSettings();

  SK.hoverTranslate = {
    disarm,
    get armedMode() { return armedMode; },
    get enabled() { return enabled; },
  };
})(window.__SK);
