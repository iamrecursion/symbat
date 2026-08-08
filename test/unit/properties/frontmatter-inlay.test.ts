import assert from "node:assert/strict";
import { test } from "node:test";
import { hintPlacesOnKey, valueRepeatsExpr } from "../../../src/properties/frontmatter-inlay.ts";
import { frontmatterKeySites } from "../../../src/properties/parse.ts";

// --- valueRepeatsExpr ---------------------------------------------------------

test("a value that restates its own source is noise", () => {
  assert.equal(valueRepeatsExpr("80.5", "80.5"), true);
  assert.equal(valueRepeatsExpr("[70, 72]", "[70,  72]"), true); // whitespace-insensitive
  assert.equal(valueRepeatsExpr("8 €", "5 EUR + 3 EUR"), false);
  assert.equal(valueRepeatsExpr(null, "5 EUR"), false);
});

// --- hintPlacesOnKey ----------------------------------------------------------

const site = (line: number, endLine: number) => ({ line, endLine });

test("a result places on a key whose value is on that line, and not on one written below", () => {
  assert.equal(hintPlacesOnKey("result", site(1, 1)), true);
  assert.equal(hintPlacesOnKey("result", site(1, 4)), false);
});

test("a problem places wherever the key is — it restates no data", () => {
  for (const kind of ["error", "hole"] as const) {
    assert.equal(hintPlacesOnKey(kind, site(1, 1)), true);
    assert.equal(hintPlacesOnKey(kind, site(1, 4)), true);
  }
});

test("the rule reads off the real key extents, so a block list shows only its problems", () => {
  const sites = frontmatterKeySites([
    "---",
    "rates:", // a block sequence: the items are right there to read
    "  - 5 EUR",
    "  - 3 EUR",
    "inline: [5 EUR, 3 EUR]", // written on the key line, so its result is worth showing
    "total: rates + 1",
    "---",
  ].values());

  const extent = (key: string) => sites.get(key) as { line: number; endLine: number; };
  assert.equal(hintPlacesOnKey("result", extent("rates")), false);
  assert.equal(hintPlacesOnKey("error", extent("rates")), true);
  assert.equal(hintPlacesOnKey("result", extent("inline")), true);
  assert.equal(hintPlacesOnKey("result", extent("total")), true);
});
