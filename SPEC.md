# Shinkansen — 規格文件（SPEC）

> 一款專注於隱私的網頁翻譯 Chrome Extension。

- 文件版本：v2.0
- 建立日期：2026-04-08
- 最後更新：2026-08-06（v2.0.85，文件瘦身改版）
- 目標平台：Chrome（Manifest V3）
- 作業系統：macOS 26
- 目前 Extension 版本：2.4.6

---

## 0. 文件維護政策

**每次修改 Extension 的行為、UI、設定結構、或檔案組織，都必須同步更新本文件。**

- 本文件定位為「使用者與整合者面向的功能規格」：功能行為、預設值、使用者可調設定、限制與上限。演算法細節、偵測規則、序列化協定、cache key 組裝、內部訊息協定、防護機制等**實作藍圖**維護於本機的 `SPEC-PRIVATE.md`（不入 repo），本文件對應章節僅留行為描述。
- Extension 版本號規則：三段式格式（`1.0.0` → `1.0.1`）。v1.0.0 以前的歷史版本使用兩段式。
- Extension 版本號統一由 `manifest.json` 的 `version` 欄位控管；Popup 顯示版本透過 `chrome.runtime.getManifest().version` 動態讀取，不得寫死。
- 本 SPEC 文件的版本號與 Extension 版本號獨立管理；SPEC 有結構性變動時 +0.1。

---

## 1. 專案目標

Shinkansen 是一款 Chrome 擴充功能，將英文（或其他外語）網頁翻譯成台灣繁體中文，協助使用者流暢閱讀外語內容。名稱「新幹線」象徵快速、平穩、流暢的閱讀體驗。

授權：Elastic License 2.0 (ELv2)。允許查看、學習、修改與個人使用；禁止將本軟體（含改寫版本）作為託管或受管理的服務提供給第三方。完整條款見專案根目錄 `LICENSE`。

---

## 2. 功能範圍

### 2.1 已實作（v2.4.6 為止）

詳細版本歷史見 [`CHANGELOG.md`](CHANGELOG.md)。

| 功能區塊 | 狀態 | 簡述 |
|---------|------|------|
| 網頁翻譯 | ✅ | Option+S（Gemini）/ Option+G（Google Translate）切換；單語覆蓋 / 雙語對照雙模式；漸進分批注入；還原原文 |
| 雙語對照模式 | ✅ | 譯文以 wrapper 形式附在原段落後；4 種視覺標記；顯示模式同時決定字幕雙語與否 |
| YouTube 字幕翻譯 | ✅ | 自動偵測字幕即時翻譯；ASR（自動字幕）AI 分句；時間視窗批次；雙語 overlay；字幕大小與顏色跟隨原生設定；行動版 `m.youtube.com` 支援；`/watch` 與 `/live/<id>`（直播 / 直播存檔分享連結）路徑皆支援 |
| SPA 支援 | ✅ | 站內導航自動偵測；動態載入內容補翻；譯文防覆蓋保護；續翻模式 |
| 段落偵測 | ✅ | 結構化 DOM walker；技術性排除（code / 表單 / 站底 footer）；內容品味判斷交給 system prompt |
| 佔位符序列化 | ✅ | 行內元素（連結 / 粗斜體等）與媒體在譯文中完整保留 |
| 並行翻譯 | ✅ | 併發批次池（`maxConcurrentBatches`）；429 退避重試 |
| 自動術語擷取 | ✅ | 預翻前擷取全文專有名詞對照表；長度三級策略；術語快取 |
| 固定術語表 | ✅ | 全域 + 網域兩層；設定頁編輯；優先覆蓋 LLM 自動術語 |
| 翻譯快取 | ✅ | `chrome.storage.local`；SHA-1 key；v1.8.45 起版本變更不清快取 |
| 設定頁 | ✅ | 8 Tab：一般設定 / YouTube 字幕 / Gemini / 自訂模型 / 術語表 / 禁用詞清單 / 用量紀錄 / Debug；匯入匯出 |
| Popup 面板 | ✅ | 翻譯/還原；快取/費用統計；自動翻譯開關；YouTube 字幕 toggle |
| Toast 提示 | ✅ | 進度條 + 計時器；可調透明度與位置；`toastAutoHide` 自動關閉選項 |
| 懸浮按鈕 | ✅ | 頁面邊緣可拖移「新」icon；短按翻譯、長按選引擎或功能選單；可調透明度與大小；手機／平板預設開、桌面預設關 |
| 用量紀錄 | ✅ | IndexedDB + 折線圖 + CSV 匯出；日期/模型/網域/文字搜尋篩選 |
| Debug 工具 | ✅ | Log buffer 1000 筆 + 持久化 100 筆（跨 SW 重啟）；設定頁 Debug 分頁瀏覽 |
| Google Docs 支援 | ✅ | 偵測編輯頁自動導向 `/mobilebasic` 閱讀版再翻譯 |
| 自動語言偵測 | ✅ | 跳過已是目標語言的頁面；target-aware（各 target 跳對應源語言） |
| 翻譯目標語言 | ✅ | 8 語：zh-TW / zh-CN / en / ja / ko / es / fr / de；詳見 §3.9 |
| 自動翻譯網站 | ✅ | 網域白名單（支援萬用字元）；`autoTranslate` 總開關 |
| 簡繁本地互轉 | ✅ | 簡繁段落走本地 OpenCC 字典轉換，免費零 API；`autoConvertZh` 自動模式 |
| 送到 Instapaper | ✅ | 把已翻譯整頁存進 Instapaper（含 AI 摘要）；popup 按鈕 + Alt+I 快速鍵 |
| 文件翻譯（PDF / EPUB / Word / TXT / Markdown / HTML / 字幕檔） | ✅ | 上傳整份翻譯；PDF 保留版面輸出譯文 PDF；EPUB 全書術語表 / 章節選翻 / 預覽編輯 / 雙語譯本；Word（.docx）譯文寫回原檔格式與版面全保留、可輸出雙語對照；TXT / Markdown / HTML 沿用章節管線，譯文輸出格式 = 輸入格式；字幕檔（SRT / WebVTT / ASS）每則字幕為翻譯單位、時間軸原樣保留、可輸出雙語字幕；詳見 §17 |
| iOS／iPadOS Safari | ✅ | 已上架 App Store（app ID 6776958298「Shinkansen Web Translator」）；四指輕點觸發；popup／options 觸控調整；不含 PDF 翻譯 |

### 2.3 明確不做

滑鼠懸停顯示、原文樣式客製、輸入框翻譯、劃詞翻譯、DeepL / Yandex 等第三方付費翻譯服務、影片字幕（YouTube 除外，已支援）、延遲載入、淺色/深色主題切換。

> 備注：v1.4.0 起已加入 Google Translate 非官方免費端點（Opt+G，不需 API Key），同時保留 Gemini（Opt+S）。Google 官方 Cloud Translation v2 API（付費）不在支援範圍內。

---

## 3. 翻譯服務：Google Gemini

