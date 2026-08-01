import assert from "node:assert/strict";
import { test } from "node:test";
import {
  derivePreamble,
  FIELD_KEYWORDS,
  frontmatterBody,
  frontmatterKeySites,
  MAX_PROPERTY_DEPTH,
  type PreambleRules,
  propertyValueAt,
  sanitizeIdentifier,
} from "../../../src/properties/parse.ts";

// --- sanitizeIdentifier -------------------------------------------------------

test("sanitize keeps plain identifiers", () => {
  assert.equal(sanitizeIdentifier("distance"), "distance");
  assert.equal(sanitizeIdentifier("total_cost"), "total_cost");
  assert.equal(sanitizeIdentifier("Δt"), "Δt");
});

test("sanitize turns separator runs into single underscores", () => {
  assert.equal(sanitizeIdentifier("total cost"), "total_cost");
  assert.equal(sanitizeIdentifier("total - cost"), "total_cost");
  assert.equal(sanitizeIdentifier("a  b--c"), "a_b_c");
});

test("sanitize trims, guards leading digits, and rejects empties", () => {
  assert.equal(sanitizeIdentifier("  pace  "), "pace");
  assert.equal(sanitizeIdentifier("2nd leg"), "_2nd_leg");
  assert.equal(sanitizeIdentifier("---"), null);
  assert.equal(sanitizeIdentifier(""), null);
});

test("sanitize drops leading/trailing separators without underscoring them", () => {
  assert.equal(sanitizeIdentifier("(cost)"), "cost");
  assert.equal(sanitizeIdentifier("cost!"), "cost");
});

// --- derivePreamble -----------------------------------------------------------

const rules = (over: Partial<PreambleRules> = {}): PreambleRules => ({
  isNumbatTyped: (key) => key.startsWith("nb_"),
  isReserved: () => false,
  bindNumbers: true,
  ...over,
});

test("numbat-typed properties bind their text as an expression", () => {
  const preamble = derivePreamble({ nb_total: "5 km + 3 mi" }, rules());
  assert.equal(preamble.bindings.length, 1);
  const [b] = preamble.bindings;
  assert.equal(b.name, "nb_total");
  assert.equal(b.kind, "expression");
  assert.equal(b.code, "let nb_total = (5 km + 3 mi)");
  assert.equal(preamble.source, "let nb_total = (5 km + 3 mi)");
});

test("a numbat-typed number value still binds as an expression", () => {
  const preamble = derivePreamble({ nb_n: 42 }, rules());
  assert.equal(preamble.bindings[0].code, "let nb_n = (42)");
  assert.equal(preamble.bindings[0].kind, "expression");
});

test("untyped plain numbers bind as scalars, other untyped values do not", () => {
  const preamble = derivePreamble(
    { weight: 80.5, title: "hello", done: true, tags: ["a"] },
    rules(),
  );
  assert.deepEqual(
    preamble.bindings.map((b) => b.code),
    ["let weight = (80.5)"],
  );
  assert.equal(preamble.bindings[0].kind, "number");
  // Non-participants are quietly ignored — no skip entries.
  assert.equal(preamble.skips.length, 0);
});

test("untyped numbers stay out when bindNumbers is off", () => {
  const preamble = derivePreamble({ weight: 80.5 }, rules({ bindNumbers: false }));
  assert.equal(preamble.bindings.length, 0);
  assert.equal(preamble.source, "");
});

test("bindings keep frontmatter order so later ones see earlier ones", () => {
  const preamble = derivePreamble(
    { nb_rate: "40 / 1 h", hours: 3, nb_cost: "nb_rate * hours" },
    rules(),
  );
  assert.deepEqual(
    preamble.bindings.map((b) => b.name),
    ["nb_rate", "hours", "nb_cost"],
  );
  assert.equal(
    preamble.source,
    "let nb_rate = (40 / 1 h)\nlet hours = (3)\nlet nb_cost = (nb_rate * hours)",
  );
});

test("reserved names are skipped with an error", () => {
  const preamble = derivePreamble(
    { m: 5, pi: "3" },
    rules({
      isNumbatTyped: (key) => key === "pi",
      isReserved: (name) => name === "m" || name === "pi",
    }),
  );
  assert.equal(preamble.bindings.length, 0);
  assert.deepEqual(
    preamble.skips.map((s) => [s.key, s.reason]),
    [["m", "reserved"], ["pi", "reserved"]],
  );
});

