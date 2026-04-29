// Unit test: GitHub Releases 更新檢查（v1.6.1 regression）
//
// 驗證 lib/update-check.js 的核心行為：
//   - 比對 GitHub latest tag 與 manifest.version
//   - latest > current → 寫入 storage.local.updateAvailable
//   - latest === current → 清掉 storage.local.updateAvailable（避免 stale）
//   - 非 development install → 直接 skip 不打 GitHub API
//   - parseVersion / isNewer 三段式版本比對正確
//
// Mock 策略：替換 globalThis.chrome（storage.local in-memory + runtime.getManifest）
// + globalThis.fetch 攔截 GitHub API。
// v1.8.18: isManualInstall() 改用 manifest.update_url 判斷(不再需要 management
// permission),mock 裡用 installType 變數推導 update_url:
//   installType === 'normal' → 注入 update_url(模擬 CWS Chrome 自動 inject)
//   其他 → 不注入 update_url(模擬手動安裝 / unpacked)
import { test, expect } from '@playwright/test';

const store = {};
let installType = 'development'; // 預設模擬 unpacked
let manifestVersion = '1.6.0';

globalThis.chrome = {
  storage: {
    sync: {
      get: async () => ({}),
      remove: async () => {},
    },
    local: {
      get: async (keys) => {
        if (keys === null) return { ...store };
        if (typeof keys === 'string') keys = [keys];
        const result = {};
        for (const k of keys) if (k in store) result[k] = store[k];
        return result;
      },
      set: async (items) => { Object.assign(store, items); },
      remove: async (keys) => {
        if (typeof keys === 'string') keys = [keys];
        for (const k of keys) delete store[k];
      },
    },
  },
  runtime: {
    getManifest: () => {
      const m = { version: manifestVersion };
      // 模擬 CWS 自動 inject 的 update_url(只有 'normal' install type 會有)
      if (installType === 'normal') {
        m.update_url = 'https://clients2.google.com/service/update2/crx';
      }
      return m;
    },
  },
};

let nextFetchResponse = null;
let fetchCalls = [];
// 包成 function 而非 inline,beforeEach 內重新設定 globalThis.fetch,
// 避免被其他 spec(workers=1 共享 globalThis)污染。
const fetchMock = async (url) => {
  fetchCalls.push(url);
  if (nextFetchResponse?.error) throw nextFetchResponse.error;
  return nextFetchResponse;
};
globalThis.fetch = fetchMock;

const { checkForUpdate, parseVersion, isNewer, isWorthNotifying, markUpdateNoticeShown, shouldShowTodayNotice, localTodayKey } =
  await import('../../shinkansen/lib/update-check.js');

function clearStore() { for (const k of Object.keys(store)) delete store[k]; }
function makeOkResp(tagName, htmlUrl = null) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: tagName,
      html_url: htmlUrl || `https://github.com/jimmysu0309/shinkansen/releases/tag/${tagName}`,
    }),
  };
}

test.beforeEach(() => {
  clearStore();
  fetchCalls = [];
  installType = 'development';
  manifestVersion = '1.6.0';
  // v1.8.0: 重新綁定 fetch mock,避免被前面的 spec(streaming-batch-incremental.spec.js
  // 等)留下的 fetch 殘留污染。
  globalThis.fetch = fetchMock;
});

test.describe('parseVersion / isNewer', () => {
  test('parseVersion 解析 v1.6.0 / 1.6.0 / v1.6.0-beta', () => {
    expect(parseVersion('v1.6.0')).toEqual([1, 6, 0]);
    expect(parseVersion('1.6.0')).toEqual([1, 6, 0]);
    expect(parseVersion('v1.6.0-beta')).toEqual([1, 6, 0]);
    expect(parseVersion('2.0')).toEqual([2, 0, 0]); // 補 0
  });

  test('isNewer：major / minor / patch 各維度', () => {
    expect(isNewer('1.6.1', '1.6.0')).toBe(true);   // patch
    expect(isNewer('1.7.0', '1.6.5')).toBe(true);   // minor 蓋掉 patch
    expect(isNewer('2.0.0', '1.99.99')).toBe(true); // major 蓋掉 minor/patch
    expect(isNewer('1.6.0', '1.6.0')).toBe(false);  // 相同
    expect(isNewer('1.5.9', '1.6.0')).toBe(false);  // 舊版
    expect(isNewer('v1.6.1', 'v1.6.0')).toBe(true); // v 前綴容忍
  });

  test('localTodayKey 用本地時區（不是 UTC），格式 YYYY-MM-DD', () => {
    const k = localTodayKey();
    expect(k).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 與 new Date() 的本地年月日一致（防止誤用 UTC）
    const d = new Date();
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(k).toBe(expected);
    // 在 UTC+0 以外時區，UTC 日期可能與本地差一天 — 確保我們不是用 UTC 計算
    // （測試環境 timezone 可能是 UTC，那這條退化為 == 對照組；非 UTC 環境會抓到 bug）
    const utcKey = new Date().toISOString().slice(0, 10);
    if (utcKey !== expected) {
      // 在跨日邊界時刻 UTC 與本地不同——確保我們用的是本地
      expect(k).toBe(expected);
      expect(k).not.toBe(utcKey);
    }
  });

  test('isWorthNotifying：只 major / minor 升才提示，patch 不提示', () => {
    // major 升 → 提示
    expect(isWorthNotifying('2.0.0', '1.6.4')).toBe(true);
    expect(isWorthNotifying('2.0.0', '1.99.99')).toBe(true);
    // minor 升 → 提示
    expect(isWorthNotifying('1.7.0', '1.6.4')).toBe(true);
    expect(isWorthNotifying('1.7.0', '1.6.99')).toBe(true);
    // patch 升 → **不提示**（避免高頻小改打擾使用者）
    expect(isWorthNotifying('1.6.5', '1.6.4')).toBe(false);
    expect(isWorthNotifying('1.6.10', '1.6.0')).toBe(false);
    // 相同 → 不提示
    expect(isWorthNotifying('1.6.4', '1.6.4')).toBe(false);
    // 舊版 → 不提示
    expect(isWorthNotifying('1.5.9', '1.6.0')).toBe(false);
  });
});

