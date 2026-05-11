// index.js — translate-doc 頁面主協調層
//
// W2-iter1：上傳 → parsePdf → analyzeLayout → 顯示版面 IR 摘要 + 提供 debug overlay 預覽
// (SVG 疊在 PDF.js canvas 上，可肉眼驗 block 切分是否合理)。
// 完整翻譯 / 閱讀器 / 下載走後續週次。

import { parsePdf, preflightFile, renderPageToCanvas, closeDocument, PdfParseError } from './pdf-engine.js';
import { analyzeLayout } from './layout-analyzer.js';
import { translateDocument, segmentsToMarkdown, markdownToSegments } from './translate.js';
import { renderReader, buildPlainTextDump } from './reader.js';
import { downloadBilingualPdf } from './pdf-renderer.js';
import { formatMoney } from '../lib/format.js';
import { getCachedRate, FALLBACK_USD_TWD_RATE } from '../lib/exchange-rate.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEBUG_RENDER_SCALE = 1.5;

const $ = (id) => document.getElementById(id);

// i18n shortcut。lib/i18n.js 由 index.html `<script src>` 載入,attach 到
// window.__SK.i18n。fallback:i18n 還沒載入時回傳 fallback 字串(避免 init race)。
const t = (key, params, fallback) => {
  const i18n = window.__SK?.i18n;
  if (i18n && typeof i18n.t === 'function') return i18n.t(key, params);
  return fallback != null ? fallback : key;
};

const stages = {
  upload: $('stage-upload'),
  parsing: $('stage-parsing'),
  result: $('stage-result'),
  translating: $('stage-translating'),
  reader: $('stage-reader'),
  edit: $('stage-edit'),
  glossary: $('stage-glossary'),
  debug: $('stage-debug'),
};

let parseAbortController = null;
let translateAbortController = null;
let currentDoc = null;       // analyzeLayout 輸出
let currentPdfDoc = null;    // PDF.js PDFDocumentProxy（記得 destroy）
let currentDebugPage = 0;
let currentReaderHandle = null;
let currentModelOverride = null;
let currentEngine = 'gemini';
let currentOriginalArrayBuffer = null; // W6：留 PDF 原 ArrayBuffer 給 pdf-lib 重組譯文 PDF 用
let lastTranslateSummary = null;       // 翻譯紀錄 modal 顯示用
// 翻譯設定：選定 preset slot(1 / 2 / 3)，從 storage.local.translateDocPresetSlot 讀，
// 預設 1。對應 storage.sync.translatePresets[slot - 1] 的 model 當 modelOverride
let currentPresetSlot = 1;
let cachedPresets = null;
// v1.8.49:文章術語表(取代既有 applyGlossary 黑箱 toggle)。
// null = 還沒建;[] = 建過但空(等同沒術語表);[{source, target, note?}] = 有效術語表。
// 不持久化(reupload 即清),持久靠使用者自行匯出 / 匯入 JSON。
let currentArticleGlossary = null;
// 記錄打開 glossary editor 的來源 stage,cancel / 翻譯後決定回哪個 stage
let glossaryEntryStage = 'result';

function showStage(name) {
  for (const [key, el] of Object.entries(stages)) {
    el.hidden = key !== name;
  }
}

function setVersionFooter() {
  try {
    const v = chrome.runtime.getManifest().version;
    $('footer-version').textContent = `Shinkansen v${v}`;
  } catch (_) {
    /* manifest 拿不到時靜默 */
  }
}

function showError(msg) {
  const el = $('upload-error');
  el.textContent = msg;
  el.hidden = false;
  showStage('upload');
}

function clearError() {
  const el = $('upload-error');
  el.textContent = '';
  el.hidden = true;
}

function setParsingDetail(text) {
  $('parsing-detail').textContent = text;
}

function releaseCurrentDoc() {
  if (currentReaderHandle) {
    try { currentReaderHandle.destroy(); } catch (_) { /* ignore */ }
    currentReaderHandle = null;
  }
  if (currentPdfDoc) {
    closeDocument(currentPdfDoc);
    currentPdfDoc = null;
  }
  currentDoc = null;
  currentDebugPage = 0;
  currentModelOverride = null;
  currentEngine = 'gemini';
  currentOriginalArrayBuffer = null;
  lastTranslateSummary = null;
  currentArticleGlossary = null;
  if (window.__skLayoutDoc) delete window.__skLayoutDoc;
}

