// Notes whose last evaluation did not finish, and what to render instead of trying again.
//
// The other half of the evaluation limit, and on the other side of the seam. interpreter/budget.ts
// holds the *arm* which lives where the interpreter does. This holds the *ledger*, which lives
// where the surfaces do: it is consulted by the code that decides whether a note renders at all,
// and that code is on the asking side.
//
// A note listed here is not evaluated again until it ages out. That keeps a note which cannot
// finish from spending the whole limit on every render, every scroll and every freshness tick,
// turning a single stall into an endless series thereof.
//
// **Only refusals are remembered, never results.** Nothing here can make a working note show a
// stale value; the worst it can do is delay a retry by {@link OVER_BUDGET_COOLDOWN_MS}, and only
// for the two surfaces whose own keys do not already stop the retry.
//
// Imports tuning.ts, the HTML escaper and two values from its sibling, none of which import
// anything, so this loads under plain `node --test`.

import { EVALUATION_LIMIT_NOTICE_MS, OVER_BUDGET_COOLDOWN_MS, REFUSAL_LEDGER_ENTRIES } from "../tuning";
import { defaultClock, EVALUATION_LIMIT_RESULT } from "./budget";
import { escapeHtml } from "./markup";

/**
 * What a note says when the reader stopped it by hand rather than when it ran out of time.
 *
 * A separate sentence rather than a reuse of {@link EVALUATION_LIMIT_RESULT}'s: "time limit
 * reached" names a setting the reader did not trip and would send them to Runtime to raise a number
 * that was never the problem.
 *
 * It lives here rather than beside the limit's own sentence because a stop is not a budget event at
 * all: nothing spends an allowance, and the only thing the two have in common is this ledger.
 */
export const EVALUATION_STOPPED_TEXT = "Symbat: evaluation stopped";

/**
 * {@link EVALUATION_STOPPED_TEXT} as a result, for the surfaces that have to show a refusal where
 * there is no context to produce one. Frozen for the same reason its sibling is: one object handed
 * to every surface is the wrong place to find out that something started mutating it.
 */
export const EVALUATION_STOPPED_RESULT: { readonly output: string; readonly isError: boolean; } = Object.freeze({
  output: escapeHtml(EVALUATION_STOPPED_TEXT),
  isError: true,
});

/**
 * What a refused note is shown. Held in the entry because there are two ways to end up here and
 * they need different sentences.
 */
type Refusal = { readonly output: string; readonly isError: boolean; };

// Every access writes, so insertion order is recency and eviction is oldest-first without a
// separate promote step.
const refusals = new Map<string, { at: number; stamp: number; result: Refusal; }>();

function file(key: string, stamp: number, now: number, result: Refusal): void {
  refusals.delete(key);
  refusals.set(key, { at: now, stamp, result });

  while (refusals.size > REFUSAL_LEDGER_ENTRIES) {
    const oldest = refusals.keys().next();
    if (oldest.done === true) {
      break;
    }

    refusals.delete(oldest.value);
  }
}

/**
 * Note that evaluating this note ran out of time under interpreter stamp `stamp`.
 *
 * The stamp is opaque here: callers pass `interpreterGeneration()`, which moves whenever the
 * prelude, the exchange rates or a setting changes what an expression *means*. Holding it makes an
 * entry from before such a change unreachable rather than merely old, so the one action that
 * invalidates every other cache in the plugin invalidates this one too, without this module needing
 * to know that any of those things exist.
 */
export function rememberRefusal(key: string, stamp: number, now = defaultClock()): void {
  file(key, stamp, now, EVALUATION_LIMIT_RESULT);
}

/**
 * Note that the reader stopped this note themselves.
 *
 * The same ledger and the same cool-down, because the hazard is the same one: without an entry, the
 * render that was hanging re-fires the moment the interpreter is back and the reader stops the same
 * note over and over. What differs is the sentence — see {@link EVALUATION_STOPPED_TEXT}.
 */
export function rememberStop(key: string, stamp: number, now = defaultClock()): void {
  file(key, stamp, now, EVALUATION_STOPPED_RESULT);
}

/**
 * Whether this note ran out of time recently enough, and under the same interpreter, that trying
 * it again would only stall again.
 */
export function refusedRecently(key: string, stamp: number, now = defaultClock()): boolean {
  return refusalResult(key, stamp, now) !== null;
}

/**
 * What to paint instead of evaluating, or `null` if this note may be tried. The same question as
 * {@link refusedRecently}, for the surfaces that have somewhere to put the answer.
 */
export function refusalResult(key: string, stamp: number, now = defaultClock()): Refusal | null {
  const held = refusals.get(key);
  if (held === undefined || held.stamp !== stamp || now - held.at > OVER_BUDGET_COOLDOWN_MS) {
    return null;
  }

  return held.result;
}

/**
 * Let a note back in: it changed, so the fact that its previous evaluation gave up says nothing
 * about it. The route back for a reader who fixes the expression that was not finishing, and the
 * near half of `refillEvaluationBudget` — {@link import("./budget").releaseNote} is the far one.
 *
 * Wired to the vault's *saved* content rather than to the editor buffer, which is better than it
 * sounds. The evaluation caches key on the buffer, so a note that ran out of time stays out of time
 * through a burst of typing (because every keystroke moves the cache key, finds the refusal already
 * filed there and paints it for the low cost of a map lookup) and comes back to life once the edit
 * is committed, a couple of seconds after the reader stops. One revival per edit, not one per
 * keystroke.
 */
export function forgetRefusal(key: string): void {
  refusals.delete(key);
}

/** Forget every refusal, so everything is tried again (the clear-caches command, and unload). */
export function clearRefusals(): void {
  refusals.clear();
  announcedAt = null;
}

// TELLING THE READER
// ================================================================================================

/** When the reader was last told that a note ran out of time, or `null` if never. */
let announcedAt: number | null = null;

/** How long the limit is, said the way a sentence to the reader needs it. */
export function describeLimit(budgetMs: number): string {
  // Seconds once there are seconds to speak of: the setting is in milliseconds because the
  // difference between two and five seconds is a real judgment about a machine, but "after 10000
  // ms" is not how anyone reads a sentence about how long they waited. One decimal keeps 2500 ms
  // honest without turning 10000 into "10.0".
  return budgetMs >= 1_000 ? `${Number((budgetMs / 1_000).toFixed(1))} s` : `${budgetMs} ms`;
}

/**
 * Whether to announce this trip, and the record that it was announced.
 *
 * Deliberately one window across all notes, not one per note. A Bases table can put fifty
 * unfinishable notes on screen at once, and fifty toasts naming fifty notes helps nobody; the
 * caller's unthrottled `console.warn` is where the complete account lives.
 */
export function shouldAnnounceLimit(now = defaultClock()): boolean {
  if (announcedAt !== null && now - announcedAt < EVALUATION_LIMIT_NOTICE_MS) {
    return false;
  }

  announcedAt = now;
  return true;
}
