// The evaluation limit: how long one note's evaluation may take before the rest of it is skipped.
//
// Numbat cannot be interrupted. There is no fuel counter, no interrupt hook and no recursion depth
// cap, and the wasm surface is `new`/`interpret`/`free`. A call that has started runs to the end
// wherever it runs, and because the VM keeps its call stack on the heap, runaway recursion doesn't
// even result in a quick trap. What *can* be bounded is how many more calls are made: a deadline
// armed for one piece of work, which the funnel in interpreter/numbat.ts consults before it touches
// the wasm. That turns "this note never finishes" into "this note finishes short", which the caches
// and the renderers already know how to hold, since a refusal is an ordinary error result.
//
// The deadline is ambient rather than threaded through the evaluators as threading it would reach
// only the calls that go through an injected `run`, which is about half of them and almost none of
// the time. `replayPreamble` runs once per import chunk and per binding, the shared-block replay is
// quadratic in the note, and `createContext` — the single largest cost in the plugin at 163 ms —
// goes through nothing at all.
//
// Nothing is armed unless a task armed it, and no interactive path arms one. Completion, hover, the
// typed-hole probe and the REPL never open a scope, so `outOfBudget()` answers `false` for them
// essentially by fiat.
//
// What is *not* here is the refusal ledger (interpreter/refusals.ts). The arm is consulted where
// the interpreter is; the ledger is consulted where the surfaces are, and after the move those are
// two threads. They were one file while they were one module instance, and a refill posted across
// the boundary would have reached only this half of it.
//
// Imports only tuning.ts and the HTML escaper, neither of which imports anything, so this loads
// under plain `node --test`.

import { BUDGET_BUCKET_ENTRIES, BUDGET_REFILL_IDLE_MS } from "../tuning";
import { escapeHtml } from "./markup";

/**
 * What every surface shows in place of an evaluation the limit refused.
 *
 * Lives here rather than beside the interpreter. It is the limit's own vocabulary, so it belongs
 * with the limit; and the interpreter is unloadable outside a bundle — a message no test can name
 * is a message whose disappearance no test can catch.
 */
export const EVALUATION_LIMIT_TEXT = "Symbat: evaluation time limit reached";

/**
 * {@link EVALUATION_LIMIT_TEXT} as a result, for the surfaces that have to show a refusal where
 * there is no context to produce one: a code block the reading view skipped, an inlay block the
 * pass never opened, a property batch answering from the cool-down. Being one object also means the
 * sentence a reader sees cannot drift between surfaces.
 *
 * It is here rather than with the interpreter for a third reason the other two do not have: after
 * the seam, half the places that show it are on the side that has no interpreter to ask.
 *
 * Frozen because it is shared. Nothing treats a result as mutable today, and one object handed to
 * every surface is the wrong place to find out that something started to.
 */
export const EVALUATION_LIMIT_RESULT: { readonly output: string; readonly isError: boolean; } = Object.freeze({
  output: escapeHtml(EVALUATION_LIMIT_TEXT),
  isError: true,
});

/** Where the time comes from. Injected so the whole policy is testable with no interpreter and no
 *  timers (the same seam the outcome caches use for their freshness (properties/outcome-cache.ts)).
 */
export type Clock = () => number;

/** What a caller that passes no clock is measured by. Exported so the ledger next door reads the
 *  same clock rather than declaring its own copy of this line: the two halves of the limit compare
 *  their timestamps with each other's constants, and two independently-written defaults is how
 *  they would come to be measured against two different origins. */
export const defaultClock: Clock = () => performance.now();

/** What one budgeted piece of work produced, and whether it was cut short. */
export interface BudgetResult<T> {
  value: T;

  /** Whether anything was actually *refused*, as opposed to merely finishing late. See
   *  {@link withBudget} for why the difference decides what the caller does with `value`. */
  exceeded: boolean;
}

// THE ARMED DEADLINE
// ================================================================================================

/** The innermost armed budget, or `null` when nothing is under one (which is every interactive
 *  path) and is why the check {@link outOfBudget} makes on every statement costs a single null
 *  comparison there. */
let arm: { deadline: number; clock: Clock; } | null = null;

// Whether anything under the current arm was actually refused. Recorded here rather than re-derived
// from the clock afterwards, because those are different questions: work that finished a hair past
// its deadline without ever being turned away is complete and its results are true, while work that
// was refused is missing whatever came after the refusal. Only the second may not be cached whole.
let refused = false;

