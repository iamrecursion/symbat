// The two halves of "can this context be handed on": what the last user left behind, and what the
// next user could notice.
//
// Both predicates are lexical and both err towards refusing, so the cases that matter are the ones
// where a wrong `false` would hand somebody a context carrying something they did not put there.
// The `definesNames` cases came with the function from properties/outcomes.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { definesNames, LAST_RESULT_NAMES, readsLastAnswer } from "../../../src/interpreter/reuse.ts";

describe("definesNames", () => {
  it("passes the expressions a property is actually for", () => {
    for (const text of ["2 + 2", "rate * n_hours", "3 m -> ft", "  now()  ", "sum([1, 2])", "# a comment"]) {
      assert.equal(definesNames(text), false, text);
    }
  });

  it("catches every form that would leave something behind in a borrowed context", () => {
    for (
      const text of [
        "let x = 5",
        "unit foo = 2 m",
        "fn double(x: Scalar) = 2 x",
        "dimension Money",
        "struct Point { x: Length }",
        "use units::si",
        "@aliases(m) unit metre = 1 m",
        "1 + 1\nlet x = 5",
        "@metric_prefixes",
      ]
    ) {
      assert.equal(definesNames(text), true, text);
    }
  });

  it("does not lose the declaration behind a decorator whose argument contains a parenthesis", () => {
    // A decorator argument is a Numbat string and may hold anything, `)` included, so a pattern
    // that looked for the closing parenthesis found the wrong one and read the declaration after it
    // as ordinary text. Both of these lines are the shape the standard library is written in.
    assert.equal(definesNames("@url(\"https://en.wikipedia.org/wiki/Mercury_(planet)\") unit mercury = 1 m"), true);
    assert.equal(definesNames("@description(\"radius (in metres)\") let r = 3"), true);
  });

  it("reads a keyword, not a prefix of one", () => {
    assert.equal(definesNames("let_me_be * 2"), false, "a name that merely starts like a keyword");
    assert.equal(definesNames("units_sold * 3"), false);
  });

  it("errs towards refusing, since a wrong `false` is the expensive one", () => {
    // A line of a *string* that reads like a declaration is answered as one. The cost of that is a
    // single interpreter context; the cost of the opposite mistake is a shared context quietly
    // gaining a name, so the reading is not worth the blanking pass it would take to be sure.
    assert.equal(definesNames("\"one\nlet two\""), true);
    // On one line there is no such doubt: the statement is an expression, whatever the string says.
    assert.equal(definesNames("\"let x = 5\""), false);
  });
});

describe("readsLastAnswer", () => {
  it("names exactly the two identifiers Numbat binds from an expression", () => {
    assert.deepEqual([...LAST_RESULT_NAMES], ["ans", "_"]);
  });

  it("catches both, wherever in the expression they appear", () => {
    for (const text of ["ans", "_", "ans * 2", "sqrt(ans)", "2 m\n_ -> ft", "  ans  ", "f(1) + _"]) {
      assert.equal(readsLastAnswer(text), true, text);
    }
  });

  it("passes text that merely contains the letters", () => {
    for (const text of ["answer * 2", "means", "trans_am", "_poisson(2)", "x_", "ANS"]) {
      assert.equal(readsLastAnswer(text), false, text);
    }
  });

  // `_` is Numbat's digit separator as well as its last-result name, and a literal written with one
  // is a single word rather than a bare `_`. Getting this wrong would refuse a context to every
  // note that writes a large number, which is most of the notes this is for.
  it("does not read a digit separator as the last result", () => {
    for (const text of ["5_000_000", "1_000 m", "0x_ff"]) {
      assert.equal(readsLastAnswer(text), false, text);
    }
  });

  it("errs towards refusing, so a mention in a comment or a string counts", () => {
    assert.equal(readsLastAnswer("2 + 2 # the ans"), true);
    assert.equal(readsLastAnswer("\"ans\""), true);
  });

  it("is not confused by an empty expression", () => {
    assert.equal(readsLastAnswer(""), false);
  });
});
