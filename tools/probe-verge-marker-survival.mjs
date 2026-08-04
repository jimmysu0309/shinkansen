// probe-verge-marker-survival.mjs — 使用者回報:The Verge Installer 段落(9 連結、
// 23 巢狀 slot)用 gemini-3.1-flash-lite 翻譯後 inline 連結消失,gemini-3-flash-preview 正常。
//
// 本 probe 忠實重現 production 組裝(buildEffectiveSystemInstruction、«N» marker、
// DELIMITER、temperature 1.0、thinkingLevel minimal),用該段真實序列化文本
// (tools/tmp-dump-verge-serialized.mjs 從真實頁面抽出)打真 API,統計各模型
// 佔位符配對存活率(23 slots:paired ⟦N⟧…⟦/N⟧ 全部到齊才算存活)。
//
// 訊號層:驗「LLM 對高密度巢狀佔位符的保留率」(機率性);不驗 Shinkansen 端
// serialize / deserialize 管線(那層由既有 spec 蓋)。
//
// 跑法: node tools/probe-verge-marker-survival.mjs [rounds=5]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DELIMITER, MARKER_COMPACT, buildEffectiveSystemInstruction } from '../shinkansen/lib/system-instruction.js';

const ROUNDS = Number(process.argv[2] || 5);
const MODELS = ['gemini-3.1-flash-lite', 'gemini-3-flash-preview'];
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

// 真實序列化文本(2026-07-20 從 theverge.com mole-bartender 文章抽出,23 slots)
const TEXT = 'This week, I’ve been reading about ⟦0⟧⟦1⟧David Attenborough⟦/1⟧⟦/0⟧ and ⟦2⟧⟦3⟧screenwriters-turned-AI-trainers⟦/3⟧⟦/2⟧ and ⟦4⟧⟦5⟧the ⟦/5⟧⟦6⟧⟦7⟧Subway Takes⟦/7⟧⟦/6⟧⟦8⟧ guy⟦/8⟧⟦/4⟧, listening to a lot of ⟦9⟧⟦10⟧Productivity FM’s mixes⟦/10⟧⟦/9⟧ while I work, finally writing ⟦11⟧⟦12⟧my vibe-coding opus⟦/12⟧⟦/11⟧, testing the Poppy AI assistant (and giving it more of my data than I frankly should have), tracking my pathetic step counts with the new Fitbit Air, buying more of ⟦13⟧⟦14⟧⟦15⟧The Atlantic⟦/15⟧⟦/14⟧⟦16⟧’s summer reading list⟦/16⟧⟦/13⟧ than I will ever plausibly read, watching a lot of ⟦17⟧⟦18⟧Maxinomics⟦/18⟧⟦/17⟧ videos after ⟦19⟧⟦20⟧the one on quartz⟦/20⟧⟦/19⟧ went viral, drowning in the nostalgia of my all-time ⟦21⟧⟦22⟧Spotify Wrapped playlist⟦/22⟧⟦/21⟧, and switching browsers for the first time in forever. More on that next week.';
const SLOT_COUNT = 23;

const markedTexts = [MARKER_COMPACT.fmt(1) + TEXT];
const joined = markedTexts.join(DELIMITER);
const effectiveSystem = buildEffectiveSystemInstruction(BASE_SYSTEM, [TEXT], joined, null, null, null);

async function callOnce(model) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: joined }] }],
    systemInstruction: { parts: [{ text: effectiveSystem }] },
    generationConfig: { temperature: 1.0, maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: 'minimal' } },
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

function analyzeMarkers(out) {
  const missingPairs = [];
  const brokenPairs = [];
  for (let n = 0; n < SLOT_COUNT; n++) {
    const hasOpen = out.includes(`⟦${n}⟧`);
    const hasClose = out.includes(`⟦/${n}⟧`);
    if (hasOpen && hasClose) continue;
    if (!hasOpen && !hasClose) missingPairs.push(n);
    else brokenPairs.push(n);
  }
  return { missingPairs, brokenPairs, survived: SLOT_COUNT - missingPairs.length - brokenPairs.length };
}

for (const model of MODELS) {
  let cleanRounds = 0;
  const lostSlotFreq = {};
  for (let r = 0; r < ROUNDS; r++) {
    let out;
    try { out = await callOnce(model); } catch (e) { console.log(`[${model}] round ${r + 1}: API 失敗 ${e.message.slice(0, 120)}`); continue; }
    const seg = out.split(/<<<SHINKANSEN_SEP>>>/)[0];
    const { missingPairs, brokenPairs, survived } = analyzeMarkers(seg);
    const clean = missingPairs.length === 0 && brokenPairs.length === 0;
    if (clean) cleanRounds++;
    for (const n of [...missingPairs, ...brokenPairs]) lostSlotFreq[n] = (lostSlotFreq[n] || 0) + 1;
    console.log(`[${model}] round ${r + 1}: 存活 ${survived}/${SLOT_COUNT}  整組遺失=[${missingPairs}]  半殘=[${brokenPairs}]`);
    if (!clean) {
      const idx = seg.indexOf('Atlantic');
      console.log(`  atlantic 區域: ${seg.replace(/\n/g, ' ').slice(Math.max(0, idx - 120), idx + 160)}`);
    }
  }
  console.log(`>> ${model}: ${cleanRounds}/${ROUNDS} 輪 23 slots 全存活;高頻遺失 slot: ${JSON.stringify(lostSlotFreq)}\n`);
}
