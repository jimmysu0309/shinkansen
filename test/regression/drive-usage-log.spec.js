// Regression: drive-usage-log(code review 2026-08-03 批次 2 C2——Drive 字幕翻譯
// 成功路徑完全不記 LOG_USAGE,usage-db 系統性漏帳)
//
// Bug:YouTube 路徑每批由 content 端發 LOG_USAGE(content-youtube.js _logWindowUsage),
// content-drive.js 的 _runOneBatchLlm 拿到 res.usage 後只丟進 sendLog，從不發
// LOG_USAGE——Drive 影片整支翻譯(數百段 × Gemini token)在用量儀表板 /
// GET_USAGE_STATS 對帳完全隱形。
//
// 修法：_runOneBatchLlm 成功路徑(res.ok 之後、parseAsrResponse 之前——API 已回應
// 即已付費，parse 失敗丟棄結果錢也花了)發 LOG_USAGE,source='drive-subtitle'、
// videoId=Drive 檔案 id，走 background upsert 合併路徑(一支影片多批合成一筆)。
// Google 路徑不發(免費，chars 記帳由 background handleTranslateGoogle 落地，發了反而重複)。
//
// 驅動方式：同 drive-captions-pipeline-guards.spec.js——SK._driveHandleCaptionsMessage
// seam + mock chrome.runtime.sendMessage，捕捉 LOG_USAGE 訊息斷言 payload。
//
// 訊號層界定：本 spec 驗「content 端有發 LOG_USAGE + payload 欄位正確」，不驗
// background LOG_USAGE handler 的 upsert 路由與 usage-db 合併寫入(該層由
// test/unit/usage-drive-subtitle-routing.spec.js 以 source 斷言鎖)。
//
// SANITY 紀錄(已驗證，2026-08-04)：暫時把 _runOneBatchLlm 內
// `_logDriveUsage(batch.length, res.usage, engineLabel)` 呼叫註解掉 →
// case 1 fail(logUsageMsgs 空)、case 2 fail → 還原 → 全 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'drive-bilingual-overlay';

const JSON3_TWO_SEGS = JSON.stringify({
  events: [
    { tStartMs: 0,    segs: [{ utf8: 'hello' }] },
    { tStartMs: 3000, segs: [{ utf8: 'world' }] },
  ],
});

const USAGE = {
  inputTokens: 120, outputTokens: 60, cachedTokens: 10,
  billedInputTokens: 111, billedCostUSD: 0.0012, cacheHits: 0,
};

async function setupPage(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);
  return { page, evaluate };
}

// mock:TRANSLATE_DRIVE_* 回 canned 結果；LOG_USAGE 收進 window.__logUsageMsgs
function installMock(evaluate, { result, usage }) {
  return evaluate(`
    window.__logUsageMsgs = [];
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'LOG_USAGE') { window.__logUsageMsgs.push(msg.payload); return { ok: true }; }
      if (!msg || !String(msg.type).startsWith('TRANSLATE_DRIVE_')) return { ok: true };
      return { ok: true, result: ${JSON.stringify(result)}, usage: ${JSON.stringify(usage)} };
    };
  `);
}

test.describe('drive-usage-log', () => {
  test('case 1: LLM 成功批次 → 發 LOG_USAGE(source=drive-subtitle,tokens 對應 res.usage)', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);
    await installMock(evaluate, {
      result: [JSON.stringify([{ s: 0, e: 3000, t: '譯文一' }, { s: 3000, e: 4500, t: '譯文二' }])],
      usage: USAGE,
    });

    await evaluate(`window.__SK._driveHandleCaptionsMessage({ payload: { json3: ${JSON.stringify(JSON3_TWO_SEGS)} } })`);

    const msgs = await evaluate(`window.__logUsageMsgs`);
    expect(msgs.length, '成功批次應發出 1 筆 LOG_USAGE').toBe(1);
    const p = msgs[0];
    expect(p.source).toBe('drive-subtitle');
    expect(p.engine).toBe('gemini');
    expect(p.inputTokens).toBe(120);
    expect(p.outputTokens).toBe(60);
    expect(p.cachedTokens).toBe(10);
    expect(p.billedInputTokens).toBe(111);
    expect(p.billedCostUSD).toBe(0.0012);
    expect(p.segments, 'segments = 本批原始片段數').toBe(2);
    await page.close();
  });

  test('case 2: parseAsrResponse 失敗仍發 LOG_USAGE(API 已回應即已付費)', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);
    await installMock(evaluate, { result: ['not-a-json-asr-payload'], usage: USAGE });

    await evaluate(`window.__SK._driveHandleCaptionsMessage({ payload: { json3: ${JSON.stringify(JSON3_TWO_SEGS)} } })`);

    const r = await evaluate(`({ msgs: window.__logUsageMsgs.length, entries: window.__SK.DRIVE.entries.length })`);
    expect(r.entries, 'parse 失敗不 push entries').toBe(0);
    expect(r.msgs, 'parse 失敗前已付費，仍須記帳').toBe(1);
    await page.close();
  });

  test('case 3: usage 全 0(如整批本地 cache 命中且無 cacheHits 欄位)→ 不發(比照 YT guard)', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);
    await installMock(evaluate, {
      result: [JSON.stringify([{ s: 0, e: 3000, t: '譯文一' }])],
      usage: {},
    });

    await evaluate(`window.__SK._driveHandleCaptionsMessage({ payload: { json3: ${JSON.stringify(JSON3_TWO_SEGS)} } })`);

    const msgs = await evaluate(`window.__logUsageMsgs`);
    expect(msgs.length, '無付費也無 cacheHits 的批次不記(避免零值紀錄噪音)').toBe(0);
    await page.close();
  });

  test('case 4: google engine → content 端不發 LOG_USAGE(免費，background 端已記 chars)', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);
    await evaluate(`window.__SK._driveSetEngine('google')`);
    await installMock(evaluate, { result: ['譯一', '譯二'], usage: { engine: 'google', chars: 10 } });

    await evaluate(`window.__SK._driveHandleCaptionsMessage({ payload: { json3: ${JSON.stringify(JSON3_TWO_SEGS)} } })`);

    const r = await evaluate(`({ msgs: window.__logUsageMsgs.length, entries: window.__SK.DRIVE.entries.length })`);
    expect(r.entries, 'google 路徑照常 push entries').toBe(2);
    expect(r.msgs, 'google 路徑不得發 LOG_USAGE(background 已記，重發 = 重複帳)').toBe(0);
    await page.close();
  });
});
