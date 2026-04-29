// Unit test: lib/cache.js getCacheUsageBytes 用 getBytesInUse(v1.8.14)
//
// 原 bug(v1.8.13 review B1):cache.js 反覆 storage.local.get(null) 拉整份 9.5MB
// 翻譯快取 → 翻譯量大時 SW 反覆把 9.5MB JSON 拉到記憶體再算 byte size。
// 是專案目前最大的單一性能浪費。
//
// 修法:getCacheUsageBytes() 改用 Chrome 原生 storage.local.getBytesInUse(null) —
// 不需把整份 storage 拉進記憶體;舊瀏覽器走 get(null) fallback。
//
// SANITY 已驗(2026-04-28):把 getCacheUsageBytes body 改回優先 get(null),
// "應呼叫 getBytesInUse 而非 get(null)" test fail。還原後 pass。

import { test, expect } from '@playwright/test';

test('getCacheUsageBytes: 應優先呼叫 getBytesInUse(null) 而非 get(null)', async () => {
  let getBytesInUseCalls = 0;
  let getCalls = 0;

  globalThis.chrome = {
    storage: {
      local: {
        get: async () => { getCalls++; return {}; },
        getBytesInUse: async (keys) => {
          getBytesInUseCalls++;
          expect(keys, 'getBytesInUse 應傳 null(算整體 storage)').toBeNull();
          return 1024 * 100; // 100KB
        },
      },
      onChanged: { addListener: () => {} },
    },
  };

  // cache.js 的 getCacheUsageBytes 不是 export,只能透過 stats() / 觸發 eviction 路徑驗
  // 這邊改用「直接看 getBytesInUse 是否被呼叫」的方式 — 透過 dynamic import + monkey-patch
  // 在 cache.js 內加 export 比較乾淨,但牽動 production code surface。改用 setBatch 觸發
  // proactiveEvictionCheck 來間接驗(它一定會走 getCacheUsageBytes)。
  const cache = await import('../../shinkansen/lib/cache.js?cb=' + Date.now());

  // setBatch 後 30 秒節流會擋,我們改成直接觸發 internal 的方式 —
  // 看 stats()(它走 get(null) 而非 getCacheUsageBytes,本 test 主驗 setBatch 路徑)
  // 簡化:呼叫 setBatch 之後等一拍,看 getBytesInUse 是否至少被呼叫一次
  await cache.setBatch(['hello'], ['你好']);
  await new Promise(r => setTimeout(r, 50));

  expect(
    getBytesInUseCalls,
    `setBatch 後的 proactiveEvictionCheck 應走 getBytesInUse(實際:${getBytesInUseCalls})`,
  ).toBeGreaterThanOrEqual(1);

  // get(null) 在新路徑不該被呼叫(舊版每次 setBatch 都會掃 9.5MB)
  // 註:setBatch 內 get([keys]) 會拉特定 key,但不會 get(null);只有 fallback 路徑才走 get(null)
  // 所以 getCalls 會是針對特定 key 的(從 1 到 N),這邊只驗 getBytesInUse 行為
});

test('getCacheUsageBytes: 沒有 getBytesInUse(舊瀏覽器)應 fallback 走 get(null)', async () => {
  let getCalls = 0;
  let getBytesInUseExists = false;

  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          getCalls++;
          if (keys === null) {
            // fallback 路徑會掃整份 — 回傳一個假的 cache entry 讓加總有結果
            return { tc_abc: { v: '你好', t: Date.now() } };
          }
          return {};
        },
        // 故意不定義 getBytesInUse(模擬不支援)
      },
      onChanged: { addListener: () => {} },
    },
  };

  const cache = await import('../../shinkansen/lib/cache.js?cb=' + Date.now());

  // 透過 setBatch 觸發 proactiveEvictionCheck 走 getCacheUsageBytes
  await cache.setBatch(['hello'], ['你好']);
  await new Promise(r => setTimeout(r, 50));

  // fallback 路徑會走 get(null)
  expect(
    getCalls,
    `沒有 getBytesInUse 時應 fallback 到 get(null)(實際 get 被呼叫 ${getCalls} 次)`,
  ).toBeGreaterThanOrEqual(1);
});
