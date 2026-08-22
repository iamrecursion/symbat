// The interpreter itself: the one module that imports the generated Numbat bindings, and therefore
// the one module that can only run where the wasm can.
//
// Everything above it (the tasks, the queue, the surfaces) names a scope rather than holding a
// context, so this is the only place a `Numbat` handle exists at all. This is why this file can be
// lifted onto another thread without anything above it changing.
//
// Three things it deliberately does _not_ do, each of which it used to:
//
//   * **It does not restart itself.** A panic sets {@link takeFault}; the side that owns the
//     instance decides what to do about it. A worker cannot terminate a worker.
//   * **It does not reach into main-thread state.** The dimension and unit names a context build
//     enumerates are _returned_ (see {@link takeSemanticNames}), not pushed into the highlighter.
//   * **It does not own a timer.** There is no `window` here. Releasing the completion contexts
//     after an idle period is a policy, and policies belong to whoever can see a clock the reader
//     is looking at.
//
// It imports no Obsidian and no DOM, so `test/integration` can drive it against the real
// interpreter — which is exactly what the seam's differential tests need.

import { completionCard, type CompletionInfo, signatureFromTypeOutput } from "../../completion/docs";
import {
  type CompletionVocabulary,
  parseListNames,
  pluginTypeCandidates,
  structFieldNames,
} from "../../completion/expressions";
import { plainText } from "../../evaluation/inlay-parse";
import { type PreludePart, preludeSourceBefore } from "../../settings/util";
import { PRISTINE_POOL_ENTRIES } from "../../tuning";
import init, { __numbat_reset, FormatType, initSync, Numbat, setup_panic_hook } from "../../wasm/pkg/numbat_wasm.js";
import { EVALUATION_LIMIT_RESULT, outOfBudget } from "../budget";
import { escapeHtml } from "../markup";
import { NULLABLE_PRELUDE } from "../nullable";
import { readableNullables } from "../nullable-display";
import {
  describeError,
  type EngineEnv,
  type NumbatResult,
  type PoolCounts,
  scopeKey,
  type ScopeSpec,
  type SemanticNames,
} from "../protocol";

/**
 * A live interpreter context.
 *
 * An alias rather than the class, so that nothing above this module names `Numbat` — the type is
 * carried around inside the engine and the task layer, and never appears in a request, a response,
 * or a surface. Calling a method on one from outside this file would be the one mistake the whole
 * seam exists to make impossible.
 */
export type EngineContext = Numbat;

export { FormatType };

// WHETHER THE ENGINE IS UP, AND WHETHER IT BROKE
// ================================================================================================

// A synchronous mirror of the wasm module having been instantiated. Cleared by `resetEngine`.
let ready = false;

// Which instance is the current one, bumped by every reset.
//
// A `Numbat` handle is a pointer into the wasm module's linear memory, and a reset replaces that
// memory while leaving the JavaScript wrapper looking exactly as it did. Calling into a handle from
// an earlier instance is thus a wild pointer read *in the current one*, observed as
// `RuntimeError: memory access out of bounds`, though nothing promises a trap rather than a silent
// read, and `free` on the same pointer is the write-shaped version of it.
//
// Everything holding a handle when the reset happens is dropped by `resetEngine` itself, with one
// exception it cannot reach: a task suspended at a cooperative boundary (worker/cooperative.ts).
// That task resumes *after* the reset, unwinds, and offers its context back from a `finally`, into
// the pool the reset has just emptied, under a key the next instance will look up. Hence a number
// rather than a `ready` flag: by the time the task resumes, the replacement instance may already
// have set `ready` back to `true`. See {@link discardedInstance}.
let instance = 0;

// Set when a wasm call throws — a Rust panic. Read (and cleared) by whoever owns the instance,
// which in this module's world is always somebody else: a worker cannot restart a worker, and the
// in-process fallback's restart is the host's to schedule.
let fault = false;

/** Whether the wasm module is instantiated and safe to call. */
export function engineReady(): boolean {
  return ready;
}

/** Note that a wasm call panicked. Every call site that used to say `restartNumbat()` says this
 *  instead: the difference is that this one cannot act on it. */
function noteFault(error: unknown, what: string): void {
  fault = true;
  console.error(`Symbat: ${what}`, error);
}

/** Whether a panic has been absorbed since this was last asked, clearing the flag. Carried out on
 *  the reply envelope, so the owning side learns about it with the answer rather than by
 *  polling. */
export function takeFault(): boolean {
  const faulted = fault;
  fault = false;
  return faulted;
}

