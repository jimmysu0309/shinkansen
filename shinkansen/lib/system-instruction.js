// system-instruction.js — 跨 provider 共用的翻譯 batch 構建 helper(v1.5.7 起)
//
// 從 lib/gemini.js 抽出,讓 Gemini 與 OpenAI-compatible 兩條 adapter 共用同一份:
//   1. DELIMITER:多段串接分隔符
//   2. packChunks:依字元預算 + 段數雙門檻 greedy 分批
//   3. buildEffectiveSystemInstruction:依批次內容動態追加規則
//      (段內換行規則 / 佔位符規則 / fixedGlossary / 中國用語黑名單 /
//       自動 glossary / 多段分隔符規則)
//
// 抽出原因:自訂 OpenAI-compat provider 也要繼承「黑名單 + 固定術語表」自動注入
//          (依 Jimmy 設計決定 #3:systemPrompt 獨立、黑名單 & 固定術語表共用)。
//          改放 lib/ 共用模組讓 Gemini 與 OpenAI-compat 兩個 adapter 同步演進,
//          未來新加翻譯規則只改一處。
//
// 順序設計(v1.8.39 起,為 Gemini implicit cache hit rate 重排):
//   prefix 共享度由高到低,動態變動部分推到最末。
//   baseSystem(完全固定)→ 段內換行(條件性,頁內穩定)→ 佔位符(條件性,頁內穩定)
//   → fixedGlossary(使用者級固定)→ forbiddenTerms(使用者級固定)
//   → glossary(頁面級,跨頁變)→ 多段分隔符規則(嵌入 batch 段數 N,batch 級變)。
//   把 N 嵌入的「本批次包含 N 段」這條規則從第 2 位推到最末端,讓所有 batch 共享前段
//   prefix(原本只能共享 baseSystem ~1500 tokens,新排法可達 ~2000 tokens)。
//   trade-off:forbiddenTerms 不再「最末端」,LLM 注意力略降——靠 regression
//   spec(forbidden-terms-leak / multi-segment 系列)監測。

import { DEFAULT_UNITS_PER_BATCH, DEFAULT_CHARS_PER_BATCH } from './constants.js';

/** 多段翻譯時用此 delimiter 串接 / 拆回對齊。Gemini 與 OpenAI-compat 共用。 */
export const DELIMITER = '\n<<<SHINKANSEN_SEP>>>\n';
// v1.9.22: split-time tolerance — Gemini Flash Lite 經常把 DELIMITER 兩邊的 `\n` 吃掉,
// 還原成 `<<<SHINKANSEN_SEP>>>`(無換行)或 ` <<<SHINKANSEN_SEP>>> `(空格替代)等變體。
// 用嚴格 `text.split(DELIMITER)` 找不到匹配 → parts.length===1 → segment count mismatch
// → 觸發 per-segment fallback(每段一個獨立 API call,慢且燒 token)。
// 改用 SEP_RE(兩側 `\s*`)接受所有空白變體;`\s*` 包含 0 個字元,連 `abc<<<SHINKANSEN_SEP>>>def`
// 也能正確切。每段 .trim() 過,前後空白損失無影響。實測這個 fix 把 ASR 字幕 mismatch 率
// 從 ~46% 砍到接近 0%。
// v2.0.70: 加 `i` flag — gemini-3.5-flash-lite 偶發把 token 大小寫改寫
//(實測 `<<<SHINKansen_SEP>>>`,persisted ring 2026-07-30 stuff.tv 批次),case-sensitive
// split 漏切一刀 → mismatch,且 mangled token 逃過 realign 清理與 sanitizeMarkers
// 最後防線直接漏進 DOM 與快取。token 是協定保留字串,原文不可能合法出現任何大小寫
// 變體,放寬無誤殺風險。
export const SEP_RE = /\s*<<<SHINKANSEN_SEP>>>\s*/i;

