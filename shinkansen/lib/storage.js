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
   - 唯一的例外：國家、城市與地理位置必須翻譯為標準台灣譯名（如 Israel → 以色列, London → 倫敦）。
</critical_rules>

<linguistic_guidelines>
1. 台灣道地語感：嚴格使用台灣慣用語，追求情緒對等而非字面直譯。若原文語氣誇張（如 broke the internet），請對應台灣當代強烈的流行語或成語。拒絕「這是一個...的過程」、「在...的情況下」、「...的部分」等機器翻譯腔。
2. 禁用中國大陸用語：嚴格依本 prompt 末端 <forbidden_terms_blacklist> 區塊中列出的對照表，絕對不可使用左側詞彙。除黑名單外，其他中國大陸特有用語也應主動替換為台灣慣用詞。
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

// v1.0.2: 術語表擷取用的預設 prompt（結構化重寫，強化排除規則與輸出格式約束）
export const DEFAULT_GLOSSARY_PROMPT = `<role_definition>
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
1. 在台灣已高度通用且通常不翻譯的品牌、平台、縮寫或企業名（例如：Google, Netflix, AI, NBA, F1, 勞力士, 蘋果, 抖音, 微軟, 麥當勞, 可口可樂, Instagram 等）。
2. 一般的英文單字（非專有名詞的普通名詞、動詞、形容詞）。
3. 原文中僅出現一次且無歧義的簡單詞彙。
</exclusion_rules>
<output_constraints>
1. 語言規範：嚴格使用台灣繁體中文與台灣慣用語，絕對禁用中國大陸譯法（例如：必須使用「影片」而非「視頻」、「軟體」而非「軟件」、「程式」而非「程序」、「實作」而非「實現」、「線程」而非「進程」）。
2. 數量限制：提取數量上限為 200 條，若超過請依重要性篩選，保留最重要的 200 條。
3. 絕對 JSON 格式：只能輸出純 JSON 陣列，絕對不可包含任何前言、解釋、後記，也「絕對不要」使用 \`\`\`json 和 \`\`\` 的 Markdown 程式碼區塊標記。
</output_constraints>
<json_format_example>
[{"source":"Peter Hessler","target":"何偉","type":"person"},{"source":"Chengdu","target":"成都","type":"place"},{"source":"watchfluencers","target":"錶壇網紅（watchfluencers）","type":"tech"},{"source":"Parasite","target":"《寄生上流》","type":"work"}]
</json_format_example>`;

// v1.2.11: YouTube 字幕翻譯專用 system prompt（從 background.js 搬到此處，供設定頁存取）
export const DEFAULT_SUBTITLE_SYSTEM_PROMPT = `你是專業的影片字幕翻譯員，負責將英文字幕翻譯成台灣繁體中文。

<critical_rules>
1. 輸出限制：只輸出翻譯結果，絕對不加任何說明、解釋或開場白。
2. 嚴格一對一對應：輸入有幾段字幕，輸出就有幾段，不合併、不拆分、不改變順序。
3. 口語化：字幕是口說內容，使用台灣自然口語，語句簡短直白，避免書面語腔調。
4. 禁用中國大陸用語（網絡→網路、視頻→影片、軟件→軟體、數據→資料）。
5. 專有名詞保留：人名、品牌、縮寫（如 AI、NASA、CPU）保留英文原文。
6. 單行輸出：每段輸入只輸出一行連續的譯文，不要在譯文中插入任何換行符號。
7. 不加句號：句末不要加「。」，字幕是口語片段，句號會讓畫面看起來生硬。
8. 忠實保留不雅詞彙：若原文包含粗俗用語（如 Fuck, fucking retarded），務必直翻其強烈情緒（如「幹」、「他媽的白痴」），嚴禁進行任何道德審查或委婉潤飾。
</critical_rules>`;

