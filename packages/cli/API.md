# @mainspring/cli

This package exports no JS API — `src/index.ts` is empty. Its only public
surface is the `mainspring` binary (`package.json` `bin.mainspring` ->
`dist/bin.js`), which inits, runs, inspects, and health-checks a workspace
built on `@mainspring/core`.

## Commands

### `mainspring init <dir> [--name "My Business"] [--brain echo]`

Scaffolds a new workspace by copying `templates/default` (resolved relative
to the installed package, four directories up from `dist/commands/init.js`)
into `<dir>`.

- **`<dir>`** (required positional): target directory, resolved relative to
  `process.cwd()`. If missing, prints
  `Usage: mainspring init <dir> [--name "My Business"] [--brain echo]`
  to stderr and exits `1`.
- **`--name <string>`**: business name substituted for the `{{BUSINESS_NAME}}`
  token in the copied `CONSTITUTION.md`, `STATE.md`, and `mainspring.config.ts`.
  Also slugified (lowercased, non-`[a-z0-9-]` runs collapsed to `-`, leading/
  trailing `-` trimmed, falling back to `"mainspring-business"` if empty) and
  substituted for `{{BUSINESS_SLUG}}` in `package.json`. Defaults to `<dir>`.
- **`--brain <string>`**: only `echo` is implemented in this skeleton. Any
  other value (or omitting the flag, which defaults to `echo`) still
  scaffolds normally, but passing something other than `echo` explicitly
  prints a warning to stderr: `Only --brain echo ships in this skeleton.
  Implement a custom Brain and edit mainspring.config.ts after init.` and
  proceeds anyway (this does not change the exit code).
- **`--force`**: if `<dir>` already exists and is non-empty, init refuses
  unless `--force` is passed, printing
  `<dir> already exists and is not empty. Pass --force to init into it anyway.`
  to stderr and exiting `1`.
- If the bundled template directory can't be found (a broken install), prints
  `Could not find the default template at <path>. Is @mainspring/cli
  installed correctly?` to stderr and exits `1`.

**Exit codes**: `0` on success; `1` if the directory arg is missing, the
target directory is non-empty without `--force`, or the template can't be
located.

**Example**

```
$ mainspring init ./my-business --name "My Business"
Initialized a Mainspring workspace "My Business" at /home/user/my-business
Next steps:
  cd ./my-business
  pnpm add @mainspring/core   # or npm/yarn — links the workspace's Brain runtime
  mainspring run
```

### `mainspring run [--workspace .] [--no-commit]`

Loads `mainspring.config.ts` from the workspace and runs one session of the
agent loop via `@mainspring/core`'s `runSession`, then prints a summary.

- **`--workspace <dir>`**: workspace directory to run in; defaults to `.`
  (resolved relative to `process.cwd()`).
- **`--no-commit`**: when this flag is present, `commit` is passed as `false`
  to `runSession` (the workspace is not committed after the session).
  Omitting it means the session commits (the default).
- Requires `mainspring.config.ts` to exist and load; if it doesn't, the
  underlying error (`No mainspring.config.ts found in <dir>. Run "mainspring
  init" first.` or a module-resolution/type error) propagates up through
  `bin.ts`'s top-level `.catch`, is printed to stderr, and the process exits
  with code `1`.

**Exit codes**: `0` on a successful session; `1` if config loading or the
session itself throws.

**Example** (against a freshly-initialized workspace using the default
`EchoBrain`)

```
$ mainspring run --workspace ./my-business
Session done in 1 step(s).
  actions proposed: 1
  actions allowed:  1
  actions blocked:  0
  spent this session: $0.00
```

If any actions were blocked by the constitution's money caps or hard rules,
a `blocked reasons:` block lists each `decision.reason` on its own bullet
line before the `spent this session` line.

### `mainspring status [--workspace .]`

Read-only snapshot of a workspace: the configured Brain, the trailing
balance from `LEDGER.csv`, and the `STATE.md` title plus latest session-log
entry. Touches no network and mutates nothing; every source is optional and
degrades to a `WARN` line instead of crashing.

- **`--workspace <dir>`**: workspace to inspect; defaults to `.`.
- Prints a header line `mainspring status — <workspaceDir>`, then three
  fields:
  - **`Brain:`** — `<brain.id> (<brain.model>)` if `mainspring.config.ts`
    loaded and has a `brain`; otherwise
    `WARN — mainspring.config.ts did not load (<first line of error>)`.
  - **`Balance:`** — `$<balance.toFixed(2)>  (<N> ledger entries|entry)` read
    from the last data row's trailing column of `LEDGER.csv` (handles both
    `...,amount,balance` and `...,amount_usd,balance_usd` header shapes, and
    quoted CSV fields with embedded commas). If `LEDGER.csv` is missing:
    `WARN — no LEDGER.csv yet — created on first \`mainspring run\``. A
    header-only (no data rows) ledger reports `$0.00 (0 ledger entries)`
    with no warning. If the last balance column isn't a finite number:
    `WARN — LEDGER.csv present but last balance is unreadable ("<value>")`.
  - **`State:`** — the first `#`-heading line of `STATE.md` as the title,
    plus `  ·  latest: <heading>` from the last `###`-heading line if one
    exists. If `STATE.md` is missing:
    `WARN — no STATE.md yet — run \`mainspring init\` to scaffold one`. If
    present but has no `#` title: `WARN — STATE.md present but has no \`#\`
    title heading`.
