// The bounded evaluation cache every note-level surface keeps, and the eviction rule that decides
// when an entry stops being returned.
//
// Six of these exist: the editor's inlay hints and its `.nbt` whole-file pass, the editor's inline
// expressions, the reading view's, the scope inspector's values, and what the interpreter knows
// about a name (interpreter/facts.ts).
//
// So an entry records whether the scope it came from can actually produce a different answer
// (interpreter/purity.ts), and only those entries expire. A scope that cannot change is cached
// until its key moves, which is what it always was; a scope that can is cached for
// {@link IMPURE_FRESH_MS} and then asked again.
//
// **Stale is not the same as absent**, and the difference keeps the editor from flickering. A miss
// has nothing to paint, so the surface paints nothing while it evaluates. A stale hit still has the
// previous answer, which is a second old rather than wrong — so the caller paints it *and*
// schedules a fresh evaluation, the way the frontmatter inlays already treat an aged property
// outcome. `get` reports the difference rather than deciding it.
//
// Imports only tuning.ts, so this loads under plain `node --test`.

import { IMPURE_FRESH_MS } from "../tuning";

/** A cache hit: what was stored, and whether it can still be trusted not to have moved. */
export interface CachedValue<T> {
  value: T;

  /** `false` once an entry whose scope reads the clock is older than {@link IMPURE_FRESH_MS}. Still
   *  the value to paint — see the note on staleness above. */
  fresh: boolean;
}

interface Entry<T> {
  value: T;
  at: number;
  impure: boolean;
}

/**
 * A bounded cache of evaluation results, keyed by a signature of the text and the interpreter
 * generation that produced them.
 *
 * Eviction is by **write** order rather than by use, and is right for these caches: their keys move
 * with the note's own text, so an entry nobody writes again is usually an entry whose note has been
 * edited rather than one the reader has scrolled away from. A re-evaluation counts as use enough,
 * which is why {@link set} refreshes an existing key's position rather than leave it where it was.
 * The property outcome cache promotes on *read* instead as it is keyed by property and read by a
 * Bases table scrolling back over rows it has already shown.
 */
export class EvaluationCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  /** @param cap How many entries to keep. An evicted entry costs one re-evaluation. */
  constructor(private readonly cap: number) {}

  /**
   * What is cached under `key`, or `null` when nothing is. A hit is always the value to use or to
   * paint; `fresh` says whether the caller may stop there or should also ask for a newer one.
   */
  get(key: string, now = performance.now()): CachedValue<T> | null {
    const hit = this.entries.get(key);
    if (hit === undefined) {
      return null;
    }

    return { value: hit.value, fresh: !hit.impure || now - hit.at <= IMPURE_FRESH_MS };
  }

  /**
   * Whether an answer under `key` is current enough that asking again would only reproduce it.
   *
   * What an evaluation pass tests before doing the work, so that two requests for the same scope in
   * one pass cost one evaluation. It has to mean *fresh* rather than *present*: a pass is scheduled
   * precisely because something went stale, and a presence test would see the stale entry and skip
   * the work the pass exists to do.
   */
  hasFresh(key: string, now = performance.now()): boolean {
    return this.get(key, now)?.fresh === true;
  }

  /**
   * Record an evaluation's result.
   *
   * `impure` is whether *this scope* can produce a different answer next time: the user prelude,
   * the note's imports and property bindings, and its own Numbat text. It is decided by the writer,
   * which is the only party holding the scope; a reader that had to be told could be told wrong.
   *
   * `now` is injectable for the same reason it is on {@link get}: a test that can move the read
   * side of freshness but not the write side can only ever assert half of it.
   */
  set(key: string, value: T, impure: boolean, now = performance.now()): void {
    // Deleted first, so a key written again goes to the back rather than staying where it was.
    // `Map.set` on a key already there keeps its original position, which was harmless while every
    // key moved with the note's own text — a second write to one meant an entry nothing would ask
    // for again. Staleness introduced the first key that is written twice on purpose: an impure
    // entry is re-evaluated and re-filed under exactly the same key every IMPURE_FRESH_MS, for as
    // long as the reader keeps looking at it. Without this, that entry ages towards the front of
    // the eviction order while it is being used, and is dropped ahead of colder ones. The refusal
    // ledger does the same thing for the same reason (interpreter/refusals.ts).
    this.entries.delete(key);
    this.entries.set(key, { value, at: now, impure });

    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }

      this.entries.delete(oldest);
    }
  }

  /**
   * Mark entries as unable to change, after that is done they never go stale again.
   *
   * For the one thing a writer cannot know at the moment it writes: whether the pass it belongs to
   * ran out of the note's evaluation allowance (interpreter/budget.ts). An answer the limit cut
   * short is not a value the clock moves, and asking for it again would spend the whole allowance
   * a second time to be told the same thing — so a note that both reads `now()` and exceeds the
   * limit would otherwise freeze for the length of the limit, once per window, for the rest of the
   * session. Only an edit to the note can make that answer different, and an edit moves the key.
   *
   * Keys with no entry are ignored: a pass may have been cut off before it wrote one.
   */
  freeze(keys: Iterable<string>): void {
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry !== undefined) {
        entry.impure = false;
      }
    }
  }

  /** Forget everything. For a caller whose keys do not move on their own, and for the reset
   *  command, which is written so that it needs no theory about what its callees do. */
  clear(): void {
    this.entries.clear();
  }

  /** How many entries are held. For tests and for the debug counters. */
  get size(): number {
    return this.entries.size;
  }
}
