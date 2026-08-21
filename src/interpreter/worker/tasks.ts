// What the interpreter is asked to do.
//
// The boundary is deliberately **coarse**. A note's inlay pass is around a hundred `interpret`
// calls; a per-call proxy would be a hundred round trips per debounce tick per open editor, and
// "this note's pass has been superseded" has no representation in a stream of calls but is trivial
// as a task id. So a task is a whole pass over a whole note, stated as plain data and answered as
// plain data.
//
// Every handler here has the same shape, and the shape is the point:
//
//   1. build whatever contexts the job needs, from the request's own text;
//   2. drive one of the pure evaluation modules with `interpret` as its `run`;
//   3. free every context before returning.
//
// Step 3 is an invariant, not a habit: **no context built here outlives the call that built it**,
// apart from the REPL sessions below and the engine's own replayed-scope cache, both of which are
// keyed and owned instead of being handed out. That is what lets the pool reuse contexts without
// any surface being able to notice.
//
// Obsidian-free by construction — the requests carry text, not documents — which is what lets
// `test/integration` drive these against the real interpreter and compare them with the pure
// modules driven directly.

import type { CompletionVocabulary } from "../../completion/expressions";
import { type Hint, hintsForBlock, holeForm, type LineInterpret, parseHoleType } from "../../evaluation/inlay-parse";
import {
  configError,
  configErrorResult,
  type InlineResult,
  inlineResultFor,
  spanDecimalPlaces,
} from "../../evaluation/inline-parse";
import { type BindingOutcome, evaluateBindings } from "../../properties/outcomes";
import { preambleChunks } from "../../properties/parse";
import { deriveScopeValue, evaluateScopeTree } from "../../scope/eval";
import { TASK_YIELD_ITEMS } from "../../tuning";
import { EVALUATION_LIMIT_RESULT, outOfBudget, withBudget, withBudgetAsync } from "../budget";
import {
  type BlockHints,
  type Budgeted,
  type CompletionsReply,
  type CompletionsRequest,
  type ContextRef,
  describeError,
  type EvalBindingsRequest,
  type EvalBlocksRequest,
  type EvalCodeBlockRequest,
  type EvalDocumentRequest,
  type EvalExprsRequest,
  type EvalNoteUnitsRequest,
  type EvalPropertyRequest,
  type EvalScopeTreeRequest,
  type FactsRequest,
  type HoleRequest,
  type NumbatResult,
  type ReplOutcome,
  type ReplSession,
  type ScopeSnapshot,
  type ScopeSpec,
  type SymbolFacts,
  type TaskMap,
  type TaskName,
  type TaskReply,
  WANT_FIELDS,
  WANT_INFO,
  WANT_SIGNATURE,
  WANT_VALUE,
} from "../protocol";
import { definesNames, readsLastAnswer } from "../reuse";
import { breath, taskWasAborted } from "./cooperative";
import {
  buildVocabulary,
  candidatesFor,
  createContext,
  discardedInstance,
  type EngineContext,
  engineReady,
  faultPending,
  fieldsOf,
  freeQuietly,
  infoFor,
  interpret,
  lastPreludeError,
  noteEngineFault,
  poolStats,
  type PositionedContext,
  positionedContext,
  recycle,
  runCommand,
  scopeContext,
  signatureOf,
  takeFault,
  takeSemanticNames,
} from "./engine";

// THE ONE DOOR
// ================================================================================================

/**
 * Serve one request.
 *
 * Asynchronous from the outset even though every handler below is synchronous today. That is what
 * the caller has to be written against, and a signature that told it otherwise would be a signature
 * it could come to depend on. This is the same argument the facts cache makes about never answering
 * on the asking tick. It is also where the cooperative yield goes once a long task learns to be
 * interruptible.
 */
export async function runTask<K extends TaskName>(
  name: K,
  request: TaskMap[K]["request"],
  shouldAbort: () => boolean = () => false,
): Promise<TaskReply<TaskMap[K]["response"]>> {
  await Promise.resolve();

  if (!engineReady()) {
    return envelope<TaskMap[K]["response"]>(null);
  }

  try {
    // The two casts are the one place the map is opened up. Every handler is checked against its
    // own request and response types below; what cannot be expressed is that the *pairing* of a
    // name with a request holds, which is exactly what `TaskMap` states for every caller.
    return envelope(await dispatch(name, request, shouldAbort) as TaskMap[K]["response"] | null);
  } catch (error) {
    // A task that unwound because it was told to stop is not a fault, and must not be reported as
    // one: treating it as a panic would restart a healthy interpreter every time a reader typed
    // over a pass in flight. It goes back to the queue, which settles it as an ordinary "no
    // answer".
    if (taskWasAborted(error)) {
      throw error;
    }

    // A throw here is a wasm panic escaping something that does not trap it: predominantly
    // `Numbat.new` It becomes a fault on the envelope rather than a rejected promise, because the
    // caller's recovery is the same either way and a rejection is one more thing every call site
    // has to remember.
    noteEngineFault(error, "an interpreter task crashed");
    return envelope<TaskMap[K]["response"]>(null);
  }
}

