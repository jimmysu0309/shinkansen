// openai-compat-thinking.js — v1.6.18
// 自訂模型(OpenAI 相容端點)的 thinking 控制 mapping
//
// 各家 provider thinking schema 差異對照(2026-04 校準,文件來源見 CHANGELOG):
//   OpenRouter unified  : reasoning: { effort: 'low'/'medium'/'high', exclude: true }
//   DeepSeek native     : thinking: { type: 'enabled'/'disabled' }（request body 頂層）
//   Anthropic Claude    : thinking: { type: 'enabled'/'disabled'/'adaptive', budget_tokens }
//   OpenAI o-series     : reasoning_effort: 'minimal'/'low'/'medium'/'high'
//   Grok (xAI)          : reasoning_effort: 'low'/'medium'/'high'/'xhigh'(只多 agent model 支援)
//   Qwen                : enable_thinking: true/false（request body 頂層）
//
//   2026-09-11 code review §3.5-3：DeepSeek / Qwen 原本包在 `extra_body` 字面 key 下——那是
//   Python SDK 的客戶端包裝（SDK 會把 extra_body 內容攤平到 HTTP body），我們是直接 fetch
//   raw JSON，送 `{ extra_body: {...} }` 對端點是未知欄位被忽略 = thinking 設定 no-op。
//   改成頂層 `thinking` / `enable_thinking`（各家 curl 範例的 raw body 形態）。
//   OpenAI-compat 通用  : reasoning_effort: 'none'/'low'/'medium'/'high'（OpenAI 標準，
//                         所有 aggregator / Fireworks / Together / Groq / DeepInfra / Cerebras 等
//                         與自架 OpenAI-compat proxy（LiteLLM 等）的最大公約數）
//
// 設計策略:
//   1. user 的 thinkingLevel 為 'auto' → 不送任何 thinking 參數,由 provider 自選
//   2. 偵測 baseUrl 含 openrouter.ai → 一律用 OpenRouter unified reasoning(99% 使用者走這條)
//   3. baseUrl 直連各家 vendor 官方 → 用對應 provider 的官方 schema
//   4. baseUrl 不認得 → 預設走 OpenAI-compat 通用 schema（reasoning_effort 是 ecosystem
//      最大公約數，vendor 不支援也只會被忽略不會 4xx；比寫死 aggregator 名單更穩健，
//      自動涵蓋未來新冒出的 aggregator 與所有自架 proxy 場景）
//   5. user 的 extraBodyJson(進階)→ deep merge 到結果,可覆蓋 1-4 步的自動 mapping
//
// Responses API 格式（customProvider.apiFormat === 'responses'，issue #74）：
//   思考強度的標準寫法是 `reasoning: { effort }`（Chat Completions 的頂層 `reasoning_effort`
//   在這個格式下不存在），各家 vendor 的原生欄位（thinking / enable_thinking）也不屬於這個格式，
//   所以除了 'auto' 不送之外一律走 `reasoning.effort`，見 buildResponsesThinking。

/**
 * 偵測 baseUrl + model name 屬於哪個 provider。
 * 偵測順序:OpenRouter(host)→ 其他依 baseUrl host → fallback 走 OpenAI-compat 通用。
 *
 * 為什麼不用 model name 推 vendor schema：過去版本曾在 baseUrl 不認得時改用 model 名
 * 推 vendor（例 model 含 'qwen' → 走 Qwen 原生 enable_thinking），但實際上
 * 「未知 baseUrl」最常見的場景是 aggregator（Fireworks / Together / Groq / DeepInfra 等）
 * 或自架 OpenAI-compat proxy（LiteLLM），這些都吃 OpenAI 標準 reasoning_effort，
 * 不認 vendor 原生欄位 → 送錯會被靜默忽略（thinking 設定無效）。改成 default 走通用
 * schema 後，送 reasoning_effort 即使 vendor 不支援也只會被忽略，反而比送 vendor 原生
 * 欄位給未知端點安全。user 真要直連自架 vendor 原生 endpoint 可用 extraBodyJson 覆蓋。
 *
 * @returns {'openrouter' | 'deepseek' | 'claude' | 'openai-o' | 'grok' | 'qwen' | 'openai-compat-generic'}
 */
export function detectProvider(baseUrl, model) {
  const url = String(baseUrl || '').toLowerCase();
  const m = String(model || '').toLowerCase();

  if (/openrouter\.ai/.test(url)) return 'openrouter';
  if (/api\.deepseek\.com/.test(url)) return 'deepseek';
  if (/api\.anthropic\.com|claude/.test(url)) return 'claude';
  if (/api\.x\.ai/.test(url)) return 'grok';
  if (/api\.openai\.com/.test(url) && /^o[1-9]/.test(m)) return 'openai-o';
  if (/dashscope|aliyun/.test(url)) return 'qwen';

  // baseUrl 不在 vendor 官方名單 → 預設 OpenAI-compat 通用 schema(reasoning_effort)
  return 'openai-compat-generic';
}

