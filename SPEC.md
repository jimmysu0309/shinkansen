# Shinkansen — 規格文件（SPEC）

> 一款專注於隱私的網頁翻譯 Chrome Extension。

- 文件版本：v1.1
- 建立日期：2026-04-08
- 最後更新：2026-04-25（v1.5.4）
- 目標平台：Chrome（Manifest V3）
- 作業系統：macOS 26
- 目前 Extension 版本：1.9.9

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

### 2.1 已實作（v1.9.9 為止）

詳細版本歷史見 [`CHANGELOG.md`](CHANGELOG.md)。

| 功能區塊 | 狀態 | 簡述 |
|---------|------|------|
| 網頁翻譯 | ✅ | Option+S（Gemini）/ Option+G（Google Translate）切換；單語覆蓋 / 雙語對照雙模式；漸進分批注入；還原原文 |
| 雙語對照模式 | ✅ | v1.5.0 新增；popup toggle 切換；譯文以 `<shinkansen-translation>` wrapper 形式 append 在原段落後/內；4 種視覺標記 |
| YouTube 字幕翻譯 | ✅ | XHR 預翻 + on-the-fly 備援；時間視窗批次；seek/rate 補償；字幕框展開置中；SPA 導航自動重啟；ASR（自動字幕）走獨立合句路徑（v1.6.20） |
| SPA 支援 | ✅ | History API 攔截 + URL 輪詢；MutationObserver rescan；Content Guard；stickyTranslate 續翻 |
| 段落偵測 | ✅ | walker + mixed-content fragment；PRE 條件排除；leaf DIV / grid cell 補抓；nav 放行 |
| 佔位符序列化 | ✅ | 配對型 ⟦N⟧…⟦/N⟧ + 原子型 ⟦*N⟧；媒體保留；含圖連結重建 |
| 並行翻譯 + Rate Limiter | ✅ | 三維滑動視窗（RPM/TPM/RPD）；Priority Queue；429 退避；concurrency pool |
| 自動術語擷取 | ✅ | Gemini 預翻前擷取專有名詞；長度三級策略；術語快取（`gloss_` prefix） |
| 固定術語表 | ✅ | 全域 + 網域兩層；設定頁編輯；優先覆蓋 LLM 自動術語 |
| 翻譯快取 | ✅ | `chrome.storage.local`；SHA-1 key；版本變更自動清空 |
| 設定頁 | ✅ | 5 Tab：一般設定 / Gemini / 術語表 / 用量紀錄 / Debug；匯入匯出 |
| Popup 面板 | ✅ | 翻譯/還原；快取/費用統計；自動翻譯開關；YouTube 字幕 toggle |
| Toast 提示 | ✅ | 進度條 + 計時器；可調透明度與位置；`toastAutoHide` 自動關閉選項 |
| 用量紀錄 | ✅ | IndexedDB + 折線圖 + CSV 匯出；日期/模型/網域/文字搜尋篩選 |
| Debug 工具 | ✅ | Debug Bridge（CustomEvent）；Log buffer 1000 筆 + 持久化 100 筆（`youtube` / `api` / `rate-limit` / `translate` 跨 SW 重啟）；YouTube `GET_YT_DEBUG` action |
| Google Docs 支援 | ✅ | 偵測編輯頁自動導向 `/mobilebasic` 閱讀版再翻譯 |
| 自動語言偵測 | ✅ | 跳過已是目標語言的頁面（可設定關閉）；比例制偵測；日韓文排除；v1.8.59 起 target-aware（zh-TW/zh-CN/en 各自跳對應源語言） |
| 翻譯目標語言 | ✅ | v1.8.59 新增；可選 zh-TW（台灣繁中）/ zh-CN（中國簡中）/ en（英文）；非 zh-TW 走 universal prompt 注入 `{targetLanguage}`；詳見 §3.9 |
| 自動翻譯網站 | ✅ | 網域白名單（支援萬用字元）；`autoTranslate` 總開關 |

### 2.3 明確不做

