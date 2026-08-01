import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configDecimalPlaces,
  configError,
  configErrorResult,
  configParams,
  DEFAULT_INLINE_CONFIG,
  deriveInlineResult,
  evalSignature,
  findInlineSpans,
  inlineResultFor,
  inlineScopeAt,
  inlineValueHtml,
  noteSignature,
  type NoteUnit,
  scanNote,
  spanAtColumn,
  spanDecimalPlaces,
} from "../../../src/evaluation/inline-parse.ts";

const cfg = DEFAULT_INLINE_CONFIG;

// --- findInlineSpans --------------------------------------------------------

test("findInlineSpans: a live span carries the trimmed expression and its columns", () => {
  const line = "The trip is n`5 km + 3 mi` total.";
  const spans = findInlineSpans(line, cfg);
  assert.equal(spans.length, 1);
  const span = spans[0];
  assert.equal(span.variant, "live");
  assert.equal(span.expr, "5 km + 3 mi");
  assert.equal(span.prefixStart, line.indexOf("n`"));
  assert.equal(span.openTickStart, line.indexOf("`"));
  assert.equal(span.contentStart, line.indexOf("5 km"));
  assert.equal(span.closeEnd, line.indexOf("` total") + 1);
  assert.equal(span.separatorAt, null);
  assert.equal(span.resultText, null);
  assert.equal(span.exprEnd, span.contentEnd);
});

test("findInlineSpans: a concrete span splits expr from the materialized value", () => {
  const line = "cost nc`5 km + 3 mi ⇒ 8.0 km` ok";
  const spans = findInlineSpans(line, cfg);
  assert.equal(spans.length, 1);
  const span = spans[0];
  assert.equal(span.variant, "concrete");
  assert.equal(span.expr, "5 km + 3 mi");
  assert.equal(span.resultText, "8.0 km");
  assert.equal(span.separatorAt, line.indexOf("⇒"));
  assert.equal(span.separatorText, "⇒");
  assert.equal(span.exprEnd, span.separatorAt);
  // The prefix spans both letters of `nc`.
  assert.equal(span.prefixStart, line.indexOf("nc`"));
});

test("findInlineSpans: a typed `=>` is accepted as the separator (alias)", () => {
  const line = "cost nc`4 m + 1 m => 5 m` ok";
  const [span] = findInlineSpans(line, cfg);
  assert.equal(span.expr, "4 m + 1 m");
  assert.equal(span.resultText, "5 m");
  assert.equal(span.separatorAt, line.indexOf("=>"));
  assert.equal(span.separatorText, "=>");
  assert.equal(span.exprEnd, span.separatorAt);
});

test("findInlineSpans: a live span never splits at a separator", () => {
  const [span] = findInlineSpans("n`a => b`", cfg);
  assert.equal(span.expr, "a => b");
  assert.equal(span.separatorAt, null);
  assert.equal(span.separatorText, null);
});

test("findInlineSpans: a leading {…} config is split from the expression", () => {
  const line = "x n`{dp=2} 5 + 25/60` y";
  const [span] = findInlineSpans(line, cfg);
  assert.equal(span.configText, "dp=2");
  assert.equal(span.expr, "5 + 25/60");
  assert.equal(span.exprStart, line.indexOf("} ") + 1);
  // A span without one starts its expression at the content.
  const [plain] = findInlineSpans("n`5 km`", cfg);
  assert.equal(plain.configText, null);
  assert.equal(plain.exprStart, plain.contentStart);
});

test("findInlineSpans: a config composes with a concrete span's separator", () => {
  const line = "x nc`{dp=1} 4 m + 1 m ⇒ 5.0 m`";
  const [span] = findInlineSpans(line, cfg);
  assert.equal(span.configText, "dp=1");
  assert.equal(span.expr, "4 m + 1 m");
  assert.equal(span.resultText, "5.0 m");
});

test("findInlineSpans: an unclosed brace is expression text, not a config", () => {
  const [span] = findInlineSpans("n`{dp=2 oops`", cfg);
  assert.equal(span.configText, null);
  assert.equal(span.expr, "{dp=2 oops");
});