// 多段序號標記。為什麼有兩組:
//   Gemini / 商用 LLM(GPT / Claude / DeepSeek 等)用緊湊的 «N»,token 開銷小。
//   本機量化模型(gemma-4 量化版等)會把 «1» «2» 當自然語言誤翻成「N1、N2」洩漏到譯文,
//   改用長形式 <<<SHINKANSEN_SEG-N>>> 弱模型認得是協定 token 不會誤翻,代價是
//   每段批次多約 7 tokens / segment(input + output 雙倍開銷)。
// 自訂 Provider 走 useStrongSegMarker toggle 切換(預設 STRONG),Gemini 主路徑固定用 COMPACT。
//
// fmt(n)        生成第 n 段的 marker 字串(內含尾部空白方便 join)
// re            移除 LLM 譯文開頭殘留 marker 的 regex(行首 + 可選空白)
// stripGlobalRe 全文掃 marker 殘留的 regex(防禦 sanitize 用,跨段位置任何地方)
// scanRe        realignByMarkers 用的擷取 regex(捕獲 N;COMPACT 容忍「«2 »」這種
//               模型自己塞空白的變體——實測 gemini-3.5-flash-lite 會吐)
// display       prompt 描述句裡顯示給 LLM 看的「N 範本」
export const MARKER_COMPACT = {
  fmt: (n) => `«${n}» `,
  re: /^«\d+»\s*/,
  stripGlobalRe: /«\d+»\s*/g,
  scanRe: /«\s*(\d+)\s*»/,
  display: '«N»',
};
export const MARKER_STRONG = {
  // v2.0.70: 三個 regex 加 `i` — 與 SEP_RE 同因(模型偶發改寫協定 token 大小寫)
  fmt: (n) => `<<<SHINKANSEN_SEG-${n}>>> `,
  re: /^<<<SHINKANSEN_SEG-\d+>>>\s*/i,
  stripGlobalRe: /<<<SHINKANSEN_SEG-\d+>>>\s*/gi,
  scanRe: /<<<SHINKANSEN_SEG-(\d+)>>>/i,
  display: '<<<SHINKANSEN_SEG-N>>>',
};

// ─── 序號標記二次對齊(2026-07-29)────────────────────────────
// 動機:gemini-3.5-flash-lite 會偶發性吃掉段落間的 <<<SHINKANSEN_SEP>>>(把相鄰兩段
// 合併輸出),SEP split 段數 < 預期 → 原本直接走 per-segment fallback(整批已付費譯文
// 丟棄 + 每段再各打一次 API,費用近雙倍)。實測該模型合併段落時「段首的 «N» 序號標記
// 都還在」,所以段數不符時先用序號標記當第二對齊錨點重新切割,對得齊就不必 fallback。
// 對照組:同頁 gemini-3.1-flash-lite / gemini-3.6-flash 零 mismatch——這是模型層行為,
// 修法是結構性通則(任何「愛合併段落但保留序號」的模型都適用),不是模型特判。
/**
 * 用 «N» / <<<SHINKANSEN_SEG-N>>> 序號標記重新切割模型輸出。
 *
 * 僅在全部條件成立時回傳切割結果,任一不成立回傳 null(呼叫端走原 fallback):
 *   1. 掃到的 marker 數 === expectedCount
 *   2. marker 序列嚴格等於 1..N(遞增、完整、不重複——譯文內文偶然出現 «數字» 會
 *      破壞此序列,自然擋掉誤判)
 *   3. 第一個 marker 之前只有空白(marker 出現在意料外位置 = 不可信)
 *
 * 切出的每段會清掉殘留的 SEP token 與段首 marker,與正常路徑的清理等價。
 *
 * @param {string} text 模型完整輸出
 * @param {number} expectedCount 預期段數(texts.length,呼叫端保證 >= 2)
 * @param {{scanRe: RegExp}} marker MARKER_COMPACT 或 MARKER_STRONG
 * @returns {string[]|null} 對齊成功回傳 expectedCount 段,失敗回傳 null
 */
