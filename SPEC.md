# Shinkansen — 規格文件（SPEC）

> 一款專注於隱私的網頁翻譯 Chrome Extension。

- 文件版本：v1.1
- 建立日期：2026-04-08
- 最後更新：2026-06-09（v1.10.44）
- 目標平台：Chrome（Manifest V3）
- 作業系統：macOS 26
- 目前 Extension 版本：2.0.77

---

## 0. 文件維護政策

**每次修改 Extension 的行為、UI、設定結構、或檔案組織，都必須同步更新本文件。**

- Extension 版本號規則：三段式格式（`1.0.0` → `1.0.1`）。v1.0.0 以前的歷史版本使用兩段式。
- Extension 版本號統一由 `manifest.json` 的 `version` 欄位控管；Popup 顯示版本透過 `chrome.runtime.getManifest().version` 動態讀取，不得寫死。
- 本 SPEC 文件的版本號與 Extension 版本號獨立管理；SPEC 有結構性變動時 +0.1。

---

## 1. 專案目標

Shinkansen 是一款 Chrome 擴充功能，將英文（或其他外語）網頁翻譯成台灣繁體中文，協助使用者流暢閱讀外語內容。名稱「新幹線」象徵快速、平穩、流暢的閱讀體驗。

授權：Elastic License 2.0 (ELv2)。允許查看、學習、修改與個人使用；禁止將本軟體（含改寫版本）作為託管或受管理的服務提供給第三方。完整條款見專案根目錄 `LICENSE`。

---

## 2. 功能範圍

### 2.1 已實作（v2.0.77 為止）

詳細版本歷史見 [`CHANGELOG.md`](CHANGELOG.md)。

| 功能區塊 | 狀態 | 簡述 |
|---------|------|------|
| 網頁翻譯 | ✅ | Option+S（Gemini）/ Option+G（Google Translate）切換；單語覆蓋 / 雙語對照雙模式；漸進分批注入；還原原文 |
| 雙語對照模式 | ✅ | v1.5.0 新增；popup toggle 切換；譯文以 `<shinkansen-translation>` wrapper 形式 append 在原段落後/內；4 種視覺標記 |
| YouTube 字幕翻譯 | ✅ | XHR 預翻 + on-the-fly 備援；時間視窗批次；seek/rate 補償；字幕框展開置中；SPA 導航自動重啟；ASR（自動字幕）走獨立合句路徑（v1.6.20）；ASR 視窗與子批邊界對齊句尾標點（視窗尾端延伸 + `asrSegConsumed` 去重不重複送翻、子批只在句尾切點切分——句子不再被拆進兩個獨立 LLM 呼叫造成邊界詞重複；無標點軌維持 gap 切分）；LLM 合句譯文超過 40 字元時顯示層保底拆成多個 cue（切點時間以字元占比初估、±2s 內吸附到最近的原始片段起點＝真實語音 onset，軌粒度太粗吸不到才留占比；captionMap 仍存整句）；行動版 `m.youtube.com` 同樣支援（auto-CC 走 `#movie_player` captions module API、SPA 用 `state-navigateend` 事件） |
| SPA 支援 | ✅ | History API 攔截 + URL 輪詢；MutationObserver rescan；Content Guard；stickyTranslate 續翻 |
| 段落偵測 | ✅ | walker + mixed-content fragment；PRE 條件排除；leaf DIV / grid cell 補抓；nav 放行 |
| 佔位符序列化 | ✅ | 配對型 ⟦N⟧…⟦/N⟧ + 原子型 ⟦*N⟧；媒體保留；含圖連結重建 |
| 並行翻譯 | ✅ | concurrency pool（`maxConcurrentBatches`）；429 退避重試（`fetchWithRetry`） |
| 自動術語擷取 | ✅ | Gemini 預翻前擷取專有名詞；長度三級策略；術語快取（`gloss_` prefix） |
| 固定術語表 | ✅ | 全域 + 網域兩層；設定頁編輯；優先覆蓋 LLM 自動術語 |
| 翻譯快取 | ✅ | `chrome.storage.local`；SHA-1 key；版本變更自動清空 |
| 設定頁 | ✅ | 5 Tab：一般設定 / Gemini / 術語表 / 用量紀錄 / Debug；匯入匯出 |
| Popup 面板 | ✅ | 翻譯/還原；快取/費用統計；自動翻譯開關；YouTube 字幕 toggle |
| Toast 提示 | ✅ | 進度條 + 計時器；可調透明度與位置（設定頁透明度旁附即時範例預覽）；`toastAutoHide` 自動關閉選項 |
| 懸浮按鈕 | ✅ | 頁面邊緣可拖移方形「新」icon（`content-floating-icon.js`）；短按走 `popupButtonSlot` 預設翻譯、長按選三組 preset 或「功能選單」（在頁內用 closed Shadow DOM + iframe 載入 `popup/popup.html?panel=1` 當浮層叫出工具列圖示選單，`popup.html` 列入 `web_accessible_resources`；popup 端偵測 `?panel=1` → 關閉改 postMessage 收浮層、並回報內容高度讓 iframe 收緊）；在 YouTube 影片頁（`SK.isYouTubePage()`）長按選單額外加一列「啟動／關閉字幕翻譯」（依 `SK.YT.active` 決定 label 與動作，與 popup `SET_SUBTITLE` 同一份事實，只切當前影片、不持久化 `ytSubtitle.autoTranslate`）、拖移吸附左右緣（`floatingIconPos` 位置記憶）；**僅 iPadOS** 渲染時把按鈕夾離螢幕上下角落（避開視窗縮放拖曳角／系統手勢角，防止停太靠近角落被 OS 攔走觸控而拖不出來），iPadOS 預設右下角即落在此安全極限；iPhone 與桌面瀏覽器不設角落禁制區（`isIPadOSEnv` 以 UA + `maxTouchPoints` 判定，排除 iPhone／Android／桌面 Mac）；手機／平板預設開、桌面預設關（`floatingIcon`）；可調透明度（`floatingIconOpacity`）與大小（`floatingIconSize`：16 小／24 中／32 大，預設 24 中；視覺邊長 = icon 尺寸、可點範圍 = icon + 透明 padding）；closed Shadow DOM，不注入文章內容 |
| 用量紀錄 | ✅ | IndexedDB + 折線圖 + CSV 匯出；日期/模型/網域/文字搜尋篩選 |
| Debug 工具 | ✅ | Debug Bridge（CustomEvent）；Log buffer 1000 筆 + 持久化 100 筆（`youtube` / `api` / `translate` 跨 SW 重啟）；YouTube `GET_YT_DEBUG` action |
| Google Docs 支援 | ✅ | 偵測編輯頁自動導向 `/mobilebasic` 閱讀版再翻譯 |
| 自動語言偵測 | ✅ | 跳過已是目標語言的頁面（可設定關閉）；比例制偵測；日韓文排除；v1.8.59 起 target-aware（zh-TW/zh-CN/en 各自跳對應源語言） |
| 翻譯目標語言 | ✅ | v1.8.59 新增；可選 zh-TW（台灣繁中）/ zh-CN（中國簡中）/ en（英文）；非 zh-TW 走 universal prompt 注入 `{targetLanguage}`；詳見 §3.9 |
| 自動翻譯網站 | ✅ | 網域白名單（支援萬用字元；填裸網域或整段網址皆可，比對前正規化成主機名）；`autoTranslate` 總開關 |
| iOS／iPadOS Safari | 🚧 | TestFlight 階段（未上架）；四指輕點觸發（= 主要預設快速鍵完整 toggle，`content-touch.js`；可在設定頁關閉 `fourFingerGesture`）；popup／options iOS 調整（popup viewport 依機型動態放大撐滿、popup 快速鍵提示改顯示四指輕點、options 窄版 RWD＋16px 輸入框防 focus 自動 zoom、隱藏 PDF 入口）；build 期 strip `translate-doc/`（不做 PDF 翻譯）；m.youtube.com 字幕翻譯完整支援（行動版 Safari 不需切電腦版） |

### 2.3 明確不做

滑鼠懸停顯示、原文樣式客製、輸入框翻譯、劃詞翻譯、DeepL / Yandex 等第三方付費翻譯服務、影片字幕（YouTube 除外，已支援）、延遲載入、多國語言介面、淺色/深色主題切換。

> 備注：v1.4.0 起已加入 Google Translate 非官方免費端點（Opt+G，不需 API Key），同時保留 Gemini（Opt+S）。Google 官方 Cloud Translation v2 API（付費）不在支援範圍內。

---

## 3. 翻譯服務：Google Gemini

