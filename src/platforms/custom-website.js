// Visit user-configured URLs in the shared browser profile — the generic
// "daily login = points" service (Temu, Lenovo, …). URLs are configured
// in Settings → Services → Custom websites (data/config.json
// services.custom-website.customUrls, or the CUSTOM_URLS env var: one URL
// per line, or comma-separated). Log in to those sites once via the panel
// Sessions tab (or noVNC) — the shared browser profile holds the session,
// and the panel's post-run session check (registry checkLogin = generic
// sign-in probe) notifies you if any goes stale.

import { launchContext, gotoWithRetry } from '#src/browser.js';
import { handleSIGINT, log, delay } from '#src/util.js';
import { cfg } from '#src/config.js';
import { siteVersion } from '#src/sites.js';

// Settle time after page load so the site's daily check-in beacon has
// fired before we move on (most fire within a second; allow for slow CDNs).
const SETTLE_MS = 2000;

handleSIGINT();
log.section(`Custom websites (v${siteVersion('custom-website')})`);

const urls = String(cfg.custom_urls || '')
  .split(/[\n,]+/)
  .map(s => s.trim())
  .filter(Boolean);

if (!urls.length) {
  log.warn('No custom websites configured — skipping.');
  log.status('hint', 'Add URLs in Settings → Services → Custom websites (or env CUSTOM_URLS), then re-run.');
  process.exit(0);
}

log.status('urls', urls.length);
log.status('mode', cfg.headless ? 'headless' : `headed${cfg.novnc_port ? ` (noVNC on :${cfg.novnc_port})` : ''}`);

const { context, page } = await launchContext('custom-website', { record: false, sigint: true });
let visited = 0;
let failed = 0;
try {
  for (const url of urls) {
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      /* not a plain http(s) URL — use as label */
    }
    try {
      await gotoWithRetry(page, url, {
        attempts: 2,
        backoffMs: 2000,
        gotoOpts: { waitUntil: 'domcontentloaded' },
        siteId: 'custom-website',
        label: host,
      });
      visited++;
      log.ok(`${host} visited`);
      await delay(SETTLE_MS); // let the page's login beacon fire
    } catch (e) {
      failed++;
      log.fail(`${host} — ${String(e.message || e).split('\n')[0]}`);
    }
  }
} finally {
  try {
    await context.close();
  } catch {
    /* context already gone */
  }
}

if (visited === 0) {
  log.fail(`all ${urls.length} custom website visits failed`);
  throw new Error(`all ${urls.length} custom website visits failed`);
}

log.summary({ claimed: visited, skipped: 0, siteId: 'custom-website', visited, failed, display: 'visited' });