/** Wrap a handler's answer in everything the asking side has to learn from the call. */
function envelope<T>(value: T | null): TaskReply<T> {
  return {
    value,
    names: takeSemanticNames(),
    faulted: takeFault(),
    preludeError: lastPreludeError(),
  };
}

/**
 * The task table. A `switch` with a `never`-typed default, so a task added to {@link TaskMap}
 * without a handler here is a compile-time error rather than a task that answers `undefined` — a
 * value that passes every caller's `=== null` guard and fails at the use site instead.
 *
 * Some handlers answer with a promise and most do not, which is the honest shape: only a task that
 * loops over items has anywhere to be stopped, and making the rest asynchronous to match would add
 * a turn to every completion and every hover for the sake of a symmetry nobody reads.
 */
function dispatch(name: TaskName, request: unknown, shouldAbort: () => boolean): unknown {
  switch (name) {
    case "evalBlocks":
      return evalBlocks(request as EvalBlocksRequest, shouldAbort);
    case "evalDocument":
      return evalDocument(request as EvalDocumentRequest);
    case "evalNoteUnits":
      return evalNoteUnits(request as EvalNoteUnitsRequest, shouldAbort);
    case "evalExprs":
      return evalExprs(request as EvalExprsRequest, shouldAbort);
    case "evalCodeBlock":
      return evalCodeBlock(request as EvalCodeBlockRequest);
    case "evalBindings":
      return evalBindings(request as EvalBindingsRequest);
    case "evalProperty":
      return evalProperty(request as EvalPropertyRequest);
    case "evalScopeTree":
      return evalScopeTree(request as EvalScopeTreeRequest);
    case "snapshot":
      return snapshot(request as ContextRef);
    case "facts":
      return facts(request as FactsRequest);
    case "holeType":
      return holeType(request as HoleRequest);
    case "completions":
      return completions(request as CompletionsRequest);
    case "replOpen":
      return replOpen(request as { applyRates: boolean; });
    case "replEval":
      return replEval(request as { id: number; input: string; applyRates: boolean; });
    case "replReset":
      return replReset(request as { id: number; applyRates: boolean; });
    case "replClose":
      return replClose(request as { id: number; });
    case "preludeCheck":
      return preludeCheck(request as { text: string; applyRates: boolean; preludeBefore: string; });
    case "warm":
      return warm(request as { applyRates: boolean; });
    case "poolStats":
      return poolStats();
    default: {
      // Unreachable while every name has an arm.
      const unhandled: never = name;
      throw new Error(`Symbat: no handler for interpreter task ${String(unhandled)}`);
    }
  }
}

// BUILDING AND RELEASING
// ================================================================================================

/** `run` over a context, the shape every pure evaluation module takes. */
function runner(context: EngineContext): LineInterpret {
  return (code) => interpret(context, code);
}

/**
 * A `use` callback's return type, with a promise refused.
 *
 * The two synchronous helpers below dispose of their context in a `finally`, which for a `use` that
 * yields runs when it hands back its promise rather than when that promise settles. The context is
 * freed, or offered to the pool, while the walk is still interpreting into it. See
 * {@link withPooledContextAsync}, which exists for that case and describes what the mistake looks
 * like from the far end.
 *
 * A type rather than a comment because the mistake typechecks: `T` is inferred from whatever `use`
 * returns, and `Promise<Hint[]>` is as good a `T` as `Hint[]`. Substituting a string in the
 * callback's return position is what turns it into an error at the call, and the string is the
 * message the reader sees. Every call site is checked by `tsc` on the way into CI, which is the
 * whole of the enforcement: there is nothing here to assert at runtime.
 */
type NoAsync<T> = T extends PromiseLike<unknown> ? "pass this to withPooledContextAsync instead" : T;

