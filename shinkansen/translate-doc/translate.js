// translate.js — 文件翻譯 pipeline 協調(W3 起)
//
// 職責：
//   1. 從版面 IR 收集所有「送翻譯」類 block(SPEC §17.4.4)
//   2. 切 chunk(預設 CHUNK_SIZE = 20，跟 content.js 對齊)
//   3. 逐 chunk 透過 chrome.runtime.sendMessage 送 background 的文件翻譯 handler
//      (Gemini = TRANSLATE_DOC_BATCH / custom provider = TRANSLATE_DOC_BATCH_CUSTOM)
//   4. 結果寫回 IR(每 block.translation / .translationStatus / .translationError)
//   5. 每完成一批 emit progress(SPEC §17.5.4 結構)
//
// 不在這裡：
//   - preset 選擇(由 caller 傳入 modelOverride)
//   - cache key blockType / fontSize 桶位(W3-iter2)
//   - 段落級 retry UI(W5)

// 跟 content.js 共用相同 chunk size，行為一致(rate limiter / token cost / cache 命中規則一致)
export const DOC_CHUNK_SIZE = 20;

// SPEC §17.4.4：這幾種 block type 送翻；其他(formula / table / figure / page-number) 不送
const TRANSLATABLE_TYPES = new Set(['paragraph', 'heading', 'list-item', 'caption', 'footnote']);

/**
 * 翻譯整份 layout doc，結果寫回每個 block。
 *
 * @param {LayoutDoc} doc                  — analyzeLayout 輸出
 * @param {object}    options
 * @param {string}    [options.modelOverride] — preset 對應的 Gemini model id
 * @param {Array}     [options.glossary]      — 額外術語表(可選)
 * @param {string}    [options.engine]        — 'gemini' | 'openai-compat'，預設 gemini
 * @param {AbortSignal} [options.signal]      — 取消信號
 * @param {(progress: TranslateProgress) => void} [options.onProgress]
 * @returns {Promise<TranslateSummary>}
 */
