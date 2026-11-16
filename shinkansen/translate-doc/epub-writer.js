// epub-writer.js — 譯文 EPUB 重建（v2.0.11 起）
//
// 職責：
//   1. 把已翻譯 block 的譯文（translationRaw，含 ⟦N⟧）反序列化回 XHTML DOM
//      （重用 content-serialize.js 的 SK.deserializeWithPlaceholders，
//      frag 是頁面 HTML document 的節點，importNode 進章節 XHTML document）
//   2. 更新語言 metadata（OPF dc:language + 修改過章節的 html@lang/@xml:lang，
//      Apple Books / Kobo 依此選字型與斷行規則）
//   3. fflate 重打包：mimetype 必須是第一個 entry 且不壓縮（EPUB/OCF 規範），
//      其餘未修改 entry 原樣 bit-for-bit 帶過（CSS / 圖片 / 字型不動，
//      譯本在閱讀器的樣式與原書一致）
//
// 未翻章節 / 失敗 block：保留原文原樣（部分譯本下載天然支援）。

import { resolveBlockFragment } from './block-output.js';

const XML_SER = new XMLSerializer();
const XML_DECL = '<?xml version="1.0" encoding="utf-8"?>\n';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

function getSK() {
  const SK = window.__SK;
  if (!SK || typeof SK.deserializeWithPlaceholders !== 'function') {
    throw new Error('serializer not loaded');
  }
  return SK;
}

// 譯文寫回單一 block。優先序：
//   1. block.editedHtml（使用者在預覽頁手動編輯過，最終版）
//   2. override?.translationRaw ?? block.translationRaw 反序列化（機器譯文，含 ⟦N⟧）
//   3. 純文字 fallback（override?.translation ?? block.translation，已去除標記）
// override 來自 computeAnnotationDedupe（「對照只出現一次」後處理版本），
// raw 與 plain 兩路都要吃 override——反序列化失敗走 fallback 時不可漏掉後處理。
// bilingual = true 時原文保留、譯文以 sibling / 內嵌 div 插入（見 insertDualTranslation）
// export 供 doc-file-engine.js 的 HTML 檔譯文寫回重用（單一資料源；
// importNode / replaceChildren 對 DOMParser('text/html') 的 document 同樣成立）
export function applyBlockTranslation(SK, xhtmlDoc, block, override, bilingual = false) {
  const el = block.el;
  if (!el) {
    // 容器直接文字的 fragment block（epub-engine collectChapterBlocks，§3.8-9）
    if (block.fragStart) return applyFragmentTranslation(SK, xhtmlDoc, block, override, bilingual);
    return false;
  }
  // 同一份 xhtmlDoc 會被重複下載重複套用（單語 replaceChildren 會毀掉 DOM 內
  // 原文；雙語需要原文還在）：首次套用前快照原文子節點，之後每次先還原再套，
  // 讓「下載單語 → 切雙語重下載」與重複下載都 idempotent
  if (!block._srcChildNodes) {
    block._srcChildNodes = [...el.childNodes].map((n) => n.cloneNode(true));
  } else {
    el.replaceChildren(...block._srcChildNodes.map((n) => n.cloneNode(true)));
  }
  const content = resolveBlockContent(SK, xhtmlDoc, block, override);
  if (!content) return false;
  if (bilingual) return insertDualTranslation(xhtmlDoc, el, content);
  el.replaceChildren(content);
  return true;
}

// 把曾經套用過譯文的 block 還原成原文（沒套用過 = 沒有快照 = 不動）。同一份文件 DOM 會被重複
// 下載重複套用；某個 block 上次下載時是 done、這次不是（重翻失敗 / 取消勾選該章 / 匯入較舊的
// 工作階段）時，寫回迴圈只處理 done 的 block，上次寫進 DOM 的譯文就原封不動留在輸出檔裡
export function restoreBlockSource(block) {
  if (block.el && block._srcChildNodes) {
    block.el.replaceChildren(...block._srcChildNodes.map((n) => n.cloneNode(true)));
    return true;
  }
  if (block._srcFragNodes && block._fragParent) {
    const parent = block._fragParent;
    for (const n of (block._placedNodes || [])) {
      if (n.parentNode) n.parentNode.removeChild(n);
    }
    const next = (block._fragNext && block._fragNext.parentNode === parent) ? block._fragNext : null;
    const srcClones = block._srcFragNodes.map((n) => n.cloneNode(true));
    for (const n of srcClones) parent.insertBefore(n, next);
    block._placedNodes = srcClones;
    return true;
  }
  return false;
}

