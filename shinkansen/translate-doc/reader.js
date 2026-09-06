// reader.js — 雙頁並排閱讀器(WYSIWYG mode,2026-05-05 起)
//
// 左欄:用 PDF.js render 原 pdfDoc 到 canvas
// 右欄:呼叫 buildBilingualPdf 拿譯文 PDF bytes,用 PDF.js 開出 translatedPdfDoc
//      再 render 到 canvas
//
// 為什麼走 PDF.js render 譯文 PDF 而非 HTML overlay:
//   1. WYSIWYG — reader 顯示的譯文 = 下載按鈕產出的譯文 PDF。三條 fix
//      (bold preservation / link annotation / fit-to-box 縮字 + bbox 擴展 +
//      CJK line_skip + CJK 標點)都在 pdf-renderer 統一處理,reader 自動
//      繼承,沒有「reader 跟下載結果不一致」這條 debug 路徑要 maintain
//   2. 連結可點 — pdf-renderer 已用 page.node.addAnnot 把原 PDF 的 Link
//      annotation 加進譯文 PDF,PDF.js render 後 annotation 自動 clickable
//   3. 字型 vector — Noto Sans TC subset 內嵌進譯文 PDF,zoom 不破
//
// 歷史:W4-W5 走 HTML overlay (renderOverlayBlock + 每 block 一個 absolute
// div + 白底蓋原文位置),v1.8.46 後 pdf-renderer 修了 bold/link/overflow,
// 但 reader 仍走 HTML overlay 沒套用,變成兩條視覺不一致的路徑。本次重寫
// 直接讓 reader 走 pdf-renderer 同一條 path

import { renderPageToCanvas } from './pdf-engine.js';
import { translateSingleBlock } from './translate.js';
import { buildBilingualPdf } from './pdf-renderer.js';
import { TRANSLATABLE_TYPES } from './block-types.js';
import * as pdfjsLib from '../lib/vendor/pdfjs/pdf.min.mjs';

const READER_RENDER_SCALE = 1.5;
const SCROLL_SYNC_RESET_MS = 250;
// review G5:lazy render 預載邊界(相對欄高)。可視區外 ±2 個欄高內先 render
// (捲到時多半已就緒);離開此區釋放 canvas bitmap。Retina(DPR 2)下 A4 每
// bitmap ~18MB,兩欄 × 50 頁一次性全 render 峰值 ~1.8GB——lazy + 釋放把常駐
// bitmap 壓到「可視區 ±2 欄高」的頁數
const READER_LAZY_MARGIN = '200%';

// v2.0.78（批次 5 G3）：renderReader 世代計數。初始逐頁 render loop 執行期間 handle
// 尚未 return，caller 拿不到 destroy 可呼叫（destroyed flag 只保護 handle 建立後的
// async 路徑）——大 PDF render 可跑 10 秒+，期間 toolbar 已可點：第二次 openReader
// 的 `innerHTML = ''` 清欄後，舊輪 resume 繼續 append 它的 leftPage/rightPage 進
// 同一欄 → 新舊譯文頁交錯混排；換檔情境舊輪還對已 close 的 pdfDoc 逐頁空燒。
// 每次 renderReader 進場 bump，舊輪 loop 每頁開頭比對失配即自我終止。
let _renderReaderGen = 0;

/**
 * 渲染雙頁並排閱讀器。
 *
 * @param {LayoutDoc}   doc                   — analyzeLayout 輸出 + translateDocument 寫回 .translation
 * @param {object}      originalPdfDoc        — PDF.js PDFDocumentProxy (原 PDF,左欄 render 用)
 * @param {ArrayBuffer} originalArrayBuffer   — 原 PDF ArrayBuffer (傳給 buildBilingualPdf)
 * @param {HTMLElement} originalCol           — 左欄容器
 * @param {HTMLElement} translatedCol         — 右欄容器
 * @param {object}      [opts]
 * @param {string}      [opts.modelOverride]  — retry 用的 preset model id
 * @param {string|null} [opts.extraPrompt]    — 本文件額外翻譯指令（retry 也要帶，跟主翻譯同 cache key）
 * @param {(failedCount: number) => void} [opts.onFailedCountChange]
 * @param {() => void} [opts.onFontFallback] — 遠端字型抓不到退回內建 TC 時呼叫（提示用）
 * @returns {Promise<ReaderHandle>}
 */
