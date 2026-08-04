// Unit test: lib/google-translate.js（v1.4.0 regression）
//
// 驗證 translateGoogleBatch 的兩條核心行為：
//   (1) SEP 串接：多段文字合成單一 fetch 請求，回應後正確拆回對應數量
//   (2) URL 長度分塊：encodeURIComponent 後超過 5500 chars 的批次自動分多次 fetch
//
// Mock 策略：替換 globalThis.fetch，根據 URL 中的 q= 參數拆 SEP 計算批次內文字數，
// 回傳對應數量的假譯文片段（每段以 SEP 串接）。回傳結構模擬 Google Translate 的
// [[[chunk, ...], ...]] 格式。
//
// 為什麼用 globalThis.fetch 而不是 page.route：google-translate.js 是 ES module，
// 直接呼叫 globalThis.fetch；Node 環境下替換 globalThis.fetch 即可，不需要瀏覽器。
import { test, expect } from '@playwright/test';

const SEP = '\n\u2063\u2063\u2063\n';

// fetch 呼叫紀錄，每測試清空
let fetchCalls = [];

globalThis.fetch = async (url) => {
  fetchCalls.push(url);

  // 從 URL 抽出 q= 後的內容，decode 後依 SEP 拆出原文片段數量
  const match = String(url).match(/[?&]q=([^&]*)/);
  const q = match ? decodeURIComponent(match[1]) : '';
  const sourceParts = q.split(SEP);

  // 假譯文：每段固定為「[ZH] <原文>」，再以 SEP 串成單一字串模擬 Google 的回傳
  const translatedJoined = sourceParts.map(s => `[ZH] ${s}`).join(SEP);

  // Google Translate 回應格式：[[[chunk, source, ...], ...], ...]
  // _fetchTranslate 取 data[0] 中所有陣列的第一個欄位串接
  // 這裡把整段譯文塞進單一 chunk 裡，符合最簡 case。
  return {
    ok: true,
    json: async () => [[[translatedJoined, q, null, null, 1]]],
  };
};

const { translateGoogleBatch } = await import('../../shinkansen/lib/google-translate.js');

test.beforeEach(() => {
  fetchCalls = [];
});

test('translateGoogleBatch: 3 段文字 → 1 次 fetch → 拆回 3 段譯文', async () => {
  const inputs = ['Hello', 'World', 'Goodbye'];
  const { translations, chars } = await translateGoogleBatch(inputs);

  expect(fetchCalls.length).toBe(1);
  expect(translations.length).toBe(3);
  expect(translations[0]).toBe('[ZH] Hello');
  expect(translations[1]).toBe('[ZH] World');
  expect(translations[2]).toBe('[ZH] Goodbye');
  expect(chars).toBe('Hello'.length + 'World'.length + 'Goodbye'.length);
});

test('translateGoogleBatch: 空陣列 → 不發 fetch', async () => {
  const { translations, chars } = await translateGoogleBatch([]);
  expect(fetchCalls.length).toBe(0);
  expect(translations).toEqual([]);
  expect(chars).toBe(0);
});

test('translateGoogleBatch: 長文字超過 URL 上限 → 自動分多次 fetch', async () => {
  // MAX_URL_ENCODED_CHARS = 5500。每段 1500 字 ASCII（encode 後仍 1500），
  // 4 段 = 6000，超過上限 → 應分成至少 2 批
  const long = 'A'.repeat(1500);
  const inputs = [long, long, long, long];
  const { translations } = await translateGoogleBatch(inputs);

  expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
  expect(translations.length).toBe(4);
  // 每段譯文應該都對應到原文（mock 加 [ZH] 前綴後等於原文）
  for (const t of translations) {
    expect(t).toBe(`[ZH] ${long}`);
  }
});

test('translateGoogleBatch: 索引保留正確（多批次 result 依 idx 寫回）', async () => {
  // 用第三個測試的長度結構，但每段給不同前綴以便辨識索引
  const inputs = [
    'A' + 'x'.repeat(1499),
    'B' + 'x'.repeat(1499),
    'C' + 'x'.repeat(1499),
    'D' + 'x'.repeat(1499),
  ];
  const { translations } = await translateGoogleBatch(inputs);

  expect(translations.length).toBe(4);
  expect(translations[0].startsWith('[ZH] A')).toBe(true);
  expect(translations[1].startsWith('[ZH] B')).toBe(true);
  expect(translations[2].startsWith('[ZH] C')).toBe(true);
  expect(translations[3].startsWith('[ZH] D')).toBe(true);
});

