// popup.js — 工具列面板邏輯

import { browser } from '../lib/compat.js';
import { formatBytes, formatTokens, formatUSD, formatMoney } from '../lib/format.js';
import { getCachedRate, FALLBACK_USD_TWD_RATE } from '../lib/exchange-rate.js';
import { RELEASE_HIGHLIGHTS } from '../lib/release-highlights.js';
import { shouldShowWelcomeNotice } from '../lib/welcome-notice.js';
import { isWorthNotifying, buildUpdateDownloadUrl } from '../lib/update-check.js';
import { IS_MAS_BUILD, IS_IOS_BUILD } from '../lib/distribution.js';
import { isTouchScreenDevice } from '../lib/platform.js';
import { pickPopupSlot, presetsRequireGemini, TARGET_LANGUAGES, DEFAULT_SETTINGS } from '../lib/storage.js';
import { saveToInstapaper, buildInstapaperPayload } from '../lib/instapaper.js'; // 送到 Instapaper

// 懸浮按鈕的「功能選單」會把本 popup 以 iframe 嵌進網頁當頁內浮層（src 帶 ?panel=1）。
// 嵌入頁無法自關（window.close 無效）→ 改 postMessage 通知外層 content script 收掉浮層；
// 真正的工具列 popup（非 panel）維持原本 window.close()。
const IS_PANEL = (() => {
  try { return new URLSearchParams(location.search).get('panel') === '1'; }
  catch (_e) { return false; }
})();
function closePopup() {
  if (IS_PANEL) {
    try { window.parent.postMessage({ type: 'shinkansen-close-panel' }, '*'); } catch (_e) {}
    return;
  }
  window.close();
}
// panel 浮層模式：回報內容高度給外層 content script，讓 iframe 收緊到內容高度（不留白）。
// 內容變動（banner 展開 / usage 載入）時用 ResizeObserver 重報。非 panel（原生 popup）no-op。
if (IS_PANEL) {
  // 用 body 量內容高度（documentElement.scrollHeight 會被 iframe viewport 高度撐住、量不到
   // 真實內容；body 高度才是內容本身）。
  const postPanelSize = () => {
    try {
      const rect = document.body.getBoundingClientRect();
      const h = Math.ceil(rect.height);
      // 一併回報內容寬度，讓外層 iframe 收緊到 popup 實際寬（桌面 280px），不留左右白邊。
      const w = Math.ceil(rect.width);
      window.parent.postMessage({ type: 'shinkansen-panel-size', height: h, width: w }, '*');
    } catch (_e) {}
  };
  window.addEventListener('load', postPanelSize);
  if (window.ResizeObserver) {
    try { new ResizeObserver(postPanelSize).observe(document.body); } catch (_e) {}
  }
  setTimeout(postPanelSize, 0);
}

// iOS build（SPEC-PRIVATE §26）。build 屬性 vs 平台屬性分離見 lib/platform.js：
//   - body.runtime-ios（build 屬性，不論 host OS）：CSS 隱藏「翻譯文件」入口
//     （iOS build 已 strip translate-doc/，留著是死按鈕）
//   - body.runtime-ios-touch（平台屬性，只在真觸控裝置）：popup 撐滿放大。
//     iOS build 可透過「iPhone 與 iPad App 在 Mac 上執行」裝在 macOS，此時要
//     尊重 macOS popover 尺寸 → 不放大，只保留 runtime-ios 的死按鈕隱藏。
if (IS_IOS_BUILD) {
  document.body.classList.add('runtime-ios');
  if (isTouchScreenDevice()) {
    document.body.classList.add('runtime-ios-touch');
    // 箱子尺寸（zoom）與寬度撐滿改由 popup.css 全權處理（固定放大檔 zoom 1.35 + 觸控且
    // viewport 已寬時 width:auto,對齊 JRead 實機驗證做法,見 popup.css runtime-ios-touch
    // 區段註解）。這裡只剩字體大小微調：
    //   字體大小（--sk-fz）：大 iPad（12.9"）跟 iPad mini 共用同一個 popover 尺寸（都
    //   ~420pt），但大螢幕檢視距離較遠 → 字看起來偏小。zoom 是整體縮放、改不了「字相對
    //   箱子」的比例,故另用 --sk-fz 只放大可讀文字（popup.css 用 calc 套），箱子尺寸不動。
    //   依螢幕短邊校準：iPad mini（短邊 744）→ 1.0 維持原樣；12.9"（短邊 1024）→ ~1.35。
    //   iPhone（短邊 ≤ 440）算出 < 1 被 clamp 回 1.0 → 不變。用 screen.*（固定值、不隨
    //   orientation 變）。
    const applyIosFontScale = () => {
      const screenMin = Math.min(screen.width || 744, screen.height || 744);
      const fz = Math.min(1.4, Math.max(1.0, 1 + (screenMin - 744) / 800));
      document.body.style.setProperty('--sk-fz', String(fz));
    };
    applyIosFontScale();
    window.addEventListener('resize', applyIosFontScale);
  }
}

