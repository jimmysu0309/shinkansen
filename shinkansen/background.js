// background.js — Shinkansen Service Worker
// 職責：接收翻譯請求、呼叫 Gemini API、處理快取、處理快捷鍵、統一除錯 Log。

import { browser } from './lib/compat.js';
import { IS_IOS_BUILD } from './lib/distribution.js'; // Phase 2: host app 設定橋接只在 iOS build 走 native messaging
import { translateBatch, extractGlossary, extractTermRenderings, translateBatchStream, summarizeArticle } from './lib/gemini.js';
import { translateBatch as translateBatchCustom, extractGlossary as extractGlossaryCustom } from './lib/openai-compat.js'; // v1.5.7
import { translateGoogleBatch } from './lib/google-translate.js';
import { getSettings, getSettingsCached, setSettings, cleanupLegacySyncKeys, DEFAULT_SUBTITLE_SYSTEM_PROMPT, DEFAULT_ASR_SUBTITLE_SYSTEM_PROMPT, DEFAULT_DOC_SYSTEM_PROMPT, DOC_INLINE_MARKER_INSTRUCTION, getEffectiveSystemPrompt, getEffectiveSubtitleSystemPrompt, getEffectiveAsrSubtitleSystemPrompt, getEffectiveDocSystemPrompt, getEffectiveGlossaryPrompt, LANG_LABELS } from './lib/storage.js';
import { debugLog, getLogs, clearLogs, getPersistedLogs, getAnomalyLogs, clearPersistedLogs } from './lib/logger.js';
import * as cache from './lib/cache.js';
import * as usageDB from './lib/usage-db.js'; // v0.86: 用量紀錄 IndexedDB
import { getPricingForModel } from './lib/model-pricing.js';  // v1.4.12: preset 依 model 查定價
import { detectForbiddenTermLeaks } from './lib/forbidden-terms.js'; // v1.5.6
import { filterEchoPairsForCache, isSuspectEchoTranslation } from './lib/system-instruction.js'; // v2.0.52: echo 快取防護
import { checkForUpdate, markUpdateNoticeShown, localTodayKey } from './lib/update-check.js'; // v1.6.1
import { maybeWriteWelcomeNotice } from './lib/welcome-notice.js'; // v1.6.5
import { refreshExchangeRate, getCachedRate, isCacheFresh } from './lib/exchange-rate.js'; // v1.8.41
import { codedError } from './lib/bg-error.js'; // 使用者面對錯誤帶 error code 過協定，content 端查 dict 翻譯
import { saveToInstapaper, buildInstapaperPayload } from './lib/instapaper.js'; // 送到 Instapaper（Alt+I 快捷鍵路徑）
import { planStreamingPartialReuse } from './lib/stream-reuse.js'; // v1.10.61: streaming 批次 missing-only 分流
import { convertZhBatch, ZH_CONVERT_DIRECTIONS } from './lib/zh-convert.js'; // 簡繁本地互轉（OpenCC 字典，lazy load）

// instapaper-keys.js（gitignored）的 consumer 金鑰載入。
// 不能用 dynamic import()：MV3 service worker 禁止 dynamic import（實測 throw
// "import() is disallowed on ServiceWorkerGlobalScope"），這正是「popup 送得出去、
// 快捷鍵一定失敗」的根因——SW 載不到金鑰 → saveToInstapaper 回 CONFIG。
// 改用 fetch 自家檔案原始碼（SW 可 fetch 自己打包的資源）+ regex 抽兩個 hex 金鑰
//（檔案格式由我們自己的模板控制）。缺檔（fresh clone / CI）→ fetch 失敗 catch →
// 金鑰留空 → 功能停用。載入後掛 globalThis.__SK，lib/instapaper.js 的
// getInstapaperConsumerKeys() 自會讀到。
let _instapaperKeysLoaded = false;
async function ensureInstapaperKeys() {
  if (_instapaperKeysLoaded) return;
  _instapaperKeysLoaded = true;
  try {
    const url = browser.runtime.getURL('lib/instapaper-keys.js');
    const text = await (await fetch(url)).text();
    const ck = text.match(/consumerKey\s*:\s*['"]([^'"]+)['"]/);
    const cs = text.match(/consumerSecret\s*:\s*['"]([^'"]+)['"]/);
    if (ck && cs) {
      globalThis.__SK = globalThis.__SK || {};
      globalThis.__SK.INSTAPAPER_KEYS = { consumerKey: ck[1], consumerSecret: cs[1] };
    }
  } catch (_) { /* 無金鑰檔 → 功能停用 */ }
}

debugLog('info', 'system', 'service worker started', { version: browser.runtime.getManifest().version });

// v1.8.14: 一次性清掉 storage.sync 的 legacy keys（避免長期累積踩到 quota)
cleanupLegacySyncKeys();

// v1.2.11: SUBTITLE_SYSTEM_PROMPT 已移至 lib/storage.js（DEFAULT_SUBTITLE_SYSTEM_PROMPT）
// TRANSLATE_SUBTITLE_BATCH handler 從 ytSubtitle 設定讀取，不再使用硬碼常數。

// ─── 啟動時：版本檢查 ───────────────────
// v1.8.45 起版本變更不再清快取，只更新標記。讓累積翻譯跨版本保留（避免每次 bump 都
// 重打 API)；若 prompt / 行為大改要清，使用者用 popup「清除快取」手動觸發。
(async () => {
  const currentVersion = browser.runtime.getManifest().version;
  const result = await cache.checkVersionAndClear(currentVersion);
  if (result.changed) {
    debugLog('info', 'cache', 'version mark updated (cache preserved across version changes)', {
      oldVersion: result.oldVersion ?? '?',
      newVersion: currentVersion,
    });
  } else {
    debugLog('info', 'cache', 'cache up-to-date', { version: currentVersion });
  }
})();

// ─── v1.6.1: GitHub Releases 更新檢查 ────────────────────────
// 三層觸發確保使用快速鍵不開 popup 的使用者也能即時看到新版提示：
//   1. SW 第一次喚醒 fire-and-forget（最早可跑的時機）
//   2. chrome.runtime.onStartup（Chrome 啟動時）
//   3. chrome.alarms 'update-check' 24h 定時（Chrome 一直開著的備援）
// CWS 安裝（installType='normal'）會在 update-check.js 內被跳過，不會打 GitHub API。
checkForUpdate().catch(err => debugLog('warn', 'update-check', 'initial check failed', { error: err.message }));

browser.runtime.onStartup?.addListener(() => {
  checkForUpdate().catch(err => debugLog('warn', 'update-check', 'onStartup check failed', { error: err.message }));
});

// ─── 單一 onAlarm dispatcher（name → handler map）─────────────────────
// 各 alarm 不再各自 addListener；改往 _alarmHandlers 註冊一筆 handler，由下方唯一的
// onAlarm listener 依 alarm.name 分派。新增 alarm 只要 _registerAlarm 一行，避免分散
// 註冊難追、未來漏接。淨行為與原本多個 name-filter listener 完全相同。
const _alarmHandlers = Object.create(null);
function _registerAlarm(name, handler) { _alarmHandlers[name] = handler; }
try {
  browser.alarms?.onAlarm.addListener((alarm) => {
    const handler = alarm && _alarmHandlers[alarm.name];
    if (handler) handler(alarm);
  });
} catch (_) { /* alarms 不可用環境 */ }

browser.alarms?.create('update-check', { periodInMinutes: 60 * 24 });
_registerAlarm('update-check', () => {
  checkForUpdate().catch(err => debugLog('warn', 'update-check', 'alarm check failed', { error: err.message }));
});

// ─── v1.8.41:USD ↔ TWD 匯率每日更新 ─────────────────────
// 設計同 update-check：三層觸發確保 cache 不會永遠 stale。
//   1. SW 第一次喚醒 fire-and-forget（但 cache 還新鮮就 skip，避免每次 SW 喚醒就打 API)
//   2. chrome.runtime.onStartup
//   3. chrome.alarms 'exchange-rate-fetch' 24h 定時
// 失敗一律靜默（refreshExchangeRate 內回 null 不動 storage)，呼叫端走 cached 或 fallback 31.6。
isCacheFresh().then(fresh => {
  if (!fresh) {
    refreshExchangeRate().catch(err => debugLog('warn', 'exchange-rate', 'initial fetch failed', { error: err.message }));
  }
});

browser.runtime.onStartup?.addListener(() => {
  refreshExchangeRate().catch(err => debugLog('warn', 'exchange-rate', 'onStartup fetch failed', { error: err.message }));
});

browser.alarms?.create('exchange-rate-fetch', { periodInMinutes: 60 * 24 });
_registerAlarm('exchange-rate-fetch', () => {
  refreshExchangeRate().catch(err => debugLog('warn', 'exchange-rate', 'alarm fetch failed', { error: err.message }));
});

// ─── Phase 2（SPEC-PRIVATE §26.12）：iOS host app 設定橋接 ─────────────────
// iOS Safari 下，host app（WKWebView）寫不進 extension 的 storage。host app 把
// 使用者在 onboarding / 設定畫面選的 API Key + 預設模型寫進「App Group 共享
// UserDefaults」，這裡用 browser.runtime.sendNativeMessage 經 native handler
// （SafariWebExtensionHandler，跑在 appex、讀得到同一個 App Group）拉回，套用進
// extension 自己的 storage。
//
// 單一資料源（CLAUDE.md §5）：host 每次存遞增 hostSettingsSeq；這裡記 consumedSeq，
// 只在 seq > consumedSeq 時套用一次 → 已消費的不重套、host 新存的會贏、使用者中途
// 在 options 改的不被舊 pending 蓋。host 為「寫入來源」，不反向覆蓋 options 的後續改動。
//
// 「預設模型」對映：四指 tap / Alt+S / 工具列按鈕全走 translatePresets slot 2，
// 所以把選的 engine+model 寫進 slot 2 那組 preset（不是切 autoTranslateSlot）。
const HOST_MODEL_PRESETS = {
  flash:  { engine: 'gemini', model: 'gemini-3-flash-preview' },
  lite:   { engine: 'gemini', model: 'gemini-3.1-flash-lite' },
  google: { engine: 'google', model: null },
};

// sendNativeMessage 跨瀏覽器簽名不一（Chrome callback、部分回 Promise），統一包成 Promise。
function sendNativeMessageAsync(appId, msg) {
  return new Promise((resolve, reject) => {
    try {
      const ret = browser.runtime.sendNativeMessage(appId, msg, (r) => {
        const err = browser.runtime.lastError;
        if (err) reject(new Error(err.message || 'native messaging error'));
        else resolve(r);
      });
      if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
    } catch (e) { reject(e); }
  });
}

async function pullHostSettings(trigger) {
  if (!IS_IOS_BUILD) return;                                   // 桌面 / 非 iOS build 不走
  if (!browser.runtime || typeof browser.runtime.sendNativeMessage !== 'function') return;
  let resp;
  try {
    resp = await sendNativeMessageAsync('app.shinkansen.ios', { action: 'pullHostSettings' });
  } catch (e) {
    debugLog('warn', 'host-settings', 'native pull failed', { trigger, error: e.message });
    return;
  }
  if (!resp || typeof resp !== 'object') return;
  const seq = Number(resp.seq) || 0;
  if (seq <= 0) return;                                        // host 還沒存過任何設定
  const { hostSettingsConsumedSeq = 0 } = await browser.storage.local.get('hostSettingsConsumedSeq');
  if (seq <= hostSettingsConsumedSeq) return;                  // 已消費 / 無新設定

  const patch = {};
  if (typeof resp.apiKey === 'string' && resp.apiKey.length > 0) patch.apiKey = resp.apiKey;
  const presetCfg = HOST_MODEL_PRESETS[resp.model];
  if (presetCfg) {
    const settings = await getSettings();
    const presets = Array.isArray(settings.translatePresets)
      ? settings.translatePresets.map(p => ({ ...p }))
      : null;
    const idx = presets ? presets.findIndex(p => p && p.slot === 2) : -1;
    if (idx >= 0) {
      presets[idx].engine = presetCfg.engine;
      presets[idx].model = presetCfg.model;
      patch.translatePresets = presets;
    }
  }
  if (Object.keys(patch).length > 0) {
    await setSettings(patch);
    debugLog('info', 'host-settings', 'applied', { trigger, seq, hasKey: !!patch.apiKey, model: resp.model || null });
  }
  await browser.storage.local.set({ hostSettingsConsumedSeq: seq });
}

// ─── 反向：extension 真值 → App Group（host app 設定畫面回填用）─────────────
// 問題（單一資料源 §5）：host app 的「API Key 與預設模型設定」畫面原本只讀 host 自己
// 寫過的 hostApiKey/hostModel，那份是「host 上次推了什麼」而非 extension 目前真正在用的值。
// 使用者若在擴充功能 options 改過、或 onboarding 被略過，畫面就顯示空白 / 舊值 →
// 一按儲存可能把現值（尤其預設模型，無「空不覆寫」防護）覆寫掉 → 設定被清除。
// 修法：extension 主動把現值推進 App Group 的 extApiKey/extModel（與 host* 分開的 key,
// 不碰 seq → 不觸發 pull,無迴圈）；ViewController.sendSettingsToPage 優先讀 ext*。
//
// 「預設模型」反向對映：slot 2（四指 tap / Alt+S / 工具列按鈕共用）的 engine+model → host
// 三選一 token。自訂引擎 / 無法用三選一表示時回 ''（host 端清掉 extModel、fallback host*）。
function extModelToken(settings) {
  const presets = Array.isArray(settings.translatePresets) ? settings.translatePresets : [];
  const p = presets.find((x) => x && x.slot === 2);
  if (!p) return '';
  if (p.engine === 'google') return 'google';
  if (p.engine === 'gemini') {
    return (typeof p.model === 'string' && p.model.includes('lite')) ? 'lite' : 'flash';
  }
  return '';
}

async function pushExtSettings(trigger) {
  if (!IS_IOS_BUILD) return;                                   // 桌面 / 非 iOS build 不走
  if (!browser.runtime || typeof browser.runtime.sendNativeMessage !== 'function') return;
  try {
    const settings = await getSettings();
    const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey : '';  // 真值（含空字串=已清空）
    const model = extModelToken(settings);
    await sendNativeMessageAsync('app.shinkansen.ios', { action: 'pushExtSettings', apiKey, model });
    debugLog('info', 'host-settings', 'pushed ext settings to App Group', { trigger, hasKey: !!apiKey, model: model || null });
  } catch (e) {
    debugLog('warn', 'host-settings', 'native push failed', { trigger, error: e.message });
  }
}

// 觸發點：SW/event page 冷啟動、onStartup、onInstalled、content script 載入送的 PULL_HOST_SETTINGS。
pullHostSettings('sw-init');
pushExtSettings('sw-init');                                    // 啟動就把現值同步給 host
browser.runtime.onStartup?.addListener(() => { pullHostSettings('onStartup'); pushExtSettings('onStartup'); });
browser.runtime.onInstalled.addListener(() => { pullHostSettings('onInstalled'); });
browser.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'PULL_HOST_SETTINGS') {
    pullHostSettings('content-init');
    pushExtSettings('content-init');   // 同條 content-init 路徑也把現值推回 host(見下方 reliability 註解)
  }
  // fire-and-forget，不回 response → 不 return true
});

// apiKey（storage.local）/ translatePresets（storage.sync）一變動就把現值推給 host,
// 讓設定畫面隨時讀得到 extension 真值。只在 iOS build 註冊（其他平台無 host app）。
//
// ⚠️ 但 iOS Safari 的 background 是 event page（v1.10.24 起,非持久 SW),閒置會卸載。
// 使用者在擴充功能 options 改 Key / 模型時 event page 可能正在睡 → 此 onChanged 收不到 →
// push 沒跑 → extModel 沒更新 → host 設定畫面 fallback 到過時的 hostModel（onboarding 略過
// Key 時寫的 'google'）→ 顯示錯誤的預設翻譯方式。所以「真正可靠」的觸發是上面 content-init
// 那條（content-touch.js 每次頁面載入送 PULL_HOST_SETTINGS,pull 已驗證會喚醒 event page,
// push 搭同一條等效可靠）。這個 onChanged 只當 event page 醒著時的即時補強,不是唯一依賴。
if (IS_IOS_BUILD) {
  browser.storage.onChanged.addListener((changes, area) => {
    if ((area === 'local' && 'apiKey' in changes) ||
        (area === 'sync' && 'translatePresets' in changes)) {
      pushExtSettings('storage-changed');
    }
  });
}

// 累計用量（grand total）由 IndexedDB usage-db.js 透過 QUERY_USAGE_STATS 提供。
// 不再額外維護 storage.local 累計欄位，避免與明細紀錄 drift。

