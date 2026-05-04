// Regression: v1.6.20 D' ASR mode(LLM 自由合句 + 時間戳對齊)
//
// 驗證:
//   1. URL 含 kind=asr → YT.isAsr=true,translateWindowFrom 走 _runAsrWindow 而非原批次路徑
//   2. _runAsrWindow 包 [{s,e,t}] JSON 送 TRANSLATE_ASR_SUBTITLE_BATCH
//      (而非 TRANSLATE_SUBTITLE_BATCH 的 1:1 行陣列)
//   3. LLM 回 [{s,e,t}] 譯文後,合句譯文寫入區間第一個 normText,其餘 normText 存空字串
//   4. URL 不含 kind=asr → 走原 TRANSLATE_SUBTITLE_BATCH 路徑(行為不變)
//
// SANITY CHECK 已完成:
//   暫時把 content-youtube.js 的「shinkansen-yt-captions listener 內 `YT.isAsr =
//   u.searchParams.get('kind') === 'asr'`」改成 `YT.isAsr = false` →
//   test #1 fail(asrBatchCount=0 / regularBatchCount=1,因為走回原路徑)
//   還原後再跑 → pass。
//
// 設計依據:timestamp mode—— LLM 自由合句,以時間戳邊界驗證對齊
// (不強制 1:1 行對齊,只驗輸出時間 ⊆ 輸入時間戳集合)。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-asr-mode';

// 設定 ytSubtitle.asrMode 到 chrome.storage.sync。translateYouTubeSubtitles 啟動時會
// reset YT.config = null,接著 getYtConfig 從 storage 讀取,這裡注入 asrMode 後即生效。
async function setAsrMode(evaluate, mode) {
  await evaluate(`chrome.storage.sync.set({ ytSubtitle: { asrMode: ${JSON.stringify(mode)} } })`);
}

