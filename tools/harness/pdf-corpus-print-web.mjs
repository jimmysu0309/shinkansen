// pdf-corpus-print-web.mjs — Chrome「列印為 PDF」網頁 → exports bucket（使用者常見流程：網頁存 PDF 再丟翻譯）
import { chromium } from 'playwright';
import path from 'node:path';
const DST = path.resolve('docs/excluded/test pdf/corpus/exports');
const pages = [
  ['chrome-print-wiki-en-Kaohsiung.pdf', 'https://en.wikipedia.org/wiki/Kaohsiung', {}],
  ['chrome-print-mdn-flexbox.pdf', 'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_flexible_box_layout/Basic_concepts_of_flexbox', {}],
  ['chrome-print-arxiv-abs.pdf', 'https://arxiv.org/abs/1706.03762', {}],
  ['chrome-print-wiki-ja-高雄市.pdf', 'https://ja.wikipedia.org/wiki/%E9%AB%98%E9%9B%84%E5%B8%82', {}],
  ['chrome-print-hn-landscape.pdf', 'https://news.ycombinator.com/', { landscape: true }],
];
const browser = await chromium.launch({ args: ['--mute-audio'] });
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' });
for (const [name, url, opt] of pages) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.emulateMedia({ media: 'print' });
    await page.pdf({ path: path.join(DST, name), format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' }, ...opt });
    console.log('OK  ', name);
  } catch (err) { console.log('FAIL', name, err.message.slice(0, 120)); }
  await page.close();
}
await browser.close();