async function handleFile(file) {
  clearError();

  const pre = preflightFile(file);
  if (pre.level === 'error') {
    showError(pre.message);
    return;
  }
  // softWarn（超過 5MB 但未達 10MB）目前先不做 modal，直接繼續解析
  // 軟警告完整 modal 走 W7 UX polish

  // 切新檔前釋放舊 pdfDoc(避免 PDF.js Worker 累積)
  releaseCurrentDoc();

  showStage('parsing');
  setParsingDetail(t('doc.parsing.detail.fileContent'));

  try {
    // W6：讀一次 file.arrayBuffer() cache 起來，給後續 pdf-renderer 重組譯文 PDF 用
    // (parsePdf 內也讀一次，但 PDF.js 內部消費掉，不能 reuse；這裡多 read 一次)
    currentOriginalArrayBuffer = await file.arrayBuffer();
    const rawDoc = await parsePdf(file, (progress) => {
      switch (progress.stage) {
        case 'reading':
          setParsingDetail(t('doc.parsing.detail.fileContent'));
          break;
        case 'opening':
          setParsingDetail(t('doc.parsing.detail.openDoc'));
          break;
        case 'page':
          setParsingDetail(t('doc.parsing.detail.extractPage', { current: progress.current, total: progress.total }));
          break;
        default:
          break;
      }
    });

    setParsingDetail(t('doc.parsing.detail.layout'));
    const doc = analyzeLayout(rawDoc);
    currentDoc = doc;
    currentPdfDoc = rawDoc.pdfDoc;

    // dev probe: expose 給 tools/pdf-layout-harness.js 用 page.evaluate 讀
    // 不影響使用者(只是多一個 global ref;memory 釋放交給 releaseCurrentDoc)
    window.__skLayoutDoc = {
      meta: doc.meta,
      stats: doc.stats,
      warnings: doc.warnings,
      pages: doc.pages.map((p) => ({
        pageIndex: p.pageIndex,
        viewport: p.viewport,
        columnCount: p.columnCount,
        medianLineHeight: p.medianLineHeight,
        bodyFontSize: p.bodyFontSize,
        blocks: p.blocks,
      })),
      // dev probe(W2-iter3 期間留著，iter4 移除):raw text runs 也 expose 供 harness 抓
      _rawPages: rawDoc.pages.map((p) => ({
        pageIndex: p.pageIndex,
        viewport: p.viewport,
        textRuns: p.textRuns,
      })),
    };

    // dev hook for tools/pdf-structure-verify.js — 不影響 production,
    // 只暴露操作 module-scope state 的函式,供 harness 注入 fake translation
    // + 攔截 downloadBilingualPdf 的 PDF bytes 做版面結構核對
    window.__skVerify = {
      hasDoc: () => !!currentDoc,
      injectPlainTextAsTranslation: () => {
        if (!currentDoc) return null;
        let count = 0;
        for (const page of currentDoc.pages) {
          for (const block of page.blocks) {
            if (TRANSLATABLE_TYPES_SET.has(block.type) && block.plainText && block.plainText.trim()) {
              block.translation = block.plainText;
              block.translationStatus = 'done';
              count++;
            }
          }
        }
        return { translatableCount: count };
      },
      generateAndVerifyPdf: async () => {
        if (!currentDoc || !currentOriginalArrayBuffer) return null;
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
          result = await downloadBilingualPdf(currentOriginalArrayBuffer, currentDoc, {});
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
        if (!currentDoc) return null;
        return computeStructureDiagnostics(currentDoc);
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
      runEnhancedVerify: async () => {
        if (!currentDoc || !currentOriginalArrayBuffer) return null;
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
          if (!TRANSLATABLE_TYPES_SET.has(block.type)) return null;
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
        const gt = await analyzePdfBytes(currentOriginalArrayBuffer);

        // ---- 2. 對每 block 算 bold 比例 + overflow ----
        const blockAnalysis = [];
        for (const page of currentDoc.pages) {
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

        // ---- 3. 注入 fake translation = plainText ----
        let translatableCount = 0;
        for (const page of currentDoc.pages) {
          for (const block of page.blocks) {
            if (TRANSLATABLE_TYPES_SET.has(block.type) && block.plainText && block.plainText.trim()) {
              block.translation = block.plainText;
              block.translationStatus = 'done';
              translatableCount++;
            }
          }
        }

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
        try {
          const r = await downloadBilingualPdf(currentOriginalArrayBuffer, currentDoc, {});
          generatedByteLength = r.byteLength;
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
          const layoutBlock = currentDoc.pages[ba.pageIndex].blocks.find((b) => b.blockId === ba.blockId);
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
          if (!TRANSLATABLE_TYPES_SET.has(ba.type)) continue;
          const layoutBlock = currentDoc.pages[ba.pageIndex].blocks.find((b) => b.blockId === ba.blockId);
          if (!layoutBlock) continue;
          const layoutPage = currentDoc.pages[ba.pageIndex];
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

        return {
          ok: true,
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

    // W2 暫定：把版面 IR 印到 console 供肉眼驗
    const totalBlocks = doc.pages.reduce((sum, p) => sum + p.blocks.length, 0);
    console.group('[Shinkansen] PDF 版面分析完成');
    console.log('meta:', doc.meta);
    console.log('stats:', doc.stats);
    console.log('warnings:', doc.warnings);
    console.log('總 block 數：', totalBlocks);
    console.log('pages:', doc.pages);
    if (doc.pages[0]) {
      console.log('首頁 blocks:', doc.pages[0].blocks);
    }
    console.groupEnd();

    // UI 摘要(W7:工程術語 text run 總數 / 切出 block 數對 user 無意義已移除,
    // 只保留檔名 / 頁數 / 文件字數三項)
    $('result-filename').textContent = doc.meta.filename || t('doc.result.unnamed');
    $('result-pages').textContent = t('doc.result.pageCount', { n: doc.meta.pageCount });
    $('result-chars').textContent = doc.stats.totalChars.toLocaleString('en-US');

    if (doc.warnings.length > 0) {
      const warnEl = $('upload-error');
      warnEl.textContent = doc.warnings.map((w) => t('doc.parsing.warn', { message: w.message })).join(' / ');
      warnEl.hidden = false;
    }

    showStage('result');
  } catch (err) {
    if (err instanceof PdfParseError) {
      showError(err.message);
    } else {
      console.error('[Shinkansen] PDF 解析失敗', err);
      showError(t('doc.parsing.fail', { error: (err && err.message) || String(err) }));
    }
    releaseCurrentDoc();
  }
}

// ---------- Debug overlay ----------

// 給每個 block 配個穩定色相(reading order * 黃金比例 mod 360 → 視覺分散)
function blockHue(readingOrder) {
  return (readingOrder * 137.508) % 360;
}

// type 對應的色盤(HSL 三元組：hue, saturation, lightness)
const BLOCK_TYPE_COLORS = {
  heading: [0, 75, 50],       // 紅暖色：標題
  paragraph: [210, 70, 50],   // 藍：正文
  'list-item': [140, 60, 42], // 綠：條列
  footnote: [40, 60, 45],     // 橙：腳註
  'page-number': [0, 0, 60],  // 灰：頁碼
  table: [280, 60, 50],       // 紫：表格
  formula: [320, 60, 45],     // 洋紅：公式(W2-iter6)
  caption: [180, 60, 40],     // 青：說明(W2-iter6)
  figure: [0, 0, 75],         // 淡灰：圖
};

function blockColorForType(type) {
  const c = BLOCK_TYPE_COLORS[type] || BLOCK_TYPE_COLORS.paragraph;
  return {
    stroke: `hsl(${c[0]}, ${c[1]}%, ${c[2]}%)`,
    fill: `hsl(${c[0]}, ${c[1]}%, ${c[2] + 10}%)`,
  };
}

function blockColorForOrder(order) {
  const hue = blockHue(order);
  return {
    stroke: `hsl(${hue}, 70%, 45%)`,
    fill: `hsl(${hue}, 70%, 55%)`,
  };
}

function renderTypeLegend(blocks) {
  const el = $('debug-type-legend');
  if (!el) return;
  // 統計這頁出現的 types
  const counts = {};
  for (const b of blocks) counts[b.type] = (counts[b.type] || 0) + 1;
  const order = ['heading', 'paragraph', 'list-item', 'footnote', 'page-number', 'table', 'formula', 'caption', 'figure'];
  el.innerHTML = '';
  for (const t of order) {
    if (!counts[t]) continue;
    const span = document.createElement('span');
    const color = BLOCK_TYPE_COLORS[t];
    span.style.color = `hsl(${color[0]}, ${color[1]}%, ${color[2]}%)`;
    const swatch = document.createElement('i');
    span.appendChild(swatch);
    span.appendChild(document.createTextNode(`${t} (${counts[t]})`));
    el.appendChild(span);
  }
}

function setBlockDetail(block) {
  const el = $('debug-detail');
  el.innerHTML = '';
  if (!block) {
    el.innerHTML = `<span class="debug-detail-empty">${t('doc.debug.detail.empty')}</span>`;
    return;
  }
  const idSpan = document.createElement('span');
  idSpan.className = 'debug-detail-id';
  const statusSuffix = block.translationStatus ? ` · ${block.translationStatus}` : '';
  idSpan.textContent = `#${block.readingOrder} ${block.blockId} · ${block.type}${statusSuffix}`;
  const metaSpan = document.createElement('span');
  metaSpan.className = 'debug-detail-meta';
  metaSpan.textContent = t('doc.debug.metadata', { col: block.column, lines: block.lineCount, size: block.fontSize.toFixed(1) });

  el.appendChild(idSpan);
  el.appendChild(metaSpan);
  el.appendChild(document.createElement('br'));

  const previewText = (txt) =>
    !txt ? t('doc.debug.empty') : (txt.length > 280 ? txt.slice(0, 280) + '…' : txt);

  // 原文
  const origLabel = document.createElement('span');
  origLabel.style.color = 'var(--text-faint)';
  origLabel.textContent = t('doc.debug.original');
  el.appendChild(origLabel);
  const origText = document.createElement('span');
  origText.textContent = ' ' + previewText(block.plainText);
  el.appendChild(origText);

  // 譯文(若有)
  if (block.translation) {
    el.appendChild(document.createElement('br'));
    const trLabel = document.createElement('span');
    trLabel.style.color = 'var(--primary)';
    trLabel.textContent = t('doc.debug.translation');
    el.appendChild(trLabel);
    const trText = document.createElement('span');
    trText.textContent = ' ' + previewText(block.translation);
    el.appendChild(trText);
  } else if (block.translationError) {
    el.appendChild(document.createElement('br'));
    const errLabel = document.createElement('span');
    errLabel.style.color = 'var(--error-text)';
    errLabel.textContent = t('doc.debug.translateFail', { error: block.translationError });
    el.appendChild(errLabel);
  }
}

async function renderDebugPage() {
  if (!currentDoc || !currentPdfDoc) return;
  const pageIndex = currentDebugPage;
  const layoutPage = currentDoc.pages[pageIndex];
  if (!layoutPage) return;

  const total = currentDoc.pages.length;
  $('debug-page-indicator').textContent = t('doc.debug.pageIndicator', { current: pageIndex + 1, total });
  $('debug-prev').disabled = pageIndex === 0;
  $('debug-next').disabled = pageIndex >= total - 1;
  const bodyFs = layoutPage.bodyFontSize ? `${layoutPage.bodyFontSize.toFixed(1)}pt` : 'N/A';
  $('debug-page-stats').textContent =
    t('doc.debug.pageStats', { blocks: layoutPage.blocks.length, cols: layoutPage.columnCount }) +
    ` · medianLineHeight ${layoutPage.medianLineHeight.toFixed(1)}pt · body fontSize ${bodyFs}`;
  renderTypeLegend(layoutPage.blocks);

  const canvas = $('debug-canvas');
  let renderInfo;
  try {
    renderInfo = await renderPageToCanvas(currentPdfDoc, pageIndex, canvas, DEBUG_RENDER_SCALE);
  } catch (err) {
    console.error('[Shinkansen] render page 失敗', err);
    return;
  }
  // canvas internal bitmap 是 scale × DPR(retina 銳化),但顯示尺寸要鎖回
  // scale 基準的 CSS pixel,SVG overlay 才對得上(SVG 走 renderInfo.width / .height)
  canvas.style.width = `${renderInfo.width}px`;
  canvas.style.height = `${renderInfo.height}px`;

  // SVG overlay 對齊 canvas 像素尺寸
  const svg = $('debug-svg');
  svg.setAttribute('width', String(renderInfo.width));
  svg.setAttribute('height', String(renderInfo.height));
  svg.setAttribute('viewBox', `0 0 ${renderInfo.width} ${renderInfo.height}`);
  svg.style.width = `${renderInfo.width}px`;
  svg.style.height = `${renderInfo.height}px`;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const showBbox = $('debug-show-bbox').checked;
  const showOrder = $('debug-show-order').checked;
  const isolateRaw = $('debug-isolate-input').value.trim();
  const isolateOrder = isolateRaw === '' ? null : Number.parseInt(isolateRaw, 10);

  // bbox 已是 canvas 座標(y 由上往下，套過 viewport.transform)，直接乘 scale 即可
  const scale = renderInfo.scale;

  setBlockDetail(null);

  // dev probe:exposed 給 harness / 手動 console inspect
  window.__skDebugSvg = svg;
  window.__skDebugBlocks = layoutPage.blocks;

  for (const block of layoutPage.blocks) {
    if (isolateOrder !== null && !Number.isNaN(isolateOrder) && block.readingOrder !== isolateOrder) continue;

    const [left, top, right, bottom] = block.bbox;
    const rectX = left * scale;
    const rectY = top * scale;
    const rectW = Math.max(1, (right - left) * scale);
    const rectH = Math.max(1, (bottom - top) * scale);

    const colorMode = $('debug-color-mode')?.value || 'type';
    const { stroke, fill } = colorMode === 'type'
      ? blockColorForType(block.type)
      : blockColorForOrder(block.readingOrder);

    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'debug-block-group');
    group.dataset.blockId = block.blockId;

    if (showBbox) {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(rectX));
      rect.setAttribute('y', String(rectY));
      rect.setAttribute('width', String(rectW));
      rect.setAttribute('height', String(rectH));
      rect.setAttribute('class', 'debug-block-rect');
      rect.setAttribute('stroke', stroke);
      rect.setAttribute('fill', fill);
      group.appendChild(rect);
    }

    if (showOrder) {
      const labelText = `#${block.readingOrder}`;
      const padX = 4;
      const labelH = 13;
      const estW = labelText.length * 7 + padX * 2;
      // label 放 bbox 內右上角(跟前一個 block 的 bbox 不互相重疊)
      const labelX = Math.max(0, rectX + rectW - estW);
      const labelY = rectY;

      const bg = document.createElementNS(SVG_NS, 'rect');
      bg.setAttribute('x', String(labelX));
      bg.setAttribute('y', String(labelY));
      bg.setAttribute('width', String(estW));
      bg.setAttribute('height', String(labelH));
      bg.setAttribute('rx', '2');
      bg.setAttribute('class', 'debug-block-label-bg');
      bg.setAttribute('fill', '#fff');
      bg.setAttribute('stroke', stroke);
      group.appendChild(bg);

      const txt = document.createElementNS(SVG_NS, 'text');
      txt.setAttribute('x', String(labelX + padX));
      txt.setAttribute('y', String(labelY + labelH - 3));
      txt.setAttribute('class', 'debug-block-label');
      txt.setAttribute('fill', stroke);
      txt.textContent = labelText;
      group.appendChild(txt);
    }

    group.addEventListener('mouseenter', () => setBlockDetail(block));
    group.addEventListener('mouseleave', () => setBlockDetail(null));
    group.addEventListener('click', () => {
      // click 鎖定 detail，再 click 同一個解鎖
      if (group.classList.contains('is-active')) {
        group.classList.remove('is-active');
        setBlockDetail(null);
      } else {
        svg.querySelectorAll('.debug-block-group.is-active').forEach((g) => g.classList.remove('is-active'));
        group.classList.add('is-active');
        setBlockDetail(block);
      }
    });

    svg.appendChild(group);
  }
}

// ---------- 事件綁定 ----------

function bindUploadUI() {
  const dropzone = $('dropzone');
  const fileInput = $('file-input');

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) {
      handleFile(file);
      fileInput.value = ''; // reset 讓同一檔案可重選
    }
  });

  ['dragenter', 'dragover'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
}

function bindResultUI() {
  $('reupload-btn').addEventListener('click', () => {
    clearError();
    releaseCurrentDoc();
    showStage('upload');
  });
  $('cancel-btn').addEventListener('click', () => {
    if (parseAbortController) {
      parseAbortController.abort();
      parseAbortController = null;
    }
    releaseCurrentDoc();
    showStage('upload');
  });
  $('translate-btn').addEventListener('click', () => startTranslate());
}

function bindTranslatingUI() {
  // 翻譯中 stage 的「取消」按鈕(原 bindTranslatedUI 內含此 binding,
  // stage-translated 砍掉後該 binding 仍要保留)
  $('translate-cancel-btn').addEventListener('click', () => {
    if (translateAbortController) {
      translateAbortController.abort();
    }
  });
}

const TRANSLATABLE_TYPES_SET = new Set(['paragraph', 'heading', 'list-item', 'caption', 'footnote']);
const GLOSSARY_INPUT_MAX_CHARS = 60_000;

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
      if (TRANSLATABLE_TYPES_SET.has(block.type)) {
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

// 對整份 PDF 送 EXTRACT_GLOSSARY 拿 [{source, target}] 對照表(術語表一致化)
async function extractGlossaryForDoc(doc) {
  const parts = [];
  let acc = 0;
  for (const page of doc.pages) {
    for (const b of page.blocks) {
      if (!TRANSLATABLE_TYPES_SET.has(b.type)) continue;
      const t = b.plainText && b.plainText.trim();
      if (!t) continue;
      if (acc + t.length > GLOSSARY_INPUT_MAX_CHARS) {
        parts.push(t.slice(0, GLOSSARY_INPUT_MAX_CHARS - acc));
        acc = GLOSSARY_INPUT_MAX_CHARS;
        break;
      }
      parts.push(t);
      acc += t.length + 1;
    }
    if (acc >= GLOSSARY_INPUT_MAX_CHARS) break;
  }
  const compressedText = parts.join('\n');
  if (compressedText.length < 200) {
    console.log('[Shinkansen] glossary skipped (text too short)', { chars: compressedText.length });
    return null;
  }
  const inputHash = await sha1(compressedText);
  console.log('[Shinkansen] glossary extracting', { chars: compressedText.length, hash: inputHash.slice(0, 8) });
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'EXTRACT_GLOSSARY',
      payload: { compressedText, inputHash },
    });
    if (res?.ok && Array.isArray(res.glossary) && res.glossary.length > 0) {
      return res.glossary;
    }
    if (res?.ok) {
      console.log('[Shinkansen] glossary returned empty');
      return null;
    }
    console.warn('[Shinkansen] glossary not ok', res?.error);
    return null;
  } catch (err) {
    console.warn('[Shinkansen] glossary extract failed', err && err.message);
    return null;
  }
}

