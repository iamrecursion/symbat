// Pins the real Numbat wasm behavior cross-note imports rely on: a note's `numbat-use` targets
// contribute their `numbat-shared` blocks and typed properties as one import chunk, replayed (in
// one `interpret` call) before the note's own bindings — so a local property or expression can
// reference an import.
//
// The graph walk itself (ordering, cycle guard, dedupe) is unit-tested in
// test/unit/imports/parse.test.ts against a mock resolver; here we check that the code it assembles
// actually evaluates the way the design assumes.
//
// Requires the wasm to be built; self-skips otherwise.

import assert from "node:assert/strict";
import { test } from "node:test";
import { inlineResultFor } from "../../../src/evaluation/inline-parse.ts";
import { derivePreamble, PLAIN_NONE } from "../../../src/properties/parse.ts";
import { loadNumbat, skip } from "../wasm-pkg.ts";

function runnerFor(nb: any) {
  return (code: string) => {
    const out = nb.interpret(code);
    const result = { output: out.output as string, isError: out.is_error as boolean };
    out.free();
    return result;
  };
}

// The import chunks a `numbat-use` target contributes: its typed-property bindings (only) then each
// of its `numbat-shared` blocks — exactly as properties/note.ts builds them, each an
// independently-interpretable chunk.
function importChunks(frontmatter: Record<string, unknown>, sharedBlocks: string[]): string[] {
  const props = derivePreamble(frontmatter, {
    isNumbatTyped: (key) => key.startsWith("nb_"),
    isReserved: () => false,
    plain: PLAIN_NONE, // only typed properties are exported
  });
  return [...props.bindings.map((b) => b.code), ...sharedBlocks];
}

// Replay chunks the way replayPreamble does: each in its own interpret call.
function replayChunks(nb: any, chunks: string[]): void {
  for (const chunk of chunks) {
    nb.interpret(chunk).free();
  }
}

test("imported shared blocks and typed properties open the note's scope", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = mod.Numbat.new(true, true, mod.FormatType.Html);
  try {
    const chunks = importChunks({ nb_g: "9.81 m/s^2", title: "ignored" }, ["fn scale2(x) = 2 * x"]);
    replayChunks(nb, chunks);
    const run = runnerFor(nb);
    assert.equal(inlineResultFor(run, "scale2(21)").plain, "42");
    assert.equal(inlineResultFor(run, "nb_g").plain?.startsWith("9.81"), true);

    // A note's own binding, replayed after the imports, can reference them.
    nb.interpret("let weight = (nb_g * 2 kg)").free();
    const weight = inlineResultFor(run, "weight");
    assert.equal(weight.kind, "value");
    assert.equal(weight.plain?.startsWith("19.62"), true);
  } finally {
    nb.free();
  }
});

test("a broken import chunk is isolated — the others still land", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = mod.Numbat.new(true, true, mod.FormatType.Html);
  try {
    // Numbat rejects a whole multi-statement program on any error (pinned here), so each import
    // must be its own chunk — then the broken one is contained.
    assert.equal(runnerFor(nb)("let a = 1\nlet b = not_a_thing\nlet c = 3").isError, true);
    assert.equal(inlineResultFor(runnerFor(nb), "a").kind === "error", true, "the atomic program left nothing");

    const fresh = mod.Numbat.new(true, true, mod.FormatType.Html);
    try {
      replayChunks(fresh, ["let a = (1)", "let b = (not_a_thing)", "let c = (3)"]);
      const run = runnerFor(fresh);
      // The broken chunk (`b`) is contained; `a` and `c` both survive.
      assert.equal(inlineResultFor(run, "a").plain, "1");
      assert.equal(inlineResultFor(run, "c").plain, "3");
    } finally {
      fresh.free();
    }
  } finally {
    nb.free();
  }
});