test("a reserved skip checks the sanitized name", () => {
  const preamble = derivePreamble({ "p i": 5 }, rules({ isReserved: (name) => name === "p_i" }));
  assert.equal(preamble.skips[0].reason, "reserved");
});

test("duplicate sanitized names keep the first and skip the rest", () => {
  const preamble = derivePreamble({ "a b": 1, "a-b": 2 }, rules());
  assert.deepEqual(preamble.bindings.map((b) => b.code), ["let a_b = (1)"]);
  assert.deepEqual(preamble.skips.map((s) => [s.key, s.reason]), [["a-b", "duplicate"]]);
});

test("typed properties with unusable values or names report skips", () => {
  const preamble = derivePreamble(
    { nb_obj: { a: [{ b: 1 }] }, nb_flag: true, nb_blank: "  ", "nb_%%%": "1" },
    rules({ isNumbatTyped: () => true }),
  );
  assert.equal(preamble.bindings.length, 1); // nb_%%% sanitizes to nb_
  assert.deepEqual(
    preamble.skips.map((s) => s.reason),
    ["unsupported", "unsupported", "empty"],
  );
});

test("non-finite untyped numbers are ignored", () => {
  const preamble = derivePreamble({ bad: Number.POSITIVE_INFINITY, nan: Number.NaN }, rules());
  assert.equal(preamble.bindings.length, 0);
});

// --- nested (object) properties -----------------------------------------------

// The generated struct names carry a hash of the namespace + the object's key, so assertions read
// them back rather than hard-coding a digest.
const structNames = (code: string): string[] => [...code.matchAll(/struct (\w+)</g)].map((m) => m[1]);

test("an object binds its leaves as struct fields, in document order", () => {
  const preamble = derivePreamble(
    { costs: { materials: 500, labor: 300 }, after: 1 },
    rules(),
  );
  assert.deepEqual(preamble.bindings.map((b) => b.key), ["costs.materials", "costs.labor", "after"]);
  assert.deepEqual(preamble.bindings.map((b) => b.name), ["costs.materials", "costs.labor", "after"]);
  assert.deepEqual(preamble.bindings.map((b) => b.path), [
    ["costs", "materials"],
    ["costs", "labor"],
    ["after"],
  ]);
  assert.deepEqual(preamble.bindings.map((b) => b.kind), ["number", "number", "number"]);
  assert.equal(preamble.skips.length, 0);
});

test("each leaf rebuilds the object, reading earlier fields back off it", () => {
  const preamble = derivePreamble({ costs: { materials: 500, labor: 300 } }, rules());
  const [first, second] = preamble.bindings;
  const [s1] = structNames(first.code);
  const [s2] = structNames(second.code);
  assert.equal(first.code, `struct ${s1}<T0> { materials: T0 }\nlet costs = ${s1} { materials: (500) }`);
  assert.equal(
    second.code,
    `struct ${s2}<T0, T1> { materials: T0, labor: T1 }\n`
      + `let costs = ${s2} { materials: costs.materials, labor: (300) }`,
  );
  // Every generation is a distinct type — redefining a struct is a hard error.
  assert.notEqual(s1, s2);
});

test("a sibling reference is written as the dotted name and kept verbatim", () => {
  const preamble = derivePreamble(
    { costs: { materials: 500, total: "costs.materials * 2" } },
    rules({ isNumbatTyped: (key) => key === "costs.total" }),
  );
  const total = preamble.bindings[1];
  assert.equal(total.name, "costs.total");
  assert.equal(total.expr, "costs.materials * 2");
  assert.equal(total.kind, "expression");
  assert.ok(total.code.includes("total: (costs.materials * 2)"));
});

test("a deeper object nests literally, addressed by its path from the root", () => {
  const preamble = derivePreamble({ costs: { a: 1, inner: { b: 2 } } }, rules());
  assert.deepEqual(preamble.bindings.map((b) => b.name), ["costs.a", "costs.inner.b"]);
  const [inner, outer] = structNames(preamble.bindings[1].code);
  assert.ok(preamble.bindings[1].code.includes(`struct ${inner}<T0> { b: T0 }`));
  assert.ok(
    preamble.bindings[1].code.endsWith(`let costs = ${outer} { a: costs.a, inner: ${inner} { b: (2) } }`),
    preamble.bindings[1].code,
  );
});

