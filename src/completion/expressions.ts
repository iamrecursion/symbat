// Pure helpers for Numbat *expression* completion: turning the interpreter's completion vocabulary
// into categorized completions (variables, functions, units, types, keywords), and deciding where —
// and on what — the completer should trigger.
//
// Nothing from Obsidian, CodeMirror, or the wasm is imported — only the pure text helpers that read
// Numbat source, which are shared rather than copied — so this is unit-testable in isolation,
// mirroring unicode/codes.ts. interpreter/numbat.ts feeds it the wasm's data (the flat
// `get_completions_for` list, and the categorized names parsed from the `list` commands); the
// editor suggester and the REPL completer feed it the text at the cursor.
//
// Why the categories are computed here rather than taken from the wasm: Numbat's
// `get_completions_for` returns one flat, prefix-filtered list mixing keywords, LaTeX `\code`
// patterns, variables, functions, dimensions, and units, with no category tag. We recover the
// category of each candidate by cross-referencing a vocabulary built from the interpreter's own
// `list functions|units|variables| dimensions` output, plus the two static sets below.

import { blankStrings, stripLineComment } from "../evaluation/inlay-parse";
import { continuesAfter, continuesBefore } from "../syntax/statements";

/**
 * A completion's fine-grained category — its display label and highlight color. Each of the five
 * settings toggles gates one group: `variable`/`function` are "identifiers", `unit` is "units",
 * `dimension` is "dimensions", `type` is "types", and `keyword` is "keywords". `type` is a
 * built-in/structural type (`Bool`, `String`, `List`, …); `dimension` is a physical dimension
 * (`Length`, `Time`, …) — Numbat renders both as type identifiers, but they are distinct kinds.
 * `parameter` and `local` are the names a declaration binds inside itself, which no context knows.
 */
export type ExprCategory =
  | "variable"
  | "function"
  | "unit"
  | "dimension"
  | "type"
  | "keyword"
  | "field"
  | "parameter"
  | "local"
  | "decorator";

/** One categorized expression completion. */
export interface ExprCompletion {
  /** The text inserted when the completion is accepted. */
  name: string;

  /** The completion's kind (drives its label, color, and which toggle gates it). */
  category: ExprCategory;

  /** What to ask the interpreter about when showing this row's signature and docs, when that
   *  differs from what is inserted. A struct field inserts its bare name but is typed through its
   *  whole path (`type(costs.total)`). */
  probeName?: string;

  /** What accepting the row writes, when that is more than `name`, and where the caret lands within
   *  it. A decorator's parentheses are mandatory, so they are written with it and the caret is put
   *  where the argument goes. */
  applied?: { text: string; caret: number; };

  /** A ready-made documentation card for a row the interpreter cannot be asked about (it knows no
   *  decorator vocabulary). Rendered in place of a `print_info` lookup. */
  doc?: string;

  /** What a locally-declared row's card says — a parameter or a `where`/`and` local, whose type and
   *  owner come from the declaration rather than from the interpreter (see {@link
   *  isInterpreterKnown}). Rendered in place of a `print_info` lookup, as `doc` is. */
  declared?: {
    /** How the declaration introduces it, which heads the card. */
    kind: "parameter" | "local";

    /** Its declared type, as written, or `null` when the declaration gives none. */
    type: string | null;

    /** The `fn` it belongs to. */
    owner: string;
  };
}

/** Which category groups the user has enabled (the five sub-toggles). */
export interface ExprCategories {
  /** Variables, constants, and functions. */
  identifiers: boolean;

  /** Keywords and operators. */
  keywords: boolean;

  /** Unit names (`meter`, `second`, …). */
  units: boolean;

  /** Physical dimension names (`Length`, `Time`, …). */
  dimensions: boolean;

  /** Built-in / structural type names (`Bool`, `String`, `List`, …). */
  types: boolean;
}

/**
 * The interpreter's completion vocabulary, split by kind. Built from the `list` commands' output
 * (see {@link parseListNames} and interpreter/numbat.ts), so it reflects the actual loaded prelude
 * and any user-defined names. Functions and variables are separated (Numbat tags both with the same
 * `identifier` class, so they are read from separate `list` commands) so the completer can label
 * them distinctly.
 */
export interface CompletionVocabulary {
  /** Dimension names (e.g. `Length`, `Time`) — Numbat's `list dimensions`. */
  dimensions: Set<string>;

  /** Unit names (e.g. `meter`, `newton`). */
  units: Set<string>;

  /** Function names (e.g. `sin`, `atan2`). */
  functions: Set<string>;

  /** Variable and constant names (e.g. `pi`, and the user's own `let` bindings). */
  variables: Set<string>;
}

/**
 * Numbat keywords and keyword-operators, surfaced under the "keywords" category. These are the
 * non-name entries of Numbat's completion vocabulary (its `KEYWORDS` table), minus the built-in
 * type names (see {@link BUILTIN_TYPE_NAMES}, surfaced as types) and the decorator names
 * (`aliases`, `name`, …), which only apply after `@` and would clash with ordinary identifiers —
 * those are offered in that position instead, from {@link DECORATORS}, which is the whole set
 * rather than the few Numbat's vocabulary happens to list. The
 * wasm trims the trailing space/`(` Numbat stores on some of these, so they are bare words here.
 */
export const KEYWORDS: ReadonlySet<string> = new Set([
  "NaN",
  "assert",
  "assert_eq",
  "both",
  "dimension",
  "else",
  "false",
  "fn",
  "if",
  "inf",
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
]);

