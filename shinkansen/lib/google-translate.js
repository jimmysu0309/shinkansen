// lib/google-translate.js — Google Translate 非官方 API 封裝
// 使用 translate.googleapis.com/translate_a/single?client=gtx 端點（免費，不需 API Key）
// 此端點非官方，無公開文件；業界通例用於瀏覽器擴充功能（Immersive Translation、read-frog 等）。
// 注意：Google 可能隨時更動此端點，屬灰色地帶，不建議作為唯一翻譯引擎。

import { debugLog } from './logger.js';
import { codedError } from './bg-error.js'; // 使用者面對錯誤帶 error code 過協定，content 端查 dict 翻譯

// U+2063 INVISIBLE SEPARATOR × 3：翻譯過程中幾乎不會被 MT 引擎改動，用作批次分隔符。
const SEP = '\n\u2063\u2063\u2063\n';

// URL encode 後的 SEP 長度約 66 chars，保守上限設 5500，避免伺服器拒絕過長請求。
const MAX_URL_ENCODED_CHARS = 5500;

// Shinkansen targetLanguage → Google Translate `tl` 參數對映。
// Shinkansen 8 種 target(zh-TW / zh-CN / en / ja / ko / es / fr / de)Google
// Translate 端點代號完全一致,不需轉換;未識別的 target 退回 zh-TW(向下相容)。
const SUPPORTED_TL = new Set(['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'es', 'fr', 'de']);

// v1.10.46(批次 2-8):echo retry 防護。
// RETRY_SKIP_THRESHOLD:超過此段數且「全數 echo」視為「整頁已是 target」,直接放棄
// 逐筆 retry(echo 值本來就是正解,N 段 = N 次 serial 重打只會增加 IP 被封風險)。
// RETRY_DELAY_MS:逐筆 retry 之間的間隔,降低對非官方端點的請求密度。
const RETRY_SKIP_THRESHOLD = 20;
const RETRY_DELAY_MS = 150;

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function _normalizeTl(targetLanguage) {
  return SUPPORTED_TL.has(targetLanguage) ? targetLanguage : 'zh-TW';
}

// v1.9.8: 偵測 text 的主導 letter script(CJK / Latin)。
// Google MT 的 sl=auto 對整個 fetch 請求(SEP 串接的多 unit)做一次語言偵測,
// 所以混批時 Google 用整批多數派 lang 為偵測結果,夾在裡面的少數派 lang 段被
// 誤譯成 garbage(英文殘骸 + 漢字殘渣)。真實案例:X(Twitter)推文討論串
// 父推文簡中 + 主推文英文 + UI 標籤繁中,英文段被當「簡中變體」字碼級轉換,
// 譯文出現「No API billing, no latingle m...」「mid-m​​etal 判​​版ds5.」這種
// garbage。echo retry 條件是 `tr.trim() === text.trim()`(完整 echo),這類
// 部分 garbage 不是 echo 所以救不到。
//
// 解法:預先按字面 CJK / Latin 主導把 texts 分成同質群,各群獨立打 fetch,
// 讓 Google 每次只看到「全 CJK」或「全 Latin」的同質 batch,sl=auto 不再
// 被混批拉錯。'other' 主導(純符號 / 數字 / 短文)沒明確語言,跟 CJK 一組
// 維持原行為(中文版面常見的數字 / 符號夾在 CJK 文章內 Google 會原樣保留)。
function dominantScript(text) {
  let cjk = 0, latin = 0;
  for (const ch of text || '') {
    const c = ch.codePointAt(0);
    if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF)) {
      cjk++;
    } else if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)) {
      latin++;
    }
  }
  if (cjk + latin === 0) return 'cjk';
  return cjk >= latin ? 'cjk' : 'latin';
}

/**
 * 批次翻譯字串陣列（自動偵測語言 → targetLanguage）。
 * 內部用 SEP 串接多段文字為單一請求，若 URL 過長則自動拆多次請求後合併。
 * @param {string[]} texts
 * @param {string} [targetLanguage='zh-TW'] Shinkansen target language code
 * @returns {Promise<{ translations: string[], chars: number }>}
 */
