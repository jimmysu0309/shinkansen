// instapaper-keys.js 的產生模板（issue #61）。
//
// 兩個 placeholder 由 .github/workflows/release.yml 在發布時以 repo secret 取代，
// 輸出到 shinkansen/lib/instapaper-keys.js —— 那支檔是 gitignored（consumer 金鑰
// 不進 repo / git 歷史，擋 bot 爬 code search），但必須存在於發布產物內，否則
// background.js fetch 不到金鑰，使用者連 Instapaper 會看到「整合尚未設定 consumer 金鑰」。
//
// 本檔只有 placeholder、沒有真金鑰，所以可以進 repo：它同時也是「檔案格式」的
// 單一資料源 —— background.js 的抽取 regex 與 popup / options 的 <script> 載入
// 都依賴這個形狀，test/jest-unit/instapaper-keys-packaging.test.cjs 鎖住三者一致。
//
// 只在 extension 內部頁（popup / options / background）載入，不注入一般網頁。
// lib/instapaper.js 從 globalThis.__SK.INSTAPAPER_KEYS 讀；讀不到 → 功能停用。
(function (root) {
  root.__SK = root.__SK || {};
  root.__SK.INSTAPAPER_KEYS = {
    consumerKey: '__INSTAPAPER_CONSUMER_KEY__',
    consumerSecret: '__INSTAPAPER_CONSUMER_SECRET__',
  };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : self));
