// Regression: iOS 四指手勢觸發翻譯(content-touch.js,SPEC-PRIVATE §26.1)
//
// 行為:
//   - 四指手勢預設關閉(改由懸浮按鈕當主要觸控入口,易誤觸發故預設關),使用者在
//     Options 開啟 fourFingerGesture 後才生效。
//   - 四指「快點」(壓住 < LONGPRESS_MS 即抬起)= Alt+S 完整 toggle(主要預設 slot 2)。
//     送 FOUR_FINGER_TAP → background → TRANSLATE_PRESET slot 2。
//   - 四指「長按」(四指壓住達 LONGPRESS_MS 仍未抬起 / 未移動)= 次要預設 slot 1
//     (預設 Flash)。計時器在門檻當下送 FOUR_FINGER_LONGPRESS → background →
//     TRANSLATE_PRESET slot 1,抬起時不再額外送 slot 2(longPressFired guard)。
//
// 本 spec 鎖的訊號層次(CLAUDE.md 工作流原則 3):
//   驗「synthetic TouchEvent → content-touch 手勢判定(快點 vs 長按單一門檻) →
//   background FOUR_FINGER_TAP / FOUR_FINGER_LONGPRESS relay → TRANSLATE_PRESET
//   onMessage → handleTranslatePreset → SK.translatePage」整條跨 isolated world +
//   service worker 的真實訊息路徑,以及 IS_IOS_BUILD gate、swipe / 五指兩種不該觸發
//   的手勢分支、長按不重複觸發 slot 2 的 guard。
//   不驗:真實 iOS Safari 的 touch 事件派發行為與 iPadOS 系統手勢搶占(Playwright
//   Chromium 無法模擬,Phase 3 真機驗收)、translatePage 後續翻譯流程(其他 spec 鎖)。
//
// SANITY CHECK 紀錄(已驗證,2026-06-05):
//   暫時把 content-touch.js 的 isEnabled() 改成永遠回 false → 「四指 tap →
//   translatePage(slot 2)」case fail(0 call),還原後全綠。
// SANITY CHECK 紀錄(長按,已驗證,2026-06-14):
//   暫時把 content-touch.js touchstart 的 gesture.timer setTimeout 整段拿掉 →
//   「四指長按 → slot 1」case fail(0 call),還原後全綠。
// SANITY CHECK 紀錄(fourFingerGesture 開關,已驗證):
//   暫時把 isEnabled() 改成只回 SK.IS_IOS_BUILD===true(忽略 fourFingerEnabled)→
//   「Options 關閉 fourFingerGesture → 四指 tap 不觸發」case fail(1 call),還原後全綠。
// SANITY CHECK 紀錄(部分抬起取消長按,已驗證,2026-08-04):
//   暫時把 content-touch.js touchend 部分抬起分支的 clearGestureTimer() 註解掉
//   (回到「> 0 直接 return 不清計時器」舊 code)→ 「部分抬起後剩一指壓超過門檻
//   不得誤發長按 slot 1」case fail(收到 slot 1 call),還原後全綠。
// SANITY CHECK 紀錄(預設關閉,已驗證):
//   暫時把 content-touch.js 的 `let fourFingerEnabled = false` 改回 true →
//   「production 預設(無 key)→ 四指 tap 不觸發」case fail(getter 收到 true),還原後全綠。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'ios-four-finger-tap';

// 在 page main world 派發 synthetic touch 手勢。
// content-touch.js 的 listener 掛在 isolated world 的 window 上,但 DOM 事件
// 跨 world 共享,main world dispatch 的 TouchEvent 兩邊都收得到。
const DISPATCH_HELPERS = `
  window.__mkTouches = (n, dx = 0) => Array.from({ length: n }, (_, i) =>
    new Touch({ identifier: i, target: document.body, clientX: 100 + i * 30 + dx, clientY: 200 }));
  window.__touch = (type, touches) =>
    window.dispatchEvent(new TouchEvent(type, { touches, changedTouches: touches, bubbles: true }));
`;