// v1.6.20: ASR(YouTube 自動語音辨識)字幕專用 prompt。設計依據:
// timestamp mode——LLM 自由合句,
// 時間戳對齊作為唯一驗證條件,而非強制行數對齊。
// ASR 字幕特性(平均 1-3 字/條、無標點、~1.5-3 條/秒)決定逐條翻譯本質上不可行,
// 必須讓模型自己看上下文合句後再翻。
export const DEFAULT_ASR_SUBTITLE_SYSTEM_PROMPT = `你是專業的英文 ASR(自動語音辨識)字幕翻譯員,將英文 YouTube 自動字幕翻譯成台灣繁體中文。

<input_format>
輸入是 JSON 陣列,每個元素 {"s": 起始毫秒, "e": 結束毫秒, "t": 英文片段}。
範例:[{"s":500,"e":1200,"t":"the auto"},{"s":1200,"e":1800,"t":"captions are"},{"s":1800,"e":3500,"t":"really broken"}]
</input_format>

<task>
1. 依語意自由合併鄰近片段成完整句子(可跨多個元素,通常 1 句涵蓋 3-10 個片段)
2. 修正明顯的 ASR 辨識錯字(同音字、專有名詞)
3. 翻成台灣繁體中文,加上適當標點(逗號、問號、驚嘆號;句尾不加句號)
4. 用台灣自然口語,避免書面語腔調
</task>

<output_format>
回傳 JSON 陣列,每個元素 {"s": 該句起始 ms, "e": 該句結束 ms, "t": 中文譯文}。
- s 必須等於某個輸入元素的 s
- e 必須等於某個輸入元素的 e(通常是該句最後一個片段的 e)
- 不要包 \`\`\`json fence,直接輸出純 JSON 陣列
- 不要任何解釋、開場白、後記
範例:[{"s":500,"e":3500,"t":"自動字幕真的壞了"}]
</output_format>

<critical_rules>
1. 禁用中國大陸用語(網絡→網路、視頻→影片、軟件→軟體、數據→資料、用戶→使用者)
2. 專有名詞保留英文(人名、品牌、縮寫如 AI、NASA、CPU)
3. 忠實保留粗俗用語(Fuck → 幹),不審查、不委婉化
4. 不要遺漏輸入片段:輸出陣列加總應涵蓋所有輸入時間範圍
</critical_rules>`;

// v1.5.6: 中國用語黑名單預設清單。使用者可在「術語表」分頁的「禁用詞清單」section 編輯。
// 注入時機：buildEffectiveSystemInstruction 在所有其他規則（含 fixedGlossary）之後，
// 以 <forbidden_terms_blacklist> 區塊放在最末端，讓 LLM 給予最高權重。
// 與既有「進程→線程」對照（v0.83 ~ v1.5.5）相比修正：原對映把兩個都誤翻為簡中
// （process 在台灣應為「行程」、thread 應為「執行緒」），這版分開列正確對映。
export const DEFAULT_FORBIDDEN_TERMS = [
  { forbidden: '視頻',     replacement: '影片',     note: '' },
  { forbidden: '音頻',     replacement: '音訊',     note: '' },
  { forbidden: '軟件',     replacement: '軟體',     note: '' },
  { forbidden: '硬件',     replacement: '硬體',     note: '' },
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
  { forbidden: '界面',     replacement: '介面',     note: '' },
  { forbidden: '痛點',     replacement: '要害',     note: '' },
  { forbidden: '硬傷',     replacement: '罩門',     note: '' },
  { forbidden: '文檔',     replacement: '文件',     note: 'document（注意：「文件」在台灣指 document，「檔案」才是 file）' },
  { forbidden: '操作系統', replacement: '作業系統', note: '' },
];

