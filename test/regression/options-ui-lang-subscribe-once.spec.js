// Regression: Code review 2026-06-09 H2 — options.js 的 UI 語系變動訂閱
// (I18N.subscribeUiLanguageChange) 原本寫在 load() 內,而 load() 會被多次呼叫
// (init / 回復預設 / 匯入設定),每次都疊一個 chrome.storage.onChanged listener
// 且丟棄 unsubscribe → 切 UI 語言時 callback 跑 N 次(連帶 refreshExchangeRateDisplay
// 的 sendMessage 放大成多次背景查詢)。
//
// 修法:模組頂層 _uiLangChangeSubscribed 旗標,確保只訂閱一次。
//
// 測法:用 addInitScript 包 chrome.storage.onChanged.addListener / removeListener
// 計淨 listener 數。options 頁載入後 load() 跑一次(+1 uiLanguage 訂閱),再透過
// 匯入觸發第二次 load();修好後淨 listener 數不該增加。
//
// SANITY 紀錄(已驗證):把 options.js 的 `if (!_uiLangChangeSubscribed) { ... }`
// guard 拿掉(恢復成每次 load() 都 subscribe)→ 本 spec fail(第二次 load() 後
// listener +1);還原 guard → pass。

import { test, expect } from '../fixtures/extension.js';

test('UI 語系變動訂閱只註冊一次,即使 load() 被多次呼叫', async ({ context, extensionId }) => {
  const sw = context.serviceWorkers()[0]
    || (await context.waitForEvent('serviceworker', { timeout: 10_000 }));

  await sw.evaluate(async () => {
    await chrome.storage.sync.clear();
    await chrome.storage.sync.set({ uiLanguage: 'zh-TW' });
  });

  const page = await context.newPage();
  // accept 加 catch：dialog 與 page close race 防護（同 options-import-fixed-glossary）
  page.on('dialog', d => d.accept().catch(() => {}));

  // 在頁面任何 script 跑之前,包住 onChanged 的 add / remove 以計淨 listener 數
  await page.addInitScript(() => {
    window.__skOnChangedNet = 0;
    const oc = chrome.storage.onChanged;
    const realAdd = oc.addListener.bind(oc);
    const realRemove = oc.removeListener.bind(oc);
    oc.addListener = (fn) => { window.__skOnChangedNet++; return realAdd(fn); };
    oc.removeListener = (fn) => { window.__skOnChangedNet--; return realRemove(fn); };
  });

  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#import-input', { state: 'attached' });

  // 等首次 load() 完成(輪詢到 onChanged listener 已就緒)
  await page.waitForFunction(() => window.__skOnChangedNet >= 1, { timeout: 5000 });
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => window.__skOnChangedNet);

  // 觸發第二次 load():匯入一份設定(import flow 末尾 await load())
  await page.setInputFiles('#import-input', {
    name: 'shinkansen-settings-reload.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ uiLanguage: 'zh-TW' }), 'utf8'),
  });

  // 等第二次 load() 跑完(import 會 alert importOk,且 storage 寫入)
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => window.__skOnChangedNet);

  // 修好後第二次 load() 不該再 subscribe → 淨 listener 數不變
  expect(after).toBe(before);
});
