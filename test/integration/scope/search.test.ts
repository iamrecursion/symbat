// Pins the scope inspector's search against the real Numbat wasm: the bundled prelude's vocabulary
// is what gets searched, the user's own prelude is not double-listed as a built-in, and a note's
// own binding outranks the standard library for the same query.
//
// Sizes are asserted in bands, never exactly — they move with the Numbat version.
//
// Requires the wasm to be built; self-skips otherwise.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type CompletionVocabulary, parseListNames } from "../../../src/completion/expressions.ts";
import { DEFAULT_INLINE_CONFIG } from "../../../src/evaluation/inline-parse.ts";
import { EMPTY_PREAMBLE } from "../../../src/properties/parse.ts";
import { buildScopeTree } from "../../../src/scope/model.ts";
import { type FuzzyScorer, rankSearchCandidates, scopeSearchCandidates } from "../../../src/scope/search.ts";
import { loadNumbat, skip } from "../wasm-pkg.ts";

/** The four flat name buckets, exactly as interpreter/numbat.ts's `buildCompletionVocabulary` reads
 *  them — the only vocabulary the wasm exposes. */
function vocabularyFor(nb: any): CompletionVocabulary {
  const list = (what: string): Set<string> => {
    const command = nb.try_run_command(`list ${what}`);
    const names = parseListNames(command.output as string);
    command.free();
    return new Set(names);
  };
  return {
    functions: list("functions"),
    units: list("units"),
    variables: list("variables"),
    dimensions: list("dimensions"),
  };
}

/** A deterministic subsequence scorer, so ranking is exercised against the real vocabulary without
 *  pulling in Obsidian's `prepareFuzzySearch`. */
function scorerFor(query: string): FuzzyScorer {
  const needle = query.toLowerCase();
  return (text: string) => {
    const haystack = text.toLowerCase();
    const matches: [number, number][] = [];
    let i = 0;
    for (let k = 0; k < haystack.length && i < needle.length; k += 1) {
      if (haystack[k] === needle[i]) {
        matches.push([k, k + 1]);
        i += 1;
      }
    }
    return i === needle.length ? { score: -(matches[0]?.[0] ?? 0), matches } : null;
  };
}

const config = DEFAULT_INLINE_CONFIG;

// `thrice` and `gadget` are deliberately not prelude names: `triple` is an alias of `three`, and
// `g`/`m` are gram/metre, so a binding using one of those would silently never define (see the
// alias trap pinned in scope-eval.test.ts).
const LINES = [
  "prose",
  "```numbat-shared",
  "let thrice = 3",
  "```",
];

function noteTree(vocabAside = false) {
  return buildScopeTree({
    file: "Note.md",
    lines: LINES,
    config,
    preamble: EMPTY_PREAMBLE,
    importGroups: [],
    preludeFiles: vocabAside ? [] : [{
      label: "My prelude",
      path: "lib/prelude.nbt",
      lines: ["let gadget = 7"],
    }],
  });
}

test("the bundled vocabulary is the standard library's, in plausible bands", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = mod.Numbat.new(true, true, mod.FormatType.Html);
  try {
    const vocab = vocabularyFor(nb);
    for (
      const [bucket, name] of [
        ["functions", "sin"],
        ["variables", "pi"],
        ["dimensions", "Length"],
        ["units", "meter"],
      ] as const
    ) {
      assert.ok(vocab[bucket].has(name), `expected ${name} among the ${bucket}`);
    }
    // Bands, not exact counts: these move with the Numbat version.
    assert.ok(vocab.units.size > 100, `units: ${vocab.units.size}`);
    assert.ok(vocab.functions.size > 50, `functions: ${vocab.functions.size}`);
    assert.ok(vocab.dimensions.size > 20, `dimensions: ${vocab.dimensions.size}`);
  } finally {
    nb.free();
  }
});

test("the standard library is searchable, each name exactly once", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = mod.Numbat.new(true, true, mod.FormatType.Html);
  try {
    const candidates = scopeSearchCandidates(null, vocabularyFor(nb));
    assert.ok(candidates.length > 300, `expected a substantial vocabulary, got ${candidates.length}`);
    assert.ok(candidates.every((c) => c.origin === "builtin"));
    const names = candidates.map((c) => c.text);
    assert.equal(new Set(names).size, names.length, "a name appeared in more than one bucket");
    // Categories are recovered from the buckets, as the completer does.
    assert.equal(candidates.find((c) => c.text === "sin")?.category, "function");
    assert.equal(candidates.find((c) => c.text === "Length")?.category, "dimension");
  } finally {
    nb.free();
  }
});

test("a user-prelude declaration is listed once, as the jumpable copy", { skip }, async () => {
  const mod = await loadNumbat();
  // The user prelude is loaded into the same context the vocabulary is read from, so `gadget`
  // appears in both; the tree's copy — the one that can be jumped to — wins.
  const nb = mod.Numbat.new(true, true, mod.FormatType.Html);
  try {
    const declared = nb.interpret("let gadget = 7");
    declared.free();
    const vocab = vocabularyFor(nb);
    assert.ok(vocab.variables.has("gadget"), "the fixture only means anything if the context has it");

    const candidates = scopeSearchCandidates(noteTree(), vocab);
    const gadget = candidates.filter((c) => c.text === "gadget");
    assert.equal(gadget.length, 1);
    assert.equal(gadget[0].origin, "scope");
    assert.deepEqual(gadget[0].trail, ["prelude", "prelude:lib/prelude.nbt"]);
    // A standard-library name the user did not declare stays a built-in.
    assert.equal(candidates.find((c) => c.text === "sin")?.origin, "builtin");
  } finally {
    nb.free();
  }
});

test("a note's own binding outranks the standard library", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = mod.Numbat.new(true, true, mod.FormatType.Html);
  try {
    const candidates = scopeSearchCandidates(noteTree(), vocabularyFor(nb));
    const hits = rankSearchCandidates(candidates, "thrice", scorerFor("thrice"));
    assert.ok(hits.length > 0, "the note's binding should be found");
    assert.equal(hits[0].candidate.text, "thrice");
    assert.equal(hits[0].candidate.origin, "scope");
    assert.deepEqual(hits[0].candidate.trail, ["block:0"]);
  } finally {
    nb.free();
  }
});

test("a common query returns the standard library ranked, best match first", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = mod.Numbat.new(true, true, mod.FormatType.Html);
  try {
    const candidates = scopeSearchCandidates(null, vocabularyFor(nb));
    const hits = rankSearchCandidates(candidates, "meter", scorerFor("meter"));
    // The exact name first, then longer names containing it as a subsequence.
    assert.equal(hits[0].candidate.text, "meter");
    assert.equal(hits[0].tier, 1); // exact, built-in
    assert.ok(hits.length > 1, "expected the metre's relatives too");
    assert.ok(hits.every((hit, index) => index === 0 || hit.tier >= hits[index - 1].tier));
  } finally {
    nb.free();
  }
});
