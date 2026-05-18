import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.resolve(__dirname, '..', 'solhunt-hero-card.html');
const outPath = path.resolve(__dirname, '..', 'solhunt-hero-card.png');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1700 }, deviceScaleFactor: 2 });
await page.goto('file://' + htmlPath);
await page.waitForLoadState('networkidle');
const card = await page.$('.card');
await card.screenshot({ path: outPath, omitBackground: false });
await browser.close();
console.log('Rendered:', outPath);
