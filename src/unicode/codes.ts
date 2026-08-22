// Pure helpers for the LaTeX-style `\code` completion popover: the shape of one code, parsing the
// code prefix at the cursor, and filtering by it. No imports at all (no Obsidian, CodeMirror, or
// wasm), so this is unit-testable in isolation and can be reached from the input handler's
// synchronous path. The codes themselves live in unicode/table.ts, resolved by unicode/expand.ts.

/**
 * A `\code` completion candidate: the code name (without the backslash) and its Unicode expansion,
 * e.g. `{ name: "alpha", replacement: "α" }`.
 */
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

/** The codes whose name starts with `prefix` (case-sensitive: `Omega` ≠ `omega`). */
export function codesMatching(codes: readonly UnicodeCode[], prefix: string): UnicodeCode[] {
  return codes.filter((code) => code.name.startsWith(prefix));
}
