// What the Numbat property widget paints while it is not evaluating, and the machinery that keeps a
// note's worth of widgets from each starting their own evaluation.
//
// An evaluation costs a fresh interpreter context, loading the entire standard library at a
// minimum, so the widget is built around not needing one. There are two caches here, because two
// different things are being remembered:
//
//   - **The note cache** holds one entry per property of a note, filled a whole note at a time by
//     the batch (properties/note-outcomes.ts). Its entries carry the *text* they were computed for,
//     so a display derived from a value the reader has since edited is a miss rather than a wrong
//     paint. A key can only say what the scope was, and the row's own text moves ahead of it.
//   - **The live cache** holds outcomes for text that is not (yet) the note's: the row being typed
//     into, which is one row, evaluated on its own because the note batch has nothing to say about
//     a value the note does not hold.
//
// **Entries carry their age**, because a key built from the frontmatter cannot see the one input
// that is not in it: the clock. A property that says `now()` would freeze at whatever it read when
// the reader first scrolled past it, and no invalidation hook could catch that, because nothing
// *happened*. So a hit is used two different ways — see {@link OUTCOME_FRESH_MS}.
//
// Nothing here imports Obsidian, CodeMirror or the interpreter: the keys arrive built, the
// evaluation arrives injected. What that buys is that the coalescing — the part with a race in it —
// is testable with a stub clock and a stub pass.

import { OUTCOME_FRESH_MS, PROPERTY_LIVE_OUTCOME_ENTRIES, PROPERTY_NOTE_OUTCOME_ENTRIES } from "../tuning";
import type { PropertyDisplay } from "./display";
import type { BindingOutcome } from "./outcomes";
import { type NotePreamble, type PropertyBinding, scopeChunksAbove } from "./parse";

/** A note-cache hit: the binding's evaluated outcome, and whether it is recent enough to be the
 *  whole answer. */
export interface CachedOutcome {
  /** What the evaluation produced, unprojected — see the note on the store below. */
  outcome: BindingOutcome;

  /** Whether the caller may skip evaluating. See {@link OUTCOME_FRESH_MS}. */
  fresh: boolean;
}

/** A live-cache hit: text of the moment has no binding, so there is only ever a display. */
export interface CachedDisplay {
  display: PropertyDisplay;
  fresh: boolean;
}

/**
 * Outcomes for the value a note actually holds, keyed by scope (properties/note-outcomes.ts builds
 * the key) and holding the text they describe.
 *
 * The **outcome** is stored, not a projection of it, because two surfaces read this: the widget
 * projects it with `displayFromOutcome` and the Source-mode frontmatter inlays with
 * `hintFromOutcome`. Storing either projection would leave the other to evaluate the note a second
 * time — which is what they used to do, in two contexts, for one set of answers.
 */
const noteOutcomes = new Map<string, { text: string; outcome: BindingOutcome; at: number; }>();

/** Outcomes for text of the moment, keyed by scope *and* text — a keystroke's key is its own. */
const liveOutcomes = new Map<string, { display: PropertyDisplay; at: number; }>();

// Bumped whenever the caches are emptied. A pass that was still booting when that happened is
// about to describe a world that has moved (a new prelude, refetched rates, a settings change), so
// it compares this against what it read on the way in and abandons the pass rather than filing
// answers against a scope nobody holds any more.
//
// Read once the awaits are behind it and *before* it evaluates anything, not after: the pass
// derives nothing further and yields nowhere from that point on, so there is no later moment at
// which the answer could go stale, and the check placed there costs an evaluation rather than
// wasting one.
let epoch = 0;

/** The current cache generation — see the note above. */
export function outcomeEpoch(): number {
  return epoch;
}

/** Forget every cached outcome: the prelude, the note scope or the settings moved under them, and
 *  on unload. */
export function clearPropertyOutcomes(): void {
  noteOutcomes.clear();
  liveOutcomes.clear();
  epoch += 1;
}

/** The outcome known for a note's committed value in this scope, or `null`, including when an entry
 * exists but was computed for text the row no longer holds. */
export function noteOutcome(key: string, text: string, now = performance.now()): CachedOutcome | null {
  const hit = noteOutcomes.get(key);
  if (hit === undefined || hit.text !== text) {
    return null;
  }

  promote(noteOutcomes, key, hit);
  return { outcome: hit.outcome, fresh: now - hit.at <= OUTCOME_FRESH_MS };
}

/** Record what a note's property evaluated to, replacing whatever that scope held before: there is
 *  one committed value per property, so an older entry for the same key is simply out of date. */
export function rememberNoteOutcome(key: string, text: string, outcome: BindingOutcome): void {
  promote(noteOutcomes, key, { text, outcome, at: performance.now() });
  evict(noteOutcomes, PROPERTY_NOTE_OUTCOME_ENTRIES);
}

