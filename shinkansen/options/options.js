// options.js — 設定頁邏輯
// v1.0.4: 改為 ES module，從 lib/ 匯入共用常數與工具函式，消除重複程式碼。

import { browser } from '../lib/compat.js';
import { DEFAULT_SETTINGS, DEFAULT_SYSTEM_PROMPT, DEFAULT_GLOSSARY_PROMPT, DEFAULT_SUBTITLE_SYSTEM_PROMPT, DEFAULT_FORBIDDEN_TERMS } from '../lib/storage.js';
import { TIER_LIMITS } from '../lib/tier-limits.js';
import { formatTokens, formatUSD, parseUserNum, buildUsageCsvFilename } from '../lib/format.js';
import { isWorthNotifying } from '../lib/update-check.js'; // v1.6.5

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
// 95%+ 場景,真實後備路徑剩 testGeminiKey 按鈕 + cache key 構建）。改讀
// 「主要預設」(slot 2)的 model;若 slot 2 引擎不是 gemini → fallback 到
// DEFAULTS.geminiConfig.model(避免 testGeminiKey 沒 model 可送)。
function getSelectedModel() {
  const engineSel = $('preset-engine-2');
  const modelSel = $('preset-model-2');
  if (engineSel?.value === 'gemini' && modelSel?.value) {
    return modelSel.value;
  }
  return DEFAULTS.geminiConfig.model;
}

// v1.6.15: SERVICE_TIER_MULTIPLIER + applyModelPricing 已移除。
// 原本是「全域 model dropdown 切換時自動帶入參考價到後備路徑單價」的便利功能,
// model dropdown 移除後不再有觸發點;且 v1.6.14 已加 per-model override 表
// 取代「自動帶價」的 UX 功能。後備路徑單價現在純由使用者填,不自動連動 service tier。

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
  rpdEl.value = limits.rpd === Infinity ? '無限制' : limits.rpd;
}