### 3.1 API 端點

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
```

API key 一律走 `x-goog-api-key` request header，不放 URL query string（避免金鑰漏進 proxy／網路設備／錯誤訊息等會記 URL 的地方）。streaming 走 `:streamGenerateContent?alt=sse`、金鑰測試走 `GET models/{model}`，同樣以 header 帶 key。

### 3.2 開放使用者微調的參數

- `model`：模型名稱（預設 `gemini-3-flash-preview`，可改為其他 Gemini 模型或自行輸入模型 ID）
- `serviceTier`：推論層級（DEFAULT / FLEX / STANDARD / PRIORITY），設定頁存大寫短形式，API 送出時轉小寫（`flex`/`standard`/`priority`），DEFAULT 時不送此欄位
- `temperature`：創造性，範圍 0–2，預設 1.0（Gemini 3 Flash 原廠預設值）
- `topP`：核採樣，預設 0.95
- `topK`：預設 40（Gemini 3 Flash 原廠預設值，Pro 系列為 64）
- **取樣參數模型 gating**：Gemini 3.6 Flash／3.5 Flash-Lite（含日後所有模型）起官方淘汰 `temperature`／`topP`／`topK`（目前被忽略，日後送出直接回 HTTP 400），Shinkansen 對這些模型一律不送三者（`lib/gemini.js` 的 `modelDropsSamplingParams`／`buildTemperatureField`／`buildSamplingFields`）；Gemini 3 世代維持只送 `temperature`。設定欄位保留，對淘汰取樣參數的模型不生效，確定性需求改由 `systemInstruction` 規則承擔
- `maxOutputTokens`：最大輸出長度，預設 8192
- `systemInstruction`：系統提示詞（見 3.3）
- `safetySettings`：安全過濾等級（預設 BLOCK_NONE 四大類別全開）

> **Thinking 功能**：`gemini.js` 固定送 `thinkingConfig: { thinkingBudget: 0 }`（永遠關閉），不開放使用者設定。原因是思考 token 會吃掉 `maxOutputTokens` 額度，導致譯文被截斷。

### 3.3 預設 System Prompt

> **適用 target**：本節描述 zh-TW target 的預設 prompt（`DEFAULT_SYSTEM_PROMPT`）。其他 target（zh-CN / en）走 `UNIVERSAL_SYSTEM_PROMPT` + `{targetLanguage}` 注入後字面值，詳見 §3.9。

完整預設 prompt 定義在 `lib/storage.js` 的 `DEFAULT_SYSTEM_PROMPT`（v0.83 升級）。採 XML tag 結構，分四大區塊：

- **`<role_definition>`**：定位為「精通英美流行文化與台灣在地文學的首席翻譯專家」，追求出版級台灣當代語感
- **`<critical_rules>`**：禁止輸出思考過程、忠實保留不雅詞彙（不做道德審查）、專有名詞保留英文原文（地理位置例外，須翻為台灣標準譯名）
- **`<linguistic_guidelines>`**：台灣道地語感（拒絕翻譯腔）、禁用非台灣慣用譯法（v1.5.6 起改指向末端 `<forbidden_terms_blacklist>` 禁用詞區塊）、台灣通行譯名、特殊詞彙首次出現加註原文
- **`<formatting_and_typography>`**：全形標點、破折號改寫、中英夾雜半形空格、數字格式（1–99 中文數字、100 以上阿拉伯數字）、年份格式

`lib/system-instruction.js` 的 `buildEffectiveSystemInstruction()`（v1.5.7 從 `lib/gemini.js` 抽出供 OpenAI-compat adapter 共用）會依批次內容動態追加規則。追加順序為：基礎指令 → 多段分隔符（含段序號標記規則） → 段內換行 → 佔位符 → 自動術語對照表 → 使用者固定術語表 → 禁用詞清單。

段序號標記有兩種格式（adapter 各自指定）：

- **COMPACT `«N»`**：Gemini 主路徑固定使用，token 開銷最小（單段約 3 tokens）
- **STRONG `<<<SHINKANSEN_SEG-N>>>`**：自訂 OpenAI-compat 預設使用，本機量化模型（如 gemma-4 量化版）不會把它誤譯為 N1、N2 洩漏到譯文；商用 LLM 使用者可在「自訂模型」分頁關閉 `useStrongSegMarker` toggle 改回 COMPACT 省 token（單段約多 7 tokens、input + output 雙倍開銷）

`SK.sanitizeMarkers`（content-ns.js）防禦式 strip 兩種格式都涵蓋——LLM 偷懶把 N 段合併成 1 段時的殘留標記、跨 engine 切換時的 cache race、使用者切換 toggle 期間的混合譯文都能清乾淨。

使用者另可在「術語表」分頁編輯「禁用詞清單」，內容會以 `<forbidden_terms_blacklist>` 區塊注入 systemInstruction 末端，詳見 §3.7。

### 3.4 分段請求協定

多段文字以 `\n<<<SHINKANSEN_SEP>>>\n` 串接後一次送出，回應以相同分隔符拆分對齊。

**分批策略**：字元預算 + 段數上限雙門檻 greedy 打包。`maxCharsPerBatch`（預設 3500，設定頁可調）與 `maxUnitsPerBatch`（v1.5.8 起預設 20，設定頁可調）任一觸發即封口。超大段落獨佔一批，不切段落本身。

**對齊失敗處理**（v2.0.69 起兩層）：回傳段數不符時，先以 `«N»` 段序號標記做二次對齊（`lib/system-instruction.js` 的 `realignByMarkers()`——模型偶發吃掉段落間 SEP 但序號標記還在的場景；marker 數等於預期段數、序列嚴格 1..N、首個 marker 前僅空白三條件全過才採用），救不回才退回逐段單獨呼叫模式。非串流、串流（流結束後補發錯位段覆蓋、內容相同段不重發）、OpenAI-compat（COMPACT／STRONG 雙 marker）三條解析路徑同套邏輯。逐段 fallback 時的 WARN log 附 `rawHead`（原始輸出頭 6000 字）供事後排查。

**實作位置**：`content.js` 的 `packBatches()` 為主要打包層，`lib/system-instruction.js` 的 `packChunks()` 為 adapter 端雙重保險層（Gemini / OpenAI-compat 共用）。v1.10.46 起 `packChunks` 由呼叫端帶入 `settings.maxUnitsPerBatch` / `maxCharsPerBatch`——原本寫死預設值，使用者調高設定後在 adapter 端被重切蓋掉（>20 段無效且無提示）。

### 3.5 429 與重試處理

client 端不做預防性節流（v2.0.64 起 API 配額管理功能移除），配額由 API 端 429 回應把關：

- **429 處理**：尊重 `Retry-After` header（等待上限 `RETRY_AFTER_CAP_MS` 30 秒，Gemini / OpenAI-compat 兩路皆同），否則指數退避 `2^n * 500ms`（上限 8 秒）
- 重試上限 `maxRetries`（預設 3，options「效能調校」可調）
- 併發由 `maxConcurrentBatches`（content 端 concurrency pool）自然限制 burst

### 3.6 術語表一致化

翻譯長文前先呼叫 Gemini 擷取全文專有名詞對照表，注入所有翻譯批次的 systemInstruction。

**策略依文章長度分三級**（由 `glossary.skipThreshold` 和 `glossary.blockingThreshold` 控制）：

- ≤ `skipThreshold`（預設 1）批 → 完全跳過，不建術語表
- `skipThreshold` < 批數 ≤ `blockingThreshold`（預設 10）→ fire-and-forget（首批不等術語表）
- \> `blockingThreshold` → 阻塞等待術語表回來再開始翻譯

**擷取 prompt**：定義在 `lib/storage.js` 的 `DEFAULT_GLOSSARY_PROMPT`，XML 結構，限定四類實體（人名/地名/專業術語/作品名），附排除規則與 JSON 格式範例。上限 `glossary.maxTerms`（預設 200）條。

**對照「只出現一次」裁剪**：tech 類 entry 的 target 依擷取 prompt 自帶「譯名（原文）」全形括號對照，且 systemInstruction 注入指令要求模型每次出現都完整輸出（EPUB 抗剝除措辭，見 `lib/system-instruction.js`）。網頁路徑由注入端確定性裁剪：`content-inject.js` 的 `trimAnnotationDedupe` 在 `injectTranslation` 統一入口對整頁第一個注入的出現保留完整對照、後續出現只留譯名（規則由 `setAnnotationDedupeRules` 從當前 run 的自動術語表建立；seen 狀態跨 SPA rescan 延續、`restorePage` 歸零；同一 keeper 元素 re-inject 不誤裁）。EPUB 路徑另由 `epub-writer.js` 的 `computeAnnotationDedupe` 處理（per-entry「對照一次」選項）。

**其他細節**：

- 輸入壓縮：只送 heading、每段第一句、caption、頁面標題（約原文 20–30%）
- 術語表快取於 `chrome.storage.local`（key `gloss_<sha1>`）；v1.8.45 起版本變更不清快取（與翻譯快取一致），popup「清除快取」會一併清除
- 術語表請求為 best-effort 單次請求，fetch 層 timeout 自保（v0.70 起）
- 逾時 `glossary.timeoutMs`（預設 60000ms），`gemini.js` 內部 fetch 層另有 `fetchTimeoutMs`（預設 15000ms，對齊主翻譯）
- 失敗或逾時 → fallback 成不帶術語表的一般翻譯
- 術語表 temperature 獨立設定（預設 1.0；Gemini 3 官方建議維持 1.0，低於 1.0 可能引發思考迴圈）
- 預設停用（`glossary.enabled` 預設 `false`），使用者可在設定頁或 Popup 開啟

### 3.7 禁用詞清單

v1.5.6 新增。針對 AI 模型容易漏網的非台灣慣用譯法、或使用者單純不希望出現在譯文中的詞彙，建立可由使用者編輯的禁用清單，作為純 prompt 注入機制——遵循硬規則 §7（中文排版偏好交給 system prompt 處理），content 端不做事後 regex replace。

**替換詞可留空**：每條只有「禁用詞」為必填，「替換詞」可留空。填了替換詞 → 要求模型改用指定詞；留空 → 只要求模型不可使用該詞，由模型自行改寫成自然的台灣慣用說法（用於「單純討厭某詞、但提不出固定替換詞」的情境，例如陳腔濫調）。

**預設清單**：25 條，定義在 `lib/storage.js` 的 `DEFAULT_FORBIDDEN_TERMS`，涵蓋常見的視頻/軟件/數據/網絡/質量/用戶/默認/創建/實現/運行/發布/屏幕/文檔/操作系統等對映，並含兩條留空替換詞的純禁用詞（沒有之一 / 橫空出世）作為範例。v1.5.6 同步修正了 v0.83 起 `DEFAULT_SYSTEM_PROMPT` 內錯誤的「進程→線程」對映（兩者都是非台灣譯法：process 在台灣應為「行程」、thread 應為「執行緒」），改在禁用詞清單分開列出兩條正確對映。

**注入位置**：`lib/system-instruction.js` 的 `buildEffectiveSystemInstruction()` 在所有其他規則（含 `fixedGlossary`）之後、systemInstruction 的最末端，以 `<forbidden_terms_blacklist>` XML tag 包起來注入。區塊內拆兩段：有替換詞的列成「禁用 → 必須改用」對照（明確指示「即使原文是英文如 video / software / data，譯文也只能使用右欄」），留空替換詞的列成「禁用（未指定替換詞）」清單（要求模型不可使用、自行改寫）。並交代「優先級高於任何 stylistic 考量」與「若該詞為文章本身討論的主題請使用引號保留原詞」的合理 escape hatch。

**Debug 偵測層**：實作於 `lib/forbidden-terms.js` 的 `detectForbiddenTermLeaks()`。`background.js` 的 `handleTranslate` 在 `translateBatch` 成功 resolve 後、回傳給 content script 之前，逐段掃描譯文是否含有禁用詞，命中時用 `debugLog('warn', 'forbidden-term-leak', ...)` 寫一筆診斷訊息（含 forbidden / replacement / sourceSnippet / translationSnippet），方便使用者從 Debug 分頁追查模型漏網案例。**純記錄、不修改譯文**。

**快取分區**：`lib/cache.js` 的 `hashForbiddenTerms()` 對清單做穩定 hash（先依 `forbidden` 欄位排序再 JSON.stringify 後 SHA-1 取前 12 字元），加進 cache key 後綴 `_b<hash>`。空清單時不附加後綴，向下相容 v1.5.5 之前的快取。完整 cache key 格式見 §9.1。

**設定 UI**：獨立的「禁用詞清單」分頁（位於「術語表」與「YouTube 字幕」之間），三欄表格（禁用詞 / 替換詞 / 備註）+ 「新增一條」/「還原預設清單」/「刪除」按鈕。匯入匯出 schema 已加入 `forbiddenTerms` 欄位，`sanitizeImport()` 會逐筆過濾無 `forbidden` 欄位的髒資料。

### 3.8 自訂 OpenAI-compatible Provider

v1.5.7 新增。除了 Gemini 與 Google Translate 兩條既有引擎，使用者可設定**一組** OpenAI-compatible 端點，接 OpenRouter（含 Anthropic / Gemini / Llama / Qwen / Grok 等百種模型）/ Ollama 本機 / Together / Groq / Fireworks / OpenAI 自家等。`translatePresets` 任一 slot 的 `engine` 設成 `'openai-compat'` 即可由對應快速鍵啟動。

**為什麼選這個介面**：chat.completions 是事實上的 lingua franca；OpenRouter 把 Anthropic / Gemini 原生 API 都已 wrap 成 OpenAI-compatible，使用者要冷門 provider 透過它就能接，不需要 Shinkansen 為每個 provider 寫獨立 adapter。

**Adapter**：`lib/openai-compat.js` 提供與 `lib/gemini.js` 介面對齊的 `translateBatch(texts, settings, glossary, fixedGlossary, forbiddenTerms)`，內部走 `POST <baseUrl>/chat/completions` + Bearer Authorization。`baseUrl` 已含 `/chat/completions` 時不重複附加。回應走 OpenAI 標準的 `choices[0].message.content` + `usage.prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens` 抽取。

**共用模組** `lib/system-instruction.js`（v1.5.7 從 `lib/gemini.js` 抽出）：`DELIMITER` / `packChunks` / `buildEffectiveSystemInstruction` 三個 helper 由 Gemini 與 OpenAI-compat 兩條 adapter 共用，確保「禁用詞清單 + 固定術語表 + 自動 glossary + 多段分隔符 / 段內換行 / 佔位符」等規則只實作一次、未來新規則只改一處。

**systemPrompt 行為**：使用者可在「自訂 Provider」分頁填獨立 `systemPrompt`，作為 `buildEffectiveSystemInstruction` 的 base（不繼承 Gemini 分頁的 `geminiConfig.systemInstruction`）。但 `fixedGlossary` 與 `forbiddenTerms` 仍由共用注入機制處理，自訂 Provider 自動享有兩者 — 改一處（術語表 / 禁用詞清單分頁）兩邊同步生效。

**API 逾時 `fetchTimeoutSec`（預設 90）**：每次 API 請求等待回應的最長秒數。預設 90 秒是為 reasoning 模型（GPT / Claude 旗艦等，非 streaming 要等整批生成完才回應）留的空間；本機 LLM（Ollama 等）冷啟動從硬碟載入模型到 VRAM 可能需要 120–300 秒，使用者可在「自訂模型」分頁自行調高。`lib/openai-compat.js` 的 `fetchWithRetry` 讀取此值乘以 1000 作為 `AbortController` timeout（ms）。範圍 5–600 秒。

**429 處理**：`fetchWithRetry` 的退避重試（OpenRouter 等 provider 端自行管理配額）。

**計價**：預設 OpenRouter GPT-5.4 Mini 價格（input 0.75 / output 4.50，2026-05 校準）。使用者改用其他 model 時需在 options 自填 `customProvider.inputPerMTok` 與 `customProvider.outputPerMTok`（USD / 1M tokens），填 0 = 不顯示費用（token 數仍會記錄）。OpenRouter / Together 等百種模型不可能內建查表。

**Cache 命中折扣**（v1.9.2）：`customProvider.cachedDiscount`（0–1，cache 命中省下的比例，預設 0.90 對齊 GPT-5.4 Mini）。UI 以百分比輸入（例：90 = 90% off）。空白 → fallback `getCustomCacheHitRate(baseUrl)` 自動推導：anthropic.com → 0.10 命中比例（90% off）、openai.com → 0.10（90% off，新世代 GPT-5+）、deepseek.com → 0.02（98% off）、x.ai → 0.20（80% off）、其他 aggregator → 0.50 中間值。

**Cache key**：base tag `_oc` + glossary hash（若有）+ forbidden hash（若有）+ `_m<baseUrlHash6>_<safeModel>`。`baseUrlHash6` 是 `baseUrl` SHA-1 前 6 字元，避免不同 provider 同 model name 共用快取（例如 OpenRouter 的 `gpt-4` vs 自架 Ollama 的 `gpt-4`）。

**API Key 儲存**：`customProvider.apiKey` 存 `chrome.storage.local`（key `customProviderApiKey`），不跨裝置同步、不在匯出 JSON 範圍內。設計理由與主 Gemini API Key 一致。

**強化段序號標記 `useStrongSegMarker`（預設 `true`）**：自訂 Provider 多段批次時，每段開頭加「<<<SHINKANSEN_SEG-N>>>」STRONG 格式序號標記，弱模型（如 gemma-4 量化版等本機量化 LLM）不會把它當自然語言誤譯為「N1、N2」洩漏到譯文。代價是每段批次多約 7 tokens（input 加 output 雙倍開銷）。商用 LLM 使用者（OpenRouter / Groq 等）可在「自訂 Provider」分頁關閉此 toggle 改用緊湊「«N»」省 token。Gemini 主路徑不受此選項影響——固定使用「«N»」COMPACT。

**`customProvider.model` 為空的行為**:`lib/openai-compat.js`（translateChunk / extractGlossary）在 model 為空字串時**不送** `body.model` 欄位,讓 server 用啟動時鎖定的 model;對應 llama.cpp / Ollama 等本機 server 沒指定 model ID 的場景。商用後端（OpenAI / OpenRouter 等）漏填會自然回 4xx「model required」,讓 provider error 自己講話。`background.js handleTranslateCustom` / `handleExtractGlossaryCustomProvider` 對齊此行為,**不**在前面提早擋空 model;`baseUrl` 仍是必填（連 endpoint 都沒有沒辦法呼叫）。

**Message protocol**:content → background 送 `TRANSLATE_BATCH_CUSTOM` 訊息（與 `TRANSLATE_BATCH` / `TRANSLATE_BATCH_GOOGLE` 對稱）走 `handleTranslateCustom`;術語表抽取送 `EXTRACT_GLOSSARY_CUSTOM`（與 `EXTRACT_GLOSSARY` 對稱）走 `handleExtractGlossaryCustomProvider`。content 端 dispatch 由 `SK.getSubtitleBatchType` / `SK.getGlossaryExtractType` 兩個 helper 集中決定路由（避免多處 inline 三元式 drift）。

**設定 UI**：獨立的「自訂 Provider」分頁（位於「術語表」與「禁用詞清單」之間）。preset 引擎下拉新增第三個選項 `「自訂 Provider（OpenAI-compatible）」`；選此引擎時 preset card 隱藏 model 下拉（model 由「自訂 Provider」分頁的設定決定，不靠 preset 欄位）。

**未來擴充空間**：當前設計「一組」自訂 provider；若未來需要「多組 named provider 讓 preset 各綁不同組」，可把 `customProvider` 改為 `customProviders: { [name]: {...} }` Map 結構，preset 加 `customProviderName` 欄位指定。

### 3.9 翻譯目標語言（Target Language）

v1.8.59 新增。Shinkansen 從「只支援 zh-TW（台灣繁中）」擴展為支援八個目標語言：zh-TW（台灣繁中）/ zh-CN（中國簡中）/ en（英文）/ ja（日文）/ ko（韓文）/ es（西文）/ fr（法文）/ de（德文）。

**設定**：`settings.targetLanguage`（合法值 8 個，見 `TARGET_LANGUAGES` 陣列），存 `chrome.storage.sync`，使用者可在工具列圖示選單（popup）的「翻譯成」選單切換（v1.9.16 起從 Options 搬到 popup，改了立刻寫 storage 不需「儲存」）。

**預設值推導**（`detectDefaultTargetLanguage()`，依 `navigator.language`）：

| navigator.language | 推導 target |
|---|---|
| `zh-TW` / `zh-Hant` / `zh-HK`（含 `zh-Hant-*`） | `zh-TW` |
| 其他 `zh-*`（`zh-CN` / `zh-Hans` / `zh-SG` / 泛 `zh`） | `zh-CN` |
| `ja*` | `ja` |
| `ko*` | `ko` |
| `es*` | `es` |
| `fr*` | `fr` |
| `de*` | `de` |
| 其他（it / pt / ru / ar / ...） | `en` |

zh-HK 走 zh-TW 的設計理由：港式繁中跟台式繁中詞彙雖有差，但比 zh-CN 簡中或英文都接近。

**Universal prompt 機制**：

| Prompt 常數 | zh-TW target | 其他 target（zh-CN / en / ja / ko / es / fr / de） |
|---|---|---|
| `geminiConfig.systemInstruction` | `DEFAULT_SYSTEM_PROMPT`（完整台灣用語規則） | `UNIVERSAL_SYSTEM_PROMPT` + `{targetLanguage}` + 末尾 target-language reinforcement |
| `translateDoc.systemPrompt` | `DEFAULT_DOC_SYSTEM_PROMPT` | `UNIVERSAL_DOC_SYSTEM_PROMPT` + `{targetLanguage}` + 末尾 target-language reinforcement |
| `glossary.prompt` | `DEFAULT_GLOSSARY_PROMPT` | `UNIVERSAL_GLOSSARY_PROMPT` + `{targetLanguage}` |
| `ytSubtitle.systemPrompt` | `DEFAULT_SUBTITLE_SYSTEM_PROMPT` | `UNIVERSAL_SUBTITLE_SYSTEM_PROMPT` + `{targetLanguage}` |
| ASR 字幕（無 user override 入口） | `DEFAULT_ASR_SUBTITLE_SYSTEM_PROMPT` | `UNIVERSAL_ASR_SUBTITLE_SYSTEM_PROMPT` + `{targetLanguage}` |

**Target-language reinforcement**：對應 Gemini Flash 已知 issue「英文 prompt 內 append target language 命令對短輸入服從度不穩」。`TARGET_LANGUAGE_REINFORCEMENT` 對 7 個非 zh-TW target 各有一條用該 target 語言寫的 task instruction（zh-CN 簡中、en 英文、ja 日文、ko 韓文、es 西文、fr 法文、de 德文），於 `getEffectiveSystemPrompt` / `getEffectiveDocSystemPrompt` 自動 append 到 universal prompt 末尾，double-tap 提高 LLM 服從度。**不**用 ALL CAPS / ALWAYS / NEVER 等絕對化指令（避免引發 over-correction）。GLOSSARY / SUBTITLE / ASR 不套（避免干擾 JSON 嚴格輸出 / 段對齊指示）。

**來源語言文字級偵測**（`SK.detectTextLang(text)`）：

> 簡繁特徵字集（`SIMPLIFIED_ONLY_CHARS` / `TRADITIONAL_ONLY_CHARS`）由 `tools/generate-zh-char-sets.mjs` 自 OpenCC 字典完備生成（BMP 內簡體特徵 2657+9 字 / 繁體特徵 3134+19 字），內嵌於 `content-detect.js` 生成區塊，勿手改。排除簡繁共用歧義字（干 / 后 / 里 / 台 / 据 / 几…繁體文本也用的字），確保「繁體短文絕不誤判 zh-Hans」優先於簡體覆蓋率。v1.9.15 的人工 curated 清單已淘汰（覆蓋缺口實例：10 字標題只含 赛 / 绝 / 击 時 simpCount=0 誤判 zh-Hant 被跳過）。
>
> **準特徵字 tier**（+N 部分）：對側語料出現 ≤ 3 次的極邊緣共用字。簡側必須通過人工安全白名單（么 / 万 / 广 / 厂 / 种 / 别…共 9 字——只收「簡體高頻、現代繁體實務不用、轉換輸出無爭議」的字；吃 / 秘 / 唇 這類繁體日常字即使語料計數低也絕不收，否則繁體誤判會轉出古字形 喫 / 祕）；繁側可全推導（誤命中方向是更保守不轉，無害）。實例：「本周看什么」全共用字、唯一變體訊號是 么（被 TWVariants 幺→么 異體收錄而遭語料排除），tier 收復後可正確偵測。

| 偵測訊號 | detected lang | isAlreadyInTarget skip 對應 target |
|---|---|---|
| htmlLang `^ja` | `ja` | `ja` |
| htmlLang `^ko` | `ko` | `ko` |
| 假名（hiragana / katakana）比例 > 5% | `ja` | `ja` |
| 韓文音節（hangul U+AC00-D7AF）比例 > 5% | `ko` | `ko` |
| CJK 比例 ≥ 0.5 + 簡體特徵字比例 ≥ 0.2 | `zh-Hans` | `zh-CN` |
| CJK 比例 ≥ 0.5 + 簡體特徵字比例 < 0.2 | `zh-Hant` | `zh-TW` |
| ASCII letter 比例 ≥ 0.5 + CJK 比例 < 0.05 | `en` | `en` |
| 其他 | `other` | （不跳） |

**es / fr / de 拉丁字母 target 的限制**：文字級無法區分英 / 西 / 法 / 德等所有拉丁字母語言（都會被 detectTextLang 統一回 `'en'`）。`isAlreadyInTarget` 對 es / fr / de target 一律 return false（讓 LLM 端處理 echo / 翻譯判斷）。Trade-off：可能會白翻幾段已是 target 語言的內容（送 LLM 後 LLM echo 回去）— 接受，避免誤跳真正需要翻的段落。

`{targetLanguage}` 注入字串由 `LANG_LABELS` 定義（如 `Simplified Chinese (China conventions, 中国用语)` / `English`）。zh-CN label 明確標 "China conventions" 讓 LLM 用中國用詞，避免混到台灣用詞。zh-CN label 內附帶的中文字串本身用簡體（`中国用语`），避免「告訴 LLM 用簡體但 label 自己是繁體」自相矛盾。

Universal prompt 內容**只放語言無關規則**（不輸出思考、保留原意、保留專名詞 / URL / code、保留 markdown / HTML inline 結構）。佔位符 `⟦N⟧…⟦/N⟧` / 段內換行 / 多段分隔符 / 禁用詞清單 / 術語表注入等屬「內部協定層」，由 `lib/system-instruction.js` 的 `buildEffectiveSystemInstruction()` 統一動態 append（target-agnostic），universal prompt 跟 zh-TW DEFAULT 一樣不重複這些。

**未客製化判定**（`getEffective*Prompt(target, userOverride)` factory）：

```
userOverride trim 為空 OR userOverride.trim() === DEFAULT_*_PROMPT.trim()
  → 視為「使用者未客製化」,走 target 對應預設
否則
  → 直接 return userOverride(尊重使用者客製化,target 切換不再影響)
```

這個設計讓既有 zh-TW 使用者升級到 v1.8.59 時：

- 若 saved 仍是舊版 `DEFAULT_SYSTEM_PROMPT` 字面值 → 視為「未客製」→ target 切換立刻反映（不需 storage migration）
- 若 saved 真的客製過 → 直接 return 使用者自訂值 → 行為跟 v1.8.58 完全一致

**禁用詞清單依 target 預設**（`getSettings()` 邏輯）：

- 使用者 saved.forbiddenTerms 已寫入 → 完全以 saved 為準（即使空陣列）
- 使用者未寫入 + target = zh-TW → `DEFAULT_FORBIDDEN_TERMS`（v1.5.6 起的 25 條台灣慣用語清單）
- 使用者未寫入 + target = zh-CN / en → 空陣列（zh-CN 不需要禁用中國用語、en 不適用）

**未客製不物化**（options.js save 端）：autosave 時禁用詞表內容等於「當前 target 的預設」（zh-TW = `DEFAULT_FORBIDDEN_TERMS` 逐條相同 / 其他 target = 空表）就不寫 `forbiddenTerms` key，並 `storage.sync.remove` 回收既有物化殘留 —— 維持上面 target-aware fallback 設計持續生效（使用者吃得到預設表更新、切 target 預設跟得上）。判斷函式 `isForbiddenTermsDefaultFor(terms, tl, defaults)`（純函式）。zh-TW 的空表 = 使用者刻意清空（停用黑名單）→ 視為已客製照寫。已知取捨：zh-TW 停用後把 target 切走再切回，停用標記會被回收、預設清單回來（停用語意只在停留 zh-TW 期間保證）。popup 切 target 時 options 的 `_syncForbiddenTermsToTarget(newTl, oldTl)` 以「舊 target 的預設」判未客製，未客製時同步 remove key（UI 與 storage 不再 desync）。

**來源語言偵測 target-aware**（v1.8.59 起 `content-detect.js`）：

- `SK.detectTextLang(text)`：純函式，回傳 `'zh-Hant' | 'zh-Hans' | 'ja' | 'ko' | 'en' | 'other'`
- `SK.isAlreadyInTarget(text, target)`：依 target 判定文字是否已是目標語言（target=`zh-TW` 跳 `zh-Hant`、`zh-CN` 跳 `zh-Hans`、`en` 跳 `en`）
- `SK.isTraditionalChinese(text)`：保留為 zh-TW 專用 alias，等同 `isAlreadyInTarget(text, 'zh-TW')`
- `STATE.targetLanguage`：content.js `translatePage()` 開頭從 storage 注入，預設 `'zh-TW'`（hydrate 前的 fallback 維持 v1.8.58 之前行為）

**YouTube 字幕「已是目標語言」跳過**（v1.8.59 起 `content-youtube.js`）：

`SKIP_LANGS_BY_TARGET` 對照表依 `STATE.targetLanguage` 切集合：

- target=`zh-TW` → 跳 `zh-Hant` / `zh-TW` / `zh-HK` / `zh-MO` / `zh-Hans` / `zh-CN` / `zh-SG`（簡中系也跳：繁中使用者可直讀簡中字幕，不花 API 簡轉繁；模糊 `zh` 軌的內容偵測補判同步——偵測到繁中或簡中都跳。僅字幕路徑，整頁翻譯的簡中段落仍照翻）
- target=`zh-CN` → 跳 `zh-Hans` / `zh-CN` / `zh-SG`
- target=`en` → 跳 `en` / `en-US` / `en-GB` / `en-CA` / `en-AU` / `en-IE` / `en-NZ`

**Cache key 區隔**（詳見 §9.1）：非 zh-TW target 加 `_lang<x>` suffix；zh-TW 不加（向下相容 v1.8.58 之前 cache）。

**自訂 OpenAI-compat Provider 路徑**（§3.8）：v1.8.59 同走 `getEffectiveSystemPrompt(target, customProvider.systemPrompt)`（跟 Gemini 主翻譯路徑對齊）。`handleTranslateCustom` 內 wrap effective prompt 後傳給 `lib/openai-compat.js translateChunk`；cache key 加 `_lang<x>` suffix（zh-TW 不加維持向下相容）。Options「自訂模型」分頁的「翻譯 Prompt」textarea 同樣納入 `_syncPromptTextareaToTarget` listener。

**P1 Launch 範圍說明**：

- ✅ 翻譯目標語言（zh-TW / zh-CN / en）
- ✅ 來源語言偵測 target-aware
- ✅ Cache key 區隔
- ✅ Extension UI 字串 i18n（zh-TW / zh-CN / en / ja / ko / es / fr / de 八語 UI）— v1.8.60 P2（三語）+ v1.8.62 P3（補 5 語），詳見 §3.10
- ✅ 商店素材多語 listing — `_locales/{zh_TW,zh_CN,en,ja,ko,es,fr,de}/messages.json` 八語齊備（v1.8.62）

### 3.10 UI Localization（i18n，P2 / P3）

擴充功能 UI 字串支援 8 語（zh-TW / zh-CN / en / ja / ko / es / fr / de），與翻譯目標語種完全對齊。UI 語言由獨立的 `settings.uiLanguage` 偏好控制，**跟翻譯目標 `settings.targetLanguage` 解耦**——可以「英文介面 + 翻譯目標繁中」或「日文介面 + 翻譯目標西文」等任意組合。

**`settings.uiLanguage` 合法值**：

| 值 | 行為 |
|---|---|
| `'auto'`（預設） | 由 `resolveUiLanguage(navigator.language)` 推導：`zh-TW` / `zh-Hant` / `zh-HK` 系 → `zh-TW`；其他 `zh-*` → `zh-CN`；`ja` / `ko` / `es` / `fr` / `de` → 對應；其他 → `en` |
| `'zh-TW'` / `'zh-CN'` / `'en'` / `'ja'` / `'ko'` / `'es'` / `'fr'` / `'de'` | 強制鎖到該語言，不受 `navigator.language` / `targetLanguage` 影響 |

8 語 UI dict 全到位後，fallback 到 `en` 僅在 `navigator.language` 未命中任何已知語族時觸發。原 v1.8.60 P2 第一版的「UI 跟著 target 切」設計已撤回，因為使用者可能想用 en 介面但翻成繁中（或反之），雙設定獨立。

**自製 dict 而非 `chrome.i18n`**：Chrome 原生 `chrome.i18n` 綁瀏覽器 locale，無法跟 target 連動（使用者瀏覽器 zh-TW、把翻譯目標切 en，UI 仍會跟瀏覽器走繁中），故走自製 dict。`_locales/{zh_TW,zh_CN,en,ja,ko,es,fr,de}/messages.json` 維持 Chrome Web Store / AMO 商店 listing 用的 `extName` / `extDescription` 兩條最小集，目前 8 語齊備。

**Dict 結構**（`shinkansen/lib/i18n.js`）：

| 區塊 | 來源 |
|---|---|
| `messages_zhTW` | source of truth，人工撰寫 |
| `messages_zhCN` | Claude 直翻（v1.8.60 一次完成；原 `tools/translate-i18n-dict.js` Gemini build 對長 prompt 偶發截斷，留作備案不主動跑） |
| `messages_en` | 同上 |
| `messages_ja` / `messages_ko` / `messages_es` / `messages_fr` / `messages_de` | Claude 直翻（v1.8.62 P3 一次補齊） |

每組 dict 約 483 條 entry，key 對齊；t() 內三層 fallback：`[TABLES[lang], TABLES[FALLBACK_LANG], TABLES['zh-TW']]`，`FALLBACK_LANG = 'en'`，最終 fallback 為 zh-TW（避免任何 key 缺漏導致 UI 顯示空字串）。

**API**：`window.__SK.i18n` export `{ t, applyI18n, getUiLanguage, subscribeUiLanguageChange, _tables, _supported }`。content scripts 同步 alias 為 `window.__SK.t`。

- `t(key, params, target)`：查表 + `{name}` placeholder 替換（regex `\{(\w+)\}`）
- `applyI18n(rootNode, target)`：掃 `[data-i18n]`（textContent）/ `[data-i18n-html]`（innerHTML）/ `[data-i18n-attr-<attrName>]`（屬性）三類元素注入
- `subscribeUiLanguageChange(cb)`：訂閱 `chrome.storage.onChanged` 對 `uiLanguage` 的變動，觸發 reapply

**整合點**：

| 模組 | 整合方式 |
|---|---|
| popup（`popup.js`） | init 讀 storage targetLanguage → applyI18n + subscribe + 5 語 fallback banner show/hide |
| options（`options.js`） | init applyI18n + subscribe；#targetLanguage picker change 同步寫 storage 並 reapply（picker 自身與 subscribe callback 雙觸發,任一可獨立 reapply） |
| content scripts（`content.js` / `content-spa.js` / `content-youtube.js`） | 22 條 toast 改 `SK.t('toast.X', { ... })`；targetLabel 改查 `lang.X` dict key 動態取 |
| manifest | `content_scripts.js` 加 `lib/i18n.js`（在 `content-ns.js` 之後，其他子模組之前） |

**Regression 覆蓋**（`test/regression/i18n-*.spec.js` 6 條）：

- `i18n-popup-language-switch.spec.js`：popup 依 `uiLanguage` 切 dict（zh-TW / zh-CN / en）、`uiLanguage='auto'` 走 navigator 推導、#shortcut-hint 動態 textContent 元素也跟 UI 語系切
- `i18n-options-language-switch.spec.js`：options 依 `#uiLanguage` picker 切 dict + tab-bar wrap 視覺斷言
- `i18n-toast.spec.js`：`SK.t('toast.X')` 依 `STATE.uiLanguage` 優先 / `STATE.targetLanguage` 後備切語言（content scripts 場景）
- `i18n-fallback-key-missing.spec.js`：getUiLanguage 三層 fallback + 不存在 key 回傳 key 本身 + placeholder 替換
- `i18n-forbidden-target-aware.spec.js`：Options「禁用詞清單」依 target 預設（zh-TW → 25 條 / 其他 → 空 / saved 尊重 / 切 picker 未客製自動切、已客製保留）
- `i18n-ui-language-pref.spec.js`：`uiLanguage` 偏好獨立於 target（`uiLanguage=zh-TW + target=en` → UI 仍繁中、切 #targetLanguage 不影響 UI、`'auto'` 解析、#uiLanguage picker 立刻寫 storage）

