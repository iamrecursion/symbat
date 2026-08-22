// Evaluating a note's Numbat properties: a whole note at a time, from the _first_ property whose
// answer is **not already known**.
//
// The widget used to evaluate one property at a time, each in a fresh interpreter context that
// replayed the properties above it. This module answers all property values from one context, and
// on an edit answers only the properties from the edited one down, because the ones above it cannot
// have changed: their scope is the same and so are their values.
//
// Three things share the work between them:
//
//   - **The batch** ({@link requestNoteOutcomes}) evaluates a note's committed values. Every widget
//     of a note asks for it and they are coalesced into one pass (properties/outcome-cache.ts).
//   - **The live path** ({@link evaluateLiveOutcome}) evaluates one property's text on its own, for
//     the row being typed into. Only the focused row is ever on this path.
//   - **{@link resolveOutcome}** decides which of the two a widget wants, and answers outright
//     where no interpreter is needed at all: a key-level skip and a derivation warning are both
//     read straight off the frontmatter, and used to be reported only after awaiting the entire
//     wasm boot.
//
// **Known gap:** an array-*item* widget (`rates.#`) has no binding of its own as the list binds as
// one value, so it never matches a binding and stays on the live path. That is correct, since an
// item is written against the scope its whole list has, but it is unbatched: a list of ten items is
// ten evaluations. Closing it needs per-item bindings, which the preamble model does not have.
//
// The pivot between the batch and the live path is whether the widget's text is what the note's
// binding evaluates. That comparison is against {@link PropertyBinding.expr} rather than against
// the raw frontmatter value, and deliberately: where the derivation rewrote the value the batch's
// answer is about the rewrite and not about what the reader typed, so the comparison fails and the
// row falls to the live path, which is where its warning is judged anyway.

import { wholeScopeKey } from "../evaluation/inlay-parse";
import {
  ask,
  ensureNumbatReady,
  interpreterGeneration,
  isNumbatReady,
  preludeReadsClockOrRandom,
  touchCompletionIdle,
} from "../interpreter/numbat";
import { impureBindings, readsClockOrRandom } from "../interpreter/purity";
import { refusalResult, rememberRefusal } from "../interpreter/refusals";
import type SymbatPlugin from "../main";
import { PROPERTY_BATCH_COALESCE_MS } from "../tuning";
import type { PropertyDisplay } from "./display";
import {
  bindingKey,
  ensureReservedNames,
  type NotePreamble,
  preambleForFile,
  type PropertyWidgetContext,
  scopeChunksAbove,
} from "./note";
import {
  cancelBatches,
  clearPropertyOutcomes,
  firstStale,
  liveKey,
  liveOutcome,
  noteOutcome,
  outcomeEpoch,
  outcomeKeys,
  rememberLiveOutcome,
  rememberNoteOutcome,
  requestBatch,
  scopeKey,
} from "./outcome-cache";
import { type BindingOutcome, displayFromOutcome } from "./outcomes";
import { isBareZero } from "./parse";

// Re-exported so the surfaces that drive this module need only one import. `outcomeEpoch` is part
// of that surface rather than an internal: a caller waiting on a batch compares it either side to
// tell "the pass answered" from "the pass abandoned itself", which `done` deliberately does not say
// (properties/outcome-cache.ts).
export { cancelBatches, clearPropertyOutcomes, outcomeEpoch };

// WHICH PATH A WIDGET IS ON
// ================================================================================================

/**
 * Where a fresher outcome would come from: nowhere (the answer is already complete), the note
 * batch, or this one property evaluated on its own.
 */
export type OutcomeMode = "none" | "note" | "live";

/** What a widget should paint right now, and what — if anything — it should ask for next. */
export interface ResolvedOutcome {
  /**
   * What to paint, or `null` when nothing is known about this text yet and the row should keep
   * showing whatever it has.
   */
  display: PropertyDisplay | null;

  /**
   * Whether {@link display} is recent enough to stand in for the evaluation, so the widget can
   * schedule nothing at all. Always true where {@link mode} is `none`.
   */
  fresh: boolean;

