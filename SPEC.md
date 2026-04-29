# Shinkansen — 規格文件（SPEC）

> 一款專注於隱私的網頁翻譯 Chrome Extension。

- 文件版本：v1.1
- 建立日期：2026-04-08
- 最後更新：2026-04-25（v1.5.4）
- 目標平台：Chrome（Manifest V3）
- 作業系統：macOS 26
- 目前 Extension 版本：1.8.20

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

### 2.1 已實作（v1.8.20 為止）

詳細版本歷史見 [`CHANGELOG.md`](CHANGELOG.md)。

| 功能區塊 | 狀態 | 簡述 |
|---------|------|------|
| 網頁翻譯 | ✅ | Option+S（Gemini）/ Option+G（Google Translate）切換；單語覆蓋 / 雙語對照雙模式；漸進分批注入；還原原文 |
| 雙語對照模式 | ✅ | v1.5.0 新增；popup toggle 切換；譯文以 `<shinkansen-translation>` wrapper 形式 append 在原段落後/內；4 種視覺標記 |
| YouTube 字幕翻譯 | ✅ | XHR 預翻 + on-the-fly 備援；時間視窗批次；seek/rate 補償；字幕框展開置中；SPA 導航自動重啟；ASR(自動字幕)走獨立合句路徑(v1.6.20) |
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
| Debug 工具 | ✅ | Debug Bridge（CustomEvent）；Log buffer 1000 筆；YouTube `GET_YT_DEBUG` action |
| Google Docs 支援 | ✅ | 偵測編輯頁自動導向 `/mobilebasic` 閱讀版再翻譯 |
| 自動語言偵測 | ✅ | 跳過繁中頁面（可設定關閉）；比例制偵測；日韓文排除 |
| 自動翻譯網站 | ✅ | 網域白名單（支援萬用字元）；`autoTranslate` 總開關 |

### 2.2 規劃中（尚未實作）

| 功能區塊 | 優先度 | 簡述 |
|---------|--------|------|
| EPUB 翻譯 | 中 | 擴充頁面（epub.html）；JSZip 解壓縮 + OPF 解析；重用現有 Gemini 批次翻譯流程；拖曳 EPUB 檔案進頁面後逐章翻譯並顯示 |
| Gemini structured output（治本多段協定 mismatch）| 中 | 改用 Gemini `responseSchema` + `responseMimeType: "application/json"` 強制 JSON 輸出（`[{idx, text}, ...]`），由 API 層保證格式，根本不會 escape 成「«N» + <<<SHINKANSEN_SEP>>> + 合併段落」的 hadMismatch 情境。需重寫 prompt（去掉 SEP / «N» 規則）+ parser（split → JSON.parse）+ streaming SSE 解析（partial JSON parser，比文字 SEP 切分難寫）。涵蓋範圍只限 Gemini engine；OpenAI-compat 各 provider structured output 支援度不一、Claude 與部分本機模型仍要靠 v1.8.10 的 sanitize（A）+ mismatch retry（B）兩層防禦。預估工程 1-2 天。 |

### 2.3 明確不做

滑鼠懸停顯示、原文樣式客製、輸入框翻譯、劃詞翻譯、DeepL / Yandex 等第三方付費翻譯服務、PDF/影片字幕、延遲載入、多國語言介面、淺色/深色主題切換。

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

完整預設 prompt 定義在 `lib/storage.js` 的 `DEFAULT_SYSTEM_PROMPT`（v0.83 升級）。採 XML tag 結構，分四大區塊：

- **`<role_definition>`**：定位為「精通英美流行文化與台灣在地文學的首席翻譯專家」，追求出版級台灣當代語感
- **`<critical_rules>`**：禁止輸出思考過程、忠實保留不雅詞彙（不做道德審查）、專有名詞保留英文原文（地理位置例外，須翻為台灣標準譯名）
- **`<linguistic_guidelines>`**：台灣道地語感（拒絕翻譯腔）、禁用中國大陸用語（v1.5.6 起改指向末端 `<forbidden_terms_blacklist>` 黑名單區塊）、台灣通行譯名、特殊詞彙首次出現加註原文
- **`<formatting_and_typography>`**：全形標點、破折號改寫、中英夾雜半形空格、數字格式（1–99 中文數字、100 以上阿拉伯數字）、年份格式

