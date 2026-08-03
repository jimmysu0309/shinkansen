// pdf-renderer.js — 譯文 PDF 下載(W6,SPEC §17.8)
//
// 流程(W6-iter2):
//   1. 讀原 PDF ArrayBuffer
//   2. pdf-lib 創新 PDFDocument + registerFontkit + embedFont(NotoSansTC TTF)
//   3. 對每頁 i:
//      - addPage 創新頁(同 viewport size)
//      - embedPages 把原 page i 變成 form XObject + drawPage 畫到新頁底層
//      - 對每個 translatable block:drawRectangle 白底蓋原文位置 + drawText 譯文(用 cjkFont)
//      - 不可翻譯 type / failed block → 不蓋，讓底層原文 visible
//   4. PDFDocument.save() → Uint8Array → Blob → trigger download
//
// 視覺等同 reader 那種「換成中文版的 PDF」(裝飾元素留 / 譯文蓋原文位置),
// 而非雙頁並排對照。原本 W6-iter1 設計每頁 [原頁 + 譯文頁] 雙頁並排，W6-iter2 改成
// 「只譯文頁(原頁當底層裝飾)」，因為使用者實際需求是看譯文版，原頁可隨時開原 PDF 看。
//
// 字型:vendor 的 NotoSansTC-Regular.ttf(SIL OFL,11.4MB TrueType Variable Font);
// pdf-lib subset: true 在最終 PDF 內只 embed 譯文用到的字,通常 100-300KB,
// 不影響譯文 PDF 大小。
// (原本 vendor OTF/CFF 版本,fontkit 1.1.1 對 CFF-based OTF subset 是已知問題,
//  輸出 PDF 中文字會 render 成 broken glyphs;TTF/TrueType 沒此 issue)
//
// 依賴:window.PDFLib(@cantoo/pdf-lib UMD,hopding/pdf-lib 1.17.1 的活躍 fork,
// 補上 mozilla/pdf.js port 的 AES decrypt 支援)、window.fontkit(fontkit UMD,
// 給 embedFont 用)— 由 index.html 用 <script src> 載入 vendor min.js,page 級 globals
//
// 加密 PDF 處理:`PDFDocument.load(...)` 必須帶 `{ ignoreEncryption: true,
// password: '' }`。
//   - 不帶 password 參數:cantoo 走「強制忽略加密但物件仍是密」分支,後續
//     embedPages 會在 `PDFContext.lookup(pagesRef)` 拿到 undefined 而炸
//   - 帶 password='' 觸發 cantoo 的 decryption 路徑,實測對 AESv2 + R=4 + 空
//     user pwd + owner-only 限制的 PDF(如 Trimble 系列 spec sheet)可順利
//     解開,生成譯文 PDF
//
// Link annotation preservation:embedPages 把原 page 嵌成 form XObject 時不會
// 自動拷貝 /Annots,所以原 PDF 的 link 在譯文 PDF 完全消失。修法是另外用 PDF.js
// 在原 PDF 上跑 page.getAnnotations() 拿 Link list (rect + url),再用
// pdf-lib 在新 page 上構造對等的 Link annotation dict,呼叫 page.node.addAnnot
// 加進新 page 的 /Annots
//
// Bold preservation:vendor 兩把字型 NotoSansTC-Regular.ttf + NotoSansTC-Bold.ttf,
// 用 PDF.js commonObjs 拿原 PDF 每個 fontName 的 .bold 屬性 / name regex,把
// textContent items 標 isBold,對每個 layout block 算 bold 字符比例 ≥ 50% 為
// bold block,drawTranslatedOverlay 對 bold block 用 boldFont 寫

import * as pdfjsLib from '../lib/vendor/pdfjs/pdf.min.mjs';
import { TRANSLATABLE_TYPES } from './block-types.js';

const FONT_PATH_REGULAR = 'lib/vendor/fonts/NotoSansTC-Regular.ttf';
const FONT_PATH_BOLD = 'lib/vendor/fonts/NotoSansTC-Bold.ttf';

async function loadFontBytes(path, cacheRef) {
  if (cacheRef.value) return cacheRef.value;
  const url = chrome.runtime.getURL(path);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`字型載入失敗：${res.status} (${path})`);
  cacheRef.value = await res.arrayBuffer();
  return cacheRef.value;
}
const regularRef = { value: null };
const boldRef = { value: null };
const loadCJKRegularBytes = () => loadFontBytes(FONT_PATH_REGULAR, regularRef);
const loadCJKBoldBytes = () => loadFontBytes(FONT_PATH_BOLD, boldRef);

/**
 * 生成譯文 PDF 的核心 pipeline(供 reader WYSIWYG render + 下載按鈕共用)。
 * 不觸發 download,只回傳 bytes 與 filename
 *
 * @param {ArrayBuffer} originalArrayBuffer
 * @param {LayoutDoc}   layoutDoc
 * @param {object}      [options]
 * @param {(p: { stage: string, current?: number, total?: number }) => void} [options.onProgress]
 * @returns {Promise<{ bytes: Uint8Array, filename: string, byteLength: number }>}
 */
