// epub-session-db.js — EPUB 翻譯工作階段存檔（v2.0.11）
//
// 需求（2026-07-10 Jimmy）：翻譯到一半離開頁面，下次載入同一檔案可以繼續翻，
// 且**不受「清除翻譯快取」影響**——工作進度（譯文 / 手動編輯 / 術語表 / 本書
// 禁用詞）是使用者的工作成果，跟機器翻譯快取（tc_ / gloss_，可隨時重建）是
// 不同性質的資料。
//
// 存放位置：translate-doc 頁自己的 IndexedDB（chrome-extension:// origin）。
// 不放 chrome.storage.local——整本書譯文可達數 MB（storage.local 有 10MB 總額
// 上限且被翻譯快取共用），且 clearDocTranslationCache 掃的是 storage.local。
//
// key = 書指紋（全書 plainText 的 sha1，同 bookgloss_ 的指紋）。
// value shape：
//   { title, updatedAt,
//     glossary: [...] | null,        // 全書術語表（含選項 flag）
//     forbidden: [...] | null,       // 本書獨立禁用詞
//     extraPrompt: string,           // 本文件額外翻譯指令（2026-07-27）
//     blocks: { [blockId]: { raw, plain, edited, status } } }  // 只存 done block

// LLM 協定殘片修復 / 句尾句號對齊 / strip（v2.0.53 hydrate 自癒用；
// translate.js 不 import 本檔，無循環）
import { repairDocLlmArtifacts, alignTrailingPeriodWithSource, stripPlaceholderTokens } from './translate.js';

const DB_NAME = 'shinkansen-epub-sessions';
const STORE = 'sessions';
// v2(review G11):blocks 從 sessions 整包記錄拆出,獨立 store 以 [bookHash, blockId]
// 為 key 逐塊寫入——大書每次 debounced 存檔不再整本重寫(單次數 MB)。sessions
// store 只放 meta(title / glossary / forbidden / extraPrompt / costUSD / scanIgnored)。
// v1 舊記錄(meta 內嵌 blocks)load 時仍讀得到;第一次 v2 存檔會全量寫進 blocks
// store 並以不帶 blocks 的 meta 覆寫,即完成搬遷
const BLOCKS_STORE = 'session-blocks';
const VERSION = 2;

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(BLOCKS_STORE)) db.createObjectStore(BLOCKS_STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      // 連線失效自我重建（同 lib/usage-db.js 的教訓：瀏覽器可能主動關閉閒置連線）
      db.onclose = () => { _dbPromise = null; };
      db.onversionchange = () => { db.close(); _dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { _dbPromise = null; reject(req.error); };
  });
  return _dbPromise;
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function blocksRange(bookHash) {
  // IDB key 排序:[bookHash] < [bookHash, 任何字串] < [bookHash, []](array > string),
  // 此界界定「該書全部 per-block 記錄」,不依賴 blockId 字元範圍
  return IDBKeyRange.bound([bookHash], [bookHash, []]);
}

/** @returns {Promise<object|null>} 沒有存檔回 null；任何錯誤靜默回 null（存檔是加值功能，不可擋主流程） */
export async function loadEpubSession(bookHash) {
  if (!bookHash) return null;
  try {
    const db = await openDb();
    const tx = db.transaction([STORE, BLOCKS_STORE], 'readonly');
    const bstore = tx.objectStore(BLOCKS_STORE);
    const range = blocksRange(bookHash);
    const [meta, keys, vals] = await Promise.all([
      reqAsPromise(tx.objectStore(STORE).get(bookHash)),
      reqAsPromise(bstore.getAllKeys(range)),
      reqAsPromise(bstore.getAll(range)),
    ]);
    if (!meta && keys.length === 0) return null;
    // v1 整包記錄的內嵌 blocks 為底,v2 per-block 記錄疊上(較新)
    const blocks = { ...((meta && meta.blocks) || {}) };
    for (let i = 0; i < keys.length; i++) blocks[keys[i][1]] = vals[i];
    return { ...(meta || {}), blocks };
  } catch (err) {
    console.warn('[Shinkansen] epub session load failed', err && err.message);
    return null;
  }
}

/**
 * v2(review G11)增量存檔:meta(小)每次全寫;blocks(大)只寫呼叫端標記有變的。
 * @param meta 不含 blocks 的 session meta(帶了也會被剝掉——meta 記錄永遠不再內嵌整包)
 * @param changedBlocks { [blockId]: { raw, plain, edited } } 本次要落地的 block
 * @param removedBlockIds 已離開 done 集合、要從存檔移除的 blockId
 */
export async function saveEpubSession(bookHash, meta, { changedBlocks = {}, removedBlockIds = [] } = {}) {
  if (!bookHash || !meta) return false;
  try {
    const db = await openDb();
    const tx = db.transaction([STORE, BLOCKS_STORE], 'readwrite');
    const { blocks: _legacyEmbedded, ...metaOnly } = meta;
    tx.objectStore(STORE).put({ ...metaOnly, updatedAt: Date.now() }, bookHash);
    const bstore = tx.objectStore(BLOCKS_STORE);
    for (const [blockId, rec] of Object.entries(changedBlocks || {})) {
      bstore.put(rec, [bookHash, blockId]);
    }
    for (const blockId of removedBlockIds || []) {
      bstore.delete([bookHash, blockId]);
    }
    await txDone(tx);
    return true;
  } catch (err) {
    console.warn('[Shinkansen] epub session save failed', err && err.message);
    return false;
  }
}

