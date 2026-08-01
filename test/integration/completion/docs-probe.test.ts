// Drives the real Numbat wasm to pin the formats the completion documentation relies on: the
// `type(<name>)` signature output and the `print_info(<name>)` docs — and, since the hover card is
// that same documentation, what Numbat will say about the names a *note* defines. Self-skips when
// the wasm is not built, like the sibling probes.

import assert from "node:assert/strict";
import { test } from "node:test";
import { describedInfo, formatDocBody, parsePrintInfo, signatureFromTypeOutput } from "../../../src/completion/docs.ts";
import { deriveScopeValue } from "../../../src/scope/eval.ts";
import { loadNumbat, skip } from "../wasm-pkg.ts";

test("type(<name>) yields a signature we can extract, per kind", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);
  const sig = (name: string): string | null => {
    const r = nb.interpret(`type(${name})`);
    const out = r.is_error ? null : signatureFromTypeOutput(r.output);
    r.free();
    return out;
  };

  // A generic function: `forall … Fn[…]`, with its `numbat-*` spans intact.
  const abs = sig("abs");
  assert.ok(abs && abs.includes("numbat-keyword") && abs.includes("Fn"), abs ?? "no sig");
  assert.ok(!abs.includes(">type<"), "the echoed input is stripped");
  // A monomorphic function: `Fn[(Scalar) -> Scalar]`.
  assert.ok(sig("sin")?.includes("Fn"));
  // A variable and a unit resolve to their type/dimension.
  assert.ok(sig("pi")?.includes("Scalar"));
  assert.ok(sig("meter")?.includes("Length"));
  // A keyword / dimension has no `type(…)` — an error, so no signature.
  assert.equal(sig("to"), null);

  nb.free();
});

test("print_info(<name>) parses into body + reference URL, or null", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  const sqrt = parsePrintInfo(nb.print_info("sqrt") as string);
  assert.ok(sqrt, "sqrt has documentation");
  assert.match(sqrt.referenceUrl ?? "", /^https:\/\//);
  assert.ok(sqrt.bodyHtml.includes("Signature:"));
  assert.ok(sqrt.bodyHtml.includes("numbat-keyword")); // the `fn` in the signature
  assert.ok(!sqrt.bodyHtml.includes("https://"), "the URL is lifted out of the body");

  // A unit still has docs (with a reference), a keyword does not.
  assert.ok(parsePrintInfo(nb.print_info("meter") as string));
  assert.equal(parsePrintInfo(nb.print_info("to") as string), null);
  assert.equal(parsePrintInfo(nb.print_info("nonexistent_xyz") as string), null);

  nb.free();
});

// --- what the hover card rests on ---------------------------------------------

test("print_info documents the names a note defines, values and all", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);
  const run = (code: string) => {
    const r = nb.interpret(code);
    r.free();
  };
  run("let speed = 5 km / h");
  run("fn tripled(x: Scalar) -> Scalar = 3 x");
  run("unit widget");
  run("dimension Sparkle");

  // This is the premise of the whole feature: hovering your own binding is worth doing, because
  // Numbat has as much to say about it as about its own prelude.
  const speed = parsePrintInfo(nb.print_info("speed") as string);
  assert.ok(speed, "a user's own binding has print_info to parse");
  assert.ok(speed.bodyHtml.includes("Variable:"));
  assert.ok(speed.bodyHtml.includes("km/h"), "a variable's card carries its value");
  assert.ok(parsePrintInfo(nb.print_info("tripled") as string)?.bodyHtml.includes("Signature:"));
  assert.ok(parsePrintInfo(nb.print_info("widget") as string)?.bodyHtml.includes("A unit of:"));
  assert.ok(parsePrintInfo(nb.print_info("Sparkle") as string)?.bodyHtml.includes("Dimension:"));

  nb.free();
});

test("a struct field has no print_info, so its card is built from type + value", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);
  const run = (code: string) => {
    const r = nb.interpret(code);
    const out = { output: r.output as string, isError: r.is_error as boolean };
    r.free();
    return out;
  };
  run("struct Costs { total: Money, tax: Money }");
  run("let costs = Costs { total: 500 EUR, tax: 20 EUR }");

  // The struct itself is documented; the field is not — Numbat exposes docs by name, and
  // `costs.total` is not a name.
  assert.ok(parsePrintInfo(nb.print_info("costs") as string));
  assert.equal(parsePrintInfo(nb.print_info("costs.total") as string), null);
  // But it types and evaluates, which is what the field card is made of.
  const type = signatureFromTypeOutput(run("type(costs.total)").output);
  assert.ok(type?.includes("Money"));
  const value = deriveScopeValue(run, "costs.total");
  assert.equal(value.kind, "value");
  assert.ok(value.plain?.includes("500"));
  const card = formatDocBody(describedInfo("Field", "costs.total", value.valueHtml).bodyHtml, type);
  assert.ok(card.includes("Field:"));
  assert.ok(card.includes("Type:"));
  assert.ok(card.includes("numbat-doc-label"), "the labels style like every other card's");

  nb.free();
});
