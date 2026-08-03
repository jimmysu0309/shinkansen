// Regression: layout-wrap-fragment-merge（對應 dev tail 2.0.74.1 的 6.6
// mergeWrapFragments——格線表格描述 cell 跨行句子被插斷後的幾何配對再合併）
//
// Bug：表格描述 cell 的 wrap 句子(Thorpe p3「Special partitions … These /
// partitions will not be initialized …」)被「垂直置中的 row 序號 cell」插在
// 行序列中間,sameRow / leftShift 在序號兩側切開 → 描述行各自成塊,句子在
// 行界斷開送翻,譯文於行界斷句。
//
// 修法：post-pass 以幾何配對(同欄、gap < 1.5× mlh、左緣對齊、x-overlap ≥ 70%、
// fontSize 相近)+ 語意訊號(head ≥ 4 詞 prose 形狀;tail 小寫開頭 ≥ 2 詞、
// 非 label-shape、不含 '://')把續行接回。不靠序列相鄰——序號 cell x-range
// 與描述欄不重疊,天然不擋配對。
// head 詞數 guard 的反例依據:Würth 687 header box 的 form label 小寫開頭
// (「your sales agent:」),行距同樣緊、左緣同樣齊,曾把「10/22/2014」+
// 「your sales agent:」誤併——日期 / 人名 / 短 label 都 < 4 詞,靠詞數排除。
//
// SANITY 紀錄（已驗證）：暫時把 mergeWrapFragments 改成直接 return blocks →
// Case 1「續行接回」與 Case 6「三行連鎖接回」fail(仍是分開的塊)→ 還原 →
// 全 pass。反向 case(2-5)在破壞態照樣 pass(它們斷言「不併」)。
import { test, expect } from '@playwright/test';
import { mergeWrapFragments } from '../../shinkansen/translate-doc/layout-analyzer.js';

const MLH = 10;

// 最小 block 物件(mergeWrapFragments 讀 type / plainText / bbox / column /
// fontSize / _lines;merge 走 buildBlockFromLines 需要 _lines 帶 runs)
function blk(plainText, x0, top, w, opts = {}) {
  const h = opts.h || 10;
  const bbox = [x0, top, x0 + w, top + h];
  return {
    type: opts.type || 'paragraph',
    plainText,
    bbox,
    column: opts.column || 0,
    fontSize: opts.fontSize || 10,
    lineCount: 1,
    _lines: [{
      bbox,
      runs: [{ text: plainText, bbox, fontSize: opts.fontSize || 10, fontName: 'f1' }],
      fontSize: opts.fontSize || 10,
      plainText,
      dominantFontName: 'f1',
    }],
  };
}

test.describe('mergeWrapFragments', () => {
  test('Case 1: 描述 cell 續行被序號 cell 插斷 → 幾何配對接回,序號不受影響', () => {
    // 模擬 Thorpe p3:序號 cell「3」垂直置中(top 介於描述兩行之間),
    // x-range(40-46)與描述欄(160-410)不重疊
    const head = blk('Special partitions for the applications. These', 160, 100, 250);
    const num = blk('3', 40, 106, 6);
    const tail = blk('partitions will not be initialized by reset.', 160, 112, 230);
    const out = mergeWrapFragments([head, num, tail], MLH);
    expect(out).toHaveLength(2);
    const mergedBlk = out.find((b) => b.plainText.includes('Special'));
    expect(mergedBlk.plainText).toContain('These partitions will not');
    expect(out.find((b) => b.plainText === '3')).toBeTruthy();
  });

  test('Case 2(反向): tail 是小寫 form label(「your sales agent:」)→ 不併', () => {
    const head = blk('All supplies and services are made exclusively', 40, 100, 300);
    const label = blk('your sales agent:', 40, 112, 110);
    const out = mergeWrapFragments([head, label], MLH);
    expect(out).toHaveLength(2);
  });

  test('Case 3(反向): head 是短內容(日期 / 人名,< 4 詞)→ 不併', () => {
    const date = blk('10/22/2014', 40, 100, 70);
    const cont = blk('weeks after receiving the purchase order', 40, 112, 260);
    const out = mergeWrapFragments([date, cont], MLH);
    expect(out).toHaveLength(2);
  });

  test('Case 4(反向): 表格 row 間距(gap ≥ 1.5× mlh)→ 不併', () => {
    const rowA = blk('Special partitions for the applications. These', 160, 100, 250);
    // gap = 130 - 110 = 20 = 2× mlh > 1.5×
    const rowB = blk('another cell in the next table row entirely', 160, 130, 250);
    const out = mergeWrapFragments([rowA, rowB], MLH);
    expect(out).toHaveLength(2);
  });

  test('Case 5(反向): URL 原子行 → 不併', () => {
    const u1 = blk('see the full datasheet available at source below', 40, 100, 300);
    const u2 = blk('http://example.com/em/datasheet/6871xx14522.pdf', 40, 112, 290);
    const out = mergeWrapFragments([u1, u2], MLH);
    expect(out).toHaveLength(2);
  });

  test('Case 6: 三行 cell 連鎖接回(合併後繼續向下試併)', () => {
    const l1 = blk('After the device and software is stalled, hanged-up or', 160, 100, 300);
    const num = blk('4', 40, 106, 6);
    const l2 = blk('crashed, the device is recovered automatically without', 160, 112, 295);
    const l3 = blk('any manual operation required by field users.', 160, 124, 250);
    const out = mergeWrapFragments([l1, num, l2, l3], MLH);
    expect(out).toHaveLength(2);
    const mergedBlk = out.find((b) => b.plainText.includes('After the device'));
    expect(mergedBlk.plainText).toContain('recovered automatically');
    expect(mergedBlk.plainText).toContain('manual operation');
  });
});
