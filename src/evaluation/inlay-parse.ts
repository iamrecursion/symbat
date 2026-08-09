import type { NumbatBlockRange } from "../document/fences";

// Pure helpers for the inlay-hint pass (evaluation/inlay.ts). Given a single Numbat line's
// interpreter output, or the line's source text, these extract the pieces the hints render: a
// declaration's inferred type, an expression's result, the column at which to anchor a type hint,
// and — for an incomplete expression — the completable "typed hole" form to re-evaluate and the
// type it reports.
//
// Everything here is string-only: no Obsidian, CodeMirror, or wasm imports, so it is unit-testable
// in isolation (like completion/expressions.ts / document/fences.ts). The HTML shapes matched below
// come from Numbat's own `HtmlFormatter`; the integration tests pin them against the real wasm so a
// version bump that changes them fails loudly rather than silently dropping hints.

// READING THE FORMATTER'S OUTPUT
// ================================================================================================

/** The single-class operator spans Numbat's HTML formatter emits for `:` and `=`. */
const COLON_SPAN = `<span class="numbat-operator">:</span>`;

/** The `=` separating a statement's echo from its value, and so where the echo ends. */
const EQUALS_SPAN = `<span class="numbat-operator">=</span>`;

/** The split of a single statement's interpreter output into its echoed source and its result.
 *  `result` is `null` for statements that produce no value — a declaration, a command, a comment,
 *  or a blank line. */
export interface InterpretParts {
  /** The formatter's echo of the statement (HTML), e.g. `let x: Length = 5 metre`. */
  echo: string;

  /** The result fragment (HTML), e.g. `<span…>=</span> … [Length]`, or `null`. */
  result: string | null;
}

/**
 * Split one statement's HTML output into its echo and result. Numbat wraps a statement's output as
 * `\n{echo}\n\n{result}\n` (the result absent for a declaration/command), so the first blank line
 * separates the two. Leading and trailing blank lines — and the result's leading indentation — are
 * stripped.
 */
export function splitInterpretOutput(html: string): InterpretParts {
  const trimmed = html.replace(/^\n+/, "");
  const sep = trimmed.indexOf("\n\n");
  if (sep === -1) {
    const echo = trimmed.replace(/\n+$/, "").trim();
    return { echo, result: null };
  }
  const echo = trimmed.slice(0, sep).trim();
  const result = trimmed.slice(sep + 2).replace(/\n+$/, "").trim();
  return { echo, result: result === "" ? null : result };
}

/**
 * Extract the `: Type` annotation fragment (HTML) from a declaration's echo — the span run from the
 * type-annotation colon up to (but excluding) the `=` — or `null` when the echo carries no such
 * annotation. The engine always emits the inferred type here for a `let`/`unit` binding (e.g. `let
 * x: Length = 5 metre`), so rendering this fragment reuses the formatter's own dimension coloring.
 */
export function declarationTypeHtml(echo: string): string | null {
  const colon = echo.indexOf(COLON_SPAN);
  if (colon === -1) {
    return null;
  }

  const equals = echo.indexOf(EQUALS_SPAN, colon + COLON_SPAN.length);
  const end = equals === -1 ? echo.length : equals;
  const fragment = echo.slice(colon, end).trim();

  return fragment === "" ? null : fragment;
}

// DECLARATIONS
// ================================================================================================

/** A `let` / `unit` declaration recognized in a line of source. */
export interface DeclarationSite {
  /** The declaration keyword. */
  keyword: "let" | "unit";

  /** The declared name (for evaluating a `let` binding's value). */
  name: string;

  /** Column (0-indexed, in characters) just past the declared name — where an inferred `: Type`
   *  hint is anchored. */
  nameEnd: number;

  /** Whether the source already writes an explicit `: Type` annotation (so no inferred hint should
   *  be shown — the user has stated the type themselves). */
  annotated: boolean;
}

