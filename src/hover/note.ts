// The note editor's hover: what the symbol under the pointer (or the caret) is, wherever a note's
// text is Numbat *source* — inside a `numbat` / `numbat-shared` fence, inside an inline-eval span,
// or in a Numbat-typed property's value in Source mode. Prose is never hovered, and neither is a
// rendered block: hover reads the document, and a rendered block's source is not in it.
//
// It resolves the symbol against exactly the scope that position has (scope/replay.ts — the same
// walk the completer uses), so a name means here what it means there.
//
// Nothing here calls the interpreter (see hover/hover.ts). What a name is comes out of the facts
// cache (interpreter/facts.ts) as a map lookup; a miss says so and hands back the fill it started,
// which the driver waits on and asks again after. The dwell being armed is what starts that fill,
// so by the time the card is due the answer is usually already there.

import type { EditorView } from "@codemirror/view";
import { type Editor, editorInfoField } from "obsidian";
import { cursorInInlineExpr, cursorInNumbatFence } from "../document/editor-scope";
import { inlineConfig } from "../evaluation/inline";
import { ensureFacts, knownFacts, scopeKey, type ScopeSpec, WANT_CARD } from "../interpreter/facts";
import { scopeFactsReader } from "../interpreter/live-facts";
import { ensureNumbatReady, interpreterGeneration, isNumbatReady } from "../interpreter/numbat";
import type SymbatPlugin from "../main";
import { numbatPropertySiteAt, replayChunksAt } from "../scope/replay";
import { factsSource } from "./card";
import { appendDefinitionLink, declarationCard, symbolCard } from "./content";
import { declaredSymbolAt } from "./declarations";
import { definitionAt } from "./definition";
import { dismissHover, type HoverMiss, type HoverOutcome, type HoverSource, numbatHover } from "./hover";
import { type HoverSymbol, hoverSymbolAt } from "./parse";

/**
 * Where in a note a position sits, when it is Numbat source at all. A property's value carries the
 * column its expression starts at — the key half is YAML. A fence is kept apart from the other
 * two: it is the only one whose body holds statements rather than a single expression.
 */
type NumbatRegion = { kind: "fence"; } | { kind: "inline"; } | { kind: "property"; valueCh: number; };

/**
 * The active editor and note path behind a CodeMirror view, or `null` when the view is not a note
 * (the REPL input, a property field — those hover through their own host).
 */
function editorFor(view: EditorView): { editor: Editor; path: string | null; } | null {
  const info = view.state.field(editorInfoField, false);
  const editor = info?.editor;
  return editor === undefined ? null : { editor, path: info?.file?.path ?? null };
}

/** The warm-up in flight, or `null` when none is (see {@link warmUp}). */
let warming: Promise<void> | null = null;

/**
 * Ready the interpreter, and settle when it is ready to be asked. Mirrors the completer's warm-up,
 * for the same reason: the first hover in a session would otherwise land while the wasm is still
 * loading.
 *
 * Shared rather than started per hover: a reader moving the caret through a block would otherwise
 * queue one of these per keystroke, and they all wait for the same thing. It never rejects — a
 * failure is logged and settles, and the ask that follows is what discovers there is still no
 * answer.
 */
function warmUp(plugin: SymbatPlugin): Promise<void> {
  warming ??= (async () => {
    try {
      await ensureNumbatReady();
      await plugin.ensurePrelude();
      await plugin.ensureExchangeRates();
    } catch (error) {
      console.error("Symbat: the hover popup could not initialize the interpreter", error);
    } finally {
      warming = null;
    }
  })();

  return warming;
}

