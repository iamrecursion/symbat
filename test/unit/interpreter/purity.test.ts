// The purity predicate: which scopes can produce a different answer from the same text.
//
// The stakes are asymmetric and the tests are written to match. A false positive costs one
// re-evaluation — which is what every scope costs today — so the cases that assert `false` are
// about the feature being *worth* having. A false negative shows a frozen clock forever, so the
// cases that assert `true` are the correctness ones, and the string/comment handling is tested from
// both sides for exactly that reason.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { IMPURE_NAMES, impureBindings, readsClockOrRandom } from "../../../src/interpreter/purity.ts";
import type { NotePreamble, PropertyBinding } from "../../../src/properties/parse.ts";

/** A binding carrying `code`, which is what a top-level property produces. */
function binding(name: string, expr: string): PropertyBinding {
  return { key: name, path: [name], name, expr, defs: [], code: `let ${name} = ${expr}`, kind: "expression" };
}

function preamble(bindings: PropertyBinding[], imports?: string[]): NotePreamble {
  return { bindings, skips: [], source: bindings.map((b) => b.code).join("\n"), imports };
}

describe("the pinned name table", () => {
  test("holds both FFI roots and the prelude names that reach them", () => {
    assert.ok(IMPURE_NAMES.includes("now"));
    assert.ok(IMPURE_NAMES.includes("random"));
    // The clock family funnels through one private helper, so all four must be present.
    for (const name of ["_today_str", "today", "time"]) {
      assert.ok(IMPURE_NAMES.includes(name), name);
    }
    // The distributions are impure through `random()`, including the private recursion.
    for (const name of ["rand_uniform", "rand_int", "rand_norm", "rand_poisson", "_poisson"]) {
      assert.ok(IMPURE_NAMES.includes(name), name);
    }
  });

  test("excludes the names that only look impure", () => {
    // Both are invalidated by `interpreterGeneration()` instead — see the module header.
    assert.ok(!IMPURE_NAMES.includes("exchange_rate"));
    assert.ok(!IMPURE_NAMES.includes("get_local_timezone"));
    // The duration family reads `time` as its own parameter, which shadows the prelude function.
    assert.ok(!IMPURE_NAMES.includes("human"));
  });

  test("has no duplicates", () => {
    assert.equal(new Set(IMPURE_NAMES).size, IMPURE_NAMES.length);
  });
});

describe("readsClockOrRandom", () => {
  test("is false for ordinary arithmetic", () => {
    assert.equal(readsClockOrRandom(""), false);
    assert.equal(readsClockOrRandom("let total = 3 m + 4 m"), false);
    assert.equal(readsClockOrRandom("fn area(r) = pi * r^2"), false);
  });

  test("catches a direct call, a bare mention and a higher-order use", () => {
    assert.equal(readsClockOrRandom("now()"), true);
    assert.equal(readsClockOrRandom("let n = now"), true);
    assert.equal(readsClockOrRandom("map(random, xs)"), true);
  });

  test("catches every name in the table", () => {
    for (const name of IMPURE_NAMES) {
      assert.equal(readsClockOrRandom(`let x = ${name}()`), true, name);
    }
  });

  test("matches whole words only", () => {
    assert.equal(readsClockOrRandom("let nowhere = 1"), false);
    assert.equal(readsClockOrRandom("let snow = 1"), false);
    assert.equal(readsClockOrRandom("let random_seed_unused = 1"), false);
    // Unicode identifiers continue a word, so a Greek-prefixed name is not the bare one.
    assert.equal(readsClockOrRandom("let σtime = 1"), false);
  });
});