function computeCostUSD(inputTokens, outputTokens, pricing) {
  const inRate = Number(pricing?.inputPerMTok) || 0;
  const outRate = Number(pricing?.outputPerMTok) || 0;
  return (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate;
}

/**
 * v0.48: 計算套用 implicit / explicit context cache 折扣後的實付費用。
 * v1.8.20: 改成可注入折扣比例（cachedRate = cache 命中部分相對全價的比例）。
 * v1.9.2: 預設 fallback rate 從 0.25 改 0.10——Gemini 2.5+ 起 implicit cache 是 90% off
 *         (命中部分付 10%),不再是 2.0 時代的 75% off;且新 caller 一律從 settings 帶
 *         明確 cachedDiscount,fallback 只給「沒帶值」的舊 caller 用,給 Gemini 現實值
 *         比 OpenAI 舊 50% 中間值更實用。
 *
 * 公式：effectiveInput = (inputTokens - cachedTokens) + cachedTokens × cachedRate
 */
function computeBilledCostUSD(inputTokens, cachedTokens, outputTokens, pricing, cachedRate) {
  const rate = (typeof cachedRate === 'number' && cachedRate >= 0 && cachedRate <= 1)
    ? cachedRate
    : 0.10; // 預設 Gemini 2.5+ 90% off
  const uncached = Math.max(0, inputTokens - cachedTokens);
  const effectiveInput = uncached + cachedTokens * rate;
  return computeCostUSD(effectiveInput, outputTokens, pricing);
}

/**
 * v1.9.2: 從 pricing 物件取出 cache 命中部分相對全價的比例。
 * pricing.cachedDiscount(0-1,命中省下的比例)→ rate = 1 - discount。
 * 沒填 / 不合法 → 回 null,呼叫端決定 fallback。
 *
 * @param {object|null} pricing
 * @returns {number|null}
 */
function pricingToCachedRate(pricing) {
  const d = Number(pricing?.cachedDiscount);
  if (!Number.isFinite(d) || d < 0 || d > 1) return null;
  return 1 - d;
}

/**
 * v1.8.20: 依自訂 Provider baseUrl 推斷 cache 命中折扣比例,作為 customProvider.cachedDiscount
 *         沒填時的二級 fallback。
 * v1.9.2: 數值對齊 2026-05 各家現況——OpenAI 新世代(GPT-5+)up to 90% off、
 *         DeepSeek 約 98% off、xAI 75-90%、Claude 90%。
 * 由 baseUrl 簡單字串判斷,使用者用 OpenRouter 等 aggregator 時走預設 0.5 中間值。
 *
 * @param {string} baseUrl
 * @returns {number} cache 命中部分相對全價的比例（0-1)
 */
function getCustomCacheHitRate(baseUrl) {
  const url = String(baseUrl || '').toLowerCase();
  if (url.includes('anthropic.com')) return 0.10;        // Claude read 90% off
  if (url.includes('openai.com')) return 0.10;            // OpenAI 新世代(GPT-5+) up to 90% off
  if (url.includes('deepseek.com')) return 0.02;          // DeepSeek context cache hit ~98% off
  if (url.includes('x.ai')) return 0.20;                  // xAI Grok ~80% off(因 model 而異)
  return 0.50;                                            // 未知 provider 中間值
}

/**
 * v1.9.2: customProvider 路徑 cache 命中比例查找順序:
 *   1. customProvider.cachedDiscount 合法 → 用使用者設定
 *   2. fallback baseUrl 自動推導(getCustomCacheHitRate)
 *
 * @param {object} cp customProvider 設定物件
 * @returns {number} cache 命中部分相對全價的比例（0-1)
 */
function resolveCustomProviderCachedRate(cp) {
  const fromSettings = pricingToCachedRate(cp);
  if (fromSettings !== null) return fromSettings;
  return getCustomCacheHitRate(cp?.baseUrl);
}

function buildFixedGlossaryEntries(fixedGlossary, sender) {
  if (!fixedGlossary) return null;
  const globalEntries = Array.isArray(fixedGlossary.global)
    ? fixedGlossary.global.filter((e) => e.source && e.target)
    : [];
  let domainEntries = [];
  if (fixedGlossary.byDomain && sender?.tab?.url) {
    try {
      const hostname = new URL(sender.tab.url).hostname;
      domainEntries = Array.isArray(fixedGlossary.byDomain[hostname])
        ? fixedGlossary.byDomain[hostname].filter((e) => e.source && e.target)
        : [];
    } catch { /* invalid URL */ }
  }
  if (globalEntries.length === 0 && domainEntries.length === 0) return null;
  const merged = new Map();
  for (const entry of globalEntries) merged.set(entry.source, entry.target);
  for (const entry of domainEntries) merged.set(entry.source, entry.target);
  return [...merged.entries()].map(([source, target]) => ({ source, target }));
}

function preferArticleGlossaryEntries(fixedGlossaryEntries, articleGlossary, enabled) {
  if (!enabled
      || !Array.isArray(articleGlossary) || articleGlossary.length === 0
      || !Array.isArray(fixedGlossaryEntries) || fixedGlossaryEntries.length === 0) {
    return fixedGlossaryEntries;
  }
  const articleSources = new Set(articleGlossary.map((entry) => entry.source));
  const filtered = fixedGlossaryEntries.filter((entry) => !articleSources.has(entry.source));
  return filtered.length > 0 ? filtered : null;
}

// 三條翻譯路徑（handleTranslate / handleTranslateStream / handleTranslateCustom）共用的
// cache key suffix 組裝單一資料源。組裝規則：
//   cacheTag（'_yt' / '_doc' / '_oc' 等，呼叫端明確指定）
//   + '_g<hash12>'（有 glossary 時；+= 附加不可 = 覆蓋，覆蓋會把 cacheTag 吃掉 →
//     _doc 清快取漏清、_yt 撞網頁 key）
//   + '_b<hash>'（forbiddenTerms 非空時；使用者改清單後既有快取自動失效）
//   + '_m<modelKeyPart>'（同段文字在不同 model 之間不共用快取；Gemini 路徑傳
//     sanitized model 字串，custom 路徑傳 baseUrlHash_safeModel 避免不同 provider
//     同 model name 撞 key）
//   + '_lang<tl>'（targetLanguage 非 zh-TW 時；zh-TW 不加維持向下相容）
//   + '_t<temp>'（docTemperature 為有限數值時；只有文件翻譯路徑傳入，讓使用者改
//     文件獨立 temperature 後立即生效，網頁／字幕路徑不加避免 cache 多分裂）
//   + '_x<hash12>'（docExtraPrompt 非空時；只有文件翻譯路徑傳入——本文件額外翻譯
//     指令改動後既有快取自動失效，清空回沒有額外指令的原 key，舊快取直接可用）
async function buildCacheKeySuffix({
  cacheTag = '',
  glossary = null,
  fixedGlossaryEntries = null,
  forbiddenTermsList = [],
  modelKeyPart = 'unknown',
  targetLanguage = '',
  docTemperature = undefined,
  docExtraPrompt = '',
}) {
  let suffix = cacheTag;
  const allGlossaryForHash = [
    ...(glossary || []).map((e) => `${e.source}:${e.target}`),
    ...(fixedGlossaryEntries || []).map((e) => `F:${e.source}:${e.target}`),
  ];
  if (allGlossaryForHash.length > 0) {
    const fullHash = await cache.hashText(allGlossaryForHash.join('|'));
    suffix += '_g' + fullHash.slice(0, 12);
  }
  const forbiddenHash = await cache.hashForbiddenTerms(forbiddenTermsList);
  if (forbiddenHash) {
    suffix += '_b' + forbiddenHash;
  }
  suffix += '_m' + modelKeyPart;
  if (targetLanguage && targetLanguage !== 'zh-TW') {
    suffix += '_lang' + targetLanguage.replace(/[^a-z0-9]/gi, '');
  }
  if (typeof docTemperature === 'number' && Number.isFinite(docTemperature)) {
    suffix += '_t' + docTemperature.toFixed(2);
  }
  if (typeof docExtraPrompt === 'string' && docExtraPrompt.trim()) {
    suffix += '_x' + (await cache.hashText(docExtraPrompt.trim())).slice(0, 12);
  }
  return suffix;
}

// 本文件額外翻譯指令（2026-07-27）：translate-doc 隨 payload 送的 per-document
// 補充 prompt。trim 後回空字串 = 沒有額外指令（prompt 組裝與 cache key 都不動）
function docExtraPromptOf(payload) {
  const p = payload?.extraPrompt;
  return (typeof p === 'string') ? p.trim() : '';
}

// ─── Extension icon badge（已翻譯紅點提示） ─────────────────
// 使用浮世繪圖示上的旭日紅 #cf3a2c，視覺上延續「太陽」的意象。
const BADGE_COLOR = '#cf3a2c';
const BADGE_TEXT = '●';

async function setTranslatedBadge(tabId) {
  if (tabId == null) return;
  try {
    await browser.action.setBadgeBackgroundColor({ color: BADGE_COLOR, tabId });
    // 某些 Chrome 版本支援白色 badge 文字，舊版本會忽略此呼叫
    if (browser.action.setBadgeTextColor) {
      await browser.action.setBadgeTextColor({ color: '#ffffff', tabId });
    }
    await browser.action.setBadgeText({ text: BADGE_TEXT, tabId });
  } catch (err) {
    debugLog('warn', 'system', 'setBadge failed', { error: err.message });
  }
}

async function clearTranslatedBadge(tabId) {
  if (tabId == null) return;
  try {
    await browser.action.setBadgeText({ text: '', tabId });
  } catch (err) {
    debugLog('warn', 'system', 'clearBadge failed', { error: err.message });
  }
}

// 分頁重新導航時自動清掉 badge(SPA 同站導航除外，需依賴 content.js 重新通知）
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    clearTranslatedBadge(tabId);
  }
});

// ─── v1.4.11 跨 tab sticky 翻譯（v1.4.12 改存 preset slot；v1.8.24 改用 webNavigation） ──────────
// 使用者在 tab A 按任一 preset 快速鍵翻譯後，從 A 點連結開到 tab B 會自動翻譯，
// 跟著「實際的連結點擊」傳遞。Cmd+T 後手動打網址 / bookmark / 外部 app 開啟不繼承。
// 每個 tab 記錄自己當時用的 preset slot（1/2/3），新 tab 繼承相同 slot——
// 尊重使用者當時按的引擎+模型（Flash / Flash Lite / Google MT 各自繼承）。
// 按任意 preset 快速鍵在已翻譯狀態 → restorePage → STICKY_CLEAR 只清當前 tab。
// 持久化於 chrome.storage.session，service worker 休眠重啟後仍保留。
//
// v1.8.24: 從 `tabs.onCreated.openerTabId` 改用 `webNavigation.onCreatedNavigationTarget`。
// 原本的 onCreated 路徑誤以為 Cmd+T 開的新 tab 會有 openerTabId == null，但現代
// Chrome 對 Cmd+T 也會把 openerTabId 設為當下 active tab（受 tab grouping / new-tab
// placement 影響），加上 `chrome.tabs.create({})` 從 extension API 開的也會帶 opener，
// 結果任何被 Chrome 設了 openerTabId 的新 tab 都會誤繼承 sticky slot。
// onCreatedNavigationTarget 是 Chrome 專為「使用者點連結造成新 tab」設計的精準事件——
// 只 fire 在 target=_blank / middle-click / Cmd+click / window.open，不 fire 在
// Cmd+T → 打網址 / bookmark / 外部 app / 程式化 tabs.create，剛好對應 v1.4.11 的設計意圖。

const stickyTabs = new Map(); // tabId → slot (number)
let _stickyHydratingPromise = null;

// v1.5.4: storage.session 是 Chrome 102+ / Firefox 129+ 才有的 in-memory storage。
// 舊版 Firefox（< 129）沒有此 API → fallback 到 storage.local（會 disk-persist，
// 但 onCreated/onRemoved listener 會自動同步，stale 資料風險可接受）。
// Chrome 端 storage.session 一定存在 → 行為跟修改前完全一致，效能 0 影響。
const _stickyStorage = (browser.storage && browser.storage.session) ?? browser.storage.local;

// v1.6.19: 用 promise lock 取代 boolean flag——舊版在 `_stickyHydrated = true`
// 與 `await storage.get` 之間第二個 caller 直接 return，但 Map 還空，結果
// 後續 onCreated 拿不到 sticky slot。改成共用同一個 in-flight promise,
// 所有並行 caller 都等到 Map 真正填好。
function hydrateStickyTabs() {
  if (_stickyHydratingPromise) return _stickyHydratingPromise;
  _stickyHydratingPromise = (async () => {
    try {
      const { stickyTabs: saved } = await _stickyStorage.get('stickyTabs');
      if (saved && typeof saved === 'object') {
        for (const [tabId, slot] of Object.entries(saved)) {
          // v1.4.12 前的舊值是 'gemini'/'google' 字串，重啟後忽略舊格式避免誤觸發
          if (typeof slot === 'number') stickyTabs.set(Number(tabId), slot);
        }
      }
    } catch (err) {
      debugLog('warn', 'system', 'hydrateStickyTabs failed', { error: err.message });
    }
  })();
  return _stickyHydratingPromise;
}

async function persistStickyTabs() {
  try {
    const obj = {};
    stickyTabs.forEach((slot, tabId) => { obj[tabId] = slot; });
    await _stickyStorage.set({ stickyTabs: obj });
  } catch (err) {
    debugLog('warn', 'system', 'persistStickyTabs failed', { error: err.message });
  }
}

// v1.8.24: 用 webNavigation.onCreatedNavigationTarget 取代 tabs.onCreated。
// Firefox 同樣支援這個 API（webNavigation polyfill 在 lib/compat.js 有 fallback 處理）。
if (browser.webNavigation && browser.webNavigation.onCreatedNavigationTarget) {
  browser.webNavigation.onCreatedNavigationTarget.addListener(async (details) => {
    await hydrateStickyTabs();
    const sourceTabId = details.sourceTabId;
    const newTabId = details.tabId;
    if (sourceTabId == null || newTabId == null) return;
    const slot = stickyTabs.get(sourceTabId);
    if (slot == null) return;
    stickyTabs.set(newTabId, slot);
    await persistStickyTabs();
    debugLog('info', 'system', 'sticky inherited from link-opened new tab', {
      newTabId, sourceTabId, slot, url: details.url,
    });
  });
} else {
  debugLog('warn', 'system', 'webNavigation.onCreatedNavigationTarget unavailable, cross-tab sticky disabled', {});
}

browser.tabs.onRemoved.addListener(async (tabId) => {
  // SW 重啟後 in-memory Map 是空的，不先 hydrate 就 has() 檢查會永遠 early return,
  // storage 內的 entry 清不掉（Firefox storage.local fallback 時 entry 跨重啟持久，
  // 重啟後 tab ID 重配可能對到無關新 tab → 誤觸發自動翻譯）。
  await hydrateStickyTabs();
  if (!stickyTabs.has(tabId)) return;
  stickyTabs.delete(tabId);
  await persistStickyTabs();
});

// commit 4a 抽出：YouTube 跟 Drive 影片 ASR 都走 D' 模式（LLM 自由合句 + 時間戳對齊）,
// 邏輯一致只差 cacheTag（避免 YouTube / Drive cache 互打）與 log namespace。
async function _handleAsrSubtitleBatch(payload, sender, cacheTag, namespace) {
  const _tReceived = Date.now();
  const s = await getSettings();
  const _settingsMs = Date.now() - _tReceived;
  debugLog('info', namespace, 'asr subtitle batch received', {
    inputBytes: payload?.texts?.[0]?.length || 0,
    settingsMs: _settingsMs,
  });
  const yt = s.ytSubtitle || {};
  const geminiOverrides = {
    // ASR 模式不沿用使用者自訂的 ytSubtitle.systemPrompt（那是逐條翻譯版本，規則不適用 ASR JSON 模式）
    // P1: 依 target 切 universal/zh-TW prompt(zh-TW 走原 DEFAULT,其他走 UNIVERSAL 注入後)
    systemInstruction: getEffectiveAsrSubtitleSystemPrompt(s.targetLanguage, payload?.sourceLanguage || 'en'),
    // ASR 合句需要一點推理，但翻譯仍應穩定；沿用 ytSubtitle.temperature
    temperature: yt.temperature ?? 0.1,
  };
  if (yt.model) geminiOverrides.model = yt.model;
  const pricingOverride = (yt.pricing && yt.pricing.inputPerMTok != null) ? yt.pricing : null;
  // ASR 路徑不套用固定術語表 / 黑名單（ASR prompt 已內含禁用詞規則，且 JSON 包裝增加術語注入難度）
  return handleTranslate(payload, sender, geminiOverrides, pricingOverride, cacheTag,
    false, false);
}

// v2.0.53:文件翻譯批次的 fetch 逾時（TRANSLATE_DOC_BATCH* 兩個 handler 共用）。
// 網頁翻譯的 15s 假設（gemini.js FETCH_TIMEOUT_MS）對「每批可達 50 段長文」不成立,
// 詳見兩個 handler 內的註解
const DOC_FETCH_TIMEOUT_MS = 120_000;