async function sha1(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 翻譯設定：讀使用者選定 slot，解析 engine + modelOverride。
// engine='gemini' 時 modelOverride = preset.model（若有）；
// 其他 engine（google / openai-compat）不走 Gemini model override。
async function resolvePreset() {
  const presets = await loadPresets();
  const idx = (currentPresetSlot || 1) - 1;
  const p = presets[idx];
  if (!p) return { engine: 'gemini', modelOverride: undefined };
  const engine = p.engine || 'gemini';
  const modelOverride = (engine === 'gemini' && p.model) ? p.model : undefined;
  return { engine, modelOverride };
}

async function loadPresets() {
  if (cachedPresets) return cachedPresets;
  try {
    const r = await chrome.storage.sync.get(['translatePresets']);
    cachedPresets = Array.isArray(r.translatePresets) ? r.translatePresets : [];
  } catch (err) {
    console.warn('[Shinkansen] 讀 translatePresets 失敗', err);
    cachedPresets = [];
  }
  return cachedPresets;
}

async function loadCurrentPresetSlot() {
  try {
    const r = await chrome.storage.local.get(['translateDocPresetSlot']);
    const slot = parseInt(r.translateDocPresetSlot, 10);
    if (slot >= 1 && slot <= 3) currentPresetSlot = slot;
    else currentPresetSlot = 1;
  } catch (err) {
    currentPresetSlot = 1;
  }
}

// 對齊 options.html「翻譯快速鍵」分頁的 label / shortcut / 順序(slot 2 排最前 為主要預設):
//   slot 2 = 主要預設 (⌥S / Alt+S)
//   slot 1 = 預設 2  (⌥A / Alt+A)
//   slot 3 = 預設 3  (⌥D / Alt+D)
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');
// name 在 openSettingsDialog 走 t() 取(必須在 i18n 載入後 lazy 取),這裡只記 slot 順序與快速鍵
const PRESET_DISPLAY = [
  { slot: 2, nameKey: 'doc.settings.preset.main', shortcut: IS_MAC ? '⌥S' : 'Alt+S' },
  { slot: 1, nameKey: 'doc.settings.preset.alt',  nameParams: { n: 2 }, shortcut: IS_MAC ? '⌥A' : 'Alt+A' },
  { slot: 3, nameKey: 'doc.settings.preset.alt',  nameParams: { n: 3 }, shortcut: IS_MAC ? '⌥D' : 'Alt+D' },
];

async function openSettingsDialog() {
  const presets = await loadPresets();
  const dlg = $('translate-settings-dialog');
  const list = $('settings-preset-list');
  list.innerHTML = '';
  for (const { slot, nameKey, nameParams, shortcut } of PRESET_DISPLAY) {
    const p = presets.find((x) => x && x.slot === slot) || { engine: 'gemini', model: null, label: '' };
    const row = document.createElement('label');
    row.className = 'settings-preset-row' + (slot === currentPresetSlot ? ' is-selected' : '');
    const engineLabel = p.engine === 'gemini' ? (p.model || 'gemini')
      : p.engine === 'google' ? 'Google MT'
      : p.engine;
    const presetLabel = t('doc.settings.preset.label', {
      name: t(nameKey, nameParams),
      shortcut,
      presetLabel: p.label || t('doc.settings.preset.unnamed'),
    });
    row.innerHTML = `
      <input type="radio" name="preset-slot" value="${slot}" ${slot === currentPresetSlot ? 'checked' : ''}>
      <span class="preset-label">${presetLabel}</span>
      <span class="preset-engine">${engineLabel}</span>
    `;
    row.addEventListener('click', () => {
      list.querySelectorAll('.settings-preset-row').forEach((el) => el.classList.remove('is-selected'));
      row.classList.add('is-selected');
      row.querySelector('input').checked = true;
    });
    list.appendChild(row);
  }
  dlg.showModal();
}

function bindSettingsDialogUI() {
  const dlg = $('translate-settings-dialog');
  $('translate-settings-cancel-btn').addEventListener('click', () => dlg.close());
  $('translate-settings-save-btn').addEventListener('click', async () => {
    const checked = dlg.querySelector('input[name="preset-slot"]:checked');
    const slot = checked ? parseInt(checked.value, 10) : currentPresetSlot;
    currentPresetSlot = slot;
    try {
      await chrome.storage.local.set({ translateDocPresetSlot: slot });
    } catch (_) { /* ignore */ }
    dlg.close();
  });
  $('settings-clear-doc-cache-btn').addEventListener('click', async () => {
    const btn = $('settings-clear-doc-cache-btn');
    const status = $('settings-clear-doc-cache-status');
    if (btn.disabled) return;
    if (!currentDoc) {
      status.textContent = t('doc.settings.cache.notLoaded');
      setTimeout(() => { status.textContent = ''; }, 3000);
      return;
    }
    btn.disabled = true;
    status.textContent = t('doc.settings.cache.clearing');
    try {
      const r = await clearCurrentDocCache();
      status.textContent = t('doc.settings.cache.cleared', { removed: r.removedKeyCount, total: r.translatableSegmentCount });
    } catch (err) {
      console.error('[Shinkansen] 清除本篇 cache 失敗', err);
      status.textContent = t('doc.settings.cache.failed', { error: (err && err.message) || t('doc.settings.unknownErr') });
    }
    setTimeout(() => {
      btn.disabled = false;
      status.textContent = '';
    }, 4000);
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  // stage-result + reader-toolbar 兩個按鈕都開同一個 dialog
  $('result-settings-btn').addEventListener('click', () => openSettingsDialog());
  $('reader-settings-btn').addEventListener('click', () => openSettingsDialog());

  // W7:modal 內「進階設定 →」按鈕,開新 tab 進獨立 settings page。
  // 為將來擴充 Office 翻譯做好結構,深設定(systemPrompt / 預設術語表 /
  // 清除所有文件快取)在 translate-doc/settings.html 集中
  $('settings-open-doc-options-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('translate-doc/settings.html') });
    dlg.close();
  });
}

// 清除本篇 PDF 對應的所有譯文快取(prefix tc_<sha1> match,不限 suffix)。
// 不動其他 PDF / 網頁 / 字幕快取。同時把 currentDoc 內已有 translation 的
// block 重置成 pending,讓使用者下次重新翻譯會真的呼叫 LLM。
//
// Cache key 結構(見 lib/cache.js):
//   tc_<sha1(plainText)><suffix>
// suffix 包含 cacheTag('_doc') / glossary hash / forbidden hash / model id,
// 所以同一段 plainText 在不同 model / glossary 設定下會有不同 key。我們以
// `tc_<sha1>` 為 prefix 一次掃掉所有 suffix 變體 — 比對單一 suffix 來得徹底
async function clearCurrentDocCache() {
  if (!currentDoc) return { removedKeyCount: 0, translatableSegmentCount: 0 };
  const segTexts = [];
  for (const page of currentDoc.pages) {
    for (const block of page.blocks) {
      if (!TRANSLATABLE_TYPES_SET.has(block.type)) continue;
      const t = block.plainText && block.plainText.trim();
      if (!t) continue;
      segTexts.push({ block, text: block.plainText });
    }
  }
  if (segTexts.length === 0) return { removedKeyCount: 0, translatableSegmentCount: 0 };
  // 算每段 sha1 → 構造 prefix
  const prefixes = await Promise.all(
    segTexts.map(async (s) => 'tc_' + (await sha1(s.text))),
  );
  const prefixSet = new Set(prefixes);
  // 全 storage 掃 keys 比對 prefix(一份 PDF 通常 < 200 段,storage 全 key 通常 < 1000 條,
  // 一次 chrome.storage.local.get(null) 可接受)
  const all = await chrome.storage.local.get(null);
  const matchedKeys = [];
  for (const key of Object.keys(all)) {
    if (!key.startsWith('tc_')) continue;
    // tc_<40 char sha1>... — 取前 43 字當 prefix 比對
    const prefix = key.slice(0, 43);
    if (prefixSet.has(prefix)) matchedKeys.push(key);
  }
  if (matchedKeys.length > 0) {
    await chrome.storage.local.remove(matchedKeys);
  }
  // 重置 block 翻譯狀態,讓 reader / debug overlay 看起來「重新可翻」
  for (const { block } of segTexts) {
    block.translation = undefined;
    block.translationStatus = undefined;
    block.translationError = undefined;
  }
  return { removedKeyCount: matchedKeys.length, translatableSegmentCount: segTexts.length };
}

function bindSummaryDialogUI() {
  const dlg = $('translate-summary-dialog');
  $('translate-summary-close-btn').addEventListener('click', () => dlg.close());
  $('translate-summary-overlay-btn').addEventListener('click', () => {
    dlg.close();
    if (!currentDoc) return;
    currentDebugPage = 0;
    showStage('debug');
    renderDebugPage();
  });
  // 重試失敗段落:走 currentReaderHandle.retryAllFailed,內部會 regenerate 譯文 PDF
  // + rerender 右欄。完成後刷新 dialog 顯示。
  $('summary-retry-btn').addEventListener('click', async () => {
    if (!currentReaderHandle) return;
    const btn = $('summary-retry-btn');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = t('doc.summary.retrying');
    try {
      const r = await currentReaderHandle.retryAllFailed();
      btn.textContent = t('doc.summary.retried', { success: r.success, total: r.total });
    } catch (err) {
      console.error('[Shinkansen] retryAll 失敗', err);
      btn.textContent = t('doc.summary.retryFailed');
    }
    setTimeout(() => {
      btn.textContent = orig;
      // 重新計算失敗段數刷新 dialog 顯示(retry 後可能 0 或剩幾段)
      refreshSummaryFailedDisplay();
    }, 1500);
  });
  // 點 backdrop(對話框外)關閉
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
}

// 用實際當前 doc 的失敗計數刷新「翻譯失敗」row + 控 retry 按鈕顯示
// + 同步刷新 reader toolbar 上的「翻譯紀錄」按鈕視覺提示
function refreshSummaryFailedDisplay() {
  const failed = countCurrentFailedBlocks();
  $('translated-failed').textContent = failed > 0 ? t('doc.summary.failedSegments', { n: failed }) : '0';
  const btn = $('summary-retry-btn');
  btn.hidden = failed === 0;
  btn.disabled = false;
  refreshSummaryButtonAlert();
}

function bindReaderUI() {
  $('reader-edit-btn').addEventListener('click', () => openEditor());
  $('reader-reupload-btn').addEventListener('click', () => {
    releaseCurrentDoc();
    showStage('upload');
  });
  $('reader-copy-btn').addEventListener('click', async () => {
    if (!currentDoc) return;
    const txt = buildPlainTextDump(currentDoc);
    const btn = $('reader-copy-btn');
    const orig = btn.textContent;
    try {
      await navigator.clipboard.writeText(txt);
      btn.textContent = t('doc.reader.copy.copied', { size: (txt.length / 1024).toFixed(1) });
    } catch (err) {
      console.error('clipboard 失敗', err);
      btn.textContent = t('doc.reader.copy.failed');
    }
    setTimeout(() => { btn.textContent = orig; }, 2500);
  });
  $('reader-sync-toggle').addEventListener('change', (e) => {
    if (currentReaderHandle) {
      currentReaderHandle.setSyncEnabled(e.target.checked);
    }
  });
  $('reader-zoom-out').addEventListener('click', () => stepZoom(-0.1));
  $('reader-zoom-in').addEventListener('click', () => stepZoom(+0.1));
  $('reader-summary-btn').addEventListener('click', async () => {
    if (!lastTranslateSummary) return;
    await fillSummaryDialog(lastTranslateSummary);
    $('translate-summary-dialog').showModal();
  });
  $('reader-download-pdf-btn').addEventListener('click', async () => {
    if (!currentDoc || !currentOriginalArrayBuffer) return;
    const btn = $('reader-download-pdf-btn');
    if (btn.disabled) return;
    btn.disabled = true;
    const orig = btn.textContent;
    try {
      // reader 已經 cache 一份生成好的 bytes(WYSIWYG mode 開 reader 時就生成),
      // 直接用 prebuiltBytes 觸發 download 免重做。reader handle 不存在
      // (使用者沒進過 reader stage 就直接從 stage-result 點下載?)再走一般流程
      const cachedBytes = currentReaderHandle && currentReaderHandle.getTranslatedPdfBytes
        ? currentReaderHandle.getTranslatedPdfBytes()
        : null;
      let result;
      if (cachedBytes) {
        btn.textContent = t('doc.reader.download.writing');
        result = await downloadBilingualPdf(currentOriginalArrayBuffer, currentDoc, {
          prebuiltBytes: cachedBytes,
        });
      } else {
        btn.textContent = t('doc.reader.download.generating');
        result = await downloadBilingualPdf(currentOriginalArrayBuffer, currentDoc, {
          onProgress: (p) => {
            if (p.stage === 'page') {
              btn.textContent = t('doc.reader.download.processingPage', { current: p.current, total: p.total });
            } else if (p.stage === 'saving') {
              btn.textContent = t('doc.reader.download.writing');
            } else if (p.stage === 'font') {
              btn.textContent = t('doc.reader.download.loadingFont');
            }
          },
        });
      }
      const sizeMB = (result.byteLength / 1024 / 1024).toFixed(1);
      btn.textContent = t('doc.reader.download.done', { size: sizeMB });
    } catch (err) {
      console.error('[Shinkansen] 下載譯文 PDF 失敗', err);
      btn.textContent = t('doc.reader.download.failed', { error: (err && err.message) || t('doc.settings.unknownErr') });
    }
    setTimeout(() => {
      btn.textContent = orig;
      btn.disabled = false;
    }, 3000);
  });
}

async function openReader() {
  if (!currentDoc || !currentPdfDoc || !currentOriginalArrayBuffer) return;
  showStage('reader');
  // 等 stage 切換 + layout 確定後再 render(canvas size 才對)
  await new Promise((r) => requestAnimationFrame(r));
  if (currentReaderHandle) {
    try { currentReaderHandle.destroy(); } catch (_) { /* ignore */ }
    currentReaderHandle = null;
  }
  currentReaderHandle = await renderReader(
    currentDoc,
    currentPdfDoc,
    currentOriginalArrayBuffer,
    $('reader-col-original'),
    $('reader-col-translated'),
    {
      modelOverride: currentModelOverride,
      engine: currentEngine,
      glossary: currentArticleGlossary,
    },
  );
  // 套用 sync toggle + 重設 zoom 顯示
  if (currentReaderHandle) {
    currentReaderHandle.setSyncEnabled($('reader-sync-toggle').checked);
    $('reader-zoom-level').textContent = `${Math.round(currentReaderHandle.getZoom() * 100)}%`;
  }
  refreshSummaryButtonAlert();
}

// 從 currentDoc 算當前實際失敗段數(不依賴 lastTranslateSummary,因為使用者可能
// 在編輯頁手動填過失敗段 → 已 done,實際失敗數 < 原始 summary)
function countCurrentFailedBlocks() {
  if (!currentDoc) return 0;
  let n = 0;
  for (const page of currentDoc.pages) {
    for (const block of page.blocks) {
      if (TRANSLATABLE_TYPES_SET.has(block.type) && block.translationStatus === 'failed') n++;
    }
  }
  return n;
}

// 「翻譯紀錄」按鈕視覺提示:有失敗段時加橘邊強調,讓使用者知道要進去查 / 重試。
// 呼叫點:openReader 完成、saveEdits 完成、retry 完成、translate 完成
function refreshSummaryButtonAlert() {
  const btn = $('reader-summary-btn');
  if (!btn) return;
  const failed = countCurrentFailedBlocks();
  btn.classList.toggle('has-failed-alert', failed > 0);
  btn.title = failed > 0
    ? t('doc.reader.btn.summary.title.failed', { n: failed })
    : t('doc.reader.btn.summary.title');
}

function stepZoom(delta) {
  if (!currentReaderHandle) return;
  const cur = currentReaderHandle.getZoom();
  const next = currentReaderHandle.setZoom(cur + delta);
  $('reader-zoom-level').textContent = `${Math.round(next * 100)}%`;
}

function bindDebugUI() {
  $('debug-prev').addEventListener('click', () => {
    if (currentDebugPage > 0) {
      currentDebugPage--;
      renderDebugPage();
    }
  });
  $('debug-next').addEventListener('click', () => {
    if (currentDoc && currentDebugPage < currentDoc.pages.length - 1) {
      currentDebugPage++;
      renderDebugPage();
    }
  });
  $('debug-show-bbox').addEventListener('change', () => renderDebugPage());
  $('debug-show-order').addEventListener('change', () => renderDebugPage());
  $('debug-isolate-input').addEventListener('input', () => renderDebugPage());
  $('debug-color-mode').addEventListener('change', () => renderDebugPage());

  $('debug-copy-json-btn').addEventListener('click', async () => {
    if (!currentDoc) return;
    // 序列化：剝掉 pdfDoc(PDF.js proxy 不可序列化)，保留所有 layout 資訊
    const dump = {
      meta: currentDoc.meta,
      stats: currentDoc.stats,
      warnings: currentDoc.warnings,
      pages: currentDoc.pages.map((p) => ({
        pageIndex: p.pageIndex,
        viewport: p.viewport,
        columnCount: p.columnCount,
        medianLineHeight: p.medianLineHeight,
        blocks: p.blocks,
      })),
    };
    const json = JSON.stringify(dump, null, 2);
    const btn = $('debug-copy-json-btn');
    const orig = btn.textContent;
    try {
      await navigator.clipboard.writeText(json);
      btn.textContent = t('doc.debug.copy.copied', { size: (json.length / 1024).toFixed(1) });
    } catch (err) {
      console.error('clipboard 失敗', err);
      console.log('[Shinkansen] dump JSON:', json);
      btn.textContent = t('doc.debug.copy.failed');
    }
    setTimeout(() => { btn.textContent = orig; }, 2500);
  });
  $('debug-back-btn').addEventListener('click', () => {
    // 已翻譯過 → 回閱讀器；尚未翻譯(只解析過)→ 回 stage-result
    if (currentReaderHandle && lastTranslateSummary) {
      showStage('reader');
    } else {
      showStage('result');
    }
  });

  // 鍵盤左右切頁
  document.addEventListener('keydown', (e) => {
    if (stages.debug.hidden) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      $('debug-prev').click();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      $('debug-next').click();
    }
  });
}

async function init() {
  await initI18n();
  setVersionFooter();
  bindUploadUI();
  bindResultUI();
  bindTranslatingUI();
  bindSummaryDialogUI();
  bindSettingsDialogUI();
  bindReaderUI();
  bindEditUI();
  bindGlossaryUI();
  bindDebugUI();
  // 啟動讀使用者選定的 preset slot
  loadCurrentPresetSlot();
  showStage('upload');
}

// 把 lib/i18n.js 的 dict 套到 [data-i18n*] 元素上,並訂閱 uiLanguage 變動 reapply。
// 跟 popup / options 同套機制,差別:translate-doc 沒有獨立 UI 語言 picker,直接讀
// settings.uiLanguage(預設 'auto' → navigator.language 推導)。
async function initI18n() {
  const I18N = window.__SK?.i18n;
  if (!I18N) return; // i18n.js 未載入(legacy fallback)
  let uiLang = 'auto';
  try {
    const stored = await chrome.storage.sync.get(['uiLanguage']);
    if (typeof stored.uiLanguage === 'string') uiLang = stored.uiLanguage;
  } catch (_) { /* 沒權限 / API 失敗時走 auto */ }
  const dictLang = I18N.getUiLanguage(uiLang);
  // 把 dictLang 寫進 window.__SK.STATE.uiLanguage,讓 i18n.t() 在沒帶 target 參數時
  // 能透過 _readCurrentTarget() 讀到正確語言(否則 fallback 'zh-TW')。translate-doc
  // 不是 content script,window.__SK.STATE 預設不存在,需手動建立。reader.js / index.js
  // 內的 t() 動態字串(preset 名稱 / progress 文字 / glossary state 等)都依賴此值。
  window.__SK = window.__SK || {};
  window.__SK.STATE = window.__SK.STATE || {};
  window.__SK.STATE.uiLanguage = dictLang;
  I18N.applyI18n(document, dictLang);
  // 訂閱 uiLanguage 變動 → 同步更新 STATE + reapply。translate-doc 開著時若使用者
  // 在 options 切 UI 語言,此 callback 會把所有 [data-i18n] 元素 + 後續 t() 動態
  // 呼叫都重指向新語言。
  I18N.subscribeUiLanguageChange((newUi) => {
    window.__SK.STATE.uiLanguage = newUi;
    I18N.applyI18n(document, newUi);
  });
}

// ---------- 譯文編輯（v1.8.49）----------
//
// 設計參考 CLAUDE.md §15(single mode 必須注入回原 element):這裡譯文最終仍寫回
// block.translation / block.translationSegments,buildBilingualPdf 走原本路徑,
// 不額外加 sibling overlay。編輯只發生在 layout doc 上,不持久(reupload 即失效)。
//
// markdown 協定見 translate.js segmentsToMarkdown / markdownToSegments 註解。

function openEditor() {
  if (!currentDoc) return;
  const list = $('edit-list');
  list.innerHTML = '';
  for (const page of currentDoc.pages) {
    const header = document.createElement('div');
    header.className = 'edit-page-header';
    header.textContent = t('doc.edit.pageHeader', { n: page.pageIndex + 1 });
    list.appendChild(header);

    let translatableInPage = 0;
    for (const block of page.blocks) {
      if (!TRANSLATABLE_TYPES_SET.has(block.type)) continue;
      if (!block.plainText || !block.plainText.trim()) continue;
      translatableInPage++;

      const row = document.createElement('div');
      row.className = 'edit-block';
      row.dataset.blockId = block.blockId;
      if (block.translationStatus === 'failed') row.classList.add('edit-block--failed');

      const original = document.createElement('div');
      original.className = 'edit-original';
      original.textContent = block.plainText;
      row.appendChild(original);

      // textarea + overlay 雙層結構,overlay 在底層墊高亮 mark,textarea 在上層保持
      // 編輯能力。CSS 兩者 padding/font/line-height/word-wrap 完全對齊。scroll 由 JS 同步。
      const wrap = document.createElement('div');
      wrap.className = 'edit-translation-wrap';

      const overlay = document.createElement('div');
      overlay.className = 'edit-highlight-overlay';
      overlay.setAttribute('aria-hidden', 'true');
      wrap.appendChild(overlay);

      const initialMd = (Array.isArray(block.translationSegments) && block.translationSegments.length > 0)
        ? segmentsToMarkdown(block.translationSegments)
        : (block.translation || '');

      const textarea = document.createElement('textarea');
      textarea.className = 'edit-translation';
      // 用譯文 markdown 長度估 rows(中文密度 ~25 字/行,textarea ~45 字/行 × 2/3 安全
      // 係數);max 30 避免極長段落炸太高;openEditor 末尾還會跑一次 autoFit 用實際
      // scrollHeight 微調(見 fitTextareaHeight)
      textarea.rows = Math.max(3, Math.min(30, Math.ceil((initialMd.length || 1) / 25)));
      textarea.value = initialMd;
      if (block.translationStatus === 'failed') {
        textarea.placeholder = t('doc.edit.placeholder.failed');
      }
      // 同步 overlay scroll(scrollbar 由 textarea 顯示;overlay overflow:hidden)
      textarea.addEventListener('scroll', () => {
        overlay.scrollTop = textarea.scrollTop;
        overlay.scrollLeft = textarea.scrollLeft;
      });
      // textarea 內容變動 → 重算 matches + 更新所有 overlays
      // (input event 對 user 打字 / 程式 setValue 都會觸發)
      textarea.addEventListener('input', () => {
        if ($('edit-find-input') && !$('edit-find-bar').hidden) {
          recomputeFindMatches({ keepIndex: true });
        }
      });
      wrap.appendChild(textarea);

      row.appendChild(wrap);

      list.appendChild(row);
    }

    if (translatableInPage === 0) {
      const empty = document.createElement('div');
      empty.className = 'edit-empty';
      empty.textContent = t('doc.edit.empty');
      list.appendChild(empty);
    }
  }
  showStage('edit');
  list.scrollTop = 0;
  // showStage 後 textarea 才有實際 layout,此時 scrollHeight 才正確。一次 loop 把
  // 所有 textarea 高度貼合內容(避免內容溢出產生 internal scroll)。read scrollHeight
  // 會 force layout,200 段約 50-150ms blocking,只在 openEditor 一次,可接受
  requestAnimationFrame(() => {
    for (const ta of list.querySelectorAll('.edit-translation')) {
      fitTextareaHeight(ta);
    }
  });
}

// 把 textarea 高度設成貼合內容(無 internal scroll)。caller 在 user 看不見的時機
// 呼叫(初始 render / saveEdits 後)避免閃動。重設 height='auto' 讓 scrollHeight 反
// 映 natural 高度,再寫回 px。最低 60px 對齊 CSS min-height。
function fitTextareaHeight(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.max(60, ta.scrollHeight) + 'px';
}

async function saveEdits() {
  if (!currentDoc) return;
  const blockMap = new Map();
  for (const page of currentDoc.pages) {
    for (const block of page.blocks) blockMap.set(block.blockId, block);
  }
  const rows = $('edit-list').querySelectorAll('.edit-block');
  for (const row of rows) {
    const block = blockMap.get(row.dataset.blockId);
    if (!block) continue;
    const text = row.querySelector('textarea').value;
    if (!text.trim()) {
      block.translation = '';
      block.translationSegments = [];
    } else {
      const { segments, linkUrls } = markdownToSegments(text);
      block.translationSegments = segments;
      block.translation = segments.map((s) => s.text).join('');
      // 保守 union linkUrls:user 新加的 + 原本有的（給其他依賴 block.linkUrls 的路徑用）
      if (linkUrls.length > 0) {
        const existing = new Set(Array.isArray(block.linkUrls) ? block.linkUrls : []);
        for (const u of linkUrls) existing.add(u);
        block.linkUrls = [...existing];
      }
    }
    block.translationStatus = 'done';
    block.translationError = null;
    block.userEdited = true; // 預留 flag,將來 retry / re-translate 路徑可跳過
  }
  // 重 render reader（renderReader 內部會 regenerateTranslatedPdf）
  await openReader();
}

function bindEditUI() {
  $('edit-cancel-btn').addEventListener('click', () => {
    if (currentDoc && currentReaderHandle) showStage('reader');
    else showStage('upload');
  });
  $('edit-save-btn').addEventListener('click', async () => {
    const btn = $('edit-save-btn');
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('doc.edit.btn.generating');
    try {
      await saveEdits();
    } catch (err) {
      console.error('[Shinkansen] saveEdits 失敗', err);
      btn.textContent = t('doc.edit.btn.failed');
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
      return;
    }
    btn.textContent = orig;
    btn.disabled = false;
  });
  bindFindReplaceUI();
  // 編輯頁鍵盤捷徑(只在 stage-edit 顯示時生效,不影響其他 stage):
  //   ⌘F / Ctrl+F:喚出 find bar(攔截瀏覽器原生搜尋——textarea 多區搜尋體驗差)
  //   ⌘G / Ctrl+G / F3:find bar 開啟時找下一個(focus 已經跳到 textarea 也能繼續走)
  //   ⇧⌘G / Shift+F3:找上一個
  //   Esc:關閉 find bar(若已開啟)
  document.addEventListener('keydown', (e) => {
    if (stages.edit.hidden) return;
    const findBarOpen = !$('edit-find-bar').hidden;
    if (e.key === 'Escape' && findBarOpen) {
      e.preventDefault();
      closeFindBar();
      return;
    }
    const isFindShortcut = (e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F');
    if (isFindShortcut) {
      e.preventDefault();
      openFindBar();
      return;
    }
    const isFindNext = e.key === 'F3' || ((e.metaKey || e.ctrlKey) && (e.key === 'g' || e.key === 'G'));
    if (isFindNext && findBarOpen && findMatches.length > 0) {
      e.preventDefault();
      findStep(e.shiftKey ? -1 : 1);
    }
  });
}

// ---------- Find & Replace（編輯頁，v1.8.49）----------
//
// 範圍:只搜「譯文 textarea」,不搜原文。case sensitive,不躲 markdown 標記
// (user 搜 `bold` 會在 `**bold**` 內命中——MVP 取捨,help bar 文檔有提)。
// matches 算法:每次 input 變化或值改變後 recompute,線性掃所有 textarea.value
// 用 indexOf 收集 [{ textarea, start, end }]。currentIndex 在 matches 內走。
//
// 替換策略:replaceCurrent 取代當前 match 後重算 matches、停留在「同 index」
// (等同自動跳到下一個未取代的 match);replaceAll 一次掃完所有 textarea,
// counter 暫時顯示「已取代 N 處」2 秒後恢復。

let findMatches = [];     // [{ textarea, start, end }]
let findCurrentIndex = -1;

function getEditTextareas() {
  return Array.from($('edit-list').querySelectorAll('.edit-translation'));
}

function recomputeFindMatches({ keepIndex = false } = {}) {
  const findStr = $('edit-find-input').value;
  const oldIdx = findCurrentIndex;
  findMatches = [];
  if (!findStr) {
    findCurrentIndex = -1;
    clearMatchHighlight();
    updateFindCounter();
    return;
  }
  for (const ta of getEditTextareas()) {
    const v = ta.value;
    let i = 0;
    while ((i = v.indexOf(findStr, i)) !== -1) {
      findMatches.push({ textarea: ta, start: i, end: i + findStr.length });
      i += findStr.length;
    }
  }
  if (findMatches.length === 0) {
    findCurrentIndex = -1;
  } else if (keepIndex && oldIdx >= 0) {
    findCurrentIndex = Math.min(oldIdx, findMatches.length - 1);
  } else {
    findCurrentIndex = 0;
  }
  updateFindCounter();
  if (findCurrentIndex >= 0) markMatch(findCurrentIndex);
  else clearMatchHighlight();
}

function updateFindCounter() {
  const total = findMatches.length;
  const cur = findCurrentIndex >= 0 ? findCurrentIndex + 1 : 0;
  $('edit-find-count').textContent = `${cur} / ${total}`;
  const empty = total === 0;
  $('edit-find-prev-btn').disabled = empty;
  $('edit-find-next-btn').disabled = empty;
  $('edit-replace-btn').disabled = empty;
  $('edit-replace-all-btn').disabled = !$('edit-find-input').value;
}

function clearMatchHighlight() {
  for (const ta of getEditTextareas()) {
    const wrap = ta.parentElement;
    if (wrap) wrap.classList.remove('edit-translation-wrap--current');
    const overlay = wrap && wrap.querySelector('.edit-highlight-overlay');
    if (overlay) overlay.innerHTML = '';
  }
}

// HTML escape(避免 user 譯文含 < > & 破 overlay 渲染)
function escapeOverlayHTML(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 從文字 + match 區段產出 overlay innerHTML(transparent 文字 + <mark> 高亮)
function buildOverlayHTML(text, marks) {
  if (!text) return '';
  if (!marks || marks.length === 0) return escapeOverlayHTML(text);
  let out = '';
  let cursor = 0;
  for (const m of marks) {
    if (m.start > cursor) out += escapeOverlayHTML(text.slice(cursor, m.start));
    out += `<mark${m.isCurrent ? ' class="is-current"' : ''}>${escapeOverlayHTML(text.slice(m.start, m.end))}</mark>`;
    cursor = m.end;
  }
  if (cursor < text.length) out += escapeOverlayHTML(text.slice(cursor));
  // 結尾換行 browser 渲染會吞掉,加 zero-width space 撐住高度避免最後一行對不齊
  if (text.endsWith('\n')) out += '​';
  return out;
}

// 重新渲染所有 textarea 的 overlay(根據當前 findMatches + findCurrentIndex)
function renderAllOverlays() {
  // 把 findMatches 按 textarea 分組,記每筆全域 index 用來標 isCurrent
  const byTa = new Map();
  findMatches.forEach((m, gi) => {
    if (!byTa.has(m.textarea)) byTa.set(m.textarea, []);
    byTa.get(m.textarea).push({ start: m.start, end: m.end, isCurrent: gi === findCurrentIndex });
  });
  for (const ta of getEditTextareas()) {
    const wrap = ta.parentElement;
    if (!wrap) continue;
    const overlay = wrap.querySelector('.edit-highlight-overlay');
    if (!overlay) continue;
    const marks = byTa.get(ta) || [];
    overlay.innerHTML = buildOverlayHTML(ta.value, marks);
    overlay.scrollTop = ta.scrollTop;
    overlay.scrollLeft = ta.scrollLeft;
  }
}

// 標示當前 match:wrap 加 ring class + scroll into view + 設 textarea selection
// (失焦時不可見,user click 進 textarea 才看到)。focus 不搶,find input 保留焦點。
function markMatch(idx) {
  const m = findMatches[idx];
  if (!m) return;
  for (const ta of getEditTextareas()) {
    const wrap = ta.parentElement;
    if (wrap) wrap.classList.remove('edit-translation-wrap--current');
  }
  const wrap = m.textarea.parentElement;
  if (wrap) wrap.classList.add('edit-translation-wrap--current');
  m.textarea.scrollIntoView({ block: 'center', behavior: 'smooth' });
  try { m.textarea.setSelectionRange(m.start, m.end); } catch (_) { /* 失焦時某些 browser 會丟 */ }
  renderAllOverlays();
}

function findStep(direction) {
  if (findMatches.length === 0) return;
  findCurrentIndex = (findCurrentIndex + direction + findMatches.length) % findMatches.length;
  updateFindCounter();
  markMatch(findCurrentIndex);
}

function replaceCurrent() {
  if (findCurrentIndex < 0 || findMatches.length === 0) return;
  const m = findMatches[findCurrentIndex];
  if (!m) return;
  const replaceStr = $('edit-replace-input').value;
  const v = m.textarea.value;
  m.textarea.value = v.slice(0, m.start) + replaceStr + v.slice(m.end);
  // 取代後重算,停在同 index → 自然跳到下一個未取代的 match
  recomputeFindMatches({ keepIndex: true });
}

function replaceAll() {
  const findStr = $('edit-find-input').value;
  const replaceStr = $('edit-replace-input').value;
  if (!findStr) return;
  let total = 0;
  for (const ta of getEditTextareas()) {
    const v = ta.value;
    if (!v.includes(findStr)) continue;
    let c = 0;
    let i = 0;
    while ((i = v.indexOf(findStr, i)) !== -1) {
      c++;
      i += findStr.length;
    }
    if (c > 0) {
      ta.value = v.split(findStr).join(replaceStr);
      total += c;
    }
  }
  // counter 暫時顯示取代結果,2 秒後重算
  $('edit-find-count').textContent = t('doc.edit.find.replaceCount', { n: total });
  clearMatchHighlight();
  setTimeout(() => recomputeFindMatches(), 2000);
}

function openFindBar() {
  const bar = $('edit-find-bar');
  bar.hidden = false;
  const input = $('edit-find-input');
  input.focus();
  input.select();
  recomputeFindMatches();
}

function closeFindBar() {
  $('edit-find-bar').hidden = true;
  findMatches = [];
  findCurrentIndex = -1;
  clearMatchHighlight();
}

function bindFindReplaceUI() {
  $('edit-find-input').addEventListener('input', () => recomputeFindMatches());
  $('edit-find-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      findStep(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFindBar();
    }
  });
  $('edit-replace-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      replaceCurrent();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFindBar();
    }
  });
  $('edit-find-prev-btn').addEventListener('click', () => findStep(-1));
  $('edit-find-next-btn').addEventListener('click', () => findStep(1));
  $('edit-replace-btn').addEventListener('click', replaceCurrent);
  $('edit-replace-all-btn').addEventListener('click', replaceAll);
  $('edit-find-close-btn').addEventListener('click', closeFindBar);
}

