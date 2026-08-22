// Inline expression evaluation in the editor (Source mode + Live Preview).
//
// A CodeMirror 6 `ViewPlugin` that finds inline-eval spans in prose — `` n`expr` `` (live) and ``
// nc`expr ⇒ value` `` (concrete) — and, for each:
//
//   * dims the `n` / `nc` prefix and syntax-highlights `expr` (and a concrete span's materialized
//     value) with Numbat's own token classes;
//   * for a live span, paints a non-dimmed `= value` widget after the span that can be clicked to
//     commit the result into the note;
//   * for a concrete span, writes the computed value into the source, right of the `⇒` separator,
//     and keeps it in sync as `expr` changes.
//
// Spans are located with the pure scanner (evaluation/inline-parse.ts), which also skips fenced
// code and gathers the `numbat-shared` blocks. Evaluation is a single top-to-bottom replay of the
// note in one interpreter context (so a span sees every shared block and every earlier inline span
// above it), done off the update path, debounced, and cached by a signature that excludes the
// materialized value regions — so writing a concrete value back never triggers a re-evaluation
// loop.

import { Annotation, type Extension, type Range, StateEffect } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { type Editor, type EditorPosition } from "obsidian";
import { frontmatterBodyOf, scannedNote } from "../document/doc-cache";
import { sourcePathOf } from "../document/editor-file";
import { EvaluationCache } from "../interpreter/eval-cache";
import { escapeHtmlStrict } from "../interpreter/markup";
import {
  ask,
  ensureNumbatReady,
  interpreterGeneration,
  isNumbatReady,
  preludeReadsClockOrRandom,
  restartNumbat,
} from "../interpreter/numbat";
import { setNumbatHtml } from "../interpreter/render";
import type SymbatPlugin from "../main";
import { ensureReservedNames, notePreamble } from "../properties/note";
import { tokensForLine } from "../syntax/tokenizer";
import { semanticKind } from "../syntax/type-names";
import { INLINE_EVAL_CACHE_ENTRIES, INLINE_EVAL_DEBOUNCE_MS } from "../tuning";
import {
  DEFAULT_SEPARATOR,
  type InlineEvalConfig,
  type InlineResult,
  inlineScopeAt,
  type InlineSpan,
  MAX_DECIMAL_PLACES,
  noteReadsClockOrRandom,
  noteSignature,
  type NoteUnit,
  spanAtColumn,
} from "./inline-parse";

// CONFIGURATION
// ================================================================================================

/**
 * Dispatched after an off-path evaluation populates the cache, so the plugin rebuilds its
 * decorations to include the newly-available result widgets. Also dispatched by {@link
 * refreshNumbatInline} when the note scope changes out-of-band (a cross-note import's source note
 * was edited).
 */
const inlineEvalReady = StateEffect.define<void>();

/**
 * Nudge an editor's inline-eval widgets to recompute — its `build()` re-derives the note preamble
 * (picking up a changed cross-note import) and re-evaluates via the signature cache, so unchanged
 * notes cost nothing. Used by the plugin when an imported note changes; the effect dispatch also
 * repaints a background pane.
 */
export function refreshNumbatInline(view: EditorView): void {
  view.dispatch({ effects: inlineEvalReady.of() });
}

/**
 * Marks a transaction that only writes computed values into concrete spans, for clarity when
 * inspecting transactions (the value regions are excluded from the eval signature, so such a write
 * never itself schedules a re-evaluation).
 */
const materialization = Annotation.define<boolean>();

/**
 * The default decimal places from its setting: a non-negative integer string, capped; anything
 * else (blank included) reads as full precision.
 */
function defaultDecimalPlaces(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  return Math.min(Number(trimmed), MAX_DECIMAL_PLACES);
}

