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
import { DELIMITER, SEP_RE, MARKER_COMPACT, MARKER_STRONG, packChunks, buildEffectiveSystemInstruction } from './system-instruction.js';
// v1.6.18: thinking 控制 mapping（各家 provider 的 thinking schema 不同，統一成
// thinkingLevel 'auto/off/low/medium/high' + extraBodyJson 進階透傳）
import { buildThinkingPayload } from './openai-compat-thinking.js';

const MAX_BACKOFF_MS = 8000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * fetch chat.completions endpoint，帶 429 / 5xx 退避重試。
 * 與 lib/gemini.js 的 fetchWithRetry 邏輯對齊（除了 quota dimension 提取，
 * OpenAI-compatible provider 的 429 body 結構不一致，這裡只做純退避）。
 */
// 主翻譯 fetch 層級 timeout 預設值。使用者可透過 customProvider.fetchTimeoutSec 覆蓋
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

async function fetchWithRetry(url, headers, body, { maxRetries = 3, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let resp;
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(abortTimer);
      const isTimeout = err.name === 'AbortError';
      const errMsg = isTimeout ? `逾時(${timeoutMs}ms)` : err.message;
      await debugLog('error', 'api', isTimeout ? 'openai-compat fetch timeout' : 'openai-compat fetch network error', { error: err.message, attempt, timeoutMs: isTimeout ? timeoutMs : undefined });
      if (attempt >= maxRetries) throw new Error('網路錯誤：' + errMsg);
      await sleep(Math.min(MAX_BACKOFF_MS, 500 * Math.pow(2, attempt)));
      attempt += 1;
      continue;
    }
    clearTimeout(abortTimer);

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

    if (resp.status !== 429) return resp;

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
      ? retryAfterSec * 1000 + 100
      : Math.min(MAX_BACKOFF_MS, 500 * Math.pow(2, attempt));
    await sleep(waitMs);
    attempt += 1;
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
  if (!baseUrl) throw new Error('customProvider.baseUrl 未設定');
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
  const chunks = packChunks(texts);
  for (const { start, end } of chunks) {
    const slice = texts.slice(start, end);
    const result = await translateChunk(slice, settings, glossary, fixedGlossary, forbiddenTerms);
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
    temperature: typeof temperature === 'number' ? temperature : 0.7,
    stream: false,
    ...thinkingPayload,
  };
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
    throw new Error(`自訂 Provider 回應格式異常（非 JSON）：HTTP ${resp.status}。${rawPreview ? '前 200 字：' + rawPreview : ''}`);
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
    throw new Error(`自訂 Provider 回傳空內容（finish_reason: ${finishReason}）。`);
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
  if (parts.length !== texts.length) {
    await debugLog('warn', 'api', 'openai-compat segment count mismatch — fallback to per-segment', {
      expected: texts.length, got: parts.length, elapsed: ms,
    });
    if (texts.length === 1) {
      return { parts: [text.trim()], usage: chunkUsage, hadMismatch: false };
    }
    const aligned = [];
    const aggUsage = { ...chunkUsage };
    for (let fi = 0; fi < texts.length; fi++) {
      const r = await translateChunk([texts[fi]], settings, glossary, fixedGlossary, forbiddenTerms);
      aligned.push(r.parts[0] || '');
      aggUsage.inputTokens += r.usage.inputTokens;
      aggUsage.outputTokens += r.usage.outputTokens;
      aggUsage.cachedTokens += r.usage.cachedTokens || 0;
    }
    return { parts: aligned, usage: aggUsage, hadMismatch: true };
  }
  return { parts, usage: chunkUsage, hadMismatch: false };
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
    temperature,
    stream: false,
  };
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
  clearTimeout(abortTimer);

  let json;
  try {
    json = await resp.json();
  } catch (parseErr) {
    await debugLog('error', 'glossary', 'openai-compat glossary response body parse failed', { status: resp.status, error: parseErr.message });
    return { glossary: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, _diag: `resp.json() failed: ${parseErr.message}` };
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

  const glossary = entries
    .filter(e => e && typeof e.source === 'string' && typeof e.target === 'string' && e.source && e.target)
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
