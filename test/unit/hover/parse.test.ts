import assert from "node:assert/strict";
import { test } from "node:test";
import { hoverSymbolAt, isCodeAt } from "../../../src/hover/parse.ts";
import { dottedPathAt, wordRangeAt } from "../../../src/syntax/identifier.ts";

/** `wordRangeAt` as the substring it selects, for readable assertions. */
function word(text: string, ch: number): string | null {
  const range = wordRangeAt(text, ch);
  return range === null ? null : text.slice(range.from, range.to);
}

/** `dottedPathAt` as the substring it selects. */
function path(text: string, ch: number): string | null {
  const range = dottedPathAt(text, ch);
  return range === null ? null : text.slice(range.from, range.to);
}

// --- the word rule ------------------------------------------------------------

test("wordRangeAt: a word is found from anywhere on it, including both edges", () => {
  const line = "let speed = 5";
  // "speed" spans columns 4..9; column 9 is the boundary just past its last character, which a
  // pointer lands on as readily as the middle.
  assert.deepEqual([0, 4, 6, 9].map((ch) => word(line, ch)), ["let", "speed", "speed", "speed"]);
});

test("wordRangeAt: whitespace and punctuation are not words", () => {
  // Column 6 of the first is its `=`; a column touching a word (3, just past `let`) deliberately
  // still finds it — see the edges test above.
  assert.deepEqual([word("let x = 5", 6), word("  ", 1), word("5 + 3", 3)], [null, null, null]);
});

test("wordRangeAt: identifiers are Unicode, not just ASCII", () => {
  // The tokenizer's ASCII-only rule once split these; the shared rule keeps them whole.
  assert.deepEqual(["µm", "Δt", "π", "x_1"].map((line) => word(line, 1)), ["µm", "Δt", "π", "x_1"]);
});

test("wordRangeAt: a digit can continue a word but never begin one", () => {
  assert.deepEqual(["5km", "5km", "42", "1.5"].map((line, i) => word(line, [0, 2, 1, 2][i])), [
    "km", // the leading digits are trimmed…
    "km", // …from either side of the word
    null, // a bare number is not a name
    null, // and neither is a decimal
  ]);
});

test("dottedPathAt: a member chain extends left, never right", () => {
  const line = "sum(costs.breakdown.tax)";
  assert.deepEqual([
    path(line, line.indexOf("costs")),
    path(line, line.indexOf("breakdown")),
    path(line, line.indexOf("tax")),
  ], ["costs", "costs.breakdown", "costs.breakdown.tax"]);
});

test("dottedPathAt: a dot that is not a member access does not extend the chain", () => {
  assert.equal(path("1.5 m", 4), "m", "the decimal point of a number");
  assert.equal(path("f(x).y", 5), "y", "a dot after something that is not a word");
});

// --- code vs comment vs string ------------------------------------------------

test("isCodeAt: a `#` comment is not code, and a `#` inside a string is not a comment", () => {
  const line = "let x = 5 # metre of it";
  assert.equal(isCodeAt(line, 4), true);
  assert.equal(isCodeAt(line, line.indexOf("metre")), false);
  const stringed = "let s = \"# metre\" + t";
  assert.equal(stringed.length > 0 && isCodeAt(stringed, stringed.indexOf("metre")), false, "inside the string");
  assert.equal(isCodeAt(stringed, stringed.indexOf("t", stringed.indexOf("+"))), true, "after it closes");
});

// --- the symbol -----------------------------------------------------------

test("hoverSymbolAt: the pointed-at word, probed by its whole member chain", () => {
  const line = "let total = costs.tax + 1";
  assert.deepEqual(hoverSymbolAt(line, line.indexOf("tax")), {
    kind: "member",
    name: "tax",
    probe: "costs.tax",
    from: line.indexOf("costs"),
    to: line.indexOf("tax") + 3,
  });
  assert.deepEqual(hoverSymbolAt(line, line.indexOf("costs")), {
    kind: "name",
    name: "costs",
    probe: "costs",
    from: line.indexOf("costs"),
    to: line.indexOf("costs") + 5,
  });
});

test("hoverSymbolAt: a YAML value's own quotes are not Numbat's strings", () => {
  // A frontmatter value is routinely quoted (`total: "5 km + 3 mi"`); read as Numbat that is one
  // string, and nothing in it would ever be hoverable.
  const line = "distance: \"21.1 km + 3 mi\"";
  assert.equal(hoverSymbolAt(line, line.indexOf("km")), null, "without the flag it is a string");
  assert.equal(hoverSymbolAt(line, line.indexOf("km"), { quoted: true })?.name, "km");
  // A YAML comment still ends the value; a `#` inside it does not.
  const commented = "speed: 5 km/h # per hour";
  assert.equal(hoverSymbolAt(commented, commented.indexOf("hour"), { quoted: true }), null);
  const hashed = "note: \"a#tail\"";
  assert.equal(hoverSymbolAt(hashed, hashed.indexOf("tail"), { quoted: true })?.name, "tail");
});

test("hoverSymbolAt: nothing to ask about in a comment, a string, or empty space", () => {
  assert.equal(hoverSymbolAt("2 + 2 # metre", 8), null);
  assert.equal(hoverSymbolAt("\"metre\"", 3), null);
  assert.equal(hoverSymbolAt("2 + 2", 2), null);
  assert.equal(hoverSymbolAt("", 0), null);
});

// --- literals -----------------------------------------------------------------

test("hoverSymbolAt: a literal is hoverable, with the unit that follows it", () => {
  const line = "let d = 21.1 km + 3 mi";
  const quantity = hoverSymbolAt(line, line.indexOf("21.1") + 1);
  assert.deepEqual([quantity?.kind, quantity?.name, quantity?.probe], ["quantity", "21.1", "21.1 km"]);
  // A bare number is a quantity too (a Scalar is still an answer).
  const bare = hoverSymbolAt("2 + 2", 0);
  assert.deepEqual([bare?.kind, bare?.probe], ["quantity", "2"]);
  // The unit half of the same run is a name, asked about on its own.
  const unit = hoverSymbolAt(line, line.indexOf("km"));
  assert.deepEqual([unit?.kind, unit?.probe], ["name", "km"]);
});

test("hoverSymbolAt: a member chain reports itself as one", () => {
  const line = "sum(costs.items)";
  assert.equal(hoverSymbolAt(line, line.indexOf("items"))?.kind, "member");
  assert.equal(hoverSymbolAt(line, line.indexOf("costs"))?.kind, "name");
});
