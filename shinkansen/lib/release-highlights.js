// release-highlights.js — 近期重大更新文字單一來源（v1.6.5 起）
//
// 為什麼集中在這個檔：popup welcome banner、translation toast welcome callout、
// 設定頁未來可能的 What's new section 都會引用同一份文字；改一處就同步生效。
// README / landing page 的對應 bullet 仍需手動同步（這兩處不是 extension 程式碼，
// 不能 import 此 module）。

/**
 * 近期重大更新（給使用者看的，要白話簡短）。
 * 順序由近到遠（最新放最前）。
 *
 * v1.8.7 起放 6 條（之前是 4 條上限）；popup welcome banner 與 toast welcome callout
 * 視高度自然撐開，內容多時可捲。
 *
 * 維護規則（release.sh 的 minor/major bump 提醒會提示這條）：
 *   - **有新功能的 minor/major 升級** → 把最舊那條移除、最新的補進第一條
 *   - **純內部升級**（重構 / 效能 / 修 bug，沒有使用者直接感知的新功能）
 *     → 仍要更新一條，避免使用者看到上版的三大條目以為「這版沒做事」。
 *     可用通用條目代替，例如：
 *       '**改善效能與穩定性**，提升整體使用體驗'
 *       '**優化內部架構**，為未來新功能做準備'
 *       '**修正多項細節問題**，改善整體流暢度'
 *   - **patch 升級** → 完全不用動（patch 不觸發 welcome notice）
 *
 * 註：本檔修改後 README.md 與 docs/index.html 的「近期重大更新」段落也要手動同步。
 */
export const RELEASE_HIGHLIGHTS = [
  '**新增「EPUB 電子書翻譯」**（beta）：整本電子書丟進「翻譯文件」頁即可翻譯，全書術語表確保譯名前後一致',
  '**簡繁互轉完全免費**：簡體（或繁體）中文內容走內建字典本地轉換，不需 API Key、離線可用',
  '**PDF 翻譯品質大幅強化**：表格與規格書的版面偵測、譯文渲染全面重修',
];
