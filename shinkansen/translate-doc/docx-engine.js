// docx-engine.js — Microsoft Word（.docx）翻譯引擎（2026-09-03 起）
//
// 職責：把 .docx（OOXML ZIP）解析成與 EPUB doc 同形狀的結構
//（chapters / blocks / pages），讓章節清單、全書術語表、工作階段持久化、
// 一致性掃描、翻譯 pipeline（translate.js translateDocument）原樣重用；
// 譯文寫回原 document.xml 等 part 重新打包成 .docx。
//
// 設計核心（SPEC-PRIVATE §32.x）：
//   1. 段落定位走 string-level：對每個 part 的 XML 字串做深度感知掃描收集
//      leaf <w:p> span（span 內不含巢狀 <w:p>；textbox 內層段落各自成 leaf）。
//      寫回只 splice 動過的 span——未翻段落與所有未動 zip entry 逐位元組保留，
//      冪等由「每次從原始 entries 出發」結構保證。
//   2. 段落內容走自寫 tokenizer（不走 DOMParser——避免 namespace wrapper 與
//      屬性重排，rPr / island 都取原文子字串零失真）。
//   3. 相鄰同 rPr run 合併（Word rsid 碎裂收斂）後橋接成 HTML 元素，
//      交 collectChapterBlocks 走既有 ⟦N⟧ 佔位符協定。格式往返靠
//      data-sk-rpr（指向原 rPr 子字串）；不可翻 XML 塊（圖片 / 欄位 /
//      數學 / 註腳參照等）以 island（data-sk-docx-island，serializer 頁面層
//      policy 判 atomic ⟦*N⟧）逐位元組往返。
//
// Node unit 測試邊界：本檔頂層不得碰 window / document / XMLSerializer
//（比照 doc-file-engine 的 lazy 慣例）；string-level 純函式（scanLeafParagraphSpans /
// tokenizeParagraph / mergeRunItems / composeTranslatedParagraph / spliceEdits 等）
// 直接 import 可測，parseDocxFile / buildTranslatedDocx 才需要瀏覽器環境。

import { collectChapterBlocks, getSerializerSK, EPUB_LIMITS, HAS_LETTER_RE, unzipWithLimit } from './epub-engine.js';
import { resolveBlockFragment } from './block-output.js';

export class DocxParseError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'DocxParseError';
    // 'not-docx' | 'too-large' | 'encrypted' | 'track-changes' | 'bad-zip'
    // | 'no-document' | 'empty' | 'parse' | 'aborted'
    this.code = code;
  }
}

// ─── 偵測 / preflight ─────────────────────────────────────
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function detectDocxFile(file) {
  const name = (file && file.name) || '';
  if (/\.docx$/i.test(name)) return true;
  return ((file && file.type) || '') === DOCX_MIME;
}

export function preflightDocxFile(file) {
  if (file.size > EPUB_LIMITS.hardMaxBytes) {
    return { level: 'error', code: 'too-large' };
  }
  return { level: 'ok' };
}

// 加密 docx 是 OLE CFB 容器（非 ZIP），magic D0 CF 11 E0
export function isOleContainer(bytes) {
  return bytes.length >= 4
    && bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0;
}

// 追蹤修訂偵測：含未接受修訂的文件 run 結構複雜（w:ins / w:del 包裹、
// moveFrom / moveTo 成對），v1 擋下提示使用者先在 Word 接受修訂
export function hasTrackedChanges(xml) {
  return /<w:(?:ins|del|moveFrom|moveTo)(?=[\s>])/.test(xml);
}

