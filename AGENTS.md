# AGENTS.md — instructions for local coding agents

This repo is a local clone of **jo2745/free-games-claimer** — a fork of `feldorn/free-games-claimer`
(which is itself a fork of the dormant `vogler/free-games-claimer`). The **feldorn** remote is the
active mainline; it is the only source of new fixes and features.

## Remotes

| Remote | Repo | Role |
|---|---|---|
| `origin` | `git@github.com:jo2745` — **this repo** | All agent work pushes here |
| `feldorn` | `https://github.com/feldorn/free-games-claimer` | Upstream mainline — fetch-only, never push |

## Update loop (when the mainline has moved)

1. `git fetch feldorn`
2. `git checkout main && git merge feldorn/main` — expected conflict sites: `CHANGELOG.md`
   (mainline sections on top, this fork's four-part sections below), `README.md`, `package.json`,
   `src/sites.js` (unioned imports), `src/panel/panel.js` (import line + claim-command helper).
   Resolve: take mainline where it's newer, re-add this fork's rows (custom websites, IKEA) on top.
   **`CLAUDE.md` comes back from every upstream merge — `git rm CLAUDE.md` in each sync.**
   This repo uses AGENTS.md instead.
3. `node --check` every changed `.js` file before committing (merge artifacts like duplicate
   imports only show up there).
4. `git push origin main`
5. GHCR: this fork's CI builds `ghcr.io/jo2745/free-games-claimer`; `:latest` is applied **only on
   default-branch (main) pushes**. A four-part fork tag (`vX.Y.Z.W`) doesn't apply `:latest`
   (not semver, not a branch) — so **after pushing any fork tag, bump main again** (docs-only is
   fine) or self-hosters' `:latest` pull fails with `manifest unknown`.
6. Container: the live fgc container runs on the user's box — its docker daemon is not reachable
   from this box. The user does the image pull + restart; the agent asks rather than assumes.

## Fork-local additions (not in the mainline)

- **Custom websites** — `src/platforms/custom-website.js` + `src/sites.js` registry entry: visit
  user-defined URLs on every run, each URL on its own isolated browser profile, per-site Sessions
  rows + logins. The runner also **scrubs the page's displayed points after the 10s settle** (the balance only reflects the new check-in once the site's beacon has fired — scrape pre-settle and you read yesterday's total)
  (`SITE_BALANCE_SELECTORS` map in the runner — per-host CSS path, currently digitalcore.club's
  `#statusBox` tile) and persists it to `data/custom-balances.json`; the panel reads that file on
  every state poll and shows `Balance N` on the per-site Sessions cards (read it there, not from
  the run marker, so the value survives panel restarts).

- **IKEA Family rewards watcher** — `src/platforms/ikea-rewards.js` + `urlLocale()` in `src/util.js`
  (browser language pinned to the page's locale).
  **Setup (user-side, in the panel):** ① Settings → Services → IKEA Family Rewards → active = on
  (or `IKEA_ACTIVE=1`); ② pick a country preset (20 verified URLs) or a custom rewards URL in the
  same accordion; ③ one-time login: press **Login** on the IKEA row in Sessions (noVNC, 2FA by
  hand). The session then rides `data/browser-ikea-rewards` across runs/restarts; a stale session is
  detected in-run (sign-in CTA guard) and post-run (registry `checkLogin`) — re-login via noVNC.
  The runner no-ops (clean exit, state file untouched) until the URL is set / session is live.
- The four-part CHANGELOG sections (2.12.5.1 – 2.12.5.4) document them; the pre-merge fork line is
  the old `origin/main` tip (491bd4a) — recoverable any time via `git fetch origin`.

## Versioning & changelog

- Version is single-sourced in `package.json` (inherited from mainline: 2.12.33 at sync time).
- Four-part tags `vX.Y.Z.W` mark fork-local changes; mainline syncs keep the plain version.
- Every user-visible change gets a CHANGELOG entry; fork-local ones use `## What's new in X.Y.Z.W`.

## Landmines (curated — full list lives in feldorn's CLAUDE.md on GitHub)

- **`PANEL_HTML` is a giant backtick template literal** — regex escapes inside it must be doubled
  (`\\d`, `\\/`); a bare backtick in the body ends the template and Node crashes at import.
- **`evaluate()` in-page copies of regexes drift from module-scope copies** — pass pattern strings
  as `evaluate()` args (`new RegExp(arg, 'i')` in-page); one copy of the truth.
- **Client JS inside PANEL_HTML is invisible to `node --check`** — after panel edits, cook the
  template and syntax-check the cooked `<script>` block (the "cooking test").
- **ESM cycle `config.js`↔`util.js`: import util before config** — `cfg` is a plain export (TDZ).
- **Panel `cfg` is a module-load snapshot** — live reads go through `describeConfig().effective`;
  subprocesses are fine (fresh process = fresh `cfg`).
- **Post-click `disabled` is a loading spinner, not success** — never a post-click success signal
  (Epic CTA path).
- **Playwright error strings are comma-list literals** (`Target page, context or browser has been
  closed`) — match the literal, not alternations.
- **No hot-patching** — the flow is edit → commit → `git push origin main` → GHCR build (~10–12 min)
  → user pulls `:latest`. `docker cp` on the live container wouldn't reload the panel anyway.
- **Stale MS WAM session** — the public `rewards.bing.com` root loads, but the msal-protected
  `/dashboard` bounces to `login.live.com/oauth20_authorize.srf` (PKCE consent). `microsoft.js`
  probes `/dashboard` (`probeDashboardAuth`), re-auths via the consent **Allow** click, and
  fast-bails `readPointsBalance` on a login-domain URL. Don't "simplify" the probe away — the
  public-root `isLoggedIn` check can't see this failure mode (it's how MS Rewards went to 0
  points with a valid-looking session).