// Regression: layout-cell-granularity（對應 v2.0.75 layout-analyzer 四項結構改動）
//
// Bug 全貌（2026-08-03 Trimble / Quotation 系列 probe 實測）：
//   (1) 跨欄同 y 內容被黏成單一 line：SAME_LINE_MAX_X_GAP_FACTOR=4 太寬,
//       label→value gap 23.9pt、雙欄地址 gap 14.5–27.5pt(2.07×–3.9× mlh)全被
//       合併 → 譯文把兩欄內容 collapse 成一串。降到 2 並新增 2.2 line 級 cell
//       split(> 1.2× mlh 即切,form「label: value」與 list marker 豁免)。
//   (2) 縱向誤併:label 欄行(x=40)被吸進 value 欄(x=166)區塊、同 visual row 的
//       cell line 因垂直 gap 為負被縱向串接 → splitOnLeftShift(左緣位移 > 6× mlh,
//       置中 / 靠右對齊豁免)+ splitOnSameRow(top 幾乎相同即切)。
//   (3) 啟發式 'table' block 整塊不送翻譯 → 半頁留原文(Trimble p3)。改成 6.5
//       逐行 explode(重用 cell split)成可翻譯 block,type 重新分類。
//
// SANITY 紀錄（已驗證）：
//   ① 暫時把 splitLinesAtCellGaps 改成直接 return lines → Case 1 fail → 還原 pass。
//   ② 暫時把 6.5 explode 條件改 `if (true || …)`(全部不拆)→ Case 6 fail
//     （synthetic 輸入確認真的會被分類成 table）→ 還原 pass。
//
// 訊號層界定：splitOnSameRow / splitOnLeftShift 的「正向切分」案例在 synthetic
// fixture 咬不住（K-means 欄位偵測會先把測試座標分進不同 column,誰切的分不出來）
// ——Case 4 驗的是「同 row cell 不 collapse」的整合結果,不指定由哪條規則達成;
// 兩條規則的正向覆蓋由本機 pdf-layout-snapshot 套件(真 PDF:Quotation TDC6 表格
// 區 per-cell、Trimble p1-b39 label 不被吸入)扛,見 PENDING_REGRESSION 對應條目。
import { test, expect } from '@playwright/test';
import { splitLinesAtCellGaps, analyzeLayout, maybeSubsplitListBlock } from '../../shinkansen/translate-doc/layout-analyzer.js';

const MLH = 10; // cell gap 閾值 = 10 × 1.2 = 12

function mkRun(text, x0, top, w, h = 10) {
  return { text, bbox: [x0, top, x0 + w, top + h], fontSize: 10, fontName: 'f1' };
}
function mkLine(runs) {
  let bbox = runs[0].bbox.slice();
  for (const r of runs.slice(1)) {
    bbox = [Math.min(bbox[0], r.bbox[0]), Math.min(bbox[1], r.bbox[1]),
      Math.max(bbox[2], r.bbox[2]), Math.max(bbox[3], r.bbox[3])];
  }
  return { runs, bbox, fontSize: 10, dominantFontName: 'f1', plainText: runs.map((r) => r.text).join('') };
}

test.describe('2.2 splitLinesAtCellGaps', () => {
  test('Case 1: 2-run line 帶 cell 級 gap(> 1.2× mlh)→ 切成兩條 line', () => {
    // 模擬 Trimble p1-b20「SD support, expansion capability | microSD slot…」
    // (gap 23.9pt @ mlh 7 = 3.4×;此處 gap 20 @ mlh 10 = 2×)
    const l = mkLine([mkRun('label text', 40, 0, 80), mkRun('value text', 140, 0, 80)]);
    const out = splitLinesAtCellGaps([l], MLH);
    expect(out).toHaveLength(2);
    expect(out[0].plainText).toBe('label text');
    expect(out[1].plainText).toBe('value text');
  });

  test('Case 2: form「label:」+ value 大 gap → 不切(label-shape 豁免)', () => {
    const l = mkLine([mkRun('Shipping Term:', 40, 0, 80), mkRun('FCA TWN', 140, 0, 60)]);
    const out = splitLinesAtCellGaps([l], MLH);
    expect(out).toHaveLength(1);
  });

  test('Case 3: bullet marker + 內文大 gap → 不切(list marker 豁免)', () => {
    // 模擬 Thorpe「•  The following is our brief proposal…」(bullet 後寬間距)
    const l = mkLine([mkRun('•', 40, 0, 6), mkRun('The following is our proposal', 66, 0, 200)]);
    const out = splitLinesAtCellGaps([l], MLH);
    expect(out).toHaveLength(1);
  });

  test('Case 3b: 小 gap(≤ 1.2× mlh)一般文字 → 不切', () => {
    const l = mkLine([mkRun('normal', 40, 0, 50), mkRun('spacing', 98, 0, 50)]); // gap 8 < 12
    const out = splitLinesAtCellGaps([l], MLH);
    expect(out).toHaveLength(1);
  });
});