滑鼠懸停顯示、原文樣式客製、輸入框翻譯、劃詞翻譯、DeepL / Yandex 等第三方付費翻譯服務、影片字幕（YouTube 除外，已支援）、延遲載入、多國語言介面、淺色/深色主題切換。

> 備注：v1.4.0 起已加入 Google Translate 非官方免費端點（Opt+G，不需 API Key），同時保留 Gemini（Opt+S）。Google 官方 Cloud Translation v2 API（付費）不在支援範圍內。

---

## 3. 翻譯服務：Google Gemini

### 3.1 API 端點

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={API_KEY}
```

### 3.2 開放使用者微調的參數

- `model`：模型名稱（預設 `gemini-3-flash-preview`，可改為其他 Gemini 模型或自行輸入模型 ID）
- `serviceTier`：推論層級（DEFAULT / FLEX / STANDARD / PRIORITY），設定頁存大寫短形式，API 送出時轉小寫（`flex`/`standard`/`priority`），DEFAULT 時不送此欄位
- `temperature`：創造性，範圍 0–2，預設 1.0（Gemini 3 Flash 原廠預設值）
- `topP`：核採樣，預設 0.95
- `topK`：預設 40（Gemini 3 Flash 原廠預設值，Pro 系列為 64）
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

**對齊失敗 fallback**：回傳段數不符時退回逐段單獨呼叫模式。

**實作位置**：`content.js` 的 `packBatches()` 為主要打包層，`lib/gemini.js` 的 `packChunks()` 為雙重保險層。

### 3.5 Rate Limiter

三維滑動視窗（RPM / TPM / RPD），實作於 `lib/rate-limiter.js`。

- **RPM**：60 秒滑動視窗，時間戳環形緩衝區
- **TPM**：60 秒滑動視窗，token 估算 `Math.ceil(text.length / 3.5)`
- **RPD**：太平洋時間午夜重置，持久化至 `chrome.storage.local`（key `rateLimit_rpd_<YYYYMMDD>`）
- **安全邊際**：每個上限乘以 `(1 - safetyMargin)`，預設 10%
- **429 處理**：尊重 `Retry-After` header，否則指數退避 `2^n * 500ms`（上限 8 秒）。RPD 爆則不重試

Tier 對照表在 `lib/tier-limits.js`，涵蓋 Free / Tier 1 / Tier 2 各模型的 RPM / TPM / RPD。設定頁可選 Tier 或自訂覆寫。

### 3.6 術語表一致化

翻譯長文前先呼叫 Gemini 擷取全文專有名詞對照表，注入所有翻譯批次的 systemInstruction。

**策略依文章長度分三級**（由 `glossary.skipThreshold` 和 `glossary.blockingThreshold` 控制）：

- ≤ `skipThreshold`（預設 1）批 → 完全跳過，不建術語表
- `skipThreshold` < 批數 ≤ `blockingThreshold`（預設 5）→ fire-and-forget（首批不等術語表）
- \> `blockingThreshold` → 阻塞等待術語表回來再開始翻譯

**擷取 prompt**：定義在 `lib/storage.js` 的 `DEFAULT_GLOSSARY_PROMPT`，XML 結構，限定四類實體（人名/地名/專業術語/作品名），附排除規則與 JSON 格式範例。上限 `glossary.maxTerms`（預設 200）條。

**其他細節**：

- 輸入壓縮：只送 heading、每段第一句、caption、頁面標題（約原文 20–30%）
- 術語表快取於 `chrome.storage.local`（key `gloss_<sha1>`），版本變更時清空
- 術語表請求走 rate limiter priority 0 插隊
- 逾時 `glossary.timeoutMs`（預設 60000ms），`gemini.js` 內部 fetch 層另有 `fetchTimeoutMs`（預設 55000ms）
- 失敗或逾時 → fallback 成不帶術語表的一般翻譯
- 術語表 temperature 獨立設定（預設 0.1，要穩定不要有創意）
- 預設停用（`glossary.enabled` 預設 `false`），使用者可在設定頁或 Popup 開啟

### 3.7 禁用詞清單

v1.5.6 新增。針對 AI 模型容易漏網的非台灣慣用譯法建立可由使用者編輯的禁用對照表，作為純 prompt 注入機制——遵循硬規則 §7（中文排版偏好交給 system prompt 處理），content 端不做事後 regex replace。

**預設清單**：25 條，定義在 `lib/storage.js` 的 `DEFAULT_FORBIDDEN_TERMS`，涵蓋常見的視頻/軟件/數據/網絡/質量/用戶/默認/創建/實現/運行/發布/屏幕/界面/文檔/操作系統等對映。v1.5.6 同步修正了 v0.83 起 `DEFAULT_SYSTEM_PROMPT` 內錯誤的「進程→線程」對映（兩者都是非台灣譯法：process 在台灣應為「行程」、thread 應為「執行緒」），改在禁用詞清單分開列出兩條正確對映。

**注入位置**：`lib/gemini.js` 的 `buildEffectiveSystemInstruction()` 在所有其他規則（含 `fixedGlossary`）之後、systemInstruction 的最末端，以 `<forbidden_terms_blacklist>` XML tag 包起來注入。文字明確指示模型「即使原文是英文（如 video / software / data），譯文也只能使用右欄」、「優先級高於任何 stylistic 考量」，並交代「若該詞為文章本身討論的主題請使用引號保留原詞」的合理 escape hatch。

**Debug 偵測層**：實作於 `lib/forbidden-terms.js` 的 `detectForbiddenTermLeaks()`。`background.js` 的 `handleTranslate` 在 `translateBatch` 成功 resolve 後、回傳給 content script 之前，逐段掃描譯文是否含有禁用詞，命中時用 `debugLog('warn', 'forbidden-term-leak', ...)` 寫一筆診斷訊息（含 forbidden / replacement / sourceSnippet / translationSnippet），方便使用者從 Debug 分頁追查模型漏網案例。**純記錄、不修改譯文**。

**快取分區**：`lib/cache.js` 的 `hashForbiddenTerms()` 對清單做穩定 hash（先依 `forbidden` 欄位排序再 JSON.stringify 後 SHA-1 取前 12 字元），加進 cache key 後綴 `_b<hash>`。空清單時不附加後綴，向下相容 v1.5.5 之前的快取。完整 cache key 格式見 §9.1。

**設定 UI**：獨立的「禁用詞清單」分頁（位於「術語表」與「YouTube 字幕」之間），三欄表格（禁用詞 / 替換詞 / 備註）+ 「新增一條」/「還原預設清單」/「刪除」按鈕。匯入匯出 schema 已加入 `forbiddenTerms` 欄位，`sanitizeImport()` 會逐筆過濾無 `forbidden` 欄位的髒資料。

### 3.8 自訂 OpenAI-compatible Provider

v1.5.7 新增。除了 Gemini 與 Google Translate 兩條既有引擎，使用者可設定**一組** OpenAI-compatible 端點，接 OpenRouter（含 Anthropic / Gemini / Llama / Qwen / Grok 等百種模型）/ Ollama 本機 / Together / Groq / Fireworks / OpenAI 自家等。`translatePresets` 任一 slot 的 `engine` 設成 `'openai-compat'` 即可由對應快速鍵啟動。

**為什麼選這個介面**：chat.completions 是事實上的 lingua franca；OpenRouter 把 Anthropic / Gemini 原生 API 都已 wrap 成 OpenAI-compatible，使用者要冷門 provider 透過它就能接，不需要 Shinkansen 為每個 provider 寫獨立 adapter。

**Adapter**：`lib/openai-compat.js` 提供與 `lib/gemini.js` 介面對齊的 `translateBatch(texts, settings, glossary, fixedGlossary, forbiddenTerms)`，內部走 `POST <baseUrl>/chat/completions` + Bearer Authorization。`baseUrl` 已含 `/chat/completions` 時不重複附加。回應走 OpenAI 標準的 `choices[0].message.content` + `usage.prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens` 抽取。

**共用模組** `lib/system-instruction.js`（v1.5.7 從 `lib/gemini.js` 抽出）：`DELIMITER` / `packChunks` / `buildEffectiveSystemInstruction` 三個 helper 由 Gemini 與 OpenAI-compat 兩條 adapter 共用，確保「禁用詞清單 + 固定術語表 + 自動 glossary + 多段分隔符 / 段內換行 / 佔位符」等規則只實作一次、未來新規則只改一處。

**systemPrompt 行為**：使用者可在「自訂 Provider」分頁填獨立 `systemPrompt`，作為 `buildEffectiveSystemInstruction` 的 base（不繼承 Gemini 分頁的 `geminiConfig.systemInstruction`）。但 `fixedGlossary` 與 `forbiddenTerms` 仍由共用注入機制處理，自訂 Provider 自動享有兩者 — 改一處（術語表 / 禁用詞清單分頁）兩邊同步生效。

**不走項目**：rate limiter（OpenRouter 等 provider 自己處理配額；既有 `fetchWithRetry` 的 429 退避重試已能應付）。

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

**設定**：`settings.targetLanguage`（合法值 8 個，見 `TARGET_LANGUAGES` 陣列），存 `chrome.storage.sync`，使用者可在 Options「翻譯目標語言」分頁切換。

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

**來源語言偵測 target-aware**（v1.8.59 起 `content-detect.js`）：

- `SK.detectTextLang(text)`：純函式，回傳 `'zh-Hant' | 'zh-Hans' | 'ja' | 'ko' | 'en' | 'other'`
- `SK.isAlreadyInTarget(text, target)`：依 target 判定文字是否已是目標語言（target=`zh-TW` 跳 `zh-Hant`、`zh-CN` 跳 `zh-Hans`、`en` 跳 `en`）
- `SK.isTraditionalChinese(text)`：保留為 zh-TW 專用 alias，等同 `isAlreadyInTarget(text, 'zh-TW')`
- `STATE.targetLanguage`：content.js `translatePage()` 開頭從 storage 注入，預設 `'zh-TW'`（hydrate 前的 fallback 維持 v1.8.58 之前行為）

**YouTube 字幕「已是目標語言」跳過**（v1.8.59 起 `content-youtube.js`）：

`SKIP_LANGS_BY_TARGET` 對照表依 `STATE.targetLanguage` 切集合：

- target=`zh-TW` → 跳 `zh-Hant` / `zh-TW` / `zh-HK` / `zh-MO`
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

**禁用詞清單 UI 與 storage 對齊**（v1.8.60 P2 附帶修補）：之前 options.js 用 `s.forbiddenTerms`（已 spread DEFAULTS）→ 永遠 25 條，UI 跟 storage.js getSettings() 的 target-aware fallback drift。修法改用 `saved.forbiddenTerms`（只看 storage 實際寫入）+ target-aware fallback（zh-TW → DEFAULT、其他 → 空），對齊 §3.9「禁用詞清單依 target 預設」。切 target picker 時透過 `_isForbiddenTermsUnchangedFromDefault()` 判斷是否「視為未客製」，自動切；已客製化保留使用者編輯。

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

**YouTube 字幕**：`content-youtube.js` 維持單語字幕替換路徑，不支援 dual。

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

驗證採寬鬆模式：至少一對佔位符配對即視為成功，殘留標記由 `stripStrayPlaceholderMarkers` 清除。

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
- **ARIA role**：祖先鏈含 `banner` / `contentinfo` / `search` / `grid` 則跳過。HEADER 僅在 `role="banner"` 時排除

**不做內容性 selector 排除**：content.js 不以 class/selector 判斷「該不該翻」。此類判斷交給 Gemini systemInstruction。

### 5.3 選擇器補抓（`INCLUDE_BY_SELECTOR`）

```
#siteSub, #contentSub, #contentSub2, #coordinates,
.hatnote, .mw-redirectedfrom, .dablink, [role="note"], .thumbcaption
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
├── content-ns.js         # 命名空間、共用狀態 STATE、常數、工具函式
├── content-toast.js      # Toast 提示系統（Shadow DOM 隔離）
├── content-detect.js     # 段落偵測（語言偵測、容器排除、collectParagraphs）
├── content-serialize.js  # 佔位符序列化/反序列化（⟦N⟧…⟦/N⟧ 協定）
├── content-inject.js     # DOM 注入（resolveWriteTarget、injectIntoTarget）
├── content-spa.js        # SPA 導航偵測 + Content Guard + MutationObserver
├── content-youtube-main.js  # YouTube XHR 攔截（MAIN world, document_start, v1.2.8）
├── content-youtube.js    # YouTube 字幕翻譯（isolated world, v1.2.11）
├── content.js            # 主協調層（translatePage、Debug API、初始化）
├── content.css
├── background.js         # Service Worker（ES module）
├── lib/
│   ├── gemini.js         # Gemini API 呼叫、分批、重試
│   ├── cache.js          # 翻譯快取（LRU + debounced flush）
│   ├── storage.js        # 設定讀寫、預設值
│   ├── rate-limiter.js   # 三維 Rate Limiter
│   ├── tier-limits.js    # Tier 對照表
│   ├── logger.js         # 結構化 Log 系統
│   ├── usage-db.js       # 用量追蹤（IndexedDB）
│   ├── format.js         # 共用格式化函式（formatBytes/formatTokens/formatUSD）
│   └── vendor/           # 第三方程式庫
├── popup/
│   ├── popup.html
│   ├── popup.js          # ES module
│   └── popup.css
├── options/
│   ├── options.html
│   ├── options.js        # ES module
│   └── options.css
├── _locales/
│   └── zh_TW/
│       └── messages.json # Chrome i18n 繁體中文語系檔
└── icons/
```

---

## 7. 資料流程

1. 使用者按 Option+S 或 Popup「翻譯本頁」
2. `content.js` 的 `collectParagraphs()` 遍歷 DOM 收集翻譯單位
3. `packBatches()` 依字元預算 + 段數上限打包成批次
4. 術語表前置流程（依文章長度決定策略）
5. `runWithConcurrency()` 平行送出批次，每批經 `TRANSLATE_BATCH` 訊息到 background
6. background 的 handler 查快取 → 未命中則走 Rate Limiter → 呼叫 Gemini API
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
  "debugLog": false,
  "tier": "tier1",
  "safetyMargin": 0.1,
  "maxRetries": 3,
  "rpmOverride": null,
  "tpmOverride": null,
  "rpdOverride": null,
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
    "pricing": null
  },
  "forbiddenTerms": "（見 §3.7 / DEFAULT_FORBIDDEN_TERMS，25 條預設）",
  "customProvider": {
    "baseUrl": "https://openrouter.ai/api/v1",
    "model": "openai/gpt-5.4-mini",
    "systemPrompt": "（見 lib/storage.js DEFAULT_SYSTEM_PROMPT）",
    "temperature": 0.7,
    "inputPerMTok": 0.75,
    "outputPerMTok": 4.5,
    "thinkingLevel": "off"
  }
}
```

