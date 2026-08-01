// Syntax highlighting for `numbat` / `numbat-shared` fenced code blocks.
//
//   * Editor (Source mode + Live Preview) — a CodeMirror 6 `ViewPlugin` that tokenizes the contents
//     of `numbat` fences and paints `Decoration.mark` ranges. Obsidian exposes no public API to
//     bind a CM6 language to a fence info-string, so (like the maintained Shiki /
//     Extended-Code-Highlight plugins) we detect the fences and tokenize their text ourselves
//     rather than using the legacy `window.CodeMirror` CM5 shim.
//   * Reading view — a Prism grammar, registered via `loadPrism()`.

import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { loadPrism, type Plugin } from "obsidian";
import { inNumbatBody, numbatFenceState } from "../document/fence-state";
import { numbatBlockRanges } from "../document/fences";
import { primeSemanticNames } from "../interpreter/numbat";
import { KEYWORDS, NUMBER_PATTERN, tokensForLine } from "./tokenizer";
import { semanticKind, subscribeSemanticNames } from "./type-names";

// EDITOR: CODEMIRROR 6 DECORATIONS
// ================================================================================================

/** Dispatched once the interpreter's dimension/unit names have been captured, so the plugin
 *  re-tokenizes the visible numbat blocks to color them semantically. */
const semanticsReady = StateEffect.define<void>();

/** The result of a decoration pass: the marks, and whether any numbat block was seen (so the plugin
 *  knows whether it is worth priming the type names). */
interface DecorationResult {
  /** The token marks to paint, in ascending document order. */
  decorations: DecorationSet;

  /** Whether the pass saw any Numbat code at all — the trigger for priming the interpreter's
   *  dimension/unit names, which is not worth doing for a note that has none. */
  sawNumbat: boolean;
}

/**
 * Build the token decorations for the numbat blocks the editor is showing. Only lines within the
 * visible ranges are visited at all — where the blocks are comes from the maintained fence index
 * (document/fence-state.ts), so a keystroke costs the visible lines rather than the document.
 * `visibleRanges` are ascending, which is what `RangeSetBuilder` requires. Type/dimension/unit
 * names are colored semantically (see syntax/tokenizer.ts's `wordKind`).
 */
function buildDecorations(view: EditorView): DecorationResult {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc } = view.state;
  const visible = view.visibleRanges;

  // Which lines are numbat code comes from the maintained index, so this walks only the *visible*
  // lines rather than every line of the document on every keystroke and every scroll. Without the
  // index (no field registered) it falls back to scanning, which is what it always did.
  const spans = view.state.field(numbatFenceState, false)
    ?? numbatBlockRanges(doc.iterLines(1, doc.lines + 1)).map((block) => ({
      shared: block.shared,
      bodyStartLine: block.bodyStartLine,
      closeLine: block.closeLine,
    }));

  for (const range of visible) {
    const first = doc.lineAt(range.from).number;
    const last = doc.lineAt(range.to).number;
    for (let n = first; n <= last; n += 1) {
      if (!inNumbatBody(spans, n - 1)) {
        continue;
      }

      const line = doc.line(n);
      for (const token of tokensForLine(line.text, semanticKind)) {
        builder.add(line.from + token.start, line.from + token.end, Decoration.mark({ class: token.cls }));
      }
    }
  }

  // Priming the semantic names only needs to know the note *has* numbat code.
  return { decorations: builder.finish(), sawNumbat: spans.length > 0 };
}

/**
 * Tokenize every (visible) line of a wholly-Numbat document — the REPL input — with no fence
 * detection, since the entire content is Numbat. Mirrors {@link buildDecorations} otherwise, so the
 * REPL and code blocks color identically.
 */
function buildReplDecorations(view: EditorView): DecorationResult {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc } = view.state;
  const visible = view.visibleRanges;
  const isVisible = (from: number, to: number): boolean =>
    visible.some((range) => from <= range.to && to >= range.from);

  for (let n = 1; n <= doc.lines; n += 1) {
    const line = doc.line(n);
    if (isVisible(line.from, line.to)) {
      for (const token of tokensForLine(line.text, semanticKind)) {
        builder.add(line.from + token.start, line.from + token.end, Decoration.mark({ class: token.cls }));
      }
    }
  }

  // Prime once there is something to highlight (an empty input needs no interpreter).
  return { decorations: builder.finish(), sawNumbat: doc.length > 0 };
}

/**
 * Build the editor extension that keeps the decoration set in sync with edits and scrolling, given
 * a `scan` that produces the decorations (fence-scanning for code blocks, whole-document for the
 * REPL). Once Numbat content is present it primes the prelude's dimension/unit names and subscribes
 * for growth (user-defined names arrive as they are used), re-tokenizing whenever they change (via
 * the `semanticsReady` effect) so they light up. Shared so the REPL input and code blocks color
 * alike.
 */
