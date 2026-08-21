// The asking side of the boundary: who owns the interpreter, where it runs, how a request reaches
// it, and what has to be learned from every answer.
//
// Every surface goes through `ask`. What it gets back is the task's own answer, or `null`, which
// covers the engine being down, the request having been superseded, and the world having moved on
// since it was made. All three mean the same thing to a surface, which is why they are one value:
// keep painting what you have, and ask again if you still care.
//
// Three things the envelope carries that no caller should have to remember, and that this module
// therefore acts on for all of them:
//
//   * **The dimension and unit names a context build enumerated.** Nothing else announces them, and
//     without them every unit silently stops being syntax-highlighted.
//   * **A panic.** The answering side records one and carries on; it cannot restart itself, and
//     across a boundary it would not be able to. Here is where a restart is scheduled.
//   * **The prelude error**, which used to be read out of module state immediately after a context
//     was built. That ordering does not survive a boundary, so the tasks that need it carry it in
//     their own answers and this module leaves it alone.
//
// The transport is genuinely a choice: a `Worker` where one can be constructed, and the same code
// called directly where one cannot. **The two are not equivalent, and this module is where that
// stops being an implementation detail.** Only the worker path can stop an evaluation that has
// already started: Numbat's VM has no fuel, no interrupt hook and no depth cap, so falling back is
// not merely slower, it is weaker. Which one is in force is therefore reported (see
// {@link describeInterpreterPath}) rather than left for the reader to infer.

import { Notice } from "obsidian";
import workerSource from "symbat:worker-source";
import type { InterpreterThread } from "../settings/defs";
import type { PreludePart } from "../settings/util";
import { forgetSemanticNames, recordSemanticNames } from "../syntax/type-names";
import { RESPAWN_STORM_LIMIT, RESPAWN_STORM_WINDOW_MS, STOP_GRACE_MS, WORKER_READY_TIMEOUT_MS } from "../tuning";
import { climb, type Countdown, describeRejections, type Rejection, type Rung } from "./ladder";
import type { EngineEnv, TaskMap, TaskName } from "./protocol";
import { forgetRefusal, rememberStop } from "./refusals";
import { type InterpreterPath, localAttempt, type Transport, type TransportHost } from "./transport";
import { WASM_BASE64 } from "./wasm-binary";
import { blobWorkerUrl, dataWorkerUrl, workerAttempt } from "./worker-transport";
import type { Priority } from "./worker/queue";

export type { InterpreterPath };
export type { Priority };

// WHAT A CONTEXT WOULD CONTAIN
// ================================================================================================

// Bumped whenever something a fresh context bakes in changes — the user prelude, the exchange
// rates. See `interpreterGeneration`.
let generation = 1;

/**
 * A stamp identifying what a context built *now* would contain, beyond the code fed to it: the user
 * prelude and the exchange rates.
 *
 * Surfaces that cache evaluation results fold this into their cache key. Keying on the note's own
 * text alone is not enough as the same block evaluates differently after a prelude edit or a rate
 * refresh, and enumerating the environment at each cache site is how three of them came to disagree
 * about it. One number, bumped here, is the whole contract: a caller cannot forget a component it
 * never has to name.
 *
 * **A respawn does not move it**, and that is deliberate rather than an omission. A crash does not
 * change what a note means, and this number is folded into every evaluation key in the vault;
 * bumping it here would turn a crash storm into a vault-wide re-evaluation storm.
 */
export function interpreterGeneration(): number {
  return generation;
}

/**
 * Declare that every cached evaluation is out of date, whether or not anything actually changed.
 *
 * Deliberately a *claim* rather than an observation. Every surface that caches an evaluation folds
 * {@link interpreterGeneration} into its key, so moving it is the one action that reaches all of
 * them at once — including the per-view caches this module has no reference to and could not empty
 * if it wanted to.
 *
 * Nothing is freed here: the entries are not deleted, they simply stop being found, and are evicted
 * in the ordinary way as new ones arrive. What it *does* reach is the queue, where a request made
 * under the old generation is answering a question about a world that no longer exists and is
 * dropped rather than run.
 */
