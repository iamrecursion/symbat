// What crosses the seam: the plain-data vocabulary shared by the side that asks for an evaluation
// and the side that performs one.
//
// Every type here is structured-clonable and every function here is pure. Nothing in this module
// knows whether the two sides are the same thread and nothing in it may learn, because a shape that
// assumes they are is a given configuration stops working once that assumption no longer holds.
//
// Two rules the file exists to enforce:
//
//   * **No handle appears in any request or response.** A `Numbat` is a pointer into a wasm heap.
//     A request names a _scope_ or a _session_; the answering side decides which context serves it.
//   * **A reply carries everything the asking side has to learn from the call**, rather than
//     leaving it to be read out of module state afterwards. `getLastPreludeError()` used to be read
//     immediately after `createContext`; that ordering does not exist across a boundary, so the
//     reply carries it. So do the dimension and unit names a context build enumerated, without
//     which the highlighter silently stops coloring units.
//
// Imports are `import type` only, so this loads under plain `node --test` and adds nothing to
// either bundle.

import type { CompletionInfo } from "../completion/docs";
import type { CompletionVocabulary } from "../completion/expressions";
import type { Hint } from "../evaluation/inlay-parse";
import type { InlineEvalConfig, InlineResult, NoteUnit } from "../evaluation/inline-parse";
import type { BindingOutcome } from "../properties/outcomes";
import type { NotePreamble } from "../properties/parse";
import type { ScopeTree } from "../scope/model";
import type { PreludePart } from "../settings/util";

// THE OUTCOME OF AN EVALUATION
// ================================================================================================

/** The outcome of one interpreter call. */
export interface NumbatResult {
  /**
   * Numbat's rendered output — HTML when the context formats as HTML, and an error message rather
   * than a value when {@link isError}.
   */
  output: string;

  /** Whether Numbat rejected the input (a parse, type, or runtime error). */
  isError: boolean;
}

/**
 * A one-line description of a caught error, for surfacing to the user.
 *
 * Lives on the protocol because both sides need it and neither may import the other: the answering
 * side turns a panic into a message with it, and the asking side turns a failed spawn into one.
 */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0];
}

// WHAT A LOOKUP IS FOR
// ================================================================================================
//
// A hover card can want three of a name's facts; a completion row wants its signature and nothing
// else. The difference earns a mask rather than a comment, because each fact costs an interpreter
// call, and `valueHtml` costs an _evaluation_. A completer that filled all four for every visible
// row would run a couple of hundred evaluations per keystroke, which is a cost we are not willing
// to pay.
//
// So a lookup says what it is for, an entry records what it was filled with, and one filled for a
// narrow purpose is a **miss** for a wider one. A bitmask rather than four booleans: one integer in
// the request key, one `&` in the hit test, and the combinations below name themselves.

/** `type(N)`: the inline signature on a completion row, and the type line on a card. */
export const WANT_SIGNATURE = 1;

/** `print_info(N)`: the documentation body of a card or a dwell popup. */
export const WANT_INFO = 2;

/** What the name evaluates to. The expensive one — it runs the interpreter over the name. */
export const WANT_VALUE = 4;

/** The name's struct fields, for member completion after a `.`. */
export const WANT_FIELDS = 8;

/** Everything a hover card can need; hover/card.ts decides which of them it actually uses. */
export const WANT_CARD = WANT_SIGNATURE | WANT_INFO | WANT_VALUE;

/**
 * What one point query about one name produced. Plain data throughout: nothing here refers back to
 * the context that answered, so a record outlives it and can be posted across a boundary.
 *
 * A fact a lookup did not ask for is `null`, which is also what "asked, and there is nothing to
 * say" looks like. The record does not distinguish them and does not need to: the mask a lookup was
 * made under is what the cache checks before answering, so nobody is ever handed a `null` standing
 * in for a question that was never put.
 */
export interface SymbolFacts {
  /** The rendered type signature (`type(N)`), or `null` when the name does not type. */
  readonly signature: string | null;

  /** What `print_info(N)` documents, or `null` when it documents nothing. */
  readonly info: CompletionInfo | null;

  /** What the name evaluates to, as HTML, or `null` when it has no value to show. */
  readonly valueHtml: string | null;

