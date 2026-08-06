// Regression: 匯入設定時 fixedGlossary（含 global + byDomain）必須通過 sanitizeImport,
// 不能被白名單默默丟掉。issue #48 audit 後發現另有 12 條 key 同樣被默默丟，一併鎖死。
//
// 修在 issue #48 fix:options.js sanitizeImport() 漏列 fixedGlossary,export 倒全部
// （含 fixedGlossary）但 import 走白名單過濾，結果整塊 fixedGlossary 被丟。使用者報告
// 「網域專用區塊沒匯入」實際上 global 也沒匯入。
//
// 全面 audit：同樣被丟的還有 11 條——targetLanguage / uiLanguage / displayMode /
// displayCurrency / translationMarkStyle / dualAccentColor / toastOpacity / toastPosition /
// disableUpdateNotice / translatePresets / ytSubtitle。
// 第 3 條 spec round-trip 全部 11 條，確保再也不會默默掉。
// (v1.9.26: skipTraditionalChinesePage 移除,原 12 條變 11 條)
//
// SANITY 紀錄（已驗證）:
//   1）把 options.js sanitizeImport() 內新增的 fixedGlossary 區塊整段註解掉，
//     spec 1 + 2 fail(Expected fixedGlossary 含 byDomain;Received undefined）。
//   2）把 sanitizeImport() topRules 新增的 9 條 scalar(targetLanguage / uiLanguage /
//     displayMode / displayCurrency / translationMarkStyle / dualAccentColor /
//     toastOpacity / toastPosition / disableUpdateNotice)
//     全砍 + translatePresets / ytSubtitle 兩塊砍，spec 3 fail。
//   還原 → 三條皆 pass。

import { test, expect } from '../fixtures/extension.js';

test('匯入設定時 fixedGlossary.global 與 byDomain 都要保留', async ({ context, extensionId }) => {
  const sw = context.serviceWorkers()[0]
    || (await context.waitForEvent('serviceworker', { timeout: 10_000 }));

  // 清空 storage，確保起點乾淨
  await sw.evaluate(async () => {
    await chrome.storage.sync.clear();
    await chrome.storage.sync.set({ uiLanguage: 'zh-TW' });
  });

  const page = await context.newPage();
  // 接住 importOk / importPartial 的 alert
  // accept 加 catch：匯入成功 alert 與測試收尾 page close 有 race，dialog 在關閉
  // 瞬間已失效時 accept() reject（'Target page ... has been closed'），未接住會把
  // 綠測試標成 fail（2026-07-27 兩輪 full gate 各炸本檔不同 case，錯誤簽名相同）
  page.on('dialog', d => d.accept().catch(() => {}));

  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#import-input', { state: 'attached' });

  // 模擬使用者匯入的 JSON——含 fixedGlossary.global 與 byDomain 兩個 domain
  const importPayload = {
    fixedGlossary: {
      global: [
        { source: 'Trump', target: '川普' },
        { source: 'JavaScript', target: 'JavaScript' },
      ],
      byDomain: {
        'en.wikipedia.org': [
          { source: 'Taiwan', target: '台灣' },
        ],
        'news.ycombinator.com': [
          { source: 'HN', target: 'Hacker News' },
          { source: 'YC', target: 'Y Combinator' },
        ],
      },
    },
  };

  await page.setInputFiles('#import-input', {
    name: 'shinkansen-settings-test.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(importPayload), 'utf8'),
  });

  // 等 await browser.storage.sync.set + await load() 完成——輪詢 storage
  const start = Date.now();
  let stored;
  while (Date.now() - start < 5000) {
    stored = await sw.evaluate(async () => {
      const all = await chrome.storage.sync.get('fixedGlossary');
      return all.fixedGlossary;
    });
    if (stored && stored.byDomain && Object.keys(stored.byDomain).length > 0) break;
    await page.waitForTimeout(50);
  }

  expect(stored).toBeDefined();
  expect(stored.global).toEqual([
    { source: 'Trump', target: '川普' },
    { source: 'JavaScript', target: 'JavaScript' },
  ]);
  expect(stored.byDomain).toEqual({
    'en.wikipedia.org': [
      { source: 'Taiwan', target: '台灣' },
    ],
    'news.ycombinator.com': [
      { source: 'HN', target: 'Hacker News' },
      { source: 'YC', target: 'Y Combinator' },
    ],
  });
});