// ─── XML entity（w:t 文字內容用；OOXML 屬性值另走 escapeXmlAttr）──
export function decodeXmlEntities(s) {
  return s.replace(/&(?:amp|lt|gt|quot|apos|#x?[0-9A-Fa-f]+);/g, (m) => {
    switch (m) {
      case '&amp;': return '&';
      case '&lt;': return '<';
      case '&gt;': return '>';
      case '&quot;': return '"';
      case '&apos;': return "'";
      default: {
        const hex = /^&#x/i.test(m);
        const code = parseInt(m.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
    }
  });
}

export function escapeXmlText(s) {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

export function escapeXmlAttr(s) {
  return s.replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;'));
}

// ─── leaf <w:p> span 掃描 ─────────────────────────────────
// 深度感知：巢狀（textbox w:txbxContent 內的 w:p）時外層不算 leaf——
// 外層段落自身通常只有 drawing anchor（無文字），內層各自成獨立翻譯單位。
// <w:p/> 自閉合（空段落）不收。lookahead [\s>/] 排除 <w:pPr / <w:pict 等前綴撞名。
// opts.includeOuter：一併回傳含巢狀段落的外層段落（outer: true）。外層段落掛著文字方塊的錨點，
// 但本身常常也有內文（Word 把浮動文字方塊錨在最近的一般段落上；100 檔語料 43 個外層段落裡
// 6 個有自己的內文，其中幾個是文件標題）——解析端只收「自己有可翻文字」的外層段落
export function scanLeafParagraphSpans(xml, opts = {}) {
  const spans = [];
  const re = /<w:p(?=[\s>/])|<\/w:p>/g;
  const stack = []; // { start, hasChildP }
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (m[0] === '</w:p>') {
      const top = stack.pop();
      if (!top) continue; // 不平衡（理論不會發生）：忽略
      if (!top.hasChildP) {
        spans.push({ start: top.start, end: m.index + 6 /* '</w:p>'.length */ });
      } else if (opts.includeOuter) {
        spans.push({ start: top.start, end: m.index + 6, outer: true });
      }
      continue;
    }
    // open tag：找 '>'，自閉合（<w:p/>）不入 stack
    const gt = xml.indexOf('>', m.index);
    if (gt === -1) break;
    if (xml.charCodeAt(gt - 1) === 47 /* '/' */) continue; // 空段落
    for (const s of stack) s.hasChildP = true;
    stack.push({ start: m.index, hasChildP: false });
    re.lastIndex = gt + 1;
  }
  return spans;
}

// ─── 元素邊界小工具（string-level）────────────────────────
// 從 openIdx（'<' 位置）找同名元素的結束位置（含巢狀計數與自閉合）。
// 回傳 { end, selfClosing }——end 為元素整體結束後一格 offset。
export function findElementEnd(xml, openIdx, tagName) {
  const gt = xml.indexOf('>', openIdx);
  if (gt === -1) return { end: xml.length, selfClosing: true };
  if (xml.charCodeAt(gt - 1) === 47) return { end: gt + 1, selfClosing: true };
  const re = new RegExp('<' + tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[\\s>/])|</' + tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '>', 'g');
  re.lastIndex = gt + 1;
  let depth = 1;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (m[0].charCodeAt(1) === 47 /* '/' */) {
      depth--;
      if (depth === 0) return { end: m.index + m[0].length, selfClosing: false };
    } else {
      const g = xml.indexOf('>', m.index);
      if (g === -1) break;
      if (xml.charCodeAt(g - 1) !== 47) depth++;
      re.lastIndex = g + 1;
    }
  }
  return { end: xml.length, selfClosing: false };
}

// open tag 的 '<w:xxx' 之後解析 tag 名（含 prefix）
function tagNameAt(xml, idx) {
  const m = /^<([A-Za-z0-9_:.-]+)/.exec(xml.slice(idx, idx + 64));
  return m ? m[1] : null;
}

// 段首（尚無文字前）出現的 marker → lead；其後 → tail。
const MARKER_TAGS = new Set([
  'w:bookmarkStart', 'w:bookmarkEnd',
  'w:commentRangeStart', 'w:commentRangeEnd',
  'w:permStart', 'w:permEnd',
]);
// 整顆丟棄（拼字檢查標記，Word 重開會自行重建）
const DROP_TAGS = new Set(['w:proofErr']);

// ─── 段落 tokenizer ───────────────────────────────────────
// 輸入：一個 leaf <w:p> span 的完整字串。
// 輸出：{ openTag, pPrXml, items, leadMarkers, tailMarkers }
//   items 依序：{ k:'text', text, rpr } / { k:'br', rpr } /
//               { k:'island', xml } /
//               { k:'linkStart', rid, anchor } / { k:'linkEnd' }
//   rpr = 原 rPr XML 子字串（無 rPr 的 run 為 ''）；island xml 為可獨立
//   回放的完整片段（重組 run 或原元素子字串）。
// 欄位（fldChar begin→end 整串 run，含巢狀計數）合併為單一 island。
export function tokenizeParagraph(spanXml) {
  const openGt = spanXml.indexOf('>');
  const openTag = spanXml.slice(0, openGt + 1);
  const bodyEnd = spanXml.length - 6; // '</w:p>'
  const items = [];
  const leadMarkers = [];
  const tailMarkers = [];
  let pPrXml = '';
  let sawText = false;
  let fieldDepth = 0;
  let fieldBuf = '';

  let i = openGt + 1;
  while (i < bodyEnd) {
    const lt = spanXml.indexOf('<', i);
    if (lt === -1 || lt >= bodyEnd) break;
    // close tag 先判（tagNameAt 對 '</...' 回 null，必須在 null-skip 之前）
    if (spanXml.charCodeAt(lt + 1) === 47 /* '/' */) {
      if (spanXml.startsWith('</w:hyperlink>', lt)) {
        items.push({ k: 'linkEnd' });
        i = lt + '</w:hyperlink>'.length;
      } else {
        i = spanXml.indexOf('>', lt) + 1;
      }
      continue;
    }
    const tag = tagNameAt(spanXml, lt);
    if (!tag) { i = lt + 1; continue; }

    if (tag === 'w:pPr') {
      const { end } = findElementEnd(spanXml, lt, tag);
      pPrXml = spanXml.slice(lt, end);
      i = end;
      continue;
    }
    if (DROP_TAGS.has(tag)) {
      const { end } = findElementEnd(spanXml, lt, tag);
      i = end;
      continue;
    }
    if (MARKER_TAGS.has(tag)) {
      const { end } = findElementEnd(spanXml, lt, tag);
      (sawText ? tailMarkers : leadMarkers).push(spanXml.slice(lt, end));
      i = end;
      continue;
    }
    if (tag === 'w:hyperlink') {
      if (fieldDepth > 0) { // 欄位內 hyperlink 整塊已被 field island 吸收
        const { end } = findElementEnd(spanXml, lt, tag);
        fieldBuf += spanXml.slice(lt, end);
        i = end;
        continue;
      }
      const gt = spanXml.indexOf('>', lt);
      const attrs = spanXml.slice(lt, gt + 1);
      const rid = /r:id="([^"]*)"/.exec(attrs)?.[1] || '';
      const anchor = /w:anchor="([^"]*)"/.exec(attrs)?.[1] || '';
      if (spanXml.charCodeAt(gt - 1) === 47) { i = gt + 1; continue; } // 自閉合：無內容
      // 開頭 tag 的完整屬性字串原樣保留（w:tooltip / w:history / w:tgtFrame 等），
      // 寫回時整串回放；rid / anchor 仍另抽供預覽 href 與舊資料 fallback
      //（code review 2026-09-11 §3.8-13）
      const attrsXml = attrs.slice('<w:hyperlink'.length, -1).trim();
      items.push({ k: 'linkStart', rid, anchor, attrsXml });
      i = gt + 1;
      // 內部 run 由主迴圈繼續掃；碰到 </w:hyperlink> 時收尾
      continue;
    }
    if (tag === 'w:r') {
      const { end } = findElementEnd(spanXml, lt, tag);
      const runXml = spanXml.slice(lt, end);
      const parsed = parseRun(runXml);
      if (fieldDepth > 0 || parsed.fldBegin > 0) {
        // 欄位聚合：begin 起整串 run 進 buffer，end run 收斂為單一 island
        fieldDepth += parsed.fldBegin - parsed.fldEnd;
        fieldBuf += runXml;
        if (fieldDepth <= 0) {
          items.push({ k: 'island', xml: fieldBuf });
          fieldBuf = '';
          fieldDepth = 0;
        }
        i = end;
        continue;
      }
      for (const it of parsed.items) {
        if (it.k === 'text') sawText = true;
        items.push(it);
      }
      i = end;
      continue;
    }
    // 其他段落層元素（w:sdt / m:oMath / m:oMathPara / w:fldSimple /
    // w:smartTag / mc:AlternateContent…）→ island 原樣保留（安全預設：
    // 不理解的結構寧可不翻也不能弄壞）
    {
      const { end } = findElementEnd(spanXml, lt, tag);
      const xml = spanXml.slice(lt, end);
      if (fieldDepth > 0) fieldBuf += xml;
      else items.push({ k: 'island', xml });
      i = end;
    }
  }
  // 欄位未閉合（跨段落欄位——罕見但合法）：殘餘 buffer 原樣保留
  if (fieldBuf) items.push({ k: 'island', xml: fieldBuf });
  return { openTag, pPrXml, items, leadMarkers, tailMarkers };
}

