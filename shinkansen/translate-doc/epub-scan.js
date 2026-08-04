// epub-scan.js — 譯後一致性掃描（v2.0.11，SPEC §17.10.10）
//
// 純函式模組：不碰 DOM / storage / 訊息層，掃描邏輯可單獨驗證。
// 兩層訊號（訊號層分工，工作流原則 §3）：
//   第一層 checkGlossaryCompliance —— 術語表符合度（確定性，零 API 費用）：
//     原文含術語表 source 的已翻段落，譯文必須含指定譯名（noTranslate 則含原文）
//   第二層 mineCandidates / buildScanBatches / aggregateRenderings ——
//     術語表外「同一原文多譯名」漂移。候選挖掘與聚合是確定性；
//     「譯名對照抽取」（原文詞在譯文中的實際譯法）由 background
//     SCAN_TERM_RENDERINGS 的 LLM 呼叫完成，本模組只負責前後處理
// 本模組驗「同一 source 多譯名 / 指定譯名缺席」，不驗「單一譯名但翻得差」
// （品質問題交給 prompt / 模型，不歸一致性掃描管）。

// 「譯文（原文）」對照式譯名（同 index.js ANNOTATED_TARGET_RE 語意）：
// 符合度比對取全形括號前的本體
const ANNOTATED_RE = /^(.+)（(.+)）\s*$/;

const RE_ASCII_ONLY = /^[\x20-\x7E]+$/;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 拉丁詞邊界（結構性通則：不讓 'Ann' 命中 'Announcement'）；
// 非拉丁 term 用純 substring。
// compileTermMatcher：term 只編譯一次回傳比對函式——checkGlossaryCompliance 是
// entry × block 雙迴圈（大書 500 條 × 數千段 = 百萬次比對），逐次 new RegExp
// 會造成主執行緒秒級卡頓；無 /g flag 的 RegExp.test 無狀態，可安全重用
function compileTermMatcher(term) {
  if (!term) return () => false;
  if (RE_ASCII_ONLY.test(term)) {
    const re = new RegExp(`(?<![A-Za-z])${escapeRe(term)}(?![A-Za-z])`);
    return (text) => !!text && re.test(text);
  }
  return (text) => !!text && text.includes(term);
}

function sourceHasTerm(text, term) {
  return compileTermMatcher(term)(text);
}

export { sourceHasTerm };

// CJK↔拉丁邊界空格規則（台灣排版慣例，2026-07-10）：替換後的新詞
//   - 邊緣是拉丁且直接貼著 CJK → 補一個空格（「法拉利車隊」換 Ferrari →「Ferrari 車隊」）
//   - 邊緣是 CJK 且隔「單一空格」貼著 CJK → 移除該空格（「Ferrari 車隊」換法拉利 →「法拉利車隊」）
// 補空格方向與 epub-writer spliceWithCjkSpacing 同規則；移除方向為掃描替換新增
const CJK_EDGE_RE = /[㐀-鿿豈-﫿]/;
const LATIN_EDGE_RE = /[A-Za-z0-9]/;

// ctx.prevChar / ctx.nextChar：本段文字（text node）之外的相鄰字元——詞落在
// 節點開頭 / 結尾時，節點內看不到隔壁節點的 CJK，空格規則會漏（2026-07-10
// Jimmy 回報「贊助商Haas 車隊」：前緣在節點邊界沒補到空格）。
// 移除空格的分支只在空格位於本節點內時執行（不可跨節點改字）
function spliceCjkAware(text, start, end, replacement, ctx = {}) {
  let before = text.slice(0, start);
  let after = text.slice(end);
  let mid = replacement;
  const repFirst = replacement[0] || '';
  const repLast = replacement[replacement.length - 1] || '';
  const prev = before ? before[before.length - 1] : (ctx.prevChar || '');
  if (prev) {
    if (CJK_EDGE_RE.test(prev) && LATIN_EDGE_RE.test(repFirst)) {
      mid = ' ' + mid;
    } else if (before && prev === ' ' && CJK_EDGE_RE.test(repFirst)) {
      const beyond = before.length >= 2 ? before[before.length - 2] : (ctx.prevChar || '');
      if (beyond && CJK_EDGE_RE.test(beyond)) before = before.slice(0, -1);
    }
  }
  const next = after ? after[0] : (ctx.nextChar || '');
  if (next) {
    if (LATIN_EDGE_RE.test(repLast) && CJK_EDGE_RE.test(next)) {
      mid = mid + ' ';
    } else if (after && next === ' ' && CJK_EDGE_RE.test(repLast)) {
      const beyond = after.length >= 2 ? after[1] : (ctx.nextChar || '');
      if (beyond && CJK_EDGE_RE.test(beyond)) after = after.slice(1);
    }
  }
  return { text: before + mid + after, nextFrom: before.length + mid.length };
}

