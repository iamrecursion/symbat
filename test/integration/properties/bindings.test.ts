// Pins the real Numbat wasm behavior the note-property bindings rely on:
//
//   * the reserved-name set (built exactly as primeReservedNames does, from the `list …` commands)
//     contains the names whose shadowing is the hazard — units like `m`/`hours`, which Numbat
//     itself rejects with an identifier clash, and prelude *variables* like `pi`, which Numbat lets
//     a `let` silently shadow (`2 pi` would become 6);
//   * a skipped property therefore leaves the prelude intact (`5 m` stays a length), while the
//     surviving bindings replay in frontmatter order so a later property (and everything after the
//     preamble) sees an earlier one;
//   * a botched binding (a statement in the value) errors, is absorbed, and the bindings after it
//     still land — the replay resilience every surface and the property widget assume.
//
// Requires the wasm to be built; self-skips otherwise.

import assert from "node:assert/strict";
import { test } from "node:test";
import { signatureFromTypeOutput } from "../../../src/completion/docs.ts";
import { parseListNames, structFieldNames } from "../../../src/completion/expressions.ts";
import { plainText } from "../../../src/evaluation/inlay-parse.ts";
import { inlineResultFor } from "../../../src/evaluation/inline-parse.ts";
import { readableNullables } from "../../../src/interpreter/nullable-display.ts";
import { NULLABLE_NAMES, NULLABLE_STRUCT } from "../../../src/interpreter/nullable.ts";
import { frontmatterHints } from "../../../src/properties/frontmatter-inlay.ts";
import { derivePreamble, type NotePreamble, PLAIN_ALL } from "../../../src/properties/parse.ts";
import { loadNumbat, newContext, skip } from "../wasm-pkg.ts";

// The LineInterpret shape over a live wasm context.
function runnerFor(nb: any) {
  return (code: string) => {
    const out = nb.interpret(code);
    const result = { output: out.output as string, isError: out.is_error as boolean };
    out.free();
    return result;
  };
}

// Mirrors properties/note.ts's primeReservedNames: the union of the four `list …` vocabularies of a
// prelude context.
function reservedSet(nb: any): Set<string> {
  const names: string[] = [];
  for (const what of ["functions", "units", "variables", "dimensions"]) {
    const command = nb.try_run_command(`list ${what}`);
    names.push(...parseListNames(command.output as string));
    command.free();
  }
  return new Set(names);
}

// Mirrors properties/note.ts's replayPreamble: each binding's own definitions, then its statement,
// errors absorbed.
function replay(nb: any, preamble: NotePreamble): void {
  for (const binding of preamble.bindings) {
    for (const def of binding.defs) {
      nb.interpret(def).free();
    }
    nb.interpret(binding.code).free();
  }
}

const plain = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ");

// The generated struct names carry a hash, so assertions read them back rather than hard-code one.
const structNamesIn = (code: string): string[] => [...code.matchAll(/struct (\w+)</g)].map((m) => m[1]);

test("property bindings: reserved names are skipped and the rest chain in order", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    const reserved = reservedSet(nb);
    // The two shadowing hazards the skip exists for: unit names (Numbat rejects the let itself — an
    // identifier clash) and prelude variables (Numbat lets the let silently shadow: `let pi = 3`
    // would turn `2 pi` into 6).
    for (const name of ["m", "hours", "pi", "e"]) {
      assert.ok(reserved.has(name), `expected '${name}' in the reserved set`);
    }
    assert.equal(runnerFor(nb)("let m = 5").isError, true, "the unit clash the skip pre-empts");
    assert.equal(runnerFor(nb)("let pi = 3").isError, false, "the silent variable shadowing the skip prevents");

    const preamble = derivePreamble(
      // `m` (reserved unit), `pi` (reserved variable), then a chain where a later property
      // references an earlier one. Both clashing keys are typed, because only a property that opted
      // in is owed the reason it did not reach the scope.
      { m: 5, pi: 3, rate: "40 / 1 h", n_hours: 3, cost: "rate * n_hours * 1 h" },
      {
        isNumbatTyped: (key) => key === "rate" || key === "cost" || key === "m" || key === "pi",
        isReserved: (name) => reserved.has(name),
        plain: PLAIN_ALL,
      },
    );
    assert.deepEqual(preamble.skips.map((s) => [s.key, s.reason]), [["m", "reserved"], ["pi", "reserved"]]);
    assert.deepEqual(preamble.bindings.map((b) => b.name), ["rate", "n_hours", "cost"]);

    // Replay into a fresh context (the shadowing probe above polluted this one with its own `pi`).
    const fresh = newContext(mod);
    try {
      replay(fresh, preamble);
      const run = runnerFor(fresh);
      // The chain landed: `cost` saw `rate` and `n_hours`.
      const cost = inlineResultFor(run, "cost");
      assert.equal(cost.kind, "value");
      assert.equal(cost.plain, "120");
      // The skipped properties left the prelude untouched.
      const length = inlineResultFor(run, "5 m");
      assert.equal(length.kind === "value" && plain(length.valueHtml ?? "").includes("m"), true);
      const twoPi = inlineResultFor(run, "2 pi");
      assert.equal(twoPi.plain?.startsWith("6.28"), true, "pi still is π");
    } finally {
      fresh.free();
    }
  } finally {
    nb.free();
  }
});

