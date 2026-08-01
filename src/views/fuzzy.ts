// Pure fuzzy-matching helpers for REPL history search. No imports, so they are unit-testable
// without Obsidian.

/**
 * Case-insensitive subsequence match: are all characters of `query` present in `text` in order (not
 * necessarily contiguously)? An empty query always matches.
 *
 * @param text The candidate string.
 * @param query The search query (typically the current REPL input).
 * @returns `true` if `query` fuzzy-matches `text`.
 */
export function fuzzyMatches(text: string, query: string): boolean {
  const needle = query.toLowerCase();
  if (needle === "") {
    return true;
  }

  const haystack = text.toLowerCase();
  let i = 0;
  for (let k = 0; k < haystack.length && i < needle.length; k += 1) {
    if (haystack[k] === needle[i]) {
      i += 1;
    }
  }

  return i === needle.length;
}

/**
 * Filter `entries` to those fuzzy-matching `query`, de-duplicated and preserving input order
 * (callers pass most-recent-first for history recall).
 *
 * @param entries Candidate strings, in the desired result order.
 * @param query The search query.
 * @returns The de-duplicated matching entries, in order.
 */
export function fuzzyFilter(entries: readonly string[], query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    if (!seen.has(entry) && fuzzyMatches(entry, query)) {
      seen.add(entry);
      out.push(entry);
    }
  }

  return out;
}