test("findInlineSpans: a concrete span with no separator yet has a null value region", () => {
  const line = "here nc`5 km` more";
  const [span] = findInlineSpans(line, cfg);
  assert.equal(span.variant, "concrete");
  assert.equal(span.expr, "5 km");
  assert.equal(span.separatorAt, null);
  assert.equal(span.resultText, null);
  assert.equal(span.exprEnd, span.contentEnd);
});

test("findInlineSpans: the prefix must sit at a word boundary", () => {
  assert.equal(findInlineSpans("sun`x`", cfg).length, 0, "n inside a word does not trigger");
  assert.equal(findInlineSpans("then`x`", cfg).length, 0, "trailing n of a word does not trigger");
  assert.equal(findInlineSpans("a franc`x`", cfg).length, 0, "nc inside a word does not trigger");
  assert.equal(findInlineSpans("n`x`", cfg).length, 1, "at line start it triggers");
  assert.equal(findInlineSpans("cost: n`x`", cfg).length, 1, "after a space it triggers");
  assert.equal(findInlineSpans("(n`x`)", cfg).length, 1, "after punctuation it triggers");
});

test("findInlineSpans: an ordinary inline code span (no prefix) is ignored", () => {
  assert.equal(findInlineSpans("see `let x = 5` above", cfg).length, 0);
});

test("findInlineSpans: multiple spans on a line are returned left to right", () => {
  const line = "n`1 m` and n`2 m`";
  const spans = findInlineSpans(line, cfg);
  assert.equal(spans.length, 2);
  assert.deepEqual(spans.map((s) => s.expr), ["1 m", "2 m"]);
  assert.ok(spans[0].openTickStart < spans[1].openTickStart);
});

test("findInlineSpans: multi-backtick spans allow a literal backtick inside", () => {
  const line = "n``a`b``";
  const [span] = findInlineSpans(line, cfg);
  assert.equal(span.tickLen, 2);
  assert.equal(span.expr, "a`b");
});

test("findInlineSpans: an unterminated backtick run yields no span", () => {
  assert.equal(findInlineSpans("n`5 km + 3", cfg).length, 0);
});

// --- spanAtColumn -------------------------------------------------------------

test("spanAtColumn: hits only within a span's expression region", () => {
  const line = "cost nc`4 m + 1 m ⇒ 5 m` and n`2 m` end";
  const exprCol = line.indexOf("4 m");
  const valueCol = line.indexOf("5 m");
  assert.equal(spanAtColumn(line, exprCol, cfg)?.expr, "4 m + 1 m", "inside the expression");
  assert.equal(spanAtColumn(line, valueCol, cfg), null, "the materialized value is not editable Numbat");
  assert.equal(spanAtColumn(line, line.indexOf("nc`"), cfg), null, "the prefix is outside");
  assert.equal(spanAtColumn(line, line.indexOf(" and"), cfg), null, "prose is outside");
  assert.equal(spanAtColumn(line, line.indexOf("2 m"), cfg)?.expr, "2 m", "the second span hits too");
});

test("spanAtColumn: a span's {…} config is not expression region", () => {
  const line = "x n`{dp=2} 5 km` y";
  assert.equal(spanAtColumn(line, line.indexOf("dp"), cfg), null, "inside the config");
  assert.equal(spanAtColumn(line, line.indexOf("5 km"), cfg)?.expr, "5 km", "past it, the expression");
});

// --- scanNote ---------------------------------------------------------------

function inlineExprs(units: NoteUnit[]): string[] {
  return units.filter((u) => u.kind === "inline").map((u) => (u as { span: { expr: string; }; }).span.expr);
}

test("scanNote: inline spans in prose are collected in document order", () => {
  const units = scanNote(["intro n`1 m`", "middle", "end n`2 m`"], cfg);
  assert.deepEqual(inlineExprs(units), ["1 m", "2 m"]);
  assert.deepEqual(units.map((u) => u.line), [0, 2]);
});

