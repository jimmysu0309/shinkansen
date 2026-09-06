// probe-asr-window-boundary.mjs — 真實 ASR 軌驗證「視窗邊界切在句中 → 句尾詞跨字幕重複」
// 修法(v2.0.54 _collectAsrWindowSegs 尾端延伸 + prompt 殘句規則)的 ground truth。
//
// 背景:30s 視窗純時間切分會把句子切成兩半送進獨立 LLM 呼叫——前窗腦補句尾、
// 後窗殘句起頭(real-data:cXot3z7ZPOo 150s 邊界切在「It makes 181 ⟷ horsepower」)。
// 本 probe 忠實重現視窗收集(含尾端延伸 + consumed 去重),對指定邊界的前後兩個視窗
// 打真 Gemini API(production ASR prompt),印出邊界兩側 entry 讓人眼比對是否還有
// 重複詞/腦補詞。--legacy 可退回舊純時間切分對照。
//
// 用法:
//   node tools/probe-asr-window-boundary.mjs <json3路徑> <邊界ms> [--legacy]
//   例:node tools/probe-asr-window-boundary.mjs /tmp/miata.en.json3 150000

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const JSON3_PATH = process.argv[2];
const BOUNDARY_MS = Number(process.argv[3] || 150000);
const LEGACY = process.argv.includes('--legacy');
const WINDOW_MS = 30_000;
const MODEL = 'gemini-3.1-flash-lite';
// = SK.ASR_WINDOW_MAX_TAIL_EXTEND_MS / ASR_LAST_CUE_MAX_EXTEND_MS / ASR_LAST_CUE_FALLBACK_MS
const TAIL_EXTEND_MS = 12000;
const LAST_CUE_MAX_EXTEND_MS = 5000;
const LAST_CUE_FALLBACK_MS = 1500;

if (!JSON3_PATH) { console.error('用法: node tools/probe-asr-window-boundary.mjs <json3> <邊界ms> [--legacy]'); process.exit(1); }
const API_KEY = fs.readFileSync(path.join(os.homedir(), '.shinkansen-test-key'), 'utf-8').trim();

// ── DEFAULT_ASR_SUBTITLE_SYSTEM_PROMPT 抽取(同 probe-asr-llm-se-quality.mjs)──
function extractAsrPrompt() {
  const src = fs.readFileSync(new URL('../../shinkansen/lib/storage.js', import.meta.url), 'utf-8');
  const anchor = 'export const DEFAULT_ASR_SUBTITLE_SYSTEM_PROMPT = `';
  const start = src.indexOf(anchor);
  if (start < 0) throw new Error('找不到 DEFAULT_ASR_SUBTITLE_SYSTEM_PROMPT');
  let i = start + anchor.length;
  let out = '';
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { out += src[i + 1]; i += 2; continue; }
    if (ch === '`') break;
    out += ch; i++;
  }
  return out;
}
const SYSTEM_PROMPT = extractAsrPrompt().replaceAll('{sourceLanguage}', '英文');

// ── parseJson3 忠實重現(content-youtube.js)──
function parseJson3(json) {
  const segments = [];
  for (const ev of (json.events || [])) {
    if (!ev.segs) continue;
    const full = ev.segs.map(s => s.utf8 || '').join('');
    const lines = full.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) segments.push({ text: line, startMs: ev.tStartMs || 0 });
  }
  return segments.sort((a, b) => a.startMs - b.startMs);
}

// ── _collectAsrWindowSegs 忠實重現(content-youtube.js v2.0.54)──
const SENTENCE_END_RE = /[.!?。！？…]["')\]」』]*$/;
function collectWindowSegs(raw, winStart, winEnd, consumed) {
  if (LEGACY) return raw.filter(s => s.startMs >= winStart && s.startMs < winEnd && !consumed.has(s.startMs));
  const maxMs = winEnd + TAIL_EXTEND_MS;
  const segs = [];
  for (const seg of raw) {
    if (!seg || seg.startMs < winStart) continue;
    if (consumed.has(seg.startMs)) {
      if (seg.startMs >= winEnd) break;
      continue;
    }
    if (seg.startMs < winEnd) { segs.push(seg); continue; }
    if (segs.length === 0) break;
    if (SENTENCE_END_RE.test(segs[segs.length - 1].text.trim())) break;
    if (seg.startMs > maxMs) break;
    segs.push(seg);
  }
  return segs;
}

// ── _asrBatchEndMs + input 建構忠實重現(_runAsrSubBatch)──
function batchEndMs(lastStartMs, raw) {
  const next = raw.find(s => s.startMs > lastStartMs);
  if (next) return Math.min(next.startMs, lastStartMs + LAST_CUE_MAX_EXTEND_MS);
  return lastStartMs + LAST_CUE_FALLBACK_MS;
}
function buildInput(segs, raw) {
  const end = batchEndMs(segs[segs.length - 1].startMs, raw);
  return segs.map((seg, i) => ({ s: seg.startMs, e: segs[i + 1] ? segs[i + 1].startMs : end, t: seg.text }));
}

async function translateWindow(inputArr) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(inputArr) }] }],
      generationConfig: { temperature: 0.1 },
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  const m = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const stripped = m ? m[1].trim() : text.trim();
  return JSON.parse(stripped.slice(stripped.indexOf('[')));
}

const raw = parseJson3(JSON.parse(fs.readFileSync(JSON3_PATH, 'utf-8')));
console.log(`模式:${LEGACY ? 'LEGACY(純時間切分)' : 'NEW(尾端延伸+去重)'};軌 ${raw.length} 條;邊界 ${BOUNDARY_MS / 1000}s\n`);

const winA = BOUNDARY_MS - WINDOW_MS;
const consumed = new Set();
const segsA = collectWindowSegs(raw, winA, BOUNDARY_MS, consumed);
segsA.forEach(s => consumed.add(s.startMs));
const segsB = collectWindowSegs(raw, BOUNDARY_MS, BOUNDARY_MS + WINDOW_MS, consumed);

console.log(`── 視窗 A ${winA / 1000}-${BOUNDARY_MS / 1000}s:${segsA.length} 條(末條 @${(segsA.at(-1).startMs / 1000).toFixed(1)}s「${segsA.at(-1).text}」)`);
console.log(`── 視窗 B ${BOUNDARY_MS / 1000}-${(BOUNDARY_MS + WINDOW_MS) / 1000}s:${segsB.length} 條(首條 @${(segsB[0].startMs / 1000).toFixed(1)}s「${segsB[0].text}」)\n`);

const [entA, entB] = await Promise.all([
  translateWindow(buildInput(segsA, raw)),
  translateWindow(buildInput(segsB, raw)),
]);

console.log('視窗 A 末 3 entries:');
for (const e of entA.slice(-3)) console.log(`  [${(e.s / 1000).toFixed(1)}-${(e.e / 1000).toFixed(1)}s] ${e.t}`);
console.log('視窗 B 首 3 entries:');
for (const e of entB.slice(0, 3)) console.log(`  [${(e.s / 1000).toFixed(1)}-${(e.e / 1000).toFixed(1)}s] ${e.t}`);

// 超長句統計(code 端 splitLongCue 保底會接手的部分)
const all = [...entA, ...entB];
const over = all.filter(e => String(e.t || '').length > 40);
console.log(`\n>40 字 entry:${over.length}/${all.length}(這些由 _splitLongAsrCue 顯示層拆分接手)`);
for (const e of over) console.log(`  (${String(e.t).length} 字) ${e.t}`);
