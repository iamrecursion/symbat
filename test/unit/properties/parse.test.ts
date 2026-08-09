import assert from "node:assert/strict";
import { test } from "node:test";
import { definedValue, NULLABLE_ABSENT } from "../../../src/interpreter/nullable.ts";
import {
  bindingKey,
  derivePreamble,
  FIELD_KEYWORDS,
  frontmatterBody,
  frontmatterKeySites,
  MAX_PROPERTY_DEPTH,
  PLAIN_ALL,
  PLAIN_NONE,
  type PlainBindings,
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
  plain: PLAIN_ALL,
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

// A date binds as one only under a property explicitly assigned Obsidian's Date type, so the
// records below say so where they mean a date.
const dateTyped = { assignedType: (key: string) => key === "due" ? "date" : null };

test("untyped plain values ride along as the kind of value they are", () => {
  const preamble = derivePreamble(
    { weight: 80.5, title: "hello", done: true, due: new Date("2026-07-27T00:00:00Z") },
    rules(dateTyped),
  );
  assert.deepEqual(preamble.bindings.map((b) => [b.code, b.kind]), [
    ["let weight = (80.5)", "number"],
    ["let title = (\"hello\")", "text"],
    ["let done = (true)", "boolean"],
    ["let due = (date(\"2026-07-27\"))", "date"],
  ]);
  // None of it is opted into, so none of it can report a problem.
  assert.equal(preamble.skips.length, 0);
});

test("each kind of plain value is its own setting", () => {
  const record = { weight: 80.5, title: "hello", done: true, due: new Date("2026-07-27T00:00:00Z") };
  const only = (kind: keyof typeof PLAIN_ALL) =>
    derivePreamble(record, rules({ ...dateTyped, plain: { ...PLAIN_NONE, [kind]: true } })).bindings.map((b) => b.key);

  assert.deepEqual(only("numbers"), ["weight"]);
  assert.deepEqual(only("booleans"), ["done"]);
  assert.deepEqual(only("dates"), ["due"]);
  // Text picks up the date too: without the dates setting it is the text it was written as, which
  // is exactly what the surfaces reading Obsidian's property cache are handed.
  assert.deepEqual(only("text"), ["title", "due"]);
  assert.deepEqual(derivePreamble(record, rules({ plain: PLAIN_NONE })).bindings, []);
});

test("untyped values stay out entirely when nothing plain binds", () => {
  const preamble = derivePreamble({ weight: 80.5 }, rules({ plain: PLAIN_NONE }));
  assert.equal(preamble.bindings.length, 0);
  assert.equal(preamble.source, "");
});

test("vault machinery is held back, unless it is explicitly Numbat-typed", () => {
  const record = { tags: ["a"], aliases: ["b"], cssclasses: ["c"], "numbat-use": "[[Constants]]", title: "kept" };
  assert.deepEqual(derivePreamble(record, rules()).bindings.map((b) => b.key), ["title"]);

  // An explicit type assignment beats the default.
  const typed = derivePreamble(record, rules({ isNumbatTyped: (key) => key === "tags.#" }));
  assert.deepEqual(typed.bindings.map((b) => b.key), ["tags", "title"]);

  // Only at the top level: a `tags` of your own inside an object is your data.
  const nested = derivePreamble({ meta: { tags: ["a"] } }, rules());
  assert.deepEqual(nested.bindings.map((b) => b.name), ["meta.tags"]);
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
      isNumbatTyped: () => true,
      isReserved: (name) => name === "m" || name === "pi",
    }),
  );
  assert.equal(preamble.bindings.length, 0);
  assert.deepEqual(
    preamble.skips.map((s) => [s.key, s.reason]),
    [["m", "reserved"], ["pi", "reserved"]],
  );
});

test("a plain value that cannot claim a name is a non-participant, not a problem", () => {
  // `id`, `date`, `time`, `year`, `day`, `month` and `people` are all prelude names *and* ordinary
  // frontmatter keys. Reporting them would put a row in the inspector on a great many notes that
  // never opted into anything, so an untyped value that cannot have a name simply does not bind.
  const preamble = derivePreamble(
    { m: 5, "a b": 1, "a-b": 2, "---": 9 },
    rules({ isReserved: (name) => name === "m" }),
  );
  assert.deepEqual(preamble.bindings.map((b) => b.code), ["let a_b = (1)"]);
  assert.deepEqual(preamble.skips, []);
});

test("a reserved skip checks the sanitized name", () => {
  const preamble = derivePreamble(
    { "p i": 5 },
    rules({ isNumbatTyped: () => true, isReserved: (name) => name === "p_i" }),
  );
  assert.equal(preamble.skips[0].reason, "reserved");
});

test("duplicate sanitized names keep the first and skip the rest", () => {
  const preamble = derivePreamble({ "a b": 1, "a-b": 2 }, rules({ isNumbatTyped: () => true }));
  assert.deepEqual(preamble.bindings.map((b) => b.code), ["let a_b = (1)"]);
  assert.deepEqual(preamble.skips.map((s) => [s.key, s.reason]), [["a-b", "duplicate"]]);
});

test("typed properties with unusable values or names report skips", () => {
  const preamble = derivePreamble(
    { nb_flag: true, nb_blank: "  ", "nb_%%%": "1", nb_when: new Date("2026-07-27") },
    rules({ isNumbatTyped: () => true }),
  );
  // nb_%%% sanitizes to nb_, and nb_blank is empty rather than unusable — it binds undefined.
  assert.deepEqual(preamble.bindings.map((b) => [b.key, b.expr]), [
    ["nb_blank", NULLABLE_ABSENT],
    ["nb_%%%", "1"],
  ]);
  assert.deepEqual(
    preamble.skips.map((s) => s.reason),
    ["unsupported", "unsupported"],
  );
});

