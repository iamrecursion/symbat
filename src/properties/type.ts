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
import { inlineResultFor } from "../evaluation/inline-parse";
import { symbolCard } from "../hover/content";
import type { HoverSymbol } from "../hover/parse";
import {
  completionInfo,
  completionSignature,
  createContext,
  ensureBlockCompletion,
  ensureNumbatReady,
  expressionCompletionCandidates,
  freeQuietly,
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
  bindingKey,
  type NotePreamble,
  NUMBAT_PROPERTY_TYPE,
  preambleForFile,
  primeReservedNames,
  propertyTypeManager,
  type PropertyWidgetContext,
  replayScopeAbove,
  scopeChunksAbove,
} from "./note";
import { isBareZero } from "./parse";

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
    icon: "calculator",
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
  let generation = 0;
  const cancelPending = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    // Also disowns any evaluation already in flight: `pass === generation` can no longer hold, so a
    // resolved outcome is dropped rather than written.
    generation += 1;
  };

  const entry: LiveEditor = { el, input: null, attached: el.isConnected, cancelPending };
  liveEditors.add(entry);

  // With no editor beside it the result *is* the cell's content, so it shows the bare value rather
  // than the `= value` fragment — and falls back to the expression itself when there is nothing to
  // show, so that a column of properties is never a column of blanks (see {@link displayPlan}).
  const paint = () => {
    showOutcome(resultEl, outcome, { bare: entry.input === null, fallback: text });
  };

  const evaluate = () => {
    const pass = ++generation;
    void propertyOutcome(plugin, ctx, text).then((next) => {
      // Stale passes and torn-down rows (the metadata editor re-renders liberally) must not write
      // into the DOM.
      if (pass === generation && resultEl.isConnected) {
        outcome = next;
        paint();
      }
    });
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
  // scrolls back into view.
  const cached = cachedOutcome(plugin, ctx, text);
  if (cached !== null) {
    outcome = cached.outcome;
  }

  paint();

  // Debounced rather than immediate. Obsidian re-renders a whole object's rows in one pass and does
  // so liberally, and `propertyOutcome` builds a fresh interpreter context — the entire standard
  // library, synchronously. A note with four Numbat properties would otherwise pay for four of
  // those on the main thread every time the frontmatter changed; coalescing collapses the pass into
  // one round of work per row.
  //
  // Skipped outright on a *recent* hit: the key covers everything the evaluation would read except
  // the clock, so within {@link OUTCOME_FRESH_MS} re-running it could only reproduce the value
  // already painted above. That is what keeps a scrolled Base column from paying an interpreter
  // context per row per pass; an older hit is painted but re-evaluated, so nothing reading the
  // clock stays still.
  if (cached === null || !cached.fresh) {
    scheduleEvaluate();
  }

  return { focus: () => activate().focus() };
}