/** Whether a panic has been absorbed and not yet drained, _without_ draining it.
 *
 * One caller: a REPL submission has to know that the call it just made was the one that panicked,
 * and it must not swallow the flag on the way — the reply envelope still owes the owning side a
 * restart. Read after a call whose fault, if any, can only be that call's. */
export function faultPending(): boolean {
  return fault;
}

/** Record a panic that escaped something which does not trap one — `Numbat.new` above all. The task
 *  layer's outermost catch, expressed here so that the flag has exactly one writer. */
export function noteEngineFault(error: unknown, what: string): void {
  noteFault(error, what);
}

/**
 * Instantiate the wasm module from `bytes`.
 *
 * `sync` chooses `initSync`, which calls `new WebAssembly.Module(bytes)` — the _synchronous_
 * compiler, which V8 refuses on a document's main thread above 4 KB. It is permitted in a worker
 * and is the right choice there; the in-process path must keep the asynchronous form. Getting this
 * backwards produces a plugin that throws on load for everyone, so the choice is a parameter rather
 * than a guess this module makes about where it is running.
 */
export async function initEngine(base64: string, sync = false): Promise<void> {
  const bytes = decode(base64);
  if (sync) {
    initSync({ module: bytes });
  } else {
    await init({ module_or_path: bytes });
  }

  setup_panic_hook();
  ready = true;
}

/**
 * Decode the inlined module into the bytes an instantiation starts from.
 *
 * Deliberately not memoized, and deliberately local. `WebAssembly.instantiate` copies what it
 * needs, so holding the 1.9 MB array afterwards would keep a compiled-and-discarded buffer alive
 * for the session to save a decode that happens at most twice — at first use, and if a panic forces
 * a reinitialization.
 */
function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

/**
 * Discard everything this instance held and reset the wasm module, so the next {@link initEngine}
 * starts from a clean one.
 *
 * The contexts are dropped rather than freed: after a panic they are "borrowed" and cannot be
 * freed, and the reset discards the heap they live in anyway.
 */
export function resetEngine(): void {
  ready = false;
  instance += 1;
  fault = false;
  ratesApplied = false;
  preludeSemanticsCaptured = false;
  pendingNames = null;
  expressionContext = null;
  expressionVocab = null;
  blockContext = null;
  blockVocab = null;
  blockCacheKey = null;
  pool.clear();

  // Zeroed with the instance they describe. `poolStats` says "since the interpreter came up", and a
  // report that silently spanned every instance of the session would be answering a different
  // question from the one the debug line asks.
  counts.hits = 0;
  counts.misses = 0;
  counts.refused = 0;
  counts.recycled = 0;
  counts.freed = 0;

  try {
    __numbat_reset();
  } catch (error) {
    console.error("Symbat: could not reset the wasm module", error);
  }
}

/**
 * Free a wasm object, ignoring errors. After a panic the object is left "borrowed" and cannot be
 * freed; the subsequent reset discards it anyway.
 */
export function freeQuietly(value: { free: () => void; } | null | undefined): void {
  try {
    value?.free();
  } catch {
    // Object poisoned by a panic — nothing to do.
  }
}

// THE ENVIRONMENT
// ================================================================================================

// The ECB rates XML, as the owning side last posted it. Numbat parses it directly.
let ratesXml: string | null = null;

// Numbat stores exchange rates in a per-instance `OnceLock` whose setter unwraps the `Err`, so
// `set_exchange_rates` panics if called twice on one instance. Applied once; later contexts merely
// `use units::currencies`.
let ratesApplied = false;

// The personal prelude, one entry per configured `.nbt` file in load order, replayed into every new
// context. Kept per file rather than pre-joined so a context can be built with only the files
// loaded *before* a given one — which is what the file itself sees when the prelude loads.
let preludeParts: readonly PreludePart[] = [];

// The HTML-formatted error from the most recent context's prelude application, or `null`. Read by
// the task layer immediately after a build and put on the reply, because that ordering is the one
// thing about it that does not survive a boundary.
let preludeError: string | null = null;

/**
 * Replace what a context is built in.
 *
 * **Changed rates require a fresh instance**, not just a fresh env: the `OnceLock` means this
 * instance can never be told a second time. The owning side is the one that knows how to get a
 * fresh instance, so this reports whether one is needed rather than trying to arrange it.
 *
 * @returns whether the rates changed on an instance that had already applied some, in which case
 * the caller must reset and reinitialize before the new ones take effect.
 */
export function setEngineEnv(env: EngineEnv): boolean {
  preludeParts = env.prelude;
  releaseCompletionContexts();

  if (env.ratesXml === ratesXml) {
    return false;
  }

  ratesXml = env.ratesXml;
  return ratesApplied;
}