/** Numbat's built-in / structural type names — surfaced as `type` (distinct from the physical
 *  `dimension` names). Numbat lists these among its keywords. */
export const BUILTIN_TYPE_NAMES: ReadonlySet<string> = new Set([
  "Bool",
  "DateTime",
  "Fn",
  "List",
  "String",
]);

/**
 * The long metric prefixes Numbat's completer synthesizes onto prefixable units (matching its
 * `COMMON_METRIC_PREFIXES`). Used to recognize a completion like `kilometer` as a (prefixed) unit
 * even though only `meter` is in the vocabulary.
 */
const METRIC_PREFIXES: readonly string[] = [
  "pico",
  "nano",
  "micro",
  "milli",
  "centi",
  "kilo",
  "mega",
  "giga",
  "tera",
];

/** Whether `name` is a known unit carrying one of the long metric prefixes. */
function isMetricPrefixedUnit(name: string, units: ReadonlySet<string>): boolean {
  for (const prefix of METRIC_PREFIXES) {
    if (name.length > prefix.length && name.startsWith(prefix) && units.has(name.slice(prefix.length))) {
      return true;
    }
  }
  return false;
}

/**
 * Classify one completion candidate against the vocabulary, or `null` when it belongs to no
 * surfaced category — which is how LaTeX `\code` patterns (offered via the unicode leader, not as
 * bare words) and other non-name entries are dropped. Checked most- to least-specific (type,
 * dimension, keyword, function, variable, unit), so a name in more than one bucket keeps its most
 * specific kind.
 */
export function classifyCompletion(name: string, vocab: CompletionVocabulary): ExprCategory | null {
  if (BUILTIN_TYPE_NAMES.has(name)) {
    return "type";
  }
  if (vocab.dimensions.has(name)) {
    return "dimension";
  }
  if (KEYWORDS.has(name)) {
    return "keyword";
  }
  if (vocab.functions.has(name)) {
    return "function";
  }
  if (vocab.variables.has(name)) {
    return "variable";
  }
  if (vocab.units.has(name) || isMetricPrefixedUnit(name, vocab.units)) {
    return "unit";
  }

  return null;
}

/** Whether the group toggle covering `category` is enabled. Each of the five toggles gates one
 *  kind; variables and functions share the "identifiers" toggle. */
function categoryEnabled(category: ExprCategory, enabled: ExprCategories): boolean {
  switch (category) {
    case "variable": // Intentional fallthrough
    case "function": // Intentional fallthrough
    case "field": // Intentional fallthrough
    case "parameter": // Intentional fallthrough — a declaration's own names are names too.
    case "local":
      return enabled.identifiers;
    case "keyword": // Intentional fallthrough — a decorator is syntax, like a keyword.
    case "decorator":
      return enabled.keywords;
    case "unit":
      return enabled.units;
    case "dimension":
      return enabled.dimensions;
    case "type":
      return enabled.types;
  }
}

/**
 * Categorize `rawNames` (the wasm's flat `get_completions_for` list, already prefix-filtered and
 * sorted) and keep those whose category is both enabled (by the user's toggles) and — when
 * `allowed` is given — accepted at this position (see {@link allowedCategoriesAt}). Entries that
 * classify to no category (LaTeX patterns, stray keywords) are dropped, as are duplicates; input
 * order is kept.
 */
export function expressionCompletions(
  rawNames: Iterable<string>,
  vocab: CompletionVocabulary,
  enabled: ExprCategories,
  allowed?: ReadonlySet<ExprCategory> | null,
): ExprCompletion[] {
  const out: ExprCompletion[] = [];
  const seen = new Set<string>();

  for (const name of rawNames) {
    if (name === "" || seen.has(name)) {
      continue;
    }
    const category = classifyCompletion(name, vocab);
    if (category === null || !categoryEnabled(category, enabled)) {
      continue;
    }
    if (allowed && !allowed.has(category)) {
      continue;
    }
    seen.add(name);
    out.push({ name, category });
  }

  return out;
}

// PARSING THE `LIST` COMMANDS' OUTPUT
// ================================================================================================

/** Decode the HTML entities Numbat's jQuery-terminal formatter emits in span text (it escapes
 *  `&`,`<`,`>` and writes `[`/`]` as numeric entities). */
function decodeEntities(text: string): string {
  return text
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Matches one `[[;;;hl-CLASS]CONTENT]` span of Numbat's jQuery-terminal markup. Literal `]` never
 * appears in CONTENT (it is written as `&#93;`), so the content run is simply "up to the next `]`".
 */
const LIST_SPAN = /\[\[;;;hl-[a-z0-9-]+\]([^\]]*)\]/g;

/**
 * Extract the listed names from a single `list functions|units|variables|dimensions` command's
 * jQuery-terminal output. Each name is a class-tagged span; the command (not the class) determines
 * the kind, so every span's text is taken, with layout whitespace — which is not class-tagged —
 * ignored. interpreter/numbat.ts runs the four commands and assembles the {@link
 * CompletionVocabulary}.
 */
export function parseListNames(markup: string): string[] {
  const names: string[] = [];
  for (const match of markup.matchAll(LIST_SPAN)) {
    const name = decodeEntities(match[1]).trim();
    if (name !== "") {
      names.push(name);
    }
  }

  return names;
}

// TRIGGER DETECTION
// ================================================================================================

/** Categories a type-annotation position accepts: types, dimensions, and units. */
const TYPE_ANNOTATION: ReadonlySet<ExprCategory> = new Set<ExprCategory>(["type", "dimension", "unit"]);