**禁用詞清單 UI 與 storage 對齊**（v1.8.60 P2 附帶修補）：之前 options.js 用 `s.forbiddenTerms`（已 spread DEFAULTS）→ 永遠 25 條，UI 跟 storage.js getSettings() 的 target-aware fallback drift。修法改用 `saved.forbiddenTerms`（只看 storage 實際寫入）+ target-aware fallback（zh-TW → DEFAULT、其他 → 空），對齊 §3.9「禁用詞清單依 target 預設」。切 target picker 時透過 `isForbiddenTermsDefaultFor(terms, tl, defaults)`（target-aware：zh-TW 空表 = 刻意停用 = 已客製）判斷是否「視為未客製」，自動切；已客製化保留使用者編輯。未客製判定與 save 端「未客製不物化」共用同一函式（見 §3.9）。

### 3.11 送到 Instapaper（下游 reader 整合）

把目前（已就地翻譯）的整頁送進使用者自己的 Instapaper 帳號。選用功能，**預設關**。

- **引擎**：Instapaper Full API（OAuth 1.0a + xAuth），`lib/instapaper.js`。走 Full API（非 Simple `/api/add`）是因為要把我們用 Readability 抽好的乾淨譯文正文，經 `bookmarks/add` 的 `content` 參數送出 → 存進去的是譯文版文章；Simple API 只吃網址會讓 Instapaper 重抓原文（未翻譯）。**不設** `is_private_from_source`：影片綁架的真因是 frame 廣播（見訊息協定），不是 Instapaper re-crawl；實測帶 content、不帶該參數，Instapaper 即用我們的 content 且保留原始 source URL 連結（設了會變 private 且失去連結）。
- **consumer 金鑰**：app 層 consumer key/secret 放 gitignored 的 `lib/instapaper-keys.js`（掛 `globalThis.__SK.INSTAPAPER_KEYS`，popup/options 以 classic `<script>` 載入、background 用 dynamic `import()` 載入並容忍缺檔）。public repo 不 commit 金鑰。
- **連結（xAuth）**：options 頁填 Instapaper email + 密碼一次，`instapaperXAuth` 換取 OAuth token；**只存** `instapaperToken` / `instapaperTokenSecret` / `instapaperUsername` 到 `storage.sync`，密碼用完即丟。連結的 fetch 由 options 頁直接發。
- **設定欄位**：`DEFAULT_SETTINGS.instapaperEnabled`（boolean，預設 false）。token 三鍵不在 DEFAULT_SETTINGS，連結後才寫 `storage.sync`。
- **訊息協定**：
  - content `EXTRACT_PAGE_HTML` → 回 `{ ok, url, title, html }`（`SK.extractPageHtml`）。**只由最上層 frame 回應**：content script 以 `all_frames` 注入，頁內嵌入的 iframe（youtube-nocookie 等）也跑同一份 content script；`browser.tabs.sendMessage` 未指定 frameId 會廣播到所有 frame，內嵌影片 iframe frame 搶先回應會把「影片嵌入頁的文件」當主文送出（存成影片）→ 子 frame（`window.top !== window`）一律不回應。擷取用 vendored Readability（`lib/readability.js`，`@mozilla/readability` Apache-2.0 + 中文頓號 `、` 評分 patch）在 `document` 的 clone 上抽正文：先剝擴充注入 UI（`#shinkansen-toast-host`/`#shinkansen-dual-style`）與媒體嵌入（`iframe/video/audio/object/embed/lite-youtube`——避免中文譯文字元數少時、被保留的影片 iframe 反超整篇被選成正文）再跑 Readability，輸出再套硬化（剝註解／去重標題／段落 `div`→`p`／空殼修剪）並包成完整 HTML 文件。Readability 抽不到的罕見頁面退回 `SK.extractPageHtmlLegacy`（舊整頁 `documentElement` 剝除）。
    - **標題**（`SK.pickExtractTitle`）：取譯文標題而非 `document.title`——single mode 不動 `<head><title>`/og:title，譯文標題在已就地翻譯的主 `<h1>`（優先 `main`/`article`/第一個 `<h1>`，沒 h1 退回 `document.title`）。同時改寫 clone 的 `<head><title>` 為譯文標題（雙保險）。
    - **去重複標題**：移除 content 內與 title 同字的主 `<h1>`——下游 reader 用 title 參數另渲染一行標題，body 再留同字 h1 會出現重複標題。只移除「正規化文字 === title」的那個主 h1。
  - background → content `INSTAPAPER_TOAST`（`status`: `sending`/`sent`/`not-enabled`/`failed-auth`/`failed-network`/`failed`）供快捷鍵路徑回饋（無 popup → 走 content toast）。
- **兩條觸發路徑**（共用 `lib/instapaper.js` 的 `saveToInstapaper`）：
  - **popup 按鈕** `#send-to-instapaper-btn`（`instapaperEnabled && 已連結` 才顯示）→ popup 直接 `saveToInstapaper`（避開 iOS 背景 event page 掛起）。
  - **快捷鍵 Alt+I**（`commands.send-to-instapaper`）→ background `onCommand` → 取 active tab `EXTRACT_PAGE_HTML` → 背景 `saveToInstapaper`，enable gate 未連結時 `not-enabled` toast no-op。
- **host_permissions**：`https://www.instapaper.com/*`。
- **i18n**：`options.instapaper.*` / `popup.action.sendToInstapaper` / `instapaper.*`（toast）八語齊備。
- **回歸測試**：`test/unit/instapaper-oauth.spec.js`（RFC 5849 §3.4.1 base string 向量 + OAuth 1.0 A.5.2 HMAC-SHA1 簽章向量 + payload / parse / mock fetch 分支）、`test/regression/extract-readability-instapaper.spec.js`（Readability 路徑：縮到正文、剝影片嵌入、標題取譯文 h1、去重標題）、`test/regression/extract-page-html.spec.js`（legacy fallback 路徑剝除 / 保留斷言）。frame 廣播搶答路徑需真實多 frame + 訊息廣播時序、harness 測不到，記入 `PENDING_REGRESSION`。

> OAuth 簽章細節、Readability 選型與 frame 廣播根因、is_private_from_source 取捨、human review 卡關等設計脈絡見 SPEC-PRIVATE / `PLAN-send-to-instapaper.md`（本機）。

### 3.12 簡繁本地互轉（OpenCC 字典，免費）

target 為中文變體時，偵測為**相反變體**的段落不送 LLM，改走本地 OpenCC 字典轉換——免費、即時、不需 API Key、離線可用。

**方向對映**（`content.js` translatePage 依 `targetLanguage` 決定）：

| target | convertDirection | 轉換內容 |
|---|---|---|
| `zh-TW` | `cn2twp` | 簡體 → 台灣繁體含慣用詞（軟件→軟體、視頻→影片、內存→記憶體） |
| `zh-CN` | `twp2cn` | 台灣繁體 → 簡體（先還原慣用詞再簡化） |
| 其他 | `null` | 不分流，全走 LLM |

**分流機制**：`SK.translateUnits` 在 dedup 後按 `SK.isConvertibleVariant(text, direction)` 分組（translatePage convertOnly 過濾共用同一判定）——`detectTextLang` 判為相反變體是強訊號直接可轉；另有中英混排放寬：CJK ≥ 2 字、CJK 佔字母數 ≥ 0.3、變體特徵字單邊乾淨（處理「视频｜正面对决！大疆 OSMO nano…」標題與「传感/MEMS」分類標籤這類英文字母壓過 CJK 被 `detectTextLang` 判 `'other'` 的短文），拉丁為主夾帶少量中文的英文句（ratio < 0.3）不轉、照送 LLM。另外 `_foreignPage`（短文收集放寬的前提訊號）對無 `<html lang>` 宣告的頁面以 `document.title` 文字級偵測推導——僅在「target 為中文變體且 title 為相反變體」時視為 foreign（零誤判訊號；簡中新聞站常不宣告 lang，原本短 tag anchor 過不了 20 字門檻永遠不轉），其他語言組合維持保守。可轉段落送 `CONVERT_ZH_LOCAL`，其餘照走 LLM batch（混合頁兩路並存，注入共用同一條 `injectTranslation` + dup broadcast + idle gate 路徑）。佔位符 `⟦N⟧` 非漢字不受轉換影響。轉換結果**不寫 `tc_` 快取**（即時免費，不佔快取池），也不寫 usage-db（零 API 用量）。

**殭屍 marker reconcile**：`collectParagraphs` 起點對已標記元素做驗證——target 為中文變體時，標記元素內容仍偵測為相反變體（`isConvertibleVariant`）＝marker 是殭屍（SPA 站內導航時 framework 重用 DOM 元素渲染新文章原文，reset 清了 STATE maps 但 marker 與 per-element `lang` 屬性留在元素上，收集會雙重跳過）→ unmark + 清 target 家族的 per-element lang + 清 STATE 殘影，本輪照常重收轉換。dual 模式安全（雙語內容變體特徵不單邊乾淨，不會命中）。

**convertOnly 模式**（簡繁自動互轉路徑）：只跑本地轉換組，不可轉換段落（英文等）保持原文，**絕不打 API**——`autoConvertZh` toggle 開啟時頁面載入 / SPA 導航自動以此模式執行；頁面無可轉換段落時靜默結束（無 toast / badge）。背景行為靜默三則：collect=0（SPA 未渲染 / 純英文頁）不跳 noContent toast；離線照常執行（本地轉換不需網路）且不跳離線提示；Google Docs 頁不觸發 mobilebasic 自動導向（導向留給手動翻譯）。成功後 `STATE.translationContext.provider = 'opencc-local'`（rescan 新內容續走本地轉換），**不設** `stickyTranslate`（免費路徑不得經 sticky replay 觸發 LLM 整頁翻譯）。混合頁完整翻譯（手動觸發）的 `translationContext` 帶 `convertDirection`，rescan 延續分流。

**設定**：`settings.autoConvertZh`（bool，預設 `false`，`chrome.storage.sync`）。popup toggle「簡繁自動互轉（免費）」只在 target 為 zh-TW / zh-CN 時顯示（`_updateAutoConvertZhRow` 與「翻譯成」picker 連動）。

**Toggle 即時生效**：popup change handler 寫入 storage 後對 active tab 發 `SET_AUTO_CONVERT_ZH { enabled }`——勾選：本頁未翻譯時立即跑 convertOnly（不適用頁面靜默結束）；取消：**僅當本頁是本地轉換結果**（`STATE.translatedBy === 'opencc-local'`）時 `restorePage()` 還原，LLM 翻譯成果不受影響。

**Toast**：convertOnly 完成 `toast.zhConvertDone` + detail `toast.zhConvertFree`（免費未使用 API）；混合頁完整翻譯 detail 追加 `toast.zhConvertPartial`（其中 N 段本地轉換）。

**實作檔案**：`lib/zh-convert.js`（background ES module：conversion chain 定義、字典 lazy fetch、converter cache）+ `lib/vendor/opencc/`（Trie 轉換核心 `opencc-core.js` + `dict/*.txt` 字典 10 檔，約 1.1MB；來源與授權見 `THIRD-PARTY-NOTICES.md`，再生工具 `tools/vendor-opencc.mjs`）。字典於 background 首次轉換時 `fetch(runtime.getURL())` lazy load（MV3 SW 禁 dynamic import），SW 啟動零成本。

**測試**：`test/regression/inject-zh-convert-local.spec.js`（真 background 真字典端到端：convertOnly 零 LLM 呼叫 + 無 Key 前置、混合頁分流不越界、autoConvertZh 載入自動轉換）。

---

## 4. 翻譯顯示規格

### 4.1 顯示模式

兩種模式並存，由 `displayMode` 設定切換（popup toggle 即時切換、寫入 `chrome.storage.sync`）：

- **`single`（預設，單語覆蓋）**：將原文段落的文字節點替換成譯文，元素本身保留不動。所有 v1.4 之前的 injection 行為（媒體保留、`resolveWriteTarget` MJML 救援等）都走此路徑。
- **`dual`（雙語對照，v1.5.0 新增）**：原文保留，譯文以 `<shinkansen-translation>` wrapper 形式 append 在原段落之後/內。原段落 `textContent` / `innerHTML` 完全不動。

**雙語對照規格**（`shinkansen/content-inject.js` 的 `SK.injectDual`）：

| 原元素類型 | wrapper 位置 | wrapper 內部 tag |
|----------|-------------|----------------|
| 一般 block （`<p>` / `<div>` / `<blockquote>` / `<pre>` 等） | `original.insertAdjacentElement('afterend', wrapper)` | 同原 tag |
| `<h1>`–`<h6>` | 同上 | `<div>`，inline style 從原 heading 繼承 `font-size` / `font-weight` / `line-height`（避免 SEO/AT 重複標題） |
| `<li>` | `originalLi.appendChild(wrapper)`（避免 `<ol>` 編號錯位） | `<div>` |
| `<td>` / `<th>` | `originalCell.appendChild(wrapper)`（避免 table 對齊跑掉） | `<div>` |
| Inline 元素（被偵測為段落時的 `<span>` / `<a>` 等） | 往上找最近 block 祖先（computed `display` ∈ {block, flex, grid, table, list-item, flow-root}），block 祖先的 afterend | `<div>` |

**視覺標記**：wrapper 上以 `data-sk-mark` attribute 區分 4 種樣式（由 `translationMarkStyle` 設定）：

- `tint`（預設）—— 淡黃底色 `#FFF8E1`
- `bar` —— 左邊細條 `border-left: 2px solid #9CA3AF`
- `dashed` —— 虛線底線 `border-bottom: 1px dashed #9CA3AF`
- `none` —— 無標記

樣式由 `SK.ensureDualWrapperStyle()` 動態 inject `<style id="shinkansen-dual-style">` 到 `<head>`，每頁僅注入一次。

**翻譯內容重建**：dual 模式仍走 `serializeWithPlaceholders` → `deserializeWithPlaceholders` 流程，inline 結構（`<a href>`、`<strong>`、`<em>` 等）完整保留進 wrapper inner。

**還原**：`restorePage()` 依 `STATE.translatedMode` 分派——`single` 走原本反向覆寫；`dual` 直接 `document.querySelectorAll('shinkansen-translation').forEach(n => n.remove())`，原段落不動。

**Content Guard dual 分支**：`STATE.translationCache: Map<originalEl, { wrapper, insertMode }>` 追蹤每個 wrapper 的當初插入位置。若 SPA framework 把 wrapper 從 DOM 拔掉，Content Guard 依 `insertMode`（`afterend` / `append` / `afterend-block-ancestor`）把同一個 wrapper element re-append 回去，不重新呼叫 LLM。

**Content Guard 外部暫停（JRead 閱讀模式握手）**：姊妹擴充功能 JRead 進入閱讀模式時，會把被 Shinkansen 翻譯過的 `articleEl` 重排成閱讀卡片；此時 Content Guard 每秒 sweep 會把重排後的 `articleEl` 誤判成「譯文被 SPA 覆蓋」而重建子節點 → 使用者畫面每秒閃動（僅在 translate-first 後進閱讀模式才發生；閱讀卡片即 `articleEl` 本身、在 guard 管轄區內，JRead 端無法閃避）。修法採跨擴充功能握手：JRead 進 / 出閱讀模式時對頁面 dispatch `jread-reader-mode` CustomEvent（`detail.active` 布林，跨 extension content script、同 `shinkansen-debug-request` 的 CustomEvent 機制）；`content.js` 監聽後呼叫 `SK.setContentGuardPaused(active)` 切換 `content-spa.js` 的 `contentGuardExternallyPaused` 旗標。讓位範圍：`onSpaObserverMutations` 整段早退；`runContentGuard` 只停會重建子樹的 innerHTML / dual 軌，**nodeValue-mutate 軌（`runContentGuardNvMutate`）保留 sweep**（reapplyOnly 模式：只做零 API 的原地重套、不 unmark + rescan）——nv 軌純改 text node `nodeValue`、不動結構不會閃，保留它讓閱讀模式期間 framework 把譯文打回原文（NYT React figcaption 間歇 re-render 實測）能在 1s 內原地修復。恢復（`active:false`）當下立即跑一次全量 `runContentGuardNvMutate(ignoreViewport=true)` 補課，接住暫停期間漏掉或 reapplyOnly 跳過（內容已變、需 unmark 重翻）的 entry。暫停期間不停 interval、不 `stopSpaObserver`，退出閱讀模式恢復後立即接續。`_spaDebug()` 多回 `contentGuardExternallyPaused` 供查。

**nv-mutate 軌介入判準與停損**：sweep 介入條件為三判準取或——backup node 全 detach（`allDetached`）／畫面含任一 backup 原文值（`nvMutateRevertedToOriginal`，部分重繪）／**`el.textContent` 空白正規化後等於 `STATE.originalText`（`nvRevertedToOrigText`，不依賴 backup refs 與值）**。第三判準是必要的：backup 的 `originalValue` 在多輪 guard 重建後可能 stale（重建當下畫面是混合態），framework 用 reuse-node 把全段打回原文時前兩判準都不成立，會永久跳過。**健康譯文守門（判準之前先擋）**：backup 完好（所有 backup text node 仍 connected 且 `nodeValue === translatedValue`，`nvBackupIntact`）或 `el.textContent` 去空白後等於純文字譯文（`nvTextEqualsPlain`）→ 畫面已是譯文，sweep 直接跳過——譯文逐字保留原文專有名詞（人名／品牌名）時 `nvMutateRevertedToOriginal` 的 includes 判準會對健康譯文誤報，沒有守門會把好譯文重套成 flatten（見下）。每元素介入停損為**滾動視窗**：60 秒視窗內最多 8 次（`nvGuardTryIntervene`，距上次介入超過 60s 歸零重計）——高頻 ping-pong（站方持續對抗）照樣 8 次就停，但長閱讀 session 的偶發重繪不會耗盡額度造成「標 translated、畫面永遠原文」終態，停損打滿 60s 後也會重新放行自癒。nv 軌 sweep 對 `contenteditable="true"` 元素豁免（對齊 innerHTML 軌的編輯模式豁免）。

