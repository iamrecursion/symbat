// The `Numbat` property type: a custom entry in Obsidian's property-type registry
// (`metadataTypeManager.registeredTypeWidgets` — the same undocumented registry Obsidian's own
// widgets and Better Properties use, so both coexist). A property assigned this type holds a Numbat
// expression; the widget shows the expression in a monospace input with a live `= value` annotation
// after it, evaluated in the note's property scope (the bindings of the properties above it —
// mirroring exactly what the note preamble replay defines). The binding side lives in
// properties/note.ts; this file is only the type + widget.
//
// The same widget is what Bases draws in a table or card cell — Obsidian gives both surfaces one
// registry and one `render`. A cell is a box in a grid rather than a line of its own, so there it
// shows the *value* until it is clicked into, and builds no editor until then (properties/host.ts
// draws the distinction, properties/display.ts says what each state shows).

import type { CompletionInfo } from "../completion/docs";
import {
  type ExprCategories,
  type ExprCategory,
  type ExprCompletion,
  expressionCompletions,
} from "../completion/expressions";
import { holeForm, parseHoleType } from "../evaluation/inlay-parse";
import { symbolCard } from "../hover/content";
import type { HoverSymbol } from "../hover/parse";
import {
  completionInfo,
  completionSignature,
  ensureBlockCompletion,
  expressionCompletionCandidates,
  interpret,
  isNumbatReady,
  structFields,
  touchCompletionIdle,
} from "../interpreter/numbat";
import { setNumbatHtml } from "../interpreter/render";
import type SymbatPlugin from "../main";
import { PROPERTY_EVAL_DEBOUNCE_MS } from "../tuning";
import { NumbatInput } from "../views/input";
import { type DisplayMode, displayPlan, type PropertyDisplay } from "./display";
import { deferFocusCheck } from "./focus-guard";
import { ACTIVE_CLASS, COMPACT_CLASS, resolveHost, windowFor } from "./host";
import {
  NUMBAT_PROPERTY_TYPE,
  preambleForFile,
  primeReservedNames,
  propertyTypeManager,
  type PropertyWidgetContext,
  scopeChunksAbove,
} from "./note";
import { evaluateLiveOutcome, outcomeEpoch, requestNoteOutcomes, resolveOutcome } from "./note-outcomes";
import { tintedIcon } from "./registry";

// REGISTERING THE TYPE
// ================================================================================================

/**
 * Register the `Numbat` property type. On an Obsidian without the registry the feature quietly does
 * not exist (properties can still bind by being numbers). The registration is reverted on plugin
 * unload; a property left assigned the type then renders with Obsidian's fallback text widget until
 * re-enable.
 */
export function registerNumbatPropertyType(plugin: SymbatPlugin): void {
  const manager = propertyTypeManager(plugin.app);
  const widgets = manager?.registeredTypeWidgets;
  if (manager === null || widgets === undefined) {
    console.error("Symbat: this Obsidian exposes no property-type registry; the Numbat property type is unavailable");
    return;
  }

  const widget = {
    type: NUMBAT_PROPERTY_TYPE,
    // Our own copy of the glyph, tinted green — the tell that this type came from a plugin rather
    // than from Obsidian (properties/registry.ts).
    icon: tintedIcon("calculator"),
    name: () => "Numbat",
    // What Obsidian considers an assignable value for this type: the expression text (a bare number
    // is how YAML stores an unquoted numeric expression).
    validate: (value: unknown) => typeof value === "string" || typeof value === "number",
    render: (el: HTMLElement, value: unknown, ctx: PropertyWidgetContext) => renderWidget(plugin, el, value, ctx),
  };

  widgets[NUMBAT_PROPERTY_TYPE] = widget;
  manager.trigger?.("changed");
  plugin.register(() => {
    // Removed only if the entry is still this one — see properties/date-type.ts for the rule and
    // its two other applications. A plugin that wrapped this type keeps its wrapper rather than
    // being uninstalled by our unload.
    if (widgets[NUMBAT_PROPERTY_TYPE] !== widget) {
      return;
    }

    delete widgets[NUMBAT_PROPERTY_TYPE];
    manager.trigger?.("changed");
  });
}