// 單一 w:r → { items, fldBegin, fldEnd }
// run 內容項：w:t → text、無屬性 w:br 與 w:cr → br、其餘（w:tab / 帶屬性
// w:br（分頁）/ w:drawing / w:pict / w:object / w:sym / w:footnoteReference /
// w:endnoteReference / w:commentReference / w:noBreakHyphen…）→ island
//（重組為帶原 rPr 的獨立 run）
function parseRun(runXml) {
  const items = [];
  let fldBegin = 0;
  let fldEnd = 0;
  const openGt = runXml.indexOf('>');
  let rpr = '';
  let i = openGt + 1;
  const bodyEnd = runXml.length - 6; // '</w:r>'
  while (i < bodyEnd) {
    const lt = runXml.indexOf('<', i);
    if (lt === -1 || lt >= bodyEnd) break;
    const tag = tagNameAt(runXml, lt);
    if (!tag) { i = lt + 1; continue; }
    if (runXml.charCodeAt(lt + 1) === 47) { i = runXml.indexOf('>', lt) + 1; continue; }
    const { end, selfClosing } = findElementEnd(runXml, lt, tag);
    const frag = runXml.slice(lt, end);
    if (tag === 'w:rPr') {
      rpr = frag;
    } else if (tag === 'w:t') {
      const inner = selfClosing ? '' : frag.slice(frag.indexOf('>') + 1, frag.lastIndexOf('<'));
      items.push({ k: 'text', text: decodeXmlEntities(inner), rpr: '' });
    } else if (tag === 'w:br' || tag === 'w:cr') {
      // 無屬性換行 → br；帶屬性（w:type="page" 分頁等）→ island 原樣保留
      const hasAttrs = /<w:(?:br|cr)\s+[^>]*[^\s>]/.test(frag);
      if (tag === 'w:br' && hasAttrs) items.push({ k: 'island', xml: null, item: frag, rpr: '' });
      else items.push({ k: 'br', rpr: '' });
    } else if (tag === 'w:fldChar') {
      const type = /w:fldCharType="([^"]*)"/.exec(frag)?.[1];
      if (type === 'begin') fldBegin++;
      else if (type === 'end') fldEnd++;
      // separate / begin / end 本身不產 item——整個 run 由外層欄位聚合吸收
    } else if (tag === 'w:instrText' || tag === 'w:delText' || tag === 'w:delInstrText') {
      // 只會出現在欄位聚合內（instrText）或追蹤修訂（已擋）——防禦性忽略
    } else if (tag === 'w:lastRenderedPageBreak') {
      // 渲染快取標記，丟棄無害（Word 重排時自行重建）
    } else {
      items.push({ k: 'island', xml: null, item: frag, rpr: '' });
    }
    i = end;
  }
  // 後處理：把 rpr 回填到 text / br；island item 重組為完整 run
  for (const it of items) {
    if (it.k === 'island' && it.item != null) {
      it.xml = '<w:r>' + rpr + it.item + '</w:r>';
      delete it.item;
    } else if (it.k === 'text' || it.k === 'br') {
      it.rpr = rpr;
    }
  }
  return { items, fldBegin, fldEnd };
}

// ─── run 合併與格式判讀 ───────────────────────────────────
// 相鄰同 rpr 的 text / br 合併為 run-group（Word rsid 碎裂收斂）；
// island / link 邊界打斷合併。輸出 groups：
//   { k:'group', rpr, parts:[{t:'text',text}|{t:'br'}] } / island / linkStart / linkEnd
export function mergeRunItems(items) {
  const out = [];
  for (const it of items) {
    if (it.k === 'text' || it.k === 'br') {
      const last = out[out.length - 1];
      if (last && last.k === 'group' && last.rpr === it.rpr) {
        last.parts.push(it.k === 'text' ? { t: 'text', text: it.text } : { t: 'br' });
      } else {
        out.push({ k: 'group', rpr: it.rpr, parts: [it.k === 'text' ? { t: 'text', text: it.text } : { t: 'br' }] });
      }
    } else {
      out.push(it);
    }
  }
  return out;
}

// rPr 的語意格式判讀（HTML 橋接的 tag 選擇用；寫回一律用原 rPr 子字串，
// 判讀只影響預覽視覺與 LLM 端 slot 型態，不影響格式往返）
const offRe = (tag) => new RegExp('<w:' + tag + '\\s[^>]*w:val="(?:false|0|none)"');
function rprFlag(rpr, tag) {
  const re = new RegExp('<w:' + tag + '(?=[\\s/>])');
  if (!re.test(rpr)) return false;
  return !offRe(tag).test(rpr);
}
export function rprSemantics(rpr) {
  const vert = /<w:vertAlign\s[^>]*w:val="(superscript|subscript)"/.exec(rpr)?.[1];
  return {
    b: rprFlag(rpr, 'b'),
    i: rprFlag(rpr, 'i'),
    u: rprFlag(rpr, 'u'),
    s: rprFlag(rpr, 'strike'),
    sup: vert === 'superscript',
    sub: vert === 'subscript',
  };
}

// 段落主導 rpr（text 長度加權最大者）——裸文字寫回時的預設格式
export function dominantRpr(groups) {
  const weight = new Map();
  for (const g of groups) {
    if (g.k !== 'group') continue;
    let len = 0;
    for (const p of g.parts) if (p.t === 'text') len += p.text.length;
    weight.set(g.rpr, (weight.get(g.rpr) || 0) + len);
  }
  let best = '';
  let bestW = -1;
  for (const [rpr, w] of weight) {
    if (w > bestW) { best = rpr; bestW = w; }
  }
  return best;
}

// pStyle / outlineLvl → heading level（1-6；非標題回 0）
export function headingLevel(pPrXml) {
  const style = /<w:pStyle\s[^>]*w:val="([^"]*)"/.exec(pPrXml)?.[1] || '';
  const m = /heading\s*([1-6])/i.exec(style) || /^berschrift([1-6])$/i.exec(style);
  if (m) return parseInt(m[1], 10);
  const lvl = /<w:outlineLvl\s[^>]*w:val="([0-5])"/.exec(pPrXml)?.[1];
  if (lvl != null) return parseInt(lvl, 10) + 1;
  return 0;
}

// ─── 寫回組裝（string-level 純函式）───────────────────────
// 譯文 run 序列 XML + 原段落骨架 → 完整 <w:p>。runsXml 由瀏覽器端
// fragment walk 產出（見 buildRunsFromFragment）。
export function composeTranslatedParagraph(para, runsXml) {
  return para.openTag + para.pPrXml + para.leadMarkers.join('')
    + runsXml + para.tailMarkers.join('') + '</w:p>';
}

// 雙語模式的譯文段：pPr 剝 numPr（清單項雙語不重複編號）
export function stripNumPr(pPrXml) {
  return stripPPrChildren(pPrXml, ['w:numPr']);
}

// 雙語譯文段不能原樣複製的 pPr 子元素（code review 2026-09-11 §3.8-8）：
//   - w:numPr：清單編號會重複
//   - w:sectPr：段落層 sectPr = 「本節到此為止」；複製一份就多一個分節，
//     nextPage 型多一頁空白
//   - w:framePr：文字框定位；兩段同框會互相疊在同一位置
const DUAL_PPR_STRIP_TAGS = ['w:numPr', 'w:sectPr', 'w:framePr'];

export function stripPPrChildren(pPrXml, tags) {
  if (!pPrXml) return pPrXml;
  let out = pPrXml;
  for (const tag of tags) {
    let idx = out.indexOf('<' + tag);
    while (idx !== -1) {
      // 只認完整 tag 名（<w:numPr 不可吃到 <w:numPrX>）
      const after = out.charCodeAt(idx + tag.length + 1);
      if (after === 62 /* > */ || after === 32 /* space */ || after === 47 /* / */) {
        const { end } = findElementEnd(out, idx, tag);
        out = out.slice(0, idx) + out.slice(end);
        idx = out.indexOf('<' + tag, idx);
      } else {
        idx = out.indexOf('<' + tag, idx + 1);
      }
    }
  }
  return out;
}

