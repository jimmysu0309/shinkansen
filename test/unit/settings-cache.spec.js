// Unit test: lib/storage.js getSettingsCached(v1.8.14 settings cache)
//
// 原 bug(v1.8.13 review B2+B3):
//   - logger.js debugLog 每筆都呼 getSettings() → 翻譯量大時每秒上百次
//     storage.sync.get(null) + storage.local.get IPC + 完整深 merge
//   - background.js LOG_USAGE handler 每筆 await getSettings() 解析 model →
//     YouTube 一支影片上百筆 batch,每筆都重讀整份 settings
//
// 修法:lib/storage.js 加 getSettingsCached() promise cache + storage.onChanged
// invalidate;logger.js debugLog 與 background.js LOG_USAGE handler 都改用
// cached 版本。SW 重啟後 module 重 init,cache 自然從零開始。
//
// SANITY 已驗(2026-04-28):
//   把 getSettingsCached body 改回 `return getSettings()` (不 cache),
//   "100 次呼叫只該觸發 1 次 storage.sync.get" test fail。還原後 pass。

import { test, expect } from '@playwright/test';

// 用 dynamic import + globalThis mock 模擬 chrome.storage,避免動 production code
test('getSettingsCached: 100 次呼叫只該觸發 1 次 storage.sync.get(同 cache)', async () => {
  // 計數器:統計 storage.sync.get 與 storage.local.get 被呼叫幾次
  let syncGetCalls = 0;
  let localGetCalls = 0;

  // Mock chrome.storage(必須在 import storage.js 之前掛上)
  const mockSettings = { debugLog: false, geminiConfig: { model: 'gemini-flash' } };
  globalThis.chrome = {
    storage: {
      sync: {
        get: async () => { syncGetCalls++; return mockSettings; },
        remove: async () => {},
      },
      local: {
        get: async () => { localGetCalls++; return {}; },
      },
      onChanged: {
        addListener: () => {},
      },
    },
  };

  // dynamic import(每次 test 重 import 不可行,因為 ES module 有 cache;
  // 改成手動 reset module-scope cache 變數的方法不 portable)
  // 用 cache-busting query string 強制重 import → 拿到全新 module instance
  const { getSettingsCached } = await import(
    '../../shinkansen/lib/storage.js?cb=' + Date.now()
  );

  // 100 次連續呼叫
  for (let i = 0; i < 100; i++) {
    await getSettingsCached();
  }

  expect(
    syncGetCalls,
    `100 次 getSettingsCached 應只觸發 1 次 storage.sync.get(實際:${syncGetCalls})`,
  ).toBe(1);

  expect(
    localGetCalls,
    `100 次 getSettingsCached 應只觸發 ≤ 2 次 storage.local.get(apiKey + customProvider apiKey,實際:${localGetCalls})`,
  ).toBeLessThanOrEqual(2);
});

test('getSettingsCached: storage.onChanged 觸發後應 invalidate 重新讀', async () => {
  let syncGetCalls = 0;
  let onChangedListener = null;

  const mockSettings = { debugLog: false, geminiConfig: { model: 'gemini-flash' } };
  globalThis.chrome = {
    storage: {
      sync: {
        get: async () => { syncGetCalls++; return mockSettings; },
        remove: async () => {},
      },
      local: {
        get: async () => ({}),
      },
      onChanged: {
        addListener: (cb) => { onChangedListener = cb; },
      },
    },
  };

  const { getSettingsCached } = await import(
    '../../shinkansen/lib/storage.js?cb=' + Date.now()
  );

  await getSettingsCached();
  await getSettingsCached();
  expect(syncGetCalls, '兩次連續呼叫應只觸發 1 次').toBe(1);

  // 模擬使用者改 storage(例:options 頁存設定)
  expect(onChangedListener, 'storage.onChanged listener 應已綁上').not.toBeNull();
  onChangedListener({}, 'sync');

  // invalidate 後再次呼叫應重新讀
  await getSettingsCached();
  expect(syncGetCalls, 'onChanged 後應重新觸發 1 次 → 共 2 次').toBe(2);
});
