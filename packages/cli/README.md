# @mainspring/cli

The `mainspring` command: init, run, status, and doctor a long-lived
agent-business workspace built on `@mainspring/core`.

## Install

```sh
npm install -g @mainspring/cli
```

## Usage

```sh
mainspring init ./my-business --name "My Business" --brain echo
mainspring run --workspace ./my-business
mainspring status --workspace ./my-business
mainspring doctor
```

`init` scaffolds a workspace with a `CONSTITUTION.md`, `STATE.md`, and
`mainspring.config.ts`; `run` executes one session of the loop and commits
the workspace; `status` prints a summary of the last recorded session;
`doctor` checks that required tooling (git, node) is on `PATH`.
