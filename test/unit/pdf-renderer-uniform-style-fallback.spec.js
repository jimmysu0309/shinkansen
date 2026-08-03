// pdf-renderer.js drawTranslatedOverlay 對「整塊同 style」block 的樣式繼承
//
// Bug(2026-08-03 structure-verify 揭露):譯文樣式完全依賴 LLM 回傳 ⟦b⟧/⟦i⟧
// marker——模型剝掉 marker / parseMarkedTranslation fallback / 舊資料無
// translationSegments 時,整塊粗體的標題(origBoldRatio=1)被畫成細體。
// 全粗體 / 全斜體 block 的正確樣式其實不需要 marker:原文 styleSegments
// 全部同 (isBold, isItalic) 時,譯文整塊必然同樣式。
//
// 修法(結構性通則):drawTranslatedOverlay 內,block.styleSegments 為 uniform
// 帶樣式(全 bold / 全 italic)且譯文 segments 全無樣式時,譯文 pieces 直接
// 繼承 uniform style。混排 block 不覆蓋(結構上無法推斷對位);譯文帶任一
// bold / italic piece 時視為 marker 有效,不覆蓋。
//
// SANITY 紀錄(已驗證):暫時把 pdf-renderer.js 的 uniform 繼承段改成
// `if (false && uniform && ...)` → Case 1「用 boldFont 畫」、Case 2「舊資料
// fallback 用 boldFont」、Case 5「italic 繼承 matrix」三條 fail(收到
// regular font / 無 matrix),Case 3 / 4 對照組仍 pass → 還原後 5 條全 pass。

import { test, expect } from '@playwright/test';

globalThis.window = globalThis.window || {};
globalThis.window.PDFLib = { rgb: (r, g, b) => ({ r, g, b }) };

const { drawTranslatedOverlay } = await import('../../shinkansen/translate-doc/pdf-renderer.js');

// 兩把可分辨身份的 fake font(每 char 寬 = fontSize,模擬全形)
function makeFont(name) {
  return {
    fontName: name,
    widthOfTextAtSize: (text, fontSize) => text.length * fontSize * 1.0,
  };
}

function makeRecordingPage() {
  const calls = [];
  return {
    drawRectangle: (opts) => calls.push({ kind: 'rect', opts }),
    drawText: (text, opts) => calls.push({ kind: 'text', text, opts }),
    drawLine: (opts) => calls.push({ kind: 'line', opts }),
    node: { addAnnot: () => {} },
    calls,
  };
}

// 單一 block 的 layoutPage 樣板。bbox 高 = fontSize,寬鬆到不觸發 wrap / 縮字
function makePage(block) {
  return {
    pageIndex: 0,
    viewport: { width: 612, height: 792 },
    medianLineHeight: 12,
    columnCount: 1,
    blocks: [block],
  };
}

function baseBlock(overrides) {
  return {
    blockId: 'b0',
    type: 'heading',
    bbox: [54, 100, 400, 112],
    column: 0,
    fontSize: 12,
    lineCount: 1,
    runCount: 1,
    plainText: 'Bold Heading',
    translation: '粗體標題',
    ...overrides,
  };
}

