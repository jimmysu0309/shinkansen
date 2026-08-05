// index.js — translate-doc 頁面主協調層
//
// W2-iter1：上傳 → parsePdf → analyzeLayout → 顯示版面 IR 摘要 + 提供 debug overlay 預覽
// (SVG 疊在 PDF.js canvas 上，可肉眼驗 block 切分是否合理)。
// 完整翻譯 / 閱讀器 / 下載走後續週次。

import { parsePdf, preflightFile, renderPageToCanvas, closeDocument, PdfParseError } from './pdf-engine.js';
import { analyzeLayout } from './layout-analyzer.js';
import { translateDocument, segmentsToMarkdown, markdownToSegments, collectGlossaryInputParts, clearTcCacheForTexts } from './translate.js';
import { TRANSLATABLE_TYPES } from './block-types.js';
import { renderReader, buildPlainTextDump } from './reader.js';
import { downloadBilingualPdf, buildBilingualPdf } from './pdf-renderer.js';
import { formatMoney } from '../lib/format.js';
import { getCachedRate, FALLBACK_USD_TWD_RATE } from '../lib/exchange-rate.js';
// EPUB 翻譯（v2.0.11）
import {
  parseEpub, preflightEpubFile, estimateChapterCostUSD, EPUB_LIMITS,
  buildBookGlossaryRounds, mergeBookGlossaries, glossaryGroupOf, normalizeNameSeparators,
  BOOK_GLOSSARY_MAX_TERMS,
} from './epub-engine.js';
import { buildTranslatedEpub, translatedEpubFilename, computeAnnotationDedupe } from './epub-writer.js';
// 譯後一致性掃描（v2.0.11，SPEC §17.10.10）
import {
  checkGlossaryCompliance, mineCandidates, buildScanBatches, aggregateRenderings, sourceHasTerm,
  replaceTermInText, addCjkLatinSpacing,
} from './epub-scan.js';
import {
  loadEpubSession, saveEpubSession, deleteEpubSession, collectSessionBlocks, hydrateSessionBlocks,
  collectSessionFailures,
} from './epub-session-db.js';
import { getSettings } from '../lib/storage.js';

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
  // EPUB（v2.0.11）：章節選翻清單 + 單章譯文預覽 + 一致性掃描結果
  chapters: $('stage-chapters'),
  epubPreview: $('stage-epub-preview'),
  scan: $('stage-scan'),
};

let parseAbortController = null;
// 解析 generation token:每次 handleFile / 取消都 ++。in-flight 的 handleFile 在每個
// await resume 點比對自己抓的 gen,不相等代表已被取消(或被新一輪上傳取代)→ 丟棄結果,
// 不寫 module state、不 showStage('result') 蓋掉取消後的 upload 畫面
let parseGeneration = 0;
let translateAbortController = null;
let currentDoc = null;       // analyzeLayout 輸出
let currentPdfDoc = null;    // PDF.js PDFDocumentProxy（記得 destroy）
let currentDebugPage = 0;
let currentReaderHandle = null;
// openReader 的 in-flight 守門(比照 parseGeneration):renderReader await 期間
// currentReaderHandle 為 null,releaseCurrentDoc 摸不到，靠 gen 比對丟棄舊輪
let readerGeneration = 0;
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
// EPUB（v2.0.11）：本書跨輪累計費用（試翻 + 續翻加總，SPEC-PRIVATE §30.4)
let epubCumulativeCostUSD = 0;
// 譯後一致性掃描（v2.0.11）：結果不持久化，每輪翻譯完成後重掃
// （對照抽取有 scanr_ 內容快取，重掃不重複計費）
let epubScanState = null; // { running, tier1: [violations], cases: [drift], autoFixes }
let epubScanGen = 0;      // 換檔 / 放棄時 ++，讓 in-flight 掃描丟棄結果
// 略過清單（2026-07-10 Jimmy 指示）：人工 review 後認定不需替換的術語表違規
// entry（source→expected），隨工作階段持久化——重掃不再列出、自動替換也不碰
let epubScanIgnored = new Map(); // key = source + '→' + expected → { source, expected }
// 漂移案例（第二層）的略過清單（2026-07-10）：人工判斷非真漂移的 term——
// 隨工作階段持久化；下次掃描連候選 / LLM 對照抽取都跳過（省費用）
let epubScanIgnoredDrift = new Set(); // term 字串
// EPUB 書指紋（全書 plainText 的 sha1）：工作階段存檔 / 術語表持久化的 key。
// 用內容 hash 不用 OPF dc:identifier——出版社填寫品質不可靠
let epubBookHash = null;
// EPUB 本書獨立禁用詞（2026-07-10）：與 options 共通清單合併注入，隨 session 持久化
let currentBookForbidden = [];
// 本文件額外翻譯指令（2026-07-27）：per-document 補充 prompt，附加在
// translateDoc.systemPrompt 之後送 LLM（background 端組裝）。PDF 只存在記憶體
//（換檔即清）；EPUB 隨工作階段持久化並進「匯出工作階段」JSON
let currentDocExtraPrompt = '';
// EPUB 預覽狀態：原文對照 toggle + 目前預覽範圍（章節物件或 'all'）
let epubPreviewCompare = false;
let epubPreviewScope = null;

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

// v1.9.6: stage-result 用 inline banner（不踢回 upload stage，讓使用者保留已解析的
// 文件，改 preset / 設定後再點翻譯）
function showResultError(msg) {
  const el = $('result-error');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}

function clearResultError() {
  const el = $('result-error');
  if (!el) return;
  el.textContent = '';
  el.hidden = true;
}

// v2.0.78（批次 5 G9）：PDF 路徑 translateDocument throw 時的失敗原因顯示——
// 原本 exception 被包成 error summary 後直接 openReader()，fillSummaryDialog 只
// 顯示計數欄不讀 summary.error → 使用者拿到全未翻譯的 reader 卻看不到失敗原因。
// EPUB 路徑有 showChaptersError(summary.error) 對等處理，這裡補 PDF 版（同樣顯示
// raw error 訊息——codedError 協定的訊息本身已是使用者面對字串）
function showReaderError(msg) {
  const el = $('reader-error');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}

function clearReaderError() {
  const el = $('reader-error');
  if (!el) return;
  el.textContent = '';
  el.hidden = true;
}

function setParsingDetail(text) {
  $('parsing-detail').textContent = text;
}

function releaseCurrentDoc() {
  // 排程中的 EPUB session 存檔先落地再清 state（debounce 內的預覽編輯不掉失）
  flushPendingSessionSave();
  // bump generation:openReader 的 renderReader 可能還 in-flight(大 PDF 全頁 canvas
  // render 可達 10 秒+,await 期間 currentReaderHandle 是 null，這裡摸不到它)——
  // gen 失配讓那輪完成後自行 destroy，不把舊檔的 handle / DOM 寫進新檔的欄位
  readerGeneration++;
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
  epubCumulativeCostUSD = 0;
  epubBookHash = null;
  _sessionSavedSig = new Map();  // review G11:換檔清增量簽章,下本書首存全量寫
  currentBookForbidden = [];
  currentDocExtraPrompt = '';
  epubPreviewScope = null;
  epubScanGen++; // 取消 in-flight 一致性掃描
  epubScanState = null;
  epubScanIgnored = new Map();
  epubScanIgnoredDrift = new Set();
  if (window.__skLayoutDoc) delete window.__skLayoutDoc;
}

// dev hook(批次 8 G6):verify harness 抽到 dev-verify.js,harness / spec 端先呼叫
// await window.__skInstallVerify() 再用 window.__skVerify。production 正常使用不載入。
window.__skInstallVerify = async () => {
  if (!window.__skVerify) {
    const m = await import('./dev-verify.js');
    window.__skVerify = m.createVerify({
      getCurrentDoc: () => currentDoc,
      getCurrentOriginalArrayBuffer: () => currentOriginalArrayBuffer,
    });
  }
  return true;
};

async function handleFile(file) {
  clearError();
  clearResultError();

  // EPUB 分流（v2.0.11）：副檔名 / MIME 命中就走 EPUB 管線，其餘維持 PDF 路徑
  if (/\.epub$/i.test(file.name || '') || (file.type || '') === 'application/epub+zip') {
    return handleEpubFile(file);
  }

  const pre = preflightFile(file);
  if (pre.level === 'error') {
    showError(pre.message);
    return;
  }
  // softWarn（超過 5MB 但未達 10MB）目前先不做 modal，直接繼續解析
  // 軟警告完整 modal 走 W7 UX polish

  // 切新檔前釋放舊 pdfDoc(避免 PDF.js Worker 累積)
  releaseCurrentDoc();

  // generation token + AbortController:取消時 abort 真的停掉 parsePdf page loop,
  // gen 比對讓已 resume 的舊輪丟棄結果(不蓋掉取消後的 upload 畫面 / 不寫壞 state)
  // 直接換檔(未按取消)時也要 abort 前一輪——否則舊 parse 的 page loop
  // (getTextContent + getOperatorList，重)會跟新 parse 並行跑到底才被 gen 比對丟棄
  if (parseAbortController) parseAbortController.abort();
  const myGen = ++parseGeneration;
  parseAbortController = new AbortController();
  const parseSignal = parseAbortController.signal;

  showStage('parsing');
  setParsingDetail(t('doc.parsing.detail.fileContent'));

  let rawDoc = null;
  try {
    // W6：讀一次 file.arrayBuffer() cache 起來，給後續 pdf-renderer 重組譯文 PDF 用
    // (parsePdf 內也讀一次，但 PDF.js 內部消費掉，不能 reuse；這裡多 read 一次)
    const buf = await file.arrayBuffer();
    if (myGen !== parseGeneration) return; // 已取消:不寫 state
    currentOriginalArrayBuffer = buf;
    rawDoc = await parsePdf(file, (progress) => {
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
    }, { signal: parseSignal });
    if (myGen !== parseGeneration) {
      // parse 完成前被取消(abort 沒攔到的窗口):丟棄結果並釋放剛開的 pdfDoc
      closeDocument(rawDoc.pdfDoc);
      return;
    }

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
    };
    // 批次 8 G6:_rawPages 改 opt-in——原本無條件掛在 __skLayoutDoc 直到換檔,大 PDF
    // 多留數 MB~數十 MB(註解寫「iter4 移除」一直沒移)。只有 harness / spec 事先設
    // window.__skKeepRawPages = true 才 expose(pdf-rotated-text-drop.spec 用)
    if (window.__skKeepRawPages) {
      window.__skLayoutDoc._rawPages = rawDoc.pages.map((p) => ({
        pageIndex: p.pageIndex,
        viewport: p.viewport,
        textRuns: p.textRuns,
      }));
    }


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
    // 取消觸發的中止:cancel handler 已清 state + 回 upload,這裡靜默收尾即可
    // (不彈「解析失敗」error)。aborted code 來自 parsePdf 的 signal 檢查
    if (myGen !== parseGeneration || (err instanceof PdfParseError && err.code === 'aborted')) {
      if (rawDoc && rawDoc.pdfDoc && rawDoc.pdfDoc !== currentPdfDoc) closeDocument(rawDoc.pdfDoc);
      return;
    }
    if (err instanceof PdfParseError) {
      showError(err.message);
    } else {
      console.error('[Shinkansen] PDF 解析失敗', err);
      showError(t('doc.parsing.fail', { error: (err && err.message) || String(err) }));
    }
    // analyzeLayout / 後續 UI 段 throw 時 rawDoc.pdfDoc 還沒掛上 currentPdfDoc,
    // releaseCurrentDoc 摸不到它 → 這裡補 destroy(已掛上的交給 releaseCurrentDoc)
    if (rawDoc && rawDoc.pdfDoc && rawDoc.pdfDoc !== currentPdfDoc) closeDocument(rawDoc.pdfDoc);
    releaseCurrentDoc();
  } finally {
    if (myGen === parseGeneration) parseAbortController = null;
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

// 批次 8 G10:debug canvas render cache(同頁只 render 一次,overlay 獨立重畫)
let _debugCanvasCache = null;

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
  // 批次 8 G10:同一頁重繪(isolate 輸入每個 keystroke / bbox / order / 色彩模式
  // 切換)重用 canvas bitmap,只重畫 SVG overlay——原本每個 keystroke 都整頁
  // PDF.js re-render。cache key 綁 currentPdfDoc 參照,換檔自動失效
  if (_debugCanvasCache
      && _debugCanvasCache.pdfDoc === currentPdfDoc
      && _debugCanvasCache.pageIndex === pageIndex) {
    renderInfo = _debugCanvasCache.renderInfo;
  } else {
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
    _debugCanvasCache = { pdfDoc: currentPdfDoc, pageIndex, renderInfo };
  }

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
    // ++gen 讓 in-flight handleFile resume 後丟棄結果;abort 真的停掉 parsePdf page loop
    parseGeneration++;
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

const GLOSSARY_INPUT_MAX_CHARS = 60_000;

// computeStructureDiagnostics 已隨 dev verify harness 抽到 dev-verify.js(批次 8 G6)

// 對整份 PDF 送 EXTRACT_GLOSSARY 拿 [{source, target}] 對照表(術語表一致化)
// 取樣邏輯抽到 translate.js collectGlossaryInputParts(可 unit 測;原 inline 版有
// slice(0, 負值) 邊界 bug:acc 含 join 分隔符預算可超過 MAX,後續 block 算出負 room)
async function extractGlossaryForDoc(doc, { forceRefresh = false } = {}) {
  const parts = collectGlossaryInputParts(doc, GLOSSARY_INPUT_MAX_CHARS);
  const compressedText = parts.join('\n');
  if (compressedText.length < 200) {
    console.log('[Shinkansen] glossary skipped (text too short)', { chars: compressedText.length });
    return null;
  }
  const inputHash = await sha1(compressedText);
  console.log('[Shinkansen] glossary extracting', { chars: compressedText.length, hash: inputHash.slice(0, 8) });
  // modelOverride：術語擷取模型設「與主翻譯模型相同」時，對文件翻譯要用頁面
  // preset 而非全域模型（2026-07-10）。抽取常發生在翻譯開始前
  //（currentModelOverride 尚未設定），就地解析 preset
  const presetModel = currentModelOverride || (await resolvePreset()).modelOverride || null;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'EXTRACT_GLOSSARY',
      payload: { compressedText, inputHash, forceRefresh, modelOverride: presetModel },
    });
    if (res?.ok && Array.isArray(res.glossary) && res.glossary.length > 0) {
      // 人名間隔號正規化（同 mergeBookGlossaries 的 EPUB 路徑）
      return res.glossary.map((e) => ({ ...e, target: normalizeNameSeparators(e.target) }));
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
  // find-by-slot 與全 codebase 其他路徑(openSettingsDialog / content.js / options.js /
  // background.js)一致——匯入的設定允許 slot 順序亂 / 不足 3 條，用陣列 index 查
  // 會拿錯 preset(dialog 顯示 slot 2、實際用到 slot 1 的 engine/model)
  const p = presets.find((x) => x && x.slot === (currentPresetSlot || 1));
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

// 設定 dialog 有「進階設定 →」動線開 options 改 preset；不失效 cache 的話，改完
// 回來按翻譯仍用舊 model 打 API(花錯錢),dialog 的 engine 標籤也停留舊值到 reload
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.translatePresets) cachedPresets = null;
  });
} catch (_) { /* storage API 不可用時(單元測試環境)略過 */ }

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

// 文件翻譯每批段數（settings.translateDoc.batchSize，預設 50，clamp 1-100）
async function resolveDocBatchSize() {
  try {
    const s = await getSettings();
    const n = s.translateDoc?.batchSize;
    if (Number.isInteger(n) && n >= 1 && n <= 100) return n;
  } catch (_) { /* fallback */ }
  return 50;
}

