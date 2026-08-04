// openai-compat.js — OpenAI-compatible Chat Completions adapter（v1.5.7 起）
//
// 為什麼有這個檔：使用者想用 Gemini 之外的模型（OpenRouter / Together / DeepSeek /
// Groq / Fireworks / OpenAI 自家 / 自架 Ollama 等）。chat.completions 是事實上的
// lingua franca；OpenRouter 把 Anthropic 與 Gemini 原生 API 都已經 wrap 成
// OpenAI-compatible，使用者要冷門 provider 透過它就能接，不需要 Shinkansen
// 為每個 provider 寫獨立 adapter。
//
// 介面對齊 lib/gemini.js 的 translateBatch：呼叫端（background.js）只看 engine
// 字串切換 import 不同 module，其他流程（cache / 注入 / segment mismatch fallback）
// 完全共用。
//
// Rate limiter / RPD 配額：bypass（Jimmy 設計決定 #5）。OpenRouter 等 provider
// 自己處理配額；429 退避重試由本檔 fetchWithRetry 處理。
//
// systemInstruction 構建：使用者自訂的 customProvider.systemPrompt 是 base，
// 其後由 buildEffectiveSystemInstruction 自動追加：多段分隔符規則 / 段內換行
// 規則 / 佔位符規則 / 自動 glossary / 使用者固定術語表 / 中國用語黑名單。
// 黑名單與固定術語表是「跨 provider 共用」（Jimmy 設計決定 #3）。

import { debugLog } from './logger.js';
import { DELIMITER, SEP_RE, MARKER_COMPACT, MARKER_STRONG, packChunks, buildEffectiveSystemInstruction, isValidGlossaryEntry, detectOutputLangMismatch, realignByMarkers } from './system-instruction.js';
// v1.6.18: thinking 控制 mapping（各家 provider 的 thinking schema 不同，統一成
// thinkingLevel 'auto/off/low/medium/high' + extraBodyJson 進階透傳）
import { buildThinkingPayload } from './openai-compat-thinking.js';
import { codedError } from './bg-error.js'; // 使用者面對錯誤帶 error code 過協定，content 端查 dict 翻譯

const MAX_BACKOFF_MS = 8000;
// v1.10.46(批次 2-1):429 Retry-After 等待上限(同 lib/gemini.js)。provider 可能回
// 數百秒的 Retry-After,MV3 SW 等不到那麼久,無上限等待等於永久卡批次。
const RETRY_AFTER_CAP_MS = 30_000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * fetch chat.completions endpoint，帶 429 / 5xx 退避重試。
 * 與 lib/gemini.js 的 fetchWithRetry 邏輯對齊（除了 quota dimension 提取，
 * OpenAI-compatible provider 的 429 body 結構不一致，這裡只做純退避）。
 */
// 主翻譯 fetch 層級 timeout 預設值。使用者可透過 customProvider.fetchTimeoutSec 覆蓋。
// 2026-07-27 從 15s 調成 90s：OpenRouter 上的 reasoning 模型（GPT / Claude 旗艦）
// 非 streaming 要等整批生成完才回 body，15s 對一批 20 段幾乎必逾時（Jimmy 實測
// ~openai/gpt-latest 網頁翻譯每批三連 body read timeout）
const DEFAULT_FETCH_TIMEOUT_MS = 90_000;