test("frontmatter inlays: results chain, plain numbers are suppressed, holes/errors surface", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    const preamble = derivePreamble(
      {
        total: "e * 278", // a computed value → a result inlay
        weight: 80.5, // an untyped plain number → suppressed (it restates itself)
        doubled: "total * 2", // chains on `total` → a result inlay
        incomplete: "3 m +", // an incomplete expression → a typed-hole inlay
        bad: "abs(-5", // a broken expression → an error inlay
      },
      {
        isNumbatTyped: (key) => key !== "weight",
        isReserved: () => false,
        plain: PLAIN_ALL,
      },
    );
    const hints = frontmatterHints(runnerFor(nb), preamble);
    const byKey = new Map(hints.map((h) => [h.key, h]));

    // The plain number restates its source, so it gets no inlay.
    assert.equal(byKey.has("weight"), false);

    assert.equal(byKey.get("total")?.kind, "result");
    assert.equal(plain(byKey.get("total")?.content ?? "").includes("755"), true);
    // The chain saw the earlier binding (total * 2 ≈ 1511).
    assert.equal(byKey.get("doubled")?.kind, "result");
    assert.equal(plain(byKey.get("doubled")?.content ?? "").includes("1511"), true);

    assert.equal(byKey.get("incomplete")?.kind, "hole");
    assert.equal(byKey.get("incomplete")?.content, "Length");

    assert.equal(byKey.get("bad")?.kind, "error");
    assert.equal((byKey.get("bad")?.content ?? "").length > 0, true);
  } finally {
    nb.free();
  }
});

test("property bindings: a botched binding is absorbed and later ones still land", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    const preamble = derivePreamble(
      { broken: "let x = 5", after: "2 + 2" },
      { isNumbatTyped: () => true, isReserved: () => false, plain: PLAIN_ALL },
    );
    assert.equal(preamble.bindings.length, 2);
    // The statement-in-expression binding parses to an error…
    assert.equal(runnerFor(nb)(preamble.bindings[0].code).isError, true);
    // …and the widget-style probe of the binding after it still works.
    nb.interpret(preamble.bindings[1].code).free();
    const after = inlineResultFor(runnerFor(nb), "after");
    assert.equal(after.kind, "value");
    assert.equal(after.plain, "4");
  } finally {
    nb.free();
  }
});

// --- text, dates and booleans --------------------------------------------------

test("plain values: text, dates and booleans bind as the Numbat types they are", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    const preamble = derivePreamble(
      {
        title: "Kyoto trip",
        booked: true,
        due: new Date("2026-07-27T00:00:00Z"),
        starts: new Date("2026-07-27T10:30:00Z"),
        words: ["one", "two"],
      },
      {
        isNumbatTyped: () => false,
        isReserved: () => false,
        plain: PLAIN_ALL,
        // A date binds as one only under a property explicitly assigned Obsidian's Date type.
        assignedType: (key) => key === "due" || key === "starts" ? "date" : null,
      },
    );
    replay(nb, preamble);
    const run = runnerFor(nb);

    assert.equal(plain(inlineResultFor(run, "str_length(title)").valueHtml ?? ""), "10");
    assert.equal(inlineResultFor(run, "if booked then 1 else 2").plain, "1");
    // Numbat's date arithmetic applies, which is the whole point of binding these as DateTimes.
    assert.equal(plain(inlineResultFor(run, "(starts - due) -> minutes").valueHtml ?? ""), "630 min");
    assert.equal(inlineResultFor(run, "len(words)").plain, "2");
    // Each carries its own type, so the note's scope sees them as what they are.
    for (const [expr, type] of [["title", "String"], ["booked", "Bool"], ["due", "DateTime"]]) {
      assert.equal(plain(signatureFromTypeOutput(run(`type(${expr})`).output) ?? ""), type);
    }
  } finally {
    nb.free();
  }
});

