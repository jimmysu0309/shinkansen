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

// ─── 括號 / 引號 → 台灣慣用標點（僅 cn2twp）────────────────────
// 簡中網頁常見半形 ( ) 夾在中文裡（例「苹果公司(Apple)」）、引號用彎引號 “ ”。
// OpenCC 字典只轉字形與用詞、不碰標點，轉完變成「蘋果公司(Apple)」「“台灣”」，
// 不合台灣排版慣例。本段把「屬於中文語境」的成對標點換成台灣慣用形式:
//   ( )  → （ ）
//   “ ”  → 「 」
//
// 判斷中文語境（成對標點滿足任一）:
//   ① 內容含 CJK 漢字（「(应用程序接口)」「“人工智能”」）
//   ② 開符號前最近的非空白字元是 CJK 漢字（「苹果(Apple)」「他说“Hello”」）
//   ③ 僅引號:閉符號後最近的非空白字元是 CJK 漢字（「“Hello”是问候语」）。
//      括號不看 ③——「f(x)的值」這類程式 / 數學寫法在中文句中也常見，不該轉
// 皆否 → 視為英文 / 程式語境原樣保留（「f(x)」「GPT-4 (OpenAI)」）。
// 只處理成對符號，由內而外逐層配對；不成對的孤立符號一律不動（避免誤轉笑臉、
// 列表編號「1)」等）。轉換後一併吃掉新符號內外緊貼的半形空白（全形符號自帶
// 字寬，台灣排版不留空白）。
// 不碰佔位符 ⟦…⟧（字元不同，不會被配對到）。
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const WS_RE = /\s/;
// 暫存 sentinel:決定「不轉」的內層符號先換成私用區字元，讓外層配對能跨過它
// 繼續往外找；全部處理完再還原。每種符號一組 sentinel。
const CJK_PAIRS = [
  { open: '(', close: ')', toOpen: '（', toClose: '）', keepOpen: '\uE000', keepClose: '\uE001', checkAfter: false },
  { open: '\u201C', close: '\u201D', toOpen: '「', toClose: '」', keepOpen: '\uE002', keepClose: '\uE003', checkAfter: true },
];
const _escRe = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const p of CJK_PAIRS) {
  const o = _escRe(p.open);
  const c = _escRe(p.close);
  p.innerRe = new RegExp(`${o}([^${o}${c}]*)${c}`, 'g');
}
const SENTINEL_RE = /[\uE000-\uE003]/;
const STRIP_WS_RE = /[ \t\u00A0]*([（）「」])[ \t\u00A0]*/g;

function convertPair(text, p) {
  if (text.indexOf(p.open) === -1 || text.indexOf(p.close) === -1) return { s: text, changed: false };
  let s = text;
  let prev;
  let changed = false;
  do {
    prev = s;
    s = s.replace(p.innerRe, (m, inner, offset, whole) => {
      let i = offset - 1;
      while (i >= 0 && WS_RE.test(whole[i])) i--;
      const before = i >= 0 ? whole[i] : '';
      let after = '';
      if (p.checkAfter) {
        let j = offset + m.length;
        while (j < whole.length && WS_RE.test(whole[j])) j++;
        after = j < whole.length ? whole[j] : '';
      }
      if (CJK_RE.test(inner) || CJK_RE.test(before) || CJK_RE.test(after)) {
        changed = true;
        return p.toOpen + inner + p.toClose;
      }
      return p.keepOpen + inner + p.keepClose;
    });
  } while (s !== prev);
  return { s: s.replaceAll(p.keepOpen, p.open).replaceAll(p.keepClose, p.close), changed };
}

export function convertCjkPunct(text) {
  if (typeof text !== 'string') return text;
  // 原文若本來就含 sentinel 私用區字元（極罕見），放棄處理以免還原時誤傷
  if (SENTINEL_RE.test(text)) return text;
  let s = text;
  let anyChanged = false;
  for (const p of CJK_PAIRS) {
    const r = convertPair(s, p);
    s = r.s;
    anyChanged = anyChanged || r.changed;
  }
  // 有轉換才清空白:全形括號 / 引號內外緊貼的半形空白 / tab / NBSP 去掉（不跨換行）
  return anyChanged ? s.replace(STRIP_WS_RE, '$1') : s;
}

// ─── 台灣慣用字形偏好（僅 cn2twp）──────────────────────────
// OpenCC 單字字典把 台 一律對成 臺（STCharacters「台 臺」），詞組字典也輸出
// 臺灣 / 臺北 / 平臺 / 舞臺；台灣日常書寫慣用「台」，轉完統一改回。
// 只動 臺 本字:颱（台风→颱風）、檯（柜台→櫃檯）是不同字，不受影響。
// 簡體段落原文本就不會出現 臺，故整段替換不會誤傷原文。
const TW_CHAR_PREFS = [['臺', '台']];

export function applyTwCharPrefs(text) {
  if (typeof text !== 'string') return text;
  let s = text;
  for (const [from, to] of TW_CHAR_PREFS) {
    if (s.includes(from)) s = s.replaceAll(from, to);
  }
  return s;
}

// 各方向的轉換後處理（字典轉換之後依序套用）。twp2cn 目前不做後處理。
const POST_PROCESS = {
  cn2twp: (t) => convertCjkPunct(applyTwCharPrefs(t)),
};

// 批次轉換。非字串項原樣返還（防禦協定層雜訊）。
export async function convertZhBatch(texts, direction) {
  const convert = await getZhConverter(direction);
  const post = POST_PROCESS[direction];
  return texts.map((t) => {
    if (typeof t !== 'string') return t;
    const out = convert(t);
    return post ? post(out) : out;
  });
}