export async function translateDocument(doc, options = {}) {
  const { modelOverride, glossary, signal, onProgress = () => {}, engine = 'gemini' } = options;
  const startTime = Date.now();

  // 1) 收集所有需翻譯 block(扁平化，保 order 用 readingOrder + page)
  const queue = [];
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (TRANSLATABLE_TYPES.has(block.type) && block.plainText && block.plainText.trim().length > 0) {
        queue.push(block);
        block.translationStatus = 'pending';
        block.translation = null;
        block.translationError = null;
      }
    }
  }

  const totalBlocks = queue.length;
  let translatedBlocks = 0;
  let failedBlocks = 0;
  let cacheHits = 0;
  let cumulativeInputTokens = 0;
  let cumulativeOutputTokens = 0;
  let cumulativeCostUSD = 0;
  const batchTimes = [];

  console.log('[Shinkansen] translateDocument start', {
    filename: doc.meta?.filename,
    totalBlocks,
    chunks: Math.ceil(totalBlocks / DOC_CHUNK_SIZE),
    chunkSize: DOC_CHUNK_SIZE,
    modelOverride: modelOverride || '(default)',
    pages: doc.pages.length,
  });

  emit();

  // 2) 切 chunk 逐批送
  for (let start = 0; start < queue.length; start += DOC_CHUNK_SIZE) {
    if (signal?.aborted) {
      // 標 cancelled，剩下 block 保留 pending(UI 顯示原文)
      for (let j = start; j < queue.length; j++) {
        queue[j].translationStatus = 'cancelled';
      }
      break;
    }

    const chunk = queue.slice(start, start + DOC_CHUNK_SIZE);
    // W7:送 LLM 的文字含 inline style marker(⟦b⟧/⟦i⟧/⟦l:N⟧)。fallback:
    // 沒 styleSegments 的 block(舊 fixture / parser 失敗等)用 plainText。
    const texts = chunk.map((b) => buildMarkedText(b));

    chunk.forEach((b) => { b.translationStatus = 'translating'; });
    emit();

    const t0 = Date.now();
    let response;
    try {
      const messageType = engine === 'openai-compat' ? 'TRANSLATE_DOC_BATCH_CUSTOM' : 'TRANSLATE_DOC_BATCH';
      response = await chrome.runtime.sendMessage({
        type: messageType,
        payload: { texts, modelOverride, glossary, preferArticleGlossary: true },
      });
    } catch (err) {
      // background 完全沒回應(extension reload / service worker crash 等)
      const msg = (err && err.message) || String(err);
      chunk.forEach((b) => {
        b.translationStatus = 'failed';
        b.translationError = msg;
      });
      failedBlocks += chunk.length;
      translatedBlocks += chunk.length;
      emit();
      continue;
    }
    batchTimes.push(Date.now() - t0);

    if (!response || !Array.isArray(response.result)) {
      // background handler 拋了(API key 缺 / Gemini 回 error 等)
      const msg = (response && response.error) || 'no response';
      chunk.forEach((b) => {
        b.translationStatus = 'failed';
        b.translationError = msg;
      });
      failedBlocks += chunk.length;
      translatedBlocks += chunk.length;
      emit();
      continue;
    }

    const usage = response.usage || {};
    cumulativeInputTokens += usage.billedInputTokens || usage.inputTokens || 0;
    cumulativeOutputTokens += usage.outputTokens || 0;
    cumulativeCostUSD += usage.billedCostUSD || usage.costUSD || 0;
    cacheHits += usage.cacheHits || 0;
    console.log('[Shinkansen] chunk done', {
      chunkStart: start,
      chunkSize: chunk.length,
      batchMs: Date.now() - t0,
      usage: {
        billedInputTokens: usage.billedInputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        cacheHits: usage.cacheHits || 0,
        billedCostUSD: Number((usage.billedCostUSD || 0).toFixed(6)),
      },
    });

    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      const tr = response.result[i];
      if (typeof tr === 'string' && tr.length > 0) {
        // W7:譯文 parse 出 inline segments,寫回 block.translationSegments。
        // parser 失敗(marker 對不齊)會 fallback 整段 plain regular,不破渲染。
        // block.translation 保留為「parser 還原後的純文字」(複製譯文用),
        // 不留 marker(避免使用者複製到帶 ⟦…⟧ 標記)
        const parsed = parseMarkedTranslation(tr, b.linkUrls || []);
        b.translationSegments = parsed.segments;
        b.translation = parsed.plainText;
        b.translationStatus = 'done';
      } else {
        b.translation = null;
        b.translationSegments = null;
        b.translationStatus = 'failed';
        b.translationError = 'empty translation';
        failedBlocks++;
      }
      translatedBlocks++;
    }
    emit();
  }


  const durationMs = Date.now() - startTime;

  console.log('[Shinkansen] translateDocument done', {
    totalBlocks,
    translatedBlocks,
    failedBlocks,
    cacheHits,
    cumulativeInputTokens,
    cumulativeOutputTokens,
    cumulativeCostUSD: Number(cumulativeCostUSD.toFixed(6)),
    durationMs,
    cancelled: !!signal?.aborted,
  });

  // 用量寫進「用量紀錄」(IndexedDB，跟網頁翻譯共用 LOG_USAGE handler)
  // 全 cache hit 場景 background 端 shouldSkipUsageRecord 會自動跳過，不污染列表
  try {
    const filename = (doc.meta && doc.meta.filename) || 'unknown.pdf';
    await chrome.runtime.sendMessage({
      type: 'LOG_USAGE',
      payload: {
        url: `pdf://${filename}`,
        title: filename,
        inputTokens: cumulativeInputTokens,
        outputTokens: cumulativeOutputTokens,
        cachedTokens: 0,
        billedInputTokens: cumulativeInputTokens,
        billedCostUSD: cumulativeCostUSD,
        segments: totalBlocks,
        cacheHits,
        durationMs,
        timestamp: Date.now(),
        engine: engine || 'gemini',
        model: modelOverride || null,
        source: 'translate-doc',
      },
    });
  } catch (err) {
    console.warn('[Shinkansen] LOG_USAGE 失敗', err && err.message);
  }

  return {
    totalBlocks,
    translatedBlocks,
    failedBlocks,
    cacheHits,
    cumulativeInputTokens,
    cumulativeOutputTokens,
    cumulativeCostUSD,
    durationMs,
    cancelled: !!signal?.aborted,
  };

  // ---- helpers ----

  function emit() {
    const avgBatchMs = batchTimes.length > 0
      ? batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length
      : 0;
    const remainingChunks = Math.max(0, Math.ceil((totalBlocks - translatedBlocks) / DOC_CHUNK_SIZE));
    const estimatedRemainingSec = avgBatchMs > 0
      ? Math.round((remainingChunks * avgBatchMs) / 1000)
      : 0;
    onProgress({
      totalBlocks,
      translatedBlocks,
      failedBlocks,
      estimatedRemainingSec,
      cumulativeInputTokens,
      cumulativeOutputTokens,
      cumulativeCostUSD,
    });
  }
}

