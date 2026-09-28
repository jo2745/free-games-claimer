// Visit user-configured websites, one isolated browser profile per site.
//
// Every URL configured in Settings → Services → Custom websites (or the
// CUSTOM_URLS env var) becomes its own entry: its own `data/browser-custom-<host>`
// profile, its own login (Sessions tab), and its own session check. That
// isolation is the point — a captcha, block, or stale login on ONE site must
// not poison the shared sessions of the others (each site rides its own
// cookie jar), and the per-site rows let the panel flag exactly which one
// needs re-login.

import { launchContext, gotoWithRetry } from '#src/browser.js';
import { handleSIGINT, log, delay } from '#src/util.js';
import { cfg } from '#src/config.js';
import { getCustomSites, siteVersion } from '#src/sites.js';

// Settle time after page load so the site's daily check-in beacon has
// fired before we move on (most fire within a second; allow for slow CDNs).
const SETTLE_MS = 2000;

handleSIGINT(); // no per-context handler: contexts open/close sequentially
log.section(`Custom websites (v${siteVersion('custom-website')})`);

const all = getCustomSites();
// Per-card "Run" on one Sessions row (extraEnv from the panel): visit only
// the listed site id(s). Full-chain runs set no filter → all configured
// sites. Entries whose URL the user since removed from Settings simply
// aren't visited (they no longer exist in all[]).
const filter = process.env.CUSTOM_SITE_ID
  ? new Set(String(process.env.CUSTOM_SITE_ID).split(',').map(s => s.trim()).filter(Boolean))
  : null;
const sites = filter ? all.filter(s => filter.has(s.id)) : all;

if (!cfg.cw_active) {
  log.warn('Custom websites service is off (Settings → Services) — skipping.');
  process.exit(0);
}
if (!sites.length) {
  log.warn('No custom websites configured — skipping.');
  log.status('hint', 'Add URLs in Settings → Services → Custom websites (or env CUSTOM_URLS), then re-run.');
  process.exit(0);
}

log.status('sites', `${sites.length} (one isolated profile each)`);
log.status('mode', cfg.headless ? 'headless' : `headed${cfg.novnc_port ? ` (noVNC on :${cfg.novnc_port})` : ''}`);

let visited = 0;
let failed = 0;
let failedHosts = [];
for (const site of sites) {
  const { context, page } = await launchContext(site.id, {
    profileDir: site.browserDir, // per-site isolation
    sigint: false, // panel-managed handler above owns SIGINT; one context open at a time
  });
  try {
    try {
      await gotoWithRetry(page, site.url, {
        attempts: 2,
        backoffMs: 2000,
        gotoOpts: { waitUntil: 'domcontentloaded' },
        siteId: site.id,
        label: site.name,
      });
      visited++;
      log.ok(`${site.name} visited`);
      await delay(SETTLE_MS); // let the page's login beacon fire
    } catch (e) {
      // Per-site containment: a captcha-walled, blocked, or unreachable
      // site fails ONLY itself — the remaining sites still run in their
      // own profiles.
      failed++;
      failedHosts.push(site.name);
      log.fail(`${site.name} — ${String(e.message || e).split('\n')[0]}`);
    }
  } finally {
    try {
      await context.close();
    } catch {
      /* context already gone */
    }
  }
}

if (visited === 0) {
  log.fail(`all ${sites.length} custom website visits failed (${failedHosts.join(', ')})`);
  throw new Error(`all ${sites.length} custom website visits failed`);
}

log.summary({
  claimed: visited,
  skipped: 0,
  siteId: 'custom-website',
  visited,
  failed,
  display: 'visited',
});