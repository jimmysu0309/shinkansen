// Regression: Extension context invalidated 不會洩漏 uncaught error
//
// 修在 v1.8.19: SK.safeSendMessage(content-ns.js) helper + content scripts 31
// 處 caller 全替換。修前 reload extension 後, orphan content script 的
// `browser.runtime.sendMessage(...).catch(() => {})` 因 sendMessage 是 SYNC throw
// (不是 promise reject), `.catch()` 接不到 → uncaught error 洩漏到
// chrome://extensions/ 錯誤面板, 污染真實 bug 能見度。
//
// SANITY 紀錄(已驗證):
//   把 content-ns.js 的 SK.safeSendMessage 內 try/catch 移除 + .catch wrap 移除,
//   spec fail(uncaughtCount > 0)。還原 → pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'br-paragraph';  // 任意 fixture 即可,測試不依賴頁面內容

test('Extension context invalidated 時 SK.safeSendMessage 不洩漏 uncaught error', async ({ context, localServer }) => {
  const page = await context.newPage();

  // 在 navigation 前裝 page-level uncaught listener,確保攔到 content script 的 throw
  await page.addInitScript(() => {
    window.__skUncaught = [];
    window.addEventListener('error', (e) => {
      window.__skUncaught.push({ kind: 'error', msg: e.message });
    });
    window.addEventListener('unhandledrejection', (e) => {
      window.__skUncaught.push({ kind: 'unhandledrejection', msg: String(e.reason?.message || e.reason) });
    });
  });

  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);

  // Stub chrome.runtime.sendMessage 模擬 context invalidated 的 sync throw
  await evaluate(`
    (() => {
      window.__sk_origSendMessage = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = function() {
        throw new Error('Extension context invalidated.');
      };
    })()
  `);

  // 觸發 SK.safeSendMessage 多次(模擬 reload 後各種 caller path 在 orphan 中執行)
  const results = await evaluate(`
    (async () => {
      const r1 = await window.__SK.safeSendMessage({ type: 'CLEAR_BADGE' });
      const r2 = await window.__SK.safeSendMessage({ type: 'STICKY_QUERY' });
      const r3 = await window.__SK.safeSendMessage({ type: 'LOG', payload: { level: 'info' } });
      return { r1, r2, r3 };
    })()
  `);

  // 全部三個呼叫 invalidated 時 resolve undefined, 不 throw, 不洩漏
  expect(results.r1).toBeUndefined();
  expect(results.r2).toBeUndefined();
  expect(results.r3).toBeUndefined();

  // 還原 stub(避免影響其他 test)
  await evaluate(`chrome.runtime.sendMessage = window.__sk_origSendMessage;`);

  // 等一個 microtask 讓 unhandledrejection 有機會 fire(若有)
  await page.waitForTimeout(50);

  const uncaught = await page.evaluate(() => window.__skUncaught);
  expect(uncaught, `不該有 uncaught error/rejection. 實際: ${JSON.stringify(uncaught)}`).toEqual([]);
});

test('async reject 帶 invalidated 訊息也吞掉(SW 端 throw 而非 sync throw 的情境)', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 模擬 sendMessage return 一個 reject Promise(訊息含 "Receiving end does not exist",
  // 這是另一種 SW dead 後的常見錯誤型態)
  const result = await evaluate(`
    (async () => {
      const orig = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = function() {
        return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
      };
      const r = await window.__SK.safeSendMessage({ type: 'CLEAR_BADGE' });
      chrome.runtime.sendMessage = orig;
      return r;
    })()
  `);

  expect(result).toBeUndefined();
});

test('真實業務錯誤(非 invalidated)仍會 reject(不被 helper 吞掉)', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 模擬一個非 invalidated 的真實業務錯誤,helper 不該吞掉
  const result = await evaluate(`
    (async () => {
      const orig = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = function() {
        return Promise.reject(new Error('Translation API quota exceeded'));
      };
      let caught = null;
      try {
        await window.__SK.safeSendMessage({ type: 'TRANSLATE_BATCH' });
      } catch (err) {
        caught = err.message;
      }
      chrome.runtime.sendMessage = orig;
      return caught;
    })()
  `);

  expect(result).toContain('quota exceeded');
});