test("plain values: a brace in prose is escaped, not interpolated", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    // Unescaped, `{rate}` would be evaluated by Numbat's string interpolation — against a name the
    // note may not even have. The property is prose; nothing in it may run.
    const prose = "cost {rate} each, 50% \"off\", C:\\tmp";
    const preamble = derivePreamble(
      { note: prose },
      { isNumbatTyped: () => false, isReserved: () => false, plain: PLAIN_ALL },
    );
    replay(nb, preamble);
    const run = runnerFor(nb);

    const value = inlineResultFor(run, "note");
    assert.equal(value.kind, "value");
    assert.equal(plain(value.valueHtml ?? "").includes("{rate}"), true, plain(value.valueHtml ?? ""));
    // Round-tripped exactly: Numbat counts a string's length in UTF-8 bytes, and this is all ASCII.
    assert.equal(inlineResultFor(run, "str_length(note)").plain, String(prose.length));
  } finally {
    nb.free();
  }
});

// --- nested (object) properties ------------------------------------------------

// The empirical proof of the struct scheme: everything below drives the real interpreter with
// exactly the code derivePreamble emits, one statement per `interpret` call, the way every surface
// replays a preamble.

test("nested properties: a sibling chain resolves by its dotted name", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    const preamble = derivePreamble(
      {
        costs: {
          materials: "500 EUR",
          labor: "300 EUR",
          total: "costs.materials + costs.labor",
          breakdown: { doubled: "costs.total * 2" },
        },
      },
      { isNumbatTyped: () => true, isReserved: () => false, plain: PLAIN_ALL, namespace: "Budget.md" },
    );
    assert.deepEqual(preamble.bindings.map((b) => b.name), [
      "costs.materials",
      "costs.labor",
      "costs.total",
      "costs.breakdown.doubled",
    ]);
    replay(nb, preamble);
    const run = runnerFor(nb);
    assert.equal(plain(inlineResultFor(run, "costs.total").valueHtml ?? ""), "800 €");
    assert.equal(plain(inlineResultFor(run, "costs.breakdown.doubled").valueHtml ?? ""), "1600 €");
    // The object itself is a value, and a later expression sees it.
    assert.equal(plain(inlineResultFor(run, "costs.materials + 1 EUR").valueHtml ?? ""), "501 €");
  } finally {
    nb.free();
  }
});

test("nested properties: a field may shadow a unit name", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    const reserved = reservedSet(nb);
    const preamble = derivePreamble(
      { si: { m: 5 } },
      { isNumbatTyped: () => false, isReserved: (name) => reserved.has(name), plain: PLAIN_ALL },
    );
    assert.deepEqual(preamble.bindings.map((b) => b.name), ["si.m"]);
    replay(nb, preamble);
    const run = runnerFor(nb);
    assert.equal(inlineResultFor(run, "si.m").plain, "5");
    // `m` is still the unit — struct fields live in their own namespace.
    assert.ok(plain(inlineResultFor(run, "5 m").valueHtml ?? "").includes("m"));
  } finally {
    nb.free();
  }
});

test("nested properties: a broken leaf freezes the object, not its siblings", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    const preamble = derivePreamble(
      { costs: { materials: "500 EUR", labor: "nope + 1", total: "costs.materials * 2" } },
      { isNumbatTyped: () => true, isReserved: () => false, plain: PLAIN_ALL },
    );
    replay(nb, preamble);
    const run = runnerFor(nb);
    // Each leaf still evaluates its own RHS — which is what the property widget, the inlays and the
    // inspector show.
    assert.equal(inlineResultFor(run, preamble.bindings[1].expr).kind, "error");
    assert.equal(plain(inlineResultFor(run, preamble.bindings[2].expr).valueHtml ?? ""), "1000 €");
    // But the object froze at the last field that landed: `total` never got in.
    assert.equal(inlineResultFor(run, "costs.total").kind, "error");
    assert.equal(plain(inlineResultFor(run, "costs.materials").valueHtml ?? ""), "500 €");
  } finally {
    nb.free();
  }
});