// CJK↔拉丁直接相鄰（缺空格）的兩個方向；字元集合與 CJK_EDGE_RE / LATIN_EDGE_RE
// 同源（單一資料源），只比對「直接貼著」——中間已有空格 / 標點都不命中
const RE_CJK_THEN_LATIN = new RegExp(`(${CJK_EDGE_RE.source})(${LATIN_EDGE_RE.source})`, 'g');
const RE_LATIN_THEN_CJK = new RegExp(`(${LATIN_EDGE_RE.source})(${CJK_EDGE_RE.source})`, 'g');

// 全形標點（2026-07-12 Jimmy 指示：全形標點與中英文之間都不需要空格）。
// 範圍取不歧義的 CJK / 全形標點區段：U+3001-303F（、。「」『』《》【】等，
// 刻意不含 U+3000 全形空格——它是空白不是標點）+ 全形 ASCII 標點
//（，！？：；（）等，刻意不含全形數字 / 字母——那些是「文字」）。
// … U+2026 與 — U+2014 刻意不收：譯文內嵌英文句也用這兩個字元
//（"wait… he said"），移掉旁邊空格會改壞合法英文排版
const FW_PUNCT_RE = /[、-〿！-／：-＠［-｀｛-｠]/;
// 標點的另一側是「中文或英數字」都不需空格；[ \t] 與 collapseCjkAsciiSpaces
// 同一取捨——\n 是換行語意（<br> / source 排版）不動
const TEXT_EDGE_RE = new RegExp(`(?:${CJK_EDGE_RE.source}|${LATIN_EDGE_RE.source})`);
const RE_SPACE_BEFORE_FW_PUNCT = new RegExp(`(${TEXT_EDGE_RE.source})[ \\t]+(?=${FW_PUNCT_RE.source})`, 'g');
const RE_SPACE_AFTER_FW_PUNCT = new RegExp(`(${FW_PUNCT_RE.source})[ \\t]+(?=${TEXT_EDGE_RE.source})`, 'g');

/**
 * 中英空格修正（2026-07-11 Jimmy 回報「批評 F1是無謂」——LLM 輸出偶發漏掉
 * CJK↔拉丁邊界空格）。兩組規則（皆冪等）：
 *   1. 補：CJK↔拉丁直接相鄰 → 補一個空格（不動既有空格 / 其他排版）
 *   2. 移（2026-07-12）：全形標點與中英文之間的 [ \t] → 移除（「F1 ，」→「F1，」）。
 *      CJK↔全形標點側在譯文接收鏈 collapseCjkAsciiSpaces 已收斂過，這裡是
 *      預覽 / 下載時機對全書（含舊 session / editedHtml）的補掃，並補上
 *      接收鏈管不到的「拉丁↔全形標點」方向
 * 節點邊界：ctx.prevChar 是前一個 text node 的尾字，跨節點相鄰只在後節點
 * 開頭補 / 移（避免前後節點各處理一次）；空格落在前一節點尾端的移除案例
 * 搆不到（不可跨節點改字，與 spliceCjkAware 同取捨）。
 * @returns { text, count }（count = 修正處數 = 補入 + 移除）
 */
