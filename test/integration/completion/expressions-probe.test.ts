// Drives the real Numbat wasm to confirm the `list` commands' markup format and the end-to-end
// expression-completion categorization (parse → classify → filter) against the actual standard
// library. Self-skips when the wasm is not built, like the sibling interpret suite.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowedCategoriesAt,
  boundCompletions,
  BUILTIN_TYPE_NAMES,
  classifyCompletion,
  type CompletionVocabulary,
  expressionCompletions,
  isTypePosition,
  parseListNames,
  pluginTypeCandidates,
  typeVariableCompletions,
} from "../../../src/completion/expressions.ts";
import { NULLABLE_PRELUDE, NULLABLE_STRUCT } from "../../../src/interpreter/nullable.ts";
import { loadNumbat, skip } from "../wasm-pkg.ts";

/** Build the vocabulary from the four `list` commands, as interpreter/numbat.ts does. */
function buildVocab(nb: any): CompletionVocabulary {
  const list = (what: string): string[] => {
    const cmd = nb.try_run_command(`list ${what}`);
    const names = parseListNames(cmd.output);
    cmd.free();
    return names;
  };
  return {
    functions: new Set(list("functions")),
    units: new Set(list("units")),
    variables: new Set(list("variables")),
    dimensions: new Set(list("dimensions")),
  };
}

const ALL = { identifiers: true, keywords: true, units: true, dimensions: true, types: true };

test("real `list` output categorizes as expected", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  const vocab = buildVocab(nb);

  // The standard names land in the right buckets, kept distinct.
  assert.ok(vocab.dimensions.has("Length") && vocab.dimensions.has("Time"), "Length/Time are dimensions");
  assert.ok(vocab.units.has("meter") || vocab.units.has("metre"), "meter is a unit");
  assert.ok(vocab.variables.has("pi"), "pi is a variable");
  assert.ok(vocab.functions.has("sin"), "sin is a function");
  // Functions and variables must not be conflated, and dimensions must not leak.
  assert.ok(!vocab.variables.has("sin"), "sin is not a variable");
  assert.ok(!vocab.functions.has("pi"), "pi is not a function");
  assert.ok(!vocab.units.has("Length") && !vocab.functions.has("Length"));

  const complete = (query: string) => {
    const raw = (nb.get_completions_for(query) as unknown[]).map((v) => String(v));
    return expressionCompletions(raw, vocab, ALL);
  };

  // Distinct categories from real data: meter→unit, sin→function, pi→variable, Length→dimension,
  // String→type, to→keyword.
  assert.ok(complete("me").some((c) => (c.name === "meter" || c.name === "metre") && c.category === "unit"));
  assert.ok(complete("si").some((c) => c.name === "sin" && c.category === "function"));
  assert.ok(complete("pi").some((c) => c.name === "pi" && c.category === "variable"));
  assert.ok(complete("Len").some((c) => c.name === "Length" && c.category === "dimension"));
  assert.ok(complete("St").some((c) => c.name === "String" && c.category === "type"));
  assert.ok(complete("Li").some((c) => c.name === "List" && c.category === "type"));
  assert.ok(complete("to").some((c) => c.name === "to" && c.category === "keyword"));

  // A metric-prefixed unit completes as a unit.
  assert.ok(complete("kilom").some((c) => c.name === "kilometer" && c.category === "unit"));

  // `pi` (both a `\code` and a real constant) is kept; a pure `\code` like `alpha` classifies to
  // nothing when it is not a defined name.
  assert.equal(classifyCompletion("pi", vocab), "variable");
  if (!vocab.variables.has("alpha") && !vocab.units.has("alpha") && !vocab.functions.has("alpha")) {
    assert.equal(classifyCompletion("alpha", vocab), null);
  }

  // A `:` type annotation offers types, dimensions, and units. `Len` there yields the dimension
  // `Length` — and no functions/variables/keywords.
  assert.equal(isTypePosition("let x: "), true);
  const atColon = expressionCompletions(
    (nb.get_completions_for("Len") as unknown[]).map((v) => String(v)),
    vocab,
    ALL,
    allowedCategoriesAt("let x: "),
  );
  assert.ok(atColon.length > 0);
  assert.ok(atColon.every((c) => c.category === "type" || c.category === "dimension" || c.category === "unit"));
  assert.ok(atColon.some((c) => c.name === "Length" && c.category === "dimension"));

  // A `unit <name>:` declaration narrows to dimensions only.
  const atUnit = expressionCompletions(
    (nb.get_completions_for("Len") as unknown[]).map((v) => String(v)),
    vocab,
    ALL,
    allowedCategoriesAt("unit foo: "),
  );
  assert.ok(atUnit.length > 0 && atUnit.every((c) => c.category === "dimension"));

  nb.free();
});

