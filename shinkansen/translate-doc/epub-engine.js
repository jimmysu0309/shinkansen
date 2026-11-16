// epub-engine.js — EPUB 解析引擎（v2.0.11 起）
//
// 職責：
//   1. 解壓 EPUB（fflate，window.fflate 由 index.html <script src> 載入）
//   2. container.xml → OPF manifest / spine → 章節順序與 metadata
//   3. 各章 XHTML 以 DOMParser 解析，抽出可翻譯 block（段落 / 標題 / 清單項等）
//   4. 每個 block 以既有 ⟦N⟧ 佔位符協定序列化（重用 content-serialize.js，
//      由 index.html <script src> 載入 content-ns.js + content-serialize.js）
//   5. 產出與 PDF 版面 IR 同形狀的 doc（pages[] = 章節），讓 translate.js
//      translateDocument / glossary editor / 進度 UI 原樣重用
//
// 序列化架構說明（單一資料源，CLAUDE.md 工作流原則 §5）：
//   - ⟦N⟧ 協定字串規則由 lib/system-instruction.js 注入（joined 含 ⟦ 自動觸發），
//     LLM 端規則單一來源。
//   - DOM 序列化 / 反序列化重用 content-serialize.js 本體（不是抄一份）。
//     EPUB 專屬政策差異用「頁面層 override」表達（見 applyEpubSerializerPolicy），
//     只影響 translate-doc 頁自己的 window.__SK instance，不影響網頁翻譯路徑。
//   - XHTML tagName 大小寫陷阱：DOMParser('application/xhtml+xml') 產出的
//     tagName 是小寫（'p' 不是 'P'），content-serialize.js 的大寫比對會全部失效。
//     解法：每個 block 先經 htmlCloneFromXhtml() 轉成頁面 HTML document 的
//     clone（tagName 恢復大寫、屬性以字面保留），序列化在 HTML clone 上做；
//     譯文反序列化出的 frag 再 importNode 回 XHTML document（epub-writer.js）。

import { getPricingForModel } from '../lib/model-pricing.js';
import { serviceTierMultiplier } from '../lib/billing.js';

// 「有可翻文字」判斷的單一資料源（epub / docx / txt / md / subtitle 各引擎共用）。
// 2026-09-11 code review P1-3：原本各引擎各自手寫「拉丁 / Latin-1 / 西里爾 / CJK / 假名 / 諺文」區段三份，
// 整個漏掉希臘 / 希伯來 / 阿拉伯 / 泰 / 天城文等文字系統——阿拉伯文 SRT 全段 verbatim
// 報「空檔案」、希臘文 EPUB 每章 0 字。改 Unicode 屬性 \p{L}（任何文字系統的字母，
// 刻意不含數字：純數字 / 標點段不送翻）。網頁路徑 content-detect 早已用 \p{L}。
export const HAS_LETTER_RE = /\p{L}/u;

// ─── 限制（SPEC-PRIVATE §30.5）─────────────────────────────
// 硬上限走檔案 bytes（EPUB 大多是圖片撐大，跟翻譯成本無關，設寬鬆防呆值）；
// 軟警告走「可翻譯字元數」（成本相關維度），超過時 UI 要使用者確認。
export const EPUB_LIMITS = {
  hardMaxBytes: 100 * 1024 * 1024,   // 100 MB
  softWarnChars: 500_000,            // 50 萬可翻譯字元（動工時實測校準的暫定量級）
  // 解壓後總大小上限。hardMaxBytes 只管壓縮檔本身；高壓縮比的檔（幾 MB 解開成幾 GB）會在同步解壓時
  // 把分頁記憶體吃光。正常書籍 / 文件解開後遠低於此
  maxUnzippedBytes: 1024 * 1024 * 1024, // 1 GB
};

// 帶解壓後大小上限的 unzip（EPUB / Word 共用）。大小取自 zip 目錄記載的原始大小，在真正解壓前就擋下；
// 超過上限丟 Error（呼叫端一律包成各自的 'bad-zip'）
export function unzipWithLimit(bytes, maxBytes = EPUB_LIMITS.maxUnzippedBytes) {
  let total = 0;
  return window.fflate.unzipSync(bytes, {
    filter: (f) => {
      total += f.originalSize || 0;
      if (total > maxBytes) throw new Error('uncompressed size exceeds limit');
      return true;
    },
  });
}

