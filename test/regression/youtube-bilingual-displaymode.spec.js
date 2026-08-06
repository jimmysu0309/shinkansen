// Regression: youtube-bilingual-displaymode(對應 v2.0.85「字幕雙語對照與顯示模式合併」)
//
// Fixture: test/regression/fixtures/youtube-bilingual-displaymode.html
// 背景:v2.0.85 前字幕雙語有獨立 popup toggle(ytSubtitle.bilingualMode),與整頁翻譯
//      「顯示模式」(displayMode)語意撞名,使用者(含 Jimmy 本人)混淆——開了顯示模式
//      雙語對照,字幕仍純中文。依 CLAUDE.md 工作流原則 §5 收斂單一資料源:
//      toggle 移除,bilingualMode 唯一來源 = displayMode === 'dual'。
// 修法:getYtConfig 讀 ['ytSubtitle','displayMode'] 導出 bilingualMode(舊
//      ytSubtitle.bilingualMode 殘留 key 忽略);storage.onChanged 監聽 displayMode
//      live 切換;ytSubtitle 全量合併時保留導出值不被洗掉。
//
// 訊號層界定:驗 content-youtube.js 的導出/監聽邏輯;content-drive.js 為同款導出的
// 鏡像實作(設定載入在 drive.google.com hostname gate 之後,fixture 驅動不到),
// 不重複驅動。popup toggle UI 已刪除,無 UI 層可驗。
//
// SANITY 紀錄(已驗證):
//   ① getYtConfig 拿掉 `bilingualMode: saved.displayMode === 'dual'` 導出行 →
//      case 1 fail(legacy key 蓋過導出值)+ case 3 fail(初始導出即失效);還原 pass
//   ② onChanged 的 changes.displayMode 分支整段註解 → case 2 fail(config 不更新、
//      host 無 bilingual attr);還原 pass
//   ③ onChanged 的 ytSubtitle 全量合併改回舊式 `{ ...DEFAULT_YT_CONFIG, ...newVal }`
//      (不保留導出值)→ case 3 fail(bilingualMode 被洗掉);還原 pass
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-bilingual-displaymode';

async function openFixture(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  return { page, evaluate };
}

async function pollUntil(evaluate, page, expr, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await evaluate(expr)) return true;
    await page.waitForTimeout(50);
  }
  return false;
}

test('bilingual-displaymode (case 1): getYtConfig 由 displayMode 導出,legacy ytSubtitle.bilingualMode 忽略', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await openFixture(context, localServer);

  // displayMode=dual + legacy key false → 導出 true(displayMode 贏)
  await evaluate(`chrome.storage.sync.set({ displayMode: 'dual', ytSubtitle: { bilingualMode: false } })`);
  const dual = await evaluate(`
    (async () => {
      window.__SK.YT.config = null;
      const cfg = await window.__SK._getYtConfig();
      return cfg.bilingualMode;
    })()
  `);
  expect(dual).toBe(true);

  // displayMode=single + legacy key true → 導出 false(殘留 key 不得復活雙語)
  await evaluate(`chrome.storage.sync.set({ displayMode: 'single', ytSubtitle: { bilingualMode: true } })`);
  const single = await evaluate(`
    (async () => {
      window.__SK.YT.config = null;
      const cfg = await window.__SK._getYtConfig();
      return cfg.bilingualMode;
    })()
  `);
  expect(single).toBe(false);
  await page.close();
});

test('bilingual-displaymode (case 2): displayMode live 切換 → config 更新 + _applyBilingualMode 生效', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await openFixture(context, localServer);

  await evaluate(`chrome.storage.sync.set({ displayMode: 'single' })`);
  await evaluate(`
    (async () => {
      const SK = window.__SK;
      SK.YT.config = null;
      await SK._getYtConfig();
      SK.YT.active = true;
      SK.YT.isAsr = true;
    })()
  `);

  // 模擬使用者在 popup 切顯示模式 → 雙語對照(真實寫入路徑:sync.displayMode)
  await evaluate(`chrome.storage.sync.set({ displayMode: 'dual' })`);
  const flipped = await pollUntil(evaluate, page, `window.__SK.YT.config && window.__SK.YT.config.bilingualMode === true`);
  expect(flipped, 'displayMode → dual 後 config.bilingualMode 應為 true').toBe(true);

  const hostAttr = await evaluate(`
    (() => {
      const host = document.querySelector('shinkansen-yt-overlay');
      return host ? host.getAttribute('bilingual') : null;
    })()
  `);
  expect(hostAttr, '_applyBilingualMode(true) 應把 overlay host 設 bilingual attr').toBe('true');

  // 切回 single → 退出雙語
  await evaluate(`chrome.storage.sync.set({ displayMode: 'single' })`);
  const flippedBack = await pollUntil(evaluate, page, `window.__SK.YT.config.bilingualMode === false`);
  expect(flippedBack, 'displayMode → single 後 config.bilingualMode 應為 false').toBe(true);
  await page.close();
});

test('bilingual-displaymode (case 3): ytSubtitle 變更全量合併不洗掉導出的 bilingualMode', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await openFixture(context, localServer);

  await evaluate(`chrome.storage.sync.set({ displayMode: 'dual' })`);
  await evaluate(`
    (async () => {
      const SK = window.__SK;
      SK.YT.config = null;
      await SK._getYtConfig();
    })()
  `);
  const before = await evaluate(`window.__SK.YT.config.bilingualMode`);
  expect(before).toBe(true);

  // options 儲存 ytSubtitle(不含 bilingualMode)→ onChanged 全量合併,導出值須保留
  await evaluate(`chrome.storage.sync.set({ ytSubtitle: { windowSizeS: 45 } })`);
  const merged = await pollUntil(evaluate, page, `window.__SK.YT.config.windowSizeS === 45`);
  expect(merged, 'ytSubtitle 變更應全量合併進 config').toBe(true);
  const stillBilingual = await evaluate(`window.__SK.YT.config.bilingualMode`);
  expect(stillBilingual, 'ytSubtitle 合併不得洗掉 displayMode 導出的 bilingualMode').toBe(true);
  await page.close();
});