/** Categories a dimension position accepts: dimensions only. */
const DIMENSION_ONLY: ReadonlySet<ExprCategory> = new Set<ExprCategory>(["dimension"]);

/** The current line is a `unit <name>:` declaration (optionally decorated), whose `:` introduces a
 *  dimension rather than a full type. */
const UNIT_DECLARATION = /(?:^|\n)\s*(?:@\w+(?:\([^)]*\))?\s+)*unit\s[^\n]*$/;

/** The current line is the body of a `dimension <name> = …` declaration (past the `=`), a dimension
 *  expression. */
const DIMENSION_DECLARATION = /(?:^|\n)\s*(?:@\w+(?:\([^)]*\))?\s+)*dimension\s+\w+[^\n]*=[^\n]*$/;

/**
 * The completion categories a position accepts, or `null` when it accepts all of them (so the
 * caller applies only the user's toggles). A `:` type annotation accepts types, dimensions, and
 * units; the `:` of a `unit <name>:` declaration and the body of a `dimension <name> = …` accept
 * dimensions only — so, as far as the surrounding syntax reveals, a place that wants a dimension
 * does not offer units. `before` is the text up to the completion anchor (see {@link
 * isTypePosition}).
 */
export function allowedCategoriesAt(before: string): ReadonlySet<ExprCategory> | null {
  if (DIMENSION_DECLARATION.test(before)) {
    return DIMENSION_ONLY;
  }
  if (isTypePosition(before)) {
    return UNIT_DECLARATION.test(before) ? DIMENSION_ONLY : TYPE_ANNOTATION;
  }
  if (isGenericOpenPosition(before) || isReturnTypePosition(before)) {
    return TYPE_ANNOTATION;
  }

  return null;
}

/** The trailing Numbat identifier word before the caret: a run starting with a letter or `_` (never
 *  a digit, so numbers do not read as words). Empty when the text does not end in such a run.
 *  Unicode letters/digits are allowed. */
const TRAILING_WORD = /[\p{L}_][\p{L}\p{N}_]*$/u;

/** Characters that can end an expression before a `.`/`:` trigger: an identifier tail, or a closing
 *  bracket. A digit is excluded so `3.`/`3:` do not trigger. */
const EXPR_TAIL = /[\p{L}_)\]]/u;

/** Where an expression completion should be inserted: the query typed so far, and how many
 *  characters before the caret it replaces. */
export interface ExprTrigger {
  /** The text typed so far, matched against the completion vocabulary. */
  query: string;

  /** How many characters before the caret the accepted completion replaces. This is not always
   *  `query.length`: a member path completes only its final segment. */
  replaceLength: number;
}

/** A dotted member-access path (`costs`, `costs.breakdown`). */
const MEMBER_PATH = /[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*$/u;

/**
 * The struct expression whose fields the caret is completing, or `null` when it is not in member
 * position. `costs.` and `costs.ma` both give `costs`; `costs.inner.` gives `costs.inner`. A
 * trailing word is stripped first, so this reads the same whether it is handed the whole text
 * before the caret or only the text before the completion anchor.
 *
 * Whether the base names an actual struct is not decided here — that takes an interpreter (see
 * `structFields` in interpreter/numbat.ts), which is why this stays pure.
 */
export function memberBaseAt(before: string): string | null {
  const word = exprWordPrefixAt(before);

  const beforeWord = before.slice(0, before.length - word.length);
  if (!beforeWord.endsWith(".")) {
    return null;
  }

  return MEMBER_PATH.exec(beforeWord.slice(0, -1))?.[0] ?? null;
}

/** The struct signature Numbat names in a "field does not exist" diagnostic. `.` is newline-blind,
 *  so the greedy match ends at the last quote on that line. */
const MISSING_FIELD = /does not exist in struct '(.*)'/;

/** The innermost balanced `{…}` group that `text` ends with, or `null`. */
function trailingBraces(text: string): string | null {
  const end = text.length - 1;
  if (text[end] !== "}") {
    return null;
  }

  let depth = 0;
  for (let i = end; i >= 0; i -= 1) {
    if (text[i] === "}") {
      depth += 1;
    } else if (text[i] === "{") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(i + 1, end);
      }
    }
  }

  return null;
}

/** One `name: Type` entry of a comma-separated declaration list — a struct's field, a function's
 *  parameter. `type` is `null` when the entry writes none. */
interface ListEntry {
  /** The entry's name, as written. */
  name: string;

  /** Its declared type, as written (`List<D>`, `Money`), or `null`. */
  type: string | null;
}

/** Split a declaration list on its top-level commas, returning each entry's name and written type.
 *  Brackets are tracked so an entry whose own type is a struct, a generic, or an `Fn[(A) -> B]`
 *  does not split in the middle. */
function listEntries(inner: string): ListEntry[] {
  const entries: ListEntry[] = [];
  const open = "{[(<";
  const close = "}])>";
  let depth = 0;
  let start = 0;

  const take = (part: string): void => {
    const colon = part.indexOf(":");
    const name = (colon === -1 ? part : part.slice(0, colon)).trim();
    if (name === "") {
      return;
    }
    const type = colon === -1 ? "" : part.slice(colon + 1).trim();
    entries.push({ name, type: type === "" ? null : type });
  };

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];

    if (open.includes(ch)) {
      depth += 1;
    } else if (close.includes(ch)) {
      depth = Math.max(0, depth - 1); // a bare `>` from an `->` arrow closes nothing
    } else if (ch === "," && depth === 0) {
      take(inner.slice(start, i));
      start = i + 1;
    }
  }

  take(inner.slice(start));
  return entries;
}

