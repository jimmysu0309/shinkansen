// Regression: youtube-caption-color-sync(對應 v2.0.85 修的「YouTube 字幕樣式設定的
// 字型顏色/背景顏色在 Shinkansen overlay 上無效」bug)
//
// Fixture: test/regression/fixtures/youtube-caption-color-sync.html
// 結構:最小 player DOM,.ytp-caption-segment 帶 inline color(黃)/ background-color
//       (綠 50%)——模擬 YouTube 字幕樣式設定的合成結果(顏色 × 透明度)。
// Bug:overlay shadow CSS 硬編 color:#fff / background:rgba(0,0,0,0.75),使用者在
//      YouTube 設定的字幕顏色被 overlay 無視(overlay 路徑:ASR 純中文 / ASR 雙語 /
//      non-ASR 雙語都中)。
// 修法:比照 _readNativeCaptionFontSize 的「原生字幕是單一事實」pattern——
//      _readNativeCaptionColors 讀 segment computed color / background-color(帶
//      last-good cache),_applyNativeCaptionColors 寫進 host CSS var
//      --sk-cue-color / --sk-cue-bg,shadow .cue-block 消費(fallback 維持舊硬編值);
//      兩個同步點(_updateOverlay ASR / _updateNonAsrBilingualOverlay)都呼叫。
//
// 訊號層界定:本 spec 驗「讀取邏輯 + CSS var 消費 + 兩個同步點的呼叫」,不驗真實
// YouTube 設定面板寫入 inline style 的行為(YouTube 內部實作)與真實影片播放時序。
//
// SANITY 紀錄(已驗證):
//   ① _applyNativeCaptionColors 內兩行 setProperty 註解掉 → case 1(computed 背景/
//      文字色維持硬編預設)與 case 3 / case 4(host var 空)fail;還原後全綠
//   ② 單獨把 _updateOverlay 內 _applyNativeCaptionColors(host) 呼叫註解掉 →
//      case 3(ASR 同步點)fail、case 4 仍綠;還原後全綠
//   ③ 單獨把 _updateNonAsrBilingualOverlay 內呼叫註解掉 → case 4 fail、case 3 仍綠;
//      還原後全綠
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-caption-color-sync';
const SEG_COLOR = 'rgb(255, 255, 0)';
const SEG_BG = 'rgba(0, 128, 0, 0.5)';

async function openFixture(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  return { page, evaluate };
}

test('youtube-caption-color-sync (case 1): 讀 segment 顏色 → host CSS var → shadow .cue-block computed 生效', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await openFixture(context, localServer);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      SK._resetCaptionColorsCache();
      // 先建 overlay(寫一筆內容讓 .cue-block 可量測),再套顏色
      SK._setOverlayContent('中文譯文', 'source line');
      const host = document.querySelector('shinkansen-yt-overlay');
      SK._applyNativeCaptionColors(host);
      const read = SK._readNativeCaptionColors();
      const block = host.shadowRoot.querySelector('.cue-block');
      const cs = getComputedStyle(block);
      return {
        readColor: read && read.color,
        readBg: read && read.background,
        varColor: host.style.getPropertyValue('--sk-cue-color'),
        varBg: host.style.getPropertyValue('--sk-cue-bg'),
        blockColor: cs.color,
        blockBg: cs.backgroundColor,
      };
    })()
  `);

  expect(result.readColor).toBe(SEG_COLOR);
  expect(result.readBg).toBe(SEG_BG);
  expect(result.varColor).toBe(SEG_COLOR);
  expect(result.varBg).toBe(SEG_BG);
  // shadow CSS var 消費端真的生效(不是只有 var 寫上去)
  expect(result.blockColor).toBe(SEG_COLOR);
  expect(result.blockBg).toBe(SEG_BG);
  await page.close();
});

test('youtube-caption-color-sync (case 2): 空窗期沿用 last-good;從沒讀到回 null → fallback 硬編預設', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await openFixture(context, localServer);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      SK._resetCaptionColorsCache();
      // 先讀一次(segment 在場)
      const first = SK._readNativeCaptionColors();
      // 模擬無字幕空窗:segment 移除後仍應回上次有效值
      const seg = document.querySelector('.ytp-caption-segment');
      seg.remove();
      const gap = SK._readNativeCaptionColors();
      // 從沒讀到過(cache 清空 + 無 segment):回 null,不寫 var
      SK._resetCaptionColorsCache();
      const never = SK._readNativeCaptionColors();
      SK._setOverlayContent('中文譯文');
      const host = document.querySelector('shinkansen-yt-overlay');
      host.style.removeProperty('--sk-cue-color');
      host.style.removeProperty('--sk-cue-bg');
      SK._applyNativeCaptionColors(host);
      const block = host.shadowRoot.querySelector('.cue-block');
      const cs = getComputedStyle(block);
      return {
        gapColor: gap && gap.color, gapBg: gap && gap.background,
        never,
        varColor: host.style.getPropertyValue('--sk-cue-color'),
        blockColor: cs.color,
        blockBg: cs.backgroundColor,
      };
    })()
  `);

  // 空窗期 last-good
  expect(result.gapColor).toBe(SEG_COLOR);
  expect(result.gapBg).toBe(SEG_BG);
  // 從沒讀到 → null → var 不寫 → shadow fallback = 舊硬編預設(視覺不回退)
  expect(result.never).toBe(null);
  expect(result.varColor).toBe('');
  expect(result.blockColor).toBe('rgb(255, 255, 255)');
  expect(result.blockBg).toBe('rgba(0, 0, 0, 0.75)');
  await page.close();
});

test('youtube-caption-color-sync (case 3): ASR 同步點 _updateOverlay 套用顏色', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await openFixture(context, localServer);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      SK._resetCaptionColorsCache();
      // ASR 純中文模式(使用者回報的主場景)最小狀態
      SK.YT.active = true;
      SK.YT.isAsr = true;
      SK.YT.ccPaused = false;
      SK.YT.videoEl = document.querySelector('video');
      SK.YT.config = { bilingualMode: false };
      SK.YT.displayCues = [{ startMs: 0, endMs: 5000, sourceText: 'Hello world', targetText: '中文譯文' }];
      SK._updateAsrOverlay();
      const host = document.querySelector('shinkansen-yt-overlay');
      return {
        varColor: host && host.style.getPropertyValue('--sk-cue-color'),
        varBg: host && host.style.getPropertyValue('--sk-cue-bg'),
        tgtText: host && host.shadowRoot.querySelector('.tgt').textContent,
      };
    })()
  `);

  expect(result.tgtText).toBe('中文譯文');
  expect(result.varColor).toBe(SEG_COLOR);
  expect(result.varBg).toBe(SEG_BG);
  await page.close();
});

test('youtube-caption-color-sync (case 4): non-ASR 雙語同步點 _updateNonAsrBilingualOverlay 套用顏色', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await openFixture(context, localServer);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      SK._resetCaptionColorsCache();
      SK.YT.active = true;
      SK.YT.isAsr = false;
      SK.YT.config = { bilingualMode: true };
      SK.YT.captionMap.clear();
      SK.YT.captionMap.set('hello world', '中文譯文');
      SK._updateNonAsrBilingualOverlay();
      const host = document.querySelector('shinkansen-yt-overlay');
      return {
        varColor: host && host.style.getPropertyValue('--sk-cue-color'),
        varBg: host && host.style.getPropertyValue('--sk-cue-bg'),
      };
    })()
  `);

  expect(result.varColor).toBe(SEG_COLOR);
  expect(result.varBg).toBe(SEG_BG);
  await page.close();
});