// How long the current arm has spent suspended — see {@link suspendBudget}. Subtracted from what
// the note is charged, so that a task which stepped aside to let a cancellation through is not
// billed for the time it was not running.
let idled = 0;

/**
 * Whether the caller must stop, and the record that it did.
 *
 * Answers `false` whenever no budget is armed, reading no clock in that case, so the interactive
 * paths, which never arm one, cannot be refused by a limit they were never given.
 */
export function outOfBudget(): boolean {
  if (arm === null || arm.clock() < arm.deadline) {
    return false;
  }

  refused = true;
  return true;
}

/** What arming a budget put aside, so that disarming can put it back. Opaque to callers: the two
 *  functions below are the only things that read it. */
interface Armed {
  readonly outerArm: { deadline: number; clock: Clock; } | null;
  readonly outerRefused: boolean;
  readonly outerIdled: number;
  readonly clock: Clock;
  readonly start: number;
  readonly carried: number;
  readonly key: string | undefined;
}

/** Put a deadline in force, or answer `null` when `budgetMs` means "unbudgeted". */
function armBudget(budgetMs: number, options: { key?: string; clock?: Clock; }): Armed | null {
  if (budgetMs <= 0) {
    return null;
  }

  const clock = options.clock ?? defaultClock;
  const start = clock();

  // Read once, here, rather than recomputed when the spend is recorded: the two would otherwise
  // have to agree about whether the burst was over, having asked at different moments.
  const carried = carriedBy(options.key, start);
  const own = start + Math.max(0, budgetMs - carried);

  const armed: Armed = {
    outerArm: arm,
    outerRefused: refused,
    outerIdled: idled,
    clock,
    start,
    carried,
    key: options.key,
  };

  arm = { deadline: arm === null ? own : Math.min(arm.deadline, own), clock };
  refused = false;
  idled = 0;
  return armed;
}

/** Take the deadline back out of force, and charge the note for the time that was actually spent
 * under it. */
function disarmBudget(armed: Armed): void {
  // One read, so what was spent and when it was spent describe the same instant.
  const end = armed.clock();
  charge(armed.key, armed.carried + (end - armed.start - idled), end);
  arm = armed.outerArm;
  refused = armed.outerRefused || refused;

  // The enclosing arm's own wall clock covered this one's idling too, so the time is handed
  // outward rather than dropped.
  idled += armed.outerIdled;
}

/**
 * Run `task` under a budget of `budgetMs`, and report whether anything was refused.
 *
 * **`task` must be synchronous.** A wall-clock deadline held across an `await` charges the note for
 * time the interpreter did not spend, and worse, applies to whatever else runs in the gap (e.g. a
 * completion probe, another pane's pass). Every caller already has a region where, in
 * properties/note-outcomes.ts's own words, "from here down nothing yields"; this is armed around
 * exactly that region, never around the awaits above it. An asynchronous task is a programming
 * error and says so on the console rather than silently mis-measuring.
 *
 * A task that genuinely has to yield — one long enough that a cancellation must be able to reach it
 * — uses {@link withBudgetAsync} and {@link suspendBudget} instead, which answer both halves of
 * that objection rather than ignoring them.
 *
 * `budgetMs <= 0` runs the task unbudgeted, which is what the setting's zero means.
 *
 * `options.key` names the *note*, so that several pieces of work about one note share one
 * allowance. Absent, the budget is this call's alone.
 *
 * Nesting takes the earlier of the two deadlines: work inside other work cannot buy itself more
 * time than the work containing it has left, and a refusal inside is a refusal outside.
 */
export function withBudget<T>(
  budgetMs: number,
  task: () => T,
  options: { key?: string; clock?: Clock; } = {},
): BudgetResult<T> {
  const armed = armBudget(budgetMs, options);
  if (armed === null) {
    return { value: task(), exceeded: false };
  }

  try {
    const value = task();
    if (isThenable(value)) {
      console.error("Symbat: withBudget was given an asynchronous task; its deadline is meaningless");
    }

    // Built before the `finally` runs, so this is the *inner* arm's answer, which is what the
    // caller asked about.
    return { value, exceeded: refused };
  } finally {
    disarmBudget(armed);
  }
}

