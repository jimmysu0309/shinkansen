// font-loader.js — 譯文 PDF 用的 CJK 字型：依目標語言「用到才下載」（2026-09-06）
//
// 安裝包只內建 Noto Sans TC（繁中）。zh-CN / ja / ko 目標語言的 PDF 譯文需要 SC / JP / KR
// 字型（TC 缺簡體專用字與日文字形，譯文會畫成方框），但多數使用者永遠用不到，所以：
//   - 安裝、更新、開設定頁都不下載；只有「翻譯 PDF 且目標語言是 zh-CN / ja / ko」時，在生成
//     譯文 PDF 前抓該語言的 Regular + Bold；網頁翻譯 / EPUB / TXT / 字幕不內嵌字型，不會觸發
//   - 只抓那一種語言；抓過一次存 Cache Storage（extension 自己的 origin），之後離線也能用
//   - 來源是專案自己的 GitHub Pages（回 Access-Control-Allow-Origin: *，extension 頁面不需
//     新增 host permission）；URL 釘死版本目錄，下載後比對 SHA-256，不符就丟掉
//   - 抓不到（離線 / 被擋 / hash 不符）→ 回 null，呼叫端退回內建 TC 並提示使用者
//
// 隱私：這是本擴充功能除了翻譯引擎之外唯一的對外連線，只在上述條件下發生，請求不帶任何
// 文件內容（隱私政策已載明）。
//
// 字型檔本體放在公開 repo 的 docs/fonts/（Google Fonts 靜態 TTF，SIL OFL 1.1）。

export const FONT_CACHE_NAME = 'sk-cjk-fonts-v1';

// 可被 spec 覆寫（page.route 攔 URL、改 sha 驗 fallback 路徑）；production 不動
export const FONT_CONFIG = {
  baseUrl: 'https://jimmysu0309.github.io/shinkansen/fonts/',
  fonts: {
    'zh-CN': {
      regular: { file: 'NotoSansSC-Regular.ttf', bytes: 10540376, sha256: 'a0ecca1c67a4da5a89857703b84a44eba9fce7d7b5941bf4285e8c0a8346cf60' },
      bold: { file: 'NotoSansSC-Bold.ttf', bytes: 10530140, sha256: '2179d44af51b5fc3db254102bd9710fb50e1538754cd33349f1ae1056bf7f3c8' },
    },
    ja: {
      regular: { file: 'NotoSansJP-Regular.ttf', bytes: 5323876, sha256: '0eba77a9f62df60eda7b56719cf57bbfbd8434583f2a137a9b91d4d67cf420c0' },
      bold: { file: 'NotoSansJP-Bold.ttf', bytes: 5319412, sha256: '74823fedeaaa812df51a6a1ab156cdde3183f65dc924d02934238d8e553f28bc' },
    },
    ko: {
      regular: { file: 'NotoSansKR-Regular.ttf', bytes: 6162976, sha256: '65f278fc677a3a0128c733af662c3eb31b910c9bce81e046ccc3c6d3ede879e2' },
      bold: { file: 'NotoSansKR-Bold.ttf', bytes: 6158968, sha256: '45f69f3abd7e355bcd9f754261c5090ab3b7e1b526c6af60a71fe7d999b35073' },
    },
  },
};

// 目標語言 → 需要遠端字型的 key；其他語言（zh-TW / en / es / fr / de…）一律用內建 TC，回 null
export function remoteFontKeyFor(targetLanguage) {
  const lang = String(targetLanguage || '').trim();
  if (!lang) return null;
  if (/^zh[-_]?(cn|hans|sg)$/i.test(lang)) return 'zh-CN';
  if (/^ja/i.test(lang)) return 'ja';
  if (/^ko/i.test(lang)) return 'ko';
  return null;
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function openCache() {
  try { return await caches.open(FONT_CACHE_NAME); } catch { return null; }
}

// 單一字型檔：快取命中 → 直接回；否則下載 → 驗 hash → 寫快取。任何失敗回 null
async function loadOne(spec, { onProgress, fetchImpl, label }) {
  const url = FONT_CONFIG.baseUrl + spec.file;
  const cache = await openCache();
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) {
        const buf = await hit.arrayBuffer();
        if (buf.byteLength > 0) return { buffer: buf, fromCache: true };
      }
    } catch { /* 快取壞掉當沒命中 */ }
  }
  let res;
  try {
    res = await fetchImpl(url, { cache: 'no-store' });
  } catch (err) {
    console.warn('[Shinkansen] 字型下載失敗（網路）：', spec.file, err && err.message);
    return null;
  }
  if (!res || !res.ok) {
    console.warn('[Shinkansen] 字型下載失敗（HTTP）：', spec.file, res && res.status);
    return null;
  }
  // 逐段讀取回報進度（下載 5–10 MB，手機網路十幾秒，要讓使用者看得到在動）
  let buffer;
  try {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        onProgress({ label, received, total: spec.bytes });
      }
      const out = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.byteLength; }
      buffer = out.buffer;
    } else {
      buffer = await res.arrayBuffer();
      onProgress({ label, received: buffer.byteLength, total: spec.bytes });
    }
  } catch (err) {
    console.warn('[Shinkansen] 字型下載中斷：', spec.file, err && err.message);
    return null;
  }
  const hash = await sha256Hex(buffer);
  if (hash !== spec.sha256) {
    console.warn('[Shinkansen] 字型檔 SHA-256 不符，丟棄：', spec.file, hash);
    return null;
  }
  if (cache) {
    try { await cache.put(url, new Response(buffer, { headers: { 'Content-Type': 'font/ttf' } })); }
    catch (err) { console.warn('[Shinkansen] 字型寫入快取失敗（下次會重抓）：', err && err.message); }
  }
  return { buffer, fromCache: false };
}

/**
 * 依目標語言載入遠端字型。回 null = 該語言用內建 TC 即可；回 { regular: null } = 需要遠端字型
 * 但抓不到（呼叫端退回 TC 並提示）。bold 抓不到只回 null（呼叫端用 regular 頂替）。
 *
 * @param {string} targetLanguage
 * @param {{ onProgress?: Function, fetchImpl?: Function }} [opts]
 * @returns {Promise<null | { key: string, regular: ArrayBuffer | null, bold: ArrayBuffer | null, fromCache: boolean }>}
 */
export async function loadRemoteFontForLanguage(targetLanguage, opts = {}) {
  const key = remoteFontKeyFor(targetLanguage);
  if (!key) return null;
  const spec = FONT_CONFIG.fonts[key];
  if (!spec) return null;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
  const reg = await loadOne(spec.regular, { onProgress, fetchImpl, label: 'regular' });
  if (!reg) return { key, regular: null, bold: null, fromCache: false };
  const bold = await loadOne(spec.bold, { onProgress, fetchImpl, label: 'bold' });
  return { key, regular: reg.buffer, bold: bold ? bold.buffer : null, fromCache: reg.fromCache && !!(bold && bold.fromCache) };
}

// 設定頁「清除字型快取」用；也給 spec 每條 case 前清場
export async function clearRemoteFontCache() {
  try { return await caches.delete(FONT_CACHE_NAME); } catch { return false; }
}
