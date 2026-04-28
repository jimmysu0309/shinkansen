// Regression:「僅翻譯可視範圍」節省模式
//
// 鎖定兩件事:
//   1. partialMode.viewportOnly=true 時只翻目前 viewport 內的段落。
//   2. 若同時 partialMode.enabled=true,viewportOnly 優先,不套用 maxUnits 截斷,
//      且 translateUnits 內部 batching 不可因 partialMode.enabled 跳過 batch 1+。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-priority-sort';

test('translate-viewport-only: 只翻可視範圍,且優先於只翻文章開頭', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    document.body.innerHTML = '<main id="viewport-fixture"></main>';
    const main = document.getElementById('viewport-fixture');
    main.style.cssText = 'position:relative; margin:0; padding:0;';
    for (let i = 0; i < 8; i++) {
      const p = document.createElement('p');
      p.id = 'visible-' + i;
      p.textContent = 'visible paragraph ' + i + ' has enough English text to translate';
      p.style.cssText = 'margin:0 0 12px 0; line-height:24px;';
      main.appendChild(p);
    }
    for (let i = 0; i < 4; i++) {
      const p = document.createElement('p');
      p.id = 'below-' + i;
      p.textContent = 'below fold paragraph ' + i + ' has enough English text to translate';
      p.style.cssText = 'position:absolute; top:' + (1200 + i * 40) + 'px; left:0; margin:0; line-height:24px;';
      main.appendChild(p);
    }

    window.__SK.BATCH0_UNITS = 3;
    window.__SK.BATCH0_CHARS = 100000;
    window.__batchCount = 0;
    window.__batchSizes = [];

    chrome.storage.sync.get = async function(keys) {
      return {
        maxConcurrentBatches: 10,
        maxUnitsPerBatch: 3,
        maxCharsPerBatch: 100000,
        maxTranslateUnits: 1000,
        partialMode: { enabled: true, maxUnits: 5, viewportOnly: true },
        skipTraditionalChinesePage: false,
      };
    };
    chrome.storage.local.get = async function() { return {}; };

    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') return { ok: false };
      if (msg && msg.type === 'STREAMING_ABORT') return { ok: true };
      if (msg && msg.type === 'TRANSLATE_BATCH') {
        window.__batchCount += 1;
        const texts = (msg.payload && msg.payload.texts) || [];
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

  await evaluate(`
    (async () => {
      await window.__SK.translatePage({});
    })().catch(e => null)
  `);

  for (let i = 0; i < 30; i += 1) {
    const translating = await evaluate(`!!window.__SK.STATE.translating`);
    if (!translating) break;
    await page.waitForTimeout(200);
  }

  const result = await evaluate(`(() => ({
    visibleTranslated: Array.from(document.querySelectorAll('[id^="visible-"]')).filter(el => el.textContent.includes('[ZH]')).length,
    belowTranslated: Array.from(document.querySelectorAll('[id^="below-"]')).filter(el => el.textContent.includes('[ZH]')).length,
    batchCount: window.__batchCount,
    batchSizes: window.__batchSizes,
  }))()`);

  expect(result.visibleTranslated, 'viewport 內 8 段都應翻譯,不可被 partialMode.maxUnits=5 截斷').toBe(8);
  expect(result.belowTranslated, 'viewport 外段落不應被翻譯').toBe(0);
  expect(result.batchCount, 'viewportOnly 應忽略 partialMode 內層 skipBatch1Plus,跑完所有可視範圍批次').toBeGreaterThanOrEqual(3);
  expect(result.batchSizes, '8 段、batch0=3、maxUnitsPerBatch=3 應切成 3/3/2').toEqual([3, 3, 2]);

  await page.close();
});