/**
 * Build a context, hand it to `use`, and free it however `use` ends. The `finally` is what the
 * invariant rests on: a panic in a replay must not abandon a context to a caller that has no name
 * for it.
 *
 * Still four callers, and each is one the pool cannot help:
 *
 *   - **the property batch**, because `evaluateBindings` writes a `let` per binding, so its context
 *     can never come back unchanged and there is no prefix to split off the front of it;
 *   - **the `.nbt` whole-file pass** and **the prelude check**, whose key carries `preludeBefore`
 *     and so has no other producer, and whose file defines by definition;
 *   - **a property row that is being typed into**, which reaches here only on the branch where
 *     `definesNames` already said yes.
 *
 * The scope inspector is not on the list only because its contract is in the way:
 * `evaluateScopeTree`'s factory takes no argument, so what is about to be replayed into the context
 * is not knowable where the context is made. It builds one per block, so it would be worth the
 * change; it is a change to a pure module's API rather than to this one.
 */
function withContext<T>(
  applyRates: boolean,
  preludeBefore: string | null,
  use: (run: LineInterpret) => NoAsync<T>,
): T {
  const context = createContext(applyRates, preludeBefore === null ? {} : { preludeBefore });
  try {
    // The cast is the price of the guard: `NoAsync<T>` is a deferred conditional, so the compiler
    // cannot see that it is `T` for every `T` a call site can actually reach here.
    return use(runner(context)) as T;
  } finally {
    freeQuietly(context);
  }
}

/** What two requests have to agree on to share a context, which the pool's key is built from.
 *  Shared by the two helpers below, so a synchronous and an asynchronous caller cannot key
 *  differently. */
function poolSpec(applyRates: boolean, preludeBefore: string | null, prefix: readonly string[]): ScopeSpec {
  return preludeBefore === null
    ? { chunks: prefix, applyRates }
    : { chunks: prefix, applyRates, preludeBefore };
}

/**
 * A context positioned at `prefix`, reused when it can be, and offered back when what ran left
 * nothing behind.
 *
 * The difference from {@link withContext} is that the prefix moves out of the caller's callback and
 * into the spec. It has to: on a pool hit the prefix is _already_ in the context, so whether to
 * replay it is not the caller's decision — see {@link import("./engine").positionedContext}, which
 * owns both halves for exactly that reason.
 *
 * The two questions in interpreter/reuse.ts are asked here because this is the one place holding
 * both the text and the handle. `readsLastAnswer` gates the take, since a used context carries
 * `ans` and `_` where a fresh one carries neither; `definesNames` gates the return, since a context
 * that gained a name would hand it to an unrelated block. Either answering `true` means a build,
 * which is what every caller paid before the pool existed.
 *
 * The third gate is not a question about the text at all — see {@link keepOrRecycle}.
 */
function withPooledContext<T>(
  applyRates: boolean,
  preludeBefore: string | null,
  prefix: readonly string[],
  leaves: readonly string[],
  use: (run: LineInterpret) => NoAsync<T>,
): T {
  const spec = poolSpec(applyRates, preludeBefore, prefix);
  const text = leaves.join("\n");
  const taken = positionedContext(spec, readsLastAnswer(text));

  try {
    // As in {@link withContext}: the cast is what {@link NoAsync} costs.
    return use(runner(taken.context)) as T;
  } finally {
    keepOrRecycle(spec, taken, text);
  }
}

/**
 * Dispose of a context a pooled call is done with: back to the pool, or freed.
 *
 * One function rather than the same three lines in both helpers, because the conditions are
 * non-obvious enough that two copies would eventually be two rules. The second is the one that is
 * not about the text: a context whose prefix replay ran out of the note's allowance
 * ({@link import("./engine").PositionedContext}) is not positioned where its key says it is, and
 * recycling it hands the next request (by then a request with a full allowance) a note missing its
 * own preamble and shared blocks, answered as though nothing had gone wrong.
 */
function keepOrRecycle(spec: ScopeSpec, taken: PositionedContext, text: string): void {
  // First, because can rule out both arms. A task told to stop unwinds through here, and one of the
  // things that stops a task is the instance being replaced underneath it, after which the handle
  // names an address in somebody else's heap. See {@link import("./engine").discardedInstance}.
  if (discardedInstance(taken)) {
    return;
  }

  if (!taken.positioned || definesNames(text)) {
    freeQuietly(taken.context);
  } else {
    recycle(spec, taken.context);
  }
}

/**
 * {@link withPooledContext} for a `use` that yields.
 *
 * The synchronous one is **actively wrong** for an asynchronous `use`, in a way that typechecks and
 * mostly appears to work: its `finally` runs when `use` hands back a promise, not when that promise
 * settles, so the context is disposed of while the walk is still interpreting into it.
 *
 * Freeing it there gives a call into a freed handle (a nullptr passed to Rust), which reads
 * downstream as a crash and restarts the engine, at a distance from anything that looks like a
 * cause; offering it back there is worse still, since the next taker gets a context another task is
 * mid-way through. The `await` moves the `finally` to the end of the work.
 */
