# Pending Regression Tests

> **這是什麼**：待補的 regression test 清單。每筆代表「bug 已修但對應的
> regression spec 還沒寫」(對應 CLAUDE.md 硬規則 9 的路徑 B fallback)。
>
> **誰會讀**：
>   - **Claude Code** 每次新對話會檢查本檔,若非空必須在第一句話提醒 Jimmy
>     (CLAUDE.md「開始新對話時的標準動作」第 4 步);跑完 `npm test` 全綠後若本檔非空,也必須主動提醒
>   - **Jimmy** 看到提醒後可以決定要立刻清,還是先繼續手上的事
>
> **怎麼清**：見 `測試流程說明.md` 的「指令 G:清 pending regression queue」。
>
> **空 queue 的判斷**：本檔只剩本段 header + 「(目前沒有 pending 條目)」
> 那行 placeholder = 空。任何在「## 條目」section 之下的內容都算待清。

---

## 條目

### ~~splitOnSameRow / splitOnLeftShift 縱向切分規則的正向案例——synthetic fixture 咬不住（dev tail 2.0.74.1 修）~~
- ★ **已清（2026-08-05，批次 8 H5 走路徑 A）**：layout-analyzer 把 analyzePage 步驟 4 的 per-column 迴圈抽成可注入 column assignment 的純函式 `splitIntoBlocksByAssignment` 並 export（純搬移不改行為）→ `test/unit/layout-split-by-assignment.spec.js` 4 case 手工指定「全部 line 同一 column」完全繞過 K-means，splitOnSameRow / splitOnLeftShift 正向案例各自隔離覆蓋（Case 1 座標刻意壓 leftShift 閾值以下，讓兩條規則的 SANITY 各自只 fail 自己的 case——不再假覆蓋）。SANITY 兩輪已驗（①拔 splitOnLeftShift → Case 2 fail;②拔 splitOnSameRow → Case 1 fail；還原皆 pass）。Plano 真翻譯 Read 譯文 PDF 驗收無回歸。本條即原「建議方向」第一項的落地。
- **症狀**:spec sheet 的 label 欄行（x=40）被吸進 value 欄（x=166）的 list 區塊（Trimble p1-b39）;同 visual row 的 cell line 因垂直 gap 為負被縱向串成 franken block（Quotation TDC6 表頭「QTY|Unit Cost」與金額 rows 黏成 ln=3 一塊）。
- **修在**:`shinkansen/translate-doc/layout-analyzer.js` `splitColumnIntoBlocks` 新增 `splitOnLeftShift`（左緣位移 > 6× mlh,置中 / 靠右對齊豁免）與 `splitOnSameRow`（top 幾乎相同即切）。
- **已有覆蓋**:`test/unit/layout-cell-granularity.spec.js` Case 4 驗「同 row cell 不 collapse」整合結果、Case 5 驗置中豁免（負向）;SANITY 過。真 PDF 驗證走本機 `npm run pdf-snapshot`（Quotation TDC6 表格區 per-cell / Trimble p1-b39 label 獨立,baseline 已含新行為）。
- **為什麼正向案例還不能寫 spec**:synthetic fixture 中 K-means 欄位偵測會先把測試座標分進不同 column → block 本來就分開,斷言分不出「是哪條規則切的」（SANITY 破壞 splitOnSameRow 後 spec 照樣綠 = 假覆蓋,依 §9 不硬寫）。要咬住需構造「欄位偵測判單欄但含同 row cell」的輸入,K-means 對 line lefts 的行為難以在小 fixture 穩定控制。
- **建議方向**:若日後 layout-analyzer 把 splitColumnIntoBlocks 抽成可注入 column assignment 的純函式,直接 unit 驅動即可補上;或本機 snapshot 套件納入 CI 的話此條可永久結案。

### ~~術語表帶（原文）對照的 target 被模型剝掉對照——LLM 行為層無法 fixture 化（dev tail 2.0.53.1 修）~~
- ★ **關閉(2026-07-13,Jimmy 決定永久結案)**:修法已隨 v2.0.54 release(prompt 措辭 + collapseDoubledTitleMarks 路徑 A);LLM 服從度層打真 API、非決定性,永久 path B。日後回歸用 `tools/probe-glossary-annotation.mjs` 手動 probe。程式側 mangle 變體已另走路徑 A 修復(v2.0.55,`epub-translate.spec.js` SANITY ⑪)。
- **症狀**:EPUB 全書術語表 entry「Changing Rooms → 《變換房間》（Changing Rooms）」（對照一次未勾）,譯文只出現《變換房間》,（Changing Rooms）對照被砍(2026-07-12 Jimmy 回報,session 真實資料 c9-b169);另一表現:模型在已含《》的譯名外再自包一層變「《《雷霆谷》》」。
- **根因**:`system-instruction.js` 術語表注入指令句尾「…也不需加註英文原文」與帶對照的 target 自相矛盾——模型讀到就把 target 裡的（原文）剝掉。真 API probe(`tools/probe-glossary-annotation.mjs`,忠實重現 production prompt 組裝)重現:舊指令 3.5-flash 3 輪只保留 1 輪、lite 3 輪保留 2 輪。
- **修在**:(1) `lib/system-instruction.js` 注入措辭改「右欄字串的所有部分——包括書名號與括號內的原文對照——都是指定譯名的一部分,每次出現都要完整輸出」＋「已含書名號不要再外包一層」——新指令 probe 3.5-flash 5/5、lite 全保留、零雙書名號;(2) 雙重書名號已另走路徑 A(`collapseDoubledTitleMarks` 接收鏈確定性收斂,`test/unit/placeholder-mangled-repair.spec.js`,SANITY 過)。
- **為什麼 (1) 進 PENDING**:斷言對象是「模型對帶對照 target 的服從度」,要打真 API、花錢、非決定性(機率性剝除),Playwright fixture 架構放不下。日後要覆蓋走 probe script 手動跑(需 `~/.shinkansen-test-key`),不進 `npm test`。屬永久 path B 性質,可由 Jimmy 決定結案。
- **注意**:cache key 不含注入指令文字,舊快取(被剝對照的譯文)不會自動失效——bump 時 CHANGELOG 應寫「建議手動清快取」;既有書重勾章節真重翻即可吃到新 prompt。
- **補充(2026-07-12,dev tail 2.0.54.1)**:同書再回報的「大製騙家(《大製騙家》)」症狀是**另一條路徑**——模型剝《》但保留對照時,合規掃描自動替換把對照括號內的原文也換成譯名(程式側 mangle,非 LLM 剝除)。該路徑已走**路徑 A**修復(`epub-translate.spec.js` SANITY ⑪:skipAnnotated 對照保護 + 補書名號 + 舊殘影修復),與本條 LLM 行為層互為補充,不影響本條結案判斷。