/**
 * 重新翻譯單一 block(W5 段落級 retry)。
 *
 * @param {LayoutBlock} block — 要重翻的 block，結果會寫回 block.translation / .translationStatus
 * @param {object} options
 * @param {string} [options.modelOverride]
 * @param {Array}  [options.glossary]
 * @param {string} [options.engine]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function translateSingleBlock(block, options = {}) {
  const { modelOverride, glossary, engine = 'gemini' } = options;
  if (!block || !block.plainText) return { ok: false, error: 'no plainText' };

  console.log('[Shinkansen] retry block', block.blockId, 'modelOverride=', modelOverride || '(default)');

  block.translationStatus = 'translating';
  block.translationError = null;
  const startTime = Date.now();

  let response;
  try {
    const messageType = engine === 'openai-compat' ? 'TRANSLATE_DOC_BATCH_CUSTOM' : 'TRANSLATE_DOC_BATCH';
    response = await chrome.runtime.sendMessage({
      type: messageType,
      payload: { texts: [buildMarkedText(block)], modelOverride, glossary, preferArticleGlossary: true },
    });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    block.translationStatus = 'failed';
    block.translationError = msg;
    console.warn('[Shinkansen] retry sendMessage 失敗', block.blockId, msg);
    return { ok: false, error: msg };
  }

  if (!response || !Array.isArray(response.result) || response.result.length === 0) {
    const msg = (response && response.error) || 'no response';
    block.translationStatus = 'failed';
    block.translationError = msg;
    console.warn('[Shinkansen] retry response 異常', block.blockId, msg);
    return { ok: false, error: msg };
  }

  // 用量寫進紀錄(retry 通常很小，但仍計入)
  const usage = response.usage || {};
  try {
    await chrome.runtime.sendMessage({
      type: 'LOG_USAGE',
      payload: {
        url: 'pdf://retry',
        title: `(retry ${block.blockId})`,
        inputTokens: usage.billedInputTokens || usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        cachedTokens: 0,
        billedInputTokens: usage.billedInputTokens || 0,
        billedCostUSD: usage.billedCostUSD || 0,
        segments: 1,
        cacheHits: usage.cacheHits || 0,
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
        engine: engine || 'gemini',
        model: modelOverride || null,
        source: 'translate-doc-retry',
      },
    });
  } catch (_) { /* swallow */ }

  const tr = response.result[0];
  if (typeof tr === 'string' && tr.length > 0) {
    const parsed = parseMarkedTranslation(tr, block.linkUrls || []);
    block.translationSegments = parsed.segments;
    block.translation = parsed.plainText;
    block.translationStatus = 'done';
    block.translationError = null;
    console.log('[Shinkansen] retry block done', block.blockId, 'tr=', parsed.plainText.slice(0, 40));
    return { ok: true };
  } else {
    block.translation = null;
    block.translationSegments = null;
    block.translationStatus = 'failed';
    block.translationError = 'empty translation';
    console.warn('[Shinkansen] retry empty translation', block.blockId);
    return { ok: false, error: 'empty translation' };
  }
}

// ============================================================================
// W7 inline rich text marker 協定
// ============================================================================
//
// marker 設計(沿用既有段落佔位符 ⟦…⟧ 格式,LLM 已熟悉):
//   ⟦b⟧粗體段⟦/b⟧
//   ⟦i⟧斜體段⟦/i⟧
//   ⟦l:N⟧連結文字⟦/l⟧   N = block.linkUrls 內的 1-based index
//
// 巢狀順序(由外到內):bold → italic → link
// 例:**Editor's Note:** *Go to [Plano.gov](url) for ...*
// →  ⟦b⟧Editor's Note:⟦/b⟧ ⟦i⟧Go to ⟦l:1⟧Plano.gov⟦/l⟧ for ...⟦/i⟧
//
// link 在最內層的理由:link 是錨點,跨樣式邊界比連續性重要;bold/italic 純樣式
// 可被 wrap 邏輯切散。
//
// parser 失敗策略:tag 不成對 / 巢狀錯誤 / link index 越界 → 整 block 退回 plain
// regular(translationSegments 為單一 piece),不破渲染。