export async function translateGoogleBatch(texts, targetLanguage = 'zh-TW') {
  if (!texts || texts.length === 0) return { translations: [], chars: 0 };

  const tl = _normalizeTl(targetLanguage);

  const totalChars = texts.reduce((s, t) => s + (t?.length || 0), 0);
  const result = new Array(texts.length).fill('');

  // ─── 先按 dominant script 分群,再依 URL 長度分組 ──────────────
  // v1.9.8: dominantScript 分群避免混批 garbage(見上方註解)。
  // 同 script 內仍須按 URL 長度切批(Google 端點 q 參數有實質上限)。
  const byScript = { cjk: [], latin: [] };
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i] || '';
    byScript[dominantScript(t)].push({ idx: i, text: t });
  }

  const groups = [];
  const encodedSep = encodeURIComponent(SEP).length;
  for (const script of ['cjk', 'latin']) {
    const items = byScript[script];
    if (items.length === 0) continue;
    let cur = [];
    let curEncodedLen = 0;
    for (const item of items) {
      const eLen = encodeURIComponent(item.text).length + encodedSep;
      if (cur.length > 0 && curEncodedLen + eLen > MAX_URL_ENCODED_CHARS) {
        groups.push(cur);
        cur = [];
        curEncodedLen = 0;
      }
      cur.push(item);
      curEncodedLen += eLen;
    }
    if (cur.length > 0) groups.push(cur);
  }

  // ─── 逐組翻譯，合併回原索引 ──────────────────────────────────
  // needsRetry:暫存「翻完跟原文一樣」的 unit,整批跑完後逐筆 retry。
  // Why retry:即便 v1.9.8 已分 script,同 script 群仍可能整組被偵測「已是
  // target」整批 echo(例:全是「已是繁中」的批次,target=zh-TW)。
  // 真實案例 v1.9.5:X 推文討論串簡中 + 英文混雜整組 14 段全 echo;v1.9.8 起
  // 該案例改走「英文段獨立成 latin 群」路徑直接解,本 retry 留作 same-script
  // 內被誤判 echo 的 safety net。
  // 改 sl=auto → sl=fixed 解不掉(我們不知道每 unit 真實源語言);最穩的補救
  // 是每筆獨立再打一次:單筆送 sl=auto 偵測通常更準,真翻得出來。
  const needsRetry = [];
  let hadSepLoss = false;  // v2.0.78:SEP 丟失的 retry 不可被「整頁已是 target」skip 誤殺
  for (const group of groups) {
    const joined = group.map(g => g.text).join(SEP);
    const parts = await _fetchTranslate(joined, tl);
    // v2.0.78：段數不符 = SEP 邊界丟失。原本只擋「尾端缺（parts[j] == null）」——
    // Google 吞掉「中間」一個 SEP 時 parts 整體前移，合併點之後每段都拿到上一段的
    // 譯文（非 null 也非 echo，三檢查全 pass）→ 錯位譯文靜默回傳並被呼叫端永久寫進
    // 快取。逐位對應在長度不符時整體不可信，整組改用原文 placeholder 進逐筆 retry。
    if (parts.length !== group.length) {
      await debugLog('warn', 'api', 'google batch SEP boundary lost — whole group to retry', {
        expected: group.length, got: parts.length,
      });
      hadSepLoss = true;
      for (const g of group) {
        result[g.idx] = g.text;
        needsRetry.push(g);
      }
      continue;
    }
    group.forEach((g, j) => {
      const tr = parts[j];
      if (tr == null) {
        // SEP 邊界丟失 → 用原文當 placeholder,稍後逐筆 retry
        result[g.idx] = g.text;
        needsRetry.push(g);
      } else if (tr.trim() === (g.text || '').trim()) {
        // Google MT echo 原文 → 寫入但標記 retry(retry 失敗仍維持此值,呼叫端
        // 會判讀成「已是 target,不需改」)
        result[g.idx] = tr;
        needsRetry.push(g);
      } else {
        result[g.idx] = tr;
      }
    });
  }

  // ─── 逐筆 retry ────────────────────────────────────────────
  // v1.10.46(批次 2-8):retry 加上限與間隔。整頁已是 target 的頁面會讓每段都 echo
  // → 全部進 needsRetry → N 段 = N 次 serial 重打非官方端點(請求密度高,IP 被封風險)。
  // 「>20 段且全數 echo」視為「整頁已是 target」直接放棄 retry(echo 值本來就是正解);
  // 其餘 retry 逐筆之間加小 delay 降低請求密度。
  // hadSepLoss 時 placeholder 也是原文、跟 echo 分不開——不可套「整頁已是 target」推定
  const allEcho = !hadSepLoss && needsRetry.length === texts.length;
  if (needsRetry.length > RETRY_SKIP_THRESHOLD && allEcho) {
    await debugLog('info', 'api', 'google batch retry skipped — whole page already in target', {
      echoed: needsRetry.length,
    });
  } else if (needsRetry.length > 0) {
    let recoveredCount = 0;
    for (let ri = 0; ri < needsRetry.length; ri++) {
      const g = needsRetry[ri];
      try {
        const single = await _fetchTranslate(g.text, tl);
        const tr = single[0];
        if (tr != null && tr.trim() !== (g.text || '').trim()) {
          result[g.idx] = tr;
          recoveredCount++;
        }
      } catch (_) {
        // 單筆失敗就放著,維持 echo 值;不阻擋整批
      }
      if (ri < needsRetry.length - 1) await _sleep(RETRY_DELAY_MS);
    }
    await debugLog('info', 'api', 'google batch retry done', {
      attempted: needsRetry.length,
      recovered: recoveredCount,
    });
  }

  return { translations: result, chars: totalChars };
}

// Google Translate 非官方端點 fetch timeout。15s 對齊 Gemini / OpenAI 主翻譯路徑;
// Google MT 典型回應 < 1s,設這值純粹是防 hang 的兜底。
const FETCH_TIMEOUT_MS = 15_000;

/**
 * 對 Google Translate 非官方端點發出單一 GET 請求，回傳用 SEP 分割的字串陣列。
 */
async function _fetchTranslate(text, tl) {
  const url =
    'https://translate.googleapis.com/translate_a/single' +
    `?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=` +
    encodeURIComponent(text);

  // v1.10.46(批次 2-2):abortTimer 涵蓋到 resp.json() 讀完才清(同 lib/gemini.js)。
  // fetch resolve 只代表 headers 到,body 中途吊住時 json 讀取可無限 pending;
  // timer 到點 abort → json reject AbortError → 統一轉成逾時錯誤。
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let data;
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`Google Translate HTTP ${resp.status}`);
    data = await resp.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw codedError('gtTimeout', { ms: FETCH_TIMEOUT_MS }, `Google Translate 逾時(${FETCH_TIMEOUT_MS}ms)`);
    }
    throw err;
  } finally {
    clearTimeout(abortTimer);
  }
  // 回應格式：[[[譯文片段, 原文片段, ...], ...], ...]
  // 取 data[0] 的所有陣列元素的第一個欄位串接即完整譯文
  const full = (data[0] || [])
    .filter(Array.isArray)
    .map(chunk => chunk[0] || '')
    .join('');

  return full.split(SEP);
}
