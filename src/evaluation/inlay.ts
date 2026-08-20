// Inlay hints for `numbat` / `numbat-shared` code blocks in the editor (Source mode + Live
// Preview).
//
// A CodeMirror 6 `ViewPlugin` that, for each visible block, evaluates the block line by line in a
// fresh interpreter context and paints muted `Decoration.widget` hints:
//
//   * a binding's inferred type, anchored just after the name (`let x‹: Length›`), shown only where
//     the user did not already write an annotation;
//   * an expression's result, at the end of the line (`a + b ‹= 7 m [Length]›`);
//   * for an incomplete expression, the type of the missing operand as a placeholder (`3 m +
//     ‹⟨Length⟩›`), obtained from Numbat's typed holes;
//   * for a statement that fails to evaluate (and has no such hole), the diagnostic's summary line
//     (`abs(-5 ‹Expected ")"›`), like inline eval.
//
// The block is fenced-scanned exactly as syntax/highlight.ts does. Evaluation is the one costly
// part, so it is debounced, done off the update path, and cached by block text; a completed
// evaluation dispatches an effect that rebuilds the (cheap) decoration set from the cache.
// Types/dimensions and results reuse Numbat's own formatter HTML (via setNumbatHtml), so they color
// exactly like the rendered view — just dimmed by the `.numbat-inlay` container.

