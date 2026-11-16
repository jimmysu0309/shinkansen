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
// 自己處理配額；429 退避重試由 lib/llm-common.js fetchWithRetry 處理（與 Gemini 共用，
// 2026-09-12 批次 6 §5.1 收斂；本檔只剩 request body 組裝與 choices / usage 形狀抽取）。
//
// systemInstruction 構建：使用者自訂的 customProvider.systemPrompt 是 base，
// 其後由 buildEffectiveSystemInstruction 自動追加：多段分隔符規則 / 段內換行
// 規則 / 佔位符規則 / 自動 glossary / 使用者固定術語表 / 中國用語黑名單。
// 黑名單與固定術語表是「跨 provider 共用」（Jimmy 設計決定 #3）。

import { debugLog } from './logger.js';
import { DELIMITER, MARKER_COMPACT, MARKER_STRONG, packChunks, buildEffectiveSystemInstruction, isValidGlossaryEntry } from './system-instruction.js';
// v1.6.18: thinking 控制 mapping（各家 provider 的 thinking schema 不同，統一成
// thinkingLevel 'auto/off/low/medium/high' + extraBodyJson 進階透傳）
import { buildThinkingPayload } from './openai-compat-thinking.js';
import { codedError } from './bg-error.js'; // 使用者面對錯誤帶 error code 過協定，content 端查 dict 翻譯

import {
  fetchWithRetry, readJsonBody, alignAndFallback, runChunkedBatch, emptyContentError, parseLlmJson, emptyUsage,
  normalizeMessageContent,
} from './llm-common.js';

// 主翻譯 fetch 層級 timeout 預設值。使用者可透過 customProvider.fetchTimeoutSec 覆蓋。
// 2026-07-27 從 15s 調成 90s：OpenRouter 上的 reasoning 模型（GPT / Claude 旗艦）
// 非 streaming 要等整批生成完才回 body，15s 對一批 20 段幾乎必逾時（Jimmy 實測
// ~openai/gpt-latest 網頁翻譯每批三連 body read timeout）
const DEFAULT_FETCH_TIMEOUT_MS = 90_000;

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
  // 分批外層（packChunks + 累加 usage + 中途 throw 掛已付費 usage）走 llm-common runChunkedBatch
  return runChunkedBatch(texts, settings,
    (slice) => translateChunk(slice, settings, glossary, fixedGlossary, forbiddenTerms), packChunks);
}

