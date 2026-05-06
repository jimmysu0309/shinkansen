# Gemini Streaming 可行性 probe 報告

**日期**:2026-04-28(下午,v1.7.3 release 後的 design probe,尚未實作 production code)
**目的**:在動 production code 之前,實測 Gemini `streamGenerateContent` 在 Shinkansen 場景下的真實時序行為,驗證「**batch 0 用 streaming + batch 1-N 在 first_chunk 時並行 dispatch non-streaming**」這個設計是否真的能把首字延遲從 ~3.4s 壓到 ~1s 而不付出整頁完成時間延後的代價。

**結論摘要**:設計可行性 4/4 假設全驗證通過。預期首字延遲 -71%、整頁完成時間僅 +1 秒、batch 0 size 可放心擴大到 25 unit。**值得進入 v1.8.0 實作階段**。

---

## 0. 為什麼要 probe

`reports/optimization-roadmap-2026-04-28.md` 列了候選 E「Gemini API streaming 邊收邊注入」,預期 OFF 模式首字延遲 3-7s → 1-3s,但實作成本 200-400 行 code(動 background.js fetch 路徑 + 增量 parser + 新一批 streaming 情境 regression)。直接動 code 風險太高——整套架構 commit 下去若實測效果不如預期,撤回成本極大。

依 CLAUDE.md §11「Debug 必須以真實資料為基石」,先寫一次性 probe 拿真實 Gemini API 行為數據,再決定是否值得實作。

設計討論中提出的關鍵假設要先驗證:
1. Gemini Flash first-token-latency ≈ 0.5-1.5 秒(沒在 Shinkansen 場景驗證過)
2. batch 0 size 對 first-token-latency 影響小(因此可擴大 batch 0 涵蓋更多內文)
3. 在 first_chunk 時就同步 dispatch batch 1-N(走 non-streaming),這 6 個並行 fetch 不會拖慢 streaming batch 0 的 chunk arrival
4. 整頁完成時間不會因並行而顯著延長

---

## 1. probe 工具

### 1.1 `tools/probe-streaming.js`

獨立 Node script,直接打 Gemini `streamGenerateContent?alt=sse` endpoint,不依賴 extension。

- 用 Shinkansen 真實 system prompt(從 `lib/storage.js DEFAULT_SYSTEM_PROMPT` import)
- 用 Shinkansen 真實 batch 構造(`«N» <text>` 序號標記 + `\n<<<SHINKANSEN_SEP>>>\n` 分隔符,直接從 `lib/system-instruction.js` import)
- 用真實 batch 0 風格 input(取自 TWZ SpaceX 文章開頭 + Cloudflare blog + Wikipedia Tea 各段)
- 量測 5 個關鍵時間點:
  - `first_chunk_t`:第一個 SSE event 從 server 抵達本機
  - `first_token_t`:第一個帶 `text` 的 chunk(通常跟 first_chunk 同時)
  - `first_slot_close_t`:第一次出現 `⟦/0⟧` 的時間(**最接近使用者「看到首字」的時間點**——對應 Shinkansen 第一段譯文整段收齊可注入 DOM)
  - `first_segment_complete_t`:第一個 `SHINKANSEN_SEP` 收到(整段第 1 unit 完整翻完)
  - `stream_end_t`:stream 結束(等同 non-streaming 的整批回送時間)
- 三種 batch size(10/20/30 unit)各跑 3 次取中位數

### 1.2 `tools/probe-streaming-concurrent.js`

延續上面,但加入「並行影響」的對照實驗:

- **Mode A(對照組)**:只跑 streaming batch 0,沒任何並行請求
- **Mode B(實戰)**:streaming batch 0 + 在第一個 chunk 收到時同步 dispatch 6 個 non-streaming batch
- 額外量測:
  - `chunk_gap_p95` / `chunk_gap_max`:兩個相鄰 chunk 的最大間隔(反映 streaming 是否被並行請求 stall)
  - 6 個 parallel batch 各自的 `recv at Xms`(反映整頁完成時間)
- batch 0 = 25 unit / parallel batches = 6 × 20 unit / 跑 3 runs

兩個 probe 都因 `tools/probe-*.js` 已在 `.gitignore`,不會誤入版控。

---

## 2. 實測結果

### 2.1 Streaming 單獨 probe(probe-streaming.js,size 10/20/30 各跑 3 次)

```
size  first_chunk  first_token  first_slot_close  first_segment  stream_end  chunks
10u    1084ms        1084ms       1086ms              1086ms         3397ms      21
20u    1005ms        1005ms       1061ms              1061ms         6224ms      42
30u    1041ms        1041ms       1168ms              1168ms         8566ms      60
```

**關鍵觀察**:

