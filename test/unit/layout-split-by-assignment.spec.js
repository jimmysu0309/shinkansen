// Regression: layout-split-by-assignment(批次 8 H5,code review 2026-08-03;
// 清 PENDING_REGRESSION「splitOnSameRow / splitOnLeftShift 正向案例」條目,
// dev tail 2.0.74.1 修的縱向切分規則)
//
// 背景:v2.0.74.1 在 splitColumnIntoBlocks 加了兩條縱向切分規則——
//   splitOnLeftShift:左緣位移 > 6× mlh(置中 / 靠右對齊豁免)→ label 欄行不被
//     吸進 value 欄 list 區塊(Trimble p1-b39 病型)
//   splitOnSameRow:top 幾乎相同(< 0.5× mlh)即切 → 同 visual row 的 cell line
//     不因垂直 gap 為負被縱向串成 franken block(Quotation TDC6 表頭病型)
// 正向案例先前咬不住:synthetic fixture 走 analyzeLayout 時 K-means 欄位偵測會把
// 測試座標分進不同 column → block 本來就分開,斷言分不出是哪條規則切的(假覆蓋)。
//
// 修法(H5):per-column 迴圈抽成 splitIntoBlocksByAssignment(可注入 column
// assignment 的純函式)並 export——spec 手工指定「全部 line 同一 column」,完全繞過
// K-means,切分結果只可能來自 splitColumnIntoBlocks 的規則本身。
//
// 訊號層界定:驗縱向切分規則的正向 / 豁免行為;不驗 detectColumns(K-means)與
// 真實 PDF 端到端(本機 pdf-snapshot 套件扛,Quotation TDC6 / Trimble p1-b39
// baseline 已含新行為)。
//
// SANITY 紀錄(已驗證,2026-08-05):
//   ① 暫時把 splitColumnIntoBlocks 的 `splitOnLeftShift` 併入切分條件處拔掉
//     (splitOnGap || splitOnFont || splitOnSameRow)→ Case 2 fail(1 block)→ 還原 pass。
//   ② 暫時把 `splitOnSameRow` 拔掉 → Case 1 fail(1 block)→ 還原 pass。
//   兩處破壞各自只 fail 自己的 case(Case 3 / 4 對照組兩態皆 pass)= 斷言能分辨
//   是哪條規則在切,不再假覆蓋。
import { test, expect } from '@playwright/test';
import { splitIntoBlocksByAssignment } from '../../shinkansen/translate-doc/layout-analyzer.js';

const MLH = 10; // splitOnGap 閾值 15 / sameRow 閾值 5 / leftShift 閾值 60 / align tol 20

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

// 全部 line 塞同一 column:切分只可能來自 splitColumnIntoBlocks 規則
function splitSingleColumn(lines) {
  return splitIntoBlocksByAssignment(lines, lines.map(() => 0), 1, MLH);
}

test('Case 1(splitOnSameRow 正向): 同 visual row 的兩條 cell line → 各自獨立 block', () => {
  // 同 row 相鄰 cell:top 差 1(< 0.5× mlh = 5),垂直 gap 為負(重疊)。
  // 左緣位移刻意壓在 leftShift 閾值(6× mlh = 60)以下(40),隔離 splitOnSameRow
  // 規則本體——否則兩條規則都會切,SANITY 分不出是誰切的(假覆蓋)
  const lines = [
    mkLine([mkRun('QTY', 40, 0, 30)]),
    mkLine([mkRun('Unit Cost', 80, 1, 30)]),
  ];
  const blocks = splitSingleColumn(lines);
  expect(blocks).toHaveLength(2);
  expect(blocks[0].plainText).toBe('QTY');
  expect(blocks[1].plainText).toBe('Unit Cost');
});

test('Case 2(splitOnLeftShift 正向): 左緣大幅位移的緊鄰行 → 切獨立 block', () => {
  // 行距緊(gap = 2 < 15,不觸發 splitOnGap)、同 fontSize;左緣位移 100(> 60),
  // 中心與右緣也都偏移(> 20,不吃置中 / 靠右豁免)= label 欄行 vs value 欄行
  const lines = [
    mkLine([mkRun('Display label', 40, 0, 200)]),
    mkLine([mkRun('value item text', 140, 12, 200)]),
  ];
  const blocks = splitSingleColumn(lines);
  expect(blocks).toHaveLength(2);
  expect(blocks[0].plainText).toBe('Display label');
  expect(blocks[1].plainText).toBe('value item text');
});

test('Case 3(對照組): 置中對齊的左緣位移 → 豁免不切(同一版面單位)', () => {
  // 左緣位移 70(> 60)但中心點重合(centerDelta = 0 ≤ 20)= 置中排版,不切
  const lines = [
    mkLine([mkRun('Centered Title Line', 40, 0, 200)]),
    mkLine([mkRun('subtitle', 110, 12, 60)]),
  ];
  const blocks = splitSingleColumn(lines);
  expect(blocks).toHaveLength(1);
});

test('Case 4(對照組): 正常縱向流(左緣對齊、行距 ≈ leading)→ 合為一個 block', () => {
  const lines = [
    mkLine([mkRun('first line of paragraph', 40, 0, 200)]),
    mkLine([mkRun('second line of paragraph', 40, 12, 200)]),
    mkLine([mkRun('third line of paragraph', 40, 24, 200)]),
  ];
  const blocks = splitSingleColumn(lines);
  expect(blocks).toHaveLength(1);
  expect(blocks[0].plainText).toContain('first line');
  expect(blocks[0].plainText).toContain('third line');
});
