// Unit test: RateLimiter currentTokenSum incremental(v1.8.14 E8)
//
// 原:lib/rate-limiter.js currentTokenSum() 每次呼叫都 reduce 整個 tokens 陣列。
// tier2 Flash Lite 容許 10K RPM,陣列可達數千 entries,熱路徑 O(n) 累加。
//
// 修法:維護 _tokenSum 變數,push += / shift -=,O(1) 更新。currentTokenSum 直接讀。
//
// SANITY 已驗(2026-04-29):把 _tokenSum 增量同步註解掉,
// "sum 應與直接 reduce 結果一致" test fail。還原後 pass。

import { test, expect } from '@playwright/test';

// stub chrome storage(RateLimiter 內部會 import logger/compat,間接需要 chrome)
globalThis.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener: () => {} },
  },
  runtime: { getManifest: () => ({ version: 'test' }) },
};

const { RateLimiter } = await import('../../shinkansen/lib/rate-limiter.js');

function reduceSum(limiter) {
  return limiter.tokens.reduce((s, e) => s + e.n, 0);
}

test('currentTokenSum 應與直接 reduce 結果一致(空 tokens)', () => {
  const lim = new RateLimiter({ rpm: 100, tpm: 1_000_000, rpd: 1000 });
  expect(lim.currentTokenSum()).toBe(0);
  expect(lim.currentTokenSum()).toBe(reduceSum(lim));
});

test('currentTokenSum 在 push 後遞增', () => {
  const lim = new RateLimiter({ rpm: 100, tpm: 1_000_000, rpd: 1000 });
  const now = Date.now();
  lim.tokens.push({ t: now, n: 100 });
  lim._tokenSum += 100;
  lim.tokens.push({ t: now + 10, n: 250 });
  lim._tokenSum += 250;
  expect(lim.currentTokenSum()).toBe(350);
  expect(lim.currentTokenSum()).toBe(reduceSum(lim));
});

test('currentTokenSum 在 pruneWindow shift 後正確扣減', () => {
  const lim = new RateLimiter({ rpm: 100, tpm: 1_000_000, rpd: 1000 });
  const now = Date.now();
  // 60 秒前的舊條目(會被 prune)
  lim.tokens.push({ t: now - 70_000, n: 500 });
  lim._tokenSum += 500;
  // 視窗內條目(留下)
  lim.tokens.push({ t: now - 10_000, n: 200 });
  lim._tokenSum += 200;
  lim.tokens.push({ t: now - 5_000, n: 300 });
  lim._tokenSum += 300;

  expect(lim.currentTokenSum(), 'prune 前').toBe(1000);

  lim.pruneWindow(now);

  expect(lim.tokens.length, 'prune 後應剩 2 條').toBe(2);
  expect(lim.currentTokenSum(), 'prune 後 _tokenSum 應扣掉 500').toBe(500);
  expect(lim.currentTokenSum(), 'prune 後 sum 仍與 reduce 結果一致').toBe(reduceSum(lim));
});

test('多次 prune 後 _tokenSum 仍與 reduce 一致(壓力測試)', () => {
  const lim = new RateLimiter({ rpm: 100, tpm: 1_000_000, rpd: 1000 });
  const baseT = Date.now() - 200_000;
  // 100 條跨越 200 秒的條目
  for (let i = 0; i < 100; i++) {
    lim.tokens.push({ t: baseT + i * 2_000, n: 10 + i });
    lim._tokenSum += 10 + i;
  }
  // 分多次 prune 模擬時間推進
  for (let advance = 0; advance < 200_000; advance += 10_000) {
    lim.pruneWindow(baseT + advance + 60_000);
    expect(lim.currentTokenSum(), `prune at +${advance}ms 後 sum 應 = reduce`).toBe(reduceSum(lim));
  }
});
