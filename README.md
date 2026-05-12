[English](README.en.md) | **繁體中文**

# Shinkansen 🚄

快速、私密的網頁、YouTube 字幕翻譯擴充功能，支援 8 種目標語言與多種 AI 引擎（Google Gemini、Google Translate、OpenAI 相容自訂模型），原地替換網頁文字保留原始排版，瀏覽資料不經過第三方伺服器。

名稱「新幹線」象徵快速、平穩、流暢的閱讀體驗。

> [從 Chrome Web Store 安裝](https://chromewebstore.google.com/detail/shinkansen/pnhmlecoofeoofajcjenndnimhbodhlg) · [從 Firefox Add-ons 安裝](https://addons.mozilla.org/firefox/addon/shinkansen/) · [下載最新版本 zip](https://github.com/jimmysu0309/shinkansen/releases/latest) · 安裝教學與產品介紹見 [官方網頁](https://jimmysu0309.github.io/shinkansen/) · [更新紀錄](https://jimmysu0309.github.io/shinkansen/release-notes.html)

## 近期重大更新

- 新增**多語言支援**，可翻譯成 8 種語言（繁體中文 / 簡體中文 / 英文 / 日文 / 韓文 / 西班牙文 / 法文 / 德文）；擴充功能介面也支援 8 語
- 新增**極速秒翻**，按下翻譯 1 秒看到頁面開始變中文（限 Gemini）
- 新增**雙語對照模式**，原文 + 譯文並列顯示
- 新增**自訂 AI 模型**，可接 OpenRouter / Claude / Ollama 本機等所有模型
- 新增**字幕 AI 分句**，YouTube 自動產生字幕經 AI 重新分句，中文字幕更自然好讀
- 新增**禁用詞清單**，明確要求 AI 模型不要使用視頻 / 軟件 / 數據等不希望出現在譯文中的詞
- 新增**只翻文章開頭**選項，先翻前幾段預覽，大幅節省 token

## 為什麼做這個專案

既有的網頁翻譯工具大多需要將個人瀏覽內容傳送到第三方伺服器處理，隱私權難以掌控。Shinkansen 的設計從一開始就以隱私為核心：所有設定與資料都只存在你自己的電腦上；除了你自備的 Gemini API Key 直接連線 Google 之外，不會將任何資料外傳給其他第三方；原始碼完全公開，任何人都可以檢視它的安全性。

## 效能實測

我們拿英文維基百科的 Taiwan 條目（超過一千段文字）做壓力測試：記憶體不增反減（中文比英文精簡）、翻譯過程中網頁不會變卡（95% 以上的時間在等 API 回應，電腦幾乎不做額外運算）、翻完後頁面結構維持乾淨不留痕跡。用最便宜的模型翻完整頁，API 費用不到 0.08 美元（約台幣 2.5 元），翻過的內容自動快取，下次再開不用重新花錢。完整測試數據見 [PERFORMANCE.md](docs/PERFORMANCE.md)。

## 功能特色

- **多語翻譯目標 + 多語介面**：可選翻譯成 8 種語言（繁體中文 / 簡體中文 / 英文 / 日文 / 韓文 / 西班牙文 / 法文 / 德文）。設定頁「翻譯目標語言」分頁切換，所有翻譯模式（網頁 / PDF / YouTube 字幕）共用此設定；工具列圖示 / 設定頁 / 網頁翻譯進度通知 / PDF 文件翻譯 reader 同樣支援 8 語介面，可獨立設定或跟著瀏覽器語言推導
- **極速秒翻**：按下翻譯 1 秒看到頁面開始變中文，不用等整批 API 回完再一次塞回頁面（限 Gemini）
- **保留網頁排版**：原地替換網頁文字，保留字型、字級、顏色與排版，連結仍可點擊、粗體斜體原樣保留
- **單語覆蓋 / 雙語對照雙模式**：工具列圖示一鍵切換顯示模式——「單語覆蓋」原地替換、「雙語對照」原文保留 + 譯文以新段落 append。雙語模式提供 4 種視覺標記（淡底色 / 左邊細條 / 虛線底線 / 無）讓你選擇譯文段落的呈現風格
- **三翻譯引擎**：Gemini（AI 翻譯、品質最佳、需 API Key）+ Google Translate（非官方免費端點、不需 API Key、速度更快）+ 自訂模型，依場景自由切換
- **自訂 AI 模型**：OpenAI 相容端點，可接 OpenRouter / Together / Groq / Ollama 本機等百種模型
- **三組可自訂快速鍵**：`Alt+A` / `Alt+S` / `Alt+D` 各自綁一組翻譯預設（引擎 + 模型 + 標籤），依網頁內容重要性一鍵選擇不同引擎（例如閱讀材料用 Flash、隨手瀏覽用 Google MT）。詳見下方「翻譯快速鍵與預設」段落
- **YouTube 字幕即時翻譯**：自動偵測 YouTube 字幕，即時替換為繁體中文，字幕樣式與原生 YouTube 字幕一致。詳見下方「YouTube 字幕翻譯」段落
- **字幕雙語對照**：工具列圖示一鍵切換，字幕同時顯示英文 + 中文兩行（英文在上、中文在下），適合練聽力或對照原文。YouTube 與 Google Drive 影片共用同一個設定。詳見下方「字幕雙語對照」段落
- **YouTube AI 分句**（自動產生字幕專用）：YouTube 自動產生字幕（ASR）原本是一個個破碎的詞，經 AI 重新依語意分句後翻譯，中文字幕從「破碎的詞」變「完整句子」，閱讀體驗大幅提升。詳見下方「AI 智慧分句」段落
- **固定術語表**：自訂翻譯對照表，指定特定詞彙一律翻成你要的譯名。支援全域與網域專屬兩層，網域規則覆蓋全域同名詞條。詳見下方「固定術語表」段落
- **禁用詞清單**：可由你編輯的禁用詞對照表（預設 25 條，例如視頻 / 軟件 / 數據 / 網絡 / 質量 / 用戶），會以高顯著性區塊注入到 system prompt 末端，明確要求譯文不可使用左欄詞彙。詳見下方「禁用詞清單」段落
- **只翻文章開頭**：先翻前幾段預覽再決定是否讀完整篇，大幅節省 token。詳見下方「只翻文章開頭」段落
- **全文術語表一致化**（預設不開啟）：特別適合人名眾多的長文，自動確保同一個人名或專有名詞前後翻譯一致。詳見下方「術語表一致化」段落
- **翻譯快取與即時節費報告**：雙層快取機制（本地快取 + Gemini implicit cache），翻譯完成後提示訊息即時顯示 cache hit rate 與實際節省費用。詳見下方「翻譯快取與費用計算」段落
- **API 配額管理**：Shinkansen 在背景幫你管理 Gemini API 用量，避免大頁面翻譯被 Google 中途擋下，也會在快超過每日配額時提早警告，不會等到失敗才知道。多數情況選對 Tier 即可，其他不用設定
- **用量追蹤**：記錄每次翻譯的 token 數與費用，附圖表與 CSV 匯出
- **編輯譯文**：翻譯完成後可直接在頁面上修改譯文，適合要列印 PDF 或讓 Readwise Reader 抓取時，手動修正翻得不理想的地方
- **跨 tab 延續翻譯**：在 tab A 按快速鍵翻譯後，從 A 點連結開新 tab B（含按住 Cmd（Mac）/ Ctrl（Windows）點連結 / `target="_blank"` / `window.open`），B 自動翻譯並繼承同一組 preset；新 tab 再開新 tab 也繼續
- **自動翻譯指定網站**：在設定頁加入常看的網域，開啟該網站時自動翻譯，不用每次手動按快速鍵（翻譯通知會標示 `[自動翻譯]` 讓你知道是 whitelist 觸發）
- **還原原文**：按同一組快速鍵即切換回原文，隨時對照
- **Google Docs 翻譯**：自動偵測 Google Docs，開啟可翻譯的閱讀版並翻譯（詳見下方說明）

## 安裝方式

**Chrome / Edge / Brave 等 Chromium 瀏覽器**

前往 [Chrome Web Store 安裝頁面](https://chromewebstore.google.com/detail/shinkansen/pnhmlecoofeoofajcjenndnimhbodhlg) 點「加到 Chrome」即可。

**Firefox**

前往 [Firefox Add-ons 安裝頁面](https://addons.mozilla.org/firefox/addon/shinkansen/) 點「Add to Firefox」即可。

> ⚠ **Firefox 使用者注意：預設快捷鍵 `Alt+S` / `Alt+A` / `Alt+D` 會被瀏覽器或其他擴充功能攔截**（Firefox 把 `Alt+S` 用於開啟「歷史」選單、`Alt+D` 用於切換地址列焦點；`Alt+A` 常被 Save Page WE 等擴充功能搶走）。Chrome 沒有此衝突，但 Firefox 環境下三組預設快捷鍵可能完全無法觸發翻譯。請到 `about:addons` → 設定圖示（齒輪）→「管理擴充功能快捷鍵」，把 Shinkansen 的三個快速鍵改成不衝突的組合（例如 `Ctrl+Shift+S`）。設定頁的「翻譯快速鍵」section 也會在 Firefox 環境自動顯示這個提示

**開發版（載入未封裝）**

1. 開啟 Chrome，網址列輸入 `chrome://extensions/` 並按 Enter
2. 右上角打開「開發人員模式」
3. 點「載入未封裝項目」（Load unpacked）
4. 選擇本專案的 `shinkansen/` 資料夾
5. 擴充功能清單會出現 Shinkansen，可以固定到工具列

## 首次設定

1. 申請 Gemini API Key — 詳細步驟見 [API Key 申請教學](docs/API-KEY-SETUP.md)
2. 點工具列的 Shinkansen 圖示 → 「設定」
3. 貼上你的 Gemini API Key
4. 預設模型 `gemini-3-flash-preview`、Service Tier `DEFAULT`
5. 其餘參數可依需求調整（溫度、每批段數、字元預算等）

## 使用方式

- **手動翻譯**：點工具列圖示 → 「翻譯本頁」
- **翻譯快速鍵**（三組）：
    - `Option+A`（macOS）/ `Alt+A` — 預設 Gemini Flash Lite（便宜）
    - `Option+S` / `Alt+S` — 預設 Gemini Flash（品質高，推薦日常用）
    - `Option+D` / `Alt+D` — 預設 Google Translate（免費、不需 API Key）
    - 三組鍵位、引擎、模型、標籤都可在設定頁「翻譯快速鍵」區塊自訂
    - 已翻譯狀態下按任一快速鍵 → 還原原文
    - 翻譯中按任一快速鍵 → 取消翻譯
- **YouTube 字幕翻譯**：開啟有英文字幕的影片，確認 CC 已開啟，點工具列圖示 → 打開「YouTube 字幕翻譯」開關
- **自動翻譯指定網站**：在設定頁的「自動翻譯網站」名單加入網域，進入該網站自動翻譯（翻譯通知會顯示 `[自動翻譯]` 前綴）
- **固定術語表**：在設定頁的「術語表」Tab 新增對照詞條，翻譯時會強制使用你指定的譯名
- **術語表一致化**：在工具列圖示或設定頁開啟「術語表一致化」，長文翻譯會先建立專有名詞對照表
- **編輯譯文**：翻譯完成後，在工具列圖示點「編輯譯文」可直接修改頁面上的譯文

## 翻譯快速鍵與預設

Shinkansen 提供三組可自訂的翻譯預設，各綁一個快速鍵：

| 快速鍵 | 預設引擎 | 預設模型 | 適合場景 |
|--------|----------|----------|----------|
| `Alt+A` / `Option+A` | Gemini | Flash Lite（$0.10 / $0.30） | 隨手翻譯，要最省 |
| `Alt+S` / `Option+S` | Gemini | Flash（$0.50 / $3.00） | 日常閱讀，品質最佳性價比 |
| `Alt+D` / `Option+D` | Google Translate | — | 不需 API Key、速度快、完全免費 |

**可以在設定頁「翻譯快速鍵」區塊自訂**：每組 preset 的引擎（Gemini / Google Translate）、模型（Flash Lite / Flash / Pro / 自訂）、顯示標籤都可以改。鍵位本身則在 `chrome://extensions/shortcuts` 設定。

**統一的取消/還原行為**：
- 翻譯中按任一快速鍵 → 立即取消翻譯
- 已翻譯狀態下按任一快速鍵 → 還原原文（不分用哪個 preset 翻的）

**跨 tab 延續翻譯**：在 tab A 按快速鍵翻譯後，從 A 點連結開新 tab B（按住 Cmd（Mac）/ Ctrl（Windows）點連結、`target="_blank"` 或 `window.open`），B 會自動翻譯且繼承同一組 preset——讓使用者可以一路按連結讀下去不用每個 tab 都按快速鍵。新 tab 再開新 tab 也繼續；手動打網址 / 從 bookmark 開 / 從外部 app 開的 tab 不繼承（openerTabId 為空）。按任一組快速鍵還原只影響當前 tab，不影響樹中其他 tab。

## Google Translate 翻譯引擎

Shinkansen 支援 Google Translate 作為第二翻譯引擎：

- **不需要 API Key**：使用 Google 公開的非官方 web 端點（與 `translate.google.com` 同源），完全免費
- **速度較快**：機器翻譯回應時間通常比 LLM 短
- **品質折衷**：語法流暢度、語感比 Gemini 略遜，但對純技術性內容（新聞、規格文件）足夠
- **保留連結與格式**：`<a>`、`<b>`、`<small>` 等語意標籤用特殊標記保護，翻譯後結構完整還原（不會把整頁 `<span>` 打爛）
- **費用為零、用量不計入 Gemini 配額**：但非官方端點無 SLA 保證，Google 若改動可能需要跟進修正

適合場景：大量瀏覽英文論壇、新聞、商品頁等「讀懂意思就好」的內容，用 Google MT 省 API 費用；需要精準翻譯（文學、學術文章、專有名詞處理）時切 Gemini。

## Google Docs 翻譯

Google Docs 的編輯畫面使用 Canvas 渲染文字，一般的網頁翻譯擴充功能無法存取其內容。Shinkansen 會自動偵測 Google Docs 頁面，並採用以下流程：

1. 在 Google Docs 編輯頁面按下 `Option + S`（或點工具列圖示的「翻譯本頁」）
2. Shinkansen 會自動在新分頁開啟同一份文件的「行動版閱讀模式」（mobilebasic）
3. 新分頁載入完成後自動開始翻譯，不需再按一次

注意事項：你必須有該文件的檢視權限。「行動版閱讀模式」是純閱讀，不會影響原始文件。

## YouTube 字幕翻譯

開啟有英文字幕的 YouTube 影片，確認 CC 已開啟，點工具列的 Shinkansen 圖示，會出現「YouTube 字幕翻譯」開關，打開即可。字幕會在不影響影片播放的情況下逐段替換成繁體中文，樣式與 YouTube 原生字幕完全一致。

若你常看 YouTube 英文影片，可在設定頁的「YouTube 字幕」Tab 開啟自動翻譯，進入影片頁面後字幕翻譯會自動啟動，不需每次手動開關。

### AI 智慧分句（自動產生字幕專用）

YouTube 自動產生字幕（沒有人工字幕的影片，CC 標記為 auto-generated）原本是「**按時間切割**」而非「按句子切割」——每條字幕只有 1-3 個英文字、沒有標點，逐條翻譯完全失去語意上下文，譯文會像被剁碎一樣難讀。

Shinkansen 對自動產生字幕導入專用流程：

- **分句改用 AI 重組**：把整批 ASR 片段送 Gemini，由 AI 依語意重新分句（合併短條成完整句子、補上標點），再翻譯。中文字幕從「破碎的詞」變成「完整的句子」。
- **預設「混合模式」**：先用本地啟發式快速分句顯示（秒出，使用者不必等），背景同時跑 AI 分句，回來後用更精緻版本替換——兼顧速度與品質。
- **字幕顯示 overlay 整句穩定**：自家 overlay 完全旁路 YouTube 原生 caption-segment（避免「一個字一個字跳出來」），整句進整句出。控制列出現時自動上移避開進度條。
- **可關閉**：如果只想要最低延遲、用 YouTube 原始分句邏輯翻，到設定頁「YouTube 字幕 → AI 分句模式」取消勾選即可。

人工上傳字幕（professional / community-contributed）不受此設定影響，沿用原來的逐句翻譯路徑。

### 字幕雙語對照

點工具列 Shinkansen 圖示，「字幕雙語對照」開關打開後，字幕會同時顯示原文與譯文兩行（英文在上、中文在下），關閉則只顯示中文（預設）。

適合場景：
- **練聽力**：聽不清楚單字時，對著原文看一眼即可
- **對照確認**：翻譯品質有疑慮時，直接看英文不必切回原文模式
- **學語言**：把字幕當作雙語對照教材

實作要點：
- **YouTube 與 Google Drive 影片共用同一個設定**（打開後兩邊都會切到雙語）
- **即時切換**：播放中切換不需重新載入，當下生效
- **AI 分句模式相容**：雙語對照在 AI 分句的整句字幕上一樣有效，英文整句 + 中文整句兩行

### 費用

字幕翻譯與網頁翻譯共用同一套計費邏輯與用量追蹤。翻過的字幕自動快取，重播或拖回已翻段落完全不花錢。AI 分句模式 token 用量略高於關閉時（多送一次語意分句的 prompt），但對中文閱讀體驗的提升明顯，建議開啟。

### 注意事項

- 需要影片有英文字幕（手動上傳或自動產生皆可）
- 字幕翻譯使用獨立的 system prompt，可在設定頁「YouTube 字幕」Tab 自訂
- 若 CC 未開啟，Shinkansen 會自動幫你開啟（每個影片 session 只主動開一次，尊重使用者後續手動關 CC）
- 換影片後需重新開啟開關（或開啟自動翻譯）

## 翻譯快取與費用計算

Shinkansen 有兩層快取機制，各自在不同階段省錢：

**第一層：本地翻譯快取**——翻譯過的段落以 SHA-1 雜湊為 key 存在瀏覽器的 `chrome.storage.local` 裡。下次遇到相同原文（即使在不同網頁）直接取用，完全不呼叫 API、不花錢。Extension 版本更新時會自動清空快取，確保新版翻譯邏輯不會吃到舊結果。快取滿了會自動淘汰最久沒用的條目（LRU）。

**第二層：Gemini implicit context cache**——Google 伺服器端自動做的，當連續請求的 prompt 前綴相同（例如 system prompt + 術語表）時，Gemini 會快取這段前綴，命中的 token 只收正常價格的 25%。這不需要使用者設定，Shinkansen 會自動從 API 回應中讀取命中數據。

**翻譯完成後，頁面右下角的通知會即時顯示兩行數據：**

- 第一行：`{計費 tokens} tokens (XX% hit)` — 計費 token 數，以及 Gemini implicit cache 的命中率（命中的 input tokens 佔全部 input tokens 的比例）
- 第二行：`${計費金額} (XX% saved)` — 實付金額，以及相比沒有 cache 折扣時省了多少百分比

如果整頁所有段落都在本地快取命中（例如重新翻譯剛翻過的頁面），提示訊息會直接顯示「全部快取命中 · 本次未計費」。

過去每筆翻譯的 token 用量、費用與 cache hit rate 都會留存紀錄，可在設定頁的「用量紀錄」Tab 回查。

## 固定術語表

你可以在設定頁的「術語表」Tab 自訂翻譯對照表，指定特定原文詞彙一律翻成你要的譯名。例如把 "Arrow" 固定翻成「艾蘿」而不是「箭頭」，或把 "Arrow" 在 DC Comics 相關網站上翻成「乙太翠雀之箭」。

術語表分兩層：「全域」適用於所有網站，「網域專屬」只在指定網域生效。當全域和網域有相同原文詞條時，網域規則覆蓋全域。

固定術語表的優先級高於自動術語表一致化。翻譯時，固定術語表的指令會放在 system prompt 的最末端，LLM 會給予最高權重。修改術語表後不需要手動清快取，Shinkansen 會自動讓舊快取失效。

## 自訂模型（OpenAI 相容端點）

除了 Gemini 與 Google Translate 兩條既有引擎，你還可以接一組 OpenAI 相容端點，使用 Gemini 之外的模型——例如：

- **OpenRouter**（`https://openrouter.ai/api/v1`）：一個端點接百種模型，含 Anthropic / Gemini / Llama / Qwen / Grok / xAI / Mistral 等
- **Together / Groq / Fireworks** 等模型供應商
- **Ollama 本機**（`http://localhost:11434/v1`）：跑你自己的開源模型，零成本零延遲
- **OpenAI 自家**（`https://api.openai.com/v1`）

### 設定步驟

1. 到設定頁的「自訂模型」分頁
2. 填三個必填欄位：
   - **Base URL**：例如 `https://openrouter.ai/api/v1`（系統會自動接 `/chat/completions`）
   - **模型 ID**：例如 `anthropic/claude-sonnet-4-5`（OpenRouter 的格式為 `provider/model`）
   - **API Key**：對應 provider 的 Bearer token，按右側「測試」按鈕可立即驗證連線（耗 ~1 token）
3. 選填：翻譯 Prompt（留空 = 用內建簡短預設，預設值與 Gemini 相同）/ Temperature / 模型計價 input / output 單價（USD / 1M tokens；填 0 = 不顯示費用）
4. 儲存
5. 到「一般設定」分頁的「翻譯快速鍵」，把任一組預設引擎改為「自訂模型」
6. 對該 preset 的快速鍵翻譯時就會走自訂模型端點

### 設計重點

- **翻譯 Prompt 獨立**：自訂模型用獨立的翻譯 prompt，不繼承 Gemini 分頁的設定
- **禁用詞清單與固定術語表共用**：兩個分頁的設定會自動注入到 prompt 末端，自訂模型也享有，改一處兩邊同步生效
- **快取分區**：cache key 自帶 base URL hash，不同端點的同 model name 不會互相污染
- **API Key 不上雲**：`customProvider.apiKey` 只存在你的瀏覽器本機，不跨裝置同步、也不在匯出 JSON 範圍內
- **不走 rate limiter**：OpenRouter 等 provider 自己處理配額；429 退避重試已內建
- **強化段序號標記**（預設開啟）：本機量化模型（如 gemma-4 量化版）會把預設的緊湊段序號「«1» «2»」當自然語言誤譯為「N1、N2」洩漏到譯文。開啟後改用 `<<<SHINKANSEN_SEG-N>>>` 格式弱模型不會誤翻；代價是每段批次多約 7 tokens。商用 API（OpenRouter / Groq 等）通常用不到此選項，但開啟也無害

### 限制

- 目前只能設定**一組**自訂模型
- 必須是真正 OpenAI 相容（`POST /chat/completions` + `Bearer` Authorization + 標準 `messages` 結構 + `usage.prompt_tokens` / `completion_tokens` 欄位）。Anthropic 與 Gemini 的**原生** API 不能直接接，但透過 OpenRouter 中轉就可以
- 計價必須自填，token 估算依賴 provider 在 response 的 `usage` 物件正確回傳

### Firefox 連本機 server 注意事項

Firefox 的「**HTTPS-Only Mode**」（`about:preferences#privacy` 滑到底）若開啟，會把 extension 發出的 `http://` 請求**強制升級成 `https://`**，導致連 `http://localhost:11434/v1`（Ollama）、`http://192.168.x.x:8081/v1`（llama.cpp 本機 server）等 HTTP 端點直接失敗。Chrome 沒類似機制，是 Firefox 獨有問題。

**解法**：到 `about:preferences#privacy` → HTTPS-Only Mode 改成「Don't enable」，或對該網址加入例外。設定頁的 Base URL 欄位若填了 `http://`，Shinkansen 會自動偵測 Firefox 並顯示提示。

## 禁用詞清單

AI 模型翻成繁中時雖然會盡量用台灣慣用語，但偶爾還是會吐出「視頻」、「軟件」、「數據」、「網絡」、「用戶」這類非台灣慣用譯法——尤其原文是英文（video / software / data / user）時模型容易直接套用最常見的中譯。為此 Shinkansen 內建一份禁用詞對照表，明確告訴模型左欄絕對不能用、必須改用右欄。

預設清單共 25 條，涵蓋常見的雷區：視頻→影片、音頻→音訊、軟件→軟體、硬件→硬體、程序→程式、進程→行程（process）、線程→執行緒（thread）、數據→資料、數據庫→資料庫、網絡→網路、信息→資訊、質量→品質、用戶→使用者、默認→預設、創建→建立、實現→實作、運行→執行、發布→發表、屏幕→螢幕、界面→介面、文檔→文件、操作系統→作業系統，另含「劍指→針對」、「痛點→要害」、「硬傷→罩門」這類風格詞。

你可以在設定頁的「禁用詞清單」Tab 編輯這份清單——新增、修改、刪除自己常踩到的詞，或按「還原預設清單」回到預設 25 條。每條有三欄：禁用詞、替換詞、備註（備註可空）。

此外，每次翻譯回應後 Shinkansen 會掃描譯文，若仍有禁用詞漏進譯文，會在 Debug 分頁記一筆 `forbidden-term-leak` warning（含原文片段與譯文片段），讓你能追查模型漏網案例——但**不會**自動改寫譯文，遵循「中文排版偏好交給 prompt 處理、不做事後 regex replace」的設計原則，避免誤傷譯文中合法的引述場景。

## 只翻文章開頭

對 token 用量敏感、想先預覽再決定要不要看完整文章的使用者，可在 Gemini 分頁的「節省模式」section 開啟「只翻文章開頭」toggle。啟用後翻譯只跑前 N 段（按 DOM 順序，預設 25 段，範圍 5-50），跳過後段，大幅減少 token 用量。

**漸進式體驗**：先翻開頭 → 讀完覺得想繼續 → 右下角提示會出現「翻譯剩餘段落」按鈕，點按即走完整翻譯。前面已翻好的段落從本地快取 fast path 命中（0 token / ~9ms），只後段才打 API；toggle 設定本身不會被改寫，下次翻新頁面仍走節省模式。

預設關閉。對部落格 / 新聞 / Substack 這類文章型網站特別有用——很多文章前 5-10 段就能判斷值不值得讀完。Wikipedia / GitHub 等「DOM 前段是 nav / chrome」的網站不建議開（會翻到導覽列而非主文）。

## 術語表一致化

LLM 在翻譯長文時，前後文的人名、地名翻譯容易出現不一致（例如同一個人名前面翻「強森」、後面變成「約翰森」）。開啟「術語表一致化」後，Shinkansen 會先掃描全文建立專有名詞對照表，再讓後續翻譯遵循同一套譯名。

這個功能預設不開啟，建議在特別需要精準翻譯（例如人名眾多的報導、學術文章）時才手動打開。副作用是術語翻譯會跳過 system prompt 的部分指示——例如原本設定「英文人名保留不翻」，開啟術語表後會一律翻成中文。此外，建立術語表需要額外的 API 呼叫，會增加少量 token 消耗與翻譯時間。

## Gemini API Rate Limit 參考（2026-04-10 擷取）

### Tier 1

| 模型 | RPM | TPM | RPD |
|------|-----|-----|-----|
| Gemini 2.5 Flash Lite | 4K | 4M | 無限制 |
| Gemini 2.5 Flash | 1K | 1M | 10K |
| Gemini 3.1 Flash Lite | 4K | 4M | 150K |
| Gemini 3 Flash | 1K | 2M | 10K |
| Gemini 2.5 Pro | 150 | 2M | 1K |
| Gemini 3.1 Pro | 225 | 2M | 250 |

### Tier 2

| 模型 | RPM | TPM | RPD |
|------|-----|-----|-----|
| Gemini 2.5 Flash Lite | 20K | 10M | 無限制 |
| Gemini 2.5 Flash | 2K | 3M | 100K |
| Gemini 3.1 Flash Lite | 10K | 10M | 350K |
| Gemini 3 Flash | 2K | 3M | 100K |
| Gemini 2.5 Pro | 1K | 5M | 50K |
| Gemini 3.1 Pro | 1K | 5M | 50K |

## 目前版本

v1.9.9 — 完整功能清單與規格詳見 [SPEC.md](SPEC.md)。

## 授權

本專案採用 [Elastic License 2.0 (ELv2)](LICENSE) 授權。

白話來說：你可以自由查看原始碼、學習、修改、自己使用，但**不能把 Shinkansen（或改寫版本）包成服務拿去賣**。完整條款請見 [LICENSE](LICENSE) 檔案。

## 第三方資源

Shinkansen 整合下列開源軟體與字型，完整來源、授權與授權檔位置見
[THIRD-PARTY-NOTICES.md](shinkansen/THIRD-PARTY-NOTICES.md):

- **PDF.js**(Mozilla,Apache 2.0)— 翻譯文件功能 PDF 解析 / render
- **pdf-lib**(Hopding,MIT)— 譯文 PDF 下載重組
- **fontkit**(Devon Govett / Hopding fork,MIT)— pdf-lib 的字型解析後端
- **Noto Sans CJK TC Regular**(Google Noto,SIL OFL 1.1)— 譯文 PDF 內嵌中文字型
