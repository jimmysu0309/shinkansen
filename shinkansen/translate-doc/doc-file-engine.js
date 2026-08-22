// doc-file-engine.js — 純文字 / Markdown / HTML 檔翻譯引擎（v2.0.87 起）
//
// 職責：把 txt / md / htm / html 解析成與 EPUB doc 同形狀的結構
//（chapters / blocks / pages），讓章節清單、全書術語表、工作階段持久化、
// 一致性掃描、翻譯 pipeline（translate.js translateDocument）原樣重用
//（單一資料源，CLAUDE.md 工作流原則 §5）；譯文輸出格式 = 輸入格式。
//
// 三種格式的分工：
//   - txt：整份單一「章節」，按空行分段成 block；無章節結構（UI 不出章節勾選）
//   - md：按 ATX 標題（# / ##）切章，比照 EPUB 出章節勾選清單；
//     標題 / 清單 / 引用的 markdown 前綴由 writer 重建，fenced code 原樣保留
//   - html：重用 epub-engine collectChapterBlocks（⟦N⟧ 佔位符序列化）與
//     epub-writer applyBlockTranslation（反序列化寫回），整份單一章節
//   - 字幕檔（srt / vtt / ass）另見 subtitle-engine.js：重用本檔的 segment
//     協定、assembleTextDoc 與 blockOutputText，只有解析與標記對映不同
//
// 重建策略（txt / md）：解析時把整份文字切成有序 segment 序列——
//   { verbatim } 原樣片段（空行 / code fence / 純標點段）與
//   { block, src, prefix, linePrefix } 可翻段。writer 逐 segment 串接：
//   未翻 block 用原文 slice（src），已翻 block 用 prefix + 譯文（多行時
//   後續行加 linePrefix，如引用的「> 」）。整份未翻時輸出 === 輸入
//  （EOL 統一者；CRLF 檔案整檔正規化後回寫 CRLF）。
//
// block 欄位與 EPUB block 對齊：plainText（原文）、epubSerializedText
//（送 LLM 文字 = 翻譯快取 key 基底；txt / md 無佔位符，slots = []）、
// translationRaw / translation / editedHtml / translationStatus。
// translate.js 以「epubSerializedText != null」走 raw 保留路徑，
// renderBlockContent / session 存檔 / 一致性掃描全部原樣可用。

import { collectChapterBlocks, getSerializerSK, EPUB_LIMITS } from './epub-engine.js';
// epub-writer 走 lazy import（buildTranslatedHtmlDoc 內）：該檔頂層有
// new XMLSerializer()，頂層 import 會讓 Node 端 unit spec 無法載入本模組
//（txt / md / CSV 解析是純函式，unit 測試直接 import 驗）

export class DocFileParseError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'DocFileParseError';
    this.code = code; // 'empty' | 'too-large' | 'parse'
  }
}

// ─── 檔案類型偵測 / preflight ─────────────────────────────
export function detectDocFileKind(file) {
  const name = (file && file.name) || '';
  if (/\.txt$/i.test(name)) return 'txt';
  if (/\.(md|markdown)$/i.test(name)) return 'md';
  if (/\.html?$/i.test(name)) return 'html';
  const type = (file && file.type) || '';
  if (type === 'text/plain') return 'txt';
  if (type === 'text/markdown') return 'md';
  if (type === 'text/html') return 'html';
  return null;
}

export function preflightDocFile(file) {
  // 硬上限沿用 EPUB 的防呆值（100 MB）；成本維度由章節清單的軟警告把關
  if (file.size > EPUB_LIMITS.hardMaxBytes) {
    return { level: 'error', code: 'too-large' };
  }
  return { level: 'ok' };
}

// ─── 共用小工具 ───────────────────────────────────────────
// 「有可翻文字」判斷：與 epub-engine collectChapterBlocks 的字母集合同源
//（拉丁 / 西里爾 / CJK / 假名 / 諺文）。純數字 / 標點 / 分隔線不送翻
export const HAS_LETTER_RE = /[A-Za-zÀ-ÿЀ-ӿ㐀-鿿぀-ヿ가-힯]/;