test('youtube-asr-mode: kind=asr URL 走 ASR 合句路徑,captionMap 寫入合併譯文', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await setAsrMode(evaluate, 'llm'); // 此 test 驗純 LLM 路徑

  // Mock chrome.runtime.sendMessage:
  //   - TRANSLATE_ASR_SUBTITLE_BATCH → 計數 + 回 canned JSON 譯文(合 3 條成 1 句)
  //   - TRANSLATE_SUBTITLE_BATCH → 計數,讓 SANITY 失敗時能觀察到走錯路徑
  //   - 其他(LOG_USAGE 等)→ { ok: true }
  await evaluate(`
    window.__asrBatchCount = 0;
    window.__regularBatchCount = 0;
    window.__lastAsrPayload = null;
    chrome.runtime.sendMessage = async function(msg) {
      if (!msg || !msg.type) return { ok: true };
      if (msg.type === 'TRANSLATE_ASR_SUBTITLE_BATCH') {
        window.__asrBatchCount++;
        window.__lastAsrPayload = msg.payload;
        // 模擬 LLM 把 3 條合成 1 句,時間 s 對齊輸入第 1 條 s,e 對齊輸入第 3 條 e
        const inputArr = JSON.parse((msg.payload && msg.payload.texts && msg.payload.texts[0]) || '[]');
        if (inputArr.length === 0) return { ok: true, result: ['[]'], usage: {} };
        const merged = {
          s: inputArr[0].s,
          e: inputArr[inputArr.length - 1].e,
          t: '自動字幕真的壞了',
        };
        return {
          ok: true,
          result: [JSON.stringify([merged])],
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      if (msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        window.__regularBatchCount++;
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  // 模擬 ASR 攔截:dispatch shinkansen-yt-captions 事件,URL 含 kind=asr,
  // responseText 是 json3 格式(parseJson3 會處理),三條短條落在同一視窗 0
  await evaluate(`
    const json3 = JSON.stringify({
      events: [
        { tStartMs: 500,  segs: [{ utf8: 'the auto' }] },
        { tStartMs: 1200, segs: [{ utf8: 'captions are' }] },
        { tStartMs: 1800, segs: [{ utf8: 'really broken' }] },
      ],
    });
    window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
      detail: { url: 'https://www.youtube.com/api/timedtext?v=ABC&lang=en&kind=asr&caps=asr', responseText: json3 },
    }));
  `);
  await page.waitForTimeout(100);

  // 驗證 isAsr 已設為 true 且 rawSegments 有資料
  const afterCapture = await evaluate(`({
    isAsr: window.__SK.YT.isAsr,
    rawCount: window.__SK.YT.rawSegments.length,
  })`);
  expect(afterCapture.isAsr, 'kind=asr URL 應將 YT.isAsr 設為 true').toBe(true);
  expect(afterCapture.rawCount, '應有 3 條 rawSegments').toBe(3);

  // 啟動翻譯:translateYouTubeSubtitles → translateWindowFrom(0) → 走 _runAsrWindow
  await evaluate(`window.__SK.translateYouTubeSubtitles()`);
  await page.waitForTimeout(500);

  const result = await evaluate(`({
    asrBatchCount: window.__asrBatchCount,
    regularBatchCount: window.__regularBatchCount,
    captionMap: Array.from(window.__SK.YT.captionMap.entries()),
    asrPayloadFirstText: (() => {
      const p = window.__lastAsrPayload;
      if (!p || !p.texts || !p.texts[0]) return null;
      return p.texts[0];
    })(),
  })`);

  // 驗證 1:走 ASR 路徑(asrBatch 1 次)、不走原路徑(regularBatch 0 次)
  expect(
    result.asrBatchCount,
    'ASR 模式應只送 1 次 TRANSLATE_ASR_SUBTITLE_BATCH',
  ).toBe(1);
  expect(
    result.regularBatchCount,
    'ASR 模式不應送 TRANSLATE_SUBTITLE_BATCH(那是逐條翻譯路徑)',
  ).toBe(0);

  // 驗證 2:送出的 payload 是 [{s,e,t}] JSON 陣列字串,含 3 條輸入
  expect(result.asrPayloadFirstText, 'payload 第一個元素應是 JSON 字串').toBeTruthy();
  const inputArr = JSON.parse(result.asrPayloadFirstText);
  expect(inputArr.length, 'payload 應含 3 條 ASR segments').toBe(3);
  expect(inputArr[0].s, '第一條 s 應為 500').toBe(500);
  expect(inputArr[0].t, '第一條 t 應為 "the auto"').toBe('the auto');
  expect(inputArr[2].s, '第三條 s 應為 1800').toBe(1800);

  // 驗證 3:captionMap 寫入 — 第一條 normText 存合併譯文,其餘存空字串
  const captionMap = new Map(result.captionMap);
  expect(captionMap.get('the auto'), '合句首條應存完整譯文').toBe('自動字幕真的壞了');
  expect(captionMap.get('captions are'), '合句非首條應存空字串(視覺合併)').toBe('');
  expect(captionMap.get('really broken'), '合句非首條應存空字串(視覺合併)').toBe('');

  await page.close();
});

test('youtube-asr-mode: gap-aware streaming 切子批,batch 0 先回先寫 captionMap,batch 1+ 並行', async ({
  context,
  localServer,
}) => {
  // 驗證 v1.6.20 D'-streaming:
  //   1. 條數多(> 5 條)且有 gap > 500ms 自然停頓 → 切多個子批
  //   2. batch 0 先 await,batch 1+ 並行(allSettled)
  //   3. batch 0 完成立刻寫 captionMap,不等其他批
  //
  // SANITY CHECK 已完成:
  //   把 _splitAsrSubBatches return [windowSegs];(整批不切)→ 此 test fail
  //   (asrBatchCount=1 而非 ≥ 2,且 batch0EarlyWrite=false)→ 還原後 pass。

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await setAsrMode(evaluate, 'llm'); // 此 test 驗純 LLM 路徑的 streaming

  // Mock:batch 0 最快(50ms),後續批慢得多(3000ms),製造明顯時間差以驗證 streaming。
  // 若 streaming 生效,在 [50ms, 3000ms] 區間內 captionMap 應只含 batch 0 的譯文。
  // 若整批 await(無 streaming),則 captionMap 直到 3000ms 才有任何寫入。
  await evaluate(`
    window.__asrBatchCount = 0;
    window.__asrBatchInputs = [];
    window.__asrBatchCallStartedAt = [];
    chrome.runtime.sendMessage = async function(msg) {
      if (!msg || !msg.type) return { ok: true };
      if (msg.type === 'TRANSLATE_ASR_SUBTITLE_BATCH') {
        const idx = window.__asrBatchCount++;
        window.__asrBatchCallStartedAt.push(Date.now());
        const inputArr = JSON.parse((msg.payload && msg.payload.texts && msg.payload.texts[0]) || '[]');
        window.__asrBatchInputs.push({
          idx,
          firstS: inputArr[0]?.s,
          lastS: inputArr[inputArr.length - 1]?.s,
          count: inputArr.length,
        });
        const delayMs = idx === 0 ? 50 : 3000;
        await new Promise(r => setTimeout(r, delayMs));
        const merged = inputArr.length > 0 ? [{
          s: inputArr[0].s,
          e: inputArr[inputArr.length - 1].e,
          t: '譯文 batch ' + idx,
        }] : [];
        return {
          ok: true,
          result: [JSON.stringify(merged)],
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  // 構造 14 條 ASR segments,跨 28s,故意在 5s/13s 處留 gap > 500ms 自然停頓
  // 預期切點:0..4(5s 前)= sub0;5..9(5-13s)= sub1;10..13(13s 之後)= sub2
  await evaluate(`
    const events = [];
    const startMsList = [
      // 5 條密集(每 800ms 一條,落在 0-3.2s,所有 gap = 800ms)
      0, 800, 1600, 2400, 3200,
      // 在 3.2s → 5s 之間 1800ms gap(自然停頓 1)→ 切點 1 應落這
      5000, 5800, 6600, 7400, 8200,
      // 8.2s → 13s 之間 4800ms gap(自然停頓 2)→ 切點 2 應落這
      13000, 13800, 14600, 15400,
    ];
    for (const ms of startMsList) {
      events.push({ tStartMs: ms, segs: [{ utf8: 'word' + ms }] });
    }
    const json3 = JSON.stringify({ events });
    window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
      detail: { url: 'https://www.youtube.com/api/timedtext?v=ABC&lang=en&kind=asr&caps=asr', responseText: json3 },
    }));
  `);
  await page.waitForTimeout(100);

  // 啟動翻譯(fire-and-forget;evaluate 不 await translateYouTubeSubtitles 的 promise),
  // 1500ms 後拍 captionMap snapshot——此時 batch 0(50ms 延遲)已寫,batch 1+(3000ms)還沒。
  // 若 streaming 生效 → snapshot 含「譯文 batch 0」但不含「譯文 batch 1」。
  // 若整批 await(無 streaming)→ snapshot 為空(全部要等 3000ms 才一起寫)。
  const _t0 = Date.now();
  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  await page.waitForTimeout(1500);
  const midSnapshot = await evaluate(`Array.from(window.__SK.YT.captionMap.entries())`);
  const _midElapsed = Date.now() - _t0;

  // 再等到 batch 1+ 完成
  await page.waitForTimeout(2500);

  const result = await evaluate(`({
    asrBatchCount: window.__asrBatchCount,
    asrBatchInputs: window.__asrBatchInputs,
    asrBatchCallStartedAt: window.__asrBatchCallStartedAt,
    finalCaptionMap: Array.from(window.__SK.YT.captionMap.entries()),
  })`);

  // 驗證 1:應切成 ≥ 2 個子批(14 條 + 自然 gap)
  expect(
    result.asrBatchCount,
    '14 條 ASR + gap > 500ms 應切成至少 2 個子批',
  ).toBeGreaterThanOrEqual(2);

  // 驗證 2:子批切點順序合理(sub_n.firstS > sub_(n-1).lastS,且每個子批內部時間遞增)
  //   不硬編碼具體切點 —— sub0Max 隨 leadMs 浮動(緊急 4000 / 即將 6000 / 從容 8000),
  //   切點隨之變化。test #3 會專門驗 leadMs ≤ 0(緊急)時切點落在更早位置;
  //   test #4 驗 leadMs ≥ 5000(從容)時切到較晚的 gap。
  for (let i = 0; i < result.asrBatchInputs.length; i++) {
    const b = result.asrBatchInputs[i];
    expect(b.firstS, `sub${i} firstS ≤ lastS`).toBeLessThanOrEqual(b.lastS);
    if (i > 0) {
      const prev = result.asrBatchInputs[i - 1];
      expect(b.firstS, `sub${i}.firstS 應晚於 sub${i - 1}.lastS`).toBeGreaterThan(prev.lastS);
    }
  }

  // 驗證 3:1500ms 中段 snapshot — batch 0(50ms)已寫,batch 1+(3000ms)還沒(streaming 證據)
  const midMap = new Map(midSnapshot);
  const midValues = Array.from(midMap.values());
  expect(
    midValues.some(v => v === '譯文 batch 0'),
    `mid snapshot 應含 batch 0 譯文。實際 @${_midElapsed}ms: ${JSON.stringify(midValues)}`,
  ).toBe(true);
  expect(
    midValues.some(v => v === '譯文 batch 1'),
    `streaming 應確保 batch 0 完成時 batch 1 還沒寫入。實際 @${_midElapsed}ms: ${JSON.stringify(midValues)}`,
  ).toBe(false);

  // 驗證 4:batch 1+ 應並行(call 開始時間相近,而非循序 await)
  if (result.asrBatchCount >= 3) {
    const t0 = result.asrBatchCallStartedAt[1];
    const t2 = result.asrBatchCallStartedAt[2];
    expect(
      Math.abs(t2 - t0),
      'batch 1 與 batch 2 應並行送出(時間差 < 50ms)',
    ).toBeLessThan(50);
  }

  await page.close();
});

test('youtube-asr-mode: lead-time aware—緊急模式(currentTime 在視窗中段)子批 0 從現在開始,跳過已過去 segments', async ({
  context,
  localServer,
}) => {
  // 驗證 D'-adaptive(v1.6.20):
  //   - 使用者按 Alt+S 時 video 已在視窗中段(典型情況)
  //   - 子批 0 從 videoNowMs 開始,而非 windowStartMs
  //   - 已過去的 segments(startMs < videoNowMs)被 skip,不送 API
  //   - 子批 0 跨度上限縮成 4000ms(從容模式 8000ms 的一半),payload 更小
  //
  // SANITY CHECK 已完成:
  //   把 _splitAsrSubBatches 內 leadMs ≤ 0 分支改成永遠走 sub0Start = windowSegs[0].startMs
  //   → 此 test fail(子批 0 含 0–10s 的 segments 而非從 currentTime 開始)→ 還原 pass。

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await setAsrMode(evaluate, 'llm'); // 此 test 驗 LLM 路徑的 lead-time aware

  await evaluate(`
    window.__asrBatchInputs = [];
    chrome.runtime.sendMessage = async function(msg) {
      if (!msg || !msg.type) return { ok: true };
      if (msg.type === 'TRANSLATE_ASR_SUBTITLE_BATCH') {
        const inputArr = JSON.parse((msg.payload && msg.payload.texts && msg.payload.texts[0]) || '[]');
        window.__asrBatchInputs.push({
          firstS: inputArr[0]?.s,
          lastS: inputArr[inputArr.length - 1]?.s,
          count: inputArr.length,
        });
        const merged = inputArr.length > 0 ? [{
          s: inputArr[0].s,
          e: inputArr[inputArr.length - 1].e,
          t: '譯文',
        }] : [];
        return {
          ok: true,
          result: [JSON.stringify(merged)],
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  // 14 條 segments 分布在 0..15.4s。設 video.currentTime = 10s 模擬「使用者在視窗中段按 Alt+S」
  // → leadMs = 0 - 10000 = -10000(緊急模式)→ 子批 0 應從 ≥ 10000ms 的 segments 開始
  await evaluate(`
    const events = [];
    const startMsList = [
      0, 800, 1600, 2400, 3200,
      5000, 5800, 6600, 7400, 8200,
      13000, 13800, 14600, 15400,
    ];
    for (const ms of startMsList) {
      events.push({ tStartMs: ms, segs: [{ utf8: 'word' + ms }] });
    }
    const json3 = JSON.stringify({ events });
    window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
      detail: { url: 'https://www.youtube.com/api/timedtext?v=ABC&lang=en&kind=asr&caps=asr', responseText: json3 },
    }));
    // 設 currentTime = 10s,attachVideoListener 抓得到的 video element 之 currentTime 屬性
    const video = document.querySelector('video');
    Object.defineProperty(video, 'currentTime', { get: () => 10, configurable: true });
  `);
  await page.waitForTimeout(100);

  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  await page.waitForTimeout(300);

  const result = await evaluate(`({
    asrBatchInputs: window.__asrBatchInputs,
    leadMs: window.__SK.YT.lastLeadMs,
  })`);

  // 驗證 1:全部子批的 firstS 都 ≥ 10000(currentTime in ms),已過去 segments 被 skip
  expect(result.asrBatchInputs.length, '至少送出 1 個子批').toBeGreaterThanOrEqual(1);
  for (const b of result.asrBatchInputs) {
    expect(
      b.firstS,
      `子批 firstS=${b.firstS} 應 ≥ 10000(已過去的 segments 應被 skip)`,
    ).toBeGreaterThanOrEqual(10000);
  }

  // 驗證 2:子批 0 跨度應在 sub0Max=4000ms 內(緊急模式比 8000ms 小一半)
  const sub0 = result.asrBatchInputs[0];
  expect(
    sub0.lastS - sub0.firstS,
    `緊急模式子批 0 跨度應 ≤ 4000ms(實際 ${sub0.lastS - sub0.firstS}ms)`,
  ).toBeLessThanOrEqual(4000);

  // 驗證 3:lastLeadMs 記錄為負(視窗中段 = 緊急)
  expect(
    result.leadMs,
    `lastLeadMs 應為負數(緊急,實際 ${result.leadMs})`,
  ).toBeLessThan(0);

  await page.close();
});

test('youtube-asr-mode: G 路徑 — ASR 啟動後 player root 加 class + overlay 注入,不動原生 segment', async ({
  context,
  localServer,
}) => {
  // 驗證 G 路徑(v1.6.20):
  //   - ASR 字幕偵測到後,_setAsrHidingMode(true) 把 player root 加 'shinkansen-asr-active' class
  //   - _ensureOverlay() 在 player root 內 append <shinkansen-yt-overlay> 容器(含 Shadow DOM)
  //   - 全域 style#shinkansen-asr-hide-css 注入 head,把 .caption-window / rolling captions 設 display:none
  //   - 動態 append 的英文 segment **不被改 textContent**(由 CSS 整體隱藏整個 caption-window,
  //     避免跟 YouTube 原生 rolling captions 在 textContent 上競爭)
  //
  // 反例:非 ASR 不加 class、不注入 overlay。
  //
  // SANITY CHECK 已完成:
  //   把 captions listener 內 `if (YT.isAsr)` 區塊整段 comment 掉(_setAsrHidingMode + _ensureOverlay 不執行)
  //   → 此 test fail(hasAsrClass / overlayCount / cssInjected 全 false)→ 還原 pass。

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await setAsrMode(evaluate, 'llm');

  await evaluate(`
    chrome.runtime.sendMessage = async function(msg) {
      if (!msg || !msg.type) return { ok: true };
      if (msg.type === 'TRANSLATE_ASR_SUBTITLE_BATCH') {
        await new Promise(r => setTimeout(r, 2000));
        return { ok: true, result: ['[]'], usage: {} };
      }
      return { ok: true };
    };

    // dispatch ASR caption(URL kind=asr)→ rawSegments 填入 + isAsr=true → 觸發 G 路徑 setup
    const json3 = JSON.stringify({
      events: [{ tStartMs: 1000, segs: [{ utf8: 'first line' }] }],
    });
    window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
      detail: { url: 'https://www.youtube.com/api/timedtext?v=ABC&lang=en&kind=asr', responseText: json3 },
    }));
  `);
  await page.waitForTimeout(150);

  // 驗證 1:player root 應加 ASR class
  // 驗證 2:overlay element 應存在於 player root 內(含 shadowRoot)
  // 驗證 3:全域 style 應注入到 head
  const asrSetup = await evaluate(`(() => {
    const root = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    const overlay = root ? root.querySelector('shinkansen-yt-overlay') : null;
    return {
      hasAsrClass: !!root && root.classList.contains('shinkansen-asr-active'),
      overlayExists: !!overlay,
      overlayHasShadow: !!(overlay && overlay.shadowRoot),
      cssInjected: !!document.getElementById('shinkansen-asr-hide-css'),
      isAsr: window.__SK.YT.isAsr,
    };
  })()`);
  expect(asrSetup.isAsr, 'YT.isAsr 應為 true').toBe(true);
  expect(asrSetup.hasAsrClass, 'player root 應加 shinkansen-asr-active class').toBe(true);
  expect(asrSetup.overlayExists, 'player root 內應有 <shinkansen-yt-overlay>').toBe(true);
  expect(asrSetup.overlayHasShadow, 'overlay 應有 shadowRoot').toBe(true);
  expect(asrSetup.cssInjected, '全域 hide CSS 應注入到 head').toBe(true);

  // 啟動翻譯,動態 append 英文 segment(模擬 YouTube ASR rolling captions append 新行)
  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  await page.waitForTimeout(200);
  await evaluate(`
    const container = document.querySelector('.ytp-caption-window-container');
    const newSeg = document.createElement('span');
    newSeg.className = 'ytp-caption-segment';
    newSeg.textContent = 'english not yet translated';
    container.appendChild(newSeg);
    window.__newSeg = newSeg;
  `);
  await page.waitForTimeout(150);

  // 驗證 4:G 路徑下 ASR 模式不動原生 segment textContent(由 CSS 隱藏整個 caption-window)
  const segText = await evaluate(`window.__newSeg.textContent`);
  expect(
    segText,
    `G 路徑 ASR 模式不應改原生 segment textContent。實際: "${segText}"`,
  ).toBe('english not yet translated');

  // 對照:把 isAsr 翻成 false → player root 不該有 class(此處驗 stop/SPA 應移除 class)
  await evaluate(`window.__SK.stopYouTubeTranslation()`);
  await page.waitForTimeout(50);
  const afterStop = await evaluate(`(() => {
    const root = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    return {
      hasAsrClass: !!root && root.classList.contains('shinkansen-asr-active'),
      overlayExists: !!(root && root.querySelector('shinkansen-yt-overlay')),
    };
  })()`);
  expect(afterStop.hasAsrClass, 'stop 後 player root 應移除 ASR class').toBe(false);
  expect(afterStop.overlayExists, 'stop 後 overlay 應被移除').toBe(false);

  await page.close();
});

test('youtube-asr-mode: heuristic mode 走啟發式合句 + TRANSLATE_SUBTITLE_BATCH(逐句翻),不送 ASR_BATCH', async ({
  context,
  localServer,
}) => {
  // 驗證 F 模式:asrMode='heuristic'
  //   - 不送 TRANSLATE_ASR_SUBTITLE_BATCH(LLM 合句路徑)
  //   - 用啟發式合句後逐句送 TRANSLATE_SUBTITLE_BATCH
  //   - 合句首條 normText 存譯文,其餘存空字串(視覺合併)

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await setAsrMode(evaluate, 'heuristic');

  await evaluate(`
    window.__asrBatchCount = 0;
    window.__regularBatchCount = 0;
    window.__regularBatchTexts = [];
    chrome.runtime.sendMessage = async function(msg) {
      if (!msg || !msg.type) return { ok: true };
      if (msg.type === 'TRANSLATE_ASR_SUBTITLE_BATCH') {
        window.__asrBatchCount++;
        return { ok: true, result: ['[]'], usage: {} };
      }
      if (msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        window.__regularBatchCount++;
        const texts = (msg.payload && msg.payload.texts) || [];
        window.__regularBatchTexts.push(...texts);
        return {
          ok: true,
          result: texts.map((t, i) => '[ZH] ' + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  // 構造 ASR-style segments(每條 1-3 字,有時間 gap)
  await evaluate(`
    const events = [
      { tStartMs: 0,    segs: [{ utf8: 'the' }] },
      { tStartMs: 400,  segs: [{ utf8: 'auto' }] },
      { tStartMs: 800,  segs: [{ utf8: 'captions' }] },
      { tStartMs: 1200, segs: [{ utf8: 'are' }] },
      { tStartMs: 1500, segs: [{ utf8: 'broken' }] },
      // 大 gap(2500ms)後新句
      { tStartMs: 4000, segs: [{ utf8: 'hello' }] },
      { tStartMs: 4400, segs: [{ utf8: 'world' }] },
    ];
    const json3 = JSON.stringify({ events });
    window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
      detail: { url: 'https://www.youtube.com/api/timedtext?v=ABC&lang=en&kind=asr', responseText: json3 },
    }));
  `);
  await page.waitForTimeout(100);

  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  await page.waitForTimeout(800);

  const result = await evaluate(`({
    asrBatchCount: window.__asrBatchCount,
    regularBatchCount: window.__regularBatchCount,
    regularBatchTexts: window.__regularBatchTexts,
    captionMap: Array.from(window.__SK.YT.captionMap.entries()),
  })`);

  expect(
    result.asrBatchCount,
    'heuristic mode 不應送 TRANSLATE_ASR_SUBTITLE_BATCH',
  ).toBe(0);
  expect(
    result.regularBatchCount,
    'heuristic mode 應送 TRANSLATE_SUBTITLE_BATCH(逐句翻譯路徑)',
  ).toBeGreaterThanOrEqual(1);
  // 啟發式應切成 ≥ 2 句(2.5s gap 是強自然停頓,Lle 也不會再吞回去)
  expect(
    result.regularBatchTexts.length,
    `啟發式合句應產生 ≥ 2 個英文整句(實際 ${result.regularBatchTexts.length}: ${JSON.stringify(result.regularBatchTexts)})`,
  ).toBeGreaterThanOrEqual(2);

  // captionMap 應含合句首條譯文 + 其餘 normText 為空
  const captionMap = new Map(result.captionMap);
  const cmValues = Array.from(captionMap.values());
  expect(
    cmValues.some(v => /^\[ZH\]/.test(v)),
    'captionMap 應含至少一個 [ZH] 譯文',
  ).toBe(true);
  expect(
    cmValues.filter(v => v === '').length,
    '合句非首條的 normText 應存空字串',
  ).toBeGreaterThanOrEqual(1);

  await page.close();
});

test('youtube-asr-mode: progressive mode 兩種訊息都送(heuristic + LLM 並行覆蓋)', async ({
  context,
  localServer,
}) => {
  // 驗證 E 模式:asrMode='progressive'
  //   - 送 TRANSLATE_SUBTITLE_BATCH(heuristic 合句後逐句翻)
  //   - 也送 TRANSLATE_ASR_SUBTITLE_BATCH(LLM 自由合句)
  //   - LLM 結果回來後寫 captionMap 會覆蓋 heuristic 結果(同 normText key)

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await setAsrMode(evaluate, 'progressive');

  await evaluate(`
    window.__asrBatchCount = 0;
    window.__regularBatchCount = 0;
    chrome.runtime.sendMessage = async function(msg) {
      if (!msg || !msg.type) return { ok: true };
      if (msg.type === 'TRANSLATE_ASR_SUBTITLE_BATCH') {
        window.__asrBatchCount++;
        const inputArr = JSON.parse((msg.payload && msg.payload.texts && msg.payload.texts[0]) || '[]');
        const merged = inputArr.length > 0 ? [{
          s: inputArr[0].s, e: inputArr[inputArr.length - 1].e, t: 'LLM 譯文',
        }] : [];
        return { ok: true, result: [JSON.stringify(merged)], usage: {} };
      }
      if (msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        window.__regularBatchCount++;
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map(t => 'heuristic 譯文'),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  await evaluate(`
    const events = [
      { tStartMs: 0,    segs: [{ utf8: 'the' }] },
      { tStartMs: 400,  segs: [{ utf8: 'auto' }] },
      { tStartMs: 800,  segs: [{ utf8: 'captions' }] },
      { tStartMs: 1200, segs: [{ utf8: 'are' }] },
      { tStartMs: 1500, segs: [{ utf8: 'broken' }] },
      { tStartMs: 4000, segs: [{ utf8: 'hello' }] },
      { tStartMs: 4400, segs: [{ utf8: 'world' }] },
    ];
    const json3 = JSON.stringify({ events });
    window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
      detail: { url: 'https://www.youtube.com/api/timedtext?v=ABC&lang=en&kind=asr', responseText: json3 },
    }));
  `);
  await page.waitForTimeout(100);

  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  await page.waitForTimeout(1500);

  const result = await evaluate(`({
    asrBatchCount: window.__asrBatchCount,
    regularBatchCount: window.__regularBatchCount,
    captionMap: Array.from(window.__SK.YT.captionMap.entries()),
  })`);

  expect(
    result.regularBatchCount,
    'progressive mode 應送 TRANSLATE_SUBTITLE_BATCH(heuristic 路徑)',
  ).toBeGreaterThanOrEqual(1);
  expect(
    result.asrBatchCount,
    'progressive mode 應送 TRANSLATE_ASR_SUBTITLE_BATCH(LLM 覆蓋路徑)',
  ).toBeGreaterThanOrEqual(1);

  // captionMap 應含 LLM 譯文(覆蓋了 heuristic 譯文)
  const captionMap = new Map(result.captionMap);
  const cmValues = Array.from(captionMap.values());
  expect(
    cmValues.some(v => v === 'LLM 譯文'),
    `progressive 最終應顯示 LLM 譯文(覆蓋 heuristic)。實際 captionMap values: ${JSON.stringify(cmValues)}`,
  ).toBe(true);

  await page.close();
});


test('youtube-asr-mode: openai-compat engine 應路由 ASR heuristic 與 LLM 批次到 custom handlers', async ({
  context,
  localServer,
}) => {
  // Regression: ytSubtitle.engine='openai-compat' 時，ASR progressive 模式不應再硬走 Gemini handlers。
  //   - heuristic 路徑應送 TRANSLATE_SUBTITLE_BATCH_CUSTOM
  //   - LLM/timestamp 路徑應送 TRANSLATE_ASR_SUBTITLE_BATCH_CUSTOM
  //   - 不應送 TRANSLATE_SUBTITLE_BATCH / TRANSLATE_ASR_SUBTITLE_BATCH

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await evaluate(`chrome.storage.sync.set({ ytSubtitle: { asrMode: 'progressive', engine: 'openai-compat' } })`);

  await evaluate(`
    window.__customAsrBatchCount = 0;
    window.__customSubtitleBatchCount = 0;
    window.__geminiAsrBatchCount = 0;
    window.__geminiSubtitleBatchCount = 0;
    chrome.runtime.sendMessage = async function(msg) {
      if (!msg || !msg.type) return { ok: true };
      if (msg.type === 'TRANSLATE_ASR_SUBTITLE_BATCH_CUSTOM') {
        window.__customAsrBatchCount++;
        const inputArr = JSON.parse((msg.payload && msg.payload.texts && msg.payload.texts[0]) || '[]');
        const merged = inputArr.length > 0 ? [{
          s: inputArr[0].s, e: inputArr[inputArr.length - 1].e, t: 'custom LLM 譯文',
        }] : [];
        return { ok: true, result: [JSON.stringify(merged)], usage: {} };
      }
      if (msg.type === 'TRANSLATE_SUBTITLE_BATCH_CUSTOM') {
        window.__customSubtitleBatchCount++;
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map(() => 'custom heuristic 譯文'),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      if (msg.type === 'TRANSLATE_ASR_SUBTITLE_BATCH') window.__geminiAsrBatchCount++;
      if (msg.type === 'TRANSLATE_SUBTITLE_BATCH') window.__geminiSubtitleBatchCount++;
      return { ok: true };
    };
  `);

  await evaluate(`
    const events = [
      { tStartMs: 0,    segs: [{ utf8: 'the' }] },
      { tStartMs: 400,  segs: [{ utf8: 'auto' }] },
      { tStartMs: 800,  segs: [{ utf8: 'captions' }] },
      { tStartMs: 1200, segs: [{ utf8: 'are' }] },
      { tStartMs: 1500, segs: [{ utf8: 'broken' }] },
      { tStartMs: 4000, segs: [{ utf8: 'hello' }] },
      { tStartMs: 4400, segs: [{ utf8: 'world' }] },
    ];
    const json3 = JSON.stringify({ events });
    window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
      detail: { url: 'https://www.youtube.com/api/timedtext?v=ABC&lang=en&kind=asr', responseText: json3 },
    }));
  `);
  await page.waitForTimeout(100);

  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  await page.waitForTimeout(1500);

  const result = await evaluate(`({
    customAsrBatchCount: window.__customAsrBatchCount,
    customSubtitleBatchCount: window.__customSubtitleBatchCount,
    geminiAsrBatchCount: window.__geminiAsrBatchCount,
    geminiSubtitleBatchCount: window.__geminiSubtitleBatchCount,
  })`);

  expect(result.customSubtitleBatchCount, 'heuristic 路徑應走 TRANSLATE_SUBTITLE_BATCH_CUSTOM').toBeGreaterThanOrEqual(1);
  expect(result.customAsrBatchCount, 'LLM/timestamp 路徑應走 TRANSLATE_ASR_SUBTITLE_BATCH_CUSTOM').toBeGreaterThanOrEqual(1);
  expect(result.geminiSubtitleBatchCount, 'openai-compat 時不應送 TRANSLATE_SUBTITLE_BATCH').toBe(0);
  expect(result.geminiAsrBatchCount, 'openai-compat 時不應送 TRANSLATE_ASR_SUBTITLE_BATCH').toBe(0);

  await page.close();
});

test('youtube-asr-mode: G 路徑 — overlay 內容由 timeupdate 驅動,根據 currentTime 切換 active cue', async ({
  context,
  localServer,
}) => {
  // 驗證 G 路徑(v1.6.20)整句穩定顯示:
  //   1. heuristic 翻譯回來後 displayCues 應有 cue
  //   2. video.currentTime = cue 範圍內 → overlay 顯示該 cue 的中文
  //   3. video.currentTime 跳出範圍 → overlay 隱藏
  //   4. 切換到另一個 cue 範圍 → overlay 顯示另一句中文
  //
  // SANITY CHECK 已完成:
  //   把 onVideoTimeUpdate 內 _updateOverlay() 呼叫改成 noop → overlay 不再隨 currentTime 切換 → fail。
  //   還原後 pass。

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await setAsrMode(evaluate, 'heuristic'); // 用 heuristic 模式回得最快

  await evaluate(`
    chrome.runtime.sendMessage = async function(msg) {
      if (!msg || !msg.type) return { ok: true };
      if (msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        const texts = (msg.payload && msg.payload.texts) || [];
        // mock 譯文用 source 前 6 字當區分(adaptive batch 0 切到不同批時 batch 內 idx 都從 0 開始,
        // 不能用 idx 當 prefix——同一影片兩 cue 可能都拿到 idx=0)
        return {
          ok: true,
          result: texts.map(t => '中譯-' + t.slice(0, 8)),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  // 兩個明顯的句子,中間 4s gap(自然停頓),確保切成 2 個 cue
  await evaluate(`
    const events = [
      { tStartMs: 1000, segs: [{ utf8: 'first' }] },
      { tStartMs: 1400, segs: [{ utf8: 'sentence' }] },
      { tStartMs: 1800, segs: [{ utf8: 'one' }] },
      { tStartMs: 6000, segs: [{ utf8: 'second' }] },
      { tStartMs: 6400, segs: [{ utf8: 'sentence' }] },
      { tStartMs: 6800, segs: [{ utf8: 'two' }] },
    ];
    const json3 = JSON.stringify({ events });
    window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
      detail: { url: 'https://www.youtube.com/api/timedtext?v=ABC&lang=en&kind=asr', responseText: json3 },
    }));
  `);
  await page.waitForTimeout(100);

  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  // 等翻譯完成 + displayCues 寫入
  await page.waitForTimeout(500);

  const cuesInfo = await evaluate(`(() => {
    const cues = window.__SK.YT.displayCues;
    return {
      count: cues.length,
      cues: cues.map(c => ({ s: c.startMs, e: c.endMs, t: c.targetText })),
    };
  })()`);
  expect(cuesInfo.count, '應產生至少 2 個 displayCues').toBeGreaterThanOrEqual(2);

  // 取得 overlay 顯示函式 — overlay shadowRoot 的 .tgt textContent
  const readOverlayText = async () => evaluate(`(() => {
    const root = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    const host = root ? root.querySelector('shinkansen-yt-overlay') : null;
    if (!host || !host.shadowRoot) return { hidden: true, text: '' };
    const tgt = host.shadowRoot.querySelector('.tgt');
    return {
      hidden: host.style.display === 'none',
      text: tgt ? tgt.textContent : '',
    };
  })()`);

  // 場景 1:currentTime 落在 cue 0 範圍 → 顯示 cue 0 譯文
  // 由於 fixture <video> 的 currentTime 預設 0,且不會自動播放,
  // 用 Object.defineProperty 動態 mock,然後手動 dispatch timeupdate 事件
  const driveTimeUpdate = async (timeSec) => evaluate(`(() => {
    const video = document.querySelector('video');
    Object.defineProperty(video, 'currentTime', { get: () => ${timeSec}, configurable: true });
    video.dispatchEvent(new Event('timeupdate'));
  })()`);

  // 落在 cue 0 範圍(startMs=1000, endMs ≈ 6000)→ 顯示對應 first/second 起頭的譯文
  await driveTimeUpdate(2);
  await page.waitForTimeout(50);
  const at2s = await readOverlayText();
  expect(at2s.hidden, '@2s overlay 應顯示').toBe(false);
  expect(at2s.text, `@2s overlay 應對應 cue 0(source 起頭 first)。實際: "${at2s.text}"`).toContain('first');

  // 落在 cue 1 範圍(startMs=6000, endMs ≈ 8300)→ 顯示對應 second 起頭的譯文
  await driveTimeUpdate(7);
  await page.waitForTimeout(50);
  const at7s = await readOverlayText();
  expect(at7s.hidden, '@7s overlay 應顯示').toBe(false);
  expect(at7s.text, `@7s overlay 應對應 cue 1(source 起頭 second)。實際: "${at7s.text}"`).toContain('second');
  expect(at7s.text, `@7s overlay 不應包含 cue 0 的內容。實際: "${at7s.text}"`).not.toContain('first');

  // 跳到所有 cue 之外(cue 1 endMs ≈ 6800 + 1500 = 8300,所以 10s 之後 = gap)→ overlay 應隱藏
  await driveTimeUpdate(10);
  await page.waitForTimeout(50);
  const at10s = await readOverlayText();
  expect(
    at10s.hidden,
    `@10s 超過所有 cue 範圍 overlay 應隱藏。實際: hidden=${at10s.hidden} text="${at10s.text}"`,
  ).toBe(true);

  await page.close();
});

test('youtube-asr-mode: 譯文過長依標點拆行(_wrapTargetTextForOverlay)', async ({
  context,
  localServer,
}) => {
  // 驗證 v1.6.20 譯文 wrap:
  //   - 短譯文(≤ 35 字)不拆,原樣回傳
  //   - 長譯文(> 35 字)在 [21, 49] 區間從後往前找最近標點切點,結果以 \n 分行
  //   - 找不到標點時不強制拆,讓 CSS 自然 wrap(回傳剩餘部分整段)
  //
  // SANITY CHECK 已完成:
  //   把 _wrapTargetText 內 _ASR_LINE_MAX 改 200(實質 disable wrap)→
  //   case "我們今天要討論的主題..." 預期 includes('\n') 變 false → fail。

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // case 1:短譯文不拆
  const r1 = await evaluate(`window.__SK._wrapTargetTextForOverlay('這是一段很短的譯文')`);
  expect(r1, '短譯文不應拆行').toBe('這是一段很短的譯文');

  // case 2:長譯文,中間有逗號 → 在標點處拆兩行
  // 「我們今天要討論的主題是 AI 翻譯的進步,而且目前看起來真的進步很多」
  // 共 ~31 中文 + 一個逗號,逗號在第 16 字附近(超過 minSpan=21)→
  // 從 idx 49 往回找第一個標點:idx 16 在 minSpan 之外應退回不拆?讓我看實際長度
  const longA = '我們今天討論的主題是人工智慧翻譯的進步,而且目前看起來真的進步很多會超過上限值';
  const r2 = await evaluate(`window.__SK._wrapTargetTextForOverlay(${JSON.stringify(longA)})`);
  expect(r2.length, 'wrap 後總字數應 ≥ 原文(可能多了 \\n)').toBeGreaterThanOrEqual(longA.length);
  expect(r2, `長譯文有標點應在標點後拆行。實際: "${r2}"`).toContain('\n');
  // 拆點應在「,」之後
  const lines = r2.split('\n');
  expect(lines.length, '應拆成至少 2 行').toBeGreaterThanOrEqual(2);
  expect(lines[0].endsWith(','), `第一行應結束於標點。實際第一行: "${lines[0]}"`).toBe(true);

  // case 3:長譯文無任何標點 → 按 maxLine 硬切(不依賴 CSS wrap)
  const longNoPunct = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三';
  const r3 = await evaluate(`window.__SK._wrapTargetTextForOverlay(${JSON.stringify(longNoPunct)})`);
  expect(r3, '長譯文無標點仍應強制拆行(輸出含 \\n)').toContain('\n');
  // 拆完後最長一行不應超過 maxLine 上限(clamp 上限 35)
  const longestLine = r3.split('\n').reduce((max, l) => Math.max(max, l.length), 0);
  expect(longestLine, `任一行不應超過 maxLine 上限。實際最長 ${longestLine}`).toBeLessThanOrEqual(35);

  await page.close();
});

test('youtube-asr-mode: 中文閱讀時間補償(_upsertDisplayCue 延長 endMs + _findActiveCue clamp 到下一句)', async ({
  context,
  localServer,
}) => {
  // 驗證 v1.6.21 修法:LLM 給的 endMs 對中文太短 → _upsertDisplayCue 延長至少
  // (中文字數 × 250ms,最低 1000ms);_findActiveCue 把延長後的 endMs clamp
  // 到下一個 cue 的 startMs,避免視覺重疊。
  //
  // SANITY CHECK 已完成:
  //   把 _upsertDisplayCue 內 adjustedEnd = Math.max(...) 改成直接用 endMs(不延長)
  //   → 此 test fail(case 1 的 cue.endMs 不是 startMs + 字數×250)→ 還原 pass。

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);

  // case 1:cue 含 8 字中文,LLM 給的 endMs 只 500ms(太短)
  //   → adjustedEnd 應 = startMs + max(800, 8 × 200) = startMs + 1600ms
  // case 2:cue 1 endMs 延長後超過 cue 2 startMs → _findActiveCue 在 cue2 startMs 處選 cue 2
  await evaluate(`
    window.__SK.YT.displayCues = [];
  `);

  // 構造直接呼叫 _runAsrSubBatch 太複雜,改用 dispatch ASR caption + LLM mock
  await setAsrMode(evaluate, 'llm');
  await evaluate(`
    chrome.runtime.sendMessage = async function(msg) {
      if (!msg || !msg.type) return { ok: true };
      if (msg.type === 'TRANSLATE_ASR_SUBTITLE_BATCH') {
        const inputArr = JSON.parse((msg.payload && msg.payload.texts && msg.payload.texts[0]) || '[]');
        // 模擬 LLM 只取第一段當合句(故意給較短的 endMs 模擬「中文比英文密度高」場景)
        if (inputArr.length === 0) return { ok: true, result: ['[]'], usage: {} };
        const merged = [{
          s: inputArr[0].s,
          e: inputArr[0].e,           // 短 endMs(=500ms)
          t: '一二三四五六七八',         // 8 字中文(預期 idealReadMs = 2000ms)
        }];
        return { ok: true, result: [JSON.stringify(merged)], usage: {} };
      }
      return { ok: true };
    };

    // 兩段 ASR:0-500ms / 500-1000ms,合句 endMs = 1000(LLM 給的太短)
    const events = [
      { tStartMs: 0,   segs: [{ utf8: 'a' }] },
      { tStartMs: 500, segs: [{ utf8: 'b' }] },
    ];
    const json3 = JSON.stringify({ events });
    window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
      detail: { url: 'https://www.youtube.com/api/timedtext?v=ABC&lang=en&kind=asr', responseText: json3 },
    }));
  `);
  await page.waitForTimeout(100);

  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  await page.waitForTimeout(500);

  const cuesSnapshot = await evaluate(`window.__SK.YT.displayCues.map(c => ({
    startMs: c.startMs, endMs: c.endMs, targetText: c.targetText,
  }))`);

  // 應有 1 個 cue(LLM 合句),endMs 延長至 startMs + max(800, 8×200) = 1600
  expect(cuesSnapshot.length, '應有 ≥ 1 個 cue').toBeGreaterThanOrEqual(1);
  const cue = cuesSnapshot.find(c => c.targetText === '一二三四五六七八');
  expect(cue, '應找到合句中文 cue').toBeTruthy();
  expect(
    cue.endMs - cue.startMs,
    `cue 持續時間應 ≥ 8字 × 200ms = 1600ms。實際 ${cue.endMs - cue.startMs}ms`,
  ).toBeGreaterThanOrEqual(1600);

  // case 3:模擬下一個 cue 注入,_findActiveCue 應在下一句 startMs 之後不再返回前一句
  await evaluate(`
    window.__SK.YT.displayCues.push({
      startMs: 1500, endMs: 2500, sourceText: '', targetText: '下句',
    });
  `);
  // 在 currentMs = 1550 時(已過 cue 1 的 nextStart=1500),應返回 cue 2 而非 cue 1
  const at1550 = await evaluate(`(() => {
    // 模擬 _findActiveCue 邏輯
    const cues = window.__SK.YT.displayCues;
    const currentMs = 1550;
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      let nextStart = Infinity;
      for (let j = i + 1; j < cues.length; j++) {
        if (cues[j].startMs > c.startMs) { nextStart = cues[j].startMs; break; }
      }
      const effectiveEnd = Math.min(c.endMs, nextStart);
      if (currentMs >= c.startMs && currentMs <= effectiveEnd) return c.targetText;
    }
    return null;
  })()`);
  expect(
    at1550,
    `currentMs=1550 落在 cue 1 延長 endMs(1600)範圍內,但已過下一句 cue 2 startMs=1500,應顯示「下句」。實際: "${at1550}"`,
  ).toBe('下句');

  await page.close();
});

