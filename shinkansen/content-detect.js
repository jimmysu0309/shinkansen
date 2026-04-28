// content-detect.js — Shinkansen 段落偵測
// 負責語言偵測、容器排除、段落收集（collectParagraphs）、fragment 抽取。

(function(SK) {
  if (!SK || SK.disabled) return;  // v1.5.2: iframe gate（見 content-ns.js）

  // ─── v0.76: 自動語言偵測 ─────────────────────────────────
  const SIMPLIFIED_ONLY_CHARS = new Set(
    '们这对没说还会为从来东车长开关让认应该头电发问时点学两' +
    '乐义习飞马鸟鱼与单亲边连达远运进过选钱铁错阅难页题风' +
    '饭体办写农决况净减划动务区医华压变号叶员围图场坏块' +
    '声处备够将层岁广张当径总战担择拥拨挡据换损摇数断无旧显' +
    '机权条极标样欢残毕气汇沟泽浅温湿灭灵热爱状独环现盖监盘' +
    '码确离种积称穷竞笔节范药虑虽见规览计订训许设评识证诉试' +
    '详语误读调贝负贡财贫购贸费赶递邮释银锁门间隐随雾静须领' +
    '颜饮驱验鸡麦龙龟齿齐复'
  );

  const NON_CHINESE_LANG_PREFIX = /^(ja|ko)\b/i;

  SK.isTraditionalChinese = function isTraditionalChinese(text) {
    const htmlLang = document.documentElement.lang || '';
    if (NON_CHINESE_LANG_PREFIX.test(htmlLang)) return false;

    const lettersOnly = text.replace(/[\s\d\p{P}\p{S}]/gu, '');
    if (lettersOnly.length === 0) return false;

    let cjkCount = 0;
    let simpCount = 0;
    let kanaCount = 0;

    for (const ch of lettersOnly) {
      const code = ch.codePointAt(0);
      if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF)) {
        cjkCount++;
        if (SIMPLIFIED_ONLY_CHARS.has(ch)) simpCount++;
      }
      if ((code >= 0x3040 && code <= 0x309F) || (code >= 0x30A0 && code <= 0x30FF)) {
        kanaCount++;
      }
    }

    if (kanaCount > 0 && kanaCount / lettersOnly.length > 0.05) return false;
    if (cjkCount / lettersOnly.length < 0.5) return false;
    if (cjkCount > 0 && simpCount / cjkCount >= 0.2) return false;
    return true;
  };

  function isCandidateText(el) {
    // v1.6.9: textContent 取代 innerText——innerText 觸發 layout 重算（每呼叫一次
    // 都 force layout reflow，在 leaf div/span 全頁掃描路徑會被呼叫上千次）。
    // textContent 純讀字串樹不 force layout。差異：textContent 包含 display:none
    // 子樹文字；但 isVisible 在多處已過濾隱藏祖先，剩餘 edge case 僅是「父可見、
    // 子隱藏」混排（極罕見），對長度/語言判斷不足以改變結果。
    const text = el.textContent?.trim();
    if (!text || text.length < 2) return false;
    if (SK.isTraditionalChinese(text)) return false;
    if (!/[\p{L}]/u.test(text)) return false;
    return true;
  }

  // ─── 容器排除 ─────────────────────────────────────────

  function isContentFooter(el) {
    if (!el || el.tagName !== 'FOOTER') return false;
    if (el.querySelector('.wp-block-query, .wp-block-post-title, .wp-block-post')) return true;
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
      if (cur.tagName === 'ARTICLE' || cur.tagName === 'MAIN') return true;
      cur = cur.parentElement;
    }
    return false;
  }

  // v1.6.9: 加入 memo 參數做 per-call cache。原版每次從 el 走到 body
  // 是 O(depth)，在 walker acceptNode + 三條 querySelectorAll 補抓路徑被
  // 重複呼叫,實測同一個祖先鏈會被走過數百次。Map<el, bool> 把每個祖先
  // 第一次計算後的結果記下,後續任何後代命中即 O(1) 短路。memo 為純函式
  // 結果緩存（DOM 在單次 collectParagraphs 內不變動），語意完全等價。
  function isInsideExcludedContainer(el, memo) {
    if (memo && memo.has(el)) return memo.get(el);

    const visited = [];
    let cur = el;
    let result = false;
    while (cur && cur !== document.body) {
      if (memo && memo.has(cur)) {
        result = memo.get(cur);
        break;
      }
      visited.push(cur);

      const tag = cur.tagName;
      if (tag === 'FOOTER' && isContentFooter(cur)) {
        cur = cur.parentElement;
        continue;
      }
      if (tag && SK.SEMANTIC_CONTAINER_EXCLUDE_TAGS.has(tag)) { result = true; break; }
      // v1.5.2: 祖先若是 dual 模式注入的譯文 wrapper,整段 skip。
      // acceptNode 流程已用 HARD_EXCLUDE_TAGS 擋住 wrapper 子樹,
      // 但 leaf content div/span / anchor / grid td 三條補抓路徑用
      // querySelectorAll 繞過 TreeWalker,必須在這裡再擋一次。
      if (tag === 'SHINKANSEN-TRANSLATION') { result = true; break; }
      const role = cur.getAttribute && cur.getAttribute('role');
      if (role && SK.EXCLUDE_ROLES.has(role)) { result = true; break; }
      if (tag === 'HEADER' && role === 'banner') { result = true; break; }
      if (cur.getAttribute && cur.getAttribute('contenteditable') === 'true') { result = true; break; }
      if (role === 'textbox') { result = true; break; }
      cur = cur.parentElement;
    }

    if (memo) {
      for (const v of visited) memo.set(v, result);
    }
    return result;
  }

  function isInteractiveWidgetContainer(el) {
    if (!el.querySelector('button, [role="button"]')) return false;
    // v1.6.9: 此處刻意保留 innerText（不改 textContent）。語意上「>=300 字
    // 視為非 widget」要的是「使用者實際看得到的字數」,改成 textContent 會把
    // 隱藏 modal/menu/dropdown 的字也算進來,可能讓本應被視為 widget 的元件
    // 通過篩選被翻譯。Twitter / Gmail 這類站常見,風險過大。此函式只在 walker
    // accept 路徑被呼叫一次/element,非熱點。
    const textLen = (el.innerText || '').trim().length;
    if (textLen >= 300) return false;
    return true;
  }

  // v1.4.9 Case B helpers
  function hasBrChild(el) {
    for (const child of el.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'BR') return true;
    }
    return false;
  }

  function directTextLength(el) {
    let total = 0;
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) total += child.nodeValue.trim().length;
    }
    return total;
  }

  // ─── Fragment 抽取 ────────────────────────────────────

  function extractInlineFragments(el) {
    const fragments = [];
    const children = Array.from(el.childNodes);
    let runStart = null;
    let runEnd = null;

    const flushRun = () => {
      if (!runStart) return;
      let text = '';
      let n = runStart;
      while (n) {
        text += n.textContent || '';
        if (n === runEnd) break;
        n = n.nextSibling;
      }
      const trimmed = text.trim();
      // v1.2.0: 已翻譯成繁中的 fragment 不再重複收集
      // （fragment 注入後父元素不帶 data-shinkansen-translated，
      //   若不在此過濾，SPA observer rescan 會無限迴圈）
      if (trimmed.length >= 2 && SK.isTraditionalChinese(trimmed)) {
        runStart = null;
        runEnd = null;
        return;
      }
      if (/[A-Za-zÀ-ÿ\u0400-\u04FF\u3400-\u9fff0-9]/.test(text)) {
        fragments.push({
          kind: 'fragment',
          el,
          startNode: runStart,
          endNode: runEnd,
        });
      }
      runStart = null;
      runEnd = null;
    };

    for (const child of children) {
      if (SK.isInlineRunNode(child)) {
        if (!runStart) runStart = child;
        runEnd = child;
      } else {
        flushRun();
      }
    }
    flushRun();
    return fragments;
  }

  // ─── collectParagraphs ────────────────────────────────

  SK.collectParagraphs = function collectParagraphs(root, stats) {
    root = root || document.body;
    stats = stats || null;

    const results = [];
    const seen = new Set();
    const fragmentExtracted = new Set();
    // v1.6.9: per-call memo for isInsideExcludedContainer。整個 collectParagraphs
    // 期間 DOM 不變,同一祖先鏈只算一次。
    const excludedMemo = new Map();

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (SK.HARD_EXCLUDE_TAGS.has(el.tagName)) {
          if (stats) stats.hardExcludeTag = (stats.hardExcludeTag || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        if (el.tagName === 'PRE' && el.querySelector('code')) {
          if (stats) stats.hardExcludeTag = (stats.hardExcludeTag || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        if (el.hasAttribute('data-shinkansen-translated')) {
          if (stats) stats.alreadyTranslated = (stats.alreadyTranslated || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        // v1.1.9: 統一使用 BLOCK_TAGS_SET.has() 取代舊版 BLOCK_TAGS.includes()
        if (!SK.BLOCK_TAGS_SET.has(el.tagName)) {
          if (stats) stats.notBlockTag = (stats.notBlockTag || 0) + 1;
          // v1.4.7 / v1.4.9: 非 block-tag 容器（DIV、SECTION 等）的補抓邏輯。
          // 典型案例：XenForo <div class="bbWrapper">
          //   Case A: "intro"<br>"Pros:"<ul><li>...</li></ul>"Overall..."
          //   Case B: "段落一"<br><br>"段落二"
          // DIV 不在 BLOCK_TAGS_SET → 以前直接 FILTER_SKIP，text node 完全不可見。
          if (!fragmentExtracted.has(el) && !isInsideExcludedContainer(el, excludedMemo)) {
            let hasDirectText = false;
            for (const child of el.childNodes) {
              if (child.nodeType === Node.TEXT_NODE && child.nodeValue.trim().length >= 2) {
                hasDirectText = true;
                break;
              }
            }
            if (hasDirectText && SK.containsBlockDescendant(el)) {
              // Case A (v1.4.7)：有 block 子孫 → 抽 inline fragment
              fragmentExtracted.add(el);
              const frags = extractInlineFragments(el);
              for (const f of frags) {
                results.push(f);
                seen.add(f.startNode);
                if (stats) stats.fragmentUnit = (stats.fragmentUnit || 0) + 1;
              }
            } else if (
              // Case B (v1.4.9)：純文字 + BR、無 block 子孫 → 整體當 element 單元
              // 4 個條件全成立才匹配，避免誤抓 inline element / leaf-content-div / nav 短連結
              // / 麵包屑（每條對應一個既有 spec：detect-leaf-content-div /
              // detect-nav-anchor-threshold / detect-nav-content）
              SK.CONTAINER_TAGS.has(el.tagName) &&
              !seen.has(el) &&
              hasBrChild(el) &&
              directTextLength(el) >= 20 &&
              isCandidateText(el)
            ) {
              results.push({ kind: 'element', el });
              seen.add(el);
              if (stats) stats.containerWithBr = (stats.containerWithBr || 0) + 1;
            } else if (
              // Case C (v1.4.19)：container 有直接文字 + inline 元素（如 <a>），
              // 無 block 子孫、無 BR → 抽 inline fragment
              // 典型案例：XenForo bbWrapper "<p>text</p>" 以外的純行內段落：
              //   "There is actually <a>some evidence</a> to support..."
              // Case A 因 !containsBlock 失敗，Case B 因 !hasBR 失敗 → 整段被跳過。
              // directTextLength >= 20 確保非 nav 短連結（nav 的文字在 <a> 內，直接文字長度趨近 0）
              SK.CONTAINER_TAGS.has(el.tagName) &&
              !seen.has(el) &&
              hasDirectText &&
              directTextLength(el) >= 20 &&
              isCandidateText(el)
            ) {
              fragmentExtracted.add(el);
              const frags = extractInlineFragments(el);
              for (const f of frags) {
                results.push(f);
                seen.add(f.startNode);
                if (stats) stats.inlineMixedFragment = (stats.inlineMixedFragment || 0) + 1;
              }
            }
          }
          return NodeFilter.FILTER_SKIP;
        }
        if (isInsideExcludedContainer(el, excludedMemo)) {
          if (stats) stats.excludedContainer = (stats.excludedContainer || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        if (!SK.WIDGET_CHECK_EXEMPT_TAGS.has(el.tagName) && isInteractiveWidgetContainer(el)) {
          if (stats) stats.interactiveWidget = (stats.interactiveWidget || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        if (!SK.isVisible(el)) {
          if (stats) stats.invisible = (stats.invisible || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        // v1.4.20: block element 同時有功能性媒體（img/picture/video）＋CONTAINER_TAGS 直屬子容器
        // = 媒體卡片模式（附件清單、圖片庫 item）。
        // 若整體收進來翻，injectIntoTarget 走 clean-slate 會清空所有子元素（含 img），
        // 圖片直接消失。改為 FILTER_SKIP，讓 walker 往裡找真正可翻的葉節點。
        // 典型案例：XenForo 附件 LI：li > [a.file-preview > img, div.file-content]
        // 注意：刻意用 img/picture/video 而非 containsMedia（後者含 svg/canvas/audio），
        // 避免誤傷含 SVG icon 的標題（如 Substack h2.header-anchor-post 內有 SVG + div.anchor）。
        //
        // v1.5.7: 排除 H1–H6。HTML5 語意上 heading 永遠是「標題」，不會是 grid item /
        // 附件清單卡片。WordPress 主題（如 nippper.com）會把 hero 圖塞進 <h1> 內：
        //   <h1><img class="wp-post-image"><div><span>標題文字</span></div></h1>
        // 這結構直屬子節點是 [IMG, DIV]，不加 heading exclusion 會被 mediaCardSkip 誤殺，
        // 整個 H1 跳過、標題完全不翻。判定條件用 tag name 規範（語意層）而非站點 class，
        // 屬於結構性通則（CLAUDE.md 硬規則 §8）。
        if (
          !/^H[1-6]$/.test(el.tagName) &&
          el.querySelector('img, picture, video') &&
          Array.from(el.children).some(c => SK.CONTAINER_TAGS.has(c.tagName))
        ) {
          if (stats) stats.mediaCardSkip = (stats.mediaCardSkip || 0) + 1;
          return NodeFilter.FILTER_SKIP;
        }
        if (SK.containsBlockDescendant(el)) {
          if (stats) stats.hasBlockDescendant = (stats.hasBlockDescendant || 0) + 1;
          if (!fragmentExtracted.has(el)) {
            fragmentExtracted.add(el);
            const frags = extractInlineFragments(el);
            for (const f of frags) {
              results.push(f);
              seen.add(f.startNode);
              if (stats) stats.fragmentUnit = (stats.fragmentUnit || 0) + 1;
            }
          }
          return NodeFilter.FILTER_SKIP;
        }
        if (!isCandidateText(el)) {
          if (stats) stats.notCandidateText = (stats.notCandidateText || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        // v1.4.17: Block element 有 CONTAINER_TAGS 直屬子容器，且容器內有直屬 <A> 連結時，
        // 改為只捕捉 <A> 連結本身（而非整個 block）。
        // 原因：若把整個 block（如 TD）當一個翻譯單元，injectIntoTarget 走 clean-slate 路徑
        // 會清空 TD 的全部子元素，包含不需翻譯的相鄰容器（如 TD > DIV.smallfont > SPAN.author）。
        // 典型案例：vBulletin forumdisplay：
        //   td > div → a[thread_title] + div.smallfont → span(author)
        // Gemini 翻完 thread title 後 slot 1（作者名）被丟掉 → clean-slate 把整個 TD 清空
        // → 作者 ID 消失。改為只翻 A 連結，TD 結構完全保留。
        if (!fragmentExtracted.has(el)) {
          const containerKids = Array.from(el.children).filter(c =>
            SK.CONTAINER_TAGS.has(c.tagName));
          if (containerKids.length > 0) {
            let capturedLinks = 0;
            for (const container of containerKids) {
              for (const child of Array.from(container.children)) {
                if (child.tagName !== 'A') continue;
                if (seen.has(child)) continue;
                if (child.hasAttribute('data-shinkansen-translated')) continue;
                if (!SK.isVisible(child)) continue;
                if (!isCandidateText(child)) continue;
                results.push({ kind: 'element', el: child });
                seen.add(child);
                capturedLinks++;
                if (stats) stats.blockContainerLink = (stats.blockContainerLink || 0) + 1;
              }
            }
            if (capturedLinks > 0) {
              fragmentExtracted.add(el);
              if (stats) stats.skipBlockWithContainer = (stats.skipBlockWithContainer || 0) + 1;
              return NodeFilter.FILTER_SKIP;
            }
          }
        }
        if (stats) stats.acceptedByWalker = (stats.acceptedByWalker || 0) + 1;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      results.push({ kind: 'element', el: node });
      seen.add(node);
    }

    // 補抓 selector 指定的特殊元素
    document.querySelectorAll(SK.INCLUDE_BY_SELECTOR).forEach(el => {
      if (seen.has(el)) return;
      if (el.hasAttribute('data-shinkansen-translated')) return;
      if (isInsideExcludedContainer(el, excludedMemo)) return;
      if (isInteractiveWidgetContainer(el)) return;
      if (!SK.isVisible(el)) return;
      if (!isCandidateText(el)) return;
      if (stats) stats.includedBySelector = (stats.includedBySelector || 0) + 1;
      results.push({ kind: 'element', el });
    });

    // v0.42: leaf content anchor 補抓
    document.querySelectorAll('a').forEach(a => {
      if (seen.has(a)) return;
      if (a.hasAttribute('data-shinkansen-translated')) return;
      let cur = a.parentElement;
      let hasBlockAncestor = false;
      while (cur && cur !== document.body) {
        if (SK.BLOCK_TAGS_SET.has(cur.tagName)) { hasBlockAncestor = true; break; }
        cur = cur.parentElement;
      }
      if (hasBlockAncestor) return;
      if (SK.containsBlockDescendant(a)) return;
      if (isInsideExcludedContainer(a, excludedMemo)) return;
      if (isInteractiveWidgetContainer(a)) return;
      if (!SK.isVisible(a)) return;
      if (!isCandidateText(a)) return;
      // v1.6.9: textContent 取代 innerText（避免 layout reflow）
      const txt = (a.textContent || '').trim();
      if (txt.length < 20) return;
      if (stats) stats.leafContentAnchor = (stats.leafContentAnchor || 0) + 1;
      results.push({ kind: 'element', el: a });
      seen.add(a);
    });

    // v1.0.8: leaf content element 補抓（CSS-in-JS 框架）
    // v1.6.9: 收緊 selector 為 :not(:has(*))——只抓「無 element 子節點」的 div/span,
    // 把過濾從 JS forEach 路徑下放到原生 CSS engine。長頁（Wikipedia / 論壇）原本
    // querySelectorAll('div, span') 可能回傳幾萬個 element,新版只回傳數百個葉節點,
    // 後續 isVisible / textContent / isCandidateText 等檢查減少 95% 以上呼叫次數。
    // :has() 支援:Chrome 105+ / Firefox 121+ / Safari 15.4+,皆已是 stable 多年。
    document.querySelectorAll('div:not(:has(*)), span:not(:has(*))').forEach(d => {
      if (seen.has(d)) return;
      if (d.hasAttribute('data-shinkansen-translated')) return;
      // d.children.length > 0 過濾已由 :not(:has(*)) selector 取代,移除
      let cur = d.parentElement;
      let hasBlockAncestor = false;
      while (cur && cur !== document.body) {
        if (SK.BLOCK_TAGS_SET.has(cur.tagName)) { hasBlockAncestor = true; break; }
        cur = cur.parentElement;
      }
      if (hasBlockAncestor) return;
      if (isInsideExcludedContainer(d, excludedMemo)) return;
      if (isInteractiveWidgetContainer(d)) return;
      if (!SK.isVisible(d)) return;
      if (!isCandidateText(d)) return;
      // v1.6.9: textContent 取代 innerText
      const txt = (d.textContent || '').trim();
      if (txt.length < 20) return;
      if (stats) stats.leafContentDiv = (stats.leafContentDiv || 0) + 1;
      results.push({ kind: 'element', el: d });
      seen.add(d);
    });

    // v1.0.22: grid cell leaf text 補抓
    document.querySelectorAll('table[role="grid"] td').forEach(td => {
      // v1.6.9: textContent 取代 innerText
      const tdText = (td.textContent || '').trim();
      if (tdText.length < 20) return;
      if (td.hasAttribute('data-shinkansen-translated')) return;

      td.querySelectorAll('*').forEach(el => {
        if (seen.has(el)) return;
        if (el.hasAttribute('data-shinkansen-translated')) return;

        for (const child of el.children) {
          if ((child.textContent || '').trim().length >= 15) return;
        }

        const text = (el.textContent || '').trim();
        if (text.length < 15) return;

        if (!SK.isVisible(el)) return;
        if (!isCandidateText(el)) return;

        if (stats) stats.gridCellLeaf = (stats.gridCellLeaf || 0) + 1;
        results.push({ kind: 'element', el });
        seen.add(el);
      });
    });

    return results;
  };

  // ─── 術語表輸入萃取 ──────────────────────────────────

  SK.extractGlossaryInput = function extractGlossaryInput(units) {
    const parts = [];
    const title = document.title?.trim();
    if (title) parts.push(title);

    for (const unit of units) {
      const el = unit.kind === 'fragment' ? unit.parent : unit.el;
      if (!el) continue;
      const tag = el.tagName;

      if (/^H[1-6]$/.test(tag)) {
        const txt = el.innerText?.trim();
        if (txt) parts.push(txt);
        continue;
      }

      if (tag === 'FIGCAPTION' || tag === 'CAPTION') {
        const txt = el.innerText?.trim();
        if (txt) parts.push(txt);
        continue;
      }

      const fullText = el.innerText?.trim();
      if (!fullText) continue;
      const sentenceMatch = fullText.match(/^[^.!?。！？]*[.!?。！？]/);
      const firstSentence = sentenceMatch ? sentenceMatch[0] : fullText.slice(0, 200);
      if (firstSentence.length >= 10) {
        parts.push(firstSentence);
      }
    }

    return parts.join('\n');
  };

  // ─── v1.7.1+: 翻譯優先級排序(v1.7.2 加入 tier 0 細分) ──────────
  // 把「使用者最想看的內容」推到 array 前面,讓 batch 0 翻譯完成時視覺上是
  // 「文章開頭變中文」而不是「導覽列變中文」。本函式只重排 array 順序,
  // 不過濾任何單元——所有 unit 都還是會翻,只是時序不同。
  //
  // tier 0:祖先含 <main>/<article> + readability score >= 5 → 文章核心(高信心)
  // tier 1:祖先含 <main>/<article> + score < 5 → 工具列 / tab(GitHub UI、Wikipedia
  //         閱讀工具切換等。框架把 chrome 也塞進語意 main 容器的常見問題)
  // tier 2:祖先無 main/article + 文字長度 ≥ 80 + 連結密度 < 0.5 → 一般內文段落
  // tier 3:其他 → 短連結 / nav / 補抓出來的零碎元素
  //
  // V8 的 Array.prototype.sort 自 2018 起為 stable sort(Chrome 70+),
  // 同 tier 內維持原 DOM 順序——TreeWalker 走過的次序保留,只是把高 tier 推前。
  // 注入用 element reference,不依賴 array index → 排序不影響注入位置。
  //
  // readability score 借用 Mozilla Readability 的評分啟發式,只取結構訊號(文字長度、
  // 逗號數、heading tag、含 P 子孫),刻意不用 class/id 名稱啟發式——避免命中
  // 「ca-nstab-main」這類含 main 字眼但實際是 chrome 的元素(符合硬規則 §8 結構通則)。
  function readabilityScore(el) {
    if (!el) return 0;
    let score = 0;
    const text = el.textContent || '';
    score += text.length / 100;                                    // 文字長度
    score += (text.match(/[,,]/g) || []).length;                   // 逗號數(內文訊號,nav/tab 通常無逗號)
    if (/^H[1-3]$/.test(el.tagName)) score += 5;                   // 標題 tag 加分
    if (el.querySelector && el.querySelector('p')) score += 3;     // 含 <p> 子孫加分
    return score;
  }

  SK.prioritizeUnits = function prioritizeUnits(units) {
    const tierCache = new Map();

    function computeTier(unit) {
      // fragment 用 unit.el(parent block,符合 extractInlineFragments push 結構);
      // element 用 unit.el。兩者統一。
      const el = unit.el;
      if (!el || !el.parentElement) return 3;

      // 祖先檢查:HTML5 語意 tag 或 ARIA role
      let cur = el.parentElement;
      let inMainOrArticle = false;
      while (cur && cur !== document.body) {
        const tag = cur.tagName;
        if (tag === 'MAIN' || tag === 'ARTICLE') { inMainOrArticle = true; break; }
        const role = cur.getAttribute && cur.getAttribute('role');
        if (role === 'main' || role === 'article') { inMainOrArticle = true; break; }
        cur = cur.parentElement;
      }

      if (inMainOrArticle) {
        // tier 0/1 細分:用 readability score 切「真內文」vs「main 內的工具列」
        return readabilityScore(el) >= 5 ? 0 : 1;
      }

      // 祖先沒 main/article:用文字長度 + 連結密度判斷
      const text = (el.textContent || '').trim();
      if (text.length < 80) return 3;
      let linkChars = 0;
      const anchors = el.querySelectorAll ? el.querySelectorAll('a') : [];
      for (const a of anchors) linkChars += (a.textContent || '').length;
      if (text.length > 0 && linkChars / text.length >= 0.5) return 3;
      return 2;
    }

    for (const u of units) tierCache.set(u, computeTier(u));
    return units.slice().sort((a, b) => tierCache.get(a) - tierCache.get(b));
  };

  SK.isUnitInViewport = function isUnitInViewport(unit) {
    const el = unit?.el;
    if (!el || typeof el.getClientRects !== 'function') return false;
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (vw <= 0 || vh <= 0) return false;

    for (const rect of el.getClientRects()) {
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      if (rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw) return true;
    }
    return false;
  };

})(window.__SK);
