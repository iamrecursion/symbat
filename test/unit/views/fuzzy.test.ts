import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzyFilter, fuzzyMatches } from "../../../src/views/fuzzy.ts";

test("fuzzyMatches does a case-insensitive subsequence match", () => {
  assert.equal(fuzzyMatches("kilometre", "km"), true);
  assert.equal(fuzzyMatches("kilometre", "KM"), true);
  assert.equal(fuzzyMatches("kilometre", "mk"), false); // order matters
  assert.equal(fuzzyMatches("anything", ""), true); // empty matches
});

test("fuzzyFilter keeps order and de-duplicates", () => {
  const history = ["3 mile -> km", "2 km + 3 m", "3 mile -> km", "sin(pi)"];
  // most-recent-first is the caller's responsibility; here we pass as-is
  assert.deepEqual(fuzzyFilter(history, "km"), ["3 mile -> km", "2 km + 3 m"]);
});

test("fuzzyFilter with empty query returns all unique entries in order", () => {
  assert.deepEqual(fuzzyFilter(["a", "b", "a", "c"], ""), ["a", "b", "c"]);
});

test("fuzzyFilter returns nothing when nothing matches", () => {
  assert.deepEqual(fuzzyFilter(["abc", "def"], "xyz"), []);
});