test("three levels deep still resolves each existing field by its full path", () => {
  const preamble = derivePreamble({ a: { b: { c: { d: 1, e: 2 } } } }, rules());
  assert.deepEqual(preamble.bindings.map((b) => b.name), ["a.b.c.d", "a.b.c.e"]);
  assert.ok(preamble.bindings[1].code.includes("d: a.b.c.d"), preamble.bindings[1].code);
});

test("isNumbatTyped is asked about the dotted path", () => {
  const asked: string[] = [];
  derivePreamble(
    { costs: { total: 1 }, top: 2 },
    rules({
      isNumbatTyped: (key) => {
        asked.push(key);
        return false;
      },
    }),
  );
  assert.deepEqual(asked, ["costs.total", "top"]);
});

test("bindNumbers off suppresses nested numbers too, so no struct is built", () => {
  const preamble = derivePreamble({ costs: { materials: 500 } }, rules({ bindNumbers: false }));
  assert.equal(preamble.bindings.length, 0);
  assert.equal(preamble.source, "");
});

test("dates, nulls, empty objects and object lists contribute nothing and do not throw", () => {
  const preamble = derivePreamble(
    { items: [{ a: 1 }], due: new Date("2026-07-27"), empty: null, blank: {}, nested: { tags: ["a"] } },
    rules(),
  );
  assert.deepEqual(preamble.bindings, []);
  assert.deepEqual(preamble.skips, []);
});

test("an object key competes for its Numbat name like any other property", () => {
  const preamble = derivePreamble({ costs: 1, costs2: { x: 2 } }, rules());
  assert.deepEqual(preamble.bindings.map((b) => b.name), ["costs", "costs2.x"]);
  // A literal top-level name and an object key are the same namespace.
  const clash = derivePreamble({ costs: 1, "costs ": { x: 2 } }, rules());
  assert.deepEqual(clash.bindings.map((b) => b.name), ["costs"]);
  assert.deepEqual(clash.skips.map((s) => [s.key, s.reason]), [["costs ", "duplicate"]]);
});

test("a reserved object key skips the whole object, once", () => {
  const preamble = derivePreamble(
    { m: { a: 1, b: 2, c: 3 } },
    rules({ isReserved: (name) => name === "m" }),
  );
  assert.deepEqual(preamble.bindings, []);
  assert.deepEqual(preamble.skips.map((s) => [s.key, s.path, s.reason]), [["m", ["m"], "reserved"]]);
});

test("an object holding nothing bindable neither claims its name nor reports a skip", () => {
  const preamble = derivePreamble(
    { m: { title: "text" }, note: "prose" },
    rules({ isReserved: (name) => name === "m" }),
  );
  assert.deepEqual(preamble.bindings, []);
  assert.deepEqual(preamble.skips, []);
});

test("a field name may shadow a unit — struct fields are their own namespace", () => {
  const preamble = derivePreamble({ si: { m: 5 } }, rules({ isReserved: (name) => name === "m" }));
  assert.deepEqual(preamble.bindings.map((b) => b.name), ["si.m"]);
  assert.deepEqual(preamble.skips, []);
});

test("a leaf named with a Numbat keyword is skipped, leaving its siblings alone", () => {
  const preamble = derivePreamble({ meta: { a: 1, type: 2, b: 3 } }, rules());
  assert.deepEqual(preamble.bindings.map((b) => b.name), ["meta.a", "meta.b"]);
  assert.deepEqual(preamble.skips.map((s) => [s.key, s.reason]), [["meta.type", "reserved"]]);
});

test("FIELD_KEYWORDS is the set Numbat's grammar refuses in field position", () => {
  // Pinned against the built wasm (v1.23.0): every name in the interpreter's completion vocabulary
  // was tried as a struct field name.
  assert.deepEqual([...FIELD_KEYWORDS].sort(), [
    "Bool",
    "DateTime",
    "Fn",
    "List",
    "NaN",
    "String",
    "and",
    "assert",
    "assert_eq",
    "both",
    "dimension",
    "else",
    "false",
    "fn",
    "if",
    "inf",
    "let",
    "long",
    "none",
    "per",
    "print",
    "short",
    "struct",
    "then",
    "to",
    "true",
    "type",
    "unit",
    "use",
    "where",
  ]);
});