export function invalidateCachedEvaluations(): void {
  generation += 1;
  transport?.setGeneration(generation);
}

// WHICH THREAD
// ================================================================================================

// What the reader asked for, which is not what they necessarily got — hence the status line, which
// names what actually happened.
let wanted: InterpreterThread = "worker";

// Whether the running interpreter was started before spawning was permitted, and is therefore on
// the in-process path for a reason that has since expired. See `allowInterpreterSpawn`.
let startedEarly = false;

// Nothing spawns before the workspace is ready. Not a performance tweak but a matter of what the
// plugin costs a reader with no Numbat content at all: a thread, a 1.9 MB compile and a stdlib
// load, for a feature they never use. `ensureInterpreter` still spawns on first real demand, which
// for most vaults is never.
let spawnAllowed = false;

// Set for the session once restarting has stopped being worth trying. See `noteCrash`.
let latched = false;

// Why the ladder ended up where it did, for the status line. Empty when nothing was rejected.
let rejections: Rejection[] = [];

// What the reader's own prelude is currently being blamed for. See `noteCrash`: a prelude is
// replayed into *every* context, so it is the only thing that can make every task fail, and moving
// a bomb onto a weaker thread is not a fix.
let preludeSuspended = false;

/** Choose where the interpreter runs. Takes effect at the next start, which the caller forces by
 *  restarting; a change with nothing running is simply remembered. */
export function setInterpreterThread(next: InterpreterThread): void {
  if (next === wanted) {
    return;
  }

  wanted = next;
  // The reader has just chosen a path, so an earlier session's verdict about the other one is no
  // longer the reason for anything, including a start that failed outright. The session tally is
  // deliberately *not* cleared: it is a fact about the session, and a bug report is the thing that
  // reads it.
  latched = false;
  rejections = [];
  failedAt = null;
  crashes = [];
  disclosedNoWorker = false;
  blockedReason = null;
  if (up || starting !== null) {
    restartPending = true;

    // Restarted now rather than at the next demand. The reader has just moved a setting whose whole
    // visible effect is which affordances exist; leaving that until something happens to ask for an
    // evaluation makes it look inert. Deliberately not an unconditional start: a cold interpreter
    // stays cold, because choosing where it *would* run is not asking for it to run.
    void ensureInterpreter();
  }
}

/**
 * Permit spawning. Called once the workspace is ready; before it, `ensureInterpreter` uses the
 * in-process path rather than constructing a thread during Obsidian's own startup.
 *
 * A start that happened before this is replaced rather than left alone. Something can ask for an
 * evaluation during Obsidian's own startup (a prelude load, a note already open) and without this
 * that one early question would decide the whole session's interpreter path, silently and in the
 * weaker direction.
 */
export function allowInterpreterSpawn(): void {
  spawnAllowed = true;
  if (startedEarly && wanted === "worker") {
    startedEarly = false;
    restartPending = true;

    // Carried out here rather than left for the next demand, and that distinction was a bug rather
    // than a nicety: marking it only means the interpreter is *not ready* from now until something
    // happens to ask for an evaluation, and the first thing to ask gets told to try again instead
    // of being served. A REPL open at startup met exactly that.
    void ensureInterpreter();
  }
}

// THE INSTANCE
// ================================================================================================

// How the interpreter is currently reached, or `null` when it is not running. Exactly one exists at
// a time, and that is an invariant rather than a tidiness: Numbat's exchange rates go into a
// per-module `OnceLock`, so two instances are two rate states and two 1.9 MB modules.
let transport: Transport | null = null;

// The in-flight (or completed) start, so concurrent callers share one rather than racing to
// instantiate. Nulled on restart, which is what lets the next caller begin a fresh one.
let starting: Promise<void> | null = null;

// A synchronous mirror of `starting` having resolved. The completion paths need to know this
// without awaiting; cleared on restart.
let up = false;