// P2 (v1.8.60):i18n. lib/i18n.js 在 popup.html 內以普通 <script> 早於本 module 載入,
// 因此 window.__SK.i18n API 必然存在
const I18N = (typeof window !== 'undefined' && window.__SK && window.__SK.i18n) || null;
const t = (key, params) => (I18N ? I18N.t(key, params, _currentTarget) : key);
let _currentTarget = 'zh-TW'; // init 時讀 storage 覆蓋

// v1.6.5: 把 markdown 風的 **粗體** 標記轉成 <strong>，其他字符做 escapeHtml
function highlightToHtml(s) {
  const esc = String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return esc.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

async function refreshUsageInfo() {
  try {
    // 讀 displayCurrency + cached rate 決定金額顯示幣值。
    // grand total 走 IndexedDB getStats（與用量明細分頁同源，避免 drift）。
    // v2.0.71：popup 累計費用支援「清除」——實際是顯示基準點重設（usageResetAt，
    // storage.local，與 usage-db 同為裝置本機），只加總基準點之後的紀錄；
    // usage-db 紀錄本身不動,options 用量明細分頁完全不受影響。
    const { usageResetAt } = await browser.storage.local.get('usageResetAt');
    const statsPayload = (typeof usageResetAt === 'number' && usageResetAt > 0)
      ? { from: usageResetAt } : {};
    const [resp, currencyState] = await Promise.all([
      browser.runtime.sendMessage({ type: 'QUERY_USAGE_STATS', payload: statsPayload }),
      readCurrencyState(),
    ]);
    const stats = resp?.ok ? resp.stats : null;
    if (stats) {
      const totalTok = (stats.totalInputTokens || 0) + (stats.totalOutputTokens || 0);
      $('usage-info').textContent = t('popup.usage.value', {
        cost: formatMoney(stats.totalBilledCostUSD || 0, currencyState),
        tokens: formatTokens(totalTok),
      });
    } else {
      $('usage-info').textContent = t('popup.usage.failed');
    }
  } catch {
    $('usage-info').textContent = t('popup.usage.unreadable');
  }
}

// v1.8.41：讀 displayCurrency + cached rate 組成 formatMoney opts
async function readCurrencyState() {
  try {
    const [{ displayCurrency = 'TWD' }, rateInfo] = await Promise.all([
      browser.storage.sync.get('displayCurrency'),
      getCachedRate(),
    ]);
    return { currency: displayCurrency, rate: rateInfo?.rate || FALLBACK_USD_TWD_RATE };
  } catch {
    return { currency: 'TWD', rate: FALLBACK_USD_TWD_RATE };
  }
}

async function refreshCacheInfo() {
  try {
    const resp = await browser.runtime.sendMessage({ type: 'CACHE_STATS' });
    if (resp?.ok) {
      $('cache-info').textContent = t('popup.cache.value', {
        count: resp.count,
        bytes: formatBytes(resp.bytes),
      });
    } else {
      $('cache-info').textContent = t('popup.cache.failed');
    }
  } catch {
    $('cache-info').textContent = t('popup.cache.unreadable');
  }
}

async function refreshTranslateButton() {
  // 詢問 content script 目前是否已翻譯，動態切換按鈕標籤
  const btn = $('translate-btn');
  const editBtn = $('edit-btn');
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const resp = await browser.tabs.sendMessage(tab.id, { type: 'GET_STATE' });
    if (resp?.translated) {
      btn.textContent = t('popup.action.restore');
      btn.dataset.mode = 'restore';
      // v1.0.3: 已翻譯時顯示編輯按鈕
      editBtn.hidden = false;
      editBtn.textContent = resp?.editing ? t('popup.action.editDone') : t('popup.action.editStart');
    } else {
      btn.textContent = t('popup.action.translate');
      btn.dataset.mode = 'translate';
      editBtn.hidden = true;
    }
  } catch {
    // 頁面尚未注入 content script (例如 chrome:// 頁、剛 reload extension)
    // 維持預設「翻譯本頁」即可
    btn.textContent = t('popup.action.translate');
    btn.dataset.mode = 'translate';
    editBtn.hidden = true;
  }
}

