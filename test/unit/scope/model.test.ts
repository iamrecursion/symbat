import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_INLINE_CONFIG, noteSignature, scanNote } from "../../../src/evaluation/inline-parse.ts";
import { derivePreamble, EMPTY_PREAMBLE, PLAIN_ALL, PLAIN_NONE } from "../../../src/properties/parse.ts";
import {
  buildScopeTree,
  currentNodeId,
  currentNodePath,
  declarationHeadHtml,
  findDefinition,
  isActiveLine,
  scopeDeclaration,
} from "../../../src/scope/model.ts";

const config = DEFAULT_INLINE_CONFIG;

// A note with frontmatter (one typed property + one reserved-name skip), an inline `let` span among
// a non-`let` span, a shared block, and a plain (local) block.
const LINES = [
  "---",
  "distance: 21.1 km",
  "m: 5",
  "---",
  "prose n`let x = 4` and n`5 m` here",
  "",
  "```numbat-shared",
  "let area = 50 m^2",
  "```",
  "",
  "```numbat",
  "let tmp = 3",
  "```",
];

function samplePreamble() {
  return derivePreamble(
    // `m` is typed, so its clash with the unit is reported: only a property that opted in is owed
    // the reason it did not reach the scope.
    { distance: "21.1 km", m: "5" },
    {
      isNumbatTyped: (key) => key === "distance" || key === "m",
      isReserved: (name) => name === "m",
      plain: PLAIN_ALL,
    },
  );
}

function sampleTree() {
  return buildScopeTree({
    file: "Note.md",
    lines: LINES,
    config,
    preamble: samplePreamble(),
    importGroups: [{ notePath: "lib/Constants.md", chunks: ["let g = (9.81 m/s^2)"] }],
  });
}

// --- tree shape ---------------------------------------------------------------

test("nodes appear in scope order with stable ids", () => {
  const tree = sampleTree();
  assert.deepEqual(tree.nodes.map((n) => n.id), ["imports", "frontmatter", "block:0", "block:1", "inline"]);
  assert.deepEqual(tree.nodes.map((n) => n.kind), ["imports", "frontmatter", "block", "block", "inline"]);
});

test("imports are grouped by source note with a basename label", () => {
  const tree = sampleTree();
  const imports = tree.nodes.find((n) => n.kind === "imports");
  assert.equal(imports?.children.length, 1);
  assert.equal(imports?.children[0].id, "import:lib/Constants.md");
  assert.equal(imports?.children[0].label, "Constants");
  assert.deepEqual(imports?.children[0].entries.map((e) => e.name), ["g"]);
});

// An object property is emitted as one `let` per leaf, each superseding the last (properties/parse
// generationCode). Read back off the chunk text those are N identically-named declarations with N-1
// struck through — the progressive build, which is not something to show a reader. Given the
// bindings the chunks came from, the group renders the object the way the note's own frontmatter
// does instead: a sub-tree, one row per leaf.
test("an imported object shows one row per leaf, not one per generation", () => {
  const source = derivePreamble(
    { costs: { materials: "500 €", total: "costs.materials * 1.2" }, nb_g: "9.81 m/s^2" },
    {
      isNumbatTyped: (key) => key.startsWith("costs.") || key.startsWith("nb_"),
      isReserved: () => false,
      plain: PLAIN_NONE,
      plainNested: PLAIN_ALL,
    },
  );

  const sharedChunks = ["fn scale2(x) = 2 * x"];
  const tree = buildScopeTree({
    file: "Note.md",
    lines: LINES,
    config,
    preamble: EMPTY_PREAMBLE,
    importGroups: [{
      notePath: "lib/Constants.md",
      chunks: [...source.bindings.flatMap((b) => [...b.defs, b.code]), ...sharedChunks],
      contribution: { properties: source.bindings, sharedChunks },
    }],
  });

  const group = tree.nodes.find((n) => n.kind === "imports")?.children[0];
  // Shown directly: the shared block's function and the note's non-object property.
  assert.deepEqual(group?.entries.map((e) => e.name), ["nb_g", "scale2"]);

  // The object is a sub-tree, one row per leaf — not the two generations under a duplicate name.
  assert.deepEqual(group?.children.map((c) => c.label), ["costs"]);
  assert.deepEqual(group?.children[0].entries.map((e) => e.name), ["costs.materials", "costs.total"]);
  assert.equal(group?.children[0].id, "import:lib/Constants.md:costs");

  // Nothing is superseded, so nothing renders struck through.
  assert.deepEqual(tree.imports[0].entries.filter((e) => e.shadowed), []);
});