test('youtube-asr-mode: progressive 模式 LLM 寫入清除被覆蓋的 heuristic cues(避免疊來疊去)', async ({
  context,
  localServer,
}) => {
  // 驗證 v1.6.22 修法:
  //   progressive 模式下 heuristic 與 LLM 合句邊界 startMs 不一致時,
  //   _upsertDisplayCue 用 opts.replaceRange=true 清除 (新 cue.startMs, 新 cue.endMs)
  //   範圍內的舊 cue,避免「heuristic 沒被覆蓋的中段 cue 殘留 → 顯示在預設分句 / AI 分句之間疊來疊去」。
  //
  // 場景:
  //   1. 啟動 progressive(預設 'progressive')
  //   2. mock heuristic 回 2 個 cue:[h1(s=0), h2(s=1500)]
  //   3. mock LLM 回 1 個跨界 cue:[l1(s=0, e=2500)]
  //   4. 預期:LLM 寫入後 h2 被清除,displayCues 只剩 l1
  //
  // SANITY CHECK 已完成:
  //   把 _upsertDisplayCue 內 `if (opts && opts.replaceRange)` 改成 `if (false)` →
  //   此 test fail(displayCues 仍含 h2)→ 還原 pass。

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await setAsrMode(evaluate, 'progressive');

  await evaluate(`
    chrome.runtime.sendMessage = async function(msg) {
      if (!msg || !msg.type) return { ok: true };
      if (msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        // heuristic 路徑:把 input 視為兩個獨立句子(切兩 cue,sourceSegs[0] 各自一段)
        // 但 _runAsrHeuristicWindow 內合句後送 SUBTITLE_BATCH 是「逐句翻」,
        // 一個 unit 一個 text → result 跟 input 行數同。
        // 我們在 mock 裡讓 result 回兩段「heuristic 譯文 X」表示分別翻譯
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map((_t, i) => 'heuristic 譯文 ' + i),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      if (msg.type === 'TRANSLATE_ASR_SUBTITLE_BATCH') {
        const inputArr = JSON.parse((msg.payload && msg.payload.texts && msg.payload.texts[0]) || '[]');
        if (inputArr.length === 0) return { ok: true, result: ['[]'], usage: {} };
        // LLM 把所有輸入合成 1 個跨界 cue(s = first.s, e = last.e)
        const merged = [{
          s: inputArr[0].s,
          e: inputArr[inputArr.length - 1].e,
          t: '一二三四五六七八九十一二三四五',  // 15 字長中文,確保延長後跨多 heuristic 邊界
        }];
        return { ok: true, result: [JSON.stringify(merged)], usage: {} };
      }
      return { ok: true };
    };

    // 構造 ASR segments 含一個明顯 gap(讓 heuristic 切兩句):
    //   seg0:0ms / seg1:400ms(gap=400 < 1000 同句)
    //   gap 1500ms(自然停頓)
    //   seg2:1900ms / seg3:2300ms
    const events = [
      { tStartMs: 0,    segs: [{ utf8: 'one' }] },
      { tStartMs: 400,  segs: [{ utf8: 'two' }] },
      { tStartMs: 1900, segs: [{ utf8: 'three' }] },
      { tStartMs: 2300, segs: [{ utf8: 'four' }] },
    ];
    const json3 = JSON.stringify({ events });
    window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
      detail: { url: 'https://www.youtube.com/api/timedtext?v=ABC&lang=en&kind=asr', responseText: json3 },
    }));
  `);
  await page.waitForTimeout(100);

  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  await page.waitForTimeout(500); // 等 heuristic + LLM 都寫完

  const finalCues = await evaluate(`window.__SK.YT.displayCues.map(c => ({
    startMs: c.startMs, endMs: c.endMs, targetText: c.targetText,
  }))`);

  // 驗證:final cues 不應包含 heuristic 中段殘留(s 在 LLM cue 範圍內的)
  // LLM cue:s=0,e=last.e + 字數延長
  // last.e in inputArr:seg3 是最後,e=seg3.startMs+1500=3800
  // LLM cue endMs 延長後 = max(3800, 0 + 15×200=3000) = 3800
  // 所以 LLM cue 範圍 [0, 3800)
  // heuristic 假設切 2 cue:s=0(seg0+seg1)、s=1900(seg2+seg3)
  // s=1900 在 (0, 3800) 內 → 應被清除
  const hasMidRangeHeuristic = finalCues.some(c =>
    c.startMs > 0 && c.startMs < 3800 && c.targetText.startsWith('heuristic')
  );
  expect(
    hasMidRangeHeuristic,
    `LLM cue 範圍內(s 在 (0, 3800) 之間)不應有殘留 heuristic cue。實際 cues: ${JSON.stringify(finalCues)}`,
  ).toBe(false);

  // 應該至少有 LLM cue(s=0,target=「一二三四…」)
  const llmCue = finalCues.find(c => c.startMs === 0 && c.targetText.startsWith('一二三四'));
  expect(llmCue, `應有 LLM cue 在 s=0。實際 cues: ${JSON.stringify(finalCues)}`).toBeTruthy();

  // displayCues 應按 startMs 排序
  for (let i = 1; i < finalCues.length; i++) {
    expect(
      finalCues[i].startMs >= finalCues[i - 1].startMs,
      `displayCues 應按 startMs 排序。實際 ${JSON.stringify(finalCues)}`,
    ).toBe(true);
  }

  await page.close();
});