test("nested properties: the struct type reads as a name derived from the key", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    const preamble = derivePreamble(
      { costs: { materials: 500, labor: 300 } },
      { isNumbatTyped: () => false, isReserved: () => false, plain: PLAIN_ALL, namespace: "Budget.md" },
    );
    replay(nb, preamble);
    // The raw interpreter prints the generated type name in front of every struct value;
    // interpreter/numbat.ts rewrites it to the label the name carries. Pin both halves: the raw
    // shape, and that the rewrite leaves a readable type and nothing else.
    const raw = nb.interpret("costs");
    const text = plain(raw.output as string);
    raw.free();
    assert.match(text, /_Nb_CostsStruct_[0-9a-z]+_\d+_\d+/);
    const readable = text.replace(/_Nb_([A-Za-z0-9]+)_[0-9a-z]+_\d+_\d+/g, "$1");
    assert.equal(readable.includes("_Nb"), false);
    assert.match(readable, /CostsStruct \{ ?materials: 500, labor: 300 ?\}/);
  } finally {
    nb.free();
  }
});

test("nested properties: frontmatter hints are keyed by the dotted path", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    const preamble = derivePreamble(
      { costs: { materials: 500, total: "costs.materials * 2" } },
      { isNumbatTyped: (key) => key === "costs.total", isReserved: () => false, plain: PLAIN_ALL },
    );
    const hints = frontmatterHints(runnerFor(nb), preamble);
    // The plain number repeats its own source, so it contributes no hint; the expression does,
    // under its dotted key.
    assert.deepEqual(hints.map((h) => [h.key, h.kind]), [["costs.total", "result"]]);
    assert.equal(plain(hints[0].content), "= 1000");
  } finally {
    nb.free();
  }
});

test("member completion: a struct's fields come out of the missing-field error", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    const preamble = derivePreamble(
      { costs: { materials: 500, labor: 300, breakdown: { doubled: 12 } } },
      { isNumbatTyped: () => false, isReserved: () => false, plain: PLAIN_ALL },
    );
    replay(nb, preamble);
    const run = runnerFor(nb);
    // Mirrors interpreter/numbat.ts's `structFields`.
    const fields = (base: string): string[] => {
      const result = run(`${base}._numbat_member_probe`);
      return result.isError ? structFieldNames(plainText(result.output)) : [];
    };
    assert.deepEqual(fields("costs"), ["materials", "labor", "breakdown"]);
    assert.deepEqual(fields("costs.breakdown"), ["doubled"]);
    assert.deepEqual(fields("pi"), []); // not a struct
    assert.deepEqual(fields("no_such_name"), []);
    // And each field types through its whole path, which is what the row shows.
    assert.equal(plain(signatureFromTypeOutput(run("type(costs.materials)").output) ?? ""), "Scalar");
  } finally {
    nb.free();
  }
});

test("arrays: a list binds, survives the rebuild, and carries its dimension", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    const typed = new Set(["rates", "costs.total"]);
    const preamble = derivePreamble(
      {
        weights: [70, 72, 71],
        rates: ["5 EUR", "3 EUR"],
        costs: { items: [500, 300], total: "sum(costs.items)" },
      },
      { isNumbatTyped: (key) => typed.has(key), isReserved: () => false, plain: PLAIN_ALL },
    );
    assert.deepEqual(preamble.bindings.map((b) => b.name), ["weights", "rates", "costs.items", "costs.total"]);
    replay(nb, preamble);
    const run = runnerFor(nb);
    // Numbat's own list vocabulary works on a bound array.
    assert.equal(inlineResultFor(run, "sum(weights)").plain, "213");
    assert.equal(inlineResultFor(run, "mean(weights)").plain, "71");
    assert.equal(inlineResultFor(run, "len(weights)").plain, "3");
    assert.equal(inlineResultFor(run, "element_at(1, weights)").plain, "72");
    // A typed array's items are expressions, so the list carries their dimension.
    assert.equal(plain(inlineResultFor(run, "sum(rates)").valueHtml ?? ""), "8 €");
    // The proof that matters: a list survives being read back off the object as the struct is
    // rebuilt, so a sibling can compute from it.
    assert.equal(inlineResultFor(run, "costs.total").plain, "800");
  } finally {
    nb.free();
  }
});

