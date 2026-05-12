// Regression: v1.9.9 — 影片無 CC 字幕時的 toast 訊息正確
//
// 背景:v1.6.20 起 forceSubtitleReload(1s tick)會主動點開 CC button(_autoCcToggled=true),
// 所以 5s tick 仍 rawSegments=0 + captionMap=0 = 本影片真的沒字幕。
// 舊訊息「字幕翻譯已開啟。請開啟 YouTube 字幕(CC),翻譯將自動開始」對沒字幕影片
// 不可能達成,造成使用者混淆。
//
// 驗證:
//   1. translateYouTubeSubtitles 啟動後 ~5s 仍無字幕資料 → SK.showToast 被呼叫,
//      type='error',訊息為「本影片未提供 CC 字幕,無法翻譯字幕」(toast.subtitleNotAvailable)。
//   2. opts.autoHideMs 必須有值(error kind 預設不 auto-hide,沒傳會卡住不消失)。
//   3. 舊 i18n key toast.subtitleEnabled 已不存在(避免再被誤引用)。
//
// SANITY CHECK 已完成:
//   (a) 暫時把 'error' 改 'success' → test #1 fail(kind 對不上)→ 還原 pass。
//   (b) 暫時拔掉 { autoHideMs: 5000 } 參數 → test #1 fail(autoHideMs 斷言)→ 還原 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-auto-cc';

test('youtube-no-subtitle-toast: 5s 後仍無字幕資料 → 顯示「本影片未提供 CC 字幕」error toast', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);

  // 攔 sendMessage(避免動到實際 background)+ 攔 showToast 收集呼叫
  await evaluate(`
    chrome.runtime.sendMessage = async function() { return { ok: true }; };
    window.__toastCalls = [];
    const _origShowToast = window.__SK.showToast;
    window.__SK.showToast = function(kind, msg, opts) {
      window.__toastCalls.push({ kind, msg, opts });
      // 不實際渲染 DOM,避免 toast Shadow DOM 干擾
    };
    // 攔 CC button click 避免實際 toggle 觸發其他 side effect
    const btn = document.querySelector('.ytp-subtitles-button');
    btn.click = function() {};
  `);

  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);

  // 5s setTimeout + 些許 buffer
  await page.waitForTimeout(5500);

  const result = await evaluate(`({
    toastCalls: window.__toastCalls,
    active: window.__SK.YT.active,
    rawSegments: window.__SK.YT.rawSegments.length,
    captionMapSize: window.__SK.YT.captionMap.size,
  })`);

  expect(result.active, '翻譯流程應啟動').toBe(true);
  expect(result.rawSegments, 'fixture 不含字幕資料,rawSegments 應為 0').toBe(0);
  expect(result.captionMapSize, 'captionMap 也應為空').toBe(0);

  const noAvailToast = result.toastCalls.find(
    (c) => c.kind === 'error' && /本影片未提供 CC 字幕/.test(c.msg),
  );
  expect(
    noAvailToast,
    `5s 後應顯示「本影片未提供 CC 字幕」error toast。實際 toast 呼叫: ${JSON.stringify(result.toastCalls)}`,
  ).toBeTruthy();

  // error kind 預設不 auto-hide,必須帶 autoHideMs 否則 toast 卡住
  // (showToast 內 success kind 走 5s 預設 hide,error 沒明確 autoHideMs 就永遠不消失)
  expect(
    noAvailToast.opts && noAvailToast.opts.autoHideMs,
    `error toast 必須帶 opts.autoHideMs 否則不會自動消失。實際 opts: ${JSON.stringify(noAvailToast.opts)}`,
  ).toBeGreaterThan(0);

  // 反向斷言:不應再出現舊的「請開啟 YouTube 字幕(CC)」success toast
  const oldEnabledToast = result.toastCalls.find(
    (c) => /請開啟 YouTube 字幕/.test(c.msg),
  );
  expect(oldEnabledToast, '舊「請開啟 YouTube 字幕」訊息已不應出現').toBeUndefined();

  await page.close();
});

test('youtube-no-subtitle-toast: 舊 i18n key toast.subtitleEnabled 已移除', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // SK.t 找不到 key 時 fallback 回傳 key 本身 → 用這個特性驗 key 已刪
  const result = await evaluate(`({
    enabledKey: window.__SK.t('toast.subtitleEnabled'),
    notAvailKey: window.__SK.t('toast.subtitleNotAvailable'),
  })`);

  expect(
    result.enabledKey,
    'toast.subtitleEnabled 應已刪除(SK.t fallback 應回傳 key 本身)',
  ).toBe('toast.subtitleEnabled');
  expect(
    result.notAvailKey,
    'toast.subtitleNotAvailable 應存在且回傳譯文',
  ).not.toBe('toast.subtitleNotAvailable');
  expect(result.notAvailKey).toMatch(/本影片未提供 CC 字幕/);

  await page.close();
});
