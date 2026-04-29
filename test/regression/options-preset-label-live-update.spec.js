// Regression: 「翻譯快速鍵」preset 標籤 input 即時聯動下游兩個下拉選單
//
// 修在 v1.8.17:options.js refreshSlotDropdownLabels() helper + preset-label-{slot}
// 的 input listener。修前 popup-button-slot / auto-translate-slot 的 option text
// 只在 init() 載入時組一次,使用者改 preset 標籤要重整頁面才會更新。
//
// SANITY 紀錄(已驗證 v1.8.17 release 前):
//   把 options.js 中 preset-label-{slot} 的 input listener 註解掉(三 slot 全 disable),
//   spec fail(Expected「預設 2:我的測試標籤」/ Received「預設 2:Flash Lite」)。
//   還原 listener → pass。

import { test, expect } from '../fixtures/extension.js';

test('preset 標籤改變時下游兩個下拉選單即時更新', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#preset-label-1');
  // init() 載入完成後 option text 應已組好為「預設 2:Flash Lite」(預設值)
  await expect(page.locator('#popup-button-slot option[value="1"]')).toHaveText('預設 2：Flash Lite');

  // 改 slot 1 的標籤,popup-button-slot 與 auto-translate-slot 的對應 option 應立刻更新
  await page.fill('#preset-label-1', '我的測試標籤');
  await page.dispatchEvent('#preset-label-1', 'input');

  const popupOpt1 = await page.locator('#popup-button-slot option[value="1"]').textContent();
  const autoOpt1 = await page.locator('#auto-translate-slot option[value="1"]').textContent();
  expect(popupOpt1).toBe('預設 2：我的測試標籤');
  expect(autoOpt1).toBe('預設 2：我的測試標籤');

  // 改 slot 2(主要預設)
  await page.fill('#preset-label-2', 'Flash 主');
  await page.dispatchEvent('#preset-label-2', 'input');
  const popupOpt2 = await page.locator('#popup-button-slot option[value="2"]').textContent();
  const autoOpt2 = await page.locator('#auto-translate-slot option[value="2"]').textContent();
  expect(popupOpt2).toBe('主要預設：Flash 主');
  expect(autoOpt2).toBe('主要預設：Flash 主');

  // 清空 slot 3 的標籤,應 fallback 到 slotTitle 本身
  await page.fill('#preset-label-3', '');
  await page.dispatchEvent('#preset-label-3', 'input');
  const popupOpt3 = await page.locator('#popup-button-slot option[value="3"]').textContent();
  const autoOpt3 = await page.locator('#auto-translate-slot option[value="3"]').textContent();
  expect(popupOpt3).toBe('預設 3：預設 3');
  expect(autoOpt3).toBe('預設 3：預設 3');
});