  /**
   * The fields of the struct the name evaluates to, in declaration order, or `null` when it is not
   * one. What member completion offers after a `.`.
   */
  readonly fields: readonly string[] | null;
}

// NAMING A SCOPE WITHOUT HOLDING ONE
// ================================================================================================

/**
 * What a scope is built from: the ingredients a replayed completion context takes, kept together so
 * the key and the build cannot disagree about which scope is meant.
 *
 * This is the shape that replaced a handle. A surface used to hold the context it had built and
 * hand it to whatever needed an answer; it now holds this, which is inert data that cannot be freed
 * behind its back and can be posted to somebody else's thread.
 */
export interface ScopeSpec {
  /** The code above the cursor, replayed in order on top of the prelude. */
  readonly chunks: readonly string[];

  /** Whether exchange rates are applied to the context. */
  readonly applyRates: boolean;

  /**
   * The prelude file to stop _before_, for the `.nbt` editor: a prelude file's own scope is what
   * the files ahead of it define, not what it defines itself.
   */
  readonly preludeBefore?: string;
}

/**
 * The key every fact about this scope is filed under: the scope's ingredients, plus the interpreter
 * generation, which is what a prelude edit or a rate refresh moves.
 *
 * A NUL never occurs in a text document, so it separates the parts unambiguously — the same
 * argument the replayed-context cache makes about its own key, and the reason the two can be built
 * from one spec.
 */
export function scopeKey(spec: ScopeSpec, generation: number): string {
  return [
    String(generation),
    spec.applyRates ? "1" : "0",
    spec.preludeBefore ?? "",
    ...spec.chunks,
  ].join("\u0000");
}

/**
 * Which context is to answer a point query: one built from a scope, or a REPL session that has been
 * accumulating definitions.
 *
 * An integer names the session, never a pointer — deliberately, and it is the one design rule the
 * REPL's conversion rests on. The answering side validates it against its own table, so a stale id
 * from a view that outlived a respawn is a miss rather than a call into a freed heap.
 */
export type ContextRef =
  | { readonly kind: "scope"; readonly spec: ScopeSpec; }
  | { readonly kind: "session"; readonly id: number; };

/**
 * Everything about a scope that can be _enumerated_ in one pass, as opposed to asked about one
 * name at a time. What the completing surfaces need, and the reason none of them has to hold a
 * context to complete.
 */
export interface ScopeSnapshot {
  /** The categorized vocabulary: which names are functions, units, variables, dimensions. */
  readonly vocab: CompletionVocabulary;

  /**
   * The user prelude's error for the context this snapshot was taken from, or `null`. Carried
   * rather than read afterwards: the read-immediately-after-`createContext` ordering it used to
   * rely on does not survive a boundary.
   */
  readonly preludeError: string | null;
}

// WHAT A CONTEXT BUILD LEARNED
// ================================================================================================

/**
 * The dimension and unit names a context build enumerated.
 *
 * **This is the one thing that has to reach back out of an evaluation into main-thread state.** The
 * highlighter colors units and dimensions distinctly, and `syntax/type-names.ts` — which it reads
 * — is on the asking side. Nothing else announces the names. Miss it and every unit silently stops
 * being highlighted: no error, no missing feature to report, just prose-colored code. So every
 * reply carries whatever its work turned up, and the asking side records it.
 */
export interface SemanticNames {
  readonly dimensions: readonly string[];
  readonly units: readonly string[];
}

/**
 * The environment a context is built in: what the asking side knows and the answering side cannot
 * find out for itself. Exchange rates in particular are fetched with Obsidian's `requestUrl`,
 * which is main-thread-only, so the XML is posted rather than downloaded.
 */
export interface EngineEnv {
  /** The ECB rates XML, or `null` when rates are unavailable or switched off. */
  readonly ratesXml: string | null;

  /** The personal prelude, in load order. */
  readonly prelude: readonly PreludePart[];
}

// THE BUDGET, ACROSS THE SEAM
// ================================================================================================