`lib/system-instruction.js` 的 `buildEffectiveSystemInstruction()`（v1.5.7 從 `lib/gemini.js` 抽出供 OpenAI-compat adapter 共用）會依批次內容動態追加規則。追加順序為：基礎指令 → 多段分隔符（含 `«N»` 序號標記規則） → 段內換行 → 佔位符 → 自動術語對照表 → 使用者固定術語表 → 中國用語黑名單。

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

### 3.7 中國用語黑名單

v1.5.6 新增。針對 LLM 容易漏網的中國大陸用語建立可由使用者編輯的禁用對照表，作為純 prompt 注入機制——遵循硬規則 §7（中文排版偏好交給 system prompt 處理），content 端不做事後 regex replace。

**預設清單**：25 條，定義在 `lib/storage.js` 的 `DEFAULT_FORBIDDEN_TERMS`，涵蓋常見的視頻/軟件/數據/網絡/質量/用戶/默認/創建/實現/運行/發布/屏幕/界面/文檔/操作系統等對映。v1.5.6 同步修正了 v0.83 起 `DEFAULT_SYSTEM_PROMPT` 內錯誤的「進程→線程」對映（兩者都是中國大陸用語：process 在台灣應為「行程」、thread 應為「執行緒」），改在黑名單分開列出兩條正確對映。

**注入位置**：`lib/gemini.js` 的 `buildEffectiveSystemInstruction()` 在所有其他規則（含 `fixedGlossary`）之後、systemInstruction 的最末端，以 `<forbidden_terms_blacklist>` XML tag 包起來注入。文字明確指示 LLM「即使原文是英文（如 video / software / data），譯文也只能使用右欄」、「優先級高於任何 stylistic 考量」，並交代「若該詞為文章本身討論的主題請使用引號保留原詞」的合理 escape hatch。

**Debug 偵測層**：實作於 `lib/forbidden-terms.js` 的 `detectForbiddenTermLeaks()`。`background.js` 的 `handleTranslate` 在 `translateBatch` 成功 resolve 後、回傳給 content script 之前，逐段掃描譯文是否含有黑名單詞，命中時用 `debugLog('warn', 'forbidden-term-leak', ...)` 寫一筆診斷訊息（含 forbidden / replacement / sourceSnippet / translationSnippet），方便使用者從 Debug 分頁追查 LLM 漏網案例。**純記錄、不修改譯文**。

**快取分區**：`lib/cache.js` 的 `hashForbiddenTerms()` 對清單做穩定 hash（先依 `forbidden` 欄位排序再 JSON.stringify 後 SHA-1 取前 12 字元），加進 cache key 後綴 `_b<hash>`。空清單時不附加後綴，向下相容 v1.5.5 之前的快取。完整 cache key 格式見 §9.1。

**設定 UI**：獨立的「禁用詞清單」分頁（位於「術語表」與「YouTube 字幕」之間），三欄表格（禁用詞 / 替換詞 / 備註）+ 「新增一條」/「還原預設清單」/「刪除」按鈕。匯入匯出 schema 已加入 `forbiddenTerms` 欄位，`sanitizeImport()` 會逐筆過濾無 `forbidden` 欄位的髒資料。

### 3.8 自訂 OpenAI-compatible Provider

v1.5.7 新增。除了 Gemini 與 Google Translate 兩條既有引擎，使用者可設定**一組** OpenAI-compatible 端點，接 OpenRouter（含 Anthropic / Gemini / DeepSeek / Llama / Qwen / Grok 等百種模型）/ Ollama 本機 / Together / Groq / Fireworks / OpenAI 自家 / DeepSeek 直連等。`translatePresets` 任一 slot 的 `engine` 設成 `'openai-compat'` 即可由對應快速鍵啟動。

**為什麼選這個介面**：chat.completions 是事實上的 lingua franca；OpenRouter 把 Anthropic / Gemini 原生 API 都已 wrap 成 OpenAI-compatible，使用者要冷門 provider 透過它就能接，不需要 Shinkansen 為每個 provider 寫獨立 adapter。

**Adapter**：`lib/openai-compat.js` 提供與 `lib/gemini.js` 介面對齊的 `translateBatch(texts, settings, glossary, fixedGlossary, forbiddenTerms)`，內部走 `POST <baseUrl>/chat/completions` + Bearer Authorization。`baseUrl` 已含 `/chat/completions` 時不重複附加。回應走 OpenAI 標準的 `choices[0].message.content` + `usage.prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens` 抽取。

