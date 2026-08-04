// Regression: issue #57——深色 appearance 下設定頁 / 工具列圖示選單的表單控制項白底白字
//
// 症狀（使用者截圖，2026-07-02）：設定頁的術語表欄位、API Key、介面語言下拉「明明有值
// 卻顯示空白」，點進去才看得到（選取反白墊在字後面才顯形）。截圖像素分析：那些「空白」
// 欄位是 100% 純白、零個非白像素 → 字真的被畫成 #ffffff；placeholder 反而看得到，因為
// UA stylesheet 的 placeholder 色是寫死的 darkgray，不隨 appearance 變。
//
// Root cause：options.css / popup.css 把表單控制項的 background 鎖成 #fff 卻沒鎖 color，
// 而擴充功能所有頁面都沒宣告 color-scheme。瀏覽環境被解析成深色 appearance 時
// （Firefox「網站外觀：深色」、系統深色模式下的部分瀏覽器、強制深色模式旗標 / 外掛），
// UA 給表單控制項的預設文字色是白的 → 白底白字。已在 chromium / webkit 兩引擎確認：
// `color-scheme: dark` 下同一份 CSS 的 input computed color = rgb(255,255,255)。
//
// 修法（兩層）：
//   1) 淺色專用頁面（options / popup / translate-doc）的 :root 宣告 `color-scheme: light`，
//      讓 UA 一律用淺色 appearance 畫原生控制項
//   2) 背景鎖淺色的規則一律連 `color` 一起鎖，當作 appearance 被外力推成深色時的保險
//   （順帶：options 的全域選擇器漏了 input[type="email"]，Instapaper Email 欄位整個沒
//     套到框線與背景，一併補進選擇器清單）
//
// 訊號層界定：驗「頁面宣告 color-scheme」+「強制深色 appearance 下文字與背景仍有足夠
// 對比」。不驗真實 Firefox / Safari 在使用者機器上的原生控制項繪製（Playwright 的
// colorScheme 只模擬 media query，不切 UA 的 widget appearance），那層要實機看。
//
// SANITY 紀錄（已驗證，2026-08-04）：
//   1）拿掉 options.css 的 `:root { color-scheme: light; }` → 「options.html 宣告
//      color-scheme: light」fail（Received 'normal'）；還原 → pass。
//   2）拿掉全域 input 規則的 `color: #1d1d1f;` → 「強制深色 appearance 下…仍看得見」
//      fail（#apiKey 對比 1.00，文字色 rgb(255,255,255) 疊 rgb(255,255,255)）；
//      還原 → pass。
//   3）拿掉 popup.css `.row select` 的 `color: #1d1d1f;` → popup 那條 fail；還原 → pass。
import { test, expect } from '../fixtures/extension.js';

// WCAG 相對亮度 / 對比度，在頁面內算（拿 computed color 對 computed background）
const CONTRAST_HELPER = `
  const parse = (s) => (s.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (fg, bg) => {
    const [a, b] = [lum(parse(fg)), lum(parse(bg))];
    const [hi, lo] = a > b ? [a, b] : [b, a];
    return (hi + 0.05) / (lo + 0.05);
  };
`;

test('options.html 宣告 color-scheme: light（不讓 UA 用深色 appearance 畫原生控制項）', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#apiKey', { state: 'attached' });

  const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  expect(scheme).toBe('light');

  await page.close();
});

test('popup.html 宣告 color-scheme: light', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForSelector('#targetLanguage', { state: 'attached' });

  const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  expect(scheme).toBe('light');

  await page.close();
});

test('強制深色 appearance 時 options 的輸入框 / 下拉文字仍看得見（第二層保險）', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#apiKey', { state: 'attached' });

  // 模擬使用者環境：把 appearance 推成深色（蓋掉第一層修法，單獨驗第二層）。
  // 注入的 <style> 在 options.css 之後，同 specificity 由後者勝出。
  await page.addStyleTag({ content: ':root { color-scheme: dark; }' });

  const measured = await page.evaluate(`(() => {
    ${CONTRAST_HELPER}
    const ids = ['apiKey', 'uiLanguage', 'instapaper-email'];
    return ids.map((id) => {
      const el = document.getElementById(id);
      if (!el) return { id, missing: true };
      const s = getComputedStyle(el);
      return {
        id,
        color: s.color,
        background: s.backgroundColor,
        ratio: Number(contrast(s.color, s.backgroundColor).toFixed(2)),
      };
    });
  })()`);

  for (const m of measured) {
    expect(m.missing, `${m.id} 應存在於 options.html`).toBeFalsy();
    // 4.5 = WCAG AA 內文門檻；破壞修法時白底白字會是 1.00
    expect(m.ratio, `${m.id} 文字 ${m.color} 疊背景 ${m.background} 對比不足`).toBeGreaterThanOrEqual(4.5);
  }

  await page.close();
});

test('強制深色 appearance 時 popup 的目標語言下拉文字仍看得見', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForSelector('#targetLanguage', { state: 'attached' });

  await page.addStyleTag({ content: ':root { color-scheme: dark; }' });

  const m = await page.evaluate(`(() => {
    ${CONTRAST_HELPER}
    const s = getComputedStyle(document.getElementById('targetLanguage'));
    return {
      color: s.color,
      background: s.backgroundColor,
      ratio: Number(contrast(s.color, s.backgroundColor).toFixed(2)),
    };
  })()`);

  expect(m.ratio, `#targetLanguage 文字 ${m.color} 疊背景 ${m.background} 對比不足`).toBeGreaterThanOrEqual(4.5);

  await page.close();
});

test('Instapaper Email 欄位有套到全域輸入框樣式（原本漏在選擇器清單外）', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#instapaper-email', { state: 'attached' });

  const [email, password] = await page.evaluate(() =>
    ['instapaper-email', 'instapaper-password'].map((id) => {
      const s = getComputedStyle(document.getElementById(id));
      return { borderWidth: s.borderTopWidth, borderRadius: s.borderTopLeftRadius, background: s.backgroundColor };
    })
  );

  // 同一區塊的兄弟欄位（密碼）長什麼樣，Email 就該長什麼樣
  expect(email).toEqual(password);

  await page.close();
});
