// Pure helpers for inline expression evaluation — evaluating a Numbat expression written *inline in
// prose* (not in a `numbat` code block).
//
// Two triggers, each a letter *prefix* on an inline code span (the prefix sits outside the
// backticks):
//
//   * `` n`expr` `` — "live": evaluated continuously, its result shown as a widget after the span
//     (and committable on demand);
//   * `` nc`expr ⇒ value` `` — "concrete": the value is materialized inside the span, right of a
//     `⇒` separator, and kept in sync.
//
// Everything here is string-only — no Obsidian, CodeMirror, or wasm imports — so it is
// unit-testable in isolation (like evaluation/inlay-parse.ts / document/fences.ts). The editor
// ViewPlugin (evaluation/inline.ts) and the reading-view post-processor
// (evaluation/inline-reading.ts) provide the interpreter and DOM/CM layers around it.

import { FenceWalk } from "../document/fences";
import { WORD_CHAR } from "../syntax/identifier";
import {
  bindingValueRepeatsSource,
  declarationSite,
  errorSummary,
  holeForm,
  type LineInterpret,
  parseHoleType,
  plainText,
  resultValueHtml,
  splitInterpretOutput,
} from "./inlay-parse";

// SYNTAX AND DEFAULTS
// ================================================================================================

/** The configurable syntax of inline evaluation. Defaults below; the prefixes are also exposed as
 *  settings, so a user can pick rarer markers. */
export interface InlineEvalConfig {
  /** Prefix for a live span (default `n`). */
  live: string;

  /** Prefix for a concrete span (default `nc`). Matched in preference to `live` when both could
   *  apply (it is the longer of the two). */
  concrete: string;

  /** Separator between a concrete span's expression and its materialized value (default `⇒`). The
   *  plugin owns everything from the first separator onward. */
  separator: string;

  /** Whether to detect spans in YAML frontmatter (note properties). */
  frontmatter: boolean;

  /** Whether to detect spans inside non-`numbat` fenced code blocks. */
  codeBlocks: boolean;

  /** Display inline results with this many decimal places (truncated / zero-padded via Numbat's own
   *  format specifiers), or `null` for full precision. A span's `{dp=…}` config overrides it. */
  decimalPlaces: number | null;
}

/** The live prefix default (`n`). */
export const DEFAULT_LIVE_PREFIX = "n";

/** The concrete prefix default (`nc`). */
export const DEFAULT_CONCRETE_PREFIX = "nc";

/** The concrete value separator default (`⇒`). */
export const DEFAULT_SEPARATOR = "⇒";

/** An ASCII `=>` typed where the separator goes is accepted as one, and normalized to the real
 *  separator on the next write-back — so a user can introduce the value region by hand without
 *  hunting for `⇒`. */
export const SEPARATOR_ALIAS = "=>";

/** The most decimal places a `dp` accepts — beyond an f64's precision, more places only print
 *  noise. */
export const MAX_DECIMAL_PLACES = 15;

/** The default inline-eval syntax and scope (both extended contexts on, full precision). */
export const DEFAULT_INLINE_CONFIG: InlineEvalConfig = {
  live: DEFAULT_LIVE_PREFIX,
  concrete: DEFAULT_CONCRETE_PREFIX,
  separator: DEFAULT_SEPARATOR,
  frontmatter: true,
  codeBlocks: true,
  decimalPlaces: null,
};

/** A located inline-eval span within a single line of markdown source. All columns are 0-indexed
 *  character offsets within the line. */
export interface InlineSpan {
  /** Which trigger this is. */
  variant: "live" | "concrete";

  /** Column of the first prefix character (`n` / `nc`). */
  prefixStart: number;

  /** Column of the first opening backtick. */
  openTickStart: number;

  /** Column of the first content character (just past the opening backticks). */
  contentStart: number;

  /** Column just past the last content character (just before the closing backticks). */
  contentEnd: number;

  /** Column just past the last closing backtick — the end of the whole span. */
  closeEnd: number;

  /** Number of backticks in each delimiter run. */
  tickLen: number;

  /** The text inside a `{…}` config sitting immediately after the opening backticks (`` n`{dp=2}
   *  expr` ``), or `null` when the span has none. */
  configText: string | null;

