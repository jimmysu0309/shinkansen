# Third-Party Notices

Shinkansen 整合下列第三方軟體與字型，本檔列出來源、授權與授權檔位置。

## JavaScript 套件

### PDF.js

- **用途**：翻譯文件功能解析 PDF / render 頁面 canvas / 抽取 text run
- **檔案**:`shinkansen/lib/vendor/pdfjs/pdf.min.mjs`、`pdf.worker.min.mjs`
- **來源**:Mozilla(github.com/mozilla/pdf.js)
- **授權**:Apache License 2.0
- **授權檔**:`shinkansen/lib/vendor/pdfjs/LICENSE`

### pdf-lib (@cantoo/pdf-lib)

- **用途**：翻譯文件功能下載「雙頁並排對照 PDF」時用 pdf-lib 創新 PDFDocument、
  copyPages 把原 page embed 進新 doc、addPage 創新譯文頁、page.drawText 畫譯文
- **檔案**:`shinkansen/lib/vendor/pdf-lib/pdf-lib.min.js`(@cantoo/pdf-lib 2.6.5,
  Andrew Dillon 原作 hopding/pdf-lib 1.17.1 的活躍 fork，補上 mozilla/pdf.js 的
  AES decrypt 邏輯，讓含 owner-password 安全限制的弱加密 PDF 也能匯出譯文 PDF)
- **來源**:cantoo-scribe(github.com/cantoo-scribe/pdf-lib)/ Andrew Dillon
- **授權**:MIT License
- **授權檔**:`shinkansen/lib/vendor/pdf-lib/LICENSE-pdf-lib.md`

### fontkit (pdf-fontkit)

- **用途**:pdf-lib 透過 fontkit 解析 OpenType 字型 + 做字型 subset（只 embed
  譯文實際用到的字，典型 7MB CJK 字型 subset 後降到 100-300KB)
- **檔案**:`shinkansen/lib/vendor/pdf-lib/fontkit.umd.min.js`(npm `pdf-fontkit`
  1.8.9,Devon Govett 原作 fontkit / Hopding fork @pdf-lib/fontkit / znacloud
  進一步 fork 修 CJK subset bug。@pdf-lib/fontkit 1.1.x 對 CJK TTF subset 後
  glyph advance 寫錯，Chrome / PDF.js render 會字符散落破碎，實測在 Plano
  / Trimble 等所有測試 PDF 都炸，換 pdf-fontkit 後完整 fix)
- **來源**:znacloud(github.com/znacloud/fontkit)
- **授權**:MIT License
- **授權檔**:`shinkansen/lib/vendor/pdf-lib/LICENSE-fontkit`

### Chart.js

- **用途**：options 用量明細分頁的 token / 費用圖表繪製
- **檔案**：`shinkansen/lib/vendor/chart.min.js`（Chart.js v4.5.1）
- **來源**：Chart.js Contributors（github.com/chartjs/Chart.js）
- **授權**：MIT License
- **授權檔**：`shinkansen/lib/vendor/LICENSE-chartjs.md`

### fflate

- **用途**：文件翻譯的 EPUB 讀寫——解壓原書 zip 容器、翻譯後重新打包譯文 EPUB
- **檔案**：`shinkansen/lib/vendor/fflate/fflate.umd.js`
- **來源**：Arjun Barrett（github.com/101arrowz/fflate）
- **授權**：MIT License
- **授權檔**：`shinkansen/lib/vendor/fflate/LICENSE`

### @mozilla/readability

- **用途**：「送到 Instapaper」送出前在譯文 DOM 的 clone 上抽乾淨正文，避免整頁
  SPA 噪音讓下游 reader 綁架到影片嵌入塊（含少量本地修補，
  grep "Shinkansen patch" 可定位，詳見檔頭註解）
- **檔案**：`shinkansen/lib/readability.js`（vendored v0.6.0）
- **來源**：Mozilla / Arc90（github.com/mozilla/readability）
- **授權**：Apache License 2.0
- **授權檔**：`shinkansen/lib/readability.LICENSE`

### OpenCC / opencc-js

- **用途**：簡繁互轉功能——target 為 zh-TW / zh-CN 時，偵測為相反中文變體的段落
  走本地字典轉換（Trie 詞組級，含台灣慣用詞對映），不經任何 API
- **檔案**:`shinkansen/lib/vendor/opencc/opencc-core.js`(Trie / ConverterFactory
  轉換核心，取自 opencc-js 1.4.1 dist/esm-lib/core.js)、
  `shinkansen/lib/vendor/opencc/dict/*.txt`(cn↔twp 兩方向最小字典集，原始
  「來源 替換|…」文字格式，由 `tools/vendor-opencc.mjs` 自 opencc-js 套件抽出，
  background 首次轉換時 lazy fetch)
- **來源**:opencc-js(github.com/nk2028/opencc-js)；字典資料上游為 OpenCC
  (github.com/BYVoid/OpenCC)
- **授權**:opencc-js — MIT License;OpenCC 字典資料 — Apache License 2.0
- **授權檔**:`shinkansen/lib/vendor/opencc/LICENSE`(opencc-js MIT)、
  `shinkansen/lib/vendor/opencc/LICENSE-OpenCC-data`（字典資料 Apache-2.0）

## 字型

### Noto Sans CJK TC（Regular + Bold）

- **用途**：翻譯文件下載譯文 PDF 時內嵌作為譯文中文字型（中文標點 / 漢字 95%+
  覆蓋率）。Bold 字重用於還原原文粗體段落。pdf-lib subset: true 在最終 PDF 內
  只 embed 譯文用到的字 subset（典型 100-300KB)，不影響譯文 PDF 大小
- **檔案**:`shinkansen/lib/vendor/fonts/NotoSansTC-Regular.ttf`、
  `shinkansen/lib/vendor/fonts/NotoSansTC-Bold.ttf`
- **來源**:Google Noto CJK Sans 計畫（github.com/notofonts/noto-cjk）
- **授權**:SIL Open Font License Version 1.1
- **授權檔**:`shinkansen/lib/vendor/fonts/LICENSE-NotoSansTC.txt`
- **限制**：依 SIL OFL 條款，字型本身不可作為其他產品的行銷名稱