// THE LIVE EDITORS
// ================================================================================================

/**
 * Live property editors, so they can be destroyed. Obsidian's property-widget contract has no
 * teardown hook — `render` returns only `{ focus }` — and the metadata editor re-renders rows
 * freely, so an editor whose row has gone would otherwise keep its listeners and its documentation
 * popup forever.
 *
 * Every `render` sweeps: an editor whose element has left the document is dead, and there are only
 * ever a handful. That is cheaper and less fragile than observing mutations, and it self-heals —
 * the next render of any property cleans up after every row that has been discarded since.
 *
 * `attached` is what makes "has left the document" mean that. Obsidian renders a widget into a
 * **detached** element and inserts it afterwards, and it renders a whole object's rows in one pass
 * — so a naive `!isConnected` sweep destroyed every editor the moment the *next* row rendered,
 * leaving only the last property of the note with a visible field. An editor is therefore only ever
 * swept once it has been seen in the document.
 */
interface LiveEditor {
  /** The element the editor was rendered into — what the sweep tests for connectedness. */
  el: HTMLElement;

  /**
   * The CodeMirror input hosted in it, destroyed when the row is swept — and `null` whenever there
   * is none, which in a compact host (properties/host.ts) is most of the time: a Base cell shows
   * its value until it is clicked into, and builds no editor until then.
   *
   * The entry is registered whether or not there is an editor, because what the sweep must reach is
   * {@link cancelPending} — the debounced *evaluation*, which every row has.
   */
  input: NumbatInput | null;

  /** Whether {@link el} has ever been seen in the document. Until it has, the row is exempt from
   *  sweeping: Obsidian renders into a detached element and inserts it afterwards, so a naive check
   *  would destroy each editor as the next rendered. */
  attached: boolean;

  /** The row's pending debounced evaluation, cancelled when the row is swept. Held here rather than
   *  in the render closure so the sweep can reach it: a timer left to fire after unload rebuilds —
   *  and re-*initialises* — the wasm module that `onunload` has just released. */
  cancelPending: () => void;

  /** Start the row's evaluation over: disown whatever is in flight and schedule a fresh round. What
   *  {@link refreshPropertyEditors} reaches every row through. */
  refresh: () => void;
}

// Every property editor currently alive. Module-level because Obsidian gives the widget no teardown
// hook: the plugin sweeps this set instead, on re-render and on unload.
const liveEditors = new Set<LiveEditor>();

/**
 * Destroy the editors whose rows are gone, and (on unload) all of them.
 *
 * Deliberately `destroy()` rather than the widget's own `deactivate` — a swept row is one Obsidian
 * has already discarded, and `deactivate` commits. Committing into a discarded row's context (or,
 * on unload, into every row at once) would have the plugin writing to notes as it is torn down.
 */
function sweepEditors(all = false): void {
  for (const entry of [...liveEditors]) {
    if (all) {
      entry.cancelPending();
      entry.input?.destroy();
      entry.input = null;
      liveEditors.delete(entry);
      continue;
    }

    if (entry.el.isConnected) {
      entry.attached = true;
    } else if (entry.attached) {
      entry.cancelPending();
      entry.input?.destroy();
      entry.input = null;
      liveEditors.delete(entry);
    }
  }
}

/**
 * The widget: a Numbat expression editor plus a muted result annotation — or, in a compact host
 * (properties/host.ts), the value on its own until the cell is clicked into.
 *
 * The two states share everything but the editor. Evaluation runs from the widget's *text* rather
 * than from the editor (`propertyOutcome` takes a string), so an idle cell shows its value with no
 * CodeMirror in existence; and one outcome carries both shapes it can be shown in, so clicking into
 * a cell repaints rather than re-evaluating. That matters: an evaluation costs a fresh interpreter
 * context — the whole standard library — and a click should not.
 */
