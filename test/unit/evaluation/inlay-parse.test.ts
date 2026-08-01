import assert from "node:assert/strict";
import { test } from "node:test";
import type { NumbatBlockRange } from "../../../src/document/fences.ts";
import {
  bindingValueRepeatsSource,
  blockKey,
  declarationSite,
  declarationTypeHtml,
  endPadding,
  errorSummary,
  groupStatements,
  hintsForBlock,
  holeForm,
  parseHoleType,
  resultValueHtml,
  splitInterpretOutput,
  stripLineComment,
} from "../../../src/evaluation/inlay-parse.ts";

// HTML shapes below are copied from Numbat's real HtmlFormatter output (see the integration probe /
// interpret.test.ts); the integration tests pin them against the live wasm so a version bump that
// changes them fails loudly.

const LET_ECHO = `\n<span class="numbat-keyword">let</span> <span class="numbat-identifier">z</span>`
  + `<span class="numbat-operator">:</span> <span class="numbat-type-identifier">Length</span> `
  + `<span class="numbat-operator">=</span> <span class="numbat-value">9</span> `
  + `<span class="numbat-unit">metre</span>\n\n`;

const EXPR_RESULT = `\n<span class="numbat-identifier">z</span>\n\n    `
  + `<span class="numbat-operator">=</span> <span class="numbat-value">9</span> <span class="numbat-unit">m</span>`
  + `<span class="numbat-dimmed">    [</span><span class="numbat-type-identifier">Length</span>`
  + `<span class="numbat-dimmed">]</span>\n`;

test("splitInterpretOutput: a declaration has an echo and no result", () => {
  const { echo, result } = splitInterpretOutput(LET_ECHO);
  assert.equal(result, null);
  assert.match(echo, /^<span class="numbat-keyword">let<\/span>/);
  assert.doesNotMatch(echo, /^\n/);
});