const MARKER_TAG_RE = /⟦(?:b|i|l:\d+|\/b|\/i|\/l)⟧/g;

/**
 * 從 block.styleSegments 構出帶 marker 的字串送 LLM。
 * 沒 styleSegments 的 block(舊資料 / fallback)直接回傳 plainText。
 *
 * @param {LayoutBlock} block
 * @returns {string}
 */
export function buildMarkedText(block) {
  if (!block) return '';
  const segs = block.styleSegments;
  const linkUrls = block.linkUrls || [];
  if (!Array.isArray(segs) || segs.length === 0) {
    return block.plainText || '';
  }
  let out = '';
  for (const s of segs) {
    let t = s.text;
    if (s.linkUrl) {
      const idx = linkUrls.indexOf(s.linkUrl) + 1;
      if (idx > 0) t = `⟦l:${idx}⟧${t}⟦/l⟧`;
    }
    if (s.isItalic) t = `⟦i⟧${t}⟦/i⟧`;
    if (s.isBold) t = `⟦b⟧${t}⟦/b⟧`;
    out += t;
  }
  return out;
}

/**
 * 解 LLM 回的 marker 字串成 segments 陣列 + 純文字。
 * 走簡化 stack 解法:遇 ⟦b⟧/⟦i⟧/⟦l:N⟧ push、遇 ⟦/b⟧/⟦/i⟧/⟦/l⟧ pop。
 * 任一錯誤(tag 不成對 / link 編號越界)→ fallback 整段 plain regular。
 *
 * @param {string}   text
 * @param {string[]} linkUrls — 對應 block.linkUrls
 * @returns {{ segments: StyleSegment[], plainText: string }}
 */
export function parseMarkedTranslation(text, linkUrls) {
  const fallback = () => {
    const cleaned = (text || '').replace(MARKER_TAG_RE, '');
    return {
      segments: [{ text: cleaned, isBold: false, isItalic: false, linkUrl: null }],
      plainText: cleaned,
    };
  };
  if (typeof text !== 'string' || text.length === 0) {
    return { segments: [], plainText: '' };
  }

  const stack = []; // entries: 'b' | 'i' | { type: 'l', url }
  const segments = [];
  const tagRe = /⟦(\/?[bi]|l:(\d+)|\/l)⟧/g;
  let lastIndex = 0;

  function flushPlain(plain) {
    if (!plain) return;
    let isBold = false, isItalic = false, linkUrl = null;
    for (const e of stack) {
      if (e === 'b') isBold = true;
      else if (e === 'i') isItalic = true;
      else if (e && e.type === 'l') linkUrl = e.url;
    }
    // 同 style 連續 segment 合一(LLM 譯文可能在同 style 內多次切 segment)
    const last = segments[segments.length - 1];
    if (last && last.isBold === isBold && last.isItalic === isItalic && last.linkUrl === linkUrl) {
      last.text += plain;
    } else {
      segments.push({ text: plain, isBold, isItalic, linkUrl });
    }
  }

  let m;
  while ((m = tagRe.exec(text)) !== null) {
    const plain = text.slice(lastIndex, m.index);
    flushPlain(plain);
    lastIndex = tagRe.lastIndex;
    const tag = m[1];
    if (tag === 'b' || tag === 'i') {
      stack.push(tag);
    } else if (tag === '/b' || tag === '/i') {
      const want = tag === '/b' ? 'b' : 'i';
      const top = stack[stack.length - 1];
      if (top !== want) return fallback();
      stack.pop();
    } else if (m[2] !== undefined) {
      // ⟦l:N⟧
      const idx = parseInt(m[2], 10) - 1;
      if (idx < 0 || idx >= linkUrls.length) return fallback();
      stack.push({ type: 'l', url: linkUrls[idx] });
    } else if (tag === '/l') {
      const top = stack[stack.length - 1];
      if (!top || top.type !== 'l') return fallback();
      stack.pop();
    }
  }
  flushPlain(text.slice(lastIndex));
  if (stack.length !== 0) return fallback();

  return {
    segments,
    plainText: segments.map((s) => s.text).join(''),
  };
}

