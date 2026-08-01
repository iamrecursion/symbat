// The note editor's hover: what the symbol under the pointer (or the caret) is, wherever a note's
// text is Numbat *source* — inside a `numbat` / `numbat-shared` fence, inside an inline-eval span,
// or in a Numbat-typed property's value in Source mode. Prose is never hovered, and neither is a
// rendered block: hover reads the document, and a rendered block's source is not in it.
//
// It resolves the symbol against exactly the scope that position has (scope/replay.ts — the same
// walk the completer uses), so a name means here what it means there.
//
// Everything here is synchronous (see hover/hover.ts): the interpreter is warmed in the background
// and a hover before it is ready simply shows nothing.

import type { EditorView } from "@codemirror/view";
import { type Editor, editorInfoField } from "obsidian";
import { cursorInInlineExpr, cursorInNumbatFence } from "../document/editor-scope";
import { inlineConfig } from "../evaluation/inline";
import { ensureBlockCompletion, ensureNumbatReady, isNumbatReady, touchCompletionIdle } from "../interpreter/numbat";
import type SymbatPlugin from "../main";
import { numbatPropertySiteAt, replayChunksAt } from "../scope/replay";
import { appendDefinitionLink, declarationCard, symbolCard } from "./content";
import { declaredSymbolAt } from "./declarations";
import { definitionAt } from "./definition";
import { dismissHover, type HoverOutcome, type HoverSource, numbatHover, showHoverWhenReady } from "./hover";
import { type HoverSymbol, hoverSymbolAt } from "./parse";

/** Where in a note a position sits, when it is Numbat source at all. A property's value carries the
 *  column its expression starts at — the key half is YAML. */
type NumbatRegion = { kind: "code"; } | { kind: "property"; valueCh: number; };

/** The active editor and note path behind a CodeMirror view, or `null` when the view is not a note
 *  (the REPL input, a property field — those hover through their own host). */
function editorFor(view: EditorView): { editor: Editor; path: string | null; } | null {
  const info = view.state.field(editorInfoField, false);
  const editor = info?.editor;
  return editor === undefined ? null : { editor, path: info?.file?.path ?? null };
}

/** Whether a background warm-up is already in flight (see {@link warmUp}). */
let warming = false;

/**
 * Ready the interpreter off the hover path, so the *next* hover can answer synchronously. Mirrors
 * the completer's warm-up, for the same reason: the first hover in a session would otherwise have
 * to await the wasm.
 */
function warmUp(plugin: SymbatPlugin, view: EditorView): void {
  if (warming) {
    return;
  }
  warming = true;
  const ready = (async () => {
    try {
      await ensureNumbatReady();
      await plugin.ensurePrelude();
      await plugin.ensureExchangeRates();
    } catch (error) {
      console.error("Symbat: the hover popup could not initialize the interpreter", error);
    } finally {
      warming = false;
    }
  })();
  // The hover that triggered the warm-up is the one the user wanted; show it when the interpreter
  // arrives, rather than making them ask a second time.
  showHoverWhenReady(view, ready);
}

/** The hover source for a note editor. */
function noteHoverSource(plugin: SymbatPlugin): HoverSource {
  return {
    completerOpen: () => completerOpen(),
    resolve: (view, pos) => resolveInNote(plugin, view, pos),
  };
}

/**
 * Whether a completion popover is **open right now** — judged from the popover element itself, for
 * every completer at once: ours, which renders into Obsidian's native completer UI, and Obsidian's
 * own (the property and link completers open over frontmatter, exactly where hover also fires).
 *
 * No flag is consulted, deliberately. The first version of this read the suggest manager's
 * `currentSuggest`, which names the completer that ran *last* rather than one that is showing — so
 * from the first completion onward it stayed set, and every hover was suppressed for the rest of
 * the session: no card, no error, no clue. A stuck flag ends the feature; a missed suppression
 * merely lets two popups share the screen for a moment. This check fails towards **closed** for
 * that reason.
 */
function completerOpen(): boolean {
  for (const container of Array.from(document.querySelectorAll<HTMLElement>(".suggestion-container"))) {
    if (container.isConnected && container.getBoundingClientRect().height > 0) {
      return true;
    }
  }
  return false;
}

/** Resolve the symbol at `pos`, or say why there is nothing to show. Every `miss` here is
 *  user-facing: the command and the Vim key report it. */
