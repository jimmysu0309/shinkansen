// pdf-engine.js — PDF.js wrapper
//
// W1 階段：本檔負責用 PDF.js 載入 PDF File 物件，抽出每頁的 text run + bbox +
// font + page viewport，輸出原始 raw 結構供下游消費。版面演算法（column 偵測 /
// block 切分 / type 分類）在 W2 才會加進來。

import * as pdfjsLib from '../lib/vendor/pdfjs/pdf.min.mjs';

// MV3 不能跨 origin 載 worker，必須 vendor 進 extension 並用 chrome.runtime.getURL 指過去
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/vendor/pdfjs/pdf.worker.min.mjs');

// 上限與軟警告依 SPEC §17.2
export const LIMITS = Object.freeze({
  hardMaxPages: 50,
  hardMaxBytes: 10 * 1024 * 1024,
  softWarnPages: 30,
  softWarnBytes: 5 * 1024 * 1024,
});

// 已知不支援的 PDF 樣態（SPEC §17.2）——抽完文字後再判斷
const SCANNED_PDF_TEXT_THRESHOLD = 50; // 整份 < 50 個非空白字 → 視為掃描檔
const GARBLED_FONT_NON_PRINTABLE_RATIO = 0.5; // 非 ASCII printable / 控制字元比例 > 50% → 字型映射不完整

// run bbox 落在 viewport 外多遠時視為「PDF 邏輯邊界外」直接丟棄
// (PowerPoint / Excel 匯出 PDF 常見:寬 table 繪製在邏輯 page 之外,page transform
// 才把它縮回頁內顯示。viewport.transform 套上後仍超出 viewport 一定距離以上的 run
// 在實際 PDF reader 視覺上看不到,不該抽出來翻譯。)
const VIEWPORT_OUTSIDE_TOLERANCE_PT = 4;

// 6-element affine matrix multiply(同 PDF.js Util.transform):
// 套 m1 × m2 兩個 transform。viewport.transform × item.transform 即可把 raw text
// matrix 座標映射到 canvas viewport 座標(y 由上往下,範圍 [0, w] × [0, h])
function matMul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export class PdfParseError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
  }
}

/**
 * 上傳前檢查：檔案大小、副檔名/MIME。頁數要等載入後才知道。
 * 回傳 { level: 'ok' | 'warn' | 'error', message?: string }
 */
export function preflightFile(file) {
  if (!file) return { level: 'error', message: '未選取檔案' };
  const isPdfMime = file.type === 'application/pdf' || file.type === '';
  const isPdfExt = /\.pdf$/i.test(file.name || '');
  if (!isPdfMime && !isPdfExt) {
    return { level: 'error', message: '檔案類型不符，請選擇 PDF' };
  }
  if (file.size > LIMITS.hardMaxBytes) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return { level: 'error', message: `檔案 ${mb} MB 超過 ${LIMITS.hardMaxBytes / 1024 / 1024} MB 上限,請先拆分後再上傳` };
  }
  if (file.size > LIMITS.softWarnBytes) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return { level: 'warn', message: `檔案 ${mb} MB 較大,翻譯時間會較長` };
  }
  return { level: 'ok' };
}

/**
 * 主入口：讀 File → 抽 text run → 回傳 raw 結構。
 *
 * @param {File} file
 * @param {(progress: { stage: string, current?: number, total?: number }) => void} [onProgress]
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] — 取消信號;page loop 每頁開頭檢查,
 *        aborted 時 throw PdfParseError('aborted') 並釋放 pdfDoc
 * @returns {Promise<RawPdfDocument>}
 */
export async function parsePdf(file, onProgress = () => {}, options = {}) {
  onProgress({ stage: 'reading' });
  const buffer = await file.arrayBuffer();

  onProgress({ stage: 'opening' });
  let pdfDoc;
  try {
    const loadingTask = pdfjsLib.getDocument({
      data: buffer,
      // 關閉預設的 disableFontFace，讓 PDF.js 走 Worker 字型解析（更快、能拿到 fontName）
      disableFontFace: false,
      // 不渲染、只抽 text 的場景下用 streams=false 的差別不大，留預設
    });
    pdfDoc = await loadingTask.promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') {
      throw new PdfParseError('encrypted', '此 PDF 受密碼保護或加密，請先解除保護', err);
    }
    if (err && err.name === 'InvalidPDFException') {
      throw new PdfParseError('invalid', '檔案不是有效的 PDF', err);
    }
    throw new PdfParseError('open-failed', `無法開啟 PDF:${err && err.message ? err.message : String(err)}`, err);
  }

  // pdfDoc 開啟後的所有後續處理:中途任何 throw(too-many-pages / scanned / 取消 /
  // 非預期例外)都先 destroy pdfDoc 再 rethrow — caller 只在成功回傳後才接手
  // pdfDoc 的釋放責任,中途失敗不留 PDF.js Worker 資源洩漏
  try {
    return await extractRawDoc(pdfDoc, file, onProgress, options);
  } catch (err) {
    closeDocument(pdfDoc);
    throw err;
  }
}

