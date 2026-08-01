import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompletionVocabulary } from "../../../src/completion/expressions.ts";
import { DEFAULT_INLINE_CONFIG } from "../../../src/evaluation/inline-parse.ts";
import { derivePreamble } from "../../../src/properties/parse.ts";
import { buildScopeTree, type ScopeNode, type ScopeTree } from "../../../src/scope/model.ts";
import {
  type FuzzyScorer,
  rankSearchCandidates,
  scopeSearchCandidates,
  type SearchCandidate,
  searchRowKey,
} from "../../../src/scope/search.ts";

const config = DEFAULT_INLINE_CONFIG;

// The same shape as the scope-model fixture: frontmatter with a typed property and a reserved-name
// skip, an inline `let`, a shared block, and a plain (local) block.
const LINES = [
  "---",
  "distance: 21.1 km",
  "m: 5",
  "---",
  "prose n`let x = 4` here",
  "",
  "```numbat-shared",
  "let area = 50 m^2",
  "unit widget = 3 m",
  "```",
  "",
  "```numbat",
  "let tmp = 3",
  "```",
];

function samplePreamble() {
  return derivePreamble(
    { distance: "21.1 km", m: 5 },
    { isNumbatTyped: (key) => key === "distance", isReserved: (name) => name === "m", bindNumbers: true },
  );
}

function sampleTree(): ScopeTree {
  return buildScopeTree({
    file: "Note.md",
    lines: LINES,
    config,
    preamble: samplePreamble(),
    importGroups: [{ notePath: "lib/Constants.md", chunks: ["let grav = (9.81 m/s^2)"] }],
    preludeFiles: [{ label: "My prelude", path: "lib/prelude.nbt", lines: ["let answer = 42"] }],
  });
}

function vocabulary(over: Partial<CompletionVocabulary> = {}): CompletionVocabulary {
  return {
    dimensions: over.dimensions ?? new Set(),
    units: over.units ?? new Set(),
    functions: over.functions ?? new Set(),
    variables: over.variables ?? new Set(),
  };
}

const byText = (candidates: SearchCandidate[], text: string) => candidates.find((c) => c.text === text);

/** A deterministic stand-in for Obsidian's fuzzy search: case-insensitive subsequence, scoring an
 *  earlier first match higher, so ranking is testable without Obsidian. */