// 超長段落切塊上限（無空行的整檔 txt 防呆；一般段落遠低於此值）。
// 行邊界優先，單行超長退到句界
const BLOCK_MAX_CHARS = 2000;

export function normalizeEol(rawText) {
  const hadCrLf = /\r\n/.test(rawText);
  return { text: rawText.replace(/\r\n?/g, '\n'), hadCrLf };
}

export function stripBom(rawText) {
  const hadBom = rawText.charCodeAt(0) === 0xFEFF;
  return { text: hadBom ? rawText.slice(1) : rawText, hadBom };
}

// ─── 文字檔解碼（編碼自動判斷 → 內部一律 UTF-8 字串，輸出一律 UTF-8）──
// file.text() 固定當 UTF-8 解碼：Big5 / GBK / Shift_JIS / EUC-KR 的舊編碼字幕 /
// 文字檔（網路流通極多）讀進來整份亂碼，存出去的「UTF-8」檔內容也是亂碼。
// 判斷順序：UTF-16 BOM → UTF-8（fatal）→ 依目標語言排序的舊編碼候選
//（fatal 解碼成功 + 文字可信度檢查）→ windows-1252（永不失敗的最後退路）。
//
// 可信度檢查是結構性必要：Big5 / GBK 的位元組空間幾乎互相涵蓋（Big5 位元組
// 當 GBK 解幾乎必成功、反之亦然），單靠 fatal 分不出；Latin-1 的「ñ」+ 字母
// 也能被當成一個合法雙位元組漢字。所以要求（1）該編碼的文字系統占字母的
// 3 成以上（Latin-1 西文不會中）、（2）漢字須有足夠比例落在常用字集合、
// 日文須有足夠假名、韓文須有足夠常用音節（亂碼是均勻隨機字，比例極低）。
const COMMON_HANZI = new Set(('的一是不了在人有我他這这個个們们中來来上大為为和國国地到以說说時时要就出會会可也你對对生能而子那得於于著着下自之年過过發发後后作裡里用道行所然家種种事成方多經经麼么去法學学如都同現现當当沒没動动面起看定天分還还進进好小部其些主樣样理心她本前開开但因只從从想實实日軍军者意無无力它與与長长把機机十民第公此已工使情明性知全三又關关點点正業业外將将兩两高間间由問问很最重並并物手應应戰战向頭头文體体政美相見见被利什二等產产或新己制身果加西斯月話话合回特代內内信表化老給给世位次度門门任常先海通教兒儿原東东聲声提立及比員员解水名真論论處处走義义各入幾几口認认條条平系氣气題题活爾尔更別别打女變变四神總总何電电數数安少報报才結结反受目太量再感建務务做接必場场件計计管期市直德資资命山金指克許许統统區区保至隊队形社便空決决治展馬马科司五基眼書书非則则聽听白卻却界達达光放強强即像難难且權权思王象完設设式色路記记南品住告類类求據据程北邊边死張张該该交規规萬万取拉格望覺觉術术領领共確确傳传師师觀观清今切院讓让識识候帶带導导爭争運运笑飛飞風风步改收根幹干造言聯联持組组每濟济車车親亲極极林服快辦办議议往元英士證证近失轉转夫令準准布始怎呢存未遠远叫台單单影具羅罗字愛爱擊击流備备兵連连調调深商算質质團团集百需價价花黨党華华城石級级整府離离況况亞亚請请技際际約约示復复病息究線线似官火斷断精滿满支視视消越器容照須须九增研寫写稱称企八功嗎吗包片史委乎查輕轻易早曾除農农找裝装廣广顯显吧阿李標标談谈吃圖图念六引歷历首醫医局突專专費费號号盡尽另周較较注語语僅仅考落青隨随選选奇嚴严江省板半友陽阳獎奖雲云輪轮啊哦喔嘿唉哪誰谁').split(''));
const COMMON_HANGUL = new Set('이다는을를에의가하고한지로도기서나것게니사아그수어있자으시리인대정보들주해요면상없않만우전소내적마라경생되와실학국제일부오무세처장신문'.split(''));
const LETTER_ANY_RE = /[A-Za-zÀ-ÿЀ-ӿ㐀-鿿぀-ヿ가-힯]/g;
const count = (s, re) => (s.match(re) || []).length;
const ratioIn = (s, re, set) => {
  const chars = s.match(re) || [];
  if (chars.length === 0) return 0;
  let hit = 0;
  for (const c of chars) if (set.has(c)) hit++;
  return hit / chars.length;
};
const LEGACY_CANDIDATES = [
  { enc: 'big5', script: /[一-鿿]/g, plausible: (s) => ratioIn(s, /[一-鿿]/g, COMMON_HANZI) >= 0.2 },
  { enc: 'gbk', script: /[一-鿿]/g, plausible: (s) => ratioIn(s, /[一-鿿]/g, COMMON_HANZI) >= 0.2 },
  { enc: 'shift_jis', script: /[぀-ヿ一-鿿]/g, plausible: (s) => count(s, /[぀-ヿ]/g) / Math.max(1, count(s, /[぀-ヿ一-鿿]/g)) >= 0.2 },
  { enc: 'euc-kr', script: /[가-힯]/g, plausible: (s) => ratioIn(s, /[가-힯]/g, COMMON_HANGUL) >= 0.15 },
];