1. **first_chunk = first_token = first_slot_close** 三者幾乎同時。這意味著 Gemini Flash 在第一個 SSE chunk 裡就已吐出整段「⟦0⟧解密美國國家安全...⟦/0⟧」（約 30 字,fits in one chunk）。**「first_chunk 就是首字延遲」這個簡化假設在實務上成立**。

2. **first_slot_close 跟 batch 0 size 幾乎無關**:10u/20u/30u 都在 **1.0-1.2 秒** 範圍。差距 < 100ms,符合 Gemini server-side latency 抖動範圍。

3. **stream_end 與 size 線性相關**:10u → 3.4s,20u → 6.2s,30u → 8.6s。每多 10 unit ≈ 多 2.6 秒生成時間。對 non-streaming 來說 stream_end 就是首字延遲——所以 size 越大,non-streaming 越拖慢首字;**streaming 解耦這個關係**。

4. **streaming 帶來的首字改善幅度**:

   | size | non-streaming 首字(=stream_end) | streaming 首字(=first_slot_close) | 改善 |
   |---|---:|---:|---:|
   | 10u | 3397ms | 1086ms | **-68%** |
   | 20u | 6224ms | 1061ms | **-83%** |
   | 30u | 8566ms | 1168ms | **-86%** |

   **batch 0 size 越大,streaming 收益越大**——擴大 batch 0 是 streaming 方案的天然搭檔。

### 2.2 並行影響 probe(probe-streaming-concurrent.js,batch 0 = 25 unit + 6 並行 × 20 unit,跑 3 次)

```
                         Mode A (alone)  Mode B (with 6 parallel)  delta
first_chunk                  991ms          936ms                   -55ms
first_slot_close            1138ms         1020ms                  -118ms
stream_end                  8074ms         7717ms                  -357ms
chunk_gap_p95                210ms          190ms                   -20ms
chunk_gap_max                254ms          285ms                   +31ms
chunk_count                  52            52                       +0
```

**所有 delta 都是負的或極小**——並行 6 個 batch **完全沒拖慢 streaming**,反而略快一點(屬於 server-side latency 抖動,不是真的「並行使 streaming 變快」,但結論是「**並行不會傷害 streaming**」)。

`chunk_gap_max` 從 254ms → 285ms,只多 31ms(< 1 個 token 的時間),代表偶有的 server-side stall 也是極輕微,不會造成可見的 streaming 卡頓。

**為什麼並行不互相影響的可能解釋**:
- HTTP/2 connection multiplexing:7 個並行請求共用 connection 但獨立 stream,server 端各自處理
- Gemini server 端對同 API key 並行請求至少 7 個都還沒撞 throttle 上限
- 本機 Node fetch 並行 7 個 + 1 個 streaming reader,事件迴圈處理量遠未滿載

**6 個 parallel batch 完成時序(median across 3 runs)**:

```
parallel batch 1: recv at 5676ms
parallel batch 2: recv at 5879ms
parallel batch 3: recv at 6133ms
parallel batch 4: recv at 7552ms
parallel batch 5: recv at 7830ms
parallel batch 6: recv at 8426ms
```

跟 streaming batch 0 stream_end 7717ms 對比,**6 個並行 batch 大致跟 streaming batch 0 在同一時間窗內完成**。也就是整頁完成時間 ≈ max(streaming 8s, 最慢 parallel 8.4s) = **8.4 秒**。

---

## 3. 設計可行性結論

四個關鍵假設全部驗證通過:

| # | 假設 | 預期 | 實測 | 驗證 |
|---|---|---|---|:---:|
| 1 | Gemini Flash first-token-latency 在 Shinkansen 場景下 ≤ 1.5 秒 | 0.5-1.5 秒 | **median 1.0 秒** | ✅ |
| 2 | batch 0 size 不影響 first-token-latency | 差距 < 200ms | 10u/20u/30u 差距 < 100ms | ✅ |
| 3 | first_chunk 觸發並行 batch 1-N(non-streaming)不拖慢 streaming | 差距 < 200ms | first_slot_close mode A → mode B **變快 118ms** | ✅ |
| 4 | 整頁完成時間不因並行而顯著延長 | < +2 秒 | 8.4 秒(vs 對照 8.1 秒) | ✅ |

---

## 4. 預期 v1.8.0 整體效果

| 指標 | v1.7.3 現狀 | v1.8.0 streaming + 並行 |
|---|---:|---:|
| 首字延遲 | ~3.4s(batch 0=10u,等 stream_end) | **~1.0s**(streaming first_slot_close) |
| 整頁完成時間 | ~7s | ~8s(略增 1 秒) |
| batch 0 size | 10 unit / 1500 chars | **25 unit / 3700 chars**(可放心擴大) |
| batch 0 涵蓋內容 | 文章 H1 + 副標 + 開頭幾段 | H1 + 副標 + 整段內文前 25 段 |