export function addCjkLatinSpacing(text, ctx = {}) {
  if (!text) return { text, count: 0 };
  let count = 0;
  const bump = (_, a, b) => {
    count++;
    return `${a} ${b}`;
  };
  const drop = (_, a) => {
    count++;
    return a;
  };
  let out = text.replace(RE_CJK_THEN_LATIN, bump);
  out = out.replace(RE_LATIN_THEN_CJK, bump);
  out = out.replace(RE_SPACE_BEFORE_FW_PUNCT, drop);
  out = out.replace(RE_SPACE_AFTER_FW_PUNCT, drop);
  const prev = ctx.prevChar || '';
  const first = out[0] || '';
  if (prev && ((CJK_EDGE_RE.test(prev) && LATIN_EDGE_RE.test(first))
      || (LATIN_EDGE_RE.test(prev) && CJK_EDGE_RE.test(first)))) {
    out = ' ' + out;
    count++;
  } else if (prev) {
    // 節點前緣的移除方向：前節點尾字是全形標點、本節點以空格開頭貼著中英文
    //（或反向）→ 移除本節點前緣空格
    const lead = out.match(/^[ \t]+/);
    if (lead) {
      const after = out[lead[0].length] || '';
      if ((FW_PUNCT_RE.test(prev) && TEXT_EDGE_RE.test(after))
          || (TEXT_EDGE_RE.test(prev) && FW_PUNCT_RE.test(after))) {
        out = out.slice(lead[0].length);
        count++;
      }
    }
  }
  return { text: out, count };
}

/**
 * 確定性替換（2026-07-10）：與 compileTermMatcher 同一套邊界語意——
 * 拉丁 term 用詞邊界（不讓 'Ann' 改到 'Announcement' 內部），非拉丁純 substring。
 * 逐一出現位置以 spliceCjkAware 替換（CJK↔拉丁邊界補 / 移空格）。
 * 掃描的自動替換 / 搜尋替換 / 漂移套用共用（單一資料源）。
 * ctx 選項（除 prevChar / nextChar 邊界字元外）：
 *   - skipAnnotated：跳過整顆包在括號內的出現位置「（term）」——那是
 *     「譯名（原文）」對照協定的原文對照，不是殘留待譯詞（2026-07-12
 *     Jimmy 回報：合規自動替換把「大製騙家（Bowfinger）」的對照內容
 *     也換掉，變成「大製騙家（《大製騙家》）」）
 *   - skipTitleAdjacent：跳過緊貼書名號的出現位置（前是《或後是》）——
 *     補書名號的替換不可把已有《》的位置疊成《《》》
 * @returns { text, count }（count = 替換次數；term 空 / 等於 replacement 時 0）
 */
export function replaceTermInText(text, term, replacement, ctx = {}) {
  if (!text || !term || typeof replacement !== 'string' || term === replacement) {
    return { text, count: 0 };
  }
  const re = RE_ASCII_ONLY.test(term)
    ? new RegExp(`(?<![A-Za-z])${escapeRe(term)}(?![A-Za-z])`, 'g')
    : null;
  let out = text;
  let count = 0;
  let from = 0;
  while (from <= out.length) {
    let idx = -1;
    if (re) {
      re.lastIndex = from;
      const m = re.exec(out);
      idx = m ? m.index : -1;
    } else {
      idx = out.indexOf(term, from);
    }
    if (idx === -1) break;
    // 節點邊緣的出現位置看不到隔壁節點字元 → 用 ctx 邊界字元補位
    const chBefore = idx > 0 ? out[idx - 1] : (ctx.prevChar || '');
    const chAfter = out[idx + term.length] || (ctx.nextChar || '');
    if ((ctx.skipAnnotated
        && (chBefore === '（' || chBefore === '(') && (chAfter === '）' || chAfter === ')'))
      || (ctx.skipTitleAdjacent && (chBefore === '《' || chAfter === '》'))) {
      from = idx + term.length;
      continue;
    }
    const spliced = spliceCjkAware(out, idx, idx + term.length, replacement, ctx);
    out = spliced.text;
    count++;
    from = spliced.nextFrom;
  }
  return { text: out, count };
}

function doneBlocks(chapters) {
  const out = [];
  for (const ch of chapters) {
    for (const b of ch.blocks) {
      if (b.translationStatus !== 'done') continue;
      if (typeof b.plainText !== 'string' || typeof b.translation !== 'string') continue;
      out.push({ ch, b });
    }
  }
  return out;
}

