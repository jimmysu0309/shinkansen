// Regression: v1.10.46 批次 3-1 — 字幕來源切換時視窗簿記不失效
//             + 批次 3-10 — captionLang / captionSourceId 未在 stop / SPA reset 清除
//
// 痛點（3-1）：雙語流程官方指引就是教使用者手動切 CC 軌；切完之後：
//   - 舊軌的 translatedWindows 是純時間 key → 新軌在「已翻」視窗被誤跳過，完全不翻
//   - 舊軌 captionMap / displayCues 譯文殘顯
//   - in-flight 舊軌批次完成後仍把 windowStartMs 標進 translatedWindows（同上誤跳過）
//
// 修法位置：shinkansen/content-youtube.js
//   1. SK.YT 新欄位 captionSourceId(videoId|lang|kind)/ captionSourceGen
//   2. shinkansen-yt-captions listener 比對來源身份，變更即 _resetCaptionSourceBookkeeping
//      (translatedWindows / translatingWindows / captionMap / pendingQueue / displayCues /
//       translatedUpToMs / captionMapCoverageUpToMs 全清 + gen bump)
//   3. translateWindowFrom 開頭快照 captionSourceGen，結尾比對——世代已變不標 translatedWindows
//   4. chooser 'switch' 分支同步走 _resetCaptionSourceBookkeeping
//   5. stop / SPA reset 清 captionLang + captionSourceId(3-10，新影片不可殘留前一支的 lang)
//
// 結構通則：鎖「來源身份（videoId+lang+kind）變更 → 簿記重置」行為，不依賴站點 class/id。
// 同軌 re-fetch（seek / CC toggle 重抓，身份相同）不得重置——case 2 反向保護。
//
// 訊號層界定：本 spec 驗 isolated world 內的 state 轉移與完整 translateWindowFrom 路徑
// （gen guard case 走真實 in-flight 批次），不驗真實 YouTube 播放器切軌時 XHR 的觸發時序。
//
// SANITY 紀錄（已驗證，2026-06-11）:
//   (a) 暫時註解 XHR listener 的 `_resetCaptionSourceBookkeeping('source switched', ...)`
//       → case 1 fail（translatedWindows / captionMap 未被清）→ 還原 pass。
//   (b) 暫時把 translateWindowFrom 結尾的 `_myCaptionGen !== (YT.captionSourceGen || 0)`
//       分支拿掉 → case 3 fail（舊軌 in-flight 完成後仍標 translatedWindows）→ 還原 pass。
// SANITY 紀錄（case 6 / review C4,已驗證 2026-08-04）:
//   暫時把 XHR listener 的 captionLang 改回只讀 lang(不折 tlang)→ case 6 fail
//   （captionLang='en',sourceId 與原軌相同不重置）→ 還原 pass。
//   自動翻譯軌 URL 形態(lang=en&tlang=zh-Hant)經真實 YT 頁 probe 驗證(2026-08-04,
//   jNQXAC9IVRw 切「英文→中文(繁體)」自動翻譯軌抓 timedtext request)。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-innertube-fetch';
const VIDEO_ID = 'testABC1234';

const JSON3_EN = JSON.stringify({
  events: [
    { tStartMs: 0,    segs: [{ utf8: 'Hello world' }] },
    { tStartMs: 3000, segs: [{ utf8: 'This is a test' }] },
  ],
});
const JSON3_JA = JSON.stringify({
  events: [
    { tStartMs: 0,    segs: [{ utf8: 'こんにちは世界' }] },
    { tStartMs: 3000, segs: [{ utf8: 'これはテストです' }] },
  ],
});

function dispatchCaptions(lang, json3) {
  return `
    window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
      detail: {
        url: 'https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=${lang}',
        responseText: ${JSON.stringify(json3)},
      }
    }));
  `;
}

async function setupPage(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html?v=${VIDEO_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ytp-caption-window-container', { timeout: 10_000, state: 'attached' });
  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);
  return { page, evaluate };
}

