// options.js — 設定頁邏輯
// v1.0.4: 改為 ES module，從 lib/ 匯入共用常數與工具函式，消除重複程式碼。

import { browser } from '../lib/compat.js';
import { DEFAULT_SETTINGS, DEFAULT_SYSTEM_PROMPT, DEFAULT_GLOSSARY_PROMPT, DEFAULT_SUBTITLE_SYSTEM_PROMPT, DEFAULT_FORBIDDEN_TERMS, TARGET_LANGUAGES, UI_LANGUAGES, getEffectiveSystemPrompt, getEffectiveSubtitleSystemPrompt, getEffectiveGlossaryPrompt, isPromptUnchangedFromDefault } from '../lib/storage.js';
import { TIER_LIMITS } from '../lib/tier-limits.js';
import { formatTokens, formatUSD, formatMoney, parseUserNum, buildUsageCsvFilename } from '../lib/format.js';
import { isWorthNotifying } from '../lib/update-check.js'; // v1.6.5
import { IS_MAS_BUILD } from '../lib/distribution.js';

// 向下相容：舊程式碼大量使用 DEFAULTS，保留別名避免大範圍搜尋取代
const DEFAULTS = DEFAULT_SETTINGS;

// v1.4.12: 模型參考價統一由 lib/model-pricing.js 提供，與 background.js 共用同一份，
// 避免兩邊不同步（以前 background 用 settings.pricing 單一值，options 用 local 表，
// preset 切換 model 時 toast 會算錯）。此處做 input/output key 轉換保留原 options.js 介面。
import { MODEL_PRICING as LIB_MODEL_PRICING } from '../lib/model-pricing.js';
const MODEL_PRICING = Object.fromEntries(
  Object.entries(LIB_MODEL_PRICING).map(([model, p]) => [model, { input: p.inputPerMTok, output: p.outputPerMTok }])
);


// v1.6.15: 全域 #model dropdown 已移除（v1.4.12 起 preset modelOverride 涵蓋
// 95%+ 場景，真實後備路徑剩 testGeminiKey 按鈕 + cache key 構建）。改讀
// 「主要預設」(slot 2）的 model；若 slot 2 引擎不是 gemini → fallback 到
// DEFAULTS.geminiConfig.model（避免 testGeminiKey 沒 model 可送）。
function getSelectedModel() {
  const engineSel = $('preset-engine-2');
  const modelSel = $('preset-model-2');
  if (engineSel?.value === 'gemini' && modelSel?.value) {
    return modelSel.value;
  }
  return DEFAULTS.geminiConfig.model;
}

// v1.6.15: SERVICE_TIER_MULTIPLIER + applyModelPricing 已移除。
// 原本是「全域 model dropdown 切換時自動帶入參考價到後備路徑單價」的便利功能，
// model dropdown 移除後不再有觸發點；且 v1.6.14 已加 per-model override 表
// 取代「自動帶價」的 UX 功能。後備路徑單價現在純由使用者填，不自動連動 service tier。

function applyTierToInputs(tier, model) {
  const rpmEl = $('rpm');
  const tpmEl = $('tpm');
  const rpdEl = $('rpd');
  if (tier === 'custom') {
    rpmEl.readOnly = false;
    tpmEl.readOnly = false;
    rpdEl.readOnly = false;
    return;
  }
  rpmEl.readOnly = true;
  tpmEl.readOnly = true;
  rpdEl.readOnly = true;
  const table = TIER_LIMITS[tier] || {};
  const limits = table[model] || { rpm: 60, tpm: 1000000, rpd: 1000 };
  rpmEl.value = limits.rpm;
  tpmEl.value = limits.tpm;
  rpdEl.value = limits.rpd === Infinity ? _t('common.unlimited') : limits.rpd;
}

const $ = (id) => document.getElementById(id);

// 翻譯目標語言已從 options 搬到 popup(v1.9.16),options 不再有 #targetLanguage
// picker,但 options 內多處仍需「當前 target」決定 prompt textarea / 語言偵測 label /
// 禁用詞表預設。改成 module-level cache:load() 從 storage 讀進來,storage.onChanged
// listener 監聽 popup 寫入後同步更新並 reapply refresher。
let _currentTargetLang = DEFAULT_SETTINGS.targetLanguage;

async function load() {
  const saved = await browser.storage.sync.get(null);
  // v0.62 起：apiKey 改存 browser.storage.local，不跟 Google 帳號同步
  const { apiKey: localApiKey = '' } = await browser.storage.local.get('apiKey');
  const s = {
    ...DEFAULTS,
    ...saved,
    geminiConfig: { ...DEFAULTS.geminiConfig, ...(saved.geminiConfig || {}) },
    pricing: { ...DEFAULTS.pricing, ...(saved.pricing || {}) },
    apiKey: localApiKey,
  };
  $('apiKey').value = s.apiKey;
  // v1.9.16:翻譯目標語言 picker 已搬到 popup,options 內不再有 #targetLanguage element。
  // 仍需要「當前 target」決定 prompt textarea / 語言偵測 label / 禁用詞表預設,
  // 改成讀進 module-level _currentTargetLang(saved 不在合法集合 → DEFAULT_SETTINGS.targetLanguage)。
  _currentTargetLang = (typeof s.targetLanguage === 'string' && TARGET_LANGUAGES.includes(s.targetLanguage))
    ? s.targetLanguage : DEFAULTS.targetLanguage;
  // v1.6.15: 全域 #model dropdown 已移除，不再從 storage 載入到 UI。
  // settings.geminiConfig.model 仍保留 storage 結構（避免 migration）但 UI 不顯示。
  $('serviceTier').value = s.geminiConfig.serviceTier;
  $('temperature').value = s.geminiConfig.temperature;
  $('topP').value = s.geminiConfig.topP;
  $('topK').value = s.geminiConfig.topK;
  $('maxOutputTokens').value = s.geminiConfig.maxOutputTokens;
  $('systemInstruction').value = s.geminiConfig.systemInstruction;
  // v1.6.16: 後備路徑單價 UI 已移除（對應 input element 不存在），不再從 settings 載入到 UI。
  // settings.pricing 仍保留 storage 結構作 belt-and-suspenders(background.js:610 fallback 路徑保留）。
  // v1.6.14: per-model 計價覆蓋
  // v1.9.2: 加 cachedDiscount(0-1)欄位,UI 顯示百分比(0-100);儲存仍為比例(0-1)
  const overrides = s.modelPricingOverrides || {};
  const fillOverride = (id, model, key) => {
    const el = $(id);
    if (!el) return;
    const v = overrides[model]?.[key];
    el.value = (Number.isFinite(Number(v)) ? Number(v) : '');
  };
  const fillOverrideDiscount = (id, model) => {
    const el = $(id);
    if (!el) return;
    const v = overrides[model]?.cachedDiscount;
    el.value = (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) : '');
  };
  fillOverride('override-lite-input',  'gemini-3.1-flash-lite', 'inputPerMTok');
  fillOverride('override-lite-output', 'gemini-3.1-flash-lite', 'outputPerMTok');
  fillOverrideDiscount('override-lite-discount', 'gemini-3.1-flash-lite');
  fillOverride('override-flash-input', 'gemini-3-flash-preview', 'inputPerMTok');
  fillOverride('override-flash-output','gemini-3-flash-preview', 'outputPerMTok');
  fillOverrideDiscount('override-flash-discount', 'gemini-3-flash-preview');
  fillOverride('override-pro-input',   'gemini-3.5-flash', 'inputPerMTok');
  fillOverride('override-pro-output',  'gemini-3.5-flash', 'outputPerMTok');
  fillOverrideDiscount('override-pro-discount', 'gemini-3.5-flash');
  $('whitelist').value = (s.domainRules.whitelist || []).join('\n');
  $('debugLog').checked = s.debugLog;

  // 效能與配額
  $('tier').value = s.tier || 'tier1';
  applyTierToInputs($('tier').value, s.geminiConfig.model);
  // 若有 override 則把 override 填進去覆蓋 tier 預設
  if (s.rpmOverride) $('rpm').value = s.rpmOverride;
  if (s.tpmOverride) $('tpm').value = s.tpmOverride;
  if (s.rpdOverride) $('rpd').value = s.rpdOverride;
  // v1.6.19: 統一用 ?? 不用 || ——使用者輸入 0(batch size 等）是合法
  // 設定意圖，|| 會把 0 當 falsy 默默改回預設值，造成 UI 「我設了 0 卻看到 10%」。
  // v1.8.19: 安全邊際從 UI 移除，程式碼內部維持 storage default 0.1 即可
  $('maxConcurrentBatches').value = s.maxConcurrentBatches ?? 10;
  $('maxUnitsPerBatch').value = s.maxUnitsPerBatch ?? 20;
  $('maxCharsPerBatch').value = s.maxCharsPerBatch ?? 3500;
  $('maxTranslateUnits').value = s.maxTranslateUnits ?? 1000;
  // v1.8.3: partialMode toggle + size
  const pm = { ...DEFAULTS.partialMode, ...(s.partialMode || {}) };
  $('partialModeEnabled').checked = pm.enabled === true;
  $('partialModeMaxUnits').value = pm.maxUnits;
  $('maxRetries').value = s.maxRetries ?? 3;

  // v0.69: 術語表一致化設定
  const gl = { ...DEFAULTS.glossary, ...(s.glossary || {}) };
  $('glossaryEnabled').checked = gl.enabled !== false;
  // v1.7.2: 術語擷取獨立模型（預設 Flash Lite)，空字串表示「與主翻譯相同」
  $('glossaryModel').value = gl.model ?? DEFAULTS.glossary.model;
  // v1.7.3: 阻塞門檻可調（預設 10,> 此值才 blocking,≤ 此值走 fire-and-forget)
  $('glossaryBlockingThreshold').value = gl.blockingThreshold ?? DEFAULTS.glossary.blockingThreshold;
  $('glossaryTemperature').value = gl.temperature;
  // v1.8.61:UI 顯示秒,storage 內部仍 ms;讀時 ms / 1000 換算
  $('glossaryTimeout').value = Math.round((gl.timeoutMs ?? 60000) / 1000);
  $('glossaryPrompt').value = gl.prompt;

  // v1.0.17: Toast 透明度 / v1.0.31: Toast 位置
  const opacityPct = Math.round((s.toastOpacity ?? 0.7) * 100);
  $('toastOpacity').value = opacityPct;
  // v1.8.61:wrap label 走 i18n 動態字串(原本寫死繁中,en/zh-CN UI 漏翻)
  _renderToastOpacityLabel(opacityPct);
  $('toastPosition').value = s.toastPosition || 'bottom-right';
  // v1.1.3: Toast 自動關閉
  $('toastAutoHide').checked = s.toastAutoHide !== false;
  // v1.6.8: Toast master switch
  $('showProgressToast').checked = s.showProgressToast !== false;

  // v1.0.21: 頁面層級繁中偵測開關

  // v1.5.0: 雙語對照視覺標記
  const validMarks = ['tint', 'bar', 'dashed', 'none'];
  const savedMark = validMarks.includes(s.translationMarkStyle) ? s.translationMarkStyle : 'tint';
  for (const r of document.querySelectorAll('input[name="markStyle"]')) {
    r.checked = (r.value === savedMark);
  }
  updateDualDemoMark(savedMark);

  // v1.8.52: 雙語強調色 — sanitize 後同步 swatch / picker / hex input + demo
  currentDualAccent = sanitizeDualAccent(s.dualAccentColor);
  refreshDualAccentUI();

  // v1.8.41：金額顯示幣值
  const validCurrencies = ['USD', 'TWD'];
  const savedCurrency = validCurrencies.includes(s.displayCurrency) ? s.displayCurrency : 'TWD';
  for (const r of document.querySelectorAll('input[name="displayCurrency"]')) {
    r.checked = (r.value === savedCurrency);
  }
  refreshExchangeRateDisplay();

  // v1.0.29: 固定術語表
  fixedGlossary = {
    global: Array.isArray(s.fixedGlossary?.global) ? s.fixedGlossary.global : [],
    byDomain: (s.fixedGlossary?.byDomain && typeof s.fixedGlossary.byDomain === 'object') ? s.fixedGlossary.byDomain : {},
  };
  currentDomain = '';
  renderGlobalTable();
  updateDomainSelect();
  showDomainPanel('');

  // v1.5.6: 中國用語黑名單
  // P1/P2(v1.8.60):依 target 給對應預設(對齊 storage.js getSettings() 邏輯)。
  //   saved 已寫入 → 完全以 saved 為準(尊重客製化)
  //   saved 未寫入 + target=zh-TW → DEFAULT_FORBIDDEN_TERMS(25 條台灣慣用語)
  //   saved 未寫入 + target≠zh-TW → 空陣列(zh-CN/en 等不需要禁用中國用語)
  // 之前用 s.forbiddenTerms(已 spread DEFAULTS)會永遠拿到 25 條 → en/zh-CN 使用者
  // 看到滿表中→中對映無意義。
  forbiddenTerms = Array.isArray(saved.forbiddenTerms)
    ? saved.forbiddenTerms
    : (s.targetLanguage === 'zh-TW' ? DEFAULT_FORBIDDEN_TERMS.map(t => ({ ...t })) : []);
  renderForbiddenTermsTable();

  // v1.5.7: 自訂 OpenAI-compatible Provider
  // apiKey 走 storage.local（不在 sync 也不在 saved 物件，獨立讀取）
  const cp = { ...DEFAULTS.customProvider, ...(s.customProvider || {}) };
  $('cp-baseUrl').value = cp.baseUrl || '';
  // v1.8.41:initial check Firefox HTTPS-Only Mode 警告
  refreshFirefoxHttpsWarn();
  // v1.8.44:initial check Firefox 快捷鍵衝突警告(Alt+S/A/D 被 Firefox 內建或第三方擴充攔截)
  refreshFirefoxShortcutWarn();
  $('cp-model').value = cp.model || '';
  $('cp-systemPrompt').value = cp.systemPrompt || '';
  $('cp-temperature').value = (typeof cp.temperature === 'number') ? cp.temperature : 0.7;
  $('cp-fetchTimeout').value = (typeof cp.fetchTimeoutSec === 'number') ? cp.fetchTimeoutSec : 15;
  $('cp-inputPerMTok').value = cp.inputPerMTok != null ? cp.inputPerMTok : '';
  $('cp-outputPerMTok').value = cp.outputPerMTok != null ? cp.outputPerMTok : '';
  // v1.9.2: cache 命中折扣 — UI 顯示百分比(0-100),儲存仍為比例(0-1);null/undefined → 空白
  $('cp-cachedDiscount').value = (Number.isFinite(Number(cp.cachedDiscount))
    ? Math.round(Number(cp.cachedDiscount) * 100)
    : '');
  // v1.6.18: thinking 控制
  const validLevels = ['auto', 'off', 'low', 'medium', 'high'];
  const tl = validLevels.includes(cp.thinkingLevel) ? cp.thinkingLevel : 'auto';
  if ($('cp-thinking-level')) $('cp-thinking-level').value = tl;
  if ($('cp-extra-body-json')) $('cp-extra-body-json').value = (typeof cp.extraBodyJson === 'string') ? cp.extraBodyJson : '';
  // 強化段序號標記。舊使用者升級後 undefined,等同預設 true(對齊 storage.js DEFAULTS)
  if ($('cp-strong-seg-marker')) $('cp-strong-seg-marker').checked = cp.useStrongSegMarker !== false;
  // 從 storage.local 讀 customProviderApiKey
  const { customProviderApiKey = '' } = await browser.storage.local.get('customProviderApiKey');
  $('cp-apiKey').value = customProviderApiKey;

  // v1.2.11: YouTube 字幕設定
  const yt = { ...DEFAULTS.ytSubtitle, ...(s.ytSubtitle || {}) };
  // v1.4.0: 字幕翻譯引擎
  const ytEngineEl = $('ytEngine');
  if (ytEngineEl) ytEngineEl.value = yt.engine || 'gemini';
  $('ytAutoTranslate').checked       = yt.autoTranslate       === true;
  // v1.6.23: ASR 分句改單一 toggle——開啟=progressive（混合模式）、關閉=heuristic（預設分句）。
  // 舊 'llm' 值視為 progressive（行為相近，LLM 結果仍會顯示；只是改成漸進方式）。
  $('ytAsrProgressive').checked = yt.asrMode !== 'heuristic';
  // v1.5.8: 字幕是否套用固定術語表 / 黑名單
  $('ytApplyFixedGlossary').checked  = yt.applyFixedGlossary  === true;
  $('ytApplyForbiddenTerms').checked = yt.applyForbiddenTerms === true;
  $('ytDebugToast').checked          = yt.debugToast          === true;
  $('ytOnTheFly').checked            = yt.onTheFly            === true;  // v1.2.49
  // ytPreserveLineBreaks 已於 v1.2.38 移除（功能改為永遠開啟）
  $('ytWindowSizeS').value           = yt.windowSizeS ?? 30;
  $('ytLookaheadS').value            = yt.lookaheadS  ?? 10;
  $('ytTemperature').value           = yt.temperature  ?? 1;
  $('ytSystemPrompt').value          = yt.systemPrompt || DEFAULT_SUBTITLE_SYSTEM_PROMPT;
  // v1.2.39: 獨立模型 + 計價
  const ytModelSel = $('ytModel');
  const savedYtModel = yt.model || '';
  if ([...ytModelSel.options].some(o => o.value === savedYtModel)) {
    ytModelSel.value = savedYtModel;
  } else {
    ytModelSel.value = '';
  }
  const ytPricing = yt.pricing;
  $('ytInputPerMTok').value  = ytPricing?.inputPerMTok  != null ? ytPricing.inputPerMTok  : '';
  $('ytOutputPerMTok').value = ytPricing?.outputPerMTok != null ? ytPricing.outputPerMTok : '';

  // v1.4.13: 三組 preset 快速鍵
  // v1.5.7: engine 接受三種 'gemini' / 'google' / 'openai-compat'，不認識的回退 'gemini'
  const VALID_ENGINES = ['gemini', 'google', 'openai-compat'];
  const presets = Array.isArray(s.translatePresets) && s.translatePresets.length > 0
    ? s.translatePresets
    : DEFAULTS.translatePresets;
  for (const slot of [1, 2, 3]) {
    const p = presets.find(x => x.slot === slot) || DEFAULTS.translatePresets.find(x => x.slot === slot);
    $(`preset-label-${slot}`).value = p.label || '';
    $(`preset-engine-${slot}`).value = VALID_ENGINES.includes(p.engine) ? p.engine : 'gemini';
    const modelSel = $(`preset-model-${slot}`);
    if (p.model && [...modelSel.options].some(o => o.value === p.model)) {
      modelSel.value = p.model;
    } else {
      modelSel.value = 'gemini-3-flash-preview';
    }
    updatePresetModelVisibility(slot);
  }
  refreshPresetKeyBindings();

  // v1.6.6: 工具列「翻譯本頁」按鈕的 preset slot dropdown
  // v1.6.13: 自動翻譯網站使用的 preset slot
  // v1.6.14: slot 2 顯示「主要預設」、slot 1/3 顯示「預設 2/3」
  // 兩個下拉選單的 option text 由 refreshSlotDropdownLabels() 統一處理，
  // 此處只負責設 value
  refreshSlotDropdownLabels();
  const popupSlotSel = $('popup-button-slot');
  if (popupSlotSel) {
    const slotVal = Number(s.popupButtonSlot);
    popupSlotSel.value = ([1, 2, 3].includes(slotVal) ? slotVal : 2).toString();
  }
  const autoSlotSel = $('auto-translate-slot');
  if (autoSlotSel) {
    const autoSlotVal = Number(s.autoTranslateSlot);
    autoSlotSel.value = ([1, 2, 3].includes(autoSlotVal) ? autoSlotVal : 2).toString();
  }

  // v1.5.7: cache presets 與 customProvider 給用量紀錄「模型」欄的 modelToLabel() 用
  _presetsCache = presets;
  _customProviderCache = cp || { model: '' };

  // v1.5.8: 依 ytEngine 顯示 / 隱藏字幕分頁的 Gemini-only / Prompt sections
  updateYtSectionVisibility();
  // v1.5.8: 字幕 prompt 開銷估算
  updateYtPromptCostHint();

  // v1.6.1: 更新提示 banner — 有新版且使用者未關閉提示時顯示
  // v1.6.3: 加 click handler 攔截改用 chrome.tabs.create()，避免 href 被任何理由
  //         （updateAvailable.releaseUrl undefined / race condition）保留 "#" 時，
  //         <a target="_blank"> 會 navigate 到 options.html# 跳出另一個設定頁。
  try {
    // MAS build:不顯示 update banner(同 popup / content toast 守衛理由,
    // 見 lib/distribution.js)。defense in depth — storage 殘留也不錯顯。
    const disableUpdateNotice = s.disableUpdateNotice === true || IS_MAS_BUILD;
    if (!disableUpdateNotice) {
      const { updateAvailable } = await browser.storage.local.get('updateAvailable');
      const manifest = browser.runtime.getManifest();
      // v1.6.5: belt-and-suspenders — 必須 storage.version 真的 > current 才顯示
      if (updateAvailable && updateAvailable.version && updateAvailable.releaseUrl
          && isWorthNotifying(updateAvailable.version, manifest.version)) {
        $('update-banner-row').hidden = false;
        $('update-banner-version').textContent = _t('options.updateBanner.version', {
          newVersion: updateAvailable.version,
          currentVersion: manifest.version,
        });
        // click handler 改用 document delegation 在外面掛（避免 init() async race）
      }
    }
  } catch { /* 略 */ }

  // P1 (v1.8.59): init 時跑一次同步,讓使用者打開 options 立刻看到正確的 hint state
  // (若 saved prompt 已客製,hint 應該 init 顯示;若是任一 effective default,
  // 自動切到當前 target 的版本字面值)
  updateAllPromptTargetHints();

  // P2 (v1.8.60): UI i18n — 套用 data-i18n attributes,訂閱 storage.uiLanguage 變動。
  // UI 語系改用獨立 #uiLanguage picker 控制(預設 'auto' 跟 navigator.language),
  // 跟 #targetLanguage(翻譯目標)解綁。
  const I18N = window.__SK?.i18n;
  // 同步 #uiLanguage picker 的 value(若 element 存在)
  if ($('uiLanguage')) {
    const ul = (typeof s.uiLanguage === 'string' && UI_LANGUAGES.includes(s.uiLanguage))
      ? s.uiLanguage : 'auto';
    $('uiLanguage').value = ul;
  }
  if (I18N) {
    const dictLang = I18N.getUiLanguage($('uiLanguage')?.value || s.uiLanguage || 'auto');
    I18N.applyI18n(document, dictLang);
    { const _vEl = $('options-version');
      if (_vEl) _vEl.textContent = 'v' + browser.runtime.getManifest().version; }
    // refreshSlotDropdownLabels 在 load() 較早處(line ~273)已跑過一次,但當時
    // $('uiLanguage').value 還沒從 storage 同步進去,_t() 會用 HTML 預設 'auto'
    // → 跑到 en dict。現在 picker value 已 sync,重做一次拿到正確 dict。
    refreshSlotDropdownLabels();
    // v1.8.61:幣值 section 只在繁中 UI 顯示
    _updateCurrencySectionVisibility();
    // v1.8.61:Toast opacity label 動態 i18n 字串
    _renderToastOpacityLabel($('toastOpacity')?.value || 70);
    // v1.8.61:字幕 prompt token hint 重 render — load() line 293 已呼叫過一次,但當時
    // picker.value 還沒從 storage sync(走 navigator.language 推 auto),Jimmy 機器是
    // 繁中環境就拿到繁中,即使 stored uiLanguage='en' 也無效。picker.value sync 後重 render 一次。
    updateYtPromptCostHint();
    I18N.subscribeUiLanguageChange((newUi /* , newPref */) => {
      I18N.applyI18n(document, newUi);
      { const _vEl = $('options-version');
        if (_vEl) _vEl.textContent = 'v' + browser.runtime.getManifest().version; }
      // 動態 dropdown(refreshSlotDropdownLabels)用 _t() 取 prefix,UI 語系切換要重組
      refreshSlotDropdownLabels();
      // v1.8.61:#currency-rate-display 不掛 data-i18n,applyI18n 不會碰它,
      // UI 語系切換要主動重 render 才會看到新語言的「目前匯率: ...」字串
      refreshExchangeRateDisplay();
      // v1.8.61:幣值 section 隨 UI 語言切換顯示 / 隱藏
      _updateCurrencySectionVisibility();
      // v1.8.61:Toast opacity label 跟著 UI 語系重 render
      _renderToastOpacityLabel($('toastOpacity')?.value || 70);
      // v1.8.61:字幕 prompt token 開銷 hint 是純動態 _t() 計算,applyI18n 不碰,
      // 主動 reapply 才會看到新語言的 dict 字串
      updateYtPromptCostHint();
    });
  }
}

