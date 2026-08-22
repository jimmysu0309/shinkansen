// subtitle-engine.js — 字幕檔（SRT / WebVTT / ASS・SSA）翻譯引擎
//
// 職責：把字幕檔解析成與 EPUB / txt doc 同形狀的結構（chapters / blocks /
// pages / fileSegments），讓章節清單、全書術語表、工作階段持久化、一致性掃描、
// 翻譯 pipeline（translate.js translateDocument）原樣重用（單一資料源，
// CLAUDE.md 工作流原則 §5）；譯文輸出格式 = 輸入格式。
//
// 結構規則（全部結構性，不綁特定工具產出的方言）：
//   - SRT / VTT：含「-->」的時間軸行之後、到下一個空白行之前的連續行 = 一則
//     字幕文字（一個 block）；其餘（序號 / 時間軸 / WEBVTT 標頭 / NOTE / STYLE /
//     REGION / 空白行）原樣 verbatim
//   - ASS / SSA：[Events] 區段內 Dialogue: 行的 Text 欄（依 Format: 行決定欄位
//     位置，預設第 10 欄）= 一則字幕文字；Comment: 行與其餘區段 verbatim
//   - 字幕文字內的行內標記（<i>…</i> / <c.cls>…</c> / <v 說話者> / VTT 時間標記
//     <00:01.000> / ASS 覆寫 {\an8} / ASS 換行 \N）序列化成 ⟦N⟧…⟦/N⟧（配對）
//     與 ⟦*N⟧（原子）佔位符——與網頁 / EPUB 同一套協定（system-instruction
//     偵測到 ⟦ 自動注入協定規則），譯文回來再以字串對映還原成原標記
//
// block 欄位與 EPUB block 對齊：plainText（去標記原文，\N → 換行）、
// epubSerializedText（含佔位符的送翻文字 = 翻譯快取 key 基底）、translationRaw
//（含佔位符譯文）/ translation（去佔位符純文字，預覽用）。
// **slots 刻意設 null**：字幕的佔位符對映是字串級（tagSlots），不是 DOM 節點；
// 預覽 renderBlockContent 看到非陣列 slots 直接走純文字 translation 路徑，
// 不會把 ⟦N⟧ 交給 DOM 反序列化。
//
// 重建（buildTranslatedSubtitleText）：逐 segment 串接——verbatim 原樣、
// 未翻 / 失敗 block 用原文 slice（src）、已翻 block 用還原標記後的譯文；
// 雙語模式每則字幕「譯文在上、原文在下」。整份未翻時輸出 === 輸入。

import {
  DocFileParseError, HAS_LETTER_RE, normalizeEol, stripBom, decodeTextFile,
  assembleTextDoc, blockOutputText,
} from './doc-file-engine.js';

export const SUBTITLE_FORMAT_LABELS = { srt: 'SRT', vtt: 'WebVTT', ass: 'ASS' };

// ─── 檔案類型偵測 ─────────────────────────────────────────
/** @returns {'srt'|'vtt'|'ass'|null} */
export function detectSubtitleFormat(file) {
  const name = (file && file.name) || '';
  if (/\.srt$/i.test(name)) return 'srt';
  if (/\.vtt$/i.test(name)) return 'vtt';
  if (/\.(ass|ssa)$/i.test(name)) return 'ass';
  const type = (file && file.type) || '';
  if (type === 'application/x-subrip') return 'srt';
  if (type === 'text/vtt') return 'vtt';
  return null;
}

// ─── 字幕文字 ⇄ 佔位符序列化（純函式，unit 可測）──────────
// token：HTML 式標記 <…>（含 VTT 時間標記 <00:01.000>、<v 說話者>）與
// ASS 式覆寫 {…}（SRT 也常見 {\an8}）；ASS 另含換行 \N / \n 與硬空白 \h
const TOKEN_RE_HTMLISH = /<[^<>\n]+>|\{[^{}\n]*\}/g;
const TOKEN_RE_ASS = /<[^<>\n]+>|\{[^{}\n]*\}|\\[Nnh]/g;
// 標記名到「.」為止（VTT <c.yellow>…</c> / <v.loud Bob> 的 class 後綴不算名字）
const OPEN_TAG_RE = /^<([A-Za-z][^\s>/.]*)(?:[^>]*)>$/;
const CLOSE_TAG_RE = /^<\/([A-Za-z][^\s>/.]*)\s*>$/;

