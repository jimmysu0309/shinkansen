// Regression: v1.9.9 — 早期 captionTracks 判定 + og:title 語言判定。
//
// 背景:
//   舊路徑等 5s timeout 才能猜「沒字幕」,且不分影片語言一律 fire toast。
//   新路徑透過 ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks
//   (MAIN world bridge)權威確認「沒字幕」,並用 og:title 判斷影片是否已是 target 語言
//   → 若是 target 語言則 silent skip(影片本來就不需要翻譯,toast 是干擾)。
//
// 驗證:
//   case 1: captionTracks=[] + og:title 繁中 → silent(無 toast,1.5s 內)+ 不顯示「等待字幕資料」狀態
//   case 2: captionTracks=[] + og:title 英文 → toast 立即出現(< 1s,不是 5s)+ 不顯示「等待字幕資料」
//   case 3: captionTracks=[{...}] 非空 → 不提早決定,1s 內無 toast,顯示「等待字幕資料」狀態
//   case 4: playerCaptionsTracklistRenderer 整段缺失(實機沒字幕影片的常見形態,非 [] 而是 undefined)
//           + og:title 繁中 → silent + 不顯示等待狀態(playerResponseAvailable + tracks=null 也算「確認沒字幕」)
//   case 5: bridge videoId mismatch URL videoId(SPA 導航 stale ytInitialPlayerResponse 形態)→
//           不該被當「沒字幕」silent,應 fall through 5s tick + 顯示「等待字幕資料」
//
// SANITY CHECK 已完成:
//   (a) 暫時把 _maybeShowNoSubtitleToast 內 titleIsTarget 判斷拔掉(永遠 fire toast)
//       → case 1 fail(本應 silent 卻 fire toast)→ 還原 pass。
//   (b) 暫時把 captionTracks=[] 早期 branch 整段砍掉
//       → case 2 fail(2s 內等不到 toast,要等 5s)→ 還原 pass。
//   (c) 暫時把「等待字幕資料」延後拔掉(改回 showCaptionStatus 提前 call)
//       → case 1 / case 2 fail(__sk-yt-caption-status 元素出現)→ 還原 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-no-caption-tracks';

const TEST_VIDEO_ID = 'testVidA';

async function setupPage(context, localServer, { ogTitle, captionTracks, playerResponseShape, target = 'zh-TW' }) {
  const page = await context.newPage();
  // 帶 ?v=<id> 讓 getVideoIdFromUrl() 拿得到 videoId(v1.9.9 bridge stale guard 需要)
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html?v=${TEST_VIDEO_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  // og:title content + window.ytInitialPlayerResponse 都跑在 MAIN world,
  // 用 page.evaluate 直接設定;bridge listener 也在 MAIN world,讀得到。
  // playerResponseShape 為 case 4 用——直接傳整個 ytInitialPlayerResponse 物件(可能無 captions 子結構),
  // 否則沿用 captionTracks 包成標準結構;兩種 shape 都會注入 videoDetails.videoId=TEST_VIDEO_ID。
  await page.evaluate(({ ogTitle, captionTracks, playerResponseShape, videoId }) => {
    const meta = document.querySelector('meta[property="og:title"]');
    if (meta) meta.setAttribute('content', ogTitle);
    let resp;
    if (playerResponseShape) {
      resp = { ...playerResponseShape };
      resp.videoDetails = { ...(resp.videoDetails || {}), videoId };
    } else {
      resp = {
        videoDetails: { videoId },
        captions: {
          playerCaptionsTracklistRenderer: { captionTracks },
        },
      };
    }
    window.ytInitialPlayerResponse = resp;
  }, { ogTitle, captionTracks, playerResponseShape, videoId: TEST_VIDEO_ID });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await evaluate(`window.__SK.STATE = window.__SK.STATE || {}; window.__SK.STATE.targetLanguage = ${JSON.stringify(target)};`);

  // 攔 sendMessage + 攔 showToast 收集呼叫
  await evaluate(`
    chrome.runtime.sendMessage = async function() { return { ok: true }; };
    window.__toastCalls = [];
    window.__SK.showToast = function(kind, msg, opts) {
      window.__toastCalls.push({ kind, msg, opts, t: Date.now() });
    };
    // 攔 CC button click 避免 side effect
    const btn = document.querySelector('.ytp-subtitles-button');
    btn.click = function() {};
    window.__activateAt = Date.now();
  `);
  return { page, evaluate };
}

test('case 1: captionTracks=[] + og:title 繁中 → silent skip(無 toast + 無等待狀態)', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer, {
    ogTitle: '中文影片標題範例',
    captionTracks: [],
    target: 'zh-TW',
  });

  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  await page.waitForTimeout(1500);  // bridge 早期決定 < 100ms,1.5s 確認沒延遲 fire

  const result = await evaluate(`({
    toastCalls: window.__toastCalls,
    statusEl: !!document.getElementById('__sk-yt-caption-status'),
  })`);
  expect(
    result.toastCalls.length,
    `影片標題已是繁中 + 影片無字幕 → 應 silent skip。實際 toast: ${JSON.stringify(result.toastCalls)}`,
  ).toBe(0);
  expect(
    result.statusEl,
    '不該顯示「等待字幕資料」狀態(__sk-yt-caption-status 元素)',
  ).toBe(false);

  await page.close();
});