export class EpubParseError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'EpubParseError';
    this.code = code; // 'not-epub' | 'too-large' | 'drm' | 'bad-zip' | 'no-opf' | 'no-chapters' | 'aborted'
  }
}

// ─── preflight ────────────────────────────────────────────
export function preflightEpubFile(file) {
  const isEpubExt = /\.epub$/i.test(file.name || '');
  const isEpubMime = (file.type || '') === 'application/epub+zip';
  if (!isEpubExt && !isEpubMime) {
    return { level: 'error', code: 'not-epub' };
  }
  if (file.size > EPUB_LIMITS.hardMaxBytes) {
    return { level: 'error', code: 'too-large' };
  }
  return { level: 'ok' };
}

// ─── 序列化政策（頁面層 override，只動 translate-doc 頁的 __SK）───
let _policyApplied = false;
function applyEpubSerializerPolicy(SK) {
  if (_policyApplied) return;
  _policyApplied = true;
  const origAtomic = SK.isAtomicPreserve;
  SK.isAtomicPreserve = function epubIsAtomicPreserve(el) {
    const tag = (el.tagName || '').toUpperCase();
    // 段落內 inline SVG / MathML → 原子保留（公式 / 裝飾圖不送翻、不能丟）
    if (tag === 'SVG' || tag === 'MATH') return true;
    // 零文字但帶 id 或 epub:type 的錨點元素（頁碼標記 <span epub:type="pagebreak"
    // id="pg23"/>、cross-ref 錨 <a id="x"/>）→ 原子保留。這些是書內連結 / 頁碼
    // 導航的錨點，序列化器預設會因「無實質文字」整顆丟掉 → 內部連結全斷。
    if (!SK.hasSubstantiveContent(el)
        && (el.id || el.getAttribute('epub:type'))) return true;
    return origAtomic(el);
  };
}

export function getSerializerSK() {
  const SK = window.__SK;
  if (!SK || typeof SK.serializeWithPlaceholders !== 'function') {
    throw new EpubParseError('bad-zip',
      'serializer not loaded（index.html 需先載入 content-ns.js + content-serialize.js）');
  }
  applyEpubSerializerPolicy(SK);
  return SK;
}

// ─── 小工具 ───────────────────────────────────────────────
function parseXml(text, mime) {
  const doc = new DOMParser().parseFromString(text, mime);
  // Chrome 對 XML parse 失敗回帶 <parsererror> 的文件
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  return doc;
}

function decodeEntryText(u8) {
  let text = window.fflate.strFromU8(u8);
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM
  return text;
}

// 相對路徑解析（zip 內 path，無 scheme）：resolvePath('OEBPS/text', '../images/a.png')
// → 'images/a.png'。href 可能帶 URL encode（%20）。
export function resolvePath(baseDir, href) {
  // v2.0.78（批次 5 H2）：decode 失敗 fallback 原字串——href 含裸 `%`（非合法
  // escape，如 `50%off.xhtml`，手工／劣質轉檔 EPUB 會出現）時 decodeURIComponent
  // throw URIError，呼叫點（parseEpub / parseTocTitles）都沒 try → 一個壞 href
  // 毀整本書 parse，且錯誤碼非 EpubParseError、UI 只能顯示 generic 錯誤。
  // zip 內 entry 名若本來就含字面 %，原字串反而是對的查找 key
  const _rawHref = (href || '').split('#')[0];
  let raw;
  try {
    raw = decodeURIComponent(_rawHref);
  } catch (_) {
    raw = _rawHref;
  }
  if (!raw) return '';
  const parts = (baseDir ? baseDir.split('/') : []).filter(Boolean);
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

// ─── DRM 偵測 ─────────────────────────────────────────────
// META-INF/encryption.xml 存在時逐條看 EncryptionMethod@Algorithm：
// 字型混淆（IDPF / Adobe font obfuscation）不算 DRM（字型 entry 我們原樣
// bit-for-bit 帶過，不需解密）；其他演算法一律視為 DRM 拒收。
const FONT_OBFUSCATION_ALGOS = new Set([
  'http://www.idpf.org/2008/embedding',
  'http://ns.adobe.com/pdf/enc#RC',
]);

function checkDrm(entries) {
  const encU8 = entries['META-INF/encryption.xml'];
  if (!encU8) return;
  const doc = parseXml(decodeEntryText(encU8), 'application/xml');
  if (!doc) throw new EpubParseError('drm'); // encryption.xml 爛掉也不敢當沒事
  const methods = doc.getElementsByTagNameNS('*', 'EncryptionMethod');
  for (const m of methods) {
    const algo = m.getAttribute('Algorithm') || '';
    if (!FONT_OBFUSCATION_ALGOS.has(algo)) throw new EpubParseError('drm');
  }
}

// ─── block 抽取 ────────────────────────────────────────────
// 候選 block tag（leaf 原則：候選內不含另一個候選才算翻譯單位，
// 例 blockquote > p 取內層 p）。DIV 只在 leaf 且有實質文字時當段落
// （calibre 轉檔書常用 <div class="para">）。
const BLOCK_CANDIDATE_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'blockquote', 'figcaption', 'caption', 'td', 'th', 'dd', 'dt', 'div'];
const BLOCK_CANDIDATE_SELECTOR = BLOCK_CANDIDATE_TAGS.join(',');
// 整棵子樹不進翻譯單位的 tag（code 區塊 / 腳本 / 向量圖 / 公式）
const SKIP_SUBTREE_TAGS = new Set(['pre', 'script', 'style', 'template', 'svg', 'math', 'nav']);
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