function renderWidget(
  plugin: SymbatPlugin,
  el: HTMLElement,
  value: unknown,
  ctx: PropertyWidgetContext,
): { focus: () => void; } {
  sweepEditors();
  el.addClass("numbat-property");
  const committed = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const fieldEl = el.createDiv({ cls: "numbat-property-input" });
  const resultEl = el.createSpan({ cls: "numbat-property-result" });

  // Guessed now and corrected on the next frame if the guess was the wrong way round — the shared
  // dance, so that this widget and the zoned one cannot drift apart on it (properties/host.ts).
  const host = resolveHost(el, () => {
    // Both classes, not just the compact one: a row corrected between the press that opened it and
    // the frame that answered is a panel row holding an editor, and `is-active` says "a cell the
    // reader has clicked into", which a panel row is never one of.
    el.removeClasses([COMPACT_CLASS, ACTIVE_CLASS]);
    activate();
  });
  el.toggleClass(COMPACT_CLASS, host() === "compact");

  // The widget's value, whether or not an editor is holding it. The editor is authoritative while
  // it exists (`changed` writes through, `deactivate` reads back), and this is what the idle row
  // shows, what an evaluation runs, and what a commit writes.
  let text = committed;

  // The last evaluation's outcome, kept so that activating or deactivating can repaint it in the
  // other shape without evaluating again.
  let outcome: PropertyDisplay = { kind: "empty" };

  let timer: number | null = null;

  // Stops waiting on the note's batch, where this row is waiting on one. Held because the batch
  // outlives the row: a swept editor that stays in the waiter set is a callback into a DOM that is
  // gone (properties/outcome-cache.ts).
  let unwait: (() => void) | null = null;

  let generation = 0;
  const cancelPending = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }

    unwait?.();
    unwait = null;

    // Also disowns any evaluation already in flight: `pass === generation` can no longer hold, so a
    // resolved outcome is dropped rather than written.
    generation += 1;
  };

  const entry: LiveEditor = {
    el,
    input: null,
    attached: el.isConnected,
    cancelPending,
    // Through `cancelPending` rather than straight to the debounce: a refresh means something the
    // row cannot see has moved, so a round already in flight is answering the old question and is
    // disowned rather than raced.
    refresh: () => {
      cancelPending();
      scheduleEvaluate();
    },
  };
  liveEditors.add(entry);

  // With no editor beside it the result *is* the cell's content, so it shows the bare value rather
  // than the `= value` fragment — and falls back to the expression itself when there is nothing to
  // show, so that a column of properties is never a column of blanks (see {@link displayPlan}).
  const paint = () => {
    showOutcome(resultEl, outcome, { bare: entry.input === null, fallback: text });
  };

  /**
   * Learn this row's outcome, by whichever path can produce it (properties/note-outcomes.ts).
   *
   * The mode is resolved *here* rather than when the evaluation was scheduled, because the debounce
   * is exactly the window in which it changes: a keystroke puts the row on the live path, and the
   * commit that follows puts it back on the note's.
   */
  const evaluate = () => {
    // Any earlier round is superseded, including one still waiting on a batch: two waiters for one
    // row would both fire, and the second's cancel would be the only one this closure still held.
    unwait?.();
    unwait = null;

    const pass = ++generation;
    const apply = (next: PropertyDisplay | null) => {
      // Stale passes and torn-down rows (the metadata editor re-renders liberally) must not write
      // into the DOM, and a path that learned nothing leaves the row showing what it had.
      if (next === null || pass !== generation || !resultEl.isConnected) {
        return;
      }

      outcome = next;
      paint();
    };

    // Resolved again rather than trusted from the render: the note may have been evaluated by
    // another row's batch while this row's debounce was running, in which case there is nothing
    // left to ask for.
    const resolved = resolveOutcome(plugin, ctx, text);
    if (resolved.mode === "none" || resolved.fresh) {
      apply(resolved.display);
      return;
    }

    // The note's committed value: one pass answers this row and every other row of the note, so
    // this waits on that pass rather than starting an evaluation of its own.
    if (resolved.mode === "note") {
      const asked = preambleForFile(plugin, ctx.sourcePath ?? "");
      const askedEpoch = outcomeEpoch();
      unwait = requestNoteOutcomes(plugin, asked, () => {
        if (pass === generation) {
          unwait = null;
        }

        apply(resolveOutcome(plugin, ctx, text).display);
        if (pass !== generation) {
          return;
        }

        // A pass answers one scope, out of one set of caches. Two things leave what finished not an
        // answer to what is being asked, and neither comes back around on its own:
        //
        //   - **The note moved.** A property *above* this row was edited, which changes this row's
        //     key without re-rendering this row.
        //   - **The caches were emptied while the pass was booting** (e.g. a new prelude, refetched
        //     exchange rates) so it abandoned itself rather than file answers about a world that
        //     had moved. That is not rare: the first batch of a session is usually the caller that
        //     triggers the initial rate load, and so is usually the one it happens to.
        //
        // {@link refreshPropertyEditors} normally reaches the second case first, since the same
        // call that empties the caches sweeps these rows. This is the local guarantee, so that a
        // row waiting on a pass never depends on someone else having noticed.
        //
        // Gated on one of the two having happened rather than on the answer being unsatisfying: a
        // pass that simply *failed* must not turn into a retry every debounce for the rest of the
        // session. Both of these are events, so both stop.
        if (
          preambleForFile(plugin, ctx.sourcePath ?? "").source !== asked.source
          || outcomeEpoch() !== askedEpoch
        ) {
          scheduleEvaluate();
        }
      });
      return;
    }

    void evaluateLiveOutcome(plugin, ctx, text).then(apply);
  };

  const scheduleEvaluate = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(() => {
      timer = null;
      evaluate();
    }, PROPERTY_EVAL_DEBOUNCE_MS);
  };

  // Enter commits and then blurs, and blur commits too, so this must be idempotent — otherwise
  // accepting with Enter would write the value twice.
  let written = committed;
  const commit = () => {
    if (text !== written) {
      written = text;
      ctx.onChange?.(text);
    }
  };

  /**
   * Build the editor and hand the field over to it. Idempotent and synchronous, because the handle
   * returned to Obsidian focuses through it and a click must open the field in the same gesture.
   */
  const activate = (): NumbatInput => {
    const live = entry.input;
    if (live !== null) {
      return live;
    }

    // Only a cell has an idle state to be active *instead of*. A panel row is always an editor, and
    // `is-active` on one would be this plugin putting an Obsidian-flavored class on an element in
    // Obsidian's own metadata DOM to mean nothing at all.
    if (host() === "compact") {
      el.addClass(ACTIVE_CLASS);
    }

    const input: NumbatInput = new NumbatInput(fieldEl, plugin, {
      // Enter accepts, which for a property means committing (blur commits too, the shape
      // Obsidian's own text widgets use).
      submit: () => {
        commit();
        input.blur();
      },
      changed: () => {
        text = input.getValue();
        scheduleEvaluate();
      },
      blurred: () => {
        commit();
        scheduleDeactivate();
      },
      ...propertyCompletions(plugin, ctx),
    }, {
      highlight: true, // a Numbat property is Numbat code, with no prose to disturb
      vimMode: false,
      inlayHoles: plugin.settings.inlayHints && plugin.settings.inlayTypes,
      hover: plugin.settings.hover,
      placeholder: "Numbat expression",
      singleLine: true,
      expressionOnly: true, // a property commits a value, so there is no declaration to decorate
    });

    input.setValue(text);
    entry.input = input;
    paint();

    // The field was empty (and, in a compact host, laid out as nothing) until this moment, so
    // CodeMirror has never measured itself against it.
    input.refresh();
    return input;
  };

  /** Give the field back to the value. Compact hosts only — a property row keeps its editor. */
  const deactivate = () => {
    const input = entry.input;
    if (input === null || host() === "panel") {
      return;
    }

    text = input.getValue();
    entry.input = null;
    input.destroy();
    fieldEl.empty();
    el.removeClass(ACTIVE_CLASS);
    paint();
  };

  /**
   * Deactivate once it is clear the reader has actually left.
   *
   * Deferred because at blur time `document.activeElement` is still `body` — focus has left the
   * editor and not yet arrived anywhere — so nothing can be concluded yet. What it is guarding
   * against is that half of what the editor offers is drawn outside it: pressing a completion, a
   * documentation popup or a hover card blurs the field without the reader having gone anywhere
   * (properties/focus-guard.ts). An open completion popup owns the field outright, so the question
   * is dropped rather than asked at all — closing the popup blurs the editor afresh.
   */
  const scheduleDeactivate = () => {
    if (host() === "panel") {
      return;
    }

    deferFocusCheck(el, deactivate, () => entry.input?.completionOpen() === false);
  };

  // A press anywhere on an idle cell opens the field. `mousedown` rather than `click`, and the
  // default suppressed, so there is one focus transition instead of two — otherwise the press
  // focuses the cell and the editor built underneath it is blurred the moment it appears. Nothing
  // is lost by not selecting the idle text: it is a rendered value, not the property's source.
  el.addEventListener("mousedown", (event) => {
    // The primary button only. A right-click is asking for a context menu, and suppressing its
    // default to build an editor nobody asked for would take Obsidian's own away.
    if (event.button !== 0 || host() === "panel" || entry.input !== null) {
      return; // the editor owns its own presses
    }

    event.preventDefault();
    activate().focus();
  });

  if (host() === "panel") {
    activate();
  }

  // The row is usually still detached here (Obsidian inserts it after rendering), so the editor is
  // built against no layout at all. One frame later it is in the document: note that it arrived —
  // the sweep keys off it — and let CodeMirror measure itself now that there is something to
  // measure.
  //
  // Queued after `resolveHost`'s own frame, so a row that turns out to be a panel one has already
  // been corrected and had its editor built by the time this measures it. Asked of the row's own
  // window, which in a popped-out leaf is not this module's (properties/host.ts).
  windowFor(el)?.requestAnimationFrame(() => {
    if (!entry.el.isConnected) {
      return;
    }

    entry.attached = true;
    entry.input?.refresh();
  });

  // A value already evaluated in this scope paints immediately rather than after the debounce, so a
  // Base column that has been scrolled past once does not go back to raw expressions every time it
  // scrolls back into view. A property the frontmatter alone can answer (a reserved name, a
  // warned-about zero) is answered here too, rather than after awaiting an interpreter to be told
  // what the derivation already knew.
  const resolved = resolveOutcome(plugin, ctx, text);
  if (resolved.display !== null) {
    outcome = resolved.display;
  }

  paint();

  // Debounced rather than immediate. Obsidian re-renders a whole object's rows in one pass and does
  // so liberally, so this collapses the pass into one round of work per row and the note batch
  // behind it then collapses those rounds into one evaluation for the whole note.
  //
  // Skipped outright on a *fresh* hit: the key covers everything the evaluation would read except
  // the clock, so within `OUTCOME_FRESH_MS` re-running it could only reproduce the value already
  // painted above. That is what keeps a scrolled Base column from evaluating at all; an older hit
  // is painted but re-evaluated, so nothing reading the clock stays still.
  if (!resolved.fresh) {
    scheduleEvaluate();
  }

  return { focus: () => activate().focus() };
}