test("blocks carry the shared/local distinction and their line ranges", () => {
  const tree = sampleTree();
  const [shared, local] = tree.nodes.filter((n) => n.kind === "block");
  // 1-indexed fence-to-fence line span in the label.
  assert.equal(shared.label, "Shared block (L7-9)");
  assert.equal(shared.badge, null);
  assert.deepEqual(shared.range, { fromLine: 6, toLine: 8 });
  assert.equal(local.label, "Block (L11-13)");
  assert.equal(local.badge, "local");
  assert.deepEqual(local.range, { fromLine: 10, toLine: 12 });
  assert.deepEqual(tree.blocks.map((b) => b.exported), [true, false]);
});

test("the shared block's binding is defined at its body line", () => {
  const tree = sampleTree();
  const shared = tree.nodes.filter((n) => n.kind === "block")[0];
  assert.deepEqual(shared.entries.map((e) => [e.name, e.defsite.line]), [["area", 7]]);
});

test("only inline `let` spans are listed, at their line and column", () => {
  const tree = sampleTree();
  assert.deepEqual(tree.inline.map((e) => e.name), ["x"]);
  assert.deepEqual(tree.inlineLines, [4]);
  const x = tree.inline[0];
  assert.equal(x.defsite.line, 4);
  assert.equal(x.defsite.ch, LINES[4].indexOf("n`let"));
});

test("the frontmatter node holds the typed binding, its range, and a skipped child", () => {
  const tree = sampleTree();
  const fm = tree.nodes.find((n) => n.kind === "frontmatter");
  assert.deepEqual(fm?.entries.map((e) => e.name), ["distance"]);
  assert.deepEqual(fm?.range, { fromLine: 0, toLine: 3 });
  const skipped = fm?.children.find((c) => c.kind === "skipped");
  assert.equal(skipped?.badge, "1");
  assert.deepEqual(skipped?.skips.map((s) => [s.key, s.reason]), [["m", "reserved"]]);
});

test("property defsite lines come from the frontmatter key", () => {
  const tree = sampleTree();
  assert.equal(tree.properties[0].defsite.line, 1);
});

test("a property the derivation substituted for carries what the note actually says", () => {
  // The inspector shows `written` where there is one (views/scope.ts), so a grounded `0` reads as
  // the `0` the reader wrote rather than as the generated name it binds under. `expr` stays the
  // derived form, because that is the one scope/eval.ts runs.
  const lines = ["---", "costs:", "  total: 0", "---"];
  const tree = buildScopeTree({
    file: "N.md",
    lines,
    config,
    preamble: derivePreamble({ costs: { total: 0 } }, {
      isNumbatTyped: () => false,
      isReserved: () => false,
      plain: PLAIN_ALL,
      plainNested: PLAIN_ALL,
    }),
    importGroups: [],
  });

  const entry = tree.properties.find((property) => property.label === "costs.total");
  assert.equal(entry?.expr, "_Nb_zero_Scalar", "what is evaluated");
  assert.equal(entry?.written, "0", "what is shown");
});

// --- current node -------------------------------------------------------------

test("currentNodeId picks the node the caret is in, or null", () => {
  const tree = sampleTree();
  assert.equal(currentNodeId(tree, 1), "frontmatter"); // inside the YAML
  assert.equal(currentNodeId(tree, 7), "block:0"); // inside the shared block
  assert.equal(currentNodeId(tree, 11), "block:1"); // inside the local block
  assert.equal(currentNodeId(tree, 4), "inline"); // on the inline-span line
  assert.equal(currentNodeId(tree, 5), null); // blank prose line
  assert.equal(currentNodeId(tree, null), null); // no caret
});