### ~~Debug Bridge GET_STORAGE 對 orphan content script 的防護——reload 時序無法穩定 fixture 化（dev tail 2.0.52.1 修）~~
- ★ **關閉(2026-07-13,Jimmy 決定永久結案)**:修法已隨 v2.0.53 release(try/catch 包 GET_STORAGE 分支);orphan 時序 Playwright 下不穩定,影響面僅 debug 工具(使用者不觸發 bridge),風險低。
- **症狀**:extension reload 後,舊分頁的 orphan content script 收到 Debug Bridge `GET_STORAGE` 請求時,`chrome.storage` 存取**同步** throw「Extension context invalidated」——`.catch` 接不到 → uncaught error 累積在 chrome://extensions 錯誤清單(2026-07-11 Jimmy 回報,實際觸發者是 Claude 對 reload 前的舊分頁跑 GET_STORAGE)。
- **根因**:bridge 內只有 GET_STORAGE 直接碰 chrome API(其餘 action 走 `SK.safeSendMessage`,該層已有 context-invalidated 防護),且同步 throw 不走 Promise `.catch`。
- **修在**:`content.js` GET_STORAGE 分支整段包 try/catch,context 失效時 respond 明確錯誤訊息(respond 走 DOM CustomEvent,context 失效後仍可用)。
- **為什麼進 PENDING**:最小重現需要「extension reload → 舊分頁 content script 變 orphan → 對 orphan dispatch bridge 事件」的時序編排,Playwright 下 RELOAD_EXTENSION + CDP isolated context 存活狀態不穩定,硬寫斷言會 flaky。影響面僅 debug 工具(使用者不觸發 bridge),風險低,可由 Jimmy 決定是否永久結案。

### ~~術語表 prompt 日文 source 羅馬化——LLM 行為層無法 fixture 化（dev tail 2.0.51.1 修）~~
- ★ **關閉(2026-07-13,Jimmy 決定永久結案)**:修法已隨 v2.0.52 release,真 API probe 已驗(新 prompt 3 輪 0 拉丁化);升級路徑已走路徑 A(`glossary-prompt-ja-source-upgrade.spec.js`)。模型字系服從度屬 LLM 行為層,永久 path B。
- **症狀**:日文書 EPUB 抽全書術語表,212 條 source 全是羅馬拼音(Aizawa / Hitoshi Kashiwaki…)而非原文日文——譯後一致性掃描 `checkGlossaryCompliance` 拿 source 比對日文原文永遠比不中,整批條目默默失去保護;翻譯時譯名規則也變不可靠。
- **根因**:舊 `DEFAULT_GLOSSARY_PROMPT` 自稱「英中對照術語表」+ 範例全拉丁字母,無「source 必須逐字取自原文」規則。**模型相依**:gemini-3.1-flash-lite 對日文輸入仍回日文 source(短文 / 8K / 60K 皆是),`gemini-3.5-flash` 則 17/17 全轉羅馬拼音(真 API probe 重現,2026-07-11)。
- **修在**:`lib/storage.js` DEFAULT / UNIVERSAL_GLOSSARY_PROMPT 加 `<source_fidelity>` 區塊(source 逐字取自原文、保持原文字系、禁羅馬化)+ 日文範例(相沢→相澤)+ 日文漢字台灣字形規則;`_normalizePromptForComparison` 加 v2.0.52 rules 讓舊 saved 字面值視為未客製。
- **已驗證**:真 API probe(gemini-3.5-flash,舊 prompt 破壞態 17/17 拉丁 → 新 prompt 3 輪 0 拉丁、16/16 逐字存在原文);升級路徑已走路徑 A(`test/unit/glossary-prompt-ja-source-upgrade.spec.js`,SANITY 過)。
- **為什麼 LLM 層不能寫測試**:斷言對象是「gemini-3.5-flash 對日文輸入的 source 字系」,要打真 API、花錢、非決定性,Playwright fixture 架構放不下。若日後要覆蓋,方向是 tools/ probe script(需 `~/.shinkansen-test-key`)手動跑,不進 `npm test`。屬永久 path B 性質,可由 Jimmy 決定結案。
- **第二輪(同 dev tail,2026-07-11)**:Jimmy 重抽後回報兩個殘餘症狀:(a) target 被填成分類代號(「金谷 → place」)——已走路徑 A(`isValidGlossaryEntry` 協定層驗證 + `glossary-json-parsing.spec.js` 新 case,SANITY 過);(b) 無通行譯名的作品名原文照抄進書名號(《背いて故郷》)——prompt 作品名規則加日文範例釘死方向,3.5-flash probe 由 1/3 服從提升到 3/3(此部分同屬本條 LLM 行為層,無法 fixture 化)。

### ~~code review 2026-07-08 R1 — streaming 路徑 rate limiter + 失敗路徑記帳(dev tail 2.0.7.1 修)~~
- ★ **關閉(2026-07-09,Jimmy 決定)**:修法已隨 v2.0.8 release;streaming 記帳測試要 mock SSE reader + usage-db + limiter 三方,工程成本高、修法屬記帳補齊性質,Jimmy 決定不補測試永久結案。日後若對帳再出現系統性低估,回頭以本條「修在」清單為起點排查。
- **症狀**:(a) handleTranslateStream 完全 bypass rate limiter——RPM/TPM 視窗低估、RPD 每頁少計 1，免費層連續翻頁 batch 1+ 撞 429;(b) streaming 取消 / 中途失敗 / hadMismatch 丟棄結果時，SSE 已解析的已付費 usage 無人記帳(對帳系統性低估，v1.10.46 批次 2-5 只修了 non-streaming);(c) openai-compat 多 chunk 中途失敗 / 逐段 fallback 半途失敗同樣不掛 err.usage、handleTranslateCustom 無 partialFailure 記帳(多引擎 drift)。
- **修在**:`background.js` handleTranslateStream(limiter.acquire + logDiscardedStreamUsage 三處)/ handleTranslateCustom(catch 記帳);`lib/gemini.js` translateBatchStream(err.usage 掛載，含 blocked / emptyContent);`lib/openai-compat.js` translateBatch chunk 迴圈 + 逐段 fallback(err.usage)。
- **為什麼還不能寫測試**:streaming 記帳要 mock SSE reader + usage-db + limiter 三方，現有 `limiter-init-lock-partial-usage.test.cjs` 的 brace-counting 手法可延伸(抽 handleTranslateStream 太大，建議只鎖「translateBatchStream 的 catch 有掛 err.usage」source 斷言 + logDiscardedStreamUsage 行為)。
- **建議 spec 位置**:test/jest-unit/streaming-partial-usage.test.cjs

### ~~code review 2026-07-08 R2 — YT/Drive 換片 race 與字幕注入守門(dev tail 2.0.7.1 修;(c) 已清)~~
- ★ **關閉(2026-07-09,Jimmy 決定)**:(c) 已走路徑 A(見下);餘 (a)(b) 的 SPA 換片 race 需「in-flight 批次跨 stop-restart」時序、(d) 需真 timedtext 多軌時序,fixture 難穩定重現,屬永久 path B 性質,Jimmy 決定不補測試永久結案。修法已隨 v2.0.8 release。
- ★ **(c) 已清(2026-07-08,走路徑 A)**:`test/regression/youtube-cjk-source-inject.spec.js`——isolated world 直接驅動 `SK._replaceSegmentEl`,假 captionMap ja 原文→中譯斷言 segment 被替換;注入後同 el 再回呼斷言不進 onTheFly(pendingQueue / onTheFlyTotal 不增)。SANITY 兩輪已驗(①加回 RE_CJK 式防禦 → Case 1 fail;②拿掉 `_injectedSegmentText` 自我迴圈 guard → Case 2 fail;還原皆 pass)。訊號層:不驗 YouTube 真實 caption MutationObserver 觸發時序 / overlay 視覺。餘 (a)(b)(d) 維持 path B(見下)。
- **症狀**:(a) stopYouTubeTranslation 不 bump captionSourceGen → SPA 換片後舊影片 in-flight 批次把譯文 / displayCues 寫進新影片 session(_runAsrSubBatch / heuristic _runBatch / _injectBatchResult 三個寫回點原本無 active/gen 檢查);(b) activation 的 tick1/tick5/65s timer 是 closure 變數，stop 清不到，跨 session 誤報「沒有字幕」;(c) replaceSegmentEl 用 RE_CJK 一刀擋含 CJK 原文 → ja/ko 源語人工字幕單語模式譯文永遠注入不進去(API 照燒),target=en 時該防禦也無效——改 _injectedSegmentText WeakMap 快照比對；(d) Drive 換軌不清舊 entries(新舊軌譯文疊加)、currentEntryIdx 純索引在 push+sort 後失效、_findActiveEntryIdx 無 nextStart clamp(與 YT _findActiveCue drift)。
- **修在**:`content-youtube.js`(stop bump gen + 三寫回點守門 + _sessionAlive timer gate + _injectedSegmentText)/ `content-drive.js`(fingerprint 換軌清 entries、sort 後 idx sentinel、effectiveEnd clamp)。
- **為什麼其餘還不能寫測試**:(a)(b) SPA 換片 race 需要「in-flight 批次跨 stop-restart」時序，fixture 難穩定重現;(d) Drive 換軌需真 timedtext 多軌時序。視需要再補。