async function withPooledContextAsync<T>(
  applyRates: boolean,
  preludeBefore: string | null,
  prefix: readonly string[],
  leaves: readonly string[],
  use: (run: LineInterpret) => Promise<T>,
): Promise<T> {
  const spec = poolSpec(applyRates, preludeBefore, prefix);
  const text = leaves.join("\n");
  const taken = positionedContext(spec, readsLastAnswer(text));
  try {
    return await use(runner(taken.context));
  } finally {
    keepOrRecycle(spec, taken, text);
  }
}

/** Arm the note's allowance around `task`. Split out so every evaluating task states the budget the
 *  same way and none of them has to remember that a `null` key means "no bucket". */
function budgeted<T>(spec: { budgetMs: number; key: string | null; }, task: () => T): Budgeted<T> {
  const result = withBudget(spec.budgetMs, task, spec.key === null ? {} : { key: spec.key });
  return { value: result.value, exceeded: result.exceeded };
}

/** {@link budgeted} for a task that yields at its boundaries. Separate rather than a flag, because
 *  the two differ in the one way a caller cannot ignore: what they hand back. */
async function budgetedAsync<T>(
  spec: { budgetMs: number; key: string | null; },
  task: () => Promise<T>,
): Promise<Budgeted<T>> {
  const result = await withBudgetAsync(spec.budgetMs, task, spec.key === null ? {} : { key: spec.key });
  return { value: result.value, exceeded: result.exceeded };
}

// THE EVALUATING TASKS
// ================================================================================================

/**
 * The editor's inlay pass: one context per block, the note preamble replayed into each, and — for a
 * `numbat-shared` block — the shared blocks above it that are replayed for their effects.
 *
 * The head check before each context is the reason a note with two hundred blocks does not cost two
 * hundred standard-library loads once the allowance is gone. A block past the deadline is answered
 * by running it against a runner that refuses everything: it costs nothing, it writes the limit's
 * own sentence on every line rather than leaving an absence to interpret, and it comes back marked
 * `evaluated: false` so the asking side knows never to let it age.
 *
 * A boundary per block, and per block rather than per N of them because a block is a whole
 * standard-library load: this is the longest-running task in the plugin and the one a reader is
 * most likely to want out of.
 */
async function evalBlocks(
  request: EvalBlocksRequest,
  shouldAbort: () => boolean,
): Promise<Budgeted<readonly BlockHints[]>> {
  const chunks = preambleChunks(request.preamble);
  const hints: BlockHints[] = [];

  return budgetedAsync(request.budget, async () => {
    for (const block of request.blocks) {
      await breath(shouldAbort);

      if (outOfBudget()) {
        hints.push({
          id: block.id,
          hints: hintsForBlock(() => EVALUATION_LIMIT_RESULT, [...block.body]),
          evaluated: false,
        });
        continue;
      }

      // A block cut off part-way is returned exactly as it came out: real hints on the statements
      // that ran, and `hintsForBlock`'s ordinary error hint, carrying the limit's own sentence, on
      // every statement after.
      hints.push(withPooledContext(
        request.applyRates,
        null,
        [...chunks, ...block.before],
        block.body,
        (run) => ({ id: block.id, hints: hintsForBlock(run, [...block.body]), evaluated: true }),
      ));
    }

    return hints;
  });
}

/**
 * The `.nbt` editor's whole-file pass. One context serves the document (a `.nbt` file is a single
 * scope) so there is nothing to skip part-way: past the deadline every remaining statement comes
 * back as the ordinary error hint that says so.
 *
 * The arm goes *outside* the build, and the head check inside it, which is how every other
 * evaluating task here is arranged. The refused pass produces exactly the same hints for none of
 * the cost, which is the argument {@link evalCodeBlock} and {@link evalNoteUnits} make about their
 * own builds.
 */
function evalDocument(request: EvalDocumentRequest): Budgeted<readonly Hint[]> {
  const lines = request.text.split("\n");
  return budgeted(request.budget, () => {
    if (outOfBudget()) {
      return hintsForBlock(() => EVALUATION_LIMIT_RESULT, lines);
    }

    return withContext(
      request.applyRates,
      request.preludeBefore,
      (run) => hintsForBlock(run, lines),
    );
  });
}

/**
 * A note's inline expressions, replayed in one context in document order: the preamble first, then
 * the shared blocks for their effects and the inline spans for their values.
 */
