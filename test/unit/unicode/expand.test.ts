import assert from "node:assert/strict";
import { test } from "node:test";
import { listUnicodeCompletions, unicodeExpansionAt } from "../../../src/unicode/expand.ts";
import { UNICODE_INPUT } from "../../../src/unicode/table.ts";

// --- the table's own invariants ----------------------------------------------

// The lookup is a `Map` where Numbat walks the whole table asking whether the input ends with
// `\name`. The two agree only because no name contains a backslash: if one did, an input could end
// with two different `\name`s at once and the row Numbat picked would depend on its order.
test("no code name contains the backslash the lookup keys on", () => {
  for (const [codes] of UNICODE_INPUT) {
    for (const code of codes) {
      assert.ok(!code.includes("\\"), `\`${code}\` contains a backslash`);
      assert.notEqual(code, "", "an empty code name would match a bare leader");
    }
  }
});

test("every code name is unique across the whole table", () => {
  const seen = new Set<string>();
  for (const [codes] of UNICODE_INPUT) {
    for (const code of codes) {
      assert.ok(!seen.has(code), `\`${code}\` appears twice`);
      seen.add(code);
    }
  }
});

// --- unicodeExpansionAt -------------------------------------------------------

test("unicodeExpansionAt expands a code at the end of the text", () => {
  assert.deepEqual(unicodeExpansionAt("x = \\alpha", "\\"), { replaceLength: 6, replacement: "α" });
});

test("unicodeExpansionAt counts the leader in replaceLength", () => {
  assert.equal(unicodeExpansionAt("\\pi", "\\")?.replaceLength, 3);
  assert.equal(unicodeExpansionAt(";pi", ";")?.replaceLength, 3);
  assert.equal(unicodeExpansionAt("::pi", "::")?.replaceLength, 4);
});

test("unicodeExpansionAt only matches at the caret", () => {
  assert.equal(unicodeExpansionAt("\\alpha + 1", "\\"), null);
  assert.equal(unicodeExpansionAt("\\alpha ", "\\"), null);
});

test("unicodeExpansionAt rejects text that is not a code", () => {
  assert.equal(unicodeExpansionAt("alpha", "\\"), null);
  assert.equal(unicodeExpansionAt("\\notacode", "\\"), null);
  assert.equal(unicodeExpansionAt("", "\\"), null);
});

// A bare leader leaves an empty name, which must not resolve — otherwise typing the leader alone
// would expand to something.
test("unicodeExpansionAt does not expand a bare leader", () => {
  assert.equal(unicodeExpansionAt("x = \\", "\\"), null);
  assert.equal(unicodeExpansionAt("::", "::"), null);
});

test("unicodeExpansionAt reads the code after the final leader", () => {
  assert.deepEqual(unicodeExpansionAt("\\beta\\pi", "\\"), { replaceLength: 3, replacement: "π" });
});

test("unicodeExpansionAt honors a custom leader", () => {
  assert.deepEqual(unicodeExpansionAt("2 ;alpha", ";"), { replaceLength: 6, replacement: "α" });
  assert.deepEqual(unicodeExpansionAt("2 ::alpha", "::"), { replaceLength: 7, replacement: "α" });
  // The backslash is then just a character, so a LaTeX-shaped code no longer expands.
  assert.equal(unicodeExpansionAt("\\alpha", ";"), null);
});

test("unicodeExpansionAt expands codes that are not words", () => {
  assert.equal(unicodeExpansionAt("m\\^2", "\\")?.replacement, "²");
  assert.equal(unicodeExpansionAt("x\\_1", "\\")?.replacement, "₁");
  assert.equal(unicodeExpansionAt("\\1/2", "\\")?.replacement, "½");
  assert.equal(unicodeExpansionAt("\\pm", "\\")?.replacement, "±");
});

test("unicodeExpansionAt gives every alias in a row the same replacement", () => {
  assert.equal(unicodeExpansionAt("\\to", "\\")?.replacement, "→");
  assert.equal(unicodeExpansionAt("\\rightarrow", "\\")?.replacement, "→");
  assert.equal(unicodeExpansionAt("\\dots", "\\")?.replacement, "…");
  assert.equal(unicodeExpansionAt("\\ldots", "\\")?.replacement, "…");
  assert.equal(unicodeExpansionAt("\\sterling", "\\")?.replacement, "£");
  assert.equal(unicodeExpansionAt("\\pound", "\\")?.replacement, "£");
});

// Two pairs of codes look identical in a proportional font and are different characters. Numbat
// distinguishes them, so a transcription that collapsed either pair would be wrong in a way no
// reader could see.
test("unicodeExpansionAt keeps the homoglyph pairs apart", () => {
  assert.equal(unicodeExpansionAt("\\Omega", "\\")?.replacement, "\u03A9");
  assert.equal(unicodeExpansionAt("\\ohm", "\\")?.replacement, "\u2126");
  assert.equal(unicodeExpansionAt("\\mu", "\\")?.replacement, "\u03BC");
  assert.equal(unicodeExpansionAt("\\micro", "\\")?.replacement, "\u00B5");
});

// --- listUnicodeCompletions ----------------------------------------------------

test("listUnicodeCompletions filters by the typed prefix", () => {
  assert.deepEqual(listUnicodeCompletions("alph"), [{ name: "alpha", replacement: "α" }]);
  assert.deepEqual(listUnicodeCompletions("notacode"), []);
});

test("listUnicodeCompletions is case-sensitive", () => {
  assert.deepEqual(listUnicodeCompletions("Ome").map((code) => code.name), ["Omega"]);
  assert.deepEqual(listUnicodeCompletions("ome").map((code) => code.name), ["omega"]);
});

test("listUnicodeCompletions offers every code for an empty prefix, sorted and de-duplicated", () => {
  const all = listUnicodeCompletions("");
  const names = all.map((code) => code.name);
  const expected = UNICODE_INPUT.flatMap(([codes]) => codes).sort();

  assert.deepEqual(names, [...expected], "every name, in sort order");
  assert.equal(new Set(names).size, names.length, "no duplicates");
});

// The popover inserts `replacement` directly, so a row that disagreed with the expansion would put
// a different glyph in the document than typing the same code out.
test("listUnicodeCompletions agrees with unicodeExpansionAt on every code", () => {
  for (const { name, replacement } of listUnicodeCompletions("")) {
    assert.deepEqual(
      unicodeExpansionAt(`\\${name}`, "\\"),
      { replaceLength: name.length + 1, replacement },
      `\\${name}`,
    );
  }
});
