import assert from "node:assert/strict";
import { test } from "node:test";
import { factsSource, symbolCardPlan, type SymbolFactsSource } from "../../../src/hover/card.ts";
import type { HoverSymbol, HoverSymbolKind } from "../../../src/hover/parse.ts";

/** A facts source that records what it was asked, so a test can assert on the calls a card did
 *  *not* make — which is where the laziness lives. */
function stubFacts(answers: {
  info?: string | null;
  signature?: string | null;
  value?: string | null;
}): SymbolFactsSource & { asked: string[]; } {
  const asked: string[] = [];
  return {
    asked,
    info: (probe) => {
      asked.push(`info:${probe}`);
      return answers.info === undefined || answers.info === null
        ? null
        : { bodyHtml: answers.info, referenceUrl: null };
    },
    signature: (probe) => {
      asked.push(`signature:${probe}`);
      return answers.signature ?? null;
    },
    value: (probe) => {
      asked.push(`value:${probe}`);
      return answers.value ?? null;
    },
  };
}

function symbol(kind: HoverSymbolKind, probe: string, name = probe): HoverSymbol {
  return { kind, name, probe, from: 0, to: probe.length };
}

// --- decorators ---------------------------------------------------------------

test("a known decorator is answered from the completer's table, asking the interpreter nothing", () => {
  const facts = stubFacts({ info: "Function: anything", signature: "<i>Bool</i>" });
  const plan = symbolCardPlan(facts, symbol("decorator", "description"));

  assert.ok(plan !== null);
  assert.match(plan.info.bodyHtml, /Decorator: @description/);
  assert.equal(plan.signature, null);
  assert.deepEqual(facts.asked, [], "a decorator is not a name any context knows");
});

// A binding may well share the name; answering from `print_info` would show that binding's card
// under an `@`.
test("an unknown decorator says nothing at all", () => {
  const facts = stubFacts({ info: "Unit: notadecorator", signature: "<i>Length</i>" });
  assert.equal(symbolCardPlan(facts, symbol("decorator", "notadecorator")), null);
  assert.deepEqual(facts.asked, []);
});

// --- documented names ---------------------------------------------------------

test("a documented name shows its docs above its signature", () => {
  const facts = stubFacts({ info: "Unit: meter\nDescription: the SI length unit", signature: "<i>Length</i>" });
  const plan = symbolCardPlan(facts, symbol("name", "meter"));

  assert.deepEqual(plan, {
    info: { bodyHtml: "Unit: meter\nDescription: the SI length unit", referenceUrl: null },
    signature: "<i>Length</i>",
  });
});

// `print_info`'s function card already carries a `Signature:` line, so a `Type:` one above it would
// state the same thing twice — and asking for it is a wasm call that buys nothing.
test("a function's card does not repeat its signature, and does not ask for one", () => {
  const facts = stubFacts({ info: "Function: sin\nSignature: fn(Scalar) -> Scalar", signature: "<i>fn</i>" });
  const plan = symbolCardPlan(facts, symbol("name", "sin"));

  assert.equal(plan?.signature, null);
  assert.deepEqual(facts.asked, ["info:sin"]);
});

test("the function check reads the body as text, not as markup", () => {
  const facts = stubFacts({ info: "<span class=\"numbat-keyword\">Function</span>: sin", signature: "<i>fn</i>" });
  assert.equal(symbolCardPlan(facts, symbol("name", "sin"))?.signature, null);
});

// --- names with no documentation ----------------------------------------------

test("an undocumented name falls through to its type", () => {
  const facts = stubFacts({ info: null, signature: "<i>Length</i>", value: "5 m" });
  const plan = symbolCardPlan(facts, symbol("name", "x"));

  assert.match(plan?.info.bodyHtml ?? "", /Field: x/);
  assert.equal(plan?.signature, "<i>Length</i>");
  assert.deepEqual(facts.asked, ["info:x", "signature:x", "value:x"]);
});

test("a name that is neither documented nor typed has no card, and is not evaluated", () => {
  const facts = stubFacts({ info: null, signature: null, value: "should not be asked" });
  assert.equal(symbolCardPlan(facts, symbol("name", "halfwritt")), null);
  assert.deepEqual(facts.asked, ["info:halfwritt", "signature:halfwritt"]);
});

// --- members and literals -----------------------------------------------------

// Numbat exposes docs by name, and a member path is not one — so these skip `print_info` entirely
// rather than spending a call to be told `Not found`.
test("a member chain is typed and evaluated, never asked for docs", () => {
  const facts = stubFacts({ info: "never", signature: "<i>Money</i>", value: "42 €" });
  const plan = symbolCardPlan(facts, symbol("member", "costs.total", "total"));

  assert.match(plan?.info.bodyHtml ?? "", /Field: costs\.total/);
  assert.match(plan?.info.bodyHtml ?? "", /42 €/);
  assert.deepEqual(facts.asked, ["signature:costs.total", "value:costs.total"]);
});

test("a literal is labelled a quantity rather than a field", () => {
  const facts = stubFacts({ signature: "<i>Length</i>", value: "21.1 km" });
  const plan = symbolCardPlan(facts, symbol("quantity", "21.1 km"));

  assert.match(plan?.info.bodyHtml ?? "", /Quantity: 21\.1 km/);
});

test("a typed probe with no value still gets a card", () => {
  const facts = stubFacts({ signature: "<i>Length</i>", value: null });
  const plan = symbolCardPlan(facts, symbol("member", "costs.total", "total"));

  assert.match(plan?.info.bodyHtml ?? "", /Field: costs\.total/);
  assert.equal(plan?.signature, "<i>Length</i>");
});

test("the card asks about the whole probe, not the word under the pointer", () => {
  const facts = stubFacts({ signature: "<i>Money</i>" });
  symbolCardPlan(facts, symbol("member", "a.b.c", "c"));
  assert.deepEqual(facts.asked, ["signature:a.b.c", "value:a.b.c"]);
});

// --- a record read as a source ------------------------------------------------

test("a filled record answers the same card the interpreter would have", () => {
  const record = {
    info: { bodyHtml: "Length: a distance", referenceUrl: null },
    signature: "<i>Length</i>",
    valueHtml: "5 m",
    fields: null,
  };
  const plan = symbolCardPlan(factsSource(record), symbol("name", "width"));

  assert.equal(plan?.info.bodyHtml, "Length: a distance");
  assert.equal(plan?.signature, "<i>Length</i>");
});

test("a record with nothing in it is nothing to show", () => {
  const empty = { info: null, signature: null, valueHtml: null, fields: null };
  assert.equal(symbolCardPlan(factsSource(empty), symbol("name", "wat")), null);
});

test("a record answers whichever fact is asked for, since it holds them all", () => {
  // The record is about one name, so the probe is not consulted — what the lazy source bought is
  // bought further up, by the fill deciding what to send for.
  const record = { info: null, signature: "<i>Money</i>", valueHtml: "12 €", fields: null };
  const plan = symbolCardPlan(factsSource(record), symbol("member", "costs.total", "total"));

  assert.match(plan?.info.bodyHtml ?? "", /Field: costs\.total/);
  assert.match(plan?.info.bodyHtml ?? "", /12 €/);
});
