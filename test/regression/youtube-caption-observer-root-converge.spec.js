// Regression: youtube-caption-observer-root-converge(對應 code review 2026-08-03 C9,dev tail 2.0.81.1 修)
//
// Fixture: 重用 test/regression/fixtures/youtube-streaming-inject.html(有 video 的 YT 形狀頁)
//
// Bug(C9,效能):activation 早於 player mount 時 startCaptionObserver 的 root
//   fallback 掛 #movie_player 甚至整個 document.body(childList + characterData +
//   subtree)。watch 頁 DOM 變動極頻繁,每個 mutation batch 都掃 .ytp-caption-segment;
//   窄 container(.ytp-caption-window-container)出現後也不重掛,整個 session 一直
//   吃全頁 mutation。
// 修法(content-youtube.js startCaptionObserver):fallback root 時排 1s 短重試
//   (比照 _startCaptionScaleObserver 的 retry 模式),窄 container 出現即整顆重掛
//   收斂觀察範圍;stop / 換 observer 後 retry 放手(myObserver 身份比對)。
//
// 本 spec 鎖的訊號層:驗「fallback → 窄 root 出現 → 重掛」的收斂行為與「窄 root
//   直掛時不排多餘重掛」。不驗 YT 真實 watch 頁 mutation 頻率(效能量測環境相依)。
//
// SANITY 紀錄(已驗證,2026-08-05):把 startCaptionObserver 尾端 `if (!container)`
//   重試區塊整段註解掉 → Case 1「container 出現後 observer 應整顆重掛」斷言 fail
//   (remounted=false)→ 還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-streaming-inject';

test('C9-1: fallback root 啟動後,窄 container 出現 → observer 整顆重掛收斂', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (async () => {
      const SK = window.__SK;
      // 前置:確保頁上沒有窄 container → 走 fallback root
      document.querySelectorAll('.ytp-caption-window-container').forEach(n => n.remove());
      SK._startCaptionObserver();
      const first = SK.YT.observer;
      const hadObserver = !!first;
      // 窄 container 出現(player mount 完成)
      const cw = document.createElement('div');
      cw.className = 'ytp-caption-window-container';
      document.body.appendChild(cw);
      // 等重試 tick(1s)整顆重掛:observer 身份改變 = 已重掛
      let remounted = false;
      const start = Date.now();
      while (Date.now() - start < 5000) {
        if (SK.YT.observer && SK.YT.observer !== first) { remounted = true; break; }
        await new Promise(r => setTimeout(r, 100));
      }
      const stillRunning = !!SK.YT.observer;
      // 清理
      SK.stopYouTubeTranslation();
      cw.remove();
      return { hadObserver, remounted, stillRunning };
    })()
  `);

  expect(result.hadObserver, 'fallback 啟動後 observer 應存在(前置條件)').toBe(true);
  expect(result.remounted, '窄 container 出現後 observer 應整顆重掛(收斂到窄 root)').toBe(true);
  expect(result.stillRunning, '重掛後 observer 應仍在運作').toBe(true);

  await page.close();
});

test('C9-2: 窄 container 一開始就在 → 直掛窄 root,不排重掛(observer 身份穩定)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (async () => {
      const SK = window.__SK;
      const cw = document.createElement('div');
      cw.className = 'ytp-caption-window-container';
      document.body.appendChild(cw);
      SK._startCaptionObserver();
      const first = SK.YT.observer;
      // 等超過一個重試 tick,observer 不應被換掉
      await new Promise(r => setTimeout(r, 1500));
      const stable = SK.YT.observer === first;
      SK.stopYouTubeTranslation();
      cw.remove();
      return { stable };
    })()
  `);

  expect(result.stable, '窄 root 直掛時不應有多餘重掛').toBe(true);

  await page.close();
});

test('C9-3: fallback 重試中 stop → retry 放手,不復活 observer', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (async () => {
      const SK = window.__SK;
      document.querySelectorAll('.ytp-caption-window-container').forEach(n => n.remove());
      SK._startCaptionObserver();
      SK.stopYouTubeTranslation();   // 立刻 stop:清 observer + retry timer
      // 給窄 container 出現 + 越過重試 tick 的時間
      const cw = document.createElement('div');
      cw.className = 'ytp-caption-window-container';
      document.body.appendChild(cw);
      await new Promise(r => setTimeout(r, 1500));
      const revived = !!SK.YT.observer;
      cw.remove();
      return { revived };
    })()
  `);

  expect(result.revived, 'stop 後 retry 不得復活 observer').toBe(false);

  await page.close();
});