export const DEFAULT_SETTINGS = {
  apiKey: '',
  geminiConfig: {
    model: 'gemini-3-flash-preview',       // v0.83: 預設模型升級至 Gemini 3 Flash
    serviceTier: 'DEFAULT',
    temperature: 1.0,     // Gemini 3 Flash 原廠預設值
    topP: 0.95,
    topK: 40,             // Gemini 3 Flash 原廠預設值（Pro 系列為 64）
    maxOutputTokens: 8192,
    systemInstruction: DEFAULT_SYSTEM_PROMPT,
  },
  // 計價設定（USD per 1M tokens)。預設值為 gemini-3-flash-preview 的官方報價，
  // 使用者換模型時請自行至設定頁調整。
  pricing: {
    inputPerMTok: 0.50,
    outputPerMTok: 3.00,
  },
  // v0.69: 全文術語表一致化設定
  glossary: {
    enabled: false,
    prompt: DEFAULT_GLOSSARY_PROMPT,
    temperature: 0.1,                  // 術語表要穩定，不要有創意
    skipThreshold: 1,                  // ≤ 此批次數完全不建術語表
    // v1.7.3: 預設從 5 提高到 10 — 中等長度頁面(6-10 批)走 fire-and-forget 不阻塞,
    // 省下 EXTRACT_GLOSSARY 1.5-7.4 秒 blocking 等待;短頁本就跳過、長頁(>10 批)
    // 仍 blocking 確保跨批次術語一致。使用者可在設定頁 0(永遠 fire-and-forget)
    // ~ 50(極長頁才 blocking)區間調整。
    blockingThreshold: 10,             // > 此批次數則阻塞等術語表回來再翻譯
    timeoutMs: 60000,                  // 術語表請求逾時（毫秒），超過則 fallback（v0.70: 60s）
    maxTerms: 200,                     // 術語表上限條目數
    // v1.7.2: 術語表獨立模型。空字串表示「跟主翻譯同一個 model」(舊行為);
    // 預設 'gemini-3.1-flash-lite-preview' — 術語抽取任務簡單,Flash Lite 比 Flash 快
    // 1.5-3 倍且便宜 5 倍。實測啟用 glossary 時 EXTRACT_GLOSSARY 用 Flash 耗時
    // 1.5-7.4 秒,改用 Flash Lite 預期可壓到 0.5-2.5 秒。
    model: 'gemini-3.1-flash-lite-preview',
  },
  domainRules: { whitelist: [] },
  autoTranslate: false,
  debugLog: false,
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
    // v1.6.20: ASR(YouTube 自動字幕)分句模式。內部三值,UI 簡化為單一 toggle(v1.6.23):
    //   'heuristic'   = 預設分句:純 client-side 啟發式,延遲最低(~1-2s)。toggle 關閉時用。
    //   'progressive' = 混合模式(預設):先 heuristic 顯示(秒出),同時 LLM 跑覆蓋成更精緻版本。
    //                   兼顧速度與品質。toggle 開啟時用(預設)。
    //   'llm'         = 純 LLM 自由分句(內部保留,UI 不再可選)。
    asrMode: 'progressive',
  },
  // v0.35 新增：並行翻譯 rate limiter 設定
  // tier 對應 Gemini API 付費層級(free / tier1 / tier2),決定 RPM/TPM/RPD 上限
  // override 欄位若為 null 則使用 tier 對照表的值,非 null 時覆寫
  tier: 'tier1',
  safetyMargin: 0.1,
  maxRetries: 3,
  rpmOverride: null,
  tpmOverride: null,
  rpdOverride: null,
  // 每個 tab 同時最多飛出幾個翻譯批次(content.js 側的並發上限,與 limiter 雙重保險)
  maxConcurrentBatches: 10,
  // v1.0.2: 每批段數上限與字元預算，使用者可在設定頁自行調整。
  // 段數上限：避免單批 placeholder slot 過多導致 LLM 對齊失準。
  // 字元預算：作為 token proxy（3500 chars ≈ 1000 英文 tokens），留足 output headroom。
  maxUnitsPerBatch: DEFAULT_UNITS_PER_BATCH,
  maxCharsPerBatch: DEFAULT_CHARS_PER_BATCH,
  // v1.0.1: 單頁翻譯段落數上限。超大頁面（如維基百科長條目）超過此上限時截斷。
  // 設為 0 表示不限制。
  maxTranslateUnits: 1000,
  // v1.8.3:「只翻文章開頭」節省模式。enabled=true 時只翻 batch 0(經 prioritizeUnits
  // 推前的文章開頭 N 段),跳過 batch 1+,大幅減少 token 用量。使用者想看完整翻譯時
  // 關閉此選項並重新翻譯,前面已翻好的段落會從本地快取自動命中(不重複收費)。
  // maxUnits 範圍 5-50;chars 限制走內部 BATCH0_CHARS=3700 不暴露給使用者。
  partialMode: {
    enabled: false,
    maxUnits: 25,
    viewportOnly: false,
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
  // v1.0.21: 頁面層級繁體中文偵測開關。開啟時若整頁文字以繁中為主則跳過不翻譯；
  // 關閉時不做頁面層級檢查（元素層級仍會個別跳過繁中段落）。
  // Gmail 等介面語言為繁中但內容多為英文的網站，可關閉此選項。
  skipTraditionalChinesePage: true,
  // v1.5.0: 顯示模式（'single' 覆蓋 / 'dual' 雙語對照），由 popup toggle 切換。
  // 'single' 沿用 v1.4 之前所有路徑，'dual' 走 content-inject.js 的 injectDual。
  displayMode: 'single',
  // v1.5.0: 雙語模式下的視覺標記樣式（'tint' 淡底色 / 'bar' 左邊細條 / 'dashed' 波浪底線 / 'none'）
  translationMarkStyle: 'tint',
  // v1.4.12: 三組翻譯預設對應 Alt+A / Alt+S / Alt+D 三個快速鍵。
  // engine='gemini' 時 model 覆蓋 geminiConfig.model，其他欄位（prompt、temperature、glossary）沿用全域；
  // engine='google' 時走 Google Translate 路徑，不需 model。
  // label 顯示於 options 頁（未來 toast 也可用）。
  // 行為：閒置按 → 啟動對應 preset；翻譯中按 → abort；已翻譯按任意 → restorePage。
  translatePresets: [
    { slot: 1, engine: 'gemini', model: 'gemini-3.1-flash-lite-preview', label: 'Flash Lite' },
    { slot: 2, engine: 'gemini', model: 'gemini-3-flash-preview', label: 'Flash' },
    { slot: 3, engine: 'google', model: null, label: 'Google MT' },
  ],
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
  // v1.6.13: 自動翻譯網站(白名單)觸發時要用哪一組 preset。預設 slot 2 = Flash。
  // 修法前自動翻譯路徑直接 SK.translatePage() 不帶 slot,fallback 全域 geminiConfig.model;
  // 使用者改 preset model 後 Alt+S 走新 model,但白名單路徑仍走全域 → UX 不一致。
  // 改成走 SK.handleTranslatePreset(autoTranslateSlot) 後,白名單與快速鍵行為對齊。
  autoTranslateSlot: 2,
  // v1.6.14: per-model 計價覆蓋表。Google 改價時內建表(lib/model-pricing.js)會過時,
  // 使用者可在「Gemini 分頁 → 模型計價」針對 lite/flash/pro 個別覆蓋。
  // 結構:{ [modelName]: { inputPerMTok, outputPerMTok } };空欄位或缺 entry → fallback 內建表。
  modelPricingOverrides: {},
  // v1.5.7: 自訂 OpenAI-compatible Provider。
  // engine='openai-compat' 的 preset 會走 lib/openai-compat.js 透過 chat.completions
  // endpoint 翻譯，可接 OpenRouter / Together / DeepSeek / Groq / Ollama 等 provider。
  // apiKey 不存 sync（getSettings 會從 storage.local 的 customProviderApiKey 注入），
  // systemPrompt 獨立於 Gemini（黑名單與固定術語表仍共用、由 buildEffectiveSystemInstruction 注入），
  // 但「預設值」與 Gemini 相同——使用者第一次打開分頁就有完整可用的 prompt，要動再動。
  //
  // v1.6.16: baseUrl/model/pricing 預填 OpenRouter DeepSeek V4 Pro,使用者只要填 API Key
  // 就能啟動。資料來源 https://openrouter.ai/deepseek/deepseek-v4-pro(2026-04 校準)。
  // 既有使用者升級後若 storage 內已有 customProvider entry(例如打開過自訂模型分頁),
  // 此預設不會覆蓋(getSettings 對 customProvider 走淺 merge,saved 在後);要套用新預設
  // 需手動清空欄位或重新匯入設定。新使用者第一次打開設定頁就看到預填值。
  customProvider: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-v4-pro',
    systemPrompt: DEFAULT_SYSTEM_PROMPT, // 預設與 Gemini 相同；空字串時 adapter 套用簡短 fallback
    temperature: 0.7,
    inputPerMTok: 0.435,                // OpenRouter DeepSeek V4 Pro Standard tier 參考價
    outputPerMTok: 0.87,
    // v1.6.18: thinking 控制(統一 5 級對映 + 進階 JSON 透傳)。
    //   thinkingLevel:'auto' 不送任何 thinking 參數,讓 provider 自選預設(最安全 fallback);
    //   'off' / 'low' / 'medium' / 'high' 由 lib/openai-compat-thinking.js 偵測 provider 後
    //   翻譯成對應 API 寫法(OpenRouter unified reasoning / DeepSeek extra_body.thinking /
    //   Claude thinking.type / OpenAI o reasoning_effort / Grok reasoning_effort / Qwen
    //   extra_body.enable_thinking)。
    //   extraBodyJson:使用者自填 JSON 字串,deep merge 到 request body,可覆蓋自動 mapping
    //   並加 provider 專屬參數(top_k / metadata 等)。預設空白(進階使用者才需要)。
    thinkingLevel: 'auto',
    extraBodyJson: '',
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

export async function getSettings() {
  const saved = await browser.storage.sync.get(null);
  await migrateApiKeyIfNeeded(saved);
  // 從 local 讀 apiKey（v0.62 起的正規位置）
  const { [API_KEY_STORAGE_KEY]: apiKey = '' } = await browser.storage.local.get(API_KEY_STORAGE_KEY);
  // saved.apiKey 可能還在（migrate 剛剛才刪），以 local 版本為準
  const merged = {
    ...DEFAULT_SETTINGS,
    ...saved,
    geminiConfig: { ...DEFAULT_SETTINGS.geminiConfig, ...(saved.geminiConfig || {}) },
    pricing: { ...DEFAULT_SETTINGS.pricing, ...(saved.pricing || {}) },
    domainRules: { ...DEFAULT_SETTINGS.domainRules, ...(saved.domainRules || {}) },
    glossary: { ...DEFAULT_SETTINGS.glossary, ...(saved.glossary || {}) },
    // v1.2.39: 深層 merge ytSubtitle，確保新欄位（model / pricing）有預設值
    ytSubtitle: { ...DEFAULT_SETTINGS.ytSubtitle, ...(saved.ytSubtitle || {}) },
    // v1.8.3: partialMode 深層 merge,確保 maxUnits 預設值有 fallback
    partialMode: { ...DEFAULT_SETTINGS.partialMode, ...(saved.partialMode || {}) },
    // v1.4.12: translatePresets——使用者自訂三組就完全以自訂為準（不做 per-slot merge），
    // 否則套用預設三組。陣列非空時視為使用者已自訂。
    translatePresets: (Array.isArray(saved.translatePresets) && saved.translatePresets.length > 0)
      ? saved.translatePresets
      : DEFAULT_SETTINGS.translatePresets,
    // v1.5.6: forbiddenTerms 陣列。使用者一旦寫入（即使空陣列代表「停用黑名單」）
    // 就完全以 saved 為準；未曾寫入時才套用預設清單。
    forbiddenTerms: Array.isArray(saved.forbiddenTerms)
      ? saved.forbiddenTerms
      : DEFAULT_SETTINGS.forbiddenTerms,
    // v1.5.7: customProvider 深層 merge（保留新欄位預設值）
    customProvider: { ...DEFAULT_SETTINGS.customProvider, ...(saved.customProvider || {}) },
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

// v1.6.13: 自動翻譯網站(白名單)的 preset slot 解析。
// raw 來自 storage.sync.autoTranslateSlot;範圍外一律 fallback 2(與 popup 對稱)。
export function pickAutoTranslateSlot(raw) {
  const n = Number(raw);
  return [1, 2, 3].includes(n) ? n : 2;
}

// v1.8.12: 判斷使用者目前的 translatePresets 是否真的會用到 Gemini engine。
// 用途:popup 的「⚠ 尚未設定 API Key」提示只有在會用到 Gemini 時才該顯示;
// 若使用者三組 preset 都改成 Google MT / 自訂模型,popup 不該再嘮叨他沒填 Gemini Key。
// 行為:
//   - 任一 slot engine === 'gemini' → true
//   - presets 為空 / 不是 array → 視為 true(保守,跟 fallback DEFAULT_SETTINGS 一致,
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