// parsePdf 本體:從已開啟的 pdfDoc 抽每頁 text run。中途 throw 時由 parsePdf
// 統一釋放 pdfDoc,本函式內不需要逐分支 destroy
async function extractRawDoc(pdfDoc, file, onProgress, options) {
  const { signal } = options || {};
  const pageCount = pdfDoc.numPages;
  if (pageCount > LIMITS.hardMaxPages) {
    throw new PdfParseError('too-many-pages', `PDF 共 ${pageCount} 頁,超過 ${LIMITS.hardMaxPages} 頁上限`);
  }

  const pages = [];
  let totalChars = 0;
  let nonPrintable = 0;
  let printable = 0;
  let droppedRotatedTotal = 0;

  // metadata(title 用於 result UI)
  let title = file.name || '';
  try {
    const meta = await pdfDoc.getMetadata();
    if (meta && meta.info && meta.info.Title) {
      title = meta.info.Title;
    }
  } catch (_) {
    // metadata 失敗不影響後續處理
  }

  // 首頁尺寸（SPEC §17.4.2 假設全 PDF 同尺寸，取首頁）
  let firstPageSize = { width: 0, height: 0 };

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    // 使用者按「取消」:立即停掉 page loop(parse 真的中止,不是只有 UI 切走)
    if (signal && signal.aborted) {
      throw new PdfParseError('aborted', '已取消解析');
    }
    onProgress({ stage: 'page', current: pageIndex + 1, total: pageCount });
    const page = await pdfDoc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1.0 });
    if (pageIndex === 0) {
      firstPageSize = { width: viewport.width, height: viewport.height };
    }

    let textContent;
    try {
      textContent = await page.getTextContent({
        // 不要把相鄰 item 合成一條長字串——保留每個 text run 的 bbox 才能做版面分析
        disableCombineTextItems: false,
        includeMarkedContent: false,
      });
    } catch (err) {
      pages.push({
        pageIndex,
        viewport: { width: viewport.width, height: viewport.height },
        textRuns: [],
        textRunError: err && err.message ? err.message : String(err),
      });
      page.cleanup();
      continue;
    }

    // W7:per-run linkUrl — 抽 link annotations,把 PDF y-up rect 轉成 canvas
    // y-down rect,後面對每個 textRun bbox 中心點落入即標 linkUrl
    let linkRectsCanvas = [];
    try {
      const annotations = await page.getAnnotations();
      for (const a of annotations) {
        if (a.subtype !== 'Link') continue;
        const url = a.url || a.unsafeUrl || null;
        if (!url || !Array.isArray(a.rect) || a.rect.length !== 4) continue;
        // PDFviewer.convertToViewportRectangle 把 PDF rect [x1,y1,x2,y2] (y-up)
        // 轉成 canvas [x1',y1',x2',y2'] (y-down,範圍可能 y2' < y1' 或反之,
        // 標準化成 left/top/right/bottom)
        const r = viewport.convertToViewportRectangle(a.rect);
        const left = Math.min(r[0], r[2]);
        const right = Math.max(r[0], r[2]);
        const top = Math.min(r[1], r[3]);
        const bottom = Math.max(r[1], r[3]);
        linkRectsCanvas.push({ left, top, right, bottom, url });
      }
    } catch (_) {
      // link 抽失敗不影響正常翻譯,降級成「沒 link」
    }

    // W7:per-run isItalic + isBold — 從 textContent.styles + commonObjs 推
    // PDF.js textContent.styles 沒提供 italic / bold flag,要從 fontFamily 或
    // 真實 font 物件的 .italic/.bold/name 反推。先用 family regex 蓋大宗
    // (family 常含 "Italic"/"Bold"/"-It"),沒命中再用 commonObjs 反查
    const ITALIC_RE = /Italic|Oblique|-It\b|-Obl\b/i;
    const BOLD_RE = /Bold|Black|Heavy|Demi|Semi/i;
    const styleIsItalic = {};
    const styleIsBold = {};
    if (textContent.styles) {
      for (const fn of Object.keys(textContent.styles)) {
        const s = textContent.styles[fn];
        const family = (s && s.fontFamily) || '';
        styleIsItalic[fn] = ITALIC_RE.test(family);
        styleIsBold[fn] = BOLD_RE.test(family);
      }
    }
    // 用 commonObjs 反查字型物件補完(family 沒 keyword 但 font.italic/.bold)
    try {
      await page.getOperatorList(); // 觸發 worker font load
      for (const fn of Object.keys(styleIsItalic)) {
        if (styleIsItalic[fn] && styleIsBold[fn]) continue;
        try {
          const font = await new Promise((resolve) => page.commonObjs.get(fn, resolve));
          const name = (font && font.name) || '';
          if (!styleIsItalic[fn]) {
            styleIsItalic[fn] = (font && font.italic === true) || ITALIC_RE.test(name);
          }
          if (!styleIsBold[fn]) {
            styleIsBold[fn] = (font && font.bold === true) || BOLD_RE.test(name);
          }
        } catch {
          // 拿不到 font 物件 → 維持 false
        }
      }
    } catch (_) {
      // operatorList 失敗不影響其他
    }

    const textRuns = [];
    let droppedOutsideViewport = 0;
    let droppedRotated = 0;
    for (const item of textContent.items) {
      // PDF.js TextItem.transform 是 raw text matrix [scaleX, skewY, skewX, scaleY, x, y]
      // 在 PDF 座標系下(y 由下往上)。某些 PDF(PowerPoint/Excel 匯出)的 raw 座標
      // 會落在 page CropBox 之外,page transform 才把它縮回 viewport 內顯示。
      // 我們套 viewport.transform × item.transform → canvas 座標(y 由上往下,
      // 範圍 [0, viewport.width] × [0, viewport.height])再算 bbox。
      if (typeof item.str !== 'string' || item.str.length === 0) continue;
      // 純空白 run 直接丟棄。PDF 常見做法:用一個寬達數百 pt 的 ` ` text item 填滿
      // 跨欄 spacer(我們在 Bi-Weekly Report 看到 width=470pt 的單一空白 run 把
      // 左欄 heading 跟右欄 PM info 黏在一起)。layout-analyzer 流式合併會把這
      // 空白當 line 的一部分,line.bbox 一路擴張到右欄,後面所有右欄 run 被誤吞。
      // plainText 構建用 runs.join(' ') 自動帶 space,丟空白 run 不影響譯文輸出。
      if (item.str.trim().length === 0) continue;

      const m = matMul(viewport.transform, item.transform);
      // 旋轉 / 直排文字 run 偵測:對水平 run,m[1](y 向旋轉分量)≈ 0、|m[0]|
      // (水平 scale)≈ fontSize。下方 bbox 公式假設 run 水平(top = baseline -
      // fontSize、right = left + width),對旋轉 run 算出的 bbox 完全錯位 → 下游
      // mask / 譯文位置全錯。丟棄不送翻(計數告警,doc warning 提示使用者)。
      // 閾值 0.09 ≈ tan(5°):偏離水平超過約 5° 即丟。原條件 |m[1]| > |m[0]|
      // 只擋 >45°(直排 / 90° 軸標籤),斜 30-40° 的對角浮水印(「PROPRIETARY
      // AND CONFIDENTIAL」斜印)漏過,axis-aligned bbox 橫跨半頁 → 譯成一條
      // 水平大字蓋住頁面內容(Stella 簡報實測)。合法水平 run 的 m[1] ≈ 0,
      // 5° 容忍值涵蓋數值雜訊;synthetic italic 的 skew 在 m[2],不受此條件影響。
      // 已知限制:RTL(item.dir === 'rtl')的 dir 欄位有抽但下游尚未消費,
      // RTL 文字仍按 LTR bbox 處理
      if (Math.abs(m[1]) > Math.abs(m[0]) * 0.09) {
        droppedRotated++;
        continue;
      }
      // m 套完 viewport.transform 後是 6-element affine。對沒有旋轉/翻轉的 PDF:
      //   m[0] = horizontal scale = fontSize, m[3] = vertical scale = -fontSize(因 viewport y 翻轉)
      //   m[4] = baseline x(canvas), m[5] = baseline y(canvas)
      // PDF.js TextItem.width / height 已是 CSS px(在 scale=1 viewport 下 = pt),
      // 直接加到 baseline 不再乘 fontSize(這是地雷:乘了會把 bbox 暴增 fontSize 倍)。
      const fontSize = Math.hypot(m[2], m[3]);
      const left = m[4];
      const baselineY = m[5];
      const top = baselineY - fontSize;
      const right = left + (item.width || 0);
      const bottom = baselineY;

      // 視覺上落在 viewport 外的 run 跳過(縮放異常 PDF 才會走到這)
      if (
        right < -VIEWPORT_OUTSIDE_TOLERANCE_PT ||
        left > viewport.width + VIEWPORT_OUTSIDE_TOLERANCE_PT ||
        bottom < -VIEWPORT_OUTSIDE_TOLERANCE_PT ||
        top > viewport.height + VIEWPORT_OUTSIDE_TOLERANCE_PT
      ) {
        droppedOutsideViewport++;
        continue;
      }

      const styleEntry = textContent.styles && textContent.styles[item.fontName];
      const fontFamily = styleEntry && styleEntry.fontFamily ? styleEntry.fontFamily : '';
      const ascent = styleEntry && typeof styleEntry.ascent === 'number' ? styleEntry.ascent : null;
      const descent = styleEntry && typeof styleEntry.descent === 'number' ? styleEntry.descent : null;

      // W7:linkUrl — 中心點落入哪個 link rect 就標哪個 url
      let linkUrl = null;
      if (linkRectsCanvas.length > 0) {
        const cx = (left + right) / 2;
        const cy = (top + bottom) / 2;
        for (const lr of linkRectsCanvas) {
          if (cx >= lr.left && cx <= lr.right && cy >= lr.top && cy <= lr.bottom) {
            linkUrl = lr.url;
            break;
          }
        }
      }
      // W7:isItalic / isBold — 用 styleIsItalic/Bold 表查
      const isItalic = !!styleIsItalic[item.fontName];
      const isBold = !!styleIsBold[item.fontName];

      textRuns.push({
        text: item.str,
        // canvas 座標(y 由上往下),bbox = [left, top, right, bottom]
        bbox: [left, top, right, bottom],
        fontSize,
        fontName: item.fontName || '',
        fontFamily,
        ascent,
        descent,
        hasEOL: !!item.hasEOL,
        dir: item.dir || 'ltr',
        isItalic,
        isBold,
        linkUrl,
      });

      totalChars += item.str.length;
      for (const ch of item.str) {
        const cp = ch.codePointAt(0);
        if (cp < 32 || cp === 127) {
          nonPrintable++;
        } else {
          printable++;
        }
      }
    }
    if (droppedOutsideViewport > 0) {
      console.log(`[Shinkansen] page ${pageIndex + 1}: 丟棄 ${droppedOutsideViewport} 個 viewport 外的 text run`);
    }
    if (droppedRotated > 0) {
      console.log(`[Shinkansen] page ${pageIndex + 1}: 丟棄 ${droppedRotated} 個旋轉 / 直排 text run(bbox 假設不適用,不送翻)`);
      droppedRotatedTotal += droppedRotated;
    }

    pages.push({
      pageIndex,
      viewport: { width: viewport.width, height: viewport.height },
      textRuns,
    });
    page.cleanup();
  }

  // 偵測掃描 PDF / 字型亂碼（SPEC §17.2）
  const warnings = [];
  if (totalChars < SCANNED_PDF_TEXT_THRESHOLD) {
    throw new PdfParseError('scanned', '此 PDF 為掃描影像或無可抽取文字，本工具不支援 OCR');
  }
  const totalCharsForRatio = printable + nonPrintable;
  if (totalCharsForRatio > 0) {
    const nonPrintableRatio = nonPrintable / totalCharsForRatio;
    if (nonPrintableRatio > GARBLED_FONT_NON_PRINTABLE_RATIO) {
      warnings.push({
        code: 'garbled-fonts',
        message: '此 PDF 字型映射不完整，翻譯品質可能受影響',
      });
    }
  }
  if (droppedRotatedTotal > 0) {
    warnings.push({
      code: 'rotated-text-dropped',
      message: `此 PDF 含 ${droppedRotatedTotal} 段旋轉或直排文字，該部分維持原文不翻譯`,
    });
  }

  // pdfDoc 不在此 destroy——caller(index.js) 需要保留它供 debug overlay
  // render canvas 用,closeDocument() 由 caller 在切到下一檔 / 重新上傳時呼叫。
  return {
    meta: {
      title,
      filename: file.name,
      bytes: file.size,
      pageCount,
      pageSize: firstPageSize,
    },
    pages,
    stats: {
      totalChars,
      totalRuns: pages.reduce((sum, p) => sum + (p.textRuns ? p.textRuns.length : 0), 0),
    },
    warnings,
    pdfDoc,
  };
}