**nv-mutate 軌重套保留 inline 結構**：`STATE.nvMutateTranslation` 記錄形式為 `{ plain, raw, slots }`——`plain` 是剝掉佔位符的純文字譯文，`raw` ＋ `slots` 在 Layer A1/A3（帶 slots 同構配對）注入成功時一併記錄（A3.5 純文字 fallback 只記 `plain`）。guard sweep 與 Layer A4 的重套統一走 `nvReapplySaved`：先以 `raw` ＋ `slots` 重走 A3 同構配對（framework 打回原文後段落結構與首翻相同，配對成功則各 text node 原地換譯文、`<a>` 等 inline 元素結構保留），配對不成才 fallback 純文字重套（slots=[] 的整段塞第一個 text node、其餘清空——含連結的段落會退化成純文字，內容不遺失但失去可點性）。修復場景：prose 段落內嵌多個 inline `<a>`，站方重繪打回原文後 guard 補課，舊行為只有純文字可用、一律 flatten 成空殼連結。

**YouTube 字幕**：`content-youtube.js` 維持單語字幕替換路徑，不支援 dual。

**YouTube 字幕字級 scale**（`ytSubtitle.captionScale`，%，預設 100 = 跟隨各平台原生字幕大小）：全平台統一旋鈕，一個值套**三條渲染路徑**——(1) overlay（ASR／雙語,桌面／macOS／iOS 視窗內）：乘到 `--sk-cue-size`（原生字級 px × scale／100，`_scaledCueSizePx`）；(2) YouTube 視窗內原生字幕 `.ytp-caption-segment`（內建字幕單語譯文 **以及** YouTube 自家字幕／帳號層級自動翻譯——後者 Shinkansen 沒接手寫字幕,光靠 `_setSegmentText` hook 接不到）：scale≠100 時啟動 `_captionScaleObserver`（觀察 `#movie_player` subtree,rAF 合併）持續把畫面上任何 segment 套成設定大小（`_applyScaleToSegment`：`dataset.skBaseFs` 捕捉 YouTube 原始基準避免回授、值相同不重設不自觸發迴圈）;scale=100 停掉 observer + 還原 base（零殘留）。`_setSegmentText` 寫譯文時也順手套一次（Shinkansen-active 即時生效）；(3) iPhone／iPad 原生全螢幕（`webkitEnterFullscreen`，overlay 被系統播放器取代）：注入 `video::cue { font-size: <captionScale>% }`（真機驗證 iOS 原生全螢幕套用網頁 `::cue`；Safari 18.2 起系統預設字幕樣式可被網頁覆寫）。設定位於 **popup**，僅在 YouTube 影片頁（`youtube.com/watch`）顯示；change handler 寫 `ytSubtitle.captionScale`，content-youtube.js `onChanged` 即時套用（`_applyYtCaptionScale`：重套 overlay `--sk-cue-size` + 逐個原生 segment + iOS `::cue`）。預設 100 = 三條路徑全零改變（`_applyScaleToSegment` 在 scale=100 且未套過時完全不碰 segment）。

**模式切換時機**：popup 切換 displayMode 時若已翻譯，content script 收到 `MODE_CHANGED` 訊息會顯示提示 toast，要求使用者按快速鍵重新翻譯以套用；當前頁面不動（避免半翻半改）。下次 `translatePage` 進入時讀取最新 `displayMode` 寫進 `STATE.translatedMode` 鎖定本次模式。

### 4.2 替換策略

依元素內含的內容走兩條路徑，共用 `resolveWriteTarget()` + `injectIntoTarget()` 兩個 helper：

**`resolveWriteTarget(el)`**：回答「要把譯文寫到哪個元素」。預設回傳 `el` 自己；若 `el` 的 computed `font-size < 1px`（MJML email 模板常見），改回傳第一個 font-size 正常且非 slot 系元素的後代。descent 時整個 slot subtree 以 `FILTER_REJECT` 跳過（含子孫）。

**`injectIntoTarget(target, content)`**：回答「怎麼寫進 target」。預設走 clean slate（清空 children 後 append）；若 target 含媒體元素（img/svg/video/picture/audio/canvas），改走「就地替換最長文字節點」保留媒體。

**路徑 A — 含可保留行內元素**：

1. `serializeWithPlaceholders(el)`：遞迴把行內元素換成 `⟦N⟧…⟦/N⟧` 佔位符（支援巢狀），slot 存 shallow clone
2. LLM 翻譯純文字，佔位符原樣保留
3. `selectBestSlotOccurrences(text)`：處理 LLM 重複引用同一 slot 的情況（挑首次非空出現為 winner，其餘降級為純文字）
4. `deserializeWithPlaceholders(translation, slots)`：遞迴 `parseSegment()` 重建 DocumentFragment
5. `replaceNodeInPlace(el, frag)`：透過 `resolveWriteTarget` → `injectIntoTarget` 注入

驗證採寬鬆模式：至少一對佔位符配對即視為成功，殘留標記由 `stripStrayPlaceholderMarkers` 清除。`normalizeLlmPlaceholders`（反序列化與 strip 前置）除全形替代括號（❰❱）外，亦修復畸形閉合括號（`⟦/2»` → `⟦/2⟧`，含段尾漏寫）並收斂「兩個 CJK 字元之間只隔著標記與空白」的模型幻覺空格（v2.0.53；\n 與 CJK/拉丁邊界空格不動）。

**路徑 B — 無可保留行內元素**：

`replaceTextInPlace(el, translation)`：透過 `resolveWriteTarget` → `injectIntoTarget` 注入。含 `\n` 時用 `buildFragmentFromTextWithBr` 產生帶 `<br>` 的 fragment。

**`<br>` ↔ `\n` round-trip**：序列化時用 sentinel `\u0001` 標記來自 `<br>` 的換行，與 source HTML 排版空白區分。normalize 先收所有原生 whitespace 為 space，再把 sentinel 還原為 `\n`。反序列化時 `\n` 還原為 `<br>`。

### 4.2.1 可保留行內元素清單

`PRESERVE_INLINE_TAGS`：A, STRONG, B, EM, I, CODE, MARK, U, S, SUB, SUP, KBD, ABBR, CITE, Q, SMALL, DEL, INS, VAR, SAMP, TIME

`SPAN`：僅當帶有 `class` 或非空 `style` 屬性時才保留。

**原子保留（`isAtomicPreserve`）**：`<sup class="reference">` 整個 deep clone 進 slot，用自閉合 `⟦*N⟧` 取代，內部文字不送 LLM。

佔位符字元：`⟦` (U+27E6) 與 `⟧` (U+27E7)。配對型 `⟦N⟧…⟦/N⟧`，自閉合 `⟦*N⟧`。

### 4.3 還原機制

`STATE.originalHTML`（Map，el → innerHTML）備份每個被替換元素的原始 HTML。再次按 Option+S 呼叫 `restorePage()` 逐一還原。

**頁面層級 `<html lang>` 對齊**：single mode 翻譯成功後，`documentElement` 的 `lang` 設為 `targetLanguage`（`SK.applyDocTargetLang()`，`STATE.docLangBackup` snapshot-once 備份原值）——per-element lang（`applyTargetLocaleStyling`）只蓋注入段落，頁面層級 lang 是給讀整份文件的下游 scraper（Readwise Reader / Instapaper 等）與 a11y 工具看的。`restorePage()` 與 SPA 導航 reset 呼叫 `SK.restoreDocLang()` 還原原值（原本沒設 attribute 就 removeAttribute）。dual mode 不動（頁面同時含原文與譯文，標 target 語意不對）。

### 4.4 視覺樣式

原文元素的 font-family、font-size、color、layout 完全不動。不加邊框、背景、左邊線等任何裝飾。

---

## 5. 段落偵測規則

### 5.1 納入的 block tags

```
P, H1, H2, H3, H4, H5, H6, LI, BLOCKQUOTE, DD, DT,
FIGCAPTION, CAPTION, TH, TD, SUMMARY,
PRE, FOOTER
```

### 5.2 硬排除

- **Tags**（整個子樹不走）：SCRIPT, STYLE, CODE, NOSCRIPT, TEXTAREA, INPUT, BUTTON, SELECT
- **PRE 條件排除**：含 `<code>` 子元素時視為程式碼區塊跳過；不含 `<code>` 的 `<pre>` 視為普通容器，納入 walker（見 §5.1）
- **語意容器**：FOOTER 在無 `<article>` / `<main>` 祖先時跳過（站底 footer）；有祖先時視為內容 footer 放行（見 §5.1）
- **ARIA role**：祖先鏈含 `contentinfo` / `search` / `grid` / `tree` / `treeitem` 則跳過。`<footer>` 與 `contentinfo` 另有簡繁轉換放行：內容取樣（400 字）為「相反中文變體」時不排除——footer 排除是省 LLM token 的成本政策，對免費本地轉換不適用（簡中頁全轉只剩頁尾留簡體視覺突兀）；英文站 footer 不符合判準、排除照舊。`banner` 僅在「`<header role="banner">` tag + role 雙訊號」時排除——ARIA 規範的 banner 是網站 masthead，但中文新聞站常把首頁 hero 內容區誤標 `role="banner"`（DIV），硬排除會整棵殺掉主內容，故單獨 role 不排、交給偵測與 prompt

**不做內容性 selector 排除**：content.js 不以 class/selector 判斷「該不該翻」。此類判斷交給 Gemini systemInstruction。

### 5.3 選擇器補抓（`INCLUDE_BY_SELECTOR`）

```
#siteSub, #contentSub, #contentSub2, #coordinates,
.hatnote, .mw-redirectedfrom, .dablink, [role="note"], .thumbcaption,
[data-testid="tweetText"],
[data-testid="card.layoutLarge.detail"] > div,
[data-testid="card.layoutSmall.detail"] > div,
.wp-block-post-navigation-link
```

### 5.4 Mixed-content fragment 單位

若 block 元素既有直接文字又含 block 後代（如 `<li>` 含巢狀 `<ul>`），walker 先讓 block 子孫獨立處理，再用 `extractDirectTextFragment()` 從父元素收集「不屬於任何 block 後代」的直接文字（含夾在中間的行內元素），建立虛擬 fragment 單位。fragment 單位注入時走原節點就地替換，不新增 DOM 容器。

### 5.5 可見性過濾

`isVisible(el)` 排除 `display:none`、`visibility:hidden`、`getBoundingClientRect()` 面積為零的元素。候選文字須含拉丁字母、CJK 或數字才算有效。

---

## 6. 專案檔案結構

```
shinkansen/
├── manifest.json
├── content-ns.js             # 命名空間、共用狀態 STATE、常數、工具函式
├── content-toast.js          # Toast 提示系統（Shadow DOM 隔離）
├── content-detect.js         # 段落偵測（語言偵測、容器排除、collectParagraphs）
├── content-serialize.js      # 佔位符序列化/反序列化（⟦N⟧…⟦/N⟧ 協定）
├── content-inject.js         # DOM 注入（resolveWriteTarget、injectIntoTarget）
├── content-spa.js            # SPA 導航偵測 + Content Guard + MutationObserver
├── content-youtube-main.js   # YouTube XHR 攔截（MAIN world，document_start）
├── content-youtube.js        # YouTube 字幕翻譯（isolated world）
├── content-fw-detect-main.js # main world framework 偵測 bridge（isolated world 看不到 React expando，CustomEvent 橋接，MAIN world）
├── content-drive.js          # Google Drive 影片 ASR 字幕翻譯（top frame 浮層 overlay）
├── content-drive-iframe.js   # Drive ASR 字幕 URL 偵測（youtube.googleapis.com/embed iframe）
├── content-touch.js          # iOS 四指 tap 手勢（IS_IOS_BUILD gate，桌面 build 為 no-op）
├── content.js                # 主協調層（translatePage、Debug API、初始化）
├── content-shortcuts.js      # 自訂快速鍵 keydown capture 比對 → 本地 dispatch（§10.1）
├── content-floating-icon.js  # 懸浮翻譯控制按鈕（floating action button，頁面左／右緣常駐浮動 icon）
├── content.css
├── background.js             # Service Worker（ES module）
├── privacy-policy.html       # 隱私權政策（繁中）
├── privacy-policy.en.html    # 隱私權政策（英文）
├── LICENSE                   # ELv2
├── THIRD-PARTY-NOTICES.md    # 第三方授權聲明
├── lib/
│   ├── gemini.js             # Gemini API 呼叫、分批、重試
│   ├── openai-compat.js      # 自訂 OpenAI-compatible Chat Completions adapter（§3.8）
│   ├── openai-compat-thinking.js # 自訂模型 thinking 控制 mapping（thinkingLevel → 各家 provider schema）
│   ├── google-translate.js   # Google Translate 非官方 API 封裝（translate_a/single，免 API Key）
│   ├── system-instruction.js # 跨 provider 共用的翻譯 batch 構建 helper（DELIMITER／packChunks）
│   ├── bg-error.js           # 背景端錯誤 error code 協定（codedError，§14.1）
│   ├── cache.js              # 翻譯快取（LRU + debounced flush）
│   ├── storage.js            # 設定讀寫、預設值
│   ├── constants.js          # lib/ 與 content script 共用的批次翻譯數值常數
│   ├── stream-reuse.js       # streaming 批次 partial-reuse 規劃（只補缺的批次）
│   ├── logger.js             # 結構化 Log 系統
│   ├── usage-db.js           # 用量追蹤（IndexedDB）
│   ├── model-pricing.js      # Gemini 模型計價表（USD per 1M tokens）
│   ├── exchange-rate.js      # USD ↔ TWD 匯率抓取 + 快取
│   ├── format.js             # 共用格式化函式（formatBytes/formatTokens/formatUSD）
│   ├── format-currency.js    # 金額格式化 + fallback 匯率常數（content script 與 Node 測試共用）
│   ├── forbidden-terms.js    # 中國用語黑名單 Debug 偵測層
│   ├── readability.js        # vendored @mozilla/readability（Apache-2.0，EXTRACT_PAGE_HTML 正文擷取，§3.11）
│   ├── instapaper.js         # Instapaper Full API（OAuth 1.0a + xAuth）封裝（「送到 Instapaper」核心，§3.11）
│   ├── instapaper-keys.js    # Instapaper consumer 憑證（app 層，已 gitignore 不入 repo）
│   ├── i18n.js               # Extension UI 字串 i18n 字典（8 語，§3.10）
│   ├── compat.js             # Safari／Firefox 相容性 shim（chrome.* ↔ browser.*）
│   ├── platform.js           # runtime 平台偵測（iOS build 跑在 macOS 的辨別）
│   ├── distribution.js       # 編譯期注入的 MAS build flag（ES module 版）
│   ├── distribution-cs.js    # 同上的 content script 版（與 distribution.js 同步）
│   ├── update-check.js       # GitHub Releases 更新檢查
│   ├── welcome-notice.js     # 更新後「歡迎升級」提示寫入邏輯
│   ├── release-highlights.js # 近期重大更新文字單一來源
│   ├── shortcut-utils.js     # 自訂快速鍵 helper（UMD，content/options/spec 共用，§10.1）
│   ├── domain-utils.js       # 自動翻譯網站名單的網域正規化 + 比對（UMD，content/spec 共用）
│   ├── zh-convert.js         # 簡繁本地互轉（OpenCC 字典 lazy fetch + converter cache，§3.12）
│   └── vendor/               # 第三方程式庫（pdfjs／pdf-lib + fontkit／chart.min.js／fflate／Noto Sans TC 字型／opencc 簡繁字典）
├── translate-doc/            # 文件翻譯：PDF + EPUB（§17，web_accessible_resources）
│   ├── index.html            # 翻譯文件頁（含 index.js 主協調層、index.css）
│   ├── index.js
│   ├── index.css
│   ├── settings.html         # 文件翻譯獨立設定頁（含 settings.js）
│   ├── settings.js
│   ├── block-types.js        # block type 共用常數（單一資料源）
│   ├── layout-analyzer.js    # raw text run → 版面 IR（§17.4.2／§17.4.3）
│   ├── pdf-engine.js         # PDF.js wrapper（解析 pipeline）
│   ├── pdf-renderer.js       # 譯文 PDF 下載（pdf-lib，§17.8）
│   ├── epub-engine.js        # EPUB 解析（fflate 解壓 → OPF spine → 章節段落 IR，§17.10）
│   ├── epub-scan.js          # 譯後一致性掃描純函式（符合度 / 候選挖掘 / 聚合，§17.10.10）
│   ├── epub-writer.js        # 譯本 EPUB 重建（譯文寫回 XHTML + 重打包，§17.10.6）
│   ├── reader.js             # 線上閱讀器（雙頁並排，§17.6，PDF 專用）
│   └── translate.js          # 文件翻譯 pipeline 協調（chunk、重試、引擎選擇；PDF／EPUB 共用）
├── popup/
│   ├── popup.html
│   ├── popup.js              # ES module
│   └── popup.css
├── options/
│   ├── options.html
│   ├── options.js            # ES module
│   └── options.css
├── _locales/                 # Chrome i18n 語系檔（manifest name／description），8 語
│   ├── zh_TW/messages.json
│   └── zh_CN/  en/  ja/  ko/  es/  fr/  de/   # 各含 messages.json
└── icons/
```

---

## 7. 資料流程

1. 使用者按 Option+S 或 Popup「翻譯本頁」
2. `content.js` 的 `collectParagraphs()` 遍歷 DOM 收集翻譯單位
3. `packBatches()` 依字元預算 + 段數上限打包成批次
4. 術語表前置流程（依文章長度決定策略）
5. `runWithConcurrency()` 平行送出批次，每批經 `TRANSLATE_BATCH` 訊息到 background
6. background 的 handler 查快取 → 未命中則呼叫 Gemini API
7. 每批回來立即注入 DOM（`injectTranslation`），Toast 更新進度
8. 全部完成後顯示成功 Toast（含 token 數、費用、快取命中率）

---

## 8. 設定資料結構

### 8.1 `chrome.storage.sync`（跨裝置同步，100KB 上限）

以下為 `lib/storage.js` 的 `DEFAULT_SETTINGS` 完整結構（含預設值）：

```json
{
  "geminiConfig": {
    "model": "gemini-3-flash-preview",
    "serviceTier": "DEFAULT",
    "temperature": 1.0,
    "topP": 0.95,
    "topK": 40,
    "maxOutputTokens": 8192,
    "systemInstruction": "（見 §3.3 DEFAULT_SYSTEM_PROMPT）"
  },
  "pricing": { "inputPerMTok": 0.50, "outputPerMTok": 3.00 },
  "glossary": {
    "enabled": false,
    "prompt": "（見 DEFAULT_GLOSSARY_PROMPT）",
    "temperature": 0.1,
    "skipThreshold": 1,
    "blockingThreshold": 5,
    "timeoutMs": 60000,
    "maxTerms": 200
  },
  "domainRules": { "whitelist": [] },
  "autoTranslate": false,
  "autoConvertZh": false,
  "debugLog": false,
  "maxRetries": 3,
  "maxConcurrentBatches": 10,
  "maxUnitsPerBatch": 20,
  "maxCharsPerBatch": 3500,
  "maxTranslateUnits": 1000,
  "toastOpacity": 0.7,
  "toastAutoHide": true,
  "skipTraditionalChinesePage": true,
  "displayMode": "single",
  "translationMarkStyle": "tint",
  "ytSubtitle": {
    "autoTranslate": true,
    "temperature": 0.1,
    "systemPrompt": "（見 DEFAULT_SUBTITLE_SYSTEM_PROMPT）",
    "windowSizeS": 30,
    "lookaheadS": 10,
    "debugToast": false,
    "onTheFly": false,
    "model": "",
    "pricing": null,
    "captionScale": 100
  },
  "forbiddenTerms": "（見 §3.7 / DEFAULT_FORBIDDEN_TERMS，25 條預設）",
  "customProvider": {
    "baseUrl": "https://openrouter.ai/api/v1",
    "model": "openai/gpt-5.4-mini",
    "systemPrompt": "（見 lib/storage.js DEFAULT_SYSTEM_PROMPT）",
    "temperature": 0.7,
    "inputPerMTok": 0.75,
    "outputPerMTok": 4.5,
    "thinkingLevel": "off",
    "fetchTimeoutSec": 90
  }
}
```

註：`customProvider.apiKey` **不存** sync，存 `chrome.storage.local`（key `customProviderApiKey`），與主 Gemini `apiKey` 設計一致。

- **API Key** 存 `chrome.storage.local`（key `apiKey`），不跨裝置同步。舊版（≤v0.61）存在 sync 的 Key 會自動遷移至 local
- 快捷鍵由 Chrome 原生 `commands` API 管理，不存設定
- `maxTranslateUnits`：單頁翻譯段落數上限，超過截斷（0 = 不限制）

### 8.2 `chrome.storage.local`（本地，5MB 上限）

- **翻譯快取**：key `tc_<sha1>` → 譯文字串
- **術語表快取**：key `gloss_<sha1>` → 術語對照 JSON
- **版本標記**：key `__cacheVersion` → manifest version（不一致時清空所有快取）
- **累計費用顯示基準點**：key `usageResetAt` → ms epoch。popup「累計費用」的「清除」寫入；popup 只加總此時間點之後的 usage-db 紀錄。usage-db 與此 key 同為裝置本機，不跨裝置同步

### 8.3 同步策略

- `chrome.storage.sync` 自動跨裝置同步設定（不含 API Key）
- 翻譯快取與術語表快取只存 local，不同步
- 設定頁提供匯出/匯入 JSON（API Key 不含在匯出範圍），匯入時 `sanitizeImport()` 驗證所有欄位

