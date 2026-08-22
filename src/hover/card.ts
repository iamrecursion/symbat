// What a hover card should say about a symbol, decided without building any of it. The DOM is
// hover/content.ts's job; this module only chooses which of the three facts a card is made of,
// which is the part with rules in it and the part worth testing.
//
// Not everything hoverable is a name the interpreter knows. Three kinds are not, and each has a
// card built from what *is* knowable: a struct field (typed and evaluated, but undocumented), a
// literal (evaluated), and a decorator, which exists only in the grammar and is answered from the
// completer's own table.

import { type CompletionInfo, decoratorInfo, describedInfo } from "../completion/docs";
import { decoratorDoc } from "../completion/expressions";
import type { SymbolFacts } from "../interpreter/facts";
import type { HoverSymbol } from "./parse";

/**
 * The three questions a card asks about one symbol. Each answers `null` when there is nothing to
 * say, and each is asked at most once per card, and only when the branch that needs it is taken.
 *
 * It is an interface with one implementation ({@link factsSource}) and no longer a way of holding
 * an interpreter at arm's length, which is what it used to be. Kept, because the laziness is the
 * thing being tested: a card that asks for a value it does not show is a wasted evaluation on the
 * far side of a boundary, and the only way to see that in a test is to count the questions.
 */
export interface SymbolFactsSource {
  /** What `print_info` documents about the name, or `null` when it documents nothing. */
  info(probe: string): CompletionInfo | null;

  /** The rendered type signature, or `null` when the probe does not type. */
  signature(probe: string): string | null;

  /** The evaluated value as HTML, or `null` when the probe has no value to show. */
  value(probe: string): string | null;
}

/** Numbat's `print_info` opens a function's card with this label; its `Signature:` line already
 *  states the type, so the popup does not add a `Type:` one (matching what the completer does for a
 *  `function` row). */
const FUNCTION_CARD = /^\s*Function:/;

/** The card's two halves, in the shape the popup builder takes them. */
export interface CardPlan {
  /** The documentation body. */
  info: CompletionInfo;

  /** The type signature shown above it, or `null` when there is none to show, either because the
   *  probe does not type, or because the body already states it. */
  signature: string | null;
}

/**
 * What the card for `symbol` should say, or `null` when there is nothing to say about it.
 *
 * A plain name goes to `print_info`. A member chain and a literal are evaluated instead:
 * `print_info("costs.total")` is `Not found` (Numbat exposes docs by name, and neither a member
 * path nor `21.1 km` is one), while `type()` and evaluation both resolve them. A name that is
 * neither documented nor typed — a half-typed word, a keyword, a parameter — yields `null` here;
 * the caller may still have a declaration card for it.
 */
export function symbolCardPlan(facts: SymbolFactsSource, symbol: HoverSymbol): CardPlan | null {
  // A decorator exists only in the grammar as no context has heard of it, and `print_info` would
  // answer for a binding that happens to share the name, so its card comes from the completer's
  // table. An `@` on a name Numbat has no decorator for says nothing at all.
  if (symbol.kind === "decorator") {
    const doc = decoratorDoc(symbol.name);
    return doc === null ? null : { info: decoratorInfo(symbol.name, doc), signature: null };
  }

  if (symbol.kind === "name") {
    const info = facts.info(symbol.probe);
    if (info !== null) {
      return { info, signature: FUNCTION_CARD.test(plainStart(info)) ? null : facts.signature(symbol.probe) };
    }
  }

  const signature = facts.signature(symbol.probe);
  if (signature === null) {
    return null;
  }

  const label = symbol.kind === "quantity" ? "Quantity" : "Field";
  return { info: describedInfo(label, symbol.probe, facts.value(symbol.probe)), signature };
}

/**
 * A record of all three facts, read as a source.
 *
 * The probe is ignored, deliberately: a record is the answer about *one* name, and the only name a
 * card asks about is the one it was resolved for. What the laziness bought — a card never paying
 * for a fact its branch does not take — is bought once, further up, by the fill deciding what to
 * ask for.
 */
export function factsSource(facts: SymbolFacts): SymbolFactsSource {
  return {
    info: () => facts.info,
    signature: () => facts.signature,
    value: () => facts.valueHtml,
  };
}

/** The first line of a doc body as plain text, for the function check. */
function plainStart(info: CompletionInfo): string {
  return info.bodyHtml.split("\n")[0].replace(/<[^>]*>/g, "");
}
