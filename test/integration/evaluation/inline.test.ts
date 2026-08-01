// Pins the real Numbat wasm behavior that inline expression evaluation relies on: that an inline
// expression's result reduces to the bare value the reading view / commit forms expect, and —
// crucially — that replaying a note's `numbat-shared` blocks and earlier inline expressions into
// one context makes their bindings visible to a later inline expression (the "shared state +
// earlier inline defs" semantics). Drives the live interpreter through the pure scanner/deriver
// (evaluation/inline-parse.ts), exactly as the ViewPlugin does minus CodeMirror. If a wasm bump
// changes the formatter HTML, the value derivation fails loudly here. Requires the wasm to be
// built; self-skips otherwise.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configError,
  configErrorResult,
  DEFAULT_INLINE_CONFIG,
  type InlineResult,
  inlineResultFor,
  type NoteUnit,
  scanNote,
  spanDecimalPlaces,
} from "../../../src/evaluation/inline-parse.ts";
import { loadNumbat, skip } from "../wasm-pkg.ts";

// The LineInterpret shape inlineResultFor expects, over a live wasm context.
function runnerFor(nb: any) {
  return (code: string) => {
    const out = nb.interpret(code);
    const result = { output: out.output as string, isError: out.is_error as boolean };
    out.free();
    return result;
  };
}

// Mirrors evaluation/inline.ts's `evaluateNoteUnits`: replay every unit into one context in
// document order, deriving each inline expression's result (with its effective decimal places; a
// malformed config surfaces as an error result) — so a later unit sees the state accumulated by
// earlier ones.
function replay(nb: any, units: NoteUnit[]): InlineResult[] {
  const run = runnerFor(nb);
  const results: InlineResult[] = [];
  for (const unit of units) {
    if (unit.kind === "shared") {
      nb.interpret(unit.code).free();
    } else if (configError(unit.span.configText) !== null) {
      run(unit.span.expr); // state effects only
      results.push(configErrorResult(configError(unit.span.configText)!));
    } else {
      results.push(inlineResultFor(run, unit.span.expr, spanDecimalPlaces(unit.span, DEFAULT_INLINE_CONFIG)));
    }
  }
  return results;
}

test("an inline expression reduces to its bare value (no `=`, no `[Dim]`)", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  const result = inlineResultFor(runnerFor(nb), "2 km + 3 m");

  assert.equal(result.kind, "value");
  assert.equal(result.isError, false);
  assert.equal(result.plain, "2003 m");
  // The bare value HTML carries the value and unit, but not the leading `=` operator (stripped) nor
  // the `[Length]` dimension (dropped).
  assert.match(result.valueHtml ?? "", /numbat-value">2003</);
  assert.doesNotMatch(result.valueHtml ?? "", /numbat-operator">=/);
  assert.doesNotMatch(result.valueHtml ?? "", /numbat-dimmed/);
  // The widget fragment keeps the `=` but also drops the `[Length]` dimension.
  assert.match(result.resultHtml ?? "", /numbat-operator">=/);
  assert.doesNotMatch(result.resultHtml ?? "", /numbat-dimmed/);
  assert.doesNotMatch(result.resultHtml ?? "", /numbat-type-identifier">Length</);

  nb.free();
});

test("an inline expression sees a numbat-shared block above it", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  // `dist` avoids Numbat's prelude names (e.g. `base` is a core::strings function).
  const units = scanNote(
    ["```numbat-shared", "let dist = 10 m", "```", "twice that is n`dist * 2`"],
    DEFAULT_INLINE_CONFIG,
  );
  const results = replay(nb, units);

  assert.equal(results.length, 1);
  assert.equal(results[0].plain, "20 m");

  nb.free();
});

test("a later inline expression sees an earlier inline definition", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  // A live span that defines a binding, then one that uses it further down.
  const units = scanNote(["set the step: n`let step = 5 m`", "three steps: n`step * 3`"], DEFAULT_INLINE_CONFIG);
  const results = replay(nb, units);

  assert.equal(results.length, 2);
  // The declaration binds its literal, so its value hint would just repeat the source — nothing
  // shown.
  assert.equal(results[0].kind, "none");
  assert.equal(results[0].plain, null);
  assert.equal(results[0].isError, false);
  // The later expression resolves against it.
  assert.equal(results[1].plain, "15 m");

  nb.free();
});

test("a non-trivial let binding surfaces its evaluated value as a hint", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  const result = inlineResultFor(runnerFor(nb), "let stride = 5 m * 3");

  assert.equal(result.kind, "binding");
  assert.equal(result.plain, "15 m");
  // The hint fragment is `= 15 m`: the `=` kept, no `[Length]` dimension.
  assert.match(result.resultHtml ?? "", /numbat-operator">=/);
  assert.doesNotMatch(result.resultHtml ?? "", /numbat-dimmed/);

  nb.free();
});

test("an incomplete expression recovers its missing operand's type", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  const result = inlineResultFor(runnerFor(nb), "3 m +");

  assert.equal(result.kind, "hole");
  assert.equal(result.holeType, "Length");
  assert.equal(result.plain, null);

  nb.free();
});