// P2 helper: SK.t shortcut for dynamic strings
const _t = (key, params) => {
  const I18N = window.__SK?.i18n;
  if (!I18N) return key;
  const dictLang = I18N.getUiLanguage($('uiLanguage')?.value || 'auto');
  return I18N.t(key, params, dictLang);
};

// v1.6.1: 「不再提示」按鈕——寫 disableUpdateNotice=true 立即生效
$('update-banner-dismiss')?.addEventListener('click', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  await browser.storage.sync.set({ disableUpdateNotice: true });
  $('update-banner-row').hidden = true;
});

// v1.6.3: update banner 主體用 document-level delegation 處理，不依賴 init() timing。
// click handler 內臨時讀 storage 拿最新 releaseUrl，避免 init() race condition。
document.addEventListener('click', async (e) => {
  // closest 同時涵蓋點 banner 內的 strong / span 子元素
  const banner = e.target.closest('#update-banner');
  if (!banner) return;
  e.preventDefault();
  try {
    const { updateAvailable } = await browser.storage.local.get('updateAvailable');
    // 三層 fallback：storage.releaseUrl > 用 version 組 tag URL > releases 索引頁
    const url = updateAvailable?.releaseUrl
      || (updateAvailable?.version
        ? `https://github.com/jimmysu0309/shinkansen/releases/tag/v${updateAvailable.version}`
        : 'https://github.com/jimmysu0309/shinkansen/releases');
    await browser.tabs.create({ url });
  } catch (err) {
    console.error('[shinkansen] update-banner click failed', err);
  }
});

// v1.5.0: 雙語視覺標記預覽更新
// v1.8.31: 並排 light / dark 兩個預覽 box，各自有獨立 wrapper id
function updateDualDemoMark(mark) {
  ['dual-demo-wrapper-light', 'dual-demo-wrapper-dark'].forEach(id => {
    const wrapper = document.getElementById(id);
    if (wrapper) wrapper.setAttribute('data-sk-mark', mark);
  });
}

function getSelectedMarkStyle() {
  const checked = document.querySelector('input[name="markStyle"]:checked');
  const v = checked?.value;
  return ['tint', 'bar', 'dashed', 'none'].includes(v) ? v : 'tint';
}

// v1.8.52: 雙語強調色 — 與 content-ns.js 的 SK.DUAL_ACCENT_* 常數同步
const DUAL_ACCENT_TOKENS = ['auto', 'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'pink'];
const DUAL_ACCENT_HEX_MAP = {
  blue: '#3B82F6', green: '#10B981', yellow: '#F59E0B', orange: '#F97316',
  red: '#EF4444', purple: '#A855F7', pink: '#EC4899',
};
const DUAL_ACCENT_HEX_RE = /^#[0-9a-fA-F]{6}$/;

function sanitizeDualAccent(value) {
  if (typeof value !== 'string') return 'auto';
  const v = value.trim();
  if (DUAL_ACCENT_TOKENS.includes(v)) return v;
  if (DUAL_ACCENT_HEX_RE.test(v)) return v.toUpperCase();
  return 'auto';
}

function dualAccentToHex(value) {
  const norm = sanitizeDualAccent(value);
  if (norm === 'auto') return null;
  return DUAL_ACCENT_HEX_MAP[norm] || norm;
}

function dualAccentToRgbString(value) {
  const hex = dualAccentToHex(value);
  if (!hex) return null;
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 0xff} ${(n >> 8) & 0xff} ${n & 0xff}`;
}

// 目前 UI 上選中的強調色（'auto' / token / #RRGGBB）— 由 swatch / hex input 維護
let currentDualAccent = 'auto';

// 套到 light/dark 兩個 demo wrapper:auto 清屬性走預設,其餘寫 data-sk-accent + inline style
function applyDualAccentToDemo(value) {
  const norm = sanitizeDualAccent(value);
  const rgbStr = dualAccentToRgbString(norm);
  ['dual-demo-wrapper-light', 'dual-demo-wrapper-dark'].forEach(id => {
    const w = document.getElementById(id);
    if (!w) return;
    if (rgbStr) {
      w.setAttribute('data-sk-accent', 'custom');
      w.style.setProperty('--sk-accent-rgb', rgbStr);
    } else {
      w.removeAttribute('data-sk-accent');
      w.style.removeProperty('--sk-accent-rgb');
    }
  });
}

// 同步 swatch active 狀態 + hex input 顯示。
// hex input 顯示原則:auto → 空、token → 對照 hex、自訂 hex → 該 hex
function refreshDualAccentUI() {
  const norm = currentDualAccent;
  for (const btn of document.querySelectorAll('.dual-accent-swatch')) {
    btn.classList.toggle('is-active', btn.dataset.token === norm);
  }
  const hexInput = document.getElementById('dualAccentHexInput');
  const picker = document.getElementById('dualAccentColorPicker');
  const hex = dualAccentToHex(norm);
  if (hexInput) {
    if (norm === 'auto') {
      hexInput.value = '';
      hexInput.removeAttribute('aria-invalid');
    } else {
      hexInput.value = hex || '';
      hexInput.removeAttribute('aria-invalid');
    }
  }
  if (picker && hex) picker.value = hex;
  applyDualAccentToDemo(norm);
}

function setDualAccent(value) {
  currentDualAccent = sanitizeDualAccent(value);
  refreshDualAccentUI();
  if (typeof markDirty === 'function') markDirty();
}

// v1.8.41：Firefox HTTPS-Only Mode 偵測——baseUrl 是 http:// + UA 是 Firefox 才顯示警告。
// Firefox 開啟 HTTPS-Only Mode（about:preferences#privacy）會把 extension 發出的 http
// request 強制升級成 https，extension 端無法 override；連本機 server 直接失敗。
// 對使用者而言錯誤訊息只會顯示「網路錯誤」沒上下文，inline 警告直接點出根因。
function isFirefoxUserAgent() {
  return typeof navigator !== 'undefined' && /Firefox\//.test(navigator.userAgent || '');
}

function refreshFirefoxHttpsWarn() {
  const warn = document.getElementById('cp-baseurl-firefox-warn');
  if (!warn) return;
  const url = ($('cp-baseUrl')?.value || '').trim().toLowerCase();
  const shouldWarn = url.startsWith('http://') && isFirefoxUserAgent();
  warn.hidden = !shouldWarn;
}

// v1.8.44:Firefox 預設快捷鍵衝突警告——Alt+S/A/D 在 Firefox 會被瀏覽器或第三方擴充攔截
// (Alt+S = 歷史 menu mnemonic、Alt+D = 地址列焦點、Alt+A 容易被 Save Page WE 等擴充攔截),
// Chrome 沒此問題。manifest 的 commands 是跨瀏覽器共用,不能針對 Firefox 覆寫,
// 只能引導使用者自行去 about:addons 改快捷鍵。
function refreshFirefoxShortcutWarn() {
  const warn = document.getElementById('shortcut-firefox-warn');
  if (!warn) return;
  warn.hidden = !isFirefoxUserAgent();
}

// v1.8.41：讀取目前選中的幣值 radio
function getSelectedCurrency() {
  const checked = document.querySelector('input[name="displayCurrency"]:checked');
  const v = checked?.value;
  return ['USD', 'TWD'].includes(v) ? v : 'TWD';
}

// v1.8.41：當前幣值 + 匯率快取狀態，給 fmt helpers 用，避免每次顯示都 await
let currentCurrencyState = { currency: 'TWD', rate: 31.6, fetchedAt: 0, source: 'fallback' };

function fmtMoneyOpts() {
  return { currency: currentCurrencyState.currency, rate: currentCurrencyState.rate };
}

// v1.8.61:Toast 透明度 label 走 i18n 動態字串(原本 source HTML 寫死繁中導致
// en / zh-CN UI 漏翻)。每次 slider 拖動 / init / UI 語系切換都重 render。
function _renderToastOpacityLabel(value) {
  const wrap = document.getElementById('toastOpacityLabelWrap');
  if (!wrap) return;
  wrap.textContent = _t('options.toast.opacity', { value });
}

// v1.8.61:「金額顯示幣值」section 只在繁中 UI 顯示。
// 邏輯:取當前 effective UI 語言(由 #uiLanguage picker 推導,auto 會走 navigator),
// 等於 'zh-TW' 才 show,其餘隱藏整個 section。對應使用情境:TWD/USD 換算對非繁中
// 使用者無意義,匯率以 USD/TWD 計,英文 / 簡中 / 其他 UI 使用者預設用 USD。
function _updateCurrencySectionVisibility() {
  const sec = document.getElementById('currency-section');
  if (!sec) return;
  const I18N = window.__SK?.i18n;
  const uiPref = $('uiLanguage')?.value || 'auto';
  const dictLang = I18N ? I18N.getUiLanguage(uiPref) : 'zh-TW';
  sec.hidden = (dictLang !== 'zh-TW');
}

// v1.8.41:更新「目前匯率」顯示文字 + radio 同步
// v1.8.61:#currency-rate-display 移除 data-i18n,完全由本函式控制 textContent。
//   - 開頭立刻 set loading(用當前 UI 語言),不再依賴 source HTML 預設值
//   - sendMessage 失敗 / resp.ok 是 falsy 時顯示「讀取失敗」(原本沉默失敗會永遠停在 loading)
async function refreshExchangeRateDisplay() {
  const el = document.getElementById('currency-rate-display');
  if (!el) return;
  el.textContent = _t('options.currency.rateLoading');
  try {
    const resp = await browser.runtime.sendMessage({ type: 'EXCHANGE_RATE_GET' });
    if (resp?.ok) {
      currentCurrencyState = {
        currency: getSelectedCurrency(),
        rate: resp.rate,
        fetchedAt: resp.fetchedAt,
        source: resp.source,
      };
      el.textContent = formatRateLine(resp);
    } else {
      el.textContent = _t('options.currency.rateFailed');
    }
  } catch {
    el.textContent = _t('options.currency.rateFailed');
  }
}

function formatRateLine(rate) {
  const rateStr = Number(rate.rate).toFixed(2);
  if (rate.source === 'fallback' || !rate.fetchedAt) {
    return _t('options.currency.rateFallback', { rate: rateStr });
  }
  const d = new Date(rate.fetchedAt);
  const ymd = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const hm  = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  return _t('options.currency.rateOk', { rate: rateStr, ymd, hm });
}

// v1.4.13: engine='google' 時隱藏 model 欄
// v1.5.7: engine='openai-compat' 也隱藏（model 由「自訂 Provider」分頁設定）
function updatePresetModelVisibility(slot) {
  const engine = $(`preset-engine-${slot}`).value;
  const row = $(`preset-model-row-${slot}`);
  if (row) row.hidden = (engine === 'google' || engine === 'openai-compat');
}

// 「工具列翻譯本頁按鈕」「自動翻譯網站」兩個下拉選單的 option text
// 跟著「翻譯快速鍵」preset 標籤即時聯動。直接從 DOM input 讀目前值，
// 不需重新讀 storage，使用者打字當下就能看到變化。
function _slotTitle(slot) {
  if (slot === 2) return _t('options.preset.primary');
  if (slot === 1) return _t('options.preset.slot2');
  return _t('options.preset.slot3');
}
function refreshSlotDropdownLabels() {
  const popupSlotSel = $('popup-button-slot');
  const autoSlotSel = $('auto-translate-slot');
  for (const slot of [1, 2, 3]) {
    const labelInput = $(`preset-label-${slot}`);
    const label = (labelInput?.value || '').trim() || _slotTitle(slot);
    const text = `${_slotTitle(slot)}：${label}`;
    const popupOpt = popupSlotSel?.querySelector(`option[value="${slot}"]`);
    if (popupOpt) popupOpt.textContent = text;
    const autoOpt = autoSlotSel?.querySelector(`option[value="${slot}"]`);
    if (autoOpt) autoOpt.textContent = text;
  }
}

// v1.5.8: YouTube 字幕分頁 — 依引擎切換 section 可見性。
//   gemini        → 顯示「翻譯模型」「翻譯參數」「字幕翻譯 Prompt」全部
//   google        → 全部隱藏（Google MT 不支援自訂任何參數）
//   openai-compat → 只顯示「字幕翻譯 Prompt」（model/計價/temperature 從「自訂模型」分頁那組共用，
//                   但 prompt 字幕專用）
function updateYtSectionVisibility() {
  const engine = $('ytEngine')?.value || 'gemini';
  const geminiOnly = document.getElementById('yt-gemini-only-sections');
  const promptSection = document.getElementById('yt-prompt-section');
  if (geminiOnly) geminiOnly.hidden = (engine !== 'gemini');
  if (promptSection) promptSection.hidden = (engine === 'google');
}

// v1.5.8: 字幕分頁 prompt 開銷估算 — 用「目前字幕用的 model + input 單價」算
// 一支 30 分鐘影片打開「固定術語表」/「禁用詞清單」toggle 後 prompt 多花多少錢。
function updateYtPromptCostHint() {
  const hintEl = $('yt-prompt-cost-hint');
  if (!hintEl) return;

  // 找 input 單價：優先 yt.pricing > yt.model 查表 > 主 inputPerMTok
  let inputPrice = 0;
  let modelDisplay = '';
  const engine = $('ytEngine')?.value || 'gemini';
  const cpInput = parseFloat($('cp-inputPerMTok').value);
  const cpModel = ($('cp-model').value || '').trim();
  const ytModel = $('ytModel').value;
  const ytInput = parseFloat($('ytInputPerMTok').value);
  const mainModel = getSelectedModel();
  // v1.6.16: 後備路徑單價 UI 已移除；mainInput fallback 改用主要預設（slot 2）的內建表 pricing。
  // 這個 hint 是設定頁字幕 prompt 開銷估算用，翻譯實際計費走獨立路徑（yt.pricing / customProvider / preset modelOverride)，不受影響。
  const mainInput = MODEL_PRICING[mainModel]?.input ?? 0;

  if (engine === 'openai-compat') {
    // 自訂模型字幕路徑用 customProvider 那組
    inputPrice = isNaN(cpInput) ? 0 : cpInput;
    modelDisplay = cpModel || _t('options.cp.modelDisplayUnset');
  } else if (engine === 'gemini') {
    if (!isNaN(ytInput) && ytInput > 0) {
      inputPrice = ytInput;
      modelDisplay = ytModel || mainModel;
    } else if (ytModel && MODEL_PRICING[ytModel]) {
      inputPrice = MODEL_PRICING[ytModel].input;
      modelDisplay = ytModel;
    } else if (!isNaN(mainInput)) {
      inputPrice = mainInput;
      modelDisplay = mainModel;
    }
  }
  // engine === 'google' 不算費用（免費）

  // Token 估算（粗估；中文 ~1.5 char/token、英文 ~4 char/token、混合 ~2 char/token）：
  // 黑名單 prompt block：tag + 標頭 + 結尾說明 baseline ~450 token；每條對映「視頻 → 影片」~3 token
  // 固定術語表 block：標頭 baseline ~67 token；每條 source→target ~5 token
  const fbCount = Array.isArray(forbiddenTerms) ? forbiddenTerms.filter(t => t && t.forbidden).length : 0;
  const fgCount = (fixedGlossary?.global || []).filter(e => e.source && e.target).length;
  const fbTok = fbCount > 0 ? 450 + 3 * fbCount : 0;
  const fgTok = fgCount > 0 ? 67  + 5 * fgCount : 0;

  // 一支 30 分鐘影片：windowSize 30s → 60 windows × 平均每 window 1 batch ≈ 60 batches
  const BATCHES_PER_30MIN = 60;
  function fmtUSD(tok, cacheRatio = 1) {
    if (!inputPrice || !tok) return '$0';
    const usd = tok * BATCHES_PER_30MIN / 1_000_000 * inputPrice * cacheRatio;
    if (usd < 0.0001) return '<$0.0001';
    if (usd < 0.01)   return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(3)}`;
  }

  if (engine === 'google') {
    hintEl.innerHTML = _t('options.gemini.cost.googleHint.html');
    return;
  }
  if (!inputPrice) {
    // AMO source review: 純 dev hardcoded 字串(經 dict t() 查表)，無外部變數。
    hintEl.innerHTML = _t('options.gemini.cost.noPrice.html');
    return;
  }

  // AMO source review: 模型名稱經 escapeHtml,其他 ${...} 是純數字計算結果,無 user input;
  // dict 字串本身在 i18n.js 中,t() 內部 _interp 不做 escape,但 params 來源都是
  // 計算結果或預先 escape 過的字串,符合 AMO 要求。
  hintEl.innerHTML =
    _t('options.gemini.cost.estimateHeader.html', {
      model: escapeHtml(modelDisplay),
      inputPrice,
    }) + '<br>' +
    `<span style="display:inline-block; margin-left: 12px;">${_t('options.gemini.cost.estimateGlossary.html', {
      count: fgCount, tok: fgTok, usd: fmtUSD(fgTok), usdCache: fmtUSD(fgTok, 0.25),
    })}</span><br>` +
    `<span style="display:inline-block; margin-left: 12px;">${_t('options.gemini.cost.estimateForbidden.html', {
      count: fbCount, tok: fbTok, usd: fmtUSD(fbTok), usdCache: fmtUSD(fbTok, 0.25),
    })}</span><br>` +
    `<span style="font-size: 11px; color: #999;">${_t('options.gemini.cost.estimateFooter.html')}</span>`;
}