function numbatHighlightViewPlugin(scan: (view: EditorView) => DecorationResult) {
  return ViewPlugin.fromClass(
    class {
      /** The marks CodeMirror is currently painting, republished on every rescan. */
      decorations: DecorationSet;

      /** Whether this editor has already primed + subscribed (once is enough). */
      private primed = false;

      /** Unsubscribe from name-growth notifications, set once subscribed. */
      private unsubscribe: (() => void) | null = null;

      /** Set on teardown so a late notification does not dispatch to a dead view. */
      private destroyed = false;

      /** Paint the initial viewport, since no update will fire until something changes. */
      constructor(view: EditorView) {
        const result = scan(view);
        this.decorations = result.decorations;
        this.maybePrimeSemantics(view, result.sawNumbat);
      }

      /** Repaint when the text changed, the viewport moved, or the semantic names arrived — the
       *  three things that can change what a visible line looks like. */
      update(update: ViewUpdate): void {
        const arrived = update.transactions.some((tr) => tr.effects.some((e) => e.is(semanticsReady)));
        if (update.docChanged || update.viewportChanged || arrived) {
          const result = scan(update.view);
          this.decorations = result.decorations;
          this.maybePrimeSemantics(update.view, result.sawNumbat);
        }
      }

      /** Drop the name subscription with the view, and latch `destroyed` so a notification already
       *  queued cannot dispatch into a torn-down editor. */
      destroy(): void {
        this.destroyed = true;
        this.unsubscribe?.();
      }

      /**
       * On first sight of Numbat code, read the interpreter's known dimension and unit names and
       * subscribe for more. Idempotent via {@link primed}: the subscription must not be
       * re-established on every repaint.
       */
      private maybePrimeSemantics(view: EditorView, sawNumbat: boolean): void {
        if (this.primed || !sawNumbat) {
          return;
        }
        this.primed = true;

        // Read the prelude names (for pure source mode, where nothing else has), and re-tokenize
        // whenever the known names grow — the prelude first, then any user-defined dimensions/units
        // as they are used.
        primeSemanticNames();
        this.unsubscribe = subscribeSemanticNames(() => {
          // The change can land during a Live Preview render (inside a CM update), where
          // dispatching synchronously is forbidden — so defer to a fresh task.
          window.setTimeout(() => {
            if (!this.destroyed) {
              view.dispatch({ effects: semanticsReady.of() });
            }
          }, 0);
        });
      }
    },
    { decorations: (value) => value.decorations },
  );
}

// The code-block highlighter (locates numbat fences in a Markdown document).
const numbatHighlightPlugin = numbatHighlightViewPlugin(buildDecorations);

/**
 * The REPL input highlighter: the same decoration-based, semantic-aware discipline as code blocks,
 * over the wholly-Numbat input. Exported for views/input.ts, which toggles it via a compartment for
 * the "Live REPL highlighting" setting. Using the same mechanism (not a separate `HighlightStyle`)
 * keeps the REPL and code blocks in lock-step, including re-highlighting as the interpreter's names
 * are learned.
 */
export const numbatReplHighlight = numbatHighlightViewPlugin(buildReplDecorations);

// READING VIEW: PRISM
// ================================================================================================

/** Build the Prism grammar used to highlight `numbat` blocks in reading view. */
function numbatPrismGrammar(): Record<string, unknown> {
  return {
    comment: { pattern: /#.*/, greedy: true },
    string: { pattern: /"(?:[^"\\]|\\.)*"/, greedy: true },
    decorator: { pattern: /@\w+/, alias: "important" },
    keyword: new RegExp(`\\b(?:${KEYWORDS.join("|")})\\b`),
    boolean: /\b(?:true|false)\b/,
    number: NUMBER_PATTERN,
    operator: /->|→|\*\*|[-+*/^=<>!·×÷°%]/,
    punctuation: /[{}()[\],;:]/,
  };
}

/** The sliver of Prism's API this module uses. `loadPrism()` is typed `any` by Obsidian, so this
 *  narrows it to the one property being written rather than taking the untyped object at its
 *  word. */
interface PrismLike {
  /** Prism's grammar registry, keyed by language name. */
  languages: Record<string, unknown>;
}

/** Register the Numbat Prism grammar (reading view) once Prism has loaded. */
async function registerPrism(): Promise<void> {
  try {
    const prism = (await loadPrism()) as PrismLike | undefined;
    if (prism && !prism.languages["numbat"]) {
      const grammar = numbatPrismGrammar();
      prism.languages["numbat"] = grammar;
      prism.languages["numbat-shared"] = grammar;
    }
  } catch (error) {
    console.error("Symbat: could not register Prism grammar", error);
  }
}

/** Register highlighting for both the editor (CM6) and the reading view (Prism). */
export async function registerHighlighting(plugin: Plugin): Promise<void> {
  plugin.registerEditorExtension([numbatHighlightPlugin]);
  await registerPrism();
}