/**
 * 依 provider 與 thinking level 產生對應的 request body 片段。
 * 設計重點:
 *   - 'auto' 永遠回 {}(不干涉,讓 provider 自選預設)
 *   - 各 provider 的 'off' 寫法不同:
 *     OpenRouter 沒真 disable,只能 exclude(內部 reason 但不回 token)
 *     DeepSeek thinking.type='disabled'
 *     Claude thinking.type='disabled'
 *     OpenAI o-series 沒 disable,最低用 'minimal'
 *     Grok 不支援 disable,off 時索性不送
 *     Qwen enable_thinking=false
 *     OpenAI-compat 通用 reasoning_effort='none'(OpenAI 標準 disable 寫法)
 */
export function buildNativeThinking(provider, level, apiFormat) {
  if (!level || level === 'auto') return {};
  if (apiFormat === 'responses') return buildResponsesThinking(provider, level);

  switch (provider) {
    case 'openrouter':
      if (level === 'off') return { reasoning: { exclude: true } };
      return { reasoning: { effort: level } };

    case 'deepseek':
      // 頂層 thinking（非 extra_body，見檔頭 §3.5-3 註解）
      return { thinking: { type: level === 'off' ? 'disabled' : 'enabled' } };

    case 'claude':
      if (level === 'off') return { thinking: { type: 'disabled' } };
      return { thinking: { type: 'adaptive' } };

    case 'openai-o':
      // 'off' 用 'minimal'(no real disable);'low'/'medium'/'high' 直送
      return { reasoning_effort: level === 'off' ? 'minimal' : level };

    case 'grok':
      // grok 多數 model 不支援 reasoning_effort,送錯會 400。off 索性不送。
      // 'high' 等支援的場景才送。
      if (level === 'off') return {};
      return { reasoning_effort: level };

    case 'qwen':
      // 頂層 enable_thinking（非 extra_body，見檔頭 §3.5-3 註解）
      return { enable_thinking: level !== 'off' };

    case 'openai-compat-generic':
    default:
      // OpenAI 標準 reasoning_effort，top-level（不需 extra_body 展平）。
      // 'off' → 'none'；'low' / 'medium' / 'high' 直送。
      // vendor 不支援會被當未知欄位忽略，不會 4xx。
      return { reasoning_effort: level === 'off' ? 'none' : level };
  }
}

/**
 * Responses API 格式的思考強度 payload：`reasoning: { effort }`。
 * 'off' 的寫法依端點而定：
 *   - OpenRouter / OpenAI o 系列：effort 沒有 'none'，最低是 'minimal'
 *   - Grok：多數 model 不收 reasoning 參數，off 索性不送（同 Chat Completions 路徑）
 *   - 其他：'none'（OpenAI 的標準關閉寫法）
 * 端點或 model 不收這個值時回 400——lib/openai-compat.js 會拿掉 reasoning 後重打一次。
 */
function buildResponsesThinking(provider, level) {
  if (level !== 'off') return { reasoning: { effort: level } };
  switch (provider) {
    case 'grok':
      return {};
    case 'openrouter':
    case 'openai-o':
      return { reasoning: { effort: 'minimal' } };
    default:
      return { reasoning: { effort: 'none' } };
  }
}

/**
 * 安全解析使用者填的 extraBodyJson。失敗回 {} + 透過 onWarn callback 通知。
 * 不 throw(避免 UI 因 JSON 格式錯就無法翻譯)。
 */
export function safeParseJson(raw, onWarn) {
  if (!raw || typeof raw !== 'string') return {};
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const v = JSON.parse(trimmed);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (onWarn) onWarn('extraBodyJson 不是物件,已忽略');
    return {};
  } catch (e) {
    if (onWarn) onWarn(`extraBodyJson 解析失敗: ${e.message}`);
    return {};
  }
}

/**
 * 深層 merge 兩個物件(對 plain object 遞迴 merge,陣列/原始值由 b 覆蓋 a)。
 * 用於把 user 的 extraBodyJson 蓋到自動 mapping 結果上。
 */
export function deepMerge(a, b) {
  if (!isPlainObject(b)) return b === undefined ? a : b;
  if (!isPlainObject(a)) return { ...b };
  const out = { ...a };
  for (const k of Object.keys(b)) {
    if (isPlainObject(a[k]) && isPlainObject(b[k])) {
      out[k] = deepMerge(a[k], b[k]);
    } else {
      out[k] = b[k];
    }
  }
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 主入口:組合最終要 merge 進 request body 的 thinking-related payload。
 *
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.model
 * @param {string} opts.level - 'auto' | 'off' | 'low' | 'medium' | 'high'
 * @param {string} opts.extraBodyRaw - user 自訂 JSON 字串(可空)
 * @param {Function} [opts.onWarn] - JSON 解析失敗時的 callback,接 message 字串
 * @param {string} [opts.apiFormat] - 'chat'（預設）| 'responses'
 * @returns {object} 可直接 spread 進 request body 的物件
 */
export function buildThinkingPayload({ baseUrl, model, level, extraBodyRaw, onWarn, apiFormat }) {
  const provider = detectProvider(baseUrl, model);
  const native = buildNativeThinking(provider, level, apiFormat);
  const extra = safeParseJson(extraBodyRaw, onWarn);
  return deepMerge(native, extra);
}