export async function buildBilingualPdf(originalArrayBuffer, layoutDoc, options = {}) {
  const { onProgress = () => {} } = options;
  if (!window.PDFLib) throw new Error('pdf-lib 未載入(index.html <script> 標籤少？)');
  if (!window.fontkit) throw new Error('fontkit 未載入');
  const { PDFDocument } = window.PDFLib;

  onProgress({ stage: 'init' });
  const newDoc = await PDFDocument.create();
  newDoc.registerFontkit(window.fontkit);

  // load + embed CJK 字型 Regular + Bold(兩把都 subset: true,最終 PDF 只含
  // 譯文實際用到的字。Regular 11.4MB / Bold 6.8MB,subset 後通常各 100-300KB)
  onProgress({ stage: 'font' });
  const [regularBytes, boldBytes] = await Promise.all([loadCJKRegularBytes(), loadCJKBoldBytes()]);
  const cjkFontRegular = await newDoc.embedFont(regularBytes, { subset: true });
  const cjkFontBold = await newDoc.embedFont(boldBytes, { subset: true });

  onProgress({ stage: 'parsing' });
  // password: '' 是 cantoo 解密路徑的 trigger;對非加密 PDF 無副作用
  // (cantoo 內部會先檢查 isEncrypted 才走 decrypt branch)
  // v1.10.39(code review 2026-06-09 M6):傳 slice(0) 副本,不消費共用的
  // originalArrayBuffer。buildBilingualPdf 對同一 buffer 會被呼叫多次(reader 開啟 /
  // retry regenerate / download fallback),且加密 PDF 走 cantoo decrypt 分支可能
  // transfer/detach buffer → 第二次 build 拿到 length 0 整份失敗。extractPdfMetaForOverlay
  // (下方 line 104)早已自己 slice(0),此處對齊同樣防護。
  const origDoc = await PDFDocument.load(originalArrayBuffer.slice(0), { ignoreEncryption: true, password: '' });
  const pageCount = layoutDoc.pages.length;
  // 一次 embedPages 全部頁(比 for-loop 內逐頁 embedPage 快；pdf-lib 內部 batch parse)
  const origPages = origDoc.getPages().slice(0, pageCount);
  const embeddedPages = await newDoc.embedPages(origPages);

  // 並行抽原 PDF 每頁的 link + 字型 metadata(PDF.js 一次解全頁,內部會 cache,
  // 比 link / bold 各跑一次省一半)
  const pdfMetaByPage = await extractPdfMetaForOverlay(originalArrayBuffer, pageCount);

  for (let i = 0; i < pageCount; i++) {
    onProgress({ stage: 'page', current: i + 1, total: pageCount });
    const layoutPage = layoutDoc.pages[i];
    const pageW = layoutPage.viewport.width;
    const pageH = layoutPage.viewport.height;
    const meta = pdfMetaByPage[i] || { links: [], items: [] };
    // 創新頁 + 把原 page 嵌進去當底層(裝飾 / 圖 / 不可翻譯區留；譯文 overlay 在上)
    const newPage = newDoc.addPage([pageW, pageH]);
    newPage.drawPage(embeddedPages[i], { x: 0, y: 0, width: pageW, height: pageH });
    // 上層蓋譯文(白底 + 中文，只對 translatable block + 有 translation 才蓋)。
    // W7:回傳譯文 link piece 對應的 device rect(PDF y-up),addLinkAnnotations
    // 用譯文 rect 而非原 PDF rect(譯文長度跟原文不同,原 rect 對不到譯文位置)。
    // 沒對應到譯文的 link(原 PDF link 在 non-translatable 區 / translation 失敗)
    // fallback 用原 PDF rect 保留 click hit
    const translatedLinkRects = drawTranslatedOverlay(newPage, layoutPage, cjkFontRegular, cjkFontBold, meta.items);
    const coveredUrls = new Set(translatedLinkRects.map((l) => l.url));
    const fallbackLinks = meta.links.filter((l) => !coveredUrls.has(l.url));
    addLinkAnnotations(newDoc, newPage, [...translatedLinkRects, ...fallbackLinks]);
  }

  onProgress({ stage: 'saving' });
  const pdfBytes = await newDoc.save();
  const baseName = (layoutDoc.meta.filename || 'document').replace(/\.pdf$/i, '');
  const filename = `${baseName}-shinkansen.pdf`;
  return { bytes: pdfBytes, filename, byteLength: pdfBytes.byteLength };
}

/**
 * 產生譯文 PDF Blob 並觸發下載(thin wrapper over buildBilingualPdf)。
 * 也可預先傳入已生成的 bytes 跳過重做(reader 已有 cache 時用)
 *
 * @param {ArrayBuffer}  originalArrayBuffer
 * @param {LayoutDoc}    layoutDoc
 * @param {object}       [options]
 * @param {Uint8Array}   [options.prebuiltBytes] — 已生成的 bytes,免重做
 * @param {(p: { stage: string, current?: number, total?: number }) => void} [options.onProgress]
 * @returns {Promise<{ filename: string, byteLength: number }>}
 */