async function evalNoteUnits(
  request: EvalNoteUnitsRequest,
  shouldAbort: () => boolean,
): Promise<Budgeted<readonly InlineResult[]>> {
  return budgetedAsync(request.budget, async () => {
    // At the head, before the context. Past the deadline the standard-library load buys nothing:
    // every call it was built for would refuse, and refusing without it produces exactly the same
    // results (an ordinary error per span) for none of the cost.
    if (outOfBudget()) {
      return unitResults(() => EVALUATION_LIMIT_RESULT, request, shouldAbort);
    }

    // The asynchronous helper, not the synchronous one: the walk below yields, and the invariant
    // that no context outlives the call that built it is kept only by a `finally` that waits.
    //
    // A note with no shared blocks keys the same as its own code blocks do so in live preview the
    // inlay pass and this one share an entry rather than each loading the standard library.
    return withPooledContextAsync(
      request.applyRates,
      null,
      preambleChunks(request.preamble),
      request.units.map((unit) => (unit.kind === "shared" ? unit.code : unit.span.expr)),
      (run) => unitResults(run, request, shouldAbort),
    );
  });
}

/** The span-by-span walk, over whichever runner it was handed: a real context, or one that refuses
 *  everything. Shared so that the refused shape cannot drift from the evaluated one. */
async function unitResults(
  run: LineInterpret,
  request: EvalNoteUnitsRequest,
  shouldAbort: () => boolean,
): Promise<InlineResult[]> {
  const results: InlineResult[] = [];
  let since = 0;
  for (const unit of request.units) {
    if (since === 0) {
      await breath(shouldAbort);
    }
    since = (since + 1) % TASK_YIELD_ITEMS;

    if (unit.kind === "shared") {
      run(unit.code);
      continue;
    }

    const badConfig = configError(unit.span.configText);
    if (badConfig !== null) {
      // A malformed `{…}` config surfaces like an evaluation error; the expression still runs for
      // its state effects (a `let` stays visible to the spans below).
      run(unit.span.expr);
      results.push(configErrorResult(badConfig));
      continue;
    }

    results.push(inlineResultFor(run, unit.span.expr, spanDecimalPlaces(unit.span, request.config)));
  }

  return results;
}

/**
 * A sequence of expressions in one fresh context, in order, for the reading-view spans whose
 * surrounding note text could not be recovered — so a later expression still sees an earlier one's
 * definitions, even though the shared blocks between them are unavailable.
 */
async function evalExprs(
  request: EvalExprsRequest,
  shouldAbort: () => boolean,
): Promise<Budgeted<readonly InlineResult[]>> {
  const walk = async (run: LineInterpret): Promise<InlineResult[]> => {
    const results: InlineResult[] = [];
    let since = 0;
    for (const entry of request.entries) {
      if (since === 0) {
        await breath(shouldAbort);
      }
      since = (since + 1) % TASK_YIELD_ITEMS;

      if (entry.error !== null) {
        run(entry.expr); // state effects only; the config error takes precedence
        results.push(configErrorResult(entry.error));
        continue;
      }

      results.push(inlineResultFor(run, entry.expr, entry.dp));
    }

    return results;
  };

  return budgetedAsync(request.budget, async () => {
    if (outOfBudget()) {
      return walk(() => EVALUATION_LIMIT_RESULT);
    }

    return withPooledContextAsync(
      request.applyRates,
      null,
      preambleChunks(request.preamble),
      request.entries.map((entry) => entry.expr),
      walk,
    );
  });
}

/**
 * One rendered code block. `before` is what makes a `numbat-shared` block deterministic: every
 * shared block above it, in document order, replayed into a fresh context so the answer does not
 * depend on the order the reading view happened to render sections in.
 */
function evalCodeBlock(request: EvalCodeBlockRequest): Budgeted<NumbatResult> {
  return budgeted(request.budget, () => {
    // Before the context, not after. Past the deadline that standard-library load buys nothing:
    // every call it was built for would refuse, and the reader would wait for the privilege.
    if (outOfBudget()) {
      return EVALUATION_LIMIT_RESULT;
    }

    return withPooledContext(
      request.applyRates,
      null,
      [...preambleChunks(request.preamble), ...request.before],
      [request.source],
      (run) => run(request.source),
    );
  });
}

/**
 * The note's property batch: every binding from `from` down, in one accumulating context.
 *
 * `refuseWith` answers without an interpreter at all — what a note inside its cool-down gets. It
 * answers rather than declining, because a property widget that is told nothing keeps asking: the
 * resume index would go on being the same one and every render would schedule the pass again.
 */
