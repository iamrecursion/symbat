// The answering side's front door: the queue, the tasks and the engine's lifecycle behind one
// object.
//
// The asking side either calls this directly, on the same thread, or reaches it through an
// `onmessage` handler that turns the calls into messages. Nothing here knows which, and nothing
// here can learn.
//
// It owns the queue rather than the host owning it, deliberately. The queue's job is to decide what
// the *interpreter* does next, and after the move the interpreter is over here; a scheduler on the
// far side of a message boundary would be scheduling its own outbox.

import { clearNoteBudgets, releaseNote } from "../budget";
import type { EngineEnv, TaskMap, TaskName, TaskReply } from "../protocol";
import { initEngine, releaseCompletionContexts, resetEngine, setEngineEnv } from "./engine";
import { createQueue, type Priority } from "./queue";
import { closeAllSessions, runTask } from "./tasks";

const queue = createQueue();

/**
 * How a job is to be scheduled: the two things the asking side knows and the queue cannot work out
 * for itself.
 */
export interface Schedule {
  readonly priority: Priority;

  /**
   * What this job is about, so a newer one about the same thing supersedes it. See
   * {@link import("./queue").QueueJob}.
   */
  readonly group?: string;

  /** The interpreter generation the request was made under. */
  readonly generation: number;
}

/**
 * Serve one request, when the queue gets to it.
 *
 * `null` covers every way a request can come to nothing (superseded, obsolete, the engine down)
 * because a surface's response to all of them is the same: keep painting what it has, and ask again
 * if it still cares.
 */
export async function serve<K extends TaskName>(
  name: K,
  request: TaskMap[K]["request"],
  schedule: Schedule,
): Promise<TaskReply<TaskMap[K]["response"]> | null> {
  return queue.submit({
    priority: schedule.priority,
    group: schedule.group,
    generation: schedule.generation,
    run: (shouldAbort) => runTask(name, request, shouldAbort),
  });
}

/**
 * {@link serve} for a caller that has a task name and a request but has lost the link between them.
 *
 * Which is every caller on the far side of a message: `structuredClone` carries the data across and
 * leaves the types behind. The pairing is not re-checked here: it is checked once where the request
 * was built, against the same {@link TaskMap} both sides compile against.
 */
export function serveErased(
  name: TaskName,
  request: unknown,
  schedule: Schedule,
): Promise<TaskReply<unknown> | null> {
  return serve(name, request as TaskMap[TaskName]["request"], schedule);
}

/**
 * Instantiate the interpreter from the base64 module the asking side holds. See
 * {@link import("./engine").initEngine} for why `sync` is a parameter and not a guess.
 */
export function start(base64: string, sync: boolean): Promise<void> {
  return initEngine(base64, sync);
}

/**
 * Discard everything and reset the wasm module, so the next {@link start} begins from a clean one.
 *
 * The sessions go first and explicitly: they are the only contexts that outlive the call that built
 * them, so they are the only ones a reset could leave a surface holding an id for. Dropping them
 * here is what makes a stale id a miss rather than a call into a dead heap.
 */
export function stop(): void {
  queue.cancelAll();
  closeAllSessions();
  resetEngine();
}

/**
 * Replace the environment a context is built in.
 *
 * @returns whether the change needs a fresh instance — a rate change on an instance that has
 * already applied some, which Numbat's set-once rate store makes impossible to do in place.
 */
export function updateEnv(env: EngineEnv): boolean {
  return setEngineEnv(env);
}

/** Declare everything queued under an earlier generation obsolete. */
export function setGeneration(generation: number): void {
  queue.setGeneration(generation);
}

/**
 * Drop what is queued for `group`, or everything queued.
 *
 * The cooperative half of stopping. It reaches every request that has not started and, since the
 * looping tasks now stand aside between items, the one that is running too at its next boundary.
 *
 * What it still cannot reach is a single `interpret` call. Numbat has no fuel, no interrupt hook
 * and no depth cap, so one expression that will not finish is stoppable only by terminating the
 * thread, which is why the stop command keeps a rung below this one.
 */
export function cancel(group: string | null): void {
  if (group === null) {
    queue.cancelAll();
  } else {
    queue.cancel(group);
  }
}

/**
 * Release the replayed completion contexts — the idle policy's effect, applied from wherever the
 * clock the reader is looking at happens to be.
 */
export function releaseContexts(): void {
  releaseCompletionContexts();
}

/**
 * Refill a note's evaluation allowance, or all of them.
 *
 * Routed through here rather than called on `budget.ts` from the asking side, and the distinction
 * is easy to miss because today they are the same module instance. They will not be: the allowance
 * is spent where the interpreter is, so after the move the bucket lives over here and the refusal
 * ledger, the code which decides whether a surface renders at all, stays over there. Two halves of
 * one file, on two sides of a boundary.
 */
export function refill(key: string | null): void {
  if (key === null) {
    clearNoteBudgets();
  } else {
    releaseNote(key);
  }
}
