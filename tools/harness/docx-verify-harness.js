// docx-verify-harness.js — docx 語料批次驗證（L3，零 API 成本偽翻譯往返）
//
// 用法：
//   npm run docx-verify                          # 掃整個 corpus（100 檔）
//   CORPUS_DIR=/path node tools/harness/docx-verify-harness.js
//   FILE=/path/to/one.docx node tools/harness/docx-verify-harness.js   # 單檔
//   npm run docx-verify -- --save                # 額外把偽翻譯輸出存檔（供 L4 Word 開啟驗證）
//
// 行為（全程不打 API，在 translate-doc 頁面 context 直驅 docx-engine）：
//   1. parseDocxFile 解析（負面案例驗「正確錯誤碼擋下」：encrypted / track-changes）
//   2. 偽翻譯：每個 block 的 translationRaw = '偽' + epubSerializedText
//      （⟦N⟧ 佔位符原樣 → 走完 deserialize → OOXML 寫回全路徑）
//   3. buildTranslatedDocx 單語 + 雙語各建一次
//   4. 驗證：
//      a. 動過的 part XML well-formed（DOMParser 無 parsererror）
//      b. 單語輸出重新 parseDocxFile：block 數一致、每個 block plainText 帶偽前綴
//      c. 未動 entry 逐位元組不變（抽 [Content_Types].xml 比對）
//   5. 報表：stdout 摘要 + docs/excluded/test docx/<YYYY-MM-DD> output/docx-verify-report.json
//   6. --save：單語 + 雙語輸出另存 <output>/pseudo/<原檔名>-mono.docx / -dual.docx
//      （負面案例 NEG 無輸出自然跳過），供 L4 AppleScript 驅動 Word 開啟轉 PDF 驗收
//
// 驗的層次：100 檔真實多樣性下解析與寫回的穩健性。不驗：視覺（L4 走 Word
// 轉 PDF Read）、真實 LLM 譯文（L4 抽樣真翻）。
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EXT = path.join(ROOT, 'shinkansen');
const CORPUS_DIR = process.env.CORPUS_DIR
  || path.join(ROOT, 'docs/excluded/test docx/corpus');
const SINGLE = process.env.FILE || null;
const SAVE = process.argv.includes('--save');

const today = new Date().toISOString().slice(0, 10);
const OUT_DIR = path.join(ROOT, `docs/excluded/test docx/${today} output`);
fs.mkdirSync(OUT_DIR, { recursive: true });
const PSEUDO_DIR = path.join(OUT_DIR, 'pseudo');
if (SAVE) fs.mkdirSync(PSEUDO_DIR, { recursive: true });

const files = SINGLE
  ? [SINGLE]
  : ['lo-fixtures', 'real-world'].flatMap((sub) => {
    const dir = path.join(CORPUS_DIR, sub);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.docx')).sort()
      .map((f) => path.join(dir, f));
  });