function classifyToken(raw) {
  const close = raw.match(CLOSE_TAG_RE);
  if (close) return { kind: 'close', name: close[1].toLowerCase() };
  const open = raw.match(OPEN_TAG_RE);
  if (open && !/\/\s*>$/.test(raw)) return { kind: 'open', name: open[1].toLowerCase() };
  return { kind: 'atomic' };
}

/**
 * 把一則字幕文字序列化成佔位符形式。
 * @returns {{ serialized: string, plain: string, slots: Array<{open:string,close:string}|{atomic:string}> }}
 */
export function serializeCueText(text, format) {
  const re = format === 'ass' ? TOKEN_RE_ASS : TOKEN_RE_HTMLISH;
  const tokens = [];
  for (const m of text.matchAll(re)) {
    tokens.push({ start: m.index, end: m.index + m[0].length, raw: m[0], ...classifyToken(m[0]) });
  }
  // 配對：stack 對齊同名 open / close；對不上的 open / close 降為原子
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.kind === 'open') { stack.push(i); continue; }
    if (tk.kind !== 'close') continue;
    let found = -1;
    for (let s = stack.length - 1; s >= 0; s--) {
      if (tokens[stack[s]].name === tk.name) { found = s; break; }
    }
    if (found === -1) { tk.kind = 'atomic'; continue; }
    for (let s = stack.length - 1; s > found; s--) tokens[stack[s]].kind = 'atomic';
    const openIdx = stack[found];
    stack.length = found;
    tokens[openIdx].pairWith = i;
    tk.pairWith = openIdx;
    tk.kind = 'pairedClose';
  }
  for (const idx of stack) tokens[idx].kind = 'atomic';

  const slots = [];
  let serialized = '';
  let plain = '';
  let cursor = 0;
  for (const tk of tokens) {
    const between = text.slice(cursor, tk.start);
    serialized += between;
    plain += between;
    cursor = tk.end;
    if (tk.kind === 'open') {
      tk.slot = slots.length;
      slots.push({ open: tk.raw, close: tokens[tk.pairWith].raw });
      serialized += `⟦${tk.slot}⟧`;
    } else if (tk.kind === 'pairedClose') {
      serialized += `⟦/${tokens[tk.pairWith].slot}⟧`;
    } else {
      const n = slots.length;
      slots.push({ atomic: tk.raw });
      serialized += `⟦*${n}⟧`;
      if (format === 'ass') {
        if (tk.raw === '\\N' || tk.raw === '\\n') plain += '\n';
        else if (tk.raw === '\\h') plain += ' ';
      }
    }
  }
  const tail = text.slice(cursor);
  serialized += tail;
  plain += tail;
  return { serialized, plain, slots };
}

const MARKER_RE = /⟦([*＊]?)([/／]?)([0-9０-９]+)⟧/g;
const toAsciiDigits = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30));

/**
 * 譯文佔位符 → 原標記。配對型只在 open / close 兩端都存活時才還原（單邊殘留
 * 會輸出不平衡標記，寧可整組拿掉）；原子型一律還原。LLM 吃掉的 ASS 覆寫
 * 標記 {…} 補回行首（行首覆寫作用於整行，是無位置資訊下的最小破壞）。
 */
export function restoreCueText(translated, slots, format) {
  const opens = new Set();
  const closes = new Set();
  const seenAtomic = new Set();
  for (const m of translated.matchAll(MARKER_RE)) {
    const n = Number(toAsciiDigits(m[3]));
    if (m[1]) seenAtomic.add(n);
    else if (m[2]) closes.add(n);
    else opens.add(n);
  }
  let out = translated.replace(MARKER_RE, (_m, star, slash, digits) => {
    const n = Number(toAsciiDigits(digits));
    const slot = slots[n];
    if (!slot) return '';
    if (slot.atomic != null) return slot.atomic;
    if (!(opens.has(n) && closes.has(n))) return '';
    return slash ? slot.close : slot.open;
  });
  out = out.replace(/[⟦⟧]/g, '');
  let missing = '';
  slots.forEach((slot, i) => {
    if (slot.atomic != null && !seenAtomic.has(i) && /^\{/.test(slot.atomic)) missing += slot.atomic;
  });
  out = missing + out;
  if (format === 'ass') out = out.replace(/\n/g, '\\N');
  return out;
}

/**
 * 含佔位符的譯文逐文字片段套用 CJK↔拉丁間距校正（index.js autoFixCjkSpacing
 * 對字幕 block 的分支：DOM 路徑會把佔位符剝掉存成 editedHtml，行內標記全丟）。
 * @param {string} raw — translationRaw
 * @param {(text: string, ctx: {prevChar: string}) => {text: string, count: number}} fixFn
 */
export function fixCjkSpacingAroundPlaceholders(raw, fixFn) {
  const parts = String(raw).split(/(⟦[*＊]?[/／]?[0-9０-９]+⟧)/);
  let count = 0;
  let prevChar = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue; // 佔位符本體
    if (!parts[i]) continue;
    const r = fixFn(parts[i], { prevChar });
    if (r.count > 0) { parts[i] = r.text; count += r.count; }
    prevChar = parts[i].slice(-1);
  }
  return { text: parts.join(''), count };
}

