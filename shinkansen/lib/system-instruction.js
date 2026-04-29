// system-instruction.js — 跨 provider 共用的翻譯 batch 構建 helper（v1.5.7 起）
//
// 從 lib/gemini.js 抽出，讓 Gemini 與 OpenAI-compatible 兩條 adapter 共用同一份：
//   1. DELIMITER：多段串接分隔符
//   2. packChunks：依字元預算 + 段數雙門檻 greedy 分批
//   3. buildEffectiveSystemInstruction：依批次內容動態追加規則
//      （多段分隔符規則 / 段內換行規則 / 佔位符規則 / 自動 glossary
//        / fixedGlossary / 中國用語黑名單）
//
// 抽出原因：自訂 OpenAI-compat provider 也要繼承「黑名單 + 固定術語表」自動注入
//          （依 Jimmy 設計決定 #3：systemPrompt 獨立、黑名單 & 固定術語表共用）。
//          改放 lib/ 共用模組讓 Gemini 與 OpenAI-compat 兩個 adapter 同步演進，
//          未來新加翻譯規則只改一處。

import { DEFAULT_UNITS_PER_BATCH, DEFAULT_CHARS_PER_BATCH } from './constants.js';

/** 多段翻譯時用此 delimiter 串接 / 拆回對齊。Gemini 與 OpenAI-compat 共用。 */
export const DELIMITER = '\n<<<SHINKANSEN_SEP>>>\n';

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
    // forbidden_terms_blacklist 標籤(防止使用者輸入提前關閉區塊)
    .replace(/<\/?forbidden_terms_blacklist>/gi, '')
    .trim()
    .slice(0, 200); // 單詞超過 200 字本來就不正常,截斷防 prompt 暴脹
}

/**
 * Greedy 打包：對 texts 陣列用字元預算 + 段數上限雙門檻切成連續子批次，
 * 回傳「起始 / 結束 index」陣列讓呼叫端可以對齊結果。
 */
export function packChunks(texts) {
  const batches = [];
  let cur = null;
  const flush = () => { if (cur && cur.end > cur.start) batches.push(cur); cur = null; };
  for (let i = 0; i < texts.length; i++) {
    const len = (texts[i] || '').length;
    if (len > MAX_CHARS_PER_CHUNK) {
      flush();
      batches.push({ start: i, end: i + 1 });
      continue;
    }
    if (cur && (cur.chars + len > MAX_CHARS_PER_CHUNK || (cur.end - cur.start) >= MAX_UNITS_PER_CHUNK)) {
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
 * 基礎翻譯指令 → 多段分隔符規則 → 段內換行規則 → 佔位符規則 → 自動 glossary → fixedGlossary → 中國用語黑名單。
 * 順序很重要：行為規則緊跟基礎指令，術語表/黑名單是「參考資料」放末端。
 *
 * @param {string} baseSystem 使用者設定的基礎 system instruction（每個 provider 可能不同）
 * @param {string[]} texts 本批原文陣列
 * @param {string} joined 已用 DELIMITER join 過的完整文字
 * @param {Array<{source:string, target:string}>} [glossary] 可選的自動擷取術語對照表
 * @param {Array<{source:string, target:string}>} [fixedGlossary] 可選的使用者固定術語表（優先級高於 glossary）
 * @param {Array<{forbidden:string, replacement:string}>} [forbiddenTerms] 中國用語黑名單
 * @returns {string} 完整的 effectiveSystem
 */
export function buildEffectiveSystemInstruction(baseSystem, texts, joined, glossary, fixedGlossary, forbiddenTerms) {
  const parts = [baseSystem];

  // 多段翻譯分隔符與序號規則
  if (texts.length > 1) {
    parts.push(
      `額外規則（多段翻譯分隔符與序號，極重要）:\n本批次包含 ${texts.length} 段文字。每段開頭有序號標記 «N»（N 為 1 到 ${texts.length}），段與段之間以分隔符 <<<SHINKANSEN_SEP>>> 隔開。\n你的輸出必須：\n- 每段譯文開頭也加上對應的序號標記 «N»（N 與輸入的序號一一對應）\n- 段與段之間用完全相同的分隔符 <<<SHINKANSEN_SEP>>> 隔開\n- 恰好輸出 ${texts.length} 段譯文和 ${texts.length - 1} 個分隔符\n- 不可合併段落、不可省略分隔符、不可增減段數`
    );
  }

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

  // 自動擷取術語對照表
  // v1.8.20: 對 source / target 消毒,防止頁面內容塞 sentinel token 影響協定
  if (glossary && glossary.length > 0) {
    const lines = glossary
      .map(e => `${sanitizeTermText(e.source)} → ${sanitizeTermText(e.target)}`)
      .filter(l => !/^\s*→\s*$/.test(l))
      .join('\n');
    if (lines) {
      parts.push(
        '以下是本篇文章的術語對照表，遇到這些原文一律使用指定譯名，不可自行改寫，也不需加註英文原文：\n' + lines
      );
    }
  }

  // v1.0.29: 使用者固定術語表（優先級最高，放在最末端讓 LLM 給予最高權重）
  if (fixedGlossary && fixedGlossary.length > 0) {
    const lines = fixedGlossary
      .map(e => `${sanitizeTermText(e.source)} → ${sanitizeTermText(e.target)}`)
      .filter(l => !/^\s*→\s*$/.test(l))
      .join('\n');
    if (lines) {
      parts.push(
        '以下是使用者指定的固定術語表，優先級高於上方所有術語對照。遇到這些原文一律使用指定譯名，不可自行改寫，也不需加註英文原文：\n' + lines
      );
    }
  }

  // v1.5.6: 中國用語黑名單。放在所有規則最末端（高於 fixedGlossary）讓 LLM 給予最高權重。
  // 用 <forbidden_terms_blacklist> XML tag 包起來，跟 DEFAULT_SYSTEM_PROMPT 第 2 條
  // 的「依本 prompt 末端 <forbidden_terms_blacklist> 區塊」reference 對應。
  if (forbiddenTerms && forbiddenTerms.length > 0) {
    const tableLines = forbiddenTerms
      .map(t => `${sanitizeTermText(t.forbidden)} → ${sanitizeTermText(t.replacement)}`)
      .filter(l => !/^\s*→\s*$/.test(l))
      .join('\n');
    if (tableLines) {
      parts.push(
        '<forbidden_terms_blacklist>\n極重要：以下是嚴格禁用的中國大陸用語黑名單。譯文中絕對不可使用左欄詞彙，必須改用右欄的台灣慣用語。即使原文是英文（例如 video / software / data），譯文也只能使用右欄。違反此規則即為錯誤翻譯。\n\n禁用 → 必須改用\n' + tableLines + '\n\n說明：本黑名單為硬性規定，優先級高於任何 stylistic 考量。若該詞為文章本身討論的主題（例如一篇分析「中國科技用語演變」的文章），請使用引號標示後保留原詞，例如「視頻」。\n</forbidden_terms_blacklist>'
      );
    }
  }

  return parts.join('\n\n');
}