  mode: OutcomeMode;
}

/**
 * What is already known about a widget's current text, and which path would learn more.
 *
 * Synchronous and wasm-free throughout, which is the point: a re-rendered row paints in the tick it
 * is built, and a property that can be answered from the frontmatter alone (a reserved name, a
 * warned-about zero) is answered without booting an interpreter to be told what the derivation
 * already knew.
 */
export function resolveOutcome(plugin: SymbatPlugin, ctx: PropertyWidgetContext, text: string): ResolvedOutcome {
  if (!plugin.settings.noteProperties || text.trim() === "") {
    return { display: { kind: "empty" }, fresh: true, mode: "none" };
  }

  const key = ctx.key ?? "";
  const preamble = preambleForFile(plugin, ctx.sourcePath ?? "");
  const scope = propertyScope(preamble, key);

  if (scope.skip !== null) {
    return { display: { kind: "error", text: scope.skip }, fresh: true, mode: "none" };
  }

  // A derivation advisory is shown only while the live text is still the value it was raised about
  // — it is value-shaped, so it is judged from the text like the other value-shaped outcomes rather
  // than from the binding, which is a keystroke behind.
  if (scope.warning !== null && isBareZero(text)) {
    return { display: { kind: "warning", text: scope.warning }, fresh: true, mode: "none" };
  }

  const scoped = keyFor(plugin, key, scope);
  const binding = preamble.bindings.find((entry) => entry.key === key);
  if (binding !== undefined && binding.expr === text.trim()) {
    const hit = noteOutcome(scoped, binding.expr);

    // Projected here rather than stored projected: the note cache holds the outcome itself so the
    // frontmatter inlays can project the same entry their own way (properties/outcome-cache.ts).
    return {
      display: hit === null ? null : displayFromOutcome(hit.outcome),
      fresh: hit?.fresh ?? false,
      mode: "note",
    };
  }

  const live = liveOutcome(liveKey(scoped, text));
  return { display: live?.display ?? null, fresh: live?.fresh ?? false, mode: "live" };
}

// THE NOTE BATCH
// ================================================================================================

/**
 * Ask for a preamble's property outcomes and be told when they have been computed, joining whatever
 * pass is already pending for that same scope. Returns a cancel, which a swept row must call.
 *
 * The preamble is the argument rather than the note path because it is what identifies the pass:
 * two surfaces that derived the same bindings want the same answers and share one evaluation, and
 * two that did not are asking different questions (properties/outcome-cache.ts).
 *
 * `notePath` does *not* identify anything, and is not part of the key. It names the note whose
 * evaluation allowance this pass draws on (interpreter/budget.ts), so that a note's properties, its
 * inlay hints and its inline expressions share one ten seconds instead of taking one each. Two
 * notes with byte-identical frontmatter still share a single pass, and the first requester's path
 * is the one it is charged to.
 *
 * `done` reports only that a pass ran; the caller re-reads its own outcome, because between asking
 * and being told, its text may have moved on.
 */
export function requestNoteOutcomes(
  plugin: SymbatPlugin,
  preamble: NotePreamble,
  notePath: string,
  done: () => void,
): () => void {
  return requestBatch(batchKey(plugin, preamble), {
    run: () => runNotePass(plugin, preamble, notePath),
    delay: (start) => {
      const timer = window.setTimeout(start, PROPERTY_BATCH_COALESCE_MS);
      return () => window.clearTimeout(timer);
    },
  }, done);
}

/**
 * What a pass is about: the scope it evaluates, stamped with the interpreter the answers would
 * come from. Every binding statement and every import is in `preamble.source`.
 */
function batchKey(plugin: SymbatPlugin, preamble: NotePreamble): string {
  return wholeScopeKey(interpreterGeneration(), preamble.source)
    + (plugin.settings.fetchExchangeRates ? "\u00001" : "\u00000");
}