/**
 * The field names of the struct a "field does not exist" diagnostic describes, in declaration order
 * — Numbat spells the whole struct out in that message, which is the only place it exposes a
 * value's fields (there is no struct introspection, and `get_completions_for("costs.")` returns
 * nothing).
 *
 * Reading a diagnostic is a deliberate trade: it is one interpreter call and it covers every struct
 * — a note's object properties and a user's own `struct` alike. If a future Numbat rewords the
 * message this returns nothing, so member completion quietly stops rather than misbehaving; the
 * unit tests pin the current wording.
 */
export function structFieldNames(diagnostic: string): string[] {
  const signature = MISSING_FIELD.exec(diagnostic)?.[1];
  if (signature === undefined) {
    return [];
  }

  const inner = trailingBraces(signature.trimEnd());
  return inner === null ? [] : listEntries(inner).map((entry) => entry.name);
}

/** The trailing identifier word in `before`, or `""` when there is none. */
export function exprWordPrefixAt(before: string): string {
  return TRAILING_WORD.exec(before)?.[0] ?? "";
}

/**
 * Whether the text ending just before a completion anchor is a `:` type-annotation position (`let
 * x:`, `fn f(a: …)`, `x: Len`), so completion should offer types. `beforeAnchor` is the text up to
 * where the completion word begins, so it works for both an empty query (`x:`) and a partial one
 * (`x:Le`, whose anchor sits after the colon). Trailing spaces are skipped, so `x: ` reads the same
 * as `x:`; a module path (`units::`) is excluded — the character before the colon must be an
 * identifier tail, not another colon.
 */
export function isTypePosition(beforeAnchor: string): boolean {
  const trimmed = beforeAnchor.replace(/\s+$/, "");
  return trimmed.at(-1) === ":" && EXPR_TAIL.test(trimmed.at(-2) ?? "");
}

// GENERICS: `<` POSITIONS AND TYPE PARAMETERS
// ================================================================================================

/** A capitalized identifier immediately followed by `<`: a generic type's parameter list being
 *  opened (`List<`, `MyStruct<`). Capitalization is the type-name convention (the tokenizer's own
 *  fallback heuristic), and requiring the `<` to touch the name keeps spaced comparisons (`a < b`)
 *  from reading as generics. */
const GENERIC_OPEN = /[\p{Lu}][\p{L}\p{N}_]*<$/u;

/** Whether the anchor sits just inside an opened generic parameter list (`List<`, `x: List< `) — a
 *  type position. Trailing spaces are skipped, as for {@link isTypePosition}. */
export function isGenericOpenPosition(beforeAnchor: string): boolean {
  return GENERIC_OPEN.test(beforeAnchor.replace(/\s+$/, ""));
}

/** The current line is a `fn` declaration (optionally decorated) ending on its return arrow (`fn
 *  f(x: Scalar) -> `). No `=` may have appeared: past the `=` an `->` is the conversion operator,
 *  whose target is a unit expression, not a return type. */
const FN_RETURN_ARROW = /(?:^|\n)\s*(?:@\w+(?:\([^)]*\))?\s+)*fn\s[^\n=]*->\s*$/u;

/** Whether the anchor sits after a `fn` declaration's return arrow — a type position (the same `->`
 *  outside a declaration converts, and is left alone). */
export function isReturnTypePosition(beforeAnchor: string): boolean {
  return FN_RETURN_ARROW.test(beforeAnchor);
}

/** `text` with its comments and string contents blanked out — punctuation inside either must not be
 *  read as code. Blanked rather than removed so every offset into it still lines up with the
 *  source. */
function codeOnly(text: string): string {
  const uncommented = text
    .split("\n")
    .map((line) => {
      const code = stripLineComment(line);
      return code + " ".repeat(line.length - code.length);
    })
    .join("\n");

  return blankStrings(uncommented);
}

/** How many lines above the anchor a declaration's header is looked for. A declaration reaches the
 *  anchor only if every line boundary between the two continues (see {@link declarationStillOpen}),
 *  which a long way up it never does — and this scan runs on every keystroke, so it is not paid
 *  over a whole document. */
const MAX_HEADER_LOOKBACK = 200;

/** The last {@link MAX_HEADER_LOOKBACK} lines of `before`, cut on a line boundary. */
function lookbackWindow(before: string): string {
  let start = before.length;
  for (let n = 0; n < MAX_HEADER_LOOKBACK; n += 1) {
    if (start === 0) {
      return before;
    }
    const newline = before.lastIndexOf("\n", start - 1);
    if (newline === -1) {
      return before;
    }
    start = newline;
  }

  return before.slice(start + 1);
}

/** A `fn`/`struct` declaration header, up to and including the declared name, with any decorators
 *  between the line start and the keyword. The scrapers below scan forward from here. */
const DECLARATION_HEADER =
  /(?:^|\n)[^\S\n]*(?:@\w+(?:\([^)]*\))?[^\S\n]+)*(fn|struct)[^\S\n]+([\p{L}_][\p{L}\p{N}_]*)/gu;

/** One type-parameter entry: its leading identifier and, when present, its `: Dim` bound (the only
 *  bound the grammar admits); a malformed tail is ignored. */
const TYPE_PARAM_ENTRY = /^\s*([\p{L}_][\p{L}\p{N}_]*)\s*(:\s*Dim\b)?/u;

/** One declared type parameter, as the scraper reads it from the header. */
export interface TypeParameter {
  /** The parameter's name, as written in the declaration's header. */
  name: string;

