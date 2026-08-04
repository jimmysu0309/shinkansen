// Regression: debug-bridge-cache-peek-gate(code review 2026-08-03 批次 2 B5——
// GET_CACHE_PEEK 讓任意網頁讀跨站翻譯快取全文，隱私暴露面)
//
// Bug:v2.0.65 新增的 Debug Bridge 唯讀 action GET_CACHE_PEEK 對所有頁面常開，
// 惡意頁 dispatch `shinkansen-debug-request` 帶 contains 子字串即可撈 tc_ 池條目
// 全文(每次 20 條、可反覆換關鍵字探測)。快取是全域池，內含使用者在其他網站
// (Gmail、內部文件等)翻過的內容。
//
// 修法：PEEK 加 gate——僅 dev tail 版本(getManifest().version 四段 = unpacked
// working tree)啟用，商店版(三段)直接回 error。除錯本來就跑 dev tail，除錯能力
// 不受影響。寫入面設計不動(既定範圍)。
//
// 驅動方式：isolated world 內覆寫 chrome/browser.runtime.getManifest 模擬三段 /
// 四段版本(gate 在事件處理時才讀版本，覆寫即生效；不能依賴真 manifest——release
// 輪 manifest 還原三段時「允許」case 會反著炸)，再 dispatch bridge 事件斷言回應。
//
// SANITY 紀錄(已驗證，2026-08-04)：暫時把 content.js GET_CACHE_PEEK 分支的
// `if (!_isDevTail) { respond(...); return; }` gate 整段註解掉 → case 1 fail
// (三段版本收到 ok:true)→ 還原 → 全 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'debug-bridge-cache-peek';

async function setupPage(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);
  return { page, evaluate };
}

// isolated world 覆寫 getManifest(content script gate 讀的是 isolated world 的
// chrome/browser 物件)，回傳覆寫後讀到的版本供 spec 驗證覆寫真的生效
function overrideVersion(evaluate, version) {
  return evaluate(`
    (() => {
      const fake = () => ({ version: '${version}' });
      try { chrome.runtime.getManifest = fake; } catch (_) {}
      try { if (typeof browser !== 'undefined' && browser.runtime) browser.runtime.getManifest = fake; } catch (_) {}
      const rt = (typeof browser !== 'undefined' && browser.runtime) || chrome.runtime;
      return rt.getManifest().version;
    })()
  `);
}

function bridgeRequest(evaluate, detail) {
  return evaluate(`
    new Promise(resolve => {
      window.addEventListener('shinkansen-debug-response', e => resolve(e.detail), { once: true });
      window.dispatchEvent(new CustomEvent('shinkansen-debug-request', { detail: ${JSON.stringify(detail)} }));
      setTimeout(() => resolve('TIMEOUT'), 5000);
    })
  `);
}

test.describe('debug-bridge-cache-peek-gate', () => {
  test('case 1: 三段版本(商店版)→ GET_CACHE_PEEK 回 error，不吐快取內容', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);
    const seen = await overrideVersion(evaluate, '2.0.77');
    expect(seen, 'getManifest 覆寫必須生效，否則本 case 驗的是假訊號').toBe('2.0.77');

    const res = await bridgeRequest(evaluate, { action: 'GET_CACHE_PEEK', contains: 'anything' });
    expect(res).not.toBe('TIMEOUT');
    expect(res.ok, '商店版必須拒絕').toBe(false);
    expect(String(res.error)).toContain('dev tail');
    expect(res.hits, '不得回傳任何快取條目').toBeUndefined();
    await page.close();
  });

  test('case 2: 四段版本(dev tail)→ GET_CACHE_PEEK 照常運作', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);
    const seen = await overrideVersion(evaluate, '2.0.77.1');
    expect(seen).toBe('2.0.77.1');

    const res = await bridgeRequest(evaluate, { action: 'GET_CACHE_PEEK', contains: 'zzz-not-in-cache' });
    expect(res).not.toBe('TIMEOUT');
    expect(res.ok, 'dev tail 除錯能力不受影響').toBe(true);
    expect(Array.isArray(res.hits)).toBe(true);
    await page.close();
  });

  test('case 3: 三段版本下 GET_CACHE_STATS(條數統計)不受 gate 影響——gate 只擋內容全文', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);
    const seen = await overrideVersion(evaluate, '2.0.77');
    expect(seen).toBe('2.0.77');

    const res = await bridgeRequest(evaluate, { action: 'GET_CACHE_STATS' });
    expect(res).not.toBe('TIMEOUT');
    expect(res.ok, '既定範圍的統計 action 不動').toBe(true);
    await page.close();
  });
});