test("arrays of objects: one element type, and Numbat's list vocabulary over it", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    const preamble = derivePreamble(
      {
        legs: [
          { distance: "5 km", time: "21 min" },
          { distance: "10 km", time: "46 min" },
        ],
      },
      {
        // Better Properties types an Array's items once, at the shared `<parent>.#` sub-property.
        isNumbatTyped: (key) => key.startsWith("legs.#."),
        isReserved: () => false,
        plain: PLAIN_ALL,
        namespace: "Run.md",
      },
    );

    const [binding] = preamble.bindings;
    assert.equal(binding.key, "legs");
    assert.equal(binding.defs.length, 1, "one element type, declared once");

    replay(nb, preamble);
    const run = runnerFor(nb);
    assert.equal(inlineResultFor(run, "len(legs)").plain, "2");
    // A field reads through an element, and — the point of a *homogeneous* list — a function over
    // the element type maps across the whole of it.
    assert.equal(plain(inlineResultFor(run, "element_at(0, legs).distance").valueHtml ?? ""), "5 km");

    // The generated name is not something a user would type, so the mapping function is declared
    // against the name the derivation actually minted.
    const [item] = structNamesIn(binding.defs[0]);
    const paced = run(`fn pace_of<T0, T1>(l: ${item}<T0, T1>) -> T1 / T0 = l.time / l.distance`);
    assert.equal(paced.isError, false, paced.output);
    assert.equal(plain(inlineResultFor(run, "map(pace_of, legs)").valueHtml ?? "").includes("4.2"), true);

    // The type reads back as the label the name carries, like every other generated struct.
    const raw = nb.interpret("legs");
    const text = plain(raw.output as string);
    raw.free();
    assert.match(text, /_Nb_LegsStruct_[0-9a-z]+_0_0/);
    assert.equal(text.replace(/_Nb_([A-Za-z0-9]+)_[0-9a-z]+_\d+_\d+/g, "$1").includes("_Nb"), false);
  } finally {
    nb.free();
  }
});

test("arrays of objects: items that disagree dimensionally are Numbat's error", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    // Same fields, incompatible dimensions — the derivation binds it and the type system is what
    // reports the problem, on the property, which is exactly the guarantee an Array makes.
    const preamble = derivePreamble(
      { legs: [{ distance: "5 km" }, { distance: "10 s" }] },
      { isNumbatTyped: () => true, isReserved: () => false, plain: PLAIN_ALL },
    );
    const [binding] = preamble.bindings;
    assert.equal(runnerFor(nb)(binding.defs[0]).isError, false);
    assert.equal(inlineResultFor(runnerFor(nb), binding.expr).kind, "error");
  } finally {
    nb.free();
  }
});

test("untyped arrays: what binds type-checks, and what would not stays out", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    // The untyped promise is that a property nobody opted in never volunteers an error — which is a
    // claim about Numbat's type system, so the real interpreter is the only place to test it. Each
    // of these disagrees somewhere Numbat can see and the derivation cannot unless it looks all the
    // way down: a shared element type's field, and a nested list's elements.
    const rules = { isNumbatTyped: () => false, isReserved: () => false, plain: PLAIN_ALL };
    for (const value of [[{ a: 1 }, { a: "x" }], [[1, 2], ["a"]], [[], [1], ["a"]]]) {
      assert.deepEqual(derivePreamble({ rows: value }, rules).bindings, [], JSON.stringify(value));
    }

    // And what does bind is replayed into a live interpreter without a single error.
    const preamble = derivePreamble(
      { rows: [{ a: 1, b: "x" }, { b: "y", a: 2 }], grid: [[1, 2], []], flags: [true, false] },
      rules,
    );
    assert.deepEqual(preamble.bindings.map((b) => b.key), ["rows", "grid", "flags"]);

    const run = runnerFor(nb);
    for (const binding of preamble.bindings) {
      for (const def of binding.defs) {
        assert.equal(run(def).isError, false, def);
      }
      assert.equal(run(binding.code).isError, false, binding.code);
    }
    assert.equal(inlineResultFor(run, "element_at(0, rows).b").plain, "\"x\"");
    assert.equal(inlineResultFor(run, "len(grid)").plain, "2");
  } finally {
    nb.free();
  }
});

