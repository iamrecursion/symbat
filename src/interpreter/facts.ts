// What the interpreter knows about one name, as plain data, cached per scope.
//
// The shape of all such queries is as follows:
//
//   * read {@link knownFacts} synchronously with a map lookup, no interpreter, no clock;
//   * on a miss, fire one batched {@link ensureFacts} and use the surface's own retry.
//
// The surfaces already had the retry: the hover re-shows its card when the caret has not moved, the
// completer re-renders on the next keystroke. What they had nowhere to put was the wait, and that
// is what this module is.
//
// **The fill is always asynchronous, even when the reader answers instantly.** {@link ensureFacts}
// waits a turn before calling it whatever it does, so a surface can never accidentally be handed an
// answer inline and come to depend on it. That is the difference between a cache built for a
// boundary and one with a promise bolted on.
//
// Imports nothing but tuning constants, the protocol vocabulary, the shared cache and the purity
// predicate, so it loads under plain `node --test` — which the module that puts the request
// (interpreter/live-facts.ts) never can.

import { FACTS_CACHE_ENTRIES, HOLE_CACHE_ENTRIES } from "../tuning";
import { EvaluationCache } from "./eval-cache";
import type { ScopeSpec, SymbolFacts } from "./protocol";
import { readsClockOrRandom } from "./purity";

// The vocabulary a fact is asked for in lives on the protocol (interpreter/protocol.ts), because it
// is as much the interpreter's question as this cache's answer: the mask goes out in the request,
// and the record comes back as the reply. Re-exported here so that the thirty call sites that think
// of this as "the facts cache" keep saying so.
export type { ScopeSpec, SymbolFacts };
export { scopeKey, WANT_CARD, WANT_FIELDS, WANT_INFO, WANT_SIGNATURE, WANT_VALUE } from "./protocol";

/**
 * Whether the scope itself could make a fact about it say something different next time: a note, an
 * import or a prelude that reads the clock or the RNG (interpreter/purity.ts).
 *
 * Decided by the party holding the scope, exactly as the evaluation caches decide it, and for the
 * same reason: a reader that had to be told could be told wrong. The _name's_ own impurity is not
 * asked about here — {@link ensureFacts} adds that itself, since the probe is the one thing this
 * module always has.
 */
export function scopeCanChange(spec: ScopeSpec, preludeIsImpure: boolean): boolean {
  return preludeIsImpure || spec.chunks.some((chunk) => readsClockOrRandom(chunk));
}

/**
 * The two methods a surface has in place of the live handle it used to hold: read what is known,
 * ask for what is not.
 *
 * Declared here rather than beside either implementation, because it is the same contract whichever
 * side of a boundary the answer comes from: a wasm handle on this thread today, a message later.
 */
export interface FactsHost {
  /**
   * Fill in whatever `names` this surface's scope does not already know, for the purpose `want`.
   * Settles once the answers are there to be read — see {@link ensureFacts}.
   */
  facts(names: readonly string[], want: number): Promise<void>;

  /**
   * What is known about `name` for the purpose `want`, or `undefined` when it has to be asked for.
   * Synchronous, and never touches the interpreter.
   */
  knownFacts(name: string, want: number): SymbolFacts | undefined;

  /**
   * Work out what `input`'s trailing hole types as. Settles once {@link knownHoleType} can answer;
   * see {@link ensureHoleType}.
   */
  holeType(input: string): Promise<void>;

  /**
   * What `input`'s trailing hole types as, `null` when there is no recoverable type, `undefined`
   * when nobody has worked it out yet. Synchronous.
   */
  knownHoleType(input: string): string | null | undefined;
}

// THE CACHE
// ================================================================================================

/**
 * A cached record and the mask it was filled under. An entry filled for a completion row is a
 * signature and three nulls, which is no answer at all to a card; `have` is what tells the two
 * apart.
 */
interface Cached {
  readonly facts: SymbolFacts;
  readonly have: number;
}

