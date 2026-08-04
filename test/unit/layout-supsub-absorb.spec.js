// Unit regression: 上標/下標 run 誤切段落(2026-08-04 code review H4)
//
// Bug(真實 arXiv 論文 probe 重現):散文段落含下標(「(x₁, ..., xₙ)」「position t」
// 「d_model」)時,sup/sub run 的 raised/lowered baseline 讓 top 差超出
// SAME_LINE_Y_TOLERANCE(主字 10pt、下標 7pt,top 差 3-4.5pt)被 groupIntoLines
// 分成獨立 line,下游災難鏈:
//   (a) 主行在下標挪出的水平洞被 stage 2 / splitLinesAtCellGaps 當 cell gap 切開
//   (b) K-means column 偵測按 line left 分群,段中下標 left 落在欄中央被分去
//       獨立 column 自成 block
//   (c) splitOnSameRow / sibling 把段落在下標處句中切碎送翻
//
// 修法(layout-analyzer.js,三處配套、單一常數組):
//   1. residualGapAfterSupFill:groupIntoLines 階段 2 與 splitLinesAtCellGaps 的
//      gap 判定,先扣掉 sup/sub run 填補的部分,殘餘連續空白 ≤ 門檻才豁免
//      (整段豁免會把表格 cell gap 恰有小字標註的相鄰 cell 黏成一行——Stella KPI
//      row / MCS 報表 header 實測)
//   2. absorbSupSubLines(2.3):把 sup/sub 附屬 line 的 runs 併回 host 主行
//      (字級 ≤ 0.75×、垂直中心落在 host span、水平在 host span ± 1×mlh、
//      文字 ≤ 6 字),在 markSiblingsInRow 與 column 偵測之前
//
// 驗的訊號層次:驅動 export 的 analyzeLayout 整條(groupIntoLines → cell split →
// absorb → column → block),斷言 block 結構與 plainText;不驗真 PDF 抽取層
// (pdf-engine)與渲染層(本機 pdf-snapshot 池 + pdf-translate-verify 驗收)。
//
// SANITY 紀錄(已驗證,2026-08-04):
//   ① absorbSupSubLines 開頭暫加 `return lines`(停用吸收)→ case 1「段落應為
//     單一 block」fail(columnCount 2,下標自成 col1 block)。還原 → pass。
//   ② residualGapAfterSupFill 暫改 `return 0`(整段豁免,回到修法中間版)→
//     case 3「cell gap 帶小字標註仍要切」fail(兩 cell 黏成一 line)。還原 → pass。

import { test, expect } from '@playwright/test';
import { analyzeLayout } from '../../shinkansen/translate-doc/layout-analyzer.js';

const R = (text, x0, top, w, h, fs) => ({ text, bbox: [x0, top, x0 + w, top + h], fontSize: fs, fontName: 'f1' });

function analyze(runs, viewport = { width: 612, height: 792 }) {
  const doc = analyzeLayout({
    meta: {},
    pages: [{ pageIndex: 0, viewport, textRuns: runs }],
    stats: {},
    warnings: [],
  });
  return doc.pages[0];
}

test.describe('sup/sub 附屬 run 吸收(review H4)', () => {
  test('case 1: 散文段落含下標 (x_1, ..., x_n) → 單一 block、單 column、下標文字歸位', () => {
    // 仿 arXiv 實測結構:第 2 行帶兩個下標,下標 top 差 4.5(> tolerance 2)、
    // 字高 7 vs 主字 10,x 落在主行挪出的洞
    const runs = [
      R('Most competitive neural sequence transduction models have an encoder-decoder structure.', 108, 666.4, 396, 10, 10),
      R('Here, the encoder maps an input sequence of symbol representations (x', 108, 677.3, 300, 10, 10),
      R(', ..., x', 412, 677.3, 23, 10, 10),
      R(') to a sequence', 440, 677.3, 64, 10, 10),
      R('1', 408, 681.8, 4, 7, 7),
      R('n', 435, 681.8, 5, 7, 7),
      R('of continuous representations z. Given z, the decoder then generates an output', 108, 688.2, 396, 10, 10),
      R('sequence of symbols one element at a time, auto-regressively consuming previous.', 108, 699.1, 396, 10, 10),
    ];
    const page = analyze(runs);
    expect(page.columnCount, '段中下標不得把 column 偵測撐成多欄').toBe(1);
    expect(page.blocks.length, '段落應為單一 block(下標不得自成 block)').toBe(1);
    expect(page.blocks[0].lineCount, '四行段落').toBe(4);
    expect(page.blocks[0].plainText, '下標文字應歸位到主行內').toContain('(x1, ..., xn) to a sequence');
  });

  test('case 2: 主行結尾的行內下標(d_model = 512)不把主行切成兩條', () => {
    // 仿 arXiv p2:下標洞的 gap(21pt)超過 sameLineMaxXGap(2×mlh=20)——
    // 靠 residualGapAfterSupFill 扣掉下標覆蓋後殘餘 ≈ 3pt 才豁免
    const runs = [
      R('All sub-layers in the model, as well as the embedding layers, produce outputs.', 108, 555.2, 396, 10, 10),
      R('layers, produce outputs of dimension d', 108, 566.1, 155, 10, 10),
      R('= 512.', 284, 566.1, 28, 10, 10),
      R('model', 263, 570.6, 18, 7, 7),
    ];
    const page = analyze(runs);
    expect(page.blocks.length, '主行不得在下標洞被切開自成 block').toBe(1);
    expect(page.blocks[0].plainText).toContain('dimension d');
    expect(page.blocks[0].plainText).toContain('model');
    expect(page.blocks[0].plainText).toContain('= 512.');
  });

  test('case 3: 表格 cell gap 帶小字標註(殘餘空白仍超門檻)照常切 cell', () => {
    // 仿 Stella KPI row / MCS header 反例:兩個 KPI cell 之間寬 gap,小字標註
    // 只佔 gap 左角 18pt → 殘餘遠超門檻,不可整段豁免黏成一行。
    // 各 cell 下方帶 label 行(多行結構,4.5e 單行 cell subsplit 兜不到——真實
    // Stella 就是這種 KPI card 形態,豁免太寬時唯一防線就是 residual 判定)
    const runs = [
      R('0.07° x 0.05°', 100, 200, 80, 10, 10),
      R('(V)', 182, 204.5, 18, 7, 7),
      R('120° x 26°', 300, 200, 80, 10, 10),
      R('Angular Resolution', 100, 213, 80, 8, 8),
      R('Field of View', 300, 213, 80, 8, 8),
    ];
    const page = analyze(runs);
    const texts = page.blocks.map((b) => b.plainText);
    expect(
      texts.some((t) => t.includes('0.07°') && t.includes('120°')),
      '相鄰 cell 不得因標註佔 gap 一角被黏成同一 block',
    ).toBe(false);
  });

  test('case 4(負向): 正常相鄰兩行(字高相同)不被吸收', () => {
    const runs = [
      R('First line of a normal paragraph with regular leading and font.', 100, 100, 300, 10, 10),
      R('Second line with identical font size right below.', 100, 111, 300, 10, 10),
    ];
    const page = analyze(runs);
    expect(page.blocks.length).toBe(1);
    expect(page.blocks[0].lineCount, '同字高相鄰行必須維持兩條 line,不可被吸成一條').toBe(2);
  });
});