// ─── 訊息路由（handler map 取代 if-else 鏈） ──────────────────
const messageHandlers = {
  // DEBUG: 給 Debug Bridge 觸發 hot reload(讀取磁碟最新 unpacked extension code)。
  // 之後內容腳本會在下次頁面載入時以新 code 重新注入。SW 自身會在呼叫後立即重啟，
  // 故無法 sendResponse;Bridge 端視為 fire-and-forget。
  RELOAD_EXTENSION: {
    async: false,
    handler: () => {
      setTimeout(() => { try { browser.runtime.reload(); } catch (_) {} }, 50);
      return { ok: true, reloading: true };
    },
  },
  // 懸浮按鈕長按選單的「功能選單」（Safari 路徑）：content script 不能在網頁裡 iframe 載入
  // 擴充頁（Safari 已知限制，iOS 上會整頁 refresh），改由 background 開原生工具列 popup
  // （browser.action.openPopup()，Safari 16+ / Chrome 支援）。openPopup 不支援 / 失敗時退而
  // 開新分頁載入 popup.html。皆無 iframe → 不 refresh。content-floating-icon.js 只在 Safari
  // runtime 走這條（非 Safari 維持頁內 iframe 浮層）。
  OPEN_FEATURE_MENU: {
    async: true,
    handler: async () => {
      const action = browser.action || browser.browserAction;
      if (action && typeof action.openPopup === 'function') {
        try {
          await action.openPopup();
          return { opened: 'popup' };
        } catch (_e) { /* openPopup 不支援 / 需手勢失敗 → fall through 開新分頁 */ }
      }
      await browser.tabs.create({ url: browser.runtime.getURL('popup/popup.html') });
      return { opened: 'tab' };
    },
  },
  // 簡繁本地互轉:content 端把偵測為「相反中文變體」的段落送來,走 OpenCC 字典
  // Trie 轉換,不打任何 API、不寫 tc_ 快取(即時免費,不佔快取池)。字典於首次
  // 呼叫時 lazy fetch(lib/zh-convert.js),之後同 SW 生命週期內重用。
  CONVERT_ZH_LOCAL: {
    async: true,
    handler: async (payload) => {
      const texts = Array.isArray(payload?.texts) ? payload.texts : [];
      const direction = payload?.direction;
      if (!ZH_CONVERT_DIRECTIONS.includes(direction)) {
        // 協定層防呆(自家 content 端才會送這個訊息,方向錯誤 = 程式 bug,非使用者
        // 可見情境)。訊息用英文:jest bg-error-i18n forcing function 禁背景檔
        // throw 硬編中文(使用者面對中文錯誤必須走 codedError 協定)
        throw new Error(`CONVERT_ZH_LOCAL: unknown direction ${direction}`);
      }
      if (texts.length === 0) return { result: [] };
      const t0 = Date.now();
      const result = await convertZhBatch(texts, direction);
      debugLog('info', 'translate', 'CONVERT_ZH_LOCAL done', {
        count: texts.length, direction, elapsed: Date.now() - t0,
      });
      return { result };
    },
  },
  TRANSLATE_BATCH: {
    async: true,
    handler: (payload, sender) => {
      // v1.4.12: preset 快速鍵可傳 modelOverride 覆蓋 geminiConfig.model，
      // 其他欄位（prompt、temperature）沿用全域設定。沿用既有 geminiOverrides 機制。
      const overrides = payload?.modelOverride ? { model: payload.modelOverride } : {};
      return handleTranslate(payload, sender, overrides);
    },
  },
  // v1.8.0: Streaming 版翻譯，只給 content.js translateUnits 內 batch 0 用。
  // async: false——立刻回 ack,fire-and-forget streaming；結果透過 tabs.sendMessage
  // 推回 sender tab(STREAMING_FIRST_CHUNK / STREAMING_SEGMENT / STREAMING_DONE / STREAMING_ERROR / STREAMING_ABORTED)
  TRANSLATE_BATCH_STREAM: {
    async: false,
    handler: (payload, sender) => {
      const tabId = sender?.tab?.id;
      if (!tabId) return { ok: false, error: 'no tab' };
      const streamId = payload?.streamId;
      if (!streamId) return { ok: false, error: 'no streamId' };
      // fire-and-forget — streaming 內部用 tabs.sendMessage 推結果
      handleTranslateStream(payload, sender, streamId, tabId).catch((err) => {
        debugLog('error', 'system', 'TRANSLATE_BATCH_STREAM uncaught', { streamId, error: err?.message || String(err) });
        browser.tabs.sendMessage(tabId, {
          type: 'STREAMING_ERROR',
          payload: { streamId, ...errorFields(err), atSegment: 0 },
        }).catch(() => {});
      });
      return { started: true };
    },
  },
  // v1.8.9: Streaming 版人工字幕 batch 0 翻譯。
  // 跟 TRANSLATE_BATCH_STREAM 共用同一條 streaming pipeline(handleTranslateStream),
  // 但帶 ytSubtitle.systemPrompt / temperature / model / pricing,cacheTag '_yt',
  // 預設不套用固定術語表 / 黑名單（跟 TRANSLATE_SUBTITLE_BATCH 對齊）。
  TRANSLATE_SUBTITLE_BATCH_STREAM: {
    async: false,
    handler: (payload, sender) => {
      const tabId = sender?.tab?.id;
      if (!tabId) return { ok: false, error: 'no tab' };
      const streamId = payload?.streamId;
      if (!streamId) return { ok: false, error: 'no streamId' };
      // fire-and-forget — getSettings 在 handleTranslateStream 內會再讀一次
      (async () => {
        const s = await getSettings();
        const yt = s.ytSubtitle || {};
        const geminiOverrides = {
          // P1: 依 target 切 universal/zh-TW;使用者自訂(yt.systemPrompt)不為空且非預設視為客製,直接走 saved
          systemInstruction: getEffectiveSubtitleSystemPrompt(s.targetLanguage, yt.systemPrompt),
          temperature: yt.temperature ?? 0.1,
        };
        if (yt.model) geminiOverrides.model = yt.model;
        const pricingOverride = (yt.pricing && yt.pricing.inputPerMTok != null) ? yt.pricing : null;
        await handleTranslateStream(payload, sender, streamId, tabId, {
          cacheTag: '_yt',
          geminiOverrides,
          pricingOverride,
          applyFixedGlossary: yt.applyFixedGlossary === true,
          applyForbiddenTerms: yt.applyForbiddenTerms === true,
        });
      })().catch((err) => {
        debugLog('error', 'system', 'TRANSLATE_SUBTITLE_BATCH_STREAM uncaught', { streamId, error: err?.message || String(err) });
        browser.tabs.sendMessage(tabId, {
          type: 'STREAMING_ERROR',
          payload: { streamId, ...errorFields(err), atSegment: 0 },
        }).catch(() => {});
      });
      return { started: true };
    },
  },
  // v1.8.0: 中斷 in-flight streaming（使用者取消翻譯時觸發）
  STREAMING_ABORT: {
    async: false,
    handler: (payload) => {
      const streamId = payload?.streamId;
      if (!streamId) return { aborted: false };
      const ac = inFlightStreams.get(streamId);
      if (ac) {
        try { ac.abort(); } catch (_) { /* swallow */ }
        inFlightStreams.delete(streamId);
        return { aborted: true };
      }
      return { aborted: false };
    },
  },
  // v1.2.10: 字幕翻譯專用——prompt / temperature / model 從 ytSubtitle 設定讀取（v1.2.11 改為動態載入）
  // v1.2.39: 支援 ytSubtitle.model（獨立模型）與 ytSubtitle.pricing（獨立計價）
  TRANSLATE_SUBTITLE_BATCH: {
    async: true,
    handler: async (payload, sender) => {
      // v1.2.51: 記錄 handler 收到訊息到真正呼叫 Gemini 的前置耗時
      // 包含：getSettings() + cache lookup
      // 對照 api: translateBatch start 即可計算前置耗時
      const _tReceived = Date.now();
      const s = await getSettings();
      const _settingsMs = Date.now() - _tReceived;
      debugLog('info', 'youtube', 'subtitle batch received', {
        count: payload?.texts?.length || 0,
        settingsMs: _settingsMs,   // getSettings() 耗時（首次可能較慢）
      });
      const yt = s.ytSubtitle || {};
      const geminiOverrides = {
        // P1: 依 target 切 universal/zh-TW;使用者自訂(yt.systemPrompt)不為空且非預設視為客製,直接走 saved
        systemInstruction: getEffectiveSubtitleSystemPrompt(s.targetLanguage, yt.systemPrompt),
        temperature: yt.temperature ?? 0.1,
      };
      // 若使用者設定了獨立 YouTube 模型，覆蓋 geminiConfig.model
      if (yt.model) geminiOverrides.model = yt.model;
      // ytSubtitle.pricing 非空時傳入，讓 handleTranslate 用正確計價計算費用
      const pricingOverride = (yt.pricing && yt.pricing.inputPerMTok != null) ? yt.pricing : null;
      // v1.5.8: 字幕路徑預設不套用固定術語表 / 黑名單，使用者可在 YouTube 字幕分頁開 toggle
      return handleTranslate(payload, sender, geminiOverrides, pricingOverride, '_yt',
        yt.applyFixedGlossary === true,
        yt.applyForbiddenTerms === true);
    },
  },
  // v1.6.20: ASR(YouTube 自動字幕）專用——LLM 自由合句 + 時間戳對齊路徑（D' 模式，
  // timestamp mode)。
  // 與 TRANSLATE_SUBTITLE_BATCH 的差異：
  //   - 走獨立 system prompt(DEFAULT_ASR_SUBTITLE_SYSTEM_PROMPT)，允許 LLM 自由合句
  //   - texts 是單一元素（整視窗包成 [{s,e,t}] JSON 字串），不分批
  //   - cache key tag '_yt_asr'，跟 _yt 分區避免互打
  //   - 字幕 settings 沿用 ytSubtitle(model / temperature / pricing)，只覆寫 systemInstruction
  TRANSLATE_ASR_SUBTITLE_BATCH: {
    async: true,
    handler: (payload, sender) => _handleAsrSubtitleBatch(payload, sender, '_yt_asr', 'youtube'),
  },
  // commit 4a:Drive 影片 ASR 字幕走獨立 cache key('_drive_yt_asr'）避免污染 YouTube
  // 既有 cache。LLM prompt / pricing / 設定全部沿用 ytSubtitle(D' 模式跟 YouTube 一致）。
  TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH: {
    async: true,
    handler: (payload, sender) => _handleAsrSubtitleBatch(payload, sender, '_drive_yt_asr', 'drive'),
  },
  // Drive 影片 ASR 字幕 URL 偵測——iframe(youtube.googleapis.com/embed）的
  // content-drive-iframe.js 用 PerformanceObserver 抓到 timedtext URL 後送來。
  // 為什麼 background fetch 而不直接 iframe fetch:iframe 內 fetch 會被 PerformanceObserver
  // 重新捕捉造成 loop；且 background 跟 iframe 不同 origin，但 authpayload 自含 auth（已驗
  // credentials:'omit' 也 200),background 直接 refetch 即可。
  // 拿到 json3 後 relay 到 top frame(drive.google.com）的 content-script(commit 2 接手處理）。
  DRIVE_TIMEDTEXT_URL: {
    async: true,
    handler: async (payload, sender) => {
      const url = payload?.url;
      if (!url || !sender?.tab?.id) return { ok: false, error: 'invalid payload' };
      debugLog('info', 'drive', 'timedtext url received from iframe', {
        tabId: sender.tab.id,
        frameId: sender.frameId,
        url: url.slice(0, 200),
      });
      try {
        // 15s timeout 自保——timedtext host 卡住時別讓 sendResponse 通道一直懸著
        const res = await fetchWithTimeout(url, { credentials: 'omit' }, 15000);
        if (!res.ok) {
          debugLog('warn', 'drive', 'timedtext fetch failed', { status: res.status });
          return { ok: false, error: `http ${res.status}` };
        }
        const json3 = await res.json();
        debugLog('info', 'drive', 'timedtext fetched', {
          eventCount: Array.isArray(json3?.events) ? json3.events.length : 0,
        });
        try {
          await browser.tabs.sendMessage(
            sender.tab.id,
            { type: 'DRIVE_ASR_CAPTIONS', payload: { url, json3 } },
            { frameId: 0 },
          );
        } catch (e) {
          // top frame 可能還沒 listener(commit 2 才接），這層先記 log
          debugLog('info', 'drive', 'top frame relay no listener (expected pre-commit-2)', {
            error: e?.message || String(e),
          });
        }
        return { ok: true };
      } catch (e) {
        debugLog('warn', 'drive', 'timedtext handler error', { error: e?.message || String(e) });
        return { ok: false, error: e?.message || String(e) };
      }
    },
  },
  // v1.4.0: Google Translate 網頁翻譯（不需 API Key，快取 key 用 _gt 後綴）
  TRANSLATE_BATCH_GOOGLE: {
    async: true,
    handler: (payload, sender) => handleTranslateGoogle(payload, sender, '_gt'),
  },
  // W3：文件翻譯（translate-doc/index.js）專用批次。沿用 TRANSLATE_BATCH 流程，
  // cacheTag '_doc' 區隔 — 既有網頁翻譯（'') / 字幕（'_yt') / Google MT('_gt')
  // 不互相污染。SPEC §17.5.3 規定的 blockType / fontSize 桶位精修留 W3-iter2;
  // 第一版以 plainText + modelOverride + glossary 為 hash 變數，跟既有網頁翻譯邏輯一致。
  //
  // payload: { texts: string[], modelOverride?: string, glossary?: [{source,target}] }
  // 回應：{ result: string[], usage: {...}, hadMismatch }
  TRANSLATE_DOC_BATCH: {
    async: true,
    handler: async (payload, sender) => {
      // W7：文件翻譯路徑用 settings.translateDoc.systemPrompt(空 fallback 到
      // DEFAULT_DOC_SYSTEM_PROMPT)，不污染網頁翻譯 prompt。通用於 PDF + 未來
      // 各 Office 格式。透過 geminiOverrides.systemInstruction 覆蓋 geminiConfig。
      //
      // append DOC_INLINE_MARKER_INSTRUCTION：這段 inline marker 協定 user 編輯
      // 不到也看不到（避免改壞 marker 解析核心邏輯)，由 background 自動補在 user
      // prompt 後送 LLM。即便 user 把 systemPrompt 改成完全不同的翻譯 prompt,
      // marker 規則仍然生效
      const s = await getSettings();
      const td = s.translateDoc || {};
      // P1: 依 target 切 universal/zh-TW;使用者自訂(td.systemPrompt)不為空且非預設視為客製
      const userPrompt = getEffectiveDocSystemPrompt(s.targetLanguage, td.systemPrompt);
      // 本文件額外翻譯指令（2026-07-27）：附加在使用者 doc prompt 之後、marker 協定
      // 之前（協定規則永遠收尾，不被 per-document 指令蓋掉）。cache key 走 _x hash
      const extraPrompt = docExtraPromptOf(payload);
      const effectivePrompt = userPrompt
        + (extraPrompt ? '\n\n' + extraPrompt : '')
        + DOC_INLINE_MARKER_INSTRUCTION;
      const overrides = { systemInstruction: effectivePrompt };
      // v2.0.53:文件批次逾時 120s——每批可達 50 段長文,輸出遠超網頁翻譯的 15s
      // 假設(日文書實例:850 段逾時失敗,abort 的請求 Google 端照樣計費)。
      // 逾時重試降為 1 次:120s 還逾時代表批太大,重複燒同尺寸請求 = 4 倍計費
      // 0 產出,交 translate-doc/translate.js 對切重試縮批處理
      overrides.fetchTimeoutMs = DOC_FETCH_TIMEOUT_MS;
      overrides.timeoutRetries = 1;
      if (typeof td.temperature === 'number' && Number.isFinite(td.temperature)) {
        overrides.temperature = td.temperature;
      }
      if (payload?.modelOverride) overrides.model = payload.modelOverride;
      // v1.8.49: 文件翻譯路徑「是否套用固定術語表」由設定控制（預設 true，沿用之前隱含行為)。
      // fixedGlossary entries 仍從 settings.fixedGlossary.global 讀（跟主功能共用)。
      const applyFixedGlossary = td.applyFixedGlossary !== false;
      return handleTranslate(payload, sender, overrides, null, '_doc', applyFixedGlossary);
    },
  },
  TRANSLATE_DOC_BATCH_CUSTOM: {
    async: true,
    handler: async (payload, sender) => {
      const s = await getSettings();
      const td = s.translateDoc || {};
      const userPrompt = getEffectiveDocSystemPrompt(s.targetLanguage, td.systemPrompt);
      // 本文件額外翻譯指令：同 TRANSLATE_DOC_BATCH 的附加位置與 cache key 規則
      const extraPrompt = docExtraPromptOf(payload);
      const effectivePrompt = userPrompt
        + (extraPrompt ? '\n\n' + extraPrompt : '')
        + DOC_INLINE_MARKER_INSTRUCTION;
      const overrides = { systemPrompt: effectivePrompt };
      // v2.0.53:同 TRANSLATE_DOC_BATCH 的批次逾時放寬。openai-compat 走秒制
      // fetchTimeoutSec;使用者在自訂模型設定填了更大的值就尊重使用者
      const userTimeoutSec = s.customProvider?.fetchTimeoutSec;
      overrides.fetchTimeoutSec = Math.max(
        DOC_FETCH_TIMEOUT_MS / 1000,
        (typeof userTimeoutSec === 'number' && userTimeoutSec > 0) ? userTimeoutSec : 0,
      );
      if (typeof td.temperature === 'number' && Number.isFinite(td.temperature)) {
        overrides.temperature = td.temperature;
      }
      const applyFixedGlossary = td.applyFixedGlossary !== false;
      return handleTranslateCustom(payload, sender, '_oc_doc', overrides, applyFixedGlossary);
    },
  },
  // commit 5b:Drive 影片字幕走 Google Translate 路徑（獨立 cache key '_gt_drive' 避免跟
  // 一般網頁 GT 翻譯（'_gt'）互打）。input texts = raw segments 的 text array，逐段翻。
  TRANSLATE_DRIVE_BATCH_GOOGLE: {
    async: true,
    handler: (payload, sender) => handleTranslateGoogle(payload, sender, '_gt_drive'),
  },
  // v1.5.7: OpenAI-compatible 自訂 Provider 翻譯（chat.completions endpoint）
  // cache key 加 baseUrl hash + model 分區。
  TRANSLATE_BATCH_CUSTOM: {
    async: true,
    handler: (payload, sender) => handleTranslateCustom(payload, sender, '_oc'),
  },
  // v1.5.8: 字幕用自訂模型，與網頁翻譯共用 customProvider 設定但 cache key 用 '_oc_yt'
  // 命名空間（同 '_yt' 對 Gemini、'_gt_yt' 對 Google MT 的字幕分區慣例）。
  // 對 systemPrompt 走 cpOverrides 覆蓋成字幕專屬（ytSubtitle.systemPrompt）；
  // 字幕未自訂時 fallback 到主自訂模型 prompt。
  TRANSLATE_SUBTITLE_BATCH_CUSTOM: {
    async: true,
    handler: async (payload, sender) => {
      const s = await getSettings();
      const yt = s.ytSubtitle || {};
      const ytPrompt = (yt.systemPrompt || '').trim();
      const overrides = ytPrompt ? { systemPrompt: ytPrompt } : null;
      // v1.5.8: 字幕路徑同 Gemini 字幕路徑，預設不套用固定術語表 / 黑名單
      return handleTranslateCustom(payload, sender, '_oc_yt', overrides,
        yt.applyFixedGlossary === true,
        yt.applyForbiddenTerms === true);
    },
  },
  // YouTube ASR 自動字幕走自訂 Provider 時的入口。沿用 customProvider 的
  // baseUrl / model / apiKey / pricing / thinking 等設定，但 systemPrompt 強制覆寫成
  // DEFAULT_ASR_SUBTITLE_SYSTEM_PROMPT(JSON timestamp 模式跟一般逐條字幕規則不同，
  // 不讀使用者自訂的 ytSubtitle.systemPrompt — 跟 Gemini 路徑 _handleAsrSubtitleBatch 對齊)。
  // cache key '_oc_yt_asr' 區隔：跟 Gemini ASR('_yt_asr')/ 自訂一般字幕（'_oc_yt'）互不污染。
  // 同樣不套用固定術語表 / 黑名單（ASR prompt 已內含禁用詞規則，且 JSON 包裝術語注入麻煩)。
  TRANSLATE_ASR_SUBTITLE_BATCH_CUSTOM: {
    async: true,
    handler: async (payload, sender) => {
      const s = await getSettings();
      const yt = s.ytSubtitle || {};
      const overrides = {
        // P1: 自訂 Provider ASR 路徑同 Gemini ASR,依 target 切 universal/zh-TW prompt
        systemPrompt: getEffectiveAsrSubtitleSystemPrompt(s.targetLanguage, payload?.sourceLanguage || 'en'),
        temperature: yt.temperature ?? 0.1,
      };
      return handleTranslateCustom(payload, sender, '_oc_yt_asr', overrides, false, false);
    },
  },
  // Drive 影片 ASR 字幕走自訂 Provider 時的入口。跟 TRANSLATE_ASR_SUBTITLE_BATCH_CUSTOM
  // 結構對齊(共用 ASR JSON timestamp prompt + parseAsrResponse),只差 cache key '_oc_drive_yt_asr'
  // 避免跟 YouTube('_oc_yt_asr')及 Gemini Drive ASR('_drive_yt_asr')互相污染。
  TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH_CUSTOM: {
    async: true,
    handler: async (payload, sender) => {
      const s = await getSettings();
      const yt = s.ytSubtitle || {};
      const overrides = {
        systemPrompt: getEffectiveAsrSubtitleSystemPrompt(s.targetLanguage, payload?.sourceLanguage || 'en'),
        temperature: yt.temperature ?? 0.1,
      };
      return handleTranslateCustom(payload, sender, '_oc_drive_yt_asr', overrides, false, false);
    },
  },
  // v1.6.1: 使用者點 toast 內「下載」連結或「×」時，標記今日已顯示更新提示（每日節流）
  UPDATE_NOTICE_DISMISSED: {
    async: true,
    handler: () => markUpdateNoticeShown(),
  },
  // v1.6.5: 「知道了」按鈕（popup banner）標記永久 dismissed=true
  WELCOME_NOTICE_DISMISSED: {
    async: true,
    handler: async () => {
      const { welcomeNotice } = await browser.storage.local.get('welcomeNotice');
      if (!welcomeNotice) return;
      await browser.storage.local.set({
        welcomeNotice: { ...welcomeNotice, dismissed: true },
      });
    },
  },
  // v1.6.5: toast 顯示過 welcome notice 後標記今天日期（每日節流，避免每次翻譯都嘮叨）
  WELCOME_NOTICE_TOAST_SHOWN: {
    async: true,
    handler: async () => {
      const { welcomeNotice } = await browser.storage.local.get('welcomeNotice');
      if (!welcomeNotice) return;
      await browser.storage.local.set({
        welcomeNotice: { ...welcomeNotice, lastNoticeShownDate: localTodayKey() },
      });
    },
  },
  // v1.5.7: API Key 測試 — 設定頁「測試」按鈕觸發。
  // Gemini 走 GET models/<model>（key 走 x-goog-api-key header）不耗 token；
  // OpenAI-compat 走 POST /chat/completions ping(v1.8.43 起不帶 max_tokens)，耗 ~1-3 token。
  TEST_GEMINI_KEY: {
    async: true,
    handler: (payload) => testGeminiKey(payload),
  },
  TEST_CUSTOM_PROVIDER: {
    async: true,
    handler: (payload) => testCustomProvider(payload),
  },
  // v1.4.0: Google Translate 字幕翻譯（快取 key 用 _gt_yt 後綴）
  TRANSLATE_SUBTITLE_BATCH_GOOGLE: {
    async: true,
    handler: (payload, sender) => handleTranslateGoogle(payload, sender, '_gt_yt'),
  },
  EXTRACT_GLOSSARY: {
    async: true,
    handler: (payload, sender) => handleExtractGlossary(payload, sender),
  },
  // 自訂 Provider(openai-compat）走 chat.completions 抽術語表；不需要 Gemini API Key。
  // content.js 依 engine 透過 SK.getGlossaryExtractType 路由到這裡。回傳格式跟
  // EXTRACT_GLOSSARY 對齊（同 _diag / usage / glossary / fromCache 結構)。
  EXTRACT_GLOSSARY_CUSTOM: {
    async: true,
    handler: (payload, sender) => handleExtractGlossaryCustomProvider(payload, sender),
  },
  // v2.0.11: EPUB 譯後一致性掃描——批次抽取「原文詞在譯文中的實際譯法」
  //（同 EXTRACT_GLOSSARY 的抽取類任務定位：走術語表模型、best-effort、
  //  usage 記入 usage-db source='scan'、billedCostUSD 回給頁面累進本書累計費用）
  SCAN_TERM_RENDERINGS: {
    async: true,
    handler: (payload, sender) => handleScanTermRenderings(payload, sender),
  },
  CLEAR_CACHE: {
    async: true,
    handler: () => cache.clearAll().then(async (removed) => {
      // v1.8.53: storage 清完後 broadcast 給所有 tabs，讓 content script reset
      // YT in-memory state(captionMap / translatedWindows / displayCues)。
      // 否則使用者「清快取後拖進度條」會被 onSeeked 內 translatedWindows.has guard
      // 擋住「翻譯中…」+ translateWindowFrom 重發 API。詳見 content-youtube.js
      // _resetTranslationStateForCacheClear 註解。
      try {
        const tabs = await browser.tabs.query({});
        for (const tab of tabs) {
          if (!tab.id) continue;
          browser.tabs.sendMessage(tab.id, { type: 'YT_RESET_AFTER_CACHE_CLEAR' })
            .catch(() => {}); // 沒 content script 的 tab 會 error,silent
        }
      } catch (_) {}
      return { removed };
    }),
  },
  CACHE_STATS: {
    async: true,
    handler: () => cache.stats(),
  },
  SET_BADGE_TRANSLATED: {
    async: true,
    handler: (_, sender) => setTranslatedBadge(sender?.tab?.id),
  },
  CLEAR_BADGE: {
    async: true,
    handler: (_, sender) => clearTranslatedBadge(sender?.tab?.id),
  },
  // iOS 四指 tap（content-touch.js）→ 轉發 TRANSLATE_PRESET slot 2（主要預設），
  // 跟 commands onCommand 的 Alt+S（translate-preset-0 → slot 2）完全同一條派送
  // 路徑——tabs.sendMessage 不帶 frameId = all frames broadcast，行為與快速鍵一致，
  // 避免「手勢」「快速鍵」兩條 path 各自演化 drift
  FOUR_FINGER_TAP: {
    async: false,
    handler: (_, sender) => {
      const tabId = sender?.tab?.id;
      if (tabId == null) return;
      browser.tabs.sendMessage(tabId, { type: 'TRANSLATE_PRESET', payload: { slot: 2 } }).catch(() => {});
    },
  },
  // iOS 四指長按（content-touch.js）→ 轉發 TRANSLATE_PRESET slot 1（次要預設，預設
  // Flash Lite）。跟四指 tap 同一條 background → all frames broadcast 派送，只差 slot
  FOUR_FINGER_LONGPRESS: {
    async: false,
    handler: (_, sender) => {
      const tabId = sender?.tab?.id;
      if (tabId == null) return;
      browser.tabs.sendMessage(tabId, { type: 'TRANSLATE_PRESET', payload: { slot: 1 } }).catch(() => {});
    },
  },
  // v1.4.11 跨 tab sticky 翻譯（v1.4.12 起 value = preset slot number）
  STICKY_QUERY: {
    async: true,
    handler: async (_, sender) => {
      await hydrateStickyTabs();
      const tabId = sender?.tab?.id;
      if (tabId == null) return { ok: true, shouldTranslate: false };
      const slot = stickyTabs.get(tabId);
      return { ok: true, shouldTranslate: slot != null, slot: slot ?? null };
    },
  },
  STICKY_SET: {
    async: true,
    handler: async (payload, sender) => {
      await hydrateStickyTabs();
      const tabId = sender?.tab?.id;
      if (tabId == null) return { ok: false, error: 'no tab id' };
      const slot = Number(payload?.slot);
      if (!Number.isInteger(slot) || slot < 1) return { ok: false, error: 'invalid slot' };
      stickyTabs.set(tabId, slot);
      await persistStickyTabs();
      return { ok: true };
    },
  },
  STICKY_CLEAR: {
    async: true,
    handler: async (_, sender) => {
      await hydrateStickyTabs();
      const tabId = sender?.tab?.id;
      if (tabId == null) return { ok: false };
      stickyTabs.delete(tabId);
      await persistStickyTabs();
      return { ok: true };
    },
  },
  LOG: {
    async: false,
    handler: (payload, sender) => {
      const { level, category, message: msg, data } = payload || {};
      const enrichedData = { ...data, _tab: sender?.tab?.url || sender?.url };
      debugLog(level || 'info', category || 'system', msg || '', enrichedData);
    },
  },
  GET_LOGS: {
    async: false,
    handler: (payload) => getLogs(payload?.afterSeq || 0),
  },
  CLEAR_LOGS: {
    async: false,
    handler: () => { clearLogs(); },
  },
  // v1.2.52: 持久化 log（跨 service worker 重啟）
  GET_PERSISTED_LOGS: {
    async: true,
    handler: async () => {
      const logs = await getPersistedLogs();
      // anomalies：低流量異常 ring（stream 重翻覆蓋等偶發事件），不被日常
      // translate / api log 擠掉，供事後排查（2026-07-27 scotto.me 排查缺口）
      const anomalies = await getAnomalyLogs();
      return { logs, count: logs.length, anomalies };
    },
  },
  CLEAR_PERSISTED_LOGS: {
    async: true,
    handler: async () => {
      await clearPersistedLogs();
      return { ok: true };
    },
  },
  // v1.0.7: Google Docs — 在新分頁開啟 mobilebasic 版本並自動觸發翻譯
  OPEN_GDOC_MOBILE: {
    async: true,
    handler: async (payload) => {
      const url = payload?.url;
      if (!url) throw new Error('missing url');
      const tab = await browser.tabs.create({ url });
      debugLog('info', 'system', 'opened Google Docs mobilebasic tab', { url, tabId: tab.id });

      // 等待新分頁載入完成後自動觸發翻譯
      // 透過 onUpdated 監聽 tab 的 complete 狀態，再送 TOGGLE_TRANSLATE 訊息
      return new Promise((resolve) => {
        // v1.8.20: 把 30s 安全閥 timer 拉出來，onUpdated 路徑 resolve 時 clearTimeout
        // 避免 SW 多活 30s 跑無作用 code（原本 onUpdated 路徑沒清，timeout setTimeout 仍然 fire)
        let safetyTimer = null;
        const onUpdated = (tabId, changeInfo) => {
          if (tabId === tab.id && changeInfo.status === 'complete') {
            browser.tabs.onUpdated.removeListener(onUpdated);
            if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
            // 小延遲確保 content script 已完成初始化
            setTimeout(() => {
              browser.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATE' }).catch(() => {});
            }, 500);
            resolve({ tabId: tab.id });
          }
        };
        browser.tabs.onUpdated.addListener(onUpdated);

        // 安全閥：30 秒後若尚未 complete，移除 listener 避免洩漏
        safetyTimer = setTimeout(() => {
          browser.tabs.onUpdated.removeListener(onUpdated);
          resolve({ tabId: tab.id, timeout: true });
        }, 30000);
      });
    },
  },
  LOG_USAGE: {
    async: true,
    handler: async (payload) => {
      // v1.8.14: 改用 getSettingsCached——YouTube 一支影片上百筆 LOG_USAGE,
      // 每筆原本都重讀整份 settings 只為了取 model 名稱。
      const settings = await getSettingsCached();
      // v1.5.7: 依 payload.engine 決定 model 該從哪裡取——這樣 Alt+A/S 切不同 preset
      // 寫入紀錄的 model 才會是該批 API 真實使用的模型。
      // - 'openai-compat'：自訂模型，model 從 settings.customProvider.model
      // - 其他（gemini）：優先 payload.model（preset modelOverride），否則 fallback 全域
      let resolvedModel;
      if (payload.engine === 'openai-compat') {
        // v1.8.41:llama.cpp / Ollama 等本機 server 啟動時鎖 model，使用者可不填 model 欄位。
        // 此時 server 用 startup-loaded model,Shinkansen 用 '<server-default>' 佔位
        // （避免空字串污染 model filter / chart group)。
        resolvedModel = settings.customProvider?.model || '<server-default>';
      } else {
        resolvedModel = payload.model || settings.geminiConfig?.model || 'unknown';
      }
      const record = {
        ...payload,
        engine: payload.engine || 'gemini',
        model: resolvedModel,
      };
      // v1.8.39: 整頁本地 cache 全命中（沒打 API）的紀錄沒資訊價值，跳過寫入
      // 避免塞滿使用者的用量列表。YouTube 走 upsert 路徑不適用此規則。
      if (usageDB.shouldSkipUsageRecord(record)) {
        return;
      }
      // v1.4.18: YouTube 字幕一支影片會分成多批翻譯，逐批寫入會變幾十筆。
      // 改由 upsertYouTubeUsage 以 (videoId + model, 1 小時視窗） 合併成一筆；
      // 換模型或超過 1 小時才拆新筆。網頁翻譯仍走 logTranslation。
      if (record.source === 'youtube-subtitle' && record.videoId) {
        await usageDB.upsertYouTubeUsage(record);
      } else {
        await usageDB.logTranslation(record);
      }
    },
  },
  QUERY_USAGE: {
    async: true,
    handler: async (payload) => ({ records: await usageDB.query(payload || {}) }),
  },
  QUERY_USAGE_STATS: {
    async: true,
    handler: async (payload) => ({ stats: await usageDB.getStats(payload || {}) }),
  },
  QUERY_USAGE_CHART: {
    async: true,
    handler: async (payload) => ({ data: await usageDB.getAggregated(payload || {}) }),
  },
  EXPORT_USAGE_CSV: {
    async: true,
    handler: async (payload) => ({ csv: await usageDB.exportCSV(payload || {}) }),
  },
  CLEAR_USAGE: {
    async: true,
    handler: (payload) => {
      return payload?.beforeTimestamp
        ? usageDB.clearBefore(payload.beforeTimestamp)
        : usageDB.clearAll();
    },
  },

  // v1.3.12: FETCH_YT_CAPTIONS 已移除。
  // YouTube 字幕資料由 content-youtube-main.js 的 XHR monkey-patch 攔截取得，
  // 不再透過 background 主動 fetch（YouTube timedtext URL 即使 same-origin 也因 exp=xpv 需要 POT）。

  // v1.8.41:USD → TWD 匯率（讀 cache;cache 不存在回 fallback 31.6)
  EXCHANGE_RATE_GET: {
    async: true,
    handler: async () => {
      const cached = await getCachedRate();
      return { ok: true, ...cached };
    },
  },
  // v1.8.41：手動「重新抓取匯率」按鈕（options 頁）走這條，跳過 freshness 檢查強制 refetch。
  // 失敗時 refreshExchangeRate 回 null，我們仍回當前 cached 狀態讓 UI 維持可用。
  EXCHANGE_RATE_REFRESH: {
    async: true,
    handler: async () => {
      const fresh = await refreshExchangeRate();
      if (fresh) return { ok: true, ...fresh };
      const cached = await getCachedRate();
      return { ok: false, error: 'fetch failed', ...cached };
    },
  },
  // 「送到 Instapaper」摘要:popup 送出前要 description 走這條(Alt+I 路徑則由
  // handleSendToInstapaperCommand 直接呼叫同一個 helper,單一資料源不 drift)。
  // best-effort:回 { summary: '' } 代表不附摘要,popup 照常送書籤。
  SUMMARIZE_FOR_INSTAPAPER: {
    async: true,
    handler: async (payload, sender) => ({ summary: await generateInstapaperSummary(payload?.text, sender) }),
  },
};