/** The inline-eval syntax and scope from the current settings (separator fixed). */
export function inlineConfig(plugin: SymbatPlugin): InlineEvalConfig {
  return {
    live: plugin.settings.inlineEvalLivePrefix,
    concrete: plugin.settings.inlineEvalConcretePrefix,
    separator: DEFAULT_SEPARATOR,
    frontmatter: plugin.settings.inlineEvalFrontmatter,
    codeBlocks: plugin.settings.inlineEvalCodeBlocks,
    decimalPlaces: defaultDecimalPlaces(plugin.settings.inlineEvalDecimalPlaces),
  };
}

/** The plain-text a commit writes for a span: `expr = value` or just `value`. */
export function commitText(expr: string, plain: string, retainExpr: boolean): string {
  return retainExpr ? `${expr} = ${plain}` : plain;
}

// RENDERING
// ================================================================================================

/**
 * Numbat-colored HTML for a plain value text, via the shared tokenizer — used for a rounded
 * display, whose text comes from a Numbat-formatted string rather than the formatter's own
 * HTML.
 */
function tokenizedHtml(text: string): string {
  let html = "";
  let at = 0;

  for (const token of tokensForLine(text, semanticKind)) {
    if (token.start > at) {
      html += escapeHtmlStrict(text.slice(at, token.start));
    }
    html += `<span class="${token.cls}">${escapeHtmlStrict(text.slice(token.start, token.end))}</span>`;
    at = token.end;
  }

  return html + escapeHtmlStrict(text.slice(at));
}

/** The single-class operator span Numbat's formatter emits for the leading `=`. */
const EQUALS_HTML = `<span class="numbat-operator">=</span>`;

/**
 * The bare-value HTML to display for a result: the tokenized rounded text when decimal places
 * applied, else the formatter's own fragment.
 */
export function displayValueHtml(result: InlineResult): string | null {
  if (result.rounded && result.plain !== null) {
    return tokenizedHtml(result.plain);
  }

  return result.valueHtml;
}

/**
 * The `= value` HTML to display for a result (widget / binding hint), rounded when decimal places
 * applied.
 */
export function displayResultHtml(result: InlineResult): string | null {
  if (result.rounded && result.plain !== null) {
    return `${EQUALS_HTML} ${tokenizedHtml(result.plain)}`;
  }

  return result.resultHtml;
}

/**
 * Replace an inline span (from its prefix to its closing backtick) with its committed plain-text
 * value, honoring the retain-expression setting.
 */
function commitSpan(view: EditorView, from: number, to: number, insert: string): void {
  view.dispatch({ changes: { from, to, insert } });
}

// WIDGETS
// ================================================================================================

/**
 * The non-dimmed, clickable `= value` widget shown after a live span. Renders the result with
 * Numbat's formatter colors (via {@link setNumbatHtml}); a click commits the span's value into the
 * note. Equality includes the span's position and committed text so the widget is recreated when
 * either changes (e.g. after a concrete write shifts later spans).
 */
class InlineResultWidget extends WidgetType {
  /**
   * @param plugin read at click time for the retain-expression setting, so a change to it takes
   *   effect without rebuilding the widgets.
   * @param html the result as formatter HTML, for display.
   * @param expr the span's source expression, kept when committing "expression and result".
   * @param plain the result as plain text — what is actually written into the note.
   * @param from document offset of the span's opening backtick.
   * @param to document offset one past its closing backtick.
   */
  constructor(
    private readonly plugin: SymbatPlugin,
    private readonly html: string,
    private readonly expr: string,
    private readonly plain: string,
    private readonly from: number,
    private readonly to: number,
  ) {
    super();
  }

  /**
   * Compare on the position as well as the text: committing one span shifts the ones after it, and
   * a widget that kept a stale `from`/`to` would overwrite the wrong range on click.
   */
  eq(other: InlineResultWidget): boolean {
    return other.html === this.html && other.expr === this.expr && other.plain === this.plain
      && other.from === this.from && other.to === this.to;
  }

