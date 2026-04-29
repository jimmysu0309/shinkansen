// Regression: 雙語模式 reload 後 ASR stylesheet 必須注入(v1.8.16)
//
// 症狀(Jimmy 2026-04-29 回報):雙語字幕模式下 reload ASR 字幕影片,中文 overlay
// 跟原生英文 CC 重疊在 30px 高度,看不到上下分層。toggle bilingual off→on 後就錯開。
//
// 根因:_setAsrHidingMode 原本只在 active=true(純中文模式)分支注入 stylesheet,
// 注入時機是「啟用 ASR hiding 時順便把所有 ASR 相關 CSS rule 一起塞進去」。但雙語模式
// reload 後直接走 _applyBilingualMode(true) → _setAsrHidingMode(false) → 走 else 分支
// 只 removeClass 不注入 → host[bilingual] 上抬 90px 的 CSS rule 從來不存在 →
// overlay --sk-cue-bottom 維持 default 30px → 跟原生 30-40px CC 重疊。
//
// popup toggle off→on 之所以救得回:第一次 off 走 active=true 分支注入 stylesheet
// (idempotent 之後不重複),host[bilingual] rule 進 DOM;之後 on 雖再走 false
// 分支但 stylesheet 已在 DOM。
//
// 修法(v1.8.16):stylesheet 注入抽成 _ensureAsrStylesheet(),_setAsrHidingMode 入口
// 無條件 call,active true/false 兩條分支都確保 CSS rule 存在。
//
// SANITY CHECK 已完成(v1.8.16 dedicated):
//   把修法還原成只有 active=true 分支注入 → 雙語直接啟動時 stylesheet 不存在,
//   spec 斷言 #shinkansen-asr-hide-css 存在 / 含 host[bilingual] rule 兩條 fail。
//   還原修法後兩條 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-spa-navigate'; // 共用既有 fixture(.html5-video-player + .ytp-caption-window-container 已備)

test('youtube-bilingual-reload-stylesheet: 雙語直接啟動(沒走過純中文)→ stylesheet 仍注入 + host[bilingual] CSS rule 存在', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-content', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 模擬 reload 後直接進雙語 ASR 路徑:
  //   1. 設 YT.config.bilingualMode=true
  //   2. 設 YT.isAsr=true(避開 ASR check)
  //   3. 直接呼叫 _applyBilingualMode 透過 SK 暴露(下方 setup)
  // 但 _applyBilingualMode 不是 SK 暴露的——改走 caption-event handler 觸發?
  // 太重。改用 SK._setAsrHidingMode(false) 直接驗 stylesheet 注入是否 idempotent
  // 兩個分支都生。
  await evaluate(`
    window.__SK.YT.config = window.__SK.YT.config || {};
    window.__SK.YT.config.bilingualMode = true;
    window.__SK.YT.isAsr = true;
  `);

  // 直接觸發 _setAsrHidingMode(false) 路徑(雙語模式呼叫的就是這條)。
  // 為驗 stylesheet 是否注入,需要從 isolated world 找到那個 closure 內 fn——
  // 改透過 storage onChanged listener 走 toggle 路徑(line 2292),這條會 reapply。
  // 但 toggle listener 走 active+isAsr 才 reapply,所以先設 active=true。
  await evaluate(`window.__SK.YT.active = true`);

  // 驗 stylesheet 在 setAsrHidingMode(false) 路徑下也應存在:
  //   觸發雙語 toggle 模擬 reload 後 _applyBilingualMode(true) 路徑
  await evaluate(`
    window.__SK._testStorageChange = (newVal) => {
      const fakeChanges = { ytSubtitle: { newValue: newVal, oldValue: {} } };
      // 直接 dispatch 走 listener
      const listeners = window.__SK._storageListeners || [];
      // 真實情境是 chrome.storage.onChanged.addListener 自己派發 — 我們另一條路:
      // 直接走 _applyBilingualMode 但它在 closure 內。
      // 折衷:在 spec 內手動模擬 stylesheet inject 的入口邏輯—
      // 直接驗 _setAsrHidingMode 是否被暴露,沒暴露就 skip 此 spec 並改驗 host attr。
    };
  `);

  // 直接觸發 storage.onChanged 流程:寫 ytSubtitle.bilingualMode=false 模擬「toggle off」
  // 但 spec 在 isolated world 沒 chrome.storage 完整環境。改用更直接的測法:
  // 走完整 caption-event 路徑 — dispatch shinkansen-yt-captions 帶 ASR URL,
  // handler 進 _ensureOverlay + _applyBilingualMode(true) 一條鞭走完。
  await evaluate(`
    window.__SK.YT.rawSegments = [];
    window.__SK.YT.config = { bilingualMode: true, windowSizeS: 30, lookaheadS: 10 };
    window.__SK.YT.isAsr = false; // 讓 caption-event handler 從 URL 重新判斷
    window.__SK.YT.active = true;
    // 模擬 ASR 字幕 response(json3 格式最小化)
    const fakeResponse = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello' }] },
        { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'world' }] },
      ],
    });
    window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
      detail: { url: '/api/timedtext?kind=asr&v=test', responseText: fakeResponse },
    }));
  `);

  // 等 handler 跑完(async)
  await page.waitForTimeout(300);

  // 斷言 1:stylesheet 已注入(無論走哪條分支)
  const styleExists = await evaluate(`!!document.getElementById('shinkansen-asr-hide-css')`);
  expect(styleExists, '#shinkansen-asr-hide-css 應已注入(雙語直接啟動也要)').toBe(true);

  // 斷言 2:stylesheet 內含 host[bilingual] CSS rule(避開原生 CC 上抬 90px)
  const hasBilingualRule = await evaluate(`
    (() => {
      const el = document.getElementById('shinkansen-asr-hide-css');
      if (!el) return false;
      const text = el.textContent || '';
      return /shinkansen-yt-overlay\\[bilingual\\]\\s*\\{/.test(text)
          && /--sk-cue-bottom:\\s*90px/.test(text);
    })()
  `);
  expect(hasBilingualRule, 'stylesheet 應包含 host[bilingual] { --sk-cue-bottom: 90px } rule').toBe(true);

  // 斷言 3:overlay host 已設 [bilingual] attribute
  const hostBilingualAttr = await evaluate(`
    document.querySelector('shinkansen-yt-overlay')?.getAttribute('bilingual')
  `);
  expect(hostBilingualAttr, 'overlay host 應有 bilingual="true" attribute').toBe('true');

  await page.close();
});