// ---- analyzeLayout 整合層(synthetic rawDoc) ----

function mkRawDoc(textRuns) {
  return {
    meta: { filename: 't.pdf', pageCount: 1 },
    pages: [{ pageIndex: 0, viewport: { width: 600, height: 800 }, textRuns }],
    stats: {},
    warnings: [],
    pdfDoc: null,
  };
}

test.describe('縱向切分規則 + table explode', () => {
  test('Case 4: 同 visual row 的兩個 cell 不縱向串接,各自成 block', () => {
    // 模擬 Quotation TDC6 表頭:同 row 兩 cell(gap 大被 2.2 切開)+ 下一 row 內容。
    // 無 splitOnSameRow 時「QTY」與「Unit Cost」(頂點相同、垂直 gap 為負)會被
    // 縱向 chain 進同一 block
    // 左緣位移 50pt < 6× mlh(60)刻意不觸發 splitOnLeftShift——本 case 咬的是
    // splitOnSameRow(頂點相同、垂直 gap 為負的縱向串接)
    const runs = [
      mkRun('QTY', 40, 100, 25),
      mkRun('Unit Cost', 90, 100, 60),
      mkRun('1', 45, 118, 6),
      mkRun('52,000.00', 90, 118, 60),
    ];
    const doc = analyzeLayout(mkRawDoc(runs));
    const texts = doc.pages[0].blocks.map((b) => b.plainText);
    // QTY 與 Unit Cost 必須是不同 block(不可 collapse 成「QTYUnit Cost」)
    expect(texts.some((t) => t.includes('QTY') && t.includes('Unit Cost'))).toBe(false);
    expect(texts.some((t) => t === 'QTY' || t.startsWith('QTY'))).toBe(true);
  });

  test('Case 5: 置中兩行 heading(中心點重合、左緣位移大)→ 不被 splitOnLeftShift 切開', () => {
    // 模擬 Plano 置中 heading:line1 全寬、line2 短且置中(左緣位移 150pt,
    // 但中心點重合)。頂行距離正常(12pt)
    const runs = [
      mkRun('Plano Welcomes Electronics Manufacturer', 56, 100, 500),
      mkRun('America Corporation', 231, 112, 150),
    ];
    const doc = analyzeLayout(mkRawDoc(runs));
    const blocks = doc.pages[0].blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lineCount).toBe(2);
  });

  test('Case 6: 分類為 table 的 block 被逐行 explode,輸出不含 table type', () => {
    // 構造會命中 table 啟發式的 block:5 行短內容、左緣交替跳動(delta 30 <
    // 6× mlh=60 不觸發 leftShift、> blockWidth×0.2 觸發 table 判定)、行距緊
    const runs = [
      mkRun('alpha', 40, 100, 30),
      mkRun('beta', 70, 112, 30),
      mkRun('gamma', 40, 124, 30),
      mkRun('delta', 70, 136, 30),
      mkRun('epsilon', 40, 148, 30),
    ];
    const doc = analyzeLayout(mkRawDoc(runs));
    const blocks = doc.pages[0].blocks;
    expect(blocks.every((b) => b.type !== 'table')).toBe(true);
    // 內容全數保留(逐行拆解,不是丟棄)
    const joined = blocks.map((b) => b.plainText).join(' ');
    for (const w of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
      expect(joined).toContain(w);
    }
    // blockId 重新編號連續
    blocks.forEach((b, i) => expect(b.blockId).toBe(`p0-b${i}`));
  });
});

