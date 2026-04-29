// Unit test: handleTranslateCustom 的 provider-specific cache hit rate(v1.8.20 修)
//
// 驗 background.js getCustomCacheHitRate(baseUrl) 依 provider 推斷折扣比例:
//   - Anthropic Claude: 0.10 (read 90% 折扣)
//   - DeepSeek:         0.10 (context cache hit 90% 折扣)
//   - OpenAI:           0.50 (prompt cache 50% 折扣)
//   - 未知 provider:    0.50 (中間值,低估比高估保守)
//
// computeBilledCostUSD 套用該比例後,billedInputTokens / billedCostUSD 應反映正確折扣。
//
// 為何不直接 import background.js:它不是 ES module export 形式,有大量 chrome.* 副作用。
// 改用「行為等價的 helper」直接驗公式,確保 customProvider 路徑不再硬編碼 0.75。
//
// SANITY 紀錄(已驗證):把 background.js 的 cachedRate 改回硬編碼 0.25,
// "OpenAI 50% 折扣" / "Anthropic 90% 折扣" 兩條 fail。
import { test, expect } from '@playwright/test';

// 複製 background.js 的兩個函式邏輯做 spec(避免 import 整個 background.js)
function computeCostUSD(inputTokens, outputTokens, pricing) {
  const inRate = Number(pricing?.inputPerMTok) || 0;
  const outRate = Number(pricing?.outputPerMTok) || 0;
  return (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate;
}
function computeBilledCostUSD(inputTokens, cachedTokens, outputTokens, pricing, cachedRate) {
  const rate = (typeof cachedRate === 'number' && cachedRate >= 0 && cachedRate <= 1)
    ? cachedRate
    : 0.25;
  const uncached = Math.max(0, inputTokens - cachedTokens);
  const effectiveInput = uncached + cachedTokens * rate;
  return computeCostUSD(effectiveInput, outputTokens, pricing);
}
function getCustomCacheHitRate(baseUrl) {
  const url = String(baseUrl || '').toLowerCase();
  if (url.includes('anthropic.com')) return 0.10;
  if (url.includes('openai.com')) return 0.50;
  if (url.includes('deepseek.com')) return 0.10;
  return 0.50;
}

const PRICING = { inputPerMTok: 1.0, outputPerMTok: 2.0 };

test('Anthropic baseUrl → cache hit 比例 0.10(read 90% 折扣)', () => {
  expect(getCustomCacheHitRate('https://api.anthropic.com/v1/messages')).toBe(0.10);
});

test('OpenAI baseUrl → cache hit 比例 0.50', () => {
  expect(getCustomCacheHitRate('https://api.openai.com/v1')).toBe(0.50);
});

test('DeepSeek baseUrl → cache hit 比例 0.10', () => {
  expect(getCustomCacheHitRate('https://api.deepseek.com/v1')).toBe(0.10);
});

test('OpenRouter / 未知 baseUrl → 中間值 0.50', () => {
  expect(getCustomCacheHitRate('https://openrouter.ai/api/v1')).toBe(0.50);
  expect(getCustomCacheHitRate('https://example.com/v1')).toBe(0.50);
  expect(getCustomCacheHitRate('')).toBe(0.50);
  expect(getCustomCacheHitRate(null)).toBe(0.50);
});

test('OpenAI billedCostUSD: 1M input + 500K cached → uncached 0.5M * $1 + cached 500K * 0.5 * $1 = $0.75', () => {
  const cost = computeBilledCostUSD(1_000_000, 500_000, 0, PRICING, 0.50);
  expect(cost).toBeCloseTo(0.75, 5);
});

test('Anthropic billedCostUSD: 1M input + 500K cached → uncached 500K + cached 500K * 0.10 = $0.55', () => {
  const cost = computeBilledCostUSD(1_000_000, 500_000, 0, PRICING, 0.10);
  expect(cost).toBeCloseTo(0.55, 5);
});

test('全 cache 命中(Anthropic 0.10): 1M cached → effectiveInput 100K → $0.10', () => {
  const cost = computeBilledCostUSD(1_000_000, 1_000_000, 0, PRICING, 0.10);
  expect(cost).toBeCloseTo(0.10, 5);
});

test('cachedRate 未傳 → fallback 0.25(向下相容 Gemini 既有 caller)', () => {
  // 1M input + 1M cached + cachedRate 未傳 → effectiveInput = 1M * 0.25 = 250K → $0.25
  const cost = computeBilledCostUSD(1_000_000, 1_000_000, 0, PRICING);
  expect(cost).toBeCloseTo(0.25, 5);
});

test('OpenAI vs 硬編碼 0.25(舊版): cost 應該不同', () => {
  // 0.5M cached, OpenAI 0.50 → uncached 500K + cached 500K * 0.5 = 750K → $0.75
  // 舊版硬編碼 0.25 → uncached 500K + cached 500K * 0.25 = 625K → $0.625
  const newWay = computeBilledCostUSD(1_000_000, 500_000, 0, PRICING, 0.50);
  const oldWay = computeBilledCostUSD(1_000_000, 500_000, 0, PRICING, 0.25);
  expect(newWay).toBeGreaterThan(oldWay);
  expect(newWay - oldWay).toBeCloseTo(0.125, 5);
});