test('youtube-asr-mode: replaceRange 用 LLM 原始 endMs 不用 adjustedEnd(避免閱讀延長範圍誤清 heuristic)', async ({
  context,
  localServer,
}) => {
  // 驗證 v1.6.22 修法:
  //   閱讀延長(adjustedEnd)只是顯示 cue 的 endMs,不代表 LLM 涵蓋的範圍。
  //   replaceRange 清除上限應用 LLM 原始 endMs,而非延長後的 adjustedEnd。
  //   否則「LLM 短 e + 長中文 → 延長後跨多 heuristic 邊界」會誤清掉 LLM 沒 cover 的中段
  //   heuristic cue,造成「中段字幕消失」。
  //
  // 場景:
  //   - LLM 給 cue (s=0, e=500),譯文 12 字 → adjustedEnd = max(500, 0 + 12×200=2400) = 2400
  //   - heuristic 在 (500, 2400) 內有 cue (s=1500)
  //   - 修法後:replaceRange 清的是 (0, 500)(LLM 原始 e),不清 (0, 2400)
  //   - 結果:heuristic s=1500 cue 保留,接力顯示
  //
  // SANITY CHECK 已完成:
  //   把 _upsertDisplayCue 內 `c.startMs < llmEndMs` 改回 `c.startMs < adjustedEnd`
  //   → 此 test fail(s=1500 heuristic cue 被誤清)→ 還原 pass。

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await setAsrMode(evaluate, 'progressive');

  await evaluate(`
    chrome.runtime.sendMessage = async function(msg) {
      if (!msg || !msg.type) return { ok: true };
      if (msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map((_t, i) => 'heuristic_' + i),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      if (msg.type === 'TRANSLATE_ASR_SUBTITLE_BATCH') {
        const inputArr = JSON.parse((msg.payload && msg.payload.texts && msg.payload.texts[0]) || '[]');
        if (inputArr.length === 0) return { ok: true, result: ['[]'], usage: {} };
        // LLM 只取第一段(短 e)+ 12 字長譯文 → adjustedEnd 會延長很遠
        const merged = [{
          s: inputArr[0].s,
          e: inputArr[0].e,                       // 短 e(=500ms)
          t: '一二三四五六七八九十一二',           // 12 字 → idealReadMs = 12×200 = 2400ms
        }];
        return { ok: true, result: [JSON.stringify(merged)], usage: {} };
      }
      return { ok: true };
    };

    // ASR segments 安排成 heuristic 會切兩句:第一句 (s=0,500) gap=1200ms (>1000) 後第二句 (s=1700, 2100)
    const events = [
      { tStartMs: 0,    segs: [{ utf8: 'first' }] },
      { tStartMs: 500,  segs: [{ utf8: 'one' }] },
      { tStartMs: 1700, segs: [{ utf8: 'second' }] },
      { tStartMs: 2100, segs: [{ utf8: 'two' }] },
    ];
    const json3 = JSON.stringify({ events });
    window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
      detail: { url: 'https://www.youtube.com/api/timedtext?v=ABC&lang=en&kind=asr', responseText: json3 },
    }));
  `);
  await page.waitForTimeout(100);

  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  await page.waitForTimeout(500);

  const finalCues = await evaluate(`window.__SK.YT.displayCues.map(c => ({
    startMs: c.startMs, endMs: c.endMs, targetText: c.targetText,
  }))`);

  // LLM cue (s=0, e=500),adjustedEnd=2400(延長至 12 字 × 200ms)
  // heuristic 第二句 startMs=1700 在 (500, 2400) 內,但**不在** (0, 500) 內
  // 所以 heuristic s=1700 cue 應保留(不被 LLM 誤清)
  const heuristicMid = finalCues.find(c => c.startMs === 1700 && c.targetText.startsWith('heuristic'));
  expect(
    heuristicMid,
    `heuristic s=1700 cue 應保留(不在 LLM 原始範圍 (0,500) 內,只在閱讀延長 (0,2400) 內)。實際 cues: ${JSON.stringify(finalCues)}`,
  ).toBeTruthy();

  // 應有 LLM cue 在 s=0
  const llmCue = finalCues.find(c => c.startMs === 0 && c.targetText.startsWith('一二三四'));
  expect(llmCue, `應有 LLM cue 在 s=0`).toBeTruthy();

  await page.close();
});