test('匯入 fixedGlossary 時髒資料（非字串 / 空 entry / 空陣列 domain）會被過濾', async ({ context, extensionId }) => {
  const sw = context.serviceWorkers()[0]
    || (await context.waitForEvent('serviceworker', { timeout: 10_000 }));

  await sw.evaluate(async () => {
    await chrome.storage.sync.clear();
    await chrome.storage.sync.set({ uiLanguage: 'zh-TW' });
  });

  const page = await context.newPage();
  // accept 加 catch：匯入成功 alert 與測試收尾 page close 有 race，dialog 在關閉
  // 瞬間已失效時 accept() reject（'Target page ... has been closed'），未接住會把
  // 綠測試標成 fail（2026-07-27 兩輪 full gate 各炸本檔不同 case，錯誤簽名相同）
  page.on('dialog', d => d.accept().catch(() => {}));

  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#import-input', { state: 'attached' });

  const importPayload = {
    fixedGlossary: {
      global: [
        { source: 'OK', target: 'OK 譯' },
        { source: '', target: '' },                // 空 entry → 丟
        { source: 123, target: 'num' },            // 非字串 source → source=''（只剩 target)
        null,                                      // 非物件 → 丟
        { foo: 'bar' },                            // 沒 source/target 欄位 → 丟
      ],
      byDomain: {
        'example.com': [
          { source: 'X', target: 'Y' },
        ],
        'empty-domain.com': [
          { source: '', target: '' },              // 全空 → 該 domain 整個丟
        ],
        '': [                                      // 空 domain key → 丟
          { source: 'A', target: 'B' },
        ],
      },
    },
  };

  await page.setInputFiles('#import-input', {
    name: 'shinkansen-settings-dirty.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(importPayload), 'utf8'),
  });

  const start = Date.now();
  let stored;
  while (Date.now() - start < 5000) {
    stored = await sw.evaluate(async () => {
      const all = await chrome.storage.sync.get('fixedGlossary');
      return all.fixedGlossary;
    });
    if (stored && stored.byDomain && stored.byDomain['example.com']) break;
    await page.waitForTimeout(50);
  }

  expect(stored).toBeDefined();
  // global:OK entry 留下；{source:123,target:'num'} 變 {source:'',target:'num'} 保留
  expect(stored.global).toEqual([
    { source: 'OK', target: 'OK 譯' },
    { source: '', target: 'num' },
  ]);
  // byDomain：只有 example.com 留下；empty-domain.com（全空 entry）跟 ''（空 key）丟掉
  expect(stored.byDomain).toEqual({
    'example.com': [{ source: 'X', target: 'Y' }],
  });
});