// ---------- 翻譯流程(W3) ----------

async function startTranslate() {
  if (!currentDoc) return;

  const { engine, modelOverride } = await resolvePreset();
  currentModelOverride = modelOverride;
  currentEngine = engine;

  showStage('translating');
  setProgress({
    totalBlocks: 0,
    translatedBlocks: 0,
    failedBlocks: 0,
    estimatedRemainingSec: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    cumulativeCostUSD: 0,
  });

  // v1.8.49:文章術語表來源是使用者編輯後的 currentArticleGlossary(取代既有
  // applyGlossary 黑箱 toggle)。沒術語表(null / 空)就不送,等同沒術語表
  const glossary = (Array.isArray(currentArticleGlossary) && currentArticleGlossary.length > 0)
    ? currentArticleGlossary
    : null;
  if (glossary) {
    console.log('[Shinkansen] using article glossary:', glossary.length, 'terms');
  }

  translateAbortController = new AbortController();
  let summary;
  try {
    summary = await translateDocument(currentDoc, {
      modelOverride,
      engine,
      glossary,
      signal: translateAbortController.signal,
      onProgress: setProgress,
    });
  } catch (err) {
    console.error('[Shinkansen] translateDocument 失敗', err);
    summary = {
      totalBlocks: 0,
      translatedBlocks: 0,
      failedBlocks: 0,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      cumulativeCostUSD: 0,
      cancelled: false,
      error: (err && err.message) || String(err),
    };
  }
  translateAbortController = null;

  // 存進 module state 供 reader-toolbar「翻譯紀錄」按鈕開的 dialog 顯示
  lastTranslateSummary = summary;

  // dev probe expose 翻譯結果
  if (window.__skLayoutDoc) {
    window.__skLayoutDoc.translateSummary = summary;
  }

  // 直接進雙頁閱讀器(原本中介的 stage-translated 已砍掉)
  await openReader();
}

