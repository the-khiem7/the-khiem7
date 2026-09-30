# AGENTS.md

GitHub profile repository (`the-khiem7/the-khiem7`). `README.md` is the public profile page. A daily workflow keeps the Credly badge block inside it current.

## Daily workflow

1. `.github/workflows/update-credly-badges.yml` runs at 01:00 UTC, or on manual dispatch.
2. It runs the tests, then `scripts/update-credly-badges.mjs`.
3. The script fetches public badges from Credly (profile badges plus externally uploaded badges) and rewrites the block between the `credly-badges` markers in `README.md`.
4. If `README.md` changed, the bot commits `chore: update Credly badges` and pushes. If not, the job ends without a commit.

A README diff after a run is normal whenever Credly data changed (new certification, new badge image, removed badge).

## Layout

| Path | Purpose |
|---|---|
| `README.md` | Profile page. Hand-written, except the block between the `credly-badges` markers |
| `banner/` | Images referenced by the README |
| `scripts/update-credly-badges.mjs` | Badge sync script |
| `scripts/update-credly-badges.test.mjs` | `node:test` tests for the script's pure functions |
| `.github/workflows/update-credly-badges.yml` | The daily job |
| `.github/dependabot.yml` | Weekly updates for the pinned actions |

## README rules

- Never edit between `<!-- credly-badges:start -->` and `<!-- credly-badges:end -->` by hand. The next run overwrites it.
- Keep both markers. The script throws when either is missing.
- Everything outside the markers is hand-written. Do not reformat it.

## Sync script

- Node 22, ES modules, Node built-ins only. No `package.json`.
- Required env: `CREDLY_PROFILE_URL`, `CREDLY_USER_ID`. They are set in the workflow; the script has no defaults and fails when they are missing.
- Optional env: `CREDLY_BADGE_LIMIT` (0 = no limit), `CREDLY_BADGES_PER_ROW` (default 4), `CREDLY_BADGE_FILTER` (case-insensitive name substring). Invalid or zero values fall back to the default. Set them as repository variables, not in code.
- Sections in the output, in order: rule sections from `CREDENTIAL_SECTIONS` (currently "AWS Certified"), one "<Issuer> Certified" section per external-badge issuer, then "Other Credentials". The filter and limit affect only "Other Credentials".
- A highlighted credential type is a rule in `CREDENTIAL_SECTIONS`: `title`, `match(badge)`, optional `imageWidth` and `centered`. A badge goes to the first matching rule.
- Only `https://images.credly.com/` images and `https` badge URLs are accepted, because the output is raw HTML in a public README. Keep that check.
- Local run: `CREDLY_PROFILE_URL=<url> CREDLY_USER_ID=<id> README_PATH=<copy of README> node scripts/update-credly-badges.mjs`. Point `README_PATH` at a copy to leave the real README untouched.
- Tests: `node --test "scripts/*.test.mjs"` (the glob is required). Run them after any change to the script.

## Workflow rules

- Actions are pinned by full commit SHA with the version in a trailing comment. Dependabot proposes bumps. Keep new actions pinned the same way, because the job has `contents: write`.
- Keep `concurrency` so a manual run cannot race the cron run on `git push`, and keep `timeout-minutes`.
- No third-party auto-commit actions. The commit step is plain shell.
- No secrets are needed. The job uses the default `GITHUB_TOKEN`.

## Failures

| Symptom | Meaning |
|---|---|
| `CREDLY_PROFILE_URL and CREDLY_USER_ID are required.` | Env missing from the workflow step |
| `Missing <!-- credly-badges:start --> or ...` | A marker was removed from `README.md` |
| `No public badges found from the Credly profile.` | Both Credly endpoints returned nothing usable; check the profile is public |
| `Credly request failed with HTTP <status>` | Credly error after retries; rerun later, do not edit around it |

## Commits

- Conventional Commits, as in history: `feat:`, `fix:`, `chore:`, `docs(readme):`, `refactor(readme):`.
- One logical change per commit.
