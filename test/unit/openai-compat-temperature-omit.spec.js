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

// ── 批次 8 E8（code review 2026-08-03）:400 點名 temperature → 自動拿掉重試一次 ──
// 「留空=不送」是設定層逃生口;使用者不知道模型是 reasoning 系（或用預設 0.7 fallback）
// 時仍會 400。translateChunk 對「400 + 錯誤訊息含 temperature + body 有送該欄位」自動
// 拿掉 temperature 原樣重打一次(僅一次,不遞迴)。
//
// SANITY 紀錄(已驗證,2026-08-05):把 lib/openai-compat.js 的
//   `if (resp.status === 400 && ('temperature' in body) && /temperature/i.test(errMsg))`
//   改成 `if (false && ...)` → 「自動重試」case fail(throw 400 錯誤)→ 還原後 pass。

test('E8:400 且錯誤訊息點名 temperature → 拿掉 temperature 自動重試一次成功', async () => {
  const bodies = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) {
      return new Response(JSON.stringify({
        error: { message: "Unsupported value: 'temperature' does not support 0.7 with this model." },
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: '譯文' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const r = await translateBatch(['Hello'], settingsWith(0.7), null, null, null);
    expect(r.translations[0]).toBe('譯文');
    expect(bodies.length).toBe(2);
    expect('temperature' in bodies[0]).toBe(true);
    expect('temperature' in bodies[1]).toBe(false);
  } finally { globalThis.fetch = origFetch; }
});

test('E8 對照組:400 但錯誤與 temperature 無關 → 不重試,照拋原錯誤', async () => {
  const bodies = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ error: { message: 'model not found' } }),
      { status: 400, headers: { 'content-type': 'application/json' } });
  };
  try {
    const err = await translateBatch(['Hello'], settingsWith(0.7), null, null, null).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('model not found');
    expect(bodies.length).toBe(1);
  } finally { globalThis.fetch = origFetch; }
});

test('E8 對照組:body 本來就沒送 temperature(null 設定)→ 400 不觸發重試', async () => {
  const bodies = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ error: { message: 'temperature not supported' } }),
      { status: 400, headers: { 'content-type': 'application/json' } });
  };
  try {
    const err = await translateBatch(['Hello'], settingsWith(null), null, null, null).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(bodies.length).toBe(1);
  } finally { globalThis.fetch = origFetch; }
});
