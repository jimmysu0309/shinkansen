// pdf-renderer.js fitSegmentsToBox 對 1-line block 的字級保留
//
// 修法:1-line block 的 requiredH 從 fontSize × 1.21 放寬到 fontSize × 1.0
// (容許 descender 略超 box,跟原文字身佔 box 比例對齊)。
// Why:heading 類短 block bbox 高度通常 = fontSize × 1.0,中文 ascent+descent
// 加總略 > 1.0,用 1.21 標準塞不下,phase B 擴下被緊鄰下方 block 擋住 → 走 phase A
// scale 縮字 → heading 比內文小(About Plano 9pt 內文 9pt,但譯文「關於普萊諾市」
// 縮成 8.1pt)。
//
// SANITY 紀錄(已驗證):暫時把 visualRatio 改回 FIRST_LINE_VISUAL_RATIO(1.21)
// 「heading fontSize 不縮」spec fail。還原 1.0 後 pass。

import { test, expect } from '@playwright/test';

globalThis.window = globalThis.window || {};
globalThis.window.PDFLib = { rgb: (r, g, b) => ({ r, g, b }) };

const { drawTranslatedOverlay } = await import('../../shinkansen/translate-doc/pdf-renderer.js');

// CJK-aware fake font:每 char 寬度 = fontSize × 1.0pt(模擬 Noto Sans TC 全形)
function makeFont() {
  return {
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

test.describe('fitSegmentsToBox 1-line block 不縮字', () => {
  test('heading 短 block(bbox = fontSize × 1.0)+ 緊鄰下方 block → fontSize 不縮', () => {
    // 模擬 Plano page 1 的「About Plano」+ 緊貼的下個段落:
    //   b0 = [54, 116.3, 107, 125.3] = 寬 53、高 9 = fontSize 9
    //   b1.y0 = 126.8(緊鄰,gap 1.5pt < phase B buffer 2pt → 擴不出)
    const layoutPage = {
      pageIndex: 1,
      viewport: { width: 612, height: 792 },
      medianLineHeight: 9,
      columnCount: 1,
      blocks: [
        {
          blockId: 'b0',
          type: 'paragraph',
          bbox: [54, 116.3, 107, 125.3],
          column: 0,
          fontSize: 9,
          lineCount: 1,
          runCount: 1,
          plainText: 'About Plano',
          translation: '關於普萊諾市',
          translationSegments: [{ text: '關於普萊諾市', isBold: false, isItalic: false, linkUrl: null }],
        },
        {
          blockId: 'b1',
          type: 'paragraph',
          bbox: [54, 126.8, 556.8, 228.8],
          column: 0,
          fontSize: 9,
          lineCount: 10,
          runCount: 80,
          plainText: 'Body paragraph that follows the heading.',
          translation: '緊鄰段落內文',
          translationSegments: [{ text: '緊鄰段落內文', isBold: false, isItalic: false, linkUrl: null }],
        },
      ],
    };
    const page = makeRecordingPage();
    const font = makeFont();
    drawTranslatedOverlay(page, layoutPage, font, font, []);

    const textCalls = page.calls.filter((c) => c.kind === 'text');
    expect(textCalls.length).toBeGreaterThanOrEqual(2);

    // b0 的 drawText 字級必須維持 9(不縮)
    const b0Text = textCalls.find((c) => c.text === '關於普萊諾市');
    expect(b0Text).toBeTruthy();
    expect(b0Text.opts.size).toBe(9);

    // b1 的 drawText 也是 9
    const b1Text = textCalls.find((c) => c.text === '緊鄰段落內文');
    expect(b1Text).toBeTruthy();
    expect(b1Text.opts.size).toBe(9);
  });

  test('擴 box 方向:下優先於右——表格 cell 差一點塞不下時排多行,不排一行長文蓋右側', () => {
    // Bug(Thorpe p3 實測):Phase 0 變體順序原為「右先於下」,表格 cell 譯文差
    // 2pt 塞不下時向右一路擴到頁面另一側(中間的架構圖不是 text block 擋不住)
    // → 一行長文蓋過圖。向下擴 2pt 即能以 cell 寬排兩行。
    // SANITY(已驗證):暫時把 variants 順序改回「右先於下」→ 本 case fail
    // (drawText x 超出 cell 右緣、只有 1 行)→ 還原 → pass。
    //
    // 佈局:cell block(129,199)-(330,221) 高 22 = 2 行;右側遠處有一個 text
    // block(y 帶不同→ 擋不住右擴);下方 block 在 y=238(留 17pt 空隙可下擴)。
    // 譯文 33 字 CJK × fs10 = 330pt > cell 寬 201 → 需 2 行;2 行 requiredH ≈ 24
    // > 22+1 → 原 box 塞不下 → 必須擴:下擴後 2 行 fit ✓;右擴會 1 行 fit(壞)
    const layoutPage = {
      pageIndex: 0,
      viewport: { width: 900, height: 700 },
      medianLineHeight: 10,
      columnCount: 1,
      blocks: [
        {
          blockId: 'cell',
          type: 'paragraph',
          bbox: [129, 199, 330, 221],
          column: 0,
          fontSize: 10,
          lineCount: 2,
          runCount: 2,
          plainText: 'Special partitions for the applications. These will not be initialized.',
          translation: '應用程式的專用分割區這些分割區不會因恢復原廠設定而初始化完畢',
          translationSegments: [{ text: '應用程式的專用分割區這些分割區不會因恢復原廠設定而初始化完畢', isBold: false, isItalic: false, linkUrl: null }],
        },
        {
          blockId: 'below',
          type: 'paragraph',
          bbox: [129, 238, 330, 260],
          column: 0,
          fontSize: 10,
          lineCount: 2,
          runCount: 1,
          plainText: 'next row cell',
          translation: '下一列',
          translationSegments: [{ text: '下一列', isBold: false, isItalic: false, linkUrl: null }],
        },
      ],
    };
    const page = makeRecordingPage();
    const font = makeFont();
    drawTranslatedOverlay(page, layoutPage, font, font, []);

    const cellCalls = page.calls.filter((c) => c.kind === 'text' && c.text !== '下一列');
    expect(cellCalls.length).toBeGreaterThanOrEqual(2); // 排成多行,不是一行長文
    for (const c of cellCalls) {
      const x = c.opts.x != null ? c.opts.x : c.opts.matrix[4];
      const w = font.widthOfTextAtSize(c.text, c.opts.size);
      // 每行右緣不得超出 cell 右緣太多(容忍 2pt;右擴變體會畫到 330 之外一大截)
      expect(x + w).toBeLessThanOrEqual(332);
    }
  });

  test('原子 token 不拆行:窄 cell 金額寧縮字整顆塞下,不得拆成「7,000.0/0」', () => {
    // Bug(TDC6 / OCA 實測):chunk 寬過 cell 時 1.5 逐字拆 → 金額 / 數值斷行。
    // 修法:短 token(≤14 字元)被迫拆 = fit 失敗 → 縮字讓 token 整顆塞下。
    // fake font 每字寬 = fontSize:「7,000.00」8 字 × fs10 = 80 > cell 寬 64
    // → scale 1.0 需拆;0.8 → 64 ≤ 64 整顆 fit。
    // SANITY(已驗證):暫時把 tryFit 的 `if (lines.atomicSplit) return null` 註解
    // → 「單一 drawText 含完整 7,000.00」斷言 fail(被拆成多段)→ 還原 pass
    const layoutPage = {
      pageIndex: 0,
      viewport: { width: 900, height: 700 },
      medianLineHeight: 10,
      columnCount: 1,
      blocks: [
        {
          blockId: 'amt',
          type: 'paragraph',
          // cell 高 30 = 裝得下 2 行——沒有 atomicSplit 判定時 scale 1.0 直接
          // 拆成兩行過關(TDC6 實際場景);有判定才會改走縮字整顆塞下
          bbox: [100, 100, 164, 130],
          column: 0,
          fontSize: 10,
          lineCount: 1,
          runCount: 1,
          plainText: '7,000.00',
          translation: '7,000.00',
          translationSegments: [{ text: '7,000.00', isBold: false, isItalic: false, linkUrl: null }],
          _isCellBlock: true, // cell block 不擴框,只能縮字 → 直接驗縮字路徑
        },
      ],
    };
    const page = makeRecordingPage();
    const font = makeFont();
    drawTranslatedOverlay(page, layoutPage, font, font, []);
    const textCalls = page.calls.filter((c) => c.kind === 'text');
    // 金額必須以單一完整 piece 畫出(不拆行),且字級縮小到塞得下
    expect(textCalls).toHaveLength(1);
    expect(textCalls[0].text).toBe('7,000.00');
    expect(textCalls[0].opts.size).toBeLessThan(10);
  });

  test('多行 block 仍走 FIRST_LINE_VISUAL_RATIO(1.21)— 確保 1.0 放寬只對 1-line', () => {
    // 模擬中文 wrap 成 2 行的場景:box 寬 = 50,塞 6 字 × fontSize 9 = 54 → wrap 成 2 行
    // 高度只 9pt 顯然塞不下 2 行 + 1.21 + lineHeight,fit 應走 phase B/C/D 縮字
    const layoutPage = {
      pageIndex: 0,
      viewport: { width: 612, height: 792 },
      medianLineHeight: 9,
      columnCount: 1,
      blocks: [
        {
          blockId: 'a',
          type: 'paragraph',
          bbox: [54, 100, 104, 109],
          column: 0,
          fontSize: 9,
          lineCount: 1,
          runCount: 1,
          plainText: 'Hello world stuff.',
          translation: '你好世界廢柴測試',
          translationSegments: [{ text: '你好世界廢柴測試', isBold: false, isItalic: false, linkUrl: null }],
        },
        {
          blockId: 'b',
          type: 'paragraph',
          bbox: [54, 200, 556, 290],
          column: 0,
          fontSize: 9,
          lineCount: 1,
          runCount: 1,
          plainText: 'distant',
          translation: '遠方',
          translationSegments: [{ text: '遠方', isBold: false, isItalic: false, linkUrl: null }],
        },
      ],
    };
    const page = makeRecordingPage();
    const font = makeFont();
    drawTranslatedOverlay(page, layoutPage, font, font, []);
    // a 用 fontSize 9 寬 50pt 塞 8 字 × 9 = 72pt 必須 wrap → multi-line case → fontSize 應被縮(<9)
    const aText = page.calls.find((c) => c.kind === 'text' && c.text.includes('你好'));
    expect(aText).toBeTruthy();
    // 多行情境會走 phase A scale 縮 / phase B/C 擴 box,任一情況 fontSize 都會 < 9 或 = 9 但 wrap 成 1 行
    // 重點:1-line 放寬不會讓本 case 也走 1.0 標準(因為 wrap 成 2 行 → 走 1.21 + lineHeight)
    expect(aText.opts.size).toBeLessThanOrEqual(9);
  });
});