---

## 9. 翻譯快取

### 9.1 Key 設計

`tc_` + SHA-1（原文十六進位）= 43 字元。同一段原文跨頁面共用同一 key。key 只 hash 原文，不含模型/prompt；換模型改 prompt 時以版本自動清空處理。

依呼叫情境額外附加後綴（依固定順序，由 `background.js` 的 `buildCacheKeySuffix()` 統一組裝——v1.10.46 起 `handleTranslate` / `handleTranslateStream` / `handleTranslateCustom` 三條路徑共用單一資料源；最終 key 由 `lib/cache.js` 的 `resolveKeySuffix()` 接上）：

- **base tag**：`'_yt'` = 字幕模式 / `'_gt'` = Google Translate 網頁 / `'_gt_yt'` = Google Translate 字幕 / `'_oc'` = 自訂 OpenAI-compat（v1.5.7）/ `''` = 一般 Gemini 網頁翻譯（含 preset 快速鍵）
- **`_g<hash>`**：有術語表時加（自動擷取 + 使用者固定術語的合併 hash，前 12 字元 SHA-1）。固定術語表合併走 `buildFixedGlossaryEntries`（global + domain 同 source 以 Map dedup，domain 蓋 global）——v1.10.46 起 streaming 路徑同走此函式（原手抄版無 dedup，global+domain 重疊時 batch 0 與 batch 1+ 的 `_g` hash 不一致，同頁裂成兩個 cache namespace）
- **`_b<hash>`**（v1.5.6 新增）：使用者啟用禁用詞清單時加（依 `forbidden` 排序後 JSON.stringify 的前 12 字元 SHA-1）。空清單時不附加，向下相容 v1.5.5 之前的快取
- **`_m<model>`**（v1.4.12 起）：把 model 字串納入 key（替換非安全字元為 `_`），避免不同 preset 切換時共用快取
- **`_m<baseUrlHash6>_<safeModel>`**（v1.5.7，自訂 Provider 路徑）：baseUrl SHA-1 前 6 字元 + safe model — 避免不同 provider（OpenRouter vs Together vs 自架 Ollama）的同 model name 共用快取
- **`_lang<targetLang>`**（v1.8.59 新增）：非 zh-TW target 加此 suffix（如 `_langzhcn` / `_langen`），避免不同目標語言撞 cache。zh-TW target **不加**此 suffix，向下相容 v1.8.58 之前的 cache（既有 zh-TW 使用者升級 cache 仍 hit）
- **`_t<n.nn>`**（W7 起，文件翻譯路徑 `_doc` / `_oc_doc` 限定）：文件翻譯獨立 temperature 以 `toFixed(2)` 納入 key，改設定後立即生效不吃舊 temp 快取。網頁／字幕路徑不加（避免 cache 多分裂）
- **`_x<hash>`**（文件翻譯路徑 `_doc` / `_oc_doc` 限定）：「本文件額外翻譯指令」（`payload.extraPrompt`，trim 後非空時）的前 12 字元 SHA-1。改指令後既有快取自動失效；清空回沒有額外指令的原 key，舊快取直接可用

完整可能形式範例：`tc_<sha1>_g<g>_b<b>_m<m>_lang<x>_t<t>_x<x>`，部分後綴可省略。

**Glossary cache（`gloss_` prefix）同款區隔**：v1.8.59 起 `cache.getGlossary(inputHash, suffix)` / `setGlossary(inputHash, glossary, suffix)` 接 suffix 參數，background.js 的 `handleExtractGlossary*` 兩條入口傳 `_lang<x>`（非 zh-TW target）。

### 9.2 批次讀寫

- `cache.getBatch(texts)`：一次 `storage.local.get(allKeys)`。讀取時累積 LRU 時間戳到 `pendingTouches`，由 5 秒 debounce 統一 flush
- `cache.setBatch(texts, translations)`：一次 `storage.local.set(updates)`。eviction check 最多每 30 秒一次

### 9.3 清空邏輯

- `cache.clearAll()`：filter 出 `tc_` 和 `gloss_` 開頭的 key 全部 remove
- `cache.checkVersionAndClear(currentVersion)`：比對版本，不一致則 clearAll 並更新 `__cacheVersion`
- Service Worker 啟動時與 `onInstalled` 事件各執行一次

### 9.4 統計

`cache.stats()` 回傳 `{ count, bytes }`。bytes 為 key + value 字元長度粗估。

---

## 10. 快捷鍵

三組 preset 快速鍵（v1.4.12 起），每組對應 options「翻譯快速鍵」一張 preset card（slot 1／2／3，可自訂 label／engine／model）：

| command id | 預設鍵位 | 對應 storage slot | card 名稱 |
|---|---|---|---|
| `translate-preset-0` | Alt+S（macOS 為 Option+S） | 2 | 主要預設 |
| `translate-preset-1` | Alt+A | 1 | 預設 2 |
| `translate-preset-3` | Alt+D | 3 | 預設 3 |

- command id 字典序決定 `chrome://extensions/shortcuts` 的顯示順序，故「主要預設」用 id `0` 對應 storage slot `2`（`COMMAND_ID_TO_SLOT` 寫死在 `background.js`）
- Toggle 語意：未翻譯 → 翻譯；翻譯中 → 取消並立即還原原文；已翻譯 → 還原原文
- 另有 `send-to-instapaper`（Alt+I）command：把當前頁面正文送到 Instapaper（§3.11），非 preset 翻譯快速鍵，不對應 storage slot

### 10.1 自訂快速鍵（in-page recorder）

manifest `commands` 的預設鍵位（Alt+S／A／D）由瀏覽器層管理，但只有 Chrome 走 `chrome://extensions/shortcuts`、Firefox 走 `about:addons` 能改；Safari（含 iOS／iPadOS）沒有瀏覽器層快速鍵設定入口，且不支援 `commands.update()`。為讓全平台（特別是 iPad 外接鍵盤）都能改鍵，options「翻譯快速鍵」每張 preset card 提供 in-page recorder，自訂鍵走 content script 層攔截，與 manifest 預設鍵並存：

- **資料源**：`lib/shortcut-utils.js`（UMD，掛 `window.__SKShortcuts` + Node `module.exports`），content script／options／regression spec 共用同一份「比對 / 驗證 / 格式化」邏輯
- **儲存**：`storage.sync.customShortcuts`，slot key `2`／`1`／`3`，值形狀 `{ code, alt, shift, ctrl, meta }`（`null` = 沿用內建預設）。`code` 用 `e.code`（實體鍵位）不用 `e.key`（避免 macOS ⌥+字母 dead-key 變換）
- **攔截**：`content-shortcuts.js` 在頁面 `keydown` capture phase 比對命中後，直接呼叫 `SK.handleTranslatePreset(slot)`（與 onCommand Alt+S、四指 tap 同一條本地 dispatch 入口，零訊息往返，避開 iOS Safari background 被回收的問題）。`storage.onChanged` 監聽讓 options 改鍵即時生效
- **驗證規則**（`shortcut-utils.validate(s, opts)`，皆為結構性通則）：必含一個修飾鍵（⌥／⌃／⌘，避免打字誤觸）、拒 ESC（保留作取消錄製）、拒與三組內建預設鍵相同（browser 層停不掉，雙觸發 = toggle 兩次）；options 另檢查與其他 slot 生效鍵衝突
- **依瀏覽器引擎統一的修飾鍵規則（`opts.requireCtrl`）**：規則依**瀏覽器引擎**切（非 OS / build）。options.js 以 extension URL 前綴判定 `_isSafariRuntime`（`safari-web-extension://`，涵蓋 macOS／iPadOS／iOS Safari）→ 傳 `requireCtrl: true`：
  - **Safari（Mac／iPad／iPhone）**：自訂鍵**必含 ⌃ Control**，⌥-only／⌘-only 在錄製時即擋下（`shortcut.invalid.safariNeedCtrl`）+ recorder 紅框抖動 + `#shortcut-hint` ⚠ 提示。真機 probe 實證 iPadOS Safari 把 **⌥／⌘ 路由到系統鍵盤指令層，不以 keydown 傳給網頁**（iPad 按 ⌥+鍵／⌘+鍵 網頁收不到任何 keydown，只有 ⌃ 收得到）；macOS Safari 雖收得到 ⌥，但為「同一組自訂鍵跨 Apple 裝置都能動」一致性也統一要求 ⌃。內建預設鍵（⌥S／A／D）不受影響——走系統指令層（onCommand），那層收得到 ⌥
  - **Chrome／Firefox**：`requireCtrl: false`，⌥／⌃／⌘ 皆可。註：Chrome 的 ⌘ 多數組合會被瀏覽器攔（⌘L／⌘R 等），允許設但不保證觸發（產品取捨）
  - **說明文字也依瀏覽器切**：options 快速鍵 section 的操作說明有兩版 i18n（`intro.html` 桌面版「需包含 ⌥ Option 或 ⌃ Control」／`introSafari.html` Safari 版「需用 ⌃ Control」），純 CSS 依 `body.runtime-{chrome,firefox,safari}` 顯示對應版本（無額外 JS）；錄製被拒時 recorder 紅框抖動 + `#shortcut-hint` ⚠ amber box「Safari 請用 ⌃ Control 組合」
- **與預設鍵的關係**：manifest 預設鍵在 browser 層停不掉，自訂鍵是疊加。位址列／devtools focus、content script 未注入的頁（`chrome://` 等）收不到 keydown，這些情境桌面 manifest 預設鍵仍作 fallback
- 鍵位也可在 Chrome `chrome://extensions/shortcuts`、Firefox `about:addons` 改 manifest 預設鍵本身（options 對應連結以 `body.runtime-safari` 在 Safari 隱藏）

### 10.2 iOS／iPadOS 四指手勢

- **四指輕點**（壓住 < 600ms 即抬起）= 主要預設完整 toggle——`content-touch.js` 偵測手勢後送 `FOUR_FINGER_TAP` 給 background，轉發 `TRANSLATE_PRESET` slot 2，與快速鍵共用同一條派送路徑
- **四指長按**（四指同時壓住、不移動且持續達 600ms）= 第一組預設（slot 1，預設 Flash Lite）——計時器在門檻當下送 `FOUR_FINGER_LONGPRESS` 給 background，轉發 `TRANSLATE_PRESET` slot 1；抬起時以 `longPressFired` 旗標擋住，不重複觸發 slot 2。輕點 / 長按以「壓住時長」單一門檻區分，主要動作（輕點）於抬起當下零延遲觸發
- 以 `IS_IOS_BUILD`（`lib/distribution.js`，iOS build script override 為 true）gate，桌面 build 為 no-op。外接硬體鍵盤時三組快速鍵照常可用，也可用上述 recorder 自訂

### 10.3 iOS background keep-alive

iOS build 在「有開著的分頁且分頁可見」時，由 `content-touch.js` 對 background 開一條長連線 port（`browser.runtime.connect({ name: 'shinkansen-keepalive' })`）並每 20 秒 ping 一次，background `onConnect` 收到後回 pong；靠「持續有 port 連著＋收訊息」把 iOS Safari 的 background event page 維持在非閒置、避免被系統回收（iOS 平台限制：background 閒置後會被永久回收且叫不醒，連帶四指／popup 翻譯失效）。分頁切到背景即 disconnect（省電），切回／斷線自動重連。以 `IS_IOS_BUILD` gate（桌面 build 不開 port，background `onConnect` 只認此 port name，桌面永不觸發）。

---

## 11. 翻譯狀態提示（Toast）

### 11.1 容器

`position: fixed; z-index: 2147483647`，Shadow DOM 隔離（closed mode），280px 寬、白底圓角陰影。位置由 CSS class `pos-{position}` 控制，支援 `bottom-right`（預設）、`bottom-left`、`top-right`、`top-left` 四個選項，使用者可在設定頁調整。預設透明度 70%。翻譯完成的 success toast 預設 5 秒後自動關閉（`toastAutoHide` 開關，預設開啟）；關閉此選項時維持舊行為——需手動點 × 或點擊外部區域關閉。

### 11.2 狀態

| 狀態 | 主訊息 | 進度條 | 自動消失 |
|------|--------|--------|----------|
| loading | `翻譯中… N / Total` + 計時器 | 藍色（mismatch 時黃色閃爍） | 否 |
| success | `翻譯完成（N 段）` + token/費用/命中率 | 綠色 100% | 是（`toastAutoHide` 開啟時 5 秒；預設開啟） |
| error | `翻譯失敗：<msg>` | 紅色 100% | 否 |
| restore | `已還原原文` | 綠色 100% | 2 秒 |

成功 Toast 的 detail 兩行：token 數 + implicit cache hit%、實付費用 + 節省%。費用套用 cache 命中折扣後的實付值——折扣比例由 pricing config 的 `cachedDiscount` 欄位決定（Gemini 2.5+ implicit cache 預設 0.90 = 90% off；customProvider 預設 0.90 對齊 GPT-5.4 Mini，可在 options 改）。

### 11.3 設計原則

- 不用轉圈 spinner，用橫向進度條 + 計時器
- 不用左邊色條 border-left
- 成功提示預設 5 秒後自動消失（`toastAutoHide` 設定控制；關閉時需手動點 × 或點擊外部區域）
- 延遲 rescan 補抓在 UI 層完全隱形

---

## 12. LLM 除錯 Log

`lib/logger.js` 提供結構化 Log，記錄 API 呼叫的時間、模型、參數、耗時、token、錯誤等。

- **記憶體 buffer**：最近 1000 筆環形，Service Worker 重啟即丟失。設定頁「Debug」分頁可瀏覽（分類 / 等級篩選、搜尋、匯出 JSON）
- **持久化 buffer**（`yt_debug_log`）：`chrome.storage.local` key，最近 100 筆環形，**跨 Service Worker 重啟仍在**。只持久化 `youtube` / `api` / `translate` 三類（v1.8.56 起加入 translate，讓翻譯主流程的 main flow start / batch start / batch done / stream firstChunkOrTimeout 等訊號跨 SW 重啟可查），其他類別（`cache` / `spa` / `system` / `glossary`）只在記憶體 buffer
- **異常事件 ring**（`anomaly_log`）：`chrome.storage.local` key，最近 30 筆環形。log `data` 帶 `_anomaly: true` 標記的低頻異常事件另存此 ring，不受 100 筆主 ring 被日常 translate / api log 快速擠掉影響（一次整頁翻譯 ~40 筆，偶發事件數小時後即無痕跡），保留數天等級的回查窗口。目前標記的事件：串流 batch 0 的 hadMismatch 重翻（含 `injectedSoFar` = 已上屏即將被覆蓋段數——「翻好的字被另一版中文覆蓋」症狀的直接訊號）、串流 mid-failure 重翻（同帶 `injectedSoFar`）、first_chunk timeout fallback。`GET_PERSISTED_LOGS` 回應含 `anomalies` 欄位一併回傳；`CLEAR_PERSISTED_LOGS` 兩個 ring 一起清
- **「Debug」分頁載入**（v1.8.56 起）：分頁啟動時先呼叫 `GET_PERSISTED_LOGS` 載入持久化那段（SW 重啟前的紀錄），再開始 polling 記憶體 buffer。dedup 用 `timestamp + category + message` 三元 key（SW 重啟後 logSeq 重置會撞號，純 seq 去重會漏）
- **「清除」按鈕**（v1.8.56 起）：同時送 `CLEAR_LOGS` + `CLEAR_PERSISTED_LOGS`，兩層 buffer 都清。原本只清記憶體，persisted 還在 storage.local，下次 SW 重啟分頁載入時舊 log 又冒出來
- **DevTools Console**：設定頁可選啟用同步輸出
- **Debug Bridge**：content.js 透過 CustomEvent 橋接，main world 可用 `shinkansen-debug-request` / `shinkansen-debug-response` 事件讀取 log（支援 `GET_LOGS`、`CLEAR_LOGS`、`GET_PERSISTED_LOGS`、`CLEAR_PERSISTED_LOGS`、`CLEAR_CACHE`、`TRANSLATE`、`RESTORE`、`GET_STATE`（回傳含 manifest `version`）、`GET_YT_DEBUG`、`GET_CACHE_STATS`（唯讀 cache 池快照）、`GET_CACHE_PEEK`（唯讀依子字串掃 tc_ 快取條目內容，回 `{key, v, t}`，診斷壞譯文入快取用）、`SET_GLOSSARY_ENABLED`（撥術語表一致化開關，唯一開放的寫入 action，供自動化測試））。僅限 Chromium：Firefox 的 main world 受 Xray 安全模型限制，讀不到 response 的 object detail，Debug Bridge 回讀不可用（消費者皆為 Chromium-only tooling，刻意不改協定）
- **YouTube bridge 事件 detail 協定**：isolated→main 方向（`shinkansen-yt-cc-control`、`shinkansen-yt-set-caption-track`）的 detail 一律送 JSON 字串（Firefox 的 isolated→main object detail 在 main world 讀屬性會 throw，primitive 字串跨 compartment 可讀）；main 端雙格式相容讀（字串 parse、物件直收）。main→isolated 方向（`shinkansen-yt-player-response` 等）維持 object detail（content script 有 Xray vision 可讀）

---

## 13. Popup 面板規格

### 13.1 版面

- Header：emoji 🚄 + 名稱「Shinkansen」+ 版本號（動態讀取）
- 主按鈕：「翻譯本頁」/「顯示原文」（依 `GET_STATE` 切換）
- 編輯譯文按鈕（預設 `hidden`，翻譯完成後才顯示；切換 `TOGGLE_EDIT_MODE`）。進入編輯模式後頁面下方置中顯示浮動工具列（closed Shadow DOM＋Constructable Stylesheet）：提示文字＋「復原」（逐段 LIFO 撤銷，`beforeinput` 首次改動前快照 innerHTML）＋「完成」（等同「結束編輯」，寫回 guard 快取）；i18n key `editbar.*`。編輯中貼上一律降為純文字（`onEditPaste` capture 攔截，取 `text/plain` 走 `execCommand('insertText')`）——貼上格式跟目標段落走、不帶來源 inline style；Chromium 對 execCommand 不發 `beforeinput`，貼上前手動補快照讓「復原」涵蓋純貼上編輯。與 translate-doc EPUB 預覽 `onPreviewEditablePaste` 為同一份事實的雙實作
- 白名單自動翻譯 toggle
- 簡繁自動互轉 toggle（只在 target 為 zh-TW / zh-CN 時顯示，與「翻譯成」picker 連動；§3.12）
- 術語表一致化 toggle
- YouTube 字幕翻譯 toggle（只在 YouTube 影片頁面顯示）
- 快取統計（段數 / 大小）+ 清除快取按鈕
- 累計費用 / token 顯示（透過 `QUERY_USAGE_STATS` 從 IndexedDB 讀取，與用量明細分頁同源）＋「清除」按鈕（inline 確認 UI，同清除快取模式）。「清除」只寫顯示基準點 `usageResetAt`（`chrome.storage.local`，ms epoch），此後 popup 只加總基準點之後的紀錄（`QUERY_USAGE_STATS` 帶 `from`）；usage-db 紀錄一筆都不刪，options 用量明細分頁不受影響
- 狀態列（「狀態：就緒」/ 「狀態：正在翻譯…」/ 錯誤訊息等）
- Footer：設定按鈕（開啟 options 頁面）+ 快捷鍵提示（動態讀取 `chrome.commands`）

### 13.2 版本顯示

**必須**透過 `chrome.runtime.getManifest().version` 動態讀取，不得寫死。

---

## 14. 訊息協定（content ↔ background ↔ popup）

### 14.1 content → background