describe("readsClockOrRandom and text Numbat would not execute", () => {
  test("ignores comments, which is what keeps the predicate useful", () => {
    assert.equal(readsClockOrRandom("# time to destination\nlet d = 4 km"), false);
    assert.equal(readsClockOrRandom("let d = 4 km # fine for now"), false);
    // Numbat's own prelude flags these two without comment stripping, on "constant time".
    assert.equal(readsClockOrRandom("# use Binet's formula for constant time\nround(phi^n)"), false);
  });

  test("ignores string text, including decorator prose", () => {
    assert.equal(readsClockOrRandom("let greeting = \"what is the time now\""), false);
    assert.equal(readsClockOrRandom("@description(\"How long until today\")\nfn f() = 1"), false);
  });

  test("reads string interpolations, which are code", () => {
    assert.equal(readsClockOrRandom("\"{now()}\""), true);
    // How the prelude's own `today()` is written.
    assert.equal(readsClockOrRandom("fn today() = datetime(\"{_today_str()} 00:00:00\")"), true);
  });

  test("does not mistake a `#` inside a string for a comment", () => {
    // The unsound shortcut — splitting on `#` — swallows the rest of the line and misses the call.
    assert.equal(readsClockOrRandom("@url(\"https://example.com/f64.html#method.abs\")\nlet t = now()"), true);
    assert.equal(readsClockOrRandom("let u = \"a # b\" ++ \"c\"\nlet t = random()"), true);
  });

  test("handles escapes and doubled braces without losing the code after them", () => {
    assert.equal(readsClockOrRandom("let s = \"a \\\" b\"\nlet t = now()"), true);
    assert.equal(readsClockOrRandom("let s = \"{{literal}}\"\nlet t = now()"), true);
    assert.equal(readsClockOrRandom("let s = \"{{literal}}\""), false);
  });

  test("does not mistake a struct brace for the end of an interpolation", () => {
    assert.equal(readsClockOrRandom("let s = \"{ Foo { a: 1 }.a } now\""), false);
    assert.equal(readsClockOrRandom("let s = \"{ Foo { a: now() }.a }\""), true);
  });

  test("survives unterminated text without reporting a call inside it", () => {
    assert.equal(readsClockOrRandom("let s = \"unterminated now()"), false);
    assert.equal(readsClockOrRandom("# unterminated now()"), false);
  });
});

describe("impureBindings", () => {
  test("is all false when nothing in the note can change", () => {
    const p = preamble([binding("a", "1"), binding("b", "2 m")]);
    assert.deepEqual(impureBindings(p), [false, false]);
  });

  test("is empty when there are no bindings, impure prelude or not", () => {
    assert.deepEqual(impureBindings(preamble([])), []);
    assert.deepEqual(impureBindings(preamble([]), true), []);
  });

  test("latches from the first binding that reads the clock", () => {
    const p = preamble([binding("a", "1"), binding("b", "now()"), binding("c", "2")]);
    // `c` says nothing impure, but it is evaluated after `b` in a scope `b` has already touched.
    assert.deepEqual(impureBindings(p), [false, true, true]);
  });

  test("is all true when the prelude ahead of the note is impure", () => {
    // The soundness case: the note writes no impure token, but the scope defines one.
    const p = preamble([binding("a", "1"), binding("b", "t()")]);
    assert.deepEqual(impureBindings(p), [false, false]);
    assert.deepEqual(impureBindings(p, true), [true, true]);
  });

  test("is all true when an imported chunk is impure", () => {
    const p = preamble([binding("a", "1"), binding("b", "2")], ["let k = 2", "fn t() = random()"]);
    assert.deepEqual(impureBindings(p), [true, true]);
  });

  test("looks at a binding's defs and expr, not only its statement", () => {
    const withDef: PropertyBinding = {
      key: "o",
      path: ["o"],
      name: "o",
      expr: "1",
      defs: ["fn helper() = now()"],
      code: "let o = 1",
      kind: "expression",
    };
    assert.deepEqual(impureBindings(preamble([binding("a", "1"), withDef, binding("z", "2")])), [false, true, true]);
  });

  test("never goes back to pure once it has gone impure", () => {
    const p = preamble([binding("a", "now()"), binding("b", "1"), binding("c", "2"), binding("d", "3")]);
    assert.deepEqual(impureBindings(p), [true, true, true, true]);
  });
});
