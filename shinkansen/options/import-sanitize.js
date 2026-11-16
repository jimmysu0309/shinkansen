// import-sanitize.js — 設定匯入驗證（自 options.js 抽出，2026-09-11 code review §3.7-4）
//
// 對照 DEFAULT_SETTINGS 結構，只保留已知欄位，並檢查型別與範圍。
// 不認識的 key 直接丟掉，不合法的值回退為預設值。
//
// 抽成獨立 module 的原因：options.js 頂層直接操作 DOM，node 端 unit spec 無法 import；
// 匯入規則已四次漏列新設定 key（issue #48 / 批次 5-2 / 2026-07-08 / 2026-09-11），
// 需要 `test/unit/options-import-sanitize-coverage.spec.js` 這條 forcing function：
// DEFAULT_SETTINGS 每個 key（含子物件欄位）都必須能 round-trip 通過本函式，
// 新增設定 key 沒同步補規則 → spec fail。
//
// @param {object} raw  JSON.parse 後的匯入物件（apiKey 已由 caller 先剝掉）
// @param {(key: string, params?: object) => string} _t  i18n 翻譯函式（警告訊息用）
// @param {object} [SC]  lib/shortcut-utils.js 的 helper（customShortcuts 消毒用）；
//   options 頁預設拿 window.__SKShortcuts，node 端 spec 用 createRequire 傳入
// @returns {{ clean: object, warnings: string[] }}
import { TARGET_LANGUAGES, UI_LANGUAGES } from '../lib/storage.js';

