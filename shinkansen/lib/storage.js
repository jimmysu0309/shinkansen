// storage.js — 設定讀寫封裝
import { browser } from './compat.js';
import { DEFAULT_UNITS_PER_BATCH, DEFAULT_CHARS_PER_BATCH } from './constants.js';

// v0.83: 預設 system prompt 全面升級——從「翻譯助理」提升為「首席翻譯專家」，
// 強調台灣語感、排版規範、專有名詞保留策略。同步切換預設模型至 gemini-3-flash-preview。
export const DEFAULT_SYSTEM_PROMPT = `<role_definition>
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
3. 台灣通行譯名：所有出現的知名華人姓名、書名、作品名稱等，必須使用台灣已有的通行譯名，不可自行音譯。沒有可靠通行譯名或不確定時，一律保留原文，嚴禁自創、猜測或音譯譯名（例如不確定某公司的中文名稱時，保留其英文名）。
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

// W7:文件翻譯 user-editable prompt 預設 = 跟網頁翻譯同款 DEFAULT_SYSTEM_PROMPT。
// **通用於 PDF 與未來各 Office 格式**(.docx / .xlsx / .pptx),format-specific
// 設定未來各自加 translateDoc.docx / .xlsx sub-key。
//
// inline marker 協定(⟦b⟧/⟦i⟧/⟦l:N⟧)的指示獨立成 DOC_INLINE_MARKER_INSTRUCTION
// 常數,由 background.js TRANSLATE_DOC_BATCH 在送 LLM 前自動 append 到 user
// prompt 後,user 編輯不到也看不到 — 避免改壞 marker 解析的核心邏輯。
//
// v2.0.75:文件版在共用 prompt 之後追加 <document_number_fidelity> 區塊——
// 共用 prompt 的散文數字規則(1~99 中文數字、禁止千位分隔符)是為網頁文章設計,
// 套在報價單 / 規格表會把「13,000.00」改寫成「13000.00」。文件的金額 / 表格
// 數值必須逐字保留原格式,此區塊明示優先權蓋過散文規則
const DOC_NUMBER_FIDELITY_ZH = `

<document_number_fidelity>
文件數值忠實（本節優先於上方「數字格式」規則）：文件中的金額、規格數值、表格與編號中的數字，一律逐字保留原文格式——包括千位分隔符（13,000.00 保持 13,000.00）、小數位數、正負號與百分比符號。不改寫為中文數字、不移除或增加分隔符。敘述性內文中的一般數字仍依上方「數字格式」規則處理。
</document_number_fidelity>`;

const DOC_NUMBER_FIDELITY_EN = `

<document_number_fidelity>
Documents: reproduce every amount, specification value, and table or ID number exactly as written in the source — keep thousands separators (13,000.00 stays 13,000.00), decimal places, signs, and percent marks. Never add or remove digit separators or rewrite digits.
</document_number_fidelity>`;

export const DEFAULT_DOC_SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT + DOC_NUMBER_FIDELITY_ZH;

// W7 inline marker 協定指示(內部常數,**不暴露給 user 編輯**)。
// background.js 送 LLM 前 append 到 user 編輯的 systemPrompt 後。
// 變動內容 → 影響 LLM 對 marker 的對齊 → 既有 cache 不一定回得回對的 segments,
// 但 cache key sha1 不變(input plainText 不含此區塊,只 LLM 看到),所以實質
// 只影響 cache miss 那批的譯文品質。修改建議搭配 cache 清空 release。
export const DOC_INLINE_MARKER_INSTRUCTION = `

<inline_style_markers>
PDF 文件翻譯時,文字可能含 inline 樣式邊界標記:
  ⟦b⟧...⟦/b⟧ — 粗體段
  ⟦i⟧...⟦/i⟧ — 斜體段
  ⟦l:N⟧...⟦/l⟧ — 超連結(N 為連結編號,直接保留)

翻譯規則:
1. 標記必成對:⟦b⟧ 必對應 ⟦/b⟧、⟦i⟧ 對 ⟦/i⟧、⟦l:N⟧ 對 ⟦/l⟧,絕不可單邊。
2. 標記內中文字界可前後微調幾字以對應正確語意片段,但須維持「該段被包裹」的整體性。
   範例:⟦b⟧Editor's Note:⟦/b⟧ → ⟦b⟧編輯附註:⟦/b⟧
3. 連結文字可翻譯,連結編號 N 不可變動。
4. 標記可巢狀(如 ⟦b⟧⟦i⟧粗斜體⟦/i⟧⟦/b⟧),翻譯後須維持結構;不可交叉(⟦b⟧⟦i⟧X⟦/b⟧⟦/i⟧ 是錯的)。
5. 若原文無標記,譯文也不要無中生有加標記。
</inline_style_markers>`;

// v1.0.2: 術語表擷取用的預設 prompt（結構化重寫，強化排除規則與輸出格式約束）
export const DEFAULT_GLOSSARY_PROMPT = `<role_definition>
你是一位專業的翻譯術語擷取助理。你的任務是從使用者提供的文章或摘要中，精準擷取需要統一翻譯的專有名詞，建立「原文 → 台灣繁體中文」的對照術語表，符合台灣在地化語境。
</role_definition>
<source_fidelity>
source 欄位必須是原文文本中「逐字出現」的字串，保持原文字系：日文原文就用日文漢字／假名（例如原文出現「相沢」，source 必須寫「相沢」，絕不可轉寫成「Aizawa」）、韓文用諺文、英文才用拉丁字母。任何羅馬拼音轉寫、英譯改寫都是嚴重錯誤——source 拿去跟原文比對，不是原文中的字串就完全失效。
</source_fidelity>
<extraction_scope>
請嚴格限制只擷取以下四類實體：
1. 人名 (person)：西方人名須轉換為台灣通行中譯（例如：Elon Musk→馬斯克、Trump→川普、Peter Hessler→何偉）。華人姓名亦須使用台灣通行譯法。日文人名的漢字須轉為台灣慣用字形（例如：相沢→相澤、斉藤→齊藤、渋谷→澀谷），假名人名用台灣通行音譯。
2. 地名 (place)：國家、城市、地理位置須採用台灣標準譯名（例如：Israel→以色列、London→倫敦、Chengdu→成都）。
3. 專業術語與新創詞 (tech)：台灣尚無廣泛通用譯名的專業詞彙、新創詞。譯名後方「必須」附加全形括號標註原文（例如：watchfluencers→錶壇網紅（watchfluencers）、algorithmic filter bubble→演算法驅動的資訊繭房（algorithmic filter bubble））。
4. 作品名 (work)：書籍、電影、歌曲等作品名稱，須使用台灣通行譯名並加上全形書名號（例如：Parasite→《寄生上流》）。無通行譯名的作品名須自行譯成台灣繁體中文（可意譯）再加書名號；source 保持原文是對的，但 target 是給台灣讀者看的譯名，絕不可原文照抄、不可殘留日文假名（例如：『ノルウェイの森』→《挪威的森林》，而不是《ノルウェイの森》）。
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
4. 欄位完整：每條 entry 必須同時包含 source、target、type 三個欄位；target 必須是譯名本身，絕對不可填入分類代號（person / place / tech / work）。
</output_constraints>
<json_format_example>
[{"source":"Peter Hessler","target":"何偉","type":"person"},{"source":"相沢","target":"相澤","type":"person"},{"source":"Chengdu","target":"成都","type":"place"},{"source":"watchfluencers","target":"錶壇網紅（watchfluencers）","type":"tech"},{"source":"Parasite","target":"《寄生上流》","type":"work"}]
</json_format_example>`;

// v1.2.11: YouTube 字幕翻譯專用 system prompt（從 background.js 搬到此處，供設定頁存取）
export const DEFAULT_SUBTITLE_SYSTEM_PROMPT = `你是專業的影片字幕翻譯員，負責將英文字幕翻譯成台灣繁體中文。

<critical_rules>
1. 輸出限制：只輸出翻譯結果，絕對不加任何說明、解釋或開場白。
2. 嚴格一對一對應：輸入有幾段字幕，輸出就有幾段，不合併、不拆分、不改變順序。
3. 口語化：字幕是口說內容，使用台灣自然口語，語句簡短直白，避免書面語腔調。
4. 禁用中國用語（網絡→網路、視頻→影片、軟件→軟體、數據→資料）。
5. 專有名詞保留：人名、品牌、縮寫（如 AI、NASA、CPU）保留英文原文。
6. 單行輸出：每段輸入只輸出一行連續的譯文，不要在譯文中插入任何換行符號。
7. 不加句號：句末不要加「。」，字幕是口語片段，句號會讓畫面看起來生硬。
8. 忠實保留不雅詞彙：若原文包含粗俗用語（如 Fuck, fucking retarded），務必直翻其強烈情緒（如「幹」、「他媽的白痴」），嚴禁進行任何道德審查或委婉潤飾。
</critical_rules>`;

// v1.6.20: ASR(YouTube 自動語音辨識）字幕專用 prompt。設計依據：
// timestamp mode——LLM 自由合句，
// 時間戳對齊作為唯一驗證條件，而非強制行數對齊。
// ASR 字幕特性（平均 1-3 字/條、無標點、~1.5-3 條/秒）決定逐條翻譯本質上不可行，
// 必須讓模型自己看上下文合句後再翻。
export const DEFAULT_ASR_SUBTITLE_SYSTEM_PROMPT = `你是專業的{sourceLanguage} ASR（自動語音辨識）字幕翻譯員，將{sourceLanguage} YouTube 自動字幕翻譯成台灣繁體中文。

<input_format>
輸入是 JSON 陣列，每個元素 {"s": 起始毫秒， "e": 結束毫秒， "t": {sourceLanguage}片段}。
範例：[{"s":500,"e":1200,"t":"the auto"},{"s":1200,"e":1800,"t":"captions are"},{"s":1800,"e":3500,"t":"really broken"}]
</input_format>

