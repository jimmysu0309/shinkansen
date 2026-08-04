// Regression: v1.8.40 YouTube 字幕原文已是繁中時跳過 Gemini 翻譯
//
// 痛點:使用者勾「自動翻譯字幕」後,即使影片字幕本身已是繁中(zh-Hant /
// zh-TW / zh-HK / zh-MO),Shinkansen 仍照送 Gemini 翻譯一次,浪費 token。
//
// 修法位置:shinkansen/content-youtube.js
//   1. shinkansen-yt-captions listener 從 caption URL 抓 lang 存進 YT.captionLang
//   2. translateWindowFrom 入口加 _shouldSkipBecauseAlreadyTraditionalChinese()
//      命中就 return + log 'skip translate: caption already readable for target'
//   3. SKIP_LANGS_BY_TARGET['zh-TW'] = { zh-Hant, zh-TW, zh-HK, zh-MO, zh-Hans, zh-CN, zh-SG }
//
// v2.0.72 產品決策翻轉:target=zh-TW 時簡中系(zh-Hans / zh-CN / zh-SG)也 skip
//   ——繁中使用者可直接閱讀簡中字幕,簡轉繁的 API 花費不值得。模糊 `zh` 軌的
//   內容偵測補判同步:偵測到繁中「或簡中」都 skip。僅字幕路徑;整頁翻譯的
//   簡中段落仍照翻(isAlreadyInTarget 不動,見 target-source-lang-skip.spec.js)。
//
// 不在範圍(維持送 Gemini):
//   其他語言(en / ja / ...)
//   target=zh-CN 的繁中字幕(維持 LLM 繁轉簡,本次只改 zh-TW 方向)
//
// 結構通則:本 spec 鎖「URL 帶明確繁中 lang 代碼 → 不送 TRANSLATE_SUBTITLE_BATCH」
// 行為,不依賴 class/id 名稱啟發式。
//
// SANITY CHECK 紀錄(已驗證,2026-05-04):
//   把 _shouldSkipBecauseAlreadyTraditionalChinese 改成永遠回 false → 即使
//   captionLang=zh-Hant,translateWindowFrom 仍會跑 → TRANSLATE_SUBTITLE_BATCH
//   被呼叫 → spec fail。還原後 pass。
//
// v1.8.53 補:鎖「翻譯中…」status 不殘留(原 bug:skip 路徑不寫 captionMap,
//   replaceSegmentEl 永遠拿不到 cached → hideCaptionStatus 永不觸發,
//   「翻譯中…」永久殘留)。SANITY(已驗證 2026-05-05):
//   把 _shouldShowTranslatingStatus 改成永遠回 true + 移掉 skip 路徑的
//   hideCaptionStatus → status case fail。還原後 pass。
//
// v1.9.3 補:URL lang=`zh`(模糊 base lang)時靠內容偵測補判 — YouTube 對部分
//   人工字幕只標 lang=zh 不附 -Hant/-Hans variant(實測影片 OR4nfW-LPDA 即此例),
//   舊邏輯 captionLang='zh' 不在 SKIP_LANGS_BY_TARGET 集合 → 不 skip → 字幕原本
//   已是繁中還照送 Gemini + 「翻譯中…」殘留。修法:_shouldSkipBecauseAlreadyInTarget
//   對 target ∈ {zh-TW, zh-CN} + lang='zh' 時走 SK.isAlreadyInTarget 內容偵測。
//   SANITY(已驗證 2026-05-11):把 _AMBIGUOUS_LANGS_BY_TARGET['zh-TW'] 改成空集合
//   → trad+lang=zh 那條 fail(TRANSLATE_SUBTITLE_BATCH 被呼叫)。還原後 pass。
//
// review C4 SANITY(已驗證 2026-08-04):暫時把 XHR listener 的 captionLang 改回只讀
//   lang(不折 tlang)→ 「自動翻譯軌 lang=en&tlang=zh-Hant」case fail(TRANSLATE_SUBTITLE_BATCH
//   被呼叫 2 次 = 燒 token 翻自己)。還原後 pass;captionLang=en 對照組確保無 tlang 軌不誤殺。
//
// v2.0.72 SANITY(已驗證 2026-07-30):同時破壞兩處——(1) SKIP_LANGS_BY_TARGET['zh-TW']
//   拿掉 zh-Hans/zh-CN/zh-SG;(2) 模糊 zh 分支的 detectTextLang 判斷改 if(false) 還原成
//   只走 isAlreadyInTarget → 正好 4 條新 case fail(zh-Hans / zh-CN / zh-SG 三條
//   TRANSLATE_SUBTITLE_BATCH 被呼叫 + lang=zh 簡中內容 target=zh-TW 被呼叫),
//   既有 8 條不受影響。還原後 12 條全 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-innertube-fetch';
const VIDEO_ID = 'testABC1234';

