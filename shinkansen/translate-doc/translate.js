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

import { TRANSLATABLE_TYPES } from './block-types.js';
import { normalizeNameSeparators } from './epub-engine.js';
import { getSettings } from '../lib/storage.js';
import { detectOutputLangMismatch as detectDocBatchLangMismatch } from '../lib/system-instruction.js';

// 背景端錯誤的本地化（error code 協定，lib/bg-error.js）。lib/i18n.js 由 index.html
// <script src> 載入 attach 到 window.__SK.i18n；還沒載入（init race）或沒帶 code 的
// 錯誤 fallback 原字串原樣顯示
const bgErrMsg = (response) => {
  const i18n = window.__SK?.i18n;
  if (i18n && typeof i18n.bgErrorMessage === 'function') return i18n.bgErrorMessage(response);
  return (response && response.error) || '';
};

// 跟 content.js 共用相同 chunk size，行為一致(token cost / cache 命中規則一致)
export const DOC_CHUNK_SIZE = 20;

// ── batch 級輸出語言驗證（v2.0.52）──────────────────────────────
// 實作下沉到 lib/system-instruction.js detectOutputLangMismatch（單一資料源：
// gemini.js / openai-compat.js 的 chunk 層 per-segment fallback 判定共用同一條）。
// 本檔的 batch 級檢查是最後防線——chunk 層 fallback 正常情況下已自動治癒，
// 這裡攔到代表逐段 fallback 也翻錯，才標整批 failed。
export { detectOutputLangMismatch as detectDocBatchLangMismatch } from '../lib/system-instruction.js';

async function sha1Hex(text) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 清指定送翻文字的 tc_ 譯文快取（prefix 比對掃掉所有 suffix 變體，同
// index.js clearEpubBlocksCache 的思路；背景以送翻文字本身算 cache key）。
// 語言驗證重試前必清——錯譯已被 background 寫進快取，不清會秒回同一批錯譯
export async function clearTcCacheForTexts(texts) {
  const prefixes = new Set(await Promise.all(
    (texts || []).filter(Boolean).map(async (t) => 'tc_' + (await sha1Hex(t))),
  ));
  if (prefixes.size === 0) return 0;
  const allKeys = (typeof chrome.storage.local.getKeys === 'function')
    ? await chrome.storage.local.getKeys()
    : Object.keys(await chrome.storage.local.get(null));
  const matched = allKeys.filter((k) => k.startsWith('tc_') && prefixes.has(k.slice(0, 43)));
  if (matched.length > 0) await chrome.storage.local.remove(matched);
  return matched.length;
}

/**
 * 文章術語表的輸入取樣:按 reading order 收 translatable block 的 plainText,
 * 累計達 maxChars 截斷。給 index.js extractGlossaryForDoc 用(抽出來可 unit 測)。
 *
 * 邊界:acc 含 join('\n') 分隔符預算(+1),可以超過 maxChars——所以剩餘空間用
 * `room = maxChars - acc` 算且 room <= 0 直接停,不可用 `t.slice(0, maxChars - acc)`
 * (負值 slice 會變成「整塊只去尾字元」,預算直接吹破)
 *
 * @param {LayoutDoc} doc
 * @param {number}    maxChars
 * @param {(page) => boolean} [pageFilter] — 只從回 true 的頁取樣（PDF 翻譯頁數範圍）
 * @returns {string[]} parts — caller 自行 join('\n')
 */
export function collectGlossaryInputParts(doc, maxChars, pageFilter = null) {
  const parts = [];
  let acc = 0;
  for (const page of doc.pages) {
    // pageFilter：PDF 翻譯頁數範圍（index.js pageInCurrentRange）。省略 = 全份取樣
    if (pageFilter && !pageFilter(page)) continue;
    for (const b of page.blocks) {
      if (!TRANSLATABLE_TYPES.has(b.type)) continue;
      const t = b.plainText && b.plainText.trim();
      if (!t) continue;
      const room = maxChars - acc;
      if (room <= 0) break;
      if (t.length > room) {
        parts.push(t.slice(0, room));
        acc = maxChars;
        break;
      }
      parts.push(t);
      acc += t.length + 1; // +1 = join('\n') 分隔符預算
    }
    if (acc >= maxChars) break;
  }
  return parts;
}