/** The user prelude error from the most recent context build, or `null`. */
export function lastPreludeError(): string | null {
  return preludeError;
}

// BUILDING A CONTEXT
// ================================================================================================

/**
 * Replay the user prelude into a fresh context, recording any error. A parse or evaluation error is
 * captured in `preludeError` (and logged); a wasm panic is noted as a fault.
 */
function applyUserPrelude(context: Numbat, source: string): void {
  try {
    const result = context.interpret(source);

    if (result.is_error) {
      preludeError = result.output;
      console.error("Symbat: user prelude failed to load:\n" + result.output.replace(/<[^>]+>/g, ""));
    }
    result.free();
  } catch (error) {
    preludeError = escapeHtml(`User prelude crashed the interpreter: ${describeError(error)}`);
    noteFault(error, "user prelude crashed the interpreter");
  }
}

/**
 * Apply the nullable vocabulary (see interpreter/nullable.ts) to a fresh context.
 *
 * Unlike the user prelude, a failure here is a plugin bug rather than something the reader wrote,
 * so it is logged and never routed to {@link lastPreludeError} — which the REPL and the `.nbt`
 * editor show as _the user's_ prelude error.
 */
function applyNullablePrelude(context: Numbat): void {
  try {
    const result = context.interpret(NULLABLE_PRELUDE);
    if (result.is_error) {
      console.error("Symbat: the nullable vocabulary failed to load:\n" + result.output.replace(/<[^>]+>/g, ""));
    }
    result.free();
  } catch (error) {
    noteFault(error, "the nullable vocabulary crashed the interpreter");
  }
}

/**
 * Create a fresh interpreter context with the prelude loaded, rendering to HTML.
 *
 * Every context gets the nullable vocabulary (see interpreter/nullable.ts) first, so the bindings
 * an undefined frontmatter property emits type, and `get_or` and friends are callable everywhere.
 *
 * When `applyRates` is set and rates are available, they are made usable for currency conversions.
 * Because Numbat's rate store is a set-once global, the rates are applied via `set_exchange_rates`
 * only on the first context of an instance; later contexts merely `use units::currencies`.
 *
 * `options.preludeBefore` names a prelude file whose own scope is wanted: only the prelude files
 * ahead of it apply, so evaluating that file's contents does not define everything in it a second
 * time (a repeated `unit` or `dimension` is an error).
 */
export function createContext(applyRates: boolean, options: { preludeBefore?: string; } = {}): EngineContext {
  const context = Numbat.new(true, true, FormatType.Html);
  preludeError = null;

  // Before both of the below: a user prelude that defines its own `get` should *shadow* ours
  // (Numbat lets a later `fn` replace an earlier one), not be replaced by it.
  applyNullablePrelude(context);

  if (applyRates && ratesXml !== null) {
    try {
      if (ratesApplied) {
        context.interpret("use units::currencies").free();
      } else {
        context.set_exchange_rates(ratesXml);
        ratesApplied = true;
      }
    } catch (error) {
      noteFault(error, "applying exchange rates failed");
    }
  }

  // The prelude is applied after exchange rates so it may reference currencies.
  const prelude = preludeSourceBefore(preludeParts, options.preludeBefore);
  if (prelude !== null) {
    applyUserPrelude(context, prelude);
  }

  captureSemanticNames(context);
  return context;
}

// RUNNING CODE
// ================================================================================================

/** The struct types a nested frontmatter property generates (properties/parse.ts's
 *  `_Nb_<Label>_<hash>_<generation>_<index>`). Numbat prints the type name in front of every struct
 *  value, so `costs` would otherwise show as `_Nb_CostsStruct_1uy683r_4_1 { materials: 500 € }`. */
const GENERATED_STRUCT = /_Nb_([\p{L}\p{N}]+)_[0-9a-z]+_\d+_\d+/gu;

/**
 * Rewrite generated struct names to the readable label they carry, so a value reads `CostsStruct {
 * materials: 500 € }` and its type reads `CostsStruct<Money, Money>` — the generation counter and
 * the note-scoped hash that keep the definitions distinct are an implementation detail.
 */
function readableStructNames(output: string): string {
  return output.includes("_Nb_") ? output.replace(GENERATED_STRUCT, "$1") : output;
}

/**
 * Every rewrite formatter output gets before the reader sees it: readable struct names, then
 * nullable values (`Opt { value: [] }` → `nil`, `Opt { value: [70] }` → `70`). The one door for
 * anything that reaches the DOM.
 */
export function readableOutput(output: string): string {
  return readableNullables(readableStructNames(output));
}