function isInsideSkippedSubtree(el, stopAt) {
  let cur = el.parentElement;
  while (cur && cur !== stopAt) {
    if (SKIP_SUBTREE_TAGS.has(cur.localName)) return true;
    cur = cur.parentElement;
  }
  return false;
}

function hasCandidateDescendant(el) {
  return !!el.querySelector(BLOCK_CANDIDATE_SELECTOR);
}

function normalizeText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// XHTML element → 頁面 HTML document 的 clone（tagName 大寫化，供序列化器使用）。
// 用 importNode 不用「XMLSerializer → innerHTML」reparse：HTML parser 在 div
// context 會把 <td> / <th> / <caption> 這類表格 tag 整顆丟掉（firstElementChild
// 變 null → 表格內文字永遠不進翻譯 block）。XHTML 與 HTML 同 namespace，
// importNode 進 HTML document 後 tagName 即恢復大寫、屬性（含 epub:type）原樣保留
function htmlCloneFromXhtml(el) {
  return document.importNode(el, true);
}

/**
 * 抽出一章的可翻譯 block。
 * export 供 doc-file-engine.js 的 HTML 檔路徑重用(單一資料源:HTML 檔案
 * 與 EPUB 章節共用同一條偵測 / 序列化邏輯;querySelector / localName 對
 * DOMParser('text/html') 產出的 document 同樣成立)。
 * @param {Document} xhtmlDoc
 * @param {number} chapterIndex
 * @returns {Array} blocks
 */