const $ = (id) => document.getElementById(id);

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
  // v1.6.15: 全域 #model dropdown 已移除,不再從 storage 載入到 UI。
  // settings.geminiConfig.model 仍保留 storage 結構（避免 migration）但 UI 不顯示。
  $('serviceTier').value = s.geminiConfig.serviceTier;
  $('temperature').value = s.geminiConfig.temperature;
  $('topP').value = s.geminiConfig.topP;
  $('topK').value = s.geminiConfig.topK;
  $('maxOutputTokens').value = s.geminiConfig.maxOutputTokens;
  $('systemInstruction').value = s.geminiConfig.systemInstruction;
  // v1.6.16: 後備路徑單價 UI 已移除(對應 input element 不存在),不再從 settings 載入到 UI。
  // settings.pricing 仍保留 storage 結構作 belt-and-suspenders(background.js:610 fallback 路徑保留)。
  // v1.6.14: per-model 計價覆蓋
  const overrides = s.modelPricingOverrides || {};
  const fillOverride = (id, model, key) => {
    const el = $(id);
    if (!el) return;
    const v = overrides[model]?.[key];
    el.value = (Number.isFinite(Number(v)) ? Number(v) : '');
  };
  fillOverride('override-lite-input',  'gemini-3.1-flash-lite-preview', 'inputPerMTok');
  fillOverride('override-lite-output', 'gemini-3.1-flash-lite-preview', 'outputPerMTok');
  fillOverride('override-flash-input', 'gemini-3-flash-preview', 'inputPerMTok');
  fillOverride('override-flash-output','gemini-3-flash-preview', 'outputPerMTok');
  fillOverride('override-pro-input',   'gemini-3.1-pro-preview', 'inputPerMTok');
  fillOverride('override-pro-output',  'gemini-3.1-pro-preview', 'outputPerMTok');
  $('whitelist').value = (s.domainRules.whitelist || []).join('\n');
  $('debugLog').checked = s.debugLog;

  // 效能與配額
  $('tier').value = s.tier || 'tier1';
  applyTierToInputs($('tier').value, s.geminiConfig.model);
  // 若有 override 則把 override 填進去覆蓋 tier 預設
  if (s.rpmOverride) $('rpm').value = s.rpmOverride;
  if (s.tpmOverride) $('tpm').value = s.tpmOverride;
  if (s.rpdOverride) $('rpd').value = s.rpdOverride;
  // v1.6.19: 統一用 ?? 不用 || ——使用者輸入 0(batch size 等)是合法
  // 設定意圖,|| 會把 0 當 falsy 默默改回預設值,造成 UI 「我設了 0 卻看到 10%」。
  // v1.8.19: 安全邊際從 UI 移除,程式碼內部維持 storage default 0.1 即可
  $('maxConcurrentBatches').value = s.maxConcurrentBatches ?? 10;
  $('maxUnitsPerBatch').value = s.maxUnitsPerBatch ?? 20;
  $('maxCharsPerBatch').value = s.maxCharsPerBatch ?? 3500;
  $('maxTranslateUnits').value = s.maxTranslateUnits ?? 1000;
  // v1.8.3: partialMode toggle + size
  const pm = { ...DEFAULTS.partialMode, ...(s.partialMode || {}) };
  $('partialModeEnabled').checked = pm.enabled === true;
  $('partialModeViewportOnly').checked = pm.viewportOnly === true;
  $('partialModeMaxUnits').value = pm.maxUnits;
  $('maxRetries').value = s.maxRetries ?? 3;

  // v0.69: 術語表一致化設定
  const gl = { ...DEFAULTS.glossary, ...(s.glossary || {}) };
  $('glossaryEnabled').checked = gl.enabled !== false;
  // v1.7.2: 術語擷取獨立模型(預設 Flash Lite),空字串表示「與主翻譯相同」
  $('glossaryModel').value = gl.model ?? DEFAULTS.glossary.model;
  // v1.7.3: 阻塞門檻可調(預設 10,> 此值才 blocking,≤ 此值走 fire-and-forget)
  $('glossaryBlockingThreshold').value = gl.blockingThreshold ?? DEFAULTS.glossary.blockingThreshold;
  $('glossaryTemperature').value = gl.temperature;
  $('glossaryTimeout').value = gl.timeoutMs;
  $('glossaryPrompt').value = gl.prompt;

  // v1.0.17: Toast 透明度 / v1.0.31: Toast 位置
  const opacityPct = Math.round((s.toastOpacity ?? 0.7) * 100);
  $('toastOpacity').value = opacityPct;
  $('toastOpacityLabel').textContent = opacityPct;
  $('toastPosition').value = s.toastPosition || 'bottom-right';
  // v1.1.3: Toast 自動關閉
  $('toastAutoHide').checked = s.toastAutoHide !== false;
  // v1.6.8: Toast master switch
  $('showProgressToast').checked = s.showProgressToast !== false;

  // v1.0.21: 頁面層級繁中偵測開關
  $('skipTraditionalChinesePage').checked = s.skipTraditionalChinesePage !== false;

  // v1.5.0: 雙語對照視覺標記
  const validMarks = ['tint', 'bar', 'dashed', 'none'];
  const savedMark = validMarks.includes(s.translationMarkStyle) ? s.translationMarkStyle : 'tint';
  for (const r of document.querySelectorAll('input[name="markStyle"]')) {
    r.checked = (r.value === savedMark);
  }
  updateDualDemoMark(savedMark);

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
  forbiddenTerms = Array.isArray(s.forbiddenTerms) ? s.forbiddenTerms : DEFAULT_FORBIDDEN_TERMS;
  renderForbiddenTermsTable();

  // v1.5.7: 自訂 OpenAI-compatible Provider
  // apiKey 走 storage.local（不在 sync 也不在 saved 物件，獨立讀取）
  const cp = { ...DEFAULTS.customProvider, ...(s.customProvider || {}) };
  $('cp-baseUrl').value = cp.baseUrl || '';
  $('cp-model').value = cp.model || '';
  $('cp-systemPrompt').value = cp.systemPrompt || '';
  $('cp-temperature').value = (typeof cp.temperature === 'number') ? cp.temperature : 0.7;
  $('cp-inputPerMTok').value = cp.inputPerMTok != null ? cp.inputPerMTok : '';
  $('cp-outputPerMTok').value = cp.outputPerMTok != null ? cp.outputPerMTok : '';
  // v1.6.18: thinking 控制
  const validLevels = ['auto', 'off', 'low', 'medium', 'high'];
  const tl = validLevels.includes(cp.thinkingLevel) ? cp.thinkingLevel : 'auto';
  if ($('cp-thinking-level')) $('cp-thinking-level').value = tl;
  if ($('cp-extra-body-json')) $('cp-extra-body-json').value = (typeof cp.extraBodyJson === 'string') ? cp.extraBodyJson : '';
  // 從 storage.local 讀 customProviderApiKey
  const { customProviderApiKey = '' } = await browser.storage.local.get('customProviderApiKey');
  $('cp-apiKey').value = customProviderApiKey;

  // v1.2.11: YouTube 字幕設定
  const yt = { ...DEFAULTS.ytSubtitle, ...(s.ytSubtitle || {}) };
  // v1.4.0: 字幕翻譯引擎
  const ytEngineEl = $('ytEngine');
  if (ytEngineEl) ytEngineEl.value = yt.engine || 'gemini';
  $('ytAutoTranslate').checked       = yt.autoTranslate       === true;
  // v1.6.23: ASR 分句改單一 toggle——開啟=progressive(混合模式)、關閉=heuristic(預設分句)。
  // 舊 'llm' 值視為 progressive(行為相近,LLM 結果仍會顯示;只是改成漸進方式)。
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
  // 兩個下拉選單的 option text 由 refreshSlotDropdownLabels() 統一處理,
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
    const disableUpdateNotice = s.disableUpdateNotice === true;
    if (!disableUpdateNotice) {
      const { updateAvailable } = await browser.storage.local.get('updateAvailable');
      const manifest = browser.runtime.getManifest();
      // v1.6.5: belt-and-suspenders — 必須 storage.version 真的 > current 才顯示
      if (updateAvailable && updateAvailable.version && updateAvailable.releaseUrl
          && isWorthNotifying(updateAvailable.version, manifest.version)) {
        $('update-banner-row').hidden = false;
        $('update-banner-version').textContent = `v${updateAvailable.version}（你目前是 v${manifest.version}）`;
        // click handler 改用 document delegation 在外面掛（避免 init() async race）
      }
    }
  } catch { /* 略 */ }
}

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
function updateDualDemoMark(mark) {
  const wrapper = document.getElementById('dual-demo-wrapper');
  if (wrapper) wrapper.setAttribute('data-sk-mark', mark);
}

function getSelectedMarkStyle() {
  const checked = document.querySelector('input[name="markStyle"]:checked');
  const v = checked?.value;
  return ['tint', 'bar', 'dashed', 'none'].includes(v) ? v : 'tint';
}

// v1.4.13: engine='google' 時隱藏 model 欄
// v1.5.7: engine='openai-compat' 也隱藏（model 由「自訂 Provider」分頁設定）
function updatePresetModelVisibility(slot) {
  const engine = $(`preset-engine-${slot}`).value;
  const row = $(`preset-model-row-${slot}`);
  if (row) row.hidden = (engine === 'google' || engine === 'openai-compat');
}