/**
 * 翻譯整份 layout doc，結果寫回每個 block。
 *
 * @param {LayoutDoc} doc                  — analyzeLayout 輸出
 * @param {object}    options
 * @param {string}    [options.modelOverride] — preset 對應的 Gemini model id
 * @param {Array}     [options.glossary]      — 額外術語表(可選)
 * @param {string}    [options.engine]        — 'gemini' | 'openai-compat'，預設 gemini
 * @param {AbortSignal} [options.signal]      — 取消信號
 * @param {(block, page) => boolean} [options.blockFilter] — EPUB 章節選翻：回 false 的
 *   block 完全不動（不重設狀態、不送翻）。續翻時用它跳過未勾選章節與已 done 的 block
 * @param {boolean}   [options.filterGlossary] — EPUB 全書術語表批次級過濾：每批只注入
 *   該批原文實際出現的條目（全書數百條全量注入太燒 token；substring 過濾是確定性
 *   動作，不影響譯名一致性——glossary 本身在翻譯前已鎖定）
 * @param {(progress: TranslateProgress) => void} [options.onProgress]
 * @returns {Promise<TranslateSummary>}
 */
export async function translateDocument(doc, options = {}) {
  const {
    modelOverride, glossary, signal, onProgress = () => {}, engine = 'gemini',
    blockFilter, filterGlossary,
    // EPUB 本書獨立禁用詞（2026-07-10）：background 與 options 共通清單合併注入
    extraForbiddenTerms = null,
    // 本文件額外翻譯指令（2026-07-27）：background 附加在 translateDoc.systemPrompt
    // 之後（inline marker 協定之前），並以 _x hash 進 cache key
    extraPrompt = null,
    // 每批段數（2026-07-10）：settings.translateDoc.batchSize（預設 50）。
    // 同一值也隨 payload.docBatchSize 送 background 覆蓋 maxUnitsPerBatch，
    // 讓「一批」= 一次 API 請求（否則 adapter 端仍按預設 20 重切）
    batchSize = null,
  } = options;
  const chunkSize = (Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 100)
    ? batchSize : DOC_CHUNK_SIZE;
  // v1.9.6: Google MT 沒 doc handler（沒 batch-aware marker / glossary 注入機制），
  // 早期擋 + throw，避免 silent fall-through 跑 Gemini 用錯 key / 錯 model。
  // UI 層（index.js startTranslate）會在更早攔下並顯示提示，這裡是防禦深度。
  if (engine === 'google') {
    throw new Error('translate-doc: Google Translate engine 不支援文件翻譯');
  }
  const startTime = Date.now();

  // v2.0.52:batch 級輸出語言驗證用（detectDocBatchLangMismatch）。
  // fail-open:語言驗證是附加防線,設定讀取失敗(單元測試 mock 只給 runtime、
  // 極端 storage 錯誤)時 fallback 預設 target,絕不讓驗證功能弄掛翻譯主流程
  let targetLanguage = 'zh-TW';
  try {
    targetLanguage = (await getSettings()).targetLanguage || 'zh-TW';
  } catch (_) { /* fallback 預設 */ }

  // 1) 收集所有需翻譯 block(扁平化，保 order 用 readingOrder + page)
  const queue = [];
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (TRANSLATABLE_TYPES.has(block.type) && block.plainText && block.plainText.trim().length > 0) {
        if (blockFilter && !blockFilter(block, page)) continue;
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
  // raw 與 billed 分開累計:raw(inputTokens)是對帳 Google 帳單時看 cache 折扣
  // 幅度的分母,billed 是折扣後實際計費 token。混寫會讓「inputTokens vs
  // billedInputTokens 差距」維度永遠歸零
  let cumulativeInputTokens = 0;
  let cumulativeBilledInputTokens = 0;
  let cumulativeOutputTokens = 0;
  let cumulativeCostUSD = 0;
  const batchTimes = [];

  console.log('[Shinkansen] translateDocument start', {
    filename: doc.meta?.filename,
    totalBlocks,
    chunks: Math.ceil(totalBlocks / chunkSize),
    chunkSize,
    modelOverride: modelOverride || '(default)',
    pages: doc.pages.length,
  });

  emit();

  const messageType = engine === 'openai-compat' ? 'TRANSLATE_DOC_BATCH_CUSTOM' : 'TRANSLATE_DOC_BATCH';

  const accountUsage = (usage = {}) => {
    // `??` 而非 `||`:billedInputTokens === 0(全 cache hit / 全免費)是合法值,
    // `||` 會 fallback 到另一邊,語意相反
    cumulativeInputTokens += usage.inputTokens ?? usage.billedInputTokens ?? 0;
    cumulativeBilledInputTokens += usage.billedInputTokens ?? usage.inputTokens ?? 0;
    cumulativeOutputTokens += usage.outputTokens ?? 0;
    cumulativeCostUSD += usage.billedCostUSD ?? usage.costUSD ?? 0;
    cacheHits += usage.cacheHits || 0;
  };

  const markBlocksFailed = (blocks, msg) => {
    blocks.forEach((b) => {
      b.translationStatus = 'failed';
      b.translationError = msg;
    });
    failedBlocks += blocks.length;
    translatedBlocks += blocks.length;
    emit();
  };

  const applyBlockResults = (blocks, result) => {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      // LLM 協定殘片修復(v2.0.53):畸形佔位符(⟦/2»)+ 段尾分隔符殘片——進 raw
      // 前先修,快取命中回同一字串也走這裡,舊的壞快取自動治癒不需清快取。
      // 再對齊句尾句號(原文沒有終止標點時刪掉模型自補的「。」)
      const tr = typeof result[i] === 'string'
        ? alignTrailingPeriodWithSource(b.plainText, repairDocLlmArtifacts(result[i]))
        : result[i];
      if (typeof tr === 'string' && tr.length > 0) {
        // EPUB block：原始譯文（含 ⟦N⟧ 佔位符）留給 epub-writer 反序列化；
        // translation 欄位存去除標記後的純文字（預覽 / 複製用）
        if (b.epubSerializedText != null) {
          // 人名間隔號正規化（CJK·CJK → CJK・CJK，2026-07-10）——確定性保證，
          // 不靠 LLM 服從；也讓 dedupe 的 target 比對兩端形式一致
          const norm = normalizeNameSeparators(tr);
          b.translationRaw = norm;
          b.translation = stripPlaceholderTokens(norm);
          b.editedHtml = null; // 重翻覆蓋預覽頁的手動編輯（UI 有提示）
          b.translationStatus = 'done';
          translatedBlocks++;
          continue;
        }
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
  };

  // 對切重試(v2.0.53)可救的錯誤碼——縮小批次有機會通過的類型:
  //   - timeout / readTimeout:輸出量隨批次減半,更容易在時限內完成
  //   - blocked / empty*(含 PROHIBITED_CONTENT 走 emptyContent):Google 過濾器
  //     通常只被批內一兩段觸發,對切能把觸發段隔離、救回其餘段
  //   - emptyMaxTokens:輸出砍半自然低於上限
  // 不對切的類型:apiKeyMissing / baseUrlMissing / rpd 配額 / network(斷線)/
  // badResponse——縮批也不會好,對切只會把一次失敗放大成 2N-1 次請求雪崩。
  // sendMessage 直接 throw(extension reload / SW crash)同理不對切
  const BISECTABLE_CODES = new Set([
    'timeout', 'readTimeout',
    'blocked', 'emptyContent', 'emptySafety', 'emptyRecitation', 'emptyMaxTokens', 'emptyOther',
    'customEmptyContent',
  ]);

  // 一個 sub-chunk 的完整生命週期:送翻 → 失敗時視錯誤碼對切遞迴(深度自然收斂:
  // 長度 1 不可再切)→ 語言驗證 → 寫回。遞迴上限 log2(chunkSize) ≤ 7
  async function translateSubChunk(blocks, depth) {
    if (signal?.aborted) {
      blocks.forEach((b) => { b.translationStatus = 'cancelled'; });
      emit();
      return;
    }
    // W7:送 LLM 的文字含 inline style marker(⟦b⟧/⟦i⟧/⟦l:N⟧)。fallback:
    // 沒 styleSegments 的 block(舊 fixture / parser 失敗等)用 plainText。
    const texts = blocks.map((b) => buildMarkedText(b));
    blocks.forEach((b) => { b.translationStatus = 'translating'; });
    emit();

    // EPUB 全書術語表批次級過濾（見 options doc）；PDF 路徑不帶 filterGlossary，
    // 行為不變（整份 glossary 每批注入）
    const chunkGlossary = filterGlossary
      ? filterGlossaryForTexts(glossary, texts)
      : glossary;
    const payload = { texts, modelOverride, glossary: chunkGlossary, preferArticleGlossary: true, extraForbiddenTerms, docBatchSize: chunkSize, extraPrompt };

    const t0 = Date.now();
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: messageType, payload });
    } catch (err) {
      // background 完全沒回應(extension reload / service worker crash 等)
      markBlocksFailed(blocks, (err && err.message) || String(err));
      return;
    }
    batchTimes.push(Date.now() - t0);

    if (!response || !Array.isArray(response.result)) {
      // background handler 拋了(API key 缺 / Gemini 回 error 等)
      const code = response && response.errorCode;
      if (blocks.length >= 2 && BISECTABLE_CODES.has(code)) {
        console.warn('[Shinkansen] chunk failed — bisect retry', { code, size: blocks.length, depth });
        const mid = Math.ceil(blocks.length / 2);
        await translateSubChunk(blocks.slice(0, mid), depth + 1);
        await translateSubChunk(blocks.slice(mid), depth + 1);
        return;
      }
      markBlocksFailed(blocks, bgErrMsg(response) || 'no response');
      return;
    }
    accountUsage(response.usage);

    // v2.0.52:batch 級輸出語言驗證 + 單次重試。模型偶發把整批翻成原文語言
    //(實例:日文書某批「譯文」是日文改寫,下一批正常),且錯譯已被 background
    // 寫進 tc_ 快取——不清快取直接重送會秒回同一批錯譯,所以重試前先清該批
    // tc_。重試仍錯就標整批 failed(再清一次快取,讓使用者手動重翻直接打 API),
    // 不無限重試也不對切——維持該批最壞成本上限 = 2 次 API 呼叫
    if (detectDocBatchLangMismatch(response.result, targetLanguage)) {
      console.warn('[Shinkansen] chunk output language mismatch, retrying once', { size: blocks.length, targetLanguage });
      await clearTcCacheForTexts(texts);
      let retryResp = null;
      try {
        retryResp = await chrome.runtime.sendMessage({ type: messageType, payload });
      } catch { retryResp = null; }
      if (retryResp && Array.isArray(retryResp.result)) accountUsage(retryResp.usage);
      if (retryResp && Array.isArray(retryResp.result)
          && !detectDocBatchLangMismatch(retryResp.result, targetLanguage)) {
        response = retryResp;
      } else {
        await clearTcCacheForTexts(texts);
        const i18n = window.__SK?.i18n;
        markBlocksFailed(blocks, (i18n && typeof i18n.t === 'function')
          ? i18n.t('doc.translate.outputLangMismatch')
          : 'output language does not match target language');
        return;
      }
    }

    const usage = response.usage || {};
    console.log('[Shinkansen] chunk done', {
      chunkSize: blocks.length,
      depth,
      batchMs: Date.now() - t0,
      usage: {
        billedInputTokens: usage.billedInputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        cacheHits: usage.cacheHits || 0,
        billedCostUSD: Number((usage.billedCostUSD || 0).toFixed(6)),
      },
    });

    applyBlockResults(blocks, response.result);
  }

  // 2) 切 chunk 逐批送
  for (let start = 0; start < queue.length; start += chunkSize) {
    if (signal?.aborted) {
      // 標 cancelled，剩下 block 保留 pending(UI 顯示原文)
      for (let j = start; j < queue.length; j++) {
        queue[j].translationStatus = 'cancelled';
      }
      break;
    }
    await translateSubChunk(queue.slice(start, start + chunkSize), 0);
  }


  const durationMs = Date.now() - startTime;

  console.log('[Shinkansen] translateDocument done', {
    totalBlocks,
    translatedBlocks,
    failedBlocks,
    cacheHits,
    cumulativeInputTokens,
    cumulativeBilledInputTokens,
    cumulativeOutputTokens,
    cumulativeCostUSD: Number(cumulativeCostUSD.toFixed(6)),
    durationMs,
    cancelled: !!signal?.aborted,
  });

  // 用量寫進「用量紀錄」(IndexedDB，跟網頁翻譯共用 LOG_USAGE handler)
  // 全 cache hit 場景 background 端 shouldSkipUsageRecord 會自動跳過，不污染列表
  try {
    const filename = (doc.meta && doc.meta.filename) || 'unknown.pdf';
    // 書籍式文件（epub / txt / md / html / subtitle）以 kind 當 scheme,PDF 與未知維持 pdf
    const urlScheme = ['epub', 'txt', 'md', 'html', 'subtitle'].includes(doc.kind) ? doc.kind : 'pdf';
    await chrome.runtime.sendMessage({
      type: 'LOG_USAGE',
      payload: {
        url: `${urlScheme}://${filename}`,
        title: filename,
        inputTokens: cumulativeInputTokens,
        outputTokens: cumulativeOutputTokens,
        cachedTokens: 0,
        billedInputTokens: cumulativeBilledInputTokens,
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
    cumulativeBilledInputTokens,
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
    const remainingChunks = Math.max(0, Math.ceil((totalBlocks - translatedBlocks) / chunkSize));
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
  const { modelOverride, glossary, engine = 'gemini', extraPrompt = null } = options;
  // v1.9.6: Google MT 不支援文件翻譯，retry 路徑同步擋（理論上 UI 層已先擋掉走不到這，
  // 但 currentEngine 是 module state，測試 / 程式錯誤造成 stale 時這裡是最後守門）
  if (engine === 'google') {
    return { ok: false, error: 'translate-doc: Google Translate engine 不支援文件翻譯' };
  }
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
      payload: { texts: [buildMarkedText(block)], modelOverride, glossary, preferArticleGlossary: true, extraPrompt },
    });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    block.translationStatus = 'failed';
    block.translationError = msg;
    console.warn('[Shinkansen] retry sendMessage 失敗', block.blockId, msg);
    return { ok: false, error: msg };
  }

  if (!response || !Array.isArray(response.result) || response.result.length === 0) {
    const msg = bgErrMsg(response) || 'no response';
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
        // raw / billed 分開記(同 translateDocument);`??` 而非 `||`,billed===0 合法
        inputTokens: usage.inputTokens ?? usage.billedInputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cachedTokens: 0,
        billedInputTokens: usage.billedInputTokens ?? usage.inputTokens ?? 0,
        billedCostUSD: usage.billedCostUSD ?? 0,
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

  // LLM 協定殘片修復 + 句尾句號對齊,同 translateDocument 的 applyBlockResults（v2.0.53）
  const tr = typeof response.result[0] === 'string'
    ? alignTrailingPeriodWithSource(block.plainText, repairDocLlmArtifacts(response.result[0]))
    : response.result[0];
  if (typeof tr === 'string' && tr.length > 0) {
    // EPUB block：同 translateDocument 的 epub 分支
    if (block.epubSerializedText != null) {
      const norm = normalizeNameSeparators(tr);
      block.translationRaw = norm;
      block.translation = stripPlaceholderTokens(norm);
      block.editedHtml = null; // 重翻覆蓋預覽頁的手動編輯
      block.translationStatus = 'done';
      block.translationError = null;
      return { ok: true };
    }
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
// EPUB 專用 helpers
// ============================================================================

// 佔位符畸形標記修復（v2.0.53）：模型偶發把標記的閉合 ⟧ 寫成 »（⟦/2⟧ → ⟦/2»,
// 日文書實測 57 段），或段尾整個漏寫。錨定「⟦ + (*/?)數字 + 非 ⟧」pattern——
// ⟦ 是協定專用字元，這個前綴必然是壞標記；» 等常見替代閉合字元順帶吃掉,
// 其他字元不消耗只補 ⟧。內文合法的 «» 引號沒有 ⟦N 前綴,不受影響。
// 與 content-serialize.js SK.normalizeLlmPlaceholders 尾段是同一份事實的雙實作
//（module 系統隔離：content script IIFE vs ES module），改這裡必同步那邊。
// v2.0.78（批次 5 H3）：capture 擴成也涵蓋 W7 樣式標記（⟦b⟧/⟦/i⟧/⟦l:N⟧/⟦/l⟧）——
// 同一種 mangle 行為（⟦/2» 已實測 57 段）套在樣式標記上會產出 ⟦/b»，
// parseMarkedTranslation 的 tagRe 不匹配 → stack 不平衡 → fallback，而 fallback
// 的 MARKER_TAG_RE 只清「完好」tag → 字面殘片印進譯文 PDF。樣式標記是 DOC 專用
// 協定，content-serialize.js 那邊的網頁佔位符路徑不存在樣式標記，此擴充刻意不同步
//（雙實作範圍仍只到數字型佔位符）。
export function repairMangledPlaceholders(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  return s.replace(/⟦(\*?\/?\d+|\/?[bi]|l:\d+|\/l)(?:[»›❱》〉≫]|(?=[^⟧0-9])|$)/g, '⟦$1⟧');
}

// 批次分隔符殘片清理（v2.0.53）：模型偶發在段尾寫出殘缺的批次分隔符幻覺
//（日文書實例:「…走了過來。⟦/0⟧\n<<<//22»」）。完整分隔符 <<<SHINKANSEN_SEP>>>
// 由 gemini.js 的 split 消耗；殘缺副本（以 <<< 開頭、沒有 >>> 閉合）永不屬於
// 譯文內容——<<< 是批次協定保留序列（原文含 <<< 本來就會破 split）。
// 三重限縮避免誤殺內文：1) 只看字串尾端 2) <<< 之後必須是「無空白、無 CJK 的
// 符號串」≤24 字（實測殘片 //22» 的結構特徵;帶內文的「<<< b 之後還有正文」
// 不會中）3) 含 >>> 閉合的完整分隔符不動（tempered lookahead）
export function stripTrailingSeparatorGarbage(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  return s
    // v2.0.75:SHINKANSEN_SEP 是批次協定保留字,任何角括號數量 / 大小寫變體都
    // 不可能合法出現在譯文——模型對亂碼輸入(字型 CID 壞掉的 PDF)會幻覺出
    // 「<<SHINKANSEN_SEP>>」兩角括號變體,3 角括號的 split 吃不掉,整批 cell
    // 殘留字面 token(2L ink 實測)。與 content-ns.js SK.sanitizeMarkers 是
    // 同一份事實的雙實作,改這裡必同步那邊
    .replace(/\s*[<«]{1,6}\s*SHINKANSEN_SEP\s*[>»]{1,6}\s*/gi, ' ')
    .replace(/\s*<{3,}(?:(?!>{3})[^\s㐀-鿿぀-ヿ]){0,24}$/, '')
    .trim();
}

// 標記周邊 CJK 空格收斂（v2.0.53）：模型偶發在每個標記前後塞空格
//（日文書實測 c25-b30:「⟦0⟧ 兩個男人…稍微 ⟦/0⟧ ⟦1⟧ 歪 ⟦/1⟧ ⟦2⟧ 著頭…」），
// strip 後殘留「稍微 歪 著頭」這種 CJK 間空格。通則:兩個 CJK 字元之間只隔著
// 標記與空白時,空白全是模型幻覺（CJK 內部無空格語意）——標記留、[ \t] 刪;
// 字串頭尾的標記串同理。不動 \n（<br> 語意）、不動 CJK/拉丁邊界空格（中英
// 空格合法）。與 content-serialize.js SK.collapseCjkSpacesAroundPlaceholders
// 尾段是同一份事實的雙實作（module 系統隔離），改這裡必同步那邊
const CJK_RE = '[\\u3400-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef]';
const PH_TOKEN_RE = '⟦[*\\/]?\\d+⟧';
export function collapseCjkPlaceholderSpaces(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  const strip = (run) => run.replace(/[ \t]+/g, '');
  s = s.replace(
    new RegExp('(' + CJK_RE + ')((?:[ \\t]*(?:' + PH_TOKEN_RE + '))+[ \\t]*)(?=' + CJK_RE + ')', 'g'),
    (m, a, run) => a + strip(run),
  );
  s = s.replace(
    new RegExp('^((?:[ \\t]*(?:' + PH_TOKEN_RE + '))+[ \\t]*)(?=' + CJK_RE + ')'),
    (m, run) => strip(run),
  );
  s = s.replace(
    new RegExp('(' + CJK_RE + ')((?:[ \\t]*(?:' + PH_TOKEN_RE + '))+[ \\t]*)$'),
    (m, a, run) => a + strip(run),
  );
  return s;
}

// CJK 內文 ASCII 空格收斂（v2.0.53，2026-07-11 Jimmy 指定納入自動清理）：
// 模型翻日文書時把原文「？／！後接空格再起句」的排版慣例帶進中文譯文
//（實測樣本:「妳懂嗎？ 那本來應該是…」，session 內 11 段）。通則:CJK 文字
// 內部沒有 ASCII 空格語意——兩個 CJK 字元（含全形標點）之間的 [ \t] 一律移除。
// 三個刻意不動:1) 全形空格 U+3000（日文合法排版字元,不在 [ \t] 內）
// 2) CJK/拉丁邊界空格（中英空格合法,v2.0.51 甚至主動補）3) \n（換行語意）。
// 範圍:僅 translate-doc 譯文接收鏈（比照人名間隔號正規化的 translate-doc
// 先例）;網頁翻譯路徑維持 §7 排版歸 prompt 原則
export function collapseCjkAsciiSpaces(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  return s.replace(new RegExp('(' + CJK_RE + ')[ \\t]+(?=' + CJK_RE + ')', 'g'), '$1');
}

// 雙重書名號收斂（2026-07-12 Jimmy 回報「《《雷霆谷》》」）：術語表 target 已含
// 《》，模型偶發在指定譯名外再自包一層書名號。只收斂「開閉都緊鄰重複」的完整
// 雙包——合法巢狀書名（「《《紅樓夢》研究》」開雙閉不雙）不命中。迴圈到不動點
// 處理三層以上退化 case
export function collapseDoubledTitleMarks(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  let prev;
  do {
    prev = s;
    s = s.replace(/《《([^《》]*)》》/g, '《$1》');
  } while (s !== prev);
  return s;
}

// 譯文接收點的 LLM 協定殘片修復總管——applyBlockResults / retryBlock /
// hydrateSessionBlocks 三個接收點共用，避免各自組合 drift。
// 順序:先修畸形標記（collapse 的 token pattern 要求完好 ⟧）→ 清分隔符殘片
// → 收斂標記周邊 CJK 空格 → 收斂 CJK 內文 ASCII 空格（《》屬 CJK 字元集,
// 「《 《」空格先收斂）→ 收斂雙重書名號
export function repairDocLlmArtifacts(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  return collapseDoubledTitleMarks(collapseCjkAsciiSpaces(
    collapseCjkPlaceholderSpaces(stripTrailingSeparatorGarbage(repairMangledPlaceholders(s))),
  ));
}

// 句尾句號對齊原文（v2.0.53，2026-07-11 Jimmy 指定「忠於原文」方向）：
// 模型把日文「」內對白慣例的「句尾無句號」正規化成中文出版慣例的「補句號」
//（實測本:1,478 段對白中 931 段句尾帶句號,原文多數沒有）。原文輕收節奏是
// 作者的選擇——原文句尾（撇開閉引號 / 閉括號 / 標記殼）沒有終止標點時,刪掉
// 譯文句尾多補的「。」。只刪句號、只在原文沒有終止標點時刪,絕不反向添加;
// 句中的標點重組是翻譯自由,不碰。需要原文對照,所以獨立於 repairDocLlmArtifacts
//（那條鏈沒有 source context），由接收點與 hydrate 另行呼叫
const TERMINAL_PUNCT_RE = /[。．.！!？?…‥]/;
// 收尾殼:閉引號 / 閉括號 / 佔位符或樣式標記（⟦/0⟧ / ⟦/b⟧ / ⟦l:2⟧ 等）/ 空白
const TRAILING_SHELL_RE = /(?:[」』”’〉》】）)\]]|⟦[^⟦⟧]{1,8}⟧|\s)+$/;
export function alignTrailingPeriodWithSource(source, target) {
  if (typeof source !== 'string' || typeof target !== 'string' || target.length === 0) return target;
  const sCore = source.replace(TRAILING_SHELL_RE, '');
  if (!sCore) return target;
  if (TERMINAL_PUNCT_RE.test(sCore[sCore.length - 1])) return target; // 原文有終止標點 → 不動
  const m = target.match(TRAILING_SHELL_RE);
  const shell = m ? m[0] : '';
  const tCore = m ? target.slice(0, target.length - shell.length) : target;
  if (tCore.endsWith('。')) return tCore.slice(0, -1) + shell;
  return target;
}

// 去除譯文中的 ⟦N⟧ / ⟦/N⟧ / ⟦*N⟧ 佔位符標記（預覽 / 複製用純文字）。
// 反序列化重建走 epub-writer 的 SK.deserializeWithPlaceholders，不用這個。
// v2.0.53:先修畸形標記再掃——否則 ⟦/2» 這種壞 token 只會被「殘留括號」清理
// 削掉 ⟦,留下「/2»」碎片洩漏到預覽 / session plain
export function stripPlaceholderTokens(s) {
  const repaired = repairDocLlmArtifacts(s || '');
  const SK = (typeof window !== 'undefined' && window.__SK) || null;
  // 尾端再過一次 CJK 空格收斂:strip 自己的 \s{2,}→' ' 會把 raw 的合法換行
  //（\n\n 段落分隔）壓成 CJK 間空格（實測 c42-b7「如下： 清水」），對一行式
  // plain 而言該空格是噪音。EPUB 下載走 raw 不經此路徑,換行語意不受影響
  if (SK && typeof SK.stripStrayPlaceholderMarkers === 'function') {
    return collapseCjkAsciiSpaces(SK.stripStrayPlaceholderMarkers(repaired).replace(/\s{2,}/g, ' ').trim());
  }
  return collapseCjkAsciiSpaces(
    repaired.replace(/⟦\*?\/?\d+⟧/g, '').replace(/[⟦⟧❰❱]/g, '').replace(/\s{2,}/g, ' ').trim(),
  );
}

// EPUB 全書術語表的批次級過濾：只保留該批原文實際出現的條目（大小寫不敏感）。
// 確定性動作：glossary 在翻譯前已鎖定，此處只是「這批用不到的條目不送」省 token，
// 不改變任何譯名決策。
//
// 部分比對規則（2026-07-09 真書實測補）：多詞條目（如 Richard Enfield）在章節內
// 常以末詞（姓氏 Enfield）單獨出現——只比對完整 source 會把這條濾掉，LLM 對姓氏
// 自由發揮造成譯名漂移（實測 Jekyll & Hyde：恩菲爾德 → 恩菲爾）。所以多詞條目
// 改成「完整 source 或末詞（≥3 字元）出現」都算命中——多送一條無害（LLM 拿到
// 全名對照能推姓氏譯法），漏送才是漂移來源。
export function filterGlossaryForTexts(glossary, texts) {
  if (!Array.isArray(glossary) || glossary.length === 0) return glossary;
  const haystack = texts.join('\n').toLowerCase();
  const hit = glossary.filter((e) => {
    const src = (e && e.source || '').toLowerCase().trim();
    if (!src) return false;
    if (haystack.includes(src)) return true;
    const words = src.split(/\s+/);
    if (words.length >= 2) {
      const last = words[words.length - 1];
      if (last.length >= 3 && haystack.includes(last)) return true;
    }
    return false;
  });
  return hit.length > 0 ? hit : null;
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
  // EPUB block：送 ⟦N⟧ 佔位符序列化文字（epub-engine 產出；system-instruction
  // 偵測到 ⟦ 會自動注入佔位符協定規則）。W7 styleSegments 是 PDF 專用路徑
  if (block.epubSerializedText != null) return block.epubSerializedText;
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
    // v2.0.78（批次 5 H3）：MARKER_TAG_RE 只清「完好」tag——repair 搆不到的殘片
    //（如 ⟦l:» 缺編號）補一道 token 形狀的殘片掃除。字元集收緊到協定 token 本體
    //（[*/bil0-9:]）+ 常見替代閉合字元，不會誤吃內文（⟦ 是協定保留字元，但保守
    // 起見不用寬鬆的「任意 N 字」掃法）
    const cleaned = (text || '')
      .replace(MARKER_TAG_RE, '')
      .replace(/⟦\/?[*bil0-9:]{0,4}[»›❱》〉≫]?/g, '');
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
 * @property {number} cumulativeInputTokens        raw input tokens(折扣前)
 * @property {number} cumulativeBilledInputTokens  billed input tokens(cache 折扣後)
 * @property {number} cumulativeOutputTokens
 * @property {number} cumulativeCostUSD
 * @property {boolean} cancelled
 */
