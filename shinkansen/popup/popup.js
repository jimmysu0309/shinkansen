// popup.js — 工具列面板邏輯

import { browser } from '../lib/compat.js';
import { formatBytes, formatTokens, formatUSD } from '../lib/format.js';
import { RELEASE_HIGHLIGHTS } from '../lib/release-highlights.js';
import { shouldShowWelcomeNotice } from '../lib/welcome-notice.js';
import { isWorthNotifying } from '../lib/update-check.js';
import { pickPopupSlot, presetsRequireGemini } from '../lib/storage.js';

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
    const resp = await browser.runtime.sendMessage({ type: 'USAGE_STATS' });
    if (resp?.ok) {
      const totalTok = (resp.totalInputTokens || 0) + (resp.totalOutputTokens || 0);
      $('usage-info').textContent =
        `累計：${formatUSD(resp.totalCostUSD || 0)} / ${formatTokens(totalTok)} tokens`;
    } else {
      $('usage-info').textContent = '累計：讀取失敗';
    }
  } catch {
    $('usage-info').textContent = '累計：無法讀取';
  }
}

async function refreshCacheInfo() {
  try {
    const resp = await browser.runtime.sendMessage({ type: 'CACHE_STATS' });
    if (resp?.ok) {
      $('cache-info').textContent =
        `快取：${resp.count} 段 / ${formatBytes(resp.bytes)}`;
    } else {
      $('cache-info').textContent = '快取：讀取失敗';
    }
  } catch {
    $('cache-info').textContent = '快取：無法讀取';
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
      btn.textContent = '顯示原文';
      btn.dataset.mode = 'restore';
      // v1.0.3: 已翻譯時顯示編輯按鈕
      editBtn.hidden = false;
      editBtn.textContent = resp?.editing ? '結束編輯' : '編輯譯文';
    } else {
      btn.textContent = '翻譯本頁';
      btn.dataset.mode = 'translate';
      editBtn.hidden = true;
    }
  } catch {
    // 頁面尚未注入 content script (例如 chrome:// 頁、剛 reload extension)
    // 維持預設「翻譯本頁」即可
    btn.textContent = '翻譯本頁';
    btn.dataset.mode = 'translate';
    editBtn.hidden = true;
  }
}