export function collectChapterBlocks(xhtmlDoc, chapterIndex, SK) {
  const body = xhtmlDoc.getElementsByTagNameNS('*', 'body')[0];
  if (!body) return [];
  const blocks = [];
  const candidates = body.querySelectorAll(BLOCK_CANDIDATE_SELECTOR);
  let n = 0;
  const leafSet = new Set();
  for (const el of candidates) {
    if (hasCandidateDescendant(el)) continue;           // leaf 原則
    if (isInsideSkippedSubtree(el, body)) continue;      // pre/svg/nav 等子樹內不收
    leafSet.add(el);
    const htmlClone = htmlCloneFromXhtml(el);
    if (!htmlClone) continue;
    stripRubyAnnotations(htmlClone);
    const plainText = normalizeText(htmlClone.textContent);
    if (!plainText) continue;
    // 純數字 / 純標點（頁碼、分隔符）不送翻
    if (!HAS_LETTER_RE.test(plainText)) continue;

    // imgAsSlot：寫回是整段清掉重建（epub-writer replaceChildren），段內的圖 / 影音 / SVG 必須進
    // atomic slot 才會留在譯本裡（原本不進 slot，譯過的段落一律掉圖）
    const { text: serializedText, slots } = SK.serializeWithPlaceholders(htmlClone, { imgAsSlot: true });
    if (!serializedText || !serializedText.trim()) continue;

    blocks.push({
      blockId: `c${chapterIndex}-b${n++}`,
      type: HEADING_TAGS.has(el.localName) ? 'heading' : 'paragraph',
      el,                                   // XHTML 原 element（epub-writer 寫回用）
      plainText,                            // 純文字（術語表取樣 / 字數統計 / 複製）
      epubSerializedText: serializedText,   // ⟦N⟧ 序列化文字（送 LLM）
      slots,                                // 佔位符 slot（HTML-namespace clone）
      translation: null,
      translationRaw: null,                 // 含 ⟦N⟧ 的原始譯文（epub-writer 反序列化用）
      translationStatus: 'pending',
      translationError: null,
    });
  }

  // 容器直接文字（code review 2026-09-11 §3.8-9）：leaf 原則只收「不含另一個候選」
  // 的候選元素，容器自己的裸文字 / inline run 永遠不進翻譯單位——
  // <li>Chapter one<ol>…</ol></li> 的「Chapter one」、轉檔書 <div>正文<h2>標題</h2>
  // 正文</div> 的兩段正文。比照網頁路徑 extractInlineFragments：每個非 leaf 元素
  //（含 body）把連續的 text / inline 子節點切成 run，run 內有字母即成一個 fragment
  // block（el = null、fragStart / fragEnd 指向 XHTML 原節點，writer 以 run 為單位
  // 寫回）。blockId 走獨立的 f 序號，既有 session 的 b 序號不受影響
  let m = 0;
  const containers = [body, ...body.getElementsByTagName('*')];
  for (const container of containers) {
    if (container !== body) {
      if (SKIP_SUBTREE_TAGS.has(container.localName)) continue;
      if (leafSet.has(container)) continue;
      // 只有區塊型元素才是「容器」：inline 元素（em / a / span…）的文字已由所在
      // leaf block 或所在容器的 run 涵蓋，再當容器會重複收集
      if (!RUN_BREAK_TAGS.has(container.localName) && !hasCandidateDescendant(container)) continue;
      if (isInsideSkippedSubtree(container, body)) continue;
    }
    for (const run of inlineRunsOf(container)) {
      const wrapper = document.createElement('span');
      for (const node of run) wrapper.appendChild(document.importNode(node, true));
      stripRubyAnnotations(wrapper);
      const plainText = normalizeText(wrapper.textContent);
      if (!plainText || !HAS_LETTER_RE.test(plainText)) continue;
      const { text: serializedText, slots } = SK.serializeWithPlaceholders(wrapper, { imgAsSlot: true });
      if (!serializedText || !serializedText.trim()) continue;
      m++;
      blocks.push({
        blockId: null,                        // 排序後依文件順序編 f 序號（下方）
        type: 'paragraph',
        el: null,
        fragStart: run[0],                    // XHTML 原節點 run（epub-writer 寫回用）
        fragEnd: run[run.length - 1],
        plainText,
        epubSerializedText: serializedText,
        slots,
        translation: null,
        translationRaw: null,
        translationStatus: 'pending',
        translationError: null,
      });
    }
  }
  if (m > 0) {
    sortBlocksByDocumentOrder(blocks);
    let f = 0;
    for (const b of blocks) if (b.blockId == null) b.blockId = `c${chapterIndex}-f${f++}`;
  }
  return blocks;
}

// 一個容器的直接子節點切成 inline run：text / inline 元素連續段為一個 run，
// 遇到區塊型子元素（候選 / 清單 / 表格 / 分節等，或本身含候選的元素）與整棵跳過
// 的子樹（pre / svg / nav…）就斷開
const RUN_BREAK_TAGS = new Set([
  ...BLOCK_CANDIDATE_TAGS,
  'ul', 'ol', 'dl', 'table', 'thead', 'tbody', 'tfoot', 'tr',
  'section', 'article', 'aside', 'header', 'footer', 'figure', 'hr', 'main',
  'address', 'details', 'summary', 'form', 'fieldset', 'body',
]);

function inlineRunsOf(container) {
  const runs = [];
  let cur = [];
  const flush = () => { if (cur.length > 0) runs.push(cur); cur = []; };
  for (const node of container.childNodes) {
    if (node.nodeType === 3) { cur.push(node); continue; }
    if (node.nodeType !== 1) continue; // comment / PI：不進 run、不斷 run
    const tag = node.localName;
    if (SKIP_SUBTREE_TAGS.has(tag) || RUN_BREAK_TAGS.has(tag) || hasCandidateDescendant(node)) {
      flush();
      continue;
    }
    cur.push(node);
  }
  flush();
  return runs;
}

function blockAnchorNode(b) {
  return b.el || b.fragStart;
}