export async function renderReader(doc, originalPdfDoc, originalArrayBuffer, originalCol, translatedCol, opts = {}) {
  const _myRenderGen = ++_renderReaderGen;   // G3：見 _renderReaderGen 註解
  const { modelOverride, engine, glossary, extraPrompt = null, onFailedCountChange = () => {}, onFontFallback = null } = opts;
  let currentZoom = opts.initialZoom || 1.0;
  let syncEnabled = opts.initialSyncEnabled !== false;

  originalCol.innerHTML = '';
  translatedCol.innerHTML = '';

  if (!doc || !originalPdfDoc || !originalArrayBuffer) {
    const _t = (k) => window.__SK?.i18n?.t?.(k) ?? k;
    originalCol.innerHTML = `<div class="reader-empty">${_t('doc.reader.empty.notUploaded')}</div>`;
    translatedCol.innerHTML = `<div class="reader-empty">${_t('doc.reader.empty.notTranslated')}</div>`;
    return null;
  }

  // ---- 1. 生成譯文 PDF + 用 PDF.js 開起來 ----
  let translatedBytes = null;
  let translatedFilename = null;
  let translatedPdfDoc = null;
  // destroy 後的 async 收尾守門：retryAllFailed 逐 block 打付費 API 可跑數十秒，
  // 使用者中途「重新上傳」換檔 → destroy() 只 null 掉變數擋不住 loop 續跑
  // (照燒 API + regenerate 在已死 handle 上重建 PDF.js doc 永久洩漏)
  let destroyed = false;

  async function regenerateTranslatedPdf() {
    if (destroyed) return;
    if (translatedPdfDoc) {
      try { await translatedPdfDoc.destroy(); } catch (_) { /* ignore */ }
      translatedPdfDoc = null;
    }
    const built = await buildBilingualPdf(originalArrayBuffer, doc);
    // zh-CN / ja / ko 需要遠端字型但抓不到 → 已退回內建 TC，讓 index.js 提示使用者
    if (built.fontFallback && typeof onFontFallback === 'function') onFontFallback(built.fontSource);
    translatedBytes = built.bytes;
    translatedFilename = built.filename;
    // slice(0) 給 PDF.js 一份新 buffer 避免它 detach 我們的 cache。
    // disableFontFace: true:cantoo embed 的 NotoSansTC subset PDF.js render
    // 容易出 glyph 散開問題(textContent 仍正確,但 canvas render 把 ASCII
    // 字符空白化)。改用 Type3 fallback render 避開
    const task = pdfjsLib.getDocument({
      data: translatedBytes.slice(0),
      disableFontFace: true,
      password: '',
    });
    translatedPdfDoc = await task.promise;
  }

  await regenerateTranslatedPdf();

  // ---- 2. 為每頁建左/右 page 骨架;canvas 進可視區才 render(review G5)----
  // 原本全書一次性 render。改 lazy:page div 尺寸由 getViewport 先就位(只解析
  // 頁面字典不 rasterize;scroll sync / zoom 只依賴 div 尺寸),各欄掛
  // IntersectionObserver(root = 該欄,margin ±READER_LAZY_MARGIN),進區 render、
  // 出區釋放 bitmap(canvas.width=0;div 尺寸固定,版面不動)。
  const pageMeta = new Map(); // pageEl -> { idx, side, rendered, inZone }
  let renderChain = Promise.resolve(); // 串行化 render,快速捲動不並行風暴

  function releaseCanvas(pageEl) {
    const canvas = pageEl.querySelector('canvas');
    if (canvas && canvas.width > 0) { canvas.width = 0; canvas.height = 0; }
  }

  async function renderPage(pageEl) {
    const meta = pageMeta.get(pageEl);
    if (!meta || destroyed || _myRenderGen !== _renderReaderGen) return;
    const pdf = meta.side === 'left' ? originalPdfDoc : translatedPdfDoc;
    const canvas = pageEl.querySelector('canvas');
    if (!pdf || !canvas) return;
    try {
      await renderPageToCanvas(pdf, meta.idx, canvas, READER_RENDER_SCALE);
      meta.rendered = true;
    } catch (err) {
      console.error('[Shinkansen] reader render page failed', meta.idx, err);
    }
  }

  function queueRender(pageEl) {
    renderChain = renderChain.then(() => {
      const m = pageMeta.get(pageEl);
      if (!m || m.rendered || !m.inZone) return undefined; // 已出區 / 已 render
      return renderPage(pageEl);
    });
  }

  const onZoneChange = (entries) => {
    for (const e of entries) {
      const meta = pageMeta.get(e.target);
      if (!meta) continue;
      meta.inZone = e.isIntersecting;
      if (e.isIntersecting) {
        if (!meta.rendered) queueRender(e.target);
      } else if (meta.rendered) {
        meta.rendered = false;
        releaseCanvas(e.target);
      }
    }
  };
  const leftIO = new IntersectionObserver(onZoneChange, {
    root: originalCol, rootMargin: `${READER_LAZY_MARGIN} 0px`,
  });
  const rightIO = new IntersectionObserver(onZoneChange, {
    root: translatedCol, rootMargin: `${READER_LAZY_MARGIN} 0px`,
  });

  const pageCount = Math.min(doc.pages.length, originalPdfDoc.numPages, translatedPdfDoc.numPages);
  for (let i = 0; i < pageCount; i++) {
    // G3：世代失配 = 第二輪 renderReader 已清欄開跑——本輪自我終止，不再 append
    // 舊頁進新欄（交錯混排）也不對可能已 close 的 pdfDoc 空燒。自己開的
    // translatedPdfDoc 順手收掉（handle 不會 return，沒人幫收）
    if (_myRenderGen !== _renderReaderGen) {
      destroyed = true;
      leftIO.disconnect();
      rightIO.disconnect();
      if (translatedPdfDoc) {
        try { await translatedPdfDoc.destroy(); } catch (_) { /* ignore */ }
        translatedPdfDoc = null;
      }
      return null;
    }
    const leftPage = document.createElement('div');
    leftPage.className = 'reader-page reader-page-original';
    leftPage.dataset.pageIndex = String(i);
    const leftCanvas = document.createElement('canvas');
    leftCanvas.width = 0;   // 未 render 前不佔 bitmap(canvas 預設 300×150)
    leftCanvas.height = 0;
    leftPage.appendChild(leftCanvas);
    originalCol.appendChild(leftPage);

    const rightPage = document.createElement('div');
    rightPage.className = 'reader-page reader-page-translated';
    rightPage.dataset.pageIndex = String(i);
    const rightCanvas = document.createElement('canvas');
    rightCanvas.width = 0;
    rightCanvas.height = 0;
    rightPage.appendChild(rightCanvas);
    translatedCol.appendChild(rightPage);

    try {
      // 尺寸先就位(getViewport 不 rasterize,便宜)
      const leftViewport = (await originalPdfDoc.getPage(i + 1)).getViewport({ scale: READER_RENDER_SCALE });
      const rightViewport = (await translatedPdfDoc.getPage(i + 1)).getViewport({ scale: READER_RENDER_SCALE });
      leftPage.dataset.baseWidth = String(leftViewport.width);
      leftPage.dataset.baseHeight = String(leftViewport.height);
      rightPage.dataset.baseWidth = String(rightViewport.width);
      rightPage.dataset.baseHeight = String(rightViewport.height);
      applyZoomToPage(leftPage, currentZoom);
      applyZoomToPage(rightPage, currentZoom);
      pageMeta.set(leftPage, { idx: i, side: 'left', rendered: false, inZone: false });
      pageMeta.set(rightPage, { idx: i, side: 'right', rendered: false, inZone: false });
      leftIO.observe(leftPage);
      rightIO.observe(rightPage);
    } catch (err) {
      console.error('[Shinkansen] reader page setup failed', i, err);
      const _t = (k, p) => window.__SK?.i18n?.t?.(k, p) ?? k;
      leftPage.innerHTML = `<div class="reader-empty">${_t('doc.reader.empty.renderFail', { n: i + 1 })}</div>`;
    }
  }

  // dev / 批次驗收工具 hook(比照 window.__skLayoutDoc):harness 要對全書 canvas
  // toDataURL 截圖,lazy render 下離區頁沒 bitmap → 工具先 await 此 hook 全量
  // render。production 無人呼叫,不影響 lazy 行為
  async function renderAllPages() {
    for (const [pageEl, meta] of pageMeta) {
      if (destroyed || _myRenderGen !== _renderReaderGen) return;
      if (!meta.rendered) await renderPage(pageEl);
    }
  }
  window.__skReaderRenderAll = renderAllPages;

  // ---- 3. scroll sync ----
  let sync = setupScrollSync(originalCol, translatedCol);
  sync.setEnabled(syncEnabled);
  emitFailedCount();

  function emitFailedCount() {
    let n = 0;
    for (const p of doc.pages) {
      for (const b of p.blocks) {
        if (TRANSLATABLE_TYPES.has(b.type) && b.translationStatus === 'failed') n++;
      }
    }
    onFailedCountChange(n);
  }

  // 重 render 右欄(retry 後譯文 PDF 重新生成)。review G5:pageIndexes(Set)
  // 指定只重繪含變動 block 的頁——原本 retry 成功後不管改幾段、全書重繪。
  // 在區內的頁立即重繪;離區頁只標記未 render + 釋放,回可視區時 IO lazy 重繪
  async function rerenderRightColumn(pageIndexes = null) {
    if (destroyed || !translatedPdfDoc) return;
    const rightPages = translatedCol.querySelectorAll('.reader-page-translated');
    const n = Math.min(rightPages.length, translatedPdfDoc.numPages);
    for (let i = 0; i < n; i++) {
      if (pageIndexes && !pageIndexes.has(i)) continue;
      const pageEl = rightPages[i];
      const meta = pageMeta.get(pageEl);
      if (!meta) continue;
      if (meta.inZone) {
        await renderPage(pageEl);
      } else if (meta.rendered) {
        meta.rendered = false;
        releaseCanvas(pageEl);
      }
    }
  }

  return {
    setSyncEnabled(enabled) {
      syncEnabled = !!enabled;
      sync.setEnabled(syncEnabled);
    },
    setZoom(zoom) {
      const z = Math.max(0.5, Math.min(2.0, zoom));
      currentZoom = z;
      for (const el of originalCol.querySelectorAll('.reader-page-original')) {
        applyZoomToPage(el, z);
      }
      for (const el of translatedCol.querySelectorAll('.reader-page-translated')) {
        applyZoomToPage(el, z);
      }
      // page 尺寸變 → sync 內部 offsetTop 失效,重建
      sync.destroy();
      sync = setupScrollSync(originalCol, translatedCol);
      sync.setEnabled(syncEnabled);
      return z;
    },
    getZoom() { return currentZoom; },
    getTranslatedPdfBytes() { return translatedBytes; },
    getTranslatedPdfFilename() { return translatedFilename; },
    async retryAllFailed() {
      // 收集所有 failed block(帶所在頁索引),逐個 translateSingleBlock
      const failed = [];
      for (let pi = 0; pi < doc.pages.length; pi++) {
        for (const b of doc.pages[pi].blocks) {
          if (TRANSLATABLE_TYPES.has(b.type) && b.translationStatus === 'failed') {
            failed.push({ block: b, pageIdx: pi });
          }
        }
      }
      let success = 0;
      const successPages = new Set();  // review G5:只重繪含重翻成功 block 的頁
      for (const { block, pageIdx } of failed) {
        if (destroyed) return { total: failed.length, success }; // 已換檔，停止燒 API
        const r = await translateSingleBlock(block, { modelOverride, engine, glossary, extraPrompt });
        if (r.ok) { success++; successPages.add(pageIdx); }
      }
      // 至少有 1 個重翻成功 → 重建譯文 PDF + 只重繪變動頁
      if (success > 0 && !destroyed) {
        await regenerateTranslatedPdf();
        if (!destroyed) await rerenderRightColumn(successPages);
      }
      if (!destroyed) emitFailedCount();
      return { total: failed.length, success };
    },
    renderAllPages,  // 批次驗收 / debug 工具用,production 不呼叫(review G5)
    destroy() {
      destroyed = true;
      sync.destroy();
      leftIO.disconnect();
      rightIO.disconnect();
      if (window.__skReaderRenderAll === renderAllPages) delete window.__skReaderRenderAll;
      if (translatedPdfDoc) {
        translatedPdfDoc.destroy().catch(() => {});
        translatedPdfDoc = null;
      }
      translatedBytes = null;
    },
  };
}

