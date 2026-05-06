// Unit test: lib/gemini.js translateBatchStream(v1.8.0 streaming 路徑)
//
// 驗證三件事:
//   (1) Incremental parser:每收到完整 DELIMITER(SHINKANSEN_SEP)就 emit 該段譯文,
//       不會等整批結束才 emit
//   (2) Placeholder split:占位符 ⟦/0⟧ / ⟦*0⟧ 切在 SSE chunk 邊界時,parser 仍能完整解出
//   (3) onFirstChunk callback:第一個 SSE chunk 抵達就觸發
//
// Mock 策略:替換 globalThis.fetch 回一個假 Response,response.body 是手刻的
// ReadableStream,逐個 chunk push SSE event。可控制 chunk 邊界位置驗證 incremental
// parser 在「完整 SSE event 切到中間」「占位符切到中間」場景下的行為。
import { test, expect } from '@playwright/test';

// Mock chrome.storage(logger.js 內 persistLog 會讀 local;getSettings 會讀 sync)
// MERGE mode:不覆蓋已存在的 globalThis.chrome,避免 isolation 影響其他 spec(workers=1
// 跨 spec module-level state 共享)。例如 update-check.spec.js 也設 globalThis.chrome,
// 只 fill 缺的 property 不替換整個物件。
// 不設 globalThis.browser:compat.js 的 Proxy 會 fallback 到 globalThis.chrome,
// 設 browser 反而會把 reference 鎖在 streaming 載入時的 chrome,後續 spec 重設
// globalThis.chrome 時 browser 仍指向舊物件 → mock 失效。
if (!globalThis.chrome) globalThis.chrome = {};
if (!globalThis.chrome.storage) globalThis.chrome.storage = {};
if (!globalThis.chrome.storage.sync) globalThis.chrome.storage.sync = { get: async () => ({}), remove: async () => {} };
if (!globalThis.chrome.storage.local) globalThis.chrome.storage.local = { get: async () => ({}), set: async () => {}, remove: async () => {} };
if (!globalThis.chrome.runtime) globalThis.chrome.runtime = { getManifest: () => ({ version: 'test' }) };

const ENC = new TextEncoder();
const SEP = '\n<<<SHINKANSEN_SEP>>>\n';

// 構造一個假 SSE Response。chunks: string[] 指定每個 SSE event 串(每段以 \r\n\r\n 結尾)。
// 如果要測「event 切在 chunk 中間」,可以把單個 SSE event 拆成多個 chunks。
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

// 構造 SSE event 字串:`data: <json>\r\n\r\n`
function sseEvent(obj) {
  return `data: ${JSON.stringify(obj)}\r\n\r\n`;
}

// 模擬 Gemini SSE response 的單一 chunk:candidates[0].content.parts[0].text = partText
function chunkData(partText, finishReason = undefined, usageMetadata = undefined) {
  const c = { candidates: [{ content: { parts: [{ text: partText }], role: 'model' }, index: 0 }] };
  if (finishReason) c.candidates[0].finishReason = finishReason;
  if (usageMetadata) c.usageMetadata = usageMetadata;
  return c;
}

const settings = {
  apiKey: 'TEST_KEY',
  geminiConfig: {
    model: 'gemini-3-flash-preview',
    serviceTier: 'DEFAULT',
    temperature: 1.0,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
    systemInstruction: 'Translate to Chinese.',
  },
};

const { translateBatchStream } = await import('../../shinkansen/lib/gemini.js');

// 記錄 module load 時的 fetch,test 完還原 — 避免影響後續 spec(workers=1 共享 globalThis)。
// update-check.spec.js 也設 globalThis.fetch,如果 streaming 跑完留下髒的 fetch mock,
// 會讓 update-check 「latest minor 升」test 失敗(fetch 不是 update-check 預期的 makeOkResp)。
const origFetchAtLoad = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = origFetchAtLoad;
});

test('translateBatchStream: 每段 segment 收齊後立即 emit(incremental)', async () => {
  // 3 段譯文,每段一個 SSE event,中間有 SEP
  globalThis.fetch = async () => makeStreamResponse([
    sseEvent(chunkData('<<<SHINKANSEN_SEG-1>>> 段一譯文')),
    sseEvent(chunkData(SEP)),
    sseEvent(chunkData('<<<SHINKANSEN_SEG-2>>> 段二譯文')),
    sseEvent(chunkData(SEP)),
    sseEvent(chunkData('<<<SHINKANSEN_SEG-3>>> 段三譯文', 'STOP', { promptTokenCount: 10, candidatesTokenCount: 6, totalTokenCount: 16 })),
  ]);

  const segments = [];
  let firstChunkFired = 0;
  const result = await translateBatchStream(
    ['Original 1', 'Original 2', 'Original 3'],
    settings,
    null, null, null,
    {
      onFirstChunk: () => { firstChunkFired++; },
      onSegment: (idx, text) => { segments.push({ idx, text }); },
    },
  );

  // 驗 incremental:3 段都該透過 onSegment 收到
  expect(segments.length).toBe(3);
  expect(segments[0]).toEqual({ idx: 0, text: '段一譯文' });
  expect(segments[1]).toEqual({ idx: 1, text: '段二譯文' });
  expect(segments[2]).toEqual({ idx: 2, text: '段三譯文' });

  // 驗 onFirstChunk 只觸發一次(第一個 SSE chunk 抵達時)
  expect(firstChunkFired).toBe(1);

  // 驗整批結果
  expect(result.translations).toEqual(['段一譯文', '段二譯文', '段三譯文']);
  expect(result.hadMismatch).toBe(false);
  expect(result.usage.inputTokens).toBe(10);
  expect(result.usage.outputTokens).toBe(6);
});

