// Regression: 真實 bug 回報(OHAjc-ayhus 類型)— 影片同時有 native EN + native zh-Hant 字幕,
//             YT 帳號預設顯示 EN。修法前:_chooseBestCaptionTrack P1 命中無條件 skip,
//             Shinkansen 不啟動翻譯,使用者繼續看沒翻的英文字幕。
//             修法後:active 不是 P1 native 軌時 → action='switch-to-native',
//             caller 主動 dispatch setOption 切到 zh-Hant 軌,然後 stopYouTubeTranslation
//             (讓 YT 直接顯示原生中文,Shinkansen 不必跑翻譯)。
//
// 驗證(integration,蓋 unit test 之外的 caller dispatch + stop wiring):
//   case 1: native zh-Hant + active=en → setOption 被叫一次(切到 zh-Hant)+ YT.active=false
//   case 2: native zh-Hant + active 已是 zh-Hant → 不 setOption(skip path)+ YT.active=false
//   case 3: 純 en ASR(無 P1)+ active=null → setOption 切到 en(switch path)+ YT.active=true
//           (對照組,確保 switch-to-native 改動沒誤觸發到一般 switch path)
//
// case 4(bilingual): bilingual + native zh-Hant + active=en → switch-to-native 切到 zh-Hant
//   但 YT.active 保持 true(不 stop,留 Shinkansen 監聽,等使用者後續手動切到非 target 軌)
// case 5(bilingual): bilingual + native zh-Hant + active 已是 zh-Hant → skip
//   YT.active 保持 true(同 case 4,留監聽)
//
// SANITY CHECK(已驗證):
//   把 caller `decision.action === 'switch-to-native'` 從 dispatch 條件拔掉
//     → case 1 fail(__setCaptionCalls 為空,沒切到 zh-Hant)→ 還原 pass

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-native-target-switch';
const VIDEO_ID = 'testVidNTS';

async function setupPage(context, localServer, { captionTracks, activeTrack, target = 'zh-TW', bilingualMode = false }) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html?v=${VIDEO_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  // captionTracks + activeTrack 塞到 MAIN world(bridge listener 讀得到)
  await page.evaluate(({ captionTracks, activeTrack, videoId }) => {
    window.ytInitialPlayerResponse = {
      videoDetails: { videoId },
      captions: {
        playerCaptionsTracklistRenderer: { captionTracks },
      },
    };
    window.__activeTrack = activeTrack;
  }, { captionTracks, activeTrack, videoId: VIDEO_ID });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await evaluate(`window.__SK.STATE = window.__SK.STATE || {}; window.__SK.STATE.targetLanguage = ${JSON.stringify(target)};`);

  // stub storage.sync.get:getYtConfig 讀 'ytSubtitle',chooser flow 讀 'targetLanguage'
  await evaluate(`
    chrome.runtime.sendMessage = async function() { return { ok: true }; };
    const _origGet = (browser.storage && browser.storage.sync && browser.storage.sync.get) || null;
    browser.storage.sync.get = async function(key) {
      if (key === 'targetLanguage') return { targetLanguage: ${JSON.stringify(target)} };
      // v2.0.85:getYtConfig 改讀 ['ytSubtitle', 'displayMode'],bilingual 由
      // displayMode === 'dual' 導出(spec 的 bilingualMode 參數對映 displayMode)
      const wantsYt = key === 'ytSubtitle' || (Array.isArray(key) && key.includes('ytSubtitle'));
      if (wantsYt) return {
        ytSubtitle: { preferOriginalTrack: true },
        displayMode: ${bilingualMode ? "'dual'" : "'single'"},
      };
      return _origGet ? _origGet(key) : {};
    };
    chrome.storage.sync.get = browser.storage.sync.get;
    const btn = document.querySelector('.ytp-subtitles-button');
    if (btn) btn.click = function() {};
  `);
  return { page, evaluate };
}