  /** Column where the expression begins: just past the config's `}` when there is one, else {@link
   *  contentStart}. */
  exprStart: number;

  /** The Numbat expression to evaluate: the content between the config (if any) and the separator
   *  (for a concrete span) or the closing backticks, trimmed. */
  expr: string;

  /** Column just past the expression region (where highlighting of `expr` stops): the separator's
   *  column for a concrete span that has one, else `contentEnd`. */
  exprEnd: number;

  /** Column of the separator character for a concrete span that has one, else `null`. */
  separatorAt: number | null;

  /** The separator text actually written there — the configured `⇒` or the typed `=>` alias — for a
   *  concrete span that has one, else `null`. */
  separatorText: string | null;

  /** The current materialized value text (trimmed) for a concrete span that has a separator, else
   *  `null`. Compared against a fresh evaluation to decide whether the span needs rewriting. */
  resultText: string | null;
}

// Identifier characters, per Numbat's rule closely enough for a boundary test: a prefix preceded by
// one of these is part of a larger word, not our trigger.

// FINDING SPANS IN A LINE
// ================================================================================================

/**
 * Whether `prefix` sits at a word boundary at the end of `before` — i.e. the character immediately
 * before the prefix is not an identifier character (so `sun` in `` sun`x` `` does not read as the
 * `n` trigger), or the prefix is at the very start of the line.
 */
function boundaryOk(before: string, prefixLen: number): boolean {
  const idx = before.length - prefixLen - 1;
  if (idx < 0) {
    return true;
  }

  return !WORD_CHAR.test(before[idx]);
}

/**
 * Recognize a trigger prefix at the end of `before` (the text preceding an inline code span's
 * opening backticks). Prefers the concrete prefix (the longer marker) when both could match, and
 * requires a word boundary before the prefix. Returns the variant and prefix length, or `null` when
 * there is no trigger. Exported so the reading-view processor can test the text node before a
 * rendered `<code>`.
 */
export function trailingPrefix(
  before: string,
  config: InlineEvalConfig,
): { variant: "live" | "concrete"; len: number; } | null {
  if (config.concrete !== "" && before.endsWith(config.concrete) && boundaryOk(before, config.concrete.length)) {
    return { variant: "concrete", len: config.concrete.length };
  }

  if (config.live !== "" && before.endsWith(config.live) && boundaryOk(before, config.live.length)) {
    return { variant: "live", len: config.live.length };
  }

  return null;
}

/**
 * Locate every inline-eval span in one line of markdown source, left to right. Scans balanced,
 * equal-length backtick runs (so multi-backtick spans like
 * ``` `` n`= a` `` ``` are handled and a run of a different length inside a span is
 * literal content), and keeps only spans immediately preceded by a trigger prefix
 * at a word boundary. A run with no matching closing run is skipped.
 */
export function findInlineSpans(line: string, config: InlineEvalConfig): InlineSpan[] {
  const spans: InlineSpan[] = [];

  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      i += 1;
      continue;
    }

    // Measure the opening backtick run.
    let k = 1;
    while (i + k < line.length && line[i + k] === "`") {
      k += 1;
    }
    const openTickStart = i;
    const contentStart = i + k;

    // Find the next run of *exactly* k backticks — the closing delimiter.
    let j = contentStart;
    let closeStart = -1;
    while (j < line.length) {
      if (line[j] === "`") {
        let m = 1;
        while (j + m < line.length && line[j + m] === "`") {
          m += 1;
        }
        if (m === k) {
          closeStart = j;
          break;
        }
        j += m; // a run of a different length is literal content
      } else {
        j += 1;
      }
    }

    if (closeStart === -1) {
      // Unterminated: skip past the opening run and keep scanning.
      i = contentStart;
      continue;
    }

    const contentEnd = closeStart;
    const closeEnd = closeStart + k;
    const prefix = trailingPrefix(line.slice(0, openTickStart), config);
    if (prefix !== null) {
      spans.push(buildSpan(line, config, prefix, openTickStart, contentStart, contentEnd, closeEnd, k));
    }

    i = closeEnd;
  }

  return spans;
}

/** The first separator in a concrete span's content — the configured one or the typed `=>` alias,
 *  whichever comes first — or `null` when there is none. */