| type | payload | 回應 |
|------|---------|------|
| `TRANSLATE_BATCH` | `{ texts, slots, … }` | `{ ok, result, usage }` |
| `CONVERT_ZH_LOCAL` | `{ texts, direction }` | `{ ok, result }` — 簡繁本地互轉（OpenCC 字典，`direction` 為 `cn2twp` / `twp2cn`，不打 API 不寫快取，§3.12） |
| `SET_AUTO_CONVERT_ZH`（popup → content） | `{ enabled }` | — 簡繁自動互轉 toggle 即時生效：勾選對本頁跑 convertOnly、取消還原本地轉換結果（不動 LLM 翻譯，§3.12） |
| `TRANSLATE_SUBTITLE_BATCH` | `{ texts, glossary }` | `{ ok, result, usage }` — YouTube 字幕逐條翻譯（人工字幕路徑，Gemini 引擎） |
| `TRANSLATE_SUBTITLE_BATCH_GOOGLE` | `{ texts }` | 一般字幕路徑走 Google Translate（`ytSubtitle.engine='google'`），cache key `_gt_yt` |
| `TRANSLATE_SUBTITLE_BATCH_CUSTOM` | `{ texts }` | 一般字幕路徑走 OpenAI-compat 自訂 Provider（`ytSubtitle.engine='openai-compat'`），cache key `_oc_yt`；`systemPrompt` 取 `ytSubtitle.systemPrompt`（空字串 fallback 主 `customProvider.systemPrompt`） |
| `TRANSLATE_ASR_SUBTITLE_BATCH` | `{ texts: [json], glossary }` | `{ ok, result: [json], usage }` — v1.6.20:ASR 字幕專用（Gemini），texts 是單一 [{s,e,t}] JSON 字串，LLM 自由合句後回 [{s,e,t}] JSON 字串 |
| `TRANSLATE_ASR_SUBTITLE_BATCH_CUSTOM` | `{ texts: [json] }` | ASR 字幕走自訂 Provider（`ytSubtitle.engine='openai-compat'`），cache key `_oc_yt_asr`。**強制** `systemPrompt = DEFAULT_ASR_SUBTITLE_SYSTEM_PROMPT`，**不讀** `ytSubtitle.systemPrompt`（JSON timestamp 模式跟逐條字幕規則不同；跟 Gemini ASR 路徑 `_handleAsrSubtitleBatch` 對齊）。`temperature` 沿用 `ytSubtitle.temperature` |
| `EXTRACT_GLOSSARY` | `{ compressedText, inputHash, forceRefresh?, promptSuffix?, modelOverride? }` | `{ ok, glossary, usage, fromCache, _diag }` — Gemini 路徑術語表抽取。模型解析：`glossary.model` 有值優先；空字串（「與主翻譯模型相同」）→ `modelOverride`（文件翻譯頁 preset，抽取時就地解析）優先，否則全域 `geminiConfig.model` |
| `EXTRACT_GLOSSARY_CUSTOM` | `{ compressedText, inputHash }` | 同上格式 — 自訂 Provider（`engine='openai-compat'`）路徑;走 chat.completions,不需要 Gemini API Key。回傳結構跟 Gemini 路徑對齊讓 content.js handler 不必分流 |
| `LOG` | `{ level, category, message, data }` | — |
| `LOG_USAGE` | `{ inputTokens, outputTokens, … }` | `{ ok }` |
| `SET_BADGE_TRANSLATED` | — | `{ ok }` |
| `CLEAR_BADGE` | — | `{ ok }` |
| `STICKY_QUERY` | — | `{ ok, shouldTranslate, slot }` — 查當前 tab 是否在跨 tab sticky set，回傳 preset slot（v1.4.12 從 engine 改存 slot） |
| `STICKY_SET` | `{ slot: number }` | `{ ok }` — 翻譯成功後將當前 tab 加入 sticky set 記錄 slot（v1.4.12） |
| `STICKY_CLEAR` | — | `{ ok }` — 還原原文時將當前 tab 從 sticky set 移除（v1.4.11） |

**字幕路由**:`content-youtube.js` 所有字幕翻譯訊息類型都透過 `SK.getSubtitleBatchType(engine, asr)`（`content-ns.js`）統一路由，不在多處 inline 三元式判斷以避免 drift:

- 非 ASR（人工字幕 / heuristic 整句字幕）:`google` → `_GOOGLE` / `openai-compat` → `_CUSTOM` / 其餘 → Gemini
- ASR LLM（JSON timestamp 模式）:Google MT 不支援 JSON 包裝，只有 Gemini / `openai-compat` 兩路；`engine='google'` 在 ASR LLM 下走 Gemini fallback

**術語表路由**:`content.js` 兩處 `EXTRACT_GLOSSARY` dispatch 透過 `SK.getGlossaryExtractType(engine)`（`content-ns.js`）統一路由:

- `openai-compat` → `EXTRACT_GLOSSARY_CUSTOM`（走 `lib/openai-compat.js extractGlossary`,不需要 Gemini API Key）
- 其餘（含 `google`） → `EXTRACT_GLOSSARY`（走 Gemini）

`engine='google'` 走 Gemini 路徑會吃 `settings.apiKey`,使用者沒填時 background 回傳 `_diag` 提示;這是已知 trade-off — 主翻譯走 Google MT 但仍要 LLM 抽術語表的使用者必須額外填 Gemini Key（Google MT 本身不支援 LLM 抽術語表任務）。

**錯誤回報（error code 協定）**：handler 失敗統一回 `{ ok: false, error, errorCode?, errorParams? }`；streaming 路徑為 `STREAMING_ERROR` payload 的同名欄位。

- `error`：原字串（繁中 fallback 或 API 原文），舊版 UI / 未知錯誤的向下相容顯示值
- `errorCode`：背景端可預期的使用者面對錯誤帶結構化 code（`lib/bg-error.js` `codedError()` 標注）。現有 code：`apiKeyMissing` / `baseUrlMissing` / `network` / `timeout` / `readTimeout` / `dailyQuota` / `http429` / `badResponse` / `blocked` / `emptySafety` / `emptyRecitation` / `emptyMaxTokens` / `emptyOther` / `emptyContent` / `customBadResponse` / `customEmptyContent` / `gtTimeout`
- `errorParams`：dict 模板參數（`{ms}` / `{msg}` / `{status}` / `{preview}` / `{reason}` / `{dim}`）

UI 端（content scripts / translate-doc）統一走 `lib/i18n.js` `bgErrorMessage(payload)` 查 `error.bg.<code>` dict key（8 語）組當前 uiLanguage 訊息；沒帶 `errorCode`（API 原文 ground truth 直傳 / 內部錯誤 / 舊版背景）或 dict 缺 key 時 fallback `error` 原字串原樣顯示。API 原始錯誤訊息（Gemini 英文 `error.message` 等）不被翻譯吞掉——以 params 帶進模板或不掛 code 原樣直傳，完整原文在 debugLog。背景端不翻譯（service worker 載不了 `lib/i18n.js`，也不知使用者 uiLanguage）。

### 14.2 popup / options → background

| type | 回應 | 用途 |
|------|------|------|
| `CACHE_STATS` | `{ ok, count, bytes }` | 快取統計 |
| `CLEAR_CACHE` | `{ ok, removed }` | 清空翻譯快取 |
| `QUERY_USAGE_STATS` | `{ ok, stats }` | Popup 累計費用/token 顯示 + Options 用量彙總卡片（同源） |
| `QUERY_USAGE_CHART` | `{ ok, data }` | Options 用量折線圖 |
| `QUERY_USAGE` | `{ ok, records }` | Options 用量明細表格 |
| `EXPORT_USAGE_CSV` | `{ ok, csv }` | Options 匯出 CSV |
| `CLEAR_USAGE` | `{ ok }` | Options 清除用量紀錄 |
| `GET_LOGS` | `{ logs }` | 讀取 Log buffer（同步） |
| `CLEAR_LOGS` | — | 清空 Log buffer（同步） |

> **設定讀寫**：popup 和 options 直接透過 `chrome.storage.sync` / `chrome.storage.local` 存取設定，不經 message handler。

### 14.3 background / popup → content

| type | 用途 |
|------|------|
| `TRANSLATE_PRESET` | v1.4.12：依 `payload.slot`（1/2/3）觸發對應 preset 翻譯；已翻譯時任一 slot 皆 `restorePage`；翻譯中任一 slot 皆 abort |
| `TOGGLE_TRANSLATE` | 舊訊息（popup 按鈕用）；v1.4.12 起映射為 preset slot 1 |
| `GET_STATE` | 查詢翻譯狀態 |
| `TOGGLE_EDIT_MODE` | 切換編輯譯文模式 |
| `MODE_CHANGED` | v1.5.0：popup 切換顯示模式時通知 content script。payload `{ mode: 'single' \| 'dual' }`；已翻譯狀態下顯示 toast 提示需重新翻譯，否則僅靜默接收 |
| `EXTRACT_PAGE_HTML` | background 取當前頁正文（Readability 抽，§3.11）；只由最上層 frame 回 `{ ok, url, title, html }`，子 frame 不回應 |
| `INSTAPAPER_TOAST` | 快捷鍵路徑「送到 Instapaper」結果回饋（無 popup 時走 content toast）；`status`: `sending`／`sent`／`not-enabled`／`failed-auth`／`failed-network`／`failed`（§3.11） |

### 14.4 Badge

翻譯完成後 `SET_BADGE_TRANSLATED` 點亮紅點 badge（`●`，`#cf3a2c`）。分頁跨站導航時 `chrome.tabs.onUpdated` 自動清除。

### 14.5 跨 tab sticky 翻譯（v1.4.11 / v1.4.12 schema 更新）

`background.js` 維護 `stickyTabs: Map<tabId, slot>`（v1.4.12 起 value 為 preset slot number），持久化於 `chrome.storage.session.stickyTabs`（service worker 休眠重啟時 hydrate 回 memory）。

行為：
- 任一 tab 按 preset 快速鍵（Alt+A/S/D）翻譯成功 → content.js 送 `STICKY_SET {slot}` → 該 tab 進入 set。
- `chrome.tabs.onCreated`：若新 tab 的 `openerTabId` 在 set 中，把新 tab 也加入 set 並繼承相同 slot。涵蓋 Cmd+Click、`target="_blank"`、`window.open()` 等所有由瀏覽器標記 opener 的開法。
- content script 載入時送 `STICKY_QUERY`，若回 `shouldTranslate=true` 則用回傳的 slot 呼叫 `SK.handleTranslatePreset(slot)`，忠實繼承使用者當時按的 engine+model 組合（優先順序：sticky > whitelist autoTranslate）。
- `restorePage()` 送 `STICKY_CLEAR`，只移除當前 tab，不影響樹中其他 tab。
- `chrome.tabs.onRemoved` 自動從 set 清掉關閉的 tab id，避免長期累積。

不繼承的情境（無 `openerTabId`）：手動在新分頁打網址、從 bookmark 開、從外部 app 開。

### 14.6 Preset 快速鍵（v1.4.12）

- manifest commands：`translate-preset-0`（Alt+S → slot 2，預設 Flash Lite，主要預設）/ `translate-preset-1`（Alt+A → slot 1，預設 Flash）/ `translate-preset-3`（Alt+D → slot 3，預設 Google MT）。command id 與 storage slot 的對映見 §10。
- storage schema：`translatePresets: [{ slot, engine, model, label }]`，三組預設值內建於 `lib/storage.js` `DEFAULT_SETTINGS`。
- 統一行為：
  - 閒置狀態按任一 preset 鍵 → 依該 slot 的 `engine` + `model` 啟動翻譯
  - 翻譯中按任一 preset 鍵 → abort（按下當下立即還原原文 + 跳「已取消」toast，不等 in-flight 批次回應；三條注入路徑注入前檢查 `signal.aborted`，晚到的批次回應不再注入）。取消後（controller 已 aborted、舊輪還在收尾）再按 → 直接開新一輪翻譯（toggle 語意）；run state 在入口同步設定 + identity-guarded 釋放，防快速連按 spawn 並行 zombie run
  - 已翻譯完成按任一 preset 鍵 → `restorePage`（不分 slot）
- `modelOverride` 傳輸：content.js `SK.translateUnits` 把 slot 對應的 model 放進 `TRANSLATE_BATCH` payload.modelOverride → background `handleTranslate` 透過 `geminiOverrides.model` 覆蓋 `geminiConfig.model`（與 YouTube 字幕用的同一條機制，用 `cacheTag` 參數區分快取分區避免污染）。
- 未來 Options UI（v1.4.13 規劃）提供 engine/model/label 編輯；v1.4.12 使用者要改 preset 可暫時直接寫 `chrome.storage.sync.translatePresets`。
- 三組 preset 的鍵位可在 options「翻譯快速鍵」card 用 in-page recorder 自訂（全平台通用，特別是 Safari／iPad 外接鍵盤無瀏覽器層改鍵入口），詳見 §10.1。

background.js 使用 `messageHandlers` 物件 map 做 O(1) dispatch，統一的 listener 負責 sendResponse 包裝與錯誤處理。

---

## 15. Debug API

供自動化測試（Playwright）在 isolated world 查詢 content script 內部狀態。`content.js` 載入後在 isolated world 掛上 `window.__shinkansen`：

```js
window.__shinkansen = {
  version: string,                          // manifest version（getter）
  collectParagraphs(): Array,               // 回傳序列化安全的段落陣列
  collectParagraphsWithStats(): Object,     // 同上 + walker 跳過統計
  serialize(el): { text, slots },           // 佔位符序列化
  deserialize(text, slots): { frag, ok, matched }, // 佔位符反序列化
  testInject(el, translation): { sourceText, slotCount }, // 測試用：跑完整 serialize → inject 路徑，跳過 API 層
  selectBestSlotOccurrences(text): Object,  // 測試用：暴露 slot 重複排除邏輯
  getState(): Object,                       // 翻譯狀態快照
}
```

**設計原則**：查詢類方法只讀不寫、回 plain object 不回 DOM 參考、永遠啟用（無開關）、掛在 isolated world。`testInject` 和 `selectBestSlotOccurrences` 是測試專用 helper（v0.59 起），供 regression spec 驗證注入路徑而不需要呼叫 Gemini API。

---

## 16. 用量追蹤

`lib/usage-db.js` 使用 IndexedDB 儲存每次翻譯的詳細紀錄（時間、URL、模型、token 數、費用、段落數等）。

- 設定頁「用量」分頁：彙總卡片（總費用/token/筆數/最常用模型）、折線圖（日/週/月粒度）、明細表格
- 支援日期範圍篩選、CSV 匯出、清除
- 費用計算套用 cache 命中折扣後的實付值（折扣比例由 pricing config 的 `cachedDiscount` 決定，見 §11.2）

---

## 17. 文件翻譯（PDF / EPUB）

> PDF v1.8.45 起 beta 上線；EPUB v2.0.11 起（§17.10）。

### 17.1 功能總覽

使用者透過 popup 點選「翻譯文件」開啟獨立分頁，本機上傳 PDF 檔案，選擇要使用的翻譯 preset（沿用既有三組 preset 設定），系統將 PDF 解析、抽取段落、批次送翻、重建對照版本，提供：

1. **線上閱讀器**：雙頁並排顯示（左原 / 右譯），支援雙向 scroll sync（任一側 scroll 帶動另一側對應段落定位）
2. **下載對照 PDF**：使用者可下載 `<原檔名>-shinkansen.pdf`，雙頁並排版型（每張原文頁後接一張譯文頁），供離線閱讀或存檔

### 17.2 限制與上限

| 項目 | 軟警告 | 硬上限 |
|------|--------|--------|
| 頁數 | 30 頁 | 50 頁 |
| 檔案大小 | 5 MB | 10 MB |

- 達軟警告：UI 顯示「此檔案較大，翻譯時間預估 N 分鐘 / 預估費用 $X USD，是否繼續？」+ 確認 / 取消按鈕
- 達硬上限：UI 顯示「檔案超過支援上限（50 頁 / 10MB），請先拆分後再上傳」+ 阻擋上傳

**已知不支援場景**（使用者上傳時偵測 + 標示）:
- 純掃描 PDF（無 text run、需 OCR）→ 偵測方式：整份 PDF 可抽 text 字數 < 50 → 顯示「此 PDF 為掃描影像，本工具不支援 OCR」並終止
- 加密 / 受保護 PDF → PDF.js 開啟失敗 → 顯示「此 PDF 受密碼保護或加密，請先解除保護」並終止
- 無法解析的字型（custom CID font without ToUnicode map）→ 抽出的文字為亂碼 → 偵測 ASCII / 控制字元比例 > 50% → 警告「此 PDF 字型映射不完整，翻譯品質可能受影響」+ 允許繼續
- 旋轉 / 直排文字（圖表軸標籤等）→ 偵測方式：text run 變換矩陣 |m[1]| > |m[0]|（glyph 前進方向偏垂直，水平 bbox 假設不適用，送翻會造成 mask 與譯文錯位）→ 解析時丟棄該 run 不送翻 → 警告「此 PDF 含 N 段旋轉或直排文字，該部分維持原文不翻譯」+ 允許繼續。RTL 文字為已知限制（`dir` 欄位有抽出、下游未消費，仍按 LTR 處理）

### 17.3 入口 UI

#### 17.3.1 Popup 新項目

`popup/popup.html` 在現有「自動翻譯網站」開關下方新增區塊：

```
─────────────────
[圖示] 翻譯文件
       上傳 PDF 進行翻譯
─────────────────
```

點擊整列觸發 `chrome.tabs.create({ url: chrome.runtime.getURL('translate-doc/index.html') })`。

#### 17.3.2 翻譯文件頁（translate-doc/index.html）

獨立 chrome-extension 頁面，獨立資料夾 `shinkansen/translate-doc/`，結構：

```
translate-doc/
  index.html          上傳 / 設定 / 進度 / 預覽全在此頁
  index.js            主邏輯（coordinator）
  index.css           UI 樣式
  reader.js           雙頁並排閱讀器 + scroll sync
  pdf-engine.js       PDF.js wrapper、文字抽取、版面 IR 建構
  pdf-renderer.js     pdf-lib 譯文 PDF 重新生成
  layout-analyzer.js  版面演算法（column / block / reading-order / formula 偵測）
  translate.js        翻譯 pipeline 協調（chunk 切批 / usage 累計 / marker 協定）
  block-types.js      block type 共用常數（TRANSLATABLE_TYPES 單一資料源）
  settings.html/.js   文件翻譯設定頁
```

頁面 flow（單頁 SPA）:

1. **上傳階段**：中央拖放區 + 「選擇檔案」按鈕，顯示既有 preset 三組（radio button 選擇）,「開始翻譯」按鈕
2. **翻譯中階段**：整頁切換成進度視圖（進度條 + 已翻譯段落數 / 總段落數 + 預估剩餘時間 + 累計 token 數 / 預估費用 + 取消按鈕）
3. **閱讀階段**：整頁切換成雙頁並排閱讀器（左原 / 右譯，工具列含「下載譯文 PDF」「重新上傳」「複製譯文」）

### 17.4 PDF 解析與版面 IR

#### 17.4.1 解析 pipeline

```
File → ArrayBuffer
  → PDF.js loadDocument
  → for each page:
       getTextContent({ disableCombineTextItems: false })  // 拿 text run 含 bbox / font
       getViewport({ scale: 1.0 })                         // 拿 page size
       getOperatorList()                                   // 拿向量繪圖 op 用於圖片 / 表格框線偵測（階段 2 才用）
  → 全文 text run 集合 → layout-analyzer.js
  → 輸出版面 IR
```

#### 17.4.2 版面 IR 結構

```js
{
  meta: {
    title: string,           // PDF metadata title 或檔名
    pageCount: number,
    pageSize: { width, height }, // 假設全 PDF 同尺寸,異尺寸時取首頁
  },
  pages: [
    {
      pageIndex: number,        // 0-based
      blocks: [
        {
          blockId: string,      // p<page>-b<index>（穩定 ID,做 cache key + scroll sync 對齊用）
          type: 'paragraph' | 'heading' | 'list-item' | 'caption' | 'formula' | 'table' | 'figure' | 'footnote' | 'page-number',
          bbox: [x0, y0, x1, y1],  // 在原 PDF page 座標系
          column: number,       // 該頁第幾欄（0-based,單欄為 0）
          readingOrder: number, // 該頁全域 reading order index
          textRuns: [           // 僅 type ∈ {paragraph, heading, list-item, caption, footnote} 有此欄位
            { text, bbox, fontName, fontSize, color, italic, bold }
          ],
          plainText: string,    // textRuns 拼接後 + 中文排版前處理後的純文字（送翻單位）
          translation: string | null, // 翻譯結果（段落級,失敗為 null,UI 顯示原文）
          translationStatus: 'pending' | 'translating' | 'done' | 'failed',
          translationError: string | null, // failed 時的錯誤訊息
        }
      ]
    }
  ]
}
```

#### 17.4.3 版面演算法

**Column 偵測**：
- 對每頁 text run 的 x0 座標做 1-D K-means(k=1, 2, 3)，用 silhouette score 選最佳 k
- k=1 → 單欄；k=2 → 雙欄（學術論文常見）;k=3 → 三欄（罕見，雜誌排版）
- 邊界值：column 中心相距 < pageWidth × 0.3 → 強制 k 降階（避免把同一欄的縮排當作多欄）

**Block 切分**：
- 同 column 內按 y 座標降序排列 text run（PDF 座標系 y 由下往上，渲染上由上往下）
- 兩 text run 的垂直間距 > 1.5 × medianLineHeight → 切 block 邊界
- 字型 / 字級從 body text 跳變（差距 > 1pt 或 weight 由 normal 變 bold / 由 bold 變 normal）→ 也切 block 邊界（分離 heading / body / caption）

**Block type 分類啟發式**：

| 條件 | type |
|------|------|
| fontSize > body × 1.2 + 字數 < 200 + bold | `heading` |
| 第一字元 ∈ `{•, ·, -, –, *, 1., 1)}` | `list-item` |
| 連續 ≥ 3 個非 ASCII 字元符合常見公式 unicode 範圍（`U+2200-22FF` / `U+27C0-27EF` / `U+1D400-1D7FF`)+ 整段 < 5 行 | `formula` |
| 該 block bbox 完全包在某 figure 操作器（getOperatorList 偵測 `paintImageXObject`）的 bbox 內，或位於該 figure 下方 50pt 內 + 字數 < 100 | `caption` |
| fontSize < body × 0.85 + 位於頁面下方 1/4 + 第一字元為 `^[0-9]+\.|^[\^*†‡§]` | `footnote` |
| fontSize < body × 0.85 + 整段為純數字 / 「Page N」格式 + 位於頁首或頁尾 | `page-number` |
| 多列文字 bbox 形成規則格線（同列字 y 接近、欄間距固定）→ getOperatorList 含框線繪製 op | `table` |
| 以上皆非 + textRuns 長度 ≥ 1 | `paragraph`（預設） |

**table 逐行拆解**：分類為 `table` 的 block 隨即逐行（單行內 runs 有 cell 級 gap 時再逐 cell）拆解為獨立 block 並重新分類——啟發式 table 命中的多為 label / value 行群或無框線數據表，「每行是獨立版面單位」，逐 row 原位翻譯優於整塊跳過。最終版面 IR 不含 `table` type 的 block

