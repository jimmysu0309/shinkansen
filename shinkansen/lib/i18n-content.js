// lib/i18n-content.js — content script 專用 i18n 子集（GENERATED，不可手改）
//
// 由 tools/build/generate-i18n-content.mjs 從 lib/i18n.js 產出：runtime 原封不動，8 語 dict 只留
// content script（manifest content_scripts）用得到的 86 個 key。完整 dict 仍是
// lib/i18n.js（popup / options / translate-doc 載入）；改字串一律改 i18n.js 再重生本檔。
// test/unit/i18n-content-subset.spec.js 鎖「本檔 = 重生結果」與「子集值 = 完整 dict 值」。
//
(function (global) {
  'use strict';

  // === ZH_TW_DICT_START ===
  // ZH_TW content 子集（由 tools/build/generate-i18n-content.mjs 從 lib/i18n.js 產出，不可手改）
  const messages_zhTW = {
    'editbar.hint': '點擊虛線框段落可直接編輯譯文',
    'editbar.undo': '復原',
    'editbar.done': '完成',
    'popup.label.modeSingle': '單語覆蓋',
    'popup.label.modeDual': '雙語對照',
    'common.errorUnknown': '未知錯誤',
    'toast.detectGoogleDocs': '偵測到 Google Docs，正在開啟可翻譯的閱讀版⋯',
    'toast.offline': '目前處於離線狀態，無法翻譯。請確認網路連線後再試',
    'toast.noContent': '找不到可翻譯的內容',
    'toast.glossaryBuilding': '建立術語表⋯',
    'toast.translateProgress': '{prefix}翻譯中⋯ {done} / {total}',
    'toast.translateProgressGoogle': '{prefix}Google 翻譯中⋯ {done} / {total}',
    'toast.translateNew': '翻譯新內容⋯ {done} / {total}',
    'toast.translateNewFailed': '新內容翻譯失敗：{error}',
    'toast.cancelled': '已取消翻譯',
    'toast.partialFailed': '翻譯部分失敗：{failed} / {total} 段失敗',
    'toast.translateFailed': '翻譯失敗：{error}',
    'toast.restored': '已還原原文',
    'toast.subtitleRestored': '已還原原文字幕',
    'toast.subtitleNotAvailable': '本影片未提供 CC 字幕，無法翻譯字幕',
    'toast.ytSwitchedNativeTarget': '已自動切換到目標語言的原生字幕。如需雙語對照，請從 YouTube CC 選單手動切到要對照的來源語言（如英文或日文）',
    'yt.status.translating': '翻譯中…',
    'yt.status.waitingCaption': '等待字幕資料…',
    'toast.modeChanged': '顯示模式已切換為「{desc}」，請按快速鍵重新翻譯以套用',
    'toast.done': '翻譯完成（{total} 段）',
    'toast.doneTruncated': '翻譯完成（{total} 段，另有 {truncated} 段因頁面過長被略過）',
    'toast.donePartial': '已翻譯前 {total} 段（共 {all} 段）',
    'toast.allCacheHit': '全部快取命中 · 本次未計費',
    'toast.zhConvertDone': '簡繁本地轉換完成（{total} 段）',
    'toast.zhConvertFree': '只做字典簡繁轉換，未觸發 AI 翻譯 · 免費',
    'toast.zhConvertPartial': '其中 {count} 段是字典簡繁轉換，未經 AI 翻譯（免費）',
    'toast.zhConvertProgress': '{prefix}簡繁本地轉換中⋯ {done} / {total}（不使用 AI 翻譯）',
    'toast.zhConvertNew': '簡繁本地轉換新內容⋯ {done} / {total}',
    'toast.zhConvertRescanDone': '已本地轉換 {done} 段新內容（未使用 AI）',
    'toast.translateRemaining': '翻譯剩餘段落',
    'toast.googleDone': 'Google 翻譯完成（{total} 段）',
    'toast.googleDoneTruncated': 'Google 翻譯完成（{total} 段，另有 {truncated} 段因頁面過長被略過）',
    'toast.googleFreeDetail': '{chars} 字元 · 免費',
    'toast.rescanPartialFailed': '新內容翻譯部分失敗：{failed} / {total} 段',
    'toast.rescanDone': '已翻譯 {done} 段新內容',
    'toast.updateNoticeLink': 'v{version} 可下載 — 點此前往',
    'toast.welcomeNotice.html': '<strong>已升級至 v{version}</strong> — 點工具列圖示看新功能',
    'toast.elapsedSec': '{s} 秒',
    'toast.elapsedMinSec': '{m} 分 {s} 秒',
    'toast.autoTranslateLabel': '自動翻譯',
    'toast.close': '關閉',
    'toast.dismissToday': '今天不再提示',
    'error.batchTimeout': '批次逾時（{s}s）',
    'error.bg.apiKeyMissing': '尚未設定 Gemini API Key，請至設定頁填入',
    'error.bg.baseUrlMissing': '尚未設定自訂 Provider 的 Base URL',
    'error.bg.testKeyEmpty': 'API Key 為空，請先填入再測試',
    'error.bg.testTimeout': '連線逾時，請確認網址與網路狀態',
    'error.bg.testNonJsonGemini': 'HTTP {status}，但回應不是有效的 JSON。可能是網路環境（公司 proxy / 登入頁）攔截了請求，請換網路再試',
    'error.bg.testNonJsonCustom': 'HTTP {status}，但 Provider 回應不是有效的 JSON。請確認 Base URL 是否為正確的 OpenAI-compatible API endpoint',
    'error.bg.customHeadersInvalid': '自訂 request headers 格式有誤，尚未送出測試：{msg}',
    'error.bg.network': '網路錯誤：{msg}',
    'error.bg.timeout': '網路錯誤：逾時（{ms}ms）',
    'error.bg.readTimeout': '網路錯誤：回應讀取逾時（{ms}ms）',
    'error.bg.dailyQuota': '今日 Gemini API 配額已用盡（RPD 達上限），請明天再試或升級付費層級',
    'error.bg.http429': 'HTTP 429（{dim}）',
    'error.bg.badResponse': 'Gemini API 回應格式異常（非 JSON）：HTTP {status}。回應前 200 字元：{preview}',
    'error.bg.blocked': 'Gemini 拒絕處理此請求（promptFeedback.blockReason: {reason}）。可能是安全過濾器誤判，請嘗試縮短段落或調整內容',
    'error.bg.emptySafety': '內容被 Gemini 安全過濾器擋下。可能是原文含有敏感內容，請嘗試跳過此段落',
    'error.bg.emptyRecitation': 'Gemini 偵測到輸出與已知作品高度重複（recitation filter），請嘗試縮短段落',
    'error.bg.emptyMaxTokens': '輸出超過 maxOutputTokens 上限。請到設定頁提高上限，或減少每批段落數',
    'error.bg.emptyOther': 'Gemini 回傳空內容（finishReason: OTHER），原因不明。請稍後重試',
    'error.bg.emptyContent': 'Gemini 回傳空內容（finishReason: {reason}）',
    'error.bg.customBadResponse': '自訂 Provider 回應格式異常（非 JSON）：HTTP {status}。前 200 字：{preview}',
    'error.bg.customEmptyContent': '自訂 Provider 回傳空內容（finish_reason: {reason}）',
    'error.bg.customTruncated': '自訂 Provider 輸出被截斷（finish_reason: {reason}）。請減少每批段落數，或在進階 JSON 提高 {param}',
    'error.bg.gtTimeout': 'Google Translate 逾時（{ms}ms）',
    'instapaper.sending': '正在送到 Instapaper⋯',
    'instapaper.summarizing': '正在製作摘要⋯',
    'instapaper.sent': '已送到 Instapaper',
    'instapaper.failedAuth': 'Instapaper 憑證失效，請到設定重新連結',
    'instapaper.failedNetwork': '送到 Instapaper 失敗：網路錯誤',
    'instapaper.failed': '送到 Instapaper 失敗',
    'instapaper.notEnabled': '請先在設定啟用並連結 Instapaper',
    'shortcut.invalid.needKey': '請按下含一般按鍵的組合',
    'shortcut.invalid.esc': 'ESC 鍵保留作取消錄製',
    'shortcut.invalid.needMod': '組合需包含 ⌥ 或 ⌃（避免打字時誤觸）',
    'shortcut.invalid.isDefault': '{key} 已是內建預設快速鍵',
    'shortcut.invalid.safariNeedCtrl': 'Safari 請用 ⌃ Control 組合',
    'floating.featureMenu': '功能選單',
    'floating.ytSubtitleOn': '啟動字幕翻譯',
    'floating.ytSubtitleOff': '關閉字幕翻譯',
  };
  // === ZH_TW_DICT_END ===

  // === ZH_CN_DICT_START ===
  // ZH_CN content 子集（由 tools/build/generate-i18n-content.mjs 從 lib/i18n.js 產出，不可手改）
  const messages_zhCN = {
    'editbar.hint': '点击虚线框段落可直接编辑译文',
    'editbar.undo': '撤销',
    'editbar.done': '完成',
    'popup.label.modeSingle': '单语覆盖',
    'popup.label.modeDual': '双语对照',
    'common.errorUnknown': '未知错误',
    'toast.detectGoogleDocs': '检测到 Google Docs，正在打开可翻译的阅读版⋯',
    'toast.offline': '目前处于离线状态，无法翻译。请确认网络连接后再试',
    'toast.noContent': '找不到可翻译的内容',
    'toast.glossaryBuilding': '建立术语表⋯',
    'toast.translateProgress': '{prefix}翻译中⋯ {done} / {total}',
    'toast.translateProgressGoogle': '{prefix}Google 翻译中⋯ {done} / {total}',
    'toast.translateNew': '翻译新内容⋯ {done} / {total}',
    'toast.translateNewFailed': '新内容翻译失败：{error}',
    'toast.cancelled': '已取消翻译',
    'toast.partialFailed': '翻译部分失败：{failed} / {total} 段失败',
    'toast.translateFailed': '翻译失败：{error}',
    'toast.restored': '已还原原文',
    'toast.subtitleRestored': '已还原原文字幕',
    'toast.subtitleNotAvailable': '本视频未提供 CC 字幕，无法翻译字幕',
    'toast.ytSwitchedNativeTarget': '已自动切换到目标语言的原生字幕。如需双语对照，请从 YouTube CC 菜单手动切到要对照的来源语言（如英文或日文）',
    'yt.status.translating': '翻译中…',
    'yt.status.waitingCaption': '等待字幕数据…',
    'toast.modeChanged': '显示模式已切换为「{desc}」，请按快捷键重新翻译以应用',
    'toast.done': '翻译完成（{total} 段）',
    'toast.doneTruncated': '翻译完成（{total} 段，另有 {truncated} 段因页面过长被略过）',
    'toast.donePartial': '已翻译前 {total} 段（共 {all} 段）',
    'toast.allCacheHit': '全部缓存命中 · 本次未计费',
    'toast.zhConvertDone': '简繁本地转换完成（{total} 段）',
    'toast.zhConvertFree': '只做字典简繁转换，未触发 AI 翻译 · 免费',
    'toast.zhConvertPartial': '其中 {count} 段是字典简繁转换，未经 AI 翻译（免费）',
    'toast.zhConvertProgress': '{prefix}简繁本地转换中⋯ {done} / {total}（不使用 AI 翻译）',
    'toast.zhConvertNew': '简繁本地转换新内容⋯ {done} / {total}',
    'toast.zhConvertRescanDone': '已本地转换 {done} 段新内容（未使用 AI）',
    'toast.translateRemaining': '翻译剩余段落',
    'toast.googleDone': 'Google 翻译完成（{total} 段）',
    'toast.googleDoneTruncated': 'Google 翻译完成（{total} 段，另有 {truncated} 段因页面过长被略过）',
    'toast.googleFreeDetail': '{chars} 字符 · 免费',
    'toast.rescanPartialFailed': '新内容翻译部分失败：{failed} / {total} 段',
    'toast.rescanDone': '已翻译 {done} 段新内容',
    'toast.updateNoticeLink': 'v{version} 可下载 — 点此前往',
    'toast.welcomeNotice.html': '<strong>已升级至 v{version}</strong> — 点工具栏图标看新功能',
    'toast.elapsedSec': '{s} 秒',
    'toast.elapsedMinSec': '{m} 分 {s} 秒',
    'toast.autoTranslateLabel': '自动翻译',
    'toast.close': '关闭',
    'toast.dismissToday': '今天不再提示',
    'error.batchTimeout': '批次超时（{s}s）',
    'error.bg.apiKeyMissing': '尚未设置 Gemini API Key，请至设置页填入',
    'error.bg.baseUrlMissing': '尚未设置自定义 Provider 的 Base URL',
    'error.bg.testKeyEmpty': 'API Key 为空，请先填入再测试',
    'error.bg.testTimeout': '连接超时，请确认网址与网络状态',
    'error.bg.testNonJsonGemini': 'HTTP {status}，但响应不是有效的 JSON。可能是网络环境（公司 proxy / 登录页）拦截了请求，请换网络再试',
    'error.bg.testNonJsonCustom': 'HTTP {status}，但 Provider 响应不是有效的 JSON。请确认 Base URL 是否为正确的 OpenAI-compatible API endpoint',
    'error.bg.customHeadersInvalid': '自定义 request headers 格式有误，尚未发出测试：{msg}',
    'error.bg.network': '网络错误：{msg}',
    'error.bg.timeout': '网络错误：超时（{ms}ms）',
    'error.bg.readTimeout': '网络错误：响应读取超时（{ms}ms）',
    'error.bg.dailyQuota': '今日 Gemini API 配额已用尽（RPD 达上限），请明天再试或升级付费层级',
    'error.bg.http429': 'HTTP 429（{dim}）',
    'error.bg.badResponse': 'Gemini API 响应格式异常（非 JSON）：HTTP {status}。响应前 200 字符：{preview}',
    'error.bg.blocked': 'Gemini 拒绝处理此请求（promptFeedback.blockReason: {reason}）。可能是安全过滤器误判，请尝试缩短段落或调整内容',
    'error.bg.emptySafety': '内容被 Gemini 安全过滤器拦下。可能是原文含有敏感内容，请尝试跳过此段落',
    'error.bg.emptyRecitation': 'Gemini 检测到输出与已知作品高度重复（recitation filter），请尝试缩短段落',
    'error.bg.emptyMaxTokens': '输出超过 maxOutputTokens 上限。请到设置页提高上限，或减少每批段落数',
    'error.bg.emptyOther': 'Gemini 返回空内容（finishReason: OTHER），原因不明。请稍后重试',
    'error.bg.emptyContent': 'Gemini 返回空内容（finishReason: {reason}）',
    'error.bg.customBadResponse': '自定义 Provider 响应格式异常（非 JSON）：HTTP {status}。前 200 字：{preview}',
    'error.bg.customEmptyContent': '自定义 Provider 返回空内容（finish_reason: {reason}）',
    'error.bg.customTruncated': '自定义 Provider 输出被截断（finish_reason: {reason}）。请减少每批段落数，或在高级 JSON 中提高 {param}',
    'error.bg.gtTimeout': 'Google Translate 超时（{ms}ms）',
    'instapaper.sending': '正在发送到 Instapaper⋯',
    'instapaper.summarizing': '正在生成摘要⋯',
    'instapaper.sent': '已发送到 Instapaper',
    'instapaper.failedAuth': 'Instapaper 凭证失效，请到设置重新连结',
    'instapaper.failedNetwork': '发送到 Instapaper 失败：网络错误',
    'instapaper.failed': '发送到 Instapaper 失败',
    'instapaper.notEnabled': '请先在设置启用并连结 Instapaper',
    'shortcut.invalid.needKey': '请按下含普通按键的组合',
    'shortcut.invalid.esc': 'ESC 键保留用于取消录制',
    'shortcut.invalid.needMod': '组合需包含 ⌥ 或 ⌃（避免打字时误触）',
    'shortcut.invalid.isDefault': '{key} 已是内建预设快捷键',
    'shortcut.invalid.safariNeedCtrl': 'Safari 请用 ⌃ Control 组合',
    'floating.featureMenu': '功能菜单',
    'floating.ytSubtitleOn': '启动字幕翻译',
    'floating.ytSubtitleOff': '关闭字幕翻译',
  };
  // === ZH_CN_DICT_END ===

  // === EN_DICT_START ===
  // EN content 子集（由 tools/build/generate-i18n-content.mjs 從 lib/i18n.js 產出，不可手改）
  const messages_en = {
    'editbar.hint': 'Click a dashed-outline paragraph to edit its translation',
    'editbar.undo': 'Undo',
    'editbar.done': 'Done',
    'popup.label.modeSingle': 'Replace',
    'popup.label.modeDual': 'Bilingual',
    'common.errorUnknown': 'Unknown error',
    'toast.detectGoogleDocs': 'Google Docs detected, opening translatable reader view…',
    'toast.offline': 'You are offline, cannot translate. Please check your network and retry',
    'toast.noContent': 'No translatable content found',
    'toast.glossaryBuilding': 'Building glossary…',
    'toast.translateProgress': '{prefix}Translating… {done} / {total}',
    'toast.translateProgressGoogle': '{prefix}Google Translating… {done} / {total}',
    'toast.translateNew': 'Translating new content… {done} / {total}',
    'toast.translateNewFailed': 'New content translation failed: {error}',
    'toast.cancelled': 'Translation cancelled',
    'toast.partialFailed': 'Translation partially failed: {failed} / {total} segments failed',
    'toast.translateFailed': 'Translation failed: {error}',
    'toast.restored': 'Original restored',
    'toast.subtitleRestored': 'Original subtitles restored',
    'toast.subtitleNotAvailable': 'This video has no CC subtitles available',
    'toast.ytSwitchedNativeTarget': 'Switched to the native subtitle track in your target language. For bilingual mode, manually pick a source-language track (e.g. English or Japanese) from the YouTube CC menu',
    'yt.status.translating': 'Translating…',
    'yt.status.waitingCaption': 'Waiting for caption data…',
    'toast.modeChanged': 'Display mode switched to "{desc}", press shortcut to re-translate to apply',
    'toast.done': 'Translation complete ({total} segments)',
    'toast.doneTruncated': 'Translation complete ({total} segments; {truncated} more skipped because the page is too long)',
    'toast.donePartial': 'Translated first {total} segments (of {all})',
    'toast.allCacheHit': 'All cache hits · nothing billed this run',
    'toast.zhConvertDone': 'Local Chinese script conversion done ({total} segments)',
    'toast.zhConvertFree': 'Dictionary-based script conversion only · no AI translation triggered · free',
    'toast.zhConvertPartial': '{count} segments were dictionary script conversion, not AI translation (free)',
    'toast.zhConvertProgress': '{prefix}Converting Chinese script locally… {done} / {total} (no AI translation)',
    'toast.zhConvertNew': 'Converting new content locally… {done} / {total}',
    'toast.zhConvertRescanDone': '{done} new segments converted locally (no AI)',
    'toast.translateRemaining': 'Translate the rest',
    'toast.googleDone': 'Google translation complete ({total} segments)',
    'toast.googleDoneTruncated': 'Google translation complete ({total} segments; {truncated} more skipped because the page is too long)',
    'toast.googleFreeDetail': '{chars} characters · free',
    'toast.rescanPartialFailed': 'New content translation partially failed: {failed} / {total} segments',
    'toast.rescanDone': 'Translated {done} new segments',
    'toast.updateNoticeLink': 'v{version} available — click to open',
    'toast.welcomeNotice.html': '<strong>Upgraded to v{version}</strong> — click the toolbar icon to see what\'s new',
    'toast.elapsedSec': '{s} s',
    'toast.elapsedMinSec': '{m} min {s} s',
    'toast.autoTranslateLabel': 'Auto-translate',
    'toast.close': 'Close',
    'toast.dismissToday': 'Don\'t remind me again today',
    'error.batchTimeout': 'Batch timed out ({s}s)',
    'error.bg.apiKeyMissing': 'Gemini API Key not set. Please enter it on the options page',
    'error.bg.baseUrlMissing': 'Custom provider Base URL not set',
    'error.bg.testKeyEmpty': 'API key is empty. Enter it before testing',
    'error.bg.testTimeout': 'Connection timed out. Check the URL and your network',
    'error.bg.testNonJsonGemini': 'HTTP {status}, but the response is not valid JSON. Your network (corporate proxy / login page) may be intercepting the request; try another network',
    'error.bg.testNonJsonCustom': 'HTTP {status}, but the provider response is not valid JSON. Check that the Base URL is a correct OpenAI-compatible API endpoint',
    'error.bg.customHeadersInvalid': 'Custom request headers are invalid; the test was not sent: {msg}',
    'error.bg.network': 'Network error: {msg}',
    'error.bg.timeout': 'Network error: timed out ({ms}ms)',
    'error.bg.readTimeout': 'Network error: response read timed out ({ms}ms)',
    'error.bg.dailyQuota': 'Daily Gemini API quota exhausted (RPD limit reached). Please try again tomorrow or upgrade your paid tier',
    'error.bg.http429': 'HTTP 429 ({dim})',
    'error.bg.badResponse': 'Unexpected Gemini API response (not JSON): HTTP {status}. First 200 chars: {preview}',
    'error.bg.blocked': 'Gemini refused this request (promptFeedback.blockReason: {reason}). Possibly a safety-filter false positive — try shorter paragraphs or adjust the content',
    'error.bg.emptySafety': 'Content blocked by the Gemini safety filter. The original text may contain sensitive content — try skipping this paragraph',
    'error.bg.emptyRecitation': 'Gemini detected output highly similar to known works (recitation filter) — try shorter paragraphs',
    'error.bg.emptyMaxTokens': 'Output exceeded the maxOutputTokens limit. Raise the limit on the options page or reduce paragraphs per batch',
    'error.bg.emptyOther': 'Gemini returned empty content (finishReason: OTHER), reason unknown. Please retry later',
    'error.bg.emptyContent': 'Gemini returned empty content (finishReason: {reason})',
    'error.bg.customBadResponse': 'Unexpected custom provider response (not JSON): HTTP {status}. First 200 chars: {preview}',
    'error.bg.customEmptyContent': 'Custom provider returned empty content (finish_reason: {reason})',
    'error.bg.customTruncated': 'Custom provider output was truncated (finish_reason: {reason}). Reduce paragraphs per batch, or raise {param} in the advanced JSON',
    'error.bg.gtTimeout': 'Google Translate timed out ({ms}ms)',
    'instapaper.sending': 'Sending to Instapaper…',
    'instapaper.summarizing': 'Summarizing…',
    'instapaper.sent': 'Sent to Instapaper',
    'instapaper.failedAuth': 'Instapaper credentials expired — re-link in settings',
    'instapaper.failedNetwork': 'Send to Instapaper failed: network error',
    'instapaper.failed': 'Send to Instapaper failed',
    'instapaper.notEnabled': 'Enable and link Instapaper in settings first',
    'shortcut.invalid.needKey': 'Press a combination that includes a regular key',
    'shortcut.invalid.esc': 'ESC is reserved for canceling recording',
    'shortcut.invalid.needMod': 'The combination must include ⌥ or ⌃ (to avoid triggering while typing)',
    'shortcut.invalid.isDefault': '{key} is already a built-in default shortcut',
    'shortcut.invalid.safariNeedCtrl': 'On Safari use a ⌃ Control combo',
    'floating.featureMenu': 'Menu',
    'floating.ytSubtitleOn': 'Translate subtitles',
    'floating.ytSubtitleOff': 'Stop subtitle translation',
  };
  // === EN_DICT_END ===

  // === JA_DICT_START ===
  // JA content 子集（由 tools/build/generate-i18n-content.mjs 從 lib/i18n.js 產出，不可手改）
  const messages_ja = {
    'editbar.hint': '破線枠の段落をクリックすると訳文を編集できます',
    'editbar.undo': '元に戻す',
    'editbar.done': '完了',
    'popup.label.modeSingle': '原文置換',
    'popup.label.modeDual': '対訳表示',
    'common.errorUnknown': '不明なエラー',
    'toast.detectGoogleDocs': 'Google Docs を検出しました。翻訳可能なリーダー版を開いています⋯',
    'toast.offline': '現在オフラインのため翻訳できません。ネットワーク接続を確認してください',
    'toast.noContent': '翻訳可能なコンテンツが見つかりません',
    'toast.glossaryBuilding': '用語集を作成中⋯',
    'toast.translateProgress': '{prefix}翻訳中⋯ {done} / {total}',
    'toast.translateProgressGoogle': '{prefix}Google で翻訳中⋯ {done} / {total}',
    'toast.translateNew': '新しいコンテンツを翻訳中⋯ {done} / {total}',
    'toast.translateNewFailed': '新しいコンテンツの翻訳に失敗：{error}',
    'toast.cancelled': '翻訳をキャンセルしました',
    'toast.partialFailed': '一部の翻訳に失敗：{failed} / {total} 件',
    'toast.translateFailed': '翻訳に失敗：{error}',
    'toast.restored': '原文を復元しました',
    'toast.subtitleRestored': '字幕の原文を復元しました',
    'toast.subtitleNotAvailable': 'この動画には CC 字幕が提供されていません',
    'toast.ytSwitchedNativeTarget': 'ターゲット言語のネイティブ字幕トラックに自動で切り替えました。二言語表示にするには、YouTube の CC メニューから対照したい元言語（英語など）のトラックを手動で選んでください',
    'yt.status.translating': '翻訳中…',
    'yt.status.waitingCaption': '字幕データを待機中…',
    'toast.modeChanged': '表示モードを「{desc}」に変更しました。ショートカットで再翻訳して反映してください',
    'toast.done': '翻訳完了（{total} 段落）',
    'toast.doneTruncated': '翻訳完了（{total} 段落、ほか {truncated} 段落はページが長すぎるためスキップ）',
    'toast.donePartial': '先頭 {total} 段落を翻訳済み（全 {all} 段落）',
    'toast.allCacheHit': 'すべてキャッシュヒット · 今回は課金なし',
    'toast.zhConvertDone': '簡繁ローカル変換完了（{total} 段落）',
    'toast.zhConvertFree': '辞書による簡繁変換のみ・AI 翻訳は実行していません · 無料',
    'toast.zhConvertPartial': 'うち {count} 段落は辞書による簡繁変換で、AI 翻訳は未使用（無料）',
    'toast.zhConvertProgress': '{prefix}簡繁ローカル変換中⋯ {done} / {total}（AI 翻訳は使いません）',
    'toast.zhConvertNew': '新しいコンテンツをローカル変換中⋯ {done} / {total}',
    'toast.zhConvertRescanDone': '新しいコンテンツ {done} 段落をローカル変換しました（AI 未使用）',
    'toast.translateRemaining': '残りを翻訳',
    'toast.googleDone': 'Google 翻訳完了（{total} 段落）',
    'toast.googleDoneTruncated': 'Google 翻訳完了（{total} 段落、ほか {truncated} 段落はページが長すぎるためスキップ）',
    'toast.googleFreeDetail': '{chars} 文字 · 無料',
    'toast.rescanPartialFailed': '新しいコンテンツの翻訳が一部失敗：{failed} / {total} 段落',
    'toast.rescanDone': '新しいコンテンツ {done} 段落を翻訳しました',
    'toast.updateNoticeLink': 'v{version} が利用可能 — ここをクリック',
    'toast.welcomeNotice.html': '<strong>v{version} にアップグレードしました</strong> — ツールバーアイコンで新機能を確認',
    'toast.elapsedSec': '{s} 秒',
    'toast.elapsedMinSec': '{m} 分 {s} 秒',
    'toast.autoTranslateLabel': '自動翻訳',
    'toast.close': '閉じる',
    'toast.dismissToday': '今日は再表示しない',
    'error.batchTimeout': 'バッチがタイムアウトしました（{s} 秒）',
    'error.bg.apiKeyMissing': 'Gemini API Key が未設定です。設定ページで入力してください',
    'error.bg.baseUrlMissing': 'カスタム Provider の Base URL が未設定です',
    'error.bg.testKeyEmpty': 'API Key が空です。入力してからテストしてください',
    'error.bg.testTimeout': '接続がタイムアウトしました。URL とネットワーク状態を確認してください',
    'error.bg.testNonJsonGemini': 'HTTP {status} ですが、応答が有効な JSON ではありません。ネットワーク環境（社内 proxy / ログインページ）がリクエストを横取りしている可能性があります。別のネットワークでお試しください',
    'error.bg.testNonJsonCustom': 'HTTP {status} ですが、Provider の応答が有効な JSON ではありません。Base URL が正しい OpenAI-compatible API endpoint か確認してください',
    'error.bg.customHeadersInvalid': 'カスタム request headers の形式に誤りがあるため、テストは送信されませんでした：{msg}',
    'error.bg.network': 'ネットワークエラー：{msg}',
    'error.bg.timeout': 'ネットワークエラー：タイムアウト（{ms}ms）',
    'error.bg.readTimeout': 'ネットワークエラー：レスポンス読み取りタイムアウト（{ms}ms）',
    'error.bg.dailyQuota': '本日の Gemini API 割り当てを使い切りました（RPD 上限）。明日再試行するか、有料プランへのアップグレードをご検討ください',
    'error.bg.http429': 'HTTP 429（{dim}）',
    'error.bg.badResponse': 'Gemini API のレスポンス形式が異常です（非 JSON）：HTTP {status}。先頭 200 文字：{preview}',
    'error.bg.blocked': 'Gemini がこのリクエストを拒否しました（promptFeedback.blockReason: {reason}）。安全フィルターの誤判定の可能性があります。段落を短くするか内容を調整してください',
    'error.bg.emptySafety': 'コンテンツが Gemini の安全フィルターでブロックされました。原文に機微な内容が含まれている可能性があります。この段落をスキップしてみてください',
    'error.bg.emptyRecitation': 'Gemini が既知の作品と高度に重複する出力を検出しました（recitation filter）。段落を短くしてみてください',
    'error.bg.emptyMaxTokens': '出力が maxOutputTokens の上限を超えました。設定ページで上限を上げるか、バッチあたりの段落数を減らしてください',
    'error.bg.emptyOther': 'Gemini が空のコンテンツを返しました（finishReason: OTHER）。原因不明です。後ほど再試行してください',
    'error.bg.emptyContent': 'Gemini が空のコンテンツを返しました（finishReason: {reason}）',
    'error.bg.customBadResponse': 'カスタム Provider のレスポンス形式が異常です（非 JSON）：HTTP {status}。先頭 200 文字：{preview}',
    'error.bg.customEmptyContent': 'カスタム Provider が空のコンテンツを返しました（finish_reason: {reason}）',
    'error.bg.customTruncated': 'カスタム Provider の出力が途中で切れました（finish_reason: {reason}）。1 バッチあたりの段落数を減らすか、詳細 JSON で {param} を増やしてください',
    'error.bg.gtTimeout': 'Google Translate がタイムアウトしました（{ms}ms）',
    'instapaper.sending': 'Instapaper に送信中⋯',
    'instapaper.summarizing': '要約を作成中⋯',
    'instapaper.sent': 'Instapaper に送信しました',
    'instapaper.failedAuth': 'Instapaper の認証が失効しました。設定で再連携してください',
    'instapaper.failedNetwork': 'Instapaper への送信に失敗：ネットワークエラー',
    'instapaper.failed': 'Instapaper への送信に失敗しました',
    'instapaper.notEnabled': '先に設定で Instapaper を有効化して連携してください',
    'shortcut.invalid.needKey': '通常キーを含む組み合わせを押してください',
    'shortcut.invalid.esc': 'ESC はキー入力のキャンセル用に予約されています',
    'shortcut.invalid.needMod': '組み合わせには ⌥ または ⌃ が必要です（入力中の誤操作を防ぐため）',
    'shortcut.invalid.isDefault': '{key} はすでに内蔵のデフォルトショートカットです',
    'shortcut.invalid.safariNeedCtrl': 'Safari では ⌃ Control の組み合わせを使ってください',
    'floating.featureMenu': 'メニュー',
    'floating.ytSubtitleOn': '字幕を翻訳',
    'floating.ytSubtitleOff': '字幕翻訳を停止',
  };
  // === JA_DICT_END ===

  // === KO_DICT_START ===
  // KO content 子集（由 tools/build/generate-i18n-content.mjs 從 lib/i18n.js 產出，不可手改）
  const messages_ko = {
    'editbar.hint': '점선 테두리 단락을 클릭하면 번역문을 편집할 수 있습니다',
    'editbar.undo': '실행 취소',
    'editbar.done': '완료',
    'popup.label.modeSingle': '원문 대체',
    'popup.label.modeDual': '대역 표시',
    'common.errorUnknown': '알 수 없는 오류',
    'toast.detectGoogleDocs': 'Google Docs 감지됨, 번역 가능한 리더 버전 여는 중⋯',
    'toast.offline': '현재 오프라인 상태로 번역할 수 없습니다. 네트워크 연결을 확인하세요',
    'toast.noContent': '번역 가능한 콘텐츠를 찾을 수 없음',
    'toast.glossaryBuilding': '용어집 작성 중⋯',
    'toast.translateProgress': '{prefix}번역 중⋯ {done} / {total}',
    'toast.translateProgressGoogle': '{prefix}Google 번역 중⋯ {done} / {total}',
    'toast.translateNew': '새 콘텐츠 번역 중⋯ {done} / {total}',
    'toast.translateNewFailed': '새 콘텐츠 번역 실패: {error}',
    'toast.cancelled': '번역이 취소됨',
    'toast.partialFailed': '일부 번역 실패: {failed} / {total}개 실패',
    'toast.translateFailed': '번역 실패: {error}',
    'toast.restored': '원문 복원됨',
    'toast.subtitleRestored': '원문 자막 복원됨',
    'toast.subtitleNotAvailable': '이 영상에는 CC 자막이 제공되지 않습니다',
    'toast.ytSwitchedNativeTarget': '목표 언어의 기본 자막 트랙으로 자동 전환했습니다. 이중 자막을 사용하려면 YouTube CC 메뉴에서 대조할 원어(예: 영어, 일본어) 트랙을 직접 선택하세요',
    'yt.status.translating': '번역 중…',
    'yt.status.waitingCaption': '자막 데이터 대기 중…',
    'toast.modeChanged': '표시 모드가 "{desc}"(으)로 변경되었습니다. 단축키로 다시 번역하여 적용하세요',
    'toast.done': '번역 완료 ({total}개 단락)',
    'toast.doneTruncated': '번역 완료 ({total}개 단락, 페이지가 너무 길어 {truncated}개 단락은 건너뜀)',
    'toast.donePartial': '앞 {total}개 단락 번역됨 (전체 {all}개)',
    'toast.allCacheHit': '모두 캐시 적중 · 이번에는 과금 없음',
    'toast.zhConvertDone': '간·번체 로컬 변환 완료 ({total}개 단락)',
    'toast.zhConvertFree': '사전 기반 간·번체 변환만 수행 · AI 번역 미실행 · 무료',
    'toast.zhConvertPartial': '이 중 {count}개 단락은 사전 기반 변환이며 AI 번역은 사용하지 않음 (무료)',
    'toast.zhConvertProgress': '{prefix}간·번체 로컬 변환 중⋯ {done} / {total} (AI 번역 미사용)',
    'toast.zhConvertNew': '새 콘텐츠 로컬 변환 중⋯ {done} / {total}',
    'toast.zhConvertRescanDone': '새 콘텐츠 {done}개 단락 로컬 변환됨 (AI 미사용)',
    'toast.translateRemaining': '나머지 번역',
    'toast.googleDone': 'Google 번역 완료 ({total}개 단락)',
    'toast.googleDoneTruncated': 'Google 번역 완료 ({total}개 단락, 페이지가 너무 길어 {truncated}개 단락은 건너뜀)',
    'toast.googleFreeDetail': '{chars}자 · 무료',
    'toast.rescanPartialFailed': '새 콘텐츠 번역 일부 실패: {failed} / {total} 단락',
    'toast.rescanDone': '새 콘텐츠 {done}개 단락 번역됨',
    'toast.updateNoticeLink': 'v{version} 다운로드 가능 — 여기를 클릭',
    'toast.welcomeNotice.html': '<strong>v{version}(으)로 업그레이드됨</strong> — 툴바 아이콘에서 새 기능 확인',
    'toast.elapsedSec': '{s}초',
    'toast.elapsedMinSec': '{m}분 {s}초',
    'toast.autoTranslateLabel': '자동 번역',
    'toast.close': '닫기',
    'toast.dismissToday': '오늘은 다시 표시하지 않음',
    'error.batchTimeout': '배치 시간 초과 ({s}초)',
    'error.bg.apiKeyMissing': 'Gemini API Key가 설정되지 않았습니다. 설정 페이지에서 입력해 주세요',
    'error.bg.baseUrlMissing': '사용자 지정 Provider의 Base URL이 설정되지 않았습니다',
    'error.bg.testKeyEmpty': 'API Key가 비어 있습니다. 입력한 뒤 테스트하세요',
    'error.bg.testTimeout': '연결 시간이 초과되었습니다. 주소와 네트워크 상태를 확인하세요',
    'error.bg.testNonJsonGemini': 'HTTP {status}이지만 응답이 유효한 JSON이 아닙니다. 네트워크 환경(회사 proxy / 로그인 페이지)이 요청을 가로챘을 수 있습니다. 다른 네트워크에서 다시 시도하세요',
    'error.bg.testNonJsonCustom': 'HTTP {status}이지만 Provider 응답이 유효한 JSON이 아닙니다. Base URL이 올바른 OpenAI-compatible API endpoint인지 확인하세요',
    'error.bg.customHeadersInvalid': '커스텀 request headers 형식이 잘못되어 테스트를 보내지 않았습니다: {msg}',
    'error.bg.network': '네트워크 오류: {msg}',
    'error.bg.timeout': '네트워크 오류: 시간 초과 ({ms}ms)',
    'error.bg.readTimeout': '네트워크 오류: 응답 읽기 시간 초과 ({ms}ms)',
    'error.bg.dailyQuota': '오늘의 Gemini API 할당량을 모두 사용했습니다 (RPD 상한 도달). 내일 다시 시도하거나 유료 등급으로 업그레이드해 주세요',
    'error.bg.http429': 'HTTP 429 ({dim})',
    'error.bg.badResponse': 'Gemini API 응답 형식 이상 (비 JSON): HTTP {status}. 처음 200자: {preview}',
    'error.bg.blocked': 'Gemini가 이 요청을 거부했습니다 (promptFeedback.blockReason: {reason}). 안전 필터 오판일 수 있으니 단락을 줄이거나 내용을 조정해 보세요',
    'error.bg.emptySafety': '콘텐츠가 Gemini 안전 필터에 차단되었습니다. 원문에 민감한 내용이 포함되었을 수 있으니 이 단락을 건너뛰어 보세요',
    'error.bg.emptyRecitation': 'Gemini가 기존 저작물과 고도로 중복되는 출력을 감지했습니다 (recitation filter). 단락을 줄여 보세요',
    'error.bg.emptyMaxTokens': '출력이 maxOutputTokens 상한을 초과했습니다. 설정 페이지에서 상한을 높이거나 배치당 단락 수를 줄여 주세요',
    'error.bg.emptyOther': 'Gemini가 빈 콘텐츠를 반환했습니다 (finishReason: OTHER). 원인 불명입니다. 잠시 후 다시 시도해 주세요',
    'error.bg.emptyContent': 'Gemini가 빈 콘텐츠를 반환했습니다 (finishReason: {reason})',
    'error.bg.customBadResponse': '사용자 지정 Provider 응답 형식 이상 (비 JSON): HTTP {status}. 처음 200자: {preview}',
    'error.bg.customEmptyContent': '사용자 지정 Provider가 빈 콘텐츠를 반환했습니다 (finish_reason: {reason})',
    'error.bg.customTruncated': '사용자 지정 Provider 출력이 잘렸습니다 (finish_reason: {reason}). 배치당 단락 수를 줄이거나 고급 JSON에서 {param}를 높이세요',
    'error.bg.gtTimeout': 'Google Translate 시간 초과 ({ms}ms)',
    'instapaper.sending': 'Instapaper로 보내는 중⋯',
    'instapaper.summarizing': '요약 작성 중⋯',
    'instapaper.sent': 'Instapaper로 보냈습니다',
    'instapaper.failedAuth': 'Instapaper 인증이 만료되었습니다. 설정에서 다시 연결하세요',
    'instapaper.failedNetwork': 'Instapaper 보내기 실패: 네트워크 오류',
    'instapaper.failed': 'Instapaper 보내기 실패',
    'instapaper.notEnabled': '먼저 설정에서 Instapaper를 사용 설정하고 연결하세요',
    'shortcut.invalid.needKey': '일반 키가 포함된 조합을 누르세요',
    'shortcut.invalid.esc': 'ESC는 입력 취소용으로 예약되어 있습니다',
    'shortcut.invalid.needMod': '조합에 ⌥ 또는 ⌃가 포함되어야 합니다(입력 중 오작동 방지)',
    'shortcut.invalid.isDefault': '{key}는 이미 기본 내장 단축키입니다',
    'shortcut.invalid.safariNeedCtrl': 'Safari에서는 ⌃ Control 조합을 사용하세요',
    'floating.featureMenu': '메뉴',
    'floating.ytSubtitleOn': '자막 번역 시작',
    'floating.ytSubtitleOff': '자막 번역 중지',
  };
  // === KO_DICT_END ===
  // === ES_DICT_START ===
  // ES content 子集（由 tools/build/generate-i18n-content.mjs 從 lib/i18n.js 產出，不可手改）
  const messages_es = {
    'editbar.hint': 'Haz clic en un párrafo con borde discontinuo para editar su traducción',
    'editbar.undo': 'Deshacer',
    'editbar.done': 'Listo',
    'popup.label.modeSingle': 'Reemplazar original',
    'popup.label.modeDual': 'Bilingüe',
    'common.errorUnknown': 'Error desconocido',
    'toast.detectGoogleDocs': 'Google Docs detectado, abriendo versión de lector traducible⋯',
    'toast.offline': 'Sin conexión, no se puede traducir. Comprueba tu red e inténtalo de nuevo',
    'toast.noContent': 'No se encontró contenido traducible',
    'toast.glossaryBuilding': 'Generando glosario⋯',
    'toast.translateProgress': '{prefix}Traduciendo⋯ {done} / {total}',
    'toast.translateProgressGoogle': '{prefix}Traduciendo con Google⋯ {done} / {total}',
    'toast.translateNew': 'Traduciendo contenido nuevo⋯ {done} / {total}',
    'toast.translateNewFailed': 'Error al traducir contenido nuevo: {error}',
    'toast.cancelled': 'Traducción cancelada',
    'toast.partialFailed': 'Traducción parcial fallida: {failed} / {total} segmentos fallaron',
    'toast.translateFailed': 'Error de traducción: {error}',
    'toast.restored': 'Original restaurado',
    'toast.subtitleRestored': 'Subtítulos originales restaurados',
    'toast.subtitleNotAvailable': 'Este vídeo no tiene subtítulos CC disponibles',
    'toast.ytSwitchedNativeTarget': 'Se cambió automáticamente a la pista de subtítulos nativa en tu idioma de destino. Para el modo bilingüe, elige manualmente una pista en el idioma de origen (p. ej. inglés o japonés) en el menú CC de YouTube',
    'yt.status.translating': 'Traduciendo…',
    'yt.status.waitingCaption': 'Esperando datos de subtítulos…',
    'toast.modeChanged': 'Modo de visualización cambiado a "{desc}", pulsa el atajo para volver a traducir y aplicarlo',
    'toast.done': 'Traducción completada ({total} segmentos)',
    'toast.doneTruncated': 'Traducción completada ({total} segmentos; {truncated} más omitidos porque la página es demasiado larga)',
    'toast.donePartial': 'Traducidos los primeros {total} segmentos (de {all})',
    'toast.allCacheHit': 'Todo desde caché · nada facturado esta vez',
    'toast.zhConvertDone': 'Conversión local de escritura china completada ({total} segmentos)',
    'toast.zhConvertFree': 'Solo conversión por diccionario · sin traducción con IA · gratis',
    'toast.zhConvertPartial': '{count} segmentos fueron conversión por diccionario, no traducción con IA (gratis)',
    'toast.zhConvertProgress': '{prefix}Convirtiendo escritura china localmente⋯ {done} / {total} (sin IA)',
    'toast.zhConvertNew': 'Convirtiendo contenido nuevo localmente⋯ {done} / {total}',
    'toast.zhConvertRescanDone': '{done} segmentos nuevos convertidos localmente (sin IA)',
    'toast.translateRemaining': 'Traducir el resto',
    'toast.googleDone': 'Traducción de Google completada ({total} segmentos)',
    'toast.googleDoneTruncated': 'Traducción de Google completada ({total} segmentos; {truncated} más omitidos porque la página es demasiado larga)',
    'toast.googleFreeDetail': '{chars} caracteres · gratis',
    'toast.rescanPartialFailed': 'Traducción del contenido nuevo parcialmente fallida: {failed} / {total} segmentos',
    'toast.rescanDone': '{done} segmentos nuevos traducidos',
    'toast.updateNoticeLink': 'v{version} disponible — haz clic aquí',
    'toast.welcomeNotice.html': '<strong>Actualizado a v{version}</strong> — haz clic en el icono de la barra de herramientas para ver las novedades',
    'toast.elapsedSec': '{s} s',
    'toast.elapsedMinSec': '{m} min {s} s',
    'toast.autoTranslateLabel': 'Traducción automática',
    'toast.close': 'Cerrar',
    'toast.dismissToday': 'No recordar más por hoy',
    'error.batchTimeout': 'El lote agotó el tiempo ({s} s)',
    'error.bg.apiKeyMissing': 'Gemini API Key sin configurar. Introdúcela en la página de opciones',
    'error.bg.baseUrlMissing': 'Base URL del proveedor personalizado sin configurar',
    'error.bg.testKeyEmpty': 'La API Key está vacía. Introdúcela antes de probar',
    'error.bg.testTimeout': 'Tiempo de conexión agotado. Comprueba la URL y tu red',
    'error.bg.testNonJsonGemini': 'HTTP {status}, pero la respuesta no es JSON válido. Puede que tu red (proxy corporativo / página de inicio de sesión) esté interceptando la solicitud; prueba con otra red',
    'error.bg.testNonJsonCustom': 'HTTP {status}, pero la respuesta del proveedor no es JSON válido. Comprueba que la Base URL sea un endpoint de API compatible con OpenAI correcto',
    'error.bg.customHeadersInvalid': 'Los request headers personalizados no son válidos; no se envió la prueba: {msg}',
    'error.bg.network': 'Error de red: {msg}',
    'error.bg.timeout': 'Error de red: tiempo agotado ({ms} ms)',
    'error.bg.readTimeout': 'Error de red: tiempo de lectura de la respuesta agotado ({ms} ms)',
    'error.bg.dailyQuota': 'Cuota diaria de la API de Gemini agotada (límite RPD alcanzado). Inténtalo mañana o mejora tu nivel de pago',
    'error.bg.http429': 'HTTP 429 ({dim})',
    'error.bg.badResponse': 'Respuesta anómala de la API de Gemini (no JSON): HTTP {status}. Primeros 200 caracteres: {preview}',
    'error.bg.blocked': 'Gemini rechazó esta solicitud (promptFeedback.blockReason: {reason}). Puede ser un falso positivo del filtro de seguridad; prueba con párrafos más cortos o ajusta el contenido',
    'error.bg.emptySafety': 'Contenido bloqueado por el filtro de seguridad de Gemini. El texto original puede contener contenido sensible; prueba a omitir este párrafo',
    'error.bg.emptyRecitation': 'Gemini detectó una salida muy similar a obras conocidas (recitation filter); prueba con párrafos más cortos',
    'error.bg.emptyMaxTokens': 'La salida superó el límite de maxOutputTokens. Sube el límite en la página de opciones o reduce los párrafos por lote',
    'error.bg.emptyOther': 'Gemini devolvió contenido vacío (finishReason: OTHER), causa desconocida. Inténtalo más tarde',
    'error.bg.emptyContent': 'Gemini devolvió contenido vacío (finishReason: {reason})',
    'error.bg.customBadResponse': 'Respuesta anómala del proveedor personalizado (no JSON): HTTP {status}. Primeros 200 caracteres: {preview}',
    'error.bg.customEmptyContent': 'El proveedor personalizado devolvió contenido vacío (finish_reason: {reason})',
    'error.bg.customTruncated': 'La salida del proveedor personalizado se truncó (finish_reason: {reason}). Reduzca los párrafos por lote o aumente {param} en el JSON avanzado',
    'error.bg.gtTimeout': 'Google Translate agotó el tiempo ({ms} ms)',
    'instapaper.sending': 'Enviando a Instapaper…',
    'instapaper.summarizing': 'Resumiendo…',
    'instapaper.sent': 'Enviado a Instapaper',
    'instapaper.failedAuth': 'Las credenciales de Instapaper caducaron: vuelve a vincular en ajustes',
    'instapaper.failedNetwork': 'Error al enviar a Instapaper: error de red',
    'instapaper.failed': 'Error al enviar a Instapaper',
    'instapaper.notEnabled': 'Activa y vincula Instapaper en los ajustes primero',
    'shortcut.invalid.needKey': 'Pulsa una combinación que incluya una tecla normal',
    'shortcut.invalid.esc': 'ESC está reservada para cancelar la grabación',
    'shortcut.invalid.needMod': 'La combinación debe incluir ⌥ o ⌃ (para no activarse al escribir)',
    'shortcut.invalid.isDefault': '{key} ya es un atajo predeterminado integrado',
    'shortcut.invalid.safariNeedCtrl': 'En Safari usa una combinación ⌃ Control',
    'floating.featureMenu': 'Menú',
    'floating.ytSubtitleOn': 'Traducir subtítulos',
    'floating.ytSubtitleOff': 'Detener traducción de subtítulos',
  };
  // === ES_DICT_END ===
  // === FR_DICT_START ===
  // FR content 子集（由 tools/build/generate-i18n-content.mjs 從 lib/i18n.js 產出，不可手改）
  const messages_fr = {
    'editbar.hint': 'Cliquez sur un paragraphe en pointillés pour modifier sa traduction',
    'editbar.undo': 'Annuler',
    'editbar.done': 'Terminé',
    'popup.label.modeSingle': 'Remplacer l\'original',
    'popup.label.modeDual': 'Bilingue',
    'common.errorUnknown': 'Erreur inconnue',
    'toast.detectGoogleDocs': 'Google Docs détecté, ouverture de la version lecteur traduisible⋯',
    'toast.offline': 'Hors ligne, traduction impossible. Vérifiez votre connexion réseau et réessayez',
    'toast.noContent': 'Aucun contenu traduisible trouvé',
    'toast.glossaryBuilding': 'Construction du glossaire⋯',
    'toast.translateProgress': '{prefix}Traduction⋯ {done} / {total}',
    'toast.translateProgressGoogle': '{prefix}Traduction Google⋯ {done} / {total}',
    'toast.translateNew': 'Traduction du nouveau contenu⋯ {done} / {total}',
    'toast.translateNewFailed': 'Échec de la traduction du nouveau contenu : {error}',
    'toast.cancelled': 'Traduction annulée',
    'toast.partialFailed': 'Traduction partiellement échouée : {failed} / {total} segments échoués',
    'toast.translateFailed': 'Échec de la traduction : {error}',
    'toast.restored': 'Original restauré',
    'toast.subtitleRestored': 'Sous-titres originaux restaurés',
    'toast.subtitleNotAvailable': 'Cette vidéo n\'a pas de sous-titres CC disponibles',
    'toast.ytSwitchedNativeTarget': 'Bascule automatique vers la piste de sous-titres native dans votre langue cible. Pour le mode bilingue, choisissez manuellement une piste dans la langue source (p. ex. anglais ou japonais) dans le menu CC de YouTube',
    'yt.status.translating': 'Traduction…',
    'yt.status.waitingCaption': 'En attente des données de sous-titres…',
    'toast.modeChanged': 'Mode d\'affichage changé en « {desc} », appuyez sur le raccourci pour retraduire et appliquer',
    'toast.done': 'Traduction terminée ({total} segments)',
    'toast.doneTruncated': 'Traduction terminée ({total} segments ; {truncated} de plus ignorés car la page est trop longue)',
    'toast.donePartial': 'Premiers {total} segments traduits (sur {all})',
    'toast.allCacheHit': 'Tout depuis le cache · rien de facturé cette fois',
    'toast.zhConvertDone': 'Conversion locale de l\'écriture chinoise terminée ({total} segments)',
    'toast.zhConvertFree': 'Conversion par dictionnaire uniquement · aucune traduction IA · gratuit',
    'toast.zhConvertPartial': '{count} segments sont une conversion par dictionnaire, pas une traduction IA (gratuit)',
    'toast.zhConvertProgress': '{prefix}Conversion locale de l\'écriture chinoise⋯ {done} / {total} (sans IA)',
    'toast.zhConvertNew': 'Conversion locale du nouveau contenu⋯ {done} / {total}',
    'toast.zhConvertRescanDone': '{done} nouveaux segments convertis localement (sans IA)',
    'toast.translateRemaining': 'Traduire le reste',
    'toast.googleDone': 'Traduction Google terminée ({total} segments)',
    'toast.googleDoneTruncated': 'Traduction Google terminée ({total} segments ; {truncated} de plus ignorés car la page est trop longue)',
    'toast.googleFreeDetail': '{chars} caractères · gratuit',
    'toast.rescanPartialFailed': 'Traduction du nouveau contenu partiellement échouée : {failed} / {total} segments',
    'toast.rescanDone': '{done} nouveaux segments traduits',
    'toast.updateNoticeLink': 'v{version} disponible — cliquez ici',
    'toast.welcomeNotice.html': '<strong>Mis à jour vers v{version}</strong> — cliquez sur l\'icône de la barre d\'outils pour voir les nouveautés',
    'toast.elapsedSec': '{s} s',
    'toast.elapsedMinSec': '{m} min {s} s',
    'toast.autoTranslateLabel': 'Traduction automatique',
    'toast.close': 'Fermer',
    'toast.dismissToday': 'Ne plus rappeler aujourd\'hui',
    'error.batchTimeout': 'Délai du lot dépassé ({s} s)',
    'error.bg.apiKeyMissing': 'Gemini API Key non configurée. Saisissez-la dans la page d’options',
    'error.bg.baseUrlMissing': 'Base URL du fournisseur personnalisé non configurée',
    'error.bg.testKeyEmpty': 'La clé API est vide. Saisissez-la avant de tester',
    'error.bg.testTimeout': 'Délai de connexion dépassé. Vérifiez l’URL et votre réseau',
    'error.bg.testNonJsonGemini': 'HTTP {status}, mais la réponse n’est pas du JSON valide. Votre réseau (proxy d’entreprise / page de connexion) intercepte peut-être la requête ; essayez un autre réseau',
    'error.bg.testNonJsonCustom': 'HTTP {status}, mais la réponse du fournisseur n’est pas du JSON valide. Vérifiez que la Base URL est bien un endpoint d’API compatible OpenAI',
    'error.bg.customHeadersInvalid': 'Les request headers personnalisés sont invalides ; le test n\'a pas été envoyé : {msg}',
    'error.bg.network': 'Erreur réseau : {msg}',
    'error.bg.timeout': 'Erreur réseau : délai dépassé ({ms} ms)',
    'error.bg.readTimeout': 'Erreur réseau : délai de lecture de la réponse dépassé ({ms} ms)',
    'error.bg.dailyQuota': 'Quota quotidien de l’API Gemini épuisé (limite RPD atteinte). Réessayez demain ou passez à un niveau payant',
    'error.bg.http429': 'HTTP 429 ({dim})',
    'error.bg.badResponse': 'Réponse anormale de l’API Gemini (non JSON) : HTTP {status}. 200 premiers caractères : {preview}',
    'error.bg.blocked': 'Gemini a refusé cette requête (promptFeedback.blockReason: {reason}). Possible faux positif du filtre de sécurité ; essayez des paragraphes plus courts ou ajustez le contenu',
    'error.bg.emptySafety': 'Contenu bloqué par le filtre de sécurité de Gemini. Le texte original peut contenir du contenu sensible ; essayez d’ignorer ce paragraphe',
    'error.bg.emptyRecitation': 'Gemini a détecté une sortie très similaire à des œuvres connues (recitation filter) ; essayez des paragraphes plus courts',
    'error.bg.emptyMaxTokens': 'La sortie a dépassé la limite maxOutputTokens. Augmentez la limite dans la page d’options ou réduisez le nombre de paragraphes par lot',
    'error.bg.emptyOther': 'Gemini a renvoyé un contenu vide (finishReason: OTHER), cause inconnue. Réessayez plus tard',
    'error.bg.emptyContent': 'Gemini a renvoyé un contenu vide (finishReason: {reason})',
    'error.bg.customBadResponse': 'Réponse anormale du fournisseur personnalisé (non JSON) : HTTP {status}. 200 premiers caractères : {preview}',
    'error.bg.customEmptyContent': 'Le fournisseur personnalisé a renvoyé un contenu vide (finish_reason: {reason})',
    'error.bg.customTruncated': 'La sortie du fournisseur personnalisé a été tronquée (finish_reason: {reason}). Réduisez le nombre de paragraphes par lot ou augmentez {param} dans le JSON avancé',
    'error.bg.gtTimeout': 'Google Translate : délai dépassé ({ms} ms)',
    'instapaper.sending': 'Envoi vers Instapaper…',
    'instapaper.summarizing': 'Création du résumé…',
    'instapaper.sent': 'Envoyé vers Instapaper',
    'instapaper.failedAuth': 'Identifiants Instapaper expirés — reliez le compte dans les réglages',
    'instapaper.failedNetwork': 'Échec de l\'envoi vers Instapaper : erreur réseau',
    'instapaper.failed': 'Échec de l\'envoi vers Instapaper',
    'instapaper.notEnabled': 'Activez et liez Instapaper dans les réglages d\'abord',
    'shortcut.invalid.needKey': 'Appuyez sur une combinaison incluant une touche normale',
    'shortcut.invalid.esc': 'ESC est réservée à l\'annulation de l\'enregistrement',
    'shortcut.invalid.needMod': 'La combinaison doit inclure ⌥ ou ⌃ (pour éviter de la déclencher en tapant)',
    'shortcut.invalid.isDefault': '{key} est déjà un raccourci par défaut intégré',
    'shortcut.invalid.safariNeedCtrl': 'Sur Safari, utilisez une combinaison ⌃ Control',
    'floating.featureMenu': 'Menu',
    'floating.ytSubtitleOn': 'Traduire les sous-titres',
    'floating.ytSubtitleOff': 'Arrêter la traduction des sous-titres',
  };
  // === FR_DICT_END ===
  // === DE_DICT_START ===
  // DE content 子集（由 tools/build/generate-i18n-content.mjs 從 lib/i18n.js 產出，不可手改）
  const messages_de = {
    'editbar.hint': 'Klicken Sie auf einen gestrichelt umrandeten Absatz, um die Übersetzung zu bearbeiten',
    'editbar.undo': 'Rückgängig',
    'editbar.done': 'Fertig',
    'popup.label.modeSingle': 'Original ersetzen',
    'popup.label.modeDual': 'Zweisprachig',
    'common.errorUnknown': 'Unbekannter Fehler',
    'toast.detectGoogleDocs': 'Google Docs erkannt, übersetzbare Reader-Version wird geöffnet⋯',
    'toast.offline': 'Derzeit offline, Übersetzung nicht möglich. Bitte Netzwerkverbindung prüfen und erneut versuchen',
    'toast.noContent': 'Kein übersetzbarer Inhalt gefunden',
    'toast.glossaryBuilding': 'Glossar wird erstellt⋯',
    'toast.translateProgress': '{prefix}Übersetze⋯ {done} / {total}',
    'toast.translateProgressGoogle': '{prefix}Google-Übersetzung läuft⋯ {done} / {total}',
    'toast.translateNew': 'Neue Inhalte werden übersetzt⋯ {done} / {total}',
    'toast.translateNewFailed': 'Übersetzung neuer Inhalte fehlgeschlagen: {error}',
    'toast.cancelled': 'Übersetzung abgebrochen',
    'toast.partialFailed': 'Teilweise fehlgeschlagen: {failed} / {total} Segmente fehlgeschlagen',
    'toast.translateFailed': 'Übersetzung fehlgeschlagen: {error}',
    'toast.restored': 'Original wiederhergestellt',
    'toast.subtitleRestored': 'Original-Untertitel wiederhergestellt',
    'toast.subtitleNotAvailable': 'Für dieses Video sind keine CC-Untertitel verfügbar',
    'toast.ytSwitchedNativeTarget': 'Automatisch zur nativen Untertitelspur in Ihrer Zielsprache gewechselt. Für den zweisprachigen Modus wählen Sie im YouTube-CC-Menü manuell eine Spur in der Ausgangssprache (z. B. Englisch oder Japanisch)',
    'yt.status.translating': 'Übersetzen…',
    'yt.status.waitingCaption': 'Warten auf Untertiteldaten…',
    'toast.modeChanged': 'Anzeigemodus geändert zu „{desc}", drücke das Tastenkürzel zum erneuten Übersetzen',
    'toast.done': 'Übersetzung abgeschlossen ({total} Segmente)',
    'toast.doneTruncated': 'Übersetzung abgeschlossen ({total} Segmente; {truncated} weitere übersprungen, da die Seite zu lang ist)',
    'toast.donePartial': 'Erste {total} Segmente übersetzt (von {all})',
    'toast.allCacheHit': 'Alles aus dem Cache · diesmal nichts berechnet',
    'toast.zhConvertDone': 'Lokale Umwandlung der chinesischen Schrift abgeschlossen ({total} Segmente)',
    'toast.zhConvertFree': 'Nur Wörterbuch-Umwandlung · keine KI-Übersetzung ausgelöst · kostenlos',
    'toast.zhConvertPartial': '{count} Segmente waren Wörterbuch-Umwandlung, keine KI-Übersetzung (kostenlos)',
    'toast.zhConvertProgress': '{prefix}Chinesische Schrift wird lokal umgewandelt⋯ {done} / {total} (ohne KI)',
    'toast.zhConvertNew': 'Neue Inhalte werden lokal umgewandelt⋯ {done} / {total}',
    'toast.zhConvertRescanDone': '{done} neue Segmente lokal umgewandelt (ohne KI)',
    'toast.translateRemaining': 'Rest übersetzen',
    'toast.googleDone': 'Google-Übersetzung abgeschlossen ({total} Segmente)',
    'toast.googleDoneTruncated': 'Google-Übersetzung abgeschlossen ({total} Segmente; {truncated} weitere übersprungen, da die Seite zu lang ist)',
    'toast.googleFreeDetail': '{chars} Zeichen · kostenlos',
    'toast.rescanPartialFailed': 'Übersetzung neuer Inhalte teilweise fehlgeschlagen: {failed} / {total} Segmente',
    'toast.rescanDone': '{done} neue Segmente übersetzt',
    'toast.updateNoticeLink': 'v{version} verfügbar — hier klicken',
    'toast.welcomeNotice.html': '<strong>Auf v{version} aktualisiert</strong> — klicke auf das Toolbar-Symbol für die Neuerungen',
    'toast.elapsedSec': '{s} s',
    'toast.elapsedMinSec': '{m} min {s} s',
    'toast.autoTranslateLabel': 'Automatische Übersetzung',
    'toast.close': 'Schließen',
    'toast.dismissToday': 'Heute nicht mehr erinnern',
    'error.batchTimeout': 'Batch-Zeitüberschreitung ({s} s)',
    'error.bg.apiKeyMissing': 'Gemini API Key nicht gesetzt. Bitte auf der Einstellungsseite eintragen',
    'error.bg.baseUrlMissing': 'Base URL des benutzerdefinierten Providers nicht gesetzt',
    'error.bg.testKeyEmpty': 'API-Key ist leer. Bitte zuerst eintragen, dann testen',
    'error.bg.testTimeout': 'Zeitüberschreitung der Verbindung. Bitte URL und Netzwerk prüfen',
    'error.bg.testNonJsonGemini': 'HTTP {status}, aber die Antwort ist kein gültiges JSON. Möglicherweise fängt das Netzwerk (Firmen-Proxy / Login-Seite) die Anfrage ab; bitte ein anderes Netzwerk versuchen',
    'error.bg.testNonJsonCustom': 'HTTP {status}, aber die Provider-Antwort ist kein gültiges JSON. Bitte prüfen, ob die Base URL ein korrekter OpenAI-kompatibler API-Endpoint ist',
    'error.bg.customHeadersInvalid': 'Die benutzerdefinierten Request-Header sind ungültig; der Test wurde nicht gesendet: {msg}',
    'error.bg.network': 'Netzwerkfehler: {msg}',
    'error.bg.timeout': 'Netzwerkfehler: Zeitüberschreitung ({ms} ms)',
    'error.bg.readTimeout': 'Netzwerkfehler: Zeitüberschreitung beim Lesen der Antwort ({ms} ms)',
    'error.bg.dailyQuota': 'Tägliches Gemini-API-Kontingent aufgebraucht (RPD-Limit erreicht). Bitte morgen erneut versuchen oder auf eine Bezahlstufe upgraden',
    'error.bg.http429': 'HTTP 429 ({dim})',
    'error.bg.badResponse': 'Unerwartete Gemini-API-Antwort (kein JSON): HTTP {status}. Erste 200 Zeichen: {preview}',
    'error.bg.blocked': 'Gemini hat diese Anfrage abgelehnt (promptFeedback.blockReason: {reason}). Möglicherweise ein Fehlalarm des Sicherheitsfilters – kürzere Absätze versuchen oder Inhalt anpassen',
    'error.bg.emptySafety': 'Inhalt vom Gemini-Sicherheitsfilter blockiert. Der Originaltext enthält möglicherweise sensible Inhalte – diesen Absatz überspringen',
    'error.bg.emptyRecitation': 'Gemini hat eine stark mit bekannten Werken übereinstimmende Ausgabe erkannt (recitation filter) – kürzere Absätze versuchen',
    'error.bg.emptyMaxTokens': 'Ausgabe überschreitet das maxOutputTokens-Limit. Limit auf der Einstellungsseite erhöhen oder Absätze pro Batch reduzieren',
    'error.bg.emptyOther': 'Gemini hat leeren Inhalt zurückgegeben (finishReason: OTHER), Ursache unbekannt. Bitte später erneut versuchen',
    'error.bg.emptyContent': 'Gemini hat leeren Inhalt zurückgegeben (finishReason: {reason})',
    'error.bg.customBadResponse': 'Unerwartete Antwort des benutzerdefinierten Providers (kein JSON): HTTP {status}. Erste 200 Zeichen: {preview}',
    'error.bg.customEmptyContent': 'Benutzerdefinierter Provider hat leeren Inhalt zurückgegeben (finish_reason: {reason})',
    'error.bg.customTruncated': 'Die Ausgabe des benutzerdefinierten Providers wurde abgeschnitten (finish_reason: {reason}). Reduzieren Sie die Absätze pro Batch oder erhöhen Sie {param} im erweiterten JSON',
    'error.bg.gtTimeout': 'Google Translate: Zeitüberschreitung ({ms} ms)',
    'instapaper.sending': 'Sende an Instapaper…',
    'instapaper.summarizing': 'Zusammenfassung wird erstellt…',
    'instapaper.sent': 'An Instapaper gesendet',
    'instapaper.failedAuth': 'Instapaper-Anmeldedaten abgelaufen — in den Einstellungen neu verknüpfen',
    'instapaper.failedNetwork': 'Senden an Instapaper fehlgeschlagen: Netzwerkfehler',
    'instapaper.failed': 'Senden an Instapaper fehlgeschlagen',
    'instapaper.notEnabled': 'Aktiviere und verknüpfe Instapaper zuerst in den Einstellungen',
    'shortcut.invalid.needKey': 'Drücke eine Kombination mit einer normalen Taste',
    'shortcut.invalid.esc': 'ESC ist zum Abbrechen der Aufnahme reserviert',
    'shortcut.invalid.needMod': 'Die Kombination muss ⌥ oder ⌃ enthalten (um Auslösen beim Tippen zu vermeiden)',
    'shortcut.invalid.isDefault': '{key} ist bereits ein integriertes Standard-Tastenkürzel',
    'shortcut.invalid.safariNeedCtrl': 'Auf Safari eine ⌃ Control-Kombination verwenden',
    'floating.featureMenu': 'Menü',
    'floating.ytSubtitleOn': 'Untertitel übersetzen',
    'floating.ytSubtitleOff': 'Untertitelübersetzung stoppen',
  };
  // === DE_DICT_END ===

  const TABLES = {
    'zh-TW': messages_zhTW,
    'zh-CN': messages_zhCN,
    en: messages_en,
    ja: messages_ja,
    ko: messages_ko,
    es: messages_es,
    fr: messages_fr,
    de: messages_de,
  };

  const SUPPORTED_UI_LANGS = ['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'es', 'fr', 'de'];
  const FALLBACK_LANG = 'en';

  // P3 (v1.8.62):8 語 UI dict 全到位。接受兩種輸入型態:
  //   - uiLanguage 偏好值('auto' / 8 語其一 / undefined)— 主路徑;'auto' 走 navigator.language
  //     推導 8 語其一(zh-TW/HK/Hant → zh-TW;其他 zh → zh-CN;ja/ko/es/fr/de → 對應;else → en)
  //   - 任一字串(target 8 語其一)— 舊路徑相容(content scripts 仍可能傳 STATE.targetLanguage)。
  //     若值在 SUPPORTED_UI_LANGS 內直接 return,否則 fallback en。
  // 兩種路徑統一入口:'auto' 是新增的 sentinel,其他輸入維持舊行為。
  // navigator.language → 語言推導規則：鏡像 lib/storage.js NAV_LANG_RULES（content script 不能
  // import ES module）。改這裡必同步那邊，test/unit/mirror-drift.spec.js 鎖兩份逐條相同。
  // zh-MO 2026-09-12 起與 zh-HK 同落 zh-TW（澳門繁體；原本三份推導都落 zh-CN）。
  const NAV_LANG_RULES = [
    ['zh-tw', 'zh-TW'], ['zh-hant', 'zh-TW'], ['zh-hk', 'zh-TW'], ['zh-mo', 'zh-TW'],
    ['zh', 'zh-CN'],
    ['ja', 'ja'], ['ko', 'ko'], ['es', 'es'], ['fr', 'fr'], ['de', 'de'],
  ];
  function langFromNavigator(navLang) {
    const nav = String(navLang || 'en').toLowerCase();
    for (const [prefix, lang] of NAV_LANG_RULES) {
      if (nav.startsWith(prefix)) return lang;
    }
    return FALLBACK_LANG;
  }

  function getUiLanguage(input) {
    if (input === 'auto' || input == null) {
      return langFromNavigator((typeof navigator !== 'undefined' && navigator.language) || 'en');
    }
    if (SUPPORTED_UI_LANGS.includes(input)) return input;
    return FALLBACK_LANG;
  }

  function _interp(str, params) {
    if (!params || typeof str !== 'string') return str;
    return str.replace(/\{(\w+)\}/g, (m, k) => {
      if (Object.prototype.hasOwnProperty.call(params, k)) return String(params[k]);
      return m;
    });
  }

  function t(key, params, target) {
    const lang = getUiLanguage(target || _readCurrentTarget());
    const tables = [TABLES[lang], TABLES[FALLBACK_LANG], TABLES['zh-TW']];
    for (const tbl of tables) {
      if (tbl && Object.prototype.hasOwnProperty.call(tbl, key)) {
        return _interp(tbl[key], params);
      }
    }
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[shinkansen i18n] missing key:', key, '(lang:', lang + ')');
    }
    return key;
  }

  // P2 (v1.8.60):content scripts 場景透過 STATE.uiLanguage(優先)/ STATE.targetLanguage
  // (舊行為相容)決定 dict。popup / options 直接傳 lang 參數,不走此 fallback。
  function _readCurrentTarget() {
    try {
      if (global.__SK && global.__SK.STATE) {
        if (global.__SK.STATE.uiLanguage) return global.__SK.STATE.uiLanguage;
        if (global.__SK.STATE.targetLanguage) return global.__SK.STATE.targetLanguage;
      }
    } catch (_) { /* 略 */ }
    return 'zh-TW';
  }

  // bgErrorMessage：背景端錯誤的本地化（error code 協定，lib/bg-error.js；SPEC-PRIVATE §27）。
  // service worker 載不了本檔也不知 uiLanguage，所以背景把錯誤帶結構化 errorCode（+ errorParams）
  // 過協定（response / STREAMING_ERROR payload），由 UI 端在這裡查 'error.bg.' + code 組訊息。
  // fallback 順序（向下相容，別讓未知錯誤變空白）：
  //   1. 沒帶 errorCode（API 原文 ground truth 直傳 / 內部錯誤 / 舊版背景）→ 原字串原樣顯示
  //   2. 有 code 但 dict 缺 key（版本 drift）→ 原字串原樣顯示
  // 接受 sendResponse 物件與 STREAMING_ERROR payload 兩種來源（欄位同名）。
  function bgErrorMessage(payload, target) {
    const raw = (payload && payload.error != null) ? String(payload.error) : '';
    const code = payload && payload.errorCode;
    if (!code) return raw;
    const key = 'error.bg.' + code;
    const lang = getUiLanguage(target || _readCurrentTarget());
    const tables = [TABLES[lang], TABLES[FALLBACK_LANG], TABLES['zh-TW']];
    for (const tbl of tables) {
      if (tbl && Object.prototype.hasOwnProperty.call(tbl, key)) {
        return _interp(tbl[key], (payload && payload.errorParams) || undefined);
      }
    }
    return raw;
  }

  // applyI18n:掃 rootNode 內 [data-i18n] / [data-i18n-html] / [data-i18n-attr-*] 元素並注入翻譯
  // - data-i18n="key":textContent
  // - data-i18n-html="key":innerHTML(只用於信任的 dict 內含 HTML 字串)
  // - data-i18n-attr-<attrName>="key":元素的 <attrName> 屬性,例 data-i18n-attr-placeholder
  // - data-i18n-params="json":params 物件 JSON
  function applyI18n(rootNode, target) {
    const root = rootNode || (typeof document !== 'undefined' ? document : null);
    if (!root || !root.querySelectorAll) return;
    const lang = getUiLanguage(target || _readCurrentTarget());

    const pickParams = (el) => {
      const raw = el.getAttribute('data-i18n-params');
      if (!raw) return undefined;
      try { return JSON.parse(raw); } catch (_) { return undefined; }
    };

    root.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (!key) return;
      el.textContent = t(key, pickParams(el), lang);
    });
    root.querySelectorAll('[data-i18n-html]').forEach((el) => {
      const key = el.getAttribute('data-i18n-html');
      if (!key) return;
      el.innerHTML = t(key, pickParams(el), lang);
    });
    // attribute 注入(placeholder / title / aria-label)
    // v1.10.39(code review 2026-06-09 L4):原本 querySelectorAll('*') 全節點掃,大頁面
    // (options.html)每次 UI 語系切換 / load() 都掃一遍所有 element。改用精準 selector
    // 只取真的帶 data-i18n-attr-* 的 element。
    // ⚠ 新增 data-i18n-attr-<X> 屬性時,必須在下方 selector union 加 [data-i18n-attr-X],
    //   否則只帶該新屬性的 element 不會被掃到(內層 loop 仍泛用處理已匹配 element 上的任何
    //   data-i18n-attr-*,所以只差「element 完全沒有這三個已知屬性」的情況)。
    if (root.querySelectorAll) {
      const all = root.querySelectorAll(
        '[data-i18n-attr-placeholder],[data-i18n-attr-title],[data-i18n-attr-aria-label]'
      );
      all.forEach((el) => {
        const attrs = el.attributes;
        if (!attrs) return;
        for (let i = 0; i < attrs.length; i++) {
          const a = attrs[i];
          if (!a.name.startsWith('data-i18n-attr-')) continue;
          const targetAttr = a.name.slice('data-i18n-attr-'.length);
          const key = a.value;
          if (!key) continue;
          el.setAttribute(targetAttr, t(key, pickParams(el), lang));
        }
      });
    }
  }

  // P2 (v1.8.60):監聽 settings.uiLanguage 變動(新)+ targetLanguage 變動(舊行為相容)。
  // 真正觸發 UI dict 切換的是 uiLanguage;若 storage 只動 targetLanguage(non-UI sync change),
  // UI 不該重 render。但同時還要支援舊 P2 release 沒寫入 uiLanguage 的場景(callback 預設
  // 行為:任何 sync change 都檢查 effective ui dict 是否變化)。
  // callback(newUiLanguageDict, newRawValue) 觸發時保留供呼叫方 reapplyI18n
  function subscribeUiLanguageChange(callback) {
    if (typeof callback !== 'function') return () => {};
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) {
      return () => {};
    }
    const handler = (changes, area) => {
      if (area !== 'sync') return;
      // 只有 uiLanguage 真的變動才觸發 UI reapply。
      if (!changes.uiLanguage) return;
      const newPref = changes.uiLanguage.newValue;
      callback(getUiLanguage(newPref), newPref);
    };
    chrome.storage.onChanged.addListener(handler);
    return () => {
      try { chrome.storage.onChanged.removeListener(handler); } catch (_) { /* 略 */ }
    };
  }

  // iOS App Store 上架提示連結:依 UI 語系決定 storefront。桌面瀏覽器開無 country
  // 前綴的 apps.apple.com 連結會落在 us store,與使用者語系不符(2026-08-20 Jimmy
  // 回報)。單一資料源:options 頁首 pill 與 popup banner 共用本函式。
  function iosAppStoreUrl(uiPref) {
    const region = ({
      'zh-TW': 'tw', 'zh-CN': 'cn', en: 'us', ja: 'jp',
      ko: 'kr', es: 'es', fr: 'fr', de: 'de',
    })[getUiLanguage(uiPref || 'auto')] || 'us';
    return 'https://apps.apple.com/' + region + '/app/id6776958298';
  }

  const api = {
    t,
    bgErrorMessage,
    applyI18n,
    getUiLanguage,
    langFromNavigator, // 給 mirror-drift spec 驗與 lib/storage.js 同行為
    subscribeUiLanguageChange,
    iosAppStoreUrl,
    // 給 spec 用的內部 helpers
    _tables: TABLES,
    _supported: SUPPORTED_UI_LANGS,
  };

  // 雙通道 export:content scripts 走 window.__SK,popup / options 也走 window.__SK
  if (!global.__SK) global.__SK = {};
  global.__SK.i18n = api;
  // 短捷:content scripts 慣用 SK.t,直接掛到 SK 命名空間
  if (typeof global.__SK.t !== 'function') global.__SK.t = t;
})(typeof window !== 'undefined' ? window : globalThis);
