# Publishing @mainspring packages to npm (brain-side runbook)

This covers the **npm registry publish** of all 10 `@mainspring/*` packages
under `packages/`. It is separate from [`publishing.md`](./publishing.md),
which covers pushing the `mainspring` source repo to GitHub — that is a
different action with a different destination (git remote vs. npm registry).

This runbook is written for the brain (the session holding `.env` and
`NPM_TOKEN`) to run from inside a checkout of `mainspring/` on `main`, after
merging this lane's fixes. Nothing here needs to run from inside a
credential-less worker lane, and nothing in this repo contains an npm token.

## Preconditions

- `NPM_TOKEN` is set in the environment (an npm
  [automation or granular access token](https://docs.npmjs.com/creating-and-viewing-access-tokens)
  with **publish** permission for the `@mainspring` scope). Never put the
  token in a file, commit, relay message, or journal — export it in the
  shell for this session only.
- The `@mainspring` scope exists and this token's account/org is a member
  with publish rights. See the fallback section below if the scope is
  already taken by someone else.
- `pnpm -r build && pnpm -r test` is green on the commit being published
  (CI already gates this; re-verify locally if publishing outside CI).
- Corepack's pinned pnpm is available: `corepack enable` (pnpm version is
  pinned in the root `package.json`'s `packageManager` field — currently
  `pnpm@9.15.9`).

## One-command publish

```sh
export NPM_TOKEN=npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
cd mainspring
bash tools/publish-all.sh
```

`tools/publish-all.sh` does everything below in one idempotent pass:
writes a session-scoped `.npmrc` from `$NPM_TOKEN` (never from a literal),
confirms build+test are green, runs `pnpm -r publish --access public
--no-git-checks`, and verifies with `npm view`. It is safe to re-run: pnpm
skips any package version already present on the registry rather than
erroring the whole batch.

## What the script does, spelled out

1. **Auth** — pnpm reads the registry token from `.npmrc`. The script
   writes exactly one line to a git-ignored `.npmrc` in the repo root for
   the duration of the run:
   ```
   //registry.npmjs.org/:_authToken=${NPM_TOKEN}
   ```
   (pnpm/npm resolve `${NPM_TOKEN}` from the environment at read time — the
   literal string, not the value, is what's written to disk.)

2. **Publish order** — dependencies must land on the registry before the
   packages that depend on them, or the dependent's install will fail to
   resolve. The dependency graph here is shallow (one level):
   - `@mainspring/broker` depends on `@mainspring/ledger`
   - `@mainspring/cli` depends on `@mainspring/core`
   - all other packages (`brains`, `core`, `governance`, `ledger`, `memory`,
     `relay`, `schedule`, `scrub`) have no `@mainspring/*` dependencies.

   `pnpm -r publish` already topologically sorts by inter-workspace
   dependencies automatically, so a single recursive command is correct and
   sufficient — no manual per-package ordering is required. (Verified in
   this dry-run: `workspace:*` ranges are rewritten to the real pinned
   version, e.g. `@mainspring/ledger": "workspace:*"` → `"0.1.0"`, in the
   *packed* `package.json` that's actually uploaded — confirmed via `pnpm
   pack` + tarball inspection for both `@mainspring/broker` and
   `@mainspring/cli`.)

   If a single package must be retried by hand (e.g. after fixing that one
   package only), publish leaves-before-dependents manually:
   ```sh
   pnpm --filter @mainspring/ledger publish --access public --no-git-checks
   pnpm --filter @mainspring/broker publish --access public --no-git-checks
   pnpm --filter @mainspring/core publish --access public --no-git-checks
   pnpm --filter @mainspring/cli publish --access public --no-git-checks
   ```

3. **`--access public`** — every `@mainspring/*` `package.json` sets
   `"publishConfig": {"access": "public"}`, so this is redundant with the
   flag but kept for defense in depth (a fresh scoped package with neither
   set defaults to *restricted*, which fails on npm's free tier).

4. **Verify**:
   ```sh
   npm view @mainspring/core version
   ```
   Expect `0.1.0`. Repeat per package, or loop all 10:
   ```sh
   for p in brains broker cli core governance ledger memory relay schedule scrub; do
     printf '%-12s ' "$p"; npm view "@mainspring/$p" version
   done
   ```

5. The script removes the `.npmrc` it wrote when done (success or failure),
   so no token is left on disk after the run.

## Org-name-taken fallback

If `@mainspring` is already registered on npm by an unrelated party (check
with `npm org ls mainspring` or `npm view @mainspring/core` before the
first-ever publish — a 404 on every package name means the scope is free;
an unexpected owner on any one of them means it's taken), the scope must be
renamed before anything can publish. Procedure:

1. Pick a fallback scope (e.g. `@fablerlabs` or `@mainspring-os`) and
   confirm *it* is free the same way.
2. In every `packages/*/package.json`, rename:
   - the top-level `"name"` (e.g. `@mainspring/core` → `@fablerlabs/core`)
   - any `"@mainspring/*"` entry under `"dependencies"` in `broker` (→
     `@mainspring/ledger`) and `cli` (→ `@mainspring/core`) to match.
   - leave `"repository"`, `"homepage"`, `"bugs"` alone — those point at
     the GitHub repo, not the npm scope, and don't need to change.
3. Update `main` field / `bin` field paths: unaffected (they're
   scope-independent relative paths).
4. Re-run `pnpm -r build && pnpm -r test` (a pure rename, should stay
   green), re-run the dry-run (`pnpm -r publish --dry-run --no-git-checks`)
   to sanity-check the new names pack cleanly, then publish for real.
5. Update `README.md` install snippets and any doc referencing the old
   scope (`grep -rn '@mainspring/' --include='*.md'`).
6. Log the rename as a deliberate, one-way decision (like the repo-publish
   runbook's "first-ever publish" step) — anyone who bookmarked the old
   scope name will get a 404.

This is a bigger, one-way change; don't do it speculatively — only if the
scope is confirmed taken.

## What's already been verified (this dry-run, no token needed)

- `pnpm -r build && pnpm -r test`: green, all 10 packages + 4 examples.
- `pnpm -r publish --dry-run --no-git-checks`: all 10 `packages/*` produce
  a tarball; `examples/*` (all `"private": true`) are correctly skipped.
- `pnpm pack` + tarball inspection on `@mainspring/cli` and
  `@mainspring/broker`: packed `package.json` shows real resolved versions
  for `workspace:*` deps, `bin` path resolves and the emitted `dist/bin.js`
  has its `#!/usr/bin/env node` shebang intact, and (after the fix in this
  change) neither package leaks `src/`, `test/`, `dist-test/`, or
  `tsconfig*.json` into the tarball.
- Two real bugs found and fixed by this dry-run (see `RESULT-q77.md` for
  detail): `@mainspring/broker` and `@mainspring/schedule` were missing
  `"files"` (leaking source/test/dist-test into the published tarball,
  ~3x the intended package size) and `"publishConfig": {"access":
  "public"}` (would have attempted a restricted-access publish and failed
  outright on a scope with no paid org plan).
