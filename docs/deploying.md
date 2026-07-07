# Deploying

`mainspring run` executes exactly one session and exits — it never loops,
schedules itself, or restarts on failure. That's deliberate: session-runner
and supervisor are different trust levels, and Mainspring only ships the
former (see [architecture.md → Known v0.1 gaps](./architecture.md), "No
scheduler"). This doc covers the latter: how to run a Mainspring workspace
unattended, safely, forever.

Everything here is an operator-side pattern, not a Mainspring package. It
generalizes the supervisor a real Mainspring-shaped agent runs under in
production — a plain outer process that knows nothing about Brains or
Actions, and exists only to invoke, watch, and restrain.

## The supervisor model

A supervisor is any process — a cron entry, a systemd timer, a CI schedule —
that wraps `mainspring run` with five responsibilities the agent must never
own for itself:

1. **Invoke on a cadence.** Wake the agent, run one session, let it exit.
   Session length is bounded by the Brain's own step budget
   (`constitution.maxSessionMs` — advisory in v0.1, see
   [roadmap.md](./roadmap.md)); the supervisor's cadence should leave slack
   after that budget, not run sessions back-to-back.
2. **Watch a health file.** After each run, inspect what the session did
   (exit code, `.mainspring/last-session.json`, `summary.blockedReasons`)
   and write the *next* session's `health.json` in the workspace —
   `{ ok, lastSessionFailed, notes }` (see `HealthReport` in
   `packages/core/src/types.ts`). `assemble.ts` reads this file every
   session and puts it in front of the Brain; the Brain can react to its own
   past failures, but only the supervisor may declare one.
3. **Count consecutive failures and back off.** A Brain that fails three
   sessions in a row is a signal to slow down or escalate, not to retry
   faster. Track a counter next to the workspace (outside the repo the
   agent commits to, so a bad commit can't erase its own failure history)
   and widen the cadence or halt after a threshold you choose.
4. **Deliver inbox messages.** `assemble.ts` reads `workspace/inbox/*.json`
   as `OwnerMessage`s. Only the supervisor (or whatever authenticated
   channel it fronts — email, Slack, a ticket queue) should ever write into
   `inbox/`; the agent reads it but must never author its own messages
   there, or "operator guidance" stops meaning anything.
5. **Honor a STOP file.** Mainspring core does not check for one — that
   check belongs to the supervisor, one layer above anything the Brain can
   propose or the gate can veto. Before invoking `mainspring run`, the
   supervisor checks for a `STOP` file (in the workspace, or anywhere
   outside it the agent can't write); if present, it skips the run instead
   of executing it. This is the actual kill switch referenced as a hard
   rule in [writing-a-constitution.md](./writing-a-constitution.md) — a
   constitution can *tell* the Brain to stop, but only something outside
   the Brain's write access can *guarantee* it.

None of this is optional plumbing bolted onto the loop — it's what makes
`assemble → gate → dispatch → commit` (see [architecture.md](./architecture.md))
safe to leave running unattended. The gate stops a single bad Action; the
supervisor stops a bad *pattern* across sessions.

`@mainspring/schedule` — a first-party package for this — isn't on `main`
yet. Until it ships, the three recipes below are the reference
implementation; treat the scripts as a starting point to adapt, not
something to run verbatim in production without reading them.

## Recipe 1 — cron

Simplest option, good for a single VPS. `supervisor.sh` lives outside the
workspace's own git history (e.g. in the operator's home directory), so the
agent can never edit the thing that decides whether it runs:

```bash
#!/usr/bin/env bash
# supervisor.sh — invoked by cron, not part of the workspace repo.
set -euo pipefail

WORKSPACE="/srv/myagent/workspace"
FAILCOUNT_FILE="/srv/myagent/state/failcount"
LOG="/srv/myagent/logs/$(date -u +%Y-%m-%d).log"

mkdir -p "$(dirname "$LOG")" "$(dirname "$FAILCOUNT_FILE")"

if [ -f "$WORKSPACE/STOP" ] || [ -f "/srv/myagent/STOP" ]; then
  echo "$(date -u -Iseconds) STOP present, skipping run" >> "$LOG"
  exit 0
fi

failcount=0
[ -f "$FAILCOUNT_FILE" ] && failcount=$(cat "$FAILCOUNT_FILE")
if [ "$failcount" -ge 3 ]; then
  echo "$(date -u -Iseconds) $failcount consecutive failures, halting until a human clears $FAILCOUNT_FILE" >> "$LOG"
  exit 1
fi

# Secrets are exported by the operator's own shell profile / secret manager
# below (see "Secrets" section) — never read from a file inside $WORKSPACE.

cd "$WORKSPACE"
if node ../mainspring/packages/cli/dist/bin.js run >> "$LOG" 2>&1; then
  echo 0 > "$FAILCOUNT_FILE"
  cat > "$WORKSPACE/health.json" <<'EOF'
{"ok": true, "lastSessionFailed": false, "notes": []}
EOF
else
  failcount=$((failcount + 1))
  echo "$failcount" > "$FAILCOUNT_FILE"
  cat > "$WORKSPACE/health.json" <<EOF
{"ok": false, "lastSessionFailed": true, "notes": ["session failed, consecutive failures: $failcount"]}
EOF
fi
```

```cron
# crontab -e (as the dedicated agent user, never root)
*/30 * * * * /srv/myagent/supervisor.sh
```

## Recipe 2 — systemd timer + service

Preferred on a VPS you already manage with systemd: you get structured
logs (`journalctl`), a real exit-code contract, and `User=`/`ProtectSystem=`
sandboxing for free.

`/etc/systemd/system/mainspring-agent.service` (root-owned, the agent
cannot edit this):

```ini
[Unit]
Description=Mainspring agent session
After=network-online.target

[Service]
Type=oneshot
User=agent
Group=agent
WorkingDirectory=/srv/myagent/workspace
EnvironmentFile=/etc/mainspring-agent/env      # root-owned, 0600 — see "Secrets"
ExecStartPre=/usr/bin/test ! -f /srv/myagent/workspace/STOP
ExecStartPre=/usr/bin/test ! -f /srv/myagent/STOP
ExecStart=/usr/bin/node /srv/myagent/mainspring/packages/cli/dist/bin.js run
# Filesystem sandboxing: the process can write only its own workspace.
ProtectSystem=strict
ReadWritePaths=/srv/myagent/workspace
NoNewPrivileges=true
ProtectHome=true
```

`/etc/systemd/system/mainspring-agent.timer`:

```ini
[Unit]
Description=Run the Mainspring agent every 30 minutes

[Timer]
OnCalendar=*:0/30
Persistent=true
AccuracySec=1min

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now mainspring-agent.timer
journalctl -u mainspring-agent.service -f   # tail live sessions
```

Failure counting and `health.json` writing move into a small
`ExecStartPost=` wrapper script (same shape as the cron recipe's tail end)
if you want them, or into a separate `OnFailure=` unit that runs only when
`ExecStart` exits non-zero — systemd already gives you that hook natively,
which cron doesn't.

## Recipe 3 — GitHub Actions schedule

No VPS at all: the workspace repo (private) hosts its own supervisor via a
scheduled workflow. Good for validating a business idea before provisioning
any infrastructure — the tradeoff is GitHub's schedule is best-effort (can
slip under load) and every run is a fresh, stateless container, so anything
not committed to the workspace repo by the previous session is gone.

`.github/workflows/agent.yml` (in the *workspace* repo, not this one):

```yaml
name: mainspring-agent
on:
  schedule:
    - cron: "0,30 * * * *"   # every 30 minutes
  workflow_dispatch: {}       # manual run button, for an operator

concurrency:
  group: mainspring-agent
  cancel-in-progress: false   # never cancel a session mid-write

jobs:
  run:
    runs-on: ubuntu-latest
    if: ${{ !contains(github.event.head_commit.message, '[stop]') }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Honor STOP file
        run: |
          if [ -f STOP ]; then
            echo "STOP present, skipping session"
            exit 0
          fi

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install mainspring
        run: npm install --no-save @mainspring/core @mainspring/cli

      - name: Run one session
        env:
          # Secrets come from the repo's own Settings -> Secrets and
          # variables -> Actions, injected as env vars at runtime.
          # Never echo these, never write them into a workspace file.
          BRAIN_API_KEY: ${{ secrets.BRAIN_API_KEY }}
        run: npx mainspring run

      - name: Commit and push session output
        run: |
          git config user.name "mainspring-agent"
          git config user.email "agent@users.noreply.github.com"
          git add -A
          git diff --staged --quiet || git commit -m "session: $(date -u -Iseconds)"
          git push
```

Two things this recipe cannot give you that the first two can: a
human-owned kill switch that acts *instantly* (a `STOP` file only takes
effect on the next scheduled tick — commit one and it's honored next run,
but there's no live process to signal), and a place to enforce filesystem
sandboxing (`ProtectSystem=strict` has no GitHub Actions equivalent — you're
trusting the ephemeral runner's own isolation). Treat it as a fast way to
validate, not the long-term home for anything handling real money.

## Secrets

All three recipes share one rule: **secrets live in the host's own secret
store, never in the workspace repo the agent commits to.**

- Cron / systemd: an `EnvironmentFile=`/shell-profile export owned by root
  or a separate deploy user, mode `0600`, outside the workspace directory
  the agent has write access to.
- GitHub Actions: repository or environment **Secrets**, injected as env
  vars for the one step that needs them.

This isn't just hygiene — it's structural. `SessionInput` (what a Brain
actually sees, see [architecture.md](./architecture.md)) never contains a
secret by construction, and `gate.ts` pattern-blocks secret-shaped content
on any `write`/`notify` Action as a second line of defense. A secret that
never enters the workspace can't leak through either the Brain's reasoning
or a compromised Action — the supervisor injecting it directly into the
process environment, outside any file the agent reads or writes, is what
keeps that guarantee true in production.

## Privilege separation

Everything above enforces one invariant: **the process running
`mainspring run` must not be the process that can change the rules
`mainspring run` operates under.**

Concretely:

- The agent's OS user (or CI job identity) owns the workspace directory —
  `STATE.md`, `journal/`, `LEDGER.csv`, `inbox/` (read), `queue/` — and
  nothing else.
- The supervisor, the `STOP` file's location (when it lives outside the
  workspace), the systemd units / cron table / Actions workflow YAML, and
  any secret store are owned by a *different* identity: root, a separate
  deploy user, or a repo setting the agent's token can't touch. This
  mirrors the split this repo's own runtime constitution documents — "a
  root-owned supervisor... which you must never modify or work around" —
  generalized to any Mainspring workspace.
- Inside the loop itself, the same split holds one level down: a Brain
  proposes `Action`s but never executes one directly (see
  [architecture.md → The trust boundary](./architecture.md)); `gate.ts` and,
  where a workspace wires it in, `@mainspring/governance`'s rule set are the
  only code paths that can veto or allow. A Brain that's been argued into
  proposing something the Constitution forbids still can't make it happen.

`@mainspring/governance` ships today as a standalone, tested package
(constitution-as-code: hard rules loaded from `CONSTITUTION.md`, evaluated
as `allow`/`block`/`escalate` against an `Action`) — see
[`packages/governance`](../packages/governance). It is not yet called by
`core`'s built-in `gate.ts` (see the Packages table in
[README.md](../README.md)); a workspace that wants its `CONSTITUTION.md`
hard rules enforced as code today should call
`@mainspring/governance`'s `evaluate()` from its own `mainspring.config.ts`
wiring, ahead of or alongside `gate.ts`, until that integration lands.

## The credential-broker pattern (planned)

The privilege split above still leaves one gap: a Brain that's allowed to
propose a `ledger` expense Action needs *something* to turn an approved
expense into an actual payment, without ever holding the payment method
itself. The intended shape, per [roadmap.md → v0.3](./roadmap.md):

- The Brain proposes; it never sees a card number, an API key for a payment
  processor, or any credential capable of moving money on its own.
- `gate.ts` (or `@mainspring/governance`'s spend-cap rule) rejects any
  expense that would cross the Constitution's `moneyCaps` *before* anything
  downstream sees it — the cap is enforced structurally, not by trusting
  the broker to check.
- A small, separately-deployed **broker** — code the agent cannot edit,
  running with its own credentials the agent never touches — takes an
  already-gate-approved `ledger` expense and executes the real charge
  against a capped payment method, then reports the result back into the
  workspace (a `ledger` entry, a journal note) the same way any other
  dispatch write lands.

This is the same privilege-separation shape as the supervisor: the
component that can spend money is not the component that decides what's
worth spending on, and it's not reachable from anything the Brain writes.
As of this doc, the broker itself is **not shipped** — `@mainspring/relay`
(Phase 1, see [README.md](../README.md)) is the closest existing piece,
and covers the human-approval leg (`relay` Actions reaching a person) but
not an automated payment execution leg. Until a broker package exists,
treat any real spend as something a `relay` Action routes to a human
operator, not something a Brain-adjacent process executes automatically.

## What's Phase 1 here, honestly

- The three recipes above are real, operator-side patterns — not Mainspring
  code, and not covered by this repo's test suite. Adapt them; don't
  copy-paste into production without reading what they do.
- `health.json` and `STOP` are **read** by `assemble.ts` today
  (`packages/core/src/assemble.ts`) but **written by nothing in this repo**
  — populating them is entirely the supervisor's job, as shown above.
- `@mainspring/governance` and `@mainspring/relay` are real, standalone,
  tested packages a workspace can wire in today, but neither is called
  automatically by `core`'s reference loop yet (see the Packages table in
  [README.md](../README.md)).
- The credential broker described above is a v0.3 roadmap item, not code
  that exists. Nothing in this doc should be read as "already enforced
  automatically" for spend — the gate's money caps (v0.1, shipped) are the
  only automatic enforcement today.
