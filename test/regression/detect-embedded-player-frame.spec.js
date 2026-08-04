// Regression: 嵌入式播放器 iframe 不翻(GitHub issue #58,v2.0.79)
//
// Fixture: test/regression/fixtures/embed-player-frame.html(+ 三個 inner 檔)
//
// 症狀(使用者回報 + 用量紀錄佐證):課程頁按一次快速鍵翻譯,用量紀錄同時冒出兩筆——
// 主頁一筆、`www.youtube.com/embed/<id>` 一筆。原因是整頁翻譯指令由 background
// `tabs.sendMessage` 廣播給分頁內所有 frame(刻意不帶 frameId,嵌入式圖表 iframe 要靠它),
// 頁面嵌的影片播放器因此也各自跑一輪 translatePage,把播放器 UI(影片標題 / 頻道 /
// 訂閱數)送進 LLM:按一次快速鍵付兩份錢,譯文只在播放器角落一閃而過。
// 使用者誤以為是「YouTube 字幕自動翻譯關不掉」,實際上字幕路徑 gate 在 /watch,
// embed 頁根本不會跑字幕翻譯——關字幕開關、把字幕引擎改成 Google 都不會有效果。
//
// 修法(結構通則 §8,不綁站點):content-ns.js `isEmbeddedPlayerFrame` —— 非主 frame
// ＋ 有 media element(video / audio)＋ 可見文字量 < 200 字元 = 播放器介面,
// translatePage / translatePageGoogle 入口靜默結束。圖表類 iframe 沒有 media element,
// 第一條就不成立,既有「嵌入式圖表照翻」行為不受影響。
//
// 驗的訊號層次:
//   - 驗:判定函式對三種真實 iframe 結構的結果 + 播放器 frame 真的不注入譯文
//     (走 convertOnly 本地簡繁轉換路徑,零 API 呼叫但完整經過 translatePage 入口)
//   - 不驗:background 廣播本身(那是 chrome API 行為);跨來源 iframe(fixture 用同源,
//     判定函式只讀自己 frame 的 document,同源與否不影響判準)
//
// SANITY 紀錄(已驗證,兩處分別破壞):
//   1. content.js translatePage 入口的 `if (SK.isEmbeddedPlayerFrame?.(...)) return;` 註解掉
//      → 整合 case fail:播放器 iframe marked=3、文字被轉成「安裝這套開發工具 示範頻道…」
//   2. content-ns.js isEmbeddedPlayerFrame 的 media element 條件停用(視同永遠有 media)
//      → 純函式 case fail(圖表 iframe verdict=true)＋ 整合 case fail(圖表 iframe marked=0,
//        守門誤殺)
//   還原後四條全綠。
//
// 假覆蓋教訓:播放器 fixture 初版用英文文字,convertOnly 路徑本來就不處理英文,
//   破壞修法後 spec 照樣綠(marked 恆為 0)。改成簡體中文才咬得住。
import { test, expect } from '../fixtures/extension.js';

const FIXTURE = 'embed-player-frame';

// 本 spec 專用的 isolated world evaluator:必須綁「主 frame」的 Shinkansen context。
// helpers/run-inject.js 的通用版挑第一個名為 Shinkansen 的 isolated context——本 fixture
// 有三個同源 iframe,各自也有一個同名 context,通用版會挑到 iframe 那個(取不到 #f-player)。
// 這裡用 Page.getFrameTree 的 root frameId 精準對到主 frame 的 context。
async function getTopFrameEvaluator(page) {
  const cdp = await page.context().newCDPSession(page);
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
  await cdp.send('Runtime.enable');
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const rootId = frameTree.frame.id;
  const deadline = Date.now() + 8000;
  let top = null;
  while (Date.now() < deadline) {
    top = contexts.find((c) => c.auxData?.type === 'isolated'
      && /Shinkansen/i.test(c.name || '')
      && c.auxData?.frameId === rootId);
    if (top) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!top) throw new Error('找不到主 frame 的 Shinkansen isolated context');
  return async (expression) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression, contextId: top.id, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(`evaluate 失敗: ${r.exceptionDetails.text}\n${expression}`);
    return r.result.value;
  };
}

test('isEmbeddedPlayerFrame: 播放器 iframe 判 true,內容型 / 圖表型 iframe 判 false', async ({
  context, localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  const evaluate = await getTopFrameEvaluator(page);
  const result = await evaluate(`
    (() => {
      const pick = (id) => {
        const f = document.getElementById(id);
        return { doc: f.contentDocument, win: f.contentWindow };
      };
      const judge = (id) => {
        const { doc, win } = pick(id);
        return {
          verdict: window.__SK.isEmbeddedPlayerFrame(doc, win),
          hasMedia: !!doc.querySelector('video, audio'),
          textLen: (doc.body.innerText || '').replace(/\\s+/g, ' ').trim().length,
        };
      };
      return {
        player: judge('f-player'),
        article: judge('f-article'),
        chart: judge('f-chart'),
        // 主 frame 自己永遠不套用(否則整頁翻譯會被自己的守門殺掉)
        topFrame: window.__SK.isEmbeddedPlayerFrame(document, window),
        limit: window.__SK.EMBED_PLAYER_TEXT_LIMIT,
      };
    })()
  `);

  expect(result.player.verdict, `播放器 iframe 應判為 embedded player: ${JSON.stringify(result.player)}`).toBe(true);
  expect(result.article.verdict, `內含影片的文章 iframe 不該被跳過: ${JSON.stringify(result.article)}`).toBe(false);
  expect(result.article.textLen, '對照組文字量必須超過門檻,否則這條沒驗到東西').toBeGreaterThan(result.limit);
  expect(result.chart.verdict, `圖表 iframe(無 media element)不該被跳過: ${JSON.stringify(result.chart)}`).toBe(false);
  expect(result.chart.hasMedia, '圖表對照組不該有 media element').toBe(false);
  expect(result.topFrame, '主 frame 永遠不該被判為 embedded player').toBe(false);

  await page.close();
});

test('translatePage 入口:播放器 iframe 靜默結束,圖表 iframe 照常翻譯', async ({
  context, localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  const evaluate = await getTopFrameEvaluator(page);
  // convertOnly(簡繁本地轉換)完整走 translatePage 入口但零 API 呼叫:
  // 三個 frame 各自呼叫,只有非播放器的該產生譯文
  await evaluate(`
    (async () => {
      const run = (id) => {
        const win = document.getElementById(id).contentWindow;
        return win.__SK?.translatePage?.({ convertOnly: true }) || Promise.resolve();
      };
      await Promise.all([run('f-player'), run('f-chart')]).catch(() => {});
      return true;
    })()
  `);
  await page.waitForTimeout(3000);

  const after = await evaluate(`
    (() => {
      const stat = (id) => {
        const doc = document.getElementById(id).contentDocument;
        return {
          marked: doc.querySelectorAll('[data-shinkansen-translated]').length,
          text: (doc.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
        };
      };
      return { player: stat('f-player'), chart: stat('f-chart') };
    })()
  `);

  expect(
    after.player.marked,
    `播放器 iframe 不該有任何譯文注入: ${JSON.stringify(after.player)}`,
  ).toBe(0);
  expect(
    after.chart.marked,
    `圖表 iframe 應照常轉換(守門不可誤殺): ${JSON.stringify(after.chart)}`,
  ).toBeGreaterThan(0);
  expect(after.chart.text, '圖表 iframe 的簡體字應已轉成繁體').toContain('全球出貨量趨勢');

  await page.close();
});
