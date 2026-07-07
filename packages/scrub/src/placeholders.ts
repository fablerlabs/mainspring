/**
 * Replaces every exact value from `envMap` with a `<NAME>` placeholder.
 * Generalizes the brain-publish.sh trick: content destined for a public
 * repo can be scrubbed of live env values without needing to know which
 * pattern class each one belongs to — only the exact value.
 *
 * Longer values are substituted first so that one value which happens to be
 * a substring of another (e.g. an id embedded in a longer token) doesn't get
 * partially replaced before its containing value is handled.
 */
export function substitute(content: string, envMap: Record<string, string>): string {
  const entries = Object.entries(envMap).filter(([, value]) => value.length > 0);
  entries.sort((a, b) => b[1].length - a[1].length);

  let result = content;
  for (const [name, value] of entries) {
    result = result.split(value).join(`<${name}>`);
  }
  return result;
}