// 譯文內容節點（editedHtml → ⟦N⟧ 反序列化 → 純文字 fallback）：優先鏈走 block-output.js
// resolveBlockFragment（與 docx / txt / 預覽四個消費端同一份），這裡只負責 importNode 進 xhtmlDoc。
// element / fragment 兩條寫回路徑共用
function resolveBlockContent(SK, xhtmlDoc, block, override) {
  const picked = resolveBlockFragment(SK, block, override);
  return picked ? xhtmlDoc.importNode(picked.frag, true) : null;
}

// fragment block 寫回（§3.8-9）：以 fragStart..fragEnd 這段連續 sibling（容器的
// 裸文字 + inline 元素 run）為單位。首次套用快照 run 的原節點與插入位置（父節點 +
// run 後方的第一個節點；run 是極大連續段，後方必為區塊元素或 null，不會被其他
// block 的寫回動到），之後每次先移除上次放進去的節點、還原原文，再套——與
// element 路徑同樣 idempotent。雙語：原文 run 留著，後面接一個 span.sk-dual-tr
//（display:block）放譯文
function applyFragmentTranslation(SK, xhtmlDoc, block, override, bilingual) {
  if (!block._srcFragNodes) {
    const nodes = [];
    let cur = block.fragStart;
    while (cur) {
      nodes.push(cur);
      if (cur === block.fragEnd) break;
      cur = cur.nextSibling;
    }
    const parent = block.fragStart.parentNode;
    if (!parent) return false;
    block._fragParent = parent;
    block._fragNext = block.fragEnd.nextSibling;
    block._srcFragNodes = nodes.map((n) => n.cloneNode(true));
    block._placedNodes = nodes;
  }
  const parent = block._fragParent;
  for (const n of block._placedNodes) {
    if (n.parentNode) n.parentNode.removeChild(n);
  }
  const next = (block._fragNext && block._fragNext.parentNode === parent) ? block._fragNext : null;
  const insert = (node) => parent.insertBefore(node, next);
  const srcClones = block._srcFragNodes.map((n) => n.cloneNode(true));

  const content = resolveBlockContent(SK, xhtmlDoc, block, override);
  if (!content) {
    for (const n of srcClones) insert(n);
    block._placedNodes = srcClones;
    return false;
  }
  if (bilingual) {
    for (const n of srcClones) insert(n);
    const holder = xhtmlDoc.createElementNS(XHTML_NS, 'span');
    holder.setAttribute('class', 'sk-dual-tr');
    holder.appendChild(content);
    for (const n of [...holder.querySelectorAll('[id]')]) n.removeAttribute('id');
    insert(holder);
    block._placedNodes = [...srcClones, holder];
    return true;
  }
  const placed = content.nodeType === 11 ? [...content.childNodes] : [content];
  insert(content);
  block._placedNodes = placed;
  return true;
}