async function refreshShortcutHint() {
  // v1.4.13: popup 按鈕觸發 TOGGLE_TRANSLATE 訊息，content.js 將其映射為 preset slot 2（Flash）。
  // 所以這裡讀「主要預設」的當前鍵位顯示。
  // v1.8.19: 主要預設 command id 改為 translate-preset-0（字典序保證 chrome://extensions/shortcuts 顯示在最上）
  const el = $('shortcut-hint');
  if (!el) return;
  // iOS build 真觸控裝置：主要觸發是四指輕點（= 主要預設完整 toggle，
  // content-touch.js），提示改顯示手勢而非鍵盤快速鍵（接實體鍵盤時
  // Alt+S 照常可用，options 快速鍵 section 有完整說明）。
  // iOS build 跑在 Mac（無觸控）時不走這條 → fall through 顯示鍵盤快速鍵，
  // 尊重 macOS 特性（見 lib/platform.js）。
  if (IS_IOS_BUILD && isTouchScreenDevice()) {
    el.textContent = t('popup.shortcut.iosTouch');
    return;
  }
  try {
    const cmds = await browser.commands.getAll();
    const cmd = cmds.find((c) => c.name === 'translate-preset-0');
    const shortcut = cmd?.shortcut?.trim();
    if (shortcut) {
      // Mac 上把 "Alt+S" 顯示成 "⌥S"（Option 不是 Alt），與設定頁 recorder 一致；
      // 非 Mac（Windows / Linux）保持 "Alt+S"。Safari 回 "Alt+S"，Chrome Mac 多已回
      // "⌥S"（不變）。lib/shortcut-utils.js 的 macifyCommandShortcut 為單一來源。
      const isMac = /Mac/i.test((typeof navigator !== 'undefined' && navigator.platform) || '');
      const SC = (typeof window !== 'undefined' && window.__SKShortcuts) || null;
      const display = SC ? SC.macifyCommandShortcut(shortcut, isMac) : shortcut;
      el.textContent = t('popup.shortcut.value', { shortcut: display });
    } else {
      // 使用者可能在 chrome://extensions/shortcuts 清掉了快捷鍵
      el.textContent = t('popup.shortcut.unset');
    }
  } catch {
    // browser.commands 不可用時靜默留白，不要顯示錯誤
    el.textContent = '';
  }
}

// v1.6.5: welcome banner「知道了」按鈕——標記 welcomeNotice.dismissed=true 永久關閉
document.addEventListener('click', async (e) => {
  if (!e.target.closest('#welcome-banner-dismiss')) return;
  e.preventDefault();
  try {
    await browser.runtime.sendMessage({ type: 'WELCOME_NOTICE_DISMISSED' });
    $('welcome-banner').hidden = true;
    $('update-dot').hidden = true; // 紅點也清掉（除非還有 update-banner，但 welcome 顯示時 update 沒顯示）
  } catch (err) {
    console.error('[shinkansen] welcome-banner dismiss failed', err);
  }
});

// v1.6.3: 用 document-level event delegation 處理 update banner 點擊，
// 不依賴 init() async timing 也不靠 a-tag navigate 行為——任何時候 button 出現在
// DOM 都能 click 觸發。click handler 內臨時讀 storage 拿 release URL，最穩固。
//
// Safari macOS 分支(路徑 A 半鍵更新):直接 navigate 到 .pkg 下載 URL,
// 觸發瀏覽器下載(Developer ID 簽 + 公證的 pkg),省掉「開 release page → 找
// asset 連結」兩步,使用者下載完雙擊 pkg 即可重裝。其他 platform 維持開
// release page,讓使用者選要下載哪個 asset。
// 偵測:safari-web-extension:// = Safari(macOS)。註:未來 iOS Safari 上架後
// 同一 scheme 也會 match,但 iOS 不裝 .pkg,屆時需加 `os==='mac'` 守衛。
document.addEventListener('click', async (e) => {
  if (!e.target.closest('#update-banner')) return;
  e.preventDefault();
  try {
    const { updateAvailable } = await browser.storage.local.get('updateAvailable');
    const isSafari = browser.runtime.getURL('').startsWith('safari-web-extension://');
    // URL 規則單一資料源：lib/update-check.js buildUpdateDownloadUrl(options banner 同用)
    const url = buildUpdateDownloadUrl(updateAvailable, isSafari);
    await browser.tabs.create({ url });
    closePopup();
  } catch (err) {
    console.error('[shinkansen] update-banner click failed', err);
  }
});