test('case 1: native zh-Hant + active=en → setOption 切到 zh-Hant + YT.active=false', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer, {
    captionTracks: [
      { languageCode: 'en',      kind: '' },
      { languageCode: 'zh-Hant', kind: '' },
    ],
    activeTrack: { languageCode: 'en', kind: '', translationLanguageCode: null },
    target: 'zh-TW',
  });

  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  await page.waitForTimeout(1200);  // chooser bridge 來回 + setOption dispatch

  // __setCaptionCalls 在 MAIN world(fixture inline script 設),用 page.evaluate 讀;
  // window.__SK 在 ISOLATED world,用 evaluate(CDP isolated context)讀。
  const setCalls = await page.evaluate(() => window.__setCaptionCalls || []);
  const ytActive = await evaluate(`window.__SK.YT.active`);
  expect(
    setCalls.length,
    `應 dispatch setOption 切到 zh-Hant(active=en)。實際: ${JSON.stringify(setCalls)}`,
  ).toBe(1);
  expect(setCalls[0].languageCode).toBe('zh-Hant');
  expect(setCalls[0].kind).toBe('');
  expect(
    ytActive,
    'switch-to-native 完應 stopYouTubeTranslation → YT.active=false',
  ).toBe(false);

  await page.close();
});

test('case 2: native zh-Hant + active 已是 zh-Hant → 不 setOption(skip)+ YT.active=false', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer, {
    captionTracks: [
      { languageCode: 'en',      kind: '' },
      { languageCode: 'zh-Hant', kind: '' },
    ],
    activeTrack: { languageCode: 'zh-Hant', kind: '', translationLanguageCode: null },
    target: 'zh-TW',
  });

  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  await page.waitForTimeout(1200);

  const setCalls = await page.evaluate(() => window.__setCaptionCalls || []);
  const ytActive = await evaluate(`window.__SK.YT.active`);
  expect(
    setCalls.length,
    `active 已是 zh-Hant → 不該 setOption(避免重複切軌觸發 reload)。實際: ${JSON.stringify(setCalls)}`,
  ).toBe(0);
  expect(ytActive, 'skip path 仍 stopYouTubeTranslation → YT.active=false').toBe(false);

  await page.close();
});

test('case 3: 純 en ASR(無 P1)+ active=null → setOption 切到 en + YT.active=true(對照組)', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer, {
    captionTracks: [
      { languageCode: 'en', kind: 'asr' },
    ],
    activeTrack: null,
    target: 'zh-TW',
  });

  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  await page.waitForTimeout(1200);

  const setCalls = await page.evaluate(() => window.__setCaptionCalls || []);
  const ytActive = await evaluate(`window.__SK.YT.active`);
  // 一般 switch path(P3:en ASR)
  expect(setCalls.length).toBe(1);
  expect(setCalls[0].languageCode).toBe('en');
  expect(setCalls[0].kind).toBe('asr');
  // switch path 後 caller 不 stop,繼續走翻譯流程
  expect(
    ytActive,
    '一般 switch path 應保持 YT.active=true(走翻譯流程)',
  ).toBe(true);

  await page.close();
});

test('case 4(bilingual): native zh-Hant + active=en + bilingual=true → switch-to-native 切到 zh-Hant + YT.active 保持 true(不 stop)', async ({ context, localServer }) => {
  // 真實 bug 情境:OHAjc-ayhus 類型(全 manual + 多語)+ user 帳號偏好 en + bilingual on。
  // 修法後:chooser P1 仍命中 → switch-to-native 切到 zh-Hant,但 caller 在 bilingual 不 stop。
  // 留 Shinkansen 監聽,使用者後續手動從 CC 選單切到 ja/en 時自動翻譯 + overlay 啟動。
  const { page, evaluate } = await setupPage(context, localServer, {
    captionTracks: [
      { languageCode: 'en',      kind: '' },
      { languageCode: 'zh-Hant', kind: '' },
    ],
    activeTrack: { languageCode: 'en', kind: '', translationLanguageCode: null },
    target: 'zh-TW',
    bilingualMode: true,
  });

  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  await page.waitForTimeout(1200);

  const setCalls = await page.evaluate(() => window.__setCaptionCalls || []);
  const ytActive = await evaluate(`window.__SK.YT.active`);
  // P1 命中 → switch-to-native 切到 zh-Hant(bilingual 不影響 chooser)
  expect(setCalls.length).toBe(1);
  expect(setCalls[0].languageCode).toBe('zh-Hant');
  expect(setCalls[0].kind).toBe('');
  // bilingual:不 stop,保持 active 等使用者切軌
  expect(
    ytActive,
    'bilingual + switch-to-native 不該 stop(留監聽等使用者切到非 target 軌)',
  ).toBe(true);

  await page.close();
});

