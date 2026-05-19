import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.resolve(__dirname, '..', 'solhunt-banner.html');
const outPath = path.resolve(__dirname, '..', 'solhunt-banner.png');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 500 }, deviceScaleFactor: 2 });
await page.goto('file://' + htmlPath);
await page.waitForLoadState('networkidle');
const el = await page.$('.banner');
await el.screenshot({ path: outPath, omitBackground: false });
await browser.close();
console.log('Rendered:', outPath);
