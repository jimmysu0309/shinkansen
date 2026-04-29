# Shinkansen 變更記錄

> 完整版本歷史。SPEC.md §2.1 只保留功能摘要表，詳細說明均在此保存。
> 版本號規則：v1.0.0 起三段式；v0.13–v0.99 為兩段式歷史版本。

---

## 使用者功能變更摘要

> 這份摘要只涵蓋使用者能感知到的功能與 UX 變更。完整版本歷史與技術細節請見下方 v1.6.x 起的詳細紀錄。

### 翻譯引擎與模型

- **v1.8.0** — **極速秒翻**:文章翻譯 batch 0 改走 Gemini streaming(SSE),按下翻譯 1 秒就看到頁面開始變中文(首字延遲 2.5-4.4 秒 → 1.0-1.2 秒);batch 0 size 從 10 unit 擴大到 25 unit,涵蓋整段內文前 25 段。僅限 Gemini 文章翻譯 batch 0,字幕 / 術語表 / Google MT / 自訂模型不動
- **v1.6.19** — Code review 後修 5 條穩健性 bug:YouTube 字幕並行批次某批失敗不再拖累其他批字幕、跨 tab sticky 翻譯在 SW 喚醒當下連開多 tab 不再漏繼承、設定頁可正確輸入 0(不會被靜默改回預設)、fragment 注入遇到 DOM 重排不再 crash、batch timer 不再洩漏
- **v1.6.18** — 自訂模型分頁加「思考強度」(自動 / 關閉 / 低 / 中 / 高)統一控制,涵蓋 OpenRouter / DeepSeek / Claude / OpenAI o-series / Grok / Qwen 6 家 thinking API 差異;另加「進階 JSON」逃生口給 power user 透傳 provider 專屬參數
- **v1.6.12** — 修 Pro 模型(`gemini-3-pro-preview` / `gemini-2.5-pro` 等)翻譯失敗 bug,並升級到 Gemini 3 推薦的 `thinkingLevel` API
- **v1.6.7** — 自訂模型支援本機後端（llama.cpp / Ollama 等不需 API Key 的服務）
- **v1.5.7** — 新增「自訂 OpenAI 相容模型」分頁，可接 OpenRouter / Together / DeepSeek / Groq / Fireworks / Ollama 等任何 OpenAI 相容端點

### 翻譯預設與快速鍵

- **v1.6.6** — 工具列「翻譯本頁」按鈕可指定對應的翻譯預設

### 顯示模式

- **v1.5.3** — 雙語對照的「虛線底線」改為波浪底線，與連結直線底線視覺區分
- **v1.5.2** — 雙語對照模式譯文繼承原文字型、字距、行距
- **v1.5.0** — 新增雙語對照模式（譯文與原文並列，可在 popup 即時切換）

### 翻譯品質與術語管理

- **v1.8.7** — 「**翻譯剩餘段落**」按鈕:partialMode 翻完開頭後 toast 顯示「已翻譯前 N 段(共 M 段)」+ 常駐按鈕,點按走完整翻譯,前段從本地快取 fast path 命中(0 token / 9ms),只後段打 API。「只翻文章開頭」UI 從「效能」section 獨立成「**節省模式**」section,搬到「配額」之前
- **v1.8.3** — 新增「**只翻文章開頭(節省費用)**」選項。翻譯只跑前 N 段(範圍 5-50,預設 25),大幅減少 token 用量;適合先預覽再決定要不要看完整文章。預設關閉
- **v1.7.1** — **翻譯優先級排序**:長網頁翻譯時最先看到的譯文從「導覽列 / cookie 同意書 / TOC」變成「文章標題 + 第一段內文」(`prioritizeUnits` 把 main / article 內段落排到 batch 0 + batch 0 序列化先跑)
- **v1.5.6** — 新增中國用語黑名單分頁（預設 25 條禁用詞，可編輯）

### YouTube 字幕翻譯

- **v1.8.9** — YouTube **人工字幕**(非 ASR)batch 0 也走 streaming(SSE),首字延遲從整批 resolve 砍成 SSE 首段;非 ASR 字幕長譯文也比照 ASR 走 `_wrapTargetText` 切點 + `<br>` 注入,中文長句不再沖出 video 寬
- **v1.8.2** — ASR 字幕 overlay 黑底 padding 縮緊,左右各省 7px,視覺比例對齊原生 YouTube 字幕(原本黑底比原生大很多)
- **v1.7.0** — YouTube **自動產生字幕**(ASR)生產級體驗:**AI 智慧分句**(整批送 Gemini 依語意重組,中文字幕從「破碎的詞」變「完整句子」)、**混合模式預設**(預設分句先秒出、AI 分句結果回來後替換)、**字幕 overlay 整句穩定顯示**(完全旁路 YouTube 原生 caption-segment 一字一字跳的問題);UI 簡化為單一「AI 分句模式」toggle
- **v1.6.20** — YouTube 自動產生字幕整套重做:三種分句模式可切換(預設分句 / AI 分句 / 混合模式)、字幕完全旁路原生跳動 + 整句穩定顯示、譯文過長依標點動態斷行(2 行為主)、字體 / 顏色 / 透明度 / 字型動態對齊原生英文字幕;勾「自動翻譯字幕」+ CC 未開時自動開啟 CC
- **v1.6.0** — 字幕分頁 tab 移到「一般設定」右邊；section 重組為「自動翻譯 → 翻譯引擎 → Gemini 設定 → 進階 → 視窗設定 → Prompt」
- **v1.6.0** — 字幕引擎新增「自訂模型」選項（與文章翻譯共用設定，prompt 可獨立）
- **v1.6.0** — 字幕新增「字幕也套用『固定術語表』/『禁用詞清單』」兩個 toggle（預設關，省 token）
- **v1.5.5** — 修「編輯譯文」會被自動還原的 bug

### 設定頁與用量紀錄

- **v1.6.17** — 設定頁次按鈕視覺對齊主按鈕(高度/字級一致,主按鈕仍突出)
- **v1.6.16** — 自訂模型分頁預填 OpenRouter DeepSeek V4 Pro(只剩 API Key 要填即可啟動);Gemini 分頁移除「後備路徑單價」UI;reset 按鈕補清空 v1.6.14 的計價覆蓋表
- **v1.6.15** — Gemini 分頁移除「全域 Gemini 模型」下拉(後備路徑已不需要),Service Tier 搬到「LLM 參數微調」section
- **v1.6.14** — 翻譯預設改名「主要預設 / 預設 2 / 預設 3」(原預設 2 突顯為「主要預設」加藍邊框);Gemini 分頁加 per-model 計價覆蓋表(Google 改價時可手動更新)
- **v1.6.13** — 自動翻譯白名單可指定使用哪一組預設(原本走 Gemini 全域模型,現在跟快速鍵行為一致);Gemini 分頁的「模型/計價」section 重新標示為「後備路徑專用」消除混淆
- **v1.6.11** — 用量紀錄分頁加「重新載入」按鈕(不需關閉設定頁也能看到最新紀錄)
- **v1.6.0** — 設定頁加入「重設所有參數」與「重置為預設 Prompt」按鈕；每批段數預設 12→20；用量紀錄時間 filter 改 24 小時制 + 「現在時間」按鈕
- **v1.5.7** — 用量紀錄「模型」欄改顯示 preset 標籤；Google MT 同 URL 批次自動合併

### 效能與穩定性

- **v1.8.10** — 修 LLM 偷懶把多段譯文合併成 1 段時,使用者看到字幕 / 文章顯示「«1» 中文 <<<SHINKANSEN_SEP>>> «2» 中文」殘留協定標記(YouTube 字幕 streaming 上特別常見)
- **v1.8.8** — 修「翻譯剩餘段落」按鈕後 toast 立刻顯示完成、實際大部分內容沒翻的 bug
- **v1.8.6** — 修「只翻文章開頭」中英夾雜的 bug(partialMode 改走純 DOM 順序,不再被 prioritizeUnits 重新排序造成 tier 1 真內文段被 truncate 掉)
- **v1.8.1** — 修 v1.8.0 streaming 路徑漏寫 cache,「翻譯 → 還原 → 重翻同一頁」回到 cache fast path(實測同頁 9 毫秒完成)
- **v1.7.3** — Glossary 阻塞門檻動態調整(預設 5 → 10):中等長度頁面(6-10 批)從「先等術語表再翻」改為「術語表跟翻譯並行」,首字延遲省 1.5-7.4 秒(Verge -61% / GitHub -64%)
- **v1.7.2** — 翻譯首字延遲再優化:batch 0 切小(10 unit / 1500 chars)、Readability tier 0 細分(GitHub repo / Wikipedia 等「main 包了 chrome」的網站 batch 0 排序更準)、glossary 抽取改用 Flash Lite。同組 10 個 URL 平均 -29%(NPR 11.7s → 5.1s 省 6.6 秒)
- **v1.6.10** — 分頁切到背景時暫停 Content Guard 與 SPA URL 輪詢,降低背景分頁的 CPU 與電力消耗
- **v1.6.9** — 段落偵測階段大幅優化,長頁（Wikipedia / 論壇 / 長 Medium）翻譯啟動明顯變快

### 通知與更新提示

- **v1.6.8** — 「顯示翻譯進度通知」master switch（可完全關閉 toast）
- **v1.6.5** — Chrome 商店自動更新後的「歡迎升級」提示（popup banner + toast 兩處）
- **v1.6.4** — Patch 級更新不再提示，避免高頻打擾
- **v1.6.1** — GitHub Releases 自動更新提示（給手動安裝 / unpacked 使用者）

---

## v1.8.x

**v1.8.20** — 大批 code review 結構性修補一輪(22 條 high/medium bug 一次清完 + 5 條新 spec 鎖死)。**最高優先**:options.js 主 Gemini config(temperature/topP/topK/maxOutputTokens)+ glossary/yt/customProvider 的數值欄位全改 `parseUserNum`,消除「空字串 → NaN 寫進 storage 後送 API 拒絕」+「使用者打 0 被當 falsy 改回預設」兩類靜默設定遺失。**結構性修補**:Content Guard IntersectionObserver 修 v1.8.14 子集設計缺口(`initGuardIntersectionObserver` 只 observe 啟動快照,後續 SPA rescan 翻新一批的譯段從未進 `guardVisibleSet` → guard sweep 對它們完全失效)— 加 `SK._guardObserveEl(el)` hook,5 處 `STATE.translatedHTML.set` + dual `translationCache.set` + dual swap key 都呼叫;`history.replaceState` patch 在 pathname 變動時觸發 SPA reset(原版只更 spaLastUrl,React Router shallow / Notion / Twitter 部分路徑會踩);streaming SW keep-alive 從 setInterval(SW unload 時跟 module-level state 一起死)改 `chrome.alarms.create`(持久排程,SW 收回後到觸發點仍會被喚醒 — `_STREAM_KEEPALIVE_PERIOD_MIN = 0.5`);`addUsage` 改 promise chain 序列化(防跨 tab 並行翻譯 read-modify-write race 永久遺失累計用量);`lib/cache.js` flushTouches 重讀 storage 比 value 後才更新 timestamp(防 5s 內被 setBatch 寫進的新譯文被舊值蓋回);`lib/logger.js` persistLog 同類 race 序列化;`getGlossary` set 改 safeStorageSet。**fragment 路徑補完整**:`injectFragmentTranslation` 結尾補 `setAttribute('data-shinkansen-translated','1')` + `STATE.translatedHTML.set` + `SK._guardObserveEl` — 否則 dual 模式下 fragment 段落 Content Guard 保護不到、SPA observer 重複偵測 → 重複翻譯。**自訂 Provider 用量帳單修正**:`handleTranslateCustom` 的 cache hit 折扣比例從硬編碼 0.75(Gemini 75% off)改成 `getCustomCacheHitRate(baseUrl)` 依 provider 推斷:Anthropic Claude / DeepSeek 0.10、OpenAI 0.50、未知 0.50 中間值 — 原版套 0.25 對 OpenAI 系統性低估費用 50%。**ASR 字幕 status 殘留修**:`_updateOverlay` 命中含中文 cue 時主動 `hideCaptionStatus()`(原本 ASR + 純中文模式 status 永遠殘留);`flushOnTheFly` 進場 + await 後雙重檢查 `YT.active`,`stopYouTubeTranslation` 清 `YT.flushing` flag(防 stop 後 ~300ms 內 flush 污染下個 session)。**安全 / 文件**:`lib/system-instruction.js` 加 `sanitizeTermText()`(對 glossary / fixedGlossary / forbiddenTerms 的 source/target/forbidden/replacement 消毒,移除 `<<<SHINKANSEN_SEP>>>` / `</forbidden_terms_blacklist>` / `⟦數字⟧` 佔位符 / 控制字元、200 字截斷,防 auto glossary 從惡意頁面抽出 token 污染協定);privacy-policy.html 移除已不存在的 `scripting` 權限聲明,改成 activeTab + alarms。**UX 補洞**:popup 翻譯按鈕雙擊防護(`disabled` flag);options 用量分頁 `_loadUsageDataReqId` token 比對只渲染最新 request(快切日期/粒度時舊資料不再覆蓋新圖表);Debug 分頁 fetchLogs `_fetchLogsInFlight` guard(SW 喚醒慢時不重複累加 log);`update-check` fetch 加 15s AbortController timeout(原本網路差會被 SW 30s idle 強殺,訊息可能被吞);welcome-notice 版本 parse 改 `parseInt(s,10) || 0` 防 `1.6.5-beta` 後綴 NaN;`restorePage` skip detached 元素 + warn log(SPA framework rerender 後 element 已 detach,寫 innerHTML 等於沒寫);OPEN_GDOC_MOBILE setTimeout leak 修(onUpdated 路徑 resolve 時 clearTimeout)。**新增 spec**(5 檔 36 條,SANITY 全驗): `test/regression/guard-io-observer-hook.spec.js`、`test/regression/inject-fragment-attribute-and-cache.spec.js`、`test/unit/system-instruction-sanitize.spec.js`(7)、`test/unit/custom-provider-cache-hit-rate.spec.js`(9)、`test/unit/streaming-keepalive-alarms.spec.js`(5)。**PENDING_REGRESSION 大清理**:9 條未清條目處理完(2 條補新 spec,5 條延續原 PENDING 判斷劃掉豁免,2 條 Drive 待修 task 從 regression backlog 移出 — 屬 design work 不是 spec missing)。

**v1.8.19** — 大型 UI 簡化 + 結構性修補一輪:options 多個 section 收進「進階設定」摺疊區、preset label 上限放寬、content scripts 全面導入安全 sendMessage helper(消除 Extension reload 後 orphan content script 噴 uncaught error)、配額管理文案從技術導向改價值導向、preset 順序改為「主要 → 預設 2 → 預設 3」、icon 換成 PNG 取代 emoji、option HTML 全形括號 audit。

**Bug 修正:**
- **Extension context invalidated 不再洩漏 uncaught error**:Extension reload / 更新時,已載入頁面的 orphan content script 失去 extension 連線通道, 此後任何 `browser.runtime.sendMessage` 呼叫會 SYNC throw "Extension context invalidated" — 不是 promise reject!既有 caller 的 `.catch()` 接不到, 會洩漏 uncaught error 到 `chrome://extensions/` 錯誤面板, 污染真實 bug 的能見度。修法:`shinkansen/content-ns.js` 加 `SK.safeSendMessage(msg)` helper(三層防護: `chrome.runtime.id` fast path + sync try/catch + async `.catch` 過濾, 只吞 invalidated / Receiving end 兩類錯誤, 真實業務錯誤照丟); content scripts 31 處 caller 全替換(content.js × 18、content-youtube.js × 7、content-toast.js × 2、content-drive.js × 2、content-spa.js × 1、content-drive-iframe.js × 1 inline 防護因不在 SK 命名空間內)。Regression 補進 `test/regression/safe-send-message-context-invalidated.spec.js`(3 條 spec: sync throw 不洩漏 / async reject 訊息匹配也吞 / 真實業務錯誤仍會 reject)