test('case 5(bilingual): native zh-Hant + active 已是 zh-Hant + bilingual=true → skip(不 setOption)+ YT.active 保持 true', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer, {
    captionTracks: [
      { languageCode: 'en',      kind: '' },
      { languageCode: 'zh-Hant', kind: '' },
    ],
    activeTrack: { languageCode: 'zh-Hant', kind: '', translationLanguageCode: null },
    target: 'zh-TW',
    bilingualMode: true,
  });

  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  await page.waitForTimeout(1200);

  const setCalls = await page.evaluate(() => window.__setCaptionCalls || []);
  const ytActive = await evaluate(`window.__SK.YT.active`);
  expect(setCalls.length, 'active 已對齊 → 不 setOption').toBe(0);
  // bilingual:不 stop(同 case 4 留監聽)
  expect(ytActive, 'bilingual + skip 不該 stop').toBe(true);

  await page.close();
});

test('case 6(bilingual + _applyBilingualMode dynamic hide): captionLang=zh-Hant 時 _setAsrHidingMode 應為 false(不藏 native CC)', async ({ context, localServer }) => {
  // 直接驗 _applyBilingualMode 在 captionLang=target 時不藏 native CC(動態 hide 邏輯)。
  // 走法:設 YT 狀態 captionLang=zh-Hant,呼 _applyBilingualMode(true),
  // 檢查 _setAsrHidingMode 沒把 root 加上 hiding class(等同沒藏 native)。
  const { page, evaluate } = await setupPage(context, localServer, {
    captionTracks: [
      { languageCode: 'zh-Hant', kind: '' },
    ],
    activeTrack: { languageCode: 'zh-Hant', kind: '', translationLanguageCode: null },
    target: 'zh-TW',
    bilingualMode: true,
  });

  await evaluate(`
    window.__SK.YT.captionLang = 'zh-Hant';
    window.__SK.YT.isAsr = false;
    window.__SK.STATE = window.__SK.STATE || {};
    window.__SK.STATE.targetLanguage = 'zh-TW';
    window.__SK._applyBilingualMode(true);
  `);
  // _setAsrHidingMode 加在 player root 的 class 是 'shinkansen-asr-active';caption 是 target 應為 false
  const hidingClass = await page.evaluate(() => {
    const root = document.querySelector('#movie_player');
    return root ? root.className : null;
  });
  expect(
    hidingClass,
    `bilingual + captionLang=zh-Hant(target)→ 不該加 hiding class。實際 className: ${hidingClass}`,
  ).not.toMatch(/shinkansen-asr-active/);

  await page.close();
});

test('case 7(bilingual + dynamic hide 對照組): captionLang=ja(非 target)時 _setAsrHidingMode 應為 true(藏 native)', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer, {
    captionTracks: [
      { languageCode: 'ja', kind: '' },
    ],
    activeTrack: { languageCode: 'ja', kind: '', translationLanguageCode: null },
    target: 'zh-TW',
    bilingualMode: true,
  });

  await evaluate(`
    window.__SK.YT.captionLang = 'ja';
    window.__SK.YT.isAsr = false;
    window.__SK.STATE = window.__SK.STATE || {};
    window.__SK.STATE.targetLanguage = 'zh-TW';
    window.__SK._applyBilingualMode(true);
  `);
  const hidingClass = await page.evaluate(() => {
    const root = document.querySelector('#movie_player');
    return root ? root.className : null;
  });
  expect(
    hidingClass,
    `bilingual + captionLang=ja(非 target)→ 應加 hiding class。實際: ${hidingClass}`,
  ).toMatch(/shinkansen-asr-active/);

  await page.close();
});