if (files.length === 0) {
  console.error('找不到語料檔（CORPUS_DIR=' + CORPUS_DIR + '）');
  process.exit(1);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-docx-verify-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    '--headless=new',
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
  ],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extensionId = new URL(sw.url()).host;
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extensionId}/translate-doc/index.html`, { waitUntil: 'domcontentloaded' });

const report = [];
let okCount = 0;
let negOk = 0;
let failCount = 0;

for (const file of files) {
  const name = path.basename(file);
  const b64 = fs.readFileSync(file).toString('base64');
  const t0 = Date.now();
  let res;
  try {
    res = await page.evaluate(async ({ b64Str, save }) => {
      const eng = await import('/translate-doc/docx-engine.js');
      const bytes = Uint8Array.from(atob(b64Str), (c) => c.charCodeAt(0));
      const toB64 = (u8) => {
        let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) {
          s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        }
        return btoa(s);
      };
      const file = new File([bytes], 'probe.docx');
      let doc;
      try {
        doc = await eng.parseDocxFile(file, () => {}, {});
      } catch (err) {
        if (err && err.name === 'DocxParseError') {
          return { negative: err.code };
        }
        return { error: 'parse-throw: ' + (err && err.message) };
      }
      const blocks = doc.chapters.flatMap((c) => c.blocks);
      const islands = doc.docxParas.reduce((a, p) => a + p.islands.length, 0);
      // 偽翻譯（⟦N⟧ 原樣保留）
      for (const b of blocks) {
        b.translationRaw = '偽' + b.epubSerializedText;
        b.translation = b.translationRaw;
        b.translationStatus = 'done';
      }
      const checkParts = (bytesOut) => {
        const entries = window.fflate.unzipSync(bytesOut);
        const bad = [];
        for (const [p, u8] of Object.entries(entries)) {
          if (!/\.xml$/.test(p)) continue;
          const xml = window.fflate.strFromU8(u8);
          const parsed = new DOMParser().parseFromString(xml, 'application/xml');
          if (parsed.getElementsByTagName('parsererror').length > 0) bad.push(p);
        }
        return { entries, bad };
      };
      let mono;
      let dual;
      try {
        mono = eng.buildTranslatedDocx(doc, 'zh-TW', { bilingual: false });
        dual = eng.buildTranslatedDocx(doc, 'zh-TW', { bilingual: true });
      } catch (err) {
        return { error: 'build-throw: ' + (err && err.message) };
      }
      const monoCheck = checkParts(mono.bytes);
      const dualCheck = checkParts(dual.bytes);
      // 未動 entry 逐位元組比對（[Content_Types].xml 永不在編輯範圍）
      const srcEntries = window.fflate.unzipSync(bytes);
      const ctName = '[Content_Types].xml';
      const ctSame = srcEntries[ctName] && monoCheck.entries[ctName]
        && srcEntries[ctName].length === monoCheck.entries[ctName].length
        && srcEntries[ctName].every((v, i) => v === monoCheck.entries[ctName][i]);
      // 重新解析單語輸出
      let reparse;
      try {
        reparse = await eng.parseDocxFile(new File([mono.bytes], 'probe2.docx'), () => {}, {});
      } catch (err) {
        return { error: 'reparse-throw: ' + (err && err.message) + (monoCheck.bad.length ? ' badXml=' + monoCheck.bad.join(',') : '') };
      }
      const reBlocks = reparse.chapters.flatMap((c) => c.blocks);
      const missing = reBlocks.filter((b) => !b.plainText.startsWith('偽')).length;
      return {
        blocks: blocks.length,
        islands,
        chapters: doc.chapters.length,
        reBlocks: reBlocks.length,
        missingPseudo: missing,
        badXmlMono: monoCheck.bad,
        badXmlDual: dualCheck.bad,
        ctSame: !!ctSame,
        monoB64: save ? toB64(mono.bytes) : null,
        dualB64: save ? toB64(dual.bytes) : null,
      };
    }, { b64Str: b64, save: SAVE });
  } catch (err) {
    res = { error: 'evaluate-throw: ' + err.message };
  }
  const ms = Date.now() - t0;

  if (SAVE && res.monoB64) {
    const stem = name.replace(/\.docx$/i, '');
    fs.writeFileSync(path.join(PSEUDO_DIR, `${stem}-mono.docx`), Buffer.from(res.monoB64, 'base64'));
    fs.writeFileSync(path.join(PSEUDO_DIR, `${stem}-dual.docx`), Buffer.from(res.dualB64, 'base64'));
  }
  delete res.monoB64;
  delete res.dualB64;

  let status;
  if (res.negative) {
    // 語料內建負面案例：加密 / 追蹤修訂擋下 = 預期行為
    status = `NEG(${res.negative})`;
    negOk++;
  } else if (res.error) {
    status = 'FAIL';
    failCount++;
  } else if (res.badXmlMono.length || res.badXmlDual.length
    || res.missingPseudo > 0 || res.blocks !== res.reBlocks || !res.ctSame) {
    status = 'FAIL';
    failCount++;
  } else {
    status = 'OK';
    okCount++;
  }
  report.push({ file: name, status, ms, ...res });
  const detail = res.error ? res.error
    : res.negative ? ''
      : `blocks=${res.blocks} islands=${res.islands} ch=${res.chapters}`
        + (res.missingPseudo ? ` MISSING=${res.missingPseudo}` : '')
        + (res.blocks !== res.reBlocks ? ` REBLOCKS=${res.reBlocks}` : '')
        + (res.badXmlMono?.length ? ` BADXML=${res.badXmlMono.join(',')}` : '')
        + (res.badXmlDual?.length ? ` BADXML-DUAL=${res.badXmlDual.join(',')}` : '')
        + (!res.ctSame ? ' CT-DRIFT' : '');
  console.log(`${status.padEnd(18)} ${String(ms).padStart(5)}ms  ${name}  ${detail}`);
}

const reportPath = path.join(OUT_DIR, 'docx-verify-report.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\n=== docx-verify: OK=${okCount} NEG=${negOk} FAIL=${failCount} / ${files.length} ===`);
console.log('report:', reportPath);
await ctx.close();
process.exit(failCount > 0 ? 1 : 0);