註：`customProvider.apiKey` **不存** sync，存 `chrome.storage.local`（key `customProviderApiKey`），與主 Gemini `apiKey` 設計一致。

- **API Key** 存 `chrome.storage.local`（key `apiKey`），不跨裝置同步。舊版（≤v0.61）存在 sync 的 Key 會自動遷移至 local
- 快捷鍵由 Chrome 原生 `commands` API 管理，不存設定
- `rpmOverride` / `tpmOverride` / `rpdOverride`：非 null 時覆寫 tier 對照表的對應值
- `maxTranslateUnits`：單頁翻譯段落數上限，超過截斷（0 = 不限制）

### 8.2 `chrome.storage.local`（本地，5MB 上限）

- **翻譯快取**：key `tc_<sha1>` → 譯文字串
- **術語表快取**：key `gloss_<sha1>` → 術語對照 JSON
- **版本標記**：key `__cacheVersion` → manifest version（不一致時清空所有快取）
- **RPD 計數**：key `rateLimit_rpd_<YYYYMMDD>` → 當日請求數

### 8.3 同步策略

- `chrome.storage.sync` 自動跨裝置同步設定（不含 API Key）
- 翻譯快取與術語表快取只存 local，不同步
- 設定頁提供匯出/匯入 JSON（API Key 不含在匯出範圍），匯入時 `sanitizeImport()` 驗證所有欄位

