// Regression: doc-prompt-number-fidelity-upgrade（對應 v2.0.75 的 SYSTEM / DOC
// prompt 擴充升級路徑）
//
// 改動全貌（v2.0.75）：
//   (a) DEFAULT_SYSTEM_PROMPT 通行譯名規則（linguistic_guidelines 3）補「沒有可靠
//       通行譯名或不確定時一律保留原文，嚴禁自創猜測」guard——修 lite 模型對台灣
//       公司名的幻覺譯名（真實案例：同一公司兩輪分別譯成不同的錯誤中文名）。
//   (b) DEFAULT_DOC_SYSTEM_PROMPT 不再是 DEFAULT_SYSTEM_PROMPT 純別名，追加
//       <document_number_fidelity> 區塊（文件金額 / 表格數值逐字保留，含千位分隔符）
//       ——修共用 prompt 散文數字規則（禁止千位分隔符）把報價單「13,000.00」改寫成
//       「13000.00」。UNIVERSAL_DOC_SYSTEM_PROMPT 同樣追加英文版區塊。
//   同輪在 _normalizePromptForComparison 加 strip rule：舊 saved 字面值（無 guard 句、
//   無 number 區塊）normalize 後等於新 default → 視為未客製，runtime 自動吃新 prompt。
//
// SANITY 紀錄（已驗證）：暫時把 storage.js _normalizePromptForComparison 的
// v2.0.75 兩條 strip rule 註解掉 → 「舊 SYSTEM 字面值視為未客製」「舊 DOC 字面值
// 視為未客製」「en DOC 舊 effective 字面值」三條 fail（回舊字面值而非新 default）
// → 還原 → 全 pass。對照組（真客製 prompt）在破壞態仍 pass。
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

