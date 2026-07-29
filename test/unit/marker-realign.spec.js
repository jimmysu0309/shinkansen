// Unit test: realignByMarkers 序號標記二次對齊(v2.0.69)。
//
// 背景:實測 gemini-3.5-flash-lite 會偶發性吃掉段落間的 <<<SHINKANSEN_SEP>>>(把相鄰
// 兩段合併輸出),SEP split 段數 < 預期 → 原本直接走 per-segment fallback:整批已付費
// 譯文丟棄 + 每段再各打一次 API,費用近雙倍、延遲大增。對照組同頁 gemini-3.1-flash-lite
// 與 gemini-3.6-flash 零 mismatch——模型層行為。合併時「段首的 «N» 序號標記都還在」
//(偶帶「«2 »」空格變體),所以段數不符時先用序號標記當第二對齊錨點重新切割,全部
// 條件成立才採用:marker 數 === 預期段數、序列嚴格 1..N、第一個 marker 前只有空白。
//
// 影響:lib/gemini.js translateChunk(非串流)+ translateBatchStream(串流,流結束後
// realign + 補發錯位段)+ lib/openai-compat.js translateChunk(COMPACT / STRONG 雙 marker)。
//
// SANITY 紀錄(已驗證):把 realignByMarkers 開頭改成 `return null`(模擬修法失效)→
// case 1 / 2 / 7 / 8 / 10 fail(expect received null)→ 還原 → 10 passed。
import { test, expect } from '@playwright/test';
import { DELIMITER, realignByMarkers, MARKER_COMPACT, MARKER_STRONG } from '../../shinkansen/lib/system-instruction.js';

test('case 1: 模型吃掉中間一個 SEP(實測主場景)→ 用 «N» 對齊回 4 段', () => {
  const text = `«1» 譯文一${DELIMITER}«2» 譯文二 «3» 譯文三${DELIMITER}«4» 譯文四`;
  expect(realignByMarkers(text, 4, MARKER_COMPACT)).toEqual(['譯文一', '譯文二', '譯文三', '譯文四']);
});

test('case 2: 「«2 »」marker 內帶空格變體(gemini-3.5-flash-lite 實測吐過)→ 仍對齊', () => {
  const text = `«1» 譯文一${DELIMITER}«2 » 譯文二 «3» 譯文三`;
  expect(realignByMarkers(text, 3, MARKER_COMPACT)).toEqual(['譯文一', '譯文二', '譯文三']);
});

test('case 3: marker 缺一個(序列不完整)→ null 走 fallback', () => {
  const text = `«1» 譯文一${DELIMITER}譯文二 «3» 譯文三`;
  expect(realignByMarkers(text, 3, MARKER_COMPACT)).toBeNull();
});

test('case 4: 譯文內文多出偶然的 «數字»(超量 / 序列破壞)→ null 走 fallback', () => {
  const text = `«1» 內文有 «5» 引號${DELIMITER}«2» 二`;
  expect(realignByMarkers(text, 2, MARKER_COMPACT)).toBeNull();
});

test('case 5: 第一個 marker 前有開場白雜訊 → null 走 fallback(marker 位置不可信)', () => {
  const text = '好的,以下是翻譯 «1» 一 «2» 二';
  expect(realignByMarkers(text, 2, MARKER_COMPACT)).toBeNull();
});

test('case 6: 序號重複(«2» 出現兩次)→ null 走 fallback', () => {
  const text = `«1» 一${DELIMITER}«2» 二 «2» 三`;
  expect(realignByMarkers(text, 3, MARKER_COMPACT)).toBeNull();
});

test('case 7: MARKER_STRONG(OpenAI-compat 預設)同樣可對齊', () => {
  const text = '<<<SHINKANSEN_SEG-1>>> 一 <<<SHINKANSEN_SEG-2>>> 二';
  expect(realignByMarkers(text, 2, MARKER_STRONG)).toEqual(['一', '二']);
});

test('case 8: 段尾殘留的 SEP token 會被清掉(部分 SEP 有吐、部分被吃)', () => {
  // seg1/seg2 之間 SEP 在、seg2/seg3 之間被吃:切出的 seg1 尾端會殘留 SEP,必須清乾淨
  const text = `«1» 一${DELIMITER}«2» 二 «3» 三`;
  const parts = realignByMarkers(text, 3, MARKER_COMPACT);
  expect(parts).toEqual(['一', '二', '三']);
  for (const p of parts) expect(p).not.toContain('SHINKANSEN_SEP');
});

test('case 9: 單段(expectedCount < 2)不適用 → null(單段有自己的處理路徑)', () => {
  expect(realignByMarkers('«1» 一', 1, MARKER_COMPACT)).toBeNull();
});

test('case 10: 正常對齊輸出也能重切出等價結果(不破壞正常結構)', () => {
  const text = `«1» 一${DELIMITER}«2» 二`;
  expect(realignByMarkers(text, 2, MARKER_COMPACT)).toEqual(['一', '二']);
});