// ============================================================================
// v1.8.49 譯文編輯頁:markdown ⇄ segments 互轉
// ============================================================================
//
// 給編輯頁(stage-edit)使用的輕量 markdown 協定,跟 LLM 用的 ⟦…⟧ marker 區分:
//   **粗體**          → segment.isBold = true
//   *斜體*            → segment.isItalic = true
//   [連結文字](url)   → segment.linkUrl = url
//
// 為什麼不直接重用 ⟦b⟧/⟦i⟧/⟦l:N⟧:那組是 LLM 友善的字面 marker,讓 user 直接看
// 到很怪。markdown 直觀,user 改完一目了然。轉換點只有「載入編輯頁」與「儲存」
// 兩處,segments 仍是 block 內部的 source of truth,renderer / cache 邏輯不動。
//
// 不支援 escape:user 譯文裡放字面 `**` / `*` / `[]()` 會被當成 markdown 解析。
// 編輯頁底部 hint 會說明這個限制(MVP 取捨)。
// 巢狀:bold > italic > link(對齊 buildMarkedText / parseMarkedTranslation 設計)。
// 解析失敗一律 fallback 整段 plain regular,不 throw。

/**
 * Block.translationSegments → markdown 字串供編輯頁 textarea 顯示。
 * @param {Array<{text:string, isBold:boolean, isItalic:boolean, linkUrl:string|null}>} segments
 * @returns {string}
 */
export function segmentsToMarkdown(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return '';
  return segments.map((s) => {
    let t = s.text || '';
    if (s.linkUrl) t = `[${t}](${s.linkUrl})`;
    if (s.isItalic) t = `*${t}*`;
    if (s.isBold) t = `**${t}**`;
    return t;
  }).join('');
}

/**
 * 編輯頁 markdown → segments 陣列。失敗(罕見)fallback 整段 plain regular,不 throw。
 * @param {string} text
 * @returns {{ segments: Array<{text:string, isBold:boolean, isItalic:boolean, linkUrl:string|null}>, linkUrls: string[] }}
 */
export function markdownToSegments(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { segments: [], linkUrls: [] };
  }
  const segments = [];
  const linkUrls = [];
  let isBold = false;
  let isItalic = false;
  let buffer = '';
  let i = 0;

  function pushSeg(t, b, ital, url) {
    if (!t) return;
    const last = segments[segments.length - 1];
    if (last && last.isBold === b && last.isItalic === ital && last.linkUrl === url) {
      last.text += t;
    } else {
      segments.push({ text: t, isBold: b, isItalic: ital, linkUrl: url });
    }
  }
  function flush() {
    if (buffer.length === 0) return;
    pushSeg(buffer, isBold, isItalic, null);
    buffer = '';
  }

  while (i < text.length) {
    if (text.slice(i, i + 2) === '**') {
      flush();
      isBold = !isBold;
      i += 2;
      continue;
    }
    if (text[i] === '*') {
      flush();
      isItalic = !isItalic;
      i += 1;
      continue;
    }
    if (text[i] === '[') {
      const close = text.indexOf(']', i + 1);
      if (close > i && text[close + 1] === '(') {
        const closeP = text.indexOf(')', close + 2);
        if (closeP > close + 1) {
          flush();
          const linkText = text.slice(i + 1, close);
          const url = text.slice(close + 2, closeP);
          pushSeg(linkText, isBold, isItalic, url);
          if (!linkUrls.includes(url)) linkUrls.push(url);
          i = closeP + 1;
          continue;
        }
      }
    }
    buffer += text[i];
    i += 1;
  }
  flush();
  return { segments, linkUrls };
}

/**
 * @typedef {Object} TranslateProgress
 * @property {number} totalBlocks
 * @property {number} translatedBlocks
 * @property {number} failedBlocks
 * @property {number} estimatedRemainingSec
 * @property {number} cumulativeInputTokens
 * @property {number} cumulativeOutputTokens
 * @property {number} cumulativeCostUSD
 *
 * @typedef {Object} TranslateSummary
 * @property {number} totalBlocks
 * @property {number} translatedBlocks
 * @property {number} failedBlocks
 * @property {number} cumulativeInputTokens
 * @property {number} cumulativeOutputTokens
 * @property {number} cumulativeCostUSD
 * @property {boolean} cancelled
 */