test("scanNote: inline spans inside a non-numbat code fence ARE detected", () => {
  const lines = ["before n`1 m`", "```js", "const x = n`3 m`;", "```", "after n`2 m`"];
  assert.deepEqual(inlineExprs(scanNote(lines, cfg)), ["1 m", "3 m", "2 m"]);
});

test("scanNote: a nested numbat fence inside another block is not treated as numbat", () => {
  // The inner ```numbat is content of the outer ```text block (the first bare ``` closes the outer
  // fence), so it is scanned as ordinary code — its span detected, not skipped as a real numbat
  // block.
  const lines = ["```text", "```numbat", "x n`5 m`", "```", "after n`2 m`"];
  assert.deepEqual(inlineExprs(scanNote(lines, cfg)), ["5 m", "2 m"]);
});

test("scanNote: a numbat-shared block contributes its body as a shared unit", () => {
  const lines = ["```numbat-shared", "let base = 10 m", "```", "use it: n`base * 2`"];
  const units = scanNote(lines, cfg);
  assert.equal(units.length, 2);
  assert.equal(units[0].kind, "shared");
  assert.equal((units[0] as { code: string; }).code, "let base = 10 m");
  assert.equal(units[1].kind, "inline");
  // The shared block closes (line 2) before the inline span (line 3), so state is available to it.
  assert.ok(units[0].line < units[1].line);
});

test("scanNote: a plain numbat block is not shared and hides its inner spans", () => {
  const lines = ["```numbat", "let secret = 1", "n`inside`", "```", "outside n`ok`"];
  const units = scanNote(lines, cfg);
  assert.equal(units.filter((u) => u.kind === "shared").length, 0);
  assert.deepEqual(inlineExprs(units), ["ok"]);
});

test("scanNote: inline spans in YAML frontmatter ARE detected", () => {
  // Frontmatter is scanned like prose (the `---` delimiters carry no spans).
  const lines = ["---", "total: n`5 km + 3 mi`", "aliases: [x]", "---", "body n`2 m`"];
  assert.deepEqual(inlineExprs(scanNote(lines, cfg)), ["5 km + 3 mi", "2 m"]);
});

test("scanNote: the frontmatter and code-block scopes can be turned off", () => {
  const lines = ["---", "total: n`1 m`", "---", "prose n`2 m`", "```js", "code n`3 m`", "```"];
  // Both off: only the prose span survives.
  assert.deepEqual(
    inlineExprs(scanNote(lines, { ...cfg, frontmatter: false, codeBlocks: false })),
    ["2 m"],
  );
  // Frontmatter off, code blocks on.
  assert.deepEqual(inlineExprs(scanNote(lines, { ...cfg, frontmatter: false })), ["2 m", "3 m"]);
  // Code blocks off, frontmatter on.
  assert.deepEqual(inlineExprs(scanNote(lines, { ...cfg, codeBlocks: false })), ["1 m", "2 m"]);
});

test("scanNote: numbat-shared state still feeds prose spans when code blocks are off", () => {
  const lines = ["```numbat-shared", "let dist = 4 m", "```", "n`dist`"];
  const units = scanNote(lines, { ...cfg, codeBlocks: false });
  assert.equal(units.filter((u) => u.kind === "shared").length, 1);
  assert.deepEqual(inlineExprs(units), ["dist"]);
});

// --- span config parameters ---------------------------------------------------

test("configParams: comma-separated `key = value?` entries; blank or bare reads null", () => {
  assert.deepEqual(configParams("dp=2"), new Map([["dp", "2"]]));
  assert.deepEqual(configParams(" dp = 2 , other = x "), new Map([["dp", "2"], ["other", "x"]]));
  assert.deepEqual(configParams("dp="), new Map([["dp", null]]));
  assert.deepEqual(configParams("dp"), new Map([["dp", null]]));
  assert.deepEqual(configParams(null), new Map());
  assert.deepEqual(configParams(""), new Map());
});