// v1.4.13: 從 chrome.commands.getAll() 讀取實際綁定鍵位顯示在每張 card 右上角
// v1.8.19: command id 主要預設（slot 2）從 translate-preset-2 改為 translate-preset-0
//          （字典序保證 chrome://extensions/shortcuts 顯示順序「主要 → 預設 2 → 預設 3」)
async function refreshPresetKeyBindings() {
  const SLOT_TO_COMMAND_ID = { 1: 'translate-preset-1', 2: 'translate-preset-0', 3: 'translate-preset-3' };
  try {
    const cmds = await browser.commands.getAll();
    for (const slot of [1, 2, 3]) {
      const cmd = cmds.find(c => c.name === SLOT_TO_COMMAND_ID[slot]);
      const keyEl = $(`preset-key-${slot}`);
      if (!keyEl) continue;
      if (cmd?.shortcut) {
        keyEl.textContent = cmd.shortcut;
        keyEl.removeAttribute('data-unset');
      } else {
        keyEl.textContent = _t('common.unset');
        keyEl.setAttribute('data-unset', '1');
      }
    }
  } catch { /* Safari / 舊瀏覽器不支援 commands API，欄位維持 '—' */ }
}

// v1.8.14: 並發 save 防護
// 之前 save() 是 read-modify-write(sync.get → 組整桶 → sync.set)，沒任何 lock。
// 兩個 Tab 的儲存按鈕共用同一個 save()，快速連按 / 跨 Tab 同時改 / 打字+按鈕同時觸發
// → 後一筆 set 可能蓋掉前一筆 get 之間的 in-flight 變更。
let _saveInFlight = false;

async function save() {
  if (_saveInFlight) return;
  _saveInFlight = true;
  try {
    return await _saveImpl();
  } finally {
    _saveInFlight = false;
  }
}

async function _saveImpl() {
  // v0.62 起：apiKey 單獨寫到 browser.storage.local，不進 sync
  const apiKeyValue = $('apiKey').value.trim();
  await browser.storage.local.set({ apiKey: apiKeyValue });
  // v1.6.15: 讀回現存的 geminiConfig.model 不從 UI 取（全域 dropdown 已移除）。
  // 保留 storage 欄位避免 migration，且 testGeminiKey 已改走「主要預設」的 model。
  // v1.6.16: 同樣讀回 settings.pricing（後備路徑單價 UI 也移除了）。
  const existing = await browser.storage.sync.get(['geminiConfig', 'pricing']);
  const existingModel = existing.geminiConfig?.model || DEFAULTS.geminiConfig.model;
  // v1.9.16:targetLanguage 已搬到 popup,由 popup 的 change handler 直接寫 storage,
  // options「儲存設定」不寫此欄位避免回灌 stale 值(使用者在 options 開著時於 popup 改 target,
  // 然後在 options 按儲存設定 — 不該把 _currentTargetLang module 變數寫回)。
  const settings = {
    geminiConfig: {
      model: existingModel,
      serviceTier: $('serviceTier').value,
      // v1.8.20: 改用 parseUserNum——空字串/非法字元走 default，避免 NaN 寫進 storage 後送 API 拒絕。
      temperature: parseUserNum($('temperature').value, DEFAULTS.geminiConfig.temperature),
      topP: parseUserNum($('topP').value, DEFAULTS.geminiConfig.topP),
      topK: parseUserNum($('topK').value, DEFAULTS.geminiConfig.topK),
      maxOutputTokens: parseUserNum($('maxOutputTokens').value, DEFAULTS.geminiConfig.maxOutputTokens),
      systemInstruction: $('systemInstruction').value,
    },
    // v1.6.16: 後備路徑單價 UI 已移除，從 storage 拉現存值寫回（沿用 v1.6.15 對 geminiConfig.model 的同 pattern)
    pricing: existing.pricing || DEFAULTS.pricing,
    domainRules: {
      whitelist: $('whitelist').value.split('\n').map(s => s.trim()).filter(Boolean),
    },
    debugLog: $('debugLog').checked,
    tier: $('tier').value,
    // v1.6.19: 改用 parseUserNum——空字串/非法字元走 default，合法數字（含 0）保留。
    // 沿用 `|| default` 會把使用者明確打的 0 一律當 falsy 改回預設，造成 UI 不一致。
    // v1.8.19: safetyMargin 從 UI 移除，save() 不再寫，維持 storage 既有值（0.1)
    maxRetries: parseUserNum($('maxRetries').value, 3),
    maxConcurrentBatches: parseUserNum($('maxConcurrentBatches').value, 10),
    maxUnitsPerBatch: parseUserNum($('maxUnitsPerBatch').value, 20),
    maxCharsPerBatch: parseUserNum($('maxCharsPerBatch').value, 3500),
    maxTranslateUnits: parseUserNum($('maxTranslateUnits').value, 1000),
    // v1.8.3: 只翻文章開頭（節省費用）
    partialMode: {
      enabled: $('partialModeEnabled').checked,
      maxUnits: parseUserNum($('partialModeMaxUnits').value, 25),
    },
    // 只有 custom tier 才寫入 override（其他 tier 的數字從對照表讀，不存）
    rpmOverride: $('tier').value === 'custom' ? (Number($('rpm').value) || null) : null,
    tpmOverride: $('tier').value === 'custom' ? (Number($('tpm').value) || null) : null,
    rpdOverride: $('tier').value === 'custom' ? (Number($('rpd').value) || null) : null,
    // v0.69: 術語表一致化
    glossary: {
      enabled: $('glossaryEnabled').checked,
      // v1.7.2: 術語擷取獨立模型；空字串 = 與主翻譯模型相同（舊行為）
      model: $('glossaryModel').value,
      prompt: $('glossaryPrompt').value,
      // v1.8.20: 改 parseUserNum，避免使用者打 0 （合法 temperature) 被 falsy 改回 0.1
      temperature: parseUserNum($('glossaryTemperature').value, DEFAULTS.glossary.temperature ?? 0.1),
      skipThreshold: DEFAULTS.glossary.skipThreshold,
      // v1.7.3: blockingThreshold 使用者可調（0 = 永遠 fire-and-forget，大值 = 幾乎都 blocking)
      blockingThreshold: parseUserNum($('glossaryBlockingThreshold').value, DEFAULTS.glossary.blockingThreshold),
      // v1.8.61:UI 是秒,儲存前 × 1000 換算成 ms(storage schema 仍 timeoutMs)
      timeoutMs: parseUserNum($('glossaryTimeout').value, 60) * 1000,
      maxTerms: DEFAULTS.glossary.maxTerms,
    },
    // v1.0.17: Toast 透明度 / v1.0.31: Toast 位置
    // v1.8.20: 空字串 → 0/100 = 0 → toast 完全透明，改 parseUserNum 走預設
    toastOpacity: parseUserNum($('toastOpacity').value, (DEFAULTS.toastOpacity ?? 0.95) * 100) / 100,
    toastPosition: $('toastPosition').value,
    // v1.1.3: Toast 自動關閉
    toastAutoHide: $('toastAutoHide').checked,
    // v1.6.8: Toast master switch（false 完全不顯示，連訊息都不發）
    showProgressToast: $('showProgressToast').checked,
    // v1.5.0: 雙語對照視覺標記
    translationMarkStyle: getSelectedMarkStyle(),
    // v1.8.52: 雙語強調色（已在 setDualAccent 時 sanitize 過,直接寫）
    dualAccentColor: currentDualAccent,
    // v1.8.41：金額顯示幣值
    displayCurrency: getSelectedCurrency(),
    // v1.0.21: 頁面層級繁中偵測開關
    // v1.2.11: YouTube 字幕設定
    ytSubtitle: {
      engine: ($('ytEngine')?.value || 'gemini'),  // v1.4.0
      autoTranslate:      $('ytAutoTranslate').checked,
      // v1.6.23: ASR 分句單一 toggle——checked=progressive（混合）、unchecked=heuristic
      asrMode: $('ytAsrProgressive').checked ? 'progressive' : 'heuristic',
      // v1.5.8: 字幕是否套用固定術語表 / 黑名單
      applyFixedGlossary:  $('ytApplyFixedGlossary').checked,
      applyForbiddenTerms: $('ytApplyForbiddenTerms').checked,
      debugToast:         $('ytDebugToast').checked,
      onTheFly:           $('ytOnTheFly').checked,          // v1.2.49
      // preserveLineBreaks: 已移除 toggle，永遠 true（content-youtube.js 硬編碼）
      // v1.8.20: 改 parseUserNum——避免空字串走預設 + temperature 0 不被當 falsy + NaN ?? 1 = NaN 的陷阱
      windowSizeS:  parseUserNum($('ytWindowSizeS').value, DEFAULTS.ytSubtitle.windowSizeS ?? 30),
      lookaheadS:   parseUserNum($('ytLookaheadS').value, DEFAULTS.ytSubtitle.lookaheadS ?? 10),
      temperature:  parseUserNum($('ytTemperature').value, DEFAULTS.ytSubtitle.temperature ?? 1),
      systemPrompt: $('ytSystemPrompt').value || DEFAULT_SUBTITLE_SYSTEM_PROMPT,
      // v1.2.39: 獨立模型 + 計價
      model: $('ytModel').value || '',
      pricing: (() => {
        const inp = parseFloat($('ytInputPerMTok').value);
        const out = parseFloat($('ytOutputPerMTok').value);
        if (isNaN(inp) && isNaN(out)) return null; // 空白 → 與主模型相同，null 表示不覆蓋
        return {
          inputPerMTok:  isNaN(inp) ? null : inp,
          outputPerMTok: isNaN(out) ? null : out,
        };
      })(),
    },
    // v1.4.13: 三組 preset 快速鍵
    // v1.5.7: engine 接受三種 'gemini' / 'google' / 'openai-compat'，不認識的回退 'gemini'。
    // 之前只認 'google' / 'gemini' → 使用者改成 'openai-compat' 儲存後被強制 reset。
    translatePresets: [1, 2, 3].map(slot => {
      const raw = $(`preset-engine-${slot}`).value;
      const engine = (raw === 'google' || raw === 'openai-compat') ? raw : 'gemini';
      // model 欄只對 gemini 有意義（google 與 openai-compat 都用各自分頁的設定）
      const model = engine === 'gemini' ? ($(`preset-model-${slot}`).value || null) : null;
      const label = ($(`preset-label-${slot}`).value || '').trim()
        || _t('options.preset.fallbackLabel', { slot });
      return { slot, engine, model, label };
    }),
    // v1.6.6: 工具列「翻譯本頁」按鈕對應的 preset slot
    popupButtonSlot: (() => {
      const v = Number($('popup-button-slot')?.value);
      return [1, 2, 3].includes(v) ? v : 2;
    })(),
    // v1.6.13: 自動翻譯網站（白名單）觸發時走的 preset slot
    autoTranslateSlot: (() => {
      const v = Number($('auto-translate-slot')?.value);
      return [1, 2, 3].includes(v) ? v : 2;
    })(),
    // v1.6.14: per-model 計價覆蓋（Google 改價時使用者自填）。
    // v1.9.2: cachedDiscount 獨立欄位,可單獨覆蓋(只填折扣不填價格也合法)。
    //   input/output 兩欄都是合法數字才寫入 input/output entry,任一欄空白 → 走內建表;
    //   cachedDiscount 獨立 — UI 0-100% 轉成 0-1 比例存,空白 → 走內建表(預設 90%)。
    //   只要任一欄有值,該 model 在 overrides 物件就有 entry(即便只填 discount)。
    modelPricingOverrides: (() => {
      const collect = (model, inputId, outputId, discountId) => {
        const i = $(inputId)?.value?.trim() ?? '';
        const o = $(outputId)?.value?.trim() ?? '';
        const d = $(discountId)?.value?.trim() ?? '';
        const entry = { model };
        if (i !== '' && o !== '') {
          const ni = Number(i), no = Number(o);
          if (Number.isFinite(ni) && Number.isFinite(no) && ni >= 0 && no >= 0) {
            entry.inputPerMTok = ni;
            entry.outputPerMTok = no;
          }
        }
        if (d !== '') {
          const nd = Number(d);
          if (Number.isFinite(nd) && nd >= 0 && nd <= 100) {
            entry.cachedDiscount = nd / 100; // UI 百分比 → 儲存比例
          }
        }
        // entry 只有 model 一個 key → 沒有任何合法覆蓋值
        return Object.keys(entry).length > 1 ? entry : null;
      };
      const rows = [
        collect('gemini-3.1-flash-lite', 'override-lite-input',  'override-lite-output',  'override-lite-discount'),
        collect('gemini-3-flash-preview',         'override-flash-input', 'override-flash-output', 'override-flash-discount'),
        collect('gemini-3.5-flash',         'override-pro-input',   'override-pro-output',   'override-pro-discount'),
      ].filter(Boolean);
      const out = {};
      for (const r of rows) {
        const { model, ...rest } = r;
        out[model] = rest;
      }
      return out;
    })(),
    // v1.0.29: 固定術語表（save 前先同步 UI → 記憶體）
    fixedGlossary: (() => {
      // 同步全域表格的最新 UI 值
      fixedGlossary.global = readGlossaryTableEntries($('fixed-global-tbody'));
      // 同步當前網域表格的最新 UI 值
      if (currentDomain && fixedGlossary.byDomain[currentDomain]) {
        fixedGlossary.byDomain[currentDomain] = readGlossaryTableEntries($('fixed-domain-tbody'));
      }
      // 過濾掉空的 entries（source 和 target 都為空）
      const cleanGlobal = fixedGlossary.global.filter(e => e.source || e.target);
      const cleanByDomain = {};
      for (const [domain, entries] of Object.entries(fixedGlossary.byDomain)) {
        const clean = entries.filter(e => e.source || e.target);
        if (clean.length > 0) cleanByDomain[domain] = clean;
      }
      return { global: cleanGlobal, byDomain: cleanByDomain };
    })(),
    // v1.5.6: 中國用語黑名單（save 前先同步 UI → 記憶體；過濾兩欄都空的列）
    forbiddenTerms: (() => {
      forbiddenTerms = readForbiddenTableEntries();
      return forbiddenTerms.filter(t => t.forbidden || t.replacement);
    })(),
    // v1.5.7: 自訂 OpenAI-compatible Provider
    // v1.6.18: 加入 thinkingLevel + extraBodyJson（各家 thinking schema 統一抽象）
    customProvider: {
      baseUrl: ($('cp-baseUrl').value || '').trim(),
      model: ($('cp-model').value || '').trim(),
      systemPrompt: $('cp-systemPrompt').value || '',
      // v1.8.20: temperature 改 parseUserNum 避免 0 被當 falsy；單價 0 是合法值改 parseUserNum 0
      temperature: parseUserNum($('cp-temperature').value, DEFAULTS.customProvider?.temperature ?? 0.7),
      fetchTimeoutSec: parseUserNum($('cp-fetchTimeout').value, 15),
      inputPerMTok: parseUserNum($('cp-inputPerMTok').value, 0),
      outputPerMTok: parseUserNum($('cp-outputPerMTok').value, 0),
      // v1.9.2: UI 0-100% → 儲存比例 0-1;空白 → null(讓 background 走 baseUrl 自動推導)
      cachedDiscount: (() => {
        const raw = $('cp-cachedDiscount')?.value?.trim();
        if (!raw) return null;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || n > 100) return null;
        return n / 100;
      })(),
      thinkingLevel: (() => {
        const v = $('cp-thinking-level')?.value;
        return ['auto', 'off', 'low', 'medium', 'high'].includes(v) ? v : 'auto';
      })(),
      extraBodyJson: ($('cp-extra-body-json')?.value || '').trim(),
      // 強化段序號標記(預設 true)。讀取走 cp.useStrongSegMarker !== false 等同預設開啟,
      // 對齊舊使用者升級後 undefined 也得到新行為。
      useStrongSegMarker: $('cp-strong-seg-marker')?.checked !== false,
    },
  };
  // v1.5.7: customProvider.apiKey 走 storage.local（與主 apiKey 同樣設計），先抽出再寫 sync
  const cpApiKeyValue = ($('cp-apiKey').value || '').trim();
  await browser.storage.local.set({ customProviderApiKey: cpApiKeyValue });
  await browser.storage.sync.set(settings);
  $('save-status').textContent = _t('options.action.saved');
  setTimeout(() => { $('save-status').textContent = ''; }, 2000);
  // v0.94: 顯示綠色已儲存提示條
  showSaveBar('saved', _t('options.action.savedBar'));
}