async function init() {
  // 從 manifest 動態讀版本號，避免日後忘記同步
  const manifest = browser.runtime.getManifest();
  $('version').textContent = 'v' + manifest.version;

  // v1.8.60: 不在這裡呼叫 refreshShortcutHint() — 此時 _currentTarget 仍是初始 zh-TW,
  // 會把 t('popup.shortcut.value') 的 zh-TW 字串塞進 #shortcut-hint 黏到後面 applyI18n
  // 之後 stale。改在 storage 讀完 + applyI18n 之後一起呼叫(見下方)。

  // v1.6.5: welcome banner（CWS 剛升級）優先於 update banner（GitHub 有新版）顯示。
  // 兩者互斥——CWS 自動升級後使用者不需要看「有新版可下載」（已在最新），看「歡迎升級」即可；
  // unpacked 使用者沒 onInstalled update 事件，看到的是黃色 update banner。
  let welcomeShown = false;
  try {
    const { welcomeNotice } = await browser.storage.local.get('welcomeNotice');
    const decision = shouldShowWelcomeNotice(welcomeNotice, manifest.version);
    if (decision.removeStale) {
      // 過期殘留（不同 minor 系列）→ 清除避免日後誤顯示
      await browser.storage.local.remove('welcomeNotice');
    } else if (decision.show) {
      welcomeShown = true;
      $('update-dot').hidden = false;
      $('welcome-banner').hidden = false;
      $('welcome-banner-title').textContent = t('popup.banner.welcome', { version: welcomeNotice.version });
      // AMO source review: RELEASE_HIGHLIGHTS 是 dev hardcoded 字串陣列（見 lib/release-highlights.js）,
      // highlightToHtml 是同檔案內的安全 markdown-to-html 轉換（只處理 **bold** → <strong>），無 user input。
      $('welcome-bullets').innerHTML = RELEASE_HIGHLIGHTS
        .map(h => `<li>${highlightToHtml(h)}</li>`)
        .join('');
    }
  } catch { /* 略 */ }

  // v1.6.1: 更新提示 — 有新版時顯示版本紅點 + banner（welcome 顯示時跳過）
  // MAS build:整段跳過 — defense in depth,即使 storage 殘留舊 updateAvailable
  // 也不錯顯 banner(checkForUpdate 已在 update-check.js 內 MAS gate,正常不會
  // 寫入 storage,但若使用者從 Developer ID 切換到 MAS 安裝,storage 可能殘留)。
  if (!welcomeShown && !IS_MAS_BUILD) {
    try {
      const { disableUpdateNotice } = await browser.storage.sync.get('disableUpdateNotice');
      if (disableUpdateNotice !== true) {
        const { updateAvailable } = await browser.storage.local.get('updateAvailable');
        // v1.6.5: belt-and-suspenders — banner 顯示前再次驗 storage.version 真的 >
        // 當前 manifest.version。即使 storage 殘留 stale 資料（例如之前測試殘留、
        // update-check 還沒跑、或 fetch 失敗未清），UI 層也不會錯誤顯示「有新版」
        // 然後跳到自身版本的 release 頁。
        if (updateAvailable && updateAvailable.version && updateAvailable.releaseUrl
            && isWorthNotifying(updateAvailable.version, manifest.version)) {
          $('update-dot').hidden = false;
          const banner = $('update-banner');
          banner.hidden = false;
          $('update-banner-version').textContent = t('popup.banner.updateNoticeVersion', {
            newVersion: updateAvailable.version,
            currentVersion: manifest.version,
          });
        }
      }
    } catch { /* 讀取失敗就略過 */ }
  }

  // v0.62 起：autoTranslate 仍走 sync（跨裝置同步），apiKey 改走 local（不同步）
  // P2 (v1.8.60): UI 語系獨立於 targetLanguage,讀 uiLanguage('auto' / 三語)後
  // 透過 I18N.getUiLanguage('auto') 解析為 navigator.language 推導值
  const { autoTranslate = false, displayMode = 'single', translatePresets = [], uiLanguage, targetLanguage } = await browser.storage.sync.get(['autoTranslate', 'displayMode', 'translatePresets', 'uiLanguage', 'targetLanguage']);
  const { apiKey = '' } = await browser.storage.local.get(['apiKey']);
  $('auto').checked = autoTranslate;

  // 翻譯目標語言 picker(saved 不在合法集合 → 走 DEFAULT_SETTINGS.targetLanguage,
  // 跟 options 載入相同 fallback)。targetLanguage 是總 switch,影響所有翻譯路徑,
  // 切了立刻寫 storage(下方 change handler),不需要按「儲存」按鈕。
  if ($('targetLanguage')) {
    const tl = (typeof targetLanguage === 'string' && TARGET_LANGUAGES.includes(targetLanguage))
      ? targetLanguage : DEFAULT_SETTINGS.targetLanguage;
    $('targetLanguage').value = tl;
  }

  // P2: UI i18n — 寫入 _currentTarget(現在叫「ui dict 語系」更貼切,但變數名沿用),
  // 套 applyI18n,訂閱 storage.uiLanguage 變動
  _currentTarget = I18N ? I18N.getUiLanguage(uiLanguage || 'auto') : 'zh-TW';
  if (I18N) {
    I18N.applyI18n(document, _currentTarget);
    I18N.subscribeUiLanguageChange((newUi /* , newPref */) => {
      _currentTarget = newUi || 'zh-TW';
      I18N.applyI18n(document, _currentTarget);
      // 動態欄位重新整理(cache / usage / button label / shortcut)
      refreshCacheInfo();
      refreshUsageInfo();
      refreshTranslateButton();
      refreshShortcutHint();
    });
  }
  // v1.8.60: _currentTarget ready 後才呼叫 refreshShortcutHint(原本在 init 開頭呼叫,
  // 那時 _currentTarget=zh-TW 會把繁中「快速切換」黏到 #shortcut-hint, applyI18n 也救不回
  // 因為這個元素沒掛 data-i18n、由 JS 動態設 textContent)。
  refreshShortcutHint();

  // v1.5.0: 顯示模式 toggle 初始狀態
  setDisplayModeButtons(displayMode === 'dual' ? 'dual' : 'single');

  // v0.73: 術語表一致化開關（讀 browser.storage.sync 的 glossary.enabled）
  try {
    const { glossary: gc } = await browser.storage.sync.get('glossary');
    $('glossary-toggle').checked = gc?.enabled ?? false;
  } catch { /* 讀取失敗時維持預設 checked */ }

  // 送到 Instapaper：只有「已啟用且已連結」才顯示按鈕
  try {
    const { instapaperEnabled = false, instapaperToken } =
      await browser.storage.sync.get(['instapaperEnabled', 'instapaperToken']);
    $('send-to-instapaper-btn').hidden = !(instapaperEnabled === true && !!instapaperToken);
  } catch { /* 讀取失敗維持 hidden */ }

  // v1.2.12: YouTube 字幕 toggle — 只在 YouTube 影片頁才顯示
  // v1.4.13: toggle 語意從「當前 active 狀態」改為「ytSubtitle.autoTranslate 設定值」，
  // 讓使用者一打開 popup 就看到預設 ON（DEFAULT_SETTINGS.ytSubtitle.autoTranslate=true），
  // 不再因為 content script 尚未啟動 active 就顯示 off 造成「預設沒開」的錯覺。
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';
    if (url.includes('youtube.com/watch')) {
      $('yt-subtitle-row').hidden = false;
      const { ytSubtitle = {} } = await browser.storage.sync.get('ytSubtitle');
      // 沒設定過視為 true（與 DEFAULT_SETTINGS.ytSubtitle.autoTranslate 對齊）
      $('yt-subtitle-toggle').checked = ytSubtitle.autoTranslate !== false;
      // 字幕大小 scale（全平台統一,只在 YouTube 影片頁顯示）。預設 100。
      $('yt-caption-size-row').hidden = false;
      $('yt-caption-size').value = String(ytSubtitle.captionScale ?? 100);
    }
    // commit 5a':Drive 影片 viewer toggle 共用 ytSubtitle.autoTranslate
    // （user 不需要為 Drive 多做設定，跟 YouTube 字幕用同一個開關）
    if (/^https:\/\/drive\.google\.com\/file\//.test(url)) {
      $('drive-subtitle-row').hidden = false;
      const { ytSubtitle = {} } = await browser.storage.sync.get('ytSubtitle');
      $('drive-subtitle-toggle').checked = ytSubtitle.autoTranslate !== false;
    }
    // commit 5c：雙語對照 toggle(YouTube + Drive 影片頁都顯示，共用 ytSubtitle.bilingualMode)
    if (url.includes('youtube.com/watch') || /^https:\/\/drive\.google\.com\/file\//.test(url)) {
      $('bilingual-row').hidden = false;
      const { ytSubtitle = {} } = await browser.storage.sync.get('ytSubtitle');
      $('bilingual-toggle').checked = ytSubtitle.bilingualMode === true;
    }
  } catch { /* 非影片頁面，保持 hidden */ }

  // v1.8.12: 只有當 translatePresets 中有任一 slot 用 Gemini engine 時，才提醒未設 API Key。
  // 使用者若三組 preset 都改成 Google MT / 自訂模型，popup 不再嘮叨他沒填 Gemini Key。
  if (!apiKey && presetsRequireGemini(translatePresets)) {
    statusEl.textContent = t('popup.status.noApiKey');
    statusEl.style.color = '#ff3b30';
  }

  refreshCacheInfo();
  refreshUsageInfo();
  refreshTranslateButton();
}

