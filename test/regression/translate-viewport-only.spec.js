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
    window.__translateUnitsCallCount = 0;
    const origTranslateUnits = window.__SK.translateUnits;
    window.__SK.translateUnits = function(...args) {
      window.__translateUnitsCallCount += 1;
      return origTranslateUnits.apply(this, args);
    };

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
  expect(result.batchCount, 'viewportOnly 應忽略 partialMode 內層 skipBatch1Plus,跑完所有可視範圍批次').toBe(3);
  expect(result.batchSizes, '8 段、batch0=3、maxUnitsPerBatch=3 應切成 3/3/2').toEqual([3, 3, 2]);

  await page.close();
});

test('translate-viewport-only: viewport 變更後 debounce 翻譯新進可視範圍且略過已翻譯段落', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    document.body.innerHTML = '<main id="viewport-fixture"></main>';
    document.body.style.margin = '0';
    const main = document.getElementById('viewport-fixture');
    main.style.cssText = 'position:relative; min-height:1700px; margin:0; padding:0;';
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
    window.__translateUnitsCallCount = 0;
    const origTranslateUnits = window.__SK.translateUnits;
    window.__SK.translateUnits = function(...args) {
      window.__translateUnitsCallCount += 1;
      return origTranslateUnits.apply(this, args);
    };

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

  const initial = await evaluate(`(() => ({
    visibleTranslated: Array.from(document.querySelectorAll('[id^="visible-"]')).filter(el => el.textContent.includes('[ZH]')).length,
    belowTranslated: Array.from(document.querySelectorAll('[id^="below-"]')).filter(el => el.textContent.includes('[ZH]')).length,
    batchCount: window.__batchCount,
    batchSizes: window.__batchSizes.slice(),
    translateUnitsCallCount: window.__translateUnitsCallCount,
  }))()`);
  expect(initial.visibleTranslated).toBe(8);
  expect(initial.belowTranslated).toBe(0);
  expect(initial.batchCount).toBe(3);
  expect(initial.translateUnitsCallCount).toBe(1);

  await evaluate(`
    window.scrollTo(0, 1100);
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('scroll'));
  `);

  for (let i = 0; i < 30; i += 1) {
    await page.waitForTimeout(200);
    const result = await evaluate(`(() => ({
      translating: !!window.__SK.STATE.translating,
      belowTranslated: Array.from(document.querySelectorAll('[id^="below-"]')).filter(el => el.textContent.includes('[ZH]')).length,
      batchCount: window.__batchCount,
    }))()`);
    if (!result.translating && result.belowTranslated === 4) break;
  }

  const afterScroll = await evaluate(`(() => ({
    visibleTranslated: Array.from(document.querySelectorAll('[id^="visible-"]')).filter(el => el.textContent.includes('[ZH]')).length,
    belowTranslated: Array.from(document.querySelectorAll('[id^="below-"]')).filter(el => el.textContent.includes('[ZH]')).length,
    batchCount: window.__batchCount,
    batchSizes: window.__batchSizes.slice(),
    translateUnitsCallCount: window.__translateUnitsCallCount,
  }))()`);

  expect(afterScroll.visibleTranslated, '既有 viewport 內已翻譯段落不應重複翻譯').toBe(8);
  expect(afterScroll.belowTranslated, 'scroll 後新進 viewport 的段落應自動翻譯').toBe(4);
  expect(afterScroll.translateUnitsCallCount, '5 次 scroll event 應 debounce 成單次 viewport rescan').toBe(2);
  expect(afterScroll.batchCount, '初次翻譯 3 批,debounce 後新可視範圍只新增 2 批').toBe(5);
  expect(afterScroll.batchSizes, '初次 8 段切 3/3/2,scroll 後 4 段切 3/1').toEqual([3, 3, 2, 3, 1]);

  await evaluate(`
    for (let i = 0; i < 3; i++) window.dispatchEvent(new Event('scroll'));
  `);
  await page.waitForTimeout(800);

  const afterDuplicateScroll = await evaluate(`({
    batchCount: window.__batchCount,
    translateUnitsCallCount: window.__translateUnitsCallCount,
  })`);
  expect(afterDuplicateScroll.batchCount, '同一 viewport 已翻譯完成後再次 scroll 不應重複翻譯').toBe(5);
  expect(afterDuplicateScroll.translateUnitsCallCount, '同一 viewport 無新段落時不應再次呼叫 translateUnits').toBe(2);

  await page.close();
});