// 依目標語言把對應編碼排前（zh-CN → gbk 優先；其餘 zh → big5；ja / ko 同理），
// 其餘維持預設順序
function orderLegacyCandidates(targetLanguage) {
  const l = String(targetLanguage || '').toLowerCase();
  const pref = (l === 'zh-cn' || l === 'zh-sg' || l === 'zh-hans') ? 'gbk'
    : l.startsWith('zh') ? 'big5'
      : l.startsWith('ja') ? 'shift_jis'
        : l.startsWith('ko') ? 'euc-kr' : null;
  if (!pref) return LEGACY_CANDIDATES;
  return [...LEGACY_CANDIDATES.filter((c) => c.enc === pref), ...LEGACY_CANDIDATES.filter((c) => c.enc !== pref)];
}

/**
 * 位元組 → 字串（編碼自動判斷）。BOM 保留在字串內（U+FEFF），由 stripBom 記錄、
 * 輸出端按原樣回寫（有 BOM 的來源輸出 UTF-8 BOM）。
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {{ text: string, encoding: string }}
 */
export function decodeTextBytes(buf, { targetLanguage } = {}) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return { text: new TextDecoder('utf-16le', { ignoreBOM: true }).decode(bytes), encoding: 'utf-16le' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return { text: new TextDecoder('utf-16be', { ignoreBOM: true }).decode(bytes), encoding: 'utf-16be' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), encoding: 'utf-8' };
  } catch (_) { /* 非 UTF-8，往下試舊編碼 */ }
  for (const cand of orderLegacyCandidates(targetLanguage)) {
    let text;
    try {
      text = new TextDecoder(cand.enc, { fatal: true }).decode(bytes);
    } catch (_) {
      continue;
    }
    const letters = count(text, LETTER_ANY_RE);
    if (letters === 0) continue;
    if (count(text, cand.script) / letters < 0.3) continue;
    if (!cand.plausible(text)) continue;
    return { text, encoding: cand.enc };
  }
  return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
}

/** File → 字串（走 decodeTextBytes）；無 arrayBuffer 的測試替身退回 text() */
export async function decodeTextFile(file, opts = {}) {
  if (typeof file.arrayBuffer !== 'function') return file.text();
  return decodeTextBytes(await file.arrayBuffer(), opts).text;
}

