// Numbat line tokenizer.
//
// A small hand-written lexer used to color `numbat` code. It is intentionally *line-oriented and
// stateless*: `tokensForLine` scans one line and returns a flat list of `{ start, end, cls }` spans
// (offsets relative to that line), so the editor integration (syntax/highlight.ts) can turn each
// span into a CodeMirror 6 `Decoration.mark` at the corresponding document offset.
//
// How it scans (`classify` driving a `LineStream` cursor):
//   * Whitespace is skipped and yields no token.
//   * `#` runs to end-of-line as a comment.
//   * `"..."` (honoring `\`-escapes) is a string.
//   * `@name` is a decorator.
//   * A leading digit starts a number: it greedily consumes digits, the hex/oct/bin markers,
//     `_`/`.` separators and an optional `e`/`E` exponent — a deliberately loose match that is good
//     enough for highlighting.
//   * A letter or `_` starts a word; a known keyword is classified as such, otherwise as an
//     identifier (Numbat unit names are identifiers and so share that color).
//   * A single operator character (`+ - * / ^ = < > ! · × ÷ ° % →`) is an operator.
//   * Anything else advances one character with no token.
//
// Being a lexer rather than a parser, it does not understand Numbat's grammar (e.g. it cannot tell
// a unit from a variable) — an accepted trade-off for cheap, robust, incremental editor
// highlighting. Token kinds are mapped to the plugin's `numbat-*` CSS classes (`TOKEN_CLASS`) so
// editor decorations and rendered output share one palette.
//
// Its only import is the shared identifier rule, so it stays unit-testable without Obsidian or
// CodeMirror.

import { WORD_CHAR, WORD_START } from "./identifier";

// THE GRAMMAR
// ================================================================================================

/**
 * Numbat's keywords, as both the editor lexer and the reading-view Prism grammar see them. Order is
 * irrelevant — {@link KEYWORD_SET} is what `classify` consults, and Prism builds one alternation
 * from the whole list.
 */
export const KEYWORDS = [
  "and",
  "assert",
  "assert_eq",
  "both",
  "dimension",
  "else",
  "false",
  "fn",
  "if",
  "let",
  "long",
  "none",
  "per",
  "print",
  "short",
  "struct",
  "then",
  "to",
  "true",
  "type",
  "unit",
  "use",
  "where",
];

// The same keywords as a set: `classify` tests one word per token, so the linear scan of the array
// would be on the hot path.
const KEYWORD_SET = new Set(KEYWORDS);

// Numbat's numeric literals: hex/octal/binary with `_` separators, or a decimal with an optional
// fractional part and an optional signed exponent. One source, because the reading view (Prism, via
// NUMBER_PATTERN) and the editor (classify, via NUMBER_TOKEN) disagreeing about where a number ends
// is exactly how `5cm` came to lex as `5c` + `m`.
const NUMBER_BODY = String.raw`0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?`;

/** A number anywhere in a line — word-bounded, for the Prism grammar. */
export const NUMBER_PATTERN = new RegExp(String.raw`\b(?:${NUMBER_BODY})\b`);

// The same literal anchored at a token start, for the streaming tokenizer. No trailing `\b`: a
// number may be followed immediately by a unit (`5cm`, `2bar`), and the literal simply ends where
// the numeric grammar does.
const NUMBER_TOKEN = new RegExp(`^(?:${NUMBER_BODY})`);

// TOKEN KINDS
// ================================================================================================

/** The kinds {@link classify} distinguishes (whitespace/unclassified is `null`). */
export type TokenKind =
  | "comment"
  | "dimension"
  | "keyword"
  | "meta"
  | "number"
  | "operator"
  | "string"
  | "type"
  | "unit"
  | "variable";

/** Token kinds, mapped to the plugin's CSS classes (shared with the rendered output so the editor
 * and results color alike). */
const TOKEN_CLASS: Record<TokenKind, string> = {
  comment: "numbat-comment",
  dimension: "numbat-dimension",
  keyword: "numbat-keyword",
  meta: "numbat-decorator",
  number: "numbat-value",
  operator: "numbat-operator",
  string: "numbat-string",
  type: "numbat-type-identifier",
  unit: "numbat-unit",
  variable: "numbat-identifier",
};