export function sanitizeImport(raw, _t, SC = globalThis.__SKShortcuts) {
  const clean = {};
  const warnings = [];

  // 頂層純量欄位：型別 + 範圍
  const topRules = {
    autoTranslate:       { type: 'boolean' },
    // 2026-09-11 code review §3.7-4：autoConvertZh 原漏列（第四輪同型漏列），匯入被默默丟掉。
    // 之後 DEFAULT_SETTINGS 每個 key 都由 test/unit/options-import-sanitize-coverage.spec.js
    // forcing function 鎖住：新加設定 key 沒補這裡的規則 → spec fail。
    autoConvertZh:       { type: 'boolean' },
    debugLog:            { type: 'boolean' },
    maxRetries:          { type: 'number', min: 0, max: 10, int: true },
    maxConcurrentBatches:{ type: 'number', min: 1, max: 50, int: true },
    maxUnitsPerBatch:    { type: 'number', min: 1, max: 100, int: true },
    maxCharsPerBatch:    { type: 'number', min: 500, max: 20000, int: true },
    maxTranslateUnits:   { type: 'number', min: 0, max: 10000, int: true },
    toastAutoHide:       { type: 'boolean' },
    popupButtonSlot:     { type: 'number', min: 1, max: 3, int: true }, // v1.6.6
    autoTranslateSlot:   { type: 'number', min: 1, max: 3, int: true }, // v1.6.13
    modelPricingOverrides: { type: 'object' }, // v1.6.14
    showProgressToast:   { type: 'boolean' }, // v1.6.8
    hideZhConvertToast:  { type: 'boolean' }, // v2.3.0：簡繁轉換完成不顯示通知
    floatingIcon:        { type: 'boolean', nullable: true }, // 懸浮按鈕 enable（null = 預設開啟）
    floatingIconSize:    { type: 'number', oneOf: [16, 24, 32] }, // icon 邊長 px（16 小 / 24 中 / 32 大）
    floatingIconOpacity: { type: 'number', min: 0.1, max: 1 },
    floatingIconPos:     { type: 'object' }, // { edge, offsetY }，content script 拖移後寫入
    fourFingerGesture:   { type: 'boolean' }, // 多指觸控手勢 enable（iOS）
    touchGestureFingers: { type: 'number', oneOf: [3, 4] }, // 多指觸控手勢指數（iOS；issue #72）
    hoverTranslateModifier: { type: 'string', oneOf: ['off', 'shift', 'alt', 'ctrl'] }, // 懸停翻譯修飾鍵（issue #67）
    hoverTranslateMode:     { type: 'string', oneOf: ['single', 'dual'] }, // 懸停翻譯顯示方式（獨立於整頁 displayMode）
    iosPromoDismissed:   { type: 'boolean' }, // popup iOS 上架提示已關閉
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
    // 2026-07-08 review：之前漏列導致匯入時被默默丟掉（同 issue #48 / 批次 5-2 的同型漏列）
    instapaperEnabled:        { type: 'boolean' },
    instapaperSummaryEnabled: { type: 'boolean' },
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

  // 通用規則只驗型別的三個欄位，補內容檢查。消費端各自有防呆（讀到怪值會退回預設），這裡擋的是
  // 「匯入檔塞任意內容進同步儲存空間」：同步空間單項 8KB、總量 100KB，被佔滿後所有設定都存不進去
  if ('dualAccentColor' in clean && !/^(auto|[a-z][a-z-]{0,23}|#[0-9a-fA-F]{6})$/.test(clean.dualAccentColor.trim())) {
    warnings.push(_t('options.import.warningSkipOneOf', { key: 'dualAccentColor', value: String(clean.dualAccentColor).slice(0, 40) }));
    delete clean.dualAccentColor;
  }
  if ('floatingIconPos' in clean) {
    const fp = clean.floatingIconPos;
    const okPos = fp && !Array.isArray(fp) && (fp.edge === 'left' || fp.edge === 'right')
      && typeof fp.offsetY === 'number' && Number.isFinite(fp.offsetY) && fp.offsetY >= 0 && fp.offsetY <= 1;
    if (okPos) clean.floatingIconPos = { edge: fp.edge, offsetY: fp.offsetY };
    else { warnings.push(_t('options.import.warningSkipType', { key: 'floatingIconPos' })); delete clean.floatingIconPos; }
  }
  if ('modelPricingOverrides' in clean) {
    const src = clean.modelPricingOverrides;
    const out = {};
    if (src && !Array.isArray(src)) {
      for (const [model, ov] of Object.entries(src).slice(0, 200)) {
        if (typeof model !== 'string' || !model || model.length > 120 || !ov || typeof ov !== 'object' || Array.isArray(ov)) continue;
        const entry = {};
        for (const f of ['inputPerMTok', 'outputPerMTok', 'cachedDiscount']) {
          if (typeof ov[f] === 'number' && Number.isFinite(ov[f]) && ov[f] >= 0) entry[f] = ov[f];
        }
        if (Object.keys(entry).length > 0) out[model] = entry;
      }
    }
    clean.modelPricingOverrides = out;
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
    // 批次 5-2：applyFixedGlossary（文件翻譯是否套用固定術語表）原本漏列，匯入被默默丟掉
    if (typeof td.applyFixedGlossary === 'boolean') tdClean.applyFixedGlossary = td.applyFixedGlossary;
    else if ('applyFixedGlossary' in td) warnings.push(_t('options.import.warningSkipType', { key: 'translateDoc.applyFixedGlossary' }));
    if (typeof td.temperature === 'number' && Number.isFinite(td.temperature)
        && td.temperature >= 0 && td.temperature <= 2) {
      tdClean.temperature = td.temperature;
    } else if ('temperature' in td) warnings.push(_t('options.import.warningTransDocTemp'));
    // 2026-09-11 code review §3.7-4：文件翻譯頁另外寫進 translateDoc 的五欄原本漏列
    // （batchSize / epubParagraphSpacing / consistencyScan / epubAutoFixSpacing /
    // subtitleStripPeriod），匯入 round-trip 默默丟掉、alert 仍顯示成功
    if (typeof td.batchSize === 'number' && Number.isInteger(td.batchSize)
        && td.batchSize >= 1 && td.batchSize <= 100) {
      tdClean.batchSize = td.batchSize;
    } else if ('batchSize' in td) warnings.push(_t('options.import.warningSkipType', { key: 'translateDoc.batchSize' }));
    for (const boolKey of ['epubParagraphSpacing', 'consistencyScan', 'epubAutoFixSpacing', 'subtitleStripPeriod']) {
      if (typeof td[boolKey] === 'boolean') tdClean[boolKey] = td[boolKey];
      else if (boolKey in td) warnings.push(_t('options.import.warningSkipType', { key: `translateDoc.${boolKey}` }));
    }
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
    // 術語表獨立模型（save 在 saveSettings 的 glossary.model）。空字串代表跟隨主翻譯模型，也合法
    if (typeof gl.model === 'string') glClean.model = gl.model.trim();
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
    // v2.0.79：null = 匯出時使用者留空（請求不送 temperature），照原樣收下
    if (cp.temperature === null) cpClean.temperature = null;
    else if (typeof cp.temperature === 'number' && cp.temperature >= 0 && cp.temperature <= 2) {
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
    // thinkingLevel:enum，非法值落回 'auto'(對齊 saveSettings 的 fallback)
    if (typeof cp.thinkingLevel === 'string'
        && ['auto', 'off', 'low', 'medium', 'high'].includes(cp.thinkingLevel)) {
      cpClean.thinkingLevel = cp.thinkingLevel;
    }
    // apiFormat:enum，非法值不收（維持現值）
    if (cp.apiFormat === 'chat' || cp.apiFormat === 'responses') cpClean.apiFormat = cp.apiFormat;
    // extraBodyJson：自由字串（save 端只 trim，不在此驗 JSON 合法性，維持與 saveSettings 一致）
    if (typeof cp.extraBodyJson === 'string') cpClean.extraBodyJson = cp.extraBodyJson.trim();
    // useStrongSegMarker:boolean(預設 true，讀取走 !== false)
    if (typeof cp.useStrongSegMarker === 'boolean') cpClean.useStrongSegMarker = cp.useStrongSegMarker;
    if (Object.prototype.hasOwnProperty.call(cp, 'apiKey')) {
      warnings.push(_t('options.import.warningCpApiKey'));
    }
    // extraHeadersJson（自訂 request headers，issue #78）刻意不收：值可能是憑證，比照 apiKey
    // 不在匯入範圍——匯出檔本來就不含它，匯入檔若帶了也不寫入
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
      // bilingualMode 已於 v2.0.85 移除（字幕雙語跟隨 displayMode）；舊匯出檔的
      // ytSubtitle.bilingualMode 進 sanitize 會被略過，不再寫回
      preferOriginalTrack: { type: 'boolean' },
      captionScale:        { type: 'number', min: 50, max: 400 },
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

  // 批次 5-2：customShortcuts（自訂快速鍵三 slot 表）。匯出是 sync.get(null) 全量，
  // 匯入原本漏列 → 還原備份後自訂快速鍵整個消失且無警告。
  // 走 shortcut-utils sanitizeTable 消毒（保證三 slot key 都在、value 是合法 shortcut 或 null）。
  if ('customShortcuts' in raw) {
    const cs = raw.customShortcuts;
    if (SC && cs && typeof cs === 'object' && !Array.isArray(cs)) {
      clean.customShortcuts = SC.sanitizeTable(cs);
    } else {
      warnings.push(_t('options.import.warningSkipType', { key: 'customShortcuts' }));
    }
  }

  return { clean, warnings };
}

// 匯入時要「現值 ← 匯入值」逐欄合併的設定子物件（code review 2026-11-15 O-2）。
// 清單 = getSettings 以 `{ ...DEFAULT, ...saved }` 逐欄合併的那幾顆；陣列 / 表格型
//（translatePresets、fixedGlossary、forbiddenTerms、customShortcuts 等）維持整顆取代。
// 為什麼要合併：寫入是 storage.sync.set 整顆取代，匯入檔只帶部分欄位時，沒列到的欄位
// 會從 storage 消失、由 getSettings 補回預設值——customProvider 只帶 model 不帶 baseUrl
// 的檔會讓端點悄悄回到預設主機，而既有金鑰留著（繞過下方的 origin 防護）。
export const IMPORT_MERGE_KEYS = [
  'geminiConfig', 'pricing', 'domainRules', 'glossary',
  'ytSubtitle', 'partialMode', 'customProvider', 'translateDoc',
];

// @param {object} clean  sanitizeImport 回傳的 clean 物件
// @param {object} currentSync  目前 storage.sync 內的對應子物件（storage.sync.get(IMPORT_MERGE_KEYS) 的結果）
// @returns {object}  要寫入的物件（不改動傳入的 clean）
export function mergeImportOverCurrent(clean, currentSync) {
  const out = { ...clean };
  for (const k of IMPORT_MERGE_KEYS) {
    const incoming = clean[k];
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) continue;
    const cur = currentSync && currentSync[k];
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) out[k] = { ...cur, ...incoming };
  }
  return out;
}

const _originOf = (u) => {
  try { return new URL(String(u || '').trim()).origin; } catch { return null; }
};

// 兩個端點網址是否屬於不同 origin。任一端解析不了 → 無法證明是同一服務，保守視為不同
export function isDifferentOrigin(a, b) {
  const oa = _originOf(a);
  const ob = _originOf(b);
  if (!oa || !ob) return true;
  return oa !== ob;
}

// 2026-10-20 security review：匯入的 customProvider.baseUrl 與目前已存的 origin 不同時，
// 既有的 customProviderApiKey 必須清掉。匯入檔本來就視為不可信（apiKey 一律剝除），
// 若只換目的地不換金鑰，一份「推薦設定」JSON 就能把使用者的 Bearer key 連同頁面原文
// 導到攻擊者主機。同 origin（只改 path，例如 /v1 → /api/v1）視為同一服務，金鑰保留。
//
// 2026-11-15（O-2 / O-3）：呼叫端要傳 mergeImportOverCurrent 合併後的物件——合併後
// 「沒帶 baseUrl」才真的等於「目的地不變」。回傳 true 時呼叫端除了清金鑰，還要先跳
// 確認並顯示新網址（不論原本有沒有金鑰：端點一換，之後的頁面原文就送往新主機）。
//
// @param {string} currentBaseUrl  目前生效的 customProvider.baseUrl（storage 沒存時為預設值）
// @param {object} merged  mergeImportOverCurrent 的結果
// @returns {boolean}  true = 端點 origin 會改變
export function importChangesCustomProviderOrigin(currentBaseUrl, merged) {
  const nextBaseUrl = merged && merged.customProvider && merged.customProvider.baseUrl;
  if (typeof nextBaseUrl !== 'string') return false; // 合併後仍沒有 baseUrl = 目的地不變（維持預設）
  return isDifferentOrigin(currentBaseUrl, nextBaseUrl);
}