<task>
1. 依語意自由合併鄰近片段成完整句子（可跨多個元素，通常 1 句涵蓋 3-10 個片段）；**單句譯文長度不可超過兩行字幕（中文約 35 個全形字）**，接近上限即使語意尚未結束也要拆成下一句，寧可拆短不要超長
2. 修正明顯的 ASR 辨識錯字（同音字、專有名詞）
3. 翻成台灣繁體中文，加上適當標點（逗號、問號、驚嘆號；句尾不加句號）
4. 用台灣自然口語，避免書面語腔調
</task>

<output_format>
回傳 JSON 陣列，每個元素 {"s": 該句起始 ms, "e": 該句結束 ms, "t": 中文譯文}。
- s 必須等於某個輸入元素的 s
- e 必須等於某個輸入元素的 e（通常是該句最後一個片段的 e)
- 不要包 \`\`\`json fence，直接輸出純 JSON 陣列
- 不要任何解釋、開場白、後記
範例：[{"s":500,"e":3500,"t":"自動字幕真的壞了"}]
</output_format>

<critical_rules>
1. 禁用中國用語（網絡→網路、視頻→影片、軟件→軟體、數據→資料、用戶→使用者）
2. 專有名詞保留原文寫法（人名、品牌、技術縮寫如 AI、NASA、CPU 不譯成中文）
3. 忠實保留粗俗用語（Fuck → 幹），不審查、不委婉化
4. 不要遺漏輸入片段：輸出陣列加總應涵蓋所有輸入時間範圍
5. 這批輸入可能從句子中間開始、或在句子中間結束（前後還有其他批次接續）：開頭與結尾的殘句照字面翻譯即可，絕對不可為了讓句子完整而補上輸入片段裡沒有的詞語，也不可丟棄殘句
</critical_rules>`;

// v1.5.6: 禁用詞預設清單。使用者可在「術語表」分頁的「禁用詞清單」section 編輯。
// 注入時機：buildEffectiveSystemInstruction 在所有其他規則（含 fixedGlossary）之後，
// 以 <forbidden_terms_blacklist> 區塊放在最末端，讓 LLM 給予最高權重。
// 與既有「進程→線程」對照（v0.83 ~ v1.5.5）相比修正：原對映把兩個都誤翻為簡中
// （process 在台灣應為「行程」、thread 應為「執行緒」），這版分開列正確對映。
//
// 替換詞可留空（replacement: ''）：用於「單純不希望出現某詞、但提不出固定替換詞」
// 的情境（例如陳腔濫調）。留空時 buildEffectiveSystemInstruction 會把該詞列入「禁用
// （未指定替換詞）」區，請 LLM 自行改寫成自然的台灣慣用說法。
export const DEFAULT_FORBIDDEN_TERMS = [
  { forbidden: '視頻',     replacement: '影片',     note: '' },
  { forbidden: '音頻',     replacement: '音訊',     note: '' },
  { forbidden: '軟件',     replacement: '軟體',     note: '' },
  { forbidden: '程序',     replacement: '程式',     note: '指 program；若原文是 procedure/process 用「程序」屬正確' },
  { forbidden: '進程',     replacement: '行程',     note: 'process（注意：不是「線程」）' },
  { forbidden: '線程',     replacement: '執行緒',   note: 'thread' },
  { forbidden: '數據',     replacement: '資料',     note: '' },
  { forbidden: '數據庫',   replacement: '資料庫',   note: '' },
  { forbidden: '網絡',     replacement: '網路',     note: '' },
  { forbidden: '信息',     replacement: '資訊',     note: '' },
  { forbidden: '質量',     replacement: '品質',     note: '' },
  { forbidden: '用戶',     replacement: '使用者',   note: '' },
  { forbidden: '默認',     replacement: '預設',     note: '' },
  { forbidden: '創建',     replacement: '建立',     note: '' },
  { forbidden: '實現',     replacement: '實作',     note: '' },
  { forbidden: '運行',     replacement: '執行',     note: '' },
  { forbidden: '發布',     replacement: '發表',     note: '' },
  { forbidden: '屏幕',     replacement: '螢幕',     note: '' },
  { forbidden: '劍指',     replacement: '針對',     note: '' },
  { forbidden: '痛點',     replacement: '要害',     note: '' },
  { forbidden: '硬傷',     replacement: '罩門',     note: '' },
  { forbidden: '文檔',     replacement: '文件',     note: 'document（注意：「文件」在台灣指 document，「檔案」才是 file）' },
  { forbidden: '操作系統', replacement: '作業系統', note: '' },
  { forbidden: '沒有之一', replacement: '',         note: '陳腔濫調，留空替換詞由 AI 自行改寫' },
  { forbidden: '橫空出世', replacement: '',         note: '陳腔濫調，留空替換詞由 AI 自行改寫' },
];

// ── i18n:翻譯目標語言(P1 / v1.8.59)─────────────────────────────────
// targetLanguage setting 控制翻譯成什麼語言:
//   zh-TW → 走原 DEFAULT_*_PROMPT(完整台灣用語規則)
//   其他  → 走 UNIVERSAL_*_PROMPT,送 LLM 前注入 {targetLanguage} 變數
// 佔位符 / forbiddenTerms / glossary / 段內換行 / 多段分隔符規則由
// lib/system-instruction.js buildEffectiveSystemInstruction 自動 append,
// universal prompt 跟 zh-TW DEFAULT 一樣不重複這些(屬內部協定層)。