async function openSettingsDialog() {
  const presets = await loadPresets();
  const dlg = $('translate-settings-dialog');
  // EPUB：「清除本篇翻譯記憶」已拉出成主功能「放棄本書翻譯」（2026-07-10），
  // dialog 內隱藏（且該按鈕的 plainText hash 算法對 EPUB 段落本來就不對）
  const clearSection = $('settings-clear-doc-cache-btn')?.closest('.settings-section');
  if (clearSection) clearSection.hidden = currentDoc?.kind === 'epub';
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
    // createElement + textContent 組 row(同 setBlockDetail 慣例)——p.label / p.model
    // 是使用者可控字串(設定匯入只驗 typeof string)，不可直接插 innerHTML
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'preset-slot';
    radio.value = String(slot);
    radio.checked = (slot === currentPresetSlot);
    const labelSpan = document.createElement('span');
    labelSpan.className = 'preset-label';
    labelSpan.textContent = presetLabel;
    const engineSpan = document.createElement('span');
    engineSpan.className = 'preset-engine';
    engineSpan.textContent = engineLabel;
    row.append(radio, labelSpan, engineSpan);
    // Google MT preset：文件翻譯不支援 → 顯示但禁選（2026-07-10 Jimmy 回報：
    // 之前照常可選，按開始翻譯才撞 runtime banner）
    if (p.engine === 'google') {
      radio.disabled = true;
      row.classList.add('is-unsupported');
      const note = document.createElement('span');
      note.className = 'preset-unsupported-note';
      note.textContent = t('doc.settings.preset.googleUnsupported');
      row.appendChild(note);
    } else {
      row.addEventListener('click', () => {
        list.querySelectorAll('.settings-preset-row').forEach((el) => el.classList.remove('is-selected'));
        row.classList.add('is-selected');
        row.querySelector('input').checked = true;
      });
    }
    list.appendChild(row);
  }
  // 每批段數（2026-07-10）：載入現值
  $('settings-doc-batch-size').value = String(await resolveDocBatchSize());
  // 本文件額外翻譯指令（2026-07-27）：per-document state 載入現值
  const extraPromptEl = $('settings-doc-extra-prompt');
  if (extraPromptEl) extraPromptEl.value = currentDocExtraPrompt;
  // 段落間距 + 一致性掃描 toggle（EPUB 專屬，PDF 隱藏）
  const spacingSection = $('settings-epub-paragraph-spacing')?.closest('.settings-section');
  if (spacingSection) spacingSection.hidden = currentDoc?.kind !== 'epub';
  const scanSection = $('settings-epub-consistency-scan')?.closest('.settings-section');
  if (scanSection) scanSection.hidden = currentDoc?.kind !== 'epub';
  const autofixSection = $('settings-epub-autofix-spacing')?.closest('.settings-section');
  if (autofixSection) autofixSection.hidden = currentDoc?.kind !== 'epub';
  try {
    const s = await getSettings();
    $('settings-epub-paragraph-spacing').checked = s.translateDoc?.epubParagraphSpacing === true;
    // 一致性掃描預設開啟（缺值 = 開）
    const scanCb = $('settings-epub-consistency-scan');
    if (scanCb) scanCb.checked = s.translateDoc?.consistencyScan !== false;
    // 空格自動校正預設開啟（缺值 = 開）
    const fixCb = $('settings-epub-autofix-spacing');
    if (fixCb) fixCb.checked = s.translateDoc?.epubAutoFixSpacing !== false;
  } catch (_) { /* 預設不勾 */ }
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
      // 每批段數 + 段落間距：merge 進 sync.translateDoc（不動 settings.js 管的其他欄位）
      const raw = parseInt($('settings-doc-batch-size').value, 10);
      const batchSize = Number.isInteger(raw) ? Math.min(100, Math.max(1, raw)) : 50;
      // 元素缺失時不可 throw 拖垮整包儲存（2026-07-10 踩過：HTML 區塊漏部署時
      // 這行 TypeError 把 batchSize 的儲存一起吞掉）
      const epubParagraphSpacing = $('settings-epub-paragraph-spacing')?.checked === true;
      const { translateDoc = {} } = await chrome.storage.sync.get('translateDoc');
      const merged = { ...translateDoc, batchSize, epubParagraphSpacing };
      // 元素缺失時不動既有值（同上防禦）；預設開啟 → 只存明確的 true / false
      const scanCb = $('settings-epub-consistency-scan');
      if (scanCb) merged.consistencyScan = scanCb.checked === true;
      const fixCb = $('settings-epub-autofix-spacing');
      if (fixCb) merged.epubAutoFixSpacing = fixCb.checked === true;
      await chrome.storage.sync.set({ translateDoc: merged });
    } catch (_) { /* ignore */ }
    // 本文件額外翻譯指令（2026-07-27）：per-document state，不進 chrome.storage
    //（換文件不該帶著走）；EPUB 隨工作階段落地，匯出工作階段也帶
    const extraPromptEl = $('settings-doc-extra-prompt');
    if (extraPromptEl) {
      const next = extraPromptEl.value.trim();
      if (next !== currentDocExtraPrompt) {
        currentDocExtraPrompt = next;
        if (currentDoc?.kind === 'epub') scheduleEpubSessionSave();
      }
    }
    // v1.9.6: 改 preset 後清掉「Google MT 不支援」banner（讓使用者切到 Gemini / 自訂後不留殘影）
    clearResultError();
    // 換 preset / 模型後每章預估費用要跟著重算（2026-07-10 Jimmy 回報）
    if (currentDoc?.kind === 'epub') await renderChapterList();
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
      if (!TRANSLATABLE_TYPES.has(block.type)) continue;
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
  // v1.10.39(code review 2026-06-09 L4):只需比對 key prefix,不需 value。網頁翻譯快取
  // (tc_ 前綴)也存在 storage.local,重度使用者可能累積數千~數萬條 → get(null) 會把
  // 整份快取(可能數十 MB)反序列化進記憶體只為比 key。優先用 getKeys()(Chrome 130+,
  // 只回 key 不載 value);舊瀏覽器 fallback get(null)。
  const allKeys = (typeof chrome.storage.local.getKeys === 'function')
    ? await chrome.storage.local.getKeys()
    : Object.keys(await chrome.storage.local.get(null));
  const matchedKeys = [];
  for (const key of allKeys) {
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
  const myGen = ++readerGeneration;
  const handle = await renderReader(
    currentDoc,
    currentPdfDoc,
    currentOriginalArrayBuffer,
    $('reader-col-original'),
    $('reader-col-translated'),
    {
      modelOverride: currentModelOverride,
      engine: currentEngine,
      glossary: injectableArticleGlossary(),
      extraPrompt: currentDocExtraPrompt || null,
    },
  );
  // await 期間使用者換檔 / 重新上傳(releaseCurrentDoc bump gen)→ 這輪作廢：
  // destroy 剛建好的 handle 釋放 PDF.js doc，不寫回 state、不掛 scroll sync
  if (myGen !== readerGeneration) {
    try { handle?.destroy(); } catch (_) { /* ignore */ }
    return;
  }
  currentReaderHandle = handle;
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
      if (TRANSLATABLE_TYPES.has(block.type) && block.translationStatus === 'failed') n++;
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
  bindChaptersUI();
  bindEpubPreviewUI();
  bindScanUI();
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
      if (!TRANSLATABLE_TYPES.has(block.type)) continue;
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
      // v2.0.78（批次 5 G2）：用 defaultValue 設初始值（同時設定 value），讓 saveEdits
      // 能以 `value !== defaultValue` 判斷「內容真的有變動」——只對變動 row 改狀態
      textarea.defaultValue = initialMd;
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
    const ta = row.querySelector('textarea');
    const text = ta.value;
    // v2.0.78（批次 5 G2）：內容零變動的 row 完全不動——原本無條件把所有 row 標
    // done + userEdited：失敗段（placeholder 空 textarea）被抹平成 `translation: ''`
    // + status done → countCurrentFailedBlocks 歸零、summary 重試按鈕永久隱藏、
    // reader 橘框警示消失（使用者失去 retryAllFailed 入口）；同時全部 block 被打上
    // userEdited 污染該 flag 的「跳過 re-translate」語意
    if (text === ta.defaultValue) continue;
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

// v2.0.77:防重入 guard——按鈕點擊到 showStage('translating') 之間有多個 await
// (resolvePreset / getSettings / clearEpubBlocksCache 可拖數百 ms),連點兩下會併發
// 兩輪 translateDocument:重複打 API 雙倍計費 + translateAbortController 被第二輪
// 覆蓋(第一輪變不可取消)。所有翻譯入口(translate-btn / chapters-translate-btn /
// glossary-translate-btn)都經 startTranslate,單一 guard 全蓋
let translateInFlight = false;
async function startTranslate() {
  if (translateInFlight) return;
  translateInFlight = true;
  try {
    // return await(非裸 return):EPUB 委派的 promise 要在 guard 內等完,
    // 否則 finally 提早釋放 guard
    return await _startTranslateImpl();
  } finally {
    translateInFlight = false;
  }
}

async function _startTranslateImpl() {
  if (!currentDoc) return;

  // EPUB 走章節選翻管線（軟警告 / 重翻確認 / blockFilter / 批次級 glossary 過濾）
  if (currentDoc.kind === 'epub') return startEpubTranslate();

  const { engine, modelOverride } = await resolvePreset();

  // v1.9.6: Google MT 沒文件翻譯 handler（沒 batch-aware marker / glossary 注入機制），
  // 早期擋 + 顯示 banner，讓使用者改 preset 再試；不踢回 upload stage（保留已解析文件）
  if (engine === 'google') {
    showResultError(t('doc.error.googleNotSupportedInDoc'));
    showStage('result');
    return;
  }

  clearResultError();
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
  // applyGlossary 黑箱 toggle）。沒術語表（null / 空）就不送，等同沒術語表。
  // v2.0.11：經 injectableArticleGlossary 映射（不翻譯 entry → 原文→原文）
  const glossary = injectableArticleGlossary();
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
      batchSize: await resolveDocBatchSize(),
      extraPrompt: currentDocExtraPrompt || null,
    });
  } catch (err) {
    console.error('[Shinkansen] translateDocument 失敗', err);
    summary = {
      totalBlocks: 0,
      translatedBlocks: 0,
      failedBlocks: 0,
      cumulativeInputTokens: 0,
      cumulativeBilledInputTokens: 0,
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
  // G9：整體失敗（translateDocument throw）時在 reader 顯示原因；成功則清掉上輪殘留
  if (summary.error) showReaderError(summary.error);
  else clearReaderError();
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
  const isEpub = currentDoc.kind === 'epub';
  // EPUB 入口的主要按鈕是「儲存」（開始翻譯集中在章節清單主流程，2026-07-10）；
  // PDF 入口維持「用此術語表翻譯」（reader 流程沒有其他重翻入口，不可斷路）
  const actionBtn = $('glossary-translate-btn');
  const actionKey = (isEpub && fromStage === 'chapters') ? 'doc.glossary.btn.save' : 'doc.glossary.btn.translate';
  actionBtn.setAttribute('data-i18n', actionKey);
  actionBtn.textContent = t(actionKey);
  // 本書禁用詞區塊只在 EPUB 顯示
  $('book-forbidden-section').hidden = !isEpub;
  if (isEpub) buildBookForbiddenTable(currentBookForbidden);
  showStage('glossary');
  // 若還沒建術語表(null)→ 顯 loading + 自動跑 EXTRACT_GLOSSARY 拿初始值。
  // 若已有(包含空 [])→ 直接 show table 讓使用者編輯
  if (currentArticleGlossary === null) {
    setGlossaryState(t('doc.glossary.state.loading'), 'is-loading');
    try {
      // EPUB 走全書逐章分輪抽取（覆蓋全書，不是只抽開頭 60K 字）
      const extracted = isEpub
        ? await extractGlossaryForBook(currentDoc)
        : await extractGlossaryForDoc(currentDoc);
      currentArticleGlossary = Array.isArray(extracted) ? extracted : [];
      if (isEpub && currentArticleGlossary.length > 0) {
        await savePersistedBookGlossary(currentArticleGlossary);
      }
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

// 分組渲染（2026-07-10）：人名 / 地名 / 其他術語三組，各組前插跨欄 header。
// 組別依抽取 prompt 的 type（person / place / tech / work）分桶（glossaryGroupOf）
const GLOSSARY_GROUPS = ['person', 'place', 'other'];

// 欄位排序（2026-07-10）：點「原文 / 譯文」header 切換排序欄，再點反向。
// 排序在各分組內進行，分組結構不變
let glossarySortKey = 'source';
let glossarySortDir = 1;

function glossaryComparator(a, b) {
  const av = ((glossarySortKey === 'target' ? a.target : a.source) || '').toLowerCase();
  const bv = ((glossarySortKey === 'target' ? b.target : b.source) || '').toLowerCase();
  return av.localeCompare(bv) * glossarySortDir;
}

function refreshGlossarySortArrows() {
  for (const [id, key] of [['g-sort-source', 'source'], ['g-sort-target', 'target']]) {
    const arrow = $(id)?.querySelector('.g-sort-arrow');
    if (arrow) arrow.textContent = (glossarySortKey === key) ? (glossarySortDir === 1 ? '▲' : '▼') : '';
  }
}

function appendGlossaryGroupHeader(group, count) {
  const div = document.createElement('div');
  div.className = 'glossary-group-header';
  div.dataset.group = group;
  const label = document.createElement('span');
  label.textContent = `${t('doc.glossary.group.' + group)}（${count}）`;
  div.appendChild(label);
  // 「人名不翻譯」toggle 放在人名 group header 旁（2026-07-10 Jimmy 指定位置）
  if (group === 'person') {
    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'g-opt glossary-person-toggle';
    toggleLabel.title = t('doc.glossary.personNoTranslate.title');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'glossary-person-notrans';
    cb.addEventListener('change', onPersonNoTransToggle);
    toggleLabel.append(cb, document.createTextNode(t('doc.glossary.personNoTranslate')));
    div.appendChild(toggleLabel);
  }
  $('glossary-grid').appendChild(div);
}

// 「人名不翻譯」批次 toggle：一鍵把人名組所有列的不翻譯 checkbox 設成同一狀態
function onPersonNoTransToggle(e) {
  const on = e.target.checked;
  for (const src of $('glossary-grid').querySelectorAll('.g-source[data-gtype="person"]')) {
    const cb = src.nextElementSibling?.nextElementSibling?.querySelector('.g-notranslate');
    if (cb && cb.checked !== on) {
      cb.checked = on;
      cb.dispatchEvent(new Event('change'));
    }
  }
}

function buildGlossaryTable(entries) {
  refreshGlossarySortArrows();
  clearGlossaryEntries();
  if (!entries || entries.length === 0) {
    setGlossaryState(t('doc.glossary.state.empty'), 'is-empty');
    syncPersonNoTransToggle();
    return;
  }
  const buckets = { person: [], place: [], other: [] };
  for (const e of entries) buckets[glossaryGroupOf(e)].push(e);
  for (const group of GLOSSARY_GROUPS) {
    const list = buckets[group];
    if (list.length === 0) continue;
    // 組內排序：依目前排序欄與方向（預設原文升冪；大小寫不敏感）
    list.sort(glossaryComparator);
    appendGlossaryGroupHeader(group, list.length);
    for (const e of list) appendGlossaryRow(e, { skipUpdateCount: true, group });
  }
  updateGlossaryCount();
  syncPersonNoTransToggle();
}

// 「人名不翻譯」總 toggle 的顯示狀態：人名組全數 noTranslate 才打勾
function syncPersonNoTransToggle() {
  const cb = $('glossary-person-notrans');
  if (!cb) return;
  const personSources = [...$('glossary-grid').querySelectorAll('.g-source[data-gtype="person"]')];
  cb.checked = personSources.length > 0 && personSources.every((src) => {
    const opts = src.nextElementSibling?.nextElementSibling;
    return opts?.querySelector('.g-notranslate')?.checked === true;
  });
}

// 「譯文（原文）」對照式譯名的偵測（全形括號收尾）——只有這類 entry 顯示
// 「對照只出現一次」toggle（v2.0.11）
const ANNOTATED_TARGET_RE = /^(.+)（(.+)）\s*$/;
// 作品名書名號整包偵測（2026-07-12,對照順序翻轉時《》跟著 lead token 走）
const TITLE_WRAP_RE = /^《(.+)》$/;

function appendGlossaryRow(entry = { source: '', target: '' }, { skipUpdateCount = false, group = null } = {}) {
  const grid = $('glossary-grid');
  // 第一次加入 entry 時可能還在 placeholder state,先清掉
  const placeholder = grid.querySelector('.glossary-state');
  if (placeholder) placeholder.remove();

  const sourceInput = document.createElement('input');
  sourceInput.type = 'text';
  sourceInput.className = 'g-source';
  sourceInput.placeholder = t('doc.glossary.placeholder.source');
  sourceInput.value = entry.source || '';
  // 分組資訊記在 row 上：readGlossaryTable 回寫 type、「人名不翻譯」批次 toggle 靠它選人名列
  sourceInput.dataset.gtype = group || glossaryGroupOf(entry);
  if (typeof entry.type === 'string' && entry.type) sourceInput.dataset.rawtype = entry.type;

  const targetInput = document.createElement('input');
  targetInput.type = 'text';
  targetInput.className = 'g-target';
  targetInput.placeholder = t('doc.glossary.placeholder.target');
  targetInput.value = entry.target || '';

  // ── 選項 cell（v2.0.11）：不翻譯 toggle ＋「譯文（原文）」對照一次 toggle ──
  const optionsDiv = document.createElement('div');
  optionsDiv.className = 'g-options';

  const noTransLabel = document.createElement('label');
  noTransLabel.className = 'g-opt';
  const noTransCb = document.createElement('input');
  noTransCb.type = 'checkbox';
  noTransCb.className = 'g-notranslate';
  noTransCb.checked = entry.noTranslate === true;
  noTransLabel.append(noTransCb, document.createTextNode(t('doc.glossary.opt.noTranslate')));
  noTransLabel.title = t('doc.glossary.opt.noTranslate.title');

  const dedupeLabel = document.createElement('label');
  dedupeLabel.className = 'g-opt g-dedupe-wrap';
  const dedupeCb = document.createElement('input');
  dedupeCb.type = 'checkbox';
  dedupeCb.className = 'g-dedupe';
  dedupeCb.checked = entry.dedupeAnnotation === true;
  dedupeLabel.append(dedupeCb, document.createTextNode(t('doc.glossary.opt.dedupe')));
  dedupeLabel.title = t('doc.glossary.opt.dedupe.title');

  const keepSelect = document.createElement('select');
  keepSelect.className = 'g-dedupe-keep';
  const optSource = document.createElement('option');
  optSource.value = 'source';
  optSource.textContent = t('doc.glossary.opt.keepSource');
  const optTarget = document.createElement('option');
  optTarget.value = 'target';
  optTarget.textContent = t('doc.glossary.opt.keepTarget');
  keepSelect.append(optSource, optTarget);
  // 預設「後續用原文」（2026-07-10 Jimmy 指定）
  keepSelect.value = entry.dedupeKeep === 'target' ? 'target' : 'source';

  optionsDiv.append(noTransLabel, dedupeLabel, keepSelect);

  // 選項顯示邏輯：不翻譯 → 譯文欄 disabled、對照類選項隱藏；
  // 對照 toggle 只在譯文長相是「譯文（原文）」時出現；勾了才顯示後續用哪個的 select
  const refreshOptionVisibility = () => {
    const noTrans = noTransCb.checked;
    targetInput.disabled = noTrans;
    const isAnnotated = !noTrans && ANNOTATED_TARGET_RE.test(targetInput.value.trim());
    dedupeLabel.hidden = !isAnnotated;
    keepSelect.hidden = !(isAnnotated && dedupeCb.checked);
  };
  refreshOptionVisibility();

  // v2.0.54:譯文欄順序 = 「首次出現的長相」invariant。「對照一次」勾選且「後續用原文」
  // 時自動翻轉成「原文（譯文）」,讓首次對照的 lead token 跟後續出現的原文一致;
  // 「後續用譯文」或取消勾選則回「譯文（原文）」慣例順序。只在欄位是「A（B）」且
  // 其中一個 token 等於原文欄時翻轉,不覆蓋使用者自訂格式;下游 computeAnnotationDedupe
  // 以 source 比對決定 token 角色,兩種順序都吃(epub-writer.js)。
  // 書名號跟著 lead token 走（2026-07-12 Jimmy 回報:翻轉把《妳是我今生的新娘》整包
  // 塞進括號變「Four Weddings（《妳是我今生的新娘》）」）:任一 token 有《》時
  // 視為作品名 entry,翻轉後《》包 lead、括號內不帶——「《Four Weddings》（妳是我
  // 今生的新娘）」;比對 source 時同樣先剝《》再比
  const syncAnnotatedTargetOrder = () => {
    const m = targetInput.value.trim().match(ANNOTATED_TARGET_RE);
    if (!m) return;
    const src = sourceInput.value.trim();
    if (!src) return;
    const stripTitle = (s) => (s.match(TITLE_WRAP_RE)?.[1].trim() ?? s);
    const tok1 = m[1].trim();
    const tok2 = m[2].trim();
    const srcBare = stripTitle(src);
    let sourceTok = null;
    let targetTok = null;
    if (stripTitle(tok1) === srcBare) { sourceTok = stripTitle(tok1); targetTok = stripTitle(tok2); }
    else if (stripTitle(tok2) === srcBare) { sourceTok = stripTitle(tok2); targetTok = stripTitle(tok1); }
    else return;
    const hadTitleMarks = TITLE_WRAP_RE.test(tok1) || TITLE_WRAP_RE.test(tok2);
    const wrap = (s) => (hadTitleMarks ? `《${s}》` : s);
    const sourceFirst = dedupeCb.checked && keepSelect.value === 'source';
    const next = sourceFirst ? `${wrap(sourceTok)}（${targetTok}）` : `${wrap(targetTok)}（${sourceTok}）`;
    if (next !== targetInput.value.trim()) {
      targetInput.value = next;
      refreshOptionVisibility();
    }
  };

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'glossary-row-delete';
  delBtn.textContent = t('doc.glossary.btn.delete');

  // 四個元素為一組 entry,delete 時一起拔
  delBtn.addEventListener('click', () => {
    sourceInput.remove();
    targetInput.remove();
    optionsDiv.remove();
    delBtn.remove();
    // 若清空到沒任何 entry,顯示 empty state
    if (!grid.querySelector('.g-source')) setGlossaryState(t('doc.glossary.state.empty'), 'is-empty');
    else updateGlossaryCount();
  });
  sourceInput.addEventListener('input', updateGlossaryCount);
  targetInput.addEventListener('input', () => { refreshOptionVisibility(); updateGlossaryCount(); });
  noTransCb.addEventListener('change', () => { refreshOptionVisibility(); syncPersonNoTransToggle(); });
  dedupeCb.addEventListener('change', () => { refreshOptionVisibility(); syncAnnotatedTargetOrder(); });
  keepSelect.addEventListener('change', syncAnnotatedTargetOrder);

  grid.append(sourceInput, targetInput, optionsDiv, delBtn);
  if (!skipUpdateCount) updateGlossaryCount();
}

function readGlossaryTable() {
  const out = [];
  // 每個 entry 在 grid 內是連續四 cell:source / target / options / delete-btn。
  // 走 .g-source 即可，nextElementSibling 依序是 .g-target 與 .g-options
  for (const sourceInput of $('glossary-grid').querySelectorAll('.g-source')) {
    const source = sourceInput.value.trim();
    const targetInput = sourceInput.nextElementSibling;
    const target = (targetInput && targetInput.classList.contains('g-target'))
      ? targetInput.value.trim() : '';
    const optionsDiv = targetInput ? targetInput.nextElementSibling : null;
    const hasOptions = !!(optionsDiv && optionsDiv.classList.contains('g-options'));
    const noTranslate = hasOptions && optionsDiv.querySelector('.g-notranslate')?.checked === true;
    // source 必填；target 唯一可空的情境是「不翻譯」——該狀態下譯文欄 disabled，
    // 使用者填不了，要求非空會讓手動新增的不翻譯列在儲存時默默消失。
    // 空 target 以 source 補（語意 = 原文照用，同 injectableArticleGlossary 映射）
    if (!source || (!target && !noTranslate)) continue;
    // 人名間隔號正規化（手動輸入 / 編輯的條目也吃同一規則）
    const entry = { source, target: normalizeNameSeparators(target || source) };
    // 分類保留（分組顯示 / 人名批次 toggle / 持久化都要）
    const rawType = sourceInput.dataset.rawtype
      || (sourceInput.dataset.gtype && sourceInput.dataset.gtype !== 'other' ? sourceInput.dataset.gtype : '');
    if (rawType) entry.type = rawType;
    if (hasOptions) {
      if (noTranslate) entry.noTranslate = true;
      const dedupeCb = optionsDiv.querySelector('.g-dedupe');
      if (!entry.noTranslate && dedupeCb?.checked && ANNOTATED_TARGET_RE.test(target)) {
        entry.dedupeAnnotation = true;
        entry.dedupeKeep = optionsDiv.querySelector('.g-dedupe-keep')?.value === 'target'
          ? 'target' : 'source';
      }
    }
    out.push(entry);
  }
  return out;
}

// 注入用術語表（v2.0.11）：把「不翻譯此名詞」entry 映射成 `原文 → 原文`
//（LLM 拿到同值對照 = 指示保留原文），其餘 flag 不進 systemInstruction。
// dedupe 類 flag 不影響注入——那是下載 / 預覽時的後處理（epub-writer）。
function injectableArticleGlossary() {
  if (!Array.isArray(currentArticleGlossary) || currentArticleGlossary.length === 0) return null;
  // target 過人名間隔號正規化——涵蓋舊 session 載回、還沒重新儲存的條目
  return currentArticleGlossary.map((e) => (
    e.noTranslate
      ? { source: e.source, target: e.source }
      : { source: e.source, target: normalizeNameSeparators(e.target) }
  ));
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
  const baseName = (currentDoc?.meta?.filename || 'glossary').replace(/\.(pdf|epub)$/i, '');
  a.download = `${baseName}-glossary.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}

// 匯入模式三選 dialog（現有表非空時）：resolve 'merge' / 'overwrite' / null（取消）。
// 用 onclick / oncancel 直接賦值（非 addEventListener）——同一輪 session 多次匯入
// 不會堆疊 listener
function askGlossaryImportMode(existingCount, newCount) {
  return new Promise((resolve) => {
    const dlg = $('glossary-import-dialog');
    $('glossary-import-desc').textContent = t('doc.glossary.import.desc', { existing: existingCount, new: newCount });
    const done = (mode) => { dlg.close(); resolve(mode); };
    $('glossary-import-merge-btn').onclick = () => done('merge');
    $('glossary-import-overwrite-btn').onclick = () => done('overwrite');
    $('glossary-import-cancel-btn').onclick = () => done(null);
    dlg.oncancel = () => resolve(null); // Esc 關閉
    dlg.showModal();
  });
}

async function handleGlossaryFileImport(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error(t('doc.glossary.alert.invalidJson'));
    const valid = data
      .filter((e) => e && typeof e.source === 'string' && typeof e.target === 'string')
      .map((e) => {
        // v2.0.11：保留選項 flag（不翻譯 / 對照一次）與分類 type（person / place
        // 分組顯示、人名批次 toggle 都靠它，丟掉會讓匯入後全部掉進「其他」組）；
        // 舊版 JSON 帶的 note 欄忽略
        const entry = { source: e.source, target: e.target };
        if (typeof e.type === 'string' && e.type.trim()) entry.type = e.type.trim().slice(0, 32);
        if (e.noTranslate === true) entry.noTranslate = true;
        if (e.dedupeAnnotation === true) {
          entry.dedupeAnnotation = true;
          entry.dedupeKeep = e.dedupeKeep === 'target' ? 'target' : 'source';
        }
        return entry;
      });
    if (valid.length === 0) throw new Error(t('doc.glossary.alert.noEntries'));
    const existing = readGlossaryTable();
    let next = valid;
    let mergeInfo = null;
    if (existing.length > 0) {
      const mode = await askGlossaryImportMode(existing.length, valid.length);
      if (!mode) return;
      // 合併：匯入輪在前 = 原文相同（大小寫不敏感）時匯入譯名優先，現有表獨有
      // 條目附在後——系列作續集沿用前作譯名、本集新角色保留新抽取的主路徑。
      // mergeBookGlossaries 保留 type 與選項 flag（勝出條目的為準）
      if (mode === 'merge') {
        mergeInfo = mergeBookGlossaries([valid, existing]);
        next = mergeInfo.entries;
      }
    }
    buildGlossaryTable(next);
    // 合併結果告知（2026-07-10）：衝突數（原文相同、譯名不同 → 匯入為準）要讓
    // 使用者知道；超過上限被捨棄的條目更不可靜默丟
    if (mergeInfo) {
      let msg = t('doc.glossary.import.mergeResult', { n: mergeInfo.entries.length, conflicts: mergeInfo.conflicts });
      if (mergeInfo.dropped > 0) {
        msg += '\n' + t('doc.glossary.import.mergeDropped', { cap: BOOK_GLOSSARY_MAX_TERMS, dropped: mergeInfo.dropped });
      }
      alert(msg);
    }
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
    // 「重新抽取」語意 = 強制重跑（forceRefresh 繞過 gloss_ 快取讀取，
    // 否則同文字同 hash 秒回快取，按了形同沒按——2026-07-10 Jimmy 回報）
    const extracted = currentDoc.kind === 'epub'
      ? await extractGlossaryForBook(currentDoc, { forceRefresh: true })
      : await extractGlossaryForDoc(currentDoc, { forceRefresh: true });
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
  // v2.0.11：清空術語表（confirm 後清 UI + module state；EPUB 同步清持久化，
  // 避免重開同書又載回舊表）
  $('glossary-clear-btn').addEventListener('click', async () => {
    const existing = readGlossaryTable();
    if (existing.length > 0 && !confirm(t('doc.glossary.confirm.clear', { n: existing.length }))) return;
    currentArticleGlossary = [];
    buildGlossaryTable([]);
    if (currentDoc?.kind === 'epub') await savePersistedBookGlossary([]);
  });
  $('glossary-cancel-btn').addEventListener('click', () => {
    // 回到打開 editor 的來源 stage(result / edit / reader / chapters)
    if (glossaryEntryStage === 'chapters' && currentDoc?.kind === 'epub') showStage('chapters');
    else if (glossaryEntryStage === 'edit' && currentReaderHandle) showStage('edit');
    else if (glossaryEntryStage === 'reader' && currentReaderHandle) showStage('reader');
    else showStage('result');
  });
  $('glossary-translate-btn').addEventListener('click', async () => {
    currentArticleGlossary = readGlossaryTable();
    // EPUB：按鈕語意是「儲存」（2026-07-10）——存術語表 + 本書禁用詞（session
    // 持久化，跨次載檔還原），回章節清單；開始翻譯集中在主流程「翻譯勾選章節」
    if (currentDoc?.kind === 'epub') {
      currentBookForbidden = readBookForbiddenTable();
      await savePersistedBookGlossary(currentArticleGlossary);
      await renderChapterList();
      showStage('chapters');
      return;
    }
    // PDF 維持原行為（用此術語表翻譯）。從 result 第一次翻譯不需要 confirm；
    // 從 edit / reader 進來都是「已翻過要重翻」要警告
    if (glossaryEntryStage === 'edit') {
      if (!confirm(t('doc.glossary.confirm.translateUnsaved'))) return;
    } else if (currentReaderHandle) {
      if (!confirm(t('doc.glossary.confirm.translate'))) return;
    }
    await startTranslate();
  });
  // 欄位排序 header（2026-07-10）：同欄再點 = 反向；換欄 = 升冪起手。
  // 用 readGlossaryTable 重排（保留使用者未儲存的輸入；source/target 未填全的
  // 半成品列會被過濾，行為同儲存）
  const onSortHeaderClick = (key) => {
    if (glossarySortKey === key) glossarySortDir = -glossarySortDir;
    else { glossarySortKey = key; glossarySortDir = 1; }
    buildGlossaryTable(readGlossaryTable());
  };
  $('g-sort-source').addEventListener('click', () => onSortHeaderClick('source'));
  $('g-sort-target').addEventListener('click', () => onSortHeaderClick('target'));
  // 本書禁用詞（EPUB）
  $('book-forbidden-add-btn').addEventListener('click', () => appendBookForbiddenRow());
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

// ============================================================================
// EPUB 翻譯（v2.0.11，SPEC-PRIVATE §30）
// ============================================================================
//
// 流程：上傳 → parseEpub → 章節清單（選翻 + 每章預估費用） → [全書術語表] →
//       翻譯勾選章節 → 回章節清單 review（預覽 / 續翻 / 下載譯本 EPUB)
//
// 譯名一致性設計（§30.3)：術語表抽取覆蓋全書（逐章分輪）、翻譯前鎖定、
// 每批只注入該批出現的條目（translate.js filterGlossary）、以書指紋持久化。

function showChaptersError(msg) {
  const el = $('chapters-error');
  el.textContent = msg;
  el.hidden = false;
}

function clearChaptersError() {
  const el = $('chapters-error');
  el.textContent = '';
  el.hidden = true;
}

async function handleEpubFile(file) {
  const pre = preflightEpubFile(file);
  if (pre.level === 'error') {
    showError(t('doc.epub.error.' + pre.code));
    return;
  }

  releaseCurrentDoc();

  if (parseAbortController) parseAbortController.abort();
  const myGen = ++parseGeneration;
  parseAbortController = new AbortController();
  const parseSignal = parseAbortController.signal;

  showStage('parsing');
  setParsingDetail(t('doc.epub.parsing.unzip'));

  try {
    const doc = await parseEpub(file, (p) => {
      if (myGen !== parseGeneration) return;
      if (p.stage === 'chapters') {
        setParsingDetail(t('doc.epub.parsing.chapters', { current: p.current, total: p.total }));
      }
    }, { signal: parseSignal });
    if (myGen !== parseGeneration) return;

    currentDoc = doc;
    window.__skEpubDoc = doc; // dev probe

    // 書指紋：全書 plainText 內容 hash(bookgloss_ 持久化 key)
    epubBookHash = await sha1(
      doc.chapters.map((c) => c.blocks.map((b) => b.plainText).join('\n')).join('\n'));
    if (myGen !== parseGeneration) return;

    // 工作階段還原（2026-07-10）：同書重開載回翻譯進度 + 術語表 + 本書禁用詞。
    // 存檔在頁面自己的 IndexedDB，不受「清除翻譯快取」影響
    const session = await loadEpubSession(epubBookHash);
    if (myGen !== parseGeneration) return;
    if (session) {
      const restored = hydrateSessionBlocks(doc, session.blocks);
      // 空陣列也要接受——「清空過」（[]）跟「沒建過」（null）是不同狀態；
      // 只接受非空會讓清空後重開掉進 legacy fallback 撈回舊術語表
      //（2026-07-10 Jimmy 回報 bug）
      if (Array.isArray(session.glossary)) {
        currentArticleGlossary = session.glossary;
      }
      if (Array.isArray(session.forbidden)) currentBookForbidden = session.forbidden;
      if (typeof session.extraPrompt === 'string') currentDocExtraPrompt = session.extraPrompt;
      if (Number.isFinite(session.costUSD)) epubCumulativeCostUSD = session.costUSD;
      if (Array.isArray(session.scanIgnored)) epubScanIgnored = hydrateScanIgnored(session.scanIgnored);
      if (Array.isArray(session.scanIgnoredDrift)) epubScanIgnoredDrift = new Set(session.scanIgnoredDrift.filter((x) => typeof x === 'string'));
      if (restored > 0) {
        // 還原的完成章節預設不勾（續翻節奏）
        for (const c of doc.chapters) {
          if (chapterDoneState(c) === 'done') c.selected = false;
        }
      }
      console.log('[Shinkansen] epub session restored:', {
        blocks: restored,
        glossary: (currentArticleGlossary || []).length,
        forbidden: currentBookForbidden.length,
      });
    }
    // 舊版 bookgloss_（chrome.storage.local）讀取 fallback：只在「完全沒有
    // session 紀錄」時才走——有 session 就以 session 為準（即使 glossary 是空），
    // 否則清空過的術語表會被 legacy key 復活
    if (!session && currentArticleGlossary === null) {
      const persisted = await loadPersistedBookGlossary();
      if (myGen !== parseGeneration) return;
      if (Array.isArray(persisted) && persisted.length > 0) {
        currentArticleGlossary = persisted;
        console.log('[Shinkansen] legacy book glossary restored:', persisted.length, 'terms');
      }
    }

    await renderChapterList();
    if (myGen !== parseGeneration) return;
    showStage('chapters');
  } catch (err) {
    if (myGen !== parseGeneration || (err && err.code === 'aborted')) return;
    console.error('[Shinkansen] parseEpub 失敗', err);
    if (err && err.name === 'EpubParseError') {
      showError(t('doc.epub.error.' + err.code));
    } else {
      showError(t('doc.epub.error.bad-zip'));
    }
  } finally {
    if (myGen === parseGeneration) parseAbortController = null;
  }
}

// 章節翻譯狀態聚合（從段落 translationStatus 推）
function chapterDoneState(ch) {
  if (ch.parseFailed) return 'unparsed';
  if (ch.blocks.length === 0) return 'empty';
  let done = 0, failed = 0;
  for (const b of ch.blocks) {
    if (b.translationStatus === 'done') done++;
    else if (b.translationStatus === 'failed') failed++;
  }
  if (done === ch.blocks.length) return 'done';
  if (failed > 0) return 'failed';
  if (done > 0) return 'partial';
  return 'none';
}

function epubHasAnyTranslation() {
  return !!(currentDoc && currentDoc.kind === 'epub'
    && currentDoc.chapters.some((c) => c.blocks.some((b) => b.translationStatus === 'done')));
}

function formatUsdApprox(usd) {
  if (usd == null || !Number.isFinite(usd)) return '—';
  return '≈ $' + (usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2));
}

async function renderChapterList() {
  const doc = currentDoc;
  if (!doc || doc.kind !== 'epub') return;

  $('chapters-book-title').textContent = doc.meta.title;
  $('chapters-author').textContent = doc.meta.author || '—';
  $('chapters-epub-version').textContent = doc.meta.epubVersion
    ? `EPUB ${doc.meta.epubVersion}` : '—';
  $('chapters-count').textContent = String(doc.meta.chapterCount);
  $('chapters-chars').textContent = doc.stats.totalChars.toLocaleString('en-US');

  const { modelOverride } = await resolvePreset();
  const settings = await getSettings();
  const estModel = modelOverride || settings.geminiConfig?.model || '';

  const list = $('chapters-list');
  list.replaceChildren();
  for (const ch of doc.chapters) {
    const row = document.createElement('div');
    row.className = 'chapter-row';
    const state = chapterDoneState(ch);
    const disabled = state === 'unparsed' || state === 'empty';

    const label = document.createElement('label');
    label.className = 'chapter-label';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = ch.selected && !disabled;
    cb.disabled = disabled;
    cb.addEventListener('change', () => {
      ch.selected = cb.checked;
      updateChapterSummaryLine(estModel, settings);
    });
    const titleSpan = document.createElement('span');
    titleSpan.className = 'chapter-title' + (ch.suggestSkip ? ' is-matter' : '');
    titleSpan.textContent = `${ch.index + 1}. ${ch.title}`;
    label.append(cb, titleSpan);

    const charsSpan = document.createElement('span');
    charsSpan.className = 'chapter-chars';
    charsSpan.textContent = ch.charCount > 0 ? ch.charCount.toLocaleString('en-US') : '—';

    const costSpan = document.createElement('span');
    costSpan.className = 'chapter-cost';
    costSpan.textContent = ch.charCount > 0
      ? formatUsdApprox(estimateChapterCostUSD(ch.charCount, estModel, settings))
      : '';

    const statusSpan = document.createElement('span');
    statusSpan.className = 'chapter-status';
    statusSpan.dataset.state = state;
    statusSpan.textContent = t('doc.epub.status.' + state);

    row.append(label, charsSpan, costSpan, statusSpan);

    if (state === 'done' || state === 'partial' || state === 'failed') {
      const previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.className = 'chapter-preview-btn';
      previewBtn.textContent = t('doc.epub.btn.preview');
      previewBtn.addEventListener('click', () => openEpubPreview(ch));
      row.appendChild(previewBtn);
    }
    list.appendChild(row);
  }

  updateChapterSummaryLine(estModel, settings);

  $('chapters-download-btn').hidden = !epubHasAnyTranslation();
  $('chapters-preview-all-btn').hidden = !epubHasAnyTranslation();
  // 術語表按鈕動態標籤（2026-07-10）：沒建過 = 先建立、已有 = 編輯
  const glossBtn = $('chapters-glossary-btn');
  const glossKey = (Array.isArray(currentArticleGlossary) && currentArticleGlossary.length > 0)
    ? 'doc.epub.btn.glossaryEdit' : 'doc.epub.btn.glossary';
  glossBtn.setAttribute('data-i18n', glossKey);
  glossBtn.textContent = t(glossKey);
  // 放棄本書翻譯 / 匯出工作階段：有任何翻譯進度才顯示；匯入隨時可用
  $('chapters-discard-btn').hidden = !epubHasAnyTranslation();
  $('chapters-export-session-btn').hidden = !epubHasAnyTranslation();
  // EPUB2 來源才顯示「輸出格式」選擇（EPUB3 來源兩個選項等價，不放干擾項）
  const isEpub2 = /^2(\.|$)/.test(doc.meta.epubVersion || '');
  $('epub-output-format-wrap').hidden = !(isEpub2 && epubHasAnyTranslation());
  // 譯本內容（單語 / 雙語對照）：有任何翻譯（= 下載按鈕出現）才顯示
  $('epub-dual-wrap').hidden = !epubHasAnyTranslation();
  const cumRow = $('chapters-cumulative-row');
  if (epubCumulativeCostUSD > 0) {
    cumRow.hidden = false;
    $('chapters-cumulative-cost').textContent = await formatCostStr(epubCumulativeCostUSD);
  } else {
    cumRow.hidden = true;
  }
  // 一致性掃描入口與章節清單同步刷新（換書 / 放棄後不留殘影）
  renderScanBanner();
}

function selectedEpubChapters() {
  if (!currentDoc || currentDoc.kind !== 'epub') return [];
  return currentDoc.chapters.filter((c) => c.selected && !c.parseFailed && c.blocks.length > 0);
}

function updateChapterSummaryLine(estModel, settings) {
  const sel = selectedEpubChapters();
  const chars = sel.reduce((acc, c) => acc + c.charCount, 0);
  const cost = estimateChapterCostUSD(chars, estModel, settings);
  $('chapters-selected-summary').textContent = t('doc.epub.selectedSummary', {
    chapters: sel.length,
    chars: chars.toLocaleString('en-US'),
    cost: formatUsdApprox(cost),
  });
}

async function startEpubTranslate() {
  const doc = currentDoc;
  const selected = selectedEpubChapters();
  if (selected.length === 0) {
    showChaptersError(t('doc.epub.error.none-selected'));
    showStage('chapters');
    return;
  }

  const { engine, modelOverride } = await resolvePreset();
  if (engine === 'google') {
    showChaptersError(t('doc.error.googleNotSupportedInDoc'));
    showStage('chapters');
    return;
  }
  clearChaptersError();

  // 軟警告（§30.5)：已選字數超過門檻要使用者確認
  const selChars = selected.reduce((acc, c) => acc + c.charCount, 0);
  if (selChars > EPUB_LIMITS.softWarnChars) {
    const settings = await getSettings();
    const est = estimateChapterCostUSD(selChars, modelOverride || settings.geminiConfig?.model || '', settings);
    if (!confirm(t('doc.epub.confirm.softWarn', {
      chars: selChars.toLocaleString('en-US'),
      cost: formatUsdApprox(est),
    }))) return;
  }

  // 已翻章節被重勾 → 明確警告會以當前術語表 / 設定重翻並重新計費。
  // 確認後清掉這些段落的翻譯快取——否則設定沒變時逐塊 cache hit，看起來
  // 「沒有真的重翻」（2026-07-10 Jimmy 回報 bug）。正常續翻 / 中斷恢復
  // 不走這條（done 章節預設已取消勾選），快取仍然有效
  const hasDone = selected.some((c) => c.blocks.some((b) => b.translationStatus === 'done'));
  if (hasDone) {
    if (!confirm(t('doc.epub.confirm.retranslate'))) return;
    await clearEpubBlocksCache(selected);
  }

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

  // v2.0.11：經 injectableArticleGlossary 映射（不翻譯 entry → 原文→原文）
  const glossary = injectableArticleGlossary();
  if (glossary) {
    console.log('[Shinkansen] using book glossary:', glossary.length, 'terms');
  }

  const selIdx = new Set(selected.map((c) => c.index));
  translateAbortController = new AbortController();
  let summary;
  try {
    summary = await translateDocument(doc, {
      modelOverride,
      engine,
      glossary,
      signal: translateAbortController.signal,
      onProgress: setProgress,
      // 章節選翻：只翻勾選章節。勾選章節內全部重跑（重勾已翻章節時由上方 confirm
      // 把關；設定沒變時逐塊 cache hit，不重新計費）
      blockFilter: (block, page) => selIdx.has(page.chapterIndex),
      // 全書術語表批次級過濾注入（§30.3 第 4 層）
      filterGlossary: true,
      // 本書獨立禁用詞（2026-07-10）：background 與 options 共通清單合併，
      // _b hash 由合併後清單計算 → 書級清單變更快取自動失效
      extraForbiddenTerms: currentBookForbidden.length > 0 ? currentBookForbidden : null,
      batchSize: await resolveDocBatchSize(),
      extraPrompt: currentDocExtraPrompt || null,
    });
  } catch (err) {
    console.error('[Shinkansen] translateDocument(epub) 失敗', err);
    summary = {
      totalBlocks: 0,
      translatedBlocks: 0,
      failedBlocks: 0,
      cumulativeInputTokens: 0,
      cumulativeBilledInputTokens: 0,
      cumulativeOutputTokens: 0,
      cumulativeCostUSD: 0,
      cancelled: false,
      error: (err && err.message) || String(err),
    };
  }
  translateAbortController = null;
  lastTranslateSummary = summary;
  epubCumulativeCostUSD += summary.cumulativeCostUSD || 0;

  // 續翻節奏：整章完成的自動取消勾選，下一輪預設只剩未翻章節
  for (const c of selected) {
    if (chapterDoneState(c) === 'done') c.selected = false;
  }

  // 工作階段存檔：翻譯成果落地 IndexedDB（離開頁面後可續翻，2026-07-10）。
  // 必須在 showStage 之前 await——使用者看到章節清單即代表進度已落地，
  // 立刻關頁也不掉進度
  await persistEpubSession();

  await renderChapterList();
  if (summary.error) showChaptersError(summary.error);
  showStage('chapters');

  // 譯後一致性掃描（v2.0.11）：option 預設開啟，翻譯回到章節清單後於背景執行，
  // 不擋 UI；發現問題時章節頁出現入口按鈕
  maybeRunConsistencyScan(doc);
}

// 重勾已翻章節的「真重翻」快取清除：以段落實際送翻文字（epubSerializedText，
// background 以它算 cache key）的 sha1 為 prefix，掃掉所有 suffix 變體
//（同 clearCurrentDocCache 的 prefix 思路）
async function clearEpubBlocksCache(chapters, { all = false } = {}) {
  const texts = [];
  for (const ch of chapters) {
    for (const b of ch.blocks) {
      if (!all && b.translationStatus !== 'done') continue;
      const text = b.epubSerializedText || b.plainText;
      if (text) texts.push(text);
    }
  }
  // v2.0.52:prefix 掃描核心下沉到 translate.js clearTcCacheForTexts
  //(語言驗證重試共用同一條,不留雙實作)
  const removed = await clearTcCacheForTexts(texts);
  console.log('[Shinkansen] retranslate cache cleared:', removed, 'keys');
  return removed;
}

async function downloadTranslatedEpub() {
  if (!epubHasAnyTranslation()) return;
  const btn = $('chapters-download-btn');
  btn.disabled = true;
  try {
    // 下載前自動修正中英空格（與預覽開啟同一條 autoFixCjkSpacing，
    // 沒開過預覽直接下載也吃得到）
    await autoFixCjkSpacing(currentDoc);
    const settings = await getSettings();
    // EPUB2 來源可選升級輸出 EPUB3（select 只在 EPUB2 來源時顯示，見 renderChapterList）
    const upgradeTo3 = !$('epub-output-format-wrap').hidden
      && $('epub-output-format').value === 'epub3';
    // 雙語對照輸出（writer 層下載時選項：譯文資料不變，已翻好的書切換模式
    // 重新下載零重翻費用）
    const bilingual = !$('epub-dual-wrap').hidden && $('epub-dual-mode').value === 'dual';
    const { bytes } = buildTranslatedEpub(currentDoc, settings.targetLanguage || 'zh-TW', {
      upgradeTo3,
      // 「對照只出現一次」後處理要吃原始 entries（含 dedupe flag)，不是注入用映射
      glossary: currentArticleGlossary,
      // 段落間距 toggle（2026-07-10）
      paragraphSpacing: settings.translateDoc?.epubParagraphSpacing === true,
      bilingual,
    });
    const blob = new Blob([bytes], { type: 'application/epub+zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = translatedEpubFilename(currentDoc.meta.filename, { bilingual });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
  } catch (err) {
    console.error('[Shinkansen] 譯本 EPUB 產出失敗', err);
    showChaptersError(t('doc.epub.error.build-failed', { error: (err && err.message) || String(err) }));
  } finally {
    btn.disabled = false;
  }
}

// 單章譯文預覽（試翻 review)：已翻段落顯示譯文，未翻 / 失敗段落顯示原文並降淡
// EPUB 預覽（v2.0.11，2026-07-10 擴充）：
//   - scope = 章節物件（單章）或 'all'（全書預覽）
//   - 已翻段落渲染反序列化富文本 + contenteditable 編輯（editedHtml 優先進譯本）
//   - 「顯示原文對照」toggle：每個已翻段落下方附原文（降淡、不可編輯）
//   - 「對照只出現一次」後處理與下載共用（computeAnnotationDedupe），所見即所得
//   - 編輯 / 搜尋取代都排進 session 存檔（scheduleEpubSessionSave）
async function openEpubPreview(scope) {
  epubPreviewScope = scope;
  // 中英空格自動修正後再渲染，結果直接反映在預覽（2026-07-11 Jimmy 指示：
  // 由按鈕改為預覽 / 下載時機自動執行）
  const fixed = await autoFixCjkSpacing(currentDoc);
  renderEpubPreview();
  showStage('epubPreview');
  if (fixed.hits > 0) {
    $('epub-sr-status').textContent = t('doc.epub.sr.fixSpacingResult', { hits: fixed.hits, blocks: fixed.blocks });
  }
}

// 中英空格自動修正（2026-07-11）：LLM 輸出偶發漏掉 CJK↔拉丁邊界空格
//（「批評 F1是無謂」）。開啟章節 / 全書預覽與下載譯本 EPUB 時自動補齊全書
// 已翻段落；規則在 epub-scan.js addCjkLatinSpacing（與掃描替換同組邊界常數，
// 只補缺漏、冪等），只在中文 target 執行（補空格是中文排版慣例，en 等其他
// target 不適用，未來 ja / ko 也不補）。逐 block 離屏渲染（editedHtml 優先，
// 否則反序列化 translationRaw；cloneReuse 防 detach 活節點）→ 修正 text node
//（inline 標記保留、跨節點相鄰靠 prevChar context）→ 有改動才寫回 editedHtml
//（= 手動編輯語意，下載 / session 存檔都吃得到；dedupe 後處理對 edited block
// 照樣生效）
async function autoFixCjkSpacing(doc) {
  const none = { hits: 0, blocks: 0 };
  if (!doc || !Array.isArray(doc.chapters)) return none;
  try {
    const s = await getSettings();
    if (!String(s.targetLanguage || '').startsWith('zh')) return none;
    // 自動校正 toggle（2026-07-12，翻譯設定 modal）：預設開啟（缺值 = 開）
    if (s.translateDoc?.epubAutoFixSpacing === false) return none;
  } catch (_) {
    return none;
  }
  const SK = window.__SK;
  let blocks = 0;
  let hits = 0;
  for (const ch of doc.chapters) {
    for (const b of ch.blocks) {
      if (b.translationStatus !== 'done') continue;
      // 批次 8 G7:渲染統一走 renderBlockContent(無譯文 = 無可校正,跳過)
      const rendered = renderBlockContent(b, SK);
      if (!rendered) continue;
      const el = rendered.el;
      const nodes = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) nodes.push(node);
      let blockHits = 0;
      for (let i = 0; i < nodes.length; i++) {
        if (!nodes[i].nodeValue) continue;
        let prevChar = '';
        for (let j = i - 1; j >= 0 && !prevChar; j--) prevChar = (nodes[j].nodeValue || '').slice(-1);
        const r = addCjkLatinSpacing(nodes[i].nodeValue, { prevChar });
        if (r.count > 0) {
          nodes[i].nodeValue = r.text;
          blockHits += r.count;
        }
      }
      if (blockHits > 0) {
        blocks++;
        hits += blockHits;
        b.editedHtml = el.innerHTML;
        b.translation = el.textContent;
      }
    }
  }
  if (blocks > 0) scheduleEpubSessionSave();
  return { hits, blocks };
}

function renderEpubPreview() {
  const SK = window.__SK;
  const scope = epubPreviewScope;
  if (!scope || !currentDoc) return;
  const chapters = scope === 'all'
    ? currentDoc.chapters.filter((c) => c.blocks.length > 0)
    : [scope];
  $('epub-preview-title').textContent = scope === 'all'
    ? t('doc.epub.preview.allTitle')
    : `${scope.index + 1}. ${scope.title}`;
  $('epub-preview-compare').checked = epubPreviewCompare;
  $('epub-sr-status').textContent = '';
  const dedupe = computeAnnotationDedupe(currentDoc, currentArticleGlossary);
  const content = $('epub-preview-content');
  content.replaceChildren();
  for (const ch of chapters) {
    if (scope === 'all') {
      const h = document.createElement('h2');
      h.className = 'epub-preview-chapter-title';
      h.textContent = `${ch.index + 1}. ${ch.title}`;
      content.appendChild(h);
    }
    for (const b of ch.blocks) appendPreviewBlock(content, b, SK, dedupe);
  }
}

// 預覽編輯貼上一律降為純文字（2026-07-12 Jimmy 回報：從原文對照 copy 貼進
// 譯文段，瀏覽器 rich paste 帶著來源 inline style（font-family 等 span）進
// editedHtml → 預覽與譯本出現字體不一致的外來樣式；寫回消毒只剝 script /
// on*，不能剝 style——原書合法標記也可能帶 style，分不出來源）。
// 純文字插入 = 繼承游標處樣式，段落樣式主權留給書的 CSS；代價是「複製既有
// 斜體再貼」會失去 inline 標記（可接受，編輯場景以文字修正為主）
function onPreviewEditablePaste(e) {
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (!text) return;
  // execCommand 走瀏覽器原生插入（游標 / 選取範圍取代 / undo stack 都對）；
  // deprecated 但 Chromium / Safari 對 contenteditable 仍完整支援
  document.execCommand('insertText', false, text);
}

// 連結邊界補位（lib/edit-link-repair.js 共用模組）：刪掉 <a> 內的字後緊接著
// 打字，Chromium 會把新字插在連結外（邊界刻意設計）——事後把插入段搬回連結內。
// 與 content.js 網頁編輯譯文模式共用同一份實作。單一 instance 跨段落共用：
// pointerdown / 導航鍵會清 pending，跨段落誤搬不會發生
const previewLinkRepair = window.__SKEditLinkRepair.createEditLinkRepair({});

// 捲動錨點 = 視窗內第一個（部分）可見的預覽段落（sticky 工具列以下）。
// offset 記該段落頂相對 viewport 頂的距離，重繪後還原同視覺位置——
// 「大致回到原位」以段落為粒度，不追字元級精度
function findPreviewScrollAnchor() {
  const sticky = document.querySelector('#stage-epub-preview .epub-preview-sticky');
  const stickyBottom = sticky ? sticky.getBoundingClientRect().bottom : 0;
  for (const el of $('epub-preview-content').querySelectorAll('[data-sk-block-id]')) {
    const r = el.getBoundingClientRect();
    if (r.bottom > stickyBottom + 1) {
      return { blockId: el.dataset.skBlockId, offset: r.top };
    }
  }
  return null;
}

function restorePreviewScrollAnchor(anchor) {
  if (!anchor) return;
  let el = null;
  try {
    el = $('epub-preview-content').querySelector(`[data-sk-block-id="${CSS.escape(anchor.blockId)}"]`);
  } catch (_) { /* 無效 blockId 直接放棄還原 */ }
  if (!el) return;
  window.scrollBy(0, el.getBoundingClientRect().top - anchor.offset);
}

function appendPreviewBlock(content, b, SK, dedupe) {
  const el = document.createElement(b.type === 'heading' ? 'h3' : 'p');
  el.className = 'epub-preview-block';
  el.dataset.state = b.translationStatus || 'pending';
  el.dataset.skBlockId = b.blockId; // 捲動錨定查找用（含未翻段落）
  if (b.translationStatus === 'done') {
    // 批次 8 G7:渲染統一走 renderBlockContent + dedupe override(後處理視圖優先,
    // 2026-07-10 與下載共用所見即所得);is-edited 只標 editedHtml 分支
    const rendered = renderBlockContent(b, SK, dedupe.get(b.blockId) ?? null);
    if (rendered) {
      el.append(...rendered.el.childNodes);
      if (rendered.usedEdited) el.classList.add('is-edited');
    } else {
      el.textContent = '';
    }
    // 點擊編輯：blur 時存回 editedHtml（跟渲染時不同才存，避免只是點過就標記）
    el.contentEditable = 'true';
    el.spellcheck = false;
    el.__skBlock = b;
    el.addEventListener('paste', onPreviewEditablePaste);
    // 連結邊界補位：刪連結內文字後打字，把插入段補回連結內
    el.addEventListener('beforeinput', previewLinkRepair.onBeforeInput);
    el.addEventListener('input', previewLinkRepair.onInput);
    el.addEventListener('compositionend', previewLinkRepair.onCompositionEnd);
    el.addEventListener('pointerdown', previewLinkRepair.onPointerDown);
    el.addEventListener('keydown', previewLinkRepair.onKeyDown);
    const before = el.innerHTML;
    el.addEventListener('blur', () => {
      // v2.0.78（批次 5 G4）：早退不分 editedHtml 有無——原本 `&& !b.editedHtml` 讓
      // 「已編輯 block、內容零變動」的 blur 恆不早退：已編輯 block 渲染的是 dedupe
      // 後處理視圖（3499 行），點進去再點出去就把下載期後處理版本存成手動編輯資料
      // 永久烙進 editedHtml——之後取消 dedupe 勾選 / 改術語表都回不到未處理狀態，
      // computeAnnotationDedupe 的「首次出現」判定跟著位移
      if (el.innerHTML === before) return;
      b.editedHtml = el.innerHTML;
      b.translation = el.textContent;
      el.classList.add('is-edited');
      scheduleEpubSessionSave();
    });
    content.appendChild(el);
    // 原文對照：譯文段下方附原文（不進搜尋取代、不可編輯）
    if (epubPreviewCompare) {
      const orig = document.createElement('div');
      orig.className = 'epub-preview-original';
      orig.textContent = b.plainText;
      content.appendChild(orig);
    }
    return;
  }
  el.textContent = b.plainText;
  content.appendChild(el);
}

function bindChaptersUI() {
  if (!stages.chapters) return;
  $('chapters-select-all-btn').addEventListener('click', () => {
    for (const c of currentDoc?.chapters || []) {
      if (!c.parseFailed && c.blocks.length > 0) c.selected = true;
    }
    renderChapterList();
  });
  $('chapters-select-none-btn').addEventListener('click', () => {
    for (const c of currentDoc?.chapters || []) c.selected = false;
    renderChapterList();
  });
  $('chapters-exclude-matter-btn').addEventListener('click', () => {
    for (const c of currentDoc?.chapters || []) {
      if (c.suggestSkip) c.selected = false;
    }
    renderChapterList();
  });
  $('chapters-translate-btn').addEventListener('click', () => startTranslate());
  $('chapters-glossary-btn').addEventListener('click', () => openGlossaryEditor('chapters'));
  $('chapters-preview-all-btn').addEventListener('click', () => openEpubPreview('all'));
  $('chapters-download-btn').addEventListener('click', downloadTranslatedEpub);
  $('chapters-settings-btn').addEventListener('click', () => openSettingsDialog());
  $('chapters-discard-btn').addEventListener('click', discardBookTranslation);
  $('chapters-export-session-btn').addEventListener('click', exportEpubSession);
  $('chapters-import-session-btn').addEventListener('click', () => {
    const fi = $('epub-session-import-file');
    fi.value = '';
    fi.click();
  });
  $('epub-session-import-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importEpubSession(file);
  });
  $('chapters-reupload-btn').addEventListener('click', () => {
    clearError();
    releaseCurrentDoc();
    showStage('upload');
  });
}

function bindEpubPreviewUI() {
  if (!stages.epubPreview) return;
  $('epub-preview-back-btn').addEventListener('click', () => showStage('chapters'));
  $('epub-preview-compare').addEventListener('change', (e) => {
    epubPreviewCompare = e.target.checked;
    if (!epubPreviewScope) return;
    // 捲動錨定（2026-07-12 Jimmy 回報）：切換對照後全區重繪、內容高度倍增 /
    // 減半，絕對捲動位置對不上原本在看的段落 → 畫面跳到很遠。重繪前記住
    // 視窗頂附近第一個段落與其視覺偏移，重繪後把同段落捲回同視覺位置
    const anchor = findPreviewScrollAnchor();
    renderEpubPreview();
    restorePreviewScrollAnchor(anchor);
  });
  // 搜尋取代（2026-07-10）：只動已翻段落譯文的文字節點，inline 標記保留；
  // 跨標記邊界的字串搜不到（已知取捨）。改動走 editedHtml（= 手動編輯語意），
  // 下載 / session 存檔都吃得到
  $('epub-sr-apply').addEventListener('click', () => {
    const find = $('epub-sr-find').value;
    const replace = $('epub-sr-replace').value;
    if (!find) return;
    let blocks = 0;
    let hits = 0;
    for (const el of $('epub-preview-content').querySelectorAll('.epub-preview-block[data-state="done"]')) {
      const b = el.__skBlock;
      if (!b) continue;
      let changed = false;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue || !node.nodeValue.includes(find)) continue;
        hits += node.nodeValue.split(find).length - 1;
        node.nodeValue = node.nodeValue.split(find).join(replace);
        changed = true;
      }
      if (changed) {
        blocks++;
        b.editedHtml = el.innerHTML;
        b.translation = el.textContent;
        el.classList.add('is-edited');
      }
    }
    if (blocks > 0) scheduleEpubSessionSave();
    $('epub-sr-status').textContent = t('doc.epub.sr.result', { hits, blocks });
  });
}

// ---------- 譯後一致性掃描（v2.0.11，SPEC §17.10.10）----------
//
// 兩層訊號（掃描邏輯在 epub-scan.js 純函式模組）：
//   第一層：術語表符合度（確定性，免費）
//   第二層：術語表外「同一原文多譯名」（候選挖掘 / 聚合確定性；
//           對照抽取走 SCAN_TERM_RENDERINGS，費用累進本書累計費用）
// option（translateDoc.consistencyScan，預設開啟）只 gate 自動掃描；
// 結果不持久化，每輪翻譯完成後重掃（scanr_ 內容快取讓重掃不重複計費）

async function maybeRunConsistencyScan(doc) {
  if (!doc || doc.kind !== 'epub' || currentDoc !== doc) return;
  try {
    const s = await getSettings();
    if (s.translateDoc?.consistencyScan === false) return;
  } catch (_) { /* 讀不到設定時照預設開啟 */ }
  if (!doc.chapters.some((c) => c.blocks.some((b) => b.translationStatus === 'done'))) return;
  runConsistencyScan(doc).catch((err) => {
    console.warn('[Shinkansen] consistency scan failed', err && err.message);
    if (currentDoc === doc && epubScanState?.running) {
      epubScanState = null;
      renderScanBanner();
    }
  });
}

async function runConsistencyScan(doc) {
  const gen = ++epubScanGen;
  epubScanState = { running: true, tier1: [], cases: [], autoFixes: [] };
  renderScanBanner();

  const glossary = Array.isArray(currentArticleGlossary) ? currentArticleGlossary : [];
  const blockById = new Map();
  for (const ch of doc.chapters) for (const b of ch.blocks) blockById.set(b.blockId, b);

  // 舊版自動替換殘影（「裸名（《譯名》）」）先確定性還原——這些段落含指定譯名
  // 不會被列為違規，不修就永遠殘留（2026-07-12）
  let autoFixes = repairComplianceMangles(doc, glossary);

  // 第一層違規中「譯文仍殘留原文詞」的段落直接自動替換（2026-07-10 Jimmy 指示：
  // 確定性動作不需使用者確認）；替換後重掃，殘留的違規（LLM 用了別種譯名、
  // 譯文找不到原文詞）留在清單，由結果頁「搜尋替換」與「略過」處理。
  // 已略過的 entry 全程排除（不列出、不自動替換——使用者已裁決不需替換）
  let tier1 = filterIgnoredViolations(checkGlossaryCompliance(doc.chapters, glossary));
  const complianceFixes = applyComplianceFixes(doc, tier1, blockById);
  if (complianceFixes.length > 0) {
    autoFixes = mergeComplianceFixes(autoFixes, complianceFixes);
    tier1 = filterIgnoredViolations(checkGlossaryCompliance(doc.chapters, glossary));
  }

  // 已略過的漂移 term 連候選都不進（不送 LLM 對照，2026-07-10）
  const candidates = mineCandidates(doc.chapters, glossary)
    .filter((c) => !epubScanIgnoredDrift.has(c.term));
  const batches = buildScanBatches(candidates, blockById);

  const collected = [];
  for (const batch of batches) {
    if (gen !== epubScanGen || currentDoc !== doc) return;
    // 內容指紋進 scanr_ 快取：同 payload 同結果，續翻後重掃不重複計費
    const inputHash = await sha1(JSON.stringify(batch.items) + '#skscan-v1');
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'SCAN_TERM_RENDERINGS',
        payload: { items: batch.items, inputHash },
      });
    } catch (err) {
      console.warn('[Shinkansen] scan batch failed', err && err.message);
      continue;
    }
    if (res?.ok && Array.isArray(res.renderings)) {
      collected.push({ items: batch.items, results: res.renderings });
      // 抽取費用累進本書累計費用（同術語表抽取；快取命中為 0）
      if (currentDoc === doc && Number.isFinite(res.usage?.billedCostUSD) && res.usage.billedCostUSD > 0) {
        epubCumulativeCostUSD += res.usage.billedCostUSD;
        scheduleEpubSessionSave();
      }
    } else if (res && !res.ok) {
      console.warn('[Shinkansen] scan batch not ok', res.error);
    }
  }
  if (gen !== epubScanGen || currentDoc !== doc) return;

  const cases = aggregateRenderings(collected);
  epubScanState = { running: false, tier1, cases, autoFixes };
  console.log('[Shinkansen] consistency scan done', {
    glossaryViolations: tier1.length, driftCases: cases.length,
    autoFixedEntries: autoFixes.length,
    candidates: candidates.length, batches: batches.length,
  });
  renderScanResults(); // 結果頁若開著（重新掃描入口）同步刷新
  renderScanBanner();
  await renderChapterList(); // 累計費用 row 刷新
}

// 手動（重新）掃描（2026-07-10）：option translateDoc.consistencyScan 只 gate
// 翻譯完成後的自動掃描；使用者明確點掃描 = 明確意圖，不受 option 限制
function triggerManualScan() {
  if (!currentDoc || currentDoc.kind !== 'epub' || epubScanState?.running) return;
  const doc = currentDoc;
  if (!doc.chapters.some((c) => c.blocks.some((b) => b.translationStatus === 'done'))) return;
  runConsistencyScan(doc).catch((err) => {
    console.warn('[Shinkansen] manual consistency scan failed', err && err.message);
    if (currentDoc === doc && epubScanState?.running) {
      epubScanState = null;
      renderScanBanner();
    }
  });
}

// 章節頁掃描入口按鈕：書內有已翻段落即顯示——掃描中 = 進度文字（disabled）；
// 有發現 = 可點開結果頁；尚未掃描 / 零發現 = 手動掃描入口（2026-07-10，
// 取代原「無發現 = 隱藏」——重開工作階段 / option 關閉時也要有掃描途徑）
function renderScanBanner() {
  const btn = $('chapters-scan-btn');
  if (!btn) return;
  // 結果頁「重新掃描」按鈕與入口同步反映掃描狀態
  const rescanBtn = $('scan-rescan-btn');
  if (rescanBtn) {
    rescanBtn.disabled = !!epubScanState?.running;
    rescanBtn.textContent = epubScanState?.running
      ? t('doc.epub.scan.running') : t('doc.epub.scan.rescan');
  }
  const hasDone = currentDoc?.kind === 'epub'
    && currentDoc.chapters.some((c) => c.blocks.some((b) => b.translationStatus === 'done'));
  if (!hasDone) {
    btn.hidden = true;
    return;
  }
  if (epubScanState?.running) {
    btn.hidden = false;
    btn.disabled = true;
    btn.dataset.skMode = 'running';
    btn.textContent = t('doc.epub.scan.running');
    return;
  }
  // 已自動替換的條目也算發現：程式改過使用者的譯文，必須讓他看得到改了什麼。
  // 已略過的也計入——否則全略過後結果頁進不去，「復原」無入口
  const findings = epubScanState
    ? epubScanState.tier1.length
      + epubScanState.cases.filter((c) => !c.applied).length
      + (epubScanState.autoFixes?.length || 0)
      + epubScanIgnored.size
      + epubScanIgnoredDrift.size
    : 0;
  btn.hidden = false;
  btn.disabled = false;
  if (findings > 0) {
    btn.dataset.skMode = 'results';
    btn.textContent = t('doc.epub.scan.banner', { n: findings });
  } else {
    btn.dataset.skMode = 'manual';
    btn.textContent = t('doc.epub.scan.manual');
  }
}

function renderScanResults() {
  const state = epubScanState || { tier1: [], cases: [] };
  const driftWrap = $('scan-drift-wrap');
  const compWrap = $('scan-compliance-wrap');
  const driftList = $('scan-drift-list');
  const compList = $('scan-compliance-list');
  driftList.replaceChildren();
  compList.replaceChildren();

  const activeCases = state.cases || [];
  const visibleCases = activeCases.filter((c) => !c.dismissed && !epubScanIgnoredDrift.has(c.term));
  // driftWrap 顯示條件在漂移略過揭露列渲染後統一設定（含已略過項）
  // 譯名出現處的上下文查表（2026-07-10：光看譯名無法決策——同 term 的不同
  // 譯法可能是語境差異而非漂移，例如日期措辭，必須讓使用者看到前後文再選）
  const blockCtxById = new Map();
  if ((activeCases.length > 0 || (state.tier1 || []).length > 0 || (state.autoFixes || []).length > 0) && currentDoc?.kind === 'epub') {
    for (const ch of currentDoc.chapters) {
      for (const b of ch.blocks) blockCtxById.set(b.blockId, { block: b, chapterIndex: ch.index });
    }
  }
  activeCases.forEach((scCase, idx) => {
    if (scCase.dismissed) return; // 已套用且人工確認過 → 收起
    if (epubScanIgnoredDrift.has(scCase.term)) return; // 人工判斷非真漂移 → 略過
    const card = document.createElement('div');
    card.className = 'scan-case';
    const termEl = document.createElement('div');
    termEl.className = 'scan-case-term';
    termEl.textContent = scCase.term;
    card.appendChild(termEl);
    if (scCase.applied) {
      const done = document.createElement('div');
      done.className = 'scan-case-status';
      done.textContent = t('doc.epub.scan.applied', {
        keep: scCase.applied.keep || '', n: scCase.applied.hits, blocks: scCase.applied.blocks,
      });
      card.appendChild(done);
      // 套用結果摘錄（2026-07-10 Jimmy 指示：看得到改成什麼才能人工確認）：
      // 每個被改段落列當前譯文前後文，統一後的譯名加粗
      const resultWrap = document.createElement('div');
      resultWrap.className = 'scan-rendering-contexts scan-applied-contexts';
      const changed = scCase.applied.undo || [];
      const MAX_APPLIED_CTX = 6;
      for (const u of changed.slice(0, MAX_APPLIED_CTX)) {
        if (typeof u.block?.translation !== 'string' || !u.block.translation) continue;
        const line = document.createElement('div');
        line.className = 'scan-rendering-context';
        const chap = document.createElement('span');
        chap.className = 'scan-context-chapter';
        chap.textContent = t('doc.epub.scan.contextChapter', { n: u.chapterIndex + 1 });
        line.appendChild(chap);
        appendExcerptWithHighlight(line, u.block.translation, scCase.applied.keep);
        resultWrap.appendChild(line);
      }
      if (changed.length > MAX_APPLIED_CTX) {
        const more = document.createElement('div');
        more.className = 'scan-rendering-context';
        more.textContent = t('doc.epub.scan.moreItems', { n: changed.length - MAX_APPLIED_CTX });
        resultWrap.appendChild(more);
      }
      if (resultWrap.childNodes.length > 0) card.appendChild(resultWrap);
      // 套用預設不回填術語表（2026-07-10）——套用後仍可明確按鈕加入；
      // 略過 = 人工確認沒問題收起；復原 = 還原套用前文字
      const actions = buildAddGlossaryActions(scCase, () => scCase.applied.keep);
      const skipBtn = document.createElement('button');
      skipBtn.type = 'button';
      skipBtn.className = 'secondary-btn scan-case-dismiss-btn';
      skipBtn.textContent = t('doc.epub.scan.skip');
      skipBtn.addEventListener('click', () => dismissScanCase(scCase));
      const undoBtn = document.createElement('button');
      undoBtn.type = 'button';
      undoBtn.className = 'secondary-btn scan-case-undo-btn';
      undoBtn.textContent = t('doc.epub.scan.undo');
      undoBtn.addEventListener('click', () => undoScanCase(scCase));
      actions.insertBefore(undoBtn, actions.firstChild);
      actions.insertBefore(skipBtn, actions.firstChild);
      card.appendChild(actions);
      driftList.appendChild(card);
      return;
    }
    for (const r of scCase.renderings) {
      const row = document.createElement('label');
      row.className = 'scan-rendering-row';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `scan-case-${idx}`;
      radio.value = r.text;
      if (r === scCase.renderings[0]) radio.checked = true; // 預設最多數的
      const text = document.createElement('span');
      text.textContent = r.text;
      const count = document.createElement('span');
      count.className = 'scan-rendering-count';
      count.textContent = t('doc.epub.scan.count', { n: r.count });
      row.append(radio, text, count);
      card.appendChild(row);
      // 每處出現的譯文摘錄（章節標記 + 譯名加粗；字重 + 色階雙通道）
      const ctxWrap = document.createElement('div');
      ctxWrap.className = 'scan-rendering-contexts';
      for (const blockId of r.blockIds) {
        const info = blockCtxById.get(blockId);
        if (!info || typeof info.block.translation !== 'string' || !info.block.translation) continue;
        const line = document.createElement('div');
        line.className = 'scan-rendering-context';
        const chap = document.createElement('span');
        chap.className = 'scan-context-chapter';
        chap.textContent = t('doc.epub.scan.contextChapter', { n: info.chapterIndex + 1 });
        line.appendChild(chap);
        appendExcerptWithHighlight(line, info.block.translation, r.text);
        ctxWrap.appendChild(line);
      }
      if (ctxWrap.childNodes.length > 0) card.appendChild(ctxWrap);
    }
    const actions = document.createElement('div');
    actions.className = 'scan-case-actions';
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'secondary-btn';
    applyBtn.textContent = t('doc.epub.scan.apply');
    applyBtn.addEventListener('click', () => {
      const chosen = card.querySelector(`input[name="scan-case-${idx}"]:checked`);
      if (chosen) applyScanCase(scCase, chosen.value);
    });
    actions.appendChild(applyBtn);
    // 略過（2026-07-10 Jimmy 指示）：人工判斷非真漂移（例如日期語境差異）→
    // 記入漂移略過清單（隨工作階段持久化，下次掃描連 LLM 對照都跳過）
    const driftSkipBtn = document.createElement('button');
    driftSkipBtn.type = 'button';
    driftSkipBtn.className = 'secondary-btn scan-drift-skip-btn';
    driftSkipBtn.textContent = t('doc.epub.scan.skip');
    driftSkipBtn.addEventListener('click', () => skipDriftCase(scCase));
    actions.appendChild(driftSkipBtn);
    // 「加入術語表」獨立按鈕（2026-07-10 Jimmy 指示）：套用只取代文字，
    // 寫入全書術語表由此鈕明確觸發（用當前選定的譯名）
    appendAddGlossaryControls(actions, scCase,
      () => card.querySelector(`input[name="scan-case-${idx}"]:checked`)?.value || '');
    card.appendChild(actions);
    driftList.appendChild(card);
  });

  // 漂移已略過揭露列（可復原）：略過是隱形狀態，必須揭露
  for (const term of epubScanIgnoredDrift) {
    const row = document.createElement('div');
    row.className = 'scan-compliance-row scan-skipped-row scan-drift-skipped-row';
    const label = document.createElement('span');
    label.textContent = t('doc.epub.scan.skippedTerm', { term });
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'secondary-btn scan-drift-skip-undo-btn';
    undoBtn.textContent = t('doc.epub.scan.undo');
    undoBtn.addEventListener('click', () => undoSkipDrift(term));
    row.append(label, document.createTextNode(' '), undoBtn);
    driftList.appendChild(row);
  }
  driftWrap.hidden = visibleCases.length === 0 && epubScanIgnoredDrift.size === 0;

  const tier1 = state.tier1 || [];
  const autoFixes = state.autoFixes || [];
  const skippedEntries = [...epubScanIgnored.values()];
  compWrap.hidden = tier1.length === 0 && autoFixes.length === 0 && skippedEntries.length === 0;
  // 已自動替換列（資訊揭露：掃描動過使用者的譯文，列出改了什麼）
  for (const f of autoFixes) {
    const row = document.createElement('div');
    row.className = 'scan-compliance-row scan-autofixed-row';
    const head = document.createElement('span');
    head.textContent = t(f.manual ? 'doc.epub.scan.userfixed' : 'doc.epub.scan.autofixed', {
      source: f.source, target: f.expected, n: f.hits, blocks: f.blocks,
      chapters: [...f.chapters].sort((a, b) => a - b).join(', '),
    });
    row.appendChild(head);
    // 替換結果摘錄（2026-07-12 Jimmy 指示：已替換的也要看得到改成什麼樣才能
    // 人工確認）：每個被改段落列當前譯文前後文，替換後譯名加粗（同漂移套用摘錄）
    const refs = Array.isArray(f.blockRefs) ? f.blockRefs : [];
    const ctxWrap = document.createElement('div');
    ctxWrap.className = 'scan-rendering-contexts scan-applied-contexts';
    const MAX_FIXED_CTX = 6;
    for (const r of refs.slice(0, MAX_FIXED_CTX)) {
      const info = blockCtxById.get(r.blockId);
      if (typeof info?.block?.translation !== 'string' || !info.block.translation) continue;
      const line = document.createElement('div');
      line.className = 'scan-rendering-context';
      const chap = document.createElement('span');
      chap.className = 'scan-context-chapter';
      chap.textContent = t('doc.epub.scan.contextChapter', { n: r.chapterIndex + 1 });
      line.appendChild(chap);
      appendExcerptWithHighlight(line, info.block.translation, f.expected);
      ctxWrap.appendChild(line);
    }
    if (refs.length > MAX_FIXED_CTX) {
      const more = document.createElement('div');
      more.className = 'scan-rendering-context';
      more.textContent = t('doc.epub.scan.moreItems', { n: refs.length - MAX_FIXED_CTX });
      ctxWrap.appendChild(more);
    }
    if (ctxWrap.childNodes.length > 0) row.appendChild(ctxWrap);
    compList.appendChild(row);
  }
  // 依 entry 分組：同一條術語的違規列一行 + 章節統計
  const grouped = new Map();
  for (const v of tier1) {
    const key = `${v.source}\u0000${v.expected}`;
    let g = grouped.get(key);
    if (!g) {
      g = { source: v.source, expected: v.expected, count: 0, chapters: new Set(), items: [] };
      grouped.set(key, g);
    }
    g.count++;
    g.chapters.add(v.chapterIndex + 1);
    g.items.push(v);
  }
  for (const g of grouped.values()) {
    const row = document.createElement('div');
    row.className = 'scan-compliance-row';
    const head = document.createElement('span');
    head.textContent = t('doc.epub.scan.compliance.row', {
      source: g.source, target: g.expected, n: g.count,
      chapters: [...g.chapters].sort((a, b) => a - b).join(', '),
    });
    // 逐段列「原文摘錄（原詞加粗）+ 譯文摘錄」（2026-07-10 Jimmy 指示）：
    // 違規的定義是「譯文缺指定譯名」，不代表譯文殘留原文詞——使用者必須
    // 看到譯文實際用了什麼寫法才能決定搜尋取代或改術語表
    const MAX_CTX_ITEMS = 6;
    const ctxList = document.createElement('div');
    ctxList.className = 'scan-compliance-contexts';
    for (const v of g.items.slice(0, MAX_CTX_ITEMS)) {
      const info = blockCtxById.get(v.blockId);
      const item = document.createElement('div');
      item.className = 'scan-compliance-item';
      const srcLine = document.createElement('div');
      srcLine.className = 'scan-rendering-context';
      const chap = document.createElement('span');
      chap.className = 'scan-context-chapter';
      chap.textContent = t('doc.epub.scan.contextChapter', { n: v.chapterIndex + 1 });
      const srcTag = document.createElement('span');
      srcTag.className = 'scan-excerpt-label';
      srcTag.textContent = t('doc.epub.scan.excerpt.src');
      srcLine.append(chap, srcTag);
      if (typeof info?.block?.plainText === 'string' && info.block.plainText) {
        appendExcerptWithHighlight(srcLine, info.block.plainText, v.source);
      } else {
        srcLine.appendChild(document.createTextNode(v.excerpt));
      }
      item.appendChild(srcLine);
      const dstText = info?.block?.translation;
      if (typeof dstText === 'string' && dstText) {
        const dstLine = document.createElement('div');
        dstLine.className = 'scan-rendering-context';
        const dstTag = document.createElement('span');
        dstTag.className = 'scan-excerpt-label';
        dstTag.textContent = t('doc.epub.scan.excerpt.dst');
        dstLine.appendChild(dstTag);
        dstLine.appendChild(document.createTextNode(
          translationExcerptNear(dstText, info.block.plainText, v.source)));
        item.appendChild(dstLine);
      }
      ctxList.appendChild(item);
    }
    if (g.items.length > MAX_CTX_ITEMS) {
      const more = document.createElement('div');
      more.className = 'scan-rendering-context';
      more.textContent = t('doc.epub.scan.moreItems', { n: g.items.length - MAX_CTX_ITEMS });
      ctxList.appendChild(more);
    }
    const actions = document.createElement('div');
    actions.className = 'scan-case-actions';
    const status = document.createElement('span');
    status.className = 'scan-case-status';
    // 使用者輸入譯文中實際使用的譯名 → 直接搜尋替換為指定譯名（2026-07-10
    // Jimmy 指示）：從譯文摘錄看出 LLM 用了什麼寫法後，就地修正不用跳全書預覽
    const termInput = document.createElement('input');
    termInput.type = 'text';
    termInput.className = 'scan-term-input';
    termInput.placeholder = t('doc.epub.scan.termInput.placeholder');
    const customBtn = document.createElement('button');
    customBtn.type = 'button';
    customBtn.className = 'secondary-btn scan-custom-replace-btn';
    customBtn.textContent = t('doc.epub.scan.replaceCustom');
    customBtn.addEventListener('click', () => {
      const term = termInput.value.trim();
      if (!term) {
        termInput.focus();
        return;
      }
      customComplianceReplace(g, term, status);
    });
    termInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') customBtn.click();
    });
    // 略過（2026-07-10）：人工 review 後認定不需替換 → 移出清單（可復原）
    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'secondary-btn scan-skip-btn';
    skipBtn.textContent = t('doc.epub.scan.skip');
    skipBtn.addEventListener('click', () => skipComplianceEntry(g));
    actions.append(termInput, customBtn, skipBtn, status);
    row.append(head, ctxList, actions);
    compList.appendChild(row);
  }
  // 已略過列（可復原）：略過是隱形狀態，必須揭露才不會變成「為什麼掃不到」謎團
  for (const e of skippedEntries) {
    const row = document.createElement('div');
    row.className = 'scan-compliance-row scan-skipped-row';
    const label = document.createElement('span');
    label.textContent = t('doc.epub.scan.skipped', { source: e.source, target: e.expected });
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'secondary-btn scan-skip-undo-btn';
    undoBtn.textContent = t('doc.epub.scan.undo');
    undoBtn.addEventListener('click', () => undoSkipEntry(e));
    row.append(label, document.createTextNode(' '), undoBtn);
    compList.appendChild(row);
  }

  $('scan-empty').hidden = visibleCases.length > 0 || tier1.length > 0
    || autoFixes.length > 0 || skippedEntries.length > 0 || epubScanIgnoredDrift.size > 0;
}

// block DOM 內逐 text node 替換（單一資料源：自動替換 / 搜尋替換 / 漂移套用共用）。
// 帶節點邊界 context——詞落在 text node 開頭 / 結尾時，節點內看不到相鄰節點的
// 字元，空格規則會漏（2026-07-10 Jimmy 回報「贊助商Haas 車隊」前緣沒補空格）；
// 把相鄰節點的前後字元交給 replaceTermInText 判斷
// opts 穿透 replaceTermInText 的 ctx 選項（skipAnnotated / skipTitleAdjacent，
// 合規自動替換用；搜尋替換 / 漂移套用不帶 opts、行為不變）
function replaceInTextNodes(el, term, replacement, opts = null) {
  const nodes = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  let hits = 0;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node.nodeValue) continue;
    let prevChar = '';
    for (let j = i - 1; j >= 0 && !prevChar; j--) prevChar = (nodes[j].nodeValue || '').slice(-1);
    let nextChar = '';
    for (let j = i + 1; j < nodes.length && !nextChar; j++) nextChar = (nodes[j].nodeValue || '').charAt(0);
    const r = replaceTermInText(node.nodeValue, term, replacement, { ...opts, prevChar, nextChar });
    if (r.count > 0) {
      node.nodeValue = r.text;
      hits += r.count;
    }
  }
  // 第二遍:跨節點出現位置（v2.0.53）——inline 殼把詞切成多個 text node 時
  // 逐節點搜尋看不見完整詞（實例:日文書 ruby 逐字 slot,「我叫柏木⟦/0⟧⟦1⟧⟦/1⟧斉」
  // 搜「柏木斉」不中,2026-07-11 Jimmy 回報「搜尋替換找不到詞彙」）
  hits += replaceAcrossTextNodes(nodes, term, replacement, opts);
  return hits;
}

// 跨 text node 替換:把節點串接成全文找 term,映射回節點區間動手術——首節點
// 寫入「頭 + 替換結果」,中間節點清空,尾節點留「尾」。邊界 / CJK↔拉丁空格
// 語意經 synthetic context 字串（前鄰字 + term + 後鄰字）重用 replaceTermInText,
// 不留雙實作:拉丁詞邊界拒絕時 r.count=0,空格增補會出現在 r.text 的中段
function replaceAcrossTextNodes(nodes, term, replacement, opts = null) {
  if (!term || typeof replacement !== 'string' || term === replacement) return 0;
  let hits = 0;
  let from = 0; // joined 座標,跨輪單調前進——替換結果含 term 時不回頭,防無限迴圈
  for (let guard = 0; guard < 1000; guard++) {
    const vals = nodes.map((nd) => nd.nodeValue || '');
    const joined = vals.join('');
    const idx = joined.indexOf(term, from);
    if (idx === -1) return hits;
    const prevChar = idx > 0 ? joined[idx - 1] : '';
    const nextChar = joined[idx + term.length] || '';
    const synth = prevChar + term + nextChar;
    // synth 已含相鄰字元，skip 類選項直接在 synth 內判斷（r.count=0 走拒絕分支）
    const r = replaceTermInText(synth, term, replacement, { ...opts });
    if (r.count === 0) { from = idx + 1; continue; } // 拉丁詞邊界拒絕（Ann in Announcement）
    const middle = r.count === 1
      ? r.text.slice(prevChar.length, r.text.length - nextChar.length)
      : replacement; // 極端 case（單字 term 與鄰字相同→synth 內多次命中）:放棄空格微調直接替換
    // 映射 [idx, idx + term.length) 到節點區間
    let acc = 0;
    let sN = -1; let sOff = 0; let eN = -1; let eOff = 0;
    for (let i = 0; i < nodes.length; i++) {
      const len = vals[i].length;
      if (sN === -1 && idx < acc + len) { sN = i; sOff = idx - acc; }
      if (sN !== -1 && idx + term.length <= acc + len) { eN = i; eOff = idx + term.length - acc; break; }
      acc += len;
    }
    if (sN === -1 || eN === -1) return hits; // 防禦:映射失敗不硬換
    if (sN === eN) { from = idx + 1; continue; } // 單節點殘餘 = 第一遍已判定不換,跳過
    nodes[sN].nodeValue = vals[sN].slice(0, sOff) + middle;
    for (let i = sN + 1; i < eN; i++) nodes[i].nodeValue = '';
    nodes[eN].nodeValue = vals[eN].slice(eOff);
    hits++;
    from = idx + middle.length;
  }
  return hits;
}
// 測試 seam（spec 驗證跨節點空格 context 接線）
window.__skReplaceInTextNodes = replaceInTextNodes;

// 譯文摘錄：term 前後各取 radius 字元，term 本體 <strong> 加粗（配合 muted
// 底色構成字重 + 色階雙通道）。純 DOM 組裝不走 innerHTML（譯文是使用者資料）
function appendExcerptWithHighlight(el, text, term, radius = 40) {
  const idx = text.indexOf(term);
  if (idx === -1) {
    el.appendChild(document.createTextNode(text.slice(0, radius * 2)));
    return;
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + term.length + radius);
  el.appendChild(document.createTextNode((start > 0 ? '…' : '') + text.slice(start, idx)));
  const strong = document.createElement('strong');
  strong.textContent = term;
  el.appendChild(strong);
  el.appendChild(document.createTextNode(text.slice(idx + term.length, end) + (end < text.length ? '…' : '')));
}

// 違規段的譯文摘錄：指定譯名與原文詞都不在譯文中（否則不會成為待處理違規），
// 沒有精確錨點——用原文詞在原文中的位置比例對位到譯文取前後文（結構性啟發，
// 通常落在對應句子附近，非精確對齊）
function translationExcerptNear(translation, plainText, term, radius = 40) {
  let center = 0;
  const idx = typeof plainText === 'string' ? plainText.indexOf(term) : -1;
  if (idx >= 0 && plainText.length > 0) {
    center = Math.round((idx / plainText.length) * translation.length);
  }
  const start = Math.max(0, center - radius);
  const end = Math.min(translation.length, center + radius * 2);
  return (start > 0 ? '…' : '') + translation.slice(start, end) + (end < translation.length ? '…' : '');
}

// 術語表符合度違規的確定性替換（2026-07-10）：違規段譯文仍殘留原文詞 →
// 直接把原文詞替換成指定譯名（text node 級、editedHtml 語意，同 applyScanCase
// 的手動編輯身分存回；刻意不重翻——cache key 會變、重計費）。
// noTranslate 違規（譯文把該保留的原文弄丟）無從確定性還原，略過。
// 邊界語意與掃描比對一致（replaceTermInText：拉丁詞邊界 / 非拉丁 substring）。
// 回傳 [{ source, expected, hits, blocks, chapters:Set }]（僅實際有替換的條目）
function applyComplianceFixes(doc, violations, blockByIdArg = null) {
  if (!Array.isArray(violations) || violations.length === 0) return [];
  const SK = window.__SK;
  let blockById = blockByIdArg;
  if (!blockById) {
    blockById = new Map();
    for (const ch of doc.chapters) for (const b of ch.blocks) blockById.set(b.blockId, b);
  }
  const groups = new Map();
  let changed = false;
  for (const v of violations) {
    if (v.noTranslate || v.source === v.expected) continue;
    const b = blockById.get(v.blockId);
    if (!b || b.translationStatus !== 'done') continue;
    const el = renderBlockForScanEdit(b, SK);
    if (!el) continue;
    let hits = 0;
    // 帶《》的指定譯名被模型輸出成「裸名（原文）」（書名號被剝、對照還在）→
    // 補回書名號：整組「裸名（原文）」換成「《裸名》（原文）」。skipTitleAdjacent
    // 防止已有《》的位置疊成《《》》（2026-07-12 Jimmy 回報 Bowfinger 案例）
    if (v.annotation && /^《.+》$/.test(v.expected)) {
      const bare = v.expected.slice(1, -1);
      for (const wrapped of [`${bare}（${v.annotation}）`, `${bare}(${v.annotation})`]) {
        hits += replaceInTextNodes(el, wrapped, `${v.expected}（${v.annotation}）`,
          { skipTitleAdjacent: true });
      }
    }
    // 殘留原文詞 → 指定譯名。skipAnnotated：包在括號內的「（原文）」是
    // 「譯名（原文）」對照協定的一部分，不是殘留待譯詞，不可替換
    hits += replaceInTextNodes(el, v.source, v.expected, { skipAnnotated: true });
    if (hits === 0) continue;
    b.editedHtml = el.innerHTML;
    b.translation = el.textContent;
    changed = true;
    const key = v.source + '\u0000' + v.expected;
    let g = groups.get(key);
    if (!g) {
      g = { source: v.source, expected: v.expected, hits: 0, blocks: 0, chapters: new Set(), blockRefs: [] };
      groups.set(key, g);
    }
    g.hits += hits;
    g.blocks++;
    g.chapters.add(v.chapterIndex + 1);
    g.blockRefs.push({ blockId: v.blockId, chapterIndex: v.chapterIndex });
  }
  if (changed) scheduleEpubSessionSave();
  return [...groups.values()];
}

// 舊版合規自動替換殘影修復（2026-07-12）：v2.0.53~2.0.54 的自動替換會把
// 「裸名（原文）」對照括號內的原文也換成譯名，產出「裸名（《譯名》）」
//（實例：「大製騙家（《大製騙家》）」）。結構特徵：對照括號內容 = 帶書名號的
// 譯名本體——對照協定該放原文，這個形狀只可能是程式誤替換產出，確定性還原為
// 完整指定譯名「《譯名》（原文）」。只處理帶《》的 work 類 target（特徵無歧義）；
// 已略過的 entry 不碰（使用者已裁決）。回傳 group 陣列（同 applyComplianceFixes）
function repairComplianceMangles(doc, glossary) {
  if (!Array.isArray(glossary) || glossary.length === 0) return [];
  const SK = window.__SK;
  const groups = new Map();
  let changed = false;
  for (const entry of glossary) {
    if (!entry || entry.noTranslate === true) continue;
    if (typeof entry.source !== 'string' || typeof entry.target !== 'string') continue;
    const m = entry.target.trim().match(/^(《.+》)（(.+)）\s*$/);
    if (!m) continue;
    const base = m[1]; // 《大製騙家》
    const annotation = m[2].trim(); // Bowfinger
    if (!annotation) continue;
    if (epubScanIgnored.has(scanIgnoreKey(entry.source.trim(), base))) continue;
    const bare = base.slice(1, -1);
    const sig = `${bare}（${base}）`;
    const replacement = `${base}（${annotation}）`;
    for (const ch of doc.chapters) {
      for (const b of ch.blocks) {
        if (b.translationStatus !== 'done') continue;
        if (typeof b.translation !== 'string' || !b.translation.includes(sig)) continue;
        const el = renderBlockForScanEdit(b, SK);
        if (!el) continue;
        const hits = replaceInTextNodes(el, sig, replacement);
        if (hits === 0) continue;
        b.editedHtml = el.innerHTML;
        b.translation = el.textContent;
        changed = true;
        const key = entry.source.trim() + '\u0000' + base;
        let g = groups.get(key);
        if (!g) {
          g = { source: entry.source.trim(), expected: base, hits: 0, blocks: 0, chapters: new Set(), blockRefs: [] };
          groups.set(key, g);
        }
        g.hits += hits;
        g.blocks++;
        g.chapters.add(ch.index + 1);
        g.blockRefs.push({ blockId: b.blockId, chapterIndex: ch.index });
      }
    }
  }
  if (changed) scheduleEpubSessionSave();
  return [...groups.values()];
}

// 略過清單工具（2026-07-10）
function scanIgnoreKey(source, expected) {
  return source + '→' + expected;
}

function hydrateScanIgnored(arr) {
  const map = new Map();
  for (const e of arr) {
    if (!e || typeof e.source !== 'string' || typeof e.expected !== 'string') continue;
    map.set(scanIgnoreKey(e.source, e.expected), { source: e.source, expected: e.expected });
  }
  return map;
}

function filterIgnoredViolations(violations) {
  if (!Array.isArray(violations) || epubScanIgnored.size === 0) return violations || [];
  return violations.filter((v) => !epubScanIgnored.has(scanIgnoreKey(v.source, v.expected)));
}

// 略過（2026-07-10 Jimmy 指示）：人工 review 後認定該詞彙不需替換 → 記入略過
// 清單（隨工作階段持久化），本列移除、之後重掃不再列出、自動替換也不碰。
// 誤按有「復原」（略過列以揭露列形式留在結果頁）
function skipComplianceEntry(group) {
  if (!currentDoc || currentDoc.kind !== 'epub' || !epubScanState) return;
  epubScanIgnored.set(scanIgnoreKey(group.source, group.expected),
    { source: group.source, expected: group.expected });
  scheduleEpubSessionSave();
  epubScanState.tier1 = filterIgnoredViolations(epubScanState.tier1);
  renderScanResults();
  renderScanBanner();
}

function undoSkipEntry(entry) {
  if (!currentDoc || currentDoc.kind !== 'epub' || !epubScanState) return;
  epubScanIgnored.delete(scanIgnoreKey(entry.source, entry.expected));
  scheduleEpubSessionSave();
  const glossary = Array.isArray(currentArticleGlossary) ? currentArticleGlossary : [];
  epubScanState.tier1 = filterIgnoredViolations(checkGlossaryCompliance(currentDoc.chapters, glossary));
  renderScanResults();
  renderScanBanner();
}

// 使用者輸入譯文中實際使用的譯名 → 在「原文含該詞」的已翻段落把它搜尋替換為
// 指定譯名（範圍同 applyScanCase；text node 級、editedHtml 語意；替換語意同
// replaceTermInText 的詞邊界規則）。完成後重算符合度並刷新掃描結果
function customComplianceReplace(group, term, statusEl) {
  if (!currentDoc || currentDoc.kind !== 'epub' || !epubScanState || epubScanState.running) return;
  if (!term || term === group.expected) return;
  const SK = window.__SK;
  let hits = 0;
  let blocks = 0;
  const chapters = new Set();
  const blockRefs = [];
  for (const ch of currentDoc.chapters) {
    for (const b of ch.blocks) {
      if (b.translationStatus !== 'done') continue;
      if (typeof b.plainText !== 'string' || !sourceHasTerm(b.plainText, group.source)) continue;
      const el = renderBlockForScanEdit(b, SK);
      if (!el) continue;
      const blockHits = replaceInTextNodes(el, term, group.expected);
      if (blockHits === 0) continue;
      b.editedHtml = el.innerHTML;
      b.translation = el.textContent;
      hits += blockHits;
      blocks++;
      chapters.add(ch.index + 1);
      blockRefs.push({ blockId: b.blockId, chapterIndex: ch.index });
    }
  }
  if (hits === 0) {
    if (statusEl) statusEl.textContent = t('doc.epub.scan.customNotFound', { term });
    return;
  }
  scheduleEpubSessionSave();
  epubScanState.autoFixes = mergeComplianceFixes(epubScanState.autoFixes || [],
    [{ source: group.source, expected: group.expected, hits, blocks, chapters, blockRefs, manual: true }]);
  epubScanState.tier1 = filterIgnoredViolations(checkGlossaryCompliance(currentDoc.chapters,
    Array.isArray(currentArticleGlossary) ? currentArticleGlossary : []));
  renderScanResults();
  renderScanBanner();
}

function mergeComplianceFixes(base, extra) {
  // key 含 manual 維度：自動替換與使用者搜尋替換分列（揭露來源不混淆）
  const keyOf = (f) => f.source + '\u0000' + f.expected + (f.manual ? ':m' : '');
  const map = new Map(base.map((f) => [keyOf(f), f]));
  for (const f of extra) {
    const key = keyOf(f);
    const g = map.get(key);
    if (!g) {
      map.set(key, f);
      continue;
    }
    g.hits += f.hits;
    g.blocks += f.blocks;
    for (const c of f.chapters) g.chapters.add(c);
    // blockRefs 併入（替換結果摘錄用）；同 block 多輪替換只留一筆
    if (Array.isArray(f.blockRefs) && f.blockRefs.length > 0) {
      g.blockRefs = g.blockRefs || [];
      const seen = new Set(g.blockRefs.map((r) => r.blockId));
      for (const r of f.blockRefs) {
        if (seen.has(r.blockId)) continue;
        seen.add(r.blockId);
        g.blockRefs.push(r);
      }
    }
  }
  return [...map.values()];
}

// 套用選定譯名：在「原文含該詞」的已翻段落把其他譯名取代為選定譯名
//（text node 級，同搜尋取代語意，走 editedHtml → session / 譯本都吃得到）。
// 預設不回填術語表（2026-07-10 Jimmy 指示）——回填由「加入術語表」按鈕明確觸發。
// 刻意不重翻（cache key 會變、重計費；確定性取代已達同樣效果）
function applyScanCase(scCase, keep) {
  if (!currentDoc || currentDoc.kind !== 'epub' || !keep) return;
  const SK = window.__SK;
  const others = scCase.renderings.map((r) => r.text).filter((x) => x && x !== keep);
  if (others.length === 0) return;
  let hits = 0;
  let blocks = 0;
  const undo = []; // 被改段落的套用前快照（「復原」用，2026-07-10 Jimmy 指示）
  for (const ch of currentDoc.chapters) {
    for (const b of ch.blocks) {
      if (b.translationStatus !== 'done') continue;
      if (typeof b.plainText !== 'string' || !sourceHasTerm(b.plainText, scCase.term)) continue;
      const el = renderBlockForScanEdit(b, SK);
      if (!el) continue;
      const prevEditedHtml = (typeof b.editedHtml === 'string' && b.editedHtml.length > 0) ? b.editedHtml : null;
      const prevTranslation = typeof b.translation === 'string' ? b.translation : null;
      let changed = false;
      for (const other of others) {
        // 走 replaceInTextNodes：空格規則（含跨節點邊界）與其他掃描替換一致（2026-07-10）
        const n = replaceInTextNodes(el, other, keep);
        if (n === 0) continue;
        hits += n;
        changed = true;
      }
      if (changed) {
        blocks++;
        undo.push({ block: b, prevEditedHtml, prevTranslation, chapterIndex: ch.index });
        b.editedHtml = el.innerHTML;
        b.translation = el.textContent;
      }
    }
  }
  scheduleEpubSessionSave(); // editedHtml 落地（不動術語表）
  scCase.applied = { hits, blocks, keep, undo };
  renderScanResults();
  renderScanBanner();
}

// 復原套用（2026-07-10 Jimmy 指示）：把被改段落還原成套用前快照（editedHtml /
// translation），案例卡回到譯名選擇狀態。不動術語表（若已按「加入術語表」，
// 該條目保留——復原只還原文字）
function undoScanCase(scCase) {
  if (!currentDoc || currentDoc.kind !== 'epub' || !scCase.applied) return;
  for (const u of scCase.applied.undo || []) {
    u.block.editedHtml = u.prevEditedHtml;
    u.block.translation = u.prevTranslation;
  }
  scCase.applied = null;
  scCase.dismissed = false;
  scheduleEpubSessionSave();
  renderScanResults();
  renderScanBanner();
}

// 略過（已套用案例）：人工確認套用結果沒問題後收起卡片。掃描結果不持久化、
// 套用後重掃也不會再偵測到同一漂移，dismissed 只需活在本輪掃描狀態
function dismissScanCase(scCase) {
  scCase.dismissed = true;
  renderScanResults();
  renderScanBanner();
}

// 略過漂移案例（未套用，2026-07-10）：人工判斷非真漂移 → 記入持久化略過清單。
// 本輪 state 內的案例只在 render 過濾（復原可立即回來）；下輪掃描連候選都不進
function skipDriftCase(scCase) {
  if (!currentDoc || currentDoc.kind !== 'epub' || !epubScanState) return;
  epubScanIgnoredDrift.add(scCase.term);
  scheduleEpubSessionSave();
  renderScanResults();
  renderScanBanner();
}

function undoSkipDrift(term) {
  if (!currentDoc || currentDoc.kind !== 'epub') return;
  epubScanIgnoredDrift.delete(term);
  scheduleEpubSessionSave();
  // 本輪偵測過的案例立即回列；已被下輪掃描跳過的要再按「重新掃描」才會回來
  renderScanResults();
  renderScanBanner();
}

// 「加入術語表」（2026-07-10）：把選定譯名寫入全書術語表——後續翻譯經注入
// 優先採用（軟約束，漏用由一致性掃描把關，不是硬鎖定）。
// 同 source 已存在則更新其譯名（使用者明確選擇優先）
function addScanCaseToGlossary(scCase, keep, statusEl) {
  if (!currentDoc || currentDoc.kind !== 'epub' || !keep) return;
  const list = Array.isArray(currentArticleGlossary) ? [...currentArticleGlossary] : [];
  const existing = list.find((e) => e && typeof e.source === 'string'
    && e.source.trim().toLowerCase() === scCase.term.toLowerCase());
  if (existing) existing.target = keep;
  else list.push({ source: scCase.term, target: keep });
  savePersistedBookGlossary(list); // 內含 session 持久化
  if (statusEl) statusEl.textContent = t('doc.epub.scan.addedGlossary');
}

// 在 actions 容器內加「加入術語表」按鈕 + 就地狀態文字
function appendAddGlossaryControls(actions, scCase, getKeep) {
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'secondary-btn scan-add-glossary-btn';
  addBtn.textContent = t('doc.epub.scan.addGlossary');
  const status = document.createElement('span');
  status.className = 'scan-case-status';
  addBtn.addEventListener('click', () => {
    const keep = getKeep();
    if (keep) addScanCaseToGlossary(scCase, keep, status);
  });
  actions.append(addBtn, status);
}

function buildAddGlossaryActions(scCase, getKeep) {
  const actions = document.createElement('div');
  actions.className = 'scan-case-actions';
  appendAddGlossaryControls(actions, scCase, getKeep);
  return actions;
}

// 把 block 目前的譯文渲染成可編輯 DOM（editedHtml 優先，同預覽渲染語意、
// 不含對照 dedupe 後處理——套用結果以「手動編輯」身分存回）
// 批次 8 G7:「block 譯文渲染成 DOM」單一 pipeline——editedHtml 優先 → raw 反序列化
// (deserializeWithPlaceholders,cloneReuse)→ 純文字 fallback。三個消費端
// (renderBlockForScanEdit / appendPreviewBlock / autoFixCjkSpacing)原本各自手抄同一條,
// 已出現 dedupe 分支 drift(附錄 A 鏡像表)。override 供 dedupe 後處理視圖注入
// (computeAnnotationDedupe 的 entry:編輯過段落 { editedHtml }、未編輯段落
// { translation, translationRaw },缺的欄位 fallback 回 block 本體)。
// 下載端 applyBlockTranslation(epub-writer.js)同優先序但操作 xhtmlDoc 環境,刻意分開。
function renderBlockContent(b, SK, override = null) {
  const edited = override?.editedHtml ?? b.editedHtml;
  if (typeof edited === 'string' && edited.length > 0) {
    const el = document.createElement('div');
    el.innerHTML = edited;
    return { el, usedEdited: true };
  }
  const raw = override?.translationRaw ?? b.translationRaw;
  if (typeof raw === 'string' && raw && Array.isArray(b.slots)
      && typeof SK?.deserializeWithPlaceholders === 'function') {
    const { frag, ok } = SK.deserializeWithPlaceholders(raw, b.slots, { cloneReuse: true });
    if (ok || (b.slots.length === 0 && frag.childNodes.length > 0)) {
      const el = document.createElement('div');
      el.appendChild(frag);
      return { el, usedEdited: false };
    }
  }
  const plain = override?.translation ?? b.translation;
  if (typeof plain === 'string' && plain) {
    const el = document.createElement('div');
    el.textContent = plain;
    return { el, usedEdited: false };
  }
  return null;
}

function renderBlockForScanEdit(b, SK) {
  return renderBlockContent(b, SK)?.el ?? null;
}

function bindScanUI() {
  if (!stages.scan) return;
  $('chapters-scan-btn').addEventListener('click', () => {
    // 尚未掃描 / 零發現 → 手動觸發；有發現 → 開結果頁
    if ($('chapters-scan-btn').dataset.skMode === 'manual') {
      triggerManualScan();
      return;
    }
    renderScanResults();
    showStage('scan');
  });
  $('scan-rescan-btn').addEventListener('click', () => triggerManualScan());
  $('scan-back-btn').addEventListener('click', async () => {
    await renderChapterList(); // 套用可能改了術語表 / 費用，回去前刷新
    showStage('chapters');
  });
}


// ---------- 全書術語表（§30.3)----------

// 書籍模式抽取規則（角色暱稱 / 變體收錄），隨 EXTRACT_GLOSSARY payload.promptSuffix
// 送到 background 附加在有效 glossary prompt 之後。zh-TW target 用中文版，其餘英文版
const BOOK_GLOSSARY_SUFFIX_ZH = `補充規則（書籍模式）：本次輸入是一本書籍的內容（可能為小說）。
1. 人物優先：主要角色與反覆出現的配角人名一律收錄。
2. 同一人物的暱稱、簡稱、敬稱或別名（例如 Elizabeth / Lizzy / Miss Bennet 是同一人）各建一條，譯名必須對映同一人物的一致中文名（例如伊莉莎白 / 莉茲 / 班奈特小姐），確保跨章節譯名一致。
3. 多詞人名除了全名條目外，「姓氏單獨出現」也要另建一條（例如 Richard Enfield 之外另建 Enfield→恩菲爾德），因為書中常只以姓氏稱呼。
4. 譯名中的姓名分隔一律用全形間隔號「・」（例如「拉夫・舒馬克」），絕對不可用半形「·」。
5. 反覆出現的地名、組織名與作品內世界觀專有名詞（魔法、科技、稱號等設定詞）也收錄。`;
const BOOK_GLOSSARY_SUFFIX_EN = `Additional rules (book mode): the input is part of a book (possibly a novel).
1. Prioritize people: include every main character and recurring supporting character.
2. Create separate entries for nicknames, short forms, honorifics and aliases of the same person (e.g. Elizabeth / Lizzy / Miss Bennet are one person), keeping the translated names consistent for that character across chapters.
3. For multi-word person names, also add a surname-only entry (e.g. besides Richard Enfield, add Enfield), because books often refer to characters by surname alone.
4. When a translated name needs a separator between name parts, always use the full-width middle dot 「・」(U+30FB), never the half-width 「·」.
5. Also include recurring place names, organizations, and in-world proper nouns (magic terms, technologies, titles).`;

// gloss_ 輪快取的內容 hash——抽取與「放棄本書翻譯」清快取共用同一條（單一資料源，
// 兩處各算一份會 drift）。promptSuffix 語意摻進 salt：同文字不同 prompt 模式
// 不可共用 gloss_ 快取（v3：suffix 加全形間隔號規則，2026-07-10；
// v4：glossary prompt 加 <source_fidelity> 禁 source 羅馬化，舊快取可能存有
// 羅馬拼音 source 的抽取結果，不可再命中，2026-07-11）
function bookGlossaryRoundHash(text) {
  return sha1(text + '\n#shinkansen-book-glossary-v4');
}

// 清這本書的 gloss_ 抽取輪快取（含 _lang<x> 等任何 target 後綴，用前綴比對）。
// 放棄本書翻譯時呼叫——否則重開同書按「先建立術語表」逐輪秒回快取，
// 看起來像術語表沒被清掉（2026-07-10 Jimmy 回報）。get(null) 全掃對罕見的
// 破壞性動作可接受
async function clearBookGlossaryExtractionCache(doc) {
  try {
    const rounds = buildBookGlossaryRounds(doc);
    if (rounds.length === 0) return;
    const prefixes = await Promise.all(rounds.map(async (text) => 'gloss_' + await bookGlossaryRoundHash(text)));
    const all = await chrome.storage.local.get(null);
    const toRemove = Object.keys(all).filter((k) => prefixes.some((p) => k.startsWith(p)));
    if (toRemove.length) await chrome.storage.local.remove(toRemove);
    console.log('[Shinkansen] book glossary extraction cache cleared', { removed: toRemove.length });
  } catch (err) {
    console.warn('[Shinkansen] clear book glossary cache failed', err && err.message);
  }
}

async function extractGlossaryForBook(doc, { forceRefresh = false } = {}) {
  const docAtStart = doc;
  const rounds = buildBookGlossaryRounds(doc);
  if (rounds.length === 0) return null;
  const settings = await getSettings();
  const promptSuffix = (settings.targetLanguage === 'zh-TW' || !settings.targetLanguage)
    ? BOOK_GLOSSARY_SUFFIX_ZH
    : BOOK_GLOSSARY_SUFFIX_EN;

  // modelOverride：術語擷取模型設「與主翻譯模型相同」時用文件翻譯 preset
  //（2026-07-10）。抽取常在翻譯開始前（currentModelOverride 尚未設定），就地解析
  const presetModel = currentModelOverride || (await resolvePreset()).modelOverride || null;
  const lists = [];
  let failures = 0;
  for (let i = 0; i < rounds.length; i++) {
    if (currentDoc !== docAtStart) return null; // 使用者已換檔，丟棄
    setGlossaryState(t('doc.epub.glossary.extracting', { current: i + 1, total: rounds.length }), 'is-loading');
    const text = rounds[i];
    const inputHash = await bookGlossaryRoundHash(text);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'EXTRACT_GLOSSARY',
        payload: {
          compressedText: text, inputHash, promptSuffix, forceRefresh,
          modelOverride: presetModel,
        },
      });
      if (res?.ok && Array.isArray(res.glossary)) {
        lists.push(res.glossary);
        // 抽取也是真實 API 花費，累進「本書累計費用」（快取命中 billedCostUSD=0）。
        // 換檔 guard：使用者已換書時這筆費用屬舊書，不可污染新書計數
        if (currentDoc === docAtStart && Number.isFinite(res.usage?.billedCostUSD) && res.usage.billedCostUSD > 0) {
          epubCumulativeCostUSD += res.usage.billedCostUSD;
          scheduleEpubSessionSave();
        }
      } else {
        failures++;
        console.warn('[Shinkansen] book glossary round not ok', i + 1, res?.error);
      }
    } catch (err) {
      failures++;
      console.warn('[Shinkansen] book glossary round failed', i + 1, err && err.message);
    }
  }
  if (currentDoc !== docAtStart) return null;
  if (lists.length === 0) return null; // 全數失敗 → 等同抽取失敗
  const { entries, conflicts } = mergeBookGlossaries(lists);
  console.log('[Shinkansen] book glossary merged', {
    rounds: rounds.length, failures, terms: entries.length, conflicts,
  });
  return entries;
}

// ---------- 工作階段持久化（IndexedDB，epub-session-db.js，2026-07-10）----------
// 翻譯進度 / 手動編輯 / 術語表 / 本書禁用詞整包存檔。不放 chrome.storage.local
// ——「清除翻譯快取」不可波及使用者工作成果

// review G11:session 存檔增量化。原本每次 debounced 存檔 collectSessionBlocks
// 序列化整本書所有 done block 的 raw / plain / edited 三份字串整包重寫 IndexedDB,
// 大書單次數 MB。改 per-block 差異寫入:以「上次已落地的三欄字串 reference」為
// 簽章(字串不可變,欄位有變必換 reference,=== 比對零成本),只把有變的 block
// put 進 blocks store。頁面載入後首次存檔簽章表為空 → 全量寫一次(兼作 v1 整包
// schema 的搬遷);換檔 / 放棄時清簽章表
let _sessionSavedSig = new Map();  // blockId -> { raw, plain, edited }

async function persistEpubSession() {
  if (!currentDoc || currentDoc.kind !== 'epub' || !epubBookHash) return;
  // 首個 await 前同步快照差異(flushPendingSessionSave 依賴此語意)
  const changedBlocks = {};
  const doneIds = new Set();
  for (const ch of currentDoc.chapters) {
    for (const b of ch.blocks) {
      if (b.translationStatus !== 'done') continue;
      doneIds.add(b.blockId);
      const raw = b.translationRaw ?? null;
      const plain = b.translation ?? null;
      const edited = b.editedHtml ?? null;
      const sig = _sessionSavedSig.get(b.blockId);
      if (sig && sig.raw === raw && sig.plain === plain && sig.edited === edited) continue;
      changedBlocks[b.blockId] = { raw, plain, edited };
    }
  }
  const removedBlockIds = [..._sessionSavedSig.keys()].filter((id) => !doneIds.has(id));
  const ok = await saveEpubSession(epubBookHash, {
    title: currentDoc.meta.title || '',
    glossary: Array.isArray(currentArticleGlossary) ? currentArticleGlossary : null,
    forbidden: currentBookForbidden,
    // 本文件額外翻譯指令（2026-07-27）：翻譯設定的一部分，隨 session 持久化
    extraPrompt: currentDocExtraPrompt || '',
    // 本書累計翻譯費用也是進度的一部分（2026-07-10 Jimmy 確認）
    costUSD: epubCumulativeCostUSD,
    // 一致性掃描的略過清單（2026-07-10）：人工 review 決策也是工作成果
    scanIgnored: [...epubScanIgnored.values()],
    scanIgnoredDrift: [...epubScanIgnoredDrift],
  }, { changedBlocks, removedBlockIds });
  if (ok) {
    for (const [id, rec] of Object.entries(changedBlocks)) _sessionSavedSig.set(id, rec);
    for (const id of removedBlockIds) _sessionSavedSig.delete(id);
  }
  // session 落地成功後清掉舊版 bookgloss_ key——session 已是單一資料源，
  // legacy key 留著只會在邊角把清空過的術語表復活
  if (ok) {
    const legacyKey = bookGlossStorageKey();
    if (legacyKey) {
      try { await chrome.storage.local.remove(legacyKey); } catch (_) { /* ignore */ }
    }
  }
}

let _sessionSaveTimer = null;
function scheduleEpubSessionSave() {
  if (_sessionSaveTimer) clearTimeout(_sessionSaveTimer);
  _sessionSaveTimer = setTimeout(() => {
    _sessionSaveTimer = null;
    persistEpubSession();
  }, 800);
}

// 排程中的 session 存檔立即落地（2026-07-10）：debounce 800ms 內按「重新上傳」/
// 換檔 / 關頁會讓最後一筆預覽編輯掉失。persistEpubSession 在首個 await 前同步
// 快照 currentDoc 資料，releaseCurrentDoc 隨後清 state 不影響已捕捉內容。
// 放棄本書翻譯不受影響——discardBookTranslation 自己先清 timer 才走清除流程
function flushPendingSessionSave() {
  if (!_sessionSaveTimer) return;
  clearTimeout(_sessionSaveTimer);
  _sessionSaveTimer = null;
  persistEpubSession();
}
// 關頁 / 分頁收合兜底（IndexedDB 寫入在 pagehide 屬 best-effort，
// 主要保險是 releaseCurrentDoc 的同步 flush）
window.addEventListener('pagehide', flushPendingSessionSave);

// 術語表儲存 = 整包 session 存檔（glossary 隨 session 走）
async function savePersistedBookGlossary(entries) {
  if (Array.isArray(entries)) currentArticleGlossary = entries;
  await persistEpubSession();
}

// ---------- 放棄本書翻譯 / 工作階段匯出匯入（2026-07-10）----------

// 放棄 = 清掉這本書「全部」work in progress（2026-07-10 Jimmy 修訂語意）：
// 翻譯進度（含手動編輯）+ 全書翻譯快取 + 累計費用 + 術語表 + 本書禁用詞 +
// session 紀錄（含舊版 bookgloss_ fallback key，否則重開檔案又載回術語表）+
// gloss_ 抽取輪快取（否則重開同書「先建立術語表」秒回快取，看似沒清乾淨）。
// 清完直接離開本頁回選取檔案畫面（同日 Jimmy 需求），in-memory 進度隨
// releaseCurrentDoc 一起丟。想留備份的使用者先按「匯出工作階段」——匯入即可整包還原
async function discardBookTranslation() {
  if (!currentDoc || currentDoc.kind !== 'epub') return;
  if (!confirm(t('doc.epub.confirm.discard'))) return;
  // 取消排隊中的 session 存檔，避免 timer 在清除的 await 空檔把 session 又寫回去
  if (_sessionSaveTimer) {
    clearTimeout(_sessionSaveTimer);
    _sessionSaveTimer = null;
  }
  await clearEpubBlocksCache(currentDoc.chapters, { all: true });
  await clearBookGlossaryExtractionCache(currentDoc);
  await deleteEpubSession(epubBookHash);
  const legacyKey = bookGlossStorageKey();
  if (legacyKey) {
    try { await chrome.storage.local.remove(legacyKey); } catch (_) { /* ignore */ }
  }
  releaseCurrentDoc();
  showStage('upload');
}

const SESSION_EXPORT_TYPE = 'shinkansen-epub-session';

function exportEpubSession() {
  if (!currentDoc || currentDoc.kind !== 'epub' || !epubBookHash) return;
  const data = {
    type: SESSION_EXPORT_TYPE,
    version: 1,
    bookHash: epubBookHash,
    title: currentDoc.meta.title || '',
    exportedAt: new Date().toISOString(),
    glossary: Array.isArray(currentArticleGlossary) ? currentArticleGlossary : null,
    forbidden: currentBookForbidden,
    // 本文件額外翻譯指令（2026-07-27）：翻譯設定隨匯出工作階段帶走；
    // 舊版匯入忽略未知欄位，向下相容
    extraPrompt: currentDocExtraPrompt || '',
    costUSD: epubCumulativeCostUSD,
    scanIgnored: [...epubScanIgnored.values()],
    scanIgnoredDrift: [...epubScanIgnoredDrift],
    blocks: collectSessionBlocks(currentDoc),
    // v2.0.52:失敗 block 診斷欄(blockId / 章節 / 錯誤訊息 / 原文)。匯入端不
    // hydrate(失敗是暫態);舊版匯入忽略未知欄位,向下相容
    failures: collectSessionFailures(currentDoc),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const baseName = (currentDoc.meta.filename || 'book').replace(/\.epub$/i, '');
  a.download = `${baseName}-session.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}

// 匯入 = 以檔案內容整包取代目前進度（先重置再 hydrate）。
// 書指紋必須吻合——blockId 由內容派生，跨書匯入只會得到垃圾對映
async function importEpubSession(file) {
  if (!currentDoc || currentDoc.kind !== 'epub') return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.type !== SESSION_EXPORT_TYPE || !data.blocks) {
      throw new Error(t('doc.epub.alert.importSessionInvalid'));
    }
    if (data.bookHash !== epubBookHash) {
      alert(t('doc.epub.alert.importSessionMismatch'));
      return;
    }
    for (const ch of currentDoc.chapters) {
      for (const b of ch.blocks) {
        b.translation = null;
        b.translationRaw = null;
        b.editedHtml = null;
        b.translationStatus = 'pending';
        b.translationError = null;
      }
    }
    const restored = hydrateSessionBlocks(currentDoc, data.blocks);
    if (Array.isArray(data.glossary)) currentArticleGlossary = data.glossary;
    if (Array.isArray(data.forbidden)) currentBookForbidden = data.forbidden;
    if (typeof data.extraPrompt === 'string') currentDocExtraPrompt = data.extraPrompt;
    if (Number.isFinite(data.costUSD)) epubCumulativeCostUSD = data.costUSD;
    epubScanIgnored = hydrateScanIgnored(Array.isArray(data.scanIgnored) ? data.scanIgnored : []);
    epubScanIgnoredDrift = new Set((Array.isArray(data.scanIgnoredDrift) ? data.scanIgnoredDrift : []).filter((x) => typeof x === 'string'));
    for (const ch of currentDoc.chapters) {
      if (chapterDoneState(ch) === 'done') ch.selected = false;
    }
    // 匯入 = 整包取代進度 → 舊掃描結果指向被取代的譯文，一併重置
    //（gen++ 讓 in-flight 掃描丟棄結果；renderChapterList 會刷新入口按鈕）
    epubScanGen++;
    epubScanState = null;
    await persistEpubSession();
    await renderChapterList();
    console.log('[Shinkansen] epub session imported:', { blocks: restored });
  } catch (err) {
    alert(t('doc.epub.alert.importSessionFail', { error: (err && err.message) || String(err) }));
  }
}

// 舊版 bookgloss_（chrome.storage.local）讀取 fallback——v2.0.11 dev 期寫過的
// 資料還讀得到；新寫入一律走 session（IndexedDB）
function bookGlossStorageKey() {
  return epubBookHash ? `bookgloss_${epubBookHash}` : null;
}

async function loadPersistedBookGlossary() {
  const key = bookGlossStorageKey();
  if (!key) return null;
  try {
    const got = await chrome.storage.local.get(key);
    const entry = got[key];
    return (entry && Array.isArray(entry.glossary)) ? entry.glossary : null;
  } catch (_) {
    return null;
  }
}

// ---------- 本書禁用詞（EPUB，2026-07-10）----------

function buildBookForbiddenTable(entries) {
  const grid = $('book-forbidden-grid');
  for (const el of [...grid.children]) {
    if (!el.classList.contains('g-header')) el.remove();
  }
  for (const e of entries || []) appendBookForbiddenRow(e);
}

function appendBookForbiddenRow(entry = { forbidden: '', replacement: '' }) {
  const grid = $('book-forbidden-grid');
  const forbiddenInput = document.createElement('input');
  forbiddenInput.type = 'text';
  forbiddenInput.className = 'bf-forbidden';
  forbiddenInput.value = entry.forbidden || '';
  const replacementInput = document.createElement('input');
  replacementInput.type = 'text';
  replacementInput.className = 'bf-replacement';
  replacementInput.value = entry.replacement || '';
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'glossary-row-delete';
  delBtn.textContent = t('doc.glossary.btn.delete');
  delBtn.addEventListener('click', () => {
    forbiddenInput.remove();
    replacementInput.remove();
    delBtn.remove();
  });
  grid.append(forbiddenInput, replacementInput, delBtn);
}

function readBookForbiddenTable() {
  const out = [];
  for (const forbiddenInput of $('book-forbidden-grid').querySelectorAll('.bf-forbidden')) {
    const forbidden = forbiddenInput.value.trim();
    if (!forbidden) continue;
    const replacementInput = forbiddenInput.nextElementSibling;
    const replacement = (replacementInput && replacementInput.classList.contains('bf-replacement'))
      ? replacementInput.value.trim() : '';
    out.push({ forbidden, replacement });
  }
  return out;
}