test('case 2: captionTracks=[] + og:title 英文 → 立即 fire toast(< 1s)', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer, {
    ogTitle: 'How to Build a React App in 2026',
    captionTracks: [],
    target: 'zh-TW',
  });

  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  await page.waitForTimeout(800);  // 早期決定應在 < 100ms,800ms 留 buffer

  const result = await evaluate(`({
    toastCalls: window.__toastCalls,
    activatedAt: window.__activateAt,
    statusEl: !!document.getElementById('__sk-yt-caption-status'),
  })`);
  const errorToast = result.toastCalls.find((c) => c.kind === 'error' && /本影片未提供 CC 字幕/.test(c.msg));
  expect(errorToast, `英文影片無字幕 → 應 fire toast。實際: ${JSON.stringify(result.toastCalls)}`).toBeTruthy();
  expect(errorToast.opts?.autoHideMs, 'toast 應有 autoHideMs').toBeGreaterThan(0);
  // 早期路徑驗證:< 1s 已 fire(舊路徑要等 5s)
  expect(
    errorToast.t - result.activatedAt,
    'toast 應在 ~1s 內 fire(captionTracks=[] 早期決定),不是 5s',
  ).toBeLessThan(1000);
  // 早期決定 = 不顯示「等待字幕資料」狀態(直接跳 toast)
  expect(
    result.statusEl,
    '早期決定 = 不該顯示「等待字幕資料」狀態',
  ).toBe(false);

  await page.close();
});

test('case 3: captionTracks 非空 → 不提早 fire toast(1s 內)', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer, {
    ogTitle: 'How to Build a React App in 2026',
    captionTracks: [{ languageCode: 'en', kind: 'asr' }],
    target: 'zh-TW',
  });

  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  await page.waitForTimeout(1200);  // 跨過 1s tick(forceSubtitleReload),不該 fire toast

  const result = await evaluate(`({
    toastCalls: window.__toastCalls,
    statusEl: !!document.getElementById('__sk-yt-caption-status'),
    statusText: document.getElementById('__sk-yt-caption-status')?.textContent || null,
  })`);
  const errorToasts = result.toastCalls.filter((c) => c.kind === 'error');
  expect(
    errorToasts.length,
    `captionTracks 有內容 = 影片有字幕,1.2s 內不該 fire toast(等 5s fallback)。實際: ${JSON.stringify(result.toastCalls)}`,
  ).toBe(0);
  // captionTracks 非空 = 有字幕要等 → 該顯示「等待字幕資料」狀態
  expect(
    result.statusEl,
    'captionTracks 非空 → 應顯示「等待字幕資料」狀態',
  ).toBe(true);
  expect(result.statusText).toContain('等待字幕資料');

  await page.close();
});