function resolveInNote(
  plugin: SymbatPlugin,
  view: EditorView,
  pos: number,
): HoverOutcome {
  const target = editorFor(view);
  if (target === null) {
    return { miss: "no editor here" };
  }

  const line = view.state.doc.lineAt(pos);
  const position = { line: line.number - 1, ch: pos - line.from };

  // The region decides how the line reads, so it is settled before the symbol is: a property's
  // value may be wrapped in YAML quotes, which are not Numbat's.
  const region = numbatRegionAt(plugin, view, target.editor, pos, position);
  if (region === null) {
    return {
      miss: "not Numbat source here — hover works in numbat blocks, inline spans, "
        + "and a Numbat-typed property's value",
    };
  }

  const symbol = hoverSymbolAt(line.text, position.ch, { quoted: region.kind === "property" });
  if (symbol === null) {
    return { miss: "nothing to hover at the cursor" };
  }
  if (region.kind === "property" && symbol.from < region.valueCh) {
    return { miss: `\`${symbol.name}\` is the property's key, not its value` };
  }
  if (!isNumbatReady()) {
    warmUp(plugin, view);
    return { miss: "still starting the interpreter — try again in a moment" };
  }

  // The position's own scope — including its line, so a name hovered on the very statement that
  // defines it resolves.
  const chunks = replayChunksAt(plugin, target.editor, target.path, { line: position.line, ch: symbol.from }, {
    includeCurrentLine: true,
  });

  const built = ensureBlockCompletion(chunks, plugin.settings.fetchExchangeRates);
  if (built === null) {
    return { miss: "could not build the scope for this position" };
  }
  touchCompletionIdle(plugin.settings.completionIdleSeconds * 1000);

  // A parameter, a type parameter, a struct's own field: names that exist only inside the
  // declaration that introduces them. They are asked about *first*, because they shadow — no
  // context knows them, but a context may well know an outer name that happens to match, and `fn
  // f(x: Length)` written under a `let x = 9` must describe the parameter rather than the variable.
  const declared = declarationCardAt(view, position.line, symbol);
  const card = declared ?? symbolCard(built.context, symbol);
  if (card === null) {
    return { miss: `nothing known about \`${symbol.probe}\` here` };
  }

  // A declared name's definition *is* the declaration the pointer is inside, so there is nowhere to
  // go — and the outer binding it shadows is the one place a link must not lead.
  const definition = declared !== null ? null : definitionAt(
    plugin,
    target.path,
    target.editor.getValue(),
    symbol.probe,
    symbol.name,
    position.line,
  );
  if (definition !== null) {
    appendDefinitionLink(card, plugin.app, definition, target.path, () => dismissHover(view));
  }

  return { from: line.from + symbol.from, to: line.from + symbol.to, dom: card };
}

/**
 * The card for a name the enclosing `fn`/`struct` declares, or `null`. The lines up to the cursor
 * are enough: a declaration's header always precedes its uses.
 *
 * Only a bare name is asked about. A member chain's `name` is its last component (`total` of
 * `costs.total`), which a declaration elsewhere could coincidentally introduce — and that field is
 * not this path.
 */
function declarationCardAt(view: EditorView, line: number, symbol: HoverSymbol): HTMLElement | null {
  if (symbol.kind !== "name") {
    return null;
  }

  const lines: string[] = [];
  for (let n = 1; n <= line + 1; n += 1) {
    lines.push(view.state.doc.line(n).text);
  }

  const declared = declaredSymbolAt(lines, line, symbol.name);
  return declared === null ? null : declarationCard(declared);
}

/**
 * Which Numbat region the position is in, or `null` when it is prose: inside a fence, inside an
 * inline-eval span, or in a Numbat-typed property's value. The cheap document walks come first —
 * this runs on every hover.
 */
function numbatRegionAt(
  plugin: SymbatPlugin,
  view: EditorView,
  editor: Editor,
  pos: number,
  position: { line: number; ch: number; },
): NumbatRegion | null {
  if (cursorInNumbatFence(view.state.doc, pos)) {
    return { kind: "code" };
  }

  if (plugin.settings.inlineEval && cursorInInlineExpr(view.state.doc, pos, inlineConfig(plugin))) {
    return { kind: "code" };
  }

  if (!plugin.settings.noteProperties) {
    return null;
  }

  const site = numbatPropertySiteAt(plugin.app, editor, position);
  return site === null ? null : { kind: "property", valueCh: site.valueCh };
}

/** Register the hover for note editors. Called from `refreshHover`, through the mutable extension
 *  array, so the settings apply live. */
export function noteHoverExtension(plugin: SymbatPlugin) {
  return numbatHover(plugin, noteHoverSource(plugin));
}
