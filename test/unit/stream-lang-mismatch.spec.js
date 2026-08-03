// Regression: stream-lang-mismatch（對應 v2.0.77 修的「streaming 路徑缺整批輸出
// 語言錯偵測,錯語言譯文永久寫進快取」bug——CODE-REVIEW-2026-08-03 E1）
//
// Bug 全貌：v2.0.52 在 non-streaming 兩引擎(gemini.js translateChunk /
// openai-compat.js)都加了 detectOutputLangMismatch → 逐段 fallback,但
// translateBatchStream 完全沒有這層。batch 0(streaming)遇到「模型把整批翻成
// 原文語言」(v2.0.52 實證高度 sticky 的病型)時直接注入,且 background
// handleTranslateStream 寫快取只過 isSuspectEchoTranslation(擋不住非 echo 的
// 錯語言譯文)→ 壞譯文進 tc_ 永久污染——v2.0.65 / v2.0.75 兩次 migration
// 清的同類污染的產生源。
// 修法：translateBatchStream 收尾(realign 之後)補 detectOutputLangMismatch,
// 命中掛進既有 hadMismatch 通道——background 對 hadMismatch 既有行為:不寫快取
//(v1.10.46)+ discard 記帳;content 端 reject 後走 non-streaming 重翻(該路徑
// 有逐段 fallback 可打破 sticky)。
//
// 訊號層：驗 translateBatchStream 回傳 hadMismatch 旗標;不驗 background 的
// 不寫快取 / discard 記帳(既有 v1.10.46 行為,cache-key-stream-mismatch.test.cjs
// 層覆蓋)與 content 端 reject 重翻時序。
//
// Mock 策略同 streaming-batch-incremental.spec.js:替換 globalThis.fetch 回假
// SSE ReadableStream。
//
// SANITY 紀錄（已驗證 2026-08-03）：gemini.js translateBatchStream 的
// `if (!hadMismatch && texts.length > 1 && detectOutputLangMismatch(...))` 改
// `if (false)` → 「日文改寫輸出應標 hadMismatch」斷言 fail(false ≠ true)
// → 還原後 pass;對照組(正常中文輸出 hadMismatch=false)不受破壞影響恆綠。
import { test, expect } from '@playwright/test';

// Mock chrome.storage(MERGE mode,同 streaming-batch-incremental.spec.js:
// workers=1 跨 spec module-level state 共享,不覆蓋既有 globalThis.chrome)
if (!globalThis.chrome) globalThis.chrome = {};
if (!globalThis.chrome.storage) globalThis.chrome.storage = {};
if (!globalThis.chrome.storage.sync) globalThis.chrome.storage.sync = { get: async () => ({}), remove: async () => {} };
if (!globalThis.chrome.storage.local) globalThis.chrome.storage.local = { get: async () => ({}), set: async () => {}, remove: async () => {} };
if (!globalThis.chrome.runtime) globalThis.chrome.runtime = { getManifest: () => ({ version: 'test' }) };

const ENC = new TextEncoder();
const SEP = '\n<<<SHINKANSEN_SEP>>>\n';

function makeStreamResponse(chunks) {
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(ENC.encode(chunks[i]));
      i++;
    },
  });
  return {
    ok: true,
    status: 200,
    body: stream,
    text: async () => chunks.join(''),
  };
}

function sseEvent(obj) {
  return `data: ${JSON.stringify(obj)}\r\n\r\n`;
}

function chunkData(partText, finishReason = undefined, usageMetadata = undefined) {
  const c = { candidates: [{ content: { parts: [{ text: partText }], role: 'model' }, index: 0 }] };
  if (finishReason) c.candidates[0].finishReason = finishReason;
  if (usageMetadata) c.usageMetadata = usageMetadata;
  return c;
}

const settings = {
  apiKey: 'TEST_KEY',
  targetLanguage: 'zh-TW',
  geminiConfig: {
    model: 'gemini-3-flash-preview',
    serviceTier: 'DEFAULT',
    temperature: 1.0,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
    systemInstruction: '翻譯成台灣繁體中文。',
  },
};

// 三段日文原文(同 chunk-lang-fallback.spec.js 的 non-streaming 重現素材)
const JA_TEXTS = [
  '「秘書役ならときどきやってるわ」抑揚のないくすんだ声が答えた。その一言で早紀子がわたしの言葉をどう受け止めていたか明らかになった。',
  '空が一層暗くなってきた。どうやら、この解け残りがそのまま根雪になってしまうようだ。',
  '「仕事を休ませて悪かった」時計を見て言った。去るべき時間がきたことを告げるためだ。',
];
// 模型「日文改寫」輸出(段數對齊、語言錯——重現 persisted log 的失敗形態)
const JA_REWRITE = [
  '「秘書みたいなことなら、たまにやってるわ」抑揚のない、くすんだ声でそう返された。その一言で、早紀子がどう受け止めていたのかが明らかになった。',
  '空がいっそう暗くなってきた。どうやらこの解け残りがそのまま根雪になってしまうらしい。',
  '「仕事の邪魔をして悪かったな」時計を見て言った。去るべき時間が来たことを伝えるためだ。',
];
const ZH_OK = [
  '「秘書之類的工作,我偶爾會做喔。」她用毫無起伏的暗啞嗓音回答。',
  '天空變得更加陰暗了。看來這些殘雪會直接積成根雪。',
  '「抱歉害你請假了。」我看著錶說道,為的是告訴她該離開了。',
];

const { translateBatchStream } = await import('../../shinkansen/lib/gemini.js');

const origFetchAtLoad = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = origFetchAtLoad;
});

const USAGE = { promptTokenCount: 100, candidatesTokenCount: 80, totalTokenCount: 180 };

function fetchReturning(parts) {
  return async () => makeStreamResponse([
    sseEvent(chunkData(parts[0])),
    sseEvent(chunkData(SEP)),
    sseEvent(chunkData(parts[1])),
    sseEvent(chunkData(SEP)),
    sseEvent(chunkData(parts[2], 'STOP', USAGE)),
  ]);
}

test('translateBatchStream: 段數對齊但整批輸出日文(target zh-TW)應標 hadMismatch', async () => {
  globalThis.fetch = fetchReturning(JA_REWRITE);

  const result = await translateBatchStream(JA_TEXTS, settings, null, null, null, {});
  expect(result.translations.length, '段數仍對齊').toBe(3);
  expect(result.hadMismatch, '日文改寫輸出應標 hadMismatch(觸發呼叫端重翻,background 不寫快取)').toBe(true);
});

test('translateBatchStream: 正常中文輸出 hadMismatch=false(對照組)', async () => {
  globalThis.fetch = fetchReturning(ZH_OK);

  const result = await translateBatchStream(JA_TEXTS, settings, null, null, null, {});
  expect(result.translations.length).toBe(3);
  expect(result.hadMismatch, '正常譯文不可誤標').toBe(false);
});