/** Resolves a word to its semantic kind — `type`, `dimension`, or `unit` — or `null` when it is
 * none of those. The lexer is otherwise context-free and cannot tell these apart, so callers that
 * have the interpreter's vocabulary pass this to color them distinctly; without it, only the
 * capitalization heuristic applies. */
export type WordKind = (word: string) => "type" | "dimension" | "unit" | null;

/** A leading uppercase letter (Unicode-aware), the cue for the type heuristic. */
const CapitalizED = /^\p{Lu}/u;

// What can begin an identifier, and what can continue one — shared with the hover's word lookup
// (syntax/identifier.ts), so the two cannot disagree about where a name ends.

/** A currency symbol — `€`, `$`, `£`, `¥`, `₹`, … In Numbat every one of these is a unit name, and
 *  none is anything else, so they color as units wherever they appear without needing the
 *  interpreter's vocabulary to confirm it. They are not letters, so they would otherwise fall
 *  through the identifier rule unstyled. */
const CURRENCY = /\p{Sc}/u;

// DECLARATION STATE
// ================================================================================================

/**
 * Per-statement lexer state, carried across tokens. It lets the lexer color a declaration
 * *syntactically* — eagerly, before the interpreter has recorded any name — without polluting the
 * (session-global, only-grows) semantic name sets with half-typed prefixes. It tracks three things:
 *
 *   * `decl` — a just-seen `dimension`/`unit` keyword, so the name that follows it is colored as
 *     that declared kind;
 *   * `dimensionExpr` — whether we are in a position that syntactically must be a dimension
 *     expression: the `: …` annotation of a `unit <name>:` declaration, or the `= …` body of a
 *     `dimension <name> = …`. There, identifiers color as dimensions (a place we *know* to be a
 *     dimension, e.g. `unit MyFoo: MyDim`);
 *   * `dimVars` — the `Dim`-bounded type parameters seen in a `fn`/`struct` declaration (`D` in `fn
 *     foo<D: Dim>`), so their later uses on the line (`x: D`, `-> D`) color as dimensions too.
 */
export interface LexState {
  /** "dimension"/"unit" when that declaration keyword was just seen (so the next identifier is its
   *  declared name), else null. */
  decl: "dimension" | "unit" | null;

  /** Which declaration this line is, so `:`/`=` know when the dimension part starts, and whether a
   *  `<name>: Dim` reads as a type-parameter bound. */
  context: "unit-decl" | "dimension-decl" | "fn-decl" | "struct-decl" | null;

  /** Whether the cursor is in the dimension-expression part of the declaration. */
  dimensionExpr: boolean;

  /** The `Dim`-bounded type parameters declared so far in this statement. */
  dimVars: Set<string>;
}

/** A fresh {@link LexState} — a new one per line in `tokensForLine`, and the start state of the
 *  REPL `StreamLanguage`. */
export function newLexState(): LexState {
  return { decl: null, context: null, dimensionExpr: false, dimVars: new Set() };
}

// THE STREAM
// ================================================================================================

/**
 * The minimal single-line stream surface {@link classify} drives. Deliberately a structural subset
 * of CodeMirror 6's `StringStream`, so the very same lexer can tokenize a line here (via the
 * in-house {@link LineStream}, for `tokensForLine` and the reading-view/tests) *and* back a CM6
 * `StreamLanguage` (see syntax/language.ts) — one lexer, no second implementation to drift.
 */
export interface TokenStream {
  /** Whether the cursor has reached the end of the line. */
  eol(): boolean;

  /** Consume a run of whitespace; `true` if any was consumed. */
  eatSpace(): boolean;

  /** The character at the cursor without advancing, or nullish at end-of-line. */
  peek(): string | null | undefined;

  /** Consume and return the character at the cursor, or nullish at end-of-line. */
  // `void` is admitted so CodeMirror's `StringStream` (whose `next` is typed `string | void`)
  // satisfies this interface alongside the in-house LineStream.
  next(): string | null | void;

  /** Consume the rest of the line — how `#` comments and unterminated strings end. */
  skipToEnd(): void;

  /** Consume characters while they match `match`; `true` if any were consumed. */
  eatWhile(match: RegExp): boolean;

  /** The text consumed since the token began, which is what the caller classifies. */
  current(): string;

