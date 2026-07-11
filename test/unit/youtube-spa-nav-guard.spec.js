// Unit test: YouTube SPA nav same-videoId guard architecture invariants(v1.8.68)
//
// 對應 PENDING_REGRESSION.md 條目「v1.8.68 同 videoId yt-navigate-finish 假性
// 重 fire 不誤清譯文」。YouTube SPA 在 quality 切換 / ad break 結束 /
// player re-mount / theatre-fullscreen 切換等情境會 fire 假性 yt-navigate-finish
// (同一影片頁、videoId 沒變)。原 listener 一律走 reset path → captionMap /
// displayCues / overlay 全清 + force reload XHR(~10 秒)→ 使用者看到「中文字幕
// 閃一下變回英文一陣子才回到中文」。v1.8.68 加 same-videoId guard 跳過 reset。
//
// 本檔做 static check,鎖死 listener 開頭的 guard architecture invariant —
// 確保未來不會有人不小心拔掉 guard / 把 reset 移到 guard 之前 / 改錯 guard 條件,
// 讓字幕閃爍 bug 重現。
//
// **驗到 / 沒驗到**(訊號層次,§1.1 規則 3):
//   ✅ 「我們的 guard 邏輯寫對」:listener 開頭有 same-videoId early-return guard,
//      reset path 在 guard 之後 — 這層 fixture 跟 static check 都能驗。
//   ❌ 「YouTube 真的會 fire 假性同 videoId 的 yt-navigate-finish」:這是 YouTube
//      內部行為,fixture dispatchEvent 自己 fire 永遠驗不到 — 這層靠 user 觀察 +
//      production 體感持續驗證,spec 鎖死範圍不含。
//
// SANITY 紀錄(已驗證):暫時把 guard 整段拔掉,對應 spec fail;還原後全綠。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readFile(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/**
 * 從 content-youtube.js 抽出 SPA nav handler 的 body。
 * v1.10.25 起 handler 從 inline arrow 改成具名函式 `_onYtSpaNavigate`,以便同掛
 * `yt-navigate-finish`(桌面)+ `state-navigateend`(行動版 mweb)兩個事件名。
 * 從 `function _onYtSpaNavigate` 開始找第一個 `{`(函式 body 起頭)— brace
 * balance 計數抓到對應 `}` 為止。處理 string / line comment / block comment
 * 內的 `{}` 不算 brace。
 */
function extractListenerBody(src) {
  const anchor = src.indexOf('function _onYtSpaNavigate');
  if (anchor === -1) return null;
  const bodyOpen = src.indexOf('{', anchor);
  if (bodyOpen === -1) return null;

  let depth = 1;
  let i = bodyOpen + 1;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
    } else if (inBlockComment) {
      if (src[i - 1] === '*' && ch === '/') inBlockComment = false;
    } else if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inString) inString = null;
    } else {
      if (ch === '/' && src[i + 1] === '/') { inLineComment = true; i += 2; continue; }
      if (ch === '/' && src[i + 1] === '*') { inBlockComment = true; i += 2; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { inString = ch; }
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    i++;
  }
  return src.slice(bodyOpen, i);
}

