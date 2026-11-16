// translate-doc/settings.js — 文件翻譯獨立 settings page（W7,2026-05-05 起）
//
// 為什麼有這頁：
//   1. 文件翻譯（PDF / 未來 Office）的 prompt 用 inline marker 協定 ⟦b⟧/⟦i⟧/⟦l:N⟧,
//      跟網頁翻譯分開，獨立 textarea 編輯空間需要大，modal 不適合
//   2. 為將來擴充 Office 格式（.docx/.xlsx/.pptx）做好結構；格式特別設定會以子
//      section 出現，共用 systemPrompt
//   3. 從 popup 設定 / options 一般設定搬出來，「文件翻譯」相關設定集中在這一頁
//
// 觸發：從 translate-doc/index.html 工具列「翻譯設定」modal 內「進階設定 →」
// 按鈕用 chrome.tabs.create 開新 tab 進來
//
// UI 風格對齊 options/options.js:自動存檔（手動儲存按鈕已移除）+ save-bar 提示條,
// 任何 input/change 觸發 markDirty → debounce 後自動 save(),頂端先顯示「儲存中」再
// 換綠條「已自動儲存」3 秒後消失。

import { browser } from '../lib/compat.js';
import { getSettings, DEFAULT_SETTINGS, DEFAULT_DOC_SYSTEM_PROMPT } from '../lib/storage.js';
import * as cache from '../lib/cache.js';
import { temperatureSupport } from '../lib/model-pricing.js';

const $ = (id) => document.getElementById(id);

const t = (key, params, fallback) => {
  const i18n = window.__SK?.i18n;
  if (i18n && typeof i18n.t === 'function') return i18n.t(key, params);
  return fallback != null ? fallback : key;
};

async function load() {
  await initI18n();
  const s = await getSettings();
  const td = s.translateDoc || DEFAULT_SETTINGS.translateDoc;
  $('td-systemPrompt').value = td.systemPrompt || DEFAULT_DOC_SYSTEM_PROMPT;
  // applyFixedGlossary 預設 true(舊使用者 saved 沒 key 時走 default)
  $('td-applyFixedGlossary').checked = td.applyFixedGlossary !== false;
  $('td-temperature').value = (typeof td.temperature === 'number' && Number.isFinite(td.temperature))
    ? td.temperature : DEFAULT_SETTINGS.translateDoc.temperature;
  _tempModels = docTemperatureModels(s);
  refreshTemperatureNote();
  // 載入完成標記乾淨狀態(避免 load 觸發 input event 把 save-bar 點起來)
  initialLoaded = true;
  hideSaveBar();
}

// ─── Temperature 欄位可用狀態（與 options.js refreshTemperatureNotes 同判準）──────
// 文件翻譯的模型 = 翻譯時選的預設組：引擎為 Gemini 的走 preset.model；引擎為自訂模型的
// 走 customProvider.model（該路徑同樣吃 translateDoc.temperature）。全部不支援 → 停用。
let _tempModels = [];
function docTemperatureModels(s) {
  const presets = Array.isArray(s.translatePresets) && s.translatePresets.length > 0
    ? s.translatePresets : DEFAULT_SETTINGS.translatePresets;
  const out = [];
  for (const p of presets) {
    if (p.engine === 'openai-compat') out.push(s.customProvider?.model || 'custom');
    else if (p.engine !== 'google') out.push(p.model || s.geminiConfig?.model);
  }
  return out;
}
function refreshTemperatureNote() {
  const input = $('td-temperature');
  const note = $('td-temperature-note');
  if (!input || !note) return;
  const { status, supported } = temperatureSupport(_tempModels);
  input.disabled = status === 'none';
  note.hidden = status === 'all';
  note.textContent = status === 'none'
    ? t('options.tempNote.none')
    : (status === 'partial' ? t('options.tempNote.partial', { models: supported.join(' / ') }) : '');
}

async function initI18n() {
  const I18N = window.__SK?.i18n;
  if (!I18N) return;
  let uiLang = 'auto';
  try {
    const stored = await chrome.storage.sync.get(['uiLanguage']);
    if (typeof stored.uiLanguage === 'string') uiLang = stored.uiLanguage;
  } catch (_) { /* fallback auto */ }
  const dictLang = I18N.getUiLanguage(uiLang);
  // 同 translate-doc/index.js:寫 window.__SK.STATE.uiLanguage 讓 t() 動態字串能讀到
  window.__SK = window.__SK || {};
  window.__SK.STATE = window.__SK.STATE || {};
  window.__SK.STATE.uiLanguage = dictLang;
  I18N.applyI18n(document, dictLang);
  I18N.subscribeUiLanguageChange((newUi) => {
    window.__SK.STATE.uiLanguage = newUi;
    I18N.applyI18n(document, newUi);
    refreshTemperatureNote();
  });
}

