// Pins the note-scope inspector's value probing against the real Numbat wasm: every binding source
// resolves to a value in the note's scope, the values agree with the inlay surfaces EXCEPT for the
// deliberate no-suppression divergence (a value that restates its source is shown here but hidden
// by the inlays), and a plain (`local`) block's bindings never leak into the note's scope.
//
// Requires the wasm to be built; self-skips otherwise.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_INLINE_CONFIG } from "../../../src/evaluation/inline-parse.ts";
import { frontmatterHints } from "../../../src/properties/frontmatter-inlay.ts";
import { derivePreamble, PLAIN_ALL } from "../../../src/properties/parse.ts";
import { evaluateScopeTree } from "../../../src/scope/eval.ts";
import { buildScopeTree, type ScopeEntry } from "../../../src/scope/model.ts";
import { loadNumbat, newContext, skip } from "../wasm-pkg.ts";

// A LineInterpret over a live wasm context.
function runnerFor(nb: any) {
  return (code: string) => {
    const out = nb.interpret(code);
    const result = { output: out.output as string, isError: out.is_error as boolean };
    out.free();
    return result;
  };
}

// The ScopeContextFactory the inspector bridge builds over the real wasm.
function makeContextFactory(mod: any) {
  return () => {
    const nb = newContext(mod);
    return { run: runnerFor(nb), free: () => nb.free() };
  };
}

const config = DEFAULT_INLINE_CONFIG;
const plain = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ");
/** `plain`, with the entities Numbat escapes into decoded — a signature's `->` arrives as
 *  `-&gt;`. */
const text = (html: string) => plain(html).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function byName(entries: ScopeEntry[]): Map<string, ScopeEntry> {
  return new Map(entries.map((entry) => [entry.name, entry]));
}

const LINES = [
  "---",
  "total: e * 278", // computed value
  "weight: 80.5", // plain number — the inlays suppress it, the inspector shows it
  "doubled: total * 2", // chains on total
  "incomplete: 3 m +", // typed hole
  "bad: abs(-5", // error
  "---",
  "text n`let x = 4` end",
  "```numbat-shared",
  "let area = 50 m^2",
  "```",
];

function sampleTree() {
  const preamble = derivePreamble(
    { total: "e * 278", weight: 80.5, doubled: "total * 2", incomplete: "3 m +", bad: "abs(-5" },
    { isNumbatTyped: (key) => key !== "weight", isReserved: () => false, plain: PLAIN_ALL },
  );
  return buildScopeTree({
    file: "Note.md",
    lines: LINES,
    config,
    preamble,
    importGroups: [{ notePath: "Constants.md", chunks: ["let grav = (9.81 m/s^2)"] }],
  });
}

test("scope values resolve for every source and chain in scope", { skip }, async () => {
  const mod = await loadNumbat();
  const tree = sampleTree();
  evaluateScopeTree(makeContextFactory(mod), tree);

  const props = byName(tree.properties);
  // Computed property + the chain that saw it.
  assert.equal(props.get("total")?.value?.kind, "value");
  assert.equal(plain(props.get("total")?.value?.valueHtml ?? "").includes("755"), true);
  assert.equal(plain(props.get("doubled")?.value?.valueHtml ?? "").includes("1511"), true);
  // Incomplete → hole; broken → error.
  assert.equal(props.get("incomplete")?.value?.kind, "hole");
  assert.equal(props.get("incomplete")?.value?.holeType, "Length");
  assert.equal(props.get("bad")?.value?.kind, "error");
  assert.equal((props.get("bad")?.value?.errorText ?? "").length > 0, true);

  // Imported binding resolves in the active note's scope.
  assert.equal(tree.imports[0].entries[0].name, "grav");
  assert.equal(plain(tree.imports[0].entries[0].value?.valueHtml ?? "").includes("9.81"), true);

  // Shared-block and inline `let` values.
  const area = tree.blocks[0].statements[0].entry;
  assert.equal(plain(area?.value?.valueHtml ?? "").includes("50"), true);
  assert.equal(tree.inline[0].name, "x");
  assert.equal(tree.inline[0].value?.plain, "4");
});

test("a value that restates its source is shown (unlike the inlays)", { skip }, async () => {
  const mod = await loadNumbat();
  const tree = sampleTree();
  evaluateScopeTree(makeContextFactory(mod), tree);

  // The inspector shows the plain number's value…
  const weight = byName(tree.properties).get("weight");
  assert.equal(weight?.value?.kind, "value");
  assert.equal(weight?.value?.plain, "80.5");

  // …where the frontmatter inlay suppresses it entirely.
  const nb = newContext(mod);
  try {
    const hints = frontmatterHints(runnerFor(nb), tree.preamble);
    assert.equal(hints.some((hint) => hint.key === "weight"), false);
  } finally {
    nb.free();
  }
});