export function realignByMarkers(text, expectedCount, marker = MARKER_COMPACT) {
  if (!text || expectedCount < 2) return null;
  const re = new RegExp(marker.scanRe.source, 'gi');
  const hits = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    hits.push({ n: parseInt(m[1], 10), start: m.index, end: m.index + m[0].length });
    if (hits.length > expectedCount) return null; // 超量提前放棄
  }
  if (hits.length !== expectedCount) return null;
  for (let i = 0; i < hits.length; i++) {
    if (hits[i].n !== i + 1) return null;
  }
  if (text.slice(0, hits[0].start).trim() !== '') return null;
  const sepGlobal = new RegExp(SEP_RE.source, 'gi');
  const parts = [];
  for (let i = 0; i < hits.length; i++) {
    const from = hits[i].end;
    const to = i + 1 < hits.length ? hits[i + 1].start : text.length;
    parts.push(text.slice(from, to).replace(sepGlobal, ' ').trim());
  }
  return parts;
}

const MAX_UNITS_PER_CHUNK = DEFAULT_UNITS_PER_BATCH;
const MAX_CHARS_PER_CHUNK = DEFAULT_CHARS_PER_BATCH;

/**
 * v1.8.20: 對 glossary / forbiddenTerms 的 source / target / forbidden / replacement 做消毒,
 * 移除可能污染 system instruction 的協定 token——auto glossary 從頁面內容抽,惡意頁面可在
 * 抽出來的詞裡塞 `<<<SHINKANSEN_SEP>>>` / `</forbidden_terms_blacklist>` / 反斜線換行
 * 影響後續批次切分或標記閉合;固定術語表使用者輸入也比照處理(防失誤)。
 *
 * 策略:單行化 + 移除佔位符與 sentinel token + 移除控制字元。
 */
function sanitizeTermText(s) {
  return String(s ?? '')
    // 控制字元 + 換行符 → 空白(避免欺騙 LLM 換行成額外規則)
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    // 配對 / 自閉合佔位符 token(防止使用者輸入誤觸發佔位符規則)
    .replace(/⟦\/?\*?\d+⟧/g, '')
    // 多段 sentinel(防止假冒批次切分標記)
    .replace(/<<<SHINKANSEN_SEP>>>/gi, '')
    // 多段序號標記兩種格式都 strip(防止假冒段序號;«\d+» 只匹配數字所以法文 / 德文
    // 引號 «bonjour» 不會誤傷)
    .replace(/<<<SHINKANSEN_SEG-\d+>>>/gi, '')
    .replace(/«\d+»/g, '')
    // forbidden_terms_blacklist 標籤(防止使用者輸入提前關閉區塊)
    .replace(/<\/?forbidden_terms_blacklist>/gi, '')
    .trim()
    .slice(0, 200); // 單詞超過 200 字本來就不正常,截斷防 prompt 暴脹
}

// v2.0.52:glossary entry 協定層驗證(gemini.js / openai-compat.js extractGlossary
// 共用,單一資料源)。除既有的 source / target 非空字串檢查外,擋掉模型偶發的
// 欄位錯置——把分類代號(person / place / tech / work)填進 target(實例:
// {"source":"金谷","target":"place"}),這種 entry 注入譯名規則會逼模型把地名
// 翻成「place」、一致性掃描也會拿「place」當 expected 誤報,直接丟棄。
const GLOSSARY_TYPE_TOKENS = new Set(['person', 'place', 'tech', 'work']);
export function isValidGlossaryEntry(e) {
  if (!e || typeof e.source !== 'string' || typeof e.target !== 'string') return false;
  if (!e.source || !e.target) return false;
  if (GLOSSARY_TYPE_TOKENS.has(e.target.trim().toLowerCase())) return false;
  return true;
}

