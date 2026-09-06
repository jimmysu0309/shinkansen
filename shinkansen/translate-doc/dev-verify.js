// dev-verify.js — translate-doc 的 dev 驗證 harness hook(批次 8 G6 自 index.js 抽出)
//
// 職責:提供 window.__skVerify 物件——注入 fake translation、攔截 downloadBilingualPdf
// 的 PDF bytes 做版面結構核對、bold / link / overflow 診斷。只供 tools/
// pdf-structure-verify.js 與 test/regression/pdf-*.spec.js 使用。
//
// 為什麼獨立成 module(review G6):原本 ~500 行內嵌在 index.js handleFile 熱路徑,
// 每次解析檔案重建整包 closure,且 generateAndVerifyPdf 執行時 monkey-patch 全域
// URL.createObjectURL 與 document.body.appendChild 的 code 隨 production 出貨。
// 抽出後由 harness 端呼叫 window.__skInstallVerify() 動態 import,production
// 正常使用完全不載入本檔。
//
// deps 契約(index.js __skInstallVerify 提供,live getter 讀 module-scope state):
//   getCurrentDoc()                → currentDoc(layout doc)
//   getCurrentOriginalArrayBuffer() → currentOriginalArrayBuffer(原始 PDF bytes)
import { TRANSLATABLE_TYPES } from './block-types.js';
import { downloadBilingualPdf, buildBilingualPdf } from './pdf-renderer.js';

// 結構面診斷:純從 layout doc 推 reader / pdf-renderer 注入後的版面正確性。
// 不需要真的 render UI / 生成 PDF 就能 catch 大部分 IR 問題。供 __skVerify hook 用。
function computeStructureDiagnostics(doc) {
  const issues = [];
  const PCT_EPSILON = 0.5; // 容忍 0.5% 邊緣誤差(round 進位)
  const BBOX_OUTSIDE_TOL = 1.5; // 容忍 1.5pt 邊緣誤差
  for (const page of doc.pages) {
    const pageW = page.viewport.width;
    const pageH = page.viewport.height;
    if (!(pageW > 0 && pageH > 0)) {
      issues.push({ pageIndex: page.pageIndex, blockId: '-', code: 'invalid-page-size', detail: `${pageW}x${pageH}` });
      continue;
    }
    const seenOrders = new Set();
    for (const block of page.blocks) {
      if (!Array.isArray(block.bbox) || block.bbox.length !== 4) {
        issues.push({ pageIndex: page.pageIndex, blockId: block.blockId || '-', code: 'no-bbox', detail: '' });
        continue;
      }
      const [x0, y0, x1, y1] = block.bbox;
      if (!(x0 < x1 && y0 < y1)) {
        issues.push({ pageIndex: page.pageIndex, blockId: block.blockId, code: 'invalid-bbox', detail: `[${x0.toFixed(1)},${y0.toFixed(1)},${x1.toFixed(1)},${y1.toFixed(1)}]` });
        continue;
      }
      if (x0 < -BBOX_OUTSIDE_TOL || y0 < -BBOX_OUTSIDE_TOL || x1 > pageW + BBOX_OUTSIDE_TOL || y1 > pageH + BBOX_OUTSIDE_TOL) {
        issues.push({ pageIndex: page.pageIndex, blockId: block.blockId, code: 'bbox-outside-page', detail: `[${x0.toFixed(1)},${y0.toFixed(1)},${x1.toFixed(1)},${y1.toFixed(1)}] page=${pageW.toFixed(0)}x${pageH.toFixed(0)}` });
      }
      if (TRANSLATABLE_TYPES.has(block.type)) {
        if (!block.plainText || !block.plainText.trim()) {
          issues.push({ pageIndex: page.pageIndex, blockId: block.blockId, code: 'empty-plain-text', detail: block.type });
        }
      }
      if (typeof block.fontSize === 'number' && (block.fontSize < 0 || block.fontSize > 200)) {
        issues.push({ pageIndex: page.pageIndex, blockId: block.blockId, code: 'extreme-font-size', detail: `${block.fontSize.toFixed(1)}pt` });
      }
      // reader.js renderOverlayBlock 算的 % 必須合法
      const leftPct = (x0 / pageW) * 100;
      const topPct = (y0 / pageH) * 100;
      const widthPct = ((x1 - x0) / pageW) * 100;
      const heightPct = ((y1 - y0) / pageH) * 100;
      if (leftPct < -PCT_EPSILON || topPct < -PCT_EPSILON
          || leftPct + widthPct > 100 + PCT_EPSILON
          || topPct + heightPct > 100 + PCT_EPSILON) {
        issues.push({ pageIndex: page.pageIndex, blockId: block.blockId, code: 'overlay-pct-overflow', detail: `L=${leftPct.toFixed(1)} T=${topPct.toFixed(1)} W=${widthPct.toFixed(1)} H=${heightPct.toFixed(1)}` });
      }
      // readingOrder duplicate 檢查
      if (typeof block.readingOrder === 'number') {
        if (seenOrders.has(block.readingOrder)) {
          issues.push({ pageIndex: page.pageIndex, blockId: block.blockId, code: 'duplicate-reading-order', detail: String(block.readingOrder) });
        }
        seenOrders.add(block.readingOrder);
      }
    }
  }
  return { issueCount: issues.length, issues };
}