// v1.8.61: targetLanguage 必須帶進 URL 的 tl= 參數（之前寫死 zh-TW,
// 導致 zh-CN / en / ja 等其他 target 都翻成繁中)。
test('translateGoogleBatch: 預設不帶 target → URL tl=zh-TW', async () => {
  await translateGoogleBatch(['Hello']);
  expect(fetchCalls.length).toBe(1);
  const tlMatch = String(fetchCalls[0]).match(/[?&]tl=([^&]*)/);
  expect(tlMatch).not.toBeNull();
  expect(decodeURIComponent(tlMatch[1])).toBe('zh-TW');
});

test('translateGoogleBatch: target=ja → URL tl=ja', async () => {
  await translateGoogleBatch(['Hello'], 'ja');
  expect(fetchCalls.length).toBe(1);
  const tlMatch = String(fetchCalls[0]).match(/[?&]tl=([^&]*)/);
  expect(decodeURIComponent(tlMatch[1])).toBe('ja');
});

test('translateGoogleBatch: target=zh-CN → URL tl=zh-CN', async () => {
  await translateGoogleBatch(['Hello'], 'zh-CN');
  expect(fetchCalls.length).toBe(1);
  const tlMatch = String(fetchCalls[0]).match(/[?&]tl=([^&]*)/);
  expect(decodeURIComponent(tlMatch[1])).toBe('zh-CN');
});

test('translateGoogleBatch: 不認得的 target → fallback tl=zh-TW', async () => {
  await translateGoogleBatch(['Hello'], 'xx-YY');
  expect(fetchCalls.length).toBe(1);
  const tlMatch = String(fetchCalls[0]).match(/[?&]tl=([^&]*)/);
  expect(decodeURIComponent(tlMatch[1])).toBe('zh-TW');
});

// v1.9.5: per-unit retry on echo —— Google MT 對某些 batch 會把 unit 原樣回傳,
// 整批跑完後逐筆 retry 補救。下面 3 條測試覆蓋此邏輯。
//
// fetch mock 策略:用 callCount 區分「initial batch」(callCount=1) vs「retry singleton」
// (callCount=2+),initial 對指定 unit 回傳 source 不變(echo),retry 走真翻譯。
// 透過 try/finally 還原 globalThis.fetch 避免污染後續測試。