// One entry per (scope, name). Flat rather than a map per scope: the eviction rule and the
// freshness rule are the ones every other evaluation cache already uses, and this is the fourth
// place that would otherwise have written them out again. Entries from a scope nobody will ask
// about again are not dropped when it goes: they age out of the bottom like any other.
const cache = new EvaluationCache<Cached>(FACTS_CACHE_ENTRIES);

/**
 * The cache key for one name in one scope. The probe cannot contain a NUL, so the first one
 * separates it from the scope key however many the scope key holds.
 */
function entryKey(key: string, probe: string): string {
  return `${probe}\u0000${key}`;
}

/**
 * One entry, if it is there and fresh and holds everything `want` asks for. Shared by
 * {@link knownFacts}, which is the exported question, and by {@link ensureFacts}, which uses it to
 * drop the probes it would only re-answer.
 */
function lookup(key: string, probe: string, want: number, now: number): SymbolFacts | undefined {
  const hit = cache.get(entryKey(key, probe), now);
  if (hit === null || !hit.fresh || (hit.value.have & want) !== want) {
    return undefined;
  }

  return hit.value.facts;
}

/**
 * What is already known about `probe` in this scope, or `undefined` when nothing is.
 *
 * A **stale** entry answers `undefined` rather than being handed over, which is the opposite of
 * what the evaluation caches do with one. They paint a stale value because the alternative is
 * painting nothing into a document the reader is looking at; here the alternative is one round trip
 * before a card the reader has not seen yet appears, and a card is worth being right. Only a scope
 * or a name that reads the clock ever goes stale at all.
 */
export function knownFacts(
  key: string,
  probe: string,
  want: number,
  now = performance.now(),
): SymbolFacts | undefined {
  return lookup(key, probe, want, now);
}

/** What a fill produced: the answers, and whether the scope they came from can change. */
export interface FactsFill {
  /**
   * One record per probe the reader could answer. A probe it leaves out is simply not cached, and
   * is asked for again next time.
   */
  readonly facts: ReadonlyMap<string, SymbolFacts>;

  /** Whether the scope reads the clock or the RNG — {@link scopeCanChange}. */
  readonly impure: boolean;
}

/**
 * How a batch of probes is actually answered — with the probes still unknown, and never on the
 * caller's tick. `null` when there is no answer to be had at all (the wasm is not ready, the scope
 * would not build), which caches nothing and leaves the next ask to try again.
 *
 * Asynchronous because a round trip is, and because that is what it becomes: today the answer comes
 * from a wasm handle on this thread after a simulated wait, and one day from a message. Injected
 * rather than imported for the same reason — holding a handle is what this module must not do, so
 * that it stays loadable without one.
 */
export type FactsReader = (probes: readonly string[], want: number) => Promise<FactsFill | null>;

// The fills currently running, keyed by scope and by the exact set of probes, so two surfaces
// asking the same question at once ask the interpreter once. A different set of probes in the same
// scope is a different request: they are answered in one pass each, and the alternative — waiting
// to see whether more names arrive — is a delay added to the path this module exists to shorten.
const inFlight = new Map<string, Promise<void>>();

/**
 * Fill in whatever is not already known about `probes` in this scope, and resolve when it is there
 * to be read. The caller then re-asks {@link knownFacts}; nothing is returned here, because by the
 * time it resolves the answer belongs to the cache rather than to this call.
 *
 * Resolves without doing anything when everything asked for is already known, so a surface may
 * call this on every trigger without checking first, which is what makes a prewarm a one-liner.
 */