function findSeparator(content: string, config: InlineEvalConfig): { at: number; text: string; } | null {
  let best: { at: number; text: string; } | null = null;

  for (const text of [config.separator, SEPARATOR_ALIAS]) {
    if (text === "") {
      continue;
    }

    const at = content.indexOf(text);
    if (at !== -1 && (best === null || at < best.at)) {
      best = { at, text };
    }
  }

  return best;
}

/** A `{…}` config at the very start of a span's content — `null` when the content does not begin
 *  with `{`, or the brace never closes (then it is expression text, not a config). */
function leadingConfig(content: string): { text: string; end: number; } | null {
  if (content[0] !== "{") {
    return null;
  }

  const close = content.indexOf("}");
  if (close === -1) {
    return null;
  }

  return { text: content.slice(1, close), end: close + 1 };
}

/** Assemble an {@link InlineSpan}: strip a leading `{…}` config, then split a concrete span's
 *  remaining content at its first separator into the expression and the materialized value
 *  region. */
function buildSpan(
  line: string,
  config: InlineEvalConfig,
  prefix: { variant: "live" | "concrete"; len: number; },
  openTickStart: number,
  contentStart: number,
  contentEnd: number,
  closeEnd: number,
  tickLen: number,
): InlineSpan {
  const content = line.slice(contentStart, contentEnd);
  const spanConfig = leadingConfig(content);
  const configText = spanConfig?.text ?? null;
  const exprStart = contentStart + (spanConfig?.end ?? 0);
  const body = content.slice(spanConfig?.end ?? 0);

  let expr = body.trim();
  let exprEnd = contentEnd;
  let separatorAt: number | null = null;
  let separatorText: string | null = null;
  let resultText: string | null = null;

  if (prefix.variant === "concrete") {
    const sep = findSeparator(body, config);
    if (sep !== null) {
      separatorAt = exprStart + sep.at;
      separatorText = sep.text;
      exprEnd = separatorAt;
      expr = body.slice(0, sep.at).trim();
      resultText = body.slice(sep.at + sep.text.length).trim();
    }
  }

  return {
    variant: prefix.variant,
    prefixStart: openTickStart - prefix.len,
    openTickStart,
    contentStart,
    contentEnd,
    closeEnd,
    tickLen,
    configText,
    exprStart,
    expr,
    exprEnd,
    separatorAt,
    separatorText,
    resultText,
  };
}

/**
 * The parts carried by an inline span's inner content: the expression — past a leading `{…}` config
 * and left of a concrete span's first separator, trimmed — and the config's text (`null` when there
 * is none). Used by the reading-view processor, which has a rendered `<code>`'s text (no backticks)
 * rather than a source line to run {@link findInlineSpans} over.
 */
export function contentParts(
  content: string,
  variant: "live" | "concrete",
  config: InlineEvalConfig,
): { expr: string; configText: string | null; } {
  const spanConfig = leadingConfig(content);
  const body = content.slice(spanConfig?.end ?? 0);

  if (variant === "concrete") {
    const sep = findSeparator(body, config);
    if (sep !== null) {
      return { expr: body.slice(0, sep.at).trim(), configText: spanConfig?.text ?? null };
    }
  }

  return { expr: body.trim(), configText: spanConfig?.text ?? null };
}

/**
 * The span whose *expression region* contains column `col` — from just past the opening backticks
 * (and a `{…}` config, if any) to the end of the expression (a concrete span's separator, or the
 * closing backticks) — or `null`. Editor affordances (expression completion, unicode expansion) act
 * only there: the prefix, the delimiters, a config, and a materialized value are not places the
 * user writes Numbat.
 */
export function spanAtColumn(line: string, col: number, config: InlineEvalConfig): InlineSpan | null {
  for (const span of findInlineSpans(line, config)) {
    if (col >= span.exprStart && col <= span.exprEnd) {
      return span;
    }
  }

  return null;
}

// PER-SPAN CONFIGURATION
// ================================================================================================

/**
 * The `key = value?` entries of a span config's text, comma-separated; an empty value reads as
 * `null` ("explicitly unset"). Extraction is tolerant — a bare `key` also maps to `null` here, but
 * {@link configError} flags it as malformed before any consumer acts on it. Unknown keys are
 * carried (and ignored by the consumers), so future parameters parse today.
 */