test("two keys that sanitize to one field name collide as a duplicate", () => {
  const preamble = derivePreamble({ costs: { "sub total": 1, "sub-total": 2 } }, rules());
  assert.deepEqual(preamble.bindings.map((b) => b.name), ["costs.sub_total"]);
  assert.deepEqual(preamble.skips.map((s) => [s.key, s.reason]), [["costs.sub-total", "duplicate"]]);
});

test("a nested key with no usable name is skipped, not silently dropped", () => {
  const preamble = derivePreamble({ costs: { "!!!": 1 } }, rules());
  assert.deepEqual(preamble.bindings, []);
  assert.deepEqual(preamble.skips.map((s) => [s.key, s.reason]), [["costs.!!!", "invalid-name"]]);
});

test("a cyclic record terminates instead of hanging", () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  const preamble = derivePreamble({ root: cyclic }, rules());
  assert.deepEqual(preamble.bindings.map((b) => b.name), ["root.a"]);
});

test("the depth cap stops a merely absurd nesting", () => {
  let leaf: Record<string, unknown> = { deep: 1 };
  for (let i = 0; i < MAX_PROPERTY_DEPTH + 3; i += 1) {
    leaf = { down: leaf };
  }
  const preamble = derivePreamble({ root: leaf }, rules());
  assert.deepEqual(preamble.bindings, []);
});

test("the namespace changes the generated struct names, so imports cannot clash", () => {
  const one = derivePreamble({ costs: { a: 1 } }, rules({ namespace: "One.md" }));
  const two = derivePreamble({ costs: { a: 1 } }, rules({ namespace: "Two.md" }));
  assert.notDeepEqual(structNames(one.bindings[0].code), structNames(two.bindings[0].code));
  // Same note, same object, same result — the names are derived, not counted.
  const again = derivePreamble({ costs: { a: 1 } }, rules({ namespace: "One.md" }));
  assert.deepEqual(structNames(one.bindings[0].code), structNames(again.bindings[0].code));
});

test("the pure walk does not filter `position` — that is the cache bridge's job", () => {
  const preamble = derivePreamble({ meta: { position: 1 } }, rules());
  assert.deepEqual(preamble.bindings.map((b) => b.name), ["meta.position"]);
});

// --- arrays as lists ----------------------------------------------------------

test("an untyped array of plain numbers binds as a list", () => {
  const preamble = derivePreamble({ weights: [70, 72, 71] }, rules());
  assert.deepEqual(preamble.bindings.map((b) => [b.name, b.expr, b.kind]), [[
    "weights",
    "[70, 72, 71]",
    "number",
  ]]);
  assert.equal(preamble.bindings[0].code, "let weights = ([70, 72, 71])");
});

test("a numbat-typed array binds each item as an expression", () => {
  const preamble = derivePreamble({ rates: ["5 EUR", "3 EUR"] }, rules({ isNumbatTyped: () => true }));
  // Parenthesized per item, for the same reason a scalar binding is: an item like `5 km + 3 mi`
  // must stay one element.
  assert.deepEqual(preamble.bindings.map((b) => [b.expr, b.kind]), [["[(5 EUR), (3 EUR)]", "expression"]]);
});

test("arrays nest, and an empty array binds", () => {
  const preamble = derivePreamble({ grid: [[1, 2], [3]], none: [] }, rules());
  assert.deepEqual(preamble.bindings.map((b) => b.expr), ["[[1, 2], [3]]", "[]"]);
});

test("untyped arrays bind only when every item is a plain number, recursively", () => {
  const preamble = derivePreamble(
    { tags: ["a", "b"], part: [1, "a"], deep: [1, [2, "a"]], flags: [true], gaps: [1, null] },
    rules(),
  );
  assert.deepEqual(preamble.bindings, []);
  assert.deepEqual(preamble.skips, []); // quiet, like every other untyped non-number
});