test("arrays of objects: the inlay evaluates the list without redeclaring its type", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    // frontmatterHints runs each binding's defs, evaluates `expr`, then runs `code`. That order is
    // why the definitions are kept out of `code`: declaring a struct twice is a hard error, so a
    // binding that carried them in both would show its own type's redefinition as the property's
    // result.
    const preamble = derivePreamble(
      { rows: [{ cost: "5 EUR" }, { cost: "3 EUR" }], after: "2 + 2" },
      { isNumbatTyped: () => true, isReserved: () => false, plain: PLAIN_ALL },
    );

    const run = runnerFor(nb);
    const hints = frontmatterHints(run, preamble);
    assert.deepEqual(hints.map((h) => [h.key, h.kind]), [["rows", "result"], ["after", "result"]]);
    assert.equal(plain(hints[0].content).includes("5 €"), true);

    // …and the statement landed after its expression was shown, so the list is in scope for the
    // rest of the note.
    assert.equal(plain(inlineResultFor(run, "element_at(1, rows).cost").valueHtml ?? ""), "3 €");
  } finally {
    nb.free();
  }
});

test("arrays: a mixed typed list fails as a Numbat type error, not a crash", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    const preamble = derivePreamble(
      { mixed: [1, "2 m"] },
      { isNumbatTyped: () => true, isReserved: () => false, plain: PLAIN_ALL },
    );
    // The derivation binds it; Numbat is what reports the problem, on the property.
    assert.deepEqual(preamble.bindings.map((b) => b.expr), ["[(1), (2 m)]"]);
    const result = inlineResultFor(runnerFor(nb), preamble.bindings[0].expr);
    assert.equal(result.kind, "error");
  } finally {
    nb.free();
  }
});

test("undefined values: a list with a hole in it binds, types and reads back", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    // The case the whole feature exists for: without the hole the array bound nothing at all, and
    // one blank item cost the reader the other nine.
    const preamble = derivePreamble(
      { weights: [70, null, 72] },
      { isNumbatTyped: () => false, isReserved: () => false, plain: PLAIN_ALL },
    );
    const [binding] = preamble.bindings;
    assert.deepEqual(preamble.skips, []);

    const run = runnerFor(nb);
    assert.equal(run(binding.code).isError, false, binding.code);

    assert.equal(inlineResultFor(run, "len(weights)").plain, "3");
    assert.equal(inlineResultFor(run, "get(element_at(0, weights))").plain, "70");
    assert.equal(inlineResultFor(run, "is_undefined(element_at(1, weights))").plain, "true");
    assert.equal(inlineResultFor(run, "get_or(element_at(1, weights), 0)").plain, "0");

    // The type Numbat infers is one element type with a nullable in it, which is what makes the
    // list hold a hole at all.
    assert.match(plain(run("weights").output), new RegExp(`List&lt;${NULLABLE_STRUCT}&lt;Scalar&gt;&gt;`));
  } finally {
    nb.free();
  }
});

test("undefined values: an array of objects binds around an empty field and a missing key", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    const preamble = derivePreamble(
      // `pace` is written empty in the second item and left out of the third: the same thing to a
      // reader, and now the same thing to the derivation.
      { legs: [{ distance: "5 km", pace: "5 min / 1 km" }, { distance: "10 km", pace: null }, { distance: "2 km" }] },
      { isNumbatTyped: (key) => key.startsWith("legs.#"), isReserved: () => false, plain: PLAIN_ALL },
    );
    const [binding] = preamble.bindings;
    assert.deepEqual(preamble.skips, []);

    const run = runnerFor(nb);
    for (const def of binding.defs) {
      assert.equal(run(def).isError, false, def);
    }
    assert.equal(run(binding.code).isError, false, binding.code);

    assert.equal(inlineResultFor(run, "len(legs)").plain, "3");
    assert.equal(plain(inlineResultFor(run, "element_at(1, legs).distance").valueHtml ?? ""), "10 km");
    assert.equal(inlineResultFor(run, "is_defined(element_at(0, legs).pace)").plain, "true");
    assert.equal(inlineResultFor(run, "is_undefined(element_at(1, legs).pace)").plain, "true");
    assert.equal(inlineResultFor(run, "is_undefined(element_at(2, legs).pace)").plain, "true");
  } finally {
    nb.free();
  }
});