// Set when a task reported a panic, or the transport itself broke. The reinitialization is deferred
// to the next `ensureInterpreter()`, so the render that is already in flight finishes against the
// instance it started on rather than having it swapped out underneath.
let restartPending = false;

// The crashes inside the storm window, most recent last, each remembering what kind it was. Two
// questions are asked of it and they are not the same question: *anything* crashing repeatedly
// implicates the prelude, since a prelude is replayed into every context; only a **transport**
// fault is evidence about the thread. Counting by kind rather than by length is what keeps a
// Numbat panic from standing in for a fault the latch is accumulating.
let crashes: { at: number; kind: "task" | "transport"; }[] = [];

// How many times the instance has been replaced since the plugin loaded, of whatever cause. A
// plain tally rather than a windowed one, because the only thing that reads it is the status
// line.
let restartsThisSession = 0;

// When the last complete failure to start happened, or `null` if the last attempt got somewhere.
// See `ensureInterpreter`: without this a device where nothing works pays the whole ladder again
// for every surface that asks.
let failedAt: number | null = null;

// What a context is built in, held here rather than only over there. A respawned worker is a fresh
// module with no environment at all, so the asking side has to be able to state it again — which is
// why this is a field and not a fire-and-forget call.
let env: EngineEnv = { ratesXml: null, prelude: [] };

/** What the environment currently reaches the interpreter as — which is not what was published,
 *  if the prelude has been suspended for crashing it. */
function effectiveEnv(): EngineEnv {
  return preludeSuspended ? { ...env, prelude: [] } : env;
}

const transportHost: TransportHost = {
  onStale: () => {
    // Not counted as a crash: replacing the module is the *correct* response to a rate change, and
    // a reader whose rates moved four times in a minute has not discovered anything about their
    // device.
    if (up) {
      restartPending = true;
    }
  },
  onFault: (message) => {
    console.error(`Symbat: the interpreter failed — ${message}`);

    // Torn down at once rather than at the next use, unlike a panic. A panic leaves an instance
    // that still answers, so the render already in flight may as well finish against it; a fault
    // means there is nothing on the other end, and every request outstanding would otherwise wait
    // for an answer that is never coming.
    resetInstance();
    noteCrash("transport");
  },
};

/**
 * The ways of starting the interpreter, best first, or an empty list when there is no way this
 * reader has agreed to.
 *
 * **The in-process rung is not the bottom of the worker ladder, and that is deliberate.**  The two
 * paths differ in key ways: only a worker can be terminated, and terminating is the only thing that
 * stops an evaluation already running. So a reader who asked for the worker and cannot have one is
 * told, and chooses, rather than being moved somewhere weaker in silence.
 *
 * The exception is a start before {@link allowInterpreterSpawn}: that runs in process because
 * spawning during Obsidian's own startup is not something to do on the strength of one early
 * question, and it is *replaced* by a worker the moment spawning is permitted.
 */
function rungs(): Rung<Transport>[] {
  const local: Rung<Transport> = {
    detail: "in process",
    open: () => localAttempt(WASM_BASE64, transportHost),
  };

  if (wanted === "main") {
    return [local];
  }

  if (latched) {
    return [];
  }

  if (!spawnAllowed) {
    return [local];
  }

  return [
    { detail: "blob URL", open: () => workerAttempt(blobWorkerUrl(workerSource), WASM_BASE64, transportHost) },
    { detail: "data: URL", open: () => workerAttempt(dataWorkerUrl(workerSource), WASM_BASE64, transportHost) },
  ];
}

/**
 * Start the interpreter (once), restarting first if a previous task reported a panic.
 *
 * Never rejects for a reason a caller can act on: a start that fails leaves `up` false, and every
 * surface already checks {@link interpreterReady} before asking for anything.
 */
