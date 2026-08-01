// The symbol under a position, for the hover popup (hover/hover.ts): which name the pointer or the
// caret is on, what to ask Numbat about it, and where it sits on the line. Pure (no Obsidian,
// CodeMirror, or wasm imports), like completion/expressions.ts, so it is unit-testable in
// isolation.

import { dottedPathAt, wordRangeAt } from "../syntax/identifier";

/** What kind of thing the position is on, which decides how it is asked about and how the card is
 *  headed. */
export type HoverSymbolKind =
  /** A plain name — a variable, function, unit, dimension. */
  | "name"
  /** A member chain (`costs.total`), asked about by its whole path. */
  | "member"
  /** A literal, with its unit when one follows (`21.1 km`) — asked about by evaluating it, which is
   *  the only way a literal has anything to say. */
  | "quantity";

/** A symbol found at a position. */
export interface HoverSymbol {
  /** What sort of thing was pointed at, which decides how the card is built. */
  kind: HoverSymbolKind;

  /** The word actually pointed at (`total` of `costs.total`). */
  name: string;

  /** What to ask the interpreter about — the whole member chain, since `type()` answers for
   *  `costs.total` but not for a bare `total`. */
  probe: string;

  /** The probe's first column on the line — the tooltip's anchor range starts here. */
  from: number;

  /** One column past the probe's last character. */
  to: number;
}

/** A number literal, in the shapes Numbat writes them (the tokenizer's rule, minus its word
 *  boundaries — this matches at a known offset). */
const NUMBER = /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/;

/** The literal at column `ch`, extended over the unit that follows it (`21.1 km`), or `null` when
 *  the position is not on a number. A literal alone answers nothing; with its unit it answers what
 *  dimension it is. */
function quantityAt(line: string, ch: number): { from: number; to: number; name: string; } | null {
  // Walk back to the start of the number run the position sits in.
  let from = Math.max(0, Math.min(ch, line.length));
  while (from > 0 && /[\d_.]/.test(line[from - 1])) {
    from -= 1;
  }

  const match = NUMBER.exec(line.slice(from));
  if (match === null || from + match[0].length <= ch) {
    return null; // not on a number (or past its end)
  }
  const numberEnd = from + match[0].length;

  // A unit may follow, with or without a space: `21.1 km`, `5km`.
  const rest = /^\s*([\p{L}_][\p{L}\p{N}_]*)/u.exec(line.slice(numberEnd));
  const to = rest === null ? numberEnd : numberEnd + rest[0].length;
  return { from, to, name: match[0] };
}

/**
 * Whether column `ch` of `line` is *code*: outside any `"…"` string literal and before any `#` line
 * comment. Mirrors {@link import("../evaluation/inlay-parse").stripLineComment}'s scan (escapes
 * honored, `#` inside a string is not a comment), but answers for a position rather than
 * truncating.
 */
export function isCodeAt(line: string, ch: number): boolean {
  let inString = false;

  for (let i = 0; i < line.length && i < ch; i += 1) {
    const char = line[i];
    if (inString) {
      if (char === "\\") {
        i += 1; // skip the escaped character
      } else if (char === "\"") {
        inString = false;
      }
    } else if (char === "\"") {
      inString = true;
    } else if (char === "#") {
      return false; // the rest of the line is a comment
    }
  }

  return !inString;
}

/**
 * Whether column `ch` is before any comment on a line whose quoting is not Numbat's (a YAML value).
 * A `#` only opens a comment in YAML when it follows whitespace, so that is the rule here — which
 * also leaves a `#` written inside the value alone.
 */
function isBeforeComment(line: string, ch: number): boolean {
  const comment = line.search(/(^|\s)#/);
  return comment === -1 || ch <= comment;
}

/** How a line is to be read. */
export interface HoverSymbolOptions {
  /**
   * The expression may be wrapped in quotes that are not Numbat's — a frontmatter value, which YAML
   * often quotes (`total: "5 km + 3 mi"`). The string rule is then off, or the whole value would
   * read as one string and never be hoverable. The comment rule stays: `#` opens a comment in YAML
   * as well.
   */
  quoted?: boolean;
}

/**
 * The Numbat symbol at column `ch` of `line`, or `null` when there is nothing to ask about: a
 * position on whitespace or punctuation, inside a string, or in a comment. Prose is not filtered
 * here — the caller decides whether the line is Numbat at all (a fence, an inline span, a property
 * value).
 */
export function hoverSymbolAt(line: string, ch: number, options: HoverSymbolOptions = {}): HoverSymbol | null {
  const readable = options.quoted === true ? isBeforeComment(line, ch) : isCodeAt(line, ch);
  if (!readable) {
    return null;
  }

  const word = wordRangeAt(line, ch);
  if (word === null) {
    const quantity = quantityAt(line, ch);
    return quantity === null ? null : {
      kind: "quantity",
      name: quantity.name,
      probe: line.slice(quantity.from, quantity.to).trim(),
      from: quantity.from,
      to: quantity.to,
    };
  }

  const path = dottedPathAt(line, ch) ?? word;
  return {
    kind: path.from === word.from ? "name" : "member",
    name: line.slice(word.from, word.to),
    probe: line.slice(path.from, path.to),
    from: path.from,
    to: path.to,
  };
}