### ~~code review 2026-07-08 R3 — 序列化/注入路徑 drift 六條(dev tail 2.0.7.1 修;(a)(f) 已清)~~
- ★ **關閉(2026-07-09,Jimmy 決定)**:(a)(f) 已走路徑 A(見下);餘 (b) 需 jsdom 驅動內部函式、(c)(d)(e) 為防禦性小修單條 ROI 低,Jimmy 決定不補測試永久結案。修法已隨 v2.0.8 release,對應區域日後出 bug 再按當時症狀補。
- ★ **(a) 已清(2026-07-08,走路徑 A)**:`test/regression/dual-inline-button-preserved.spec.js`(2 case:dual 注入後原段落 BUTTON 仍在原位 + wrapper 內是 clone;echo skip 不把按鈕吃進 throwaway frag)。SANITY 兩輪已驗(①deserializer cloneReuse 分支改 `if (false)` → Case 1 fail;②只拿掉 echo 比對呼叫點的 `{cloneReuse:true}` → 兩 case 各自獨立 fail;還原皆 pass)。A3 探測呼叫點共用同一 cloneReuse 分支,由 SANITY ① 覆蓋。
- ★ **(f) 已清(2026-07-08,走路徑 A)**:`test/regression/spa-bytext-reuse-restore.spec.js`——驅動 `SK.spaByTextReuse` 斷言注入前有 snapshotOnce(STATE.originalHTML 有 entry 且為原文),並走 Debug Bridge RESTORE 驗還原後不殘留殭屍譯文。SANITY 已驗(註解掉 snapshotOnce → 兩斷言 fail,還原 pass)。餘 (b)(c)(d)(e) 維持 path B(見下)。
- **症狀**:(a) deserializeWithPlaceholders 的 reuseNode(inline BUTTON)在「frag 不注回原 el」的三個呼叫點(dual 重建 / echo 比對 / A3 探測)把活的原按鈕 detach 走——dual 模式原段落失去互動按鈕、echo skip 時按鈕永久消失；(b) countPairedInlineForGT 漏計 BUTTON 與「block 唯一子 A」兩種 paired 來源，>5 對 cap 被繞過 → Google MT garbage token;(c) plainTextFallback / fragment ok=false fallback 不做 \n→`<br>` 還原；(d) _revertEcho 不清 nodeValueMutateBackup → guard 把 echo 防重送標記拆掉；(e) restoreOnInnerMutation 缺 contenteditable 守門(使用者編輯內容被第三方 mutation 觸發的回寫蓋掉);(f) spaByTextReuse 不 snapshotOnce → 還原後殭屍譯文段。
- **修在**:`content-serialize.js`(cloneReuse 選項 + count 鏡像)/ `content-inject.js`(三呼叫點傳 cloneReuse、兩處 br fallback、_revertEcho 清 backup)/ `content-spa.js`(contenteditable + snapshotOnce)。
- **為什麼其餘還不能寫測試**:(b) 需 jsdom 驅動內部函式或真 fixture 過 GT 序列化;(c)(d)(e) 為防禦性小修,單條 ROI 低,對應區域出 bug 再按需補。

