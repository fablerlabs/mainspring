## What does this change, and why?

<!-- One or two sentences. Link an issue if there is one. -->

## How was this tested?

<!-- `pnpm -r test`, plus anything specific to this change. Paste the
     relevant `node --test` output for the package(s) you touched. -->

## Checklist

- [ ] `pnpm -r build && pnpm -r test` passes locally (this is exactly what CI runs, on Node 20 and 22).
- [ ] Changes are scoped to one package where possible; if this touches more than one, the description above explains why.
- [ ] No secrets, tokens, or real credentials in any commit, fixture, or test.
- [ ] New/changed public APIs have JSDoc; new behavior has a test in the relevant `packages/*/test/`.