// ─── 解析（純函式，unit 可測）────────────────────────────
function makeOffsets(lines) {
  const offsets = new Array(lines.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < lines.length; i++) offsets[i + 1] = offsets[i] + lines[i].length + 1;
  return offsets;
}

function pushCueSegment(segments, src, format) {
  const cue = serializeCueText(src, format);
  // 純音符 / 純標點字幕（♪ ♪、…）不送翻
  if (!HAS_LETTER_RE.test(cue.plain)) {
    segments.push({ verbatim: src });
    return;
  }
  segments.push({
    block: { text: cue.plain, type: 'paragraph' },
    cue: { serialized: cue.serialized, slots: cue.slots },
    src,
    prefix: '',
    linePrefix: '',
  });
}

// SRT / VTT：時間軸行（含 -->）之後到空白行之前的連續行 = 字幕文字
function parseTimedStructure(text, format) {
  const segments = [];
  const lines = text.split('\n');
  const offsets = makeOffsets(lines);
  const clamp = (o) => Math.min(text.length, o);
  let verbCursor = 0;
  const flushVerbatimTo = (offset) => {
    const o = clamp(offset);
    if (o > verbCursor) segments.push({ verbatim: text.slice(verbCursor, o) });
    verbCursor = o;
  };
  const RE_TIMING = /-->/;
  const RE_BLANK = /^\s*$/;
  let i = 0;
  while (i < lines.length) {
    if (!RE_TIMING.test(lines[i])) { i++; continue; }
    let j = i + 1;
    while (j < lines.length && !RE_BLANK.test(lines[j])) j++;
    if (j > i + 1) {
      const src = text.slice(offsets[i + 1], clamp(offsets[j] - 1));
      flushVerbatimTo(offsets[i + 1]);
      pushCueSegment(segments, src, format);
      verbCursor = clamp(offsets[j] - 1);
    }
    i = j;
  }
  flushVerbatimTo(text.length);
  return { segments };
}

// ASS / SSA：[Events] 的 Dialogue: 行，Text 欄位置依 Format: 行（預設第 10 欄）
function parseAssStructure(text) {
  const segments = [];
  const lines = text.split('\n');
  const offsets = makeOffsets(lines);
  const clamp = (o) => Math.min(text.length, o);
  let verbCursor = 0;
  const flushVerbatimTo = (offset) => {
    const o = clamp(offset);
    if (o > verbCursor) segments.push({ verbatim: text.slice(verbCursor, o) });
    verbCursor = o;
  };
  let inEvents = false;
  let textIdx = 9;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sec = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sec) { inEvents = /^events$/i.test(sec[1].trim()); continue; }
    if (!inEvents) continue;
    const fmt = line.match(/^Format\s*:\s*(.*)$/i);
    if (fmt) {
      const fields = fmt[1].split(',').map((s) => s.trim().toLowerCase());
      const k = fields.indexOf('text');
      textIdx = k >= 0 ? k : Math.max(0, fields.length - 1);
      continue;
    }
    const dlg = line.match(/^Dialogue\s*:/i);
    if (!dlg) continue;
    // Text 是最後一欄：跳過前 textIdx 個逗號，之後的逗號屬於字幕文字本身
    let pos = dlg[0].length;
    let ok = true;
    for (let c = 0; c < textIdx; c++) {
      const k = line.indexOf(',', pos);
      if (k === -1) { ok = false; break; }
      pos = k + 1;
    }
    if (!ok) continue;
    const src = line.slice(pos);
    if (!src) continue;
    flushVerbatimTo(offsets[i] + pos);
    pushCueSegment(segments, src, 'ass');
    verbCursor = clamp(offsets[i + 1] - 1);
  }
  flushVerbatimTo(text.length);
  return { segments };
}