test('case 5: stale ytInitialPlayerResponse(videoId mismatch URL)→ 不被當沒字幕 silent', async ({ context, localServer }) => {
  // 模擬 SPA 導航後 ytInitialPlayerResponse 還沒更新到新影片的場景:
  // URL 是新 videoId,但 ytInitialPlayerResponse.videoDetails.videoId 還是舊的,
  // captionTracks 也是舊影片的(null = 舊影片沒字幕)。
  // 修法前:bridge 回的 captionTracks=null 被當成新影片的權威「沒字幕」訊號 +
  //         og:title 中文 → 誤判 silent → 切到中文標題英文影片完全不翻譯。
  // 修法後:videoId 對不上 = stale,retry → 給上後 fall through 5s tick + 顯示等待狀態。
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html?v=newVidB`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  // ytInitialPlayerResponse.videoDetails.videoId 設成 'oldVidA' 模擬 stale,
  // captionTracks=null 模擬「舊的中文無字幕影片資料」,og:title 中文(誘導 silent)
  await page.evaluate(() => {
    const meta = document.querySelector('meta[property="og:title"]');
    if (meta) meta.setAttribute('content', '中文舊影片標題');
    window.ytInitialPlayerResponse = {
      videoDetails: { videoId: 'oldVidA' },
      // 無 captions 結構 = stale 上一支中文無字幕影片
    };
  });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await evaluate(`window.__SK.STATE = window.__SK.STATE || {}; window.__SK.STATE.targetLanguage = 'zh-TW';`);
  await evaluate(`
    chrome.runtime.sendMessage = async function() { return { ok: true }; };
    window.__toastCalls = [];
    window.__SK.showToast = function(kind, msg, opts) {
      window.__toastCalls.push({ kind, msg, opts, t: Date.now() });
    };
    const btn = document.querySelector('.ytp-subtitles-button');
    btn.click = function() {};
  `);

  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  await page.waitForTimeout(1500);  // 過 bridge retry window(MAX 4 × 200ms ≈ 800ms)

  const result = await evaluate(`({
    toastCalls: window.__toastCalls,
    statusEl: !!document.getElementById('__sk-yt-caption-status'),
  })`);
  expect(
    result.toastCalls.length,
    `stale videoId 不該被當沒字幕 silent / 也不該提早 toast,實際 toast: ${JSON.stringify(result.toastCalls)}`,
  ).toBe(0);
  expect(
    result.statusEl,
    'stale videoId 應 fall through → 顯示「等待字幕資料」狀態',
  ).toBe(true);

  await page.close();
});

test('case 4: playerCaptionsTracklistRenderer 整段缺失 + 繁中標題 → silent + 無等待狀態(實機沒字幕影片形態)', async ({ context, localServer }) => {
  // 實機觀察:沒字幕影片的 ytInitialPlayerResponse 通常不含 playerCaptionsTracklistRenderer.captionTracks
  // (整段 captions 子結構缺失或 captionTracks 是 undefined,而非空 [])。
  // 此 case 鎖:bridge 收到 playerResponseAvailable=true + captionTracks=null 也算「確認沒字幕」。
  const { page, evaluate } = await setupPage(context, localServer, {
    ogTitle: '中文影片標題範例',
    playerResponseShape: { videoDetails: { videoId: 'xxx' }, playabilityStatus: { status: 'OK' } }, // 無 captions 子結構
    target: 'zh-TW',
  });

  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  await page.waitForTimeout(1500);

  const result = await evaluate(`({
    toastCalls: window.__toastCalls,
    statusEl: !!document.getElementById('__sk-yt-caption-status'),
  })`);
  expect(
    result.toastCalls.length,
    `繁中標題 + 確認沒字幕 → 應 silent。實際: ${JSON.stringify(result.toastCalls)}`,
  ).toBe(0);
  expect(
    result.statusEl,
    'playerCaptionsTracklistRenderer 缺失也算「確認沒字幕」→ 不該顯示等待狀態',
  ).toBe(false);

  await page.close();
});
