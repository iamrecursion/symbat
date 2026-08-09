// The hover popup's contents: the same card the completer opens on a dwell (completion/render.ts),
// built for a symbol rather than for a selected completion, plus the go-to-definition link that
// only a hover offers.
//
// Every surface that hovers builds its card here — the editor (hover/hover.ts), the REPL input and
// the Numbat property field (through their `NumbatInput` hosts) — so the popup is one thing
// wherever it opens. What differs is only *which* interpreter context the symbol is asked about.
//
// Not everything hoverable is a name the interpreter knows. Three kinds are not, and each has a
// card built from what *is* knowable: a struct field (typed and evaluated, but undocumented), a
// literal (evaluated), and the names a declaration itself binds — its parameters, its fields, its
// `where`/`and` locals (read back out of the source — see hover/declarations.ts).

import type { App } from "obsidian";
import { type CompletionInfo, declaredInfo, declaredTypeHtml, decoratorInfo, describedInfo } from "../completion/docs";
import { decoratorDoc } from "../completion/expressions";
import { buildDocPopupContent } from "../completion/render";
import { completionInfo, completionSignature, interpret, type Numbat } from "../interpreter/numbat";
import { deriveScopeValue } from "../scope/eval";
import { hasDefinitionTarget, jumpToDefinition } from "../scope/goto-definition";
import type { DefinitionMatch } from "../scope/model";
import type { DeclaredSymbol } from "./declarations";
import type { HoverSymbol } from "./parse";

/** Numbat's `print_info` opens a function's card with this label; its `Signature:` line already
 *  states the type, so the popup does not add a `Type:` one (matching what the completer does for a
 *  `function` row). */
const FUNCTION_CARD = /^\s*Function:/;

/**
 * The documentation card for `symbol`, asked of `context`, or `null` when there is nothing to say
 * about it.
 *
 * A plain name goes to `print_info`. A member chain and a literal are evaluated instead:
 * `print_info("costs.total")` is `Not found` (Numbat exposes docs by name, and neither a member
 * path nor `21.1 km` is one), while `type()` and evaluation both resolve them. A name that is
 * neither documented nor typed — a half-typed word, a keyword, a parameter — yields `null` here;
 * the caller may still have a {@link declarationCard} for it.
 */
export function symbolCard(context: Numbat, symbol: HoverSymbol): HTMLElement | null {
  // A decorator exists only in the grammar — no context has heard of it, and `print_info` would
  // answer for a binding that happens to share the name — so its card comes from the completer's
  // table. An `@` on a name Numbat has no decorator for says nothing at all.
  if (symbol.kind === "decorator") {
    const doc = decoratorDoc(symbol.name);
    return doc === null ? null : buildDocPopupContent(decoratorInfo(symbol.name, doc));
  }

  if (symbol.kind === "name") {
    const info = completionInfo(context, symbol.probe);
    if (info !== null) {
      const signature = FUNCTION_CARD.test(plainStart(info)) ? null : completionSignature(context, symbol.probe);
      return buildDocPopupContent(info, signature);
    }
  }

  const signature = completionSignature(context, symbol.probe);
  if (signature === null) {
    return null;
  }

  const label = symbol.kind === "quantity" ? "Quantity" : "Field";
  return buildDocPopupContent(describedInfo(label, symbol.probe, evaluated(context, symbol.probe)), signature);
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

/** The evaluated value of an expression, or `null` when it has none to show. */
function evaluated(context: Numbat, expression: string): string | null {
  const value = deriveScopeValue((code) => interpret(context, code), expression);
  return value.kind === "value" ? value.valueHtml : null;
}

/** The first line of a doc body as plain text, for the function check. */
function plainStart(info: CompletionInfo): string {
  return info.bodyHtml.split("\n")[0].replace(/<[^>]*>/g, "");
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

/** How a definition's location reads on the link: the source note for a binding from another file,
 *  else where in this note it is (`frontmatter, line 5`). */
function definitionWhere(match: DefinitionMatch, fromPath: string | null): string {
  const { notePath, line } = match.defsite;

  if (notePath !== null && notePath !== fromPath) {
    const base = (notePath.split("/").pop() ?? notePath).replace(/\.md$/, "");
    return line === null ? base : `${base}, line ${line + 1}`;
  }

  return line === null ? match.where : `${match.where}, line ${line + 1}`;
}