test("a declaration's type variables complete through the merged flow", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);
  const vocab = buildVocab(nb);

  // The editor/REPL assembly at `fn mean<D: Dim>(xs: List<` with an empty query: not a bound
  // position, but a type position — and the declaration's own `D` completes ahead of the engine's
  // candidates (which cannot know it).
  const beforeAnchor = "fn mean<D: Dim>(xs: List<";
  assert.equal(boundCompletions(beforeAnchor, "", ALL), null);
  const allowed = allowedCategoriesAt(beforeAnchor);
  const typeVars = typeVariableCompletions(beforeAnchor, "", ALL, allowed);
  const injected = new Set(typeVars.map((c) => c.name));
  const engine = expressionCompletions(
    (nb.get_completions_for("") as unknown[]).map((v) => String(v)),
    vocab,
    ALL,
    allowed,
  ).filter((c) => !injected.has(c.name));
  const merged = [...typeVars, ...engine];
  assert.deepEqual(merged[0], { name: "D", category: "dimension" }); // Dim-bounded → a dimension variable
  assert.ok(merged.some((c) => c.name === "Length" && c.category === "dimension"));
  assert.ok(merged.every((c) => c.category === "type" || c.category === "dimension" || c.category === "unit"));

  // A type-parameter bound position short-circuits to `Dim` alone; the engine — which owns no such
  // name — is never consulted.
  assert.deepEqual(boundCompletions("fn mean<D: ", "", ALL), [{ name: "Dim", category: "dimension" }]);

  // Once the declaration has ended, its type variable is out of scope.
  const after = "fn mean<D: Dim>(xs: List<D>) -> D = sum(xs) / len(xs)\nlet x: ";
  assert.deepEqual(typeVariableCompletions(after, "", ALL, allowedCategoriesAt(after)), []);

  nb.free();
});

test("block-local definitions complete after being replayed", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  // Nothing user-defined completes `inc…` yet.
  const before = (nb.get_completions_for("inc") as unknown[]).map((v) => String(v));
  assert.ok(!before.includes("income"));

  // Replay the "code above the cursor" — including a user-defined dimension and unit — then rebuild
  // the vocabulary and complete.
  nb.interpret(
    "let income = 60000 EUR / year\nfn savings(x) = x * 0.1\ndimension Foo\nunit baz = 5 meter",
  ).free();
  const vocab = buildVocab(nb);

  const complete = (query: string) => {
    const raw = (nb.get_completions_for(query) as unknown[]).map((v) => String(v));
    return expressionCompletions(raw, vocab, ALL);
  };
  // The user's own definitions complete, and with the right kind.
  assert.ok(complete("inc").some((c) => c.name === "income" && c.category === "variable"));
  assert.ok(complete("sav").some((c) => c.name === "savings" && c.category === "function"));
  // User-defined dimensions/units land in the vocabulary — which interpreter/numbat.ts feeds to
  // highlighting, so they color distinctly rather than falling to the heuristic.
  assert.ok(vocab.dimensions.has("Foo"), "user dimension is captured");
  assert.ok(vocab.units.has("baz"), "user unit is captured");
  assert.ok(complete("Fo").some((c) => c.name === "Foo" && c.category === "dimension"));
  assert.ok(complete("ba").some((c) => c.name === "baz" && c.category === "unit"));

  nb.free();
});

test("every type name the plugin documents is offered, Opt included", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);
  nb.interpret(NULLABLE_PRELUDE).free();
  const vocab = buildVocab(nb);

  // The candidate list interpreter/numbat.ts assembles: the engine's, then the plugin's own.
  const complete = (query: string) => {
    const raw = (nb.get_completions_for(query) as unknown[]).map((v) => String(v));
    return expressionCompletions([...raw, ...pluginTypeCandidates(query)], vocab, ALL);
  };
  const offered = (query: string, name: string) =>
    complete(query).some((c) => c.name === name && c.category === "type");

  // Numbat's own come back from the engine unasked, tagged as keywords and reclassified here.
  for (const name of BUILTIN_TYPE_NAMES) {
    assert.ok(offered(name.slice(0, 2), name), `${name} is not offered as a type`);
    assert.ok(pluginTypeCandidates(name.slice(0, 2)).length === 0, `${name} is injected as well`);
  }

  // `Opt` comes back from the engine never — a struct name is not in its vocabulary at all, even
  // with the prelude loaded — so without the injection it would be the one type that never
  // completed. That absence is what this pins.
  assert.deepEqual((nb.get_completions_for("Op") as unknown[]).map((v) => String(v)), []);
  assert.ok(offered("Op", NULLABLE_STRUCT));
  assert.ok(offered("", NULLABLE_STRUCT), "a just-opened type position offers it");

  // And at a type position, where the engine's variables and functions are filtered out.
  const atType = expressionCompletions(
    [...(nb.get_completions_for("Op") as unknown[]).map((v) => String(v)), ...pluginTypeCandidates("Op")],
    vocab,
    ALL,
    allowedCategoriesAt("let x: "),
  );
  assert.deepEqual(atType.map((c) => c.name), [NULLABLE_STRUCT]);

  nb.free();
});