$('save').addEventListener('click', save);
// v1.0.28: Gemini 分頁也共用同一個 save()
$('save-gemini').addEventListener('click', save);
// v1.0.29: 術語表分頁也共用同一個 save()
$('save-glossary').addEventListener('click', save);
// v1.5.6: 禁用詞清單分頁
$('save-forbidden').addEventListener('click', save);
// v1.5.7: 自訂 Provider 分頁
$('save-custom-provider').addEventListener('click', save);

// v1.5.7: 自訂 Provider API Key 顯示 / 隱藏切換
$('cp-toggle-apiKey').addEventListener('click', () => {
  const input = $('cp-apiKey');
  const btn = $('cp-toggle-apiKey');
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = _t('options.action.hide');
  } else {
    input.type = 'password';
    btn.textContent = _t('options.action.show');
  }
});

// v1.5.7: 自訂模型 API 測試
$('cp-test-apiKey').addEventListener('click', async () => {
  await runApiTest({
    btn: $('cp-test-apiKey'),
    resultEl: $('cp-test-apiKey-result'),
    sendMessage: () => browser.runtime.sendMessage({
      type: 'TEST_CUSTOM_PROVIDER',
      payload: {
        baseUrl: ($('cp-baseUrl').value || '').trim(),
        model: ($('cp-model').value || '').trim(),
        apiKey: ($('cp-apiKey').value || '').trim(),
      },
    }),
  });
});
// P1 (v1.8.59): 切換目標語言時同步 prompt textarea
//
// 對單一 textarea 跑同步邏輯:
//   - 若 textarea 內容是「視為未客製」(空 / trim 等於三 target 任一 effective default)
//     → 自動更新為新 target 的 effective default,hint 隱藏
//   - 若 textarea 內容已客製(不等於任一 default)
//     → 保留 textarea,hint 顯示警示提醒使用者「prompt 沒跟著切」
function _syncPromptTextareaToTarget(textareaId, hintId, getEffectiveFn) {
  const textarea = $(textareaId);
  const hint = $(hintId);
  if (!textarea) return;
  const tl = _currentTargetLang;
  const cur = textarea.value || '';
  // 所有 target 各自的 effective default 對 cur 跑 isPromptUnchangedFromDefault(走 storage.js
  // normalize 邏輯,容忍歷史小幅修字,例如 v1.8.59 的「中國大陸」→「中國」)。
  // 任一命中 → 視為「未客製」,自動覆蓋為新 target 的 default;否則保留 + show hint。
  const treatedAsUnchanged = TARGET_LANGUAGES
    .some(t => isPromptUnchangedFromDefault(cur, getEffectiveFn(t, '')));
  if (treatedAsUnchanged) {
    textarea.value = getEffectiveFn(tl, '');
    if (hint) hint.hidden = true;
  } else {
    if (hint) hint.hidden = false;
  }
}

// 四個 textarea 一起跑(主翻譯 / 術語表抽取 / YouTube 字幕 / 自訂模型)
//   自訂模型 cp-systemPrompt 預設等於 Gemini DEFAULT_SYSTEM_PROMPT(line 364 of storage.js),
//   所以共用 getEffectiveSystemPrompt 同一個 factory。
function updateAllPromptTargetHints() {
  _syncPromptTextareaToTarget('systemInstruction', 'systemInstruction-target-hint', getEffectiveSystemPrompt);
  _syncPromptTextareaToTarget('glossaryPrompt', 'glossaryPrompt-target-hint', getEffectiveGlossaryPrompt);
  _syncPromptTextareaToTarget('ytSystemPrompt', 'ytSystemPrompt-target-hint', getEffectiveSubtitleSystemPrompt);
  _syncPromptTextareaToTarget('cp-systemPrompt', 'cp-systemPrompt-target-hint', getEffectiveSystemPrompt);
}

// v1.9.16:翻譯目標語言 picker 搬到 popup,options 改用 storage.onChanged 監聽。
// popup 寫 targetLanguage → 這裡同步更新 _currentTargetLang + 三條 refresher
// (prompt textarea hint / 語言偵測 label / 禁用詞表預設)。如此使用者在 options
// 開著的同時於 popup 切 target,options 內畫面立刻反映新 target,不需 reload。
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.targetLanguage) return;
  const nv = changes.targetLanguage.newValue;
  if (typeof nv !== 'string' || !TARGET_LANGUAGES.includes(nv)) return;
  if (nv === _currentTargetLang) return;
  _currentTargetLang = nv;
  updateAllPromptTargetHints();
  // 禁用詞清單依 target 重對:目前內容 == DEFAULT_FORBIDDEN_TERMS(視為未客製)
  // 切到非 zh-TW → 清空(en/zh-CN 不需要禁用中國用語);切到 zh-TW → 還原預設。
  // 已客製化(內容跟 DEFAULT 不同)不動,保留使用者手動編輯結果。
  _syncForbiddenTermsToTarget(nv);
});

// P2 (v1.8.60):#uiLanguage picker change handler — 立刻寫 storage(UI 跟著切),
// 不需等「儲存設定」。subscribe callback 會 reapply applyI18n + refreshSlotDropdownLabels。
$('uiLanguage')?.addEventListener('change', async () => {
  const v = $('uiLanguage').value;
  const ul = UI_LANGUAGES.includes(v) ? v : 'auto';
  try {
    await browser.storage.sync.set({ uiLanguage: ul });
  } catch (err) {
    console.error('[shinkansen] uiLanguage set failed', err);
  }
  // 立刻 reapply:subscribe 機制有時延遲,使用者體感「按了但沒變」很糟,直接同步觸發。
  if (window.__SK?.i18n) {
    const dictLang = window.__SK.i18n.getUiLanguage(ul);
    window.__SK.i18n.applyI18n(document, dictLang);
    refreshSlotDropdownLabels();
    // v1.8.61:#currency-rate-display 不掛 data-i18n,主動重 render 拿新語言匯率字串
    refreshExchangeRateDisplay();
    // v1.8.61:幣值 section 隨 UI 語言切換顯示 / 隱藏
    _updateCurrencySectionVisibility();
    // v1.8.61:Toast opacity label 跟著 UI 語系重 render
    _renderToastOpacityLabel($('toastOpacity')?.value || 70);
    // v1.8.61:字幕 prompt token 開銷 hint 是純動態 _t() 計算,主動 reapply
    updateYtPromptCostHint();
  }
});

// 判斷目前 forbiddenTerms 是否「視為未客製」:
//   完全等於 DEFAULT_FORBIDDEN_TERMS(同長度 + 每筆 forbidden/replacement 對齊),
//   或為空陣列(代表 zh-CN/en 的預設)
function _isForbiddenTermsUnchangedFromDefault() {
  if (!Array.isArray(forbiddenTerms)) return false;
  if (forbiddenTerms.length === 0) return true;
  if (forbiddenTerms.length !== DEFAULT_FORBIDDEN_TERMS.length) return false;
  for (let i = 0; i < forbiddenTerms.length; i++) {
    const a = forbiddenTerms[i];
    const b = DEFAULT_FORBIDDEN_TERMS[i];
    if ((a?.forbidden || '') !== b.forbidden || (a?.replacement || '') !== b.replacement) {
      return false;
    }
  }
  return true;
}

function _syncForbiddenTermsToTarget(tl) {
  if (!_isForbiddenTermsUnchangedFromDefault()) return; // 已客製化不動
  forbiddenTerms = tl === 'zh-TW' ? DEFAULT_FORBIDDEN_TERMS.map(t => ({ ...t })) : [];
  renderForbiddenTermsTable();
}

// v1.2.11: YouTube 字幕分頁
$('save-youtube').addEventListener('click', save);
// Debug 分頁
$('save-debug').addEventListener('click', save);
$('yt-reset-prompt').addEventListener('click', () => {
  // P1: 依當前 target 給對應 effective default(zh-TW 走原 DEFAULT_SUBTITLE,其他走 UNIVERSAL 注入後)
  const tl = _currentTargetLang;
  $('ytSystemPrompt').value = getEffectiveSubtitleSystemPrompt(tl, '');
  markDirty(); // 值已變更，標記為未儲存
  // v1.8.61:reset 後 textarea 已等於 effective default,但「你已客製化」hint 還殘留
  // hidden=false。重 calc target-mismatch hint 可見性,讓 hint 自動消失。
  updateAllPromptTargetHints();
});
// W7:文件翻譯設定已搬到 translate-doc/settings.html(獨立 page),不在 options 內
// v1.5.8: 自訂模型「重置為預設 Prompt」按鈕——把 textarea 重設為 Gemini 同款 DEFAULT_SYSTEM_PROMPT
// P1 (v1.8.59):依當前 target picker 給對應 effective default(zh-TW 走 DEFAULT,其他走 UNIVERSAL 注入後)
$('cp-reset-prompt')?.addEventListener('click', () => {
  const tl = _currentTargetLang;
  $('cp-systemPrompt').value = getEffectiveSystemPrompt(tl, '');
  markDirty();
  // v1.8.61:同 yt-reset-prompt,reset 後 hint 應自動消失
  updateAllPromptTargetHints();
});

// v1.5.8: Gemini 分頁「重設所有參數」按鈕 — 把本分頁所有欄位填回 DEFAULT_SETTINGS 對應值。
// 不直接寫 storage（要使用者按「儲存設定」才生效），避免誤觸毀掉自訂設定無法回復。
// 不影響其他分頁（術語表 / 禁用詞 / 自訂模型 / YouTube 字幕）；要全部清空仍走「一般設定 → 回復預設設定」。
$('gemini-reset-all')?.addEventListener('click', () => {
  if (!confirm(_t('options.gemini.resetAllConfirm'))) return;
  const D = DEFAULTS;
  // v1.6.15: 全域 #model dropdown 已移除，不再 reset 模型 UI；只 reset service tier。
  // settings.geminiConfig.model 由「儲存設定」按鈕從 storage 讀回沿用。
  $('serviceTier').value = D.geminiConfig.serviceTier;
  // LLM 參數
  $('temperature').value     = D.geminiConfig.temperature;
  $('topP').value            = D.geminiConfig.topP;
  $('topK').value            = D.geminiConfig.topK;
  $('maxOutputTokens').value = D.geminiConfig.maxOutputTokens;
  // P1: 依當前 target 給對應 effective default(zh-TW 走原 DEFAULT,其他走 UNIVERSAL 注入後)
  {
    const tl = _currentTargetLang;
    $('systemInstruction').value = getEffectiveSystemPrompt(tl, '');
  }
  // 計價
  // v1.6.16: 後備路徑單價 UI 已移除，reset 不再動 settings.pricing 欄位。
  // v1.6.14: per-model override 欄位 reset 為空（預設 modelPricingOverrides:{} 對應 UI 全空 = 走內建表）。
  for (const id of [
    'override-lite-input',  'override-lite-output',  'override-lite-discount',
    'override-flash-input', 'override-flash-output', 'override-flash-discount',
    'override-pro-input',   'override-pro-output',   'override-pro-discount',
  ]) {
    const el = $(id);
    if (el) el.value = '';
  }
  // 配額（先填 tier 觸發 RPM/TPM/RPD readonly 帶值，再清掉 override）
  $('tier').value = D.tier;
  applyTierToInputs(D.tier, D.geminiConfig.model);
  // v1.8.19: safetyMargin UI 已移除，reset 不再 touch
  $('maxRetries').value = D.maxRetries;
  // 效能
  $('maxConcurrentBatches').value = D.maxConcurrentBatches;
  $('maxUnitsPerBatch').value     = D.maxUnitsPerBatch;
  $('maxCharsPerBatch').value     = D.maxCharsPerBatch;
  $('maxTranslateUnits').value    = D.maxTranslateUnits;
  // v1.8.3: 只翻文章開頭重設
  $('partialModeEnabled').checked = D.partialMode.enabled;
  $('partialModeMaxUnits').value  = D.partialMode.maxUnits;
  markDirty();
  // v1.8.61:reset systemInstruction textarea 後 hint 應自動消失(同 yt/cp reset)
  updateAllPromptTargetHints();
  $('save-gemini-status').textContent = _t('options.gemini.resetAllDone');
  setTimeout(() => { $('save-gemini-status').textContent = ''; }, 4000);
});

// v1.4.13: preset engine 下拉切換時隱藏/顯示 model row
for (const slot of [1, 2, 3]) {
  $(`preset-engine-${slot}`).addEventListener('change', () => updatePresetModelVisibility(slot));
}

// preset 標籤輸入時即時刷新「工具列翻譯本頁按鈕」「自動翻譯網站」兩個下拉選單的顯示文字
for (const slot of [1, 2, 3]) {
  $(`preset-label-${slot}`)?.addEventListener('input', refreshSlotDropdownLabels);
}

// v1.5.8: 字幕引擎下拉切換時更新 section 可見性 + 重算 cost hint
$('ytEngine')?.addEventListener('change', () => {
  updateYtSectionVisibility();
  updateYtPromptCostHint();
});
// v1.5.8: 字幕模型 / 計價變動時重算 cost hint
// v1.6.15: 移除 'model'（全域 dropdown 已移除）。preset-model-2 切換不影響字幕成本估算
// 因為字幕用獨立的 ytSubtitle.model；字幕 prompt token 成本估算只看字幕端設定。
// v1.6.16: 移除 'inputPerMTok'（後備路徑單價 UI 已移除）
for (const id of ['ytModel', 'ytInputPerMTok', 'cp-model', 'cp-inputPerMTok']) {
  $(id)?.addEventListener('change', updateYtPromptCostHint);
  $(id)?.addEventListener('input', updateYtPromptCostHint);
}

// v1.8.41:Base URL 改成 http:// 時即時提示 Firefox HTTPS-Only Mode 警告
$('cp-baseUrl')?.addEventListener('input', refreshFirefoxHttpsWarn);

// v1.2.39: 切換 YouTube 模型時自動帶入參考計價（與主模型的邏輯相同）
$('ytModel').addEventListener('change', () => {
  const model = $('ytModel').value;
  if (!model) {
    // 空 = 與主模型相同，清空計價欄位讓 placeholder 顯示
    $('ytInputPerMTok').value  = '';
    $('ytOutputPerMTok').value = '';
    return;
  }
  const p = MODEL_PRICING[model];
  if (p) {
    $('ytInputPerMTok').value  = p.input;
    $('ytOutputPerMTok').value = p.output;
  }
});

// ─── v0.94: 儲存狀態提示條 ──────────────────────────────────
let saveBarHideTimer = null;
function showSaveBar(state, text) {
  const bar = $('save-bar');
  bar.textContent = text;
  bar.className = 'save-bar ' + state; // 'dirty' 或 'saved'
  bar.hidden = false;
  if (saveBarHideTimer) clearTimeout(saveBarHideTimer);
  if (state === 'saved') {
    saveBarHideTimer = setTimeout(() => { bar.hidden = true; }, 3000);
  }
}
function markDirty() {
  const bar = $('save-bar');
  // 若目前是「已儲存」狀態，不立即覆蓋（等它自己消失）
  if (bar.classList.contains('saved') && !bar.hidden) return;
  showSaveBar('dirty', _t('options.action.dirtyBar'));
}
// 監聽設定分頁與 Gemini 分頁內所有 input / select / textarea 的變更
document.getElementById('tab-settings').addEventListener('input', markDirty);
document.getElementById('tab-settings').addEventListener('change', markDirty);
document.getElementById('tab-gemini').addEventListener('input', markDirty);
document.getElementById('tab-gemini').addEventListener('change', markDirty);
document.getElementById('tab-glossary').addEventListener('input', markDirty);
document.getElementById('tab-glossary').addEventListener('change', markDirty);
// v1.5.6: 禁用詞清單分頁
document.getElementById('tab-forbidden').addEventListener('input', markDirty);
document.getElementById('tab-forbidden').addEventListener('change', markDirty);
// v1.5.7: 自訂 Provider 分頁
document.getElementById('tab-custom-provider').addEventListener('input', markDirty);
document.getElementById('tab-custom-provider').addEventListener('change', markDirty);
// v1.2.13: YouTube 字幕分頁也需要 dirty 偵測
document.getElementById('tab-youtube').addEventListener('input', markDirty);
document.getElementById('tab-youtube').addEventListener('change', markDirty);
// tab-log 的 debugLog checkbox 是真實設定，需要單獨監聽
// （tab-log 不在 tab-level delegation 內，因為其他 log 控制項是純 UI 不需要 dirty）
// 只有實際需要存的 checkbox 才個別掛 markDirty
$('debugLog').addEventListener('change', markDirty);
$('ytDebugToast').addEventListener('change', markDirty);
$('ytOnTheFly').addEventListener('change', markDirty);

// v1.8.41：幣值 radio change → currentCurrencyState 同步，並重新渲染用量分頁
// （用量分頁可能已渲染好，radio 切換後表格 / 累計 / chart 都要立即反映）
function rerenderUsageWithCurrency() {
  // 表格 + 累計卡片
  if (allUsageRecords.length) applyUsageSearch();
  // chart（若已渲染過）
  if (lastChartData) renderChart(lastChartData);
}