test("isActiveLine marks the declaration the caret sits on, same-note only", () => {
  const tree = sampleTree();
  const area = tree.blocks[0].statements[0].entry; // `let area = 50 m^2`, line 7
  assert.notEqual(area, null);
  assert.equal(isActiveLine(area!, 7), true);
  assert.equal(isActiveLine(area!, 6), false); // the fence line, not the declaration
  assert.equal(isActiveLine(area!, null), false); // no caret
  // An imported binding is never active: its defsite names another file, whose line numbers are not
  // this note's.
  const imported = tree.imports[0].entries[0];
  assert.equal(imported.defsite.notePath, "lib/Constants.md");
  assert.equal(isActiveLine(imported, imported.defsite.line ?? 0), false);
});

// --- shadowing ----------------------------------------------------------------

test("a later same-name binding shadows earlier ones across sources", () => {
  const lines = ["---", "d: 1 km", "---", "n`let d = 9`"];
  const tree = buildScopeTree({
    file: "N.md",
    lines,
    config,
    preamble: derivePreamble({ d: "1 km" }, { isNumbatTyped: () => true, isReserved: () => false, plain: PLAIN_ALL }),
    importGroups: [{ notePath: "Lib.md", chunks: ["let d = (2 km)"] }],
  });
  // import d (first) < property d < inline d (last, authoritative).
  const importD = tree.imports[0].entries[0];
  const propD = tree.properties[0];
  const inlineD = tree.inline[0];
  assert.equal(importD.shadowed, true);
  assert.equal(propD.shadowed, true);
  assert.equal(inlineD.shadowed, false);
});

test("local (plain block) bindings do not participate in shadowing", () => {
  const tree = sampleTree(); // `tmp` is only in the plain block; unique names elsewhere
  const local = tree.blocks[1];
  const tmp = local.statements[0].entry;
  assert.equal(tmp?.shadowed, false);
});

// --- signature / empty --------------------------------------------------------

test("signature extends noteSignature with plain-block bodies", () => {
  const preamble = samplePreamble();
  const tree = sampleTree();
  // noteSignature covers the interpreter generation + preamble + units (shared blocks and inline
  // spans); the scope signature also folds in the plain (`local`) block body `let tmp = 3`, so a
  // local-block edit invalidates the value cache. `sampleTree()` passes no generation, so it
  // defaults to 0.
  const expected = [noteSignature(0, preamble.source, scanNote(LINES, config), config), "let tmp = 3"].join(
    String.fromCharCode(0),
  );
  assert.equal(tree.signature, expected);
});

test("the interpreter generation is part of the signature", () => {
  // A prelude edit or an exchange-rate change bumps the generation without touching the note, and
  // must still invalidate the cached values.
  const base = sampleTree();
  const bumped = buildScopeTree({
    file: "N.md",
    lines: LINES,
    config,
    preamble: samplePreamble(),
    importGroups: [],
    generation: 7,
  });
  assert.notEqual(bumped.signature, base.signature);
});

test("a note with no Numbat sources is empty", () => {
  const tree = buildScopeTree({
    file: "Empty.md",
    lines: ["just prose", "no numbat here"],
    config,
    preamble: EMPTY_PREAMBLE,
    importGroups: [],
  });
  assert.equal(tree.empty, true);
  assert.deepEqual(tree.nodes, []);
});

// --- declaration kinds --------------------------------------------------------

test("scopeDeclaration recognizes all four kinds, ignores non-declarations", () => {
  assert.deepEqual(scopeDeclaration("let x = 1"), { keyword: "let", name: "x" });
  assert.deepEqual(scopeDeclaration("  unit foo = 5 m"), { keyword: "unit", name: "foo" });
  assert.deepEqual(scopeDeclaration("fn double(x) = 2 x"), { keyword: "fn", name: "double" });
  assert.deepEqual(scopeDeclaration("dimension Frq = 1 / Time"), { keyword: "dimension", name: "Frq" });
  assert.equal(scopeDeclaration("use units::si"), null);
  assert.equal(scopeDeclaration("2 + 2"), null);
  assert.equal(scopeDeclaration("# let x = 1"), null); // a comment, not a declaration
});