test("a numbat-typed property with no value binds undefined rather than reporting a skip", () => {
  for (const empty of [null, "", "   "]) {
    const preamble = derivePreamble({ nb_x: empty }, rules({ isNumbatTyped: () => true }));
    assert.deepEqual(preamble.bindings.map((b) => [b.name, b.expr, b.kind]), [[
      "nb_x",
      NULLABLE_ABSENT,
      "expression",
    ]]);
    assert.deepEqual(preamble.skips, []);
  }
});

test("an empty untyped property binds undefined only under a type that says a value was wanted", () => {
  // Nothing declared: as quiet as it has always been, so an empty `summary:` claims no Numbat name.
  assert.equal(exprFor(null), undefined);

  // Declared, so the type menu is the opt-in the missing value cannot be.
  assert.equal(exprFor(null, { assignedType: () => "number" }), NULLABLE_ABSENT);
  assert.equal(exprFor(null, { assignedType: () => "text" }), NULLABLE_ABSENT);
  assert.equal(exprFor(null, { assignedType: () => "date" }), NULLABLE_ABSENT);
  assert.deepEqual(
    derivePreamble({ p: null }, rules({ assignedType: () => "number" })).bindings.map((b) => b.kind),
    ["number"],
  );

  // …and the reading is still the setting's to make.
  assert.equal(exprFor(null, { assignedType: () => "text", plain: { ...PLAIN_ALL, text: false } }), undefined);
  assert.equal(exprFor(null, { assignedType: () => "date", plain: { ...PLAIN_ALL, dates: false } }), undefined);
});

test("non-finite untyped numbers are ignored", () => {
  const preamble = derivePreamble({ bad: Number.POSITIVE_INFINITY, nan: Number.NaN }, rules());
  assert.equal(preamble.bindings.length, 0);
});

// --- text, dates and booleans -------------------------------------------------

const exprFor = (value: unknown, over: Partial<PreambleRules> = {}): string | undefined =>
  derivePreamble({ p: value }, rules(over)).bindings[0]?.expr;

test("text is escaped so nothing in it can be read as Numbat", () => {
  assert.equal(exprFor("plain prose"), "\"plain prose\"");
  assert.equal(exprFor("has \"quotes\""), "\"has \\\"quotes\\\"\"");
  assert.equal(exprFor("back\\slash"), "\"back\\\\slash\"");
  // The one that matters: Numbat strings interpolate, so an unescaped `{rate}` would *evaluate*.
  assert.equal(exprFor("cost {rate} each"), "\"cost {{rate}} each\"");
  assert.equal(exprFor("a\nb\tc"), "\"a\\nb\\tc\"");
});

test("a date binds as local midnight, and a time as local wall-clock", () => {
  const dated = { assignedType: () => "date" };
  // A `due:` on a note is a day in the reader's life, so `date(…)` — which Numbat reads as local.
  assert.equal(exprFor(new Date("2026-07-27T00:00:00Z"), dated), "date(\"2026-07-27\")");
  // A timestamp keeps its clock: read back in UTC, which is the zone YAML gave it.
  assert.equal(exprFor(new Date("2026-07-27T10:30:00Z"), dated), "datetime(\"2026-07-27 10:30:00\")");
  // An unparseable date is not a date, and is not text either — there is no text to bind.
  assert.equal(exprFor(new Date("nonsense"), dated), undefined);
});

test("a timestamp the YAML parsed reads exactly as the same value read as text", () => {
  // One is what parsing the note's own YAML hands over, the other what Obsidian's property cache
  // does. The surfaces split along that line, so the two readings must not.
  const dated = { assignedType: () => "date" };
  const pairs = [["2026-07-27", "2026-07-27T00:00:00Z"], ["2026-07-27 10:30:00", "2026-07-27T10:30:00Z"]];
  for (const [text, parsed] of pairs) {
    assert.equal(exprFor(new Date(parsed), dated), exprFor(text, dated), text);
    // …and with no Date type assigned, both are the text they were written as.
    assert.equal(exprFor(new Date(parsed)), exprFor(text), text);
  }
});

test("a date that arrives as text is read as one only under a date property", () => {
  const dated = { assignedType: () => "date" };
  assert.equal(exprFor("2026-07-27", dated), "date(\"2026-07-27\")");
  // The space form is local; the `T` form is a Numbat runtime error without an offset, so the
  // separator is swapped — which is exactly the shape Better Properties writes.
  assert.equal(exprFor("2026-07-27T10:30:00", dated), "datetime(\"2026-07-27 10:30:00\")");
  assert.equal(exprFor("2026-07-27 10:30", dated), "datetime(\"2026-07-27 10:30:00\")");
  // An explicit offset is kept, in the form that requires one.
  assert.equal(exprFor("2026-07-27T10:30:00+02:00", dated), "datetime(\"2026-07-27T10:30:00+02:00\")");
  assert.equal(exprFor("2026-07-27T10:30:00.500Z", dated), "datetime(\"2026-07-27T10:30:00Z\")");

  // Without the type assignment it is text — Obsidian shows its date picker for a date-shaped value
  // without assigning anything, so the shape is not the opt-in it looks like. Text that will not
  // parse stays text either way.
  assert.equal(exprFor("2026-07-27"), "\"2026-07-27\"");
  assert.equal(exprFor("not a date", dated), "\"not a date\"");
  // Better Properties' own date type counts as one.
  assert.equal(exprFor("2026-07-27", { assignedType: () => "better-properties:datecustom" }), "date(\"2026-07-27\")");
});

test("an unticked checkbox binds false rather than undefined", () => {
  assert.equal(exprFor(null, { assignedType: () => "checkbox" }), "false");
  assert.equal(exprFor(null, { assignedType: () => "better-properties:toggle" }), "false");
  // `null` is what *every* empty property parses to; under a checkbox it is the unticked box, which
  // is a value rather than the lack of one, so it never reads as undefined.
  assert.equal(exprFor(null), undefined);
  // And the reading is the booleans setting's to make.
  assert.equal(
    exprFor(null, { assignedType: () => "checkbox", plain: { ...PLAIN_ALL, booleans: false } }),
    undefined,
  );
});

