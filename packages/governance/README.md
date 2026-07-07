# @mainspring/governance

Constitution-as-code: hard rules the brain cannot override, loaded from a
`CONSTITUTION.md` and enforced as `Action` guards. Zero runtime
dependencies, never throws, no network.

## Install

```sh
npm install @mainspring/governance
```

## Usage

```ts
import { createBuiltInRules, evaluate } from "@mainspring/governance";

const rules = createBuiltInRules({ moneyCaps: { perSessionUsd: 25, notifyAboveUsd: 25, approvalAboveUsd: 75 } });

const result = evaluate({ kind: "notify", to: "owner", text: "shipped v1" }, rules);
if (result.verdict !== "allow") {
  console.log("blocked:", result.firedRules);
}
```

`loadConstitutionRules()` / `loadConstitutionFile()` parse a `CONSTITUTION.md`'s
"## Hard rules" section and attach its prose to the matching built-in rule.