/**
 * Run `code` in `context` and return its rendered result. The single funnel every evaluation goes
 * through, so all of them get the same three guarantees: the wasm-side result object is freed
 * rather than leaked, generated struct names are made readable, and a Rust panic becomes an error
 * result plus a recorded fault instead of an exception thrown into a render pass.
 *
 * A panic leaves `context` unusable so the caller should stop using it, as no reset will free it
 * for them.
 *
 * It is also where the evaluation limit is enforced, for the same reason: being the one door, it is
 * the only place a check reaches every evaluating surface at once.
 */
export function interpret(context: EngineContext, code: string): NumbatResult {
  // Before the wasm, not after. The point of the limit is the call that is *not* made: a call that
  // has started cannot be stopped, since Numbat has no fuel counter and no interrupt hook.
  //
  // Free on every path that never armed a budget (completion, hover, the REPL) as `outOfBudget`
  // answers `false` without reading a clock when nothing is armed.
  if (outOfBudget()) {
    return EVALUATION_LIMIT_RESULT;
  }

  try {
    const output = context.interpret(code);
    const result: NumbatResult = { output: readableOutput(output.output), isError: output.is_error };
    output.free();
    return result;
  } catch (error) {
    noteFault(error, "an evaluation crashed the interpreter");
    return { output: escapeHtml(`Numbat crashed and will restart: ${describeError(error)}`), isError: true };
  }
}

/** What a REPL line turned out to be when tried as a command. `output` has already been through
 *  {@link readableOutput}; `null` means the call panicked. */
export interface CommandOutcome {
  readonly isCommand: boolean;
  readonly output: string;
  readonly shouldClear: boolean;
  readonly shouldReset: boolean;
}

/**
 * Try `input` as a REPL command (`list`, `clear`, `reset`, …).
 *
 * `try_run_command` bypasses {@link interpret}, so it applies the same output rewrite here: `info
 * costs` on a nested property would otherwise show the raw generated type name.
 */
export function runCommand(context: EngineContext, input: string): CommandOutcome | null {
  try {
    const command = context.try_run_command(input);
    const outcome: CommandOutcome = {
      isCommand: command.is_command,
      output: readableOutput(command.output),
      shouldClear: command.should_clear,
      shouldReset: command.should_reset,
    };
    command.free();
    return outcome;
  } catch (error) {
    noteFault(error, "a REPL command crashed the interpreter");
    return null;
  }
}

// SEMANTIC NAMES
// ================================================================================================

// Whether the standard-library / prelude dimension and unit names have been enumerated for this
// instance, and the ones waiting to be carried out on a reply.
let preludeSemanticsCaptured = false;
let pendingNames: SemanticNames | null = null;

/** Run a `list <what>` command and return the names it lists (freeing the wasm result). Functions
 *  and variables share a CSS class, so they are read from separate commands rather than
 *  distinguished by class. */
function listNames(context: Numbat, what: "functions" | "units" | "variables" | "dimensions"): string[] {
  const command = context.try_run_command(`list ${what}`);
  const output = command.output;
  command.free();
  return parseListNames(output);
}

/**
 * Enumerate the prelude's dimension and unit names from a freshly built context, once per instance.
 *
 * This is the one thing an evaluation learns that somebody else has to be told: the highlighter
 * reads `syntax/type-names.ts` on the main thread and nothing else announces the names. Recorded
 * here and drained by {@link takeSemanticNames} onto the reply.
 */
function captureSemanticNames(context: Numbat): void {
  if (preludeSemanticsCaptured) {
    return;
  }

  try {
    pendingNames = { dimensions: listNames(context, "dimensions"), units: listNames(context, "units") };
    preludeSemanticsCaptured = true;
  } catch (error) {
    console.error("Symbat: could not capture semantic names", error);
  }
}

/** Record names a vocabulary turned up, which may include a note's or a session's own. Merged into
 *  whatever is already pending, since one reply may cover several context builds. */
function offerSemanticNames(dimensions: Iterable<string>, units: Iterable<string>): void {
  pendingNames = {
    dimensions: [...new Set([...(pendingNames?.dimensions ?? []), ...dimensions])],
    units: [...new Set([...(pendingNames?.units ?? []), ...units])],
  };
}

/** The names enumerated since this was last asked, or `null` when there are none. */
export function takeSemanticNames(): SemanticNames | null {
  const names = pendingNames;
  pendingNames = null;
  return names;
}

// THE REPLAYED COMPLETION CONTEXTS
// ================================================================================================

// The shared, prelude-loaded context used for expression completion, and its categorized
// vocabulary.
let expressionContext: Numbat | null = null;
let expressionVocab: CompletionVocabulary | null = null;