// ─── 雙語對照輸出（原譯段落交錯）───────────────────────────
// 網頁 dual mode 的 EPUB 版（SPEC §4.1 哲學延伸；§15 管的是網頁注入路徑）。
// EPUB 是嚴格 XHTML：不用 <shinkansen-translation> 自訂標籤（epubcheck 不過、
// 閱讀器渲染不可預期），改標準標籤 + class + 注入 <style>。
// 位置策略比照網頁 dual mode 的結構表：
//   - 一般 block（p / div / blockquote / heading）→ 同 tag sibling 插在原文後
//   - li / td / th / dd / dt / caption / figcaption → 內嵌 <span>（sibling 會弄壞
//     列表編號 / 表格結構 / dl 配對 / figure 單一 figcaption 限制）。用 span 不用
//     div：XHTML 1.1 DTD 的 dt / caption 只允許 inline 內容，內嵌 div 對 EPUB2
//     來源是無效 XHTML（epubcheck 不過）；span + CSS display:block 兩代皆合法、
//     渲染等價
// 譯文副本一律剝掉 id（原文保留錨點；重複 id = 無效 XHTML，會破註腳 / 頁碼跳轉）
const DUAL_INNER_TAGS = new Set(['li', 'td', 'th', 'dd', 'dt', 'caption', 'figcaption']);
const DUAL_STYLE_ID = 'sk-dual-style';
// 原文用「縮小 + 降透明度」雙通道區分（不用固定色值——閱讀器深色主題下固定色
// 會不可讀，opacity 兩種主題皆安全）；譯文維持原樣式為主要閱讀內容
const DUAL_CSS = '\n.sk-dual-src { font-size: 0.9em; opacity: 0.72; }\nspan.sk-dual-tr { display: block; margin-top: 0.2em; }\n';

export function insertDualTranslation(xhtmlDoc, el, content) {
  const tag = (el.localName || '').toLowerCase();
  const inner = DUAL_INNER_TAGS.has(tag);
  const holder = xhtmlDoc.createElementNS(XHTML_NS, inner ? 'span' : (tag || 'div'));
  const cls = el.getAttribute('class');
  // sibling 型的譯文段沿用原段落的 class 與行內樣式：書的 CSS 多半以 class 定縮排 / 字級 / 對齊
  //（p.indent、p.center、div.epigraph），不帶的話譯文段掉回預設樣式，跟上面的原文段長得不一樣。
  // 內嵌 span 型不需要（它在原元素裡面，本來就繼承）
  const srcClasses = inner ? [] : (cls || '').split(/\s+/).filter((c) => c && c !== 'sk-dual-src' && c !== 'sk-dual-tr');
  holder.setAttribute('class', [...srcClasses, 'sk-dual-tr'].join(' '));
  if (!inner && el.getAttribute('style')) holder.setAttribute('style', el.getAttribute('style'));
  holder.appendChild(content);
  for (const n of [...holder.querySelectorAll('[id]')]) n.removeAttribute('id');
  if (!(cls || '').split(/\s+/).includes('sk-dual-src')) {
    el.setAttribute('class', cls ? `${cls} sk-dual-src` : 'sk-dual-src');
  }
  if (inner) {
    el.appendChild(holder);
  } else if (el.parentNode) {
    el.parentNode.insertBefore(holder, el.nextSibling);
  } else {
    return false;
  }
  return true;
}

// 清掉前一次雙語套用的殘留（重複下載 / 單雙語切換都先清再套）
function removeDualArtifacts(xhtmlDoc) {
  for (const n of [...xhtmlDoc.querySelectorAll('.sk-dual-tr')]) n.remove();
  for (const n of [...xhtmlDoc.querySelectorAll('.sk-dual-src')]) {
    const rest = (n.getAttribute('class') || '')
      .split(/\s+/).filter((c) => c && c !== 'sk-dual-src').join(' ');
    if (rest) n.setAttribute('class', rest);
    else n.removeAttribute('class');
  }
}

function applyDualStyle(xhtmlDoc, enabled) {
  const existing = xhtmlDoc.getElementById ? xhtmlDoc.getElementById(DUAL_STYLE_ID) : null;
  if (existing) existing.remove();
  if (!enabled) return;
  const head = xhtmlDoc.getElementsByTagNameNS('*', 'head')[0];
  if (!head) return;
  const style = xhtmlDoc.createElementNS(XHTML_NS, 'style');
  style.setAttribute('id', DUAL_STYLE_ID);
  style.setAttribute('type', 'text/css');
  style.textContent = DUAL_CSS;
  head.appendChild(style);
}

