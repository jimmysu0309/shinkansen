// Unit test:YouTube 字幕翻譯訊息類型路由(SK.getSubtitleBatchType)
//
// 為什麼這條 spec 存在:
//   字幕翻譯有兩維度組合(engine × ASR mode),原本 content-youtube.js 在 4 處 inline
//   三元式判斷訊息類型,容易 drift。v1.8.50+ 把 routing 收斂成 SK.getSubtitleBatchType
//   單一 helper(content-ns.js)。這條 spec 鎖三 engine × 兩 mode 共 6 個 case,確保
//   未來改 helper 邏輯不會悄悄回退。
//
// 為什麼不直接 import:content-ns.js 是 content script IIFE,把 helper 掛在 window.__SK
//   命名空間下,沒走 ESM。inline 重複實作然後 grep 比對 helper 行數,確保兩邊同步。
//
// SANITY 紀錄(已驗證):
//   - 把 helper ASR + openai-compat case 的回傳改成 'TRANSLATE_ASR_SUBTITLE_BATCH'
//     (即 PR #32 修補前的行為),「engine='openai-compat' + ASR」case fail。
//   - 把 helper 非 ASR + google 的回傳改成 'TRANSLATE_SUBTITLE_BATCH'
//     (退掉 v1.4.0 google routing),「engine='google' + 非 ASR」case fail。
//
// 對應 PR:#32(YouTube ASR 走自訂 Provider 時 routing 寫死 Gemini)
import { test, expect } from '@playwright/test';
import fs from 'node:fs';

// 重複 content-ns.js 的 SK.getSubtitleBatchType 邏輯。
// 兩邊內容必須字面一致(下方 grep 檢查鎖住),drift 會立刻 fail。
function getSubtitleBatchType(engine, asr) {
  if (asr) {
    if (engine === 'openai-compat') return 'TRANSLATE_ASR_SUBTITLE_BATCH_CUSTOM';
    return 'TRANSLATE_ASR_SUBTITLE_BATCH';
  }
  if (engine === 'google')        return 'TRANSLATE_SUBTITLE_BATCH_GOOGLE';
  if (engine === 'openai-compat') return 'TRANSLATE_SUBTITLE_BATCH_CUSTOM';
  return 'TRANSLATE_SUBTITLE_BATCH';
}

// engine × asr 全 case
const cases = [
  // 非 ASR
  { engine: undefined,        asr: false, expected: 'TRANSLATE_SUBTITLE_BATCH' },
  { engine: null,             asr: false, expected: 'TRANSLATE_SUBTITLE_BATCH' },
  { engine: 'gemini',         asr: false, expected: 'TRANSLATE_SUBTITLE_BATCH' },
  { engine: 'google',         asr: false, expected: 'TRANSLATE_SUBTITLE_BATCH_GOOGLE' },
  { engine: 'openai-compat',  asr: false, expected: 'TRANSLATE_SUBTITLE_BATCH_CUSTOM' },
  // ASR(JSON timestamp 模式)
  { engine: undefined,        asr: true,  expected: 'TRANSLATE_ASR_SUBTITLE_BATCH' },
  { engine: 'gemini',         asr: true,  expected: 'TRANSLATE_ASR_SUBTITLE_BATCH' },
  // Google MT 不支援 JSON timestamp 模式 → fallback Gemini
  { engine: 'google',         asr: true,  expected: 'TRANSLATE_ASR_SUBTITLE_BATCH' },
  { engine: 'openai-compat',  asr: true,  expected: 'TRANSLATE_ASR_SUBTITLE_BATCH_CUSTOM' },
];

for (const c of cases) {
  test(`engine=${String(c.engine)}, asr=${c.asr} → ${c.expected}`, () => {
    expect(getSubtitleBatchType(c.engine, c.asr)).toBe(c.expected);
  });
}

// 鎖 inline helper 與 content-ns.js 同步:把兩邊正規化後比對字面。
// 任何一邊 drift,測試立刻 fail——避免「unit spec 還綠但實際 routing 已回退」的偽陰性。
test('content-ns.js SK.getSubtitleBatchType 內容跟 spec inline 邏輯一致', () => {
  // playwright 從 repo root 跑,用 cwd-relative 路徑避免 __dirname / import.meta 兩種模組系統差異
  const src = fs.readFileSync('shinkansen/content-ns.js', 'utf8');
  // 抓 helper body(從 SK.getSubtitleBatchType = 開始到下一個 ; 結尾的 function expression)
  const m = src.match(/SK\.getSubtitleBatchType\s*=\s*function\s+getSubtitleBatchType\s*\(engine,\s*asr\)\s*\{([\s\S]*?)\n  \};/);
  expect(m, 'content-ns.js 找不到 SK.getSubtitleBatchType 定義').toBeTruthy();

  const nsBody = m[1].replace(/\s+/g, ' ').trim();
  // spec inline 版本提取 body
  const inlineSrc = getSubtitleBatchType.toString();
  const inlineBody = inlineSrc.slice(inlineSrc.indexOf('{') + 1, inlineSrc.lastIndexOf('}'))
    .replace(/\s+/g, ' ').trim();

  expect(nsBody).toBe(inlineBody);
});