test('translateBatchStream: SSE event 切在 chunk 中間,parser 仍能完整解出', async () => {
  // 把單一 SSE event 切成 3 個 chunks(模擬 TCP fragment)
  const fullEvent = sseEvent(chunkData('<<<SHINKANSEN_SEG-1>>> 完整段', 'STOP', { promptTokenCount: 5, candidatesTokenCount: 4 }));
  const splitChunks = [
    fullEvent.slice(0, 30),
    fullEvent.slice(30, 60),
    fullEvent.slice(60),
  ];
  globalThis.fetch = async () => makeStreamResponse(splitChunks);

  const segments = [];
  const result = await translateBatchStream(
    ['Single original'],
    settings,
    null, null, null,
    { onSegment: (idx, text) => segments.push({ idx, text }) },
  );

  // 單段 batch:不會 emit 中間 segment(因為沒有 SEP 切),但 stream 結束會 emit 最後一段
  expect(segments.length).toBe(1);
  expect(segments[0]).toEqual({ idx: 0, text: '完整段' });
  expect(result.translations).toEqual(['完整段']);
});

test('translateBatchStream: 占位符 ⟦/0⟧ 切在 SSE chunk 中間,parser 仍能完整解出', async () => {
  // 模擬:譯文「⟦0⟧第一段⟦/0⟧」被切成 ⟦0⟧第一段⟦/ + 0⟧ 兩個 chunk
  const event1 = sseEvent(chunkData('<<<SHINKANSEN_SEG-1>>> ⟦0⟧第一段⟦/'));
  const event2 = sseEvent(chunkData('0⟧'));
  const event3 = sseEvent(chunkData(SEP));
  const event4 = sseEvent(chunkData('<<<SHINKANSEN_SEG-2>>> ⟦0⟧第二段⟦/0⟧', 'STOP', { promptTokenCount: 8, candidatesTokenCount: 5 }));

  globalThis.fetch = async () => makeStreamResponse([event1, event2, event3, event4]);

  const segments = [];
  const result = await translateBatchStream(
    ['First', 'Second'],
    settings,
    null, null, null,
    { onSegment: (idx, text) => segments.push({ idx, text }) },
  );

  expect(segments.length).toBe(2);
  // 第一段被切到占位符中間,但因為 emit 是「看到完整 SEP 才 emit」,
  // 所以等 chunk 4 的 SEP 出現後 segments[0] 才被 emit,內容應完整含 ⟦/0⟧
  expect(segments[0].text).toBe('⟦0⟧第一段⟦/0⟧');
  expect(segments[1].text).toBe('⟦0⟧第二段⟦/0⟧');
  expect(result.translations).toEqual(['⟦0⟧第一段⟦/0⟧', '⟦0⟧第二段⟦/0⟧']);
});

test('translateBatchStream: hadMismatch 在段數不對時回 true', async () => {
  // 預期 3 段,但 LLM 只回 2 段(SEP 數量不對)
  globalThis.fetch = async () => makeStreamResponse([
    sseEvent(chunkData('<<<SHINKANSEN_SEG-1>>> 一')),
    sseEvent(chunkData(SEP)),
    sseEvent(chunkData('<<<SHINKANSEN_SEG-2>>> 二', 'STOP', { promptTokenCount: 5, candidatesTokenCount: 3 })),
  ]);

  const segments = [];
  const result = await translateBatchStream(
    ['Original 1', 'Original 2', 'Original 3'],
    settings,
    null, null, null,
    { onSegment: (idx, text) => segments.push({ idx, text }) },
  );

  expect(result.hadMismatch).toBe(true);
  expect(result.translations.length).toBe(2);  // 只收到 2 段
});

test('translateBatchStream: AbortSignal 抵達後,read 拋 AbortError → 函式 throw "streaming aborted"', async () => {
  // 模擬 fetch 對 signal.aborted 真實行為:reader.read() 拋 AbortError
  globalThis.fetch = async (_url, opts) => {
    const stream = new ReadableStream({
      start(controller) {
        if (opts?.signal) {
          if (opts.signal.aborted) {
            const e = new Error('aborted');
            e.name = 'AbortError';
            controller.error(e);
            return;
          }
          opts.signal.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            controller.error(e);
          }, { once: true });
        }
        // 持續發 chunk(永不 close)
        controller.enqueue(ENC.encode(sseEvent(chunkData('<<<SHINKANSEN_SEG-1>>> 段'))));
      },
    });
    return { ok: true, status: 200, body: stream };
  };

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);

  let err = null;
  try {
    await translateBatchStream(['One'], settings, null, null, null, {}, ac.signal);
  } catch (e) { err = e; }
  expect(err, 'abort 後應 throw').not.toBeNull();
  expect(/aborted/i.test(err.message), `error message: ${err?.message}`).toBe(true);
});
