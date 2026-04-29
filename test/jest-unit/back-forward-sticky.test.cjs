'use strict';

/**
 * v1.4.18 regression: 瀏覽器前進後退（back_forward）應保留 sticky 翻譯。
 *
 * Bug（v1.4.12–v1.4.17）：content.js 初始化時 `performance.getEntriesByType('navigation')[0].type`
 * 為 `'reload'` 或 `'back_forward'` 就送 `STICKY_CLEAR`。導致 A 翻譯後點連結到 B（自動翻譯）、
 * 按返回鍵回 A 時 STICKY_CLEAR 被觸發 → 後續 STICKY_QUERY 回 false → A 顯示英文。
 *
 * 修法（v1.4.18）：只有 `'reload'` 清 sticky。`'back_forward'` 視同正常歷史切換，走
 * STICKY_QUERY 繼承 opener / 之前的 sticky 狀態。
 *
 * 這組 test 直接 mock jsdom window.performance.getEntriesByType + 攔截
 * chrome.runtime.sendMessage 觀察 STICKY_CLEAR / STICKY_QUERY 的發送順序。
 */

const { JSDOM } = require('jsdom');
const { contentScriptCodes } = require('./helpers/create-env.cjs');

/**
 * 建立 jsdom 環境，指定 `performance.getEntriesByType('navigation')` 的回傳型別。
 * 同時攔截 chrome.runtime.sendMessage，記錄被送出的訊息。
 */
function createEnvWithNavType({ navType, url = 'https://example.com/page-a' }) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const win = dom.window;

  // Mock performance.getEntriesByType：只覆寫 'navigation' 這條路徑
  const origGet = win.performance.getEntriesByType?.bind(win.performance);
  win.performance.getEntriesByType = (type) => {
    if (type === 'navigation') {
      return navType == null ? [] : [{ type: navType }];
    }
    return origGet ? origGet(type) : [];
  };

  const sentMessages = [];
  const chromeMock = {
    runtime: {
      id: 'mock-extension-id',
      sendMessage: jest.fn().mockImplementation((msg) => {
        sentMessages.push(msg);
        // STICKY_QUERY 預設回 no-translate，讓這組 test 聚焦在「CLEAR 有沒有被送」
        if (msg?.type === 'STICKY_QUERY') {
          return Promise.resolve({ ok: true, shouldTranslate: false, slot: null });
        }
        return Promise.resolve({ ok: true });
      }),
      getManifest: jest.fn().mockReturnValue({ version: '1.4.18' }),
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

  for (const code of contentScriptCodes) {
    win.eval(code);
  }

  return {
    win,
    chrome: chromeMock,
    sentMessages,
    cleanup: () => win.close(),
  };
}

// init IIFE 是 async，要等它跑完。檢查是否已送 STICKY_QUERY 或 STICKY_CLEAR 任一個
// （兩條路徑最後至少會送其一），等到訊息出現或 timeout。
async function waitForInitSettled(sentMessages, { timeout = 2000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (sentMessages.some(m => m?.type === 'STICKY_QUERY' || m?.type === 'STICKY_CLEAR')) {
      return;
    }
    await new Promise(r => setTimeout(r, 30));
  }
}

describe('v1.4.18: back_forward navigation preserves sticky', () => {
  let env;
  afterEach(() => { if (env) { env.cleanup(); env = null; } });

  test('navType=back_forward → 不送 STICKY_CLEAR，改走 STICKY_QUERY', async () => {
    env = createEnvWithNavType({ navType: 'back_forward' });
    await waitForInitSettled(env.sentMessages);

    const types = env.sentMessages.map(m => m?.type);
    // back_forward 不該送 STICKY_CLEAR
    expect(types).not.toContain('STICKY_CLEAR');
    // 應走 STICKY_QUERY 繼承之前的 sticky 狀態
    expect(types).toContain('STICKY_QUERY');
  });

  test('navType=reload → 仍送 STICKY_CLEAR（reload 語意保留）', async () => {
    env = createEnvWithNavType({ navType: 'reload' });
    await waitForInitSettled(env.sentMessages);

    const types = env.sentMessages.map(m => m?.type);
    expect(types).toContain('STICKY_CLEAR');
    // reload 分支走完後不會送 STICKY_QUERY（if/else 結構）
    expect(types).not.toContain('STICKY_QUERY');
  });

  test('navType=navigate → 不送 STICKY_CLEAR，走 STICKY_QUERY', async () => {
    env = createEnvWithNavType({ navType: 'navigate' });
    await waitForInitSettled(env.sentMessages);

    const types = env.sentMessages.map(m => m?.type);
    expect(types).not.toContain('STICKY_CLEAR');
    expect(types).toContain('STICKY_QUERY');
  });
});