// 錯誤 i18n 協定（lib/bg-error.js）：err 帶 skCode 時把 errorCode / errorParams
// 一併放進 response / STREAMING_ERROR payload，UI 端（content / translate-doc）
// 用 lib/i18n.js bgErrorMessage() 查 dict 組訊息；error 維持原字串當 fallback。
// 四個 STREAMING_ERROR 發送點 + dispatcher catch 都走這裡，避免欄位組裝 drift。
function errorFields(err) {
  const fields = { error: err?.message || String(err) };
  if (err?.skCode) {
    fields.errorCode = err.skCode;
    if (err.skParams) fields.errorParams = err.skParams;
  }
  return fields;
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;
  const entry = messageHandlers[type];
  if (!entry) return; // 不認識的訊息類型，不處理

  if (entry.async) {
    entry.handler(message.payload, sender)
      .then((result) => sendResponse({ ok: true, ...(result && typeof result === 'object' ? result : {}) }))
      .catch((err) => {
        debugLog('error', 'system', `${type} failed`, { error: err?.message || String(err) });
        sendResponse({ ok: false, ...errorFields(err) });
      });
    return true; // 保留 sendResponse 通道
  } else {
    // 同步 handler
    const result = entry.handler(message.payload, sender);
    sendResponse({ ok: true, ...(result && typeof result === 'object' ? result : {}) });
    return false;
  }
});

// iOS background keep-alive port（content-touch.js 開，SPEC-PRIVATE §26.14）。
// iOS Safari 的 background event page 閒置後會被系統永久回收且叫不醒（thread
// 758346）→ 表現為「用一陣子後四指 / popup 翻譯失效」。content script 開一條
// 長連線 port + 每 20s ping；「持續有 port 連著 + 收訊息」這個事實本身就讓系統
// 把 background 維持在非閒置，不被回收。handler body 幾乎不必做事——收到 ping
// 回個 pong 讓 content 端能偵測背景是否還活著。
//   無條件註冊（不以 IS_IOS_BUILD gate）：桌面 build 的 content-touch.js 根本不
// 會開這條 port（content 端有 IS_IOS_BUILD gate）→ 此 listener 在桌面永不觸發，
// 零行為差異；無條件註冊讓 Playwright（Chromium）能驗真實 content↔background
// round-trip（iOS 平台的回收行為 harness 測不到，但 port 接線測得到）。
browser.runtime.onConnect.addListener((port) => {
  if (port?.name !== 'shinkansen-keepalive') return;
  port.onMessage.addListener(() => {
    try { port.postMessage({ pong: true }); } catch (_) {}
  });
});

// v1.8.0: streamId → AbortController 對映，支援使用者中途取消 streaming
const inFlightStreams = new Map();

