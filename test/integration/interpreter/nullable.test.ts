// Pins the nullable vocabulary (interpreter/nullable.ts) against the real Numbat interpreter.
//
// Everything about undefined frontmatter properties rests on this file's assumptions: that a
// generic struct over a `List<T>` lets an absence sit beside its siblings, that `head` of an empty
// list is a clean runtime error, and that `if` is lazy enough for `get_or_else` to be worth having.
// None of that is checkable in a unit test, and all of it could change under a Numbat bump — so it
// is checked here, against the pinned wasm, rather than assumed.

import assert from "node:assert/strict";
import { test } from "node:test";
import { completionCard } from "../../../src/completion/docs.ts";
import { readableNullables } from "../../../src/interpreter/nullable-display.ts";
import {
  definedValue,
  NULLABLE_ABSENT,
  NULLABLE_NAMES,
  NULLABLE_PRELUDE,
  NULLABLE_STRUCT,
} from "../../../src/interpreter/nullable.ts";
import { loadNumbat, newContext, skip } from "../wasm-pkg.ts";

/** The output with its markup removed, for assertions about what the user reads. */
const plain = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

/**
 * The card a hover or a completion opens on `name`, built from what the real interpreter answers.
 *
 * The wiring in interpreter/numbat.ts's `completionInfo` is this plus the wasm call it cannot be
 * tested without: that module imports `obsidian`, so no test can load it.
 */
const card = (nb: any, name: string) => completionCard(nb.print_info(name) as string, name);

/** Run one snippet, returning its plain text and whether Numbat rejected it. */
function runner(nb: any) {
  return (code: string) => {
    const result = nb.interpret(code);
    const outcome = { text: plain(result.output as string), isError: result.is_error as boolean };
    result.free();
    return outcome;
  };
}

test("the nullable vocabulary loads into a context", { skip }, async () => {
  const mod = await loadNumbat();
  const nb = mod.Numbat.new(true, true, mod.FormatType.Html);
  const run = runner(nb);

  const loaded = run(NULLABLE_PRELUDE);
  assert.equal(loaded.isError, false, loaded.text);

  // Every documented name is really bound, so the reserved-name cost the docs describe is the cost
  // the plugin actually pays. Numbat echoes a `fn` with its head and a `let` with its value, and an
  // alias not at all — `undefined` is checked by asking for it below instead.
  for (const name of NULLABLE_NAMES) {
    if (name === "undefined") {
      continue;
    }
    const echoed = name === "nil" ? new RegExp(`let ${name}:`) : new RegExp(`fn ${name}[<(]`);
    assert.match(loaded.text, echoed, `${name} is not declared by the prelude`);
  }

  nb.free();
});

test("the constructors build both states, and nil serves at every type", { skip }, async () => {
  const run = runner(newContext(await loadNumbat()));

  assert.match(run(`is_defined(some(7 m))`).text, /= true\s+\[Bool\]/);
  assert.match(run(`get(some(7 m))`).text, /= 7 m/);
  assert.match(run(`is_undefined(nil)`).text, /= true\s+\[Bool\]/);

  // Why `nil` is a `let` and not a `fn`: a plain constant generalizes, so the *same* name is an
  // absent Length here and an absent Scalar on the next line. A `fn nil<T>()` would have made every
  // hole a call, and every one of these two characters longer for nothing.
  assert.match(run(`get_or(nil, 5 m)`).text, /= 5 m/);
  assert.match(run(`get_or(nil, 5)`).text, /= 5$/m);
  assert.match(run(`[some(1 m), nil, some(3 m)]`).text, new RegExp(`List<${NULLABLE_STRUCT}<Length>>`));

  // And it is what the derivation writes, spelled the way a reader would spell it.
  assert.match(run(`is_undefined(${NULLABLE_ABSENT})`).text, /= true/);
});

test("an absent value answers the predicates and the fallbacks", { skip }, async () => {
  const run = runner(newContext(await loadNumbat()));

  assert.match(run(`is_undefined(${NULLABLE_ABSENT})`).text, /= true\s+\[Bool\]/);
  assert.match(run(`is_defined(${NULLABLE_ABSENT})`).text, /= false\s+\[Bool\]/);
  assert.match(run(`get_or(${NULLABLE_ABSENT}, 5 m)`).text, /= 5 m/);

  // The unguarded read is the one operation that fails, and it fails at runtime rather than
  // producing a wrong answer. The message is Numbat's own; capture it so a bump that changes it
  // shows up here rather than in a user's note.
  const unguarded = run(`get(${NULLABLE_ABSENT})`);
  assert.equal(unguarded.isError, true);
  assert.match(unguarded.text, /Empty list/);
});