test("splitInterpretOutput: an expression has both an echo and a result", () => {
  const { echo, result } = splitInterpretOutput(EXPR_RESULT);
  assert.equal(echo, `<span class="numbat-identifier">z</span>`);
  assert.ok(result !== null);
  // The result's leading indentation is stripped, so it starts at the `=` span.
  assert.match(result, /^<span class="numbat-operator">=<\/span>/);
  assert.match(result, /numbat-type-identifier">Length</);
});

test("splitInterpretOutput: a comment or blank line yields nothing", () => {
  assert.deepEqual(splitInterpretOutput("\n\n"), { echo: "", result: null });
});

test("declarationTypeHtml: extracts the `: Type` fragment from a binding echo", () => {
  const { echo } = splitInterpretOutput(LET_ECHO);
  assert.equal(
    declarationTypeHtml(echo),
    `<span class="numbat-operator">:</span> <span class="numbat-type-identifier">Length</span>`,
  );
});

test("declarationTypeHtml: returns null when the echo has no annotation", () => {
  assert.equal(declarationTypeHtml(`<span class="numbat-identifier">z</span>`), null);
});

test("declarationSite: a plain let is unannotated, with the name and its end located", () => {
  assert.deepEqual(declarationSite("let x = 5 m"), { keyword: "let", name: "x", nameEnd: 5, annotated: false });
});

test("declarationSite: an explicit annotation is detected (so no inferred hint)", () => {
  assert.deepEqual(declarationSite("let x: Length = 5 m"), { keyword: "let", name: "x", nameEnd: 5, annotated: true });
});

test("declarationSite: a unit declaration is recognized, leading indent included", () => {
  assert.deepEqual(declarationSite("  unit foo = 3 m"), {
    keyword: "unit",
    name: "foo",
    nameEnd: 10,
    annotated: false,
  });
  assert.deepEqual(declarationSite("unit foo: Length = 3 m"), {
    keyword: "unit",
    name: "foo",
    nameEnd: 8,
    annotated: true,
  });
});

test("resultValueHtml: drops the trailing [dimension] annotation", () => {
  const { result } = splitInterpretOutput(EXPR_RESULT);
  assert.ok(result !== null);
  const value = resultValueHtml(result);
  assert.match(value, /numbat-value">9</);
  assert.match(value, /numbat-unit">m</);
  assert.doesNotMatch(value, /numbat-dimmed/);
  assert.doesNotMatch(value, /Length/);
});

test("resultValueHtml: leaves a fragment with no dimension unchanged", () => {
  const frag = `<span class="numbat-operator">=</span> <span class="numbat-value">4</span>`;
  assert.equal(resultValueHtml(frag), frag);
});

// A `= value [Dim]` result fragment, as splitInterpretOutput yields for a name.
function resultFragment(valueSpans: string, dim: string): string {
  return `<span class="numbat-operator">=</span> ${valueSpans}`
    + `<span class="numbat-dimmed">    [</span><span class="numbat-type-identifier">${dim}</span>`
    + `<span class="numbat-dimmed">]</span>`;
}

test("bindingValueRepeatsSource: true when the value matches the bound source", () => {
  const value = resultFragment(`<span class="numbat-value">5</span> <span class="numbat-unit">m</span>`, "Length");
  assert.equal(bindingValueRepeatsSource("let x = 5 m", value), true);
  // Whitespace differences do not matter.
  assert.equal(bindingValueRepeatsSource("let x   =   5 m", value), true);
  // The annotation before `=` is ignored (the first `=` is the binding).
  const two = resultFragment(`<span class="numbat-value">2</span> <span class="numbat-unit">m</span>`, "Length");
  assert.equal(bindingValueRepeatsSource("let y: Length = 2 m", two), true);
});

test("bindingValueRepeatsSource: false when evaluation reduces the expression", () => {
  const value = resultFragment(`<span class="numbat-value">4</span>`, "Scalar");
  assert.equal(bindingValueRepeatsSource("let x = 1 + 3", value), false);
});

test("declarationSite: an expression is not a declaration", () => {
  assert.equal(declarationSite("2 km + 3 m"), null);
  assert.equal(declarationSite("# let x = 5"), null);
});

test("stripLineComment: strips a trailing comment but keeps `#` inside a string", () => {
  assert.equal(stripLineComment("1 + 1 # note"), "1 + 1 ");
  assert.equal(stripLineComment("\"# not a comment\""), "\"# not a comment\"");
  assert.equal(stripLineComment("a + \"b\\\"# c\" # real"), "a + \"b\\\"# c\" ");
});

test("holeForm: a trailing operator gets a hole operand", () => {
  assert.equal(holeForm("3 m +"), "3 m + ?");
  assert.equal(holeForm("3 m ->"), "3 m -> ?");
  assert.equal(holeForm("let x ="), "let x = ?");
});

test("holeForm: an open call/argument gets a hole and balanced parens", () => {
  assert.equal(holeForm("sin("), "sin( ?)");
  assert.equal(holeForm("max(1,"), "max(1, ?)");
});

test("holeForm: a complete expression, comment, or blank has no hole", () => {
  assert.equal(holeForm("3 m"), null);
  assert.equal(holeForm("  # comment"), null);
  assert.equal(holeForm(""), null);
});

test("parseHoleType: reads the type from a typed-hole diagnostic", () => {
  const diagnostic = [
    "error: Found typed hole",
    "1 │ 3 m + ?",
    "  │       ^ Length",
    "  = Found a hole of type 'Length' in the statement:",
    "  =   3 metre + ?",
  ].join("\n");
  assert.equal(parseHoleType(diagnostic), "Length");
});

test("parseHoleType: strips HTML tags before matching", () => {
  const html = `= Found a hole of type '<span class="numbat-type-identifier">Scalar</span>' in the statement:`;
  assert.equal(parseHoleType(html), "Scalar");
});

test("parseHoleType: an unconstrained (forall) hole carries no information", () => {
  assert.equal(parseHoleType("Found a hole of type 'forall A. A' in the statement:"), null);
});

test("parseHoleType: a non-hole output yields null", () => {
  assert.equal(parseHoleType("error: while parsing\n  Expected one of: number, identifier"), null);
});

test("endPadding: a result gets one space unless the line already ends in whitespace", () => {
  assert.equal(endPadding("x + y", "result"), 1);
  assert.equal(endPadding("x + y ", "result"), 0);
  assert.equal(endPadding("x + y   ", "result"), 0);
});

test("endPadding: a hole gets one space after an operator or comma, none after `(` or whitespace", () => {
  assert.equal(endPadding("3 m +", "hole"), 1);
  assert.equal(endPadding("max(1,", "hole"), 1);
  assert.equal(endPadding("sin(", "hole"), 0);
  assert.equal(endPadding("3 m + ", "hole"), 0);
});

// --- errorSummary -------------------------------------------------------------

test("errorSummary: an informative header is the summary", () => {
  assert.equal(
    errorSummary(`\n<span class="e">error:</span> Could not solve the constraint\n  ┌─ art\n`),
    "Could not solve the constraint",
  );
  assert.equal(errorSummary("\n\n  \n"), null);
});

test("errorSummary: a generic header defers to the caret annotation, then a note", () => {
  // The `while …` stage header carries no information; the marker line's label does.
  const label = "error: while type checking\n  ┌─ <input>:1:1\n  │\n"
    + "1 │ nonexistent + 1\n  │ ^^^^^^^^^^^ unknown identifier\n";
  assert.equal(errorSummary(label), "unknown identifier");
  // No label on the markers: the first `= note` line stands in.
  const note = "error: runtime error\n  ┌─ :1:1\n  │\n"
    + "1 │ error(\"boom\")\n  │ ^^^^^^^^^^^^^\n  │\n  = User error: boom\n";
  assert.equal(errorSummary(note), "User error: boom");
  // Nothing else at all: the header itself, rather than nothing.
  assert.equal(errorSummary("error: while parsing\n"), "while parsing");
});

// --- groupStatements ----------------------------------------------------------

test("groupStatements: balanced lines are single-line statements; blanks are skipped", () => {
  assert.deepEqual(groupStatements(["let x = 2 m", "", "x + 1 m"]), [
    { startLine: 0, endLine: 0, text: "let x = 2 m" },
    { startLine: 2, endLine: 2, text: "x + 1 m" },
  ]);
});

test("groupStatements: an open bracket absorbs lines until it balances", () => {
  assert.deepEqual(groupStatements(["abs(", "  -5", ")", "1 m"]), [
    { startLine: 0, endLine: 2, text: "abs(\n  -5\n)" },
    { startLine: 3, endLine: 3, text: "1 m" },
  ]);
});

test("groupStatements: an unclosed bracket at end of block closes the statement there", () => {
  assert.deepEqual(groupStatements(["1 m", "abs(-5"]), [
    { startLine: 0, endLine: 0, text: "1 m" },
    { startLine: 1, endLine: 1, text: "abs(-5" },
  ]);
});

test("groupStatements: brackets inside strings and comments do not count", () => {
  assert.deepEqual(groupStatements(["\"a ( b\"", "1 m # not open (("]), [
    { startLine: 0, endLine: 0, text: "\"a ( b\"" },
    { startLine: 1, endLine: 1, text: "1 m # not open ((" },
  ]);
});

// --- hintsForBlock (scripted interpreter) ---------------------------------------

test("hintsForBlock: a failed statement with no hole shows its error summary", () => {
  const responses: Record<string, { output: string; isError: boolean; }> = {
    "abs(-5": {
      output: "error: while parsing\n  ┌─ :1:8\n  │\n1 │ abs(-5\n  │       ^ Expected \")\"\n",
      isError: true,
    },
  };
  const run = (code: string) => responses[code] ?? { output: "error: unscripted", isError: true };
  const hints = hintsForBlock(run, ["abs(-5"]);
  assert.equal(hints.length, 1);
  assert.deepEqual(hints[0], { bodyLine: 0, column: 6, kind: "error", content: "Expected \")\"", pad: 1 });
});

test("hintsForBlock: a multi-line expression evaluates as one statement, hint on its last line", () => {
  const calls: string[] = [];
  const run = (code: string) => {
    calls.push(code);
    return { output: EXPR_RESULT, isError: false };
  };
  const hints = hintsForBlock(run, ["abs(", "  -9", ")"]);
  assert.deepEqual(calls, ["abs(\n  -9\n)"]);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].kind, "result");
  assert.equal(hints[0].bodyLine, 2);
  assert.equal(hints[0].column, 1);
});

// --- blockKey ----------------------------------------------------------------

/** A block range at `openLine` with the given body. */
function block(openLine: number, shared: boolean, ...body: string[]): NumbatBlockRange {
  return { shared, openLine, closeLine: openLine + body.length + 1, bodyStartLine: openLine + 1, body };
}

test("blockKey changes when an earlier shared block's body changes", () => {
  // The bug: `let x = 1` above, `x` below. Editing the first to `let x = 2` left the second block's
  // hint showing `= 1` for the rest of the session, because its own text had not changed — while
  // the rendered block and inline eval updated.
  const later = block(4, false, "x");
  const before = [block(0, true, "let x = 1"), later];
  const after = [block(0, true, "let x = 2"), later];
  assert.notEqual(blockKey(1, "", later, before), blockKey(1, "", later, after));
});

test("blockKey ignores shared blocks that come after it", () => {
  // Only the blocks replayed *ahead* of this one are part of its scope.
  const first = block(0, false, "1 + 1");
  const before = [first, block(4, true, "let y = 1")];
  const after = [first, block(4, true, "let y = 2")];
  assert.equal(blockKey(1, "", first, before), blockKey(1, "", first, after));
});

test("blockKey covers the generation and the preamble", () => {
  const only = block(0, false, "1 + 1");
  const base = blockKey(1, "let p = 1", only, [only]);
  assert.notEqual(base, blockKey(2, "let p = 1", only, [only]), "a prelude or rate change");
  assert.notEqual(base, blockKey(1, "let p = 2", only, [only]), "a property change");
  assert.equal(base, blockKey(1, "let p = 1", only, [only]), "and is stable");
});

test("blockKey cannot confuse a body with the preamble", () => {
  // A naive concatenation would make these collide.
  const a = block(0, false, "b");
  const b = block(0, false, "");
  assert.notEqual(blockKey(1, "a", a, [a]), blockKey(1, "ab", b, [b]));
});
