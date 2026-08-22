// The scheduler in front of the interpreter: one job at a time, newest first within a class, and a
// way to say that a job nobody is waiting for any more should never start.
//
// It exists because the interpreter is a single instance with a single heap, so concurrency here is
// not parallelism: it is a queue whichever way it is written. What the queue adds is the two things
// a bare `await` cannot express:
//
//   * **Supersession.** An editor that has typed three characters has asked three times for the
//     same note's hints. The first two answers are worthless the moment the third arrives, and
//     under a bare queue they are two whole standard-library loads spent producing them. A job
//     names a `group` (a surface and a document) and a newer job in the same group cancels the
//     queued older one outright.
//   * **Obsolescence.** A prelude edit or a rate refresh moves the interpreter generation, and
//     everything queued under the old one is answering a question about a world that no longer
//     exists. Those are dropped at dequeue rather than run and discarded.
//
// **LIFO within a class starves under sustained load, and is only safe because supersession keeps
// at most one live request per surface.** If a caller ever submits ungrouped work in a loop, the
// oldest of it will sit at the bottom of the queue for as long as the loop runs. Say so out loud
// here, because it is exactly the kind of invariant that rots quietly when a new call site is
// added.
//
// No wasm, no `postMessage`, no clock of its own.

import { taskWasAborted } from "./cooperative";

/**
 * How soon a job's answer is wanted.
 *
 * `interactive` is a person waiting with a cursor blinking — a completion, a hover, a hole hint.
 * `visible` is something on screen that will repaint when the answer lands. `background` is work
 * nobody is looking at yet.
 */
export type Priority = "interactive" | "visible" | "background";

/**
 * Highest first. A plain array rather than numbers on the union, so the order is stated once and
 * reads as the order.
 */
const CLASSES: readonly Priority[] = ["interactive", "visible", "background"];

/** One unit of work, and everything the queue needs to decide whether it is still worth doing. */
export interface QueueJob<T> {
  /** How soon the answer is wanted. */
  readonly priority: Priority;

  /**
   * What this job is _about_, conventionally a surface and a document. A newly submitted job
   * cancels any queued job sharing its group, because the two answer the same question and only the
   * newer one is answering it about what is on screen now.
   *
   * Omitted for work that is genuinely one-off, which then queues alongside everything else and is
   * never canceled by anyone but its submitter.
   */
  readonly group?: string;

  /**
   * The interpreter generation this was submitted under. A job whose generation has been left
   * behind by {@link Queue.setGeneration} is dropped without running.
   */
  readonly generation: number;

  /**
   * The work that the job performs. Called at most once, and never synchronously, from
   * {@link Queue.submit}.
   *
   * `shouldAbort` answers whether this job has since been canceled, superseded or left behind by
   * the generation. This can happen _while it runs_, and a queue entry alone cannot tell because
   * by then the entry is no longer in a queue. A job that loops is expected to consult it at its
   * own boundaries (see worker/cooperative.ts) and unwind; one that does not simply runs to the
   * end, which is what every job did before there were boundaries.
   */
  readonly run: (shouldAbort: () => boolean) => Promise<T>;
}

/**
 * Why a job produced nothing, for the caller that wants to tell "no answer" from "the answer is
 * nothing". Every one of them means the same thing to a surface, "ask again if you still care",
 * which is why {@link Queue.submit} collapses them to `null`.
 */
export type Dropped = "superseded" | "obsolete" | "canceled";

export interface Queue {
  /**
   * Queue `job` and settle with what it produced, or with `null` if it never ran.
   *
   * Never rejects: a throwing job is logged and settles `null`, because every caller's recovery is
   * the same — keep what you were painting and ask again — and a rejection is one more thing each
   * of them would have to remember.
   */
  submit<T>(job: QueueJob<T>): Promise<T | null>;

  /**
   * Declare everything queued under an earlier generation obsolete, and tell a running job of an
   * earlier generation to stop at its next boundary.
   *
   * A job with no boundaries still runs to the end. Nothing here can interrupt a single `interpret`
   * call.
   */
  setGeneration(generation: number): void;

  /** Drop every queued job in `group`, and tell a running one in that group to stop. */
  cancel(group: string): void;

  /** Drop everything queued, and tell whatever is running to stop. */
  cancelAll(): void;

  /** How many jobs are waiting — for the tests, and for the idle policy that will read it. */
  pending(): number;

  /** Whether a job is running right now. */
  busy(): boolean;
}

/** A queued job, erased of its result type so one array holds them all. */
interface Entry {
  readonly job: QueueJob<unknown>;
  readonly settle: (value: unknown) => void;
}

/**
 * A fresh scheduler.
 *
 * One per engine instance, because the thing it serializes is the engine. Nothing about it is
 * global, which is what lets a test drive several at once.
 */