  /** Whether the parameter carries the `: Dim` bound — a dimension variable, surfaced (and colored)
   *  as a dimension rather than a plain type. */
  dimBound: boolean;
}

/** Line tails that continue a declaration across a newline at bracket depth 0 *beyond* the ones
 *  Numbat itself reads on from (syntax/statements.ts): an opener or separator, or `->`. A header
 *  still being typed ends on these, and offering its earlier parameters there is the whole point —
 *  which is why this list is wider than the grouper's. It can afford to be: a false positive here
 *  costs one stray suggestion, while the grouper would merge two real statements' output into one.
 */
const CONTINUES_AFTER = /[,([{<]$|->$/;

/** Line heads that continue the previous line beyond the joining keywords: a closer or a
 *  separator. */
const CONTINUES_BEFORE = /^[)\]},]/;

/**
 * Whether the declaration starting at the beginning of `text` (a `fn`/`struct` header line) is
 * still open at the end of `text` — i.e. every line boundary on the way is a continuation: inside
 * brackets (a parameter list, a struct body), one Numbat itself reads on across (a definition's
 * `=`, a `where`/`and`/`then`/`else` — see syntax/statements.ts), or one of the wider set above,
 * which a half-typed header can also end on. Blank lines defer the judgment to the next non-blank
 * line (the parser skips empty lines after `=` and inside parameter lists). A heuristic, not a
 * parser: a false positive is a harmless extra suggestion; evaluation is never affected.
 *
 * `text` is code the caller has already stripped of comments and blanked of string contents (see
 * {@link codeOnly}), as syntax/statements.ts requires of its own two: a `#` or a quoted `where`
 * would otherwise be read as either.
 */
export function declarationStillOpen(text: string): boolean {
  const lines = text.split("\n");
  let depth = 0;
  let tail = ""; // the last non-blank line's trimmed tail

  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === "(" || ch === "[" || ch === "{") {
        depth += 1;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth = Math.max(0, depth - 1);
      }
    }

    if (line.trim() !== "") {
      tail = line.trimEnd();
    }

    if (depth > 0) {
      continue;
    }

    const head = lines[i + 1].trimStart();
    if (head === "") {
      continue; // judge at the boundary into the next non-blank line
    }

    if (
      !continuesAfter(tail) && !continuesBefore(head)
      && !CONTINUES_AFTER.test(tail) && !CONTINUES_BEFORE.test(head)
    ) {
      return false;
    }
  }

  return true;
}

/** The `fn`/`struct` declaration a position sits inside, and its text from the header through that
 *  position. */
export interface EnclosingDeclaration {
  /** Which keyword opened it. */
  keyword: "fn" | "struct";

  /** The declared name, which its parameters and fields belong to. */
  owner: string;

  /** The declaration's source from the start of its header line through the anchor. */
  header: string;

  /** Offset within {@link header} just past the declared name — where its `<`/`(`/`{` list
   *  opens. */
  nameEnd: number;
}

/**
 * The `fn`/`struct` declaration enclosing the completion anchor, or `null` when it is not inside
 * one. `before` is the (multi-line) text up to the anchor. Only the nearest preceding header
 * matters (declarations do not nest), and only while it is still open at the anchor (see {@link
 * declarationStillOpen}) — which is how a name introduced by a declaration drops out of scope once
 * that declaration ends.
 *
 * One answer to "which declaration am I in", shared by the type-parameter scraper, the parameter
 * scraper, and the hover's declared-symbol lookup (hover/declarations.ts), so the three cannot
 * disagree about where a declaration reaches.
 */
export function enclosingDeclarationAt(before: string): EnclosingDeclaration | null {
  // Matched against blanked source: a paren inside a decorator's own argument (`@example("f()") fn
  // g(x) = x`) would otherwise end the decorator prefix early, and a bracket inside a string would
  // skew the balance the scope check reads. Blanking preserves length, so the offsets below are
  // still offsets of the window.
  const window = lookbackWindow(before);
  const code = codeOnly(window);
  let match: RegExpExecArray | null = null;
  for (const found of code.matchAll(DECLARATION_HEADER)) {
    match = found;
  }
  if (match === null) {
    return null;
  }

  // The match may include the anchoring newline; the header line proper starts after it, and the
  // scope scan starts with that line.
  const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
  const header = window.slice(start);
  if (!declarationStillOpen(code.slice(start))) {
    return null;
  }

  return {
    keyword: match[1] as "fn" | "struct",
    owner: match[2],
    header,
    nameEnd: match.index + match[0].length - start,
  };
}

/** The end of the `<…>` type-parameter list opening at `from` in `header`, or `from` when none
 *  opens there. The grammar keeps the list on one line, so an unclosed one (still being typed)
 *  ends at the line's end. */
function typeParamsEnd(header: string, from: number): number {
  if (!/^[^\S\n]*</.test(header.slice(from))) {
    return from;
  }

  const close = header.indexOf(">", from);
  const lineEnd = header.indexOf("\n", from);
  if (close !== -1 && (lineEnd === -1 || close < lineEnd)) {
    return close + 1;
  }
  return lineEnd === -1 ? header.length : lineEnd;
}

/**
 * The type parameters of the declaration enclosing the completion anchor, in declaration order —
 * `[{D, dimBound}, {E}]` for an anchor inside `fn foo<D: Dim, E>(…)` — or `[]` when the anchor is
 * not inside a declaration that has any. An unclosed list (`fn foo<D: Dim, E`) is read as far as it
 * goes, so a header still being typed already offers its earlier parameters.
 */