export const TARGET_LANGUAGES = ['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'es', 'fr', 'de'];

// ASR prompt 的 {sourceLanguage} 替換用 label map。Source language 由 content script
// 從 YouTube captionTracks 的 ASR track languageCode 動態推導，值是 YT 的 languageCode
// 字串（en / ja / ko / fr / de / es / pt / it / ru / zh-Hans / zh-Hant / ar / th / vi 等）。
// _ZH 版給 DEFAULT_ASR_SUBTITLE_SYSTEM_PROMPT（zh-TW target prompt 用）注入中文 label，
// _EN 版給 UNIVERSAL_ASR_SUBTITLE_SYSTEM_PROMPT 注入英文 label。未涵蓋的 lang 在
// getEffectiveAsrSubtitleSystemPrompt 中 fallback 到 languageCode 本身。
export const SOURCE_LANG_LABELS_ZH = {
  'en':      '英文',
  'ja':      '日文',
  'ko':      '韓文',
  'fr':      '法文',
  'de':      '德文',
  'es':      '西班牙文',
  'pt':      '葡萄牙文',
  'it':      '義大利文',
  'ru':      '俄文',
  'nl':      '荷蘭文',
  'pl':      '波蘭文',
  'tr':      '土耳其文',
  'ar':      '阿拉伯文',
  'th':      '泰文',
  'vi':      '越南文',
  'id':      '印尼文',
  'hi':      '印地文',
  'zh-Hans': '簡體中文',
  'zh-Hant': '繁體中文',
  'zh-HK':   '繁體中文（港式）',
};

export const SOURCE_LANG_LABELS_EN = {
  'en':      'English',
  'ja':      'Japanese',
  'ko':      'Korean',
  'fr':      'French',
  'de':      'German',
  'es':      'Spanish',
  'pt':      'Portuguese',
  'it':      'Italian',
  'ru':      'Russian',
  'nl':      'Dutch',
  'pl':      'Polish',
  'tr':      'Turkish',
  'ar':      'Arabic',
  'th':      'Thai',
  'vi':      'Vietnamese',
  'id':      'Indonesian',
  'hi':      'Hindi',
  'zh-Hans': 'Simplified Chinese',
  'zh-Hant': 'Traditional Chinese',
  'zh-HK':   'Traditional Chinese (Hong Kong)',
};

// P3 (v1.8.62):介面語言(UI dict)獨立設定,跟翻譯目標(targetLanguage)解綁。
// 'auto'(預設)= 由 resolveUiLanguage(navigator.language) 推導為 8 語其一;
// 使用者可在 Options 強制鎖到任一支援語言。8 語 dict 全到位後,fallback 到 en 僅在
// navigator.language 未命中任何已知語族時觸發。
export const UI_LANGUAGES = ['auto', 'zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'es', 'fr', 'de'];

// 送進 universal prompt 的 {targetLanguage} 字串。
// zh-CN 明確標 "China conventions" 讓 LLM 用簡中中國用詞,避免混到台灣用詞;label 內附帶的
// 中文字串本身用簡體(中国用语),避免「告訴 LLM 用簡體但 label 自己是繁體」自相矛盾。
// 其他 target 的 label 同款附帶該語言寫的 native form,讓 LLM 多一個 target-language 信號。
export const LANG_LABELS = {
  'zh-TW': 'Traditional Chinese (Taiwan conventions)',  // 不會用到(zh-TW 走原 prompt)
  'zh-CN': 'Simplified Chinese (China conventions, 中国用语)',
  'en':    'English',
  'ja':    'Japanese (日本語)',
  'ko':    'Korean (한국어)',
  'es':    'Spanish (español)',
  'fr':    'French (français)',
  'de':    'German (Deutsch)',
};

export const UNIVERSAL_SYSTEM_PROMPT = `<role_definition>
You are a professional translator. Translate web text into {targetLanguage} accurately and naturally.
</role_definition>

<rules>
1. Output translation only. Do not output your thinking, prefaces, or explanations.
2. Translate, do not interpret. Keep the original meaning.
3. Keep proper nouns, brand names, URLs, code identifiers, and inline code untranslated.
4. Preserve all inline markdown / HTML structure exactly:
   **bold** stays **bold**, [text](url) keeps its link, <strong> / <em> / <code> tags unchanged.
   Only translate the visible natural-language text inside the structure.
5. Follow {targetLanguage} punctuation and spacing conventions. Do not carry over
   source-language typographic spacing (e.g. the Japanese habit of a space after ？/！)
   unless it is also conventional in {targetLanguage}.
6. Mirror the source's sentence-final punctuation: if the source sentence, quoted line,
   or heading ends without a sentence-final mark, do not add one in the translation.
</rules>`;

export const UNIVERSAL_DOC_SYSTEM_PROMPT = UNIVERSAL_SYSTEM_PROMPT + DOC_NUMBER_FIDELITY_EN;

export const UNIVERSAL_GLOSSARY_PROMPT = `<role_definition>
You are a glossary extraction assistant for translating into {targetLanguage}.
</role_definition>
<source_fidelity>
The "source" field must be the exact string as it appears verbatim in the original text, in its original script (e.g. Japanese kanji/kana for a Japanese text, Hangul for Korean). Never romanize, transliterate, or translate the source — a source string that does not literally appear in the original text is a critical error, because it is matched against the original text.
</source_fidelity>
<extraction_scope>
Extract only these four entity types:
1. Person names — proper-noun translations into {targetLanguage}.
2. Place names — countries, cities, regions, in {targetLanguage} convention.
3. Technical terms / coined words — terms without an established {targetLanguage} translation.
   Append the original in parentheses on first appearance.
4. Work titles — books, films, songs; use the established {targetLanguage} convention if available. If none exists, translate the title into {targetLanguage} yourself; never leave the original title untranslated as the target.
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
3. Every entry must include all three fields source / target / type; the target must be the translated name itself, never a category token (person / place / tech / work).
</output_constraints>
<json_format_example>
[{"source":"Peter Hessler","target":"<translated>","type":"person"},{"source":"相沢","target":"<translated>","type":"person"},{"source":"Chengdu","target":"<translated>","type":"place"}]
</json_format_example>`;

export const UNIVERSAL_SUBTITLE_SYSTEM_PROMPT = `You are a professional video subtitle translator translating into {targetLanguage}.

<critical_rules>
1. Output translation only. No prefaces, no explanations.
2. Strict 1-to-1: N input segments → exactly N output segments. Do not merge, split, or reorder.
3. Spoken style: subtitles are speech. Use natural conversational language, short and direct, avoid formal written prose.
4. Keep proper nouns (person names, brands, abbreviations like AI / NASA / CPU) in the original.
5. Single line per segment: do not insert line breaks within a translation.
6. Do not add a trailing period — subtitles read better without one.
</critical_rules>`;

export const UNIVERSAL_ASR_SUBTITLE_SYSTEM_PROMPT = `You are translating {sourceLanguage} ASR (auto-generated) subtitles into {targetLanguage}.

<input_format>
JSON array. Each element {"s": startMs, "e": endMs, "t": "{sourceLanguage} fragment"}.
Example: [{"s":500,"e":1200,"t":"the auto"},{"s":1200,"e":1800,"t":"captions are"}]
</input_format>

<task>
1. Freely merge adjacent fragments into complete sentences (typically 3-10 fragments per sentence); **a single output sentence must not exceed two subtitle lines (~35 CJK characters or ~80 Latin characters in the target language)**. As soon as that cap is reached, split into the next sentence even if the clause is not finished — prefer shorter over overlength.
2. Silently fix obvious ASR errors (homophones, mis-recognized proper nouns).
3. Translate into {targetLanguage} with appropriate punctuation (commas, question marks; no trailing period).
4. Use natural spoken language, avoid formal written prose.
5. This batch may start or end mid-sentence (adjacent batches continue it). Translate leading/trailing fragments literally as they are; never add words that are not in the input to complete a sentence, and never drop those fragments.
</task>

<output_format>
Return a JSON array. Each element {"s": startMs, "e": endMs, "t": "translation"}.
- s must equal some input element's s
- e must equal some input element's e (typically the last fragment's e in that sentence)
- Output pure JSON only. No code fence. No prefaces, no postscripts.
</output_format>`;

// 預設 target 推導(navigator.language)。Q3 拍板:
//   zh-TW / zh-Hant / zh-HK    → zh-TW(同繁體圈,zh-HK 雖港式詞彙不同但比 zh-CN/en 接近)
//   其他 zh-*(zh-CN/zh-Hans/zh-SG)→ zh-CN
//   ja / ko / es / fr / de prefix → 對應 target
//   其他                          → en
export function detectDefaultTargetLanguage() {
  const nav = ((typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase();
  if (nav.startsWith('zh-tw') || nav.startsWith('zh-hant') || nav.startsWith('zh-hk')) return 'zh-TW';
  if (nav.startsWith('zh')) return 'zh-CN';
  if (nav.startsWith('ja')) return 'ja';
  if (nav.startsWith('ko')) return 'ko';
  if (nav.startsWith('es')) return 'es';
  if (nav.startsWith('fr')) return 'fr';
  if (nav.startsWith('de')) return 'de';
  return 'en';
}

// P3 (v1.8.62):把 UI 語系偏好(可能 'auto' / 8 語其一)解析為實際 dict 用的 8 語之一。
// 'auto' / 'undefined' / 不認識值 → 由 navigator.language 推導(zh-TW 系 → zh-TW、其他 zh-* → zh-CN、
// ja/ko/es/fr/de → 對應、其他 → en)。
export function resolveUiLanguage(uiLanguagePref) {
  if (uiLanguagePref && uiLanguagePref !== 'auto'
      && ['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'es', 'fr', 'de'].includes(uiLanguagePref)) {
    return uiLanguagePref;
  }
  const nav = ((typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase();
  if (nav.startsWith('zh-tw') || nav.startsWith('zh-hant') || nav.startsWith('zh-hk')) return 'zh-TW';
  if (nav.startsWith('zh')) return 'zh-CN';
  if (nav.startsWith('ja')) return 'ja';
  if (nav.startsWith('ko')) return 'ko';
  if (nav.startsWith('es')) return 'es';
  if (nav.startsWith('fr')) return 'fr';
  if (nav.startsWith('de')) return 'de';
  return 'en';
}

// v2.0.78（批次 4 F1）：區塊 strip 規則必須錨定「預設字面值」，不可用 [\s\S]*? 吞任意
// 內容——舊寫法會把使用者「只客製區塊內文」的 prompt 也 strip 掉，saved 與 default
// normalize 後相等 → 誤判未客製 → runtime 改吃預設 prompt，客製內容靜默失效。
// 字面值直接從 prompt 常數抽（單一資料源；日後改區塊內文時，舊字面值要照 §7.5 慣例
// 另加 rule strip，不可回頭改寬這裡）。
const _escapeForRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const _PROMPT_DEFAULT_BLOCK_STRIP_RES = [
  // <source_fidelity>（DEFAULT_GLOSSARY_PROMPT 繁中版 + UNIVERSAL 英文版；區塊內
  // 不含 {targetLanguage} placeholder，字面抽取即可）
  ...[DEFAULT_GLOSSARY_PROMPT, UNIVERSAL_GLOSSARY_PROMPT]
    .map((p) => (p.match(/<source_fidelity>[\s\S]*?<\/source_fidelity>\n/) || [])[0])
    .filter(Boolean),
  // <document_number_fidelity>（ZH / EN 兩版常數本體，含開頭的空行）
  DOC_NUMBER_FIDELITY_ZH,
  DOC_NUMBER_FIDELITY_EN,
].map((lit) => new RegExp(_escapeForRegExp(lit), 'g'));

// P1: 對歷史 prompt 字面值的小幅修字做 normalize,讓既有使用者升級後 saved 仍能被
// 視為「未客製」。每次大幅改 DEFAULT_*_PROMPT 內容時(例如 v1.8.59 把「中國大陸」改成
// 「中國」對齊全域用語規範),在這裡加 rule;不寫 storage migration(零寫入,零風險)。
function _normalizePromptForComparison(s) {
  // 區塊 strip（錨定預設字面值，見上方 F1 註解）
  let out = (s || '');
  for (const re of _PROMPT_DEFAULT_BLOCK_STRIP_RES) out = out.replace(re, '');
  s = out;
  return (s || '')
    // v1.8.59:DEFAULT_SYSTEM_PROMPT / SUBTITLE / ASR_SUBTITLE / GLOSSARY 內
    // 「中國大陸用語/譯法/特有用語」改成「中國用語/譯法/特有用語」(全域用語規範)。
    // 既有使用者 saved 仍是舊版「中國大陸」字面值,normalize 後等於當前 DEFAULT。
    .replace(/中國大陸/g, '中國')
    // v2.0.52:GLOSSARY prompt 修「日文書 source 被轉寫成羅馬拼音」——role 改寫 +
    // 新增 <source_fidelity> 區塊 + 日文人名字形規則 + 日文 JSON 範例;同輪追加
    // 「無通行譯名作品名須自行譯出」與「target 不可填分類代號」規則。
    // 以下 rules 把新增段落 strip 掉、舊措辭映射到新措辭,讓舊 saved 字面值
    // normalize 後仍等於當前 DEFAULT / UNIVERSAL(視為未客製,自動吃新 prompt)。
    .replace(/建立符合台灣在地化語境的英中對照術語表/g, '建立「原文 → 台灣繁體中文」的對照術語表，符合台灣在地化語境')
    .replace(/日文人名的漢字須轉為台灣慣用字形（例如：相沢→相澤、斉藤→齊藤、渋谷→澀谷），假名人名用台灣通行音譯。/g, '')
    .replace(/\{"source":"相沢","target":"(?:相澤|<translated>)","type":"person"\},/g, '')
    .replace(/無通行譯名的作品名須自行譯成台灣繁體中文（可意譯）再加書名號；source 保持原文是對的，但 target 是給台灣讀者看的譯名，絕不可原文照抄、不可殘留日文假名（例如：『ノルウェイの森』→《挪威的森林》，而不是《ノルウェイの森》）。/g, '')
    .replace(/\n4\. 欄位完整：每條 entry 必須同時包含 source、target、type 三個欄位；target 必須是譯名本身，絕對不可填入分類代號（person \/ place \/ tech \/ work）。/g, '')
    .replace(/ If none exists, translate the title into [^\n]*? yourself; never leave the original title untranslated as the target\./g, '')
    .replace(/\n3\. Every entry must include all three fields source \/ target \/ type; the target must be the translated name itself, never a category token \(person \/ place \/ tech \/ work\)\./g, '')
    // v2.0.53:SYSTEM / DOC prompt 排版規則擴充——規則 1 插入「日文 ？！ 後空格移除」
    // 說明句 + 新增規則 6「忠於原文的句尾標點」;UNIVERSAL 版對應新增 rule 5 / 6。
    // strip 新增段落,讓舊 saved 字面值 normalize 後仍等於當前 DEFAULT / UNIVERSAL
    // (視為未客製,runtime 自動吃新 prompt,不需使用者手動更新)。
    .replace(/特別注意：日文等原文在「？」「！」後接空格再起句是原文的排版慣例，翻譯成中文時必須移除這些空格，不可帶進譯文。/g, '')
    .replace(/\n6\. 忠於原文的句尾標點：原文句尾沒有終止標點時（日文小說的「」內對白慣例、標題、詩句等），譯文句尾也不可自行補上句號。原文的輕收節奏是作者的選擇，必須保留。/g, '')
    // UNIVERSAL 版 rule 5 內含 {targetLanguage} 注入後的語言 label(單行任意字串),
    // 比照上方 glossary rule 先例用 [^\n]* 容忍
    .replace(/\n5\. Follow [^\n]* punctuation and spacing conventions\. Do not carry over\n   source-language typographic spacing \(e\.g\. the Japanese habit of a space after ？\/！\)\n   unless it is also conventional in [^\n]*\.\n6\. Mirror the source's sentence-final punctuation: if the source sentence, quoted line,\n   or heading ends without a sentence-final mark, do not add one in the translation\./g, '')
    // v2.0.75:SYSTEM / DOC prompt 兩處擴充——(a) 通行譯名規則補「不確定保留原文,
    // 嚴禁自創猜測」guard(修 lite 模型對台灣公司名的幻覺譯名);(b) DOC prompt 新增
    // <document_number_fidelity> 區塊(文件金額 / 表格數值逐字保留,修報價單千分位
    // 被散文數字規則移除)。strip 新增內容,舊 saved 字面值視為未客製自動吃新 prompt
    .replace(/沒有可靠通行譯名或不確定時，一律保留原文，嚴禁自創、猜測或音譯譯名（例如不確定某公司的中文名稱時，保留其英文名）。/g, '')
    .trim();
}

// 給 options.js 用的「是否視為未客製」判定 helper(避免 options.js 重複實作 normalize 邏輯,
// 確保未來改 normalize rule 兩端同步演進)。
export function isPromptUnchangedFromDefault(saved, defaultPrompt) {
  if (!saved || !saved.trim()) return true;
  return _normalizePromptForComparison(saved) === _normalizePromptForComparison(defaultPrompt);
}

// v1.10.46:options.js prompt textarea 同步用的「等於任一 target effective default 即未客製」
// 判定,原本寫在 options.js _syncPromptTextareaToTarget,下沉到這裡跟 _isAnyTargetDefault
// 同檔維護(單一資料源)。getEffectiveFn 傳 getEffectiveSystemPrompt 等 factory。
export function isPromptUnchangedFromAnyTargetDefault(saved, getEffectiveFn) {
  if (!saved || !saved.trim()) return true;
  return TARGET_LANGUAGES.some((t) => isPromptUnchangedFromDefault(saved, getEffectiveFn(t, '')));
}

// P1 (v1.8.59) hotfix:用 target language 寫的「task reinforcement」,append 到 universal
// prompt 末尾。對應 Gemini Flash 已知 issue:「英文 prompt 內 append target language 命令」
// 對短輸入服從度不穩(內文 batch 對,但短標題 LLM 自由發揮 echo 原文)。研究結論是
// 「用 target language 寫 task instruction」最可靠,我們在 prompt 末尾用 target language 寫
// 一條平實的 task reinforcement,double-tap 提高 LLM 服從度。不用 ALL CAPS / ALWAYS / NEVER。
// 只對 SYSTEM 跟 DOC 主翻譯路徑套用(GLOSSARY 走 JSON 嚴格輸出、SUBTITLE / ASR 對段對齊
// 要求高,加 reinforcement 怕干擾原任務指示)。
const TARGET_LANGUAGE_REINFORCEMENT = {
  'zh-CN': '请将输入文本翻译成简体中文。无论原文是什么语言,输出文本都应该是简体中文,使用中国地区的用词习惯。',
  'en':    'Translate the input text into English. The output should be in English, regardless of the source language.',
  'ja':    '入力テキストを日本語に翻訳してください。原文がどの言語であっても、出力は日本語で書かれるべきです。',
  'ko':    '입력 텍스트를 한국어로 번역하세요. 원문이 어떤 언어이든, 출력은 한국어로 작성되어야 합니다.',
  'es':    'Traduzca el texto de entrada al español. La salida debe estar en español, independientemente del idioma de origen.',
  'fr':    'Traduisez le texte d\'entrée en français. La sortie doit être en français, quelle que soit la langue source.',
  'de':    'Übersetzen Sie den Eingabetext ins Deutsche. Die Ausgabe muss auf Deutsch sein, unabhängig von der Quellsprache.',
};

function _appendReinforcement(prompt, targetLang, userOverride, defaultPrompt, universalTemplate) {
  // 只對「未客製 + 非 zh-TW target」append:
  //   客製化 prompt 不動(尊重使用者改的版本);zh-TW 走原 DEFAULT 已含完整繁中規則。
  if (targetLang === 'zh-TW') return prompt;
  if (!_isAnyTargetDefault(userOverride, defaultPrompt, universalTemplate)) return prompt;
  const r = TARGET_LANGUAGE_REINFORCEMENT[targetLang];
  return r ? `${prompt}\n\n${r}` : prompt;
}

// v1.10.46:「未客製」判定擴大為「等於任一 target 的 effective default」(單一資料源,
// 原邏輯在 options.js _syncPromptTextareaToTarget 的 TARGET_LANGUAGES.some,下沉到這裡)。
// Why:options.js 儲存設定時把 textarea 字面值(= 當前 target 注入語言 label 後的 universal
// prompt,SYSTEM/DOC 還含 reinforcement 尾段)寫進 storage——只比對 zh-TW DEFAULT 會把這種
// saved 誤判成「使用者客製」,之後切 target 永遠翻成舊語言(直到重開 options 再存)。
function _isAnyTargetDefault(userOverride, defaultPrompt, universalTemplate) {
  if (isPromptUnchangedFromDefault(userOverride, defaultPrompt)) return true;
  const norm = _normalizePromptForComparison(userOverride);
  for (const t of TARGET_LANGUAGES) {
    if (t === 'zh-TW') continue;  // zh-TW 走 defaultPrompt,上面比過了
    const candidate = universalTemplate.replaceAll('{targetLanguage}', LANG_LABELS[t] || LANG_LABELS.en);
    if (norm === _normalizePromptForComparison(candidate)) return true;
    // SYSTEM / DOC 的 effective default 末尾還有 target language reinforcement,一併比對
    const r = TARGET_LANGUAGE_REINFORCEMENT[t];
    if (r && norm === _normalizePromptForComparison(`${candidate}\n\n${r}`)) return true;
  }
  return false;
}

// effective prompt factory:
//   userOverride 為空 / normalize 後等於任一 target 的 effective default → 視為「未客製化」,
//   走 target 對應預設;否則直接用 saved(尊重使用者客製化)
// 這個設計自動處理舊使用者升級——saved 經 normalize 後等於當前 DEFAULT_*_PROMPT 視為未客製,
// target 切換立刻反映,不需 storage 層 migration(零寫入,零風險)。
function _buildEffective(targetLang, userOverride, defaultPrompt, universalTemplate) {
  const treatedAsUnchanged = _isAnyTargetDefault(userOverride, defaultPrompt, universalTemplate);
  if (treatedAsUnchanged) {
    if (targetLang === 'zh-TW') return defaultPrompt;
    // replaceAll(不是 replace)── universal prompt 內可能含多個 {targetLanguage} 占位
    // (例如 UNIVERSAL_GLOSSARY_PROMPT 的 extraction_scope 4 條規則各提一次)
    return universalTemplate.replaceAll('{targetLanguage}', LANG_LABELS[targetLang] || LANG_LABELS.en);
  }
  return userOverride;
}

export function getEffectiveSystemPrompt(targetLang, userOverride) {
  const prompt = _buildEffective(targetLang, userOverride, DEFAULT_SYSTEM_PROMPT, UNIVERSAL_SYSTEM_PROMPT);
  return _appendReinforcement(prompt, targetLang, userOverride, DEFAULT_SYSTEM_PROMPT, UNIVERSAL_SYSTEM_PROMPT);
}
export function getEffectiveDocSystemPrompt(targetLang, userOverride) {
  const prompt = _buildEffective(targetLang, userOverride, DEFAULT_DOC_SYSTEM_PROMPT, UNIVERSAL_DOC_SYSTEM_PROMPT);
  return _appendReinforcement(prompt, targetLang, userOverride, DEFAULT_DOC_SYSTEM_PROMPT, UNIVERSAL_DOC_SYSTEM_PROMPT);
}
export function getEffectiveGlossaryPrompt(targetLang, userOverride) {
  return _buildEffective(targetLang, userOverride, DEFAULT_GLOSSARY_PROMPT, UNIVERSAL_GLOSSARY_PROMPT);
}
export function getEffectiveSubtitleSystemPrompt(targetLang, userOverride) {
  return _buildEffective(targetLang, userOverride, DEFAULT_SUBTITLE_SYSTEM_PROMPT, UNIVERSAL_SUBTITLE_SYSTEM_PROMPT);
}
export function getEffectiveAsrSubtitleSystemPrompt(targetLang, sourceLang = 'en') {
  // ASR 沒有 user override 路徑(background.js 寫死走預設),userOverride 永遠 ''
  const base = _buildEffective(targetLang, '', DEFAULT_ASR_SUBTITLE_SYSTEM_PROMPT, UNIVERSAL_ASR_SUBTITLE_SYSTEM_PROMPT);
  // zh-TW target 走 DEFAULT(中文 prompt)用 _ZH label;其他 target 走 UNIVERSAL(英文 prompt)用 _EN label。
  // 未涵蓋的 lang fallback 到 languageCode 字串本身(讓 LLM 自己解讀,不至於拋錯)。
  const labelMap = (targetLang === 'zh-TW') ? SOURCE_LANG_LABELS_ZH : SOURCE_LANG_LABELS_EN;
  const label = labelMap[sourceLang] || sourceLang;
  return base.replaceAll('{sourceLanguage}', label);
}

export const DEFAULT_SETTINGS = {
  apiKey: '',
  // P1 (v1.8.59):翻譯目標語言。預設依 navigator.language 推導(detectDefaultTargetLanguage)。
  // 既有使用者升級後 saved 沒此 key,getSettings 會自動 detect 一次當預設,不寫回 storage。
  targetLanguage: detectDefaultTargetLanguage(),
  // P2 (v1.8.60):UI 語系偏好。'auto' = 跟 chrome 瀏覽器語系(navigator.language);
  // 使用者可選 zh-TW / zh-CN / en 強制鎖。預設 'auto' 不寫 storage(getSettings 走 default)。
  uiLanguage: 'auto',
  geminiConfig: {
    model: 'gemini-3.1-flash-lite',        // 預設模型 = Gemini 3.1 Flash Lite（省成本，與主要預設 slot 2 一致）
    serviceTier: 'DEFAULT',
    // v1.10.18:Gemini 3 官方強烈建議維持 temperature=1.0,設低於 1.0 可能引發
    // 無限思考迴圈 / 推理退化(舊世代「降溫求穩定」思維對 Gemini 3 失效)。
    temperature: 1.0,
    // topP / topK:v1.10.19 起 options UI 已移除(Gemini 3 不使用 top-k sampling、官方
    // 建議勿設,lib/gemini.js buildSamplingFields() 對 Gemini 3 一律略過不送)。此處欄位
    // 保留供「非 Gemini 3 模型」fallback 用(buildSamplingFields 非 G3 才帶),避免 migration;
    // 使用者不再能編輯,options 儲存時從 storage 拉現存值寫回。
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
    systemInstruction: DEFAULT_SYSTEM_PROMPT,
  },
  // 計價設定（USD per 1M tokens)。預設值為 gemini-3.1-flash-lite 的官方報價，
  // 使用者換模型時請自行至設定頁調整。
  // v1.9.2:cachedDiscount(0-1,cache 命中省下的比例)。Gemini 2.5+ 起 90% off → 0.90。
  pricing: {
    inputPerMTok: 0.25,
    outputPerMTok: 1.50,
    cachedDiscount: 0.90,
  },
  // v0.69: 全文術語表一致化設定
  glossary: {
    enabled: false,
    prompt: DEFAULT_GLOSSARY_PROMPT,
    // v1.10.18:從 0.1 改 1.0。glossary 跑在 Gemini 3 模型(預設 gemini-3.1-flash-lite),
    // 官方明載 Gemini 3 設 temperature<1.0 可能引發迴圈 / 退化——對「結構化 JSON + 推理」
    // 的術語抽取尤其危險,且迴圈會狂燒被計費的思考 token。維持 1.0 是 Gemini 3 正解。
    temperature: 1.0,
    skipThreshold: 1,                  // ≤ 此批次數完全不建術語表
    // v1.7.3: 預設從 5 提高到 10 — 中等長度頁面（6-10 批）走 fire-and-forget 不阻塞，
    // 省下 EXTRACT_GLOSSARY 1.5-7.4 秒 blocking 等待；短頁本就跳過、長頁（>10 批）
    // 仍 blocking 確保跨批次術語一致。使用者可在設定頁 0（永遠 fire-and-forget)
    // ~ 50（極長頁才 blocking）區間調整。
    blockingThreshold: 10,             // > 此批次數則阻塞等術語表回來再翻譯
    timeoutMs: 60000,                  // 術語表請求逾時（毫秒），超過則 fallback（v0.70: 60s）
    maxTerms: 200,                     // 術語表上限條目數
    // v1.7.2: 術語表獨立模型。空字串表示「跟主翻譯同一個 model」（舊行為）;
    // 預設 'gemini-3.1-flash-lite' — 術語抽取任務簡單，Flash Lite 比 Flash 快
    // 1.5-3 倍且便宜 5 倍。實測啟用 glossary 時 EXTRACT_GLOSSARY 用 Flash 耗時
    // 1.5-7.4 秒，改用 Flash Lite 預期可壓到 0.5-2.5 秒。
    model: 'gemini-3.1-flash-lite',
  },
  domainRules: { whitelist: [] },
  autoTranslate: false,
  // 簡繁自動互轉:開啟後 target 為 zh-TW / zh-CN 時,偵測為相反中文變體的頁面
  // 於載入 / SPA 導航自動走 OpenCC 本地轉換(免費、不打 API)。popup toggle 控制
  autoConvertZh: false,
  debugLog: false,
  // W7:文件翻譯設定 group。獨立 settings page (translate-doc/settings.html)
  // 編輯。為將來擴充各 Office 格式(.docx / .xlsx / .pptx)做好結構 — systemPrompt
  // 通用(inline marker 協定相同),格式特別設定未來加 translateDoc.docx / .xlsx
  // sub-key,不影響 systemPrompt 共用。改變 systemPrompt 會影響譯文 cache key sha1。
  translateDoc: {
    systemPrompt: DEFAULT_DOC_SYSTEM_PROMPT,
    // v2.0.11：文件翻譯每批段數（1-100）。電子書段落多，20 段太保守——請求數
    // 與 prompt 開銷都高；預設 50。只影響文件翻譯路徑（payload.docBatchSize
    // → handleTranslate 覆蓋 maxUnitsPerBatch)，網頁 / 字幕翻譯不受影響
    batchSize: 50,
    applyGlossary: false, // 預設術語表一致化(stage-result modal 內每次仍可 override)
    // 獨立 temperature,跟主 geminiConfig.temperature 區隔。
    // v1.10.18:從 0.5 改 1.0。文件翻譯也跑在 Gemini 3 模型,官方建議維持 1.0(設低於
    // 1.0 可能引發迴圈 / 推理退化);舊註解「0.5 偏保守求穩定」是 Gemini 3 失效的舊思維。
    // 改變後 cache key 跟著變(suffix _t<temp>),舊 0.5 快取不命中、新譯文走 1.0,不主動清。
    temperature: 1.0,
    // v1.8.49: 是否套用使用者級「固定術語表」(settings.fixedGlossary.global) 到文件翻譯。
    // 跟主功能共用同一份術語表(術語表分頁編輯),這裡只是「文件翻譯路徑要不要套用」開關。
    // 預設 true(沿用 v1.8.48 之前的隱含行為——TRANSLATE_DOC_BATCH 走 handleTranslate
    // 預設帶 applyFixedGlossary=true)。關掉後 cache key 會因 fixedGlossary entries 從 prompt
    // 移除而換新 hash,不主動清舊快取,使用者可在「進階設定 → 清除所有文件翻譯記憶」手動清。
    applyFixedGlossary: true,
  },
  // v1.2.11: YouTube 字幕翻譯設定
  ytSubtitle: {
    autoTranslate: true,         // 偵測到 YouTube 影片時自動翻譯字幕
    temperature:   1,             // 字幕翻譯 temperature 預設值
    systemPrompt:  DEFAULT_SUBTITLE_SYSTEM_PROMPT,
    windowSizeS:   30,           // 每批翻譯涵蓋的秒數（預設 30 秒）
    lookaheadS:    10,           // 在字幕快用完前幾秒觸發下一批（預設 10 秒）
    debugToast:    false,        // v1.2.14: 顯示字幕翻譯即時狀態面板（debug 用）
    onTheFly:      false,        // v1.2.49: cache miss 時是否送 on-the-fly API 翻譯（預設關閉）
    // preserveLineBreaks 已於 v1.2.38 移除 toggle，改為永遠 true（content-youtube.js 硬編碼）
    // v1.4.0: 字幕翻譯引擎——'gemini'（預設）或 'google'（Google Translate 免費端點）
    engine: 'gemini',
    // v1.2.39: 獨立模型設定——空字串表示與主模型相同
    model: '',
    // v1.2.39: 獨立計價——null 表示與主模型計價相同；設定後用於字幕費用計算
    pricing: null,
    // v1.5.8: 字幕路徑「是否套用固定術語表 / 中國用語黑名單」。預設 false 省 token——
    // 字幕本來就走獨立 prompt 設計，且字幕短句 LLM 不太會誤翻黑名單詞，套用收益小、
    // 而每批 prompt 多 300–500 token 的開銷在高頻字幕場景累積可觀。
    applyFixedGlossary: false,
    applyForbiddenTerms: false,
    // v1.6.20: ASR(YouTube 自動字幕）分句模式。內部三值，UI 簡化為單一 toggle(v1.6.23):
    //   'heuristic'   = 預設分句：純 client-side 啟發式，延遲最低（~1-2s)。toggle 關閉時用。
    //   'progressive' = 混合模式（預設）：先 heuristic 顯示（秒出），同時 LLM 跑覆蓋成更精緻版本。
    //                   兼顧速度與品質。toggle 開啟時用（預設）。
    //   'llm'         = 純 LLM 自由分句（內部保留，UI 不再可選）。
    asrMode: 'progressive',
    // commit 5c：雙語對照模式。預設 false=純中文（YouTube 既有行為：CSS 隱藏原生 CC;
    // Drive 透過 postMessage unloadModule 關 player CC)。true=中英對照（原生 CC + 中文 overlay)
    bilingualMode: false,
    // 影片載入時依優先序自動選 caption track:
    //   1) target lang native（任 kind）→ 不啟動 Shinkansen 翻譯，讓 YT 自己顯示
    //   2) 影片原始語 manual track（kind=''）→ setOption 切到此 track 再翻譯
    //   3) 影片原始語 ASR track（kind='asr'）→ setOption 切到此 track 再翻譯
    //   都沒命中 → 留 YT 既有行為（可能 YT 自翻譯軌）
    // 主要解 YT 帳號 auto-translate 偏好被套用到所有影片時，Shinkansen 拿到的是 YT 已翻譯後的
    // 字幕 text 而非原始 ASR，導致 prompt mismatch + timing 提前等下游問題。
    preferOriginalTrack: true,
    // YouTube 字幕字級 scale（%,全平台統一）。一個值套兩條渲染路徑：桌面／macOS／iOS 視窗內
    // 的 overlay（原生字級 × scale/100）+ iPhone／iPad 原生全螢幕的 video::cue font-size。
    // 預設 100 = 跟隨各平台原生字幕大小（桌面零改變）。設定在 popup,只在 YouTube 影片頁顯示。
    captionScale: 100,
  },
  // 失敗重試次數(429 / 網路錯誤時 fetchWithRetry 的退避重試上限)
  maxRetries: 3,
  // 每個 tab 同時最多飛出幾個翻譯批次(content.js 側的並發上限)。
  // v1.9.27: 10 → 30。付費層 Gemini 下 30 並行 safe;免費層使用者遇 429 可在
  // options 降到 5-10。長頁(段落數 > 10)初翻 latency 明顯下降。
  maxConcurrentBatches: 30,
  // v1.0.2: 每批段數上限與字元預算，使用者可在設定頁自行調整。
  // 段數上限：避免單批 placeholder slot 過多導致 LLM 對齊失準。
  // 字元預算：作為 token proxy（3500 chars ≈ 1000 英文 tokens），留足 output headroom。
  maxUnitsPerBatch: DEFAULT_UNITS_PER_BATCH,
  maxCharsPerBatch: DEFAULT_CHARS_PER_BATCH,
  // v1.0.1: 單頁翻譯段落數上限。超大頁面（如維基百科長條目）超過此上限時截斷。
  // 設為 0 表示不限制。
  maxTranslateUnits: 1000,
  // v1.8.3:「只翻文章開頭」節省模式。enabled=true 時只翻 batch 0（經 prioritizeUnits
  // 推前的文章開頭 N 段），跳過 batch 1+，大幅減少 token 用量。使用者想看完整翻譯時
  // 關閉此選項並重新翻譯，前面已翻好的段落會從本地快取自動命中（不重複收費）。
  // maxUnits 範圍 5-50;chars 限制走內部 BATCH0_CHARS=3700 不暴露給使用者。
  partialMode: {
    enabled: false,
    maxUnits: 25,
  },
  // v1.0.17: Toast 透明度（0.1–1.0），讓使用者在無限捲動網站上降低 toast 干擾
  toastOpacity: 0.7,
  // v1.1.3: Toast 自動關閉——翻譯完成/錯誤等 toast 在數秒後自動消失。
  // 預設開啟。關閉時翻譯完成 toast 需手動點 × 或點擊外部區域才會消失。
  toastAutoHide: true,
  // v1.6.8: 是否顯示翻譯進度通知（toast 系統 master switch）。
  // 預設 true 維持現有行為。false 時 SK.showToast() 入口直接 return：
  // 不建 DOM、不開 Shadow root、不發訊息（與單純調 opacity=0 不同——後者仍會渲染）。
  // 使用情境：使用者翻譯流量大、不在乎個別頁面進度，希望全靜音。
  showProgressToast: true,
  // v1.5.0: 顯示模式（'single' 覆蓋 / 'dual' 雙語對照），由 popup toggle 切換。
  // 'single' 沿用 v1.4 之前所有路徑，'dual' 走 content-inject.js 的 injectDual。
  displayMode: 'single',
  // v1.8.41：金額顯示幣值（'USD' / 'TWD')。預設 TWD 因為使用者是台灣使用者，
  // 看 NT$ 比 USD 直覺。內部所有計價、cost 累積、costUSD 欄位仍以 USD 為基準，
  // 只在 surface(toast / popup / options 用量紀錄）輸出時用 lib/format.js 的
  // formatMoney 套上 displayCurrency + cached rate 換算。
  // 匯率來源見 lib/exchange-rate.js（open.er-api.com daily fetch + fallback 31.6）。
  displayCurrency: 'TWD',
  // v1.5.0: 雙語模式下的視覺標記樣式（'tint' 淡底色 / 'bar' 左邊細條 / 'dashed' 波浪底線 / 'none'）
  translationMarkStyle: 'tint',
  // v1.8.52: 雙語模式譯文強調色。'auto' = 維持各 mark 預設配色（tint 米黃、bar/dashed 灰）;
  // 預設色 token = ['blue','green','yellow','orange','red','purple','pink'] 任一,三種 mark 共用同色;
  // 自訂 hex = #RRGGBB(6 碼,大小寫不拘）。其他值會在 content-script 端 fallback 回 'auto'。
  // 同色經 alpha 套到 tint(深淺底色），原色套到 bar(實心邊條）與 dashed(波浪底線）。
  dualAccentColor: 'auto',
  // v1.4.12: 三組翻譯預設對應 Alt+A / Alt+S / Alt+D 三個快速鍵。
  // engine='gemini' 時 model 覆蓋 geminiConfig.model，其他欄位（prompt、temperature、glossary）沿用全域；
  // engine='google' 時走 Google Translate 路徑，不需 model。
  // label 顯示於 options 頁（未來 toast 也可用）。
  // 行為：閒置按 → 啟動對應 preset；翻譯中按 → abort；已翻譯按任意 → restorePage。
  translatePresets: [
    { slot: 1, engine: 'gemini', model: 'gemini-3-flash-preview', label: 'Flash' },
    { slot: 2, engine: 'gemini', model: 'gemini-3.1-flash-lite', label: 'Flash Lite' },
    { slot: 3, engine: 'google', model: null, label: 'Google MT' },
  ],
  // 自訂快速鍵：三組 preset 各自的使用者自訂鍵組合（null = 沿用 manifest 內建預設）。
  // 由 options 的 recorder 錄製、content-shortcuts.js 在頁面 keydown capture 比對。
  // 值形狀 { code, alt, shift, ctrl, meta }；slot key 為 2 / 1 / 3（與 translatePresets 同編號）。
  // Why：Safari（含 iOS / iPadOS）沒有瀏覽器層快速鍵設定入口，自訂鍵走 content script
  // 層攔截；桌面（Chrome / Firefox / macOS Safari）manifest 預設鍵仍並存有效。
  customShortcuts: { 2: null, 1: null, 3: null },
  // 送到 Instapaper:enable/disable 開關。預設關——避免沒申請金鑰 / 沒連結的
  // 使用者看到無作用按鈕。連結後寫入的 token / tokenSecret / username 不放
  // DEFAULT_SETTINGS（連結時才寫 storage.sync,密碼用完即丟不存,見 lib/instapaper.js）。
  instapaperEnabled: false,
  // 送到 Instapaper 時一併上傳文章摘要(用翻譯目標語言,固定走 Gemini Flash Lite)。
  // 預設開:只要有 Gemini API key,送出時自動附摘要;沒 key / 摘要失敗則靜默略過、
  // 書籤照常送。摘要每次會多一筆 flash-lite 用量(極微小),使用者可在此關閉。
  instapaperSummaryEnabled: true,
  // v1.5.6: 中國用語黑名單。使用者自訂時整個陣列覆蓋（不做 per-entry merge）。
  // 內容會以 <forbidden_terms_blacklist> 區塊注入到 systemInstruction 末端，
  // 且修改清單後快取 key 會帶 _b<hash> 後綴讓既有快取自動失效。
  forbiddenTerms: DEFAULT_FORBIDDEN_TERMS,
  // v1.6.1: 「不再顯示更新提示」toggle。預設 false（顯示提示）。
  // 對應 storage.local 的 updateAvailable 物件由 lib/update-check.js 寫入，不在 sync。
  disableUpdateNotice: false,
  // v1.6.6: 工具列「翻譯本頁」按鈕對應的 preset slot（1/2/3）。
  // 預設 slot 2 = Flash（與 v1.4.12 開始 popup 按鈕硬碼映射的行為一致）。
  // 使用者可在一般設定改成其他 preset，按 popup 按鈕等同按該 slot 的快速鍵。
  popupButtonSlot: 2,
  // 懸浮翻譯控制按鈕（floating action button）。
  // floatingIcon：enable 開關。預設 null = 一律預設開啟（content / options 端都把非 boolean
  //   解析成 true，不分平台）。使用者在 options 明確切過就寫入 boolean，之後尊重該值。
  // floatingIconOpacity：0.1–1，預設 0.7（與 toast 一致）。
  // floatingIconSize：icon 視覺邊長 px，16（小）/ 24（預設，中）/ 32（大，觸控好點）。
  // floatingIconPos：吸附邊緣位置。edge='left'|'right'，offsetY=0(頂)…1(底) 垂直比例。
  //   預設右下角（edge='right'、offsetY=1）；視窗縮放後按比例還原。
  floatingIcon: null,
  floatingIconOpacity: 0.7,
  floatingIconSize: 24,
  floatingIconPos: { edge: 'right', offsetY: 1 },
  // 四指觸控手勢 enable（iOS / iPadOS）。預設 false（改由懸浮按鈕當主要觸控入口，
  //   四指手勢易誤觸發故預設關，使用者可在 Options 開啟）。
  // content-touch.js isEnabled() 額外 gate 此旗標；桌面 build 無此手勢，旗標無作用。
  fourFingerGesture: false,
  // v1.6.13: 自動翻譯網站（白名單）觸發時要用哪一組 preset。預設 slot 2 = Flash。
  // 修法前自動翻譯路徑直接 SK.translatePage() 不帶 slot,fallback 全域 geminiConfig.model;
  // 使用者改 preset model 後 Alt+S 走新 model，但白名單路徑仍走全域 → UX 不一致。
  // 改成走 SK.handleTranslatePreset(autoTranslateSlot) 後，白名單與快速鍵行為對齊。
  autoTranslateSlot: 2,
  // v1.6.14: per-model 計價覆蓋表。Google 改價時內建表（lib/model-pricing.js）會過時，
  // 使用者可在「Gemini 分頁 → 模型計價」針對 lite/flash/pro 個別覆蓋。
  // 結構：{ [modelName]: { inputPerMTok, outputPerMTok } }；空欄位或缺 entry → fallback 內建表。
  modelPricingOverrides: {},
  // v1.5.7: 自訂 OpenAI-compatible Provider。
  // engine='openai-compat' 的 preset 會走 lib/openai-compat.js 透過 chat.completions
  // endpoint 翻譯，可接 OpenRouter / Together / Groq / Ollama 等 provider。
  // apiKey 不存 sync（getSettings 會從 storage.local 的 customProviderApiKey 注入），
  // systemPrompt 獨立於 Gemini（黑名單與固定術語表仍共用、由 buildEffectiveSystemInstruction 注入），
  // 但「預設值」與 Gemini 相同——使用者第一次打開分頁就有完整可用的 prompt，要動再動。
  //
  // baseUrl/model/pricing 預設套用 OpenRouter GPT-5.4 Mini（2026-05 校準價格）：
  // 使用者第一次打開自訂模型分頁就能直接用，只需填 OpenRouter API key 即可開始翻譯。
  // 想換 provider / model 仍可在 options 頁面覆蓋這幾個欄位。
  // 既有使用者升級後若 storage 內已有 customProvider entry，此預設不會覆蓋
  // （getSettings 對 customProvider 走淺 merge，saved 在後）。
  // 邊界 case：既有使用者若 saved 物件有 baseUrl/model 但缺 inputPerMTok/outputPerMTok
  // （過去預設都 0），升級後會吃到 GPT-5.4 Mini 預設價（0.75 / 4.50），跟實際 model
  // 計費可能不符 — 在 options 頁面手動覆蓋價格即可修正。
  customProvider: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-5.4-mini',
    systemPrompt: DEFAULT_SYSTEM_PROMPT, // 預設與 Gemini 相同；空字串時 adapter 套用簡短 fallback
    temperature: 0.7,
    inputPerMTok: 0.75,                 // OpenRouter GPT-5.4 Mini input 單價（USD / 1M tokens，2026-05 校準）
    outputPerMTok: 4.5,                 // 同上 output 單價
    // v1.9.2:cache 命中折扣(0-1,命中省下的比例)。預設 0.90 對齊預設模型 GPT-5.4 Mini
    // 的 90% off。使用者換 provider/model 時自行調整 — Anthropic 90%、DeepSeek 98%、
    // xAI 75-90%、舊 OpenAI 模型 50%。null 表示走 baseUrl 自動推導(getCustomCacheHitRate)。
    cachedDiscount: 0.90,
    // v1.6.18: thinking 控制（統一 5 級對映 + 進階 JSON 透傳）。
    //   thinkingLevel:'auto' 不送任何 thinking 參數，讓 provider 自選預設;
    //   'off' / 'low' / 'medium' / 'high' 由 lib/openai-compat-thinking.js 偵測 provider 後
    //   翻譯成對應 API 寫法（OpenRouter unified reasoning / Claude thinking.type /
    //   OpenAI o reasoning_effort / Grok reasoning_effort / Qwen extra_body.enable_thinking /
    //   通用 OpenAI-compat reasoning_effort）。
    //   extraBodyJson：使用者自填 JSON 字串，deep merge 到 request body，可覆蓋自動 mapping
    //   並加 provider 專屬參數（top_k / metadata 等）。預設空白（進階使用者才需要）。
    //
    //   為什麼預設 'off' 而非 'auto':aggregator（Fireworks / Together / Groq / DeepInfra 等）
    //   接的 reasoning model 預設行為不可信 — 實測 Fireworks-Qwen3.6-Plus 不送 thinking 參數
    //   時翻一段平均 56 秒，reasoning_effort='none' 後降到 1.2 秒（差 ~47×）。預設 'auto'
    //   會讓新使用者第一次接 customProvider 就踩翻譯永遠跑不完的坑；預設 'off' 反而對
    //   非 reasoning model 無害（reasoning_effort 被忽略）。使用者要 thinking 主動選即可。
    thinkingLevel: 'off',
    extraBodyJson: '',
    // 多段翻譯序號標記格式。true = 用 <<<SHINKANSEN_SEG-N>>>(本機量化模型如 gemma-4 量化版
    // 不會把這種 token 誤翻成「N1、N2」);false = 用緊湊 «N»(token 開銷小、商用 LLM 適用)。
    // 預設 true 對本機 LLM 使用者開箱即用;商用 API 使用者可關閉省 token。
    // 既有使用者升級後 undefined,lib/openai-compat.js 用 `=== false` 判斷,等同預設 true。
    useStrongSegMarker: true,
    // API 請求逾時（秒）。預設 15 對齊 Gemini 路徑;本機 LLM(Ollama 等)冷啟動
    // 載入模型到 VRAM 可能需 60-300 秒,使用者可自行調高
    fetchTimeoutSec: 90,
  },
};

// v0.62 起：apiKey 改存 browser.storage.local，不走 Google 帳號跨裝置同步。
// 其餘設定仍存 sync。對下游呼叫端完全透明——getSettings() 回傳的物件
// 依然有 .apiKey 欄位。
//
// v1.5.7 起：自訂 Provider 的 apiKey 也走 storage.local（同樣的設計理由——
// 避免機密跨裝置同步）。讀取時注入 merged.customProvider.apiKey，存 sync 時要剝掉。
const API_KEY_STORAGE_KEY = 'apiKey';
const CUSTOM_PROVIDER_API_KEY = 'customProviderApiKey';

// v1.8.14: storage.sync legacy key cleanup
// 之前移除的設定欄位仍躺在使用者 sync storage 佔 quota(8KB / item, 100KB total)。
// 一次性 sweep 把已知 legacy keys 刪除，避免長期累積踩到 QUOTA_BYTES。
// 新增 legacy key 時直接加進這個陣列即可。
const LEGACY_SYNC_KEYS = [
  'ytPreserveLineBreaks',  // v1.2.38 移除（YouTube 字幕保留換行，改為永遠 true)
  'preserveLineBreaks',    // 同上（全頁翻譯版本，更早期）
  'tier',                  // v2.0.64 移除（API 配額管理整項功能下架）
  'safetyMargin',          // 同上
  'rpmOverride',           // 同上
  'tpmOverride',           // 同上
  'rpdOverride',           // 同上
];

let _legacyCleanupDone = false;
export async function cleanupLegacySyncKeys() {
  if (_legacyCleanupDone) return;
  _legacyCleanupDone = true;
  try {
    const saved = await browser.storage.sync.get(LEGACY_SYNC_KEYS);
    const present = LEGACY_SYNC_KEYS.filter((k) => k in saved);
    if (present.length > 0) {
      await browser.storage.sync.remove(present);
    }
    // v2.0.64:配額管理下架的 local 殘留(rate limiter init log 去重標記)。
    // rateLimit_rpd_<YYYYMMDD> 歷史計數 key 需 get(null) 全掃才列得出來,
    // 為避免把整個快取池拉進記憶體,留作無害殘留不清。
    await browser.storage.local.remove('_rateLimitInitLog');
  } catch {
    // 失敗不影響主流程
    _legacyCleanupDone = false;
  }
}

// 一次性遷移：若 sync 裡還殘留 apiKey（舊版 <= v0.61 的使用者）、而 local
// 還沒有，就把它搬到 local 並從 sync 刪除。呼叫 getSettings() 會自動觸發。
async function migrateApiKeyIfNeeded(syncSaved) {
  if (!syncSaved || typeof syncSaved.apiKey !== 'string') return;
  const { [API_KEY_STORAGE_KEY]: localKey } = await browser.storage.local.get(API_KEY_STORAGE_KEY);
  if (!localKey && syncSaved.apiKey) {
    // sync 有、local 沒有 → 搬過去
    await browser.storage.local.set({ [API_KEY_STORAGE_KEY]: syncSaved.apiKey });
  }
  // 無論 local 原本有沒有，都要把 sync 裡的 apiKey 清掉（避免之後又被同步回來）
  await browser.storage.sync.remove('apiKey');
}

// 一次性遷移(v1.9.14):Gemini 3.1 Flash Lite 從 preview 轉正式版,model ID 由
// 'gemini-3.1-flash-lite-preview' 改成 'gemini-3.1-flash-lite'。掃使用者 saved
// 設定裡所有可能存舊 ID 的欄位(geminiConfig.model / glossary.model / ytSubtitle.model /
// translatePresets[*].model / pricing key)並改寫,避免 dropdown 選不到 / pricing 查不到。
// 改寫後 storage.sync.set 寫回去,下次 getSettings 直接讀新 ID。
export const GEMINI_FLASH_LITE_OLD_ID = 'gemini-3.1-flash-lite-preview';
export const GEMINI_FLASH_LITE_NEW_ID = 'gemini-3.1-flash-lite';
export async function migrateGeminiFlashLiteModelIfNeeded(syncSaved) {
  return _migrateGeminiModelId(syncSaved, GEMINI_FLASH_LITE_OLD_ID, GEMINI_FLASH_LITE_NEW_ID);
}

// 一次性遷移(v2.0.64):gemini-3.5-flash 自模型清單下架(由同價位帶的
// gemini-3.6-flash 接替,$1.50 input 同級、output $9.00 → $7.50 更便宜)。
// 存了舊 ID 的使用者設定改寫成 3.6-flash,避免 dropdown 選不到 / pricing 查不到。
// 精確字串比對,不會誤傷 gemini-3.5-flash-lite(新增模型,非下架對象)。
export const GEMINI_35_FLASH_OLD_ID = 'gemini-3.5-flash';
export const GEMINI_35_FLASH_NEW_ID = 'gemini-3.6-flash';
export async function migrateGemini35FlashModelIfNeeded(syncSaved) {
  return _migrateGeminiModelId(syncSaved, GEMINI_35_FLASH_OLD_ID, GEMINI_35_FLASH_NEW_ID);
}

// 共用實作:掃 saved 設定裡所有可能存模型 ID 的欄位(geminiConfig.model /
// glossary.model / ytSubtitle.model / translatePresets[*].model /
// modelPricingOverrides key)把 OLD 改寫成 NEW 後 storage.sync.set 寫回。
async function _migrateGeminiModelId(syncSaved, OLD, NEW) {
  if (!syncSaved) return;
  const patch = {};

  if (syncSaved.geminiConfig && syncSaved.geminiConfig.model === OLD) {
    patch.geminiConfig = { ...syncSaved.geminiConfig, model: NEW };
  }
  if (syncSaved.glossary && syncSaved.glossary.model === OLD) {
    patch.glossary = { ...syncSaved.glossary, model: NEW };
  }
  if (syncSaved.ytSubtitle && syncSaved.ytSubtitle.model === OLD) {
    patch.ytSubtitle = { ...syncSaved.ytSubtitle, model: NEW };
  }
  if (Array.isArray(syncSaved.translatePresets)) {
    let touched = false;
    const updated = syncSaved.translatePresets.map((p) => {
      if (p && p.engine === 'gemini' && p.model === OLD) {
        touched = true;
        return { ...p, model: NEW };
      }
      return p;
    });
    if (touched) patch.translatePresets = updated;
  }
  // 批次 5-4（v1.10.46）：model ID 為 key 的計價覆蓋存在 modelPricingOverrides
  //（model-pricing.js getPricingForModel 讀的那份）。原本誤檢查 syncSaved.pricing——
  // pricing 的 shape 是 {inputPerMTok, outputPerMTok, cachedDiscount}，key 永遠不是
  // model ID（dead code）→ 舊版設過 preview ID 計價覆蓋的使用者升級後覆蓋默默失效。
  if (syncSaved.modelPricingOverrides
      && Object.prototype.hasOwnProperty.call(syncSaved.modelPricingOverrides, OLD)) {
    const mergedOverrides = { ...syncSaved.modelPricingOverrides };
    if (!Object.prototype.hasOwnProperty.call(mergedOverrides, NEW)) {
      mergedOverrides[NEW] = mergedOverrides[OLD];
    }
    delete mergedOverrides[OLD];
    patch.modelPricingOverrides = mergedOverrides;
  }

  if (Object.keys(patch).length === 0) return;
  await browser.storage.sync.set(patch);
  // 同步寫進 syncSaved,本次 getSettings merge 立即看到新值(避免 cache 半輪寫舊讀新)
  Object.assign(syncSaved, patch);
}

// v1.8.14: settings 熱路徑 cache。
// 之前每筆 debugLog / LOG_USAGE 都呼叫 getSettings() → 每秒上百次 storage IPC。
// 現在用 module-scope cache + storage.onChanged invalidate,SW 重啟後 module 重 init
// 自然回到無 cache 狀態（首呼叫會重建）。
let _settingsCachePromise = null;
let _settingsCacheListenerBound = false;

function _bindSettingsCacheInvalidator() {
  if (_settingsCacheListenerBound) return;
  _settingsCacheListenerBound = true;
  // sync 改動（設定頁存設定）或 local 的 API key 改動才 invalidate。
  // v1.10.46(批次 2-6):過濾掉與 settings 無關的 local 高頻寫入——翻譯期間 logger
  // persistLog(yt_debug_log)與 tc_* 快取 flush 都寫 storage.local,原本任何變動都
  // invalidate → cache 在翻譯熱路徑的實際命中率近零(v1.8.14 的初衷整個失效)。
  // getSettings 的資料來源只有:sync 全部 key + local 的 apiKey / customProviderApiKey。
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' && !(area === 'local' && changes
      && (API_KEY_STORAGE_KEY in changes || CUSTOM_PROVIDER_API_KEY in changes))) return;
    _settingsCachePromise = null;
  });
}

export async function getSettingsCached() {
  _bindSettingsCacheInvalidator();
  if (!_settingsCachePromise) {
    _settingsCachePromise = getSettings().catch((err) => {
      _settingsCachePromise = null; // 失敗別 cache
      throw err;
    });
  }
  return _settingsCachePromise;
}

export async function getSettings() {
  const saved = await browser.storage.sync.get(null);
  await migrateApiKeyIfNeeded(saved);
  await migrateGeminiFlashLiteModelIfNeeded(saved);
  await migrateGemini35FlashModelIfNeeded(saved);
  // 從 local 讀 apiKey（v0.62 起的正規位置）
  const { [API_KEY_STORAGE_KEY]: apiKey = '' } = await browser.storage.local.get(API_KEY_STORAGE_KEY);
  // P1: 先決定 targetLanguage,後面 forbiddenTerms 預設依此分歧。
  // saved 不在合法集合(舊使用者沒此 key / 值損壞)→ navigator 推導。
  const target = (typeof saved.targetLanguage === 'string' && TARGET_LANGUAGES.includes(saved.targetLanguage))
    ? saved.targetLanguage
    : detectDefaultTargetLanguage();
  // saved.apiKey 可能還在（migrate 剛剛才刪），以 local 版本為準
  const merged = {
    ...DEFAULT_SETTINGS,
    ...saved,
    targetLanguage: target,
    // P2 (v1.8.60):uiLanguage 偏好。saved 不在合法集合 → 'auto'(由 resolveUiLanguage 推導)。
    uiLanguage: (typeof saved.uiLanguage === 'string' && UI_LANGUAGES.includes(saved.uiLanguage))
      ? saved.uiLanguage : 'auto',
    geminiConfig: { ...DEFAULT_SETTINGS.geminiConfig, ...(saved.geminiConfig || {}) },
    pricing: { ...DEFAULT_SETTINGS.pricing, ...(saved.pricing || {}) },
    domainRules: { ...DEFAULT_SETTINGS.domainRules, ...(saved.domainRules || {}) },
    glossary: { ...DEFAULT_SETTINGS.glossary, ...(saved.glossary || {}) },
    // v1.2.39: 深層 merge ytSubtitle，確保新欄位（model / pricing）有預設值
    ytSubtitle: { ...DEFAULT_SETTINGS.ytSubtitle, ...(saved.ytSubtitle || {}) },
    // v1.8.3: partialMode 深層 merge，確保 maxUnits 預設值有 fallback
    partialMode: { ...DEFAULT_SETTINGS.partialMode, ...(saved.partialMode || {}) },
    // v1.4.12: translatePresets——使用者自訂三組就完全以自訂為準（不做 per-slot merge），
    // 否則套用預設三組。陣列非空時視為使用者已自訂。
    translatePresets: (Array.isArray(saved.translatePresets) && saved.translatePresets.length > 0)
      ? saved.translatePresets
      : DEFAULT_SETTINGS.translatePresets,
    // v1.5.6: forbiddenTerms 陣列。使用者一旦寫入（即使空陣列代表「停用黑名單」）
    // 就完全以 saved 為準；未曾寫入時才套用預設清單。
    // P1: 未曾寫入時依 target 分歧——zh-TW 走 DEFAULT 清單(維持原行為),
    // zh-CN / en 走空陣列(那些 target 不需要禁用中國用語清單)。
    forbiddenTerms: Array.isArray(saved.forbiddenTerms)
      ? saved.forbiddenTerms
      : (target === 'zh-TW' ? DEFAULT_SETTINGS.forbiddenTerms : []),
    // v1.5.7: customProvider 深層 merge（保留新欄位預設值）
    customProvider: { ...DEFAULT_SETTINGS.customProvider, ...(saved.customProvider || {}) },
    // v1.8.49: translateDoc 深層 merge — 新增 applyFixedGlossary 後既有使用者
    // saved.translateDoc 沒這個 key,深 merge 才能拿到預設 true(否則 undefined)。
    translateDoc: { ...DEFAULT_SETTINGS.translateDoc, ...(saved.translateDoc || {}) },
  };
  merged.apiKey = apiKey;
  // v1.5.7: 從 storage.local 讀 customProvider apiKey 注入
  const { [CUSTOM_PROVIDER_API_KEY]: cpApiKey = '' } = await browser.storage.local.get(CUSTOM_PROVIDER_API_KEY);
  merged.customProvider.apiKey = cpApiKey;
  return merged;
}

// v1.6.6: 工具列「翻譯本頁」按鈕的 preset slot 解析
// raw 來自 storage.sync.popupButtonSlot（可能是 number / string / undefined / 0 / 999）
// 不在 1/2/3 範圍一律 fallback 2（與 v1.4.12 起的 popup 硬碼行為一致）
export function pickPopupSlot(raw) {
  const n = Number(raw);
  return [1, 2, 3].includes(n) ? n : 2;
}

// v1.6.13: 自動翻譯網站（白名單）的 preset slot 解析。
// raw 來自 storage.sync.autoTranslateSlot；範圍外一律 fallback 2（與 popup 對稱）。
export function pickAutoTranslateSlot(raw) {
  const n = Number(raw);
  return [1, 2, 3].includes(n) ? n : 2;
}

// v1.8.12: 判斷使用者目前的 translatePresets 是否真的會用到 Gemini engine。
// 用途：popup 的「⚠ 尚未設定 API Key」提示只有在會用到 Gemini 時才該顯示；
// 若使用者三組 preset 都改成 Google MT / 自訂模型，popup 不該再嘮叨他沒填 Gemini Key。
// 行為：
//   - 任一 slot engine === 'gemini' → true
//   - presets 為空 / 不是 array → 視為 true（保守，跟 fallback DEFAULT_SETTINGS 一致，
//     DEFAULT_SETTINGS.translatePresets 三組裡有兩組是 gemini)
export function presetsRequireGemini(presets) {
  if (!Array.isArray(presets) || presets.length === 0) return true;
  return presets.some(p => p && p.engine === 'gemini');
}

export async function setSettings(patch) {
  // 若 patch 含 apiKey，抽出來寫 local；其餘寫 sync
  // v1.5.7: customProvider.apiKey 同樣抽出來寫 local（key: customProviderApiKey）
  if (!patch) return;
  const rest = { ...patch };

  // 主 Gemini API Key
  if (Object.prototype.hasOwnProperty.call(rest, 'apiKey')) {
    await browser.storage.local.set({ [API_KEY_STORAGE_KEY]: rest.apiKey });
    delete rest.apiKey;
  }

  // 自訂 Provider API Key（v1.5.7）
  if (rest.customProvider && Object.prototype.hasOwnProperty.call(rest.customProvider, 'apiKey')) {
    const cp = { ...rest.customProvider };
    await browser.storage.local.set({ [CUSTOM_PROVIDER_API_KEY]: cp.apiKey });
    delete cp.apiKey;
    rest.customProvider = cp;
  }

  if (Object.keys(rest).length > 0) {
    await browser.storage.sync.set(rest);
  }
}