// v2.0.52:per-segment echo 快取防護。模型偶發對批內短句(「えっ?」類感嘆詞)
// echo 原文不翻;echo 一旦寫進 tc_ 快取,高頻短句會在整本書 / 整站每一處命中
// 同一條壞快取,永遠自我複製。判定「確定錯」才擋:譯文與原文一致,且原文含
// 明確「非 target 字系」特徵(zh target 下含假名 / 諺文)。數字、URL、英文品牌
// 等合法原樣保留(不含這些字系特徵)不受影響。
// 用途:cache.setBatch 前過濾——echo 結果仍回給呼叫端顯示(跟原文一樣,顯示
// 無差別),只是不寫快取,下次翻譯自然重試。
//
// v2.0.65：補「拉丁字母長內文未翻」判定。lite 級模型偶發把整段英文內文照抄
// 回來（Verge Installer 頁實例）,CJK target 下純英文輸出不含假名/諺文特徵，
// 舊判定放行 → 壞 entry 進快取後該段永遠 cache hit 吐英文。
// 判定做在「譯文側」且**不要求譯文與原文字串相等**：模型 echo 時常順手動到
// 佔位符 / 引號 / 空白（字串不等，內容照樣是沒翻的英文），等號 gate 會漏
//（cage 實測：注入端 DOM 文字比對抓到 echo,cache 端字串相等比對放行）。
// 門檻三條件（拉丁字母 ≥40 + 空白分詞 ≥8 + CJK 字元 ≤2）只抓「整段拉丁內文、
// 幾乎零 CJK」的輸出：短句品牌名（Taylor Swift）、URL（無空白，分詞=1）、
// 數字搆不到；合法譯文含大量英文引用時 CJK 字元遠超 2 也不受影響。
// 誤判成本僅「不寫快取，下次重送」——例如整段就是一條長英文作品名 / 文獻
// 條目、模型合法原樣保留時，該段每次翻譯都重打 API，顯示結果不受影響。
export function isSuspectEchoTranslation(source, translation, targetLanguage) {
  if (typeof source !== 'string' || typeof translation !== 'string') return false;
  const s = source.trim();
  const t = translation.trim();
  if (!s || !t) return false;
  const tl = String(targetLanguage || 'zh-TW');
  const isCjkTarget = tl.startsWith('zh') || tl.startsWith('ja') || tl.startsWith('ko');
  if (isCjkTarget) {
    const tLatin = (t.match(/[A-Za-z]/g) || []).length;
    const tWords = t.split(/\s+/).filter(Boolean).length;
    const tCjk = (t.match(/[぀-ゟ゠-ヿ㐀-䶿一-鿿가-힣]/g) || []).length;
    if (tLatin >= 40 && tWords >= 8 && tCjk <= 2) return true;
  }
  if (s !== t) return false;
  const kana = (s.match(/[ぁ-ゖァ-ヺ]/g) || []).length;
  const hangul = (s.match(/[가-힣]/g) || []).length;
  if (tl.startsWith('zh')) return kana >= 2 || hangul >= 2;
  if (tl.startsWith('ja')) return hangul >= 2;
  if (tl.startsWith('ko')) return kana >= 2;
  // 拉丁字母 target(en / es / fr / de):原文含 CJK 系字元卻原樣返回 = echo
  const han = (s.match(/[一-鿿]/g) || []).length;
  return kana + hangul + han >= 2;
}

// v2.0.52:chunk / batch 級輸出語言驗證(單一資料源:gemini.js / openai-compat.js
// 的 chunk 層 fallback 判定與 translate-doc/translate.js 的 batch 層最後防線共用)。
// 模型偶發把「整個 chunk」翻成原文語言(實例:日文書某 22 段 sub-chunk 兩次都被
// 輸出成日文改寫,同 payload 重試高度 sticky)。只驗「整體」不驗單段——單段譯文
// 合法引用原文詞(人名、書名括號對照)是正常的,整體字系佔比漂移才代表 target
// 錯亂。閾值保守(絕對量 + 佔比雙門檻)防誤殺。純函式可 unit 測。
export function detectOutputLangMismatch(results, targetLanguage) {
  const tl = String(targetLanguage || 'zh-TW');
  if (tl.startsWith('ja')) return false; // 日文 target 本來就該有假名,不驗
  const joined = (Array.isArray(results) ? results : [])
    .filter((t) => typeof t === 'string').join('\n');
  if (joined.length < 40) return false; // 短輸出(標題等)樣本不足,不驗
  const kana = (joined.match(/[ぁ-ゖァ-ヺー]/g) || []).length;
  const han = (joined.match(/[一-鿿]/g) || []).length;
  const hangul = (joined.match(/[가-힣]/g) || []).length;
  const latin = (joined.match(/[A-Za-z]/g) || []).length;
  if (tl.startsWith('ko')) {
    // 韓文 target:輸出應以諺文為主
    return (kana >= 30 && kana > hangul) || (han >= 30 && han > hangul * 2);
  }
  if (tl.startsWith('zh')) {
    // 中文 target:假名佔 CJK 系字元比例高 = 整體是日文;諺文同理
    if (kana >= 30 && kana / (kana + han) > 0.15) return true;
    if (hangul >= 30 && hangul / (hangul + han) > 0.5) return true;
    return false;
  }
  // 拉丁字母 target(en / es / fr / de):輸出應以拉丁字母為主
  const cjkish = kana + han + hangul;
  return cjkish >= 30 && cjkish > latin;
}