export async function deleteEpubSession(bookHash) {
  if (!bookHash) return false;
  try {
    const db = await openDb();
    const tx = db.transaction([STORE, BLOCKS_STORE], 'readwrite');
    tx.objectStore(STORE).delete(bookHash);
    tx.objectStore(BLOCKS_STORE).delete(blocksRange(bookHash));
    await txDone(tx);
    return true;
  } catch (err) {
    console.warn('[Shinkansen] epub session delete failed', err && err.message);
    return false;
  }
}

/** 從 epubDoc 收集 session 的 blocks payload（只存 done block，控制體積） */
export function collectSessionBlocks(epubDoc) {
  const blocks = {};
  for (const ch of epubDoc.chapters) {
    for (const b of ch.blocks) {
      if (b.translationStatus !== 'done') continue;
      blocks[b.blockId] = {
        raw: b.translationRaw ?? null,
        plain: b.translation ?? null,
        edited: b.editedHtml ?? null,
      };
    }
  }
  return blocks;
}

// v2.0.52:匯出檔的失敗診斷欄。session 匯出原本只存 done blocks——失敗 block
// 連狀態 / 錯誤訊息都不進檔,拿到 session 檔只能反推「哪個範圍缺席」,無法診斷。
// 這裡收集 failed block 的錯誤訊息 + 原文,以獨立 `failures` 欄進匯出檔
//(不混進 blocks map——hydrateSessionBlocks 把 blocks 的存在視為 done,混放會把
// 失敗段當成譯文灌回)。診斷用途 only:匯入端不 hydrate 此欄(失敗是暫態,
// 重翻即重置),舊版匯入忽略未知欄位,向下相容。
export function collectSessionFailures(epubDoc) {
  const failures = [];
  for (const ch of epubDoc.chapters) {
    for (const b of ch.blocks) {
      if (b.translationStatus !== 'failed') continue;
      failures.push({
        blockId: b.blockId,
        chapterIndex: ch.index,
        chapterTitle: ch.title || '',
        error: b.translationError || '',
        source: b.plainText || '',
      });
    }
  }
  return failures;
}

// editedHtml → 純文字（掃描 / 比對用的 b.translation）。頁面環境走 DOM
// textContent（entity 正確解碼）;node 單元測試環境無 document,fallback 去標籤
// regex + 常見 entity（測試涵蓋 fallback,真實頁面永遠走 DOM 分支）
function editedHtmlToText(html, fallbackPlain) {
  try {
    if (typeof document !== 'undefined' && document.createElement) {
      const div = document.createElement('div');
      div.innerHTML = html;
      return div.textContent;
    }
  } catch (_) { /* fall through */ }
  if (typeof html === 'string') {
    return html.replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  return fallbackPlain ?? null;
}

/** 把 session 的 blocks 灌回 epubDoc（blockId 由內容指紋派生，同書必對齊） */
export function hydrateSessionBlocks(epubDoc, blocks) {
  if (!blocks) return 0;
  let restored = 0;
  for (const ch of epubDoc.chapters) {
    for (const b of ch.blocks) {
      const saved = blocks[b.blockId];
      if (!saved) continue;
      if (saved.raw == null && saved.plain == null && saved.edited == null) continue;
      // LLM 協定殘片自癒(v2.0.53):修好之前存的 session 可能帶壞標記——raw 修
      // ⟦/2» → ⟦/2⟧ + 段尾分隔符殘片,再對齊句尾句號(b.plainText = 該 block
      // 原文,parseEpub 已灌好);plain 是壞標記被舊版 strip 削過的殘骸
      //(「/2»」,⟦ 已丟失無法錨定修復),從修好的 raw 重新 strip 一次才乾淨。
      // 正常 session 走這條是 no-op(沒有壞 pattern 時 repair / strip 結果不變)
      const raw = typeof saved.raw === 'string'
        ? alignTrailingPeriodWithSource(b.plainText, repairDocLlmArtifacts(saved.raw))
        : (saved.raw ?? null);
      b.translationRaw = raw;
      b.editedHtml = saved.edited ?? null;
      // 手動編輯優先(渲染 / 譯本 / 掃描都以 editedHtml 為準):translation 必須
      // 從 edited 導出,不可從 raw 重算——否則已修正過的段落被 raw 舊值蓋回,
      // 掃描看到舊譯文再列違規、搜尋替換卻搜 edited DOM 找不到舊詞(2026-07-11
      // Jimmy 回報「京浜急行搜尋不到」,v2.0.53 自癒第一版引入的回歸)。
      // 從 edited 重新導出也順便修復已被前版蓋壞的 session plain(自癒)
      if (typeof b.editedHtml === 'string' && b.editedHtml.length > 0) {
        b.translation = editedHtmlToText(b.editedHtml, saved.plain);
      } else {
        b.translation = (typeof raw === 'string' && raw.length > 0)
          ? stripPlaceholderTokens(raw)
          : (saved.plain ?? null);
      }
      b.translationStatus = 'done';
      restored++;
    }
  }
  return restored;
}
