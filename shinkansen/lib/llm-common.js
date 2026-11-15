// llm-common.js — Gemini / OpenAI-compat 兩條 LLM adapter 共用的引擎層基礎設施
//
// 2026-09-12 code review 批次 6（§5.1）：以下五份「同一份事實」原本在 lib/gemini.js 與
// lib/openai-compat.js 各自維護一份，歷史上已 drift 三次（usage 掛載、catch 語意、
// temperature fallback），這裡收斂成單一實作，兩個 adapter 只剩「組 request body」與
// 「從各自 API 回應形狀抽 text / finishReason / usage」兩件事：
//
//   1. fetchWithRetry     ：fetch-level timeout（涵蓋到 body 讀完）+ 429 / 5xx / 網路錯誤退避重試
//   2. readJsonBody       ：resp.text() → JSON.parse，非 JSON 時帶前 200 字 preview 的 coded error
//   3. alignAndFallback   ：截斷不採信 → 段數比對 → 序號標記 realign → 逐段 fallback → 輸出語言驗證
//   4. runChunkedBatch    ：packChunks 分批 + 中途 throw 時把已付費 chunk 的 usage 掛在 err.usage
//   5. emptyContentError  ：空輸出 finishReason → error code 對照表（non-streaming / streaming / OpenAI 三路共用）
//   6. parseLlmJson       ：術語表 / 譯名對照抽取的 JSON 剝殼（code fence / 前後說明文字 / 找第一個陣列）
//
// 兩引擎的差異全部走參數（logPrefix / 錯誤 code / marker / 429 分類 hook），不允許在 adapter 內
// 再長出第二份同語意邏輯——test/unit/llm-common-engine-parity.spec.js 以「同輸入同行為」
// 鎖住兩引擎，並 source-lock 兩個 adapter 不得自帶 fetchWithRetry / perSegmentFallback。

import { debugLog } from './logger.js';
import { codedError } from './bg-error.js';
import { SEP_RE, realignByMarkers, detectOutputLangMismatch } from './system-instruction.js';

export const MAX_BACKOFF_MS = 8000;
// v1.10.46（批次 2-1）：429 Retry-After 等待上限。provider 可能回數百秒的 Retry-After，
// MV3 SW 等不到那麼久（30 秒 idle 即可能被回收），無上限等待等於永久卡批次。
// cap 在 30 秒，等完仍 429 就走 maxRetries 放棄路徑回報錯誤。
export const RETRY_AFTER_CAP_MS = 30_000;
// 主翻譯 fetch 層級 timeout 預設值（v1.9.21）：Flash 系列慢 case ~8s 留 2x margin。
// Gemini 路徑用此預設；OpenAI-compat 路徑由 adapter 傳 90s（reasoning 模型非 streaming
// 要等整批生成完才回 body）。
export const FETCH_TIMEOUT_MS = 15_000;

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
}

/** 兩份 usage 相加（缺欄位視為 0）。 */
export function addUsage(a, b) {
  const x = a || {};
  const y = b || {};
  const out = {
    inputTokens: (x.inputTokens || 0) + (y.inputTokens || 0),
    outputTokens: (x.outputTokens || 0) + (y.outputTokens || 0),
    cachedTokens: (x.cachedTokens || 0) + (y.cachedTokens || 0),
  };
  // Priority 被降級成 Standard 處理的部分（gemini.js 標記，lib/billing.js computeBilling 讀）。
  // 有值才帶，沒有降級時 usage 形狀不變
  for (const k of ['stdInputTokens', 'stdOutputTokens', 'stdCachedTokens']) {
    const v = (x[k] || 0) + (y[k] || 0);
    if (v > 0) out[k] = v;
  }
  return out;
}

/**
 * 把「已付費但結果不可用」的 usage 掛到 error 上，交呼叫端記帳。
 * err 既有 usage（下層 throw 時掛的）要「相加」不可覆蓋（§3.5-2：失敗那一段自己的
 * usage 也已計費）。非物件 error 原樣回傳。
 */