// ─── 「譯文（原文）」對照只出現一次（v2.0.11）───────────────
// glossary entry 帶 dedupeAnnotation 時：整本書（按 spine 閱讀順序）第一次出現
// 「譯文（原文）」保留完整對照，後續出現替換成譯文或原文（dedupeKeep）。
// 確定性後處理：不改已存的 block 資料，回傳 blockId → 替換後版本的 map
//（未編輯段落 { translation, translationRaw }；編輯過段落 { editedHtml }），
// 下載（buildTranslatedEpub）與預覽（openEpubPreview）共用同一份計算。
// 編輯過（editedHtml）的 block 也套用（2026-07-10 起）——掃描替換以 editedHtml
// 身分存回，整段跳過會讓被替換過的段落永遠清不掉對照；以 text node 級處理。
const ANNOTATED_RE = /^(.+)（(.+)）\s*$/;

// 替換片段左右的 CJK↔拉丁邊界補空格（台灣排版慣例）。「後續用原文」時替換進去的
// 是拉丁字串（如 Alpha），直接貼著中文會擠成一團（2026-07-10 Jimmy 回報 bug）
const CJK_EDGE_RE = /[㐀-鿿豈-﫿]/;
const LATIN_EDGE_RE = /[A-Za-z0-9]/;

// 批次 8 H6:回傳 { text, nextFrom }(與 epub-scan.js spliceCjkAware 同做法——
// 兩檔是同一份事實雙實作)。原本 caller 用 `idx + keep.length + 2` 猜前進步長,
// 「X（Y）X（Y）」背靠背對照時下一個出現的開頭被跳過而漏替換
function spliceWithCjkSpacing(text, start, end, keep) {
  const before = text.slice(0, start);
  const after = text.slice(end);
  let mid = keep;
  if (before && CJK_EDGE_RE.test(before[before.length - 1]) && LATIN_EDGE_RE.test(mid[0] || '')) {
    mid = ' ' + mid;
  }
  if (after && LATIN_EDGE_RE.test(mid[mid.length - 1] || '') && CJK_EDGE_RE.test(after[0])) {
    mid = mid + ' ';
  }
  return { text: before + mid + after, nextFrom: before.length + mid.length };
}

// text 內 full 的所有出現替換成 keep（含邊界補空格）；skipFirst 時第一個出現保留
function replaceOccurrences(text, full, keep, skipFirst) {
  if (!text || !text.includes(full)) return { text, changed: false, sawAny: false };
  let out = text;
  let from = 0;
  let first = true;
  let changed = false;
  while (true) {
    const idx = out.indexOf(full, from);
    if (idx === -1) break;
    if (skipFirst && first) {
      first = false;
      from = idx + full.length;
      continue;
    }
    const spliced = spliceWithCjkSpacing(out, idx, idx + full.length, keep);
    out = spliced.text;
    changed = true;
    from = spliced.nextFrom; // 批次 8 H6:實際前進位置,背靠背對照不漏替換
  }
  return { text: out, changed, sawAny: true };
}

