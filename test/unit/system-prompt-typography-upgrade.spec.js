// Regression: system-prompt-typography-upgrade（對應 v2.0.53 改的 SYSTEM / DOC
// prompt 排版規則擴充的升級路徑）
//
// Bug 全貌：
//   v2.0.53 對 DEFAULT_SYSTEM_PROMPT 規則 1 插入「日文 ？！ 後空格移除」說明句、
//   新增規則 6「忠於原文的句尾標點」；UNIVERSAL_SYSTEM_PROMPT 對應新增 rule 5 / 6。
//   當時漏加 _normalizePromptForComparison 的 strip rule → 既有使用者 storage 存的
//   「舊 default 字面值」被誤判為「使用者客製」→ runtime 永遠吃不到新 prompt，
//   options 只顯示 hint 等使用者手動更新。本 spec 鎖「舊 saved 視為未客製 →
//   自動吃新 default」這條升級路徑（DOC prompt 同一常數，一併覆蓋）。
//
// SANITY 紀錄（已驗證）：暫時把 storage.js _normalizePromptForComparison 的
// v2.0.53 三條 strip rule 註解掉 → 本 spec 前三條斷言 fail（getEffectiveSystemPrompt
// 回舊字面值而非新 DEFAULT / UNIVERSAL）→ 還原 → pass。
import { test, expect } from '@playwright/test';

globalThis.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    sync:  { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

const {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_DOC_SYSTEM_PROMPT,
  UNIVERSAL_SYSTEM_PROMPT,
  LANG_LABELS,
  getEffectiveSystemPrompt,
  getEffectiveDocSystemPrompt,
} = await import('../../shinkansen/lib/storage.js');

// ── v2.0.53 之前的舊 default 字面值（凍結快照，不可改）─────────────
// 這是既有使用者 storage 裡實際存著的內容；normalize 機制要保證它被視為「未客製」。
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
1. 標點符號：全面使用全形標點符號（，。、（）、！），標點符號後方禁止加上空格。書籍/電影等作品名請使用全形書名號《》。標題式的單句句末不加句號。
2. 破折號處理：盡可能改寫句子結構來消除破折號（—）的使用需求，用流暢的中文敘述取代。
3. 中英夾雜排版：在「中文字」與「英文字/阿拉伯數字」之間，務必插入一個半形空格。
4. 數字格式：
   - 1~99 的數字：使用中文數字（例如：七年、一百億）。
   - 100（含）以上的數字：使用阿拉伯數字（例如：365 天、58500 元），禁止使用千位分隔符（,）。
5. 年份格式：完整的四位數西元年份保留阿拉伯數字，並在後方加上「年」（例如：1975 年）。縮寫年份（如 '90s）不在此限。
</formatting_and_typography>`;

const OLD_UNIVERSAL_SYSTEM_PROMPT = `<role_definition>
You are a professional translator. Translate web text into {targetLanguage} accurately and naturally.
</role_definition>

<rules>
1. Output translation only. Do not output your thinking, prefaces, or explanations.
2. Translate, do not interpret. Keep the original meaning.
3. Keep proper nouns, brand names, URLs, code identifiers, and inline code untranslated.
4. Preserve all inline markdown / HTML structure exactly:
   **bold** stays **bold**, [text](url) keeps its link, <strong> / <em> / <code> tags unchanged.
   Only translate the visible natural-language text inside the structure.
</rules>`;

test.describe('v2.0.53 system prompt 升級路徑：舊 default 字面值視為未客製', () => {
  test('zh-TW：saved=舊 DEFAULT 字面值 → 回新 DEFAULT（自動吃到排版規則擴充）', () => {
    expect(getEffectiveSystemPrompt('zh-TW', OLD_DEFAULT_SYSTEM_PROMPT))
      .toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test('非 zh-TW（ja）：saved=舊 DEFAULT 字面值 → 回新 universal 注入後（含 rule 5/6）', () => {
    const eff = getEffectiveSystemPrompt('ja', OLD_DEFAULT_SYSTEM_PROMPT);
    expect(eff).toContain("Mirror the source's sentence-final punctuation");
    expect(eff).toContain(LANG_LABELS.ja);
    expect(eff).not.toContain('{targetLanguage}');
  });

  test('非 zh-TW（en）：saved=舊 universal 注入後字面值（含 reinforcement 尾段）→ 回新 universal 注入後', () => {
    // options.js 儲存時寫進 storage 的是 effective 字面值：universal 注入 label 後
    // + target language reinforcement 尾段（getEffectiveSystemPrompt('en', '') 的輸出）
    const oldSavedEn = OLD_UNIVERSAL_SYSTEM_PROMPT.replaceAll('{targetLanguage}', LANG_LABELS.en)
      + '\n\nTranslate the input text into English. The output should be in English, regardless of the source language.';
    const eff = getEffectiveSystemPrompt('en', oldSavedEn);
    expect(eff).toBe(getEffectiveSystemPrompt('en', ''));
    expect(eff).toContain("Mirror the source's sentence-final punctuation");
  });

  test('DOC prompt 同升級路徑：zh-TW saved=舊字面值 → 回新 DOC DEFAULT', () => {
    // v2.0.75 起 DOC prompt = DEFAULT_SYSTEM_PROMPT + <document_number_fidelity>
    // 區塊,不再是純別名;升級路徑斷言改對 DEFAULT_DOC_SYSTEM_PROMPT
    expect(getEffectiveDocSystemPrompt('zh-TW', OLD_DEFAULT_SYSTEM_PROMPT))
      .toBe(DEFAULT_DOC_SYSTEM_PROMPT);
  });

  test('真正客製化的 prompt 不受影響（原樣 return）', () => {
    expect(getEffectiveSystemPrompt('zh-TW', '我自訂的翻譯 prompt'))
      .toBe('我自訂的翻譯 prompt');
  });

  test('新 DEFAULT / UNIVERSAL 含 v2.0.53 修法本體（防未來誤刪）', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('翻譯成中文時必須移除這些空格');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('忠於原文的句尾標點');
    expect(UNIVERSAL_SYSTEM_PROMPT).toContain('punctuation and spacing conventions');
    expect(UNIVERSAL_SYSTEM_PROMPT).toContain("Mirror the source's sentence-final punctuation");
  });
});
