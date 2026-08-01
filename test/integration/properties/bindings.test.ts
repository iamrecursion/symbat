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
import { frontmatterHints } from "../../../src/properties/frontmatter-inlay.ts";
import { derivePreamble, type NotePreamble } from "../../../src/properties/parse.ts";
import { loadNumbat, skip } from "../wasm-pkg.ts";

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

// Mirrors properties/note.ts's replayPreamble: interpret each binding, errors absorbed.
function replay(nb: any, preamble: NotePreamble): void {
  for (const binding of preamble.bindings) {
    nb.interpret(binding.code).free();
  }
}

const plain = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ");

test("property bindings: reserved names are skipped and the rest chain in order", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = mod.Numbat.new(true, true, mod.FormatType.Html);
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
      // references an earlier one.
      { m: 5, pi: 3, rate: "40 / 1 h", n_hours: 3, cost: "rate * n_hours * 1 h" },
      {
        isNumbatTyped: (key) => key === "rate" || key === "cost",
        isReserved: (name) => reserved.has(name),
        bindNumbers: true,
      },
    );
    assert.deepEqual(preamble.skips.map((s) => [s.key, s.reason]), [["m", "reserved"], ["pi", "reserved"]]);
    assert.deepEqual(preamble.bindings.map((b) => b.name), ["rate", "n_hours", "cost"]);

    // Replay into a fresh context (the shadowing probe above polluted this one with its own `pi`).
    const fresh = mod.Numbat.new(true, true, mod.FormatType.Html);
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
  const nb = mod.Numbat.new(true, true, mod.FormatType.Html);
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
        bindNumbers: true,
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
  const nb = mod.Numbat.new(true, true, mod.FormatType.Html);
  try {
    const preamble = derivePreamble(
      { broken: "let x = 5", after: "2 + 2" },
      { isNumbatTyped: () => true, isReserved: () => false, bindNumbers: true },
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

// --- nested (object) properties ------------------------------------------------

// The empirical proof of the struct scheme: everything below drives the real interpreter with
// exactly the code derivePreamble emits, one statement per `interpret` call, the way every surface
// replays a preamble.

test("nested properties: a sibling chain resolves by its dotted name", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = mod.Numbat.new(true, true, mod.FormatType.Html);
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
      { isNumbatTyped: () => true, isReserved: () => false, bindNumbers: true, namespace: "Budget.md" },
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
  const nb = mod.Numbat.new(true, true, mod.FormatType.Html);
  try {
    const reserved = reservedSet(nb);
    const preamble = derivePreamble(
      { si: { m: 5 } },
      { isNumbatTyped: () => false, isReserved: (name) => reserved.has(name), bindNumbers: true },
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
  const nb = mod.Numbat.new(true, true, mod.FormatType.Html);
  try {
    const preamble = derivePreamble(
      { costs: { materials: "500 EUR", labor: "nope + 1", total: "costs.materials * 2" } },
      { isNumbatTyped: () => true, isReserved: () => false, bindNumbers: true },
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
  const nb = mod.Numbat.new(true, true, mod.FormatType.Html);
  try {
    const preamble = derivePreamble(
      { costs: { materials: 500, labor: 300 } },
      { isNumbatTyped: () => false, isReserved: () => false, bindNumbers: true, namespace: "Budget.md" },
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
  const nb = mod.Numbat.new(true, true, mod.FormatType.Html);
  try {
    const preamble = derivePreamble(
      { costs: { materials: 500, total: "costs.materials * 2" } },
      { isNumbatTyped: (key) => key === "costs.total", isReserved: () => false, bindNumbers: true },
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
  const nb = mod.Numbat.new(true, true, mod.FormatType.Html);
  try {
    const preamble = derivePreamble(
      { costs: { materials: 500, labor: 300, breakdown: { doubled: 12 } } },
      { isNumbatTyped: () => false, isReserved: () => false, bindNumbers: true },
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
  const nb = mod.Numbat.new(true, true, mod.FormatType.Html);
  try {
    const typed = new Set(["rates", "costs.total"]);
    const preamble = derivePreamble(
      {
        weights: [70, 72, 71],
        rates: ["5 EUR", "3 EUR"],
        costs: { items: [500, 300], total: "sum(costs.items)" },
      },
      { isNumbatTyped: (key) => typed.has(key), isReserved: () => false, bindNumbers: true },
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

test("arrays: a mixed typed list fails as a Numbat type error, not a crash", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = mod.Numbat.new(true, true, mod.FormatType.Html);
  try {
    const preamble = derivePreamble(
      { mixed: [1, "2 m"] },
      { isNumbatTyped: () => true, isReserved: () => false, bindNumbers: true },
    );
    // The derivation binds it; Numbat is what reports the problem, on the property.
    assert.deepEqual(preamble.bindings.map((b) => b.expr), ["[(1), (2 m)]"]);
    const result = inlineResultFor(runnerFor(nb), preamble.bindings[0].expr);
    assert.equal(result.kind, "error");
  } finally {
    nb.free();
  }
});
