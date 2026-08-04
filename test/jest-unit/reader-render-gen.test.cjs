'use strict';

/**
 * code review 2026-08-03 批次 5 G3：renderReader 初始逐頁 render loop 無中止機制。
 *
 * Bug：`destroyed` flag 只在 regenerateTranslatedPdf / retryAllFailed /
 * rerenderRightColumn 檢查；初始 loop 執行期間 handle 尚未 return，caller 拿不到
 * destroy 可呼叫（index.js openReader 的 gen 比對只 destroy「已 return 的 handle」，
 * 對 in-flight 初始 loop 無效）。大 PDF render 可跑 10 秒+，期間 toolbar 已可點——
 * 第二次 openReader 的 `innerHTML = ''` 清欄後，舊輪 resume 繼續 append 它的
 * leftPage/rightPage 進同一欄 → 新舊譯文頁交錯混排；換檔情境舊輪還對已 close 的
 * pdfDoc 逐頁空燒。
 *
 * 修法：module 級 `_renderReaderGen` 世代計數，每次 renderReader 進場 bump；
 * 初始 loop 每頁開頭比對失配 → 自我終止（destroy 自己開的 translatedPdfDoc，
 * return null；caller 的 myGen guard 已保證 null 不踩掉新 handle）。
 *
 * 為什麼是 source 斷言而非行為測試（訊號層次，CLAUDE.md 工作流原則 §3；同
 * bg-partial-usage-accounting 前例）：reader.js import pdfjs vendor mjs，jest cjs
 * 無法 representatively 載入；「兩輪 render 交錯」的時序在 Playwright 下需要
 * 「大 PDF render 慢到可搶點 + 精準第二次 openReader」，不可穩定編排。本 spec 鎖
 * 結構性事實：(1) 世代計數存在且進場 bump、(2) 初始 loop 內有失配檢查、
 * (3) 失配路徑 destroy 自開的 pdfDoc 並 return。真實視覺不交錯由
 * pdf-translate-verify 真翻譯驗收覆蓋。
 *
 * SANITY 紀錄（已驗證，2026-08-04）：暫時把初始 loop 的
 * `if (_myRenderGen !== _renderReaderGen)` 整段刪掉 → (2)(3) 斷言 fail → 還原 → pass。
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../shinkansen/translate-doc/reader.js'),
  'utf-8'
);

describe('G3: renderReader 初始 loop 世代中止', () => {
  test('世代計數存在且 renderReader 進場 bump', () => {
    expect(SRC).toMatch(/\n\s*let _renderReaderGen = 0;/);
    expect(SRC).toMatch(/const _myRenderGen = \+\+_renderReaderGen;/);
  });

  test('初始逐頁 loop 內有世代失配檢查（在 leftPage append 之前）', () => {
    const loopIdx = SRC.indexOf('for (let i = 0; i < pageCount; i++)');
    const checkIdx = SRC.indexOf('if (_myRenderGen !== _renderReaderGen)');
    const appendIdx = SRC.indexOf("leftPage.className = 'reader-page reader-page-original'");
    expect(loopIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeGreaterThan(loopIdx);
    expect(checkIdx).toBeLessThan(appendIdx);
  });

  test('失配路徑 destroy 自開的 translatedPdfDoc 並 return null', () => {
    const checkIdx = SRC.indexOf('if (_myRenderGen !== _renderReaderGen)');
    const block = SRC.slice(checkIdx, checkIdx + 600);
    expect(block).toMatch(/destroyed = true/);
    expect(block).toMatch(/translatedPdfDoc\.destroy\(\)/);
    expect(block).toMatch(/return null;/);
  });
});