/**
 * A note's evaluation allowance, as the asking side states it.
 *
 * The allowance is armed on the _answering_ side, because that is where the interpreter calls it
 * bounds actually happen, and a wall-clock deadline held across a message would charge the note for
 * the time the message spent in a queue. What crosses is the number and the note it is charged to.
 *
 * **Carried by every task that evaluates a note, and by two that deliberately do not.** The seven
 * that carry one are the ones a note evaluates *itself* through (its blocks, its whole-file pass,
 * its inline expressions, its expression list, one code block, its property bindings and its scope
 * tree) and each of those passes the same key, so a note's several surfaces draw on one allowance
 * rather than one each.
 *
 * The two without are stated here rather than left to be inferred from an absent field, since an
 * exemption that has to be noticed is one that gets closed by mistake:
 *
 *   * `replEval`, because pressing Enter at a prompt is the reader saying _run this_. It is the one
 *     surface with a stop button instead (views/repl.ts).
 *   * `evalProperty`, the row being typed into, because it is a point query: a single expression
 *     over a prefix the note's own budgeted passes have already paid for, served from the cached
 *     replayed scope on every keystroke after the first. It reaches
 *     {@link import("./worker/engine").scopeContext}, which watches the deadline anyway: a context
 *     that is *lent* must never be cached half-built, armed or not.
 *
 * Neither exemption is a way around the limit, because neither bounds a single `interpret`: Numbat
 * offers no interruption point inside one, so what an allowance actually bounds is the boundaries
 * *between* statements. A runaway expression is the stop command's problem on either path.
 */
export interface BudgetSpec {
  /**
   * How long the note may spend in the interpreter, in milliseconds. Zero or less is
   * unbudgeted.
   */
  readonly budgetMs: number;

  /**
   * The note path the allowance is keyed on, so a note's several surfaces share one — or `null`
   * for work that belongs to no note.
   */
  readonly key: string | null;
}

/**
 * A task's answer, and whether the allowance refused anything on the way to it. `exceeded` is the
 * difference between work that finished late and work that was cut short, which is what decides
 * whether the asking side may let its cache entry age.
 */
export interface Budgeted<T> {
  readonly value: T;
  readonly exceeded: boolean;
}

// THE REQUESTS
// ================================================================================================

/** One code block to evaluate, and the shared blocks that open its scope. */
export interface BlockRequest {
  /**
   * The cache key the asking side filed this block under, echoed back in the response so the
   * pairing needs no re-derivation and cannot drift.
   */
  readonly id: string;

  /** The block's body lines. */
  readonly body: readonly string[];

  /**
   * The `numbat-shared` blocks above this one, in document order, replayed for their effects.
   * Empty for an independent block.
   */
  readonly before: readonly string[];
}

/** What one block's evaluation produced. */
export interface BlockHints {
  /** The `id` from the request. */
  readonly id: string;

  /** The hints, including the ordinary error hints a refused statement produces. */
  readonly hints: readonly Hint[];

  /**
   * Whether this block was actually evaluated, as opposed to synthesized from a refusal without a
   * context being built. A synthesized answer must never be allowed to age: the note cannot be
   * re-read inside its allowance, so asking again would only spend the allowance again.
   */
  readonly evaluated: boolean;
}

export interface EvalBlocksRequest {
  readonly blocks: readonly BlockRequest[];
  readonly preamble: NotePreamble;
  readonly applyRates: boolean;
  readonly budget: BudgetSpec;
}

export interface EvalDocumentRequest {
  /** The whole `.nbt` file. */
  readonly text: string;
  readonly applyRates: boolean;

  /**
   * The file's own path when it is itself part of the prelude, so its declarations do not arrive
   * twice.
   */
  readonly preludeBefore: string | null;
  readonly budget: BudgetSpec;
}

export interface EvalNoteUnitsRequest {
  readonly units: readonly NoteUnit[];
  readonly applyRates: boolean;
  readonly config: InlineEvalConfig;
  readonly preamble: NotePreamble;
  readonly budget: BudgetSpec;
}

/**
 * One inline expression evaluated on its own, for the reading-view spans whose surrounding note
 * text could not be recovered.
 */
export interface ExprRequest {
  readonly expr: string;
  readonly dp: number | null;
  readonly error: string | null;
}

export interface EvalExprsRequest {
  readonly entries: readonly ExprRequest[];
  readonly applyRates: boolean;
  readonly preamble: NotePreamble;
  readonly budget: BudgetSpec;
}