test("a present value reads back through every accessor", { skip }, async () => {
  const run = runner(newContext(await loadNumbat()));
  const seven = definedValue("7 m");

  assert.match(run(`is_defined(${seven})`).text, /= true\s+\[Bool\]/);
  assert.match(run(`get(${seven})`).text, /= 7 m/);
  assert.match(run(`get_or(${seven}, 5 m)`).text, /= 7 m/);
});

test("get_or_else calls its fallback only when there is nothing to return", { skip }, async () => {
  const run = runner(newContext(await loadNumbat()));

  // A fallback that raises: proof of laziness, since an eager `get_or_else` would raise on the
  // present value too. This is the whole difference between it and `get_or`.
  assert.equal(run("fn boom() -> Length = error(\"the fallback ran\")").isError, false);
  assert.match(run(`get_or_else(${definedValue("7 m")}, boom)`).text, /= 7 m/);

  const raised = run(`get_or_else(${NULLABLE_ABSENT}, boom)`);
  assert.equal(raised.isError, true);
  assert.match(raised.text, /the fallback ran/);

  // Not `five`: Numbat's prelude names the small numbers, so that would be an identifier clash.
  assert.equal(run("fn fallback_length() -> Length = 5 m").isError, false);
  assert.match(run(`get_or_else(${NULLABLE_ABSENT}, fallback_length)`).text, /= 5 m/);
});

test("an absence sits beside its siblings, and a lone one stays polymorphic", { skip }, async () => {
  const run = runner(newContext(await loadNumbat()));

  // The property the whole encoding exists for: one list, one element type, one hole in it.
  const mixed = run(`[${definedValue("1 m")}, ${NULLABLE_ABSENT}, ${definedValue("3 m")}]`);
  assert.equal(mixed.isError, false, mixed.text);
  assert.match(mixed.text, new RegExp(`\\[List<${NULLABLE_STRUCT}<Length>>\\]`));

  // Nothing to fix the type: Numbat generalizes rather than complaining, which is what lets a
  // property with no siblings bind at all — and is what makes the prelude's own `nil` usable at
  // every type at once.
  const alone = run(`let nothing = ${NULLABLE_ABSENT}`);
  assert.equal(alone.isError, false, alone.text);
  assert.match(alone.text, new RegExp(`forall A\\. ${NULLABLE_STRUCT}<A>`));

  // A struct field holds one too, which is how an array of objects with a gap binds.
  assert.equal(run("struct Row<T0, T1> { a: T0, b: T1 }").isError, false);
  const rows = run(`[Row { a: ${definedValue("1")}, b: 2 }, Row { a: ${NULLABLE_ABSENT}, b: 3 }]`);
  assert.equal(rows.isError, false, rows.text);
  assert.match(rows.text, new RegExp(`List<Row<${NULLABLE_STRUCT}<Scalar>, Scalar>>`));
});

test("the vocabulary composes with the rest of Numbat", { skip }, async () => {
  const run = runner(newContext(await loadNumbat()));

  // `get` is an ordinary function, so the list vocabulary applies to a list of nullables — which is
  // the point of keeping the list intact rather than dropping it.
  const summed = run(`sum(map(get, [${definedValue("1 m")}, ${definedValue("2 m")}]))`);
  assert.equal(summed.isError, false, summed.text);
  assert.match(summed.text, /= 3 m/);
});

test("the type error for an unread hole names a type the reader knows", { skip }, async () => {
  const nb = newContext(await loadNumbat());
  const run = runner(nb);
  assert.equal(run(`let w = ${definedValue("70")}`).isError, false);

  // The mistake this whole feature invites: reading a hole without handling it. Before an empty
  // property bound at all, this said "unknown identifier"; now that it binds, this message stands
  // in for that one, so it has to name something the reader can act on.
  //
  // Pinned against the real interpreter rather than a fixture because the rewrite matches the exact
  // shape Numbat dumps a struct in — a bump that changes it should fail here rather than put the
  // struct body in front of a reader.
  const raised = nb.interpret("w + 1");
  const rewritten = readableNullables(raised.output as string);
  const shown = plain(rewritten);
  const isError = raised.is_error as boolean;
  raised.free();

  assert.equal(isError, true);
  assert.match(shown, new RegExp(`got ${NULLABLE_STRUCT}<Scalar> instead`));
  assert.equal(shown.includes("value: List<"), false, shown);

  // Numbat writes the brackets raw inside the message span; the rewrite must hand them back
  // escaped, or the sanitizer parses `<Scalar>` as an element and the reader is told `got Opt
  // instead`. Pinned here rather than only in the unit test because the raw form is Numbat's, and a
  // bump that starts escaping them would double-escape instead.
  assert.match(rewritten, new RegExp(`got ${NULLABLE_STRUCT}&lt;Scalar&gt; instead`));
});