$('translate-btn').addEventListener('click', async () => {
  // v1.8.20: 雙擊防護——點擊期間 disable 按鈕，避免快速連按兩次導致第二次被
  // content.js 解讀為 abort/restore（toggle 行為）
  const btn = $('translate-btn');
  if (btn.disabled) return;
  btn.disabled = true;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { btn.disabled = false; return; }
  const mode = btn.dataset.mode;
  statusEl.textContent = mode === 'restore' ? t('popup.status.restoring') : t('popup.status.translating');
  try {
    // v1.6.6: 讀 settings.popupButtonSlot 決定按鈕對應的 preset slot（預設 2 = Flash）
    // content.js handleTranslatePreset 自帶 toggle 行為（已翻譯 → 還原 / 翻譯中 → abort / 閒置 → 翻譯）
    const { popupButtonSlot } = await browser.storage.sync.get('popupButtonSlot');
    const slot = pickPopupSlot(popupButtonSlot);
    await browser.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PRESET', payload: { slot } });
    closePopup();
  } catch (err) {
    statusEl.textContent = t('popup.status.cannotRun');
    statusEl.style.color = '#ff3b30';
    btn.disabled = false;
  }
});

$('auto').addEventListener('change', async (e) => {
  await browser.storage.sync.set({ autoTranslate: e.target.checked });
});