test('匯入設定時 12 條 audit 漏掉的 key 必須全部 round-trip', async ({ context, extensionId }) => {
  const sw = context.serviceWorkers()[0]
    || (await context.waitForEvent('serviceworker', { timeout: 10_000 }));

  await sw.evaluate(async () => {
    await chrome.storage.sync.clear();
  });

  const page = await context.newPage();
  // accept 加 catch：匯入成功 alert 與測試收尾 page close 有 race，dialog 在關閉
  // 瞬間已失效時 accept() reject（'Target page ... has been closed'），未接住會把
  // 綠測試標成 fail（2026-07-27 兩輪 full gate 各炸本檔不同 case，錯誤簽名相同）
  page.on('dialog', d => d.accept().catch(() => {}));

  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#import-input', { state: 'attached' });

  const importPayload = {
    // 10 條 scalar / string
    targetLanguage: 'zh-CN',
    uiLanguage: 'en',
    displayMode: 'dual',
    displayCurrency: 'USD',
    translationMarkStyle: 'bar',
    dualAccentColor: 'blue',
    toastOpacity: 0.5,
    toastPosition: 'top-left',
    disableUpdateNotice: true,
    // translatePresets 陣列
    translatePresets: [
      { slot: 1, engine: 'google', model: null, label: '我的 Google' },
      { slot: 2, engine: 'gemini', model: 'gemini-3-flash-preview', label: '我的 Flash' },
      { slot: 3, engine: 'openai-compat', model: null, label: '我的 OpenAI' },
    ],
    // ytSubtitle 大物件
    ytSubtitle: {
      autoTranslate: false,
      temperature: 0.5,
      systemPrompt: '客製字幕 prompt',
      windowSizeS: 60,
      lookaheadS: 15,
      debugToast: true,
      onTheFly: true,
      engine: 'google',
      model: 'gemini-3.1-flash-lite',
      pricing: { inputPerMTok: 0.25, outputPerMTok: 1.5 },
      applyFixedGlossary: true,
      applyForbiddenTerms: true,
      asrMode: 'heuristic',
      bilingualMode: true,
      preferOriginalTrack: false,
    },
  };

  await page.setInputFiles('#import-input', {
    name: 'shinkansen-settings-full.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(importPayload), 'utf8'),
  });

  // 輪詢等 ytSubtitle 進 storage（最後一條子物件，當作 round-trip 完成 marker)
  const start = Date.now();
  let stored;
  while (Date.now() - start < 5000) {
    stored = await sw.evaluate(async () => chrome.storage.sync.get(null));
    if (stored?.ytSubtitle?.systemPrompt === '客製字幕 prompt') break;
    await page.waitForTimeout(50);
  }

  // 10 條 scalar
  expect(stored.targetLanguage).toBe('zh-CN');
  expect(stored.uiLanguage).toBe('en');
  expect(stored.displayMode).toBe('dual');
  expect(stored.displayCurrency).toBe('USD');
  expect(stored.translationMarkStyle).toBe('bar');
  expect(stored.dualAccentColor).toBe('blue');
  expect(stored.toastOpacity).toBe(0.5);
  expect(stored.toastPosition).toBe('top-left');
  expect(stored.disableUpdateNotice).toBe(true);

  // translatePresets
  expect(stored.translatePresets).toEqual([
    { slot: 1, engine: 'google', model: null, label: '我的 Google' },
    { slot: 2, engine: 'gemini', model: 'gemini-3-flash-preview', label: '我的 Flash' },
    { slot: 3, engine: 'openai-compat', model: null, label: '我的 OpenAI' },
  ]);

  // ytSubtitle
  expect(stored.ytSubtitle).toEqual({
    autoTranslate: false,
    temperature: 0.5,
    systemPrompt: '客製字幕 prompt',
    windowSizeS: 60,
    lookaheadS: 15,
    debugToast: true,
    onTheFly: true,
    engine: 'google',
    model: 'gemini-3.1-flash-lite',
    pricing: { inputPerMTok: 0.25, outputPerMTok: 1.5 },
    applyFixedGlossary: true,
    applyForbiddenTerms: true,
    asrMode: 'heuristic',
    // v2.0.85:bilingualMode 已移除(字幕雙語跟隨 displayMode)——舊匯出檔的
    // ytSubtitle.bilingualMode(payload 內仍有)被 sanitize 丟棄,toEqual 精確比對斷言其不存在
    preferOriginalTrack: false,
  });
});

