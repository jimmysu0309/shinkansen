// probe-docx-slots.mjs — 量測整個 docx 語料的 ⟦N⟧ slot 密度（改 serializer policy 前後對比用）
import { chromium } from '@playwright/test';
import path from 'node:path'; import fs from 'node:fs'; import os from 'node:os';
const ROOT=path.resolve(import.meta.dirname,'..','..');
const EXT=path.join(ROOT,'shinkansen');
const CORPUS=path.join(ROOT,'docs/excluded/test docx/corpus');
const files=['lo-fixtures','real-world'].flatMap(s=>{
  const d=path.join(CORPUS,s); if(!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter(f=>f.endsWith('.docx')).sort().map(f=>path.join(d,f));
});
const udd=fs.mkdtempSync(path.join(os.tmpdir(),'sk-slots-'));
const ctx=await chromium.launchPersistentContext(udd,{headless:false,args:['--headless=new',`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,'--no-first-run','--mute-audio']});
let [sw]=ctx.serviceWorkers(); if(!sw) sw=await ctx.waitForEvent('serviceworker');
const page=await ctx.newPage();
await page.goto(`chrome-extension://${new URL(sw.url()).host}/translate-doc/index.html`,{waitUntil:'domcontentloaded'});
let totSlots=0,totAtomic=0,totChars=0,totBlocks=0; const per={};
for(const f of files){
  const b64=fs.readFileSync(f).toString('base64');
  const r=await page.evaluate(async b=>{
    const eng=await import('/translate-doc/docx-engine.js');
    const bytes=Uint8Array.from(atob(b),c=>c.charCodeAt(0));
    try{
      const doc=await eng.parseDocxFile(new File([bytes],'p.docx'),()=>{},{});
      let s=0,a=0,c=0,n=0;
      for(const ch of doc.chapters) for(const bl of ch.blocks){
        n++; c+=bl.epubSerializedText.length;
        s+=(bl.epubSerializedText.match(/⟦\d+⟧/g)||[]).length;
        a+=(bl.epubSerializedText.match(/⟦\*\d+⟧/g)||[]).length;
      }
      return {s,a,c,n};
    }catch(e){ return null; }
  },b64);
  if(!r) continue;
  per[path.basename(f)]=r;
  totSlots+=r.s; totAtomic+=r.a; totChars+=r.c; totBlocks+=r.n;
}
console.log(JSON.stringify({totBlocks,totSlots,totAtomic,totChars},null,2));
fs.writeFileSync(process.env.OUT||'/tmp/dxword/slots.json',JSON.stringify(per,null,2));
await ctx.close();