### 3.1 API 端點

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
```

API key 一律走 `x-goog-api-key` request header，不放 URL query string（避免金鑰漏進 proxy／網路設備／錯誤訊息等會記 URL 的地方）。streaming 走 `:streamGenerateContent?alt=sse`、金鑰測試走 `GET models/{model}`，同樣以 header 帶 key。

### 3.2 開放使用者微調的參數

- `model`：模型名稱（預設 `gemini-3.1-flash-lite`，與主要預設 slot 2 一致；可改為其他 Gemini 模型或自行輸入模型 ID）
- `serviceTier`：推論層級（DEFAULT / FLEX / STANDARD / PRIORITY），設定頁存大寫短形式，API 送出時轉小寫，DEFAULT 時不送此欄位
- `temperature`：創造性，範圍 0–2，預設 1.0（Gemini 3 官方建議值）
- `topP`：核採樣，預設 0.95
- `topK`：預設 40
- **取樣參數模型 gating**：官方已淘汰取樣參數的新模型（Gemini 3.6 Flash／3.5 Flash-Lite 起）一律不送 `temperature`／`topP`／`topK`；Gemini 3 世代維持只送 `temperature`。設定欄位保留，對淘汰取樣參數的模型不生效
- `maxOutputTokens`：最大輸出長度，預設 8192
- `systemInstruction`：系統提示詞（見 3.3）
- `safetySettings`：安全過濾等級（預設 BLOCK_NONE 四大類別全開）

> **Thinking 功能**：固定關閉（`thinkingBudget: 0`），不開放使用者設定。思考 token 會吃掉 `maxOutputTokens` 額度，導致譯文被截斷。

### 3.3 預設 System Prompt

> **適用 target**：本節描述 zh-TW target 的預設 prompt（`DEFAULT_SYSTEM_PROMPT`）。其他 target 走 `UNIVERSAL_SYSTEM_PROMPT` + `{targetLanguage}` 注入，詳見 §3.9。

完整預設 prompt 定義在 `lib/storage.js` 的 `DEFAULT_SYSTEM_PROMPT`。採 XML tag 結構，分四大區塊：

- **`<role_definition>`**：定位為「精通英美流行文化與台灣在地文學的首席翻譯專家」，追求出版級台灣當代語感
- **`<critical_rules>`**：禁止輸出思考過程、忠實保留不雅詞彙（不做道德審查）、專有名詞保留英文原文（地理位置例外，須翻為台灣標準譯名）
- **`<linguistic_guidelines>`**：台灣道地語感（拒絕翻譯腔）、禁用非台灣慣用譯法（指向 §3.7 禁用詞清單）、台灣通行譯名、特殊詞彙首次出現加註原文
- **`<formatting_and_typography>`**：全形標點、破折號改寫、中英夾雜半形空格、數字與年份格式

使用者可在設定頁編輯 prompt；術語表與禁用詞清單由系統動態注入 prompt 末端。批次構建與段序號標記協定等內部機制見 SPEC-PRIVATE §32。

### 3.4 分段請求協定

多段文字以內部分隔符串接後一次送出，回應拆分對齊。分批走「字元預算 + 段數上限」雙門檻 greedy 打包：`maxCharsPerBatch`（預設 3500）與 `maxUnitsPerBatch`（預設 20）皆可在設定頁調整，任一觸發即封口；超大段落獨佔一批，不切段落本身。回傳段數不符時有兩層自動救回（段序號標記二次對齊 → 逐段單獨重呼叫）。協定與對齊演算法細節見 SPEC-PRIVATE §32。

### 3.5 429 與重試處理

client 端不做預防性節流，配額由 API 端 429 回應把關：

- **429 處理**：尊重 `Retry-After` header（等待上限 30 秒），否則指數退避（上限 8 秒）
- 重試上限 `maxRetries`（預設 3，options「效能調校」可調）
- 併發由 `maxConcurrentBatches` 自然限制 burst

### 3.6 術語表一致化

翻譯長文前先擷取全文專有名詞對照表，注入所有翻譯批次，確保譯名跨段落一致。預設停用（`glossary.enabled`），可在設定頁或 Popup 開啟。

**策略依文章長度分三級**：

- ≤ `skipThreshold`（預設 1）批 → 完全跳過，不建術語表
- 批數 ≤ `blockingThreshold`（預設 10）→ fire-and-forget（首批不等術語表）
- 超過 → 阻塞等待術語表回來再開始翻譯

**其他使用者可見行為**：

- 術語對照「譯名（原文）」全頁只在第一次出現時保留完整對照，後續只留譯名
- 上限 `glossary.maxTerms`（預設 200）條；逾時 `glossary.timeoutMs`（預設 60 秒），失敗或逾時自動 fallback 成不帶術語表的一般翻譯
- 術語表獨立模型（預設 `gemini-3.1-flash-lite`，抽取任務用輕量模型省時省錢）與獨立 temperature（預設 1.0）
- 術語表快取於 `chrome.storage.local`，popup「清除快取」一併清除

### 3.7 禁用詞清單

針對 AI 模型容易漏網的非台灣慣用譯法、或使用者不希望出現在譯文中的詞彙，建立可編輯的禁用清單，以 prompt 注入方式要求模型遵守（content 端不做事後 regex replace）。

- **替換詞可留空**：填了替換詞 → 要求模型改用指定詞；留空 → 只要求不可使用該詞，由模型自行改寫
- **預設清單**：25 條（`DEFAULT_FORBIDDEN_TERMS`），涵蓋視頻/軟件/數據/網絡/質量/用戶等常見對映；僅 target = zh-TW 時套用，其他 target 預設空清單
- **設定 UI**：獨立「禁用詞清單」分頁，三欄表格（禁用詞 / 替換詞 / 備註）＋新增/還原預設/刪除；匯入匯出支援
- 模型漏網案例會記入 Debug log（純記錄、不修改譯文）；清單變更後快取自動分區失效

### 3.8 自訂 OpenAI-compatible Provider

除 Gemini 與 Google Translate 外，使用者可設定**一組** OpenAI-compatible 端點，接 OpenRouter / Ollama 本機 / Together / Groq / Fireworks / OpenAI 等。`translatePresets` 任一 slot 的 `engine` 設成 `'openai-compat'` 即可由對應快速鍵啟動。

- **設定欄位**：`baseUrl`（預設 OpenRouter）、`model`（預設 `openai/gpt-5.4-mini`；留空 = 不送 model 欄位，配合 Ollama / llama.cpp 單模型 server）、獨立 `systemPrompt`、`temperature`（留空 = 不送，配合只接受自家預設的 reasoning model）、計價（`inputPerMTok` / `outputPerMTok`，USD / 1M tokens，填 0 = 不顯示費用）
- **Cache 命中折扣** `cachedDiscount`（0–1，預設 0.90）：空白時依 baseUrl 自動推導各家折扣
- **Thinking 控制** `thinkingLevel`（auto / off / low / medium / high，預設 off）：自動翻譯成各家 provider 的對應參數；`extraBodyJson` 供進階使用者透傳自訂欄位
- **強化段序號標記** `useStrongSegMarker`（預設開）：防本機量化模型把段落標記誤譯進譯文；商用 LLM 使用者可關閉省 token
- **API 逾時** `fetchTimeoutSec`（預設 90 秒，範圍 5–600）：本機 LLM 冷啟動可調高
- **API Key**：存 `chrome.storage.local`，不跨裝置同步、不在匯出範圍
- 固定術語表與禁用詞清單自動共用（改一處兩引擎同步生效）；術語表抽取也支援此引擎（不需 Gemini Key）

### 3.9 翻譯目標語言（Target Language）

支援八個目標語言：zh-TW（台灣繁中）/ zh-CN（中國簡中）/ en / ja / ko / es / fr / de。

**設定**：`settings.targetLanguage`，工具列圖示選單（popup）的「翻譯成」選單切換，改了立刻生效。

**預設值推導**（依 `navigator.language`）：

| navigator.language | 推導 target |
|---|---|
| `zh-TW` / `zh-Hant` / `zh-HK` 系 | `zh-TW` |
| 其他 `zh-*` | `zh-CN` |
| `ja*` / `ko*` / `es*` / `fr*` / `de*` | 對應語言 |
| 其他 | `en` |

**Prompt 機制**：zh-TW 走完整台灣用語預設 prompt（`DEFAULT_*_PROMPT` 系列）；其他 target 走 `UNIVERSAL_*_PROMPT` + `{targetLanguage}` 注入（翻譯 / 文件 / 術語表 / 字幕 / ASR 五套 prompt 各有對應 universal 版）。使用者客製過的 prompt 不受 target 切換影響；未客製者切換 target 立即生效。

**來源語言偵測 target-aware**：已是目標語言的段落自動跳過（zh-TW 跳繁中、zh-CN 跳簡中、en 跳英文）；es / fr / de 等拉丁字母 target 文字級無法區分，一律送 LLM 判斷。簡繁特徵字集由 OpenCC 字典完備生成。偵測演算法細節見 SPEC-PRIVATE §32。

**YouTube 字幕「已是目標語言」跳過**：字幕語言命中 target 對應集合時不啟動翻譯（target=zh-TW 時簡中字幕也跳——繁中使用者可直讀，不花 API；僅字幕路徑，整頁翻譯的簡中段落照翻或走本地轉換）。

**禁用詞清單依 target 預設**：未客製時 zh-TW 吃 25 條預設清單、其他 target 空清單；使用者編輯過則完全尊重 saved 值。

**Cache key 區隔**：不同 target 的譯文快取自動分區（§9.1）。

### 3.10 UI Localization（i18n）

擴充功能 UI 字串支援 8 語（與翻譯目標語種對齊）。UI 語言由獨立的 `settings.uiLanguage` 偏好控制，**跟翻譯目標解耦**——可以「英文介面 + 翻譯目標繁中」等任意組合。

- `uiLanguage = 'auto'`（預設）：依 `navigator.language` 推導；或強制鎖任一語言
- 自製 dict（`lib/i18n.js`，約 880 條 entry × 8 語，zh-TW 為 source of truth）而非 `chrome.i18n`（後者綁瀏覽器 locale 無法獨立切換）；缺 key 三層 fallback 保證不顯示空字串
- `_locales/` 8 語 `messages.json`（`extName` / `extDescription`）：manifest 的 `name` / `description` 以 `__MSG_*__` 引用，瀏覽器擴充功能管理頁、Safari 設定頁與商店 listing 短描述隨系統 / 瀏覽器語言顯示；`default_locale: zh_TW` 為 fallback。`extDescription` 每語 ≤ 112 字元（各平台取最嚴：Apple 驗 112、Chrome 為 132）
- popup / options / content toast / 文件翻譯頁全面走 dict；regression 由 `test/regression/i18n-*.spec.js` 8 檔覆蓋

### 3.11 送到 Instapaper（下游 reader 整合）

把目前（已就地翻譯）的整頁送進使用者自己的 Instapaper 帳號。選用功能，**預設關**。

- **引擎**：Instapaper Full API（OAuth 1.0a + xAuth）——走 Full API 是為了把抽好的乾淨譯文正文直接送出，存進去的是譯文版文章（Simple API 只吃網址會讓 Instapaper 重抓未翻譯的原文）
- **連結**：options 頁填 Instapaper email + 密碼一次換取 OAuth token；只存 token，密碼用完即丟
- **正文擷取**：vendored Readability 抽正文，標題取譯文標題；細節見 SPEC-PRIVATE §32
- **文章摘要**（`instapaperSummaryEnabled`，預設開）：送出時一併生成翻譯目標語言的文章摘要上傳（固定走 Gemini Flash Lite，與主翻譯引擎無關）；沒 Gemini key / 摘要失敗則靜默略過、書籤照常送
- **兩條觸發路徑**：popup「送到 Instapaper」按鈕（啟用且已連結才顯示）；快速鍵 Alt+I
- **host_permissions**：`https://www.instapaper.com/*`；consumer 金鑰不入 repo