test.describe('drawTranslatedOverlay uniform style 繼承', () => {
  test('Case 1: 全粗體 block + 譯文 marker 被剝(segments 全 plain)→ 用 boldFont 畫', () => {
    const fontRegular = makeFont('regular');
    const fontBold = makeFont('bold');
    const block = baseBlock({
      styleSegments: [{ text: 'Bold Heading', isBold: true, isItalic: false, linkUrl: null }],
      // 模擬 LLM 剝 marker → parseMarkedTranslation 得到全 plain segment
      translationSegments: [{ text: '粗體標題', isBold: false, isItalic: false, linkUrl: null }],
    });
    const page = makeRecordingPage();
    drawTranslatedOverlay(page, makePage(block), fontRegular, fontBold, []);

    const textCall = page.calls.find((c) => c.kind === 'text' && c.text.includes('粗體'));
    expect(textCall).toBeTruthy();
    expect(textCall.opts.font.fontName).toBe('bold');
  });

  test('Case 2: 全粗體 block + 無 translationSegments(舊資料 fallback)→ 用 boldFont 畫', () => {
    const fontRegular = makeFont('regular');
    const fontBold = makeFont('bold');
    const block = baseBlock({
      styleSegments: [{ text: 'Bold Heading', isBold: true, isItalic: false, linkUrl: null }],
      translationSegments: null,
    });
    const page = makeRecordingPage();
    drawTranslatedOverlay(page, makePage(block), fontRegular, fontBold, []);

    const textCall = page.calls.find((c) => c.kind === 'text' && c.text.includes('粗體'));
    expect(textCall).toBeTruthy();
    expect(textCall.opts.font.fontName).toBe('bold');
  });

  test('Case 3(對照): 混排 block + 譯文全 plain → 不覆蓋,維持 regular', () => {
    const fontRegular = makeFont('regular');
    const fontBold = makeFont('bold');
    const block = baseBlock({
      plainText: 'Label: value text',
      translation: '標籤:內文',
      styleSegments: [
        { text: 'Label:', isBold: true, isItalic: false, linkUrl: null },
        { text: ' value text', isBold: false, isItalic: false, linkUrl: null },
      ],
      translationSegments: [{ text: '標籤:內文', isBold: false, isItalic: false, linkUrl: null }],
    });
    const page = makeRecordingPage();
    drawTranslatedOverlay(page, makePage(block), fontRegular, fontBold, []);

    const textCall = page.calls.find((c) => c.kind === 'text' && c.text.includes('標籤'));
    expect(textCall).toBeTruthy();
    expect(textCall.opts.font.fontName).toBe('regular');
  });

  test('Case 4(對照): 譯文帶有效 bold piece → 照譯文 piece 樣式,不整塊覆蓋', () => {
    const fontRegular = makeFont('regular');
    const fontBold = makeFont('bold');
    // 原文全粗,譯文 marker 完整保留:粗 piece + 尾端 plain piece
    // (理論上不會發生「原文全粗、譯文只部分粗」,但 marker 有效時必須尊重譯文)
    const block = baseBlock({
      translation: '粗體標題尾註',
      styleSegments: [{ text: 'Bold Heading', isBold: true, isItalic: false, linkUrl: null }],
      translationSegments: [
        { text: '粗體標題', isBold: true, isItalic: false, linkUrl: null },
        { text: '尾註', isBold: false, isItalic: false, linkUrl: null },
      ],
    });
    const page = makeRecordingPage();
    drawTranslatedOverlay(page, makePage(block), fontRegular, fontBold, []);

    const boldCall = page.calls.find((c) => c.kind === 'text' && c.text === '粗體標題');
    const plainCall = page.calls.find((c) => c.kind === 'text' && c.text === '尾註');
    expect(boldCall).toBeTruthy();
    expect(plainCall).toBeTruthy();
    expect(boldCall.opts.font.fontName).toBe('bold');
    expect(plainCall.opts.font.fontName).toBe('regular');
  });

  test('Case 6: 譯文帶 \\n(LLM 對 bullet list 自加換行)→ 正規化為空格,drawText 不收到 \\n', () => {
    // Bug(Thorpe bullet list 實測):piece 文字帶 \n 時 pdf-lib drawText 內部
    // 再斷一次行往下畫,跟 renderer 的 cy 前進疊加 → 譯文互疊。
    // SANITY(已驗證):暫時拿掉 drawTranslatedOverlay 的 \n 正規化 map →
    // 本 case「無 drawText 收到 \n」斷言 fail → 還原 pass
    const fontRegular = makeFont('regular');
    const fontBold = makeFont('bold');
    const block = baseBlock({
      bbox: [54, 100, 400, 160],
      plainText: '• item one – item two – item three',
      translation: '• 項目一\n– 項目二\n– 項目三',
      translationSegments: [{ text: '• 項目一\n– 項目二\n– 項目三', isBold: false, isItalic: false, linkUrl: null }],
    });
    const page = makeRecordingPage();
    drawTranslatedOverlay(page, makePage(block), fontRegular, fontBold, []);

    const textCalls = page.calls.filter((c) => c.kind === 'text');
    expect(textCalls.length).toBeGreaterThan(0);
    for (const c of textCalls) {
      expect(c.text).not.toContain('\n');
    }
    // 內容沒有因正規化而遺失
    const joined = textCalls.map((c) => c.text).join('');
    expect(joined).toContain('項目一');
    expect(joined).toContain('項目三');
  });

  test('Case 5: 全斜體 block + 譯文 marker 被剝 → 繼承 italic(drawText 走 matrix skew)', () => {
    const fontRegular = makeFont('regular');
    const fontBold = makeFont('bold');
    const block = baseBlock({
      plainText: 'Italic note',
      translation: '斜體附註',
      styleSegments: [{ text: 'Italic note', isBold: false, isItalic: true, linkUrl: null }],
      translationSegments: [{ text: '斜體附註', isBold: false, isItalic: false, linkUrl: null }],
    });
    const page = makeRecordingPage();
    drawTranslatedOverlay(page, makePage(block), fontRegular, fontBold, []);

    const textCall = page.calls.find((c) => c.kind === 'text' && c.text.includes('斜體'));
    expect(textCall).toBeTruthy();
    // italic piece 走 matrix skew(matrix[2] = tan(12°) ≈ 0.2126),非 italic 走 opts.x/y
    expect(Array.isArray(textCall.opts.matrix)).toBe(true);
    expect(textCall.opts.matrix[2]).toBeGreaterThan(0.2);
    // 全斜體(非粗)仍用 regular 字型
    expect(textCall.opts.font.fontName).toBe('regular');
  });
});