// `let`/`unit` followed by the declared name, past any decorators written on the same line
// (`@metric_prefixes unit foo = …`; decorators on lines of their own are folded into the statement
// by `groupStatements`, which reports the line this must be matched against). Identifiers are
// Unicode letters, digits (not first), and `_`, matching Numbat's identifier rule closely enough
// for hint placement (evaluation is unaffected if an exotic name is missed).
const DECLARATION = /^(\s*)(?:@\w+(?:\([^)]*\))?\s+)*(let|unit)\s+([\p{L}_][\p{L}\p{N}_]*)/u;

/**
 * Recognize a `let` / `unit` declaration at the start of `line`, reporting where its name ends (for
 * anchoring a type hint) and whether the user already wrote an explicit `: Type` annotation.
 * Returns `null` when the line is not such a declaration.
 */
export function declarationSite(line: string): DeclarationSite | null {
  const src = stripLineComment(line);
  // Matched against string-blanked source, so a paren inside a decorator's own argument
  // (`@example("f()") let x = …`) does not end the prefix early. Blanking preserves length, so
  // `nameEnd` is still a column of `src`, and the keyword and name lie outside any string.
  const match = DECLARATION.exec(blankStrings(src));
  if (match === null) {
    return null;
  }
  const nameEnd = match[0].length;

  // An explicit annotation is a `:` before the binding's `=` (or anywhere, for a valueless
  // base-unit declaration like `unit foo`).
  const rest = src.slice(nameEnd);
  const equals = rest.indexOf("=");
  const beforeValue = equals === -1 ? rest : rest.slice(0, equals);

  return { keyword: match[2] as "let" | "unit", name: match[3], nameEnd, annotated: beforeValue.includes(":") };
}

// VALUES AND PLAIN TEXT
// ================================================================================================

/**
 * Drop the trailing `[dimension]` annotation from a result fragment, keeping just the `= value`
 * part. Numbat wraps the ` [Dim]` suffix in `numbat-dimmed` spans, so the fragment is cut at the
 * first of those. Used for a `let` binding's value hint, whose type is already shown inline (so
 * repeating the dimension is noise).
 */
export function resultValueHtml(resultHtml: string): string {
  const dimmed = resultHtml.indexOf(`<span class="numbat-dimmed">`);
  return dimmed === -1 ? resultHtml : resultHtml.slice(0, dimmed).trimEnd();
}

/** Strip HTML tags and decode the entities Numbat's formatter emits, for text comparison (never
 *  for display), and — via inline-eval — for committing a computed value into the note as plain
 *  text. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Collapse whitespace runs to a single space and trim, for lenient comparison. */
function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Whether a `let` binding's evaluated value is textually the same as the source expression it binds
 * — so showing it as a hint would merely repeat the code (`let x = 5 m` evaluates to `5 m`).
 * Compares the plain-text value (its leading `=` removed) against the source's right-hand side,
 * ignoring whitespace. `let x = 1 + 3` (value `4`) differs from its source, so it is not redundant.
 *
 * `text` is a whole statement, which is not always one line: a decorated declaration carries its
 * annotations above it, and a bracketed value spans until it closes. So comments come off line by
 * line, and the binding's `=` is sought in code rather than in a string a decorator's own text may
 * hold (`@description("x = 5")`).
 */
export function bindingValueRepeatsSource(text: string, valueHtml: string): boolean {
  const src = text.split("\n").map(stripLineComment).join("\n");
  const equals = blankStrings(src).indexOf("=");
  if (equals === -1) {
    return false;
  }

  const rhs = normalizeSpaces(src.slice(equals + 1));
  const value = normalizeSpaces(plainText(resultValueHtml(valueHtml)).replace(/^=\s*/, ""));

  return rhs === value;
}

/**
 * Strip a trailing `#` line comment from Numbat source, honoring string literals (a `#` inside
 * `"…"` is not a comment). Returns the code portion.
 */
export function stripLineComment(line: string): string {
  let inString = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inString) {
      if (ch === "\\") {
        i += 1; // skip the escaped character
      } else if (ch === "\"") {
        inString = false;
      }
    } else if (ch === "\"") {
      inString = true;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }

  return line;
}

// ERROR DIAGNOSTICS
// ================================================================================================