**UI 大型簡化:**
- **配額管理改價值導向 + 整段收進進階摺疊**:原「配額(API 用量限制)」section 改名「API 配額管理(進階)」, 整個 section 包進 `<details class="advanced-details">` 摺疊區(預設收起)。文案從技術導向「自動控制請求頻率, 避免超出 Google 的使用量限制」改成價值導向「Shinkansen 會在背景幫你管理 Gemini API 用量。大頁面翻譯時會把請求平均攤開避免 burst 觸發 Google 限速; 快超過每日上限時提早警告, 不會等到失敗才知道。多數情況維持預設即可」。**安全邊際 slider 從 UI 移除**(99% 使用者不知道為什麼要設、設多少也看不出差別 — 純 over-engineering); 程式碼內部寫死 0.1(透過 `lib/storage.js` default + `lib/tier-limits.js` fallback)。設定 import schema 仍容忍 `safetyMargin` key, 舊匯出檔可正常匯入
- **多個 section 整體進階化**:LLM 參數微調(Service Tier、Top P、Top K、Max Output Tokens 收進進階, Temperature 留外面作主要欄位)、效能(翻譯效率調校)整段收進進階、翻譯視窗設定整段收進進階、術語表三進階欄位 + 術語擷取 Prompt 收進同一個 details
- **preset label 字元上限 12→30**:對齊輸入框視覺寬度(原 12 字元只佔輸入框 1/3 寬度, 使用者反映無法塞入「OpenRouter Claude 3.5」這類完整模型描述)。下游 3 處顯示加 truncate: `usage-table .col-model` 加 `max-width: 220px + ellipsis + title attr` 提供 hover tooltip; `popup-button-slot` / `auto-translate-slot` 兩個 select 加 `max-width: 360px`。Regression 補進 `test/regression/options-preset-label-live-update.spec.js`(本來其實是 v1.8.17 加的, 順便鎖死下游聯動)
- **preset UI 順序改為「主要預設 → 預設 2 → 預設 3」**:options preset card 順序 + popup-button-slot / auto-translate-slot 下拉順序 + manifest commands 順序(`chrome://extensions/shortcuts` 顯示)三處同步調整。內部 slot 1/2/3 編號**完全不變**, 所有依賴 slot 編號的 storage / cache / 跨 tab sticky 全部正常
- **manifest commands description 重整 + command id rename 控制顯示順序**:舊「翻譯預設 2(預設 Gemini Flash Lite)」/「翻譯主要預設(預設 Gemini Flash)」/「翻譯預設 3(預設 Google Translate, 維持原 slot 3 編號)」格式不對稱、寫死模型名會誤導(使用者改 preset 後 description 仍寫舊模型)、含開發者註記「維持原 slot 3 編號」使用者看不懂。改成「翻譯本頁 - 主要預設」「翻譯本頁 - 預設 2」「翻譯本頁 - 預設 3」三條對稱簡潔, 不寫死模型。Chrome `chrome://extensions/shortcuts` 顯示順序由 command id 字典序決定(實測), 為了讓「主要預設」排第一, 把 `translate-preset-2` 改名為 `translate-preset-0`(字典序「0」最前), background.js listener 加 `COMMAND_ID_TO_SLOT = { 0: 2, 1: 1, 3: 3 }` mapping 維持 slot 1/2/3 storage 對應。**升級影響**:沒手動改過快捷鍵的使用者完全無感(Chrome 自動套 `suggested_key: Alt+S`);手動改過 Alt+S 為其他鍵的使用者, Chrome 會把舊 command id 視為移除、新 id 視為新加, 自訂綁定丟失需重綁(進 chrome://extensions/shortcuts 即可)
- **option / popup 標題 emoji 改 PNG icon**:從 `🚄 Shinkansen` 改用 `<img src="../icons/icon-128.png" class="page-title-icon">` + 「Shinkansen」, options 用 32px / popup 用 22px, flex + gap 對齊
- **options.html 全形括號 audit**:Python 腳本批次轉 18 處 CJK 上下文的半形括號為全形, 純英文縮寫(`(ELv2)` / `Twitter (X)`)按 §13 例外維持半形

**v1.8.18** — 移除 `chrome.management` API 的依賴(原本用來判斷 CWS vs 手動安裝),改用 `chrome.runtime.getManifest().update_url` 判斷,完全消除「需要 management permission」這個歷史包袱;同步更新 README + landing page 補充「字幕雙語對照」說明。

**Code 變更:**
- `shinkansen/lib/update-check.js`:`isManualInstall()` 改用 `chrome.runtime.getManifest().update_url` 同步判斷(CWS 安裝時 Chrome 會自動 inject `update_url`,自家 manifest 不寫 → 有 = CWS,沒有 = 手動)。原本的 `chrome.management.getSelf()` 需要 `management` permission(屬 CWS 敏感權限,能列舉/disable 其他 extension),雖然 manifest 沒宣告所以原 code 走 try/catch fallback,但邏輯不夠乾淨。修法後完全消除對 `management` API 的依賴,manifest 只保留實際用到的 `storage / activeTab / alarms` 三個 permission
- `test/unit/update-check.spec.js`:mock 從 `management.getSelf` 改成 `runtime.getManifest` 注入 `update_url`(installType='normal' → 注入,模擬 CWS 安裝),15 條既有 spec 全綠

**文件:**
- `README.md`:功能特色清單新增「字幕雙語對照」(v1.8.15 起)條目;「YouTube 字幕翻譯」section 新增「### 字幕雙語對照」子段(適合場景 + 實作要點:YouTube + Google Drive 影片共用同一個設定、即時切換、AI 分句模式相容)
- `docs/index.html`:landing page「YouTube 字幕翻譯」 feature card 文案補充「並可選擇雙語對照」

**v1.8.17** — 修設定頁「翻譯快速鍵」preset 標籤改變時,「工具列翻譯本頁按鈕」與「自動翻譯網站」兩個下拉選單沒有即時跟著更新顯示文字的小 bug。

**Bug 修正:**
- `shinkansen/options/options.js`:原本兩個下拉選單的 option text 只在 `init()` 載入時組一次,使用者在「翻譯快速鍵」section 改 preset 標籤輸入框時,下游兩個 select 要重整頁面才會更新。修法:抽出 `refreshSlotDropdownLabels()` helper 統一從 DOM input 讀目前值組「{slotTitle}:{label}」,在 init() 載入時呼叫一次,並在三個 `preset-label-{slot}` input 上掛 `input` event listener,使用者打字當下就刷新兩個下拉選單顯示。Regression 補進 `test/regression/options-preset-label-live-update.spec.js`(三 slot 即時聯動 + 空標籤 fallback 到 slotTitle)。

**v1.8.16** — 修 YouTube 字幕「reload 後字幕等不到 / 多次 reload 才 work」race condition + 「翻譯中…」提示打擾優化。

**Bug 修正:**
- YouTube 字幕翻譯 reload 後常等不到字幕、reload 多次才會突然開始翻的 race condition。根因:`content.js:1599` 的 auto-subtitle on load(setTimeout 800ms)與 `content-youtube.js:2334` 的 yt-navigate-finish SPA restart(setTimeout 500ms)兩條獨立自動鬧鐘在 reload 後都會 fire,後到那條進 `translateYouTubeSubtitles` 看 `YT.active=true` 走「再按一次還原」分支誤觸 `stopYouTubeTranslation`,把第一條鬧鐘已啟動的字幕 pipeline 整個砍掉。修法:`translateYouTubeSubtitles` 加 `{ source: 'manual' | 'auto' }` 參數,auto 路徑遇 active 直接 no-op log + return,manual 維持 toggle 還原語義。Caller 改造:content.js:1599 與 content-youtube.js:2334 兩條自動路徑改傳 `source: 'auto'`,popup `SET_SUBTITLE` 維持預設 manual(使用者操作 = manual)。Regression 補進 `test/regression/youtube-auto-activate-no-toggle-stop.spec.js`(2 條 test 涵蓋 auto no-op + manual toggle)
- 雙語字幕模式 reload 後中英 CC 重疊在原生 30px 高度(toggle 雙語 off→on 後就錯開)。根因:`_setAsrHidingMode` 原本只在 `active=true`(純中文模式)分支注入 stylesheet,雙語直接啟動走 `active=false` 分支只 removeClass 不注入,`shinkansen-yt-overlay[bilingual] { --sk-cue-bottom: 90px }` 這條讓 overlay 上抬避開原生英文 CC 的 rule 從來沒進 DOM。修法:stylesheet 注入抽 `_ensureAsrStylesheet()` helper,`_setAsrHidingMode` 入口無條件 ensure,active true/false 兩條分支都拿到 CSS rule。Regression 補進 `test/regression/youtube-bilingual-reload-stylesheet.spec.js`(SANITY 通過)

**UX 優化:**
- 螢幕上已有中文字幕時不顯示「翻譯中…」黑底文字 indicator,避免覆蓋實質內容。新增 `_hasVisibleChineseCaption()` helper(ASR 路徑查 `_findActiveCue` 命中當前 cue 含 CJK / 非 ASR 路徑查 `.ytp-caption-segment` 含 CJK),3 處 `showCaptionStatus('翻譯中…')` 各包 guard。「等待字幕資料…」提示**不**加 guard——該分支進得去代表 rawSegments=0 不可能有中文字幕,出現 = 系統 invariant 異常,留作日後 debug 訊號
- 設定頁 Debug 分頁「分類」filter dropdown 補上 4 個既有 sendLog / debugLog 在用但 dropdown 漏列的 channel:`YouTube 字幕`(youtube)、`Drive 字幕`(drive)、`Content Guard`(guard)、`YouTube 除錯`(youtube-debug)。先前使用者要篩 YouTube log 只能看 row 端標籤手動找,無法用 filter。row 端 LOG_CAT_LABELS map 不動,raw key 顯示維持現狀

**v1.8.15** — Drive 影片 ASR 字幕翻譯 + 字幕雙語對照 toggle 大功能版本。

**功能新增:**
- **Drive 影片字幕翻譯**:支援 Google Drive 影片 viewer(drive.google.com/file/...)的 ASR 自動字幕翻譯。架構上 youtube.googleapis.com/embed iframe 內 PerformanceObserver 攔截 timedtext URL,background 用 authpayload-self-contained URL 直接 refetch json3,relay 給 top frame 的 content-drive.js。譯文走 D'(LLM 自由合句)寫進 SK.DRIVE.entries,top frame 自繪 `<shinkansen-drive-overlay>` Shadow DOM 浮層 + 跨 origin postMessage(YouTube IFrame Player API)同步 currentTime 顯示對應中文。整支 26 分鐘影片 throttled 並行 3 batch,~1 分鐘翻完,$0.05 token cost(Gemini)/ $0(Google Translate)
- **字幕雙語對照 toggle**(`ytSubtitle.bilingualMode`,popup 加切換):YouTube + Drive 共用一個開關。打開 = 中英對照(YouTube ASR 中文 overlay 在原生英文 CC 上方 / Drive 中文浮層 + iframe 內原生英文 CC / YouTube 人工字幕「英文 + 譯文兩行」寫進原生 segment);關閉 = 純中文(預設,沿用 v1.8.14 既有行為)。即時切換不需 reload(YouTube 路徑 storage onChanged listener 即時 reapply,Drive 透過 postMessage loadModule/unloadModule captions)
- **Drive 字幕設定共用 ytSubtitle**:user 不需為 Drive 額外設定。`ytSubtitle.engine='gemini'` Drive 走 D' LLM 合句,`'google'` 走 GT 逐段翻免費。autoTranslate / model / pricing 全部沿用
- **popup 加 Drive 字幕翻譯 toggle**(類似 YouTube 既有 toggle,共用 ytSubtitle.autoTranslate 設定)

**架構新增:**
- 新檔 `shinkansen/content-drive.js`(top frame entry,gate hostname=drive.google.com & pathname /file/ & top frame)
- 新檔 `shinkansen/content-drive-iframe.js`(youtube.googleapis.com/embed iframe entry,PerformanceObserver 攔 timedtext URL → background relay)
- `manifest.json` content_scripts 加 `https://youtube.googleapis.com/*` entry(只裝 content-drive-iframe.js)+ all_urls 既有那組加 content-drive.js
- `background.js` 加 `DRIVE_TIMEDTEXT_URL` / `TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH` / `TRANSLATE_DRIVE_BATCH_GOOGLE` 三個訊息 handler;抽 `_handleAsrSubtitleBatch` helper 給 YouTube 跟 Drive 共用 D' 邏輯
- `content-youtube.js` IIFE 末尾 export `SK.ASR = { parseJson3, mergeAsr, parseAsrResponse }` 給 content-drive.js 共用

**已知限制(留 v1.8.16 dedicated 修):**
- Drive 影片需手動按 CC 一次觸發字幕載入(自動 setOption track protocol 對 cross-origin postMessage timing 不可靠,留 v1.8.16 debug)
- Drive overlay 控制列顯示時不動態上抬避開進度條(cross-origin iframe 監測 chrome show/hide 的 mouseenter/mouseleave event 不可靠,留 v1.8.16 改 design);目前 overlay 固定 22% 高度,實際 player 高度大時不會被進度條疊到

無 regression spec(commit 1-5d 整段 Drive ASR pipeline 走 PENDING_REGRESSION 路徑 B,e2e spec 留 v1.8.16);YouTube 既有 ASR 13 + non-ASR 8 + version-check 5 + GT preserve / unit 等相關 spec 全綠驗 YouTube 路徑零踩。

---

**v1.8.14** — 全專案技術債 review 後一輪整理:**2 個真實 bug** + **8 條性能/正確性修補** + **7 條維護性 refactor**(無功能變更)。

Bug fix:
- A1 `content-youtube.js:_runAsrSubBatch` 結尾 `domSegmentCount: domSegs.length` 在該 scope 未定義 → ASR 字幕每跑一個子批就拋 ReferenceError 被外層 try/catch 吞掉,`YT.lastApiMs` 沒同步、debug 計時失準、log 持續噴 "asr sub-batch N failed",但字幕本身 OK 所以沒被回報。修:刪該欄位 + 暴露 `SK._runAsrSubBatch` 給 spec。新 regression `test/regression/asr-sub-batch-no-reference-error.spec.js`(SANITY 加回該行 → fail)
- A2 設定頁用量分頁「匯出 CSV」按鈕 `$('usage-from').value` / `$('usage-to').value` 讀已不存在的 element id(v1.5.7 拆成 `usage-from-date` / `usage-from-hour` / `usage-from-min`)→ TypeError、按鈕一按必炸。修:`lib/format.js` 新增 `formatYmd` + `buildUsageCsvFilename(fromMs, toMs)` helper 改用 timestamp 構檔名。新 unit spec `test/unit/usage-csv-filename.spec.js`(6 條,SANITY 驗過)

性能/正確性:
- B1 `cache.js getCacheUsageBytes` 改用 `storage.local.getBytesInUse(null)`(舊瀏覽器 fallback 走 get(null))→ 不再每次反覆把 9.5MB 翻譯快取 JSON 拉進記憶體;`evictOldest` 接 optional `preFetchedAll` 避免雙掃。新 unit spec `test/unit/cache-bytes-getbytesinuse.spec.js`
- B2+B3 `lib/storage.js` 新增 `getSettingsCached()`(promise cache + `storage.onChanged` invalidate);`lib/logger.js debugLog` 與 `background.js LOG_USAGE` handler 改用 cached 版本 → YouTube 一支影片上百次 LOG_USAGE / 每筆 log 都重讀整份 settings 變單次。新 unit spec `test/unit/settings-cache.spec.js`(2 條含 invalidate 行為)
- B4 `content-spa.js` Content Guard 加 `IntersectionObserver` + `guardVisibleSet`,sweep 改成只走 viewport 附近的 entry 而非整份 STATE.translatedHTML → 長文(Wikipedia 千段)從每秒 1000 次字串相等比對 + 部分 forced layout 降到通常 < 30 entry 子集
- B5 `options.js` usage-search input 加 150ms debounce;fetchLogs 在 `res.logs.length===0` 時 short-circuit 不 render
- C1 `background.js` streaming 期間用 `_streamKeepAliveTimer` 每 20 秒呼叫 `chrome.runtime.getPlatformInfo` 重置 SW idle timer → 長頁翻譯中切去 5 分鐘回來,取消按鈕仍能用(原本 SW unload 後 inFlightStreams Map 消失 → abort 訊號到不了 fetch)
- C2 `options.save()` 加 `_saveInFlight` flag,並發按下兩次儲存 short-circuit
- C3 `lib/storage.js` 新增 `cleanupLegacySyncKeys()`,SW 啟動時一次性把 `ytPreserveLineBreaks` / `preserveLineBreaks`(v1.2.38 移除)從 storage.sync 清除,避免長期累積踩到 8KB / item quota。新 unit spec `test/unit/legacy-key-cleanup.spec.js`(3 條含冪等)

Refactor(行為等價,純維護性):
- E1 `content-detect.js` 抽 `hasBlockAncestor(el)` + `blockAncestorMemo`,leaf anchor / leaf div span 兩條補抓共用,長頁面省千次祖先比對
- E2 `content.js restorePage` dual / single 兩分支重複的 `originalHTML.forEach` 合併成單一迴圈
- E3 `content.js` 抽 `restoreOriginalHTMLAndReset()`,Gemini abort + Google abort 兩處共用(SPA reset 語意不同不抽)
- E4 `content.js packBatches` 寫入 `job.idx`,兩處 `jobs.indexOf(job)` 改 `job.idx`(O(N²) → O(1) log 計算)
- E5 `content-youtube.js _findActiveCue` 確認 `_upsertDisplayCue` 已用 findIndex upsert + sort(同 startMs 不留多筆),內 loop 簡化為 `cues[i+1].startMs`(O(N²) → O(N))
- E6 `lib/cache.js hashText` 加 LRU memo(上限 500),getBatch + setBatch 同段原文不重算 SHA-1
- E8 `lib/rate-limiter.js` 維護 `_tokenSum` incremental(push += / shift -=),`currentTokenSum` 從 reduce 整陣列改 O(1) 直接讀。新 unit spec `test/unit/rate-limiter-token-sum.spec.js`(4 條含壓力測試)

PENDING_REGRESSION 入庫(改動已套用,spec 抽不出乾淨):A3 GMT 字幕 IndexedDB source 分類錯誤(非真漏帳,費用幾乎 $0)、B4 IO subset、B5 debounce、C1 SW keep-alive、C2 save in-flight guard。

未動(獨立評估):D1-D4 中-高風險重構(三條翻譯 handler / translatePage Gemini vs Google / content-youtube 三條 streaming pattern / options form binding)、E7 usage-db compound index(IndexedDB schema migration 等用量真的暴增再說)。

Full suite 357/357 pass。

**v1.8.13** — 修 Google MT 翻譯大量 inline 連結段落時譯文殘留「【1/Proad】 /Proad1】 /Proad1】 ...」這類 garbage 標記的 bug(典型觸發場景:Medium 作者 byline「socials: YouTube | TikTok | Substack | ...」這類大量短 `<a>` 列表)。根因:以實 fetch `translate.googleapis.com/translate_a/single` 驗證,Google Translate 非官方端點對同段內 `【N】xxx【/N】` 配對標記超過 5 對時會 hallucinate 把標記當 list 結構亂吐 garbage tokens(3-5 對 OK、6 對開始壞、8 對完全爛、Atomic `【*N】` 不受影響連 8 個都正常)。修法:`shinkansen/content-serialize.js` `serializeNodeIterableForGoogle` 加 `GT_MAX_PAIRED_SLOTS=5` 閾值 + `countPairedInlineForGT` helper,paired-eligible inline 元素數 > 5 時降級——同段內 `GT_INLINE_TAGS` 元素改走「不加 paired 標記、純取文字」路徑(slots 仍可含 atomic),該段失去 `<a>` 連結保留(anchor text 變純文字)但譯文不會壞。新 1 條 regression spec(`test/regression/google-translate-many-markers-degrade.spec.js`,2 test:8 個 `<a>` 應降級 + 5 個 `<a>` 維持原 v1.4.2 行為的回歸保護);SANITY 把 `degrade` 寫死成 `false` → test #1 fail(received=8 markers expected=0)test #2 仍 pass,還原後 5/5 含 v1.4.1/4.2/4.3 既有 3 條全綠。Full suite 339/339 pass。

**v1.8.12** — popup「⚠ 尚未設定 API Key」警告 gate 在「translatePresets 中至少一組是 Gemini」之後。使用者反映他完全沒用 Gemini(三組 preset 都改成 Google MT / 自訂模型),但 popup 一直在提醒沒填 Gemini API Key。修法:`shinkansen/lib/storage.js` 加 `presetsRequireGemini(presets)` helper(any-slot some-match;空 / undefined / 非 array → 保守回 true 跟 DEFAULT_SETTINGS 對齊),`shinkansen/popup/popup.js` 把原本 `if (!apiKey)` 改成 `if (!apiKey && presetsRequireGemini(translatePresets))`。範圍外不動的:`background.js` 三處「尚未設定 Gemini API Key」error throw 維持原狀(只在使用者主動觸發 Gemini 翻譯時才跑出來,行為正確);options 設定頁 Gemini 分頁 API Key 欄位也維持(使用者主動點進去看不算嘮叨)。新 1 條 regression(`test/unit/presets-require-gemini.spec.js`,7 條斷言;SANITY 把 `some` 改 `every` → 預設組合 + 含 gemini mixed 兩條 fail,還原後 7/7 pass)。

**v1.8.11** — 文案與文件大整理(無功能變更)。**(A)近期重大更新 6 條同步**:`shinkansen/lib/release-highlights.js` / `README.md` / `docs/index.html` 三處重排順序與用字統一(極速秒翻 / 雙語對照 / 自訂 AI 模型 / AI 分句 / 中國用語黑名單 / 只翻文章開頭);「AI 智慧分句」→「AI 分句」、「百種模型」→「所有模型」、「按下翻譯後 1 秒就看到」→「按下翻譯 1 秒看到」。**(B)options.html**:「只翻文章開頭」說明拿掉「實際翻譯段數可能因 token 上限略少」尾巴(避免使用者困惑)。**(C)docs/index.html 功能特色重排**:加入「極速秒翻」(第一順位)、「中國用語黑名單」、「只翻文章開頭」三張卡;「三翻譯引擎」搬到最後;原「三翻譯引擎」內的快速鍵說明獨立成「自訂快速鍵」卡。**(D)README.md 功能特色**:移除「漸進式翻譯」改為「極速秒翻」(第一順位);加「YouTube AI 分句」(在 YouTube 字幕翻譯下方);「自訂 AI 模型」從「三翻譯引擎」拆開;新增「只翻文章開頭」條目 + 下方詳細說明段落。**(E)CHANGELOG.md 使用者功能變更摘要**:補完 v1.7.0 → v1.8.10 共 12 條使用者可感知的變更(極速秒翻 / 翻譯剩餘段落按鈕 / 只翻文章開頭 / 翻譯優先級排序 / YouTube 人工字幕 streaming / ASR overlay padding / AI 智慧分句 / 修 LLM 合併段落殘留標記 等)。**(F)測試流程說明.md 對齊現狀**:測試總數 229 → ~356 條(86 regression + 23 unit + 7 jest-unit + 1 version-check);regression spec 數 73 → 86;速查表補 24 條 regression(streaming 系列 / partial-mode / dual / fragment / priority / youtube)+ 7 條 unit(auto-translate-slot / gemini-thinking-config / google-translate-batch / model-pricing-override / openai-compat-thinking-mapping / parse-user-num / streaming-batch-incremental)。**(G)清掉廢棄檔**:刪除 untracked 的 `ziSkBLbG`(176K 隨機檔名 zip,內容是 v1.4.x 時期 shinkansen 子目錄打包,無引用)。

**v1.8.10** — 修 LLM 偷懶把 N 段譯文合併成 1 段時,使用者看到字幕 / 文章顯示「«1» 中文 <<<SHINKANSEN_SEP>>> «2» 中文」殘留協定標記的 bug(YouTube 字幕 streaming 上特別常見)。雙層防禦:(A)`SK.sanitizeMarkers` defensive helper 在寫 captionMap / inject DOM 之前 strip SEP / «N» 標記(content-ns.js 加 export,套到字幕 `_injectBatchResult` / ASR heuristic / `flushOnTheFly` + 文章 `runBatch` / `STREAMING_SEGMENT` 共 5 處注入點);(B)streaming `STREAMING_DONE` 帶 `hadMismatch=true` 時 `doneReject` 觸發既有 mid-failure catch,batch 0 整批 retry 走 non-streaming(等 LLM 整批 resolve 後一次 split,容錯較高),覆蓋 streaming 已注入的合併版本。SPEC.md §2.2 規劃中加上「Gemini structured output」條目,治本路徑(`responseSchema` + JSON 格式強制)排到下個 milestone(僅限 Gemini,1-2 天工程)。新 4 條 regression(sanitize-marker-leak × 2 + streaming-batch-0-mismatch-retry × 2)。

**v1.8.9** — YouTube 人工字幕 batch 0 改走 streaming(SSE)。新訊息 `TRANSLATE_SUBTITLE_BATCH_STREAM`(SW 端 `handleTranslateStream` 加 opts 支援 `_yt` cacheTag + ytSubtitle.systemPrompt/temperature/model/pricing),content-youtube.js `translateWindowFrom` 非 ASR 分支加 `_runBatch0Streaming`:STREAMING_SEGMENT 抵達立刻寫 captionMap + replaceSegmentEl,首字延遲從整批 resolve 砍成 SSE 首段。fallback 觸發:first_chunk 1.5s timeout(送 STREAMING_ABORT)、streaming mid-failure(批次 0 整批 retry via 非 streaming);Google MT / OpenAI-compat engine 不啟用 streaming 維持原路徑。同輪補 v1.8.0 PENDING 三條 streaming e2e edge case spec(abort 跨批 / mid-failure retry / first_chunk timeout fallback,清空 PENDING queue),以及非 ASR 字幕長譯文比照 ASR overlay 走 `_wrapTargetText` 切點 + `<br>` 注入(`_setSegmentText` helper,改 `replaceSegmentEl` 與 `flushOnTheFly` 兩個寫入點),修 expandCaptionLine 強制 nowrap 導致中文長句沖出畫面。新 9 條 regression(streaming-batch-0-abort / mid-failure / first-chunk-timeout、youtube-non-asr-wrap × 3、youtube-non-asr-streaming × 5)。

**v1.8.8** — 修「翻譯剩餘段落」按鈕後 toast 立刻顯示完成、實際大部分內容沒翻的 bug;順帶補 v1.8.7 release 後續修補(toast action button 配色 + 近期重大更新文案 6 條)。

  - **`content-toast.js`**:`.toast-action` 從半透明白底改成實心 `#0071e3` 品牌藍 + 白字(原配色在 toast 白底深字風格下幾乎隱形,使用者反映「沒看到有繼續翻譯的提示」),hover/active 用更深藍。
  - **`lib/release-highlights.js`**:近期重大更新從 4 條擴成 6 條(按使用者敲定文案):極速秒翻 / AI 智慧分句 / 雙語對照 / 自訂 AI 模型 / 中國用語黑名單 / 只翻文章開頭。
  - **`content.js translateUnits`**(主修): Root cause:`translateUnits` 讀 `storage.partialMode.enabled` 直接決定 `skipBatch1Plus`,完全沒檢查 `ignorePartialMode` flag。當使用者開節省模式 toggle 翻完開頭、點「翻譯剩餘段落」按鈕觸發 `translatePage({ ignorePartialMode: true })` 時,主流程的 `pmActive` 雖然正確處理豁免、不 truncate units(全 230 段都進來),但下游 `translateUnits` 仍把它當 partialMode 跑,22 批切完只翻 batch 0 的 8 段就 toast「翻譯完成」,然後 SPA observer rescan 機制每隔幾秒重觸發 → 又只翻 batch 0,一輪 8 / 17 / 12 段慢爬。修法:`translateUnits` 簽名加 `ignorePartialMode` option,內部新增 `partialModeActive = partialMode.enabled && !ignorePartialMode` 旗標,`firstBatchUnits`(line 273)與 `skipBatch1Plus`(line 448)兩處改用此旗標;callsite(`translatePage`)傳 `ignorePartialMode: !!options.ignorePartialMode`。新 regression `test/regression/translate-ignore-partial-mode-runs-all-batches.spec.js`(SANITY 反向驗證 fail-then-pass)。debug 過程在 `translateUnits` / `translatePage` 加 8 條 instrumentation log(translatePage entry / packBatches detail / main flow start / stream firstChunkOrTimeout / parallel dispatch decision / after stream donePromise / after parallelP / about to fire success toast)保留作為未來除錯材料(buffer-based,不會印 console)。

**v1.8.7** — 「只翻文章開頭」翻完後的銜接體驗 + UI 重新定位:**(A)使用者順暢操作流程**——partialMode 翻完後,toast 訊息變成「已翻譯前 N 段(共 M 段)」並顯示「翻譯剩餘段落」按鈕(常駐直到使用者點按或關閉)。點按 → `translatePage({ ignorePartialMode: true })` 走完整翻譯,前 N 段從本地快取 fast path 命中(0 token + 9ms)、只後段打 API,**toggle 設定本身不被改寫**(下次翻新頁面仍走節省模式)。**(B)UI 重新定位**——「只翻文章開頭」從 Gemini 分頁的「效能」section 內(被視為微調)獨立成「**節省模式**」section,搬到「配額」之前更顯眼的位置,定位為一般使用者會用的功能而非進階參數。toggle label 也從「只翻文章開頭(節省費用)」精簡成「**只翻文章開頭**」(子說明保留費用解釋)。

  - **`content-toast.js`**:`opts.action = { label, onClick }` 新增,toast 內加 `.toast-action` 按鈕(Shadow DOM 內 button + click listener);有 `action` 時 success toast 不 auto-hide;`hideToast` 清乾淨 action handler 避免 callback 殘留。
  - **`content.js translatePage` / `translatePageGoogle`**:加 `options.ignorePartialMode` 參數,STATE.translated=true + ignorePartialMode 時不走 restorePage 早退,改靜默重置 `STATE.translated=false` 後跑完整翻譯;partialMode 判斷加豁免條件(toggle 啟用但 ignorePartialMode=true 時走完整流程)。`pmSkippedCount` 追蹤被截掉的段數,success toast 在 `pmActive && pmSkippedCount > 0` 時帶 `action: { label: '翻譯剩餘段落', onClick: () => SK.translatePage({ ...options, ignorePartialMode: true }) }`。
  - **`options/options.html`**:刪除 Gemini 分頁「效能」section 內的 partialMode label;新建獨立「節省模式」section 插在「配額」之前。說明文字更新反映 v1.8.6 DOM 順序行為 + v1.8.7 「翻譯剩餘段落」按鈕。
  - **新 regression**:`test/regression/translate-partial-mode-ignore.spec.js` 鎖「ignorePartialMode=true + STATE.translated=true 時不走 restorePage 早退」(SANITY 雙驗通過——測 A 不帶 flag 走 restorePage / 測 B 帶 flag 跑完整流程)。

**v1.8.6** — 修「只翻文章開頭」中英夾雜的 bug。在 wheresyoured.at / Substack / Ghost 等部落格上,prioritizeUnits 把短內文段(score < 5,例如「I feel nothing when I see an LLM's output」這種 ~150 字 + 1 個逗號的純內文)排到 tier 1 後面,partialMode 取前 25 段全給 tier 0(score >= 5 的長段)→ tier 1 的真內文段被 truncate 掉 → 中間夾雜未翻段落,使用者看到「翻譯-原文-翻譯-原文」交錯。修法:partialMode 啟用時跳過 prioritizeUnits,改走純 DOM 順序——對使用者語意是「翻頁面 DOM 前 N 段」(視覺連續中文),不是「prioritize 認為最重要的 N 段」。Trade-off:Wikipedia / GitHub 等「DOM 前段是 nav / chrome」的網站開 partialMode 會翻到導覽列(回到 v1.7.0 之前行為),但這類網站非 partialMode 主要使用情境(使用者比較會在文章型部落格 / 新聞站開節省模式)。

**v1.8.5** — 修 v1.8.3「只翻文章開頭」兩個沒做完的行為。Bug 1:toast 仍顯示整頁段數(例如 25 / 227),沒對應實際翻譯量。Bug 2:rescan(延遲掃新段落)+ SPA observer(捲動偵測新內容)兩條動態翻譯路徑沒檢查 partialMode,使用者捲到下半頁時 Shinkansen 仍會偵測新段落並開始翻譯——這違反「節省費用」的初衷。修法:`translatePage` 在 prioritizeUnits + maxTotalUnits truncate 後,partialMode 啟用再次 truncate units 到 partialMode.maxUnits(讓 toast 顯示 25 / 25),同時設 `STATE.partialModeActive` 旗標;`rescanTick` + `content-spa.js spaObserverRescan` 兩條路徑開頭加 `if (STATE.partialModeActive) return`,啟用時完全跳過動態翻譯。`restorePage` 重設旗標。對使用者的視覺效果:勾選 toggle 後翻譯該頁,只看到「翻譯中... 25 / 25」+「已翻譯 25 段」,捲到下半頁譯文不會繼續延伸,完全符合「我只想看開頭」的意圖。

**v1.8.4** — 修 v1.8.3 設定頁整份 HTML 被重複黏接的 bug。`shinkansen/options/options.html` 從 991 行膨脹到 1980 行,在 line 991 出現畸形接縫 `</html>html lang="zh-Hant">`(第一份結尾的 `</html>` 直接拼上第二份開頭的 `html lang="zh-Hant">`,中間少了 `<`)→ 第二份完整 UI 跑出來變成「設定頁授權資訊段下方再出現一份完整的 Shinkansen 標題、Tab 列與所有分頁」,使用者誤以為打開兩份設定頁。猜想根因:v1.8.3 partialMode UI 改動時用 Python 腳本做兩次全形標點轉換,第二次跑時 anchor 字串已是全形版本,`s.find()` 回 -1,導致 `s = s[:-1] + new_block + s[j:]` 範圍計算錯誤。修法:用 head 前 990 行 + 補 `</html>` 重組正確 file。

**v1.8.3** — 新增「**只翻文章開頭(節省費用)**」選項。對 token 用量敏感、想先預覽再決定要不要看完整文章的使用者,可在 Gemini 分頁開啟 toggle:翻譯只跑 batch 0(經 prioritizeUnits 推前的內文核心 N 段),跳過 batch 1+,大幅減少 token 用量。預設關閉,可調段數範圍 5-50(預設 25)。**漸進式翻譯流程**:使用者開節省模式翻完開頭 → 想看完整翻譯時關閉 toggle 重新翻譯 → 前面已翻好的段落從本地快取自動命中(0 token 收費),只 batch 1+ 才打 API。技術上重用 v1.8.0 streaming + cache 路徑,但對使用者完全隱藏 streaming 概念。

  - **`lib/storage.js`**:`DEFAULT_SETTINGS.partialMode = { enabled: false, maxUnits: 25 }`,getSettings deep merge。
  - **`options/options.html` Gemini 分頁**:加 `partialModeEnabled` toggle + `partialModeMaxUnits` number input(min=5 max=50),說明文字明確標示「漸進式翻譯流程」與「重翻不會重複收費」。標點全形,結尾無句號(§13/§14)。
  - **`options/options.js`**:load/save/reset/sanitizeImport 四處接 partialMode。
  - **`content.js translateUnits`**:讀 partialMode → 啟用時 packBatches 第一批 limit 用 partialMode.maxUnits 取代 BATCH0_UNITS;主流程加 `skipBatch1Plus = partialMode.enabled` 旗標,streaming 路徑 + fallback 路徑都會在啟用時跳過 `runWithConcurrency(jobs.slice(1))`。BATCH0_CHARS=3700 仍用內部限制不暴露。
  - **新 regression**:`test/regression/translate-partial-mode.spec.js` 鎖「partialMode.enabled=true 時 batch 1+ 不被 dispatch + batch 0 size = partialMode.maxUnits」。SANITY 雙驗通過。

**v1.8.2** — YouTube ASR 字幕 overlay 黑底 padding 對齊原生。`.cue` padding 從 `0.15em 0.7em`(@ 18px font ≈ 上下 2.7px / 左右 12.6px)縮成 `0.05em 0.3em`(≈ 上下 0.9px / 左右 5.4px),左右黑底各省 7px。原本 ASR 字幕黑底比 YouTube 原生「一行字幕」黑底大很多(左右各多出近半字寬、上下也鬆),v1.8.2 後緊貼文字、視覺比例對齊原生字幕。純 CSS 微調,不影響翻譯邏輯或字幕分句行為。

**v1.8.1** — 修 v1.8.0 streaming 路徑漏寫 cache 的 bug。原本「翻譯 → 還原 → 重翻同一頁」應該秒載入(cache fast path),但 v1.8.0 的 streaming `handleTranslateStream` 沒做 cache lookup + write,每次重翻都要重打 Gemini API。修法:streaming 開頭先 `cache.getBatch()` 查 cache,若全部命中走 fast path 立即推 `STREAMING_FIRST_CHUNK + STREAMING_SEGMENT × N + STREAMING_DONE`(不打 API,usage = 0);若有 miss 才走 streaming,結束後 `cache.setBatch()` 寫回 cache。cache key suffix 跟 `handleTranslate` 一致(含 glossary / fixedGlossary / forbidden hash + model),確保「翻完還原重翻」必命中 fast path。實測 TWZ 同頁 Run 1 batch 0 streaming 等 6.5 秒,Run 2 cache fast path **9 毫秒完成、首字延遲 4ms**——「一閃就載入」效果回來了。Probe 工具加 `SKIP_CLEAR_CACHE=1` env var 用來驗證 cache hit 行為(原本 probe 每次跑都 CLEAR_CACHE,沒辦法測 cache hit fast path)。

**v1.8.0** — 文章翻譯 batch 0 改用 Gemini streaming + batch 1+ 在 first_chunk 抵達時同步並行 dispatch。**首字延遲從 v1.7.3 的 2.5-4.4 秒砍到 1.0-1.2 秒(平均 -66%)**——使用者按下翻譯後 1 秒內就看到頁面開頭變中文。同時 batch 0 size 從 10 unit / 1500 chars 擴大到 25 unit / 3700 chars(streaming 後 batch 0 size 不影響首字延遲),涵蓋的文章範圍從「開頭幾段」變成「整段內文前 25 段」。Scope 嚴格鎖在文章翻譯 batch 0 一個入口——字幕(`TRANSLATE_SUBTITLE_BATCH` / ASR)、術語表抽取(`EXTRACT_GLOSSARY`)、Google Translate、自訂模型路徑完全不動,維持既有 non-streaming 行為與容錯網。

  - **新增訊息協定**:`TRANSLATE_BATCH_STREAM`(content → SW)+ `STREAMING_FIRST_CHUNK` / `STREAMING_SEGMENT` / `STREAMING_DONE` / `STREAMING_ERROR` / `STREAMING_ABORTED`(SW → content)+ `STREAMING_ABORT`(content → SW)。每個 streaming 任務有獨立 `streamId`,SW 內 `inFlightStreams` Map 維護 streamId → AbortController 對映。
  - **`lib/gemini.js translateBatchStream`**:streamGenerateContent endpoint(`?alt=sse`)+ ReadableStream + incremental SSE parser。每收到完整 SHINKANSEN_SEP 就 emit 該段譯文,占位符 `⟦/N⟧` 切在 chunk 邊界時 parser 等到下一個 SEP 才 emit(占位符在段落內部,不會被截)。
  - **`background.js handleTranslateStream`**:fire-and-forget streaming task,結果透過 `tabs.sendMessage` 推回 sender tab。完整 usage accounting + addUsage(跟 non-streaming 一致)。
  - **`content.js runBatch0Streaming`**:onMessage listener 收 SW 推來的 streaming 訊息,first_chunk 抵達時 resolve promise 讓主流程同步 dispatch batch 1+,segment 抵達時立即 SK.injectTranslation。1.5 秒沒收 first_chunk → fallback 走 v1.7.x 序列 batch 0 + 並行路徑。中段失敗 → batch 0 整批用 non-streaming retry。
  - **abort 跨批傳播**:`signal.addEventListener('abort')` 在 streaming 進行中觸發 → 送 `STREAMING_ABORT` 給 SW + 解開 listener + 並行 batch 1+ 透過 runWithConcurrency signal 檢查中斷。
  - **新 regression**:5 條 unit spec(`test/unit/streaming-batch-incremental.spec.js`,incremental emit / SSE chunk split / 占位符 chunk split / hadMismatch / abort)+ 1 條 e2e spec(`test/regression/streaming-batch-0-first-chunk-triggers-parallel.spec.js`,first_chunk 觸發並行)+ 既有 `translate-priority-sort.spec.js` test #2 改鎖 streaming fallback 路徑。SANITY 雙驗通過。
  - **真實 5 URL 實測**(2026-04-28,Gemini 3 Flash):TWZ 4400ms → 1142ms(-74%)、Wikipedia Tea 4068ms → 1186ms(-71%)、GitHub 3125ms → 1071ms(-66%)、NPR 2561ms → 1052ms(-59%)、CSS-Tricks 2495ms → 1030ms(-59%)。完整實測資料見 `reports/streaming-implementation-2026-04-28.md`。
  - **設計 probe 報告**:實作前先寫 `tools/probe-streaming.js` + `tools/probe-streaming-concurrent.js` 驗證 4 個關鍵假設(Gemini Flash first-token-latency / batch 0 size 不影響首字 / 並行 batch 不拖慢 streaming / 整頁完成時間不延長),實測完才動 production code,符合硬規則 §11「以真實資料為基石」。詳見 `reports/streaming-probe-2026-04-28.md`。

## v1.7.x

**v1.7.3** — Glossary 阻塞門檻動態調整。`blockingThreshold` 預設從 5 提高到 10——中等長度頁面(6-10 批)從原本「先等術語表再翻」(blocking)改為「術語表跟翻譯並行」(fire-and-forget),省下 EXTRACT_GLOSSARY 1.5-7.4 秒的首字延遲;長頁(>10 批)仍 blocking 確保跨批次術語一致。新增使用者可調設定欄位「阻塞門檻(批次數)」於術語表分頁,範圍 0(永遠 fire-and-forget)~ 50(幾乎都 blocking,等同 v1.7.2 之前行為)。實測 5 個原本 blocking 的網站全部變 fire-and-forget,Verge 從 5.2s → 2.0s 省 3.2 秒(-61%),GitHub 從 4.2s → 1.5s 省 2.6 秒(-64%),NPR / CSS-Tricks / Smashing 各省 0.1-0.5 秒。Trade-off:fire-and-forget 路徑下 batch 0 翻的內容沒帶術語表,可能跟後段翻譯用詞略有不一致——對 H1 標題 / 文章開頭(prioritizeUnits 推前的內容)風險低,術語密度高的特殊情境使用者可調高門檻或設極大值關閉此優化。

  - **常數同步**:`lib/storage.js DEFAULT_SETTINGS.glossary.blockingThreshold = 10` + `content-ns.js SK.GLOSSARY_BLOCKING_THRESHOLD_DEFAULT = 10`(content script 端鏡像常數,storage 沒提供時的 fallback,必須跟 storage default 同步)。
  - **options 分頁新欄位**:術語表分頁加 `<input id="glossaryBlockingThreshold" type="number" min="0" max="50">`,load/save 用 `parseUserNum`(v1.6.19 helper,空字串 fallback 預設、合法數字含 0 保留)。
  - **import sanitize 放寬**:`>= 1` 改為 `>= 0`,讓「永遠 fire-and-forget」變成合法選項。

**v1.7.2** — 翻譯優先級三件套延續優化:**(A)batch 0 切小**——首字 batch 限制 10 unit / 1500 chars(原 20/3500),序列等 Gemini 的時間從平均 5.4s → 3.4s;**(B)Readability tier 0 細分**——`prioritizeUnits` 從 3 tier 升級成 4 tier,用 readability content score(文字長度 + 逗號數 + heading tag + 含 P 子孫,刻意不用 class/id 名稱啟發式)切「真內文」與「main 內的工具列」,徹底解決 GitHub repo / Wikipedia 等「`<main>` 包了 chrome」造成的 batch 0 排序失敗;**(C)glossary 模型獨立 + 預設 Flash Lite**——術語抽取改用 `gemini-3.1-flash-lite-preview`(可在設定頁 4 選 1 切換),比 Flash 快 18% + 便宜 5 倍,terms 品質接近。同一組 10 個 URL 重測,OFF 模式首字延遲平均 -29%(中位數 -36%、最佳 -43%),ON 模式平均 -26%(NPR 從 11.7s → 5.1s 省 6.6 秒)。

  - **batch 0 limit**:`content-ns.js SK.BATCH0_UNITS=10 / SK.BATCH0_CHARS=1500`,`packBatches` 加 `firstMaxUnits` / `firstMaxChars` 參數,jobs.length=0 時用第一批 limit,之後切回預設;`translateUnits` / `translateUnitsGoogle` 兩處呼叫傳 BATCH0_*。
  - **tier 0 細分**:`content-detect.js` 加 `readabilityScore(el)` helper(只用結構訊號,不引整套 `@mozilla/readability` 60KB bundle),`prioritizeUnits` 在 main/article 內依 score >= 5 切 tier 0a / 0b。實測 GitHub batch 0 從「Notifications / Fork / Star / Code / Issues」UI tab 變成「anthropics/anthropic-sdk-typescript / Folders and files / Documentation」README 內容;Wikipedia "Tea" batch 0 從「Article / Talk / Read / View source」工具列變成「H1 Tea / 內文 P 674 字 / 536 字 / 285 字」真文章內容。
  - **glossary 模型**:`storage.js DEFAULT_SETTINGS.glossary.model = 'gemini-3.1-flash-lite-preview'`,`lib/gemini.js extractGlossary` 優先讀 `glossaryConfig.model`(空字串 fallback 主翻譯 model),`background.js handleExtractGlossary` cost 計算用 `getPricingForModel(glossaryModel)` 不再硬綁主 settings.pricing;options 頁術語表分頁加 dropdown(Flash Lite / Flash / Pro / 與主翻譯相同 4 選 1)。
  - **新 regression**:`test/regression/translate-priority-tier-0-readability.spec.js` 鎖 tier 0 細分行為(SANITY 雙驗通過)。既有 11 條相關 spec 全綠。
  - **probe 工具改進**:`tools/probe-priority.js` 加 `SHINKANSEN_PROBE_PROFILE` env var——踩到 Chrome SW bytecode cache 的坑(同 PROFILE 路徑 + extension 程式碼變動時,SW 載入舊 cached 版),要求每次測試用全新時間戳路徑才能拿到真實新行為。
  - **完整實測資料**:見 `reports/priority-sort-probe-2026-04-28.md` 的 v1.7.2 章節(§8-§10)。

**v1.7.1** — 翻譯優先級排序 + batch 0 序列化。長網頁翻譯時使用者最先看到的譯文從「導覽列 / cookie 同意書 / TOC」變成「文章標題 + 第一段內文」。兩個改動互補:`SK.prioritizeUnits` 對 `collectParagraphs` 結果做 stable sort(tier 0 = `<main>` / `<article>` 後代;tier 1 = 長段落 + 連結密度 < 50%;tier 2 = 其他),把內文核心推到 array 前面;`translateUnits` / `translateUnitsGoogle` 改成「序列跑 batch 0,完成後才用 worker pool 並行 batch 1+」,確保最先注入 DOM 的批次必定是 array 開頭那批。

  - **`SK.prioritizeUnits`(新,`content-detect.js`)**:tier 函式只用語意訊號(HTML5 tag + ARIA role + 文字長度 + 連結密度),不綁站點 class / id,符合硬規則 §8 結構通則。stable sort(V8 Array.prototype.sort 自 2018 起為 stable)保留同 tier 內的 DOM 順序。注入用 element reference,不依賴 array index → 排序不影響注入位置。
  - **batch 0 序列(`content.js`)**:`runBatch` helper 抽出後,主流程改為 `await runBatch(jobs[0]); runWithConcurrency(jobs.slice(1), maxConcurrent, runBatch)`。延遲代價約 batch 0 的 API 耗時(Gemini Flash 冷啟動約 4-7 秒;暖 cache 後 2-4 秒);換來的好處是使用者最早看到的譯文是文章開頭,且 Gemini implicit cache 可在 batch 0 暖完後讓 batch 1+ 並行批吃 cache。
  - **新 regression**:`test/regression/translate-priority-sort.spec.js` 鎖兩件事——tier 0 排序到 array 前 + batch 0 序列 / batch 1+ 並行的時序行為。SANITY 雙驗(破壞排序 fail / 破壞序列 fail)。
  - **真實站點實測**(2026-04-28,10 個網頁,Gemini 3 Flash):排序機制 8/10 顯著改善(TWZ / Wikipedia / Cloudflare / Verge / Ars / NPR / Smashing / CSS-Tricks 都把 H1 / H2 / 文章內文推到 batch 0);2/10 無變化(HN 用 `<table>` 沒 `<main>`、GitHub 把 UI tab 也塞在 `<main>` 內,tier 0 太粗——這個 framework 限制留待未來細分);時序設計 10/10 全部驗證 batch 1-N 並行 dispatch(Δ < 2ms)。詳細實測資料見 `reports/priority-sort-probe-2026-04-28.md`。

**v1.7.0** — YouTube 自動產生字幕(ASR)整套生產級體驗 + 設定簡化。Highlights:**AI 智慧分句**——把整批 ASR 片段送 Gemini 依語意重新分句後翻譯,中文字幕從「破碎的詞」變「完整句子」;**混合模式預設**——預設分句先秒出,AI 分句結果回來後替換成更精緻版本;**字幕 overlay 整句穩定顯示**——完全旁路 YouTube 原生 caption-segment 一字一字跳的問題,控制列出現時自動上移避開進度條;**設定 UI 簡化**——三選一 radio → 單一「AI 分句模式」toggle(開啟=混合 / 關閉=原始分句);**popup 紅點 CSS bug 修**——`.update-dot[hidden]` 規則漏寫導致殘留紅點永遠顯示。

  - **AI 智慧分句**:`TRANSLATE_ASR_SUBTITLE_BATCH` 用 timestamp mode JSON,LLM 自由合句 + 時間戳對齊驗證。輸入 `[{s,e,t}]` → 輸出 `[{s,e,t}]`,合句後逐句翻譯,token 用量略高於原始分句但中文閱讀體驗大幅提升。
  - **設定簡化(`options.html` + `options.js`)**:`ytSubtitle.asrMode` 內部仍三值('heuristic' / 'llm' / 'progressive'),UI 只顯示一個 checkbox(開啟=progressive、關閉=heuristic)。預設 progressive。舊 'llm' 值 load 時自動 normalize 為 progressive。
  - **Popup → Option 改為單向 sync**:popup yt-subtitle-toggle 變動只發 SET_SUBTITLE 給當前 tab,**不**寫 storage,避免反向覆蓋 Option 全域設定。
  - **welcome notice 殘留清除**:`shouldShowWelcomeNotice(welcomeNotice, currentVersion)` helper,不同 minor 系列的歷史殘留 popup 開啟時自動清除。
  - **CSS specificity bug 雙修**:`.update-dot[hidden]` + `.row[hidden]` 補 `display: none !important`(原 `.update-dot { display: inline-block }` / `.row { display: flex }` 覆蓋了 user agent `[hidden]`)。
  - **CLAUDE.md §13 §14 新硬規則**:UI 中文標點全形 + 說明段落尾端不加句號,Python 批次轉換腳本附在規則內。

## v1.6.x

**v1.6.22** — 混合模式字幕「預設 / AI 分句疊來疊去 + 中段消失」雙修:`_upsertDisplayCue` 加 `replaceRange` 選項,LLM 路徑寫入時清除被覆蓋範圍內殘留的 heuristic cue + sort by startMs;清除上限改用 LLM 原始 `endMs`(非延長後 `adjustedEnd`),避免閱讀延長範圍誤清 LLM 沒涵蓋的中段 heuristic 接力 cue。新 2 條 regression spec(疊來疊去 + 不誤清 SANITY 雙驗證)。286 條 spec 全綠。

  - **`_upsertDisplayCue(opts.replaceRange)`(`content-youtube.js`)** — LLM 路徑(`_runAsrSubBatch`)呼叫時帶 `{ replaceRange: true }`,清除 startMs 落在 `(新 cue.startMs, llmEndMs)` 範圍內的舊 cue,避免 progressive 模式下 heuristic 中段 cue 殘留 → 視覺上預設分句 / AI 分句疊來疊去。
  - **`adjustedEnd` vs `llmEndMs` 區分** — `adjustedEnd` 是「閱讀時間補償」用於顯示 endMs;`llmEndMs` 是「LLM 認為涵蓋的範圍」用於 replaceRange。誤用 adjustedEnd 會清掉 LLM 沒 cover 的中段 heuristic,造成中段字幕消失。
  - **displayCues 排序** — `cues.sort((a, b) => a.startMs - b.startMs)`,確保 `_findActiveCue` 找 `nextStart` 順序正確。

**v1.6.21** — AI 分句字幕「消失太快」修正:LLM 給的 endMs 是「下一段 ASR startMs」(英文密度),中文閱讀速度比英文慢 → `_upsertDisplayCue` 自動延長 endMs 至少 `max(800ms, 中文字數 × 200ms)`,讓使用者讀得完;`_findActiveCue` 加 `effectiveEnd = min(cue.endMs, 下一個 cue.startMs)` clamp 邏輯,前一句不會視覺壓到後一句。新 1 條 regression spec(8 字中文延長到 1600ms + clamp 到下一句 startMs 雙驗證)。284 條 spec 全綠。

  - **`_upsertDisplayCue`(`content-youtube.js`)** — 寫 cue 時 `adjustedEnd = max(LLM endMs, startMs + max(800, 字數 × 200))`,實測校準參數(初版 250/1000 偏長 0.5s,改為 200/800)。
  - **`_findActiveCue`** — loop 內計算 `nextStart` 取「startMs 嚴格大於當前 cue 的下一個 cue」,`effectiveEnd = min(cue.endMs, nextStart)` 確保前一句延長後不會壓到後一句顯示。同 startMs(progressive 模式 LLM 覆蓋 heuristic)的情況不算下一句。

**v1.6.20** — YouTube 自動產生字幕(ASR)整套重做:overlay 顯示完全旁路原生 caption-segment 跳動 + 整句穩定顯示;三種分句模式(預設啟發式 / AI 自由分句 / 混合模式漸進覆蓋);譯文過長依標點動態斷行(2 行為主,maxLine 動態對應 video 寬);字體 / 顏色 / 透明度 / 字型動態同步原生英文字幕;勾「自動翻譯字幕」+ CC 未開時 forceSubtitleReload 主動開 CC;UI 用語「自動產生字幕分句模式」「預設分句 / AI 分句 / 混合模式」+ 中文標點全形修正。共新增 11 條 regression(9 條 ASR + 2 條 auto-CC)。280+ 條 spec 全綠。

  - **G 路徑(`content-youtube.js` overlay 架構)** — 注入 `<shinkansen-yt-overlay>` 到 `#movie_player`,Shadow DOM 隔離 CSS;`displayCues = [{startMs, endMs, sourceText, targetText}]`,video.timeupdate 驅動找 active cue,整句進整句出。原生 caption-window 由全域 CSS `visibility:hidden` 隱藏(保留 layout 才能讀 native font-size)。
  - **三種分句模式** — `ytSubtitle.asrMode = 'heuristic' | 'llm' | 'progressive'`,預設 `heuristic`。`heuristic` 走 client-side rule-based pipeline(split / merge / compact + 英文詞彙列表);`llm` 走 timestamp mode(`TRANSLATE_ASR_SUBTITLE_BATCH` JSON `[{s,e,t}]` 自由合句 + 時間戳邊界驗證);`progressive` heuristic 先 await 顯示後 LLM fire-and-forget 覆蓋。
  - **譯文 wrap** — `_wrapTargetText` 以動態 `_calcMaxLineChars()`(`videoWidth × 0.7 / (fontSize × 0.8)`,clamp [15, 35])為門檻,優先在標點後切;regex 用 unicode escape `,.:;!?，．：；！？、。` 確保字符集純淨。
  - **auto-CC** — `forceSubtitleReload` 在 CC `aria-pressed=false` 時主動 click + 設 `_autoCcToggled` 每 session 只自動開一次,尊重使用者後續手動關 CC 不再補開。

**v1.6.19** — Code review audit 後修 5 條穩健性 bug:YouTube 字幕並行批次容錯、跨 tab sticky race、設定頁 `||` 0 falsy、fragment 注入 anchor、Promise.race timer leak。272 條 spec 全綠。

  - **Bug B(中)— `content-youtube.js:564-585` translateWindowFrom 後續批次改 `Promise.allSettled`**:舊 `Promise.all` 任一批 reject 整個拒絕,外層 catch 跳過 `YT.batchApiMs = _batchApiMs` 同步 → debug 面板某些 batch 顯示「…」不會更新;失敗那批的字幕也不寫進 captionMap。改 allSettled 後失敗只 log 該批、其他批字幕仍正常寫回。abort 路徑也補同步 batchApiMs。
  - **Bug A(中)— `background.js:200-235` `hydrateStickyTabs` 用 promise lock**:舊版 `if (_stickyHydrated) return; _stickyHydrated = true;` 兩行同步沒問題,但接著 `await storage.session.get` 期間第二個 `tabs.onCreated` listener 進來時直接 return(_stickyHydrated=true),Map 還空 → `stickyTabs.get(openerId)` 拿不到 slot → 漏繼承 sticky。改用 `_stickyHydratingPromise` 共用 in-flight promise,所有並行 caller 等到 Map 真正填好。
  - **Bug C(低)— `options.js` 新增 `parseUserNum` helper,load/save/reset 三處 `\|\|` → `??`**:使用者設定頁輸入 `0`(safetyMargin / maxRetries / maxConcurrentBatches / maxUnitsPerBatch / maxCharsPerBatch / maxTranslateUnits)→ 舊版 `Number(v) \|\| default` 把 0 當 falsy 改回預設,使用者重開設定頁看到「我打的 0 怎麼變回 20」。新 `parseUserNum`:空字串/NaN 走 default,合法數字(含 0)保留。
  - **Bug D(低)— `content-inject.js:317-322` fragment anchor 加 `endNode.parentNode === el` guard**:舊 `endNode.nextSibling` 在 endNode 被 SPA framework reparent 後會指向別的 parent 內的 sibling,`el.insertBefore` 拋 `NotFoundError`。新版偵測 endNode 已不在 el → anchor=null → 安全 appendChild。
  - **Bug E(低)— `content.js:130-158` 新增 `sendMessageWithTimeout` helper**:舊 `Promise.race([sendMessage, setTimeout reject])` 在 sendMessage 先 settle 時不 clearTimeout,90s 後 timer 仍 fire。改 helper `.finally(() => clearTimeout(timer))`。兩處 call site(Gemini batch / Google Translate batch)都改用。
  - **新 regression spec(2 條,SANITY 已驗)**:
    - `youtube-batch-allsettled.spec.js`:mock 三批 sendMessage,batch 1 reject、其他成功,驗證 captionMap 仍含 batch 0+2 的 entries(≥9 條)、`YT.batchApiMs[2]` 已同步出去(>0)。SANITY:回退 Promise.all 後 batchApiMs[2]=undefined fail。
    - `inject-fragment-detached-endnode.spec.js`:fixture 內 `.lead-a/.lead-b/.trailing` 三 children,spec 把 `.lead-b` reparent 到 detached div(模擬 SPA reconcile),驗證 `injectTranslation` 不拋 NotFoundError。SANITY:回退 anchor guard 後 insertBefore NotFoundError fail。
  - **PENDING(3 條走路徑 B,理由各自寫)**:Bug A(時序窄窗難可控的 race)、Bug C(`parseUserNum` 沒 export)、Bug E(timer leak 屬實作細節 + 影響極低)。
  - **Code review audit 注記**:本版起點是「review 整個 codebase 找 bug」。4 個 audit agent 並行掃描 12K 行得 36 條候選,Claude Code 端逐條看 source 驗證後 31 條判定為**誤報**(如 `content-spa.js:166 setInterval 多重保護不存在`、`cache.js:39-46 flushTouches 競態` 等,實際 code 早已有對應防護或 agent 看錯行號)。Agent 推理常用「可能/若...就會」,沒看完整上下文就下判斷,符合 §11 「以真實資料為基石,不靠推理」的反例。確認的 5 條才動 code。
  - Full `npm test` 272 條(246 Playwright + 26 Jest)全綠。

**v1.6.18** — 自訂模型新增「思考強度」統一控制 + 進階 JSON 透傳,涵蓋 OpenRouter / DeepSeek / Claude / OpenAI o-series / Grok / Qwen 6 家 thinking schema。296 條 spec 全綠。

  - **使用者面向**:自訂模型分頁加「思考強度」dropdown(`自動 / 關閉 / 低 / 中 / 高`)。內部依 baseUrl + model 偵測 provider 自動翻譯成對應 API 寫法,使用者不必懂各家 thinking API 差異。同時加「進階」摺疊區,讓 power user 自填 JSON 直接 merge 進 chat.completions request body(可覆蓋自動 mapping、加 provider 專屬參數)。
  - **6 家 provider mapping(2026-04 校準,文件來源見下)**:
    - OpenRouter unified: `reasoning: { effort: low/medium/high, exclude: true }`(off → exclude=true)
    - DeepSeek native: `extra_body.thinking: { type: enabled/disabled }`
    - Claude (Anthropic): `thinking: { type: adaptive/disabled }`(高 → adaptive,低 → adaptive,off → disabled)
    - OpenAI o-series: `reasoning_effort: minimal/low/medium/high`(off → minimal,沒真 disable)
    - Grok (xAI): `reasoning_effort: low/medium/high`(off → 不送,因 grok 多數 model 不支援 disable)
    - Qwen: `extra_body.enable_thinking: true/false`
    - 不認識的 provider → 不送(走 provider 預設,避免送未知參數導致 4xx)
  - **新檔 `lib/openai-compat-thinking.js`**(150 行):export `detectProvider` / `buildNativeThinking` / `safeParseJson` / `deepMerge` / `buildThinkingPayload`。`safeParseJson` 對 user 進階 JSON 做容錯處理,格式錯誤時 debugLog 一條 warn 並回 `{}`(不阻斷翻譯)。
  - **新 unit spec** `test/unit/openai-compat-thinking-mapping.spec.js`(34 條):provider 偵測 11 條(baseUrl 優先 / model name fallback / unknown)+ buildNativeThinking 9 條(各 provider × level)+ safeParseJson 4 條(合法 / 空白 / 非 object / 格式錯)+ deepMerge 4 條(遞迴 / 覆蓋 / 陣列 / 型別衝突)+ buildThinkingPayload 整合 7 條(預設 / native / extraBody 覆蓋 / 加額外欄位 / auto / 解析失敗)。SANITY 已驗(把 OpenRouter 偵測破壞 → 5 條 fail,還原後全綠)。
  - **lib/openai-compat.js 整合**:translateChunk 加 import + 入口 `buildThinkingPayload({ baseUrl, model, level, extraBodyRaw, onWarn })`,結果 spread 進 chat.completions request body。既有 7 條 openai-compat-injection / 3 條 segment-mismatch / 5 條 usage spec 不受影響(只新增 body 欄位,不動既有路徑)。
  - **`DEFAULT_SETTINGS.customProvider` 加 2 欄**:`thinkingLevel: 'auto'`(預設不干涉)、`extraBodyJson: ''`(預設空白)。既有使用者升級 v1.6.18 後行為不變(auto 等同舊版完全不送 thinking 參數,讓 provider 自選預設)。
  - **不在本版做的事**:沒處理 Gemini 路徑(走 lib/gemini.js,v1.6.12 已有 pickThinkingConfig 獨立處理);Grok 自動偵測限制在 model name 含 grok(沒分 multi-agent vs reasoning model,因 baseUrl 區分不易)。
  - Full `npm test` 296 條(270 Playwright + 26 Jest) 全綠。

  **資料來源(thinking schema)**:
  - [OpenRouter Reasoning Tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
  - [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)
  - [Anthropic Claude Extended Thinking](https://platform.claude.com/docs/en/docs/build-with-claude/extended-thinking)
  - [OpenAI Reasoning Models Guide](https://developers.openai.com/api/docs/guides/reasoning)
  - [xAI Grok Reasoning](https://docs.x.ai/docs/guides/reasoning)
  - [Qwen Deep Thinking (Aliyun Model Studio)](https://help.aliyun.com/zh/model-studio/deep-thinking)

**v1.6.17** — 設定頁次按鈕(`.secondary`)CSS 對齊主按鈕(`.primary`)的高度與字級。262 條 spec 全綠。

  - **使用者面向**:設定頁的「儲存設定」(主按鈕)與「重設所有參數」(次按鈕)在 v1.6.16 之前因 padding / font-size / font-weight / border 累積差異,視覺高度差約 6px,看起來不像同一組按鈕。修法:`button.secondary` padding 從 `8px 16px` → `9px 20px`,font-size 從 `13px` → `14px`,讓兩按鈕高度貼齊;主按鈕仍因粗字 600 + 較大 padding(10px 24px)+ 無 border 視覺較突出,符合「主動作 vs 次動作」design pattern。
  - **影響範圍**:全 extension 的 `.secondary` 按鈕(共 16 處,15 處 options 分頁 + 1 處 popup「編輯譯文」)都會跟著對齊,提升整體視覺一致性。功能不受影響。
  - **未動其他 CSS**:`.btn-row` 對齊 / `.actions` flex container 等保持原樣。
  - Full `npm test` 262 條(236 Playwright + 26 Jest) 全綠。

**v1.6.16** — 移除「後備路徑單價」UI、reset 補清空計價覆蓋、自訂模型預填 OpenRouter DeepSeek V4 Pro。262 條 spec 全綠。

  - **使用者面向 1:後備路徑單價 UI 移除**:Gemini 分頁的「模型計價」section 下半「後備路徑單價」整段(input/output 兩個欄位 + 說明文字)移除。原因 v1.6.15 把全域 model dropdown 拿掉後,`settings.pricing` 唯一可達路徑(`background.js:610` fallback)在「preset cards 只能選 3 個合法 model」前提下永遠不可達。`settings.pricing` storage 欄位保留作 belt-and-suspenders;UI 入口完全消失。
  - **使用者面向 2:reset「重設所有參數」補清空 v1.6.14 的計價覆蓋表**:之前 reset 漏掉新加的 6 個 per-model override 欄位(Lite / Flash / Pro × input/output),按下 reset 後計價覆蓋值仍保留。修法:reset handler 加 6 個 input.value=''(預設 modelPricingOverrides:{} 對應 UI 全空 = 走內建表)。confirm 對話框文字同步更新,「計價」改成「模型計價覆蓋(清空走內建表)」明確告知行為。
  - **使用者面向 3:自訂模型預填 OpenRouter DeepSeek V4 Pro**:`DEFAULT_SETTINGS.customProvider` 的 baseUrl/model/inputPerMTok/outputPerMTok 從空字串/0 改為 OpenRouter DeepSeek V4 Pro 的官方資料(來源 https://openrouter.ai/deepseek/deepseek-v4-pro,2026-04 校準)。新使用者打開自訂模型分頁立刻看到所有欄位預填,只剩 API Key 要填即可啟動。既有使用者若 storage 內已有 customProvider entry(打開過分頁),新預設不會自動覆蓋(getSettings 對 customProvider 走淺 merge,saved 在後);要套用走「回復預設設定」清掉 storage.sync 後重新 load 即可看到 DeepSeek 預填。
  - **連帶清理**:options.js 移除 `inputPerMTok` event listener(全域成本估算 listener 陣列)、`updateYtPromptCostHint` 的 `mainInput` fallback 改用內建表 `MODEL_PRICING[mainModel]?.input ?? 0`(避免讀已不存在的 element 拋錯)。
  - **完整 reset audit**:逐欄 audit DEFAULT_SETTINGS 與 load() 對映,確認所有預設值都正確載入(0 個漏洞,5 個設計如此的 nuance:apiKey 在 storage.local 故意保留 / model + pricing UI 移除但走 sync.clear 路徑仍能 reset / popup 管的 autoTranslate+displayMode+disableUpdateNotice 不在 options 頁 UI 但 sync.clear 仍清 / fixedGlossary 預設空白 / glossary 隱藏欄位透過 save 從 storage 拉空 fallback DEFAULT)。
  - Full `npm test` 262 條(236 Playwright + 26 Jest) 全綠。

**v1.6.15** — 移除 Gemini 分頁的「Gemini 模型與參數(後備路徑)」section,Service Tier 搬到「LLM 參數微調」section。262 條 spec 全綠。

  - **使用者面向**:Gemini 分頁原本最上方的「Gemini 模型與參數(後備路徑)」整個 section 移除。Service Tier 搬到「LLM 參數微調」section 內(放在 Temperature 之上)。原因:v1.4.12 起 preset modelOverride 機制涵蓋翻譯流程 95%+ 場景,v1.6.13 補完自動翻譯白名單路徑後,**全域 model dropdown 真正活著的後備路徑剩下兩個**:
    - 「測試 API Key」按鈕用此 model 驗證 key
    - cache key 構建(每批翻譯帶當前 model 進 cache key,但永遠是 modelOverride 後的值,不是全域 dropdown 的值)
    既然 95%+ 場景沒走到全域 dropdown,且使用者多次回報「兩個 Gemini 模型設定」混淆,直接移除是最乾淨方案。
  - **「測試 API Key」按鈕改用主要預設(slot 2)的 model**:`getSelectedModel()` 改讀 `preset-engine-2 / preset-model-2`(若主要預設引擎不是 gemini → fallback `DEFAULTS.geminiConfig.model`)。
  - **storage 不踩 migration**:`settings.geminiConfig.model` 欄位**保留**(只是 UI 不再顯示),既有使用者升級無感;save() 時從 `browser.storage.sync.get('geminiConfig')` 拉現存值寫回,保留結構。
  - **連帶清理**:移除 `applyModelPricing` 函式 + `SERVICE_TIER_MULTIPLIER` 常數(原本是 model dropdown 切換時自動帶價的便利功能,UI 移除後沒觸發點;v1.6.14 已加 per-model override 表取代「自動帶價」的 UX);移除 `toggleCustomModelInput` + `.custom-model-row` CSS(自行輸入欄位隨 dropdown 一起移除);Gemini 重設按鈕的 confirm 文字同步更新欄位清單。
  - **不在本版做的事**:`extractGlossary` 與 `translateChunk` 仍從 `settings.geminiConfig.model` destructure(實際拿到的永遠是 modelOverride 後的值,handleTranslate 入口都帶 modelOverride);沒拆出 model 欄位;`background.js:35` rate limiter init log 仍 log 全域 model(預設值,僅供 debug)。完全清理掉 `geminiConfig.model` 結構需要 storage migration,風險不對等收益。
  - Full `npm test` 262 條(236 Playwright + 26 Jest) 全綠。

**v1.6.14** — 翻譯預設改名「主要預設 / 預設 2 / 預設 3」+ 模型計價支援使用者覆蓋(防 Google 改價)。262 條 spec 全綠。

  - **使用者面向 1:翻譯預設改名**:設定頁三張卡片標題從「預設 1 / 預設 2 / 預設 3」改成「**預設 2 / 主要預設 / 預設 3**」(原預設 2 是日常最常用,改名為「主要預設」突顯;原預設 1 順延編號為「預設 2」;預設 3 維持)。
    - slot 2 卡片視覺強化:藍色邊框 + 淡藍底 + 標題加深加大。
    - 「工具列『翻譯本頁』按鈕」與「自動翻譯網站使用的預設」兩個 dropdown 文字同步:「主要預設 / 預設 2 / 預設 3」。
    - manifest commands description 同步:Alt+S 描述為「翻譯主要預設」。
    - **內部 storage slot 編號 1/2/3 維持不變**(沒有 migration 風險),只動 UI 標籤。
  - **使用者面向 2:per-model 計價覆蓋**:Google 改價時內建表(`lib/model-pricing.js`)會過時。原本只有後備路徑能填單價,preset 路徑硬走內建查表。Gemini 分頁的「模型計價」section 重新設計:
    - 上半新增 per-model 覆蓋表(Lite / Flash / Pro 三組),每組顯示「內建 $X / $Y」+ 兩個 input(input/output 單價);填了就用,空白 fallback 內建。
    - 加 `LAST_CALIBRATED_DATE = '2026-04'` 常數,UI 顯示「**(2026-04 校準)**」提示使用者內建表可能過時。
    - 下半保留原「後備路徑單價」(只在後備路徑實際被觸發時用)。
    - storage 加 `modelPricingOverrides: {}`(預設空物件,使用者沒覆蓋就 fallback 內建)。
  - **getPricingForModel 簽名變更**:加 `settings` 參數,優先順序「override → 內建表 → null」。`background.js` line 607 呼叫處同步帶 settings。
  - **新 unit spec** `test/unit/model-pricing-override.spec.js`(8 條):override 優先 / 字串 coerce / 非合法數字 fallback 內建 / 其他 model 不受影響 / 內建表 fallback / 未知 model null / 空值 null / LAST_CALIBRATED_DATE 格式驗證。SANITY 已驗。
  - **不踩 storage migration**:既有使用者升級 v1.6.14,`modelPricingOverrides` 預設空物件,行為跟之前完全等價(內建表查價);改名只動 UI 標籤,內部 slot 編號 / `popupButtonSlot` / `autoTranslateSlot` / preset 卡片 storage 結構全部不變。
  - Full `npm test` 262 條(236 Playwright + 26 Jest) 全綠。

**v1.6.13** — 解 Gemini 模型設定混淆:自動翻譯白名單改走 preset slot + Gemini 分頁的「全域模型 + 計價」section 重新標示為「後備路徑專用」。254 條 spec 全綠。

  - **使用者回報的 UX 混淆**:快速鍵預設卡片可選 Gemini 模型,Gemini 分頁底下也有一個「Gemini 模型」全域下拉。使用者改 preset 模型後到 Gemini 分頁看到另一個 model 設定不知道兩者怎麼互動,實際生效規則是「preset 有設就覆蓋全域,沒設 fallback 全域」(`background.js#TRANSLATE_BATCH#modelOverride`)。但 v1.4.12 起所有快速鍵 + popup 按鈕都帶 modelOverride,**全域 model 在 95% 場景沒被用到**,卻佔據 Gemini 分頁最顯眼位置。
  - **修法 1:加 `autoTranslateSlot` 設定**(白名單觸發改走 preset slot):
    - `lib/storage.js#DEFAULT_SETTINGS.autoTranslateSlot = 2`(預設 Flash,與 v1.6.12 之前的全域 fallback 等價)
    - `lib/storage.js#pickAutoTranslateSlot(raw)` helper(同 `pickPopupSlot` 對稱設計,範圍外 fallback 2)
    - `content.js` 首次載入 + `content-spa.js` SPA 導航兩處的 autoTranslate 觸發路徑改成 `SK.handleTranslatePreset(slot)` 取代裸 `SK.translatePage()`,白名單翻譯與 Alt+S 行為對齊(走 preset.model 的 modelOverride)。
    - 設定頁「網域規則」section 加「自動翻譯使用的預設」dropdown,與「工具列『翻譯本頁』按鈕」section 設計對稱。
  - **修法 2:Gemini 分頁標題重新框定**:
    - 「Gemini 模型與參數」→ 「**Gemini 模型與參數(後備路徑)**」+ section 開頭 muted 說明「日常翻譯由翻譯快速鍵的 preset 自選模型決定,此處只在(1)上方『測試 API Key』按鈕(2)極少數沒走 preset 的後備路徑時生效」
    - 「模型計價」→ 「**模型計價(後備路徑)**」+ 說明「preset 翻譯的計價自動從內建表查,此處單價只在後備模型實際被觸發時用」
  - **新 unit spec** `test/unit/auto-translate-slot.spec.js`(4 條):合法 1/2/3 / 字串 coerce / undefined fallback / 範圍外 fallback。SANITY 已驗(把 fallback 從 2 改 1 → 2 條 fail)。
  - **未動 storage migration**:既有使用者的 `geminiConfig.model` 仍保留(僅後備路徑使用,不會壞掉);新使用者升級 v1.6.13 後白名單會自動走 slot 2,行為等價於升級前。
  - Full `npm test` 254 條(228 Playwright + 26 Jest) 全綠。

**v1.6.12** — 修 Pro 模型翻譯失敗(`Budget 0 is invalid. This model only works in thinking mode`)+ 整體升級到 Gemini 3 推薦的 `thinkingLevel` API。250 條 spec 全綠。

  - **使用者回報的 bug**:設定頁切到 Pro 模型(如 `gemini-3-pro-preview` / `gemini-2.5-pro`)後翻譯失敗,toast 顯示「翻譯部分失敗:50/50 段失敗」加 API 錯誤訊息「Budget 0 is invalid. This model only works in thinking mode」。
  - **根因(用 `tools/probe-gemini-pro.js` 真實 API 驗證後確認)**:`lib/gemini.js` 主翻譯與術語表兩處 generationConfig 寫死 `thinkingConfig: { thinkingBudget: 0 }`,Gemini Pro 系列 API 強制 thinking-only(`Pro 模型必須思考`),不允許 budget=0。從 Gemini 2.5 起此限制就存在,Gemini 3 加碼推薦改用 `thinkingLevel` 取代 `thinkingBudget`(後者標記 not recommended)。
  - **修法**:新增 `pickThinkingConfig(model)` helper(export 出來方便 unit spec 測試),依模型名選 thinking level:
    - 含 `pro` (case-insensitive) → `{ thinkingLevel: 'low' }`(probe 實測 'minimal' 在 Gemini 3 Pro 被拒,最低支援 'low')
    - 其他(Flash / Flash Lite) → `{ thinkingLevel: 'minimal' }`(thoughts=0 等同舊 budget=0,不額外計費)
    `extractGlossary` 與 `translateChunk` 兩處改呼 `pickThinkingConfig(model)`。
  - **新 unit spec** `test/unit/gemini-thinking-config.spec.js`(5 條):Pro 對映 'low' / Flash 對映 'minimal' / case-insensitive / 空值 fallback / 不送舊 thinkingBudget 欄位。SANITY 已驗(把 fix 改回「Pro 也回 minimal」→ 2 條 Pro spec fail)。
  - **既有 spec 同步更新**:`glossary-json-parsing.spec.js` 與 `segment-mismatch-fallback.spec.js` 內鎖死舊 `{ thinkingBudget: 0 }` 的 3 條 assertion 改成 `{ thinkingLevel: 'minimal' }`(test settings 用的是 `gemini-2.5-flash`,對映 minimal)。
  - **Pro 模型成本警示**:Pro 強制 thinking 即使 'low' 也會花 ~240 thoughts token / request,翻譯本來就不需要深度推理,Pro 對翻譯品質提升微乎其微但成本可能比 Flash 貴 10 倍以上。設定頁尚未加成本警告(範圍外,先解 bug),建議使用者用 Pro 之前先看用量紀錄分頁觀察費用。
  - Full `npm test` 250 條(224 Playwright + 26 Jest) 全綠。

**v1.6.11** — 用量紀錄分頁加「重新載入」按鈕 + 新增 standalone debug harness 工具(內部開發用,不影響使用者)。

  - **使用者面向:用量紀錄「重新載入」按鈕**:設定頁「用量紀錄」分頁底部操作列加 `<button id="usage-reload">重新載入</button>`,放在「匯出 CSV」前。使用者回報:translatePage 寫入新紀錄後,設定頁停留在用量分頁不會自動刷新,Cmd+R 也會回到預設分頁。新按鈕呼叫既有的 `loadUsageData()`(會保留當前的篩選狀態:日期範圍 / 搜尋字串 / 模型 filter / 日週月粒度),只重抓底層資料 + 重渲染。`title` attribute 提示「不需關閉設定頁」。
  - **內部 dev tooling:`tools/debug-harness.js`**:standalone Node script(不在 extension 內,不影響使用者),Claude Code 用來在真實站點上自驗修改後的 extension 行為。流程:`launchPersistentContext` 自動載 extension → navigate 到目標 URL → 透過 Debug Bridge `TRANSLATE` 觸發翻譯 → 輪詢 `GET_STATE` 等狀態 idle → dump DOM 翻譯狀態 + warn/error log → 截圖到 `.playwright-mcp/`。用法:`npm run debug` 或 `TARGET_URL=https://... node tools/debug-harness.js`。支援 `--keep`(留 browser)/`--no-translate`(免 API key)/`--fresh`(砍 user data dir)/`SHINKANSEN_HEADED=1`(顯示視窗)旗標。CDP `Runtime.evaluate` 走 isolated world `contextId`,可直接呼叫 Debug Bridge CustomEvent(與 `test/regression/helpers/run-inject.js` 同套機制)。
  - **CLAUDE.md 更新**:除錯手段優先序從「Playwright fixture / Chrome MCP / 真實頁面人眼」三段改為「fixture / debug-harness / Chrome MCP / 真實頁面人眼」四段,新加「自動化除錯(真實站點 probe)」說明 + 「修偵測類 bug 的硬規則:先 probe 真實站點再改 code」工作流(對應歷史教訓 Wikipedia ambox v0.51-v0.54 三輪修復)。
  - **`.gitignore` 加 `.playwright-mcp/`(harness 截圖輸出) + `tools/probe-*.js`(一次性 probe 腳本)**:probe 腳本是「跑真實站點驗假設」的拋棄式工具,用完即刪不進版控。
  - **不需 regression spec**:harness 是 dev tooling 不影響 extension 行為;按鈕純 UI 補漏(click → 既有函式),既有 245 條 spec 已涵蓋 loadUsageData 路徑。
  - Full `npm test` 245 條(219 Playwright + 26 Jest) 全綠。

**v1.6.10** — 分頁隱藏時暫停 Content Guard 與 SPA URL 輪詢(背景分頁能源優化)。245 條 spec 全綠(219 Playwright + 26 Jest,含 1 條新加 regression spec)。

  - **Content Guard `document.hidden` gate**：原本 `runContentGuard` 由 `setInterval(1000ms)` 觸發,只要 STATE.translated=true 就永遠在跑。每次 sweep 都遍歷 `STATE.translatedHTML` Map(可能上百 entry),每 entry 呼叫 `getBoundingClientRect` 強制 layout reflow。即使分頁切到背景使用者根本看不到,也照樣每秒 force layout 一次,純消耗 CPU + 電力(尤其 macOS 筆電 / iPad 等需要省電的裝置)。新加 `if (document.hidden) return;` early-return,分頁隱藏時跳過。切回前景時下一次 sweep 在 1 秒內修復,使用者無感差異。
  - **SPA URL 輪詢 `document.hidden` gate**：原本 `setInterval(500ms)` 比對 `location.href !== spaLastUrl`,2 次/秒永遠在跑。背景分頁不會由使用者觸發導航,輪詢只是 pushState patch 沒套到的 safety net,在隱藏分頁完全無作用。新加同樣 `if (document.hidden) return;`,切回前景時 visibilitychange listener 補一次 catch-up。
  - **新 regression spec** `test/regression/guard-hidden-tab-gate.spec.js`(1 條,SANITY 已驗):透過 `Object.defineProperty(document, 'hidden', ...)` 模擬分頁隱藏,呼叫新增的 `_testRunContentGuardProd` debug hook(production 路徑,所有 gate 啟用),驗證 hidden=true 時不修復、切回 visible 後修復。
  - **不在本版做的事**:MutationObserver 沒加 hidden gate(SPA 框架在背景時可能加新內容,切回前景時需要立即翻譯,跳過 mutation 風險過大)。`spaObserverDebounceTimer` 也保持原樣。後續若觀察到背景分頁的 mutation 量大且確認可安全跳過再評估。
  - **不影響的場景**:分頁可見時行為完全不變;`testRunContentGuard`(test API,繞過 viewport gate)也繞過 hidden gate,既有 spec 不受影響。

**v1.6.9** — 段落偵測效能優化（針對長頁如 Wikipedia / 論壇 / 長 Medium）。`collectParagraphs` 三項內部優化,行為等價,244 條 spec（218 Playwright + 26 Jest）全綠。

  - **`innerText` → `textContent`**（5 處）：`isCandidateText` / leaf anchor 補抓 / leaf div/span 補抓 / grid cell 補抓（4 處呼叫）。`innerText` 每次呼叫都觸發 layout reflow（瀏覽器需重算整頁版面後才回字串）,在長頁面上動輒被叫上千次,是偵測階段最大瓶頸。`textContent` 純讀 DOM 字串樹不 force layout,對長度判斷 / 語言偵測場景語意等價。`isInteractiveWidgetContainer` 刻意保留 innerText（>=300 字判定該函式語意要求「使用者實際看得到的字數」,改成 textContent 會讓含隱藏 modal/menu 字的 Twitter / Gmail widget 漏過篩選被誤翻）。
  - **leaf div/span 收緊 selector 為 `:not(:has(*))`**：原本 `document.querySelectorAll('div, span')` 在長頁可能回傳數萬個 element,後續 JS forEach 才用 `d.children.length > 0` 過濾掉非葉節點。改成讓原生 CSS engine 直接過濾「無 element 子節點」的 div/span,實測長頁從幾萬 element 降至數百個,後續 isVisible / textContent / isCandidateText 等檢查減少 95% 以上呼叫。`:has()` Chrome 105+ / Firefox 121+ / Safari 15.4+ 都已 stable 多年,Manifest V3 環境零相容性風險。
  - **`isInsideExcludedContainer` 加 per-call memo**：偵測階段反覆問「這個元素是否在被排除的容器內」（FOOTER/role=banner/contenteditable/譯文 wrapper 等）,每次都要從 el 走到 body,長頁同一條祖先鏈會被走數百次。新加 `Map<el, bool>` cache,任何後代命中已算過的祖先即 O(1) 短路。memo 為純函式緩存（單次 collectParagraphs 期間 DOM 不變動）,語意完全等價。
  - **行為等價驗證**:65 條相關 spec（27 detect / 38 inject+guard+spa+iframe+restore+sticky）+ full suite 244 條全綠。
 新增「顯示翻譯進度通知」master switch（一般設定分頁），可完全關閉 toast。

  - **使用者回報**：原本 toast 透明度最低只能設到 10%，沒有「完全關閉」選項；雖然視覺上看不見，但 DOM、Shadow root、訊息與計時器都還在跑。
  - **新設定**：一般設定 →「翻譯進度通知」section 最上方加 checkbox「顯示翻譯進度通知」（預設 ON 維持現行為），關閉後 `SK.showToast()` 入口直接 return（不渲染 DOM、不發訊息）；切換時即時生效（`onChanged` listener 同步狀態並隱藏目前 toast）。
  - **新 helper** `SK.shouldShowToast()`（與 `SK.shouldDisableInFrame` 同 pattern）：暴露 master switch 查詢給呼叫端與 regression spec 共用。
  - **新 regression spec** `test/regression/toast-master-switch.spec.js`：驗證 `SK.shouldShowToast()` 跟著 `storage.showProgressToast` 變化（預設 true / set false 同步 / set true 恢復）。SANITY 已驗（query 函式改成永遠 true → 第 2 步 fail）。

**v1.6.7** — 自訂模型支援本機後端（llama.cpp / Ollama 等）：API Key 允許留空。

  - **修使用者回報的 bug**：自訂模型分頁的「測試」按鈕在 API Key 為空時硬擋報錯（`✗ API Key 為空。`），導致 llama.cpp 等不需要 key 的本機後端使用者無法測試也無法翻譯。
  - **三處同步移除 / 條件化**：(1) `background.js#testCustomProvider` 拿掉「API Key 為空」前置 guard；(2) `background.js#handleTranslateCustom` 拿掉 `cp.apiKey` 必填 throw；(3) `lib/openai-compat.js#translateChunk` 拿掉同樣 throw、且 fetch headers 在 apiKey 為空時不送 `Authorization`（OpenAI 相容規範允許省略）。商用後端（OpenAI / OpenRouter / DeepSeek 等）漏填 key 時自然回 401，錯誤訊息由 provider 提供（例如「Incorrect API key」），對使用者也很清楚。
  - **UI 提示更新**：自訂模型分頁的 API Key 欄位 placeholder 與下方說明文字加上「本機 llama.cpp / Ollama 等可留空」。
  - **新 unit spec 兩條**：apiKey 為空 → 不 throw 且 headers 不含 Authorization；apiKey undefined（settings 沒這欄位）→ 同上。SANITY 已驗（headers 改回硬送 → 兩條 fail）。

**v1.6.6** — 新增「工具列『翻譯本頁』按鈕」可指定對應的翻譯預設。

  - **新設定**：一般設定分頁多一個 section「工具列『翻譯本頁』按鈕」，dropdown 三選項顯示各 preset 的 label（例如「預設 1：Flash Lite / 預設 2：Flash / 預設 3：Google MT」），預設仍為 slot 2（與 v1.4.12 起的 popup 硬碼行為一致），現有使用者升級不會感受到任何行為差異。
  - **改 popup.js**：「翻譯本頁」按鈕改送 `TRANSLATE_PRESET { slot: settings.popupButtonSlot }` 取代既有硬碼 `TOGGLE_TRANSLATE`；content.js 的 `TOGGLE_TRANSLATE` handler 仍保留作 backward-compat 路徑。
  - **新 helper** `lib/storage.js#pickPopupSlot`：共用 slot 解析（合法 1/2/3 原樣回 / 其餘 fallback 2），popup.js 與 unit spec 共用同一段邏輯。
  - **新 unit spec** `test/unit/popup-button-slot.spec.js`（4 條）：合法 / 字串 coerce / undefined fallback / 範圍外 fallback。SANITY 已驗（fallback 改 1 → 2 條 fail）。

**v1.6.5** — 新增 CWS 自動更新後的「歡迎升級」提示（popup banner + 翻譯成功 toast 兩處）；同時修三個更新提示機制的潛在 bug。

  - **新功能：CWS 自動更新後的歡迎提示**：使用者透過 Chrome Web Store 自動升級到 major/minor 新版時，下次開 popup 會看到綠色「🎉 已升級至 vX.Y」banner + 三條近期重大更新 bullet + 「知道了」按鈕（永久 dismiss）；翻譯成功 toast 也順帶顯示一次「已升級至 vX.Y — 點工具列圖示看新功能」（每日節流）。Patch 級自動更新（1.6.4 → 1.6.5）跳過避免高頻打擾。
  - **新模組** `lib/release-highlights.js`：近期重大更新文字單一來源，下次新功能升級時改一處同步生效。
  - **新模組** `lib/welcome-notice.js`：封裝 onInstalled handler 內的判斷邏輯（reason='update' + previousVersion + isWorthNotifying）方便 unit 測試。
  - **release.sh 加 minor/major bump 提醒**：偵測到 major 或 minor 不同時印警告 + 暫停等使用者按 Enter 繼續或 Ctrl+C 中止，提醒檢查 RELEASE_HIGHLIGHTS 是否要更新（純內部升級可用通用條目「改善效能與穩定性」之類）。
  - **修法：時區造成跨日重複顯示**：`new Date().toISOString().slice(0, 10)` 取的是 **UTC 日期**，台灣（UTC+8）使用者凌晨 0–8 點仍是 UTC 昨天，導致「今日已 dismiss」誤判為「跨日要重新顯示」（剛點過幾小時又看到）。新加 `localTodayKey()` helper 統一用本地時區，content-ns.js 鏡像一份（content script 不能 import lib），涵蓋 4 處（markUpdateNoticeShown / shouldShowTodayNotice / WELCOME_NOTICE_TOAST_SHOWN handler / maybeBuildXxxNotice）。
  - **修法：banner 顯示前缺二次過濾**：popup / options banner 顯示條件原本只看「storage 內 updateAvailable 物件存在」，沒檢查 storage 內版本是否真的 > 當前版本。導致 storage 殘留 stale 資料時 banner 仍錯誤顯示「v1.6.4 可下載 你目前是 v1.6.4」這種詭異訊息。修法：三處（popup / options / content-ns）顯示前都加 `isWorthNotifying(storage.version, current)` 二次過濾。
  - **修法（最關鍵）：CSS `display: flex` 覆寫 hidden attribute**：`.update-banner / .welcome-banner / .update-banner-row` 三處都寫 `display: flex`，class selector specificity 高於 user-agent stylesheet 的 `[hidden] { display: none }`，導致 hidden=true 仍顯示空殼 banner。從 v1.6.1 update banner 上線就潛在存在的 bug，但之前一直在測「storage 有資料」場景所以 JS 主動設 hidden=false 顯示，沒被觀察到。修法：三處 CSS 各加 `[hidden] { display: none !important }` 強制覆寫。
  - **belt-and-suspenders 多層防禦**：(1) update-check 寫 storage 前 isWorthNotifying；(2) 偵測到 latest === current 主動清 storage；(3) 三層 UI 顯示前再 isWorthNotifying 過濾；(4) dismissed=true / disableUpdateNotice=true 永久關閉；(5) lastNoticeShownDate 每日節流（本地時區）。
  - **新加 spec**：`test/unit/welcome-notice.spec.js`（9 條：major/minor 寫入、patch/install/browser_update/降版/缺 prev 不寫、RELEASE_HIGHLIGHTS 結構驗證）；`update-check.spec.js` 補 1 條 `localTodayKey` 用本地時區驗證。
  - Full `npm test` 211 條（Playwright）+ 26 條（Jest）全綠。

**v1.6.4** — 修 popup / 設定頁 update banner 點擊行為（彻底擺脫 a-tag navigate 的怪 bug）+ 加 patch 級更新節流避免高頻打擾。版號跳過 1.6.3（用作測試假 release）。

  - **修法 1：兩處 banner 從 `<a>` 改 `<button>`**：v1.6.1 ~ v1.6.2 期間 popup banner 點擊跳到 popup.html#、設定頁 banner 點擊跳到 options.html# 自身的 bug，根因是 `<a target="_blank" href="#">` 在 chrome popup 環境下不會開新分頁、會 navigate 到 href 自身。改成 `<button type="button">` 徹底擺脫 a-tag 預設 navigate。
  - **修法 2：用 document-level event delegation**：banner click handler 不再依賴 init() async timing 一次性掛上，改在檔案頂層註冊一次 document.addEventListener('click', ...)，handler 內臨時 await storage 拿 release URL，避免任何 race condition。
  - **修法 3：三層 fallback URL**：popup / options / toast 三處 click 邏輯都改成 `storage.releaseUrl > /tag/v${version} > /releases 索引頁` 三層 fallback——即使 storage 內缺 releaseUrl 或損壞（早期 race 寫入問題），使用者點 banner 仍會跳到合理頁面。content-ns.js 的 `maybeBuildUpdateNotice()` 也加同樣 fallback。
  - **新行為：patch 級更新不提示**（`isWorthNotifying` 函式）：頻繁 patch 提示會讓使用者疲勞、忽略真正重要的版本。新規則只對 major / minor 升級提示——例如 1.6.4 → 1.6.5 不提示、1.6.4 → 1.7.0 / 2.0.0 才提示。`checkForUpdate()` 改用 `isWorthNotifying` 判斷是否寫 storage / 觸發提示。
  - **新增 spec**：`isWorthNotifying` 三段式邏輯（major/minor 升提示、patch 升不提示、相同/舊版不提示）；既有 `checkForUpdate` test fixture 從 patch diff（1.6.0→1.6.1）改為 minor diff（1.6.0→1.7.0），同時新加「latest 只是 patch 升 → 不寫 storage」對照組。
  - **跳號 v1.6.3**：v1.6.3 tag 用於測試 update notice 流程的假 release，code 沒實際 bump 到 1.6.3，本版直接跳到 v1.6.4。
  - Full `npm test` 201 條（Playwright）+ 26 條（Jest）全綠。

**v1.6.2** — 修 v1.6.1 設定頁更新 banner 點擊跳到自身 settings 頁的 bug。

  - **根因**：v1.6.1 的設定頁 banner HTML 結構是 `<a target="_blank"><strong>...</strong><span>...</span><button>不再提示</button></a>`——把 `<button>` 巢嵌在 `<a>` 裡是 invalid HTML，Chrome 解析後行為錯亂，點 banner 主體沒開新分頁、反而被當成 navigate 到 `href="#"`（即當前 settings 頁）。
  - **修法**：拆成 `div` wrapper + 內部 `<a>` + 並列 `<button>` 結構（HTML valid），對應 CSS 改成 `.update-banner-row` flex container + `.update-banner-link` 主體；options.js 的 `hidden` 切換管 wrapper 而非 `<a>`。
  - **popup banner 不受影響**：popup 的 banner 沒嵌 button（只有 strong + span），是合法 HTML，不用動。
  - Full `npm test` 199 條（Playwright）+ 26 條（Jest）全綠。

**v1.6.1** — 新增 GitHub Releases 自動更新提示，解決手動安裝（unpacked / GitHub）使用者不知道有新版可下載的問題。

  - **新模組 `lib/update-check.js`**：透過 GitHub Releases API（`https://api.github.com/repos/jimmysu0309/shinkansen/releases/latest`）拿最新 `tag_name`，與 `manifest.version` 三段式比對；只對 `installType === 'development'` / `'sideload'` 觸發（CWS 安裝跳過避免與原生自動更新撞車）。
  - **三層觸發**確保使用快速鍵不開 popup 的使用者也看得到提示：(1) SW 第一次喚醒 fire-and-forget；(2) `chrome.runtime.onStartup`（Chrome 啟動時）；(3) `chrome.alarms 'update-check'` 24h 定時備援（Chrome 一直開著的 case）。GitHub API 未驗證 60 req/hr/IP 上限離爆量很遠。
  - **三層 UI 提示**（同樣為了確保不會錯過）：
    - **翻譯成功 toast**：detail 下方加黃底 callout「📦 vX.Y.Z 可下載 — 點此前往」+ 「×」按鈕，**每日節流**（同日翻譯多次只第一次顯示），點連結或「×」都標記今日已顯示
    - **Popup**：標題後紅點 + 黃底 banner 顯示「v1.6.1（你目前是 v1.6.0）」
    - **設定頁「一般設定」分頁頂部** banner + 「不再提示」按鈕（寫入 `disableUpdateNotice: true` 永久關閉）
  - **storage 結構**：`chrome.storage.local.updateAvailable: { version, releaseUrl, checkedAt, lastNoticeShownDate }`；`DEFAULT_SETTINGS.disableUpdateNotice: false`（toggle 走 sync 跨裝置同步）。失敗（network / 4xx / non-JSON）不清舊紀錄，避免 stale flap；版本一致時主動清掉 storage 避免殘留。
  - **新 message handler**：`UPDATE_NOTICE_DISMISSED`（toast 內互動觸發 `markUpdateNoticeShown` 寫今日日期）。
  - **manifest 加 `alarms` permission**（24h 定時用）；`chrome.management.getSelf()` 不需 permission 故未加 `management`，避免 CWS 審核疑慮。
  - **12 條新 unit spec** `test/unit/update-check.spec.js`：parseVersion / isNewer 三段式比對、checkForUpdate 五個情境（latest > / === / < current、CWS 跳過、network error 不清 stale、保留 lastNoticeShownDate）、shouldShowTodayNotice / markUpdateNoticeShown 節流邏輯。SANITY 驗破壞 isNewer 與 isManualInstall 各別 fail。
  - Full `npm test` 199 條（Playwright）+ 26 條（Jest）全綠。

**v1.6.0** — v1.5.7 之後一系列 UX 打磨與多項調整累積到 1.6.0 minor bump。

  - **YouTube 字幕分頁版面重組**：tab 移到「一般設定」右邊（最常用功能優先）；section 順序改為「自動翻譯 → 翻譯引擎 → Gemini 設定（合併原翻譯模型 + Temperature） → 進階：固定術語表 & 禁用詞清單 → 翻譯視窗設定 → 字幕翻譯 Prompt」。「Gemini 設定」與「字幕翻譯 Prompt」兩個 wrapper 依引擎條件顯示——選 Google Translate 全隱藏、選自訂模型只剩 Prompt（共用「自訂模型」分頁的 baseUrl/model/key）。
  - **YouTube 字幕新加自訂模型引擎**：「翻譯引擎」下拉從「Gemini / Google MT」擴成三選項（加「自訂模型」）。字幕路徑與文章翻譯共用 `customProvider` baseUrl/model/apiKey/計價，但 prompt 字幕專屬（`ytSubtitle.systemPrompt` 走 cpOverrides 覆蓋）；cache key 用 `_oc_yt` 命名空間。
  - **字幕路徑省 token toggle**：YouTube 字幕分頁新增「字幕也套用『固定術語表』/『禁用詞清單』」兩個 toggle（預設關），含動態成本估算（依目前模型與計價算「打開後一支 30 分鐘影片約多花多少」）。字幕本來就走獨立 prompt 設計，且字幕短句 LLM 不太會誤翻黑名單詞，預設關省下高頻字幕場景的累積 token 開銷。
  - **Bug 修正：preset 自訂模型引擎被強制重置**：`save()` 端 whitelist 只認 `'google'/'gemini'`，使用者選「自訂模型」儲存後被強制改回 `'gemini'`——意即 v1.5.7 上線後使用者的自訂模型 preset 從未真正生效。修法：擴 whitelist 為三選項，model 欄只對 gemini 有意義。
  - **「重設所有參數」按鈕**：Gemini 分頁底部「儲存設定」旁加，confirm 對話框防誤觸；不直接寫 storage，要使用者按「儲存設定」才生效。
  - **「重置為預設 Prompt」按鈕**：自訂模型分頁加，把翻譯 Prompt 重設為與 Gemini 同款 `DEFAULT_SYSTEM_PROMPT`。
  - **每批段數上限預設 12 → 20**：減少高頻 API call、提升整體翻譯效率。
  - **用量紀錄時間 filter 改 24 小時制**：放棄 `<input type="datetime-local">`（Chrome 對它的時間制完全跟 OS locale 走、HTML 無法 override），改成「`<input type="date">` + 兩個 `<select>` (HH 00–23 / MM 00–59)」拆三段，24h 制完全由 select option 控制；新加「現在時間」按鈕一鍵把「到」設為當下時間。
  - **用量紀錄版面對齊**：所有 widget 統一 `height: 32px` + 同 border / radius / padding；日週月按鈕從第一列搬到第二列與搜尋框並排；模型篩選 select 收斂為固定 200px 寬不再被內容撐爆觸發 wrap；「現在時間」貼第一列右側、「全部模型」貼第二列右側形成兩端勻稱。
  - **Debug log 新增 prompt 注入計數**：`api: gemini request` / `api: openai-compat request` 加 `glossaryCount` / `fixedGlossaryCount` / `forbiddenTermsCount` 三欄，使用者從 Debug 分頁直接看出本批 prompt 末端注入了幾條（驗證 YouTube 字幕的兩個 toggle 是否生效、文章翻譯有沒有讀到設定）。
  - **禁用詞清單 UI**：備註欄加 `title` attribute（hover 顯示原生 tooltip 看完整內容）+ focus 時 input 浮起放寬（CSS `position:absolute` lift），編輯時看得到完整文字。
  - **設定頁文字調整一輪**：所有 muted 說明段落結尾句號移除（14 處）；自訂模型分頁多處用詞統一（OpenAI 相容、模型計價、翻譯 Prompt、移除過時引導文字）；landing page 用詞統一；DEFAULT_FORBIDDEN_TERMS 對照表標題從「中國大陸用語」改為「中國用語」（與全域用語規範對齊）。
  - **Landing page 加「近期重大更新」section**：列出雙語對照模式 / 中國用語黑名單 / 自訂 AI 模型三條近期亮點。
  - Full `npm test` 187 條（Playwright）+ 26 條（Jest）全綠。

## v1.5.x

**v1.5.7** — 新增自訂 OpenAI 相容模型功能 + 用量紀錄多項改進 + WordPress 含 hero 圖標題的偵測/注入修法 + 設定頁版面對齊與多處文字調整。

  - **新功能：自訂 OpenAI 相容模型**：除了 Gemini 與 Google Translate，可設定一組 OpenAI-compatible 端點（chat.completions），接 OpenRouter / Together / DeepSeek / Groq / Fireworks / Ollama 本機 / OpenAI 自家等百種 provider。`translatePresets` 任一 slot 的 `engine` 設成 `'openai-compat'` 即可由對應快速鍵啟動。設定頁新增獨立「自訂模型」分頁（Gemini 右側）。API Key 走 `chrome.storage.local`（與 Gemini Key 同樣不跨裝置同步）。Bearer auth、自動接 `/chat/completions` 尾綴、429/5xx 退避重試、segment mismatch fallback、usage 結構抽取（含 `prompt_tokens_details.cached_tokens`）全部對齊 Gemini adapter。Cache key 加 `_oc_g<gh>_b<bh>_m<urlHash6>_<safeModel>` 避免不同 provider 同 model name 污染快取。
  - **共用模組 `lib/system-instruction.js`**：把 `DELIMITER` / `packChunks` / `buildEffectiveSystemInstruction` 從 `lib/gemini.js` 抽出，Gemini 與自訂模型兩條 adapter 共用——固定術語表 + 中國用語黑名單 + 多段分隔符 / 段內換行 / 佔位符規則只實作一次，未來新規則只改一處。
  - **API Key「測試」按鈕**（Gemini + 自訂模型）：Gemini 走 `GET models/<model>?key=<key>` 不耗 token；自訂模型走 `POST /chat/completions` + `max_tokens:1` 耗 ~1 token。結果以綠/紅訊息列顯示在按鈕下方。
  - **修法：WordPress 含 hero 圖標題沒翻**（`mediaCardSkip` + `injectIntoTarget` 兩處）：nippper.com 等 WordPress 主題把 hero 封面圖塞進 `<h1>` 內 → `<h1><img wp-post-image><div><span>標題</span></div></h1>`。原本兩條判斷都誤殺：(1) `mediaCardSkip` 命中 → 整個 H1 `FILTER_SKIP` 從未進翻譯流程；(2) 即使進了，`injectIntoTarget` 因 `hasContainerChild=true` 走 clean-slate 把 IMG 一起清掉。修法：兩處都加 `!/^H[1-6]$/.test(el.tagName)` 例外（HTML5 語意上 heading 永遠是「標題」、不可能是 grid item / 附件清單，屬結構性通則 §8）。新 fixture `heading-with-hero-image.html` + spec 兩條斷言（detect + inject 各一），SANITY 兩條都驗過。
  - **修法：「進程→線程」既有對映**（v1.5.6 已修一半，v1.5.7 補完）：v0.83 起 `DEFAULT_SYSTEM_PROMPT` 的對映清單把兩個簡中詞「進程→線程」放一起（process 在台灣應為「行程」、thread 應為「執行緒」）。v1.5.6 已從 prompt 移除並補進中國用語黑名單，本版未再動相關邏輯。
  - **用量紀錄改進**：
    - 「模型」欄改用 preset 標籤顯示（不再顯示 model id 縮寫），同時涵蓋彙總卡片「最常用模型」與篩選下拉
    - **Bug 修正**：`LOG_USAGE` payload 之前缺 `model` / `engine`，導致按 Alt+A（Flash Lite）和 Alt+S（Flash）寫進紀錄的 model 一樣；修法：`content.js` 把 `options.engine` / `options.modelOverride` 帶進 payload，`background.js` LOG_USAGE handler 依 `engine` 路由 model 來源（`'openai-compat'` 用 `customProvider.model`、其他用 `payload.model || geminiConfig.model`）
    - **Bug 修正**：preset.engine 儲存後被強制 reset：`save()` 端 whitelist 只認 `'google'/'gemini'`，`'openai-compat'` 被改回 `'gemini'` 寫進 storage——換言之，過去使用者設定的「自訂模型」preset 從未真正生效。修法：擴 whitelist 為三選項，model 欄只對 gemini 有意義
    - **Google MT 同篇 URL 批次合併**：新加 `usageDB.upsertGoogleUsage`，3 分鐘視窗合併同 URL 的多批 Google MT entry（避免 BBC 長文炸出十幾筆同 URL 紀錄）
    - 用量明細「TOKENS」欄 Google MT 顯示從「3,403 字元」改為「3403」、「費用」欄「$0（免費）」改為「$0」
  - **用量紀錄時間 filter UI**：
    - **24 小時制**：放棄 `<input type="datetime-local">`（Chrome 對它的時間制完全跟 OS locale 走、HTML 無法 override），改成「`<input type="date">` + 兩個 `<select>` (HH 00–23 / MM 00–59)」拆三段，24h 制完全由 select option 控制
    - 新加「現在時間」按鈕一鍵把「到」設為當下時間
    - 整列版面對齊：所有 widget 統一 `height: 32px` + 同 border / radius / padding；「現在時間」貼右、日週月按鈕貼第二列左邊與搜尋框同 x 起點；模型篩選 select 收斂為固定 200px 寬不再被內容撐爆觸發 wrap
  - **Log 系統強化**：
    - `api: gemini request` / `api: gemini response` log 加 `inputPreview` / `outputPreview`（前 300 字），「LLM echo 原文」「譯文被截斷」「譯文跟期望不一樣」這類 case 都能直接從 Debug 分頁對照看到送進去 / 回什麼出來。`openai-compat` 兩條 log 同步加
    - Debug 分頁搜尋命中 `data` 欄位時自動展開該行 detail，且命中字串包 `<mark>` 高亮
    - 搜尋 input placeholder 改為「搜尋 Log（含批次內容）⋯」讓使用者知道功能涵蓋每筆 data
  - **設定頁多項文字 / 版面調整**：
    - 「自訂 Provider」tab 改名「自訂模型」、移到 Gemini 右側
    - 「自訂 OpenAI-compatible Provider」改「自訂 OpenAI 相容模型」
    - 翻譯快速鍵預設 engine 下拉「自訂 Provider（OpenAI-compatible）」改「自訂模型」（三組 preset 一致）
    - 「System Prompt」改「翻譯 Prompt」
    - 「計價（USD / 1M tokens）」改「模型計價（USD）」
    - 計價說明文字「OpenRouter / Together 等百種模型不可能內建查表」改「請填入 input / output 單價」
    - 「Input/Output tokens 單價」加「（USD / 1M tokens）」尾綴
    - 自訂模型分頁說明文字優化（「OpenAI-compatible 端點」→「OpenAI 相容端點」、「翻譯快速鍵」section 引導文字精簡）
    - **預設值改進**：`DEFAULT_SETTINGS.customProvider.systemPrompt` 從空字串改為與 Gemini 同 `DEFAULT_SYSTEM_PROMPT`，全新使用者第一次打開分頁就有完整可用 prompt
  - **3 條新 unit spec + 1 條新 regression spec + SANITY 全綠**：
    - `openai-compat-injection`（7 條，黑名單/固定術語表共用注入、systemPrompt 獨立、apiKey 缺失 throw、baseUrl 接尾綴、Bearer auth、message 結構）
    - `openai-compat-usage`（5 條，prompt_tokens_details.cached_tokens 抽取、fallback 空 usage 不噴 NaN、多 chunk 累加）
    - `openai-compat-segment-mismatch`（3 條，多段不對齊觸發 per-segment fallback、單段不觸發、對齊不觸發）
    - `detect-heading-with-hero-image`（2 條，detect 不被 mediaCardSkip 攔 + inject 後 IMG 保留）
  - Full `npm test` 187 條（Playwright）+ 26 條（Jest）全綠。

**v1.5.6** — 新增中國用語黑名單功能 + 修正 v0.83 起 prompt 內錯誤的「進程→線程」對映。

  - **新功能：中國用語黑名單**：可由使用者編輯的禁用詞對照表（預設 25 條：視頻 / 軟件 / 數據 / 網絡 / 質量 / 用戶 / 默認 / 創建 / 實現 / 運行 / 發布 / 屏幕 / 界面 / 文檔 / 操作系統 / 進程 / 線程 / 程序 等）。內容會以 `<forbidden_terms_blacklist>` XML 區塊注入到 systemInstruction 末端（高於 fixedGlossary 的最高顯著性位置），明確要求譯文不可使用左欄詞彙、必須改用右欄。設定頁新增獨立的「禁用詞清單」分頁可編輯。
  - **修正 prompt 錯字**：v0.83 起 `DEFAULT_SYSTEM_PROMPT` 的 `<linguistic_guidelines>` 第 2 條對映清單中誤寫「進程→線程」——兩者都是中國大陸用語（process 在台灣應為「行程」、thread 應為「執行緒」），原本等於要求 LLM 把 process 翻成另一個簡中詞 thread。新版分開列出兩條正確對映進黑名單，並把 `<linguistic_guidelines>` 第 2 條改寫為指向末端黑名單區塊（避免兩處規則打架）。
  - **Debug 偵測層**：`lib/forbidden-terms.js` 的 `detectForbiddenTermLeaks()` 在每次翻譯回應後掃描譯文，命中黑名單詞時用 `debugLog('warn', 'forbidden-term-leak', ...)` 寫一筆診斷訊息（含原文與譯文 snippet），方便從 Debug 分頁追查 LLM 漏網案例。**純記錄、不修改譯文**（遵守 CLAUDE.md 硬規則 §7）。
  - **快取分區**：`lib/cache.js` 新增 `hashForbiddenTerms()` 對清單做穩定 hash（依 `forbidden` 欄位排序後 JSON.stringify 取前 12 字元 SHA-1），加進 cache key 後綴 `_b<hash>`。修改清單後既有快取自動失效；空清單時不附加後綴，向下相容 v1.5.5 之前的快取。`getBatch` / `setBatch` 同步擴充支援結構化 `{ glossaryHash, forbiddenHash, baseSuffix }` 物件 API（向下相容字串 API）。
  - **3 條新 unit spec + SANITY 全綠**：`forbidden-terms-injection`（4 條）/ `forbidden-terms-leak-detect`（5 條）/ `forbidden-terms-cache-key`（8 條），總 17 條。每條都驗過「破壞 fix → spec fail / 還原 → pass」。
  - **UI**：「禁用詞清單」拆成獨立分頁（位於「術語表」與「YouTube 字幕」之間），三欄表格（禁用詞 / 替換詞 / 備註）+ 新增 / 還原預設 / 刪除按鈕。tab-bar CSS 加 `white-space: nowrap` + `flex-shrink: 0` 防止 7 個 tab 後文字折行。
  - Full `npm test` 166 條（Playwright）+ 26 條（Jest）全綠。

**v1.5.5** — 修「編輯譯文」功能與 Content Guard 衝突。

  - **Bug**：popup 按「編輯譯文」進入編輯模式後，刪除 + 輸入單字會在 1 秒內被自動還原回原譯文；按「結束編輯」按鈕後，使用者編輯也會被蓋回原譯文。
  - **根因**：Content Guard 每秒 sweep 比對 `STATE.translatedHTML` 快取與元素 innerHTML，不符就強制覆蓋（用來修 SPA framework 重 render 時把譯文蓋掉）。但這條邏輯沒考慮編輯模式——使用者改 innerHTML 是預期行為，不是框架覆寫。
  - **修法**（兩處同步）：
    - `content-spa.js` `runContentGuard` / `SK.testRunContentGuard`：迭代 `STATE.translatedHTML` 時，若 `el.getAttribute('contenteditable') === 'true'` 就 `continue`（編輯中跳過）。
    - `content.js` `toggleEditMode(false)`：結束編輯時把每個元素當前 `innerHTML` 寫回 `STATE.translatedHTML`，當作新 baseline（contenteditable 已移除，但快取裡是使用者編輯後的版本，guard 比對相符不會修復）。
  - **新 regression spec** `test/regression/guard-edit-mode-skip.spec.js` 鎖死兩個情境（編輯中 + 結束編輯）。新 fixture `edit-mode-guard-skip.html` + `.response.txt`。
  - **landing page 下載 URL 改帶版本號**：`releases/latest/download/shinkansen.zip` → `releases/download/v1.5.5/shinkansen-v1.5.5.zip`，使用者下載下來檔名能看出版本。CLAUDE.md §1 版本 bump 同步清單加第 8 條。
  - Full `npm test` 149 全綠（148 + 新加 guard-edit-mode-skip）。

**v1.5.4** — Cross-browser 預備工程 + UI 微調，無新功能、無 bug fix。所有改動對 Chrome 端 0 影響（148 條 spec 全綠）。

  - **Landing Page 功能特色重排**：移除「漸進式翻譯」，加入「雙語對照」並排為第二位（第一位仍為「保留網頁排版」）。
  - **設定頁底部 footer**：加入彩蛋文字「No coding skills were harmed in the making of this shit.」（11px、淡灰、置中、斜體、上下 24/32px margin）。
  - **Firefox / Safari prep（為未來移植做最小準備）**：
    - `manifest.json` 加 `browser_specific_settings.gecko.id`（Chrome 完全忽略未知 manifest 欄位）。
    - `background.js` `_stickyStorage` helper：`storage.session` 在 Firefox <129 / Safari <16.4 不存在 → 自動 fallback `storage.local`。Chrome 端 storage.session 一直存在，行為跟修改前完全一致。
    - `content.js` Debug Bridge 從 `callback` 風格統一改為 `Promise` 風格——Firefox / Safari 全版本只認 Promise 而 callback 會壞；Chrome 兩種寫法走同一條 native code path 0 影響。
    - `options.js` 平台偵測改用 `runtime.getURL('')` prefix（`chrome-extension://` / `moz-extension://` / `safari-web-extension://`）精確區分三平台，比舊版 `globalThis.chrome` 偵測更可靠。Firefox 點「快捷鍵設定」連結會跳 about:addons，Safari 隱藏連結。
  - **新文件 `FIREFOX_AND_SAFARI_PORT.md`**：記錄已完成 prep + 剩餘 prep checklist + Firefox AMO / Safari Mac App Store 上架步驟。未來真要 port 時當 checklist 直接照做。
  - **不在本版做的事**：service_worker 改成 scripts（雙 manifest 結構，工程大）、ES module → bundler、AMO 帳號註冊、Apple Developer Program 註冊、改 README / Landing 加 Firefox / Safari 連結（沒目的地不加）。詳見 `FIREFOX_AND_SAFARI_PORT.md`。

  Full `npm test` 148 全綠（無新 spec，靠既有 sticky-cross-tab / preset-hotkey / debug-bridge 系列驗 Chrome 行為等價）。

**v1.5.3** — 雙語對照模式三項小修。

  1. **wrapper 未繼承原段落水平 layout**：Jimmy 在 macstories.net Newsletter（https://www.macstories.net/club/macstories-weekly-issue-510/）觀察到原 `<p>` 有 `margin-left` 把段落擠到頁面中段，但譯文 wrapper 從左邊拉滿整行，視覺不對齊。根因：v1.5.2 typography copy 只搬字型相關 6 屬性（font-family/size/weight/line-height/letter-spacing/color），layout 屬性沒搬。修法（`content-inject.js` `injectDual`）：建立 wrapper 後從 originalEl computed style 抓水平 layout 屬性 inline 寫到 wrapper：`marginLeft / marginRight / paddingLeft / paddingRight / maxWidth`。**不**動垂直方向（保留 wrapper 自有的 `margin-top: 0.25em` 段間距與不固定 width）。新增 `inject-dual-horizontal-layout.spec.js`。

  2. **restorePage 漏清 attribute → 第二次翻譯只看到原文**：Jimmy 觀察「Opt+A 翻譯（雙語）→ Opt+A 還原 → Opt+A 再翻譯」第三次只看到原文不會進入雙語對照。根因：`restorePage` 的 dual 分支手寫 `querySelectorAll(tag).forEach(n => n.remove())` 只刪 wrapper，**沒清**原段落上的 `data-shinkansen-dual-source` attribute。第二次 `translatePage` → `injectDual` 入口 `if (original.hasAttribute('data-shinkansen-dual-source')) return;` 命中所有段落 → 全部早期 return → 沒注入。`testRestoreDual` debug API（呼叫 `SK.removeDualWrappers`，正確清 attribute）跟 `restorePage` 邏輯不一致，所以既有 `inject-dual-restore.spec.js` 用 testRestoreDual 過了但沒覆蓋到實際 bug。修法（`content.js`）：dual 分支改呼叫 `SK.removeDualWrappers()`，邏輯與 testRestoreDual 統一；新加 `testRestorePage` debug API 暴露真正的 restorePage 給 spec 測。新增 `restore-page-clears-dual-attr.spec.js`（驗：注入 → restorePage → attribute 清空 → 第二次注入應成功）。

  3. **`dashed` mark 改為波浪底線**：原本「虛線底線」（`border-bottom: 1px dashed`）視覺問題：(a) block 的 border-bottom 只在最後一行出現，看起來像「結束分隔線」而不是「整段標記」；(b) 跟連結直線底線易混淆。改為**波浪底線**：`text-decoration: underline wavy #C7CDD3; text-decoration-thickness: 1px; text-underline-offset: 4px;`——每行字底下都有，跟連結直線視覺區分。`mark` value 仍叫 `dashed` 不改名（避免破 storage migration），只改視覺實作 + UI label（options.html「虛線底線」→「波浪底線」、options.css 預覽 demo 同步、storage.js 註解）。`inject-dual-mark-style.spec.js` 斷言從 `borderBottomStyle === 'dashed'` 改為 `textDecorationStyle === 'wavy'`。

  Full `npm test` 146 → 148 全綠（含 2 條新 spec + mark-style spec 斷言更新）。

**v1.5.2** — 修正 v1.5.0 雙語對照模式四個獨立問題（全部由 Jimmy 在 https://www.bbc.com/news/articles/clyepyy82kxo 觀察到），並改善測試環境效能。

  1. **譯文 typography 不繼承**：`<shinkansen-translation>` wrapper 在 block 段落情況走 `insertAdjacentElement('afterend')` 插在原段落「後面」當 sibling，wrapper 內的 inner 不在原 `<p>` 裡——無法繼承 BBC 等網站設在 `p` selector 上的 `font-family / font-size / font-weight / line-height / letter-spacing / color`，視覺上譯文字距 / 行距比原段落緊。修法（`content-inject.js` `buildDualInner`）：所有 dual 注入路徑的 inner 在 build 時用 `getComputedStyle(originalEl)` 抓 6 個 typography 屬性，inline 寫到 inner 上。新增 `inject-dual-typography.spec.js`。

  2. **SPA 替換 inline 段落造成重複注入**：BBC News 等 React 站點初次注入後可能把 inline 段落（如 byline `<span>`）整顆 cloneNode 替換掉，新 element 沒繼承 `data-shinkansen-dual-source` attribute（attribute 在「舊 element」上、舊 element 已不在 DOM），但「舊 wrapper」仍在 DOM（wrapper 是上層 block-ancestor 的 sibling，不會被 inline element 替換連帶刪除）。第二次 `injectDual` 對「新 element」沒有去重保護，又注入第二個 wrapper。修法（`content-inject.js` 加 `findExistingWrapperAtInsertionPoint`）：注入前檢查「預期插入位置」是否已有譯文相符的 wrapper——有則 skip 並把 cache key 從舊 element 換到新 element，讓 Content Guard 後續用新 element 追蹤。新增 `inject-dual-spa-rebuild.spec.js`。

  3. **detector 把譯文回頭當英文段落抓（真正根因）**：BBC byline 譯文「《Inside Health》主持人，BBC Radio 4」CJK 字元佔比 < 50%（人名 / 節目名保留英文），`SK.isTraditionalChinese` 回 false → `isCandidateText` 把譯文當「新英文段落」回傳。SPA observer 觸發 `translateUnits + injectDual` 又疊一個 wrapper；每次 BBC 頁面自然 mutation 觸發 observer，wrapper 再疊一層，視覺呈現「慢慢長出第二、第三個」相同譯文。修法兩條防線：(a) `SHINKANSEN-TRANSLATION` 加進 `SK.HARD_EXCLUDE_TAGS`（content-ns.js），TreeWalker `acceptNode` 整段 reject；(b) `isInsideExcludedContainer`（content-detect.js）祖先檢查也包含 `SHINKANSEN-TRANSLATION`，攔住三條 querySelectorAll 補抓路徑（leaf content div/span、anchor、grid td）繞過 TreeWalker 的 case。新增 `detect-skip-translation-wrapper.spec.js`（fixture 用真實 BBC 中英混排譯文）。

  4. **第三方 iframe 內的圖表不被翻**：Jimmy 觀察 BBC 文章內嵌的 Flourish 資料視覺化（`https://flo.uri.sh/visualisation/...`）整段英文沒被翻。根因：`manifest.json` `content_scripts` 沒設 `all_frames: true`，content script 只在主 frame 載入。修法：(a) manifest 開 `all_frames: true`；(b) content-ns.js 加 pure function `_sk_shouldDisableInFrame(isFrame, width, height, visible)`——iframe 內尺寸 < 200×100 或不可見就設 `SK.disabled = true`，過濾 0×0 廣告 / reCAPTCHA / cookie consent / Cxense / DoubleClick 等技術性 iframe；(c) 7 個 IIFE 模組（content-toast/detect/serialize/inject/spa/youtube + content.js）開頭加 `if (!SK || SK.disabled) return;` 防護。新增 `iframe-gate.spec.js`（pure function unit test 風格驗 8 種輸入）。

  **測試環境改善**：`test/fixtures/extension.js` 改用 Chrome 原生 `--headless=new` 模式（v113+ 支援 MV3 service worker），不再彈視窗搶 focus。full `npm test` 從 ~20 分鐘縮到 ~2 分鐘。可用 `SHINKANSEN_HEADED=1` 環境變數切回 headed 做視覺除錯。

  **CLAUDE.md §9 改寫**：full suite 從「每次修改都跑」降級為「release gate」——日常迭代只跑相關 spec，bump 才走 full suite。

  Full `npm test` 142 → 146 Playwright + 26 Jest 全綠（含 4 條新 spec）。

**v1.5.1** — 修正 v1.5.0 雙語對照模式在 BBC author byline 一類頁面譯文連續疊三個 wrapper 的問題（Jimmy 在 https://www.bbc.com/news/articles/clyepyy82kxo 觀察到「BBC Radio 4 《Inside Health》節目主持人」連續三行譯文疊在淡黃 wrapper 內）。根因：`collectParagraphs` 在這類網站抓到祖先 element + 後代 element 都當成段落單元（祖孫同段重複偵測）。單語模式下後一次 `injectIntoTarget` 會 in-place 覆蓋前一次所以使用者看不到，雙語模式下每次 `SK.injectDual` 都 `insertAdjacentElement('afterend')` 一個 wrapper，所以重複偵測被視覺放大成多重 wrapper。

  修法（`content-inject.js` `SK.injectDual` 入口加去重）：注入前檢查祖先鏈與後代是否已有 `data-shinkansen-dual-source` 標記——若祖先已注入過（本元素是後代）或後代已注入過（本元素是祖先），直接 return skip，不重複插 wrapper。`data-shinkansen-dual-source` 既保留了「同 element 不重打」的 v1.5.0 防線，也成為「同段內容（不論祖孫）只插一個」的標記。

  根因仍在偵測層的祖孫同段重複（後續視真實樣本決定是否動 `collectParagraphs`），但 dual 路徑必須先有這層防護不要把 detector bug 放大成可見的視覺爆炸——同樣的問題在單語模式下其實一直存在，只是 in-place 覆蓋掩蓋了它。

  新增 regression spec `test/regression/inject-dual-overlap-skip.spec.js`（合成 fixture：外層 div + 內層 p 含同段文字；3 子斷言：(a) 先 inject outer 再 inject inner → wrapper 仍只有 1 個 + inner 不被打 dual-source；(b) 反向順序先 inject inner 再 outer → 同樣 wrapper=1 + outer 不被打 dual-source）。SANITY：把祖先鏈 while 與後代 querySelector 同時 short-circuit 後 wrapperCount 從 1 變 2、spec fail；還原後 pass。Full `npm test` 141 → 142 Playwright + 26 Jest 全綠。

**v1.5.0** — 新增**雙語對照模式**（dual mode）。長期一直只有單語覆蓋（譯文原地取代原文），使用者反映想看英文寫作的同時對照中文，本版正式加入第二種顯示模式：原文保留、譯文以 `<shinkansen-translation>` custom element wrapper 形式 append 在原段落之後/內。Popup 新增「顯示模式」toggle 即時切換 single / dual，設定頁新增「雙語對照視覺標記」section（4 種樣式 + 即時預覽 demo）。實作範圍：

  - `shinkansen/content-ns.js`：STATE 加 `displayMode` / `translatedMode` / `translationCache: Map<originalEl, { wrapper, insertMode }>`；常數 `TRANSLATION_WRAPPER_TAG` / `DEFAULT_MARK_STYLE` / `VALID_MARK_STYLES` / `VALID_DISPLAY_MODES` / `BLOCK_DISPLAY_VALUES`。
  - `shinkansen/content-inject.js`：`SK.injectTranslation` 入口加 dual dispatch head（`STATE.translatedMode === 'dual' && unit.kind !== 'fragment'` → `SK.injectDual`）。新增 `SK.injectDual` 主入口、`buildDualInner`（依原 tag 決定 wrapper 內部 tag，heading 降級 `<div>` 但繼承字級）、`findBlockAncestor`（inline 段落用，computed display ∈ {block, flex, grid, table, list-item, flow-root}）、`SK.removeDualWrappers`（restore 用）、`SK.ensureDualWrapperStyle`（一次性注入全域 wrapper CSS 到 `<head>`）。slots 路徑共用既有 `deserializeWithPlaceholders` 重建 inline 結構（`<a href>` 等完整保留進 wrapper inner）。
  - `shinkansen/content-spa.js`：`runContentGuard` 加 dual 分派——`runContentGuardDual` 遍歷 `translationCache`，wrapper 被 SPA 拔掉時依 insertMode（`afterend` / `append` / `afterend-block-ancestor`）把同一個 wrapper element re-append 回去，不重新呼叫 LLM。`SK.testRunContentGuard` 同步 dispatch。
  - `shinkansen/content.js`：`translatePage` / `translatePageGoogle` 進入時讀 `settings.displayMode` 寫入 `STATE.translatedMode`、讀 `translationMarkStyle` 寫入 `SK.currentMarkStyle`；dual 模式呼叫 `ensureDualWrapperStyle`。`restorePage` 依 `STATE.translatedMode` 分派 single（反向覆寫 originalHTML）/ dual（`querySelectorAll('shinkansen-translation').forEach(remove)`）。新增 `MODE_CHANGED` 訊息 handler——已翻譯狀態下顯示 toast 提示「請按快速鍵重新翻譯以套用」，未翻譯則靜默接收。Debug API 新增 `testInjectDual` / `testRestoreDual`，`setTestState` 支援 `translatedMode` override。
  - `shinkansen/popup/`：popup.html 新增「顯示模式」toggle（單語覆蓋 / 雙語對照雙按鈕 radiogroup）；popup.css 對應樣式；popup.js 讀 `displayMode` 設初始狀態，切換時 `chrome.storage.sync.set` + `MODE_CHANGED` 訊息送 active tab。
  - `shinkansen/options/`：options.html「一般設定」分頁加「雙語對照視覺標記」section（demo 預覽 + 4 個 radio：tint 淡底色 / bar 左邊細條 / dashed 虛線底線 / none 無標記）；options.css 加 demo + radio 樣式（dual wrapper CSS 與 content-inject.js inject 的版本對齊）；options.js load/save 處理 `translationMarkStyle`，radio change 即時更新 demo wrapper 的 `data-sk-mark`。
  - `shinkansen/lib/storage.js`：`DEFAULT_SETTINGS` 加 `displayMode: 'single'` / `translationMarkStyle: 'tint'`。

  特殊容器規格（依 DOM 結構特徵分派，不綁站點/class）：一般 block (P/DIV/...) → wrapper 用原 tag 並 `insertAdjacentElement('afterend')`；H1–H6 → wrapper inner 為 `<div>` + inline style 從 computed style 繼承 font-size/font-weight/line-height（避免 SEO/AT 重複標題）；LI / TD / TH → wrapper inner 為 `<div>`、`appendChild` 進 cell 內部（避免 ol 編號錯位、table 對齊跑掉）；inline 段落（span/a 被偵測時）→ 往上找最近 block 祖先、wrapper 插在 block 祖先 afterend。YouTube 字幕維持單語替換路徑不變。

  新增 10 條 Playwright regression spec（`test/regression/`）：`inject-dual-basic` / `inject-dual-heading`（字級繼承）/ `inject-dual-list`（ol 編號維持）/ `inject-dual-table`（cell 內部）/ `inject-dual-inline`（block 祖先後）/ `inject-dual-preserves-link`（`<a href>` 保留 + slots 路徑）/ `inject-dual-restore`（清乾淨 + 原文不動）/ `inject-dual-mark-style`（4 種 attribute + computed CSS 全綠）/ `inject-dual-mode-switch`（dispatcher 路由）/ `content-guard-dual`（wrapper 被刪 → re-append 同一 element）。共用 fixture `dual.html`。SANITY 全部驗過：(1) 整體：把 `SK.injectDual` short-circuit 成 no-op，8 條 inject-dual-* spec 全部 fail；還原後全綠。(2) Content Guard：把 `wrapper.isConnected` 檢查反向，`content-guard-dual` fail；還原 pass。(3) Mode dispatcher：把 `STATE.translatedMode === 'dual'` 條件改為 `false`，`mode-switch` spec 中 dual 段假裝 single 路徑 fail；還原 pass。

  Full `npm test` 131 → 141 Playwright + 26 Jest 全綠。

  **協作流程同步調整（v1.5.0 起）**：所有開發（含 UI/DOM 改動）一律在 Claude Code 端執行，Cowork 從 v1.4.14 起的「UI bug 修復主力環境」角色降為諮詢幕僚。原因：v1.4.14–v1.4.20 期間幾乎所有 UI bug fix 還是回到 Claude Code 跑 `npm test` + Playwright fixture 驗，Cowork 端用 Chrome MCP 看真實 DOM 已不是 fix loop 必備（fixture 抽出後 Playwright 比 Chrome MCP 自動化程度高得多）；同時兩端切換造成的 git 錯位風險（v1.3.1 / v1.3.3 教訓）每次都要走 §10 通盤檢查防禦，工作流複雜度與實際收益不成比例。CLAUDE.md 同步改寫：檔頭分工段落、§1.5 雙環境結構、§9 Path A 兩階段流程、§工作風格除錯時段落、§不要做的事「不要加回雙語對照模式」條目（本版實作後移除）。

## v1.4.x

**v1.4.22** — GWS 送審版！修正 v1.4.20 新增的媒體卡片 skip 誤傷含 SVG icon 的標題（例如 Substack 的 `h2.header-anchor-post` 內有 `div.anchor > svg`）。根因：v1.4.20 用 `SK.containsMedia` 判斷媒體，但此函式涵蓋 `img/picture/video/svg/canvas/audio`——SVG 在現代前端常是裝飾性 icon（錨點/外連/展開符號），誤判成「媒體卡片」會把本該翻譯的整段標題或段落 FILTER_SKIP 掉。修法（`content-detect.js` acceptNode BLOCK_TAGS 分支）：把 mediaCardSkip 的判斷從 `SK.containsMedia(el)` 窄化為 `el.querySelector('img, picture, video')`，只收「功能性媒體」（真實內容圖片/影片），排除 svg/canvas/audio。v1.4.20 既有 regression（media-card-attachment fixture 用 `<img>`）仍涵蓋、不受影響。新增 regression spec `test/regression/detect-substack-heading-svg.spec.js`（正向斷言 H2 含 `div.anchor > svg + 文字` 應被偵測為 element unit + mediaCardSkip 不該命中 + H2 文字包含預期標題）+ fixture `substack-heading-svg.html` / `.response.txt`。SANITY：把判斷還原為 `SK.containsMedia` 後斷言 fail（unitCount=0, mediaCardSkip=1）；換回窄化判斷後全綠。Full `npm test` 130 → 131 Playwright + 26 Jest 全綠。

**v1.4.21** — 修正 popup 的「YouTube 字幕翻譯」勾勾在某些情境下反向作用（勾起卻停止翻譯、取消卻啟動翻譯）。根因：v1.4.13 把勾勾「顯示」改為讀 `ytSubtitle.autoTranslate` 設定值，但「點擊」還是沿用 v1.2.12 的 `TOGGLE_SUBTITLE` 翻面 `YT.active` 的舊語意。當「設定值」跟「YT.active 當下運行狀態」desync 時（常見：使用者用 Alt+S 手動啟動過、或在 content script init 800ms 延遲窗口內點擊），點擊結果會跟勾勾狀態相反。修法：`popup/popup.js` 改送 `SET_SUBTITLE { enabled: 勾勾當前狀態 }`，`content.js` handler 依 enabled 直接決定動作——`enabled=true + !active` 啟動、`enabled=false + active` 停止、兩種「已是期望狀態」no-op。勾勾即期望狀態，點擊結果永遠跟著勾勾走。新增 regression spec `test/jest-unit/subtitle-set-state.test.cjs`（5 條：四種 (enabled × active) 組合各一 + desync 重現 active=true+勾起不該停）。SANITY：把 handler 還原成舊 TOGGLE 語意後，5 條中 4 條 fail（含 desync）；套回新邏輯後全綠。Full `npm test` 130 Playwright + 26 Jest 全綠。未動 `content-youtube.js:1084` 的 SPA 導航 `shouldRestart = wasActive || autoTranslate` 同類型問題（wasActive 覆蓋明確設為 false 的 autoTranslate），屬獨立 bug 另處理避免混淆。

**v1.4.20** — 修正 XenForo 等論壇附件 LI 翻譯後預覽圖消失。Cowork 實地診斷：附件典型結構 `<li class="attachment"><a class="file-preview"><img></a><div class="file-content">...</div></li>`——LI 在 `BLOCK_TAGS_SET`，內部沒有 H/P/LI 等 block 後代 → `containsBlockDescendant(LI)=false` → walker 把整個 LI 當 element unit。注入時 `containsMedia(LI)=true` 且 `hasContainerChild=true`（DIV.file-content），`injectIntoTarget` 的 `containsMedia && !hasContainerChild` 條件不成立 → 走 clean-slate，清空 LI 所有子元素（含 `<img>`），預覽圖消失。修法（`content-detect.js` `acceptNode` BLOCK_TAGS 分支）：block 元素同時有媒體子元素 + 直屬 CONTAINER_TAGS 子容器 → `FILTER_SKIP`，讓 walker 進入 LI 內部找真正可翻的葉節點（file-meta DIV 走 Case C、或檔名 A 走 v1.4.17 skipBlockWithContainer）。LI 本身不成單元，clean-slate 不觸發，預覽圖完整保留。新增 `stats.mediaCardSkip` 作 forcing function。與 v1.4.17 skipBlockWithContainer 的關係：v1.4.17 涵蓋「block 含 CONTAINER 子 + 直屬 A」（forumdisplay），v1.4.20 補全「同類 block 結構但 CONTAINER 沒直屬 A（檔名是 span/h4）且本身含媒體」的缺口；兩條規則互不重疊，v1.4.20 要求 `containsMedia`，v1.4.17 要求 CONTAINER 內有直屬 A，真實 XenForo 兩種結構都存在。新增 regression spec `test/regression/detect-media-card-attachment.spec.js`（3 條：正向「LI 不應成 element unit + mediaCardSkip 命中 + 內部 file-meta 仍被偵測 + img 仍在 DOM」；兩條負向對照「含 img 但無 CONTAINER」「含 CONTAINER 但無媒體」皆不該觸發 mediaCardSkip）+ fixture `media-card-attachment.html` / `.response.txt`。SANITY：移除整個 mediaCardSkip if block 後，正向 test 第 1 條斷言 fail（LI 仍被偵測為 element unit，stats 顯示 skipBlockWithContainer 也未命中因為檔名是 `<span>` 沒有 A），負向兩條仍 pass；還原後全綠。Full `npm test` 127 → 130 Playwright + 21 Jest 全綠，既有 `detect-vbulletin-author`（v1.4.17，無媒體不受影響）與 `inject-vbulletin-title-div`（v1.4.14，TD 含 img 但無 CONTAINER 子，不受影響）兩條相關 spec 都仍通過。

**v1.4.19** — 修正 XenForo bbWrapper 一類純行內段落漏翻的問題（Case C）。Cowork 實地診斷結構：`<div class="bbWrapper">There is actually <a>some evidence</a> to support the position that this stuff does take place.</div>`——DIV 不在 `BLOCK_TAGS_SET`、無 block 子孫（Case A 失敗）、無 `<br>`（Case B 失敗），walker 直接 `FILTER_SKIP`，整段 TEXT + inline `<a>` 完全不進結果 → 頁面顯示英文。修法（`content-detect.js` `acceptNode` 非 BLOCK_TAGS 分支再加一條 else if）：與 Case B 對稱，但把「必須有 BR」換成「有直接文字 + directTextLength >= 20」——四重條件 `CONTAINER_TAGS.has(tag) && !seen(el) && hasDirectText && directTextLength(el) >= 20 && isCandidateText(el)` 全成立才匹配，觸發 `extractInlineFragments` 把「直接文字 + inline run」串成一個 fragment unit。`directTextLength >= 20` 門檻用來擋 nav 短連結（nav 的文字都在 `<a>` 內，直接文字長度趨近 0）。新增 stats 計數 `inlineMixedFragment` 作 forcing function。新增 regression spec `test/regression/detect-bbwrapper-inline-link.spec.js`（2 條：正向斷言 fragment 涵蓋「直接文字 + `<a>` 內文」一個 run、forcing counter >= 1；負向對照 nav 短連結不被誤抓）+ fixture `bbwrapper-inline-link.html` / `.response.txt`。SANITY：移除 Case C else if 整段後，正向 test 兩個斷言都 fail（fragmentCount=0 / stats.notBlockTag=2），負向仍 pass；還原後全綠。Full `npm test` 125 → 127 Playwright + 21 Jest 全綠，既有 `detect-bbcode-div-text` / `detect-leaf-content-div` / `detect-nav-anchor-threshold` / `detect-nav-content` 四條相關 spec 都未受影響。

**v1.4.18** — 兩個獨立修正。(1) **YouTube 字幕用量紀錄合併**：v1.4.17 之前每個字幕批次（每 5–10 秒一次）都呼叫 `usageDB.logTranslation()` 新建一筆紀錄，一支影片會產生幾十筆獨立紀錄把用量頁塞滿。`lib/usage-db.js` 新增 `upsertYouTubeUsage(record, mergeWindowMs=3600000)`：透過 timestamp 索引反向掃 1 小時視窗內的紀錄，找同 `source='youtube-subtitle' && videoId && model` 的既有紀錄就累加 tokens/segments/cacheHits/durationMs 並把 timestamp 更新為最新；找不到才新建。`background.js` LOG_USAGE handler 偵測到 `source === 'youtube-subtitle' && videoId` 時改走此路徑，網頁翻譯仍走 `logTranslation`（一頁一筆是自然單位）。`content-youtube.js` `_logWindowUsage` 在 payload 加 `videoId: YT.videoId || getVideoIdFromUrl()` 作合併 key。換模型（`yt.model` / `geminiConfig.model` 變動）或超過 1 小時空窗就拆新紀錄。(2) **瀏覽器返回鍵恢復自動翻譯**：v1.4.12 起 `content.js` 初始化時只要 `performance.getEntriesByType('navigation')[0].type` 是 `'reload'` 或 `'back_forward'` 就送 `STICKY_CLEAR`——但 `'back_forward'` 只是歷史切換，不該視為「放棄翻譯」。情境：A 翻譯後點連結到 B 會自動翻譯（跨 tab sticky 走 opener / 同 tab 走 STICKY_QUERY），但按返回鍵回 A 卻因 STICKY_CLEAR 而顯示英文。修法：`content.js:1128` 條件改成只有 `navType === 'reload'` 清 sticky，`'back_forward'` 走下方 STICKY_QUERY 分支繼承既有狀態，與「跨 tab 繼承」「SPA 續翻」的心智模型一致。新增兩條 regression：`test/regression/youtube-usage-merge.spec.js`（Playwright，4 條：同 videoId+model 1 小時內合併一筆、換 model 拆兩筆、超 1 小時拆兩筆、不同 videoId 各自獨立；SANITY：把 LOG_USAGE handler 的 youtube 分支改成永遠走 logTranslation，test 1 fail 從 1 變 2 筆）、`test/jest-unit/back-forward-sticky.test.cjs`（jsdom，3 條：back_forward 不送 CLEAR 走 QUERY / reload 仍送 CLEAR / navigate 不送 CLEAR 走 QUERY；SANITY：把 if 條件還原成含 back_forward，back_forward 測試 fail）。Full `npm test` 125 Playwright + 21 Jest 全綠。

**v1.4.17** — 修正 vBulletin 論壇討論串列表（forumdisplay）翻譯後作者 ID 消失的問題。Cowork 端用 Chrome MCP 實地診斷根因：thread title cell 結構為 `<td> > <div> > <a>[title] + <div class="smallfont"> > <span>[author]`，TD 沒有 `BLOCK_TAGS_SET` 後代 → `containsBlockDescendant(TD)=false` → walker 整個 TD `FILTER_ACCEPT` 當成一個翻譯單元。Gemini 翻完 thread title 後，slot（作者 SPAN 對應的 placeholder）被 LLM 丟掉；`injectIntoTarget` 走 clean-slate（v1.4.14 加的 `hasContainerChild` 守衛命中），清空 TD 所有子節點後只 append 回 thread title DIV，**作者 DIV/SPAN 隨 clean-slate 被抹掉 → 作者 ID 消失**。修法（只改 `content-detect.js` `collectParagraphs` 的 `acceptNode`）：block element（BLOCK_TAGS_SET 成員）通過 `containsBlockDescendant=false` 與 `isCandidateText=true` 後，再檢查 `el.children` 中的 `CONTAINER_TAGS` 直屬子容器（DIV/SECTION/ARTICLE/MAIN/ASIDE）是否含直屬 `<A>` 連結；有的話改為只把這些 `<A>` 捕捉為翻譯單元、block 本體 `FILTER_SKIP`。這樣 TD 的結構（兩個 DIV、作者 SPAN 等）完全不會被 clean-slate 碰到，只有 A 的內容會被譯文替換。新增 regression spec `test/regression/detect-vbulletin-author.spec.js` + fixture（最小結構：`td > div > a + div > span`，斷言 A 被偵測、TD 不被偵測為 element 單元、`skipStats.skipBlockWithContainer/blockContainerLink >= 1`）。SANITY：把新加的區塊整段註解後，斷言 1（A 應被偵測）與斷言 2（TD 不應被偵測）同時 fail；還原後 pass。既有 `inject-vbulletin-title-div.spec.js` 仍通過（該 fixture 的 TD 子 DIV 內無 `<A>`，新邏輯不觸發）。Full `npm test` 120 → 121 條全綠。

**v1.4.16** — 設定頁排版調整 + toast 標示自動翻譯 + README 擴充。(1) 設定頁「效能（翻譯效率調校）」從「一般設定」分頁搬到「Gemini」分頁（放在 LLM 參數微調之後），因效能與 API 速度、配額、模型選擇同屬 Gemini 相關參數，聚在同一分頁更合邏輯。(2) 一般設定分頁的 section 順序重排：Gemini API Key → **翻譯快速鍵**（原在分頁底端，現移到 API Key 之下）→ 網域規則 → 語言偵測 → 翻譯進度通知 → 匯入/匯出設定 → 回復預設設定 → 授權資訊。快速鍵放最顯眼位置讓新使用者馬上看到三組鍵位可自訂；匯入/匯出自然落在回復預設設定之前形成「備份 → 重置」的合理流程。(3) 設定頁「翻譯快捷鍵」標題改為「翻譯快速鍵」（符合台灣用語 + `DEFAULT_SYSTEM_PROMPT` 已列出的對照詞）。(4) `content.js` 自動翻譯網站觸發路徑（whitelist 命中 + `autoTranslate=true`）在呼叫 `SK.translatePage()` 時加上 `label: '自動翻譯'`，loading toast 前綴會顯示 `[自動翻譯] 翻譯中… X / Y`，讓使用者一眼區分「這次是我按的」vs「自動觸發的」。(5) README 擴充「功能特色」加入雙翻譯引擎（Gemini + Google Translate）與三組可自訂快速鍵；「使用方式」列出三鍵位 + 預設引擎對照表；新增「翻譯快速鍵與預設」專章說明自訂流程、統一取消/還原行為、跨 tab 延續翻譯；新增「Google Translate 翻譯引擎」專章說明免費性、速度、格式保留、適用場景。無 `shinkansen/` 渲染路徑改動、無 regression spec 改動（純文字 + HTML 結構重排，既有 120 條 Playwright + 18 條 Jest 全綠）。

**v1.4.15** — 補兩條 regression spec，把 v1.4.11 跨 tab sticky 翻譯 + v1.4.12 三組 preset 快速鍵的行為全部鎖死。(1) `test/regression/preset-hotkey-behavior.spec.js`：5 條測試涵蓋 `handleTranslatePreset(slot)` 的三分支 × 三 slot。idle + slot 1/2/3 各自觸發對應 engine（Gemini Flash Lite / Flash / Google）與 modelOverride 正確；translated 狀態任何 slot 都走 `restorePage`（STATE.translated/translatedBy/stickySlot 翻 null）；translating 狀態任何 slot 都觸發 `STATE.abortController.abort()`。策略：直接呼叫 `SK.handleTranslatePreset` 繞過 Playwright 無法模擬的真實鍵盤，stub `SK.translatePage` / `SK.translatePageGoogle` 攔截啟動時的 engine 分流。SANITY 四種 break（engine 路由、modelOverride、translated 分支、abort 行）全部各自驗過對應 test fail。(2) `test/regression/sticky-cross-tab.spec.js`：2 條測試涵蓋 `chrome.tabs.onCreated` 繼承 + per-tab 獨立。tab A STICKY_SET slot=2 → `window.open` 開 tab B → tab B 的 STICKY_QUERY 回 `shouldTranslate=true, slot=2`；tab A STICKY_CLEAR 不影響 tab B。策略：直接透過 `chrome.runtime.sendMessage` 操作 sticky Map，再用 Playwright `context.waitForEvent('page')` 接 `window.open` 開出的新 tab 驗 `openerTabId` 繼承。SANITY：把 onCreated listener 的繼承主體註解掉，兩條 test 都 fail。「無 opener 不繼承」情境無法在 Playwright 穩定模擬（`context.newPage()` 會把最近 active tab 設 opener），該條結構性保護由 `if (openerId == null) return;` 的 guard 提供，未另寫 regression；spec 檔頂註記限制。Full `npm test` 從 113 → 120 條全綠。PENDING_REGRESSION queue 清空該兩條。無 `shinkansen/` 程式碼改動。

**v1.4.14** — 修正 vBulletin 論壇貼文頁（如 forum.miata.net）翻譯後標題消失、`<hr>` 分隔線跑到標題之前的問題。Cowork 端用 Chrome MCP 實地診斷根因：`<td class="alt1">` 沒有 `BLOCK_TAGS_SET` 後代（`DIV`/`HR` 都不在），walker 整段 FILTER_ACCEPT 把 TD 當翻譯單元；injection 時 `containsMedia(TD) = true`（`postbitcontrol2` 內的 `<img>` emoji），走 media-preserving path 把整個 fragment 塞進最長文字節點所在的 `postbitcontrol2`，原本的 `smallfont`（空的 STRONG 殼）與 HR 殘留在其上方 → HR 視覺上跑到標題之前。修法（只改 `content-inject.js` `injectIntoTarget`）：加結構性條件 `hasContainerChild = Array.from(target.children).some(c => CONTAINER_TAGS.has(c.tagName))`，當 target 有 DIV/SECTION 等容器直屬子元素時，表示文字分散在不同結構子容器，改走 clean-slate（`containsMedia(target) && !hasContainerChild` 才走 media path）。clean-slate 清空 TD 後 append deserialize 出的 fragment（STRONG → HR → 內文），順序正確。新增 regression spec `test/regression/inject-vbulletin-title-div.spec.js`（fixture 含 img 以觸發 `containsMedia(TD)=true`，斷言 STRONG 在 HR 之前）。SANITY 通過：移除 `&& !hasContainerChild` 後 DOM 出現 `<hr>...<div class="postbitcontrol2"><strong>...</strong><hr>...</div>`，斷言 fail；還原後 pass。既有 `inject-hr-in-td.spec.js` 4 條斷言仍全部通過（hr-in-td fixture 無 img，本來就走 clean-slate，不受影響）。**流程里程碑**：這是 v1.4.14 起新工作流（UI/DOM bug 修復改 Cowork 主力）的首發——Cowork 實地診斷 + 改 code + 在 Chrome MCP 上驗證，Claude Code 補 spec + SANITY + test + release。對比被 revert 的前一版 v1.4.14（Claude Code 純推理，SANITY 過但實際頁面沒修好），驗證了「UI bug 必須實地驗證」這條規則。

**v1.4.13** — 設定頁新增「翻譯快捷鍵」區塊（一般設定分頁內，取代原本只顯示「預設 Alt+S」說明的簡版）。三張 preset card 對應 `translatePresets[slot]`，每張可編輯：標籤（自由文字，最多 12 字）、翻譯引擎（Gemini / Google Translate）、Gemini 模型（engine=gemini 時顯示，三個預設模型 + 未來可擴充）。card 右上角顯示當前鍵位綁定（由 `chrome.commands.getAll()` 讀取，未設定時顯示紅色「未設定」提示）。engine 切換成 Google Translate 時自動隱藏模型欄（google MT 無 model 概念）。與 v1.4.12 的 `translatePresets` storage schema 完全相容，儲存時組成 `[{slot, engine, model, label}]` 寫回 `chrome.storage.sync.translatePresets`。影響檔案：`shinkansen/options/options.html`（新增 section + 三張 card）、`shinkansen/options/options.js`（`load()` 讀 preset 填 UI + `save()` 組陣列寫回 + `refreshPresetKeyBindings()` 讀 `browser.commands.getAll()` + engine change listener 切換 model row 可見性）、`shinkansen/options/options.css`（新增 `.preset-cards` grid layout + card 樣式）。使用者現在可在設定頁直接調整三組 preset 的 engine/model/label，不再需要手動編輯 `chrome.storage.sync.translatePresets`。同時修三個小問題：(1) `popup.js refreshShortcutHint` 仍在找舊 command name `toggle-translate`（v1.4.12 已改名 `translate-preset-*`），導致 popup 右下角永遠顯示「未設定快捷鍵」——改讀 `translate-preset-2`（對應 popup 按鈕映射的 slot 2 Flash）的當前鍵位；(2) 翻譯中的 loading toast 加上 preset label 前綴（例如 `[Flash Lite] 翻譯中… 5 / 20`），使用者能一眼看出目前跑的是哪組 preset，透過 `options.label` 從 `handleTranslatePreset` 傳到 `translatePage` / `translatePageGoogle`；(3) popup 的 YouTube 字幕 toggle 原本顯示「當前 active 狀態」（`SK.YT.active`），使用者剛進 YouTube 頁 active 還沒就位就會顯示 off，造成「預設沒打開」錯覺——改為顯示 `ytSubtitle.autoTranslate` 設定值（default true），同時 toggle change 時寫入設定 + 通知 content script 立即啟/停，`content.js` 初始化段讀 `ytSubtitle.autoTranslate !== false` fallback 對齊預設值（從未設過視為 true），新使用者一打開 popup 就看到 ON。

**v1.4.12** — 新增三組可自訂翻譯預設快速鍵：`Alt+A` / `Alt+S` / `Alt+D`（預設對應 Gemini Flash Lite / Flash / Google Translate），讓使用者依網頁內容重要性選擇不同引擎與模型。每組 preset 存 `{ slot, engine, model, label }`，engine='gemini' 時 model 覆蓋 `geminiConfig.model`（其餘 prompt/temperature/glossary 沿用全域），engine='google' 時走 Google Translate 路徑。統一取消行為：已翻譯狀態下按任一 preset 快速鍵皆 `restorePage`（不區分按哪個）；翻譯中按任一鍵皆 abort。實作範圍：`manifest.json` commands 重寫（移除 `toggle-translate` / `toggle-google-translate`，改為 `translate-preset-1/2/3`）；`lib/storage.js` `DEFAULT_SETTINGS` 加 `translatePresets` 陣列；`background.js` onCommand 派送 `TRANSLATE_PRESET {slot}`，`TRANSLATE_BATCH` 接受 `payload.modelOverride`，`handleTranslate` 加 `cacheTag` 參數避免 preset 的 model override 被誤判為字幕模式污染快取，並把 model 字串納入 cache key 後綴（`_m<model>`），確保同段文字在不同 preset/model 之間不共用快取（例如 Flash Lite 翻過後按 Alt+S 用 Flash 會重新打 API）；`content.js` 新增 `handleTranslatePreset(slot)` 統一入口（取消/abort/啟動三分支），`SK.translatePage(options)` / `SK.translatePageGoogle(gtOptions)` 接受 `{ modelOverride, slot }` 並將 `modelOverride` 透過 `SK.translateUnits` 傳至 `TRANSLATE_BATCH` payload；v1.4.11 sticky schema 改動：`stickyTabs` Map value 從 `engine` 字串改存 `slot` number，content 初始化時收到 `STICKY_QUERY` 回的 slot 透過 `handleTranslatePreset` 啟動同 preset（忠實繼承使用者當時按的引擎+模型組合）；`content-ns.js` STATE 加 `stickySlot` 供 `content-spa.js` SPA 續翻讀取同 slot；`popup.js` 的 `TOGGLE_TRANSLATE` 訊息保留並在 content script 內部映射為 slot 1 行為（零改動相容）。Options 頁 UI（engine/model/label 下拉編輯）延到 v1.4.13；v1.4.12 使用者要改 preset 可暫時改 `chrome.storage.sync.translatePresets` 或等下版 UI。同時調整：reload 同 tab 或瀏覽器前進後退時視為使用者主動放棄翻譯（`performance.getEntriesByType('navigation')[0].type === 'reload' / 'back_forward'`），content script 初始化時主動送 `STICKY_CLEAR` 不再繼承，避免 reload 後還在自動翻。另外新增 `lib/model-pricing.js` 統一 Gemini 模型→定價表（Flash Lite $0.10/$0.30、Flash $0.50/$3.00、Pro $2/$12），`handleTranslate` 發現 `modelOverride` 時會從此表查對應 pricing 覆蓋 `settings.pricing`，確保 toast 與 usage log 的費用跟 preset 的 model 走（以前切 Flash Lite 仍用 Flash 價格算，會多算 5 倍）；優先順序為 `pricingOverride`（YouTube 字幕獨立計價）> `modelOverride` 查表 > `settings.pricing`（使用者自訂）。`options.js` 同步 import 新 lib，避免兩處定價表不同步。同時反映協作流程轉變（Jimmy 2026-04-19 決定）：**主要開發環境從 Cowork 翻轉為 Claude Code**，Cowork 降為輔助角色僅用於 `mcp__Claude_in_Chrome__*` 實地看 DOM 的 debug。`CLAUDE.md` 與 `測試流程說明.md` 已同步改寫（這兩檔在 `.gitignore` 內不進版控，變更僅存於本機）。

**v1.4.11** — 新增跨 tab sticky 翻譯：使用者按 Option+S（或 Option+G）翻譯頁面後，從此 tab 點連結開新分頁（含 Cmd+Click / target="_blank" / window.open），新分頁自動翻譯並同樣進入 sticky 狀態；新分頁再開新分頁也繼續。行為以 `chrome.tabs.openerTabId` 鏈做樹狀傳遞——手動打網址、從 bookmark 開、或完全無 opener 的新分頁不繼承。每個 tab 的 sticky 獨立，按一次 Option+S（觸發 `restorePage`）只清當前 tab，不影響樹中其他 tab。實作：`background.js` 新增 `stickyTabs` Map + `chrome.storage.session` 持久化 + `chrome.tabs.onCreated` 繼承 / `onRemoved` 清理 + 三個訊息 `STICKY_QUERY` / `STICKY_SET` / `STICKY_CLEAR`；`content.js` translatePage/translatePageGoogle 成功後送 `STICKY_SET`（engine 依路徑），restorePage 送 `STICKY_CLEAR`，content script 初始化時若 `STICKY_QUERY` 回 `shouldTranslate=true` 自動觸發對應 engine。engine 區分讓子 tab 繼承相同翻譯引擎（Gemini / Google MT）。

**v1.4.10** — 修正 VBulletin / 論壇頁面翻譯後貼文標題與正文之間的 `<hr>` 分隔線消失的問題。根因：`<td>` 包含 `<div class="smallfont">（標題）`、`<hr>`、`<div id="post_message">（內文）`，三者並列；`<td>` 沒有 P/H1/LI 等 block 後代，walker 直接把整個 `<td>` 當一個段落；`serializeWithPlaceholders` 序列化時 `<hr>` 既不是 `isPreservableInline` 也不是 `isAtomicPreserve`，直接被遞迴走過（無輸出），clean slate 注入後自然消失。修法：在 `isAtomicPreserve` 讓 `HR` 回傳 `true`，序列化時保留為 `⟦*N⟧` 原子佔位符，注入後完整還原（`cloneNode(true)` 保留 class 屬性如 `hideonmobile`）。影響函式：`content-ns.js` → `isAtomicPreserve`；Gemini 與 Google Translate 兩條序列化路徑均自動受益（皆已呼叫此函式）。

**v1.4.9** — 補做 BBCode DIV「純文字 + BR、無 block 子孫」（Case B）的偵測，重做 v1.4.8 試過但回退的邏輯。差異是這次條件嚴格 4 重：(1) tag 必須屬於新加的 `SK.CONTAINER_TAGS = {DIV, SECTION, ARTICLE, MAIN, ASIDE}`（排除 inline element 如 A/SPAN/B/I）；(2) 至少有一個直接 `<br>` 子元素（排除 leaf-content-div 那種純文字無 BR 的 DIV，仍由 v1.0.8 leaf scan 處理）；(3) 直接 TEXT 子節點 trimmed 總長度 >= 20 字（與 leaf-content-div 門檻對齊，排除短連結／麵包屑）；(4) `isCandidateText` 通過。新增 stats 計數 `containerWithBr` 作為 forcing function。三條原本被 v1.4.8 踩到的 spec（`detect-leaf-content-div` / `detect-nav-anchor-threshold` / `detect-nav-content`）SANITY 後確認仍 pass。影響函式：`content-detect.js` → `collectParagraphs` → `acceptNode`；新 helpers `hasBrChild` / `directTextLength`；新常數 `content-ns.js` → `SK.CONTAINER_TAGS`。

**v1.4.8** — 修正字面 `\n` 在 fragment no-slots / element no-slots 注入路徑殘留的問題。v1.4.6 的字面 `\n` → 真正換行符規範化只在 `deserializeWithPlaceholders`（有 slots）路徑生效，無 slots 路徑完全繞過。修法：(1) 在 `injectTranslation` 入口統一把字面 `\n`（兩字元）→ 真正換行符（U+000A），覆蓋所有後續路徑；(2) 在 `injectFragmentTranslation` 無 slots 分支補上 `\n` → `<br>` 還原（呼叫 `buildFragmentFromTextWithBr`，與 element no-slots 走的 `replaceTextInPlace` 行為對齊）。影響函式：`content-inject.js` → `injectTranslation` 入口 + `injectFragmentTranslation` 無 slots 分支。

註：原本本版還包含 BBCode DIV「純文字 + BR、無 block 子孫」（Case B）的偵測補強，但實作過於寬鬆，會誤抓既有的 nav 短連結 / leaf content div / 麵包屑（踩 3 條 regression spec），已回退；改記入 PENDING_REGRESSION 待重做。

**v1.4.7** — 修正 XenForo / BBCode 論壇風格頁面中，`<div class="bbWrapper">` 等非 block-tag 容器內的直接 text 子節點（intro 段落、「Pros:」標題等）漏翻的問題。根因：`DIV` 不在 `BLOCK_TAGS_SET`，`collectParagraphs` walker 對 `.bbWrapper` 直接回 `FILTER_SKIP`，完全沒走到 `containsBlockDescendant` / `extractInlineFragments`，導致 `<LI>` 被翻而 intro 文字完全不可見。修法：在 `acceptNode` 的非 `BLOCK_TAGS_SET` 分支，若元素有直接 TEXT 子節點（trimmed >= 2 chars）且有 block 子孫，補做 `extractInlineFragments`，把文字抽成 fragment 單元。影響函式：`content-detect.js` → `collectParagraphs` → `acceptNode`。

**v1.4.6** — 修正 Gemini 有時把換行字元以字面 `\n`（反斜線 + n，兩個可見字元）輸出，而非真正換行符（U+000A）的問題。`pushText` 用 `includes('\n')` 偵測換行，字面 `\n` 無法觸發，導致 `\n` 以兩個字元殘留 DOM。修法：在 `deserializeWithPlaceholders` 的 `normalizeLlmPlaceholders` 之後加一個規範化步驟，把字面 `\n`（`/\\n/g`）替換為真正換行符，再繼續後續的 `collapseCjkSpacesAroundPlaceholders` 與 `parseSegment`。影響函式：`content-serialize.js` → `deserializeWithPlaceholders`。

**v1.4.5** — 修正 Gemini 在翻譯含醫藥/術語內容的 slot 時，會在佔位符括號內插入描述文字（如 `⟦0 drug⟧` → `⟦0⟧`），導致 `normalizeLlmPlaceholders` 無法識別，最終 `⟦` / `⟧` 被剝除、「0 drug」/「/0 drug」裸字串殘留 DOM 的問題。修法：在 `normalizeLlmPlaceholders` 加一條 regex，偵測「數字後有空白 + 非空白文字」的模式並自動清除多餘描述（保留前綴符號與數字）。影響函式：`content-serialize.js` → `normalizeLlmPlaceholders`。

**v1.4.4** — 修正 `<strong><br>段落` 結構翻譯後 `<br>` 消失的問題。根因是 `collapseCjkSpacesAroundPlaceholders` 的 4 個 pattern 使用 `\s+`，會把佔位符標記與 CJK 字元之間的 `\n`（由 `<br>` 序列化來的）一併吃掉，導致還原時找不到 `\n` 而無法產生 `<br>` 元素。修法：將 4 個 pattern 的 `\s+` 改為 `[ \t]+`（只移除空格/tab，保留 `\n`），讓語意換行符能順利通過到 `parseSegment` 的 `pushText` 還原為 `<br>`。

**v1.4.3** — Google Translate 模式加回行內格式保留（`<b>`、`<i>`、`<small>` 等）。測試確認只排除 `<span>`（亂碼根源）就能同時解決兩個問題：Wikipedia lede 等複雜段落不再亂碼、notice box 的斜體/小字等樣式也能正確保留。新增 `SK.GT_INLINE_TAGS` 白名單（`content-ns.js`）供 `serializeForGoogleTranslate` 判斷哪些 tag 加標記。

**v1.4.2** — 修正 Google Translate 模式翻譯複雜段落（如 Wikipedia lede）時出現亂碼（如 `7/D/17777/S4]m`）的問題。根本原因：v1.4.1 使用 `serializeWithPlaceholders` 產生 10+ 個 `【N】` 標記，Google MT 被過多標記數字搞亂位置與文字，導致亂碼。修法：改用新的 `serializeForGoogleTranslate`，只對 `<a>` 連結加 `【N】`/`【/N】` 配對標記、atomic 元素（footnote sup）加 `【*N】` 單一標記，其他 span/b/i/abbr 全部直接遞迴取文字（不加標記）。通常整段只有 2-4 個標記，Google MT 能正確保留且不亂移。

**v1.4.1** — 修正 Google Translate 模式無法保留連結與行內格式的問題。根本原因：`translateUnitsGoogle` 原本直接取 `innerText` 送出，行內 HTML（`<a href>`、`<b>`、`<i>` 等）全部丟失。修法：改用 `serializeWithPlaceholders` 取得 slots，但把 `⟦N⟧`/`⟦/N⟧` 換成 `【N】`/`【/N】` 再送 Google Translate（`⟦⟧` 是數學符號，Google MT 會亂移其位置；`【】` 是 CJK 標點，Google MT 視為不透明文字，能原樣保留且維持正確前後位置）。拿回譯文後換回 `⟦N⟧`/`⟦/N⟧`，走現有 `deserializeWithPlaceholders` + `tryRecoverLinkSlots` fallback 鏈。（注：此版在 Wikipedia lede 等複雜段落仍有亂碼，由 v1.4.2 進一步修正）根本原因：`translateUnitsGoogle` 原本直接取 `innerText` 送出，行內 HTML（`<a href>`、`<b>`、`<i>` 等）全部丟失。修法：改用 `serializeWithPlaceholders` 取得 slots，但把 `⟦N⟧`/`⟦/N⟧` 換成 `【N】`/`【/N】` 再送 Google Translate（`⟦⟧` 是數學符號，Google MT 會亂移其位置；`【】` 是 CJK 標點，Google MT 視為不透明文字，能原樣保留且維持正確前後位置）。拿回譯文後換回 `⟦N⟧`/`⟦/N⟧`，走現有 `deserializeWithPlaceholders` + `tryRecoverLinkSlots` fallback 鏈。

**v1.4.0** — 新增 Google Translate 支援。網頁翻譯：新增 Opt+G 快捷鍵，使用 Google Translate 非官方免費端點（`translate.googleapis.com/translate_a/single?client=gtx`），不需要任何 API Key；使用 U+2063 隱形分隔符批次串接多段文字（每批最多 5500 URL encoded chars），翻譯完成後自動拆分回對應段落。YouTube 字幕翻譯：設定頁「YouTube 字幕」分頁新增引擎選擇（Gemini 預設 / Google Translate），選擇 Google Translate 後字幕翻譯 API 路由至 `TRANSLATE_SUBTITLE_BATCH_GOOGLE`，不走 Gemini rate limiter。用量統計：Google Translate 紀錄以「字元數 + $0（免費）」顯示，不計入 token 費用。`STATE.translatedBy` 追蹤當前引擎（`'gemini'` / `'google'` / `null`），兩個快捷鍵各自獨立 toggle（同引擎 = 還原，切引擎 = 先還原再翻）。快取：Google Translate 結果以 `_gt` / `_gt_yt` 後綴與 Gemini 快取分開存放。

---

## v1.3.x

**v1.3.16** — Safari / Firefox 相容性 shim：全 codebase `chrome.*` → `browser.*`。新增 `lib/compat.js`，以 Proxy 做 lazy 解析（每次 property access 時讀 `globalThis.browser ?? globalThis.chrome`，避免 const 在 import 當下凍結成 undefined 或錯誤的 mock——後者會讓 Playwright 多 spec 共用 module cache 時 cache / rate-limiter unit test fail）；`content-ns.js` 頂部加 `globalThis.browser = globalThis.browser ?? globalThis.chrome` 供 content scripts 繼承。`options.js` 偵測平台，Safari 上隱藏「至 chrome://extensions/shortcuts 設定快捷鍵」連結。這是 iOS/iPadOS 移植準備的第一步。

**v1.3.15** — 移除 `manifest.json` 的死權限 `scripting`：v1.3.13 清除 `FETCH_YT_CAPTION_TRACKS` 後整個 codebase 已無任何 `chrome.scripting` 呼叫，該權限純屬多餘，一併移除以減少 Chrome Web Store 審查摩擦，並向 Safari 移植邁進一步。

**v1.3.14** — 修正 Debug 分頁設定無法儲存的問題：（1）Debug 分頁缺少「儲存設定」按鈕，新增 `save-debug` 按鈕並掛上 `save()` handler；（2）`ytDebugToast` 和 `ytOnTheFly` 兩個 checkbox 未掛 `markDirty`，打勾後沒有「有未儲存的變更」提示，補上個別 change 事件監聽。

**v1.3.13** — 清除 v1.3.9–v1.3.11 遺留死程式碼：移除 `background.js` 的 `FETCH_YT_CAPTION_TRACKS` handler（從未被呼叫）、`content-youtube.js` 的 `extractCaptionTracksFromPage` 與 `selectBestTrack` 函式（v1.3.12 XHR monkey-patch 架構不再需要主動抓取 track URL）；更新 `content-youtube.js` 檔案標頭為 v1.3.12 架構說明；刪除孤立 fixture `youtube-innertube-fetch-spa.html`；更新 `youtube-innertube-fetch.spec.js` 的 test #1/#2 說明，標明 `extractCaptionTracksFromPage` 已從 extension 移除。

**v1.3.12** — 正式修正 YouTube 字幕 POT 問題（v1.3.9–v1.3.11 三輪嘗試的終局解）：實測證明 YouTube `/api/timedtext` URL 含 `exp=xpv` 時，所有主動 fetch（包含 MAIN world same-origin、service worker、isolated world）均回傳 HTTP 200 但 body 為空，v1.3.11 的 `chrome.scripting.executeScript` 方案亦同樣失敗。根本解法：恢復 `content-youtube-main.js`（MAIN world，`document_start`）的 XHR + fetch monkey-patch，攔截 YouTube 播放器**自己**帶 POT 發出的 `/api/timedtext` 請求；`content-youtube.js` 改為等待 `shinkansen-yt-captions` CustomEvent，若等不到則呼叫 `forceSubtitleReload()`（toggle CC 按鈕）強迫播放器重發 XHR；移除 `FETCH_YT_CAPTIONS` message handler（不再需要）；regression test #3/#4 更新為驗證新的 CustomEvent 協定。

**v1.3.11** — 正式修正 YouTube 字幕 POT 問題：加回 `scripting` 權限（現為實際使用），`FETCH_YT_CAPTIONS` 改用 `chrome.scripting.executeScript({ world: 'MAIN' })` 在 YouTube tab 的 MAIN world 直接執行 `fetch()`，使請求帶 `sec-fetch-site: same-origin` 且自動帶入使用者 session cookies，YouTube 視為正常瀏覽器行為不要求 POT；`chrome.scripting.executeScript` 亦繞過頁面 CSP。`FETCH_YT_CAPTION_TRACKS` SPA fallback 同步改用 scripting 讀 MAIN world `ytInitialPlayerResponse`，ANDROID API 退為 fallback。`fetchCaptionsForVideo` 恢復先讀頁面 `<script>` WEB tracks 的 fast path（因 MAIN world fetch 使 WEB format URL 可正常使用），WEB tracks + scripting fetch 組合，不需 POT。

**v1.3.10** — 修正 YouTube 字幕 POT（Proof-of-Origin Token）問題：`FETCH_YT_CAPTION_TRACKS` 改用 Innertube ANDROID player API（POST `/youtubei/v1/player`，clientName=ANDROID），取得不需要 POT 的 ANDROID-format captionTracks URL（c=ANDROID）；`fetchCaptionsForVideo` 改為永遠走 background 取 ANDROID tracks，不再使用頁面 `<script>` 的 WEB-format tracks（c=WEB，YouTube ~2025 起要求 POT，沒有 POT 則 HTTP 200 但回空）。ANDROID API 無結果時保留 HTML page parse 作為 fallback。新增 `urlClient` 欄位到 caption track selected log 以利除錯驗證。

**v1.3.9** — YouTube 字幕架構重構：移除 MAIN world XHR 攔截（`content-youtube-main.js` 廢棄），改為主動抓取架構。新流程：isolated world `extractCaptionTracksFromPage()` 從頁面 `<script>` 標籤解析 `ytInitialPlayerResponse`，挑選最佳英文軌道後請 background `FETCH_YT_CAPTIONS` 取得字幕原文；SPA 導航後 script 已過期時自動 fallback 至 background `FETCH_YT_CAPTION_TRACKS`（重新抓 YouTube 頁面）。manifest 同步移除 MAIN world `content_scripts` 宣告，架構為 Safari iOS 移植鋪路。

**v1.3.8** — 移除未使用的 `scripting` 權限（Chrome Web Store 審查要求：manifest 不得宣告未實際使用的權限）。

**v1.3.7** — YouTube 設定頁微調：移除「字幕翻譯可以使用比文章翻譯更便宜的模型，例如 Flash Lite」說明文字；移除 temperature 說明文字「字幕翻譯建議保持低 temperature（預設 0.1），讓翻譯結果穩定一致、不偏離原意。」；YouTube 字幕 temperature 預設值由 0.1 改為 1。

**v1.3.6** — 程式碼品質重構（無使用者可見行為改變）：（1）`content.js` `translateUnits` 的 `chrome.runtime.sendMessage` 批次呼叫加 90s `Promise.race` 逾時保護，防止 Gemini API 無回應時翻譯永久卡住；（2）新增 `lib/constants.js` 統一管理批次常數（`DEFAULT_UNITS_PER_BATCH = 12`、`DEFAULT_CHARS_PER_BATCH = 3500`），`lib/gemini.js` 與 `lib/storage.js` 改從此檔 import，消除三處重複定義；（3）`content-ns.js` 對應常數加上說明注解，標明與 `lib/constants.js` 的鏡像關係；（4）`background.js` `computeBilledCostUSD()` 改委派給 `computeCostUSD()`，消除計費費率計算的程式碼重複；（5）`content-spa.js` History API patch 加 `__sk_patched` 旗標防止重複注入，避免 content script 重複執行時形成 pushState 循環呼叫。

**v1.3.5** — `content-youtube.js` 技術債清理與強固性提升（無使用者可見行為改變）：（1）`translateWindowFrom` 加 try-finally 包裹，確保 `translatingWindows.delete()` 無論正常完成、提前 return 或例外都必然執行，防止 per-window 防重入鎖死；（2）`_runBatch` 改用局部 `_batchApiMs` 收集各批次計時，視窗完成後才同步至 `YT.batchApiMs`，消除多視窗並行時互相覆蓋的 debug 面板計時錯誤；（3）`stopYouTubeTranslation()` 補上 `rawSegments = []` 與 `translatedWindows = new Set()` 重置，讓函式狀態清理自給自足；（4）`yt-navigate-finish` handler 補上 `pendingQueue`、`translatedWindows`、`translatingWindows` 的明確重置，消除 SPA 導航期間殘留狀態阻塞新視窗翻譯的風險；（5）字幕區位置追蹤 timer 從 100ms 降為 250ms，每秒 4 次足夠追蹤，節省約 60% 定時器開銷；（6）模組頂部補上依賴聲明與外部介面說明。

**v1.3.4** 字幕翻譯 system prompt 新增 rule 8：忠實保留不雅詞彙，禁止道德審查或委婉潤飾（如 "fuck" → 「幹」，不得軟化為「糟糕」）。

**v1.3.3（2026-04-16）補上 v1.3.1 的實際程式修正**——v1.3.1 的 CHANGELOG entry、regression spec (`test/regression/youtube-spa-navigate.spec.js`)、git tag 都已存在，但 `shinkansen/content-youtube.js` 的實際修正一直躺在 working tree 未 commit，導致 v1.3.1 / v1.3.2 tag 對應的 tree 都不含該修正，build 出的 extension 遇到 YouTube SPA 切換影片仍不會自動重啟字幕翻譯。本版把 `yt-navigate-finish` 改為 async handler（讀 `ytSubtitle.autoTranslate` 設定 + `wasActive` 旗標 + 500ms setTimeout）與 `stopYouTubeTranslation()` 的 `seeked` / `ratechange` removeEventListener 補漏正式 commit 進 code。行為細節同 v1.3.1 entry；實際 regression 保護從 v1.3.3 起生效。

**v1.3.1（2026-04-16）修正 YouTube SPA 導航後字幕翻譯未自動重啟**——根本原因：`yt-navigate-finish` 事件處理器在 SPA 導航（點選其他影片）時正確重置了字幕翻譯狀態（`YT.active = false`、`rawSegments = []`），但從未為新影片重新啟動翻譯；首次載入頁面時的自動翻譯邏輯（`content.js` 初始化末段）只執行一次、不涵蓋 SPA 導航。修法：`yt-navigate-finish` 改為 async handler，重置後讀取 `ytSubtitle.autoTranslate` 設定；若設定開啟或之前字幕翻譯已啟動（`wasActive`），等 500ms 讓 YouTube 播放器初始化後自動呼叫 `translateYouTubeSubtitles()`——走「rawSegments=0」分支（等待 XHR + forceSubtitleReload 備案），與首次載入的自動翻譯流程完全一致。同時修正 `stopYouTubeTranslation()` 的漏洞：原本只移除 `timeupdate` listener，`seeked` 與 `ratechange` listener 遺漏；補上 `removeEventListener('seeked', ...)` 與 `removeEventListener('ratechange', ...)`，確保 stop → start 循環不累積 listener。

**v1.3.0（2026-04-16）YouTube 字幕翻譯里程碑（版本跳躍）+ SPEC.md 文件修正**——YouTube 字幕翻譯自 v1.2.5 累積至 v1.2.65 已達穩定可用里程碑（XHR 預翻、時間視窗批次、on-the-fly 備援、seek/rate 補償、preserveLineBreaks、字幕框展開置中、debug 面板、獨立模型/計價/prompt 設定、用量紀錄），版本號跳至 1.3.0 標記此里程碑；同時修正 SPEC.md 五處與程式碼不符的文件錯誤：（1）§8.1 `domainRules` 移除不存在的 `"blacklist": []` 欄位；（2）§8.1 補上 `lib/storage.js` 中存在但文件遺漏的四個設定欄位：`toastOpacity`（0.7）、`toastAutoHide`（true）、`skipTraditionalChinesePage`（true）、完整 `ytSubtitle` 區塊；（3）§11.2 成功 Toast「自動消失」欄位從「否（點擊外部關閉）」改為「是（`toastAutoHide` 開啟時 5 秒；預設開啟）」，符合 v1.1.3 起的實際行為；（4）§12「設定頁『Log』分頁」改為「設定頁『Debug』分頁」，符合 v1.2.49 改名後的現況；（5）§13.1 Popup 版面加入「YouTube 字幕翻譯 toggle（只在 YouTube 影片頁面顯示）」，補上 v1.2.12 新增的 popup UI 元件。

---

## v1.2.x

**v1.2.65**——（1）`lib/storage.js` 的 `ytSubtitle.autoTranslate` 預設值從 `false` 改為 `true`（僅影響全新安裝或清除設定的使用者，已儲存設定者不受影響）；（2）YouTube 字幕設定頁模型選單，`gemini-3.1-pro-preview` 說明從「最頂」改為「大炮打小鳥，不推薦」，明確提示字幕翻譯不需要 Pro 等級。

**v1.2.64**——（1）toggle 說明文字換行：`checkbox-label` 內的說明 `<small>` 包進 `<div class="checkbox-body">`，說明文字現在獨立一行顯示在 toggle 標籤下方；（2）Log 區塊分隔：在 YouTube 字幕 section 與 log-toolbar 之間插入 `<section><h2>Log 記錄</h2></section>`，讓兩個區塊有明確視覺邊界。

**v1.2.63**——`ytAutoTranslate` checkbox 的說明文字原為「不需手動按快捷鍵」，但字幕翻譯是由 Popup toggle 控制、與 Option+S 快捷鍵無關；改為「不需手動在 Popup 開啟開關」。

**v1.2.62**——根本原因：`applyUsageSearch()` 只呼叫 `renderTable(filtered)` 更新表格列，四張彙總卡片仍顯示完整日期範圍數字；修法：新增 `updateSummaryFromRecords(records)` 函式，從傳入的記錄陣列重算四個彙總值並寫入 DOM；`applyUsageSearch()` 在 `renderTable(filtered)` 之後立刻呼叫 `updateSummaryFromRecords(filtered)`。

**v1.2.61**——`shortModel`（如 `3.1-flash-lite`）因欄寬不足而折成多行；修法：`renderTable` 的模型欄改為 `<td class="col-model">`，CSS 新增 `.usage-table .col-model { white-space: nowrap; }` 防止折行。

**v1.2.60**——用量紀錄 UI 五項修正：（1）YouTube URL 顯示修正：`shortenUrl` 新增 YouTube watch URL 特判；（2）URL 可點擊：`renderTable` 的網址欄由 `<span>` 改為 `<a>`；（3）搜尋功能：新增 `allUsageRecords` module-level 變數與 `applyUsageSearch()` 函式；（4）網域 / 網址過濾：搜尋框支援輸入網域；（5）時間精度：日期篩選器改為 `datetime-local` 格式。

**v1.2.59**——debug 面板 buffer 欄在 seek 後顯示「翻譯中…」取代虛假正值。根本原因：`translateWindowFrom` 開頭立刻把 `translatedUpToMs` 設為 `windowEndMs`（提前佔位），導致 seek 後 API 還在飛行時 buffer 顯示 `+28s ✓` 等虛假正值；修法：`bufStr` 計算先判斷當前視窗是否在 `translatingWindows`（in-flight）且不在 `translatedWindows`（尚未完成）——若符合，顯示「翻譯中…」。

**v1.2.58**——修正 seek 後「翻譯中…」提示不消失。根本原因：`hideCaptionStatus()` 的呼叫被 `!YT._firstCacheHitLogged` guard 保護；修法：在 `el.textContent !== cached` 的寫入區塊中，將 `hideCaptionStatus()` 從條件內移出，改為每次 `cached` 為真時都呼叫（冪等）。

**v1.2.57**——修正拖動進度條後字幕區未顯示「翻譯中…」。根本原因：`onVideoSeeked` 直接呼叫 `translateWindowFrom` 但沒有先顯示提示；修法：在 `onVideoSeeked` 呼叫 `translateWindowFrom` 之前，檢查目標視窗是否已在 `YT.translatedWindows` Set 中——若不在則先呼叫 `showCaptionStatus('翻譯中…')`。

**v1.2.56**——修正第一視窗冷啟動慢（batch 0 先 await 暖熱 cache）。根本原因：`translateWindowFrom` 用 `Promise.all` 同時送出所有批次，第一視窗大批次（8 units）冷路徑需 13s；修法：將 `Promise.all(batches.map(...))` 拆成「先 `await _runBatch(batches[0], 0)`，再 `await Promise.all(batches.slice(1).map(...))`」——batch 0 以 ~1.5s 暖熱 Gemini implicit cache，之後 batch 1+ 並行走暖路徑（~2s），首條字幕從 ~13s 降至 ~3.5s。

**v1.2.55**——字幕區載入提示（取代 toast）。翻譯啟動後不再顯示 toast 轉圈提示，改為在 `.ytp-caption-window-container` 內注入仿原生字幕樣式的提示元素；`setInterval(100ms)` 持續追蹤位置，動態貼在英文字幕正上方；第一條中文字幕出現時自動移除。

**v1.2.54**——並行視窗翻譯（translatingWindows Set）。根本原因：`YT.translating: boolean` 互斥鎖造成視窗 N 翻譯進行中無法預熱視窗 N+1，形成英文字幕間隙；修法：替換為 `YT.translatingWindows: Set<number>`，以各視窗的 `windowStartMs` 作為 per-window 防重入 key。

**v1.2.53**——修正開頭字幕 20 秒空白（Observer 提前啟動）。根本原因：`await translateWindowFrom()` → `startCaptionObserver()` 的順序導致 Observer 在整個第一視窗翻譯期間完全沒有運行；修法：將 `startCaptionObserver()` 移至 `await translateWindowFrom()` 之前。

**v1.2.52**——Log 持久化（跨 service worker 重啟）。`lib/logger.js` 新增 `persistLog()` 函式，對 `youtube` / `api` / `rate-limit` 三類 log 條目做 fire-and-forget 寫入至 `chrome.storage.local`（key：`yt_debug_log`，上限 100 筆，FIFO 淘汰）。

**v1.2.51**——字幕效能診斷 Log 強化：新增 `sessionOffsetMs` 欄位、`batch done` 詳細 log、`first translated subtitle visible` 事件記錄、`subtitle batch received` 前置耗時 log。

**v1.2.50**——自適應首批大小（adaptive first batch）。以「視窗起點距影片當前位置的 lead time」動態決定 batch 0 條數：`lead ≤ 0` → 1 條；`lead < 5s` → 2 條；`lead < 10s` → 4 條；`lead ≥ 10s` → 8 條（正常）。

**v1.2.49**——設定頁 Debug 分頁重構 + On-the-fly 翻譯開關。（1）設定頁「Log」分頁改名為「Debug」；（2）YouTube debug section 移至 Debug 分頁；（3）Debug 分頁新增「啟用 On-the-fly 備援翻譯」toggle（`ytOnTheFly`，預設關閉）。

**v1.2.48**——修正向後拖進度條後字幕顯示英文（translatedWindows Set 精確跳過判斷）。根本原因：v1.2.46 的 `captionMapCoverageUpToMs` 是高水位線，不保證中間所有視窗都翻過；修法：以 `SK.YT.translatedWindows: Set<number>` 精確記錄每個實際翻譯完成的 `windowStartMs`，`translateWindowFrom` 改為 `if (YT.translatedWindows.has(windowStartMs)) return`。

**v1.2.47**——字幕批次大小從 20 降為 8。字幕段落極短（3–5 字），20 條/批涵蓋 ~33 秒，改為 8 條/批（~13 秒），串流注入讓最早字幕在 ~7s 備妥。

**v1.2.46**——向後拖進度條後 buffer 顯示修正 + 防重複翻譯。新增 `SK.YT.captionMapCoverageUpToMs` 欄位記錄「實際翻過最遠的位置」；`onVideoSeeked` 改為不論向前向後一律重置 `translatedUpToMs = newWindowStart`；`translateWindowFrom` 新增跳過判斷——若 `windowEndMs ≤ captionMapCoverageUpToMs`，直接推進返回，不送 API。

**v1.2.45**——過期視窗追趕機制。`translateWindowFrom` 完成後新增 video 位置檢查：若 `video.currentTime > translatedUpToMs`（API 耗時過長），立刻把 `translatedUpToMs` 跳到 video 當前位置所在的視窗邊界。`SK.YT.staleSkipCount` 計數此事件。

**v1.2.44**——自適應 lookahead。每個視窗翻完後計算 `adaptiveLookaheadMs = min(lastApiMs × 1.3 × playbackRate, 60000)`，下次觸發改用 `max(設定值, adaptiveLookaheadMs)`。

**v1.2.43**——debug 面板各批次耗時逐一顯示。`batch API` 欄位從只顯示第一批完成時間，改為逐批顯示耗時，格式如 `5230 / 7110 / 16770ms`；進行中顯示 `…`。

**v1.2.42**——字幕批次串流注入。將各批次的結果處理移入 `.then()` 回呼，每批一完成立刻寫入 captionMap 並呼叫 `replaceSegmentEl` 替換頁面現有字幕，不等其他批次。

**v1.2.41**——字幕批次翻譯改為並行。將循序 `await` 改為 `Promise.all` 並行——所有批次同時送出，總耗時從 N × T_batch 降為 max(T_batch)，Flash Lite 30 秒視窗由 20 秒降至約 6–8 秒。

**v1.2.40**——debug 面板新增診斷欄位：（1）`buffer`：`translatedUpToMs - video.currentTime`；（2）`last API`：最後一批 API 實際耗時；（3）`on-the-fly`：本 session 累計落入 on-the-fly 備案的字幕條數。

**v1.2.39**——YouTube 字幕用量紀錄修正 + 獨立模型設定。（1）修正字幕翻譯用量未紀錄：新增 `_logWindowUsage` 輔助函式，翻譯完成後呼叫 `LOG_USAGE`；（2）YouTube 字幕獨立模型設定：options 頁新增模型下拉選單與計價欄位；`DEFAULT_SETTINGS.ytSubtitle` 新增 `model: ''` 與 `pricing: null`。

**v1.2.38**——（1）`seeked` / `ratechange` listener 原本在第一批完成後才掛上，提早到 `YT.active = true` 後立刻掛上；（2）debug 面板新增 `speed: Xx` 欄位；（3）移除「多行字幕整合翻譯」設定頁 toggle，功能改為永遠開啟（`preserve` 硬編碼 `true`）。

**v1.2.37**——（1）播放速度補償：`lookaheadMs = lookaheadS * 1000 * playbackRate`；（2）新增 `onVideoRateChange()` 監聽 `video.ratechange`；（3）`debugLog` checkbox 補上 `markDirty` 監聽。

**v1.2.36**——（1）seek 修正：新增 `onVideoSeeked()` 監聽 `video.seeked` 事件，若新位置超出 `translatedUpToMs` 則直接跳到新位置所在的視窗邊界；（2）`yt-reset-prompt` 按鈕加上 `markDirty()` 呼叫。

**v1.2.35**——（1）置中修正：`expandCaptionLine` 擴展到所有 block 容器，到達 `caption-window` 時清除 `margin-left`、改用 `transform: translateX(-50%)`；（2）字幕 prompt rule 7：句末不加句號（。）。

**v1.2.34**——修正字幕展開時閃爍一幀。`expandCaptionLine` 改為同步呼叫（純 CSS style 設定，不需量測 layout），`el.textContent` 與容器寬度同一幀生效。

**v1.2.33**——修正 `expandCaptionLine` 永遠被 `getClientRects` 早返回。`ytp-caption-segment` 是 `display: inline-block`，`getClientRects()` 永遠回傳長度 1；修法：移除該判斷，無條件執行展開。

**v1.2.32**——修正 `expandCaptionLine` 未實際展開字幕框。v1.2.31 只設 `max-width: none` 但沒清除 `width`；修法：同時設 `width: max-content` + segment 本身加 `white-space: nowrap`。

**v1.2.31**——長譯文展開字幕框取代折行。移除 autoScaleFont 後長中文譯文會折行；改用 `expandCaptionLine(el)` 函式向上尋找 block 容器並移除 `max-width` 限制。

**v1.2.30**——移除 autoScaleFont。診斷確認 on-the-fly 與 XHR 預翻字幕大小不一致，使用者接受折行、不接受縮小字型；移除 `autoScaleFont`，兩條路徑統一不縮字型。

**v1.2.29**——修正 autoScaleFont 重複觸發造成字幕閃爍。原本不論文字是否改變都無條件排 rAF；修法：把 `autoScaleFont` 呼叫移入 `el.textContent !== cached` 的 if 區塊內，文字未改變時不觸發縮放。

**v1.2.28**——修正 autoScaleFont 誤縮正常字幕。`SINGLE_LINE_MAX_H = 55px` 固定閾值在較大視窗下誤觸；改用 `el.getClientRects().length > 1` 直接偵測 inline span 是否真的折行。

**v1.2.27**——修正 XHR 到達後仍用 on-the-fly 的問題。v1.2.26 的 `captionMap.size === 0` 分支讓當前視窗實際從未翻譯；修法：移除此分支，一律呼叫 `translateWindowFrom(windowStartMs)` + `attachVideoListener()`。

**v1.2.26**——修正 XHR 攔截失效（強制 CC toggle 重新抓字幕）。CC 已開但播放器不重新發出 XHR 時，`rawSegments=0` 持續；修法：1 秒後呼叫 `forceSubtitleReload()`，偵測 `.ytp-subtitles-button[aria-pressed="true"]` 確認 CC 已開，自動 toggle 關閉再打開，強迫播放器重新抓字幕。

**v1.2.25**——修正 XHR 未攔截時誤顯示「請開啟 CC」。5 秒後同時檢查 `captionMap.size`——若 > 0 改顯示「字幕翻譯進行中（N 條已備妥）」。

**v1.2.24**——修正 autoTranslate 誤報「請開啟 CC」。else 分支改為先顯示「字幕翻譯已啟動，等待字幕資料⋯」（loading 狀態），5 秒後若 `rawSegments` 仍為空才顯示「請開啟 CC」。

**v1.2.23**——長譯文自動字型縮放（autoScaleFont）。新增 `autoScaleFont(el)` 函式，在 rAF 內以 `getClientRects().length > 1` 偵測折行，若折行則以每步 6% 逐步縮小 `font-size`（94%→88%→82%→76%），直到縮回單行。（注：此功能後續 v1.2.28–v1.2.30 持續調整後最終移除）

**v1.2.22**——修正空 segment 父容器殘餘高度。`content.css` 新增 `.ytp-caption-segment:empty { display: none }` 及 `span:has(> .ytp-caption-segment:empty) { display: none }` 隱藏空 segment 及其父容器。

**v1.2.21**——修正 preserveLineBreaks 輸出 literal `\n` 字串。`buildTranslationUnits` 改以空格串接多行（不傳 `\n` 給 LLM）；output 處理新增雙重替換 `.replace(/\\n/g, ' ').replace(/\n/g, ' ')`；system prompt rule 6 改為「單行輸出，不要插入任何換行符號」。

**v1.2.20**——修正 preserveLineBreaks 多行仍顯示問題。移除「happy path」的 `split('\n')` 拆行邏輯；多行 group 永遠採用合併策略：LLM 譯文中的 `\n` 全部替換為空格，完整譯文存入 `unit.keys[0]`，其餘 key 存空字串。

**v1.2.19**——多行字幕整合翻譯（preserveLineBreaks）。新增 `ytSubtitle.preserveLineBreaks` 設定（預設 false，Beta），控制是否把同一 JSON3 event 內的多行字幕合併為一個翻譯單位（後 v1.2.38 改為永遠開啟）。

**v1.2.18**——修正 JSON3 多行歌詞拆行。`parseJson3` 改為 `split('\n')`，每行各自建一條 rawSegments 條目，對齊 DOM 的逐行 segment 粒度。

**v1.2.17**——修正字幕 on-the-fly 誤觸 + debug 面板事件截斷。診斷確認 on-the-fly 的根本原因是 `el.textContent = cached` 本身會觸發 `characterData` MutationObserver 回呼；修法：在 `replaceSegmentEl` 開頭加 CJK 字元偵測，含中日韓字元的文字直接 return。

**v1.2.16**——YouTube debug verbose logging。複用 `ytSubtitle.debugToast` toggle 同時控制 debug 面板與詳細 Log；新增 debug bridge `GET_YT_DEBUG` action。

**v1.2.15**——debug 面板改為即時重繪。抽出 `_debugRender()`；新增 `_debugInterval`（`setInterval(_debugRender, 500)`），面板 DOM 建立時啟動；`_debugRemove()` 清理時先 `clearInterval`。

**v1.2.14**——字幕翻譯即時 debug 面板（`ytSubtitle.debugToast`，預設 false）。開啟後字幕翻譯啟動時在頁面左上角出現綠字面板，顯示 active/translating 狀態、rawSegments 條數、captionMap 大小、translatedUpToMs、影片播放位置、最後一個事件等。

**v1.2.13**——三項修正：（1）options.js 補上 `tab-youtube` 的 `input`/`change` → `markDirty` 監聽；（2）popup 字幕 toggle 標籤改為「YouTube 字幕翻譯」；（3）`content-spa.js` 的 `onSpaObserverMutations` 新增排除條件：位於 `.ytp-caption-window-container` 或 `.ytp-caption-segment` 內部的 DOM 變動不觸發 SPA rescan。

**v1.2.12**——字幕翻譯與 Option+S 職責分離。（1）移除 `SK.translatePage()` 內的 YouTube 路由；YouTube 頁面 Option+S 現在翻譯頁面內容（說明、留言等），與字幕翻譯完全無關；（2）popup 新增「字幕翻譯」toggle，只在 YouTube 影片頁顯示；（3）字幕翻譯的啟動方式僅有兩個入口：popup toggle 或 `ytSubtitle.autoTranslate` 設定。

**v1.2.11**——字幕時間視窗批次翻譯架構 + YouTube 設定頁。（1）`rawSegments` 改為含時間戳的 `[{text, normText, startMs}]`；（2）預翻譯改為時間視窗架構 `translateWindowFrom(windowStartMs)`，`video.timeupdate` 監聽驅動；（3）`lib/storage.js` 新增 `DEFAULT_SUBTITLE_SYSTEM_PROMPT` 常數與 `ytSubtitle` 設定區塊；（4）options 新增「YouTube 字幕」分頁；（5）`content.js` 初始化新增 YouTube auto-subtitle 檢查。

**v1.2.10**——字幕翻譯獨立 Prompt 與 Temperature。新增 `TRANSLATE_SUBTITLE_BATCH` 訊息類型，使用字幕專用 system prompt（逐段翻譯、不合併、口語化）與 temperature 0.1；`handleTranslate` 新增 `geminiOverrides` 參數。

**v1.2.9**——修正 observer 啟動時序。`translateYouTubeSubtitles()` 原先在 `rawSegments` 有資料時先呼叫 `startCaptionObserver()` 再 `await runPreTranslation()`；調換順序為先 `await runPreTranslation()` 完成再 `startCaptionObserver()`，消除英文閃爍。

**v1.2.8**——XHR 攔截預翻譯架構。新增 `content-youtube-main.js`（MAIN world，`run_at: document_start`），monkey-patch `XMLHttpRequest` 與 `fetch`，攔截 YouTube 播放器自己發出的 `/api/timedtext` 請求；字幕原文透過 `shinkansen-yt-captions` CustomEvent 傳給 isolated world，批次送 Gemini 預翻譯；`YT.captionMap` 填滿後 MutationObserver 做瞬間替換，無英文閃爍。

**v1.2.7**——改為即時翻譯架構。診斷確認 YouTube 的 `/api/timedtext` 對所有 JavaScript `fetch()` 一律回傳 200 + 空 body；改為 on-the-fly 即時翻譯：MutationObserver 在 `.ytp-caption-segment` 出現時即時查快取或送 Gemini 翻譯（300ms debounce 批次）。移除 `background.js` 的 `GET_YT_PLAYER_DATA` handler。（注：v1.2.8 重新引入 XHR 攔截，此 on-the-fly 架構改為備援路徑）

**v1.2.5 + v1.2.6**——**YouTube 字幕翻譯 MVP**。新增 `content-youtube.js` 模組，在 `youtube.com/watch` 頁面按 Alt+S 時走字幕翻譯流程；v1.2.6 修正：原 v1.2.5 的 `getYtPlayerData()` 被 YouTube 的 strict CSP 封鎖；改用 `background.js` 新增的 `GET_YT_PLAYER_DATA` message handler，透過 `chrome.scripting.executeScript({ world: 'MAIN' })` 讀取 main world 全域變數。

**v1.2.4**——修正含 `<img>` + `<a>` 結構段落翻譯後連結仍消失問題。根本原因：`translateUnits` 序列化階段遇到 `containsMedia(el)` 為 true 時直接回傳 `slots: []`；修法：移除此早返回，讓含媒體元素的段落也走 `hasPreservableInline` → `serializeWithPlaceholders`。

**v1.2.3**——修正含 `<img>` 元素的段落翻譯後連結變成純文字問題。新增 `tryRecoverLinkSlots(el, text, slots)` 函式——在 `ok=false` 路徑中，以原始 `<a>` 元素的 `textContent` 為 key 搜尋 LLM 譯文字串，若找到對應位置則用 `<a>` shell 包住並建構 DocumentFragment。

**v1.2.2**——修正含 `<img>` 元素的段落翻譯後連結消失問題。`content-inject.js` media-preserving path 清空非 main 文字節點後，若父 inline 元素（如 `<a>`）的 textContent 因此變成空字串且不含媒體子元素，則移除該空殼元素。

**v1.2.1**——修正 Stratechery 等動態 widget 網站 SPA observer rescan 無限循環。`content-spa.js` 新增 `spaObserverSeenTexts` Set，在 `spaObserverRescan` 中過濾掉此 SPA session 內已翻譯過的文字。

**v1.2.0**——修正 SPA observer rescan 無限迴圈。fragment 父元素不帶 `data-shinkansen-translated`，`extractInlineFragments` 在 rescan 時重複收集已翻成繁中的 inline run；修法：`flushRun()` 新增 `isTraditionalChinese` 過濾。

---

## v1.1.x

**v1.1.9**——content script 拆分與程式碼重構。將 3081 行的單一 `content.js` 拆分為 7 個職責分明的檔案：`content-ns.js`（命名空間、STATE、常數、工具函式）、`content-toast.js`（Toast）、`content-detect.js`（段落偵測）、`content-serialize.js`（序列化）、`content-inject.js`（DOM 注入）、`content-spa.js`（SPA + Content Guard）、`content.js`（主協調層）。透過 `window.__SK` 命名空間共用。同步重構：BLOCK_TAGS 統一為 Set、`containsBlockDescendant()` 改用 `querySelector()`、`translatePage()` 合併多次 storage.get。

**v1.1.8**——繁中偵測排除日文韓文。新增兩道防護：（1）檢查 `<html lang>` 屬性，`ja` / `ko` 開頭直接排除；（2）計算假名佔比，假名超過 5% 判定為日文。

**v1.1.7**——繁中偵測改為比例制。`isTraditionalChinese` 原本只要出現任何一個簡體特徵字就判定為非繁中；改為簡體特徵字佔 CJK 字元比例 ≥ 20% 才判定為簡體中文。

**v1.1.6**——改善頁面層級繁中偵測取樣。優先從 `<article>` → `<main>` → `[role="main"]` 取樣，只有都找不到時才 fallback 到 `document.body`，大幅減少 sidebar / nav 文字污染偵測結果。

**v1.1.5**——移除黑名單 + 重新命名白名單。黑名單從未實作任何邏輯，移除設定頁 UI、storage 預設值與匯入驗證；「白名單」面向使用者的文字全部改為「自動翻譯網站」。

**v1.1.4**——修正白名單自動翻譯邏輯。v1.1.2 誤將 `autoTranslate` 當作「全域自動翻譯所有網站」的開關；正確邏輯為 `autoTranslate` 是白名單功能的總開關——開啟時才去查 `domainRules.whitelist`，網域命中才翻譯。

**v1.1.3**——Toast 自動關閉選項。設定頁新增「翻譯完成後自動關閉通知」checkbox，預設開啟；開啟時翻譯完成的 success toast 在 5 秒後自動消失。設定 `toastAutoHide`。

**v1.1.2**——修正白名單自動翻譯首次載入不生效。將比對邏輯抽為共用 `isDomainWhitelisted()` helper，並在 content script 初始化末尾新增自動翻譯檢查。

**v1.1.1**——修正 Toast 預設透明度。v1.0.31 changelog 記載預設透明度改為 70%，但 `lib/storage.js` 的 `DEFAULTS.toastOpacity` 漏改仍為 0.9；本版修正為 0.7。

---

## v1.0.x

**v1.0.31**——Toast 位置選項與預設透明度調整。設定頁「翻譯進度通知」新增「顯示位置」下拉選單（右下角/左下角/右上角/左上角，預設右下角）；Toast 預設透明度從 90% 改為 70%。

**v1.0.30**——用量紀錄表格顯示 cache hit rate。Tokens 欄位下方新增小字 `(XX% hit)` 顯示 Gemini implicit cache 命中率（命中率為 0 時不顯示）。

**v1.0.29**——固定術語表與術語表 Tab。新增「術語表」Tab，包含「固定術語表」（使用者手動指定，全域通用 + 網域專用兩層）與「自動術語擷取」。固定術語優先級最高，注入 system prompt 時放在自動擷取術語之後。儲存在 `chrome.storage.sync` 的 `fixedGlossary` 欄位。

**v1.0.28**——設定頁拆分。原「設定」Tab 拆為「一般設定」與「Gemini」兩個 Tab。Tab bar 變為四個：一般設定 | Gemini | 用量紀錄 | Log。

**v1.0.27**——設定頁術語表區塊加入預設不開啟說明與 README 連結 + README 大幅擴充文件（API Key 申請教學連結、Rate Limit 參考表格、術語表詳細說明、翻譯快取與費用計算段落）。

**v1.0.26**——擴充 `window.__shinkansen` 測試 API。新增 `setTestState()`、`testRunContentGuard()`、`testGoogleDocsUrl()`，`getState()` 增加 `translating`/`stickyTranslate`/`guardCacheSize` 欄位。

**v1.0.25**——設定頁標題下方加入 README 連結 + README 加入 PERFORMANCE.md 超連結。

**v1.0.24**——設定頁 API Key 欄位加入申請教學連結，指向 GitHub repo 的 `API-KEY-SETUP.md`。

**v1.0.23**——SPA 續翻模式。新增 `STATE.stickyTranslate` 旗標：`translatePage()` 完成時設為 true，`restorePage()` 時設為 false，`resetForSpaNavigation()` 保留不清。`handleSpaNavigation()` 優先檢查 stickyTranslate，命中時直接呼叫 `translatePage()`。新增 `hashchange` 事件監聽（Gmail 使用 hash-based 路由）。

**v1.0.22**——排除 ARIA grid 資料格翻譯。`EXCLUDE_ROLES` 新增 `grid`——Gmail inbox 的 `<table role="grid">` 是典型案例。同時新增「grid cell leaf text」補抓 pass——排除整個 td 後回頭掃描 grid cell 內部的純文字 leaf 元素個別翻譯主旨 span。

**v1.0.21**——頁面層級繁中偵測設定化。設定頁新增「語言偵測」區段，提供「跳過繁體中文網頁」checkbox，預設開啟。設定 `skipTraditionalChinesePage`。

**v1.0.20**——Content Guard 架構簡化。刪除 mutation 觸發的路徑 A、刪除 cooldown 機制，只留每秒一次的週期性掃描（`contentGuardInterval`，1 秒間隔）。`runContentGuard()` 修正：元素暫時斷開 DOM 時跳過不刪除 `STATE.translatedHTML` 條目；Guard 掃描只修復可見/即將可見的元素（視窗上下各 500px 緩衝）。

**v1.0.19**——精準化冷卻機制分離覆寫偵測與新內容偵測。重構為雙路徑架構：路徑 A「覆寫偵測」受 `guardSuppressedUntil` 冷卻控制，路徑 B「新內容偵測」永遠活躍但排除已翻譯元素內部的 mutations。

**v1.0.18**——修正 Content Guard 與 rescan 互相觸發迴圈。新增 `mutationSuppressedUntil` 冷卻時間戳，Content Guard 還原或 rescan 注入完成後設定 2 秒冷卻期，冷卻期間 observer 忽略所有 mutations。

**v1.0.17**——Toast 透明度設定。設定頁新增「Toast 提示」區段，提供 10%–100% 的透明度滑桿，預設 90%；設定 `toastOpacity`。

**v1.0.16**——提高 anchor 偵測最短文字門檻。獨立 `<a>` 元素的偵測門檻從 12 字元提高至 20 字元，避免 v1.0.15 移除 NAV 硬排除後主選單短項目被翻譯。

**v1.0.15**——移除 `<nav>` / `role="navigation"` 硬排除。`<nav>` 從 `SEMANTIC_CONTAINER_EXCLUDE_TAGS` 移除、`navigation` 從 `EXCLUDE_ROLES` 移除——Engadget 等網站的 `<nav>` 裡含有使用者想看的內容（趨勢文章標題、麵包屑）。同時移除已不再需要的 `isContentNav()` 白名單機制。

**v1.0.14**——內容守衛機制防止框架覆寫譯文。新增 `STATE.translatedHTML` Map 在翻譯注入時快取每個元素的譯文 HTML；spaObserver 的 mutation 回調新增「是否有 mutation 落在已翻譯節點內」偵測，命中時排程 `runContentGuard()`。

**v1.0.13**——修正無限捲動網站翻譯消失問題。Engadget 等無限捲動網站在捲動時用 `history.replaceState` 更新網址列，被誤判為頁面導航；修法：`replaceState` handler 只靜默同步 `spaLastUrl` 而不觸發導航重設，URL 輪詢新增「已翻譯且 DOM 中仍有 `data-shinkansen-translated` 節點」判斷。

**v1.0.12**——heading 豁免 widget 檢查。`isInteractiveWidgetContainer` 新增 `WIDGET_CHECK_EXEMPT_TAGS` 常數，H1-H6 與 PRE 統一豁免——Substack 等平台在 heading 內嵌入 anchor link 圖示按鈕，觸發 widget 偵測導致整個標題被跳過。

**v1.0.11**——SPA 導航 URL 輪詢 safety net。部分 SPA 框架（如 React Router）在 module 初始化時快取 `history.pushState` 原始參照，content script 的 monkey-patch 攔不到；新增每 500ms URL 輪詢偵測 `location.href` 變化，作為 history API 攔截的 safety net。

**v1.0.10**——排除 contenteditable/textbox 表單控制項。`isInsideExcludedContainer` 新增 `contenteditable="true"` 與 `role="textbox"` 祖先排除——Medium 等網站的留言輸入框用 `<div contenteditable>` 而非 `<textarea>`，翻譯 placeholder 文字會破壞表單互動。

**v1.0.9**——主要內容區域內 footer 放行。`isContentFooter` 新增「footer 有 `<article>` 或 `<main>` 祖先」判斷——CSS-in-JS 網站如 New Yorker 把文章附屬資訊放在 `<main>` 內的 `<footer>` 元素中，應納入翻譯。

**v1.0.8**——`<pre>` 條件排除。將 `<pre>` 從硬排除改為條件排除——僅含 `<code>` 子元素時視為程式碼區塊跳過，不含 `<code>` 的 `<pre>` 視為普通容器。同時豁免 `<pre>` 的 `isInteractiveWidgetContainer` 檢查。新增「leaf content DIV」補抓 pass——CSS-in-JS 框架以 `<div>` 取代 `<p>` 的純文字容器（無 block 祖先、無 block 後代、無子元素、文字 ≥ 20 字）納入翻譯。

**v1.0.7**——Google Docs 翻譯支援。偵測 Google Docs 編輯頁面自動導向 `/mobilebasic` 閱讀版，在標準 HTML 上執行翻譯並自動觸發。

**v1.0.6**——manifest description 修正與文件重構（SPEC.md v1.0 重寫、README.md 重寫、測試流程說明更新）。

**v1.0.5**——修正用量頁面無資料。

**v1.0.4**——程式碼重構與效能最佳化。ES module 化、handler map、debounce storage 寫入。

**v1.0.3**——編輯譯文模式。

**v1.0.2**——每批段數/字元預算改為設定頁選項。

---

## 早期版本（v0.x）

**穩定性與防護（v0.76–v0.88）**：自動語言偵測（跳過已是目標語言的頁面）、離線偵測、翻譯中止（AbortController）、超大頁面段落上限（MAX_TOTAL_UNITS）、SPA 支援（pushState/replaceState 偵測 + MutationObserver）、延遲 rescan、Debug Bridge（main world ↔ isolated world CustomEvent 橋接）、Log 系統（記憶體 buffer 1000 筆 + 設定頁 Log 分頁）。

**UI 與設定（v0.60–v0.99）**：設定頁全面重構（模型管理、計價連動、Service Tier、Thinking 開關、匯入匯出驗證）、Popup 面板（快取/費用統計、術語表開關）、Toast 成本顯示（implicit cache 折扣後實付值）、用量追蹤（IndexedDB + 圖表 + CSV 匯出）。

**全文術語表一致化（v0.69 起）**：翻譯長文前先呼叫 Gemini 擷取專有名詞對照表，注入所有翻譯批次的 systemInstruction。依文章長度三級策略（短文跳過、中檔 fire-and-forget、長文阻塞等待）。術語表快取（`gloss_` prefix）。設定頁術語表區塊。

**並行翻譯與 Rate Limiter（v0.35 起）**：三維滑動視窗 Rate Limiter（RPM/TPM/RPD）、Priority Queue Dispatcher、並行 concurrency pool（`runWithConcurrency`）、429 指數退避 + `Retry-After` 尊重、tier 對照表（Free/Tier1/Tier2）、設定頁效能與配額區塊。

**段落偵測與注入重構（v0.29–v0.58）**：mixed-content fragment 單位、字元預算 + 段數上限雙門檻分批、`<br>` ↔ `\n` round-trip（sentinel 區分語意換行與排版空白）、三條注入路徑統一為 `resolveWriteTarget` + `injectIntoTarget`、slot 重複 graceful degradation（`selectBestSlotOccurrences`）、MJML/Mailjet email 模板 `font-size:0` 相容、媒體保留策略。

**基礎翻譯（v0.13–v0.28）**：單語覆蓋顯示、手動翻譯（Popup 按鈕 + Option+S 快捷鍵）、自動翻譯白名單、Gemini REST API 串接、翻譯快取（SHA-1 key）、還原原文、佔位符保留行內元素（`⟦N⟧…⟦/N⟧` 配對型 + `⟦*N⟧` 原子型）、巢狀佔位符遞迴序列化/反序列化、腳註參照原子保留、CJK 空白清理、技術元素過濾、佔位符密度控制。