test("configDecimalPlaces: override, explicit unset, capped", () => {
  const withDefault = { ...cfg, decimalPlaces: 4 };
  assert.equal(configDecimalPlaces("dp=2", withDefault), 2, "a span override wins");
  assert.equal(configDecimalPlaces("dp=", withDefault), null, "blank dp unsets the default");
  assert.equal(configDecimalPlaces(null, withDefault), 4, "no config uses the default");
  assert.equal(configDecimalPlaces(null, cfg), null, "no config, no default");
  assert.equal(configDecimalPlaces("dp=99", cfg), 15, "capped at f64-meaningful places");
});

test("configError: a bare key or a malformed dp value is a syntax error", () => {
  assert.equal(configError(null), null);
  assert.equal(configError(""), null, "an empty config is a no-op");
  assert.equal(configError("dp=2"), null);
  assert.equal(configError("dp="), null, "the explicit-unset form is well-formed");
  assert.equal(configError("future=x, dp=2"), null, "well-formed unknown keys are tolerated");
  assert.match(configError("dp") ?? "", /'dp' is missing its '='/);
  assert.match(configError("dp=2, other") ?? "", /'other' is missing its '='/);
  assert.match(configError("dp=lots") ?? "", /whole number.*'lots'/);
  assert.match(configError("=2") ?? "", /missing its name/);
});

test("configErrorResult: an error-kind result carrying the message", () => {
  const r = configErrorResult("config: 'dp' is missing its '='");
  assert.equal(r.kind, "error");
  assert.equal(r.isError, true);
  assert.equal(r.errorText, "config: 'dp' is missing its '='");
  assert.equal(r.plain, null);
});

test("spanDecimalPlaces: resolves a located span's dp", () => {
  const [span] = findInlineSpans("n`{dp=3} 1/3`", cfg);
  assert.equal(spanDecimalPlaces(span, cfg), 3);
});

// --- inlineScopeAt ------------------------------------------------------------

test("inlineScopeAt: reports whether the last line is scanned for spans", () => {
  assert.equal(inlineScopeAt(["prose"], cfg), true, "prose is always in scope");
  assert.equal(inlineScopeAt(["```numbat", "3 m"], cfg), false, "a numbat body is not");
  assert.equal(inlineScopeAt(["```numbat-shared", "3 m"], cfg), false, "a shared body is not");
  assert.equal(inlineScopeAt(["```js", "code"], cfg), true, "another fence is, when enabled");
  assert.equal(inlineScopeAt(["```js", "code"], { ...cfg, codeBlocks: false }), false, "…and not when off");
  assert.equal(inlineScopeAt(["```js", "code", "```", "after"], cfg), true, "prose after a fence again");
  assert.equal(inlineScopeAt(["---", "total: x"], cfg), true, "frontmatter is, when enabled");
  assert.equal(inlineScopeAt(["---", "total: x"], { ...cfg, frontmatter: false }), false, "…and not when off");
  assert.equal(inlineScopeAt(["---", "a: 1", "---", "body"], cfg), true, "prose after frontmatter");
  assert.equal(inlineScopeAt(["```js"], cfg), false, "a fence opener line carries no spans");
});

// --- evalSignature ----------------------------------------------------------

test("evalSignature: changing a concrete span's materialized value does not change it", () => {
  const a = scanNote(["x nc`5 km + 3 mi ⇒ 8.0 km`"], cfg);
  const b = scanNote(["x nc`5 km + 3 mi ⇒ TOTALLY DIFFERENT`"], cfg);
  assert.equal(evalSignature(a, cfg), evalSignature(b, cfg));
});

test("evalSignature: changing an expression or shared body does change it", () => {
  const base = scanNote(["n`5 km`"], cfg);
  const expr = scanNote(["n`6 km`"], cfg);
  const shared = scanNote(["```numbat-shared", "let a = 1", "```", "n`5 km`"], cfg);
  assert.notEqual(evalSignature(base, cfg), evalSignature(expr, cfg));
  assert.notEqual(evalSignature(base, cfg), evalSignature(shared, cfg));
});