test("undefined values: a hole nested inside a list still binds one element type", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    // The decision to write a position as a nullable is made once every sibling *at that depth* has
    // been seen, so `2` and `3` are nullable because a hole appeared beside `1`.
    const preamble = derivePreamble(
      { grid: [[1, null], [2, 3]] },
      { isNumbatTyped: () => false, isReserved: () => false, plain: PLAIN_ALL },
    );
    const run = runnerFor(nb);
    assert.equal(run(preamble.bindings[0].code).isError, false, preamble.bindings[0].code);

    assert.equal(inlineResultFor(run, "get(element_at(0, element_at(1, grid)))").plain, "2");
    assert.equal(inlineResultFor(run, "is_undefined(element_at(1, element_at(0, grid)))").plain, "true");
  } finally {
    nb.free();
  }
});

test("undefined values: a typed property left empty binds undefined instead of a skip", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    const preamble = derivePreamble(
      { budget: "", spent: "20 EUR" },
      { isNumbatTyped: () => true, isReserved: () => false, plain: PLAIN_ALL },
    );
    assert.deepEqual(preamble.skips, []);

    const run = runnerFor(nb);
    replay(nb, preamble);
    assert.equal(inlineResultFor(run, "is_undefined(budget)").plain, "true");
    assert.equal(plain(inlineResultFor(run, "get_or(budget, spent)").valueHtml ?? ""), "20 €");
  } finally {
    nb.free();
  }
});

test("undefined values: the utilities are reserved names, like any other prelude name", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    // The cost of putting `get` and friends into every context: a property that wants one of those
    // names is skipped, exactly as one named `pi` is. Pinned rather than assumed, since the names
    // are the roadmap's and the skip is what a reader would see.
    const reserved = reservedSet(nb);
    for (const name of NULLABLE_NAMES) {
      assert.ok(reserved.has(name), `expected '${name}' in the reserved set`);
    }

    // The type name is *not* one of them: the set is built from functions, units, variables and
    // dimensions, so a property called `Opt` costs the reader nothing.
    assert.equal(reserved.has(NULLABLE_STRUCT), false);

    const preamble = derivePreamble({ get: "5" }, {
      isNumbatTyped: () => true,
      isReserved: (name) => reserved.has(name),
      plain: PLAIN_ALL,
    });
    assert.deepEqual(preamble.bindings, []);
    assert.deepEqual(preamble.skips.map((s) => [s.key, s.reason]), [["get", "reserved"]]);
  } finally {
    nb.free();
  }
});

test("undefined values: what the reader sees is `nil` and `Opt<T>`", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    // The display rewrite over *real* formatter output rather than a hand-written fixture — the one
    // place the span matching meets what Numbat actually emits.
    const preamble = derivePreamble(
      { weights: [70, null] },
      { isNumbatTyped: () => false, isReserved: () => false, plain: PLAIN_ALL },
    );
    const run = runnerFor(nb);
    assert.equal(run(preamble.bindings[0].code).isError, false);

    const shown = plain(readableNullables(run("weights").output));
    assert.match(shown, /\[70, nil\]/);

    // The type survives the rewrite untouched, because it is the one the reader would write.
    assert.match(shown, new RegExp(`List&lt;${NULLABLE_STRUCT}&lt;Scalar&gt;&gt;`));
    assert.equal(shown.includes("value"), false, shown);
  } finally {
    nb.free();
  }
});

test("undefined values: one empty field does not cost the object its other fields", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    // The reported failure: an object with a Numbat-typed property left empty. The hole had nothing
    // to say what it held, so the generated struct stayed polymorphic — and Numbat cannot solve
    // `HasField` against a polymorphic struct, so *every* field of `Test` became unreadable, not
    // just the empty one. `Test.Date` reported a constraint failure naming a type nobody wrote.
    const preamble = derivePreamble(
      { Test: { Cond: true, Str: "hi", Date: new Date("2022-02-02T00:00:00Z"), Foo: null } },
      { isNumbatTyped: (key) => key === "Test.Foo", isReserved: () => false, plain: PLAIN_ALL },
    );

    // The hole is dropped rather than typed on a guess: nothing anywhere says what it holds.
    assert.deepEqual(preamble.bindings.map((b) => b.name), ["Test.Cond", "Test.Str", "Test.Date"]);

    const run = runnerFor(nb);
    replay(nb, preamble);

    // Every sibling reads back, which is the whole point.
    assert.equal(inlineResultFor(run, "Test.Cond").plain, "true");
    assert.equal(inlineResultFor(run, "Test.Str").plain, "\"hi\"");
    assert.equal(inlineResultFor(run, "Test.Date").kind, "value");

    // The empty one is simply not there — the same answer an array gives a field no item fills.
    assert.equal(inlineResultFor(run, "Test.Foo").kind, "error");
  } finally {
    nb.free();
  }
});

