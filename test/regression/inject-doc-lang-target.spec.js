// Regression: doc-lang-target（對應 v2.0.73 的「<html lang> 頁面層級對齊 target」功能）
//
// Fixture: test/regression/fixtures/doc-lang-target.html（<html lang="en"> + 三段英文）
// 背景：per-element lang(applyTargetLocaleStyling)只蓋注入段落;讀「整份文件」的
//   下游 scraper(Readwise Reader / Instapaper 等)與 a11y 工具看的是頁面層級
//   <html lang>。single mode 整頁已是譯文,documentElement.lang 應對齊 target;
//   還原(restorePage)/ SPA 導航(resetForSpaNavigation,同一 SK.restoreDocLang
//   helper 的鏡像呼叫點,本 spec 不重複驅動)時應回到原值,原本沒 attribute 的
//   要 removeAttribute 不留殘影。dual mode 頁面同時含原文+譯文,不動 lang。
//
// 本 spec 鎖的訊號層：驗「真實 translatePage 成功路徑(mock 訊息層回成功譯文)→
//   <html lang> 切 target → testRestorePage(真 restorePage)→ 還原」整條。
//   不驗:下游 scraper 是否尊重 lang(Readwise 實測 2026-07-31 不尊重,見
//   SPEC-PRIVATE)、Google 路徑同款呼叫點(程式同形鏡像)、SPA reset 呼叫點(同 helper)。
//
// SANITY 紀錄（已驗證,2026-07-31）：把 content.js Gemini 成功路徑的
//   `if (STATE.translatedMode === 'single') SK.applyDocTargetLang?.();` 註解掉 →
//   Case 1「翻譯後 <html lang> 應為 zh-TW」(收到 'en')與 Case 2(收到 null)fail、
//   Case 3 dual 對照組仍 pass。還原後 3 case 全 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'doc-lang-target';

// mock 訊息層：翻譯批次全部成功（譯文 = 前置中文標記 + 原 serialized 文字,
// 佔位符structure原樣保留,且不等於原文避免 echo-skip 判定）
const MOCK_MESSAGING = `
  chrome.runtime.sendMessage = async function(msg) {
    if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') {
      // streaming 起始拒絕 → content 端 fallback 到 non-streaming TRANSLATE_BATCH
      return { ok: false, started: false, error: 'no streaming (test)' };
    }
    if (msg && msg.type === 'TRANSLATE_BATCH') {
      const texts = (msg.payload && msg.payload.texts) || [];
      return { ok: true, result: texts.map((t) => '中文譯文' + t), usage: {} };
    }
    return { ok: true };
  };
`;

async function runTranslateAndWait(page, evaluate) {
  await evaluate(`
    window.__runDone = false;
    window.__SK.translatePage()
      .then(() => { window.__runDone = true; })
      .catch(() => { window.__runDone = true; });
    null
  `);
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (await evaluate(`window.__runDone === true`)) break;
    await page.waitForTimeout(100);
  }
}

test('doc-lang-target case 1: single 翻譯成功 → <html lang> 切 target,restore 還原 en', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(MOCK_MESSAGING);

  await runTranslateAndWait(page, evaluate);

  const afterTranslate = await evaluate(`({
    runDone: window.__runDone,
    translated: window.__SK.STATE.translated,
    markedCount: document.querySelectorAll('[data-shinkansen-translated]').length,
    docLang: document.documentElement.getAttribute('lang'),
    backup: window.__SK.STATE.docLangBackup ? window.__SK.STATE.docLangBackup.orig : '(no-backup)',
  })`);

  expect(afterTranslate.runDone, 'translatePage 應完成').toBe(true);
  expect(afterTranslate.translated, '應標為已翻譯（前置條件）').toBe(true);
  expect(afterTranslate.markedCount, '應有段落注入成功（前置條件）').toBeGreaterThanOrEqual(1);
  expect(afterTranslate.docLang, '翻譯後 <html lang> 應為 zh-TW').toBe('zh-TW');
  expect(afterTranslate.backup, 'docLangBackup 應記住原值 en').toBe('en');

  // 還原（真 restorePage）
  await evaluate(`window.__shinkansen.testRestorePage(); null`);
  const afterRestore = await evaluate(`({
    docLang: document.documentElement.getAttribute('lang'),
    backupCleared: window.__SK.STATE.docLangBackup === undefined,
  })`);
  expect(afterRestore.docLang, '還原後 <html lang> 應回到 en').toBe('en');
  expect(afterRestore.backupCleared, '還原後 docLangBackup 應清空（不留殘影）').toBe(true);

  await page.close();
});

test('doc-lang-target case 2: 原頁無 lang 屬性 → 翻譯切 target,restore 後 attribute 移除', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(MOCK_MESSAGING);
  // 模擬「原本就沒設 lang」的頁面
  await evaluate(`document.documentElement.removeAttribute('lang'); null`);

  await runTranslateAndWait(page, evaluate);

  const afterTranslate = await evaluate(`({
    translated: window.__SK.STATE.translated,
    docLang: document.documentElement.getAttribute('lang'),
  })`);
  expect(afterTranslate.translated, '應標為已翻譯（前置條件）').toBe(true);
  expect(afterTranslate.docLang, '翻譯後 <html lang> 應為 zh-TW').toBe('zh-TW');

  await evaluate(`window.__shinkansen.testRestorePage(); null`);
  const afterRestore = await evaluate(`({
    hasLang: document.documentElement.hasAttribute('lang'),
  })`);
  expect(afterRestore.hasLang, '原本無 lang 的頁面,還原後不應殘留 lang attribute').toBe(false);

  await page.close();
});

test('doc-lang-target case 3: dual mode 翻譯成功 → <html lang> 維持原值不動', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(MOCK_MESSAGING);
  // 切 dual 模式（translatePage 從 storage.sync 讀 displayMode）
  await evaluate(`chrome.storage.sync.set({ displayMode: 'dual' }); null`);

  try {
    await runTranslateAndWait(page, evaluate);

    const afterTranslate = await evaluate(`({
      translated: window.__SK.STATE.translated,
      translatedMode: window.__SK.STATE.translatedMode,
      docLang: document.documentElement.getAttribute('lang'),
      backupUntouched: window.__SK.STATE.docLangBackup === undefined,
    })`);
    expect(afterTranslate.translated, '應標為已翻譯（前置條件）').toBe(true);
    expect(afterTranslate.translatedMode, '本輪應走 dual 模式（前置條件）').toBe('dual');
    expect(afterTranslate.docLang, 'dual mode 下 <html lang> 應維持 en 不動').toBe('en');
    expect(afterTranslate.backupUntouched, 'dual mode 不應建立 docLangBackup').toBe(true);
  } finally {
    // 清掉 displayMode 設定,不污染同 context 其他 spec
    await evaluate(`chrome.storage.sync.remove('displayMode'); null`);
  }

  await page.close();
});