**共用模組** `lib/system-instruction.js`（v1.5.7 從 `lib/gemini.js` 抽出）：`DELIMITER` / `packChunks` / `buildEffectiveSystemInstruction` 三個 helper 由 Gemini 與 OpenAI-compat 兩條 adapter 共用，確保「黑名單 + 固定術語表 + 自動 glossary + 多段分隔符 / 段內換行 / 佔位符」等規則只實作一次、未來新規則只改一處。

**systemPrompt 行為**：使用者可在「自訂 Provider」分頁填獨立 `systemPrompt`，作為 `buildEffectiveSystemInstruction` 的 base（不繼承 Gemini 分頁的 `geminiConfig.systemInstruction`）。但 `fixedGlossary` 與 `forbiddenTerms` 仍由共用注入機制處理，自訂 Provider 自動享有兩者 — 改一處（術語表 / 禁用詞清單分頁）兩邊同步生效。

**不走項目**：rate limiter（OpenRouter 等 provider 自己處理配額；既有 `fetchWithRetry` 的 429 退避重試已能應付）、自動術語表 implicit cache 折扣（OpenAI cache 命中折扣率不一定與 Gemini 一致，但本實作仍用 25% billed 計算作為近似）。

**計價**：使用者自填 `customProvider.inputPerMTok` 與 `customProvider.outputPerMTok`（USD / 1M tokens），填 0 = 不顯示費用（token 數仍會記錄）。OpenRouter / Together 等百種模型不可能內建查表。

**Cache key**：base tag `_oc` + glossary hash（若有）+ forbidden hash（若有）+ `_m<baseUrlHash6>_<safeModel>`。`baseUrlHash6` 是 `baseUrl` SHA-1 前 6 字元，避免不同 provider 同 model name 共用快取（例如 OpenRouter 的 `gpt-4` vs 自架 Ollama 的 `gpt-4`）。

**API Key 儲存**：`customProvider.apiKey` 存 `chrome.storage.local`（key `customProviderApiKey`），不跨裝置同步、不在匯出 JSON 範圍內。設計理由與主 Gemini API Key 一致。

**Message protocol**：content → background 送 `TRANSLATE_BATCH_CUSTOM` 訊息（與 `TRANSLATE_BATCH` / `TRANSLATE_BATCH_GOOGLE` 對稱），由 `handleTranslateCustom` 處理。

**設定 UI**：獨立的「自訂 Provider」分頁（位於「術語表」與「禁用詞清單」之間）。preset 引擎下拉新增第三個選項 `「自訂 Provider（OpenAI-compatible）」`；選此引擎時 preset card 隱藏 model 下拉（model 由「自訂 Provider」分頁的設定決定，不靠 preset 欄位）。

**未來擴充空間**：當前設計「一組」自訂 provider；若未來需要「多組 named provider 讓 preset 各綁不同組」，可把 `customProvider` 改為 `customProviders: { [name]: {...} }` Map 結構，preset 加 `customProviderName` 欄位指定。

---

## 4. 翻譯顯示規格

### 4.1 顯示模式

兩種模式並存，由 `displayMode` 設定切換（popup toggle 即時切換、寫入 `chrome.storage.sync`）：

- **`single`（預設，單語覆蓋）**：將原文段落的文字節點替換成譯文，元素本身保留不動。所有 v1.4 之前的 injection 行為（媒體保留、`resolveWriteTarget` MJML 救援等）都走此路徑。
- **`dual`（雙語對照，v1.5.0 新增）**：原文保留，譯文以 `<shinkansen-translation>` wrapper 形式 append 在原段落之後/內。原段落 `textContent` / `innerHTML` 完全不動。

**雙語對照規格**（`shinkansen/content-inject.js` 的 `SK.injectDual`）：

