// The display half of the Numbat property widget: what one evaluated outcome is shown as, given
// whether there is an expression beside it. Everything else in properties/type.ts is DOM and
// interpreter work; this is the decision, and it is the whole of what a Bases cell changed.

import assert from "node:assert/strict";
import { test } from "node:test";
import { EVALUATION_LIMIT_TEXT } from "../../../src/interpreter/budget.ts";
import { displayPlan, type PropertyDisplay } from "../../../src/properties/display.ts";

/** Beside an editor the reader can already see — a property row. */
const ANNOTATED = { bare: false, fallback: "5 km + 3 mi" };

/** On its own, as an idle Bases cell — the value *is* the cell. */
const ALONE = { bare: true, fallback: "5 km + 3 mi" };

const VALUE: PropertyDisplay = {
  kind: "value",
  resultHtml: "<span class=\"numbat-operator\">=</span> 9.828 km",
  valueHtml: "9.828 km",
};

test("a value shows its `= value` beside an expression and the bare value without one", () => {
  assert.deepEqual(displayPlan(VALUE, ANNOTATED), { paint: "html", html: VALUE.resultHtml });
  assert.deepEqual(displayPlan(VALUE, ALONE), { paint: "html", html: "9.828 km" });
});

test("a binding's value reads the same way as an expression's", () => {
  const binding: PropertyDisplay = { ...VALUE, kind: "binding" };
  assert.deepEqual(displayPlan(binding, ANNOTATED), { paint: "html", html: VALUE.resultHtml });
  assert.deepEqual(displayPlan(binding, ALONE), { paint: "html", html: "9.828 km" });
});

test("an outcome with nothing to say falls back to the expression, but only when it stands alone", () => {
  // An annotation with nothing to annotate should be silent. A *cell* left blank reads as an empty
  // property rather than as one still being evaluated — or as one whose feature is switched off —
  // so it shows the expression it holds instead.
  assert.deepEqual(displayPlan({ kind: "empty" }, ANNOTATED), { paint: "none" });
  assert.deepEqual(displayPlan({ kind: "empty" }, ALONE), { paint: "text", text: "5 km + 3 mi", cls: null });
});

test("an empty property stays empty rather than falling back to nothing at all", () => {
  assert.deepEqual(displayPlan({ kind: "empty" }, { bare: true, fallback: "" }), { paint: "none" });
});

test("an error is the message, in the error color, wherever it is shown", () => {
  const error: PropertyDisplay = { kind: "error", text: "incompatible dimensions" };
  const plan = { paint: "text", text: "incompatible dimensions", cls: "error" };
  assert.deepEqual(displayPlan(error, ANNOTATED), plan);
  assert.deepEqual(displayPlan(error, ALONE), plan);
});

test("a warning keeps its own color rather than borrowing the error's", () => {
  const warning: PropertyDisplay = { kind: "warning", text: "a bare 0 is a Scalar" };
  const plan = { paint: "text", text: "a bare 0 is a Scalar", cls: "warning" };
  assert.deepEqual(displayPlan(warning, ANNOTATED), plan);
  assert.deepEqual(displayPlan(warning, ALONE), plan);
});

test("an incomplete expression shows the missing operand's type either way", () => {
  const plan = { paint: "text", text: "⟨Length⟩", cls: null };
  assert.deepEqual(displayPlan({ kind: "hole", type: "Length" }, ANNOTATED), plan);
  assert.deepEqual(displayPlan({ kind: "hole", type: "Length" }, ALONE), plan);
});

// The evaluation limit needs no display kind of its own: it arrives as an ordinary error outcome
// and is painted by the path errors already take. This is what "no new PropertyDisplay variant" is
// worth as an assertion rather than a claim — if a future refactor gives refusals their own kind,
// every surface that renders one has to learn about it, and this is where that shows up first.
test("the evaluation limit paints through the error path, in a row and in a bare cell alike", () => {
  const refused: PropertyDisplay = { kind: "error", text: EVALUATION_LIMIT_TEXT };

  assert.deepEqual(displayPlan(refused, ANNOTATED), { paint: "text", text: EVALUATION_LIMIT_TEXT, cls: "error" });
  assert.deepEqual(displayPlan(refused, ALONE), { paint: "text", text: EVALUATION_LIMIT_TEXT, cls: "error" });
});
