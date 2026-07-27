// Unit test: openai-compat fetchWithRetry 必含 fetch-level timeout(v1.9.21)
//
// 背景:lib/openai-compat.js 有自己一份 fetchWithRetry,跟 lib/gemini.js 結構對齊但
// 獨立維護(註解明寫「跟 gemini.js fetchWithRetry 對齊」)。Gemini 主翻譯補 15s timeout
// 同時,OpenAI 相容路徑也補,避免 OpenRouter / DeepSeek / 本機 llama.cpp 等 provider
// hang 住卡死。SANITY 同步驗:拔 `signal: controller.signal` → 對應 case fail。
// 2026-07-27:預設從 15_000 調成 90_000——OpenRouter reasoning 模型非 streaming
// 生成整批 >15s,舊預設造成必逾時(Jimmy 實測 ~openai/gpt-latest)。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_PATH = path.resolve(__dirname, '../../shinkansen/lib/openai-compat.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf-8');

test('DEFAULT_FETCH_TIMEOUT_MS 常數為 90_000(reasoning 模型非 streaming 生成留空間)', () => {
  expect(
    SRC,
    'openai-compat.js 缺 `const DEFAULT_FETCH_TIMEOUT_MS = 90_000`',
  ).toMatch(/const\s+DEFAULT_FETCH_TIMEOUT_MS\s*=\s*90_000\s*;/);
});

test('fetchWithRetry 內含 AbortController + setTimeout(abort, timeoutMs)', () => {
  const fnStart = SRC.indexOf('async function fetchWithRetry');
  expect(fnStart, 'openai-compat.js 找不到 fetchWithRetry').toBeGreaterThan(-1);
  const fnBody = SRC.slice(fnStart, fnStart + 2000);

  expect(fnBody, '缺 AbortController').toMatch(/new\s+AbortController\s*\(\s*\)/);
  expect(
    fnBody,
    '缺 `setTimeout(() => controller.abort(), timeoutMs)`',
  ).toMatch(/setTimeout\s*\(\s*\(\s*\)\s*=>\s*controller\.abort\s*\(\s*\)\s*,\s*timeoutMs\s*\)/);
});

test('fetch 帶 `signal: controller.signal`', () => {
  const fnStart = SRC.indexOf('async function fetchWithRetry');
  const fnBody = SRC.slice(fnStart, fnStart + 2000);
  expect(
    fnBody,
    'fetchWithRetry fetch options 缺 `signal: controller.signal`',
  ).toMatch(/signal\s*:\s*controller\.signal/);
});

test('catch 區塊辨識 AbortError', () => {
  const fnStart = SRC.indexOf('async function fetchWithRetry');
  const fnBody = SRC.slice(fnStart, fnStart + 2000);
  expect(
    fnBody,
    'fetchWithRetry catch 缺 `err.name === \'AbortError\'` 偵測',
  ).toMatch(/err\.name\s*===\s*['"]AbortError['"]/);
});

// ── v1.10.46(批次 2-2):timeout 涵蓋範圍延伸到 body 讀完(同 lib/gemini.js)──
// SANITY 紀錄(已驗證,2026-06-11):暫時把 `bodyText = await resp.text()` 改名廢掉
// → 「body 在 timer 涵蓋下讀完」case fail → 還原 → pass

test('clearTimeout(abortTimer) 走 try/finally 統一清', () => {
  const fnStart = SRC.indexOf('async function fetchWithRetry');
  const fnBody = SRC.slice(fnStart, fnStart + 6000);
  expect(
    fnBody,
    'fetchWithRetry 缺 `finally { clearTimeout(abortTimer); }` 結構',
  ).toMatch(/finally\s*\{\s*clearTimeout\s*\(\s*abortTimer\s*\)\s*;?\s*\}/);
});

test('2-2: body 在 timer 涵蓋下讀完(resp.text() + 重建 Response)', () => {
  const fnStart = SRC.indexOf('async function fetchWithRetry');
  const fnBody = SRC.slice(fnStart, fnStart + 6000);
  expect(
    fnBody,
    'fetchWithRetry 成功路徑缺 `await resp.text()`(body 讀取不在 abortTimer 涵蓋內)',
  ).toMatch(/bodyText\s*=\s*await\s+resp\.text\s*\(\s*\)/);
  expect(
    fnBody,
    'fetchWithRetry 缺以 body 文字重建 Response 回傳',
  ).toMatch(/new\s+Response\s*\(\s*bodyText/);
  expect(
    fnBody,
    'fetchWithRetry body 讀取 catch 缺逾時辨識(openai-compat body read timeout)',
  ).toMatch(/openai-compat body read timeout/);
});

test('extractGlossary 預設 fetchTimeoutMs 為 15_000(對齊主翻譯,跟 Gemini 同)', () => {
  const fnStart = SRC.indexOf('export async function extractGlossary');
  expect(fnStart, 'openai-compat.js 找不到 extractGlossary').toBeGreaterThan(-1);
  const fnBody = SRC.slice(fnStart, fnStart + 2000);
  expect(
    fnBody,
    'extractGlossary 預設 fetchTimeoutMs 應為 15_000,不應是 55_000 / 60_000',
  ).toMatch(/fetchTimeoutMs\s*=\s*gc\.fetchTimeoutMs\s*\?\?\s*15_000/);
});

test('fetchWithRetry 接受 timeoutMs 參數(使用者可透過 customProvider.fetchTimeoutSec 覆蓋)', () => {
  const fnStart = SRC.indexOf('async function fetchWithRetry');
  expect(fnStart, 'openai-compat.js 找不到 fetchWithRetry').toBeGreaterThan(-1);
  const fnSignature = SRC.slice(fnStart, fnStart + 200);
  expect(
    fnSignature,
    'fetchWithRetry 簽名缺 timeoutMs 參數（預設 DEFAULT_FETCH_TIMEOUT_MS）',
  ).toMatch(/timeoutMs\s*=\s*DEFAULT_FETCH_TIMEOUT_MS/);
});

test('translateChunk 從 customProvider.fetchTimeoutSec 讀取逾時設定', () => {
  const fnStart = SRC.indexOf('async function translateChunk');
  expect(fnStart, 'openai-compat.js 找不到 translateChunk').toBeGreaterThan(-1);
  const fnBody = SRC.slice(fnStart, fnStart + 4000);
  expect(
    fnBody,
    'translateChunk 缺 fetchTimeoutSec 讀取邏輯',
  ).toMatch(/fetchTimeoutSec/);
  expect(
    fnBody,
    'translateChunk 缺 fetchWithRetry timeoutMs 傳遞',
  ).toMatch(/fetchWithRetry\s*\(.*timeoutMs/s);
});