export function attachUsage(err, base) {
  if (err && typeof err === 'object') {
    err.usage = addUsage(base, err.usage);
  }
  return err;
}

/**
 * fetch LLM endpoint，帶 fetch-level timeout + 429 / 5xx / 網路錯誤退避重試。
 * - timeoutMs 內沒回應 → AbortError → 走網路錯誤 retry path
 * - 收到 429 → 讀 Retry-After header（秒數）等待後重試；沒給 → 指數退避 2^n × 500ms（上限 8s）
 * - 5xx → 指數退避重試
 * - 重試次數超過 maxRetries → 丟原錯誤
 * - timeoutRetries（預設同 maxRetries）：逾時類單獨的重試上限。文件路徑設 1——放寬到
 *   120s 還逾時代表批太大，重複燒同尺寸請求只會 4 倍計費 0 產出，交呼叫端縮批處理
 * - classify429(bodyJson)：引擎專屬的 429 分類 hook，回 `{ dimension, fatal }`。
 *   dimension 進 log 與 http429 錯誤參數；fatal 非空時直接 throw 不重試（Gemini RPD 每日配額）
 *
 * v1.10.46（批次 2-2）：abortTimer 涵蓋範圍從「只到 headers 抵達」延伸到「body 讀完」。
 * fetch resolve 只代表 headers 到，行動網路 / proxy 中途吊住時 resp.json() 可無限 pending
 * → 該批永久卡住無錯誤。改成在 controller 還在 scope 的這裡把 body 讀完（逾時 → abort →
 * body 讀取 reject → 走網路錯誤 retry），成功路徑回傳以 body 文字重建的 Response，呼叫端
 * resp.json() / clone() 行為不變。timer 統一在 finally 清（每輪 continue / return / throw 都會經過）。
 *
 * headers：額外 request headers（Gemini API key 走 `x-goog-api-key` header 而非 URL
 * query string，避免金鑰漏進 proxy / 網路設備 / 錯誤訊息等會記 URL 的地方）
 */