// 翻譯目標語言切換 — 立刻寫 storage(content script 下一次翻譯讀新值生效;
// 舊翻譯快取仍保留,使用者可手動清快取重新翻譯)。non-集合值 fallback DEFAULT
// 避免損壞值寫進 storage。
$('targetLanguage').addEventListener('change', async (e) => {
  const v = e.target.value;
  const tl = TARGET_LANGUAGES.includes(v) ? v : DEFAULT_SETTINGS.targetLanguage;
  try {
    await browser.storage.sync.set({ targetLanguage: tl });
  } catch (err) {
    console.error('[shinkansen] targetLanguage set failed', err);
  }
});

// v1.5.0: 顯示模式切換 toggle
function setDisplayModeButtons(mode) {
  $('mode-single').setAttribute('aria-checked', mode === 'single' ? 'true' : 'false');
  $('mode-dual').setAttribute('aria-checked', mode === 'dual' ? 'true' : 'false');
}

async function changeDisplayMode(mode) {
  setDisplayModeButtons(mode);
  await browser.storage.sync.set({ displayMode: mode });
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await browser.tabs.sendMessage(tab.id, { type: 'MODE_CHANGED', mode }).catch(() => {});
    }
  } catch { /* 非可注入頁面，安靜忽略 */ }
}

$('mode-single').addEventListener('click', () => changeDisplayMode('single'));
$('mode-dual').addEventListener('click',   () => changeDisplayMode('dual'));

// v0.73: 術語表一致化開關 — 寫入 browser.storage.sync 的 glossary.enabled
$('glossary-toggle').addEventListener('change', async (e) => {
  try {
    const { glossary: gc = {} } = await browser.storage.sync.get('glossary');
    gc.enabled = e.target.checked;
    await browser.storage.sync.set({ glossary: gc });
  } catch (err) {
    console.error('[Shinkansen] popup: failed to save glossary toggle', err);
  }
});

// v1.2.12: YouTube 字幕翻譯開關
// v1.4.13: toggle 變更時同時更新設定（autoTranslate）+ 通知 content script 立即啟/停
// v1.4.21: popup 顯示（讀 ytSubtitle.autoTranslate 設定值）與點擊動作對齊到同一語意——
// 舊版點擊送 TOGGLE_SUBTITLE，content.js 走「翻面」YT.active；當設定值與 YT.active
// desync（例如使用者手動按 Alt+S 啟動過、或處於 init 800ms 延遲窗口）時，點擊會反向作用。
// 改為送 SET_SUBTITLE { enabled }，content.js 依 enabled 直接決定啟/停/no-op。
// v1.6.23：改為「Option → Popup」單向 sync。popup toggle 變動只通知當前 tab 即時啟 / 停，
// **不寫** storage 避免反向覆蓋 Option 的全域設定。Option 設定影響「下次進 YouTube 頁的預設行為」,
// popup 的勾選只控制「當前 tab」即時狀態。
$('yt-subtitle-toggle').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await browser.tabs.sendMessage(tab.id, {
        type: 'SET_SUBTITLE',
        payload: { enabled },
      }).catch(() => {});
    }
  } catch (err) {
    statusEl.textContent = t('popup.status.subtitleToggleFailed');
    statusEl.style.color = '#ff3b30';
  }
});