/** Release every property editor (plugin unload). */
export function disposePropertyEditors(): void {
  sweepEditors(true);
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

// EVALUATING THE VALUE
// ================================================================================================

/**
 * What the note's frontmatter says about a property, without the interpreter: the scope its value
 * evaluates in, and any problem to report instead of evaluating.
 *
 * Split out because every part of it is derivable synchronously and cheaply, which is what makes
 * {@link outcomeKey} — and so the outcome cache — possible: two renders that agree on all of this
 * and on the text cannot disagree on the outcome.
 */
interface PropertyScope {
  /** The bindings replayed before the value: the note's imports, then the properties written
   *  *above* this one (never those below, and never the note's shared blocks). */
  chunks: string[];

  /** A key-level skip (a reserved or unusable name, a duplicate) — reported as the same error the
   *  binding side skips it with, in place of any evaluation. */
  skip: string | null;

  /** A derivation advisory attached to this binding (today: a bare `0` read as a `Scalar`). */
  warning: string | null;
}

/** {@link PropertyScope} for one widget context. Pure frontmatter reading — no wasm, no awaits. */
function propertyScope(preamble: NotePreamble, key: string): PropertyScope {
  // Key-level skips are stable while typing the value; value-shaped ones (empty / unsupported) are
  // judged from the live text instead. An array item is shown its array's skip (`rates.#` reads
  // `rates`'s) unless the item's own position has one of its own, since the item is only bound
  // through the list.
  const owner = bindingKey(key);
  const keyLevel = preamble.skips.filter(
    (entry) => entry.reason === "reserved" || entry.reason === "invalid-name" || entry.reason === "duplicate",
  );

  // The item's own position first, so the more specific message wins wherever both exist.
  const skip = keyLevel.find((entry) => entry.key === key) ?? keyLevel.find((entry) => entry.key === owner);

  return {
    chunks: scopeChunksAbove(preamble, key),
    skip: skip?.message ?? null,
    warning: preamble.bindings.find((entry) => entry.key === key)?.warning ?? null,
  };
}

/**
 * Evaluate the widget's current expression text in its note's property scope: the bindings of the
 * properties *above* this one replay first (never those below, and never the note's shared blocks —
 * the preamble evaluates before them). A key-level problem (a reserved or unusable name, a
 * duplicate) shows as the same error the binding side skips it with.
 */
async function propertyOutcome(
  plugin: SymbatPlugin,
  ctx: PropertyWidgetContext,
  text: string,
): Promise<PropertyDisplay> {
  if (!plugin.settings.noteProperties || text.trim() === "") {
    return { kind: "empty" };
  }

  try {
    await ensureNumbatReady();
    await plugin.ensureExchangeRates();
    await plugin.ensurePrelude();
  } catch (error) {
    console.error("Symbat: the property widget could not initialize the interpreter", error);
    return { kind: "empty" };
  }

  if (!isNumbatReady()) {
    return { kind: "empty" };
  }

  primeReservedNames(plugin.settings.fetchExchangeRates);

  const key = ctx.key ?? "";
  const preamble = preambleForFile(plugin, ctx.sourcePath ?? "");
  const scope = propertyScope(preamble, key);
  const remember = (outcome: PropertyDisplay): PropertyDisplay => {
    rememberOutcome(outcomeKey(plugin, key, scope, text), outcome);
    return outcome;
  };

  if (scope.skip !== null) {
    return remember({ kind: "error", text: scope.skip });
  }

  // A derivation advisory is shown only while the live text is still the value it was raised about
  // — it is value-shaped, so it is judged from the text like the other value-shaped outcomes rather
  // than from the binding, which is a keystroke behind.
  if (scope.warning !== null && isBareZero(text)) {
    return remember({ kind: "warning", text: scope.warning });
  }

  const context = createContext(plugin.settings.fetchExchangeRates);
  try {
    // Imports, then only the properties written above this one.
    replayScopeAbove(context, preamble, key);

    const result = inlineResultFor((code) => interpret(context, code), text);
    if (result.kind === "error") {
      return remember({ kind: "error", text: result.errorText ?? "evaluation failed" });
    }
    if (result.kind === "hole" && result.holeType !== null) {
      return remember({ kind: "hole", type: result.holeType });
    }
    if ((result.kind === "value" || result.kind === "binding") && result.resultHtml !== null) {
      return remember({
        kind: result.kind,
        resultHtml: result.resultHtml,
        valueHtml: result.valueHtml ?? result.resultHtml,
      });
    }

    return remember({ kind: "empty" });
  } finally {
    freeQuietly(context);
  }
}

// THE OUTCOME CACHE
// ================================================================================================

/**
 * Evaluated outcomes, by everything they depend on.
 *
 * An evaluation costs a fresh interpreter context — the entire standard library, synchronously, and
 * a Numbat column in a Base pays one per visible row. Rows are re-rendered from scratch as they
 * scroll back into view, so without this the same handful of values would be recomputed for as long
 * as the reader kept scrolling, and each row would show its raw expression until its debounce
 * elapsed.
 *
 * **Entries carry their age**, because a key built from the frontmatter cannot see the one input
 * that is not in it: the clock. A property that says `now()` would freeze at whatever it read when
 * the reader first scrolled past it, and no invalidation hook could catch that, because nothing
 * *happened*. So a hit is used two different ways — see {@link OUTCOME_FRESH_MS}.
 *
 * Bounded, and cleared wholesale on overflow rather than evicted one at a time (the same policy
 * properties/zone.ts's zone caches use): the cost of a miss is one evaluation, so a cheap
 * approximation of recency is worth more than an accurate one.
 */
const outcomes = new Map<string, { outcome: PropertyDisplay; at: number; }>();

/** How many outcomes are kept. A screenful of Base rows and then some. */
const OUTCOME_CACHE_LIMIT = 256;

/**
 * How long an outcome stands in for the evaluation that produced it.
 *
 * Inside it, a hit is the whole answer and {@link renderWidget} schedules no evaluation at all —
 * which is what makes scrolling back and forth over the same rows free rather than merely
 * flicker-free. Outside it, the hit is still painted (it is the best thing to show, and far better
 * than a raw expression) but the evaluation runs anyway, so anything reading the clock moves again.
 *
 * Ten seconds is chosen against the gesture, not the value: it comfortably covers scrolling a
 * column and coming back, and it is short enough that a `now()` property in a Base reads as live.
 */
const OUTCOME_FRESH_MS = 10_000;

/**
 * The identity of an evaluation: the settings that change what an expression means, the property's
 * own key and its key-level problems, the scope replayed before it, and the text itself. Everything
 * here is read from the frontmatter, so the key costs no interpreter work — which is the point,
 * since it is computed to *avoid* interpreter work.
 *
 * `noteProperties` is deliberately absent even though it changes everything: both sides return
 * before they reach this while it is off, so no key built here can ever describe a world without
 * it. The rest of the invalidation is not this key's job either — a moved prelude or a refetched
 * exchange rate goes through `refreshNoteScope`, which empties the map wholesale.
 */
function outcomeKey(plugin: SymbatPlugin, key: string, scope: PropertyScope, text: string): string {
  return [
    plugin.settings.fetchExchangeRates ? "1" : "0",
    key,
    scope.skip ?? "",
    scope.warning ?? "",
    ...scope.chunks,
    text,
  ].join("\0");
}

/** Record an outcome, stamped with when it was true. Called on the way out of every evaluation,
 *  including for a row whose element has since gone: the value is still true, and the next render
 *  of that row wants it. */
function rememberOutcome(key: string, outcome: PropertyDisplay): void {
  if (outcomes.size >= OUTCOME_CACHE_LIMIT) {
    outcomes.clear();
  }

  outcomes.set(key, { outcome, at: performance.now() });
}

/** A cache hit: what to paint, and whether it is recent enough to be the whole answer. */
interface CachedOutcome {
  outcome: PropertyDisplay;

  /** Whether the caller may skip evaluating. See {@link OUTCOME_FRESH_MS}. */
  fresh: boolean;
}

/** The outcome already known for this text in this scope, or `null`. Synchronous and wasm-free, so
 *  a re-rendered row can paint its value in the same tick it is built. */
function cachedOutcome(plugin: SymbatPlugin, ctx: PropertyWidgetContext, text: string): CachedOutcome | null {
  if (!plugin.settings.noteProperties || text.trim() === "") {
    return null;
  }

  const key = ctx.key ?? "";
  const scope = propertyScope(preambleForFile(plugin, ctx.sourcePath ?? ""), key);
  const hit = outcomes.get(outcomeKey(plugin, key, scope, text));
  return hit === undefined ? null : { outcome: hit.outcome, fresh: performance.now() - hit.at <= OUTCOME_FRESH_MS };
}

/** Forget every cached outcome — the prelude, the note scope or the settings moved under them, and
 *  on unload. */
export function clearPropertyOutcomes(): void {
  outcomes.clear();
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