export function typeVariablesInScopeAt(before: string): TypeParameter[] {
  const declaration = enclosingDeclarationAt(before);
  return declaration === null ? [] : typeParametersOf(declaration);
}

/** The type parameters `declaration` binds, for a caller that has already resolved it — so the
 *  hover, which needs the declaration itself as well, does not scan for it twice. */
export function typeParametersOf(declaration: EnclosingDeclaration): TypeParameter[] {
  const { header, nameEnd } = declaration;
  const open = /^[^\S\n]*</.exec(header.slice(nameEnd));
  if (open === null) {
    return []; // no type-parameter list on this declaration
  }

  // The list runs to its `>` or — while still being typed — the line's end.
  const listStart = nameEnd + open[0].length;
  const end = typeParamsEnd(header, nameEnd);
  const listEnd = header[end - 1] === ">" ? end - 1 : end;

  const parameters: TypeParameter[] = [];
  for (const entry of header.slice(listStart, listEnd).split(",")) {
    const match = TYPE_PARAM_ENTRY.exec(entry);
    if (match !== null && !parameters.some((parameter) => parameter.name === match[1])) {
      parameters.push({ name: match[1], dimBound: match[2] !== undefined });
    }
  }

  return parameters;
}

// THE NAMES A DECLARATION BINDS
// ================================================================================================

/** A name a declaration introduces into its own body, which exists nowhere else — no interpreter
 *  context has heard of it, and an outer binding that happens to share it is a different thing. */
export interface DeclaredName {
  /** How the declaration introduces it: a `fn`'s parameter, a `struct`'s field, or a `where`/`and`
   *  local binding in a function's body. */
  kind: "parameter" | "field" | "local";

  /** The name, as written. */
  name: string;

  /** Its declared type, as written (`List<D>`, `Money`), or `null` when it carries none. */
  type: string | null;
}

/** A `where` or `and` local binding: the keyword, the bound name, its optional annotation, and the
 *  `=` that makes it a binding rather than a comparison. */
const WHERE_BINDING =
  /(?<![\p{L}\p{N}_])(?:where|and)[^\S\n]+([\p{L}_][\p{L}\p{N}_]*)[^\S\n]*(?::[^\S\n]*([^=\n]+?)[^\S\n]*)?=(?!=)/gu;

/** An entry's name, as the grammar writes one — a half-typed list yields parts that are not names
 *  at all, and those are not offered. */
const NAME_ONLY = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** The `[from, to)` of the list `opener` opens at or after `from` in `code`, or `null` when none
 *  does. An unclosed list — one still being typed — runs to the end of the text. */
function listRange(code: string, from: number, opener: string): { from: number; to: number; } | null {
  const start = code.indexOf(opener, from);
  if (start === -1) {
    return null;
  }

  const closer = opener === "(" ? ")" : "}";
  let depth = 0;
  for (let i = start; i < code.length; i += 1) {
    if (code[i] === opener) {
      depth += 1;
    } else if (code[i] === closer) {
      depth -= 1;
      if (depth === 0) {
        return { from: start + 1, to: i };
      }
    }
  }

  return { from: start + 1, to: code.length };
}

/**
 * Every name `declaration` introduces into its own body, in the order it introduces them: a `fn`'s
 * parameters and then its `where`/`and` locals, or a `struct`'s fields. `[]` when the declaration
 * has not got as far as its list yet.
 *
 * The header is read as far as it goes, so a declaration still being typed already reports the
 * names it has committed to — which is what lets the completer offer a parameter while the
 * signature is unfinished. Comments and string contents are blanked first, so a `where x =`
 * written inside an `@example` is not read as a binding.
 */
export function declaredNamesIn(declaration: EnclosingDeclaration): DeclaredName[] {
  const code = codeOnly(declaration.header);
  const listOpener = declaration.keyword === "fn" ? "(" : "{";
  const list = listRange(code, typeParamsEnd(code, declaration.nameEnd), listOpener);
  if (list === null) {
    return [];
  }

  const kind = declaration.keyword === "fn" ? "parameter" : "field";
  const names: DeclaredName[] = listEntries(code.slice(list.from, list.to))
    .filter((entry) => NAME_ONLY.test(entry.name))
    .map((entry) => ({ kind, name: entry.name, type: entry.type }));

  if (declaration.keyword === "struct") {
    return names;
  }

  // The locals come from the body, which starts once the parameter list has closed.
  for (const match of code.slice(list.to).matchAll(WHERE_BINDING)) {
    const [, name, type] = match;
    if (!names.some((declared) => declared.name === name)) {
      names.push({ kind: "local", name, type: type === undefined ? null : type.trim() });
    }
  }

  return names;
}

/**
 * Whether the interpreter can be asked about a row of this category — for its `type()` signature,
 * or for the `print_info` card the dwell popup shows.
 *
 * False for the three it has never heard of. A decorator has no runtime existence at all; a
 * parameter and a `where` local exist only inside their declaration, where an outer binding that
 * happens to share the name would answer in their place — putting someone else's signature on the
 * row. Those describe themselves instead, through `doc` / `declared`.
 */
export function isInterpreterKnown(category: ExprCategory): boolean {
  return category !== "decorator" && category !== "parameter" && category !== "local";
}

