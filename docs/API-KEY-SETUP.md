[English](API-KEY-SETUP.en.md) | **繁體中文**

# Shinkansen — Google Gemini API Key 申請指南

> 本指引帶你申請 Gemini API Key，供 Shinkansen 呼叫 Google Gemini 翻譯網頁，一般情況下 2 分鐘可完成。金鑰免費申請，只存在你的裝置，不會上傳到任何伺服器

### 步驟 1：開啟 API Keys 頁面並登入

**直接開這個連結：[aistudio.google.com/api-keys](https://aistudio.google.com/api-keys)**

1. 用你的 Google 帳號登入（會自動回到 API Keys 頁面）
2. 第一次使用 Google AI Studio 會要求同意服務條款，勾選後按「Continue」

> 不要從 AI Studio 首頁進去——首頁是聊天介面，API Keys 入口藏在左側選單（手機上還要先點左上角的選單按鈕），容易迷路。直接開上面的連結最快

### 步驟 2：建立 API Key

1. 點頁面**右上角**的「**Create API key**」
2. 「Name your key」可以維持預設，或改成 `Shinkansen` 方便辨識
3. 「Choose an imported project」維持預設即可（沒有的話選「Create new project」）
4. 點「**Create key**」

API Key 會立刻顯示，格式像 `AIzaSy...`（約 39 個字元）。點旁邊的複製圖示複製整串

> **小提醒**：之後隨時可以回到 API Keys 頁面點該 Key 複製，不用擔心一次沒複製到

### 步驟 3：貼進 Shinkansen

**Chrome / Firefox / Mac**

1. 點工具列的 Shinkansen 圖示 →「設定」（第一次安裝時設定頁會自動打開）
2. 在「**Gemini API Key**」欄位貼上剛才複製的 Key，貼上後會自動檢查是否有效（也可按「測試」再驗一次），設定會自動儲存
3. 開任何英文網頁，按 Option+S（Mac）或 Alt+S（Windows）試翻譯

**iPhone / iPad**

1. 打開 Shinkansen App，首次啟動的導覽第 2 步就是貼 API Key（之後可從主畫面「API Key 與預設翻譯方式」進入）
2. 貼上後會自動檢查，按「完成」或「儲存」即同步到 Safari 延伸功能

### 步驟 4（選擇性）：綁信用卡解除免費額度限制

免費額度有 **RPD**（每日請求上限）、**RPM**（每分鐘請求上限）、**TPM**（每分鐘 token 上限）等限制，日常閱讀量通常夠用；翻得多、或想用 Pro 等進階模型再綁卡

1. 開 [Google AI Studio](https://aistudio.google.com/)
2. 點左側選單「**Billing**」→「**Set up billing**」
3. 填寫付款資訊（姓名、地址、信用卡）
4. 提交後 AI Studio 會自動把你的專案升到 Tier 1，RPD / RPM 上限放寬，可使用 Pro 等進階模型

**月度花費上限**：Tier 1 帳戶 Google 強制設每月 250 美元上限，這是保護機制，避免意外天價帳單

*本文件最後更新：2026 年 9 月 3 日*
