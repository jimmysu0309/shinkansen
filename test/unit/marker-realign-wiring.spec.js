// Integration test(stub fetch): realignByMarkers 在 translateBatch(非串流)與
// translateBatchStream(串流)兩條真實解析路徑上的 wiring(v2.0.69)。
//
// 純函式行為見 marker-realign.spec.js;本檔驗的是「模型回應吃掉 SEP 但 «N» 都在」時:
//   1. 非串流:translateBatch 回傳對齊的 N 段、fetch 只打 1 次(沒觸發逐段 fallback
//      ——fallback 會對每段各打一次 API,fetch 次數 = 1 + N)
//   2. 串流:流結束後 realign 成功 → hadMismatch=false(呼叫端不整批重翻)、
//      對錯位段補發修正版 onSegment、對內容相同的段不重發(避免 A3 零 mutation 誤判)
//
// 訊號層次註記:本檔驗 lib 層 parse+wiring(用 stub fetch),不驗 background ↔ content
// 訊息傳遞與 DOM 注入;後者由既有 streaming / inject 類 spec 與實機驗證涵蓋。
//
// SANITY 紀錄(已驗證):把 realignByMarkers 開頭改成 `return null` → 非串流 case
// fetch 次數 1→4(逐段 fallback)+ 串流 case hadMismatch 變 true → 兩 case 都 fail
// → 還原 → 全綠。
import { test, expect } from '@playwright/test';
import { DELIMITER } from '../../shinkansen/lib/system-instruction.js';
import { translateBatch, translateBatchStream } from '../../shinkansen/lib/gemini.js';

const SETTINGS = {
  apiKey: 'test-key',
  targetLanguage: 'zh-TW',
  maxUnitsPerBatch: 40,
  maxCharsPerBatch: 3500,
  geminiConfig: {
    model: 'gemini-3.5-flash-lite',
    serviceTier: 'DEFAULT',
    temperature: 1.0,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
    systemInstruction: '把輸入翻成繁體中文。',
  },
};

const TEXTS = ['First paragraph.', 'Second paragraph.', 'Third paragraph.'];
// 模擬 gemini-3.5-flash-lite 實測行為:seg2/seg3 之間的 SEP 被吃掉,«3» 還在
const MERGED_OUTPUT = `«1» 譯文一${DELIMITER}«2» 譯文二 «3» 譯文三`;

function geminiJson(text) {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
  };
}

test('非串流:合併段落回應 → realign 對齊 3 段,fetch 只打 1 次(不逐段 fallback)', async () => {
  const origFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify(geminiJson(MERGED_OUTPUT)), { status: 200 });
  };
  try {
    const r = await translateBatch(TEXTS, SETTINGS, null, null, null);
    expect(r.translations).toEqual(['譯文一', '譯文二', '譯文三']);
    expect(r.hadMismatch).toBe(false);
    expect(fetchCalls).toBe(1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('串流:流結束 realign → hadMismatch=false + 只補發錯位段(不重發相同內容段)', async () => {
  const origFetch = globalThis.fetch;
  // SSE 兩個 event:第一個含 seg1 完整 + seg2/3 合併段的前半,第二個補完
  const ev1 = geminiJson(`«1» 譯文一${DELIMITER}«2» 譯文二 «3» `);
  const ev2 = geminiJson('譯文三');
  const sse = `data: ${JSON.stringify(ev1)}\n\ndata: ${JSON.stringify(ev2)}\n\n`;
  globalThis.fetch = async () => new Response(sse, { status: 200 });
  const emitted = [];
  try {
    const r = await translateBatchStream(TEXTS, SETTINGS, null, null, null, {
      onSegment: (idx, tr) => emitted.push([idx, tr]),
    });
    expect(r.hadMismatch).toBe(false);
    expect(r.translations).toEqual(['譯文一', '譯文二', '譯文三']);
    // 串流中 emit:idx0(SEP 前的完整段)。流結束 flush:idx1 = 合併髒段。
    // realign 補發:idx1 修正版 + idx2(沒 emit 過);idx0 內容相同 → 不重發
    const idx0Emits = emitted.filter(([i]) => i === 0);
    expect(idx0Emits).toHaveLength(1);
    // 每個 idx 的「最後一次 emit」必須是對齊後的正確譯文
    const lastByIdx = new Map(emitted);
    expect(lastByIdx.get(0)).toBe('譯文一');
    expect(lastByIdx.get(1)).toBe('譯文二');
    expect(lastByIdx.get(2)).toBe('譯文三');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('非串流:marker 也救不回(序號缺失)→ 仍走逐段 fallback(行為不回退)', async () => {
  const origFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async (url, opts) => {
    fetchCalls += 1;
    const reqText = JSON.parse(opts.body).contents[0].parts[0].text;
    // 第一次(多段):回「SEP 掉了、«2» 也掉了」的壞回應;逐段 fallback(單段)回正常譯文
    const isMulti = reqText.includes('<<<SHINKANSEN_SEP>>>');
    const out = isMulti ? '«1» 譯文一 譯文二 «3» 譯文三' : '單段譯文';
    return new Response(JSON.stringify(geminiJson(out)), { status: 200 });
  };
  try {
    const r = await translateBatch(TEXTS, SETTINGS, null, null, null);
    expect(r.hadMismatch).toBe(true);
    expect(fetchCalls).toBe(1 + TEXTS.length); // 整批 1 次 + 逐段 3 次
    expect(r.translations).toEqual(['單段譯文', '單段譯文', '單段譯文']);
  } finally {
    globalThis.fetch = origFetch;
  }
});
