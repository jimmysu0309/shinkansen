#!/usr/bin/env node
// pdf-corpus-fetch.mjs — PDF 測試語料下載（Phase 1，docs/excluded/planning/pdf-test-plan.md §1.2）
//
// 用法：
//   node tools/pdf-corpus-fetch.mjs                 # 依 corpus/SOURCES.json 下載，缺 sha256 者補寫（lock）
//   node tools/pdf-corpus-fetch.mjs --only tables   # 只抓某 bucket
//   node tools/pdf-corpus-fetch.mjs --force         # 已存在也重抓
//
// 行為：
//   - 目的地 docs/excluded/test pdf/corpus/<bucket>/<sanitized name>（docs/excluded 整層不入 repo）
//   - 已存在且 sha256 相符 → SKIP；SOURCES.json 沒 sha 的第一次下載後把 sha 寫回（之後上游改檔會被抓到）
//   - 回應不是 %PDF 開頭（HTML 錯誤頁 / 被擋）→ FAIL 不落地
//   - 失敗不中斷整批，最後列清單；exit 1 表示至少一檔失敗
//
// 語料只在本機測試用，不隨產品散布（授權見各來源 repo）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const CORPUS = path.join(ROOT, 'docs/excluded/test pdf/corpus');
const SOURCES_PATH = path.join(CORPUS, 'SOURCES.json');
const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const onlyIdx = argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
const CONCURRENCY = 6;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 shinkansen-corpus-fetch';

const sources = JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf-8'));
const todo = sources.filter((s) => !ONLY || s.bucket === ONLY);

export function sanitizeName(name) {
  return name.replace(/[^\w.\-一-鿿぀-ヿ가-힣؀-ۿ֐-׿]+/g, '_').replace(/_+/g, '_');
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function fetchOne(s) {
  const dir = path.join(CORPUS, s.bucket);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, sanitizeName(s.name));
  s.file = path.relative(CORPUS, dest);
  if (!FORCE && fs.existsSync(dest)) {
    const cur = sha256(fs.readFileSync(dest));
    if (!s.sha256) { s.sha256 = cur; return { status: 'SKIP(lock)', dest }; }
    if (s.sha256 === cur) return { status: 'SKIP', dest };
    return { status: 'FAIL', dest, detail: 'sha 不符（上游或本機改過），--force 重抓' };
  }
  let res;
  try {
    res = await fetch(s.url, { headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(90_000) });
  } catch (err) {
    return { status: 'FAIL', dest, detail: 'fetch: ' + err.message };
  }
  if (!res.ok) return { status: 'FAIL', dest, detail: `HTTP ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 8 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    // qpdf 的 bad1.pdf 之類刻意壞檔沒有 %PDF 頭，encryption-broken bucket 放行
    if (s.bucket !== 'encryption-broken' && s.bucket !== 'scanned') {
      return { status: 'FAIL', dest, detail: `非 PDF（${buf.length} bytes，開頭 ${JSON.stringify(buf.subarray(0, 12).toString('latin1'))}）` };
    }
  }
  fs.writeFileSync(dest, buf);
  const cur = sha256(buf);
  if (s.sha256 && s.sha256 !== cur) return { status: 'FAIL', dest, detail: 'sha 不符（上游改檔）' };
  s.sha256 = cur;
  return { status: 'OK', dest, bytes: buf.length };
}

const results = [];
let i = 0;
async function worker() {
  while (i < todo.length) {
    const s = todo[i++];
    const r = await fetchOne(s);
    results.push({ ...r, source: s });
    console.log(`${r.status.padEnd(11)} ${s.bucket.padEnd(18)} ${sanitizeName(s.name)}${r.bytes ? `  ${Math.round(r.bytes / 1024)}KB` : ''}${r.detail ? `  — ${r.detail}` : ''}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

fs.writeFileSync(SOURCES_PATH, JSON.stringify(sources, null, 1), 'utf-8');
const fails = results.filter((r) => r.status === 'FAIL');
const ok = results.filter((r) => r.status === 'OK').length;
const skip = results.length - ok - fails.length;
console.log(`\n=== pdf-corpus-fetch: OK=${ok} SKIP=${skip} FAIL=${fails.length} / ${results.length} ===`);
for (const f of fails) console.log(`  FAIL ${f.source.bucket}/${sanitizeName(f.source.name)} — ${f.detail}  ${f.source.url}`);
process.exit(fails.length ? 1 : 0);
