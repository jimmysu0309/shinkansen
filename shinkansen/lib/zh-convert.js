// zh-convert.js — 簡繁互轉（background 專用 ES module）
// 字典與 Trie 轉換核心 vendor 自 lib/vendor/opencc/（見該目錄 LICENSE 與
// THIRD-PARTY-NOTICES.md）。字典資料以原始文字檔（"來源 替換|來源 替換"）打包，
// 首次轉換才 fetch lazy load——MV3 service worker 禁 dynamic import（見
// background.js ensureInstapaperKeys 註解），fetch 自家打包資源是既有可行前例；
// 沒用到簡繁轉換時 SW 啟動零成本、零記憶體。
//
// 方向命名:
//   cn2twp — 簡體 → 台灣繁體（含台灣慣用詞:軟件→軟體、視頻→影片）
//   twp2cn — 台灣繁體 → 簡體（先還原慣用詞再簡化）
// 對應 target:zh-TW 用 cn2twp、zh-CN 用 twp2cn。

import { browser } from './compat.js';
import { ConverterFactory } from './vendor/opencc/opencc-core.js';

// 各方向的 conversion chain:外層陣列 = 依序執行的轉換 pass（各建一棵 Trie），
// 內層陣列 = 該 pass 合併載入的字典（先載排後面的、排前面的優先——loadDictGroup
// 以 reverse 順序載入，故同組內「詞組字典在前、單字字典在後」詞組優先命中）。
// 組合對映 opencc-js 的 from/cn + to/twp 與 from/twp + to/cn preset。
const CHAINS = {
  cn2twp: [
    ['STPhrases', 'STCharacters'],
    ['TWPhrases'],
    ['TWVariantsPhrases', 'TWVariants'],
  ],
  twp2cn: [
    ['TWPhrasesRev', 'TWVariantsRevPhrases', 'TWVariantsRev'],
    ['TSPhrases', 'TSCharacters'],
  ],
};

export const ZH_CONVERT_DIRECTIONS = Object.keys(CHAINS);

// 字典文字 cache:同一字典（例如未來多方向共用）只 fetch 一次。
// 失敗時從 cache 移除讓下次重試（網路層理論上不會失敗——fetch 自家資源——
// 但防禦 Safari 檔案缺漏等 packaging 事故）。
const _dictPromises = new Map();
function loadDictText(name) {
  if (!_dictPromises.has(name)) {
    const p = (async () => {
      const url = browser.runtime.getURL(`lib/vendor/opencc/dict/${name}.txt`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`OpenCC 字典載入失敗:${name}（HTTP ${res.status}）`);
      return res.text();
    })();
    p.catch(() => _dictPromises.delete(name));
    _dictPromises.set(name, p);
  }
  return _dictPromises.get(name);
}

// 方向 → converter function 的 cache。Trie 建構（STPhrases 約 39 萬字元）只在
// 每次 SW 生命週期首次用到該方向時做一次。
const _converterPromises = new Map();
export function getZhConverter(direction) {
  const chain = CHAINS[direction];
  if (!chain) return Promise.reject(new Error(`未知的簡繁轉換方向:${direction}`));
  if (!_converterPromises.has(direction)) {
    const p = (async () => {
      const groups = await Promise.all(chain.map((g) => Promise.all(g.map(loadDictText))));
      const converter = ConverterFactory(...groups);
      // review F8:Trie 建成後字典原始文字(合計 ~1.1MB 字串)已無用途,清掉對應
      // cache 釋放 SW 長駐記憶體。兩方向目前無共用字典,直接清安全;未來若出現
      // 共用字典,代價只是另一方向首次建 Trie 時多一次 fetch 自家打包資源
      for (const g of chain) for (const name of g) _dictPromises.delete(name);
      return converter;
    })();
    p.catch(() => _converterPromises.delete(direction));
    _converterPromises.set(direction, p);
  }
  return _converterPromises.get(direction);
}

// 批次轉換。非字串項原樣返還（防禦協定層雜訊）。
export async function convertZhBatch(texts, direction) {
  const convert = await getZhConverter(direction);
  return texts.map((t) => (typeof t === 'string' ? convert(t) : t));
}