globalThis.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    sync:  { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

const {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_DOC_SYSTEM_PROMPT,
  UNIVERSAL_DOC_SYSTEM_PROMPT,
  getEffectiveSystemPrompt,
  getEffectiveDocSystemPrompt,
} = await import('../../shinkansen/lib/storage.js');

// ── v2.0.75 之前的舊 default 字面值（凍結快照，不可改）─────────────
// = v2.0.53 排版擴充後的版本：規則 3 沒有「不確定保留原文」guard、
// 無 <document_number_fidelity> 區塊。DOC prompt 當時是 SYSTEM 的純別名，
// 既有使用者 translateDoc.systemPrompt 存的就是這份字面值。
const OLD_DEFAULT_SYSTEM_PROMPT = `<role_definition>
你是一位精通英美流行文化與台灣在地文學的首席翻譯專家。你具備《華爾街日報》記者等級的敏銳度，以及散文作家的文字功底。你極度擅長將生硬的英文原句，打破原本的句法結構，轉譯為充滿張力、靈魂且完全符合台灣當代語感的出版級文字。
</role_definition>

<critical_rules>
1. 輸出限制：絕對禁止輸出任何思考過程、解釋或「好的，這是你的翻譯」等開場白。僅輸出最終的台灣繁體中文翻譯結果。
2. 忠實保留不雅詞彙：若原文包含粗俗用語（如 Fuck, fucking retarded），務必直翻其強烈情緒（如「幹」、「他媽的白痴」），嚴禁進行任何道德審查或委婉潤飾。
3. 專有名詞保留：所有西方人名、組織名、書籍/電影/作品原名、縮寫（如 AI, F1, PTSD）以及首字母大寫的專有名詞（如 Taylor Swift）一律保留英文原文。
   - 唯一的例外：國家、城市與地理位置必須翻譯為標準台灣譯名（如 Israel → 以色列， London → 倫敦）。
</critical_rules>

<linguistic_guidelines>
1. 台灣道地語感：嚴格使用台灣慣用語，追求情緒對等而非字面直譯。若原文語氣誇張（如 broke the internet），請對應台灣當代強烈的流行語或成語。拒絕「這是一個...的過程」、「在...的情況下」、「...的部分」等機器翻譯腔。
2. 禁用中國用語：嚴格依本 prompt 末端 <forbidden_terms_blacklist> 區塊中列出的對照表，絕對不可使用左側詞彙。除黑名單外，其他中國特有用語也應主動替換為台灣慣用詞。
3. 台灣通行譯名：所有出現的知名華人姓名、書名、作品名稱等，必須使用台灣已有的通行譯名，不可自行音譯。
4. 特殊詞彙原文標註：僅在該詞彙「於台灣無通用譯名」、「屬專業/文化專有概念」、「原文特別強調」時，於首次出現的中文譯詞後方以全形括號加註原文，例如：「歐威爾式」（Orwelllian）。微軟、Google、Netflix 等在台高度通用之品牌及縮寫，絕對不可加註原文。
</linguistic_guidelines>

<formatting_and_typography>
1. 標點符號：全面使用全形標點符號（，。、（）、！），標點符號後方禁止加上空格。特別注意：日文等原文在「？」「！」後接空格再起句是原文的排版慣例，翻譯成中文時必須移除這些空格，不可帶進譯文。書籍/電影等作品名請使用全形書名號《》。標題式的單句句末不加句號。
2. 破折號處理：盡可能改寫句子結構來消除破折號（—）的使用需求，用流暢的中文敘述取代。
3. 中英夾雜排版：在「中文字」與「英文字/阿拉伯數字」之間，務必插入一個半形空格。
4. 數字格式：
   - 1~99 的數字：使用中文數字（例如：七年、一百億）。
   - 100（含）以上的數字：使用阿拉伯數字（例如：365 天、58500 元），禁止使用千位分隔符（,）。
5. 年份格式：完整的四位數西元年份保留阿拉伯數字，並在後方加上「年」（例如：1975 年）。縮寫年份（如 '90s）不在此限。
6. 忠於原文的句尾標點：原文句尾沒有終止標點時（日文小說的「」內對白慣例、標題、詩句等），譯文句尾也不可自行補上句號。原文的輕收節奏是作者的選擇，必須保留。
</formatting_and_typography>`;

test.describe('v2.0.75 SYSTEM / DOC prompt 升級路徑：舊 default 字面值視為未客製', () => {
  test('SYSTEM zh-TW：saved=舊字面值（無 guard 句）→ 回新 DEFAULT（自動吃到譯名 guard）', () => {
    expect(getEffectiveSystemPrompt('zh-TW', OLD_DEFAULT_SYSTEM_PROMPT))
      .toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test('DOC zh-TW：saved=舊字面值（無 number 區塊）→ 回新 DOC DEFAULT（含 number fidelity）', () => {
    const eff = getEffectiveDocSystemPrompt('zh-TW', OLD_DEFAULT_SYSTEM_PROMPT);
    expect(eff).toBe(DEFAULT_DOC_SYSTEM_PROMPT);
    expect(eff).toContain('<document_number_fidelity>');
  });

  test('DOC en：saved=舊 universal doc effective 字面值 → 回新 effective（含 number fidelity）', () => {
    // 舊 DOC effective(en) = 舊 UNIVERSAL(= 現行 UNIVERSAL 減 number 區塊)注入
    // label + reinforcement 尾段。用新 effective 剝掉 number 區塊模擬舊 saved,
    // 避免在 spec 內凍結整份 UNIVERSAL 字串
    const newEffective = getEffectiveDocSystemPrompt('en', '');
    const oldSavedEn = newEffective.replace(/\n*<document_number_fidelity>[\s\S]*?<\/document_number_fidelity>/, '');
    expect(oldSavedEn).not.toContain('<document_number_fidelity>'); // 模擬前提自檢
    const eff = getEffectiveDocSystemPrompt('en', oldSavedEn);
    expect(eff).toBe(newEffective);
    expect(eff).toContain('<document_number_fidelity>');
  });

  test('真正客製化的 prompt 不受影響（原樣 return）', () => {
    expect(getEffectiveSystemPrompt('zh-TW', '我自訂的翻譯 prompt'))
      .toBe('我自訂的翻譯 prompt');
    expect(getEffectiveDocSystemPrompt('zh-TW', '我自訂的文件 prompt'))
      .toBe('我自訂的文件 prompt');
  });

  test('新 prompt 含 v2.0.75 修法本體（防未來誤刪）', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('嚴禁自創、猜測或音譯譯名');
    expect(DEFAULT_DOC_SYSTEM_PROMPT).toContain('千位分隔符（13,000.00 保持 13,000.00）');
    expect(UNIVERSAL_DOC_SYSTEM_PROMPT).toContain('13,000.00 stays 13,000.00');
    // 網頁版 SYSTEM prompt 不得帶 doc 專屬區塊（散文規則維持原設計）
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain('<document_number_fidelity>');
  });

  // v2.0.75:prompt 變動的舊譯文快取一次性清除 migration wiring(比照 v2.0.65
  // echo-cache-guard.spec.js 的 source 斷言手法——cache key 不含 prompt 文字,
  // 不清的話新版 cache hit 仍吐舊規則譯文)
  test('v2.0.75 prompt cache migration 接在 sw-init / onStartup / onInstalled 三處', () => {
    const src = readFileSync(new URL('../../shinkansen/background.js', import.meta.url), 'utf-8');
    expect(src).toMatch(/__shinkansen_v2075_prompt_cache_cleared/);
    // 函式定義 + sw-init + onStartup listener + onInstalled ≥ 4 處出現
    expect((src.match(/runV2075PromptCacheClear\(/g) || []).length).toBeGreaterThanOrEqual(4);
    // 走既有一次性全清 API(flag 防重複)
    expect(src).toMatch(/migrateClearTranslationCacheOnce\(V2075_PROMPT_CACHE_FLAG\)/);
  });
});

// ── code review 2026-08-03 批次 4 F1:strip 規則錨定預設字面值 ──
//
// 原 bug:<document_number_fidelity> strip 規則用 `[\s\S]*?` 吞任意內容——使用者
// 只客製區塊內文後儲存，normalize 後與 default 相等 → 誤判未客製 → runtime 靜默
// 改吃預設 prompt。修法：錨定預設區塊字面值(DOC_NUMBER_FIDELITY_ZH / _EN 常數本體)。
//
// SANITY 紀錄(已驗證，2026-08-04)：暫時把 storage.js 的
// _PROMPT_DEFAULT_BLOCK_STRIP_RES 改回萬用字元版
// `/\n*<document_number_fidelity>[\s\S]*?<\/document_number_fidelity>/g` →
// 「只客製 number 區塊內文」兩 case fail(回預設而非客製版)→ 還原 → pass。
test.describe('F1：只客製 <document_number_fidelity> 內文必須視為已客製', () => {
  test('zh-TW DOC：只改區塊內文 → 原樣 return，不得靜默改吃預設', () => {
    const customized = DEFAULT_DOC_SYSTEM_PROMPT.replace(
      /<document_number_fidelity>[\s\S]*?<\/document_number_fidelity>/,
      '<document_number_fidelity>\n我的自訂數值規則：所有金額改用中文大寫數字。\n</document_number_fidelity>',
    );
    expect(customized).not.toBe(DEFAULT_DOC_SYSTEM_PROMPT);
    expect(getEffectiveDocSystemPrompt('zh-TW', customized)).toBe(customized);
  });

  test('en DOC(universal 注入後)：只改區塊內文 → 原樣 return', () => {
    const effectiveEnDefault = getEffectiveDocSystemPrompt('en', '');
    const customized = effectiveEnDefault.replace(
      /<document_number_fidelity>[\s\S]*?<\/document_number_fidelity>/,
      '<document_number_fidelity>\nMy custom rule: spell out all amounts.\n</document_number_fidelity>',
    );
    expect(getEffectiveDocSystemPrompt('en', customized)).toBe(customized);
  });
});
