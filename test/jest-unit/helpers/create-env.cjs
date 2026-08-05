'use strict';

/**
 * create-env.cjs — Jest 單元測試用的 content.js 載入 helper
 *
 * 做的事：
 *   1. 用 jsdom 建立一個假的瀏覽器環境（DOM、window、history 等）
 *   2. 加上假的 chrome.runtime / chrome.storage API
 *   3. 把 content.js eval 進去，讓它以為自己在真的 Chrome Extension 裡面跑
 *
 * 這樣就能測試 SPA 導航偵測、Content Guard 等涉及 chrome API 的邏輯，
 * 完全不需要動 shinkansen/ 裡面的任何程式碼。
 *
 * 已知的時間常數（content.js 內部定義，測試的 wait 時間依此推算）：
 *   SPA_URL_POLL_MS      = 500   — URL 輪詢間隔
 *   SPA_NAV_SETTLE_MS    = 800   — SPA 導航後等 DOM 穩定
 *   GUARD_SWEEP_INTERVAL = 1000  — Content Guard 週期性掃描
 */

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

// v1.1.9: content script 拆分為多個檔案，按 manifest.json 的 js 陣列順序依序載入。
// 所有檔案共用同一個 window（jsdom），透過 window.__SK 命名空間互動。
// v1.9.25: 新增 lib/distribution-cs.js(MAS distribution flag)。
// v1.9.26: 新增 lib/i18n.js(content.js translatePage 用 SK.t,從 i18n.js 來)。
//   原本 v1.1.6 sampling test 早退到 SK.t 之前所以沒事;移除整頁 skip 後翻譯 pipeline
//   會走到 SK.t,helper 必須提供 i18n.js 否則 SK.t is not a function。
// v2.0.84: 新增 lib/edit-link-repair.js(content.js 編輯模式模組層
//   window.__SKEditLinkRepair.createEditLinkRepair,缺檔直接 throw)。
const SHINKANSEN_DIR = path.resolve(__dirname, '../../../shinkansen');
const CONTENT_SCRIPT_FILES = [
  'content-ns.js',
  'lib/distribution-cs.js',
  'lib/i18n.js',
  'lib/format-currency.js',
  'lib/domain-utils.js',
  'lib/edit-link-repair.js',
  'content-toast.js',
  'content-detect.js',
  'content-serialize.js',
  'content-inject.js',
  'content-spa.js',
  'content.js',
];
const contentScriptCodes = CONTENT_SCRIPT_FILES.map(f =>
  fs.readFileSync(path.join(SHINKANSEN_DIR, f), 'utf-8')
);

/**
 * 建立乾淨的 jsdom 環境並載入 content.js。
 *
 * @param {Object} [options]
 * @param {string} [options.url='https://example.com/'] — 初始 URL
 * @param {string} [options.html] — 初始 HTML（預設空 body）
 * @returns {{ dom, window, document, chrome, shinkansen, setUrl, navigateHash, cleanup }}
 */
function createEnv(options = {}) {
  const {
    url = 'https://example.com/',
    html = '<!DOCTYPE html><html><head></head><body></body></html>',
  } = options;

  const dom = new JSDOM(html, {
    url,
    runScripts: 'dangerously',   // 讓 window.eval() 能執行 content.js
    pretendToBeVisual: true,      // 提供 requestAnimationFrame、innerHeight 等
  });

  const win = dom.window;

  // ── Chrome API mock ──────────────────────────────────────
  // 只 mock content.js 實際會呼叫的方法，其他不需要。
  // 每個 mock 都用 jest.fn() 包裝，測試可以斷言呼叫次數與參數。
  const chromeMock = {
    runtime: {
      // 有效 extension context 一定帶 runtime.id(orphan 時才變 undefined)。content-spa.js
      // 的 URL 輪詢 interval 用 !chrome.runtime.id 偵測 orphan 自我清除,mock 要反映「活著」。
      id: 'test-extension-id',
      sendMessage: jest.fn().mockImplementation(() => Promise.resolve({})),
      getManifest: jest.fn().mockReturnValue({ version: '1.0.26' }),
      onMessage: { addListener: jest.fn() },
    },
    storage: {
      sync: {
        get: jest.fn().mockImplementation(() => Promise.resolve({})),
      },
      onChanged: { addListener: jest.fn() },
    },
  };
  win.chrome = chromeMock;

  // ── 載入 content script 檔案群 ─────────────────────────
  // v1.1.9: 按 manifest.json 的 js 陣列順序依序 eval，模擬 Chrome 載入行為。
  // 第一個檔案 (content-ns.js) 建立 window.__SK 命名空間，
  // 後續檔案透過 (function(SK) { ... })(window.__SK) 存取共用資源。
  // 最後一個檔案 (content.js) 掛載 window.__shinkansen Debug API。
  for (const code of contentScriptCodes) {
    win.eval(code);
  }

  return {
    dom,
    window: win,
    document: win.document,
    chrome: chromeMock,
    shinkansen: win.__shinkansen,

    /**
     * 靜默改變 URL（不觸發任何事件）。
     * 用途：模擬 SPA 框架用快取的 pushState 導航（monkey-patch 攔不到）。
     * content.js 的 500ms URL 輪詢會偵測到這個變化。
     */
    setUrl(newUrl) {
      dom.reconfigure({ url: newUrl });
    },

    /**
     * 改變 URL + 手動觸發 hashchange 事件。
     * 用途：模擬 Gmail 等 hash-based SPA 的導航。
     */
    navigateHash(newUrl) {
      dom.reconfigure({ url: newUrl });
      win.dispatchEvent(new win.Event('hashchange'));
    },

    /**
     * 清理 jsdom 資源。每個 test 結束後呼叫。
     */
    cleanup() {
      win.close();
    },
  };
}

/**
 * 輪詢等待條件成立。用於正向測試（預期某狀態最終會變化）。
 * 負向測試（預期某事不發生）仍應使用固定等待。
 *
 * @param {Function} conditionFn — 回傳 truthy 代表條件成立
 * @param {Object} [opts]
 * @param {number} [opts.timeout=3000] — 最久等幾毫秒
 * @param {number} [opts.interval=50]  — 每幾毫秒檢查一次
 * @returns {Promise<boolean>} — true 表示條件在 timeout 內成立
 */
async function waitForCondition(conditionFn, { timeout = 3000, interval = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (conditionFn()) return true;
    await new Promise(r => setTimeout(r, interval));
  }
  return false;
}

module.exports = {
  createEnv,
  waitForCondition,
  // v1.1.9: 給自建 env 的測試用 — 讓它們也能載入完整 7 個 content script 檔案,
  // 不用自己硬編檔案清單（順序若與 manifest 不一致會炸）。
  SHINKANSEN_DIR,
  CONTENT_SCRIPT_FILES,
  contentScriptCodes,
};