export async function downloadBilingualPdf(originalArrayBuffer, layoutDoc, options = {}) {
  let result;
  if (options.prebuiltBytes) {
    const baseName = (layoutDoc.meta.filename || 'document').replace(/\.pdf$/i, '');
    result = {
      bytes: options.prebuiltBytes,
      filename: `${baseName}-shinkansen.pdf`,
      byteLength: options.prebuiltBytes.byteLength,
    };
  } else {
    result = await buildBilingualPdf(originalArrayBuffer, layoutDoc, options);
  }
  const blob = new Blob([result.bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = result.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { filename: result.filename, byteLength: result.byteLength };
}

// ----- 譯文頁 layout 渲染 -----

// W7:italic 用 pdf-lib drawText `matrix` 做 12° skew transform(業界標準做法,
// CSS font-synthesis-style 預設 14°、FontForge -10°~-15°,折衷 12°)。matrix 走
// PDF text rendering matrix 規格,skew x 軸:[1, 0, tan(12°), 1, tx, ty]
const ITALIC_SKEW = Math.tan(12 * Math.PI / 180);
// 原子 token 斷行判定上限:≤ 此字元數的 ASCII 連續串(金額 / 數值 / 短料號)被迫
// 逐字拆行時視為 fit 失敗(寧縮字不拆);更長的串(URL / 完整料號)照舊可拆
const ATOMIC_CHUNK_MAX_CHARS = 14;
// 連結色 = 接近 #00468C 的偏深藍,跟黑字有對比但不過度螢光
const LINK_RGB = [0, 0.27, 0.55];
// link underline:baseline 下 fontSize × 0.12 處,thickness fontSize × 0.06
const UNDERLINE_OFFSET_RATIO = 0.12;
const UNDERLINE_THICKNESS_RATIO = 0.06;

// block.styleSegments(原文)全部同 (isBold, isItalic) 時回傳該 style;
// 混排 / 無資料 / uniform 但無樣式(全 regular)回 null。
// 只看有實質文字的 segment——純空白 segment 的樣式位不可靠
export function uniformBlockStyle(block) {
  const src = block && block.styleSegments;
  if (!Array.isArray(src) || src.length === 0) return null;
  let isBold = null;
  let isItalic = null;
  for (const s of src) {
    if (!s || typeof s.text !== 'string' || s.text.trim().length === 0) continue;
    if (isBold === null) {
      isBold = !!s.isBold;
      isItalic = !!s.isItalic;
      continue;
    }
    if (!!s.isBold !== isBold || !!s.isItalic !== isItalic) return null;
  }
  if (isBold === null) return null;
  return (isBold || isItalic) ? { isBold, isItalic } : null;
}

// 對每個 translatable + has translation 的 block 在新 page 上蓋白底 + 寫譯文。
// 不可翻譯 type(table / formula / figure / page-number)/ failed block / pending →
// 不蓋(讓底層 embeddedPage 的原 PDF 文字 visible)，跟 reader overlay 模式一致。
//
// W7:走 piece-by-piece 渲染:每個 block 的 translationSegments 切成 wrap line,
// 每 line 內走 piece 列表逐個 drawText。bold piece 用 fontBold、italic piece 用
// matrix skew、link piece 藍色 + drawLine underline + 收集譯文 device rect 給
// addLinkAnnotations。
//
// items:從 PDF.js 抽出的 textContent items(canvas 座標),只用於 expandBoxToCoverItems
// 算 mask box(W7 起 isBold 從 styleSegments 走,不再用 items 反推 block-level bold)
//
// @returns {Array<{ url: string, rect: [number,number,number,number] }>}
//          回傳譯文 link piece 對應的 PDF y-up rect,給 addLinkAnnotations 用
export function drawTranslatedOverlay(page, layoutPage, fontRegular, fontBold, items) {
  const { rgb } = window.PDFLib;
  const pageH = layoutPage.viewport.height;
  const translatedLinkRects = [];

  // 兩階段 render:先把所有 block 的 mask + fit 結果算完並一次畫白底,再 loop
  // drawText。
  // Why two-pass:單階段 loop(mask → drawText 交替)在「sub-block 緊貼」時會
  // 出 bug——後一 block 的 mask(padding ≈ fontSize × 0.3)會蓋住前一 block 已畫
  // 的字身底部。觸發場景:layout-analyzer narrow-multi-line split 切出的緊貼
  // sub-block 群(聯絡資訊區、spec sheet diagram label 群)。本 fix 不限該場景,
  // 任何相鄰 mask 重疊處都受惠
  const prepared = [];
  for (const block of layoutPage.blocks) {
    if (!TRANSLATABLE_TYPES.has(block.type)) continue;
    if (!block.translation || block.translation.trim().length === 0) continue;

    const [origX0, origY0, origX1, origY1] = block.bbox;
    if (origX1 <= origX0 || origY1 <= origY0) continue;

    // W7:取 translationSegments(parser 失敗 / 舊資料 → fallback 整段 plain regular)
    let segs = Array.isArray(block.translationSegments) && block.translationSegments.length > 0
      ? block.translationSegments
      : [{ text: block.translation, isBold: false, isItalic: false, linkUrl: null }];

    // 換行正規化:LLM 對 bullet list 類 block 常自作主張在譯文加 \n(輸入的
    // plainText 本來就是收斂空白後的單行)。wrap 是本 renderer 唯一的斷行者,
    // piece 文字帶 \n 會讓 pdf-lib drawText 內部再斷一次行往下畫,跟我們的
    // cy 前進疊加 → 譯文互疊(Thorpe bullet list 實測)。\n 一律轉單一空格
    segs = segs.map((s) => (s.text && s.text.includes('\n')
      ? { ...s, text: s.text.replace(/\s*\n+\s*/g, ' ') }
      : s));

    // 整塊同 style 的 block(全粗體標題 / 全斜體引言)不依賴 LLM marker:
    // 譯文 segments 全無樣式時直接繼承原 block 的 uniform style。涵蓋三種
    // 樣式流失來源——模型剝掉 ⟦b⟧/⟦i⟧ marker、parseMarkedTranslation fallback、
    // 舊資料無 translationSegments。linkUrl 不在此列(連結錨點必須靠 marker 對位);
    // 譯文帶任一 bold / italic piece 時視為 marker 有效,不覆蓋
    const uniform = uniformBlockStyle(block);
    if (uniform && segs.every((s) => !s.isBold && !s.isItalic)) {
      segs = segs.map((s) => ({ ...s, isBold: uniform.isBold, isItalic: uniform.isItalic }));
    }

    // fit-to-box:從 scale 1.0 起步,塞不下時依序試縮 + 擴 box,回傳最終 box +
    // 字級 + 行(每行帶 pieces 陣列)
    const fit = fitSegmentsToBox(
      segs, fontRegular, fontBold, block.fontSize, block, layoutPage,
    );
    prepared.push({ block, fit });
  }

  // Pass 1: 把所有 block 的 mask 一次畫完。
  // mask box = expandBoxToCoverItems(finalBox, block, items)(clamp 到 block.bbox)
  // + 底部 padding (descender)。
  // padBottom 涵蓋原文字身 descender 殘影(PDF.js textRun bbox 不一定完整包到字身底)。
  // 對非 cell-block 用 fontSize × 0.3(原行為);對 cell-block 限制較小,因為 cell.y1
  // 跟下方 row 邊線距離通常 3-4pt。
  // cell-block buffer:cell-split sub-block 的 block.bbox 邊界跟原 PDF 表格邊線
  // 重合(cell.x0 = 垂直邊線 x、cell.y0 = 水平邊線 y),mask 從 cell.bbox 邊開始
  // 會蓋邊線。對 cell-block 上左右各收 0.5pt buffer 留邊線(中文沒突出 ascender 寬,
  // 0.5pt 不會留明顯殘影)
  for (const { block, fit } of prepared) {
    const isCellBlock = block._isCellBlock === true;
    if (isCellBlock) {
      // cell-block mask:蓋「原文 item 形狀 + descender padding」而非整格內縮矩形。
      // 舊法(cell.bbox 內縮 1pt、無 padBottom)在原文字身貼近 cell 底時留 1-2pt
      // 字身底殘影(zoom 下呈虛線,Quotation 表頭列實測)。文字通常不貼表格邊線,
      // 以 item bbox 起算的 mask 蓋得住字身(含 PDF.js bbox 常低估的 descender)
      // 又碰不到邊線;item 貼邊時 clamp 回 cell 內縮 0.5pt(殘影只剩貼邊側極窄條,
      // 仍優於全周內縮)。cell 內找不到 item 時 fallback 舊內縮矩形(寧可壓邊線
      // 也不漏蓋原文,對齊 v1.10.39 M5 窄 cell 原則)
      const [bx0, by0, bx1, by1] = block.bbox;
      const buf = 0.5;
      const fs = block.fontSize || 10;
      const padX = fs * 0.1;
      const padTop = fs * 0.1;
      const padBottomCell = Math.max(1.5, fs * 0.25);
      let drewItemMask = false;
      for (const it of (items || [])) {
        const [ix0, iy0, ix1, iy1] = it.bbox;
        // 只取與 cell 相交的 item(相鄰 cell 的 item 不會與本 cell bbox 相交)
        if (ix1 < bx0 || ix0 > bx1 || iy1 < by0 || iy0 > by1) continue;
        const mx0 = Math.max(ix0 - padX, bx0 + buf);
        const mx1 = Math.min(ix1 + padX, bx1 - buf);
        const my0 = Math.max(iy0 - padTop, by0 + buf);
        const my1 = Math.min(iy1 + padBottomCell, by1 - buf);
        if (mx1 <= mx0 || my1 <= my0) continue;
        page.drawRectangle({
          x: mx0,
          y: pageH - my1,
          width: mx1 - mx0,
          height: my1 - my0,
          color: rgb(1, 1, 1),
          borderWidth: 0,
        });
        drewItemMask = true;
      }
      if (!drewItemMask) {
        // fallback:cell.bbox 內縮 1pt(v1.10.39 M5:窄 cell 內縮後 ≤ 0 用原尺寸)
        const fbuf = 1;
        const insetW = (bx1 - bx0) - fbuf * 2;
        const insetH = (by1 - by0) - fbuf * 2;
        const useInset = insetW > 0 && insetH > 0;
        page.drawRectangle({
          x: useInset ? bx0 + fbuf : bx0,
          y: useInset ? pageH - (by1 - fbuf) : pageH - by1,
          width: useInset ? insetW : (bx1 - bx0),
          height: useInset ? insetH : (by1 - by0),
          color: rgb(1, 1, 1),
          borderWidth: 0,
        });
      }
    } else {
      // non-cell-block:mask 基底 = 原 block.bbox ∪ 譯文實際畫字範圍,再
      // expandBoxToCoverItems(clamp 到 block.bbox)+ padBottom = fontSize × 0.3
      // (蓋 link underline / 標點 / ascent 殘影)。
      // 不可用整個 fit.finalBox 當基底:fit-to-box 擴 box 後 finalBox 可能一路
      // 伸到下一個 text block 上緣 / 頁底,但 layout blocks 全來自 text run,
      // block 之間的圖片 / 向量圖形不是阻擋物——以 finalBox 起算會把它們整片蓋白。
      // 只蓋「原文所在區」+「譯文實際會畫到的區」,擴 box 多出來沒畫字的區域不蓋。
      // 非 cell-block 通常不在表格內,padBottom 不會蓋表格邊線
      const drawn = computeDrawnExtent(fit, fontRegular, fontBold);
      const f = fit.finalBox;
      const [bx0, by0, bx1, by1] = block.bbox;
      const baseBox = {
        x0: Math.min(bx0, f.x0),
        y0: Math.min(by0, f.y0),
        x1: Math.max(bx1, Math.min(f.x1, f.x0 + drawn.w)),
        y1: Math.max(by1, Math.min(f.y1, f.y0 + drawn.h)),
      };
      const maskBox = expandBoxToCoverItems(baseBox, block, items);
      const padBottom = Math.max(2, (block.fontSize || 12) * 0.3);
      const { x0: mx0, y0: my0, x1: mx1, y1: my1 } = maskBox;
      const pdfMaskBottom = pageH - (my1 + padBottom);
      page.drawRectangle({
        x: mx0,
        y: pdfMaskBottom,
        width: mx1 - mx0,
        height: (my1 - my0) + padBottom,
        color: rgb(1, 1, 1),
        borderWidth: 0,
      });
    }
  }

  // Pass 2: 把所有 block 的譯文 drawText
  for (const { block, fit } of prepared) {
    const { fontSize, lineHeight, lines, finalBox } = fit;
    const { x0, y0, y1 } = finalBox;
    const pdfTop = pageH - y0;
    const pdfBottom = pageH - y1;

    let cy = pdfTop - fontSize; // baseline 起點(PDF y-up)
    for (const line of lines) {
      if (cy < pdfBottom - lineHeight) break;
      let cx = x0;
      for (const piece of line.pieces) {
        if (!piece.text) continue;
        const pieceFont = piece.isBold ? fontBold : fontRegular;
        const color = piece.linkUrl ? rgb(LINK_RGB[0], LINK_RGB[1], LINK_RGB[2]) : rgb(0, 0, 0);
        const opts = { font: pieceFont, size: fontSize, color };
        if (piece.isItalic) {
          // pdf-lib drawText 接 matrix 後會用 matrix 取代 x/y,把 cx/cy 寫進 matrix.tx/ty
          opts.matrix = [1, 0, ITALIC_SKEW, 1, cx, cy];
        } else {
          opts.x = cx;
          opts.y = cy;
        }
        try {
          page.drawText(piece.text, opts);
        } catch (err) {
          console.warn('[Shinkansen] drawText 跳過：', piece.text.slice(0, 30), err.message);
        }
        // widthOfTextAtSize 與 drawText 走同一條 fontkit layout 路徑,編不進字型的
        // piece 兩者都會 throw——drawText 有跳過防護,這裡必須同樣兜住,否則整份
        // PDF 生成炸掉(fallback 估算比照 computeDrawnExtent)
        let pieceWidth;
        try { pieceWidth = pieceFont.widthOfTextAtSize(piece.text, fontSize); }
        catch { pieceWidth = piece.text.length * fontSize * 0.5; }
        if (piece.linkUrl) {
          // underline:baseline 下方
          const underlineY = cy - fontSize * UNDERLINE_OFFSET_RATIO;
          try {
            page.drawLine({
              start: { x: cx, y: underlineY },
              end: { x: cx + pieceWidth, y: underlineY },
              thickness: fontSize * UNDERLINE_THICKNESS_RATIO,
              color: rgb(LINK_RGB[0], LINK_RGB[1], LINK_RGB[2]),
            });
          } catch (_) { /* underline 失敗不破整體 */ }
          // 收集譯文 link rect(PDF y-up,給 addLinkAnnotations 用)。rect 涵蓋
          // baseline 上下幾 pt 讓點擊 hit area 寬鬆些
          translatedLinkRects.push({
            url: piece.linkUrl,
            rect: [cx, cy - fontSize * 0.2, cx + pieceWidth, cy + fontSize * 0.9],
          });
        }
        cx += pieceWidth;
      }
      cy -= lineHeight;
    }
  }
  return translatedLinkRects;
}

// 譯文實際畫字範圍(供 mask 限縮用):寬 = 最寬行的 piece 寬總和,高 = 同 tryFit
// 的 requiredH 公式(首行 visual ratio + 其餘行 lineHeight)。fit.lines 可能因
// drawText loop 的 box 底截斷而少畫,caller 對 finalBox 取 min 兜底
function computeDrawnExtent(fit, fontRegular, fontBold) {
  const { fontSize, lineHeight, lines } = fit;
  let maxW = 0;
  for (const line of lines) {
    let w = 0;
    for (const p of line.pieces) {
      const font = p.isBold ? fontBold : fontRegular;
      try { w += font.widthOfTextAtSize(p.text, fontSize); }
      catch { w += p.text.length * fontSize * 0.5; }
    }
    if (w > maxW) maxW = w;
  }
  const visualRatio = lines.length === 1 ? SINGLE_LINE_VISUAL_RATIO : FIRST_LINE_VISUAL_RATIO;
  const h = lines.length > 0 ? fontSize * visualRatio + (lines.length - 1) * lineHeight : 0;
  return { w: maxW, h };
}

// fit-to-box(港 BabelDOC `_find_optimal_scale_and_layout` 演算法到 JS):
//   Phase A: 原 box scale 1.0 → 0.7 試
//   Phase B: 擴 box 往下(找最近下方阻擋 block,留 buffer)→ 重試 1.0 → 0.7
//   Phase C: 再擴 box 往右(找最近右側阻擋 block)→ 重試 1.0 → 0.7
//   Phase D: 0.65 → MIN_SCALE 繼續縮(極端 case)
//
// CJK line_skip 用 1.5(原文是英文 1.3 vs 中文 1.5 的 BabelDOC 經驗值,中文
// ascender + descender 比英文多,行間距要大一點才不視覺擠)
//
// 高度估算:Noto Sans TC ascent ≈ 0.88 + |descent| ≈ 0.21 + 餘裕 0.12
// → 第 1 行視覺占用 = fontSize × FIRST_LINE_VISUAL_RATIO(1.21)
const MIN_FONT_SIZE = 5;
const MIN_SCALE = 0.5;
const PHASE_A_SCALES = [1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7];
const PHASE_D_SCALES = [0.65, 0.55, 0.5];
const FIRST_LINE_VISUAL_RATIO = 1.21;
// 1-line block 的 requiredH 放寬:容許 descender 略超 box(ratio 1.0 而非 1.21)。
// Why:heading 類短 block 的原 PDF bbox 高度往往只 = fontSize × 1.0(英文 ascent +
// descent 加總略 < 1.0 塞得下);中文 Noto Sans TC ascent 0.88 + descent 0.21 = 1.09
// 略 > 1.0,用 1.21 標準會讓 1-line heading 永遠塞不下,phase B 擴下又被緊鄰下方
// block 擋住 → 走 phase A scale 縮字 → heading 比內文小。
// 安全性:two-pass mask render 保證所有 mask 先畫完才 drawText,descender 略超 box
// 不會被下個 block mask 蓋掉;且原文字身也是同樣 ratio,視覺對等
const SINGLE_LINE_VISUAL_RATIO = 1.0;

// W7:segment-aware 版本。input 接 styleSegments + 兩種 font(regular/bold),
// 內部用 wrapSegmentsToWidth 取代 wrapTextToWidth。回傳 lines 結構也變
// [{ pieces: [{ text, isBold, isItalic, linkUrl }] }] 給 drawTranslatedOverlay
// piece-by-piece drawText 用。
function fitSegmentsToBox(segments, fontRegular, fontBold, originalFontSize, currentBlock, layoutPage) {
  // 全段 text 拼起來判斷 CJK(影響 line_skip)
  const fullText = segments.map((s) => s.text).join('');
  const isCJKText = hasCJK(fullText);
  const lineSkipRatio = isCJKText ? 1.5 : 1.3;
  const [origX0, origY0, origX1, origY1] = currentBlock.bbox;
  let box = { x0: origX0, y0: origY0, x1: origX1, y1: origY1 };

  function tryFit(b, scale) {
    const fontSize = Math.max(MIN_FONT_SIZE, originalFontSize * scale);
    const lineHeight = fontSize * lineSkipRatio;
    const blockW = b.x1 - b.x0;
    const blockH = b.y1 - b.y0;
    if (blockW <= 0 || blockH <= 0) return null;
    const lines = wrapSegmentsToWidth(segments, fontRegular, fontBold, fontSize, blockW);
    // 原子 token(短金額 / 數值)被逐字拆行 = 排版不合格,視為 fit 失敗——
    // 讓 phase 迴圈改試縮字 / 擴框;全部救不了才由最終 fallback 接受拆行
    if (lines.atomicSplit) return null;
    const visualRatio = lines.length === 1 ? SINGLE_LINE_VISUAL_RATIO : FIRST_LINE_VISUAL_RATIO;
    const requiredH = fontSize * visualRatio + (lines.length - 1) * lineHeight;
    if (requiredH <= blockH + 1) return { fontSize, lineHeight, lines, finalBox: b };
    return null;
  }

  // cell-split sub-block 不該擴 box(會推到相鄰 cell 邊界,蓋掉表格垂直邊線)。
  // 改成只走 scale 縮字路徑(phase A + D),跳過 phase 0 / B / C 擴 box variant。
  const isCellBlock = currentBlock._isCellBlock === true;

  // 先算所有可用的 box variant(擴右 / 擴下 / 擴雙),供 Phase 0 / B / C 共用
  const expandedRight = isCellBlock ? -Infinity : getMaxRightX(currentBlock, layoutPage);
  const expandedBottom = isCellBlock ? -Infinity : getMaxBottomY(currentBlock, layoutPage);
  const canExpandRight = expandedRight > box.x1 + 0.5;
  const canExpandDown = expandedBottom > box.y1 + 0.5;
  // 變體順序:原 box → 擴下 → 擴右 → 擴雙。「下優先於右」(對齊 Phase B 先於
  // Phase C 的既有語意):向下是同欄流向,通常只是 cell 下緣 / 段落間的小空隙,
  // 良性;向右會跨進版面上「非文字阻擋物」的地盤——表格右側的架構圖 / 圖片不是
  // text block,getMaxRightX 擋不住,右擴優先時「差 2pt 塞不下」的表格 cell 會
  // 被排成一行長文蓋過整張圖(Thorpe p3 分割區 / 驅動程式紀錄 cell 實測)
  const variants = [box];
  if (canExpandDown) variants.push({ ...box, y1: expandedBottom });
  if (canExpandRight) variants.push({ ...box, x1: expandedRight });
  if (canExpandRight && canExpandDown) {
    variants.push({ x0: box.x0, y0: box.y0, x1: expandedRight, y1: expandedBottom });
  }

  // Phase 0:scale 1.0 優先試所有 box variant — 「擴 box」比「縮字」優先
  // Why:之前 phase A 從 scale 1.0 試到 0.7 後才走 phase B/C 擴 box,但 1-line
  // heading 在中文 wrap 後若 scale 0.95 已 fit 就直接接受,fontSize 縮 5-10% →
  // heading 比內文小(About Plano 9pt 內文 9pt,但譯文「關於普萊諾市」變 8.1pt)。
  // 改成 scale 1.0 先全試擴 box variant,fontSize 100% 沒副作用優先
  for (const v of variants) {
    const r = tryFit(v, 1.0);
    if (r) return r;
  }

  // Phase A: 原 box,scale 0.95 → 0.7(scale 1.0 已在 Phase 0 試過)
  for (const scale of PHASE_A_SCALES) {
    if (scale === 1.0) continue;
    const r = tryFit(box, scale);
    if (r) return r;
  }

  // Phase B: 擴 box 往下,scale 0.95 → 0.7
  if (canExpandDown) {
    const expanded = { ...box, y1: expandedBottom };
    for (const scale of PHASE_A_SCALES) {
      if (scale === 1.0) continue;
      const r = tryFit(expanded, scale);
      if (r) return r;
    }
    box = expanded;
  }

  // Phase C: 擴 box 往右,scale 0.95 → 0.7
  if (canExpandRight) {
    const expanded = { ...box, x1: expandedRight };
    for (const scale of PHASE_A_SCALES) {
      if (scale === 1.0) continue;
      const r = tryFit(expanded, scale);
      if (r) return r;
    }
    box = expanded;
  }

  // Phase D: 繼續縮(極端 case)
  for (const scale of PHASE_D_SCALES) {
    const r = tryFit(box, scale);
    if (r) return r;
  }

  // fallback:用 MIN_SCALE 算一次,可能仍 overflow,讓 drawText loop 自己擋
  const fontSize = Math.max(MIN_FONT_SIZE, originalFontSize * MIN_SCALE);
  const lineHeight = fontSize * lineSkipRatio;
  const lines = wrapSegmentsToWidth(segments, fontRegular, fontBold, fontSize, box.x1 - box.x0);
  return { fontSize, lineHeight, lines, finalBox: box };
}

// 判字串是否含 CJK(影響 line_skip)
function hasCJK(text) {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x3000 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF)) return true;
  }
  return false;
}