test("a shared block lists all declaration kinds, not just lets", () => {
  const lines = ["```numbat-shared", "let a = 1", "unit u = 2 m", "fn f(x) = x", "dimension D = Length", "```"];
  const tree = buildScopeTree({ file: "N.md", lines, config, preamble: EMPTY_PREAMBLE, importGroups: [] });
  const block = tree.nodes.find((n) => n.kind === "block");
  assert.deepEqual(block?.entries.map((e) => [e.name, e.declKind]), [
    ["a", "let"],
    ["u", "unit"],
    ["f", "fn"],
    ["D", "dimension"],
  ]);
});

test("a decorated declaration is listed, and its defsite is the declaration line", () => {
  // The decorators are part of the statement, so the entry's code carries them — but the caret
  // jumps to the `fn`, not to the annotation above it.
  const lines = [
    "```numbat-shared",
    "@description(\"the last element\")",
    "@example(\"last([1, 2])\")",
    "fn last(xs) = xs",
    "```",
  ];
  const tree = buildScopeTree({ file: "N.md", lines, config, preamble: EMPTY_PREAMBLE, importGroups: [] });
  const block = tree.nodes.find((n) => n.kind === "block");
  assert.deepEqual(block?.entries.map((e) => [e.name, e.declKind]), [["last", "fn"]]);
  assert.equal(block?.entries[0].defsite.line, 3);
  assert.match(block?.entries[0].code ?? "", /^@description/);
});

test("a decorated let's expression is the binding's, not one written inside a decorator", () => {
  // The entry's `expr` is what the inspector evaluates to show the binding's value, and the
  // statement now carries the decorators above it — so an `=` inside a decorator's own text must
  // not be taken for the binding's, or the value shown is an error.
  const lines = [
    "```numbat-shared",
    "@description(\"about 5 = five\")",
    "let x = 5 m",
    "@name(\"Widget\")",
    "unit widget = 3 m",
    "```",
  ];
  const tree = buildScopeTree({ file: "N.md", lines, config, preamble: EMPTY_PREAMBLE, importGroups: [] });
  const block = tree.nodes.find((n) => n.kind === "block");
  assert.deepEqual(block?.entries.map((e) => [e.name, e.expr]), [["x", "5 m"], ["widget", "3 m"]]);
});

test("scopeDeclaration steps over decorators on the declaration's own line", () => {
  assert.deepEqual(scopeDeclaration("@metric_prefixes unit foo = 5 m"), { keyword: "unit", name: "foo" });
  // A paren inside the decorator's own text does not end the prefix early — `@example` carries code
  // by definition, so this is the ordinary case rather than an exotic one.
  assert.deepEqual(scopeDeclaration("@example(\"f([1, 2])\") fn f(xs) = xs"), { keyword: "fn", name: "f" });
  assert.deepEqual(scopeDeclaration("@description(\"a (nice) unit\") unit foo = 1 m"), {
    keyword: "unit",
    name: "foo",
  });
});

test("an imported decorated declaration is listed, however its decorators are written", () => {
  // The chunk is grouped into statements and the declaration read off `codeLine`, so neither a
  // paren inside a decorator's text nor a comment above the declaration hides it.
  const chunk = [
    "@example(\"last([1, 2])\", \"gives 2\")",
    "@description(\"the last element\")",
    "",
    "# why it is the last",
    "fn last(xs) = xs",
  ].join("\n");
  const tree = buildScopeTree({
    file: "N.md",
    lines: ["prose"],
    config,
    preamble: EMPTY_PREAMBLE,
    importGroups: [{ notePath: "Lib.md", chunks: [chunk] }],
  });

  const imports = tree.nodes.find((n) => n.kind === "imports");
  assert.deepEqual(imports?.children[0].entries.map((e) => [e.name, e.declKind]), [["last", "fn"]]);
});

