// Regression: YouTube 自動啟動路徑遇到已 active 不該誤觸 toggle stop(v1.8.16)
//
// 背景(Image 24 + Image 5):reload 後兩條自動鬧鐘都會 fire——
//   (1) content.js:1599 `auto-subtitle on load` setTimeout 800ms
//   (2) content-youtube.js:2334 `yt-navigate-finish` SPA restart setTimeout 500ms
// 第一條觸發後 YT.active=true、字幕載入、第一輪翻譯開跑;第二條 800ms 後到,
// 進 translateYouTubeSubtitles 看 active=true → 走「再按一次還原」分支 →
// stopYouTubeTranslation 把整個 pipeline 砍掉。
//
// 修法(v1.8.16):translateYouTubeSubtitles 加 { source: 'manual'|'auto' }
//   - source='auto' + active=true → no-op log + return(不 toggle)
//   - source='manual'(預設,popup) + active=true → 維持 toggle stop 行為
//
// SANITY CHECK 已完成(v1.8.16 dedicated):
//   把「if (source === 'auto') { ...; return; }」整段移除 →
//   test #1 expect rawSegments 還在 / active 還是 true 兩條 fail。
//   還原後兩 test 都 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-spa-navigate'; // 共用既有 fixture(僅需要 .ytp-caption-window-container stub)

test('youtube-auto-activate-no-toggle-stop #1: source=auto + active=true → no-op,rawSegments 不被清', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-content', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 模擬「第一條鬧鐘已啟動成功」狀態:active=true、rawSegments 已有 553 條(對應 image 5 的真實 case)
  await evaluate(`
    window.__SK.YT.active = true;
    window.__SK.YT.rawSegments = [
      { text: 'hello',  normText: 'hello',  startMs: 0 },
      { text: 'world',  normText: 'world',  startMs: 1000 },
      { text: 'foo',    normText: 'foo',    startMs: 2000 },
    ];
    window.__SK.YT.captionMap = new Map([['hello', '你好']]);
  `);

  // 第二條自動鬧鐘到了:source='auto'
  await evaluate(`window.__SK.translateYouTubeSubtitles({ source: 'auto' })`);
  await page.waitForTimeout(50); // 等 async return

  const active = await evaluate('window.__SK.YT.active');
  const rawCount = await evaluate('window.__SK.YT.rawSegments.length');
  const captionMapSize = await evaluate('window.__SK.YT.captionMap.size');

  expect(active, 'YT.active 應仍為 true(auto 路徑遇 active 應 no-op,不 toggle stop)').toBe(true);
  expect(rawCount, 'rawSegments 不該被清空(stopYouTubeTranslation 才會清)').toBe(3);
  expect(captionMapSize, 'captionMap 不該被清空').toBe(1);

  await page.close();
});

test('youtube-auto-activate-no-toggle-stop #2: source=manual(預設)+ active=true → toggle stop(維持原行為)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-content', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    window.__SK.YT.active = true;
    window.__SK.YT.rawSegments = [
      { text: 'hello', normText: 'hello', startMs: 0 },
    ];
    window.__SK.YT.captionMap = new Map([['hello', '你好']]);
  `);

  // 使用者按 popup 取消勾選 → SET_SUBTITLE 走 stopYouTubeTranslation 直接 path,
  // 但 popup「再按一次」走 translateYouTubeSubtitles() 不帶 source = manual 預設。
  // 這條測 manual 預設仍維持 toggle 還原語義(避免修法把 manual 路徑也改壞)。
  await evaluate(`window.__SK.translateYouTubeSubtitles()`);
  await page.waitForTimeout(50);

  const active = await evaluate('window.__SK.YT.active');
  const rawCount = await evaluate('window.__SK.YT.rawSegments.length');

  expect(active, 'YT.active 應變 false(manual 預設遇 active 走 toggle stop)').toBe(false);
  expect(rawCount, 'rawSegments 應被 stopYouTubeTranslation 清空').toBe(0);

  await page.close();
});
