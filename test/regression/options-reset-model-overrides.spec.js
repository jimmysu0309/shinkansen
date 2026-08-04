// Regression: options「重設所有參數」必清空全部 per-model 計價覆蓋欄位(2026-08-03 code review D1)
//
// 背景:reset 清單原本手列 9 個 ID,漏掉 gemini-3.5-flash-lite 三欄
// (override-lite35-input / -output / -discount)——填過 3.5 Flash Lite 自訂單價後
// 按重設,其他欄位清空但 lite35 三欄殘留,autosave 把殘留值繼續物化進 storage。
// 修法:load(fillOverride)/ save(collect)/ reset 三處改由 MODEL_OVERRIDE_FIELDS
// 常數驅動(單一資料源),新增模型列只改一處。
//
// 驗的訊號層次:
//   - 驗:HTML 內「全部」override-* input(用 DOM 掃,不手列 ID——新增模型列漏進
//     常數時本 spec 會咬住)填值 → 按重設 → 全部清空 + autosave 後 storage 的
//     modelPricingOverrides 為空
//   - 不驗:各欄位數值格式驗證(collect 的 Number/範圍檢查,unit spec
//     model-pricing-override.spec.js 鎖)
//
// SANITY 紀錄(已驗證,2026-08-04,兩處破壞):
//   ① 暫時把 options.js MODEL_OVERRIDE_FIELDS 的 gemini-3.5-flash-lite 列註解掉
//     → 「storage 應有 ≥4 個覆蓋 entry」前置斷言 fail(save 路徑一起漏,只存 3 個)。
//   ② 暫時在 reset 迴圈加 `if (f.model === 'gemini-3.5-flash-lite') continue`
//     (精準重現「reset 清單漏 lite35」的舊 bug 形態)→ 「重設後 #override-lite35-input
//     應為空」斷言 fail(殘留 '9')。兩處各自還原 → pass。

import { test, expect } from '../fixtures/extension.js';

test('重設所有參數 → 全部 per-model 覆蓋欄位清空 + storage 覆蓋表清空', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#uiLanguage');

  // 切到 Gemini 分頁
  await page.click('.tab-btn[data-tab="gemini"]');
  await page.waitForSelector('#gemini-reset-all', { state: 'visible' });

  // 從 DOM 掃出全部 override 欄位(不手列 ID:HTML 新增模型列而常數漏更新時,
  // 這裡會自動涵蓋新欄位並讓下方「重設後應為空」斷言 fail)
  const ids = await page.$$eval('input[id^="override-"]', (els) => els.map((e) => e.id));
  expect(ids.length, 'Gemini 分頁應有 4 模型 × 3 欄 = 12 個覆蓋欄位').toBe(12);
  expect(ids, '應包含 3.5 Flash Lite 三欄(bug 當時漏掉的)').toEqual(
    expect.arrayContaining(['override-lite35-input', 'override-lite35-output', 'override-lite35-discount']),
  );

  // 全部填 9(input/output 單價與 discount 百分比都是合法值)
  for (const id of ids) await page.fill(`#${id}`, '9');

  // 等 autosave 把覆蓋表物化進 storage(前置條件:確認 lite35 真的被存過)
  await expect.poll(async () =>
    page.evaluate(() => new Promise((r) => chrome.storage.sync.get(['modelPricingOverrides'], (o) => r(Object.keys(o.modelPricingOverrides || {}).length)))),
    { timeout: 5000 },
  ).toBeGreaterThanOrEqual(4);
  const litePre = await page.evaluate(() => new Promise((r) => chrome.storage.sync.get(['modelPricingOverrides'], (o) => r(o.modelPricingOverrides?.['gemini-3.5-flash-lite']))));
  expect(litePre?.inputPerMTok, '前置條件:lite35 覆蓋已被存進 storage').toBe(9);

  // 按「重設所有參數」(有 confirm dialog,需先掛 accept handler)
  page.on('dialog', (d) => d.accept());
  await page.click('#gemini-reset-all');

  // 全部欄位應清空(bug 形態:lite35 三欄殘留 '9')
  for (const id of ids) {
    await expect(page.locator(`#${id}`), `重設後 #${id} 應為空`).toHaveValue('');
  }

  // reset 有 markDirty → autosave 應把空覆蓋表寫回 storage(殘留值不再物化)
  await expect.poll(async () =>
    page.evaluate(() => new Promise((r) => chrome.storage.sync.get(['modelPricingOverrides'], (o) => r(Object.keys(o.modelPricingOverrides || {}).length)))),
    { timeout: 5000 },
  ).toBe(0);
});