async function refreshShortcutHint() {
  // v1.4.13: popup 按鈕觸發 TOGGLE_TRANSLATE 訊息，content.js 將其映射為 preset slot 2（Flash）。
  // 所以這裡讀「主要預設」的當前鍵位顯示。
  // v1.8.19: 主要預設 command id 改為 translate-preset-0(字典序保證 chrome://extensions/shortcuts 顯示在最上)
  const el = $('shortcut-hint');
  if (!el) return;
  try {
    const cmds = await browser.commands.getAll();
    const cmd = cmds.find((c) => c.name === 'translate-preset-0');
    const shortcut = cmd?.shortcut?.trim();
    if (shortcut) {
      el.textContent = `${shortcut} 快速切換`;
    } else {
      // 使用者可能在 chrome://extensions/shortcuts 清掉了快捷鍵
      el.textContent = '未設定快捷鍵';
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
document.addEventListener('click', async (e) => {
  if (!e.target.closest('#update-banner')) return;
  e.preventDefault();
  try {
    const { updateAvailable } = await browser.storage.local.get('updateAvailable');
    // 三層 fallback：storage.releaseUrl > 用 version 組 tag URL > releases 索引頁
    // 即使 storage 內缺 releaseUrl 或損壞也能跳到合理頁面
    const url = updateAvailable?.releaseUrl
      || (updateAvailable?.version
        ? `https://github.com/jimmysu0309/shinkansen/releases/tag/v${updateAvailable.version}`
        : 'https://github.com/jimmysu0309/shinkansen/releases');
    await browser.tabs.create({ url });
    window.close();
  } catch (err) {
    console.error('[shinkansen] update-banner click failed', err);
  }
});

async function init() {
  // 從 manifest 動態讀版本號，避免日後忘記同步
  const manifest = browser.runtime.getManifest();
  $('version').textContent = 'v' + manifest.version;

  refreshShortcutHint();

  // v1.6.5: welcome banner（CWS 剛升級）優先於 update banner（GitHub 有新版）顯示。
  // 兩者互斥——CWS 自動升級後使用者不需要看「有新版可下載」（已在最新），看「歡迎升級」即可；
  // unpacked 使用者沒 onInstalled update 事件，看到的是黃色 update banner。
  let welcomeShown = false;
  try {
    const { welcomeNotice } = await browser.storage.local.get('welcomeNotice');
    const decision = shouldShowWelcomeNotice(welcomeNotice, manifest.version);
    if (decision.removeStale) {
      // 過期殘留(不同 minor 系列)→ 清除避免日後誤顯示
      await browser.storage.local.remove('welcomeNotice');
    } else if (decision.show) {
      welcomeShown = true;
      $('update-dot').hidden = false;
      $('welcome-banner').hidden = false;
      $('welcome-banner-title').textContent = `🎉 已升級至 v${welcomeNotice.version}`;
      $('welcome-bullets').innerHTML = RELEASE_HIGHLIGHTS
        .map(h => `<li>${highlightToHtml(h)}</li>`)
        .join('');
    }
  } catch { /* 略 */ }

  // v1.6.1: 更新提示 — 有新版時顯示版本紅點 + banner（welcome 顯示時跳過）
  if (!welcomeShown) {
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
          $('update-banner-version').textContent = `v${updateAvailable.version}（你目前是 v${manifest.version}）`;
        }
      }
    } catch { /* 讀取失敗就略過 */ }
  }

  // v0.62 起：autoTranslate 仍走 sync（跨裝置同步），apiKey 改走 local（不同步）
  const { autoTranslate = false, displayMode = 'single', translatePresets = [] } = await browser.storage.sync.get(['autoTranslate', 'displayMode', 'translatePresets']);
  const { apiKey = '' } = await browser.storage.local.get(['apiKey']);
  $('auto').checked = autoTranslate;

  // v1.5.0: 顯示模式 toggle 初始狀態
  setDisplayModeButtons(displayMode === 'dual' ? 'dual' : 'single');

  // v0.73: 術語表一致化開關（讀 browser.storage.sync 的 glossary.enabled）
  try {
    const { glossary: gc } = await browser.storage.sync.get('glossary');
    $('glossary-toggle').checked = gc?.enabled ?? false;
  } catch { /* 讀取失敗時維持預設 checked */ }

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
    }
    // commit 5a':Drive 影片 viewer toggle 共用 ytSubtitle.autoTranslate
    // (user 不需要為 Drive 多做設定,跟 YouTube 字幕用同一個開關)
    if (/^https:\/\/drive\.google\.com\/file\//.test(url)) {
      $('drive-subtitle-row').hidden = false;
      const { ytSubtitle = {} } = await browser.storage.sync.get('ytSubtitle');
      $('drive-subtitle-toggle').checked = ytSubtitle.autoTranslate !== false;
    }
    // commit 5c:雙語對照 toggle(YouTube + Drive 影片頁都顯示,共用 ytSubtitle.bilingualMode)
    if (url.includes('youtube.com/watch') || /^https:\/\/drive\.google\.com\/file\//.test(url)) {
      $('bilingual-row').hidden = false;
      const { ytSubtitle = {} } = await browser.storage.sync.get('ytSubtitle');
      $('bilingual-toggle').checked = ytSubtitle.bilingualMode === true;
    }
  } catch { /* 非影片頁面,保持 hidden */ }

  // v1.8.12: 只有當 translatePresets 中有任一 slot 用 Gemini engine 時,才提醒未設 API Key。
  // 使用者若三組 preset 都改成 Google MT / 自訂模型,popup 不再嘮叨他沒填 Gemini Key。
  if (!apiKey && presetsRequireGemini(translatePresets)) {
    statusEl.textContent = '狀態：⚠ 尚未設定 API Key';
    statusEl.style.color = '#ff3b30';
  }

  refreshCacheInfo();
  refreshUsageInfo();
  refreshTranslateButton();
}

$('translate-btn').addEventListener('click', async () => {
  // v1.8.20: 雙擊防護——點擊期間 disable 按鈕,避免快速連按兩次導致第二次被
  // content.js 解讀為 abort/restore(toggle 行為)
  const btn = $('translate-btn');
  if (btn.disabled) return;
  btn.disabled = true;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { btn.disabled = false; return; }
  const mode = btn.dataset.mode;
  statusEl.textContent = mode === 'restore' ? '狀態：正在還原原文…' : '狀態：正在翻譯…';
  try {
    // v1.6.6: 讀 settings.popupButtonSlot 決定按鈕對應的 preset slot（預設 2 = Flash）
    // content.js handleTranslatePreset 自帶 toggle 行為（已翻譯 → 還原 / 翻譯中 → abort / 閒置 → 翻譯）
    const { popupButtonSlot } = await browser.storage.sync.get('popupButtonSlot');
    const slot = pickPopupSlot(popupButtonSlot);
    await browser.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PRESET', payload: { slot } });
    window.close();
  } catch (err) {
    statusEl.textContent = '狀態：無法在此頁面執行，請重新整理後再試';
    statusEl.style.color = '#ff3b30';
    btn.disabled = false;
  }
});