export function createQueue(): Queue {
  // Per class, oldest first — so a pop from the end is the newest, which is the LIFO the doc above
  // argues for. A record rather than a map, so that every class provably has a queue: a lookup that
  // could miss would need a fallback, and a fallback here is an array that is pushed to and never
  // read from.
  const waiting: Record<Priority, Entry[]> = { interactive: [], visible: [], background: [] };
  let generation = 0;
  let running = false;

  // The job in `run` right now, and whether anything has since asked it to stop. Held separately
  // from the queues because that is exactly what a running job is no longer in: once it has been
  // popped, the only way to reach it is the callback it was handed.
  let current: Entry | null = null;
  let aborted = false;

  const drop = (entry: Entry, why: Dropped): void => {
    if (why === "superseded" || why === "obsolete") {
      // Deliberately not logged. Both are the queue working: an editor that supersedes its own
      // request twenty times a second is the design, not an event.
    }
    entry.settle(null);
  };

  const remove = (matches: (entry: Entry) => boolean, why: Dropped): void => {
    for (const queue of Object.values(waiting)) {
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (matches(queue[i])) {
          const [entry] = queue.splice(i, 1);
          drop(entry, why);
        }
      }
    }
  };

  /**
   * Tell the running job to stop, if there is one and it matches. Latching rather than assignment:
   * two cancellations arriving in one turn must not un-cancel each other.
   */
  const abortIf = (matches: (entry: Entry) => boolean): void => {
    if (current !== null && matches(current)) {
      aborted = true;
    }
  };

  /** The next job to run, skipping (and settling) everything the world has moved past. */
  const next = (): Entry | null => {
    for (const priority of CLASSES) {
      const queue = waiting[priority];
      while (queue.length > 0) {
        const entry = queue.pop() as Entry;
        if (entry.job.generation < generation) {
          drop(entry, "obsolete");
          continue;
        }

        return entry;
      }
    }

    return null;
  };

  const pump = (): void => {
    if (running) {
      return;
    }

    const entry = next();
    if (entry === null) {
      return;
    }

    running = true;
    current = entry;

    // The place the signal is reset, and it is reset on the way *in* rather than on the way out. A
    // stop that arrives while nothing is running has nothing to latch onto and no next job to be
    // about, so the flag it would leave behind must never be read by whatever starts next.
    aborted = false;

    // `run` is invoked inside the promise chain rather than before it. Every task is asynchronous
    // today, so a synchronous throw cannot happen. If one ever did, however, it would escape `pump`
    // outright, leaving `running` set and the queue deadlocked for the life of the instance with
    // every submitted job holding a promise nothing will settle. In here it is just a rejection,
    // which the arm below already knows what to do with.
    void Promise.resolve()
      .then(() => entry.job.run(() => aborted))
      .catch((error: unknown) => {
        // A job that unwound because it was told to stop is the queue working, and settles the same
        // `null` a job dropped before it started would have. Anything else is a bug in a task: log
        // it and settle empty rather than leave the surface holding a promise that never resolves.
        if (!taskWasAborted(error)) {
          console.error("Symbat: an interpreter task failed", error);
        }
        return null;
      })
      .then((value) => {
        // In this order, deliberately: the flag is cleared *before* the waiter is told, so that a
        // caller which awaits an answer and then asks whether the queue is busy is not told yes
        // about its own finished job. The next job starts after the waiter has had its turn, so a
        // caller can supersede on the strength of what it just learned.
        running = false;
        current = null;
        entry.settle(value);
        pump();
      });
  };

  return {
    submit<T>(job: QueueJob<T>): Promise<T | null> {
      if (job.generation < generation) {
        return Promise.resolve(null);
      }

      if (job.group !== undefined) {
        const { group } = job;
        remove((entry) => entry.job.group === group, "superseded");

        // The running job too, the case supersession was written for: an editor three keystrokes
        // into a note has already started a pass whose answer describes a document that no longer
        // exists. Before there were boundaries it ran to the end regardless.
        abortIf((entry) => entry.job.group === group);
      }

      return new Promise<T | null>((resolve) => {
        waiting[job.priority].push({ job, settle: resolve as (value: unknown) => void });

        // A turn before anything starts, so that a caller submitting several jobs in one tick gets
        // the supersession it asked for rather than having the first one already running.
        void Promise.resolve().then(pump);
      });
    },

    setGeneration(next_: number): void {
      generation = next_;
      remove((entry) => entry.job.generation < generation, "obsolete");
      abortIf((entry) => entry.job.generation < generation);
    },

    cancel(group: string): void {
      remove((entry) => entry.job.group === group, "canceled");
      abortIf((entry) => entry.job.group === group);
    },

    cancelAll(): void {
      remove(() => true, "canceled");
      abortIf(() => true);
    },

    pending(): number {
      return Object.values(waiting).reduce((total, queue) => total + queue.length, 0);
    },

    busy(): boolean {
      return running;
    },
  };
}
