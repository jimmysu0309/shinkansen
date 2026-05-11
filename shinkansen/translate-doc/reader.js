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
import * as pdfjsLib from '../lib/vendor/pdfjs/pdf.min.mjs';

const READER_RENDER_SCALE = 1.5;
const TRANSLATABLE_TYPES = new Set(['paragraph', 'heading', 'list-item', 'caption', 'footnote']);
const SCROLL_SYNC_RESET_MS = 250;

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
 * @param {(failedCount: number) => void} [opts.onFailedCountChange]
 * @returns {Promise<ReaderHandle>}
 */
export async function renderReader(doc, originalPdfDoc, originalArrayBuffer, originalCol, translatedCol, opts = {}) {
  const { modelOverride, engine, glossary, onFailedCountChange = () => {} } = opts;
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

  async function regenerateTranslatedPdf() {
    if (translatedPdfDoc) {
      try { await translatedPdfDoc.destroy(); } catch (_) { /* ignore */ }
      translatedPdfDoc = null;
    }
    const built = await buildBilingualPdf(originalArrayBuffer, doc);
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

  // ---- 2. 為每頁建左/右 canvas + render ----
  const pageCount = Math.min(doc.pages.length, originalPdfDoc.numPages, translatedPdfDoc.numPages);
  for (let i = 0; i < pageCount; i++) {
    const leftPage = document.createElement('div');
    leftPage.className = 'reader-page reader-page-original';
    leftPage.dataset.pageIndex = String(i);
    const leftCanvas = document.createElement('canvas');
    leftPage.appendChild(leftCanvas);
    originalCol.appendChild(leftPage);

    const rightPage = document.createElement('div');
    rightPage.className = 'reader-page reader-page-translated';
    rightPage.dataset.pageIndex = String(i);
    const rightCanvas = document.createElement('canvas');
    rightPage.appendChild(rightCanvas);
    translatedCol.appendChild(rightPage);

    try {
      const leftInfo = await renderPageToCanvas(originalPdfDoc, i, leftCanvas, READER_RENDER_SCALE);
      const rightInfo = await renderPageToCanvas(translatedPdfDoc, i, rightCanvas, READER_RENDER_SCALE);

      leftPage.dataset.baseWidth = String(leftInfo.width);
      leftPage.dataset.baseHeight = String(leftInfo.height);
      rightPage.dataset.baseWidth = String(rightInfo.width);
      rightPage.dataset.baseHeight = String(rightInfo.height);
      applyZoomToPage(leftPage, currentZoom);
      applyZoomToPage(rightPage, currentZoom);
    } catch (err) {
      console.error('[Shinkansen] reader render page failed', i, err);
      const _t = (k, p) => window.__SK?.i18n?.t?.(k, p) ?? k;
      leftPage.innerHTML = `<div class="reader-empty">${_t('doc.reader.empty.renderFail', { n: i + 1 })}</div>`;
    }
  }

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

  // 重 render 右欄(retry 後譯文 PDF 重新生成,canvas 重畫)
  async function rerenderRightColumn() {
    const rightPages = translatedCol.querySelectorAll('.reader-page-translated');
    const n = Math.min(rightPages.length, translatedPdfDoc.numPages);
    for (let i = 0; i < n; i++) {
      const canvas = rightPages[i].querySelector('canvas');
      if (!canvas) continue;
      try {
        await renderPageToCanvas(translatedPdfDoc, i, canvas, READER_RENDER_SCALE);
      } catch (err) {
        console.error('[Shinkansen] reader rerender page failed', i, err);
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
      // 收集所有 failed block,逐個 translateSingleBlock
      const failed = [];
      for (const p of doc.pages) {
        for (const b of p.blocks) {
          if (TRANSLATABLE_TYPES.has(b.type) && b.translationStatus === 'failed') failed.push(b);
        }
      }
      let success = 0;
      for (const block of failed) {
        const r = await translateSingleBlock(block, { modelOverride, engine, glossary });
        if (r.ok) success++;
      }
      // 至少有 1 個重翻成功 → 重建譯文 PDF + 重 render 右欄
      if (success > 0) {
        await regenerateTranslatedPdf();
        await rerenderRightColumn();
      }
      emitFailedCount();
      return { total: failed.length, success };
    },
    destroy() {
      sync.destroy();
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
