'use strict';

/**
 * code review 2026-08-03 批次 3 E6：STREAMING_ABORT 在 AbortController 註冊之前
 * 抵達會被丟失。
 *
 * Bug：TRANSLATE_BATCH_STREAM 同步回 ack 後，handleTranslateStream 要先
 *   await getSettings() + cache.getBatch（逐段 sha1）才註冊 AbortController——
 *   abort 落在這個窗口（桌面數十 ms；iOS event page 冷啟更寬）→ 查 map 拿不到 →
 *   回 { aborted:false }，整批照打；content 端 listener 已移除，之後的
 *   STREAMING_DONE 被忽略 → 已付費 usage 既不走 LOG_USAGE 也不走 discard 記帳。
 *
 * 修法：STREAMING_ABORT 對未知 streamId 留 TTL tombstone；handleTranslateStream
 *   在 `new AbortController()` 註冊之前查一次 tombstone，命中即不打 API、推
 *   STREAMING_ABORTED 收尾。
 *
 * 為什麼是 source 斷言而非行為測試（訊號層次，CLAUDE.md 工作流原則 §3；
 * 同 bg-partial-usage-accounting.test.cjs 前例）：
 *   background.js 是 ES module，top-level 大量 side effect + 依賴 browser global，
 *   jest cjs 環境無法 representatively 載入整個 SW；handleTranslateStream 非 export，
 *   且「abort 早到」的窗口時序在 Playwright 真 extension 下不可穩定編排（ack →
 *   getSettings → cache lookup 的耗時不可控）。本 spec 鎖「結構性事實」：
 *   (1) 未知 streamId 有寫 tombstone、(2) tombstone 檢查在 AbortController 註冊
 *   之前、(3) 命中即 return（不往下打 API）、(4) tombstone 有 TTL sweep。
 *   不鎖「真實 race 下 abort 一定攔得住」——那要真 SW 環境。
 *
 * SANITY 紀錄（已驗證，2026-08-04）：暫時把 STREAMING_ABORT handler 的
 *   `abortedStreamTombstones.set(streamId, ...)` 註解掉 → 「未知 streamId 留
 *   tombstone」斷言 fail；把 handleTranslateStream 的 tombstone 檢查段註解掉 →
 *   「檢查在註冊之前」斷言 fail → 還原 → 全 pass。
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../shinkansen/background.js'),
  'utf-8'
);

describe('E6: STREAMING_ABORT 早到 tombstone', () => {
  test('STREAMING_ABORT handler 對未知 streamId 寫入 tombstone（帶 TTL）', () => {
    const handlerStart = SRC.indexOf('STREAMING_ABORT: {');
    expect(handlerStart).toBeGreaterThan(-1);
    const block = SRC.slice(handlerStart, handlerStart + 1500);
    // \n\s* 錨定行首（排除被 // 註解掉的殘影）
    expect(block).toMatch(/\n\s*abortedStreamTombstones\.set\(streamId, Date\.now\(\) \+ ABORT_TOMBSTONE_TTL_MS\)/);
    // 已知 streamId 的既有 abort 行為不變
    expect(block).toMatch(/ac\.abort\(\)/);
    expect(block).toMatch(/return \{ aborted: true \}/);
  });

  test('handleTranslateStream 的 tombstone 檢查在 AbortController 註冊之前', () => {
    const checkMatch = SRC.match(/\n\s*_sweepAbortTombstones\(\);\s*\n\s*if \(abortedStreamTombstones\.has\(streamId\)\)/);
    const registerIdx = SRC.indexOf('inFlightStreams.set(streamId, ac)');
    expect(checkMatch).not.toBeNull(); // tombstone 檢查（非註解行）必須存在
    expect(registerIdx).toBeGreaterThan(-1);
    expect(checkMatch.index).toBeLessThan(registerIdx);
  });

  test('tombstone 命中即 return，不往下打 API；並推 STREAMING_ABORTED 收尾', () => {
    const checkIdx = SRC.indexOf('if (abortedStreamTombstones.has(streamId))');
    const block = SRC.slice(checkIdx, checkIdx + 700);
    expect(block).toMatch(/abortedStreamTombstones\.delete\(streamId\)/);
    expect(block).toMatch(/STREAMING_ABORTED/);
    expect(block).toMatch(/\n\s+return;/);
  });

  test('tombstone 有 TTL sweep（不會無限累積）', () => {
    expect(SRC).toMatch(/function _sweepAbortTombstones\(\)/);
    expect(SRC).toMatch(/const ABORT_TOMBSTONE_TTL_MS = 60_000/);
    // 兩個入口都 sweep：abort handler 寫入前 + handleTranslateStream 檢查前
    const sweepCalls = SRC.match(/_sweepAbortTombstones\(\);/g) || [];
    expect(sweepCalls.length).toBeGreaterThanOrEqual(2);
  });
});