/** The outcome known for this exact text in this scope, or `null`. */
export function liveOutcome(key: string, now = performance.now()): CachedDisplay | null {
  const hit = liveOutcomes.get(key);
  if (hit === undefined) {
    return null;
  }

  promote(liveOutcomes, key, hit);
  return { display: hit.display, fresh: now - hit.at <= OUTCOME_FRESH_MS };
}

/** Record an outcome for text of the moment. Called on the way out of every live evaluation,
 *  including for a row whose element has since gone: the value is still true, and the next render
 *  of that row wants it. */
export function rememberLiveOutcome(key: string, display: PropertyDisplay): void {
  promote(liveOutcomes, key, { display, at: performance.now() });
  evict(liveOutcomes, PROPERTY_LIVE_OUTCOME_ENTRIES);
}

/**
 * Move an entry to the young end, so {@link evict} reads as least-recently-*used* rather than
 * least-recently-*written*.
 *
 * The insertion order of a `Map` is the only order it has, so a re-insert is the mechanism. It
 * matters here in a way it does not for the other evaluation caches: the thing that reads these is
 * scrolling, and under insertion order a table longer than the cap evicts precisely the rows the
 * reader is on their way back to. Reading is the signal; writing is not.
 *
 * Applied on a write as well as on a hit, because `Map.set` on a key already present leaves it
 * where it was, so re-answering a property whose text has moved (which is a *miss*, and so does
 * not promote on the way in) would file the new answer at the position the old one held, ahead of
 * entries nobody has looked at since. Just recomputed is the least stale thing in the cache; it
 * must not be the first thing out of it.
 */
function promote<T>(cache: Map<string, T>, key: string, entry: T): void {
  cache.delete(key);
  cache.set(key, entry);
}

/** Trim a cache to its cap, least-recently-used first (see {@link promote}). An evicted entry costs
 *  one evaluation, and on the note cache that evaluation is a standard-library load. */
function evict<T>(cache: Map<string, T>, cap: number): void {
  while (cache.size > cap) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }

    cache.delete(oldest);
  }
}

// THE KEYS
// ================================================================================================

// The key separator: a NUL, which cannot occur in a vault path, in note text, or in a settings
// value the user can type. Built with `fromCharCode` so no literal NUL byte is ever written into
// this source file.
const SEP = String.fromCharCode(0);

/**
 * The identity of an evaluation *short of its text*: the settings that change what an expression
 * means, the property's own key and its key-level problems, and the scope replayed before it.
 * Everything here is read from the frontmatter, so the key costs no interpreter work.
 *
 * The text is left off because the two caches carry it differently: the note cache holds one entry
 * per property and keeps the text *in* the entry, so a value the reader has edited is a miss rather
 * than a second entry; the live cache appends it with {@link liveKey} and keeps one entry per
 * keystroke.
 *
 * The `noteProperties` setting is deliberately absent even though it changes everything: every path
 * returns before it reaches this while it is off, so no key built here can ever describe a world
 * without it. The rest of the invalidation is not this key's job either: a moved prelude or a
 * refetched exchange rate goes through `refreshNoteScope`, which empties the caches wholesale.
 */
export function scopeKey(
  applyRates: boolean,
  key: string,
  skip: string | null,
  warning: string | null,
  chunks: string[],
): string {
  return [applyRates ? "1" : "0", key, skip ?? "", warning ?? "", ...chunks].join(SEP);
}

/** A {@link scopeKey} narrowed to one exact text — the live cache's key. */
export function liveKey(scoped: string, text: string): string {
  return scoped + SEP + text;
}

/**
 * Every binding of a note keyed the way {@link scopeKey} keys one.
 *
 * Written through {@link scopeChunksAbove} rather than by accumulating the scope as it walks, which
 * would be marginally cheaper: the batch fills these entries and a widget looks one up, so a
 * disagreement between the two would not fail but would quietly stop matching, or worse, hit the
 * wrong scope. Sharing the one function is what makes that impossible rather than merely tested.
 *
 * A property with a binding has no key-level skip so the slot `scopeKey` keeps for it is empty here
 * by construction.
 */
export function outcomeKeys(applyRates: boolean, preamble: NotePreamble): string[] {
  return preamble.bindings.map((binding) =>
    scopeKey(applyRates, binding.key, null, binding.warning ?? null, scopeChunksAbove(preamble, binding.key))
  );
}

/**
 * Every binding's outcome, in order, or `null` if any one of them is unknown.
 *
 * All-or-nothing because the reader is the frontmatter inlay pass, which shows a note's properties
 * as a set: half a set reads as "the others have nothing to say", which is a different claim from
 * "the others have not been evaluated". Age is deliberately not consulted as an old answer is still
 * the answer to paint, and {@link firstStale} is what decides whether to go and get a newer one.
 */
export function knownOutcomes(keys: string[], bindings: PropertyBinding[]): BindingOutcome[] | null {
  const outcomes: BindingOutcome[] = [];
  for (const [index, key] of keys.entries()) {
    const hit = noteOutcome(key, bindings[index].expr);
    if (hit === null) {
      return null;
    }

    outcomes.push(hit.outcome);
  }

  return outcomes;
}