/** @returns {{ segments: Array }} */
export function parseSubtitleStructure(text, format) {
  return format === 'ass' ? parseAssStructure(text) : parseTimedStructure(text, format);
}

/**
 * @param {File} file
 * @param {'srt'|'vtt'|'ass'} format — detectSubtitleFormat 結果
 * @param {{ targetLanguage?: string }} [opts] — 舊編碼候選排序用（decodeTextFile）
 * @returns {Promise<object>} 與 parseEpub 同形狀的 doc（kind = 'subtitle'）
 */
export async function parseSubtitleFile(file, format, opts = {}) {
  // 編碼自動判斷（Big5 / GBK / Shift_JIS / EUC-KR / UTF-16 BOM …）→ 一律 UTF-8 處理與輸出
  const rawText = await decodeTextFile(file, opts);
  const bom = stripBom(rawText);
  const eol = normalizeEol(bom.text);
  const structure = parseSubtitleStructure(eol.text, format);
  const doc = assembleTextDoc('subtitle', file.name, structure, { hadCrLf: eol.hadCrLf, hadBom: bom.hadBom });
  doc.subtitleFormat = format;
  // 字幕 block：送翻文字改為佔位符序列化形式，標記對映存 tagSlots（字串級）
  for (const seg of structure.segments) {
    if (!seg.block || !seg.cue) continue;
    seg.block.epubSerializedText = seg.cue.serialized;
    seg.block.slots = null;
    seg.block.tagSlots = seg.cue.slots;
  }
  return doc;
}

// ─── 譯文輸出 ─────────────────────────────────────────────
/**
 * 字幕譯文檔重建。
 * @param {object} doc — parseSubtitleFile 輸出（blocks 已帶翻譯結果）
 * @param {Map|null} dedupe — computeAnnotationDedupe 的 blockId → override map
 * @param {{ bilingual?: boolean, stripPeriod?: boolean }} opts — 雙語：每則字幕譯文在上、
 *   原文在下；stripPeriod：譯文行尾「。」去除（stripCueTrailingPeriod，只動譯文不動原文）
 * @returns {string}
 */
export function buildTranslatedSubtitleText(doc, dedupe = null, { bilingual = false, stripPeriod = false } = {}) {
  const format = doc.subtitleFormat;
  const lineBreak = format === 'ass' ? '\\N' : '\n';
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
    const tr = restoreCueText(stripPeriod ? stripCueTrailingPeriod(out) : out, seg.block.tagSlots || [], format);
    parts.push(bilingual ? tr + lineBreak + seg.src : tr);
  }
  let text = parts.join('');
  if (doc.hadCrLf) text = text.replace(/\n/g, '\r\n');
  if (doc.hadBom) text = '﻿' + text;
  return text;
}

/**
 * 下載檔名：<原檔名>[.dual].<語言>.<原副檔名>（2026-08-22 Jimmy 指定，例
 * `Show S01E01.srt` → `Show S01E01.zh.srt`）。語言後綴是字幕檔的通行慣例：播放器
 *（VLC / Plex / Jellyfin / mpv）靠緊貼副檔名的語言碼把字幕自動對到影片並標出語言，
 * 所以語言碼一律放最後一節；雙語版的 `.dual` 放語言碼前面（不佔掉播放器讀的那一節）。
 * 語言碼取 target 的主要子標籤小寫（zh-TW / zh-CN → zh、en → en、ja → ja），播放器
 * 普遍認 2 字母碼；不沿用文件翻譯的 `-shinkansen` 後綴（那會被當成檔名的一部分，
 * 播放器對不到語言）
 */
export function translatedSubtitleFilename(originalName, format, { bilingual = false, targetLanguage = 'zh-TW' } = {}) {
  const name = originalName || 'subtitle';
  const m = name.match(/\.(srt|vtt|ass|ssa)$/i);
  const ext = m ? m[0] : `.${format || 'srt'}`;
  const base = m ? name.slice(0, -m[0].length) : name;
  const lang = (String(targetLanguage || 'zh').split(/[-_]/)[0] || 'zh').toLowerCase();
  return `${base}${bilingual ? '.dual' : ''}.${lang}${ext}`;
}

export function subtitleMimeType(format) {
  return format === 'vtt' ? 'text/vtt' : 'text/plain';
}