export function configParams(configText: string | null): Map<string, string | null> {
  const params = new Map<string, string | null>();
  if (configText === null) {
    return params;
  }

  for (const part of configText.split(",")) {
    const entry = part.trim();
    if (entry === "") {
      continue;
    }

    const eq = entry.indexOf("=");
    if (eq === -1) {
      params.set(entry, null);
      continue;
    }

    const key = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1).trim();
    if (key !== "") {
      params.set(key, value === "" ? null : value);
    }
  }

  return params;
}

/**
 * The syntax error of a span's `{…}` config, or `null` when it is well-formed. Every entry must be
 * `key = value` with the value optional — `dp=` unsets — so a bare key without its `=` is malformed
 * (`{dp}` is an easy slip for `{dp=}`), as is a `dp` value that is not a whole number. Well-formed
 * unknown keys are tolerated, so a future parameter does not error in an older plugin. Surfaced
 * after the span exactly like a Numbat evaluation error.
 */
export function configError(configText: string | null): string | null {
  if (configText === null) {
    return null;
  }

  for (const part of configText.split(",")) {
    const entry = part.trim();
    if (entry === "") {
      continue;
    }

    const eq = entry.indexOf("=");
    if (eq === -1) {
      return `config: '${entry}' is missing its '=' — write '${entry}=' to unset`;
    }

    const key = entry.slice(0, eq).trim();
    if (key === "") {
      return "config: a parameter is missing its name before '='";
    }

    const value = entry.slice(eq + 1).trim();
    if (key === "dp" && value !== "" && !/^\d+$/.test(value)) {
      return `config: 'dp' takes a whole number of decimal places, not '${value}'`;
    }
  }

  return null;
}

/** An "error"-kind result carrying a config syntax error — it takes display precedence over the
 *  expression's own outcome (which is still evaluated for its state effects). */
export function configErrorResult(error: string): InlineResult {
  return emptyResult(true, error);
}

/**
 * The decimal places to display a span's result with: the span config's `dp` parameter when present
 * — `dp = <number>` overrides, a blank `dp =` unsets rounding — else the configured default. `null`
 * means full precision. A malformed config is {@link configError}'s concern: the span then shows
 * the error, and this resolution (which falls back to the default) is moot.
 */
export function configDecimalPlaces(configText: string | null, config: InlineEvalConfig): number | null {
  const params = configParams(configText);

  if (params.has("dp")) {
    const value = params.get("dp") ?? null;
    if (value === null) {
      return null; // explicitly unset — full precision even with a default set
    }
    if (/^\d+$/.test(value)) {
      return Math.min(Number(value), MAX_DECIMAL_PLACES);
    }
  }

  return config.decimalPlaces;
}

/** {@link configDecimalPlaces} for a located span. */
export function spanDecimalPlaces(span: InlineSpan, config: InlineEvalConfig): number | null {
  return configDecimalPlaces(span.configText, config);
}

// WALKING A NOTE
// ================================================================================================

/** A unit of a note that contributes to inline evaluation, in document order: the body of a
 *  `numbat-shared` block (replayed into the session) or a located inline span (evaluated, and its
 *  result recorded). Only `numbat`/`numbat-shared` block bodies are excluded from inline detection
 *  — their contents are numbat code, handled by the block itself. */
export type NoteUnit =
  | { kind: "shared"; code: string; line: number; }
  | { kind: "inline"; span: InlineSpan; line: number; };

/**
 * The line-by-line scanner state shared by {@link scanNote} and {@link inlineScopeAt}: reports for
 * each consumed line whether it is scanned for inline spans and whether it just closed a
 * `numbat-shared` block (whose body then feeds the shared session).
 *
 * Inline spans are always detected in prose; frontmatter and non-`numbat` fenced code blocks are
 * gated by `config.frontmatter` / `config.codeBlocks`. `numbat`/`numbat-shared` block bodies are
 * never scanned for spans — their contents are numbat code the block evaluates itself.
 *
 * The frontmatter and fence tracking underneath is {@link FenceWalk}, shared with every other
 * scanner in the plugin, so nesting is decided in one place.
 */