test("an unticked checkbox inside an object is a value, not a hole", () => {
  // Worth pinning separately: a hole inside an object is the one that cannot be bound (it would
  // leave the struct polymorphic and cost every sibling), and a checkbox must never be routed down
  // that path — an unset box is `false`, which types as `Bool` like any other value.
  const preamble = derivePreamble(
    { flags: { on: null, n: 1 } },
    rules({ assignedType: (key) => key === "flags.on" ? "checkbox" : null }),
  );

  assert.deepEqual(preamble.bindings.map((b) => [b.name, b.expr, b.kind]), [
    ["flags.on", "false", "boolean"],
    ["flags.n", "1", "number"],
  ]);
  // No hole machinery anywhere near it: no typed-hole definition, no dropped field.
  assert.deepEqual(preamble.bindings.flatMap((b) => b.defs), []);
});

test("plain values ride along inside objects and lists alike", () => {
  const preamble = derivePreamble(
    { trip: { name: "Kyoto", days: 3, booked: true }, notes: ["one", "two"] },
    rules(),
  );
  assert.deepEqual(preamble.bindings.map((b) => [b.name, b.expr]), [
    ["trip.name", "\"Kyoto\""],
    ["trip.days", "3"],
    ["trip.booked", "true"],
    ["notes", "[\"one\", \"two\"]"],
  ]);
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

test("a numbat-typed hole binds nothing inside an object", () => {
  // The numbat type menu describes the value's *syntax*, not its type, so an empty one says nothing
  // at all. A field with no type leaves a type variable in the generated struct, and Numbat cannot
  // solve a `HasField` constraint against a polymorphic struct — so keeping it cost the reader
  // every field of the object. `costs.materials` failed just as surely as `costs.spare` did.
  const preamble = derivePreamble(
    { costs: { materials: 500, spare: null } },
    rules({ isNumbatTyped: (key) => key === "costs.spare" }),
  );

  assert.deepEqual(preamble.bindings.map((b) => b.name), ["costs.materials"]);
  const [only] = preamble.bindings;
  const [s1] = structNames(only.code);
  assert.equal(only.code, `struct ${s1}<T0> { materials: T0 }\nlet costs = ${s1} { materials: (500) }`);
});

test("a hole the type menu gave a type to binds inside an object, carrying that type", () => {
  // number / text / date / datetime name the type outright, so an empty one of those is a hole of a
  // known type rather than a hole of no type — and binds wherever a filled one would.
  for (
    const [assigned, type] of [["number", "Scalar"], ["text", "String"], ["date", "DateTime"], ["datetime", "DateTime"]]
  ) {
    const preamble = derivePreamble(
      { costs: { spare: null, materials: 500 } },
      rules({ assignedType: () => assigned }),
    );
    assert.deepEqual(preamble.bindings.map((b) => b.name), ["costs.spare", "costs.materials"], assigned);

    // The type rides on the *value*, not on the struct field: Numbat expands a declared field of a
    // generic type without substituting into it, and then rejects the value that matches.
    const [hole] = preamble.bindings;
    assert.deepEqual(hole.defs, [`let _Nb_hole_${type}: Opt<${type}> = ${NULLABLE_ABSENT}`], assigned);
    assert.equal(hole.expr, `_Nb_hole_${type}`, assigned);
    assert.match(hole.code, /\{ spare: T0 \}/, assigned);
  }
});

test("an object of nothing but numbat-typed holes binds nothing at all", () => {
  const preamble = derivePreamble({ box: { spare: null } }, rules({ isNumbatTyped: (key) => key === "box.spare" }));
  assert.deepEqual(preamble.bindings, []);
});

test("a list of nothing but holes is type-free in the same way, and goes the same way", () => {
  const preamble = derivePreamble({ box: { xs: [null, null] } }, rules({ isNumbatTyped: (key) => key === "box.xs" }));
  assert.deepEqual(preamble.bindings, []);

  // At the top level there is no struct to poison, so the very same value binds happily — `let xs =
  // […]` generalizes, and that is the asymmetry this rule buys.
  const lone = derivePreamble({ xs: [null, null] }, rules({ isNumbatTyped: (key) => key === "xs" }));
  assert.deepEqual(lone.bindings.map((b) => b.name), ["xs"]);
});

test("an empty list is as type-free as a hole, and is dropped from an object the same way", () => {
  // `[]` types as `forall A. List<A>`, which leaves the same type variable in the generated struct
  // that a hole does — and costs the same: every *other* field of the object with it.
  const preamble = derivePreamble({ costs: { materials: 500, spare: [] } }, rules());
  assert.deepEqual(preamble.bindings.map((b) => b.name), ["costs.materials"]);

  // On its own it still binds, exactly as a lone hole does: no struct, nothing to poison.
  const lone = derivePreamble({ spare: [] }, rules());
  assert.deepEqual(lone.bindings.map((b) => [b.name, b.expr]), [["spare", "[]"]]);
});

test("a type-free field is dropped from an array's element type too, not only from an object", () => {
  // The array path has its own type: an element is a generated struct like any other, so a field
  // saying nothing about what it holds leaves *that* type polymorphic and every sibling field of
  // every item unreadable — `element_at(0, legs).weight` fails as surely as `legs.#.marks` would.
  for (const marks of [[null, null], [], [[]], [[null]]]) {
    const preamble = derivePreamble({ legs: [{ weight: 80, marks }] }, rules());
    const [binding] = preamble.bindings;

    assert.deepEqual(preamble.bindings.map((b) => b.key), ["legs"], JSON.stringify(marks));
    assert.match(binding.expr, /^\[_Nb_LegsStruct_\w+ \{ weight: \(80\) \}\]$/, JSON.stringify(marks));
    assert.equal(binding.defs.length, 1, JSON.stringify(marks));
    assert.ok(binding.defs[0].endsWith("<T0> { weight: T0 }"), binding.defs[0]);
  }
});

test("a list one item fills is not type-free, and keeps its holes", () => {
  // The rule above is about a position that never said what it holds — not about emptiness. One
  // filled item is all it takes, and the gaps beside it stay as gaps.
  const preamble = derivePreamble({ legs: [{ weight: 80, marks: [1, null] }] }, rules());
  const [binding] = preamble.bindings;

  assert.match(binding.expr, /marks: \(\[.+\]\)/);
  assert.ok(binding.expr.includes(`${definedValue("1")}, ${NULLABLE_ABSENT}`), binding.expr);
});

test("a numbat-typed leaf dropped for having no type says so, and a plain one stays quiet", () => {
  // Dropped silently, a property the reader explicitly opted in disappears with no binding, no
  // inlay and nothing to explain why — leaving `costs.spare` reporting only that it does not exist.
  const typed = derivePreamble(
    { costs: { materials: 500, spare: null } },
    rules({ isNumbatTyped: (key) => key === "costs.spare" }),
  );
  assert.deepEqual(typed.skips.map((s) => [s.key, s.reason]), [["costs.spare", "unsupported"]]);
  assert.match(typed.skips[0].message, /nothing here says what type it holds/);

  // A plain value that rode along was never asked for: a name it cannot have makes it a
  // non-participant rather than a problem, exactly as claimName's own reporting rule has it.
  const plain = derivePreamble({ costs: { materials: 500, spare: [] } }, rules());
  assert.deepEqual(plain.skips, []);
});

test("a lone hole still binds, and is not narrowed on the way", () => {
  const preamble = derivePreamble({ budget: null }, rules({ isNumbatTyped: (key) => key === "budget" }));
  assert.deepEqual(preamble.bindings.map((b) => [b.name, b.expr]), [["budget", NULLABLE_ABSENT]]);

  // A declared-kind hole on its own keeps the bare literal too: nothing needs its type there, and
  // `forall A. Opt<A>` accepts a fallback of any type where `Opt<Scalar>` would not.
  const plain = derivePreamble({ budget: null }, rules({ assignedType: () => "number" }));
  assert.deepEqual(plain.bindings.map((b) => [b.expr, b.defs]), [[NULLABLE_ABSENT, []]]);
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
  const preamble = derivePreamble({ costs: { materials: 500 } }, rules({ plain: PLAIN_NONE }));
  assert.equal(preamble.bindings.length, 0);
  assert.equal(preamble.source, "");
});

// --- plainNested (what a note exports to its importers) ------------------------

// `nb_` marks a numbat-typed leaf at whatever depth it sits, so a nested key (`costs.nb_total`)
// reads the same way the top-level default does.
const nbLeaf = (key: string) => key.split(".").some((segment) => segment.startsWith("nb_"));

// The export rule: nothing untyped binds on its own, but an object that binds at all binds whole,
// because its typed leaves may read a plain sibling by its dotted name.
const exportRules = (over: Partial<PreambleRules> = {}): PreambleRules =>
  rules({ isNumbatTyped: nbLeaf, plain: PLAIN_NONE, plainNested: PLAIN_ALL, ...over });

test("plainNested keeps a plain leaf inside an object the top-level rule would drop", () => {
  const preamble = derivePreamble(
    { weight: 80.5, costs: { materials: 500, nb_total: "costs.materials * 1.2" } },
    exportRules(),
  );

  // The lone plain property is still private; the one inside the exported object is not.
  assert.deepEqual(preamble.bindings.map((b) => b.key), ["costs.materials", "costs.nb_total"]);
  assert.equal(preamble.bindings[0].kind, "number");
});

test("plainNested gates on a typed leaf, so an all-plain object stays private", () => {
  const preamble = derivePreamble(
    { meta: { author: "ara", revision: 3 }, costs: { nb_total: "5 €" } },
    exportRules(),
  );

  assert.deepEqual(preamble.bindings.map((b) => b.key), ["costs.nb_total"]);
  // Nothing under `meta` was asked for, so nothing about it is reported either.
  assert.deepEqual(preamble.skips, []);
});

test("plainNested's gate sees a typed leaf at any depth, and through an array's item key", () => {
  const deep = derivePreamble({ a: { b: { nb_c: "1 m" } } }, exportRules());
  assert.deepEqual(deep.bindings.map((b) => b.key), ["a.b.nb_c"]);

  // `legs.#.distance` is where a type menu applied to array items lives; the object holding the
  // array exports on the strength of it.
  const arrayed = derivePreamble(
    { trip: { legs: [{ distance: "5 km" }, { distance: "10 km" }] } },
    exportRules({ isNumbatTyped: (key) => key === "trip.legs.#.distance" }),
  );
  assert.deepEqual(arrayed.bindings.map((b) => b.key), ["trip.legs"]);
});

test("plainNested reaches an array's items, which sit below the top level too", () => {
  // The array is typed by its item key, so it binds; its untyped sibling field rides along inside
  // the element struct rather than being dropped out of it.
  const preamble = derivePreamble(
    { legs: [{ nb_distance: "5 km", label: "first" }] },
    exportRules({ isNumbatTyped: (key) => key === "legs.#.nb_distance" }),
  );

  assert.deepEqual(preamble.bindings.map((b) => b.key), ["legs"]);
  assert.equal(preamble.bindings[0].code.includes("\"first\""), true, "the plain field is in the element");
});

test("plainNested keeps an empty leaf whose type menu names a type", () => {
  // An empty property carries no value to read a kind off, so only its assigned type says a Numbat
  // value was wanted there (declaredKind). That reading has to happen at the depth the property
  // sits at like every other: dropping the hole would export `costs` without a `materials` field,
  // and the sibling that reads it takes the whole object down with it.
  const preamble = derivePreamble(
    { costs: { materials: null, nb_total: "costs.materials * 1.2" } },
    exportRules({ assignedType: (key) => key === "costs.materials" ? "number" : null }),
  );

  assert.deepEqual(preamble.bindings.map((b) => b.key), ["costs.materials", "costs.nb_total"]);
  assert.equal(preamble.bindings[0].kind, "number");
});

test("plainNested's gate reaches exactly as deep as the binding walk binds", () => {
  // The gate and the walk must agree about MAX_PROPERTY_DEPTH: a gate that gave up first would drop
  // an exportable object with no skip to say so. Walk out past the limit from both sides.
  for (let wrappers = 1; wrappers <= MAX_PROPERTY_DEPTH + 2; wrappers += 1) {
    let record: Record<string, unknown> = { nb_x: "1 m" };
    for (let level = wrappers; level >= 1; level -= 1) {
      record = { [`L${level}`]: record };
    }

    const gated = derivePreamble(record, exportRules()).bindings.map((b) => b.key);
    const ungated = derivePreamble(record, rules({ isNumbatTyped: nbLeaf, plain: PLAIN_NONE })).bindings.map((b) =>
      b.key
    );
    assert.deepEqual(gated, ungated, `nesting ${wrappers} deep`);
  }
});

test("plainNested's gate terminates on a cyclic YAML anchor", () => {
  const cyclic: Record<string, unknown> = { nb_x: "1 m" };
  cyclic.self = cyclic;

  assert.deepEqual(derivePreamble({ root: cyclic }, exportRules()).bindings.map((b) => b.key), ["root.nb_x"]);
});

// The note's own reading pairs the same nested rule with the reader's settings at the top level, so
// the gate has to ask what those settings would have bound rather than "is anything typed".
test("plainNested's gate follows the top-level rule, not just the type menu", () => {
  const numbersOff = { numbers: false, text: true, dates: true, booleans: true };
  const textOff = { numbers: true, text: false, dates: true, booleans: true };
  const keys = (record: Record<string, unknown>, plain: PlainBindings) =>
    derivePreamble(record, rules({ isNumbatTyped: nbLeaf, plain, plainNested: PLAIN_ALL })).bindings.map((b) => b.key);

  // Nothing under `meta` is typed, but a text leaf is enough where text binds — and not where it
  // does not, which is what keeps the sub-toggles meaningful.
  assert.deepEqual(keys({ meta: { author: "ara" } }, numbersOff), ["meta.author"]);
  assert.deepEqual(keys({ meta: { author: "ara" } }, textOff), []);

  // Once it binds, it binds whole: the kind toggles gate the object, never its fields.
  assert.deepEqual(keys({ meta: { revision: 3, author: "ara" } }, textOff), ["meta.revision", "meta.author"]);

  // The sub-toggles still apply in full to a top-level property.
  assert.deepEqual(keys({ weight: 80.5, note: "hi" }, numbersOff), ["note"]);
  assert.deepEqual(keys({ weight: 80.5, note: "hi" }, textOff), ["weight"]);
});

test("plainNested keeps a typed leaf's plain sibling even with that kind switched off", () => {
  // The bug this pairing exists to prevent, in the note itself: `costs.total` reads a number the
  // reader asked not to have bound *as a property*, and without the field the object breaks.
  const preamble = derivePreamble(
    { costs: { materials: 500, nb_total: "costs.materials * 1.2" } },
    rules({
      isNumbatTyped: nbLeaf,
      plain: { numbers: false, text: false, dates: false, booleans: false },
      plainNested: PLAIN_ALL,
    }),
  );

  assert.deepEqual(preamble.bindings.map((b) => b.key), ["costs.materials", "costs.nb_total"]);
});

test("without plainNested one rule applies at every depth, as it always did", () => {
  const record = { costs: { materials: 500, nb_total: "costs.materials * 1.2" } };

  // No nested rule set: PLAIN_NONE drops the plain leaf wherever it sits, and there is no gate.
  assert.deepEqual(
    derivePreamble(record, rules({ isNumbatTyped: nbLeaf, plain: PLAIN_NONE })).bindings.map((b) => b.key),
    ["costs.nb_total"],
  );
  assert.deepEqual(
    derivePreamble(record, rules({ isNumbatTyped: nbLeaf, plain: PLAIN_ALL })).bindings.map((b) => b.key),
    ["costs.materials", "costs.nb_total"],
  );
  // …and an all-plain object still binds, which is what the gate exists to prevent on export.
  assert.deepEqual(
    derivePreamble({ meta: { author: "ara" } }, rules({ plain: PLAIN_ALL })).bindings.map((b) => b.key),
    ["meta.author"],
  );
});

test("nulls, empty objects and unusable shapes contribute nothing and do not throw", () => {
  const preamble = derivePreamble(
    { empty: null, blank: {}, bad: new Date("nonsense"), fn: () => 1 },
    rules(),
  );
  assert.deepEqual(preamble.bindings, []);
  assert.deepEqual(preamble.skips, []);
});

test("an object key competes for its Numbat name like any other property", () => {
  const preamble = derivePreamble({ costs: 1, costs2: { x: 2 } }, rules());
  assert.deepEqual(preamble.bindings.map((b) => b.name), ["costs", "costs2.x"]);
  // A literal top-level name and an object key are the same namespace.
  const clash = derivePreamble({ costs: 1, "costs ": { x: 2 } }, rules({ isNumbatTyped: () => true }));
  assert.deepEqual(clash.bindings.map((b) => b.name), ["costs"]);
  assert.deepEqual(clash.skips.map((s) => [s.key, s.reason]), [["costs ", "duplicate"]]);
});

test("a reserved object key skips the whole object, once", () => {
  const preamble = derivePreamble(
    { m: { a: 1, b: 2, c: 3 } },
    rules({ isNumbatTyped: () => true, isReserved: (name) => name === "m" }),
  );
  assert.deepEqual(preamble.bindings, []);
  assert.deepEqual(preamble.skips.map((s) => [s.key, s.path, s.reason]), [["m", ["m"], "reserved"]]);
});

test("an object holding nothing bindable neither claims its name nor reports a skip", () => {
  const preamble = derivePreamble(
    { m: { empty: null }, note: null },
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
  const preamble = derivePreamble({ costs: { "!!!": 1 } }, rules({ isNumbatTyped: () => true }));
  assert.deepEqual(preamble.bindings, []);
  assert.deepEqual(preamble.skips.map((s) => [s.key, s.reason]), [["costs.!!!", "invalid-name"]]);

  // Untyped, it is a non-participant like any other plain value that cannot have a name.
  assert.deepEqual(derivePreamble({ costs: { "!!!": 1 } }, rules()).skips, []);
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

test("an untyped array binds when its items are one kind, and stays quiet when they are not", () => {
  const preamble = derivePreamble(
    { words: ["a", "b"], flags: [true, false], part: [1, "a"], deep: [1, [2]], gaps: [1, null] },
    rules(),
  );
  // A Numbat list holds one type, so only the homogeneous ones bind — and a *gap* is not a
  // disagreement: the items that are there agree, and the hole binds as undefined beside them.
  assert.deepEqual(preamble.bindings.map((b) => [b.key, b.expr, b.kind]), [
    ["words", "[\"a\", \"b\"]", "text"],
    ["flags", "[true, false]", "boolean"],
    ["gaps", `[${definedValue("1")}, ${NULLABLE_ABSENT}]`, "number"],
  ]);
  // …and the mixed ones are as quiet as any other non-participant, rather than binding a list that
  // would report Numbat's type error on a property nobody opted in.
  assert.deepEqual(preamble.skips, []);
});

test("agreement reaches inside an item, not just to its outermost shape", () => {
  const preamble = derivePreamble(
    {
      // Same field names, different field types: one generated element type cannot be both.
      rows: [{ a: 1 }, { a: "x" }],
      // …at any depth.
      deep: [{ a: { b: 1 } }, { a: { b: "x" } }],
      // Two lists agree on being lists, and disagree on what they hold.
      grid: [[1, 2], ["a"]],
      // An empty list has no element type to disagree with — but it must not launder one either.
      mixed: [[], [1], ["a"]],
      // The same shapes, agreeing all the way down, still bind.
      okRows: [{ a: 1 }, { a: 2 }],
      okGrid: [[1, 2], [3]],
      okGaps: [[], [1], [2]],
    },
    rules(),
  );

  assert.deepEqual(preamble.bindings.map((b) => b.key), ["okRows", "okGrid", "okGaps"]);
  assert.deepEqual(preamble.skips, []);
});

test("a typed array is still Numbat's to type-check, however its items disagree", () => {
  // The untyped rule above must not leak into the opted-in reading, where Numbat's own message on
  // the property beats anything guessable here.
  const preamble = derivePreamble({ rows: [{ a: 1 }, { a: "x" }] }, rules({ isNumbatTyped: () => true }));
  const [binding] = preamble.bindings;

  assert.equal(binding.key, "rows");
  assert.equal(binding.kind, "expression");
  // Typed, an item's value is Numbat *source*, so `x` is a name and not a string literal — which is
  // exactly the sort of thing the type system, and not this file, should be reporting.
  assert.match(binding.expr, /^\[_Nb_RowsStruct_\w+ \{ a: \(\(1\)\) \}, _Nb_RowsStruct_\w+ \{ a: \(\(x\)\) \}\]$/);
  assert.deepEqual(preamble.skips, []);
});

test("an untyped array reports the kind its items ultimately hold, through any nesting", () => {
  const preamble = derivePreamble({ grid: [["a"], ["b"]], nested: [[[1]], [[2]]] }, rules());
  assert.deepEqual(preamble.bindings.map((b) => [b.key, b.kind]), [["grid", "text"], ["nested", "number"]]);
});

test("no plain kinds bound suppresses untyped arrays too, empty ones included", () => {
  const preamble = derivePreamble({ weights: [70, 72], none: [] }, rules({ plain: PLAIN_NONE }));
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

// --- arrays typed at their item key (`<key>.#`) --------------------------------

test("an item type assignment makes every item an expression", () => {
  // Better Properties keys an Array's shared sub-property `<parent>.#`; the array's own key carries
  // no type at all.
  const preamble = derivePreamble({ rates: ["5 EUR", "3 EUR"] }, rules({ isNumbatTyped: (key) => key === "rates.#" }));
  assert.deepEqual(preamble.bindings.map((b) => [b.key, b.expr, b.kind]), [[
    "rates",
    "[(5 EUR), (3 EUR)]",
    "expression",
  ]]);
});

test("the item key is asked about at every level, arrays inside objects included", () => {
  const asked: string[] = [];
  derivePreamble(
    { costs: { items: [[1], 2] } },
    rules({
      isNumbatTyped: (key) => {
        asked.push(key);
        return false;
      },
    }),
  );
  assert.deepEqual(asked, ["costs.items", "costs.items.#", "costs.items.#.#"]);
});

test("a nested array can be typed at its own level alone", () => {
  const preamble = derivePreamble(
    { grid: [["5 m", "3 m"]] },
    rules({ isNumbatTyped: (key) => key === "grid.#.#" }),
  );
  assert.deepEqual(preamble.bindings.map((b) => b.expr), ["[[(5 m), (3 m)]]"]);
});

test("an array item's key resolves to the binding its list makes", () => {
  assert.equal(bindingKey("rates"), "rates");
  assert.equal(bindingKey("rates.#"), "rates");
  assert.equal(bindingKey("people.#.pace"), "people");
  assert.equal(bindingKey("costs.items.#"), "costs.items");
  assert.equal(bindingKey("costs.total"), "costs.total");
});

// --- arrays of objects ---------------------------------------------------------

test("an array of objects binds as a list of one generated struct type", () => {
  const preamble = derivePreamble(
    { legs: [{ distance: "5 km", time: "21 min" }, { distance: "10 km", time: "46 min" }] },
    rules({ isNumbatTyped: (key) => key.startsWith("legs.#.") }),
  );
  const [binding] = preamble.bindings;
  const [item] = structNames(binding.defs.join("\n"));

  assert.equal(binding.key, "legs");
  assert.equal(binding.kind, "expression");
  // One type, declared once, generic in each field — so Numbat infers the field types at the first
  // element and holds every other element to them.
  assert.deepEqual(binding.defs, [`struct ${item}<T0, T1> { distance: T0, time: T1 }`]);
  assert.equal(
    binding.expr,
    `[${item} { distance: ((5 km)), time: ((21 min)) }, ${item} { distance: ((10 km)), time: ((46 min)) }]`,
  );
  assert.equal(binding.code, `let legs = (${binding.expr})`);
  // The definition is not in `code`: a surface that evaluates `expr` and then runs `code` would
  // otherwise declare the struct twice, which Numbat rejects.
  assert.equal(binding.code.includes("struct"), false);
  assert.equal(preamble.source, `${binding.defs[0]}\n${binding.code}`);
});

test("an untyped array of objects rides along on the plain values in it", () => {
  const preamble = derivePreamble({ readings: [{ weight: 80, note: "am" }, { weight: 81, note: "pm" }] }, rules());
  const [binding] = preamble.bindings;
  const [item] = structNames(binding.defs.join("\n"));
  assert.deepEqual(binding.defs, [`struct ${item}<T0, T1> { weight: T0, note: T1 }`]);
  assert.equal(
    binding.expr,
    `[${item} { weight: (80), note: ("am") }, ${item} { weight: (81), note: ("pm") }]`,
  );

  // A field that binds nowhere is dropped from every item alike, so the elements still agree.
  const sparse = derivePreamble(
    { readings: [{ weight: 80, note: "am" }, { weight: 81, note: "pm" }] },
    rules({ plain: { ...PLAIN_NONE, numbers: true } }),
  );
  assert.equal(sparse.bindings[0].expr.includes("note"), false);
});

test("a typed field makes the whole list an expression binding", () => {
  const preamble = derivePreamble(
    { legs: [{ n: 1, pace: "5 min / 1 km" }] },
    rules({ isNumbatTyped: (key) => key === "legs.#.pace" }),
  );
  assert.equal(preamble.bindings[0].kind, "expression");
  assert.ok(preamble.bindings[0].expr.includes("pace: ((5 min / 1 km))"), preamble.bindings[0].expr);
});

test("objects nest inside array items, innermost type first", () => {
  const preamble = derivePreamble({ rows: [{ a: 1, inner: { b: 2 } }] }, rules());
  const [binding] = preamble.bindings;
  const [inner, outer] = structNames(binding.defs.join("\n"));
  // Definition order is innermost first, and each position gets exactly one type.
  assert.deepEqual(binding.defs, [
    `struct ${inner}<T0> { b: T0 }`,
    `struct ${outer}<T0, T1> { a: T0, inner: T1 }`,
  ]);
  assert.equal(binding.expr, `[${outer} { a: (1), inner: (${inner} { b: (2) }) }]`);
});

test("an array of objects inside an object is one field holding the list", () => {
  const preamble = derivePreamble({ trip: { legs: [{ km: 5 }], n: 1 } }, rules());
  const [legs, n] = preamble.bindings;
  const [item] = structNames(legs.defs.join("\n"));
  assert.equal(legs.name, "trip.legs");
  assert.ok(legs.code.endsWith(`{ legs: ([${item} { km: (5) }]) }`), legs.code);
  // The element type is declared once, with the leaf that introduces it — the later leaf reads the
  // list back off the object instead.
  assert.deepEqual(n.defs, []);
  assert.ok(n.code.includes("legs: trip.legs"), n.code);
});

test("a key one item leaves out is undefined there, not a disagreement", () => {
  // The elements still bind one type — the item that has no `b` writes it as undefined, which is
  // what it is. The field types themselves must still agree; that is the test below.
  const ragged = { people: [{ a: 1, b: 2 }, { a: 3 }] };
  const preamble = derivePreamble(ragged, rules());
  const [binding] = preamble.bindings;
  const [item] = structNames(binding.defs.join("\n"));

  assert.deepEqual(binding.defs, [`struct ${item}<T0, T1> { a: T0, b: T1 }`]);
  assert.equal(
    binding.expr,
    `[${item} { a: (1), b: (${definedValue("2")}) }, ${item} { a: (3), b: (${NULLABLE_ABSENT}) }]`,
  );
  assert.deepEqual(preamble.skips, []);
});

test("a field no item fills is dropped, rather than binding a column of undefined", () => {
  const preamble = derivePreamble({ people: [{ a: 1, b: null }, { a: 3 }] }, rules());
  const [binding] = preamble.bindings;
  const [item] = structNames(binding.defs.join("\n"));

  assert.deepEqual(binding.defs, [`struct ${item}<T0> { a: T0 }`]);
  assert.equal(binding.expr, `[${item} { a: (1) }, ${item} { a: (3) }]`);
});

test("an array of objects holding nothing at all still binds nothing", () => {
  // Every field of every item empty: there is no struct left to write, so the array is as quiet as
  // one holding nothing bindable.
  const empty = { people: [{ a: null }, { a: null }] };
  const untyped = derivePreamble(empty, rules());
  assert.deepEqual(untyped.bindings, []);
  assert.deepEqual(untyped.skips, []);

  const typed = derivePreamble(empty, rules({ isNumbatTyped: (key) => key.startsWith("people.#") }));
  assert.deepEqual(typed.bindings, []);
  assert.deepEqual(typed.skips.map((s) => [s.key, s.reason]), [["people", "unsupported"]]);
  assert.match(typed.skips[0].message, /no item holds anything Numbat can bind/);
});

test("items may write the same fields in a different order", () => {
  // Numbat constructs a struct by naming its fields, in any order — so this is one shape, not two.
  const preamble = derivePreamble({ rows: [{ a: 1, b: 2 }, { b: 3, a: 4 }] }, rules());
  const [binding] = preamble.bindings;
  const [item] = structNames(binding.defs.join("\n"));
  assert.deepEqual(binding.defs, [`struct ${item}<T0, T1> { a: T0, b: T1 }`]);
  assert.equal(binding.expr, `[${item} { a: (1), b: (2) }, ${item} { b: (3), a: (4) }]`);
});

test("an item that binds nothing at all fails the list, naming its position", () => {
  const preamble = derivePreamble(
    { rates: ["5 EUR", true] },
    rules({ isNumbatTyped: (key) => key === "rates.#" }),
  );
  assert.deepEqual(preamble.bindings, []);
  assert.match(preamble.skips[0].message, /item 2 holds nothing Numbat can bind/);
});

test("two items that disagree are reported by the field they disagree under", () => {
  // A field one item leaves out is a hole rather than a disagreement, so the only way two objects
  // can fall out is over a key they *both* have — and the message names it rather than claiming,
  // as it once could, that the field sets differ.
  const preamble = derivePreamble(
    { rows: [{ a: "1", b: "2" }, { a: ["1"], b: "3" }] },
    rules({ isNumbatTyped: (key) => key === "rows" }),
  );

  assert.deepEqual(preamble.bindings, []);
  assert.match(preamble.skips[0].message, /item 2 holds something different under 'a' than item 1 does/);
});

test("a field Numbat cannot name is dropped once for the array, not once per item", () => {
  const record = { rows: [{ type: 1, a: 2 }, { type: 3, a: 4 }] };
  const preamble = derivePreamble(record, rules({ isNumbatTyped: (key) => key === "rows.#.a" }));
  const [binding] = preamble.bindings;
  const [item] = structNames(binding.defs.join("\n"));
  // Every element drops the same key, so the elements still agree and the list still binds.
  assert.equal(binding.expr, `[${item} { a: ((2)) }, ${item} { a: ((4)) }]`);
  assert.deepEqual(preamble.skips.map((s) => [s.key, s.reason]), [["rows.#.type", "reserved"]]);

  // With nothing in the array opted into, the dropped field is as quiet as any other plain value
  // that could not have a name.
  const untyped = derivePreamble(record, rules());
  assert.equal(untyped.bindings[0].expr.includes("type"), false);
  assert.deepEqual(untyped.skips, []);
});

test("an array that binds nothing reports itself and not its insides", () => {
  const preamble = derivePreamble(
    { rows: [{ type: 1, a: 2 }, { type: 3 }] },
    rules({ isNumbatTyped: (key) => key.startsWith("rows.#") }),
  );
  assert.deepEqual(preamble.bindings, []);
  assert.deepEqual(preamble.skips.map((s) => s.key), ["rows"]);
});

test("the generated element names are namespaced, and clear of an object's own", () => {
  const one = derivePreamble({ rows: [{ a: 1 }] }, rules({ namespace: "One.md" }));
  const two = derivePreamble({ rows: [{ a: 1 }] }, rules({ namespace: "Two.md" }));
  assert.notDeepEqual(structNames(one.bindings[0].defs.join("\n")), structNames(two.bindings[0].defs.join("\n")));

  // An object and an array of the same name in different notes must not collide either.
  const object = derivePreamble({ rows: { a: 1 } }, rules({ namespace: "One.md" }));
  assert.notDeepEqual(
    structNames(one.bindings[0].defs.join("\n")),
    structNames(object.bindings[0].code),
  );
  // The label the user reads is still derived from the key.
  assert.match(one.bindings[0].defs[0], /struct _Nb_RowsStruct_[0-9a-z]+_0_0</);
});

test("a cyclic or absurdly deep array terminates instead of hanging", () => {
  const cyclic: unknown[] = [1];
  cyclic.push(cyclic);
  assert.deepEqual(derivePreamble({ root: cyclic }, rules()).bindings, []);

  let deep: unknown = 1;
  for (let i = 0; i < MAX_PROPERTY_DEPTH + 3; i += 1) {
    deep = [deep];
  }
  assert.deepEqual(derivePreamble({ root: deep }, rules()).bindings, []);
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

test("a sequence places no key of its own, and hides no key after it", () => {
  // An item shares one position with every other item, so it gets no site — but the array's own key
  // now extends over the items it opens, at either indentation YAML allows.
  assert.deepEqual(sitesOf("---\ntags:\n- alpha\n- beta\nweight: 4\n---"), [
    ["tags", 1, 0, 3],
    ["weight", 4, 0, 4],
  ]);
  assert.deepEqual(sitesOf("---\nitems:\n  - a: 1\n    b: 2\nweight: 5\n---"), [
    ["items", 1, 0, 3],
    ["weight", 4, 0, 4],
  ]);
  // A key after a sequence of mappings closes it, however deep the last item ran.
  assert.deepEqual(sitesOf("---\nlegs:\n  - a:\n      b: 1\nafter: 2\n---"), [
    ["legs", 1, 0, 3],
    ["after", 4, 0, 4],
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

const ITEMS = [
  "---",
  "rates:",
  "  - 5 EUR",
  "  - 3 EUR",
  "legs:",
  "  - distance: 5 km",
  "    time: 21 min",
  "flat:",
  "- 1 m",
  "---",
];

test("propertyValueAt names an array item under the key its type lives at", () => {
  // An item's value starts past the dash, and every item shares the one position.
  assert.deepEqual(propertyValueAt(ITEMS, 2, 4), { key: "rates.#", valueCh: 4 });
  assert.deepEqual(propertyValueAt(ITEMS, 3, 8), { key: "rates.#", valueCh: 4 });
  assert.equal(propertyValueAt(ITEMS, 2, 3), null); // on the dash
  // An item at its key's own indentation is an item all the same.
  assert.deepEqual(propertyValueAt(ITEMS, 8, 2), { key: "flat.#", valueCh: 2 });
});

test("propertyValueAt reads the fields of an array of objects", () => {
  // The key opened by the dash, and the one written under it, are the same position.
  assert.deepEqual(propertyValueAt(ITEMS, 5, 14), { key: "legs.#.distance", valueCh: 14 });
  assert.deepEqual(propertyValueAt(ITEMS, 6, 10), { key: "legs.#.time", valueCh: 10 });
  assert.equal(propertyValueAt(ITEMS, 6, 5), null); // on the key half
  // And the array's own key is still just its key, never an item's.
  assert.deepEqual(propertyValueAt(ITEMS, 4, 5), { key: "legs", valueCh: 5 });
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