async function translateChunk(texts, settings, glossary, fixedGlossary, forbiddenTerms) {
  if (!texts?.length) return { parts: [], usage: emptyUsage() };
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
  const fetchOpts = { maxRetries, timeoutMs, headers, logPrefix: 'openai-compat' };
  const resp = await fetchWithRetry(url, body, fetchOpts);

  // API 回傳非 JSON 時帶前 200 字 preview 拋 customBadResponse（llm-common readJsonBody）
  const badResponseOpts = {
    t0, logPrefix: 'openai-compat', errorCode: 'customBadResponse',
    message: (status, preview) => `自訂 Provider 回應格式異常（非 JSON）：HTTP ${status}。${preview ? '前 200 字：' + preview : ''}`,
  };
  let json = await readJsonBody(resp, badResponseOpts);
  const ms = Date.now() - t0;

  if (!resp.ok) {
    const errMsg = json?.error?.message || `HTTP ${resp.status}`;
    // 批次 8 E8（code review 2026-08-03）:reasoning 模型（OpenAI o 系列等）只吃自家預設
    // temperature,帶值直接 400。v2.0.79 已提供「留空=不送」的設定逃生口;這裡補自動層:
    // 400 且錯誤訊息點名 temperature、body 有送該欄位時,拿掉後原樣重打一次（僅一次,
    // 非遞迴）。gemini.js 有 modelDropsSamplingParams gating,custom 路徑靠這條對齊。
    if (resp.status === 400 && ('temperature' in body) && /temperature/i.test(errMsg)) {
      await debugLog('warn', 'api', 'openai-compat 400 mentions temperature — retry once without it', {
        model, error: errMsg,
      });
      delete body.temperature;
      const retryResp = await fetchWithRetry(url, body, fetchOpts);
      json = await readJsonBody(retryResp, badResponseOpts);
      if (!retryResp.ok) {
        const retryErrMsg = json?.error?.message || `HTTP ${retryResp.status}`;
        await debugLog('error', 'api', 'openai-compat error (after temperature retry)', {
          status: retryResp.status, error: retryErrMsg,
        });
        throw new Error(retryErrMsg);
      }
      // 重試成功:後續流程只讀 json,直接落下去走正常解析
    } else {
      await debugLog('error', 'api', 'openai-compat error', { status: resp.status, elapsed: ms, error: errMsg });
      throw new Error(errMsg);
    }
  }

  const choice = json?.choices?.[0];
  const finishReason = choice?.finish_reason || 'unknown';
  const text = normalizeMessageContent(choice?.message?.content);

  // 抽 usage（OpenAI / OpenRouter 標準結構）
  // 2026-09-11 code review §3.5-2：提前到 empty 檢查之前——空內容（reasoning 模型把
  // 預算燒在 thinking 上）時 prompt + completion token 已計費，掛 err.usage 讓
  // translateBatch 外層加總、background 記帳（對齊 gemini.js 兩條路徑）。
  const chunkUsage = parseOpenAiUsage(json?.usage);

  if (!text) {
    await debugLog('error', 'api', 'openai-compat empty content', {
      elapsed: ms, finishReason, choicesLength: json?.choices?.length || 0,
    });
    // usage 掛在 err 交呼叫端記帳（llm-common emptyContentError；OpenAI finish_reason 小寫，
    // 不套 Gemini 的 SAFETY / RECITATION 對照表，一律 customEmptyContent）
    throw emptyContentError(finishReason, chunkUsage, {
      codes: {}, messages: {},
      fallbackCode: 'customEmptyContent',
      fallbackMessage: `自訂 Provider 回傳空內容（finish_reason: ${finishReason}）。`,
    });
  }

  await debugLog('info', 'api', 'openai-compat response', {
    elapsed: ms,
    segments: texts.length,
    inputTokens: chunkUsage.inputTokens,
    outputTokens: chunkUsage.outputTokens,
    cachedTokens: chunkUsage.cachedTokens,
    finishReason,
    outputPreview: text.slice(0, 300), // v1.5.7: 對齊 gemini.js

  });

  // split 對齊 / 截斷不採信（§3.5-1，finish_reason 'length'）/ 序號標記 realign / 逐段 fallback /
  // 輸出語言驗證全部走 llm-common alignAndFallback——與 gemini.js 同一份實作；marker 用本批選的
  // COMPACT / STRONG。
  return alignAndFallback({
    texts, text, marker, chunkUsage, finishReason,
    truncatedFinishReason: 'length',
    makeTruncatedError: () => codedError('customTruncated', { reason: finishReason },
      '自訂 Provider 輸出被截斷（finish_reason: length）。請減少每批段落數，或在進階 JSON 提高 max_tokens。'),
    translateOne: (t) => translateChunk([t], settings, glossary, fixedGlossary, forbiddenTerms),
    targetLanguage: settings.targetLanguage,
    elapsedMs: ms,
    logPrefix: 'openai-compat',
  });
}