/** The hover source for a note editor. */
function noteHoverSource(plugin: SymbatPlugin): HoverSource {
  return {
    completerOpen: () => completerOpen(),
    resolve: (view, pos) => resolveInNote(plugin, view, pos),
    prewarm: (view, pos) => {
      prewarmInNote(plugin, view, pos);
    },
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

/**
 * What a hover landed on: the symbol, the note holding it, and the scope it resolves against.
 * Shared by the resolve and the prewarm, so the two cannot come to disagree about which name in
 * which scope the reader is asking about.
 */
interface HoverSite {
  /** The note's editor, for the definition search. */
  editor: Editor;

  /** The note's path, or `null` for an unsaved buffer. */
  path: string | null;

  /** The document line the position is on — the tooltip's anchor is an offset into it. */
  line: { from: number; text: string; };

  /** The position as a line/column pair, which is what the note-side walks take. */
  position: { line: number; ch: number; };

  /** The name being asked about. */
  symbol: HoverSymbol;

  /** The scope the name resolves in: the code above it, replayed. */
  spec: ScopeSpec;

  /** That scope's cache key (interpreter/facts.ts). */
  key: string;
}

/**
 * The site at `pos`, or why there is nothing there. Every `miss` is user-facing: the command and
 * the Vim key report it.
 */
function hoverSiteAt(plugin: SymbatPlugin, view: EditorView, pos: number): HoverSite | HoverMiss {
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

  // Only a fence body holds statements; an inline span and a property value are each one
  // expression, so an `@` in either is not a decorator sigil to be carded.
  const symbol = hoverSymbolAt(line.text, position.ch, {
    quoted: region.kind === "property",
    statements: region.kind === "fence",
  });
  if (symbol === null) {
    return { miss: "nothing to hover at the cursor" };
  }
  if (region.kind === "property" && symbol.from < region.valueCh) {
    return { miss: `\`${symbol.name}\` is the property's key, not its value` };
  }

  // The position's own scope, including its line, so a name hovered on the very statement that
  // defines it resolves.
  const chunks = replayChunksAt(plugin, target.editor, target.path, { line: position.line, ch: symbol.from }, {
    includeCurrentLine: true,
  });
  const spec: ScopeSpec = { chunks, applyRates: plugin.settings.fetchExchangeRates };

  return {
    editor: target.editor,
    path: target.path,
    line,
    position,
    symbol,
    spec,
    key: scopeKey(spec, interpreterGeneration()),
  };
}

/**
 * Start the lookup this site needs, and settle when its answer is in the cache. Batched at one
 * name because that is all a hover asks about; the completer rows are what will send forty.
 */
function fillFacts(plugin: SymbatPlugin, site: HoverSite): Promise<void> {
  return ensureFacts(
    site.key,
    [site.symbol.probe],
    WANT_CARD,
    scopeFactsReader(site.spec, plugin.settings.completionIdleSeconds * 1000),
  );
}

/**
 * Resolve the symbol at `pos`: the card, why there is none, or the lookup that would produce
 * one.
 */
function resolveInNote(
  plugin: SymbatPlugin,
  view: EditorView,
  pos: number,
): HoverOutcome {
  const site = hoverSiteAt(plugin, view, pos);
  if ("miss" in site) {
    return site;
  }
  const { line, position, symbol } = site;

  if (!isNumbatReady()) {
    return { pending: warmUp(plugin), miss: "still starting the interpreter — try again in a moment" };
  }

  // A parameter, a type parameter, a struct's own field: names that exist only inside the
  // declaration that introduces them. They are asked about *first*, because they shadow — no
  // context knows them, but a context may well know an outer name that happens to match, and `fn
  // f(x: Length)` written under a `let x = 9` must describe the parameter rather than the variable.
  // They also need no interpreter at all, so a declared name never waits.
  const declared = declarationCardAt(view, position.line, symbol);

  let card = declared;
  if (card === null) {
    const known = knownFacts(site.key, symbol.probe, WANT_CARD);
    if (known === undefined) {
      return { pending: fillFacts(plugin, site), miss: "could not look that name up — try again in a moment" };
    }
    card = symbolCard(factsSource(known), symbol);
  }
  if (card === null) {
    return { miss: `nothing known about \`${symbol.probe}\` here` };
  }

  // A declared name's definition *is* the declaration the pointer is inside, so there is nowhere to
  // go — and the outer binding it shadows is the one place a link must not lead.
  const definition = declared !== null ? null : definitionAt(
    plugin,
    site.path,
    site.editor.getValue(),
    symbol.probe,
    symbol.name,
    position.line,
  );
  if (definition !== null) {
    appendDefinitionLink(card, plugin.app, definition, site.path, () => dismissHover(view));
  }

  return { from: line.from + symbol.from, to: line.from + symbol.to, dom: card };
}

/**
 * Start what a card at `pos` will need, while the dwell delay runs.
 *
 * The site is worked out first and the interpreter is only woken for a position that is actually
 * Numbat. This runs wherever a caret settles in an editor hover is registered in, and warming the
 * wasm because someone paused in a paragraph would be a cost with nothing at the end of it.
 */
function prewarmInNote(plugin: SymbatPlugin, view: EditorView, pos: number): void {
  const site = hoverSiteAt(plugin, view, pos);
  if ("miss" in site) {
    return;
  }

  if (!isNumbatReady()) {
    void warmUp(plugin);
    return;
  }
  void fillFacts(plugin, site);
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
    return { kind: "fence" };
  }

  if (plugin.settings.inlineEval && cursorInInlineExpr(view.state.doc, pos, inlineConfig(plugin))) {
    return { kind: "inline" };
  }

  if (!plugin.settings.noteProperties) {
    return null;
  }

  const site = numbatPropertySiteAt(plugin.app, editor, position);
  return site === null ? null : { kind: "property", valueCh: site.valueCh };
}

/**
 * Register the hover for note editors. Called from `refreshHover`, through the mutable extension
 * array, so the settings apply live.
 */
export function noteHoverExtension(plugin: SymbatPlugin) {
  return numbatHover(plugin, noteHoverSource(plugin));
}