// v1.8.14: streaming 期間 SW keep-alive。
// v1.8.20: 改用 chrome.alarms — setInterval 在 SW 真被收回時整個被銷毀，等於 keep-alive 本身死亡；
// alarms 是持久排程，SW 收回後到觸發點仍會被喚醒繼續續命。
// 設計：0.4 分鐘（24 秒）觸發一次，由 onAlarm 排程下一次，直到 inFlightStreams 清空才停。
const _STREAM_KEEPALIVE_ALARM = 'shinkansen-stream-keepalive';
const _STREAM_KEEPALIVE_PERIOD_MIN = 0.5; // Chrome alarms 最低 0.5 分鐘 = 30 秒
function _startStreamKeepAlive() {
  // 重複呼叫 alarms.create 同名會覆蓋（無重複註冊風險）
  try {
    browser.alarms.create(_STREAM_KEEPALIVE_ALARM, {
      delayInMinutes: _STREAM_KEEPALIVE_PERIOD_MIN,
      periodInMinutes: _STREAM_KEEPALIVE_PERIOD_MIN,
    });
  } catch (_) { /* alarms 權限缺失或測試環境 */ }
}
function _stopStreamKeepAliveIfIdle() {
  if (inFlightStreams.size === 0) {
    try { browser.alarms.clear(_STREAM_KEEPALIVE_ALARM); } catch (_) {}
  }
}
// alarm 觸發即「SW 被喚醒到」這個事實本身就是 keep-alive。handler body 不必做事；
// 但 alarm 觸發時若 inFlightStreams 已空（stream 完成同時 alarm fire 的 race)，順手清理。
_registerAlarm(_STREAM_KEEPALIVE_ALARM, () => {
  if (inFlightStreams.size === 0) {
    try { browser.alarms.clear(_STREAM_KEEPALIVE_ALARM); } catch (_) {}
  }
});

// v1.8.0: Streaming 翻譯 handler。
// v1.8.9: 加 opts 參數，支援字幕路徑（TRANSLATE_SUBTITLE_BATCH_STREAM）復用同一條 streaming pipeline,
// 但用 ytSubtitle.systemPrompt / ytSubtitle.model / ytSubtitle.pricing / cacheTag '_yt'。
// 設計：async fire-and-forget，結果透過 tabs.sendMessage 推回 sender tab。
// scope 限制：只給文章翻譯 + 人工字幕 batch 0 用，ASR LLM 路徑下一輪再套。
// v2.0.11:EPUB「本書獨立禁用詞」——translate-doc 頁隨批次 payload 送，與
// options 共通清單合併。_b cache hash 由合併後清單計算（buildCacheKeySuffix),
// 書級清單變更 → 既有快取自動失效。上限 200 條防 prompt 暴脹；逐條欄位驗型別，
// 值的消毒交給 lib/system-instruction.js sanitizeTermText（單一資料源）。
function mergeExtraForbiddenTerms(baseList, extras) {
  if (!Array.isArray(extras) || extras.length === 0) return baseList;
  const cleaned = extras.slice(0, 200)
    .filter((e) => e && typeof e.forbidden === 'string' && e.forbidden.trim())
    .map((e) => ({
      forbidden: e.forbidden,
      replacement: typeof e.replacement === 'string' ? e.replacement : '',
    }));
  if (cleaned.length === 0) return baseList;
  return [...baseList, ...cleaned];
}

async function handleTranslateStream(payload, sender, streamId, tabId, opts = {}) {
  const {
    cacheTag = '',
    geminiOverrides = {},
    pricingOverride = null,
    applyFixedGlossary = true,
    applyForbiddenTerms = true,
  } = opts;

  const settings = await getSettings();
  if (!settings.apiKey) {
    browser.tabs.sendMessage(tabId, {
      type: 'STREAMING_ERROR',
      payload: { streamId, ...errorFields(codedError('apiKeyMissing', null, '尚未設定 Gemini API Key，請至設定頁填入。')), atSegment: 0 },
    }).catch(() => {});
    return;
  }

  const texts = payload?.texts || [];
  if (!texts.length) {
    browser.tabs.sendMessage(tabId, {
      type: 'STREAMING_DONE',
      payload: { streamId, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, billedInputTokens: 0, billedCostUSD: 0 }, totalSegments: 0, hadMismatch: false, finishReason: 'STOP' },
    }).catch(() => {});
    return;
  }

  // 合併 caller 傳入的 geminiOverrides（字幕路徑帶 systemPrompt / temperature / model)+
  // payload.modelOverride(preset 快速鍵）。payload 層級 model 勝出。
  const overrides = { ...geminiOverrides };
  if (payload?.modelOverride) overrides.model = payload.modelOverride;
  // P1: 同 handleTranslate ── caller 沒覆蓋 systemInstruction 時依 targetLanguage 算 effective prompt
  const baseSI = ('systemInstruction' in overrides)
    ? overrides.systemInstruction
    : getEffectiveSystemPrompt(settings.targetLanguage, settings.geminiConfig?.systemInstruction);
  const effectiveSettings = {
    ...settings,
    geminiConfig: { ...settings.geminiConfig, ...overrides, systemInstruction: baseSI },
  };
  // pricing 優先順序：caller 傳入 pricingOverride（字幕獨立計價）> modelOverride 查表 > settings.pricing
  let effectivePricing = pricingOverride;
  if (!effectivePricing && overrides.model) effectivePricing = getPricingForModel(overrides.model, settings);
  if (!effectivePricing) effectivePricing = settings.pricing;

  // v1.10.46 批次 2-5 的「失敗路徑記帳」同型修法(streaming 版)：中途失敗 / 取消 /
  // hadMismatch 丟棄結果時，SSE 已解析出的 usage 是已付費 token,content 端不會發
  // LOG_USAGE(error 路徑)或會在累計前 reject(mismatch 重翻)，不在這裡記就永遠漏帳。
  const logDiscardedStreamUsage = async (usage, why, segments) => {
    if (!usage || !(usage.inputTokens > 0 || usage.outputTokens > 0)) return;
    try {
      const cachedRate = pricingToCachedRate(effectivePricing) ?? 0.10;
      const cachedSavedRatio = 1 - cachedRate;
      await usageDB.logTranslation({
        url: sender?.tab?.url || '',
        title: sender?.tab?.title || '',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens || 0,
        billedInputTokens: Math.max(0, Math.round(
          usage.inputTokens - (usage.cachedTokens || 0) * cachedSavedRatio,
        )),
        billedCostUSD: computeBilledCostUSD(
          usage.inputTokens,
          usage.cachedTokens || 0,
          usage.outputTokens,
          effectivePricing,
          cachedRate,
        ),
        segments: segments || 0,
        cacheHits: 0,
        timestamp: Date.now(),
        engine: 'gemini',
        model: effectiveSettings.geminiConfig?.model || 'unknown',
        partialFailure: true,
      });
      debugLog('warn', 'api', 'streaming usage logged on discard path', {
        streamId, why, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      });
    } catch (_) { /* 記帳失敗不影響原流程 */ }
  };

  // 固定術語表 / 禁用詞清單。字幕路徑預設不套用（applyFixedGlossary/applyForbiddenTerms=false),
  // 跟 handleTranslate 對 ytSubtitle 的處理一致。
  // v1.10.46: 改走 buildFixedGlossaryEntries + preferArticleGlossaryEntries 共用邏輯——
  // 原手抄版沒做 Map dedup 也沒呼叫 preferArticleGlossaryEntries，global+domain 同 source
  // 重疊時 batch 0（streaming）與 batch 1+（non-streaming）算出不同 _g hash，同頁兩個
  // cache namespace。
  let fixedGlossaryEntries = buildFixedGlossaryEntries(
    applyFixedGlossary ? settings.fixedGlossary : null,
    sender,
  );
  fixedGlossaryEntries = preferArticleGlossaryEntries(
    fixedGlossaryEntries,
    payload?.glossary,
    payload?.preferArticleGlossary,
  );
  const forbiddenTermsList = mergeExtraForbiddenTerms(
    (applyForbiddenTerms && Array.isArray(settings.forbiddenTerms)) ? settings.forbiddenTerms : [],
    payload?.extraForbiddenTerms,
  );

  // v1.8.1/v1.8.9: cache key suffix 跟 handleTranslate 同 key 規則（v1.10.46 起共用
  // buildCacheKeySuffix 單一資料源）— 起始 cacheTag（'_yt' / ''）
  const glossary = payload?.glossary || null;
  const cacheKeySuffix = await buildCacheKeySuffix({
    cacheTag,
    glossary,
    fixedGlossaryEntries,
    forbiddenTermsList,
    modelKeyPart: (effectiveSettings.geminiConfig?.model || 'unknown').replace(/[^a-z0-9.\-]/gi, '_'),
    targetLanguage: effectiveSettings.targetLanguage,
  });

  // v1.8.1: 先查 cache。若全部命中，走 fast path 直接 emit 假 first_chunk + 所有 segment + done,
  // 不打 Gemini API。對應使用者「翻完還原重翻」的 case,batch 0 內容應該秒出。
  const cached = await cache.getBatch(texts, cacheKeySuffix);
  const allHit = cached.every((tr) => tr != null);
  const cacheHits = cached.filter((tr) => tr != null).length;
  debugLog('info', 'cache', 'streaming batch cache lookup', {
    streamId, total: texts.length, hits: cacheHits, misses: texts.length - cacheHits, allHit,
  });

  if (allHit) {
    // Fast path：跳過 streaming + Gemini call，立即推 FIRST_CHUNK + 各 SEGMENT + DONE
    inFlightStreams.delete(streamId);  // 不需要 abort
    _stopStreamKeepAliveIfIdle();
    browser.tabs.sendMessage(tabId, { type: 'STREAMING_FIRST_CHUNK', payload: { streamId } }).catch(() => {});
    for (let i = 0; i < cached.length; i++) {
      browser.tabs.sendMessage(tabId, {
        type: 'STREAMING_SEGMENT',
        payload: { streamId, segmentIdx: i, translation: cached[i] },
      }).catch(() => {});
    }
    browser.tabs.sendMessage(tabId, {
      type: 'STREAMING_DONE',
      payload: {
        streamId,
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, billedInputTokens: 0, billedCostUSD: 0, cacheHits: texts.length },
        totalSegments: cached.length,
        hadMismatch: false,
        finishReason: 'STOP',
      },
    }).catch(() => {});
    return;
  }

  const ac = new AbortController();
  inFlightStreams.set(streamId, ac);
  _startStreamKeepAlive();

  let firstChunkSent = false;
  const onFirstChunk = () => {
    if (firstChunkSent) return;
    firstChunkSent = true;
    browser.tabs.sendMessage(tabId, {
      type: 'STREAMING_FIRST_CHUNK',
      payload: { streamId },
    }).catch(() => {});
  };
  const onSegment = (idx, translation, _hadMismatch) => {
    browser.tabs.sendMessage(tabId, {
      type: 'STREAMING_SEGMENT',
      payload: { streamId, segmentIdx: idx, translation },
    }).catch(() => {});
  };

  // v1.10.61: streaming 批次改「只補缺的」。原本只要這批有一段 miss(allHit=false)就把
  // 整批 texts 重送 Gemini(含已快取段落),跟 handleTranslate / openai-compat 的
  // missing-only 行為不一致 —— RSS feed 頂端插入新文章時,新段落落進 batch 0 會讓整批
  // 連已翻段落一起重打。改法:先把已快取段落以「原始 index」即刻回推給 content(等同
  // fast path 的零 API 重注入),只把 miss 的段落送 translateBatchStream;由於 stream 的
  // onSegment 給的是 missingTexts 內的 index,要 remap 回原始 index(content 端 segmentIdx
  // 必須對應 job.texts,見 content.js STREAMING_SEGMENT 處理的 idx < job.texts.length 驗證)。
  const { missingIdxs, missingTexts, cachedSegments } = planStreamingPartialReuse(cached, texts);
  debugLog('info', 'cache', 'streaming batch partial reuse', {
    streamId, total: texts.length, reusedFromCache: cacheHits, streamedMissing: missingTexts.length,
  });

  try {
    // 已快取段落即刻回推(content 走 idle gate 注入,跟 fast path 同一條路徑)
    onFirstChunk();
    for (const seg of cachedSegments) onSegment(seg.idx, seg.translation, false);

    const result = await translateBatchStream(
      missingTexts,
      effectiveSettings,
      glossary,
      fixedGlossaryEntries,
      forbiddenTermsList.length > 0 ? forbiddenTermsList : null,
      { onFirstChunk, onSegment: (mIdx, tr, hm) => onSegment(missingIdxs[mIdx], tr, hm) },
      ac.signal,
    );

    // v1.8.1: 寫回 cache（使用跟 handleTranslate 一致的 keySuffix)，下次重翻可命中 fast path
    // v1.10.46: hadMismatch 時不寫 — translateBatchStream 不做逐段 fallback,mismatch 的
    // translations 是錯位陣列,以 texts[i]→translations[i] 配對寫進去會永久污染快取
    if (!result.hadMismatch && result.translations && result.translations.length > 0) {
      // setBatch 內部會跳過 falsy translations，且 length 不對齊時也只寫對齊的那部分
      const writableTexts = [];
      const writableTranslations = [];
      for (let i = 0; i < missingTexts.length && i < result.translations.length; i++) {
        // v2.0.52: echo segment 不寫快取(見 handleTranslate 同款防護)
        if (result.translations[i]
            && !isSuspectEchoTranslation(missingTexts[i], result.translations[i], settings.targetLanguage)) {
          writableTexts.push(missingTexts[i]);
          writableTranslations.push(result.translations[i]);
        }
      }
      if (writableTexts.length > 0) {
        await cache.setBatch(writableTexts, writableTranslations, cacheKeySuffix);
        debugLog('info', 'cache', 'streaming batch cache write', {
          streamId, written: writableTexts.length,
        });
      }
    }

    // 計費（跟 handleTranslate 一致）
    // v1.9.2: cache 命中折扣從 effectivePricing.cachedDiscount 讀取(預設 Gemini 90% off)
    const cachedRate = pricingToCachedRate(effectivePricing) ?? 0.10;
    const cachedSavedRatio = 1 - cachedRate;
    const billedInputTokens = Math.max(
      0,
      Math.round(result.usage.inputTokens - (result.usage.cachedTokens || 0) * cachedSavedRatio),
    );
    const billedCostUSD = computeBilledCostUSD(
      result.usage.inputTokens,
      result.usage.cachedTokens || 0,
      result.usage.outputTokens,
      effectivePricing,
      cachedRate,
    );

    // hadMismatch:content 端會在累計 pageUsage 之前 reject 觸發 non-streaming 重翻，
    // 這批 full generation 的 usage 沒人記——由 background 直接入帳(重翻那輪照常由
    // content LOG_USAGE，不重複計)。
    if (result.hadMismatch) {
      await logDiscardedStreamUsage(result.usage, 'mismatch-discarded', missingTexts.length);
    }

    browser.tabs.sendMessage(tabId, {
      type: 'STREAMING_DONE',
      payload: {
        streamId,
        usage: {
          ...result.usage,
          billedInputTokens,
          billedCostUSD,
          // v1.10.61: 帶上本批已快取段數,讓 content 端 pickRescanToast 正確判定純快取
          // (否則 missing-only 後「只剩少數真送 API」會被誤報成整批新翻)
          cacheHits,
        },
        totalSegments: texts.length,
        hadMismatch: result.hadMismatch,
        finishReason: result.finishReason,
      },
    }).catch(() => {});
  } catch (err) {
    // 取消 / 中途失敗都可能已產生計費 token(translateBatchStream 掛在 err.usage)
    await logDiscardedStreamUsage(err?.usage, ac.signal.aborted ? 'aborted' : 'error', missingTexts.length);
    if (ac.signal.aborted || /aborted/i.test(err?.message || '')) {
      browser.tabs.sendMessage(tabId, {
        type: 'STREAMING_ABORTED',
        payload: { streamId },
      }).catch(() => {});
    } else {
      debugLog('error', 'api', 'streaming translateBatch failed', { streamId, error: err?.message || String(err) });
      browser.tabs.sendMessage(tabId, {
        type: 'STREAMING_ERROR',
        payload: { streamId, ...errorFields(err), atSegment: 0 },
      }).catch(() => {});
    }
  } finally {
    inFlightStreams.delete(streamId);
    _stopStreamKeepAliveIfIdle();
  }
}