/**
 * 把指定頁 render 到 canvas（給 debug overlay / 線上閱讀器用）。
 * scale 預設 1.5——比螢幕原生稍大讓文字邊緣銳利,過大會讓 SVG overlay 變慢。
 *
 * 對 HiDPI / Retina 螢幕(DPR > 1),canvas internal bitmap 用 `scale × DPR` 算,
 * 讓一個 device pixel 對映一個 canvas pixel,文字邊緣不會被瀏覽器 upscale 模糊。
 * 回傳的 width / height 仍以 `scale` 為基準(CSS pixels),caller 拿來算 layout
 * (reader 的 zoom / debug overlay 的 SVG viewBox)時不變。canvas CSS 顯示尺寸
 * 走 `width: 100%` 跟著 parent,parent 用 baseW(=回傳 width)× zoom 設置。
 *
 * @param {object} pdfDoc            PDF.js 的 PDFDocumentProxy
 * @param {number} pageIndex         0-based
 * @param {HTMLCanvasElement} canvas 目標 canvas
 * @param {number} [scale=1.5]
 * @returns {Promise<{ width: number, height: number, scale: number }>}
 */
export async function renderPageToCanvas(pdfDoc, pageIndex, canvas, scale = 1.5) {
  const page = await pdfDoc.getPage(pageIndex + 1);
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const cssViewport = page.getViewport({ scale });
  const renderViewport = page.getViewport({ scale: scale * dpr });
  canvas.width = Math.ceil(renderViewport.width);
  canvas.height = Math.ceil(renderViewport.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
  page.cleanup();
  return { width: cssViewport.width, height: cssViewport.height, scale };
}

/**
 * 釋放 PDFDocumentProxy。caller 在切檔 / 離開頁時呼叫。
 */
export function closeDocument(pdfDoc) {
  if (pdfDoc && typeof pdfDoc.destroy === 'function') {
    try { pdfDoc.destroy(); } catch (_) { /* ignore */ }
  }
}

/**
 * @typedef {Object} RawTextRun
 * @property {string} text
 * @property {[number, number, number, number]} bbox  Canvas viewport 座標 [left, top, right, bottom]（y 由上往下,套過 viewport.transform）
 * @property {number} fontSize
 * @property {string} fontName       PDF.js 內部字型 ID（例 g_d0_f1）
 * @property {string} fontFamily     從 textContent.styles 拿的 family 名稱
 * @property {number|null} ascent
 * @property {number|null} descent
 * @property {boolean} hasEOL
 * @property {string} dir            'ltr' / 'rtl' / 'ttb'
 * @property {boolean} isItalic      W7:從 fontFamily / commonObjs.font.italic 推
 * @property {boolean} isBold        W7:從 fontFamily / commonObjs.font.bold 推
 * @property {string|null} linkUrl   W7:bbox 中心點落入 link annotation 的 url
 *
 * @typedef {Object} RawPdfPage
 * @property {number} pageIndex
 * @property {{ width: number, height: number }} viewport  scale=1 的頁面尺寸（pt）
 * @property {RawTextRun[]} textRuns
 * @property {string} [textRunError]  抽取失敗時填，該頁 textRuns 為空陣列
 *
 * @typedef {Object} RawPdfDocument
 * @property {Object} meta
 * @property {RawPdfPage[]} pages
 * @property {Object} stats
 * @property {Array<{code: string, message: string}>} warnings
 */