function evalBindings(request: EvalBindingsRequest): Budgeted<readonly BindingOutcome[]> {
  const refusal = request.refuseWith;
  if (refusal !== null) {
    return { value: evaluateBindings(() => refusal, request.preamble, request.from), exceeded: false };
  }

  // No head check, deliberately: one context serves the whole pass, and past the deadline
  // `evaluateBindings` still runs so that every binding comes back as an ordinary error outcome
  // that the asking side can file. Refusing before the context would file nothing, and the widgets
  // would ask again on every render forever.
  return budgeted(
    request.budget,
    () => withContext(request.applyRates, null, (run) => evaluateBindings(run, request.preamble, request.from)),
  );
}

/**
 * One property row's own text, in the scope of the properties above it.
 *
 * Unbudgeted: this is the row being typed into, one expression, and the batch that would bound it
 * is a different task. It reuses the engine's replayed scope context when evaluating `text` there
 * would leave nothing behind — which turns a keystroke from a standard-library load into a single
 * `interpret`, and is the largest single cost on the typing path. {@link definesNames} is what
 * refuses the rest.
 */
function evalProperty(request: EvalPropertyRequest): InlineResult {
  const chunks = [...request.chunks];

  // Both questions, not just the first. The engine's shared scope context is used the way a pooled
  // one is (a hover filling `WANT_VALUE` evaluates the probe into it) so it carries `ans` and `_`
  // where a fresh context carries neither. `definesNames` alone would let a row reading `ans` be
  // answered with whatever the last lookup left behind. See interpreter/reuse.ts.
  if (!definesNames(request.text) && !readsLastAnswer(request.text)) {
    const built = scopeContext({ chunks, applyRates: request.applyRates });
    if (built !== null) {
      return inlineResultFor(runner(built.context), request.text);
    }
  }

  return withContext(request.applyRates, null, (run) => {
    for (const chunk of chunks) {
      run(chunk);
    }

    return inlineResultFor(run, request.text);
  });
}

/**
 * The scope inspector's value pass, filling every binding in the tree.
 *
 * The tree goes out and comes back rather than a list of values, because `evaluateScope` writes
 * into the entries it walks and the walk is what knows where each value belongs. The head
 * check inside the factory is the one that matters here: the tree builds a context per block and
 * two besides, so past the deadline this would otherwise pay a standard-library load apiece to hand
 * each one to statements that will all refuse.
 */
function evalScopeTree(request: EvalScopeTreeRequest): Budgeted<ScopeTreeValue> {
  const { tree } = request;
  return budgeted(request.budget, () => {
    evaluateScopeTree(() => {
      if (outOfBudget()) {
        return { run: () => EVALUATION_LIMIT_RESULT, free: () => {} };
      }

      // `preludeBefore` (a `.nbt` file being inspected) keeps the file's own declarations from
      // arriving twice — once from the prelude, once from the replay — which a repeated `unit` or
      // `dimension` would reject.
      const context = createContext(
        request.applyRates,
        request.preludeBefore === null ? {} : { preludeBefore: request.preludeBefore },
      );
      return {
        run: runner(context),
        free: () => {
          freeQuietly(context);
        },
      };
    }, tree);

    return tree;
  });
}

/** The tree a scope pass writes into and hands back. Named so the handler's return type reads as
 *  what it is rather than repeating the import. */
type ScopeTreeValue = EvalScopeTreeRequest["tree"];

/**
 * Load a `.nbt` file the way the prelude loader would, and report both halves of the answer: the
 * error the prelude files _ahead_ of it left behind, and what this file itself does.
 *
 * The context is built with `preludeBefore` set to the file's own path, so its declarations are not
 * defined twice — once from the prelude, once from the text — which a repeated `unit` would reject.
 * The earlier error is read before the file runs, because it belongs to the build.
 */
function preludeCheck(
  request: { text: string; applyRates: boolean; preludeBefore: string; },
): { earlier: string | null; result: NumbatResult; } {
  return withContext(request.applyRates, request.preludeBefore, (run) => ({
    earlier: lastPreludeError(),
    result: run(request.text),
  }));
}

/**
 * Build a prelude context and free it again.
 *
 * Its answer is `true` and nobody reads it: what the caller wanted is on the envelope. Only for the
 * case where no context exists yet and none is about to — a `numbat` block viewed in pure source
 * mode — because a render, a completion or a REPL enumerates the names on the way past.
 */
function warm(request: { applyRates: boolean; }): true {
  freeQuietly(createContext(request.applyRates));
  return true;
}

// POINT QUERIES
// ================================================================================================

