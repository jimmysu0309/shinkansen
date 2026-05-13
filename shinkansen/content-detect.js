// content-detect.js — Shinkansen 段落偵測
// 負責語言偵測、容器排除、段落收集（collectParagraphs）、fragment 抽取。

(function(SK) {
  if (!SK || SK.disabled) return;  // v1.5.2: iframe gate（見 content-ns.js）

  // ─── v0.76: 自動語言偵測 ─────────────────────────────────
  // 補字策略:detectTextLang 用 simpCount/cjkCount ≥ 0.2 判 zh-Hans。短文(< 30 cjk)
  // 在 set 命中率低時 ratio 過不了門檻會被誤判 zh-Hant。真實案例:X 引用文章卡片
  // "手冲咖啡进阶指北：冠军参数如何变成你的日常 - 少数派" 23 cjk 內含 8 簡中字,但
  // 原 set 只有「进数变数」4 字命中,4/23 ≈ 0.17 < 0.2 → 整段被當「已是繁中」跳過,
  // 卡片標題永遠不翻。補上常見高頻簡中專屬字,讓覆蓋率夠跨過閾值。
  const SIMPLIFIED_ONLY_CHARS = new Set(
    '们这对没说还会为从来东车长开关让认应该头电发问时点学两' +
    '乐义习飞马鸟鱼与单亲边连达远运进过选钱铁错阅难页题风' +
    '饭体办写农决况净减划动务区医华压变号叶员围图场坏块' +
    '声处备够将层岁广张当径总战担择拥拨挡据换损摇数断无旧显' +
    '机权条极标样欢残毕气汇沟泽浅温湿灭灵热爱状独环现盖监盘' +
    '码确离种积称穷竞笔节范药虑虽见规览计订训许设评识证诉试' +
    '详语误读调贝负贡财贫购贸费赶递邮释银锁门间隐随雾静须领' +
    '颜饮驱验鸡麦龙龟齿齐复' +
    // 補字(覆蓋常見高頻簡中字,各自有獨立繁體對應):
    //   冲沖 阶階 军軍 参參 个個 国國 几幾 网網 听聽 觉覺
    //   实實 给給 红紅 终終 经經 历歷 论論 类類 优優 报報
    //   视視 业業 谢謝 该該 带帶 怀懷 听聽 觉覺 总總 单單 紧緊
    //   担擔 创創 际際 际 试試 询詢 综綜 务務 务 优優 优 织織
    //   钟鐘 销銷 续續 责責 资資 状狀 状 涉涉 注 关關 兴興 离離 离
    '冲阶军参个国几网听觉实给红终经历论类优报视业谢该带怀紧创际综钟销续责资兴'
  );

  const NON_CHINESE_LANG_PREFIX = /^(ja|ko)\b/i;

  // P1: 原 isTraditionalChinese 拆分為通用 detectTextLang(回傳語言類別) +
  //     target-aware isAlreadyInTarget(target=='zh-TW' 跳繁中、'zh-CN' 跳簡中、'en' 跳英文)。
  //     既有 isTraditionalChinese 保留為 alias,避免外部 reference 斷掉(spec / 字幕路徑等)。
  //
  // 回傳:'zh-Hant' | 'zh-Hans' | 'ja' | 'ko' | 'en' | 'other'
  //   - 'zh-Hant' = 繁體中文(cjk 多 + 沒簡體特徵字)
  //   - 'zh-Hans' = 簡體中文(cjk 多 + 簡體特徵字比例 ≥ 0.2)
  //   - 'ja' / 'ko' = htmlLang 明示
  //   - 'en' = 主要 ASCII letter,cjk 比例 < 0.05
  //   - 'other' = 其他狀況(短文字 / 純符號 / 多語混雜等)
  SK.detectTextLang = function detectTextLang(text) {
    const htmlLang = document.documentElement.lang || '';
    if (/^ja\b/i.test(htmlLang)) return 'ja';
    if (/^ko\b/i.test(htmlLang)) return 'ko';

    const lettersOnly = text.replace(/[\s\d\p{P}\p{S}]/gu, '');
    if (lettersOnly.length === 0) return 'other';

    let cjkCount = 0;
    let simpCount = 0;
    let kanaCount = 0;
    let hangulCount = 0;
    let asciiLetterCount = 0;

    for (const ch of lettersOnly) {
      const code = ch.codePointAt(0);
      if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF)) {
        cjkCount++;
        if (SIMPLIFIED_ONLY_CHARS.has(ch)) simpCount++;
      } else if ((code >= 0x3040 && code <= 0x309F) || (code >= 0x30A0 && code <= 0x30FF)) {
        kanaCount++;
      } else if (code >= 0xAC00 && code <= 0xD7AF) {
        // P1 v1.8.59:hangul Unicode 區段(韓文音節)
        hangulCount++;
      } else if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) {
        asciiLetterCount++;
      }
    }

    // hangul 比例 > 5% → 視為韓文
    if (hangulCount > 0 && hangulCount / lettersOnly.length > 0.05) return 'ko';
    // 假名比例 > 5% → 視為日文(跟原 isTraditionalChinese 邏輯一致)
    if (kanaCount > 0 && kanaCount / lettersOnly.length > 0.05) return 'ja';

    const cjkRatio = cjkCount / lettersOnly.length;
    if (cjkRatio >= 0.5) {
      // 主要是 CJK ── 依簡體特徵字比例分繁簡
      if (cjkCount > 0 && simpCount / cjkCount >= 0.2) return 'zh-Hans';
      return 'zh-Hant';
    }

    // 主要是 ASCII letter(包括英 / 西 / 法 / 德等所有拉丁字母語言)
    // 文字級無法區分這些語言(都是 ASCII letter),統一回 'en' 作為「拉丁字母 letter-dominant」識別。
    // isAlreadyInTarget 對 es/fr/de target 一律 return false(讓 LLM 端處理 echo / 翻譯判斷)。
    if (cjkRatio < 0.05 && asciiLetterCount / lettersOnly.length >= 0.5) return 'en';

    return 'other';
  };

  // P1: target-aware「源語言已等於目標語言」判定。
  //   target='zh-TW' → 跳 'zh-Hant'(維持 v1.8.58 之前行為)
  //   target='zh-CN' → 跳 'zh-Hans'
  //   target='en'    → 跳 'en'(主要 ASCII letter)
  //   target='ja'    → 跳 'ja'(假名比例 > 5%)
  //   target='ko'    → 跳 'ko'(hangul 比例 > 5%)
  //   target='es' / 'fr' / 'de' → 一律 false(拉丁字母文字級無法區分,讓 LLM 端處理 echo)
  //   不認得的 target 一律 false(不跳,送 LLM 翻)。
  SK.isAlreadyInTarget = function isAlreadyInTarget(text, target) {
    const detected = SK.detectTextLang(text);
    if (target === 'zh-TW') return detected === 'zh-Hant';
    if (target === 'zh-CN') return detected === 'zh-Hans';
    if (target === 'en')    return detected === 'en';
    if (target === 'ja')    return detected === 'ja';
    if (target === 'ko')    return detected === 'ko';
    // es / fr / de:文字級無法區分,return false(送 LLM 處理)
    return false;
  };

  // P1: 既有 isTraditionalChinese 保留為 zh-TW 專用 alias(spec / 字幕路徑等仍 reference)。
  // 行為等同 isAlreadyInTarget(text, 'zh-TW')。
  SK.isTraditionalChinese = function isTraditionalChinese(text) {
    return SK.isAlreadyInTarget(text, 'zh-TW');
  };

  // 讀 element 自身或最近 ancestor 的 lang attribute,return lowercase or null。
  // 用於 isCandidateText 對社群網站(Twitter / Reddit / Threads / Mastodon / Discord web)的
  // lang attribute 信號優先於純文字 detect — short text(< 30 cjk)時 SIMP 集合命中率
  // 跨不過 0.2 閾值會被誤判 zh-Hant skip,但 Twitter 等站對每則內容都標 lang(simp tweet
  // 標 "zh"、繁中 tweet 標 "zh-TW"/"zh-Hant"),用此信號可 robust 判斷。
  function getElementLangHint(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (cur.lang) return cur.lang.toLowerCase();
      const attr = cur.getAttribute && cur.getAttribute('lang');
      if (attr) return attr.toLowerCase();
      cur = cur.parentElement;
    }
    return null;
  }
  // 暴露給 spec 用
  SK._getElementLangHint = getElementLangHint;

  // 對應 target,根據 lang attribute 決定是否「已是目標語言」(skip)或「明確需要翻」。
  // 回傳:'skip'(明確已是 target)/ 'translate'(明確需要翻)/ 'unknown'(無 hint 或 lang 不對應)
  // unknown 由 caller fallback 到純文字 detectTextLang。
  function langHintDecision(langHint, target) {
    if (!langHint) return 'unknown';
    // 規範化:zh-Hant / zh-TW / zh-HK / zh-MO 都視為 zh-Hant 系列;
    //         zh / zh-Hans / zh-CN / zh-SG 都視為 zh-Hans 系列(zh 無後綴 Twitter 對簡中標)。
    const isZhHant = /^zh-(hant|tw|hk|mo)$/i.test(langHint);
    const isZhHans = langHint === 'zh' || /^zh-(hans|cn|sg)$/i.test(langHint);
    if (target === 'zh-TW') {
      if (isZhHant) return 'skip';
      if (isZhHans) return 'translate';
    } else if (target === 'zh-CN') {
      if (isZhHans) return 'skip';
      if (isZhHant) return 'translate';
    } else if (target === 'en') {
      if (/^en\b/i.test(langHint)) return 'skip';
    } else if (target === 'ja') {
      if (/^ja\b/i.test(langHint)) return 'skip';
    } else if (target === 'ko') {
      if (/^ko\b/i.test(langHint)) return 'ko' === target ? 'skip' : 'unknown';
    }
    return 'unknown';
  }
  SK._langHintDecision = langHintDecision;

  function isCandidateText(el) {
    // v1.6.9: textContent 取代 innerText——innerText 觸發 layout 重算（每呼叫一次
    // 都 force layout reflow，在 leaf div/span 全頁掃描路徑會被呼叫上千次）。
    // textContent 純讀字串樹不 force layout。差異：textContent 包含 display:none
    // 子樹文字；但 isVisible 在多處已過濾隱藏祖先，剩餘 edge case 僅是「父可見、
    // 子隱藏」混排（極罕見），對長度/語言判斷不足以改變結果。
    const text = el.textContent?.trim();
    if (!text || text.length < 2) return false;
    if (!/[\p{L}]/u.test(text)) return false;
    // P1: target-aware「已是目標語言」跳過。STATE.targetLanguage 由 content.js translatePage
    //     開始時從 storage 注入,預設 'zh-TW' 維持既有行為。
    const target = SK.STATE?.targetLanguage || 'zh-TW';
    // lang attribute hint 優先於純文字 detect:
    //   social 站(Twitter / Reddit / Threads / Mastodon)對每則內容標 lang;
    //   短簡中 tweet(< 30 cjk)SIMP 集合命中率跨不過 0.2 閾值會被誤判 zh-Hant skip。
    //   明確 lang attribute 信號比 SIMP 統計強得多,優先使用。沒 lang 的站維持純文字 detect。
    const langHint = getElementLangHint(el);
    const decision = langHintDecision(langHint, target);
    if (decision === 'skip') return false;
    if (decision === 'translate') return true;
    // unknown(沒 lang 或 lang 不對應)→ fallback 到純文字 detect
    if (SK.isAlreadyInTarget(text, target)) return false;
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

  // 結構性 code 容器偵測：祖先 computed font-family 含等寬字眼且 white-space 為
  // pre 系列。這是所有 code rendering 共通的物理特徵（GitHub 新版 React 檔案瀏覽
  // 器 / GitLab / Bitbucket / VSCode Web / CodeMirror / Monaco / Prism / highlight.js
  // 都通用)，不依賴任何站點 class / id，符合硬規則 §6 / §8。
  // 兩條都成立才 reject——只 monospace 沒 pre 可能是 inline `<code>` 風格的小品味，
  // 一般文章正文不會兩條同時成立。
  const _MONOSPACE_FONT_RE = /(?:^|[\s,'"])(monospace|Menlo|Consolas|Monaco|Courier|Fira(?:\s+Code|\s+Mono)?|Source\s+Code|JetBrains|Cascadia|Roboto\s+Mono|SFMono|SF\s+Mono|ui-monospace)(?:[\s,'"]|$)/i;

  // 自然語言 inline 元素：出現在 <pre> 內表示是引用文字（Medium 留言等)，不是 code。
  const PROSE_INLINE_TAGS = new Set(['A', 'EM', 'STRONG', 'I', 'B', 'CITE', 'Q', 'MARK', 'SMALL', 'INS', 'DEL', 'U']);

  // 純識別符 cell 偵測：GitHub/GitLab/Bitbucket 檔案列表 filename 欄、版號、hash、
  // commit short id 之類字串翻譯後跟原文相同（`.github` → `.github`）或對中文讀者
  // 沒意義（`app` → `應用程式`，但 `app` 是檔名，翻了反而誤導)。wrapper 純粹是視覺
  // 垃圾。
  //
  // 結構性條件：文字只含 word char + dot + slash + hyphen + underscore + < 40 字。
  // 額外需滿足下列之一（防誤殺 plain 英文字 "Yes"/"Done"/"OK"):
  //   (a) 文字含 `.`/`/`/`-`(filename hint:`.github`/`v0.5.24`/`feat-x` 等)
  //   (b) cell 內含 svg/img 子（icon-label pattern：檔案夾 / 檔案 icon + 名稱)
  const PURE_IDENTIFIER_RE = /^[\w./\-]+$/;
  const FILENAME_HINT_RE = /[./\-]/;
  function isPureIdentifierCell(el) {
    const text = (el.textContent || '').trim();
    if (text.length === 0 || text.length >= 40) return false;
    if (!PURE_IDENTIFIER_RE.test(text)) return false;
    if (FILENAME_HINT_RE.test(text)) return true;
    if (el.querySelector('svg, img')) return true;
    return false;
  }

  // 日期 / 時間戳記 cell:GitHub commit 時間欄（`May 7, 2026` / `5 minutes ago` /
  // `last month`)、ISO date(`2026-05-07`）等格式。LLM 對短日期串容易 hallucinate
  // 出無關長文（觀察：`May 7, 2026` → 數百字 Microsoft 創辦故事)，且日期翻譯本身
  // 對中文讀者價值不高（`5 minutes ago` 已普及)，全部跳過。
  const DATE_PATTERNS = [
    // "May 7, 2026" / "Dec 12, 2024" / "September 3, 2025"
    /^[A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4}$/,
    // "2026-05-07" / "2026/05/07" / "07-05-2026"
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/,
    /^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/,
    // Relative: "5 minutes ago" / "2 hours ago" / "3 days ago" / "last month"
    /^\d+\s+(?:minute|hour|day|week|month|year)s?\s+ago$/i,
    /^last\s+(?:week|month|year)$/i,
    /^(?:yesterday|today|now)$/i,
    // 純時長： "5 minutes" / "3 days"
    /^\d+\s+(?:minute|hour|day|week|month|year)s?$/i,
  ];
  function isDateLikeText(el) {
    const text = (el.textContent || '').trim();
    if (text.length === 0 || text.length >= 30) return false;
    return DATE_PATTERNS.some((re) => re.test(text));
  }
  function isCodeContainer(el) {
    if (!el || el.nodeType !== 1) return false;
    // <pre> 有專屬規則（pre+code→skip,pre 單獨→當文字段落，例如 Medium 留言),
    // 不能被結構性 monospace 規則覆蓋。<pre> 的 UA 預設 white-space:pre + monospace
    // 字型剛好命中下面條件，但其語意應由 acceptNode 內 PRE+code 路徑（content-detect.js
    // 第 ~265 行）決定，不在此處判斷。
    if (el.tagName === 'PRE') return false;
    const cs = window.getComputedStyle(el);
    if (!cs) return false;
    const ws = cs.whiteSpace || '';
    if (ws !== 'pre' && ws !== 'pre-wrap' && ws !== 'break-spaces') return false;
    const ff = cs.fontFamily || '';
    return _MONOSPACE_FONT_RE.test(ff);
  }

  // v1.6.9: 加入 memo 參數做 per-call cache。原版每次從 el 走到 body
  // 是 O(depth)，在 walker acceptNode + 三條 querySelectorAll 補抓路徑被
  // 重複呼叫，實測同一個祖先鏈會被走過數百次。Map<el, bool> 把每個祖先
  // 第一次計算後的結果記下，後續任何後代命中即 O(1) 短路。memo 為純函式
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
      // v1.5.2: 祖先若是 dual 模式注入的譯文 wrapper，整段 skip。
      // acceptNode 流程已用 HARD_EXCLUDE_TAGS 擋住 wrapper 子樹，
      // 但 leaf content div/span / anchor / grid td 三條補抓路徑用
      // querySelectorAll 繞過 TreeWalker，必須在這裡再擋一次。
      if (tag === 'SHINKANSEN-TRANSLATION') { result = true; break; }
      // 結構性 code 容器排除（monospace + white-space:pre 系)。詳見 isCodeContainer
      // 註解。放在 SEMANTIC / SHINKANSEN 之後是因為較貴（getComputedStyle)，先讓
      // 便宜的 tag-based 比對短路。
      if (isCodeContainer(cur)) { result = true; break; }
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
    const buttons = el.querySelectorAll('button, [role="button"]');
    if (buttons.length === 0) return false;
    // 程式碼區塊複製按鈕（GitHub `<clipboard-copy>` / 通用「button 跟 <pre> 同
    // 父層」結構）是 utility，不是父段落本身的互動。從 button 往上 walk，若任一
    // 層的兄弟元素含 <pre>，視為 code-block utility，從 widget 計數中剔除。
    //
    // v1.8.60: <a role="button"> 有真實 href(非 '#' / 'javascript:' / 空)→ 視為
    // navigation link,不算互動 widget(swiper carousel / Bootstrap nav-pills 慣例,
    // 把 role="button" 加在 nav anchor 上是 a11y 提示,並非真按鈕)。對應 upmedia.mg
    // 主選單(<li><a href="/tw/project/..." role="button">短文字</a></li>)case,
    // 沒這條 nav LI 整顆被 widget skip → 短中文 nav 翻不到。'#' / 'javascript:' /
    // 空 href 仍視為真 widget(SPA dropdown trigger / accordion toggle 等本質上
    // 不 navigate,只觸發 JS 行為)。
    //
    // v1.8.61: 進一步收緊 — `aria-haspopup="true"` 是 ARIA 標準明確聲明「會展開
    // popup / menu」,等同 dropdown trigger,即使 href 是真 URL 也維持 widget skip。
    // 對應 upmedia.mg 主選單真實結構(`<a role="button" aria-haspopup="true">頂層</a>
    // <div class="dropdown-menu"><a class="dropdown-item">子項</a>…</div>`):若不擋,
    // collectParagraphs 會把 LI 整顆收進候選,inject 譯文時嵌套 dropdown-menu 結構
    // 被破壞 → 全部子項平鋪展開亂版。Bootstrap / Headless UI / Reach UI 等任何符合
    // ARIA 的 dropdown 共用此屬性,屬結構性通則不是站點特判。
    let nonUtilityCount = 0;
    for (const btn of buttons) {
      if (btn.tagName === 'A' && btn.getAttribute('role') === 'button') {
        const ariaHaspopup = btn.getAttribute('aria-haspopup');
        const isPopupTrigger = ariaHaspopup && ariaHaspopup !== 'false';
        const href = btn.getAttribute('href');
        const hasRealHref = href && href !== '#' && !href.startsWith('javascript:');
        if (hasRealHref && !isPopupTrigger) continue;
      }
      let cur = btn;
      let isCodeUtility = false;
      while (cur && cur !== el && cur.parentElement) {
        const parent = cur.parentElement;
        for (const sib of parent.children) {
          if (sib === cur) continue;
          if (sib.tagName === 'PRE' || (sib.querySelector && sib.querySelector('pre'))) {
            isCodeUtility = true;
            break;
          }
        }
        if (isCodeUtility) break;
        cur = parent;
      }
      if (!isCodeUtility) nonUtilityCount++;
    }
    if (nonUtilityCount === 0) return false;
    // v1.6.9: 此處刻意保留 innerText（不改 textContent）。語意上「>=300 字
    // 視為非 widget」要的是「使用者實際看得到的字數」，改成 textContent 會把
    // 隱藏 modal/menu/dropdown 的字也算進來，可能讓本應被視為 widget 的元件
    // 通過篩選被翻譯。Twitter / Gmail 這類站常見，風險過大。此函式只在 walker
    // accept 路徑被呼叫一次/element，非熱點。
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

  // Case D 用：el 是否有直接 element 子（BR 不算)。
  // 跟 hasBrChild 對稱：Case B 抓「BR + 純文字」,Case D 抓「inline element + 文字」。
  function hasDirectNonBrElement(el) {
    for (const child of el.childNodes) {
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (child.tagName === 'BR') continue;
      return true;
    }
    return false;
  }

  // Case D 用：祖先鏈是否已被某條路徑抽過 fragment。SPAN 嵌套（host > inner-span > a)
  // 在 YouTube / 通用 web 都很常見，父抽完後子的 walker visit 仍會發生（NodeFilter.FILTER_SKIP
  // 不阻擋 walker 訪問子節點)，不擋祖先會把同一段文字重複抽兩次，deserialize 時佔位符 slot
  // 對不上譯文。Case A/B/C 因為 CONTAINER_TAGS 限定 DIV/SECTION 等少嵌套 tag 沒踩到，
  // Case D 把 SPAN 納入後必須補上。
  function hasAncestorExtracted(el, fragmentExtracted) {
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
      if (fragmentExtracted.has(cur)) return true;
      cur = cur.parentElement;
    }
    return false;
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
      // v1.2.0: 已翻譯成 target 語言的 fragment 不再重複收集
      // （fragment 注入後父元素不帶 data-shinkansen-translated，
      //   若不在此過濾，SPA observer rescan 會無限迴圈）
      // P1 (v1.8.59):從寫死 isTraditionalChinese 改成 target-aware ──
      //   原邏輯只考慮 target=zh-TW(只翻成繁中),target=en/zh-CN 時繁中原文(例如新聞標題)
      //   會被誤判「已是 target」直接跳掉,造成「target=en 但中文標題沒翻」的 bug。
      const _target = SK.STATE?.targetLanguage || 'zh-TW';
      if (trimmed.length >= 2 && SK.isAlreadyInTarget(trimmed, _target)) {
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
    // 期間 DOM 不變，同一祖先鏈只算一次。
    const excludedMemo = new Map();
    // v1.8.14: 補抓三條（leaf anchor / leaf div span / 等）共用的「BLOCK 祖先」memo。
    // 之前每條補抓路徑各自從葉節點 walk 到 body，大頁面浪費上千次祖先比對。
    const blockAncestorMemo = new Map();
    function hasBlockAncestor(el) {
      if (blockAncestorMemo.has(el)) return blockAncestorMemo.get(el);
      const chain = [];
      let cur = el.parentElement;
      let result = false;
      while (cur && cur !== document.body) {
        if (blockAncestorMemo.has(cur)) {
          result = blockAncestorMemo.get(cur);
          break;
        }
        chain.push(cur);
        if (SK.BLOCK_TAGS_SET.has(cur.tagName)) {
          result = true;
          break;
        }
        cur = cur.parentElement;
      }
      // 把整條 chain memoize 為相同結果
      for (const node of chain) blockAncestorMemo.set(node, result);
      blockAncestorMemo.set(el, result);
      return result;
    }

    // v1.9.13: open Shadow DOM 支援。walker + 4 條補抓抽進 processScope，
    // 主 root(document.body)跑一次,再對 root subtree 內每個 open shadow root
    // 各跑一次。closed shadow root 受 web spec 限制無法 traverse,直接跳過。
    // 共用 seen / excludedMemo / fragmentExtracted / blockAncestorMemo,避免 host
    // 與 shadow 重複計算或 inject 衝突。
    function processScope(scopeRoot) {
    const walker = document.createTreeWalker(scopeRoot, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (SK.HARD_EXCLUDE_TAGS.has(el.tagName)) {
          if (stats) stats.hardExcludeTag = (stats.hardExcludeTag || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        if (el.tagName === 'PRE') {
          // (a) 經典 markdown 渲染：<pre><code>... → skip
          if (el.querySelector('code')) {
            if (stats) stats.hardExcludeTag = (stats.hardExcludeTag || 0) + 1;
            return NodeFilter.FILTER_REJECT;
          }
          // (b) 語法高亮 <pre>:GitHub PrettyLights / hljs / prism / shiki 等用 <span>
          //     做 token，結構是「<pre>{text + <span>}*</pre>」，沒有 <code> 包裹。
          //     直接 element 子全是 <span>(且至少有一個)、無 <a>/<em>/<strong> 等
          //     自然語言 inline → 視為 code。
          //     不誤殺 Medium 留言用 <pre> 引用文字（那種通常含 <a> / <em>)。
          let hasSpan = false;
          let hasProseInline = false;
          for (const child of el.children) {
            if (child.tagName === 'SPAN') hasSpan = true;
            else if (PROSE_INLINE_TAGS.has(child.tagName)) hasProseInline = true;
          }
          if (hasSpan && !hasProseInline) {
            if (stats) stats.hardExcludeTag = (stats.hardExcludeTag || 0) + 1;
            return NodeFilter.FILTER_REJECT;
          }
        }
        if (el.hasAttribute('data-shinkansen-translated')) {
          if (stats) stats.alreadyTranslated = (stats.alreadyTranslated || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        // TD/TH 純識別符 cell skip：檔案列表 filename 欄、版號、hash 等。
        if ((el.tagName === 'TD' || el.tagName === 'TH') && isPureIdentifierCell(el)) {
          if (stats) stats.pureIdentifierCell = (stats.pureIdentifierCell || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        // 日期 / 時間戳 cell skip:LLM 對短日期串易 hallucinate 出無關長文。
        if (isDateLikeText(el)) {
          if (stats) stats.dateLikeCell = (stats.dateLikeCell || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        // font-size: 0 sr-only 技法：父元素 font-size:0 把文字「壓扁」，只給 screen
        // reader 讀。GitHub 檔案列表的 THEAD 欄位標題用此技法 + height: 8px 撐出
        // 一條極薄的視覺分隔線。FILTER_SKIP 不收為 unit、但允許 walker 進子節點
        //(防誤殺「父 font-size:0 消 inline-block whitespace gap、子各自設字級」的
        // 合法用法)。
        {
          const _cs = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
          if (_cs && _cs.fontSize === '0px') {
            if (stats) stats.fontSizeZero = (stats.fontSizeZero || 0) + 1;
            return NodeFilter.FILTER_SKIP;
          }
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
            } else if (
              // Case D:inline-style 容器（SPAN）直接含 text + 至少一個非 BR element 子。
              // 典型案例：YouTube yt-attributed-string 的 ytAttributedStringHost span，直接子混合
              //   "7:00" <span><a>...</a></span> "now we can see..." <span><img></span>
              // Case A 因 !containsBlockDescendant 失敗；Case B 因 !hasBrChild 失敗；
              // Case C 因 SPAN 不在 CONTAINER_TAGS 失敗 → 過去整段都被 SKIP。
              // 結構特徵（描述 DOM 不綁站點/class):tag 是 SPAN、有直接 text node、有直接非 BR
              // element 子、文字長度 >= 20、無 block 子孫、isCandidateText 通過。
              // hasAncestorExtracted 防 SPAN > SPAN 巢狀重複抽（BLOCK 補抓的 Case A/B/C 用
              // CONTAINER_TAGS 限定 DIV/SECTION 等不嵌套 tag 沒踩到 dedup;Case D 必須補上)。
              el.tagName === 'SPAN' &&
              !seen.has(el) &&
              !hasAncestorExtracted(el, fragmentExtracted) &&
              hasDirectText &&
              hasDirectNonBrElement(el) &&
              directTextLength(el) >= 20 &&
              isCandidateText(el)
            ) {
              fragmentExtracted.add(el);
              const frags = extractInlineFragments(el);
              for (const f of frags) {
                results.push(f);
                seen.add(f.startNode);
                if (stats) stats.inlineMixedSpan = (stats.inlineMixedSpan || 0) + 1;
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
        // v1.4.17: Block element 有 CONTAINER_TAGS 直屬子容器，且容器內有直屬 <A> 連結時，
        // 改為只捕捉 <A> 連結本身（而非整個 block）。
        // 原因：若把整個 block（如 TD）當一個翻譯單元，injectIntoTarget 走 clean-slate 路徑
        // 會清空 TD 的全部子元素，包含不需翻譯的相鄰容器（如 TD > DIV.smallfont > SPAN.author）。
        // 典型案例：vBulletin forumdisplay：
        //   td > div → a[thread_title] + div.smallfont → span(author)
        // Gemini 翻完 thread title 後 slot 1（作者名）被丟掉 → clean-slate 把整個 TD 清空
        // → 作者 ID 消失。改為只翻 A 連結，TD 結構完全保留。
        //
        // v1.8.33: 順序提到 mediaCardSkip 之前。原本兩條規則同時滿足時 mediaCardSkip
        // 先命中（line 順序),v1.4.17 永遠跑不到。真實案例：vBulletin 訂閱中 thread:
        //   td > div > [span(prefix), a#thread_gotonew(textLen=0，含 img 圖示),
        //                a#thread_title(font-weight:bold)]
        //   + div.smallfont > span(author)
        // TD 同時：含 img(thread_gotonew 的 16px 跳到第一筆未讀圖示) + 直屬子有 DIV
        // → mediaCardSkip 條件成立 → 整個 TD SKIP,A#thread_title 沒被任何葉節點補抓
        // 邏輯接走（A 是 inline 直接含 text,Case A-D 都不抓)。提前後 v1.4.17 先抓 A
        // → SKIP + skipBlockWithContainer/blockContainerLink 計數；沒 A 可抓時 fallthrough
        // 到原 mediaCardSkip 路徑，既有附件 LI 行為不變。
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
    // v1.9.13: scopeRoot.querySelectorAll(主 root 是 document.body,shadow 路徑是 ShadowRoot)
    scopeRoot.querySelectorAll(SK.INCLUDE_BY_SELECTOR).forEach(el => {
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
    scopeRoot.querySelectorAll('a').forEach(a => {
      if (seen.has(a)) return;
      if (a.hasAttribute('data-shinkansen-translated')) return;
      if (hasBlockAncestor(a)) return;
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
    // querySelectorAll('div, span') 可能回傳幾萬個 element，新版只回傳數百個葉節點，
    // 後續 isVisible / textContent / isCandidateText 等檢查減少 95% 以上呼叫次數。
    // :has() 支援：Chrome 105+ / Firefox 121+ / Safari 15.4+，皆已是 stable 多年。
    scopeRoot.querySelectorAll('div:not(:has(*)), span:not(:has(*))').forEach(d => {
      if (seen.has(d)) return;
      if (d.hasAttribute('data-shinkansen-translated')) return;
      // d.children.length > 0 過濾已由 :not(:has(*)) selector 取代，移除
      if (hasBlockAncestor(d)) return;
      if (isInsideExcludedContainer(d, excludedMemo)) return;
      if (isInteractiveWidgetContainer(d)) return;
      if (!SK.isVisible(d)) return;
      if (!isCandidateText(d)) return;
      // v1.6.9: textContent 取代 innerText
      const txt = (d.textContent || '').trim();
      if (txt.length < 2) return;
      // v1.8.61: 短文字 leaf DIV/SPAN(2-19 字)必須是 visual prominent block
      // heading(display 為 block 系列 + font-size >= 24px)才放行。對應上報網站
      // 「編輯部推薦」(5 字 / 48px / block / sel-tit2 class)這類 DIV section
      // title — 非 H1-H6 但視覺是大字標題,沒這條補抓會永久不翻。24px 是 heading
      // 慣例下限(body 14-18px / prominent heading >= 24px),跟 timestamp / author
      // / inline counter 等 14-20px 噪音明確分開;display 限 block 系列(排除
      // inline span 短字如 author / time / counter)。結構性通則(visual
      // prominence),不靠 class 黑白名單(對應硬規則 §6 / §8)。
      if (txt.length < 20) {
        const cs = getComputedStyle(d);
        const fs = parseFloat(cs.fontSize) || 0;
        const disp = cs.display;
        const isBlockDisplay = disp === 'block' || disp === 'flex' ||
                               disp === 'grid' || disp === 'list-item';
        if (!(isBlockDisplay && fs >= 24)) return;
      }
      if (stats) stats.leafContentDiv = (stats.leafContentDiv || 0) + 1;
      results.push({ kind: 'element', el: d });
      seen.add(d);
    });

    // v1.0.22: grid cell leaf text 補抓
    scopeRoot.querySelectorAll('table[role="grid"] td').forEach(td => {
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
    }  // end processScope

    // 主 scope:document.body(或 caller 指定的 root)
    processScope(root);

    // v1.9.13: open Shadow DOM descent。對 root subtree 內所有 open shadow root 各跑
    // 一次 processScope。host 端 ancestor exclude(footer / role=contentinfo 等)在
    // shadow boundary 自然斷掉(parentElement 走到 shadowRoot 時為 null)— 這對 web
    // component 的隔離語意是預期行為,shadow content 自身結構若含 EXCLUDE_ROLES 仍會被擋。
    if (typeof SK.findOpenShadowRoots === 'function') {
      const shadowRoots = SK.findOpenShadowRoots(root);
      for (const sr of shadowRoots) {
        if (stats) stats.shadowRootsScanned = (stats.shadowRootsScanned || 0) + 1;
        processScope(sr);
      }
    }

    return results;
  };

  // v1.9.13: 找出 root subtree 內所有 open shadow root,遞迴進去再找(shadow 內可能還有
  // shadow)。closed shadow root 受 web spec 安全限制,從 JS 完全不可達,只能跳過。
  SK.findOpenShadowRoots = function findOpenShadowRoots(root) {
    if (!root) return [];
    const found = [];
    function walk(node) {
      if (!node || node.nodeType !== 1) return;  // 只 traverse Element
      if (node.shadowRoot && node.shadowRoot.mode === 'open') {
        found.push(node.shadowRoot);
        let inner = node.shadowRoot.firstElementChild;
        while (inner) { walk(inner); inner = inner.nextElementSibling; }
      }
      let c = node.firstElementChild;
      while (c) { walk(c); c = c.nextElementSibling; }
    }
    if (root.nodeType === 1) {
      walk(root);
    } else if (root.firstElementChild) {
      // ShadowRoot / DocumentFragment 等:直接從 firstElementChild 開始
      let c = root.firstElementChild;
      while (c) { walk(c); c = c.nextElementSibling; }
    }
    return found;
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

  // ─── v1.7.1+: 翻譯優先級排序（v1.7.2 加入 tier 0 細分) ──────────
  // 把「使用者最想看的內容」推到 array 前面，讓 batch 0 翻譯完成時視覺上是
  // 「文章開頭變中文」而不是「導覽列變中文」。本函式只重排 array 順序，
  // 不過濾任何單元——所有 unit 都還是會翻，只是時序不同。
  //
  // tier 0：祖先含 <main>/<article> + readability score >= 1(v1.8.40 起，原本 >=5)
  //         → 文章核心 + 中等內文段（article 內幾乎所有非極短雜訊段)
  // tier 1：祖先含 <main>/<article> + score < 1 → 極短雜訊（byline / metadata 一兩字)
  //         舊版邊界 5 把中等 P 段（score 1-5）推到這層，造成 H tag +5 boost 讓 H 段
  //         先翻、內文段後翻的「斷層」體感（詳見 prioritizeUnits 內 inline 註解)
  // tier 2：祖先無 main/article + 文字長度 ≥ 80 + 連結密度 < 0.5 → 一般內文段落
  // tier 3：其他 → 短連結 / nav / 補抓出來的零碎元素
  //
  // V8 的 Array.prototype.sort 自 2018 起為 stable sort(Chrome 70+),
  // 同 tier 內維持原 DOM 順序——TreeWalker 走過的次序保留，只是把高 tier 推前。
  // 注入用 element reference，不依賴 array index → 排序不影響注入位置。
  //
  // readability score 借用 Mozilla Readability 的評分啟發式，只取結構訊號（文字長度、
  // 逗號數、heading tag、含 P 子孫)，刻意不用 class/id 名稱啟發式——避免命中
  // 「ca-nstab-main」這類含 main 字眼但實際是 chrome 的元素（符合硬規則 §8 結構通則)。
  function readabilityScore(el) {
    if (!el) return 0;
    let score = 0;
    const text = el.textContent || '';
    score += text.length / 100;                                    // 文字長度
    score += (text.match(/[,,]/g) || []).length;                   // 逗號數（內文訊號，nav/tab 通常無逗號)
    if (/^H[1-3]$/.test(el.tagName)) score += 5;                   // 標題 tag 加分
    if (el.querySelector && el.querySelector('p')) score += 3;     // 含 <p> 子孫加分
    return score;
  }

  SK.prioritizeUnits = function prioritizeUnits(units) {
    const tierCache = new Map();

    function computeTier(unit) {
      // fragment 用 unit.el(parent block，符合 extractInlineFragments push 結構);
      // element 用 unit.el。兩者統一。
      const el = unit.el;
      if (!el || !el.parentElement) return 3;

      // 祖先檢查：HTML5 語意 tag 或 ARIA role
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
        // tier 0/1 細分：用 readability score 切「真內文」vs「main 內的雜訊」
        // v1.7.2 起原邊界 score >= 5。但 v1.7.2 的 H tag +5 boost 讓所有 H1/H2/H3
        // 自動 tier 0，而中等長度內文 P 段（textLen 100-300、commas 0-2)score 常常落在
        // 1-5 之間 → 被推到 tier 1。實測 Medium 文章「In 1988, I was obsessed...」
        // (score 3.15）被排到 prioIdx 28(原本 DOM idx 5),H3 副標卻在 prioIdx 2,
        // 使用者體感「heading 先出現，內文後補」斷層大。
        // v1.8.40 起降邊界到 score >= 1:article 內幾乎所有非極短雜訊段都 tier 0,
        // stable sort 保持 DOM 順序；只把「Member-only story」之類短 byline(score < 1)
        // 過濾到 tier 1。
        return readabilityScore(el) >= 1 ? 0 : 1;
      }

      // 祖先沒 main/article：用文字長度 + 連結密度判斷
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

})(window.__SK);
