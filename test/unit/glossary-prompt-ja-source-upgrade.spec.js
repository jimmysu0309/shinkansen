// Regression: glossary-prompt-ja-source-upgrade（對應 v2.0.52 修的「日文書術語表
// source 欄被轉寫成羅馬拼音」bug 的升級路徑）
//
// Bug 全貌（兩層）：
//   1. LLM 層：舊 DEFAULT_GLOSSARY_PROMPT 自稱「英中對照術語表」且範例全拉丁字母，
//      gemini-3.5-flash 對日文輸入會把 source 全轉羅馬拼音（Aizawa / Kashiwaki…），
//      導致譯後一致性掃描（checkGlossaryCompliance 拿 source 比對日文原文）整批失效。
//      修法 = prompt 加 <source_fidelity>（source 必須逐字取自原文、保持原文字系）
//      + 日文範例 + 日文漢字台灣字形規則。LLM 行為無法 fixture 化，已用真 API probe
//      驗證（3.5-flash 舊 prompt 17/17 拉丁 → 新 prompt 3 輪 0/16 拉丁），
//      詳見 test/PENDING_REGRESSION.md 對應條目。
//   2. 升級路徑層（本 spec 鎖這層，確定性）：既有使用者 storage 存的是「舊 default
//      字面值」，若 _normalizePromptForComparison 沒把新舊差異 normalize 掉，
//      舊 saved 會被誤判「使用者客製」→ 永遠吃不到新 prompt → bug 對既有使用者復發。
//
// SANITY 紀錄（已驗證）：暫時把 storage.js _normalizePromptForComparison 的
// <source_fidelity> strip rule 註解掉 → 本 spec「zh-TW：舊 DEFAULT 字面值視為未客製」
// 斷言 fail（getEffectiveGlossaryPrompt 回舊字面值而非新 DEFAULT）→ 還原 → pass。
import { test, expect } from '@playwright/test';