// ---- list subsplit:黏字 marker 與負數行(2026-08-03 LIST_MARKER_RE / ratio 調整) ----
//
// Bug:PDF 抽出的 bullet 行常是「•The following」「–PEGA」黏字形態(marker 與
// 文字 run 間 bbox gap 小於補空白閾值),舊 LIST_MARKER_RE 要求 marker 後有空白
// → marker 全沒認出,整個 bullet list 攤平成單一翻譯單位,sub-bullet 換行結構
// 全失(Thorpe p1 實測)。同輪 LIST_SUBSPLIT_MARKER_RATIO 0.6 → 0.5(bullet 帶
// 1-2 行續行時 marker 行佔比常剛好 50%)。
// dash 守門:「-20 °C」負數溫度行不可被當 marker(dash 後接數字不算)。
//
// SANITY 紀錄(已驗證):暫時把 LIST_MARKER_RE 改回舊版(要求 marker 後 \s)→
// Case 7「黏字 bullet 按 marker 切開」fail(回單一 block)→ 還原 → pass。
// Case 8(負數行對照組)破壞態照樣 pass。
function listLine(text, x0, top, w) {
  const bbox = [x0, top, x0 + w, top + 16];
  return {
    bbox,
    runs: [{ text, bbox, fontSize: 14, fontName: 'f1' }],
    fontSize: 14,
    plainText: text,
    dominantFontName: 'f1',
  };
}
function listBlock(lines) {
  let bbox = lines[0].bbox.slice();
  for (const l of lines.slice(1)) {
    bbox = [Math.min(bbox[0], l.bbox[0]), Math.min(bbox[1], l.bbox[1]),
      Math.max(bbox[2], l.bbox[2]), Math.max(bbox[3], l.bbox[3])];
  }
  return {
    type: 'list-item', bbox, column: 0, fontSize: 14,
    lineCount: lines.length, runCount: lines.length,
    plainText: lines.map((l) => l.plainText).join(' '),
    _lines: lines,
  };
}

test.describe('maybeSubsplitListBlock 黏字 marker', () => {
  test('Case 7: 黏字 bullet(「•The…」「–PEGA…」,marker 行 3/6 = 50%)→ 按 marker 切 3 塊', () => {
    const block = listBlock([
      listLine('•The following is our brief proposal', 46, 100, 500),
      listLine('–PEGA will maintain all source code and related keys', 84, 127, 500),
      listLine('continuation of the second bullet line here', 108, 154, 400),
      listLine('–PEGA will also assist in setting up a server', 84, 181, 480),
      listLine('another continuation line for the third bullet', 108, 208, 400),
      listLine('final continuation of the third bullet item', 108, 235, 380),
    ]);
    const out = maybeSubsplitListBlock(block);
    expect(out).toHaveLength(3);
    expect(out[0].plainText).toContain('The following');
    expect(out[1].plainText).toContain('maintain all source code');
    expect(out[1].plainText).toContain('continuation of the second');
    expect(out[2].plainText).toContain('also assist');
  });

  test('Case 8(對照): 負數溫度行(「-20 °C…」)不被當 marker,不切', () => {
    const block = listBlock([
      listLine('Battery storage temperature ranges are listed', 46, 100, 400),
      listLine('-20 °C to +45 °C 1 month', 46, 127, 200),
      listLine('-20 °C to +35 °C 3 months', 46, 154, 200),
      listLine('-20 °C to +25 °C 12 months', 46, 181, 200),
    ]);
    const out = maybeSubsplitListBlock(block);
    // 首行非 marker(isMarker[0] 前提)→ 整塊不切;負數行也不得被認成 marker
    expect(out).toHaveLength(1);
  });
});