/**
 * 第一層：術語表符合度掃描（確定性）。
 * @returns [{ source, expected, noTranslate, chapterIndex, chapterTitle, blockId, excerpt }]
 */
export function checkGlossaryCompliance(chapters, glossary, { maxViolations = 200 } = {}) {
  const violations = [];
  if (!Array.isArray(glossary) || glossary.length === 0) return violations;
  const blocks = doneBlocks(chapters);
  for (const entry of glossary) {
    if (!entry || typeof entry.source !== 'string' || !entry.source.trim()) continue;
    const source = entry.source.trim();
    // noTranslate：譯文須保留原文；一般 entry：譯文須含譯名本體
    //（entry.target 可能是「譯名（原文）」對照格式，取括號前本體；
    //  含本體即算符合——對照 dedupe 後處理去掉括號也不誤報）
    let expected;
    let annotation = null; // 帶對照 target 的括號內原文（自動修正補書名號用）
    if (entry.noTranslate === true) {
      expected = source;
    } else {
      if (typeof entry.target !== 'string' || !entry.target.trim()) continue;
      const m = entry.target.trim().match(ANNOTATED_RE);
      expected = (m ? m[1] : entry.target).trim();
      if (m) annotation = m[2].trim() || null;
    }
    if (!expected) continue;
    const hasTerm = compileTermMatcher(source);
    for (const { ch, b } of blocks) {
      if (!hasTerm(b.plainText)) continue;
      if (b.translation.includes(expected)) continue;
      violations.push({
        source,
        expected,
        annotation,
        noTranslate: entry.noTranslate === true,
        chapterIndex: ch.index,
        chapterTitle: ch.title || '',
        blockId: b.blockId,
        excerpt: excerptAround(b.plainText, source),
      });
      if (violations.length >= maxViolations) return violations;
    }
  }
  return violations;
}