export function ensureFacts(
  key: string,
  probes: readonly string[],
  want: number,
  read: FactsReader,
): Promise<void> {
  const now = performance.now();
  const wanted = [...new Set(probes)].filter((probe) => lookup(key, probe, want, now) === undefined).sort();
  if (wanted.length === 0) {
    return Promise.resolve();
  }

  const request = `${key}\u0000\u0000${String(want)}\u0000${wanted.join("\u0000")}`;
  const running = inFlight.get(request);
  if (running !== undefined) {
    return running;
  }

  // A turn before the reader is called, whatever the reader does: an answer that could land on the
  // asking tick is an answer a surface could come to depend on landing there.
  const fill = Promise.resolve().then(async () => {
    let filled: FactsFill | null = null;
    try {
      filled = await read(wanted, want);
    } catch (error) {
      // A reader throwing is a bug in the reader, not an answer: log it, cache nothing, and let the
      // next ask try again rather than leaving the surface waiting on a promise that never settles.
      console.error("Symbat: could not look up what a name is", error);
    }
    if (filled === null) {
      return;
    }

    for (const [probe, facts] of filled.facts) {
      // Whatever was filed here before is *replaced* rather than merged into. A narrower record
      // came from this same scope so nothing is being contradicted, and a fact it held that this
      // fill did not ask for is simply asked for again if anyone wants it. Merging would carry an
      // older fact forward under a newer timestamp, which for a name that reads the clock is the
      // one thing the freshness rule below exists to prevent.
      //
      // The scope's impurity and the name's own are both reasons an answer could move: hovering
      // `now` in a scope that never mentions it still reads the clock.
      cache.set(
        entryKey(key, probe),
        { facts, have: want },
        filled.impure || readsClockOrRandom(probe),
      );
    }
  }).finally(() => {
    inFlight.delete(request);
  });

  inFlight.set(request, fill);
  return fill;
}

/**
 * Forget everything. The reset command's route in; the generation in every key would strand these
 * entries anyway, and this deletes them rather than waiting for eviction to.
 */
export function clearFacts(): void {
  cache.clear();
  holes.clear();
}

// WHAT AN INCOMPLETE INPUT IS MISSING
// ================================================================================================
//
// The typed-hole hint: what operand `12 km /` is still waiting for. Not a fact about a *name*,
// which is why it is a second cache rather than a fifth mask bit: the question is asked about
// arbitrary half-written text, and it is answered by evaluating a hole form rather than by looking
// anything up. Everything else about it is the same shape, and it is stated here beside the other
// one so that the two cannot drift apart.
//
// Nothing here ages. A hole form is a type error *before* execution, so what it reports cannot
// depend on the clock; what it can depend on is the scope and the interpreter generation, and both
// are in the key.

const holes = new EvaluationCache<string | null>(HOLE_CACHE_ENTRIES);

/**
 * What `input`'s trailing hole types as: the type, `null` when there is none to recover, and
 * `undefined` when it has not been worked out.
 *
 * Three states rather than two, deliberately. The hint is painted by a CodeMirror plugin on every
 * keystroke, and "no type" and "not yet" call for opposite things there — paint nothing and stop,
 * versus paint nothing and ask.
 */
export function knownHoleType(key: string, input: string, now = performance.now()): string | null | undefined {
  const hit = holes.get(entryKey(key, input), now);
  return hit === null ? undefined : hit.value;
}

/**
 * How a hole form is actually typed. The outer `null` is "no answer to be had" — the scope will not
 * build — and caches nothing; `{ type: null }` is "asked, and there is no type", which does.
 */
export type HoleReader = (input: string) => Promise<{ type: string | null; } | null>;

const holesInFlight = new Map<string, Promise<void>>();

/**
 * Work out what `input`'s hole types as, unless it is already known, and settle when
 * {@link knownHoleType} can answer.
 *
 * Coalesced and deferred exactly as {@link ensureFacts} is, and for the same two reasons: two
 * surfaces asking at once is one evaluation, and an answer that could arrive on the asking tick is
 * an answer a caller could come to depend on arriving there.
 */
export function ensureHoleType(key: string, input: string, read: HoleReader): Promise<void> {
  if (knownHoleType(key, input) !== undefined) {
    return Promise.resolve();
  }

  const request = entryKey(key, input);
  const running = holesInFlight.get(request);
  if (running !== undefined) {
    return running;
  }

  const fill = Promise.resolve().then(async () => {
    let typed: { type: string | null; } | null = null;
    try {
      typed = await read(input);
    } catch (error) {
      console.error("Symbat: could not work out what an expression is missing", error);
    }
    if (typed === null) {
      return;
    }

    holes.set(request, typed.type, false);
  }).finally(() => {
    holesInFlight.delete(request);
  });

  holesInFlight.set(request, fill);
  return fill;
}