| 原元素類型 | wrapper 位置 | wrapper 內部 tag |
|----------|-------------|----------------|
| 一般 block (`<p>` / `<div>` / `<blockquote>` / `<pre>` 等) | `original.insertAdjacentElement('afterend', wrapper)` | 同原 tag |
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
    "baseUrl": "",
    "model": "",
    "systemPrompt": "",
    "temperature": 0.7,
    "inputPerMTok": 0,
    "outputPerMTok": 0
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
- **`_b<hash>`**（v1.5.6 新增）：使用者啟用中國用語黑名單時加（依 `forbidden` 排序後 JSON.stringify 的前 12 字元 SHA-1）。空清單時不附加，向下相容 v1.5.5 之前的快取
- **`_m<model>`**（v1.4.12 起）：把 model 字串納入 key（替換非安全字元為 `_`），避免不同 preset 切換時共用快取
- **`_m<baseUrlHash6>_<safeModel>`**（v1.5.7，自訂 Provider 路徑）：baseUrl SHA-1 前 6 字元 + safe model — 避免不同 provider（OpenRouter vs Together vs 自架 Ollama）的同 model name 共用快取

完整可能形式範例：`tc_<sha1>_g<g>_b<b>_m<m>`，部分後綴可省略。

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

成功 Toast 的 detail 兩行：token 數 + implicit cache hit%、實付費用 + 節省%。費用套用 Gemini implicit context cache 折扣（cached tokens ×0.25 計費）。

### 11.3 設計原則

- 不用轉圈 spinner，用橫向進度條 + 計時器
- 不用左邊色條 border-left
- 成功提示預設 5 秒後自動消失（`toastAutoHide` 設定控制；關閉時需手動點 × 或點擊外部區域）
- 延遲 rescan 補抓在 UI 層完全隱形

---

## 12. LLM 除錯 Log

`lib/logger.js` 提供結構化 Log，記錄 API 呼叫的時間、模型、參數、耗時、token、錯誤等。

- **記憶體 buffer**：最近 1000 筆，設定頁「Debug」分頁可瀏覽（分類/等級篩選、搜尋、匯出 JSON）
- **DevTools Console**：設定頁可選啟用同步輸出
- **Debug Bridge**：content.js 透過 CustomEvent 橋接，main world 可用 `shinkansen-debug-request` / `shinkansen-debug-response` 事件讀取 log（支援 `GET_LOGS`、`CLEAR_LOGS`、`CLEAR_CACHE`、`TRANSLATE`、`RESTORE`、`GET_STATE`）

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
- 累計費用 / token 顯示（透過 `USAGE_STATS` 訊息讀取；重置功能在 options 頁面）
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
| `TRANSLATE_SUBTITLE_BATCH` | `{ texts, glossary }` | `{ ok, result, usage }` — YouTube 字幕逐條翻譯(人工字幕路徑) |
| `TRANSLATE_ASR_SUBTITLE_BATCH` | `{ texts: [json], glossary }` | `{ ok, result: [json], usage }` — v1.6.20:ASR 字幕專用,texts 是單一 [{s,e,t}] JSON 字串,LLM 自由合句後回 [{s,e,t}] JSON 字串 |
| `EXTRACT_GLOSSARY` | `{ input }` | `{ ok, terms, _diag }` |
| `LOG` | `{ level, category, message, data }` | — |
| `LOG_USAGE` | `{ inputTokens, outputTokens, … }` | `{ ok }` |
| `SET_BADGE_TRANSLATED` | — | `{ ok }` |
| `CLEAR_BADGE` | — | `{ ok }` |
| `STICKY_QUERY` | — | `{ ok, shouldTranslate, slot }` — 查當前 tab 是否在跨 tab sticky set，回傳 preset slot（v1.4.12 從 engine 改存 slot） |
| `STICKY_SET` | `{ slot: number }` | `{ ok }` — 翻譯成功後將當前 tab 加入 sticky set 記錄 slot（v1.4.12） |
| `STICKY_CLEAR` | — | `{ ok }` — 還原原文時將當前 tab 從 sticky set 移除（v1.4.11） |

### 14.2 popup / options → background

| type | 回應 | 用途 |
|------|------|------|
| `CACHE_STATS` | `{ ok, count, bytes }` | 快取統計 |
| `CLEAR_CACHE` | `{ ok, removed }` | 清空翻譯快取 |
| `USAGE_STATS` | `{ ok, totalInputTokens, totalOutputTokens, totalCostUSD, since }` | Popup 累計費用/token 顯示 |
| `RESET_USAGE` | `{ ok, totalInputTokens, totalOutputTokens, totalCostUSD, since }` | Popup 重置累計統計 |
| `QUERY_USAGE_STATS` | `{ ok, stats }` | Options 用量彙總卡片 |
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
- 費用計算套用 Gemini implicit cache 折扣後的實付值
