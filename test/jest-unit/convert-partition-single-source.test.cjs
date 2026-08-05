'use strict';

/**
 * 批次 8 B6（code review 2026-08-03）:簡繁分流判準單一資料源 forcing function。
 *
 * 背景:content.js 的實際分流(translateUnits partition)用 `SK.isConvertibleVariant`
 * (放寬版,含中英混排品牌標題),但 batchCount 估算與術語表輸入端(_isConvertible)
 * 原本用 `SK.detectTextLang(t) === 'zh-Hans'/'zh-Hant'` 嚴格版——放寬命中的段落被算進
 * glossary API 輸入(浪費 token)與 batchCount(虛增可能誤觸發 blocking 門檻)。
 * 同一份「哪些段落走本地轉換」事實必須單一判準(工作流原則 §5,附錄 A 鏡像表)。
 *
 * 修法:_isConvertible 改用 `SK.isConvertibleVariant(t, convertDirection)`。
 *
 * 本 spec 為 source 斷言 forcing function:功能行為由
 * test/regression/inject-zh-convert-local.spec.js 的真實路徑 case 覆蓋;這裡鎖
 * 「估算端不再出現嚴格判準的鏡像實作」,防未來改動讓兩端再度 drift。
 *
 * SANITY 紀錄(已驗證,2026-08-05):把 content.js _isConvertible 改回
 *   `preTexts.map(t => SK.detectTextLang(t) === (convertDirection === 'cn2twp' ? 'zh-Hans' : 'zh-Hant'))`
 *   → 兩條斷言 fail → 還原後 pass。
 */

const path = require('path');
const fs = require('fs');

const src = fs.readFileSync(
  path.resolve(__dirname, '../../shinkansen/content.js'),
  'utf-8',
);

// 剝註解,只斷言會執行的 code
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n');

describe('批次 8 B6:簡繁分流判準單一資料源', () => {
  test('估算端 _isConvertible 用 isConvertibleVariant(與分流端同判準)', () => {
    expect(code).toMatch(/_isConvertible = convertDirection\s*\?\s*preTexts\.map\(t => SK\.isConvertibleVariant\(t, convertDirection\)\)/);
  });

  test('content.js 不再有 detectTextLang 嚴格版的分流判準鏡像', () => {
    expect(code).not.toMatch(/detectTextLang\([^)]*\) === \(convertDirection === 'cn2twp'/);
  });
});