export function ensureInterpreter(): Promise<void> {
  if (restartPending) {
    resetInstance();
  }

  // A start that failed outright is not retried on every keystroke as climbing a whole ladder is up
  // to three ready timeouts, and a device where nothing works would spend all of them again for
  // each surface that asked. Retried after the same window a crash storm is counted over, which is
  // the shortest interval at which "try again" is plausibly a different answer.
  if (failedAt !== null) {
    if (Date.now() - failedAt < RESPAWN_STORM_WINDOW_MS) {
      return Promise.resolve();
    }

    failedAt = null;
    starting = null;
  }

  starting ??= (async () => {
    rejections = [];
    const ladder = rungs();
    const climbed = ladder.length === 0
      ? null
      : await climb(ladder, WORKER_READY_TIMEOUT_MS, countdown, rejections);
    if (climbed === null) {
      failedAt = Date.now();
      console.error(`Symbat: the interpreter could not be started — ${describeRejections(rejections)}`);
      if (wanted === "worker") {
        discloseNoWorker();
      }
      return;
    }

    failedAt = null;
    blockedReason = null;

    transport = climbed.value;
    activePath = climbed.value.path;
    detail = climbed.detail;
    startedEarly = !spawnAllowed;

    // Both stated to the fresh instance rather than assumed to have survived. A respawned worker is
    // a fresh module that has never heard of either, and a prelude that quietly stops being applied
    // is the kind of failure that reads as a broken note rather than a broken restart.
    transport.updateEnv(effectiveEnv());
    transport.setGeneration(generation);
    up = true;

    if (rejections.length > 0) {
      console.warn(`Symbat: the interpreter started on "${detail}" — ${describeRejections(rejections)}`);
    }

    // Every start, not only one that changed threads. A fresh instance has an empty session table
    // whichever thread it is on, so a REPL holding an id is holding a miss.
    announceInterpreter();
  })();

  return starting;
}

// How the running transport is described in the status line: "blob URL", "data: URL", "in process".
let detail = "not started";

// Where the interpreter ran when it last ran. Held past a teardown, deliberately: a stop that made
// the stop button vanish would be a poor reward for pressing it, and "which path is this device on"
// does not stop being true because nothing is running at this instant.
let activePath: InterpreterPath | null = null;

/**
 * Whether the interpreter is up and safe to ask.
 *
 * A pending restart counts as not ready: `up` is still set until the reset actually runs, so a
 * caller must defer to {@link ensureInterpreter} — which performs it — rather than ask a poisoned
 * instance and wait.
 */
export function interpreterReady(): boolean {
  return up && !restartPending;
}

/**
 * Request that the interpreter be reinitialized before its next use.
 *
 * Deferred rather than immediate: a panic leaves an instance that still answers, so the render
 * already in flight finishes against the one it started on rather than having it swapped out
 * underneath. A transport *fault* is the other case and is torn down at once — see
 * {@link TransportHost.onFault}.
 */
export function restartInterpreter(): void {
  if (restartPending) {
    return;
  }

  restartPending = true;
  noteCrash("task");
}

/**
 * Count a crash, and decide whether carrying on the same way is the correct course of action.
 *
 * Two quite different failures reach here and they need opposite treatments:
 *
 *   * **A personal prelude that crashes the interpreter** fails every task, because it is replayed
 *     into every context. Falling back to the main thread would move the bomb onto the thread with
 *     no way to survive it. So the prelude is suspended and the reader is told, once. This is the
 *     one case that earns a Notice, because nothing else in the plugin can explain why their own
 *     file stopped being loaded.
 *   * **A thread that cannot host the interpreter** fails at construction or at load. That stops
 *     the worker being tried again for the session, and the interpreter stops with it: the reader
 *     is told once and can move to the main thread themselves. Restarting forever is worse than
 *     stopping and saying so, and moving them somewhere weaker unasked is worse than both.
 *
 * `kind` is what keeps the second of those from firing on the first. **A wasm panic inside a task
 * must never latch the thread off**: the latch's question is "can this thread host the
 * interpreter", and a Numbat panic proves nothing about the thread. It still counts toward
 * suspecting the prelude, because a prelude that crashes the interpreter does so during a context
 * build and arrives here as exactly that.
 *
 * Which is why the window remembers each crash's kind rather than merely counting them. One shared
 * tally read two ways is a tally that answers neither question: a panic arriving among a run of
 * transport faults would push the count over the line, and the latch would take the credit for
 * evidence it had not been given.
 */