function sortBlocksByDocumentOrder(blocks) {
  blocks.sort((a, b) => {
    const na = blockAnchorNode(a);
    const nb = blockAnchorNode(b);
    if (na === nb) return 0;
    const pos = na.compareDocumentPosition(nb);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
}

// 日文 EPUB 的 <ruby> 讀音假名（code review 2026-09-11 §3.8-10）：<rt> / <rp> 是
// 標注，不是正文——透明展開會把「東京とうきょう」串進送翻原文、術語表抽出
// 「柏木かしわぎ」。EPUB 政策層在 HTML clone 上直接剝掉（plainText / 序列化文字
// 同一份來源），<ruby> 本體維持透明、基底文字照常進正文。原 XHTML 不動：
// 雙語輸出原文段的 ruby 完整保留
function stripRubyAnnotations(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  for (const n of root.querySelectorAll('rt, rp')) n.remove();
}

// ─── TOC（nav doc / NCX）─────────────────────────────────
function parseTocTitles(entries, opfDir, manifest, spineTocId) {
  const titleByPath = new Map();
  // 1) EPUB3 nav doc（manifest properties 含 'nav'）
  const navItem = manifest.find((m) => (m.properties || '').split(/\s+/).includes('nav'));
  if (navItem) {
    const navPath = resolvePath(opfDir, navItem.href);
    const u8 = entries[navPath];
    if (u8) {
      const doc = parseXml(decodeEntryText(u8), 'application/xhtml+xml');
      if (doc) {
        // 找 epub:type="toc" 的 nav，找不到就用第一個 nav
        const navs = doc.getElementsByTagNameNS('*', 'nav');
        let tocNav = null;
        for (const nav of navs) {
          const t = nav.getAttributeNS('http://www.idpf.org/2007/ops', 'type')
            || nav.getAttribute('epub:type') || '';
          if (t.split(/\s+/).includes('toc')) { tocNav = nav; break; }
        }
        if (!tocNav && navs.length > 0) tocNav = navs[0];
        if (tocNav) {
          const navDir = dirOf(navPath);
          for (const a of tocNav.getElementsByTagNameNS('*', 'a')) {
            const href = a.getAttribute('href');
            const label = normalizeText(a.textContent);
            if (!href || !label) continue;
            const p = resolvePath(navDir, href);
            if (p && !titleByPath.has(p)) titleByPath.set(p, label);
          }
        }
      }
    }
  }
  // 2) NCX fallback（EPUB2）
  if (titleByPath.size === 0 && spineTocId) {
    const ncxItem = manifest.find((m) => m.id === spineTocId);
    if (ncxItem) {
      const ncxPath = resolvePath(opfDir, ncxItem.href);
      const u8 = entries[ncxPath];
      if (u8) {
        const doc = parseXml(decodeEntryText(u8), 'application/xml');
        if (doc) {
          const ncxDir = dirOf(ncxPath);
          for (const np of doc.getElementsByTagNameNS('*', 'navPoint')) {
            const label = normalizeText(
              np.getElementsByTagNameNS('*', 'text')[0]?.textContent);
            const src = np.getElementsByTagNameNS('*', 'content')[0]?.getAttribute('src');
            if (!label || !src) continue;
            const p = resolvePath(ncxDir, src);
            if (p && !titleByPath.has(p)) titleByPath.set(p, label);
          }
        }
      }
    }
  }
  return titleByPath;
}

// ─── front / back matter 啟發式（章節清單「一鍵排除」候選）────
// 關鍵字兩側要求非字母（code review 2026-09-11 §3.8-12）：原本無詞邊界，
// stock_market.xhtml（toc）/ navy.xhtml（nav）/ discovery.xhtml（cover）正文章
// 都被判成附屬頁預設不勾。數字 / 底線 / 連字號仍算邊界（cover01 / ch_toc 照舊命中）
const MATTER_FILENAME_RE = /(?<![a-z])((?:front|back|book)?cover|titlepage|title-page|copyright|colophon|imprint|toc|nav|contents|tableofcontents|table-of-contents|dedication|halftitle|half-title)(?![a-z])/i;

function suggestSkipChapter(ch) {
  if (ch.linear === 'no') return true;
  if (ch.isNavDoc) return true;
  if (MATTER_FILENAME_RE.test(ch.href.split('/').pop() || '')) return true;
  if (ch.charCount < 200) return true;
  return false;
}

// ─── 主解析 ───────────────────────────────────────────────
/**
 * @param {File} file
 * @param {(p: {stage: string, current?: number, total?: number}) => void} onProgress
 * @param {{ signal?: AbortSignal }} opts
 * @returns {Promise<EpubDoc>}
 */
export async function parseEpub(file, onProgress = () => {}, opts = {}) {
  const SK = getSerializerSK();
  const { signal } = opts;
  const throwIfAborted = () => {
    if (signal?.aborted) throw new EpubParseError('aborted');
  };

  onProgress({ stage: 'unzip' });
  const buf = await file.arrayBuffer();
  throwIfAborted();
  let entries;
  try {
    entries = unzipWithLimit(new Uint8Array(buf));
  } catch (err) {
    throw new EpubParseError('bad-zip', err && err.message);
  }

  checkDrm(entries);

  // container.xml → OPF path
  onProgress({ stage: 'opf' });
  const containerU8 = entries['META-INF/container.xml'];
  if (!containerU8) throw new EpubParseError('no-opf');
  const containerDoc = parseXml(decodeEntryText(containerU8), 'application/xml');
  const rootfile = containerDoc
    && containerDoc.getElementsByTagNameNS('*', 'rootfile')[0];
  const opfPath = rootfile && rootfile.getAttribute('full-path');
  if (!opfPath || !entries[opfPath]) throw new EpubParseError('no-opf');
  const opfText = decodeEntryText(entries[opfPath]);
  const opfDoc = parseXml(opfText, 'application/xml');
  if (!opfDoc) throw new EpubParseError('no-opf');
  const opfDir = dirOf(opfPath);

  // metadata
  const dc = (tag) => normalizeText(
    opfDoc.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', tag)[0]?.textContent);
  const packageEl = opfDoc.documentElement;
  const meta = {
    filename: file.name,
    title: dc('title') || file.name.replace(/\.epub$/i, ''),
    author: dc('creator') || '',
    language: dc('language') || '',
    identifier: dc('identifier') || '',
    // OPF package@version（'2.0' / '3.0'…）。UI 依此決定「輸出 EPUB 3」選項顯隱
    epubVersion: (packageEl && packageEl.getAttribute('version')) || '',
  };

  // manifest / spine
  const manifest = [];
  for (const item of opfDoc.getElementsByTagNameNS('*', 'item')) {
    manifest.push({
      id: item.getAttribute('id'),
      href: item.getAttribute('href'),
      mediaType: item.getAttribute('media-type') || '',
      properties: item.getAttribute('properties') || '',
    });
  }
  const manifestById = new Map(manifest.map((m) => [m.id, m]));
  const spineEl = opfDoc.getElementsByTagNameNS('*', 'spine')[0];
  const spineTocId = spineEl ? spineEl.getAttribute('toc') : null;
  const spine = [];
  if (spineEl) {
    for (const ref of spineEl.getElementsByTagNameNS('*', 'itemref')) {
      spine.push({
        idref: ref.getAttribute('idref'),
        linear: (ref.getAttribute('linear') || 'yes').toLowerCase(),
      });
    }
  }

  const titleByPath = parseTocTitles(entries, opfDir, manifest, spineTocId);

  // 逐章解析
  const chapters = [];
  let chapterIndex = 0;
  const xhtmlSpine = spine.filter((s) => {
    const m = manifestById.get(s.idref);
    return m && /xhtml|html/i.test(m.mediaType);
  });
  for (const s of xhtmlSpine) {
    throwIfAborted();
    const m = manifestById.get(s.idref);
    const path = resolvePath(opfDir, m.href);
    const u8 = entries[path];
    if (!u8) continue;
    onProgress({ stage: 'chapters', current: chapterIndex + 1, total: xhtmlSpine.length });

    const rawText = decodeEntryText(u8);
    const xhtmlDoc = parseXml(rawText, 'application/xhtml+xml');
    const isNavDoc = (m.properties || '').split(/\s+/).includes('nav');
    let blocks = [];
    let parseFailed = false;
    if (xhtmlDoc) {
      blocks = collectChapterBlocks(xhtmlDoc, chapterIndex, SK);
    } else {
      parseFailed = true; // 爛 XHTML：整章保留原文不翻（writer 原樣帶過）
    }
    const charCount = blocks.reduce((acc, b) => acc + b.plainText.length, 0);
    const ch = {
      index: chapterIndex,
      href: path,
      manifestId: m.id,
      linear: s.linear,
      isNavDoc,
      title: titleByPath.get(path) || '',
      xhtmlDoc,
      // rawText 不保留（原始 XHTML 每章常駐記憶體無消費者，2026-09-12 批次 6 移除）
      hadXmlDeclaration: /^\s*<\?xml/i.test(rawText),
      parseFailed,
      blocks,
      charCount,
      cjkRatio: cjkRatioOfBlocks(blocks), // 估價係數（§3.8-7）
      selected: true,       // UI 填 suggestSkip 後調整
      suggestSkip: false,
    };
    ch.suggestSkip = suggestSkipChapter(ch);
    ch.selected = !ch.suggestSkip;
    // TOC 沒給標題 → fallback 章內第一個 heading，再 fallback 檔名
    if (!ch.title && xhtmlDoc) {
      const h = blocks.find((b) => b.type === 'heading');
      ch.title = (h && h.plainText.slice(0, 80)) || path.split('/').pop();
    } else if (!ch.title) {
      ch.title = path.split('/').pop();
    }
    chapters.push(ch);
    chapterIndex++;
    // 讓 UI 有機會刷新進度（每章 yield 一次事件迴圈）
    await new Promise((r) => setTimeout(r, 0));
  }

  if (chapters.length === 0) throw new EpubParseError('no-chapters');

  const totalChars = chapters.reduce((acc, c) => acc + c.charCount, 0);

  return {
    kind: 'epub',
    meta: { ...meta, pageCount: chapters.length, chapterCount: chapters.length },
    stats: { totalChars },
    zip: { entries },
    opf: { path: opfPath, dir: opfDir, text: opfText },
    chapters,
    // translateDocument / collectGlossaryInputParts 相容形狀：pages[] = 章節
    pages: chapters.map((c) => ({ pageIndex: c.index, chapterIndex: c.index, blocks: c.blocks })),
  };
}

// ─── 全書術語表：分輪與合併（§30.3 第 1 層）────────────────
export const BOOK_GLOSSARY_ROUND_CHARS = 60_000; // 每輪抽取輸入上限（對齊 GLOSSARY_INPUT_MAX_CHARS）
export const BOOK_GLOSSARY_MAX_ROUNDS = 40;      // 防呆上限（40 輪 = 240 萬字，一般書籍到不了）
export const BOOK_GLOSSARY_MAX_TERMS = 500;      // 合併後上限

// 把全書 blocks 依序切成 ≤roundChars 的輪次（覆蓋全書；跟 PDF 只抽前 60K 不同，
// 只在第 20 章登場的配角也會被抽到）
export function buildBookGlossaryRounds(doc, roundChars = BOOK_GLOSSARY_ROUND_CHARS, maxRounds = BOOK_GLOSSARY_MAX_ROUNDS) {
  const rounds = [];
  let cur = [];
  let acc = 0;
  const flush = () => {
    if (cur.length > 0) rounds.push(cur.join('\n'));
    cur = [];
    acc = 0;
  };
  for (const ch of doc.chapters) {
    for (const b of ch.blocks) {
      const txt = (b.plainText || '').trim();
      if (!txt) continue;
      const piece = txt.length > roundChars ? txt.slice(0, roundChars) : txt;
      if (acc + piece.length > roundChars && cur.length > 0) {
        flush();
        if (rounds.length >= maxRounds) return rounds;
      }
      cur.push(piece);
      acc += piece.length + 1;
    }
  }
  flush();
  return rounds.slice(0, maxRounds);
}

// 合併多輪抽取結果：同 source（大小寫不敏感）以先出現輪為準——角色初登場章節的
// 譯法優先，後面輪次的不同譯法算衝突（計數回報，不覆蓋）
export function mergeBookGlossaries(lists, cap = BOOK_GLOSSARY_MAX_TERMS) {
  const bySource = new Map();
  let conflicts = 0;
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!e || typeof e.source !== 'string' || typeof e.target !== 'string') continue;
      const source = e.source.trim();
      const target = e.target.trim();
      if (!source || !target) continue;
      const key = source.toLowerCase();
      const prev = bySource.get(key);
      if (!prev) {
        // type（person / place / tech / work，抽取 prompt 的分類）保留——
        // 編輯器分組顯示與「人名不翻譯」批次 toggle 都靠它。
        // target 過人名間隔號正規化（拉夫·舒馬克 → 拉夫・舒馬克）
        const entry = { source, target: normalizeNameSeparators(target) };
        if (typeof e.type === 'string' && e.type) entry.type = e.type;
        // 選項 flag（不翻譯 / 對照一次）保留——抽取輪次不帶 flag（無影響），
        // 「匯入 JSON 合併」路徑的條目會帶（editor / 匯出 JSON 的 entry 形狀）
        if (e.noTranslate === true) entry.noTranslate = true;
        if (e.dedupeAnnotation === true) {
          entry.dedupeAnnotation = true;
          entry.dedupeKeep = e.dedupeKeep === 'target' ? 'target' : 'source';
        }
        bySource.set(key, entry);
      } else if (prev.target !== target) {
        conflicts++;
      }
    }
  }
  // dropped：超過 cap 被捨棄的條數（匯入合併路徑要告知使用者，不可靜默丟）
  const all = [...bySource.values()];
  return { entries: all.slice(0, cap), conflicts, dropped: Math.max(0, all.length - cap) };
}