/**
 * The context a point query is to be answered from: one built from a scope spec (and cached by the
 * engine, so a reader moving down a block reuses it), or a REPL session.
 *
 * `null` is a real answer, not an error: the scope would not build, or the session is gone because
 * the interpreter was replaced underneath it. Both leave the asking side to try again against
 * whatever exists now, which is exactly what a stale handle could never do.
 *
 * A scope's vocabulary comes back with it, because building the scope enumerated it anyway; a
 * session's is `null` and is built on demand, since a REPL evaluates far more often than it
 * completes.
 */
function resolve(ref: ContextRef): { context: EngineContext; vocab: CompletionVocabulary | null; } | null {
  if (ref.kind === "session") {
    const session = sessions.get(ref.id);
    return session === undefined ? null : { context: session, vocab: sessionVocabs.get(ref.id) ?? null };
  }

  const built = scopeContext(ref.spec);
  return built === null ? null : { context: built.context, vocab: built.vocab };
}

/** Everything about a scope that can be enumerated in one pass. */
function snapshot(ref: ContextRef): ScopeSnapshot | null {
  const resolved = resolve(ref);
  if (resolved === null) {
    return null;
  }

  const vocab = resolved.vocab ?? buildVocabulary(resolved.context);
  if (vocab === null) {
    return null;
  }

  // Kept, as `completions` keeps it, and for the same reason: a scope's vocabulary is cached with
  // the context the engine built it from, but a session has no key to build from, so whoever builds
  // one files it. Four `list` commands otherwise, per snapshot, for an answer already in hand.
  rememberSessionVocab(ref, vocab);
  return { vocab, preludeError: lastPreludeError() };
}

/**
 * Fill the facts `want` asks for about each probe.
 *
 * **This is the function the whole facts layer was built around.** A fact the mask leaves out is
 * not asked about at all, which is what keeps a completer's hundred rows from each running an
 * evaluation: `WANT_VALUE` is an `interpret` per name, and a row wants only its signature.
 *
 * Within one mask everything is filled eagerly, where a card asks for one or two depending on what
 * the first answer says. That is the right way round once asking costs a round trip: the
 * alternative is a second exchange to fetch what the first answer turned out to need.
 */
function facts(request: FactsRequest): ReadonlyMap<string, SymbolFacts> | null {
  const resolved = resolve(request.ref);
  if (resolved === null) {
    return null;
  }

  const { context } = resolved;
  const { want } = request;
  const filled = new Map<string, SymbolFacts>();
  for (const probe of request.probes) {
    filled.set(probe, {
      signature: (want & WANT_SIGNATURE) === 0 ? null : signatureOf(context, probe),
      info: (want & WANT_INFO) === 0 ? null : infoFor(context, probe),
      valueHtml: (want & WANT_VALUE) === 0 ? null : valueOf(context, probe),
      fields: (want & WANT_FIELDS) === 0 ? null : fieldsOf(context, probe),
    });
  }

  return filled;
}

/** What a probe evaluates to, as HTML, or `null` when it has no value to show. */
function valueOf(context: EngineContext, probe: string): string | null {
  const derived = deriveScopeValue(runner(context), probe);
  return derived.kind === "value" ? derived.valueHtml : null;
}

/**
 * The type of the operand `input` is still waiting for, recovered by evaluating its typed-hole
 * form.
 *
 * Safe to run against a context others are using, and that is the whole trick: a hole form is a
 * type error _before_ execution, so it never defines anything and never mutates the scope. The
 * replayed scope context and a live REPL session both take it.
 */
function holeType(request: HoleRequest): { type: string | null; } | null {
  const resolved = resolve(request.ref);
  if (resolved === null) {
    return null;
  }

  const hole = holeForm(request.input);
  return { type: hole === null ? null : parseHoleType(interpret(resolved.context, hole).output) };
}

/** The completion candidates for a query, or the fields of a struct for a member completion. */
function completions(request: CompletionsRequest): CompletionsReply | null {
  const resolved = resolve(request.ref);
  if (resolved === null) {
    return null;
  }

  const { context } = resolved;
  const vocab = resolved.vocab ?? buildVocabulary(context);
  if (vocab !== null) {
    rememberSessionVocab(request.ref, vocab);
  }

  // The fields come back beside the names rather than instead of them: a base that turns out not to
  // be a struct falls through to ordinary completion, and discovering that on the far side of a
  // round trip would cost a second one on the typing path.
  return {
    candidates: candidatesFor(context, request.query),
    vocab,
    fields: request.memberBase === undefined ? null : fieldsOf(context, request.memberBase),
  };
}

// THE REPL SESSIONS
// ================================================================================================
//
// The one place a context outlives the call that built it, and the reason the protocol names a
// session by an integer rather than by anything the asking side could dereference. A view holding
// an id that no longer exists gets `null` and rebuilds; a view holding a pointer to a freed heap
// would get a "null pointer passed to Rust" that the layer above reads as a crash.