for (const r of document.querySelectorAll('input[name="displayCurrency"]')) {
  r.addEventListener('change', () => {
    currentCurrencyState.currency = getSelectedCurrency();
    rerenderUsageWithCurrency();
  });
}

// v1.8.41：重新抓取匯率按鈕（force fetch，跳過 freshness 檢查）
$('refresh-rate-btn')?.addEventListener('click', async () => {
  const btn = $('refresh-rate-btn');
  const el = document.getElementById('currency-rate-display');
  btn.disabled = true;
  btn.dataset.state = 'loading';
  btn.textContent = _t('options.currency.refreshing');
  try {
    const resp = await browser.runtime.sendMessage({ type: 'EXCHANGE_RATE_REFRESH' });
    if (resp?.ok) {
      currentCurrencyState = {
        currency: getSelectedCurrency(),
        rate: resp.rate,
        fetchedAt: resp.fetchedAt,
        source: resp.source,
      };
      el.textContent = formatRateLine(resp);
      // 已渲染的用量分頁也要重算金額
      rerenderUsageWithCurrency();
    } else {
      el.textContent = _t('options.currency.refreshFailed', {
        error: resp?.error || _t('common.errorUnknown'),
        rate: Number(resp?.rate || 31.6).toFixed(2),
      });
    }
  } catch (err) {
    el.textContent = _t('options.currency.refreshFailedShort', { error: err?.message || err });
  } finally {
    btn.disabled = false;
    btn.dataset.state = '';
    btn.textContent = _t('options.currency.refresh');
  }
});

// 顯示/隱藏 API Key 切換（v0.63）— 讓使用者能確認貼上去的 key 沒有貼錯
$('toggle-api-key').addEventListener('click', () => {
  const input = $('apiKey');
  const btn = $('toggle-api-key');
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = _t('options.action.hide');
    btn.setAttribute('aria-label', _t('options.apiKey.hideAria'));
  } else {
    input.type = 'password';
    btn.textContent = _t('options.action.show');
    btn.setAttribute('aria-label', _t('options.apiKey.showAria'));
  }
});

// v1.5.7: 通用「測試 API」UI helper — 兩個測試按鈕共用 loading / 結果顯示流程
async function runApiTest({ btn, resultEl, sendMessage }) {
  btn.disabled = true;
  btn.dataset.state = 'loading';
  btn.textContent = _t('options.action.testing');
  resultEl.hidden = false;
  resultEl.dataset.state = 'loading';
  resultEl.textContent = _t('options.action.testingConnect');
  try {
    const resp = await sendMessage();
    if (resp?.ok) {
      resultEl.dataset.state = 'ok';
      resultEl.textContent = '✓ ' + (resp.message || _t('options.action.connectOk'));
    } else {
      resultEl.dataset.state = 'fail';
      resultEl.textContent = '✗ ' + (resp?.message || resp?.error || _t('common.errorUnknown'));
    }
  } catch (err) {
    resultEl.dataset.state = 'fail';
    resultEl.textContent = '✗ ' + (err?.message || String(err));
  } finally {
    btn.disabled = false;
    btn.dataset.state = '';
    btn.textContent = _t('options.action.test');
  }
}

// v1.5.7: Gemini API Key 測試
$('test-api-key').addEventListener('click', async () => {
  await runApiTest({
    btn: $('test-api-key'),
    resultEl: $('test-api-key-result'),
    sendMessage: () => browser.runtime.sendMessage({
      type: 'TEST_GEMINI_KEY',
      payload: {
        apiKey: $('apiKey').value,
        model: getSelectedModel(),
      },
    }),
  });
});

// Tier 變更 → 自動更新 RPM/TPM/RPD 顯示
// v1.6.15: 全域 model dropdown 已移除，Service Tier 已搬到 LLM 參數微調 section。
// applyModelPricing(model) 在這裡也失去意義（model 不再從 UI 變，計價走 v1.6.14 per-model
// override 表；Service Tier 影響的是內建表 multiplier，但「後備路徑單價」不再隨 tier 變）。
$('tier').addEventListener('change', () => {
  applyTierToInputs($('tier').value, getSelectedModel());
});
// v1.8.19: safetyMargin slider UI 已移除，程式碼內部維持 storage default 0.1
$('toastOpacity').addEventListener('input', () => {
  _renderToastOpacityLabel($('toastOpacity').value);
});
$('toastPosition').addEventListener('change', markDirty);

// v1.5.0: 雙語視覺標記 radio 切換 → 即時更新 demo wrapper
for (const r of document.querySelectorAll('input[name="markStyle"]')) {
  r.addEventListener('change', () => updateDualDemoMark(getSelectedMarkStyle()));
}

// v1.8.52: 強調色 swatch 點擊 / 自訂 hex 輸入 / color picker 切色
for (const btn of document.querySelectorAll('.dual-accent-swatch')) {
  btn.addEventListener('click', () => setDualAccent(btn.dataset.token));
}
{
  const picker = document.getElementById('dualAccentColorPicker');
  const hexInput = document.getElementById('dualAccentHexInput');
  if (picker) {
    // input 事件:拖曳 native picker 即時預覽（不等 change 關閉視窗）
    picker.addEventListener('input', () => setDualAccent(picker.value));
  }
  if (hexInput) {
    // 一邊輸入一邊驗,六碼通過才套色;不通過顯示紅框但保留輸入內容
    hexInput.addEventListener('input', () => {
      const v = hexInput.value.trim();
      if (DUAL_ACCENT_HEX_RE.test(v)) {
        setDualAccent(v);
      } else if (v === '') {
        setDualAccent('auto');
      } else {
        hexInput.setAttribute('aria-invalid', 'true');
      }
    });
    // blur 時若仍無效,還原為當前 currentDualAccent 對應 hex（不留下半成品）
    hexInput.addEventListener('blur', () => refreshDualAccentUI());
  }
}

$('reset-defaults').addEventListener('click', async () => {
  if (!confirm(_t('options.reset.confirm'))) return;
  // v0.62 起：apiKey 在 browser.storage.local，不在 sync 裡，
  // 所以直接 clear sync 即可；apiKey 自然不受影響。
  await browser.storage.sync.clear();
  await load();
  $('save-status').textContent = _t('options.reset.done');
  $('save-status').style.color = '#34c759';
  setTimeout(() => {
    $('save-status').textContent = '';
    $('save-status').style.color = '';
  }, 3000);
});

// v0.88: 舊的 view-logs 按鈕已移除，Log 改為獨立分頁