// commit 5a':Drive toggle 共用 ytSubtitle.autoTranslate（寫 storage，跟 YouTube popup
// 的 SET_SUBTITLE message 設計不同——因 Drive 沒 SPA 切影片，單純 storage 即時 sync 即可。
// content-drive.js listen onChanged 即時生效）。
$('drive-subtitle-toggle').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  try {
    const { ytSubtitle = {} } = await browser.storage.sync.get('ytSubtitle');
    await browser.storage.sync.set({
      ytSubtitle: { ...ytSubtitle, autoTranslate: enabled },
    });
  } catch (err) {
    statusEl.textContent = t('popup.status.subtitleToggleFailed');
    statusEl.style.color = '#ff3b30';
  }
});

// commit 5c：雙語 toggle change handler（寫 ytSubtitle.bilingualMode 到 storage,YouTube
// 跟 Drive 兩條路徑各自的 onChanged listener 自動反應；切換生效需 reload 影片頁）
$('bilingual-toggle').addEventListener('change', async (e) => {
  const bilingual = e.target.checked;
  try {
    const { ytSubtitle = {} } = await browser.storage.sync.get('ytSubtitle');
    await browser.storage.sync.set({
      ytSubtitle: { ...ytSubtitle, bilingualMode: bilingual },
    });
  } catch (err) {
    statusEl.textContent = t('popup.status.bilingualToggleFailed');
    statusEl.style.color = '#ff3b30';
  }
});

// 字幕大小 scale change handler（寫 ytSubtitle.captionScale；content-youtube onChanged
// 即時套用 overlay + iOS ::cue,不需 reload 影片頁）
$('yt-caption-size').addEventListener('change', async (e) => {
  const scale = parseInt(e.target.value, 10);
  if (!Number.isFinite(scale)) return;
  try {
    const { ytSubtitle = {} } = await browser.storage.sync.get('ytSubtitle');
    await browser.storage.sync.set({
      ytSubtitle: { ...ytSubtitle, captionScale: scale },
    });
  } catch (err) {
    statusEl.textContent = t('popup.status.captionSizeFailed');
    statusEl.style.color = '#ff3b30';
  }
});

$('options-btn').addEventListener('click', async() => {
  try{
    await browser.runtime.openOptionsPage();
  } catch (e) {
    // 如果 openOptionsPage 不支援（例如 Arc），退而求其次直接開啟 options.html 頁面
    const url = browser.runtime.getURL('options/options.html');
    await browser.tabs.create({ url });
  }
});

$('translate-doc-btn').addEventListener('click', async () => {
  const url = browser.runtime.getURL('translate-doc/index.html');
  await browser.tabs.create({ url });
  closePopup();
});

// ── 送到 Instapaper ──────────────────────────────────────
// 在 popup 直接做 OAuth 簽章 + fetch（避開 iOS 背景 event page 掛起）：
// 向 content 取目前頁面 HTML（含已就地替換的譯文）→ saveToInstapaper。
function instapaperErrText(error) {
  switch (error) {
    case 'AUTH': return t('instapaper.failedAuth');
    case 'NETWORK': return t('instapaper.failedNetwork');
    default: return t('instapaper.failed');
  }
}

$('send-to-instapaper-btn').addEventListener('click', async () => {
  const btn = $('send-to-instapaper-btn');
  btn.disabled = true;
  statusEl.style.color = '#86868b';
  statusEl.textContent = t('instapaper.sending');
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('no active tab');
    const page = await browser.tabs.sendMessage(tab.id, { type: 'EXTRACT_PAGE_HTML' });
    if (!page?.ok || !page.url) throw new Error(page?.error || 'extract failed');
    // 送出前向 background 要文章摘要。Gemini 呼叫 + usage 記帳集中在 background（與 Alt+I
    // 路徑共用同一個 generateInstapaperSummary，單一資料源不 drift）。best-effort:background
    // 依 instapaperSummaryEnabled + 是否有 Gemini key gate,回 '' 代表不附摘要,書籤照常送。
    let description = '';
    try {
      // 摘要那步會多打一次 Gemini（數秒），顯示獨立狀態避免看起來像卡在「送出中」。
      // 只讀 toggle 當「要不要顯示摘要中」的 UX 訊號,真正 gate（含 Gemini key）仍只在
      // background;toggle 開但沒 key 時 background 會秒回 ''，狀態瞬間翻到送出中。
      const { instapaperSummaryEnabled = true } = await browser.storage.sync.get(['instapaperSummaryEnabled']);
      if (instapaperSummaryEnabled !== false) statusEl.textContent = t('instapaper.summarizing');
      const sres = await browser.runtime.sendMessage({ type: 'SUMMARIZE_FOR_INSTAPAPER', payload: { text: page.text } });
      if (sres?.ok && typeof sres.summary === 'string') description = sres.summary;
    } catch (_) { /* 摘要失敗不擋送出 */ }
    statusEl.textContent = t('instapaper.sending');
    const { instapaperToken, instapaperTokenSecret } =
      await browser.storage.sync.get(['instapaperToken', 'instapaperTokenSecret']);
    const payload = buildInstapaperPayload({ url: page.url, html: page.html, title: page.title, description });
    const r = await saveToInstapaper({ token: instapaperToken, tokenSecret: instapaperTokenSecret, payload });
    if (r.ok) {
      statusEl.textContent = t('instapaper.sent');
      statusEl.style.color = '#34c759';
    } else {
      statusEl.textContent = instapaperErrText(r.error);
      statusEl.style.color = '#ff3b30';
    }
  } catch (_) {
    statusEl.textContent = t('instapaper.failed');
    statusEl.style.color = '#ff3b30';
  } finally {
    btn.disabled = false;
  }
});