// The pieces of a codespan-style diagnostic the summary is drawn from: the `error: <header>` first
// line; a source-echo line (line number in the gutter, skipped); a marker line (bare `│` gutter,
// then caret/underline art, then the annotation text); and an `= <note>` line.
const ERROR_HEADER = /^error:\s*(.*)$/;
const SOURCE_GUTTER = /^\s*\d+\s*│/;
const BAR_GUTTER = /^\s*│\s?/;
const MARKER_ART = /^[\^\-─│ ]+/;
const NOTE_LINE = /^\s*=\s+(.*)$/;

/**
 * One informative line for an error diagnostic, as plain text — the full output is multi-line
 * source-position art; a single line is what an inline hint has room for. The header is used when
 * it names the problem (`error: Could not solve …`); a generic stage header (`error: while type
 * checking`, `error: runtime error`) defers to the annotation on the caret markers (`^^^ unknown
 * identifier` — longest wins, it is the most specific), then to the first `= note` (`= User error:
 * boom`), then falls back to the header itself. `null` when the output has no non-blank line at
 * all. Shared by the code-block inlay hints and inline evaluation.
 */
export function errorSummary(output: string): string | null {
  let header: string | null = null;
  const labels: string[] = [];
  const notes: string[] = [];

  for (const raw of plainText(output).split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      continue;
    }

    if (header === null) {
      const match = ERROR_HEADER.exec(line.trim());
      header = match !== null ? match[1].trim() : line.trim();
      continue;
    }

    const note = NOTE_LINE.exec(line);
    if (note !== null) {
      notes.push(note[1].trim());
      continue;
    }

    if (SOURCE_GUTTER.test(line)) {
      continue; // the echoed source line, not an annotation
    }

    const gutter = BAR_GUTTER.exec(line);
    if (gutter === null) {
      continue;
    }

    const rest = line.slice(gutter[0].length);
    const art = MARKER_ART.exec(rest);
    if (art === null || !/[\^\-─│]/.test(art[0])) {
      continue; // no marker art, so no annotation on this line
    }

    const label = rest.slice(art[0].length).trim();
    if (label !== "") {
      labels.push(label);
    }
  }

  if (header !== null && !/^while /.test(header) && header !== "runtime error") {
    return header;
  }

  const label = labels.reduce<string | null>((a, b) => (a === null || b.length > a.length ? b : a), null);
  return label ?? notes[0] ?? header;
}

// INCOMPLETE EXPRESSIONS
// ================================================================================================

// A single trailing operator that expects a right-hand operand — the same set the tokenizer treats
// as operators (including the Unicode conversion arrow `→`).
const TRAILING_OPERATOR = /[-+*/^=<>!·×÷°%→]$/u;

// A trailing `(` or `,` opens an argument position that expects an operand.
const TRAILING_OPEN = /[(,]$/;

/**
 * Turn an incomplete expression into a completable form with a single Numbat typed hole (`?`) in
 * the operand slot it is missing, so re-evaluating it makes the type checker report the expected
 * type. Handles a trailing binary operator or conversion arrow (`3 m +` → `3 m + ?`), an open call
 * or argument separator (`sin(` → `sin(?)`, `max(1,` → `max(1, ?)`), and balances any still-open
 * parentheses. Returns `null` when the line has no such missing-operand slot (e.g. it is blank, a
 * comment, or already a complete expression).
 */
export function holeForm(line: string): string | null {
  const src = stripLineComment(line).trimEnd();

  if (src === "") {
    return null;
  }

  if (!TRAILING_OPERATOR.test(src) && !TRAILING_OPEN.test(src)) {
    return null;
  }

  let candidate = `${src} ?`;
  const opens = (candidate.match(/\(/g) ?? []).length;
  const closes = (candidate.match(/\)/g) ?? []).length;
  if (opens > closes) {
    candidate += ")".repeat(opens - closes);
  }

  return candidate;
}

/**
 * Extract the hole's type from the `Found typed hole` diagnostic Numbat produces for a {@link
 * holeForm} expression (`Found a hole of type 'Length' …`). Returns `null` when the output is not
 * that diagnostic, or when the type is the fully-polymorphic `forall …` (an unconstrained hole,
 * e.g. a bare `let x = ?`), which carries no useful information.
 */
export function parseHoleType(output: string): string | null {
  const text = output.replace(/<[^>]*>/g, "");
  const match = text.match(/Found a hole of type '([^']+)'/);
  if (match === null) {
    return null;
  }

  const type = match[1].trim();
  if (type === "" || /^forall\b/.test(type)) {
    return null;
  }

  return type;
}