// The single-entry cache for a context that also replays the code above the cursor: the context,
// its vocabulary, and the key they were built for.
let blockContext: Numbat | null = null;
let blockVocab: CompletionVocabulary | null = null;
let blockCacheKey: string | null = null;

/**
 * Release every context this module is holding on the reader's behalf — the replayed completion
 * contexts and the pristine pool — so the next lookup rebuilds.
 *
 * Called when the environment changes (a cached context would hold a stale prelude) and by the
 * idle policy, which lives outside this module because there is no clock in here worth reading.
 */
export function releaseCompletionContexts(): void {
  releasePool();
  freeQuietly(expressionContext);
  expressionContext = null;
  expressionVocab = null;
  freeQuietly(blockContext);
  blockContext = null;
  blockVocab = null;
  blockCacheKey = null;
}

/**
 * The context for `spec`: the prelude, plus the code above the cursor replayed on top of it, each
 * chunk interpreted independently so a half-written statement does not wipe the definitions that
 * parsed.
 *
 * Building a prelude context costs the whole standard library, whereas replaying the chunks is
 * cheap, so the result is cached against the spec: typing within a line reuses it, and only moving
 * to a new line rebuilds. An empty spec falls back to the shared prelude-only context.
 *
 * Returns `null` when the wasm is not up or the build failed.
 */
export function scopeContext(spec: ScopeSpec): { context: EngineContext; vocab: CompletionVocabulary; } | null {
  if (!ready) {
    return null;
  }

  const { applyRates, preludeBefore } = spec;
  const nonEmpty = spec.chunks.filter((chunk) => chunk.trim() !== "");
  if (nonEmpty.length === 0 && preludeBefore === undefined) {
    const context = ensureExpressionContext(applyRates);
    const vocab = expressionVocabulary();
    return context !== null && vocab !== null ? { context, vocab } : null;
  }

  // The scope's own key, without the generation: this cache lives and dies with the instance, and
  // the environment that a generation stands for is replaced by `setEngineEnv` releasing it.
  const key = scopeKey({ chunks: nonEmpty, applyRates, preludeBefore }, 0);
  if (blockContext !== null && blockVocab !== null && blockCacheKey === key) {
    return { context: blockContext, vocab: blockVocab };
  }

  freeQuietly(blockContext);
  blockContext = null;
  blockVocab = null;
  blockCacheKey = null;

  try {
    const context = createContext(applyRates, preludeBefore === undefined ? {} : { preludeBefore });
    for (const chunk of nonEmpty) {
      // interpret() absorbs errors (and wasm panics, recording a fault); the definitions from
      // chunks that did parse remain in the context.
      //
      // It absorbs the evaluation limit too, which is why the replay is watched here as it is in
      // `positionedContext`. Nothing armed reaches this function today (the point queries and the
      // property row that use it are all deliberately unbudgeted) but this one *caches* what it
      // builds under a key that promises the whole prefix, so a cut-short replay would not merely
      // give one wrong answer, it would give the same wrong answer until the key moved.
      //
      // Abandoned rather than handed over half-built, because this context is *lent*: every caller
      // may only read it, so there is nobody to free a one-off. `null` is a real answer here ("the
      // scope would not build") that every caller already retries.
      if (outOfBudget()) {
        freeQuietly(context);
        return null;
      }

      interpret(context, chunk);
    }

    const vocab = buildVocabulary(context);
    if (vocab === null) {
      freeQuietly(context);
      return null;
    }

    blockContext = context;
    blockVocab = vocab;
    blockCacheKey = key;
    return { context, vocab };
  } catch (error) {
    noteFault(error, "could not build the replayed completion context");
    return null;
  }
}

/** The shared prelude-only context, created lazily. `null` when the wasm is not up or the build
 *  failed. */
function ensureExpressionContext(applyRates: boolean): Numbat | null {
  if (!ready) {
    return null;
  }

  if (expressionContext === null) {
    try {
      expressionContext = createContext(applyRates);
    } catch (error) {
      noteFault(error, "could not create the expression completion context");
      return null;
    }
  }

  return expressionContext;
}

/** The cached vocabulary for the shared prelude-only context, built on first use. */
function expressionVocabulary(): CompletionVocabulary | null {
  if (expressionContext === null) {
    return null;
  }
  if (expressionVocab === null) {
    expressionVocab = buildVocabulary(expressionContext);
  }
  return expressionVocab;
}

/**
 * Build the categorized completion vocabulary for `context` from its `list` commands — one each for
 * functions, units, variables, and dimensions, so functions and variables (which share a display
 * class) stay distinct. Returns `null` on failure.
 */
