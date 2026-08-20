// gemini.js — Google Gemini REST API 封裝
// 支援批次翻譯、Service Tier (Flex/Standard/Priority)、除錯 Log。
// v0.69: 新增 extractGlossary() 術語表擷取功能。

import { debugLog } from './logger.js';
// v1.5.7: DELIMITER / packChunks / buildEffectiveSystemInstruction 抽到共用模組，
// 與 lib/openai-compat.js 共用同一份「翻譯 batch 構建」邏輯。
import { DELIMITER, SEP_RE, MARKER_COMPACT, packChunks, buildEffectiveSystemInstruction, isValidGlossaryEntry, detectOutputLangMismatch, realignByMarkers } from './system-instruction.js';
import { codedError } from './bg-error.js'; // 使用者面對錯誤帶 error code 過協定，content 端查 dict 翻譯

const MAX_BACKOFF_MS = 8000;
// v1.10.46(批次 2-1):429 Retry-After 等待上限。provider 可能回數百秒的 Retry-After,
// MV3 SW 等不到那麼久(30 秒 idle 即可能被回收),無上限等待等於永久卡批次。
// cap 在 30 秒,等完仍 429 就走 maxRetries 放棄路徑回報錯誤。
const RETRY_AFTER_CAP_MS = 30_000;
// 「送到 Instapaper」摘要的輸入字元上限。摘要不需要全文,截斷把最壞 token 成本鎖死
//(CLAUDE.md §4):flash-lite 下 ~12K 字元(~3-4K token)足夠抓主旨,每次摘要遠低於 $0.001。
const MAX_SUMMARY_INPUT_CHARS = 12_000;

/** 自訂錯誤:RPD 每日配額用盡,不應該被重試。 */
export class DailyQuotaExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DailyQuotaExceededError';
    // 錯誤 i18n 協定（lib/bg-error.js）：content 端查 error.bg.dailyQuota 組訊息
    this.skCode = 'dailyQuota';
    this.skParams = null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 空內容 finishReason → error code（error.bg.* dict key 尾段）。
// non-streaming / streaming 兩條路徑共用，沒列出的 finishReason 走 'emptyContent'（帶 {reason}）。
const EMPTY_REASON_CODES = {
  SAFETY: 'emptySafety',
  RECITATION: 'emptyRecitation',
  MAX_TOKENS: 'emptyMaxTokens',
  OTHER: 'emptyOther',
};

/**
 * v1.6.12:依模型決定 thinkingConfig。Gemini 3+ 改用 thinkingLevel(舊
 * thinkingBudget Google 標 not recommended)。實測(tools/probe-gemini-pro.js):
 *   - Pro 系列(gemini-3-pro-preview 等)強制 thinking-only,thinkingBudget=0
 *     會 400 "Budget 0 is invalid. This model only works in thinking mode"
 *   - gemini-3 Pro 不支援 thinkingLevel='minimal',最低支援 'low'
 *   - gemini-3 Flash / Flash Lite 用 thinkingLevel='minimal'(合法範圍內最省)
 *
 * v1.10.18 更正:'minimal' **不保證 thoughts=0**。Google 官方明載
 * 「`minimal` does not guarantee that thinking is off」——minimal 仍可能產生思考
 * token,且照 output 單價計費。舊註解誤寫「thoughts=0 不額外計費」,是 v1.10.18
 * 「漏算 thoughtsTokenCount → 費用低估 3 倍」bug 的認知根源。故 usage 解析一律
 * 走 parseGeminiUsage() 把 thoughts 計入 output(見該函式)。
 *
 * 2026-08-20 更正:gemini-3.7-flash 起 'minimal' 下架——真 API 實測 minimal 回
 * 400 "Thinking level MINIMAL is not supported for this model",low / medium /
 * high 皆 200。版本判定與 modelDropsSamplingParams 同款解析(≥ 3.7 或未來
 * gemini-4+ 都命中),future-proof:新世代一律送 'low'(合法範圍內最省)。
 *
 * 偵測策略:
 *   - 模型名含 "pro"(case-insensitive)→ 'low'(Pro 強制 thinking)
 *   - 版本 ≥ 3.7(含未來 gemini-4+)→ 'low'('minimal' 已下架,送了 400)
 *   - 否則 → 'minimal'(3.6 以前的 Flash 系列繼續省 token)
 *
 * 此函式 export 是為了 unit spec 鎖死 model → level 對映。
 */
export function pickThinkingConfig(model) {
  const m = String(model || '');
  if (/pro/i.test(m)) return { thinkingLevel: 'low' };
  const ver = m.match(/gemini-(\d+)(?:\.(\d+))?/i);
  if (ver) {
    const major = Number(ver[1]);
    const minor = Number(ver[2] || 0);
    if (major > 3 || (major === 3 && minor >= 7)) return { thinkingLevel: 'low' };
  }
  return { thinkingLevel: 'minimal' };
}