class NoteWalk {
  /** The shared fence/frontmatter tracker this adds inline-span rules on top of. */
  private readonly walk = new FenceWalk();

  /** The body lines of the block currently open, accumulated so a closing `numbat-shared` fence can
   *  hand its source back for replay. */
  private body: string[] = [];

  /** @param config decides which regions carry spans — notably whether frontmatter does. */
  constructor(private readonly config: InlineEvalConfig) {}

  /** Consume one line: whether it is scanned for inline spans, and the body of a `numbat-shared`
   *  block the line just closed (`null` otherwise). */
  step(text: string): { scans: boolean; closedShared: string | null; } {
    const line = this.walk.step(text);

    if (line.region === "prose") {
      return { scans: true, closedShared: null };
    }

    if (line.region === "frontmatter") {
      // The `---` delimiters carry no spans; the properties between them may.
      return { scans: line.role === "body" && this.config.frontmatter, closedShared: null };
    }

    if (line.role === "open") {
      this.body = [];
      return { scans: false, closedShared: null };
    }

    if (line.role === "close") {
      return { scans: false, closedShared: line.kind === "shared" ? this.body.join("\n") : null };
    }

    if (line.kind === "shared") {
      this.body.push(text);
      return { scans: false, closedShared: null };
    }

    // A non-numbat code fence hosts inline spans when enabled; a `numbat` body is numbat code,
    // skipped entirely.
    return { scans: line.kind === "other" && this.config.codeBlocks, closedShared: null };
  }

  /** The body of a `numbat-shared` block left open at end-of-note, if any. */
  finish(): string | null {
    return this.walk.openNumbat()?.kind === "shared" ? this.body.join("\n") : null;
  }
}

/**
 * Walk a note's lines in document order, yielding the {@link NoteUnit}s that feed inline
 * evaluation: each `numbat-shared` block's body (at the point it closes) and every inline span, per
 * the {@link NoteWalk} scoping rules.
 *
 * Accepts any iterable of lines, so the editor passes a CodeMirror line cursor and the reading-view
 * processor passes `text.split("\n")`; both share this ordering.
 */
export function scanNote(lines: Iterable<string>, config: InlineEvalConfig): NoteUnit[] {
  const units: NoteUnit[] = [];
  const walk = new NoteWalk(config);

  let index = 0;
  for (const text of lines) {
    const { scans, closedShared } = walk.step(text);

    if (closedShared !== null) {
      units.push({ kind: "shared", code: closedShared, line: index });
    }

    if (scans) {
      for (const span of findInlineSpans(text, config)) {
        units.push({ kind: "inline", span, line: index });
      }
    }

    index += 1;
  }

  // A `numbat-shared` block left open at end-of-document still contributes.
  const open = walk.finish();
  if (open !== null) {
    units.push({ kind: "shared", code: open, line: index });
  }

  return units;
}

/**
 * Whether the *last* of `lines` is a context inline spans are detected in — prose, or YAML
 * frontmatter / a non-`numbat` fenced code block when the corresponding scope is enabled. Walks the
 * whole prefix so fences and frontmatter are tracked exactly as {@link scanNote} does; used to gate
 * the editor affordances (expression completion, unicode expansion) to the same places evaluation
 * reaches. Callers pass every line up to and including the caret line.
 */
export function inlineScopeAt(lines: Iterable<string>, config: InlineEvalConfig): boolean {
  const walk = new NoteWalk(config);
  let scans = false;

  for (const text of lines) {
    scans = walk.step(text).scans;
  }

  return scans;
}

/**
 * A signature of everything that affects inline results: each shared block's body and each inline
 * expression — with its effective decimal places, so a `{dp=…}` edit or a changed default
 * re-evaluates — in document order. Crucially it does **not** include a concrete span's
 * materialized value region — so rewriting that region (see evaluation/inline.ts) leaves the
 * signature unchanged and cannot trigger a re-evaluation loop. Equal signatures ⇒ identical
 * results, so the editor reuses its cache and only rebuilds decorations.
 */