// 批次寫快取前的 echo 過濾(texts / translations 平行陣列,回傳可安全寫入的子集)
export function filterEchoPairsForCache(texts, translations, targetLanguage) {
  const outTexts = [];
  const outTranslations = [];
  let skipped = 0;
  const n = Math.min(texts?.length || 0, translations?.length || 0);
  for (let i = 0; i < n; i++) {
    if (!translations[i]) continue; // falsy 本來就不寫(setBatch 也會跳),不算 echo
    if (isSuspectEchoTranslation(texts[i], translations[i], targetLanguage)) { skipped++; continue; }
    outTexts.push(texts[i]);
    outTranslations.push(translations[i]);
  }
  return { texts: outTexts, translations: outTranslations, skipped };
}

/**
 * Greedy 打包：對 texts 陣列用字元預算 + 段數上限雙門檻切成連續子批次，
 * 回傳「起始 / 結束 index」陣列讓呼叫端可以對齊結果。
 *
 * 批次 5-3（v1.10.46）：上限改可由 opts 帶入（呼叫端傳 settings.maxUnitsPerBatch /
 * maxCharsPerBatch）——原本寫死預設值，使用者在 options 調高 maxUnitsPerBatch 後
 * content 端分批生效但 adapter 端在這裡重切蓋掉（>20 段的設定無效且無提示）。
 * opts 缺漏或非法值 fallback 預設，既有呼叫端不傳 opts 行為不變。
 */
export function packChunks(texts, opts = {}) {
  const maxUnits = (Number.isFinite(opts.maxUnits) && opts.maxUnits >= 1)
    ? Math.floor(opts.maxUnits) : MAX_UNITS_PER_CHUNK;
  const maxChars = (Number.isFinite(opts.maxChars) && opts.maxChars >= 1)
    ? Math.floor(opts.maxChars) : MAX_CHARS_PER_CHUNK;
  const batches = [];
  let cur = null;
  const flush = () => { if (cur && cur.end > cur.start) batches.push(cur); cur = null; };
  for (let i = 0; i < texts.length; i++) {
    const len = (texts[i] || '').length;
    if (len > maxChars) {
      flush();
      batches.push({ start: i, end: i + 1 });
      continue;
    }
    if (cur && (cur.chars + len > maxChars || (cur.end - cur.start) >= maxUnits)) {
      flush();
    }
    if (!cur) cur = { start: i, end: i, chars: 0 };
    cur.end = i + 1;
    cur.chars += len;
  }
  flush();
  return batches;
}