test("declarationHeadHtml renders unit/dimension as their declaration, nothing else", () => {
  const lines = ["```numbat-shared", "let a = 1", "unit u = 2 m", "fn f(x) = x", "dimension D = Length", "```"];
  const tree = buildScopeTree({ file: "N.md", lines, config, preamble: EMPTY_PREAMBLE, importGroups: [] });
  const entries = tree.blocks[0].statements.flatMap((s) => (s.entry === null ? [] : [s.entry]));
  const head = (name: string) => declarationHeadHtml(entries.find((e) => e.name === name)!);
  assert.equal(head("u"), `<span class="numbat-keyword">unit</span> <span class="numbat-unit">u</span>`);
  assert.equal(
    head("D"),
    `<span class="numbat-keyword">dimension</span> <span class="numbat-type-identifier">D</span>`,
  );
  // A `let` is a bare name, and a `fn` shows its signature instead of a keyword.
  assert.equal(head("a"), null);
  assert.equal(head("f"), null);
});

// --- user prelude -------------------------------------------------------------

test("the user prelude becomes a per-file node with all declaration kinds", () => {
  const tree = buildScopeTree({
    file: "N.md",
    lines: ["just prose"],
    config,
    preamble: EMPTY_PREAMBLE,
    importGroups: [],
    preludeFiles: [{
      label: "My prelude",
      path: "lib/prelude.nbt",
      lines: [
        "let answer = 42",
        "unit foo = 5 m",
        "fn double(x) = 2 x",
        "dimension Frq = 1 / Time",
        "# a comment",
        "use units::si",
      ],
    }],
  });
  assert.equal(tree.empty, false);
  const prelude = tree.nodes.find((n) => n.kind === "prelude");
  assert.equal(prelude?.label, "User prelude");
  assert.equal(prelude?.children.length, 1);
  const file = prelude?.children[0];
  assert.equal(file?.id, "prelude:lib/prelude.nbt");
  assert.equal(file?.label, "My prelude");
  // The `use` line and the comment contribute no entry.
  assert.deepEqual(file?.entries.map((e) => [e.name, e.declKind]), [
    ["answer", "let"],
    ["foo", "unit"],
    ["double", "fn"],
    ["Frq", "dimension"],
  ]);
  // The defsite points into the prelude file, at the declaration's line.
  assert.equal(file?.entries[0].defsite.notePath, "lib/prelude.nbt");
  assert.equal(file?.entries[0].defsite.line, 0);
  // The User prelude node sits first — the foundation the rest is layered on.
  assert.equal(tree.nodes[0].kind, "prelude");
});

test("prelude files keep their configured load order, above the note's own sources", () => {
  const preludeFile = (label: string, path: string) => ({ label, path, lines: [`let ${label} = 1`] });
  const tree = buildScopeTree({
    file: "N.md",
    lines: LINES,
    config,
    preamble: samplePreamble(),
    importGroups: [{ notePath: "lib/Constants.md", chunks: ["let grav = (9.81 m/s^2)"] }],
    preludeFiles: [preludeFile("first", "a.nbt"), preludeFile("second", "b.nbt")],
  });
  assert.deepEqual(tree.nodes.map((n) => n.id), [
    "prelude",
    "imports",
    "frontmatter",
    "block:0",
    "block:1",
    "inline",
  ]);
  // Children follow `preludeFileList` order, which is the interpreter's load order.
  assert.deepEqual(tree.nodes[0].children.map((c) => c.label), ["first", "second"]);
});

// --- nested (object) properties ------------------------------------------------

// Kept apart from LINES so the line-number assertions above do not churn.
const NESTED_LINES = [
  "---",
  "weight: 80",
  "costs:",
  "  materials: 500",
  "  breakdown:",
  "    doubled: 12",
  "---",
  "prose",
];