// ─── txt 解析（純函式，unit 可測）────────────────────────
// 回傳 { segments }：segment = { verbatim } 或
// { block: { text, type }, src, prefix, linePrefix }
export function parseTxtStructure(text) {
  const segments = [];
  let cursor = 0;
  // 段落 = 連續「含非空白字元」的行；其餘（空白行串）為 verbatim
  const paraRe = /[^\n]*\S[^\n]*(?:\n[^\n]*\S[^\n]*)*/g;
  let m;
  while ((m = paraRe.exec(text)) !== null) {
    if (m.index > cursor) segments.push({ verbatim: text.slice(cursor, m.index) });
    pushParagraphSegments(segments, m[0], '', '');
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) segments.push({ verbatim: text.slice(cursor) });
  return { segments };
}

// 段落文字 → 一或多個 block segment（超長時按行、再按句界切）。
// 純標點 / 數字段（分隔線「***」、頁碼）直接 verbatim
function pushParagraphSegments(segments, para, prefix, linePrefix) {
  if (!HAS_LETTER_RE.test(para)) {
    segments.push({ verbatim: para });
    return;
  }
  for (const piece of splitOversized(para)) {
    if (piece.gap) segments.push({ verbatim: piece.text });
    else {
      segments.push({
        block: { text: piece.text, type: 'paragraph' },
        src: piece.text,
        prefix,
        linePrefix,
      });
    }
  }
}

// 超長段落切塊：行邊界累積 ≤ BLOCK_MAX_CHARS；單行超長按句界切。
// 回傳 [{ text, gap? }]——gap 片段（行間 \n / 句間空白）原樣保留，
// 串接後恰等於輸入（重建不變量）
function splitOversized(para) {
  if (para.length <= BLOCK_MAX_CHARS) return [{ text: para }];
  const out = [];
  const lines = para.split('\n');
  let cur = [];
  let curLen = 0;
  const flush = () => {
    if (cur.length === 0) return;
    out.push({ text: cur.join('\n') });
    cur = [];
    curLen = 0;
  };
  // 相鄰 block 間的行分隔 \n 以 gap 片段保留（串接後恰等於輸入）
  const gapIfNeeded = () => {
    if (out.length > 0) out.push({ text: '\n', gap: true });
  };
  for (const line of lines) {
    if (line.length > BLOCK_MAX_CHARS) {
      flush();
      gapIfNeeded();
      pushSentenceChunks(out, line);
      continue;
    }
    if (curLen + line.length + 1 > BLOCK_MAX_CHARS) flush();
    if (cur.length === 0) gapIfNeeded();
    cur.push(line);
    curLen += line.length + 1;
  }
  flush();
  return out;
}

// 單行超長（整本書無換行的極端 txt）：句界切塊,句間空白保留為 gap
function pushSentenceChunks(out, line) {
  const sentRe = /[^]*?[.!?。！？…‥](?=\s|$)|[^]+$/g;
  let cur = '';
  let m;
  const flush = () => {
    if (!cur) return;
    out.push({ text: cur });
    cur = '';
  };
  while ((m = sentRe.exec(line)) !== null) {
    const piece = m[0];
    if (cur && cur.length + piece.length > BLOCK_MAX_CHARS) flush();
    cur += piece;
    if (cur.length >= BLOCK_MAX_CHARS) flush();
  }
  flush();
}