/**
 * {@link withBudget} for a task that yields.
 *
 * The objection the synchronous contract raises is important, and is answered by this in two parts:
 *
 *   * _The note must not be charged for time the interpreter did not spend._ Every yield inside the
 *     task goes through {@link suspendBudget}, which moves the deadline forward by however long it
 *     was away and subtracts the same interval from what the note is charged. A yield is therefore
 *     free, whether it took a microsecond or a paint.
 *   * _The deadline must not apply to whatever else runs in the gap._ Suspending clears the arm
 *     outright, so during the gap {@link outOfBudget} answers `false` for exactly the reason it
 *     does on any interactive path: nothing is armed.
 *
 * What makes the second part sufficient rather than merely necessary is the scheduler: the queue in
 * worker/queue.ts runs one job at a time and does not start the next until the current one settles,
 * so nothing else evaluating can be in the gap to begin with. If that ever stops being true, this
 * needs a stack of arms rather than one.
 */
export async function withBudgetAsync<T>(
  budgetMs: number,
  task: () => Promise<T>,
  options: { key?: string; clock?: Clock; } = {},
): Promise<BudgetResult<T>> {
  const armed = armBudget(budgetMs, options);
  if (armed === null) {
    return { value: await task(), exceeded: false };
  }

  try {
    const value = await task();
    return { value, exceeded: refused };
  } finally {
    disarmBudget(armed);
  }
}

/**
 * Step out from under the deadline, and answer with the way back.
 *
 * For the one thing a budgeted task may legitimately do across an `await`: stand aside so that a
 * message asking it to stop can be delivered. The returned function moves the deadline forward by
 * the time spent away and records the same interval as unbilled, so stepping aside neither shortens
 * the note's allowance nor lets an unrelated caller be refused by a limit it was never given.
 *
 * Answers a no-op when nothing is armed, so a caller never has to ask.
 *
 * Resuming twice does nothing the second time; a `finally` that has already run its `try` is the
 * expected shape and not an error.
 */
export function suspendBudget(): () => void {
  const held = arm;
  if (held === null) {
    return () => {};
  }

  const at = held.clock();
  arm = null;
  let resumed = false;

  return () => {
    if (resumed) {
      return;
    }

    resumed = true;
    const away = held.clock() - at;
    held.deadline += away;
    idled += away;
    arm = held;
  };
}

/** Whether a value is promise-shaped, without assuming it is an object at all. */
function isThenable(value: unknown): boolean {
  return typeof (value as { then?: unknown; } | null | undefined)?.then === "function";
}

// ONE ALLOWANCE PER NOTE
// ================================================================================================
//
// How much of each note's allowance is already spent, and when it was last spent. See
// {@link BUDGET_REFILL_IDLE_MS} for why the allowance belongs to the note rather than to the task.
//
// Every access writes, so insertion order is recency and eviction is oldest-first without a
// separate promote step.

const buckets = new Map<string, { spent: number; at: number; }>();

/** How much of `key`'s allowance is already spent, or zero when the burst it was spent on is
 *  over. */
function carriedBy(key: string | undefined, now: number): number {
  if (key === undefined) {
    return 0;
  }

  const held = buckets.get(key);
  return held === undefined || now - held.at > BUDGET_REFILL_IDLE_MS ? 0 : held.spent;
}

/** Record what a note's allowance now stands at, and when. */
function charge(key: string | undefined, spent: number, now: number): void {
  if (key === undefined) {
    return;
  }

  buckets.delete(key);
  buckets.set(key, { spent, at: now });

  while (buckets.size > BUDGET_BUCKET_ENTRIES) {
    const oldest = buckets.keys().next();
    if (oldest.done === true) {
      break;
    }

    buckets.delete(oldest.value);
  }
}

/**
 * Give a note its whole allowance back: it changed, so what its previous evaluation cost says
 * nothing about it.
 *
 * The *far* half of a refill, and only that half. The near one —
 * {@link import("./refusals").forgetRefusal} — lifts the cool-down the note is serving, and lives
 * where the surfaces that observe it do. `refillEvaluationBudget` (interpreter/host.ts) is the one
 * caller of both, which is what keeps them from drifting apart.
 */
export function releaseNote(key: string): void {
  buckets.delete(key);
}

/** Forget every allowance (a cache clear, or unload). */
export function clearNoteBudgets(): void {
  buckets.clear();
}