/**
 * The names the enclosing declaration binds, as completions: a `fn`'s parameters and its
 * `where`/`and` locals, each tagged with its own category and carrying what its card says. `[]`
 * when the anchor is not inside a `fn`, or is at a type position (`allowed` non-null — a parameter
 * is a value, and it is the *type* variables that belong there instead).
 *
 * A struct's fields are deliberately left out: they are names of a type, reachable only through a
 * value of it (`costs.total`, which member completion already covers), never bare in an expression.
 *
 * Gated on the identifiers toggle and prefix-filtered against the typed query, which the engine
 * could not do — it does not know these names at all. `scopeText` is the multi-line text up to the
 * anchor (see {@link enclosingDeclarationAt}).
 */
export function declaredNameCompletions(
  scopeText: string,
  query: string,
  enabled: ExprCategories,
  allowed: ReadonlySet<ExprCategory> | null,
): ExprCompletion[] {
  if (allowed !== null || !enabled.identifiers) {
    return [];
  }

  const declaration = enclosingDeclarationAt(scopeText);
  if (declaration === null || declaration.keyword !== "fn") {
    return [];
  }

  return declaredNamesIn(declaration)
    .filter((declared) => declared.kind !== "field" && declared.name.startsWith(query))
    .map(({ kind, name, type }) => ({
      name,
      category: kind as "parameter" | "local",
      declared: { kind: kind as "parameter" | "local", type, owner: declaration.owner },
    }));
}

/**
 * The enclosing declaration's type variables as completions — a `Dim`-bounded parameter is surfaced
 * (and colored) as a `dimension`, an unbounded one as a plain `type` — or `[]` when there are none
 * to offer. They are offered only at recognized type positions (`allowed` non-null: a `:`
 * annotation, an opened generic list, or a return arrow — a type variable is meaningless in a value
 * expression), each gated by its own category toggle, and prefix-filtered against the typed query
 * (the engine cannot: it does not know these names). `scopeText` is the multi-line text up to the
 * anchor (see {@link typeVariablesInScopeAt}).
 */
export function typeVariableCompletions(
  scopeText: string,
  query: string,
  enabled: ExprCategories,
  allowed: ReadonlySet<ExprCategory> | null,
): ExprCompletion[] {
  if (allowed === null) {
    return [];
  }

  return typeVariablesInScopeAt(scopeText)
    .map(({ name, dimBound }) => ({ name, category: dimBound ? ("dimension" as const) : ("type" as const) }))
    .filter(({ name, category }) =>
      name.startsWith(query)
      && allowed.has(category)
      && (category === "dimension" ? enabled.dimensions : enabled.types)
    );
}

/** The current line is a `fn`/`struct` header whose type-parameter list is still open at the
 *  anchor, ending on a parameter's bound colon (`fn foo<D: `). */
const BOUND_POSITION =
  /(?:^|\n)[^\S\n]*(?:@\w+(?:\([^)]*\))?[^\S\n]+)*(?:fn|struct)[^\S\n]+[\p{L}_][\p{L}\p{N}_]*[^\S\n]*<[^>\n]*:[^\S\n]*$/u;

/** Whether the anchor sits on a type-parameter bound (`fn foo<D: `). */
export function isBoundPosition(beforeAnchor: string): boolean {
  return BOUND_POSITION.test(beforeAnchor);
}

/**
 * The completions for a type-parameter bound position, or `null` when the anchor is not at one. The
 * grammar admits exactly one bound — `Dim` — so the position offers that single name, tagged as a
 * dimension (it is the bound all dimensions satisfy) and so gated on the dimensions toggle,
 * prefix-filtered against the typed query. Callers short-circuit on a non-null result *instead of*
 * asking the engine: every engine candidate is a parse error in this position (and `Dim` itself is
 * in no vocabulary).
 */
export function boundCompletions(
  beforeAnchor: string,
  query: string,
  enabled: ExprCategories,
): ExprCompletion[] | null {
  if (!isBoundPosition(beforeAnchor)) {
    return null;
  }

  if (!enabled.dimensions || !"Dim".startsWith(query)) {
    return [];
  }

  return [{ name: "Dim", category: "dimension" }];
}

// DECORATORS
// ================================================================================================

/** One Numbat decorator: what it is called, what accepting it writes, and one line about it. */
interface DecoratorDef {
  /** The name, without its `@`. */
  name: string;

  /** What is written after the `@`, and where the caret lands in it. Decorators that take an
   *  argument write their mandatory punctuation, since the name alone never parses. */
  applied: { text: string; caret: number; };

  /** The one-line description shown on the row's card. */
  doc: string;
}

/** A decorator taking a single string argument, whose caret belongs between the quotes. */
function stringArg(name: string, doc: string): DecoratorDef {
  return { name, applied: { text: `${name}("")`, caret: name.length + 2 }, doc };
}

/**
 * Numbat's decorators — the complete set its parser accepts (`parse_decorators`), which is closed:
 * an unknown name is a parse error, and the interpreter exposes no decorator vocabulary to ask, so
 * the list lives here. Ordered as they are usually written, annotation before behavior, rather than
 * alphabetically.
 */
const DECORATORS: readonly DecoratorDef[] = [
  stringArg("name", "The unit's full, human-readable name, as shown when it is described."),
  stringArg("description", "A sentence describing the definition, shown on completion and hover."),
  stringArg("url", "A reference URL for the definition, linked wherever it is described."),
  stringArg("example", "Example code for a function. A second string argument describes it."),
  {
    name: "aliases",
    applied: { text: "aliases()", caret: "aliases(".length },
    doc: "Alternative names for a unit, comma-separated. Each may carry a suffix — short, long, "
      + "both or none — saying which spellings a prefix may attach to.",
  },
  {
    name: "metric_prefixes",
    applied: { text: "metric_prefixes", caret: "metric_prefixes".length },
    doc: "Allow metric prefixes on the unit: kilometer, millisecond.",
  },
  {
    name: "binary_prefixes",
    applied: { text: "binary_prefixes", caret: "binary_prefixes".length },
    doc: "Allow binary prefixes on the unit: kibibyte, mebibyte.",
  },
  {
    name: "abbreviation",
    applied: { text: "abbreviation", caret: "abbreviation".length },
    doc: "Mark the unit as shorthand for a compound one, like mph, so results are not simplified to it.",
  },
];

