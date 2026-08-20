// model-pricing.js — Gemini 模型計價表（Standard tier，USD per 1M tokens）
// 來源：https://ai.google.dev/gemini-api/docs/pricing
// 結構對齊 settings.pricing，可直接當 effectivePricing 使用。
//
// v1.4.12：preset 快速鍵按 modelOverride 觸發翻譯時，由 background.js handleTranslate
// 依當下 model 查此表覆蓋 settings.pricing，讓 toast 顯示的費用與 usage log 跟 model 走。
// 使用者若在 options 頁有自訂 settings.pricing，該值在「沒有 modelOverride」時仍會被使用。
//
// v1.6.14:加入 LAST_CALIBRATED_DATE + settings.modelPricingOverrides。
// Google 改價時內建表會過時,使用者可在「Gemini 分頁 → 模型計價」逐模型覆蓋。
// getPricingForModel 簽名加 settings 參數,先查 override 再 fallback 內建。
//
// v1.9.2:加入 cachedDiscount(0-1,cache 命中省下的比例)。Gemini 2.5+ 起 implicit
// cache 命中折扣為 90%(命中部分付 10%)→ 預設 0.90。早於 v1.9.2 的版本硬編 0.75
// (Gemini 2.0 時代),會讓 cache 命中部分被高估 1.5×。input/output 與 cachedDiscount
// 三者於 override 表獨立 fallback——使用者可只覆蓋折扣不覆蓋價格,反之亦然。
export const DEFAULT_GEMINI_CACHED_DISCOUNT = 0.90;

export const MODEL_PRICING = {
  'gemini-3.1-flash-lite': { inputPerMTok: 0.25, outputPerMTok: 1.50, cachedDiscount: DEFAULT_GEMINI_CACHED_DISCOUNT },
  // v2.0.64:官方定價頁明示 3.5 Flash-Lite 不提供 context caching → cachedDiscount 0
  // (API 不會回報 cached tokens,設 0 讓萬一出現的 cached 部分照全價計,不虛報折扣)
  'gemini-3.5-flash-lite': { inputPerMTok: 0.30, outputPerMTok: 2.50, cachedDiscount: 0 },
  'gemini-3-flash-preview':        { inputPerMTok: 0.50, outputPerMTok: 3.00, cachedDiscount: DEFAULT_GEMINI_CACHED_DISCOUNT },
  // v2.0.64:gemini-3.5-flash 下架(遷移至 3.6-flash);2026-08-20:gemini-3.6-flash 下架
  // (migrateGemini36FlashModelIfNeeded 遷移至 3.7-flash;歷史用量費用寫入當下已存
  // billedCostUSD,不受查表影響)。
  // gemini-3.7-flash(2026-08-13 GA):官方促銷價 $0.75 / $3.75 至 2026-12-31,
  // 2027-01-01 起回 $1.50 / $7.50——屆時更新此列 + options 選單價格標示。
  // context cache $0.075 = input 10% → 折扣走 DEFAULT。
  'gemini-3.7-flash':              { inputPerMTok: 0.75, outputPerMTok: 3.75, cachedDiscount: DEFAULT_GEMINI_CACHED_DISCOUNT },
};

// v1.6.14:內建表校準日期。UI 顯示「(YYYY-MM 校準)」提示使用者可能過時。
// release 時若 Google 公布新價,把這裡更新 + 同步 MODEL_PRICING 數字。
export const LAST_CALIBRATED_DATE = '2026-08';

/**
 * 查模型計價,各欄位獨立 fallback(v1.9.2 起):
 *   inputPerMTok / outputPerMTok / cachedDiscount 三欄各自先查 override 再 fallback 內建表。
 *   使用者可只覆蓋折扣不覆蓋價格,反之亦然。
 *   找不到內建 entry 且 override 沒填整組 → null(呼叫端再走 settings.pricing 全域 fallback)。
 *
 * @param {string} model 模型 ID
 * @param {object|null} settings 完整 settings(可只帶 modelPricingOverrides)
 */
export function getPricingForModel(model, settings = null) {
  if (!model) return null;
  const override = settings?.modelPricingOverrides?.[model] || {};
  const builtIn = MODEL_PRICING[model] || null;
  const oIn = Number(override.inputPerMTok);
  const oOut = Number(override.outputPerMTok);
  const oDisc = Number(override.cachedDiscount);
  const overrideHasPrices = Number.isFinite(oIn) && Number.isFinite(oOut);
  if (!builtIn && !overrideHasPrices) return null;
  return {
    inputPerMTok:  overrideHasPrices ? oIn  : builtIn.inputPerMTok,
    outputPerMTok: overrideHasPrices ? oOut : builtIn.outputPerMTok,
    cachedDiscount: (Number.isFinite(oDisc) && oDisc >= 0 && oDisc <= 1)
      ? oDisc
      : (builtIn?.cachedDiscount ?? DEFAULT_GEMINI_CACHED_DISCOUNT),
  };
}