async function setupPage(context, localServer, { iosBuild, enableGesture = false }) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#para', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  if (iosBuild) {
    // 模擬 iOS build:distribution-cs.js 在 iOS build 被 safari-build-ios.sh
    // override 成 true。content-touch.js 的 isEnabled() 動態讀,runtime 翻 flag 即生效。
    await evaluate(`window.__SK.IS_IOS_BUILD = true`);
  }
  // 四指手勢預設關閉(改由懸浮按鈕當主要觸控入口)。同 context 跨 test 共用 storage,
  // 故每個 test 都把旗標設成已知狀態:enableGesture → 寫 true;否則 remove 還原成
  // 「production 預設(無 key)」。寫入後輪詢 getter 確認 onChanged 已生效再派發手勢。
  const wantEnabled = enableGesture === true;
  if (wantEnabled) {
    await evaluate(`browser.storage.sync.set({ fourFingerGesture: true })`);
  } else {
    await evaluate(`browser.storage.sync.remove('fourFingerGesture')`);
  }
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (await evaluate(`window.__SK.getFourFingerEnabled()`) === wantEnabled) break;
    await page.waitForTimeout(50);
  }
  // Stub 掉 translatePage:本 spec 只鎖「手勢 → preset 派送」路徑,
  // 不讓真實翻譯流程(API call / toast)跑起來
  await evaluate(`
    window.__tapCalls = [];
    window.__SK.translatePage = (opts) => { window.__tapCalls.push(opts || {}); };
    window.__SK.translatePageGoogle = (opts) => { window.__tapCalls.push({ google: true, ...(opts || {}) }); };
  `);
  await page.evaluate(DISPATCH_HELPERS);
  return { page, evaluate };
}

// 派發後輪詢 call 數(訊息要過 background round-trip,非同步)
async function readCalls(page, evaluate, expectAtLeast) {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const calls = await evaluate(`window.__tapCalls`);
    if (calls.length >= expectAtLeast) return calls;
    await page.waitForTimeout(50);
  }
  return await evaluate(`window.__tapCalls`);
}

test('四指 tap → 走 TRANSLATE_PRESET slot 2 → translatePage 被呼叫', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer, { iosBuild: true, enableGesture: true });

  await page.evaluate(`
    (() => {
      const ts = window.__mkTouches(4);
      window.__touch('touchstart', ts);
      window.__touch('touchend', []);
    })()
  `);

  const calls = await readCalls(page, evaluate, 1);
  expect(calls.length, 'translatePage 應被呼叫恰好 1 次').toBe(1);
  expect(calls[0].slot, '應走主要預設 slot 2(= Alt+S)').toBe(2);
  expect(calls[0].google, 'DEFAULT preset slot 2 是 gemini,不該走 translatePageGoogle').toBeUndefined();
});

test('IS_IOS_BUILD=false(桌面 build 預設)→ 四指 tap 不觸發', async ({ context, localServer }) => {
  // enableGesture: true 確認擋下的是 IS_IOS_BUILD gate,而非四指手勢預設關閉
  const { page, evaluate } = await setupPage(context, localServer, { iosBuild: false, enableGesture: true });

  await page.evaluate(`
    (() => {
      const ts = window.__mkTouches(4);
      window.__touch('touchstart', ts);
      window.__touch('touchend', []);
    })()
  `);

  await page.waitForTimeout(800);
  const calls = await evaluate(`window.__tapCalls`);
  expect(calls.length, '桌面 build gate 應擋下手勢').toBe(0);
});

test('Options 關閉 fourFingerGesture → 四指 tap 不觸發（IS_IOS_BUILD=true 也擋下）', async ({ context, localServer }) => {
  // 先開啟（enableGesture: true）再關掉,驗證 on → off 的 onChanged 轉換真的擋下手勢
  const { page, evaluate } = await setupPage(context, localServer, { iosBuild: true, enableGesture: true });

  // 使用者在 Options 關掉四指手勢：寫 storage.sync.fourFingerGesture=false。
  // content-touch.js 的 onChanged 會更新內部旗標,輪詢 getter 確認已生效再派發。
  await evaluate(`browser.storage.sync.set({ fourFingerGesture: false })`);
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (await evaluate(`window.__SK.getFourFingerEnabled()`) === false) break;
    await page.waitForTimeout(50);
  }
  expect(await evaluate(`window.__SK.getFourFingerEnabled()`), '旗標應已翻為 false').toBe(false);

  await page.evaluate(`
    (() => {
      const ts = window.__mkTouches(4);
      window.__touch('touchstart', ts);
      window.__touch('touchend', []);
    })()
  `);

  await page.waitForTimeout(800);
  const calls = await evaluate(`window.__tapCalls`);
  expect(calls.length, '關閉四指手勢後 gate 應擋下').toBe(0);

  // 還原（不污染同 context 後續 test 的 storage）
  await evaluate(`browser.storage.sync.remove('fourFingerGesture')`);
});