globalThis.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    sync:  { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

const {
  DEFAULT_GLOSSARY_PROMPT,
  UNIVERSAL_GLOSSARY_PROMPT,
  LANG_LABELS,
  getEffectiveGlossaryPrompt,
} = await import('../../shinkansen/lib/storage.js');

// ── v2.0.51 之前的舊 default 字面值（凍結快照，不可改）─────────────
// 這是既有使用者 storage 裡實際存著的內容；normalize 機制要保證它被視為「未客製」。
const OLD_DEFAULT_GLOSSARY_PROMPT = `<role_definition>
你是一位專業的翻譯術語擷取助理。你的任務是從使用者提供的文章或摘要中，精準擷取需要統一翻譯的專有名詞，建立符合台灣在地化語境的英中對照術語表。
</role_definition>
<extraction_scope>
請嚴格限制只擷取以下四類實體：
1. 人名 (person)：西方人名須轉換為台灣通行中譯（例如：Elon Musk→馬斯克、Trump→川普、Peter Hessler→何偉）。華人姓名亦須使用台灣通行譯法。
2. 地名 (place)：國家、城市、地理位置須採用台灣標準譯名（例如：Israel→以色列、London→倫敦、Chengdu→成都）。
3. 專業術語與新創詞 (tech)：台灣尚無廣泛通用譯名的專業詞彙、新創詞。譯名後方「必須」附加全形括號標註原文（例如：watchfluencers→錶壇網紅（watchfluencers）、algorithmic filter bubble→演算法驅動的資訊繭房（algorithmic filter bubble））。
4. 作品名 (work)：書籍、電影、歌曲等作品名稱，須使用台灣通行譯名並加上全形書名號（例如：Parasite→《寄生上流》）。
</extraction_scope>
<exclusion_rules>
絕對不可擷取以下內容（違反將導致嚴重錯誤）：
1. 在台灣已高度通用且通常不翻譯的品牌、平台、縮寫或企業名（例如：Google, Netflix, AI, NBA, F1, 勞力士， 蘋果， 抖音， 微軟， 麥當勞， 可口可樂， Instagram 等）。
2. 一般的英文單字（非專有名詞的普通名詞、動詞、形容詞）。
3. 原文中僅出現一次且無歧義的簡單詞彙。
</exclusion_rules>
<output_constraints>
1. 語言規範：嚴格使用台灣繁體中文與台灣慣用語，絕對禁用中國譯法（例如：必須使用「影片」而非「視頻」、「軟體」而非「軟件」、「程式」而非「程序」、「實作」而非「實現」、「線程」而非「進程」）。
2. 數量限制：提取數量上限為 200 條，若超過請依重要性篩選，保留最重要的 200 條。
3. 絕對 JSON 格式：只能輸出純 JSON 陣列，絕對不可包含任何前言、解釋、後記，也「絕對不要」使用 \`\`\`json 和 \`\`\` 的 Markdown 程式碼區塊標記。
</output_constraints>
<json_format_example>
[{"source":"Peter Hessler","target":"何偉","type":"person"},{"source":"Chengdu","target":"成都","type":"place"},{"source":"watchfluencers","target":"錶壇網紅（watchfluencers）","type":"tech"},{"source":"Parasite","target":"《寄生上流》","type":"work"}]
</json_format_example>`;

const OLD_UNIVERSAL_GLOSSARY_PROMPT = `<role_definition>
You are a glossary extraction assistant for translating into {targetLanguage}.
</role_definition>
<extraction_scope>
Extract only these four entity types:
1. Person names — proper-noun translations into {targetLanguage}.
2. Place names — countries, cities, regions, in {targetLanguage} convention.
3. Technical terms / coined words — terms without an established {targetLanguage} translation.
   Append the original in parentheses on first appearance.
4. Work titles — books, films, songs; use the established {targetLanguage} convention if available.
</extraction_scope>
<exclusion_rules>
Do NOT extract:
1. Globally common brands / abbreviations (Google, Netflix, AI, NBA, etc.)
2. Common words (non-proper nouns).
3. Terms appearing only once with no ambiguity.
</exclusion_rules>
<output_constraints>
1. Maximum 200 entries; if exceeded, keep the most important.
2. Output pure JSON only. No prefaces, no postscripts, no markdown code fences.
</output_constraints>
<json_format_example>
[{"source":"Peter Hessler","target":"<translated>","type":"person"},{"source":"Chengdu","target":"<translated>","type":"place"}]
</json_format_example>`;

test.describe('v2.0.52 glossary prompt 升級路徑：舊 default 字面值視為未客製', () => {
  test('zh-TW：saved=舊 DEFAULT 字面值 → 回新 DEFAULT（自動吃到 source_fidelity 修法）', () => {
    expect(getEffectiveGlossaryPrompt('zh-TW', OLD_DEFAULT_GLOSSARY_PROMPT))
      .toBe(DEFAULT_GLOSSARY_PROMPT);
  });

  test('非 zh-TW（ja）：saved=舊 DEFAULT 字面值 → 回新 universal 注入後（含 source_fidelity）', () => {
    const eff = getEffectiveGlossaryPrompt('ja', OLD_DEFAULT_GLOSSARY_PROMPT);
    expect(eff).toContain('<source_fidelity>');
    expect(eff).toContain(LANG_LABELS.ja);
    expect(eff).not.toContain('{targetLanguage}');
  });

  test('非 zh-TW（en）：saved=舊 universal 注入後字面值 → 回新 universal 注入後', () => {
    const oldSavedEn = OLD_UNIVERSAL_GLOSSARY_PROMPT.replaceAll('{targetLanguage}', LANG_LABELS.en);
    const eff = getEffectiveGlossaryPrompt('en', oldSavedEn);
    expect(eff).toBe(UNIVERSAL_GLOSSARY_PROMPT.replaceAll('{targetLanguage}', LANG_LABELS.en));
    expect(eff).toContain('<source_fidelity>');
  });

  test('真正客製化的 prompt 不受影響（原樣 return）', () => {
    expect(getEffectiveGlossaryPrompt('zh-TW', '我自訂的術語表 prompt'))
      .toBe('我自訂的術語表 prompt');
  });

  test('新 DEFAULT / UNIVERSAL 含 source_fidelity 修法本體（防未來誤刪）', () => {
    // source 逐字取自原文 + 禁羅馬拼音 + 日文範例 + 日文漢字台灣字形規則
    expect(DEFAULT_GLOSSARY_PROMPT).toContain('<source_fidelity>');
    expect(DEFAULT_GLOSSARY_PROMPT).toContain('逐字出現');
    expect(DEFAULT_GLOSSARY_PROMPT).toContain('相沢→相澤');
    expect(DEFAULT_GLOSSARY_PROMPT).toContain('{"source":"相沢","target":"相澤","type":"person"}');
    expect(UNIVERSAL_GLOSSARY_PROMPT).toContain('<source_fidelity>');
    expect(UNIVERSAL_GLOSSARY_PROMPT).toContain('Never romanize');
    // 同輪追加:無通行譯名作品名須自行譯出(不可原文照抄)+ target 不可填分類代號
    expect(DEFAULT_GLOSSARY_PROMPT).toContain('無通行譯名的作品名須自行譯成台灣繁體中文');
    expect(DEFAULT_GLOSSARY_PROMPT).toContain('絕對不可填入分類代號');
    expect(UNIVERSAL_GLOSSARY_PROMPT).toContain('never leave the original title untranslated');
    expect(UNIVERSAL_GLOSSARY_PROMPT).toContain('never a category token');
  });
});

// ── code review 2026-08-03 批次 4 F1:strip 規則錨定預設字面值 ──
//
// 原 bug:_normalizePromptForComparison 的 <source_fidelity> strip 規則用
// `[\s\S]*?` 吞「任意內容」——使用者只客製區塊內文後儲存，saved 與 default
// normalize 後相等 → 誤判未客製 → runtime 靜默改吃預設 prompt，客製內容失效無提示。
// 修法：strip 規則改錨定預設區塊完整字面值(從 prompt 常數抽，單一資料源)。
//
// SANITY 紀錄(已驗證，2026-08-04)：暫時把 storage.js 的
// _PROMPT_DEFAULT_BLOCK_STRIP_RES 改回萬用字元版
// `/<source_fidelity>[\s\S]*?<\/source_fidelity>\n/g` → 「只客製 source_fidelity
// 內文」case fail(回預設 prompt 而非客製版)→ 還原 → pass。
test.describe('F1：只客製區塊內文必須視為已客製', () => {
  test('只客製 <source_fidelity> 內文(zh-TW)→ 原樣 return，不得靜默改吃預設', () => {
    const customized = DEFAULT_GLOSSARY_PROMPT.replace(
      /<source_fidelity>[\s\S]*?<\/source_fidelity>/,
      '<source_fidelity>\n我的自訂規則：source 一律轉成羅馬拼音。\n</source_fidelity>',
    );
    expect(customized).not.toBe(DEFAULT_GLOSSARY_PROMPT); // 前置：確實有改到
    expect(getEffectiveGlossaryPrompt('zh-TW', customized)).toBe(customized);
  });

  test('只客製 <source_fidelity> 內文(en universal 注入後)→ 原樣 return', () => {
    const savedEn = UNIVERSAL_GLOSSARY_PROMPT.replaceAll('{targetLanguage}', LANG_LABELS.en)
      .replace(
        /<source_fidelity>[\s\S]*?<\/source_fidelity>/,
        '<source_fidelity>\nMy custom rule: always romanize the source.\n</source_fidelity>',
      );
    expect(getEffectiveGlossaryPrompt('en', savedEn)).toBe(savedEn);
  });
});