export function evalSignature(units: NoteUnit[], config: InlineEvalConfig): string {
  return units
    .map((unit) =>
      unit.kind === "shared"
        ? `S:${unit.code}`
        // The raw config text rides along with the effective dp: a `{dp}` ↔ `{dp=}` edit changes
        // the surfaced config error but not the dp.
        : `I:${spanDecimalPlaces(unit.span, config) ?? ""}:${unit.span.configText ?? ""}:${unit.span.expr}`
    )
    .join(" ");
}

/**
 * The full cache key for a note's inline results: the interpreter generation, the note preamble
 * (the property-derived `let` bindings replayed before everything else — see properties/parse.ts),
 * and {@link evalSignature}. A property edit, a type (re)assignment, or a toggled binding setting
 * changes the preamble source and re-evaluates; a NUL separates the parts since it cannot occur in
 * any of them.
 *
 * `generation` comes from the interpreter (`interpreterGeneration()`) and covers what a context
 * bakes in beyond the note's own text — the user prelude and the exchange rates. It is passed in
 * rather than read here so this module stays free of interpreter imports. Omitting it is what let a
 * prelude edit, or enabling live currency rates, leave a cached result standing.
 */
export function noteSignature(
  generation: number,
  preambleSource: string,
  units: NoteUnit[],
  config: InlineEvalConfig,
): string {
  return `${generation}\u0000${preambleSource}\u0000${evalSignature(units, config)}`;
}

// EVALUATION RESULTS
// ================================================================================================

/** What one inline evaluation produced, shaping what the editor and reading view show for the
 *  span. */
export type InlineResultKind =
  /** An expression with a value: the committable widget / `nc` materialization / reading-view
   *  replacement. */
  | "value"
  /** A `let` declaration whose evaluated value is worth showing — an informational hint only
   *  (mirroring the code-block inlay), never committed or materialized, since replacing the span
   *  would delete the definition. */
  | "binding"
  /** A statement with nothing to show (a command, or a binding whose value just repeats its
   *  source). */
  | "none"
  /** An incomplete expression: show the missing operand's type as a placeholder. */
  | "hole"
  /** The expression failed to evaluate. */
  | "error";

/** The shapes an evaluated inline result is needed in, by {@link InlineResultKind}. */
export interface InlineResult {
  /** Which outcome this is, and so which of the fields below are populated. */
  kind: InlineResultKind;

  /** The `= value` fragment (HTML), the trailing `[Dim]` dropped — the editor widget/hint ("value"
   *  / "binding"). */
  resultHtml: string | null;

  /** The bare value (HTML), no leading `=` — the reading-view replacement ("value"). */
  valueHtml: string | null;

  /** The bare value as plain text — committing to the note / materializing `nc`. */
  plain: string | null;

  /** Whether the expression errored ("hole" is an error the placeholder stands in for). */
  isError: boolean;

  /** The diagnostic's summary line, plain text ("error"). */
  errorText: string | null;

  /** The missing operand's type ("hole"). */
  holeType: string | null;

  /** Whether `plain` is the decimal-places display form (see {@link roundedText}); consumers then
   *  render from `plain` rather than the formatter HTML above. */
  rounded: boolean;
}

/** An inline result carrying no value: an error (with its summary) or a value-less statement. */
function emptyResult(isError: boolean, errorText: string | null = null): InlineResult {
  return {
    kind: isError ? "error" : "none",
    resultHtml: null,
    valueHtml: null,
    plain: null,
    isError,
    errorText,
    holeType: null,
    rounded: false,
  };
}

/** A result carrying a value: an expression's own ("value") or the one a `let` binding bound
 *  ("binding"). `result` is the formatter's `= value [Dim]` fragment. */
function valueResult(kind: "value" | "binding", result: string): InlineResult {
  const valueHtml = inlineValueHtml(result);
  return {
    kind,
    resultHtml: resultValueHtml(result),
    valueHtml,
    plain: plainText(valueHtml),
    isError: false,
    errorText: null,
    holeType: null,
    rounded: false,
  };
}

/**
 * The fixed-decimal display of `expr`'s value, via Numbat's own interpolation format specifiers:
 * `"{(expr):.<dp>f}"` truncates or zero-pads to `dp` decimal places and keeps the unit (`8.05372
 * km`, dp 2 → `8.05 km`; `1.5`, dp 3 → `1.500`). Returns `null` when the formatted evaluation fails
 * — the spec requires a quantity, so a string/boolean/list value falls back to its plain display —
 * or does not produce the expected string literal.
 */
