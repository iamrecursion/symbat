// Pins the real Numbat wasm behavior the inlay-hint pass (evaluation/inlay.ts) relies on: that a
// declaration echoes its inferred type, that an expression's result is separated from the echo by a
// blank line, and that a `?` typed hole reports the expected type of a missing operand. If a wasm
// bump changes any of these, the pure parsers in evaluation/inlay-parse.ts would silently stop
// producing hints — so these fail loudly instead. Requires the wasm to be built; self-skips
// otherwise.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  declarationTypeHtml,
  hintsForBlock,
  holeForm,
  parseHoleType,
  splitInterpretOutput,
} from "../../../src/evaluation/inlay-parse.ts";
import { loadNumbat, skip } from "../wasm-pkg.ts";

test("a let binding echoes its inferred type, which declarationTypeHtml extracts", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  const out = nb.interpret("let x = 5 metre");
  assert.equal(out.is_error, false);
  const { echo, result } = splitInterpretOutput(out.output);
  // A declaration produces no value.
  assert.equal(result, null);
  // The `: Type` fragment is present and names the dimension.
  const typeHtml = declarationTypeHtml(echo);
  assert.ok(typeHtml !== null, "expected a type annotation in the echo");
  assert.match(typeHtml, /numbat-type-identifier">Length</);
  out.free();
  nb.free();
});

test("an expression's result is split from its echo and carries a dimension", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  const out = nb.interpret("2 km + 3 m");
  assert.equal(out.is_error, false);
  const { result } = splitInterpretOutput(out.output);
  assert.ok(result !== null, "expected a result fragment");
  assert.match(result, /numbat-value">2003</);
  assert.match(result, /numbat-type-identifier">Length</);
  out.free();
  nb.free();
});

test("a typed hole reports the missing operand's type (trailing operator)", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  const hole = holeForm("3 m +");
  assert.equal(hole, "3 m + ?");
  const out = nb.interpret(hole);
  assert.equal(out.is_error, true); // a hole is reported as a (recoverable) error
  assert.equal(parseHoleType(out.output), "Length");
  out.free();
  nb.free();
});

test("a typed hole reports a function argument's type (open call)", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  const hole = holeForm("sin(");
  assert.equal(hole, "sin( ?)");
  const out = nb.interpret(hole);
  assert.equal(parseHoleType(out.output), "Scalar");
  out.free();
  nb.free();
});

test("hints carry across lines and an error line does not disturb the others", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  // Define a binding, hit an unknown identifier, then use the binding again: the definition
  // survives the bad line (the property evaluation/inlay.ts depends on for per-line evaluation).
  assert.equal(nb.interpret("let a = 3 m").is_error, false);
  assert.equal(nb.interpret("nonexistent(a)").is_error, true);
  const after = nb.interpret("a + 1 m");
  assert.equal(after.is_error, false);
  assert.match(after.output, /numbat-value">4</);
  after.free();
  nb.free();
});

// End-to-end: the real per-line orchestration (evaluation/inlay-parse.ts's hintsForBlock) over a
// whole block, driving the live interpreter through an injected closure — exactly as
// evaluation/inlay.ts's ViewPlugin does, minus the CodeMirror layer.
test("hintsForBlock produces type, result, and typed-hole hints over a real block", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);
  const run = (code: string) => {
    const out = nb.interpret(code);
    const data = { output: out.output, isError: out.is_error };
    out.free();
    return data;
  };

  const body = [
    "let x = 2 m + 3 m", // 0: inferred type hint (`: Length`) + reduced value (`= 5 m`)
    "let y: Length = 2 m", // 1: annotated (no type) and value repeats source (no value) → nothing
    "x + y", // 2: result hint
    "x +", // 3: incomplete → typed-hole hint (Length)
    "# just a comment", // 4: nothing
    "sin(", // 5: incomplete call → typed-hole hint (Scalar)
  ];
  const hints = hintsForBlock(run, body);
  const at = (bodyLine: number, kind: string) => hints.find((h) => h.bodyLine === bodyLine && h.kind === kind);
  const kindsAt = (bodyLine: number) => hints.filter((h) => h.bodyLine === bodyLine).map((h) => h.kind).sort();

  // Line 0 (`let x = 2 m + 3 m`): an inferred type hint just after the name (`let x` → col 5), plus
  // the binding's reduced value at end of line (differs from source).
  assert.equal(at(0, "type")?.column, 5);
  assert.match(at(0, "type")?.content ?? "", /Length/);
  assert.match(at(0, "result")?.content ?? "", /numbat-value">5</);
  // Line 1 (`let y: Length = 2 m`): the user annotated the type (no type hint), and the value `2 m`
  // just repeats the source (no value hint) — so nothing at all.
  assert.equal(kindsAt(1).length, 0);
  // Line 2: an end-of-line result, one virtual space from the code.
  assert.equal(at(2, "result")?.column, body[2].length);
  assert.match(at(2, "result")?.content ?? "", /numbat-value">7</);
  assert.equal(at(2, "result")?.pad, 1);
  // Line 3: an incomplete expression's operand type, via a typed hole (after `+`).
  assert.equal(at(3, "hole")?.content, "Length");
  assert.equal(at(3, "hole")?.pad, 1);
  // Line 4: a comment contributes nothing.
  assert.equal(kindsAt(4).length, 0);
  // Line 5: an open call reports its argument type, butting against the `(`.
  assert.equal(at(5, "hole")?.content, "Scalar");
  assert.equal(at(5, "hole")?.pad, 0);

  nb.free();
});

