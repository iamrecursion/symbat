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
import { NULLABLE_ABSENT } from "../../../src/interpreter/nullable.ts";
import { derivePreamble, PLAIN_ALL, PLAIN_NONE } from "../../../src/properties/parse.ts";
import { loadNumbat, newContext, skip } from "../wasm-pkg.ts";

function runnerFor(nb: any) {
  return (code: string) => {
    const out = nb.interpret(code);
    const result = { output: out.output as string, isError: out.is_error as boolean };
    out.free();
    return result;
  };
}

// The import chunks a `numbat-use` target contributes: its typed-property bindings (only) then each
// of its `numbat-shared` blocks — exactly as properties/note.ts's importedPropsChunks builds them,
// each an independently-interpretable chunk.
//
// `defs` are part of a binding's contribution, not an extra: an object property's generated
// `struct` and a typed hole's declaration both ride there, and a chunk list without them is not
// what the plugin replays. `plainNested` likewise mirrors the real caller — see the test below.
function importChunks(
  frontmatter: Record<string, unknown>,
  sharedBlocks: string[],
  isNumbatTyped: (key: string) => boolean = (key) => key.startsWith("nb_"),
  assignedType: (key: string) => string | null = () => null,
): string[] {
  const props = derivePreamble(frontmatter, {
    isNumbatTyped,
    isReserved: () => false,
    plain: PLAIN_NONE, // no untyped value is exported on its own …
    plainNested: PLAIN_ALL, // … but an object that exports at all exports whole
    assignedType,
  });
  return [...props.bindings.flatMap((binding) => [...binding.defs, binding.code]), ...sharedBlocks];
}

// Replay chunks the way replayPreamble does: each in its own interpret call.
function replayChunks(nb: any, chunks: string[]): void {
  for (const chunk of chunks) {
    nb.interpret(chunk).free();
  }
}

test("imported shared blocks and typed properties open the note's scope", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
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

// An object property is the one place a plain value is load-bearing for its typed siblings: it is a
// *field* of a value that is being exported anyway, and a sibling may read it by its dotted name.
// Exporting the object without it used to hand the importer a different object than was written —
// and since every leaf rebuilds the object from the previous one, the first sibling that read the
// missing field failed and took every later leaf with it, leaving the whole name unbound.
test("an exported object keeps the plain leaves its typed siblings read", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    const chunks = importChunks(
      {
        world: {
          // Obsidian's *number* type, not numbat — untyped as far as the export rule is concerned.
          year: 2511,
          delta: "(world.year - 11) years",
          clamped: "maximum([world.delta, 0])",
        },
      },
      [],
      (key) => key === "world.delta" || key === "world.clamped",
    );

    replayChunks(nb, chunks);
    const run = runnerFor(nb);
    assert.equal(inlineResultFor(run, "world.year").plain, "2511", "the plain leaf came along");
    assert.equal(inlineResultFor(run, "world.delta").plain, "2500 yr", "a typed sibling read it");
    assert.equal(inlineResultFor(run, "world.clamped").plain, "2500 yr", "and so did the one after");
  } finally {
    nb.free();
  }
});

// The same rule for an *empty* leaf, which has no value to read a kind off: only its assigned type
// says a Numbat value was ever wanted there. Left out of the export it is not a private name, it is
// a missing field — and the sibling that reads it takes the whole object down.
test("an exported object keeps an empty leaf its type menu names a type for", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    const chunks = importChunks(
      { costs: { materials: null, nb_total: "costs.materials" } },
      [],
      (key) => key === "costs.nb_total",
      (key) => key === "costs.materials" ? "number" : null,
    );

    replayChunks(nb, chunks);
    const run = runnerFor(nb);
    assert.equal(inlineResultFor(run, "costs.materials").plain, NULLABLE_ABSENT, "the hole came along");
    assert.equal(inlineResultFor(run, "costs.nb_total").plain, NULLABLE_ABSENT, "the sibling that reads it bound");
  } finally {
    nb.free();
  }
});

// The gate on the rule above: riding along inside an object is not a way for a note's incidental
// metadata to reach an importer. Nothing under `meta` was asked for, so none of it exports — while
// `nb_g`, on the same note, still does.
test("an object with no typed leaf stays private to the note", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    replayChunks(nb, importChunks({ meta: { author: "ara", revision: 3 }, nb_g: "9.81 m/s^2" }, []));
    const run = runnerFor(nb);
    assert.equal(inlineResultFor(run, "meta.revision").kind === "error", true, "the object did not export");
    assert.equal(inlineResultFor(run, "nb_g").plain?.startsWith("9.81"), true, "the typed property still did");
  } finally {
    nb.free();
  }
});

test("a broken import chunk is isolated — the others still land", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    // Numbat rejects a whole multi-statement program on any error (pinned here), so each import
    // must be its own chunk — then the broken one is contained.
    assert.equal(runnerFor(nb)("let a = 1\nlet b = not_a_thing\nlet c = 3").isError, true);
    assert.equal(inlineResultFor(runnerFor(nb), "a").kind === "error", true, "the atomic program left nothing");

    const fresh = newContext(mod);
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
