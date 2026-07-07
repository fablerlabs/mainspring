#!/usr/bin/env bash
# Publish all @mainspring/* packages to npm in one idempotent pass.
#
# Usage:
#   export NPM_TOKEN=npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
#   bash tools/publish-all.sh
#
# Reads NPM_TOKEN from the environment only — never edit this file to embed
# a token. Safe to re-run: `pnpm -r publish` skips any package version
# already live on the registry instead of failing the whole batch.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ -z "${NPM_TOKEN:-}" ]; then
  echo "error: NPM_TOKEN is not set. export NPM_TOKEN=... first." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm not found on PATH. Run: corepack enable" >&2
  exit 1
fi

NPMRC=".npmrc"
cleanup() {
  rm -f "$NPMRC"
}
trap cleanup EXIT

echo "==> writing scoped npm auth (token read from env, not embedded)"
echo "//registry.npmjs.org/:_authToken=\${NPM_TOKEN}" > "$NPMRC"

echo "==> verifying build + test are green before publishing"
pnpm -r build
pnpm -r test

echo "==> publishing all @mainspring/* packages (pnpm resolves publish order"
echo "    from the workspace dependency graph automatically)"
pnpm -r publish --access public --no-git-checks

echo "==> verifying published versions"
FAILED=0
for pkg in brains broker cli core governance ledger memory relay schedule scrub; do
  live_version="$(npm view "@mainspring/$pkg" version 2>/dev/null || echo "MISSING")"
  local_version="$(node -p "require('./packages/$pkg/package.json').version")"
  if [ "$live_version" = "$local_version" ]; then
    printf '  ok    @mainspring/%-10s %s\n' "$pkg" "$live_version"
  else
    printf '  FAIL  @mainspring/%-10s expected %s, got %s\n' "$pkg" "$local_version" "$live_version"
    FAILED=1
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo "error: one or more packages did not verify on the registry. See above." >&2
  exit 1
fi

echo "==> done: all @mainspring/* packages published and verified"
