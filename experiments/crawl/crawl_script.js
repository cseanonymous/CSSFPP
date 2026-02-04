// Usage: node crawl_script.js sites.txt 8
import pLimit from 'p-limit';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { chromium } from 'playwright';

const NAV_TIMEOUT = 25000;                 // per navigation
const OUT_DIR = 'out/css';                 // where CSS files go
const CONCURRENCY = parseInt(process.argv[3] || '6', 10);

// Skip infra/CDN/DNS-style domains that rarely have browsable pages
const SKIP_PATTERNS = [
  /(^|\.)googlevideo\.com$/i,
  /(^|\.)gstatic\.com$/i,
  /(^|\.)akamai(edge)?\.net$/i,
  /(^|\.)edgesuite\.net$/i,
  /(^|\.)fastly\.com$/i,
  /(^|\.)cloudfront\.net$/i,
  /(^|\.)doubleclick\.net$/i,
  /(^|\.)gtld-servers\.net$/i,
  /(^|\.)root-servers\.net$/i,
  /(^|\.)amazonaws\.com$/i
];

function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function normOrigin(d) { return d.replace(/[^\w.-]/g, '_'); }
function shouldSkip(domain) { return SKIP_PATTERNS.some(rx => rx.test(domain)); }

// Try https/http with and without www
function candidates(domain) {
  const d = domain.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  return [
    `https://${d}/`,
    `https://www.${d}/`,
    `http://${d}/`,
    `http://www.${d}/`
  ];
}

async function runOne(browser, domain) {
  if (shouldSkip(domain)) {
    console.warn('skip (infra/CDN):', domain);
    return;
  }

  await fs.promises.mkdir(path.join(OUT_DIR), { recursive: true });

  const originTag = normOrigin(domain);

  const context = await browser.newContext({
    userAgent: undefined,
    ignoreHTTPSErrors: true      // tolerate odd certs
  });

  // Block heavy assets to speed up
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (/\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|m4v|mov|avi|m3u8|woff2?)$/i.test(url)) {
      return route.abort();
    }
    route.continue();
  });

  const page = await context.newPage();
  const seen = new Set();

  // Save external text/css responses
  page.on('response', async (resp) => {
    try {
      const u = resp.url();
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('text/css')) return;
      if (seen.has(u)) return;
      const body = await resp.text();
      seen.add(u);
      const h = sha1(body);
      await fs.promises.writeFile(path.join(OUT_DIR, `${originTag}__${h}.css`), body);
    } catch { /* ignore individual failures */ }
  });

  try {
    // Try several candidate URLs until one loads
    let loaded = false, lastErr;
    for (const url of candidates(domain)) {
      try {
        await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
        loaded = true;
        break;
      } catch (e) { lastErr = e; }
    }
    if (!loaded) throw lastErr;

    // Grab inline <style> from first page
    const styles = await page.$$eval('style', ns => ns.map(n => n.textContent || ''));
    for (let i = 0; i < styles.length; i++) {
      const css = styles[i];
      const h = sha1(css);
      await fs.promises.writeFile(path.join(OUT_DIR, `${originTag}__inline_${i}__${h}.css`), css);
    }

    // Follow one same-origin link (optional second page)
    const link = await page.$$eval('a[href]', (as) => {
      const o = location.origin;
      const same = as.map(a => a.href).filter(h => h && h.startsWith(o));
      return same.find(h => !/#/.test(h)) || null;
    });
    if (link) {
      await page.goto(link, { waitUntil: 'load', timeout: NAV_TIMEOUT });
      const styles2 = await page.$$eval('style', ns => ns.map(n => n.textContent || ''));
      for (let i = 0; i < styles2.length; i++) {
        const css = styles2[i];
        const h = sha1(css);
        await fs.promises.writeFile(path.join(OUT_DIR, `${originTag}__p2_inline_${i}__${h}.css`), css);
      }
    }

  } catch (e) {
    console.warn('skip', domain, '-', e.message);
  } finally {
    await context.close();
  }
}

(async () => {
  const domains = fs.readFileSync(process.argv[2], 'utf8')
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  const browser = await chromium.launch({ headless: true });

  const limit = pLimit(CONCURRENCY);
  let done = 0;
  const tasks = domains.map(d => limit(async () => {
    await runOne(browser, d);
    done++;
    if (done % 25 === 0) console.log(`Progress: ${done}/${domains.length}`);
  }));

  await Promise.all(tasks);
  await browser.close();
  console.log('Crawl complete.');
})();