**首字延遲 -71%,整頁完成時間僅 +1 秒,batch 0 size 翻倍涵蓋更多文章開頭**。

---

## 5. 仍需在實作階段驗證的剩餘風險

probe 跑在純 Node fetch 環境,Shinkansen 真實使用場景還有以下未驗證項目,實作時要寫對應的 regression 鎖行為:

1. **Service Worker 環境的 fetch + ReadableStream**:Chrome extension SW 對 SSE / ReadableStream 是否完全支援。SW hibernate 中途斷線的回退路徑要設計清楚。
2. **跨 service worker → content script 的 chunk forwarding**:streaming chunk 從 SW fetch 拿到後,要送到 content.js inject。可以用兩種方式:
   - SW 內 incremental parser → 解到完整 segment 才透過 sendMessage 推給 content
   - SW 一邊收一邊推 raw chunk → content 端 parser
   推薦前者(parser 集中在 SW,content 收已 parse 好的 segment 直接 inject)
3. **AbortController 跨批傳播**:使用者中途按 Option+S 取消,要把 streaming reader.read() 中斷 + 已 dispatch 的 batch 1-N 也 abort,不能繼續注入剩下的 chunk
4. **占位符斷裂處理**:極端情況 chunk 切在 `⟦` 跟 `0` 中間。incremental parser 要累積到下一個段落結束 marker (SHINKANSEN_SEP) 才嘗試 deserialize 占位符,不能 chunk-by-chunk 直接 parse
5. **streaming 失敗的回退路徑**:
   - 半途斷線:已 inject 的段落保留,未完成的 segment 走 segment-mismatch fallback(per-segment 重送)
   - 整批失敗(first_chunk 都沒到):當 non-streaming 失敗一樣處理,計入 failures
6. **Gemini implicit cache 跟 prefix cache 的交互**:streaming batch 0 prompt 在 server 端 cache 建立的時機(prompt 收完還是 generate 開始?),以及 batch 1-N 在 first_chunk 觸發時送出能否吃到 cache hit。理論上 prompt cache 在「prompt 被處理」那一刻就 ready,但實測值得確認

---

## 6. Scope 限制:streaming 只應用在「文章翻譯」路徑

**streaming 路徑只限 `TRANSLATE_BATCH`(文章翻譯)的 batch 0**。下面三條路徑明確排除,維持現有 non-streaming 行為。

### 6.1 字幕翻譯(`TRANSLATE_SUBTITLE_BATCH` / `TRANSLATE_ASR_SUBTITLE_BATCH`)— 排除

- **為什麼排除**:
  - 字幕每個視窗 batch 本來就很小(~8 條 segment),Gemini 整批回送時間就 1-3 秒,跟 streaming first_slot_close 預期 ~1 秒幾乎沒差。**streaming 收益接近零**。
  - 字幕的播放時序由影片進度決定,使用者「看到第一段中文」的時間取決於播放器 seek,不是「Gemini 回送的第一秒」。streaming 加速首段對字幕體感無感。
  - 字幕路徑(`content-youtube.js`)已有自己的「視窗滑動 + LLM 智慧分句」設計,跟文章翻譯的 batch 切分邏輯不同,引入 streaming 會把兩條本已分離的路徑再拉進共同的複雜度中,得不償失。
- **實作面**:`background.js` 的 `TRANSLATE_SUBTITLE_BATCH` / `TRANSLATE_ASR_SUBTITLE_BATCH` handler 仍呼叫 `translateBatch`(non-streaming),不動;新增的 `translateBatchStream` 不暴露給字幕 handler 用。

### 6.2 術語表抽取(`EXTRACT_GLOSSARY`)— 排除

- **為什麼排除**:
  - 術語抽取是「先等完整 JSON 回來 → 解析成 term array → 翻譯時帶入」的 blocking call,使用者**沒在等它出現視覺結果**。streaming 把「逐段吐譯文」的時序優勢用在這裡完全沒意義。
  - `extractGlossary` 的 response 是結構化 JSON(`[{ source, target, type }, ...]`),不是逐段 inject 的 streaming-friendly 格式。增量 parse JSON array 的複雜度遠高於增量 parse 段落。
  - v1.7.3 已用「blockingThreshold 提高 + Flash Lite」的組合把 EXTRACT_GLOSSARY 的影響壓到位元—中等長度頁面走 fire-and-forget(完全不阻塞首字),長頁仍 blocking 但 Flash Lite 比 Flash 快 18%。**現有方案已夠用**,沒必要再給 glossary 路徑加 streaming。
- **實作面**:`extractGlossary` 函式不動,維持現在的 `generateContent`(non-streaming)+ JSON parse 路徑。