// Code review 2026-06-09 H1:sanitizeImport 漏列 customProvider.thinkingLevel /
// extraBodyJson / useStrongSegMarker 與 glossary.model,匯出再匯入這幾個欄位被默默丟。
// SANITY 紀錄（已驗證）:
//   把 options.js sanitizeImport() 內新增的「thinkingLevel / extraBodyJson /
//   useStrongSegMarker」三行與 glClean 的「gl.model」一行註解掉 → 本 spec fail
//   (Received cpClean 缺 thinkingLevel 等);還原 → pass。
test('匯入設定時 customProvider 進階欄位與 glossary.model 必須 round-trip', async ({ context, extensionId }) => {
  const sw = context.serviceWorkers()[0]
    || (await context.waitForEvent('serviceworker', { timeout: 10_000 }));

  await sw.evaluate(async () => {
    await chrome.storage.sync.clear();
    await chrome.storage.local.clear();
  });

  const page = await context.newPage();
  // accept 加 catch：匯入成功 alert 與測試收尾 page close 有 race，dialog 在關閉
  // 瞬間已失效時 accept() reject（'Target page ... has been closed'），未接住會把
  // 綠測試標成 fail（2026-07-27 兩輪 full gate 各炸本檔不同 case，錯誤簽名相同）
  page.on('dialog', d => d.accept().catch(() => {}));

  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#import-input', { state: 'attached' });

  const importPayload = {
    customProvider: {
      baseUrl: 'https://example.com/v1',
      model: 'my-model',
      thinkingLevel: 'high',
      extraBodyJson: '{"top_k": 40}',
      useStrongSegMarker: false,
    },
    glossary: {
      enabled: true,
      model: 'gemini-3-flash-lite',
    },
  };

  await page.setInputFiles('#import-input', {
    name: 'shinkansen-settings-cp.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(importPayload), 'utf8'),
  });

  const start = Date.now();
  let stored;
  while (Date.now() - start < 5000) {
    stored = await sw.evaluate(async () => chrome.storage.sync.get(['customProvider', 'glossary']));
    if (stored?.customProvider?.thinkingLevel === 'high') break;
    await page.waitForTimeout(50);
  }

  expect(stored.customProvider).toMatchObject({
    thinkingLevel: 'high',
    extraBodyJson: '{"top_k": 40}',
    useStrongSegMarker: false,
  });
  expect(stored.glossary.model).toBe('gemini-3-flash-lite');
});

// Code review 2026-06-09 H1 補強:非法 thinkingLevel 不可進 storage（落回 saveSettings 預設前的防線）
test('匯入設定時非法 customProvider.thinkingLevel 會被過濾', async ({ context, extensionId }) => {
  const sw = context.serviceWorkers()[0]
    || (await context.waitForEvent('serviceworker', { timeout: 10_000 }));

  await sw.evaluate(async () => {
    await chrome.storage.sync.clear();
    await chrome.storage.local.clear();
  });

  const page = await context.newPage();
  // accept 加 catch：匯入成功 alert 與測試收尾 page close 有 race，dialog 在關閉
  // 瞬間已失效時 accept() reject（'Target page ... has been closed'），未接住會把
  // 綠測試標成 fail（2026-07-27 兩輪 full gate 各炸本檔不同 case，錯誤簽名相同）
  page.on('dialog', d => d.accept().catch(() => {}));

  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#import-input', { state: 'attached' });

  const importPayload = {
    customProvider: {
      model: 'my-model',
      thinkingLevel: 'ultra',   // 非法 enum → 應被丟
      useStrongSegMarker: 'yes', // 非 boolean → 應被丟
    },
  };

  await page.setInputFiles('#import-input', {
    name: 'shinkansen-settings-cp-bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(importPayload), 'utf8'),
  });

  const start = Date.now();
  let stored;
  while (Date.now() - start < 5000) {
    stored = await sw.evaluate(async () => chrome.storage.sync.get('customProvider'));
    if (stored?.customProvider?.model === 'my-model') break;
    await page.waitForTimeout(50);
  }

  expect(stored.customProvider.model).toBe('my-model');
  expect(stored.customProvider).not.toHaveProperty('thinkingLevel');
  expect(stored.customProvider).not.toHaveProperty('useStrongSegMarker');
});