async function fetchWithRetry(url, headers, body, { maxRetries = 3, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // v1.10.46(批次 2-2):abortTimer 涵蓋範圍從「只到 headers 抵達」延伸到「body 讀完」。
    // 原本 fetch resolve 即 clearTimeout,但 fetch resolve 只代表 headers 到,行動網路 /
    // proxy 中途吊住時 resp.json() 可無限 pending → 該批永久卡住無錯誤。改成在 controller
    // 還在 scope 的這裡把 body 讀完(逾時 → abort → body 讀取 reject → 走網路錯誤 retry),
    // 成功路徑回傳以 body 文字重建的 Response,呼叫端 resp.json() / clone() 行為不變。
    // timer 統一在 finally 清(每輪 continue / return / throw 都會經過)。
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
        await debugLog('error', 'api', isTimeout ? 'openai-compat fetch timeout' : 'openai-compat fetch network error', { error: err.message, attempt, timeoutMs: isTimeout ? timeoutMs : undefined });
        if (attempt >= maxRetries) {
          throw isTimeout
            ? codedError('timeout', { ms: timeoutMs }, '網路錯誤：' + errMsg)
            : codedError('network', { msg: err.message }, '網路錯誤：' + errMsg);
        }
        await sleep(Math.min(MAX_BACKOFF_MS, 500 * Math.pow(2, attempt)));
        attempt += 1;
        continue;
      }

      // 5xx → 退避重試
      if (resp.status >= 500 && resp.status < 600) {
        await debugLog('warn', 'api', `openai-compat ${resp.status} server error`, { status: resp.status, attempt });
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
        // 成功 / 非 429 錯誤:body 在 timer 涵蓋下讀完(2-2)
        let bodyText;
        try {
          bodyText = await resp.text();
        } catch (err) {
          const isTimeout = err.name === 'AbortError';
          const errMsg = isTimeout ? `回應讀取逾時(${timeoutMs}ms)` : err.message;
          await debugLog('error', 'api', isTimeout ? 'openai-compat body read timeout' : 'openai-compat body read error', { error: err.message, attempt });
          if (attempt >= maxRetries) {
            throw isTimeout
              ? codedError('readTimeout', { ms: timeoutMs }, '網路錯誤：' + errMsg)
              : codedError('network', { msg: err.message }, '網路錯誤：' + errMsg);
          }
          await sleep(Math.min(MAX_BACKOFF_MS, 500 * Math.pow(2, attempt)));
          attempt += 1;
          continue;
        }
        // bodyText 為空字串時傳 null(204 等 null-body status 帶 body 會 throw)
        return new Response(bodyText || null, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
      }

      // 429 退避（不依 quota dimension 細分，OpenAI 相容 provider 沒有統一的維度標記）
      let bodyJson = null;
      try { bodyJson = await resp.clone().json(); } catch { /* noop */ }
      const retryAfterHeader = resp.headers.get('retry-after');
      const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;

      await debugLog('warn', 'api', 'openai-compat 429 rate limit', {
        retryAfter: retryAfterHeader,
        attempt,
        error: bodyJson?.error?.message,
      });

      if (attempt >= maxRetries) {
        const msg = bodyJson?.error?.message || `HTTP 429`;
        throw new Error(msg);
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
 * 把 OpenAI 風格的 base URL 標準化成 chat.completions endpoint。
 *   "https://openrouter.ai/api/v1"          → ".../chat/completions"
 *   "https://openrouter.ai/api/v1/"         → ".../chat/completions"
 *   "https://openrouter.ai/api/v1/chat/completions" → 原值（已是完整 endpoint）
 *   "http://localhost:11434/v1"             → ".../chat/completions"（Ollama）
 */
function resolveChatCompletionsUrl(baseUrl) {
  if (!baseUrl) throw codedError('baseUrlMissing', null, 'customProvider.baseUrl 未設定');
  const trimmed = String(baseUrl).trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return trimmed + '/chat/completions';
}

/**
 * 批次翻譯文字陣列（會自動切成多批送出）。介面與 lib/gemini.js 的 translateBatch 對齊。
 *
 * @param {string[]} texts 原文陣列
 * @param {object} settings 完整設定。會讀：
 *   - customProvider.baseUrl
 *   - customProvider.model
 *   - customProvider.systemPrompt
 *   - customProvider.temperature
 *   - customProvider.apiKey（已由 background 端從 storage.local 注入）
 * @param {Array<{source:string, target:string}>} [glossary]
 * @param {Array<{source:string, target:string}>} [fixedGlossary]
 * @param {Array<{forbidden:string, replacement:string}>} [forbiddenTerms]
 * @returns {Promise<{ translations: string[], usage: { inputTokens: number, outputTokens: number, cachedTokens: number }, hadMismatch: boolean }>}
 */
export async function translateBatch(texts, settings, glossary, fixedGlossary, forbiddenTerms) {
  if (!texts?.length) return { translations: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, hadMismatch: false };
  const out = new Array(texts.length);
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
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
      result = await translateChunk(slice, settings, glossary, fixedGlossary, forbiddenTerms);
    } catch (err) {
      // 多 chunk 中途失敗：前面 chunk 已付費——把累積 usage 掛上 err 讓呼叫端記帳
      // (對齊 lib/gemini.js translateBatch 的 err.usage 慣例，兩引擎對帳準確度一致)。
      // v2.0.78:err.usage 已存在(perSegmentFallback 半途 throw 掛上該 chunk 的
      // aggUsage）時仍須「相加」外層已完成 chunk 的累積——之前 `!err.usage` 直接跳過，
      // 前面成功 chunk 的已付費 token 被丟棄（gemini.js:728 是相加，兩引擎 drift）
      if (err && typeof err === 'object') {
        const partial = err.usage || { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
        err.usage = {
          inputTokens: usage.inputTokens + (partial.inputTokens || 0),
          outputTokens: usage.outputTokens + (partial.outputTokens || 0),
          cachedTokens: usage.cachedTokens + (partial.cachedTokens || 0),
        };
      }
      throw err;
    }
    for (let j = 0; j < result.parts.length; j++) out[start + j] = result.parts[j];
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    usage.cachedTokens += result.usage.cachedTokens || 0;
    if (result.hadMismatch) hadMismatch = true;
  }
  return { translations: out, usage, hadMismatch };
}

async function translateChunk(texts, settings, glossary, fixedGlossary, forbiddenTerms) {
  if (!texts?.length) return { parts: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } };
  const cp = settings.customProvider || {};
  const { baseUrl, model, systemPrompt, temperature, apiKey, thinkingLevel, extraBodyJson } = cp;
  // v1.6.7: API Key 允許為空（本機 llama.cpp / Ollama 等不需要 key）；商用後端漏填會自然 401
  // v1.8.41:Model 也允許為空（llama.cpp 啟動時鎖 model,body 不送 model 欄位即用 server 預設）;
  // 商用後端不送 model 會自然 4xx「model required」，讓 provider error 自己講話。

  // 多段時加序號標記。useStrongSegMarker 預設 true(包含舊使用者升級後 undefined 的情況):
  // 用 STRONG 格式 <<<SHINKANSEN_SEG-N>>> 防止本機量化模型(gemma-4 量化版等)誤翻 «N»
  // 為自然語言 N1, N2 洩漏到譯文。商用 LLM(GPT / Claude / DeepSeek 等)使用者可關閉
  // 此 toggle 改用緊湊 «N» 省 token。
  const marker = (cp.useStrongSegMarker === false) ? MARKER_COMPACT : MARKER_STRONG;
  const useSeqMarkers = texts.length > 1;
  const markedTexts = useSeqMarkers
    ? texts.map((t, i) => marker.fmt(i + 1) + t)
    : texts;
  const joined = markedTexts.join(DELIMITER);

  const baseSystem = (typeof systemPrompt === 'string' && systemPrompt.trim())
    ? systemPrompt
    : '你是專業的英文 → 繁體中文（台灣慣用語）翻譯助理，僅輸出譯文不加任何說明。';
  const effectiveSystem = buildEffectiveSystemInstruction(baseSystem, texts, joined, glossary, fixedGlossary, forbiddenTerms, marker);

  // v1.6.18: 依 baseUrl + model 偵測 provider，組對應 thinking 控制 payload。
  // 若 user 的 extraBodyJson 解析失敗，debugLog 一條 warn 但不阻斷翻譯。
  const thinkingPayload = buildThinkingPayload({
    baseUrl, model,
    level: thinkingLevel || 'auto',
    extraBodyRaw: extraBodyJson || '',
    onWarn: (msg) => { debugLog('warn', 'api', `customProvider thinking config: ${msg}`); },
  });

  const body = {
    messages: [
      { role: 'system', content: effectiveSystem },
      { role: 'user', content: joined },
    ],
    stream: false,
    ...thinkingPayload,
  };
  // v2.0.79:temperature 留空(存成 null)= 此 provider / model 不接受這個參數,body 一律
  // 不送。部分 reasoning model 只吃自家預設值,帶任何 temperature 直接回 400
  //(GitHub issue #60)。undefined(舊設定沒寫過這個欄位)維持既有 0.7 fallback。
  if (temperature !== null) {
    body.temperature = typeof temperature === 'number' ? temperature : 0.7;
  }
  // v1.8.41:model 為空（llama.cpp / Ollama）時不送 model 欄位，讓 server 用啟動時鎖定的 model。
  if (model) body.model = model;

  const url = resolveChatCompletionsUrl(baseUrl);
  // v1.6.7: apiKey 為空時不送 Authorization（本機 llama.cpp / Ollama 等不需要 key）
  const headers = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};

  await debugLog('info', 'api', 'openai-compat request', {
    baseUrl, model, segments: texts.length, chars: joined.length,
    inputPreview: joined.slice(0, 300), // v1.5.7: 對齊 gemini.js
    // v1.5.8: 本批 prompt 末端注入的條數（同 gemini.js）
    glossaryCount: glossary?.length || 0,
    fixedGlossaryCount: fixedGlossary?.length || 0,
    forbiddenTermsCount: forbiddenTerms?.length || 0,
  });

  const t0 = Date.now();
  const maxRetries = typeof settings?.maxRetries === 'number' ? settings.maxRetries : 3;
  const fetchTimeoutSec = cp.fetchTimeoutSec;
  const timeoutMs = (typeof fetchTimeoutSec === 'number' && fetchTimeoutSec > 0)
    ? fetchTimeoutSec * 1000
    : DEFAULT_FETCH_TIMEOUT_MS;
  const resp = await fetchWithRetry(url, headers, body, { maxRetries, timeoutMs });

  let json;
  try {
    json = await resp.json();
  } catch (parseErr) {
    const ms = Date.now() - t0;
    let rawPreview = '';
    try { rawPreview = await resp.clone().text().then(t => t.slice(0, 200)); } catch { /* noop */ }
    await debugLog('error', 'api', 'openai-compat response not JSON', {
      status: resp.status, elapsed: ms, parseError: parseErr.message, rawPreview,
    });
    throw codedError('customBadResponse', { status: resp.status, preview: rawPreview || 'N/A' },
      `自訂 Provider 回應格式異常（非 JSON）：HTTP ${resp.status}。${rawPreview ? '前 200 字：' + rawPreview : ''}`);
  }
  const ms = Date.now() - t0;

  if (!resp.ok) {
    const errMsg = json?.error?.message || `HTTP ${resp.status}`;
    await debugLog('error', 'api', 'openai-compat error', { status: resp.status, elapsed: ms, error: errMsg });
    throw new Error(errMsg);
  }

  const choice = json?.choices?.[0];
  const finishReason = choice?.finish_reason || 'unknown';
  const text = choice?.message?.content || '';

  if (!text) {
    await debugLog('error', 'api', 'openai-compat empty content', {
      elapsed: ms, finishReason, choicesLength: json?.choices?.length || 0,
    });
    throw codedError('customEmptyContent', { reason: finishReason },
      `自訂 Provider 回傳空內容（finish_reason: ${finishReason}）。`);
  }

  // 抽 usage（OpenAI / OpenRouter 標準結構）
  const u = json?.usage || {};
  const chunkUsage = {
    inputTokens: u.prompt_tokens || 0,
    outputTokens: u.completion_tokens || 0,
    // OpenAI 2024-09 起加的 cache 命中欄位（OpenRouter 也支援）
    cachedTokens: u.prompt_tokens_details?.cached_tokens || u.cached_tokens || 0,
  };

  await debugLog('info', 'api', 'openai-compat response', {
    elapsed: ms,
    segments: texts.length,
    inputTokens: chunkUsage.inputTokens,
    outputTokens: chunkUsage.outputTokens,
    cachedTokens: chunkUsage.cachedTokens,
    finishReason,
    outputPreview: text.slice(0, 300), // v1.5.7: 對齊 gemini.js

  });

  // 拆分對齊（與 Gemini 同邏輯：split by DELIMITER + 移除序號標記;用本批選的 marker.re）
  const parts = text.split(SEP_RE).map(s => s.trim().replace(marker.re, ''));

  // 逐段 fallback（segment count mismatch 與輸出語言錯 chunk 共用,對齊 gemini.js）
  const perSegmentFallback = async () => {
    const aligned = [];
    const aggUsage = { ...chunkUsage };
    for (let fi = 0; fi < texts.length; fi++) {
      let r;
      try {
        r = await translateChunk([texts[fi]], settings, glossary, fixedGlossary, forbiddenTerms);
      } catch (err) {
        // 逐段 fallback 半途失敗：整批 + 已完成段的 usage 掛上 err(對齊 gemini.js 慣例)
        if (err && typeof err === 'object' && !err.usage) err.usage = { ...aggUsage };
        throw err;
      }
      aligned.push(r.parts[0] || '');
      aggUsage.inputTokens += r.usage.inputTokens;
      aggUsage.outputTokens += r.usage.outputTokens;
      aggUsage.cachedTokens += r.usage.cachedTokens || 0;
    }
    return { parts: aligned, usage: aggUsage, hadMismatch: true };
  };

  // 段數不符先試序號標記二次對齊(v2.0.69,對齊 gemini.js;用本批選的 marker),
  // 救不回才 fallback 逐段翻譯
  let aligned = parts;
  if (parts.length !== texts.length) {
    if (texts.length === 1) {
      return { parts: [text.trim()], usage: chunkUsage, hadMismatch: false };
    }
    const realigned = realignByMarkers(text, texts.length, marker);
    if (!realigned) {
      await debugLog('warn', 'api', 'openai-compat segment count mismatch — fallback to per-segment', {
        expected: texts.length, got: parts.length, elapsed: ms,
      });
      return perSegmentFallback();
    }
    await debugLog('info', 'api', 'openai-compat segment count mismatch — realigned via seq markers', {
      expected: texts.length, got: parts.length, elapsed: ms,
    });
    aligned = realigned;
  }

  // v2.0.52:段數對齊但整 chunk 輸出語言錯 → 逐段 fallback(對齊 gemini.js,
  // 單段 chunk 不驗避免無限遞迴)
  if (texts.length > 1 && detectOutputLangMismatch(aligned, settings.targetLanguage)) {
    await debugLog('warn', 'api', 'openai-compat chunk output language mismatch — fallback to per-segment', {
      segments: texts.length, elapsed: ms, targetLanguage: settings.targetLanguage,
    });
    return perSegmentFallback();
  }

  return { parts: aligned, usage: chunkUsage, hadMismatch: false };
}