/**
 * 組合最終的 system instruction。
 *
 * 順序(v1.8.39 起):
 *   baseSystem → 段內換行規則 → 佔位符規則 → fixedGlossary → forbiddenTerms
 *   → 自動 glossary → 多段分隔符規則(本批次包含 N 段)
 *
 * 設計理由:Gemini implicit cache 命中率優化。
 *   - prefix 越穩定的部分越靠前(baseSystem / fixedGlossary / forbiddenTerms 是使用者級固定,跨頁亦共享)
 *   - 條件性出現但「同頁穩定」的(段內換行 / 佔位符)放在前段,實務上整頁批次幾乎都會同 trigger
 *   - 頁面級變動的 glossary 放在 batch 級變動的「本批次包含 N 段」之前
 *   - batch 級變動的「本批次包含 N 段」(嵌入 literal 數字 N)推到最末端,
 *     讓所有 batch 共享前段 prefix
 *
 * 歷史排序(v0.71-v1.8.38):
 *   baseSystem → 多段分隔符 → 段內換行 → 佔位符 → glossary → fixedGlossary → forbiddenTerms
 *   舊排法把「本批次包含 N 段」放第 2 位,N 一變(例如最後一批 segs<20)導致
 *   後面所有 token 都 cache miss,實測 Medium 長文 hit rate 只能達 ~49%;
 *   新排法預估可拉到 ~80-90%。
 *
 * Trade-off:forbiddenTerms 不再「最末端最高權重」。
 *   v0.71 的 v0.70 bug 教訓:「術語表夾在中間會稀釋 LLM 對佔位符規則的注意力,
 *   導致 ⟦*N⟧ 標記洩漏」。新排法把 forbiddenTerms 從末端往前移,理論上 LLM
 *   注意力略降。靠 forbidden-terms-leak-detect / multi-segment 等 regression
 *   spec + 真實頁面驗證監測。
 *
 * @param {string} baseSystem 使用者設定的基礎 system instruction(每個 provider 可能不同)
 * @param {string[]} texts 本批原文陣列
 * @param {string} joined 已用 DELIMITER join 過的完整文字
 * @param {Array<{source:string, target:string}>} [glossary] 可選的自動擷取術語對照表
 * @param {Array<{source:string, target:string}>} [fixedGlossary] 可選的使用者固定術語表
 * @param {Array<{forbidden:string, replacement:string}>} [forbiddenTerms] 中國用語黑名單
 * @param {{display:string}} [marker] 多段序號標記配置,影響「本批次包含 N 段」描述句裡顯示
 *   的 N 範本。預設用 MARKER_COMPACT(«N»),OpenAI-compat 路徑可傳 MARKER_STRONG。
 *   Gemini 路徑固定 COMPACT,呼叫端不必傳。
 * @returns {string} 完整的 effectiveSystem
 */