test.describe('content-youtube.js: yt-navigate-finish listener 同 videoId guard', () => {
  const src = readFile('shinkansen/content-youtube.js');
  const body = extractListenerBody(src);

  test('_onYtSpaNavigate handler 可被找到', () => {
    expect(body).not.toBeNull();
    expect(body.length).toBeGreaterThan(200);
  });

  test('handler 同掛 yt-navigate-finish(桌面)+ state-navigateend(行動版 mweb)', () => {
    // v1.10.25:mweb 站內切片 fire state-navigateend(桌面是 yt-navigate-finish),
    // 同一具名 handler 掛兩個事件名 — 缺 state-navigateend 行動版 SPA 切片不會重置
    expect(src).toMatch(/addEventListener\(\s*['"]yt-navigate-finish['"]\s*,\s*_onYtSpaNavigate\s*\)/);
    expect(src).toMatch(/addEventListener\(\s*['"]state-navigateend['"]\s*,\s*_onYtSpaNavigate\s*\)/);
  });

  test('listener 開頭取當前 URL videoId(用於跟 YT.videoId 比對)', () => {
    expect(body).toMatch(/getVideoIdFromUrl\s*\(\)/);
  });

  test('有 same-videoId early-return guard(三段式條件:active + 新 videoId truthy + 等於 YT.videoId)', () => {
    // 三個條件都要,缺一不可:
    //   - YT.active:必須是翻譯仍在進行中,單純停在影片頁不該被 guard
    //   - 新 videoId truthy:離開 watch 頁(newVideoId === null)該走原 reset path
    //   - 新 videoId === YT.videoId:不同影片切換該走原 reset path
    expect(body).toMatch(/YT\.active\s*&&\s*\w+\s*&&\s*\w+\s*===\s*YT\.videoId/);
  });

  test('guard 命中時 early return(避免繼續跑 reset path)', () => {
    // 抓 guard if (...) 後面接 { ... return; ... } 或 if (...) return;
    // 用更寬的 pattern:guard 條件之後 500 字內出現 return
    // (v1.10.46 批次 3-5:guard 內補 attachVideoListener() + 註解,200 字視窗不夠;
    //  500 字仍鎖「return 緊跟在 guard 區塊內」,不會誤吃到 reset path 尾端的 return)
    expect(body).toMatch(/YT\.active\s*&&[\s\S]{0,80}===\s*YT\.videoId\s*\)\s*\{?[\s\S]{0,500}return\s*[;\n]/);
  });

  test('guard 在 reset path(stopYouTubeTranslation / 清 captionMap)之前', () => {
    // 用字串位置比較:guard 條件位置 < reset 操作位置
    const guardIdx = body.search(/===\s*YT\.videoId/);
    const stopIdx = body.indexOf('stopYouTubeTranslation()');
    const captionMapResetIdx = body.search(/YT\.captionMap\s*=\s*new\s+Map/);

    expect(guardIdx).toBeGreaterThan(0);
    expect(stopIdx).toBeGreaterThan(0);
    expect(captionMapResetIdx).toBeGreaterThan(0);
    expect(guardIdx).toBeLessThan(stopIdx);
    expect(guardIdx).toBeLessThan(captionMapResetIdx);
  });

  test('reset path 仍在(不同影片 / 離開 watch 頁仍走原 reset)', () => {
    // 確保 guard 加了之後 reset 邏輯沒被一起拿掉 — 真正的影片切換仍要清狀態
    expect(body).toMatch(/stopYouTubeTranslation\s*\(\)/);
    expect(body).toMatch(/YT\.captionMap\s*=\s*new\s+Map/);
    expect(body).toMatch(/YT\.rawSegments\s*=\s*\[\]/);
  });

  test('guard 命中時記 log(方便 user 報告閃爍時 dump log 驗證真實場景)', () => {
    // user 報告字幕閃時,log 內可以看到 'SPA nav skipped' 條目 → 確認真的有命中
    // same-videoId 場景。沒這條 log,我們仍鎖不到 YouTube 真實 fire 行為,但至少
    // 知道 guard 沒命中(應該命中卻沒命中 = 別處出問題)
    expect(body).toMatch(/['"]SPA nav skipped[^'"]*['"]/);
  });
});

// ─── issue #58:SPA 導航尊重「明確關閉的 autoTranslate」──────────────────
//
// CHANGELOG v1.4.21 已記載但當時未修的獨立 bug(上游 issue #58 症狀 1):重啟條件
// `wasActive || autoTranslate` 讓 wasActive 短路掉使用者明確設為 false 的
// ytSubtitle.autoTranslate — 只要本分頁字幕翻譯曾啟動過(安裝預設 true 的首次載入、
// 或手動啟動),之後把設定關掉,同分頁換影片(SPA 導航)仍會繼續翻譯並燒 API。
//
// 修正語意:明確 false 一律不重啟;true 重啟;未設定(undefined)沿用舊行為
// (wasActive 才重啟 — 手動啟動的跨影片延續)。
//
// 測法:extractListenerBody 抽出 handler body,AsyncFunction 注入 stub 依賴後直接
// 呼叫,驗「translateYouTubeSubtitles 是否在 500ms 重啟排程後被呼叫」的行為層 —
// 不是 static check,是真的執行 handler 原始碼。
//
// 驗到 / 沒驗到:
//   ✅ 五種 (autoTranslate × wasActive) 組合的重啟決策(執行層)
//   ❌ 真實 YouTube fire yt-navigate-finish 的時序 — 同上方 static check 區塊的限制
//
// SANITY 紀錄(已驗證):修正前(`wasActive || autoTranslate`)「false + wasActive=true
// → 不重啟」case fail(實際重啟了);套上明確 false 優先後五條全綠。

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function buildHandlerFromSource() {
  const body = extractListenerBody(readFile('shinkansen/content-youtube.js'));
  // body 是含外層 {} 的 block statement,直接當 function body 執行語意相同
  return new AsyncFunction(
    'SK', 'browser', 'getVideoIdFromUrl', 'stopYouTubeTranslation',
    'hideCaptionStatus', '_debugRemove', '_setAsrHidingMode', '_removeOverlay',
    'attachVideoListener',
    body
  );
}

function makeHarness({ active, ytSubtitle }) {
  const startCalls = [];
  const SK = {
    YT: { active, videoId: 'video-OLD' },
    isYouTubePage: () => true,
    sendLog: () => {},
    translateYouTubeSubtitles: (opts) => { startCalls.push(opts); return Promise.resolve(); },
  };
  const browser = {
    storage: { sync: { get: async () => (ytSubtitle === undefined ? {} : { ytSubtitle }) } },
  };
  const handler = buildHandlerFromSource();
  const invoke = () => handler(
    SK, browser,
    () => 'video-NEW',                       // getVideoIdFromUrl:模擬切到不同影片
    () => { SK.YT.active = false; },         // stopYouTubeTranslation
    () => {},                                // hideCaptionStatus
    () => {},                                // _debugRemove
    () => {},                                // _setAsrHidingMode
    () => {},                                // _removeOverlay
    () => {},                                // attachVideoListener
  );
  return { startCalls, invoke };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// handler 內部重啟走 setTimeout(500ms)。正負向都等固定 900ms:
// 正向給排程足夠餘裕,負向依 create-env.cjs 慣例用固定等待驗「事情沒發生」。
const RESTART_WAIT_MS = 900;

test.describe('_onYtSpaNavigate 行為:autoTranslate 明確 false 不得重啟(issue #58)', () => {
  test('autoTranslate=false + wasActive=true → 不重啟(本 issue 的核心 bug)', async () => {
    const h = makeHarness({ active: true, ytSubtitle: { autoTranslate: false } });
    await h.invoke();
    await sleep(RESTART_WAIT_MS);
    expect(h.startCalls.length).toBe(0);
  });

  test('autoTranslate=false + wasActive=false → 不重啟', async () => {
    const h = makeHarness({ active: false, ytSubtitle: { autoTranslate: false } });
    await h.invoke();
    await sleep(RESTART_WAIT_MS);
    expect(h.startCalls.length).toBe(0);
  });

  test('autoTranslate=true + wasActive=false → 重啟', async () => {
    const h = makeHarness({ active: false, ytSubtitle: { autoTranslate: true } });
    await h.invoke();
    await sleep(RESTART_WAIT_MS);
    expect(h.startCalls.length).toBe(1);
  });

  test('ytSubtitle 未設定 + wasActive=true → 重啟(手動啟動的跨影片延續)', async () => {
    const h = makeHarness({ active: true, ytSubtitle: undefined });
    await h.invoke();
    await sleep(RESTART_WAIT_MS);
    expect(h.startCalls.length).toBe(1);
  });

  test('ytSubtitle 未設定 + wasActive=false → 不重啟', async () => {
    const h = makeHarness({ active: false, ytSubtitle: undefined });
    await h.invoke();
    await sleep(RESTART_WAIT_MS);
    expect(h.startCalls.length).toBe(0);
  });
});
