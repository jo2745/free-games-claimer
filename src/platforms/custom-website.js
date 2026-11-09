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
import { handleSIGINT, log, delay, datetime, dataDir } from '#src/util.js';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { cfg } from '#src/config.js';
import { getCustomSites, siteVersion } from '#src/sites.js';

// ── Balance scrape (fork-local) ─────────────────────────────────────
// Some visited sites display the account's current points on the page
// (digitalcore.club's status box). Scrubbing it during the visit gives
// proof the check-in actually landed — the Sessions card shows the
// balance, not just "the page loaded". Per-host selector map: ID-anchored
// paths survive class reorgs; add a site's balance node here (CSS path)
// and it gets scrubbed on every visit. Selector strings are passed into
// the in-page evaluate as args — one copy of the truth (the in-page
// context can't see module scope).
const SITE_BALANCE_SELECTORS = {
  // digitalcore.club status box, 4th tile (user-provided 2026-10).
  'digitalcore.club': '#statusBox > div > div:nth-child(4) > span:nth-child(1) > span',
};
const BALANCES_FILE = dataDir('custom-balances.json');

// Settle time after page load so the site's daily check-in beacon has
// fired before we move on. 10s (fork-local; upstream ships 2s) — some
// beacons (digitalcore.club) only post their token after a longer client
// init window, and the extra dwell costs nothing (one page, one wait).
const SETTLE_MS = 10_000;

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

// Persisted per-site balances the panel's Sessions cards display
// ({ [siteId]: { url, balance, at } }).
function loadBalances() {
  if (!existsSync(BALANCES_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(BALANCES_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
let balances = loadBalances();
function saveBalances() {
  try { writeFileSync(BALANCES_FILE, JSON.stringify(balances, null, 2) + '\n'); }
  catch (e) { log.warn(`Failed to save custom-balances.json: ${String(e.message).split('\n')[0]}`); }
}

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
      await delay(SETTLE_MS); // let the page's login beacon fire first —
      // the displayed balance only reflects the new check-in AFTER it
      // posts; scraping pre-settle would read yesterday's total
      // Balance scrape (fork-local): if the page displays the account's
      // points, scrub it now (freshest post-beacon value) and persist it
      // for the panel's Sessions cards.
      let balance = null;
      try {
        const host = new URL(site.url).host;
        const selector = SITE_BALANCE_SELECTORS[host];
        if (selector) {
          balance = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const n = parseInt((el.textContent || '').replace(/[^\d]/g, ''), 10);
            return Number.isFinite(n) && n > 0 ? n : null;
          }, selector).catch(() => null);
          if (balance != null) {
            log.status('balance', balance.toLocaleString('en-US'));
            balances[site.id] = { url: site.url, balance, at: datetime() };
            saveBalances();
          }
        }
      } catch (e) {
        log.warn(`Balance scrape failed for ${site.name}: ${String(e.message || e).split('\n')[0]}`);
      }
      // Per-site run marker (fork-local): the panel records one
      // lastRunSuccess entry per configured site, so the Sessions grid
      // shows each custom site's own last-success instead of the parent
      // 'custom-website' id the Sessions cards are keyed by.
      console.log(`  [run] service=${site.id} ok visited=1` + (balance != null ? ` balance=${balance}` : ''));
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