test("an array of objects is unsupported when typed, and quiet when not", () => {
  const typed = derivePreamble({ rows: [{ a: 1 }] }, rules({ isNumbatTyped: () => true }));
  assert.deepEqual(typed.bindings, []);
  assert.deepEqual(typed.skips.map((s) => [s.key, s.reason]), [["rows", "unsupported"]]);
  const untyped = derivePreamble({ rows: [{ a: 1 }] }, rules());
  assert.deepEqual(untyped.bindings, []);
  assert.deepEqual(untyped.skips, []);
});

test("bindNumbers off suppresses untyped arrays too", () => {
  const preamble = derivePreamble({ weights: [70, 72] }, rules({ bindNumbers: false }));
  assert.deepEqual(preamble.bindings, []);
});

test("an array inside an object becomes a struct field holding the list", () => {
  const preamble = derivePreamble({ costs: { items: [500, 300] } }, rules());
  const [binding] = preamble.bindings;
  assert.equal(binding.name, "costs.items");
  assert.equal(binding.expr, "[500, 300]");
  assert.ok(binding.code.endsWith("{ items: ([500, 300]) }"), binding.code);
});

test("a mixed typed array binds and leaves the type error to Numbat", () => {
  // Nothing here can type-check, and Numbat's own message beats a guess.
  const preamble = derivePreamble({ mixed: [1, "2 m"] }, rules({ isNumbatTyped: () => true }));
  assert.deepEqual(preamble.bindings.map((b) => b.expr), ["[(1), (2 m)]"]);
  assert.deepEqual(preamble.skips, []);
});

// --- frontmatterKeySites ------------------------------------------------------

const sitesOf = (text: string) =>
  [...frontmatterKeySites(text.split("\n"))].map(([key, s]) => [key, s.line, s.ch, s.endLine]);

test("key sites index nested keys by dotted path, with indent and extent", () => {
  assert.deepEqual(
    sitesOf(`---
weight: 80
costs:
  materials: 500
  breakdown:
    doubled: 12
after: 1
---
prose`),
    [
      ["weight", 1, 0, 1],
      ["costs", 2, 0, 5],
      ["costs.materials", 3, 2, 3],
      ["costs.breakdown", 4, 2, 5],
      ["costs.breakdown.doubled", 5, 4, 5],
      ["after", 6, 0, 6],
    ],
  );
});

test("quoted keys, trailing comments and blank lines are handled", () => {
  assert.deepEqual(
    sitesOf(`---
costs:  # rough
  "sub total": 1

  'other': 2
after: 3
---`),
    [
      ["costs", 1, 0, 4],
      ["costs.sub total", 2, 2, 2],
      ["costs.other", 4, 2, 4],
      ["after", 5, 0, 5],
    ],
  );
});

test("only a key with no value opens a block — the three look-alikes are values", () => {
  // A block scalar whose body contains `total: 5`.
  assert.deepEqual(sitesOf("---\nnote: |\n  total: 5\nweight: 7\n---"), [
    ["note", 1, 0, 1],
    ["weight", 3, 0, 3],
  ]);
  // A flow mapping: the key is placeable, its members are not.
  assert.deepEqual(sitesOf("---\ncosts: {materials: 1}\nweight: 3\n---"), [
    ["costs", 1, 0, 1],
    ["weight", 2, 0, 2],
  ]);
  // A multi-line plain scalar.
  assert.deepEqual(sitesOf("---\ndesc: some text\n  more: text\nweight: 6\n---"), [
    ["desc", 1, 0, 1],
    ["weight", 3, 0, 3],
  ]);
});

test("sequences are skipped without hiding the keys after them", () => {
  assert.deepEqual(sitesOf("---\ntags:\n- alpha\n- beta\nweight: 4\n---"), [
    ["tags", 1, 0, 1],
    ["weight", 4, 0, 4],
  ]);
  assert.deepEqual(sitesOf("---\nitems:\n  - a: 1\n    b: 2\nweight: 5\n---"), [
    ["items", 1, 0, 3],
    ["weight", 4, 0, 4],
  ]);
});

test("anchors, aliases and tab indentation place nothing but break nothing", () => {
  assert.deepEqual(sitesOf("---\nbase: &b\n  a: 1\nother: *b\nweight: 8\n---"), [
    ["base", 1, 0, 1],
    ["other", 3, 0, 3],
    ["weight", 4, 0, 4],
  ]);
  assert.deepEqual(sitesOf("---\na:\n\tb: 1\nd: 2\n---"), [["a", 1, 0, 2], ["d", 3, 0, 3]]);
});