test("evalSignature: the effective decimal places and the config text are part of it", () => {
  const plain = scanNote(["n`5 km`"], cfg);
  const withDp = scanNote(["n`{dp=2} 5 km`"], cfg);
  // A span-level dp, or a different default, changes the signature (the display depends on it).
  assert.notEqual(evalSignature(plain, cfg), evalSignature(withDp, cfg));
  assert.notEqual(evalSignature(plain, cfg), evalSignature(plain, { ...cfg, decimalPlaces: 2 }));
  // A malformed-config edit re-evaluates too: `{dp}` (a syntax error) and `{dp=}` (explicit unset)
  // resolve to the same dp but must not share a cache entry.
  const bare = scanNote(["n`{dp} 5 km`"], cfg);
  const unset = scanNote(["n`{dp=} 5 km`"], cfg);
  assert.notEqual(evalSignature(bare, cfg), evalSignature(unset, cfg));
});

// --- value derivation (pinned HTML from Numbat's HtmlFormatter) --------------

const EXPR_RESULT = `<span class="numbat-operator">=</span> <span class="numbat-value">9</span> `
  + `<span class="numbat-unit">m</span><span class="numbat-dimmed">    [</span>`
  + `<span class="numbat-type-identifier">Length</span><span class="numbat-dimmed">]</span>`;

// splitInterpretOutput wraps a statement's output as `\n{echo}\n\n{result}\n`.
const FULL_OUTPUT = `\n<span class="numbat-identifier">z</span>\n\n    ${EXPR_RESULT}\n`;

test("inlineValueHtml: strips the leading = operator and the trailing [Dim]", () => {
  assert.equal(
    inlineValueHtml(EXPR_RESULT),
    `<span class="numbat-value">9</span> <span class="numbat-unit">m</span>`,
  );
});

test("deriveInlineResult: yields the result, bare value, and plain text of an expression", () => {
  const r = deriveInlineResult(FULL_OUTPUT, false);
  assert.equal(r.kind, "value");
  assert.equal(r.isError, false);
  // The widget fragment keeps the `=` but drops the trailing `[Dim]`.
  assert.equal(
    r.resultHtml,
    `<span class="numbat-operator">=</span> <span class="numbat-value">9</span> <span class="numbat-unit">m</span>`,
  );
  assert.equal(r.valueHtml, `<span class="numbat-value">9</span> <span class="numbat-unit">m</span>`);
  assert.equal(r.plain, "9 m");
});

test("deriveInlineResult: an error carries its summary; a value-less statement is 'none'", () => {
  assert.deepEqual(deriveInlineResult("\nboom: bad input\n  detail art\n", true), {
    kind: "error",
    resultHtml: null,
    valueHtml: null,
    plain: null,
    isError: true,
    errorText: "boom: bad input",
    holeType: null,
    rounded: false,
  });
  // A declaration has an echo but no result fragment.
  const decl = `\n<span class="numbat-keyword">let</span> <span class="numbat-identifier">z</span>\n\n`;
  assert.deepEqual(deriveInlineResult(decl, false), {
    kind: "none",
    resultHtml: null,
    valueHtml: null,
    plain: null,
    isError: false,
    errorText: null,
    holeType: null,
    rounded: false,
  });
});

// --- inlineResultFor (the probes that need an interpreter at hand) -----------

/** A scripted LineInterpret: replies from `responses` by exact input. */
function fakeRun(responses: Record<string, { output: string; isError: boolean; }>) {
  return (code: string) => responses[code] ?? { output: "unscripted input", isError: true };
}