// ---- 6.55 splitRowPairedBlocks:row 配對拆分(2026-08-03) ----
//
// Bug:同左緣、行距緊(< 1.5× mlh)的獨立 label 群縱向切分訊號全缺,被黏成
// 一塊(OCA「短期高溫/長期高溫/長期低溫」+ 值 177/85/-40 各自成塊 → label
// 黏成一團與值錯位)。訊號:每一行在 x 不重疊的側邊有「專屬且互不相同」的
// 單行配對塊 = 表格 row 群,逐行拆開。
//
// SANITY 紀錄(已驗證):暫時把 splitRowPairedBlocks 改成直接 return blocks →
// Case R1 fail(label 群仍一塊)→ 還原 → pass。R2/R3(反向)破壞態照樣 pass。
import { splitRowPairedBlocks } from '../../shinkansen/translate-doc/layout-analyzer.js';

function rpBlock(plainText, lines, opts = {}) {
  let bbox = lines[0].bbox.slice();
  for (const l of lines.slice(1)) {
    bbox = [Math.min(bbox[0], l.bbox[0]), Math.min(bbox[1], l.bbox[1]),
      Math.max(bbox[2], l.bbox[2]), Math.max(bbox[3], l.bbox[3])];
  }
  return {
    type: opts.type || 'paragraph', bbox, column: 0, fontSize: 10,
    lineCount: lines.length, runCount: lines.length, plainText,
    _lines: lines,
  };
}
function rpLine(text, x0, y0, x1, y1) {
  const bbox = [x0, y0, x1, y1];
  return { bbox, runs: [{ text, bbox, fontSize: 10, fontName: 'f1' }], fontSize: 10, plainText: text, dominantFontName: 'f1' };
}
function rpSingle(text, x0, y0, x1, y1) {
  return rpBlock(text, [rpLine(text, x0, y0, x1, y1)]);
}
const RP_CTX = { bodyFontSize: 10, pageWidth: 612, pageHeight: 792 };

test.describe('splitRowPairedBlocks', () => {
  test('R1: 三行 label 群 + 右側三個專屬值塊(OCA 幾何)→ 逐行拆', () => {
    const labels = rpBlock('Short Term High Temperature Long Term High Temperature Long Term Low Temperature', [
      rpLine('Short Term High Temperature', 48, 330, 170, 340),
      rpLine('Long Term High Temperature', 48, 342, 170, 352),
      rpLine('Long Term Low Temperature', 48, 354, 168, 364),
    ]);
    const v1 = rpSingle('177', 192, 330, 207, 340);
    const v2 = rpSingle('85', 192, 342, 202, 352);
    const v3 = rpSingle('-40', 192, 354, 206, 364);
    const out = splitRowPairedBlocks([labels, v1, v2, v3], 10, RP_CTX);
    expect(out).toHaveLength(6);
    expect(out.some((b) => b.plainText === 'Short Term High Temperature')).toBe(true);
    expect(out.some((b) => b.plainText === 'Long Term Low Temperature')).toBe(true);
  });

  test('R2(反向): 垂直置中的共享 partner(Thorpe 序號 cell)→ 不拆', () => {
    const desc = rpBlock('Special partitions for the applications. These partitions will not', [
      rpLine('Special partitions for the applications. These', 129, 199, 330, 209),
      rpLine('partitions will not be initialized by reset.', 129, 211, 320, 221),
    ]);
    // 序號 cell 垂直置中,同時蓋到兩行的 band(共享,非專屬)
    const num = rpSingle('3', 54, 203, 60, 217);
    const out = splitRowPairedBlocks([desc, num], 10, RP_CTX);
    expect(out).toHaveLength(2);
    expect(out.some((b) => b.lineCount === 2)).toBe(true);
  });

  test('R3(反向): 側邊無配對(純段落)→ 不拆', () => {
    const para = rpBlock('first line of prose here second line of prose here', [
      rpLine('first line of prose here', 48, 100, 300, 110),
      rpLine('second line of prose here', 48, 112, 305, 122),
    ]);
    const out = splitRowPairedBlocks([para], 10, RP_CTX);
    expect(out).toHaveLength(1);
    expect(out[0].lineCount).toBe(2);
  });
});