test('translateGoogleBatch: 批次內某 unit 被 echo 原文 → 觸發 per-unit retry → 救回譯文', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    callCount++;
    const match = String(url).match(/[?&]q=([^&]*)/);
    const q = match ? decodeURIComponent(match[1]) : '';
    const sourceParts = q.split(SEP);

    if (callCount === 1) {
      // initial batch:"Echo me" 原文 echo,其他段正常翻
      const translatedParts = sourceParts.map(s =>
        s === 'Echo me' ? s : `[ZH] ${s}`
      );
      const joined = translatedParts.join(SEP);
      return { ok: true, json: async () => [[[joined, q]]] };
    }
    // retry:單筆送進來真翻
    return { ok: true, json: async () => [[[`[ZH] ${q}`, q]]] };
  };

  try {
    const inputs = ['Hello', 'Echo me', 'World'];
    const { translations } = await translateGoogleBatch(inputs);

    // 1 initial + 1 retry(只有 "Echo me" 需 retry)
    expect(fetchCalls.length).toBe(2);
    expect(translations[0]).toBe('[ZH] Hello');
    expect(translations[1]).toBe('[ZH] Echo me'); // 救回
    expect(translations[2]).toBe('[ZH] World');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('translateGoogleBatch: 整批全 echo → 全部逐筆 retry', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    callCount++;
    const match = String(url).match(/[?&]q=([^&]*)/);
    const q = match ? decodeURIComponent(match[1]) : '';

    if (callCount === 1) {
      // initial:整批 echo
      return { ok: true, json: async () => [[[q, q]]] };
    }
    return { ok: true, json: async () => [[[`[ZH] ${q}`, q]]] };
  };

  try {
    const inputs = ['A', 'B', 'C'];
    const { translations } = await translateGoogleBatch(inputs);

    // 1 initial + 3 retry(每段都需 retry)
    expect(fetchCalls.length).toBe(4);
    expect(translations).toEqual(['[ZH] A', '[ZH] B', '[ZH] C']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('translateGoogleBatch: retry 仍 echo(genuinely already in target)→ 維持 echo 值,不阻擋整批', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    const match = String(url).match(/[?&]q=([^&]*)/);
    const q = match ? decodeURIComponent(match[1]) : '';
    const sourceParts = q.split(SEP);
    // initial AND retry 都 echo(任何 fetch 都回 source 不變)
    const translated = sourceParts.map(s => s).join(SEP);
    return { ok: true, json: async () => [[[translated, q]]] };
  };

  try {
    const inputs = ['已是繁中一', '已是繁中二'];
    const { translations } = await translateGoogleBatch(inputs);

    // initial(1)+ retry 2 筆(2)= 3
    expect(fetchCalls.length).toBe(3);
    // retry 仍 echo → 結果維持原 echo 值,不 throw、不阻擋整批
    expect(translations).toEqual(['已是繁中一', '已是繁中二']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// v1.9.8: dominant-script 分群避免混批 garbage —— Google MT 對混批時 sl=auto
// 偵測整批多數派 lang,夾在裡面的少數派 lang 段會被當「異種變體」字碼級轉換,
// 譯文出現英文殘骸 + 漢字殘渣 garbage(echo retry 抓不到這類部分腐壞)。
// 解法:texts 預先按 CJK / Latin 主導語言分群,各群獨立打 fetch。

test('translateGoogleBatch: CJK + Latin 混批 → 分 2 次 fetch(各群獨立)', async () => {
  const inputs = [
    '這是一段繁體中文,字數足以判定 CJK 主導',  // CJK
    'This is an English paragraph long enough to be Latin-dominant',  // Latin
    '另一段繁體中文段落',  // CJK
    'Another English line here',  // Latin
  ];
  const { translations } = await translateGoogleBatch(inputs);

  expect(fetchCalls.length).toBe(2);
  const decodedQs = fetchCalls.map(url => {
    const m = String(url).match(/[?&]q=([^&]*)/);
    return decodeURIComponent(m[1]);
  });
  // CJK fetch 不含 English 段;Latin fetch 不含 CJK 段
  const cjkFetch = decodedQs.find(q => q.includes('繁體中文'));
  const latinFetch = decodedQs.find(q => q.includes('English'));
  expect(cjkFetch).toBeDefined();
  expect(latinFetch).toBeDefined();
  expect(cjkFetch).not.toContain('English');
  expect(latinFetch).not.toContain('繁體中文');

  // 譯文仍按原 idx 順序回 4 段
  expect(translations.length).toBe(4);
  expect(translations[0]).toBe('[ZH] ' + inputs[0]);
  expect(translations[1]).toBe('[ZH] ' + inputs[1]);
  expect(translations[2]).toBe('[ZH] ' + inputs[2]);
  expect(translations[3]).toBe('[ZH] ' + inputs[3]);
});

test('translateGoogleBatch: 全 CJK 批次 → 仍 1 次 fetch(同 script 不分群)', async () => {
  const inputs = ['中文段一', '另一段中文', '第三段'];
  const { translations } = await translateGoogleBatch(inputs);
  expect(fetchCalls.length).toBe(1);
  expect(translations.length).toBe(3);
});

test('translateGoogleBatch: 全 Latin 批次 → 仍 1 次 fetch', async () => {
  const inputs = ['Hello world here', 'Another sentence done', 'Third one ok'];
  const { translations } = await translateGoogleBatch(inputs);
  expect(fetchCalls.length).toBe(1);
  expect(translations.length).toBe(3);
});

test('translateGoogleBatch: 段內混雜以主導字數判定群組(整段算同一邊)', async () => {
  // 每段內部都有少量另一語言字元,但主導仍然清楚
  const inputs = [
    'Damn，Redis 創辦人用一個 C 文件,乾翻了大廠燒幾十億 GPU',  // CJK 主導
    'The 1M context on 128GB MacBook Pro is the real story',     // Latin 主導
  ];
  const { translations } = await translateGoogleBatch(inputs);
  expect(fetchCalls.length).toBe(2);
  expect(translations.length).toBe(2);
  expect(translations[0]).toBe('[ZH] ' + inputs[0]);
  expect(translations[1]).toBe('[ZH] ' + inputs[1]);
});

// SANITY check（手動驗證紀錄，已在 Claude Code 端跑過）：
//   把 google-translate.js line 33 的條件 `cur.length > 0 && curEncodedLen + eLen > MAX_URL_ENCODED_CHARS`
//   改為 `false`（永不切批），第三條測試 fetchCalls.length 會降為 1，斷言 fail。
//   還原後 pass。已驗證。
//
// v1.8.61 SANITY check：
//   把 google-translate.js 的 `tl=${encodeURIComponent(tl)}` 改回 `tl=zh-TW` 寫死,
//   "target=ja" / "target=zh-CN" / "fallback" 三條測試會 fail(實際 tl 都是 zh-TW)。
//   還原後 4 條 target language 測試全 pass。已驗證。
//
// v1.9.8 SANITY check(dominant-script 分群):
//   把 google-translate.js translateGoogleBatch 內 byScript 兩群初始化改成
//   `const byScript = { cjk: [], latin: [] };` 之後緊接的 push 改成
//   `byScript.cjk.push({ idx: i, text: t });`(全部塞同一群)→
//   「CJK + Latin 混批」測試 fetchCalls 從 2 降到 1,「段內混雜」測試同樣降到 1,fail。
//   還原為 dominantScript 分群後 3 條全 pass(全 CJK / 全 Latin 兩條一直都是 1 次 fetch)。
//   已驗證。

// v1.9.5 SANITY check(per-unit retry):
//   把 google-translate.js translateGoogleBatch 內整段 `if (needsRetry.length > 0) { ... }`
//   區塊註解掉(讓 echo 直接寫回 result 不 retry)→
//   「批次內某 unit 被 echo 原文」測試 fetchCalls 從 2 降到 1、translations[1] 變成 'Echo me'(沒救回),
//   「整批全 echo」測試 fetchCalls 從 4 降到 1、translations 全為原文,
//   「retry 仍 echo」測試 fetchCalls 從 3 降到 1。
//   還原後 3 條全 pass。已驗證。

// ── v1.10.46(批次 2-8):echo retry 上限與間隔 ──
//
// 原 bug:整頁已是 target 的頁面會讓每段都 echo → 全部進 needsRetry → N 段 = N 次
// serial 重打非官方端點(請求密度高,IP 被封風險);v1.9.5 的 retry 完全無上限無間隔。
//
// 修法:「> RETRY_SKIP_THRESHOLD(20)段且全數 echo」視為整頁已是 target,直接放棄
// retry(echo 值本來就是正解);其餘 retry 逐筆間加 RETRY_DELAY_MS(150ms)。
//
// SANITY 紀錄(已驗證,2026-06-11):暫時把 translateGoogleBatch 的
// `if (needsRetry.length > RETRY_SKIP_THRESHOLD && allEcho)` skip 分支拿掉(恢復
// 無條件 retry)→「25 段全 echo 不得逐筆 retry」case fail(fetchCalls 1 → 26)
// → 還原 → pass。

test('2-8: 25 段全 echo(>20)→ 視為整頁已是 target,不逐筆 retry', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    const match = String(url).match(/[?&]q=([^&]*)/);
    const q = match ? decodeURIComponent(match[1]) : '';
    const sourceParts = q.split(SEP);
    // 任何 fetch 都 echo(整頁已是 target 的情境)
    return { ok: true, json: async () => [[[sourceParts.join(SEP), q]]] };
  };

  try {
    const inputs = Array.from({ length: 25 }, (_, i) => `Paragraph number ${i}`);
    const { translations } = await translateGoogleBatch(inputs);

    // 原 bug:1 initial + 25 retry = 26 次。修後只剩 initial(可能因 URL 長度切 1-2 批)
    expect(fetchCalls.length).toBeLessThanOrEqual(2);
    // echo 值即正解,維持原文
    expect(translations).toEqual(inputs);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('2-8: 3 段全 echo(≤20)→ 仍逐筆 retry(safety net 行為不變),retry 間有 delay', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    callCount++;
    const match = String(url).match(/[?&]q=([^&]*)/);
    const q = match ? decodeURIComponent(match[1]) : '';
    if (callCount === 1) {
      return { ok: true, json: async () => [[[q, q]]] }; // initial 全 echo
    }
    return { ok: true, json: async () => [[[`[ZH] ${q}`, q]]] }; // retry 真翻
  };

  try {
    const inputs = ['Alpha', 'Beta', 'Gamma'];
    const t0 = Date.now();
    const { translations } = await translateGoogleBatch(inputs);
    const elapsed = Date.now() - t0;

    expect(fetchCalls.length).toBe(4); // 1 initial + 3 retry
    expect(translations).toEqual(['[ZH] Alpha', '[ZH] Beta', '[ZH] Gamma']);
    // 3 筆 retry 之間 2 段 delay(150ms × 2)→ 至少 250ms(留 margin 防 timer 抖動)
    expect(elapsed).toBeGreaterThanOrEqual(250);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('2-8: 25 段但僅部分 echo → 不觸發 skip(非全 echo),echo 段仍被 retry 救回', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    const match = String(url).match(/[?&]q=([^&]*)/);
    const q = match ? decodeURIComponent(match[1]) : '';
    const sourceParts = q.split(SEP);
    if (sourceParts.length > 1) {
      // initial batch:只 echo "Echo target",其他正常翻
      return {
        ok: true,
        json: async () => [[[sourceParts.map(s => (s === 'Echo target' ? s : `[ZH] ${s}`)).join(SEP), q]]],
      };
    }
    return { ok: true, json: async () => [[[`[ZH] ${q}`, q]]] }; // retry 真翻
  };

  try {
    const inputs = [...Array.from({ length: 24 }, (_, i) => `Sentence ${i}`), 'Echo target'];
    const { translations } = await translateGoogleBatch(inputs);

    expect(translations[24]).toBe('[ZH] Echo target'); // retry 救回
    expect(translations[0]).toBe('[ZH] Sentence 0');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── code review 2026-08-03 批次 2 E3:SEP 中間丟失 → 整組 retry ──
//
// 原 bug:`parts = full.split(SEP)` 後只逐位比對，`parts[j] == null`(尾端缺)才進
// retry。Google 只吞掉「中間」一個 SEP 時(程式註解自己承認會發生),parts 整體前移
// ——合併點之後每段都拿到「上一段的譯文」，非 null 也非 echo → 三檢查全 pass，錯位
// 譯文靜默回傳並在 background cache.setBatch 永久快取；只有最後一段(undefined)進 retry。
//
// 修法：`parts.length !== group.length` 時整組視為 SEP 邊界丟失，全數用原文
// placeholder 進逐筆 retry；並以 hadSepLoss 旗標把這批 retry 排除在
// 「>20 段全 echo = 整頁已是 target」的 skip 推定之外(placeholder 也是原文，
// 跟 echo 分不開，skip 會讓整組永遠停在原文)。
//
// SANITY 紀錄(已驗證，2026-08-04)：暫時把 google-translate.js 的
// `if (parts.length !== group.length) { ... continue; }` 整段註解掉 →
// 「SEP 中間丟失」case fail(translations[0] 收到 '[ZH] Alpha[ZH] Beta' 錯位串、
// translations[1] 收到 '[ZH] Gamma')、「25 段 SEP 丟失」case fail(translations
// 全維持原文，retry 被全 echo skip 誤殺)→ 還原 → 兩條 pass。

test('E3: SEP 中間丟失(3 段回 2 parts)→ 整組逐筆 retry，譯文不錯位', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    const match = String(url).match(/[?&]q=([^&]*)/);
    const q = match ? decodeURIComponent(match[1]) : '';
    const sourceParts = q.split(SEP);
    if (sourceParts.length > 1) {
      // initial batch：模擬 Google 吞掉第一個 SEP——前兩段譯文黏成一段，回 2 parts
      const joined = [`[ZH] ${sourceParts[0]}[ZH] ${sourceParts[1]}`, `[ZH] ${sourceParts[2]}`].join(SEP);
      return { ok: true, json: async () => [[[joined, q]]] };
    }
    return { ok: true, json: async () => [[[`[ZH] ${q}`, q]]] }; // retry 真翻
  };

  try {
    const inputs = ['Alpha', 'Beta', 'Gamma'];
    const { translations } = await translateGoogleBatch(inputs);

    // 1 initial + 3 retry(整組進 retry)
    expect(fetchCalls.length).toBe(4);
    // 原 bug:translations = ['[ZH] Alpha[ZH] Beta', '[ZH] Gamma', retry(Gamma)]——
    // 中段之後全部錯位。修後整組 retry 救回正確對應
    expect(translations).toEqual(['[ZH] Alpha', '[ZH] Beta', '[ZH] Gamma']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('E3: 25 段 SEP 丟失 → hadSepLoss 不套「整頁已是 target」skip,retry 全數救回', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    const match = String(url).match(/[?&]q=([^&]*)/);
    const q = match ? decodeURIComponent(match[1]) : '';
    const sourceParts = q.split(SEP);
    if (sourceParts.length > 1) {
      // initial：吞掉一個 SEP → 25 段只回 24 parts(前兩段黏住)
      const parts = sourceParts.map(s => `[ZH] ${s}`);
      const merged = [parts[0] + parts[1], ...parts.slice(2)].join(SEP);
      return { ok: true, json: async () => [[[merged, q]]] };
    }
    return { ok: true, json: async () => [[[`[ZH] ${q}`, q]]] }; // retry 真翻
  };

  try {
    const inputs = Array.from({ length: 25 }, (_, i) => `Sentence number ${i}`);
    const { translations } = await translateGoogleBatch(inputs);

    // placeholder=原文跟 echo 分不開；沒 hadSepLoss 旗標時會被「>20 段全 echo」skip
    // 誤殺(fetchCalls 停在 1、translations 全原文)。修後 1 initial + 25 retry
    expect(fetchCalls.length).toBe(26);
    expect(translations).toEqual(inputs.map(t => `[ZH] ${t}`));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
