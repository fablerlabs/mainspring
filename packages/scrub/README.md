# @mainspring/scrub

The scrub gate: detects secret-shaped strings in content before any publish
or notify action. Zero runtime dependencies, no network.

## Install

```sh
npm install @mainspring/scrub
```

## Usage

```ts
import { scanFiles, substitute } from "@mainspring/scrub";

const findings = await scanFiles(["README.md", "docs/setup.md"]);
if (findings.length > 0) {
  throw new Error(`scrub gate: ${findings.length} possible secret(s) found`);
}

const redacted = substitute(content, { STRIPE_KEY: process.env.STRIPE_KEY! });
```

`scan`/`scanFiles` never return the full matched string, only a redacted
excerpt — safe to log.