// v1.6.23:popup 開著時 reactive sync ytSubtitle.autoTranslate（設定頁同步寫 storage 後立即反映）
// popup 通常 click 外面就關閉，但 detached popup window 或極短時間視窗下這條 listener 確保一致
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.ytSubtitle) return;
  const newVal = changes.ytSubtitle.newValue || {};
  // 同一個 ytSubtitle.autoTranslate 設定同步兩個 popup toggle（YouTube + Drive 共用）
  const enabled = newVal.autoTranslate !== false;
  $('yt-subtitle-toggle').checked = enabled;
  $('drive-subtitle-toggle').checked = enabled;
  // commit 5c:bilingualMode 同步
  $('bilingual-toggle').checked = newVal.bilingualMode === true;
  // 字幕大小 scale 同步
  if (newVal.captionScale != null) $('yt-caption-size').value = String(newVal.captionScale);
});

// v1.0.3: 編輯譯文按鈕
$('edit-btn').addEventListener('click', async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    const resp = await browser.tabs.sendMessage(tab.id, { type: 'TOGGLE_EDIT_MODE' });
    if (resp?.ok) {
      $('edit-btn').textContent = resp.editing ? t('popup.action.editDone') : t('popup.action.editStart');
      statusEl.textContent = resp.editing
        ? t('popup.status.editMode', { count: resp.elements })
        : t('popup.status.editEnded');
      statusEl.style.color = resp.editing ? '#0071e3' : '#86868b';
    }
  } catch {
    statusEl.textContent = t('popup.status.editFailed');
    statusEl.style.color = '#ff3b30';
  }
});

// v1.8.41:Firefox popup 內 native confirm() 會被視窗寬度卡住、按鈕被切掉看不見，
// 改用 inline 確認 UI——點「清除快取」→ 隱藏按鈕，顯示「確定清除？是 / 否」確認列。
$('clear-cache-btn').addEventListener('click', () => {
  $('clear-cache-btn').hidden = true;
  $('clear-cache-confirm').hidden = false;
});

$('clear-cache-no').addEventListener('click', () => {
  $('clear-cache-confirm').hidden = true;
  $('clear-cache-btn').hidden = false;
});

$('clear-cache-yes').addEventListener('click', async () => {
  $('clear-cache-confirm').hidden = true;
  $('clear-cache-btn').hidden = false;
  const resp = await browser.runtime.sendMessage({ type: 'CLEAR_CACHE' });
  if (resp?.ok) {
    statusEl.textContent = t('popup.status.cacheCleared', { count: resp.removed });
    statusEl.style.color = '#34c759';
    refreshCacheInfo();
  } else {
    statusEl.textContent = t('popup.status.cacheClearFailed', { error: resp?.error || t('common.errorUnknown') });
    statusEl.style.color = '#ff3b30';
  }
});

// v2.0.71：累計費用「清除」——同 clear-cache 的 inline 確認 UI 模式（Firefox popup
// 不能用 native confirm）。「清除」只寫 usageResetAt 顯示基準點（storage.local），
// usage-db 紀錄一筆都不刪，options 用量明細分頁不受影響。
$('clear-usage-btn').addEventListener('click', () => {
  $('clear-usage-btn').hidden = true;
  $('clear-usage-confirm').hidden = false;
});

$('clear-usage-no').addEventListener('click', () => {
  $('clear-usage-confirm').hidden = true;
  $('clear-usage-btn').hidden = false;
});

$('clear-usage-yes').addEventListener('click', async () => {
  $('clear-usage-confirm').hidden = true;
  $('clear-usage-btn').hidden = false;
  try {
    await browser.storage.local.set({ usageResetAt: Date.now() });
    refreshUsageInfo();
  } catch {
    $('usage-info').textContent = t('popup.usage.unreadable');
  }
});

init();