export function computeAnnotationDedupe(epubDoc, glossary) {
  const out = new Map(); // blockId → { translation, translationRaw }
  const rules = [];
  for (const e of glossary || []) {
    if (!e || e.dedupeAnnotation !== true || typeof e.target !== 'string') continue;
    const m = e.target.match(ANNOTATED_RE);
    if (!m) continue;
    // v2.0.54:欄位可能是「譯文（原文）」或「原文（譯文）」(UI 依「後續用X」自動翻轉,
    // 欄位 = 首次出現的長相)。哪個 token 是原文以 e.source 比對決定;都比不中時退回
    // 舊慣例(lead=譯文、括號=原文)——涵蓋舊 session 存檔與手改過的欄位。
    // 預設「後續用原文」（2026-07-10 Jimmy 指定；明確選 target 才用譯文）。
    // 作品名 entry 的 lead token 帶書名號（「《Four Weddings》（妳是我今生的新娘）」,
    // 2026-07-12 UI 翻轉起《》跟著 lead 走）:比對 source 先剝《》再比,keep token
    // 用原樣——後續出現保住書名號（《Four Weddings》不是裸 Four Weddings）
    const stripTitle = (s) => {
      const t = s.trim();
      const tw = t.match(/^《(.+)》$/);
      return tw ? tw[1].trim() : t;
    };
    const src = typeof e.source === 'string' ? stripTitle(e.source) : '';
    let sourceTok = m[2];
    let targetTok = m[1];
    if (src && stripTitle(m[1]) === src) { sourceTok = m[1]; targetTok = m[2]; }
    else if (src && stripTitle(m[2]) === src) { sourceTok = m[2]; targetTok = m[1]; }
    rules.push({ full: e.target, keep: e.dedupeKeep === 'target' ? targetTok : sourceTok, seen: false });
  }
  if (rules.length === 0) return out;

  for (const ch of epubDoc.chapters) {
    for (const b of ch.blocks) {
      if (b.translationStatus !== 'done') continue;
      if (typeof b.editedHtml === 'string' && b.editedHtml.length > 0) {
        // 編輯過的段落不再整段跳過（2026-07-10 Jimmy 回報：掃描替換以 editedHtml
        // 身分存回，被碰過的段落全數退出 dedupe，對照原文清不掉）——editedHtml
        // 以 text node 級套用同一份規則，「首次出現保留」計數跨兩種段落統一。
        // 已知限制：對照字串被行內標記從中切開時搆不到（罕見邊角）
        const div = document.createElement('div');
        div.innerHTML = b.editedHtml;
        let editedChanged = false;
        const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (!node.nodeValue) continue;
          for (const rule of rules) {
            const rt = replaceOccurrences(node.nodeValue, rule.full, rule.keep, !rule.seen);
            if (rt.sawAny) rule.seen = true;
            if (rt.changed) {
              node.nodeValue = rt.text;
              editedChanged = true;
            }
          }
        }
        if (editedChanged) out.set(b.blockId, { editedHtml: div.innerHTML });
        continue;
      }
      let t = b.translation || '';
      let raw = b.translationRaw || '';
      let changed = false;
      for (const rule of rules) {
        // seen 以 plain translation 為準（raw 同步替換；佔位符不會落在對照字串
        // 中間——對照整段是同一文字節點的內容）。首次出現保留完整對照
        const seenBefore = rule.seen;
        const rt = replaceOccurrences(t, rule.full, rule.keep, !seenBefore);
        t = rt.text;
        if (rt.sawAny) rule.seen = true;
        if (rt.changed) changed = true;
        if (raw) {
          const rr = replaceOccurrences(raw, rule.full, rule.keep, !seenBefore);
          if (rr.changed) { raw = rr.text; changed = true; }
        }
      }
      if (changed) out.set(b.blockId, { translation: t, translationRaw: raw });
    }
  }
  return out;
}

// 段落間距注入（2026-07-10 Jimmy 需求）：小說常見「margin:0 + 只靠 text-indent」
// 的傳統排版，讀者反映段落擠成一團。
//
// 「最少 0.5em」的實作靠 CSS margin collapse：相鄰段落間距 = max(前段
// margin-bottom, 後段 margin-top)。只注入 margin-top、不動 margin-bottom——
// 原書 margin:0 → 間距變 0.5em；原書 bottom / 對稱 margin ≥0.5em → max 取原值，
// 排版不變 = 真正的下限語意。!important 是因為很多書明確寫 margin:0，弱規則
// 蓋不過。已知邊角：罕見的「只用 margin-top 撐段距」的書會被壓到 0.5em。
// idempotent：每次 build 先移除舊注入再按當前設定加回
const SPACING_STYLE_ID = 'sk-paragraph-spacing';
const SPACING_CSS = '\np { margin-top: 0.5em !important; }\n';