**Reading order**:
- 同欄內按 y 降序（視覺由上往下）
- 跨欄按欄編號升序（左欄全部讀完再右欄）
- 跨頁按頁碼升序
- 例外：`footnote` / `page-number` 永遠排在該頁所有其他 block 之後（reading order 最大）

#### 17.4.4 翻譯與保留策略

| Block type | 處理 |
|------------|------|
| `paragraph` / `heading` / `list-item` / `caption` / `footnote` | **送翻譯**——以 `plainText` 為單位送既有 Gemini batch translation pipeline |
| `formula` / `figure` / `page-number` | **不送翻譯**——保留原樣；譯文 PDF 該位置直接 render 原文 |
| `table` | 不會出現在最終 IR——分類後隨即逐行拆解為可翻譯 block（見 §17.4.3「table 逐行拆解」） |

**plainText 構建**：
- 同 block 內 textRuns 按原順序拼接
- 行尾若為連字符 `-` 且下一行第一字為小寫字母 → 合併為單字（de-hyphenation）
- 行尾若無標點且下一行非縮排起始 → 視為續行，以單一 ASCII space 銜接
- 行尾若有句號 / 問號 / 驚嘆號 / 中英文標點 → 視為段落內換行，保留為單一 ASCII space

### 17.5 翻譯流程

#### 17.5.1 重用既有 pipeline

文件翻譯**完全沿用**既有 background.js `TRANSLATE_BATCH` 訊息處理：

- 把版面 IR 中所有 `送翻譯` 類 block 收集成 `plainText[]` 陣列，送 `TRANSLATE_BATCH`
- 每批 chunk size = 既有 `CHUNK_SIZE = 20`
- 每批回應依索引 map 回對應 block 的 `translation` 欄位
- 失敗段落 `translation = null` + `translationStatus = 'failed'` + 記錄錯誤訊息
- 整批請求失敗（v2.0.53 起）：依 `response.errorCode` 分流——**可對切碼**（`timeout` / `readTimeout` / `blocked` / `empty*` / `customEmptyContent`，縮小批次有機會通過的類型）遞迴切半重送（長度 1 自然收斂），把觸發段隔離、救回其餘段；**不可對切碼**（`network` / `apiKeyMissing` 等縮批無效的）與無錯誤碼者維持整批標 failed、不追加請求。語言驗證失敗維持單次重試上限（v2.0.52 決策），不對切
- 批次 fetch 逾時（v2.0.53 起）：文件翻譯路徑 120 秒（`background.js` `DOC_FETCH_TIMEOUT_MS`，經 `geminiConfig.fetchTimeoutMs` / 自訂 Provider `fetchTimeoutSec` 覆蓋，後者尊重使用者設定的更大值）、逾時重試 1 次（`timeoutRetries`，交對切縮批處理）；網頁翻譯走 `fetchTimeoutSec` 預設（90 秒）
- 譯文接收後處理（v2.0.53 起，`repairDocLlmArtifacts` + `alignTrailingPeriodWithSource`，批次寫回 / 單段重試 / session 載入三接收點共用）：畸形佔位符修復（`⟦/2»` → `⟦/2⟧`）→ 段尾批次分隔符殘片清理 → 標記周邊與 CJK 內文 ASCII 空格收斂（全形空格 / 中英空格 / 換行不動）→ 雙重書名號收斂（`collapseDoubledTitleMarks`，「《《雷霆谷》》」→「《雷霆谷》」——術語表 target 已含《》時模型偶發外包一層；只收「開閉都緊鄰重複」的完整雙包，巢狀書名「《《紅樓夢》研究》」不命中）→ 句尾句號對齊原文（原文句尾無終止標點時刪掉譯文自補的「。」，只刪不加、手動編輯不碰）。快取命中也走同一條，舊壞快取自動治癒

#### 17.5.2 引擎選擇

UI 提供既有三組 preset(`translatePresets`）以 radio 形式呈現，使用者選一組。**不**新增獨立的「PDF 專用 preset」設定，維護成本低。

選定的 preset 透過 `payload.modelOverride` 傳給 `TRANSLATE_BATCH`，沿用既有 modelOverride 機制（YouTube 字幕、preset 翻譯共用同一條路徑）。

#### 17.5.3 快取

沿用既有 `tc_<sha1>` 快取機制，**cache key 多納入 block type + fontSize 桶位**（避免「heading "Introduction"」與「paragraph "Introduction"」共用同一條快取）。

具體 cache key 規則：
```
tc_<sha1(plainText + "\n" + blockType + "\n" + targetLang + "\n" + modelId + "\n" + systemPromptId)>
```

`fontSize` 桶位設計：小字（< 9pt）、中字（9-13pt）、大字（> 13pt）三檔，進 hash 避免桶位跳變導致快取 miss 風暴。

> **note**：此設計將「block type」納入 cache key 是相對既有網頁翻譯 cache key 的擴充，需確認既有 `tc_<sha1>` 不受影響——文件翻譯走獨立 prefix `tcdoc_<sha1>` 區分，既有快取不污染。

#### 17.5.4 進度回報

`pdf-engine.js` 翻譯時每完成一批 emit `progress` 事件：

```js
{
  totalBlocks: number,
  translatedBlocks: number,
  failedBlocks: number,
  estimatedRemainingSec: number,  // 依平均每批耗時推算
  cumulativeInputTokens: number,
  cumulativeOutputTokens: number,
  cumulativeCostUSD: number,       // 即時依當前 preset model 計價
}
```

UI 進度條讀此事件刷新。

### 17.6 線上閱讀器（reader.js）

#### 17.6.1 雙頁並排版型

```
┌─────────────────────────────────────────────────────┐
│ [工具列] 下載譯文 PDF | 重新上傳 | 複製譯文 | preset │
├──────────────────────┬──────────────────────────────┤
│                      │                              │
│   原文 PDF 頁 1      │   譯文 PDF 頁 1              │
│   (PDF.js canvas     │   (純 HTML render,           │
│    + text layer)     │    使用版面 IR + 譯文        │
│                      │    重建段落 layout)          │
│                      │                              │
├──────────────────────┼──────────────────────────────┤
│   原文 PDF 頁 2      │   譯文 PDF 頁 2              │
│   ...                │   ...                        │
└──────────────────────┴──────────────────────────────┘
```

- 左欄：用 PDF.js render 成 canvas + 透明 text layer（供選字 / 複製），完整保留原 PDF 視覺
- 右欄：用版面 IR + 譯文重建 HTML（每 block 一個 `<div data-block-id="p0-b3">`，以 absolute positioning 對齊原版面 bbox 比例），不嘗試完全 pixel-perfect 復刻原 PDF 視覺，但**段落順序與相對位置**對齊

#### 17.6.2 雙向 scroll sync 演算法

每個 block 在左 / 右兩欄都有對應 element（透過 `data-block-id` 對齊）。scroll 監聽：

```
監聽左欄 scroll:
  → 計算當前 viewport 中心 y 座標
  → 在左欄找到中心點落在 bbox 內（或最接近）的 block
  → 取得該 blockId
  → 在右欄找到 [data-block-id="<blockId>"] 的 element
  → 計算右欄該 element 的 offsetTop,讓它對齊右欄 viewport 中心
  → 用 requestAnimationFrame 平滑捲動

右欄 scroll 同理反向
```

**避免循環觸發**：
- 設 `scrollSyncSource: 'left' | 'right' | null` flag
- 主動觸發另一側 scroll 時設為當前側，另一側 scroll handler 看到 source 跟自己一致時 ignore
- 200ms 後清空 flag

**避免抖動**：
- 兩側 scroll 完成偵測用 scrollend 事件（Chrome 114+）+ 250ms debounce fallback
- 每次同步只在 viewport 中心對應的 blockId **改變**時觸發，同 block 內的微調不觸發

#### 17.6.3 譯文 block render

每個送翻譯的 block 在右欄 render 為：

```html
<div class="sk-block sk-block-paragraph"
     data-block-id="p0-b3"
     data-status="done"
     style="position: absolute;
            left: <bboxRatioX>%;
            top: <bboxRatioY>%;
            width: <bboxRatioW>%;
            font-size: <fontSizePt>pt;
            font-weight: <bold ? bold : normal>;
            font-style: <italic ? italic : normal>">
  譯文文字
</div>
```

不送翻譯的 block(`formula` / `figure` / `page-number`；`table` 已在分類階段逐行拆解,不會到這裡）直接 clone 原文 textRuns 的視覺 render:

```html
<div class="sk-block sk-block-formula" data-block-id="p0-b5" data-status="kept">
  原公式文字（保留 unicode）
</div>
```

`translationStatus = 'failed'` 的段落：

```html
<div class="sk-block sk-block-paragraph"
     data-block-id="p0-b3"
     data-status="failed"
     title="翻譯失敗:<errorMessage>;點擊重試">
  原文文字  ← 保留原文（per §17.7 設計決策）
  <button class="sk-retry-btn">↻</button>
</div>
```

點擊 ↻ 按鈕單獨 retry 該段落（走 `TRANSLATE_BATCH` 單筆請求）。

### 17.7 翻譯失敗處理

- **單段落失敗**：該段落 `translation = null`,UI 右欄顯示原文 + 紅色虛線下劃線標記，hover 顯示錯誤訊息，點擊段落右上角 ↻ 按鈕可單獨 retry
- **整批失敗**：該批內所有段落標記 failed,UI 工具列顯示「N 個段落翻譯失敗，點此一鍵重試所有失敗段落」按鈕
- **不做整份 retry**：翻譯成本高、使用者已等候很久，自動整份 retry 等於浪費已成功的段落 token——讓使用者自己選 retry 範圍
- **下載譯文 PDF 時**：failed 段落以原文輸出（不留空、不留錯誤標記）

### 17.8 譯文 PDF 下載（pdf-renderer.js）

點「下載譯文 PDF」觸發 pdf-lib pipeline:

1. 創建新 PDFDocument
2. 對每張原 page:
   - 用 pdf-lib 把原 page 整頁 embed 進新 doc 第 `2N` 頁（原樣保留向量 + 點陣 + 文字）
   - 創建新 page（尺寸同原頁）為第 `2N+1` 頁，依版面 IR 在對應 bbox 比例位置繪製譯文段落：
     - `paragraph` / `heading` / `list-item` / `caption` / `footnote`：用 `page.drawText()` 寫譯文，字型用內嵌的台灣繁中字型（見 §17.8.1），字級沿用原 block fontSize
     - `formula` / `figure` / `page-number`：從原 page 對應 bbox crop 出來貼進譯文頁（`table` 已於分類階段逐行拆解為可翻譯 block）
3. PDFDocument.save() → Uint8Array → Blob → `<a download="<原檔名>-shinkansen.pdf">` 觸發下載

#### 17.8.1 中文字型內嵌

pdf-lib 預設字型（Helvetica 等）不支援 CJK，必須內嵌中文字型：

- 採用免費商用授權的開源繁中字型（評估候選：思源黑體 Noto Sans TC、Source Han Sans TC），選一款最終決定後 vendor 進 `shinkansen/translate-doc/fonts/`
- 字型檔以 woff2 / otf 格式打包，啟用 pdf-lib 的 subsetting（只 embed 譯文實際用到的字元），最終 PDF 體積約增加 1-3 MB（視譯文字數）
- 字型授權文字附在 `lib/vendor/fonts/LICENSE-NotoSansTC.txt`，並列於 `THIRD-PARTY-NOTICES.md`；Chrome Web Store 描述需標示包含的開源字型授權

> **note**：此處字型 vendor 屬於 §18 例外條款 1（直接 vendor code / 資源，授權要求標示）——必須在 `lib/vendor/fonts/LICENSE-NotoSansTC.txt` 與 `THIRD-PARTY-NOTICES.md` 標示字型來源 + 授權，不違反硬規則 §18。

#### 17.8.2 譯文 PDF 排版

- 譯文頁背景：純白
- 文字方向：橫排，由左至右
- 段落間距：沿用原版面 IR 的 bbox 相對位置，等比例投影到新頁
- 字級不夠長放下時：譯文段落自動換行（pdf-lib 不支援自動 word wrap，需手動實作 line breaking——按字寬累加超過 bbox width 即斷行）
- 譯文長度溢出 bbox 時：不裁切、不縮字級，允許溢出到 bbox 下方（下一個 block 的位置可能被覆蓋，屬已知限制）

### 17.9 訊息協定增補

於 §14 既有訊息協定基礎上新增：

| type | payload | 回應 | 用途 |
|------|---------|------|------|
| `TRANSLATE_DOC_BATCH` | `{ blocks: [{ blockId, plainText, blockType, fontSize }], modelOverride, glossary }` | `{ ok, results: [{ blockId, translation, error? }], usage }` | 文件翻譯專用批次，跟 `TRANSLATE_BATCH` 同流程但 cache key 走 `tcdoc_` prefix + 多納入 blockType / fontSize 桶位 |

document 翻譯頁不是 content script，直接從 `translate-doc/index.js` 透過 `chrome.runtime.sendMessage` 送 background。

### 17.10 EPUB 電子書翻譯

> v2.0.11 起。設計脈絡與決策紀錄見 SPEC-PRIVATE §30。

#### 17.10.1 入口與分流

與 PDF 共用同一頁（`translate-doc/index.html`）。`handleFile` 依副檔名 `.epub` 或 MIME `application/epub+zip` 分流到 EPUB 管線；file input `accept` 同時收 PDF 與 EPUB。

**限制**（`epub-engine.js` `EPUB_LIMITS`）：
- 硬上限：檔案 100 MB（EPUB 體積多為圖片，與翻譯成本無關，防呆值）
- 軟警告：已勾選章節「可翻譯字元數」合計 > 50 萬 → confirm 對話框（顯示字數與預估費用）才開跑
- DRM：`META-INF/encryption.xml` 含字型混淆（IDPF / Adobe font obfuscation）以外的加密演算法 → 拒收並顯示錯誤

#### 17.10.2 解析（epub-engine.js）

```
File → fflate.unzipSync（lib/vendor/fflate/，MIT）
  → DRM 偵測（encryption.xml）
  → META-INF/container.xml → OPF（metadata / manifest / spine）
  → TOC 標題（EPUB3 nav doc 優先，NCX fallback；再 fallback 章內首個 heading / 檔名）
  → 逐 spine 章節：DOMParser('application/xhtml+xml') → collectChapterBlocks
  → epubDoc（pages[] = 章節，與 PDF 版面 IR 同形狀 → translateDocument / 術語表
    editor / 進度 UI 原樣重用）
```

**block 抽取**：候選 tag = `p`／`h1-h6`／`li`／`blockquote`／`figcaption`／`caption`／`td`／`th`／`dd`／`dt`／`div`，leaf 原則（候選內含另一候選時取內層）；`pre`／`script`／`style`／`template`／`svg`／`math`／`nav` 子樹整棵不收；純數字 / 純標點段不送翻。XHTML parse 失敗的章節標 `parseFailed`，整章保留原文。

**附屬頁啟發式**（`suggestSkip`，預設不勾選）：spine `linear="no"`、nav doc、檔名命中 cover／toc／copyright／titlepage 等、或字數 < 200。

#### 17.10.3 序列化（重用 content-serialize.js）

`index.html` 以 `<script src>` 載入 `content-ns.js` + `content-serialize.js`（必須排在 `lib/i18n.js` 之前——content-ns 會重建 `window.__SK`）。段內 inline 標記（`em`／`strong`／`a`／`span[class]`／`sub`／`sup` 等）用既有 `⟦N⟧…⟦/N⟧`／`⟦*N⟧` 佔位符協定保留，LLM 端規則由 `lib/system-instruction.js` 依「文字含 ⟦」自動注入（單一資料源）。

- **tagName 大小寫**：XHTML DOMParser 產小寫 tagName，序列化前先把 block 轉成頁面 HTML document 的 clone（`htmlCloneFromXhtml`），譯文反序列化後 `importNode` 回 XHTML document
- **EPUB 專屬政策 override**（`applyEpubSerializerPolicy`，只影響本頁 `__SK` instance）：inline `svg`／`math` 走 atomic 保留；零文字但帶 `id` 或 `epub:type` 的錨點元素（pagebreak 標記、cross-ref 錨）走 atomic 保留，否則書內連結會斷
- 送 LLM 文字 = `block.epubSerializedText`（`translate.js` `buildMarkedText` 的 EPUB 分支）；原始譯文（含佔位符）存 `block.translationRaw` 給 writer，`block.translation` 存去除標記後的純文字（預覽 / 複製用）

#### 17.10.4 章節選翻與試翻 review

解析完成進章節清單 stage（`#stage-chapters`）：每章顯示 TOC 標題、字數、預估費用（`estimateChapterCostUSD`，依 preset model 查 `lib/model-pricing.js`；查不到顯示「—」）、翻譯狀態與預覽按鈕。全選 / 全不選 / 排除附屬頁快捷鍵。

- 翻譯只跑勾選章節（`translateDocument` 的 `blockFilter` option），批次不跨章節語意（`filterGlossary` 過濾以批為單位）
- 完成後回章節清單：整章完成的自動取消勾選（續翻節奏：下一輪預設剩未翻章節）；已翻章節可逐章預覽（`#stage-epub-preview`）
- **預覽可直接編輯**：已翻段落渲染反序列化後的富文本（含斜體 / 連結）且 `contenteditable`，blur 時存 `block.editedHtml`（同步更新 `block.translation` 純文字），下載譯本時優先於機器譯文；重新翻譯該章會清掉 `editedHtml`（UI 有提示）。編輯內容寫回前消毒（剝 `script` / `style` / `template` 與 `on*` 屬性）。**貼上一律降為純文字**（paste 攔截取 `text/plain` 走 `insertText` 插入，繼承游標處樣式）——rich paste 會把來源 inline style（`font-family` 等 span）帶進 `editedHtml` 造成譯本字體不一致，且寫回消毒不能剝 `style` 屬性（原書合法標記也可能帶 style，分不出來源）；代價是複製既有斜體再貼會失去 inline 標記
- **預覽強化**（2026-07-10）：「顯示原文對照」toggle（每個已翻段落下方附原文，降淡、不進編輯與取代）；「全書預覽」按鈕（全部章節連續渲染，章節標題分隔）；**搜尋取代**列（只動已翻段落譯文的文字節點、inline 標記保留，跨標記邊界的字串搜不到屬已知取捨；改動走 `editedHtml` 語意，下載與 session 存檔都吃得到）
- **譯文空格自動校正**（開啟章節 / 全書預覽與下載譯本 EPUB 時自動執行，僅 target 為中文時；翻譯設定 modal 有「譯文空格自動校正」toggle，`translateDoc.epubAutoFixSpacing`，預設開啟＝缺值視為開）：規則在 `epub-scan.js` `addCjkLatinSpacing`（與掃描替換共用同組 CJK / 拉丁邊界字元集合），皆冪等：1) **補**——CJK↔拉丁直接相鄰缺漏的空格（LLM 輸出偶發漏掉，如「批評F1是無謂」→「批評 F1 是無謂」）；2) **移**——全形標點符號與中英文之間的多餘 `[ \t]`（「F1 ，」→「F1，」；標點集合取 U+3001-303F ＋全形 ASCII 標點，刻意不含 U+3000 全形空格與 `…` `—`——後兩者在內嵌英文句也合法使用）。跨 text node 相鄰靠 prevChar context 在後節點前緣補 / 移；空格落在前節點尾端的移除案例搆不到（不跨節點改字）。CJK↔全形標點側與譯文接收鏈 `collapseCjkAsciiSpaces` 部分重疊——接收鏈只治新譯文，本規則是預覽 / 下載時機對全書（含舊 session / editedHtml）補掃。作用範圍 = 全書已翻段落（`index.js` `autoFixCjkSpacing` 逐 block 離屏渲染），改動走 `editedHtml` 語意（同搜尋取代，下載 / session 存檔都吃得到）；預覽開啟時有修正在搜尋取代狀態列顯示「已補 N 處空格（M 段）」
- 重勾已翻章節 → confirm 警告「以目前術語表與設定重翻並重新計費」，確認後**清掉該批段落的翻譯快取**（`clearEpubBlocksCache`，以 `epubSerializedText` 的 sha1 為 prefix 掃 suffix 變體）——重勾語意 = 真重翻，不吃 cache；正常續翻 / 中斷恢復不走這條，快取仍有效
- 「本書累計費用」跨輪加總顯示，**含全書術語表抽取費用**（抽取回應的 `usage.billedCostUSD` 累進，快取命中為 0）；「下載譯本 EPUB」在任一章節完成後出現，未翻章節保留原文（部分譯本天然支援）
- **工作階段存檔**（2026-07-10）：翻譯進度（done block 的譯文 / 手動編輯）+ 全書術語表 + 本書禁用詞 + 本文件額外翻譯指令（`extraPrompt`）+ 本書累計費用整包存 IndexedDB（`epub-session-db.js`，db `shinkansen-epub-sessions`，key = 書指紋）。重開同檔自動還原、還原章節預設不勾；**不受「清除翻譯記憶」影響**（工作成果與機器翻譯快取分離）。存檔時機：翻譯完成（showStage 前 await）、預覽編輯 / 搜尋取代（800ms debounce）、術語表 / 禁用詞儲存。還原（hydrate）時自癒（v2.0.53）：raw 過協定殘片修復 + 句尾句號對齊後，`translation` 依「editedHtml 優先」導出——有手動編輯的段落從 editedHtml 取純文字（不可從 raw 重算，否則已修正段落被機器原譯蓋回，掃描重複列違規）；無編輯的從修好的 raw 重新 strip
- **工作階段匯出 / 匯入**（2026-07-10）：匯出成 `<原檔名>-session.json`（type `shinkansen-epub-session`，含書指紋 / 術語表 / 本書禁用詞 / 本文件額外翻譯指令（`extraPrompt`，翻譯設定隨匯出帶走）/ 累計費用 / done blocks / `failures` 失敗診斷欄——failed block 的 blockId、章節、錯誤訊息、原文，僅供診斷，匯入端不 hydrate）；匯入以檔案內容整包取代目前進度，**書指紋不符直接拒絕**（blockId 由內容派生，跨書匯入只會得到垃圾對映）
- **放棄本書翻譯**（主功能按鈕，紅字、confirm 後執行）：清掉這本書**全部** work in progress——翻譯進度（含手動編輯）、全書翻譯快取、累計費用、術語表、本書禁用詞、session 紀錄（含舊版 `bookgloss_` fallback key）、本書的 `gloss_` 抽取輪快取（含任何 target 後綴，前綴比對；否則重開同書「先建立術語表」逐輪秒回快取，看似沒清乾淨）——並**立即離開本頁回到選取檔案畫面**。想留備份先「匯出工作階段」，匯入即整包還原。取代翻譯設定 dialog 的「清除本篇翻譯記憶」（EPUB 時該區塊隱藏——其 plainText hash 算法對 EPUB 段落不正確）
- 術語表按鈕動態標籤：沒建過 =「先建立全書術語表」、已有 =「編輯全書術語表」
- **輸出格式**：來源是 EPUB 2 時下載旁顯示「輸出格式」select（原檔版本 / EPUB 3）；EPUB 3 來源不顯示（兩者等價）。升級動作見 §17.10.6
- **譯本內容**：有任何翻譯（= 下載按鈕出現）時下載旁顯示「譯本內容」select（單語譯文 / 雙語對照，預設單語）。純 writer 層下載時選項——譯文資料不變，已翻好的書切換模式重新下載零重翻費用。雙語結構見 §17.10.6