test("property values carry an inferred type from the definition echo", { skip }, async () => {
  const mod = await loadNumbat();
  const tree = sampleTree();
  evaluateScopeTree(makeContextFactory(mod), tree);
  // `total` is a scalar; `area` is 50 m² → an Area type fragment.
  const area = tree.blocks[0].statements[0].entry;
  assert.equal(plain(area?.value?.type ?? "").length > 0, true);
});

test("a plain (local) block's bindings do not leak into scope", { skip }, async () => {
  const mod = await loadNumbat();
  const lines = [
    "```numbat",
    "let secret = 99",
    "```",
    "then n`let leak = secret + 1` here",
  ];
  const preamble = derivePreamble({}, { isNumbatTyped: () => true, isReserved: () => false, plain: PLAIN_ALL });
  const tree = buildScopeTree({ file: "N.md", lines, config, preamble, importGroups: [] });
  evaluateScopeTree(makeContextFactory(mod), tree);

  // The local block computes its own value…
  const secret = tree.blocks[0].statements[0].entry;
  assert.equal(secret?.sourceKind, "local");
  assert.equal(secret?.value?.plain, "99");
  // …but it is invisible to the note scope, so the inline binding referencing it fails.
  assert.equal(tree.inline[0].name, "leak");
  assert.equal(tree.inline[0].value?.kind, "error");
});

test("user prelude bindings resolve; fn/dimension show no value", { skip }, async () => {
  const mod = await loadNumbat();
  // `thrice`, not `triple`: the latter is a prelude alias of `three`, so defining a function by
  // that name is an identifier clash (the same trap as `let g` = gram).
  const preludeSrc = ["let answer = 42", "unit widget = 3 m", "fn thrice(x) = 3 x", "dimension Frq = 1 / Time"];
  // A context factory that loads the prelude on creation, as createContext does.
  const makeContext = () => {
    const nb = newContext(mod);
    for (const line of preludeSrc) {
      nb.interpret(line).free();
    }
    return { run: runnerFor(nb), free: () => nb.free() };
  };
  const preamble = derivePreamble({}, { isNumbatTyped: () => true, isReserved: () => false, plain: PLAIN_ALL });
  const tree = buildScopeTree({
    file: "N.md",
    lines: ["prose"],
    config,
    preamble,
    importGroups: [],
    preludeFiles: [{ label: "P", path: "p.nbt", lines: preludeSrc }],
  });
  evaluateScopeTree(makeContext, tree);

  const byNamePrelude = byName(tree.prelude[0].entries);
  // `let` and `unit` resolve to a value…
  assert.equal(byNamePrelude.get("answer")?.value?.plain, "42");
  assert.equal(plain(byNamePrelude.get("widget")?.value?.valueHtml ?? "").includes("widget"), true);
  // …a `fn` carries no value but does carry its `type(…)` signature…
  const thrice = byNamePrelude.get("thrice");
  assert.equal(thrice?.value?.kind, "none");
  assert.equal(thrice?.declKind, "fn");
  assert.match(text(thrice?.value?.type ?? ""), /^:\s*forall .*Fn\[\(.*\) -> .*\]$/);
  // …and a `dimension` is neither (probing one errors), so it shows by name alone.
  assert.equal(byNamePrelude.get("Frq")?.value?.kind, "none");
  assert.equal(byNamePrelude.get("Frq")?.declKind, "dimension");
  assert.equal(byNamePrelude.get("Frq")?.value?.type, null);
});

test("a block's function shows its concrete signature; a broken one shows its error", { skip }, async () => {
  const mod = await loadNumbat();
  const lines = [
    "```numbat-shared",
    "fn addLen(a: Length, b: Length) -> Length = a + b",
    "fn broken(x) = x + ",
    "```",
  ];
  const tree = buildScopeTree({
    file: "N.md",
    lines,
    config,
    preamble: derivePreamble({}, { isNumbatTyped: () => true, isReserved: () => false, plain: PLAIN_ALL }),
    importGroups: [],
  });
  evaluateScopeTree(makeContextFactory(mod), tree);

  const entries = byName(tree.blocks[0].statements.flatMap((s) => (s.entry === null ? [] : [s.entry])));
  // The signature is Numbat's own `type(…)` form — what the completer shows on a row.
  assert.equal(text(entries.get("addLen")?.value?.type ?? ""), ": Fn[(Length, Length) -> Length]");
  assert.equal(entries.get("addLen")?.value?.kind, "none");
  // A function that failed to define keeps its diagnostic instead of a signature.
  assert.equal(entries.get("broken")?.value?.kind, "error");
});
