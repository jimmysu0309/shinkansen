// Regression: 懸浮按鈕拖到視窗頂緣時長按選單超出畫面(2026-08-03 code review D3)
//
// Fixture: test/regression/fixtures/floating-icon.html(共用)
// 結構性根因:.menu 是 host 內 position:absolute; bottom:0,永遠從按鈕底緣向上長;
// 左右緣有 side-left / side-right 翻轉,垂直方向沒有——按鈕在視窗頂緣(offsetY≈0)
// 時,約 180-220px 高的選單大部分在 viewport 上方,點不到。
// 修法:openMenu 顯示後量測,向上空間不足(host 底緣 - 選單高 < 0)→ 加 .v-down
// (bottom:auto; top:0,從按鈕頂緣向下長),對稱水平方向的 side-left/right 處理。
//
// 驗的訊號層次:
//   - 驗:選單 getBoundingClientRect 幾何(頂緣開選單不超出 viewport 上緣;底部
//     開選單維持原向上行為不受影響)——真實 content script 注入 + 真實 CSS 佈局
//   - 不驗:實機長按手勢消歧(pointer 計時那層 inject-floating-icon.spec.js 的
//     既有說明,需實機)、視覺樣式細節(截圖人工驗)
//
// 重現紀錄(2026-08-04,修法前先跑本 spec 確認咬得住 bug):
//   未修狀態跑「頂緣開選單」case → menuRect.top = -133(選單大部分在 viewport
//   上方),斷言 fail。修法後 → pass = spec 重現力已驗。
// SANITY 紀錄(已驗證,2026-08-04):暫時把 openMenu 的 v-down 量測分支改
//   `if (false)` → 「頂緣開選單不得超出 viewport 上緣」fail(top=-133)。還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'floating-icon';

async function openAt(evaluate, offsetY) {
  return await evaluate(`(async () => {
    const f = window.__SK._floating;
    f.applyEnabled(true);
    f.closeMenu();
    f.applyPos({ edge: 'right', offsetY: ${offsetY} });
    await f.openMenu();
    const menuRect = f.menuEl.getBoundingClientRect();
    const hostRect = f.host.getBoundingClientRect();
    return {
      menuTop: menuRect.top, menuBottom: menuRect.bottom, menuHeight: menuRect.height,
      hostTop: hostRect.top, viewportH: window.innerHeight,
      vDown: f.menuEl.classList.contains('v-down'),
    };
  })()`);
}

test('floating icon: 頂緣開選單向下翻轉不超出畫面;底部維持向上不受影響', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  // 按鈕拖到視窗頂緣(offsetY=0)→ 選單應向下翻轉,完整落在 viewport 內
  const top = await openAt(evaluate, 0);
  expect(top.menuHeight, '選單應已渲染(前置條件)').toBeGreaterThan(50);
  expect(top.menuTop, '頂緣開選單不得超出 viewport 上緣').toBeGreaterThanOrEqual(0);
  expect(top.menuBottom, '頂緣開選單應完整落在 viewport 內').toBeLessThanOrEqual(top.viewportH);

  // 按鈕在底部(預設 offsetY=1)→ 維持原向上行為,同樣完整落在 viewport 內
  const bottom = await openAt(evaluate, 1);
  expect(bottom.vDown, '底部開選單不該翻轉(維持向上)').toBe(false);
  expect(bottom.menuTop, '底部開選單不得超出 viewport 上緣').toBeGreaterThanOrEqual(0);
  expect(bottom.menuBottom, '底部開選單應完整落在 viewport 內').toBeLessThanOrEqual(bottom.viewportH);

  await page.close();
});
