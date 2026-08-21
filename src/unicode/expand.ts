// Resolving a LaTeX-style `\code` at the caret, and enumerating the whole set for the completion
// popover. Both answers come from the committed table (unicode/table.ts) rather than from the
// interpreter, so this module imports nothing but its sibling helpers and is unit-testable.
//
// That is the reason behind the split. The expansion is applied from CodeMirror's `inputHandler`,
// which must answer on the keystroke; before the table existed this module's job was done by a
// dedicated wasm instance kept alive for it, which meant an expansion typed before the module had
// loaded silently did nothing, and the popover's list cost one wasm call per name in Numbat's
// vocabulary.

import { codesMatching, type UnicodeCode, unicodePrefixAt } from "./codes";
import { UNICODE_INPUT } from "./table";

/**
 * A pending expansion: the matched code occupies the final `replaceLength` characters of the
 * queried text and expands to `replacement` (e.g. `\alpha` → `α`, with `replaceLength` 6).
 */
export interface UnicodeCompletion {
  /** Length of the matched code, including the leader, in characters. */
  replaceLength: number;

  /** The Unicode text the code expands to. */
  replacement: string;
}

/** Every code name to its replacement. Numbat's own lookup walks the table testing whether the
 *  input ends with `\name`; a map is exactly equivalent because no name contains a backslash, so
 *  at most one row can match and the matching one always begins right after the final leader. */
const REPLACEMENTS = new Map<string, string>(
  UNICODE_INPUT.flatMap(([codes, replacement]) => codes.map((code): [string, string] => [code, replacement])),
);

/** The full `\code` list for the popover, de-duplicated and sorted once. The sort is by code unit,
 *  so `Omega` sorts before `omega` rather than beside it — which is what keeps the two visibly
 *  distinct in a list where their glyphs are not. */
const UNICODE_CODES: readonly UnicodeCode[] = [...REPLACEMENTS]
  .map(([name, replacement]): UnicodeCode => ({ name, replacement }))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/**
 * The expansion for the code ending at the caret, or `null` when the text does not end in one.
 *
 * `leader` is whatever the reader configured in place of the backslash; the code name is the run
 * after its last occurrence, so a multi-character leader works without the table knowing about it.
 * A run containing whitespace is not a code, which {@link unicodePrefixAt} already reports as no
 * prefix at all.
 */
export function unicodeExpansionAt(textBeforeCaret: string, leader: string): UnicodeCompletion | null {
  const name = unicodePrefixAt(textBeforeCaret, leader);
  if (name === null) {
    return null;
  }

  const replacement = REPLACEMENTS.get(name);
  return replacement === undefined ? null : { replaceLength: leader.length + name.length, replacement };
}

/**
 * The codes whose name starts with `prefix` (the text after the leader, e.g. `"al"` → `\alpha`),
 * for the completion popover.
 */
export function listUnicodeCompletions(prefix: string): UnicodeCode[] {
  return codesMatching(UNICODE_CODES, prefix);
}