function nestedTree() {
  return buildScopeTree({
    file: "Nested.md",
    lines: NESTED_LINES,
    config,
    preamble: derivePreamble(
      { weight: 80, costs: { materials: 500, breakdown: { doubled: 12 } } },
      { isNumbatTyped: () => false, isReserved: () => false, plain: PLAIN_ALL },
    ),
    importGroups: [],
  });
}

test("tree.properties stays flat and in document order whatever the nesting", () => {
  const tree = nestedTree();
  assert.deepEqual(tree.properties.map((e) => e.name), ["weight", "costs.materials", "costs.breakdown.doubled"]);
});

test("an object becomes a child node holding its own leaves", () => {
  const tree = nestedTree();
  const fm = tree.nodes.find((n) => n.kind === "frontmatter");
  assert.notEqual(fm, undefined);
  // Only the top-level properties are shown directly; the object is a sub-tree.
  assert.deepEqual(fm?.entries.map((e) => e.name), ["weight"]);
  assert.deepEqual(fm?.children.map((n) => [n.id, n.kind, n.label]), [[
    "property:costs",
    "frontmatter-object",
    "costs",
  ]]);
  const costs = fm?.children[0];
  assert.deepEqual(costs?.entries.map((e) => e.name), ["costs.materials"]);
  assert.deepEqual(costs?.children.map((n) => [n.id, n.label]), [["property:costs.breakdown", "breakdown"]]);
  assert.deepEqual(costs?.children[0].entries.map((e) => e.name), ["costs.breakdown.doubled"]);
  // The nodes hold the very same entry objects the flat list does (scope-eval fills values by
  // reference).
  assert.equal(costs?.entries[0], tree.properties[1]);
});

test("an object node spans the whole block its key opens", () => {
  const tree = nestedTree();
  const costs = tree.nodes.find((n) => n.kind === "frontmatter")?.children[0];
  assert.deepEqual(costs?.range, { fromLine: 2, toLine: 5 });
  assert.deepEqual(costs?.children[0].range, { fromLine: 4, toLine: 5 });
});

test("a nested defsite carries the key's own line and column", () => {
  const tree = nestedTree();
  assert.deepEqual(tree.properties.map((e) => [e.defsite.line, e.defsite.ch]), [[1, 0], [3, 2], [5, 4]]);
});

test("the caret in an object resolves to the deepest node, with its ancestors", () => {
  const tree = nestedTree();
  assert.deepEqual(currentNodePath(tree, 5), ["frontmatter", "property:costs", "property:costs.breakdown"]);
  assert.equal(currentNodeId(tree, 5), "property:costs.breakdown");
  assert.deepEqual(currentNodePath(tree, 3), ["frontmatter", "property:costs"]);
  assert.deepEqual(currentNodePath(tree, 1), ["frontmatter"]);
  assert.deepEqual(currentNodePath(tree, 7), []); // prose
});

test("currentNodePath is unchanged for a tree with no nested ranges", () => {
  const tree = sampleTree();
  assert.deepEqual(currentNodePath(tree, 1), ["frontmatter"]);
  assert.deepEqual(currentNodePath(tree, 7), ["block:0"]);
  assert.deepEqual(currentNodePath(tree, 4), ["inline"]);
});

// --- go-to-definition (the hover's lookup) -------------------------------------

// Two blocks binding the same name, so "which definition is this one" has a real answer, plus an
// import and a nested property to resolve.
const DEF_LINES = [
  "---",
  "distance: 21.1 km",
  "costs:",
  "  materials: 500",
  "---",
  "```numbat-shared",
  "let area = 50 m^2",
  "```",
  "prose",
  "```numbat-shared",
  "let area = 90 m^2",
  "```",
];

function defTree() {
  return buildScopeTree({
    file: "Defs.md",
    lines: DEF_LINES,
    config,
    preamble: derivePreamble(
      { distance: "21.1 km", costs: { materials: 500 } },
      { isNumbatTyped: (key) => key === "distance", isReserved: () => false, plain: PLAIN_ALL },
    ),
    importGroups: [{ notePath: "lib/Constants.md", chunks: ["let g = (9.81 m/s^2)"] }],
  });
}

