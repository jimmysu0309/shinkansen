// probe-asr-llm-se-quality.mjs — 離線量測 ASR「AI 分句」LLM 回傳 s/e 的時間軸品質。
//
// 背景:Playwright fresh profile 拿不到 timedtext(POT 防護,200 空 body),
// 改用 yt-dlp 抓真實 ASR json3,忠實重現 _runAsrSubBatch 的輸入建構
// (視窗切分 → 子批切分 → [{s,e,t}] JSON),打真 Gemini API(同 production 設定:
// gemini-3.1-flash-lite、temperature 0.1、DEFAULT_ASR_SUBTITLE_SYSTEM_PROMPT),
// 然後分析回傳 entries 的 s/e 對時間軸的失真:
//   - e 是否合法輸入值(某片段的 e / 某片段的 s / 幻覺值 / e<s)
//   - 「提早收」= 分割真值(下一 entry 的 s 或子批末片段 e)- LLM e
//   - 「顯示空窗」= 套上 production 閱讀補償(200ms/字,min 800ms)與 next-start clamp 後,
//     語音仍在進行但 cue 已消失的秒數
//   - entry 之間未覆蓋的片段(下一句「太晚出現」的直接原因)
//
// 用法:
//   node tools/probe-asr-llm-se-quality.mjs <json3路徑> [windows數,預設8]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const JSON3_PATH = process.argv[2];
const N_WINDOWS = Number(process.argv[3] || 8);
const WINDOW_MS = 30_000;
const ASR_LAST_CUE_FALLBACK_MS = 1500;   // = SK.ASR_LAST_CUE_FALLBACK_MS
const MODEL = 'gemini-3.1-flash-lite';

if (!JSON3_PATH) { console.error('用法: node tools/probe-asr-llm-se-quality.mjs <json3> [windows]'); process.exit(1); }
const API_KEY = fs.readFileSync(path.join(os.homedir(), '.shinkansen-test-key'), 'utf-8').trim();

// ── 從 lib/storage.js 抽 DEFAULT_ASR_SUBTITLE_SYSTEM_PROMPT(template literal 內含
//    跳脫反引號,不能直接 import——storage.js import compat.js 需要 browser 環境)──
function extractAsrPrompt() {
  const src = fs.readFileSync(new URL('../../shinkansen/lib/storage.js', import.meta.url), 'utf-8');
  const anchor = 'export const DEFAULT_ASR_SUBTITLE_SYSTEM_PROMPT = `';
  const start = src.indexOf(anchor);
  if (start < 0) throw new Error('找不到 DEFAULT_ASR_SUBTITLE_SYSTEM_PROMPT');
  let i = start + anchor.length;
  let out = '';
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { out += src[i + 1]; i += 2; continue; }  // \` → `
    if (ch === '`') break;
    out += ch; i++;
  }
  return out;
}
const SYSTEM_PROMPT = extractAsrPrompt().replaceAll('{sourceLanguage}', '英文');

// ── parseJson3 忠實重現(content-youtube.js parseJson3)──
function parseJson3(json) {
  const segments = [];
  for (const ev of (json.events || [])) {
    if (!ev.segs) continue;
    const full = ev.segs.map(s => s.utf8 || '').join('');
    const lines = full.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      segments.push({ text: line, startMs: ev.tStartMs || 0 });
    }
  }
  return segments.sort((a, b) => a.startMs - b.startMs);
}

// ── _splitAsrSubBatches 忠實重現(lead 充裕情境:sub0Max=8000)──
function splitAsrSubBatches(windowSegs) {
  if (windowSegs.length === 0) return [];
  if (windowSegs.length <= 5) return [windowSegs];
  const GAP_MS = 500;
  const segs = windowSegs;
  const n = segs.length;
  const sub0Max = 8000, sub0Min = 2000;
  function findCutIdx(fromIdx, minSpanMs, maxSpanMs) {
    const baseMs = segs[fromIdx].startMs;
    let bestIdx = -1, bestGap = 0;
    for (let i = fromIdx + 1; i < n; i++) {
      const span = segs[i].startMs - baseMs;
      if (span < minSpanMs) continue;
      if (span > maxSpanMs) break;
      const gap = segs[i].startMs - segs[i - 1].startMs;
      if (gap >= GAP_MS && gap > bestGap) { bestGap = gap; bestIdx = i; }
    }
    if (bestIdx < 0) {
      for (let i = fromIdx + 1; i < n; i++) {
        if (segs[i].startMs - segs[fromIdx].startMs >= maxSpanMs) { bestIdx = i; break; }
      }
    }
    return bestIdx;
  }
  const cuts = [];
  const cut1 = findCutIdx(0, sub0Min, sub0Max);
  if (cut1 > 0) cuts.push(cut1);
  if (cut1 > 0) {
    const cut2 = findCutIdx(cut1, 8000, 15000);
    if (cut2 > cut1) cuts.push(cut2);
  }
  if (cuts.length === 0) return [segs];
  const batches = [];
  let prev = 0;
  for (const c of cuts) { batches.push(segs.slice(prev, c)); prev = c; }
  batches.push(segs.slice(prev));
  return batches.filter(b => b.length > 0);
}

// ── _runAsrSubBatch 輸入建構忠實重現 ──
function buildInputArr(subSegs) {
  return subSegs.map((seg, i) => {
    const next = subSegs[i + 1];
    const endMs = next ? next.startMs : seg.startMs + ASR_LAST_CUE_FALLBACK_MS;
    return { s: seg.startMs, e: endMs, t: seg.text };
  });
}

async function callGemini(inputJson) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: inputJson }] }],
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    generationConfig: { temperature: 0.1, thinkingConfig: { thinkingLevel: 'minimal' } },
  };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
}