function excerptAround(text, term, radius = 60) {
  const idx = text.indexOf(term);
  if (idx === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + term.length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

// 拉丁專有名詞候選：連續 Capitalized 詞組；片假名連串（日文源書的人名/外來語）
const RE_LATIN_NAME = /[A-Z][A-Za-z''-]+(?:\s+[A-Z][A-Za-z''-]+)*/g;
const RE_KATAKANA = /[ァ-ヺー・]{2,}/g;

/**
 * 第二層前段：候選詞挖掘（確定性）。
 * 規則（全部結構性，不綁語言黑名單）：
 *   - 只看已翻段落的原文
 *   - 單詞候選長度 ≥3，且其小寫形不在全書詞彙表（過濾句首普通詞如 The / She）
 *   - 單詞候選若 >50% 出現時後面緊跟另一個大寫詞 → 視為稱謂前綴（Mr / Mrs /
 *     Lady…）丟棄——它是別的名字的一部分，不是獨立譯名單位
 *   - 已在術語表的 source 不重複掃（第一層管它們）
 *   - 出現於 ≥minBlocks 個不同段落才有「跨段漂移」可言
 * @returns [{ term, blocks: [{ chapterIndex, blockId }], count }]
 */
export function mineCandidates(chapters, glossary, { minBlocks = 2, maxCandidates = 120 } = {}) {
  const blocks = doneBlocks(chapters);
  if (blocks.length === 0) return [];

  // 全書「原文中以小寫出現過」的詞彙表（過濾「碰巧在句首被大寫」的普通詞：
  // The / She / When… 這些詞在書中其他位置必以小寫出現；真人名不會有小寫形）。
  // 注意不可把整段 lowercase 再收集——那會讓每個大寫詞的小寫形都「存在」
  const lowerWords = new Set();
  for (const { b } of blocks) {
    for (const m of b.plainText.matchAll(/(?<![A-Za-z])[a-z][a-z''-]*/g)) {
      lowerWords.add(m[0]);
    }
  }
  const glossSources = new Set(
    (Array.isArray(glossary) ? glossary : [])
      .filter((e) => e && typeof e.source === 'string')
      .map((e) => e.source.trim().toLowerCase()),
  );

  const map = new Map(); // term -> { blocks: Map(blockId -> ref), count }
  const addHit = (term, ch, b) => {
    let rec = map.get(term);
    if (!rec) {
      rec = { blocks: new Map(), count: 0 };
      map.set(term, rec);
    }
    rec.count++;
    if (!rec.blocks.has(b.blockId)) {
      rec.blocks.set(b.blockId, { chapterIndex: ch.index, blockId: b.blockId });
    }
  };

  const corpusParts = [];
  for (const { ch, b } of blocks) {
    corpusParts.push(b.plainText);
    for (const m of b.plainText.matchAll(RE_LATIN_NAME)) addHit(m[0], ch, b);
    for (const m of b.plainText.matchAll(RE_KATAKANA)) addHit(m[0], ch, b);
  }
  const corpus = corpusParts.join('\n');

  // review H8:原本下方迴圈對每個單詞候選 `new RegExp` + 全書 corpus matchAll——
  // O(候選 × 全書),50 萬字 × 上百候選是數千萬字元級,主執行緒可感卡頓(同檔
  // compileTermMatcher 已做同類快取,這條漏網)。改一次 pass 先建「詞 → 後接
  // 大寫/數字次數」Map。語意同原 per-term regex `(?<![A-Za-z])term\.?\s+[A-Z0-9]`:
  // token 取法與 RE_LATIN_NAME 同字元集(maximal token,候選詞本就來自該 regex),
  // 後接判定用 sticky regex 原地測,不消耗下一個 token(「Mr Smith Goes」的
  // Smith 也要算到自己的後接)。
  const followedByCapMap = new Map();
  {
    const reToken = /(?<![A-Za-z])[A-Z][A-Za-z''-]*/g;
    const reFollow = /\.?\s+[A-Z0-9]/y;
    for (const m of corpus.matchAll(reToken)) {
      reFollow.lastIndex = m.index + m[0].length;
      if (reFollow.test(corpus)) {
        followedByCapMap.set(m[0], (followedByCapMap.get(m[0]) || 0) + 1);
      }
    }
  }

  const out = [];
  for (const [term, rec] of map) {
    if (rec.blocks.size < minBlocks) continue;
    if (glossSources.has(term.toLowerCase())) continue;
    const isLatin = RE_ASCII_ONLY.test(term);
    const isSingleWord = isLatin && !/\s/.test(term);
    if (isSingleWord) {
      if (term.length < 3) continue;
      if (lowerWords.has(term.toLowerCase())) continue; // 句首大寫的普通詞
      // 前綴偵測：多數出現緊跟另一個大寫詞 → 稱謂（Mr / Lady…），是長名字
      // 的一部分；緊跟數字 → 日期 / 章節 / 編號等更大單位的一部分（April 1 /
      // Chapter 3 / Lap 42），兩者都不是獨立譯名單位（2026-07-10 Jimmy 回報
      // 月份名 April 被掃出、各日期被當多種譯名）
      const followedByCap = followedByCapMap.get(term) || 0;
      if (rec.count > 1 && followedByCap / rec.count > 0.5) continue;
    }
    out.push({ term, blocks: [...rec.blocks.values()], count: rec.count });
  }
  out.sort((a, b) => b.count - a.count);
  return out.slice(0, maxCandidates);
}

/**
 * 第二層中段：把候選詞 + 取樣譯文段組成送 LLM 的批次。
 * 取樣分散取（頭 / 尾 / 均勻），比取前 k 段更能抓到跨書漂移。
 * @param blockById Map(blockId -> block)
 * @returns [{ items: [{ term, samples: [{ blockId, text }] }] }]
 */
export function buildScanBatches(candidates, blockById, {
  samplePerTerm = 6, maxItemsPerBatch = 30, maxCharsPerBatch = 12000, sampleChars = 600,
} = {}) {
  const batches = [];
  let cur = { items: [] };
  let curChars = 0;
  for (const cand of candidates) {
    const picked = spreadPick(cand.blocks, samplePerTerm);
    const samples = [];
    for (const ref of picked) {
      const b = blockById.get(ref.blockId);
      if (!b || typeof b.translation !== 'string' || !b.translation) continue;
      samples.push({ blockId: ref.blockId, text: b.translation.slice(0, sampleChars) });
    }
    if (samples.length < 2) continue; // 只剩一段可比 → 無漂移可言
    const chars = samples.reduce((n, s) => n + s.text.length, cand.term.length);
    if (cur.items.length >= maxItemsPerBatch || (curChars + chars > maxCharsPerBatch && cur.items.length > 0)) {
      batches.push(cur);
      cur = { items: [] };
      curChars = 0;
    }
    cur.items.push({ term: cand.term, samples });
    curChars += chars;
  }
  if (cur.items.length > 0) batches.push(cur);
  return batches;
}

function spreadPick(arr, k) {
  if (arr.length <= k) return arr.slice();
  const out = [];
  for (let i = 0; i < k; i++) {
    out.push(arr[Math.round((i * (arr.length - 1)) / (k - 1))]);
  }
  // Math.round 可能重複取同 index，去重
  return [...new Map(out.map((x) => [x.blockId, x])).values()];
}

/**
 * 第二層後段：聚合 LLM 對照結果 → 漂移案例。
 * 防幻覺守門（確定性）：LLM 回的譯名必須真的出現在對應取樣譯文裡，否則丟棄。
 * @param collected [{ items, results }]：results 與 items 對齊
 *   （results = [{ term, renderings: [str] }]，renderings[i] 對應 samples[i]）
 * @returns [{ term, renderings: [{ text, blockIds, count }] }]（僅譯名 ≥2 種的）
 */
export function aggregateRenderings(collected) {
  const byTerm = new Map(); // term -> Map(rendering -> Set(blockId))
  for (const { items, results } of collected) {
    if (!Array.isArray(items) || !Array.isArray(results)) continue;
    for (const item of items) {
      const res = results.find((r) => r && r.term === item.term);
      if (!res || !Array.isArray(res.renderings)) continue;
      for (let i = 0; i < item.samples.length; i++) {
        const raw = res.renderings[i];
        if (typeof raw !== 'string') continue;
        const rendering = raw.trim();
        if (!rendering) continue;
        if (!item.samples[i].text.includes(rendering)) continue; // 幻覺守門
        let renderMap = byTerm.get(item.term);
        if (!renderMap) {
          renderMap = new Map();
          byTerm.set(item.term, renderMap);
        }
        let ids = renderMap.get(rendering);
        if (!ids) {
          ids = new Set();
          renderMap.set(rendering, ids);
        }
        ids.add(item.samples[i].blockId);
      }
    }
  }
  const cases = [];
  for (const [term, renderMap] of byTerm) {
    if (renderMap.size < 2) continue;
    // 數字不變合併：兩譯名去掉數字與空白後相同 = 差異全由原文數字差異解釋
    //（日期 / 編號 / 圈數逐字帶過來），非譯名漂移；也防 LLM 抽取時把 term
    // 前後的數字一起抓進來（2026-07-10 Jimmy 回報「April → 4 月 1 日 /
    // 4 月 5 日…」被判成多種譯名）。代表文字取出現段落數最多的變體
    const merged = new Map(); // digitInvariantKey -> { text, repCount, ids }
    for (const [text, ids] of renderMap) {
      const key = text.replace(/[0-9０-９\s]/g, '');
      let rec = merged.get(key);
      if (!rec) {
        rec = { text, repCount: 0, ids: new Set() };
        merged.set(key, rec);
      }
      if (ids.size > rec.repCount) {
        rec.text = text;
        rec.repCount = ids.size;
      }
      for (const id of ids) rec.ids.add(id);
    }
    if (merged.size < 2) continue;
    // 互為子字串的譯名視為同一個（「普爾」⊂「老普爾」是稱謂 / 修飾差異，非漂移）
    const renderings = [...merged.values()]
      .map((r) => ({ text: r.text, blockIds: [...r.ids], count: r.ids.size }))
      .sort((a, b) => b.count - a.count);
    const distinct = renderings.filter((r, i) =>
      !renderings.some((other, j) => j < i && (other.text.includes(r.text) || r.text.includes(other.text))));
    if (distinct.length < 2) continue;
    cases.push({ term, renderings: distinct });
  }
  cases.sort((a, b) => b.renderings[0].count - a.renderings[0].count);
  return cases;
}