### 3.12 簡繁本地互轉（OpenCC 字典，免費）

target 為中文變體時，偵測為**相反變體**的段落不送 LLM，改走本地 OpenCC 字典轉換——免費、即時、不需 API Key、離線可用。

**方向對映**：

| target | 轉換內容 |
|---|---|
| `zh-TW` | 簡體 → 台灣繁體含慣用詞（軟件→軟體、視頻→影片） |
| `zh-CN` | 台灣繁體 → 簡體（先還原慣用詞再簡化） |
| 其他 | 不分流，全走 LLM |

- 混合頁兩路並存：可轉段落走本地轉換、其餘照走 LLM；轉換結果不寫翻譯快取、不記用量（零 API）
- **自動模式**（`settings.autoConvertZh`，預設開）：頁面載入 / SPA 導航自動轉換（只跑本地轉換、絕不打 API）；popup toggle「簡繁自動互轉（免費）」只在 target 為中文變體時顯示，切換即時生效（取消時僅還原本地轉換結果，LLM 翻譯成果不受影響）
- 完成 toast 標示「免費未使用 API」；混合頁完整翻譯時標示其中 N 段本地轉換
- **實作**：`lib/zh-convert.js` + `lib/vendor/opencc/`（字典 10 檔約 1.1MB，lazy load）；分流判定與 SPA 邊角處理見 SPEC-PRIVATE §32

---

## 4. 翻譯顯示規格

### 4.1 顯示模式

兩種模式並存，由 `displayMode` 設定切換（popup 即時切換）：

- **`single`（預設，單語覆蓋）**：原文段落的文字節點替換成譯文，元素本身保留不動（字體 / 大小 / 顏色 / 排版全部沿用原文）
- **`dual`（雙語對照）**：原文保留，譯文以 `<shinkansen-translation>` wrapper 附在原段落之後（列表 / 表格等特殊元素內嵌避免破版）。原段落內容完全不動

**視覺標記**（`translationMarkStyle`，dual 模式譯文標記）：

- `tint`（預設）—— 淡黃底色
- `bar` —— 左邊細條
- `dashed` —— 波浪底線
- `none` —— 無標記

另支援暗色主題自動配色與自訂強調色（`dualAccentColor`：預設色 token 或自訂 hex，三種標記共用同色）。

**字幕跟隨顯示模式**：YouTube 與 Google Drive 影片字幕的雙語與否由 `displayMode === 'dual'` 決定（單一資料源，無獨立設定），播放中切換即時生效。字幕雙語走獨立 overlay 呈現，與整頁 dual 的 wrapper 機制無關。

**YouTube 字幕大小**（`ytSubtitle.captionScale`，%，預設 100 = 跟隨原生）：全平台統一旋鈕，涵蓋 overlay、視窗內原生字幕、iPhone／iPad 原生全螢幕三條渲染路徑。設定位於 popup，僅 YouTube 影片頁顯示，即時生效。

**YouTube 字幕顏色**：overlay 文字與背景顏色跟隨使用者在 YouTube 播放器「字幕樣式」設定的字型／背景顏色（含透明度），不硬編。

**模式切換時機**：已翻譯狀態下切換顯示模式會顯示提示 toast，要求按快速鍵重新翻譯以套用；當前頁面不動（避免半翻半改）。

**SPA 防護**：譯文被站點 framework 覆蓋 / 拔除時自動偵測並修復（Content Guard），不重複呼叫 LLM。注入規則、防護判準、與姊妹擴充 JRead 的互讓機制等細節見 SPEC-PRIVATE §32。

### 4.2 替換策略

single 模式譯文**一律注入回原 element**（不做 sibling overlay——下游 reader / scraper 擷取才乾淨）。行內元素（連結 / 粗斜體 / 行內 code 等）與媒體（圖片 / 影片 / SVG）以佔位符序列化協定在譯文中完整保留；含媒體的段落走「保留媒體 + 替換文字」路徑。序列化 / 反序列化協定與注入演算法見 SPEC-PRIVATE §32。

### 4.3 還原機制

再次按快速鍵（或 popup「顯示原文」）呼叫 `restorePage()` 完整還原原文——單語覆蓋、雙語 wrapper、framework-managed 三種注入痕跡一次清乾淨，含被站點 framework 暫時拆下 / 複製的節點（殭屍 marker 防護，v2.0.85）。內部三軌還原與保底機制見 SPEC-PRIVATE §32。

**頁面層級 `<html lang>` 對齊**：single mode 翻譯成功後 `<html lang>` 設為 target 語言（給下游 scraper 與 a11y 工具看），還原時寫回原值。dual mode 不動。

### 4.4 視覺樣式

原文元素的 font-family、font-size、color、layout 完全不動。不加邊框、背景、左邊線等任何裝飾。

---

## 5. 段落偵測規則

翻譯範圍由「技術性排除 + system prompt 內容判斷」決定，content script 不做內容性 selector 排除（該不該翻的品味判斷交給 LLM）。

- **納入**：常見文字 block 元素（段落 / 標題 / 列表 / 引用 / 表格格 / 圖說等）與偵測為段落的 inline 結構
- **技術性排除**：script / style / 程式碼區塊（含語法高亮 `<pre>`）/ 表單控制項 / 站底 footer（無文章祖先時）/ ARIA search 等；`<nav>` 不硬排除（交給 prompt）
- **可見性**：隱藏元素與 a11y visually-hidden 元素不收
- 特定站點結構補抓 selector、mixed-content fragment 切分、BUTTON 長文放行等細節見 SPEC-PRIVATE §32

