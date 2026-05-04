// Regression: background custom-provider handlers must allow empty customProvider.model.
//
// lib/openai-compat.js intentionally omits body.model when model is empty so llama.cpp /
// Ollama-style local servers can use their startup-loaded model. background.js should not
// reject before the adapter gets that chance.

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-dedup-broadcast';

async function sendMessageFrom(page, msg) {
  const { evaluate } = await getShinkansenEvaluator(page);
  return JSON.parse(
    await evaluate(`(async () => JSON.stringify(await chrome.runtime.sendMessage(${JSON.stringify(msg)})))()`)
  );
}

test('custom provider background handlers allow empty model and do not throw model-id validation error', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`
    chrome.storage.sync.set({
      customProvider: {
        baseUrl: 'http://127.0.0.1:9/v1',
        model: '',
        systemPrompt: 'Translate.',
        temperature: 0.1,
        inputPerMTok: 0,
        outputPerMTok: 0,
      },
      maxRetries: 0,
      glossary: {
        prompt: 'Extract glossary as JSON array.',
        temperature: 0.1,
        maxTerms: 20,
      },
    })
  `);
  await page.waitForTimeout(100);

  const translateResp = await sendMessageFrom(page, {
    type: 'TRANSLATE_BATCH_CUSTOM',
    payload: { texts: ['hello world'], glossary: null },
  });
  expect(translateResp?.ok).toBe(false);
  expect(String(translateResp?.error || '')).not.toContain('模型 ID');

  const glossaryResp = await sendMessageFrom(page, {
    type: 'EXTRACT_GLOSSARY_CUSTOM',
    payload: { compressedText: 'Peter Hessler visited Chengdu.', inputHash: 'empty-model-regression' },
  });
  expect(glossaryResp?.ok).toBe(false);
  expect(String(glossaryResp?.error || '')).not.toContain('模型 ID');

  await page.close();
});