function fakeScorer(query: string): FuzzyScorer {
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

const rank = (candidates: SearchCandidate[], query: string) =>
  rankSearchCandidates(candidates, query, fakeScorer(query));

// --- candidate assembly -------------------------------------------------------

test("every row the tree shows becomes a candidate, including skips", () => {
  const candidates = scopeSearchCandidates(sampleTree(), null);
  const texts = candidates.map((c) => c.text);
  for (const expected of ["answer", "grav", "distance", "m", "area", "widget", "tmp", "x"]) {
    assert.ok(texts.includes(expected), `expected a candidate for ${expected}, got ${texts.join(", ")}`);
  }
  // The reserved property bound nothing, but is findable so its reason can be read.
  assert.equal(byText(candidates, "m")?.target.kind, "skip");
});

test("a candidate's trail names every node that must be expanded to reveal it", () => {
  const candidates = scopeSearchCandidates(sampleTree(), null);
  assert.deepEqual(byText(candidates, "grav")?.trail, ["imports", "import:lib/Constants.md"]);
  assert.deepEqual(byText(candidates, "answer")?.trail, ["prelude", "prelude:lib/prelude.nbt"]);
  assert.deepEqual(byText(candidates, "distance")?.trail, ["frontmatter"]);
  assert.deepEqual(byText(candidates, "area")?.trail, ["block:0"]);
  assert.deepEqual(byText(candidates, "x")?.trail, ["inline"]);
  // A skip is two levels down: its own node *and* the frontmatter above it.
  assert.deepEqual(byText(candidates, "m")?.trail, ["frontmatter", "skipped"]);
});

test("row keys are stable across rebuilds", () => {
  const first = scopeSearchCandidates(sampleTree(), null);
  const second = scopeSearchCandidates(sampleTree(), null);
  assert.deepEqual(first.map((c) => c.key), second.map((c) => c.key));
});

test("searchRowKey has the literal form the rows are addressed by", () => {
  // Spelled out rather than built with the function under test: every assertion below compares a
  // candidate's key against `searchRowKey(...)`, and both sides would still agree if it returned a
  // constant.
  assert.equal(searchRowKey("block:0", "entry", 0), "block:0\u0000entry\u00000");
  assert.equal(searchRowKey("skipped", "skip", 2), "skipped\u0000skip\u00002");
});

test("candidate keys are the ones the tree view writes onto its rows", () => {
  // The invariant that matters, and the one neither side of a `searchRowKey` === `searchRowKey`
  // comparison could fail: a hit can only reveal its row if its key is the `data-numbat-key` the
  // view wrote. That key comes from walking the tree — node by node, entries then skips, indexed
  // within the node — so this walk is an independent copy of views/scope.ts's `renderNode`, and the
  // candidates must agree with it.
  const tree = sampleTree();
  const fromView: string[] = [];
  const walk = (nodes: readonly ScopeNode[]): void => {
    for (const node of nodes) {
      node.entries.forEach((_entry, index) => fromView.push(searchRowKey(node.id, "entry", index)));
      node.skips.forEach((_skip, index) => fromView.push(searchRowKey(node.id, "skip", index)));
      walk(node.children);
    }
  };
  walk(tree.nodes);
  const fromSearch = scopeSearchCandidates(tree, null).map((candidate) => candidate.key);
  assert.notEqual(fromSearch.length, 0, "the sample tree has rows to address");
  for (const key of fromSearch) {
    assert.ok(fromView.includes(key), `no row is rendered with key ${JSON.stringify(key)}`);
  }
  // And specific rows land where the view puts them, by literal key.
  const candidates = scopeSearchCandidates(tree, null);
  assert.equal(byText(candidates, "area")?.key, "block:0\u0000entry\u00000");
  assert.equal(byText(candidates, "widget")?.key, "block:0\u0000entry\u00001");
  // A skip is keyed by its own `skipped` node, not the frontmatter node above it.
  assert.equal(byText(candidates, "m")?.key, "skipped\u0000skip\u00000");
});

test("categories come from the declaration keyword, with no vocabulary lookup", () => {
  const candidates = scopeSearchCandidates(sampleTree(), null);
  assert.equal(byText(candidates, "area")?.category, "variable");
  assert.equal(byText(candidates, "widget")?.category, "unit");
});

test("candidates carry their containing node's label", () => {
  const candidates = scopeSearchCandidates(sampleTree(), null);
  assert.equal(byText(candidates, "grav")?.nodeLabel, "Constants");
  assert.equal(byText(candidates, "area")?.nodeLabel, "Shared block (L7-10)");
});

// --- the bundled prelude ------------------------------------------------------

test("the bundled vocabulary is listed, minus the names the user prelude declares", () => {
  const vocab = vocabulary({ variables: new Set(["answer", "pi"]), functions: new Set(["sin"]) });
  const candidates = scopeSearchCandidates(sampleTree(), vocab);
  const builtins = candidates.filter((c) => c.origin === "builtin").map((c) => c.text);
  assert.deepEqual(builtins.sort(), ["pi", "sin"]);
  // `answer` is one entity in two places; the jumpable copy in the tree wins.
  assert.equal(byText(candidates, "answer")?.origin, "scope");
});

test("a builtin whose name the note also binds is kept, only flagged", () => {
  // `m` is the metre. A note binding `m` cannot make the unit unfindable — and per Numbat's alias
  // rules that binding may never have defined at all.
  const candidates = scopeSearchCandidates(sampleTree(), vocabulary({ units: new Set(["m"]) }));
  const both = candidates.filter((c) => c.text === "m");
  assert.deepEqual(both.map((c) => c.origin).sort(), ["builtin", "scope"]);
  assert.equal(both.find((c) => c.origin === "builtin")?.shadowedByScope, false); // `m` is a skip, not a binding
  const withBinding = scopeSearchCandidates(sampleTree(), vocabulary({ units: new Set(["area"]) }));
  assert.equal(withBinding.find((c) => c.origin === "builtin" && c.text === "area")?.shadowedByScope, true);
});

test("a name in several vocabulary buckets yields one candidate", () => {
  const vocab = vocabulary({ units: new Set(["bar"]), functions: new Set(["bar"]) });
  const builtins = scopeSearchCandidates(null, vocab).filter((c) => c.text === "bar");
  assert.equal(builtins.length, 1);
});

test("with no note open the bundled prelude is still searchable", () => {
  const candidates = scopeSearchCandidates(null, vocabulary({ functions: new Set(["sin"]) }));
  assert.deepEqual(candidates.map((c) => [c.text, c.origin]), [["sin", "builtin"]]);
  assert.deepEqual(candidates[0].trail, []);
  assert.equal(candidates[0].key, "");
});

test("no vocabulary yet yields the note's rows alone", () => {
  const candidates = scopeSearchCandidates(sampleTree(), null);
  assert.ok(candidates.every((c) => c.origin === "scope"));
  assert.deepEqual(scopeSearchCandidates(null, null), []);
});

// --- ranking ------------------------------------------------------------------

test("an empty or blank query matches nothing", () => {
  const candidates = scopeSearchCandidates(sampleTree(), null);
  assert.deepEqual(rank(candidates, ""), []);
  assert.deepEqual(rank(candidates, "   "), []);
});

test("exact beats prefix beats fuzzy, and in scope beats builtin", () => {
  const vocab = vocabulary({ variables: new Set(["are", "area", "areaOfCircle", "aXrXeXa"]) });
  const candidates = scopeSearchCandidates(sampleTree(), vocab);
  const hits = rank(candidates, "area");
  assert.deepEqual(hits.slice(0, 4).map((h) => [h.candidate.text, h.candidate.origin]), [
    ["area", "scope"], // exact, and the note's own
    ["area", "builtin"], // exact, bundled
    ["areaOfCircle", "builtin"], // prefix
    ["aXrXeXa", "builtin"], // fuzzy
  ]);
  assert.deepEqual(hits.map((h) => h.tier), [0, 1, 4, 6]);
});

test("a case-insensitive exact match outranks any prefix match", () => {
  const vocab = vocabulary({ variables: new Set(["AREA", "areaOfCircle"]) });
  const hits = rank(scopeSearchCandidates(null, vocab), "area");
  assert.deepEqual(hits.map((h) => h.candidate.text), ["AREA", "areaOfCircle"]);
});

test("ties break by shorter name then alphabetically, so the order is stable", () => {
  const vocab = vocabulary({ variables: new Set(["ab_long", "abz", "aby"]) });
  const first = rank(scopeSearchCandidates(null, vocab), "ab");
  const second = rank(scopeSearchCandidates(null, vocab), "ab");
  assert.deepEqual(first.map((h) => h.candidate.text), ["aby", "abz", "ab_long"]);
  assert.deepEqual(first.map((h) => h.candidate.text), second.map((h) => h.candidate.text));
});

test("candidates the scorer rejects are dropped, and matches are carried through", () => {
  const vocab = vocabulary({ variables: new Set(["sin", "zzz"]) });
  const hits = rank(scopeSearchCandidates(null, vocab), "sin");
  assert.deepEqual(hits.map((h) => h.candidate.text), ["sin"]);
  assert.deepEqual(hits[0].matches, [[0, 1], [1, 2], [2, 3]]);
});

test("a property searchable under two names still yields one row", () => {
  // A key that is not a valid identifier binds a different Numbat name.
  const preamble = derivePreamble(
    { "top speed": "10 m/s" },
    { isNumbatTyped: () => true, isReserved: () => false, bindNumbers: true },
  );
  const tree = buildScopeTree({
    file: "N.md",
    lines: ["---", "top speed: 10 m/s", "---"],
    config,
    preamble,
    importGroups: [],
  });
  const candidates = scopeSearchCandidates(tree, null);
  const entry = tree.properties[0];
  assert.notEqual(entry.name, entry.label); // the fixture is only meaningful if they differ
  assert.equal(candidates.filter((c) => c.key === searchRowKey("frontmatter", "entry", 0)).length, 2);
  // Both names find it, and each finds it exactly once.
  assert.equal(rank(candidates, entry.label).length, 1);
  assert.equal(rank(candidates, entry.name).length, 1);
});

// --- nested (object) properties ------------------------------------------------

function nestedTree(): ScopeTree {
  return buildScopeTree({
    file: "Nested.md",
    lines: ["---", "costs:", "  materials: 500", "---", "prose"],
    config,
    preamble: derivePreamble(
      { costs: { materials: 500 } },
      { isNumbatTyped: () => false, isReserved: () => false, bindNumbers: true },
    ),
    importGroups: [],
  });
}

test("a nested property is findable by dotted key and by leaf key, on one row", () => {
  const candidates = scopeSearchCandidates(nestedTree(), null);
  const dotted = byText(candidates, "costs.materials");
  const leaf = byText(candidates, "materials");
  assert.notEqual(dotted, undefined);
  assert.notEqual(leaf, undefined);
  // Two candidates, one row — so a query matching both cannot list it twice.
  assert.equal(dotted?.key, leaf?.key);
  // The row sits under the object's node, inside Frontmatter.
  assert.deepEqual(dotted?.trail, ["frontmatter", "property:costs"]);
});

test("a nested match ranks once and force-expands the chain to its row", () => {
  const ranked = rank(scopeSearchCandidates(nestedTree(), null), "materials");
  assert.equal(ranked.length, 1);
  assert.deepEqual(ranked[0].candidate.trail, ["frontmatter", "property:costs"]);
});