// 編號掛在樣式上的段落樣式（styles.xml 的樣式定義帶 numPr、numId ≠ 0；沒有自己的 numPr 的樣式
// 沿 basedOn 繼承）。回傳 { ids: Set<styleId>, defaultNumbered }——defaultNumbered = 預設段落樣式
// 本身帶編號（沒有 pStyle 的段落適用）
export function numberedParagraphStyles(stylesXml) {
  const info = new Map();
  let defaultId = null;
  const re = /<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g;
  let m;
  while ((m = re.exec(stylesXml || '')) !== null) {
    const attrs = m[1];
    if (!/w:type="paragraph"/.test(attrs)) continue;
    const id = /w:styleId="([^"]*)"/.exec(attrs)?.[1];
    if (id == null) continue;
    if (/w:default="(?:1|true|on)"/.test(attrs)) defaultId = id;
    const numPr = /<w:numPr\b[^>]*>([\s\S]*?)<\/w:numPr>/.exec(m[2])?.[1];
    const numId = numPr != null ? (/<w:numId\s[^>]*w:val="([^"]*)"/.exec(numPr)?.[1] ?? null) : null;
    info.set(id, {
      basedOn: /<w:basedOn\s[^>]*w:val="([^"]*)"/.exec(m[2])?.[1] ?? null,
      // true / false = 樣式自己決定；null = 沿 basedOn
      own: numPr != null && numId != null ? numId !== '0' : null,
    });
  }
  const ids = new Set();
  for (const id of info.keys()) {
    let cur = id;
    const seen = new Set();
    while (cur != null && info.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const st = info.get(cur);
      if (st.own != null) { if (st.own) ids.add(id); break; }
      cur = st.basedOn;
    }
  }
  return { ids, defaultNumbered: defaultId != null && ids.has(defaultId) };
}

// pPr 子元素有固定順序，numPr 之前只能有這幾個
const PPR_BEFORE_NUMPR = ['w:pStyle', 'w:keepNext', 'w:keepLines', 'w:pageBreakBefore', 'w:framePr', 'w:widowControl'];
const NUMPR_OFF = '<w:numPr><w:numId w:val="0"/></w:numPr>';

// 在 pPr 內補「此段不編號」（numId 0）。pPrXml 為空時補一個只含它的 pPr
function addNumberingOff(pPrXml) {
  if (!pPrXml) return '<w:pPr>' + NUMPR_OFF + '</w:pPr>';
  const open = /^<w:pPr\b[^>]*>/.exec(pPrXml);
  if (!open) return pPrXml; // <w:pPr/> 自閉合等非預期形狀：不動
  let at = open[0].length;
  for (const tag of PPR_BEFORE_NUMPR) {
    let idx = pPrXml.indexOf('<' + tag, open[0].length);
    while (idx !== -1) {
      const after = pPrXml.charCodeAt(idx + tag.length + 1);
      if (after === 62 || after === 32 || after === 47) {
        const { end } = findElementEnd(pPrXml, idx, tag);
        if (end > at) at = end;
        break;
      }
      idx = pPrXml.indexOf('<' + tag, idx + 1);
    }
  }
  return pPrXml.slice(0, at) + NUMPR_OFF + pPrXml.slice(at);
}

// numbered：numberedParagraphStyles 的結果（null = 不處理樣式層編號）。原段的樣式帶編號時，
// 譯文段沿用同一個 pStyle 會再編一次號——補 numId 0 關掉（段落自己的 numPr 已在上面剝掉）
export function composeDualParagraph(para, runsXml, numbered = null) {
  let pPr = stripPPrChildren(para.pPrXml, DUAL_PPR_STRIP_TAGS);
  if (numbered) {
    const styleId = /<w:pStyle\s[^>]*w:val="([^"]*)"/.exec(para.pPrXml || '')?.[1];
    if (styleId != null ? numbered.ids.has(styleId) : numbered.defaultNumbered) pPr = addNumberingOff(pPr);
  }
  return '<w:p>' + pPr + runsXml + '</w:p>';
}

// 一個 text run 的 XML
export function buildTextRun(text, rpr) {
  return '<w:r>' + (rpr || '') + '<w:t xml:space="preserve">' + escapeXmlText(text) + '</w:t></w:r>';
}

export function buildBrRun(rpr) {
  return '<w:r>' + (rpr || '') + '<w:br/></w:r>';
}

// edits = [{start, end, replacement}]（同一 part 內不重疊）→ splice
export function spliceEdits(xml, edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const parts = [];
  let cursor = 0;
  for (const e of sorted) {
    parts.push(xml.slice(cursor, e.start), e.replacement);
    cursor = e.end;
  }
  parts.push(xml.slice(cursor));
  return parts.join('');
}

// ─── rels（hyperlink r:id → URL，預覽顯示用；寫回只需 r:id 往返）──
export function parseRels(relsXml) {
  const map = new Map();
  if (!relsXml) return map;
  const re = /<Relationship\s+[^>]*\/?>/g;
  let m;
  while ((m = re.exec(relsXml)) !== null) {
    const id = /\bId="([^"]*)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]*)"/.exec(m[0])?.[1];
    if (id && target) map.set(id, decodeXmlEntities(target));
  }
  return map;
}

// ─── serializer 頁面層 policy（island → atomic ⟦*N⟧）──────
// 比照 applyEpubSerializerPolicy：只動 translate-doc 頁自己的 __SK。
let _docxPolicyApplied = false;
function applyDocxSerializerPolicy(SK) {
  if (_docxPolicyApplied) return;
  _docxPolicyApplied = true;
  const origAtomic = SK.isAtomicPreserve;
  SK.isAtomicPreserve = function docxIsAtomicPreserve(el) {
    if (el.getAttribute && el.getAttribute('data-sk-docx-island') != null) return true;
    return origAtomic(el);
  };
  // docx run wrapper（帶 data-sk-rpr）一律成 ⟦N⟧ slot，不受通用
  // hasSubstantiveContent（要有字母 / CJK）門檻限制。
  // Why：網頁路徑用「有沒有實質文字」判 span 值不值得保留；docx 的 wrapper 卻是
  // 字元格式（字型 / 色 / 大小 / 上下標 / 螢光）往返的唯一通道——純符號 / 標點 /
  // 數字的 run（Symbol 字型字元、上標的 2、色字的 ★）沒有字母，被通用門檻擋掉後
  // wrapper 從序列化文字消失，寫回時該段文字退回段落主導 rPr，格式整個掉。
  // 實例：pandoc-unicode.docx 的 Symbol 字型字元譯後在 Word 渲染消失（2026-09-03
  // 100 檔語料 L4 驗證抓到）。純空白 run 仍不保留（字型對空白無視覺意義，避免
  // 每個粗體空格都佔一個 slot 增加 LLM 對齊噪音）。
  const origPreservable = SK.isPreservableInline;
  SK.isPreservableInline = function docxIsPreservableInline(el) {
    if (el && el.getAttribute && el.getAttribute('data-sk-rpr') != null) {
      return /\S/.test(el.textContent || '');
    }
    return origPreservable(el);
  };
}

