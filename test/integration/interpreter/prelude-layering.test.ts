// Pins the real Numbat wasm behavior the `.nbt` editor's prelude layering exists for (see
// settings/util.ts's `preludeSourceBefore` and interpreter/numbat.ts's `createContext({
// preludeBefore })`).
//
// Every interpreter context loads the user's whole prelude. Evaluating a prelude file's own
// contents in such a context would therefore apply its declarations twice — which only matters if
// Numbat rejects that. These tests assert that it does, and that layering the prelude to just the
// files *ahead* of one makes the same evaluation clean. If a wasm bump ever made redefinition
// legal, the layering would become unnecessary rather than load-bearing, and this would say so.
//
// Requires the wasm to be built; self-skips otherwise.

import assert from "node:assert/strict";
import { test } from "node:test";
import { hintsForBlock } from "../../../src/evaluation/inlay-parse.ts";
import { preludeSourceBefore } from "../../../src/settings/util.ts";
import { loadNumbat, skip } from "../wasm-pkg.ts";

// A two-file prelude, as `ensurePrelude` loads it. `units.nbt` is the file the editor opens: it
// depends on `base.nbt` and declares a unit of its own.
const PARTS = [
  { path: "base.nbt", source: "dimension Effort" },
  { path: "units.nbt", source: "unit widget: Effort" },
];
const OPEN_FILE = PARTS[1].source.split("\n");

/** Run `source` (when non-null) then `body`, and report each statement's outcome. */
function runIn(nb: any, prelude: string | null, body: string[]) {
  if (prelude !== null) {
    nb.interpret(prelude).free();
  }
  const outcomes: boolean[] = [];
  hintsForBlock((code) => {
    const out = nb.interpret(code);
    const result = { output: out.output, isError: out.is_error };
    outcomes.push(out.is_error);
    out.free();
    return result;
  }, body);
  return outcomes;
}

test("redefining a unit is an error — the whole reason the prelude is layered", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);
  // The unlayered context: the full prelude, which already contains this file.
  const whole = preludeSourceBefore(PARTS);
  assert.ok(whole !== null && whole.includes("unit widget"), "the file's own unit is in the whole prelude");
  assert.deepEqual(runIn(nb, whole, OPEN_FILE), [true], "a second `unit widget` is rejected");
  nb.free();
});

test("layering the prelude to the files before it evaluates the file cleanly", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);
  const before = preludeSourceBefore(PARTS, "units.nbt");
  assert.equal(before, "dimension Effort", "only the file ahead of it applies");
  assert.deepEqual(runIn(nb, before, OPEN_FILE), [false], "the file's own unit declares once, and holds");
  nb.free();
});

test("a Numbat file's lines produce the same hints as the same block body", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);
  // A `.nbt` file is a block body without the fence, so `hintsForBlock` anchors its hints on
  // document lines directly — no `bodyStartLine` offset to get wrong. The `let`'s value is computed
  // rather than restated, so it earns a value hint alongside its inferred type (a `let x = 3 m`
  // would only get the type).
  const body = ["let side = 1 m + 2 m", "", "side^2"];
  const hints = hintsForBlock((code) => {
    const out = nb.interpret(code);
    const result = { output: out.output, isError: out.is_error };
    out.free();
    return result;
  }, body);
  assert.deepEqual(
    hints.map((hint) => [hint.bodyLine, hint.kind]),
    [[0, "type"], [0, "result"], [2, "result"]],
    "the declaration's type and value on line 0, the expression's result on line 2",
  );
  nb.free();
});