### 6.3 batch 1+(同一次文章翻譯內,batch 0 之外的批次)— 排除

- **為什麼排除**:
  - batch 1+ 在 batch 0 first_chunk 觸發後並行 dispatch,使用者已看到首字、不會盯著 batch 1+ 的視覺進度。streaming 對 batch 1+ 沒額外收益。
  - 維持 batch 1+ 走 `translateBatch`(non-streaming)= 維持 v0.77 segment-mismatch fallback、v0.94 hadMismatch 偵測、cache lookup、rate limiter 等所有容錯網。streaming 路徑要新設計這些容錯,等於把成熟的 fallback 重做一次。
  - **副作用範圍最小化**:streaming 只在一個入口(batch 0 of `TRANSLATE_BATCH`),incremental parser / abort / chunk forwarding 等新邏輯只影響一條路徑。萬一某個 site 的 batch 0 streaming 出錯,batch 1+ 仍能完整翻完整頁。
- **實作面**:`translateUnits` 內 jobs[0] 走 `translateBatchStream`,jobs[1..N] 走 `runWithConcurrency(jobs.slice(1), maxConcurrent, runBatch)` 維持原 `translateBatch` 路徑。

### 6.4 結論

| 路徑 | streaming? | 走什麼函式 |
|---|:---:|---|
| 文章翻譯 batch 0(TRANSLATE_BATCH 第一批) | ✅ | 新增 `translateBatchStream` |
| 文章翻譯 batch 1+(TRANSLATE_BATCH 後續批次) | ❌ | 既有 `translateBatch`(non-streaming) |
| YouTube 字幕(TRANSLATE_SUBTITLE_BATCH) | ❌ | 既有 `translateBatch`(non-streaming) |
| YouTube ASR 字幕(TRANSLATE_ASR_SUBTITLE_BATCH) | ❌ | 既有 `translateBatch`(non-streaming) |
| 術語表抽取(EXTRACT_GLOSSARY) | ❌ | 既有 `extractGlossary`(non-streaming) |
| Google Translate 翻譯(TRANSLATE_BATCH_GOOGLE) | ❌ | 既有 `translateGoogleBatch`(不適用 streaming) |
| 自訂模型翻譯(TRANSLATE_BATCH_CUSTOM) | ❌ | 既有 OpenAI-compat 路徑(後續可考慮另案評估) |

**streaming 是一條「文章翻譯首字優化」專用的新路徑,跟其他翻譯任務的執行路徑完全分離**。

---

## 7. v1.8.0 實作計畫(等綠燈才開工)

| 步驟 | 估時 | 內容 |
|---|---|---|
| 1 | ~2 小時 | `lib/gemini.js translateBatchStream` 新函式(~150 行)。streamGenerateContent endpoint + ReadableStream + incremental parser 累積到 SHINKANSEN_SEP 才 emit segment。 |
| 2 | ~2 小時 | `background.js` 加 STREAMING_BATCH_CHUNK 訊息類型,SW 收到 segment 透過 chrome.tabs.sendMessage 推給 content。 |
| 3 | ~1 小時 | `content.js translateUnits` 內 batch 0 走 streaming 路徑;在收到 first_chunk 訊號(透過新 STREAMING_BATCH_FIRST_CHUNK 訊息)時同步 dispatch batch 1-N。 |
| 4 | ~1 小時 | `content-ns.js BATCH0_UNITS` 從 10 → 25,`BATCH0_CHARS` 從 1500 → 3700。 |
| 5 | ~2 小時 | abort signal 跨批傳播。 |
| 6 | ~2 小時 | 5-8 條新 regression spec(streaming 各種情境:正常完成、半途斷線、占位符斷裂、abort 中斷、失敗 fallback) |
| 7 | ~1 小時 | 真實 10 URL 重測 + 報告(`reports/streaming-implementation-<date>.md`) |
| 8 | ~30 分 | bump v1.8.0 + 6 處同步點 + 3 處 docs + release |

**總計 1-2 個工作 session,bump 為 v1.8.0**(架構性新增 streaming 路徑,minor bump 而非 patch)。

---

## 8. 參考資料

- 完整實測數據:`/tmp/probe-streaming-result.json` 與 `/tmp/probe-streaming-concurrent-result.json`(本機 only,未入 commit)
- 相關報告:
  - `reports/priority-sort-probe-2026-04-28.md`(v1.7.1 / v1.7.2 priority sort + batch 0 變小實測)
  - `reports/optimization-roadmap-2026-04-28.md`(優化候選清單,候選 E 是本報告的對應實驗)
- 相關 release:v1.7.3(blockingThreshold 動態調整,glossary fire-and-forget 路徑優化)
