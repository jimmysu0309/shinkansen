// block-output.js — block 譯文輸出的優先鏈單一資料源（2026-09-12 code review 批次 6 §5.1）
//
// 一個已翻譯 block 有三種可能的譯文形態，輸出時固定優先序：
//   1. editedHtml      使用者在預覽頁手動編輯過（含掃描替換 / 空格自動校正的存回），最終版
//   2. translationRaw  機器譯文含 ⟦N⟧ 佔位符，經 SK.deserializeWithPlaceholders 還原 inline 結構
//   3. translation     純文字 fallback（已去除標記）
// override 來自 computeAnnotationDedupe（「對照只出現一次」後處理版本）：缺的欄位 fallback 回
// block 本體；三層都要吃 override——反序列化失敗走 fallback 時不可漏掉後處理。
//
// 原本四個消費端各抄一份鏈：epub-writer resolveBlockContent（xhtmlDoc 寫回）、docx-engine
// fragmentForBlock（OOXML run）、doc-file-engine blockOutputText（txt / md / 字幕純文字）、
// index.js renderBlockContent（預覽 / 掃描編輯 DOM），且 editedHtml → 純文字有兩個實作
//（epub-session-db editedHtmlToText 對 <br> 不換行 vs doc-file-engine editedHtmlToPlain <br> → \n）
// 已 drift。本檔收斂成：
//   pickBlockOutput        鏈的選擇（回 { source, value }），純函式、無 DOM
//   editedHtmlToPlain      editedHtml → 純文字（<br> → \n），唯一實作
//   sanitizeEditedHtml     editedHtml → 頁面 DocumentFragment（剝 script / style / template 與 on* 屬性）
//   resolveBlockFragment   鏈 + DOM 化（edited → raw 反序列化 → 純文字），消費端只決定怎麼掛
// 不 import 任何模組；瀏覽器環境用 document，node 測試環境 editedHtmlToPlain 走 regex fallback。

/**
 * 依優先鏈挑出要輸出的譯文形態。
 * @param {object} b block
 * @param {object|null} override computeAnnotationDedupe 的 override（可 null）
 * @param {object} [opts]
 * @param {boolean} [opts.rawNeedsSlots=false] raw 分支要求 Array.isArray(b.slots)（DOM 反序列化路徑）
 * @returns {{ source: 'edited'|'raw'|'plain', value: string } | null}
 */
export function pickBlockOutput(b, override, { rawNeedsSlots = false } = {}) {
  if (!b) return null;
  const edited = override?.editedHtml ?? b.editedHtml;
  if (typeof edited === 'string' && edited.length > 0) return { source: 'edited', value: edited };
  const raw = override?.translationRaw ?? b.translationRaw;
  if (typeof raw === 'string' && raw.length > 0 && (!rawNeedsSlots || Array.isArray(b.slots))) {
    return { source: 'raw', value: raw };
  }
  const plain = override?.translation ?? b.translation;
  if (typeof plain === 'string' && plain.length > 0) return { source: 'plain', value: plain };
  return null;
}

/**
 * editedHtml → 純文字。<br> 與 block 元素邊界視為換行（字幕 block 多行譯文以 <br> 渲染，
 * textContent 會把行併掉）。真實頁面走 DOM（entity 正確解碼），node 測試環境 fallback regex。
 */
export function editedHtmlToPlain(html) {
  try {
    if (typeof document !== 'undefined' && document.createElement) {
      const div = document.createElement('div');
      div.innerHTML = String(html).replace(/<br\s*\/?>/gi, '\n');
      return div.textContent;
    }
  } catch (_) { /* fall through */ }
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/**
 * 使用者在預覽頁 contenteditable 編輯過的 HTML → 消毒後 parse 成頁面 DocumentFragment。
 * 消毒：剝 script / style / template 元素與 on* 事件屬性（貼上內容可能夾帶）。
 */
export function sanitizeEditedHtml(html) {
  const container = document.createElement('div');
  container.innerHTML = html;
  for (const bad of container.querySelectorAll('script, style, template')) bad.remove();
  for (const el of container.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
  }
  const frag = document.createDocumentFragment();
  while (container.firstChild) frag.appendChild(container.firstChild);
  return frag;
}

/**
 * 鏈 + DOM 化：edited → 消毒 fragment；raw → SK.deserializeWithPlaceholders（cloneReuse：frag 不注回
 * 序列化來源，slot 一律 clone 殼重建；接受條件 ok 或「無 slot 但有節點」）；plain → renderPlain
 *（預設純 text node）。raw 反序列化 throw 或不被接受時退到 plain，並把載體型 slot 補在尾端。
 * 回傳的節點屬於頁面 document；寫回 xhtmlDoc 的消費端自行 importNode。
 *
 * @param {object} SK content-serialize 命名空間（deserializeWithPlaceholders）
 * @param {object} b block
 * @param {object|null} override
 * @param {object} [opts]
 * @param {(plain:string) => DocumentFragment} [opts.renderPlain] 純文字分支的自訂渲染（字幕 \n → <br> 等）
 * @returns {{ frag: DocumentFragment, source: 'edited'|'raw'|'plain' } | null}
 */
export function resolveBlockFragment(SK, b, override, { renderPlain } = {}) {
  const edited = override?.editedHtml ?? b?.editedHtml;
  if (typeof edited === 'string' && edited.length > 0) {
    return { frag: sanitizeEditedHtml(edited), source: 'edited' };
  }
  const raw = override?.translationRaw ?? b?.translationRaw;
  if (typeof raw === 'string' && raw.length > 0 && Array.isArray(b?.slots)
      && typeof SK?.deserializeWithPlaceholders === 'function') {
    try {
      const { frag, ok } = SK.deserializeWithPlaceholders(raw, b.slots, { cloneReuse: true });
      if (ok || (b.slots.length === 0 && frag.childNodes.length > 0)) return { frag, source: 'raw' };
    } catch (_) { /* fall through to plain */ }
  }
  const plain = override?.translation ?? b?.translation;
  if (typeof plain === 'string' && plain.length > 0) {
    let frag;
    if (typeof renderPlain === 'function') frag = renderPlain(plain);
    else {
      frag = document.createDocumentFragment();
      frag.appendChild(document.createTextNode(plain));
    }
    // 走到純文字 = 佔位符沒有一個對得上（或根本沒有 raw）：段內的載體型 slot（DOCX 註腳參照 / 圖 /
    // 分頁符、EPUB 行內圖 / id 錨點）不補回就會從輸出檔消失。位置已隨佔位符遺失，補在譯文尾端；
    // 純格式殼不補（文字仍在譯文裡）。與網頁端注入同一支（content-serialize.js）
    if (Array.isArray(b?.slots) && b.slots.length > 0 && typeof SK?.appendUnusedCarrierSlots === 'function') {
      SK.appendUnusedCarrierSlots(frag, b.slots, null, true);
    }
    return { frag, source: 'plain' };
  }
  return null;
}