export async function fetchWithRetry(url, body, {
  maxRetries = 3,
  headers = {},
  timeoutMs = FETCH_TIMEOUT_MS,
  timeoutRetries = null,
  logPrefix = 'llm',
  classify429 = null,
} = {}) {
  const timeoutRetryCap = (typeof timeoutRetries === 'number') ? timeoutRetries : maxRetries;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let resp;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        const isTimeout = err.name === 'AbortError';
        const errMsg = isTimeout ? `逾時(${timeoutMs}ms)` : err.message;
        await debugLog('error', 'api', isTimeout ? `${logPrefix} fetch timeout` : `${logPrefix} fetch network error`, { error: err.message, attempt, timeoutMs: isTimeout ? timeoutMs : undefined });
        if (attempt >= (isTimeout ? timeoutRetryCap : maxRetries)) {
          throw isTimeout
            ? codedError('timeout', { ms: timeoutMs }, '網路錯誤：' + errMsg)
            : codedError('network', { msg: err.message }, '網路錯誤：' + errMsg);
        }
        await sleep(Math.min(MAX_BACKOFF_MS, 500 * Math.pow(2, attempt)));
        attempt += 1;
        continue;
      }

      // v0.84：5xx 伺服器錯誤也重試（provider 偶爾回 500 / 503 服務暫時不可用）
      if (resp.status >= 500 && resp.status < 600) {
        await debugLog('warn', 'api', `${logPrefix} ${resp.status} server error`, { status: resp.status, attempt });
        if (attempt >= maxRetries) {
          let errMsg = `HTTP ${resp.status}`;
          try { const j = await resp.json(); errMsg = j?.error?.message || errMsg; } catch { /* noop */ }
          throw new Error(errMsg);
        }
        await sleep(Math.min(MAX_BACKOFF_MS, 500 * Math.pow(2, attempt)));
        attempt += 1;
        continue;
      }

      if (resp.status !== 429) {
        // 成功 / 非 429 錯誤：body 在 timer 涵蓋下讀完（2-2）
        let bodyText;
        try {
          bodyText = await resp.text();
        } catch (err) {
          const isTimeout = err.name === 'AbortError';
          const errMsg = isTimeout ? `回應讀取逾時(${timeoutMs}ms)` : err.message;
          await debugLog('error', 'api', isTimeout ? `${logPrefix} body read timeout` : `${logPrefix} body read error`, { error: err.message, attempt });
          if (attempt >= (isTimeout ? timeoutRetryCap : maxRetries)) {
            throw isTimeout
              ? codedError('readTimeout', { ms: timeoutMs }, '網路錯誤：' + errMsg)
              : codedError('network', { msg: err.message }, '網路錯誤：' + errMsg);
          }
          await sleep(Math.min(MAX_BACKOFF_MS, 500 * Math.pow(2, attempt)));
          attempt += 1;
          continue;
        }
        // bodyText 為空字串時傳 null（204 等 null-body status 帶 body 會 throw）
        return new Response(bodyText || null, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
      }

      // 429 處理
      let bodyJson = null;
      try { bodyJson = await resp.clone().json(); } catch { /* noop */ }
      const cls = (typeof classify429 === 'function') ? (classify429(bodyJson) || {}) : {};
      const dim = cls.dimension || null;
      const retryAfterHeader = resp.headers.get('retry-after');
      const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;

      await debugLog('warn', 'api', `${logPrefix} 429 rate limit`, {
        dimension: dim,
        retryAfter: retryAfterHeader,
        attempt,
        error: bodyJson?.error?.message,
      });

      if (cls.fatal) throw cls.fatal;

      if (attempt >= maxRetries) {
        // API 自帶 error.message（英文，ground truth）原樣傳遞不掛 code；
        // 沒帶才用 http429 code 讓 content 端組「HTTP 429（{dim}）」
        const apiMsg = bodyJson?.error?.message;
        if (apiMsg) throw new Error(apiMsg);
        throw codedError('http429', { dim: dim || 'unknown' }, `HTTP 429(${dim || '未知維度'})`);
      }

      const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.min(retryAfterSec * 1000 + 100, RETRY_AFTER_CAP_MS)
        : Math.min(MAX_BACKOFF_MS, 500 * Math.pow(2, attempt));
      await sleep(waitMs);
      attempt += 1;
    } finally {
      clearTimeout(abortTimer);
    }
  }
}

/**
 * resp.text() → JSON.parse。API 回傳非 JSON（HTML 錯誤頁、空回應、CDN 擋下的 502 頁）時
 * 以 coded error 帶前 200 字 preview 拋出。
 * 批次 8 E4：先 text() 再 JSON.parse——resp.json() 失敗後 body 已 disturbed，
 * resp.clone().text() 依 spec 必 throw → rawPreview 恆空，診斷 preview 實質 dead code。
 *
 * @param {Response} resp
 * @param {object} opts
 * @param {number} opts.t0 請求起始時間（log elapsed 用）
 * @param {string} opts.logPrefix
 * @param {string} opts.errorCode coded error code（gemini: badResponse / openai-compat: customBadResponse）
 * @param {(status:number, preview:string) => string} opts.message fallback 訊息組裝
 * @returns {Promise<any>} parsed JSON
 */
export async function readJsonBody(resp, { t0, logPrefix, errorCode, message }) {
  let rawBody = '';
  try {
    rawBody = await resp.text();
    return JSON.parse(rawBody);
  } catch (parseErr) {
    const rawPreview = rawBody.slice(0, 200);
    await debugLog('error', 'api', `${logPrefix} response body is not JSON`, {
      status: resp.status, elapsed: Date.now() - t0, parseError: parseErr.message, rawPreview,
    });
    throw codedError(errorCode, { status: resp.status, preview: rawPreview || 'N/A' }, message(resp.status, rawPreview));
  }
}