test('case 8(bilingual ja source → overlay): _updateNonAsrBilingualOverlay 應把 ja segment 寫進 src + 對應 zh 寫進 tgt(不再被 RE_CJK guard 誤殺)', async ({ context, localServer }) => {
  // Pre-existing bug:_updateNonAsrBilingualOverlay 用 RE_CJK 過濾源文,
  // 直接誤殺 ja / ko / zh-Hans 等含 CJK chars 的源語 → ja 源 overlay 永遠空。
  // 真機驗證(OHAjc-ayhus):移除 RE_CJK guard 後 overlay src 顯示「あぁどうしようもないほどに私に蠢く獣」
  // tgt 顯示「啊,在我體內蠢蠢欲動的野獸,簡直無可救藥」。
  const { page, evaluate } = await setupPage(context, localServer, {
    captionTracks: [{ languageCode: 'ja', kind: '' }],
    activeTrack: { languageCode: 'ja', kind: '', translationLanguageCode: null },
    target: 'zh-TW',
    bilingualMode: true,
  });

  // 注 ja segment + 預填 captionMap 翻譯。然後呼叫 _updateNonAsrBilingualOverlay
  // 看 overlay 是否填上 ja src + zh tgt。
  const result = await evaluate(`
    (async () => {
      const cw = document.querySelector('.ytp-caption-window-container');
      cw.innerHTML = '<div class="ytp-caption-segment">あぁどうしようもないほどに</div>';
      window.__SK.YT.captionLang = 'ja';
      window.__SK.YT.isAsr = false;
      window.__SK.YT.active = true;
      window.__SK.STATE = window.__SK.STATE || {};
      window.__SK.STATE.targetLanguage = 'zh-TW';
      if (!window.__SK.YT.config) window.__SK.YT.config = {};
      window.__SK.YT.config.bilingualMode = true;
      // 預填 captionMap:key 是 normText(原文)。normText = collapse空白+trim+toLowerCase,
      // ja 文字無空白且非字母大小寫,結果跟原文相同(僅 trim)。content-youtube.js line 446 定義。
      const normText = (t) => t.replace(/\\s+/g, ' ').trim().toLowerCase();
      const key = normText('あぁどうしようもないほどに');
      window.__SK.YT.captionMap = new Map([[key, '啊,在我體內蠢蠢欲動的野獸,簡直無可救藥']]);
      // 確保 overlay 存在
      window.__SK._applyBilingualMode(true);
      window.__SK._updateNonAsrBilingualOverlay();
      return { mapKey: key };
    })()
  `);

  // 在 main world 讀 overlay shadow DOM
  const overlay = await page.evaluate(() => {
    const host = document.querySelector('shinkansen-yt-overlay');
    const tgt = host?.shadowRoot?.querySelector('.tgt');
    const src = host?.shadowRoot?.querySelector('.src');
    return {
      tgtText: tgt?.textContent,
      srcText: src?.textContent,
      srcHidden: src?.hasAttribute('hidden'),
    };
  });

  expect(
    overlay.tgtText,
    `bilingual + ja source + captionMap 有翻譯 → tgt 應填 zh 譯文。實際: ${JSON.stringify(overlay)} / mapKey=${result.mapKey}`,
  ).toBe('啊,在我體內蠢蠢欲動的野獸,簡直無可救藥');
  expect(overlay.srcText, 'src 應填 ja 原文').toBe('あぁどうしようもないほどに');
  expect(overlay.srcHidden, 'non-ASR 雙語 src 應顯示(不該 hidden)').toBe(false);

  await page.close();
});