---

## 9. 翻譯快取

### 9.1 Key 設計

`tc_` + SHA-1（原文十六進位）= 43 字元。同一段原文跨頁面共用同一 key。key 只 hash 原文，不含模型/prompt；換模型改 prompt 時以版本自動清空處理。

依呼叫情境額外附加後綴（依固定順序，由 `lib/cache.js` 的 `resolveKeySuffix()` 組合）：

- **base tag**：`'_yt'` = 字幕模式 / `'_gt'` = Google Translate 網頁 / `'_gt_yt'` = Google Translate 字幕 / `'_oc'` = 自訂 OpenAI-compat（v1.5.7）/ `''` = 一般 Gemini 網頁翻譯（含 preset 快速鍵）
- **`_g<hash>`**：有術語表時加（自動擷取 + 使用者固定術語的合併 hash，前 12 字元 SHA-1）
- **`_b<hash>`**（v1.5.6 新增）：使用者啟用禁用詞清單時加（依 `forbidden` 排序後 JSON.stringify 的前 12 字元 SHA-1）。空清單時不附加，向下相容 v1.5.5 之前的快取
- **`_m<model>`**（v1.4.12 起）：把 model 字串納入 key（替換非安全字元為 `_`），避免不同 preset 切換時共用快取
- **`_m<baseUrlHash6>_<safeModel>`**（v1.5.7，自訂 Provider 路徑）：baseUrl SHA-1 前 6 字元 + safe model — 避免不同 provider（OpenRouter vs Together vs 自架 Ollama）的同 model name 共用快取
- **`_lang<targetLang>`**（v1.8.59 新增）：非 zh-TW target 加此 suffix（如 `_langzhcn` / `_langen`），避免不同目標語言撞 cache。zh-TW target **不加**此 suffix，向下相容 v1.8.58 之前的 cache（既有 zh-TW 使用者升級 cache 仍 hit）