#### 17.10.5 全書術語表（譯名跨章節一致性）

解「同一人名在不同章節譯名漂移」問題，五層設計：

1. **全書抽取**：`buildBookGlossaryRounds` 把全書 blocks 依序切成 ≤60K 字的輪次（覆蓋全書，上限 40 輪），逐輪送 `EXTRACT_GLOSSARY`（帶 `payload.promptSuffix` = 書籍模式規則：角色暱稱 / 簡稱 / 敬稱變體各建一條、多詞人名另建姓氏條目）。`inputHash` 由 caller 摻入 suffix 版本標記（`#shinkansen-book-glossary-v2`），不與一般抽取共用 `gloss_` 快取
2. **合併**：`mergeBookGlossaries` 同 source（大小寫不敏感）以先出現輪為準（角色初登場譯法優先），衝突計數，合併上限 500 條
3. **鎖定 + 審閱**：抽完進既有 glossary editor 編輯。EPUB 入口的主要按鈕是「**儲存**」（存術語表 + 本書禁用詞後回章節清單，開始翻譯集中在主流程；PDF 入口維持「用此術語表翻譯」）。可匯出 / 匯入 JSON（系列作續集重用前作譯名，選項 flag 與 type 一併保留）。現有表非空時匯入走三選 dialog：**合併**（原文相同——大小寫不敏感——以匯入譯名為準，現有表獨有條目保留；重用 `mergeBookGlossaries`，勝出條目的 type 與選項 flag 一併保留）/ **覆蓋** / 取消；現有表為空直接匯入。編輯器（v2.0.11）：
   - **分組顯示**：人名 / 地名 / 其他術語三組（依抽取 type：person / place / 其餘），group header 帶計數；**欄位排序**——點「原文 / 譯文」header 切換排序欄、同欄再點反向（▲▼ 指示），排序在各分組內進行，預設原文升冪
   - **人名不翻譯**（toggle 位於「人名」group header 旁）：一鍵把人名組全部條目設為不翻譯；人名組全數 noTranslate 時 toggle 顯示為勾選
   - **重新抽取 = 強制重跑**：`payload.forceRefresh` 繞過 `gloss_` 快取讀取（否則同文字同 hash 秒回快取，按了形同沒按）；新結果仍寫回快取。editor 初開的自動抽取不帶 flag（快取命中免費）
   - **不翻譯**（`noTranslate`，逐條）：該名詞在譯文保留原文。注入時映射成 `原文 → 原文`（`injectableArticleGlossary`），譯文欄 disabled
   - **對照一次**（`dedupeAnnotation` + `dedupeKeep`，預設 `source` = 後續用原文）：只在譯文長相是「A（B）」對照式（全形括號收尾）時顯示。勾選後全書第一次出現保留完整對照，後續出現改用原文或譯文（子選項）；替換時 CJK↔拉丁邊界自動補空格。**譯文欄順序 = 首次出現的長相**：勾選「對照一次」且「後續用原文」時，譯文欄自動翻轉成「原文（譯文）」（例「Camel Trophy（駱駝盃越野挑戰賽）」），首次對照的 lead token 與後續出現一致；切「後續用譯文」或取消勾選則翻回「譯文（原文）」。只在欄位兩 token 之一等於原文欄時翻轉（使用者自訂格式不動）。**書名號跟著 lead token 走**：任一 token 帶《》的作品名 entry，翻轉後《》包 lead、括號內不帶（「《妳是我今生的新娘》（Four Weddings）」⇄「《Four Weddings》（妳是我今生的新娘）」），比對原文欄時先剝《》再比；`computeAnnotationDedupe` 的 token 角色比對同樣剝《》，keep token 用原樣（後續出現保住《Four Weddings》書名號）；翻轉後的欄位同時是注入 prompt 的譯法，LLM 每次出現都輸出該順序，不需另加 prompt 規則。實作是下載 / 預覽共用的確定性後處理（`epub-writer.js` `computeAnnotationDedupe`，token 角色以 `source` 比對決定——兩種欄位順序與舊 session 存檔都相容，按 spine 閱讀順序，不改動已存譯文；編輯過（editedHtml）的段落——含掃描替換存回的——也套用，以 text node 級處理，「首次出現保留」計數跨兩種段落統一；已知限制：對照字串被行內標記從中切開時搆不到），不影響注入與快取
   - 工具列另有「清空」按鈕（confirm 後清空整份並同步清 session 持久化）
   - **本書禁用詞**（EPUB 才顯示）：禁用詞 / 替換詞小表格，與「設定 → 禁用詞清單」共通清單合併注入（`payload.extraForbiddenTerms` → background `mergeExtraForbiddenTerms`，上限 200 條；`_b` cache hash 由合併後清單計算，書級清單變更快取自動失效）
4. **批次級過濾注入**：`filterGlossaryForTexts` 每批只注入該批原文出現的條目——完整 source 或多詞條目的末詞（≥3 字元，姓氏單獨出現場景）命中都算。glossary hash 進 cache key（既有機制）
5. **持久化**：以書指紋（全書 plainText 的 sha1，非 OPF `dc:identifier`）隨工作階段存 IndexedDB（§17.10.4 工作階段存檔），同書重開自動載回，**不受清除翻譯記憶影響**。空陣列是有效狀態（「清空過」≠「沒建過」，重開不觸發自動抽取）。舊 `bookgloss_<sha1>`（chrome.storage.local）只在**完全沒有 session 紀錄**時讀取 fallback，且 session 落地成功即刪除 legacy key（防清空後被復活）；`clearDocTranslationCache` 仍會清 legacy key
6. **人名間隔號正規化**：CJK 之間的半形間隔號（`·` U+00B7／`‧` U+2027／`･` U+FF65）一律轉全形「・」（U+30FB，例「拉夫・舒馬克」），只在兩側都是 CJK 時替換（URL／拉丁縮寫不動）。三層：術語表 target 所有入口（抽取／手動／匯入／注入）＋ EPUB 譯文輸出（`translate.js` epub 分支）＋書籍模式抽取 prompt 明文規則（hash 記號 v3）。範圍限文件翻譯，網頁翻譯路徑維持排版歸 prompt 原則

#### 17.10.6 譯本 EPUB 重建（epub-writer.js）

- 已翻 block 寫回優先序：①`editedHtml`（預覽頁手動編輯 / 掃描替換，含「對照一次」後處理 override）→ ②`translationRaw`（含「對照一次」後處理 override）經 `SK.deserializeWithPlaceholders`（`cloneReuse: true`）→ `importNode` 回章節 XHTML → `replaceChildren` → ③純文字 fallback（同樣吃後處理 override）
- 修改過章節更新 `<html lang / xml:lang>`；OPF `dc:language` 更新為 target 語言（Apple Books / Kobo 依此選字型 / 斷行）
- **EPUB 2 → 3 升級**（`buildTranslatedEpub` 的 `upgradeTo3` option）：`package@version` → `3.0`、補 `dcterms:modified` meta（EPUB 3 必填）、從章節清單（NCX 解析出的標題）生成 EPUB 3 必備的 nav 文件（`sk-nav.xhtml`，manifest `properties="nav"`）。NCX 與章節內文原樣保留（向下相容；章節 doctype 維持 XHTML 1.1，主流閱讀器接受，屬已知取捨）。manifest 已有 nav item 時不重複生成
- **雙語對照輸出**（`buildTranslatedEpub` 的 `bilingual` option）：原文段落保留並加 `sk-dual-src` class（注入 `<style id="sk-dual-style">`：`font-size: 0.9em; opacity: 0.72`——縮小 + 降透明度雙通道，不用固定色值以兼容閱讀器深色主題），譯文以 `sk-dual-tr` 元素交錯插在每段後。網頁 dual mode 的 EPUB 版，但用標準標籤 + class（`<shinkansen-translation>` 自訂標籤過不了 epubcheck）。位置策略比照網頁 dual mode：一般 block（p / div / blockquote / heading）同 tag sibling 插原文後；`li` / `td` / `th` / `dd` / `dt` / `caption` / `figcaption` 內嵌 `<span>` + CSS `display:block`（sibling 會弄壞列表編號 / 表格結構 / dl 配對 / figure 單一 figcaption 限制；不用 `<div>`——XHTML 1.1 的 `dt` / `caption` 只收 inline 內容，div 對 EPUB2 來源是無效 XHTML）。譯文副本一律剝 `id`（原文保留錨點；重複 id = 無效 XHTML，會破註腳 / 頁碼跳轉）。`dc:language` / 章節 lang 仍標 target（譯文為主要閱讀內容）。「對照一次」後處理兩種模式行為一致（per-entry 使用者選項，雙語下仍尊重）
- 重打包（fflate `zipSync`）：`mimetype` 必為第一個 entry 且 STORED 不壓縮（OCF 規範）；未修改 entry（CSS / 圖片 / 字型 / 未翻章節）原樣 bit-for-bit 帶過
- 下載檔名 `<原檔名>-shinkansen.epub`（雙語 `<原檔名>-shinkansen-dual.epub`，兩版可並存）；重複下載 / 單雙語切換 idempotent（block 首次套用前快照原文子節點，之後每次先還原再套；雙語殘留每輪先清）

#### 17.10.7 訊息協定增補

`EXTRACT_GLOSSARY` / `EXTRACT_GLOSSARY_CUSTOM` payload 新增可選 `promptSuffix`（≤2000 字元，background 附加在有效 glossary prompt 之後；caller 需自行把 suffix 摻進 `inputHash`，否則同文字不同 suffix 會吃到彼此快取）與 `forceRefresh`（跳過快取讀取強制重跑，結果仍寫回）。

新增 `SCAN_TERM_RENDERINGS`（一致性掃描的譯名對照抽取，§17.10.10）：payload `{ items: [{ term, samples: [{ blockId, text }] }], inputHash }`，回 `{ ok, renderings: [{ term, renderings: [str] }], usage, fromCache }`。走術語表模型（`glossary.model`，預設 Flash Lite）、`scanr_<hash>` 內容快取（同 payload 同結果，重掃不重複計費，與 `tc_` / `gloss_` 同 LRU 淘汰池）、用量記 usage-db `source='scan'`、`usage.billedCostUSD` 回給頁面累進本書累計費用。

#### 17.10.8 翻譯設定（dialog）增補

- **每批段數**（`settings.translateDoc.batchSize`，1-100，預設 50）：每次 AI 請求包含的段落數。translate-doc 端以此切批並隨 `payload.docBatchSize` 送 background，覆蓋該請求的 `maxUnitsPerBatch`（gemini / openai-compat 的 `packChunks` 以此切 API 請求）——「一批」= 一次 API 請求。只影響文件翻譯（PDF + EPUB），網頁 / 字幕不受影響；字元上限（`maxCharsPerBatch`）保護仍在，超長段落仍會被切小
- **本文件額外翻譯指令**（per-document，PDF + EPUB 都顯示）：只套用在目前文件的補充 prompt。隨 `payload.extraPrompt` 送 background，`TRANSLATE_DOC_BATCH` / `TRANSLATE_DOC_BATCH_CUSTOM` 附加在 `translateDoc.systemPrompt`（effective doc prompt）之後、`DOC_INLINE_MARKER_INSTRUCTION` 之前（marker 協定永遠收尾）；trim 後非空時以 `_x<hash12>` 進 cache key（§9.1），改動後重翻自動重新呼叫 AI。**不進 chrome.storage**（換文件不帶著走）：PDF 只存記憶體（換檔即清）；EPUB 隨工作階段持久化（session `extraPrompt` 欄），並跟「匯出 / 匯入工作階段」JSON 一起帶走。單段 retry（PDF reader「重試失敗段落」）同樣帶此指令，與主翻譯同 cache key
- **Google MT preset 禁選**：文件翻譯不支援 Google Translate，preset 列表照常顯示該 slot 但 radio disabled + 紅字標注（原本可選、按開始翻譯才撞 runtime banner）
- **換 preset / 模型儲存後**：EPUB 章節清單的每章預估費用即時重算
- **段落間距至少 0.5em**（`translateDoc.epubParagraphSpacing`，EPUB 才顯示，預設關）：對有譯文的章節 `<head>` 尾端注入 `p { margin-top: 0.5em !important }`。「最少」語意靠 CSS margin collapse——相鄰段落間距 = max(前段 margin-bottom, 0.5em)，原書段距 ≥0.5em 時排版不變、`margin:0` 傳統排版變 0.5em。已知邊角：罕見的 top-margin-only 排版會被壓到 0.5em。idempotent（每次 build 先移除舊注入）
- **譯後一致性掃描**（`translateDoc.consistencyScan`，EPUB 才顯示，**預設開**；缺值 = 開）：見 §17.10.10

#### 17.10.9 翻譯中動態提示

「翻譯中」stage 標題旁有 spinner、進度條帶 shimmer 動畫（長批次期間畫面仍有動態感，避免被當成當機）；術語表抽取 loading 態同樣附 spinner（`forceRefresh` 多輪重抽是真實等待）。

#### 17.10.10 譯後一致性掃描（epub-scan.js）

每輪翻譯完成回到章節清單後於背景自動執行（option `translateDoc.consistencyScan` gate，預設開；**option 只管自動掃描**，手動觸發不受限），亦可手動觸發（見下方入口說明），兩層訊號：

1. **術語表符合度**（確定性，免費）：原文含術語表 source（拉丁詞取詞邊界比對）的已翻段落，譯文必須含指定譯名本體（「譯名（原文）」對照格式取全形括號前本體；`noTranslate` entry 則須含原文）。違規分兩路處理：
   - **自動替換**：違規段譯文仍殘留原文詞（LLM 沒翻、把原文留在譯文裡）→ 掃描完成時直接把原文詞替換成指定譯名（`replaceTermInText`，與比對同一套詞邊界語意；text node 級、`editedHtml` 手動編輯語意，同層 3 的套用；刻意不重翻）。**所有掃描替換**（自動替換 / 搜尋替換 / 漂移套用）共用 `replaceTermInText`，並套用 CJK↔拉丁邊界空格規則：換入拉丁詞貼著 CJK 補空格、換入 CJK 後與相鄰 CJK 之間殘留的單一空格移除（「Ferrari 車隊」→「法拉利車隊」）；詞落在 text node 開頭 / 結尾時以相鄰節點的字元判斷邊界（跨節點只補不刪）；詞被行內元素切成多個 text node 時（日文 ruby 逐字 slot 等）另有跨節點替換（v2.0.53，`replaceAcrossTextNodes`）——串接全文定位、映射回節點區間動手術，詞邊界與空格語意經 synthetic context 重用 `replaceTermInText`。結果依 entry 分組列為「已自動替換」揭露列（`noTranslate` 違規 = 譯文把該保留的原文弄丟，無從確定性還原，不自動處理）
   - **待處理列**：譯文既無指定譯名也未殘留原文詞（LLM 用了別種譯名）→ 依 entry 分組列出（章節統計），**逐段附「原文摘錄（原詞加粗）+ 譯文摘錄」**（最多 6 段，超出顯示「…還有 N 段」；譯文無精確錨點——指定譯名與原詞都不在譯文中——以原詞在原文的位置比例對位取前後文，讓使用者看到 LLM 實際用的寫法再決策），附**輸入欄 + 「搜尋替換」按鈕**——使用者從譯文摘錄看出 LLM 實際用的譯名後直接輸入，在「原文含該詞」的已翻段落把它替換為指定譯名（範圍同漂移套用；詞邊界與空格規則同 `replaceTermInText`），完成後重算符合度並刷新掃描結果、以「已搜尋替換」揭露列列出，找不到輸入詞就地顯示說明；另附**「略過」按鈕**——人工 review 認定該 entry 不需替換 → 記入略過清單（隨工作階段持久化、匯出匯入也帶著），之後重掃不再列出、自動替換也不碰；已略過列以揭露列形式留在結果頁（計入入口計數）附「復原」按鈕可撤銷
2. **同一原文多譯名偵測**（術語表外）：
   - **候選挖掘**（確定性）：已翻段落原文中的連續大寫詞組 + 片假名連串；過濾「原文他處以小寫出現過的詞」（句首大寫的普通詞）、「多數出現緊跟另一大寫詞的單詞」（Mr / Lady 等稱謂前綴）、術語表已收錄 source；須出現於 ≥2 段，上限 120 候選
   - **對照抽取**（LLM）：每候選分散取樣 ≤6 段譯文（頭尾均勻，各截 600 字元），批次送 `SCAN_TERM_RENDERINGS` 問「該詞在各段譯文中的實際譯法子字串」
   - **聚合**（確定性）：防幻覺守門——回傳譯名必須真的出現在對應取樣文中，否則丟棄；互為子字串的譯名視為同一個（稱謂 / 修飾差異非漂移）；剩 ≥2 種譯名 = 漂移案例
3. **套用**：結果頁每案例列出各譯名選項，**每譯名附出現處的譯文摘錄**（章節標記 + 前後文各 40 字元、譯名本體加粗——同 term 的不同譯法可能是語境差異而非漂移，例如日期措辭，須帶上下文才能決策）；使用者選定譯名（預設最多數者）→「套用」把「原文含該詞」的已翻段落中其他譯名以 text node 級取代為選定譯名（同搜尋取代語意，走 `editedHtml` → session / 譯本都吃得到；刻意不重翻——cache key 會變、重計費）。**套用後卡片顯示結果摘錄**（每個被改段落的當前譯文前後文、統一譯名加粗，最多 6 段）供人工確認：「略過」收起卡片（本輪掃描狀態，套用後重掃不會再偵測到同一漂移，不需持久化）、「復原」把被改段落還原成套用前快照；**未套用的案例卡也有「略過」**——人工判斷非真漂移（如日期語境差異）→ 記入漂移略過清單（隨工作階段持久化、匯出匯入帶著），之後重掃連候選都不進（不送 LLM 對照抽取），已略過項以揭露列列在漂移區附「復原」（editedHtml / translation 逐段還原；不動術語表）。**套用預設不回填術語表**；獨立「加入術語表」按鈕把選定譯名寫入全書術語表（後續翻譯經注入優先採用——軟約束，漏用由掃描第 1 層把關；同 source 已存在則更新譯名），套用前後皆可按

入口：章節頁按鈕，書內有已翻段落即顯示（掃描中 = 進度文字；有發現 = 「一致性掃描：N 個發現」開結果頁 `#stage-scan`，計數含已自動替換條目——程式動過譯文必須讓使用者看得到；尚未掃描 / 零發現 = 「掃描譯名一致性」**手動觸發**——重開工作階段或 option 關閉時的掃描途徑）。結果頁另有「重新掃描」按鈕（套用 / 編輯後重驗）。結果不持久化，每輪翻譯後重掃；自動替換的譯文變更經 session 存檔持久化；對照抽取費用累進本書累計費用（`scanr_` 快取命中為 0，手動重掃幾乎免費）。

**訊號層**：掃的是「同一原文多譯名 / 指定譯名缺席」，不驗「單一譯名但翻得差」（品質歸 prompt / 模型）；中文原文書（zh→en 等）無大寫 / 片假名特徵，候選挖掘抓不到，該方向掃描實質只有第一層。