// pricingOverride：傳入時（如 YouTube 獨立計價）使用；null 則沿用 settings.pricing
async function handleTranslate(payload, sender, geminiOverrides = {}, pricingOverride = null, cacheTag = '', applyFixedGlossary = true, applyForbiddenTerms = true) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    throw codedError('apiKeyMissing', null, '尚未設定 Gemini API Key，請至設定頁填入。');
  }
  const texts = payload.texts;
  const glossary = payload.glossary || null;  // v0.69: 可選的術語對照表

  // 若呼叫端傳入 geminiOverrides（如字幕模式），覆蓋 geminiConfig 對應欄位。
  // pricingOverride（v1.2.39）：字幕模式可傳入獨立計價，否則沿用主設定 pricing。
  // P1: 若 caller 沒覆蓋 systemInstruction(網頁主翻譯路徑),依 targetLanguage 切 universal/zh-TW prompt;
  //     caller 已覆蓋(字幕 / 文件 / ASR 路徑)── 那邊已自行呼叫 getEffective*Prompt,這裡不再二次處理。
  const baseSI = ('systemInstruction' in geminiOverrides)
    ? geminiOverrides.systemInstruction
    : getEffectiveSystemPrompt(settings.targetLanguage, settings.geminiConfig?.systemInstruction);
  const effectiveSettings = {
    ...settings,
    geminiConfig: { ...settings.geminiConfig, ...geminiOverrides, systemInstruction: baseSI },
  };
  // v2.0.11：文件翻譯每批段數（translate-doc 頁隨 payload 送，只有 TRANSLATE_DOC_BATCH*
  // 會帶)。覆蓋頂層 maxUnitsPerBatch → gemini.js packChunks 以此切 API 請求
  if (Number.isInteger(payload.docBatchSize) && payload.docBatchSize >= 1 && payload.docBatchSize <= 100) {
    effectiveSettings.maxUnitsPerBatch = payload.docBatchSize;
  }
  // v1.4.12: preset 帶 modelOverride 時，從內建表查對應 model 的 pricing，
  // 確保 toast / usage log 的費用與 model 一致（Flash Lite $0.25/$1.50、Flash $0.50/$3.00）。
  // 優先順序：pricingOverride（字幕獨立計價） > modelOverride 查表 > settings.pricing
  let effectivePricing = pricingOverride;
  if (!effectivePricing && geminiOverrides.model) {
    // v1.6.14: 帶 settings 讓 getPricingForModel 先查使用者的 modelPricingOverrides,
    // 沒有 override 才 fallback 內建表（Google 改價時使用者能自己更新單價）。
    effectivePricing = getPricingForModel(geminiOverrides.model, settings);
  }
  if (!effectivePricing) {
    effectivePricing = settings.pricing;
  }

  // v1.0.29: 讀取固定術語表（全域 + 當前網域），合併後傳給 translateBatch
  // v1.5.8: 字幕路徑（applyFixedGlossary=false）跳過讀取，省 prompt token
  let fixedGlossaryEntries = buildFixedGlossaryEntries(
    applyFixedGlossary ? settings.fixedGlossary : null,
    sender,
  );

  // v1.8.49: preferArticleGlossary 時（文件翻譯 path 帶來)，把跟文章術語表同 source 的
  // fixed entry 從 fixedGlossary 移除，讓 article 完全 override fixed(不靠 LLM 判斷
  // 優先級，直接從 prompt 拿掉避免衝突)
  fixedGlossaryEntries = preferArticleGlossaryEntries(
    fixedGlossaryEntries,
    payload?.glossary,
    payload?.preferArticleGlossary,
  );

  // v1.5.6: 中國用語黑名單。從 settings 讀清單後一路傳到 translateBatch（注入到 systemInstruction），
  // 同時計算 hash 加進 cache key 後綴，讓使用者修改清單後既有快取自動失效。
  // 空清單時 hash 為空字串，不附加後綴，向下相容既有 v1.5.5 之前的快取 key。
  // v1.5.8: 字幕路徑（applyForbiddenTerms=false）跳過，省 prompt token。
  const forbiddenTermsList = mergeExtraForbiddenTerms(
    (applyForbiddenTerms && Array.isArray(settings.forbiddenTerms)) ? settings.forbiddenTerms : [],
    payload?.extraForbiddenTerms,
  );

  // v1.4.12: cacheTag 由呼叫端明確指定（'_yt' = 字幕模式 / '' = 網頁翻譯含 preset）。
  // 不再用 geminiOverrides 是否有值來判斷，因為 preset 快速鍵也會傳 { model } override，
  // 會被誤判為字幕模式污染快取。組裝規則見 buildCacheKeySuffix（v1.10.46 起三條路徑
  // 共用單一資料源）。
  const glossaryKeySuffix = await buildCacheKeySuffix({
    cacheTag,
    glossary,
    fixedGlossaryEntries,
    forbiddenTermsList,
    modelKeyPart: (effectiveSettings.geminiConfig?.model || 'unknown').replace(/[^a-z0-9.\-]/gi, '_'),
    targetLanguage: effectiveSettings.targetLanguage,
    // W7：只有文件翻譯路徑帶 temperature 進 key（改文件獨立 temperature 後立即生效）
    docTemperature: cacheTag === '_doc' ? effectiveSettings.geminiConfig?.temperature : undefined,
    // 本文件額外翻譯指令（2026-07-27）：只有文件翻譯路徑帶進 key
    docExtraPrompt: cacheTag === '_doc' ? docExtraPromptOf(payload) : '',
  });

  // 1. 先撈快取
  const cached = await cache.getBatch(texts, glossaryKeySuffix);
  const missingIdxs = [];
  const missingTexts = [];
  cached.forEach((tr, i) => {
    if (tr == null) {
      missingIdxs.push(i);
      missingTexts.push(texts[i]);
    }
  });

  const cacheHits = texts.length - missingTexts.length;
  debugLog('info', 'cache', 'batch cache lookup', {
    total: texts.length,
    hits: cacheHits,
    misses: missingTexts.length,
  });

  // 2. 缺的部分送 Gemini
  let fresh = [];
  let batchUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let batchCostUSD = 0;
  // v0.48: hoist 到 if 外面，讓後面組 return usage 能讀到
  let billedInputTokens = 0;
  let billedCostUSD = 0;
  let batchHadMismatch = false; // v0.94: hoist 到 if 外面，讓 return 讀得到 hadMismatch
  if (missingTexts.length) {
    const t0 = Date.now();
    const totalChars = missingTexts.reduce((s, t) => s + (t?.length || 0), 0);
    debugLog('info', 'api', 'translateBatch start', { texts: missingTexts.length, chars: totalChars });
    let res;
    try {
      res = await translateBatch(missingTexts, effectiveSettings, glossary, fixedGlossaryEntries, forbiddenTermsList);
    } catch (err) {
      // v1.10.46(批次 2-5):多 chunk 中途失敗時前面 chunk 已付費(translateBatch 把
      // 累積 usage 掛在 err.usage)。content 端收到 error 不會發 LOG_USAGE,這筆錢若不
      // 在這裡直接記進 usage-db 就永遠漏帳(對帳系統性低估)。記完原樣 rethrow。
      const partialUsage = err?.usage;
      if (partialUsage && (partialUsage.inputTokens > 0 || partialUsage.outputTokens > 0)) {
        try {
          const cachedRate = pricingToCachedRate(effectivePricing) ?? 0.10;
          const cachedSavedRatio = 1 - cachedRate;
          await usageDB.logTranslation({
            url: sender?.tab?.url || '',
            title: sender?.tab?.title || '',
            inputTokens: partialUsage.inputTokens,
            outputTokens: partialUsage.outputTokens,
            cachedTokens: partialUsage.cachedTokens || 0,
            billedInputTokens: Math.max(0, Math.round(
              partialUsage.inputTokens - (partialUsage.cachedTokens || 0) * cachedSavedRatio,
            )),
            billedCostUSD: computeBilledCostUSD(
              partialUsage.inputTokens,
              partialUsage.cachedTokens || 0,
              partialUsage.outputTokens,
              effectivePricing,
              cachedRate,
            ),
            segments: missingTexts.length,
            cacheHits,
            timestamp: Date.now(),
            engine: 'gemini',
            model: effectiveSettings.geminiConfig?.model || 'unknown',
            // 批次中途失敗的已付費部分(結果丟棄,錢有花)
            partialFailure: true,
          });
          debugLog('warn', 'api', 'translateBatch failed mid-way — partial usage logged', {
            inputTokens: partialUsage.inputTokens,
            outputTokens: partialUsage.outputTokens,
            error: err?.message,
          });
        } catch (_) { /* 記帳失敗不影響原錯誤回報 */ }
      }
      throw err;
    }
    fresh = res.translations;
    batchUsage = res.usage;
    batchHadMismatch = res.hadMismatch || false; // v0.94: mismatch 旗標

    // v1.5.6: 翻譯成功後掃描黑名單詞，命中時用 debugLog 寫一條 forbidden-term-leak warn。
    // 純記錄、不修改譯文（修改交給 prompt，硬規則 §7）。adapter 把 detect 函式的
    // logger.warn(category, message, data) 介面轉成 debugLog('warn', category, message, data)。
    detectForbiddenTermLeaks(fresh, missingTexts, forbiddenTermsList, {
      warn: (category, message, data) => debugLog('warn', category, message, data),
    });
    batchCostUSD = computeCostUSD(batchUsage.inputTokens, batchUsage.outputTokens, effectivePricing);
    const batchMs = Date.now() - t0;
    debugLog('info', 'api', 'translateBatch done', {
      count: missingTexts.length,
      chars: totalChars,
      elapsed: batchMs,
      inputTokens: batchUsage.inputTokens,
      outputTokens: batchUsage.outputTokens,
      cachedTokens: batchUsage.cachedTokens || 0,
      costUSD: batchCostUSD,
      tabUrl: sender?.tab?.url,
    });
    // 3. 寫回快取（帶 glossary suffix 確保有/無術語表分開存）
    // v2.0.52: echo segment(譯文=原文且原文非 target 字系,如「えっ?」被原樣返回)
    // 不寫快取——結果照樣回給呼叫端,但下次翻譯重試而非永遠命中壞快取
    {
      const cacheable = filterEchoPairsForCache(missingTexts, fresh, settings.targetLanguage);
      if (cacheable.skipped > 0) {
        debugLog('warn', 'cache', 'echo translations not cached', { skipped: cacheable.skipped });
      }
      await cache.setBatch(cacheable.texts, cacheable.translations, glossaryKeySuffix);
    }
    // 3.5 累計到全域使用量統計
    // v0.48: 改為累計「實付」值（套用 implicit cache 折扣後的等效 input tokens
    // 與實付費用），讓 popup 累計顯示的 token / 費用等於 Gemini 帳單實際扣款。
    // v1.9.2: cache 命中折扣從 effectivePricing.cachedDiscount 讀(預設 Gemini 90% off);
    //         舊硬編 0.75 是 Gemini 2.0 時代值,2.5+ 起應為 0.90。
    const cachedRate = pricingToCachedRate(effectivePricing) ?? 0.10;
    const cachedSavedRatio = 1 - cachedRate;
    billedInputTokens = Math.max(
      0,
      Math.round(batchUsage.inputTokens - (batchUsage.cachedTokens || 0) * cachedSavedRatio),
    );
    billedCostUSD = computeBilledCostUSD(
      batchUsage.inputTokens,
      batchUsage.cachedTokens || 0,
      batchUsage.outputTokens,
      effectivePricing,
      cachedRate,
    );
  }

  // 4. 合併結果（快取 + 新翻譯）按原順序回傳
  const result = cached.slice();
  missingIdxs.forEach((idx, k) => {
    result[idx] = fresh[k];
  });
  return {
    result,
    usage: {
      // 原始（未套 implicit cache 折扣）數字，保留給 content 端算 hit% / saved%
      inputTokens: batchUsage.inputTokens,
      outputTokens: batchUsage.outputTokens,
      // Gemini implicit context cache 命中的輸入 token 數（v0.46 新增）。
      // 注意這跟下面的 `cacheHits`（本地 tc_<sha1> 翻譯快取命中段數） 是兩回事。
      cachedTokens: batchUsage.cachedTokens || 0,
      costUSD: batchCostUSD,
      // v0.48: 套 implicit cache 折扣後的「實付」數字。toast 與 popup 都顯示這組
      billedInputTokens,
      billedCostUSD,
      cacheHits,
    },
    // v0.94: 本批翻譯是否觸發了 segment mismatch fallback
    hadMismatch: batchHadMismatch,
  };
}

// ─── v1.5.7: API Key 測試（設定頁「測試」按鈕觸發）─────────────
//
// 設計：兩條 endpoint 各有對應的最便宜驗證方式。回傳統一結構
// { ok: boolean, status?: number, message: string }，options 端只看訊息顯示綠/紅。

/**
 * 測試 Gemini API Key 有效性。
 * 走 `GET models/<model>`（key 走 `x-goog-api-key` header）——不耗 token，能驗 key 有效 + model 存在。
 */
// 測試按鈕 / 一次性 fetch 共用的 timeout 包裝——對已掛掉 / 防火牆 drop 封包的
// endpoint，裸 fetch 會吊在瀏覽器預設逾時（可達數分鐘），按鈕卡「測試中」無回饋。
// 主翻譯路徑各自有 fetchWithRetry / AbortController，這裡只給輔助請求用。
async function fetchWithTimeout(url, init = {}, timeoutMs = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function testGeminiKey(payload) {
  const apiKey = (payload?.apiKey || '').trim();
  const model = (payload?.model || 'gemini-3-flash-preview').trim();
  if (!apiKey) return { ok: false, message: 'API Key 為空，請先填入再測試。' };
  // API key 走 x-goog-api-key header,不放 URL(避免金鑰漏進會記 URL 的 proxy / log)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`;
  try {
    const resp = await fetchWithTimeout(url, { method: 'GET', headers: { 'x-goog-api-key': apiKey } }, 10000);
    if (resp.ok) {
      const j = await resp.json().catch(() => ({}));
      return { ok: true, status: resp.status, message: `連線成功（model: ${j?.name || model}）` };
    }
    let errMsg = `HTTP ${resp.status}`;
    try { const j = await resp.json(); errMsg = j?.error?.message || errMsg; } catch { /* noop */ }
    return { ok: false, status: resp.status, message: errMsg };
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, message: '連線逾時，請確認網址與網路狀態。' };
    return { ok: false, message: '網路錯誤：' + (err?.message || String(err)) };
  }
}

/**
 * 測試自訂 OpenAI-compatible Provider。
 * 走 `POST /chat/completions` + 「ping」訊息，同時驗證 baseUrl / model / apiKey
 * 三者皆正確。比 GET /models 通用（部分 provider 不支援 GET /models)。
 *
 * v1.8.43：不送 max_tokens——GPT-5 / o1 / o3 系列拒收 max_tokens 改認
 * max_completion_tokens，而 OpenRouter / DeepSeek / 較舊 OpenAI-compat 後端
 * 不一定認新欄位，改一個 break 一群。實際翻譯路徑（lib/openai-compat.js)
 * 本來就不送 max_tokens，測試路徑對齊即可。ping 訊息 server 自然回 1-3 token,
 * 沒 limit 也不會失控。
 */
async function testCustomProvider(payload) {
  const baseUrl = (payload?.baseUrl || '').trim().replace(/\/+$/, '');
  const model = (payload?.model || '').trim();
  const apiKey = (payload?.apiKey || '').trim();
  if (!baseUrl) return { ok: false, message: 'Base URL 為空。' };
  // v1.6.7: API Key 允許為空（本機 llama.cpp / Ollama 等不需要 key）。商用後端
  // 若漏填會自然回 401，錯誤訊息由 provider 提供（例如 OpenAI: "Incorrect API key"）。
  // v1.8.41:Model ID 也允許為空（llama.cpp 啟動時鎖 model,body 不送 model 欄位即用 server 預設）。
  // 商用後端（OpenAI / OpenRouter / DeepSeek）會自然回「model required」4xx，讓 provider error 自己講話。

  const url = /\/chat\/completions$/.test(baseUrl) ? baseUrl : baseUrl + '/chat/completions';
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const reqBody = {
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
    };
    if (model) reqBody.model = model;
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(reqBody),
    }, 10000);
    if (resp.ok) {
      const j = await resp.json().catch(() => ({}));
      const used = j?.usage?.total_tokens || j?.usage?.prompt_tokens || 0;
      const modelLabel = model || j?.model || 'server-default';
      return { ok: true, status: resp.status, message: `連線成功（${modelLabel}，本次用量約 ${used} tokens）` };
    }
    let errMsg = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      errMsg = j?.error?.message || j?.message || errMsg;
    } catch { /* noop */ }
    return { ok: false, status: resp.status, message: errMsg };
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, message: '連線逾時，請確認網址與網路狀態。' };
    return { ok: false, message: '網路錯誤：' + (err?.message || String(err)) };
  }
}

