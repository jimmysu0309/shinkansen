'use strict';

/**
 * 批次 8 E7 + E9（code review 2026-08-03）:background.js source 斷言。
 *
 * E7:文件翻譯批次（TRANSLATE_DOC_BATCH*）fetch 逾時放寬到 120s(retry 後 240s+),
 *   遠超 MV3 SW 30s idle 上限——streaming 有 keepalive alarm 續命,doc 批次原本沒有,
 *   SW 可能中途被回收(被 abort 的請求 Google 端照樣計費)。
 *   修法:_withDocBatchKeepAlive wrapper(計數 + 共用 stream keepalive alarm),
 *   兩個 doc handler 都包;idle 判斷同時看 inFlightStreams 與 _inFlightDocBatches。
 *
 * E9:dispatcher sync handler 一 throw 即 uncaught,content 端只收到「message port
 *   closed」而非結構化 errorFields——與 async 分支錯誤協定不對稱。
 *   修法:sync 分支包 try/catch 統一走 onError → errorFields。
 *
 * 為什麼走 source 斷言(比照 streaming-abort-tombstone.test.cjs / reader-render-gen):
 *   - E7 的「SW 被回收」時序 Playwright 編排不出(Chromium 測試環境不回收 SW);
 *     keepalive alarm 註冊本身在既有 streaming spec 已驗過同一顆 alarm。
 *   - E9 需要「sync handler throw」的注入 seam,handler map 是 module 閉包,
 *     為測試開洞不值得——錯誤協定形狀由 bg-error-i18n.test.cjs 另行覆蓋。
 *   斷言全部先剝註解行再匹配(E6 教訓:block comment 會讓 source 斷言假綠)。
 *
 * SANITY 紀錄(已驗證,2026-08-05):
 *   E7:把 TRANSLATE_DOC_BATCH 的 `_withDocBatchKeepAlive(() =>` 包裝拆回直呼 →
 *     「兩個 doc handler 都包 keepalive」case fail(count 2 → 1)→ 還原後 pass。
 *   E9:把 sync 分支 try/catch 拆回裸呼叫 → 「sync 分支包 try/catch」case fail →
 *     還原後 pass。
 */

const path = require('path');
const fs = require('fs');

const src = fs.readFileSync(
  path.resolve(__dirname, '../../shinkansen/background.js'),
  'utf-8',
);

// 剝掉行註解與 block comment,只對「會執行的 code」斷言
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n');

describe('批次 8 E7:doc 批次 keepalive', () => {
  test('_withDocBatchKeepAlive wrapper 存在:計數 + start + finally 釋放', () => {
    expect(code).toMatch(/let _inFlightDocBatches = 0;/);
    const fnMatch = code.match(/async function _withDocBatchKeepAlive\(fn\) \{[\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    const fn = fnMatch[0];
    expect(fn).toContain('_inFlightDocBatches++');
    expect(fn).toContain('_startStreamKeepAlive()');
    expect(fn).toContain('finally');
    expect(fn).toContain('_inFlightDocBatches--');
    expect(fn).toContain('_stopStreamKeepAliveIfIdle()');
  });

  test('兩個 doc handler（gemini + custom）都包 _withDocBatchKeepAlive', () => {
    const count = (code.match(/return _withDocBatchKeepAlive\(\(\) =>/g) || []).length;
    expect(count).toBe(2);
    // 包的對象確實是兩條 doc 翻譯主呼叫
    expect(code).toMatch(/_withDocBatchKeepAlive\(\(\) =>\s*handleTranslate\(payload, sender, overrides, null, '_doc'/);
    expect(code).toMatch(/_withDocBatchKeepAlive\(\(\) =>\s*handleTranslateCustom\(payload, sender, '_oc_doc'/);
  });

  test('keepalive idle 判斷同時看 streams 與 doc 批次計數（stop + alarm handler 兩處）', () => {
    const count = (code.match(/inFlightStreams\.size === 0 && _inFlightDocBatches === 0/g) || []).length;
    expect(count).toBe(2);
  });
});

describe('批次 8 E9:dispatcher sync handler 錯誤協定', () => {
  // 取 onMessage dispatcher 區塊（從 addListener 到 sync 分支 return false）
  const dispatcherMatch = code.match(
    /browser\.runtime\.onMessage\.addListener\(\(message, sender, sendResponse\) => \{[\s\S]*?\n\}\);/,
  );

  test('dispatcher 存在且 sync 分支包 try/catch 走 onError', () => {
    expect(dispatcherMatch).not.toBeNull();
    const d = dispatcherMatch[0];
    expect(d).toMatch(/const onError = \(err\) => \{/);
    // sync 分支:try { const result = entry.handler(...) } catch → onError
    expect(d).toMatch(/try \{\s*const result = entry\.handler\(message\.payload, sender\);[\s\S]*?\} catch \(err\) \{\s*onError\(err\);/);
    // onError 走 errorFields 結構化協定(與 async 分支同一條)
    expect(d).toMatch(/sendResponse\(\{ ok: false, \.\.\.errorFields\(err\) \}\)/);
  });

  test('async handler 同步段 throw 也被攔（Promise.resolve 包裝 + catch）', () => {
    const d = dispatcherMatch[0];
    expect(d).toMatch(/p = Promise\.resolve\(entry\.handler\(message\.payload, sender\)\);/);
  });
});
