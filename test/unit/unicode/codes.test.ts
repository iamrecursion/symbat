import assert from "node:assert/strict";
import { test } from "node:test";
import { codesMatching, unicodePrefixAt } from "../../../src/unicode/codes.ts";

// --- unicodePrefixAt ---------------------------------------------------------

test("unicodePrefixAt reads the code prefix after the last backslash", () => {
  assert.equal(unicodePrefixAt("x = \\al", "\\"), "al");
  assert.equal(unicodePrefixAt("\\alpha", "\\"), "alpha");
  assert.equal(unicodePrefixAt("2 + \\pi", "\\"), "pi");
});

test("unicodePrefixAt returns an empty string for a lone backslash", () => {
  assert.equal(unicodePrefixAt("x = \\", "\\"), "");
});

test("unicodePrefixAt returns null when the caret is not in a code", () => {
  assert.equal(unicodePrefixAt("x = 2", "\\"), null);
  assert.equal(unicodePrefixAt("", "\\"), null);
  // A space (or the closing of a code) ends the run.
  assert.equal(unicodePrefixAt("\\alpha ", "\\"), null);
  assert.equal(unicodePrefixAt("\\alpha + 1", "\\"), null);
});

test("unicodePrefixAt uses only the run after the final backslash", () => {
  assert.equal(unicodePrefixAt("\\alpha\\be", "\\"), "be");
});

test("unicodePrefixAt honors a custom single-character leader", () => {
  assert.equal(unicodePrefixAt("x = ;al", ";"), "al");
  assert.equal(unicodePrefixAt(";alpha ", ";"), null);
  assert.equal(unicodePrefixAt("a;b;c", ";"), "c"); // last leader wins
  assert.equal(unicodePrefixAt("x = 2", ";"), null);
});

test("unicodePrefixAt honors a multi-character leader", () => {
  assert.equal(unicodePrefixAt("q::al", "::"), "al");
  assert.equal(unicodePrefixAt("::", "::"), ""); // lone leader → empty prefix
  assert.equal(unicodePrefixAt("::alpha beta", "::"), null); // whitespace ends the run
});

// --- codesMatching -----------------------------------------------------------

const CODES = [
  { name: "alpha", replacement: "α" },
  { name: "beta", replacement: "β" },
  { name: "Omega", replacement: "Ω" },
  { name: "omega", replacement: "ω" },
];

test("codesMatching filters by name prefix", () => {
  assert.deepEqual(codesMatching(CODES, "al").map((c) => c.name), ["alpha"]);
  assert.deepEqual(codesMatching(CODES, "").map((c) => c.name), ["alpha", "beta", "Omega", "omega"]);
});

test("codesMatching is case-sensitive so Omega and omega stay distinct", () => {
  assert.deepEqual(codesMatching(CODES, "O").map((c) => c.name), ["Omega"]);
  assert.deepEqual(codesMatching(CODES, "o").map((c) => c.name), ["omega"]);
});