const MOCK_JSON3 = JSON.stringify({
  events: [
    { tStartMs: 0,    segs: [{ utf8: '這是繁體中文字幕第一句' }] },
    { tStartMs: 3000, segs: [{ utf8: '這是繁體中文字幕第二句' }] },
    { tStartMs: 6000, segs: [{ utf8: '這是繁體中文字幕第三句' }] },
  ],
});

// v1.9.3 內容偵測 fixture:lang=zh 模糊標籤時靠這些 sample 跑 SK.detectTextLang
// 繁中 sample 內無 SIMPLIFIED_ONLY_CHARS 命中字,簡中 sample 命中比例遠 > 0.2
const MOCK_JSON3_TRAD_CONTENT = JSON.stringify({
  events: [
    { tStartMs: 0,    segs: [{ utf8: '對真正懂行的玩家而言這個問題並不存在' }] },
    { tStartMs: 3000, segs: [{ utf8: '他們認為應該如此而且車體設計極為精緻' }] },
    { tStartMs: 6000, segs: [{ utf8: '唯一的問題在於價格與供應量遠超出預期' }] },
  ],
});
const MOCK_JSON3_SIMP_CONTENT = JSON.stringify({
  events: [
    { tStartMs: 0,    segs: [{ utf8: '对真正懂行的玩家而言这个问题并不存在' }] },
    { tStartMs: 3000, segs: [{ utf8: '他们认为应该如此而且车体设计极为精致' }] },
    { tStartMs: 6000, segs: [{ utf8: '唯一的问题在于价格与供应量远超出预期' }] },
  ],
});