// ─── issue #58:ASR 模式解析(engine='google' 強制 heuristic)──────────────
//
// 上游 issue #58 症狀 2:使用者把字幕引擎改成 google translate(免費)後,ASR 影片
// 仍靜默呼叫預設 Gemini API 燒 tokens。根因:asrMode 預設 'progressive',其 LLM
// overlay(_runAsrWindow)與 'llm' 模式的 JSON timestamp 翻譯都是 LLM 任務,
// getSubtitleBatchType 的 ASR 分支對 google 只能 fallback Gemini(上方 case 表的
// 文件化既定路由,不能動——Google MT 真的不支援 JSON timestamp 模式)。修法收斂在
// 「模式解析」單點:engine='google' 時 ASR 一律走 heuristic 合句(逐句翻,走
// TRANSLATE_SUBTITLE_BATCH_GOOGLE 免費端點),LLM 相關模式只在 LLM 引擎下生效。
//
// 驗到 / 沒驗到:
//   ✅ SK.resolveAsrMode 決策表(google → heuristic;其餘引擎 passthrough + 預設 progressive)
//   ✅ content-youtube.js 的 asrMode 取值點真的走 SK.resolveAsrMode(靜態鎖定,防 inline 回退)
//   ❌ 「google + ASR 影片全程零付費 API 呼叫」的 e2e 層 — 需真實 YouTube 影片 + 網路,
//      靠 Mac/桌面實測驗證。
//
// SANITY 紀錄(已驗證):把 content-ns.js helper 的 google 分支拿掉,
// 「resolveAsrMode 同步」test fail;content-youtube.js 改回 inline
// `config.asrMode || 'progressive'`,「取值走 SK.resolveAsrMode」test fail。

// 重複 content-ns.js 的 SK.resolveAsrMode 邏輯,同上方 getSubtitleBatchType 的
// inline + grep 比對模式。
function resolveAsrMode(engine, asrMode) {
  if (engine === 'google') return 'heuristic';
  return asrMode || 'progressive';
}

const asrModeCases = [
  // google:任何 asrMode 設定都強制 heuristic(免費引擎不得觸發 LLM 路徑)
  { engine: 'google',        asrMode: 'progressive', expected: 'heuristic' },
  { engine: 'google',        asrMode: 'llm',         expected: 'heuristic' },
  { engine: 'google',        asrMode: 'heuristic',   expected: 'heuristic' },
  { engine: 'google',        asrMode: undefined,     expected: 'heuristic' },
  // LLM 引擎:passthrough
  { engine: 'gemini',        asrMode: 'llm',         expected: 'llm' },
  { engine: 'gemini',        asrMode: 'heuristic',   expected: 'heuristic' },
  { engine: 'openai-compat', asrMode: 'progressive', expected: 'progressive' },
  // 未設定 engine(預設 Gemini)/未設定 asrMode:維持既有預設 progressive
  { engine: undefined,       asrMode: undefined,     expected: 'progressive' },
  { engine: undefined,       asrMode: 'heuristic',   expected: 'heuristic' },
];

for (const c of asrModeCases) {
  test(`resolveAsrMode(${String(c.engine)}, ${String(c.asrMode)}) → ${c.expected}`, () => {
    expect(resolveAsrMode(c.engine, c.asrMode)).toBe(c.expected);
  });
}

test('content-ns.js SK.resolveAsrMode 內容跟 spec inline 邏輯一致', () => {
  const src = fs.readFileSync('shinkansen/content-ns.js', 'utf8');
  const m = src.match(/SK\.resolveAsrMode\s*=\s*function\s+resolveAsrMode\s*\(engine,\s*asrMode\)\s*\{([\s\S]*?)\n  \};/);
  expect(m, 'content-ns.js 找不到 SK.resolveAsrMode 定義').toBeTruthy();

  const nsBody = m[1].replace(/\s+/g, ' ').trim();
  const inlineSrc = resolveAsrMode.toString();
  const inlineBody = inlineSrc.slice(inlineSrc.indexOf('{') + 1, inlineSrc.lastIndexOf('}'))
    .replace(/\s+/g, ' ').trim();

  expect(nsBody).toBe(inlineBody);
});

test('content-youtube.js 的 asrMode 取值走 SK.resolveAsrMode(不再 inline fallback)', () => {
  const src = fs.readFileSync('shinkansen/content-youtube.js', 'utf8');
  expect(src).toMatch(/const asrMode = SK\.resolveAsrMode\(\s*config\.engine\s*,\s*config\.asrMode\s*\)/);
  // 舊 inline 寫法不得殘留(防止改回去繞過 google 強制)
  expect(src).not.toMatch(/config\.asrMode \|\| 'progressive'/);
});
