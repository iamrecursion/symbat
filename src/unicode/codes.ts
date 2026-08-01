// Pure helpers for the LaTeX-style `\code` completion popover: parsing the code prefix at the
// cursor, and turning Numbat's completion vocabulary into the list of `\code` → glyph entries. No
// imports (no Obsidian, CodeMirror, or wasm), so this is unit-testable in isolation;
// interpreter/numbat.ts feeds it the wasm's completion data and the suggesters feed it the text at
// the cursor.

/** A `\code` completion candidate: the code name (without the backslash) and its Unicode expansion,
 *  e.g. `{ name: "alpha", replacement: "α" }`. */
export interface UnicodeCode {
  /** The code name as typed after the leader, without it. */
  name: string;

  /** The Unicode text the code expands to. */
  replacement: string;
}

/**
 * The code prefix immediately before the caret: the run of characters following the last `leader`
 * (default `\`), or `null` when the caret is not within such a run. With leader `\`: `"x = \\al"` →
 * `"al"`, `"\\"` → `""` (an empty prefix, i.e. every code matches), `"x = 2"` → `null`. A leader
 * can be more than one character (e.g. `";;"`), so this matches the last whole `leader` rather than
 * a single character class.
 *
 * A run containing whitespace is not a prefix (the run ends the code), so `"\\alpha "` → `null`;
 * this mirrors the tail the eager expansion looks for.
 */
export function unicodePrefixAt(textBeforeCaret: string, leader: string): string | null {
  const idx = textBeforeCaret.lastIndexOf(leader);
  if (idx === -1) {
    return null;
  }

  const run = textBeforeCaret.slice(idx + leader.length);
  return /\s/.test(run) ? null : run;
}

/**
 * Build the `{ name, replacement }` list from candidate completion `names`, keeping only those that
 * resolve to a Unicode code via `lookup` (which is given the full `\name` and returns the
 * replacement glyph, or `null` for non-codes). De-duplicated by name and sorted, so the popover
 * order is stable.
 *
 * `names` is Numbat's full completion vocabulary (keywords, unit/function names, and the `\code`
 * names among them); the `lookup` filter is what keeps only the genuine codes — and hands back each
 * glyph — without a separate code table.
 */
export function buildUnicodeCodeList(
  names: Iterable<string>,
  lookup: (code: string) => string | null,
): UnicodeCode[] {
  const codes: UnicodeCode[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (name === "" || seen.has(name)) {
      continue;
    }

    const replacement = lookup(`\\${name}`);
    if (replacement !== null && replacement !== "") {
      seen.add(name);
      codes.push({ name, replacement });
    }
  }

  codes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return codes;
}

/** The codes whose name starts with `prefix` (case-sensitive: `Omega` ≠ `omega`). */
export function codesMatching(codes: readonly UnicodeCode[], prefix: string): UnicodeCode[] {
  return codes.filter((code) => code.name.startsWith(prefix));
}