/**
 * 術語表擷取 — 對齊 lib/gemini.js 的 extractGlossary,介面相同(同一 background
 * dispatch path 下兩條 engine 都能 plug-in)。
 *
 * 走 chat.completions:system = settings.glossary.prompt、user = compressedText。
 * 不走 buildEffectiveSystemInstruction(那會插入翻譯特化規則:SEP 分隔符 / 段序號標記
 * («N» 或 <<<SHINKANSEN_SEG-N>>>) / 段內換行 / 佔位符 / 自動 glossary / 固定術語表 /
 * 黑名單),術語抽取不需要。
 *
 * model:沿用 customProvider.model;為空(llama.cpp / Ollama 預設)時不送 model 欄位。
 * fetch timeout 用 settings.glossary.fetchTimeoutMs(預設 15s,跟 Gemini 對齊)。
 *
 * 回傳格式跟 lib/gemini.js extractGlossary 完全一致,讓 background.js handler
 * 不必 if-else 兩條結構。
 *
 * @param {string} compressedText
 * @param {object} settings 完整設定。會讀 customProvider.* + glossary.*。
 * @returns {Promise<{ glossary: Array<{source:string,target:string}>, usage: {inputTokens:number,outputTokens:number,cachedTokens:number}, fromCache?: boolean, _diag?: string|null }>}
 */