// HINTS
// ================================================================================================

/** A single inlay hint to place in a block, positioned relative to the block body. */
export interface Hint {
  /** 0-indexed line within the block body. */
  bodyLine: number;

  /** Column (characters) within that line to anchor the widget at. */
  column: number;

  /** What the hint reports: an inferred `type` (rendered inline, at `column`), a computed `result`,
   *  the type filling a typed `hole`, or an `error` summary. Each maps to its own CSS class and to
   *  a filter the user can switch off. */
  kind: "type" | "result" | "hole" | "error";

  /** Formatter HTML (for `type`/`result`) or plain text (the hole's type for `hole`, the diagnostic
   *  summary for `error`). */
  content: string;

  /** Virtual spaces to render before an end-of-line hint (0 or 1), so it sits one space from the
   *  code unless the line already ends in whitespace. Unused for the inline `type` hint. */
  pad: number;
}

/**
 * How many virtual spaces to render before an end-of-line hint, so the gap to the code is a single
 * space — but never a doubled one when the line already ends in whitespace:
 *
 *   * a `result` hint (begins with `=`) gets one space unless the line ends in whitespace (which
 *     already separates it);
 *   * a `hole` hint gets one space after a trailing operator — a trailing comma counts as one — but
 *     none when the line ends in whitespace, or in an open `(` (whose argument placeholder butts
 *     right against it).
 */
export function endPadding(line: string, kind: "result" | "hole"): number {
  if (/\s$/.test(line)) {
    return 0;
  }

  if (kind === "result") {
    return 1;
  }

  return line.endsWith("(") ? 0 : 1;
}

// EVALUATING A BLOCK
// ================================================================================================

/** The interpreter surface {@link hintsForBlock} needs: evaluate one statement and report its
 *  formatter output and whether it errored. Injected so the evaluation logic is testable against
 *  the real wasm without the editor/plugin layers. */
export type LineInterpret = (code: string) => { output: string; isError: boolean; };

/** One statement of a block body: a single line, or a run of lines that belong together because a
 *  bracket is still open (Numbat allows an expression to span lines inside `(…)` / `[…]` / `{…}`)
 *  or because decorator lines precede it. */
export interface BlockStatement {
  /** 0-indexed first body line of the statement — a decorator line, where it has any. */
  startLine: number;

  /** 0-indexed last body line of the statement. */
  endLine: number;

  /** 0-indexed body line where the statement proper begins, past any decorator lines above it.
   *  Equal to `startLine` when the statement carries no decorators on lines of their own — which is
   *  also what a dangling decorator with no statement below it reports. */
  codeLine: number;

  /** The statement's source: the body lines, newline-joined, verbatim. */
  text: string;
}

/**
 * `src` with the contents of every string literal blanked out, so punctuation inside a string
 * cannot be mistaken for code — `"a ( b"` opens no bracket, and `@example("last([1, 2])")` closes
 * on its own paren, not on one in its text. Escapes are honored, quotes and newlines survive, and
 * lengths are preserved so offsets still line up. The caller strips comments first.
 *
 * Exported for the declaration scanners that must step over a decorator prefix (see {@link
 * declarationSite}, scope/model.ts, hover/declarations.ts): their `@name(…)` pattern would
 * otherwise end at the first `)` in the decorator's own text.
 */
export function blankStrings(src: string): string {
  let out = "";
  let inString = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (!inString) {
      out += ch;
      inString = ch === "\"";
    } else if (ch === "\\" && i + 1 < src.length) {
      out += "  "; // the escape and the character it escapes
      i += 1;
    } else if (ch === "\"") {
      out += ch;
      inString = false;
    } else {
      out += ch === "\n" ? ch : " ";
    }
  }

  return out;
}

/** The bracket-depth change of one line — `(`/`[`/`{` up, their closers down — ignoring brackets
 *  inside string literals. The caller strips comments first. */