/**
 * v1.10.18:統一解析 Gemini usageMetadata,三個呼叫點(translateChunk /
 * translateBatchStream / extractGlossary)共用,避免「同一份計費事實」三套實作 drift。
 *
 * **計費 output = candidatesTokenCount(可見譯文)+ thoughtsTokenCount(思考過程)。**
 * Gemini 3 是 reasoning 模型,兩者在 usageMetadata 是**獨立欄位**,Google 兩者都以
 * output 單價計費。舊版只讀 candidatesTokenCount 漏算思考 token,而 output 單價是
 * input 的 6 倍 → 整筆費用被低估到剩 1/2~1/3(實測使用者帳單 ≈ Shinkansen 紀錄的 3 倍)。
 *
 * 算術依據(2026-06 證據,因測試 key 過期未跑 live 對帳,改採文件 + 真實帳單 ground truth):
 *   - Google 官方論壇 gemini-3-flash-preview 範例:candidates 與 thoughts 分開列
 *   - simonw/llm-gemini #75:candidates=104 / thoughts=989 分開、未內含
 *   - 官方 tokens 文件把 candidates / thoughts / total 列為獨立欄位
 *   → 採「outputTokens = candidates + thoughts」。換新 key 後可用
 *     tools/probe-thoughts-usage.js 跑 total == prompt + candidates + thoughts 再確認。
 *
 * 另回傳 thoughtsTokens 供 debugLog 診斷(不改 DB schema,outputTokens 已含其值)。
 */
export function parseGeminiUsage(meta) {
  const m = meta || {};
  const candidates = m.candidatesTokenCount || 0;
  const thoughts = m.thoughtsTokenCount || 0;
  return {
    inputTokens: m.promptTokenCount || 0,
    outputTokens: candidates + thoughts,
    cachedTokens: m.cachedContentTokenCount || 0,
    thoughtsTokens: thoughts,
  };
}

/**
 * v1.10.18:Gemini 3.x 的 generationConfig sampling 欄位。
 * Gemini 3 **不使用 top-k sampling**(topK 非允許參數,送了被後端忽略),且官方建議
 * Gemini 3 只靠 temperature=1.0、**不要設 topP/topK**(設了可能引發迴圈 / 退化)。
 * 故 Gemini 3 模型一律不送 topP/topK;非 Gemini 3(理論上不該出現,§17 最低基準為
 * Gemini 3 Flash Lite)才帶舊 topP/topK 參數,保留相容。
 *
 * @param {string} model 模型 ID
 * @param {{topP:number, topK:number}} sampling 來自 geminiConfig 的 topP/topK
 * @returns {object} 要 spread 進 generationConfig 的欄位(G3 為空物件)
 */
export function buildSamplingFields(model, { topP, topK } = {}) {
  if (modelDropsSamplingParams(model)) return {};
  if (/gemini-3/i.test(String(model || ''))) return {};
  return { topP, topK };
}

/**
 * v2.0.64:Gemini 3.6 Flash / 3.5 Flash-Lite 起官方淘汰 temperature / top_p / top_k
 * 取樣參數(目前被忽略,日後模型送了直接回 HTTP 400;官方指示「從所有要求中移除」),
 * 確定性需求改由 systemInstruction 明確規則承擔。
 * 判定:版本號 ≥ 3.6,或 3.5-flash-lite(此代起點;同版號的 gemini-3.5-flash 屬前代
 * 不在列)。版本解析對使用者自填的未來模型 ID(gemini-4-* 等)也命中,future-proof。
 */
export function modelDropsSamplingParams(model) {
  const m = String(model || '');
  if (/gemini-3\.5-flash-lite/i.test(m)) return true;
  const ver = m.match(/gemini-(\d+)(?:\.(\d+))?/i);
  if (!ver) return false;
  const major = Number(ver[1]);
  const minor = Number(ver[2] || 0);
  return major > 3 || (major === 3 && minor >= 6);
}

/**
 * temperature 欄位的模型 gating(與 buildSamplingFields 同哲學):淘汰取樣參數的
 * 模型回空物件,其餘照送。呼叫端用 spread 寫進 generationConfig。
 */
