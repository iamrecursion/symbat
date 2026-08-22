// The hover popup's contents: the same card the completer opens on a dwell (completion/render.ts),
// built for a symbol rather than for a selected completion, plus the go-to-definition link that
// only a hover offers.
//
// Every surface that hovers builds its card here (the editor (hover/hover.ts), the REPL input, the
// `.nbt` editor and the Numbat property field) so the popup is one thing wherever it opens. What
// differs is only which facts the symbol is asked about (hover/card.ts).
//
// What a card should *say* is decided in hover/card.ts, which is pure and tested; this module turns
// that into elements, which needs Obsidian and a document. The one card it decides itself is the
// declaration card, which asks no interpreter anything: it is for the names a declaration binds —
// its parameters, its fields, its `where`/`and` locals — read back out of the source (see
// hover/declarations.ts) because nothing else knows them.

import type { App } from "obsidian";
import { declaredInfo, declaredTypeHtml } from "../completion/docs";
import { buildDocPopupContent } from "../completion/render";
import { hasDefinitionTarget, jumpToDefinition } from "../scope/goto-definition";
import type { DefinitionMatch } from "../scope/model";
import type { SymbolFactsSource } from "./card";
import { symbolCardPlan } from "./card";
import type { DeclaredSymbol } from "./declarations";
import type { HoverSymbol } from "./parse";

/**
 * The documentation card for `symbol`, built from what `facts` can answer about it, or `null` when
 * there is nothing to say. See {@link symbolCardPlan} for which facts a card is made of and why.
 */
export function symbolCard(facts: SymbolFactsSource, symbol: HoverSymbol): HTMLElement | null {
  const plan = symbolCardPlan(facts, symbol);
  return plan === null ? null : buildDocPopupContent(plan.info, plan.signature);
}

/**
 * The card for a name its own declaration introduces — a parameter, a `where`/`and` local, a type
 * parameter, a struct's field. Nothing in any context knows these, so the card is what the
 * declaration says: the kind, the declared type, and which `fn`/`struct` it belongs to. Built by
 * the completer's own card builder, which the completion popover shows for the same names.
 */
export function declarationCard(declared: DeclaredSymbol): HTMLElement {
  const info = declaredInfo(declared.kind, declared.name, declared.owner);
  return buildDocPopupContent(info, declared.type === null ? null : declaredTypeHtml(declared.type));
}

/**
 * Append the go-to-definition row to a card. Only a **non-bundled** symbol gets one — the note's
 * own bindings, its imports, and the user prelude are what {@link DefinitionMatch} can resolve;
 * everything in Numbat's own prelude resolves to nothing, and shows no row.
 *
 * `onJump` runs after the jump (the caller closes its popup with it). The row is a button rather
 * than a link so a tap works the same as a click.
 */
export function appendDefinitionLink(
  card: HTMLElement,
  app: App,
  match: DefinitionMatch,
  fromPath: string | null,
  onJump: () => void,
): void {
  if (!hasDefinitionTarget(match.defsite, fromPath)) {
    return;
  }

  const row = card.createEl("button", { cls: "numbat-hover-definition", attr: { type: "button" } });
  row.createSpan({ cls: "numbat-hover-definition-label", text: "Go to definition" });
  row.createSpan({ cls: "numbat-hover-definition-where", text: definitionWhere(match, fromPath) });
  row.addEventListener("click", (event) => {
    event.preventDefault();
    jumpToDefinition(app, match.defsite, fromPath);
    onJump();
  });
}

/**
 * How a definition's location reads on the link: the source note for a binding from another file,
 * else where in this note it is (`frontmatter, line 5`).
 */
function definitionWhere(match: DefinitionMatch, fromPath: string | null): string {
  const { notePath, line } = match.defsite;

  if (notePath !== null && notePath !== fromPath) {
    const base = (notePath.split("/").pop() ?? notePath).replace(/\.md$/, "");
    return line === null ? base : `${base}, line ${line + 1}`;
  }

  return line === null ? match.where : `${match.where}, line ${line + 1}`;
}