test("inlineResultFor: a non-trivial let binding yields its value as a 'binding'", () => {
  const declEcho = `\n<span class="numbat-keyword">let</span> <span class="numbat-identifier">z</span>\n\n`;
  const run = fakeRun({
    "let z = 4 + 5": { output: declEcho, isError: false },
    "z": { output: FULL_OUTPUT, isError: false },
  });
  const r = inlineResultFor(run, "let z = 4 + 5");
  assert.equal(r.kind, "binding");
  assert.equal(r.plain, "9 m");
  assert.match(r.resultHtml ?? "", /numbat-operator">=/);
});

test("inlineResultFor: a binding whose value repeats its source stays 'none'", () => {
  const declEcho = `\n<span class="numbat-keyword">let</span> <span class="numbat-identifier">z</span>\n\n`;
  const run = fakeRun({
    "let z = 9 m": { output: declEcho, isError: false },
    "z": { output: FULL_OUTPUT, isError: false },
  });
  assert.equal(inlineResultFor(run, "let z = 9 m").kind, "none");
});

test("inlineResultFor: an incomplete expression recovers its typed hole", () => {
  const run = fakeRun({
    "3 m +": { output: "error: parse", isError: true },
    "3 m + ?": { output: "error: Found a hole of type 'Length' here", isError: true },
  });
  const r = inlineResultFor(run, "3 m +");
  assert.equal(r.kind, "hole");
  assert.equal(r.holeType, "Length");
  assert.equal(r.errorText, null);
});

test("inlineResultFor: a plain error keeps its summary (no hole to probe)", () => {
  const run = fakeRun({
    "nope + 1": { output: "error: unknown identifier 'nope'\n  detail", isError: true },
  });
  const r = inlineResultFor(run, "nope + 1");
  assert.equal(r.kind, "error");
  assert.equal(r.errorText, "unknown identifier 'nope'");
});

// A Numbat string result fragment, as the formatter emits for `"…"`.
function stringResult(text: string): string {
  return `\n<span class="numbat-string">&quot;x&quot;</span>\n\n    <span class="numbat-operator">=</span> `
    + `<span class="numbat-string">"${text}"</span><span class="numbat-dimmed">    [</span>`
    + `<span class="numbat-type-identifier">String</span><span class="numbat-dimmed">]</span>\n`;
}

test("inlineResultFor: decimal places swap the plain display for Numbat's fixed form", () => {
  const run = fakeRun({
    "9 m / 7": { output: FULL_OUTPUT, isError: false },
    "\"{(9 m / 7):.2f}\"": { output: stringResult("1.29 m"), isError: false },
  });
  const r = inlineResultFor(run, "9 m / 7", 2);
  assert.equal(r.kind, "value");
  assert.equal(r.rounded, true);
  assert.equal(r.plain, "1.29 m");
  // The formatter fragments are untouched; consumers render from `plain`.
  assert.match(r.resultHtml ?? "", /numbat-value">9</);
});

test("inlineResultFor: a failed format probe falls back to the plain display", () => {
  const run = fakeRun({
    "9 m / 7": { output: FULL_OUTPUT, isError: false },
    // The formatted probe errors (e.g. the value is not a quantity).
  });
  const r = inlineResultFor(run, "9 m / 7", 2);
  assert.equal(r.kind, "value");
  assert.equal(r.rounded, false);
  assert.equal(r.plain, "9 m");
});

// --- noteSignature -----------------------------------------------------------

test("noteSignature separates the generation from the preamble", () => {
  // The generation stands for what a context bakes in beyond the note — the user prelude and the
  // exchange rates. A prelude edit changes nothing in the note, so without this the cached results
  // for every note in the vault would stand.
  const units = scanNote(["n`2 m`"], DEFAULT_INLINE_CONFIG);
  const before = noteSignature(1, "", units, DEFAULT_INLINE_CONFIG);
  const after = noteSignature(2, "", units, DEFAULT_INLINE_CONFIG);
  assert.notEqual(before, after);
  assert.equal(noteSignature(1, "", units, DEFAULT_INLINE_CONFIG), before, "and is stable");
});

test("noteSignature cannot confuse a generation with a preamble", () => {
  // A naive `${generation}${preamble}` concatenation would make these collide.
  assert.notEqual(
    noteSignature(1, "2let x = 1", [], DEFAULT_INLINE_CONFIG),
    noteSignature(12, "let x = 1", [], DEFAULT_INLINE_CONFIG),
  );
});