---

## 6. 專案檔案結構

```
shinkansen/
├── manifest.json
├── content-ns.js             # 命名空間、共用狀態 STATE、常數、工具函式
├── content-toast.js          # Toast 提示系統（Shadow DOM 隔離）
├── content-detect.js         # 段落偵測（語言偵測、容器排除、collectParagraphs）
├── content-serialize.js      # 佔位符序列化/反序列化
├── content-inject.js         # DOM 注入
├── content-spa.js            # SPA 導航偵測 + Content Guard + MutationObserver
├── content-youtube-main.js   # YouTube XHR 攔截（MAIN world，document_start）
├── content-youtube.js        # YouTube 字幕翻譯（isolated world）
├── content-fw-detect-main.js # main world framework 偵測 bridge（MAIN world）
├── content-drive.js          # Google Drive 影片 ASR 字幕翻譯（top frame 浮層 overlay）
├── content-drive-iframe.js   # Drive ASR 字幕 URL 偵測（iframe）
├── content-touch.js          # iOS 四指 tap 手勢（IS_IOS_BUILD gate，桌面 build 為 no-op）
├── content.js                # 主協調層（translatePage、Debug API、初始化）
├── content-shortcuts.js      # 自訂快速鍵 keydown capture 比對 → 本地 dispatch（§10.1）
├── content-floating-icon.js  # 懸浮翻譯控制按鈕
├── content.css
├── background.js             # Service Worker（ES module）
├── privacy-policy.html       # 隱私權政策（繁中）
├── privacy-policy.en.html    # 隱私權政策（英文）
├── LICENSE                   # ELv2
├── THIRD-PARTY-NOTICES.md    # 第三方授權聲明
├── lib/
│   ├── gemini.js             # Gemini API 呼叫、分批、重試
│   ├── openai-compat.js      # 自訂 OpenAI-compatible adapter（§3.8）
│   ├── openai-compat-thinking.js # 自訂模型 thinking 控制 mapping
│   ├── google-translate.js   # Google Translate 非官方 API 封裝（免 API Key）
│   ├── system-instruction.js # 跨 provider 共用的翻譯 batch 構建 helper
│   ├── bg-error.js           # 背景端錯誤 error code 協定
│   ├── cache.js              # 翻譯快取（LRU + debounced flush）
│   ├── storage.js            # 設定讀寫、預設值
│   ├── constants.js          # 批次翻譯數值常數（content-ns.js 內為鏡像值）
│   ├── stream-reuse.js       # streaming 批次 partial-reuse 規劃
│   ├── logger.js             # 結構化 Log 系統
│   ├── usage-db.js           # 用量追蹤（IndexedDB）
│   ├── model-pricing.js      # Gemini 模型計價表
│   ├── exchange-rate.js      # USD ↔ TWD 匯率抓取 + 快取
│   ├── format.js             # 共用格式化函式
│   ├── format-currency.js    # 金額格式化 + fallback 匯率常數
│   ├── forbidden-terms.js    # 禁用詞 Debug 偵測層
│   ├── readability.js        # vendored @mozilla/readability（Apache-2.0；授權正本 readability.LICENSE）
│   ├── instapaper.js         # Instapaper Full API 封裝（§3.11）
│   ├── instapaper-keys.js    # Instapaper consumer 憑證（gitignore 不入 repo）
│   ├── i18n.js               # Extension UI 字串 i18n 字典（8 語，§3.10）
│   ├── compat.js             # Safari／Firefox 相容性 shim
│   ├── platform.js           # runtime 平台偵測
│   ├── distribution.js       # 編譯期注入的 MAS build flag（ES module 版）
│   ├── edit-link-repair.js   # contenteditable 連結邊界補位（編輯模式共用）
│   ├── update-check.js       # 版本更新檢查
│   ├── zh-convert.js         # 簡繁本地互轉（§3.12）
│   └── vendor/               # 第三方程式庫（pdfjs／pdf-lib + fontkit／chart.min.js／fflate／Noto Sans TC 字型／opencc 簡繁字典）
├── translate-doc/            # 文件翻譯：PDF + EPUB + TXT / MD / HTML + 字幕檔（§17，web_accessible_resources）
│   ├── index.html / index.js / index.css
│   ├── settings.html / settings.js
│   ├── block-types.js        # block type 共用常數
│   ├── layout-analyzer.js    # PDF 版面分析
│   ├── pdf-engine.js         # PDF.js wrapper（解析 pipeline）
│   ├── pdf-renderer.js       # 譯文 PDF 下載（pdf-lib，§17.8）
│   ├── epub-engine.js        # EPUB 解析（§17.10）
│   ├── epub-scan.js          # 譯後一致性掃描（§17.10）
│   ├── epub-writer.js        # 譯本 EPUB 重建（§17.10）
│   ├── epub-session-db.js    # 書籍式文件翻譯工作階段存檔（IndexedDB）
│   ├── doc-file-engine.js    # TXT / Markdown / HTML 解析與譯文檔重建 + 術語表 CSV 解析（§17.11）
│   ├── docx-engine.js        # Word（.docx）解析與譯本 docx 重建（§17.13）
│   ├── subtitle-engine.js    # 字幕檔（SRT / WebVTT / ASS）解析、行內標記佔位符對映與譯文檔重建（§17.12）
│   ├── dev-verify.js         # dev 驗證 harness hook（production 不載入）
│   ├── reader.js             # 線上閱讀器（雙頁並排，§17.6）
│   └── translate.js          # 文件翻譯 pipeline 協調
├── popup/
│   ├── popup.html / popup.js / popup.css
├── options/
│   ├── options.html / options.js / options.css
├── _locales/                 # 8 語 extName / extDescription（manifest __MSG__ 引用 + 商店 listing）
└── icons/
```

（部分次要檔案從略；以 repo 現況為準。）

---

## 7. 資料流程

1. 使用者按 Option+S 或 Popup「翻譯本頁」
2. 段落偵測收集翻譯單位（`content-detect.js`）
3. 段落 dedup；target 為中文變體時相反變體段分流走本地 OpenCC 轉換（§3.12）
4. 依字元預算 + 段數上限打包成批次
5. 術語表前置流程（依文章長度決定策略）
6. 併發送出批次到 background（依 engine 走 Gemini / Google Translate / 自訂 Provider）
7. background 查快取 → 未命中呼叫對應 provider API
8. 每批回來立即注入 DOM，Toast 更新進度
9. 全部完成後顯示成功 Toast（含 token 數、費用、快取命中率）

---

## 8. 設定資料結構

### 8.1 `chrome.storage.sync`（跨裝置同步，100KB 上限）

以下為 `lib/storage.js` 的 `DEFAULT_SETTINGS` 完整結構（含預設值）：