function parseEntries(text) {
  const m = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const stripped = (m ? m[1] : text).trim();
  const start = stripped.indexOf('[');
  if (start < 0) return null;
  try { const a = JSON.parse(stripped.slice(start)); return Array.isArray(a) ? a : null; } catch { return null; }
}

// ── 主流程 ──
const json3 = JSON.parse(fs.readFileSync(JSON3_PATH, 'utf-8'));
const allSegs = parseJson3(json3);
console.log(`片段總數 ${allSegs.length},範圍 0–${Math.round(allSegs[allSegs.length - 1].startMs / 1000)}s`);

const agg = {
  entries: 0, invalidS: 0, eKind: { 'input-e': 0, 'input-s': 0, hallucinated: 0, 'e<s/NaN': 0 },
  shortfalls: [], blanks: [], uncoveredFrags: 0, totalFrags: 0, lateStarts: [],
};

for (let w = 0; w < N_WINDOWS; w++) {
  const winStart = w * WINDOW_MS;
  const windowSegs = allSegs.filter(s => s.startMs >= winStart && s.startMs < winStart + WINDOW_MS);
  if (!windowSegs.length) continue;
  const subBatches = splitAsrSubBatches(windowSegs);
  console.log(`\n═══ window ${winStart / 1000}–${winStart / 1000 + 30}s: ${windowSegs.length} 片段 → ${subBatches.length} 子批`);

  for (const subSegs of subBatches) {
    const inputArr = buildInputArr(subSegs);
    agg.totalFrags += inputArr.length;
    const inputJson = JSON.stringify(inputArr);
    let raw;
    try { raw = await callGemini(inputJson); } catch (e) { console.log('  API失敗:', e.message); continue; }
    const entries = parseEntries(raw);
    if (!entries) { console.log('  ★ 回應 parse 失敗:', raw.slice(0, 120)); continue; }

    const startSet = new Set(inputArr.map(f => f.s));
    const inputEndSet = new Set(inputArr.map(f => f.e));
    const lastInputE = inputArr[inputArr.length - 1].e;

    const valid = entries
      .map(en => ({ s: Number(en.s), e: Number(en.e), t: String(en.t || '') }))
      .filter(en => { const ok = Number.isFinite(en.s) && startSet.has(en.s); if (!ok) { agg.invalidS++; console.log(`  ✗ invalid s=${en.s} "${en.t.slice(0, 20)}"`); } return ok; })
      .sort((a, b) => a.s - b.s);

    // 覆蓋檢查:每個片段屬於哪個 entry 的 [s,e](production covered 邏輯)
    const coveredSet = new Set();
    for (const en of valid) {
      const eOk = Number.isFinite(en.e) && en.e >= en.s ? en.e : en.s;
      for (const f of inputArr) if (f.s >= en.s && f.s <= eOk) coveredSet.add(f.s);
    }
    const uncovered = inputArr.filter(f => !coveredSet.has(f.s));
    agg.uncoveredFrags += uncovered.length;

    for (let i = 0; i < valid.length; i++) {
      const en = valid[i];
      const next = valid[i + 1];
      const trueEnd = next ? next.s : lastInputE;
      const eKind = !Number.isFinite(en.e) || en.e < en.s ? 'e<s/NaN'
        : inputEndSet.has(en.e) ? 'input-e'
        : startSet.has(en.e) ? 'input-s'
        : 'hallucinated';
      agg.eKind[eKind]++;
      agg.entries++;
      const eUse = eKind === 'e<s/NaN' ? en.s : en.e;
      const shortfall = trueEnd - eUse;
      agg.shortfalls.push(shortfall);
      // production 顯示模擬:閱讀補償 + next-start clamp
      const readMs = Math.max(800, en.t.length * 200);
      const displayEnd = Math.max(eUse, en.s + readMs);
      const effEnd = next ? Math.min(displayEnd, next.s) : displayEnd;
      const blank = Math.max(0, trueEnd - effEnd);
      agg.blanks.push(blank);
      const mark = blank > 500 ? ' ★空窗' : '';
      if (blank > 500 || eKind !== 'input-e') {
        console.log(`  s=${(en.s/1000).toFixed(1)} e=${(en.e/1000).toFixed(1)} 真end=${(trueEnd/1000).toFixed(1)} [${eKind}] 短收=${(shortfall/1000).toFixed(1)}s 空窗=${(blank/1000).toFixed(1)}s${mark} "${en.t.slice(0, 24)}"`);
      }
    }
    if (uncovered.length) {
      console.log(`  ⚠ 未覆蓋片段 ${uncovered.length} 條: ${uncovered.slice(0, 4).map(f => `${(f.s/1000).toFixed(1)}s"${f.t.slice(0, 15)}"`).join(' | ')}`);
    }
  }
}

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.floor(s.length / 2)]); };
const pctOver = (a, ms) => a.length ? (a.filter(v => v > ms).length / a.length * 100).toFixed(0) : '0';
console.log('\n════════ 彙總 ════════');
console.log(`entries=${agg.entries} invalidS(整條被丟)=${agg.invalidS}`);
console.log(`e 分類: ${JSON.stringify(agg.eKind)}`);
console.log(`短收>1s 比例: ${pctOver(agg.shortfalls, 1000)}% / >3s: ${pctOver(agg.shortfalls, 3000)}% (中位 ${median(agg.shortfalls)}ms)`);
console.log(`顯示空窗>500ms 比例: ${pctOver(agg.blanks, 500)}% / >2s: ${pctOver(agg.blanks, 2000)}% (中位 ${median(agg.blanks)}ms)`);
console.log(`未覆蓋片段: ${agg.uncoveredFrags}/${agg.totalFrags}`);
