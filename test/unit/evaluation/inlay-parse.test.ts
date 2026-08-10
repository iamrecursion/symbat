import assert from "node:assert/strict";
import { test } from "node:test";
import type { NumbatBlockRange } from "../../../src/document/fences.ts";
import {
  bindingValueRepeatsSource,
  blankStrings,
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

test("declarationSite: decorators on the declaration's own line are stepped over", () => {
  // `nameEnd` is a column on that line, so it counts the decorators it skipped.
  assert.deepEqual(declarationSite("@metric_prefixes unit foo = 3 m"), {
    keyword: "unit",
    name: "foo",
    nameEnd: 25,
    annotated: false,
  });
  assert.deepEqual(declarationSite("@name(\"Foo\") @aliases(f) let x: Length = 5 m"), {
    keyword: "let",
    name: "x",
    nameEnd: 30,
    annotated: true,
  });
});

test("declarationSite: a paren inside a decorator's own text does not end the prefix", () => {
  // `@example` carries code by definition, so its argument routinely holds parens. Blanking the
  // strings preserves length, so `nameEnd` is still a column of the original line.
  const line = "@example(\"f([1, 2])\") let total = 3 m";
  assert.deepEqual(declarationSite(line), {
    keyword: "let",
    name: "total",
    nameEnd: line.indexOf("total") + "total".length,
    annotated: false,
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

test("resultValueHtml: an undefined inside the value is not mistaken for the annotation", () => {
  // An undefined frontmatter property renders as its own faint span, and it must not be the class
  // this cut looks for — see interpreter/nullable-display.ts, which is where that is enforced.
  // Wearing `numbat-dimmed` it ended the value early: `[70, nil]` came back as `[70,`, and the
  // inline-eval widget committed that truncation into the note.
  const list = `<span class="numbat-operator">[</span><span class="numbat-value">70</span>`
    + `<span class="numbat-operator">,</span> <span class="numbat-undefined">nil</span>`
    + `<span class="numbat-operator">]</span>`;
  const value = resultValueHtml(resultFragment(list, "List"));

  assert.match(value, /numbat-undefined">nil</);
  assert.match(value, /numbat-operator">\]</, "the value was cut short");
  // The annotation itself still goes.
  assert.doesNotMatch(value, /numbat-dimmed/);
  assert.doesNotMatch(value, /List/);
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

test("bindingValueRepeatsSource: a whole statement's decorators and comments are stepped over", () => {
  const value = resultFragment(`<span class="numbat-value">5</span> <span class="numbat-unit">m</span>`, "Length");

  // The statement carries its decorators, so an `=` inside one of their strings must not be
  // mistaken for the binding's — or the right-hand side reads as `5") let x = 5 m` and the
  // redundant hint is shown after all.
  assert.equal(bindingValueRepeatsSource("@description(\"x = 5\")\nlet x = 5 m", value), true);

  // A `#` on one line ends that line's code, not the statement's: the declaration below a commented
  // decorator is still found.
  assert.equal(bindingValueRepeatsSource("@name(\"Ex\") # why\nlet x = 5 m", value), true);

  // And a comment after the value still ends it.
  assert.equal(bindingValueRepeatsSource("let x = 5 m # five", value), true);
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

test("blankStrings: a literal's contents go, its quotes and the line's length stay", () => {
  assert.equal(blankStrings("f(\"a ( b\") + 1"), "f(\"     \") + 1");
  // The escape and the character it escapes are one unit, and both are blanked.
  assert.equal(blankStrings("\"a\\\"b\""), "\"    \"");
  // Nothing outside a literal is touched.
  assert.equal(blankStrings("1 + 1"), "1 + 1");
});

test("blankStrings: a newline ends a literal left open, so it cannot blank the lines below", () => {
  // Numbat has no multi-line string, and a half-typed one is routine while typing — letting it
  // reach down the document would blank out the declaration the completer is looking for.
  assert.equal(blankStrings("let s = \"abc\nfn f(x: Scalar) = x"), "let s = \"   \nfn f(x: Scalar) = x");

  // A backslash at the line's end escapes nothing: the newline survives, and so does the length.
  const dangling = "let s = \"abc\\\nfn f(x: Scalar) = x";
  assert.equal(blankStrings(dangling), "let s = \"    \nfn f(x: Scalar) = x");
  assert.equal(blankStrings(dangling).length, dangling.length);
  assert.equal(blankStrings(dangling).split("\n").length, 2);
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

test("errorSummary: an unsolved HasField becomes a sentence about what caused it", () => {
  // The raw form names a generated struct the reader never wrote and dumps its whole type. What
  // they need to know is nowhere in it: some field of that object has no type of its own.
  const singular = "error: Could not solve the following constraint: "
    + "HasField(_Nb_StateDataStruct_1pnpqoo_6_2&lt;Fn[(DateTime) -&gt; DateTime]&gt; "
    + "{Time_Zone: Fn[(DateTime) -&gt; DateTime]}, \"Time_Zone\", Fn[(DateTime) -&gt; T495])\n"
    + "  ┌─ <input>:1:1\n";
  assert.match(errorSummary(singular) ?? "", /^field 'Time_Zone' cannot be read/);
  assert.match(errorSummary(singular) ?? "", /bare 0/, "and says what to look for");

  // The plural form is the one that mattered most: the constraints sit on the lines *below* the
  // header, which `errorSummary` drops, so it used to return a sentence with no content at all.
  const plural = "error: Could not solve the following constraints:\n"
    + "  HasField(_Nb_S_x_0_0 {Population: T389}, \"Population\", T389)\n"
    + "  HasField(T389, \"Current\", T392)\n"
    + "  ┌─ :1:1\n";
  assert.match(errorSummary(plural) ?? "", /^field 'Population' cannot be read/, "the outermost field, not the last");
});

test("errorSummary: every other diagnostic is left exactly as it was", () => {
  // Including an unsolved constraint of some *other* kind, whose own header is the better answer.
  assert.equal(
    errorSummary("error: Could not solve the following constraint: Dim(T1)\n  ┌─ art\n"),
    "Could not solve the following constraint: Dim(T1)",
  );
  assert.equal(errorSummary("error: Could not solve the constraint\n  ┌─ art\n"), "Could not solve the constraint");
});

// --- groupStatements ----------------------------------------------------------

test("groupStatements: balanced lines are single-line statements; blanks are skipped", () => {
  assert.deepEqual(groupStatements(["let x = 2 m", "", "x + 1 m"]), [
    { startLine: 0, codeLine: 0, endLine: 0, text: "let x = 2 m" },
    { startLine: 2, codeLine: 2, endLine: 2, text: "x + 1 m" },
  ]);
});

test("groupStatements: an open bracket absorbs lines until it balances", () => {
  assert.deepEqual(groupStatements(["abs(", "  -5", ")", "1 m"]), [
    { startLine: 0, codeLine: 0, endLine: 2, text: "abs(\n  -5\n)" },
    { startLine: 3, codeLine: 3, endLine: 3, text: "1 m" },
  ]);
});

test("groupStatements: an unclosed bracket at end of block closes the statement there", () => {
  assert.deepEqual(groupStatements(["1 m", "abs(-5"]), [
    { startLine: 0, codeLine: 0, endLine: 0, text: "1 m" },
    { startLine: 1, codeLine: 1, endLine: 1, text: "abs(-5" },
  ]);
});

test("groupStatements: brackets inside strings and comments do not count", () => {
  assert.deepEqual(groupStatements(["\"a ( b\"", "1 m # not open (("]), [
    { startLine: 0, codeLine: 0, endLine: 0, text: "\"a ( b\"" },
    { startLine: 1, codeLine: 1, endLine: 1, text: "1 m # not open ((" },
  ]);
});

// --- groupStatements: multi-line definitions ----------------------------------
//
// A function definition spans lines with every bracket closed — Numbat reads on past the `=` and
// around a `where`/`and`/`then`/`else` (syntax/statements.ts). Split apart, the body reports its
// `where` names as unknown identifiers and the clause alone does not parse at all.

test("groupStatements: a `where` clause belongs to the definition above it", () => {
  const body = [
    "@description(\"the PTB price level\")",
    "fn price_level(local_price: Money, bench_price: Money) -> Scalar = r",
    "  where r = local_price / bench_price",
    "",
    "price_level(10 EUR, 5 EUR)",
  ];
  assert.deepEqual(groupStatements(body), [
    { startLine: 0, codeLine: 1, endLine: 2, text: body.slice(0, 3).join("\n") },
    { startLine: 4, codeLine: 4, endLine: 4, text: body[4] },
  ]);
});

test("groupStatements: each `and` binding continues the `where` it extends", () => {
  const body = ["fn f(a: Scalar) = r + s", "  where r = a", "  and s = a * 2", "1 + 1"];
  assert.deepEqual(groupStatements(body), [
    { startLine: 0, codeLine: 0, endLine: 2, text: body.slice(0, 3).join("\n") },
    { startLine: 3, codeLine: 3, endLine: 3, text: "1 + 1" },
  ]);
});

test("groupStatements: a body on the line below the `=`, and a multi-line `if`", () => {
  const body = ["fn sign(a: Scalar) =", "  if a > 0", "  then 1", "  else -1", "sign(2)"];
  assert.deepEqual(groupStatements(body), [
    { startLine: 0, codeLine: 0, endLine: 3, text: body.slice(0, 4).join("\n") },
    { startLine: 4, codeLine: 4, endLine: 4, text: "sign(2)" },
  ]);
});

test("groupStatements: a blank line or a comment between a body and its `where` still binds", () => {
  // Numbat's parser steps over both, so a note written between the two does not break them apart.
  const body = ["fn f(a: Scalar) = r", "", "  # why it is halved", "  where r = a / 2"];
  assert.deepEqual(groupStatements(body), [
    { startLine: 0, codeLine: 0, endLine: 3, text: body.join("\n") },
  ]);
});

test("groupStatements: a trailing operator is not a continuation", () => {
  // Numbat rejects `3 m +` ⏎ `2 m`, so the two stay separate statements — which is what leaves the
  // first free to report the type of the operand it is missing.
  assert.deepEqual(groupStatements(["3 m +", "2 m"]), [
    { startLine: 0, codeLine: 0, endLine: 0, text: "3 m +" },
    { startLine: 1, codeLine: 1, endLine: 1, text: "2 m" },
  ]);
  // Nor is a comparison's `=`, which only looks like a definition's.
  assert.deepEqual(groupStatements(["1 ==", "1"]).length, 2);
});

test("groupStatements: a definition's `=` with nothing below it ends the statement", () => {
  assert.deepEqual(groupStatements(["let x =", "", ""]), [
    { startLine: 0, codeLine: 0, endLine: 0, text: "let x =" },
  ]);
});

// --- groupStatements: decorators ----------------------------------------------
//
// A decorator is a prefix of the statement below it, not a statement — evaluating one alone is a
// different, invalid program, and it leaves the declaration undecorated. `codeLine` is where the
// statement proper starts, which is what a caller reading a declaration off "the first line" wants.

test("groupStatements: a decorator absorbs the declaration below it", () => {
  assert.deepEqual(groupStatements(["@name(\"Foo\")", "unit foo = 1 m", "2 foo"]), [
    { startLine: 0, codeLine: 1, endLine: 1, text: "@name(\"Foo\")\nunit foo = 1 m" },
    { startLine: 2, codeLine: 2, endLine: 2, text: "2 foo" },
  ]);
});

test("groupStatements: decorators stack, and each argument shape is recognized", () => {
  const body = ["@metric_prefixes", "@aliases(m: short)", "@description(\"a length\")", "unit foo = 1 m"];
  assert.deepEqual(groupStatements(body), [
    { startLine: 0, codeLine: 3, endLine: 3, text: body.join("\n") },
  ]);
});

test("groupStatements: a blank line or a comment between a decorator and its declaration still binds", () => {
  // Numbat's parser skips empty lines after a decorator before reading the statement, and comments
  // never reach it at all.
  assert.deepEqual(groupStatements(["@name(\"Foo\")", "", "# why it is named", "unit foo = 1 m"]), [
    { startLine: 0, codeLine: 3, endLine: 3, text: "@name(\"Foo\")\n\n# why it is named\nunit foo = 1 m" },
  ]);
});

test("groupStatements: a decorated declaration's open bracket still absorbs to its close", () => {
  const body = ["@description(\"first\")", "fn first(xs) = xs[", "  0", "]"];
  assert.deepEqual(groupStatements(body), [
    { startLine: 0, codeLine: 1, endLine: 3, text: body.join("\n") },
  ]);
});

test("groupStatements: a multi-line decorator argument is still only a prefix", () => {
  const body = ["@aliases(", "  metre,", "  meters", ")", "unit foo = 1 m"];
  assert.deepEqual(groupStatements(body), [
    { startLine: 0, codeLine: 4, endLine: 4, text: body.join("\n") },
  ]);
});

test("groupStatements: a decorator on the declaration's own line is one statement, code from the top", () => {
  assert.deepEqual(groupStatements(["@metric_prefixes unit foo = 1 m"]), [
    { startLine: 0, codeLine: 0, endLine: 0, text: "@metric_prefixes unit foo = 1 m" },
  ]);
});

test("groupStatements: a dangling decorator still evaluates, anchored on its own last line", () => {
  // It is an error either way — but the error belongs on the decorator, not on the empty space the
  // user had not filled in yet.
  assert.deepEqual(groupStatements(["1 m", "@name(\"Foo\")", "", ""]), [
    { startLine: 0, codeLine: 0, endLine: 0, text: "1 m" },
    { startLine: 1, codeLine: 1, endLine: 1, text: "@name(\"Foo\")" },
  ]);
});

test("groupStatements: a decorator's own text may hold parens without ending it", () => {
  // `@example` arguments routinely contain calls; the closing paren is the one outside the string.
  const body = ["@example(\"last([1, 2])\", \"a list\")", "@description(\"the last element\")", "fn last(xs) = xs"];
  assert.deepEqual(groupStatements(body), [
    { startLine: 0, codeLine: 2, endLine: 2, text: body.join("\n") },
  ]);
});

test("groupStatements: an `@` inside an expression is not a decorator", () => {
  assert.deepEqual(groupStatements(["\"a @name b\"", "1 m"]), [
    { startLine: 0, codeLine: 0, endLine: 0, text: "\"a @name b\"" },
    { startLine: 1, codeLine: 1, endLine: 1, text: "1 m" },
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