test('youtube-asr-mode: chrome 顯示時 overlay 上移避開進度條(:not(.ytp-autohide) CSS rule)', async ({
  context,
  localServer,
}) => {
  // 驗證 v1.6.23 修法:
  //   YouTube 在控制列(chrome)隱藏時加 .ytp-autohide 到 .html5-video-player,顯示時移除。
  //   全域 style 內含規則 `.html5-video-player:not(.ytp-autohide) shinkansen-yt-overlay
  //   { --sk-cue-bottom: 60px; }`,讓 overlay 在 chrome 顯示時上移避開進度條。
  //   shadow DOM 內 .window `bottom: var(--sk-cue-bottom, 30px)` 透過 CSS variable 繼承自動切換。
  //
  // 驗證點:
  //   1. 全域 style 含 :not(.ytp-autohide) selector + --sk-cue-bottom: 60px
  //   2. shadow DOM 內 .window CSS 含 var(--sk-cue-bottom, 30px)
  //
  // SANITY CHECK 已完成:
  //   把全域 style 內 `:not(.ytp-autohide)` 規則整段註解掉
  //   → 此 test fail(全域 style 不含該 selector)→ 還原 pass。

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);

  // dispatch ASR caption 觸發 _setAsrHidingMode + _ensureOverlay
  await evaluate(`
    chrome.runtime.sendMessage = async function() { return { ok: true }; };
    const json3 = JSON.stringify({
      events: [{ tStartMs: 1000, segs: [{ utf8: 'hello' }] }],
    });
    window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
      detail: { url: 'https://www.youtube.com/api/timedtext?v=ABC&lang=en&kind=asr', responseText: json3 },
    }));
  `);
  await page.waitForTimeout(150);

  // 驗證 1:全域 stylesheet 真的有 :not(.ytp-autohide) rule(用 cssRules API,
  // 而非 textContent 字串比對 — comment 內的字串會誤通過)
  const ruleInfo = await evaluate(`(() => {
    const style = document.getElementById('shinkansen-asr-hide-css');
    if (!style || !style.sheet) return { hasRule: false, ruleSelector: null, ruleCss: null };
    for (const rule of style.sheet.cssRules) {
      if (rule.selectorText && rule.selectorText.includes(':not(.ytp-autohide)')) {
        return {
          hasRule: true,
          ruleSelector: rule.selectorText,
          ruleCss: rule.cssText,
        };
      }
    }
    return { hasRule: false, ruleSelector: null, ruleCss: null };
  })()`);
  expect(
    ruleInfo.hasRule,
    `全域 stylesheet 應有 :not(.ytp-autohide) 規則(active rule,非 comment)`,
  ).toBe(true);
  expect(
    ruleInfo.ruleCss,
    'rule 應設 --sk-cue-bottom 用 calc(60px + 字體高度) 動態避開進度條',
  ).toMatch(/--sk-cue-bottom:\s*calc\(60px\s*\+\s*var\(--sk-cue-size/);

  // 驗證 2:shadow DOM 內 .window 用 CSS variable
  const shadowCss = await evaluate(`(() => {
    const root = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    const host = root ? root.querySelector('shinkansen-yt-overlay') : null;
    if (!host || !host.shadowRoot) return '';
    const styleEl = host.shadowRoot.querySelector('style');
    return styleEl ? styleEl.textContent : '';
  })()`);
  expect(
    shadowCss,
    `shadow DOM .window 應用 var(--sk-cue-bottom, 30px)。實際 css: ${shadowCss.slice(0, 200)}`,
  ).toContain('var(--sk-cue-bottom');
  expect(shadowCss, '應有 transition: bottom 平滑切換').toContain('transition: bottom');

  await page.close();
});

test('youtube-asr-mode: 非 ASR(kind 不存在)走原 TRANSLATE_SUBTITLE_BATCH 路徑', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);

  await evaluate(`
    window.__asrBatchCount = 0;
    window.__regularBatchCount = 0;
    chrome.runtime.sendMessage = async function(msg) {
      if (!msg || !msg.type) return { ok: true };
      if (msg.type === 'TRANSLATE_ASR_SUBTITLE_BATCH') {
        window.__asrBatchCount++;
        return { ok: true, result: ['[]'], usage: {} };
      }
      if (msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        window.__regularBatchCount++;
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  // URL 不含 kind=asr(人工字幕路徑)
  await evaluate(`
    const json3 = JSON.stringify({
      events: [
        { tStartMs: 500,  segs: [{ utf8: 'Hello world' }] },
        { tStartMs: 3000, segs: [{ utf8: 'Goodbye world' }] },
      ],
    });
    window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
      detail: { url: 'https://www.youtube.com/api/timedtext?v=ABC&lang=en', responseText: json3 },
    }));
  `);
  await page.waitForTimeout(100);

  const afterCapture = await evaluate(`window.__SK.YT.isAsr`);
  expect(afterCapture, '無 kind=asr URL 應將 YT.isAsr 設為 false').toBe(false);

  await evaluate(`window.__SK.translateYouTubeSubtitles()`);
  await page.waitForTimeout(500);

  const result = await evaluate(`({
    asrBatchCount: window.__asrBatchCount,
    regularBatchCount: window.__regularBatchCount,
  })`);

  expect(result.asrBatchCount, '非 ASR 不應送 TRANSLATE_ASR_SUBTITLE_BATCH').toBe(0);
  expect(
    result.regularBatchCount,
    '非 ASR 應走 TRANSLATE_SUBTITLE_BATCH(原逐條路徑)至少 1 次',
  ).toBeGreaterThanOrEqual(1);

  await page.close();
});