export function buildVocabulary(context: EngineContext): CompletionVocabulary | null {
  try {
    const vocab: CompletionVocabulary = {
      functions: new Set(listNames(context, "functions")),
      units: new Set(listNames(context, "units")),
      variables: new Set(listNames(context, "variables")),
      dimensions: new Set(listNames(context, "dimensions")),
    };

    // This context may be a note's or a REPL session's, so its dimensions/units include
    // user-defined ones; they ride out on the reply and reach the highlighter there.
    offerSemanticNames(vocab.dimensions, vocab.units);
    return vocab;
  } catch (error) {
    noteFault(error, "could not build the completion vocabulary");
    releaseCompletionContexts();
    return null;
  }
}

// THE CONTEXT POOL
// ================================================================================================

// Contexts that were used and came back unchanged, kept for the next request positioned at the same
// prefix. Keyed by `scopeKey` over `(applyRates, preludeBefore, prefix)`, one context per key: a
// pass takes, uses and returns before it asks again, so a second entry under one key would only
// ever be built by two tasks interleaving at a yield boundary. That would be a miss and a fresh
// rebuild, not a correctness issue.
//
// This is the largest lever the interpreter has. A note's inlay pass builds one context per block
// because blocks must not see each other's definitions, and a reading view renders one *task* per
// block on top of that; at ~163 ms of standard library each, twenty blocks is three seconds of
// interpreter and two thirds of a ten-second allowance. Most blocks in a calculator note define
// nothing at all, and a context they ran in is, by the argument in interpreter/reuse.ts, good for
// the next one.
//
// What it does **not** do is speculate. Nothing is built ahead of a request, so a context that is
// never claimed is never paid for; the pool only ever recycles work that was already done, which is
// the difference between saving a build and moving one.
const pool = new Map<string, Numbat>();

/** What two requests have to agree on to share a context. Zero rather than a generation: the pool
 *  lives and dies with this instance, and the environment a generation stands for is replaced by
 *  `setEngineEnv` releasing it. The same argument {@link scopeContext} makes about its own key. */
function poolKey(spec: ScopeSpec): string {
  return scopeKey(spec, 0);
}

// What the pool did, for the counters in the settings' debug info and for the one test that can
// show the reuse is live rather than merely safe. A differential test proves a pooled context
// leaks nothing, and would go on proving it if the pool never handed one out at all.
const counts = { hits: 0, misses: 0, refused: 0, recycled: 0, freed: 0 };

/** What the pool has done since the instance came up. `hits`, `misses` and `refused` partition the
 *  requests, so the hit rate is a rate over all of them rather than over the ones that got as far
 *  as looking; `recycled` counts contexts offered back and `freed` the ones an eviction or a
 *  release sent to `free` instead. */
export function poolStats(): PoolCounts {
  return { ...counts };
}

/**
 * A context handed over by {@link positionedContext}, and whether it actually holds the prefix it
 * was asked for.
 *
 * The flag exists for one reason: {@link recycle} must not be given a context whose prefix was cut
 * short. The caller cannot work that out for itself as the replay happens in here, and from outside
 * a refused chunk is indistinguishable from a chunk that ran.
 */
export interface PositionedContext {
  readonly context: EngineContext;

  /** Whether every chunk in the spec was replayed. `false` means the evaluation limit ran out
   *  mid-replay, and the context is this call's alone: use it, then free it. */
  readonly positioned: boolean;

  /** The instance this was built in, for {@link discardedInstance}. Carried rather than looked up
   *  when the context is given back, because by then the only true thing left to compare is what
   *  was true when it was taken. */
  readonly instance: number;
}

/**
 * Whether the instance `taken` was built in has since been discarded.
 *
 * A caller holding one of these in a `finally` must ask before doing *anything* with the context —
 * not recycle it, and not free it either. Both are calls into a wasm module that no longer exists
 * at the address the handle names, and the memory at that address now belongs to the instance which
 * replaced it. The handle is simply dropped: the heap it pointed into is gone, so there is nothing
 * left to leak.
 */
export function discardedInstance(taken: PositionedContext): boolean {
  return taken.instance !== instance;
}