$('auto').addEventListener('change', async (e) => {
  await browser.storage.sync.set({ autoTranslate: e.target.checked });
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
// v1.6.23:改為「Option → Popup」單向 sync。popup toggle 變動只通知當前 tab 即時啟 / 停,
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
    statusEl.textContent = '狀態：無法切換字幕翻譯,請重新整理頁面';
    statusEl.style.color = '#ff3b30';
  }
});

// commit 5a':Drive toggle 共用 ytSubtitle.autoTranslate(寫 storage,跟 YouTube popup
// 的 SET_SUBTITLE message 設計不同——因 Drive 沒 SPA 切影片,單純 storage 即時 sync 即可。
// content-drive.js listen onChanged 即時生效)。
$('drive-subtitle-toggle').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  try {
    const { ytSubtitle = {} } = await browser.storage.sync.get('ytSubtitle');
    await browser.storage.sync.set({
      ytSubtitle: { ...ytSubtitle, autoTranslate: enabled },
    });
  } catch (err) {
    statusEl.textContent = '狀態:無法切換字幕翻譯,請重新整理頁面';
    statusEl.style.color = '#ff3b30';
  }
});

// commit 5c:雙語 toggle change handler(寫 ytSubtitle.bilingualMode 到 storage,YouTube
// 跟 Drive 兩條路徑各自的 onChanged listener 自動反應;切換生效需 reload 影片頁)
$('bilingual-toggle').addEventListener('change', async (e) => {
  const bilingual = e.target.checked;
  try {
    const { ytSubtitle = {} } = await browser.storage.sync.get('ytSubtitle');
    await browser.storage.sync.set({
      ytSubtitle: { ...ytSubtitle, bilingualMode: bilingual },
    });
  } catch (err) {
    statusEl.textContent = '狀態:無法切換雙語對照';
    statusEl.style.color = '#ff3b30';
  }
});

$('options-btn').addEventListener('click', () => {
  browser.runtime.openOptionsPage();
});

// v1.6.23:popup 開著時 reactive sync ytSubtitle.autoTranslate(設定頁同步寫 storage 後立即反映)
// popup 通常 click 外面就關閉,但 detached popup window 或極短時間視窗下這條 listener 確保一致
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.ytSubtitle) return;
  const newVal = changes.ytSubtitle.newValue || {};
  // 同一個 ytSubtitle.autoTranslate 設定同步兩個 popup toggle(YouTube + Drive 共用)
  const enabled = newVal.autoTranslate !== false;
  $('yt-subtitle-toggle').checked = enabled;
  $('drive-subtitle-toggle').checked = enabled;
  // commit 5c:bilingualMode 同步
  $('bilingual-toggle').checked = newVal.bilingualMode === true;
});

// v1.0.3: 編輯譯文按鈕
$('edit-btn').addEventListener('click', async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    const resp = await browser.tabs.sendMessage(tab.id, { type: 'TOGGLE_EDIT_MODE' });
    if (resp?.ok) {
      $('edit-btn').textContent = resp.editing ? '結束編輯' : '編輯譯文';
      statusEl.textContent = resp.editing
        ? `狀態：編輯模式（${resp.elements} 個區塊可編輯）`
        : '狀態：已結束編輯';
      statusEl.style.color = resp.editing ? '#0071e3' : '#86868b';
    }
  } catch {
    statusEl.textContent = '狀態：無法切換編輯模式';
    statusEl.style.color = '#ff3b30';
  }
});

$('clear-cache-btn').addEventListener('click', async () => {
  if (!confirm('確定要清除所有翻譯快取嗎？清除後下次翻譯會重新呼叫 Gemini。')) return;
  const resp = await browser.runtime.sendMessage({ type: 'CLEAR_CACHE' });
  if (resp?.ok) {
    statusEl.textContent = `狀態：已清除 ${resp.removed} 筆快取`;
    statusEl.style.color = '#34c759';
    refreshCacheInfo();
  } else {
    statusEl.textContent = '狀態：清除失敗 — ' + (resp?.error || '未知錯誤');
    statusEl.style.color = '#ff3b30';
  }
});

init();
