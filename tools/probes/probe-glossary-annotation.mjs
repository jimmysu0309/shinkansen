// probe-glossary-annotation.mjs — 驗證「術語表 target 含（原文）對照時,譯文是否保留對照」
//
// 背景(2026-07-12 Jimmy 回報):EPUB 全書術語表 entry「Changing Rooms →
// 《變換房間》（Changing Rooms）」（對照一次未勾）,譯文 raw 只出現《變換房間》,
// （Changing Rooms）被砍。session 真實資料顯示兩個詞都落在 ⟦0⟧…⟦/0⟧ 行內標記內。
// 假設根因:system-instruction.js 術語表注入指令「…也不需加註英文原文」與
// 帶對照的 target 自相矛盾,模型讀到後主動剝掉（原文）。
//
// 本 probe 忠實重現 production 組裝(import 真 buildEffectiveSystemInstruction、
// 抽真 DEFAULT_SYSTEM_PROMPT、«N» marker + DELIMITER、temperature 1.0),打真 API。
// 跑法:改 code 前跑一次(baseline,舊指令)→ 改指令後再跑(驗證修法)。
//   node tools/probe-glossary-annotation.mjs [rounds=3]
//
// 訊號層:驗 LLM 對「帶對照 target」的服從度(機率性,非決定性);不驗 Shinkansen
// 端注入管線(那層由 buildEffectiveSystemInstruction 單元行為 + 既有 spec 蓋)。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DELIMITER, MARKER_COMPACT, buildEffectiveSystemInstruction } from '../../shinkansen/lib/system-instruction.js';

const ROUNDS = Number(process.argv[2] || 3);
const MODELS = ['gemini-3.5-flash', 'gemini-3.1-flash-lite'];
const API_KEY = fs.readFileSync(path.join(os.homedir(), '.shinkansen-test-key'), 'utf-8').trim();

// 抽真 DEFAULT_SYSTEM_PROMPT(storage.js import compat.js 需 browser 環境,不能直接 import)
function extractPrompt(name) {
  const src = fs.readFileSync(new URL('../../shinkansen/lib/storage.js', import.meta.url), 'utf-8');
  const anchor = `const ${name} = \``;
  const start = src.indexOf(anchor);
  if (start < 0) throw new Error(`找不到 ${name}`);
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
const BASE_SYSTEM = extractPrompt('DEFAULT_SYSTEM_PROMPT');

// 模擬 c9-b169 結構:作品名在 ⟦N⟧…⟦/N⟧ 行內標記內、句子列舉兩部作品
const TEXTS = [
  'Fair enough, that was not the fault of the remaining presenters; the real problem was the format itself. Television was flooded with a new wave of reality shows such as ⟦0⟧Changing Rooms⟦/0⟧ and ⟦1⟧Ground Force⟦/1⟧, where every presenter seemed utterly at ease, chatting and joking as if the cameras were not there.',
  'He started his career at a small magazine before moving into television production.',
];
const GLOSSARY = [
  { source: 'Changing Rooms', target: '《變換房間》（Changing Rooms）', type: 'work' },
  { source: 'Ground Force', target: '《大地之力》（Ground Force）', type: 'work' },
];

const markedTexts = TEXTS.map((t, i) => MARKER_COMPACT.fmt(i + 1) + t);
const joined = markedTexts.join(DELIMITER);
const effectiveSystem = buildEffectiveSystemInstruction(BASE_SYSTEM, TEXTS, joined, GLOSSARY, null, null);

console.log('── 注入的術語表指令段 ──');
const gIdx = effectiveSystem.indexOf('術語對照表');
console.log(effectiveSystem.slice(Math.max(0, gIdx - 40), gIdx + 220));
console.log('────────────\n');

async function callOnce(model) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: joined }] }],
    systemInstruction: { parts: [{ text: effectiveSystem }] },
    generationConfig: { temperature: 1.0, maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'minimal' } },
  };
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`${model} API ${resp.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
}

for (const model of MODELS) {
  let keepBoth = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const out = await callOnce(model);
    const seg1 = out.split(/<<<SHINKANSEN_SEP>>>/)[0];
    const hasCR = seg1.includes('（Changing Rooms）') || seg1.includes('(Changing Rooms)');
    const hasGF = seg1.includes('（Ground Force）') || seg1.includes('(Ground Force)');
    const leadOk = seg1.includes('《變換房間》') && seg1.includes('《大地之力》');
    const doubled = /《《|》》/.test(seg1); // 2026-07-12 第二症狀:模型在含《》的譯名外再包一層
    if (hasCR && hasGF) keepBoth++;
    console.log(`[${model}] round ${r + 1}: 對照保留 CR=${hasCR} GF=${hasGF} 譯名=${leadOk} 雙書名號=${doubled}`);
    console.log(`  ${seg1.replace(/\n/g, ' ').slice(0, 220)}`);
  }
  console.log(`>> ${model}: ${keepBoth}/${ROUNDS} 輪兩個對照都保留\n`);
}
