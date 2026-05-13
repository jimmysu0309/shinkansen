// Regression: v1.9.13 open Shadow DOM 偵測
//
// 結構特徵:web component(custom element)用 attachShadow({ mode: 'open' }) 把
// 內容封裝在 shadow root 內。document.createTreeWalker / document.querySelectorAll
// 不穿透 shadow root → Shinkansen 看不到內容,整片不翻譯。
//
// 真實案例:CSIS / The Atlantic / 任何用 Datawrapper(<datawrapper-visualization>)
// 圖表的網站,以及越來越多用 Lit / Stencil / Svelte web-component 模式的設計
// 系統。Bug reporter 截圖見 conversation thread; 釘 root cause 流程也記錄在
// SPEC-PRIVATE.md。
//
// 修法(content-detect.js v1.9.13):collectParagraphs 把 walker + 4 條補抓抽進
// processScope(scopeRoot),主 root(document.body)跑一次後,SK.findOpenShadowRoots
// 遞迴找所有 open shadow root,各跑一次 processScope。closed shadow root 受 web
// spec 限制完全不可達,只能跳過。
//
// SANITY 紀錄(已驗證):暫時把 collectParagraphs 內 shadow root descent 整段
// (`for (const sr of shadowRoots) processScope(sr)`)註解掉 → 本 spec 第 2 / 3 / 4
// 條斷言 fail(shadow 內 H2 / TD / Note / Source 全收不到);還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'shadow-dom-web-component';

test('shadow DOM: open shadow root 內 H2 / table / note / source 都進 collectParagraphs', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  // 等 custom element upgrade + shadow root attached
  await page.waitForFunction(
    () => !!document.querySelector('chart-embed')?.shadowRoot?.querySelector('h2'),
    { timeout: 10_000 }
  );

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphsWithStats())
  `);
  const { units, skipStats } = JSON.parse(result);

  // 斷言 1:light DOM 控制段落仍正常被收
  const controlH1 = units.find((u) => u.id === 'control-h1');
  expect(controlH1, 'light DOM #control-h1 應該被收').toBeDefined();

  const controlPara = units.find((u) => u.id === 'control-para');
  expect(controlPara, 'light DOM #control-para 應該被收').toBeDefined();

  const controlAfter = units.find((u) => u.id === 'control-after');
  expect(controlAfter, 'light DOM #control-after 應該被收').toBeDefined();

  // 斷言 2:shadow root 內 H2 標題被收(BLOCK_TAGS_SET 路徑命中)
  const shadowHeadline = units.find((u) => u.id === 'shadow-headline');
  expect(shadowHeadline, 'shadow root 內 H2 #shadow-headline 應該被收').toBeDefined();
  expect(shadowHeadline.tag, 'tag 應為 H2').toBe('H2');

  // 斷言 3:shadow root 內 TD 長文字被收(TD 在 BLOCK_TAGS_SET)
  const tdTomahawkDetail = units.find((u) => u.id === 'shadow-td-tomahawk-detail');
  expect(tdTomahawkDetail, 'shadow root 內 TD #shadow-td-tomahawk-detail 應該被收').toBeDefined();
  expect(tdTomahawkDetail.tag).toBe('TD');

  const tdJassmDetail = units.find((u) => u.id === 'shadow-td-jassm-detail');
  expect(tdJassmDetail, 'shadow root 內 TD #shadow-td-jassm-detail 應該被收').toBeDefined();

  // 斷言 4:shadow root 內 P.note 段落被收(P 在 BLOCK_TAGS_SET)
  const shadowNote = units.find((u) => u.id === 'shadow-note');
  expect(shadowNote, 'shadow root 內 P #shadow-note 應該被收').toBeDefined();
  expect(shadowNote.tag).toBe('P');

  // 斷言 5:stats.shadowRootsScanned 應為 1(只有一個 chart-embed)
  expect(skipStats.shadowRootsScanned, '應掃過 1 個 shadow root').toBe(1);

  await page.close();
});

test('shadow DOM: testInject 寫進 shadow 內 element + restorePage 還原', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => !!document.querySelector('chart-embed')?.shadowRoot?.querySelector('h2'),
    { timeout: 10_000 }
  );

  const { evaluate } = await getShinkansenEvaluator(page);

  // 對 shadow 內 H2 inject 譯文
  const before = await evaluate(`
    document.querySelector('chart-embed').shadowRoot.querySelector('#shadow-headline').textContent
  `);
  expect(before).toBe('Table 1: Status of Key Munitions');

  await evaluate(`
    (() => {
      const el = document.querySelector('chart-embed').shadowRoot.querySelector('#shadow-headline');
      window.__shinkansen.testInject(el, '表 1:關鍵彈藥狀態');
    })()
  `);

  const after = await evaluate(`
    document.querySelector('chart-embed').shadowRoot.querySelector('#shadow-headline').textContent
  `);
  expect(after, 'shadow 內 H2 應已注入譯文').toBe('表 1:關鍵彈藥狀態');

  // 確認 data-shinkansen-translated attribute 寫進去
  const hasMark = await evaluate(`
    document.querySelector('chart-embed').shadowRoot.querySelector('#shadow-headline').hasAttribute('data-shinkansen-translated')
  `);
  expect(hasMark, 'shadow 內 element 應有 data-shinkansen-translated marker').toBe(true);

  // restorePage 應還原 shadow 內 element
  await evaluate(`
    window.__shinkansen.setTestState({ translated: true, translatedMode: 'single' });
    window.__shinkansen.testRestorePage();
  `);
  const restored = await evaluate(`
    document.querySelector('chart-embed').shadowRoot.querySelector('#shadow-headline').textContent
  `);
  expect(restored, 'restorePage 後應回原 H2 文字').toBe('Table 1: Status of Key Munitions');

  await page.close();
});

test('shadow DOM: SK.findOpenShadowRoots 遞迴找出所有 open shadow root', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => !!document.querySelector('chart-embed')?.shadowRoot,
    { timeout: 10_000 }
  );

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const roots = window.__SK.findOpenShadowRoots(document.body);
      return JSON.stringify({
        count: roots.length,
        modes: roots.map(r => r.mode),
        hosts: roots.map(r => r.host?.tagName?.toLowerCase()),
      });
    })()
  `);
  const data = JSON.parse(result);

  expect(data.count, '應找到 1 個 open shadow root').toBe(1);
  expect(data.modes[0]).toBe('open');
  expect(data.hosts[0]).toBe('chart-embed');

  await page.close();
});