export interface EvalCodeBlockRequest {
  /** This block's source. */
  readonly source: string;

  /** The `numbat-shared` blocks above it, replayed in order — empty for an independent block. */
  readonly before: readonly string[];
  readonly preamble: NotePreamble;
  readonly applyRates: boolean;
  readonly budget: BudgetSpec;
}

export interface EvalBindingsRequest {
  readonly preamble: NotePreamble;

  /** The binding index to resume from — everything above it is already known. */
  readonly from: number;
  readonly applyRates: boolean;
  readonly budget: BudgetSpec;

  /**
   * Answer every binding with this result, without building a context at all. What a note inside
   * its cool-down gets: the same outcomes, filed under the same keys, for no interpreter.
   *
   * The result rather than a flag, because there are two ways into a cool-down (the note ran out
   * of time, or the reader stopped it) each of which is handled differently. The asking side is the
   * one holding the ledger entry that knows which.
   */
  readonly refuseWith: NumbatResult | null;
}

export interface EvalPropertyRequest {
  /** The bindings replayed before the value: the note's imports, then the properties above it. */
  readonly chunks: readonly string[];

  /** The row's own text. */
  readonly text: string;
  readonly applyRates: boolean;
}

export interface EvalScopeTreeRequest {
  /**
   * The tree to fill. **The answer is the reply's tree, never this one.**
   *
   * The pass writes each value into the entry it belongs to, so it is the one request whose shape
   * invites a caller to read its results off the object it sent. That works on only one transport:
   * a request is structured-cloned on its way to a worker, so what comes back is a different object
   * and the one the caller holds is untouched.
   */
  readonly tree: ScopeTree;
  readonly applyRates: boolean;
  readonly preludeBefore: string | null;
  readonly budget: BudgetSpec;
}

export interface FactsRequest {
  readonly ref: ContextRef;
  readonly probes: readonly string[];

  /** The purpose mask — see {@link WANT_SIGNATURE} and friends. */
  readonly want: number;
}

export interface HoleRequest {
  readonly ref: ContextRef;

  /** The half-written line whose trailing hole is to be typed. */
  readonly input: string;
}

export interface CompletionsRequest {
  readonly ref: ContextRef;

  /** What has been typed so far, which the engine prefix-filters against. */
  readonly query: string;

  /**
   * The struct whose fields are wanted _as well as_ the name list, for a member completion after a
   * `.`.
   *
   * Both come back from one request, deliberately. A base that turns out not to be a struct falls
   * through to ordinary completion, and asking for the names only once that is known would be a
   * second round trip on the typing path — where the extra `get_completions_for` that answers it
   * unasked costs almost nothing.
   */
  readonly memberBase?: string;
}

/**
 * What a completion request produced: the candidate names, the vocabulary that classifies them,
 * and — for a member completion — the struct's fields (empty when the base is not a struct).
 */
export interface CompletionsReply {
  readonly candidates: readonly string[];
  readonly vocab: CompletionVocabulary | null;
  readonly fields: readonly string[] | null;
}

// THE REPL SESSION
// ================================================================================================

/**
 * What a REPL submission turned out to be.
 *
 * The third arm is the one that could not exist before the seam. `repl.ts` bypasses the shared
 * `interpret` deliberately, because the _throw_ is what tells it to rebuild its context — and
 * across a boundary a panic is always a message and never a throw. Without an explicit state for it
 * a panic prints an error line while the REPL goes on typing into a dead session.
 */
export type ReplOutcome =
  | {
    readonly kind: "command";
    readonly output: string;
    readonly shouldClear: boolean;
    readonly shouldReset: boolean;

    /** The prelude error of the context a `reset` command built, when it built one. */
    readonly preludeError: string | null;
  }
  | { readonly kind: "value"; readonly output: string; readonly isError: boolean; }
  | { readonly kind: "crashed"; readonly message: string; };

/** A freshly opened session and whatever its first context build reported. */
export interface ReplSession {
  /** The integer the asking side names this session by from now on. */
  readonly id: number;
  readonly preludeError: string | null;
}

// THE REPLY ENVELOPE
// ================================================================================================

