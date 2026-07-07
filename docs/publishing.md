# Publishing this repo (brain-side checklist)

This file documents how the **brain** (the session that holds `.env` and
owns `tools/`) publishes or refreshes `github.com/fablerlabs/mainspring`.
It is not run from inside this repo — `mainspring/` has no secrets and no
publish scripts of its own, by design (see the worker-lane hard limits: no
side effects, no credentials, ever, from a lane that only writes source).

`mainspring` repurposes the repo previously used for the `brain` snapshot
(`tools/brain-publish.sh`). Unlike `brain`, this repo is a full, real source
tree (not an allowlist/placeholder snapshot) — so the closer template is
`tools/oss-publish.sh`'s history-preserving rsync flow, not `brain-publish.sh`'s
substitution step. Adjust whichever publish script the brain uses to publish
`mainspring/` as-is: no redaction pass, no `.env` substitution, because
nothing under `mainspring/` should ever have contained a secret to begin
with.

## Checklist

1. **Scrub gate first, always.** Run the mandatory pre-publish secret scan
   over the whole tree before anything leaves this box:

   ```sh
   bash tools/scrub-gate.sh --public mainspring/
   ```

   Exit 0 = clean, proceed. Nonzero = findings printed as `file:line:
   reason` — fix and re-run. Never skip or bypass this step for any publish
   path (this is audit rule F2 — see `tools/scrub-gate.sh`'s own header).

2. **History-preserving push**, not a fresh-init force-push. Clone the live
   `fablerlabs/mainspring` repo, overlay it with the current `mainspring/`
   working tree (e.g. `rsync -a --delete --exclude .git mainspring/. <clone>/`),
   commit only if something changed, and push to `main`. Refuse (or require
   an explicit override) if the diff would *delete* files that exist on
   origin but not in the local tree — that usually means someone added
   something directly on GitHub (e.g. a community PR merge, a GitHub Action
   run artifact) that the local snapshot hasn't caught up with yet; sync
   origin → local first rather than silently deleting it.

3. **First-ever publish** (repo currently holds the old `brain` snapshot, or
   is empty): decide explicitly whether this is a repurpose (replace
   `brain`'s content wholesale with `mainspring/`, i.e. the delete guard
   above is expected to fire once and should be overridden deliberately) or
   a fresh repo. Either way, log the decision — this is a one-way door for
   anyone with `brain`'s repo URL bookmarked.

4. **Repo metadata** — set/refresh on every publish:
   - Description: a one-line pitch (see `README.md`'s H1 + tagline for the
     wording to reuse).
   - Homepage: `https://fablerlabs.com`.
   - Topics (GitHub repo topics API,
     `PUT /repos/{owner}/{repo}/topics`):
     ```
     agent-framework, autonomous-agents, ai-business, typescript,
     model-agnostic, mcp
     ```
   - `has_issues: true` (bug/idea templates already ship in
     `.github/ISSUE_TEMPLATE/`), `has_wiki: false`, `private: false`.

5. **Verify CI is green** on the pushed commit before calling the publish
   done — `.github/workflows/ci.yml` runs `pnpm install && pnpm -r build &&
   pnpm -r test` on a Node 20 / 22 matrix. If it's red on a repo that was
   green in this worktree, something about the push (e.g. a `.gitignore`d
   file that CI actually needed) diverged from what was locally verified —
   don't leave it red, and don't paper over it by editing CI to skip the
   failing step.

6. **No publishing steps live in `ci.yml` itself** — it only builds and
   tests. Anything that ships a package (npm publish, a release tag, a
   changelog bump) is a separate, deliberate action this checklist doesn't
   cover yet; add a step here if/when that becomes real.

## What "refresh" looks like on later sessions

Steps 1–2 and 5 again: scrub, history-preserving push of whatever changed
in `mainspring/` since the last publish, confirm CI is green. Steps 3–4
(repurpose decision, topics/description) are one-time unless the repo's
positioning changes.
