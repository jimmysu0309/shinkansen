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
  // (遷移至 3.7-flash);2026-09-03:gemini-3.7-flash 下架
  // (migrateGemini37FlashModelIfNeeded 遷移至 3.8-flash;歷史用量費用寫入當下已存
  // billedCostUSD,不受查表影響)。
  // gemini-3.8-flash：此列是 2027-01-01 起的正式價 $1.50 / $7.50；2026-12-31 以前的
  // 促銷價 $0.75 / $3.75 在下方 MODEL_PRICING_PROMOS，由 getBuiltInPricing 依日期切換
  // （code review 2026-11-15 B-3，官方定價頁 2026-11-15 再確認兩組數字）。
  // context cache 為 input 的 10%（促銷期 $0.075、之後 $0.15）→ 折扣走 DEFAULT。
  'gemini-3.8-flash':              { inputPerMTok: 1.50, outputPerMTok: 7.50, cachedDiscount: DEFAULT_GEMINI_CACHED_DISCOUNT },
};

// 有期限的促銷價：endsAtMs 之前用這裡的單價，之後回 MODEL_PRICING 的正式價。
// 3.8-flash 促銷到 2026-12-31（官方未註明時區，取太平洋時間當日結束 = 2027-01-01 08:00 UTC）。
// 促銷結束後這筆可留著（歷史 + isExpiredPromoPricing 辨識舊的自動帶入值），不必趕著刪。
export const MODEL_PRICING_PROMOS = {
  'gemini-3.8-flash': { endsAtMs: Date.UTC(2027, 0, 1, 8), inputPerMTok: 0.75, outputPerMTok: 3.75 },
};

/**
 * 某時間點生效的內建計價（促銷期內回促銷價）。查不到回 null。
 * 內建價的單一入口：背景計費（getPricingForModel）與設定頁的價格顯示都走這裡，
 * 不直接讀 MODEL_PRICING。
 */
export function getBuiltInPricing(model, now = Date.now()) {
  const base = MODEL_PRICING[model];
  if (!base) return null;
  const promo = MODEL_PRICING_PROMOS[model];
  if (promo && now < promo.endsAtMs) {
    return { ...base, inputPerMTok: promo.inputPerMTok, outputPerMTok: promo.outputPerMTok };
  }
  return { ...base };
}

/** 某時間點的整張內建表 { model: pricing }。 */
export function builtInPricingTable(now = Date.now()) {
  return Object.fromEntries(Object.keys(MODEL_PRICING).map((m) => [m, getBuiltInPricing(m, now)]));
}

/** 該模型此刻是否在促銷期內（設定頁決定要不要保留「促銷價」註記）。 */
export function isPromoActive(model, now = Date.now()) {
  const promo = MODEL_PRICING_PROMOS[model];
  return !!promo && now < promo.endsAtMs;
}

/**
 * pricing 是否為「已過期的促銷價字面值」。設定頁選字幕模型時會把當時的內建價自動帶進
 * 字幕獨立計價欄位並存檔（ytSubtitle.pricing），促銷結束後那組數字就過時了，而且與使用者
 * 手動輸入的值無從區分——只有「數字剛好等於已過期促銷價」這一種可辨識，視為未自訂、
 * 改用內建表現價。
 */
export function isExpiredPromoPricing(model, pricing, now = Date.now()) {
  const promo = MODEL_PRICING_PROMOS[model];
  if (!promo || now < promo.endsAtMs || !pricing) return false;
  return Number(pricing.inputPerMTok) === promo.inputPerMTok
    && Number(pricing.outputPerMTok) === promo.outputPerMTok;
}

// v1.6.14:內建表校準日期。UI 顯示「(YYYY-MM 校準)」提示使用者可能過時。
// release 時若 Google 公布新價,把這裡更新 + 同步 MODEL_PRICING 數字。
export const LAST_CALIBRATED_DATE = '2026-11';

/**
 * 查模型計價,各欄位獨立 fallback(v1.9.2 起):
 *   inputPerMTok / outputPerMTok / cachedDiscount 三欄各自先查 override 再 fallback 內建表。
 *   使用者可只覆蓋折扣不覆蓋價格,反之亦然。
 *   找不到內建 entry 且 override 沒填整組 → null(呼叫端再走 settings.pricing 全域 fallback)。
 *
 * @param {string} model 模型 ID
 * @param {object|null} settings 完整 settings(可只帶 modelPricingOverrides)
 */
export function getPricingForModel(model, settings = null, now = Date.now()) {
  if (!model) return null;
  const override = settings?.modelPricingOverrides?.[model] || {};
  const builtIn = getBuiltInPricing(model, now);
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
 * 設定頁「Temperature」欄位的可用狀態（options 與文件翻譯設定頁共用）。
 * 傳入該欄位實際會套用到的 Gemini 模型 ID 清單：
 *   'none'    = 全部模型都忽略 temperature → 欄位停用
 *   'partial' = 部分忽略 → 欄位可調，但要註明只對哪些模型生效
 *   'all'     = 全部有效（或清單為空，無從判斷）→ 不加註記
 * supported 回傳「仍吃 temperature 的模型」去重清單，供註記文字列出。
 */
export function temperatureSupport(models) {
  const list = [...new Set((models || []).map((m) => String(m || '').trim()).filter(Boolean))];
  const supported = list.filter((m) => !modelDropsSamplingParams(m));
  if (list.length === 0 || supported.length === list.length) return { status: 'all', supported };
  return { status: supported.length === 0 ? 'none' : 'partial', supported };
}
