// The cooperative part of task stopping, with messages able to issue mid-task aborts at yield
// points.
//
// A task can run for a long time (two hundred code blocks is two hundred standard-library loads,
// for example) and until it yields, the thread it is on does nothing else. In the worker that means
// the `cancel` message sitting in the port's queue is not delivered, so "stop what you are doing"
// reaches only work that has not started. In the in-process fallback it means the same message plus
// every repaint Obsidian wanted to make.
//
// **`MessageChannel` is a portable macro-task yield.** `setTimeout(0)` is clamped to 4 ms once
// nesting passes five, which over a hundred items is four hundred milliseconds of pure clamp;
// `requestIdleCallback` is off by default in Safari; and `scheduler.postTask` / `scheduler.yield`
// are unimplemented in WebKit, which is what Obsidian mobile runs under on iOS and iPadOS.
//
// What this _cannot_ do is interrupt a single `interpret` call. Numbat has no fuel, no interrupt
// hook and no depth cap, so one expression that will not finish is still only stoppable by
// terminating the thread. This bounds the *number* of further calls, exactly as the evaluation
// limit does, providing extra granularity without replacing the more strict lever.

import { suspendBudget } from "../budget";

/**
 * One `MessageChannel` and the yields waiting on it.
 *
 * There are **two** of these and a yield alternates between them: a single reused channel deadlocks
 * the whole mechanism under node. A `MessagePort` drains its own queue in a loop, running
 * microtasks between messages, so a resolver that yields again posts straight back into the drain
 * that is still running, which picks it up without ever returning to the event loop. Nothing else
 * the loop holds is ever serviced again, and the message the yield exists to let through — `cancel`
 * — sits in the parent port's queue for the whole pass.
 *
 * Alternating guarantees the message a resolver posts goes to the *other* port, so the drain in
 * progress finds nothing more and the loop gets its turn.
 *
 * A browser is thought not to need this — a posted message is its own task there, appended behind
 * whatever is already queued — but that is an inference about an engine that this plugin's test
 * suite does not run on suite cannot run, and a second channel costs only one allocation for the
 * life of the worker.
 */
interface Lane {
  readonly channel: MessageChannel;
  readonly waiting: (() => void)[];
}

let lanes: readonly [Lane, Lane] | null = null;
let other = false;

// How many yields are in flight, which is what decides whether the ports speak for the event loop.
let outstanding = 0;

/**
 * The half of node's `MessagePort` that no browser has.
 *
 * An open port is a live handle on node's event loop, and a loop with a live handle never drains,
 * so a process that has yielded once never exits again. That is invisible in Obsidian, where the
 * worker is terminated rather than drained, and total under `node --test`, where the whole suite
 * hangs with every test passed. Held only while a yield is actually outstanding, so the handle
 * describes real pending work rather than the existence of the channel.
 *
 * Optional because in a browser or a real worker neither method exists, and there is nothing there
 * for them to do.
 */
interface LoopHandle {
  ref?: () => void;
  unref?: () => void;
}

/** Make the ports speak for the loop, or stop them speaking for it. */
function holdLoop(hold: boolean): void {
  for (const lane of lanes ?? []) {
    const handle = lane.channel.port1 as LoopHandle;
    if (hold) {
      handle.ref?.();
    } else {
      handle.unref?.();
    }
  }
}

/**
 * Build a lane and start both its ports. Neither is ever closed: the channel lives as long as the
 * worker does, and closing one would strand a yield already in flight.
 */
function openLane(): Lane {
  const lane: Lane = { channel: new MessageChannel(), waiting: [] };
  lane.channel.port1.onmessage = () => {
    // One waiter per posted message, in order. Shifting rather than draining, so a resolver that
    // synchronously yields again queues behind its own message rather than consuming it.
    lane.waiting.shift()?.();
    outstanding -= 1;
    if (outstanding === 0) {
      holdLoop(false);
    }
  };

  lane.channel.port1.start();
  lane.channel.port2.start();
  return lane;
}

/** Hand the thread back long enough for a round of messages to be delivered, then take it back. */
export function yieldToMessages(): Promise<void> {
  lanes ??= [openLane(), openLane()];

  other = !other;
  const lane = other ? lanes[0] : lanes[1];

  return new Promise<void>((resolve) => {
    if (outstanding === 0) {
      holdLoop(true);
    }

    outstanding += 1;
    lane.waiting.push(resolve);
    lane.channel.port2.postMessage(0);
  });
}

/**
 * How a task says it was stopped.
 *
 * Thrown to unwind, never to be reported. Its message and its stack are read by nothing, and the
 * two places that catch it both ask {@link taskWasAborted} rather than looking inside. It is an
 * `Error` because throwing anything else is a lint error across this repository, and that rule is
 * right about the general case, but a reader who finds this on a console has been shown something
 * that was working as designed, so it says as much.
 */
class TaskAborted extends Error {
  constructor() {
    super("the interpreter task was told to stop (this is the queue working, not a failure)");
    this.name = "TaskAborted";
  }
}

/**
 * Whether `error` is a task unwinding because it was told to stop, rather than something going
 * wrong. The queue settles the first as an ordinary "no answer" and logs the second.
 */
export function taskWasAborted(error: unknown): boolean {
  return error instanceof TaskAborted;
}

/**
 * A place a long task can be stopped: check, stand aside for a round of messages, and check again.
 *
 * Both checks earn their place. The first is what makes a boundary useful when the answer is
 * already known: a job canceled while the previous item ran should not start another. The second
 * is that the message that cancels it can only be *delivered* in the gap, so asking before the gap
 * and not after would be asking before the answer could exist.
 *
 * The budget stands down across the gap, so a task is not charged for the time it spent letting
 * somebody else speak — see {@link suspendBudget}.
 *
 * Throws to unwind rather than returning a verdict, deliberately. A boundary sits in the middle of
 * a loop that is accumulating partial results, and every caller's handling of "stop" is identical:
 * abandon them. Returning a boolean would put that decision, written the same way, at every
 * boundary in the file, and one of them would eventually be written differently.
 */
export async function breath(shouldAbort: () => boolean): Promise<void> {
  if (shouldAbort()) {
    throw new TaskAborted();
  }

  const resume = suspendBudget();
  try {
    await yieldToMessages();
  } finally {
    resume();
  }

  if (shouldAbort()) {
    throw new TaskAborted();
  }
}
