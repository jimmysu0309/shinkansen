// gemini.js — Google Gemini REST API 封裝
// 支援批次翻譯、Service Tier (Flex/Standard/Priority)、除錯 Log。
// v0.69: 新增 extractGlossary() 術語表擷取功能。

import { debugLog } from './logger.js';
// v1.5.7: DELIMITER / packChunks / buildEffectiveSystemInstruction 抽到共用模組，
// 與 lib/openai-compat.js 共用同一份「翻譯 batch 構建」邏輯。
import { DELIMITER, packChunks, buildEffectiveSystemInstruction } from './system-instruction.js';

const MAX_BACKOFF_MS = 8000;

/** 自訂錯誤:RPD 每日配額用盡,不應該被重試。 */
export class DailyQuotaExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DailyQuotaExceededError';
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * v1.6.12:依模型決定 thinkingConfig。Gemini 3+ 改用 thinkingLevel(舊
 * thinkingBudget Google 標 not recommended)。實測(tools/probe-gemini-pro.js):
 *   - gemini-3-pro-preview / gemini-2.5-pro 強制 thinking-only,thinkingBudget=0
 *     會 400 "Budget 0 is invalid. This model only works in thinking mode"
 *   - gemini-3 Pro 不支援 thinkingLevel='minimal',最低支援 'low'
 *   - gemini-3 Flash / Flash Lite 用 thinkingLevel='minimal' = 舊 budget=0 的等效,
 *     thoughts=0 不額外計費
 *
 * 偵測策略:
 *   - 模型名含 "pro"(case-insensitive)→ 'low'(Pro 強制 thinking)
 *   - 否則 → 'minimal'(Flash 系列繼續省 token)
 *
 * 此函式 export 是為了 unit spec 鎖死 model → level 對映。
 */
export function pickThinkingConfig(model) {
  const isPro = /pro/i.test(String(model || ''));
  return { thinkingLevel: isPro ? 'low' : 'minimal' };
}

/**
 * 從 Gemini 429 的 response body 找出爆掉的維度(RPM/TPM/RPD)。
 * 若找不到明確線索回傳 null。
 */
function extractQuotaDimension(json) {
  const details = json?.error?.details;
  if (!Array.isArray(details)) return null;
  for (const d of details) {
    const metric = d?.quotaMetric || d?.metric || '';
    const id = d?.quotaId || '';
    const haystack = `${metric} ${id}`.toLowerCase();
    if (haystack.includes('perday') || haystack.includes('_day')) return 'RPD';
    if (haystack.includes('tokens') && haystack.includes('minute')) return 'TPM';
    if (haystack.includes('requests') && haystack.includes('minute')) return 'RPM';
  }
  return null;
}

/**
 * fetch Gemini API,帶 429 退避重試。
 * - 收到 429 → 讀 Retry-After header(秒數)等待後重試
 * - Retry-After 沒給 → 指數退避 2^n * 500ms(上限 8s)
 * - 爆的是 RPD → 丟 DailyQuotaExceededError,不 retry
 * - 重試次數超過 maxRetries → 丟原錯誤
 */