// 港 BabelDOC `get_max_bottom_space` 到 JS。canvas 座標(y 由上往下),所以
// 「下方」= y 較大。對當前 block,找頁面所有「在當前 block 下方且水平有重疊」
// 的其他 block,取最小的 y0 為阻擋邊界,留 2pt buffer
function getMaxBottomY(currentBlock, layoutPage) {
  const [cx0, , cx1, cy1] = currentBlock.bbox;
  const pageH = layoutPage.viewport.height;
  let minBlockerY0 = pageH; // 頁面底
  for (const b of layoutPage.blocks) {
    if (b === currentBlock) continue;
    if (!Array.isArray(b.bbox) || b.bbox.length !== 4) continue;
    const [bx0, by0, bx1] = b.bbox;
    if (by0 <= cy1) continue; // 不在下方
    if (bx0 >= cx1 || bx1 <= cx0) continue; // 沒水平重疊
    if (by0 < minBlockerY0) minBlockerY0 = by0;
  }
  return Math.max(cy1, minBlockerY0 - 2);
}

// 港 BabelDOC `get_max_right_space`。對當前 block,找頁面所有「在當前 block
// 右側且垂直有重疊」的其他 block,取最小的 x0 為阻擋邊界,留 5pt buffer
function getMaxRightX(currentBlock, layoutPage) {
  const [, cy0, cx1, cy1] = currentBlock.bbox;
  const pageW = layoutPage.viewport.width;
  let minBlockerX0 = pageW;
  for (const b of layoutPage.blocks) {
    if (b === currentBlock) continue;
    if (!Array.isArray(b.bbox) || b.bbox.length !== 4) continue;
    const [bx0, by0, , by1] = b.bbox;
    if (bx0 <= cx1) continue; // 不在右側
    if (by0 >= cy1 || by1 <= cy0) continue; // 沒垂直重疊
    if (bx0 < minBlockerX0) minBlockerX0 = bx0;
  }
  return Math.max(cx1, minBlockerX0 - 5);
}