test("every injected name describes itself on hover", { skip }, async () => {
  const nb = newContext(await loadNumbat());

  // The decorators are only worth writing if `print_info` reads them back — that is the one route
  // the plugin has into a card the interpreter answers for, and the hover popup and both completers
  // all go through it (interpreter/numbat.ts's completionInfo).
  for (const name of NULLABLE_NAMES) {
    const info = card(nb, name);
    assert.notEqual(info, null, `${name} has no card`);
    assert.match(plain(info?.bodyHtml ?? ""), /Description: \S/, `${name} has no description`);
  }

  // The alias is the same binding, so it answers with the same words — but under the name that was
  // asked about, which is the right way round: hovering `undefined` should say `undefined`. Each
  // card names both spellings, so neither leaves a reader wondering about the other.
  const nil = plain(card(nb, "nil")?.bodyHtml ?? "");
  const undef = plain(card(nb, "undefined")?.bodyHtml ?? "");
  assert.match(nil, /^Variable: nil\n/);
  assert.match(undef, /^Variable: undefined\n/);
  assert.equal(nil.split("\n").slice(1).join("\n"), undef.split("\n").slice(1).join("\n"));
  assert.match(nil, /Aliases: nil, undefined/);

  nb.free();
});

test("a type name describes itself too, though the interpreter cannot", { skip }, async () => {
  const nb = newContext(await loadNumbat());

  // Numbat answers `Not found` for every type name it has, so these cards come from the plugin's
  // own table. Pinned against the real interpreter because the fallback is only reached when
  // `print_info` really does say nothing — if a bump starts documenting types, this stops being a
  // fallback and starts being an override.
  assert.equal(nb.print_info(NULLABLE_STRUCT).includes("Not found"), true);
  assert.match(plain(card(nb, NULLABLE_STRUCT)?.bodyHtml ?? ""), /^Type: Opt\nDescription: \S/);
  assert.match(plain(card(nb, "List")?.bodyHtml ?? ""), /^Type: List\nDescription: \S/);

  // A name the interpreter *can* answer for is never spoken over by the table — including a
  // dimension, which it documents in full and which is not a type in the sense used here.
  assert.match(plain(card(nb, "pi")?.bodyHtml ?? ""), /^Variable: /);
  assert.match(plain(card(nb, "Length")?.bodyHtml ?? ""), /^Dimension: /);
  assert.equal(card(nb, "nonesuch"), null);

  nb.free();
});

test("a binding of the reader's own outranks the type table", { skip }, async () => {
  const nb = newContext(await loadNumbat());

  // Numbat's own type names cannot be bound at all — `let List = 5` is a *parse* error, since they
  // are grammar-reserved words. So for those five the table can never be overridden, and there is
  // nothing to arbitrate.
  assert.equal(nb.interpret("let List = 5").is_error, true);

  // `Opt` is the plugin's, and an ordinary name to the grammar — so a reader can bind it, and when
  // they do their own words win. This is the asymmetry that keeps `Opt` out of BUILTIN_TYPE_NAMES:
  // that set is the grammar's reserved words, and `Opt` is not one.
  assert.equal(nb.interpret(`@description("My own thing.")\nlet ${NULLABLE_STRUCT} = 5`).is_error, false);
  assert.match(plain(card(nb, NULLABLE_STRUCT)?.bodyHtml ?? ""), /Description: My own thing\./);

  nb.free();
});

test("a type annotation may be written in the name the reader is shown", { skip }, async () => {
  const run = runner(newContext(await loadNumbat()));

  // The whole point of dropping the `T?` display: what a reader sees in a result or an error is a
  // type they can turn around and write, in a `fn` signature or a `let`.
  // Not a zero fallback: Numbat prints a zero quantity with no unit, which would prove nothing.
  const declared = run(`fn spend(b: ${NULLABLE_STRUCT}<Length>) -> Length = get_or(b, 2 m)`);
  assert.equal(declared.isError, false, declared.text);
  assert.match(run("spend(some(4 m))").text, /= 4 m/);
  assert.match(run("spend(nil)").text, /= 2 m/);
});

test("a user definition may shadow one of the utilities", { skip }, async () => {
  const run = runner(newContext(await loadNumbat()));

  // Why the vocabulary is applied *before* the user prelude: Numbat lets a later `fn` replace an
  // earlier one, so a reader who has their own `get` keeps it instead of colliding with ours.
  assert.equal(run("fn get(x: Scalar) -> Scalar = x + 1").isError, false);
  assert.match(run("get(1)").text, /= 2/);
});