```json
{
  "apiKey": "",
  "targetLanguage": "（依 navigator.language 推導，§3.9）",
  "uiLanguage": "auto",
  "geminiConfig": {
    "model": "gemini-3.1-flash-lite",
    "serviceTier": "DEFAULT",
    "temperature": 1.0,
    "topP": 0.95,
    "topK": 40,
    "maxOutputTokens": 8192,
    "systemInstruction": "（見 §3.3 DEFAULT_SYSTEM_PROMPT）"
  },
  "pricing": { "inputPerMTok": 0.25, "outputPerMTok": 1.50, "cachedDiscount": 0.90 },
  "glossary": {
    "enabled": false,
    "prompt": "（見 DEFAULT_GLOSSARY_PROMPT）",
    "temperature": 1.0,
    "skipThreshold": 1,
    "blockingThreshold": 10,
    "timeoutMs": 60000,
    "maxTerms": 200,
    "model": "gemini-3.1-flash-lite"
  },
  "domainRules": { "whitelist": [] },
  "autoTranslate": false,
  "autoConvertZh": true,
  "debugLog": false,
  "translateDoc": {
    "systemPrompt": "（見 DEFAULT_DOC_SYSTEM_PROMPT）",
    "batchSize": 50,
    "applyGlossary": false,
    "temperature": 1.0,
    "applyFixedGlossary": true
  },
  "ytSubtitle": {
    "autoTranslate": true,
    "temperature": 1,
    "systemPrompt": "（見 DEFAULT_SUBTITLE_SYSTEM_PROMPT）",
    "windowSizeS": 30,
    "lookaheadS": 10,
    "debugToast": false,
    "onTheFly": false,
    "engine": "gemini",
    "model": "",
    "pricing": null,
    "applyFixedGlossary": false,
    "applyForbiddenTerms": false,
    "asrMode": "progressive",
    "preferOriginalTrack": true,
    "captionScale": 100
  },
  "maxRetries": 3,
  "maxConcurrentBatches": 30,
  "maxUnitsPerBatch": 20,
  "maxCharsPerBatch": 3500,
  "maxTranslateUnits": 1000,
  "partialMode": { "enabled": false, "maxUnits": 25 },
  "toastOpacity": 0.7,
  "toastAutoHide": true,
  "showProgressToast": true,
  "displayMode": "single",
  "displayCurrency": "TWD",
  "translationMarkStyle": "tint",
  "dualAccentColor": "auto",
  "translatePresets": [
    { "slot": 1, "engine": "gemini", "model": "gemini-3-flash-preview", "label": "Flash" },
    { "slot": 2, "engine": "gemini", "model": "gemini-3.1-flash-lite", "label": "Flash Lite" },
    { "slot": 3, "engine": "google", "model": null, "label": "Google MT" }
  ],
  "customShortcuts": { "2": null, "1": null, "3": null },
  "instapaperEnabled": false,
  "instapaperSummaryEnabled": true,
  "forbiddenTerms": "（見 §3.7 / DEFAULT_FORBIDDEN_TERMS，25 條預設）",
  "disableUpdateNotice": false,
  "popupButtonSlot": 2,
  "floatingIcon": null,
  "floatingIconOpacity": 0.7,
  "floatingIconSize": 24,
  "floatingIconPos": { "edge": "right", "offsetY": 1 },
  "fourFingerGesture": true,
  "iosPromoDismissed": false,
  "autoTranslateSlot": 2,
  "modelPricingOverrides": {},
  "customProvider": {
    "baseUrl": "https://openrouter.ai/api/v1",
    "model": "openai/gpt-5.4-mini",
    "systemPrompt": "（見 lib/storage.js DEFAULT_SYSTEM_PROMPT）",
    "temperature": 0.7,
    "inputPerMTok": 0.75,
    "outputPerMTok": 4.5,
    "cachedDiscount": 0.90,
    "thinkingLevel": "off",
    "extraBodyJson": "",
    "useStrongSegMarker": true,
    "fetchTimeoutSec": 90
  }
}
```

註：`customProvider.apiKey` **不存** sync，存 `chrome.storage.local`（key `customProviderApiKey`），與主 Gemini `apiKey` 設計一致。`customProvider.temperature` 可為 `null`（options 欄位留空）＝ 請求不送 `temperature`，見 §3.8。`ytSubtitle.bilingualMode` 已於 v2.0.85 移除——字幕雙語跟隨 `displayMode === 'dual'`（§4.1），舊版寫入的殘留 key 讀取時忽略、匯入時 sanitize 丟棄。

- **API Key** 存 `chrome.storage.local`（key `apiKey`），不跨裝置同步。舊版（≤v0.61）存在 sync 的 Key 會自動遷移至 local
- manifest `commands` 預設快捷鍵由 Chrome 原生管理不存設定；三組 preset 的**自訂**鍵位存 `customShortcuts`（in-page recorder，§10.1）
- `maxTranslateUnits`：單頁翻譯段落數上限，超過截斷（0 = 不限制）
- **Legacy key sweep**：已移除的設定欄位一次性從 sync 刪除，避免長期佔 quota

### 8.2 `chrome.storage.local`（本地，10MB 上限）

- **翻譯快取**：key `tc_<sha1>` → 譯文字串（另有 EPUB 一致性掃描快取 `scanr_`、全書術語表 `bookgloss_`）
- **術語表快取**：key `gloss_<sha1>` → 術語對照 JSON
- **版本標記**：key `__cacheVersion` → manifest version（v1.8.45 起版本變更**不**清快取，只更新標記）
- **累計費用顯示基準點**：key `usageResetAt` → ms epoch。popup「累計費用」的「清除」寫入；popup 只加總此時間點之後的 usage-db 紀錄。usage-db 與此 key 同為裝置本機，不跨裝置同步
- **機密**：`apiKey`（Gemini）、`customProviderApiKey`（自訂 Provider）——不跨裝置同步
- **通知狀態**：`welcomeNotice`（升級歡迎橫幅）、`updateAvailable`（`lib/update-check.js` 寫入的新版資訊）
- **其他**：`exchangeRate`（匯率 cache）、`translateDocPresetSlot`（文件翻譯頁上次選的 preset）、`hostSettingsConsumedSeq`（Safari host app 設定交接序號）、`yt_debug_log` / `anomaly_log`（持久 log ring，§12）

### 8.3 同步策略

- `chrome.storage.sync` 自動跨裝置同步設定（不含 API Key）
- 翻譯快取與術語表快取只存 local，不同步
- 設定頁提供匯出/匯入 JSON（API Key 不含在匯出範圍），匯入時 `sanitizeImport()` 驗證所有欄位

---

## 9. 翻譯快取

### 9.1 Key 設計

`tc_` + SHA-1（原文十六進位）。同一段原文跨頁面共用同一 key。key 依呼叫情境自動分區——引擎（Gemini / Google / 自訂 Provider）、用途（網頁 / 字幕 / ASR / Drive / 文件翻譯）、術語表內容、禁用詞清單、模型、目標語言、文件翻譯的 temperature 與額外指令都會讓 key 分開，互不污染。suffix 組裝規則見 SPEC-PRIVATE §32。

### 9.2 批次讀寫與容量

- 批次讀寫（一次 storage 往返）+ LRU 時間戳 debounce flush
- **容量上限**：約 9.5MB（storage.local 10MB 保留空間給非快取資料），超量 LRU 淘汰最舊條目

### 9.3 清空邏輯

- popup / options「清除快取」：清全部翻譯與術語表快取
- 版本變更**不**清快取（v1.8.45 起，避免每次更新讓使用者掉快取）
- options「清除所有文件翻譯記憶」：只清文件翻譯分區
- 特定修復版本會帶一次性 migration 清理受影響的快取分區（CHANGELOG 標注）

### 9.4 統計

`cache.stats()` 回傳 `{ count, bytes, glossaryCount, glossaryBytes }`。bytes 為 key + value 字元長度粗估。

---

## 10. 快捷鍵

三組 preset 快速鍵（v1.4.12 起），每組對應 options「翻譯快速鍵」一張 preset card（slot 1／2／3，可自訂 label／engine／model）：

| 快捷鍵 | command id | slot | 預設 engine / model |
|---|---|---|---|
| Alt+S（Opt+S） | `translate-preset-0` | 2 | Gemini Flash Lite（主要預設） |
| Alt+A（Opt+A） | `translate-preset-1` | 1 | Gemini Flash |
| Alt+D（Opt+D） | `translate-preset-3` | 3 | Google MT |
| Alt+I（Opt+I） | `send-to-instapaper` | — | 送到 Instapaper（§3.11） |

行為：閒置按 → 啟動對應 preset 翻譯；翻譯中按 → 立即取消還原；已翻譯按任一 → 還原原文。

### 10.1 自訂快速鍵（in-page recorder）

三組 preset 的鍵位可在 options「翻譯快速鍵」card 用 in-page recorder 自訂（存 `customShortcuts`，`content-shortcuts.js` 在頁面層攔截比對）。全平台通用——特別是 Safari／iPad 外接鍵盤沒有瀏覽器層改鍵入口。manifest 預設鍵仍並存有效。

### 10.2 iOS／iPadOS 四指手勢

四指輕點 = 主要預設快速鍵完整 toggle（`content-touch.js`）；`fourFingerGesture` 設定控制，預設開（易誤觸發的使用者可在 options 關閉；懸浮按鈕與硬體鍵盤快速鍵不受此開關影響）。