  /** Build the clickable result element, wired to commit the span on mousedown. */
  toDOM(view: EditorView): HTMLElement {
    const span = createSpan({ cls: "numbat-inline-result" });
    span.setAttribute("aria-label", "Commit inline result");

    // A leading space so the widget sits one space off the closing backtick.
    span.appendText(" ");
    setNumbatHtml(span.createSpan(), this.html);
    span.addEventListener("mousedown", (event) => {
      // Handle the click ourselves; keep the editor from moving the cursor.
      event.preventDefault();
      event.stopPropagation();
      commitSpan(
        view,
        this.from,
        this.to,
        commitText(this.expr, this.plain, this.plugin.settings.inlineEvalRetainExpr),
      );
    });
    return span;
  }

  /** Keep CodeMirror out of the widget's events. */
  ignoreEvent(): boolean {
    // The DOM listener above still fires; this only keeps CodeMirror from also treating the
    // mousedown as an editor interaction.
    return true;
  }
}

/**
 * A non-interactive hint after a span, for a result that is informational rather than committable:
 * a `let` binding's evaluated value (`= 4`, formatter-colored), an error's summary line, or an
 * incomplete expression's missing-operand type as a `⟨Length⟩` placeholder. Styled like the
 * code-block inlay hints — dimmed and non-selectable — in contrast to the bright, clickable result
 * widget.
 */
class InlineHintWidget extends WidgetType {
  /**
   * @param kind selects both the CSS class and how `content` is rendered.
   * @param content formatter HTML for `binding`, plain text for `error` and `hole`.
   */
  constructor(private readonly kind: "binding" | "error" | "hole", private readonly content: string) {
    super();
  }

  /**
   * Compare by the two rendered inputs; unlike the result widget these carry no position, having
   * nothing to commit.
   */
  eq(other: InlineHintWidget): boolean {
    return other.kind === this.kind && other.content === this.content;
  }

  /** Build the hint element. */
  toDOM(): HTMLElement {
    const span = createSpan({ cls: `numbat-inline-hint numbat-inline-${this.kind}` });

    // A leading space so the hint sits one space off the closing backtick.
    span.appendText(" ");
    if (this.kind === "binding") {
      // Reuse Numbat's own formatter HTML so the value colors as rendered; a child span keeps the
      // pad text node clear of `setNumbatHtml`'s `empty()`.
      setNumbatHtml(span.createSpan(), this.content);
    } else if (this.kind === "hole") {
      span.appendText(`⟨${this.content}⟩`);
    } else {
      span.appendText(this.content);
    }
    return span;
  }