const sessions = new Map<number, EngineContext>();
let nextSessionId = 1;

// A session's vocabulary, kept until the session evaluates anything. A scope's is cached with the
// context the engine built it from, but a session has no key to build from, so the cache is here —
// and it is dropped on every submission, because a `let`, a `unit` or a `fn` changes what
// completes. Without it a completion keystroke would run four `list` commands.
const sessionVocabs = new Map<number, CompletionVocabulary>();

/** File a vocabulary against `ref` when `ref` is a session, and do nothing when it is a scope,
 *  whose vocabulary the engine caches with the context it built. One function so that every builder
 *  of one keeps it, rather than whichever of them happened to remember. */
function rememberSessionVocab(ref: ContextRef, vocab: CompletionVocabulary): void {
  if (ref.kind === "session") {
    sessionVocabs.set(ref.id, vocab);
  }
}

/** Discard every session. Called when the instance underneath them is being replaced, which is the
 *  only thing that can invalidate one. */
export function closeAllSessions(): void {
  for (const context of sessions.values()) {
    freeQuietly(context);
  }
  sessions.clear();
  sessionVocabs.clear();
}

function replOpen(request: { applyRates: boolean; }): ReplSession {
  const id = nextSessionId;
  nextSessionId += 1;
  sessions.set(id, createContext(request.applyRates));
  return { id, preludeError: lastPreludeError() };
}

function replReset(request: { id: number; applyRates: boolean; }): ReplSession | null {
  const existing = sessions.get(request.id);
  if (existing === undefined) {
    return null;
  }

  // Built before the old one is freed. `createContext` can panic — that is what `runTask`'s outer
  // catch is for — and freeing first would leave the table pointing at a handle nothing can call.
  const fresh = createContext(request.applyRates);
  freeQuietly(existing);
  sessions.set(request.id, fresh);
  sessionVocabs.delete(request.id);
  return { id: request.id, preludeError: lastPreludeError() };
}

function replClose(request: { id: number; }): true {
  freeQuietly(sessions.get(request.id));
  sessions.delete(request.id);
  sessionVocabs.delete(request.id);
  return true;
}

/**
 * Evaluate one submitted line against a session.
 *
 * The `crashed` arm is what the seam made necessary and possible. `repl.ts` used to bypass the
 * shared `interpret` deliberately, because the _throw_ was what told it to rebuild its context;
 * across a boundary a panic is always a message. So the panic is detected here — the engine records
 * a fault rather than throwing — and named, instead of being reported as an ordinary error line
 * while the view goes on typing into a dead session.
 */
function replEval(request: { id: number; input: string; applyRates: boolean; }): ReplOutcome | null {
  const context = sessions.get(request.id);
  if (context === undefined) {
    return null;
  }

  // Whatever this line turns out to be, it may define a name — so the vocabulary is retired before
  // it runs rather than after, and a completion racing it cannot be answered from the old one.
  sessionVocabs.delete(request.id);

  // Commands (`list`, `clear`, `reset`, …) are tried first.
  const command = runCommand(context, request.input);
  if (command === null) {
    return crashed(request.id);
  }

  if (command.isCommand) {
    let preludeError: string | null = null;
    if (command.shouldReset) {
      // As in `replReset`: build, then free, then swap. A panic in the build must not leave the
      // session table naming a freed context.
      const fresh = createContext(request.applyRates);
      freeQuietly(context);
      sessions.set(request.id, fresh);
      preludeError = lastPreludeError();
    }

    return {
      kind: "command",
      output: command.output,
      shouldClear: command.shouldClear,
      shouldReset: command.shouldReset,
      preludeError,
    };
  }

  const result = interpret(context, request.input);
  return faultPending()
    ? crashed(request.id)
    : { kind: "value", output: result.output, isError: result.isError };
}

/**
 * The outcome of a panic, read off the fault the engine recorded.
 *
 * The session is dropped here rather than left to the asking side. The restart the fault triggers
 * gets round to it (`stop()` closes every session), but not before the reader can submit another
 * line. The id would still be in the table, naming a context that has been poisoned by the panic.
 * Forgetting it here makes the next submission a clean miss, which is a state this view already
 * knows how to be in.
 *
 * Not freed, only forgotten: after a panic the handle cannot be freed either, and the reset that
 * follows discards the heap it lives in.
 */
function crashed(id: number): ReplOutcome {
  sessions.delete(id);
  sessionVocabs.delete(id);
  return { kind: "crashed", message: describeError(new Error("the interpreter crashed")) };
}