test.describe('youtube-caption-source-switch', () => {
  test('case 1: 來源身份變更（en → ja）→ 視窗簿記與譯文全部重置 + gen bump', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    // 第一軌（en）進來，建立來源身份
    await evaluate(dispatchCaptions('en', JSON3_EN));
    await page.waitForTimeout(100);

    // 模擬「舊軌已翻過一些視窗」的簿記狀態
    await evaluate(`
      const YT = window.__SK.YT;
      YT.translatedWindows.add(0);
      YT.translatedWindows.add(30000);
      YT.captionMap.set('hello world', '哈囉世界');
      YT.displayCues.push({ startMs: 0, endMs: 3000, sourceText: 'Hello world', targetText: '哈囉世界' });
      YT.translatedUpToMs = 60000;
      window.__genBefore = YT.captionSourceGen;
    `);

    // 切軌：第二軌（ja）進來 → 簿記應全部重置
    await evaluate(dispatchCaptions('ja', JSON3_JA));
    await page.waitForTimeout(100);

    const r = await evaluate(`
      (() => {
        const YT = window.__SK.YT;
        return {
          translatedWindowsSize: YT.translatedWindows.size,
          captionMapSize: YT.captionMap.size,
          displayCuesLen: YT.displayCues.length,
          translatedUpToMs: YT.translatedUpToMs,
          genBumped: YT.captionSourceGen > window.__genBefore,
          captionLang: YT.captionLang,
          rawSegmentsLen: YT.rawSegments.length,
        };
      })()
    `);
    expect(r.translatedWindowsSize, '舊軌 translatedWindows 應被清空').toBe(0);
    expect(r.captionMapSize, '舊軌 captionMap 譯文應被清空').toBe(0);
    expect(r.displayCuesLen, '舊軌 displayCues 應被清空').toBe(0);
    expect(r.translatedUpToMs, 'translatedUpToMs 應歸零').toBe(0);
    expect(r.genBumped, 'captionSourceGen 應遞增').toBe(true);
    expect(r.captionLang, '新軌 lang 應為 ja').toBe('ja');
    expect(r.rawSegmentsLen, '新軌 rawSegments 應已載入').toBe(2);

    await page.close();
  });

  test('case 2: 同軌 re-fetch（身份相同）→ 簿記保留不重置（seek / CC toggle 不得掉進度）', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    await evaluate(dispatchCaptions('en', JSON3_EN));
    await page.waitForTimeout(100);
    await evaluate(`
      const YT = window.__SK.YT;
      YT.translatedWindows.add(0);
      YT.captionMap.set('hello world', '哈囉世界');
      window.__genBefore = YT.captionSourceGen;
    `);

    // 同 lang 同 kind re-fetch
    await evaluate(dispatchCaptions('en', JSON3_EN));
    await page.waitForTimeout(100);

    const r = await evaluate(`
      (() => {
        const YT = window.__SK.YT;
        return {
          translatedWindowsHas0: YT.translatedWindows.has(0),
          captionMapHit: YT.captionMap.get('hello world'),
          genUnchanged: YT.captionSourceGen === window.__genBefore,
        };
      })()
    `);
    expect(r.translatedWindowsHas0, '同軌 re-fetch 不得清 translatedWindows').toBe(true);
    expect(r.captionMapHit, '同軌 re-fetch 不得清 captionMap').toBe('哈囉世界');
    expect(r.genUnchanged, '同軌 re-fetch 不得 bump gen').toBe(true);

    await page.close();
  });

  test('case 3: in-flight 舊軌批次完成 → gen guard 擋下 translatedWindows 標記（完整 translateWindowFrom 路徑）', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    // 舊軌（en）只給 1 段 → 整個視窗只有 1 批，resolve 後舊 run 能完整走到 epilogue
    // （多段會讓 batch 1+ 卡在 permanent pending，舊 run 永遠到不了 translatedWindows
    //  決策點，gen guard 斷言空轉——SANITY 驗證時抓到的 spec 弱點）
    const JSON3_EN_SINGLE = JSON.stringify({
      events: [{ tStartMs: 0, segs: [{ utf8: 'Hello world' }] }],
    });

    // mock：第一個批次掛起（可手動 resolve），之後的批次永遠 pending
    // → 舊軌（en）的 translateWindowFrom 卡在 in-flight，期間切軌（ja）
    await evaluate(`
      window.__calls = [];
      window.__resolve1 = null;
      chrome.runtime.sendMessage = async function(msg) {
        if (msg && (msg.type === 'TRANSLATE_SUBTITLE_BATCH')) {
          window.__calls.push(msg.payload.texts);
          if (window.__calls.length === 1) {
            return new Promise(res => {
              window.__resolve1 = () => res({ ok: true,
                result: msg.payload.texts.map(t => '[ZH] ' + t),
                usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                         billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 } });
            });
          }
          return new Promise(() => {}); // 後續批次（新軌）permanent pending，排除干擾
        }
        if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH_STREAM') {
          return { ok: false, error: 'streaming disabled in test' };
        }
        return { ok: true };
      };
      window.__SK.YT.active = true;
    `);

    // 舊軌（en）captions 進來 → active → translateWindowFrom 啟動 → 第一批 in-flight
    await evaluate(dispatchCaptions('en', JSON3_EN_SINGLE));
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const n = await evaluate(`window.__calls.length`);
      if (n >= 1) break;
      await page.waitForTimeout(50);
    }
    expect(await evaluate(`window.__calls.length`), '舊軌第一批應已送出').toBeGreaterThanOrEqual(1);

    // 切軌（ja）→ 簿記重置 + gen bump（新軌自己的批次 permanent pending，不會標視窗）
    await evaluate(dispatchCaptions('ja', JSON3_JA));
    await page.waitForTimeout(100);

    // 放行舊軌批次 → 舊 run 完成（輪詢 batchApiMs 確認真的走完）,gen 已變，
    // 不得標 translatedWindows
    await evaluate(`window.__resolve1 && window.__resolve1()`);
    const start2 = Date.now();
    while (Date.now() - start2 < 5000) {
      const done = await evaluate(`window.__SK.YT.batchApiMs.length === 1 && window.__SK.YT.batchApiMs[0] > 0`);
      if (done) break;
      await page.waitForTimeout(50);
    }
    expect(
      await evaluate(`window.__SK.YT.batchApiMs.length === 1 && window.__SK.YT.batchApiMs[0] > 0`),
      '舊 run 應完整走完（batchApiMs 同步代表 epilogue 已到）',
    ).toBe(true);
    await page.waitForTimeout(200);

    const r = await evaluate(`
      (() => {
        const YT = window.__SK.YT;
        return {
          translatedWindowsSize: YT.translatedWindows.size,
          windows: Array.from(YT.translatedWindows),
        };
      })()
    `);
    expect(
      r.translatedWindowsSize,
      `舊軌 in-flight 批次完成後不得標 translatedWindows（實際： ${JSON.stringify(r.windows)})`,
    ).toBe(0);

    await page.close();
  });

  test('case 4(3-10): stopYouTubeTranslation 應清 captionLang + captionSourceId', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    await evaluate(dispatchCaptions('en', JSON3_EN));
    await page.waitForTimeout(100);
    expect(await evaluate(`window.__SK.YT.captionLang`)).toBe('en');

    await evaluate(`window.__SK.stopYouTubeTranslation()`);
    const r = await evaluate(`
      ({ captionLang: window.__SK.YT.captionLang, captionSourceId: window.__SK.YT.captionSourceId })
    `);
    expect(r.captionLang, 'stop 後 captionLang 應為 null').toBeNull();
    expect(r.captionSourceId, 'stop 後 captionSourceId 應為 null').toBeNull();

    await page.close();
  });

  test('case 5(3-10): SPA reset 應清 captionLang + captionSourceId', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    await evaluate(dispatchCaptions('en', JSON3_EN));
    await page.waitForTimeout(100);
    expect(await evaluate(`window.__SK.YT.captionLang`)).toBe('en');

    // active=false + videoId 不同 → 不走 skip path，走 reset path
    await evaluate(`window.__SK.YT.videoId = 'otherVideo99'`);
    await evaluate(`window.dispatchEvent(new CustomEvent('yt-navigate-finish'))`);
    await page.waitForTimeout(300);

    const r = await evaluate(`
      ({ captionLang: window.__SK.YT.captionLang, captionSourceId: window.__SK.YT.captionSourceId })
    `);
    expect(r.captionLang, 'SPA reset 後 captionLang 應為 null').toBeNull();
    expect(r.captionSourceId, 'SPA reset 後 captionSourceId 應為 null').toBeNull();

    await page.close();
  });

  test('case 6(review C4): 切 YT 自動翻譯軌(lang=en → lang=en&tlang=zh-Hant)→ 身份變更重置 + captionLang=tlang', async ({ context, localServer }) => {
    // 自動翻譯軌 URL 形態經真實 YT 頁 probe 驗證(2026-08-04):lang=<原軌>&tlang=<目標>,
    // body 已是 tlang 語言。舊 code sourceId 只含 lang → 與原軌同 id,mid-session 切
    // 自動翻譯軌不重置簿記;captionLang 也停在 'en' → skip 判斷失效(把 zh-Hant 內容
    // 再送 Gemini 翻一次)。修法:tlang 存在時折進 captionLang(sourceId 用 captionLang
    // 組,連帶修正)。
    const { page, evaluate } = await setupPage(context, localServer);

    // 原軌(en)進來,建立來源身份 + 模擬已翻視窗簿記
    await evaluate(dispatchCaptions('en', JSON3_EN));
    await page.waitForTimeout(100);
    await evaluate(`
      const YT = window.__SK.YT;
      YT.translatedWindows.add(0);
      YT.captionMap.set('hello world', '哈囉世界');
      window.__genBefore = YT.captionSourceGen;
    `);

    // 切「英文 → 自動翻譯 → 中文(繁體)」軌:同 lang=en 但多 tlang=zh-Hant
    const JSON3_ZH_HANT = JSON.stringify({
      events: [
        { tStartMs: 0,    segs: [{ utf8: '哈囉世界' }] },
        { tStartMs: 3000, segs: [{ utf8: '這是一個測試' }] },
      ],
    });
    await evaluate(`
      window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
        detail: {
          url: 'https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=en&tlang=zh-Hant',
          responseText: ${JSON.stringify(JSON3_ZH_HANT)},
        }
      }));
    `);
    await page.waitForTimeout(100);

    const r = await evaluate(`
      (() => {
        const YT = window.__SK.YT;
        return {
          captionLang: YT.captionLang,
          translatedWindowsSize: YT.translatedWindows.size,
          captionMapSize: YT.captionMap.size,
          genBumped: YT.captionSourceGen > window.__genBefore,
          sourceId: YT.captionSourceId,
        };
      })()
    `);
    expect(r.captionLang, '自動翻譯軌語言身份應以 tlang 為準').toBe('zh-Hant');
    expect(r.sourceId, 'sourceId 應含 tlang 語言(與原軌不同 id)').toContain('zh-Hant');
    expect(r.translatedWindowsSize, '舊軌 translatedWindows 應被清空(身份變更)').toBe(0);
    expect(r.captionMapSize, '舊軌 captionMap 應被清空(身份變更)').toBe(0);
    expect(r.genBumped, 'captionSourceGen 應遞增').toBe(true);

    await page.close();
  });
});