test.describe('checkForUpdate', () => {
  test('latest minor 升 → 寫入 updateAvailable + 回 hasUpdate=true', async () => {
    nextFetchResponse = makeOkResp('v1.7.0');
    const result = await checkForUpdate();
    expect(result.checked).toBe(true);
    expect(result.hasUpdate).toBe(true);
    expect(result.version).toBe('1.7.0');
    expect(store.updateAvailable).toBeDefined();
    expect(store.updateAvailable.version).toBe('1.7.0');
    expect(store.updateAvailable.releaseUrl).toContain('releases/tag/v1.7.0');
  });

  test('latest 只是 patch 升 → **不**寫 storage（避免小修打擾）', async () => {
    nextFetchResponse = makeOkResp('v1.6.1');  // 1.6.1 vs current 1.6.0 是 patch 級
    const result = await checkForUpdate();
    expect(result.hasUpdate).toBe(false);
    expect(store.updateAvailable).toBeUndefined();
  });

  test('latest === current → 清掉 storage.updateAvailable + 回 hasUpdate=false', async () => {
    // 先模擬「之前偵測過有新版」
    store.updateAvailable = { version: '1.7.0', releaseUrl: 'old' };
    manifestVersion = '1.7.0';
    nextFetchResponse = makeOkResp('v1.7.0');
    const result = await checkForUpdate();
    expect(result.checked).toBe(true);
    expect(result.hasUpdate).toBe(false);
    expect(store.updateAvailable).toBeUndefined(); // 被清
  });

  test('latest < current → 不寫 storage（極端，例如 GitHub 撤回 release）', async () => {
    manifestVersion = '1.7.0';
    nextFetchResponse = makeOkResp('v1.6.0');
    const result = await checkForUpdate();
    expect(result.hasUpdate).toBe(false);
    expect(store.updateAvailable).toBeUndefined();
  });

  test('CWS 安裝（manifest.update_url 存在）→ 不打 GitHub API', async () => {
    installType = 'normal'; // mock 依此推導 manifest.update_url 存在
    nextFetchResponse = makeOkResp('v9.9.9'); // 即使 GitHub 有新版也不該被讀
    const result = await checkForUpdate();
    expect(result.checked).toBe(false);
    expect(fetchCalls.length).toBe(0);
    expect(store.updateAvailable).toBeUndefined();
  });

  test('GitHub API 失敗（network error）→ 不清 storage（保留之前偵測結果）', async () => {
    store.updateAvailable = { version: '1.6.1', releaseUrl: 'http://example' };
    nextFetchResponse = { error: new Error('network error') };
    const result = await checkForUpdate();
    expect(result.checked).toBe(false);
    expect(result.error).toContain('network error');
    expect(store.updateAvailable).toBeDefined(); // 不被清
    expect(store.updateAvailable.version).toBe('1.6.1');
  });

  test('保留 lastNoticeShownDate（多次 check 之間每日節流不會被覆蓋）', async () => {
    store.updateAvailable = {
      version: '1.7.0',
      releaseUrl: 'old',
      lastNoticeShownDate: '2026-04-27',
    };
    nextFetchResponse = makeOkResp('v1.8.0'); // 又有新 minor 版
    await checkForUpdate();
    expect(store.updateAvailable.version).toBe('1.8.0'); // 版本更新
    expect(store.updateAvailable.lastNoticeShownDate).toBe('2026-04-27'); // 日期保留
  });
});

test.describe('shouldShowTodayNotice / markUpdateNoticeShown', () => {
  test('updateAvailable 不存在 → 回 null', async () => {
    expect(await shouldShowTodayNotice()).toBeNull();
  });

  test('今天首次（lastNoticeShownDate=null）→ 回版本資訊', async () => {
    store.updateAvailable = { version: '1.6.1', releaseUrl: 'http://x', lastNoticeShownDate: null };
    const r = await shouldShowTodayNotice();
    expect(r).not.toBeNull();
    expect(r.version).toBe('1.6.1');
  });

  test('lastNoticeShownDate === 今天 → 回 null（節流生效）', async () => {
    // v1.6.5: 用本地時區（與 production localTodayKey 同步）
    const _d = new Date();
    const today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`;
    store.updateAvailable = { version: '1.6.1', releaseUrl: 'http://x', lastNoticeShownDate: today };
    expect(await shouldShowTodayNotice()).toBeNull();
  });

  test('markUpdateNoticeShown 寫入今天日期', async () => {
    store.updateAvailable = { version: '1.6.1', releaseUrl: 'http://x' };
    await markUpdateNoticeShown();
    // v1.6.5: 用本地時區（與 production localTodayKey 同步）
    const _d = new Date();
    const today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`;
    expect(store.updateAvailable.lastNoticeShownDate).toBe(today);
  });
});

// SANITY 紀錄（已在 Claude Code 端驗過）：
//   把 update-check.js isNewer() 改成永遠回 false → 「latest > current → 寫入」spec fail。
//   把 isManualInstall() 改成永遠回 true（移除 update_url 判斷）→ 「CWS 安裝跳過」spec fail。
//   v1.8.18 sanity:把 isManualInstall() 內 `return !updateUrl` 改成 `return true`,
//     「CWS 安裝跳過」spec fail(fetch 被打,store 被寫)。還原 → pass。
//   還原後全部 pass。