test("the same leaf name under two parents keeps its own site", () => {
  assert.deepEqual(sitesOf("---\none:\n  total: 1\ntwo:\n  total: 2\n---"), [
    ["one", 1, 0, 2],
    ["one.total", 2, 2, 2],
    ["two", 3, 0, 4],
    ["two.total", 4, 2, 4],
  ]);
});

test("an empty key closes immediately, and a note without frontmatter has no sites", () => {
  assert.deepEqual(sitesOf("---\nempty:\nweight: 7\n---"), [["empty", 1, 0, 1], ["weight", 2, 0, 2]]);
  assert.deepEqual(sitesOf("no frontmatter"), []);
});

// --- propertyValueAt ----------------------------------------------------------

const FM = [
  "---",
  "weight: 80",
  "costs:",
  "  total: costs.materials",
  "empty:",
  "---",
  "prose: not frontmatter",
];

test("propertyValueAt names the property whose value the caret is in", () => {
  // `weight: 80` — the value starts at column 8.
  assert.deepEqual(propertyValueAt(FM, 1, 8), { key: "weight", valueCh: 8 });
  assert.deepEqual(propertyValueAt(FM, 1, 10), { key: "weight", valueCh: 8 });
  // Nested keys come back dotted, and the column is past the indented key.
  assert.deepEqual(propertyValueAt(FM, 3, 9), { key: "costs.total", valueCh: 9 });
});

test("propertyValueAt refuses the key half, and a bare key still counts", () => {
  assert.equal(propertyValueAt(FM, 1, 0), null); // on the key
  assert.equal(propertyValueAt(FM, 1, 7), null); // on the colon
  // `empty:` has no value yet — which is exactly when completion is wanted.
  assert.deepEqual(propertyValueAt(FM, 4, 6), { key: "empty", valueCh: 6 });
});

test("propertyValueAt ignores everything outside the frontmatter", () => {
  assert.equal(propertyValueAt(FM, 0, 0), null); // the opening delimiter
  assert.equal(propertyValueAt(FM, 5, 0), null); // the closing one
  assert.equal(propertyValueAt(FM, 6, 8), null); // prose that looks like a key
  assert.equal(propertyValueAt(["no frontmatter"], 0, 5), null);
  assert.equal(propertyValueAt(FM, 99, 0), null); // past the end
});

// --- frontmatterBody ----------------------------------------------------------

test("frontmatter body is the lines between the delimiters", () => {
  assert.deepEqual(frontmatterBody(["---", "a: 1", "b: two", "---", "prose"]), ["a: 1", "b: two"]);
});

test("frontmatter closes on ... too", () => {
  assert.deepEqual(frontmatterBody(["---", "a: 1", "...", "prose"]), ["a: 1"]);
});

test("no opener on the first line means no frontmatter", () => {
  assert.equal(frontmatterBody(["# heading", "---", "a: 1", "---"]), null);
  assert.equal(frontmatterBody([]), null);
});

test("an unclosed opener means no frontmatter", () => {
  assert.equal(frontmatterBody(["---", "a: 1"]), null);
});

test("a --- ruler later in the note is not frontmatter", () => {
  assert.equal(frontmatterBody(["prose", "---", "more"]), null);
});

test("generated struct names carry a readable label derived from the key", () => {
  const preamble = derivePreamble(
    { costs: { a: 1, breakdown: { b: 2 } }, "total cost": { c: 3 } },
    rules(),
  );
  const names = preamble.bindings.flatMap((b) => structNames(b.code));
  // The label is what interpreter/numbat.ts shows the user; the hash and the generation counter
  // behind it keep every definition distinct.
  assert.deepEqual(
    [...new Set(names.map((n) => /^_Nb_([A-Za-z0-9]+)_/.exec(n)?.[1]))],
    ["CostsStruct", "CostsBreakdownStruct", "TotalCostStruct"],
  );
  assert.ok(names.every((n) => /^_Nb_[A-Za-z0-9]+_[0-9a-z]+_\d+_\d+$/.test(n)), names.join(" "));
  // Distinct definitions throughout — a repeated `struct` is a hard error.
  assert.equal(new Set(names).size, names.length);
});
