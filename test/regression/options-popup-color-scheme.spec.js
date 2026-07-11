// Regression:issue #57 — macOS 深色模式下 options 頁輸入框白字白底(值看起來是空的)
//
// 根因:options.css 表單控制項規則只寫死 background(#fff / transparent)卻沒設
// color,且整頁零 color-scheme 宣告。macOS 系統深色模式下,WebKit 對未宣告
// color-scheme 的頁面套用系統深色的表單控制項文字色(近白)→ 疊在白底上 =
// 白字白底。三個症狀互證:placeholder 走 UA 獨立灰階所以看得到;選取反白時系統
// 強制對比前景所以文字浮現;頁面一般文字有明確 color:#1d1d1f 所以正常。
// popup.css 同款寫法(.row select 有 background 無 color)一併修。
//
// 驗到 / 沒驗到:
//   ✅ :root 宣告 color-scheme: light(向引擎聲明本頁純淺色,表單控制項用淺色渲染)
//   ✅ 表單控制項有明確前景色 rgb(29,29,31),不再依賴 UA 預設
//   ❌ 真實 WebKit/macOS 深色模式的渲染結果 — Chromium 沒有 Safari 那種
//      「系統外觀滲入未宣告 color-scheme 頁面」的行為,白字白底無法在本 harness
//      重現;該層靠 Mac 實機(系統深色 + Safari 開設定頁)驗證。
//
// SANITY 紀錄(已驗證):把 options.css 的 :root color-scheme 與控制項 color 拿掉,
// options 兩條斷言 fail(colorScheme='normal'、color=rgb(0,0,0));還原後全綠。
import { test, expect } from '../fixtures/extension.js';

const EXPECTED_TEXT_COLOR = 'rgb(29, 29, 31)'; // #1d1d1f,與頁面一般文字同色

test('options 頁:root 宣告 color-scheme light + 表單控制項有明確前景色', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#apiKey');

  const rootScheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  expect(rootScheme).toBe('light');

  // 命中 options.css 表單控制項共用規則的兩類控制項(input[type=password] / select)。
  // 術語表分頁的 input[type=text](.fg-source/.fg-target)走同一條規則,一併覆蓋。
  const inputColor = await page.evaluate(() => getComputedStyle(document.querySelector('#apiKey')).color);
  expect(inputColor).toBe(EXPECTED_TEXT_COLOR);
  const selectColor = await page.evaluate(() => getComputedStyle(document.querySelector('#uiLanguage')).color);
  expect(selectColor).toBe(EXPECTED_TEXT_COLOR);
});

test('popup 頁:root 宣告 color-scheme light + .row select 有明確前景色', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForSelector('.row select');

  const rootScheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  expect(rootScheme).toBe('light');

  const selectColor = await page.evaluate(() => getComputedStyle(document.querySelector('.row select')).color);
  expect(selectColor).toBe(EXPECTED_TEXT_COLOR);
});

// review 發現的同根因 sibling:translate-doc(文件翻譯)頁也是純淺色 + 寫死白底
// + 零 color-scheme,Safari 深色模式下輸入框同樣白字白底。index.html 用 index.css;
// settings.html 用 ../options/options.css(上方 options 修正已覆蓋,不需獨立斷言)。
test('translate-doc 頁:root 宣告 color-scheme light', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/translate-doc/index.html`);
  await page.waitForSelector('#app-main');

  const rootScheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  expect(rootScheme).toBe('light');
});