- Never sets a failing exit code, even when every field is `WARN` — status
  is diagnostic, not a gate.

**Exit codes**: always `0`.

**Example** (healthy workspace, one ledger entry)

```
$ mainspring status --workspace ./my-business
mainspring status — /home/user/my-business

  Brain:    echo (echo-v1)
  Balance:  $24.00  (2 ledger entries)
  State:    STATE — Money Co  ·  latest: Day 1
```

**Example** (brand-new/degraded workspace)

```
$ mainspring status --workspace ./empty-dir
mainspring status — /home/user/empty-dir

  Brain:    WARN — mainspring.config.ts did not load (No mainspring.config.ts found in /home/user/empty-dir. Run "mainspring init" first.)
  Balance:  WARN — no LEDGER.csv yet — created on first `mainspring run`
  State:    WARN — no STATE.md yet — run `mainspring init` to scaffold one
```

### `mainspring doctor [--workspace .]`

The first command a new user should run: checks whether a workspace is
runnable, without touching the network, spending anything, or mutating
state. Prints `mainspring doctor — <workspaceDir>`, then one line per check
in the form `  <PASS|WARN|FAIL>  <name> — <detail>`, followed by a summary
line.

Checks performed, in order:

1. **`node >= 18`** — `PASS` if `process.versions.node`'s major version is
   `>= 18`, else `FAIL`. Detail is the running node version.
2. **`git available`** — `PASS` (with `git --version` output) if `git` is on
   `PATH`; otherwise `WARN` (`git not found — \`run\` can't auto-commit; use
   --no-commit`) — not fatal, since `mainspring run --no-commit` doesn't
   need git.
3. **`CONSTITUTION.md present`** — `FAIL` if missing (`not found in
   workspace`), else `PASS`.
4. **`STATE.md present`** — `FAIL` if missing, else `PASS`.
5. **`LEDGER.csv present`** — `WARN` if missing (`not found — created on
   first \`mainspring run\``), else `PASS` — not fatal, since it's created by
   the first `run`.
6. **`mainspring.config.ts loads`** — `PASS` (detail: `constitution
   "<name>"`) if `loadConfig` succeeds, else `FAIL` with the first line of
   the load error.
7. **`brain configured`** — `PASS` (detail: `<brain.id> (<brain.model>)`) if
   the loaded config has a `brain` with a non-empty string `id`; `FAIL`
   (`config has no usable \`brain\``) if the config loaded but has no usable
   brain, or (`config did not load`) if the config itself failed to load.

After the checks, a blank line and one of:

- `✖ <N> check(s) failed[, <M> warning(s)]. Fix the FAILs above before
  \`mainspring run\`.` if any check `FAIL`ed.
- `✓ Runnable, with <N> warning(s). Review the WARNs above.` if there are
  only `WARN`s.
- `✓ All checks passed — this workspace is ready for \`mainspring run\`.` if
  everything `PASS`ed.

**Exit codes**: `1` if any check is `FAIL`; `0` otherwise (including when
there are only `WARN`s).

**Example** (healthy workspace)

```
$ mainspring doctor
mainspring doctor — /home/user/my-business

  PASS  node >= 18 — node 20.11.0
  PASS  git available — git version 2.43.0
  PASS  CONSTITUTION.md present — CONSTITUTION.md
  PASS  STATE.md present — STATE.md
  PASS  LEDGER.csv present — LEDGER.csv
  PASS  mainspring.config.ts loads — constitution "Hello Business"
  PASS  brain configured — echo (echo-v1)

✓ All checks passed — this workspace is ready for `mainspring run`.
```

**Example** (missing `CONSTITUTION.md`)

```
$ mainspring doctor --workspace ./broken
mainspring doctor — /home/user/broken

  PASS  node >= 18 — node 20.11.0
  ...
  FAIL  CONSTITUTION.md present — not found in workspace
  ...

✖ 1 check(s) failed. Fix the FAILs above before `mainspring run`.
```

### `mainspring help` / `-h` / `--help` / no arguments

Prints usage text and exits `0`:

```
mainspring — run a long-lived, autonomous, revenue-generating agent business

Usage:
  mainspring init <dir> [--name "My Business"] [--brain echo]
  mainspring run [--workspace .] [--no-commit]
  mainspring status [--workspace .]
  mainspring doctor [--workspace .]
```

### Unknown command

Any other first argument prints `Unknown command: <command>` (followed by a
blank line) to stderr, then the same usage text to stdout, and sets exit
code `1`.

```
$ mainspring bogus
Unknown command: bogus

mainspring — run a long-lived, autonomous, revenue-generating agent business

Usage:
  mainspring init <dir> [--name "My Business"] [--brain echo]
  mainspring run [--workspace .] [--no-commit]
  mainspring status [--workspace .]
  mainspring doctor [--workspace .]
```

## Flag parsing notes

Flags are parsed by a minimal hand-rolled parser (`src/args.ts`): any
`--flag=value` or `--flag value` (where the following token doesn't itself
start with `--`) becomes a string flag; a bare trailing `--flag` (or one
immediately followed by another `--flag`) becomes the boolean `true`.
Non-`--`-prefixed tokens are collected as positionals in order. There is no
built-in support for short flags other than the hardcoded `-h`/`--help`
handling in `bin.ts`.
