// The `Numbat` property type: a custom entry in Obsidian's property-type registry
// (`metadataTypeManager.registeredTypeWidgets` — the same undocumented registry Obsidian's own
// widgets and Better Properties use, so both coexist). A property assigned this type holds a Numbat
// expression; the widget shows the expression in a monospace input with a live `= value` annotation
// after it, evaluated in the note's property scope (the bindings of the properties above it —
// mirroring exactly what the note preamble replay defines). The binding side lives in
// properties/note.ts; this file is only the type + widget.

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
import {
  bindingKey,
  NUMBAT_PROPERTY_TYPE,
  preambleForFile,
  primeReservedNames,
  propertyTypeManager,
  replayScopeAbove,
  scopeChunksAbove,
} from "./note";

// REGISTERING THE TYPE
// ================================================================================================

/** The slice of the (undocumented) render context Obsidian passes a property widget. Every field is
 *  optional and accessed defensively. */
interface PropertyWidgetContext {
  /** The frontmatter key this widget is editing. */
  key?: string;

  /** Report a new value back to Obsidian, which writes it to the note. */
  onChange?: (value: unknown) => void;

  /** Vault path of the note being edited, needed to resolve its imports. */
  sourcePath?: string;
}

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

  widgets[NUMBAT_PROPERTY_TYPE] = {
    type: NUMBAT_PROPERTY_TYPE,
    icon: "calculator",
    name: () => "Numbat",
    // What Obsidian considers an assignable value for this type: the expression text (a bare number
    // is how YAML stores an unquoted numeric expression).
    validate: (value: unknown) => typeof value === "string" || typeof value === "number",
    render: (el: HTMLElement, value: unknown, ctx: PropertyWidgetContext) => renderWidget(plugin, el, value, ctx),
  };

  manager.trigger?.("changed");
  plugin.register(() => {
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

  /** The CodeMirror input hosted in it, destroyed when the row is swept. */
  input: NumbatInput;

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

/** Destroy the editors whose rows are gone, and (on unload) all of them. */
function sweepEditors(all = false): void {
  for (const entry of [...liveEditors]) {
    if (all) {
      entry.cancelPending();
      entry.input.destroy();
      liveEditors.delete(entry);
      continue;
    }

    if (entry.el.isConnected) {
      entry.attached = true;
    } else if (entry.attached) {
      entry.cancelPending();
      entry.input.destroy();
      liveEditors.delete(entry);
    }
  }
}

/** The widget: a Numbat expression editor plus a muted result annotation. */
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

  const evaluate = () => {
    const pass = ++generation;
    void propertyOutcome(plugin, ctx, input.getValue()).then((outcome) => {
      // Stale passes and torn-down rows (the metadata editor re-renders liberally) must not write
      // into the DOM.
      if (pass === generation && resultEl.isConnected) {
        showOutcome(resultEl, outcome);
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
    const text = input.getValue();
    if (text !== written) {
      written = text;
      ctx.onChange?.(text);
    }
  };

  const completions = propertyCompletions(plugin, ctx);
  const input: NumbatInput = new NumbatInput(fieldEl, plugin, {
    // Enter accepts, which for a property means committing (blur commits too, the shape Obsidian's
    // own text widgets use).
    submit: () => {
      commit();
      input.blur();
    },
    changed: scheduleEvaluate,
    blurred: commit,
    ...completions,
  }, {
    highlight: true, // a Numbat property is Numbat code, with no prose to disturb
    vimMode: false,
    inlayHoles: plugin.settings.inlayHints && plugin.settings.inlayTypes,
    hover: plugin.settings.hover,
    placeholder: "Numbat expression",
    singleLine: true,
    expressionOnly: true, // a property commits a value, so there is no declaration to decorate
  });
  input.setValue(committed);

  const entry: LiveEditor = { el, input, attached: el.isConnected, cancelPending };
  liveEditors.add(entry);

  // The row is usually still detached here (Obsidian inserts it after rendering), so the editor is
  // built against no layout at all. One frame later it is in the document: note that it arrived —
  // the sweep keys off it — and let CodeMirror measure itself now that there is something to
  // measure.
  window.requestAnimationFrame(() => {
    if (entry.el.isConnected) {
      entry.attached = true;
      entry.input.refresh();
    }
  });

  // Debounced rather than immediate. Obsidian re-renders a whole object's rows in one pass and does
  // so liberally, and `propertyOutcome` builds a fresh interpreter context — the entire standard
  // library, synchronously. A note with four Numbat properties would otherwise pay for four of
  // those on the main thread every time the frontmatter changed; coalescing collapses the pass into
  // one round of work per row.
  scheduleEvaluate();

  return { focus: () => input.focus() };
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

/** What the widget shows after the input for one evaluation pass. */
type PropertyDisplay =
  | { kind: "empty"; }
  | { kind: "error"; text: string; }
  | { kind: "hole"; type: string; }
  /** The `= value` fragment, as Numbat formatter HTML. */
  | { kind: "value" | "binding"; html: string; };

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

  if (skip !== undefined) {
    return { kind: "error", text: skip.message };
  }

  const context = createContext(plugin.settings.fetchExchangeRates);
  try {
    // Imports, then only the properties written above this one.
    replayScopeAbove(context, preamble, key);

    const result = inlineResultFor((code) => interpret(context, code), text);
    if (result.kind === "error") {
      return { kind: "error", text: result.errorText ?? "evaluation failed" };
    }
    if (result.kind === "hole" && result.holeType !== null) {
      return { kind: "hole", type: result.holeType };
    }
    if ((result.kind === "value" || result.kind === "binding") && result.resultHtml !== null) {
      return { kind: result.kind, html: result.resultHtml };
    }

    return { kind: "empty" };
  } finally {
    freeQuietly(context);
  }
}

/** Render an outcome into the annotation span. */
function showOutcome(resultEl: HTMLElement, outcome: PropertyDisplay): void {
  resultEl.empty();
  resultEl.toggleClass("numbat-property-error", outcome.kind === "error");

  switch (outcome.kind) {
    case "empty":
      break;
    case "error":
      resultEl.setText(outcome.text);
      break;
    case "hole":
      resultEl.setText(`⟨${outcome.type}⟩`);
      break;
    default:
      // Numbat's own formatter HTML, so the value colors like everywhere else.
      setNumbatHtml(resultEl.createSpan(), outcome.html);
  }
}