export async function extractGlossary(compressedText, settings) {
  const cp = settings.customProvider || {};
  const { baseUrl, model, apiKey } = cp;
  if (!baseUrl) {
    return { glossary: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, _diag: 'customProvider.baseUrl 未設定' };
  }
  const gc = settings.glossary || {};
  const glossaryPrompt = gc.prompt || '';
  const temperature = gc.temperature ?? 0.1;
  const maxTerms = gc.maxTerms ?? 200;
  const fetchTimeoutMs = gc.fetchTimeoutMs ?? 15_000;

  const body = {
    messages: [
      { role: 'system', content: glossaryPrompt },
      { role: 'user', content: compressedText },
    ],
    stream: false,
  };
  // v2.0.79:術語表抽取打的是同一個 provider endpoint——自訂模型 temperature 留空
  //(null)代表該 provider 不接受此參數,術語表路徑也必須不送,否則主翻譯正常、
  // 一開術語表就 400(issue #60)。術語表自己的 temperature 設定只在有送時生效。
  if (cp.temperature !== null) body.temperature = temperature;
  // v1.8.41 對齊:model 為空(llama.cpp / Ollama)時不送 model 欄位
  if (model) body.model = model;

  const url = resolveChatCompletionsUrl(baseUrl);
  const headers = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};

  await debugLog('info', 'glossary', 'openai-compat glossary extraction request', {
    baseUrl, model, chars: compressedText.length, fetchTimeoutMs,
  });

  const t0 = Date.now();
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), fetchTimeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(abortTimer);
    const reason = err.name === 'AbortError' ? `fetch timeout (${fetchTimeoutMs}ms)` : 'network error';
    await debugLog('error', 'glossary', `openai-compat glossary extraction failed (${reason})`, { error: err.message, elapsed: Date.now() - t0 });
    return { glossary: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, _diag: `${reason}: ${err.message}` };
  }
  // v1.10.46(批次 2-2):json 讀完才清 timer——body 中途吊住時 timer 到點 abort,
  // resp.json() reject 走下方 catch 回 best-effort 空結果,不再無限 pending
  let json;
  try {
    json = await resp.json();
  } catch (parseErr) {
    await debugLog('error', 'glossary', 'openai-compat glossary response body parse failed', { status: resp.status, error: parseErr.message });
    return { glossary: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, _diag: `resp.json() failed: ${parseErr.message}` };
  } finally {
    clearTimeout(abortTimer);
  }
  const ms = Date.now() - t0;
  const u = json?.usage || {};
  const usage = {
    inputTokens: u.prompt_tokens || 0,
    outputTokens: u.completion_tokens || 0,
    cachedTokens: u.prompt_tokens_details?.cached_tokens || u.cached_tokens || 0,
  };

  if (!resp.ok) {
    const errMsg = json?.error?.message || `HTTP ${resp.status}`;
    await debugLog('error', 'glossary', 'openai-compat glossary extraction failed (API)', { status: resp.status, error: errMsg, elapsed: ms });
    return { glossary: [], usage, _diag: `API error ${resp.status}: ${errMsg}` };
  }

  const choice = json?.choices?.[0];
  const finishReason = choice?.finish_reason || 'unknown';
  const rawText = choice?.message?.content || '';
  await debugLog('info', 'glossary', 'openai-compat glossary extraction response', {
    elapsed: ms, usage: u, rawChars: rawText.length, finishReason,
  });

  // JSON 解析容錯邏輯跟 lib/gemini.js extractGlossary 同(見該檔 v0.72 註解)。
  // 兩邊 inline 重複是有意識的選擇:gemini.js 用 candidates[0].content.parts[0].text,
  // openai-compat.js 用 choices[0].message.content,API 結構不同 — 強行抽 helper 介面
  // 反而要傳 rawText + 兩邊各自 usage/finishReason,helper 變成「只 parse string」價值有限。
  // 未來若兩邊都需要新增容錯邏輯(例如 partial JSON),再評估是否抽出。
  let jsonStr = rawText.trim();
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
  } catch (parseErr) {
    await debugLog('warn', 'glossary', 'openai-compat glossary JSON parse failed', {
      error: parseErr.message, finishReason, preview: rawText.slice(0, 500),
    });
    return { glossary: [], usage, _diag: `JSON parse error (finishReason=${finishReason}): ${parseErr.message}, preview: ${rawText.slice(0, 300)}` };
  }

  let entries;
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const arrKey = Object.keys(parsed).find(k => Array.isArray(parsed[k]));
    entries = arrKey ? parsed[arrKey] : null;
  }

  if (!entries) {
    return { glossary: [], usage, _diag: `no array in response (rawText first 500): ${rawText.slice(0, 500)}` };
  }
  if (entries.length === 0) {
    return { glossary: [], usage, _diag: `entries array is empty (rawText first 500): ${rawText.slice(0, 500)}` };
  }

  // v2.0.52:改共用 isValidGlossaryEntry(加擋「target 被填成分類代號」欄位錯置)
  const glossary = entries
    .filter(isValidGlossaryEntry)
    .slice(0, maxTerms);

  if (entries.length > 0 && glossary.length === 0) {
    const sampleDiag = JSON.stringify(entries.slice(0, 3)).slice(0, 500);
    return { glossary: [], usage, _diag: `entries=${entries.length} but 0 valid (missing source/target?). samples: ${sampleDiag}` };
  }

  await debugLog('info', 'glossary', 'openai-compat glossary extraction done', {
    totalEntries: entries.length, validTerms: glossary.length, elapsed: ms, finishReason,
  });

  return { glossary, usage, fromCache: false, _diag: null };
}