function noteCrash(kind: "task" | "transport"): void {
  const now = Date.now();
  restartsThisSession += 1;
  crashes = crashes.filter((crash) => now - crash.at < RESPAWN_STORM_WINDOW_MS);
  crashes.push({ at: now, kind });

  if (crashes.length <= RESPAWN_STORM_LIMIT) {
    return;
  }

  // Read before the window is emptied, which it is because this call is about to act on it.
  const transportFaults = crashes.filter((crash) => crash.kind === "transport").length;
  crashes = [];
  if (env.prelude.length > 0 && !preludeSuspended) {
    preludeSuspended = true;
    console.warn("Symbat: the personal prelude keeps crashing the interpreter; it will not be loaded.");
    new Notice(
      "Symbat: your personal prelude keeps crashing the interpreter, so it has been suspended for "
        + "this session. Fix it and reload, or clear it in Settings → Prelude.",
      10_000,
    );
    return;
  }

  // Counted by kind, not by length. A wasm panic inside a task proves nothing about the thread, so
  // a window whose entries are mostly panics is not evidence that the worker cannot be hosted here,
  // and reading the array's length would let three panics and one fault latch it off.
  if (transportFaults > RESPAWN_STORM_LIMIT && activePath === "worker") {
    latched = true;
    rejections = [{
      detail: "worker",
      reason: `stopped after ${transportFaults} failures in ${RESPAWN_STORM_WINDOW_MS / 1000} s`,
    }];
    console.warn("Symbat: the interpreter worker keeps failing; it will not be restarted this session.");
    discloseNoWorker();
  }
}

// Whether the reader has been told, this session, that there is no worker. One flag rather than one
// per route in, because there is only one thing to say.
let disclosedNoWorker = false;

// Why there is no interpreter, when the reason is one the reader can do something about. Read by
// the settings status line and by the REPL, which is where somebody goes to find out why nothing
// is happening.
let blockedReason: string | null = null;

/**
 * Tell the reader, once, that the worker they asked for is not available and nothing is being
 * evaluated.
 *
 * The choice is handed to the reader because the two evaluation engines are not feature-equivalent.
 * The non-worker engine has no real way to stop a runaway evaluation, so the choice is handed back
 * to the user with its costs.
 */
function discloseNoWorker(): void {
  blockedReason = rejections.length > 0 ? describeRejections(rejections) : "the worker did not start";

  if (disclosedNoWorker) {
    return;
  }

  disclosedNoWorker = true;
  new Notice(
    "Symbat could not run Numbat on a worker thread, so nothing is being evaluated.\n\n"
      + "Set “Interpreter thread” to “Main thread” in Settings → Symbat → Runtime to evaluate on "
      + "Obsidian's own thread instead. Everything works there, but an evaluation that will never "
      + "finish cannot be stopped, and the evaluation time limit bounds only what comes after it.",
    0,
  );
}

/**
 * Why nothing is being evaluated, in a sentence a reader can act on, or `null` when that is not the
 * situation.
 *
 * Separate from {@link describeInterpreterPath} because the two have different audiences: that one
 * describes whatever is running, for a bug report, and this one is shown to somebody who is looking
 * at a surface that has gone quiet and needs to know it is not broken.
 */
export function interpreterProblem(): string | null {
  return blockedReason === null
    ? null
    : "Numbat could not start on a worker thread, so nothing is being evaluated. Set Interpreter "
      + "thread to Main thread in Settings → Symbat → Runtime to run it on Obsidian's own thread "
      + `(${blockedReason}).`;
}

/**
 * Put the instance down, settling every outstanding request with `null`.
 *
 * The one place that does it, because there are three reasons to and they must not each grow their
 * own idea of what "down" means: a panic, the reader stopping everything, and unload. What differs
 * between them is only whether a restart follows.
 */