// ---------- 文章術語表編輯（v1.8.49）----------
//
// state:currentArticleGlossary — null = 還沒建,[] = 建過但空,[{source,target,note?}] = 有效
// 入口:
//   1. stage-result「先建立文章術語表」按鈕 → openGlossaryEditor()(若 null 自動 extract)
//   2. reader「翻譯紀錄」dialog 內「編輯文章術語表」按鈕 → openGlossaryEditor()(同上)
// 出口:
//   1.「用此術語表翻譯」→ 寫回 currentArticleGlossary → startTranslate()
//      (從 reader 進來時會 confirm「會重打 API」)
//   2.「取消」→ 回 reader / result stage,currentArticleGlossary 不動
// 持久化:無。靠 user 自行匯出 / 匯入 JSON 跨次保存

async function openGlossaryEditor(fromStage = 'result') {
  if (!currentDoc) return;
  glossaryEntryStage = fromStage;
  showStage('glossary');
  // 若還沒建術語表(null)→ 顯 loading + 自動跑 EXTRACT_GLOSSARY 拿初始值。
  // 若已有(包含空 [])→ 直接 show table 讓使用者編輯
  if (currentArticleGlossary === null) {
    setGlossaryState(t('doc.glossary.state.loading'), 'is-loading');
    try {
      const extracted = await extractGlossaryForDoc(currentDoc);
      currentArticleGlossary = Array.isArray(extracted) ? extracted : [];
    } catch (err) {
      console.warn('[Shinkansen] glossary extract failed', err && err.message);
      currentArticleGlossary = [];
    }
  }
  buildGlossaryTable(currentArticleGlossary);
}

