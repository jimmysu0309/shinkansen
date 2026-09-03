// probe-docx-parse.mjs — 單一 docx 的解析結果傾印（plainText / ⟦N⟧ 序列化 / rprs / islands）
//
// 用法：FILE=/path/to/doc.docx node tools/probe-docx-parse.mjs
//
// 用途：查「某個 run 的格式有沒有進 slot」「island 抓到哪些」這類問題的第一手資料。
// 序列化字串裡的不可見字元（Symbol 字型 PUA 等）在終端機看不出來，需要時把輸出
// 丟給 python 逐字元印 codepoint。
import { chromium } from '@playwright/test';
import path from 'node:path'; import fs from 'node:fs'; import os from 'node:os';
const ROOT='/Users/jimmysu/Documents/Claude/Projects/Shinkansen';
const EXT=path.join(ROOT,'shinkansen');
const FILE=process.env.FILE;
const udd=fs.mkdtempSync(path.join(os.tmpdir(),'sk-probe-'));
const ctx=await chromium.launchPersistentContext(udd,{headless:false,args:['--headless=new',`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,'--no-first-run','--mute-audio']});
let [sw]=ctx.serviceWorkers(); if(!sw) sw=await ctx.waitForEvent('serviceworker');
const id=new URL(sw.url()).host; const page=await ctx.newPage();
await page.goto(`chrome-extension://${id}/translate-doc/index.html`,{waitUntil:'domcontentloaded'});
const b64=fs.readFileSync(FILE).toString('base64');
const out=await page.evaluate(async (b)=>{
  const eng=await import('/translate-doc/docx-engine.js');
  const bytes=Uint8Array.from(atob(b),c=>c.charCodeAt(0));
  const doc=await eng.parseDocxFile(new File([bytes],'p.docx'),()=>{},{});
  const blocks=doc.chapters.flatMap(c=>c.blocks);
  return blocks.map(bl=>({
    plain: bl.plainText,
    ser: bl.epubSerializedText,
    html: bl.htmlSource || bl.html || null,
    rprs: bl.docx && bl.docx.rprs,
    islands: bl.docx && bl.docx.islands,
  }));
}, b64);
console.log(JSON.stringify(out,null,2));
await ctx.close();