/** Release every property editor (plugin unload). */
export function disposePropertyEditors(): void {
  sweepEditors(true);
}

/**
 * Ask every property row on screen to evaluate again.
 *
 * The counterpart to `nudgeOpenEditors` for the one surface it cannot reach. Obsidian owns these
 * rows and offers no way to re-render one, so a change that no cache key can see (a new prelude,
 * refetched rates, the reset command) reaches every CodeMirror surface and none of these. The row
 * goes on painting the outcome held in its render closure, which is the answer to a question nobody
 * is asking any more; and if it happened to be waiting on a property batch when the caches were
 * emptied, it is waiting on a pass that will abandon itself and tell it nothing.
 *
 * Cheap in the ordinary case, and cheap *because* the keys are honest: a row that asks again
 * re-reads the cache first, so all this costs for a property whose answer did not move is a map
 * lookup. That is what lets it be called from the narrow invalidation (`refreshPropertyTypes`) as
 * well as the wide one.
 *
 * Rows that have left the document are swept rather than refreshed, so this cannot resurrect work
 * for a row Obsidian has discarded.
 */
export function refreshPropertyEditors(): void {
  sweepEditors();

  for (const entry of [...liveEditors]) {
    entry.refresh();
  }
}

// COMPLETION
// ================================================================================================