export function roundedText(run: LineInterpret, expr: string, dp: number): string | null {
  const out = run(`"{(${expr}):.${dp}f}"`);
  if (out.isError) {
    return null;
  }

  const { result } = splitInterpretOutput(out.output);
  if (result === null) {
    return null;
  }

  const text = plainText(inlineValueHtml(result));
  if (text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")) {
    return text.slice(1, -1);
  }

  return null;
}

/**
 * Derive the {@link InlineResult} shapes from one interpreter output. Splits the echo from the
 * result (via inlay-parse's {@link splitInterpretOutput}); a value keeps its `= value` fragment for
 * the widget (the `[Dim]` dropped) and reduces to the bare value / plain text; an error carries its
 * summary line; a value-less statement yields "none". The probes that need further evaluations — a
 * binding's value, a typed hole — live in {@link inlineResultFor}.
 */
export function deriveInlineResult(output: string, isError: boolean): InlineResult {
  if (isError) {
    return emptyResult(true, errorSummary(output));
  }

  const { result } = splitInterpretOutput(output);
  if (result === null) {
    return emptyResult(false);
  }

  return valueResult("value", result);
}

/** `result` with its `plain` replaced by the fixed-decimal display of `target` when `dp` is set and
 *  the formatted probe succeeds; unchanged otherwise. */
function withRounding(run: LineInterpret, result: InlineResult, target: string, dp: number | null): InlineResult {
  if (dp === null) {
    return result;
  }

  const text = roundedText(run, target, dp);
  if (text === null) {
    return result;
  }

  return { ...result, plain: text, rounded: true };
}

/**
 * The full result derivation for one inline expression, with the interpreter at hand (`run` carries
 * the note's replayed state so far): {@link deriveInlineResult}, plus the two probes that need
 * further evaluations, mirroring the code-block inlay hints — a non-trivial `let` binding's value
 * (`let x = 1 + 3` shows `= 4`; one that just repeats its source shows nothing), and an incomplete
 * expression's missing-operand type recovered from a Numbat typed hole (`3 m +` → `Length`).
 * Neither probe disturbs the session: evaluating a bound name is pure, and a hole form is always a
 * type error. With `dp` set, a value/binding result displays with that many decimal places (see
 * {@link roundedText}).
 */
export function inlineResultFor(run: LineInterpret, expr: string, dp: number | null = null): InlineResult {
  const out = run(expr);
  const derived = deriveInlineResult(out.output, out.isError);

  if (derived.kind === "value") {
    return withRounding(run, derived, expr, dp);
  }

  if (derived.kind === "none") {
    const site = declarationSite(expr);

    if (site !== null && site.keyword === "let") {
      const value = run(site.name);

      if (!value.isError) {
        const { result } = splitInterpretOutput(value.output);

        if (result !== null && !bindingValueRepeatsSource(expr, result)) {
          return withRounding(run, valueResult("binding", result), site.name, dp);
        }
      }
    }
    return derived;
  }

  if (derived.kind === "error") {
    const hole = holeForm(expr);

    if (hole !== null) {
      const type = parseHoleType(run(hole).output);

      if (type !== null) {
        return { ...derived, kind: "hole", holeType: type, errorText: null };
      }
    }
  }

  return derived;
}

// RENDERING
// ================================================================================================

/** The single-class operator span Numbat's HTML formatter emits for a leading `=`. */
const EQUALS_SPAN = `<span class="numbat-operator">=</span>`;

/**
 * Reduce a result fragment (`= value [Dim]`, HTML) to just the value: drop the trailing `[Dim]`
 * (via inlay-parse's {@link resultValueHtml}) and strip the leading `=` operator span and any
 * following whitespace. Reused for the reading-view value and, through {@link deriveInlineResult},
 * the plain-text commit/materialize forms.
 */
export function inlineValueHtml(resultHtml: string): string {
  let value = resultValueHtml(resultHtml).replace(/^\s+/, "");
  if (value.startsWith(EQUALS_SPAN)) {
    value = value.slice(EQUALS_SPAN.length).replace(/^(\s|&nbsp;)+/, "");
  }

  return value;
}
