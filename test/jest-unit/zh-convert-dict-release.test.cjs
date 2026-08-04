'use strict';

/**
 * Regression(code review 2026-08-03 F8,dev tail 2.0.81.1 修):
 *   lib/zh-convert.js 字典原始文字在 Trie 建成後應從 _dictPromises cache 清掉。
 *
 * 背景 bug(記憶體):_dictPromises 永久 cache 字典原始文字(合計 ~1.1MB 字串),
 *   Trie 建成後這些字串已無用途,卻跟著 SW 生命週期長駐記憶體。
 *
 * 修法(zh-convert.js getZhConverter):ConverterFactory 建完 converter 後,
 *   對該方向 chain 內所有字典名 `_dictPromises.delete(name)`。兩方向目前無共用
 *   字典,直接清安全;未來若共用,代價只是另一方向首次建 Trie 多一次 fetch。
 *
 * 本 spec 鎖的訊號層:驗「dict text cache 的釋放契約」——converter 建成後同名字典
 *   再載入會重新 fetch(= cache 已清),且 converter promise cache 不受影響(同
 *   方向第二次 getZhConverter 零 fetch)。不驗真實記憶體佔用(環境相依)。
 *   _dictPromises 是 vm script 頂層 const 拿不到,以 fetch 呼叫次數為 observable。
 *
 * SANITY CHECK 紀錄(已驗證,2026-08-05):
 *   把 getZhConverter 內 `for (const g of chain) for (const name of g)
 *   _dictPromises.delete(name);` 註解掉 → 「build 後重新 loadDictText 應重新
 *   fetch」測試 fail(fetch 次數不增,吃到舊 cache)。還原後 pass。
 */

const path = require('path');
const fs = require('fs');
const vm = require('vm');

const CN2TWP_DICTS = ['STPhrases', 'STCharacters', 'TWPhrases', 'TWVariantsPhrases', 'TWVariants'];
const TWP2CN_DICTS = ['TWPhrasesRev', 'TWVariantsRevPhrases', 'TWVariantsRev', 'TSPhrases', 'TSCharacters'];

function loadZhConvert() {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../shinkansen/lib/zh-convert.js'),
    'utf-8',
  );
  const stripped = src
    .replace(/^import\s+[^;]+;?\s*$/gm, '')
    .replace(/^export\s+(const|let)\s+/gm, 'var ')
    .replace(/^export\s+(function|async\s+function)\s+/gm, '$1 ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');

  const fetchCalls = [];
  const factoryCalls = [];
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout,
    Promise, Date, Number, String, Object, Array, Math, JSON, Map, Error,
    browser: { runtime: { getURL: (p) => `chrome-extension://test/${p}` } },
    fetch: async (url) => {
      fetchCalls.push(url);
      return { ok: true, text: async () => '来源 替換' };
    },
    ConverterFactory: (...groups) => {
      factoryCalls.push(groups);
      return (t) => t;
    },
  });
  vm.runInNewContext(stripped, ctx, { filename: 'zh-convert.js' });
  return { ctx, fetchCalls, factoryCalls };
}

describe('zh-convert dict text cache 釋放(review F8)', () => {
  test('converter 建成後,同名字典再 loadDictText 應重新 fetch(cache 已清)', async () => {
    const { ctx, fetchCalls } = loadZhConvert();
    await ctx.getZhConverter('cn2twp');
    expect(fetchCalls.length).toBe(CN2TWP_DICTS.length);

    // 核心斷言:build 完成後 dict text cache 已清 → 再要求同字典會重新 fetch
    await ctx.loadDictText('STPhrases');
    expect(fetchCalls.length).toBe(CN2TWP_DICTS.length + 1);
  });

  test('converter promise cache 不受清理影響:同方向第二次 getZhConverter 零 fetch', async () => {
    const { ctx, fetchCalls, factoryCalls } = loadZhConvert();
    const first = await ctx.getZhConverter('cn2twp');
    const fetchesAfterFirst = fetchCalls.length;
    const second = await ctx.getZhConverter('cn2twp');
    expect(second).toBe(first);
    expect(fetchCalls.length).toBe(fetchesAfterFirst);
    expect(factoryCalls.length).toBe(1);
  });

  test('兩方向各自建 Trie,字典 fetch 各自完整、互不干擾', async () => {
    const { ctx, fetchCalls } = loadZhConvert();
    await ctx.getZhConverter('cn2twp');
    await ctx.getZhConverter('twp2cn');
    expect(fetchCalls.length).toBe(CN2TWP_DICTS.length + TWP2CN_DICTS.length);
    for (const name of [...CN2TWP_DICTS, ...TWP2CN_DICTS]) {
      expect(fetchCalls.some((u) => u.includes(`/${name}.txt`))).toBe(true);
    }
  });

  test('convertZhBatch 在清理後照常運作(功能不受影響)', async () => {
    const { ctx } = loadZhConvert();
    const out = await ctx.convertZhBatch(['简体', 42, null], 'cn2twp');
    expect(out[0]).toBe('简体');   // mock converter 為 identity
    expect(out[1]).toBe(42);       // 非字串原樣返還
    expect(out[2]).toBe(null);
  });
});