export function buildEffectiveSystemInstruction(baseSystem, texts, joined, glossary, fixedGlossary, forbiddenTerms, marker = MARKER_COMPACT) {
  const parts = [baseSystem];

  // 段內換行保留規則
  if (texts.some(t => t && t.indexOf('\n') !== -1)) {
    parts.push(
      '額外規則（段落分隔）:\n輸入中可能含有段內換行符 \\n（例如 "第一段\\n\\n第二段"）,代表原文有對應的段落或行分隔（通常是 <br> 或 <br><br>）。翻譯時必須在對應位置原樣保留 \\n 字元——譯文段落數與輸入段落數一致,連續兩個 \\n 也要保留兩個。不可把段落合併成一行,也不可把空白行多塞或少塞。'
    );
  }

  // 佔位符保留規則
  if (joined.indexOf('⟦') !== -1) {
    parts.push(
      '額外規則（極重要，處理佔位符標記）:\n輸入中可能含有兩種佔位符標記，都是用來保留原文結構，必須原樣保留、不可翻譯、不可省略、不可改寫、不可新增、不可重排。佔位符裡的數字、斜線、星號 **必須是半形 ASCII 字元**（0-9、/、*），絕對不可改成全形（０-９、／、＊），否則程式無法配對會整段崩壞。\n\n（A）配對型 ⟦數字⟧…⟦/數字⟧（例如 ⟦0⟧Tokugawa Ieyasu⟦/0⟧)：\n- 把標記視為透明外殼。外殼「內部」的文字跟外殼「外部」的文字一樣，全部都要翻譯成繁體中文。\n- ⟦數字⟧ 與 ⟦/數字⟧ 兩個標記本身原樣保留，數字不變。\n- **配對型可以巢狀嵌套**（例如 ⟦0⟧may incorporate text from a ⟦1⟧large language model⟦/1⟧, which is ...⟦/0⟧）。巢狀代表原文是 `<b>text <a>link</a> more text</b>` 這類嵌套結構。翻譯時必須**同時**保留外層與內層兩組標記、不可扁平化成單層、不可交換順序、不可遺漏任何一層。外層與內層的內部文字全部要翻成繁體中文。\n\n（B）自閉合 ⟦*數字⟧（例如 ⟦*5⟧)：\n- 這是「原子保留」位置記號，代表原文裡有一段不可翻譯的小區塊（例如維基百科腳註參照 [2])。\n- 整個 ⟦*數字⟧ token 原樣保留，不可拆開、不可翻譯、不可省略，數字不變。\n- 它的位置代表那段內容應該插在譯文的哪裡。\n\n具體範例 1（單層）：\n輸入： ⟦0⟧Tokugawa Ieyasu⟦/0⟧ won the ⟦1⟧Battle of Sekigahara⟦/1⟧ in 1600.⟦*2⟧\n正確輸出： ⟦0⟧德川家康⟦/0⟧於 1600 年贏得⟦1⟧關原之戰⟦/1⟧。⟦*2⟧\n錯誤輸出 1： ⟦0⟧Tokugawa Ieyasu⟦/0⟧於 1600 年贏得⟦1⟧Battle of Sekigahara⟦/1⟧。⟦*2⟧（配對型內部英文沒翻）\n錯誤輸出 2： ⟦0⟧德川家康⟦/0⟧於 1600 年贏得⟦1⟧關原之戰⟦/1⟧。[2]（自閉合 ⟦*2⟧ 被擅自還原成 [2])\n\n具體範例 2（巢狀）：\n輸入： This article ⟦0⟧may incorporate text from a ⟦1⟧large language model⟦/1⟧, which is ⟦2⟧prohibited in Wikipedia articles⟦/2⟧⟦/0⟧.\n正確輸出： 本條目⟦0⟧可能包含來自⟦1⟧大型語言模型⟦/1⟧的文字，這在⟦2⟧維基百科條目中是被禁止的⟦/2⟧⟦/0⟧。\n錯誤輸出 3： 本條目可能包含來自⟦1⟧大型語言模型⟦/1⟧的文字，這在⟦2⟧維基百科條目中是被禁止的⟦/2⟧。（外層 ⟦0⟧…⟦/0⟧ 被扁平化丟掉）'
    );
  }

  // v1.0.29: 使用者固定術語表(使用者級固定,跨頁亦共享,放前段協助 cache 命中)
  // v1.8.20: 對 source / target 消毒,防止頁面內容塞 sentinel token 影響協定
  if (fixedGlossary && fixedGlossary.length > 0) {
    const lines = fixedGlossary
      .map(e => `${sanitizeTermText(e.source)} → ${sanitizeTermText(e.target)}`)
      .filter(l => !/^\s*→\s*$/.test(l))
      .join('\n');
    if (lines) {
      parts.push(
        '以下是使用者指定的固定術語表，優先級高於下方所有術語對照。遇到這些原文一律使用指定譯名，不可自行改寫，也不需加註英文原文：\n' + lines
      );
    }
  }

  // v1.5.6: 中國用語黑名單(使用者級固定,跨頁亦共享,放前段協助 cache 命中)。
  // 用 <forbidden_terms_blacklist> XML tag 包起來,跟 DEFAULT_SYSTEM_PROMPT 第 2 條
  // 的「依本 prompt 末端 <forbidden_terms_blacklist> 區塊」reference 對應。
  // v1.8.39 起從末端前移到 fixedGlossary 之後——失去「最末端最高權重」位置,
  // 靠 regression spec(forbidden-terms-leak-detect 系列)監測 LLM 服從度退化。
  if (forbiddenTerms && forbiddenTerms.length > 0) {
    // 拆兩類：有填替換詞的走「禁用 → 必須改用」對照；只填禁用詞、替換詞留空的
    // 列入「禁用（未指定替換詞）」區，請 LLM 自行改寫成自然的台灣慣用說法
    // （使用者單純不想看到某詞、但提不出固定替換詞的情境，例如陳腔濫調）。
    const mappedLines = [];
    const bannedOnly = [];
    for (const t of forbiddenTerms) {
      if (!t) continue;
      const forbidden = sanitizeTermText(t.forbidden);
      if (!forbidden || !forbidden.trim()) continue;
      const replacement = sanitizeTermText(t.replacement);
      if (replacement && replacement.trim()) {
        mappedLines.push(`${forbidden} → ${replacement}`);
      } else {
        bannedOnly.push(forbidden);
      }
    }
    if (mappedLines.length > 0 || bannedOnly.length > 0) {
      let block = '<forbidden_terms_blacklist>\n極重要：以下是嚴格禁用的詞彙，譯文中絕對不可使用，違反此規則即為錯誤翻譯。\n';
      if (mappedLines.length > 0) {
        block += '\n【禁用 → 必須改用】以下左欄詞彙一律改用右欄的台灣慣用語。即使原文是英文（例如 video / software / data），譯文也只能使用右欄。\n' + mappedLines.join('\n') + '\n';
      }
      if (bannedOnly.length > 0) {
        block += '\n【禁用（未指定替換詞）】以下詞彙同樣不可出現在譯文中，但未指定替換詞，請自行改用合適、自然的台灣慣用說法表達相同語意。\n' + bannedOnly.join('\n') + '\n';
      }
      block += '\n說明：本黑名單為硬性規定，優先級高於任何 stylistic 考量。若該詞為文章本身討論的主題（例如一篇分析「中國科技用語演變」的文章），請使用引號標示後保留原詞，例如「視頻」。\n</forbidden_terms_blacklist>';
      parts.push(block);
    }
  }

  // 自動擷取術語對照表(頁面級,跨頁變;放在使用者級規則之後讓跨頁 cache 共享前段)
  // v1.8.20: 對 source / target 消毒,防止頁面內容塞 sentinel token 影響協定
  // 2026-07-12: 措辭改「右欄整串都是譯名」——舊句尾「也不需加註英文原文」跟
  // EPUB 全書術語表帶對照的 target（「《變換房間》（Changing Rooms）」）自相矛盾,
  // 真 API probe(tools/probe-glossary-annotation.mjs)實測模型會因此剝掉（原文）
  // 對照(3.5-flash 3 輪只保留 1 輪)。「對照一次」的後續出現裁剪由下游端
  // 確定性處理,LLM 層永遠輸出完整右欄——EPUB 走 epub-writer computeAnnotationDedupe,
  // 網頁走 content-inject.js trimAnnotationDedupe(注入端整頁首現保留、後續留譯名);
  // 改本段措辭時兩個下游裁剪端一起檢查
  if (glossary && glossary.length > 0) {
    const lines = glossary
      .map(e => `${sanitizeTermText(e.source)} → ${sanitizeTermText(e.target)}`)
      .filter(l => !/^\s*→\s*$/.test(l))
      .join('\n');
    if (lines) {
      parts.push(
        '以下是本篇文章的術語對照表，遇到左欄原文時一律逐字使用右欄指定譯名。右欄字串的所有部分——包括其中的書名號與括號內的原文對照——都是指定譯名的一部分，每次出現都要完整輸出，不可自行增刪、改寫或省略括號對照；右欄已含書名號時不要在外面再包一層書名號或引號；右欄沒有括號對照時，也不要自行加註原文：\n' + lines
      );
    }
  }

  // 多段翻譯分隔符與序號規則(嵌入 batch 段數 N,batch 級變動;放最末端讓前段 cache 共享)
  if (texts.length > 1) {
    const m = marker.display;
    parts.push(
      `額外規則（多段翻譯分隔符與序號，極重要）:\n本批次包含 ${texts.length} 段文字。每段開頭有序號標記 ${m}（N 為 1 到 ${texts.length}），段與段之間以分隔符 <<<SHINKANSEN_SEP>>> 隔開。\n你的輸出必須：\n- 每段譯文開頭也加上對應的序號標記 ${m}（N 與輸入的序號一一對應）\n- 段與段之間用完全相同的分隔符 <<<SHINKANSEN_SEP>>> 隔開\n- 恰好輸出 ${texts.length} 段譯文和 ${texts.length - 1} 個分隔符\n- 不可合併段落、不可省略分隔符、不可增減段數`
    );
  }

  return parts.join('\n\n');
}