// 對「bbox 跟 block.bbox 有重疊」的 text items 算 union bbox,跟 finalBox 聯集回傳。
// 用於擴展白底 mask 範圍,確保原 PDF text 的 ascent / descent / inline 標點
// 不會在 block.bbox 邊緣漏出。中心點判定會漏掉 block 邊緣的 item(中心點略出
// block.bbox 但大半字身仍在 block 內),改用 bbox overlap 判定才包得到。
// 沒命中任何 item 直接回傳 finalBox。
function expandBoxToCoverItems(finalBox, block, items) {
  if (!items || items.length === 0) return finalBox;
  const [bx0, by0, bx1, by1] = block.bbox;
  let { x0, y0, x1, y1 } = finalBox;
  for (const it of items) {
    const [ix0, iy0, ix1, iy1] = it.bbox;
    if (ix1 < bx0 || ix0 > bx1 || iy1 < by0 || iy0 > by1) continue;
    // 擴 mask 到 item bbox,但 clamp 到 block.bbox 內(避免跨 cell 蓋邊線)。
    // 對 cell-split sub-block,block.bbox 已是 cell-sized,clamp 確保 mask 不擴
    // 到相鄰 cell。對非 cell-split block,block.bbox 大致等於 textRun union,
    // clamp 是 no-op
    if (Math.max(ix0, bx0) < x0) x0 = Math.max(ix0, bx0);
    if (Math.max(iy0, by0) < y0) y0 = Math.max(iy0, by0);
    if (Math.min(ix1, bx1) > x1) x1 = Math.min(ix1, bx1);
    if (Math.min(iy1, by1) > y1) y1 = Math.min(iy1, by1);
  }
  return { x0, y0, x1, y1 };
}

