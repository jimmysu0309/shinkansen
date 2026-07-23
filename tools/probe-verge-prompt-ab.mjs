// probe-verge-prompt-ab.mjs — A/B:現行佔位符指令 vs 追加「收尾自檢」硬化段,
// 測 gemini-3.1-flash-lite 對 The Verge 高密度巢狀段的標記存活率是否改善。
// 跑法: node tools/probe-verge-prompt-ab.mjs [rounds=6]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DELIMITER, MARKER_COMPACT, buildEffectiveSystemInstruction } from '../shinkansen/lib/system-instruction.js';

const ROUNDS = Number(process.argv[2] || 6);
const MODEL = 'gemini-3.1-flash-lite';
const API_KEY = fs.readFileSync(path.join(os.homedir(), '.shinkansen-test-key'), 'utf-8').trim();

function extractPrompt(name) {
  const src = fs.readFileSync(new URL('../shinkansen/lib/storage.js', import.meta.url), 'utf-8');
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

const TEXT = 'This week, I’ve been reading about ⟦0⟧⟦1⟧David Attenborough⟦/1⟧⟦/0⟧ and ⟦2⟧⟦3⟧screenwriters-turned-AI-trainers⟦/3⟧⟦/2⟧ and ⟦4⟧⟦5⟧the ⟦/5⟧⟦6⟧⟦7⟧Subway Takes⟦/7⟧⟦/6⟧⟦8⟧ guy⟦/8⟧⟦/4⟧, listening to a lot of ⟦9⟧⟦10⟧Productivity FM’s mixes⟦/10⟧⟦/9⟧ while I work, finally writing ⟦11⟧⟦12⟧my vibe-coding opus⟦/12⟧⟦/11⟧, testing the Poppy AI assistant (and giving it more of my data than I frankly should have), tracking my pathetic step counts with the new Fitbit Air, buying more of ⟦13⟧⟦14⟧⟦15⟧The Atlantic⟦/15⟧⟦/14⟧⟦16⟧’s summer reading list⟦/16⟧⟦/13⟧ than I will ever plausibly read, watching a lot of ⟦17⟧⟦18⟧Maxinomics⟦/18⟧⟦/17⟧ videos after ⟦19⟧⟦20⟧the one on quartz⟦/20⟧⟦/19⟧ went viral, drowning in the nostalgia of my all-time ⟦21⟧⟦22⟧Spotify Wrapped playlist⟦/22⟧⟦/21⟧, and switching browsers for the first time in forever. More on that next week.';
const SLOT_COUNT = 23;

const HARDENING = '\n\n（C）收尾自檢（極重要）：最常見的錯誤是「開了標記卻忘記關」——譯文重組句子時 ⟦數字⟧ 出現了，但對應的 ⟦/數字⟧ 沒輸出。每段輸出完成前逐一自檢：輸入裡的每一個 ⟦N⟧…⟦/N⟧ 配對，輸出裡都必須同時含 ⟦N⟧ 與 ⟦/N⟧。\n錯誤輸出 4： 從 ⟦3⟧⟦4⟧《大西洋月刊》⟦/4⟧⟦5⟧ 的夏季書單買了很多書（⟦5⟧ 與 ⟦3⟧ 都沒有收尾標記，整組連結會遺失）\n正確做法： 從 ⟦3⟧⟦4⟧《大西洋月刊》⟦/4⟧⟦5⟧ 的夏季書單⟦/5⟧⟦/3⟧ 買了很多書';

const markedTexts = [MARKER_COMPACT.fmt(1) + TEXT];
const joined = markedTexts.join(DELIMITER);
const baseSystem = buildEffectiveSystemInstruction(BASE_SYSTEM, [TEXT], joined, null, null, null);
const VARIANTS = [
  { name: 'baseline(現行)', system: baseSystem },
  { name: 'hardened(+收尾自檢)', system: baseSystem + HARDENING },
];

async function callOnce(system) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: joined }] }],
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: { temperature: 1.0, maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: 'minimal' } },
  };
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`API ${resp.status}: ${JSON.stringify(json).slice(0, 150)}`);
  return json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
}

function analyze(out) {
  const bad = [];
  for (let n = 0; n < SLOT_COUNT; n++) {
    const o = out.includes(`⟦${n}⟧`);
    const c = out.includes(`⟦/${n}⟧`);
    if (!(o && c)) bad.push(`${n}${o ? 'o' : ''}${c ? 'c' : ''}`);
  }
  return bad;
}

for (const v of VARIANTS) {
  let clean = 0;
  for (let r = 0; r < ROUNDS; r++) {
    let out;
    try { out = await callOnce(v.system); } catch (e) { console.log(`[${v.name}] round ${r + 1}: API 失敗 ${e.message.slice(0, 100)}`); continue; }
    const seg = out.split(/<<<SHINKANSEN_SEP>>>/)[0];
    const bad = analyze(seg);
    if (bad.length === 0) clean++;
    console.log(`[${v.name}] round ${r + 1}: ${bad.length === 0 ? '✓ 全存活' : '✗ 壞 slot: ' + bad.join(',')}`);
  }
  console.log(`>> ${v.name}: ${clean}/${ROUNDS} 全存活\n`);
}