/**
 * A context positioned at `spec`: the prelude, `preludeBefore` applied, and `spec.chunks` replayed
 * on top. Taken from the pool when one is waiting there and built when it is not.
 *
 * The replay lives here rather than in the caller so that a pool hit *cannot* re-run a prefix that
 * is already in the context. That mistake is invisible from outside: a doubled `unit` or `struct`
 * errors on the redundant chunk and leaves the answer intact, so no differential test can see it,
 * only the wasted standard-library work. Owning both halves is what makes it unrepresentable.
 *
 * The caller owns what comes back: the pool forgets it entirely rather than lending it, so a task
 * that dies still holds the only reference and frees it in its own `finally`. Lending would mean
 * two owners for a handle whose double-free is a call into a dead heap. Offer it back with
 * {@link recycle}, or free it.
 *
 * The sibling is {@link scopeContext}, which answers the same question for a *shared* context: that
 * one caches and lends, and its callers may only read. This one hands over.
 *
 * `mayNoticeLastResult` is the caller's answer to {@link import("../reuse").readsLastAnswer} over
 * the text about to be run, and refuses the pool outright: a used context carries `ans` and `_`
 * where a fresh one carries neither. The pool is _told_ rather than asking, because the text that
 * would be checked is not in scope by the time a context is wanted, and it is told even when the
 * answer is no, so that one place counts every request and the hit rate means what it says.
 */
export function positionedContext(spec: ScopeSpec, mayNoticeLastResult: boolean): PositionedContext {
  // Built once. The key is a join over the whole prefix, which for an inlay pass is the note's
  // preamble plus every shared block above this one.
  const key = poolKey(spec);
  const pooled = mayNoticeLastResult ? undefined : pool.get(key);
  if (pooled !== undefined) {
    counts.hits += 1;
    pool.delete(key);

    // A pooled context is positioned by construction: nothing goes into the pool that was not, and
    // the guard below is what keeps that true.
    return { context: pooled, positioned: true, instance };
  }

  if (mayNoticeLastResult) {
    counts.refused += 1;
  } else {
    counts.misses += 1;
  }

  const context = createContext(
    spec.applyRates,
    spec.preludeBefore === undefined ? {} : { preludeBefore: spec.preludeBefore },
  );
  for (const chunk of spec.chunks) {
    // `interpret` absorbs errors and records a panic as a fault, so a chunk that does not parse
    // leaves the definitions of the chunks that did — the same contract the replayed completion
    // context is built under.
    //
    // What it also absorbs is the evaluation limit, which is why the replay is watched rather than
    // assumed. The caller head-checks the budget before asking for a context, but the deadline can
    // fall *inside* this loop, and from there every remaining chunk is refused without running. A
    // context that never heard its own prefix is not positioned at `spec`, and offering it to the
    // pool under that key would answer the next request — one whose allowance has since refilled —
    // with a note missing its shared blocks and its preamble. That is a wrong value, not a
    // refusal: it is marked evaluated, it is not marked exceeded, and it caches.
    if (outOfBudget()) {
      return { context, positioned: false, instance };
    }

    interpret(context, chunk);
  }

  return { context, positioned: true, instance };
}

/**
 * Offer a used context back, for the next request at the same prefix.
 *
 * **The caller must have established two things**, and both failures look the same from here: a
 * valid-looking answer with nothing wrong on its face.
 *
 *   * That what it ran left nothing behind — see {@link import("../reuse").definesNames}. A context
 *     that gained a definition would hand that definition to an unrelated block.
 *   * That the context is actually positioned at `spec` — see {@link PositionedContext}. A context
 *     whose prefix replay was cut short by the evaluation limit is missing definitions the key
 *     promises it has, and the next taker is by then a request whose allowance has refilled.
 *
 * A context from an instance that has since been replaced is refused by the caller, before it gets
 * as far as here — see {@link discardedInstance}, and note that the same argument forbids *freeing*
 * it, which is why that guard cannot live in this function.
 *
 * A pending fault refuses outright: after a panic the handle is poisoned, cannot even be freed, and
 * whatever the interpreter's internal state is it is not the one this key names. **That guard is
 * the one thing here no test covers**, and deliberately: the only way to panic the real wasm from
 * this harness is applying exchange rates twice, which finishes the instance for every test after
 * it — see the note at the top of test/integration/interpreter/exchange-rates.test.ts. Without the
 * guard a poisoned context would be handed out until the owning side got round to restarting, and
 * every task that took it would fault in turn.
 */
export function recycle(spec: ScopeSpec, context: EngineContext): void {
  if (faultPending()) {
    return;
  }

  const key = poolKey(spec);
  const existing = pool.get(key);
  if (existing !== undefined && existing !== context) {
    // Two tasks interleaved and both came back. Keep the newcomer, which is the one whose caches
    // are warm, and free the one that was sitting.
    freeQuietly(existing);
  }

  counts.recycled += 1;

  // Deleted before it is set. `Map.set` on a key that is already present keeps its original
  // position, and the eviction below reads insertion order as recency, so re-offering the hottest
  // key would leave it first in line to be evicted.
  pool.delete(key);
  pool.set(key, context);
  while (pool.size > PRISTINE_POOL_ENTRIES) {
    // Insertion order, so the first key is the least recently offered.
    const oldest = pool.keys().next();
    if (oldest.done === true) {
      break;
    }

    counts.freed += 1;
    freeQuietly(pool.get(oldest.value));
    pool.delete(oldest.value);
  }
}

