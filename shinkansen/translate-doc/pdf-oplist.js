// pdf-oplist.js — PDF.js operator list 的輕量判斷（批次 7 §6.4，2026-09-14）
//
// 解析階段（pdf-engine.js parsePdf，opList 已為字型載入取得）與 renderer
//（pdf-renderer.js 底色取樣前置判斷）共用的單一資料源。獨立成檔是因為 renderer 不能
// import pdf-engine.js——那支模組載入時就呼叫 chrome.runtime.getURL 設 worker 路徑，
// node 端的 renderer unit spec 沒有這個 API 會炸。
import * as pdfjsLib from '../lib/vendor/pdfjs/pdf.min.mjs';

/**
 * 頁面是否可能有彩色底（有任何填色 / 影像 / 漸層 / form 繪圖指令）。純文字頁回 false，
 * renderer 據此跳過整頁 rasterize 取樣（書籍 / 論文類 200 頁實測每頁 ≈ 0.2s）。
 * opList 缺席 / 結構不明 → true（保守：照樣取樣）。
 */
export function pageMayHaveColoredBackground(opList) {
  const OPS = pdfjsLib.OPS;
  if (!opList || !opList.fnArray || !OPS) return true;
  const colorOps = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke,
    OPS.shadingFill, OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintJpegXObject, OPS.paintImageMaskXObject,
    OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat, OPS.paintImageMaskXObjectGroup, OPS.paintFormXObjectBegin, OPS.beginGroup].filter((v) => v != null));
  return opList.fnArray.some((fn) => colorOps.has(fn));
}

/**
 * 頁面上點陣圖的外框（canvas 座標，y 向下，[left, top, right, bottom]）。版面分析用它判斷
 * 「段落旁邊有圖」：文字 block 的外框是矩形，繞圖段落的窄行與寬行併成一塊時矩形會蓋到圖的
 * 位置；渲染端擴框時也要知道圖在哪（原本只認得文字 block）。
 * 追蹤 save / restore / transform / form XObject 的 CTM，在 paintImage* 指令處取單位方形的
 * 外接矩形。只收看得出是「一張圖」的尺寸：太小的（圖示、項目符號、分隔線）與幾乎整頁的
 *（底圖、掃描底）都不收。opList 結構不明回空陣列（等同沒有圖，行為與舊版相同）。
 */
export function extractImageRects(opList, viewportTransform, pageWidth, pageHeight) {
  const OPS = pdfjsLib.OPS;
  if (!opList || !opList.fnArray || !opList.argsArray || !OPS || !Array.isArray(viewportTransform)) return [];
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintJpegXObject].filter((v) => v != null));
  const mul = (m, c) => [
    m[0] * c[0] + m[1] * c[2], m[0] * c[1] + m[1] * c[3],
    m[2] * c[0] + m[3] * c[2], m[2] * c[1] + m[3] * c[3],
    m[4] * c[0] + m[5] * c[2] + c[4], m[4] * c[1] + m[5] * c[3] + c[5],
  ];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const rects = [];
  const vt = viewportTransform;
  const pageArea = (pageWidth || 0) * (pageHeight || 0);
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];
    if (fn === OPS.save) { stack.push(ctm); continue; }
    if (fn === OPS.restore) { if (stack.length) ctm = stack.pop(); continue; }
    if (fn === OPS.transform) {
      if (args && args.length >= 6) ctm = mul(args, ctm);
      continue;
    }
    if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = args && args[0];
      if (m && m.length >= 6) ctm = mul(m, ctm);
      continue;
    }
    if (fn === OPS.paintFormXObjectEnd) { if (stack.length) ctm = stack.pop(); continue; }
    if (!imageOps.has(fn)) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [ux, uy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const px = ctm[0] * ux + ctm[2] * uy + ctm[4];
      const py = ctm[1] * ux + ctm[3] * uy + ctm[5];
      const cx = vt[0] * px + vt[2] * py + vt[4];
      const cy = vt[1] * px + vt[3] * py + vt[5];
      if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
    }
    const w = x1 - x0, h = y1 - y0;
    if (!(w >= IMAGE_RECT_MIN_SIDE_PT && h >= IMAGE_RECT_MIN_SIDE_PT)) continue;
    if (pageArea > 0 && w * h >= pageArea * IMAGE_RECT_MAX_PAGE_AREA_RATIO) continue;
    rects.push([x0, y0, x1, y1]);
  }
  return rects;
}
// 圖片外框的收錄門檻：邊長至少 24pt（小於此多半是圖示 / 項目符號），面積不到頁面的 60%（更大的是底圖）
const IMAGE_RECT_MIN_SIDE_PT = 24;
const IMAGE_RECT_MAX_PAGE_AREA_RATIO = 0.6;