import { RangeSetBuilder, StateEffect, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import { blockRangesOf, frontmatterBodyOf } from "../document/doc-cache";
import { sourcePathOf } from "../document/editor-file";
import { type NumbatBlockRange } from "../document/fences";
import { FRONTMATTER_CLOSE, FRONTMATTER_OPEN } from "../document/frontmatter";
import {
  createContext,
  ensureNumbatReady,
  freeQuietly,
  interpret,
  interpreterGeneration,
  isNumbatReady,
  restartNumbat,
} from "../interpreter/numbat";
import { setNumbatHtml } from "../interpreter/render";
import type SymbatPlugin from "../main";
import { hintPlacesOnKey, hintsFromOutcomes } from "../properties/frontmatter-inlay";
import { notePreamble, primeReservedNames, replayPreamble } from "../properties/note";
import { requestNoteOutcomes } from "../properties/note-outcomes";
import { firstStale, knownOutcomes, outcomeKeys } from "../properties/outcome-cache";
import { frontmatterKeySites } from "../properties/parse";
import { INLAY_CACHE_ENTRIES, INLAY_DEBOUNCE_MS } from "../tuning";
import { blockKey, endPadding, type Hint, hintsForBlock, holeForm, wholeScopeKey } from "./inlay-parse";

/** Dispatched after an off-path evaluation populates the cache, so the plugin rebuilds its
 *  decorations to include the newly-available hints. Also dispatched by {@link refreshNumbatInlays}
 *  when the note scope changes out-of-band (a cross-note import's source note was edited). */
const inlayReady = StateEffect.define<void>();

/**
 * Nudge an editor's inlay hints to recompute — its `build()` re-derives the note preamble (picking
 * up a changed cross-note import) and re-evaluates only the blocks whose cache key moved, so
 * unaffected hints do not flicker. Used by the plugin when an imported note changes; a plain effect
 * dispatch also repaints a background pane, which `updateOptions()` alone does not reliably do.
 */
export function refreshNumbatInlays(view: EditorView): void {
  view.dispatch({ effects: inlayReady.of() });
}

// THE HINT WIDGET
// ================================================================================================

/** The widget rendering a single hint. Equality by (kind, content, pad) lets CodeMirror reuse the
 *  DOM across redraws when a hint is unchanged. */
class InlayWidget extends WidgetType {
  /**
   * @param kind which hint this is, selecting both the CSS class and how {@link toDOM} renders
   *   `content`.
   * @param content formatter HTML, or plain text for `hole` and `error`.
   * @param pad virtual leading spaces, so an end-of-line hint clears the code.
   */
  constructor(private readonly kind: Hint["kind"], private readonly content: string, private readonly pad: number) {
    super();
  }

  /** Compare by the three rendered inputs, so CodeMirror keeps the existing DOM when a redraw
   *  produces an identical hint. */
  eq(other: InlayWidget): boolean {
    return other.kind === this.kind && other.content === this.content && other.pad === this.pad;
  }

  /** Build the hint's element. */
  toDOM(): HTMLElement {
    const span = createSpan({ cls: `numbat-inlay numbat-inlay-${this.kind}` });

    // Virtual leading space(s) so the end-of-line hint sits one space from the code (see
    // endPadding); rendered as real spaces (the container is `pre-wrap`) so they match the
    // monospace grid. Added first, before the content.
    if (this.pad > 0) {
      span.appendText(" ".repeat(this.pad));
    }

    if (this.kind === "hole") {
      // A placeholder for the missing operand's type (e.g. `⟨Length⟩`).
      span.appendText(`⟨${this.content}⟩`);
    } else if (this.kind === "error" || this.kind === "warning") {
      // The diagnostic's summary line, or the advisory, as plain text (colored by the class above).
      span.appendText(this.content);
    } else {
      // Reuse Numbat's own formatter HTML so types/dimensions/values color as they do in the
      // rendered view (the container dims them); render into a child so the pad text node above
      // survives `setNumbatHtml`'s `empty()`.
      setNumbatHtml(span.createSpan(), this.content);
    }

    return span;
  }

  /** Hints are decoration, not content: let every event through to the editor so clicking one
   *  places the caret in the code rather than selecting the widget. */
  ignoreEvent(): boolean {
    return true;
  }
}

// FRONTMATTER PROPERTY INLAYS (SOURCE MODE)
// ================================================================================================
//
// In Source mode the frontmatter is raw YAML, so a numbat-typed (or bound-number) property gets the
// same end-of-line `= value` hint a `numbat` block line does. In Live Preview the frontmatter is
// the property-editor widget instead, which carries its own result — so these are suppressed there
// (see isSourceFrontmatter).
//
// The evaluation is not done here at all: a note's bindings are evaluated once, by the property
// batch (properties/note-outcomes.ts), and this projects the same cached outcomes through
// {@link hintFromOutcome}. Here we locate each property's line and place the widget.

// The frontmatter delimiters, as properties/parse.ts tracks them — matched here over the editor's
// line index so a property line can be located by number.

/** The note's YAML frontmatter region (1-indexed CM line numbers, both delimiters included), or
 *  `null` when the note has none. */
function frontmatterRegion(doc: Text): { open: number; close: number; } | null {
  if (doc.lines < 2 || !FRONTMATTER_OPEN.test(doc.line(1).text)) {
    return null;
  }

  for (let n = 2; n <= doc.lines; n += 1) {
    if (FRONTMATTER_CLOSE.test(doc.line(n).text)) {
      return { open: 1, close: n };
    }
  }

  return null;
}

/** Which hint kinds the current settings permit. */
interface HintFilter {
  /** Whether inferred-type hints (and typed holes) are shown. */
  types: boolean;

  /** Whether computed-result hints (and error summaries) are shown. */
  results: boolean;
}

/** Whether a hint should be shown under the given filter: holes are type hints; an error or warning
 *  hint is the line's outcome, so both follow the results toggle. */
function hintEnabled(hint: Hint, filter: HintFilter): boolean {
  return hint.kind === "result" || hint.kind === "error" || hint.kind === "warning"
    ? filter.results
    : filter.types;
}

// CODE-BLOCK HINTS
// ================================================================================================

/**
 * The inlay-hint editor extension. Reads the plugin's inlay settings live, so `refreshInlayHints()`
 * (which reconfigures the editors) is all a toggle needs.
 */
export function numbatInlayHints(plugin: SymbatPlugin) {
  return ViewPlugin.fromClass(
    class {
      /** The hint widgets CodeMirror is painting, republished on every build. */
      decorations: DecorationSet;

      /** Cached hints per block, keyed by {@link blockKey}. */
      private readonly cache = new Map<string, Hint[]>();

      /** Stops waiting on the property batch, where a pass has been asked for. Held because the
       *  batch outlives a view: a destroyed plugin left in the waiter set dispatches into a view
       *  that is gone. */
      private unwaitFrontmatter: (() => void) | null = null;

      /** The pending debounced evaluation, or `null` when none is scheduled. */
      private timer: number | null = null;

      /** Set on teardown, so an evaluation already in flight discards its results instead of
       *  dispatching into a destroyed view. */
      private destroyed = false;

      /** Paint whatever is already cached; anything missing is scheduled by `build`. */
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      /** Rebuild when the text changed, the viewport moved, or a refresh was requested out-of-band
       *  (an imported note changed, or a setting was toggled). */
      update(update: ViewUpdate): void {
        const arrived = update.transactions.some((tr) => tr.effects.some((e) => e.is(inlayReady)));
        if (update.docChanged || update.viewportChanged || arrived) {
          this.decorations = this.build(update.view);
        }
      }

      /** Cancel any pending evaluation with the view, and stop waiting on the property batch. */
      destroy(): void {
        this.destroyed = true;
        if (this.timer !== null) {
          window.clearTimeout(this.timer);
        }

        this.unwaitFrontmatter?.();
        this.unwaitFrontmatter = null;
      }

      /**
       * Build the decoration set for the visible blocks from cached evaluations, and schedule an
       * evaluation for any visible block not yet cached. Returns an empty set (and schedules
       * nothing) when inlay hints are disabled.
       */
      private build(view: EditorView): DecorationSet {
        if (!plugin.settings.inlayHints) {
          return Decoration.none;
        }

        const filter: HintFilter = {
          types: plugin.settings.inlayTypes,
          results: plugin.settings.inlayResults,
        };

        const { doc } = view.state;
        const blocks = blockRangesOf(doc);
        const visible = blocks.filter((block) => this.isVisible(view, doc, block));

        // The same preamble-aware key the evaluation pass caches under.
        const preamble = notePreamble(plugin, frontmatterBodyOf(doc), sourcePathOf(view));

        const pending: NumbatBlockRange[] = [];
        const placements: { from: number; widget: InlayWidget; }[] = [];
        for (const block of visible) {
          const key = blockKey(interpreterGeneration(), preamble.source, block, blocks);
          const hints = this.cache.get(key);

          if (hints === undefined) {
            pending.push(block);
            continue;
          }

          for (const hint of hints) {
            if (!hintEnabled(hint, filter)) {
              continue;
            }

            const docLine = block.bodyStartLine + hint.bodyLine + 1; // CM lines are 1-indexed.
            if (docLine > doc.lines) {
              continue;
            }

            const line = doc.line(docLine);
            const from = Math.min(line.from + hint.column, line.to);

            placements.push({ from, widget: new InlayWidget(hint.kind, hint.content, hint.pad) });
          }
        }

        // Frontmatter property inlays: in Source mode, place each bound property's `= value` on its
        // own line (Live Preview shows the widget instead) — except for a value written on the
        // lines below its key, which shows only its problems (see hintPlacesOnKey).
        let needFrontmatter = false;
        if (filter.results && preamble.bindings.length > 0 && this.isSourceFrontmatter(view, doc)) {
          const region = frontmatterRegion(doc);

          if (region !== null) {
            // The keys the batch fills through, built by the same function it builds them with, so
            // the two cannot come to disagree about what a property's scope is.
            const keys = outcomeKeys(plugin.settings.fetchExchangeRates, preamble);
            const outcomes = knownOutcomes(keys, preamble.bindings);

            // An old answer is still painted; what it also does is ask for a newer one, which is
            // how a property reading the clock keeps moving.
            needFrontmatter = outcomes === null || firstStale(keys, preamble.bindings) !== null;

            if (outcomes !== null) {
              const hints = hintsFromOutcomes(outcomes);

              // One scan of the frontmatter locates every key, nested ones included; the sites are
              // 0-indexed, the document's lines are 1-indexed.
              const sites = frontmatterKeySites(doc.iterLines(1, region.close + 1));

              for (const hint of hints) {
                const site = sites.get(hint.key);
                if (site === undefined || !hintPlacesOnKey(hint.kind, site)) {
                  continue;
                }

                const lineNo = site.line + 1;
                const line = doc.line(lineNo);
                const pad = endPadding(line.text, hint.kind === "hole" ? "hole" : "result");
                placements.push({ from: line.to, widget: new InlayWidget(hint.kind, hint.content, pad) });
              }
            }
          }
        }

        if (pending.length > 0 || needFrontmatter) {
          this.scheduleEvaluation(view, pending, blocks, needFrontmatter);
        }

        placements.sort((a, b) => a.from - b.from);
        const builder = new RangeSetBuilder<Decoration>();
        for (const { from, widget } of placements) {
          builder.add(from, from, Decoration.widget({ widget, side: 1 }));
        }

        return builder.finish();
      }

      /** Whether any of `block`'s body lines fall within the editor's viewport. */
      private isVisible(view: EditorView, doc: Text, block: NumbatBlockRange): boolean {
        const firstLine = Math.min(block.bodyStartLine + 1, doc.lines);
        const lastLine = Math.min(block.closeLine, doc.lines);

        if (block.body.length === 0 || firstLine > lastLine) {
          return false;
        }

        const from = doc.line(firstLine).from;
        const to = doc.line(lastLine).to;

        return view.visibleRanges.some((range) => from <= range.to && to >= range.from);
      }

      /**
       * Whether the frontmatter is shown as raw YAML (Source mode) and lies in the viewport. In
       * Live Preview the frontmatter is replaced by the property-editor widget — which carries its
       * own `= value` — so raw-line hints are suppressed there; and off-screen frontmatter needs no
       * evaluation.
       */
      private isSourceFrontmatter(view: EditorView, doc: Text): boolean {
        if (view.state.field(editorLivePreviewField, false) === true) {
          return false;
        }

        const region = frontmatterRegion(doc);
        if (region === null) {
          return false;
        }

        const from = doc.line(region.open).from;
        const to = doc.line(region.close).to;

        return view.visibleRanges.some((range) => from <= range.to && to >= range.from);
      }

      /**
       * Debounced, off-path evaluation of the visible `pending` blocks whose hints are not cached.
       * `allBlocks` (the whole document's blocks) is carried so a `numbat-shared` block can replay
       * the shared blocks that precede it. After evaluating, caches the hints and asks the view to
       * rebuild its decorations.
       */
      private scheduleEvaluation(
        view: EditorView,
        pending: NumbatBlockRange[],
        allBlocks: NumbatBlockRange[],
        evalFrontmatter: boolean,
      ): void {
        if (this.timer !== null) {
          window.clearTimeout(this.timer);
        }

        this.timer = window.setTimeout(() => {
          this.timer = null;
          void this.evaluatePending(view, pending, allBlocks, evalFrontmatter);
        }, INLAY_DEBOUNCE_MS);
      }

      /**
       * Evaluate the blocks that missed the cache and repaint. Runs off the debounce, so by the
       * time it starts the view may be gone or the document may have moved on — hence the
       * `destroyed` checks either side of the awaits, and the cache keys, which make a stale result
       * simply unused rather than wrong.
       *
       * `allBlocks` is needed as well as `pending` because each block is evaluated against the
       * shared blocks above it, which are part of its key.
       */
      private async evaluatePending(
        view: EditorView,
        pending: NumbatBlockRange[],
        allBlocks: NumbatBlockRange[],
        evalFrontmatter: boolean,
      ): Promise<void> {
        try {
          await ensureNumbatReady();
          await plugin.ensureExchangeRates();
          await plugin.ensurePrelude();
        } catch (error) {
          // A rejected init leaves `readyPromise` rejected for good; only a restart clears it.
          // Without this the surface would stay dead for the session unless some other one happened
          // to trigger the retry.
          console.error("Symbat: inlay hints could not initialize the interpreter", error);
          restartNumbat();
          return;
        }

        if (this.destroyed || !isNumbatReady()) {
          return;
        }

        const applyRates = plugin.settings.fetchExchangeRates;
        primeReservedNames(applyRates);

        // The note preamble (property bindings) opens every block's scope; it is part of each cache
        // key, so a property edit re-evaluates the hints.
        const { doc } = view.state;
        const preamble = notePreamble(plugin, frontmatterBodyOf(doc), sourcePathOf(view));
        let evaluated = false;

        for (const block of pending) {
          const key = blockKey(interpreterGeneration(), preamble.source, block, allBlocks);
          if (block.body.length === 0 || this.cache.has(key)) {
            continue;
          }

          const context = createContext(applyRates);
          try {
            replayPreamble(context, preamble);
            if (block.shared) {
              // Replay earlier shared blocks so shared state is deterministic.
              for (const earlier of allBlocks) {
                if (earlier.shared && earlier.openLine < block.openLine) {
                  interpret(context, earlier.body.join("\n"));
                }
              }
            }
            this.remember(key, hintsForBlock((code) => interpret(context, code), block.body));
            evaluated = true;
          } catch (error) {
            // A wasm panic: schedule a restart and stop this pass (the interpreter reinitializes
            // before the next evaluation).
            console.error("Symbat: inlay-hint evaluation crashed", error);
            restartNumbat();
            break;
          } finally {
            freeQuietly(context);
          }
        }

        if (evaluated && !this.destroyed) {
          view.dispatch({ effects: inlayReady.of() });
        }

        // The frontmatter properties are asked for rather than evaluated: the property batch owns
        // that evaluation, and while this note's scope is the one a widget is also looking at, the
        // two share a single pass. Its own dispatch, because it lands on its own schedule.
        if (evalFrontmatter && preamble.bindings.length > 0) {
          const keys = outcomeKeys(applyRates, preamble);
          this.unwaitFrontmatter?.();
          this.unwaitFrontmatter = requestNoteOutcomes(plugin, preamble, () => {
            this.unwaitFrontmatter = null;

            // Only when the pass actually answered this scope. A dispatch rebuilds, a rebuild that
            // still finds nothing asks again, and a pass that cannot run would otherwise spin at
            // the debounce for the rest of the session. Nothing is lost by waiting: the next edit
            // rebuilds anyway.
            if (!this.destroyed && firstStale(keys, preamble.bindings) === null) {
              view.dispatch({ effects: inlayReady.of() });
            }
          });
        }
      }

      /** Store a block's hints, evicting the oldest entries past the cap. */
      private remember(key: string, hints: Hint[]): void {
        this.cache.set(key, hints);

        while (this.cache.size > INLAY_CACHE_ENTRIES) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) {
            break;
          }

          this.cache.delete(oldest);
        }
      }
    },
    { decorations: (value) => value.decorations },
  );
}