// 自動存檔：手動儲存按鈕已移除，任一 input/change → markDirty → debounce 後 save()。
// _saveInFlight / _savePending 防並發 read-modify-write 互蓋，並把 in-flight 期間的
// 變更補存一次（對齊 options.js 同套機制）。
let _saveInFlight = false;
let _savePending = false;
async function save() {
  if (_saveInFlight) { _savePending = true; return; }
  _saveInFlight = true;
  try {
    await _saveImpl();
    while (_savePending) {
      _savePending = false;
      await _saveImpl();
    }
  } catch (err) {
    // 寫入失敗（配額 / storage 錯誤）要讓使用者看到：原本沒接，save-bar 永遠停在「儲存中⋯」
    console.warn('[Shinkansen doc settings] save failed', err);
    showSaveBar('dirty', t('options.action.saveFailed', { error: err?.message || String(err) }));
  } finally {
    _saveInFlight = false;
  }
}

async function _saveImpl() {
  // 讀現有 settings 再 merge — 不踩到使用者其他設定
  const existing = (await browser.storage.sync.get(null)) || {};
  const td = existing.translateDoc || {};
  // temperature:空字串 / 非數字 → 退回預設,合法數字(含 0)保留
  const tempRaw = parseFloat($('td-temperature').value);
  const tempClean = (Number.isFinite(tempRaw) && tempRaw >= 0 && tempRaw <= 2)
    ? tempRaw : DEFAULT_SETTINGS.translateDoc.temperature;
  const merged = {
    ...td,
    systemPrompt: $('td-systemPrompt').value || DEFAULT_DOC_SYSTEM_PROMPT,
    // v1.8.49: 移除 auto applyGlossary toggle(改走 stage-result「先建立文章術語表」按鈕);
    // saved.applyGlossary 留在既有使用者 storage 但不再讀寫,無害 orphan
    applyFixedGlossary: $('td-applyFixedGlossary').checked,
    temperature: tempClean,
  };
  await browser.storage.sync.set({ translateDoc: merged });
  showSaveBar('saved', t('doc.settingsPage.saveBar.saved'));
}

// ─── save-bar(對齊 options.js v0.94 同套機制)──────────────────
let initialLoaded = false;
let saveBarHideTimer = null;
function showSaveBar(state, text) {
  const bar = $('save-bar');
  bar.textContent = text;
  bar.className = 'save-bar ' + state;
  bar.hidden = false;
  if (saveBarHideTimer) clearTimeout(saveBarHideTimer);
  if (state === 'saved') {
    saveBarHideTimer = setTimeout(() => { bar.hidden = true; }, 3000);
  }
}
function hideSaveBar() {
  const bar = $('save-bar');
  bar.hidden = true;
  if (saveBarHideTimer) { clearTimeout(saveBarHideTimer); saveBarHideTimer = null; }
}
let _autoSaveTimer = null;
function scheduleAutoSave() {
  if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => { _autoSaveTimer = null; save(); }, 600);
}
function markDirty() {
  if (!initialLoaded) return; // load() 階段觸發的 input 不算 dirty
  scheduleAutoSave();
  const bar = $('save-bar');
  if (bar.classList.contains('saved') && !bar.hidden) return;
  showSaveBar('dirty', t('doc.settingsPage.saveBar.dirty'));
}
document.querySelector('.container').addEventListener('input', markDirty);
document.querySelector('.container').addEventListener('change', markDirty);

$('td-reset-prompt').addEventListener('click', () => {
  $('td-systemPrompt').value = DEFAULT_DOC_SYSTEM_PROMPT;
  markDirty();
});

$('td-clear-all-cache-btn').addEventListener('click', async () => {
  if (!confirm(t('doc.settingsPage.confirm.clearAllCache'))) return;
  const status = $('td-clear-cache-status');
  try {
    const cleared = await cache.clearDocTranslationCache();
    status.textContent = t('doc.settingsPage.cache.cleared', { n: cleared });
    status.style.color = '#34c759';
    setTimeout(() => { status.textContent = ''; status.style.color = ''; }, 3000);
  } catch (err) {
    status.textContent = t('doc.settingsPage.cache.failed', { error: (err && err.message) || '' });
    status.style.color = '#ef4444';
  }
});

// 讀設定失敗時 initialLoaded 停在 false，之後所有編輯都被 markDirty 靜默丟掉（畫面看起來正常、
// 其實什麼都沒存）。不能改成照存——欄位此時是 HTML 內建預設值，存下去會蓋掉使用者原本的設定。
// 改成明講：欄位鎖住 + 顯示錯誤，請使用者重新整理
load().catch((err) => {
  console.warn('[Shinkansen doc settings] load failed', err);
  for (const el of document.querySelectorAll('.container input, .container textarea, .container select, #td-reset-prompt')) el.disabled = true;
  showSaveBar('dirty', t('doc.settingsPage.saveBar.loadFailed', { error: err?.message || String(err) }));
});