test("undefined values: a field that says nothing does not cost an array element its others", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    // The same failure as the test above, one level along: an array element is a generated struct
    // too, so a field holding nothing but emptiness leaves *its* type polymorphic and takes every
    // other field of every item with it — `element_at(0, legs).weight` failed on a property that
    // looked perfectly bound, and `legs` itself still printed, so nothing said why.
    //
    // Three ways for a field to say nothing, all dropped alike: a list of holes, an empty list, and
    // a key every item leaves empty.
    const preamble = derivePreamble(
      { legs: [{ weight: "80 kg", marks: [null, null], splits: [], note: null }] },
      { isNumbatTyped: (key) => key.startsWith("legs.#"), isReserved: () => false, plain: PLAIN_ALL },
    );
    const [binding] = preamble.bindings;
    assert.equal(binding.defs.length, 1, binding.defs.join("\n"));
    assert.ok(binding.defs[0].endsWith("<T0> { weight: T0 }"), binding.defs[0]);

    const run = runnerFor(nb);
    replay(nb, preamble);

    // The point: the filled field reads back.
    assert.equal(plain(inlineResultFor(run, "element_at(0, legs).weight").valueHtml ?? ""), "80 kg");
    for (const gone of ["marks", "splits", "note"]) {
      assert.equal(inlineResultFor(run, `element_at(0, legs).${gone}`).kind, "error", gone);
    }

    // One filled item is all it takes for the position to have something to say, and then the gaps
    // beside it stay as gaps rather than costing the field its place. Under its own key, since a
    // second `legs` would redeclare that element type — which Numbat refuses.
    const filled = derivePreamble(
      { hikes: [{ weight: "80 kg", marks: [1, null] }] },
      { isNumbatTyped: (key) => key.startsWith("hikes.#"), isReserved: () => false, plain: PLAIN_ALL },
    );
    replay(nb, filled);
    assert.equal(inlineResultFor(run, "get_or(element_at(0, element_at(0, hikes).marks), 9)").plain, "1");
    assert.equal(inlineResultFor(run, "get_or(element_at(1, element_at(0, hikes).marks), 9)").plain, "9");
  } finally {
    nb.free();
  }
});

test("undefined values: an empty date or number property still binds inside an object", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = newContext(mod);
  try {
    // The distinction the drop above turns on: a *numbat*-typed menu says nothing about the value's
    // type, but number/text/date/datetime name it outright — so an empty one of those is a hole
    // of a known type and keeps its place. Pinned against the real interpreter because the type
    // has to ride on the value: Numbat expands a declared struct field of a generic type without
    // substituting into it, and rejects the very value that matches it.
    const preamble = derivePreamble(
      { Trip: { leaves: null, cost: null, note: null, n: 2 } },
      {
        isNumbatTyped: () => false,
        isReserved: () => false,
        assignedType: (key) =>
          key === "Trip.leaves" ? "datetime" : key === "Trip.cost" ? "number" : key === "Trip.note" ? "text" : null,
        plain: PLAIN_ALL,
      },
    );
    assert.deepEqual(preamble.bindings.map((b) => b.name), ["Trip.leaves", "Trip.cost", "Trip.note", "Trip.n"]);

    const run = runnerFor(nb);
    replay(nb, preamble);

    // Every field reads, holes and siblings alike, and each hole is a hole of its declared type.
    assert.equal(inlineResultFor(run, "Trip.n").plain, "2");
    assert.equal(inlineResultFor(run, "is_undefined(Trip.leaves)").plain, "true");
    assert.equal(inlineResultFor(run, "get_or(Trip.cost, 5)").plain, "5");
    assert.equal(inlineResultFor(run, "get_or(Trip.note, \"n/a\")").plain, "\"n/a\"");
    assert.match(plain(run("type(get_or(Trip.leaves, now()))").output), /DateTime/);
  } finally {
    nb.free();
  }
});
