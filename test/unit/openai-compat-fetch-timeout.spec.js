// Unit test: openai-compat fetchWithRetry 必含 15s fetch-level timeout(v1.9.21)
//
// 背景:lib/openai-compat.js 有自己一份 fetchWithRetry,跟 lib/gemini.js 結構對齊但
// 獨立維護(註解明寫「跟 gemini.js fetchWithRetry 對齊」)。Gemini 主翻譯補 15s timeout
// 同時,OpenAI 相容路徑也補,避免 OpenRouter / DeepSeek / 本機 llama.cpp 等 provider
// hang 住卡死。SANITY 同步驗:拔 `signal: controller.signal` → 對應 case fail。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_PATH = path.resolve(__dirname, '../../shinkansen/lib/openai-compat.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf-8');

test('DEFAULT_FETCH_TIMEOUT_MS 常數為 15_000(對齊 Gemini 主翻譯)', () => {
  expect(
    SRC,
    'openai-compat.js 缺 `const DEFAULT_FETCH_TIMEOUT_MS = 15_000`',
  ).toMatch(/const\s+DEFAULT_FETCH_TIMEOUT_MS\s*=\s*15_000\s*;/);
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

test('clearTimeout(abortTimer) 成功與失敗兩路徑都呼叫', () => {
  const fnStart = SRC.indexOf('async function fetchWithRetry');
  const fnBody = SRC.slice(fnStart, fnStart + 2000);
  const matches = fnBody.match(/clearTimeout\s*\(\s*abortTimer\s*\)/g) || [];
  expect(
    matches.length,
    `應 ≥ 2 次 clearTimeout,實際 ${matches.length}`,
  ).toBeGreaterThanOrEqual(2);
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