async function fetchWithRetry(url, body, { maxRetries = 3 } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      await debugLog('error', 'api', 'gemini fetch network error', { error: err.message, attempt });
      if (attempt >= maxRetries) throw new Error('網路錯誤：' + err.message);
      await sleep(Math.min(MAX_BACKOFF_MS, 500 * Math.pow(2, attempt)));
      attempt += 1;
      continue;
    }

    // v0.84: 5xx 伺服器錯誤也重試（Gemini 偶爾回 500/503 服務暫時不可用）
    if (resp.status >= 500 && resp.status < 600) {
      await debugLog('warn', 'api', `gemini ${resp.status} server error`, { status: resp.status, attempt });
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

    // 429 處理
    let bodyJson = null;
    try { bodyJson = await resp.clone().json(); } catch { /* noop */ }
    const dim = extractQuotaDimension(bodyJson);
    const retryAfterHeader = resp.headers.get('retry-after');
    const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;

    await debugLog('warn', 'api', 'gemini 429 rate limit', {
      dimension: dim,
      retryAfter: retryAfterHeader,
      attempt,
      error: bodyJson?.error?.message,
    });

    if (dim === 'RPD') {
      throw new DailyQuotaExceededError('今日 Gemini API 配額已用盡(RPD 達上限),請明天再試或升級付費層級。');
    }

    if (attempt >= maxRetries) {
      const msg = bodyJson?.error?.message || `HTTP 429(${dim || '未知維度'})`;
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
 * v0.69: 術語表擷取 — 從壓縮過的文章摘要中提取專有名詞對照表。
 * v0.70: 改為直接 fetch + AbortController（不走 fetchWithRetry），
 *        因為術語表是 best-effort，不需要重試，且必須在有限時間內回應。
 *
 * @param {string} compressedText 壓縮後的文章摘要（headings + 每段首句等）
 * @param {object} settings 完整設定
 * @returns {Promise<{ glossary: Array<{source:string, target:string, type:string}>, usage: {inputTokens:number, outputTokens:number, cachedTokens:number} }>}
 *
 * 失敗（包含 JSON 格式錯誤、逾時）一律回傳空陣列 + usage，由上層 fallback。
 */
export async function extractGlossary(compressedText, settings) {
  const { apiKey, geminiConfig, glossary: glossaryConfig } = settings;
  const {
    serviceTier,
    topP,
    topK,
    maxOutputTokens,
  } = geminiConfig;

  // v1.7.2: 術語表獨立模型優先(預設 Flash Lite,使用者可在 options 改);空字串
  // / 不存在 / 找不到 model 時 fallback 到主翻譯 model。
  const model = (glossaryConfig?.model || '').trim() || geminiConfig.model;

  const glossaryPrompt = glossaryConfig?.prompt || '';
  const glossaryTemperature = glossaryConfig?.temperature ?? 0.1;
  const maxTerms = glossaryConfig?.maxTerms ?? 200;
  // v0.70: fetch 層級的 timeout — Structured Output 對大輸入可能需要 30–60 秒
  const fetchTimeoutMs = glossaryConfig?.fetchTimeoutMs ?? 55_000;

  // v0.72: 保底至少 4096，作為額外防線。
  const glossaryMaxOutput = Math.max(maxOutputTokens || 0, 4096);

  const body = {
    contents: [{ role: 'user', parts: [{ text: compressedText }] }],
    systemInstruction: { parts: [{ text: glossaryPrompt }] },
    generationConfig: {
      temperature: glossaryTemperature,
      topP,
      topK,
      maxOutputTokens: glossaryMaxOutput,
      // v1.6.12:Pro 系列改用 thinkingLevel='low'(無法完全關閉 thinking),Flash
      // 系列用 'minimal'(thoughts=0,等同舊 budget=0)。詳見 pickThinkingConfig 註解。
      thinkingConfig: pickThinkingConfig(model),
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  if (serviceTier && serviceTier !== 'DEFAULT') {
    body.service_tier = serviceTier.toLowerCase();
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  await debugLog('info', 'glossary', 'glossary extraction request', { model, chars: compressedText.length, fetchTimeoutMs, maxOutputTokens: glossaryMaxOutput, settingsMaxOutput: maxOutputTokens });

  const t0 = Date.now();

  // v0.70: 直接 fetch + AbortController，不走 fetchWithRetry。
  // 術語表是 best-effort：要嘛一次成功，要嘛放棄。不值得 retry 燒時間。
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), fetchTimeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(abortTimer);
    const reason = err.name === 'AbortError' ? `fetch timeout (${fetchTimeoutMs}ms)` : 'network error';
    await debugLog('error', 'glossary', `glossary extraction failed (${reason})`, { error: err.message, elapsed: Date.now() - t0 });
    return { glossary: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, _diag: `${reason}: ${err.message}` };
  }
  clearTimeout(abortTimer);

  let json;
  try {
    json = await resp.json();
  } catch (parseErr) {
    await debugLog('error', 'glossary', 'glossary response body parse failed', { status: resp.status, error: parseErr.message });
    return { glossary: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, _diag: `resp.json() failed: ${parseErr.message}` };
  }
  const ms = Date.now() - t0;
  const meta = json?.usageMetadata || {};
  const usage = {
    inputTokens: meta.promptTokenCount || 0,
    outputTokens: meta.candidatesTokenCount || 0,
    cachedTokens: meta.cachedContentTokenCount || 0,
  };

  if (!resp.ok) {
    const errMsg = json?.error?.message || `HTTP ${resp.status}`;
    await debugLog('error', 'glossary', 'glossary extraction failed (API)', { status: resp.status, error: errMsg, elapsed: ms });
    // v0.70: 回傳 _diag 供 content.js 顯示，方便從頁面 console 看到錯誤原因
    return { glossary: [], usage, _diag: `API error ${resp.status}: ${errMsg}` };
  }

  const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const finishReason = json?.candidates?.[0]?.finishReason || 'unknown';
  await debugLog('info', 'glossary', 'glossary extraction response', {
    elapsed: ms, usage: meta, rawChars: rawText.length, finishReason,
  });

  // v0.72: 不用 responseMimeType 後，模型可能在 JSON 前後附帶說明文字
  // 或用 ```json ... ``` code fence 包裹。需要先提取 JSON 部分再 parse。
  let jsonStr = rawText.trim();

  // 移除 markdown code fence（```json ... ``` 或 ``` ... ```）
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  } else {
    // 找第一個 [ 或 { 到最後一個 ] 或 } 之間的內容
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
    await debugLog('warn', 'glossary', 'glossary JSON parse failed', {
      error: parseErr.message, finishReason,
      preview: rawText.slice(0, 500),
    });
    return { glossary: [], usage, _diag: `JSON parse error (finishReason=${finishReason}): ${parseErr.message}, preview: ${rawText.slice(0, 300)}` };
  }

  // 從各種可能的 JSON 結構中找出術語陣列
  let entries;
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed && typeof parsed === 'object') {
    // 找第一個值是 array 的 key（模型可能用 "terms"、"glossary"、"entries" 等任何 key）
    const arrKey = Object.keys(parsed).find(k => Array.isArray(parsed[k]));
    entries = arrKey ? parsed[arrKey] : null;
  }

  if (!entries) {
    await debugLog('warn', 'glossary', 'glossary result: no array found in response', {
      type: typeof parsed,
      keys: parsed ? Object.keys(parsed).slice(0, 5) : [],
    });
    return { glossary: [], usage, _diag: `no array in response (rawText first 500): ${rawText.slice(0, 500)}` };
  }

  if (entries.length === 0) {
    return { glossary: [], usage, _diag: `entries array is empty (rawText first 500): ${rawText.slice(0, 500)}` };
  }

  // 過濾有效 entry 並截斷到 maxTerms
  const glossary = entries
    .filter(e => e && typeof e.source === 'string' && typeof e.target === 'string' && e.source && e.target)
    .slice(0, maxTerms);

  // v0.75 診斷：若有 entries 但全被過濾掉，回傳前幾筆的結構讓 content.js 能看到
  if (entries.length > 0 && glossary.length === 0) {
    const sampleDiag = JSON.stringify(entries.slice(0, 3)).slice(0, 500);
    return { glossary: [], usage, _diag: `entries=${entries.length} but 0 valid (missing source/target?). samples: ${sampleDiag}` };
  }

  await debugLog('info', 'glossary', 'glossary extraction done', {
    totalEntries: entries.length, validTerms: glossary.length, elapsed: ms, finishReason,
  });

  return { glossary, usage };
}

// v1.5.7: buildEffectiveSystemInstruction 已移至 lib/system-instruction.js（兩個 adapter 共用）。
/**
 * 批次翻譯文字陣列（會自動切成多批送出）。
 * @param {string[]} texts 原文陣列
 * @param {object} settings 完整設定
 * @param {Array<{source:string, target:string}>} [glossary] 可選的術語對照表（v0.69）
 * @param {Array<{source:string, target:string}>} [fixedGlossary] 可選的使用者固定術語表（v1.0.29）
 * @returns {Promise<{ translations: string[], usage: { inputTokens: number, outputTokens: number, cachedTokens: number } }>}
 *
 * 註：`cachedTokens` 來自 Gemini API 回應的 `usageMetadata.cachedContentTokenCount`，
 * 代表本次輸入中被 Gemini implicit context cache 命中的 token 數。
 * 命中的部分 Gemini 會以全價 25% 計費（2.5 系列 Flash/Pro 預設開啟 implicit cache，
 * 命中條件是 prompt 前綴穩定且達到最低門檻：Flash ~1024、Pro ~2048）。
 * 這個數字跟 `lib/cache.js` 的本地 `tc_<sha1>` 翻譯快取是不同概念 ——
 * 本地快取命中的段落根本不會送 API，而 implicit cache 命中的段落有送 API
 * 但前綴（system prompt 那一大段）被 Gemini 內部 cache 省下。
 */
export async function translateBatch(texts, settings, glossary, fixedGlossary, forbiddenTerms) {
  if (!texts?.length) return { translations: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, hadMismatch: false };
  const out = new Array(texts.length);
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let hadMismatch = false; // v0.94: 追蹤本批是否有 segment mismatch
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
  if (!texts?.length) return [];
  const { apiKey, geminiConfig } = settings;
  const {
    model,
    serviceTier,
    temperature,
    topP,
    topK,
    maxOutputTokens,
    systemInstruction,
  } = geminiConfig;

  // v0.89: 多段時加序號標記，幫助模型追蹤段數，降低 segment mismatch 機率
  // 格式：«1» text1 <<<SHINKANSEN_SEP>>> «2» text2 ...
  // 使用 «» 而非 [] 避免跟原文的引註 [3] 或佔位符 ⟦⟧ 衝突。
  // parse 時會用 regex 移除每段開頭的 «N» 前綴，不會洩漏到 DOM。
  const useSeqMarkers = texts.length > 1;
  const markedTexts = useSeqMarkers
    ? texts.map((t, i) => `«${i + 1}» ${t}`)
    : texts;
  const joined = markedTexts.join(DELIMITER);

  // 若本批文字含 ⟦…⟧ 佔位符(content.js 為了保留連結 / 樣式而注入的),
  // 在 systemInstruction 後面追加一條規則,要求 LLM 原樣保留這些標記。
  //
  // v0.71: 建構順序歷史是「行為規則(換行、佔位符)必須緊跟在基礎翻譯指令後面,
  // 術語表是『參考資料』放最後」,避免術語表稀釋 LLM 對佔位符規則的注意力(v0.70 bug)。
  //
  // v1.8.39 重排:為 Gemini implicit cache hit rate 把「本批次包含 N 段」推到最末端、
  // glossary 也後移到使用者級規則之後。詳見 lib/system-instruction.js 的 jsdoc。
  // 行為規則(換行、佔位符)仍緊跟基礎指令,維持 v0.71 的設計核心。
  const effectiveSystem = buildEffectiveSystemInstruction(systemInstruction, texts, joined, glossary, fixedGlossary, forbiddenTerms);

  const body = {
    contents: [{ role: 'user', parts: [{ text: joined }] }],
    systemInstruction: { parts: [{ text: effectiveSystem }] },
    generationConfig: {
      temperature,
      topP,
      topK,
      maxOutputTokens,
      // v1.6.12:依模型動態選 thinkingLevel('low' for Pro, 'minimal' for Flash)。
      // 詳見 pickThinkingConfig 註解;Pro 強制 thinking 不能用 budget=0。
      thinkingConfig: pickThinkingConfig(model),
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  // 只有在使用者明確選擇 flex/standard/priority 時才送 service_tier。
  // 若為 'DEFAULT' 或空值則完全不送此欄位，避免舊模型拒絕。
  // 注意：REST API 欄位名稱用 snake_case（service_tier），值用小寫（flex）,
  // 對應 Google 官方 REST 範例與 JS SDK 慣例。
  if (serviceTier && serviceTier !== 'DEFAULT') {
    body.service_tier = serviceTier.toLowerCase(); // "flex" / "standard" / "priority"
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  await debugLog('info', 'api', 'gemini request', {
    model, serviceTier, segments: texts.length, chars: joined.length,
    // v1.5.7: 送進 LLM 的原文前 300 字 — 將來任何「譯文沒按預期出現」都能對照原文 / 譯文確認 LLM 行為
    inputPreview: joined.slice(0, 300),
    // v1.5.8: 本批 prompt 末端注入的「自動術語表 / 固定術語表 / 禁用詞清單」實際條數，
    // 讓使用者從 Debug 分頁看出：YouTube 字幕的兩個 toggle 是否生效、文章翻譯有沒有讀到設定
    glossaryCount: glossary?.length || 0,
    fixedGlossaryCount: fixedGlossary?.length || 0,
    forbiddenTermsCount: forbiddenTerms?.length || 0,
  });

  const t0 = Date.now();
  const maxRetries = typeof settings?.maxRetries === 'number' ? settings.maxRetries : 3;
  const resp = await fetchWithRetry(url, body, { maxRetries });

  // v0.84: resp.json() 加 try-catch。API 回傳非 JSON 時（HTML 錯誤頁、空回應、
  // CDN 擋下的 502 HTML 頁面等）原本會直接 crash，現在包成可讀的錯誤訊息。
  let json;
  try {
    json = await resp.json();
  } catch (parseErr) {
    const ms = Date.now() - t0;
    // 嘗試讀 raw text 取前 200 字元作為診斷線索
    let rawPreview = '';
    try { rawPreview = await resp.clone().text().then(t => t.slice(0, 200)); } catch { /* noop */ }
    await debugLog('error', 'api', 'gemini response body is not JSON', {
      status: resp.status, elapsed: ms, parseError: parseErr.message, rawPreview,
    });
    throw new Error(`Gemini API 回應格式異常（非 JSON）：HTTP ${resp.status}。${rawPreview ? '回應前 200 字元：' + rawPreview : ''}`);
  }
  const ms = Date.now() - t0;

  if (!resp.ok) {
    await debugLog('error', 'api', 'gemini error', { status: resp.status, elapsed: ms, error: json?.error?.message });
    const msg = json?.error?.message || `HTTP ${resp.status}`;
    throw new Error(msg);
  }

  // v0.84: candidates 結構驗證。API 可能回傳空 candidates（被安全過濾器擋掉、
  // 模型拒絕回應、promptFeedback.blockReason 不為空等情況）。
  const candidate = json?.candidates?.[0];
  const finishReason = candidate?.finishReason || 'unknown';
  const text = candidate?.content?.parts?.[0]?.text || '';

  // 檢查 promptFeedback（整個 prompt 被擋的情況，candidates 會是空陣列）
  const blockReason = json?.promptFeedback?.blockReason;
  if (blockReason) {
    await debugLog('error', 'api', 'gemini prompt blocked', { blockReason, elapsed: ms });
    throw new Error(`Gemini 拒絕處理此請求（promptFeedback.blockReason: ${blockReason}）。可能是安全過濾器誤判，請嘗試縮短段落或調整內容。`);
  }

  // 檢查 candidates 為空或無文字輸出
  if (!candidate || !text) {
    await debugLog('error', 'api', 'gemini empty candidates', {
      elapsed: ms, finishReason,
      candidatesLength: json?.candidates?.length || 0,
      promptFeedback: json?.promptFeedback,
    });
    // 根據 finishReason 給出更有意義的錯誤訊息
    const reasonMessages = {
      SAFETY: '內容被 Gemini 安全過濾器擋下。可能是原文含有敏感內容，請嘗試跳過此段落。',
      RECITATION: 'Gemini 偵測到輸出與已知作品高度重複（recitation filter），請嘗試縮短段落。',
      MAX_TOKENS: '輸出超過 maxOutputTokens 上限。請到設定頁提高上限，或減少每批段落數。',
      OTHER: 'Gemini 回傳空內容（finishReason: OTHER），原因不明。請稍後重試。',
    };
    const friendlyMsg = reasonMessages[finishReason]
      || `Gemini 回傳空內容（finishReason: ${finishReason}）。`;
    throw new Error(friendlyMsg);
  }

  // finishReason 異常警告（有文字但不是正常結束）
  if (finishReason && finishReason !== 'STOP' && finishReason !== 'unknown') {
    await debugLog('warn', 'api', 'gemini unusual finishReason', { finishReason, elapsed: ms, textLength: text.length });
  }

  const meta = json?.usageMetadata || {};
  const chunkUsage = {
    inputTokens: meta.promptTokenCount || 0,
    outputTokens: meta.candidatesTokenCount || 0,
    // Gemini 2.5+ implicit context caching 命中的 token 數（輸入 tokens 的子集）。
    // 未命中或舊模型時欄位不會出現，用 || 0 防呆。
    cachedTokens: meta.cachedContentTokenCount || 0,
  };
  await debugLog('info', 'api', 'gemini response', {
    elapsed: ms,
    segments: texts.length,
    inputTokens: chunkUsage.inputTokens,
    outputTokens: chunkUsage.outputTokens,
    cachedTokens: chunkUsage.cachedTokens,
    finishReason,
    // v1.5.7: LLM 回應的譯文前 300 字 — 與 'gemini request' 的 inputPreview 對照即可診斷
    // 「LLM echo 原文」「譯文被截斷」「譯文跟期望不一樣」這類 case，不必 attach 真實 API 中介。
    outputPreview: text.slice(0, 300),
  });

  // split 後移除序號標記 «N»；多段時額外處理本地模型把 «1» 變形為 N1 的情況
  const SEQ_MARKER_RE = texts.length > 1 ? /^(?:«\d+»|N\d+)\s*/ : /^«\d+»\s*/;
  const parts = text.split(DELIMITER).map(s => s.trim().replace(SEQ_MARKER_RE, ''));
  // 若回傳段數不符，且本批不只一段，則 fallback 改為逐段單獨翻譯，確保對齊
  if (parts.length !== texts.length) {
    await debugLog('warn', 'api', 'segment count mismatch — fallback to per-segment', {
      expected: texts.length, got: parts.length, elapsed: ms,
    });
    if (texts.length === 1) {
      // 單段模式：直接回傳整個 text(LLM 可能多吐了分隔符）
      return { parts: [text.trim()], usage: chunkUsage };
    }
    // 逐段 fallback：每段都會真的再打一次 API，需累加 usage
    // 注意：此時原本這一批的 chunkUsage 已經付過錢了，但結果沒法對齊要丟掉，
    // 所以還是要算進總成本裡。
    const aligned = [];
    const aggUsage = { ...chunkUsage };
    const tFallback0 = Date.now();
    for (let fi = 0; fi < texts.length; fi++) {
      const tSeg0 = Date.now();
      const r = await translateChunk([texts[fi]], settings, glossary, fixedGlossary, forbiddenTerms);
      await debugLog('info', 'api', `fallback segment ${fi + 1}/${texts.length}`, { elapsed: Date.now() - tSeg0 });
      aligned.push(r.parts[0] || '');
      aggUsage.inputTokens += r.usage.inputTokens;
      aggUsage.outputTokens += r.usage.outputTokens;
      aggUsage.cachedTokens += r.usage.cachedTokens || 0;
    }
    await debugLog('warn', 'api', 'fallback complete', { segments: texts.length, fallbackElapsed: Date.now() - tFallback0, originalElapsed: ms });
    return { parts: aligned, usage: aggUsage, hadMismatch: true };
  }
  return { parts, usage: chunkUsage, hadMismatch: false };
}

/**
 * v1.8.0: Streaming 版翻譯——只給 content.js translateUnits 內 batch 0 用。
 *
 * 透過 callbacks 增量回送結果:
 *   onFirstChunk():第一個 SSE chunk 抵達時觸發(讓呼叫端同步 dispatch batch 1+)
 *   onSegment(idx, translation, hadMismatch):incremental parser 解出完整一段譯文時觸發
 * 整批結束 return: { translations, usage, hadMismatch, finishReason }
 *
 * Scope 限制(reports/streaming-probe-2026-04-28.md §6):
 *   ✅ 給 TRANSLATE_BATCH_STREAM(文章翻譯 batch 0)用
 *   ❌ 不給字幕(TRANSLATE_SUBTITLE_BATCH / ASR)用
 *   ❌ 不給術語抽取(EXTRACT_GLOSSARY)用
 *   ❌ 不給 Google Translate / 自訂模型用
 *
 * 跟 translateBatch 的差異:
 *   - 走 streamGenerateContent endpoint(?alt=sse)
 *   - 不做 chunked packBatches(streaming 是單一 request)
 *   - 不做 segment-mismatch 逐段 fallback(那留給呼叫端決定整批 retry)
 *   - 不做 retry on transient errors(streaming 失敗時 partial 可能已 inject,呼叫端決定如何 fallback)
 *
 * @param {string[]} texts batch 0 所有 unit 的原文 array
 * @param {object} settings 完整 settings
 * @param {Array<{source,target,type}>|null} glossary
 * @param {Array<{source,target,type}>|null} fixedGlossary
 * @param {Array<string>|null} forbiddenTerms
 * @param {object} callbacks { onFirstChunk?, onSegment? }
 * @param {AbortSignal} [signal] 跨 streaming + 並行 batch 1+ 的中斷
 */
export async function translateBatchStream(texts, settings, glossary, fixedGlossary, forbiddenTerms, callbacks = {}, signal = undefined) {
  if (!texts?.length) {
    return { translations: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, hadMismatch: false, finishReason: 'STOP' };
  }

  const { apiKey, geminiConfig } = settings;
  const { model, serviceTier, temperature, topP, topK, maxOutputTokens, systemInstruction } = geminiConfig;

  // 跟 translateChunk 一致:多段時加 «N» 序號標記
  const useSeqMarkers = texts.length > 1;
  const markedTexts = useSeqMarkers ? texts.map((t, i) => `«${i + 1}» ${t}`) : texts;
  const joined = markedTexts.join(DELIMITER);

  const effectiveSystem = buildEffectiveSystemInstruction(systemInstruction, texts, joined, glossary, fixedGlossary, forbiddenTerms);

  const body = {
    contents: [{ role: 'user', parts: [{ text: joined }] }],
    systemInstruction: { parts: [{ text: effectiveSystem }] },
    generationConfig: {
      temperature, topP, topK, maxOutputTokens,
      thinkingConfig: pickThinkingConfig(model),
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };
  if (serviceTier && serviceTier !== 'DEFAULT') body.service_tier = serviceTier.toLowerCase();

  // streamGenerateContent endpoint with alt=sse
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  await debugLog('info', 'api', 'gemini stream request', {
    model, segments: texts.length, chars: joined.length,
    inputPreview: joined.slice(0, 200),
    glossaryCount: glossary?.length || 0,
    fixedGlossaryCount: fixedGlossary?.length || 0,
  });

  const t0 = Date.now();
  const SEQ_MARKER_RE = texts.length > 1 ? /^(?:«\d+»|N\d+)\s*/ : /^«\d+»\s*/;

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') {
      throw new Error('streaming aborted');
    }
    throw err;
  }

  if (!resp.ok) {
    let errText = '';
    try { errText = await resp.text(); } catch (_) {}
    await debugLog('error', 'api', 'gemini stream HTTP error', { status: resp.status, error: errText.slice(0, 200) });
    throw new Error(`Gemini API HTTP ${resp.status}${errText ? ': ' + errText.slice(0, 200) : ''}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let allText = '';
  let firstChunkFired = false;
  let segmentsEmitted = 0;
  let lastUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let finishReason = 'unknown';
  let blockReason = null;

  // 增量 emit segment:每收到完整 DELIMITER 就 emit 前一段。流結束時 emit 最後一段。
  // 占位符可能切在 chunk 中間(例如 `⟦/0⟧` 切成 `⟦/0` 跟 `⟧`),但 DELIMITER 是
  // 多字元固定字串(`\n<<<SHINKANSEN_SEP>>>\n`),如果 split 找不到就代表「這一段譯文還沒收完」,
  // 不要 emit。等下一個 chunk 把 DELIMITER 補完才 emit。所以「以 DELIMITER 為 segment 邊界」
  // 自動處理占位符斷裂——占位符在 segment 內部,DELIMITER 不會切到占位符中間。
  function tryEmitSegments() {
    if (!callbacks.onSegment) return;
    const allParts = allText.split(DELIMITER);
    // allParts 最後一個 element 是「尚未完成的當前段落」(因為它後面沒 DELIMITER 接),先不 emit
    const numComplete = allParts.length - 1;
    while (segmentsEmitted < numComplete && segmentsEmitted < texts.length) {
      const segText = allParts[segmentsEmitted].trim().replace(SEQ_MARKER_RE, '');
      callbacks.onSegment(segmentsEmitted, segText, false);
      segmentsEmitted++;
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (!firstChunkFired) {
        firstChunkFired = true;
        try { callbacks.onFirstChunk?.(); } catch (_) { /* swallow */ }
      }

      buffer += decoder.decode(value, { stream: true });

      // SSE event 用 \r\n\r\n 或 \n\n 分隔
      while (true) {
        const m = buffer.match(/\r?\n\r?\n/);
        if (!m) break;
        const eventBlock = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        if (!eventBlock.startsWith('data: ')) continue;
        const dataStr = eventBlock.slice(6);

        let json;
        try {
          json = JSON.parse(dataStr);
        } catch (_) {
          continue;  // SSE chunk 切到 JSON 中間;buffer 下一輪會接上
        }

        const candidate = json?.candidates?.[0];
        const partText = candidate?.content?.parts?.[0]?.text || '';
        const fr = candidate?.finishReason;
        if (fr) finishReason = fr;
        if (json?.promptFeedback?.blockReason) blockReason = json.promptFeedback.blockReason;

        if (partText) {
          allText += partText;
          tryEmitSegments();
        }

        // 每個 SSE event 都帶 usageMetadata,取最後一個就是整批最終 usage
        const meta = json?.usageMetadata;
        if (meta) {
          lastUsage = {
            inputTokens: meta.promptTokenCount || 0,
            outputTokens: meta.candidatesTokenCount || 0,
            cachedTokens: meta.cachedContentTokenCount || 0,
          };
        }
      }
    }
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') {
      throw new Error('streaming aborted');
    }
    throw err;
  } finally {
    try { reader.releaseLock?.(); } catch (_) {}
  }

  const elapsed = Date.now() - t0;

  // 流結束後 emit 最後一段(allText 最後一個 split element 是 trailing segment)
  if (callbacks.onSegment) {
    const allParts = allText.split(DELIMITER);
    while (segmentsEmitted < allParts.length && segmentsEmitted < texts.length) {
      const segText = allParts[segmentsEmitted].trim().replace(SEQ_MARKER_RE, '');
      callbacks.onSegment(segmentsEmitted, segText, false);
      segmentsEmitted++;
    }
  }

  await debugLog('info', 'api', 'gemini stream response', {
    elapsed, segments: texts.length, segmentsEmitted,
    inputTokens: lastUsage.inputTokens,
    outputTokens: lastUsage.outputTokens,
    cachedTokens: lastUsage.cachedTokens,
    finishReason,
    outputPreview: allText.slice(0, 300),
  });

  if (blockReason) {
    throw new Error(`Gemini 拒絕處理此請求(promptFeedback.blockReason: ${blockReason})`);
  }

  if (allText.length === 0) {
    const reasonMsg = {
      SAFETY: '內容被 Gemini 安全過濾器擋下',
      RECITATION: 'Gemini 偵測到輸出與已知作品高度重複(recitation filter)',
      MAX_TOKENS: '輸出超過 maxOutputTokens 上限',
      OTHER: 'Gemini 回傳空內容(finishReason: OTHER)',
    };
    throw new Error(reasonMsg[finishReason] || `Gemini 回傳空內容(finishReason: ${finishReason})`);
  }

  // 計算對齊後的譯文 array(跟 non-streaming 一致),hadMismatch 留給呼叫端決定如何處理
  const translations = allText.split(DELIMITER).map(s => s.trim().replace(SEQ_MARKER_RE, ''));
  const hadMismatch = translations.length !== texts.length;

  if (hadMismatch) {
    await debugLog('warn', 'api', 'gemini stream segment mismatch', {
      expected: texts.length, got: translations.length, elapsed,
    });
  }

  return {
    translations,
    usage: lastUsage,
    hadMismatch,
    finishReason,
  };
}
