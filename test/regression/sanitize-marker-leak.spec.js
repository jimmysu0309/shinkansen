// Regression: v1.8.10 A — SK.sanitizeMarkers strip LLM 偷懶殘留的多段協定標記
//
// 背景:lib/system-instruction.js 把多段譯文用 <<<SHINKANSEN_SEP>>> 分隔 + 每段加 <<<SHINKANSEN_SEG-N>>> 序號。
// 正常情況下 lib/gemini.js parser 在 split 時會清掉這些標記。但 LLM 偷懶把 N 段合併成 1 段
// (translations.length=1 ≠ texts.length=N → hadMismatch=true)時,合併版字串會帶完整的
// SEP / SEG-N 進到 translations[0],一路寫進 captionMap / DOM。
//
// A 路徑(本 spec):defensive sanitize at write time——content-ns.js 加 SK.sanitizeMarkers,
// 字幕 _injectBatchResult / 文章 runBatch & STREAMING_SEGMENT inject 時呼叫,strip 殘留標記。
// B 路徑(streaming-batch-0-mismatch-retry.spec.js):hadMismatch=true → retry,根本不走合併版。
// 兩條是分層防禦——A 是 B 失敗時最後一道防線。
//
// SANITY CHECK 紀錄(已驗證,2026-04-29):
//   把 SK.sanitizeMarkers 改成 identity(`return text`)→ test #2 captionMap 含 SHINKANSEN_SEP fail。
//   還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-streaming-inject';

test('sanitize-marker-leak (case 1): SK.sanitizeMarkers 直接呼叫 strip SEP / SEG-N', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  const cases = [
    {
      input: '<<<SHINKANSEN_SEG-1>>> 第一句譯文 <<<SHINKANSEN_SEP>>> <<<SHINKANSEN_SEG-2>>> 第二句譯文',
      expect: '第一句譯文 第二句譯文',
      desc: 'SEP + SEG-N 都殘留',
    },
    { input: '<<<SHINKANSEN_SEP>>>', expect: '', desc: '只有 SEP' },
    { input: '<<<SHINKANSEN_SEG-1>>> 純序號開頭', expect: '純序號開頭', desc: '只有 SEG-1 開頭' },
    { input: '正常譯文沒有標記', expect: '正常譯文沒有標記', desc: '無標記應原樣回傳' },
    { input: '', expect: '', desc: '空字串' },
    { input: null, expect: null, desc: 'null 應原樣回(防禦式)' },
  ];

  for (const c of cases) {
    const out = await evaluate(`window.__SK.sanitizeMarkers(${JSON.stringify(c.input)})`);
    expect(out, `[${c.desc}] input=${JSON.stringify(c.input)}`).toBe(c.expect);
  }

  await page.close();
});

test('sanitize-marker-leak (case 2): TRANSLATE_SUBTITLE_BATCH 回譯文含 SEP/SEG-N → captionMap 已清', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`window.__SK.isYouTubePage = () => true`);
  // 不送 STREAMING(立刻 fallback non-streaming)→ 走 _runBatch 寫 captionMap 路徑
  await evaluate(`
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH_STREAM') {
        return { ok: true, started: false, error: 'force fallback' };
      }
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        const texts = msg.payload.texts || [];
        // 模擬 LLM 偷懶:texts[0] 回完整合併版含 SEP / SEG-N,其餘空字串
        const result = texts.map((_, i) =>
          i === 0
            ? '<<<SHINKANSEN_SEG-1>>> 第一句中文譯文 <<<SHINKANSEN_SEP>>> <<<SHINKANSEN_SEG-2>>> 第二句譯文 <<<SHINKANSEN_SEP>>> <<<SHINKANSEN_SEG-3>>> 第三句譯文'
            : ''
        );
        return {
          ok: true, result,
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  await evaluate(`
    const segs = [];
    for (let i = 0; i < 3; i++) {
      segs.push({ startMs: i * 1000, endMs: (i * 1000) + 800, text: 'line ' + i, normText: 'line ' + i, groupId: null });
    }
    window.__SK.YT.rawSegments = segs;
  `);
  await evaluate(`window.__SK.translateYouTubeSubtitles();`);
  await page.waitForTimeout(500);

  const result = await evaluate(`({
    captionMapEntries: Array.from(window.__SK.YT.captionMap.entries()),
  })`);

  // captionMap 應含 line 0 的譯文,內容不該有 SEP / SEG-N
  const entry0 = result.captionMapEntries.find(([k]) => k === 'line 0');
  expect(entry0, 'line 0 應有 captionMap entry').toBeTruthy();
  const trans0 = entry0[1];
  expect(trans0.includes('<<<SHINKANSEN_SEP>>>'), `line 0 譯文不該含 SEP(實際:${trans0})`).toBe(false);
  expect(/<<<SHINKANSEN_SEG-\d+>>>/.test(trans0), `line 0 譯文不該含 SEG-N(實際:${trans0})`).toBe(false);
  // 應該包含合併後的中文(三句連在一起)
  expect(trans0.includes('第一句中文譯文'), `line 0 譯文應含「第一句中文譯文」`).toBe(true);
  expect(trans0.includes('第二句譯文'), `line 0 譯文應含「第二句譯文」`).toBe(true);

  await page.close();
});
