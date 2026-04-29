// content-inject.js — Shinkansen DOM 注入
// 負責把翻譯結果注入回 DOM：resolveWriteTarget、injectIntoTarget、
// replaceNodeInPlace、replaceTextInPlace、plainTextFallback、fragment 注入。

(function(SK) {
  if (!SK || SK.disabled) return;  // v1.5.2: iframe gate（見 content-ns.js）

  const STATE = SK.STATE;

  /**
   * 保證同一個 element 只快照一次原始 innerHTML。
   */
  SK.snapshotOnce = function snapshotOnce(el) {
    if (!STATE.originalHTML.has(el)) {
      STATE.originalHTML.set(el, el.innerHTML);
    }
  };

  /**
   * 「注入目標解析」——回答「要把譯文寫到哪個元素?」
   * 預設值是 el 本身。唯一例外：el 自己 computed font-size 趨近 0（MJML 模板）。
   */
  function resolveWriteTarget(el) {
    const win = el.ownerDocument?.defaultView;
    const cs = win?.getComputedStyle?.(el);
    const px = cs ? parseFloat(cs.fontSize) : NaN;
    if (Number.isFinite(px) && px < 1) {
      const walker = el.ownerDocument.createTreeWalker(
        el,
        NodeFilter.SHOW_ELEMENT,
        {
          acceptNode(node) {
            if (node === el) return NodeFilter.FILTER_SKIP;
            if (SK.isPreservableInline(node) || SK.isAtomicPreserve(node)) {
              return NodeFilter.FILTER_REJECT;
            }
            const dcs = win?.getComputedStyle?.(node);
            const dpx = dcs ? parseFloat(dcs.fontSize) : NaN;
            if (Number.isFinite(dpx) && dpx >= 1) {
              return NodeFilter.FILTER_ACCEPT;
            }
            return NodeFilter.FILTER_SKIP;
          },
        }
      );
      const found = walker.nextNode();
      if (found) return found;
    }
    return el;
  }

  /**
   * 「注入」helper——回答「要怎麼把譯文寫進 target?」
   * (A) Clean slate 預設：清空 target 後 append content。
   * (B) Media-preserving 例外：target 含媒體元素，且無 CONTAINER_TAGS 直屬子元素時，
   *     就地替換最長文字節點（保留媒體位置）。
   *     若 target 有 DIV/SECTION 等容器直屬子元素（如 vBulletin TD > DIV+HR+DIV），
   *     文字節點分散於不同結構子容器，media-preserving 路徑會把譯文塞進最長文字
   *     所在的子容器，導致其他結構元素（HR、標題 DIV）殘留在錯誤位置（HR 跑到標題上面）。
   *     這種情況改走 clean-slate，讓 deserialize 後的 fragment 依正確順序填入 target。
   *     （v1.4.14 修正 vBulletin 論壇貼文標題翻譯後分隔線位置顛倒）
   */
  function injectIntoTarget(target, content) {
    const isString = typeof content === 'string';

    // (B) 條件：含媒體 && (target 是 heading [H1-H6] || target 無 CONTAINER_TAGS 直屬子元素)
    //
    // v1.5.7: heading 例外。WordPress 主題（如 nippper.com）會把 hero 圖塞進 <h1> 內：
    //   <h1><img class="wp-post-image"><div><span>標題</span></div></h1>
    // hasContainerChild 在這 case 是 true（DIV 是 CONTAINER），原本會走 (A) clean slate
    // 把 IMG 一起清掉。但 heading 結構通常很簡單（單一 wrapper 包文字），不會有
    // 「文字節點分散在多個結構容器」的 vBulletin 情境，所以強制走 (B) media-preserving
    // 把譯文塞進最長文字節點、IMG 保留位置不動。
    // 用 tag name 規範（HTML5 語意層）判斷不是站點 class，屬結構性通則（CLAUDE.md §8）。
    const isHeading = /^H[1-6]$/.test(target.tagName);
    const hasContainerChild = Array.from(target.children).some(c =>
      SK.CONTAINER_TAGS.has(c.tagName));
    if (SK.containsMedia(target) && (isHeading || !hasContainerChild)) {
      // (B) media-preserving path
      if (!isString) {
        let fragHasBr = false;
        const fw = document.createTreeWalker(content, NodeFilter.SHOW_ELEMENT);
        let fn;
        while ((fn = fw.nextNode())) {
          if (fn.tagName === 'BR') { fragHasBr = true; break; }
        }
        if (fragHasBr) {
          const oldBrs = target.querySelectorAll('br');
          for (const br of oldBrs) if (br.parentNode) br.parentNode.removeChild(br);
        }
      }
      const node = isString ? target.ownerDocument.createTextNode(content) : content;
      const textNodes = SK.collectVisibleTextNodes(target);
      if (textNodes.length === 0) {
        target.appendChild(node);
        return;
      }
      const main = SK.findLongestTextNode(textNodes);
      for (const t of textNodes) {
        if (t === main) continue;
        t.nodeValue = '';
        // v1.2.2: 清空文字後，若父 inline 元素（如 <a>）因此變成空殼，向上逐層移除，
        // 避免留下看不見的空連結殼（Gmail Team Picks 連結消失 bug 的根因）
        let p = t.parentNode;
        while (p && p !== target) {
          if (p.textContent.trim() === '' && !SK.containsMedia(p)) {
            const gp = p.parentNode;
            if (!gp) break;
            gp.removeChild(p);
            p = gp;
          } else {
            break;
          }
        }
      }
      const parent = main.parentNode;
      if (parent) {
        parent.insertBefore(node, main);
        parent.removeChild(main);
      } else {
        target.appendChild(node);
      }
      return;
    }

    // (A) clean slate path
    while (target.firstChild) target.removeChild(target.firstChild);
    if (isString) {
      target.textContent = content;
    } else {
      target.appendChild(content);
    }
  }

  /**
   * 把含 \n 的純文字譯文做成 DocumentFragment。
   */
  function buildFragmentFromTextWithBr(text) {
    const frag = document.createDocumentFragment();
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]) frag.appendChild(document.createTextNode(parts[i]));
      if (i < parts.length - 1) frag.appendChild(document.createElement('br'));
    }
    return frag;
  }

  /**
   * slot 配對失敗 fallback 用的純文字注入。
   */
  function plainTextFallback(el, cleaned) {
    const target = resolveWriteTarget(el);
    injectIntoTarget(target, cleaned);
  }

  /**
   * 無 slots 路徑的純文字注入。
   */
  function replaceTextInPlace(el, translation) {
    if (translation && translation.includes('\n')) {
      const frag = buildFragmentFromTextWithBr(translation);
      replaceNodeInPlace(el, frag);
      return;
    }
    const target = resolveWriteTarget(el);
    injectIntoTarget(target, translation);
  }

  /**
   * slots 路徑的 fragment 注入。
   */
  function replaceNodeInPlace(el, frag) {
    const target = resolveWriteTarget(el);
    injectIntoTarget(target, frag);
  }

  // ─── 主注入函式 ───────────────────────────────────────

  /**
   * ok=false fallback: LLM 丟掉佔位符時，嘗試從原始 DOM 找回 <a> slot 的文字，
   * 在譯文中重新定位並包回 <a> 標籤，還原連結結構。
   * 僅處理 <a> slot；slot 文字必須完整出現在譯文中才做，否則 return null。
   *
   * 範例（Dhruv Team Picks）：
   *   原文: "Dhruv's been having fun with this little ⟦0⟧Kodak Charmera⟦/0⟧ keychain."
   *   LLM 回: "Dhruv 最近都在玩這個超可愛的 Kodak Charmera 鑰匙圈。"  (slot 丟掉)
   *   → 找到 "Kodak Charmera" → frag: TEXT + A("Kodak Charmera") + TEXT
   */
  function tryRecoverLinkSlots(el, text, slots) {
    // 找出所有 <a> slot 的 index
    const linkSlotIdxs = [];
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s && s.nodeType === Node.ELEMENT_NODE && s.tagName === 'A') {
        linkSlotIdxs.push(i);
      }
    }
    if (linkSlotIdxs.length === 0) return null;

    // 從原始 DOM 取得每個 <a> 的原始文字（按 DOM 順序）
    const originalAnchors = Array.from(el.querySelectorAll('a'));

    let remaining = text;
    const parts = [];
    let anyFound = false;
    let slotPtr = 0;

    for (const anchor of originalAnchors) {
      const linkText = (anchor.textContent || '').trim();
      if (linkText.length < 2) continue; // 太短容易誤判
      const pos = remaining.indexOf(linkText);
      if (pos === -1) continue; // 找不到則跳過，不強行猜位置

      const matchIdx = linkSlotIdxs[slotPtr];
      if (matchIdx === undefined) continue;

      if (pos > 0) parts.push({ type: 'text', content: remaining.slice(0, pos) });
      parts.push({ type: 'link', content: linkText, slotIdx: matchIdx });
      remaining = remaining.slice(pos + linkText.length);
      anyFound = true;
      slotPtr++;
    }

    if (!anyFound) return null;
    if (remaining) parts.push({ type: 'text', content: remaining });

    // 建立 DocumentFragment
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (part.type === 'text') {
        if (part.content) frag.appendChild(document.createTextNode(part.content));
      } else {
        const shell = slots[part.slotIdx].cloneNode(false);
        shell.appendChild(document.createTextNode(part.content));
        frag.appendChild(shell);
      }
    }
    return frag;
  }

  SK.injectTranslation = function injectTranslation(unit, translation, slots) {
    if (!translation) return;
    // v1.4.8: 統一在注入入口規範化字面 \n（反斜線+n，兩字元）→ 真正換行符（U+000A）。
    // v1.4.6 在 deserializeWithPlaceholders（有 slots 路徑）加了同樣的規範化，
    // 但 fragment no-slots / element no-slots 路徑完全繞過 deserializeWithPlaceholders，
    // 導致字面 \n 殘留可見 DOM 字元。在此入口統一處理，覆蓋所有後續路徑。
    if (translation.includes('\\n')) translation = translation.replace(/\\n/g, '\n');

    // v1.5.0: 雙語對照模式分派——dual 走 SK.injectDual 走另一條路徑。
    // 只 element 走得到 dual（fragment unit 結構特殊，dual 模式直接 fallback 走 single）。
    // 模式由 STATE.translatedMode 決定（translatePage 進入時依 settings.displayMode 設定）。
    if (STATE.translatedMode === 'dual' && unit.kind !== 'fragment' && SK.injectDual) {
      SK.injectDual(unit, translation, slots);
      return;
    }

    if (unit.kind === 'fragment') {
      return injectFragmentTranslation(unit, translation, slots);
    }
    const el = unit.el;
    SK.snapshotOnce(el);

    if (slots && slots.length > 0) {
      const { frag, ok } = SK.deserializeWithPlaceholders(translation, slots);
      if (ok) {
        replaceNodeInPlace(el, frag);
        el.setAttribute('data-shinkansen-translated', '1');
        STATE.translatedHTML.set(el, el.innerHTML);
        SK._guardObserveEl?.(el); // v1.8.20: 把新譯段註冊進 IO subset
        return;
      }
      const cleaned = SK.stripStrayPlaceholderMarkers(translation);
      // v1.2.3: ok=false 時，嘗試從原始 DOM 找回 <a> 連結文字並重建連結結構
      const recovered = tryRecoverLinkSlots(el, cleaned, slots);
      if (recovered) {
        replaceNodeInPlace(el, recovered);
        el.setAttribute('data-shinkansen-translated', '1');
        STATE.translatedHTML.set(el, el.innerHTML);
        SK._guardObserveEl?.(el);
        return;
      }
      plainTextFallback(el, cleaned);
      el.setAttribute('data-shinkansen-translated', '1');
      STATE.translatedHTML.set(el, el.innerHTML);
      SK._guardObserveEl?.(el);
      return;
    }

    replaceTextInPlace(el, translation);
    el.setAttribute('data-shinkansen-translated', '1');
    STATE.translatedHTML.set(el, el.innerHTML);
    SK._guardObserveEl?.(el);
  };

  function injectFragmentTranslation(unit, translation, slots) {
    if (!translation) return;
    const { el, startNode, endNode } = unit;

    if (!startNode || startNode.parentNode !== el) return;

    SK.snapshotOnce(el);

    let newContent;
    if (slots && slots.length > 0) {
      const { frag, ok } = SK.deserializeWithPlaceholders(translation, slots);
      if (ok) {
        newContent = frag;
      } else {
        const cleaned = SK.stripStrayPlaceholderMarkers(translation);
        newContent = document.createTextNode(cleaned);
      }
    } else {
      // v1.4.8: 無 slots 時也要把 \n 還原為 <br>（字面 \n 已在 injectTranslation 入口轉換完畢）
      if (translation.includes('\n')) {
        newContent = buildFragmentFromTextWithBr(translation);
      } else {
        newContent = document.createTextNode(translation);
      }
    }

    // v1.6.19: endNode 可能在 collectParagraphs 與 inject 之間被外部重排,
    // 不再是 el 的直接 child。沿用 endNode.nextSibling 當 anchor 會把 newContent
    // 加到 el 末尾(順序錯位)。anchor 必須是 el 的直接 child 才合法。
    const anchor = (endNode && endNode.parentNode === el) ? endNode.nextSibling : null;
    const toRemove = [];
    let cur = startNode;
    while (cur) {
      toRemove.push(cur);
      if (cur === endNode) break;
      cur = cur.nextSibling;
    }
    for (const n of toRemove) {
      if (n.parentNode === el) el.removeChild(n);
    }
    el.insertBefore(newContent, anchor);
    // v1.8.20: fragment 路徑也要寫 attribute + STATE.translatedHTML——
    // 否則 dual 模式下 fragment 段落 Content Guard 保護不到、SPA observer 重複偵測 → 重複翻譯。
    el.setAttribute('data-shinkansen-translated', '1');
    STATE.translatedHTML.set(el, el.innerHTML);
    SK._guardObserveEl?.(el);
  }

  // 暴露 resolveWriteTarget / injectIntoTarget 供 Debug API testInject 使用
  SK._resolveWriteTarget = resolveWriteTarget;
  SK._injectIntoTarget = injectIntoTarget;

  // ─── v1.5.0 雙語對照模式注入 ────────────────────────
  // 與 single 模式並列；single 走 SK.injectTranslation 的舊路徑，dual 走這裡。
  // 設計原則：
  //   1. 結構性判斷不綁站點/class（硬規則 §8）：依 tagName + computed display 決定 wrapper 形狀
  //   2. 不動原段落（原文保留），只在原段落旁/內附加 <shinkansen-translation> wrapper
  //   3. 透過既有 deserializeWithPlaceholders 重建譯文 inline 結構（連結、行內樣式都會保留）
  //   4. Content Guard 用 STATE.translationCache 追蹤 original → { wrapper, mode } 對應

  /** 找最近的 block 祖先（computed display ∈ BLOCK_DISPLAY_VALUES） */
  function findBlockAncestor(el) {
    const win = el.ownerDocument?.defaultView;
    let cur = el.parentElement;
    while (cur && cur !== el.ownerDocument.body) {
      const cs = win?.getComputedStyle?.(cur);
      if (cs && SK.BLOCK_DISPLAY_VALUES.has(cs.display)) return cur;
      cur = cur.parentElement;
    }
    return cur;  // body 或 null
  }
  // 暴露給 content-spa.js（Content Guard dual 分支）使用
  SK.findBlockAncestor = findBlockAncestor;

  /** 依原段落 tag 決定 wrapper 內部要用哪個 element */
  function buildDualInner(originalTag, originalEl, translation, slots) {
    let innerTag;
    if (/^H[1-6]$/.test(originalTag)) {
      innerTag = 'div';
    } else if (originalTag === 'LI' || originalTag === 'TD' || originalTag === 'TH') {
      innerTag = 'div';
    } else if (SK.BLOCK_TAGS_SET.has(originalTag) || originalTag === 'DIV' || originalTag === 'SECTION' || originalTag === 'ARTICLE' || originalTag === 'MAIN' || originalTag === 'ASIDE') {
      // 一般 block：保留原 tag（P, BLOCKQUOTE, DD, DT, FIGCAPTION, CAPTION, SUMMARY, PRE, FOOTER, DIV 等）
      innerTag = originalTag.toLowerCase();
    } else {
      // Inline 段落（SPAN/A/EM 等被偵測為段落時）
      innerTag = 'div';
    }
    const inner = document.createElement(innerTag);

    // v1.5.2: typography copy（涵蓋所有 dual 路徑）。
    // wrapper 在大多數情境下是原段落的 sibling（block tag 走 afterend、heading
    // 走 afterend、inline 走 afterend-block-ancestor），inner 也不在原段落裡，
    // 所以無法繼承到 BBC 等網站設在 `p`/`h1` selector 上的 paragraph typography——
    // 結果是雙語模式下譯文字型 / 字距 / 行距跟原段落差很多。
    // 主動 copy computed style 才能讓譯文視覺上對齊原段落。
    // LI/TD/TH 的 inner 雖然在原 cell 裡（已繼承），多 copy 一份 inline style
    // 結果一致、行為單純，照做。
    const win = originalEl.ownerDocument?.defaultView;
    const cs = win?.getComputedStyle?.(originalEl);
    if (cs) {
      if (cs.fontFamily)    inner.style.fontFamily    = cs.fontFamily;
      if (cs.fontSize)      inner.style.fontSize      = cs.fontSize;
      if (cs.fontWeight)    inner.style.fontWeight    = cs.fontWeight;
      if (cs.lineHeight)    inner.style.lineHeight    = cs.lineHeight;
      if (cs.letterSpacing) inner.style.letterSpacing = cs.letterSpacing;
      if (cs.color)         inner.style.color         = cs.color;
    }

    // 譯文內容：有 slots 走 deserializer 重建 inline 結構，否則純文字 / br fragment
    if (slots && slots.length > 0) {
      const result = SK.deserializeWithPlaceholders(translation, slots);
      if (result.ok) {
        inner.appendChild(result.frag);
      } else {
        // ok=false fallback：類似 single 路徑——盡力把連結 slot 還原回去
        const cleaned = SK.stripStrayPlaceholderMarkers(translation);
        const recovered = tryRecoverLinkSlots(originalEl, cleaned, slots);
        if (recovered) {
          inner.appendChild(recovered);
        } else {
          inner.appendChild(document.createTextNode(cleaned));
        }
      }
    } else if (translation.includes('\n')) {
      inner.appendChild(buildFragmentFromTextWithBr(translation));
    } else {
      inner.appendChild(document.createTextNode(translation));
    }
    return inner;
  }

  /**
   * 在「本次預期注入的位置」找已存在、譯文相符的 wrapper。
   *
   * v1.5.2 BBC SPA 重建 inline 段落 race condition 防護：
   * BBC News 等 React-driven 站點在初次 dual 注入後會把原 inline element（如
   * byline 的 <span>）整個用 cloneNode 替換掉。新 element 沒有
   * data-shinkansen-dual-source attribute（attribute 在「舊 element」上、舊
   * element 已不在 DOM），但「舊 wrapper」仍在 DOM——因為 wrapper 是更上層
   * block-ancestor 的 sibling，與 inline element 不同層，不會被替換連帶刪除。
   * MutationObserver 觸發 collectParagraphs 重掃時，injectDual 對「新 element」
   * 沒有去重保護，於是又注入第二個 wrapper；BBC 再 rerender 一次 → 第三個 wrapper
   * → DOM 上同位置疊出 N 層巢狀 wrapper（v1.5.2 BBC byline 三層觀察值）。
   *
   * 修法：注入前在「預期插入位置」掃一次。若該位置已有 SHINKANSEN-TRANSLATION
   * 且 textContent 與這次譯文相符，視為同一段已注入，skip 並把 cache key 從
   * 舊 element 換成新 element，讓 Content Guard 後續用新 element 追蹤。
   *
   * 比對方式：用 stripStrayPlaceholderMarkers 把譯文裡的 ⟦…⟧ 標記移除後 trim，
   * 跟 wrapper.textContent.trim() 比對全字串——因為 wrapper inner 的 textContent
   * 是 deserializer 還原後的純文字（slot 已展開），跟 translation 帶 markers 的
   * 原始字串不會 100% 一致，但移除 markers 後等價。
   */
  function findExistingWrapperAtInsertionPoint(original, tag, translation) {
    const wrapperTagUpper = SK.TRANSLATION_WRAPPER_TAG.toUpperCase();
    const winDoc = original.ownerDocument;
    let candidate = null;
    if (tag === 'LI' || tag === 'TD' || tag === 'TH') {
      // appendChild 模式：注入後 wrapper 是 original 最後一個 element child
      candidate = original.lastElementChild;
    } else if (
      SK.BLOCK_TAGS_SET.has(tag) ||
      tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE' || tag === 'MAIN' || tag === 'ASIDE'
    ) {
      // afterend 模式：wrapper 是 original 的下一個 element sibling
      candidate = original.nextElementSibling;
    } else {
      // inline：afterend-block-ancestor（找不到 block-ancestor 時 fallback 到 original）
      const blockAncestor = findBlockAncestor(original);
      const anchor = (blockAncestor && blockAncestor !== winDoc.body) ? blockAncestor : original;
      candidate = anchor.nextElementSibling;
    }
    if (!candidate || candidate.tagName !== wrapperTagUpper) return null;
    const expected = (SK.stripStrayPlaceholderMarkers
      ? SK.stripStrayPlaceholderMarkers(translation)
      : translation).trim();
    if (candidate.textContent.trim() !== expected) return null;
    return candidate;
  }

  /** 主入口：把譯文以雙語 wrapper 形式注入 DOM */
  SK.injectDual = function injectDual(unit, translation, slots) {
    if (!translation) return;
    // Fragment unit 結構特殊（虛擬段落 = 父容器內的「直接文字節點區段」），
    // 在 dual 模式下沒有清楚的「插在哪裡」答案——fallback 走 single 路徑。
    if (unit.kind === 'fragment') {
      return injectFragmentTranslation(unit, translation, slots);
    }
    const original = unit.el;
    if (!original || !original.parentNode) return;
    // 同一段已注入過就不要重複（SPA rescan 雙重觸發、Content Guard 觸發都會重打）
    if (original.hasAttribute('data-shinkansen-dual-source')) return;

    // v1.5.1: 祖孫同段去重——若祖先或後代已被 dual-source 標記過，表示「這段內容」
    // 已經有 wrapper，本元素 skip，避免同一段譯文連續疊多個 wrapper。
    //
    // 這是 collectParagraphs 在某些網站（例如 BBC author byline 區塊）抓到祖孫
    // element 都當成段落單元的問題——單語模式下後一次 in-place 注入會覆蓋前一次
    // 所以使用者看不到，雙語模式下每次都 append wrapper 所以疊三個被看到。
    // 真正根因在偵測層的祖孫同段重複（後續視真實樣本決定要不要動 collectParagraphs），
    // 但 dual 路徑必須先有這層防護不要把 detector bug 放大成可見的視覺爆炸。
    let anc = original.parentElement;
    while (anc && anc !== original.ownerDocument.body) {
      if (anc.hasAttribute && anc.hasAttribute('data-shinkansen-dual-source')) return;
      anc = anc.parentElement;
    }
    if (original.querySelector && original.querySelector('[data-shinkansen-dual-source]')) return;

    const tag = original.tagName;

    // v1.5.2: 同位置已存在譯文相符的 wrapper → skip 並把 cache key 換成 original
    // （見 findExistingWrapperAtInsertionPoint 註解：BBC SPA 重建 inline 段落
    // 後 attribute 不繼承造成的重複注入。）
    const existingWrapper = findExistingWrapperAtInsertionPoint(original, tag, translation);
    if (existingWrapper) {
      for (const [oldKey, info] of STATE.translationCache) {
        if (info.wrapper === existingWrapper) {
          STATE.translationCache.delete(oldKey);
          STATE.translationCache.set(original, info);
          SK._guardObserveEl?.(original); // v1.8.20: swap key 後新 key 要重新進 IO subset
          break;
        }
      }
      original.setAttribute('data-shinkansen-dual-source', '1');
      return;
    }

    const inner = buildDualInner(tag, original, translation, slots);
    const wrapper = original.ownerDocument.createElement(SK.TRANSLATION_WRAPPER_TAG);
    const mark = SK.currentMarkStyle && SK.VALID_MARK_STYLES.has(SK.currentMarkStyle)
      ? SK.currentMarkStyle
      : SK.DEFAULT_MARK_STYLE;
    wrapper.setAttribute('data-sk-mark', mark);
    wrapper.appendChild(inner);

    // v1.5.3: copy 原段落的水平 layout 屬性到 wrapper。
    // 真實案例（macstories.net Newsletter）：原 <p> 有 margin-left / padding-left
    // 把段落擠到頁面中段，wrapper 是 sibling、不繼承這些屬性，所以譯文拉滿整行
    // 跟原 <p> 不對齊。typography copy（v1.5.2）只搬字型相關 6 屬性，layout 沒搬。
    // 只 copy 水平方向：保留 wrapper 自有的「上下間距」（margin-top:0.25em CSS rule）
    // 與「不固定 width」（讓 wrapper 隨 parent 撐開），避免動到段間距與整體寬度。
    const winLayout = original.ownerDocument?.defaultView;
    const csLayout = winLayout?.getComputedStyle?.(original);
    if (csLayout) {
      if (csLayout.marginLeft)   wrapper.style.marginLeft   = csLayout.marginLeft;
      if (csLayout.marginRight)  wrapper.style.marginRight  = csLayout.marginRight;
      if (csLayout.paddingLeft)  wrapper.style.paddingLeft  = csLayout.paddingLeft;
      if (csLayout.paddingRight) wrapper.style.paddingRight = csLayout.paddingRight;
      if (csLayout.maxWidth && csLayout.maxWidth !== 'none') wrapper.style.maxWidth = csLayout.maxWidth;
    }

    let insertMode;
    if (tag === 'LI' || tag === 'TD' || tag === 'TH') {
      original.appendChild(wrapper);
      insertMode = 'append';
    } else if (
      SK.BLOCK_TAGS_SET.has(tag) ||
      tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE' || tag === 'MAIN' || tag === 'ASIDE'
    ) {
      original.insertAdjacentElement('afterend', wrapper);
      insertMode = 'afterend';
    } else {
      // Inline 段落：往上找最近 block 祖先
      const blockAncestor = findBlockAncestor(original);
      if (blockAncestor && blockAncestor !== original.ownerDocument.body) {
        blockAncestor.insertAdjacentElement('afterend', wrapper);
        insertMode = 'afterend-block-ancestor';
      } else {
        // 找不到合理祖先，掛在 inline 自身後（次佳）
        original.insertAdjacentElement('afterend', wrapper);
        insertMode = 'afterend';
      }
    }

    original.setAttribute('data-shinkansen-dual-source', '1');
    STATE.translationCache.set(original, { wrapper, insertMode });
    SK._guardObserveEl?.(original); // v1.8.20: dual 路徑也要進 IO subset
  };

  /** 還原 dual 模式：移除所有 wrapper、清乾淨 attribute（restorePage 雙語分支用） */
  SK.removeDualWrappers = function removeDualWrappers() {
    const tag = SK.TRANSLATION_WRAPPER_TAG;
    document.querySelectorAll(tag).forEach(n => n.remove());
    document.querySelectorAll('[data-shinkansen-dual-source]').forEach(el => {
      el.removeAttribute('data-shinkansen-dual-source');
    });
  };

  /** 全域 wrapper 樣式注入（content.css 跨 host 行為不可靠，inline style 才能保證生效） */
  SK.ensureDualWrapperStyle = function ensureDualWrapperStyle() {
    if (document.getElementById('shinkansen-dual-style')) return;
    const tag = SK.TRANSLATION_WRAPPER_TAG;
    const style = document.createElement('style');
    style.id = 'shinkansen-dual-style';
    // 樣式設計原則：display:block 確保 wrapper 自成一行；mark 用 attribute selector 區分
    // v1.5.3: dashed 從「底部虛線」（block border-bottom 只在最後一行出現、跟連結
    // 底線易混淆）改為「波浪底線」（每行字底下都有，跟連結直線底線視覺區分）。
    // mark value 保留 'dashed' 不改名，避免 storage migration 問題；只改視覺實作。
    style.textContent =
      `${tag} { display: block; margin-top: 0.25em; }\n` +
      `${tag}[data-sk-mark="tint"]   { background-color: #FFF8E1; padding: 2px 4px; }\n` +
      `${tag}[data-sk-mark="bar"]    { border-left: 2px solid #9CA3AF; padding-left: 8px; }\n` +
      `${tag}[data-sk-mark="dashed"] { text-decoration: underline wavy #C7CDD3; text-decoration-thickness: 1px; text-underline-offset: 4px; }\n` +
      `${tag}[data-sk-mark="none"]   {}\n`;
    (document.head || document.documentElement).appendChild(style);
  };

})(window.__SK);