/**
 * Every reply, whatever the task. The envelope carries the three things that used to be read out of
 * module state on the asking side and cannot be any more.
 */
export interface TaskReply<T> {
  /**
   * What the task produced. `null` when it could not run at all — the interpreter is not up, or
   * the named session is gone.
   */
  readonly value: T | null;

  /**
   * The dimension and unit names any context this task built enumerated, or `null` when it built
   * none or they were already known. See {@link SemanticNames}.
   */
  readonly names: SemanticNames | null;

  /**
   * Whether a wasm panic was absorbed while serving this task. The asking side restarts; the
   * answering side cannot restart itself.
   */
  readonly faulted: boolean;

  /** The user prelude's error from the last context this task built, or `null`. */
  readonly preludeError: string | null;
}

/**
 * What each task takes and what it gives back. One map rather than a dozen function signatures, so
 * the host and the task layer are checked against the same thing and a task added to one without
 * the other does not compile.
 */
export interface TaskMap {
  evalBlocks: { request: EvalBlocksRequest; response: Budgeted<readonly BlockHints[]>; };
  evalDocument: { request: EvalDocumentRequest; response: Budgeted<readonly Hint[]>; };
  evalNoteUnits: { request: EvalNoteUnitsRequest; response: Budgeted<readonly InlineResult[]>; };
  evalExprs: { request: EvalExprsRequest; response: Budgeted<readonly InlineResult[]>; };
  evalCodeBlock: { request: EvalCodeBlockRequest; response: Budgeted<NumbatResult>; };
  evalBindings: { request: EvalBindingsRequest; response: Budgeted<readonly BindingOutcome[]>; };
  evalProperty: { request: EvalPropertyRequest; response: InlineResult; };
  evalScopeTree: { request: EvalScopeTreeRequest; response: Budgeted<ScopeTree>; };
  snapshot: { request: ContextRef; response: ScopeSnapshot; };
  facts: { request: FactsRequest; response: ReadonlyMap<string, SymbolFacts>; };
  holeType: { request: HoleRequest; response: { type: string | null; }; };
  completions: { request: CompletionsRequest; response: CompletionsReply; };
  replOpen: { request: { applyRates: boolean; }; response: ReplSession; };
  replEval: { request: { id: number; input: string; applyRates: boolean; }; response: ReplOutcome; };
  replReset: { request: { id: number; applyRates: boolean; }; response: ReplSession; };
  replClose: { request: { id: number; }; response: true; };

  /**
   * Load a `.nbt` file as though it were a prelude, and report what happened.
   *
   * The one task whose request could not be expressed as any other, because it needs the prelude
   * error _of the context it just built_ — and the read-immediately-after-`createContext` ordering
   * that used to supply it is precisely what a boundary does not preserve. Both halves come back
   * together, which is what makes the banner's two cases distinguishable: the prelude ahead of this
   * file is broken, or this file is.
   */
  preludeCheck: {
    request: { text: string; applyRates: boolean; preludeBefore: string; };
    response: { earlier: string | null; result: NumbatResult; };
  };

  /**
   * Build a prelude context and throw it away, for the names its build enumerates.
   *
   * The one task whose answer is worthless and whose _envelope_ is all we care about: the
   * highlighter needs the dimension and unit lists before anything has been evaluated, so that a
   * `numbat` block opened in pure source mode, with nothing rendered, no completion, and no REPL,
   * is colored like every other one.
   */
  warm: { request: { applyRates: boolean; }; response: true; };

  /**
   * What the context pool has done, for the settings' debug info.
   *
   * A task rather than a control message, because the numbers are on the far side of the boundary
   * and everything that crosses it already goes through one door.
   */
  poolStats: { request: Record<string, never>; response: PoolCounts; };
}

/**
 * What the context pool has done since the interpreter came up. `hits`, `misses` and `refused`
 * partition the requests; `recycled` counts contexts offered back and `freed` the ones an eviction
 * or a release sent to `free` instead.
 */
export interface PoolCounts {
  readonly hits: number;
  readonly misses: number;
  readonly refused: number;
  readonly recycled: number;
  readonly freed: number;
}

/** The tasks by name. A union rather than a bare `string` so an unhandled one is a type error. */
export type TaskName = keyof TaskMap;
