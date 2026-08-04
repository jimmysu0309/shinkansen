// Unit test: openai-compat translateBatch 多 chunk 失敗時，err.usage 必須「相加」
// 外層已完成 chunk 的累積(code review 2026-08-03 批次 2 E2)
//
// 原 bug:lib/openai-compat.js translateBatch 的 catch 是
//   `if (err && typeof err === 'object' && !err.usage) err.usage = { ...usage }`
// ——當失敗 chunk 走了 perSegmentFallback(err.usage 已在 fallback 內掛上該 chunk 的
// aggUsage)，外層因 `!err.usage` 為 false 而不把「前面已完成 chunk」的累積 usage 加進
// 去。custom provider 批次 3 chunk:chunk 0-1 成功付費、chunk 2 mismatch → 逐段
// fallback 半途 throw → background 只記到 chunk 2 的 usage,chunk 0-1 的已付費 token
// 永遠漏帳。對照 gemini.js:728-736 是「partial + 外層累積」相加——兩引擎 drift。
//
// 修法：比照 gemini.js,err.usage 已存在時仍相加外層累積。
//
// Mock 策略：替換 globalThis.fetch。4 段 + maxUnitsPerBatch=2 → 兩個 chunk;
// call 1(chunk A 多段)成功、call 2(chunk B 多段)回 3 parts 且無序號標記
// (realign 失敗)→ 逐段 fallback、call 3(fallback 段 1)成功、call 4(fallback 段 2)
// 網路錯誤 throw。maxRetries=0 立即放棄。
//
// SANITY 紀錄(已驗證，2026-08-04)：暫時把 openai-compat.js translateBatch catch 改回
// `if (... && !err.usage) err.usage = { ...usage }` → case 1 fail
// (err.usage.inputTokens 收到 200 非 300，外層 chunk A 的 100 沒加進去)→ 還原 → pass。
import { test, expect } from '@playwright/test';

// stub chrome storage(openai-compat.js → logger.js → storage.js 需要)
globalThis.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    sync: { get: async () => ({}), remove: async () => {}, set: async () => {} },
    onChanged: { addListener: () => {} },
  },
  runtime: { getManifest: () => ({ version: 'test' }) },
};

const { DELIMITER } = await import('../../shinkansen/lib/system-instruction.js');
const { translateBatch } = await import('../../shinkansen/lib/openai-compat.js');

const SETTINGS = {
  maxRetries: 0,           // fetch 失敗立即放棄(測試提速)
  maxUnitsPerBatch: 2,     // 4 段 → 2 chunk
  targetLanguage: 'zh-TW',
  customProvider: {
    baseUrl: 'https://provider.test/v1',
    model: 'test-model',
    apiKey: 'test-key',
    systemPrompt: '翻譯成台灣繁體中文。',
    temperature: 0.3,
  },
};

const TEXTS = [
  'First sentence for chunk A.',
  'Second sentence for chunk A.',
  'Third sentence for chunk B.',
  'Fourth sentence for chunk B.',
];

function oaJson(content) {
  return {
    choices: [{ finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  };
}

// fetchWithRetry 需要 status / headers / text() / clone()
function mockResp(json) {
  const r = {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    text: async () => JSON.stringify(json),
    json: async () => json,
  };
  r.clone = () => r;
  return r;
}

// call 序：1=chunk A(成功) 2=chunk B(3 parts mismatch，無標記 → realign 失敗)
// 3=fallback 段 1(成功) 4=fallback 段 2(網路錯誤)
function makeFetchMock({ failOnCall, mismatchOnCall }) {
  let call = 0;
  return async (_url, opts) => {
    call++;
    if (call === failOnCall) throw new Error('network down');
    const body = JSON.parse(opts.body);
    const input = body.messages[1].content;
    const isMulti = input.includes('SHINKANSEN_SEP');
    if (call === mismatchOnCall) {
      // 3 parts、無序號標記 → parts.length !== texts.length 且 realign 失敗
      return mockResp(oaJson(['錯一', '錯二', '錯三'].join(DELIMITER)));
    }
    if (isMulti) {
      const n = input.split('<<<SHINKANSEN_SEP>>>').length;
      return mockResp(oaJson(Array.from({ length: n }, (_, i) => `譯文${i + 1}`).join(DELIMITER)));
    }
    return mockResp(oaJson('單段譯文'));
  };
}

test('E2: chunk B 逐段 fallback 半途失敗 → err.usage = chunk A + chunk B 初始 + fallback 段 1 相加', async () => {
  const originalFetch = globalThis.fetch;
  // chunk A 成功(100/50)→ chunk B mismatch(100/50)→ fallback 段 1 成功(100/50)
  // → fallback 段 2 網路錯誤 → err.usage 應 = 300/150
  globalThis.fetch = makeFetchMock({ mismatchOnCall: 2, failOnCall: 4 });
  try {
    let caught = null;
    try {
      await translateBatch(TEXTS, SETTINGS);
    } catch (err) {
      caught = err;
    }
    expect(caught, 'translateBatch 應 reject').not.toBeNull();
    expect(caught.usage, 'err.usage 應存在').toBeTruthy();
    expect(caught.usage.inputTokens, '外層 chunk A 的 100 必須加進 fallback 已掛的 200').toBe(300);
    expect(caught.usage.outputTokens).toBe(150);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('E2: chunk B 初始 fetch 就失敗(err 無 usage)→ err.usage = chunk A 累積', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetchMock({ failOnCall: 2 });
  try {
    let caught = null;
    try {
      await translateBatch(TEXTS, SETTINGS);
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.usage).toBeTruthy();
    expect(caught.usage.inputTokens).toBe(100);
    expect(caught.usage.outputTokens).toBe(50);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('E2: 全部成功時行為不變(translations 對齊 + usage 累加)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetchMock({});
  try {
    const res = await translateBatch(TEXTS, SETTINGS);
    expect(res.translations.length).toBe(4);
    expect(res.translations.every(t => typeof t === 'string' && t.length > 0)).toBe(true);
    expect(res.usage.inputTokens).toBe(200); // 2 chunks × 100
    expect(res.usage.outputTokens).toBe(100);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
