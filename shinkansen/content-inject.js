// content-inject.js — Shinkansen DOM 注入
// 負責把翻譯結果注入回 DOM：resolveWriteTarget、injectIntoTarget、
// replaceNodeInPlace、replaceTextInPlace、plainTextFallback、fragment 注入。

(function(SK) {
  if (!SK || SK.disabled) return;  // v1.5.2: iframe gate（見 content-ns.js）

  const STATE = SK.STATE;

  /**
   * 保證同一個 element 只快照一次原始 innerHTML。
   * 同時 snapshot textContent 給 SPA observer 的「detect-replacement」路徑用——
   * 當框架（YouTube yt-attributed-string）整個 detach 譯後 element 再 add 一個英文
   * 新 element 時，mutation callback 用 originalText 比對 addedNodes 找回對應段落。
   */
  SK.snapshotOnce = function snapshotOnce(el) {
    if (!STATE.originalHTML.has(el)) {
      STATE.originalHTML.set(el, el.innerHTML);
    }
    if (!STATE.originalText.has(el)) {
      STATE.originalText.set(el, (el.textContent || '').trim());
    }
    if (!STATE.originalLang.has(el)) {
      STATE.originalLang.set(el, el.hasAttribute('lang') ? el.getAttribute('lang') : null);
    }
    if (!STATE.originalFontFamily.has(el)) {
      STATE.originalFontFamily.set(el, el.style.fontFamily || '');
    }
  };

  // v1.10.49: nv-mutate 元素的譯文紀錄(WeakMap el → { plain, raw, slots })。
  // Content Guard 在 framework「同內容重 render」把 backup text node 整批換新時
  // (Medium 劃線 highlight hydration 實測場景),用它直接重套譯文,不重打 API
  // (見 content-spa.js runContentGuardNvMutate)。restorePage 不需清:guard 以
  // STATE.nodeValueMutateBackup 為迭代來源,backup 項清掉後本表殘項只是等 GC 的孤兒。
  // v2.0.59: 由「只存純文字」擴充為同時存帶佔位符的原始譯文 + slots——A3 同構注入
  // 成功的段落(含 <a> 等 inline 結構),guard 重套若只有純文字可用,會走 slots=[] 的
  // Case 3b flatten:整段塞第一個 text node、其餘(含 <a> 內)清空 → 連結變空殼
  // (The Verge 重繪實測,2026-07-16)。存 raw + slots 讓重套能重走 A3 配對保留結構。
  // slots 是序列化端產物(cloneReuse deserialize 全 clone、不 mutate),跨多輪重套安全。
  function recordNvMutateTranslation(el, plain, raw, slots) {
    if (!el || !plain) return;
    if (!STATE.nvMutateTranslation) STATE.nvMutateTranslation = new WeakMap();
    const hasSlots = !!(raw && slots && slots.length > 0);
    STATE.nvMutateTranslation.set(el, {
      plain,
      raw: hasSlots ? raw : null,
      slots: hasSlots ? slots : null,
    });
  }

  // 注入時對 el 套 locale-aware 樣式:
  //   1. lang attribute 設為 STATE.targetLanguage(讓瀏覽器選對 CJK 字形變體)
  //   2. CJK target(ja / ko / zh-TW / zh-CN)時 prepend locale 字體到 inline fontFamily
  //      站點 hardcode 單一 locale 字體 stack(例 upmedia.mg "Noto Serif TC" 開頭)
  //      時,單純設 lang 救不了(瀏覽器停在第一順位字體不再 fallback);prepend 對應
  //      locale 字體讓瀏覽器優先選對 locale 字形。
  // Why prepend 而非取代:保留站點原 stack 當 fallback,系統沒裝 locale 字體時不影響
  //   顯示;有裝時前面字體會涵蓋 CJK codepoint → 用對 locale 字形變體。
  function applyTargetLocaleStyling(el) {
    const target = STATE.targetLanguage;
    if (!target || typeof target !== 'string') return;
    el.setAttribute('lang', target);

    const localeMap = SK.LOCALE_FONT_PREPEND && SK.LOCALE_FONT_PREPEND[target];
    if (!localeMap) return;

    // 只在 source locale ≠ target locale 時 prepend。同 locale 時站點 CSS 已選對
    // 字形變體,prepend 反而會強制覆寫站點 typography(例 zh-TW 站特意用 Noto Serif TC
    // 變成譯文段被換成 sans-serif PingFang TC)。source 未知(<html> 沒設 lang 或
    // 不認識的 code)也跳過 prepend——保守做法,避免在不確定的場景動站點 typography。
    // v2.0.78（批次 4 A2）：source lang 必須看「原始」宣告（docLangBackup.orig），
    // 對齊 detect 端 v2.0.76 同型修法（content-detect.js _foreignPage）——翻譯成功後
    // applyDocTargetLang 把 <html lang> 蓋成 target，讀 live lang 會讓 SPA rescan /
    // 晚載注入在這裡 pageLang === target 早退不 prepend → 晚載段落字形變體與首輪
    // 注入不一致（§8 舊路徑也要跟著更新的案例）。orig 為 null（原頁無宣告）時
    // 維持原本保守跳過。
    const doc = el.ownerDocument;
    const _langBackup = STATE.docLangBackup;
    const pageLang = SK.normalizeLangCode?.(
      _langBackup ? _langBackup.orig : doc?.documentElement?.lang,
    );
    if (!pageLang || pageLang === target) return;

    // base = 「我們動之前的 stack」:
    //   - 有 inline(dual mode buildDualInner 剛 copy 原段落 cs.fontFamily 進來,或
    //     站點對 el 寫死 inline style):直接用 inline 當 base
    //   - 無 inline:讀 computed(站點 CSS cascade 過來的 stack)
    const current = el.style.fontFamily || '';
    let base = current;
    if (!base) {
      const win = el.ownerDocument?.defaultView;
      const cs = win?.getComputedStyle?.(el);
      base = cs?.fontFamily || '';
    }

    // 偵測站點 stack 是 serif 還是 sans-serif,選對應 prepend stack。
    // 偵測必須用「我們動之前的 stack」(用 STATE.originalFontFamily 或 computed 反推),
    // 不能用 current(SPA 第二次 apply 時 current 已含我們的 prepend → 會用第一字體
    // 偵測誤判成 prepend 的風格 → idempotent 偵測歪)。優先 STATE.originalFontFamily
    // (snapshotOnce 記錄的原 inline);沒記錄時用 base。
    const originalForDetect = STATE.originalFontFamily.has(el)
      ? (STATE.originalFontFamily.get(el) || base)
      : base;
    const style = SK.detectFontStyle?.(originalForDetect) || 'sans-serif';
    const prepend = localeMap[style] || localeMap['sans-serif'];
    if (!prepend) return;

    // Idempotent guard:已經 prepend 過(SPA reapply / Content Guard 多次觸發),
    // 不再重複 prepend → 避免 stack 越疊越長。比對「第一字體名」(剝去引號)即可,
    // 不能直接 startsWith(prepend),因為瀏覽器會正規化 CSS string(例如把
    // `"Meiryo"` 簡化成 `Meiryo` 不必要引號),導致 setter 進去跟 getter 出來不字面相等。
    const stripQuotes = (s) => s.replace(/^["']|["']$/g, '').trim();
    const firstOf = (s) => stripQuotes((s.split(',')[0] || '').trim());
    if (firstOf(current) === firstOf(prepend)) return;

    el.style.fontFamily = base ? `${prepend}, ${base}` : prepend;
  }

  // v2.0.73:single mode 翻譯成功後把 <html lang> 設為 targetLanguage。
  // per-element lang(applyTargetLocaleStyling)只蓋注入段落,頁面層級 lang 是給
  // 讀「整份文件」的下游 scraper(Readwise Reader / Instapaper 等)與 a11y 工具看的。
  // 備份採 snapshot-once 語意:同頁多輪翻譯(ignorePartialMode 重翻等)不覆寫首次備份,
  // 還原永遠回到「Shinkansen 動手前」的值。dual mode 由呼叫端把關不進來。
  SK.applyDocTargetLang = function applyDocTargetLang() {
    const target = STATE.targetLanguage;
    if (!target || typeof target !== 'string') return;
    const root = document.documentElement;
    if (!root) return;
    if (STATE.docLangBackup === undefined) {
      STATE.docLangBackup = { orig: root.hasAttribute('lang') ? root.getAttribute('lang') : null };
    }
    root.setAttribute('lang', target);
  };

  // restorePage / SPA 導航用:還原 <html lang> 原值(null = 原本沒設,移除 attribute)。
  SK.restoreDocLang = function restoreDocLang() {
    if (STATE.docLangBackup === undefined) return;
    const root = document.documentElement;
    if (root) {
      if (STATE.docLangBackup.orig === null) root.removeAttribute('lang');
      else root.setAttribute('lang', STATE.docLangBackup.orig);
    }
    STATE.docLangBackup = undefined;
  };

  // restorePage / abort 路徑用:還原翻譯前的 lang attribute + inline fontFamily。
  // originalLang 為 null = 原本沒設 attribute,移除即可;originalFontFamily 空字串 =
  // 原本沒 inline style,設空字串會清掉 inline,重新繼承站點 CSS。
  SK.restoreLocaleStyling = function restoreLocaleStyling(el) {
    if (STATE.originalLang.has(el)) {
      const orig = STATE.originalLang.get(el);
      if (orig === null) el.removeAttribute('lang');
      else el.setAttribute('lang', orig);
    }
    if (STATE.originalFontFamily.has(el)) {
      el.style.fontFamily = STATE.originalFontFamily.get(el);
    }
  };

  /**
   * 「注入目標解析」——回答「要把譯文寫到哪個元素？」
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

    // (B) 條件:target 內單一文字區塊(textBearingChildCount <= 1)+ 有東西值得保留
    //         (媒體 OR 空結構占位子,後者對應 lazy-loaded media container)
    //         + (heading 例外 || 無 CONTAINER 子元素 || 有空結構占位子)
    //
    // v1.5.7: heading 例外。WordPress 主題（如 nippper.com）會把 hero 圖塞進 <h1> 內：
    //   <h1><img class="wp-post-image"><div><span>標題</span></div></h1>
    // hasContainerChild 在這 case 是 true（DIV 是 CONTAINER），原本會走 (A) clean slate
    // 把 IMG 一起清掉。但 heading 結構通常很簡單（單一 wrapper 包文字），不會有
    // 「文字節點分散在多個結構容器」的 vBulletin 情境，所以強制走 (B) media-preserving
    // 把譯文塞進最長文字節點、IMG 保留位置不動。
    // 用 tag name 規範（HTML5 語意層）判斷不是站點 class，屬結構性通則（CLAUDE.md §8）。
    //
    // textBearingChildCount 守門:target 直屬有 ≥ 2 個含文字的 element children 時跳過 (B)。
    // (B) 的 findLongestTextNode 假設「單一主文字區塊 + 媒體」,挑 main → 清空其他 text node →
    // walk up 把空 inline 殼移除（v1.2.2 為 Gmail Team Picks 加的）。當「IMG 把多個 inline 文字
    // 區塊切開」時這個假設破:把 main 所在以外的 SPAN 整顆當空殼移除,front 段落就消失。
    // 真實案例:X(Twitter) 推文 `<div data-testid="tweetText">[<span>intro</span>, <img alt="🤯">,
    // <span>rest</span>]</div>` — IMG emoji 把推文切成兩個 SPAN 文字區塊,(B) 把 SPAN[0] 殺掉,
    // 譯文只剩後半段 + 浮動 IMG。
    // 結構性通則(§8):描述「target 內多個 text-bearing 兄弟元素被媒體切開」這個結構,不綁站點 / class。
    //
    // hasEmptyPlaceholderChild 守門:target 直屬有 element child「自身有 children 但無 text」
    // → 視為 lazy-loaded media container 占位子。即使 containsMedia 此刻 false(IMG / 背景圖
    // 還沒 lazy-load),也走 (B) 保結構。否則 (A) clean-slate 會把占位 DIV 連同 image lazy-load
    // 容器一起清掉,後續 X 的 lazy load 找不到容器,圖片永遠不顯示。
    // 真實案例:X 推文裡帶 URL card preview,結構為
    //   <a><div(empty img placeholder, has children no text)><div(title)></a>
    // (A) 清掉 → cardLink.children = [],只剩 a.textContent = 翻完的標題,大圖預覽消失。
    // 結構性通則(§8):描述「element child 自身有 children 但無 text 文字內容」這個 lazy-load
    // pattern,不綁 X / class / data-testid。任何 SPA 用 placeholder DIV 等 image lazy-load
    // 注入的場景都會踩到。
    const isHeading = /^H[1-6]$/.test(target.tagName);
    const hasContainerChild = Array.from(target.children).some(c =>
      SK.CONTAINER_TAGS.has(c.tagName));
    const textBearingChildCount = Array.from(target.children).filter(c =>
      (c.textContent || '').trim().length > 0).length;
    const hasEmptyPlaceholderChild = Array.from(target.children).some(c =>
      c.children.length > 0 && (c.textContent || '').trim().length === 0);
    const containsMediaOrPlaceholder = SK.containsMedia(target) || hasEmptyPlaceholderChild;
    // 注入內容自身已含 IMG（Google MT atomic IMG slot deserialization 產生的 clone）
    // 時跳過 (B)：(B) 會保留 target 原始 IMG，加上 fragment 裡的 clone = 圖片重複。
    // fragment 已包含完整內容（含 IMG clone），走 (A) clean-slate 即可。
    const contentHasImg = !isString && content.querySelector && content.querySelector('img');
    if (containsMediaOrPlaceholder && !contentHasImg && textBearingChildCount <= 1
        && (isHeading || !hasContainerChild || hasEmptyPlaceholderChild)) {
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
    //
    // v2.0.61 media-sparing:直屬子樹「含媒體且自身無文字」的節點不清除、保留原位。
    // 結構背景:媒體包在無文字 wrapper(如 AMP 頁 <amp-img> 自訂元素、lazy-load 圖殼)
    // 時,serialize 端不會為它產生 slot(無文字),譯文 fragment 裡沒有它;而 target
    // 同時有 ≥ 2 個帶文字子元素(圖卡:圖 + 多行 <b>資訊)會被 textBearingChildCount
    // 守門踢出 (B),原本整顆清空 = 媒體蒸發(historyvshollywood 人物對照卡實例)。
    // 譯文 fragment 插回「第一個被清除節點」的位置,維持媒體/文字相對順序。
    // contentHasImg(fragment 已含 IMG clone,Google MT atomic path)時不 spare,
    // 否則原圖 + clone 重複。
    // 保留判準:自身無文字 + media-like(媒體 / embed / 無文字自訂元素,含 AMP
    // lazy 升級前後兩種空殼狀態;判定單一資料源見 content-ns.js SK.containsMediaLike)。
    // HR / 空 SPAN / BR 等一般空元素不 spare,維持既有 clean-slate 行為
    //(vBulletin TD>DIV+HR+DIV 場景的 HR 順序問題即靠清除解,v1.4.14)。
    const isMediaOnlyNode = (n) => n.nodeType === Node.ELEMENT_NODE
      && (n.textContent || '').trim() === ''
      && SK.containsMediaLike(n);
    const node = isString ? target.ownerDocument.createTextNode(content) : content;
    let insertRef = null;       // 譯文插入錨點 = 第一個被清除節點之後的首個保留節點
    let removedAny = false;
    for (const child of Array.from(target.childNodes)) {
      if (!contentHasImg && isMediaOnlyNode(child)) {
        if (removedAny && !insertRef) insertRef = child;
        continue;
      }
      target.removeChild(child);
      removedAny = true;
    }
    target.insertBefore(node, insertRef);
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
   * \n → <br> 還原對齊 replaceTextInPlace——serialize 端把 <br> 轉 \n 送 LLM,
   * fallback 不還原的話多行段落在非 pre-wrap 站點視覺換行全塌成空格。
   */
  function plainTextFallback(el, cleaned) {
    if (cleaned && cleaned.includes('\n')) {
      const frag = buildFragmentFromTextWithBr(cleaned);
      replaceNodeInPlace(el, frag);
      return;
    }
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
   *   原文： "Dhruv's been having fun with this little ⟦0⟧Kodak Charmera⟦/0⟧ keychain."
   *   LLM 回： "Dhruv 最近都在玩這個超可愛的 Kodak Charmera 鑰匙圈。"  (slot 丟掉)
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

  function _revertEcho(el, translation) {
    var origHTML = STATE.originalHTML.get(el);
    if (origHTML != null) el.innerHTML = origHTML;
    var origLang = STATE.originalLang.get(el);
    if (origLang === null) el.removeAttribute('lang');
    else if (origLang != null) el.setAttribute('lang', origLang);
    el.removeAttribute('data-shinkansen-nodevalue-mutated');
    var origFont = STATE.originalFontFamily.get(el);
    if (origFont != null) el.style.fontFamily = origFont;
    // v1.10.50: echo = 模型判定「譯文即原文」(典型:品牌名/專有名詞短段)。DOM 已還原
    // 為原文,但必須標 data-shinkansen-translated 視為已處理——否則 rescanTick /
    // spaObserverRescan 每輪把同段重收進候選重送 API,模型再 echo、再不標,純燒 token
    //(DF probe 實測:同兩段 20s 內 3 連打)。標記走既有 translated 屬性而非新屬性,
    // 讓所有候選過濾點(collectParagraphs / prescan IO selector / spaByTextReuse)
    // 單一資料源生效;restorePage / SPA reset 照常清標記,使用者清快取重翻(必經
    // restore toggle)仍會重送這些段。
    el.setAttribute('data-shinkansen-translated', '1');
    // innerHTML 還原讓剛建立的 nv-mutate backup 全數 detach——不清 entry 的話
    // runContentGuardNvMutate 會看到 allDetached 走 unmark path 把上面那行
    // translated 標記又拔掉，echo 防重送失效(標記/rescan 反覆震盪)
    STATE.nodeValueMutateBackup?.delete(el);
    STATE.nvMutateTranslation?.delete?.(el);
    // by-text reuse 也記一筆(value = 原文 innerHTML):SPA virtualization 同文字段
    // remount 成新元素時直接 reuse,不再進 API 候選。
    SK._recordTranslatedByText?.(el, el.innerHTML);
    // v2.0.65: 加記 translationHead——區分「模型真 echo（譯文=英文原文）」vs
    // 「注入層假 echo（譯文是好的，但寫入後 DOM 文字沒變 → 誤判）」。後者代表
    // injection path 有洞，少這欄位只能瞎猜是哪一種（Verge Installer 頁除錯實例）
    SK.sendLog('warn', 'inject', 'echo detected: translation identical to source, marked translated (rescan will not re-send)',
      { text: (el.textContent || '').substring(0, 80),
        translationHead: (translation || '').substring(0, 80) });
  }

  // ─── 術語表對照「只出現一次」裁剪 ──────────────────────────
  // 自動術語表 tech 類 target 依抽取 prompt(DEFAULT_GLOSSARY_PROMPT)自帶
  // 「譯名（原文）」對照,而 system prompt 注入指令(lib/system-instruction.js)
  // 要求模型每次出現都完整輸出(EPUB 抗剝除修法,見該處註解)——結果網頁譯文
  // 每次出現都是「α-半乳糖（alpha-gal）」全對照,蓋掉主 prompt「僅首次加註」規則。
  // 且整頁跨多批獨立 API 呼叫,模型層根本做不到「全頁只加註一次」;
  // 確定性解只能做在注入端:整頁第一個注入的出現保留完整對照,後續只留譯名。
  //
  // 與 translate-doc/epub-writer.js computeAnnotationDedupe 是「對照裁剪」同一份
  // 事實的雙實作(EPUB 端另有 per-entry flag / dedupeKeep 方向 / editedHtml text
  // node 級處理等語意,模組系統也不同無法直接共用)。同步觸發:改「對照 target
  // 解析 regex / 替換邊界 CJK 補空格」規則時,兩處一起檢查。
  //
  // seen 追蹤記 keptEl:content guard / framework restore 對同一元素 re-inject 時
  // 不能因 seen=true 把當初保留的那份對照也裁掉(idempotent re-inject)。
  const ANNOTATED_TARGET_RE = /^(.+)（(.+)）\s*$/;
  const AD_CJK_EDGE_RE = /[㐀-鿿豈-﫿]/;
  const AD_LATIN_EDGE_RE = /[A-Za-z0-9]/;

  // 替換片段左右的 CJK↔拉丁邊界補空格(對齊 epub-writer spliceWithCjkSpacing)
  function _adSplice(text, start, end, keep) {
    const before = text.slice(0, start);
    const after = text.slice(end);
    let mid = keep;
    if (before && AD_CJK_EDGE_RE.test(before[before.length - 1]) && AD_LATIN_EDGE_RE.test(mid[0] || '')) {
      mid = ' ' + mid;
    }
    if (after && AD_LATIN_EDGE_RE.test(mid[mid.length - 1] || '') && AD_CJK_EDGE_RE.test(after[0])) {
      mid = mid + ' ';
    }
    return before + mid + after;
  }

  // 由當前 run 的自動術語表建立裁剪規則。同一 glossary 陣列參照(主 run 之後的
  // SPA rescan / 續批都帶 ctx.glossary 同一顆)不重建 → seen 狀態跨 rescan 延續,
  // 整頁生命週期只保留一份對照;新 translatePage run 拿到新陣列 → 重建歸零。
  SK.setAnnotationDedupeRules = function setAnnotationDedupeRules(glossary) {
    if (STATE._annotationDedupeSrc === glossary) return;
    STATE._annotationDedupeSrc = glossary || null;
    const rules = [];
    for (const e of glossary || []) {
      if (!e || typeof e.target !== 'string' || typeof e.source !== 'string') continue;
      const m = e.target.match(ANNOTATED_TARGET_RE);
      if (!m) continue;
      // 慣例是「譯名（原文）」→ 留 lead;lead 反而與 source 相符時代表欄位是
      // 「原文（譯名）」變體 → 留括號內。書名號剝掉再比(對齊 epub-writer)
      const stripTitle = (s) => {
        const t = s.trim();
        const w = t.match(/^《(.+)》$/);
        return w ? w[1].trim() : t;
      };
      const src = stripTitle(e.source);
      const keep = (src && stripTitle(m[1]) === src) ? m[2] : m[1];
      if (!keep) continue;
      rules.push({ full: e.target, keep, seen: false, keptEl: null });
    }
    STATE._annotationDedupeRules = rules.length > 0 ? rules : null;
  };

  SK.clearAnnotationDedupeRules = function clearAnnotationDedupeRules() {
    STATE._annotationDedupeRules = null;
    STATE._annotationDedupeSrc = null;
  };

  // 譯文字串層裁剪(佔位符 ⟦N⟧ 不受影響:indexOf 整串比對,對照被 inline 標記
  // 從中切開時比不中 = 安全 no-op)。holderEl = unit.el,供 keeper re-inject 判斷。
  SK.trimAnnotationDedupe = function trimAnnotationDedupe(translation, holderEl) {
    const rules = STATE._annotationDedupeRules;
    if (!rules || typeof translation !== 'string' || !translation) return translation;
    let out = translation;
    for (const rule of rules) {
      if (!out.includes(rule.full)) continue;
      const isKeeperEl = !rule.seen || (holderEl != null && rule.keptEl === holderEl);
      let keptThisString = false;
      let from = 0;
      while (true) {
        const idx = out.indexOf(rule.full, from);
        if (idx === -1) break;
        if (isKeeperEl && !keptThisString) {
          // 整頁第一次出現(或 keeper 元素 re-inject 的第一個出現):保留完整對照
          keptThisString = true;
          rule.seen = true;
          if (holderEl != null) rule.keptEl = holderEl;
          from = idx + rule.full.length;
          continue;
        }
        out = _adSplice(out, idx, idx + rule.full.length, rule.keep);
        rule.seen = true;
        from = idx + rule.keep.length + 2; // +2 = 最多補兩個空格的餘裕(保守前進)
      }
    }
    return out;
  };

  SK.injectTranslation = function injectTranslation(unit, translation, slots) {
    if (!translation) return;
    // v1.4.8: 統一在注入入口規範化字面 \n（反斜線+n，兩字元）→ 真正換行符（U+000A）。
    // v1.4.6 在 deserializeWithPlaceholders（有 slots 路徑）加了同樣的規範化，
    // 但 fragment no-slots / element no-slots 路徑完全繞過 deserializeWithPlaceholders，
    // 導致字面 \n 殘留可見 DOM 字元。在此入口統一處理，覆蓋所有後續路徑。
    if (translation.includes('\\n')) translation = translation.replace(/\\n/g, '\n');

    // 空 slots 不變量守門(佔位符外洩防線):element / fragment / dual / framework-nvMutate
    // 四條 no-slots 路徑都不經 deserializeWithPlaceholders,不會消耗佔位符 ⟦N⟧。序列化端
    // 「placeholders ⟺ slots」本是不變量,但快取值存的是帶佔位符的原始譯文,一旦「帶佔位符
    // 譯文 + 空 slots」配對出現(實例:NYT React 重排後某 <p> 重新序列化成空 slots,卻命中
    // 帶佔位符的 tc_ 快取值),下游 sink 會把 ⟦N⟧ 原封寫進 DOM 被使用者看到。此處統一 strip
    // 把不變量在注入端「強制成立」而非假設成立;slots>0 路徑交給 deserialize,不在此動。
    if ((!slots || slots.length === 0) && typeof translation === 'string'
        && SK.stripStrayPlaceholderMarkers) {
      translation = SK.stripStrayPlaceholderMarkers(translation);
    }

    // 術語表對照「只出現一次」:整頁第一個注入的出現保留「譯名（原文）」完整對照,
    // 後續出現只留譯名(規則與 seen 狀態見上方 setAnnotationDedupeRules 區塊)。
    // single / dual / fragment / streaming / rescan 都經此入口,一次裁全部
    if (typeof translation === 'string' && STATE._annotationDedupeRules) {
      translation = SK.trimAnnotationDedupe(translation, unit.el || null);
    }

    // 輸出語言守門:目標為拉丁字母語言(en/es/fr/de)時,若整段譯文是東亞文字,判定為
    // LLM 掉語言(間歇性,見 content-detect.js SK.isWrongLanguageOutput 說明),不注入 →
    // 保留原文,避免使用者看到與目標語言不符的中文。single / dual / fragment / streaming /
    // testInject 都經此入口,一次擋全部(單一資料源:判斷邏輯在 content-detect.js)。
    if (SK.isWrongLanguageOutput && SK.isWrongLanguageOutput(translation, SK.STATE?.targetLanguage)) {
      return;
    }

    var _preText = (unit.kind !== 'fragment' && unit.el)
      ? (unit.el.textContent || '').trim() : null;

    // Sibling element 邊界空格:React site(X / Threads)DOM 元素間沒有
    // whitespace text node,各 unit 獨立翻譯後文字直接黏 URL/mention。
    // 在注入前對 translation 尾/首補空格,讓 text node 跟相鄰 element 有間距。
    if (unit.el && unit.el.nodeType === 1 && typeof translation === 'string'
        && STATE.translatedMode !== 'dual') {
      var _cs = unit.el.ownerDocument?.defaultView?.getComputedStyle?.(unit.el);
      if (_cs && _cs.display.startsWith('inline')) {
        if (!/\s$/.test(translation)) {
          var _next = unit.el.nextSibling;
          while (_next && _next.nodeType === 3 && !_next.nodeValue?.trim()) _next = _next.nextSibling;
          if (_next && _next.nodeType === 1) translation += ' ';
        }
        if (!/^\s/.test(translation)) {
          var _prev = unit.el.previousSibling;
          while (_prev && _prev.nodeType === 3 && !_prev.nodeValue?.trim()) _prev = _prev.previousSibling;
          if (_prev && _prev.nodeType === 1) translation = ' ' + translation;
        }
      }
    }

    // §5 單一資料源:祖先已走 nvMutate(整棵子樹 text node 全 mutate 過)時,
    // 本 unit 重複 inject 會覆蓋已成功 mutate 的子 DOM。典型場景:
    //   1. translatePage auto:tweetText(React fiber 在)走 framework branch
    //      nvMutate 成功;SPAN[5] children 也有 fiber 進 framework branch,
    //      祖先 tweetText 有 attr → framework 內 dedup bail。三 unit 安全。
    //   2. restorePage 後再 translatePage:tweetText.innerHTML = originalHTML
    //      重 parse,tweetText 自己 ref 不變(fiber 在)但內部 children 變
    //      orphan 新節點(沒 fiber)→ isFrameworkManaged(SPAN[5]) = false
    //      → SPAN[5] 跳過 framework branch 走 standard slots path →
    //      replaceNodeInPlace 把 tweetText 已 mutate 的 SPAN[5] 內部蓋成
    //      [text, BR, BR, text] fragment 結構,trailing \n\n 丟失。
    //
    // 入口只擋 nvMutated 祖先(整棵 mutate 過)。
    // 不擋 data-shinkansen-translated(fragment inject 會設,但 outer fragment +
    // inner element 是 SPEC §15 path 的合法雙段 inject,inner 不該被擋)。
    // 不擋 data-shinkansen-dual-source(dual 路徑由 injectDual 內部去重)。
    if (unit && unit.el && unit.el.parentElement) {
      let anc = unit.el.parentElement;
      while (anc && anc !== document.body) {
        if (anc.hasAttribute && anc.hasAttribute('data-shinkansen-nodevalue-mutated')) return;
        anc = anc.parentElement;
      }
    }

    // v1.5.0: 雙語對照模式分派——dual 走 SK.injectDual 走另一條路徑。
    // 只 element 走得到 dual（fragment unit 結構特殊，dual 模式直接 fallback 走 single）。
    // 模式由 STATE.translatedMode 決定（translatePage 進入時依 settings.displayMode 設定）。
    if (STATE.translatedMode === 'dual' && unit.kind !== 'fragment' && SK.injectDual) {
      SK.injectDual(unit, translation, slots);
      return;
    }

    // v1.9.27: 即便全局 mode 是 single,個別 framework-managed element 也 fall back
    // 到 dual inject(append sibling wrapper,不動原 element 子樹),保 framework
    // 的 DOM node ref 完整。
    // Why:single mode 改 element.innerHTML / text node nodeValue 會讓 React fiber
    // 認知的 DOM ref 變孤兒,使用者後續點按鈕(X 推文「顯示更多」、Reddit/Threads/
    // Medium 留言「展開」)時 framework click handler 失效或 silent bail out
    // (Chrome for Claude 在真實 X 推文上 probe 2026-05-19 驗證:single inject 後
    // click 不展開;dual inject 後 click 正常展開到 4663 chars,btn 消失)。
    // Trade-off:framework-managed 段落變雙語(原文 + 譯文 sibling),違反使用者
    // 預期的「single 全頁原地替換」+ Readwise Reader 擷取對應段帶 wrapper 噪音。
    // 但對 X / Threads / Reddit 這類 React SPA,寧可保 click 互動 work,使用者
    // 體驗整體較好。詳見 facebook/react#11538 系列。
    if (STATE.translatedMode !== 'dual' && unit.kind !== 'fragment'
        && SK.injectDual && SK.isFrameworkManaged?.(unit.el)) {
      // v1.9.27 Layer A2 局部 dedup:framework-managed 場景下 collectParagraphs 對
      // X tweetText 可能同時抓父 + 內部 inline 子 element(各為一個 unit)。兩個都
      // inject 會造成雙倍中文(父走 dual sibling wrapper、子走 nodeValue mutate)。
      // dedup 限縮在此 branch 內不影響其他合法雙段 inject(outer fragment + inner
      // element 等場景,SPEC §15 path)。
      if (unit.el.hasAttribute) {
        // v1.10.49: 元素「自己」已帶任一翻譯標記 → 不重複注入。原本只查祖先 +
        // 後代,漏掉自己:第一輪 A1/A3/A3.5 全 fail 掉 dual visible(元素只標
        // data-shinkansen-dual-source,detect 層刻意不擋 dual-source),SPA rescan
        // 重抓同元素再翻一次,LLM 非決定性這輪產出可對齊的譯文 → mutate 寫入 →
        // 「原地中文 + 下方另一份不同中文 wrapper」雙重譯文(2026-06-12 Medium
        // figcaption 實測:兩輪 API 譯文不同,間隔 6.6s)。
        if (unit.el.hasAttribute('data-shinkansen-translated')
            || unit.el.hasAttribute('data-shinkansen-dual-source')
            || unit.el.hasAttribute('data-shinkansen-nodevalue-mutated')) return;
        let anc = unit.el.parentElement;
        while (anc && anc !== document.body) {
          if (anc.hasAttribute && (
            anc.hasAttribute('data-shinkansen-translated') ||
            anc.hasAttribute('data-shinkansen-dual-source') ||
            anc.hasAttribute('data-shinkansen-nodevalue-mutated')
          )) return;
          anc = anc.parentElement;
        }
        if (unit.el.querySelector && unit.el.querySelector(
          '[data-shinkansen-translated], [data-shinkansen-dual-source], [data-shinkansen-nodevalue-mutated]'
        )) return;
      }

      SK.snapshotOnce(unit.el);

      // v1.9.27 Layer A1: 先試 nodeValue mutate(類似 Immersive Translate SR()):
      // 對「source 是 single visible text node」場景,直接改 text node 的 nodeValue
      // 為譯文,不動 element 結構。React fiber 認識的 text node 物件 ref 不變,
      // click handler 在它上面操作仍 work(Chrome for Claude 早期 probe 證實:單一
      // text node nodeValue mutate 後 X click show more 仍能 expand)。
      // 視覺等同 single mode(只看到中文,沒並列原文),且 Readwise Reader 擷取
      // 乾淨(無 wrapper sibling 噪音)。
      // 配對失敗(multi text node、含 placeholder、含 \n 多段)→ fallback dual visible。
      if (SK.tryInjectNodeValueMutate?.(unit.el, translation, slots)) {
        if (_preText != null && (unit.el.textContent || '').trim() === _preText) {
          _revertEcho(unit.el, translation); return;
        }
        unit.el.setAttribute('data-shinkansen-nodevalue-mutated', '1');
        unit.el.setAttribute('data-shinkansen-translated', '1');
        // nodeValue mutate 後也記錄 by-text reuse 快取：X virtualization
        // unmount/remount 全新 element 時 spaByTextReuse 用 innerHTML
        // 還原譯文（新 element 還沒被 React 互動過,innerHTML 寫入安全）。
        SK._recordTranslatedByText?.(unit.el, unit.el.innerHTML);
        // v1.10.49: 記錄譯文,供 Content Guard 在「framework 同內容重
        // render 把 backup node 整批換新」時直接重套(免 API,見 content-spa.js
        // runContentGuardNvMutate)。v2.0.59: A3(帶 slots)場景連 raw + slots 一起
        // 記,重套時先走 A3 同構配對保留 <a> 等 inline 結構。
        recordNvMutateTranslation(unit.el,
          slots && slots.length > 0 && SK.stripStrayPlaceholderMarkers
            ? SK.stripStrayPlaceholderMarkers(translation).trim()
            : translation,
          translation, slots);
        return;
      }

      // v1.10.48: Layer A3.5 — A3 配對失敗時的「純文字 nodeValue mutate」fallback。
      // 觸發結構:譯文無法同構重現 source 的 inline 序列。典型 case 是 dropcap
      // 首字下沉段:source = TEXT("F") + SPAN.smallcaps("iending …") + TEXT(rest),
      // 單字從字母中間被切開;CJK 譯文沒有「首字母」可對應 → LLM 要嘛丟掉佔位符
      // (deserialize ok=false)、要嘛把首字併進 span(譯文序列 2 項 vs source 3 項,
      // A3 對齊 fail)。同結構在非 framework 站走 single 的 plainTextFallback 原地
      // 替換;framework branch 原本直接掉進 dual visible(原文保留 + 譯文 sibling),
      // 使用者看起來就是「這段沒翻到」。
      // 修法:slots 全為 styling-only inline(paired Element shell,非 <a>、非
      // atomic、非 reuseNode)時,剝掉佔位符 → 以 slots=[] 重走 nodeValue mutate
      // (整段譯文塞第一個 text node、其餘 text node 清空)。只動 nodeValue 不動
      // 元素結構,fiber-safe 程度同 Layer A1,視覺等同 single 原地替換(§15)。
      // Trade-off:styling inline(smallcaps / strong / em)的樣式覆蓋範圍丟失,
      // 換取譯文完整 + 單語呈現。BUTTON(reuseNode)/ atomic(inline code / footnote
      // sup / IMG emoji)流不進此層:flatten 會清空 click target / 未送翻的 atomic
      // 內容 → gate 的 `!atomic && !reuseNode` 擋下,維持 dual visible 保功能。
      // 純 <a>(isPreservableInline shell,非 reuseNode)會流入,處理見下方 anchor gate。
      if (slots && slots.length > 0 && SK.stripStrayPlaceholderMarkers
          && slots.every(s => s && s.nodeType === Node.ELEMENT_NODE
            && !s.atomic && !s.reuseNode)) {
        const plainTranslation = SK.stripStrayPlaceholderMarkers(translation).trim();
        // anchor gate(v1.10.52 放寬):framework-managed 段落 A3 同構配對失敗後,
        // 是否放行純文字 flatten。
        //
        // v1.10.49 原本額外要求「el 內所有 <a> 可見文字逐字出現在譯文中」才放行,
        // 否則維持 dual。但 prose 文章內文連結的 anchor text 會被翻成中文(prompt
        // 只對專有名詞 / 作品名保留英文,一般敘述性連結文字照翻):
        //   source: Read the ⟦0⟧full report⟦/0⟧ for more details
        //   LLM 掉佔位符回: 閱讀完整報告以了解更多研究結果細節。  (full report → 完整報告)
        // 英文 anchor text 不在中文譯文 → 舊 gate fail → 整段掉 dual visible(原文 +
        // 譯文並列),違反 §15 single 原地替換(真實案例:theatlantic.com Next.js
        // 文章內文段,使用者回報「譯文沒注入原文、變新段落顯示在下方」)。
        //
        // 放寬後:不再要求 anchor text 在譯文中。理由——flatten 走 nodeValue mutate
        // (整段譯文塞第一個 text node、其餘清空),<a> 留為空殼,譯文已含翻譯後的
        // 連結文字 → 內容零遺失,唯一損失是連結「可點擊性」。這跟非 framework 站
        // plainTextFallback「ok=false 一律 flatten(連結整顆消失)」的退化等價甚至更輕,
        // §15 single 原地替換優先。掉佔位符極罕見(<0.2%),正常 ok=true 路徑 A3 會
        // 保留連結 inline 結構(可點),不受影響。
        //
        // 唯一保留的結構守門:第一個可見 text node 不在 <a> 內。
        //   1. 避免整段譯文塞進連結 → 全段變可點(degenerate)。
        //   2. 同時保證「段落有連結以外的 prose 文字」——純連結載體段落(整段就是
        //      一個 <a>)第一個 text node 在 <a> 內 → 不放行 → 維持 dual,避免內容
        //      載體被 flatten 清空。
        // 此守門非站點特判,是「inline 連結內嵌於 prose」vs「整段即連結」的結構區分(§8)。
        let a35AnchorsOk = true;
        if (unit.el.querySelector && unit.el.querySelector('a')) {
          const tns0 = SK.collectVisibleTextNodes?.(unit.el) || [];
          a35AnchorsOk = tns0.length > 0
            && !(tns0[0].parentElement && tns0[0].parentElement.closest('a'));
        }
        if (plainTranslation && a35AnchorsOk && SK.tryInjectNodeValueMutate?.(unit.el, plainTranslation, [])) {
          if (_preText != null && (unit.el.textContent || '').trim() === _preText) {
            _revertEcho(unit.el, translation); return;
          }
          unit.el.setAttribute('data-shinkansen-nodevalue-mutated', '1');
          unit.el.setAttribute('data-shinkansen-translated', '1');
          SK._recordTranslatedByText?.(unit.el, unit.el.innerHTML);
          recordNvMutateTranslation(unit.el, plainTranslation);
          SK.sendLog('info', 'inject', 'A3.5 plain-text nv-mutate fallback (styling-only / prose-link slots)',
            { text: (unit.el.textContent || '').substring(0, 60) });
          return;
        }
      }

      // fallback: dual visible(layer 1-8 path)
      // 確保 dual wrapper style 已注入(translatePage 入口在 single mode 下沒 ensure)
      SK.ensureDualWrapperStyle?.();
      SK.injectDual(unit, translation, slots);
      // v1.9.27 設計決策:framework-managed fallback 走 dual visible,不嘗試
      // hide-original「視覺 single」。Chrome for Claude probe 在真實 X 推文上
      // 試過多種隱藏方式:
      //   - display:none → 撞 X flex parent 重算 height,wrapper 壓 8px
      //   - position:absolute + clip-path:inset(100%) + opacity 0 套件:初翻 work
      //     (wrapper 208px / single-look),但 click show more 觸發 X article
      //     re-mount 後,wrapper 仍變 8px(可能 deserializer 在新 wrapper 重設
      //     display:none child,或 X 重 mount 環境跟初始不同)
      // 業界對齊:Immersive Translate 在 X / Reddit / Threads / Medium / Facebook
      // 等 React SPA + 留言系統全部走 paragraph mode(等同 dual visible),也不嘗試
      // hide-original。沒看到任何 reference 解決「React click-triggered re-mount
      // 場景下單語視覺」的 robust workaround。
      // Trade-off vs §15「single 必須原地替換」:framework site 上原文 + 譯文並列
      // 違反原始設計,但保 click 互動可運作 + 譯文視覺呈現比「點按鈕沒反應」優先。
      // Non-framework site 維持 single 原地替換,符合 §15。
      // hide-original 留 future:可考慮對「無 click-triggered re-mount」的 framework
      // site(若有的話)再啟用 position absolute 路線。
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
      } else {
        const cleaned = SK.stripStrayPlaceholderMarkers(translation);
        const recovered = tryRecoverLinkSlots(el, cleaned, slots);
        if (recovered) {
          replaceNodeInPlace(el, recovered);
        } else {
          plainTextFallback(el, cleaned);
        }
      }
    } else {
      replaceTextInPlace(el, translation);
    }

    if (_preText != null && (el.textContent || '').trim() === _preText) {
      _revertEcho(el, translation); return;
    }
    el.setAttribute('data-shinkansen-translated', '1');
    applyTargetLocaleStyling(el);
    STATE.translatedHTML.set(el, el.innerHTML);
    SK.refreshAncestorSavedHTML?.(el);
    SK._guardObserveEl?.(el);
    SK._recordTranslatedByText?.(el, el.innerHTML);
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
        // \n → <br> 還原對齊下方 no-slots 路徑(fallback 不還原會塌成空格)
        newContent = cleaned.includes('\n')
          ? buildFragmentFromTextWithBr(cleaned)
          : document.createTextNode(cleaned);
      }
    } else {
      // v1.4.8: 無 slots 時也要把 \n 還原為 <br>（字面 \n 已在 injectTranslation 入口轉換完畢）
      if (translation.includes('\n')) {
        newContent = buildFragmentFromTextWithBr(translation);
      } else {
        newContent = document.createTextNode(translation);
      }
    }

    // v1.6.19: endNode 可能在 collectParagraphs 與 inject 之間被外部重排，
    // 不再是 el 的直接 child。沿用 endNode.nextSibling 當 anchor 會把 newContent
    // 加到 el 末尾（順序錯位)。anchor 必須是 el 的直接 child 才合法。
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
    applyTargetLocaleStyling(el);
    STATE.translatedHTML.set(el, el.innerHTML);
    SK.refreshAncestorSavedHTML?.(el);
    SK._guardObserveEl?.(el);
    // 注意:fragment unit 的 by-text key 對應原 fragment 文字(startNode → endNode 串接),
    // 不是整個 el.textContent。SPA observer rescan 路徑用 unitText() 算 fragment 原文後查 cache,
    // 此處 el 是 fragment 父容器,key 不對,故此 record 行為不對 fragment 路徑寫 byText。
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

  /** 取 element 的「可見文字」：遞迴每個 text node，若其祖先含 sr-only / clip-hidden
   * (`position:absolute` + 1×1 rect)/ `display:none` / `visibility:hidden` 則略過。
   * 用於 dual mode B 比對，避免 a11y(svg aria-label 對應的 sr-only span）文字干擾
   * 譯文 == 原文 的判定。 */
  function getVisibleText(el) {
    const win = el.ownerDocument?.defaultView;
    if (!win) return el.textContent || '';
    let text = '';
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      let p = n.parentElement;
      let hidden = false;
      while (p && p !== el.parentElement) {
        const cs = win.getComputedStyle(p);
        if (cs.display === 'none' || cs.visibility === 'hidden') { hidden = true; break; }
        if (cs.position === 'absolute') {
          const r = p.getBoundingClientRect();
          if (r.width <= 1 && r.height <= 1) { hidden = true; break; }
        }
        // SVG `<desc>` / `<title>` 等 a11y metadata 元素 rect 是 0×0(瀏覽器
        // 完全不渲染，只給 screen reader / accessibility tree 用)。Medium
        // 文章按讚 / 留言計數 anchor 用 SVG `<desc>` 放 "A clap icon" 等說明
        // 文字，影響 textContent 但對 sighted user 完全不可見。
        const r2 = p.getBoundingClientRect();
        if (r2.width === 0 && r2.height === 0) { hidden = true; break; }
        p = p.parentElement;
      }
      if (!hidden) text += n.nodeValue || '';
    }
    return text;
  }

  /** 找最近的 block 祖先（computed display ∈ BLOCK_DISPLAY_VALUES）。
   * 若 el 自身 computed display 已是 block-ish(例如 `<a style="display:flex">`,
   * 常見於 release 卡片連結)，回傳 el 自身——讓 wrapper 緊貼 el 而不是被推到
   * 上層大容器（避免 wrapper 與原段落距離過遠)。 */
  function findBlockAncestor(el) {
    const win = el.ownerDocument?.defaultView;
    const selfCs = win?.getComputedStyle?.(el);
    if (selfCs && SK.BLOCK_DISPLAY_VALUES.has(selfCs.display)) return el;
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
    } else if (originalTag === 'PRE') {
      // PRE 原本帶 UA 預設 `white-space: pre`,inner 用 PRE 會讓中文譯文不換行衝出
      // column(Medium 引用文字 case)。譯文是自然語言不是 code，改用 <div>。
      innerTag = 'div';
    } else if (SK.BLOCK_TAGS_SET.has(originalTag) || originalTag === 'DIV' || originalTag === 'SECTION' || originalTag === 'ARTICLE' || originalTag === 'MAIN' || originalTag === 'ASIDE') {
      // 一般 block：保留原 tag（P, BLOCKQUOTE, DD, DT, FIGCAPTION, CAPTION, SUMMARY, FOOTER, DIV 等）
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
      // PRE 通常 monospace，中文譯文在 monospace 字型下視覺擁擠難讀（Medium 引用
      // 文字 case);PRE source 不 copy fontFamily，讓 inner 繼承 wrapper 父層
      // (article body）字型。
      if (cs.fontFamily && originalTag !== 'PRE') inner.style.fontFamily = cs.fontFamily;
      if (cs.fontSize)      inner.style.fontSize      = cs.fontSize;
      if (cs.fontWeight)    inner.style.fontWeight    = cs.fontWeight;
      if (cs.lineHeight)    inner.style.lineHeight    = cs.lineHeight;
      if (cs.letterSpacing) inner.style.letterSpacing = cs.letterSpacing;
      if (cs.color)         inner.style.color         = cs.color;
    }

    // v1.8.31: inner reset padding/margin。
    // inner 是 <p>/<div> 等真實 tag，會被站點的 `article p { padding-bottom: ... }`
    // 之類規則套到——而 padding 算在 inner box 內，wrapper 的 background-color 會
    // 跟著 inner padding 範圍一起延伸 → 視覺上「底色超出文字一大塊空白」。
    // 砍掉 inner 的 padding/margin，讓底色只圍著文字本身；段落間距改由 wrapper
    // 自己的 margin 控制（injectDual 內 mirror 原段落 padding-bottom + margin-bottom
    // 到 wrapper.style.marginBottom)。
    inner.style.padding = '0';
    inner.style.margin = '0';

    // 設 lang 讓瀏覽器選對 CJK 字形變體。dual 模式 inner 完全是譯文,直接設 lang 比
    // 設在 wrapper 更精準(wrapper element 本身不含可見文字)。
    applyTargetLocaleStyling(inner);

    // 譯文內容：有 slots 走 deserializer 重建 inline 結構，否則純文字 / br fragment
    if (slots && slots.length > 0) {
      // cloneReuse:dual wrapper 是原段落的「譯文複本」,reuseNode 不 clone 會把原段落
      // 的 inline BUTTON 搬進 wrapper(原段落失去互動按鈕，違反 dual 不動原文的前提)
      const result = SK.deserializeWithPlaceholders(translation, slots, { cloneReuse: true });
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
      // inline：afterend-block-ancestor — wrapper chain 可能有多個,掃全部找 text match
      const blockAncestor = findBlockAncestor(original);
      const anchor = (blockAncestor && blockAncestor !== winDoc.body) ? blockAncestor : original;
      const expected = (SK.stripStrayPlaceholderMarkers
        ? SK.stripStrayPlaceholderMarkers(translation)
        : translation).trim();
      let sib = anchor.nextElementSibling;
      while (sib && sib.tagName === wrapperTagUpper) {
        if (sib.textContent.trim() === expected) return sib;
        sib = sib.nextElementSibling;
      }
      return null;
    }
    if (!candidate || candidate.tagName !== wrapperTagUpper) return null;
    const expected = (SK.stripStrayPlaceholderMarkers
      ? SK.stripStrayPlaceholderMarkers(translation)
      : translation).trim();
    if (candidate.textContent.trim() !== expected) return null;
    return candidate;
  }

  /**
   * v1.8.31: 偵測 wrapper 即將注入位置的「實際背景亮度」，回傳 'dark' | 'light'。
   * 從 original 往上 walk，逐層讀 computed backgroundColor，第一層 alpha > 0.5 的
   * 色調拿來算 luma。全程透明追到 html 還是透明就 fallback 'light'(HTML 預設白底)。
   *
   * Why:dual mode 的 tint 標記寫死 #FFF8E1 米色底，假設「父層文字偏深」;dark mode
   * 頁面父層文字本來就是淺灰，淺字疊米色塊對比破裂。改用 prefers-color-scheme 會誤判
   * 「OS dark + 站點 light」混合情境，所以走「實際渲染色」路線最準。
   */
  function detectThemeForElement(el) {
    const win = el.ownerDocument?.defaultView;
    if (!win) return 'light';
    let node = el;
    while (node && node !== el.ownerDocument.documentElement) {
      const cs = win.getComputedStyle(node);
      const m = cs.backgroundColor && cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
      if (m) {
        const parts = m[1].split(',').map(s => parseFloat(s.trim()));
        const [r, g, b, a] = [parts[0], parts[1], parts[2], parts.length === 4 ? parts[3] : 1];
        if (a > 0.5 && [r, g, b].every(n => Number.isFinite(n))) {
          // ITU-R BT.601 luma
          const luma = 0.299 * r + 0.587 * g + 0.114 * b;
          return luma < 128 ? 'dark' : 'light';
        }
      }
      node = node.parentElement;
    }
    // 全程透明：看 documentElement 自己
    const rootCs = win.getComputedStyle(el.ownerDocument.documentElement);
    const m2 = rootCs.backgroundColor && rootCs.backgroundColor.match(/rgba?\(([^)]+)\)/);
    if (m2) {
      const parts = m2[1].split(',').map(s => parseFloat(s.trim()));
      const [r, g, b, a] = [parts[0], parts[1], parts[2], parts.length === 4 ? parts[3] : 1];
      if (a > 0.5 && [r, g, b].every(n => Number.isFinite(n))) {
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        return luma < 128 ? 'dark' : 'light';
      }
    }
    return 'light';
  }
  SK._detectThemeForElement = detectThemeForElement; // 給 spec 測試讀

  /**
   * 中和 wrapper 從站點祖先繼承到的「軸對齊翻轉」transform。
   *
   * 某些站點（實例：Google 搜尋結果標題）用「祖先 scaleY(-1) + 該元素自身 scaleY(-1)」
   * 雙重翻轉互相抵消來反爬蟲——原標題文字經兩層翻轉後正立，但 dual wrapper 是以
   * sibling 身分插進「只有祖先那層翻轉」的位置，少吃一次翻轉 → 譯文上下顛倒。
   *
   * 修法：累乘 wrapper 所有祖先（不含自身）的 2D transform 對角線（a = 水平 scale、
   * d = 垂直 scale），若淨值任一軸為負（奇數次軸對齊翻轉）→ 對 wrapper 補一次對應軸的
   * scale(-1) 抵消。只處理「軸對齊、無旋轉／skew」（off-diagonal ≈ 0）的純翻轉；遇
   * rotate / skew / matrix3d 等一律不動（保守，避免對正常 transform 動手）。結構性通則
   * （§8）：描述「注入元素繼承到未被抵消的軸翻轉」這個 DOM/CSS 結構，不綁站點 / class。
   *
   * 只在 dual wrapper 需要（single mode 譯文注入回原元素，跟原文吃到相同層數的翻轉，
   * 天然正立，不需也不可補償）。
   */
  function neutralizeInheritedFlip(wrapper) {
    const win = wrapper.ownerDocument?.defaultView;
    if (!win) return;
    const root = wrapper.ownerDocument.documentElement;
    let netA = 1, netD = 1;
    let node = wrapper.parentElement;
    while (node && node !== root) {
      const t = win.getComputedStyle(node).transform;
      if (t && t !== 'none') {
        const m = /^matrix\(([^)]+)\)$/.exec(t);
        if (!m) return;  // matrix3d / 非預期格式 → 保守不動
        const p = m[1].split(',').map(Number);
        const [a, b, c, d] = p;
        if (Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6) return; // 含旋轉/skew → 不動
        netA *= a; netD *= d;
      }
      node = node.parentElement;
    }
    if (netA >= 0 && netD >= 0) return;
    const parts = [];
    if (netA < 0) parts.push('scaleX(-1)');
    if (netD < 0) parts.push('scaleY(-1)');
    wrapper.style.transform = parts.join(' ');
  }
  SK._neutralizeInheritedFlip = neutralizeInheritedFlip; // 給 spec 測試讀

  /** 主入口:把譯文以雙語 wrapper 形式注入 DOM */
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

    // 譯文等於原文 → skip wrapper(視覺乾淨，不留純複製貼上的廢譯塊)。
    // 補 detect 層 isPureIdentifierCell 漏的 case:
    //   - LLM 對 "OK"/"TODO"/"v1.0" 之類短語照搬
    //   - GitHub Languages 區塊 "TypeScript 90.9%" 英文名+數字
    //   - <td><code>BASE_URL</code></td> 之類 atomic preserve(`⟦*0⟧`)
    //
    // 比對策略：
    //   1. originalText 用「可見文字」(排除 sr-only / clip-hidden / display:none
    //      子樹的文字)。Medium 文章 metadata anchor 結構為 `<a><svg/>+<span class=
    //      "sr-only">A clap icon</span>2.4K<svg/>+sr-only 43</a>`,textContent 會把
    //      sr-only 文字一起算進去，B 比對譯文 "2.4K43" 永遠不等於 source 的
    //      "A clap icon2.4KA response icon43"。
    //   2. translation 帶有 placeholder marker(`⟦N⟧`/`⟦*N⟧`）時，先 deserialize 再
    //      取 fragment textContent —— atomic preserve 會把 slot 還原成原 element,
    //      textContent 等於 slot 原 textContent，跟 originalText 自然相等。stripStray
    //      Placeholder Markers 會把 `⟦*0⟧` 整段刪掉留空字串，單純比 stripped 永遠
    //      不等於原文。
    //   3. whitespace 規範化（layout 空白 vs LLM 單空白差異）後 strict `===` 比對
    const normalizeWs = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const originalText = normalizeWs(getVisibleText(original));
    let translationText;
    if (slots && slots.length > 0 && translation) {
      // cloneReuse：這裡只為取 textContent 做「譯文==原文」比對，frag 用完即丟——
      // 不 clone 的話 reuseNode 會把原按鈕 detach 進 throwaway frag，按鈕從頁面永久消失
      const dsResult = SK.deserializeWithPlaceholders(translation, slots, { cloneReuse: true });
      translationText = dsResult.ok
        ? (dsResult.frag.textContent || '')
        : (SK.stripStrayPlaceholderMarkers ? SK.stripStrayPlaceholderMarkers(translation) : translation);
    } else {
      translationText = SK.stripStrayPlaceholderMarkers
        ? SK.stripStrayPlaceholderMarkers(translation || '')
        : (translation || '');
    }
    const translationStripped = normalizeWs(translationText);
    if (originalText && translationStripped === originalText) {
      original.setAttribute('data-shinkansen-dual-source', '1');
      return;
    }

    // 純數字計量 metric:source 可見文字只剩數字 + K/M/B/%/逗號/小數點/空白等計量
    // 符號（典型場景：Medium / Twitter / Reddit 等的 clap 數 / 留言數 / 觀看數
    // metadata anchor)。LLM 即便把 "1.8K" 轉成 "1800" 也只是數字格式變化，沒翻譯
    // 價值，wrapper 純粹是視覺垃圾。
    const NUMERIC_METRIC_RE = /^[\d.\s,KMB%+\-]+$/;
    if (originalText.length > 0 && originalText.length < 30 && NUMERIC_METRIC_RE.test(originalText)) {
      original.setAttribute('data-shinkansen-dual-source', '1');
      return;
    }

    // 譯文長度 sanity check：譯文遠長於原文（> 5×）時很可能是 LLM hallucination
    //(觀察：`May 7, 2026` 11 字回傳 ~500 字 Microsoft 創辦故事)。中文一般比英文
    // 緊湊，正常翻譯 ratio < 1;> 5× 幾乎必然異常。原文 < 5 字時不套（極短輸入翻譯
    // 比例震盪大)、原文 > 200 字時也不套（長段譯文 5× 可能是合法擴張或合段問題，
    // 不該硬擋顯示)。
    if (originalText.length >= 5 && originalText.length <= 200
        && translationStripped.length > originalText.length * 5) {
      original.setAttribute('data-shinkansen-dual-source', '1');
      return;
    }

    SK.snapshotOnce(original);

    const inner = buildDualInner(tag, original, translation, slots);
    const wrapper = original.ownerDocument.createElement(SK.TRANSLATION_WRAPPER_TAG);
    const mark = SK.currentMarkStyle && SK.VALID_MARK_STYLES.has(SK.currentMarkStyle)
      ? SK.currentMarkStyle
      : SK.DEFAULT_MARK_STYLE;
    wrapper.setAttribute('data-sk-mark', mark);
    // v1.8.31: 依注入位置的實際頁面亮度決定 dark/light 配色，避免 tint 米色底在
    // dark mode 頁面跟淺灰文字對比破裂。
    wrapper.setAttribute('data-sk-theme', detectThemeForElement(original));
    // v1.8.52: 自訂強調色（token 或 hex）套到三種 mark。auto 不寫屬性，走預設 CSS
    const rgb = SK.dualAccentToRgb?.(SK.currentDualAccent);
    if (rgb) {
      wrapper.setAttribute('data-sk-accent', 'custom');
      wrapper.style.setProperty('--sk-accent-rgb', `${rgb.r} ${rgb.g} ${rgb.b}`);
    }
    wrapper.appendChild(inner);

    // v1.5.3: copy 原段落的水平 layout 屬性到 wrapper。
    // 真實案例（macstories.net Newsletter）：原 <p> 有 margin-left / padding-left
    // 把段落擠到頁面中段，wrapper 是 sibling、不繼承這些屬性，所以譯文拉滿整行
    // 跟原 <p> 不對齊。typography copy（v1.5.2）只搬字型相關 6 屬性，layout 沒搬。
    // 只 copy 水平方向：保留 wrapper 自有的「上下間距」（margin-top:0.25em CSS rule）
    // 與「不固定 width」（讓 wrapper 隨 parent 撐開），避免動到段間距與整體寬度。
    //
    // v1.8.31: 只 copy「非零值」——原段落 padding/margin 是 0px 時不該寫 inline
    // style 蓋掉 mark CSS(例如 tint mark 的 padding: 4px 8px 會被 inline padding:0
    // 壓掉)。getComputedStyle 對沒設 padding 的元素回傳 '0px'，是 truthy 字串。
    const winLayout = original.ownerDocument?.defaultView;
    const csLayout = winLayout?.getComputedStyle?.(original);
    const isNonZero = (v) => v && v !== '0px';
    if (csLayout) {
      if (isNonZero(csLayout.marginLeft))   wrapper.style.marginLeft   = csLayout.marginLeft;
      if (isNonZero(csLayout.marginRight))  wrapper.style.marginRight  = csLayout.marginRight;
      if (isNonZero(csLayout.paddingLeft))  wrapper.style.paddingLeft  = csLayout.paddingLeft;
      if (isNonZero(csLayout.paddingRight)) wrapper.style.paddingRight = csLayout.paddingRight;
      if (csLayout.maxWidth && csLayout.maxWidth !== 'none') wrapper.style.maxWidth = csLayout.maxWidth;

      // v1.8.31: 處理「譯文塊跟下一段段距」+「padding-bottom 撐空間造成的空白」。
      //
      // marginBottom mirror：把原段落「下方該有的段距」搬到 wrapper marginBottom。
      // 因為 inner 已 reset padding/margin = 0(底色不溢出)，原段落「在 inner
      // 裡」的下方空間消失了，要由 wrapper 自己的 marginBottom 補回去跟下一段
      // 拉開。
      //
      // marginTop 抵消「原段落 paddingBottom」(不含 marginBottom):
      //   - paddingBottom 是「box 內下緣塞著的空白」,wrapper 在 afterend 會被
      //     推到這塊空白下方。抵消後 wrapper 上邊界對齊原文字下緣。
      //   - marginBottom **不抵消**：它的物理意義是「跟下一個 sibling 的距離」,
      //     可能是 list item 之間 12px 距離（抵消會讓譯文塊侵入兄弟空間 → 重疊),
      //     也可能是 byline-to-list 60px 距離（理想是抵消，但無法跟前者區分)。
      //     歷史教訓：v1.8.31 試過抵消 (pb+mb) 整體，Daring Fireball sidebar
      //     `<a>` 段落走 afterend-block-ancestor 插到 `<li>` 後面，把 12px li
      //     兄弟距離抵消後譯文塊跟 li 重疊；退回只抵消 pb。
      //   - byline-to-list 60px 空白沒解（屬於需要動原段落 inline style 才能
      //     乾淨解的 case，風險評估後暫不做)。
      //
      // 此邏輯只適用 sibling 插入模式（`afterend` / `afterend-block-ancestor`)。
      // LI/TD/TH 的 `append` 模式 wrapper 是 child，負 marginTop 會把 wrapper 拉
      // 進 cell 內部往上 overlap 原文字（zerobyte 環境變數描述 cell case);
      // append 模式跳過 marginTop/marginBottom mirror 處理。
      const isAppendMode = (tag === 'LI' || tag === 'TD' || tag === 'TH');
      if (!isAppendMode) {
        const pb = parseFloat(csLayout.paddingBottom) || 0;
        const mb = parseFloat(csLayout.marginBottom)  || 0;
        if (pb > 0) wrapper.style.marginTop = `-${pb}px`;
        if (pb + mb > 0) wrapper.style.marginBottom = `${pb + mb}px`;
      }
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
        // 同 block ancestor 多個 inline 依序注入時,每次都 afterend block ancestor
        // 會讓新 wrapper 插在舊 wrapper 前面 → 視覺反序。走到 block ancestor 後面
        // 已有的 wrapper 尾端再 append,維持 DOM 順序。
        const wrapperTagUpper = SK.TRANSLATION_WRAPPER_TAG.toUpperCase();
        let insertPoint = blockAncestor;
        let sib = blockAncestor.nextElementSibling;
        while (sib && sib.tagName === wrapperTagUpper) {
          insertPoint = sib;
          sib = sib.nextElementSibling;
        }
        insertPoint.insertAdjacentElement('afterend', wrapper);
        insertMode = 'afterend-block-ancestor';
      } else {
        // 找不到合理祖先，掛在 inline 自身後（次佳）
        original.insertAdjacentElement('afterend', wrapper);
        insertMode = 'afterend';
      }
    }

    // wrapper 已插入 DOM，祖先鏈就位——中和站點反爬蟲翻轉（見 neutralizeInheritedFlip）。
    neutralizeInheritedFlip(wrapper);

    original.setAttribute('data-shinkansen-dual-source', '1');
    STATE.translationCache.set(original, { wrapper, insertMode });
    SK._guardObserveEl?.(original); // v1.8.20: dual 路徑也要進 IO subset
  };

  /**
   * v1.9.27 Layer A2: 對 framework-managed element 試做 nodeValue mutate。
   * 不動 element 結構,保 framework DOM ref(類似 Immersive Translate SR())。
   *
   * 三條配對 path:
   *   Case 1: slots > 0 → fallback(inline element placeholder 重建只能走 fragment)
   *   Case 2: 1 source text node → 直接 mutate 整段譯文(允許 \n,LLM 譯文含 \n
   *     會由站點 CSS 的 white-space: pre-wrap 等 render 出視覺換行)
   *   Case 3: N > 1 source text nodes → 譯文按 /\n+/ split 成 chunks,N == chunks
   *     才 1:1 順序配對 mutate;N != chunks 視為配對失敗 → fallback dual
   *
   * 所有 case mutate 前都存 backup 到 STATE.nodeValueMutateBackup,供 restorePage
   * 還原。multi-inject 場景(同 el 第二次 inject)保第一次 backup,不覆蓋。
   */
  // Layer A3 helper:遞迴抽 element 內 [text|inline] 序列。
  // inline 判斷直接呼叫 SK.isPreservableInline 跟 serializer 完全對齊(包含
  // hasSubstantiveContent 檢查)— SPAN 雖有 class 但內容無 alphanum/CJK
  // (例 SPAN(" ")、SPAN("…")、emoji-only SPAN)serializer 視為透明,
  // extractA3Seq 必須一致視為透明、遞迴拆進子節點,否則 source seq 帶 inline
  // 而 target seq(來自 deserialize)是 text,type 不符 alignment fail。
  // 同 CLAUDE.md §5 單一資料源:preservable 判斷一條 source of truth。
  function extractA3Seq(rootEl, imgIsInline = false) {
    const seq = [];
    for (const child of rootEl.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.nodeValue && child.nodeValue.trim()) {
          seq.push({ type: 'text', node: child });
        }
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      // v1.9.31: IMG 視為 inline atomic 只在 tgt 端含 IMG 時啟用(Google MT IMG
      // atomic path 才會,LLM Gemini path 對 IMG 透明,tgt 沒 IMG → src 也須透明
      // 避免 src/tgt seq 長度錯位)。
      if (imgIsInline && child.tagName === 'IMG') {
        seq.push({ type: 'inline', node: child, tag: 'IMG' });
        continue;
      }
      if (SK.isPreservableInline?.(child)) {
        seq.push({ type: 'inline', node: child, tag: child.tagName });
      } else {
        // 透明 container(unstyled SPAN / DIV / 無實質內容 SPAN / IMG ...)
        // 拆解進子節點
        const inner = extractA3Seq(child, imgIsInline);
        for (const item of inner) seq.push(item);
      }
    }
    return seq;
  }

  // v1.9.31: Layer A3 對 SPAN 完全透明的變體 — 任何 SPAN(無論 class、無論 inner 內容)
  // 一律透明展開,A / B / I / STRONG 等 semantic inline 維持 opaque。
  //
  // Why:Google MT serializer 對 SPAN 一律透明展開(content-serialize.js
  // serializeNodeIterableForGoogle line 144 註解:「SPAN 是最常見的爆炸來源」),
  // deserialize 後 target frag 內 SPAN.class wrapper 不存在(只剩 inner)。但
  // extractA3Seq 對 source 端 preservable SPAN 仍視為 inline,造成 src.inline(SPAN)
  // vs tgt.text 型別不符 alignment fail → framework-managed 段落走 dual sibling
  // wrapper(違反 §15 single 原地替換)。
  //
  // 對應真實 X 推文(2026-05-20 Chrome for Claude 驗證):
  //   source: <div><span class="...">主文 prose</span><a>URL</a><span> </span><div><span><a>@mention</a></span></div></div>
  //   Google MT serializer:主文 prose 純文字 + 【*0】(A.url atomic) + ' ' + 【1】@mention【/1】
  //   Google MT 翻完 deserialize:[text("中文主文"), A.url(deep clone), text(' '), A.mention]
  //   strict extractA3Seq src:[inline(SPAN.main), inline(A.url), inline(SPAN.mention-wrap)]
  //     vs tgt:[text, inline(A.url), inline(A.mention)] → src[0] inline vs tgt[0] text → fail。
  //
  // SPAN-unwrap src:[text(主文), inline(A.url), inline(A.mention)](SPAN.main 展開為 text、
  // DIV/SPAN.mention-wrap 展開為 A.mention)。
  // SPAN-unwrap tgt:[text, inline(A.url), inline(A.mention)] = 3 items。
  // 對齊成功 → nodeValue mutate single。
  //
  // 只在 strict fail 後當 fallback 用,不取代 extractA3Seq(避免影響 Gemini LLM
  // path 的既有 spec 假設,LLM SPAN 走 paired marker,target 端保留 SPAN wrapper,
  // strict 就過,不會走到此 fallback)。
  function extractA3SeqSpanUnwrapped(rootEl, imgIsInline = false) {
    const seq = [];
    for (const child of rootEl.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.nodeValue && child.nodeValue.trim()) {
          seq.push({ type: 'text', node: child });
        }
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      // v1.9.31: IMG 視為 inline atomic 同 extractA3Seq(動態)
      if (imgIsInline && child.tagName === 'IMG') {
        seq.push({ type: 'inline', node: child, tag: 'IMG' });
        continue;
      }
      // SPAN 一律透明展開(無論有無 class、無論 inner 是 text 還是 element)
      if (child.tagName === 'SPAN') {
        const inner = extractA3SeqSpanUnwrapped(child, imgIsInline);
        for (const item of inner) seq.push(item);
      } else if (SK.isPreservableInline?.(child)) {
        // A / B / I / STRONG / EM / SUB / SUP / ... 維持 opaque inline
        seq.push({ type: 'inline', node: child, tag: child.tagName });
      } else {
        const inner = extractA3SeqSpanUnwrapped(child, imgIsInline);
        for (const item of inner) seq.push(item);
      }
    }
    return seq;
  }

  // Layer A3 helper:source seq vs target seq 對齊檢查 + 收集 text mutation pairs。
  // 配對成功 return mutation list(尚未實作 mutate);任何位置 type / inline tag 不對 → null。
  // inline element 內部遞迴對齊,因此 source 跟 target 結構必須完全同構。
  // Layer A3 helper:把 target container 內 text+br 結構還原成含 \n 的字串。
  // 對應 deserializer 的 buildFragmentFromTextWithBr:原 LLM \n 轉成 br,還原時 br 轉回 \n。
  function targetContainerToText(targetContainer) {
    let s = '';
    for (const child of targetContainer.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        s += child.nodeValue;
      } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'BR') {
        s += '\n';
      }
    }
    return s;
  }

  // 檢查 container 是否含直接 BR 子節點(extractA3Seq 對 BR 不收進 seq,
  // BR 在邊緣的 case 從 seq.length 看不出來,要看 container 本身)。
  function targetContainerHasBr(container) {
    if (!container || !container.childNodes) return false;
    for (const child of container.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'BR') return true;
    }
    return false;
  }

  // v1.9.31:1-to-1 text mutate 的 leading/trailing whitespace preserve helper。
  // 對應 X 推文「✨ Spatial...」emoji 後空格、「\n\n」段落空行等 — Google MT / LLM
  // 翻譯後常去掉原 leading space 跟 trailing \n,mutate src text 為純翻譯結果會丟失
  // 視覺結構。helper 規則:tgt 自帶 ws 優先用 tgt 的,否則 fallback 用 src ws(preserve)。
  function preserveWsTextMutate(srcVal, tgtVal) {
    const srcLead = (srcVal.match(/^\s+/) || [''])[0];
    const srcTrail = (srcVal.match(/\s+$/) || [''])[0];
    const tgtLead = ((tgtVal || '').match(/^\s+/) || [''])[0];
    const tgtTrail = ((tgtVal || '').match(/\s+$/) || [''])[0];
    const tgtStripped = (tgtVal || '').replace(/^\s+|\s+$/g, '');
    return (tgtLead || srcLead) + tgtStripped + (tgtTrail || srcTrail);
  }

  function collectA3Mutations(sourceContainer, targetContainer, mutations) {
    // v1.9.31:tgt 含 IMG → Google MT IMG atomic path → src 端也視 IMG 為 inline;
    // tgt 無 IMG → LLM Gemini path 對 IMG 透明,src 端也須透明(否則 src 多 IMG inline
    // 比 tgt 多,長度不符 fallback dual,破壞 LLM path 原本 work 的對齊)。
    const imgIsInline = !!targetContainer.querySelector?.('img');
    const sourceSeq = extractA3Seq(sourceContainer, imgIsInline);
    const targetSeq = extractA3Seq(targetContainer, imgIsInline);
    // Special case:source 是單一 text node(內含 \n)+ target 是純 text 序列(deserialize
    // 把原 LLM \n 拆成 br,extractA3Seq 不收 br)。還原 target br 為 \n 接成完整字串
    // 設給 source text node。對應 X tweetText 結構:source SPAN 內 1 text node 含
    // \n\n vs target SPAN 內 br+text+br 混合。
    //
    // 兩條 trigger path:
    //   - targetSeq.length > 1:BR 夾在 text 之間(原 \n 在文字中段),extractA3Seq
    //     drop BR 後剩多 text item。
    //   - targetSeq.length === 1 但 container 直接含 BR:BR 在邊緣(原 \n 在文字
    //     首/尾),drop BR 後僅剩 1 text item,length 看不出 BR 存在 → 加查 container
    //     本身有沒有 BR。對應 X tweet「\n\nEnjoy : )\n\n」結構,單純走 length > 1
    //     會漏。
    //   source 必須真的含 \n(否則保守走 normal flow,避免無中生有添加 \n)。
    if (sourceSeq.length === 1 && sourceSeq[0].type === 'text' &&
        targetSeq.every(t => t.type === 'text')) {
      const sourceHasNewline = /\n/.test(sourceSeq[0].node.nodeValue || '');
      if (targetSeq.length > 1
          || (targetSeq.length >= 1 && sourceHasNewline && targetContainerHasBr(targetContainer))) {
        mutations.push({
          node: sourceSeq[0].node,
          newValue: targetContainerToText(targetContainer),
        });
        return true;
      }
    }
    // 寬容對齊:source 是純 inline 序列(中間沒 text),target 是 inline + 之間穿插
    // free text node。對應 LLM(尤其 Flash Lite)重組句子時把原 placeholder 內文字
    // 搬到 placeholder 之間自由 text 區。把 target free text 吸收進「下一個 inline
    // 的 leading」,合進該 inline mutate 的 newValue。
    //
    // 真實案例(@jsnell 2026-05-20 probe + Flash Lite):
    //   source 結構:[SPAN("Steve Jobs in Exile by "), DIV(@geoffrey_cain), SPAN(" is out today..."), A.url]
    //   extractA3Seq source → [inline, inline, inline, inline](DIV 透明,recurse 進去抓 SPAN.r-18u37iz)
    //   target deserialize → [SPAN("由 "), SPAN.r-18u37iz, text(" 撰寫的"), SPAN("《...》..."), A.url]
    //   extractA3Seq target → [inline, inline, text, inline, inline]
    //   原本長度不符 4 vs 5 → fallback dual。寬容後把 " 撰寫的" 視為下一個 inline 的
    //   leading,合進 SPAN.middle 譯文 → mutate 結果「 撰寫的《Steve Jobs in Exile》...」。
    //
    // 守門:source 必須是純 inline(全 inline 沒夾 text),否則 source 結構複雜不易判斷
    // 自由 text 該吸收去哪。
    const sourceAllInline = sourceSeq.length > 0 && sourceSeq.every(s => s.type === 'inline');
    if (sourceAllInline && targetSeq.length !== sourceSeq.length) {
      const tightened = [];
      let prepend = '';
      for (const item of targetSeq) {
        if (item.type === 'text') {
          prepend += item.node.nodeValue || '';
        } else {
          tightened.push({ inline: item, prepend });
          prepend = '';
        }
      }
      // trailing free text(在最後一個 inline 之後)沒地方放,捨棄(罕見 + 通常是
      // LLM 譯文尾巴的標點,visually 影響小)。
      if (tightened.length === sourceSeq.length) {
        let allTagOk = true;
        for (let i = 0; i < sourceSeq.length; i++) {
          if (sourceSeq[i].tag !== tightened[i].inline.tag) { allTagOk = false; break; }
        }
        if (allTagOk) {
          for (let i = 0; i < sourceSeq.length; i++) {
            const s = sourceSeq[i];
            const t = tightened[i].inline;
            const pre = tightened[i].prepend;
            const innerMutations = [];
            const innerOk = collectA3Mutations(s.node, t.node, innerMutations);
            if (innerOk) {
              if (pre && innerMutations.length > 0) {
                // 把 free text 合進該 inline 的第一個 text mutation 的 leading
                innerMutations[0].newValue = pre + innerMutations[0].newValue;
              }
              for (const m of innerMutations) mutations.push(m);
            }
            // innerOk false:opaque(source 內部保留),free text 就丟掉(沒地方放;
            // 但這是 placeholder opaque case,通常 inline 內容無譯文意義,可接受)
          }
          return true;
        }
      }
    }

    if (sourceSeq.length === targetSeq.length) {
      let strictOk = true;
      const strictMutations = [];
      for (let i = 0; i < sourceSeq.length; i++) {
        const s = sourceSeq[i];
        const t = targetSeq[i];
        if (s.type !== t.type) { strictOk = false; break; }
        if (s.type === 'text') {
          strictMutations.push({
            node: s.node,
            newValue: preserveWsTextMutate(s.node.nodeValue || '', t.node.nodeValue || ''),
          });
        } else if (s.type === 'inline') {
          if (s.tag !== t.tag) { strictOk = false; break; }
          // inline 視為 opaque placeholder:遞迴對齊內部成功 → 套用 inner mutations;
          // 失敗 → 跳過該 inline 內部不 mutate(source 端原狀保留),不讓整段對齊
          // 因 inline 子結構不同構而 fail 觸發 dual sibling fallback。對應 X URL <a>
          // 場景:source <a> 含 <span class>https://</span>...<span>…</span> 三段
          // inline,deserializer 從 placeholder slot 還原時只剩 text node 子序列,
          // type 不符。協定本意是「inline placeholder 內部 source 端保持原樣」,
          // 此鬆綁讓父層 text 仍能照常 mutate,符合 CLAUDE.md §15 single 原地替換。
          const innerMutations = [];
          const innerOk = collectA3Mutations(s.node, t.node, innerMutations);
          if (innerOk) {
            for (const m of innerMutations) strictMutations.push(m);
          }
        }
      }
      if (strictOk) {
        for (const m of strictMutations) mutations.push(m);
        return true;
      }
    }

    const srcSpanU = extractA3SeqSpanUnwrapped(sourceContainer, imgIsInline);
    const tgtSpanU = extractA3SeqSpanUnwrapped(targetContainer, imgIsInline);
    if (srcSpanU.length === tgtSpanU.length && srcSpanU.length > 0) {
      const unwrapMutations = [];
      let unwrapOk = true;
      for (let i = 0; i < srcSpanU.length; i++) {
        const s = srcSpanU[i];
        const t = tgtSpanU[i];
        if (s.type !== t.type) { unwrapOk = false; break; }
        if (s.type === 'text') {
          // v2.0.78（批次 4 A3）：三條同型路徑（strict:1663 / 本條 / segment 1-to-1）
          // 唯獨這裡漏套 preserveWsTextMutate——Google MT 慣性吃掉 leading space 與
          // trailing \n（v1.9.31 加 helper 的原始動機場景），裸寫 nodeValue 會破壞
          // pre-wrap 段的視覺換行 / 間距結構
          unwrapMutations.push({
            node: s.node,
            newValue: preserveWsTextMutate(s.node.nodeValue || '', t.node.nodeValue || ''),
          });
        } else {
          // inline:tag 必符
          if (s.tag !== t.tag) { unwrapOk = false; break; }
          const innerMutations = [];
          const innerOk = collectA3Mutations(s.node, t.node, innerMutations);
          if (innerOk) {
            for (const m of innerMutations) unwrapMutations.push(m);
          }
        }
      }
      if (unwrapOk) {
        for (const m of unwrapMutations) mutations.push(m);
        return true;
      }
    }

    // v1.9.31 \n-aware segment fallback:SPAN-unwrap 等長對齊也失敗時,以 inline 為
    // 錨點把 srcSpanU / tgtSpanU 分段(inline 跟相鄰 text 區塊),inline-to-inline
    // tag 對齊 + 區段內多 text 用 \n join 起來 mutate。
    //
    // Why:X 推文使用者打 Enter 換行時 source 端 SPAN 內 text node 含 `\n` char
    // (white-space: pre-wrap render 出換行視覺),Google MT serializer 對 SPAN
    // 透明 + preserveNewlines=true 把 \n 送進 Google API,Google 翻完保留 \n,
    // deserialize 時 \n 拆成 BR + text node。target seq SPAN-unwrap 後比 src 多
    // 出 BR-split 的 text node,strict / SPAN-unwrap 等長都對不上。
    //
    // 對應 @asymco Mont Blanc / Exotica tweet(2026-05-20 Chrome for Claude probe):
    //   source structure:[SPAN.main(含 \n + Mont Blanc), A.url1, SPAN("\nExotica "), A.url2, ...hashtags]
    //   target structure(BR + text 拆 \n):[text(中文主文), BR, text(萬寶龍), A.url1, BR, text(奇特), A.url2, ...]
    //   src SpanU 6 vs tgt SpanU 7(BR-skip 後 tgt 主文段多 1 個 text)→ SPAN-unwrap fail。
    //   segment 後 inline 數量對等(4=4)→ 區段內 1 text vs N text 用 \n join mutate。
    function segment(seq) {
      const segs = [];
      let cur = [];
      for (const item of seq) {
        if (item.type === 'text') cur.push(item);
        else { segs.push(cur); segs.push(item); cur = []; }
      }
      segs.push(cur);
      return segs;
    }
    const srcSegs = segment(srcSpanU);
    const tgtSegs = segment(tgtSpanU);
    if (srcSegs.length === tgtSegs.length && srcSegs.length > 1) {
      const segMutations = [];
      let segOk = true;
      // 追蹤最近一個有內容的 text segment mutation（用於吸收 CJK 語序重排溢出文字）
      let lastProseMutationIdx = -1;
      // v1.10.49: 開頭溢出文字 — 譯文在「第一個 inline 之前」產生 source 沒有的
      // 文字,前面沒有 prose mutation 可往前吸,暫存後「往後」塞進下一個 mutation
      //（優先塞進下一個 inline 的內部首個 text mutation,保持視覺順序)。
      // 典型場景:source = [A(Bob Dylan), " and ", A(The Beatles), ", 1960s (...)"]
      // 開頭沒 text;LLM 語序重排譯成「1960 年代的 ⟦0⟧..⟦/0⟧ 與 ⟦1⟧..⟦/1⟧（...)」
      // → tgt 開頭多一個 text segment,原本直接 segOk=false 掉 dual visible
      //（2026-06-12 Medium figcaption 實測)。trade-off:塞進 inline 內部的文字
      // 會吃到該 inline 的樣式(連結底線等),換取 single 原地替換不掉 dual。
      let pendingLeadText = '';
      for (let i = 0; i < srcSegs.length; i++) {
        const ss = srcSegs[i];
        const ts = tgtSegs[i];
        if (i % 2 === 1) {
          // inline 位置
          if (ss.tag !== ts.tag) { segOk = false; break; }
          const inner = [];
          const innerOk = collectA3Mutations(ss.node, ts.node, inner);
          if (innerOk) {
            if (pendingLeadText && inner.length > 0) {
              inner[0].newValue = pendingLeadText + inner[0].newValue;
              pendingLeadText = '';
            }
            for (const m of inner) segMutations.push(m);
          }
          continue;
        }
        // text segment（可空）
        if (ss.length === 0 && ts.length === 0) continue;
        if (ss.length === 0 && ts.length > 0) {
          // CJK 語序重排：翻譯在 inline element 前後產生了 source 沒有的文字。
          // 典型場景：英文 "meet buddy @user"（mention 在句尾）翻成
          // 中文 "見到好友 @user 真是太棒了"（mention 後面多出 text）。
          // 把溢出文字吸收進最近一個有內容的 text segment mutation。
          if (lastProseMutationIdx >= 0) {
            const overflow = ts.map(t => (t.node.nodeValue || '')).join('');
            segMutations[lastProseMutationIdx].newValue += overflow;
            continue;
          }
          // 前面沒有 prose mutation（開頭溢出）→ 暫存往後塞
          pendingLeadText += ts.map(t => (t.node.nodeValue || '')).join('');
          continue;
        }
        // v1.9.31:Google MT 把短 metadata 連接詞(" by " / " - " / " via " /
        // " at "等)跟前段主文一起翻譯,deserialize 後該 text segment 在 tgt 消失。
        // src 端的 text 失去對應 tgt → mutate 為 "" 接受視覺上失去該連接詞(中文翻譯
        // 通常會把連接詞合進前後 text)。守門:只在 src 全部 text 加總 ≤ 12 字時容忍
        // (避免把實質 prose 丟掉)。
        if (ts.length === 0 && ss.length > 0) {
          const totalLen = ss.reduce((acc, item) => acc + (item.node.nodeValue || '').length, 0);
          if (totalLen <= 12) {
            for (const item of ss) {
              segMutations.push({ node: item.node, newValue: '' });
            }
            continue;
          }
          segOk = false; break;
        }
        if (ss.length === ts.length) {
          // 1-to-1 mutate:用 helper preserve src 原 leading/trailing whitespace
          // (含 \n 跟 leading space — Google MT 翻譯「 Spatial...\n」變「空間運算...」,
          // 失去前空格跟 trailing \n,視覺結構就破)
          for (let j = 0; j < ss.length; j++) {
            segMutations.push({
              node: ss[j].node,
              newValue: preserveWsTextMutate(ss[j].node.nodeValue || '', ts[j].node.nodeValue || ''),
            });
          }
          if (pendingLeadText) {
            // 開頭溢出文字沒能塞進前面的 inline(內部對齊 fail)→ 塞本 text segment 開頭
            const firstIdx = segMutations.length - ss.length;
            segMutations[firstIdx].newValue = pendingLeadText + segMutations[firstIdx].newValue;
            pendingLeadText = '';
          }
          lastProseMutationIdx = segMutations.length - 1;
        } else {
          // src N vs tgt M（N != M）— Google MT 對含 \n / IMG emoji / 多段 prose 的
          // 推文翻譯後 text 切分跟 src 不對等(IMG 透明不送 API、\n 拆 BR 後 skip
          // 不同數量)。catch-all:把 tgt 全部 text join 塞給 ss[0],ss[1..N] mutate
          // 為 ""。視覺結果:src 端集中 nodeValue 在 ss[0],含完整中文 + 分段。
          //
          // separator 看 src 全部 text 是否含 \n\n:含 → join('\n\n') 保留段落空行;
          // 否則 join('\n')。leading/trailing whitespace 從 src ss 整段抽含 space
          // 跟 \n(preserveWsTextMutate 同邏輯)。
          const ssJoined = ss.map(s => s.node.nodeValue || '').join('');
          const srcLead = (ssJoined.match(/^\s+/) || [''])[0];
          const srcTrail = (ssJoined.match(/\s+$/) || [''])[0];
          const sep = /\n\n/.test(ssJoined) ? '\n\n' : '\n';
          const tgtJoined = ts
            .map(t => (t.node.nodeValue || '').replace(/^\s+|\s+$/g, ''))
            .join(sep);
          segMutations.push({ node: ss[0].node, newValue: pendingLeadText + srcLead + tgtJoined + srcTrail });
          pendingLeadText = '';
          for (let j = 1; j < ss.length; j++) {
            segMutations.push({ node: ss[j].node, newValue: '' });
          }
          lastProseMutationIdx = segMutations.length - ss.length;
        }
      }
      // 開頭溢出文字到結尾都沒地方塞(後續 inline 內部對齊全 fail 且無 text
      // segment)→ 不可丟字,整段視為配對失敗走 dual fallback
      if (pendingLeadText) segOk = false;
      if (segOk) {
        for (const m of segMutations) mutations.push(m);
        return true;
      }
    }

    return false;
  }

  SK.tryInjectNodeValueMutate = function tryInjectNodeValueMutate(el, translation, slots) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (!translation || typeof translation !== 'string') return false;

    // Layer A3:slots > 0 場景(source 含 inline element 像 <a> / 帶 class SPAN)
    // 走「同構序列配對」path:source 跟 target 各自抽 [text|inline] 序列,N==N 同 type
    // 同 inline tag → 收集 text mutation list → 一次性 mutate text nodes nodeValue;
    // inline element 結構不動,React fiber DOM ref 完整保留。
    // 配對失敗(序列長度不一 / type 不對 / inline tag 不對)→ return false 走 fallback dual。
    if (slots && slots.length > 0) {
      if (!SK.deserializeWithPlaceholders) return false;
      // cloneReuse:A3 對齊探測用 frag，不注回 el——不 clone 會在探測前就把按鈕搬離 el
      const { frag, ok } = SK.deserializeWithPlaceholders(translation, slots, { cloneReuse: true });
      if (!ok || !frag) return false;
      // 快速 short-circuit:source 沒任何 visible content → 不適合 mutate
      if (extractA3Seq(el).length === 0) return false;
      const mutations = [];
      const aligned = collectA3Mutations(el, frag, mutations);
      if (!aligned) return false;
      // v2.0.65: aligned 但 0 條 text mutation = 譯文一個字都寫不進去，不算注入成功。
      // 結構成因：整段被單一 preservable inline（如帶 class 的 SPAN wrapper）包住時，
      // 頂層對齊只有 inline↔inline 一對；而 collectA3Mutations 對 opaque inline 的
      // 內部對齊失敗刻意不致命（v1.9.31 鬆綁，見該處註解）——內部不同構（模型弄壞
      // 佔位符巢狀）時 strictMutations 收集到空陣列照樣 return true。這裡若不擋，
      // 回 true 後 caller 的 echo 偵測看 DOM 文字沒變 → 誤判「模型 echo」→ 沖回
      // 原文 + 標已翻，好譯文被靜默丟棄（Verge Installer 頁實例，cage MutationObserver
      // 抓到零 characterData 寫入）。回 false 讓段落走 A3.5 flatten / dual fallback。
      if (mutations.length === 0) return false;
      if (mutations.some(m => !m.node.isConnected)) return false;
      if (!STATE.nodeValueMutateBackup) STATE.nodeValueMutateBackup = new Map();
      if (!STATE.nodeValueMutateBackup.has(el)) {
        // backup 同時存 originalValue(restorePage 還原用)與 translatedValue(Layer A4
        // partial-reset detect 用 — framework 把任一 backup text node reset 成新值
        // 時 nodeValue !== translatedValue 觸發 unmark + 重翻)。
        STATE.nodeValueMutateBackup.set(el,
          mutations.map(m => ({
            node: m.node,
            originalValue: m.node.nodeValue,
            translatedValue: m.newValue,
          }))
        );
      }
      for (const m of mutations) m.node.nodeValue = m.newValue;
      return true;
    }

    // 空 slots 不變量守門(佔位符外洩防線):此段(Case 2/3/3b)不經 deserialize,直接把
    // translation / chunks 寫進 text node nodeValue,並存進 nodeValueMutateBackup 供 guard
    // 重放。若譯文因快取殘留 / reflow 帶了佔位符 ⟦N⟧,必須在寫入 + backup 前先剝除,否則
    // 佔位符不只漏進畫面,還會被 guard 當「乾淨譯文」反覆重放。guard 直呼本函式(content-spa
    // 的 nvMutate guard)也經此,故這道防線與 injectTranslation 入口那道互補、不重複。
    if (typeof translation === 'string' && SK.stripStrayPlaceholderMarkers) {
      translation = SK.stripStrayPlaceholderMarkers(translation);
    }

    const textNodes = SK.collectVisibleTextNodes?.(el);
    if (!textNodes || textNodes.length === 0) return false;
    if (textNodes.some(n => !n.isConnected)) return false;

    if (!STATE.nodeValueMutateBackup) STATE.nodeValueMutateBackup = new Map();

    // Case 2: single source text node — 整段譯文(含 \n)mutate 進去
    if (textNodes.length === 1) {
      const node = textNodes[0];
      if (!STATE.nodeValueMutateBackup.has(el)) {
        STATE.nodeValueMutateBackup.set(el, [{ node, originalValue: node.nodeValue, translatedValue: translation }]);
      }
      node.nodeValue = translation;
      return true;
    }

    // Case 3: multi source text nodes — 譯文按 \n+ 切 chunks,N == chunks 1:1 配對
    const chunks = translation.split(/\n+/).map(s => s).filter(s => s.length > 0);
    if (chunks.length !== textNodes.length) {
      // Case 3b: chunks < textNodes — React site 把同段落文字拆多個 inline SPAN
      // (X tweetText / Threads / Reddit),inline 分隔不產 \n,翻譯結果自然
      // 比 source text node 少 chunk。策略:整段譯文塞第一個 text node,其餘清空。
      if (chunks.length > 0 && chunks.length < textNodes.length) {
        if (!STATE.nodeValueMutateBackup) STATE.nodeValueMutateBackup = new Map();
        if (!STATE.nodeValueMutateBackup.has(el)) {
          STATE.nodeValueMutateBackup.set(el,
            textNodes.map((node, i) => ({
              node,
              originalValue: node.nodeValue,
              translatedValue: i === 0 ? translation : '',
            }))
          );
        }
        textNodes[0].nodeValue = translation;
        for (let i = 1; i < textNodes.length; i++) {
          textNodes[i].nodeValue = '';
        }
        return true;
      }
      return false;
    }

    // 都 OK,做 backup + mutate
    if (!STATE.nodeValueMutateBackup.has(el)) {
      const backup = textNodes.map((node, i) => ({ node, originalValue: node.nodeValue, translatedValue: chunks[i] }));
      STATE.nodeValueMutateBackup.set(el, backup);
    }
    for (let i = 0; i < textNodes.length; i++) {
      textNodes[i].nodeValue = chunks[i];
    }
    return true;
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
    // v1.8.31:
    //   - dark variant 用 [data-sk-theme="dark"] 切配色（避免 tint 米色底在 dark
    //     mode 頁面跟淺灰文字對比破裂)
    //   - tint 加 border-radius + 加大 padding，避免文字貼塊邊
    //   - box-sizing: border-box 讓 padding 算進寬度內，不溢出原段落視覺寬
    //   - 標題後的 wrapper 拉大 margin-top(`<h1>` 等大字級 line-height 把 0.25em
    //     吃光，標題與譯文視覺零間距)
    // marginTop：標題後拉開 0.5em(原 0.25em 太小，大字級標題 line-height 會把
    // 它吃光)；其他元素維持 0.25em。原段落若有 paddingBottom,injectDual 會在
    // wrapper 上設 inline marginTop 負值覆蓋這條 CSS 預設。
    // v1.8.52:
    //   - dark auto 對比加強（tint 0.08 → 0.14、bar/dashed 灰色 → #B7BDC4）解決
    //     issue #35 強調色看不清的回報
    //   - bar 統一 2px → 3px(細邊在淺灰底色站點本來就不夠醒目)
    //   - 加 [data-sk-accent="custom"] 配色：三種 mark 共用 inline `--sk-accent-rgb`
    //     變數套色；tint 走 alpha,bar/dashed 走實心色
    style.textContent =
      `${tag} { display: block; margin-top: 0.5em; margin-bottom: 0.5em; box-sizing: border-box; }\n` +
      // light (default / auto)
      `${tag}[data-sk-mark="tint"]   { background-color: #FFF8E1; padding: 4px 8px; border-radius: 4px; }\n` +
      `${tag}[data-sk-mark="bar"]    { border-left: 3px solid #9CA3AF; padding-left: 8px; }\n` +
      `${tag}[data-sk-mark="dashed"] { text-decoration: underline wavy #C7CDD3; text-decoration-thickness: 1px; text-underline-offset: 4px; }\n` +
      `${tag}[data-sk-mark="none"]   {}\n` +
      // dark (default / auto)
      `${tag}[data-sk-mark="tint"][data-sk-theme="dark"]   { background-color: rgba(255, 255, 255, 0.14); }\n` +
      `${tag}[data-sk-mark="bar"][data-sk-theme="dark"]    { border-left-color: #B7BDC4; }\n` +
      `${tag}[data-sk-mark="dashed"][data-sk-theme="dark"] { text-decoration-color: #B7BDC4; }\n` +
      // custom accent(token 或 hex 經 sanitize 套到三種 mark）
      `${tag}[data-sk-accent="custom"][data-sk-mark="tint"]   { background-color: rgb(var(--sk-accent-rgb) / 0.15); }\n` +
      `${tag}[data-sk-accent="custom"][data-sk-mark="tint"][data-sk-theme="dark"] { background-color: rgb(var(--sk-accent-rgb) / 0.22); }\n` +
      `${tag}[data-sk-accent="custom"][data-sk-mark="bar"]    { border-left-color: rgb(var(--sk-accent-rgb)); }\n` +
      `${tag}[data-sk-accent="custom"][data-sk-mark="dashed"] { text-decoration-color: rgb(var(--sk-accent-rgb)); }\n`;
    (document.head || document.documentElement).appendChild(style);
  };

})(window.__SK);
