// Unit test: 自訂模型 Temperature 留空 → request body 不送 temperature(issue #60)
//
// 為什麼這條 spec 存在:
//   GPT-5 / o 系列等推理模型不吃自訂 temperature(部分端點直接 4xx,官方建議不帶)。
//   舊行為把「留空」強制變 0.7(三處:options save 的 parseUserNum fallback、
//   options load 的顯示 fallback、openai-compat translateChunk 的 body fallback),
//   使用者無法表達「不要送 temperature」。
//
// 新語意(對齊 cachedDiscount 的 null sentinel 前例):
//   - null      = 使用者明確留空 → body 完全不含 temperature 欄位
//   - number    = 照送(0 是合法值,不可被當 falsy)
//   - undefined = 舊資料無此鍵 → 維持 0.7(不改變未動設定者的行為)
//   - extraBodyJson 的 temperature(spread 在後)仍可覆蓋 → 深度控制不受影響
//
// 兩層驗證:
//   1. 行為測試:真 translateBatch + mock fetch 攔 request body(同 openai-compat-usage.spec.js)
//   2. source 斷言:options.js save/load/import 三處(save 綁整頁 DOM,無法行為級載入;
//      同 options-parse-user-num-defaults.test.cjs 前例)
//
// SANITY 紀錄(已驗證,TDD 紅→綠):
//   - 修改前:「null → 不含 temperature」case fail(body.temperature 收到 0.7)、
//     source 斷言三條 fail;修改後全綠。
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

globalThis.chrome = {
  storage: {
    sync: { get: async () => ({}), remove: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

let lastRequestBody = null;
globalThis.fetch = async (_url, options) => {
  lastRequestBody = JSON.parse(options.body);
  return new Response(JSON.stringify({
    choices: [{ message: { content: '翻譯結果' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const { translateBatch } = await import('../../shinkansen/lib/openai-compat.js');

// 測試間重置:未來若新增「不觸發 fetch」的 case,讀到 null 會 fail-loud 而非上一筆殘值
test.beforeEach(() => { lastRequestBody = null; });

function makeSettings(temperature, extra = {}) {
  return {
    customProvider: {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.2',
      systemPrompt: 'system',
      apiKey: 'sk-test',
      temperature,
      ...extra,
    },
    maxRetries: 0,
  };
}

test.describe('openai-compat translateChunk:temperature 三態', () => {
  test('number → body 照送', async () => {
    await translateBatch(['Hello'], makeSettings(0.3), null, null, null);
    expect(lastRequestBody.temperature).toBe(0.3);
  });

  test('0 → body 送 0(合法值,不可被當 falsy 吃掉)', async () => {
    await translateBatch(['Hello'], makeSettings(0), null, null, null);
    expect(lastRequestBody.temperature).toBe(0);
  });

  test('null(明確留空)→ body 完全不含 temperature 欄位', async () => {
    await translateBatch(['Hello'], makeSettings(null), null, null, null);
    expect('temperature' in lastRequestBody).toBe(false);
  });

  test('undefined(舊資料無此鍵)→ 維持 0.7 不改變行為', async () => {
    await translateBatch(['Hello'], makeSettings(undefined), null, null, null);
    expect(lastRequestBody.temperature).toBe(0.7);
  });

  test('null + extraBodyJson 指定 temperature → extraBodyJson 覆蓋仍有效', async () => {
    // extraBodyJson deep merge spread 在內建欄位之後(openai-compat-thinking.js 設計:
    // 可覆蓋自動 mapping)。留空 + extraBodyJson 手動指定 = 進階使用者的深度控制,必須保留。
    await translateBatch(
      ['Hello'],
      makeSettings(null, { extraBodyJson: '{"temperature":0.2}' }),
      null, null, null,
    );
    expect(lastRequestBody.temperature).toBe(0.2);
  });
});

// ─── source 斷言:options.js 三處(save 綁整頁 DOM,鎖結構性事實)──────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPTIONS_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../shinkansen/options/options.js'), 'utf-8',
);

test.describe('options.js:temperature 空白 = null sentinel', () => {
  test('save:cp-temperature 空白存 null,不再 parseUserNum fallback 0.7', () => {
    // 舊寫法(空白被吃成 0.7)必須消失
    expect(OPTIONS_SRC).not.toMatch(
      /temperature: parseUserNum\(\$\('cp-temperature'\)\.value/,
    );
    // 新寫法:空字串 → null(比照 cachedDiscount 的 IIFE sentinel)
    expect(OPTIONS_SRC).toMatch(
      /\$\('cp-temperature'\)\.value[\s\S]{0,120}?if \(raw === ''\) return null;/,
    );
  });

  test('load:非 number(null)→ 顯示空白,不再填 0.7', () => {
    expect(OPTIONS_SRC).toMatch(
      /\$\('cp-temperature'\)\.value = \(typeof cp\.temperature === 'number'\) \? cp\.temperature : '';/,
    );
  });

  test('import:temperature === null 被接受(留空設定可 round-trip)', () => {
    expect(OPTIONS_SRC).toMatch(/if \(cp\.temperature === null\) cpClean\.temperature = null;/);
  });
});
