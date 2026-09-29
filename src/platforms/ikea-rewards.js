// IKEA Family rewards watcher (logged-in, in-page activity detection).
//
// Visits the country-specific IKEA Family rewards page in its OWN browser
// profile (data/browser-ikea-rewards — isolated from the store logins),
// waits for the client-rendered React app to mount, then scans the DOM
// (main frame + any iframes) for:
//   1. Points balance (the member's current total, if a member)
//   2. Posted activities — the buttons/tiles you tap to EARN points
//      (quizzes, check-ins, card games, challenges — each country's
//      program phrases these differently, so we match a multilingual
//      activity vocabulary, minus the redemption vocabulary, because
//      redeeming *spends* points we're trying to collect)
//
// Diffs against data/ikea-rewards-watch.json and notifies (apprise +
// Alerts tab + post-run session machinery, all via the registry) when:
//   - a NEW activity is posted since the last check
//   - the balance moved since the last check (points landed)
//
// Notify-then-act by design (the project's fragile-UI convention):
// completing an activity is YOUR click in noVNC — the notification
// carries the noVNC deep link (?login=ikea-rewards). We never auto-click
// through IKEA's activity/anti-bot UI: that's how Family accounts get
// flagged, and the client-rendered React DOM would need selector
// reworkes every time IKEA redeploys. The watcher's job is to make sure
// you're never the last to hear about a posted activity.
//
// Login: first run, log in to IKEA Family via the Sessions-row Login
// button (noVNC, incl. 2FA by hand). The session then rides
// data/browser-ikea-rewards across runs and container restarts; if it
// goes stale the standard post-run session check + Alerts tab + Pushover
// deep link handle it like any other service.
//
// The activity/redeem/balance vocabularies are String.raw pattern
// STRINGS at module scope — the single source of truth — and are passed
// into the in-page scan as evaluate() arguments (the in-page context
// can't see module scope, and re-typing the patterns inside the
// in-page function is how the two copies silently diverge; the in-page
// code rebuilds RegExp objects from the passed strings). Same pattern
// as lenovo-gaming's in-frame extraction.

import { launchContext, gotoWithRetry } from '#src/browser.js';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { datetime, notify, log, dataDir, handleSIGINT } from '#src/util.js';
import { cfg } from '#src/config.js';
import { SITES_BY_ID } from '#src/sites.js';

handleSIGINT();
log.section(`IKEA Family rewards (v${SITES_BY_ID['ikea-rewards']?.version || 0})`);

let _summaryStats = { siteId: 'ikea-rewards', claimed: 0, skipped: 0, display: 'onPage', onPage: 0, new: 0 };
process.on('exit', code => {
  if (!code) log.summary(_summaryStats);
});

if (!cfg.ikea_active) {
  log.warn('IKEA Family rewards service is off (Settings → Services) — skipping.');
  process.exit(0);
}

const URL = cfg.ikea_rewards_url;
// Notification tap-target — mirror of the panel's PUBLIC_URL expression
// (panel.js: `cfg.public_url || http://localhost:PANEL_PORT/BASE_PATH`).
// cfg.public_url = PUBLIC_URL env or the Settings `panel.publicUrl`
// field; the localhost fallback only works on same-host deploys — the
// panel already warns about that at boot when PUBLIC_URL is unset.
const PANEL_URL = cfg.public_url || `http://localhost:${Number(process.env.PANEL_PORT) || 7080}${cfg.base_path}`;
const STATE_FILE = dataDir('ikea-rewards-watch.json');

// ── In-page vocabulary (single source of truth) ─────────────────────
// EARN side: activity-CTA verbs/nouns across FI/SE/Nordic/EN.
// REDEEM side: the "spend your points" tiles we must NOT flag —
// redeeming is opt-in (you choose what to spend on), never auto-flagged.
const ACTIVITY_PAT = String.raw`\b(tue|tee|spela|spel|play|quiz|quizz|peli|lotto|arvaus|turnaus|check.?in|challenge|aktivit\w*|activity|aktivitet|aktiviteetti|aktiviteet|aktivita|aktio|kampanj\w*|tapahtuma|toiminto|ülesanne|tehtävä|ufordring|oppdre|aktivität|pistepeli|piste-?peli|piste-?peliä|piste-?peliin)\b`;
const REDEEM_PAT = String.raw`\b(valitse|valitsen|valitset|choose|select|redeem|anna|annan|löydetty|koodi|koodin|voucher|etuu|etun|etuna|benefit|palkinto|palkinnon|prize|prämi|premi|palkinto-?koodi|redeemable|saldo|balance|solde|saldot|pisteesi|piste-?saldo)\b`;
// BALANCE: a short text node holding a number + "piste/points" wording.
// No trailing \b — the in-page scan must also fire on non-ASCII endings
// ("30000 pistettä": \b never matches after a non-ASCII word char in a
// non-unicode regex); the runner takes the max candidate, so a spurious
// "12 pistepeli" tile can't out-rank the real balance.
const BALANCE_PAT = String.raw`(\d[\d\s\u00a0]{0,9})\s*(?:piste|pisteen|pistettä|pisteitä|points|punte|poäng|punct)`;

