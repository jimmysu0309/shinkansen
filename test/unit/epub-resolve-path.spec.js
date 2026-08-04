// Unit test: epub-engine resolvePath 對非法 URL escape 的容錯
// (code review 2026-08-03 批次 5 H2)
//
// 原 bug:resolvePath 裸呼叫 decodeURIComponent——href 含裸 `%`(非合法 escape,
// 如 `50%off.xhtml`，手工／劣質轉檔 EPUB 會出現)時 throw URIError，呼叫點
// (parseEpub / parseTocTitles)都沒 try → 一個壞 href 毀整本書 parse，且錯誤碼
// 不是 EpubParseError,UI 只能顯示 generic 錯誤。
// 修法：decode 失敗 fallback 用原字串(zip 內 entry 名若本來就含字面 %,
// 原字串反而是對的查找 key)。
//
// SANITY 紀錄(已驗證，2026-08-04)：暫時把 resolvePath 的 try/catch 拿掉(改回裸
// decodeURIComponent)→ 「裸 % href 不 throw」兩 case fail(URIError)→ 還原 → pass。
import { test, expect } from '@playwright/test';

const { resolvePath } = await import('../../shinkansen/translate-doc/epub-engine.js');

test('H2: 合法 escape 照常 decode(既有行為不變)', () => {
  expect(resolvePath('OEBPS/text', '../images/a%20b.png')).toBe('OEBPS/images/a b.png');
  expect(resolvePath('OEBPS', 'ch1.xhtml#frag')).toBe('OEBPS/ch1.xhtml');
  expect(resolvePath('', 'ch1.xhtml')).toBe('ch1.xhtml');
});

test('H2: 裸 % 的非法 escape 不 throw,fallback 原字串', () => {
  expect(() => resolvePath('OEBPS', '50%off.xhtml')).not.toThrow();
  expect(resolvePath('OEBPS', '50%off.xhtml')).toBe('OEBPS/50%off.xhtml');
});

test('H2: 非法 escape 帶相對路徑與 fragment 仍正常解析', () => {
  expect(resolvePath('OEBPS/text', '../ch%2/50%off.xhtml#sec1')).toBe('OEBPS/ch%2/50%off.xhtml');
});