  /** Try `pattern` (which must be `^`-anchored) at the current position without advancing
   *  (`consume` false) — the lexer's lookahead, e.g. for a `: Dim` bound. Truthy on a match; typed
   *  loosely so CM6's `StringStream.match` (returning `boolean | RegExpMatchArray | null`)
   *  satisfies it as-is. */
  match(pattern: RegExp, consume?: boolean): unknown;
}

/**
 * Minimal single-line character stream for the tokenizer — the in-house {@link TokenStream} used by
 * {@link tokensForLine}, where CodeMirror's own `StringStream` is not available (the reading view,
 * and the unit tests).
 */
class LineStream {
  /** The cursor: the offset of the next character to read. */
  pos = 0;

  /** Where the token in progress began; {@link current} slices from here. */
  start = 0;

  /** @param text the single line to scan, without its terminator. */
  constructor(readonly text: string) {}

  /** Whether the cursor has reached the end of the line. */
  eol(): boolean {
    return this.pos >= this.text.length;
  }

  /** The character at the cursor without advancing, or `null` at end-of-line. */
  peek(): string | null {
    return this.pos < this.text.length ? this.text[this.pos] : null;
  }

  /** Consume and return the character at the cursor, or `null` at end-of-line. */
  next(): string | null {
    return this.pos < this.text.length ? this.text[this.pos++] : null;
  }

  /** Consume a run of whitespace; `true` if any was consumed. */
  eatSpace(): boolean {
    const from = this.pos;
    while (!this.eol() && /\s/.test(this.text[this.pos])) {
      this.pos += 1;
    }
    return this.pos > from;
  }

  /** Consume the rest of the line. */
  skipToEnd(): void {
    this.pos = this.text.length;
  }

  /** Consume characters while they match `match`; `true` if any were consumed. */
  eatWhile(match: RegExp): boolean {
    const from = this.pos;
    while (!this.eol() && match.test(this.text[this.pos])) {
      this.pos += 1;
    }
    return this.pos > from;
  }

  /** The text consumed since {@link start} — the token in progress. */
  current(): string {
    return this.text.slice(this.start, this.pos);
  }

  /**
   * Match `pattern` at the cursor, consuming it unless `consume` is false. `pattern` must be
   * `^`-anchored: the `index !== 0` guard rejects a match found later in the line rather than
   * silently accepting it at the wrong offset.
   */
  match(pattern: RegExp, consume = true): RegExpMatchArray | null {
    const found = pattern.exec(this.text.slice(this.pos));
    if (found === null || found.index !== 0) {
      return null;
    }

    if (consume) {
      this.pos += found[0].length;
    }
    return found;
  }
}

// THE LEXER
// ================================================================================================

/** Classify the next token, advancing the stream. Returns the token kind, or null for whitespace /
 * unclassified characters. Typed against {@link TokenStream} so it can drive either {@link
 * LineStream} or a CM6 `StringStream`. `wordKind`, when given, colors recognized
 * type/dimension/unit words semantically; any other capitalized word falls back to a `type` (the
 * static heuristic). `state`, when given, colors a `dimension`/`unit` declaration's name eagerly
 * (see {@link LexState}); any substantive token clears the pending declaration, so it only ever
 * affects the identifier immediately following the keyword. */