完整可能形式範例：`tc_<sha1>_g<g>_b<b>_m<m>_lang<x>`，部分後綴可省略。

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

**Option + S**（macOS）/ **Alt + S**（其他 OS）—— 切換翻譯狀態。

```json
"commands": {
  "toggle-translate": {
    "suggested_key": { "default": "Alt+S", "mac": "Alt+S" },
    "description": "切換目前分頁的翻譯"
  }
}
```

使用者可至 `chrome://extensions/shortcuts` 調整。

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
- **持久化 buffer**（`yt_debug_log`）：`chrome.storage.local` key，最近 100 筆環形，**跨 Service Worker 重啟仍在**。只持久化 `youtube` / `api` / `rate-limit` / `translate` 四類（v1.8.56 起加入 translate，讓翻譯主流程的 main flow start / batch start / batch done / stream firstChunkOrTimeout 等訊號跨 SW 重啟可查），其他類別（`cache` / `spa` / `system` / `glossary`）只在記憶體 buffer
- **「Debug」分頁載入**（v1.8.56 起）：分頁啟動時先呼叫 `GET_PERSISTED_LOGS` 載入持久化那段（SW 重啟前的紀錄），再開始 polling 記憶體 buffer。dedup 用 `timestamp + category + message` 三元 key（SW 重啟後 logSeq 重置會撞號，純 seq 去重會漏）
- **「清除」按鈕**（v1.8.56 起）：同時送 `CLEAR_LOGS` + `CLEAR_PERSISTED_LOGS`，兩層 buffer 都清。原本只清記憶體，persisted 還在 storage.local，下次 SW 重啟分頁載入時舊 log 又冒出來
- **DevTools Console**：設定頁可選啟用同步輸出
- **Debug Bridge**：content.js 透過 CustomEvent 橋接，main world 可用 `shinkansen-debug-request` / `shinkansen-debug-response` 事件讀取 log（支援 `GET_LOGS`、`CLEAR_LOGS`、`GET_PERSISTED_LOGS`、`CLEAR_PERSISTED_LOGS`、`CLEAR_CACHE`、`TRANSLATE`、`RESTORE`、`GET_STATE`、`GET_YT_DEBUG`、`CLEAR_RPD`）