// WHOLE-DOCUMENT HINTS (.NBT FILES)
// ================================================================================================

/**
 * The `.nbt` editor's counterpart of the block inlay hints: the whole document is one Numbat
 * program, so it needs no fence scan and no per-block bookkeeping — {@link hintsForBlock} runs over
 * every line, and a hint's `bodyLine` is its document line (CM's are 1-indexed, hence the `+ 1`).
 *
 * `filePath` names the file being edited, so a file that is itself part of the user prelude
 * evaluates against the prelude files loaded *before* it rather than one that already contains it
 * (see `createContext`'s `preludeBefore`) — otherwise its own `unit` and `dimension` declarations
 * would each be defined twice, and every hint below the first would be a redefinition error.
 *
 * Like the block plugin the evaluation is debounced, done off the update path, and cached by
 * document text; unlike it, the whole document is one cache entry. The context is built and freed
 * per pass — never the shared completion context, whose contents are keyed to a cache the file's
 * own statements would corrupt.
 */
export function numbatDocumentInlays(plugin: SymbatPlugin, filePath: () => string | null) {
  return ViewPlugin.fromClass(
    class {
      /** The hint widgets CodeMirror is painting, republished on every build. */
      decorations: DecorationSet;

      /** Cached hints for the document, keyed by its full text and the interpreter generation. A
       * prelude edit changes what the file's own statements mean without changing a character of it
       * (see {@link wholeScopeKey}). */
      private readonly cache = new Map<string, Hint[]>();

      /** The pending debounced evaluation, or `null` when none is scheduled. */
      private timer: number | null = null;

      /** Set on teardown, so an evaluation already in flight discards its results. */
      private destroyed = false;

      /** Paint whatever is already cached; a miss schedules the evaluation. */
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      /** Rebuild when the text changed, the viewport moved, or a refresh was requested. */
      update(update: ViewUpdate): void {
        const arrived = update.transactions.some((tr) => tr.effects.some((e) => e.is(inlayReady)));
        if (update.docChanged || update.viewportChanged || arrived) {
          this.decorations = this.build(update.view);
        }
      }

      /** Cancel any pending evaluation with the view. */
      destroy(): void {
        this.destroyed = true;
        if (this.timer !== null) {
          window.clearTimeout(this.timer);
        }
      }

      /**
       * Turn the cached hints into widgets, scheduling an evaluation on a miss. Purely synchronous:
       * the settings are read live here rather than baked in, which is why toggling a hint kind
       * only needs the editors reconfigured.
       */
      private build(view: EditorView): DecorationSet {
        if (!plugin.settings.inlayHints) {
          return Decoration.none;
        }

        const filter: HintFilter = {
          types: plugin.settings.inlayTypes,
          results: plugin.settings.inlayResults,
        };

        const { doc } = view.state;
        const hints = this.cache.get(wholeScopeKey(interpreterGeneration(), doc.toString()));
        if (hints === undefined) {
          this.scheduleEvaluation(view);
          return Decoration.none;
        }

        const builder = new RangeSetBuilder<Decoration>();
        for (const hint of hints) {
          if (!hintEnabled(hint, filter)) {
            continue;
          }

          const lineNo = hint.bodyLine + 1; // CM lines are 1-indexed.
          if (lineNo > doc.lines) {
            continue;
          }

          const line = doc.line(lineNo);
          const from = Math.min(line.from + hint.column, line.to);
          builder.add(
            from,
            from,
            Decoration.widget({ widget: new InlayWidget(hint.kind, hint.content, hint.pad), side: 1 }),
          );
        }

        return builder.finish();
      }

      /** Debounce a whole-document evaluation, restarting the wait on each call so a burst of
       *  typing costs one pass rather than one per keystroke. */
      private scheduleEvaluation(view: EditorView): void {
        if (this.timer !== null) {
          window.clearTimeout(this.timer);
        }

        this.timer = window.setTimeout(() => {
          this.timer = null;
          void this.evaluate(view);
        }, INLAY_DEBOUNCE_MS);
      }

      /**
       * Evaluate the whole file in a throwaway context and repaint. The document is one cache entry
       * — unlike the block plugin, a `.nbt` file is a single scope, so there is nothing finer to
       * key on.
       */
      private async evaluate(view: EditorView): Promise<void> {
        try {
          await ensureNumbatReady();
          await plugin.ensureExchangeRates();
          await plugin.ensurePrelude();
        } catch (error) {
          console.error("Symbat: the Numbat file's inlay hints could not initialize the interpreter", error);
          return;
        }

        if (this.destroyed || !isNumbatReady()) {
          return;
        }

        const applyRates = plugin.settings.fetchExchangeRates;
        const text = view.state.doc.toString();
        const key = wholeScopeKey(interpreterGeneration(), text);
        if (this.cache.has(key)) {
          return;
        }

        const path = filePath();
        const context = createContext(applyRates, path === null ? {} : { preludeBefore: path });
        try {
          this.remember(key, hintsForBlock((code) => interpret(context, code), text.split("\n")));
        } catch (error) {
          console.error("Symbat: the Numbat file's inlay evaluation crashed", error);
          restartNumbat();
          return;
        } finally {
          freeQuietly(context);
        }
        if (!this.destroyed) {
          view.dispatch({ effects: inlayReady.of() });
        }
      }

      /** Store the document's hints, evicting the oldest entries past the cap (the key moves with
       *  every edit, so the map would otherwise grow unbounded). */
      private remember(key: string, hints: Hint[]): void {
        this.cache.set(key, hints);

        while (this.cache.size > INLAY_CACHE_ENTRIES) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          this.cache.delete(oldest);
        }
      }
    },
    { decorations: (value) => value.decorations },
  );
}