/**
 * The completion half of the widget's host: the same engine, rows, signatures and documentation the
 * editor and the REPL use, resolved against the scope this property actually has — the note's
 * imports and the properties written above it, which is exactly what its value evaluates in.
 *
 * The context comes from `ensureBlockCompletion`, keyed on those chunks, so it is built once per
 * distinct scope rather than per keystroke. Everything degrades to "no completions" while the wasm
 * is still loading.
 */
function propertyCompletions(plugin: SymbatPlugin, ctx: PropertyWidgetContext): {
  exprCompletions: (
    query: string,
    enabled: ExprCategories,
    allowed: ReadonlySet<ExprCategory> | null,
  ) => ExprCompletion[];
  memberFields: (base: string) => string[];
  completionSignature: (name: string) => string | null;
  completionInfo: (name: string) => CompletionInfo | null;
  hoverCard: (symbol: HoverSymbol) => HTMLElement | null;
  holeType: (input: string) => string | null;
} {
  const built = () => {
    if (!plugin.settings.noteProperties || !isNumbatReady()) {
      return null;
    }

    primeReservedNames(plugin.settings.fetchExchangeRates);
    const preamble = preambleForFile(plugin, ctx.sourcePath ?? "");
    const chunks = scopeChunksAbove(preamble, ctx.key ?? "");

    const context = ensureBlockCompletion(chunks, plugin.settings.fetchExchangeRates);
    if (context !== null) {
      touchCompletionIdle(plugin.settings.completionIdleSeconds * 1000);
    }

    return context;
  };
  return {
    exprCompletions: (query, enabled, allowed) => {
      if (!plugin.settings.exprCompletion) {
        return [];
      }

      const scope = built();
      if (scope === null) {
        return [];
      }

      const raw = expressionCompletionCandidates(scope.context, query);
      return expressionCompletions(raw, scope.vocab, enabled, allowed);
    },
    memberFields: (base) => {
      const scope = built();
      return scope === null ? [] : structFields(scope.context, base);
    },
    completionSignature: (name) => {
      const scope = built();
      return scope === null ? null : completionSignature(scope.context, name);
    },
    completionInfo: (name) => {
      const scope = built();
      return scope === null ? null : completionInfo(scope.context, name);
    },
    // Hovering a name in the field asks the same scope the value evaluates in, so a sibling
    // property reads exactly as it will when the value is committed.
    hoverCard: (symbol) => {
      const scope = built();
      return scope === null ? null : symbolCard(scope.context, symbol);
    },
    holeType: (text) => {
      const scope = built();
      if (scope === null) {
        return null;
      }

      const hole = holeForm(text);
      return hole === null ? null : parseHoleType(interpret(scope.context, hole).output);
    },
  };
}

// SHOWING AN OUTCOME
// ================================================================================================

/** Render an outcome into the result span, in whichever shape the mode calls for
 *  (properties/display.ts). */
function showOutcome(resultEl: HTMLElement, outcome: PropertyDisplay, mode: DisplayMode): void {
  const plan = displayPlan(outcome, mode);
  resultEl.empty();
  resultEl.toggleClass("numbat-property-error", plan.paint === "text" && plan.cls === "error");
  resultEl.toggleClass("numbat-property-warning", plan.paint === "text" && plan.cls === "warning");

  if (plan.paint === "text") {
    resultEl.setText(plan.text);
  } else if (plan.paint === "html") {
    setNumbatHtml(resultEl.createSpan(), plan.html);
  }
}
