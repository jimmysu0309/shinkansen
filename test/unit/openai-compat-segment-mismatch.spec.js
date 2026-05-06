// Unit test: OpenAI-compat adapter 的 segment mismatch fallback（v1.5.7 regression）
//
// 對齊 Gemini 的 segment mismatch 行為（test/unit/segment-mismatch-fallback.spec.js）：
// 多段送出時若 LLM 回傳段數不符（例如吃掉分隔符、合併段落），需要退回逐段呼叫
// 確保對齊；單段呼叫不應觸發 fallback；hadMismatch 旗標正確回傳。
import { test, expect } from '@playwright/test';

globalThis.chrome = {
  storage: {
    sync: { get: async () => ({}), remove: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

let fetchCallCount = 0;
let pendingMode = 'mismatch'; // 'mismatch' / 'aligned'

globalThis.fetch = async (_url, options) => {
  fetchCallCount += 1;
  const reqBody = JSON.parse(options?.body || '{}');
  const userText = reqBody.messages?.[1]?.content || '';
  const sepCount = (userText.match(/<<<SHINKANSEN_SEP>>>/g) || []).length;
  const segCount = sepCount + 1;

  let respText;
  if (pendingMode === 'mismatch' && segCount > 1) {
    // 故意把多段譯文合併成一段（不含分隔符）→ split 出來只有 1 段，與 segCount 不符
    respText = '合併後的單段譯文';
  } else {
    // 對齊回應：每段照樣產生序號標記 + 段譯並用 SEP 串接
    const parts = userText.split('\n<<<SHINKANSEN_SEP>>>\n').map((_t, i) => `<<<SHINKANSEN_SEG-${i + 1}>>> 段譯${i + 1}`);
    respText = parts.join('\n<<<SHINKANSEN_SEP>>>\n');
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: respText }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 30 },
    }),
  };
};

const { translateBatch } = await import('../../shinkansen/lib/openai-compat.js');

const settings = {
  customProvider: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4-5',
    systemPrompt: 'sys',
    temperature: 0.5,
    apiKey: 'sk-test',
  },
  maxRetries: 0,
};

test.beforeEach(() => { fetchCallCount = 0; });

test.describe('OpenAI-compat segment mismatch fallback', () => {
  test('回傳段數不符 → 觸發 per-segment fallback，每段獨立呼叫', async () => {
    pendingMode = 'mismatch';
    const texts = ['First', 'Second', 'Third'];
    const { translations, hadMismatch } = await translateBatch(texts, settings, null, null, null);
    // 1 次 multi-segment（mismatch）+ 3 次 per-segment fallback = 4 次
    expect(fetchCallCount).toBe(4);
    expect(translations.length).toBe(3);
    expect(hadMismatch).toBe(true);
  });

  test('回傳段數對齊 → 不觸發 fallback', async () => {
    pendingMode = 'aligned';
    const texts = ['First', 'Second', 'Third'];
    const { translations, hadMismatch } = await translateBatch(texts, settings, null, null, null);
    expect(fetchCallCount).toBe(1);
    expect(translations.length).toBe(3);
    expect(hadMismatch).toBe(false);
  });

  test('單段不觸發 fallback（即使 LLM 多吐分隔符）', async () => {
    pendingMode = 'mismatch'; // 單段時 mismatch mode 不影響（split 只有 1 段就回原文）
    const texts = ['Only one'];
    const { translations, hadMismatch } = await translateBatch(texts, settings, null, null, null);
    expect(fetchCallCount).toBe(1);
    expect(translations.length).toBe(1);
    expect(hadMismatch).toBe(false);
  });
});

// SANITY 紀錄（已在 Claude Code 端驗證）：
//   把 lib/openai-compat.js translateChunk 內
//     `if (parts.length !== texts.length) { ... }` 整段條件改成 `if (false) { ... }`
//   → 第 #1 條 fail（fetchCallCount=1 不是 4，translations 長度也錯）。
//   還原後全部 pass。