function applyParagraphSpacing(xhtmlDoc, enabled) {
  const existing = xhtmlDoc.getElementById
    ? xhtmlDoc.getElementById(SPACING_STYLE_ID)
    : null;
  if (existing) existing.remove();
  if (!enabled) return;
  const head = xhtmlDoc.getElementsByTagNameNS('*', 'head')[0];
  if (!head) return;
  const style = xhtmlDoc.createElementNS('http://www.w3.org/1999/xhtml', 'style');
  style.setAttribute('id', SPACING_STYLE_ID);
  style.setAttribute('type', 'text/css');
  style.textContent = SPACING_CSS;
  head.appendChild(style);
}

// 修改過的章節：更新 <html lang / xml:lang>（閱讀器字型 / 斷行 / 辭典行為依此）
function updateChapterLang(xhtmlDoc, targetLanguage) {
  const html = xhtmlDoc.documentElement;
  if (!html || !targetLanguage) return;
  html.setAttribute('lang', targetLanguage);
  html.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:lang', targetLanguage);
}

function serializeChapter(ch) {
  let out = XML_SER.serializeToString(ch.xhtmlDoc);
  if (ch.hadXmlDeclaration && !/^\s*<\?xml/i.test(out)) out = XML_DECL + out;
  return out;
}

// OPF 更新（每次從 opf.text 重新 parse，不依賴外部狀態）：
//   - dc:language → target
//   - upgradeTo3：package@version → 3.0 + 補 dcterms:modified（EPUB3 必填）+
//     manifest 加 nav 文件 item（properties="nav"，EPUB3 必備；NCX 保留向下相容）
function buildUpdatedOpf(opfText, targetLanguage, { upgradeTo3 = false, navFilename = null } = {}) {
  const doc = new DOMParser().parseFromString(opfText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const OPF_NS = 'http://www.idpf.org/2007/opf';

  if (targetLanguage) {
    const langEls = doc.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'language');
    if (langEls.length > 0) {
      langEls[0].textContent = targetLanguage;
      for (let i = langEls.length - 1; i >= 1; i--) langEls[i].remove();
    } else {
      const metadata = doc.getElementsByTagNameNS('*', 'metadata')[0];
      if (metadata) {
        const el = doc.createElementNS('http://purl.org/dc/elements/1.1/', 'dc:language');
        el.textContent = targetLanguage;
        metadata.appendChild(el);
      }
    }
  }

  if (upgradeTo3) {
    doc.documentElement.setAttribute('version', '3.0');
    const metadata = doc.getElementsByTagNameNS('*', 'metadata')[0];
    if (metadata) {
      // dcterms:modified（EPUB3 必填）：既有的更新，沒有就補
      let modified = null;
      for (const m of metadata.getElementsByTagNameNS('*', 'meta')) {
        if (m.getAttribute('property') === 'dcterms:modified') { modified = m; break; }
      }
      if (!modified) {
        modified = doc.createElementNS(OPF_NS, 'meta');
        modified.setAttribute('property', 'dcterms:modified');
        metadata.appendChild(modified);
      }
      modified.textContent = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
    if (navFilename) {
      const manifest = doc.getElementsByTagNameNS('*', 'manifest')[0];
      if (manifest) {
        const item = doc.createElementNS(OPF_NS, 'item');
        item.setAttribute('id', 'sk-nav');
        item.setAttribute('href', navFilename);
        item.setAttribute('media-type', 'application/xhtml+xml');
        item.setAttribute('properties', 'nav');
        manifest.appendChild(item);
      }
    }
  }

  let out = XML_SER.serializeToString(doc);
  if (/^\s*<\?xml/i.test(opfText) && !/^\s*<\?xml/i.test(out)) out = XML_DECL + out;
  return out;
}

// EPUB2 → 3 升級用：manifest 是否已有 properties 含 nav 的 item（有就不生成）
function opfHasNavItem(opfText) {
  const doc = new DOMParser().parseFromString(opfText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return false;
  for (const item of doc.getElementsByTagNameNS('*', 'item')) {
    if ((item.getAttribute('properties') || '').split(/\s+/).includes('nav')) return true;
  }
  return false;
}

// 章節 href（zip 內完整路徑）→ 相對 OPF 目錄的 href（nav 文件放 OPF 同層）
function hrefRelativeToOpfDir(fullPath, opfDir) {
  if (!opfDir) return fullPath;
  if (fullPath.startsWith(opfDir + '/')) return fullPath.slice(opfDir.length + 1);
  // 章節不在 OPF 目錄底下（罕見）：用 ../ 回到 zip root 再走全路徑
  const ups = opfDir.split('/').filter(Boolean).map(() => '..').join('/');
  return ups + '/' + fullPath;
}

// zip 內的檔案路徑 → href：逐段做百分比編碼。章節檔名含空白 / # / ? / % / 非 ASCII 字元時，
// 原樣放進 href 會被閱讀器當成片段識別字或查詢字串（「第 1 章 #1.xhtml」只連到「第 1 章 」）
function encodeHrefPath(p) {
  return String(p || '').split('/').map((seg) => (seg === '..' || seg === '.' ? seg : encodeURIComponent(seg))).join('/');
}

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// EPUB2 → 3 升級：從章節清單（TOC 標題已解析）生成 EPUB3 必備的 nav 文件
export function buildNavDoc(epubDoc, targetLanguage) {
  const items = epubDoc.chapters
    .filter((c) => c.title)
    .map((c) => `      <li><a href="${escapeXml(encodeHrefPath(hrefRelativeToOpfDir(c.href, epubDoc.opf.dir)))}">${escapeXml(c.title)}</a></li>`)
    .join('\n');
  const lang = escapeXml(targetLanguage || epubDoc.meta.language || 'en');
  return `${XML_DECL}<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}">
<head><title>${escapeXml(epubDoc.meta.title)}</title></head>
<body>
  <nav epub:type="toc">
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>`;
}

/**
 * 產出譯本 EPUB bytes。
 * @param {EpubDoc} epubDoc — parseEpub 輸出（blocks 已帶翻譯結果）
 * @param {string}  targetLanguage — 例 'zh-TW'
 * @param {object}  [opts]
 * @param {boolean} [opts.upgradeTo3] — EPUB2 來源升級輸出 EPUB3（version 3.0 +
 *   dcterms:modified + 生成 nav 文件；NCX 與章節內文保留不動，向下相容）
 * @param {Array}   [opts.glossary] — 術語表原始 entries（含 dedupeAnnotation flag，
 *   「對照只出現一次」後處理用；不傳 = 不後處理）
 * @param {boolean} [opts.paragraphSpacing] — 段落間距 0.5em 注入（設定 toggle）
 * @param {boolean} [opts.bilingual] — 雙語對照輸出：原文段落保留（加 .sk-dual-src
 *   縮小降透明度），譯文段落交錯插在後面（.sk-dual-tr）。dc:language / 章節 lang
 *   仍標 target（譯文為主要閱讀內容）
 * @returns {{ bytes: Uint8Array, translatedChapters: number, appliedBlocks: number }}
 */
export function buildTranslatedEpub(epubDoc, targetLanguage, opts = {}) {
  const SK = getSK();
  const { strToU8, zipSync } = window.fflate;
  const { upgradeTo3 = false, glossary = null, paragraphSpacing = false, bilingual = false } = opts;

  // 0)「譯文（原文）」對照只出現一次的後處理 map（不改動 block 存檔資料）
  const dedupe = computeAnnotationDedupe(epubDoc, glossary);

  // 1) 譯文寫回各章 DOM，收集修改過的章節序列化結果
  const modified = new Map(); // path → string
  let translatedChapters = 0;
  let appliedBlocks = 0;
  for (const ch of epubDoc.chapters) {
    if (!ch.xhtmlDoc || ch.parseFailed) continue;
    // 先清上一次雙語套用殘留，再逐 block 還原 + 套用（重複下載 idempotent）
    removeDualArtifacts(ch.xhtmlDoc);
    let chApplied = 0;
    for (const b of ch.blocks) {
      if (b.translationStatus !== 'done') { restoreBlockSource(b); continue; }
      if (applyBlockTranslation(SK, ch.xhtmlDoc, b, dedupe.get(b.blockId), bilingual)) chApplied++;
    }
    if (chApplied > 0) {
      updateChapterLang(ch.xhtmlDoc, targetLanguage);
      applyParagraphSpacing(ch.xhtmlDoc, paragraphSpacing);
      applyDualStyle(ch.xhtmlDoc, bilingual);
      modified.set(ch.href, serializeChapter(ch));
      translatedChapters++;
      appliedBlocks += chApplied;
    }
  }

  // 2) EPUB2 → 3 升級：生成 nav 文件（既有 nav item 就不重複生成）
  let navFilename = null;
  let navPath = null;
  if (upgradeTo3 && !opfHasNavItem(epubDoc.opf.text)) {
    navFilename = 'sk-nav.xhtml';
    navPath = epubDoc.opf.dir ? `${epubDoc.opf.dir}/${navFilename}` : navFilename;
    // 防呆：撞名時換名（幾乎不會發生）
    while (epubDoc.zip.entries[navPath]) {
      navFilename = 'sk-' + navFilename;
      navPath = epubDoc.opf.dir ? `${epubDoc.opf.dir}/${navFilename}` : navFilename;
    }
    modified.set(navPath, buildNavDoc(epubDoc, targetLanguage));
  }

  // 3) OPF 更新（語言 + 可選升級）
  const updatedOpf = buildUpdatedOpf(epubDoc.opf.text, targetLanguage, { upgradeTo3, navFilename });
  if (updatedOpf) modified.set(epubDoc.opf.path, updatedOpf);

  // 4) 重打包。mimetype 第一且 STORED（level 0），其餘依原 zip 順序。
  const entries = epubDoc.zip.entries;
  const zipInput = {};
  const mimetypeU8 = entries['mimetype'] || strToU8('application/epub+zip');
  zipInput['mimetype'] = [mimetypeU8, { level: 0 }];
  for (const path of Object.keys(entries)) {
    if (path === 'mimetype') continue;
    if (path.endsWith('/')) continue; // 目錄 entry 不需重建
    const u8 = modified.has(path) ? strToU8(modified.get(path)) : entries[path];
    // 批次 7 §6.4：圖片 / 字型 / 音訊等本身已壓縮的 entry 用 STORED（level 0）——
    // 原本每次下載都對整本書的媒體同步重跑 deflate（大書最花時間的一段）且壓不出空間。
    // entry 內容位元組不變，只有 zip 內的儲存方式不同
    zipInput[path] = isPrecompressedMediaPath(path) ? [u8, { level: 0 }] : u8;
  }
  // 新增的 nav 文件（原 zip 沒有的 entry）
  if (navPath && !zipInput[navPath]) zipInput[navPath] = strToU8(modified.get(navPath));
  const bytes = zipSync(zipInput, { level: 6 });
  return { bytes, translatedChapters, appliedBlocks };
}

/** 已壓縮媒體 / 字型副檔名（epub / docx 重打包共用判準；docx-engine 有同一份鏡像） */
const PRECOMPRESSED_MEDIA_RE = /\.(?:png|jpe?g|gif|webp|avif|bmp|tiff?|ico|ttf|otf|woff2?|eot|mp3|m4a|aac|ogg|oga|wav|mp4|m4v|webm|ogv|zip|jar|gz|br|pdf)$/i;
export function isPrecompressedMediaPath(path) {
  return PRECOMPRESSED_MEDIA_RE.test(String(path || ''));
}

/** 下載檔名：<原檔名>-shinkansen.epub（雙語版 -shinkansen-dual.epub，兩版可並存不互蓋） */
export function translatedEpubFilename(originalName, { bilingual = false } = {}) {
  const base = (originalName || 'book').replace(/\.epub$/i, '');
  return base + (bilingual ? '-shinkansen-dual.epub' : '-shinkansen.epub');
}
