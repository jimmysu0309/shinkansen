'use strict';

/**
 * SPEC-PRIVATE §27「錯誤字串族群」：background/lib 端錯誤訊息 i18n 化（error code 協定）。
 *
 * 背景：service worker 載不了 lib/i18n.js 也不知 uiLanguage，background / lib 端
 * 錯誤改帶結構化 errorCode（+ errorParams）過協定（lib/bg-error.js codedError →
 * background.js errorFields → response / STREAMING_ERROR payload），UI 端用
 * lib/i18n.js bgErrorMessage() 查 'error.bg.' + code 組訊息；沒 code / dict 缺 key
 * fallback 原字串原樣顯示（向下相容，未知錯誤不變空白）。
 *
 * 本檔三層：
 *   1) bgErrorMessage() mapping 行為（載真 dict）：code → 對應語言字串、params 內插、
 *      未知 code / 無 code / 空 payload 的 fallback
 *   2) code ↔ dict key 同步 forcing function：背景四檔出現的每個 error code 必有
 *      error.bg.<code> ×8 語；反向：dict 內每個 error.bg.* key 必對應背景某個 code
 *      （防 dead key——這些 key 由 bgErrorMessage 動態組 'error.bg.' + code 查表，
 *      i18n-key-references.test.cjs 的字面掃描掃不到，dead-key 防護靠這裡）；
 *      placeholder 8 語一致
 *   3) source 斷言（協定接線防 drift）：四檔不再有「throw new Error(含中文字面)」
 *      （使用者面對中文錯誤必過 codedError）；dispatcher catch + 4 個 STREAMING_ERROR
 *      發送點走 errorFields；消費端（content.js / content-youtube.js /
 *      translate-doc/translate.js）走 bgErrorMessage，不殘留硬編「翻譯失敗」fallback
 *
 * 訊號層界定：不驗「真實 API 故障時這些 throw 真的被觸發」（網路逾時 / 429 / 安全過濾
 * 需真 API 故障，harness 到不了）；apiKeyMissing 的完整真實路徑（content → 真 background
 * → 協定 → toast）由 test/regression/bg-error-code-i18n.spec.js 驗。
 *
 * SANITY 紀錄（已驗證，2026-06-11）：暫時把 lib/i18n.js bgErrorMessage 的
 * `if (!code) return raw;` 改成 `return raw;`（永遠 fallback 原字串）→ 第 1 層
 * mapping 測試 2 條 fail（已知 code 查表 + errorParams 內插；另 2 條 fallback 行為
 * 本來就走 raw 不受影響）；還原 → 全綠。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../shinkansen');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

// 載真 dict（i18n.js IIFE 在無 window 環境 attach 到 globalThis.__SK）
require(path.join(ROOT, 'lib/i18n.js'));
const i18n = globalThis.__SK.i18n;

const BG_FILES = ['background.js', 'lib/gemini.js', 'lib/openai-compat.js', 'lib/google-translate.js'];

// 背景四檔實際使用的 error codes：codedError('X') 字面 + EMPTY_REASON_CODES 值 + dailyQuota
function collectBgErrorCodes() {
  const codes = new Set();
  for (const f of BG_FILES) {
    const src = read(f);
    for (const m of src.matchAll(/codedError\(\s*'([A-Za-z0-9]+)'/g)) codes.add(m[1]);
    // codedError(EMPTY_REASON_CODES[x] || 'emptyContent', ...) 的 fallback 字面
    for (const m of src.matchAll(/codedError\(\s*EMPTY_REASON_CODES\[\w+\] \|\| '([A-Za-z0-9]+)'/g)) codes.add(m[1]);
  }
  const gemini = read('lib/gemini.js');
  // EMPTY_REASON_CODES = { SAFETY: 'emptySafety', ... }（經 codedError 第一參數變數引用）
  const emptyBlock = gemini.match(/const EMPTY_REASON_CODES = \{[\s\S]*?\};/);
  expect(emptyBlock).not.toBeNull();
  for (const m of emptyBlock[0].matchAll(/'(\w+)'/g)) codes.add(m[1]);
  // DailyQuotaExceededError constructor 內建 skCode
  expect(gemini).toMatch(/this\.skCode = 'dailyQuota';/);
  codes.add('dailyQuota');
  return codes;
}

describe('1) bgErrorMessage() mapping 行為', () => {
  test('已知 code 依語言查 error.bg.* dict（en / zh-TW / ja）', () => {
    const payload = { error: '尚未設定 Gemini API Key，請至設定頁填入。', errorCode: 'apiKeyMissing' };
    expect(i18n.bgErrorMessage(payload, 'en'))
      .toBe('Gemini API Key not set. Please enter it on the options page');
    expect(i18n.bgErrorMessage(payload, 'zh-TW'))
      .toBe('尚未設定 Gemini API Key，請至設定頁填入');
    expect(i18n.bgErrorMessage(payload, 'ja'))
      .toBe('Gemini API Key が未設定です。設定ページで入力してください');
  });

  test('errorParams 內插（{ms} / {msg} / {status}+{preview}）', () => {
    expect(i18n.bgErrorMessage({ error: 'x', errorCode: 'timeout', errorParams: { ms: 15000 } }, 'en'))
      .toBe('Network error: timed out (15000ms)');
    expect(i18n.bgErrorMessage({ error: 'x', errorCode: 'network', errorParams: { msg: 'Failed to fetch' } }, 'zh-TW'))
      .toBe('網路錯誤：Failed to fetch');
    expect(i18n.bgErrorMessage(
      { error: 'x', errorCode: 'badResponse', errorParams: { status: 502, preview: '<html>' } }, 'en'))
      .toBe('Unexpected Gemini API response (not JSON): HTTP 502. First 200 chars: <html>');
  });

  test('未知 code（dict 缺 key 的版本 drift）fallback 原字串', () => {
    expect(i18n.bgErrorMessage({ error: 'raw message', errorCode: 'noSuchCode' }, 'en'))
      .toBe('raw message');
  });

  test('無 code（API 原文直傳 / 內部錯誤 / 舊版背景）fallback 原字串；空 payload 回空字串', () => {
    expect(i18n.bgErrorMessage({ error: 'You exceeded your current quota' }, 'en'))
      .toBe('You exceeded your current quota');
    expect(i18n.bgErrorMessage(null, 'en')).toBe('');
    expect(i18n.bgErrorMessage({}, 'en')).toBe('');
  });
});

describe('2) code ↔ dict key 同步 forcing function', () => {
  const codes = collectBgErrorCodes();

  test('背景四檔每個 error code 在 8 語 dict 都有 error.bg.<code>', () => {
    const missing = [];
    for (const code of codes) {
      for (const lang of i18n._supported) {
        if (!Object.prototype.hasOwnProperty.call(i18n._tables[lang], `error.bg.${code}`)) {
          missing.push(`${lang}: error.bg.${code}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('dict 內每個 error.bg.* key 都對應背景某個 code（dead-key 防護）', () => {
    const orphan = Object.keys(i18n._tables['zh-TW'])
      .filter((k) => k.startsWith('error.bg.'))
      .filter((k) => !codes.has(k.slice('error.bg.'.length)));
    expect(orphan).toEqual([]);
  });

  test('error.bg.* placeholder 8 語一致', () => {
    const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    const bad = [];
    for (const key of Object.keys(i18n._tables['zh-TW']).filter((k) => k.startsWith('error.bg.'))) {
      const ref = placeholders(i18n._tables['zh-TW'][key]);
      for (const lang of i18n._supported) {
        if (placeholders(i18n._tables[lang][key]) !== ref) bad.push(`${lang}: ${key}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('3) source 斷言：協定接線防 drift', () => {
  test('背景四檔不再有 throw new Error(含中文字面)（使用者面對中文錯誤必過 codedError）', () => {
    const offenders = [];
    for (const f of BG_FILES) {
      for (const [i, line] of read(f).split('\n').entries()) {
        if (/throw new Error\([^\n]*[一-鿿]/.test(line)) offenders.push(`${f}:${i + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('background.js：dispatcher catch + 4 個 STREAMING_ERROR 發送點走 errorFields', () => {
    const bg = read('background.js');
    expect(bg).toContain('sendResponse({ ok: false, ...errorFields(err) })');
    // errorFields(...) 內可能嵌套 codedError(...)（apiKeyMissing streaming 早退點），用 .* 含括
    const streamingSites = bg.match(/payload: \{ streamId, \.\.\.errorFields\(.*\), atSegment: 0 \}/g) || [];
    expect(streamingSites.length).toBe(4);
  });

  test('消費端走 bgErrorMessage，不殘留硬編中文 fallback', () => {
    const content = read('content.js');
    // v2.0.76: 第 3 個消費點 = runZhConvert(簡繁本地轉換批次失敗回報,同 pattern)
    expect((content.match(/SK\.i18n\.bgErrorMessage\(response\)/g) || []).length).toBe(3);
    expect(content).toContain('SK.i18n.bgErrorMessage(message.payload)');

    const yt = read('content-youtube.js');
    expect((yt.match(/SK\.i18n\.bgErrorMessage\(/g) || []).length).toBeGreaterThanOrEqual(5);
    expect(yt).not.toContain("|| '翻譯失敗'");

    const doc = read('translate-doc/translate.js');
    expect(doc).toContain('i18n.bgErrorMessage');
    expect((doc.match(/bgErrMsg\(response\)/g) || []).length).toBe(2);
  });
});