/**
 * The first binding whose committed value is not already answered, or `null` when the whole note
 * is.
 *
 * This is the incremental behavior and it falls out of the key rather than being arranged: a key
 * folds in the chunks replayed *above* its property, so editing property *i* leaves the keys of
 * everything above it untouched and moves the key of everything below it.
 *
 * An entry that is merely *old* counts as unanswered, for the reason entries carry an age at all:
 * a property that reads the clock would otherwise be frozen at whatever it said when the note was
 * first rendered, since nothing about the note ever changes to invalidate it. A note's entries are
 * all written in one pass, so they age out together and the note re-evaluates whole.
 */
export function firstStale(keys: string[], bindings: PropertyBinding[], now = performance.now()): number | null {
  for (const [index, key] of keys.entries()) {
    if (noteOutcome(key, bindings[index].expr, now)?.fresh !== true) {
      return index;
    }
  }

  return null;
}

// COALESCING THE NOTE BATCH
// ================================================================================================

/** How one note's outcomes are produced, injected so the scheduling below can be tested without an
 *  interpreter, a clock or Obsidian. */
export interface BatchDriver {
  /** Run one pass over the note, filling the note cache. Never rejects as a failed pass leaves the
   *  cache as it was, and the waiters are told regardless so nothing hangs on it. */
  run: () => Promise<void>;

  /** Schedule the start of a pass, returning a cancel. This is the coalescing window: every widget
   *  that asks inside it joins the same pass. */
  delay: (start: () => void) => () => void;
}

interface Job {
  /** Everyone waiting to be told the pass is done: one per rendered widget of the note. */
  waiters: Set<() => void>;

  /** The driver of the first request; every later one is about the same scope, so they agree. */
  driver: BatchDriver;

  /** Cancels the not-yet-started pass, or `null` once it has started. */
  cancelDelay: (() => void) | null;

  running: boolean;
}

/** The scopes with a pass pending or running, one entry each. */
const jobs = new Map<string, Job>();

/**
 * Ask for a scope's outcomes, joining whatever pass is already pending or running for it, and be
 * told when it is done. Returns a cancel: a widget whose row is swept must stop waiting, or a
 * torn-down editor is holding a callback that will fire into a dead DOM.
 *
 * `key` is what the pass is *about* (the interpreter generation and the note's binding statements)
 * rather than which note it belongs to. That is what lets two surfaces reading the same note
 * through different routes share one pass: the editor derives its preamble from the buffer and a
 * widget derives its from the metadata cache, and while those agree they are one job. When they
 * disagree, mid-edit, they are two jobs with each correct about its own scope.
 *
 * A note that moves is therefore not something a running pass has to notice: it is simply a
 * different key, and what the pass files is still true of the key it filed it under. Supersession
 * is the cancel below — the surface that moved on drops its waiter, and a pending pass nobody is
 * waiting for never starts.
 *
 * `done` says only *that* the pass finished, never what it produced: the caller re-reads the cache,
 * because between asking and being told its own text may have moved on.
 */
export function requestBatch(key: string, driver: BatchDriver, done: () => void): () => void {
  const job = jobs.get(key) ?? { waiters: new Set(), driver, cancelDelay: null, running: false };
  jobs.set(key, job);
  job.waiters.add(done);

  if (!job.running && job.cancelDelay === null) {
    job.cancelDelay = driver.delay(() => {
      job.cancelDelay = null;
      void runBatch(key, job);
    });
  }

  return () => {
    job.waiters.delete(done);

    // The last widget of an unstarted pass went away: a row swept before its debounce elapsed, a
    // Bases column scrolled past, or an editor that has since moved on to a different scope.
    // Nothing is left to tell, so nothing needs evaluating.
    if (job.waiters.size === 0 && !job.running && job.cancelDelay !== null) {
      job.cancelDelay();
      job.cancelDelay = null;
      jobs.delete(key);
    }
  };
}

/** Drop every pending pass (plugin unload). A pass already running finishes into a cache nobody
 *  will read; there is no way to interrupt a synchronous interpreter mid-note. */
export function cancelBatches(): void {
  for (const job of jobs.values()) {
    job.cancelDelay?.();
    job.cancelDelay = null;
    job.waiters.clear();
  }

  jobs.clear();
}

/**
 * Run one pass for one scope, then tell everyone waiting.
 *
 * One pass, not a loop: an edit landing mid-pass produces a different key, so it is a different job
 * and this one's answers stay true of what they describe. What the waiters have to do about that is
 * ask again — which is why `done` reports only that a pass ran.
 */
async function runBatch(key: string, job: Job): Promise<void> {
  job.running = true;
  try {
    await job.driver.run();
  } finally {
    job.running = false;
    jobs.delete(key);

    // Copied first: a waiter may ask again from inside its own callback, which builds a fresh job
    // rather than mutating the one being drained.
    for (const waiter of [...job.waiters]) {
      waiter();
    }
  }
}