test('production 預設(無 fourFingerGesture key)→ 四指 tap 不觸發', async ({ context, localServer }) => {
  // 四指手勢預設關閉(改由懸浮按鈕當主要觸控入口)。setupPage 不帶 enableGesture →
  // remove storage key → 等同首次安裝 / 沒設過的使用者。即使 IS_IOS_BUILD=true 也不該觸發。
  const { page, evaluate } = await setupPage(context, localServer, { iosBuild: true });

  expect(await evaluate(`window.__SK.getFourFingerEnabled()`), '無設定時旗標應為 false').toBe(false);

  await page.evaluate(`
    (() => {
      const ts = window.__mkTouches(4);
      window.__touch('touchstart', ts);
      window.__touch('touchend', []);
    })()
  `);

  await page.waitForTimeout(800);
  const calls = await evaluate(`window.__tapCalls`);
  expect(calls.length, '預設關閉時四指 tap 不該觸發翻譯').toBe(0);
});

test('四指 swipe(移動超過容差)→ 不觸發', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer, { iosBuild: true, enableGesture: true });

  await page.evaluate(`
    (() => {
      const ts = window.__mkTouches(4);
      window.__touch('touchstart', ts);
      // 全部手指平移 80px(> MOVE_TOLERANCE_PX 30)= iPadOS 多工 swipe 型手勢
      window.__touch('touchmove', window.__mkTouches(4, 80));
      window.__touch('touchend', []);
    })()
  `);

  await page.waitForTimeout(800);
  const calls = await evaluate(`window.__tapCalls`);
  expect(calls.length, 'swipe 不該觸發翻譯').toBe(0);
});

test('五指落下 → 不觸發(讓位 iPadOS 系統手勢)', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer, { iosBuild: true, enableGesture: true });

  await page.evaluate(`
    (() => {
      window.__touch('touchstart', window.__mkTouches(4));
      window.__touch('touchstart', window.__mkTouches(5)); // 第五指落下
      window.__touch('touchend', []);
    })()
  `);

  await page.waitForTimeout(800);
  const calls = await evaluate(`window.__tapCalls`);
  expect(calls.length, '五指手勢不該觸發翻譯').toBe(0);
});

test('四指長按達門檻 → 走 TRANSLATE_PRESET slot 1 → translatePage 恰 1 次(不重複送 slot 2)', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer, { iosBuild: true, enableGesture: true });

  // 四指壓住不抬起,等過 LONGPRESS_MS(600)讓計時器觸發長按
  await page.evaluate(`window.__touch('touchstart', window.__mkTouches(4))`);
  await page.waitForTimeout(750); // > LONGPRESS_MS 600
  // 計時器應已送出 slot 1;此時才抬起,longPressFired guard 應擋住 slot 2
  await page.evaluate(`window.__touch('touchend', [])`);

  const calls = await readCalls(page, evaluate, 1);
  expect(calls.length, '長按應觸發恰好 1 次(抬起不重複送 slot 2)').toBe(1);
  expect(calls[0].slot, '應走次要預設 slot 1(預設 Flash)').toBe(1);
  expect(calls[0].google, 'DEFAULT preset slot 1 是 gemini,不該走 translatePageGoogle').toBeUndefined();
});

test('四指按下後抬三指剩一指壓超過門檻 → 不觸發 slot 1(部分抬起取消長按)', async ({ context, localServer }) => {
  // Regression(2026-08-03 code review D2):touchend 在 e.touches.length > 0 時
  // 直接 return 不清計時器 → 抬起三指、剩一指壓超過 LONGPRESS_MS,計時器照樣
  // 觸發 FOUR_FINGER_LONGPRESS 誤發 slot 1。長按語意 = 四指「全程」壓住,
  // 任一指抬起即取消長按候選。上一個 case(四指壓好壓滿 → slot 1)是本 case 的
  // 正向對照組,確保修法沒把合法長按一起殺掉。
  const { page, evaluate } = await setupPage(context, localServer, { iosBuild: true, enableGesture: true });

  await page.evaluate(`
    (() => {
      const ts = window.__mkTouches(4);
      window.__touch('touchstart', ts);
      // 立即抬起三指:touchend 的 e.touches = 剩餘 1 指(不含已抬起的)
      window.__touch('touchend', ts.slice(0, 1));
    })()
  `);
  // 剩一指壓超過 LONGPRESS_MS(600)——舊 code 計時器未清,此處會誤發 slot 1
  await page.waitForTimeout(900);
  await page.evaluate(`window.__touch('touchend', [])`); // 最後一指抬起

  await page.waitForTimeout(800); // 給訊息 round-trip 時間(若誤發的話)
  const calls = await evaluate(`window.__tapCalls`);
  expect(calls.filter((c) => c.slot === 1).length, '部分抬起後剩一指壓超過門檻不得誤發長按 slot 1').toBe(0);
  // elapsed >= LONGPRESS_MS 的防禦性早退也擋 tap → 全程不該有任何觸發
  expect(calls.length, '此手勢全程不該觸發任何翻譯').toBe(0);
});
