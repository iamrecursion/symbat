import assert from "node:assert/strict";
import { test } from "node:test";
import { declaredSymbolAt } from "../../../src/hover/declarations.ts";

// A note's worth of declarations: a one-line function, a multi-line generic one, and a struct — the
// three shapes that introduce names no interpreter context knows.
const LINES = [
  "fn double(x: Scalar) -> Scalar = 2 x",
  "",
  "fn mean<D: Dim>(xs: List<D>) -> D =",
  "  sum(xs) / len(xs)",
  "",
  "struct Costs {",
  "  total: Money,",
  "  tax: Money,",
  "}",
  "",
  "let paid = 3",
];

/** `declaredSymbolAt` as a readable tuple. */
function declared(line: number, name: string) {
  const found = declaredSymbolAt(LINES, line, name);
  return found === null ? null : [found.kind, found.name, found.type, found.owner];
}

test("a parameter is declared by the function it belongs to", () => {
  assert.deepEqual(declared(0, "x"), ["parameter", "x", "Scalar", "double"]);
});

test("a parameter is found from the body, lines below its signature", () => {
  assert.deepEqual(declared(3, "xs"), ["parameter", "xs", "List<D>", "mean"]);
});

test("a type parameter is distinguished from a value one, with its bound", () => {
  assert.deepEqual(declared(3, "D"), ["type parameter", "D", "Dim", "mean"]);
});

test("a struct's fields are declared by the struct", () => {
  assert.deepEqual(declared(6, "total"), ["field", "total", "Money", "Costs"]);
  assert.deepEqual(declared(7, "tax"), ["field", "tax", "Money", "Costs"]);
});

test("a name the enclosing declaration does not introduce is not declared", () => {
  assert.equal(declared(3, "sum"), null, "a function called in the body");
  assert.equal(declared(0, "Scalar"), null, "the type itself is not a parameter");
});

test("a parameter is reported even when an outer binding has the same name", () => {
  // The case that made hover show the wrong card: the hover asked the interpreter first, which
  // knows the outer `x` and nothing about the parameter — so a parameter shadowing a variable
  // described the variable. The resolver was always right about this; the callers now consult it
  // before the interpreter.
  const shadowing = [
    "let x = 9",
    "fn foo<A: Dim>(x: DigitalInformation) -> DigitalInformation = x",
  ];
  assert.deepEqual(declaredSymbolAt(shadowing, 1, "x"), {
    kind: "parameter",
    name: "x",
    type: "DigitalInformation",
    owner: "foo",
  });
  assert.deepEqual(declaredSymbolAt(shadowing, 1, "A"), {
    kind: "type parameter",
    name: "A",
    type: "Dim",
    owner: "foo",
  });
  // The outer binding's own line is not inside the declaration, so it is untouched.
  assert.equal(declaredSymbolAt(shadowing, 0, "x"), null);
});

test("nothing is declared outside a declaration, however near", () => {
  // `paid` sits after the struct closed; a stale enclosing declaration must not claim names that
  // merely follow it.
  assert.equal(declared(10, "paid"), null);
  assert.equal(declared(10, "total"), null);
});