// ---- 決定性 CJK 偽翻譯（零 API，tools/pdf-corpus-verify.mjs L3 全量往返用）----
// 目的：讓 pdf-renderer 的 CJK 主路徑（Noto Sans TC 子集化 / 中文斷行禁則 / fit-to-box
// 縮字 / 中英混排）在不打 API 的情況下全部跑到。規則：
//   - 拉丁詞 → 由詞內容 hash 固定選字的繁中字串，長度 ≈ 0.45 倍字元數（模擬中譯縮短）
//   - 每第 5 個拉丁詞保留原樣（中英混排斷行探針）；數字 / URL / email / ⟦N⟧ 標記原樣
//   - ASCII 標點換全形；原本就是 CJK 的字元原樣
//   - 前綴「偽」讓文字層辨識；探針 block（依 block 序號）額外塞行首禁則標點與
//     罕見字 / 假名 / 簡體字 / 全形符號 / emoji（字型子集缺字 → drawText 跳過的 R9 探針）
// 同一份輸入永遠產同一份輸出，產出可 diff。
const PSEUDO_POOL = '的一是不了人我在有他這中大來上國個到說們為子和你地出道也時年得就那要下以生會自著去之過家學對可她裡後小麼心多天而能好都然沒日於起還發成事只作當想看文無開手十用主行方又如前所本見經頭面公同三已老從動兩長知民樣現分將外但身些與高意進把法此實回二理美點月明其種聲全工己話兒者向情性入定四東量真氣機重應水果體';
const PSEUDO_PUNCT = { '.': '。', ',': '，', ':': '：', ';': '；', '!': '！', '?': '？', '(': '（', ')': '）', '[': '［', ']': '］' };
// 探針字元：① 全形符號 / が 假名 / 简 簡體 / — 破折號 / 𠮷 BMP 外 / 😀 emoji（一定不在 Noto Sans TC）
const PSEUDO_PROBE_RARE = '①が简—𠮷';
const PSEUDO_PROBE_EMOJI = '😀';
function pseudoHash(str, salt) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function pseudoWord(word, salt, ratio = 0.45) {
  // 0.45：英譯中的字元數比約 0.35-0.5，CJK 每字 1em vs 拉丁 0.5em → 版面寬度比 ≈ 0.7-1.0，
  // 貼近真實譯文的 fit-to-box 行為（0.6 會讓寬度比 1.2，逼 renderer 一律往右擴框，失真）
  const len = Math.max(1, Math.round(word.length * ratio));
  let h = pseudoHash(word.toLowerCase(), salt);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += PSEUDO_POOL[h % PSEUDO_POOL.length];
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
  }
  return out;
}
export function pseudoCjkTranslate(text, blockIndex = 0, ratio = 0.45) {
  // 連續兩個以上的句點（目錄點線 / 省略號）原樣保留：換成「。」會連成三十個字寬的不可斷行塊撐出框外
  const re = /(⟦[^⟧]*⟧)|(https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.-]+|\.{2,})|([A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'’\-]*)|(\d[\d.,:%\/\-]*)|(\s+)|(.)/gsu;
  const probeForbidden = blockIndex % 7 === 3;
  const tokens = [];
  let latinIdx = 0;
  let quoteOpen = true;
  for (const m of text.matchAll(re)) {
    if (m[1]) tokens.push({ k: 'keep', v: m[1] });
    else if (m[2]) tokens.push({ k: 'keep', v: m[2] });
    else if (m[3]) {
      latinIdx++;
      if (latinIdx % 5 === 0) tokens.push({ k: 'keep', v: m[3] });
      else tokens.push({ k: 'cjk', v: pseudoWord(m[3], blockIndex, ratio) + (probeForbidden ? '，' : '') });
    } else if (m[4]) tokens.push({ k: 'keep', v: m[4] });
    else if (m[5]) tokens.push({ k: 'ws' });
    else {
      const ch = m[6];
      // 點線「. . . .」（句點間夾空白）：第二個起的句點原樣保留（keep 之間留空白，可斷行）
      const prevNonWs = [...tokens].reverse().find((t) => t.k !== 'ws');
      if (ch === '.' && prevNonWs && (prevNonWs.v === '。' || prevNonWs.v === '.')) tokens.push({ k: 'keep', v: '.' });
      else if (ch === '"') { tokens.push({ k: 'cjk', v: quoteOpen ? '「' : '」' }); quoteOpen = !quoteOpen; }
      else if (PSEUDO_PUNCT[ch]) tokens.push({ k: 'cjk', v: PSEUDO_PUNCT[ch] });
      else tokens.push({ k: ch.charCodeAt(0) < 128 ? 'keep' : 'cjk', v: ch });
    }
  }
  let out = '偽';
  let prevKeep = false;
  let pendingWs = false;
  for (const tk of tokens) {
    if (tk.k === 'ws') { pendingWs = true; continue; }
    // 空白只在「兩側都是保留的拉丁 / 數字 token」時留一個 ASCII space（中文不留空白）
    if (pendingWs && prevKeep && tk.k === 'keep') out += ' ';
    pendingWs = false;
    out += tk.v;
    prevKeep = tk.k === 'keep';
  }
  if (blockIndex % 11 === 5) out += PSEUDO_PROBE_RARE;
  if (blockIndex % 13 === 7) out += PSEUDO_PROBE_EMOJI;
  return out;
}
function injectTranslations(doc, mode, ratio = 0.45) {
  let count = 0;
  let idx = 0;
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (TRANSLATABLE_TYPES.has(block.type) && block.plainText && block.plainText.trim()) {
        block.translation = mode === 'pseudo-cjk' ? pseudoCjkTranslate(block.plainText, idx, ratio) : block.plainText;
        block.translationStatus = 'done';
        count++;
        idx++;
      }
    }
  }
  return count;
}
function bytesToBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function createVerify(deps) {
  return {
      hasDoc: () => !!deps.getCurrentDoc(),
      injectPlainTextAsTranslation: () => {
        if (!deps.getCurrentDoc()) return null;
        let count = 0;
        for (const page of deps.getCurrentDoc().pages) {
          for (const block of page.blocks) {
            if (TRANSLATABLE_TYPES.has(block.type) && block.plainText && block.plainText.trim()) {
              block.translation = block.plainText;
              block.translationStatus = 'done';
              count++;
            }
          }
        }
        return { translatableCount: count };
      },
      injectPseudoCjkTranslation: () => {
        if (!deps.getCurrentDoc()) return null;
        return { translatableCount: injectTranslations(deps.getCurrentDoc(), 'pseudo-cjk') };
      },
      // regression 用（pdf-remote-font.spec）：生成一次，只回 meta（字型來源 / 是否退回 / 大小）
      buildTranslatedPdfMeta: async () => {
        if (!deps.getCurrentDoc() || !deps.getCurrentOriginalArrayBuffer()) return null;
        const r = await buildBilingualPdf(deps.getCurrentOriginalArrayBuffer(), deps.getCurrentDoc(), {});
        return { fontSource: r.fontSource, fontFallback: r.fontFallback, bytes: r.byteLength };
      },
      // regression 用:直接回傳譯文 PDF bytes(Array)。spec 端拿去用 PDF.js
      // render 驗 pixel(例:mask 不可蓋掉 block 間的圖片 / 向量圖形)
      buildTranslatedPdfBytes: async () => {
        if (!deps.getCurrentDoc() || !deps.getCurrentOriginalArrayBuffer()) return null;
        const { bytes } = await buildBilingualPdf(deps.getCurrentOriginalArrayBuffer(), deps.getCurrentDoc(), {});
        return Array.from(bytes);
      },
      generateAndVerifyPdf: async () => {
        if (!deps.getCurrentDoc() || !deps.getCurrentOriginalArrayBuffer()) return null;
        let capturedBytes = null;
        const origCreateObjectURL = URL.createObjectURL;
        const origAppendChild = document.body.appendChild.bind(document.body);
        URL.createObjectURL = function (blob) {
          if (blob && typeof blob.arrayBuffer === 'function') {
            blob.arrayBuffer().then((buf) => { capturedBytes = new Uint8Array(buf); });
          }
          return 'blob:verify-stub';
        };
        document.body.appendChild = function (el) {
          if (el && el.tagName === 'A' && el.download) el.click = () => {};
          return origAppendChild(el);
        };
        let result = null;
        let error = null;
        const t0 = performance.now();
        try {
          result = await downloadBilingualPdf(deps.getCurrentOriginalArrayBuffer(), deps.getCurrentDoc(), {});
          for (let i = 0; i < 200 && !capturedBytes; i++) {
            await new Promise((r) => setTimeout(r, 20));
          }
        } catch (err) {
          error = (err && err.message) || String(err);
        } finally {
          URL.createObjectURL = origCreateObjectURL;
          document.body.appendChild = origAppendChild;
        }
        const elapsedMs = Math.round(performance.now() - t0);
        if (!result || !capturedBytes) {
          return { ok: false, error: error || 'no-bytes-captured', elapsedMs };
        }
        // 重 parse 驗證頁數 + 文字 run 數量
        const pdfjsLib = await import('../lib/vendor/pdfjs/pdf.min.mjs');
        let reparsed = null;
        let reparseError = null;
        try {
          const loadingTask = pdfjsLib.getDocument({ data: capturedBytes.slice(0).buffer, disableFontFace: false });
          const pdfDoc = await loadingTask.promise;
          const pageDiagnostics = [];
          for (let i = 0; i < pdfDoc.numPages; i++) {
            const page = await pdfDoc.getPage(i + 1);
            const tc = await page.getTextContent();
            const viewport = page.getViewport({ scale: 1 });
            pageDiagnostics.push({
              pageIndex: i,
              width: Math.round(viewport.width),
              height: Math.round(viewport.height),
              runCount: tc.items.length,
            });
          }
          reparsed = { numPages: pdfDoc.numPages, pages: pageDiagnostics };
          await pdfDoc.destroy();
        } catch (err) {
          reparseError = (err && err.message) || String(err);
        }
        return {
          ok: true,
          error: null,
          byteLength: result.byteLength,
          captured: capturedBytes.byteLength,
          elapsedMs,
          reparsed,
          reparseError,
        };
      },
      computeStructureDiagnostics: () => {
        if (!deps.getCurrentDoc()) return null;
        return computeStructureDiagnostics(deps.getCurrentDoc());
      },
      // 加強版核對:自包跑「原 PDF ground truth + 注入英文當譯文 + 攔截
      // generated PDF + 譯文 PDF 重 parse + 三項比對」一條龍。
      // 給 tools/pdf-structure-verify.js 用,production 不會 trigger。
      // 三項驗證:
      //   1. bold preservation:原 PDF 內 bold textRun 多數佔比 ≥ 0.5 的 block
      //      在譯文 PDF 對應 bbox 區域的 textRun 是否仍 bold
      //      (目前 pdf-renderer 只 embed Noto Sans TC Regular,預期譯文 overlay
      //      textRun 都不 bold;只有底層 form XObject 帶的原文 textRun 可能 bold)
      //   2. link preservation:原 PDF page.getAnnotations() 的 Link annotation
      //      (rect + url)在譯文 PDF 是否仍存在
      //      (目前 pdf-renderer 完全沒處理 annotations,預期全消失)
      //   3. translation overflow:對每個 translatable block 模擬 pdf-renderer
      //      的 wrapTextToWidth + lineHeight,看英文當譯文時 requiredHeight
      //      是否 > blockH(中文塞不下英文 bbox 的延伸風險)
      // opts.mode：'plain'（預設，英文原文當譯文）/ 'pseudo-cjk'（決定性 CJK 偽翻譯，見
      // pseudoCjkTranslate）；opts.keepBytes：回傳 generated PDF 的 base64（corpus harness
      // 存 translated.pdf 給 L4 像素比對用）
      runEnhancedVerify: async (opts = {}) => {
        if (!deps.getCurrentDoc() || !deps.getCurrentOriginalArrayBuffer()) return null;
        const mode = opts.mode === 'pseudo-cjk' ? 'pseudo-cjk' : 'plain';
        const pdfjs = await import('../lib/vendor/pdfjs/pdf.min.mjs');

        // ---- helper:對 ArrayBuffer 跑 PDF.js,抽 ground truth ----
        async function analyzePdfBytes(ab) {
          const task = pdfjs.getDocument({ data: ab.slice(0), disableFontFace: false });
          const pdfDoc = await task.promise;
          const pages = [];
          for (let i = 0; i < pdfDoc.numPages; i++) {
            const page = await pdfDoc.getPage(i + 1);
            const viewport = page.getViewport({ scale: 1 });
            const annotations = await page.getAnnotations();
            const links = annotations
              .filter((a) => a.subtype === 'Link')
              .map((a) => ({ rect: a.rect, url: a.url || a.unsafeUrl || null, dest: a.dest || null }));
            // getOperatorList 觸發 worker font load,後續 commonObjs.get 才有資料
            await page.getOperatorList();
            const tc = await page.getTextContent();
            const styles = tc.styles || {};
            const fontsByName = {};
            for (const fn of Object.keys(styles)) {
              try {
                const font = await new Promise((resolve) => {
                  page.commonObjs.get(fn, (obj) => resolve(obj));
                });
                if (font) {
                  const name = font.name || '';
                  // .bold 有時直接帶,有時要 regex name(subset 過的字型常無 .bold 屬性)
                  const isBold = font.bold === true || /Bold|Black|Heavy|Demi|Semi/i.test(name);
                  fontsByName[fn] = { name, isBold };
                }
              } catch { /* 字型 cache 沒命中,fallback 空 */ }
            }
            // 把 textContent items 套 viewport.transform 變 canvas 座標
            const items = tc.items.filter((it) => typeof it.str === 'string' && it.str.trim().length > 0).map((it) => {
              // 套 viewport.transform × item.transform → canvas 座標(同 pdf-engine.js 邏輯)
              const m = pdfjs.Util.transform(viewport.transform, it.transform);
              const fontSize = Math.hypot(m[2], m[3]);
              const left = m[4];
              const baselineY = m[5];
              const top = baselineY - fontSize;
              const right = left + (it.width || 0);
              const bottom = baselineY;
              const fmeta = fontsByName[it.fontName];
              return {
                str: it.str,
                fontName: it.fontName,
                bbox: [left, top, right, bottom],
                fontSize,
                isBold: !!(fmeta && fmeta.isBold),
                fontRealName: fmeta ? fmeta.name : '',
              };
            });
            pages.push({
              pageIndex: i,
              viewport: { width: viewport.width, height: viewport.height },
              links,
              fontsByName,
              items,
            });
          }
          await pdfDoc.destroy();
          return { numPages: pdfDoc.numPages, pages };
        }

        // ---- helper:對單一 block,從 ground truth items 抽出落在 bbox 內的
        // textRuns,算 bold 比例。fontFilter 可指定「只看哪一層 textRun」——
        // 用於 generated PDF 區分「overlay 層譯文(NotoSansTC)」vs「底層 form
        // XObject 殘留的原 PDF 字(被白底蓋但 PDF.js 仍抽得到)」----
        function blockBoldRatio(block, gtPage, fontFilter) {
          const [bx0, by0, bx1, by1] = block.bbox;
          let boldChars = 0;
          let totalChars = 0;
          for (const it of gtPage.items) {
            if (fontFilter && !fontFilter(it)) continue;
            const [ix0, iy0, ix1, iy1] = it.bbox;
            // 中心點 in block bbox(寬鬆判定,避免 baseline 邊界誤差)
            const cx = (ix0 + ix1) / 2;
            const cy = (iy0 + iy1) / 2;
            if (cx >= bx0 && cx <= bx1 && cy >= by0 && cy <= by1) {
              const n = it.str.length;
              totalChars += n;
              if (it.isBold) boldChars += n;
            }
          }
          return { boldChars, totalChars, ratio: totalChars > 0 ? boldChars / totalChars : 0 };
        }
        // 區分譯文 overlay 層 vs 底層 form XObject:overlay 層走 pdf-lib embedFont
        // 出來的字型,fontRealName 通常是 NotoSansTC / Noto Sans TC 變體
        const isOverlayFont = (it) => /Noto|NotoSansTC/i.test(it.fontRealName || '');

        // ---- helper:模擬 pdf-renderer.js 的 overflow check ----
        // 分兩條路徑:
        //   (a) english:用 plainText 估(英文當譯文,測 baseline pipeline)
        //   (b) cjk-est:把 plainText 模擬成中文(英文 word count × 1.2 ≈ CJK 字數,
        //       每字寬 = fontSize)估真實中文翻譯後可能的 height
        // 任一條超過 blockH + tolerance 都 flag overflow。
        // 另外 flag「heading bbox 太緊」風險:blockH < fontSize_translation × 1.4
        // 即使 1 行也容易 ascender 截斷(對應 Jimmy 截圖「標題上半截被切」)
        function computeOverflowFor(block) {
          if (!TRANSLATABLE_TYPES.has(block.type)) return null;
          const txt = block.plainText || '';
          if (!txt.trim()) return null;
          const [x0, y0, x1, y1] = block.bbox;
          const blockW = x1 - x0;
          const blockH = y1 - y0;
          if (blockW <= 0 || blockH <= 0) return null;
          // 同 pdf-renderer.js 公式
          const fontSize = Math.max(7, block.fontSize * 0.9);
          const lineHeight = fontSize * 1.3;

          // ---- (a) english 估算 ----
          const englishCharWidth = (ch) => {
            const cp = ch.codePointAt(0);
            const isCJK = (cp >= 0x3000 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0xFF00 && cp <= 0xFFEF);
            const isWS = /\s/.test(ch);
            if (isCJK) return fontSize * 1.0;
            if (isWS) return fontSize * 0.3;
            return fontSize * 0.5;
          };
          let englishLines = 1;
          let lineW = 0;
          for (const ch of txt) {
            const w = englishCharWidth(ch);
            if (lineW + w > blockW && lineW > 0) { englishLines++; lineW = w; }
            else lineW += w;
          }
          const englishHeight = fontSize + (englishLines - 1) * lineHeight;

          // ---- (b) CJK 估算(英文 chars 估翻成中文字符數)----
          // 經驗值:英文每 1.5 chars ≈ 1 中文字,中文字寬 = fontSize
          const cjkChars = Math.max(2, Math.ceil(txt.replace(/\s+/g, '').length / 2));
          const cjkCharsPerLine = Math.max(1, Math.floor(blockW / fontSize));
          const cjkLines = Math.ceil(cjkChars / cjkCharsPerLine);
          const cjkHeight = fontSize + (cjkLines - 1) * lineHeight;

          // ---- (c) heading 緊湊風險:bbox 高度連 1 行 fontSize × 1.15 都不到 ----
          // 中文 (Noto Sans TC) ascent ≈ 0.88,加 descent / line-leading 後安全
          // 邊界 ~ 1.15 × fontSize。bbox 高度低於此值 → 字頂可能跑出白底,視覺
          // 上像被截斷(對應 Jimmy 截圖「標題上半截被切」風險)
          const minSafeHeight = fontSize * 1.15;
          const isTightHeight = blockH < minSafeHeight;

          const englishOverflow = englishHeight - blockH;
          const cjkOverflow = cjkHeight - blockH;
          const TOLERANCE = 1; // 1pt 容忍

          // 最終 isOverflow 取三條任一觸發
          const isOverflow = englishOverflow > TOLERANCE || cjkOverflow > TOLERANCE || isTightHeight;
          return {
            blockId: block.blockId,
            type: block.type,
            blockW: Math.round(blockW),
            blockH: Math.round(blockH * 10) / 10,
            fontSize: Math.round(fontSize * 10) / 10,
            englishLines,
            englishHeight: Math.round(englishHeight * 10) / 10,
            cjkLines,
            cjkHeight: Math.round(cjkHeight * 10) / 10,
            englishOverflow: Math.round(englishOverflow * 10) / 10,
            cjkOverflow: Math.round(cjkOverflow * 10) / 10,
            isTightHeight,
            isOverflow,
            // worstOverflow 用於排序 — 取三項中最大的差距
            worstDelta: Math.round(Math.max(englishOverflow, cjkOverflow, isTightHeight ? minSafeHeight - blockH : 0) * 10) / 10,
          };
        }

        // ---- 1. 對原 PDF 跑 ground truth ----
        const gt = await analyzePdfBytes(deps.getCurrentOriginalArrayBuffer());

        // ---- 2. 對每 block 算 bold 比例 + overflow ----
        const blockAnalysis = [];
        for (const page of deps.getCurrentDoc().pages) {
          const gtPage = gt.pages[page.pageIndex];
          if (!gtPage) continue;
          for (const block of page.blocks) {
            const boldR = blockBoldRatio(block, gtPage);
            const overflowR = computeOverflowFor(block);
            blockAnalysis.push({
              pageIndex: page.pageIndex,
              blockId: block.blockId,
              type: block.type,
              fontSize: Math.round(block.fontSize * 10) / 10,
              originalBoldRatio: Math.round(boldR.ratio * 100) / 100,
              isOriginalBold: boldR.ratio >= 0.5,
              boldChars: boldR.boldChars,
              totalCharsInBlock: boldR.totalChars,
              overflow: overflowR,
            });
          }
        }

        // ---- 3. 注入 fake translation（plain = plainText；pseudo-cjk = 決定性偽翻譯）----
        // opts.pseudoRatio：偽翻譯字元長度比（預設 0.45 ≈ 真實中譯；fixture 可拉高逼出塞不下的截斷路徑）
        const translatableCount = injectTranslations(deps.getCurrentDoc(), mode, typeof opts.pseudoRatio === 'number' ? opts.pseudoRatio : 0.45);

        // ---- 4. 攔截 generated PDF bytes ----
        let capturedBytes = null;
        const origCreateObjectURL = URL.createObjectURL;
        const origAppendChild = document.body.appendChild.bind(document.body);
        URL.createObjectURL = function (blob) {
          if (blob && typeof blob.arrayBuffer === 'function') {
            blob.arrayBuffer().then((buf) => { capturedBytes = new Uint8Array(buf); });
          }
          return 'blob:enhanced-verify-stub';
        };
        document.body.appendChild = function (el) {
          if (el && el.tagName === 'A' && el.download) el.click = () => {};
          return origAppendChild(el);
        };
        let generatedByteLength = 0;
        let generateError = null;
        let fontFallback = false;
        let fontSource = null;
        try {
          const r = await downloadBilingualPdf(deps.getCurrentOriginalArrayBuffer(), deps.getCurrentDoc(), {});
          generatedByteLength = r.byteLength;
          fontFallback = !!r.fontFallback;
          fontSource = r.fontSource || null;
          for (let i = 0; i < 200 && !capturedBytes; i++) await new Promise((resolve) => setTimeout(resolve, 20));
        } catch (err) {
          generateError = (err && err.message) || String(err);
        } finally {
          URL.createObjectURL = origCreateObjectURL;
          document.body.appendChild = origAppendChild;
        }
        if (!capturedBytes) {
          return {
            ok: false,
            error: generateError || 'no-bytes-captured',
            translatableCount,
            blockAnalysis,
            originalLinks: gt.pages.map((p) => p.links).flat(),
          };
        }

        // ---- 5. 對 generated PDF 跑同樣分析 ----
        const gen = await analyzePdfBytes(capturedBytes.buffer);

        // ---- 6. Bold preservation 比對 ----
        // 在 generated PDF 對應 bbox 內,**只看 overlay 譯文層**(過濾 NotoSans
        // 字型);底層 form XObject 的原 bold 字雖被 PDF.js 抽得到但被白底
        // 視覺蓋掉,使用者實際看不到所以不算 preserved
        const boldOrig = blockAnalysis.filter((b) => b.isOriginalBold);
        const boldLost = [];
        for (const ba of boldOrig) {
          const layoutBlock = deps.getCurrentDoc().pages[ba.pageIndex].blocks.find((b) => b.blockId === ba.blockId);
          if (!layoutBlock) continue;
          const genPage = gen.pages[ba.pageIndex];
          if (!genPage) continue;
          // overlay 層該 bbox 內的 textRun 是否 bold
          const overlayRatio = blockBoldRatio(layoutBlock, genPage, isOverlayFont);
          // 若 overlay 層在這 bbox 完全沒蓋(沒 textRun),代表沒 inject 譯文 →
          // 原文 visible,bold preserved
          // 若有蓋但 not bold → 原文被遮,使用者看到的是不 bold 的譯文 → bold lost
          if (overlayRatio.totalChars > 0 && overlayRatio.ratio < 0.5) {
            boldLost.push({
              pageIndex: ba.pageIndex,
              blockId: ba.blockId,
              type: ba.type,
              fontSize: ba.fontSize,
              originalBoldRatio: ba.originalBoldRatio,
              overlayBoldRatio: Math.round(overlayRatio.ratio * 100) / 100,
              overlayChars: overlayRatio.totalChars,
              plainTextPreview: (layoutBlock.plainText || '').slice(0, 60),
            });
          }
        }

        // ---- 7. Link preservation 比對 ----
        // rect 過濾:譯文 PDF 對應 page 內找有沒有同 url 同近似 rect 的 link
        const RECT_TOL = 5; // pt
        const linkOrig = [];
        const linkLost = [];
        for (let i = 0; i < gt.pages.length; i++) {
          const gtLinks = gt.pages[i].links || [];
          const genLinks = (gen.pages[i] && gen.pages[i].links) || [];
          for (const L of gtLinks) {
            linkOrig.push({ pageIndex: i, ...L });
            const found = genLinks.find((G) => {
              if (G.url !== L.url) return false;
              const r1 = L.rect, r2 = G.rect;
              return Math.abs(r1[0] - r2[0]) <= RECT_TOL && Math.abs(r1[1] - r2[1]) <= RECT_TOL
                && Math.abs(r1[2] - r2[2]) <= RECT_TOL && Math.abs(r1[3] - r2[3]) <= RECT_TOL;
            });
            if (!found) linkLost.push({ pageIndex: i, ...L });
          }
        }

        // ---- 8. Overflow 統整 ----
        const overflowList = blockAnalysis.filter((b) => b.overflow && b.overflow.isOverflow);

        // ---- 8b. Actual overflow:overlay textRun bottom 是否撞到下個 block ----
        // 比對基準從「原 block.bbox.y1」改為「下個阻擋 block 的 y0」(等同
        // pdf-renderer fit-to-box 擴展上限)。原因:fit-to-box 會擴 box 往下擴
        // 到 max bottom space,字跑到那邊不是 overflow,撞到下個 block 才是
        function maxAllowedBottomY(block, page) {
          const [cx0, , cx1, cy1] = block.bbox;
          const pageH = page.viewport.height;
          let minBlockerY0 = pageH;
          for (const b of page.blocks) {
            if (b === block) continue;
            if (!Array.isArray(b.bbox) || b.bbox.length !== 4) continue;
            const [bx0, by0, bx1] = b.bbox;
            if (by0 <= cy1) continue;
            if (bx0 >= cx1 || bx1 <= cx0) continue;
            if (by0 < minBlockerY0) minBlockerY0 = by0;
          }
          // 等同 pdf-renderer 的 getMaxBottomY 邏輯,留 2pt buffer
          return Math.max(cy1, minBlockerY0 - 2);
        }
        const actualOverflowList = [];
        for (const ba of blockAnalysis) {
          if (!TRANSLATABLE_TYPES.has(ba.type)) continue;
          const layoutBlock = deps.getCurrentDoc().pages[ba.pageIndex].blocks.find((b) => b.blockId === ba.blockId);
          if (!layoutBlock) continue;
          const layoutPage = deps.getCurrentDoc().pages[ba.pageIndex];
          const genPage = gen.pages[ba.pageIndex];
          if (!genPage) continue;
          const [bx0, by0, bx1, by1] = layoutBlock.bbox;
          const allowedBottom = maxAllowedBottomY(layoutBlock, layoutPage);
          // 只看 overlay 譯文層(NotoSans)的 textRun
          let maxBottom = -Infinity;
          let overlayCharsInBlock = 0;
          for (const it of genPage.items) {
            if (!isOverlayFont(it)) continue;
            const [ix0, iy0, ix1, iy1] = it.bbox;
            const cx = (ix0 + ix1) / 2;
            const cy = (iy0 + iy1) / 2;
            // 寬鬆判定:中心 x 在 block 寬內 + 中心 y 在「允許擴展上限」內
            if (cx >= bx0 && cx <= bx1 && cy >= by0 - 1 && cy <= allowedBottom + 1) {
              overlayCharsInBlock += it.str.length;
              if (iy1 > maxBottom) maxBottom = iy1;
            }
          }
          if (overlayCharsInBlock === 0) continue;
          const actualOverflow = maxBottom - allowedBottom;
          if (actualOverflow > 1) {
            actualOverflowList.push({
              pageIndex: ba.pageIndex,
              blockId: ba.blockId,
              type: ba.type,
              fontSize: ba.fontSize,
              blockH: Math.round((by1 - by0) * 10) / 10,
              allowedBottom: Math.round(allowedBottom * 10) / 10,
              maxBottom: Math.round(maxBottom * 10) / 10,
              actualOverflow: Math.round(actualOverflow * 10) / 10,
              overlayChars: overlayCharsInBlock,
            });
          }
        }

        // ---- 8c. 譯文文字層多重集比對（只看 overlay 層 Noto 字型 items）----
        // 每個已翻 block：expected = translation 去空白的字元多重集；found = 落在
        // 「bbox 起點 ~ 允許擴展底」區域內 overlay items 的字元多重集。missing =
        // expected − found（逐字元計數）。三種病型都會現形：(1) 字型缺字 → 該字元
        // 以 .notdef 畫出，PDF.js 抽不到（tofu）；(2) fit-to-box 縮到底仍塞不下，
        // drawText loop 截掉尾行（missing 集中在尾端 → truncated）；(3) 整塊沒畫。
        // 用 PDF.js 而非 pdftotext：後者會把底層原文 XObject 與 overlay 同行交錯輸出
        const textLayer = { checked: 0, missingBlocks: 0, missingChars: 0, truncatedBlocks: 0, ellipsisBlocks: 0, missingCharCounts: {}, samples: [], blocks: [] };
        // 擴右上限：overlay item 右緣超過該頁內容右緣（所有 block 最右 x1）+ 20pt 的數量。容忍約兩個字寬：
        // 行首禁則把標點搬回上一行末、原子 token 超寬時，單行可合法超出框寬一個字，那不是擴框到頁緣
        let rightOverflowItems = 0;
        const rightOverflowSamples = [];
        for (const page of deps.getCurrentDoc().pages) {
          const genPage = gen.pages[page.pageIndex];
          if (!genPage || page.blocks.length === 0) continue;
          const contentRight = Math.max(...page.blocks.filter((b) => Array.isArray(b.bbox)).map((b) => b.bbox[2]));
          for (const it of genPage.items) {
            if (isOverlayFont(it) && it.bbox[2] > contentRight + 20) {
              rightOverflowItems++;
              if (rightOverflowSamples.length < 5) rightOverflowSamples.push({ pageIndex: page.pageIndex, str: it.str.slice(0, 40), right: Math.round(it.bbox[2]), contentRight: Math.round(contentRight), left: Math.round(it.bbox[0]) });
            }
          }
        }
        textLayer.rightOverflowItems = rightOverflowItems;
        textLayer.rightOverflowSamples = rightOverflowSamples;
        for (const page of deps.getCurrentDoc().pages) {
          const genPage = gen.pages[page.pageIndex];
          if (!genPage) continue;
          const pageW = page.viewport.width;
          for (const block of page.blocks) {
            if (!TRANSLATABLE_TYPES.has(block.type) || !block.translation || block.translationStatus !== 'done') continue;
            // NFKC：康熙部首（U+2F00–）/ 相容表意字與統一表意字共用字形，subset 字型的 ToUnicode
            // 只能指回其中一個碼位（PDF.js 抽原檔 CJK 時也常回部首碼位），比對前雙方都正規化
            // NFKC 會把「…」拆成三個 ASCII 句點，先換成私用區佔位再正規化，截斷標示才認得出來
            const normText = (str) => str.replace(/\s+/g, '').replace(/…/g, '\uE000').normalize('NFKC');
            const expected = normText(block.translation);
            if (!expected) continue;
            textLayer.checked++;
            const [bx0, by0] = block.bbox;
            const allowedBottom = maxAllowedBottomY(block, page);
            const need = new Map();
            for (const ch of expected) need.set(ch, (need.get(ch) || 0) + 1);
            let extraEllipsis = 0;
            for (const it of genPage.items) {
              if (!isOverlayFont(it)) continue;
              const [ix0, iy0] = it.bbox;
              if (ix0 < bx0 - 3 || ix0 > pageW || iy0 < by0 - 3 || iy0 > allowedBottom + 3) continue;
              for (const ch of normText(it.str)) {
                const n = need.get(ch);
                if (n) need.set(ch, n - 1);
                else if (ch === '\uE000') extraEllipsis++;
              }
            }
            // renderer 塞不下時末行補「…」（其餘行隱形補齊）：expected 沒有的「…」= 截斷標示
            if (extraEllipsis > 0) textLayer.ellipsisBlocks++;
            let missing = 0;
            let missingStr = '';
            for (const [ch, n] of need) {
              if (n > 0) { missing += n; missingStr += ch.repeat(n); textLayer.missingCharCounts[ch] = (textLayer.missingCharCounts[ch] || 0) + n; }
            }
            if (missing > 0) {
              // 給 harness 端依字型 cmap 分流（tofu vs 真的沒畫到）後再判截斷用
              textLayer.blocks.push({ pageIndex: page.pageIndex, blockId: block.blockId, type: block.type, expectedLen: expected.length, missing: missingStr, tail: expected.slice(-60) });
              textLayer.missingBlocks++;
              textLayer.missingChars += missing;
              // 尾端截斷判定：expected 最後 missing 個字元裡多數在 need 殘餘集合內
              const tail = expected.slice(-Math.min(missing, expected.length));
              let tailHit = 0;
              const rest = new Map(need);
              for (const ch of tail) { const n = rest.get(ch); if (n > 0) { tailHit++; rest.set(ch, n - 1); } }
              const truncated = missing >= 4 && tailHit / tail.length > 0.8;
              if (truncated) textLayer.truncatedBlocks++;
              if (textLayer.samples.length < 8) {
                textLayer.samples.push({ pageIndex: page.pageIndex, blockId: block.blockId, type: block.type, expectedLen: expected.length, missing, truncated, preview: expected.slice(0, 40) });
              }
            }
          }
        }

        return {
          ok: true,
          mode,
          bytesBase64: opts.keepBytes ? bytesToBase64(capturedBytes) : null,
          fontFallback,
          fontSource,
          textLayer,
          generatedByteLength,
          translatableCount,
          totalBlocks: blockAnalysis.length,
          bold: {
            totalBoldBlocks: boldOrig.length,
            preservedCount: boldOrig.length - boldLost.length,
            lostCount: boldLost.length,
            lostBlocks: boldLost.slice(0, 30),
          },
          links: {
            totalLinks: linkOrig.length,
            preservedCount: linkOrig.length - linkLost.length,
            lostCount: linkLost.length,
            lostLinks: linkLost.slice(0, 30),
          },
          overflow: {
            totalChecked: blockAnalysis.filter((b) => b.overflow).length,
            // 靜態 risk:從 layout block 結構推得「若不縮字會 overflow」的 block
            riskCount: overflowList.length,
            englishOverflowCount: overflowList.filter((b) => b.overflow.englishOverflow > 1).length,
            cjkOverflowCount: overflowList.filter((b) => b.overflow.cjkOverflow > 1).length,
            tightHeightCount: overflowList.filter((b) => b.overflow.isTightHeight).length,
            worstRisk: overflowList.slice().sort((a, b) => b.overflow.worstDelta - a.overflow.worstDelta).slice(0, 15)
              .map((b) => ({ pageIndex: b.pageIndex, blockId: b.blockId, type: b.type, ...b.overflow })),
            // 實際 render 後 overlay textRun 真的超出 block bbox 的 block 數
            // (fit-to-box 縮字若有效 → 應為 0)
            actualOverflowCount: actualOverflowList.length,
            actualOverflowSamples: actualOverflowList.slice().sort((a, b) => b.actualOverflow - a.actualOverflow).slice(0, 15),
          },
        };
      },
    };
}
