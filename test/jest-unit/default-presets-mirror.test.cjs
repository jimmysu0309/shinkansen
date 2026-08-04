'use strict';

/**
 * code review 2026-08-03 批次 4 B4：SK.DEFAULT_PRESETS（content-ns.js fallback）與
 * lib/storage.js DEFAULT_SETTINGS.translatePresets 是同一份事實的鏡像雙實作。
 *
 * 原 bug：v1.10.67 把 storage.js 預設對調成 slot 1 = Flash、slot 2 = Flash Lite，
 * content-ns.js fallback 仍是 v1.9.14 的相反順序——註解明寫「必須與 lib/storage.js
 * 保持一致」但兩份完全相反。storage 尚未寫入 translatePresets 的窗口（全新安裝
 * onInstalled 前、升級後未開過 options）按快速鍵／popup 按鈕，實際模型與 UI 顯示
 * 的預設相反。
 *
 * 本 spec 是 forcing function：從兩檔 source 抽出 preset 陣列逐欄比對，任一端改了
 * 另一端沒跟 → fail。content-ns.js 是 IIFE content script、storage.js 是 ES module，
 * jest cjs 下都不 representatively 載入，走 source 解析（同 bg-partial-usage-accounting
 * 前例的訊號層取捨——鎖「兩份字面一致」，不鎖 runtime 行為）。
 *
 * SANITY 紀錄（已驗證，2026-08-04）：暫時把 content-ns.js SK.DEFAULT_PRESETS 的
 * slot 1/2 model 對調回舊值 → 「兩份 preset 陣列必須完全一致」fail → 還原 → pass。
 */

const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.resolve(__dirname, '../../shinkansen', p), 'utf-8');

// 從 source 文字抽出陣列區塊內的 preset objects
function extractPresets(src, blockStartMarker) {
  const start = src.indexOf(blockStartMarker);
  expect(start).toBeGreaterThan(-1);
  const block = src.slice(start, src.indexOf(']', start));
  const re = /\{ slot: (\d+), engine: '([^']+)', model: (null|'[^']*'), label: '([^']*)' \}/g;
  const out = [];
  let m;
  while ((m = re.exec(block)) !== null) {
    out.push({
      slot: Number(m[1]),
      engine: m[2],
      model: m[3] === 'null' ? null : m[3].slice(1, -1),
      label: m[4],
    });
  }
  return out;
}

test('B4: content-ns.js SK.DEFAULT_PRESETS 與 storage.js translatePresets 必須完全一致', () => {
  const nsPresets = extractPresets(read('content-ns.js'), 'SK.DEFAULT_PRESETS = [');
  const storagePresets = extractPresets(read('lib/storage.js'), 'translatePresets: [');
  expect(nsPresets.length).toBe(3);   // 抽取失敗（格式改了）時在這裡爆，不是默默比對空陣列
  expect(storagePresets.length).toBe(3);
  expect(nsPresets).toEqual(storagePresets);
});