/**
 * One pass over a note: evaluate from the first property whose answer is not already known, in a
 * single context, and record what each produced.
 *
 * Never rejects. A pass that cannot start (the interpreter would not boot) or that crashes leaves
 * the cache as it was; the widgets keep whatever they were painting and ask again on their next
 * render.
 */
async function runNotePass(plugin: SymbatPlugin, preamble: NotePreamble, notePath: string): Promise<void> {
  const epoch = outcomeEpoch();
  try {
    await ensureNumbatReady();
    await plugin.ensureExchangeRates();
    await plugin.ensurePrelude();
  } catch (error) {
    console.error("Symbat: the property batch could not initialize the interpreter", error);
    return;
  }

  // The caches were emptied while this was booting, so whatever it read on the way in describes a
  // world that has moved. Dropping the pass is right: the widgets that wanted it will ask again.
  if (!isNumbatReady() || outcomeEpoch() !== epoch) {
    return;
  }

  void ensureReservedNames(plugin.settings.fetchExchangeRates);

  // The preamble is the one the request was keyed on and is not re-derived here, deliberately. An
  // edit that landed across the awaits is a different scope with a different key so re-reading the
  // note would move the entries this is about to write out from under the key they are filed
  // against. From here down nothing yields.
  const keys = outcomeKeys(plugin.settings.fetchExchangeRates, preamble);
  const from = firstStale(keys, preamble.bindings);
  if (from === null) {
    return;
  }

  // The note's allowance, shared with its inlay and inline passes. In the editor all three run on
  // the same note within a debounce of each other, and three separate budgets would let one note
  // take three times what the reader asked for.
  //
  // As on the inline path, and for the same reason, there is no head check: one context serves the
  // whole pass, and past the deadline `evaluateBindings` still runs so that every binding comes
  // back as an ordinary error outcome. Those get filed, so the widgets have an answer and stop
  // asking. Refusing before the context would file nothing, `firstStale` would keep returning the
  // same index, and every render would schedule the pass again.
  //
  // Answering, not skipping. The other two ledger surfaces can simply decline to render, but a
  // property widget that is told nothing keeps asking: `firstStale` would go on returning the same
  // index and every render would schedule this pass again. So a note inside its cool-down is
  // answered from a runner that refuses everything.
  //
  // This is also the surface that needs the ledger most, and for a reason peculiar to it: the
  // outcome cache *ages* (IMPURE_FRESH_MS), deliberately, so that a property reading the clock
  // keeps moving. A property that cannot be evaluated has no clock to read, and without the longer
  // cool-down dominating that window the note would pay the whole limit every ten seconds for the
  // rest of the session.
  const stamp = interpreterGeneration();
  const outcomes = await ask("evalBindings", {
    preamble,
    from,
    applyRates: plugin.settings.fetchExchangeRates,
    budget: { budgetMs: plugin.settings.evaluationLimitMs, key: notePath },
    refuseWith: refusalResult(notePath, stamp),
  }, { note: notePath });
  if (outcomes === null) {
    return;
  }

  // Re-checked on the way out as well as on the way in: the caches may have been emptied while the
  // pass ran, and filing answers about a world that has been declared gone would put entries under
  // keys nothing will ever look up again. The widgets that wanted them ask again.
  if (outcomeEpoch() !== epoch) {
    return;
  }

  if (outcomes.exceeded) {
    rememberRefusal(notePath, stamp);
    plugin.reportEvaluationLimit(notePath);
  }

  fileOutcomes([...outcomes.value], keys, preamble, from);
}

/**
 * Record a pass's outcomes against the keys they were computed for.
 *
 * Each entry is filed with whether *its* scope can produce a different answer next time, which is
 * what decides whether it ever ages out (properties/outcome-cache.ts). A note that reads no clock
 * anywhere is therefore never re-evaluated on a timer again, and one that reads a clock partway
 * down resumes there rather than at the top — see {@link impureBindings}.
 *
 * Decided for the whole preamble rather than for the slice this pass evaluated, because the flags
 * are indexed by binding and a pass that started at `from` still has to file at the right offsets.
 */