// A let binding shows its inferred type inline AND its evaluated value at the end of the line (`let
// x = 1 + 3 -> let x: Scalar = 1 + 3 = 4`).
test("a let binding shows its inferred type inline and its evaluated value at end of line", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);
  const run = (code: string) => {
    const out = nb.interpret(code);
    const data = { output: out.output, isError: out.is_error };
    out.free();
    return data;
  };

  const line = "let x = 1 + 3";
  const hints = hintsForBlock(run, [line]);

  const typeHint = hints.find((h) => h.kind === "type");
  assert.ok(typeHint, "expected an inline type hint");
  assert.match(typeHint.content, /Scalar/);
  assert.equal(typeHint.column, "let x".length);

  const valueHint = hints.find((h) => h.kind === "result");
  assert.ok(valueHint, "expected an end-of-line value hint");
  assert.match(valueHint.content, /numbat-value">4</); // the evaluated value, not the source `1 + 3`
  assert.doesNotMatch(valueHint.content, /numbat-dimmed/); // the [dimension] is dropped
  assert.equal(valueHint.column, line.length); // end of line
  assert.equal(valueHint.pad, 1); // one space from the code

  // A binding whose value just repeats the source shows the type but no value.
  const redundant = hintsForBlock(run, ["let z = 9 m"]);
  assert.ok(redundant.some((h) => h.kind === "type"), "expected a type hint");
  assert.equal(redundant.some((h) => h.kind === "result"), false, "no value hint when it repeats the source");

  nb.free();
});

// A statement that fails to evaluate — and offers no typed hole — surfaces its diagnostic's summary
// as an error hint, while a bracketed multi-line expression (valid Numbat) evaluates as one
// statement and shows a result, not errors.
test("a failed statement shows its error summary; multi-line brackets stay one statement", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);
  const run = (code: string) => {
    const out = nb.interpret(code);
    const data = { output: out.output, isError: out.is_error };
    out.free();
    return data;
  };

  // `abs(-5` has no trailing-operator/open slot for a hole (it ends mid-operand), so the parse
  // diagnostic's annotation is surfaced instead.
  const failed = hintsForBlock(run, ["abs(-5"]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].kind, "error");
  assert.equal(failed[0].bodyLine, 0);
  assert.match(failed[0].content, /closing parenthesis/i);

  // The same call split across lines is valid Numbat: one statement, one result hint on its last
  // line, and no error hints anywhere.
  const spanning = hintsForBlock(run, ["abs(", "  -5", ")"]);
  assert.equal(spanning.some((h) => h.kind === "error"), false);
  const result = spanning.find((h) => h.kind === "result");
  assert.ok(result, "expected the multi-line call's result");
  assert.equal(result.bodyLine, 2);
  assert.match(result.content, /numbat-value">5</);

  // An unknown identifier's summary names it via the type checker's annotation.
  const unknown = hintsForBlock(run, ["nonexistent + 1"]);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].kind, "error");
  assert.match(unknown[0].content, /unknown identifier/);

  nb.free();
});

// The REPL hole hint (views/repl.ts's holeTypeFor): an incomplete input's operand type, resolved
// against the live session context, without mutating that context.
test("REPL hole type resolves against a session-defined name and does not mutate it", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  // A prior submitted REPL entry persists in the session context. `dist` avoids Numbat's prelude
  // names (e.g. `d` is the unit for day).
  assert.equal(nb.interpret("let dist = 3 m").is_error, false);

  // A complete input is not an incomplete expression — no hole form, no hint.
  assert.equal(holeForm("dist"), null);

  // The user is typing an incomplete expression referring to the session name.
  const hole = holeForm("dist +");
  assert.equal(hole, "dist + ?");
  const out = nb.interpret(hole);
  assert.equal(parseHoleType(out.output), "Length");
  out.free();

  // Evaluating the hole must not have defined anything or disturbed `dist`.
  const after = nb.interpret("dist");
  assert.equal(after.is_error, false);
  assert.match(after.output, /numbat-value">3</);
  after.free();

  nb.free();
});

