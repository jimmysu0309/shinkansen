# Shinkansen 🚄

快速、流暢的 Chrome 網頁翻譯擴充功能。使用 Google Gemini 將外語網頁翻譯成台灣繁體中文，原地替換文字，保留頁面原始排版。

名稱「新幹線」象徵快速、平穩、流暢的閱讀體驗。

> **[從 Chrome Web Store 安裝](https://chromewebstore.google.com/detail/shinkansen/pnhmlecoofeoofajcjenndnimhbodhlg)**（推薦）· [下載最新版本 zip](https://github.com/jimmysu0309/shinkansen/releases/latest) · 安裝教學與產品介紹見 [官方網頁](https://jimmysu0309.github.io/shinkansen/)

## 為什麼做這個專案

既有的沉浸式翻譯工具需要將個人瀏覽內容傳送到第三方伺服器處理，隱私權難以掌控。Shinkansen 的設計從一開始就以隱私為核心：所有設定與資料都只存在你自己的電腦上；除了你自備的 Gemini API Key 直接連線 Google 之外，不會將任何資料外傳給其他第三方；原始碼完全公開，任何人都可以檢視它的安全性。

## 效能實測

我們拿英文維基百科的 Taiwan 條目（超過一千段文字）做壓力測試：記憶體不增反減（中文比英文精簡）、翻譯過程中網頁不會變卡（95% 以上的時間在等 API 回應，電腦幾乎不做額外運算）、翻完後頁面結構維持乾淨不留痕跡。用最便宜的模型翻完整頁，API 費用不到 0.08 美元（約台幣 2.5 元），翻過的內容自動快取，下次再開不用重新花錢。完整測試數據見 [PERFORMANCE.md](PERFORMANCE.md)。

## 功能特色

- **保留網頁排版**：原地替換網頁文字，保留字型、字級、顏色與排版，連結仍可點擊、粗體斜體原樣保留
- **單語覆蓋 / 雙語對照雙模式**（v1.5.0 起）：popup 一鍵切換顯示模式——「單語覆蓋」原地替換、「雙語對照」原文保留 + 譯文以新段落 append。雙語模式提供 4 種視覺標記（淡底色 / 左邊細條 / 虛線底線 / 無）讓你選擇譯文段落的呈現風格
- **漸進式翻譯**：分批送出、逐批注入，頁面逐段變成中文，不必等全部翻完
- **雙翻譯引擎**：Gemini（AI 翻譯、品質最佳、需 API Key）+ Google Translate（非官方免費端點、不需 API Key、速度更快），依場景自由切換
- **三組可自訂快速鍵**：`Alt+A` / `Alt+S` / `Alt+D` 各自綁一組翻譯預設（引擎 + 模型 + 標籤），依網頁內容重要性一鍵選擇不同引擎（例如閱讀材料用 Flash、隨手瀏覽用 Google MT）。詳見下方「翻譯快速鍵與預設」段落
- **YouTube 字幕即時翻譯**：自動偵測 YouTube 字幕，即時替換為繁體中文，字幕樣式與原生 YouTube 字幕一致。詳見下方「YouTube 字幕翻譯」段落
- **固定術語表**：自訂翻譯對照表，指定特定詞彙一律翻成你要的譯名。支援全域與網域專屬兩層，網域規則覆蓋全域同名詞條。詳見下方「固定術語表」段落
- **全文術語表一致化**（預設不開啟）：特別適合人名眾多的長文，自動確保同一個人名或專有名詞前後翻譯一致。詳見下方「術語表一致化」段落
- **翻譯快取與即時節費報告**：雙層快取機制（本地快取 + Gemini implicit cache），翻譯完成後提示訊息即時顯示 cache hit rate 與實際節省費用。詳見下方「翻譯快取與費用計算」段落
- **三維 Rate Limiter**：RPM / TPM / RPD 滑動視窗，自動配合 Gemini API 配額
- **用量追蹤**：記錄每次翻譯的 token 數與費用，附圖表與 CSV 匯出
- **編輯譯文**：翻譯完成後可直接在頁面上修改譯文，適合要列印 PDF 或讓 Readwise Reader 抓取時，手動修正翻得不理想的地方
- **跨 tab 延續翻譯**（v1.4.11 起）：在 tab A 按快速鍵翻譯後，從 A 點連結開新 tab B（含 Cmd+Click / `target="_blank"` / `window.open`），B 自動翻譯並繼承同一組 preset；新 tab 再開新 tab 也繼續
- **自動翻譯指定網站**：在設定頁加入常看的網域，開啟該網站時自動翻譯，不用每次手動按快速鍵（翻譯通知會標示 `[自動翻譯]` 讓你知道是 whitelist 觸發）
- **還原原文**：按同一組快速鍵即切換回原文，隨時對照
- **Google Docs 翻譯**：自動偵測 Google Docs，開啟可翻譯的閱讀版並翻譯（詳見下方說明）

## 安裝方式

**推薦：Chrome Web Store**

前往 [Chrome Web Store 安裝頁面](https://chromewebstore.google.com/detail/shinkansen/pnhmlecoofeoofajcjenndnimhbodhlg) 點「加到 Chrome」即可。

**開發版（載入未封裝）**

1. 開啟 Chrome，網址列輸入 `chrome://extensions/` 並按 Enter
2. 右上角打開「開發人員模式」
3. 點「載入未封裝項目」（Load unpacked）
4. 選擇本專案的 `shinkansen/` 資料夾
5. 擴充功能清單會出現 Shinkansen，可以固定到工具列

**Firefox 本機安裝包（.xpi）**

1. 在專案根目錄執行：`npm run build:firefox`
2. 產物會輸出到 `dist/shinkansen-firefox-local-<git-describe-version>.xpi`
3. Firefox 開啟 `about:debugging` → `This Firefox` → `Load Temporary Add-on`
4. 選擇上一步產生的 `.xpi` 檔案即可載入

## 首次設定

1. 申請 Gemini API Key — 詳細步驟見 [API Key 申請教學](API-KEY-SETUP.md)
2. 點工具列的 Shinkansen 圖示 → 「設定」
3. 貼上你的 Gemini API Key
4. 預設模型 `gemini-3-flash-preview`、Service Tier `DEFAULT`
5. 其餘參數可依需求調整（溫度、每批段數、字元預算等）

## 使用方式

- **手動翻譯**：點工具列圖示 → 「翻譯本頁」
- **翻譯快速鍵**（v1.4.12 起三組）：
    - `Option+A`（macOS）/ `Alt+A` — 預設 Gemini Flash Lite（便宜）
    - `Option+S` / `Alt+S` — 預設 Gemini Flash（品質高，推薦日常用）
    - `Option+D` / `Alt+D` — 預設 Google Translate（免費、不需 API Key）
    - 三組鍵位、引擎、模型、標籤都可在設定頁「翻譯快速鍵」區塊自訂
    - 已翻譯狀態下按任一快速鍵 → 還原原文
    - 翻譯中按任一快速鍵 → 取消翻譯
- **YouTube 字幕翻譯**：開啟有英文字幕的影片，確認 CC 已開啟，點工具列圖示 → 打開「YouTube 字幕翻譯」開關
- **自動翻譯指定網站**：在設定頁的「自動翻譯網站」名單加入網域，進入該網站自動翻譯（翻譯通知會顯示 `[自動翻譯]` 前綴）
- **固定術語表**：在設定頁的「術語表」Tab 新增對照詞條，翻譯時會強制使用你指定的譯名
- **術語表一致化**：在 Popup 或設定頁開啟「術語表一致化」，長文翻譯會先建立專有名詞對照表
- **編輯譯文**：翻譯完成後，在 Popup 點「編輯譯文」可直接修改頁面上的譯文

## 翻譯快速鍵與預設

v1.4.12 起提供三組可自訂的翻譯預設，各綁一個快速鍵：

| 快速鍵 | 預設引擎 | 預設模型 | 適合場景 |
|--------|----------|----------|----------|
| `Alt+A` / `Option+A` | Gemini | Flash Lite（$0.10 / $0.30） | 隨手翻譯，要最省 |
| `Alt+S` / `Option+S` | Gemini | Flash（$0.50 / $3.00） | 日常閱讀，品質最佳性價比 |
| `Alt+D` / `Option+D` | Google Translate | — | 不需 API Key、速度快、完全免費 |

**可以在設定頁「翻譯快速鍵」區塊自訂**：每組 preset 的引擎（Gemini / Google Translate）、模型（Flash Lite / Flash / Pro / 自訂）、顯示標籤都可以改。鍵位本身則在 `chrome://extensions/shortcuts` 設定。

**統一的取消/還原行為**：
- 翻譯中按任一快速鍵 → 立即取消翻譯
- 已翻譯狀態下按任一快速鍵 → 還原原文（不分用哪個 preset 翻的）

**跨 tab 延續翻譯**（v1.4.11 起）：在 tab A 按快速鍵翻譯後，從 A 點連結開新 tab B（Cmd+Click、`target="_blank"` 或 `window.open`），B 會自動翻譯且繼承同一組 preset——讓使用者可以一路按連結讀下去不用每個 tab 都按快速鍵。新 tab 再開新 tab 也繼續；手動打網址 / 從 bookmark 開 / 從外部 app 開的 tab 不繼承（openerTabId 為空）。按任一組快速鍵還原只影響當前 tab，不影響樹中其他 tab。

## Google Translate 翻譯引擎

v1.4.0 起支援 Google Translate 作為第二翻譯引擎：

- **不需要 API Key**：使用 Google 公開的非官方 web 端點（與 `translate.google.com` 同源），完全免費
- **速度較快**：機器翻譯回應時間通常比 LLM 短
- **品質折衷**：語法流暢度、語感比 Gemini 略遜，但對純技術性內容（新聞、規格文件）足夠
- **保留連結與格式**：`<a>`、`<b>`、`<small>` 等語意標籤用特殊標記保護，翻譯後結構完整還原（不會把整頁 `<span>` 打爛）
- **費用為零、用量不計入 Gemini 配額**：但非官方端點無 SLA 保證，Google 若改動可能需要跟進修正

適合場景：大量瀏覽英文論壇、新聞、商品頁等「讀懂意思就好」的內容，用 Google MT 省 API 費用；需要精準翻譯（文學、學術文章、專有名詞處理）時切 Gemini。

## Google Docs 翻譯

Google Docs 的編輯畫面使用 Canvas 渲染文字，一般的網頁翻譯擴充功能無法存取其內容。Shinkansen 會自動偵測 Google Docs 頁面，並採用以下流程：

1. 在 Google Docs 編輯頁面按下 `Option + S`（或點 Popup 的「翻譯本頁」）
2. Shinkansen 會自動在新分頁開啟同一份文件的「行動版閱讀模式」（mobilebasic）
3. 新分頁載入完成後自動開始翻譯，不需再按一次

注意事項：你必須有該文件的檢視權限。「行動版閱讀模式」是純閱讀，不會影響原始文件。

## YouTube 字幕翻譯

開啟有英文字幕的 YouTube 影片，確認 CC 已開啟，點工具列的 Shinkansen 圖示，Popup 會出現「YouTube 字幕翻譯」開關，打開即可。字幕會在不影響影片播放的情況下逐段替換成繁體中文，樣式與 YouTube 原生字幕完全一致。

若你常看 YouTube 英文影片，可在設定頁的「YouTube 字幕」Tab 開啟自動翻譯，進入影片頁面後字幕翻譯會自動啟動，不需每次手動開關。

**費用**

字幕翻譯與網頁翻譯共用同一套計費邏輯與用量追蹤。翻過的字幕自動快取，重播或拖回已翻段落完全不花錢。

**注意事項**

- 需要影片有英文字幕（手動上傳或自動生成皆可）
- 字幕翻譯使用獨立的 system prompt，可在設定頁「YouTube 字幕」Tab 自訂
- 若 CC 未開啟，畫面會顯示提示請你先開啟字幕
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

v1.5.4 — 完整功能清單與規格詳見 [SPEC.md](SPEC.md)。

## 授權

本專案採用 [Elastic License 2.0 (ELv2)](LICENSE) 授權。

白話來說：你可以自由查看原始碼、學習、修改、自己使用，但**不能把 Shinkansen（或改寫版本）包成服務拿去賣**。完整條款請見 [LICENSE](LICENSE) 檔案。
