// billing.js — 用量計費公式的單一資料源（2026-09-12 code review 批次 6 §5.1）
//
// 原本 background.js 內 computeCostUSD / computeBilledCostUSD + 十處手寫的
// 「billedInputTokens = max(0, round(input − cached × (1 − rate)))」散在三條翻譯 handler、
// 串流 discard 記帳、兩條術語表抽取、譯名對照掃描——同一份公式抄十次，P1-2 那類 drift 的溫床。
// 收斂成 computeBilling(usage, pricing, cachedRate) 一個入口；引擎差異只在 cachedRate 的來源
//（Gemini 從 pricing.cachedDiscount、自訂 Provider 從 customProvider.cachedDiscount 或 baseUrl 推導）。
//
// 純函式、無 chrome.* 依賴，Playwright unit spec 可直接 import。

/** 原始（未套 cache 折扣）費用：inputTokens / outputTokens 各乘 USD / 1M tokens 單價。 */
export function computeCostUSD(inputTokens, outputTokens, pricing) {
  const inRate = Number(pricing?.inputPerMTok) || 0;
  const outRate = Number(pricing?.outputPerMTok) || 0;
  return (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate;
}

// Gemini implicit cache 命中部分相對全價的預設比例（v1.9.2 起 Gemini 3 系列 90% off → 付 10%）。
// 只給「沒帶 cachedRate」的舊 caller 用；新 caller 一律從 settings 帶明確 cachedDiscount。
export const DEFAULT_CACHED_RATE = 0.10;

/**
 * v0.48: 計算套用 implicit / explicit context cache 折扣後的實付費用。
 * v1.8.20: 改成可注入折扣比例（cachedRate = cache 命中部分相對全價的比例）。
 * 公式：effectiveInput = (inputTokens - cachedTokens) + cachedTokens × cachedRate
 */
export function computeBilledCostUSD(inputTokens, cachedTokens, outputTokens, pricing, cachedRate) {
  const rate = (typeof cachedRate === 'number' && cachedRate >= 0 && cachedRate <= 1)
    ? cachedRate
    : DEFAULT_CACHED_RATE;
  const uncached = Math.max(0, inputTokens - cachedTokens);
  const effectiveInput = uncached + cachedTokens * rate;
  return computeCostUSD(effectiveInput, outputTokens, pricing);
}

/**
 * v1.9.2: 從 pricing 物件取出 cache 命中部分相對全價的比例。
 * pricing.cachedDiscount（0-1，命中省下的比例）→ rate = 1 - discount。
 * 沒填 / 不合法 → 回 null，呼叫端決定 fallback。
 */
export function pricingToCachedRate(pricing) {
  // null / undefined / 空字串 = 沒填（設定頁欄位留空存的是 null）。不可直接 Number()：
  // Number(null) 與 Number('') 都是 0，會被當成「折扣 0%」，自訂 Provider 的
  // baseUrl 自動推導永遠走不到（code review 2026-11-15 B-1）
  const raw = pricing?.cachedDiscount;
  if (raw == null || raw === '') return null;
  const d = Number(raw);
  if (!Number.isFinite(d) || d < 0 || d > 1) return null;
  return 1 - d;
}

/** Gemini 路徑的 cachedRate：pricing.cachedDiscount，沒填 fallback 90% off。 */
export function geminiCachedRate(pricing) {
  return pricingToCachedRate(pricing) ?? DEFAULT_CACHED_RATE;
}

/**
 * v1.8.20: 依自訂 Provider baseUrl 推斷 cache 命中折扣比例，作為 customProvider.cachedDiscount
 *         沒填時的二級 fallback。
 * v1.9.2: 數值對齊 2026-05 各家現況——OpenAI 新世代（GPT-5+）up to 90% off、
 *         DeepSeek 約 98% off、xAI 75-90%、Claude 90%。
 * 由 baseUrl 簡單字串判斷，使用者用 OpenRouter 等 aggregator 時走預設 0.5 中間值。
 */
export function getCustomCacheHitRate(baseUrl) {
  const url = String(baseUrl || '').toLowerCase();
  if (url.includes('anthropic.com')) return 0.10;        // Claude read 90% off
  if (url.includes('openai.com')) return 0.10;            // OpenAI 新世代（GPT-5+）up to 90% off
  if (url.includes('deepseek.com')) return 0.02;          // DeepSeek context cache hit ~98% off
  if (url.includes('x.ai')) return 0.20;                  // xAI Grok ~80% off（因 model 而異）
  return 0.50;                                            // 未知 provider 中間值
}

/**
 * v1.9.2: customProvider 路徑 cache 命中比例查找順序：
 *   1. customProvider.cachedDiscount 合法 → 用使用者設定
 *   2. fallback baseUrl 自動推導（getCustomCacheHitRate）
 */
export function resolveCustomProviderCachedRate(cp) {
  const fromSettings = pricingToCachedRate(cp);
  if (fromSettings !== null) return fromSettings;
  return getCustomCacheHitRate(cp?.baseUrl);
}

/** 自訂 Provider 的 pricing 物件（沒填單價 = 0，不顯示費用）。 */
export function customProviderPricing(cp) {
  return { inputPerMTok: cp?.inputPerMTok || 0, outputPerMTok: cp?.outputPerMTok || 0 };
}

// ─── Gemini service tier 計價倍率（code review 2026-11-15 B-2）────────────
// model-pricing.js 的內建表是 Standard 價。Flex 為 Standard 的 50%，Priority 為 1.8 倍
//（官方定價頁 2026-11-15 校準：四個內建模型的 input / output 全部符合這兩個倍率）。
// DEFAULT（不送 service_tier）與 STANDARD 為 1。
// 不精確處：個別模型的 Flex 快取命中價不是剛好減半（例 gemini-3-flash-preview），
// 這裡一律套同一倍率，誤差只落在快取命中那一小部分。
export const SERVICE_TIER_MULTIPLIER = { FLEX: 0.5, PRIORITY: 1.8 };

export function serviceTierMultiplier(tier) {
  return SERVICE_TIER_MULTIPLIER[String(tier || '').toUpperCase()] ?? 1;
}

/**
 * 把這次請求送出的 service tier 掛到 pricing 上（單價本身不動，倍率由 computeBilling 套）。
 * 只給 Gemini 路徑用；自訂 Provider 沒有 tier 概念，不呼叫即為 1。
 */
export function withServiceTier(pricing, tier) {
  const m = serviceTierMultiplier(tier);
  if (!pricing || m === 1) return pricing;
  return { ...pricing, tierMultiplier: m };
}

/**
 * 一批用量的完整計費：原始費用 + 套 cache 折扣後的「實付」input token 數與費用。
 * toast / popup / usage-db 顯示的都是 billed* 這組（v0.48 起）；raw 數字保留給 hit% / saved%。
 *
 * service tier：pricing.tierMultiplier（withServiceTier 掛的）乘在費用上，token 數不變。
 * usage.std*Tokens 是「要求 Priority 但被降級成 Standard 處理」的那部分（gemini.js 依回應
 * 標頭標記），官方對降級請求照 Standard 計價 → 這部分不乘倍率。
 *
 * @param {{inputTokens?:number, outputTokens?:number, cachedTokens?:number, stdInputTokens?:number, stdOutputTokens?:number, stdCachedTokens?:number}} usage
 * @param {object|null} pricing { inputPerMTok, outputPerMTok, tierMultiplier? }
 * @param {number} cachedRate cache 命中部分相對全價的比例（0-1）
 * @returns {{ inputTokens:number, outputTokens:number, cachedTokens:number, costUSD:number, billedInputTokens:number, billedCostUSD:number }}
 */
export function computeBilling(usage, pricing, cachedRate) {
  const inputTokens = usage?.inputTokens || 0;
  const outputTokens = usage?.outputTokens || 0;
  const cachedTokens = usage?.cachedTokens || 0;
  const cachedSavedRatio = 1 - cachedRate;
  const m = (typeof pricing?.tierMultiplier === 'number' && pricing.tierMultiplier > 0) ? pricing.tierMultiplier : 1;
  let costUSD = computeCostUSD(inputTokens, outputTokens, pricing) * m;
  let billedCostUSD = computeBilledCostUSD(inputTokens, cachedTokens, outputTokens, pricing, cachedRate) * m;
  if (m !== 1) {
    // 被降級成 Standard 的部分退回 1 倍（上限夾在總量內，防標記與總量不一致）
    const stdIn = Math.min(inputTokens, usage?.stdInputTokens || 0);
    const stdOut = Math.min(outputTokens, usage?.stdOutputTokens || 0);
    const stdCached = Math.min(cachedTokens, stdIn, usage?.stdCachedTokens || 0);
    if (stdIn > 0 || stdOut > 0) {
      costUSD -= computeCostUSD(stdIn, stdOut, pricing) * (m - 1);
      billedCostUSD -= computeBilledCostUSD(stdIn, stdCached, stdOut, pricing, cachedRate) * (m - 1);
    }
  }
  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    costUSD,
    billedInputTokens: Math.max(0, Math.round(inputTokens - cachedTokens * cachedSavedRatio)),
    billedCostUSD,
  };
}
