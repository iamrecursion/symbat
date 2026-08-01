// Pure helpers for Numbat *expression* completion: turning the interpreter's completion vocabulary
// into categorized completions (variables, functions, units, types, keywords), and deciding where —
// and on what — the completer should trigger.
//
// No imports (no Obsidian, CodeMirror, or wasm), so this is unit-testable in isolation, mirroring
// unicode/codes.ts. interpreter/numbat.ts feeds it the wasm's data (the flat `get_completions_for`
// list, and the categorized names parsed from the `list` commands); the editor suggester and the
// REPL completer feed it the text at the cursor.
//
// Why the categories are computed here rather than taken from the wasm: Numbat's
// `get_completions_for` returns one flat, prefix-filtered list mixing keywords, LaTeX `\code`
// patterns, variables, functions, dimensions, and units, with no category tag. We recover the
// category of each candidate by cross-referencing a vocabulary built from the interpreter's own
// `list functions|units|variables| dimensions` output, plus the two static sets below.

/**
 * A completion's fine-grained category — its display label and highlight color. Each of the five
 * settings toggles gates one group: `variable`/`function` are "identifiers", `unit` is "units",
 * `dimension` is "dimensions", `type` is "types", and `keyword` is "keywords". `type` is a
 * built-in/structural type (`Bool`, `String`, `List`, …); `dimension` is a physical dimension
 * (`Length`, `Time`, …) — Numbat renders both as type identifiers, but they are distinct kinds.
 */
export type ExprCategory = "variable" | "function" | "unit" | "dimension" | "type" | "keyword" | "field";

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
 * type names (see {@link BUILTIN_TYPE_NAMES}, surfaced as types) and the decorator argument words
 * (`aliases`, `name`, …), which only apply after `@` and would clash with ordinary identifiers. The
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
    case "field":
      return enabled.identifiers;
    case "keyword":
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

/** Split a struct's field list on its top-level commas, returning each field's name. Brackets are
 *  tracked so a field whose own type is a struct, a generic, or an `Fn[(A) -> B]` does not split in
 *  the middle. */
function fieldNames(inner: string): string[] {
  const names: string[] = [];
  const open = "{[(<";
  const close = "}])>";
  let depth = 0;
  let start = 0;

  const take = (part: string): void => {
    const colon = part.indexOf(":");
    const name = (colon === -1 ? part : part.slice(0, colon)).trim();
    if (name !== "") {
      names.push(name);
    }
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
  return names;
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
  return inner === null ? [] : fieldNames(inner);
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

/** A `fn`/`struct` declaration header opening a type-parameter list, up to and including its `<`.
 *  Kept to one line (matching the grammar: the parser accepts no newline tokens inside `<…>`), with
 *  any decorators between the line start and the keyword. The scraper scans forward from here. */
const TYPE_PARAMS_HEADER =
  /(?:^|\n)[^\S\n]*(?:@\w+(?:\([^)]*\))?[^\S\n]+)*(?:fn|struct)[^\S\n]+[\p{L}_][\p{L}\p{N}_]*[^\S\n]*</gu;

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

/** Line tails that continue a declaration across a newline at bracket depth 0: an opener or
 *  separator, `=` (the body may start on the next line), or `->`. */
const CONTINUES_AFTER = /[,([{=<]$|->$/;

/** Line heads that continue the previous line: a closer, a separator, or the `where`/`and`
 *  local-variable keywords (which the parser accepts across linebreaks). */
const CONTINUES_BEFORE = /^(?:[)\]},]|where\b|and\b)/;

/**
 * Whether the declaration starting at the beginning of `text` (a `fn`/`struct` header line) is
 * still open at the end of `text` — i.e. every line boundary on the way is a continuation: inside
 * brackets (a parameter list, a struct body), after a tail that cannot end a statement, or before a
 * head that continues one. Blank lines defer the judgment to the next non-blank line (the parser
 * skips empty lines after `=` and inside parameter lists). A heuristic, not a parser: a false
 * positive is a harmless extra suggestion; evaluation is never affected.
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

    if (!CONTINUES_AFTER.test(tail) && !CONTINUES_BEFORE.test(head)) {
      return false;
    }
  }

  return true;
}

/**
 * The type parameters of the declaration enclosing the completion anchor, in declaration order —
 * `[{D, dimBound}, {E}]` for an anchor inside `fn foo<D: Dim, E>(…)` — or `[]` when the anchor is
 * not inside a declaration that has any. `before` is the (multi-line) text up to the anchor. Only
 * the nearest preceding `fn`/`struct` header matters (declarations do not nest), and only while it
 * is still open at the anchor (see {@link declarationStillOpen}); an unclosed list (`fn foo<D: Dim,
 * E`) is read as far as it goes, so a header still being typed already offers its earlier
 * parameters.
 */
export function typeVariablesInScopeAt(before: string): TypeParameter[] {
  let header: RegExpExecArray | null = null;
  for (const match of before.matchAll(TYPE_PARAMS_HEADER)) {
    header = match;
  }
  if (header === null) {
    return [];
  }

  // The match may include the anchoring newline; the header line proper starts after it, and the
  // scope scan starts with that line.
  const start = header.index + (header[0].startsWith("\n") ? 1 : 0);
  if (!declarationStillOpen(before.slice(start))) {
    return [];
  }

  // The parameter list runs to its `>` or — while still being typed — the line's end (the grammar
  // keeps the list on one line).
  const listStart = header.index + header[0].length;
  let listEnd = before.indexOf(">", listStart);
  const lineEnd = before.indexOf("\n", listStart);
  if (listEnd === -1 || (lineEnd !== -1 && lineEnd < listEnd)) {
    listEnd = lineEnd === -1 ? before.length : lineEnd;
  }

  const parameters: TypeParameter[] = [];
  for (const entry of before.slice(listStart, listEnd).split(",")) {
    const match = TYPE_PARAM_ENTRY.exec(entry);
    if (match !== null && !parameters.some((parameter) => parameter.name === match[1])) {
      parameters.push({ name: match[1], dimBound: match[2] !== undefined });
    }
  }

  return parameters;
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
  if (word.length >= 2) {
    return { query: word, replaceLength: word.length };
  }
  const beforeWord = before.slice(0, before.length - word.length);

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