---

## 13. Popup 面板規格

### 13.1 版面

- Header：emoji 🚄 + 名稱「Shinkansen」+ 版本號（動態讀取）
- 主按鈕：「翻譯本頁」/「顯示原文」（依 `GET_STATE` 切換）
- 編輯譯文按鈕（預設 `hidden`，翻譯完成後才顯示；切換 `TOGGLE_EDIT_MODE`）
- 白名單自動翻譯 toggle
- 術語表一致化 toggle
- YouTube 字幕翻譯 toggle（只在 YouTube 影片頁面顯示）
- 快取統計（段數 / 大小）+ 清除快取按鈕
- 累計費用 / token 顯示（透過 `QUERY_USAGE_STATS` 從 IndexedDB 讀取，與用量明細分頁同源）
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
| `TRANSLATE_SUBTITLE_BATCH` | `{ texts, glossary }` | `{ ok, result, usage }` — YouTube 字幕逐條翻譯（人工字幕路徑，Gemini 引擎） |
| `TRANSLATE_SUBTITLE_BATCH_GOOGLE` | `{ texts }` | 一般字幕路徑走 Google Translate（`ytSubtitle.engine='google'`），cache key `_gt_yt` |
| `TRANSLATE_SUBTITLE_BATCH_CUSTOM` | `{ texts }` | 一般字幕路徑走 OpenAI-compat 自訂 Provider（`ytSubtitle.engine='openai-compat'`），cache key `_oc_yt`；`systemPrompt` 取 `ytSubtitle.systemPrompt`（空字串 fallback 主 `customProvider.systemPrompt`） |
| `TRANSLATE_ASR_SUBTITLE_BATCH` | `{ texts: [json], glossary }` | `{ ok, result: [json], usage }` — v1.6.20:ASR 字幕專用（Gemini），texts 是單一 [{s,e,t}] JSON 字串，LLM 自由合句後回 [{s,e,t}] JSON 字串 |
| `TRANSLATE_ASR_SUBTITLE_BATCH_CUSTOM` | `{ texts: [json] }` | ASR 字幕走自訂 Provider（`ytSubtitle.engine='openai-compat'`），cache key `_oc_yt_asr`。**強制** `systemPrompt = DEFAULT_ASR_SUBTITLE_SYSTEM_PROMPT`，**不讀** `ytSubtitle.systemPrompt`（JSON timestamp 模式跟逐條字幕規則不同；跟 Gemini ASR 路徑 `_handleAsrSubtitleBatch` 對齊）。`temperature` 沿用 `ytSubtitle.temperature` |
| `EXTRACT_GLOSSARY` | `{ compressedText, inputHash }` | `{ ok, glossary, usage, fromCache, _diag }` — Gemini 路徑術語表抽取 |
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
| `CLEAR_RPD` | `{ ok, removedKeys }` | 清除 RPD 計數（除錯用） |