function resetInstance(): void {
  restartPending = false;
  up = false;
  starting = null;

  // A fresh instance means a fresh standard library, so the captured dimension and unit names must
  // be re-enumerated rather than carried over.
  forgetSemanticNames();
  const had = transport !== null;
  transport?.stop();
  transport = null;

  // Announced on the way down as well as on the way up, so a surface can close itself off while
  // there is nothing behind it rather than discovering the gap by being unable to evaluate.
  if (had) {
    announceInterpreter();
  }
}

/** Release everything the interpreter holds, for plugin unload. */
export function disposeInterpreter(): void {
  clearIdleTimer();
  resetInstance();
}

/**
 * Replace the environment a context is built in.
 *
 * A rate change on an instance that has already applied some cannot be done in place as Numbat's
 * rate store is a set-once global whose setter panics on a second call. The answering side thus
 * says so — through {@link TransportHost.onStale}, since the message it answers has no reply — and
 * the instance is replaced. Without this the refresh interval had no in-session effect at all: a
 * session left open for days kept converting at day-one rates while cheerfully re-downloading fresh
 * ones.
 */
export function setInterpreterEnv(next: EngineEnv): void {
  // A prelude the reader has *changed* is not the prelude that was suspended, so it gets another
  // go. A prelude that arrived unchanged alongside a new rates document is the same one, and
  // readmitting it there was a real bug rather than an over-cautious guard: this function is the
  // one door for the whole environment, so an exchange-rate refresh went through it too and
  // un-suspended a prelude that had already been proven to crash the interpreter: quietly, on a
  // timer, with the storm to be earned all over again.
  if (preludeChanged(env.prelude, next.prelude)) {
    preludeSuspended = false;
  }

  env = next;
  transport?.updateEnv(effectiveEnv());
}

/** Whether two prelude lists differ in what they would put into a context: the same comparison
 *  `setUserPrelude` makes before bumping the generation, made again here because this door is
 *  reached by rate changes as well. */
function preludeChanged(before: readonly PreludePart[], after: readonly PreludePart[]): boolean {
  return before.length !== after.length
    || after.some((part, i) => part.path !== before[i].path || part.source !== before[i].source);
}

// WHERE IT ENDED UP
// ================================================================================================

/**
 * One line naming the active path, for the settings tab and for **Copy debug info**.
 *
 * On a phone this is the only diagnostic anybody can hand you, so it says what is running, how it
 * was reached and, when it is not what was asked for, why not.
 */
export function describeInterpreterPath(): string {
  const where = blockedReason !== null
    ? "not running — no worker thread available"
    : activePath === null
    ? "not started"
    : activePath === "worker"
    ? `worker (${detail})`
    : "main thread";

  const notes: string[] = [];
  if (wanted === "main") {
    notes.push("chosen in settings");
  }
  if (rejections.length > 0) {
    notes.push(describeRejections(rejections));
  }
  if (preludeSuspended) {
    notes.push("personal prelude suspended after repeated crashes");
  }
  if (restartsThisSession > 0) {
    notes.push(
      restartsThisSession === 1 ? "1 restart this session" : `${restartsThisSession} restarts this session`,
    );
  }

  return notes.length === 0 ? where : `${where} — ${notes.join("; ")}`;
}

/** Whether an evaluation that has already started can be stopped. False on the in-process path, and
 *  that is the asymmetry the two stop affordances exist to make visible. */
export function interpreterCanBeStopped(): boolean {
  return activePath === "worker";
}

// Surfaces whose own state depends on which interpreter instance is live.
const watchers = new Set<() => void>();

/**
 * Be told whenever the interpreter instance is replaced: started, restarted after a panic,
 * respawned, moved between threads, or put down by the reader.
 *
 * **A surface cannot answer these questions once and keep the answer**, and two quite different
 * ones are involved:
 *
 *   * _Where does it run?_ Not known until something has actually started it, and it legitimately
 *     moves afterwards: a view restored with the workspace opens *before* `onLayoutReady` permits
 *     spawning, so it sees the in-process path and is overtaken by the worker a moment later.
 *     Anything that hides an affordance off the worker path has to hear about that.
 *   * _Is what I am holding still valid?_ A REPL session is an integer in the interpreter's own
 *     table, and a replaced instance has an empty table. Nothing else tells the view that the
 *     session it opened is gone, and a stale id is a miss it would otherwise discover by being
 *     unable to evaluate.
 *
 * One notification rather than two, because every replacement answers both at once and a surface
 * that cared about one and not the other would still have to re-ask.
 *
 * @returns a function that stops the notifications, for the caller's own teardown.
 */