### 10.3 iOS background keep-alive

iOS Safari 背景 event page 掛起的續命處理（長批次翻譯期間保持背景存活）。

---

## 11. 翻譯狀態提示（Toast）

### 11.1 容器

`position: fixed` 最上層，Shadow DOM 隔離，280px 寬、白底圓角陰影。位置四選項（預設 `bottom-right`），設定頁可調。預設透明度 70%。

### 11.2 狀態

| 狀態 | 主訊息 | 進度條 | 自動消失 |
|------|--------|--------|----------|
| loading | `翻譯中… N / Total` + 計時器 | 藍色 | 否 |
| success | `翻譯完成（N 段）` + token/費用/命中率 | 綠色 100% | 是（`toastAutoHide` 開啟時 5 秒；帶動作按鈕時不自動關） |
| error | `翻譯失敗：<msg>` | 紅色 100% | 主要失敗訊息不自動關；次要錯誤 3-8 秒自動關 |
| restore | `已還原原文` | 綠色 100% | 2 秒 |

另有 `showProgressToast` 總開關（options，預設開）——關閉時所有 toast 完全不顯示。

成功 Toast 的 detail 兩行：token 數 + cache hit%、實付費用 + 節省%（費用套用 cache 命中折扣後的實付值）。

### 11.3 設計原則

- 不用轉圈 spinner，用橫向進度條 + 計時器
- 不用左邊色條 border-left
- 延遲 rescan 補抓在 UI 層完全隱形

---

## 12. LLM 除錯 Log

`lib/logger.js` 提供結構化 Log，記錄 API 呼叫的時間、模型、參數、耗時、token、錯誤等。

- **記憶體 buffer**：最近 1000 筆環形，SW 重啟即丟失。設定頁「Debug」分頁可瀏覽（分類 / 等級篩選、搜尋、匯出 JSON）
- **持久化 buffer**：最近 100 筆環形存 `chrome.storage.local`，跨 SW 重啟仍在（`youtube` / `api` / `translate` 三類）；另有低頻異常事件 ring 30 筆
- **「清除」按鈕**：兩層 buffer 都清
- **DevTools Console**：設定頁可選啟用同步輸出
- **Debug Bridge**：content script 以 CustomEvent 橋接供自動化測試 / 除錯工具讀取狀態與觸發動作；含快取內容檢視與編輯模式切換等**僅 dev 版本（四段版本號）啟用**的 action，商店版回 error。action 清單與協定見 SPEC-PRIVATE §32。僅限 Chromium（Firefox Xray 限制回讀不可用）

---

## 13. Popup 面板規格

### 13.1 版面

- Header：icon 圖檔 + 名稱「Shinkansen」+ 版本號（動態讀取，連結至更新紀錄頁）+ 更新提示 dot
- 升級歡迎 banner 與更新提示 banner（minor/major 進版觸發）
- 主按鈕：「翻譯本頁」/「顯示原文」+「送到 Instapaper」按鈕（啟用時，§3.11）
- 顯示模式 segmented control（單語覆蓋 / 雙語對照，§4.1）
- 「翻譯成」目標語言 picker（§3.9）
- 編輯譯文按鈕（翻譯完成後顯示）：進入編輯模式後頁面浮動工具列提供「復原」/「完成」；編輯中貼上降為純文字；連結邊界打字自動補回連結內（`lib/edit-link-repair.js`，與 EPUB 預覽編輯共用）
- 白名單自動翻譯 toggle
- 簡繁自動互轉 toggle（target 為中文變體時顯示，§3.12）
- 術語表一致化 toggle
- YouTube 字幕翻譯 toggle + 字幕大小 select（YouTube 影片頁顯示）
- Drive 影片字幕翻譯 toggle（Drive 影片頁顯示）
- 快取統計 + 清除快取按鈕
- 累計費用 / token 顯示 +「清除」按鈕（只重設顯示基準點，不刪用量紀錄）
- 狀態列
- Footer：設定按鈕 +「翻譯文件」按鈕（§17）+ 快捷鍵提示（動態讀取）

### 13.2 版本顯示

**必須**透過 `chrome.runtime.getManifest().version` 動態讀取，不得寫死。

---

## 14. 訊息協定（content ↔ background ↔ popup）

內部訊息協定（翻譯批次 / 字幕 / 文件翻譯 / streaming push / sticky 翻譯 / badge / 用量查詢等訊息 type 與 payload schema）維護於 SPEC-PRIVATE §32。

對外可觀察的行為要點：

- 翻譯完成後工具列 icon 點亮紅點 badge，分頁導航自動清除
- **跨 tab sticky 翻譯**：從已翻譯頁面以連結開新分頁（Cmd+Click / `target="_blank"` 等）時，新分頁自動以同一組 preset 續翻；手動開新分頁 / bookmark 不繼承
- 設定讀寫由 popup / options 直接走 `chrome.storage`，不經訊息層

---

## 15. Debug API

供自動化測試（Playwright）在 isolated world 查詢 content script 內部狀態與驅動測試路徑（`window.__shinkansen`）。成員清單與協定見 SPEC-PRIVATE §32。

---

## 16. 用量追蹤

`lib/usage-db.js` 使用 IndexedDB 儲存每次翻譯的詳細紀錄（時間、URL、模型、token 數、費用、段落數等）。

- 設定頁「用量」分頁：彙總卡片（總費用/token/筆數/最常用模型）、折線圖（日/週/月粒度）、明細表格
- 支援日期範圍篩選、CSV 匯出、清除——清除有兩種語意：options 的清除真刪紀錄；popup 的「清除」只重設顯示基準點，不刪任何紀錄
- 費用計算套用 cache 命中折扣後的實付值
- 字幕翻譯逐批合併成單筆（YouTube / Drive 各自合併不互混）；Google MT 整頁翻譯亦合併
- 全部命中本地快取（零 API 呼叫）的翻譯不寫入用量紀錄

---

## 17. 文件翻譯（PDF / EPUB / Word / TXT / Markdown / HTML / 字幕檔）

### 17.1 功能總覽

使用者透過 popup 點選「翻譯文件」開啟獨立分頁，本機上傳 PDF、EPUB、Word（`.docx`）、TXT、Markdown（`.md` / `.markdown`）、HTML（`.htm` / `.html`）或字幕檔（`.srt` / `.vtt` / `.ass` / `.ssa`），選擇翻譯 preset（沿用既有三組 preset），系統解析、批次送翻、提供：

1. **線上閱讀器**（PDF）：雙頁並排顯示（左原 / 右譯），雙向 scroll sync（同頁同比例定位）、zoom 控制、同步捲動開關
2. **下載譯文檔**：PDF 輸出 `<原檔名>-shinkansen.pdf`（譯文直接寫在原頁面版面上，頁數與原檔相同）；EPUB 輸出譯本 EPUB（單語 / 雙語對照可選）；Word 輸出 `<原檔名>-shinkansen.docx`（雙語版 `-shinkansen-dual.docx`，§17.13）；TXT / Markdown / HTML 輸出 `<原檔名>-shinkansen.<原副檔名>`（譯文輸出格式 = 輸入格式）；字幕檔輸出同格式字幕檔 `<原檔名>.<語言>.<原副檔名>`（單語 / 雙語字幕可選，§17.12）

### 17.2 限制與上限（PDF）

| 項目 | 硬上限 |
|------|--------|
| 頁數 | 300 頁 |
| 檔案大小 | 50 MB |

- 達硬上限：顯示「檔案超過支援上限，請先拆分後再上傳」+ 阻擋上傳
- 硬上限只擋解析階段吃不消的極端檔；長文件的翻譯成本由 §17.2.1「翻譯頁數範圍」控制
- **已知不支援場景**（上傳時偵測 + 標示）：純掃描 PDF（需 OCR，終止）、加密 PDF（終止）、字型映射不完整（警告 + 允許繼續）、旋轉 / 直排文字（該部分維持原文不翻譯）、RTL 文字（按 LTR 處理）

### 17.2.1 翻譯頁數範圍（PDF）

