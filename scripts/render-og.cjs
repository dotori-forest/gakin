// Renders scripts/og-image.html to icons/og.png (the link-preview image).
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

(async () => {
  const root = path.join(__dirname, '..');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.goto(pathToFileURL(path.join(__dirname, 'og-image.html')).href);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(root, 'icons', 'og.png') });
  await browser.close();
})();
