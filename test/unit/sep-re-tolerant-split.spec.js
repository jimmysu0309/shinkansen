// Unit test: SEP_RE 容忍 Gemini Flash Lite 吃掉 DELIMITER 兩側 `\n` 的回應變體(v1.9.22)。
//
// 背景:Chrome for Claude 實測 Gemini Flash Lite 在小批次(BATCH=2/3/4)場景下,~46%
// 的回應把 DELIMITER (`\n<<<SHINKANSEN_SEP>>>\n`) 兩側的換行吃掉,還原成:
//   - `<<<SHINKANSEN_SEP>>>`  (無空白)
//   - ` <<<SHINKANSEN_SEP>>> ` (空格替代)
//   - 等變體
// 嚴格 `text.split(DELIMITER)` 找不到匹配 → parts.length===1 → segment count mismatch
// → 觸發 per-segment fallback(N 個 sequential API call,慢 ~5x)。
//
// 修法:`SEP_RE = /\s*<<<SHINKANSEN_SEP>>>\s*/` 兩側 `\s*`(0 個以上空白)。
//
// 影響:lib/gemini.js × 4 split 點 + lib/openai-compat.js × 1 split 點 全改用 SEP_RE。
//
// SANITY:把 SEP_RE 改回精確 `/\n<<<SHINKANSEN_SEP>>>\n/` → cases 2-5 fail。
// SANITY 紀錄(v2.0.70 case 8,已驗證 2026-07-30):把 SEP_RE 的 `i` flag 拔掉 →
// case 8 fail(toHaveLength(3) 收到 1)→ 還原 → 21 passed。

import { test, expect } from '@playwright/test';
import { DELIMITER, SEP_RE } from '../../shinkansen/lib/system-instruction.js';

test('case 1: 嚴格 DELIMITER 仍能切(向後相容)', () => {
  const text = `«1» 譯文一${DELIMITER}«2» 譯文二${DELIMITER}«3» 譯文三`;
  const parts = text.split(SEP_RE);
  expect(parts).toHaveLength(3);
  expect(parts[0]).toBe('«1» 譯文一');
  expect(parts[1]).toBe('«2» 譯文二');
  expect(parts[2]).toBe('«3» 譯文三');
});

test('case 2: Gemini 吃掉前後 \\n(實測常見) → 仍能切', () => {
  const text = '«1» 譯文一<<<SHINKANSEN_SEP>>>«2» 譯文二<<<SHINKANSEN_SEP>>>«3» 譯文三';
  const parts = text.split(SEP_RE);
  expect(parts).toHaveLength(3);
  expect(parts[0]).toBe('«1» 譯文一');
  expect(parts[1]).toBe('«2» 譯文二');
  expect(parts[2]).toBe('«3» 譯文三');
});

test('case 3: 空格替代換行 → 仍能切', () => {
  const text = '«1» 譯文一 <<<SHINKANSEN_SEP>>> «2» 譯文二';
  const parts = text.split(SEP_RE);
  expect(parts).toHaveLength(2);
  expect(parts[0]).toBe('«1» 譯文一');
  expect(parts[1]).toBe('«2» 譯文二');
});

test('case 4: 多重空白變體 → 仍能切', () => {
  const text = '«1» 譯文一\n\n  \t<<<SHINKANSEN_SEP>>>\r\n  «2» 譯文二';
  const parts = text.split(SEP_RE);
  expect(parts).toHaveLength(2);
  expect(parts[0]).toBe('«1» 譯文一');
  expect(parts[1]).toBe('«2» 譯文二');
});

test('case 5: 只有單側有換行 → 仍能切(Gemini 偶爾只吃一邊)', () => {
  const text1 = '«1» 譯文一\n<<<SHINKANSEN_SEP>>>«2» 譯文二';
  expect(text1.split(SEP_RE)).toEqual(['«1» 譯文一', '«2» 譯文二']);
  const text2 = '«1» 譯文一<<<SHINKANSEN_SEP>>>\n«2» 譯文二';
  expect(text2.split(SEP_RE)).toEqual(['«1» 譯文一', '«2» 譯文二']);
});

test('case 6: 沒 SEP token → 只回單段(現狀,單句翻譯 / fallback 路徑)', () => {
  const text = '«1» 整段譯文沒有 SEP';
  const parts = text.split(SEP_RE);
  expect(parts).toHaveLength(1);
  expect(parts[0]).toBe('«1» 整段譯文沒有 SEP');
});

test('case 7: 譯文內含 <<<SHINKANSEN_SEP>>> 的小機率風險(已被 sanitizeTermText / system prompt 防護)', () => {
  // sanitize 阻止使用者輸入 / glossary 含此 token,Gemini 自己吐出來的機率極低
  // 但仍要驗證:若譯文內真有此 token,split 會切 → fallback 路徑會處理
  const text = '«1» 假設譯文內有<<<SHINKANSEN_SEP>>>token<<<SHINKANSEN_SEP>>>«2» 第二段';
  const parts = text.split(SEP_RE);
  expect(parts).toHaveLength(3);
  // 不會吐到任何下游(三段分量錯誤 → fallback per-segment 重翻)
});

test('case 8: 模型改寫 token 大小寫(<<<SHINKansen_SEP>>>,gemini-3.5-flash-lite 實測)→ 仍能切', () => {
  // v2.0.70:persisted ring 2026-07-30 stuff.tv 批次實測——40 段中一個 SEP 被改寫成
  // <<<SHINKansen_SEP>>>,case-sensitive split 漏切 → 39≠40 mismatch,且 mangled token
  // 逃過下游所有清理漏進 DOM / 快取。SEP_RE 加 `i` flag 後 split 直接吃掉大小寫變體。
  const text = '«1» 譯文一\n<<<SHINKansen_SEP>>>\n«2» 譯文二\n<<<shinkansen_sep>>>\n«3» 譯文三';
  const parts = text.split(SEP_RE);
  expect(parts).toHaveLength(3);
  expect(parts[0]).toBe('«1» 譯文一');
  expect(parts[1]).toBe('«2» 譯文二');
  expect(parts[2]).toBe('«3» 譯文三');
});