// 「工具列翻譯本頁按鈕」「自動翻譯網站」兩個下拉選單的 option text
// 跟著「翻譯快速鍵」preset 標籤即時聯動。直接從 DOM input 讀目前值,
// 不需重新讀 storage,使用者打字當下就能看到變化。
function _slotTitle(slot) {
  return slot === 2 ? '主要預設' : `預設 ${slot === 1 ? 2 : 3}`;
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
  // v1.6.16: 後備路徑單價 UI 已移除;mainInput fallback 改用主要預設(slot 2)的內建表 pricing。
  // 這個 hint 是設定頁字幕 prompt 開銷估算用,翻譯實際計費走獨立路徑(yt.pricing / customProvider / preset modelOverride),不受影響。
  const mainInput = MODEL_PRICING[mainModel]?.input ?? 0;

  if (engine === 'openai-compat') {
    // 自訂模型字幕路徑用 customProvider 那組
    inputPrice = isNaN(cpInput) ? 0 : cpInput;
    modelDisplay = cpModel || '(未設定)';
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
    hintEl.innerHTML = '<strong>Google Translate 不會送 prompt</strong>，這兩個 toggle 對 Google MT 不適用。';
    return;
  }
  if (!inputPrice) {
    hintEl.innerHTML = '<strong>無法估算費用</strong>：請在對應的計價欄位設定 input 單價（USD / 1M tokens）。';
    return;
  }

  hintEl.innerHTML =
    `<strong>token 開銷估算</strong>（以目前模型 <code>${escapeHtml(modelDisplay)}</code> 計，input $${inputPrice}/1M tokens、30 分鐘影片約 60 批）：<br>` +
    `<span style="display:inline-block; margin-left: 12px;">• 套用「固定術語表」（${fgCount} 條）→ 每批 prompt +${fgTok} token，全片約 ${fmtUSD(fgTok)}（cache 命中後 ~${fmtUSD(fgTok, 0.25)}）</span><br>` +
    `<span style="display:inline-block; margin-left: 12px;">• 套用「禁用詞清單」（${fbCount} 條）→ 每批 prompt +${fbTok} token，全片約 ${fmtUSD(fbTok)}（cache 命中後 ~${fmtUSD(fbTok, 0.25)}）</span><br>` +
    `<span style="font-size: 11px; color: #999;">※ token 為粗估，實際以 Gemini tokenizer 為準。Gemini implicit cache 命中需 prompt prefix ≥1024 token 且穩定，命中部分 25% 計費。</span>`;
}

// v1.4.13: 從 chrome.commands.getAll() 讀取實際綁定鍵位顯示在每張 card 右上角
// v1.8.19: command id 主要預設(slot 2)從 translate-preset-2 改為 translate-preset-0
//          (字典序保證 chrome://extensions/shortcuts 顯示順序「主要 → 預設 2 → 預設 3」)
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
        keyEl.textContent = '未設定';
        keyEl.setAttribute('data-unset', '1');
      }
    }
  } catch { /* Safari / 舊瀏覽器不支援 commands API，欄位維持 '—' */ }
}