/** The one-line description of the decorator `name` (written without its `@`), or `null` when it is
 *  not one of Numbat's. Lets a surface with only a name in hand — a hover — build the same card the
 *  completer shows. */
export function decoratorDoc(name: string): string | null {
  return DECORATORS.find((decorator) => decorator.name === name)?.doc ?? null;
}

/** The anchor sits directly after an `@` that opens a decorator: at the start of a statement, with
 *  only whitespace and complete decorators before it. Written against the whole text up to the
 *  anchor, so a mid-expression `@` — or one inside a string — does not match. */
const DECORATOR_POSITION = /(?:^|\n)[^\S\n]*(?:@\w+(?:\([^)]*\))?[^\S\n]*)*@$/;

/** Whether the anchor sits just after a decorator's `@`. */
export function isDecoratorPosition(beforeAnchor: string): boolean {
  return DECORATOR_POSITION.test(beforeAnchor);
}

/**
 * The completions for a decorator position, or `null` when the anchor is not at one. Like {@link
 * boundCompletions}, callers short-circuit on a non-null result *instead of* asking the engine:
 * every engine candidate is a parse error after an `@`, and no decorator name is in any vocabulary.
 * Gated on the keywords toggle — a decorator is syntax rather than a name — and prefix-filtered
 * against the typed query, which the engine could not do.
 *
 * `admitsStatements` is false on the surfaces that hold an *expression* rather than a statement —
 * an inline-eval span, a Numbat-typed frontmatter value — where a decorator has nothing to annotate
 * and so can never be written at all. The position is still claimed (an empty list, not `null`):
 * the engine's names are no more legal after an `@` than the decorators are, so offering them would
 * only dress a syntax error up as a completion.
 */
export function decoratorCompletions(
  beforeAnchor: string,
  query: string,
  enabled: ExprCategories,
  admitsStatements: boolean,
): ExprCompletion[] | null {
  if (!isDecoratorPosition(beforeAnchor)) {
    return null;
  }

  if (!enabled.keywords || !admitsStatements) {
    return [];
  }

  const prefix = query.toLowerCase();
  return DECORATORS
    .filter((decorator) => decorator.name.startsWith(prefix))
    .map(({ name, applied, doc }) => ({ name, category: "decorator" as const, applied, doc }));
}

/**
 * Decide whether an expression completion should open for text ending at the caret, and on what
 * query. The triggers:
 *
 *   * a partial word of at least two characters (`me` → complete `meter`, …);
 *   * a `.` immediately after an expression (`foo.`), which opens the completer with an empty query
 *     and keeps it open as the member word is typed (`foo.ba`);
 *   * a `:` type annotation (`let x:`), which stays open across the conventional space (`let x: `)
 *     and completes the type from its first character (`x: L`);
 *   * an opened generic parameter list (`List<`), which likewise completes the type argument from
 *     its first character;
 *   * a `fn` declaration's return arrow (`fn f(x: Scalar) -> `) — but not a conversion arrow, which
 *     sits outside a declaration.
 *   * a decorator's `@` at the start of a statement (`@`, `@na`), which offers the closed set of
 *     decorator names from the first character.
 *
 * The two-character minimum keeps the popover from flickering on every single character; the other
 * triggers mark member/type positions, and relax it so those complete from the first character.
 * Returns `null` when none applies.
 *
 * It does *not* consider the unicode or history leaders — the caller defers to those completers
 * first (that is the "disambiguated with the leaders" rule), so this only sees text that is not
 * part of a `\code` or a history query.
 */
export function exprTriggerAt(before: string): ExprTrigger | null {
  const word = exprWordPrefixAt(before);
  const beforeWord = before.slice(0, before.length - word.length);

  // A decorator's `@` is checked before the two-character minimum, so the popover opens on the `@`
  // itself and lists the whole (small, closed) set. The `@` is not part of the replacement.
  if (isDecoratorPosition(beforeWord)) {
    return { query: word, replaceLength: word.length };
  }

  if (word.length >= 2) {
    return { query: word, replaceLength: word.length };
  }

  // A short (0–1 char) word triggers when it directly follows `.`/`:` after an expression — so a
  // member or type position completes from the first character.
  const punct = beforeWord.at(-1);
  if ((punct === "." || punct === ":") && EXPR_TAIL.test(beforeWord.at(-2) ?? "")) {
    return { query: word, replaceLength: word.length };
  }

  // A `:` type annotation keeps completing across the conventional space, since `: Type` is written
  // far more often than `:Type`. (`.` member access is not relaxed this way — `foo. bar` is not
  // member access.)
  if (isTypePosition(beforeWord)) {
    return { query: word, replaceLength: word.length };
  }

  // The other type positions — a generic's argument (`List<`) and a declaration's return type (`fn
  // f(…) -> `) — also complete from the first character.
  if (isGenericOpenPosition(beforeWord) || isReturnTypePosition(beforeWord)) {
    return { query: word, replaceLength: word.length };
  }

  return null;
}