test.describe('youtube-skip-already-zh-hant', () => {
  // v2.0.72: 簡中系(zh-Hans / zh-CN / zh-SG)也進 skip 名單
  for (const lang of ['zh-Hant', 'zh-TW', 'zh-HK', 'zh-MO', 'zh-Hans', 'zh-CN', 'zh-SG']) {
    test(`captionLang=${lang} → 不送 TRANSLATE_SUBTITLE_BATCH`, async ({ context, localServer }) => {
      const page = await context.newPage();
      await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.ytp-caption-window-container', { timeout: 10_000, state: 'attached' });

      const { evaluate } = await getShinkansenEvaluator(page);
      await evaluate(`window.__SK.isYouTubePage = () => true`);

      // Mock TRANSLATE_SUBTITLE_BATCH:應該不被呼叫
      await evaluate(`
        window.__translateBatchCalled = 0;
        chrome.runtime.sendMessage = async function(msg) {
          if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
            window.__translateBatchCalled++;
            const texts = (msg.payload && msg.payload.texts) || [];
            return { ok: true, result: texts.map(t => '[ZH] ' + t),
              usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                       billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 }};
          }
          if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH_STREAM') {
            return { ok: false, error: 'streaming disabled in test' };
          }
          return { ok: true };
        };
      `);

      await evaluate(`window.__SK.translateYouTubeSubtitles()`);

      // 觸發 caption 攔截:URL 含 lang=${lang}
      await evaluate(`
        window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
          detail: {
            url: 'https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=${lang}',
            responseText: ${JSON.stringify(MOCK_JSON3)},
          }
        }));
      `);

      // 等可能的翻譯路徑跑完(skip 路徑只 ~50ms,送 API 路徑 ~500ms)
      await page.waitForTimeout(800);

      const calls = await evaluate(`window.__translateBatchCalled`);
      expect(
        calls,
        `captionLang=${lang} 應 skip 翻譯,TRANSLATE_SUBTITLE_BATCH 不該被呼叫,實際 ${calls} 次`,
      ).toBe(0);

      // captionLang 應已被 listener 抓到並存進 YT state
      const captionLang = await evaluate(`window.__SK.YT.captionLang`);
      expect(captionLang, `YT.captionLang 應為 '${lang}'`).toBe(lang);

      // v1.8.53: 「翻譯中…」status 不該殘留
      // (原 bug:show 觸發但 skip 路徑不寫 captionMap → hideCaptionStatus 永不觸發)
      const statusEl = await evaluate(`
        (() => {
          const el = document.getElementById('__sk-yt-caption-status');
          return el ? el.textContent : null;
        })()
      `);
      expect(
        statusEl,
        `captionLang=${lang} skip 翻譯時「翻譯中…」status 不該殘留,實際 textContent=${JSON.stringify(statusEl)}`,
      ).toBeNull();

      await page.close();
    });
  }

  test('captionLang=en → 仍送 TRANSLATE_SUBTITLE_BATCH(對照組,確保 skip 條件不誤殺)', async ({ context, localServer }) => {
    const page = await context.newPage();
    await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ytp-caption-window-container', { timeout: 10_000, state: 'attached' });

    const { evaluate } = await getShinkansenEvaluator(page);
    await evaluate(`window.__SK.isYouTubePage = () => true`);

    await evaluate(`
      window.__translateBatchCalled = 0;
      chrome.runtime.sendMessage = async function(msg) {
        if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
          window.__translateBatchCalled++;
          const texts = (msg.payload && msg.payload.texts) || [];
          return { ok: true, result: texts.map(t => '[ZH] ' + t),
            usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                     billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 }};
        }
        if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH_STREAM') {
          return { ok: false, error: 'streaming disabled in test' };
        }
        return { ok: true };
      };
    `);

    await evaluate(`window.__SK.translateYouTubeSubtitles()`);

    await evaluate(`
      window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
        detail: {
          url: 'https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=en',
          responseText: ${JSON.stringify(MOCK_JSON3)},
        }
      }));
    `);

    // 等翻譯啟動(en 應該真的送 API)
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const c = await evaluate(`window.__translateBatchCalled`);
      if (c > 0) break;
      await page.waitForTimeout(50);
    }

    const calls = await evaluate(`window.__translateBatchCalled`);
    expect(
      calls,
      `captionLang=en 應送 TRANSLATE_SUBTITLE_BATCH,實際 ${calls} 次`,
    ).toBeGreaterThan(0);

    // v1.8.53: 確保英文路徑「翻譯中…」status 仍會顯示
    // (防 _shouldShowTranslatingStatus 的 guard 把非繁中也誤擋)
    const statusText = await evaluate(`
      (() => {
        const el = document.getElementById('__sk-yt-caption-status');
        return el ? el.textContent : null;
      })()
    `);
    expect(
      statusText,
      `captionLang=en 應顯示「翻譯中…」status,實際 ${JSON.stringify(statusText)}`,
    ).toBe('翻譯中…');

    await page.close();
  });

  test('自動翻譯軌 lang=en&tlang=zh-Hant → 不送 TRANSLATE_SUBTITLE_BATCH(review C4,語言身份看 tlang)', async ({ context, localServer }) => {
    // 自動翻譯軌 URL 形態經真實 YT 頁 probe 驗證(2026-08-04):lang=<原軌>&tlang=<目標>,
    // body 已是 tlang 語言。舊 code 只看 lang → captionLang='en' 不 skip,把已是繁中的
    // 內容再送 Gemini 翻一次(燒 token 翻自己)。上面 captionLang=en 對照組確保修法
    // 沒把無 tlang 的英文軌一起誤殺。
    const page = await context.newPage();
    await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ytp-caption-window-container', { timeout: 10_000, state: 'attached' });

    const { evaluate } = await getShinkansenEvaluator(page);
    await evaluate(`window.__SK.isYouTubePage = () => true`);

    await evaluate(`
      window.__translateBatchCalled = 0;
      chrome.runtime.sendMessage = async function(msg) {
        if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
          window.__translateBatchCalled++;
          const texts = (msg.payload && msg.payload.texts) || [];
          return { ok: true, result: texts.map(t => '[ZH] ' + t),
            usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                     billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 }};
        }
        if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH_STREAM') {
          return { ok: false, error: 'streaming disabled in test' };
        }
        return { ok: true };
      };
    `);

    await evaluate(`window.__SK.translateYouTubeSubtitles()`);

    await evaluate(`
      window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
        detail: {
          url: 'https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=en&tlang=zh-Hant',
          responseText: ${JSON.stringify(MOCK_JSON3)},
        }
      }));
    `);
    await page.waitForTimeout(800);

    const calls = await evaluate(`window.__translateBatchCalled`);
    expect(
      calls,
      `tlang=zh-Hant 自動翻譯軌應 skip 翻譯,TRANSLATE_SUBTITLE_BATCH 不該被呼叫,實際 ${calls} 次`,
    ).toBe(0);
    const captionLang = await evaluate(`window.__SK.YT.captionLang`);
    expect(captionLang, 'captionLang 應為 tlang 值 zh-Hant').toBe('zh-Hant');

    await page.close();
  });

  // v1.9.3 模糊 lang fallback:lang=zh 時靠內容偵測補判 ─────────
  // 4 個交叉 case 確保 _AMBIGUOUS_LANGS_BY_TARGET fallback 正確:
  //   trad content + target=zh-TW → skip(實機觸發 v1.9.3 bug 的場景)
  //   simp content + target=zh-TW → skip(v2.0.72 翻轉:簡中字幕不翻)
  //   simp content + target=zh-CN → skip
  //   trad content + target=zh-CN → 不 skip(LLM 繁轉簡)

  async function _setupSkipFallbackPage({ context, localServer, target, fixtureJson, lang }) {
    const page = await context.newPage();
    await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ytp-caption-window-container', { timeout: 10_000, state: 'attached' });

    const { evaluate } = await getShinkansenEvaluator(page);
    await evaluate(`window.__SK.isYouTubePage = () => true`);
    await evaluate(`window.__SK.STATE.targetLanguage = ${JSON.stringify(target)}`);

    await evaluate(`
      window.__translateBatchCalled = 0;
      chrome.runtime.sendMessage = async function(msg) {
        if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
          window.__translateBatchCalled++;
          const texts = (msg.payload && msg.payload.texts) || [];
          return { ok: true, result: texts.map(t => '[' + ${JSON.stringify(target)} + '] ' + t),
            usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                     billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 }};
        }
        if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH_STREAM') {
          return { ok: false, error: 'streaming disabled in test' };
        }
        return { ok: true };
      };
    `);

    await evaluate(`window.__SK.translateYouTubeSubtitles()`);

    await evaluate(`
      window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
        detail: {
          url: 'https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=${lang}',
          responseText: ${fixtureJson},
        }
      }));
    `);

    return { page, evaluate };
  }

  test('lang=zh + 繁中內容 + target=zh-TW → skip(模糊 lang fallback,本次實機 bug)', async ({ context, localServer }) => {
    const { page, evaluate } = await _setupSkipFallbackPage({
      context, localServer, target: 'zh-TW', fixtureJson: MOCK_JSON3_TRAD_CONTENT, lang: 'zh',
    });

    // skip 路徑只跑 ~50ms;送 API 路徑 ~500ms+,給 800ms 等
    await page.waitForTimeout(800);

    const calls = await evaluate(`window.__translateBatchCalled`);
    expect(
      calls,
      `lang=zh + 繁中內容 + target=zh-TW 應 skip(本次 OR4nfW-LPDA 實機 bug),實際 ${calls} 次`,
    ).toBe(0);

    const captionLang = await evaluate(`window.__SK.YT.captionLang`);
    expect(captionLang).toBe('zh');

    const statusEl = await evaluate(`
      (() => { const el = document.getElementById('__sk-yt-caption-status'); return el ? el.textContent : null; })()
    `);
    expect(
      statusEl,
      `lang=zh + 繁中內容 skip 翻譯時「翻譯中…」status 不該殘留,實際 textContent=${JSON.stringify(statusEl)}`,
    ).toBeNull();

    await page.close();
  });

  test('lang=zh + 簡中內容 + target=zh-TW → skip(v2.0.72 簡中字幕不翻)', async ({ context, localServer }) => {
    const { page, evaluate } = await _setupSkipFallbackPage({
      context, localServer, target: 'zh-TW', fixtureJson: MOCK_JSON3_SIMP_CONTENT, lang: 'zh',
    });

    await page.waitForTimeout(800);

    const calls = await evaluate(`window.__translateBatchCalled`);
    expect(
      calls,
      `lang=zh + 簡中內容 + target=zh-TW 應 skip(v2.0.72 簡中字幕不翻),實際 ${calls} 次`,
    ).toBe(0);

    const statusEl = await evaluate(`
      (() => { const el = document.getElementById('__sk-yt-caption-status'); return el ? el.textContent : null; })()
    `);
    expect(
      statusEl,
      `lang=zh + 簡中內容 skip 翻譯時「翻譯中…」status 不該殘留,實際 textContent=${JSON.stringify(statusEl)}`,
    ).toBeNull();

    await page.close();
  });

  test('lang=zh + 簡中內容 + target=zh-CN → skip', async ({ context, localServer }) => {
    const { page, evaluate } = await _setupSkipFallbackPage({
      context, localServer, target: 'zh-CN', fixtureJson: MOCK_JSON3_SIMP_CONTENT, lang: 'zh',
    });

    await page.waitForTimeout(800);

    const calls = await evaluate(`window.__translateBatchCalled`);
    expect(
      calls,
      `lang=zh + 簡中內容 + target=zh-CN 應 skip,實際 ${calls} 次`,
    ).toBe(0);

    await page.close();
  });

  test('lang=zh + 繁中內容 + target=zh-CN → 不 skip(LLM 繁轉簡)', async ({ context, localServer }) => {
    const { page, evaluate } = await _setupSkipFallbackPage({
      context, localServer, target: 'zh-CN', fixtureJson: MOCK_JSON3_TRAD_CONTENT, lang: 'zh',
    });

    const start = Date.now();
    while (Date.now() - start < 5000) {
      const c = await evaluate(`window.__translateBatchCalled`);
      if (c > 0) break;
      await page.waitForTimeout(50);
    }

    const calls = await evaluate(`window.__translateBatchCalled`);
    expect(
      calls,
      `lang=zh + 繁中內容 + target=zh-CN 應送 API(繁轉簡),實際 ${calls} 次`,
    ).toBeGreaterThan(0);

    await page.close();
  });
});
