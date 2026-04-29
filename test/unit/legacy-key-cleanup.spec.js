// Unit test: lib/storage.js cleanupLegacySyncKeys(v1.8.14)
//
// 原 bug(v1.8.13 review C3):options.js load() 用 storage.sync.get(null) 拉全部,
// 但 save() 只寫當前版本認得的欄位 → 已棄用的舊 key(例:v1.2.38 移除的
// ytPreserveLineBreaks / preserveLineBreaks)永遠躺在 sync 佔 quota。
// storage.sync 單 item quota 8KB, 全部 100KB,長期累積 + 兩段 prompt
// (systemInstruction / ytSystemPrompt)就可能踩到 QUOTA_BYTES。
//
// 修法:lib/storage.js 新增 cleanupLegacySyncKeys(),SW 啟動時呼叫一次,
// 把已知 legacy keys 從 sync 移除。新增 legacy key 時直接加進 LEGACY_SYNC_KEYS 陣列。
//
// SANITY 已驗(2026-04-28):把 cleanup body 改成空 function,test 1 fail。還原後 pass。

import { test, expect } from '@playwright/test';

test('cleanupLegacySyncKeys: 殘留的 legacy keys 應從 sync 移除', async () => {
  let removedKeys = null;
  const syncStorage = {
    ytPreserveLineBreaks: true,    // 殘留 1
    preserveLineBreaks: false,     // 殘留 2
    geminiConfig: { model: 'x' },  // 仍在用,不該被刪
  };

  globalThis.chrome = {
    storage: {
      sync: {
        get: async (keys) => {
          // keys 是陣列,只回有的
          const out = {};
          for (const k of keys) if (k in syncStorage) out[k] = syncStorage[k];
          return out;
        },
        remove: async (keys) => {
          removedKeys = keys.slice();
          for (const k of keys) delete syncStorage[k];
        },
      },
      local: { get: async () => ({}) },
      onChanged: { addListener: () => {} },
    },
  };

  const { cleanupLegacySyncKeys } = await import(
    '../../shinkansen/lib/storage.js?cb=' + Date.now()
  );

  await cleanupLegacySyncKeys();

  expect(
    removedKeys,
    `應呼叫 storage.sync.remove 並把兩個殘留 legacy key 都帶上(實際:${JSON.stringify(removedKeys)})`,
  ).toEqual(expect.arrayContaining(['ytPreserveLineBreaks', 'preserveLineBreaks']));
  expect(removedKeys.length, '只該移除 legacy keys,不該動其他欄位').toBe(2);
  expect(syncStorage.geminiConfig, 'geminiConfig 仍在用,不該被刪').toBeDefined();
});

test('cleanupLegacySyncKeys: 沒有 legacy key 殘留時不應呼叫 remove', async () => {
  let removeCalled = false;
  globalThis.chrome = {
    storage: {
      sync: {
        get: async () => ({}), // 全空
        remove: async () => { removeCalled = true; },
      },
      local: { get: async () => ({}) },
      onChanged: { addListener: () => {} },
    },
  };

  const { cleanupLegacySyncKeys } = await import(
    '../../shinkansen/lib/storage.js?cb=' + Date.now()
  );

  await cleanupLegacySyncKeys();

  expect(removeCalled, '沒有 legacy 殘留時 remove 不該被呼叫').toBe(false);
});

test('cleanupLegacySyncKeys: 重複呼叫不應重複觸發 remove(冪等)', async () => {
  let removeCount = 0;
  const syncStorage = { ytPreserveLineBreaks: true };
  globalThis.chrome = {
    storage: {
      sync: {
        get: async (keys) => {
          const out = {};
          for (const k of keys) if (k in syncStorage) out[k] = syncStorage[k];
          return out;
        },
        remove: async (keys) => {
          removeCount++;
          for (const k of keys) delete syncStorage[k];
        },
      },
      local: { get: async () => ({}) },
      onChanged: { addListener: () => {} },
    },
  };

  const { cleanupLegacySyncKeys } = await import(
    '../../shinkansen/lib/storage.js?cb=' + Date.now()
  );

  await cleanupLegacySyncKeys();
  await cleanupLegacySyncKeys();
  await cleanupLegacySyncKeys();

  expect(removeCount, '冪等保護:重複呼叫只該觸發 1 次 remove').toBe(1);
});