function bracketDelta(src: string): number {
  let depth = 0;

  for (const ch of blankStrings(src)) {
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
    }
  }

  return depth;
}

/** A run of nothing but decorator applications — `@metric_prefixes`, `@name("Foo")`, a multi-line
 *  `@aliases(…)`. Anchored at both ends, so any code beside them fails it. */
const DECORATORS_ONLY = /^(?:\s*@\w+(?:\([^)]*\))?)+\s*$/;

/** Whether `lines` hold only decorators, and so are a prefix of the statement below rather than a
 *  statement of their own. Comments are stripped and strings blanked first, so a note between a
 *  decorator and the declaration it annotates does not break them apart, and neither does a paren
 *  inside a decorator's own text (`@example("last([1, 2])")`). */
function decoratorsOnly(lines: string[]): boolean {
  const stripped = lines.map(stripLineComment);
  return stripped[0].trimStart().startsWith("@") && DECORATORS_ONLY.test(blankStrings(stripped.join("\n")));
}

/** The last line of `body` in `[start, end]` that is not blank. At least `start`, which a statement
 *  never begins on. */
function lastNonBlank(body: string[], start: number, end: number): number {
  for (let i = end; i > start; i -= 1) {
    if (body[i].trim() !== "") {
      return i;
    }
  }

  return start;
}

/**
 * Group a block body into statements: a line with a still-open bracket absorbs the following lines
 * until the brackets balance (or the block ends), since that is how Numbat itself reads a
 * multi-line expression. Balanced lines — the common case — stay single-line statements; blank
 * lines between statements are skipped (a blank inside an open bracket is part of the statement).
 *
 * Decorator lines absorb the statement *below* them, which is the reading Numbat's own parser takes
 * — `parse_decorators` pushes onto a decorator stack, skips blank lines, and falls through to the
 * next statement. Evaluating `@description("…")` on its own is not a smaller piece of the same
 * program but a different, invalid one ("decorators can only be used on unit, let or function
 * definitions"), and it leaves the declaration below it undecorated, so nothing downstream ever
 * sees the annotation. `codeLine` reports where the statement proper begins, for the callers that
 * read a declaration off its first line.
 */
export function groupStatements(body: string[]): BlockStatement[] {
  const statements: BlockStatement[] = [];
  const push = (start: number, end: number, prefixEnd: number): void => {
    statements.push({
      startLine: start,
      endLine: end,
      codeLine: prefixEnd === -1 ? start : prefixEnd + 1,
      text: body.slice(start, end + 1).join("\n"),
    });
  };

  let start = -1;
  // The last line of the decorator run this statement opened with, or -1 when it opened with code.
  let prefixEnd = -1;
  let depth = 0;

  for (let i = 0; i < body.length; i += 1) {
    const line = body[i];
    if (start === -1) {
      if (line.trim() === "") {
        continue;
      }

      start = i;
      prefixEnd = -1;
      depth = 0;
    }

    depth += bracketDelta(stripLineComment(line));
    const last = i === body.length - 1;
    if (depth > 0 && !last) {
      continue;
    }

    if (decoratorsOnly(body.slice(start, i + 1))) {
      prefixEnd = i;
      if (!last) {
        continue; // hold the decorators open for the statement they annotate
      }

      // Nothing followed them. They still evaluate — and still error — so the hint is anchored on
      // the last line they occupy rather than on the blank space that ran out beneath them.
      push(start, lastNonBlank(body, start, i), -1);
    } else {
      push(start, i, prefixEnd);
    }

    start = -1;
  }

  return statements;
}

/**
 * Evaluate one block's body statement by statement via `run` (see {@link groupStatements}),
 * returning the hints to show. Each statement yields at most one end-of-line hint, anchored at its
 * last line: an expression's result, a binding's evaluated value, the missing operand's type
 * recovered from a Numbat typed hole (for an incomplete statement), or — when none of those apply
 * and the statement errored — the diagnostic's summary line. A binding's inferred type additionally
 * anchors just after its name (only where the user did not annotate one). `run` must carry
 * interpreter state across calls (a `let` is visible below it); a statement that errors does not
 * disturb the others.
 */