// ----- 從原 PDF 抽 link + 字型 metadata -----

// 用 PDF.js 一輪解全頁,每頁回傳:
//   - links: { rect, url }  (rect PDF y-up 直接給 pdf-lib 用;新 page 同 size + 1:1 嵌)
//   - items: [{ str, bbox, isBold }]  (bbox canvas 座標,同 layout-analyzer 用的座標系)
// items 供 expandBoxToCoverItems 用(W7 起 bold 改走 styleSegments,不再用 items 反推
// block-level bold)。判 bold 走兩條:
//   1. font.bold === true (PDF 字型物件直接帶)
//   2. font.name regex /Bold|Black|Heavy|Demi|Semi/  (subset 過的字型常無 .bold flag,
//      但 name 通常仍含 weight 字串,例:'BCDFEE+Arial-Black')
async function extractPdfMetaForOverlay(arrayBuffer, pageCount) {
  try {
    const task = pdfjsLib.getDocument({
      data: arrayBuffer.slice(0),
      disableFontFace: false,
      password: '',
    });
    const pdfDoc = await task.promise;
    const out = [];
    const n = Math.min(pageCount, pdfDoc.numPages);
    for (let i = 0; i < n; i++) {
      const page = await pdfDoc.getPage(i + 1);
      const viewport = page.getViewport({ scale: 1 });

      // links
      const annotations = await page.getAnnotations();
      const links = annotations
        .filter((a) => a.subtype === 'Link')
        .map((a) => ({ rect: a.rect, url: a.url || a.unsafeUrl || null }))
        .filter((l) => !!l.url);

      // items + bold flag(getOperatorList 觸發 worker font load,後續 commonObjs.get 才有資料)
      await page.getOperatorList();
      const tc = await page.getTextContent();
      const styles = tc.styles || {};
      const fontIsBold = {};
      for (const fn of Object.keys(styles)) {
        try {
          const font = await new Promise((resolve) => page.commonObjs.get(fn, resolve));
          const name = (font && font.name) || '';
          fontIsBold[fn] = (font && font.bold === true) || /Bold|Black|Heavy|Demi|Semi/i.test(name);
        } catch {
          fontIsBold[fn] = false;
        }
      }

      const items = tc.items
        .filter((it) => typeof it.str === 'string' && it.str.trim().length > 0)
        .map((it) => {
          // 套 viewport.transform × item.transform → canvas 座標(同 pdf-engine.js 邏輯)
          const m = pdfjsLib.Util.transform(viewport.transform, it.transform);
          const fontSize = Math.hypot(m[2], m[3]);
          const left = m[4];
          const baselineY = m[5];
          const top = baselineY - fontSize;
          const right = left + (it.width || 0);
          const bottom = baselineY;
          return {
            str: it.str,
            bbox: [left, top, right, bottom],
            isBold: fontIsBold[it.fontName] || false,
          };
        });

      out.push({ links, items });
    }
    await pdfDoc.destroy();
    return out;
  } catch (err) {
    // 抽取失敗不該卡住整份 PDF 生成,降級成「沒 link / 沒 bold」
    console.warn('[Shinkansen] extractPdfMetaForOverlay 失敗,譯文 PDF 將不含 link / bold:', err && err.message);
    return [];
  }
}