$('export-settings').addEventListener('click', async () => {
  const all = await browser.storage.sync.get(null);
  // apiKey 不納入匯出（apiKey 本來就存在 local 不在 sync，defensive 再 delete 一次）
  delete all.apiKey;
  const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  // 檔名含時間到秒，避免同一天多次匯出檔名重複
  const ts = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  a.href = url;
  a.download = `shinkansen-settings-${ts}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ─── 匯入驗證 ────────────────────────────────────────
// 對照 DEFAULTS 結構，只保留已知欄位，並檢查型別與範圍。
// 不認識的 key 直接丟掉，不合法的值回退為預設值。
function sanitizeImport(raw) {
  const clean = {};
  const warnings = [];

  // 頂層純量欄位：型別 + 範圍
  const topRules = {
    autoTranslate:       { type: 'boolean' },
    debugLog:            { type: 'boolean' },
    tier:                { type: 'string', oneOf: ['free', 'tier1', 'tier2', 'custom'] },
    safetyMargin:        { type: 'number', min: 0, max: 0.5 },
    maxRetries:          { type: 'number', min: 0, max: 10, int: true },
    maxConcurrentBatches:{ type: 'number', min: 1, max: 50, int: true },
    maxUnitsPerBatch:    { type: 'number', min: 1, max: 100, int: true },
    maxCharsPerBatch:    { type: 'number', min: 500, max: 20000, int: true },
    maxTranslateUnits:   { type: 'number', min: 0, max: 10000, int: true },
    rpmOverride:         { type: 'number', min: 1, nullable: true },
    tpmOverride:         { type: 'number', min: 1, nullable: true },
    rpdOverride:         { type: 'number', min: 1, nullable: true },
    toastAutoHide:       { type: 'boolean' },
    popupButtonSlot:     { type: 'number', min: 1, max: 3, int: true }, // v1.6.6
    autoTranslateSlot:   { type: 'number', min: 1, max: 3, int: true }, // v1.6.13
    modelPricingOverrides: { type: 'object' }, // v1.6.14
    showProgressToast:   { type: 'boolean' }, // v1.6.8
    // issue #48 fix：之前漏列導致匯入時這些 key 默默丟掉
    targetLanguage:      { type: 'string', oneOf: TARGET_LANGUAGES },
    uiLanguage:          { type: 'string', oneOf: UI_LANGUAGES },
    displayMode:         { type: 'string', oneOf: ['single', 'dual'] },
    displayCurrency:     { type: 'string', oneOf: ['USD', 'TWD'] },
    translationMarkStyle:{ type: 'string', oneOf: ['tint', 'bar', 'dashed', 'none'] },
    // dualAccentColor：'auto' / color token / #RRGGBB hex 大小寫不拘。
    // 非法值 content script 端會 fallback 回 'auto'，此處只做型別檢查不嚴格 oneOf。
    dualAccentColor:     { type: 'string' },
    // UI range 10-100% → 儲存 0.1-1.0
    toastOpacity:        { type: 'number', min: 0.1, max: 1 },
    toastPosition:       { type: 'string', oneOf: ['bottom-right', 'bottom-left', 'top-right', 'top-left'] },
    disableUpdateNotice: { type: 'boolean' },
  };

  for (const [key, rule] of Object.entries(topRules)) {
    if (!(key in raw)) continue;
    const v = raw[key];
    if (rule.nullable && (v === null || v === undefined)) { clean[key] = null; continue; }
    if (typeof v !== rule.type) { warnings.push(_t('options.import.warningSkipType', { key })); continue; }
    if (rule.type === 'number') {
      if (!Number.isFinite(v)) { warnings.push(_t('options.import.warningSkipNum', { key })); continue; }
      if (rule.min !== undefined && v < rule.min) { warnings.push(_t('options.import.warningSkipMin', { key, value: v, min: rule.min })); continue; }
      if (rule.max !== undefined && v > rule.max) { warnings.push(_t('options.import.warningSkipMax', { key, value: v, max: rule.max })); continue; }
      if (rule.int && !Number.isInteger(v)) { warnings.push(_t('options.import.warningSkipInt', { key })); continue; }
    }
    if (rule.oneOf && !rule.oneOf.includes(v)) { warnings.push(_t('options.import.warningSkipOneOf', { key, value: v })); continue; }
    clean[key] = v;
  }

  // geminiConfig 子物件
  if (raw.geminiConfig && typeof raw.geminiConfig === 'object') {
    const gc = raw.geminiConfig;
    const gcClean = {};
    const gcRules = {
      model:            { type: 'string' },
      serviceTier:      { type: 'string', oneOf: ['DEFAULT', 'FLEX', 'STANDARD', 'PRIORITY'] },
      temperature:      { type: 'number', min: 0, max: 2 },
      topP:             { type: 'number', min: 0, max: 1 },
      topK:             { type: 'number', min: 1, max: 100, int: true },
      maxOutputTokens:  { type: 'number', min: 256, max: 65535, int: true },
      systemInstruction:{ type: 'string' },
    };
    for (const [key, rule] of Object.entries(gcRules)) {
      if (!(key in gc)) continue;
      const v = gc[key];
      const fullKey = `geminiConfig.${key}`;
      if (typeof v !== rule.type) { warnings.push(_t('options.import.warningSkipType', { key: fullKey })); continue; }
      if (rule.type === 'number') {
        if (!Number.isFinite(v)) { warnings.push(_t('options.import.warningSkipNum', { key: fullKey })); continue; }
        if (rule.min !== undefined && v < rule.min) { warnings.push(_t('options.import.warningSkipMin', { key: fullKey, value: v, min: rule.min })); continue; }
        if (rule.max !== undefined && v > rule.max) { warnings.push(_t('options.import.warningSkipMax', { key: fullKey, value: v, max: rule.max })); continue; }
        if (rule.int && !Number.isInteger(v)) { warnings.push(_t('options.import.warningSkipInt', { key: fullKey })); continue; }
      }
      if (rule.oneOf && !rule.oneOf.includes(v)) { warnings.push(_t('options.import.warningSkipOneOf', { key: fullKey, value: v })); continue; }
      gcClean[key] = v;
    }
    if (Object.keys(gcClean).length > 0) clean.geminiConfig = gcClean;
  }

  // W7:translateDoc 子物件
  if (raw.translateDoc && typeof raw.translateDoc === 'object') {
    const td = raw.translateDoc;
    const tdClean = {};
    if (typeof td.systemPrompt === 'string') tdClean.systemPrompt = td.systemPrompt;
    else if ('systemPrompt' in td) warnings.push(_t('options.import.warningTransDocPrompt'));
    if (typeof td.applyGlossary === 'boolean') tdClean.applyGlossary = td.applyGlossary;
    else if ('applyGlossary' in td) warnings.push(_t('options.import.warningTransDocApply'));
    if (typeof td.temperature === 'number' && Number.isFinite(td.temperature)
        && td.temperature >= 0 && td.temperature <= 2) {
      tdClean.temperature = td.temperature;
    } else if ('temperature' in td) warnings.push(_t('options.import.warningTransDocTemp'));
    if (Object.keys(tdClean).length > 0) clean.translateDoc = tdClean;
  }

  // pricing 子物件
  if (raw.pricing && typeof raw.pricing === 'object') {
    const pr = raw.pricing;
    const prClean = {};
    for (const key of ['inputPerMTok', 'outputPerMTok']) {
      if (!(key in pr)) continue;
      const v = pr[key];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        warnings.push(_t('options.import.warningSkipNeg', { key })); continue;
      }
      prClean[key] = v;
    }
    // v1.9.2: cachedDiscount 0-1 範圍
    if ('cachedDiscount' in pr) {
      const v = pr.cachedDiscount;
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) {
        prClean.cachedDiscount = v;
      } else {
        warnings.push(_t('options.import.warningSkipNeg', { key: 'cachedDiscount' }));
      }
    }
    if (Object.keys(prClean).length > 0) clean.pricing = prClean;
  }

  // v0.69: glossary 子物件
  if (raw.glossary && typeof raw.glossary === 'object') {
    const gl = raw.glossary;
    const glClean = {};
    if (typeof gl.enabled === 'boolean') glClean.enabled = gl.enabled;
    if (typeof gl.prompt === 'string') glClean.prompt = gl.prompt;
    if (typeof gl.temperature === 'number' && gl.temperature >= 0 && gl.temperature <= 2) glClean.temperature = gl.temperature;
    if (typeof gl.timeoutMs === 'number' && gl.timeoutMs >= 3000 && gl.timeoutMs <= 60000) glClean.timeoutMs = gl.timeoutMs;
    if (typeof gl.skipThreshold === 'number' && Number.isInteger(gl.skipThreshold) && gl.skipThreshold >= 0) glClean.skipThreshold = gl.skipThreshold;
    if (typeof gl.blockingThreshold === 'number' && Number.isInteger(gl.blockingThreshold) && gl.blockingThreshold >= 0) glClean.blockingThreshold = gl.blockingThreshold;
    if (typeof gl.maxTerms === 'number' && Number.isInteger(gl.maxTerms) && gl.maxTerms >= 1 && gl.maxTerms <= 500) glClean.maxTerms = gl.maxTerms;
    if (Object.keys(glClean).length > 0) clean.glossary = glClean;
  }

  // v1.5.6: 中國用語黑名單。整個 array 替換（不做 per-entry merge），
  // 但會逐筆過濾掉 forbidden 欄位非字串的髒資料。
  if (Array.isArray(raw.forbiddenTerms)) {
    const cleanTerms = [];
    for (const t of raw.forbiddenTerms) {
      if (!t || typeof t !== 'object') continue;
      const forbidden = typeof t.forbidden === 'string' ? t.forbidden.trim() : '';
      const replacement = typeof t.replacement === 'string' ? t.replacement.trim() : '';
      const note = typeof t.note === 'string' ? t.note : '';
      if (!forbidden) continue; // 沒有禁用詞欄位的不收
      cleanTerms.push({ forbidden, replacement, note });
    }
    clean.forbiddenTerms = cleanTerms;
    if (cleanTerms.length !== raw.forbiddenTerms.length) {
      warnings.push(_t('options.import.warningForbiddenSkip', { count: raw.forbiddenTerms.length - cleanTerms.length }));
    }
  }

  // v1.5.7: customProvider 子物件（apiKey 不在匯入範圍——同 Gemini apiKey 設計）
  if (raw.customProvider && typeof raw.customProvider === 'object') {
    const cp = raw.customProvider;
    const cpClean = {};
    if (typeof cp.baseUrl === 'string') cpClean.baseUrl = cp.baseUrl.trim();
    if (typeof cp.model === 'string') cpClean.model = cp.model.trim();
    if (typeof cp.systemPrompt === 'string') cpClean.systemPrompt = cp.systemPrompt;
    if (typeof cp.temperature === 'number' && cp.temperature >= 0 && cp.temperature <= 2) {
      cpClean.temperature = cp.temperature;
    }
    if (typeof cp.fetchTimeoutSec === 'number' && cp.fetchTimeoutSec >= 5 && cp.fetchTimeoutSec <= 600) cpClean.fetchTimeoutSec = cp.fetchTimeoutSec;
    if (typeof cp.inputPerMTok === 'number' && cp.inputPerMTok >= 0) cpClean.inputPerMTok = cp.inputPerMTok;
    if (typeof cp.outputPerMTok === 'number' && cp.outputPerMTok >= 0) cpClean.outputPerMTok = cp.outputPerMTok;
    // v1.9.2: cachedDiscount 0-1,null 表示走 baseUrl 自動推導
    if (cp.cachedDiscount === null) cpClean.cachedDiscount = null;
    else if (typeof cp.cachedDiscount === 'number'
        && Number.isFinite(cp.cachedDiscount)
        && cp.cachedDiscount >= 0 && cp.cachedDiscount <= 1) {
      cpClean.cachedDiscount = cp.cachedDiscount;
    }
    if (Object.prototype.hasOwnProperty.call(cp, 'apiKey')) {
      warnings.push(_t('options.import.warningCpApiKey'));
    }
    if (Object.keys(cpClean).length > 0) clean.customProvider = cpClean;
  }

  // domainRules 子物件
  if (raw.domainRules && typeof raw.domainRules === 'object') {
    const dr = raw.domainRules;
    const drClean = {};
    for (const key of ['whitelist']) {
      if (!(key in dr)) continue;
      if (Array.isArray(dr[key]) && dr[key].every(x => typeof x === 'string')) {
        drClean[key] = dr[key];
      } else {
        warnings.push(_t('options.import.warningDomainRules', { key }));
      }
    }
    if (Object.keys(drClean).length > 0) clean.domainRules = drClean;
  }

  // fixedGlossary 子物件：{ global: Array<{source,target}>, byDomain: { [domain]: Array<{source,target}> } }
  // 結構性過濾——只保留 source/target 字串欄位，空 source+target 的 entry 丟掉，空陣列的 domain 丟掉
  if (raw.fixedGlossary && typeof raw.fixedGlossary === 'object') {
    const fg = raw.fixedGlossary;
    const fgClean = {};
    const sanitizeEntries = (arr) => {
      if (!Array.isArray(arr)) return [];
      const out = [];
      for (const e of arr) {
        if (!e || typeof e !== 'object') continue;
        const source = typeof e.source === 'string' ? e.source : '';
        const target = typeof e.target === 'string' ? e.target : '';
        if (!source && !target) continue;
        out.push({ source, target });
      }
      return out;
    };
    if (Array.isArray(fg.global)) {
      fgClean.global = sanitizeEntries(fg.global);
    }
    if (fg.byDomain && typeof fg.byDomain === 'object' && !Array.isArray(fg.byDomain)) {
      const byDomainClean = {};
      for (const [domain, entries] of Object.entries(fg.byDomain)) {
        if (typeof domain !== 'string' || !domain) continue;
        const cleanEntries = sanitizeEntries(entries);
        if (cleanEntries.length > 0) byDomainClean[domain] = cleanEntries;
      }
      fgClean.byDomain = byDomainClean;
    }
    if (Object.keys(fgClean).length > 0) clean.fixedGlossary = fgClean;
  }

  // issue #48 fix：translatePresets 陣列（三組翻譯快速鍵預設）
  // 結構：[{ slot: 1|2|3, engine: 'gemini'|'google'|'openai-compat', model: string|null, label: string }]
  // 整個陣列替換（不做 per-slot merge）——跟 getSettings 行為一致（非空 saved 完全覆蓋預設）。
  // 來源檔可能少於 3 slot / slot 順序亂 / 缺欄位 → 過濾掉無效，合法 entry 保留。
  if (Array.isArray(raw.translatePresets)) {
    const cleanPresets = [];
    for (const p of raw.translatePresets) {
      if (!p || typeof p !== 'object') continue;
      if (![1, 2, 3].includes(p.slot)) continue;
      const engine = ['gemini', 'google', 'openai-compat'].includes(p.engine) ? p.engine : 'gemini';
      // model 對 gemini 是字串（空 = inherit 全域），google/openai-compat 預期 null
      let model = null;
      if (typeof p.model === 'string') model = p.model;
      else if (p.model === null) model = null;
      const label = typeof p.label === 'string' ? p.label : '';
      cleanPresets.push({ slot: p.slot, engine, model, label });
    }
    if (cleanPresets.length > 0) clean.translatePresets = cleanPresets;
  }

  // issue #48 fix：ytSubtitle 子物件（YouTube 字幕翻譯設定，14 個欄位）
  if (raw.ytSubtitle && typeof raw.ytSubtitle === 'object') {
    const yt = raw.ytSubtitle;
    const ytClean = {};
    const ytRules = {
      autoTranslate:       { type: 'boolean' },
      temperature:         { type: 'number', min: 0, max: 2 },
      systemPrompt:        { type: 'string' },
      windowSizeS:         { type: 'number', min: 10, max: 120 },
      lookaheadS:          { type: 'number', min: 3, max: 30 },
      debugToast:          { type: 'boolean' },
      onTheFly:            { type: 'boolean' },
      engine:              { type: 'string', oneOf: ['gemini', 'google', 'openai-compat'] },
      model:               { type: 'string' }, // 空字串 = 與主模型相同
      applyFixedGlossary:  { type: 'boolean' },
      applyForbiddenTerms: { type: 'boolean' },
      asrMode:             { type: 'string', oneOf: ['heuristic', 'progressive', 'llm'] },
      bilingualMode:       { type: 'boolean' },
      preferOriginalTrack: { type: 'boolean' },
    };
    for (const [key, rule] of Object.entries(ytRules)) {
      if (!(key in yt)) continue;
      const v = yt[key];
      const fullKey = `ytSubtitle.${key}`;
      if (typeof v !== rule.type) { warnings.push(_t('options.import.warningSkipType', { key: fullKey })); continue; }
      if (rule.type === 'number' && !Number.isFinite(v)) { warnings.push(_t('options.import.warningSkipNum', { key: fullKey })); continue; }
      if (rule.min !== undefined && v < rule.min) { warnings.push(_t('options.import.warningSkipMin', { key: fullKey, value: v, min: rule.min })); continue; }
      if (rule.max !== undefined && v > rule.max) { warnings.push(_t('options.import.warningSkipMax', { key: fullKey, value: v, max: rule.max })); continue; }
      if (rule.oneOf && !rule.oneOf.includes(v)) { warnings.push(_t('options.import.warningSkipOneOf', { key: fullKey, value: v })); continue; }
      ytClean[key] = v;
    }
    // pricing 特殊處理：null（與主模型相同）或 { inputPerMTok, outputPerMTok }（欄位可為 null）
    if ('pricing' in yt) {
      if (yt.pricing === null) {
        ytClean.pricing = null;
      } else if (yt.pricing && typeof yt.pricing === 'object') {
        const pr = yt.pricing;
        const prClean = {};
        for (const k of ['inputPerMTok', 'outputPerMTok']) {
          if (!(k in pr)) continue;
          const v = pr[k];
          if (v === null) { prClean[k] = null; continue; }
          if (typeof v === 'number' && Number.isFinite(v) && v >= 0) prClean[k] = v;
        }
        if (Object.keys(prClean).length > 0) ytClean.pricing = prClean;
      }
    }
    if (Object.keys(ytClean).length > 0) clean.ytSubtitle = ytClean;
  }

  // v1.8.3: partialMode 子物件
  if (raw.partialMode && typeof raw.partialMode === 'object') {
    const pm = raw.partialMode;
    const pmClean = {};
    if (typeof pm.enabled === 'boolean') pmClean.enabled = pm.enabled;
    if (typeof pm.maxUnits === 'number' && Number.isInteger(pm.maxUnits) && pm.maxUnits >= 5 && pm.maxUnits <= 50) {
      pmClean.maxUnits = pm.maxUnits;
    }
    if (Object.keys(pmClean).length > 0) clean.partialMode = pmClean;
  }

  return { clean, warnings };
}

$('import-file').addEventListener('click', () => $('import-input').click());
$('import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    const data = JSON.parse(text);
    // v0.62 起：匯入時若備份檔含 apiKey（例如舊版本匯出的檔），一律忽略
    if (Object.prototype.hasOwnProperty.call(data, 'apiKey')) {
      delete data.apiKey;
    }
    const { clean, warnings } = sanitizeImport(data);
    if (Object.keys(clean).length === 0) {
      alert(_t('options.io.importNoFields'));
      return;
    }
    await browser.storage.sync.set(clean);
    await load();
    const msg = warnings.length > 0
      ? _t('options.io.importPartial', { warnings: warnings.join('\n') })
      : _t('options.io.importOk');
    alert(msg + _t('options.io.importFooter'));
  } catch (err) {
    alert(_t('options.io.importFailed', { error: err.message }));
  }
});

// v1.3.16 / v1.5.4: 平台偵測決定快捷鍵設定連結。
// 用 runtime.getURL('') 的 prefix 精確區分 Chrome / Firefox / Safari，
// 比 globalThis.chrome 偵測更可靠（Firefox 全域 chrome 不存在但 browser 在）。
//   chrome-extension://    → Chrome / Edge → chrome://extensions/shortcuts
//   moz-extension://       → Firefox       → about:addons
//   safari-web-extension:// → Safari       → CSS 隱藏連結(Safari 不允許 extension UI 改快速鍵)
//
// v1.9.10(macOS Safari 真機驗證後修):改用「body class + event delegation」
// 取代「per-element addEventListener + inline style」。原 pattern 有兩個 bug:
//   1. `data-i18n-html` 的 applyI18n 用 innerHTML 重設 <p>,新建出來的 anchor 沒 listener 也沒 inline style
//   2. Safari 看到完整 chrome:// 廢 link;Chrome / Firefox 點 link 也沒反應(沒人發現)
// body class 不會被 innerHTML 影響;event delegation 綁 document,anchor 重建後仍有效。
const _extUrl = browser.runtime.getURL('');
let _shortcutsPlatform = 'safari'; // fallback:無法 deep-link 到內建設定 URL 的環境
if (_extUrl.startsWith('chrome-extension://')) _shortcutsPlatform = 'chrome';
else if (_extUrl.startsWith('moz-extension://')) _shortcutsPlatform = 'firefox';
document.body.classList.add(`runtime-${_shortcutsPlatform}`);

// Event delegation:綁 document,anchor 被 data-i18n-html replace 重建後仍有效
document.addEventListener('click', (e) => {
  const link = e.target.closest('.open-shortcuts-link');
  if (!link) return;
  e.preventDefault();
  if (_shortcutsPlatform === 'chrome') {
    browser.tabs.create({ url: 'chrome://extensions/shortcuts' });
  } else if (_shortcutsPlatform === 'firefox') {
    browser.tabs.create({ url: 'about:addons' });
  }
  // safari 分支:CSS body.runtime-safari 已隱藏 link,理論上點不到
});

// ═══════════════════════════════════════════════════════════
// v1.0.29: 固定術語表 CRUD
// ═══════════════════════════════════════════════════════════

// 記憶體中的固定術語表資料（load 時從 storage 讀入，save 時寫回）
let fixedGlossary = { global: [], byDomain: {} };
let currentDomain = ''; // 目前選中的網域

function renderGlossaryTable(tbody, entries) {
  // AMO source review: 所有使用者可變欄位（e.source / e.target / e.note）都經 escapeAttr / escapeHtml,
  // 數字 i 是 array index(integer)，無 user input 流入未 escape 的 innerHTML 位置。
  const phSrc = escapeAttr(_t('options.glossary.fixed.placeholderSource'));
  const phTgt = escapeAttr(_t('options.glossary.fixed.placeholderTarget'));
  const delTitle = escapeAttr(_t('options.glossary.fixed.deleteRow'));
  tbody.innerHTML = entries.map((e, i) =>
    `<tr data-idx="${i}">` +
    `<td><input type="text" class="fg-source" value="${escapeAttr(e.source)}" placeholder="${phSrc}"></td>` +
    `<td><input type="text" class="fg-target" value="${escapeAttr(e.target)}" placeholder="${phTgt}"></td>` +
    `<td class="glossary-col-action"><button class="glossary-delete-row" data-idx="${i}" title="${delTitle}">×</button></td>` +
    `</tr>`
  ).join('');
}

function escapeAttr(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function readGlossaryTableEntries(tbody) {
  const rows = tbody.querySelectorAll('tr');
  const entries = [];
  for (const row of rows) {
    const source = (row.querySelector('.fg-source')?.value || '').trim();
    const target = (row.querySelector('.fg-target')?.value || '').trim();
    if (source || target) entries.push({ source, target });
  }
  return entries;
}

// 全域術語表
function renderGlobalTable() {
  renderGlossaryTable($('fixed-global-tbody'), fixedGlossary.global);
}

$('fixed-global-add').addEventListener('click', () => {
  fixedGlossary.global.push({ source: '', target: '' });
  renderGlobalTable();
  // 自動 focus 新增列的 source 欄
  const rows = $('fixed-global-tbody').querySelectorAll('tr');
  if (rows.length) rows[rows.length - 1].querySelector('.fg-source')?.focus();
  markDirty();
});

$('fixed-global-tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('.glossary-delete-row');
  if (!btn) return;
  const idx = Number(btn.dataset.idx);
  // 先把目前 UI 的值同步回記憶體
  fixedGlossary.global = readGlossaryTableEntries($('fixed-global-tbody'));
  fixedGlossary.global.splice(idx, 1);
  renderGlobalTable();
  markDirty();
});

// 失焦時同步 UI → 記憶體
$('fixed-global-tbody').addEventListener('focusout', () => {
  fixedGlossary.global = readGlossaryTableEntries($('fixed-global-tbody'));
});

// 網域術語表
function updateDomainSelect() {
  const sel = $('fixed-domain-select');
  const domains = Object.keys(fixedGlossary.byDomain).sort();
  // AMO source review: domain 字串（使用者輸入）經 escapeAttr / escapeHtml 雙重處理，
  // 第一段是 dev hardcoded 字串。
  // v1.8.61:placeholder option 加 data-i18n,讓 applyI18n 在 init / UI 語系切換時
  // 能持續更新文字(不加的話 init 時用 picker.value=auto 推導的語言,使用者切 UI
  // 語言後 placeholder 不會跟著切)。
  sel.innerHTML = `<option value="" data-i18n="options.glossary.fixed.domainSelectPlaceholder">${escapeHtml(_t('options.glossary.fixed.domainSelectPlaceholder'))}</option>` +
    domains.map(d => `<option value="${escapeAttr(d)}">${escapeHtml(d)}</option>`).join('');
  if (currentDomain && fixedGlossary.byDomain[currentDomain]) {
    sel.value = currentDomain;
  }
}

function showDomainPanel(domain) {
  currentDomain = domain;
  if (!domain || !fixedGlossary.byDomain[domain]) {
    $('fixed-domain-panel').hidden = true;
    return;
  }
  $('fixed-domain-panel').hidden = false;
  $('fixed-domain-label').textContent = domain;
  renderGlossaryTable($('fixed-domain-tbody'), fixedGlossary.byDomain[domain]);
}

$('fixed-domain-select').addEventListener('change', () => {
  // 切換前先同步當前網域的 UI 值
  if (currentDomain && fixedGlossary.byDomain[currentDomain]) {
    fixedGlossary.byDomain[currentDomain] = readGlossaryTableEntries($('fixed-domain-tbody'));
  }
  showDomainPanel($('fixed-domain-select').value);
});

$('fixed-domain-add-btn').addEventListener('click', () => {
  const input = $('fixed-domain-input');
  const domain = (input.value || '').trim().toLowerCase();
  if (!domain) return;
  if (!fixedGlossary.byDomain[domain]) {
    fixedGlossary.byDomain[domain] = [];
  }
  input.value = '';
  updateDomainSelect();
  $('fixed-domain-select').value = domain;
  showDomainPanel(domain);
  markDirty();
});

$('fixed-domain-delete').addEventListener('click', () => {
  if (!currentDomain) return;
  if (!confirm(_t('options.glossary.fixed.domainDeleteConfirm', { domain: currentDomain }))) return;
  delete fixedGlossary.byDomain[currentDomain];
  currentDomain = '';
  updateDomainSelect();
  showDomainPanel('');
  markDirty();
});

$('fixed-domain-add-row').addEventListener('click', () => {
  if (!currentDomain) return;
  // 先同步 UI → 記憶體
  fixedGlossary.byDomain[currentDomain] = readGlossaryTableEntries($('fixed-domain-tbody'));
  fixedGlossary.byDomain[currentDomain].push({ source: '', target: '' });
  renderGlossaryTable($('fixed-domain-tbody'), fixedGlossary.byDomain[currentDomain]);
  const rows = $('fixed-domain-tbody').querySelectorAll('tr');
  if (rows.length) rows[rows.length - 1].querySelector('.fg-source')?.focus();
  markDirty();
});

$('fixed-domain-tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('.glossary-delete-row');
  if (!btn || !currentDomain) return;
  const idx = Number(btn.dataset.idx);
  fixedGlossary.byDomain[currentDomain] = readGlossaryTableEntries($('fixed-domain-tbody'));
  fixedGlossary.byDomain[currentDomain].splice(idx, 1);
  renderGlossaryTable($('fixed-domain-tbody'), fixedGlossary.byDomain[currentDomain]);
  markDirty();
});

$('fixed-domain-tbody').addEventListener('focusout', () => {
  if (currentDomain && fixedGlossary.byDomain[currentDomain]) {
    fixedGlossary.byDomain[currentDomain] = readGlossaryTableEntries($('fixed-domain-tbody'));
  }
});

// ═══════════════════════════════════════════════════════════
// v1.5.6: 中國用語黑名單 CRUD
// ═══════════════════════════════════════════════════════════

let forbiddenTerms = []; // 記憶體中的清單；load 時從 storage 讀入，save 時寫回

function renderForbiddenTermsTable() {
  const tbody = $('forbidden-terms-tbody');
  // v1.5.8: 備註 input 加 title attribute（hover 顯示原生 tooltip 看完整內容），
  // 編輯時靠 CSS focus 規則浮起放寬看完整文字。
  // AMO source review: 所有使用者欄位經 escapeAttr / escapeHtml，無未 escape user input。
  const phF = escapeAttr(_t('options.forbidden.placeholderForbidden'));
  const phR = escapeAttr(_t('options.forbidden.placeholderReplacement'));
  const phN = escapeAttr(_t('options.forbidden.placeholderNote'));
  const delTitle = escapeAttr(_t('options.glossary.fixed.deleteRow'));
  tbody.innerHTML = forbiddenTerms.map((t, i) => {
    const noteVal = escapeAttr(t.note || '');
    return `<tr data-idx="${i}">` +
      `<td><input type="text" class="ft-forbidden" value="${escapeAttr(t.forbidden)}" placeholder="${phF}"></td>` +
      `<td><input type="text" class="ft-replacement" value="${escapeAttr(t.replacement)}" placeholder="${phR}"></td>` +
      `<td class="ft-note-cell"><input type="text" class="ft-note" value="${noteVal}" title="${noteVal}" placeholder="${phN}"></td>` +
      `<td class="glossary-col-action"><button class="glossary-delete-row" data-idx="${i}" title="${delTitle}">×</button></td>` +
      `</tr>`;
  }).join('');
}

function readForbiddenTableEntries() {
  const rows = $('forbidden-terms-tbody').querySelectorAll('tr');
  const entries = [];
  for (const row of rows) {
    const forbidden = (row.querySelector('.ft-forbidden')?.value || '').trim();
    const replacement = (row.querySelector('.ft-replacement')?.value || '').trim();
    const note = (row.querySelector('.ft-note')?.value || '').trim();
    entries.push({ forbidden, replacement, note });
  }
  return entries;
}

$('forbidden-terms-add').addEventListener('click', () => {
  forbiddenTerms = readForbiddenTableEntries();
  forbiddenTerms.push({ forbidden: '', replacement: '', note: '' });
  renderForbiddenTermsTable();
  // focus 新增列的禁用詞欄
  const rows = $('forbidden-terms-tbody').querySelectorAll('tr');
  if (rows.length) rows[rows.length - 1].querySelector('.ft-forbidden')?.focus();
  markDirty();
});

$('forbidden-terms-reset').addEventListener('click', () => {
  if (!confirm(_t('options.forbidden.resetConfirm'))) return;
  // deep copy 預設清單避免 user 編輯後改到 module-level 常數
  forbiddenTerms = DEFAULT_FORBIDDEN_TERMS.map(t => ({ ...t }));
  renderForbiddenTermsTable();
  markDirty();
});

$('forbidden-terms-tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('.glossary-delete-row');
  if (!btn) return;
  const idx = Number(btn.dataset.idx);
  forbiddenTerms = readForbiddenTableEntries();
  forbiddenTerms.splice(idx, 1);
  renderForbiddenTermsTable();
  markDirty();
});

$('forbidden-terms-tbody').addEventListener('focusout', () => {
  forbiddenTerms = readForbiddenTableEntries();
});

// v1.5.8: 備註 input 編輯時隨打隨同步 title attribute，hover tooltip 跟著文字更新
$('forbidden-terms-tbody').addEventListener('input', (e) => {
  const t = e.target;
  if (t && t.classList.contains('ft-note')) t.title = t.value;
});

// ═══════════════════════════════════════════════════════════
// v0.86: Tab 切換 + 用量紀錄頁面
// ═══════════════════════════════════════════════════════════

// ─── Tab 切換 ────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const panel = $('tab-' + btn.dataset.tab);
    if (panel) panel.classList.add('active');
    // 切到用量頁時載入資料
    if (btn.dataset.tab === 'usage') {
      // v1.8.40: 自動把「到」時間 bump 到當下，確保涵蓋切 tab 之前剛翻譯完的紀錄。
      // 原本 to 由 initUsageDateRange / 上次手動設值固定，getUsageDateRange 讀回時
      // 精度只到分鐘（秒/毫秒被丟），若新紀錄 timestamp > 欄位寫入時的當下分鐘起始
      // 就不在 query 範圍 → 「打開 options 看不到剛翻完的紀錄，要 refresh / 點現在時間」。
      // 切 usage tab 通常就是想看最新狀態，自動 bump 符合直覺；若 user 在 tab 內手動
      // 改 to（看歷史）不受影響（只在切進來那刻覆寫）。
      setDateTimeFields('usage-to', new Date());
      loadUsageData();
    }
    // 切到 Log 頁時開始 polling
    if (btn.dataset.tab === 'log') startLogPolling();
    else stopLogPolling();
  });
});

// ─── 用量頁面狀態 ────────────────────────────────────────
let usageChart = null;
let currentGranularity = 'day';

// v1.8.39: 用量明細表分頁（避免幾千筆紀錄一次塞 DOM 拖慢主執行緒）
const USAGE_PAGE_SIZE = 100;
let usageCurrentPage = 1;        // 1-based
let usageFilteredCache = [];     // 最近一次 filter 結果（供翻頁時 slice)
let allUsageRecords = [];   // v1.2.60: client-side 搜尋用，保留完整記錄
let lastChartData = null;   // v1.8.41: 幣值切換時 re-render chart 用（避免重打 IndexedDB)

// v1.5.7: 用量紀錄「模型」欄改用「翻譯快速鍵」三組 preset 的 label 標記。
// 在 load() 結尾把當前 presets / customProvider 寫進這裡，供 modelToLabel() 渲染時查表。
let _presetsCache = [];
let _customProviderCache = { model: '' };

/**
 * 把 record.model 對映成 preset 的 label（顯示用）。
 * - 'google-translate' → engine='google' 的 preset 標籤
 * - engine='openai-compat'(或 model 不像 Gemini)→ engine='openai-compat' 的 preset 標籤;
 *   沒對映 preset 時退到 path 最後一段(`accounts/fireworks/models/qwen3p6` → `qwen3p6`)
 * - 等於某 preset.model（engine='gemini'）→ 該 preset 標籤
 * - 都不命中 → 回退原本的 short model（去掉 gemini-/-preview 前後綴）
 *
 * v1.9.2:engine 加為可選參數。row-level caller 帶 r.engine;aggregate 路徑(top model /
 *        filter dropdown)沒 engine 資訊時走 model ID 啟發式判斷(Gemini ID 都是 `gemini-`
 *        開頭,其他即視為 customProvider 路徑)。修舊行為:customProvider 已換 model 後,
 *        過去用該 model 的紀錄會 fallback 顯示原始 ID(可能是 path-style 長字串)。
 */
function modelToLabel(modelId, engine) {
  if (!modelId) return '—';
  if (modelId === 'google-translate') {
    const p = _presetsCache.find(x => x.engine === 'google');
    return p?.label || 'Google MT';
  }
  // openai-compat 路徑:明示 engine='openai-compat',或 model ID 不像 Gemini(後者用於 aggregate
  // 路徑沒帶 engine 的情境)。Gemini model ID 一律以 'gemini-' 開頭,啟發式可靠。
  // 顯示策略:取 path 最後一段(provider/family/model → model)。直接用 preset label「自訂模型」
  // 會讓所有 customProvider 紀錄(包含換 model 前後)看起來相同,filter dropdown 兩個選項看起來
  // 一樣;path 最後一段保留可區分性又不會撐爆欄位寬度。
  const looksLikeGemini = modelId.startsWith('gemini-');
  const isCustom = engine === 'openai-compat' || (!engine && !looksLikeGemini);
  if (isCustom) {
    const last = modelId.split('/').pop();
    return last || modelId;
  }
  const p = _presetsCache.find(x => x.engine === 'gemini' && x.model === modelId);
  if (p) return p.label;
  return modelId.replace('gemini-', '').replace('-preview', '');
}

// v1.2.60: 預設日期範圍：近 30 天
// v1.5.7: 改用「<input type="date"> + HH/MM <select>」拆兩段，24 小時制完全在我們控制下
//         （Chrome datetime-local 的 12/24 制跟 OS locale 走、HTML 無法 override）。

const _pad2 = n => String(n).padStart(2, '0');

// 一次性建好 HH (00–23) 與 MM (00–59) 的 <option>；只跑一次（initUsageDateRange 第一次呼叫）
let _timeSelectsBuilt = false;
function buildTimeSelectOptions() {
  if (_timeSelectsBuilt) return;
  _timeSelectsBuilt = true;
  // AMO source review: hourOptions / minOptions 是純 dev 生成的時間下拉（_pad2 把 0..59 整數補零成 2 位字串），完全無 user input。
  const hourOptions = Array.from({ length: 24 }, (_, h) => `<option value="${_pad2(h)}">${_pad2(h)}</option>`).join('');
  const minOptions  = Array.from({ length: 60 }, (_, m) => `<option value="${_pad2(m)}">${_pad2(m)}</option>`).join('');
  for (const id of ['usage-from-hour', 'usage-to-hour']) $(id).innerHTML = hourOptions;
  for (const id of ['usage-from-min',  'usage-to-min'])  $(id).innerHTML = minOptions;
}

function setDateTimeFields(prefix, d) {
  $(`${prefix}-date`).value = `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())}`;
  $(`${prefix}-hour`).value = _pad2(d.getHours());
  $(`${prefix}-min`).value  = _pad2(d.getMinutes());
}

function readDateTimeFields(prefix, fallbackHHMM = '00:00') {
  const date = $(`${prefix}-date`).value;
  if (!date) return null;
  const hh = $(`${prefix}-hour`).value || fallbackHHMM.slice(0, 2);
  const mm = $(`${prefix}-min`).value  || fallbackHHMM.slice(3, 5);
  return new Date(`${date}T${hh}:${mm}`).getTime();
}

function initUsageDateRange() {
  buildTimeSelectOptions();
  const to = new Date();
  const from = new Date();
  // v1.8.39: 預設範圍從 30 天縮到 7 天，降低初始載入筆數（分頁仍可手動拉長日期看更多）
  from.setDate(from.getDate() - 7);
  from.setHours(0, 0, 0, 0);
  setDateTimeFields('usage-from', from);
  setDateTimeFields('usage-to', to);
}

function getUsageDateRange() {
  const from = readDateTimeFields('usage-from', '00:00') ?? (Date.now() - 7 * 86400000);
  const to   = readDateTimeFields('usage-to',   '23:59') ?? Date.now();
  return { from, to };
}

// ─── 格式化工具 ──────────────────────────────────────────
function fmtTime(ts) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

// v1.8.20: in-flight request token，只渲染最新一筆。日期/粒度切換頻繁時三條
// Promise.all 後發但先回的會覆蓋先發但後回的，圖表 stale-data race。
let _loadUsageDataReqId = 0;

// ─── 載入用量資料 ────────────────────────────────────────
async function loadUsageData() {
  const { from, to } = getUsageDateRange();
  const reqId = ++_loadUsageDataReqId;

  // 同時載入彙總、圖表、明細
  const [statsRes, chartRes, recordsRes] = await Promise.all([
    browser.runtime.sendMessage({ type: 'QUERY_USAGE_STATS', payload: { from, to } }),
    browser.runtime.sendMessage({ type: 'QUERY_USAGE_CHART', payload: { from, to, groupBy: currentGranularity } }),
    browser.runtime.sendMessage({ type: 'QUERY_USAGE', payload: { from, to } }),
  ]);

  // v1.8.20: 期間有更新的 request 已發出 → 放棄這次 stale 結果
  if (reqId !== _loadUsageDataReqId) return;

  // 彙總卡片
  if (statsRes?.ok) {
    const s = statsRes.stats;
    $('usage-total-cost').textContent = formatMoney(s.totalBilledCostUSD, fmtMoneyOpts());
    $('usage-total-cost-label').textContent = _t('options.usage.totalCostLabelCurrency', { currency: currentCurrencyState.currency });
    // v0.99: 思考 token 以 output 費率計費，加入總計
    $('usage-total-tokens').textContent = formatTokens(s.totalBilledInputTokens + s.totalOutputTokens);
    $('usage-total-count').textContent = String(s.count);
    // 找最常用模型
    let topModel = '—';
    let topCount = 0;
    for (const [m, info] of Object.entries(s.byModel || {})) {
      if (info.count > topCount) { topCount = info.count; topModel = m; }
    }
    // v1.5.7: 最常用模型卡片用 preset label 顯示
    $('usage-top-model').textContent = modelToLabel(topModel);
  }

  // 折線圖
  if (chartRes?.ok) {
    lastChartData = chartRes.data;
    renderChart(chartRes.data);
  }

  // 明細表格（v1.2.60: 存入 allUsageRecords 供搜尋過濾用；v1.3.2: 同步重建模型篩選選項）
  if (recordsRes?.ok) {
    allUsageRecords = recordsRes.records || [];
    populateModelFilter();
    applyUsageSearch();
  }
}

// ─── 折線圖 ──────────────────────────────────────────────
function renderChart(data) {
  const ctx = $('usage-chart').getContext('2d');

  if (usageChart) {
    usageChart.destroy();
    usageChart = null;
  }

  const labels = data.map(d => d.period);
  const tokenData = data.map(d => d.totalTokens);
  // v1.8.41：內部仍以 USD 為基準算合計 / 點值，顯示時（tooltip / Y 軸 / subtitle）再用
  // formatMoney 換算成當前幣值。chart Y 軸資料用換算後的數字，讓刻度直觀。
  const isTwd = currentCurrencyState.currency === 'TWD';
  const costData = isTwd
    ? data.map(d => (d.billedCostUSD || 0) * currentCurrencyState.rate)
    : data.map(d => d.billedCostUSD || 0);
  const costLabel = isTwd ? _t('options.usage.costTwd') : _t('options.usage.costUsd');
  const yAxisTitle = isTwd ? 'TWD' : 'USD';

  // 計算期間合計，顯示在圖表右上角
  const totalTokens = tokenData.reduce((s, v) => s + v, 0);
  const totalCostUSD = data.reduce((s, d) => s + (d.billedCostUSD || 0), 0);

  usageChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Tokens',
          data: tokenData,
          borderColor: '#0071e3',
          backgroundColor: 'rgba(0, 113, 227, 0.08)',
          fill: true,
          tension: 0.3,
          yAxisID: 'y',
          pointRadius: data.length > 60 ? 0 : 3,
          pointHoverRadius: 5,
        },
        {
          label: costLabel,
          data: costData,
          borderColor: '#34c759',
          backgroundColor: 'rgba(52, 199, 89, 0.08)',
          fill: true,
          tension: 0.3,
          yAxisID: 'y1',
          pointRadius: data.length > 60 ? 0 : 3,
          pointHoverRadius: 5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          align: 'start',
          labels: { font: { size: 11 }, boxWidth: 12, padding: 12 },
        },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              if (ctx.datasetIndex === 0) return `Tokens: ${formatTokens(ctx.parsed.y)}`;
              // v1.8.41:tooltip 顯示已換算的金額（TWD 模式時 ctx.parsed.y 已是 TWD 數值）
              if (isTwd) {
                const v = ctx.parsed.y;
                const value = v < 0.1 ? v.toFixed(3) : v.toFixed(1);
                return _t('options.usage.costTwdRow', { value });
              }
              return _t('options.usage.costUsdRow', { value: formatUSD(ctx.parsed.y) });
            },
          },
        },
        // Chart.js subtitle 用作期間累計顯示
        subtitle: {
          display: true,
          text: _t('options.usage.periodTotal', {
            tokens: formatTokens(totalTokens),
            cost: formatMoney(totalCostUSD, fmtMoneyOpts()),
          }),
          align: 'end',
          font: { size: 11, weight: 'normal' },
          color: '#86868b',
          padding: { bottom: 8 },
        },
      },
      scales: {
        x: {
          ticks: {
            font: { size: 10 },
            maxTicksLimit: 12,
            maxRotation: 0,
            // 日粒度時 X 軸只顯示「日」，避免 2026-04-30 這種長字串擠成一團；
            // 月 / 年粒度仍顯示原 period 字串。tooltip title 不受影響（走 default
            // formatter，顯示完整 period)
            callback: function(value) {
              const label = this.getLabelForValue(value);
              if (currentGranularity === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(label)) {
                return label.slice(-2); // YYYY-MM-DD → DD
              }
              return label;
            },
          },
          grid: { display: false },
        },
        y: {
          type: 'linear',
          position: 'left',
          beginAtZero: true,
          ticks: {
            font: { size: 10 },
            callback: (v) => formatTokens(v),
          },
          title: { display: true, text: 'Tokens', font: { size: 10 }, color: '#0071e3' },
        },
        y1: {
          type: 'linear',
          position: 'right',
          beginAtZero: true,
          grid: { drawOnChartArea: false },
          ticks: {
            font: { size: 10 },
            callback: (v) => isTwd ? 'NT$' + Math.round(v) : '$' + v.toFixed(2),
          },
          title: { display: true, text: yAxisTitle, font: { size: 10 }, color: '#34c759' },
        },
      },
    },
  });
}

// ─── 明細表格 ────────────────────────────────────────────
function renderTable(records) {
  const tbody = $('usage-tbody');
  const emptyMsg = $('usage-empty');

  if (!records || records.length === 0) {
    tbody.innerHTML = '';
    emptyMsg.hidden = false;
    renderUsagePagination(0);
    return;
  }
  emptyMsg.hidden = true;

  // v1.8.39: 只 render 當前頁的 records，其餘交給分頁按鈕切換
  const totalPages = Math.max(1, Math.ceil(records.length / USAGE_PAGE_SIZE));
  if (usageCurrentPage > totalPages) usageCurrentPage = totalPages;
  if (usageCurrentPage < 1) usageCurrentPage = 1;
  const startIdx = (usageCurrentPage - 1) * USAGE_PAGE_SIZE;
  const pageRecords = records.slice(startIdx, startIdx + USAGE_PAGE_SIZE);

  // AMO source review: usage records 來自本 extension 自己寫進 IndexedDB(usage-db.js）的計費紀錄，
  // 所有 string 欄位渲染前都經 escapeHtml/escapeAttr，數字欄位是計算結果。無外部 user input 流入。
  tbody.innerHTML = pageRecords.map(r => {
    const isGoogle = r.engine === 'google';  // v1.4.0
    // v0.99: 思考 token 以 output 費率計費，加入明細計算
    const billedTokens = (r.billedInputTokens || 0) + (r.outputTokens || 0);
    // v1.5.7: 模型欄顯示 preset label；查不到才回退 model id 短名
    // v1.8.19: label 放寬到 30 字後 col-model 加 max-width + ellipsis,
    //          完整 label 由 title attr 補（hover tooltip)
    const shortModel = modelToLabel(r.model, r.engine);
    const shortModelEsc = escapeHtml(shortModel);
    // 術語表抽取的紀錄（source='glossary'）在標題前加標籤，讓使用者一眼分辨
    // 同 url 的主翻譯紀錄與術語表紀錄（兩者通常 model 不同，費用各自計算）
    const sourceTagHtml = r.source === 'glossary'
      ? `<span class="usage-source-tag">[${escapeHtml(_t('options.usage.sourceGlossary'))}] </span>`
      : '';
    const title = sourceTagHtml + escapeHtml(r.title || _t('common.untitled'));
    const urlDisplay = escapeHtml(shortenUrl(r.url || ''));
    const urlFull = escapeHtml(r.url || '');
    // v1.0.30: Gemini implicit cache hit rate（Google Translate 不適用）
    const inputTk = r.inputTokens || 0;
    const cachedTk = r.cachedTokens || 0;
    const hitRate = (!isGoogle && inputTk > 0) ? Math.round(cachedTk / inputTk * 100) : 0;
    const hitHtml = hitRate > 0
      ? `<span class="usage-cache-hit">(${hitRate}% hit)</span>`
      : '';
    // v1.2.60: URL 改為可點擊連結
    const urlHtml = urlFull
      ? `<a class="site-url" href="${urlFull}" target="_blank" rel="noopener">${urlDisplay}</a>`
      : `<span class="site-url">${urlDisplay}</span>`;
    // v1.4.0: Google Translate 顯示字元數；v1.5.7: 去千位分隔符 + 去「字元」單位 + 費用單寫 $0
    const tokenCell = isGoogle
      ? String(r.chars || 0)
      : `${formatTokens(billedTokens)}${hitHtml}`;
    const costCell = isGoogle ? formatMoney(0, fmtMoneyOpts()) : formatMoney(r.billedCostUSD || 0, fmtMoneyOpts());
    return `<tr>
      <td>${fmtTime(r.timestamp)}</td>
      <td>${title}${urlHtml}</td>
      <td class="col-model" title="${shortModelEsc}">${shortModelEsc}</td>
      <td class="num">${tokenCell}</td>
      <td class="num">${costCell}</td>
    </tr>`;
  }).join('');

  renderUsagePagination(records.length);
}

// v1.8.39: 更新分頁 UI（總筆數、頁碼、prev/next disabled 狀態）
function renderUsagePagination(totalCount) {
  const nav = $('usage-pagination');
  const info = $('usage-page-info');
  const prevBtn = $('usage-page-prev');
  const nextBtn = $('usage-page-next');
  if (!nav || !info || !prevBtn || !nextBtn) return;

  if (totalCount <= USAGE_PAGE_SIZE) {
    // 一頁就放得下，隱藏分頁列
    nav.hidden = true;
    return;
  }
  nav.hidden = false;
  const totalPages = Math.ceil(totalCount / USAGE_PAGE_SIZE);
  info.textContent = _t('options.usage.pageInfo', {
    page: usageCurrentPage,
    total: totalPages,
    count: totalCount,
  });
  prevBtn.disabled = usageCurrentPage <= 1;
  nextBtn.disabled = usageCurrentPage >= totalPages;
}

// v1.8.39: 切頁 — 不重 query，只 re-render 當前頁
function changeUsagePage(delta) {
  const totalPages = Math.max(1, Math.ceil(usageFilteredCache.length / USAGE_PAGE_SIZE));
  const next = usageCurrentPage + delta;
  if (next < 1 || next > totalPages) return;
  usageCurrentPage = next;
  renderTable(usageFilteredCache);
  // 切頁後捲回表格頂端，避免使用者迷失位置
  $('usage-tbody')?.parentElement?.scrollTo({ top: 0 });
}

// v1.2.62: 從記錄陣列重算彙總卡片（讓搜尋/filter 結果同步反映在計費數字上）
function updateSummaryFromRecords(records) {
  let totalCost = 0, totalTokens = 0;
  const modelCount = {};
  for (const r of records) {
    totalCost += r.billedCostUSD || 0;
    totalTokens += (r.billedInputTokens || 0) + (r.outputTokens || 0);
    const m = r.model || '';
    modelCount[m] = (modelCount[m] || 0) + 1;
  }
  let topModel = '—', topCount = 0;
  for (const [m, c] of Object.entries(modelCount)) {
    if (c > topCount) { topCount = c; topModel = m; }
  }
  $('usage-total-cost').textContent   = formatMoney(totalCost, fmtMoneyOpts());
  $('usage-total-cost-label').textContent = _t('options.usage.totalCostLabelCurrency', { currency: currentCurrencyState.currency });
  $('usage-total-tokens').textContent = formatTokens(totalTokens);
  $('usage-total-count').textContent  = String(records.length);
  // v1.5.7: 最常用模型卡片也用 preset label 顯示
  $('usage-top-model').textContent    = modelToLabel(topModel);
}

// v1.3.2: 從 allUsageRecords 動態建立模型篩選下拉選項
function populateModelFilter() {
  const sel = $('usage-model-filter');
  if (!sel) return;
  const currentVal = sel.value;
  const models = [...new Set(allUsageRecords.map(r => r.model || '').filter(Boolean))].sort();
  // 重建選項（保留「全部模型」作為第一個選項）
  // v1.5.7: option text 用 preset label 顯示；option value 仍是 model id 維持 filter 行為
  // AMO source review: model id 跟 label 都經 escapeHtml/escapeAttr，第一段是 dev hardcoded。
  // v1.8.61:placeholder option 加 data-i18n 讓 applyI18n 在 UI 語系切換時持續更新
  sel.innerHTML = `<option value="" data-i18n="options.usage.modelAll">${escapeHtml(_t('options.usage.modelAll'))}</option>` +
    models.map(m => {
      const label = escapeHtml(modelToLabel(m));
      return `<option value="${escapeAttr(m)}"${m === currentVal ? ' selected' : ''}>${label}</option>`;
    }).join('');
}

// v1.2.60: 搜尋過濾，同時比對標題與 URL；v1.3.2: 加入模型篩選
// v1.8.39: filter 結果存進 usageFilteredCache 供翻頁重用，並 reset 到第 1 頁
function applyUsageSearch() {
  const q = ($('usage-search')?.value || '').trim().toLowerCase();
  const modelFilter = ($('usage-model-filter')?.value || '');
  let filtered = allUsageRecords;
  if (q) {
    filtered = filtered.filter(r =>
      (r.title || '').toLowerCase().includes(q) ||
      (r.url || '').toLowerCase().includes(q));
  }
  if (modelFilter) {
    filtered = filtered.filter(r => (r.model || '') === modelFilter);
  }
  usageFilteredCache = filtered;
  usageCurrentPage = 1;
  renderTable(filtered);
  updateSummaryFromRecords(filtered);
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    // v1.2.60: YouTube watch 頁保留 ?v= 參數，否則顯示沒意義的 /watch
    if ((u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') &&
        u.pathname === '/watch' && u.searchParams.get('v')) {
      return u.hostname + '/watch?v=' + u.searchParams.get('v');
    }
    const path = u.pathname.length > 40 ? u.pathname.slice(0, 40) + '…' : u.pathname;
    return u.hostname + path;
  } catch { return url; }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── 事件綁定 ────────────────────────────────────────────
// v1.5.7: 6 個欄位 (date + hour select + min select) × 2，任一變動都重 load
for (const id of ['usage-from-date', 'usage-from-hour', 'usage-from-min',
                  'usage-to-date',   'usage-to-hour',   'usage-to-min']) {
  $(id)?.addEventListener('change', loadUsageData);
}
// v1.5.7: 「現在時間」按鈕 — 一鍵把「到」設為當下時間方便看最新紀錄
$('usage-to-now')?.addEventListener('click', () => {
  setDateTimeFields('usage-to', new Date());
  loadUsageData();
});
// v1.2.60: 搜尋框即時過濾
// v1.8.14: 加 150ms debounce — 紀錄到 1-2K 筆時每打一字整表 re-render 會卡
let _usageSearchTimer = null;
$('usage-search')?.addEventListener('input', () => {
  clearTimeout(_usageSearchTimer);
  _usageSearchTimer = setTimeout(applyUsageSearch, 150);
});
$('usage-model-filter')?.addEventListener('change', applyUsageSearch);

// v1.8.39: 分頁按鈕
$('usage-page-prev')?.addEventListener('click', () => changeUsagePage(-1));
$('usage-page-next')?.addEventListener('click', () => changeUsagePage(+1));

// 粒度切換
document.querySelectorAll('.gran-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.gran-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentGranularity = btn.dataset.gran;
    loadUsageData();
  });
});

// v1.6.11: 手動重新載入用量紀錄（不需關閉設定頁）
// 使用者回報：translatePage 寫入新紀錄後，設定頁停留在用量頁也不會自動更新，
// Cmd+R refresh 也會回到預設分頁。loadUsageData() 已能保留當前的篩選狀態
// （日期範圍 / 搜尋 / 模型 filter / 粒度）只重抓底層資料，直接呼叫即可。
$('usage-reload')?.addEventListener('click', () => {
  // v1.8.40: 重新載入時也 bump「到」時間到當下，確保涵蓋剛翻完的紀錄
  // （詳見 tab click handler 內 usage 分支的註解）
  setDateTimeFields('usage-to', new Date());
  loadUsageData();
});

// 匯出 CSV
$('usage-export-csv').addEventListener('click', async () => {
  const { from, to } = getUsageDateRange();
  const res = await browser.runtime.sendMessage({ type: 'EXPORT_USAGE_CSV', payload: { from, to } });
  if (!res?.ok) { alert(_t('options.usage.exportFailed', { error: res?.error || _t('common.errorUnknown') })); return; }
  const blob = new Blob([res.csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = buildUsageCsvFilename(from, to);
  a.click();
  URL.revokeObjectURL(url);
});

// 清除紀錄
$('usage-clear').addEventListener('click', async () => {
  if (!confirm(_t('options.usage.clearConfirm'))) return;
  const res = await browser.runtime.sendMessage({ type: 'CLEAR_USAGE' });
  if (res?.ok) {
    loadUsageData();
  } else {
    alert(_t('options.usage.clearFailed', { error: res?.error || _t('common.errorUnknown') }));
  }
});

// ═══════════════════════════════════════════════════════════
// v0.88: Log 分頁
// ═══════════════════════════════════════════════════════════

let logPollingTimer = null;
let logLatestSeq = 0;
let allLogs = [];          // 累積收到的全部 log entries
// v1.8.56: dedup 用三元 key，因為 SW 重啟後 logSeq 會重置 → persisted 與新記憶體 buffer 的 seq
// 可能撞號；改用 ISO timestamp + category + message 做穩定 key（同一筆 log 只會有一份）。
const _seenLogKeys = new Set();
let _persistedLoaded = false;

function logKey(entry) { return `${entry.t}|${entry.category}|${entry.message}`; }

function appendLogs(entries) {
  let added = 0;
  for (const e of entries) {
    const k = logKey(e);
    if (_seenLogKeys.has(k)) continue;
    _seenLogKeys.add(k);
    allLogs.push(e);
    added++;
  }
  if (allLogs.length > 2000) {
    // 砍前段時對應 _seenLogKeys 也要清理，避免無限長
    const dropped = allLogs.splice(0, allLogs.length - 2000);
    for (const e of dropped) _seenLogKeys.delete(logKey(e));
  }
  return added;
}

// ─── Polling ────────────────────────────────────────────
function startLogPolling() {
  if (logPollingTimer) return;
  // v1.8.56: 第一次進 Log 分頁時先載 persisted log（SW 重啟前的紀錄，跨 worker 仍在），
  // 然後才開始 polling 記憶體 buffer。下一輪以後 _persistedLoaded=true，直接 polling。
  fetchLogs();  // 立即拉一次（內部會處理 persisted 載入）
  logPollingTimer = setInterval(fetchLogs, 2000);
}

function stopLogPolling() {
  if (logPollingTimer) {
    clearInterval(logPollingTimer);
    logPollingTimer = null;
  }
}

// v1.8.20: in-flight guard——SW 喚醒慢時 setInterval 不等上一輪，兩個 in-flight call
// 共用同一 logLatestSeq 各自拿回相同 log → concat 兩次 → 表格出現重複行。
let _fetchLogsInFlight = false;
async function fetchLogs() {
  if (_fetchLogsInFlight) return;
  _fetchLogsInFlight = true;
  try {
    // v1.8.56: 第一次進入時先載 persisted log（跨 SW 重啟仍在，使用者翻完文章
    // 切走幾分鐘回來看 Log 分頁也能看到上一輪 SW 的紀錄）
    if (!_persistedLoaded) {
      _persistedLoaded = true;
      try {
        const persisted = await browser.runtime.sendMessage({ type: 'GET_PERSISTED_LOGS' });
        if (persisted?.ok && Array.isArray(persisted.logs) && persisted.logs.length > 0) {
          appendLogs(persisted.logs);
          renderLogTable();
        }
      } catch { /* 第一次失敗讓後續 polling 補，不阻斷 */ }
    }
    const res = await browser.runtime.sendMessage({
      type: 'GET_LOGS',
      payload: { afterSeq: logLatestSeq },
    });
    if (!res?.ok) return;
    // v1.8.14: 沒新 log 直接 return，不重 render（原本即使空也整表 innerHTML 一遍）
    if (!res.logs || res.logs.length === 0) {
      if (res.latestSeq) logLatestSeq = res.latestSeq;
      return;
    }
    const added = appendLogs(res.logs);
    if (res.latestSeq) logLatestSeq = res.latestSeq;
    if (added > 0) renderLogTable();
  } catch {
    // extension context invalidated 等情況，靜默
  } finally {
    _fetchLogsInFlight = false;
  }
}

// ─── 篩選 ───────────────────────────────────────────────
// 回傳同時帶「命中位置」資訊：_searchHitInData = true 代表 search 字串只在 data 內命中
// （不在 message / category），render 端會自動展開該行 data detail，免得使用者
// 搜尋了還要逐筆點 {…} 開來看 inputPreview / outputPreview。
function getFilteredLogs() {
  const catFilter = $('log-category-filter').value;
  const lvlFilter = $('log-level-filter').value;
  const search = ($('log-search').value || '').trim().toLowerCase();

  return allLogs.filter(entry => {
    if (catFilter && entry.category !== catFilter) return false;
    if (lvlFilter && entry.level !== lvlFilter) return false;
    if (search) {
      const msg = (entry.message || '').toLowerCase();
      const cat = (entry.category || '').toLowerCase();
      const dataStr = entry.data ? JSON.stringify(entry.data).toLowerCase() : '';
      const hitMsg = msg.includes(search) || cat.includes(search);
      const hitData = dataStr.includes(search);
      if (!hitMsg && !hitData) return false;
      // 標記「只在 data 命中」讓 render 自動展開該行 data
      entry._searchHitInData = !hitMsg && hitData;
    } else {
      entry._searchHitInData = false;
    }
    return true;
  });
}

// 把 jsonText 中所有 search 字串包成 <mark>，與 escapeHtml 兼容
// （先 escapeHtml，再對 escape 後字串做大小寫不敏感的 mark 包裝）。
// search 為空時直接回傳 escapeHtml 結果不動。
function highlightSearch(text, searchLower) {
  const escaped = escapeHtml(text);
  if (!searchLower) return escaped;
  // 在 escaped 字串中以大小寫不敏感方式包 <mark>。
  // 用 RegExp 但要 escape regex meta 字。
  const safe = searchLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(new RegExp(safe, 'gi'), m => `<mark class="log-search-hit">${m}</mark>`);
}

// ─── 渲染 ───────────────────────────────────────────────
const LOG_CAT_LABELS = {
  translate:   'translate',
  api:         'api',
  cache:       'cache',
  'rate-limit':'rate-limit',
  glossary:    'glossary',
  spa:         'spa',
  system:      'system',
};

function renderLogTable() {
  const tbody = $('log-tbody');
  const emptyMsg = $('log-empty');
  const filtered = getFilteredLogs();

  // 更新計數
  $('log-count').textContent = _t('options.log.count', { count: allLogs.length });
  const filteredCountEl = $('log-filtered-count');
  if (filtered.length !== allLogs.length) {
    filteredCountEl.textContent = _t('options.log.filteredCount', { count: filtered.length });
    filteredCountEl.hidden = false;
  } else {
    filteredCountEl.hidden = true;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    emptyMsg.hidden = allLogs.length > 0 ? true : false;
    if (allLogs.length > 0 && filtered.length === 0) {
      emptyMsg.textContent = _t('options.log.emptyFiltered');
      emptyMsg.hidden = false;
    } else if (allLogs.length === 0) {
      emptyMsg.textContent = _t('options.log.empty');
      emptyMsg.hidden = false;
    }
    return;
  }
  emptyMsg.hidden = true;

  // 只渲染最近 500 筆（避免 DOM 太大）
  const visible = filtered.slice(-500);

  // 記住哪些 data detail 是展開的，渲染後還原
  const openSet = new Set();
  for (const el of tbody.querySelectorAll('.log-data-detail.open')) {
    openSet.add(el.id);
  }

  // v1.5.7: search 命中 data 時自動展開該行 data，並把命中字串包 <mark> 高亮
  const searchLower = ($('log-search').value || '').trim().toLowerCase();

  // AMO source review: log entries 來自本 extension 自己 sendLog 寫進 buffer 的紀錄，所有 string
  // 欄位渲染前都經 escapeHtml/escapeAttr，搜尋字串（user input）也經 escape 才插入 <mark>。
  tbody.innerHTML = visible.map(entry => {
    const time = formatLogTime(entry.t);
    const catClass = `log-cat log-cat-${entry.category || 'system'}`;
    const catLabel = LOG_CAT_LABELS[entry.category] || entry.category || 'system';
    const lvlClass = `log-lvl log-lvl-${entry.level || 'info'}`;
    const lvlLabel = (entry.level || 'info').toUpperCase();
    const rowClass = entry.level === 'error' ? 'log-row-error' :
                     entry.level === 'warn'  ? 'log-row-warn'  : '';
    const msg = highlightSearch(entry.message || '', searchLower);

    // data 展開按鈕
    let dataHtml = '';
    if (entry.data && Object.keys(entry.data).length > 0) {
      const dataJson = JSON.stringify(entry.data, null, 2);
      const dataId = `log-data-${entry.seq}`;
      // v1.5.7: 「使用者手動展開過」或「搜尋只在 data 命中」兩種情況都展開
      const isOpen = openSet.has(dataId) || entry._searchHitInData;
      const dataInner = highlightSearch(dataJson, searchLower);
      dataHtml = `<button class="log-data-toggle" data-target="${dataId}">${escapeHtml(isOpen ? _t('options.log.detailExpand') : _t('options.log.detailCollapse'))}</button>` +
        `<div class="log-data-detail${isOpen ? ' open' : ''}" id="${dataId}">${dataInner}</div>`;
    }

    return `<tr class="${rowClass}">` +
      `<td class="log-col-time">${time}</td>` +
      `<td class="log-col-cat"><span class="${catClass}">${catLabel}</span></td>` +
      `<td class="log-col-lvl"><span class="${lvlClass}">${lvlLabel}</span></td>` +
      `<td class="log-col-msg"><span class="log-msg-text">${msg}</span>${dataHtml}</td>` +
      `</tr>`;
  }).join('');

  // 自動捲動到底部
  if ($('log-autoscroll').checked) {
    const wrapper = $('log-table-wrapper');
    wrapper.scrollTop = wrapper.scrollHeight;
  }
}

function formatLogTime(isoStr) {
  try {
    const d = new Date(isoStr);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch {
    return '??:??:??';
  }
}

// ─── 使用者手動捲動時自動關閉 autoscroll ────────────────
// 判斷邏輯：若使用者往上捲（不在底部），取消勾選；捲回底部則重新勾選
$('log-table-wrapper').addEventListener('scroll', () => {
  const w = $('log-table-wrapper');
  // 距離底部 30px 以內視為「在底部」
  const atBottom = w.scrollHeight - w.scrollTop - w.clientHeight < 30;
  $('log-autoscroll').checked = atBottom;
});

// ─── Log 事件綁定 ───────────────────────────────────────
$('log-category-filter').addEventListener('change', renderLogTable);
$('log-level-filter').addEventListener('change', renderLogTable);
$('log-search').addEventListener('input', renderLogTable);

// 清除
// v1.8.56: 同時清記憶體 buffer 與 persisted yt_debug_log。原本只送 CLEAR_LOGS
// → persisted 那 100 筆還在 storage.local，下次 SW 重啟 Log 分頁載入時又冒出來，
// 使用者以為按了「清除」實際沒清乾淨。
$('log-clear').addEventListener('click', async () => {
  try {
    await Promise.all([
      browser.runtime.sendMessage({ type: 'CLEAR_LOGS' }),
      browser.runtime.sendMessage({ type: 'CLEAR_PERSISTED_LOGS' }),
    ]);
  } catch { /* 靜默 */ }
  allLogs = [];
  _seenLogKeys.clear();
  logLatestSeq = 0;
  renderLogTable();
});

// 匯出 JSON
$('log-export').addEventListener('click', () => {
  const filtered = getFilteredLogs();
  const data = filtered.length !== allLogs.length ? filtered : allLogs;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  a.href = url;
  a.download = `shinkansen-log-${ts}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// Data 展開/收合（event delegation）
$('log-tbody').addEventListener('click', (e) => {
  const toggle = e.target.closest('.log-data-toggle');
  if (!toggle) return;
  const targetId = toggle.dataset.target;
  const detail = document.getElementById(targetId);
  if (detail) {
    detail.classList.toggle('open');
    toggle.textContent = detail.classList.contains('open') ? _t('options.log.detailExpand') : _t('options.log.detailCollapse');
  }
});

// ─── 初始化 ──────────────────────────────────────────────
initUsageDateRange();
load();
