// Regression: 自訂模型 Temperature 欄位可留空(GitHub issue #60,v2.0.79)
//
// 使用者回報:有些模型建議 temperature 不要送,但欄位清空後會被回填預設 0.7,
// 等於「只能填數字、沒有不送的選項」。
//
// 修法:options 存檔時空欄存 null(不再 parseUserNum fallback 0.7),adapter 端
// `temperature !== null` 才把欄位放進 request body(lib/openai-compat.js),
// background handleTranslateCustom 再把文件 / ASR 路徑的 temperature override 讓位。
//
// 本 spec 驗真實路徑(開真的 options 頁 → 清空欄位 → 自動存檔 → 讀 storage → reload 回填):
//   - 驗:清空 → storage.sync.customProvider.temperature === null;reload 後欄位仍空白
//   - 驗:填回數字 → storage 存數字(不會因為修法把正常路徑弄壞)
//   - 驗:background 對 doc / ASR override 的讓位那行還在(source 斷言)
//   - 不驗:request body 有沒有 temperature — 由 test/unit/openai-compat-temperature-omit.spec.js
//     直接 import adapter + 攔 fetch 驗
//
// SANITY 紀錄(已驗證):把 options.js 存檔那段改回
//   `temperature: parseUserNum($('cp-temperature').value, DEFAULTS.customProvider?.temperature ?? 0.7)`
//   →「清空 → storage 為 null」case fail(收到 0.7);還原後全綠。
//   background 讓位斷言則把 handleTranslateCustom 的
//   `if (settings.customProvider?.temperature === null) cp.temperature = null;` 註解掉 → 該 case fail。
import { test, expect } from '../fixtures/extension.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BG_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../shinkansen/background.js'), 'utf-8');

const readCpTemp = (page) => page.evaluate(() => new Promise((r) =>
  chrome.storage.sync.get(['customProvider'], (o) => r(
    // 「沒有這個 key」與「值是 null」要分得出來
    o.customProvider && 'temperature' in o.customProvider
      ? { has: true, value: o.customProvider.temperature }
      : { has: false, value: undefined },
  ))));

test('options 自訂模型:Temperature 清空 → 存成 null,reload 後欄位仍空白', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#uiLanguage');
  await page.click('.tab-btn[data-tab="custom-provider"]');
  await page.waitForSelector('#cp-temperature', { state: 'visible' });

  // 先填一個數字,確保後面的「清空」是真的從有值變空
  await page.fill('#cp-temperature', '0.5');
  await expect.poll(async () => (await readCpTemp(page)).value, { timeout: 5000 }).toBe(0.5);

  // 清空欄位 → 自動存檔(不點任何按鈕)
  await page.fill('#cp-temperature', '');
  await expect.poll(async () => {
    const s = await readCpTemp(page);
    return s.has ? s.value : 'MISSING';
  }, { timeout: 5000 }).toBe(null);

  // reload 後 UI 要維持空白(不能被 render 端回填 0.7)
  await page.reload();
  await page.waitForSelector('#uiLanguage');
  await page.click('.tab-btn[data-tab="custom-provider"]');
  await page.waitForSelector('#cp-temperature', { state: 'visible' });
  await expect(page.locator('#cp-temperature')).toHaveValue('');

  await page.close();
});

test('options 自訂模型:Temperature 填回數字 → 照常存數字', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#uiLanguage');
  await page.click('.tab-btn[data-tab="custom-provider"]');
  await page.waitForSelector('#cp-temperature', { state: 'visible' });

  await page.fill('#cp-temperature', '');
  await expect.poll(async () => (await readCpTemp(page)).value, { timeout: 5000 }).toBe(null);

  await page.fill('#cp-temperature', '0.3');
  await expect.poll(async () => (await readCpTemp(page)).value, { timeout: 5000 }).toBe(0.3);

  await page.close();
});

test('background handleTranslateCustom:temperature 為 null 時讓 doc / ASR override 讓位', () => {
  const hStart = BG_SRC.indexOf('async function handleTranslateCustom(');
  expect(hStart, 'background.js 找不到 handleTranslateCustom').toBeGreaterThan(-1);
  const hBody = BG_SRC.slice(hStart, hStart + 3000);
  // ^\s* 行首錨定:被註解掉的同一行不得矇混過關
  expect(
    hBody,
    'handleTranslateCustom 缺「customProvider.temperature === null → cp.temperature = null」讓位邏輯'
    + '(文件 / ASR 路徑的 temperature override 會偷送,使用者留空等於沒生效)',
  ).toMatch(/^\s*if \(settings\.customProvider\?\.temperature === null\) cp\.temperature = null;/m);
});
