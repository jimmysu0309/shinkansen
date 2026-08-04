// Regression(端對端): 自訂模型 Temperature 留空 → 真的送出去的 HTTP body 不含 temperature
//(GitHub issue #60,v2.0.79)
//
// 為什麼要這條:options 存 null(options-cp-temperature-blank.spec.js)與 adapter 組 body
//(test/unit/openai-compat-temperature-omit.spec.js)各自驗過,但中間還有 background
// `handleTranslateCustom` 的 merge —— 文件 / ASR 路徑會把自己的 temperature 塞進 cp
// overrides,沒讓位的話使用者留空仍被偷送。本 spec 起一個假的 OpenAI-compatible server
// 當 provider,走「真 background handler → 真 adapter → 真 fetch」把整條路徑打穿,
// 直接檢查 server 收到的 request body。
//
// 驗的訊號層次:
//   - 驗:真實 HTTP request body 有沒有 temperature 欄位(含文件路徑 override 讓位)
//   - 不驗:provider 端會不會因為帶 temperature 回 400(那是 provider 行為,不可能在本機驗)
//
// SANITY 紀錄(已驗證):把 background.js handleTranslateCustom 的
//   `if (settings.customProvider?.temperature === null) cp.temperature = null;` 註解掉
//   →「文件路徑 override 讓位」case fail(server 收到 temperature: 0.3);
//   把 lib/openai-compat.js 的 `if (temperature !== null)` 拿掉 →「一般翻譯路徑」case 也 fail
//   (收到 0.7)。還原後三條全綠。
import { test, expect } from '../fixtures/extension.js';
import http from 'node:http';

let server;
let port;
let received = [];

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { received.push(JSON.parse(raw)); } catch { received.push({ _parseError: raw }); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '譯文' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

test.afterAll(async () => {
  await new Promise((r) => server.close(r));
});

async function getServiceWorker(context) {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10_000 });
  return sw;
}

// texts 每次都不同 → 不會命中 tc_ 快取(命中的話根本不會發 HTTP 請求)
let seq = 0;
async function translateOnce(page, type, extraPayload = {}) {
  seq += 1;
  received = [];
  const result = await page.evaluate(({ type, texts, extraPayload }) => new Promise((r) => {
    // background dispatch 讀的是 message.payload(見 background.js entry.handler(message.payload, sender))
    chrome.runtime.sendMessage({ type, payload: { ...extraPayload, texts } }, (resp) => r(resp));
  }), { type, texts: [`temperature e2e probe ${seq} — hello world`], extraPayload });
  return result;
}

async function setCustomProvider(context, cpPatch, extraSync = {}) {
  const sw = await getServiceWorker(context);
  await sw.evaluate(async ({ cpPatch, extraSync, port }) => {
    await chrome.storage.sync.set({
      customProvider: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'fake/reasoning-model',
        systemPrompt: 'translate',
        ...cpPatch,
      },
      ...extraSync,
    });
    await chrome.storage.local.set({ customProviderApiKey: 'sk-fake' });
  }, { cpPatch, extraSync, port });
}

test('一般翻譯路徑:customProvider.temperature = null → 送出的 body 不含 temperature', async ({ context, extensionId }) => {
  await setCustomProvider(context, { temperature: null });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#uiLanguage');

  const r = await translateOnce(page, 'TRANSLATE_BATCH_CUSTOM');
  expect(received.length, `假 provider 沒收到請求(可能命中快取或設定沒生效) result=${JSON.stringify(r)}`).toBeGreaterThan(0);
  expect('temperature' in received[0], `body: ${JSON.stringify(received[0])}`).toBe(false);

  await page.close();
});

test('一般翻譯路徑:customProvider.temperature 為數字 → 照送', async ({ context, extensionId }) => {
  await setCustomProvider(context, { temperature: 0.5 });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#uiLanguage');

  await translateOnce(page, 'TRANSLATE_BATCH_CUSTOM');
  expect(received.length).toBeGreaterThan(0);
  expect(received[0].temperature).toBe(0.5);

  await page.close();
});

test('文件翻譯路徑:temperature 留空時 translateDoc.temperature override 讓位(不偷送)', async ({ context, extensionId }) => {
  await setCustomProvider(context, { temperature: null }, {
    // 文件翻譯自己有一組 temperature,沒讓位邏輯時會被塞進 cp overrides
    translateDoc: { temperature: 0.3 },
  });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#uiLanguage');

  await translateOnce(page, 'TRANSLATE_DOC_BATCH_CUSTOM');
  expect(received.length, '假 provider 沒收到請求').toBeGreaterThan(0);
  expect(
    'temperature' in received[0],
    `文件路徑仍送了 temperature(override 沒讓位)body: ${JSON.stringify(received[0])}`,
  ).toBe(false);

  await page.close();
});