  /** Hints are decoration, not content: let events through to the editor. */
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * The hint widget for a result that shows one — a binding's value, an error summary, or a
 * typed-hole placeholder — or `null` (a committable value has the clickable widget instead; "none"
 * shows nothing).
 */
function hintFor(result: InlineResult): InlineHintWidget | null {
  if (result.kind === "binding") {
    const html = displayResultHtml(result);
    if (html !== null) {
      return new InlineHintWidget("binding", html);
    }
  }

  if (result.kind === "error" && result.errorText !== null) {
    return new InlineHintWidget("error", result.errorText);
  }

  if (result.kind === "hole" && result.holeType !== null) {
    return new InlineHintWidget("hole", result.holeType);
  }

  return null;
}

/** Whether any selection range intersects `[from, to]`. */
function overlapsSelection(view: EditorView, from: number, to: number): boolean {
  return view.state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

/**
 * The inline span whose expression region holds the caret in an Obsidian editor, when inline
 * evaluation is on and the caret line is in an inline-eval scope (prose, or frontmatter / a
 * non-numbat fence per the settings) — else `null`. Shared by the completion popovers' triggers
 * (completion/suggest.ts / unicode/suggest.ts), which extend their numbat-block gating to inline
 * spans. The scope walk reads every line above the caret, so callers run it after their cheap
 * per-keystroke checks, like the fence test.
 */
export function inlineSpanAtCursor(plugin: SymbatPlugin, editor: Editor, cursor: EditorPosition): InlineSpan | null {
  if (!plugin.settings.inlineEval) {
    return null;
  }

  const config = inlineConfig(plugin);
  const span = spanAtColumn(editor.getLine(cursor.line), cursor.ch, config);
  if (span === null) {
    return null;
  }

  const lines: string[] = [];
  for (let n = 0; n <= cursor.line; n += 1) {
    lines.push(editor.getLine(n));
  }

  return inlineScopeAt(lines, config) ? span : null;
}

// THE EDITOR EXTENSION
// ================================================================================================

/**
 * The inline-evaluation editor extension. Reads the plugin's inline-eval settings live, so
 * `refreshInlineEval()` (which reconfigures the editors) is all a toggle needs.
 */
export function numbatInlineEval(plugin: SymbatPlugin): Extension {
  return ViewPlugin.fromClass(
    class {
      /** The span decorations CodeMirror is painting, republished on every build. */
      decorations: DecorationSet;

      /** Cached note evaluations, keyed by {@link noteSignature}. */
      private readonly cache = new EvaluationCache<InlineResult[]>(INLINE_EVAL_CACHE_ENTRIES);

      /** The pending debounced evaluation, or `null` when none is scheduled. */
      private timer: number | null = null;

      /**
       * The pending debounced write-back of concrete spans; separate from {@link timer} because it
       * is driven by caret movement as well as edits.
       */
      private materializeTimer: number | null = null;

      /** Set on teardown, so work already in flight discards its results. */
      private destroyed = false;

      /** Paint whatever is already cached; a miss schedules the evaluation. */
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      /**
       * Rebuild on text, viewport or out-of-band changes, and separately re-attempt the concrete
       * write-back whenever the caret or the text moves.
       */
      update(update: ViewUpdate): void {
        const arrived = update.transactions.some((tr) => tr.effects.some((e) => e.is(inlineEvalReady)));
        if (update.docChanged || update.viewportChanged || arrived) {
          this.decorations = this.build(update.view);
        }

        // A concrete write-back is withheld while the caret sits inside the span (never fight an
        // active edit), so it must be re-attempted when the caret moves — a selection-only update —
        // as well as after edits (e.g. a stale value pasted in). Cache misses are the evaluation
        // pass's job instead.
        if (update.selectionSet || update.docChanged) {
          this.scheduleMaterialize(update.view);
        }
      }

      /** Cancel both pending passes with the view. */
      destroy(): void {
        this.destroyed = true;
        if (this.timer !== null) {
          window.clearTimeout(this.timer);
        }
        if (this.materializeTimer !== null) {
          window.clearTimeout(this.materializeTimer);
        }
      }

      /**
       * Build the decoration set: prefix-dim + expr highlight for every visible span, plus a result
       * widget for each visible live span whose evaluation is cached. Schedules an evaluation when
       * the note's signature is not yet cached.
       */
      private build(view: EditorView): DecorationSet {
        if (!plugin.settings.inlineEval) {
          return Decoration.none;
        }

        const config = inlineConfig(plugin);
        const { doc } = view.state;
        const units = scannedNote(doc, config);
        if (!units.some((unit) => unit.kind === "inline")) {
          return Decoration.none;
        }

        const preamble = notePreamble(plugin, frontmatterBodyOf(doc), sourcePathOf(view));
        const signature = noteSignature(interpreterGeneration(), preamble.source, units, config);
        // A stale hit still paints, and also asks for a newer one — the same two-sided use the
        // frontmatter inlays make of an aged property outcome. Treating it as a miss instead would
        // blank every span of a note containing `now()` for the length of a standard-library load,
        // every ten seconds, which is a worse answer than a value a moment out of date.
        const hit = this.cache.get(signature);
        const results = hit?.value;
        if (hit === null || !hit.fresh) {
          this.scheduleEvaluation(view);
        }

        const ranges: Range<Decoration>[] = [];
        let inlineIndex = -1;
        for (const unit of units) {
          if (unit.kind !== "inline") {
            continue;
          }
          inlineIndex += 1;

          const docLine = unit.line + 1;
          if (docLine > doc.lines) {
            continue;
          }

          const line = doc.line(docLine);
          if (!this.isVisible(view, line.from, line.to)) {
            continue;
          }
          addHighlight(ranges, line.from, line.text, unit.span);

          const result = results?.[inlineIndex];
          if (result === undefined) {
            continue;
          }

          const at = line.from + unit.span.closeEnd;
          const widgetHtml = result.kind === "value" ? displayResultHtml(result) : null;

          if (unit.span.variant === "live" && widgetHtml !== null && result.plain !== null) {
            // A committable value: the bright, clickable widget. (A concrete span's value is
            // materialized into the text instead.)
            const widget = new InlineResultWidget(
              plugin,
              widgetHtml,
              unit.span.expr,
              result.plain,
              line.from + unit.span.prefixStart,
              at,
            );
            ranges.push(Decoration.widget({ widget, side: 1 }).range(at));
          } else {
            // Informational outcomes — a binding's value, an error summary, a typed-hole
            // placeholder — show as muted hints on both variants.
            const hint = hintFor(result);
            if (hint !== null) {
              ranges.push(Decoration.widget({ widget: hint, side: 1 }).range(at));
            }
          }
        }

        return Decoration.set(ranges, true);
      }

      /**
       * Whether `[from, to]` overlaps anything the editor is currently showing, so off-screen
       * spans cost no decorations.
       */
      private isVisible(view: EditorView, from: number, to: number): boolean {
        return view.visibleRanges.some((range) => from <= range.to && to >= range.from);
      }

      /** Debounce a re-evaluation of the note, restarting the wait on each call. */
      private scheduleEvaluation(view: EditorView): void {
        if (this.timer !== null) {
          window.clearTimeout(this.timer);
        }

        this.timer = window.setTimeout(() => {
          this.timer = null;
          void this.evaluate(view);
        }, INLINE_EVAL_DEBOUNCE_MS);
      }

      /**
       * Debounced retry of the concrete write-back against the *cached* results (a fresh
       * evaluation dispatches its own; see {@link evaluate}).
       */
      private scheduleMaterialize(view: EditorView): void {
        if (this.materializeTimer !== null) {
          window.clearTimeout(this.materializeTimer);
        }

        this.materializeTimer = window.setTimeout(() => {
          this.materializeTimer = null;
          this.materialize(view);
        }, INLINE_EVAL_DEBOUNCE_MS);
      }

      /**
       * Write any stale concrete values back from the cached evaluation. This is what lands the
       * write once the caret leaves a span it was protecting (the evaluation pass only runs on a
       * cache miss, and the signature excludes the value regions — so without this retry a value
       * first computed while the caret sat inside the span would never materialize). The dispatch
       * converges: its own update finds nothing left to rewrite.
       */
      private materialize(view: EditorView): void {
        if (this.destroyed || !plugin.settings.inlineEval || view.composing) {
          return;
        }

        const config = inlineConfig(plugin);
        const { doc } = view.state;
        const units = scannedNote(doc, config);
        const preamble = notePreamble(plugin, frontmatterBodyOf(doc), sourcePathOf(view));
        // Freshness is not consulted: this writes a computed value into the document because the
        // reader asked it to, and last second's answer is the one they were looking at when they
        // asked.
        const results = this.cache.get(noteSignature(interpreterGeneration(), preamble.source, units, config))
          ?.value;
        if (results === undefined) {
          return;
        }

        const changes = concreteChanges(view, units, results, config);
        if (changes.length > 0) {
          view.dispatch({ changes, annotations: materialization.of(true) });
        }
      }

      /**
       * Off-path: ensure the interpreter is ready, replay the note, cache the results, write any
       * stale concrete values back, and ask the view to rebuild its decorations. Operates on the
       * *live* document (not a stale snapshot).
       */
      private async evaluate(view: EditorView): Promise<void> {
        try {
          await ensureNumbatReady();
          await plugin.ensureExchangeRates();
          await plugin.ensurePrelude();
        } catch (error) {
          // A rejected init leaves `readyPromise` rejected for good; only a restart clears it.
          // Without this the surface would stay dead for the session unless some other one happened
          // to trigger the retry.
          console.error("Symbat: inline evaluation could not initialize the interpreter", error);
          restartNumbat();
          return;
        }

        if (this.destroyed || !isNumbatReady()) {
          return;
        }

        const config = inlineConfig(plugin);
        const { doc } = view.state;
        void ensureReservedNames(plugin.settings.fetchExchangeRates);

        const units = scannedNote(doc, config);
        const preamble = notePreamble(plugin, frontmatterBodyOf(doc), sourcePathOf(view));
        const signature = noteSignature(interpreterGeneration(), preamble.source, units, config);
        const noteImpure = preludeReadsClockOrRandom() || noteReadsClockOrRandom(preamble.source, units);
        if (this.cache.hasFresh(signature)) {
          return; // Raced with another pass; nothing to do.
        }

        // The note's allowance is stated: a wall-clock deadline held across the request would
        // charge the note for the time the request spent waiting to be served. One context serves
        // the whole note over there, and there is no head check on this path. Past the deadline
        // every span comes back as an ordinary error result. That is deliberate: the alternative,
        // answering nothing, would leave the signature uncached, so the next rebuild would find the
        // same work outstanding and schedule the same pass again, at the debounce, for the rest of
        // the session.
        //
        // Grouped by note, so a reader typing supersedes their own previous request rather than
        // queueing a standard-library load per keystroke behind it.
        const budgeted = await ask("evalNoteUnits", {
          units,
          applyRates: plugin.settings.fetchExchangeRates,
          config,
          preamble,
          budget: { budgetMs: plugin.settings.evaluationLimitMs, key: sourcePathOf(view) },
        }, { group: `inline:${sourcePathOf(view) ?? ""}`, note: sourcePathOf(view) ?? undefined });

        if (budgeted === null || this.destroyed) {
          return;
        }

        if (budgeted.exceeded) {
          // As in the inlay pass: reported, not filed in the refusal ledger. The signature this is
          // cached under moves with the buffer, so the refusal is found again without re-evaluating
          // — provided it does not age out, which is what `!exceeded` below is for.
          plugin.reportEvaluationLimit(sourcePathOf(view) ?? "");
        }

        const results = [...budgeted.value];

        // Never age a refusal. An answer the limit cut short is not a value the clock can change,
        // so re-asking for it would spend the whole allowance again to be told the same thing and
        // the note's own text is the only thing that can make the answer different. This is what
        // keeps a note that reads `now()` *and* exceeds the limit from freezing once every window
        // for the rest of the session, which is the retry the buffer key used to prevent by itself.
        this.cache.set(signature, results, !budgeted.exceeded && noteImpure);

        // The document is re-checked before anything is *written* to it, and only then. The results
        // were computed against `doc`, and the await in front of them is a window a fast typist can
        // land an edit in; a concrete span materialized against a document that has moved would be
        // written at the wrong offsets. Repainting decorations is safe either way as they are
        // rebuilt from the live state, so the effect is dispatched regardless.
        const changes = view.state.doc === doc ? concreteChanges(view, units, results, config) : [];
        if (changes.length > 0) {
          view.dispatch({ changes, effects: inlineEvalReady.of(), annotations: materialization.of(true) });
        } else {
          view.dispatch({ effects: inlineEvalReady.of() });
        }
      }
    },
    { decorations: (value) => value.decorations },
  );
}

// SYNTAX HIGHLIGHTING THE EXPRESSION
// ================================================================================================

/**
 * Append the highlight decorations for one span to `ranges`: the dimmed prefix, a dimmed `{…}`
 * config (when present), the tokenized expression, and — for a concrete span with a materialized
 * value — the dimmed separator and the tokenized value. `lineFrom` is the document offset of the
 * span's line; `lineText` is that line's text.
 */
function addHighlight(
  ranges: Range<Decoration>[],
  lineFrom: number,
  lineText: string,
  span: InlineSpan,
): void {
  ranges.push(
    Decoration.mark({ class: "numbat-inline-prefix" }).range(
      lineFrom + span.prefixStart,
      lineFrom + span.openTickStart,
    ),
  );

  if (span.exprStart > span.contentStart) {
    // The `{…}` config reads as a marker, like the prefix — dimmed, not code.
    ranges.push(
      Decoration.mark({ class: "numbat-inline-config" }).range(
        lineFrom + span.contentStart,
        lineFrom + span.exprStart,
      ),
    );
  }
  tokenize(ranges, lineFrom + span.exprStart, lineText.slice(span.exprStart, span.exprEnd));

  if (span.separatorAt !== null && span.separatorText !== null) {
    const sepEnd = span.separatorAt + span.separatorText.length;
    ranges.push(
      Decoration.mark({ class: "numbat-inline-sep" }).range(lineFrom + span.separatorAt, lineFrom + sepEnd),
    );
    tokenize(ranges, lineFrom + sepEnd, lineText.slice(sepEnd, span.contentEnd));
  }
}

/** Push Numbat token marks for `text`, offset so `text[0]` sits at document `base`. */
function tokenize(ranges: Range<Decoration>[], base: number, text: string): void {
  for (const token of tokensForLine(text, semanticKind)) {
    ranges.push(Decoration.mark({ class: token.cls }).range(base + token.start, base + token.end));
  }
}

/**
 * The document changes needed to bring concrete spans in sync with an evaluation, in document order
 * (ascending, non-overlapping). A span is skipped when its value (and separator) are already in
 * sync, when the expression produced no committable value — an error keeps the last good value in
 * place, and a binding/hole shows as a hint instead — or when the user's selection is inside the
 * region that would be rewritten (so an active edit is never clobbered).
 */
function concreteChanges(
  view: EditorView,
  units: NoteUnit[],
  results: InlineResult[],
  config: InlineEvalConfig,
): { from: number; to: number; insert: string; }[] {
  const { doc } = view.state;
  const changes: { from: number; to: number; insert: string; }[] = [];

  let inlineIndex = -1;
  for (const unit of units) {
    if (unit.kind !== "inline") {
      continue;
    }
    inlineIndex += 1;

    const { span } = unit;
    if (span.variant !== "concrete") {
      continue;
    }

    const result = results[inlineIndex];
    if (result === undefined || result.kind !== "value" || result.plain === null) {
      continue;
    }

    const docLine = unit.line + 1;
    if (docLine > doc.lines) {
      continue;
    }

    const lineFrom = doc.line(docLine).from;
    if (span.separatorAt !== null && span.separatorText !== null) {
      // Rewrite from the separator (normalizing a typed `=>` alias to the real one); protect the
      // whole region while it is being edited.
      const from = lineFrom + span.separatorAt;
      const to = lineFrom + span.contentEnd;
      const inSync = span.resultText === result.plain && span.separatorText === config.separator;

      if (inSync || overlapsSelection(view, from, to)) {
        continue;
      }

      changes.push({ from, to, insert: `${config.separator} ${result.plain}` });
    } else {
      // No separator yet: introduce ` ⇒ value`, but only once the caret has left the expression (so
      // it is not inserted in the middle of typing).
      const at = lineFrom + span.contentEnd;
      if (overlapsSelection(view, lineFrom + span.contentStart, at)) {
        continue;
      }
      changes.push({ from: at, to: at, insert: ` ${config.separator} ${result.plain}` });
    }
  }

  return changes;
}