// 空內容 finishReason → error code（error.bg.* dict key 尾段）。
// Gemini non-streaming / streaming 兩條路徑共用，沒列出的 finishReason 走 fallbackCode（帶 {reason}）。
export const EMPTY_REASON_CODES = {
  SAFETY: 'emptySafety',
  RECITATION: 'emptyRecitation',
  MAX_TOKENS: 'emptyMaxTokens',
  OTHER: 'emptyOther',
};

// 對應的 fallback 訊息（content 端查不到 dict 時顯示；正常路徑由 code 查 dict 翻譯）
export const EMPTY_REASON_MESSAGES = {
  SAFETY: '內容被 Gemini 安全過濾器擋下。可能是原文含有敏感內容，請嘗試跳過此段落。',
  RECITATION: 'Gemini 偵測到輸出與已知作品高度重複（recitation filter），請嘗試縮短段落。',
  MAX_TOKENS: '輸出超過 maxOutputTokens 上限。請到設定頁提高上限，或減少每批段落數。',
  OTHER: 'Gemini 回傳空內容（finishReason: OTHER），原因不明。請稍後重試。',
};

/**
 * 空輸出錯誤：依 finishReason 查 code / 訊息表，掛 usage（空輸出時 input + thinking token 已計費）。
 * @param {string} finishReason
 * @param {object} usage
 * @param {object} [opts]
 * @param {object} [opts.codes=EMPTY_REASON_CODES]
 * @param {object} [opts.messages=EMPTY_REASON_MESSAGES]
 * @param {string} [opts.fallbackCode='emptyContent']
 * @param {string} [opts.fallbackMessage]
 */
/**
 * OpenAI 相容回應的 message.content 正規化為字串（2026-09-14 code review §8 Item G）。
 * OpenAI Chat Completions 規格的回應 content 是 string | null，但少數相容伺服器
 *（本機 proxy / gateway 回 Anthropic 式 content blocks）會回 array of parts
 *（[{type:'text', text:'…'}]）。舊碼 `choice?.message?.content || ''` 對 array 回 array，
 * 下游 text.split / parseLlmJson 直接 TypeError（`text.split is not a function`）→ 整批
 * 翻譯崩掉。這裡把 array 攤成純文字、其餘型別 String 化，非決定內容不 throw。
 * @param {*} content message.content（string | null | Array<{text?:string}> | 其他）
 * @returns {string}
 */
export function normalizeMessageContent(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : (part && typeof part.text === 'string' ? part.text : '')))
      .join('');
  }
  return String(content);
}

export function emptyContentError(finishReason, usage, {
  codes = EMPTY_REASON_CODES,
  messages = EMPTY_REASON_MESSAGES,
  fallbackCode = 'emptyContent',
  fallbackMessage = `Gemini 回傳空內容（finishReason: ${finishReason}）。`,
} = {}) {
  const err = codedError(codes[finishReason] || fallbackCode, { reason: finishReason }, messages[finishReason] || fallbackMessage);
  err.usage = { ...usage };
  return err;
}