解析完成的「解析完成」畫面提供「翻譯頁數」起訖輸入（預設整份文件，附「全部」還原按鈕），可只翻文件其中一段頁面——長篇報告 / 操作手冊不必整份送翻。

- 輸入自動修正到合法區間：小於 1 補成 1、超過總頁數補成總頁數、起始頁大於結束頁時結束頁一起推齊
- **只影響「哪些頁送去翻譯」**：閱讀器與下載的譯文 PDF 仍是完整文件，範圍外的頁維持原文
- 「先建立文章術語表」的取樣範圍跟著頁數範圍走
- 換檔（重新上傳 / 切換檔案）後範圍重設為整份文件
- EPUB / Word / TXT / Markdown / HTML / 字幕檔走章節勾選（§17.6），不使用頁數範圍

### 17.3 入口 UI

- popup footer「翻譯文件」→ 開啟 `translate-doc/index.html` 獨立分頁
- 單頁 SPA：上傳（拖放 / 選檔）→ 解析 → 選 preset 開始翻譯 → 進度視圖（進度條 + 段落數 + 預估剩餘時間 + 累計費用 + 取消）→ 閱讀器。另有譯文編輯頁（支援 `**粗體**` / `[連結](url)` markdown 與搜尋取代）、文章術語表、版面 debug 檢視等支線頁
- 檔案結構見 §6 `translate-doc/`；PDF 版面分析與 IR 結構見 SPEC-PRIVATE §32

### 17.4 翻譯範圍（PDF）

段落 / 標題 / 列表 / 註腳送翻；頁碼保留原樣；表格逐行拆解為可翻譯單位原位翻譯。版面演算法（欄偵測 / block 切分 / reading order / 分類啟發式）見 SPEC-PRIVATE §32。

### 17.5 翻譯流程

- 文件翻譯走獨立 batch pipeline，使用獨立的文件翻譯 prompt（`translateDoc.systemPrompt`，設定頁可編輯）與獨立 temperature
- 每批段數 `translateDoc.batchSize`（1-100，預設 50，翻譯設定 dialog 可調）
- 引擎：preset 三選（Google MT 不支援文件翻譯，該選項 disabled）
- 失敗自動處理：可對切的錯誤遞迴切半重送救回其餘段；譯文接收後自動修復常見協定殘片與標點問題（快取命中也走同一條，舊壞快取自動治癒）
- 快取沿用 `tc_` 機制、獨立分區（§9.1）；進度事件驅動 UI 刷新
- 協定與內部細節見 SPEC-PRIVATE §32

### 17.6 線上閱讀器

- 左欄：原檔 render 成 canvas；右欄：**譯文 PDF bytes 同樣 render 成 canvas**——所見即所得，畫面即下載檔內容
- 雙向 scroll sync 以「頁 + 頁內比例」同步；zoom 50%-200%；「同步捲動」可關
- Lazy render：離開視窗的頁釋放記憶體（大檔案兩欄全 render 記憶體峰值過高，必須惰性）
- 「翻譯紀錄」modal：翻譯摘要、失敗段落清單與「重試失敗段落」按鈕、版面 debug 檢視入口

### 17.7 翻譯失敗處理

- 單段失敗：該位置露出原文；「翻譯紀錄」modal 內可一鍵重試所有失敗段
- 整體失敗：閱讀器顯示錯誤 banner，下一輪翻譯成功時自動清除
- 編輯頁儲存只標記「內容有變動」的段落為手動編輯；未動過的失敗段保留重試入口
- **不做整份自動 retry**（浪費已成功段落的 token）；下載時 failed 段落以原文輸出

### 17.8 譯文 PDF 下載

原頁嵌為底層（向量 / 點陣 / 文字原樣保留），可翻譯段落以白底遮罩蓋住原文位置後寫入譯文；不可翻譯與失敗段落露出底層原文；原 PDF 的連結 annotation 重建。中文字型內嵌 Noto Sans TC（TTF，subset 後每檔約 100-300KB，授權標示於 `lib/vendor/fonts/`）。譯文自動換行與 fit-to-box 縮排；排版細節見 SPEC-PRIVATE §32。

### 17.10 EPUB 電子書翻譯

與 PDF 共用同一頁，依副檔名自動分流。

**限制**：檔案硬上限 100MB；全書字數超過 50 萬字時顯示成本警告。

**使用者可見功能**：

- **章節選翻**：解析後列章節清單（含每章字數與預估費用），可勾選部分章節翻譯；附屬頁（封面 / 版權頁等）預設建議跳過
- **預覽編輯**：已翻段落可直接點擊編輯（`contenteditable`，貼上降為純文字、連結邊界打字自動補回連結內）；「顯示原文對照」toggle；全書預覽；搜尋取代（只動譯文文字、保留 inline 標記）
- **譯文空格自動校正**（`translateDoc.epubAutoFixSpacing`，預設開）：中文譯文的 CJK↔拉丁間距自動補齊、全形標點旁多餘空格自動移除
- **工作階段存檔**：翻譯進度（含手動編輯）、全書術語表、本書禁用詞、額外翻譯指令、累計費用整包存本機 IndexedDB；重開同檔自動還原；不受「清除翻譯記憶」影響。支援匯出 / 匯入 `-session.json`（跨書匯入拒絕）
- **放棄本書翻譯**：紅字按鈕，confirm 後清掉這本書全部工作進度與快取，回到選檔畫面
- **全書術語表**：分輪掃描全書抽取譯名對照（上限 500 條），跨章節譯名一致；可手動編輯、逐條「對照一次」選項；匯入支援 JSON（含選項 flag）與 CSV（兩欄「原文,譯名」，容許 BOM / CRLF / 引號跳脫 / 表頭列；非 CSV 副檔名但 JSON parse 失敗時自動退回 CSV 解析），匯入走合併 / 覆蓋 dialog 與上限保護
- **本書禁用詞 / 額外翻譯指令**：per-document 補充規則，隨工作階段保存
- **術語表譯名不被加註原文**：翻譯完成後，術語表 target 為純譯名的條目，譯文中出現「譯名（該條 source）」一律還原成純譯名（確定性後處理；target 本身含括號對照的條目照表輸出，要對照請把譯名寫成「譯名（原文）」並搭配「對照一次」選項；手動編輯過的段落不動；快取命中的舊譯文重跑零費用即治癒）。通用 prompt 的「特殊詞彙首次出現加註原文」規則會讓模型對純譯名條目自行加註（實測同一份內容段落版 91 段 33 處），術語表是單一事實來源
- **輸出格式**：EPUB 2 來源可選升級輸出 EPUB 3；譯本內容可選單語譯文或雙語對照（切換重新下載零重翻費用）
- **段落間距至少 0.5em**（`translateDoc.epubParagraphSpacing`，預設關）：改善 `margin:0` 傳統排版的段落擁擠
- **譯後一致性掃描**（`translateDoc.consistencyScan`，預設開）：翻譯完成後掃描「同一原文多譯名 / 指定譯名缺席」並列出可一鍵取代的違規清單。注意訊號層：掃的是譯名一致性，不驗「單一譯名但翻得差」（品質歸 prompt / 模型）

解析 / 序列化 / 譯本重建（writer）/ 掃描演算法等實作細節見 SPEC-PRIVATE §32。

### 17.11 TXT / Markdown / HTML 檔案翻譯

與 EPUB 共用同一條「書籍式文件」管線（章節清單 / 術語表 / 譯後一致性掃描 / 預覽編輯 / 工作階段存檔 / 費用預估 / 術語表譯名不被加註原文的後處理全部沿用），只有解析與譯文檔重建按格式分流：