### ~~code review 2026-07-08 R4 — content 主流程狀態機四條(dev tail 2.0.7.1 修;(a) 已清)~~
- ★ **關閉(2026-07-09,Jimmy 決定)**:(a) 已走路徑 A(見下);餘 (b)(d) 需特定失敗時序 mock(streaming 中途斷 / http:// insecure context)、(c) 屬防禦性補齊,Jimmy 決定不補測試永久結案。修法已隨 v2.0.8 release。
- ★ **(a) 已清(2026-07-08,走路徑 A)**:`test/regression/translate-all-failed-no-mark.spec.js`——mock 訊息層全批回 error,走真實 `translatePage`:斷言 STATE.translated=false、DOM 無 translated 標記、CLEAR_BADGE 已送、第二次呼叫走重翻(批次計數增加)而非 restorePage。SANITY 已驗(guard 改 `if (false && …)` → 三斷言 fail,還原 pass)。訊號層:驗 Gemini 主路徑;Google 路徑同款 guard 為同形鏡像不重複驅動。餘 (b)(c)(d) 維持 path B(見下)。
- **症狀**:(a) 全數批次失敗(done=0，如 API key 沒填)仍標 STATE.translated=true + sticky + rescan + SPA observer——下次快速鍵誤走 restorePage、對注定失敗頁反覆重送 API、badge 紅點殘留(Gemini / Google 兩路徑同修；units=0 早退與 catch 路徑也補 CLEAR_BADGE);(b) streaming batch 0 mid-failure fallback 重跑整批時 done 重複累計(進度顯示 32/25);(c) 空字串 unit 防護只在 Gemini 路徑，translateUnitsGoogle 漏(protocol 層雙路徑 drift);(d) glossary 的 SK.sha1 在 http:// 頁(無 crypto.subtle)throw 在 try/finally 保護區之前，STATE.translating 永久卡死。
- **修在**:`content.js`(done===0 guard ×2、CLEAR_BADGE ×4、batch0StreamDone 扣回、Google 路徑 _kept 過濾、crypto.subtle gate)。
- **為什麼其餘還不能寫測試**:(b)(d) 需特定失敗時序 mock(streaming 中途斷 / http:// insecure context);(c) Google 路徑空 unit 過濾可延伸既有 google-translate spec,視需要再補。

### ~~code review 2026-07-08 R5 — 偵測層三條(dev tail 2.0.7.1 修；結構性，bump 輪必跑 full suite)~~
- ★ **已清(2026-07-08,三條全走路徑 A)**:
  - (a) `test/regression/detect-svg-anchor-skip.spec.js` + fixture——SVG `<a><text>` 不進 units、所有 element unit 皆 HTMLElement、HTML leaf `<a>` 對照組照常補抓。SANITY 已驗(註解掉 instanceof gate → svgAnchorCollected=true fail,還原 pass)。訊號層:驗偵測端;content.js `innerText ?? textContent` 兜底屬防禦層不驗(序列化 map 為內部閉包)。
  - (b) `test/regression/detect-hidden-container-skip.spec.js` + fixture——display:none Case B 容器不進 units、可見對照組 containerWithBr=1。SANITY 已驗(拿掉 `SK.isVisible(el) &&` → hiddenCollected=true fail,還原 pass)。
  - (c) `test/regression/extract-svg-keep.spec.js`(host 頁重用 extract-page-html fixture)——hardenExtractedHtml 保留無文字 inline svg、仍刪真正空殼。SANITY 已驗(改回 `KEEP.has(node.tagName)` → keptSvg=false fail,還原 pass)。
- ~~**症狀**:(a) leaf-anchor 補抓收 SVG `<a>`(querySelectorAll('a') 也匹配 SVGAElement，無 innerText)→ translateUnits 序列化 TypeError 整頁翻譯失敗(probe 實測重現);(b) 非 block 容器 Case A-F 全程不查 SK.isVisible,display:none 容器照收照翻燒 token(probe 實測);(c) content-ns hardenExtractedHtml 的 KEEP 集合寫大寫 'SVG' 但 SVG tagName 是小寫 → 送 Instapaper 的擷取 HTML 裡 inline SVG 圖整顆被空殼修剪刪掉。~~
- ~~**修在**:`content-detect.js`(HTMLElement instanceof gate + isVisible gate)/ `content.js`(innerText ?? textContent 兜底)/ `content-ns.js`(tagName.toUpperCase())。~~

### ~~code review 2026-07-08 R6 — UI / PDF / lib 雜項(dev tail 2.0.7.1 修，多數低風險)~~
- ★ **關閉(2026-07-09,Jimmy 決定)**:2 條已有 jest 覆蓋(見下),其餘為 UI 事件 / storage 監聽 / timeout 行為,單條 ROI 低,Jimmy 決定不補測試永久結案。修法已隨 v2.0.8 release,對應區域日後出 bug 再按需補。
- **內容**:options 跨頁 stale 覆寫(glossary.enabled / ytSubtitle.autoTranslate 加 storage.onChanged 反向同步)、懸浮按鈕短按 400ms 冷卻(雙擊誤觸 abort)、update banner URL 抽 lib/update-check.js buildUpdateDownloadUrl 單一資料源(options 版補上 Safari 直下 .pkg)、log-search 150ms debounce、log 明細 DOM id 改穩定三元組 key、fw-detect 'none' 不進 WeakMap 快取(SSR hydration 前誤釘死)、sticky onRemoved 先 hydrate、testGeminiKey / testCustomProvider / Drive timedtext fetch 補 timeout、usage-db CSV 公式注入中和、cache estimateEntrySize 改 UTF-8 bytes 估算、logger persistLog 300ms debounce 批次 flush、translate-doc resolvePreset 改 find-by-slot、handleFile 換檔 abort 舊 parse、cachedPresets storage.onChanged 失效、openReader gen token、reader destroyed flag、preset row innerHTML 改 createElement、pdf-renderer dead code 移除。
- **已有覆蓋**:cache 清 doc regex(`cache-clear-doc-regex.test.cjs`,SANITY 過)、sanitizeImport instapaper 兩鍵(`options-sanitize-import-missing-fields.test.cjs` 新 describe,SANITY 過)。
- **為什麼其餘還不能寫測試**：多為 UI 事件 / storage 監聽 / timeout 行為，單條 ROI 低；若日後對應區域出 bug 再按需補。

### ~~NYT 類猛重繪 React 站:nv-mutate 圖說被 framework 反覆重繪打回英文(2026-07-02,dev tail 2.0.2.1)~~
- ★ **關閉(2026-07-02,Jimmy 決定)**:偵測缺口那層已走 path A 修好(`spa-nv-guard-multinode-revert.spec.js`);殘留「打不贏 NYT 持續高頻重繪競賽 → 圖說仍卡英文」接受為**已知限制**(§15「救不回的場景不改架構」),Playwright 也模擬不出 NYT 的持續重繪 + lazy-load 時序。已移入 **SPEC-PRIVATE §28.3 已知殘餘**(含日後架構級評估方向),不再佔活動 queue。

### ~~回復預設設定排除 Instapaper 帳號連結(2026-06-22,dev tail 1.10.68.1 修)~~
- ★ **已清(2026-07-02,轉 path A)**:抽出 `resetSyncPreservingLinks(storage)` 純函式(reset 邏輯脫離 DOM click),`test/jest-unit/options-reset-preserve-instapaper.test.cjs`(3 case)用 brace-counting 抽函式 + 假 storage 驗保留/還原邏輯。SANITY 已驗(改回裸 `storage.clear()` → 已連結/部分連結兩條 fail,還原 pass)。訊號層界定:驗保留/還原邏輯對 storage 的呼叫序列,不驗真 options 頁按鈕在 Chrome/Safari runtime 端到端行為。
- ~~**症狀**:options「回復預設設定」按鈕(`storage.sync.clear()`)會把 Instapaper 帳號連結(`instapaperToken` / `instapaperTokenSecret` / `instapaperUsername`)一起清掉,使用者得重新輸入密碼連結。帳號連結是一次性 OAuth 授權,不該被「回復偏好」清掉。~~
- ~~**修在**:`shinkansen/options/options.js` `reset-defaults` handler —— clear 前先 `sync.get(RESET_PRESERVE_KEYS)`、clear 後把實際存在的 key 寫回。~~

### ~~options「按鈕透明度」範例 icon 跟著「按鈕大小」變動(2026-06-22,dev tail 1.10.68.1 修)~~
- ★ **關閉(2026-07-02,Jimmy 決定)**:純 options 頁 UI 預覽(調「按鈕大小」時範例 icon 跟著變寬高),修法為視覺回饋類,已人工驗收正常。Jimmy 判定不需自動化測試 → 結案,不再佔活動 queue。
- ~~**症狀**:options 懸浮按鈕 section 調「按鈕大小」(16 / 32)時,「按鈕透明度」旁的範例 icon 不會跟著變大小,與真實按鈕不一致。~~
- ~~**修在**:`shinkansen/options/options.js` 加 `_renderFloatingSizeDemo()`(讀 checked radio 設 `#floatingOpacityDemo img` 的 width/height),於 `load()` 與 size radio `change` 觸發。~~

### ~~Safari 選「功能選單」整頁 refresh — 改叫原生 popup(2026-06-22,v1.10.69 修)~~
- ★ **關閉(2026-06-22,Jimmy 真機驗收)**:1.10.68.3 TestFlight 真機回報「功能選單」正常叫出、不再 refresh → Safari 分支(openPopup / 新分頁)生效。Safari 原生路徑 Chromium 永遠重現不出(同其他 Safari path B),靠真機 ground truth 結案,不再佔活動 queue。
- ⚠ **Safari 路徑未在 Chromium 重現**:openPopup / Safari iframe 限制都只在真 Safari 發生,**待 Jimmy 真機 Safari 驗收**。
- **症狀**(Jimmy 真機回報):長按懸浮按鈕 → 選單出現 → 點「功能選單」→ 整頁 refresh(翻譯過 / 沒翻譯過都會)。
- **根因**:`openFeaturePanel()`(v1.10.68 新功能)在網頁裡 iframe 載入 `popup.html?panel=1`。Safari 不允許在 https 網頁的 iframe 載入 `safari-web-extension://` 擴充頁(已知限制,WebSearch 證實:CSP child-src/default-src 擋、insecure content 擋),iOS 上表現為整頁 refresh。桌面 Chrome 正常(已驗)。原 code 註解「Safari 無法程式化開原生 popup」過時——Safari 16+ 已支援 `browser.action.openPopup()`。
- **修在**:`shinkansen/content-floating-icon.js` openFeaturePanel 依 `isSafariRuntime()` 分流——Safari → `SK.safeSendMessage({type:'OPEN_FEATURE_MENU'})`,不走 iframe;非 Safari → `openFeaturePanelIframe()`(原頁內浮層,行為不變)。`shinkansen/background.js` 加 `OPEN_FEATURE_MENU` handler:`browser.action.openPopup()`,失敗則 `tabs.create(popup.html)`。
- **為什麼 path B**:Chromium 走非 Safari 分支(iframe,既有 spec 已覆蓋);Safari 分支(openPopup / 新分頁 / iframe refresh 限制)Chromium 永遠重現不出。靠真機 Safari 驗收結案。
- **真機驗收項**:長按 → 功能選單 →(a)不再 refresh;(b)叫出原生工具列 popup(理想)或新分頁載入 popup.html(openPopup 失敗 fallback)。

### ~~toast 在嚴格 CSP 站點(Safari)裸露顯示「翻譯中…」(2026-06-21,v1.10.63 修)~~
- ★ **關閉(2026-06-21,Jimmy 決定)**:Safari content script 不免疫頁面 CSP 的差異屬永久 path B——Playwright **Chromium 重現不出**(Chrome content script 免疫頁面 CSP,帶嚴格 CSP 的 fixture 上舊 `<style>` 也照樣生效 → spec 只會得到假綠),且 toast 是 `mode:'closed'` shadow、spec 無法內省 `adoptedStyleSheets`。修法早已 in place(Constructable Stylesheet)+ **iOS 模擬器真 WebKit before/after 截圖**驗過生效。無對應自動測試可補 → 關閉,不再佔活動 queue。
- ~~**症狀**:iOS Safari 上,某些站點(實例:miniflux)一載入頁面,左上角就冒出卡住的「翻譯中…」toast——沒觸發任何翻譯、自動翻譯也沒開。看到的是 toast 範本的預設文字(非真實 loading 訊息,真訊息會帶數字),且位置不對(裸露無樣式)。Chrome / 桌面看不到。~~
- ~~**根因**:miniflux 送嚴格 CSP `style-src 'nonce-...'`(無 unsafe-inline)。Safari 的 content script **不像 Chrome isolated world 那樣免疫頁面 CSP** → toast 注入的 shadow `<style>` 被 `style-src` 擋掉 → `display:none` 與全部樣式失效 → toast 裸露顯示範本字。~~
- ~~**修在**:`shinkansen/content-toast.js` —— toast 樣式改用 Constructable Stylesheet(`shadow.adoptedStyleSheets = [sheet]`,`sheet.replaceSync(TOAST_CSS)`)注入,不再用 `<style>`。JS API 建的樣式表不受 `style-src` 管。同時還原 v1.10.62 的 visualViewport 定位改動(那是基於錯誤假設的多餘複雜度,真兇是 CSP)。~~
- ~~**已驗證(ground truth)**:**iOS 模擬器(iPhone 17,iOS 26.5)真 WebKit before/after 截圖** —— 修前 miniflux 登入頁左上角有「翻譯中…」幽靈,套修法 rebuild 後消失;桌面 cage 另驗正常 toast(adoptedStyleSheets 路徑)樣式完整、右下角正常顯示。既有 9 條 toast spec 全綠確認重構無回歸。~~

### ~~送 Instapaper — EXTRACT_PAGE_HTML 只由最上層 frame 回應(2026-06-15)~~
- ★ **關閉(2026-06-18,Jimmy 決定)**:跨 frame 廣播搶答的時序屬永久 path B(同 M1/M2)——Playwright harness 走單一頂層 frame、`getShinkansenEvaluator` 只接頂層 isolated world,重現不出「哪個 frame 先回應」,寫不出乾淨 spec。修法早已 in place(`content.js` 非頂層 frame 不回應)+ cage 實機驗過生效(bookmark 2020084398 = 乾淨譯文、無影片)。無對應自動測試可補 → 關閉,不再佔活動 queue。
- ~~**症狀**:含內嵌 youtube(或任何 iframe)的頁面送 Instapaper,存下來變成「影片」而非主文。實機 readtrung 驗到:送出的 content 是 youtube-nocookie iframe frame 回的「影片嵌入頁」(347 字、標題=影片名)。~~
- ~~**根因**:content script `all_frames: true` → 內嵌 iframe 也跑 content script;popup / background 用 `browser.tabs.sendMessage(tabId, {type:'EXTRACT_PAGE_HTML'})` **未指定 frameId** → 廣播到所有 frame → iframe frame 先回應就回它自己的文件。~~
- ~~**修在**:`shinkansen/content.js` EXTRACT_PAGE_HTML handler 加 `if (window.top !== window) return false;`(非頂層 frame 不回應)。~~
- ~~**為什麼 path B**:重現需「真實多 frame 頁面 + `browser.tabs.sendMessage` 廣播 + 哪個 frame 先回應的時序」。Playwright regression harness 走 `evaluate` 直呼 `window.__SK.extractPageHtml(document)`(單一頂層 frame)、`getShinkansenEvaluator` 只接頂層 isolated world,測不到「跨 frame 廣播搶答」。已用實機 cage(temp hook 真送 + Read bookmark)驗證修法生效(bookmark 2020084398 = 乾淨譯文、無影片)。~~

<!-- iOS host app 設定畫面回填 extension 真值（反向 push extApiKey/extModel,v1.10.43）清空紀錄
  （2026-06-09,Jimmy 真機驗收完成）:
  - 症狀:host app「API Key 與預設模型設定」畫面進入時只讀 host 自己寫過的 hostApiKey/hostModel
    （host 上次推的值,非 extension 真值）→ 顯示空白 / 舊值 → 按儲存覆寫現值（尤其預設翻譯方式
    無「空不覆寫」防護）→ 設定被清掉。
  - 修在:shinkansen/background.js（pushExtSettings + extModelToken slot2 反向對映 + content-init
    /sw-init/onStartup/storage.onChanged 觸發,IS_IOS_BUILD gate）/ SafariWebExtensionHandler.swift
    （pushExtSettings action → 寫 extApiKey/extModel）/ ViewController.swift（sendSettingsToPage
    優先讀 ext*,fallback host*）。
  - 為什麼 path B:同 §26.12 forward 橋接——IS_IOS_BUILD gate（Chromium false 早退）+ sendNativeMessage
    需 Safari appex native handler + App Group（Chromium 無對應）+ host 端 WKWebView 讀 App Group plist。
  - 1.10.42.1 真機:API Key 回填正確,但預設翻譯方式顯示 Google（實際 Gemini Flash）。根因:iOS background
    是 event page,options 改設定時在睡 → storage.onChanged 沒喚醒 → extModel 沒寫 → fallback 到舊
    hostModel='google'。1.10.42.2 修:push 改掛 content-init（每次頁面載入,pull 已驗證會喚醒 event page）。
  - ★ 清空依據:2026-06-09 Jimmy 真機（1.10.42.2 TestFlight）驗收——擴充功能設 Gemini Flash + API Key →
    host 設定畫面正確顯示現值、儲存後設定不再被清 → 回報「結果正確」。比照 §26.12 靠真機 ground truth 結案。 -->

### ~~code review 2026-06-09 M2 — content-drive.js rAF loop orphan 收斂 + 防重複綁定~~
- ★ **關閉(2026-06-10,Jimmy 決定)**:orphan content script 情境 harness 永久無法重現(同 M1),屬永久 path B,寫不出乾淨 spec。code 修法早已 in place、風險已堵住(orphan 自停 + 防重複綁定 guard),既有 drive-* spec 已驗 overlay / render 邏輯沒被破壞。無對應測試可補 → 關閉,不再佔活動 queue。
- ~~**症狀**(潛在):content-drive.js:411 _startRenderLoop 的 rAF loop 原本無條件遞迴永不停,orphan content script 後仍每幀 getBoundingClientRect 空轉;_listenPlayerMessages 無防重複綁定~~
- ~~**修在**:`shinkansen/content-drive.js` _startRenderLoop 加 orphan 自我停止(`!chrome.runtime?.id`)+ DRIVE.renderLoopRunning 防重複啟動 guard;_listenPlayerMessages 加 DRIVE._msgListenerInstalled guard~~
- ~~**為什麼還不能寫測試**:orphan context 同 M1(harness 無法重現);防重複啟動 / 綁定 guard 要測需 expose 內部 + 計 rAF 次數,收益低~~
- ~~**取捨(非 bug)**:不在 _autoTranslateEnabled=false 時暫停 loop,只收斂「回不來」的 orphan~~

### ~~code review 2026-06-09 M4 — usage-db getDB 連線失效自我重建~~
- ★ **已清(2026-06-10,走路徑 A)**:`test/jest-unit/usage-db-reconnect.test.cjs`(4 case)。
  用假 indexedDB.open 替身(reuse exchange-rate test 的 vm sandbox loadEsm pattern,getDB
  是 hoisted function declaration 直接 ctx.getDB() 可呼叫),觀測 openCount + 回傳 db identity
  驗:singleton 共用 / onclose 重建 / onversionchange close+重建 / **stale onclose 不誤殺新連線
  (_db===db guard)**。SANITY 已驗(拿掉 onclose 的 `if (_db === db)` → stale onclose 測試
  fail,還原 pass)。零新 dep、零 production 改動。
  - 訊號層界定:本 spec 驗「連線失效後的記帳邏輯」,不驗「真瀏覽器儲存壓力下是否真的 fire
    onclose / 重建後 transaction 是否成功」(harness 到不了的層,fake-indexeddb 也模擬不出
    儲存壓力驅逐,故不引入)。
- ~~**症狀**(潛在):getDB singleton 沒掛 onclose / onversionchange,連線被瀏覽器關閉後 _dbPromise cache 死連線 → db.transaction() 丟 InvalidStateError,usage 寫入靜默失敗到 SW 重啟~~
- ~~**修在**:`shinkansen/lib/usage-db.js` req.onsuccess 掛 `db.onclose` / `db.onversionchange`,比對 `_db === db` 後 null 掉 _dbPromise 讓下次 getDB 重建~~

### ~~code review 2026-06-09 M8 — YT heuristic / on-the-fly 批次結果 res.result 防禦~~
- ★ **已清(2026-06-10,走路徑 A)**:`test/regression/youtube-batch-missing-result-guard.spec.js`(2 case)。
  production 加 2 個測試 seam(`SK._runAsrHeuristicWindow` / `SK._flushOnTheFly`,同既有 `SK._runAsrSubBatch` 性質),
  spec mock `safeSendMessage` 回 ok=true 但不帶 result,直接驅動兩條路徑。
  - 觀測點:兩條 result 迴圈都包 try/catch,throw 會被吞 → 不能用「不 reject」斷言。改觀測
    captionMap:有 fix → 每段 fallback 原文填入(非空);無 fix → `undefined[j]` 第一步 throw 被吞
    → captionMap 維持空。
  - SANITY 已驗:兩處 `const results = res.result || []` 改回 `res.result` 直接索引 →
    captionMap.size > 0 斷言 fail(throw 被吞、captionMap 空)→ 還原 pass。
  - 訊號層界定:驗「缺 result 時 fallback 原文寫 captionMap 不靜默丟空」,不驗 background 真會不會
    違反契約(正常不會)/ overlay 視覺。

---

## Deferred 改善項(code review 2026-06-09,待評估排程)

> 這些是 2026-06-09 全 codebase review 找出、但當輪決定**不動**的項目(架構級重構 / 低 ROI)。
> 不是 bug,功能現況正確。放這裡是為了不遺失,未來有空再評估。**不計入 release gate**。
>
> **2026-06-09 後續處理**：M9(c)、L2(a)（部分：只合 Drive Gemini+Custom）、L2(b) 已於本輪
> 完成，走路徑 A 寫了 regression spec（`test/jest-unit/alarm-dispatcher.test.cjs` /
> `drive-batch-merge.test.cjs` / `exchange-rate-and-format.test.cjs` 新增 describe）並 SANITY 驗過，
> 從本清單移除。L2(a) 的 Google / YouTube `_runAsrSubBatch` 折疊評估後風險 > 收益，**不做**
>（輸入格式 / 輸出目標 / 時間戳生成全不同）。L5 評估後決定**永久不做**(理由見下方「非 bug / 維持原樣」段)。本段所有條目已結案。

## 已評估為「非 bug / 維持原樣」(不要再被當問題重提)

- **L5 gemini.js segment mismatch 逐段 fallback 不過 rate limiter**:**永久不做**(2026-06-22)。lib/gemini.js translateChunk mismatch 時逐段重打 API 不經 limiter.acquire,但 mismatch 罕見、逐段 fallback 內層已有 429 退避兜底、後果良性;修法需把 limiter 從 background 接進純 API 模組(架構改動),ROI 不足。不再追蹤,勿重提。

- **M7 PDF 多行末行被吞**:**誤報**。數學證明 fit 保證 `requiredH ≤ blockH+1`,drawText 的 `cy < pdfBottom - lineHeight` break 對成功 fit 的最後一行永不觸發(餘裕 = `fontSize×(visualRatio-1)+lineHeight-1 ≥ 5.5 > 0`)。break 只在 fallback overflow 情境清掉真的溢出的行——正確行為。移除 break 反而讓 fallback 譯文溢出蓋下個 block。2026-06-09 Plano/Quotation/Trimble 真翻譯 Read 譯文 PDF 均無末行遺失。
- **L1 caption scale observer**:**維持觀察 #movie_player**,不縮到 .ytp-caption-window-container。YT 在字幕 toggle / 全螢幕 / 畫質切換時銷毀重建該容器,observer 掛舊容器會漏掉重建。現有 rAF 合併 + idempotent apply 已壓住成本(且只在 scale≠100 啟動)。

<!-- iOS host app ↔ extension App Group 設定橋接（Phase 2,SPEC-PRIVATE §26.12）清空紀錄
  （2026-06-09,模擬器端到端驗收完成）:
  - 功能:host app onboarding / 設定畫面選的 API Key + 預設模型，經 App Group 共享
    UserDefaults + native messaging 拉進 extension storage，四指 tap / Alt+S / popup 翻譯用到。
  - 改在:ViewController.swift（saveSettings/getSettings）/ SafariWebExtensionHandler.swift
    （pullHostSettings）/ shinkansen/background.js（pullHostSettings + model→slot2 + seq 消費）/
    shinkansen/content-touch.js（頁面載入送 PULL_HOST_SETTINGS）。
  - 為什麼 path B（harness 抓不到）:pull 以 IS_IOS_BUILD gate（Chromium false 早退）+
    sendNativeMessage 需 Safari appex native handler + App Group 共享容器（Chromium 無對應）+
    Safari WebExtension chrome.storage 在 WebKit 不透明位置（自動讀不到 consumedSeq）。
  - ★ 清空依據:2026-06-09 Jimmy 模擬器驗收——App Group plist 確認 host 寫入（hostApiKey/
    hostModel/hostSettingsSeq=6）、擴充功能已啟用（Extensions.plist GrantedPermissions）、
    設 Gemini 模型 + sim Safari 翻譯英文頁回報「測試翻譯正常」→ 整條 host 寫 → pull → 套用 →
    翻譯生效跑通。比照 §26.6/26.7 靠「實際翻譯成功」ground truth 結案，queue 不再追蹤。
  - 已知未涵蓋（非 pending,屬上架流程）:真機 TestFlight smoke-check + profile 重簽（§26.12 ⑥）。 -->


<!-- v1.10.27 清空紀錄(2026-06-08,iPhone 實機驗收完成):
  - iOS 原生全螢幕字幕軌:gate + fullscreen 事件切換層(永久 path B)
  - 症狀:iPhone / iPad Safari 看 YouTube 一按全螢幕,翻譯字幕消失(iOS 平台限制——
    webkitEnterFullscreen 進原生播放器只搬 <video>,DOM overlay 全被蓋住)
  - 修在:shinkansen/content-youtube.js iOS FS track 模組(_refreshIosFsTrack /
    _isIOSSafari / _iosFsBeginHandler / _iosFsEndHandler)
  - 已寫的 spec(路徑 A,自動測得到那層):test/regression/youtube-ios-fullscreen-track.spec.js
    4 case + SANITY——驗 _buildIosFsTrackCues cue 組裝 + _ensureIosFsTrack 真實建軌灌 VTTCue
  - 為什麼 gate / fullscreen 事件層永遠寫不出 spec(訊號層次,CLAUDE.md 工作流原則 §3):
    1. _isIOSSafari() 在 Playwright Chromium 永遠回 false → _refreshIosFsTrack 整段
       early return,自動環境碰不到
    2. webkitbeginfullscreen / webkitendfullscreen 是 iOS 原生播放器專屬事件,Chromium
       不 fire;原生播放器把 TextTrack 渲染出來更是 iPhone 系統層,harness 完全看不到
  - ★ 清空依據:2026-06-08 Jimmy iPhone 實機(TestFlight)驗收回報「測試都正常」——
    進全螢幕字幕正常顯示中文、退出切回 DOM overlay 正常。永久 path B 那層改靠這次
    實機驗收結案,queue 不再追蹤。
  - 取捨(非 bug):全螢幕字幕外觀由 iOS「設定→輔助使用→字幕」控制,無法照搬 overlay
    的中英共用黑底樣式(iPhone 硬限制)。
  - 已知未涵蓋範圍(非本條 pending,屬功能未做):目前只鏡像 ASR(自動生成)路徑的
    displayCues;非 ASR(手動上傳字幕)路徑走 replaceSegmentEl,沒有 displayCues 來源,
    全螢幕仍會消失——待後續評估是否補(mobile YouTube 外語影片以 ASR 為大宗,MVP 先涵蓋 ASR)。
-->

<!-- v1.10.0 清空紀錄(2026-05-20):
  - B3 整條移除(使用者要求移除 MAS 上架待辦,2026-05-20)。Part 1(popup banner
    Safari 分支改直連 .pkg 下載 URL)SANITY 驗收已 2026-05-18 完成。Part 2(MAS
    build 編譯期 strip update-check 全套路徑)隨 MAS 上架追蹤一起移除——
    `lib/distribution.js` + `lib/distribution-cs.js` 兩檔仍保留在 codebase
    (`IS_MAS_BUILD = false`),safari-build.sh MAS 軌 override 機制保留;未來若
    重啟 MAS 上架追蹤,SANITY 驗收計畫紀錄見 git history `test/PENDING_REGRESSION.md`
    v1.10.0 之前版本。
-->

<!-- v1.9.28 清空紀錄(2026-05-20):
  - B4: Finding 3 X 串尾「I love your works ❤」stall **完全解了**(v1.9.27.x diagnostic
    sentinel 過程後 ship v1.9.28)。Prescan IntersectionObserver `rootMargin:1000px`
    觀察 `[data-testid="tweetText"]:not([data-shinkansen-translated])` + IO callback
    內 explicit `spaObserverSeenTexts.delete(text)` 豁免 30s TTL 黑名單。POC 純觀測
    顯示 IO fire 比 user dwell 早 3.3s。5-run cross-run consistency sy=10000 桶
    stall_pct 全 0%/0%/0%/0%/0%(baseline 累積 9 runs 全 100%)。
  - 對應 regression spec:`test/regression/spa-prescan-intersection-observer.spec.js`
    8 條 + SANITY(常數定義 / subdomain 命中 / no-op 條件 / 初始 register / MO 攔
    mount / IO callback 觸發 rescan / 100ms batch coalesce / stopSpaObserver lifecycle),
    SANITY 暫破壞 batch 合成驗 spec fail 還原 pass。
  - 並發發現修法(在 Finding 3 修復過程中浮現,非原 §25.20 規劃):
    onProgress race guard(3 處 _progressClosed)/ SPA rescan 8s Promise.race timeout /
    loading toast lazy fire(只 onProgress 真有進度才彈)。全部在 v1.9.28 同輪解。
  - 完整紀錄 SPEC-PRIVATE §25.20.10。
-->

<!-- v1.9.11 清空紀錄(2026-05-12,Phase 1 macOS Safari 真機驗證 + Phase 1.5 release 完整收尾):

  ★ 兩條皆 **永久 path B**(自動化測試永遠寫不出來),SANITY 視覺驗收完成 + 已 release,
    queue 不再追蹤。原因:options.js 2000+ 行 module top-level side effect 多 + Playwright
    extension runtime URL 鎖 `chrome-extension://` 無法 mock `safari-web-extension://` /
    Playwright Chromium webkit ≠ 真實 Safari webkit baseline 渲染。

  ── B1: v1.9.10 options.js Safari detection 改用 body class + event delegation ──
  - 症狀:macOS Safari 真機 options 頁「翻譯快速鍵」section intro 顯示廢 `chrome://extensions/shortcuts`
    link(Safari 不允許 extension UI 改快速鍵,留 link 對 Safari user 是廢資訊)
  - 修在:`options/options.js` line 1733-1760 + `options/options.css` 加 `body.runtime-safari` rule
  - root cause:原 pattern「per-element addEventListener + inline style」被 `data-i18n-html` 的
    applyI18n 用 innerHTML 重設 `<p>` 時整個吹掉。改用 `document.body.classList.add('runtime-' + platform)`
    + event delegation 綁 document
  - 連帶 fix:Chrome / Firefox 一直被 i18n 吹掉的隱性 anchor click listener bug(沒人發現,
    因為 anchor href="#" 點下去靜悄悄沒事),event delegation 一起解
  - 為什麼永遠寫不出 spec:options.js 2000+ 行 module 含一堆 top-level side effects,
    要 unit test detection 邏輯必須先把 detection 抽 pure function(超出當前 bug fix 範圍,
    沒計畫 refactor);Playwright fixture extension 載入的 runtime URL 鎖 `chrome-extension://`,
    無法 mock 成 `safari-web-extension://` 驗 Safari 分支
  - SANITY:✅ 2026-05-12 macOS Safari 真機已視覺驗收 — Xcode rebuild + Safari reload extension +
    options「翻譯快速鍵」section anchor 隱藏(顯示「鍵位可至 變更」中間空格)

  ── B2: v1.9.11 options.css Safari `<input type="date">` line-height 25px 對齊 ──
  - 症狀:用量紀錄頁面 date input(2026/05/05)在 macOS Safari 上 Y 軸沒跟同 row 的 `00:00`
    select stepper 對齊(視覺偏上 ~7px)
  - 修在:`options/options.css` `body.runtime-safari .usage-date-label input[type="date"]`
    + `::-webkit-datetime-edit` pseudo
  - root cause:Safari 26 macOS 對 `<input type="date">` 即使套 `-webkit-appearance: textfield`,
    內部 `::-webkit-datetime-edit` pseudo-element line-box 仍預設靠 content area 頂端對齊
    (非 center);加上拉丁數字 0-9 visual weight 偏底部,geometric center 對齊 ≠ visual center
  - 修法:`-webkit-appearance: textfield` + `line-height: 25px`(on input + `::-webkit-datetime-edit`)。
    25px 是當前字型(-apple-system + PingFang TC + 13px)的 visual sweet spot
  - 修法歷程(燒 3 輪才鎖到):
    * v1.9.10:`::-webkit-datetime-edit-fields-wrapper` selector(Chrome 內部結構,Safari 不認)
      + `display: flex; align-items: center` → 真機完全沒生效
    * v1.9.11 中間嘗試:`-webkit-appearance: textfield` + `::-webkit-datetime-edit {
      padding: 0; margin: 0; line-height: 1 }` + `padding-top: 4px` → 沒生效
    * v1.9.11 final:加 setTimeout 1.5s 在 options.js 末尾彈紅框 dump 真機 computed style
      (CLAUDE.md §11 真實資料優先,避免再憑視覺猜),從 line-height: 13px(預設) = font-size
      看出 line-box 預設靠頂端對齊 → root cause 鎖死。歷時 30 → 28 → 26 → 25 四輪微調,
      Jimmy 視覺確認 25 pixel-perfect。debug code release 前已拿掉
  - 為什麼永遠寫不出 spec:webkit baseline 渲染差異,Playwright Chromium 跟真實 Safari webkit
    行為不同(Chromium 上已對齊,不會 reproduce);Playwright `playwright.webkit` 跟 Safari
    Web Extension 環境也有差距。完全靠真機視覺驗收
  - SANITY:✅ 2026-05-12 macOS Safari 真機已視覺驗收 line-height 25px pixel-perfect 對齊
-->


<!-- v1.9.5 清空紀錄(2026-05-11):
  - Google Translate 批次 echo 原文 → 逐筆 retry 補救 → 已補
    test/unit/google-translate-batch.spec.js 加 3 條 case(批次內某 unit echo / 整批全 echo /
    retry 仍 echo 維持原值)+ SANITY 驗(註解掉 needsRetry 區塊 → 3 條 fail,還原後全綠)。
    走 unit test 路徑(import lib/google-translate.js + mock globalThis.fetch),
    比 Playwright fixture 模 sendMessage 路徑直接,跟 v1.4.0 既有 7 條測試共用同檔同 mock 模式。
-->


<!-- v1.9.1+ 清空紀錄(2026-05-10):
  - v1.8.68 同 videoId yt-navigate-finish guard → 已補 test/unit/youtube-spa-nav-guard.spec.js
    (7 case + SANITY 過。鎖 guard 邏輯架構:listener 找得到 / 取 newVideoId /
    三段式條件 active+truthy+===videoId / early return / guard 在 reset path 之前 /
    reset path 仍在 / 命中記 'SPA nav skipped' log。SANITY:暫時拔掉 guard 整段 →
    4 條 fail 還原 → 全綠)
  - **訊號層次說明**(§1.1 規則 3):本 spec 鎖「我們的 guard 邏輯寫對」、**不鎖**
    「YouTube 真的會 fire 假性同 videoId 的 yt-navigate-finish」。後者是 YouTube
    內部行為,fixture dispatchEvent 自己 fire 永遠驗不到 — 這層靠 user 觀察 +
    production 體感持續驗證。

  popup 累計費用 path 合一 + 術語表抽取寫入 IndexedDB 兩條退役紀錄見下方
-->

<!-- v1.9.1 清空紀錄(2026-05-10):
  - popup 累計費用 path 合一 → 已補 test/unit/usage-path-architecture.spec.js
    (12 條 case:USAGE_STATS / RESET_USAGE handler 不存在 + addUsage / getUsageStats
    / resetUsageStats / USAGE_KEY 不再定義 + storage.local.set('usageStats') 不存在
    + QUERY_USAGE_STATS handler 仍在且走 usageDB.getStats + popup.js 送
    QUERY_USAGE_STATS / 讀 totalBilledCostUSD / 不送 USAGE_STATS / 不讀 totalCostUSD;
    SANITY:暫時把 USAGE_STATS handler 加回 background.js → 對應 spec fail,
    還原後全綠)
  - 術語表抽取用量寫進 IndexedDB(source='glossary')→ 已補
    test/unit/usage-glossary-record.spec.js(16 條 case:Gemini + OpenAI-compat
    兩條 handler 各驗 logTranslation 呼叫 / source='glossary' / engine 標籤 /
    model 欄位 fallback / billedCostUSD / 包在 if (usage > 0) block 內 / 用
    getCustomCacheHitRate 推 cache 折扣率;SANITY:暫時把 Gemini handler 內的
    usageDB.logTranslation 改名 → 對應 2 條 spec fail,還原後全綠)
-->


<!-- v1.8.46 清空紀錄(2026-05-05):
  - W6 譯文 PDF 下載對 owner-password + AESv2 弱加密 PDF 失敗(Trimble TDC6 SpecSheet)
    → 換 @cantoo/pdf-lib 2.6.5 fork(補 mozilla/pdf.js port 的 AES decrypt)
    + PDFDocument.load 加 { ignoreEncryption: true, password: '' }
    → 已補 test/regression/pdf-download-encrypted.spec.js(SANITY:暫時 revert
      password='' 驗證 spec 正確 fail EncryptedPDFError,還原 fix → pass)
    → fixture 走 docs/excluded(整個 .gitignore),CI 沒檔自動 skip,本機才跑
-->


<!-- v1.8.42 清空紀錄(2026-05-04):
  - non-ASR 雙語改走獨立 overlay + multi-segment dedup → 已補 test/regression/youtube-bilingual-overlay.spec.js
    (4 條 case:雙語不動 segment、雙語 dedup seg2 cached='' 也 push srcBits、純中文 dedup seg2 cached='' 清空 segment、_applyBilingualMode 加 hide class;case 3 已 SANITY 驗過)
  - 同時新加 SK._applyBilingualMode export 給 spec 用
-->


<!-- v1.8.41 清空紀錄(2026-05-04):
  - v1.8.40 YouTube zh-Hant skip → 已補 test/regression/youtube-skip-already-zh-hant.spec.js
    (6 條 case:4 個 zh-Hant/TW/HK/MO 應 skip + en/zh-Hans 對照組應送 API,SANITY 驗過)
  - v1.8.39 translateUnits 段落 hash dedup → 已補 test/regression/translate-dedup-broadcast.spec.js
    + fixtures/translate-dedup-broadcast.html(5 unique + 60 重複段,SANITY 驗過 broadcast 邏輯)
  - 原 v1.8.39 殘留條目「Google Translate 路徑未做 dedup」屬於「功能未做」(非 spec 未寫),
    不符 PENDING_REGRESSION 定位(本檔只追「bug 已修但 spec 未寫」),直接刪掉
-->


<!--
條目格式範例(實際加入時把上面那行 placeholder 刪掉):

### v0.60 — 2026-04-12 — 簡短描述 bug
- **症狀**:Jimmy 觀察到的現象 (例如「Substack 卡片標題被吃掉變空字串」)
- **來源 URL**:https://example.com/some-page (若為公開頁面)
- **修在**:shinkansen/content.js 的 XX 函式 / commit hash
- **為什麼還不能寫測試**:
    例:還沒抽出最小重現結構;原頁面太複雜、含三層 wrapper + 動態載入,
    需要再觀察是哪個 attribute 是真正觸發條件
- **建議 spec 位置**:test/regression/inject-substack-title.spec.js
- **建議 fixture 結構**(若已知):
    ```html
    <article>
      <h2 class="...">
        <span>...</span>
      </h2>
    </article>
    ```
-->