/**
 * 把模型輸出對齊回 texts 的段數；對不齊時逐段 fallback。兩引擎同一份邏輯，順序固定：
 *
 *   1. 截斷不採信（§3.5-1）：finishReason === truncatedFinishReason 帶部分文字 = 輸出在上限處
 *      被截斷、末段殘缺。多段 chunk 走逐段 fallback（每段輸出小，不會再撞上限）；單段沒有更小
 *      的單位可退，拋 makeTruncatedError() 讓使用者提高上限 / 縮批，usage 掛上供記帳。
 *      必須排在 realign / 段數比對之前，否則截斷輸出可能被對齊成功而放行。
 *   2. 段數不符：單段 chunk = 模型多吐了 SEP 字面 → strip 後以換行 join（批次 8 E5，協定 token
 *      不進 DOM / 快取）；多段先試序號標記二次對齊（v2.0.69 realignByMarkers，模型吃掉 SEP 但段首
 *      «N» 都在），救不回才逐段 fallback。
 *   3. 段數對齊但整 chunk 輸出語言錯（v2.0.52）：同 payload 立即重試高度 sticky，逐段小 payload
 *      能打破。只驗多段 chunk（單段在逐段 fallback 內部呼叫，不驗避免無限遞迴）。
 *
 * 逐段 fallback 每段都會真的再打一次 API，usage 累加；本批原始請求的 chunkUsage 已付費、結果
 * 不可用也要計入。半途 throw 時「整批 + 已完成段 + 失敗段自己」相加掛在 err.usage。
 *
 * @param {object} p
 * @param {string[]} p.texts 本 chunk 原文
 * @param {string} p.text 模型原始輸出
 * @param {{re: RegExp}} p.marker 本批用的段序號標記（COMPACT / STRONG）
 * @param {object} p.chunkUsage 本批原始請求 usage
 * @param {string} p.finishReason
 * @param {string} p.truncatedFinishReason 'MAX_TOKENS'（Gemini）/ 'length'（OpenAI）
 * @param {() => Error} p.makeTruncatedError 單段截斷時的 coded error（usage 由這裡掛）
 * @param {(text:string) => Promise<{parts:string[], usage:object}>} p.translateOne 單段重翻（遞迴 translateChunk）
 * @param {string} p.targetLanguage
 * @param {number} p.elapsedMs 原始請求耗時（log 用）
 * @param {string} p.logPrefix
 * @returns {Promise<{parts:string[], usage:object, hadMismatch:boolean}>}
 */
export async function alignAndFallback({
  texts, text, marker, chunkUsage, finishReason, truncatedFinishReason,
  makeTruncatedError, translateOne, targetLanguage, elapsedMs, logPrefix,
}) {
  const parts = text.split(SEP_RE).map(s => s.trim().replace(marker.re, ''));

  const perSegmentFallback = async () => {
    const aligned = [];
    let aggUsage = { ...chunkUsage };
    const tFallback0 = Date.now();
    for (let fi = 0; fi < texts.length; fi++) {
      const tSeg0 = Date.now();
      let r;
      try {
        r = await translateOne(texts[fi]);
      } catch (err) {
        throw attachUsage(err, aggUsage);
      }
      await debugLog('info', 'api', `${logPrefix} fallback segment ${fi + 1}/${texts.length}`, { elapsed: Date.now() - tSeg0 });
      aligned.push(r.parts[0] || '');
      aggUsage = addUsage(aggUsage, r.usage);
    }
    await debugLog('warn', 'api', `${logPrefix} fallback complete`, { segments: texts.length, fallbackElapsed: Date.now() - tFallback0, originalElapsed: elapsedMs });
    return { parts: aligned, usage: aggUsage, hadMismatch: true };
  };

  if (finishReason === truncatedFinishReason) {
    if (texts.length > 1) {
      await debugLog('warn', 'api', `${logPrefix} output truncated (${finishReason}) — fallback to per-segment`, {
        segments: texts.length, elapsed: elapsedMs, textLength: text.length,
      });
      return perSegmentFallback();
    }
    const err = makeTruncatedError();
    err.usage = { ...chunkUsage };
    throw err;
  }

  let aligned = parts;
  if (parts.length !== texts.length) {
    if (texts.length === 1) {
      const joinedSingle = parts.filter(Boolean).join('\n') || text.trim();
      return { parts: [joinedSingle], usage: chunkUsage, hadMismatch: false };
    }
    const realigned = realignByMarkers(text, texts.length, marker);
    if (!realigned) {
      // rawHead：realign 也救不回時把原始輸出頭段進 log——outputPreview 300 字看不到合併點，
      // 沒有這欄無法事後判斷是「marker 也被吃」還是其他病型
      await debugLog('warn', 'api', `${logPrefix} segment count mismatch — fallback to per-segment`, {
        expected: texts.length, got: parts.length, elapsed: elapsedMs, rawHead: text.slice(0, 6000),
      });
      return perSegmentFallback();
    }
    await debugLog('info', 'api', `${logPrefix} segment count mismatch — realigned via seq markers`, {
      expected: texts.length, got: parts.length, elapsed: elapsedMs,
    });
    aligned = realigned;
  }

  if (texts.length > 1 && detectOutputLangMismatch(aligned, targetLanguage)) {
    await debugLog('warn', 'api', `${logPrefix} chunk output language mismatch — fallback to per-segment`, {
      segments: texts.length, elapsed: elapsedMs, targetLanguage,
    });
    return perSegmentFallback();
  }

  return { parts: aligned, usage: chunkUsage, hadMismatch: false };
}

