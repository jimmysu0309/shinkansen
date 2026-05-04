// Regression: glossary extraction should respect openai-compat page translation engine.
//
// When glossary is enabled and the user selected the custom OpenAI-compatible provider,
// content.js must not dispatch EXTRACT_GLOSSARY (Gemini-only). It should dispatch
// EXTRACT_GLOSSARY_CUSTOM so missing Gemini API keys do not break best-effort glossary setup.

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-dedup-broadcast';

test('glossary custom provider routing: openai-compat uses EXTRACT_GLOSSARY_CUSTOM, not Gemini EXTRACT_GLOSSARY', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    window.__customGlossaryCount = 0;
    window.__geminiGlossaryCount = 0;
    window.__customTranslateCount = 0;
    window.__geminiTranslateCount = 0;

    chrome.storage.sync.get = async function(keys) {
      return {
        debugLog: false,
        glossary: { enabled: true, skipThreshold: 0, blockingThreshold: 999, timeoutMs: 60000 },
        maxConcurrentBatches: 10,
        maxUnitsPerBatch: 20,
        maxCharsPerBatch: 100000,
        partialMode: { enabled: false, maxUnits: 25 },
        showProgressToast: false,
        toastAutoHide: true,
        translatePresets: [{ slot: 2, engine: 'openai-compat', label: 'Custom' }],
      };
    };

    chrome.runtime.sendMessage = async function(msg) {
      if (!msg || !msg.type) return { ok: true };
      if (msg.type === 'EXTRACT_GLOSSARY_CUSTOM') {
        window.__customGlossaryCount++;
        return { ok: true, glossary: [{ source: 'Example', target: '範例', type: 'tech' }], usage: {} };
      }
      if (msg.type === 'EXTRACT_GLOSSARY') {
        window.__geminiGlossaryCount++;
        return { ok: false, error: 'Gemini should not be used' };
      }
      if (msg.type === 'TRANSLATE_BATCH_CUSTOM') {
        window.__customTranslateCount++;
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: texts.length, outputTokens: texts.length, cachedTokens: 0,
                   billedInputTokens: texts.length, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      if (msg.type === 'TRANSLATE_BATCH' || msg.type === 'TRANSLATE_BATCH_STREAM') {
        window.__geminiTranslateCount++;
        return { ok: false, error: 'Gemini should not be used' };
      }
      return { ok: true };
    };
  `);

  await evaluate(`window.__SK.translatePage({ engine: 'openai-compat' })`);
  await page.waitForTimeout(1500);

  const result = await evaluate(`({
    customGlossaryCount: window.__customGlossaryCount,
    geminiGlossaryCount: window.__geminiGlossaryCount,
    customTranslateCount: window.__customTranslateCount,
    geminiTranslateCount: window.__geminiTranslateCount,
  })`);

  expect(result.customGlossaryCount, 'openai-compat should use EXTRACT_GLOSSARY_CUSTOM').toBe(1);
  expect(result.geminiGlossaryCount, 'openai-compat should not dispatch Gemini EXTRACT_GLOSSARY').toBe(0);
  expect(result.customTranslateCount, 'page translation should still use custom provider').toBeGreaterThanOrEqual(1);
  expect(result.geminiTranslateCount, 'page translation should not use Gemini handlers').toBe(0);

  await page.close();
});