> **設定讀寫**：popup 和 options 直接透過 `chrome.storage.sync` / `chrome.storage.local` 存取設定，不經 message handler。

### 14.3 background / popup → content

| type | 用途 |
|------|------|
| `TRANSLATE_PRESET` | v1.4.12：依 `payload.slot`（1/2/3）觸發對應 preset 翻譯；已翻譯時任一 slot 皆 `restorePage`；翻譯中任一 slot 皆 abort |
| `TOGGLE_TRANSLATE` | 舊訊息（popup 按鈕用）；v1.4.12 起映射為 preset slot 1 |
| `GET_STATE` | 查詢翻譯狀態 |
| `TOGGLE_EDIT_MODE` | 切換編輯譯文模式 |
| `MODE_CHANGED` | v1.5.0：popup 切換顯示模式時通知 content script。payload `{ mode: 'single' \| 'dual' }`；已翻譯狀態下顯示 toast 提示需重新翻譯，否則僅靜默接收 |

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

- manifest commands：`translate-preset-1`（Alt+A 預設 Flash）/ `translate-preset-2`（Alt+S 預設 Flash Lite）/ `translate-preset-3`（Alt+D 預設 Google MT）。
- storage schema：`translatePresets: [{ slot, engine, model, label }]`，三組預設值內建於 `lib/storage.js` `DEFAULT_SETTINGS`。
- 統一行為：
  - 閒置狀態按任一 preset 鍵 → 依該 slot 的 `engine` + `model` 啟動翻譯
  - 翻譯中按任一 preset 鍵 → abort
  - 已翻譯完成按任一 preset 鍵 → `restorePage`（不分 slot）