/**
 * translateBatch 外層：依使用者分批上限切 chunk 逐批送，累加 usage / hadMismatch。
 * 多 chunk 中途失敗時前面已完成的 chunk 已經付過費——把累積 usage 附在 error 上讓呼叫端
 *（background handleTranslate）記帳後再 rethrow，否則 content 端收到 error 不會發 LOG_USAGE，
 * 已付費 token 系統性漏記（v1.10.46 批次 2-5）。下層 throw 已掛的 err.usage（逐段 fallback
 * 半途）一併相加。
 *
 * @param {string[]} texts
 * @param {object} settings 讀 maxUnitsPerBatch / maxCharsPerBatch
 * @param {(slice:string[]) => Promise<{parts:string[], usage:object, hadMismatch?:boolean}>} translateChunk
 * @param {(texts:string[], limits:object) => Array<{start:number,end:number}>} packChunks
 */
export async function runChunkedBatch(texts, settings, translateChunk, packChunks) {
  if (!texts?.length) return { translations: [], usage: emptyUsage(), hadMismatch: false };
  const out = new Array(texts.length);
  let usage = emptyUsage();
  let hadMismatch = false;
  // 批次 5-3：帶使用者設定的分批上限（原本寫死 20 段／3500 字，調高設定無效）
  const chunks = packChunks(texts, {
    maxUnits: settings?.maxUnitsPerBatch,
    maxChars: settings?.maxCharsPerBatch,
  });
  for (const { start, end } of chunks) {
    const slice = texts.slice(start, end);
    let result;
    try {
      result = await translateChunk(slice);
    } catch (err) {
      throw attachUsage(err, usage);
    }
    for (let j = 0; j < result.parts.length; j++) out[start + j] = result.parts[j];
    usage = addUsage(usage, result.usage);
    if (result.hadMismatch) hadMismatch = true;
  }
  return { translations: out, usage, hadMismatch };
}

/**
 * LLM 輸出的 JSON 剝殼（術語表 / 譯名對照抽取用）。不用 responseMimeType 後模型可能在
 * JSON 前後附帶說明文字，或用 ```json ... ``` code fence 包裹：先取 fence 內容；沒 fence 就取
 * 第一個 [ 或 { 到最後一個 ] 或 } 之間。parse 成功後找出「術語陣列」：頂層陣列直接用，
 * 物件則取第一個值是陣列的 key（模型可能用 "terms" / "glossary" / "entries" 等任何 key）。
 *
 * @param {string} rawText
 * @returns {{ ok: true, parsed: any, entries: Array|null } | { ok: false, error: Error }}
 */
export function parseLlmJson(rawText) {
  let jsonStr = (rawText || '').trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  } else {
    const firstBracket = jsonStr.search(/[\[{]/);
    const lastBracket = Math.max(jsonStr.lastIndexOf(']'), jsonStr.lastIndexOf('}'));
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      jsonStr = jsonStr.slice(firstBracket, lastBracket + 1);
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (error) {
    return { ok: false, error };
  }
  let entries = null;
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const arrKey = Object.keys(parsed).find(k => Array.isArray(parsed[k]));
    entries = arrKey ? parsed[arrKey] : null;
  }
  return { ok: true, parsed, entries };
}
