// Regression: v2.0.71 popup 累計費用「清除」——顯示基準點重設(usageResetAt)。
//
// 行為通則:
//   1. popup 累計費用列有「清除」按鈕,點擊走 inline 確認 UI(同 clear-cache 模式,
//      Firefox popup 不能用 native confirm)
//   2. 確認「是」→ 寫 storage.local.usageResetAt = now,popup 累計改為只加總
//      基準點之後的紀錄(QUERY_USAGE_STATS 帶 from)→ 顯示歸零
//   3. 「否」→ 不寫任何 storage,顯示不變
//   4. usage-db 紀錄一筆都不刪:重設後 QUERY_USAGE_STATS 不帶 from 仍回舊紀錄
//      (options 用量明細分頁完全不受影響)
//
// SANITY 紀錄(已驗證 2026-07-30):
//   把 popup.js refreshUsageInfo 的 statsPayload 改回固定 `{}`(模擬沒接 usageResetAt)
//   → 「確認後顯示歸零」斷言 fail(cost 仍是舊累計)。還原 → 全綠。
// SANITY 紀錄(直式換行 case,已驗證 2026-07-30):
//   把 popup.css .clear-cache-confirm 的 white-space: nowrap + flex-shrink: 0 拔掉
//   → 「確認列不因空間擠壓直式換行」fail(whiteSpace 斷言)。還原 → 4 passed。

import { test, expect } from '../fixtures/extension.js';