export function classify(stream: TokenStream, wordKind?: WordKind, state?: LexState): TokenKind | null {
  if (stream.eatSpace()) {
    return null;
  }

  const ch = stream.peek();
  if (ch === null || ch === undefined) {
    stream.next();
    return null;
  }

  // Consume any pending declaration: it applies to this one (substantive) token — the declared name
  // if this is an identifier, and is cleared regardless.
  const pendingDecl = state?.decl ?? null;
  if (state) {
    state.decl = null;
  }

  if (ch === "#") {
    stream.skipToEnd();
    return "comment";
  }

  if (ch === "\"") {
    stream.next();
    while (!stream.eol()) {
      const c = stream.next();
      if (c === "\\") {
        stream.next();
      } else if (c === "\"") {
        break;
      }
    }
    return "string";
  }

  if (ch === "@") {
    stream.next();
    stream.eatWhile(/\w/);
    return "meta";
  }

  if (/[0-9]/.test(ch)) {
    // `stream.next()` only as a guard: NUMBER_TOKEN always matches at a digit, but the stream must
    // advance or the caller's progress check trips.
    if (stream.match(NUMBER_TOKEN) === null) {
      stream.next();
    }
    return "number";
  }

  if (CURRENCY.test(ch)) {
    stream.next();
    return "unit";
  }

  if (WORD_START.test(ch)) {
    stream.eatWhile(WORD_CHAR);
    const word = stream.current();

    if (KEYWORD_SET.has(word)) {
      // A `dimension`/`unit` keyword arms the next identifier as its declared name and marks which
      // declaration this line is (so `:`/`=` can start the dimension part); `fn`/`struct` mark
      // theirs so a `<name>: Dim` bound is recognized.
      if (state) {
        if (word === "unit") {
          state.decl = "unit";
          state.context = "unit-decl";
          state.dimensionExpr = false;
        } else if (word === "dimension") {
          state.decl = "dimension";
          state.context = "dimension-decl";
          state.dimensionExpr = false;
        } else {
          state.decl = null;
          if (word === "fn" || word === "struct") {
            state.context = word === "fn" ? "fn-decl" : "struct-decl";
            state.dimensionExpr = false;
            state.dimVars = new Set();
          }
        }
      }

      return "keyword";
    }

    // A declared name straight after `dimension`/`unit` colors as that kind.
    if (pendingDecl) {
      return pendingDecl;
    }

    // In a dimension-expression position (a `unit <name>:` annotation or a `dimension <name> =`
    // body) every identifier is a dimension, syntactically.
    if (state?.dimensionExpr) {
      return "dimension";
    }

    // `Dim` — the type-parameter bound all dimensions satisfy — reads as a dimension, as do the
    // type parameters it bounds: at the declaration site (`D` in `fn foo<D: Dim>`, spotted by
    // lookahead) and at their later uses on the line (`x: D`, `-> D`, via the recorded set).
    if (word === "Dim") {
      return "dimension";
    }

    if (state && (state.context === "fn-decl" || state.context === "struct-decl")) {
      if (state.dimVars.has(word)) {
        return "dimension";
      }
      if (stream.match(/^\s*:\s*Dim\b/, false)) {
        state.dimVars.add(word);
        return "dimension";
      }
    }

    // Semantic kind (type/dimension/unit) when known; otherwise a capitalized word reads as a type
    // (the static heuristic), and anything else as an identifier.
    return wordKind?.(word) ?? (CapitalizED.test(word) ? "type" : "variable");
  }

  if (/[-+*/^=<>!·×÷°%→]/.test(ch)) {
    stream.next();
    // `=` starts the dimension body of a `dimension <name> = …`, and ends the dimension annotation
    // of a `unit <name>: … = value` (the value is ordinary).
    if (state && ch === "=") {
      state.dimensionExpr = state.context === "dimension-decl";
    }

    return "operator";
  }

  // `:` (no token of its own) starts the dimension annotation of a `unit <name>:`.
  if (state && ch === ":" && state.context === "unit-decl") {
    state.dimensionExpr = true;
  }

  stream.next();
  return null;
}

/**
 * One colored span of a line. Offsets are relative to the start of that line, so
 * syntax/highlight.ts adds the line's document offset to place the decoration.
 */
export interface Token {
  /** Offset of the token's first character within its line. */
  start: number;

  /** Offset one past the token's last character. */
  end: number;

  /** The `numbat-*` CSS class for the token's kind (see `TOKEN_CLASS`). */
  cls: string;
}

/** Tokenize a single line into class-bearing spans (relative offsets). `wordKind`, when given,
 * colors recognized type/dimension/unit words (see {@link classify}). */
export function tokensForLine(line: string, wordKind?: WordKind): Token[] {
  const stream = new LineStream(line);
  const state = newLexState();
  const tokens: Token[] = [];
  while (!stream.eol()) {
    stream.start = stream.pos;
    const kind = classify(stream, wordKind, state);
    if (stream.pos <= stream.start) {
      stream.pos = stream.start + 1; // guarantee progress
      continue;
    }

    const cls = kind ? TOKEN_CLASS[kind] : undefined;
    if (cls) {
      tokens.push({ start: stream.start, end: stream.pos, cls });
    }
  }

  return tokens;
}