test("findDefinition: a bundled name resolves to nothing", () => {
  assert.equal(findDefinition(defTree(), "meter", "meter", 6), null);
});

test("findDefinition: the nearest definition at or above the line wins", () => {
  const tree = defTree();
  // Hovering inside the first block sees the first `let area`; from below the second, the second.
  assert.deepEqual(findDefinition(tree, "area", "area", 6)?.defsite, { notePath: null, line: 6, ch: 0 });
  assert.deepEqual(findDefinition(tree, "area", "area", 10)?.defsite, { notePath: null, line: 10, ch: 0 });
  // Above them all, the last unshadowed binding is the authoritative one.
  assert.deepEqual(findDefinition(tree, "area", "area", 0)?.defsite, { notePath: null, line: 10, ch: 0 });
});

test("findDefinition: a property resolves to its own key, nested or not", () => {
  const tree = defTree();
  assert.deepEqual(findDefinition(tree, "distance", "distance", 8)?.defsite, { notePath: null, line: 1, ch: 0 });
  // The member chain is preferred over its bare word, so the leaf's key wins…
  const leaf = findDefinition(tree, "costs.materials", "materials", 8);
  assert.deepEqual(leaf?.defsite, { notePath: null, line: 3, ch: 2 });
  assert.equal(leaf?.where, "frontmatter");
  // …while the object itself, which binds nothing, resolves to the key that opens it.
  const object = findDefinition(tree, "costs", "costs", 8);
  assert.deepEqual(object?.defsite, { notePath: null, line: 2, ch: 0 });
  assert.equal(object?.entry, null);
});

test("findDefinition: an imported binding names its source note", () => {
  const match = findDefinition(defTree(), "g", "g", 8);
  assert.deepEqual(match?.defsite, { notePath: "lib/Constants.md", line: null, ch: 0 });
  assert.equal(match?.where, "imported");
});

test("findDefinition: an imported object resolves by its own name, not just its leaves", () => {
  // An imported object contributes one entry per leaf (`rates.vat`), so the object's own name binds
  // no entry anywhere — its group is the only thing that knows where it came from.
  const source = derivePreamble({ rates: { base: 100, vat: "rates.base * 0.2" } }, {
    isNumbatTyped: (key) => key === "rates.vat",
    isReserved: () => false,
    plain: PLAIN_NONE,
    plainNested: PLAIN_ALL,
  });

  const tree = buildScopeTree({
    file: "Defs.md",
    lines: DEF_LINES,
    config,
    preamble: EMPTY_PREAMBLE,
    importGroups: [{
      notePath: "lib/Constants.md",
      chunks: source.bindings.flatMap((b) => [...b.defs, b.code]),
      contribution: { properties: source.bindings, sharedChunks: [] },
    }],
  });

  const object = findDefinition(tree, "rates", "rates", 8);
  assert.deepEqual(object?.defsite, { notePath: "lib/Constants.md", line: null, ch: 0 });
  assert.equal(object?.where, "imported");
  assert.equal(object?.entry, null);

  // The leaf still resolves through its own entry, as any imported binding does.
  assert.equal(findDefinition(tree, "rates.vat", "rates", 8)?.entry?.name, "rates.vat");
});

test("findDefinition: the note's own object outranks an import of the same name", () => {
  const tree = buildScopeTree({
    file: "Defs.md",
    lines: DEF_LINES,
    config,
    preamble: derivePreamble({ costs: { materials: 500 } }, {
      isNumbatTyped: () => false,
      isReserved: () => false,
      plain: PLAIN_ALL,
    }),
    importGroups: [{
      notePath: "lib/Constants.md",
      chunks: ["let costs = 1"],
      contribution: {
        properties: [{
          key: "costs.other",
          path: ["costs", "other"],
          name: "costs.other",
          expr: "1",
          defs: [],
          code: "let costs = 1",
          kind: "number",
        }],
        sharedChunks: [],
      },
    }],
  });

  assert.deepEqual(findDefinition(tree, "costs", "costs", 8)?.defsite, { notePath: null, line: 2, ch: 0 });
});