function loadState() {
  // { state, hadBaseline }: hadBaseline is true only when the file
  // existed AND parsed into a usable object. A missing or corrupt file
  // means "re-baseline, no notifications" — the robust first-run signal
  // (a bare existsSync check misclassifies a corrupt file as "not first
  // run", which turns one bad write into a mass false "new activity"
  // ping storm on the next run).
  if (!existsSync(STATE_FILE)) return { state: { balance: null, activities: {} }, hadBaseline: false };
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (typeof parsed.balance !== 'number' && parsed.balance !== null) parsed.balance = null;
      if (typeof parsed.activities !== 'object' || parsed.activities === null || Array.isArray(parsed.activities)) parsed.activities = {};
      return { state: parsed, hadBaseline: true };
    }
  } catch { /* corrupt ⇒ re-baseline */ }
  return { state: { balance: null, activities: {} }, hadBaseline: false };
}

function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { log.warn(`Failed to save ikea-rewards watch state: ${e.message.split('\n')[0]}`); }
}

let context, page;
try {
  // Own profile: IKEA's login is isolated from the shared store session,
  // per the v2.12.5.2 isolation principle (registry getter resolves it).
  const profileDir = SITES_BY_ID['ikea-rewards']?.browserDir;
  ({ context, page } = await launchContext('ikea-rewards', {
    profileDir,
    record: false,
    sigint: false, // handleSIGINT() above owns SIGINT
  }));
  context.setDefaultTimeout(cfg.debug ? 0 : cfg.timeout);

  log.status('Visiting', URL);
  await gotoWithRetry(page, URL, {
    attempts: 2,
    backoffMs: 5000,
    gotoOpts: { waitUntil: 'domcontentloaded' },
    siteId: 'ikea-rewards',
    label: 'IKEA rewards',
  });
  // The rewards app is client-rendered React: content mounts well after
  // first paint (and an iframe widget may load async). Give it time —
  // a missed mount is a false "no activities" run, which is worse than
  // a 6s sleep.
  await page.waitForTimeout(5000).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

  // Scan the main frame AND any child frames (the loyalty widget may be
  // iframed — main-frame-only scans would see an empty shell). The
  // pattern strings are passed in as evaluate() arguments — the in-page
  // context can't see module scope, so passing them (rather than
  // re-typing them) keeps one copy of the truth.
  const scanArgs = { activityRe: ACTIVITY_PAT, redeemRe: REDEEM_PAT, balanceRe: BALANCE_PAT };
  const scanFrame = async (frame) => frame.evaluate(({ activityRe, redeemRe, balanceRe }) => {
    const ACTIVITY_RE = new RegExp(activityRe, 'i');
    const REDEEM_RE = new RegExp(redeemRe, 'i');
    const BALANCE_RE = new RegExp(balanceRe, 'i');
    const out = { activities: [], balances: [] };
    // Activity candidates: buttons/links/CTA tiles whose text names an
    // earn-action and doesn't name a redeem-action.
    for (const el of document.querySelectorAll('button, a, [role="button"], [role="link"]')) {
      const text = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).trim();
      if (!text || text.length > 80) continue;
      try { if (el.offsetParent === null && getComputedStyle(el).visibility === 'hidden') continue; } catch { continue; }
      if (REDEEM_RE.test(text) || !ACTIVITY_RE.test(text)) continue;
      const fp = 'act:' + text.toLowerCase().replace(/[^a-z0-9åäöü]+/g, ' ').replace(/\s+/g, ' ').trim();
      out.activities.push({ fp, text: text.slice(0, 80) });
    }
    // Balance candidates: short text nodes "N piste/points…". Collect
    // all; the runner takes the largest plausible (the catalog side
    // shows redeem costs — small numbers — while the member balance
    // is the big one, so max picks the balance).
    for (const el of document.querySelectorAll('div, span, p, h1, h2, h3, h4')) {
      const t = (el.textContent || '').trim();
      if (t.length > 120) continue;
      const m = t.match(BALANCE_RE);
      if (m) {
        const n = parseInt(m[1].replace(/[\s\u00a0]/g, ''), 10);
        if (n >= 1 && n < 10_000_000) out.balances.push({ n, text: t.slice(0, 100) });
      }
    }
    return out;
  }, scanArgs);

  const frames = [page.mainFrame(), ...page.frames().filter(f => f !== page.mainFrame())];
  let activities = [];
  let balances = [];
  for (const frame of frames) {
    try {
      const r = await scanFrame(frame);
      if (r) { activities = activities.concat(r.activities || []); balances = balances.concat(r.balances || []); }
    } catch (e) {
      log.warn(`Frame scan failed (${frame.url()?.split('/').slice(1, 2) || 'about:blank'}): ${e.message.split('\n')[0]}`);
    }
  }

  // Dedupe activity candidates by fingerprint (hero tile + list tile may
  // both expose the same CTA).
  const actMap = new Map();
  for (const a of activities) if (!actMap.has(a.fp)) actMap.set(a.fp, a);
  const acts = [...actMap.values()];
  const balance = balances.length
    ? balances.sort((a, b) => b.n - a.n)[0].n // max = the member balance
    : null;

  log.status('Activities on page', acts.length);
  if (balance != null) log.status('Points balance', balance);

  const { state, hadBaseline } = loadState();
  const isFirstRun = !hadBaseline;

  const newActs = [];
  const goneActs = [];
  for (const a of acts) {
    const known = state.activities[a.fp];
    if (!known) newActs.push(a);
    else known.lastSeen = datetime();
    state.activities[a.fp] = {
      text: a.text,
      firstSeen: known?.firstSeen || datetime(),
      lastSeen: datetime(),
    };
  }
  for (const fp of Object.keys(state.activities)) {
    if (!actMap.has(fp)) { goneActs.push(state.activities[fp]); delete state.activities[fp]; }
  }

  const balanceChanged = balance != null && state.balance != null && balance !== state.balance;
  const prevBalance = state.balance;
  state.balance = balance;

  saveState(state);
  _summaryStats = { ..._summaryStats, onPage: acts.length, new: newActs.length };

  // ── Notifications ─────────────────────────────────────────────────
  const lines = [];

  if (isFirstRun) {
    log.info(`Baseline established: ${acts.length} activit${acts.length === 1 ? 'y' : 'ies'} visible${balance != null ? `, balance ${balance}` : ''} (no notifications on first run)`);
    for (const a of newActs) log.info(`${a.text} — visible`);
    process.exit(0);
  }

  if (newActs.length) {
    log.info(`${newActs.length} new IKEA activity(ies) posted`);
    for (const a of newActs) {
      log.game(a.text, 'new — startable');
      lines.push(`IKEA Family: new point activity — ${a.text}`);
    }
  }

  if (balanceChanged) {
    const delta = balance - prevBalance;
    log.info(`Balance ${prevBalance} → ${balance} (${delta >= 0 ? '+' : ''}${delta})`);
    lines.push(`IKEA balance: ${prevBalance} → ${balance} (${delta >= 0 ? '+' : ''}${delta} points)`);
  }

  if (goneActs.length && !balanceChanged && !newActs.length) {
    // Activities the user has (presumably) completed and IKEA removed:
    // say so quietly in the log only — no ping (they earned, they know).
    log.info(`${goneActs.length} activity(ies) completed/removed from the page`);
  }

  if (!newActs.length && !balanceChanged) {
    log.info(`No new activities${balance != null ? `; balance ${balance} unchanged` : '; no balance visible on page'}`);
  }

  if (lines.length) {
    lines.push('');
    lines.push('Complete it in noVNC — open the panel and press Login on the IKEA row, or tap the deep link below.');
    lines.push(`${PANEL_URL}/?login=ikea-rewards`);
    const body = lines.join('<br>');
    await notify(body, { kind: 'action' })
      .catch(err => log.warn(`Notify failed: ${err.message.split('\n')[0]}`));
  }
} catch (error) {
  process.exitCode ||= 1;
  log.exception(error);
  if (cfg.debug) console.error(error);
} finally {
  if (page && page.video()) log.info(`Recorded video — ${await page.video().path()}`);
  if (context) await context.close();
}