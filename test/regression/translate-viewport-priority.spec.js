// Regression: viewport should only affect existing prioritizeUnits ordering;
// it must not add a separate scroll/rescan translation path.

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-priority-sort';

async function setupViewportFixture(evaluate) {
  await evaluate(`
    document.body.innerHTML = '<main id="viewport-fixture"></main>';
    document.body.style.cssText = 'margin:0; min-height:2600px;';
    const main = document.getElementById('viewport-fixture');
    main.style.cssText = 'position:relative; min-height:2600px; margin:0; padding:0;';

    const addParagraph = (id, text, top) => {
      const p = document.createElement('p');
      p.id = id;
      p.textContent = text;
      p.style.cssText = 'position:absolute; top:' + top + 'px; left:0; width:760px; margin:0; line-height:24px;';
      main.appendChild(p);
    };

    addParagraph('far-main', 'Far below fold article paragraph with substantial English content, commas, and enough length to score as main content.', 1800);
    addParagraph('near-below-main', 'Near below fold article paragraph with substantial English content, commas, and enough length to score as main content.', 760);
    addParagraph('near-above-main', 'Near above viewport article paragraph with substantial English content, commas, and enough length to score as main content.', -80);
    addParagraph('visible-short', 'Visible toolbar text with enough English words to translate correctly.', 40);
  `);
}

test('translate-viewport-priority: prioritizeUnits 優先排 viewport 內與下一屏內容', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);
  await setupViewportFixture(evaluate);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const before = SK.collectParagraphs();
      const after = SK.prioritizeUnits(before);
      return JSON.stringify({
        before: before.map(u => u.el?.id || null),
        after: after.map(u => u.el?.id || null),
      });
    })()
  `);
  const { before, after } = JSON.parse(result);

  expect(before, 'fixture should collect the four paragraphs in DOM order').toEqual(['far-main', 'near-below-main', 'near-above-main', 'visible-short']);
  expect(after, 'visible viewport → next screen below → other content should be prioritized in order').toEqual(['visible-short', 'near-below-main', 'far-main', 'near-above-main']);

  await page.close();
});

test('translate-viewport-priority: viewportOnly 只翻可視範圍且捲動後補翻新進入 viewport 的段落', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);
  await setupViewportFixture(evaluate);

  await evaluate(`
    window.__scrollListenerCount = 0;
    const origAddEventListener = window.addEventListener.bind(window);
    window.addEventListener = function(type, listener, options) {
      if (type === 'scroll') window.__scrollListenerCount += 1;
      return origAddEventListener(type, listener, options);
    };

    window.__batchCount = 0;
    window.__batchSizes = [];
    window.__SK.BATCH0_UNITS = 2;
    window.__SK.BATCH0_CHARS = 100000;

    chrome.storage.sync.get = async function() {
      return {
        maxConcurrentBatches: 10,
        maxUnitsPerBatch: 2,
        maxCharsPerBatch: 100000,
        maxTranslateUnits: 1000,
        partialMode: { enabled: false, maxUnits: 5, viewportOnly: true },
        skipTraditionalChinesePage: false,
      };
    };
    chrome.storage.local.get = async function() { return {}; };
    chrome.runtime.sendMessage = async function(msg) {
      if (msg?.type === 'TRANSLATE_BATCH_STREAM') return { ok: false };
      if (msg?.type === 'STREAMING_ABORT') return { ok: true };
      if (msg?.type === 'TRANSLATE_BATCH') {
        const texts = msg.payload?.texts || [];
        window.__batchCount += 1;
        window.__batchSizes.push(texts.length);
        return {
          ok: true,
          result: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUSD: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  await evaluate(`window.__SK.translatePage({}).catch(e => null)`);

  const result = await evaluate(`(() => ({
    translating: !!window.__SK.STATE.translating,
    translatedIds: Array.from(document.querySelectorAll('#viewport-fixture p'))
      .filter(el => el.textContent.includes('[ZH]'))
      .map(el => el.id),
    batchCount: window.__batchCount,
    batchSizes: window.__batchSizes,
    scrollListenerCount: window.__scrollListenerCount,
  }))()`);

  expect(result.translating).toBe(false);
  expect(result.translatedIds, 'viewportOnly=true 初次應翻目前 viewport 與上下少量緩衝區段落').toEqual([
    'near-below-main',
    'near-above-main',
    'visible-short',
  ]);
  expect(result.batchCount, '初次應翻 viewport 與上下少量緩衝區共 3 段').toBe(2);
  expect(result.batchSizes).toEqual([2, 1]);
  expect(result.scrollListenerCount, '應註冊 scroll listener 供捲動後補翻').toBeGreaterThanOrEqual(1);

  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForTimeout(500);
  const afterNearScroll = await evaluate(`Array.from(document.querySelectorAll('#viewport-fixture p'))
    .filter(el => el.textContent.includes('[ZH]'))
    .map(el => el.id)`);
  expect(afterNearScroll, '捲到 near-below-main 可視後不應重翻，far-main 仍不翻').toEqual([
    'near-below-main',
    'near-above-main',
    'visible-short',
  ]);

  await page.evaluate(() => window.scrollTo(0, 1700));
  await page.waitForTimeout(500);
  const afterFarScroll = await evaluate(`Array.from(document.querySelectorAll('#viewport-fixture p'))
    .filter(el => el.textContent.includes('[ZH]'))
    .map(el => el.id)`);
  expect(afterFarScroll, 'far-main 進入 viewport 後應補翻').toEqual([
    'far-main',
    'near-below-main',
    'near-above-main',
    'visible-short',
  ]);

  await page.close();
});