export function watchInterpreter(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

/** Tell the watchers, from a copy so that one unsubscribing in its own callback cannot disturb the
 *  walk, and without letting one that throws stop the rest. */
function announceInterpreter(): void {
  for (const watcher of [...watchers]) {
    try {
      watcher();
    } catch (error) {
      console.error("Symbat: an interpreter watcher failed", error);
    }
  }
}

// ASKING
// ================================================================================================

/** How a request is to be scheduled. Both are advice to the queue, and both have a sensible answer
 *  for a surface that has not thought about it. */
export interface AskOptions {
  /** How soon the answer is wanted. Defaults to `visible` — something on screen that will repaint
   *  when the answer lands, which is what most of the plugin is. */
  readonly priority?: Priority;

  /** What this request is *about*, so that a newer request about the same thing supersedes it. A
   *  surface and a document, conventionally; omitted for genuinely one-off work. */
  readonly group?: string;

  /**
   * The note whose evaluation allowance this request draws on, when there is one.
   *
   * Only {@link stopEvaluations} reads it, and only for the requests still running when the reader
   * gives up on them: those are the notes that will not finish, and filing a refusal against them
   * is what stops the render that was hanging from re-firing the moment the interpreter is back.
   * Every site that passes a `budget` has one and passes the same key.
   */
  readonly note?: string;
}

// Requests posted and not yet answered, and the note each is about where it names one. Read by the
// stop command, which escalates to a terminate only when the cooperative rung was not enough — and
// then files a refusal against whatever was still running.
const inFlight = new Map<number, string | undefined>();
let nextAskId = 1;

/**
 * Put one request to the interpreter and act on everything its answer carries.
 *
 * `null` when there is no answer to be had. Never rejects: a task that throws is a bug in a task,
 * and the surface's recovery is the same as for every other empty answer.
 */
export async function ask<K extends TaskName>(
  name: K,
  request: TaskMap[K]["request"],
  options: AskOptions = {},
): Promise<TaskMap[K]["response"] | null> {
  const active = transport;
  if (!interpreterReady() || active === null) {
    return null;
  }

  const askId = nextAskId;
  nextAskId += 1;
  inFlight.set(askId, options.note);

  let reply;
  try {
    reply = await active.serve(name, request, {
      priority: options.priority ?? "visible",
      group: options.group,
      generation,
    });
  } finally {
    inFlight.delete(askId);
  }

  if (reply === null) {
    return null;
  }

  // Before the fault check, deliberately. A context build that enumerated the standard library and
  // *then* panicked still enumerated it, and the highlighter is no worse off for being told.
  if (reply.names !== null) {
    recordSemanticNames(reply.names.dimensions, reply.names.units);
  }

  if (reply.faulted) {
    restartInterpreter();
  }

  return reply.value;
}

/** Wait `ms`, as a message to another thread and back would. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** {@link pause} as the ladder wants it: cancellable, so a rung that answers does not leave its own
 *  five-second timer running behind the one that follows it. */
function countdown(ms: number): Countdown {
  let timer: number | null = null;
  const expired = new Promise<void>((resolve) => {
    timer = window.setTimeout(() => {
      timer = null;
      resolve();
    }, ms);
  });

  return {
    expired,
    cancel: () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    },
  };
}

// STOPPING
// ================================================================================================

