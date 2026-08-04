// Unit test: 自訂模型 temperature 留空(null)→ 請求 body 一律不送 temperature 欄位
//(GitHub issue #60,v2.0.79)
//
// 為什麼:部分 reasoning model 只接受自家預設 temperature,body 帶了這個欄位就直接
// 400。原本 adapter 寫死 `temperature: typeof temperature === 'number' ? temperature : 0.7`,
// 使用者把欄位清空也還是被回填 0.7,等於沒有「不送」這個選項。
//
// 兩條送往同一 provider endpoint 的路徑都要鎖:
//   1. translateChunk(主翻譯 / 字幕 / 文件)——讀 customProvider.temperature
//   2. extractGlossary(術語表抽取)——自己讀 glossary.temperature,但 provider 不吃
//      temperature 時同樣不能送(否則主翻譯正常、一開術語表就 400)
//
// 本 spec 直接 import 真實 lib/openai-compat.js 並攔 fetch 讀 body(不複製邏輯,
// 避免與實作 drift)。
//
// 驗的訊號層次:
//   - 驗:adapter 組出來的 request body 有沒有 temperature 欄位、值是多少
//   - 不驗:options UI 存 null 的路徑(由 test/regression/options-cp-temperature-blank.spec.js
//     驗真實存讀)、background 對 doc / ASR override 的讓位(由同 spec 的 source 斷言鎖)
//
// SANITY 紀錄(已驗證):把 lib/openai-compat.js 的 `if (temperature !== null)` 改回
//   無條件 `body.temperature = typeof temperature === 'number' ? temperature : 0.7;`
//   →「temperature = null → body 不含 temperature」case fail(收到 0.7);
//   把 extractGlossary 的 `if (cp.temperature !== null)` 拿掉 → 術語表那條 case fail。
//   還原後全綠。
import { test, expect } from '@playwright/test';

globalThis.chrome = {
  storage: {
    sync: { get: async () => ({}), remove: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

let lastBody = null;
globalThis.fetch = async (_url, options) => {
  lastBody = JSON.parse(options.body);
  return new Response(JSON.stringify({
    choices: [{ message: { content: '譯文' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const { translateBatch, extractGlossary } = await import('../../shinkansen/lib/openai-compat.js');

function settingsWith(temperature, extra = {}) {
  const cp = {
    baseUrl: 'https://api.example.com/v1',
    model: 'some/reasoning-model',
    systemPrompt: 'system',
    apiKey: 'sk-test',
  };
  // undefined 要真的「沒有這個 key」才能驗舊設定的 fallback 行為
  if (temperature !== undefined) cp.temperature = temperature;
  return { customProvider: cp, maxRetries: 0, ...extra };
}

test.beforeEach(() => { lastBody = null; });

test('translate:temperature = null → body 不含 temperature 欄位', async () => {
  await translateBatch(['Hello'], settingsWith(null), null, null, null);
  expect('temperature' in lastBody, `body: ${JSON.stringify(lastBody)}`).toBe(false);
});

test('translate:temperature 為數字 → 照送使用者設定值(含 0)', async () => {
  await translateBatch(['Hello'], settingsWith(0.5), null, null, null);
  expect(lastBody.temperature).toBe(0.5);

  await translateBatch(['Hello'], settingsWith(0), null, null, null);
  expect(lastBody.temperature).toBe(0);
});

test('translate:temperature 未設定(舊設定沒這個 key)→ 維持 0.7 fallback', async () => {
  await translateBatch(['Hello'], settingsWith(undefined), null, null, null);
  expect(lastBody.temperature).toBe(0.7);
});

test('glossary:customProvider.temperature = null → 術語表請求也不送 temperature', async () => {
  await extractGlossary('some compressed text', settingsWith(null, {
    glossary: { prompt: 'extract', temperature: 0.1 },
  }));
  expect('temperature' in lastBody, `body: ${JSON.stringify(lastBody)}`).toBe(false);
});

test('glossary:customProvider.temperature 有值 → 術語表照送自己的 temperature', async () => {
  await extractGlossary('some compressed text', settingsWith(0.7, {
    glossary: { prompt: 'extract', temperature: 0.1 },
  }));
  expect(lastBody.temperature).toBe(0.1);
});