async function getSW(context) {
  return context.serviceWorkers()[0]
    || (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
}

// 直接往 usage-db(IndexedDB)塞一筆舊紀錄,模擬歷史用量
async function seedUsageRecord(context, { timestamp, billedCostUSD }) {
  const sw = await getSW(context);
  await sw.evaluate(async ({ timestamp, billedCostUSD }) => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('shinkansen-usage', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('translations')) {
          const store = db.createObjectStore('translations', { keyPath: 'id', autoIncrement: true });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('translations', 'readwrite');
        tx.objectStore('translations').add({
          timestamp,
          site: 'example.com',
          model: 'gemini-3.5-flash-lite',
          inputTokens: 1000,
          outputTokens: 500,
          cachedTokens: 0,
          billedInputTokens: 1000,
          billedCostUSD,
          segments: 3,
        });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, { timestamp, billedCostUSD });
}

async function resetState(context) {
  const sw = await getSW(context);
  await sw.evaluate(async () => {
    await chrome.storage.local.remove('usageResetAt');
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase('shinkansen-usage');
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
}

test('popup 累計費用「清除」確認後歸零,usage-db 紀錄保留', async ({ context, extensionId }) => {
  await resetState(context);
  await seedUsageRecord(context, { timestamp: Date.now() - 60_000, billedCostUSD: 1.23 });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForSelector('#usage-info');

  // 清除前:顯示非零累計(1000 + 500 tokens)
  await expect(page.locator('#usage-info')).toContainText('1.5K');

  // 點「清除」→ inline 確認列出現
  await page.click('#clear-usage-btn');
  await expect(page.locator('#clear-usage-confirm')).toBeVisible();
  await expect(page.locator('#clear-usage-btn')).toBeHidden();

  // 確認「是」→ usageResetAt 寫入 + 顯示歸零
  await page.click('#clear-usage-yes');
  const start = Date.now();
  let resetAt = null;
  while (Date.now() - start < 5000) {
    resetAt = await page.evaluate(async () => {
      const r = await chrome.storage.local.get('usageResetAt');
      return r.usageResetAt ?? null;
    });
    if (typeof resetAt === 'number') break;
    await page.waitForTimeout(50);
  }
  expect(typeof resetAt).toBe('number');
  await expect(page.locator('#usage-info')).toContainText('0 tokens');

  // usage-db 未被刪:不帶 from 的 QUERY_USAGE_STATS 仍看得到舊紀錄
  //(= options 用量明細分頁資料完好)
  const fullStats = await page.evaluate(async () => {
    const resp = await chrome.runtime.sendMessage({ type: 'QUERY_USAGE_STATS', payload: {} });
    return resp?.stats || null;
  });
  expect(fullStats.count).toBe(1);
  expect(fullStats.totalBilledCostUSD).toBeCloseTo(1.23, 5);

  await page.close();
});

test('popup 累計費用「清除」按「否」取消,不寫 usageResetAt', async ({ context, extensionId }) => {
  await resetState(context);
  await seedUsageRecord(context, { timestamp: Date.now() - 60_000, billedCostUSD: 0.5 });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForSelector('#usage-info');
  await expect(page.locator('#usage-info')).toContainText('1.5K');

  await page.click('#clear-usage-btn');
  await expect(page.locator('#clear-usage-confirm')).toBeVisible();
  await page.click('#clear-usage-no');
  await expect(page.locator('#clear-usage-confirm')).toBeHidden();
  await expect(page.locator('#clear-usage-btn')).toBeVisible();

  const resetAt = await page.evaluate(async () => {
    const r = await chrome.storage.local.get('usageResetAt');
    return r.usageResetAt ?? null;
  });
  expect(resetAt).toBeNull();
  // 顯示仍是原累計
  await expect(page.locator('#usage-info')).toContainText('1.5K');

  await page.close();
});

test('確認列不因空間擠壓直式換行(iOS 觸控字級放大 + 長累計數字)', async ({ context, extensionId }) => {
  // v2.0.71 Jimmy 實機回報:「歸零？」在 iOS 觸控版被 flex 擠壓拆成直式兩行。
  // 修法:.clear-cache-confirm 加 white-space: nowrap + flex-shrink: 0,
  // 空間不足由 .cache-info 截斷(ellipsis)讓位。
  // 斷言:確認列 bounding height 必須是單行(< 2 倍行高);左側資訊文字有 ellipsis 能力。
  await resetState(context);
  await seedUsageRecord(context, { timestamp: Date.now() - 60_000, billedCostUSD: 231.0 });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForSelector('#usage-info');
  // 模擬 iOS 觸控版字級放大(回報環境)
  await page.evaluate(() => {
    document.body.classList.add('runtime-ios', 'runtime-ios-touch');
    document.body.style.setProperty('--sk-fz', '1.2');
  });
  await page.click('#clear-usage-btn');
  await expect(page.locator('#clear-usage-confirm')).toBeVisible();

  const m = await page.evaluate(() => {
    const confirm = document.getElementById('clear-usage-confirm');
    const cs = getComputedStyle(confirm);
    const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
    const info = getComputedStyle(document.getElementById('usage-info'));
    return {
      confirmH: confirm.getBoundingClientRect().height,
      lineH,
      whiteSpace: cs.whiteSpace,
      infoOverflow: info.textOverflow,
      infoWhiteSpace: info.whiteSpace,
    };
  });
  expect(m.whiteSpace).toBe('nowrap');
  expect(m.confirmH).toBeLessThan(m.lineH * 2); // 直式換行時高度會 ≥ 2 行
  expect(m.infoOverflow).toBe('ellipsis');
  expect(m.infoWhiteSpace).toBe('nowrap');

  await page.close();
});

test('重開 popup 後基準點仍生效(usageResetAt 持久化)', async ({ context, extensionId }) => {
  await resetState(context);
  const now = Date.now();
  await seedUsageRecord(context, { timestamp: now - 60_000, billedCostUSD: 2.0 });
  const sw = await getSW(context);
  await sw.evaluate(async (t) => { await chrome.storage.local.set({ usageResetAt: t }); }, now - 30_000);
  // 基準點之後又有一筆新用量
  await seedUsageRecord(context, { timestamp: now - 10_000, billedCostUSD: 0.05 });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForSelector('#usage-info');
  // 只算基準點之後那筆(1.5K tokens),不含舊的 3K 總量
  await expect(page.locator('#usage-info')).toContainText('1.5K');

  await page.close();
});