/**
 * Stop what the interpreter is doing, escalating only as far as it has to.
 *
 * Two rungs, because they cost wildly different amounts. Cancelling the queue reaches every request
 * that has not started and keeps the wasm instance, the context pool, the applied rates and any
 * REPL session. Terminating loses all four, and is the only thing that stops a call already inside
 * Numbat.
 *
 * `immediate` skips straight to the terminate, which is the REPL's case: a REPL submission is a
 * *single* `interpret`, so there is no chunk boundary inside it for a cancellation to land on. The
 * button is always the second rung.
 *
 * @returns whether anything was stopped, so the caller can say so.
 */
export async function stopEvaluations(immediate = false): Promise<boolean> {
  const active = transport;
  if (active === null) {
    return false;
  }

  if (!immediate) {
    if (inFlight.size === 0) {
      return false;
    }

    active.cancel(null);
    await pause(STOP_GRACE_MS);
    if (inFlight.size === 0 || transport !== active) {
      return true;
    }
  }

  if (active.path !== "worker") {
    // Everything that could be stopped has been: the queue is empty and what is running cannot be
    // reached from here. Reported as a stop because one happened, even though it was the weaker of
    // the two and unreachable through either affordance anyway, both being hidden off this path.
    return !immediate;
  }

  // Whatever is *still* running is what will not finish, and those notes are the ones that would
  // otherwise re-fire the moment the interpreter is back, leaving the reader stopping the same note
  // over and over. Queued work that the cancel above reached is not filed: it never ran, and there
  // is nothing wrong with it.
  for (const note of new Set(inFlight.values())) {
    if (note !== undefined) {
      rememberStop(note, generation);
    }
  }

  // Deliberately not `restartInterpreter()`: this restart is the reader's instruction being carried
  // out, not a crash, and counting it would move somebody who pressed stop four times onto the path
  // that has no stop button.
  resetInstance();
  return true;
}

// POLICIES THE ANSWERING SIDE CANNOT SEE
// ================================================================================================

// The pending idle-release timer. Held at module scope so any completion resets it and
// `disposeInterpreter` can cancel it.
let idleTimer: number | null = null;

function clearIdleTimer(): void {
  if (idleTimer !== null) {
    window.clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/**
 * Keep the replayed completion contexts warm while they are in active use, and release them after
 * `timeoutMs` with no completion — reclaiming the memory a large replayed context can hold in the
 * background. A non-positive `timeoutMs` disables the release.
 *
 * The timer is here rather than beside the contexts it releases because it is a *policy*, and the
 * clock it is a policy about is the one the reader is looking at. The answering side is told when
 * to let go, not left to guess.
 */
export function touchInterpreterIdle(timeoutMs: number): void {
  clearIdleTimer();
  if (timeoutMs <= 0) {
    return;
  }

  idleTimer = window.setTimeout(() => {
    idleTimer = null;
    transport?.releaseContexts();
  }, timeoutMs);
}

/** Release the replayed completion contexts now — a prelude or rate change, whose contexts would
 *  otherwise hold a stale prelude. */
export function releaseInterpreterContexts(): void {
  transport?.releaseContexts();
}

/**
 * Refill one note's evaluation allowance, or every note's.
 *
 * **Both halves, because the allowance has two.** The spend bucket is where the interpreter is, so
 * it is refilled there; the refusal ledger is here, because the surfaces are. `releaseNote` clears
 * both, which reads as one call while the two sides are one module instance and stops being one the
 * moment they are not: posting it alone reaches an empty ledger over there and leaves the live one
 * here untouched, so a note the reader had just fixed went on saying it had run out of time for the
 * whole cool-down.
 *
 * The near call is a no-op for the bucket and the far one a no-op for the ledger, whichever
 * transport is in force, and both are idempotent. This is, thus, correct in process as well, where
 * it does each thing twice.
 *
 * `null` is the far half only: its one caller (`clearCaches`) clears the ledger itself, and going
 * through {@link import("./budget").clearRefusals} here would also reset the notice throttle, which
 * is a separate promise that command makes on purpose.
 */
export function refillEvaluationBudget(key: string | null): void {
  if (key !== null) {
    forgetRefusal(key);
  }

  transport?.refill(key);
}
