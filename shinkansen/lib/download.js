// download.js — 擴充功能頁（文件翻譯頁 / 設定頁）把產生的檔案交給使用者存檔的單一入口。
//
// 為什麼需要:iOS / iPadOS Safari 從擴充功能頁觸發 `<a download>` + blob URL 下載會失敗
// ——分頁被導向 blob 網址、顯示「WebKitBlobResource 錯誤 1」，檔案沒存到、原本的頁面
// （含翻好的譯文）也被導走（WebKit bug 226440；2026-11-20 iPad 模擬器實測重現）。
// macOS Safari / Chrome / Firefox 的 `<a download>` 正常。
//
// 分流（平台屬性，見 lib/platform.js）:
//   - iOS build + 觸控裝置（iPhone / iPad）且支援分享檔案 → 系統分享面板
//     （使用者選「儲存到檔案」等）。iOS build 跑在 Mac 上不走這條（macOS Safari 下載正常）
//   - 其他 → `<a download>` + blob URL
//
// 分享面板需要「使用者剛點過」（transient activation）。檔案產生得久（大份 PDF 寫檔）
// 時點擊的時效已過，share 會丟 NotAllowedError → 在頁面底部浮出「儲存檔案」按鈕，
// 使用者再點一次就是新的點擊，可以正常叫出分享面板。
//
// 本檔是所有擴充功能頁下載的單一資料源：新增下載點一律呼叫 saveBlob，不要再手寫
// createObjectURL + a.click()（多處手寫 = 平台修正只會套到其中幾處）。

import { IS_IOS_BUILD } from './distribution.js';
import { isTouchScreenDevice } from './platform.js';

// 是否走分享面板。export 給 spec 鎖分流條件。
export function shouldUseShareSheet() {
  return IS_IOS_BUILD && isTouchScreenDevice()
    && typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

function anchorDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  // 立刻 revoke 會讓部分瀏覽器來不及讀 blob（檔名變 unknown / 下載失敗），留一段時間再收
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
}

async function shareFile(file) {
  try {
    await navigator.share({ files: [file] });
    return 'shared';
  } catch (err) {
    if (err && err.name === 'AbortError') return 'cancelled'; // 使用者關掉分享面板
    if (err && err.name === 'NotAllowedError') return 'need-tap'; // 點擊時效已過
    throw err;
  }
}

const BAR_ID = 'sk-save-file-bar';

// 點擊時效過期時的補救 UI：頁面底部浮出一條「檔案已準備好 + 儲存檔案」。
// 樣式全 inline（文件翻譯頁與設定頁共用，不依賴各頁 CSS）。
function showSaveBar(file, t) {
  document.getElementById(BAR_ID)?.remove();
  const bar = document.createElement('div');
  bar.id = BAR_ID;
  bar.setAttribute('role', 'status');
  bar.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:24px', 'transform:translateX(-50%)',
    'z-index:2147483647', 'display:flex', 'align-items:center', 'gap:12px',
    'max-width:calc(100vw - 32px)', 'box-sizing:border-box', 'padding:12px 16px',
    'background:#fff', 'color:#1d1d1f', 'border-radius:12px',
    'box-shadow:0 4px 20px rgba(0,0,0,0.18)', 'font:15px/1.4 -apple-system,system-ui,sans-serif',
  ].join(';');
  const msg = document.createElement('span');
  msg.textContent = t('download.share.ready', { name: file.name });
  msg.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = t('download.share.save');
  saveBtn.style.cssText = 'flex:none;padding:8px 14px;border:0;border-radius:8px;background:#0071e3;color:#fff;font:inherit;font-weight:600';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', t('download.share.close'));
  closeBtn.style.cssText = 'flex:none;padding:4px 8px;border:0;background:none;color:#6e6e73;font:20px/1 system-ui';
  saveBtn.addEventListener('click', async () => {
    try {
      const r = await shareFile(file);
      if (r !== 'need-tap') bar.remove();
    } catch (err) {
      console.error('[Shinkansen] share failed', err);
      bar.remove();
      anchorDownload(file, file.name);
    }
  });
  closeBtn.addEventListener('click', () => bar.remove());
  bar.append(msg, saveBtn, closeBtn);
  document.body.appendChild(bar);
}

/**
 * 分享面板路徑本體（平台判斷之後）。獨立 export 讓 spec 能在桌面 Chromium 以 mock
 * navigator.share 驗「點擊時效過期 → 浮出儲存按鈕 → 再點一次叫出面板」整條流程。
 * @returns {Promise<'shared'|'cancelled'|'pending-tap'>} 非 Abort / NotAllowed 的錯誤往外丟
 */
export async function saveViaShareSheet(file, t) {
  const r = await shareFile(file);
  if (r !== 'need-tap') return r;
  showSaveBar(file, t || ((key) => window.__SK?.i18n?.t?.(key) ?? key));
  return 'pending-tap';
}

/**
 * 把 blob 交給使用者存檔。
 * @param {Blob} blob
 * @param {string} filename
 * @param {{ t?: (key: string, params?: object) => string }} [opts] 呼叫端頁面的 i18n 函式
 *   （只有分享面板補救 UI 會用到）
 * @returns {Promise<'downloaded'|'shared'|'cancelled'|'pending-tap'>}
 */
export async function saveBlob(blob, filename, opts = {}) {
  if (shouldUseShareSheet()) {
    const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
    if (typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] })) {
      try {
        return await saveViaShareSheet(file, opts.t);
      } catch (err) {
        console.error('[Shinkansen] share failed, fallback to download', err);
      }
    }
  }
  anchorDownload(blob, filename);
  return 'downloaded';
}
