// Regression: 字幕引擎選 Google Translate 時,AI 分句不得偷打 Gemini
//(GitHub issue #58 的第二條,v2.0.79)
//
// Fixture: test/regression/fixtures/youtube-asr-mode.html(沿用 ASR 既有 fixture)
//
// 症狀:使用者把 YouTube 字幕引擎改成 Google Translate(免費、不需 API Key),卻仍發現
// 自己的 Gemini token 被消耗。原因是 ASR(自動產生字幕)的「AI 分句」預設開啟
//(asrMode='progressive'),而 LLM 合句路徑 `_runAsrWindow` 走的訊息型別
// `TRANSLATE_ASR_SUBTITLE_BATCH` 在 `SK.getSubtitleBatchType(engine, asr=true)` 裡
// 沒有 google 分支(Google MT 不支援 JSON timestamp 合句模式)→ 一律落到 Gemini handler。
// 選項頁「AI 分句」的說明只寫「些微提升 token 耗費」,沒說「就算引擎選了免費的也照打」。
//
// 修法:content-youtube.js 的 asrMode 決策 —— engine === 'google' 時強制 'heuristic'
//(純規則合句 + 逐條走 Google MT),完全不碰 LLM 路徑;options 端同步把「AI 分句」
// toggle 停用並顯示原因(同一份事實兩邊一致,不讓使用者以為勾著就有作用)。
//
// 驗的訊號層次:
//   - 驗:engine=google + AI 分句開啟時,TRANSLATE_ASR_SUBTITLE_BATCH(Gemini)零呼叫,
//     字幕仍能經 Google MT 路徑翻出來;對照組 engine=gemini 照走 LLM 合句
//   - 不驗:heuristic 合句本身的品質(那是 youtube-asr-* 其他 spec 的守備範圍);
//     options UI 的 disabled 狀態(由 source / 手動驗)
//
// SANITY 紀錄(已驗證):把 content-youtube.js 的
//   `const asrMode = (config.engine === 'google') ? 'heuristic' : (config.asrMode || 'progressive');`
//   改回 `const asrMode = config.asrMode || 'progressive';`
//   → 「google 引擎不得呼叫 Gemini ASR handler」case fail(asrBatchCount=1);
//   還原後兩條全綠。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-asr-mode';

const MOCK_SEND = `
  window.__asrBatchCount = 0;       // TRANSLATE_ASR_SUBTITLE_BATCH(Gemini LLM 合句)
  window.__googleBatchCount = 0;    // TRANSLATE_SUBTITLE_BATCH_GOOGLE(免費 Google MT)
  window.__geminiBatchCount = 0;    // TRANSLATE_SUBTITLE_BATCH(Gemini 逐條)
  chrome.runtime.sendMessage = async function(msg) {
    if (!msg || !msg.type) return { ok: true };
    const usage = { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 };
    if (msg.type === 'TRANSLATE_ASR_SUBTITLE_BATCH') {
      window.__asrBatchCount++;
      const inputArr = JSON.parse((msg.payload && msg.payload.texts && msg.payload.texts[0]) || '[]');
      if (!inputArr.length) return { ok: true, result: ['[]'], usage };
      return { ok: true, usage, result: [JSON.stringify([{
        s: inputArr[0].s, e: inputArr[inputArr.length - 1].e, t: '自動字幕真的壞了',
      }])] };
    }
    if (msg.type === 'TRANSLATE_SUBTITLE_BATCH_GOOGLE') {
      window.__googleBatchCount++;
      const texts = (msg.payload && msg.payload.texts) || [];
      return { ok: true, usage, result: texts.map(t => '[GT] ' + t) };
    }
    if (msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
      window.__geminiBatchCount++;
      const texts = (msg.payload && msg.payload.texts) || [];
      return { ok: true, usage, result: texts.map(t => '[ZH] ' + t) };
    }
    return { ok: true };
  };
`;

const CAPTURE_ASR = `
  const json3 = JSON.stringify({
    events: [
      { tStartMs: 500,  segs: [{ utf8: 'the auto' }] },
      { tStartMs: 1200, segs: [{ utf8: 'captions are' }] },
      { tStartMs: 1800, segs: [{ utf8: 'really broken' }] },
    ],
  });
  window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
    detail: { url: 'https://www.youtube.com/api/timedtext?v=ABC&lang=en&kind=asr&caps=asr', responseText: json3 },
  }));
`;

async function runAsr(page, ytSubtitle) {
  await page.goto(`${page.__fixtureUrl}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await evaluate(`chrome.storage.sync.set({ ytSubtitle: ${JSON.stringify(ytSubtitle)} })`);
  await evaluate(MOCK_SEND);
  await evaluate(CAPTURE_ASR);
  await page.waitForTimeout(100);
  await evaluate(`window.__SK.translateYouTubeSubtitles()`);
  await page.waitForTimeout(1500);
  return evaluate(`({
    asr: window.__asrBatchCount,
    google: window.__googleBatchCount,
    gemini: window.__geminiBatchCount,
    isAsr: window.__SK.YT.isAsr,
    captionCount: window.__SK.YT.captionMap.size,
  })`);
}

test('engine=google + AI 分句開啟:不得呼叫 Gemini ASR handler,字幕走免費 Google MT', async ({
  context, localServer,
}) => {
  const page = await context.newPage();
  page.__fixtureUrl = `${localServer.baseUrl}/${FIXTURE}.html`;
  // asrMode 維持預設 progressive（= 選項頁「AI 分句」勾著的狀態）
  const r = await runAsr(page, { engine: 'google', asrMode: 'progressive' });

  expect(r.isAsr, 'fixture 應被識別為 ASR 字幕,否則這條沒驗到 ASR 路徑').toBe(true);
  expect(
    r.asr,
    `引擎選 Google Translate 時不該呼叫 Gemini 的 ASR 合句 handler（使用者選免費引擎卻被扣 token）: ${JSON.stringify(r)}`,
  ).toBe(0);
  expect(
    r.gemini,
    `引擎選 Google Translate 時也不該走 Gemini 逐條字幕 handler: ${JSON.stringify(r)}`,
  ).toBe(0);
  expect(
    r.google,
    `字幕仍應經免費 Google MT 翻出來: ${JSON.stringify(r)}`,
  ).toBeGreaterThan(0);

  await page.close();
});

test('對照組 engine=gemini + AI 分句開啟:照常走 LLM 合句', async ({ context, localServer }) => {
  const page = await context.newPage();
  page.__fixtureUrl = `${localServer.baseUrl}/${FIXTURE}.html`;
  const r = await runAsr(page, { engine: 'gemini', asrMode: 'progressive' });

  expect(r.isAsr).toBe(true);
  expect(
    r.asr,
    `Gemini 引擎的 AI 分句必須照常運作（修法不可誤殺付費使用者的分句品質）: ${JSON.stringify(r)}`,
  ).toBeGreaterThan(0);

  await page.close();
});
