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
// Per-host display style for the balance string — a comma in a short
// number is ambiguous ("46,50" is 46.50 on digitalcore, 4,650 in US
// grouping) and no parser resolves it from the string alone; the owner
// knows, the parser doesn't. Pin a host's style here when its display
// differs from the tail-width fallback ('decimal-comma' | 'thousands-comma'
// | 'plain-int'; omitted = fallback heuristic).
const SITE_BALANCE_STYLES = {
  // digitalcore.club: fractional points, decimal-comma display — "46,50"
  // means 46.50 (owner-verified against the site, 2026-11-09; the old
  // thousands-read reported 4650, 100× off).
  'digitalcore.club': 'decimal-comma',
};
const BALANCES_FILE = dataDir('custom-balances.json');
// Numeric text → integer balance. The in-page scan returns RAW text
// (module scope = the single copy of the parse; the in-page context can't
// see it). `style` (per host, SITE_BALANCE_STYLES) pins the ambiguous
// separator: 'decimal-comma' — first chunk is the integer part, the
// fraction FLOORS ("46,50" → 46; a 0,5 fraction must not round up to
// 47 — digitalcore's points are fractional); 'thousands-comma' — merge
// all chunks ("1,234" → 1234); 'plain-int' — merge and strip (legacy).
// No style = tail-width fallback: 3-digit tail = thousands separator, 1–2
// digits = decimal tail ("46,50" → 46) — correct when the site matches,
// wrong when it doesn't, which is why the raw text is logged next to the
// number so a mismatch is visible at a glance.
function parseBalanceText(text, style) {
  const parts = String(text ?? '').trim().split(/[.,\s\u00a0]+/).filter(p => /^\d+$/.test(p));
  if (!parts.length) return null;
  const first = parseInt(parts[0], 10);
  if (style === 'decimal-comma') {
    return Number.isFinite(first) && first > 0 ? first : null;
  }
  if (style === 'thousands-comma') {
    const n = parseInt(parts.join(''), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (style === 'plain-int') {
    const n = parseInt(parts[0].concat(parts.slice(1).join('')), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (parts.length === 1) return Number.isFinite(first) && first > 0 ? first : null;
  if (parts[parts.length - 1].length === 3) {
    const n = parseInt(parts.join(''), 10); // "1 234" / "1.234.567"
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return Number.isFinite(first) && first > 0 ? first : null;
}

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
          // In-page: return the text of every LEAF (element-leaf) node,
          // tagged with visibility. Sites render the same value in several
          // sibling nodes with DIFFERENT formatting (digitalcore: a hidden
          // US-grouped "4,650" next to the visible "46,50") — only the
          // visible ones are what's actually displayed.
          const candidates = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const leaves = [...el.querySelectorAll('*')].filter(n => !n.querySelector('*'));
            return leaves
              .map(n => ({ text: (n.textContent || '').trim(), visible: !!n.offsetParent }))
              .filter(x => x.text);
          }, selector).catch(() => null);
          // Visible text wins; if the page shows several distinct
          // renderings, log the mismatch — the owner's eye settles it
          // (the raw strings are right there in the log line below).
          let text = null;
          if (candidates && candidates.length) {
            const pool = candidates.filter(c => c.visible);
            const src = pool.length ? pool : candidates;
            const uniq = [...new Set(src.map(c => c.text))];
            text = uniq[0];
            if (uniq.length > 1) log.warn(`balance display mismatch on ${site.name}: ${uniq.map(t => `"${t}"`).join(', ')}`);
          }
          if (text) balance = parseBalanceText(text, SITE_BALANCE_STYLES[host] || null);
          if (balance != null) {
            // Raw page text next to the parsed value: the display is
            // ambiguous, so a mismatch with the owner's actual balance
            // is obvious at a glance — fix the host's style in
            // SITE_BALANCE_STYLES, not the heuristic.
            log.status('balance', `${balance.toLocaleString('en-US')} (page: "${text}")`);
            balances[site.id] = { url: site.url, balance, at: datetime(), raw: text };
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