// grid 內 loading / empty placeholder(跨整列;append 新 row 時清掉)
function setGlossaryState(text, modifier = 'is-empty') {
  clearGlossaryEntries();
  const div = document.createElement('div');
  div.className = `glossary-state ${modifier}`;
  div.textContent = text;
  $('glossary-grid').appendChild(div);
  $('glossary-count').textContent = t('doc.glossary.countZero');
}

function clearGlossaryEntries() {
  // 保留 g-header,移除 entry inputs / buttons / state placeholder
  const grid = $('glossary-grid');
  for (const el of [...grid.children]) {
    if (!el.classList.contains('g-header')) el.remove();
  }
}

function buildGlossaryTable(entries) {
  clearGlossaryEntries();
  if (!entries || entries.length === 0) {
    setGlossaryState(t('doc.glossary.state.empty'), 'is-empty');
    return;
  }
  for (const e of entries) appendGlossaryRow(e, { skipUpdateCount: true });
  updateGlossaryCount();
}

function appendGlossaryRow(entry = { source: '', target: '' }, { skipUpdateCount = false } = {}) {
  const grid = $('glossary-grid');
  // 第一次加入 entry 時可能還在 placeholder state,先清掉
  const placeholder = grid.querySelector('.glossary-state');
  if (placeholder) placeholder.remove();

  const sourceInput = document.createElement('input');
  sourceInput.type = 'text';
  sourceInput.className = 'g-source';
  sourceInput.placeholder = t('doc.glossary.placeholder.source');
  sourceInput.value = entry.source || '';

  const targetInput = document.createElement('input');
  targetInput.type = 'text';
  targetInput.className = 'g-target';
  targetInput.placeholder = t('doc.glossary.placeholder.target');
  targetInput.value = entry.target || '';

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'glossary-row-delete';
  delBtn.textContent = t('doc.glossary.btn.delete');

  // 三個元素為一組 entry,delete 時一起拔
  delBtn.addEventListener('click', () => {
    sourceInput.remove();
    targetInput.remove();
    delBtn.remove();
    // 若清空到沒任何 entry,顯示 empty state
    if (!grid.querySelector('.g-source')) setGlossaryState(t('doc.glossary.state.empty'), 'is-empty');
    else updateGlossaryCount();
  });
  sourceInput.addEventListener('input', updateGlossaryCount);
  targetInput.addEventListener('input', updateGlossaryCount);

  grid.append(sourceInput, targetInput, delBtn);
  if (!skipUpdateCount) updateGlossaryCount();
}

