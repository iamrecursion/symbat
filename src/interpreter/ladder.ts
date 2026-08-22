// Trying several ways of starting the interpreter, in order, and remembering why each of them
// failed if they did.
//
// It's a separate file from the things it starts because **a rung that constructs and then says
// nothing is the important failure mode**, and cannot be tested through a real `Worker`. A blocked
// blob URL, a content-security policy that refuses the construction quietly, a platform where
// workers exist and wasm does not — all of them look, from here, like silence. So the policy lives
// where a test can drive it with three stub rungs and a clock that does not tick.
//
// Nothing in this file knows what a worker is. It imports nothing at all.

/** A start that has been attempted and has not yet answered. */
export interface Attempt<T> {
  /** The thing being started. Usable only once {@link ready} resolves. */
  readonly value: T;

  /**
   * Resolves when it has _answered_, not when it was constructed. Construction succeeds on
   * platforms where nothing else does.
   */
  readonly ready: Promise<void>;

  /**
   * Undo an attempt that did not answer, whether it rejected or simply never spoke. Called at most
   * once, and never after {@link ready} resolves.
   */
  readonly abandon: () => void;
}

/** One way of getting the interpreter running. */
export interface Rung<T> {
  /**
   * How this rung is named in the status line and in the log. Reader-facing: "blob URL", not
   * "rung 0".
   */
  readonly detail: string;

  /** Try it. May throw, which counts as this rung failing rather than as the climb failing. */
  readonly open: () => Attempt<T>;
}

/**
 * A timeout, and the way to call it off.
 *
 * Two members rather than a bare promise, because an answering rung leaves its own timeout pending:
 * over a three-rung ladder that is three live timers ticking towards nothing, each for as long as
 * the ready timeout. Injected as a pair so that the test's clock, which does not tick at all,
 * satisfies the same contract as the real one.
 */
export interface Countdown {
  readonly expired: Promise<void>;
  readonly cancel: () => void;
}

/** What worked, and what it is called. */
export interface Climbed<T> {
  readonly value: T;
  readonly detail: string;
}

/** Why a rung did not work, in the order they were tried. */
export interface Rejection {
  readonly detail: string;
  readonly reason: string;
}

/**
 * Take the first rung that answers within `timeoutMs`, abandoning the ones that do not.
 *
 * `null` when every rung failed, with `rejections` holding one entry each as needed by the status
 * line. "The worker did not start" is not a useful thing to tell somebody on a phone. `delay` is
 * injected so a test can climb the whole ladder without waiting for it, and every countdown this
 * starts is called off on the way out of the rung that started it.
 *
 * A rung that answers _after_ being abandoned is ignored: the ladder has moved on and there is no
 * way to un-start what came next. That is why {@link Attempt.abandon} has to actually dispose of
 * the thing rather than merely stop listening to it.
 */
export async function climb<T>(
  rungs: readonly Rung<T>[],
  timeoutMs: number,
  delay: (ms: number) => Countdown,
  rejections: Rejection[] = [],
): Promise<Climbed<T> | null> {
  for (const rung of rungs) {
    let attempt: Attempt<T>;
    try {
      attempt = rung.open();
    } catch (error) {
      rejections.push({ detail: rung.detail, reason: describe(error) });
      continue;
    }

    const TIMED_OUT = Symbol("timed out");
    const countdown = delay(timeoutMs);
    let outcome: unknown;
    try {
      outcome = await Promise.race([
        attempt.ready,
        countdown.expired.then(() => TIMED_OUT),
      ]);
    } catch (error) {
      attempt.abandon();
      rejections.push({ detail: rung.detail, reason: describe(error) });
      continue;
    } finally {
      // However the race ended. A rung that answered in 40 ms would otherwise leave the whole ready
      // timeout ticking behind whatever ran next.
      countdown.cancel();
    }

    if (outcome === TIMED_OUT) {
      // The race is over but the attempt's own promise is not, and a rejection arriving after it
      // lost is an unhandled one. Swallowed here rather than left to the host, which is by then
      // several rungs further on and has nowhere to put it.
      attempt.ready.catch(() => {});
      attempt.abandon();
      rejections.push({
        detail: rung.detail,
        reason: `no answer within ${timeoutMs} ms`,
      });
      continue;
    }

    return { value: attempt.value, detail: rung.detail };
  }

  return null;
}

/** One line naming what was tried and what it said, for the status line and the log. */
export function describeRejections(rejections: readonly Rejection[]): string {
  return rejections.map((rejection) => `${rejection.detail}: ${rejection.reason}`).join("; ");
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
