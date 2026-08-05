// Unit test: 批次 8 E4 + E5（code review 2026-08-03）,gemini 與 openai-compat 雙引擎。
//
// E4:非 JSON 回應的診斷 preview。
//   舊寫法 `resp.json()` 失敗後 body 已 disturbed,`resp.clone().text()` 依 fetch spec
//   必 throw → 被 catch 吞 → rawPreview 恆空,codedError 的 preview 恆 'N/A'——v0.84 加的
//   診斷功能實質 dead code(CDN 回 HTML 錯誤頁時 log 與 UI 都看不到前 200 字線索)。
//   修法:先 `resp.text()` 再 `JSON.parse`,rawBody 天然可讀。
//
// E5:單段 chunk 段數不符時外洩 SEP 字面。
//   texts.length === 1 且 LLM 輸出含 SEP 字面時,舊寫法直接回傳 `text.trim()`——
//   `<<<SHINKANSEN_SEP>>>` 協定 token 會注入 DOM 並寫進快取(逐段 fallback 取
//   r.parts[0] 正是走這條)。修法:回傳 split SEP 後的非空段以換行 join。
//
// 驗的訊號層次:
//   - 驗:lib 層 translateBatch 對 mock fetch 回應的錯誤欄位 / 回傳內容
//   - 不驗:background 對 codedError 的 i18n 組裝(bg-error-i18n.test.cjs)、
//     content 端注入與快取寫入(上游拿到乾淨 parts 後行為不變)
//
// SANITY 紀錄(已驗證,2026-08-05):
//   E4:把 gemini.js 改回 `json = await resp.json()` + `resp.clone().text()` 舊寫法 →
//     「preview 帶 raw body」case fail(preview 收到 'N/A')→ 還原後 pass。
//   E5:把 gemini.js 單段分支改回 `return { parts: [text.trim()], usage: chunkUsage }` →
//     「單段 SEP strip」case fail(譯文含 SHINKANSEN_SEP)→ 還原後 pass。
//   openai-compat 兩處為同形修法,由同組 case 各自獨立覆蓋。
import { test, expect } from '@playwright/test';

globalThis.chrome = {
  storage: {
    sync: { get: async () => ({}), remove: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

let fetchResponses = [];
globalThis.fetch = async () => {
  const r = fetchResponses.shift();
  if (!r) throw new Error('No more mock responses');
  return r;
};

function htmlResponse(status, html) {
  return new Response(html, { status, headers: { 'content-type': 'text/html' } });
}
function geminiOkResponse(text) {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}
function openaiOkResponse(text) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const gemini = await import('../../shinkansen/lib/gemini.js');
const openai = await import('../../shinkansen/lib/openai-compat.js');

const geminiSettings = {
  apiKey: 'test-key',
  geminiConfig: {
    model: 'gemini-3-flash',
    serviceTier: 'DEFAULT',
    temperature: 1.0,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
    systemInstruction: '翻譯指令',
  },
  maxRetries: 0,
};
const openaiSettings = {
  customProvider: {
    baseUrl: 'https://api.example.com/v1',
    model: 'some-model',
    systemPrompt: 'system',
    apiKey: 'sk-test',
  },
  maxRetries: 0,
};

const SEP_LITERAL = '<<<SHINKANSEN_SEP>>>';

test.beforeEach(() => { fetchResponses = []; });

test.describe('E4:非 JSON 回應的診斷 preview 帶 raw body', () => {
  test('gemini:CDN 回 HTML 錯誤頁 → badResponse 的 preview / message 含前 200 字', async () => {
    fetchResponses.push(htmlResponse(200, '<html><body>Bad Gateway from CDN</body></html>'));
    const err = await gemini.translateBatch(['Hello'], geminiSettings).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.skCode).toBe('badResponse');
    expect(err.skParams?.preview).toContain('<html><body>Bad Gateway from CDN');
    expect(err.message).toContain('Bad Gateway from CDN');
  });

  test('openai-compat:同型防護,customBadResponse 的 preview 含 raw body', async () => {
    fetchResponses.push(htmlResponse(200, '<html>Service Unavailable</html>'));
    const err = await openai.translateBatch(['Hello'], openaiSettings).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.skCode).toBe('customBadResponse');
    expect(err.skParams?.preview).toContain('<html>Service Unavailable');
  });
});

test.describe('E5:單段 chunk 輸出含 SEP 字面 → strip 後回傳', () => {
  test('gemini:單段譯文含 SEP → 協定 token 不外洩,兩段內容以換行保留', async () => {
    fetchResponses.push(geminiOkResponse(`第一句\n${SEP_LITERAL}\n第二句`));
    const r = await gemini.translateBatch(['Hello world'], geminiSettings);
    expect(r.translations[0]).not.toContain('SHINKANSEN_SEP');
    expect(r.translations[0]).toContain('第一句');
    expect(r.translations[0]).toContain('第二句');
  });

  test('openai-compat:同型防護', async () => {
    fetchResponses.push(openaiOkResponse(`第一句\n${SEP_LITERAL}\n第二句`));
    const r = await openai.translateBatch(['Hello world'], openaiSettings);
    expect(r.translations[0]).not.toContain('SHINKANSEN_SEP');
    expect(r.translations[0]).toContain('第一句');
    expect(r.translations[0]).toContain('第二句');
  });

  test('對照組:單段乾淨譯文(無 SEP)行為不變', async () => {
    fetchResponses.push(geminiOkResponse('乾淨譯文'));
    const r = await gemini.translateBatch(['Hello'], geminiSettings);
    expect(r.translations[0]).toBe('乾淨譯文');
  });
});
