// What counts as a Numbat *word*, and how to find the one at a given column.
//
// Numbat's identifiers are Unicode — `Δt`, `µm`, `π` are ordinary names — so the character classes
// are letter classes rather than `[A-Za-z_]`/`\w`, which eat the leading character and match only
// the ASCII tail. That mistake was live in the tokenizer once (a `µm` unit colored as `m`), which
// is why the rule lives in one place: the tokenizer (syntax/tokenizer.ts) and the hover
// (hover/parse.ts) share it rather than each carrying a copy to drift.
//
// No imports, so it is unit-testable in isolation.

/** What can begin an identifier. */
export const WORD_START = /[\p{L}_]/u;

/** What can continue one. */
export const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** A half-open `[from, to)` range of `text`. */
export interface WordRange {
  /** Column of the word's first character. */
  from: number;

  /** Column one past the word's last character. */
  to: number;
}

/**
 * The word containing column `ch`, or `null` when there is none there.
 *
 * A column *between* two characters belongs to the word on either side, so pointing at the very
 * start or the very end of a name both find it — a hover lands wherever the pointer happens to
 * fall, and refusing the boundary would make the edges of a short name unhoverable. A word whose
 * first character is not a word start (the `2` of `2x`) begins at the first character that is, so
 * `5km` finds `km`.
 */
export function wordRangeAt(text: string, ch: number): WordRange | null {
  const at = Math.max(0, Math.min(ch, text.length));
  let from = at;
  while (from > 0 && WORD_CHAR.test(text[from - 1])) {
    from -= 1;
  }

  let to = at;
  while (to < text.length && WORD_CHAR.test(text[to])) {
    to += 1;
  }

  if (from === to) {
    return null; // the position is not on a word at all
  }

  // Digits can continue a word but not begin one, so trim any leading run of them (`5km` → `km`);
  // an all-digit run is a number, not a name.
  while (from < to && !WORD_START.test(text[from])) {
    from += 1;
  }

  return from === to ? null : { from, to };
}

/**
 * The word at `ch` extended left through any `.` member chain it is part of — so `costs.total` is
 * one probe from either half of `total`, and `a.b.c` from `c` is the whole path.
 *
 * The chain extends **left only**. Hovering `costs` in `costs.total` asks about the struct,
 * hovering `total` asks about the field; extending right as well would make the two
 * indistinguishable. `null` when there is no word at `ch`.
 */
export function dottedPathAt(text: string, ch: number): WordRange | null {
  const word = wordRangeAt(text, ch);
  if (word === null) {
    return null;
  }
  let { from } = word;

  // Walk back over `.name` segments. A `.` preceded by anything but a word (a number's decimal
  // point, a closing paren, whitespace) ends the chain.
  for (;;) {
    if (from < 2 || text[from - 1] !== ".") {
      break;
    }

    const previous = wordRangeAt(text, from - 1);
    if (previous === null || previous.to !== from - 1) {
      break;
    }

    from = previous.from;
  }

  return { from, to: word.to };
}