/** 抽 usage（OpenAI / OpenRouter 標準結構；cached_tokens 是 OpenAI 2024-09 起的 cache 命中欄位）。 */
function parseOpenAiUsage(u) {
  const x = u || {};
  return {
    inputTokens: x.prompt_tokens || 0,
    outputTokens: x.completion_tokens || 0,
    cachedTokens: x.prompt_tokens_details?.cached_tokens || x.cached_tokens || 0,
  };
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
    return { glossary: [], usage: emptyUsage(), _diag: 'customProvider.baseUrl 未設定' };
  }
  const gc = settings.glossary || {};
  const glossaryPrompt = gc.prompt || '';
  const temperature = gc.temperature ?? 0.1;
  const maxTerms = gc.maxTerms ?? 200;
  const fetchTimeoutMs = gc.fetchTimeoutMs ?? 15_000;

  // 與主翻譯同一支 thinking / 額外請求欄位組裝：術語表抽取打的是同一個 endpoint，使用者為了讓
  // 這個 provider 能用而設的 extraBodyJson（必填的自訂欄位）與 thinking 開關原本只套在主翻譯——
  // 主翻譯正常、術語表抽取卻被拒絕或開著 thinking 把 15 秒逾時用光
  const thinkingPayload = buildThinkingPayload({
    baseUrl, model,
    level: cp.thinkingLevel || 'auto',
    extraBodyRaw: cp.extraBodyJson || '',
    onWarn: (msg) => { debugLog('warn', 'glossary', `customProvider thinking config: ${msg}`); },
  });
  const body = {
    messages: [
      { role: 'system', content: glossaryPrompt },
      { role: 'user', content: compressedText },
    ],
    stream: false,
    ...thinkingPayload,
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
  const post = () => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  try {
    resp = await post();
    // 與主翻譯同一條自動退路：400 且錯誤訊息點名 temperature → 拿掉後原樣重打一次（僅一次，
    // 共用同一個逾時計時）。術語表有自己的 temperature 設定，使用者不一定知道要去把它清空
    if (resp.status === 400 && ('temperature' in body)) {
      let errText = '';
      try { errText = await resp.clone().text(); } catch (_) { /* 讀不到就不重試 */ }
      if (/temperature/i.test(errText)) {
        await debugLog('warn', 'glossary', 'openai-compat glossary 400 mentions temperature — retry once without it', { model });
        delete body.temperature;
        resp = await post();
      }
    }
  } catch (err) {
    clearTimeout(abortTimer);
    const reason = err.name === 'AbortError' ? `fetch timeout (${fetchTimeoutMs}ms)` : 'network error';
    await debugLog('error', 'glossary', `openai-compat glossary extraction failed (${reason})`, { error: err.message, elapsed: Date.now() - t0 });
    return { glossary: [], usage: emptyUsage(), _diag: `${reason}: ${err.message}` };
  }
  // v1.10.46(批次 2-2):json 讀完才清 timer——body 中途吊住時 timer 到點 abort,
  // resp.json() reject 走下方 catch 回 best-effort 空結果,不再無限 pending
  let json;
  try {
    json = await resp.json();
  } catch (parseErr) {
    await debugLog('error', 'glossary', 'openai-compat glossary response body parse failed', { status: resp.status, error: parseErr.message });
    return { glossary: [], usage: emptyUsage(), _diag: `resp.json() failed: ${parseErr.message}` };
  } finally {
    clearTimeout(abortTimer);
  }
  const ms = Date.now() - t0;
  const u = json?.usage || {};
  const usage = parseOpenAiUsage(u);

  if (!resp.ok) {
    const errMsg = json?.error?.message || `HTTP ${resp.status}`;
    await debugLog('error', 'glossary', 'openai-compat glossary extraction failed (API)', { status: resp.status, error: errMsg, elapsed: ms });
    return { glossary: [], usage, _diag: `API error ${resp.status}: ${errMsg}` };
  }

  const choice = json?.choices?.[0];
  const finishReason = choice?.finish_reason || 'unknown';
  const rawText = normalizeMessageContent(choice?.message?.content);
  await debugLog('info', 'glossary', 'openai-compat glossary extraction response', {
    elapsed: ms, usage: u, rawChars: rawText.length, finishReason,
  });

  // JSON 剝殼走 llm-common parseLlmJson（與 gemini.js extractGlossary / extractTermRenderings 共用，
  // 2026-09-12 批次 6 收斂；原本兩邊各 inline 一份）
  const parsedJson = parseLlmJson(rawText);
  if (!parsedJson.ok) {
    await debugLog('warn', 'glossary', 'openai-compat glossary JSON parse failed', {
      error: parsedJson.error.message, finishReason, preview: rawText.slice(0, 500),
    });
    return { glossary: [], usage, _diag: `JSON parse error (finishReason=${finishReason}): ${parsedJson.error.message}, preview: ${rawText.slice(0, 300)}` };
  }
  const { entries } = parsedJson;

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