function fileOutcomes(
  outcomes: BindingOutcome[],
  keys: string[],
  preamble: NotePreamble,
  from: number,
): void {
  const impure = impureBindings(preamble, preludeReadsClockOrRandom());
  for (const [offset, outcome] of outcomes.entries()) {
    const index = from + offset;
    rememberNoteOutcome(keys[index], preamble.bindings[index].expr, outcome, impure[index]);
  }
}

// THE LIVE PATH
// ================================================================================================

/**
 * Evaluate one property's text on its own, in its note's property scope: the bindings of the
 * properties *above* it replay first (never those below, and never the note's shared blocks as the
 * preamble evaluates before them).
 *
 * The row being typed into, and nothing else. A note's committed values go through the batch, which
 * answers all of them for the price of this one.
 */
export async function evaluateLiveOutcome(
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

  void ensureReservedNames(plugin.settings.fetchExchangeRates);

  // Re-derived after the awaits: the note may have been edited across them, and the scope this
  // evaluates in is the one the answer will be filed under.
  const key = ctx.key ?? "";
  const preamble = preambleForFile(plugin, ctx.sourcePath ?? "");
  const scope = propertyScope(preamble, key);
  // The row's own text is part of the question here in a way it is not for the note cache: this
  // cache holds text the note does not hold, so a reader typing `now()` is asking about a scope
  // whose last statement is the thing that reads the clock.
  const impure = preludeReadsClockOrRandom()
    || readsClockOrRandom(text)
    || scope.chunks.some((chunk) => readsClockOrRandom(chunk));
  const remember = (display: PropertyDisplay): PropertyDisplay => {
    rememberLiveOutcome(liveKey(keyFor(plugin, key, scope), text), display, impure);
    return display;
  };

  if (scope.skip !== null) {
    return remember({ kind: "error", text: scope.skip });
  }
  if (scope.warning !== null && isBareZero(text)) {
    return remember({ kind: "warning", text: scope.warning });
  }

  // The reuse this used to arrange for itself now happens inside the interpreter, where the
  // replayed scope is cached: the completer has almost certainly already built a context at this
  // exact scope for the row being typed into, and it is the same one this asks about. That turns a
  // keystroke's evaluation from a standard-library load into a single `interpret`, which is the
  // largest single cost on the typing path.
  const outcome = await ask("evalProperty", {
    chunks: scope.chunks,
    text,
    applyRates: plugin.settings.fetchExchangeRates,
  }, { priority: "interactive" });
  if (outcome === null) {
    return { kind: "empty" };
  }

  // The scope this used is the completer's own, and it is kept warm on the same policy as any other
  // use of it: a reader typing into a property row is using it.
  touchCompletionIdle(plugin.settings.completionIdleSeconds * 1000);
  return remember(displayFromOutcome(outcome));
}

// THE SCOPE A PROPERTY EVALUATES IN
// ================================================================================================

/**
 * Everything about a property's place in its note that its evaluation depends on.
 *
 * Split out because every part of it is derivable synchronously and cheaply, which is what makes
 * {@link scopeKey} (and hence the outcome caches) possible at all: two renders that agree on all of
 * this and on the text cannot disagree on the outcome.
 */
interface PropertyScope {
  /**
   * The bindings replayed before the value: the note's imports, then the properties written
   * *above* this one (never those below, and never the note's shared blocks).
   */
  chunks: string[];

  /**
   * A key-level skip (a reserved or unusable name, a duplicate), reported as the same error the
   * binding side skips it with, in place of any evaluation.
   */
  skip: string | null;

  /** A derivation advisory attached to this binding (today: a bare `0` read as a `Scalar`). */
  warning: string | null;
}

/**
 * {@link PropertyScope} for one widget context. Pure frontmatter reading with no wasm, and no
 * awaits.
 */
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

/** This context's {@link scopeKey}, from the settings and the scope its property sits in. */
function keyFor(plugin: SymbatPlugin, key: string, scope: PropertyScope): string {
  return scopeKey(plugin.settings.fetchExchangeRates, key, scope.skip, scope.warning, scope.chunks);
}