// ─── md 解析（純函式，unit 可測）─────────────────────────
// 行級掃描。結構規則（全部結構性，不綁特定 flavor 擴充）：
//   - fenced code（``` / ~~~，含縮排 ≤3）整段 verbatim
//   - ATX 標題（#{1,6} + 空白）→ heading block；level ≤ 2 切新章節
//   - 引用（行首 >）連續行合一 block，writer 重建「> 」前綴
//   - 清單項（- * + / 數字. / 數字)）逐行一 block，原始 marker 當 prefix
//   - 空白行 / 純標點段 verbatim；其餘連續行合併為段落 block
// 回傳 { segments, chapterBreaks }：chapterBreaks = [{ segIndex, title }]
//（指向作為章節起點的 heading segment）
export function parseMdStructure(text) {
  const segments = [];
  const chapterBreaks = [];
  const lines = text.split('\n');
  // 行起點 offset（verbatim / src slice 用）。最後一行無結尾 \n 時
  // offsets[lines.length] 會超出 text.length，取值處一律 clamp
  const offsets = new Array(lines.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < lines.length; i++) offsets[i + 1] = offsets[i] + lines[i].length + 1;
  const clamp = (o) => Math.min(text.length, o);
  // 行區間 [a, b) 的內容 slice（不含 b-1 行的結尾 \n——那個 \n 留給後續
  // verbatim flush，block segment 不吃行尾換行,重建才不會漏字元）
  const lineSpan = (a, b) => text.slice(offsets[a], clamp(offsets[b] - 1));

  // 尚未歸類的 verbatim 起始 char offset
  let verbCursor = 0;
  const flushVerbatimTo = (offset) => {
    const o = clamp(offset);
    if (o > verbCursor) segments.push({ verbatim: text.slice(verbCursor, o) });
    verbCursor = o;
  };
  // block segment 收尾:verbatim 游標移到 block 內容結束處（行尾 \n 由
  // 下一次 flush 接手）
  const consumeLines = (a, b) => {
    verbCursor = clamp(offsets[b] - 1);
  };

  const RE_FENCE = /^\s{0,3}(`{3,}|~{3,})/;
  const RE_ATX = /^(#{1,6})([ \t]+)(.*)$/;
  const RE_QUOTE = /^\s{0,3}>/;
  const RE_LIST = /^(\s*(?:[-*+]|\d{1,9}[.)])[ \t]+)(\S.*)$/;
  const RE_BLANK = /^\s*$/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(RE_FENCE);
    if (fence) {
      // 找閉合 fence（同字元、長度足夠）；找不到就整份到尾原樣保留。
      // fence 全區留在 verbatim 累積內（不 flush、不出 block）
      const marker = fence[1][0];
      const minLen = fence[1].length;
      const closeRe = new RegExp(`^\\s{0,3}\\${marker}{${minLen},}\\s*$`);
      let j = i + 1;
      while (j < lines.length && !closeRe.test(lines[j])) j++;
      i = Math.min(lines.length, j + 1);
      continue;
    }
    const atx = line.match(RE_ATX);
    if (atx && HAS_LETTER_RE.test(atx[3])) {
      flushVerbatimTo(offsets[i]);
      if (atx[1].length <= 2) {
        chapterBreaks.push({ segIndex: segments.length, title: atx[3].trim().slice(0, 80) });
      }
      segments.push({
        block: { text: atx[3], type: 'heading' },
        src: lineSpan(i, i + 1),
        prefix: atx[1] + atx[2],
        linePrefix: '',
      });
      consumeLines(i, i + 1);
      i++;
      continue;
    }
    if (RE_QUOTE.test(line)) {
      let j = i;
      while (j < lines.length && RE_QUOTE.test(lines[j])) j++;
      const src = lineSpan(i, j);
      const inner = lines.slice(i, j).map((l) => l.replace(/^\s{0,3}> ?/, '')).join('\n');
      flushVerbatimTo(offsets[i]);
      if (HAS_LETTER_RE.test(inner)) {
        segments.push({
          block: { text: inner, type: 'paragraph' },
          src,
          prefix: '> ',
          linePrefix: '> ',
        });
      } else {
        segments.push({ verbatim: src });
      }
      consumeLines(i, j);
      i = j;
      continue;
    }
    const list = line.match(RE_LIST);
    if (list && HAS_LETTER_RE.test(list[2])) {
      flushVerbatimTo(offsets[i]);
      segments.push({
        block: { text: list[2], type: 'paragraph' },
        src: lineSpan(i, i + 1),
        prefix: list[1],
        linePrefix: ' '.repeat(list[1].length),
      });
      consumeLines(i, i + 1);
      i++;
      continue;
    }
    if (RE_BLANK.test(line)) {
      i++;
      continue; // 空白行留在 verbatim 累積
    }
    // 一般段落：連續「非空白、非結構行」合併（表格列也走這裡——markdown
    // 表格屬文字內容整段送翻,LLM 對管線符號結構保留穩定）
    let j = i;
    while (j < lines.length
      && !RE_BLANK.test(lines[j]) && !RE_FENCE.test(lines[j])
      && !RE_ATX.test(lines[j]) && !RE_QUOTE.test(lines[j]) && !RE_LIST.test(lines[j])) j++;
    const para = lineSpan(i, j);
    flushVerbatimTo(offsets[i]);
    pushParagraphSegments(segments, para, '', '');
    consumeLines(i, j);
    i = j;
  }
  flushVerbatimTo(text.length);
  return { segments, chapterBreaks };
}

// ─── doc 組裝（txt / md 共用；subtitle-engine 字幕檔亦重用）──────
function baseName(filename, kind) {
  // 其他 kind（subtitle-engine 的字幕檔）剝任一副檔名
  const re = kind === 'html' ? /\.html?$/i : kind === 'md' ? /\.(md|markdown)$/i : kind === 'txt' ? /\.txt$/i : /\.[^.]+$/;
  return (filename || '').replace(re, '') || (filename || 'document');
}

function makeBlock(meta, chapterIndex, n) {
  return {
    blockId: `c${chapterIndex}-b${n}`,
    type: meta.type,
    plainText: meta.text,
    // 送 LLM 文字（＝翻譯快取 key 基底）。txt / md 無佔位符 → slots 空
    epubSerializedText: meta.text,
    slots: [],
    translation: null,
    translationRaw: null,
    translationStatus: 'pending',
    translationError: null,
  };
}

export function assembleTextDoc(kind, filename, structure, { hadCrLf, hadBom }) {
  const { segments, chapterBreaks = [] } = structure;
  // 章節切分：md 依 heading（level ≤2）；txt / 無標題 md 單章
  const breaks = new Map(chapterBreaks.map((b) => [b.segIndex, b.title]));
  const chapters = [];
  const newChapter = (title) => {
    const ch = {
      index: chapters.length,
      href: '',
      linear: 'yes',
      isNavDoc: false,
      title,
      parseFailed: false,
      blocks: [],
      charCount: 0,
      selected: true,
      suggestSkip: false,
    };
    chapters.push(ch);
    return ch;
  };
  let cur = null;
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    if (breaks.has(si)) cur = newChapter(breaks.get(si));
    if (!seg.block) continue;
    if (!cur) cur = newChapter(baseName(filename, kind));
    const block = makeBlock(seg.block, cur.index, cur.blocks.length);
    seg.block = block; // segment 直接引用最終 block（writer 讀翻譯結果）
    cur.blocks.push(block);
    cur.charCount += block.plainText.length;
  }
  if (chapters.length === 0 || chapters.every((c) => c.blocks.length === 0)) {
    throw new DocFileParseError('empty');
  }
  const totalChars = chapters.reduce((acc, c) => acc + c.charCount, 0);
  return {
    kind,
    meta: {
      filename,
      title: baseName(filename, kind),
      author: '',
      language: '',
      identifier: '',
      epubVersion: '',
      pageCount: chapters.length,
      chapterCount: chapters.length,
    },
    stats: { totalChars },
    chapters,
    pages: chapters.map((c) => ({ pageIndex: c.index, chapterIndex: c.index, blocks: c.blocks })),
    fileSegments: segments,
    hadCrLf,
    hadBom,
  };
}

// ─── HTML 解析 ────────────────────────────────────────────
function parseHtmlDoc(rawText, filename) {
  const SK = getSerializerSK();
  const htmlDoc = new DOMParser().parseFromString(rawText, 'text/html');
  const blocks = collectChapterBlocks(htmlDoc, 0, SK);
  if (blocks.length === 0) throw new DocFileParseError('empty');
  const title = (htmlDoc.title || '').trim() || baseName(filename, 'html');
  const chapters = [{
    index: 0,
    href: '',
    linear: 'yes',
    isNavDoc: false,
    title,
    parseFailed: false,
    blocks,
    charCount: blocks.reduce((acc, b) => acc + b.plainText.length, 0),
    selected: true,
    suggestSkip: false,
  }];
  return {
    kind: 'html',
    meta: {
      filename,
      title,
      author: '',
      language: htmlDoc.documentElement.getAttribute('lang') || '',
      identifier: '',
      epubVersion: '',
      pageCount: 1,
      chapterCount: 1,
    },
    stats: { totalChars: chapters[0].charCount },
    chapters,
    pages: [{ pageIndex: 0, chapterIndex: 0, blocks }],
    htmlDoc,
    hadDoctype: /^\s*<!doctype/i.test(rawText),
  };
}

// ─── 主解析入口 ───────────────────────────────────────────
/**
 * @param {File} file
 * @param {'txt'|'md'|'html'} kind — detectDocFileKind 結果
 * @param {{ targetLanguage?: string }} [opts] — 舊編碼候選排序用
 * @returns {Promise<object>} 與 parseEpub 同形狀的 doc（kind 不同）
 */
export async function parseDocFile(file, kind, opts = {}) {
  const rawText = await decodeTextFile(file, opts);
  if (kind === 'html') return parseHtmlDoc(rawText, file.name);
  const bom = stripBom(rawText);
  const eol = normalizeEol(bom.text);
  const structure = kind === 'md' ? parseMdStructure(eol.text) : parseTxtStructure(eol.text);
  return assembleTextDoc(kind, file.name, structure, { hadCrLf: eol.hadCrLf, hadBom: bom.hadBom });
}

// ─── 譯文輸出（txt / md）──────────────────────────────────
// editedHtml（預覽頁手動編輯 / 掃描替換 / 空格自動校正的存回形態）→ 純文字。
// <br> 與 block 元素邊界視為換行;真實頁面走 DOM,node 測試環境 fallback regex
function editedHtmlToPlain(html) {
  try {
    if (typeof document !== 'undefined' && document.createElement) {
      const div = document.createElement('div');
      div.innerHTML = String(html).replace(/<br\s*\/?>/gi, '\n');
      return div.textContent;
    }
  } catch (_) { /* fall through */ }
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// block 譯文輸出優先序（與 epub-writer applyBlockTranslation 同語意）：
// editedHtml → translationRaw → translation；未翻 / 失敗回 null（writer 用原文）
export function blockOutputText(b, override) {
  if (!b || b.translationStatus !== 'done') return null;
  const edited = override?.editedHtml ?? b.editedHtml;
  if (typeof edited === 'string' && edited.length > 0) return editedHtmlToPlain(edited);
  const raw = override?.translationRaw ?? b.translationRaw;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  const plain = override?.translation ?? b.translation;
  if (typeof plain === 'string' && plain.length > 0) return plain;
  return null;
}

/**
 * txt / md 譯文檔重建。
 * @param {object} doc — parseDocFile 輸出（blocks 已帶翻譯結果）
 * @param {Map|null} dedupe — computeAnnotationDedupe 的 blockId → override map
 * @returns {string}
 */
export function buildTranslatedDocText(doc, dedupe = null) {
  const parts = [];
  for (const seg of doc.fileSegments) {
    if (seg.verbatim != null) {
      parts.push(seg.verbatim);
      continue;
    }
    const out = blockOutputText(seg.block, dedupe ? dedupe.get(seg.block.blockId) : null);
    if (out == null) {
      parts.push(seg.src);
      continue;
    }
    const lines = out.split('\n');
    parts.push(seg.prefix + lines
      .map((ln, i) => (i === 0 ? ln : seg.linePrefix + ln))
      .join('\n'));
  }
  let text = parts.join('');
  if (doc.hadCrLf) text = text.replace(/\n/g, '\r\n');
  if (doc.hadBom) text = '﻿' + text;
  return text;
}

// ─── 譯文輸出（HTML）──────────────────────────────────────
/**
 * HTML 譯文檔重建：譯文經 applyBlockTranslation 寫回解析用的同一份 DOM
 *（editedHtml → ⟦N⟧ 反序列化 → 純文字 fallback 的優先序、_srcChildNodes
 * 快照 idempotent 重複下載都與 EPUB writer 同一條），更新 <html lang>，
 * 序列化整份文件。
 * @returns {Promise<string>}
 */
export async function buildTranslatedHtmlDoc(doc, targetLanguage, dedupe = null) {
  const { applyBlockTranslation } = await import('./epub-writer.js');
  const SK = getSerializerSK();
  const htmlDoc = doc.htmlDoc;
  for (const ch of doc.chapters) {
    for (const b of ch.blocks) {
      if (b.translationStatus !== 'done') continue;
      applyBlockTranslation(SK, htmlDoc, b, dedupe ? dedupe.get(b.blockId) : null, false);
    }
  }
  if (targetLanguage) htmlDoc.documentElement.setAttribute('lang', targetLanguage);
  // 下載檔以 UTF-8 輸出：來源沒宣告 charset 時補 <meta charset>，
  // 否則本機開檔（無 HTTP header）非 ASCII 會亂碼
  if (!htmlDoc.querySelector('meta[charset], meta[http-equiv="Content-Type" i]')) {
    const head = htmlDoc.querySelector('head');
    if (head) {
      const meta = htmlDoc.createElement('meta');
      meta.setAttribute('charset', 'utf-8');
      head.insertBefore(meta, head.firstChild);
    }
  }
  return (doc.hadDoctype ? '<!DOCTYPE html>\n' : '') + htmlDoc.documentElement.outerHTML;
}

/** 下載檔名：<原檔名>-shinkansen.<原副檔名>（與 EPUB 的 -shinkansen 慣例一致） */
export function translatedDocFilename(originalName, kind) {
  const name = originalName || 'document';
  const m = name.match(/\.(txt|md|markdown|html?)$/i);
  const ext = m ? m[0] : (kind === 'html' ? '.html' : kind === 'md' ? '.md' : '.txt');
  const base = m ? name.slice(0, -m[0].length) : name;
  return `${base}-shinkansen${ext}`;
}

// ─── 術語表 CSV 解析 ──────────────────────────────────────
// 兩欄「原文,譯名」。容錯：BOM / CRLF / RFC4180 引號跳脫（"a,b" / "" 逃逸）/
// header 列（首列像欄名時剔除）/ 空列與欄數不足列跳過。
// 只回 { source, target }——選項 flag（noTranslate 等）是 JSON 匯出格式的欄位，
// CSV 屬外部工具整理的簡表，不猜第三欄語意
export function parseGlossaryCsv(text) {
  if (typeof text !== 'string' || !text) return null;
  const s = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const entries = [];
  for (const r of rows) {
    if (r.length < 2) continue;
    const source = (r[0] || '').trim();
    const target = (r[1] || '').trim();
    if (!source || !target) continue;
    entries.push({ source, target });
  }
  // header 容忍：首列欄名長相（source / target / 原文 / 譯名 等）就剔除
  if (entries.length > 0) {
    const h = entries[0];
    if (/^(source|original|term|原文|词条|詞條|用語|原語)$/i.test(h.source)
      || /^(target|translation|translated|譯名|译名|譯文|译文|訳語)$/i.test(h.target)) {
      entries.shift();
    }
  }
  return entries.length > 0 ? entries : null;
}