// ─── 解析主入口（瀏覽器環境）──────────────────────────────
// part 掃描順序：body → headers/footers → footnotes/endnotes → comments。
// 各附加 part 自成章節（i18n 標題由 index.js 填，這裡回 partKind 供對映）。
function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true });
}

/**
 * @param {File} file
 * @param {(p:{stage:string,current?:number,total?:number})=>void} onProgress
 * @param {{ signal?: AbortSignal, chapterTitles?: {headers:string,notes:string,comments:string} }} opts
 *   chapterTitles：附加 part 章節的在地化標題（UI 層傳入，engine 不碰 i18n）
 * @returns {Promise<object>} 與 parseEpub 同形狀的 doc（kind='docx'）
 */
export async function parseDocxFile(file, onProgress = () => {}, opts = {}) {
  const SK = getSerializerSK();
  applyDocxSerializerPolicy(SK);
  const { signal } = opts;
  const throwIfAborted = () => {
    if (signal?.aborted) throw new DocxParseError('aborted');
  };

  onProgress({ stage: 'unzip' });
  const buf = await file.arrayBuffer();
  throwIfAborted();
  const bytes = new Uint8Array(buf);
  if (isOleContainer(bytes)) throw new DocxParseError('encrypted');
  let entries;
  try {
    entries = unzipWithLimit(bytes);
  } catch (err) {
    throw new DocxParseError('bad-zip', err && err.message);
  }
  if (!entries['word/document.xml']) throw new DocxParseError('no-document');

  const readPart = (path) => {
    const u8 = entries[path];
    if (!u8) return null;
    let text = window.fflate.strFromU8(u8);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return text;
  };

  // 受掃描 part 清單（存在才收）
  const partPaths = ['word/document.xml'];
  const names = Object.keys(entries);
  const headersFooters = names
    .filter((n) => /^word\/(?:header|footer)\d*\.xml$/.test(n))
    .sort(naturalSort);
  const notes = ['word/footnotes.xml', 'word/endnotes.xml'].filter((n) => entries[n]);
  const comments = entries['word/comments.xml'] ? ['word/comments.xml'] : [];

  const partsXml = new Map();
  for (const p of [...partPaths, ...headersFooters, ...notes, ...comments]) {
    const xml = readPart(p);
    if (xml != null) partsXml.set(p, xml);
  }

  // 追蹤修訂偵測（所有受掃描 part）
  for (const xml of partsXml.values()) {
    if (hasTrackedChanges(xml)) throw new DocxParseError('track-changes');
  }

  // rels（各 part 自己的 .rels）
  const relsFor = (path) => {
    const dir = path.slice(0, path.lastIndexOf('/'));
    const base = path.slice(path.lastIndexOf('/') + 1);
    return parseRels(readPart(`${dir}/_rels/${base}.rels`) || '');
  };

  // metadata（docProps/core.xml，可缺）
  const core = readPart('docProps/core.xml') || '';
  const coreTag = (tag) => {
    const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([^<]*)</' + tag + '>').exec(core);
    return m ? decodeXmlEntities(m[1]).trim() : '';
  };

  onProgress({ stage: 'paragraphs' });

  // 每個 part：leaf span 掃描 → tokenize → HTML 橋接
  // paras[]：寫回所需的段落骨架（span 位置 + pPr + markers + rprs / islands）
  const paras = [];
  const htmlDocFor = () => document.implementation.createHTMLDocument('docx');

  // partKind：'body' | 'headers' | 'notes' | 'comments'（章節分組用）
  const partKindOf = (path) => (
    path === 'word/document.xml' ? 'body'
      : /^word\/(?:header|footer)/.test(path) ? 'headers'
        : /^word\/(?:footnotes|endnotes)\.xml$/.test(path) ? 'notes' : 'comments');

  // footnotes/endnotes 的 separator 類型（w:footnote w:type="separator" 等）
  // 內的段落不收：找出這些容器的 span 範圍，落在其中的段落跳過
  const separatorRanges = (xml) => {
    const ranges = [];
    const re = /<w:(?:footnote|endnote)\s[^>]*w:type="(?:separator|continuationSeparator|continuationNotice)"[^>]*>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const tag = m[0].startsWith('<w:footnote') ? 'w:footnote' : 'w:endnote';
      const { end } = findElementEnd(xml, m.index, tag);
      ranges.push([m.index, end]);
    }
    return ranges;
  };

  // 跨段落欄位範圍（多段 TOC 最典型：fldChar begin 在第一段、end 在數段之後）。
  // 中間段落是欄位的快取結果：翻了會跟第一段（整段被欄位聚合吸收、維持原文）不一致
  //（TOC 第一列原文、其餘譯文），而含 dangling end 的收尾段落若被重寫，end 那顆
  // run 不產 item 會被丟掉 → 欄位結構壞掉。掃出平衡的 begin→end 範圍，凡「起點落在
  // 範圍內」的段落整段跳過（= 只可能是多段欄位的中段與尾段；單段內平衡的欄位
  // 沒有段落起點落在其中，不受影響）。未閉合的 begin 直接丟棄，不會吃掉整份文件。
  // 語意與 SPEC「TOC / PAGE 等欄位整塊原樣保留不送翻，Word 更新欄位時自行以譯後
  // 標題重算」一致。
  const crossParaFieldRanges = (xml) => {
    const re = /<w:fldChar\s[^>]*w:fldCharType="(begin|end)"/g;
    const ranges = [];
    const stack = [];
    let m;
    while ((m = re.exec(xml)) !== null) {
      if (m[1] === 'begin') stack.push(m.index);
      else if (stack.length) {
        const start = stack.pop();
        if (stack.length === 0) ranges.push([start, m.index]);
      }
    }
    return ranges;
  };

  const htmlPerPart = new Map(); // path → { htmlDoc, paraEls: [], outerDoc, outerEls: [] }

  for (const [path, xml] of partsXml) {
    throwIfAborted();
    const rels = relsFor(path);
    const skipRanges = partKindOf(path) === 'notes' ? separatorRanges(xml) : [];
    const fieldRanges = crossParaFieldRanges(xml);
    const spans = scanLeafParagraphSpans(xml, { includeOuter: true });
    const htmlDoc = htmlDocFor();
    const paraEls = [];
    // 外層段落（掛文字方塊的段落）另放一份 htmlDoc：block 編號與章節切分都不可動到既有段落
    const outerDoc = htmlDocFor();
    const outerEls = [];
    for (const span of spans) {
      if (skipRanges.some(([a, b]) => span.start >= a && span.end <= b)) continue;
      if (fieldRanges.some(([a, b]) => span.start > a && span.start < b)) continue;
      const spanXml = xml.slice(span.start, span.end);
      const tok = tokenizeParagraph(spanXml);
      const groups = mergeRunItems(tok.items);
      const para = {
        part: path,
        start: span.start,
        end: span.end,
        openTag: tok.openTag,
        pPrXml: tok.pPrXml,
        leadMarkers: tok.leadMarkers,
        tailMarkers: tok.tailMarkers,
        defaultRpr: dominantRpr(groups),
        rprs: [],
        islands: [],
        block: null,
      };
      if (span.outer) {
        // 巢狀內容（文字方塊）在 tokenizer 眼中是 island，不會被走進去；自己沒有可翻文字就不收
        para.outer = true;
        const oel = buildParagraphHtml(outerDoc, para, groups, rels, outerEls.length);
        if (!oel) continue;
        outerEls.push({ para, el: oel });
        outerDoc.body.appendChild(oel);
        paras.push(para);
        continue;
      }
      // 批次 7 §6.4：索引 = 目前已掛進 body 的 para 元素數（= paraEls.length），不再每段
      // querySelectorAll 整份 htmlDoc 數一次（O(n²)）
      const el = buildParagraphHtml(htmlDoc, para, groups, rels, paraEls.length);
      if (el) {
        paraEls.push({ para, el });
        htmlDoc.body.appendChild(el);
      }
      paras.push(para);
    }
    htmlPerPart.set(path, { htmlDoc, paraEls, outerDoc, outerEls });
  }

  onProgress({ stage: 'blocks' });

  // 章節組裝：body 依 heading 1/2 切章；headers / notes / comments 各一章
  const chapters = [];
  const newChapter = (title, partKind) => {
    const ch = {
      index: chapters.length,
      href: partKind,
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

  const filenameBase = (file.name || 'document').replace(/\.docx$/i, '');
  // collectChapterBlocks 對整個 part 的 htmlDoc 跑一次（blocks 與 paraEls
  // 同為 DOM 順序），再依 heading 分配到章節
  const partKindOrder = ['body', 'headers', 'notes', 'comments'];
  const extraChapterTitle = {
    headers: opts.chapterTitles?.headers || 'Headers & footers',
    notes: opts.chapterTitles?.notes || 'Footnotes & endnotes',
    comments: opts.chapterTitles?.comments || 'Comments',
  };

  for (const kindKey of partKindOrder) {
    let cur = null;
    // 還沒有章節可掛的外層段落 block（文件開頭就是掛文字方塊的段落）：等第一個章節出現再掛到它前面，
    // 不因此多開一章（章節序號變動會讓既有工作階段的 blockId 全部錯位）
    let pendingOuter = [];
    for (const [path, { htmlDoc, paraEls, outerDoc, outerEls }] of htmlPerPart) {
      if (partKindOf(path) !== kindKey) continue;
      const leafBlocks = collectChapterBlocks(htmlDoc, chapters.length, SK);
      // block ↔ para 連結：以 data-sk-docx-para 索引對回
      const byIdx = new Map(paraEls.map((pe, n) => [String(n), pe]));
      const linked = [];
      for (const b of leafBlocks) {
        // 段落 HTML 是扁平 <p>，不會產生容器直接文字的 fragment block（el = null），防禦性守門
        if (!b.el) continue;
        const pe = byIdx.get(b.el.getAttribute('data-sk-docx-para'));
        if (pe) linked.push({ b, pe });
      }
      if (outerEls.length > 0) {
        const outerByIdx = new Map(outerEls.map((pe, n) => [String(n), pe]));
        for (const b of collectChapterBlocks(outerDoc, chapters.length, SK)) {
          if (!b.el) continue;
          const pe = outerByIdx.get(b.el.getAttribute('data-sk-docx-para'));
          if (!pe) continue;
          b._docxOuter = true;
          linked.push({ b, pe });
        }
        // 依文件位置排（外層段落的起點在它的文字方塊內容之前）；sort 穩定，既有段落彼此順序不變
        linked.sort((x, y) => x.pe.para.start - y.pe.para.start);
      }
      for (const { b, pe } of linked) {
        pe.para.block = b;
        b.docxPara = pe.para;
        if (b._docxOuter) {
          if (cur) { cur.blocks.push(b); cur.charCount += b.plainText.length; }
          else pendingOuter.push(b);
          continue;
        }
        if (kindKey === 'body') {
          const lvl = headingLevel(pe.para.pPrXml);
          if (lvl >= 1 && lvl <= 2) {
            cur = newChapter(b.plainText.slice(0, 80), 'body');
          }
        }
        if (!cur) {
          cur = newChapter(
            kindKey === 'body' ? filenameBase : extraChapterTitle[kindKey], kindKey);
        }
        if (pendingOuter.length > 0 && cur.blocks.length === 0) {
          for (const ob of pendingOuter) { cur.blocks.push(ob); cur.charCount += ob.plainText.length; }
          pendingOuter = [];
        }
        cur.blocks.push(b);
        cur.charCount += b.plainText.length;
      }
    }
    // 整類 part 只有外層段落有字：自成一章
    if (pendingOuter.length > 0) {
      if (!cur) cur = newChapter(kindKey === 'body' ? filenameBase : extraChapterTitle[kindKey], kindKey);
      for (const ob of pendingOuter) { cur.blocks.push(ob); cur.charCount += ob.plainText.length; }
    }
  }

  const nonEmpty = chapters.filter((c) => c.blocks.length > 0);
  nonEmpty.forEach((c, i) => {
    c.index = i;
    // blockId 重編（章節歸屬決定後）。外層段落走獨立的 o 序號——b 序號與加入外層段落之前完全相同，
    // 既有工作階段（以 blockId 對回譯文）不受影響
    let bn = 0;
    let on = 0;
    c.blocks.forEach((b) => { b.blockId = b._docxOuter ? `c${i}-o${on++}` : `c${i}-b${bn++}`; });
  });
  if (nonEmpty.length === 0) throw new DocxParseError('empty');

  const totalChars = nonEmpty.reduce((acc, c) => acc + c.charCount, 0);
  return {
    kind: 'docx',
    meta: {
      filename: file.name,
      title: coreTag('dc:title') || filenameBase,
      author: coreTag('dc:creator') || '',
      language: coreTag('dc:language') || '',
      identifier: '',
      epubVersion: '',
      pageCount: nonEmpty.length,
      chapterCount: nonEmpty.length,
    },
    stats: { totalChars },
    chapters: nonEmpty,
    pages: nonEmpty.map((c) => ({ pageIndex: c.index, chapterIndex: c.index, blocks: c.blocks })),
    docxEntries: entries,
    docxPartsXml: partsXml,
    docxParas: paras,
  };
}

// 段落 → HTML 元素（heading / p）。回 null = 無可翻文字（純 island /
// 空段落），該段不進 htmlDoc、不會有 block、寫回不動。
// wrapper 規則見檔頭；rpr / island 存 para 側表，HTML 只帶索引。
function buildParagraphHtml(htmlDoc, para, groups, rels, paraIdx) {
  let hasLetter = false;
  for (const g of groups) {
    if (g.k !== 'group') continue;
    for (const p of g.parts) {
      if (p.t === 'text' && HAS_LETTER_RE.test(p.text)) { hasLetter = true; break; }
    }
    if (hasLetter) break;
  }
  if (!hasLetter) return null;

  const lvl = headingLevel(para.pPrXml);
  const el = htmlDoc.createElement(lvl >= 1 && lvl <= 6 ? `h${lvl}` : 'p');

  const rprIdx = (rpr) => {
    let idx = para.rprs.indexOf(rpr);
    if (idx === -1) { para.rprs.push(rpr); idx = para.rprs.length - 1; }
    return idx;
  };

  let container = el; // hyperlink 展開時切到 <a>
  for (const g of groups) {
    if (g.k === 'linkStart') {
      const a = htmlDoc.createElement('a');
      if (g.rid) a.setAttribute('data-sk-rid', g.rid);
      if (g.anchor) a.setAttribute('data-sk-anchor', g.anchor);
      if (g.attrsXml) a.setAttribute('data-sk-link-attrs', g.attrsXml);
      const url = g.rid && rels.get(g.rid);
      a.setAttribute('href', url || (g.anchor ? '#' + g.anchor : '#'));
      el.appendChild(a);
      container = a;
      continue;
    }
    if (g.k === 'linkEnd') {
      container = el;
      continue;
    }
    if (g.k === 'island') {
      const span = htmlDoc.createElement('span');
      span.className = 'sk-docx-island';
      para.islands.push(g.xml);
      span.setAttribute('data-sk-docx-island', String(para.islands.length - 1));
      container.appendChild(span);
      continue;
    }
    // group：格式 wrapper 決策
    let target = container;
    if (g.rpr !== para.defaultRpr) {
      const sem = rprSemantics(g.rpr);
      const chain = [];
      if (sem.b) chain.push('b');
      if (sem.i) chain.push('i');
      if (sem.u) chain.push('u');
      if (sem.s) chain.push('s');
      if (sem.sup) chain.push('sup');
      else if (sem.sub) chain.push('sub');
      if (chain.length === 0) chain.push('span');
      let outer = null;
      let inner = null;
      for (const tag of chain) {
        const e = htmlDoc.createElement(tag);
        if (tag === 'span') e.className = 'sk-docx-run';
        if (!outer) outer = e;
        else inner.appendChild(e);
        inner = e;
      }
      outer.setAttribute('data-sk-rpr', String(rprIdx(g.rpr)));
      container.appendChild(outer);
      target = inner;
    }
    for (const p of g.parts) {
      if (p.t === 'text') target.appendChild(htmlDoc.createTextNode(p.text));
      else target.appendChild(htmlDoc.createElement('br'));
    }
  }
  // para 索引 = 呼叫端傳入的「已掛進 body 的 para 數」（paraEls 順序）；未傳時退回數
  // body 內既有 para 元素（舊呼叫端）
  el.setAttribute('data-sk-docx-para', String(typeof paraIdx === 'number' ? paraIdx : countParaEls(htmlDoc)));
  return el;
}

const PRECOMPRESSED_MEDIA_RE = /\.(?:png|jpe?g|gif|webp|avif|bmp|tiff?|ico|ttf|otf|woff2?|eot|mp3|m4a|aac|ogg|oga|wav|mp4|m4v|webm|ogv|zip|jar|gz|br|pdf)$/i;  // 與 epub-writer.js 同一份判準（module 隔離鏡像）

function countParaEls(htmlDoc) {
  return htmlDoc.body.querySelectorAll('[data-sk-docx-para]').length;
}

// ─── 寫回主入口（瀏覽器環境）──────────────────────────────
// 每次從原始 entries 出發（冪等）。dedupe = computeAnnotationDedupe 的
// blockId → override map（與其他書籍式格式同語意）。
// 雙語模式只套 body part；comments / headers / notes 一律單語。
export function buildTranslatedDocx(doc, targetLanguage, { bilingual = false, dedupe = null } = {}) {
  const SK = getSerializerSK();
  const editsByPart = new Map();
  let numbered = null;
  if (bilingual) {
    const stylesU8 = doc.docxEntries && doc.docxEntries['word/styles.xml'];
    if (stylesU8) {
      try { numbered = numberedParagraphStyles(window.fflate.strFromU8(stylesU8)); } catch (_) { numbered = null; }
    }
  }
  for (const para of doc.docxParas) {
    if (para.outer) continue; // 外層段落在下面第二輪處理（要先有巢狀段落的修改）
    const b = para.block;
    if (!b || b.translationStatus !== 'done') continue;
    const frag = fragmentForBlock(SK, b, dedupe ? dedupe.get(b.blockId) : null);
    if (!frag) continue;
    const isBody = para.part === 'word/document.xml';
    const isDual = bilingual && isBody;
    const runsXml = buildRunsFromFragment(frag, para, { stripNoteAnchors: isDual });
    if (runsXml == null) continue;
    const replacement = isDual
      ? doc.docxPartsXml.get(para.part).slice(para.start, para.end) + composeDualParagraph(para, runsXml, numbered)
      : composeTranslatedParagraph(para, runsXml);
    if (!editsByPart.has(para.part)) editsByPart.set(para.part, []);
    editsByPart.get(para.part).push({ start: para.start, end: para.end, replacement });
  }

  // 第二輪：外層段落（掛文字方塊、自己也有內文）。它的修改範圍包住文字方塊內各段的修改，
  // 兩者不能各自依 offset 套用——把巢狀修改併進外層段落的替換字串，再從清單移除。
  // 由小到大處理（文字方塊內再掛文字方塊時，內層的外層段落先完成）
  const outers = doc.docxParas.filter((p) => p.outer).sort((x, y) => (x.end - x.start) - (y.end - y.start));
  for (const para of outers) {
    const b = para.block;
    if (!b || b.translationStatus !== 'done') continue;
    const frag = fragmentForBlock(SK, b, dedupe ? dedupe.get(b.blockId) : null);
    if (!frag) continue;
    const partXml = doc.docxPartsXml.get(para.part);
    const isDual = bilingual && para.part === 'word/document.xml';
    if (!editsByPart.has(para.part)) editsByPart.set(para.part, []);
    const partEdits = editsByPart.get(para.part);
    const kids = partEdits.filter((e) => e.start >= para.start && e.end <= para.end).sort((x, y) => x.start - y.start);
    let replacement;
    if (isDual) {
      // 原文段原樣保留（文字方塊內各段照自己的雙語修改），譯文段不再帶一份文字方塊（同錨點會疊在一起）
      const runsXml = buildRunsFromFragment(frag, para, { stripNoteAnchors: true, stripNestedIslands: true });
      if (runsXml == null) continue;
      const original = spliceEdits(partXml.slice(para.start, para.end),
        kids.map((e) => ({ start: e.start - para.start, end: e.end - para.start, replacement: e.replacement })));
      replacement = original + composeDualParagraph(para, runsXml, numbered);
    } else {
      // island 是重組過的字串，沒有原始 offset：巢狀段落的原文字串依文件順序在各 island 內逐一找到並換掉
      //（island 索引順序 = 文件順序，巢狀段落也依起點排序，兩邊同序所以不會對錯）
      const kidSrc = kids.map((e) => partXml.slice(e.start, e.end));
      let k = 0;
      const islandXml = para.islands.map((xml) => {
        let out = xml;
        let cursor = 0;
        while (k < kids.length) {
          const at = out.indexOf(kidSrc[k], cursor);
          if (at === -1) break;
          out = out.slice(0, at) + kids[k].replacement + out.slice(at + kidSrc[k].length);
          cursor = at + kids[k].replacement.length;
          k++;
        }
        return out;
      });
      // 有巢狀修改對不到 island（不預期）：這個外層段落不翻，巢狀修改照舊各自套用
      if (k < kids.length) continue;
      const emitted = new Set();
      let runsXml = buildRunsFromFragment(frag, para, { islandXml, emitted });
      if (runsXml == null) continue;
      // 文字方塊不可因譯文（或使用者編輯）漏掉佔位符而整個消失：沒被回放的補在段尾
      para.islands.forEach((xml, idx) => {
        if (!emitted.has(idx) && NESTED_PARA_RE.test(xml)) runsXml += islandXml[idx];
      });
      replacement = composeTranslatedParagraph(para, runsXml);
    }
    for (const e of kids) partEdits.splice(partEdits.indexOf(e), 1);
    partEdits.push({ start: para.start, end: para.end, replacement });
  }

  const outEntries = {};
  // 批次 7 §6.4：word/media（圖片）/ word/fonts 等已壓縮 entry 用 STORED（level 0），
  // 不再逐次 deflate；內容位元組不變（判準與 epub-writer isPrecompressedMediaPath 同一份）
  for (const [path, u8] of Object.entries(doc.docxEntries)) outEntries[path] = PRECOMPRESSED_MEDIA_RE.test(path) ? [u8, { level: 0 }] : u8;
  for (const [path, edits] of editsByPart) {
    const xml = doc.docxPartsXml.get(path);
    outEntries[path] = window.fflate.strToU8(spliceEdits(xml, edits));
  }
  const bytes = window.fflate.zipSync(outEntries, { level: 6 });
  return { bytes };
}

// block → 譯文 fragment：優先鏈（editedHtml → ⟦N⟧ 反序列化 → 純文字）走 block-output.js
// resolveBlockFragment（與 epub-writer / txt / 預覽同一份，2026-09-12 批次 6 收斂）
function fragmentForBlock(SK, b, override) {
  return resolveBlockFragment(SK, b, override)?.frag ?? null;
}

// fragment → OOXML run 序列。text node 取最近 data-sk-rpr 祖先的 rpr
//（無 → para.defaultRpr）；island → 原 XML 回放；<br> / \n → <w:br/>；
// <a data-sk-rid> → <w:hyperlink> 包裹。
// opts.stripNoteAnchors（雙語譯文段用）：跳過含 footnote / endnote / comment
// reference 的 island——這些是帶 id 的錨點，雙語模式原文段已保留一份，
// 譯文段再回放會產生指向同一註腳 / 註解的重複參照（Word 顯示成第二個
// 空編號錨，2026-09-03 L4 視覺驗證實測）。tab / 分頁 / 圖片等一般 island
// 照常回放（與 EPUB 雙語行為一致）。
const NOTE_ANCHOR_RE = /<w:(?:footnoteReference|endnoteReference|commentReference)(?=[\s/>])/;
// island 內含巢狀段落（文字方塊）
const NESTED_PARA_RE = /<w:p(?=[\s>])/;
// opts.islandXml：以這份陣列取代 para.islands 回放（外層段落：文字方塊內各段的譯文已併入）
// opts.stripNestedIslands：跳過內含巢狀段落的 island（雙語譯文段不重複文字方塊）
// opts.emitted：Set，記下實際回放了哪些 island 索引

export function buildRunsFromFragment(frag, para, opts = {}) {
  const out = [];
  const walk = (node, rpr, linkDepth) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3 /* TEXT_NODE */) {
        const pieces = String(child.nodeValue).split('\n');
        pieces.forEach((piece, i) => {
          if (i > 0) out.push(buildBrRun(rpr));
          if (piece) out.push(buildTextRun(piece, rpr));
        });
        continue;
      }
      if (child.nodeType !== 1 /* ELEMENT_NODE */) continue;
      const tag = child.tagName;
      if (tag === 'BR') {
        out.push(buildBrRun(rpr));
        continue;
      }
      const islandIdx = child.getAttribute && child.getAttribute('data-sk-docx-island');
      if (islandIdx != null) {
        const iIdx = parseInt(islandIdx, 10);
        const xml = (opts.islandXml || para.islands)[iIdx];
        if (xml && !(opts.stripNoteAnchors && NOTE_ANCHOR_RE.test(xml))
            && !(opts.stripNestedIslands && NESTED_PARA_RE.test(para.islands[iIdx] || ''))) {
          out.push(xml);
          if (opts.emitted) opts.emitted.add(iIdx);
        }
        continue;
      }
      const rid = child.getAttribute && child.getAttribute('data-sk-rid');
      const anchor = child.getAttribute && child.getAttribute('data-sk-anchor');
      if (tag === 'A' && (rid || anchor) && linkDepth === 0) {
        // 原 tag 屬性整串回放（tooltip 等不丟）；沒有時（舊 session 編輯過的
        // 內容 / 手動加的連結）退回只寫 r:id / w:anchor
        const attrsXml = child.getAttribute('data-sk-link-attrs');
        const fallbackAttrs = (rid ? ' r:id="' + escapeXmlAttr(rid) + '"' : '')
          + (anchor ? ' w:anchor="' + escapeXmlAttr(anchor) + '"' : '');
        out.push('<w:hyperlink' + (attrsXml ? ' ' + attrsXml : fallbackAttrs) + '>');
        walk(child, childRpr(child, rpr, para), 1);
        out.push('</w:hyperlink>');
        continue;
      }
      walk(child, childRpr(child, rpr, para), linkDepth);
    }
  };
  walk(frag, para.defaultRpr, 0);
  return out.join('');
}

function childRpr(el, inherited, para) {
  const idx = el.getAttribute && el.getAttribute('data-sk-rpr');
  if (idx == null) return inherited;
  const rpr = para.rprs[parseInt(idx, 10)];
  return rpr != null ? rpr : inherited;
}

// ─── 下載檔名 ─────────────────────────────────────────────
export function translatedDocxFilename(originalName, { bilingual = false } = {}) {
  const base = (originalName || 'document').replace(/\.docx$/i, '');
  return `${base}-shinkansen${bilingual ? '-dual' : ''}.docx`;
}

export { DOCX_MIME };
