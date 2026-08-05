// Regression: options-import-input-reset(批次 8 D4,code review 2026-08-03)
//
// Bug:匯入設定 handler 結束後沒清 `#import-input.value`——選同一個檔案第二次不會
// fire change 事件(修壞的備份檔改好後重選同檔名 = 無反應,使用者以為匯入壞了)。
// 修法:handler finally 補 `e.target.value = ''`(成功 / 失敗 / 無效檔都清)。
//
// 走真實 options 頁 + Playwright setInputFiles 驅動真 change handler。
//
// SANITY 紀錄(已驗證,2026-08-05):把 options.js import handler 的 finally 區塊
// 暫時拿掉 → 「成功匯入後 input.value 應清空」斷言 fail(殘留 fakepath 檔名)→
// 還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('D4: 匯入設定後 input.value 清空(同檔案可重複匯入)', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#uiLanguage');

  // 蓋掉 alert(headless 下阻塞)
  await page.evaluate(`window.alert = () => {}`);

  const file = join(tmpdir(), 'sk-import-test.json');
  writeFileSync(file, JSON.stringify({ displayMode: 'single' }));

  await page.setInputFiles('#import-input', file);
  // change handler async;輪詢等 value 清空(修法生效)或 timeout(舊行為殘留檔名)
  const start = Date.now();
  let val = null;
  while (Date.now() - start < 5000) {
    val = await page.$eval('#import-input', (el) => el.value);
    if (val === '') break;
    await page.waitForTimeout(100);
  }
  expect(val, '匯入完成後 input.value 應清空,同檔案才能重複匯入').toBe('');

  // 對照:同一個檔案第二次 setInputFiles 仍會觸發 change(value 已清)
  await page.setInputFiles('#import-input', file);
  const start2 = Date.now();
  let val2 = null;
  while (Date.now() - start2 < 5000) {
    val2 = await page.$eval('#import-input', (el) => el.value);
    if (val2 === '') break;
    await page.waitForTimeout(100);
  }
  expect(val2, '第二次匯入後也清空').toBe('');

  await page.close();
});