export function hintsForBlock(run: LineInterpret, body: string[]): Hint[] {
  const hints: Hint[] = [];

  for (const statement of groupStatements(body)) {
    // The declaration is read off the statement proper, which decorator lines sit above.
    const firstLine = body[statement.codeLine];
    const lastLine = body[statement.endLine];
    const result = run(statement.text);
    if (!result.isError) {
      const { echo, result: resultHtml } = splitInterpretOutput(result.output);
      if (resultHtml !== null) {
        const pad = endPadding(lastLine, "result");
        hints.push({ bodyLine: statement.endLine, column: lastLine.length, kind: "result", content: resultHtml, pad });
        continue;
      }

      // A declaration produces no value of its own.
      const site = declarationSite(firstLine);
      if (site !== null) {
        // Show its inferred type where the user did not already annotate one.
        if (!site.annotated) {
          const typeHtml = declarationTypeHtml(echo);
          if (typeHtml !== null) {
            hints.push({
              bodyLine: statement.codeLine,
              column: site.nameEnd,
              kind: "type",
              content: typeHtml,
              pad: 0,
            });
          }
        }

        // A `let` binding also shows its evaluated value at the end of the line (`let x = 1 + 3 =
        // 4`). The type is already inline, so the value's `[dimension]` is dropped to avoid
        // repeating it — and the whole hint is skipped when the value just repeats the bound
        // expression (`let x = 5 m`).
        if (site.keyword === "let") {
          const valueResult = run(site.name);
          if (!valueResult.isError) {
            const { result: valueHtml } = splitInterpretOutput(valueResult.output);
            if (valueHtml !== null && !bindingValueRepeatsSource(statement.text, valueHtml)) {
              const pad = endPadding(lastLine, "result");
              hints.push({
                bodyLine: statement.endLine,
                column: lastLine.length,
                kind: "result",
                content: resultValueHtml(valueHtml),
                pad,
              });
            }
          }
        }
      }

      continue;
    }

    // The statement did not evaluate — if it is an incomplete expression, recover the expected type
    // of its missing operand from a typed hole.
    const hole = holeForm(statement.text);
    if (hole !== null) {
      const holeType = parseHoleType(run(hole).output);
      if (holeType !== null) {
        const pad = endPadding(lastLine, "hole");
        hints.push({ bodyLine: statement.endLine, column: lastLine.length, kind: "hole", content: holeType, pad });
        continue;
      }
    }

    // Otherwise surface the error itself, like inline evaluation does.
    const summary = errorSummary(result.output);
    if (summary !== null) {
      const pad = endPadding(lastLine, "result");
      hints.push({ bodyLine: statement.endLine, column: lastLine.length, kind: "error", content: summary, pad });
    }
  }

  return hints;
}

// CACHE KEYS
// ================================================================================================

/**
 * The cache key for one block's hints — everything its results depend on, NUL-separated (a NUL
 * occurs in none of them):
 *
 *   * `generation`, the interpreter's stamp for what a context bakes in beyond the code fed to it
 *     (the user prelude and the exchange rates). Passed in rather than read here so this module
 *     stays free of interpreter imports, exactly as {@link noteSignature} does it.
 *   * `preambleSource` — the property bindings and cross-note imports that open the block's scope.
 *   * every *earlier* `numbat-shared` block, which the evaluation pass replays into the context
 *     ahead of this one.
 *   * the block's own body.
 *
 * The shared bodies are the subtle part. Without them, editing an earlier shared block left every
 * later block's hints frozen at the old value for the rest of the session, while the rendered block
 * and the inline spans — whose signature does include them — both updated.
 *
 * Used by both the decoration build and the evaluation pass, so the two cannot key differently.
 */
export function blockKey(
  generation: number,
  preambleSource: string,
  block: NumbatBlockRange,
  allBlocks: readonly NumbatBlockRange[],
): string {
  const shared = allBlocks
    .filter((earlier) => earlier.shared && earlier.openLine < block.openLine)
    .map((earlier) => earlier.body.join("\n"));
  return [String(generation), preambleSource, ...shared, block.body.join("\n")].join("\u0000");
}