// THE REPL HOLE HINT
// ================================================================================================

/**
 * The REPL-input counterpart of the inlay hints: shows only the incomplete expression (typed-hole)
 * placeholder at the end of the input, evaluated against the REPL's live session context through
 * `holeType`. Unlike code blocks this needs no fence scan, fresh context, or debounce — the session
 * context is loaded and a single small input evaluates synchronously.
 *
 * Scoped to a single-line input: a multi-line entry's earlier statements would have to be replayed
 * to type the last line's hole, and running them on the live session context would define them
 * before the user submits. A single incomplete line's hole form is always a type error, so it never
 * mutates the session.
 *
 * Gated by the same inlay type-hint settings; views/input.ts toggles it live via a compartment (so
 * a disabled/enabled change fully adds or removes it), and this also self-gates in case it is left
 * installed.
 */
export function numbatReplHoleHint(plugin: SymbatPlugin, holeType: (input: string) => string | null) {
  return ViewPlugin.fromClass(
    class {
      /** The hole widget CodeMirror is painting — at most one. */
      decorations: DecorationSet;

      /** Paint the initial input, which is usually empty and so yields nothing. */
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      /** Rebuild on every edit: the hint tracks the input character by character. */
      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.build(update.view);
        }
      }

      /**
       * Type the input's trailing hole, if it has one. Synchronous — the session context is already
       * loaded, and the two cheap gates below (single line, `holeForm` matches) keep a complete
       * expression from costing an interpret on every keystroke.
       */
      private build(view: EditorView): DecorationSet {
        if (!plugin.settings.inlayHints || !plugin.settings.inlayTypes) {
          return Decoration.none;
        }

        const { doc } = view.state;
        if (doc.lines !== 1) {
          return Decoration.none;
        }
        const line = doc.line(1);

        // Only evaluate when the line actually looks incomplete (ends in an operand-expecting
        // slot), so a complete expression costs no interpret.
        if (holeForm(line.text) === null) {
          return Decoration.none;
        }

        const type = holeType(line.text);
        if (type === null) {
          return Decoration.none;
        }

        const builder = new RangeSetBuilder<Decoration>();
        const widget = new InlayWidget("hole", type, endPadding(line.text, "hole"));
        builder.add(line.to, line.to, Decoration.widget({ widget, side: 1 }));

        return builder.finish();
      }
    },
    { decorations: (value) => value.decorations },
  );
}
