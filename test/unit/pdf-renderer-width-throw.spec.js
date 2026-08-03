// Regression: pdf-renderer-width-throw（對應 v2.0.77 修的「Pass 2 widthOfTextAtSize
// 未包 try/catch,罕見字元讓整份譯文 PDF 生成炸掉」bug——CODE-REVIEW-2026-08-03 H1）
//
// Bug：drawTranslatedOverlay Pass 2 的 page.drawText 有 try/catch(跳過編不進
//      字型的 piece),緊接的 pieceFont.widthOfTextAtSize 沒有——兩者走同一條
//      fontkit layout 路徑,drawText 會 throw 的輸入 widthOfTextAtSize 幾乎必同樣
//      throw。同檔另外兩處(computeDrawnExtent / wrapSegmentsToWidth 的 widthOf)
//      都有 catch + 字寬估算 fallback,唯獨 Pass 2 漏了。譯文含 Noto Sans TC 無法
//      編碼的字元時,例外從 drawTranslatedOverlay 一路炸出 buildBilingualPdf——
//      此時翻譯已完成、mask 已畫,使用者只拿到錯誤。
// 修法：比照 computeDrawnExtent,catch 後用 piece.text.length * fontSize * 0.5 估算。
//
// 訊號層：驗 drawTranslatedOverlay 對「widthOfTextAtSize 必 throw 的字型」不炸;
// 不驗真實 fontkit 對哪些字元 throw(平台行為)與譯文 PDF 視覺(靠 pdf-translate-verify
// 流程真翻譯 Read PDF 驗收)。
//
// Mock 策略：stub font 的 widthOfTextAtSize 一律 throw(重現「編不進字型的 piece」
// 的最壞形態);page 為記錄用 no-op stub;window.PDFLib.rgb 最小 stub。
//
// SANITY 紀錄（已驗證 2026-08-03）：pdf-renderer.js Pass 2 的
// `try { pieceWidth = ... } catch { ... }` 暫改回裸
// `const pieceWidth = pieceFont.widthOfTextAtSize(piece.text, fontSize)` →
// 「不應 throw」斷言 fail(收到 'glyph not encodable') → 還原後 pass。
import { test, expect } from '@playwright/test';

// pdf-renderer 依賴 window.PDFLib(extension 頁由 <script src> 載 vendor UMD)。
// MERGE mode:不覆蓋既有 globalThis.window(workers=1 跨 spec 共享)
if (!globalThis.window) globalThis.window = {};
if (!globalThis.window.PDFLib) globalThis.window.PDFLib = {};
if (!globalThis.window.PDFLib.rgb) globalThis.window.PDFLib.rgb = (r, g, b) => ({ r, g, b });

const { drawTranslatedOverlay } = await import('../../shinkansen/translate-doc/pdf-renderer.js');

// widthOfTextAtSize 一律 throw 的 stub 字型(重現 fontkit 對編不進字型的輸入的行為)
const throwingFont = {
  widthOfTextAtSize() { throw new Error('glyph not encodable'); },
  heightAtSize() { return 12; },
};

function makePageStub() {
  const calls = { drawText: 0, drawRectangle: 0, drawLine: 0 };
  return {
    calls,
    drawText() { calls.drawText++; },
    drawRectangle() { calls.drawRectangle++; },
    drawLine() { calls.drawLine++; },
  };
}

const layoutPage = {
  viewport: { width: 600, height: 800 },
  blocks: [
    {
      type: 'paragraph',
      translation: '這是一段測試譯文,長度足以觸發 wrap 與逐 piece 渲染的路徑。',
      translationSegments: [
        { text: '這是一段測試譯文,', isBold: false, isItalic: false, linkUrl: null },
        { text: '含連結 piece 走 underline 路徑', isBold: false, isItalic: false, linkUrl: 'https://example.com/' },
      ],
      bbox: [50, 100, 400, 140],
      fontSize: 12,
    },
  ],
};

test('drawTranslatedOverlay: widthOfTextAtSize 必 throw 的字型不可炸整份 PDF', () => {
  const page = makePageStub();
  let rects;
  expect(() => {
    rects = drawTranslatedOverlay(page, layoutPage, throwingFont, throwingFont, []);
  }, 'Pass 2 對 widthOfTextAtSize throw 應以估算 fallback 兜住').not.toThrow();
  // 仍應回傳 link rect 陣列(fallback 估算寬度,流程走完)
  expect(Array.isArray(rects)).toBe(true);
  // mask(Pass 1)與譯文(Pass 2)都應照畫——例外沒有中斷流程
  expect(page.calls.drawRectangle).toBeGreaterThanOrEqual(1);
  expect(page.calls.drawText).toBeGreaterThanOrEqual(1);
});