- **TXT**：按空行分段為翻譯單位；空白行、純標點 / 數字段（分隔線、頁碼）原樣保留。無章節結構——整份單一「章節」，不出章節勾選 UI，主按鈕為「開始翻譯」
- **Markdown**：按 ATX 標題（`#` / `##`）切章，比照 EPUB 出章節勾選清單；標題 / 清單 / 引用的標記前綴由重建端保留，fenced code block 不翻譯原樣帶過；無標題檔視同單章
- **HTML**：整份單一章節，段落偵測與行內標記序列化沿用 EPUB 章節引擎（粗斜體 / 連結等 inline 標記保留），`<script>` / 樣式 / 其餘結構原樣帶過；輸出時更新 `<html lang>` 為目標語言，來源未宣告 charset 時補 `<meta charset="utf-8">`
- **限制**：檔案硬上限與 EPUB 相同（100 MB）；已選字數超過 50 萬字時顯示成本警告
- **檔案編碼**：讀入時自動判斷編碼——UTF-8（含 BOM）/ UTF-16（BOM）/ Big5 / GBK / Shift_JIS / EUC-KR / Windows-1252（以目標語言決定舊編碼的優先順序，並以常用字比例防止 Big5 ⇄ GBK 互判錯）；譯文檔一律以 **UTF-8** 輸出（來源有 BOM 才帶 UTF-8 BOM）
- **格式列**：章節清單資訊列的「格式」欄顯示 EPUB 版本或 TXT / Markdown / HTML
- **UI 文案分流**：只有 EPUB 用「書」語彙（全書術語表 / 全書預覽 / 放棄本書翻譯 / 本書累計費用 / 本書禁用詞）；TXT / Markdown / HTML / 字幕檔用通用檔案語彙（全文術語表 / 全文預覽 / 放棄本檔翻譯 / 本檔累計費用 / 本檔禁用詞）。單章文件另隱藏「章節數」列、摘要列不出現「N 章」、預覽返回鍵為「← 返回」；無作者的檔案隱藏「作者」列
- 雙語對照譯本輸出為 EPUB 與字幕檔提供，TXT / Markdown / HTML 不提供
- **整份未翻輸出 === 輸入**（重建不變量）：未翻 / 失敗段落在譯文檔中以原文原樣輸出

### 17.12 字幕檔翻譯（SRT / WebVTT / ASS）

與 TXT / Markdown / HTML 共用同一條「書籍式文件」管線（術語表 / 譯後一致性掃描 / 預覽編輯 / 工作階段存檔 / 費用預估全部沿用），整份單一「章節」不出章節勾選 UI：

- **支援格式**：SubRip（`.srt`）、WebVTT（`.vtt`）、Advanced SubStation Alpha（`.ass` / `.ssa`）
- **翻譯單位**：每則字幕（cue）一個翻譯單位；同一批內相鄰字幕一起送翻，LLM 以前後字幕為語境但逐則輸出（內建字幕專用提示：不合併 / 不拆分相鄰字幕、不把內容提前或延後到相鄰則、譯文精簡口語、不加註解；使用者的「本文件額外翻譯指令」接在其後）
- **句末不加句號**（翻譯設定 modal「字幕句末不加句號」，`translateDoc.subtitleStripPeriod`，預設開）：與 YouTube 字幕翻譯同款要求——開啟時字幕提示加「每則譯文結尾不加「。」（問號、驚嘆號保留）」，另有確定性安全網在輸出端把每則譯文每行行尾的「。」去掉（「。」後只剩閉合引號 / 括號 / 標記也算行尾；句中「。」不動）；預覽與下載都套用、不改寫存在工作階段的譯文，關閉即回到模型原始輸出。只在翻譯目標為中文時生效（半形 `.` 在其他語言有縮寫語意，不動）。切換會改變字幕提示 → 翻譯記憶 key 跟著變，舊譯文不命中但不需手動清
- **譯名不加括號原文對照**：字幕提示明訂「譯名後不加括號原文」並優先於通用 prompt 的「特殊詞彙首次出現加註原文」規則（字幕每則獨立，通用規則會讓每則都變「首次出現」→ 滿篇「伊拉克（Iraq）」）；另有書籍式文件共用的確定性安全網（§17.10「術語表譯名不被加註原文」）
- **原樣保留**：序號、時間軸（含 VTT cue 設定）、WEBVTT 標頭、NOTE / STYLE / REGION 區塊、ASS 的 `[Script Info]` / `[V4+ Styles]` 區段與 `Comment:` 行、純音符 / 純標點字幕（♪ ♪）全部原樣帶過
- **行內標記保留**：`<i>` / `<b>` / `<c.class>` 等配對標記、`<v 說話者>` / VTT 時間標記 `<00:01.000>` / ASS 覆寫 `{\an8}` / ASS 換行 `\N` 以佔位符協定保護，譯文回來還原原標記；LLM 吃掉的 ASS 覆寫標記補回該行行首
- **輸出**：下載 `<原檔名>.<語言>.<原副檔名>`（例 `Show S01E01.srt` → `Show S01E01.zh.srt`；語言碼取目標語言主要子標籤小寫：zh-TW / zh-CN → `zh`、en → `en`），語言碼緊貼副檔名是播放器（VLC / Plex / Jellyfin）自動對字幕軌與標示語言的慣例；譯文檔與原檔同格式、同則數、同時間軸；「字幕內容」select 可選**單語字幕**（每則只有譯文）或**雙語字幕**（每則譯文在上、原文在下，ASS 以 `\N` 分行；檔名為 `<原檔名>.dual.<語言>.<原副檔名>`）；切換模式重新下載零重翻費用
- **預覽**：一則多行的字幕譯文在預覽頁以換行顯示（與下載檔一致），預覽內編輯的換行存回譯文時保留
- **限制**：檔案硬上限與 EPUB 相同（100 MB）；格式列顯示 SRT / WebVTT / ASS；整份未翻輸出 === 輸入
- **檔案編碼**：讀入時自動判斷編碼——UTF-8（含 BOM）/ UTF-16（BOM）/ Big5 / GBK / Shift_JIS / EUC-KR / Windows-1252（以目標語言決定舊編碼的優先順序，並以常用字比例防止 Big5 ⇄ GBK 互判錯）；字幕檔常見的舊編碼來源不再亂碼，譯文字幕檔一律以 **UTF-8** 輸出（來源有 BOM 才帶 UTF-8 BOM）
- 解析 / 佔位符對映 / 重建細節見 SPEC-PRIVATE §32

### 17.13 Word（.docx）檔案翻譯

與 EPUB 共用同一條「書籍式文件」管線（章節清單 / 全書術語表 / 譯後一致性掃描 / 預覽編輯 / 工作階段存檔 / 費用預估 / 術語表譯名不被加註原文的後處理全部沿用），譯文寫回原 .docx 檔案結構——版面、樣式、字型、圖片、表格全部由 Word 自身維持，不做版面重排：

- **章節切分**：內文依標題樣式（Heading 1 / Heading 2）切章，比照 Markdown 出章節勾選清單；無標題檔視同單章。頁首與頁尾、註腳與章節附註、文件註解各自成附加章節，可獨立勾選
- **格式保留**：段落樣式、對齊、清單編號、粗斜體 / 底線 / 刪除線 / 上下標 / 色字 / 螢光標記 / 字型等行內格式，以及超連結（外部與文件內錨點）全數往返；行內圖片、定位鍵、分頁符、數學公式、內容控制項原樣保留不送翻
- **欄位（field）**：PAGE / TOC 等 Word 欄位整塊原樣保留不翻譯——目錄在 Word 內更新欄位後即以譯後標題重算
- **書籤與註解錨點**：書籤、註解範圍錨點與參照全數保留；註解（comments）內容一併翻譯，在 Word 註解面板顯示譯文
- **雙語對照**（下載時「譯本內容」select 可選）：原文段落原樣保留，譯文段落接在每段後面（清單項的譯文段不重複編號；頁首頁尾 / 註腳 / 註解維持單語）；切換模式重新下載零重翻費用
- **不支援場景**（上傳時偵測 + 明確提示）：加密（密碼保護）docx 擋下；含未接受追蹤修訂的檔案擋下並提示先在 Word 接受修訂；`.doc` 舊格式與 `.docm` 巨集檔不支援
- **限制**：檔案硬上限與 EPUB 相同（100 MB）；已選字數超過 50 萬字時顯示成本警告；格式列顯示「Word (DOCX)」
- **重建不變量**：未翻 / 失敗段落與所有未動檔案區塊逐位元組保留；重複下載輸出一致
- 解析 / OOXML 寫回 / island 協定等實作細節見 SPEC-PRIVATE §32
