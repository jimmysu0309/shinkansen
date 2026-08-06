// release-highlights.js — 近期重大更新的 key 清單（單一資料源，v1.6.5 起）
//
// 為什麼集中在這個檔：popup welcome banner 引用這份清單決定「顯示哪幾條、順序為何」。
// 文字本體放 lib/i18n.js 的 popup.banner.hl.* key（8 語——先前本檔直接放繁中寫死
// 字串，非繁中介面的使用者升級後看到的是繁中條目）。README / docs/index.html 的
// 「近期重大更新」段落仍需手動同步（這兩處不是 extension 程式碼，不能 import 此 module）。

/**
 * 近期重大更新（給使用者看的，要白話簡短）。
 * 順序由近到遠（最新放最前）。
 *
 * 維護規則（release.sh 的 minor/major bump 提醒會提示這條）：
 *   - **有新功能的 minor/major 升級** → 把最舊那條 key 移除、最新的補進第一條；
 *     新 key 必須在 lib/i18n.js 的 8 語 block 各補一份譯文（漏語言時
 *     i18n-sync-check 會擋）
 *   - **純內部升級**（重構 / 效能 / 修 bug，沒有使用者直接感知的新功能）
 *     → 仍要更新一條，避免使用者看到上版的條目以為「這版沒做事」。
 *     可用通用條目代替，例如「改善效能與穩定性，提升整體使用體驗」
 *   - **patch 升級** → 完全不用動（patch 不觸發 welcome notice）
 */
export const RELEASE_HIGHLIGHT_KEYS = [
  'popup.banner.hl.epub',
  'popup.banner.hl.docfiles',
  'popup.banner.hl.opencc',
];