function readGlossaryTable() {
  const out = [];
  // 每個 entry 在 grid 內是連續三 cell:source / target / delete-btn。
  // 走 .g-source 即可,nextElementSibling 一定是對應的 .g-target
  for (const sourceInput of $('glossary-grid').querySelectorAll('.g-source')) {
    const source = sourceInput.value.trim();
    const targetInput = sourceInput.nextElementSibling;
    const target = (targetInput && targetInput.classList.contains('g-target'))
      ? targetInput.value.trim() : '';
    // source + target 都有值才當有效 entry(只填 source 沒譯名 / 只填譯名沒原文都丟)
    if (source && target) out.push({ source, target });
  }
  return out;
}

function updateGlossaryCount() {
  $('glossary-count').textContent = t('doc.glossary.count', { n: readGlossaryTable().length });
}

function exportGlossaryJSON() {
  const entries = readGlossaryTable();
  if (entries.length === 0) {
    alert(t('doc.glossary.alert.empty'));
    return;
  }
  const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const baseName = (currentDoc?.meta?.filename || 'glossary').replace(/\.pdf$/i, '');
  a.download = `${baseName}-glossary.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}

async function handleGlossaryFileImport(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error(t('doc.glossary.alert.invalidJson'));
    const valid = data
      .filter((e) => e && typeof e.source === 'string' && typeof e.target === 'string')
      .map((e) => ({ source: e.source, target: e.target })); // 舊版 JSON 帶的 note 欄忽略
    if (valid.length === 0) throw new Error(t('doc.glossary.alert.noEntries'));
    const existing = readGlossaryTable();
    if (existing.length > 0) {
      if (!confirm(t('doc.glossary.confirm.import', { existing: existing.length, new: valid.length }))) return;
    }
    buildGlossaryTable(valid);
  } catch (err) {
    alert(t('doc.glossary.alert.importFail', { error: err.message || err }));
  }
}

async function reextractGlossary() {
  const existing = readGlossaryTable();
  if (existing.length > 0) {
    if (!confirm(t('doc.glossary.confirm.reextract', { n: existing.length }))) return;
  }
  const btn = $('glossary-reextract-btn');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = t('doc.glossary.btn.extracting');
  setGlossaryState(t('doc.glossary.state.loading'), 'is-loading');
  try {
    const extracted = await extractGlossaryForDoc(currentDoc);
    if (Array.isArray(extracted) && extracted.length > 0) {
      buildGlossaryTable(extracted);
    } else {
      buildGlossaryTable([]);
      alert(t('doc.glossary.alert.noExtract'));
    }
  } finally {
    btn.textContent = orig;
    btn.disabled = false;
  }
}

function bindGlossaryUI() {
  $('extract-glossary-btn').addEventListener('click', () => openGlossaryEditor('result'));
  $('edit-glossary-btn').addEventListener('click', () => openGlossaryEditor('edit'));
  $('glossary-add-row-btn').addEventListener('click', () => appendGlossaryRow());
  $('glossary-import-btn').addEventListener('click', () => {
    const fileInput = $('glossary-import-file');
    fileInput.value = '';
    fileInput.click();
  });
  $('glossary-import-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    handleGlossaryFileImport(file);
  });
  $('glossary-export-btn').addEventListener('click', exportGlossaryJSON);
  $('glossary-reextract-btn').addEventListener('click', reextractGlossary);
  $('glossary-cancel-btn').addEventListener('click', () => {
    // 回到打開 editor 的來源 stage(result / edit / reader)
    if (glossaryEntryStage === 'edit' && currentReaderHandle) showStage('edit');
    else if (glossaryEntryStage === 'reader' && currentReaderHandle) showStage('reader');
    else showStage('result');
  });
  $('glossary-translate-btn').addEventListener('click', async () => {
    currentArticleGlossary = readGlossaryTable();
    // 從 result 第一次翻譯不需要 confirm;從 edit / reader 進來都是「已翻過要重翻」要警告
    if (glossaryEntryStage === 'edit') {
      if (!confirm(t('doc.glossary.confirm.translateUnsaved'))) return;
    } else if (currentReaderHandle) {
      if (!confirm(t('doc.glossary.confirm.translate'))) return;
    }
    await startTranslate();
  });
}

async function fillSummaryDialog(summary) {
  if (!summary) return;
  const filename = (currentDoc && currentDoc.meta && currentDoc.meta.filename) || t('doc.settings.preset.unnamed');
  $('translated-filename').textContent = filename;
  $('translated-count').textContent = `${summary.translatedBlocks - summary.failedBlocks} / ${summary.totalBlocks}`;
  // 翻譯失敗用「當前 doc 的實際失敗段數」(使用者可能已在編輯頁手動修過,
  // 跟 summary.failedBlocks 不同),同時控制 retry 按鈕顯隱
  refreshSummaryFailedDisplay();
  const cacheHits = summary.cacheHits || 0;
  $('translated-cache-hits').textContent = cacheHits > 0 && summary.totalBlocks > 0
    ? t('doc.summary.cacheHitRate', { n: cacheHits, percent: ((cacheHits / summary.totalBlocks) * 100).toFixed(0) })
    : '0';
  $('translated-input-tokens').textContent = summary.cumulativeInputTokens.toLocaleString('en-US');
  $('translated-output-tokens').textContent = summary.cumulativeOutputTokens.toLocaleString('en-US');
  // 跟主設定的 displayCurrency + cached rate 一致(USD / TWD 切換)
  $('translated-cost').textContent = await formatCostStr(summary.cumulativeCostUSD);
}

async function formatCostStr(usd) {
  try {
    const [{ displayCurrency = 'TWD' }, rateInfo] = await Promise.all([
      chrome.storage.sync.get('displayCurrency'),
      getCachedRate(),
    ]);
    return formatMoney(usd, { currency: displayCurrency, rate: rateInfo?.rate || FALLBACK_USD_TWD_RATE });
  } catch (_) {
    return formatMoney(usd, { currency: 'USD' });
  }
}

function setProgress(p) {
  const ratio = p.totalBlocks > 0 ? (p.translatedBlocks / p.totalBlocks) : 0;
  $('translate-progress-fill').style.width = `${(ratio * 100).toFixed(1)}%`;
  $('translate-progress-count').textContent = t('doc.translating.progress.count', { translated: p.translatedBlocks, total: p.totalBlocks });
  $('translate-progress-eta').textContent = p.estimatedRemainingSec > 0
    ? t('doc.translating.progress.eta', { time: formatSec(p.estimatedRemainingSec) })
    : '';
  $('translate-progress-cost').textContent = p.cumulativeCostUSD > 0
    ? t('doc.translating.progress.cost', { cost: p.cumulativeCostUSD.toFixed(4) })
    : '';
  if (p.failedBlocks > 0) {
    $('translate-progress-failed').textContent = t('doc.translating.progress.failed', { n: p.failedBlocks });
    $('translate-progress-failed').hidden = false;
  } else {
    $('translate-progress-failed').hidden = true;
  }
}

function formatSec(sec) {
  if (sec < 60) return t('doc.translating.timeSec', { n: sec });
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return t('doc.translating.timeMinSec', { m, s });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