// 人名間隔號正規化（2026-07-10 Jimmy 指定）：CJK 之間的半形間隔號
//（· U+00B7 / ‧ U+2027 / ･ U+FF65）一律轉全形「・」（U+30FB），
// 例「拉夫·舒馬克」→「拉夫・舒馬克」。只在兩側都是 CJK 時替換——URL /
// 英文 / code 內的 middle dot 不受影響。適用於術語表 target 與文件翻譯
// 譯文輸出（translate-doc 範圍；網頁翻譯路徑維持 §7 排版歸 prompt 原則）
const NAME_SEP_RE = /(?<=[\u3400-\u9fff\uf900-\ufaff])[\u00B7\u2027\uFF65](?=[\u3400-\u9fff\uf900-\ufaff])/g;
export function normalizeNameSeparators(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  return s.replace(NAME_SEP_RE, '\u30FB');
}

// 編輯器分組：人名 / 地名 / 其他術語（tech / work / 未標 type 都算其他）
export function glossaryGroupOf(entry) {
  if (entry && entry.type === 'person') return 'person';
  if (entry && entry.type === 'place') return 'place';
  return 'other';
}

// ─── 費用預估 ─────────────────────────────────────────────
// 粗估 heuristic（UI 標示「約」）：
//   拉丁文：input tokens ≈ chars / 4（平均 ~4 chars/token）、output ≈ chars × 0.5
//          （英文原文 → 繁中譯文的實測量級）
//   CJK 原文（日文 / 韓文 / 中文書譯成另一種中文等，code review 2026-09-11 §3.8-7）：
//          input ≈ chars / 1.5（一個字約 0.7 token）、output ≈ chars × 1.2（譯文字數與
//          原文相近、CJK 每字約 1 token，再加 thinking 模型計入 output 的思考量）。
//          係數以 2026-07-11 實測校準：178,756 字日文書拉丁公式估 $0.91、實花 $2.4
//         （低估 2.6 倍），新係數在同計價下約 2.4 倍
//   每批 prompt 殘餘 ~600 tokens（systemInstruction 大部分被 implicit cache 折掉，
//   取折後殘值）
// cjkRatio = 該段文字中 CJK 字元佔比（0–1），兩種係數按比例混合。
// 回傳 null = 查不到該 model 計價（自訂 Provider 等），UI 顯示「—」。
export function estimateChapterCostUSD(charCount, model, settings, cjkRatio = 0) {
  const pricing = getPricingForModel(model, settings);
  if (!pricing || !charCount) return null;
  const ratio = Number.isFinite(cjkRatio) ? Math.min(1, Math.max(0, cjkRatio)) : 0;
  const cjkChars = charCount * ratio;
  const latinChars = charCount - cjkChars;
  const batches = Math.max(1, Math.ceil(charCount / 4000));
  const inTok = latinChars / 4 + cjkChars / 1.5 + batches * 600;
  const outTok = latinChars * 0.5 + cjkChars * 1.2;
  // 估算同樣依 service tier 倍率（Flex 半價 / Priority 1.8 倍），與翻完的實際記帳一致
  const tier = serviceTierMultiplier(settings?.geminiConfig?.serviceTier);
  return (inTok * pricing.inputPerMTok + outTok * pricing.outputPerMTok) / 1e6 * tier;
}

// 一組 block 的 CJK 字元佔比（估價係數用）：漢字 / 假名 / 諺文 / 全形標點
const CJK_CHAR_RE = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;
export function cjkRatioOfBlocks(blocks) {
  let total = 0;
  let cjk = 0;
  for (const b of blocks) {
    const t = (b && b.plainText) || '';
    total += t.length;
    cjk += (t.match(CJK_CHAR_RE) || []).length;
  }
  return total > 0 ? cjk / total : 0;
}