// 對單一新 page 加回 Link annotations。每條 Link 構造一個 PDFDict 註冊成
// indirect object 後 push 進 page 的 /Annots。新 page 跟原 page 同 size 而且
// embedPages 是 1:1 嵌入,原 rect (PDF y-up) 直接套用
function addLinkAnnotations(newDoc, newPage, links) {
  if (!links || links.length === 0) return;
  const { PDFName, PDFString } = window.PDFLib;
  const ctx = newDoc.context;
  for (const link of links) {
    if (!link.url || !Array.isArray(link.rect) || link.rect.length !== 4) continue;
    // ctx.obj 對 string value 一律當 PDFName(看 cantoo 9387:obj 行為),
    // 但 URI 必須是 PDFString(literal 形式),所以手動 set
    const annotDict = ctx.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: link.rect,
      Border: [0, 0, 0],
    });
    const actionDict = ctx.obj({
      Type: 'Action',
      S: 'URI',
    });
    actionDict.set(PDFName.of('URI'), PDFString.of(link.url));
    annotDict.set(PDFName.of('A'), actionDict);
    const annotRef = ctx.register(annotDict);
    newPage.node.addAnnot(annotRef);
  }
}

// 不可行首的標點(中文全形 + 半形,新行起頭看到這些字符會把它拉回上一行末)。
// 涵蓋:句號逗號、頓號、分號冒號、感嘆問號、右括號、右引號、書名號右半
// 不可行首字符後處理由 applyCJKPunctuationRulesPieces(segment-aware 版)負責,常數共用。
const FORBIDDEN_LINE_START = '、。，：；！？」』）〕】》〉,.;:!?)]}';