/** Free everything the pool is holding. Called with the replayed completion contexts, since the two
 *  answer the same question about the reader: they have gone away, or what they were reading has
 *  changed underneath them. */
export function releasePool(): void {
  for (const context of pool.values()) {
    counts.freed += 1;
    freeQuietly(context);
  }

  pool.clear();
}

// POINT QUERIES ABOUT ONE NAME
// ================================================================================================

// Per-context cache of `type(<name>)` signatures. Keyed by the context, so a name resolves to the
// right type in each one rather than colliding by name — and it is released with the context: a
// rebuilt context is a fresh object with an empty cache. `null` caches "no signature" (a
// keyword/dimension/type, for which `type(…)` errors) so it is not retried.
const signatureCaches = new WeakMap<Numbat, Map<string, string | null>>();

/**
 * The inline signature for `name` — the HTML from `type(<name>)`, e.g. `forall A: Dim. Fn[(A) ->
 * A]` for a function, `Scalar`/`Length` for a variable/unit — or `null` when it has none (a
 * keyword/dimension/type, or on error).
 */
export function signatureOf(context: EngineContext, name: string): string | null {
  let cache = signatureCaches.get(context);
  if (cache === undefined) {
    cache = new Map();
    signatureCaches.set(context, cache);
  }

  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }

  // `interpret` traps wasm panics and returns an error result; `type(…)` of a
  // keyword/dimension/type is a normal (non-panic) error, yielding no signature.
  const result = interpret(context, `type(${name})`);
  const signature = result.isError ? null : signatureFromTypeOutput(result.output);
  cache.set(name, signature);

  return signature;
}

/**
 * The full documentation for `name` — parsed from `print_info(<name>)` into its body HTML and
 * reference URL — or `null` when there is nothing to show.
 *
 * A **type** falls through to the plugin's own table (completion/expressions.ts): `print_info`
 * answers `Not found` for `List` and `Bool` as readily as for a word it has never heard, so without
 * this a type name is the one thing in the language that hovers to nothing. The interpreter is
 * asked first and kept if it answers, so a reader's own `let List = 5` still describes itself.
 */
export function infoFor(context: EngineContext, name: string): CompletionInfo | null {
  try {
    const raw = context.print_info(name);

    // `print_info` bypasses `interpret`, so it needs the same rewrite: a nested property's docs
    // would otherwise show the raw generated type name.
    return completionCard(typeof raw === "string" ? readableOutput(raw) : null, name);
  } catch (error) {
    noteFault(error, "print_info crashed");
    return null;
  }
}

/** A field name no note or prelude will ever define, so accessing it on a struct reliably produces
 *  the "field does not exist" diagnostic that names the struct's actual fields (see {@link
 *  structFieldNames}). */
const FIELD_PROBE = "_numbat_member_probe";

/**
 * The field names of the struct `base` evaluates to, in declaration order — or an empty list when
 * it is not a struct, does not evaluate, or Numbat has reworded its diagnostic.
 *
 * Numbat exposes no other route: `get_completions_for("costs.")` returns nothing and `print_info`
 * on a struct type is "Not found", but a missing-field error spells the whole struct out.
 */
export function fieldsOf(context: EngineContext, base: string): string[] {
  const result = interpret(context, `${base}.${FIELD_PROBE}`);
  return result.isError ? structFieldNames(plainText(result.output)) : [];
}

/**
 * The completion candidates for `query` from `context`, via the wasm's `get_completions_for` — a
 * flat, prefix-filtered, sorted list mixing keywords, `\code` patterns, variables, functions,
 * dimensions and units. Empty when the wasm is not up.
 *
 * The plugin's own type names are appended, since the engine does not know them. After the engine's
 * own, so a name it offers keeps the position its sorting gave it; a duplicate is dropped
 * downstream.
 */
export function candidatesFor(context: EngineContext, query: string): string[] {
  if (!ready) {
    return [];
  }

  try {
    const engine = context.get_completions_for(query).map((value) => String(value));
    return [...engine, ...pluginTypeCandidates(query)];
  } catch (error) {
    noteFault(error, "expression completion crashed");
    releaseCompletionContexts();
    return [];
  }
}