// v1.8.14: 並發 save 防護
// 之前 save() 是 read-modify-write(sync.get → 組整桶 → sync.set),沒任何 lock。
// 兩個 Tab 的儲存按鈕共用同一個 save(),快速連按 / 跨 Tab 同時改 / 打字+按鈕同時觸發
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
  // v1.6.15: 讀回現存的 geminiConfig.model 不從 UI 取(全域 dropdown 已移除)。
  // 保留 storage 欄位避免 migration,且 testGeminiKey 已改走「主要預設」的 model。
  // v1.6.16: 同樣讀回 settings.pricing(後備路徑單價 UI 也移除了)。
  const existing = await browser.storage.sync.get(['geminiConfig', 'pricing']);
  const existingModel = existing.geminiConfig?.model || DEFAULTS.geminiConfig.model;
  const settings = {
    geminiConfig: {
      model: existingModel,
      serviceTier: $('serviceTier').value,
      // v1.8.20: 改用 parseUserNum——空字串/非法字元走 default,避免 NaN 寫進 storage 後送 API 拒絕。
      temperature: parseUserNum($('temperature').value, DEFAULTS.geminiConfig.temperature),
      topP: parseUserNum($('topP').value, DEFAULTS.geminiConfig.topP),
      topK: parseUserNum($('topK').value, DEFAULTS.geminiConfig.topK),
      maxOutputTokens: parseUserNum($('maxOutputTokens').value, DEFAULTS.geminiConfig.maxOutputTokens),
      systemInstruction: $('systemInstruction').value,
    },
    // v1.6.16: 後備路徑單價 UI 已移除,從 storage 拉現存值寫回(沿用 v1.6.15 對 geminiConfig.model 的同 pattern)
    pricing: existing.pricing || DEFAULTS.pricing,
    domainRules: {
      whitelist: $('whitelist').value.split('\n').map(s => s.trim()).filter(Boolean),
    },
    debugLog: $('debugLog').checked,
    tier: $('tier').value,
    // v1.6.19: 改用 parseUserNum——空字串/非法字元走 default,合法數字(含 0)保留。
    // 沿用 `|| default` 會把使用者明確打的 0 一律當 falsy 改回預設,造成 UI 不一致。
    // v1.8.19: safetyMargin 從 UI 移除,save() 不再寫,維持 storage 既有值(0.1)
    maxRetries: parseUserNum($('maxRetries').value, 3),
    maxConcurrentBatches: parseUserNum($('maxConcurrentBatches').value, 10),
    maxUnitsPerBatch: parseUserNum($('maxUnitsPerBatch').value, 20),
    maxCharsPerBatch: parseUserNum($('maxCharsPerBatch').value, 3500),
    maxTranslateUnits: parseUserNum($('maxTranslateUnits').value, 1000),
    // v1.8.3: 只翻文章開頭(節省費用)
    partialMode: {
      enabled: $('partialModeEnabled').checked,
      viewportOnly: $('partialModeViewportOnly').checked,
      maxUnits: parseUserNum($('partialModeMaxUnits').value, 25),
    },
    // 只有 custom tier 才寫入 override(其他 tier 的數字從對照表讀,不存)
    rpmOverride: $('tier').value === 'custom' ? (Number($('rpm').value) || null) : null,
    tpmOverride: $('tier').value === 'custom' ? (Number($('tpm').value) || null) : null,
    rpdOverride: $('tier').value === 'custom' ? (Number($('rpd').value) || null) : null,
    // v0.69: 術語表一致化
    glossary: {
      enabled: $('glossaryEnabled').checked,
      // v1.7.2: 術語擷取獨立模型;空字串 = 與主翻譯模型相同(舊行為)
      model: $('glossaryModel').value,
      prompt: $('glossaryPrompt').value,
      // v1.8.20: 改 parseUserNum,避免使用者打 0 (合法 temperature) 被 falsy 改回 0.1
      temperature: parseUserNum($('glossaryTemperature').value, DEFAULTS.glossary.temperature ?? 0.1),
      skipThreshold: DEFAULTS.glossary.skipThreshold,
      // v1.7.3: blockingThreshold 使用者可調(0 = 永遠 fire-and-forget,大值 = 幾乎都 blocking)
      blockingThreshold: parseUserNum($('glossaryBlockingThreshold').value, DEFAULTS.glossary.blockingThreshold),
      timeoutMs: parseUserNum($('glossaryTimeout').value, 60000),
      maxTerms: DEFAULTS.glossary.maxTerms,
    },
    // v1.0.17: Toast 透明度 / v1.0.31: Toast 位置
    // v1.8.20: 空字串 → 0/100 = 0 → toast 完全透明,改 parseUserNum 走預設
    toastOpacity: parseUserNum($('toastOpacity').value, (DEFAULTS.toastOpacity ?? 0.95) * 100) / 100,
    toastPosition: $('toastPosition').value,
    // v1.1.3: Toast 自動關閉
    toastAutoHide: $('toastAutoHide').checked,
    // v1.6.8: Toast master switch（false 完全不顯示，連訊息都不發）
    showProgressToast: $('showProgressToast').checked,
    // v1.5.0: 雙語對照視覺標記
    translationMarkStyle: getSelectedMarkStyle(),
    // v1.0.21: 頁面層級繁中偵測開關
    skipTraditionalChinesePage: $('skipTraditionalChinesePage').checked,
    // v1.2.11: YouTube 字幕設定
    ytSubtitle: {
      engine: ($('ytEngine')?.value || 'gemini'),  // v1.4.0
      autoTranslate:      $('ytAutoTranslate').checked,
      // v1.6.23: ASR 分句單一 toggle——checked=progressive(混合)、unchecked=heuristic
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
      const label = ($(`preset-label-${slot}`).value || '').trim() || `預設 ${slot}`;
      return { slot, engine, model, label };
    }),
    // v1.6.6: 工具列「翻譯本頁」按鈕對應的 preset slot
    popupButtonSlot: (() => {
      const v = Number($('popup-button-slot')?.value);
      return [1, 2, 3].includes(v) ? v : 2;
    })(),
    // v1.6.13: 自動翻譯網站(白名單)觸發時走的 preset slot
    autoTranslateSlot: (() => {
      const v = Number($('auto-translate-slot')?.value);
      return [1, 2, 3].includes(v) ? v : 2;
    })(),
    // v1.6.14: per-model 計價覆蓋(Google 改價時使用者自填)。
    // 兩欄都是合法數字才寫入 entry,任一欄空白整個 model 不存(走內建表)。
    modelPricingOverrides: (() => {
      const collect = (model, inputId, outputId) => {
        const i = $(inputId)?.value?.trim();
        const o = $(outputId)?.value?.trim();
        if (i === '' || o === '') return null;
        const ni = Number(i), no = Number(o);
        if (!Number.isFinite(ni) || !Number.isFinite(no) || ni < 0 || no < 0) return null;
        return { model, inputPerMTok: ni, outputPerMTok: no };
      };
      const rows = [
        collect('gemini-3.1-flash-lite-preview', 'override-lite-input',  'override-lite-output'),
        collect('gemini-3-flash-preview',         'override-flash-input', 'override-flash-output'),
        collect('gemini-3.1-pro-preview',         'override-pro-input',   'override-pro-output'),
      ].filter(Boolean);
      const out = {};
      for (const r of rows) {
        out[r.model] = { inputPerMTok: r.inputPerMTok, outputPerMTok: r.outputPerMTok };
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
    // v1.6.18: 加入 thinkingLevel + extraBodyJson(各家 thinking schema 統一抽象)
    customProvider: {
      baseUrl: ($('cp-baseUrl').value || '').trim(),
      model: ($('cp-model').value || '').trim(),
      systemPrompt: $('cp-systemPrompt').value || '',
      // v1.8.20: temperature 改 parseUserNum 避免 0 被當 falsy;單價 0 是合法值改 parseUserNum 0
      temperature: parseUserNum($('cp-temperature').value, DEFAULTS.customProvider?.temperature ?? 0.7),
      inputPerMTok: parseUserNum($('cp-inputPerMTok').value, 0),
      outputPerMTok: parseUserNum($('cp-outputPerMTok').value, 0),
      thinkingLevel: (() => {
        const v = $('cp-thinking-level')?.value;
        return ['auto', 'off', 'low', 'medium', 'high'].includes(v) ? v : 'auto';
      })(),
      extraBodyJson: ($('cp-extra-body-json')?.value || '').trim(),
    },
  };
  // v1.5.7: customProvider.apiKey 走 storage.local（與主 apiKey 同樣設計），先抽出再寫 sync
  const cpApiKeyValue = ($('cp-apiKey').value || '').trim();
  await browser.storage.local.set({ customProviderApiKey: cpApiKeyValue });
  await browser.storage.sync.set(settings);
  $('save-status').textContent = '✓ 已儲存';
  setTimeout(() => { $('save-status').textContent = ''; }, 2000);
  // v0.94: 顯示綠色已儲存提示條
  showSaveBar('saved', '設定已儲存');
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
    btn.textContent = '隱藏';
  } else {
    input.type = 'password';
    btn.textContent = '顯示';
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
// v1.2.11: YouTube 字幕分頁
$('save-youtube').addEventListener('click', save);
// Debug 分頁
$('save-debug').addEventListener('click', save);
$('yt-reset-prompt').addEventListener('click', () => {
  $('ytSystemPrompt').value = DEFAULT_SUBTITLE_SYSTEM_PROMPT;
  markDirty(); // 值已變更，標記為未儲存
});
// v1.5.8: 自訂模型「重置為預設 Prompt」按鈕——把 textarea 重設為 Gemini 同款 DEFAULT_SYSTEM_PROMPT
$('cp-reset-prompt')?.addEventListener('click', () => {
  $('cp-systemPrompt').value = DEFAULT_SYSTEM_PROMPT;
  markDirty();
});

// v1.5.8: Gemini 分頁「重設所有參數」按鈕 — 把本分頁所有欄位填回 DEFAULT_SETTINGS 對應值。
// 不直接寫 storage（要使用者按「儲存設定」才生效），避免誤觸毀掉自訂設定無法回復。
// 不影響其他分頁（術語表 / 禁用詞 / 自訂模型 / YouTube 字幕）；要全部清空仍走「一般設定 → 回復預設設定」。
$('gemini-reset-all')?.addEventListener('click', () => {
  if (!confirm('確定要把 Gemini 分頁所有參數重設為預設值嗎？\n\n影響欄位：Service Tier、模型計價覆蓋（清空走內建表）、Tier/RPM/TPM/RPD、安全邊際、重試次數、Temperature、Top P、Top K、Max Output Tokens、翻譯 Prompt、並發批次、每批段數/字元/段落上限。\n\n按下後仍需點「儲存設定」才會生效。')) return;
  const D = DEFAULTS;
  // v1.6.15: 全域 #model dropdown 已移除,不再 reset 模型 UI;只 reset service tier。
  // settings.geminiConfig.model 由「儲存設定」按鈕從 storage 讀回沿用。
  $('serviceTier').value = D.geminiConfig.serviceTier;
  // LLM 參數
  $('temperature').value     = D.geminiConfig.temperature;
  $('topP').value            = D.geminiConfig.topP;
  $('topK').value            = D.geminiConfig.topK;
  $('maxOutputTokens').value = D.geminiConfig.maxOutputTokens;
  $('systemInstruction').value = D.geminiConfig.systemInstruction;
  // 計價
  // v1.6.16: 後備路徑單價 UI 已移除,reset 不再動 settings.pricing 欄位。
  // v1.6.14: per-model override 欄位 reset 為空(預設 modelPricingOverrides:{} 對應 UI 全空 = 走內建表)。
  for (const id of [
    'override-lite-input',  'override-lite-output',
    'override-flash-input', 'override-flash-output',
    'override-pro-input',   'override-pro-output',
  ]) {
    const el = $(id);
    if (el) el.value = '';
  }
  // 配額（先填 tier 觸發 RPM/TPM/RPD readonly 帶值，再清掉 override）
  $('tier').value = D.tier;
  applyTierToInputs(D.tier, D.geminiConfig.model);
  // v1.8.19: safetyMargin UI 已移除,reset 不再 touch
  $('maxRetries').value = D.maxRetries;
  // 效能
  $('maxConcurrentBatches').value = D.maxConcurrentBatches;
  $('maxUnitsPerBatch').value     = D.maxUnitsPerBatch;
  $('maxCharsPerBatch').value     = D.maxCharsPerBatch;
  $('maxTranslateUnits').value    = D.maxTranslateUnits;
  // v1.8.3: 只翻文章開頭重設
  $('partialModeEnabled').checked = D.partialMode.enabled;
  $('partialModeViewportOnly').checked = D.partialMode.viewportOnly;
  $('partialModeMaxUnits').value  = D.partialMode.maxUnits;
  markDirty();
  $('save-gemini-status').textContent = '欄位已重設，請按「儲存設定」生效';
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
// v1.6.15: 移除 'model'(全域 dropdown 已移除)。preset-model-2 切換不影響字幕成本估算
// 因為字幕用獨立的 ytSubtitle.model;字幕 prompt token 成本估算只看字幕端設定。
// v1.6.16: 移除 'inputPerMTok'(後備路徑單價 UI 已移除)
for (const id of ['ytModel', 'ytInputPerMTok', 'cp-model', 'cp-inputPerMTok']) {
  $(id)?.addEventListener('change', updateYtPromptCostHint);
  $(id)?.addEventListener('input', updateYtPromptCostHint);
}

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
  showSaveBar('dirty', '有未儲存的變更');
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

// 顯示/隱藏 API Key 切換（v0.63）— 讓使用者能確認貼上去的 key 沒有貼錯
$('toggle-api-key').addEventListener('click', () => {
  const input = $('apiKey');
  const btn = $('toggle-api-key');
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = '隱藏';
    btn.setAttribute('aria-label', '隱藏 API Key');
  } else {
    input.type = 'password';
    btn.textContent = '顯示';
    btn.setAttribute('aria-label', '顯示 API Key');
  }
});

// v1.5.7: 通用「測試 API」UI helper — 兩個測試按鈕共用 loading / 結果顯示流程
async function runApiTest({ btn, resultEl, sendMessage }) {
  btn.disabled = true;
  btn.dataset.state = 'loading';
  btn.textContent = '測試中⋯';
  resultEl.hidden = false;
  resultEl.dataset.state = 'loading';
  resultEl.textContent = '正在連線測試⋯';
  try {
    const resp = await sendMessage();
    if (resp?.ok) {
      resultEl.dataset.state = 'ok';
      resultEl.textContent = '✓ ' + (resp.message || '連線成功');
    } else {
      resultEl.dataset.state = 'fail';
      resultEl.textContent = '✗ ' + (resp?.message || resp?.error || '未知錯誤');
    }
  } catch (err) {
    resultEl.dataset.state = 'fail';
    resultEl.textContent = '✗ ' + (err?.message || String(err));
  } finally {
    btn.disabled = false;
    btn.dataset.state = '';
    btn.textContent = '測試';
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
// v1.6.15: 全域 model dropdown 已移除,Service Tier 已搬到 LLM 參數微調 section。
// applyModelPricing(model) 在這裡也失去意義(model 不再從 UI 變,計價走 v1.6.14 per-model
// override 表;Service Tier 影響的是內建表 multiplier,但「後備路徑單價」不再隨 tier 變)。
$('tier').addEventListener('change', () => {
  applyTierToInputs($('tier').value, getSelectedModel());
});
// v1.8.19: safetyMargin slider UI 已移除,程式碼內部維持 storage default 0.1
$('toastOpacity').addEventListener('input', () => {
  $('toastOpacityLabel').textContent = $('toastOpacity').value;
});
$('toastPosition').addEventListener('change', markDirty);

// v1.5.0: 雙語視覺標記 radio 切換 → 即時更新 demo wrapper
for (const r of document.querySelectorAll('input[name="markStyle"]')) {
  r.addEventListener('change', () => updateDualDemoMark(getSelectedMarkStyle()));
}

$('reset-defaults').addEventListener('click', async () => {
  if (!confirm('確定要回復所有預設設定嗎？\n\nAPI Key 會被保留，翻譯快取與累計使用統計不受影響。\n此操作無法復原。')) return;
  // v0.62 起：apiKey 在 browser.storage.local，不在 sync 裡，
  // 所以直接 clear sync 即可；apiKey 自然不受影響。
  await browser.storage.sync.clear();
  await load();
  $('save-status').textContent = '✓ 已回復預設設定';
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
  };

  for (const [key, rule] of Object.entries(topRules)) {
    if (!(key in raw)) continue;
    const v = raw[key];
    if (rule.nullable && (v === null || v === undefined)) { clean[key] = null; continue; }
    if (typeof v !== rule.type) { warnings.push(`${key}：型別錯誤，已略過`); continue; }
    if (rule.type === 'number') {
      if (!Number.isFinite(v)) { warnings.push(`${key}：非有效數字，已略過`); continue; }
      if (rule.min !== undefined && v < rule.min) { warnings.push(`${key}：${v} 低於下限 ${rule.min}，已略過`); continue; }
      if (rule.max !== undefined && v > rule.max) { warnings.push(`${key}：${v} 超過上限 ${rule.max}，已略過`); continue; }
      if (rule.int && !Number.isInteger(v)) { warnings.push(`${key}：需為整數，已略過`); continue; }
    }
    if (rule.oneOf && !rule.oneOf.includes(v)) { warnings.push(`${key}：「${v}」不在允許值內，已略過`); continue; }
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
      if (typeof v !== rule.type) { warnings.push(`geminiConfig.${key}：型別錯誤，已略過`); continue; }
      if (rule.type === 'number') {
        if (!Number.isFinite(v)) { warnings.push(`geminiConfig.${key}：非有效數字，已略過`); continue; }
        if (rule.min !== undefined && v < rule.min) { warnings.push(`geminiConfig.${key}：${v} 低於下限 ${rule.min}，已略過`); continue; }
        if (rule.max !== undefined && v > rule.max) { warnings.push(`geminiConfig.${key}：${v} 超過上限 ${rule.max}，已略過`); continue; }
        if (rule.int && !Number.isInteger(v)) { warnings.push(`geminiConfig.${key}：需為整數，已略過`); continue; }
      }
      if (rule.oneOf && !rule.oneOf.includes(v)) { warnings.push(`geminiConfig.${key}：「${v}」不在允許值內，已略過`); continue; }
      gcClean[key] = v;
    }
    if (Object.keys(gcClean).length > 0) clean.geminiConfig = gcClean;
  }

  // pricing 子物件
  if (raw.pricing && typeof raw.pricing === 'object') {
    const pr = raw.pricing;
    const prClean = {};
    for (const key of ['inputPerMTok', 'outputPerMTok']) {
      if (!(key in pr)) continue;
      const v = pr[key];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        warnings.push(`pricing.${key}：需為非負數字，已略過`); continue;
      }
      prClean[key] = v;
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
      warnings.push(`forbiddenTerms：${raw.forbiddenTerms.length - cleanTerms.length} 筆格式錯誤，已略過`);
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
    if (typeof cp.inputPerMTok === 'number' && cp.inputPerMTok >= 0) cpClean.inputPerMTok = cp.inputPerMTok;
    if (typeof cp.outputPerMTok === 'number' && cp.outputPerMTok >= 0) cpClean.outputPerMTok = cp.outputPerMTok;
    if (Object.prototype.hasOwnProperty.call(cp, 'apiKey')) {
      warnings.push('customProvider.apiKey：匯入不含 API Key，請至設定頁自行填入');
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
        warnings.push(`domainRules.${key}：需為字串陣列，已略過`);
      }
    }
    if (Object.keys(drClean).length > 0) clean.domainRules = drClean;
  }

  // v1.8.3: partialMode 子物件
  if (raw.partialMode && typeof raw.partialMode === 'object') {
    const pm = raw.partialMode;
    const pmClean = {};
    if (typeof pm.enabled === 'boolean') pmClean.enabled = pm.enabled;
    if (typeof pm.viewportOnly === 'boolean') pmClean.viewportOnly = pm.viewportOnly;
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
      alert('匯入失敗：檔案中沒有任何有效的設定欄位');
      return;
    }
    await browser.storage.sync.set(clean);
    await load();
    const msg = warnings.length > 0
      ? '匯入完成，但部分欄位被略過：\n\n' + warnings.join('\n')
      : '匯入成功';
    alert(msg + '\n\n（API Key 不在匯入範圍，請自行輸入）');
  } catch (err) {
    alert('匯入失敗：' + err.message);
  }
});

// v1.3.16 / v1.5.4: 平台偵測決定快捷鍵設定連結。
// 用 runtime.getURL('') 的 prefix 精確區分 Chrome / Firefox / Safari，
// 比 globalThis.chrome 偵測更可靠（Firefox 全域 chrome 不存在但 browser 在）。
//   chrome-extension://    → Chrome / Edge → chrome://extensions/shortcuts
//   moz-extension://       → Firefox       → about:addons（Firefox 沒有深連到 shortcut UI）
//   safari-web-extension:// → Safari       → 隱藏連結（Safari 不支援 about:* / chrome://*）
const _extUrl = browser.runtime.getURL('');
const _shortcutsLink = $('open-shortcuts');
if (_extUrl.startsWith('moz-extension://')) {
  _shortcutsLink?.addEventListener('click', (e) => {
    e.preventDefault();
    browser.tabs.create({ url: 'about:addons' });
  });
} else if (_extUrl.startsWith('chrome-extension://')) {
  _shortcutsLink?.addEventListener('click', (e) => {
    e.preventDefault();
    browser.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
} else {
  // Safari 或其他：隱藏連結（無法 tabs.create 到內建設定 URL）
  if (_shortcutsLink) _shortcutsLink.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════
// v1.0.29: 固定術語表 CRUD
// ═══════════════════════════════════════════════════════════

// 記憶體中的固定術語表資料（load 時從 storage 讀入，save 時寫回）
let fixedGlossary = { global: [], byDomain: {} };
let currentDomain = ''; // 目前選中的網域

function renderGlossaryTable(tbody, entries) {
  tbody.innerHTML = entries.map((e, i) =>
    `<tr data-idx="${i}">` +
    `<td><input type="text" class="fg-source" value="${escapeAttr(e.source)}" placeholder="英文原文"></td>` +
    `<td><input type="text" class="fg-target" value="${escapeAttr(e.target)}" placeholder="中文譯文"></td>` +
    `<td class="glossary-col-action"><button class="glossary-delete-row" data-idx="${i}" title="刪除">×</button></td>` +
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
  sel.innerHTML = '<option value="">選擇網域…</option>' +
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
  if (!confirm(`確定要刪除「${currentDomain}」的網域術語表嗎？`)) return;
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
  tbody.innerHTML = forbiddenTerms.map((t, i) => {
    const noteVal = escapeAttr(t.note || '');
    return `<tr data-idx="${i}">` +
      `<td><input type="text" class="ft-forbidden" value="${escapeAttr(t.forbidden)}" placeholder="禁用詞（簡中）"></td>` +
      `<td><input type="text" class="ft-replacement" value="${escapeAttr(t.replacement)}" placeholder="替換詞（台灣）"></td>` +
      `<td class="ft-note-cell"><input type="text" class="ft-note" value="${noteVal}" title="${noteVal}" placeholder="（可選）"></td>` +
      `<td class="glossary-col-action"><button class="glossary-delete-row" data-idx="${i}" title="刪除">×</button></td>` +
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
  if (!confirm('確定要還原預設禁用詞清單嗎？目前的自訂內容會被覆蓋。')) return;
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
    if (btn.dataset.tab === 'usage') loadUsageData();
    // 切到 Log 頁時開始 polling
    if (btn.dataset.tab === 'log') startLogPolling();
    else stopLogPolling();
  });
});

// ─── 用量頁面狀態 ────────────────────────────────────────
let usageChart = null;
let currentGranularity = 'day';
let allUsageRecords = [];   // v1.2.60: client-side 搜尋用，保留完整記錄

// v1.5.7: 用量紀錄「模型」欄改用「翻譯快速鍵」三組 preset 的 label 標記。
// 在 load() 結尾把當前 presets / customProvider 寫進這裡，供 modelToLabel() 渲染時查表。
let _presetsCache = [];
let _customProviderCache = { model: '' };

/**
 * 把 record.model 對映成 preset 的 label（顯示用）。
 * - 'google-translate' → engine='google' 的 preset 標籤
 * - 等於 customProvider.model → engine='openai-compat' 的 preset 標籤
 * - 等於某 preset.model（engine='gemini'）→ 該 preset 標籤
 * - 都不命中 → 回退原本的 short model（去掉 gemini-/-preview 前後綴）
 */
function modelToLabel(modelId) {
  if (!modelId) return '—';
  if (modelId === 'google-translate') {
    const p = _presetsCache.find(x => x.engine === 'google');
    return p?.label || 'Google MT';
  }
  if (_customProviderCache.model && modelId === _customProviderCache.model) {
    const p = _presetsCache.find(x => x.engine === 'openai-compat');
    if (p) return p.label;
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
  from.setDate(from.getDate() - 30);
  from.setHours(0, 0, 0, 0);
  setDateTimeFields('usage-from', from);
  setDateTimeFields('usage-to', to);
}

function getUsageDateRange() {
  const from = readDateTimeFields('usage-from', '00:00') ?? (Date.now() - 30 * 86400000);
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

// v1.8.20: in-flight request token,只渲染最新一筆。日期/粒度切換頻繁時三條
// Promise.all 後發但先回的會覆蓋先發但後回的,圖表 stale-data race。
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
    $('usage-total-cost').textContent = formatUSD(s.totalBilledCostUSD);
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
  if (chartRes?.ok) renderChart(chartRes.data);

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
  const costData = data.map(d => d.billedCostUSD);

  // 計算期間合計，顯示在圖表右上角
  const totalTokens = tokenData.reduce((s, v) => s + v, 0);
  const totalCost = costData.reduce((s, v) => s + v, 0);

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
          label: '費用（USD）',
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
              return `費用: ${formatUSD(ctx.parsed.y)}`;
            },
          },
        },
        // Chart.js subtitle 用作期間累計顯示
        subtitle: {
          display: true,
          text: `期間合計：${formatTokens(totalTokens)} tokens / ${formatUSD(totalCost)}`,
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
            callback: (v) => '$' + v.toFixed(2),
          },
          title: { display: true, text: 'USD', font: { size: 10 }, color: '#34c759' },
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
    return;
  }
  emptyMsg.hidden = true;

  tbody.innerHTML = records.map(r => {
    const isGoogle = r.engine === 'google';  // v1.4.0
    // v0.99: 思考 token 以 output 費率計費，加入明細計算
    const billedTokens = (r.billedInputTokens || 0) + (r.outputTokens || 0);
    // v1.5.7: 模型欄顯示 preset label；查不到才回退 model id 短名
    // v1.8.19: label 放寬到 30 字後 col-model 加 max-width + ellipsis,
    //          完整 label 由 title attr 補(hover tooltip)
    const shortModel = modelToLabel(r.model);
    const shortModelEsc = escapeHtml(shortModel);
    const title = escapeHtml(r.title || '(無標題)');
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
    const costCell = isGoogle ? '$0' : formatUSD(r.billedCostUSD || 0);
    return `<tr>
      <td>${fmtTime(r.timestamp)}</td>
      <td>${title}${urlHtml}</td>
      <td class="col-model" title="${shortModelEsc}">${shortModelEsc}</td>
      <td class="num">${tokenCell}</td>
      <td class="num">${costCell}</td>
    </tr>`;
  }).join('');
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
  $('usage-total-cost').textContent   = formatUSD(totalCost);
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
  sel.innerHTML = '<option value="">全部模型</option>' +
    models.map(m => {
      const label = escapeHtml(modelToLabel(m));
      return `<option value="${escapeAttr(m)}"${m === currentVal ? ' selected' : ''}>${label}</option>`;
    }).join('');
}

// v1.2.60: 搜尋過濾，同時比對標題與 URL；v1.3.2: 加入模型篩選
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
// 使用者回報：translatePage 寫入新紀錄後,設定頁停留在用量頁也不會自動更新,
// Cmd+R refresh 也會回到預設分頁。loadUsageData() 已能保留當前的篩選狀態
// （日期範圍 / 搜尋 / 模型 filter / 粒度）只重抓底層資料,直接呼叫即可。
$('usage-reload')?.addEventListener('click', () => {
  loadUsageData();
});

// 匯出 CSV
$('usage-export-csv').addEventListener('click', async () => {
  const { from, to } = getUsageDateRange();
  const res = await browser.runtime.sendMessage({ type: 'EXPORT_USAGE_CSV', payload: { from, to } });
  if (!res?.ok) { alert('匯出失敗：' + (res?.error || '未知錯誤')); return; }
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
  if (!confirm('確定要清除所有翻譯用量紀錄嗎？\n此操作無法復原。')) return;
  const res = await browser.runtime.sendMessage({ type: 'CLEAR_USAGE' });
  if (res?.ok) {
    loadUsageData();
  } else {
    alert('清除失敗：' + (res?.error || '未知錯誤'));
  }
});

// ═══════════════════════════════════════════════════════════
// v0.88: Log 分頁
// ═══════════════════════════════════════════════════════════

let logPollingTimer = null;
let logLatestSeq = 0;
let allLogs = [];          // 累積收到的全部 log entries

// ─── Polling ────────────────────────────────────────────
function startLogPolling() {
  if (logPollingTimer) return;
  fetchLogs();  // 立即拉一次
  logPollingTimer = setInterval(fetchLogs, 2000);
}

function stopLogPolling() {
  if (logPollingTimer) {
    clearInterval(logPollingTimer);
    logPollingTimer = null;
  }
}

// v1.8.20: in-flight guard——SW 喚醒慢時 setInterval 不等上一輪,兩個 in-flight call
// 共用同一 logLatestSeq 各自拿回相同 log → concat 兩次 → 表格出現重複行。
let _fetchLogsInFlight = false;
async function fetchLogs() {
  if (_fetchLogsInFlight) return;
  _fetchLogsInFlight = true;
  try {
    const res = await browser.runtime.sendMessage({
      type: 'GET_LOGS',
      payload: { afterSeq: logLatestSeq },
    });
    if (!res?.ok) return;
    // v1.8.14: 沒新 log 直接 return,不重 render(原本即使空也整表 innerHTML 一遍)
    if (!res.logs || res.logs.length === 0) {
      if (res.latestSeq) logLatestSeq = res.latestSeq;
      return;
    }
    allLogs = allLogs.concat(res.logs);
    // 前端也限制 buffer 上限，避免記憶體無限成長
    if (allLogs.length > 2000) {
      allLogs = allLogs.slice(allLogs.length - 2000);
    }
    if (res.latestSeq) logLatestSeq = res.latestSeq;
    renderLogTable();
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
  $('log-count').textContent = `${allLogs.length} 筆`;
  const filteredCountEl = $('log-filtered-count');
  if (filtered.length !== allLogs.length) {
    filteredCountEl.textContent = `（篩選後 ${filtered.length} 筆）`;
    filteredCountEl.hidden = false;
  } else {
    filteredCountEl.hidden = true;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    emptyMsg.hidden = allLogs.length > 0 ? true : false;
    if (allLogs.length > 0 && filtered.length === 0) {
      emptyMsg.textContent = '沒有符合篩選條件的 Log';
      emptyMsg.hidden = false;
    } else if (allLogs.length === 0) {
      emptyMsg.textContent = '尚無 Log。翻譯一個頁面後，Log 會自動出現在這裡';
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
      dataHtml = `<button class="log-data-toggle" data-target="${dataId}">${isOpen ? '收合' : '{…}'}</button>` +
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
$('log-clear').addEventListener('click', async () => {
  try {
    await browser.runtime.sendMessage({ type: 'CLEAR_LOGS' });
  } catch { /* 靜默 */ }
  allLogs = [];
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
    toggle.textContent = detail.classList.contains('open') ? '收合' : '{…}';
  }
});

// ─── 初始化 ──────────────────────────────────────────────
initUsageDateRange();
load();
