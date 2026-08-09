import assert from "node:assert/strict";
import { test } from "node:test";
import { continuesAfter, continuesBefore } from "../../../src/syntax/statements.ts";

// Every case here was checked against the pinned wasm before it was written down: `ok` means Numbat
// parsed the two lines as one statement, `ERR` means it did not.

test("continuesAfter: a definition's `=` is read on from", () => {
  assert.equal(continuesAfter("fn f(x: Scalar) ="), true);
  assert.equal(continuesAfter("let x ="), true);
  assert.equal(continuesAfter("fn f(x: Scalar) = r where r ="), true);
  assert.equal(continuesAfter("dimension D ="), true);
  // Surrounding whitespace is not part of the answer.
  assert.equal(continuesAfter("  let x =   "), true);
});

test("continuesAfter: a comparison's `=` is not a definition's", () => {
  // Numbat rejects each of these across a newline ("Expected one of: number, identifier, …").
  assert.deepEqual(["1 ==", "1 !=", "1 <=", "1 >=", "true &&"].map(continuesAfter), [
    false,
    false,
    false,
    false,
    false,
  ]);
});

test("continuesAfter: the joining keywords, and nothing that merely ends in one", () => {
  assert.deepEqual(["x where", "x and", "if a > 0 then", "then 1 else"].map(continuesAfter), [
    true,
    true,
    true,
    true,
  ]);
  // A name that ends in a keyword's letters is a name.
  assert.deepEqual(["nowhere", "band", "x_then", "elsewhere"].map(continuesAfter), [
    false,
    false,
    false,
    false,
  ]);
});

test("continuesAfter: an ordinary tail ends the statement", () => {
  // A trailing operator is a parse error in Numbat, not a continuation — which is what leaves `3 m
  // +` free to report its missing operand's type as a hint.
  assert.deepEqual(["3 m +", "abs(-5", "5 metre", "fn f(x: Scalar) ->", "fn f(x:", "= if"].map(continuesAfter), [
    false,
    false,
    false,
    false,
    false,
    false,
  ]);
});

test("continuesBefore: a line opening on a joining keyword continues the one above", () => {
  assert.deepEqual(["  where r = a", "and s = a", "then 1", "  else -1"].map(continuesBefore), [
    true,
    true,
    true,
    true,
  ]);
});

test("continuesBefore: a name that starts with a keyword's letters is a name", () => {
  assert.deepEqual(["whereabouts + 1", "android", "thence", "elsewhere = 2"].map(continuesBefore), [
    false,
    false,
    false,
    false,
  ]);
});

test("continuesBefore: an ordinary head opens a statement of its own", () => {
  // `1` ⏎ `+ 2` is two statements in Numbat, so a leading operator is not a continuation.
  assert.deepEqual(["+ 2", "&& false", "let x = 1", "1 + 1", ""].map(continuesBefore), [
    false,
    false,
    false,
    false,
    false,
  ]);
});