// W7:segment-aware wrap。對每 styleSegment 切 chunks(CJK 逐字 / ASCII 詞 /
// 空白獨立 切法),chunks 帶 segment 的 style;累加 chunk
// 寬超過 maxWidth 就斷新行。同 line 內合併連續同 style chunks 成 piece。
//
// @returns {Array<{ pieces: Array<{ text, isBold, isItalic, linkUrl }> }>}
export function wrapSegmentsToWidth(segments, fontRegular, fontBold, fontSize, maxWidth) {
  if (!Array.isArray(segments) || segments.length === 0) return [];

  // 1) 對每 segment 切 chunks(每個 chunk 是 CJK 單字 / ASCII 詞 / 空白)
  // chunks: [{ text, isBold, isItalic, linkUrl, isWS }]
  const chunks = [];
  for (const seg of segments) {
    if (!seg || !seg.text) continue;
    let buf = '';
    const flushBuf = () => {
      if (buf) {
        chunks.push({
          text: buf,
          isBold: !!seg.isBold,
          isItalic: !!seg.isItalic,
          linkUrl: seg.linkUrl || null,
          isWS: false,
        });
        buf = '';
      }
    };
    for (const ch of seg.text) {
      const cp = ch.codePointAt(0);
      const isCJK =
        (cp >= 0x3000 && cp <= 0x9FFF) ||
        (cp >= 0x3400 && cp <= 0x4DBF) ||
        (cp >= 0xFF00 && cp <= 0xFFEF);
      const isWS = /\s/.test(ch);
      if (isCJK || isWS) {
        flushBuf();
        chunks.push({
          text: ch,
          isBold: !!seg.isBold,
          isItalic: !!seg.isItalic,
          linkUrl: seg.linkUrl || null,
          isWS,
        });
      } else {
        buf += ch;
      }
    }
    flushBuf();
  }

  function fontFor(c) { return c.isBold ? fontBold : fontRegular; }
  function widthOf(c) {
    try { return fontFor(c).widthOfTextAtSize(c.text, fontSize); }
    catch { return c.text.length * fontSize * 0.5; }
  }

  // 1.5) 單一 chunk 自己就寬過 maxWidth(長 URL / 料號等 ASCII 連續串)→ 退化成
  // 逐字元 chunks 再走一般 wrap:整條塞同一行會畫超出 box.x1,水平溢出疊到右側
  // 原文 / 相鄰 block。逐字元後同 style 字元在行內仍會被 mergeChunksToPieces 合回
  // 同一 piece,不影響渲染結構。
  // v2.0.75:短 chunk(≤ ATOMIC_CHUNK_MAX_CHARS)被迫逐字拆 = 「原子 token 斷行」
  // ——窄 cell 的金額 / 數值被拆成「7,000.0 / 0」「1.4 / 7」(TDC6 / OCA 實測)。
  // 回傳陣列標 atomicSplit,fitSegmentsToBox 的 tryFit 視為 fit 失敗,改走縮字 /
  // 擴框讓 token 整顆塞下;所有 phase 都救不了才在最終 fallback 接受逐字拆。
  // 長串(URL / 完整料號 > 14 字元)不設限,照舊逐字拆(縮字救不了它們)
  const sizedChunks = [];
  let atomicSplit = false;
  for (const c of chunks) {
    if (!c.isWS && c.text.length > 1 && widthOf(c) > maxWidth) {
      if (c.text.length <= ATOMIC_CHUNK_MAX_CHARS) atomicSplit = true;
      for (const ch of c.text) sizedChunks.push({ ...c, text: ch });
    } else {
      sizedChunks.push(c);
    }
  }

  // 2) wrap chunks 成 lines(lineChunks: chunks[],尚未合併成 pieces)
  const lineChunks = [];
  let current = [];
  let currentWidth = 0;
  for (const c of sizedChunks) {
    const w = widthOf(c);
    if (current.length === 0 && c.isWS) continue; // 跳新行開頭的純空白
    if (currentWidth + w > maxWidth && current.length > 0) {
      lineChunks.push(current);
      current = c.isWS ? [] : [c];
      currentWidth = c.isWS ? 0 : w;
    } else {
      current.push(c);
      currentWidth += w;
    }
  }
  if (current.length > 0) lineChunks.push(current);

  // 3) 合併連續同 style 的 chunks 成 pieces;CJK 標點規則(跨 piece)
  const lines = lineChunks.map((cs) => ({ pieces: mergeChunksToPieces(cs) }));
  const out = applyCJKPunctuationRulesPieces(lines);
  if (atomicSplit) out.atomicSplit = true;
  return out;
}

// 把 chunks 陣列合併成 pieces:連續同 (isBold, isItalic, linkUrl) 合一段
function mergeChunksToPieces(chunks) {
  const pieces = [];
  for (const c of chunks) {
    const last = pieces[pieces.length - 1];
    if (last && last.isBold === c.isBold && last.isItalic === c.isItalic && last.linkUrl === c.linkUrl) {
      last.text += c.text;
    } else {
      pieces.push({ text: c.text, isBold: c.isBold, isItalic: c.isItalic, linkUrl: c.linkUrl });
    }
  }
  return pieces;
}

// piece 版的 CJK 標點規則:每行第一個 piece 第一個 char 違規 → 挪到上行最後
// piece 末尾(若同 style 合一,不同 style 則插個新 piece 保 style)
function applyCJKPunctuationRulesPieces(lines) {
  if (!lines || lines.length < 2) return lines;
  const out = lines.map((l) => ({ pieces: l.pieces.map((p) => ({ ...p })) }));
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (let i = 1; i < out.length; i++) {
      const line = out[i];
      const firstP = line.pieces[0];
      if (!firstP || !firstP.text) continue;
      const firstCh = firstP.text[0];
      if (!FORBIDDEN_LINE_START.includes(firstCh)) continue;
      // 移到上一行
      const prevLine = out[i - 1];
      const prevLast = prevLine.pieces[prevLine.pieces.length - 1];
      if (prevLast && prevLast.isBold === firstP.isBold && prevLast.isItalic === firstP.isItalic && prevLast.linkUrl === firstP.linkUrl) {
        prevLast.text += firstCh;
      } else {
        prevLine.pieces.push({
          text: firstCh, isBold: firstP.isBold, isItalic: firstP.isItalic, linkUrl: firstP.linkUrl,
        });
      }
      firstP.text = firstP.text.slice(1);
      if (firstP.text.length === 0) line.pieces.shift();
      moved = true;
    }
    if (!moved) break;
  }
  // 過濾空 line + 空 piece
  return out
    .map((l) => ({ pieces: l.pieces.filter((p) => p.text.length > 0) }))
    .filter((l) => l.pieces.length > 0);
}

