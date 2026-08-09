// Where Numbat reads *on* across a newline, and where a newline ends the statement.
//
// Numbat's tokenizer emits a newline token and its parser skips one only in the places its grammar
// says a statement cannot have finished. Two surfaces need that answer and must not drift apart:
// the statement grouper (evaluation/inlay-parse.ts), which splits a block body into the units it
// evaluates, and the declaration-scope heuristic (completion/expressions.ts), which decides how far
// down a `fn`/`struct` header's names reach.
//
// The rule below was checked against the pinned wasm (`src/wasm/pkg`, prelude loaded) rather than
// inferred:
//
//   Continues                                  | Ends the statement
//   -------------------------------------------|-----------------------------------------------
//   a tail `=` — a definition's, or a `where`   | a tail `==` `!=` `<=` `>=`, and every other
//   binding's: `fn f(x) =` ⏎ `x + 1`            | binary operator: `1 +` ⏎ `2` is a parse error
//   a tail `where` `and` `then` `else`          | a tail `->`, `:`, `if`, or a `fn` name before
//                                              | its `(` — each is a parse error over the newline
//   a head `where` `and` `then` `else`, at any  | a head `&&` or `+`: `1` ⏎ `+ 2` is two
//   indent, column 0 included                   | statements, not one
//
// Blank and comment-only lines between the two halves are skipped by Numbat, so a caller pairing a
// tail with a head must skip them too. Brackets are the caller's business: a still-open `(`/`[`/`{`
// continues a statement for reasons of its own, and is tracked by bracket depth rather than here.
//
// No imports, so this is unit-testable in isolation (like syntax/identifier.ts). Both functions
// take code text the caller has already stripped of comments and blanked of string contents, so a
// `#` or a quoted `where` cannot be read as either.

/** The keywords that join a definition's body to what came before it: the `where`/`and` local
 *  bindings, and the two halves of an `if`. Numbat skips a newline on either side of each. */
const JOINING_KEYWORD = "where|and|then|else";

/** A line's code ending on a keyword that continues, or on a definition's `=` — which is not the
 *  `=` of `==`/`!=`/`<=`/`>=`, none of which Numbat reads on from. */
const CONTINUES_AFTER = new RegExp(`(?<![=!<>])=$|(?<![\\p{L}\\p{N}_])(?:${JOINING_KEYWORD})$`, "u");

/** A line's code opening on a keyword that continues the previous line. */
const CONTINUES_BEFORE = new RegExp(`^(?:${JOINING_KEYWORD})(?![\\p{L}\\p{N}_])`, "u");

/**
 * Whether Numbat reads on past the end of this line's code — it ends on a definition's `=` or on a
 * `where`/`and`/`then`/`else`. `tail` is the line's code; surrounding whitespace is ignored.
 */
export function continuesAfter(tail: string): boolean {
  return CONTINUES_AFTER.test(tail.trim());
}

/**
 * Whether this line's code continues the one above it — it opens on `where`, `and`, `then`, or
 * `else`. `head` is the line's code; leading whitespace is ignored (the keyword is conventionally
 * indented, but Numbat accepts it at column 0 too).
 */
export function continuesBefore(head: string): boolean {
  return CONTINUES_BEFORE.test(head.trim());
}