// The regression this file exists to catch: a decorator written on its own line is a *prefix* of
// the declaration below it, not a statement. Fed to the interpreter alone it is a different,
// invalid program ("decorators can only be used on unit, let or function definitions"), and the
// declaration below it is then defined undecorated — so the annotation never reaches anything
// downstream. Both halves are checked here against the real wasm.
test("a decorated declaration evaluates as one statement, and its annotations take effect", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);
  const run = (code: string) => {
    const out = nb.interpret(code);
    const data = { output: out.output, isError: out.is_error };
    out.free();
    return data;
  };

  const body = [
    "@description(\"the last element\")",
    "@example(\"last([1, 2])\", \"gives 2\")",
    "fn last<A>(xs: List<A>) -> A = head(reverse(xs))",
    "",
    "last([1, 2, 3])",
  ];
  const hints = hintsForBlock(run, body);

  // No error anywhere — in particular not on either decorator line.
  assert.deepEqual(hints.filter((h) => h.kind === "error").map((h) => h.bodyLine), []);

  // The call below the definition resolves, so the `fn` really was defined.
  const result = hints.find((h) => h.kind === "result" && h.bodyLine === 4);
  assert.ok(result, "expected the call's result");
  assert.match(result.content, /numbat-value">3</);

  // And the decorators reached the interpreter: it can describe the function by them. (`print_info`
  // renders the description but not the examples, so only the former is assertable — the `@example`
  // above earns its place by carrying parens inside its string, which the grouping must not read as
  // the decorator's own closing paren.)
  assert.match(nb.print_info("last"), /Description: the last element/);

  nb.free();
});

// A decorator on a `unit` declaration must still yield the declaration's own hints — the type hint
// is anchored on the declaration line, not on the decorator above it.
test("a decorated let/unit anchors its inline type hint on the declaration line", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);
  const run = (code: string) => {
    const out = nb.interpret(code);
    const data = { output: out.output, isError: out.is_error };
    out.free();
    return data;
  };

  const body = ["@name(\"Widget\")", "@aliases(widgets)", "unit widget = 3 m"];
  const hints = hintsForBlock(run, body);

  assert.deepEqual(hints.filter((h) => h.kind === "error"), []);
  const typeHint = hints.find((h) => h.kind === "type");
  assert.ok(typeHint, "expected an inferred type hint");
  assert.equal(typeHint.bodyLine, 2); // the `unit` line, not either decorator
  assert.equal(typeHint.column, "unit widget".length);
  assert.match(typeHint.content, /Length/);

  // The alias the decorator introduced resolves, so the decorator was really applied.
  const aliased = run("2 widgets");
  assert.equal(aliased.isError, false);

  nb.free();
});

// A decorated `let` whose value just repeats its source shows no value hint — the redundancy check
// reads the whole statement, so an `=` inside a decorator's own text must not be taken for the
// binding's.
test("a decorated let suppresses the value hint that merely repeats its source", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);
  const run = (code: string) => {
    const out = nb.interpret(code);
    const data = { output: out.output, isError: out.is_error };
    out.free();
    return data;
  };

  const body = ["@description(\"where x = 5\")", "let x = 5 m", "@description(\"a sum\")", "let y = 1 m + 3 m"];
  const hints = hintsForBlock(run, body);

  assert.deepEqual(hints.filter((h) => h.kind === "error"), []);

  // `x` binds exactly what it evaluates to, so only its type is annotated.
  assert.deepEqual(hints.filter((h) => h.bodyLine === 1).map((h) => h.kind), ["type"]);

  // `y` reduces, so its value is worth showing — and lands on the declaration line, not on a
  // decorator.
  const valueHint = hints.find((h) => h.bodyLine === 3 && h.kind === "result");
  assert.ok(valueHint, "expected the reduced value");
  assert.match(valueHint.content, /numbat-value">4</);

  nb.free();
});

// A function definition spans lines with every bracket closed: Numbat reads on past its `=` and
// around a `where`/`and`/`then`/`else`. Split apart, the body reports its `where` names as unknown
// identifiers and the clause alone does not parse — which is exactly what the grouper used to do.
test("a multi-line function definition is one statement, however its body is laid out", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);
  const run = (code: string) => {
    const out = nb.interpret(code);
    const data = { output: out.output, isError: out.is_error };
    out.free();
    return data;
  };

  const body = [
    "@description(\"the ratio of two prices\")",
    "fn price_level(local_price: Scalar, bench_price: Scalar) -> Scalar = r",
    "  where r = local_price / bench_price",
    "",
    "fn magnitude(a: Scalar) =",
    "  if a > 0",
    "  then a",
    "  else -a",
    "",
    "magnitude(price_level(10, -5))",
  ];
  const hints = hintsForBlock(run, body);

  // Nothing errored — in particular not the `fn` line missing its `where`, nor the clause alone.
  assert.deepEqual(hints.filter((h) => h.kind === "error").map((h) => h.bodyLine), []);

  // Both definitions really took: the call below them resolves, and to the right number.
  const result = hints.find((h) => h.kind === "result" && h.bodyLine === 9);
  assert.ok(result, "expected the call's result");
  assert.match(result.content, /numbat-value">2</);

  // The decorator above the multi-line definition still reached the interpreter with it.
  assert.match(nb.print_info("price_level"), /Description: the ratio of two prices/);

  nb.free();
});