test("a concrete span evaluates only the part left of the separator", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  // A concrete span whose stale materialized value is deliberately wrong; only the expression (`4 m
  // + 1 m`) is evaluated, so the fresh value is `5 m`. A typed `=>` alias splits the same way.
  for (const line of ["total nc`4 m + 1 m ⇒ 999 km`", "total nc`4 m + 1 m => 999 km`"]) {
    const units = scanNote([line], DEFAULT_INLINE_CONFIG);
    const results = replay(nb, units);
    assert.equal(results.length, 1);
    assert.equal(results[0].plain, "5 m");
  }

  nb.free();
});

test("decimal places display via Numbat's format specifiers: truncate, pad, keep units", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);
  const run = runnerFor(nb);

  // Truncating: the user's example, 5 + 25/60 = 5.41666… at two places.
  const truncated = inlineResultFor(run, "5 + 25/60", 2);
  assert.equal(truncated.rounded, true);
  assert.equal(truncated.plain, "5.42");
  // Zero-padding: 1.5 at three places gains the zeros.
  assert.equal(inlineResultFor(run, "1.5", 3).plain, "1.500");
  // The unit rides along.
  assert.equal(inlineResultFor(run, "8.05372 km", 2).plain, "8.05 km");
  // A non-quantity value cannot take a precision: unrounded fallback.
  const text = inlineResultFor(run, "\"abc\"", 2);
  assert.equal(text.rounded, false);
  assert.equal(text.kind, "value");
  // A binding's value hint rounds too.
  const binding = inlineResultFor(run, "let stride7 = 9 m / 7", 2);
  assert.equal(binding.kind, "binding");
  assert.equal(binding.plain, "1.29 m");

  nb.free();
});

test("a span's {dp=…} config drives the replay's rounding", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  const units = scanNote(["time n`{dp=3} 5 + 25/60` hours"], DEFAULT_INLINE_CONFIG);
  const results = replay(nb, units);
  assert.equal(results.length, 1);
  assert.equal(results[0].plain, "5.417");
  assert.equal(results[0].rounded, true);

  nb.free();
});

test("a malformed {…} config errors, but its expression still feeds shared state", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  // `{dp}` is missing its `=` — a config syntax error — yet the `let` inside the span still defines
  // `paces` for the span below it.
  const units = scanNote(["set n`{dp} let paces = 5 m`", "use n`paces * 2`"], DEFAULT_INLINE_CONFIG);
  const results = replay(nb, units);
  assert.equal(results.length, 2);
  assert.equal(results[0].kind, "error");
  assert.match(results[0].errorText ?? "", /missing its '='/);
  assert.equal(results[1].plain, "10 m");

  nb.free();
});

test("an errored inline expression yields no value, but carries its summary", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  const result = inlineResultFor(runnerFor(nb), "nonexistent + 1");

  assert.equal(result.kind, "error");
  assert.equal(result.isError, true);
  assert.equal(result.plain, null);
  assert.equal(result.valueHtml, null);
  // The summary names the problem (pin loosely: wording is Numbat's).
  assert.match(result.errorText ?? "", /unknown identifier/);

  nb.free();
});