- `modelOverride` 傳輸：content.js `SK.translateUnits` 把 slot 對應的 model 放進 `TRANSLATE_BATCH` payload.modelOverride → background `handleTranslate` 透過 `geminiOverrides.model` 覆蓋 `geminiConfig.model`（與 YouTube 字幕用的同一條機制，用 `cacheTag` 參數區分快取分區避免污染）。
- 未來 Options UI（v1.4.13 規劃）提供 engine/model/label 編輯；v1.4.12 使用者要改 preset 可暫時直接寫 `chrome.storage.sync.translatePresets`。

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

## 17. 文件翻譯（PDF）

> v1.8.45 起 beta 上線。

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

**Reading order**:
- 同欄內按 y 降序（視覺由上往下）
- 跨欄按欄編號升序（左欄全部讀完再右欄）
- 跨頁按頁碼升序
- 例外：`footnote` / `page-number` 永遠排在該頁所有其他 block 之後（reading order 最大）

#### 17.4.4 翻譯與保留策略

| Block type | 處理 |
|------------|------|
| `paragraph` / `heading` / `list-item` / `caption` / `footnote` | **送翻譯**——以 `plainText` 為單位送既有 Gemini batch translation pipeline |
| `formula` / `table` / `figure` / `page-number` | **不送翻譯**——保留原樣；譯文 PDF 該位置直接 render 原文 |

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
- 整批請求失敗：該批內所有 block 標記 failed,**不**整份 retry（per §17.7 設計決策）

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

不送翻譯的 block(`formula` / `table` / `figure` / `page-number`）直接 clone 原文 textRuns 的視覺 render:

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
     - `formula` / `table` / `figure` / `page-number`：從原 page 對應 bbox crop 出來貼進譯文頁
3. PDFDocument.save() → Uint8Array → Blob → `<a download="<原檔名>-shinkansen.pdf">` 觸發下載

#### 17.8.1 中文字型內嵌

pdf-lib 預設字型（Helvetica 等）不支援 CJK，必須內嵌中文字型：

- 採用免費商用授權的開源繁中字型（評估候選：思源黑體 Noto Sans TC、Source Han Sans TC），選一款最終決定後 vendor 進 `shinkansen/translate-doc/fonts/`
- 字型檔以 woff2 / otf 格式打包，啟用 pdf-lib 的 subsetting（只 embed 譯文實際用到的字元），最終 PDF 體積約增加 1-3 MB（視譯文字數）
- 字型授權文字附在 `LICENSE-fonts.md`,Chrome Web Store 描述需標示包含的開源字型授權

> **note**：此處字型 vendor 屬於 §18 例外條款 1（直接 vendor code / 資源，授權要求標示）——必須在 `LICENSE-fonts.md` 標示字型來源 + 授權，不違反硬規則 §18。

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