export function buildTemperatureField(model, temperature) {
  if (modelDropsSamplingParams(model)) return {};
  return { temperature };
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

// 主翻譯 fetch 層級 timeout。15s = Flash 系列慢 case(~8s)留 2x margin,
// 真正卡死的情境(Gemini 沒回 / 連線吊住)在 15s 後 AbortError,走下面 retry 路徑。
// 預設 preset 都是 Flash 系列(storage.js:617-618),Pro thinking 邊緣情境不納入。
// v2.0.53:這個假設只對「網頁翻譯每批 ~20 段」成立——文件翻譯每批可達 50 段長文,
// 輸出時間遠超 15s(日文書實例:850 段全因 15s 逾時失敗,且 abort 掉的請求
// Google 端照樣計費)。文件路徑由 background 經 geminiConfig.fetchTimeoutMs 覆蓋,
// 本常數只是預設值
const FETCH_TIMEOUT_MS = 15_000;

/**
 * fetch Gemini API,帶 fetch-level timeout + 429 退避重試。
 * - timeoutMs(預設 15s)內沒回應 → AbortError → 走網路錯誤 retry path
 * - 收到 429 → 讀 Retry-After header(秒數)等待後重試
 * - Retry-After 沒給 → 指數退避 2^n * 500ms(上限 8s)
 * - 爆的是 RPD → 丟 DailyQuotaExceededError,不 retry
 * - 重試次數超過 maxRetries → 丟原錯誤
 * - timeoutRetries(預設同 maxRetries):逾時類單獨的重試上限。文件路徑設 1——
 *   放寬到 120s 還逾時代表批太大,重複燒同尺寸請求只會 4 倍計費 0 產出,
 *   交呼叫端(translate-doc 對切重試)縮批處理
 */
// opts.headers:額外 request headers(API key 走 `x-goog-api-key` header 而非 URL
// query string,避免金鑰漏進 proxy / 網路設備 / 錯誤訊息等會記 URL 的地方)
async function fetchWithRetry(url, body, { maxRetries = 3, headers = {}, timeoutMs = FETCH_TIMEOUT_MS, timeoutRetries = null } = {}) {
  const timeoutRetryCap = (typeof timeoutRetries === 'number') ? timeoutRetries : maxRetries;
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
        await debugLog('error', 'api', isTimeout ? 'gemini fetch timeout' : 'gemini fetch network error', { error: err.message, attempt, timeoutMs: isTimeout ? timeoutMs : undefined });
        if (attempt >= (isTimeout ? timeoutRetryCap : maxRetries)) {
          throw isTimeout
            ? codedError('timeout', { ms: timeoutMs }, '網路錯誤：' + errMsg)
            : codedError('network', { msg: err.message }, '網路錯誤：' + errMsg);
        }
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

      if (resp.status !== 429) {
        // 成功 / 非 429 錯誤:body 在 timer 涵蓋下讀完(2-2)
        let bodyText;
        try {
          bodyText = await resp.text();
        } catch (err) {
          const isTimeout = err.name === 'AbortError';
          const errMsg = isTimeout ? `回應讀取逾時(${timeoutMs}ms)` : err.message;
          await debugLog('error', 'api', isTimeout ? 'gemini body read timeout' : 'gemini body read error', { error: err.message, attempt });
          if (attempt >= (isTimeout ? timeoutRetryCap : maxRetries)) {
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
        // API 自帶 error.message（英文，ground truth）原樣傳遞不掛 code；
        // 沒帶才用 http429 code 讓 content 端組「HTTP 429({dim})」
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
  // v1.10.18:fallback 從 0.1 改 1.0(對齊 storage 預設;Gemini 3 設低溫易迴圈 / 退化)。
  const glossaryTemperature = glossaryConfig?.temperature ?? 1.0;
  const maxTerms = glossaryConfig?.maxTerms ?? 200;
  // fetch 層級的 timeout。v0.70 原為 55s(Structured Output 大輸入需 30-60s),v0.72
  // 拿掉 JSON mode 後該理由消失;v1.9.21 對齊主翻譯路徑 15s(術語表用 Flash Lite
  // 典型 2-5s,慢 case ~10s,15s 留 50% margin)。glossaryConfig.fetchTimeoutMs 仍可
  // override(JSON / 工具測試套件直接給值)。
  const fetchTimeoutMs = glossaryConfig?.fetchTimeoutMs ?? 15_000;

  // v0.72: 保底至少 4096，作為額外防線。
  const glossaryMaxOutput = Math.max(maxOutputTokens || 0, 4096);

  const body = {
    contents: [{ role: 'user', parts: [{ text: compressedText }] }],
    systemInstruction: { parts: [{ text: glossaryPrompt }] },
    generationConfig: {
      // v2.0.64:temperature 依模型 gating(3.6+/3.5-flash-lite 淘汰,見 buildTemperatureField)。
      ...buildTemperatureField(model, glossaryTemperature),
      // v1.10.18:Gemini 3 不送 topP/topK(見 buildSamplingFields)。
      ...buildSamplingFields(model, { topP, topK }),
      maxOutputTokens: glossaryMaxOutput,
      // v1.6.12:Pro 系列用 thinkingLevel='low'(無法完全關閉 thinking),Flash 系列
      // 用 'minimal'(合法最省)。注意 minimal 不保證 thoughts=0,計費仍含思考 token,
      // 見 pickThinkingConfig / parseGeminiUsage 註解。
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

  // API key 走 x-goog-api-key header,不放 URL(見 fetchWithRetry 註解)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

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
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(abortTimer);
    const reason = err.name === 'AbortError' ? `fetch timeout (${fetchTimeoutMs}ms)` : 'network error';
    await debugLog('error', 'glossary', `glossary extraction failed (${reason})`, { error: err.message, elapsed: Date.now() - t0 });
    return { glossary: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, _diag: `${reason}: ${err.message}` };
  }
  // v1.10.46(批次 2-2):json 讀完才清 timer——body 中途吊住時 timer 到點 abort,
  // resp.json() reject 走下方 catch 回 best-effort 空結果,不再無限 pending
  let json;
  try {
    json = await resp.json();
  } catch (parseErr) {
    await debugLog('error', 'glossary', 'glossary response body parse failed', { status: resp.status, error: parseErr.message });
    return { glossary: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, _diag: `resp.json() failed: ${parseErr.message}` };
  } finally {
    clearTimeout(abortTimer);
  }
  const ms = Date.now() - t0;
  // v1.10.18:outputTokens 計入 thoughtsTokenCount(見 parseGeminiUsage)。
  const usage = parseGeminiUsage(json?.usageMetadata);

  if (!resp.ok) {
    const errMsg = json?.error?.message || `HTTP ${resp.status}`;
    await debugLog('error', 'glossary', 'glossary extraction failed (API)', { status: resp.status, error: errMsg, elapsed: ms });
    // v0.70: 回傳 _diag 供 content.js 顯示，方便從頁面 console 看到錯誤原因
    return { glossary: [], usage, _diag: `API error ${resp.status}: ${errMsg}` };
  }

  const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const finishReason = json?.candidates?.[0]?.finishReason || 'unknown';
  await debugLog('info', 'glossary', 'glossary extraction response', {
    elapsed: ms, usage, rawChars: rawText.length, finishReason,
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

  // 過濾有效 entry 並截斷到 maxTerms(v2.0.52:改共用 isValidGlossaryEntry,
  // 加擋「target 被填成分類代號」的欄位錯置 entry)
  const glossary = entries
    .filter(isValidGlossaryEntry)
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

// v2.0.11: 一致性掃描的「譯名對照抽取」固定 prompt。機械性任務（在譯文中找
// 指定原文詞的實際譯法子字串），非品味判斷 → 不開使用者自訂，不進 options
const SCAN_RENDERINGS_PROMPT = `You are given proper-noun terms from a source-language book. Each term is followed by numbered passages that are TRANSLATIONS of passages containing that term. For each numbered passage, output the EXACT substring of that passage which is the translated rendering of the term (the name of the same person / place / thing). Rules:
1. The rendering MUST be copied verbatim from the passage. Never invent or normalize text.
2. If you cannot locate the rendering in a passage, use "" for that slot.
3. Reply with JSON only, no explanations, no markdown fence: [{"term":"<term>","renderings":["<r1>","<r2>",...]}] where renderings[i] corresponds to passage [i+1] of that term.`;

/**
 * v2.0.11: 一致性掃描——批次抽取「原文詞在譯文中的實際譯法」。
 * 結構鏡像 extractGlossary（best-effort 單次請求、AbortController timeout、
 * usage 解析、code fence / 雜訊剝除），模型同術語表設定（預設 Flash Lite）。
 * @param {Array<{term:string, samples:Array<{text:string}>}>} items
 * @returns {Promise<{ renderings: Array<{term:string, renderings:string[]}>, usage, _diag?: string }>}
 */
export async function extractTermRenderings(items, settings) {
  const emptyUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const { apiKey, geminiConfig, glossary: glossaryConfig } = settings;
  if (!Array.isArray(items) || items.length === 0) {
    return { renderings: [], usage: emptyUsage };
  }
  const model = (glossaryConfig?.model || '').trim() || geminiConfig.model;
  const fetchTimeoutMs = glossaryConfig?.fetchTimeoutMs ?? 20_000;

  const parts = [];
  for (const item of items) {
    parts.push(`### ${item.term}`);
    item.samples.forEach((s, i) => parts.push(`[${i + 1}] ${s.text}`));
  }
  const userText = parts.join('\n');

  const body = {
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    systemInstruction: { parts: [{ text: SCAN_RENDERINGS_PROMPT }] },
    generationConfig: {
      ...buildTemperatureField(model, glossaryConfig?.temperature ?? 1.0),
      ...buildSamplingFields(model, { topP: geminiConfig.topP, topK: geminiConfig.topK }),
      maxOutputTokens: Math.max(geminiConfig.maxOutputTokens || 0, 4096),
      thinkingConfig: pickThinkingConfig(model),
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };
  if (geminiConfig.serviceTier && geminiConfig.serviceTier !== 'DEFAULT') {
    body.service_tier = geminiConfig.serviceTier.toLowerCase();
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  await debugLog('info', 'scan', 'term renderings request', { model, terms: items.length, chars: userText.length });
  const t0 = Date.now();
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), fetchTimeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(abortTimer);
    const reason = err.name === 'AbortError' ? `fetch timeout (${fetchTimeoutMs}ms)` : 'network error';
    await debugLog('error', 'scan', `term renderings failed (${reason})`, { error: err.message, elapsed: Date.now() - t0 });
    return { renderings: [], usage: emptyUsage, _diag: `${reason}: ${err.message}` };
  }
  let json;
  try {
    json = await resp.json();
  } catch (parseErr) {
    return { renderings: [], usage: emptyUsage, _diag: `resp.json() failed: ${parseErr.message}` };
  } finally {
    clearTimeout(abortTimer);
  }
  const usage = parseGeminiUsage(json?.usageMetadata);
  if (!resp.ok) {
    const errMsg = json?.error?.message || `HTTP ${resp.status}`;
    await debugLog('error', 'scan', 'term renderings failed (API)', { status: resp.status, error: errMsg });
    return { renderings: [], usage, _diag: `API error ${resp.status}: ${errMsg}` };
  }
  const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
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
    await debugLog('warn', 'scan', 'term renderings JSON parse failed', { error: parseErr.message, preview: rawText.slice(0, 300) });
    return { renderings: [], usage, _diag: `JSON parse error: ${parseErr.message}` };
  }
  let entries = Array.isArray(parsed) ? parsed : null;
  if (!entries && parsed && typeof parsed === 'object') {
    const arrKey = Object.keys(parsed).find((k) => Array.isArray(parsed[k]));
    entries = arrKey ? parsed[arrKey] : null;
  }
  const renderings = (entries || [])
    .filter((e) => e && typeof e.term === 'string' && Array.isArray(e.renderings))
    .map((e) => ({ term: e.term, renderings: e.renderings.map((r) => (typeof r === 'string' ? r : '')) }));
  await debugLog('info', 'scan', 'term renderings done', { terms: renderings.length, elapsed: Date.now() - t0, usage });
  return { renderings, usage };
}

/**
 * 為「送到 Instapaper」產生文章摘要(3-4 句,目標語言)。
 *
 * 設計:固定走 Gemini Flash Lite(最便宜),與使用者主翻譯引擎無關——只要有 Gemini
 * key 就能摘要(主引擎可以是 Google 翻譯 / openai-compat)。best-effort:任何失敗
 *(無 key / 無 model / 逾時 / API 錯誤 / 空回應)一律回 { summary: '' },由呼叫端
 * 降級為「不附摘要照常送出」,絕不讓摘要害書籤送不出去。
 *
 * 跨語摘要:text 可能是已翻譯頁的目標語言文字,也可能是未翻譯頁的原文。prompt 統一
 * 要求「用 {targetLangLabel} 輸出」,兩種情況都對(flash-lite 跨語摘要沒問題)。
 *
 * @param {object} args
 * @param {string} args.text 文章純文字
 * @param {string} args.targetLangLabel 目標語言英文 label(storage.LANG_LABELS),注入 prompt
 * @param {string} args.apiKey Gemini API key
 * @param {string} args.model 摘要模型(預設由呼叫端帶 flash-lite)
 * @param {string} [args.serviceTier]
 * @param {number} [args.fetchTimeoutMs=15000]
 * @returns {Promise<{ summary: string, usage: { inputTokens:number, outputTokens:number, cachedTokens:number }, _diag?: string }>}
 */
export async function summarizeArticle({ text, targetLangLabel, apiKey, model, serviceTier, fetchTimeoutMs = 15_000 }) {
  const emptyUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const clean = (text || '').trim();
  if (!clean || !apiKey || !model) {
    return { summary: '', usage: emptyUsage, _diag: 'missing text/apiKey/model' };
  }
  const input = clean.length > MAX_SUMMARY_INPUT_CHARS ? clean.slice(0, MAX_SUMMARY_INPUT_CHARS) : clean;
  const lang = (targetLangLabel || '').trim() || 'the same language as the article';

  // 純文字、無 markdown、無 bullet——Instapaper description 只吃純文字,顯示在項目底下。
  const systemInstruction =
    `You are a concise summarizer. Read the article the user provides and write a summary of 3 to 4 sentences in ${lang}. ` +
    `Capture the article's main point and key takeaways. ` +
    `Output ONLY the summary as a single plain-text paragraph — no preamble, no title, no markdown, no bullet points, no surrounding quotation marks.`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: input }] }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: {
      ...buildTemperatureField(model, 1.0),
      // Gemini 3 不送 topP/topK(見 buildSamplingFields)。
      ...buildSamplingFields(model),
      maxOutputTokens: 1024,
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

  // API key 走 x-goog-api-key header,不放 URL(見 fetchWithRetry 註解)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  await debugLog('info', 'summary', 'instapaper summary request', { model, chars: input.length, targetLang: lang });

  const t0 = Date.now();
  // best-effort:直接 fetch + AbortController,不重試(對齊 extractGlossary)。
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), fetchTimeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(abortTimer);
    const reason = err.name === 'AbortError' ? `fetch timeout (${fetchTimeoutMs}ms)` : 'network error';
    await debugLog('error', 'summary', `instapaper summary failed (${reason})`, { error: err.message, elapsed: Date.now() - t0 });
    return { summary: '', usage: emptyUsage, _diag: `${reason}: ${err.message}` };
  }
  let json;
  try {
    json = await resp.json();
  } catch (parseErr) {
    await debugLog('error', 'summary', 'instapaper summary body parse failed', { status: resp.status, error: parseErr.message });
    return { summary: '', usage: emptyUsage, _diag: `resp.json() failed: ${parseErr.message}` };
  } finally {
    clearTimeout(abortTimer);
  }

  const usage = parseGeminiUsage(json?.usageMetadata);
  if (!resp.ok) {
    const errMsg = json?.error?.message || `HTTP ${resp.status}`;
    await debugLog('error', 'summary', 'instapaper summary failed (API)', { status: resp.status, error: errMsg });
    return { summary: '', usage, _diag: `API error ${resp.status}: ${errMsg}` };
  }

  const rawText = (json?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  await debugLog('info', 'summary', 'instapaper summary done', { elapsed: Date.now() - t0, usage, chars: rawText.length });
  return { summary: rawText, usage };
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
      // v1.10.46(批次 2-5):多 chunk 中途失敗時,前面已完成的 chunk 已經付過費——
      // 把累積 usage 附在 error 上讓呼叫端(background handleTranslate)記帳後再
      // rethrow,否則 content 端收到 error 不會發 LOG_USAGE,已付費 token 系統性
      // 漏記(對帳低估)。translateChunk 逐段 fallback 半途 throw 也會把已累積
      // usage 掛在 err.usage,這裡一併加總。
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

  // v0.89: 多段時加序號標記,幫助模型追蹤段數,降低 segment mismatch 機率
  // 格式:«1» text1 <<<SHINKANSEN_SEP>>> «2» text2 ...
  // 使用 «» 而非 [] 避免跟原文的引註 [3] 或佔位符 ⟦⟧ 衝突。
  // Gemini 主路徑固定用 COMPACT 緊湊格式(token 開銷小);OpenAI-compat 視
  // useStrongSegMarker toggle 決定。
  // parse 時會用 regex 移除每段開頭的 marker 前綴,不會洩漏到 DOM。
  const useSeqMarkers = texts.length > 1;
  const markedTexts = useSeqMarkers
    ? texts.map((t, i) => MARKER_COMPACT.fmt(i + 1) + t)
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
      ...buildTemperatureField(model, temperature),
      // v1.10.18:Gemini 3 不送 topP/topK(見 buildSamplingFields)。
      ...buildSamplingFields(model, { topP, topK }),
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

  // API key 走 x-goog-api-key header,不放 URL(見 fetchWithRetry 註解)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

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
  // v2.0.53:文件翻譯路徑(TRANSLATE_DOC_BATCH)經 geminiOverrides 帶
  // fetchTimeoutMs=120s + timeoutRetries=1;undefined 時 fetchWithRetry 用預設
  //(15s / maxRetries),網頁翻譯行為不變
  const resp = await fetchWithRetry(url, body, {
    maxRetries,
    headers: { 'x-goog-api-key': apiKey },
    timeoutMs: (typeof geminiConfig.fetchTimeoutMs === 'number' && geminiConfig.fetchTimeoutMs > 0)
      ? geminiConfig.fetchTimeoutMs : undefined,
    timeoutRetries: (typeof geminiConfig.timeoutRetries === 'number') ? geminiConfig.timeoutRetries : null,
  });

  // v0.84: resp.json() 加 try-catch。API 回傳非 JSON 時（HTML 錯誤頁、空回應、
  // CDN 擋下的 502 HTML 頁面等）原本會直接 crash，現在包成可讀的錯誤訊息。
  // 批次 8 E4:先 text() 再 JSON.parse——原寫法 resp.json() 失敗後 body 已 disturbed,
  // resp.clone().text() 依 spec 必 throw 被 catch 吞 → rawPreview 恆空,診斷 preview
  // 實質 dead code(CDN 回 HTML 錯誤頁時看不到前 200 字線索)
  let json;
  let rawBody = '';
  try {
    rawBody = await resp.text();
    json = JSON.parse(rawBody);
  } catch (parseErr) {
    const ms = Date.now() - t0;
    const rawPreview = rawBody.slice(0, 200);
    await debugLog('error', 'api', 'gemini response body is not JSON', {
      status: resp.status, elapsed: ms, parseError: parseErr.message, rawPreview,
    });
    throw codedError('badResponse', { status: resp.status, preview: rawPreview || 'N/A' },
      `Gemini API 回應格式異常（非 JSON）：HTTP ${resp.status}。${rawPreview ? '回應前 200 字元：' + rawPreview : ''}`);
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
    throw codedError('blocked', { reason: blockReason },
      `Gemini 拒絕處理此請求（promptFeedback.blockReason: ${blockReason}）。可能是安全過濾器誤判，請嘗試縮短段落或調整內容。`);
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
    throw codedError(EMPTY_REASON_CODES[finishReason] || 'emptyContent', { reason: finishReason }, friendlyMsg);
  }

  // finishReason 異常警告（有文字但不是正常結束）
  if (finishReason && finishReason !== 'STOP' && finishReason !== 'unknown') {
    await debugLog('warn', 'api', 'gemini unusual finishReason', { finishReason, elapsed: ms, textLength: text.length });
  }

  // v1.10.18:outputTokens 計入 thoughtsTokenCount(見 parseGeminiUsage)。
  // cachedTokens 為 Gemini 2.5+ implicit cache 命中的 input 子集,未命中欄位不出現 → 0。
  const chunkUsage = parseGeminiUsage(json?.usageMetadata);
  await debugLog('info', 'api', 'gemini response', {
    elapsed: ms,
    segments: texts.length,
    inputTokens: chunkUsage.inputTokens,
    outputTokens: chunkUsage.outputTokens,
    thoughtsTokens: chunkUsage.thoughtsTokens,
    cachedTokens: chunkUsage.cachedTokens,
    finishReason,
    // v1.5.7: LLM 回應的譯文前 300 字 — 與 'gemini request' 的 inputPreview 對照即可診斷
    // 「LLM echo 原文」「譯文被截斷」「譯文跟期望不一樣」這類 case，不必 attach 真實 API 中介。
    outputPreview: text.slice(0, 300),
  });

  // v0.89: split 後移除序號標記（若有）
  const parts = text.split(SEP_RE).map(s => s.trim().replace(MARKER_COMPACT.re, ''));

  // 逐段 fallback：每段都會真的再打一次 API，需累加 usage
  // 注意：此時原本這一批的 chunkUsage 已經付過錢了，但結果沒法用要丟掉，
  // 所以還是要算進總成本裡。（segment count mismatch 與輸出語言錯 chunk 共用）
  const perSegmentFallback = async () => {
    const aligned = [];
    const aggUsage = { ...chunkUsage };
    const tFallback0 = Date.now();
    for (let fi = 0; fi < texts.length; fi++) {
      const tSeg0 = Date.now();
      let r;
      try {
        r = await translateChunk([texts[fi]], settings, glossary, fixedGlossary, forbiddenTerms);
      } catch (err) {
        // v1.10.46(批次 2-5):逐段 fallback 半途失敗——本批原始請求 + 已完成的逐段
        // 都付過費,把累積 usage 掛在 error 上交給 translateBatch 外層加總(見上)。
        if (err && typeof err === 'object') err.usage = { ...aggUsage };
        throw err;
      }
      await debugLog('info', 'api', `fallback segment ${fi + 1}/${texts.length}`, { elapsed: Date.now() - tSeg0 });
      aligned.push(r.parts[0] || '');
      aggUsage.inputTokens += r.usage.inputTokens;
      aggUsage.outputTokens += r.usage.outputTokens;
      aggUsage.cachedTokens += r.usage.cachedTokens || 0;
    }
    await debugLog('warn', 'api', 'fallback complete', { segments: texts.length, fallbackElapsed: Date.now() - tFallback0, originalElapsed: ms });
    return { parts: aligned, usage: aggUsage, hadMismatch: true };
  };

  // 若回傳段數不符，且本批不只一段：先試序號標記二次對齊(v2.0.69,模型吃掉 SEP
  // 但段首 «N» 都在的場景,見 realignByMarkers 註解),救不回才 fallback 逐段翻譯
  let aligned = parts;
  if (parts.length !== texts.length) {
    if (texts.length === 1) {
      // 單段模式:LLM 多吐了 SEP 字面。不可原樣回傳 text.trim()——協定 token 會注入
      // DOM 並寫進快取(批次 8 E5;逐段 fallback 取 r.parts[0] 正是走這條)。
      // parts 已是 split SEP + strip 序號標記後的段,取非空段以換行 join。
      const joinedSingle = parts.filter(Boolean).join('\n') || text.trim();
      return { parts: [joinedSingle], usage: chunkUsage };
    }
    const realigned = realignByMarkers(text, texts.length, MARKER_COMPACT);
    if (!realigned) {
      // rawHead:realign 也救不回時把原始輸出頭段進 log——outputPreview 300 字
      // 看不到合併點,沒有這欄無法事後判斷是「marker 也被吃」還是其他病型
      await debugLog('warn', 'api', 'segment count mismatch — fallback to per-segment', {
        expected: texts.length, got: parts.length, elapsed: ms, rawHead: text.slice(0, 6000),
      });
      return perSegmentFallback();
    }
    await debugLog('info', 'api', 'segment count mismatch — realigned via seq markers', {
      expected: texts.length, got: parts.length, elapsed: ms,
    });
    aligned = realigned;
  }

  // v2.0.52:段數對齊但整 chunk 輸出語言錯(模型把整個 chunk 翻成原文語言;
  // 實測同 payload 立即重試高度 sticky,原樣重打大機率再錯)→ 走同款逐段
  // fallback——逐段小 payload 能打破 sticky(persisted log 實證 16/16 全成功)。
  // 只驗多段 chunk:單段 chunk 在逐段 fallback 內部呼叫,不驗避免無限遞迴;
  // 逐段結果若仍翻錯,由 translate-doc 頁 batch 級最後防線攔(標 failed 不入庫)。
  if (texts.length > 1 && detectOutputLangMismatch(aligned, settings.targetLanguage)) {
    await debugLog('warn', 'api', 'chunk output language mismatch — fallback to per-segment', {
      segments: texts.length, elapsed: ms, targetLanguage: settings.targetLanguage,
    });
    return perSegmentFallback();
  }

  return { parts: aligned, usage: chunkUsage, hadMismatch: false };
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

  // 跟 translateChunk 一致:多段時加 COMPACT 序號標記(Gemini 主路徑固定用 «N»)
  const useSeqMarkers = texts.length > 1;
  const markedTexts = useSeqMarkers ? texts.map((t, i) => MARKER_COMPACT.fmt(i + 1) + t) : texts;
  const joined = markedTexts.join(DELIMITER);

  const effectiveSystem = buildEffectiveSystemInstruction(systemInstruction, texts, joined, glossary, fixedGlossary, forbiddenTerms);

  const body = {
    contents: [{ role: 'user', parts: [{ text: joined }] }],
    systemInstruction: { parts: [{ text: effectiveSystem }] },
    generationConfig: {
      ...buildTemperatureField(model, temperature),
      // v1.10.18:Gemini 3 不送 topP/topK(見 buildSamplingFields)。
      ...buildSamplingFields(model, { topP, topK }),
      maxOutputTokens,
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
  // API key 走 x-goog-api-key header,不放 URL(見 fetchWithRetry 註解)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

  await debugLog('info', 'api', 'gemini stream request', {
    model, segments: texts.length, chars: joined.length,
    inputPreview: joined.slice(0, 200),
    glossaryCount: glossary?.length || 0,
    fixedGlossaryCount: fixedGlossary?.length || 0,
  });

  const t0 = Date.now();

  // 跟 fetchWithRetry 一致的 15s headers timeout — 真正卡死(Gemini 不回 response headers)
  // 在 FETCH_TIMEOUT_MS 後 AbortError。headers 收到後 clearTimeout,stream phase 改靠
  // 外部 signal 控制(user 按 × 取消或 background.js inFlightStreams 清掉時 abort)。
  // 用 internal AC + forward external signal,讓 ac.signal 同時 cover headers timeout
  // 跟外部 cancel 兩條 abort path;外層 try/finally 統一清掉 listener 防 leak。
  const ac = new AbortController();
  let headersTimer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  const onExternalAbort = () => ac.abort();
  if (signal?.aborted) ac.abort();
  else signal?.addEventListener('abort', onExternalAbort);

  try {
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    clearTimeout(headersTimer);
    headersTimer = null;
  } catch (err) {
    if (headersTimer) clearTimeout(headersTimer);
    if (signal?.aborted) {
      throw new Error('streaming aborted');
    }
    if (err?.name === 'AbortError') {
      throw new Error(`streaming fetch timeout (${FETCH_TIMEOUT_MS}ms)`);
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
    const allParts = allText.split(SEP_RE);
    // allParts 最後一個 element 是「尚未完成的當前段落」(因為它後面沒 DELIMITER 接),先不 emit
    const numComplete = allParts.length - 1;
    while (segmentsEmitted < numComplete && segmentsEmitted < texts.length) {
      const segText = allParts[segmentsEmitted].trim().replace(MARKER_COMPACT.re, '');
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

        // 每個 SSE event 都帶 usageMetadata,取最後一個就是整批最終 usage。
        // v1.10.18:outputTokens 計入 thoughtsTokenCount(見 parseGeminiUsage)。
        const meta = json?.usageMetadata;
        if (meta) {
          lastUsage = parseGeminiUsage(meta);
        }
      }
    }
  } catch (err) {
    // 中途失敗 / 使用者取消時，SSE 已解析出的 usage(每個 event 都帶 usageMetadata)
    // 是已付費 token——掛在 err.usage 讓呼叫端記帳(對齊 translateBatch 的
    // err.usage 慣例)，否則取消一次 streaming 這筆錢就永遠漏帳。
    if (signal?.aborted || err?.name === 'AbortError') {
      const abortErr = new Error('streaming aborted');
      abortErr.usage = lastUsage;
      throw abortErr;
    }
    if (err && typeof err === 'object' && !err.usage) err.usage = lastUsage;
    throw err;
  } finally {
    try { reader.releaseLock?.(); } catch (_) {}
  }

  const elapsed = Date.now() - t0;

  // 流結束後 emit 最後一段(allText 最後一個 split element 是 trailing segment)
  if (callbacks.onSegment) {
    const allParts = allText.split(SEP_RE);
    while (segmentsEmitted < allParts.length && segmentsEmitted < texts.length) {
      const segText = allParts[segmentsEmitted].trim().replace(MARKER_COMPACT.re, '');
      callbacks.onSegment(segmentsEmitted, segText, false);
      segmentsEmitted++;
    }
  }

  await debugLog('info', 'api', 'gemini stream response', {
    elapsed, segments: texts.length, segmentsEmitted,
    inputTokens: lastUsage.inputTokens,
    outputTokens: lastUsage.outputTokens,
    thoughtsTokens: lastUsage.thoughtsTokens,
    cachedTokens: lastUsage.cachedTokens,
    finishReason,
    outputPreview: allText.slice(0, 300),
  });

  if (blockReason) {
    const err = codedError('blocked', { reason: blockReason },
      `Gemini 拒絕處理此請求(promptFeedback.blockReason: ${blockReason})`);
    err.usage = lastUsage; // blocked 前的 input token 已計費，交呼叫端記帳
    throw err;
  }

  if (allText.length === 0) {
    const reasonMsg = {
      SAFETY: '內容被 Gemini 安全過濾器擋下',
      RECITATION: 'Gemini 偵測到輸出與已知作品高度重複(recitation filter)',
      MAX_TOKENS: '輸出超過 maxOutputTokens 上限',
      OTHER: 'Gemini 回傳空內容(finishReason: OTHER)',
    };
    const err = codedError(EMPTY_REASON_CODES[finishReason] || 'emptyContent', { reason: finishReason },
      reasonMsg[finishReason] || `Gemini 回傳空內容(finishReason: ${finishReason})`);
    err.usage = lastUsage; // 空輸出時 input(+thinking)token 已計費，交呼叫端記帳
    throw err;
  }

  // 計算對齊後的譯文 array(跟 non-streaming 一致),hadMismatch 留給呼叫端決定如何處理
  let translations = allText.split(SEP_RE).map(s => s.trim().replace(MARKER_COMPACT.re, ''));
  let hadMismatch = translations.length !== texts.length;

  if (hadMismatch) {
    // v2.0.69:先試序號標記二次對齊(模型吃掉 SEP 但 «N» 都在,見 realignByMarkers)。
    // 成功時增量 emit 過的段可能因 SEP 缺失整體錯位,全部用對齊後版本重新 emit 覆蓋
    // (呼叫端 injectTranslation 對已注入 unit 重注入是既有安全模式——同 hadMismatch
    // retry 的覆蓋路徑),並回報 hadMismatch=false 讓呼叫端不必整批重翻。
    const realigned = realignByMarkers(allText, texts.length, MARKER_COMPACT);
    if (realigned) {
      await debugLog('info', 'api', 'gemini stream segment mismatch — realigned via seq markers', {
        expected: texts.length, got: translations.length, elapsed,
      });
      if (callbacks.onSegment) {
        // 只補發「沒 emit 過」或「內容跟先前 emit 版本不同」的段:合併點之前的段
        // SEP-split 與 realign 結果相同,重注入等內容會觸發 A3 零 mutation 假 echo
        // 判定(v2.0.65),跳過;合併點之後整體錯位,用對齊後版本覆蓋
        for (let i = 0; i < realigned.length; i++) {
          if (i >= segmentsEmitted || realigned[i] !== translations[i]) {
            callbacks.onSegment(i, realigned[i], false);
          }
        }
      }
      translations = realigned;
      hadMismatch = false;
    } else {
      await debugLog('warn', 'api', 'gemini stream segment mismatch', {
        expected: texts.length, got: translations.length, elapsed,
      });
    }
  }

  // v2.0.77:段數對齊但整批輸出語言錯(同 non-streaming translateChunk 的 v2.0.52
  // 防護;此病型 sticky,不擋的話錯語言譯文會經 DONE 寫進快取永久污染)。掛進既有
  // hadMismatch 通道:background 不寫快取 + discard 記帳,content 端 reject 後走
  // non-streaming 重翻——該路徑有逐段 fallback 可打破 sticky。只驗多段批
  // (單段樣本太短,detectOutputLangMismatch 誤判率高,與 non-streaming 同條件)。
  if (!hadMismatch && texts.length > 1 && detectOutputLangMismatch(translations, settings.targetLanguage)) {
    await debugLog('warn', 'api', 'gemini stream output language mismatch — flag hadMismatch for retry', {
      segments: texts.length, elapsed, targetLanguage: settings.targetLanguage,
    });
    hadMismatch = true;
  }

  return {
    translations,
    usage: lastUsage,
    hadMismatch,
    finishReason,
  };
  } finally {
    // 統一清 external signal listener + 防 leak headers timer(catch 路徑 throw 之前
    // 已清,但成功路徑 / post-stream throw 都靠這條 finally 兜底)
    if (headersTimer) clearTimeout(headersTimer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}