// ─── v1.5.7: OpenAI-compatible 自訂 Provider 批次處理 ─────────
// 與 handleTranslate（Gemini）不同：429 交由 fetchWithRetry 退避處理，cache key
// 用 _oc base tag + baseUrl hash + safe model 分區，計價來自 customProvider 自填。
// 與 Gemini 共用：fixedGlossary、forbiddenTerms、自動 glossary 注入、cache module。
async function handleTranslateCustom(payload, sender, cacheTag = '_oc', cpOverrides = null, applyFixedGlossary = true, applyForbiddenTerms = true) {
  const settings = await getSettings();
  // v1.5.8: cpOverrides 給字幕路徑覆蓋特定欄位（例如 systemPrompt 改用字幕專屬），
  // 其他欄位（baseUrl / model / apiKey / 計價）仍走「自訂模型」分頁主設定。
  const cp = { ...(settings.customProvider || {}), ...(cpOverrides || {}) };
  // P1 (v1.8.59):cp.systemPrompt 走 getEffective(target-aware,跟 Gemini 主翻譯路徑對齊)。
  // cpOverrides 已含 systemPrompt(字幕 / ASR caller 自帶 effective)→ 不再二次處理;
  // cpOverrides 沒覆蓋 systemPrompt(主路徑)→ 在這裡 wrap getEffective。
  if (!cpOverrides || !('systemPrompt' in cpOverrides)) {
    cp.systemPrompt = getEffectiveSystemPrompt(settings.targetLanguage, cp.systemPrompt);
  }
  // v1.6.7: API Key 允許為空（本機 llama.cpp / Ollama 等不需要 key)；商用後端漏填會自然 401
  // v1.8.41 對齊：Model 也允許為空（llama.cpp / Ollama 啟動時鎖 model,adapter 不送
  // model 欄位讓 server 用啟動 model)— lib/openai-compat.js translateChunk 本來就支援，
  // 之前在這裡提早擋下會讓 local server 配置失敗（空 model 行為應跟 adapter 一致)。
  if (!cp.baseUrl) throw codedError('baseUrlMissing', null, '尚未設定自訂 Provider 的 Base URL。');

  const texts = payload.texts;
  const glossary = payload.glossary || null;

  // 重用 handleTranslate 內的 fixedGlossary 合併邏輯
  // v1.5.8: 字幕路徑（applyFixedGlossary=false）跳過
  let fixedGlossaryEntries = buildFixedGlossaryEntries(
    applyFixedGlossary ? settings.fixedGlossary : null,
    sender,
  );

  // preferArticleGlossary dedup: article glossary overrides fixed entries with same source
  fixedGlossaryEntries = preferArticleGlossaryEntries(
    fixedGlossaryEntries,
    payload?.glossary,
    payload?.preferArticleGlossary,
  );

  // v1.5.8: 字幕路徑（applyForbiddenTerms=false）跳過
  const forbiddenTermsList = mergeExtraForbiddenTerms(
    (applyForbiddenTerms && Array.isArray(settings.forbiddenTerms)) ? settings.forbiddenTerms : [],
    payload?.extraForbiddenTerms,
  );

  // Cache key：'_oc' （網頁） / '_oc_yt' （字幕） base tag，組裝規則見 buildCacheKeySuffix
  // （v1.10.46 起三條路徑共用單一資料源）。
  // baseUrl hash 6 字元 + safe model — 避免不同 provider 同 model name 共用快取
  const baseUrlHash = (await cache.hashText(cp.baseUrl)).slice(0, 6);
  const safeModel = String(cp.model).replace(/[^a-z0-9.\-]/gi, '_');
  const suffix = await buildCacheKeySuffix({
    cacheTag,
    glossary,
    fixedGlossaryEntries,
    forbiddenTermsList,
    modelKeyPart: `${baseUrlHash}_${safeModel}`,
    targetLanguage: settings.targetLanguage,
    docTemperature: cacheTag === '_oc_doc' ? cp.temperature : undefined,
    // 本文件額外翻譯指令（2026-07-27）：只有文件翻譯路徑帶進 key
    docExtraPrompt: cacheTag === '_oc_doc' ? docExtraPromptOf(payload) : '',
  });

  // 1. 撈快取
  const cached = await cache.getBatch(texts, suffix);
  const missingIdxs = [];
  const missingTexts = [];
  cached.forEach((tr, i) => {
    if (tr == null) {
      missingIdxs.push(i);
      missingTexts.push(texts[i]);
    }
  });
  const cacheHits = texts.length - missingTexts.length;
  debugLog('info', 'cache', 'openai-compat batch cache lookup', {
    total: texts.length, hits: cacheHits, misses: missingTexts.length,
  });

  // 2. 缺的部分送 OpenAI-compat
  let fresh = [];
  let batchUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let batchCostUSD = 0;
  let batchHadMismatch = false;
  if (missingTexts.length) {
    const t0 = Date.now();
    const totalChars = missingTexts.reduce((s, t) => s + (t?.length || 0), 0);
    debugLog('info', 'api', 'openai-compat translateBatch start', {
      texts: missingTexts.length, chars: totalChars, baseUrl: cp.baseUrl, model: cp.model,
    });
    // P1 (v1.8.59):translateBatchCustom 內部讀 settings.customProvider.systemPrompt,
    // 把已 wrap 過 effective prompt 的 cp 寫回 settings.customProvider 才能讓 LLM 端拿到對的 prompt。
    const effSettings = { ...settings, customProvider: cp };
    // v2.0.11：文件翻譯每批段數（同 handleTranslate，openai-compat packChunks 讀
    // settings.maxUnitsPerBatch)
    if (Number.isInteger(payload.docBatchSize) && payload.docBatchSize >= 1 && payload.docBatchSize <= 100) {
      effSettings.maxUnitsPerBatch = payload.docBatchSize;
    }
    let res;
    try {
      res = await translateBatchCustom(missingTexts, effSettings, glossary, fixedGlossaryEntries, forbiddenTermsList);
    } catch (err) {
      // 對齊 handleTranslate 的 v1.10.46 批次 2-5 修法：多 chunk 中途失敗時前面 chunk
      // 已付費(translateBatchCustom 把累積 usage 掛在 err.usage)。content 端收到 error
      // 不會發 LOG_USAGE，不在這裡記進 usage-db 就永遠漏帳。記完原樣 rethrow。
      const partialUsage = err?.usage;
      if (partialUsage && (partialUsage.inputTokens > 0 || partialUsage.outputTokens > 0)) {
        try {
          const pricingCp = { inputPerMTok: cp.inputPerMTok || 0, outputPerMTok: cp.outputPerMTok || 0 };
          const rateCp = resolveCustomProviderCachedRate(cp);
          await usageDB.logTranslation({
            url: sender?.tab?.url || '',
            title: sender?.tab?.title || '',
            inputTokens: partialUsage.inputTokens,
            outputTokens: partialUsage.outputTokens,
            cachedTokens: partialUsage.cachedTokens || 0,
            billedInputTokens: Math.max(0, Math.round(
              partialUsage.inputTokens - (partialUsage.cachedTokens || 0) * (1 - rateCp),
            )),
            billedCostUSD: computeBilledCostUSD(
              partialUsage.inputTokens,
              partialUsage.cachedTokens || 0,
              partialUsage.outputTokens,
              pricingCp,
              rateCp,
            ),
            segments: missingTexts.length,
            cacheHits,
            timestamp: Date.now(),
            engine: 'openai-compat',
            model: cp.model || 'server-default',
            partialFailure: true,
          });
          debugLog('warn', 'api', 'openai-compat translateBatch failed mid-way — partial usage logged', {
            inputTokens: partialUsage.inputTokens,
            outputTokens: partialUsage.outputTokens,
            error: err?.message,
          });
        } catch (_) { /* 記帳失敗不影響原錯誤回報 */ }
      }
      throw err;
    }
    fresh = res.translations;
    batchUsage = res.usage;
    batchHadMismatch = res.hadMismatch || false;
    batchCostUSD = computeCostUSD(batchUsage.inputTokens, batchUsage.outputTokens, {
      inputPerMTok: cp.inputPerMTok || 0,
      outputPerMTok: cp.outputPerMTok || 0,
    });
    const batchMs = Date.now() - t0;
    debugLog('info', 'api', 'openai-compat translateBatch done', {
      count: missingTexts.length,
      chars: totalChars,
      elapsed: batchMs,
      inputTokens: batchUsage.inputTokens,
      outputTokens: batchUsage.outputTokens,
      cachedTokens: batchUsage.cachedTokens || 0,
      costUSD: batchCostUSD,
    });

    // 3. 翻譯成功後掃黑名單漏網（純記錄）
    detectForbiddenTermLeaks(fresh, missingTexts, forbiddenTermsList, {
      warn: (category, message, data) => debugLog('warn', category, message, data),
    });

    // 4. 寫回快取
    // v2.0.52: echo segment 不寫快取(見 handleTranslate 同款防護)
    {
      const cacheable = filterEchoPairsForCache(missingTexts, fresh, settings.targetLanguage);
      if (cacheable.skipped > 0) {
        debugLog('warn', 'cache', 'echo translations not cached (custom)', { skipped: cacheable.skipped });
      }
      await cache.setBatch(cacheable.texts, cacheable.translations, suffix);
    }
  }

  // 6. 合併結果
  const result = cached.slice();
  missingIdxs.forEach((idx, k) => { result[idx] = fresh[k]; });

  // v1.9.2: cache 命中折扣優先讀 cp.cachedDiscount,沒填 fallback baseUrl 自動推導
  const cachedRate = resolveCustomProviderCachedRate(cp);
  const cachedSavedRatio = 1 - cachedRate;
  return {
    result,
    usage: {
      inputTokens: batchUsage.inputTokens,
      outputTokens: batchUsage.outputTokens,
      cachedTokens: batchUsage.cachedTokens || 0,
      costUSD: batchCostUSD,
      billedInputTokens: Math.max(
        0, Math.round(batchUsage.inputTokens - (batchUsage.cachedTokens || 0) * cachedSavedRatio),
      ),
      billedCostUSD: computeBilledCostUSD(
        batchUsage.inputTokens,
        batchUsage.cachedTokens || 0,
        batchUsage.outputTokens,
        { inputPerMTok: cp.inputPerMTok || 0, outputPerMTok: cp.outputPerMTok || 0 },
        cachedRate,
      ),
      cacheHits,
    },
    hadMismatch: batchHadMismatch,
  };
}

// ─── v1.4.0: Google Translate 批次處理 ────────────────────────
// 與 handleTranslate 不同：不走術語表、費用 $0。
// cacheSuffix：網頁翻譯用 '_gt'，字幕翻譯用 '_gt_yt'，確保快取與 Gemini 分開存放。
// v1.8.61: targetLanguage 透傳給 translateGoogleBatch + 進 cache key,
// zh-TW 不加 lang suffix(向下相容,既有 _gt cache 仍 hit),其他 target 加 _lang<x>。
async function handleTranslateGoogle(payload, sender, cacheSuffix) {
  const texts = payload?.texts;
  if (!Array.isArray(texts) || texts.length === 0) {
    return { result: [], usage: { engine: 'google', chars: 0 } };
  }

  const settings = await getSettings();
  const tl = settings.targetLanguage || 'zh-TW';
  const effectiveCacheSuffix = (tl && tl !== 'zh-TW')
    ? cacheSuffix + '_lang' + tl.replace(/[^a-z0-9]/gi, '')
    : cacheSuffix;

  // 1. 先查快取（與 Gemini 快取共用 cache module，但 key suffix 不同）
  const cached = await cache.getBatch(texts, effectiveCacheSuffix);
  const missingIdxs = [];
  const missingTexts = [];
  cached.forEach((tr, i) => {
    if (tr == null) {
      missingIdxs.push(i);
      missingTexts.push(texts[i]);
    }
  });

  const cacheHits = texts.length - missingTexts.length;
  debugLog('info', 'cache', 'google batch cache lookup', {
    total: texts.length, hits: cacheHits, misses: missingTexts.length, tl,
  });

  // 2. 缺失的部分呼叫 Google Translate
  let fresh = [];
  let totalChars = 0;
  if (missingTexts.length > 0) {
    const t0 = Date.now();
    debugLog('info', 'api', 'google translateBatch start', { count: missingTexts.length, tl });
    const res = await translateGoogleBatch(missingTexts, tl);
    fresh = res.translations;
    totalChars = res.chars;
    debugLog('info', 'api', 'google translateBatch done', {
      count: missingTexts.length,
      chars: totalChars,
      elapsed: Date.now() - t0,
      tl,
    });

    // 3. 寫回快取
    await cache.setBatch(missingTexts, fresh, effectiveCacheSuffix);

    // 4. 記錄用量（費用 $0，以字元計）
    // v1.5.7: 走 upsertGoogleUsage 合併同一篇 URL 一小時內的批次到單一紀錄，
    // 避免一篇 BBC 長文炸出 5–20 筆同 URL Google MT entry。
    await usageDB.upsertGoogleUsage({
      url: sender?.tab?.url || '',
      title: '',
      engine: 'google',
      model: 'google-translate',
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      billedInputTokens: 0,
      billedCostUSD: 0,
      chars: totalChars,
      segments: missingTexts.length,
      cacheHits,
      durationMs: 0,
      timestamp: Date.now(),
    });
  }

  // 5. 合併結果
  const result = cached.slice();
  missingIdxs.forEach((idx, k) => { result[idx] = fresh[k]; });

  return {
    result,
    usage: { engine: 'google', chars: totalChars, cacheHits },
  };
}

// 術語表抽取模型解析（2026-07-10）：glossary.model 空字串 =「與主翻譯模型相同」。
// 「主翻譯」對文件翻譯是頁面 preset（payload.modelOverride），對網頁翻譯是全域
// geminiConfig.model——先前一律 fallback 全域模型，文件翻譯用非預設 preset 時
// 「與主翻譯模型相同」對不上實際翻譯模型
function resolveGlossaryModel(settings, modelOverride) {
  const own = (settings.glossary?.model || '').trim();
  if (own) return own;
  const override = (typeof modelOverride === 'string' && modelOverride.trim()) ? modelOverride.trim() : '';
  return override || settings.geminiConfig?.model || '';
}

// ─── v0.70: 術語表擷取處理（v0.69 建立，v0.70 加強除錯與容錯） ──
async function handleExtractGlossary(payload, sender) {
  debugLog('info', 'glossary', 'glossary extraction start', { inputHash: payload.inputHash, chars: payload.compressedText?.length });
  const settings = await getSettings();
  if (!settings.apiKey) {
    throw codedError('apiKeyMissing', null, '尚未設定 Gemini API Key，請至設定頁填入。');
  }
  const { compressedText, inputHash } = payload;

  // P1: glossary cache 也要依 target 區隔(同 source text 抽出的譯名 zh-TW vs zh-CN 必然不同)。
  // zh-TW 不加 suffix 維持向下相容,既有 zh-TW 使用者升級後 cache 仍 hit。
  const tl = settings.targetLanguage;
  const glossarySuffix = (tl && tl !== 'zh-TW') ? '_lang' + tl.replace(/[^a-z0-9]/gi, '') : '';

  // 1. 先查術語表快取。forceRefresh（「重新抽取」按鈕，v2.0.11）跳過快取讀取
  //    強制重跑 API——否則同文字同 hash 秒回快取，「重新抽取」形同沒按；
  //    新結果仍寫回快取
  const cached = payload.forceRefresh ? null : await cache.getGlossary(inputHash, glossarySuffix);
  if (cached) {
    debugLog('info', 'glossary', 'glossary cache hit', { inputHash, terms: cached.length });
    return { glossary: cached, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, fromCache: true };
  }

  // 2. 術語表是 best-effort 單次請求，extractGlossary 內部用 AbortController
  //    自帶 20 秒 fetch timeout 自保。
  debugLog('info', 'glossary', 'calling Gemini');

  // P1: glossary prompt 走 getEffective(zh-TW 走原 DEFAULT,其他走 UNIVERSAL 注入後)
  // v2.0.11：EPUB 書籍模式可帶 promptSuffix（角色暱稱 / 變體收錄規則，translate-doc 頁送）。
  // caller 需自行把 suffix 摻進 inputHash(gloss_ cache key 只看 caller 給的 hash),
  // 否則同文字不同 suffix 會吃到彼此的快取。
  const promptSuffix = (typeof payload.promptSuffix === 'string' && payload.promptSuffix.trim())
    ? '\n\n' + payload.promptSuffix.trim().slice(0, 2000)
    : '';
  const effGlossaryModel = resolveGlossaryModel(settings, payload.modelOverride);
  const glossaryEffSettings = {
    ...settings,
    glossary: {
      ...settings.glossary,
      prompt: getEffectiveGlossaryPrompt(tl, settings.glossary?.prompt) + promptSuffix,
      model: effGlossaryModel,
    },
  };

  // 3. 呼叫 Gemini 擷取術語表
  const result = await extractGlossary(compressedText, glossaryEffSettings);
  const { glossary, usage, _diag } = result;
  debugLog('info', 'glossary', 'Gemini returned glossary', { terms: glossary.length, usage, diag: _diag || null });

  // 4. 寫入快取（只快取有內容的術語表；空結果不快取，讓下次重試有機會成功）
  if (glossary.length > 0) {
    await cache.setGlossary(inputHash, glossary, glossarySuffix);
  }

  // 5. 記錄用量到 IndexedDB（source='glossary' 區分，跟主翻譯紀錄分流）。
  //    billedCostUSD 同時回給 caller——EPUB 頁把抽取費用累進「本書累計費用」
  let glossaryBilledCostUSD = 0;
  if (usage.inputTokens > 0 || usage.outputTokens > 0) {
    const glossaryModel = effGlossaryModel || 'unknown';
    const glossaryPricing = getPricingForModel(glossaryModel, settings) || settings.pricing;
    // v1.9.2: cache 命中折扣從 glossaryPricing.cachedDiscount 讀(預設 Gemini 90% off)
    const cachedRate = pricingToCachedRate(glossaryPricing) ?? 0.10;
    const cachedSavedRatio = 1 - cachedRate;
    const billedInputTokens = Math.max(
      0,
      Math.round(usage.inputTokens - (usage.cachedTokens || 0) * cachedSavedRatio),
    );
    glossaryBilledCostUSD = computeBilledCostUSD(
      usage.inputTokens,
      usage.cachedTokens || 0,
      usage.outputTokens,
      glossaryPricing,
      cachedRate,
    );
    await usageDB.logTranslation({
      url: sender?.tab?.url || '',
      title: sender?.tab?.title || '',
      engine: 'gemini',
      model: glossaryModel,
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      cachedTokens: usage.cachedTokens || 0,
      billedInputTokens,
      billedCostUSD: glossaryBilledCostUSD,
      segments: 0,
      cacheHits: 0,
      durationMs: 0,
      timestamp: Date.now(),
      source: 'glossary',
    });
  }

  debugLog('info', 'glossary', 'glossary extraction complete', {
    terms: glossary.length,
    inputHash,
    tabUrl: sender?.tab?.url,
  });

  return { glossary, usage: { ...usage, billedCostUSD: glossaryBilledCostUSD }, fromCache: false, _diag: _diag || null };
}

// 自訂 Provider 路徑術語表抽取。跟 handleExtractGlossary(Gemini）結構對齊：
// 先查快取 → API call → 寫快取 → 累計用量。差別只在 API endpoint(走
// lib/openai-compat.js extractGlossary)、不檢查 Gemini API Key(自訂 Provider
// 可不填 key，例如本機 llama.cpp / Ollama)。
async function handleExtractGlossaryCustomProvider(payload, sender) {
  debugLog('info', 'glossary', 'openai-compat glossary extraction start', {
    inputHash: payload.inputHash, chars: payload.compressedText?.length,
  });
  const settings = await getSettings();
  const cp = settings.customProvider || {};
  if (!cp.baseUrl) {
    return { glossary: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, _diag: '尚未設定自訂 Provider 的 Base URL。' };
  }
  const { compressedText, inputHash } = payload;

  // P1: glossary cache 依 target 區隔(同 handleExtractGlossary)
  const tl = settings.targetLanguage;
  const glossarySuffix = (tl && tl !== 'zh-TW') ? '_lang' + tl.replace(/[^a-z0-9]/gi, '') : '';

  // 1. 先查術語表快取（共用 cache.getGlossary;_diag 內含 baseUrl/model/engine 影響的話
  //    可在 inputHash 計算時考量，目前 hash 只看 compressedText 跟 Gemini 路徑共享
  //    符合「同一份原文不同 engine 抽出的術語應該等價」假設)
  const cached = payload.forceRefresh ? null : await cache.getGlossary(inputHash, glossarySuffix);
  if (cached) {
    debugLog('info', 'glossary', 'openai-compat glossary cache hit', { inputHash, terms: cached.length });
    return { glossary: cached, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, fromCache: true };
  }

  // P1: glossary prompt 走 getEffective(zh-TW 走原 DEFAULT,其他走 UNIVERSAL 注入後)
  // v2.0.11: EPUB 書籍模式 promptSuffix(同 handleExtractGlossary,caller 摻 hash)
  const promptSuffix = (typeof payload.promptSuffix === 'string' && payload.promptSuffix.trim())
    ? '\n\n' + payload.promptSuffix.trim().slice(0, 2000)
    : '';
  const glossaryEffSettings = {
    ...settings,
    glossary: { ...settings.glossary, prompt: getEffectiveGlossaryPrompt(tl, settings.glossary?.prompt) + promptSuffix },
  };

  // 2. 呼叫自訂 Provider 抽術語表（extractGlossary 內部 best-effort，失敗回空陣列 + _diag)
  const result = await extractGlossaryCustom(compressedText, glossaryEffSettings);
  const { glossary, usage, _diag } = result;
  debugLog('info', 'glossary', 'openai-compat returned glossary', { terms: glossary.length, usage, diag: _diag || null });

  // 3. 寫入快取（只快取有內容的)
  if (glossary.length > 0) {
    await cache.setGlossary(inputHash, glossary, glossarySuffix);
  }

  // 4. 記錄用量到 IndexedDB（source='glossary' 區分，跟主翻譯紀錄分流）。
  //    billedCostUSD 同時回給 caller（同 handleExtractGlossary）
  let glossaryBilledCostUSD = 0;
  if (usage.inputTokens > 0 || usage.outputTokens > 0) {
    // v1.9.2: cache 命中折扣優先讀 cp.cachedDiscount,沒填 fallback baseUrl 自動推導
    const cachedRate = resolveCustomProviderCachedRate(cp);
    const cachedSavedRatio = 1 - cachedRate;
    const billedInputTokens = Math.max(
      0,
      Math.round(usage.inputTokens - (usage.cachedTokens || 0) * cachedSavedRatio),
    );
    const cpPricing = (cp.inputPerMTok || cp.outputPerMTok)
      ? { inputPerMTok: cp.inputPerMTok || 0, outputPerMTok: cp.outputPerMTok || 0 }
      : null;
    glossaryBilledCostUSD = computeBilledCostUSD(
      usage.inputTokens,
      usage.cachedTokens || 0,
      usage.outputTokens,
      cpPricing,
      cachedRate,
    );
    await usageDB.logTranslation({
      url: sender?.tab?.url || '',
      title: sender?.tab?.title || '',
      engine: 'openai-compat',
      model: cp.model || '<server-default>',
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      cachedTokens: usage.cachedTokens || 0,
      billedInputTokens,
      billedCostUSD: glossaryBilledCostUSD,
      segments: 0,
      cacheHits: 0,
      durationMs: 0,
      timestamp: Date.now(),
      source: 'glossary',
    });
  }

  debugLog('info', 'glossary', 'openai-compat glossary extraction complete', {
    terms: glossary.length, inputHash, tabUrl: sender?.tab?.url,
  });

  return { glossary, usage: { ...usage, billedCostUSD: glossaryBilledCostUSD }, fromCache: false, _diag: _diag || null };
}

