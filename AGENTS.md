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
  rows + logins.
- **IKEA Family rewards watcher** — `src/platforms/ikea-rewards.js` + `urlLocale()` in `src/util.js`
  (browser language pinned to the page's locale).
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