// 對 reader-page 套用 zoom
function applyZoomToPage(pageEl, zoom) {
  const baseW = parseFloat(pageEl.dataset.baseWidth) || 0;
  const baseH = parseFloat(pageEl.dataset.baseHeight) || 0;
  if (baseW === 0 || baseH === 0) return;
  pageEl.style.width = `${baseW * zoom}px`;
  pageEl.style.height = `${baseH * zoom}px`;
}

// ---------- 雙向 scroll sync(page-level + 頁內相對 y 比例)----------
//
// 兩欄 page 高度套同 zoom + baseW/H,「左 page X 內相對 y 比例 = 右 page X
// 內相對 y 比例」。viewport 中心 y → (pageIdx, ratioInPage) → 對另一欄套用
function setupScrollSync(leftCol, rightCol) {
  let enabled = true;
  let source = null;
  let resetTimer = null;
  let leftRaf = null;
  let rightRaf = null;

  function findColumnPageAndRatio(col, pageSelector) {
    const center = col.scrollTop + col.clientHeight / 2;
    const pages = col.querySelectorAll(pageSelector);
    if (pages.length === 0) return null;
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const top = p.offsetTop;
      const bottom = top + p.clientHeight;
      if (center >= top && center <= bottom) {
        const ratio = p.clientHeight > 0 ? (center - top) / p.clientHeight : 0;
        return { pageIdx: i, ratio };
      }
    }
    const firstTop = pages[0].offsetTop;
    const lastBottom = pages[pages.length - 1].offsetTop + pages[pages.length - 1].clientHeight;
    if (center < firstTop) return { pageIdx: 0, ratio: 0 };
    if (center > lastBottom) return { pageIdx: pages.length - 1, ratio: 1 };
    return null;
  }

  function applyToColumn(col, pageSelector, info) {
    const pages = col.querySelectorAll(pageSelector);
    const target = pages[info.pageIdx];
    if (!target) return;
    const targetCenter = target.offsetTop + target.clientHeight * info.ratio;
    const targetScrollTop = targetCenter - col.clientHeight / 2;
    col.scrollTo({ top: targetScrollTop, behavior: 'auto' });
  }

  function resetSourceAfter() {
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { source = null; }, SCROLL_SYNC_RESET_MS);
  }

  function onLeftScroll() {
    if (!enabled) return;
    if (source && source !== 'left') return;
    if (leftRaf) return;
    leftRaf = requestAnimationFrame(() => {
      leftRaf = null;
      const info = findColumnPageAndRatio(leftCol, '.reader-page-original');
      if (!info) return;
      source = 'left';
      applyToColumn(rightCol, '.reader-page-translated', info);
      resetSourceAfter();
    });
  }

  function onRightScroll() {
    if (!enabled) return;
    if (source && source !== 'right') return;
    if (rightRaf) return;
    rightRaf = requestAnimationFrame(() => {
      rightRaf = null;
      const info = findColumnPageAndRatio(rightCol, '.reader-page-translated');
      if (!info) return;
      source = 'right';
      applyToColumn(leftCol, '.reader-page-original', info);
      resetSourceAfter();
    });
  }

  leftCol.addEventListener('scroll', onLeftScroll, { passive: true });
  rightCol.addEventListener('scroll', onRightScroll, { passive: true });

  return {
    setEnabled(v) { enabled = !!v; },
    destroy() {
      leftCol.removeEventListener('scroll', onLeftScroll);
      rightCol.removeEventListener('scroll', onRightScroll);
      clearTimeout(resetTimer);
      if (leftRaf) cancelAnimationFrame(leftRaf);
      if (rightRaf) cancelAnimationFrame(rightRaf);
    },
  };
}

/**
 * 把所有翻譯後的 block plainText / translation 整理成純文字輸出(複製譯文用)。
 */
export function buildPlainTextDump(doc) {
  if (!doc) return '';
  const lines = [];
  for (let i = 0; i < doc.pages.length; i++) {
    const page = doc.pages[i];
    const _t = (k, p) => window.__SK?.i18n?.t?.(k, p) ?? k;
    lines.push(_t('doc.reader.dump.pageHeader', { n: i + 1 }));
    for (const block of page.blocks) {
      const t = block.translation || block.plainText;
      if (!t) continue;
      lines.push(t);
      lines.push('');
    }
  }
  return lines.join('\n');
}