// v2.0.11: EPUB 譯後一致性掃描——譯名對照抽取。結構鏡像 handleExtractGlossary：
// 快取（scanr_，key 由 caller 以 items 內容 hash 計算）→ API → 寫快取 → 記用量。
// 對照結果是「同 payload 同結果」的確定性映射 → 續翻後重掃、重開同書都吃快取，
// 不重複計費
async function handleScanTermRenderings(payload, sender) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    throw codedError('apiKeyMissing', null, '尚未設定 Gemini API Key，請至設定頁填入。');
  }
  const { items, inputHash } = payload;
  const cached = inputHash ? await cache.getScanRenderings(inputHash) : null;
  if (cached) {
    debugLog('info', 'scan', 'scan renderings cache hit', { inputHash, terms: cached.length });
    return { renderings: cached, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, billedCostUSD: 0 }, fromCache: true };
  }

  const result = await extractTermRenderings(items, settings);
  const { renderings, usage, _diag } = result;

  if (inputHash && renderings.length > 0) {
    await cache.setScanRenderings(inputHash, renderings);
  }

  let scanBilledCostUSD = 0;
  if (usage.inputTokens > 0 || usage.outputTokens > 0) {
    const scanModel = (settings.glossary?.model || '').trim() || settings.geminiConfig?.model || 'unknown';
    const scanPricing = getPricingForModel(scanModel, settings) || settings.pricing;
    const cachedRate = pricingToCachedRate(scanPricing) ?? 0.10;
    const cachedSavedRatio = 1 - cachedRate;
    const billedInputTokens = Math.max(
      0,
      Math.round(usage.inputTokens - (usage.cachedTokens || 0) * cachedSavedRatio),
    );
    scanBilledCostUSD = computeBilledCostUSD(
      usage.inputTokens,
      usage.cachedTokens || 0,
      usage.outputTokens,
      scanPricing,
      cachedRate,
    );
    await usageDB.logTranslation({
      url: sender?.tab?.url || '',
      title: sender?.tab?.title || '',
      engine: 'gemini',
      model: scanModel,
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      cachedTokens: usage.cachedTokens || 0,
      billedInputTokens,
      billedCostUSD: scanBilledCostUSD,
      segments: 0,
      cacheHits: 0,
      durationMs: 0,
      timestamp: Date.now(),
      source: 'scan',
    });
  }

  debugLog('info', 'scan', 'scan renderings complete', { terms: renderings.length, inputHash });
  return { renderings, usage: { ...usage, billedCostUSD: scanBilledCostUSD }, fromCache: false, _diag: _diag || null };
}

// ─── 快捷鍵 ────────────────────────────────────────────────
// v1.4.12: 三個 preset 快捷鍵（Alt+A/S/D 預設，可在 chrome://extensions/shortcuts 改）。
// 每個對應 translatePresets[slot-1]，由 content.js 依 preset.engine/model 派送。
// v1.8.19: chrome://extensions/shortcuts 顯示順序由 command id 字典序決定，
//   要讓「主要預設」排最前必須改 id 從「translate-preset-2」→「translate-preset-0」,
//   storage 內仍維持 slot 1/2/3 編號，故 command id 0 → slot 2 mapping 寫死。
const COMMAND_ID_TO_SLOT = { 0: 2, 1: 1, 3: 3 };
browser.commands.onCommand.addListener(async (command) => {
  // 送到 Instapaper（Alt+I）：走背景 OAuth + fetch，回饋走 content toast。
  if (command === 'send-to-instapaper') {
    handleSendToInstapaperCommand().catch(() => {});
    return;
  }
  const match = command.match(/^translate-preset-(\d+)$/);
  if (!match) return;
  const cmdNum = Number(match[1]);
  const slot = COMMAND_ID_TO_SLOT[cmdNum];
  if (!slot) return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  // 在 chrome://、Chrome Web Store、新分頁等頁面按快捷鍵時，該 tab 沒有
  // content script listening,sendMessage 會 reject:
  //   "Could not establish connection. Receiving end does not exist."
  // 這是預期情境（使用者可能不小心按到快捷鍵），靜默吞掉即可，不讓它冒成
  // uncaught promise rejection 污染 background.js 的錯誤面板。
  browser.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PRESET', payload: { slot } }).catch(() => {});
});

// 「送到 Instapaper」摘要固定走 Gemini Flash Lite(最便宜),與使用者主翻譯引擎無關
//(CLAUDE.md §17:不可用 2.5 系列)。
const INSTAPAPER_SUMMARY_MODEL = 'gemini-3.1-flash-lite';

// 產生 Instapaper 摘要(popup 與 Alt+I 兩條路徑共用,單一資料源)。
// gate:instapaperSummaryEnabled 開 + 有 Gemini API key + 有文字。任一不滿足或摘要呼叫
// 失敗,一律回 ''(呼叫端降級為「不附摘要照常送書籤」,摘要是加值不擋送出)。
// usage 進 usage-db(source='instapaper-summary'),與主翻譯 / 術語表一致供帳單對帳。
async function generateInstapaperSummary(text, sender) {
  if (!text || typeof text !== 'string' || !text.trim()) return '';
  let settings;
  try { settings = await getSettings(); } catch (_) { return ''; }
  if (settings.instapaperSummaryEnabled !== true) return '';
  const apiKey = settings.apiKey;
  if (!apiKey) return ''; // 無有效 Gemini key → 不摘要(需求:有 key 才用 flash-lite)

  const targetLangLabel = LANG_LABELS[settings.targetLanguage] || '';
  try {
    const { summary, usage } = await summarizeArticle({
      text,
      targetLangLabel,
      apiKey,
      model: INSTAPAPER_SUMMARY_MODEL,
      serviceTier: settings.geminiConfig?.serviceTier,
    });

    // 記用量(對齊 handleExtractGlossary 的記帳:source 分流、cache 折扣換算 billed)
    if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
      const pricing = getPricingForModel(INSTAPAPER_SUMMARY_MODEL, settings) || settings.pricing;
      const cachedRate = pricingToCachedRate(pricing) ?? 0.10;
      const cachedSavedRatio = 1 - cachedRate;
      const billedInputTokens = Math.max(
        0,
        Math.round(usage.inputTokens - (usage.cachedTokens || 0) * cachedSavedRatio),
      );
      const billedCostUSD = computeBilledCostUSD(
        usage.inputTokens, usage.cachedTokens || 0, usage.outputTokens, pricing, cachedRate,
      );
      try {
        await usageDB.logTranslation({
          url: sender?.tab?.url || '',
          title: sender?.tab?.title || '',
          engine: 'gemini',
          model: INSTAPAPER_SUMMARY_MODEL,
          inputTokens: usage.inputTokens || 0,
          outputTokens: usage.outputTokens || 0,
          cachedTokens: usage.cachedTokens || 0,
          billedInputTokens,
          billedCostUSD,
          segments: 0,
          cacheHits: 0,
          durationMs: 0,
          timestamp: Date.now(),
          source: 'instapaper-summary',
        });
      } catch (_) { /* 記帳失敗不影響摘要回傳 */ }
    }
    return (summary || '').trim();
  } catch (_) {
    return '';
  }
}

// 送到 Instapaper 快捷鍵處理：取 active tab → 擷取頁面 HTML → 摘要 → OAuth 簽章 + fetch。
// 回饋透過 INSTAPAPER_TOAST 訊息派給 content（快捷鍵無 popup）。
async function handleSendToInstapaperCommand() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const toast = (status) =>
    browser.tabs.sendMessage(tab.id, { type: 'INSTAPAPER_TOAST', status }).catch(() => {});

  // enable gate：未啟用或未連結 → 提示後 no-op
  const { instapaperEnabled = false, instapaperToken, instapaperTokenSecret, instapaperSummaryEnabled = true } =
    await browser.storage.sync.get(['instapaperEnabled', 'instapaperToken', 'instapaperTokenSecret', 'instapaperSummaryEnabled']);
  if (instapaperEnabled !== true || !instapaperToken || !instapaperTokenSecret) {
    toast('not-enabled');
    return;
  }

  await ensureInstapaperKeys();
  toast('sending');
  let page;
  try {
    page = await browser.tabs.sendMessage(tab.id, { type: 'EXTRACT_PAGE_HTML' });
  } catch (_) {
    // content script 沒注入的頁（chrome:// 等）→ 無法擷取也無法 toast，直接放棄
    return;
  }
  if (!page?.ok || !page.url) { toast('failed'); return; }

  try {
    // 摘要那步會多打一次 Gemini（數秒）→ 先 toast「製作摘要中」避免 UI 看似卡住。
    // toggle 開但沒 key 時 generateInstapaperSummary 會秒回 '',toast 瞬間翻到 sending。
    if (instapaperSummaryEnabled !== false) toast('summarizing');
    // 摘要 best-effort:產不出回 ''，buildInstapaperPayload 不帶 description,書籤照常送。
    const description = await generateInstapaperSummary(page.text, { tab });
    toast('sending');
    const payload = buildInstapaperPayload({ url: page.url, html: page.html, title: page.title, description });
    const r = await saveToInstapaper({
      token: instapaperToken, tokenSecret: instapaperTokenSecret, payload,
    });
    if (r.ok) toast('sent');
    else if (r.error === 'AUTH') toast('failed-auth');
    else if (r.error === 'NETWORK') toast('failed-network');
    else toast('failed');
  } catch (_) {
    toast('failed');
  }
}

// ─── 安裝/更新事件 ─────────────────────────────────────────
// W7：一次性清 tc_* 翻譯 cache(PDF inline marker 協定變動 → 舊 sha1 全部失效)。
// flagKey 在 storage.local 設過後不再清，onInstalled + onStartup 兩處都呼叫只
// 會跑一次。網頁 cache 一併清是 PDF 路徑 prompt 變動的代價，使用者下次翻譯重打
// API，新譯文跟舊版本一致（只是費用)。Glossary 不在此清，因為術語表 prompt 沒變動。
const W7_CACHE_MIGRATION_FLAG = '__shinkansen_w7_cache_migrated';
async function runW7CacheMigration(triggerLabel) {
  try {
    const r = await cache.migrateClearTranslationCacheOnce(W7_CACHE_MIGRATION_FLAG);
    if (r.ranMigration) {
      debugLog('info', 'cache', `W7 migration cleared tc_* (${triggerLabel})`, { cleared: r.cleared });
    }
  } catch (err) {
    debugLog('warn', 'cache', 'W7 migration failed', { error: err && err.message, trigger: triggerLabel });
  }
}
browser.runtime.onStartup?.addListener(() => { runW7CacheMigration('onStartup'); });
runW7CacheMigration('sw-init'); // SW 冷啟動也跑一次（防 onStartup 沒觸發的 case，如更新 install)

// v1.9.8 一次性 migration:Google MT 混批 garbage cache 清除。
// Bug:v1.9.8 之前 Google MT 對中英混排頁面的混批會把英文段攪成 garbage 寫進 cache;
// 新版分群避免後續 fetch 被攪,但既有 cache entry 不修法本身解不掉,SPA rescan 撈 hit
// 仍會吐 garbage。掃掉 tc_*_gt[_drive|_yt|...] entry,Gemini / openai-compat cache 不動。
const V198_GOOGLE_MT_CACHE_FLAG = '__shinkansen_v198_google_mt_cache_cleared';
async function runV198GoogleMtCacheClear(triggerLabel) {
  try {
    const r = await cache.migrateClearGoogleMtCacheOnce(V198_GOOGLE_MT_CACHE_FLAG);
    if (r.ranMigration) {
      debugLog('info', 'cache', `v1.9.8 Google MT cache cleared (${triggerLabel})`, { cleared: r.cleared });
    }
  } catch (err) {
    debugLog('warn', 'cache', 'v1.9.8 Google MT cache clear failed', { error: err && err.message, trigger: triggerLabel });
  }
}
browser.runtime.onStartup?.addListener(() => { runV198GoogleMtCacheClear('onStartup'); });
runV198GoogleMtCacheClear('sw-init');

// v2.0.65 一次性 migration：英文段落 echo 壞快取清除。
// Bug:isSuspectEchoTranslation 對 CJK target 只認假名/諺文字系特徵，整段英文
// 內文被 echo（原文照抄）不觸發 → 壞 entry 寫進 tc_ 快取後，該段每次翻譯都
// cache hit 直接吐英文，「永遠沒翻」。v2.0.65 已補「拉丁字母長內文 echo」判定
// 擋住新增，但既有壞 entry 修法本身解不掉；快取 value 無法分辨「壞 echo」vs
// 「合法譯文」（都是字串，無 metadata），一次性全清 tc_*（glossary 不動）。
const V2065_ECHO_CACHE_FLAG = '__shinkansen_v2065_echo_cache_cleared';
async function runV2065EchoCacheClear(triggerLabel) {
  try {
    const r = await cache.migrateClearTranslationCacheOnce(V2065_ECHO_CACHE_FLAG);
    if (r.ranMigration) {
      debugLog('info', 'cache', `v2.0.65 echo cache cleared (${triggerLabel})`, { cleared: r.cleared });
    }
  } catch (err) {
    debugLog('warn', 'cache', 'v2.0.65 echo cache clear failed', { error: err && err.message, trigger: triggerLabel });
  }
}
browser.runtime.onStartup?.addListener(() => { runV2065EchoCacheClear('onStartup'); });
runV2065EchoCacheClear('sw-init');

// v2.0.75 一次性 migration:prompt 規則變動後的舊譯文快取清除。
// 本版 DEFAULT_SYSTEM_PROMPT 補「通行譯名不確定保留原文」guard、DOC prompt 追加
// <document_number_fidelity>(千分位保留)——舊 prompt 產的譯文(千分位被移除、
// 公司名幻覺譯名)已寫進 tc_ 快取,cache key 不含 prompt 文字,新版 cache hit
// 仍會吐舊規則譯文。一次性全清 tc_*(glossary 不動,術語表 prompt 本版沒變)。
const V2075_PROMPT_CACHE_FLAG = '__shinkansen_v2075_prompt_cache_cleared';
async function runV2075PromptCacheClear(triggerLabel) {
  try {
    const r = await cache.migrateClearTranslationCacheOnce(V2075_PROMPT_CACHE_FLAG);
    if (r.ranMigration) {
      debugLog('info', 'cache', `v2.0.75 prompt cache cleared (${triggerLabel})`, { cleared: r.cleared });
    }
  } catch (err) {
    debugLog('warn', 'cache', 'v2.0.75 prompt cache clear failed', { error: err && err.message, trigger: triggerLabel });
  }
}
browser.runtime.onStartup?.addListener(() => { runV2075PromptCacheClear('onStartup'); });
runV2075PromptCacheClear('sw-init');

// 累計用量 path 合一（IndexedDB 為單一資料源）後，storage.local['usageStats'] 殘餘清掉
browser.storage.local.remove('usageStats').catch(() => {});

browser.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  debugLog('info', 'system', `extension ${reason}`, {
    version: browser.runtime.getManifest().version,
    previousVersion: previousVersion || null,
  });
  // 安裝/更新時也檢查一次版本（雙重保險，SW 啟動時已經跑過一次）
  const currentVersion = browser.runtime.getManifest().version;
  await cache.checkVersionAndClear(currentVersion);
  await runW7CacheMigration('onInstalled');
  await runV198GoogleMtCacheClear('onInstalled');
  await runV2065EchoCacheClear('onInstalled');
  await runV2075PromptCacheClear('onInstalled');

  // v1.6.5: CWS 自動更新到 major / minor 新版時，寫 welcomeNotice 讓使用者下次
  // 開 popup 或翻譯成功 toast 時看到「🎉 已升級至 vX.Y」+ 重大更新清單。
  // patch 級小修跳過避免高頻打擾——邏輯封裝在 lib/welcome-notice.js 方便 unit 測試。
  const wrote = await maybeWriteWelcomeNotice({ reason, previousVersion, currentVersion });
  if (wrote) {
    debugLog('info', 'system', 'welcome notice written', {
      from: previousVersion, to: currentVersion,
    });
  }

  // v0.62 起：API Key 從 browser.storage.sync 搬到 browser.storage.local，
  // 避免跨 Google 帳號同步。這裡做一次主動遷移：若 sync 裡還殘留舊的 apiKey，
  // 搬到 local（沒 local 版本才搬，已經有就尊重 local）然後從 sync 刪除。
  // lib/storage.js::getSettings 也有 lazy migration 作為雙重保險。
  if (reason === 'update' || reason === 'install') {
    try {
      const { apiKey: syncKey } = await browser.storage.sync.get('apiKey');
      if (typeof syncKey === 'string') {
        const { apiKey: localKey } = await browser.storage.local.get('apiKey');
        if (!localKey && syncKey) {
          await browser.storage.local.set({ apiKey: syncKey });
          debugLog('info', 'system', 'apiKey migrated from sync → local');
        }
        await browser.storage.sync.remove('apiKey');
      }
    } catch (err) {
      debugLog('warn', 'system', 'apiKey migration failed', { error: err.message });
    }
  }
});
