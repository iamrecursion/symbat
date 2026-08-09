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

test("a `where` local is declared by the function whose body binds it", () => {
  // A local exists only inside its function, so no context has heard of it either — and after the
  // grouper learned to keep the clause with its definition, this is a name the completer offers.
  const local = [
    "let r = 9",
    "fn price_level(local_price: Money, bench_price: Money) -> Scalar = r",
    "  where r: Scalar = local_price / bench_price",
    "  and half = r / 2",
  ];
  assert.deepEqual(declaredSymbolAt(local, 2, "r"), {
    kind: "local",
    name: "r",
    type: "Scalar",
    owner: "price_level",
  });
  assert.deepEqual(declaredSymbolAt(local, 3, "half"), {
    kind: "local",
    name: "half",
    type: null,
    owner: "price_level",
  });
  // The parameters are still parameters, and the outer `r` on its own line is untouched.
  assert.equal(declaredSymbolAt(local, 2, "local_price")?.kind, "parameter");
  assert.equal(declaredSymbolAt(local, 0, "r"), null);
});

test("a name bound in a `then`/`else` body is still inside its declaration", () => {
  // `then` and `else` open a continuation line of their own, as `where` does.
  const branching = ["fn sign(a: Scalar) =", "  if a > 0", "  then a", "  else -a"];
  assert.deepEqual(declaredSymbolAt(branching, 3, "a"), {
    kind: "parameter",
    name: "a",
    type: "Scalar",
    owner: "sign",
  });
});

test("a decorator on the declaration's own line is stepped over, parens in its text and all", () => {
  // Without this, a decorated `fn` is not recognized as the enclosing declaration, and a parameter
  // hover falls through to whatever outer binding happens to share the name.
  const decorated = [
    "let x = 9",
    "@example(\"double(2)\") fn double(x: Scalar) -> Scalar = 2 x",
  ];
  assert.deepEqual(declaredSymbolAt(decorated, 1, "x"), {
    kind: "parameter",
    name: "x",
    type: "Scalar",
    owner: "double",
  });
});