// ─── 字幕專用翻譯提示 ─────────────────────────────────────
// 隨「本文件額外翻譯指令」一起附加在 translateDoc.systemPrompt 之後（進 cache key
// _x hash）。字幕是連續片段、螢幕停留數秒：要用前後則當語境、但每則各自成句、
// 精簡；不可合併 / 拆分 / 搬動、不可加註。
// 「不加括號原文對照」必須明講並宣告優先：通用 prompt 有「特殊詞彙首次出現加註
// 原文」規則，字幕每則各自獨立、一批 50 則，模型把每則都當首次出現 → 滿篇
//「伊拉克（Iraq）」（2026-08-22 Jimmy 實檔 723 則出現 49 次）
const SUBTITLE_PROMPT_HINT_ZH = `本文件是影片字幕檔：每一段是一則依時間順序排列的字幕，可能只是半句話。翻譯時請參考前後字幕理解語境，但每則字幕只輸出該則對應的譯文，不可把相鄰字幕合併或拆分，也不可把某則的內容提前或延後到相鄰字幕（即使中文語序不同，每則譯文也要對應該則原文的內容，因為字幕必須對上畫面時間）。字幕在螢幕上只停留數秒，譯文務必精簡口語，不加註解或說明。

字幕專用規則（優先於上方任何「加註原文」規則）：譯名後面一律不要加括號原文對照。人名、地名、組織、作品名翻成中文後就只輸出中文譯名（術語表指定的譯名照表輸出），不可寫成「伊拉克（Iraq）」「海珊（Saddam Hussein）」這種形式；只有術語表的譯名本身已含括號對照時才照表輸出。原文的換行可視譯文長度保留或合併為一行。`;
const SUBTITLE_PROMPT_HINT_EN = `This document is a video subtitle file: each segment is one cue in timeline order and may be only part of a sentence. Use the neighbouring cues for context, but output only the translation of each cue itself — never merge or split cues, and never move content earlier or later into a neighbouring cue (even when the target language's word order differs, each cue's translation must correspond to that cue's own content, because subtitles must match the picture timing). Cues stay on screen for a few seconds, so keep the translation concise and conversational, with no notes or explanations.

Subtitle-specific rule (takes precedence over any rule above about annotating the original): never append the original term in parentheses after a translated name. Person, place, organisation, and work names are output as the translated name only (glossary targets exactly as given) — never forms like "Iraq (Iraq)"; only when the glossary target itself already contains a parenthesised original should it be output as-is. Line breaks in the source may be kept or collapsed to one line depending on length.`;

// 「句末不加句號」（2026-08-22）：與 YouTube 字幕 prompt 同款要求。只對中文 target、且
// translateDoc.subtitleStripPeriod 開啟時附加（關掉就不進 prompt，也不進 cache key）；
// 模型服從度不可靠，另有 stripCueTrailingPeriod 確定性安全網在輸出端
const SUBTITLE_PROMPT_HINT_ZH_NO_PERIOD = `字幕句末不加句號：每則譯文的結尾不要加「。」（問號、驚嘆號照常保留），字幕是口語片段，句號會讓畫面看起來生硬。`;

export function subtitlePromptHint(targetLanguage, { stripPeriod = false } = {}) {
  if (!String(targetLanguage || '').startsWith('zh')) return SUBTITLE_PROMPT_HINT_EN;
  return stripPeriod ? `${SUBTITLE_PROMPT_HINT_ZH}\n\n${SUBTITLE_PROMPT_HINT_ZH_NO_PERIOD}` : SUBTITLE_PROMPT_HINT_ZH;
}

// ─── 句末句號去除（確定性後處理）───────────────────────────
// 每行行尾的「。」去掉；「。」後面只剩閉合引號 / 括號 / 佔位符標記 / 空白也算行尾
//（「他說：『走吧。』」→ 『走吧』；「你好。⟦/1⟧」→ 「你好⟦/1⟧」）。問號 / 驚嘆號 /
// 刪節號不動。只處理全形「。」：toggle 只對中文 target 生效，半形「.」在英文等
// target 有縮寫（Mr. / etc.）語意，不可一刀切。在輸出端（下載 / 預覽）套用、不改寫
// 存在 session 的譯文 → 關掉 toggle 即回到模型原始輸出
const CUE_TRAILING_PERIOD_RE = /。+(?=(?:[」』）】〕》〉\]\)"'”’]|⟦[*＊]?[/／]?[0-9０-９]+⟧|[ \t\u3000])*$)/gm;
export function stripCueTrailingPeriod(text) {
  if (typeof text !== 'string' || !text.includes('。')) return text;
  return text.replace(CUE_TRAILING_PERIOD_RE, '');
}
