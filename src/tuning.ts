// Tuning constants, centralized.
//
// Naming each one for its consumer makes the differences deliberate and reviewable. Most of them
// *should* differ — see the comments — so this file deliberately does not unify values, only names.

// EVALUATION CACHES
// ================================================================================================
//
// All evicted oldest-first. The sizes differ because the unit being cached differs: inlay hints
// cache one entry per *block*, so a large note needs many; the others cache one entry per *note*,
// so a handful covers realistic use.

/** Cached block evaluations for inlay hints. Bounded so a very large note cannot grow memory
 *  without limit; an evicted block re-evaluates in a moment. */
export const INLAY_CACHE_ENTRIES = 200;

/** Cached whole-note evaluations for inline expressions, keyed by signature. */
export const INLINE_EVAL_CACHE_ENTRIES = 32;

/** Cached per-note values for the scope inspector, matching the inline-eval cache because it is the
 *  same unit: one entry per note visited. */
export const SCOPE_VALUE_CACHE_ENTRIES = 32;

/** Cached whole-note evaluations for the reading view. Smaller than the editor's because it exists
 * only so the many sections of a single render share one replay, not to span a browsing session. */
export const READING_EVAL_CACHE_ENTRIES = 16;

/** Cached answers to point questions about one name in one scope (interpreter/facts.ts).
 *
 *  The unit is smaller than the four above (a name rather than a note) but so is the response, and
 *  the number of *live* scopes is one or two: the key carries the code above the cursor, so moving
 *  to another line is a different scope entirely. What the size has to cover is a completion
 *  popover's worth of rows in the scope being typed in, plus whatever the reader hovered just
 *  before, and an evicted entry costs one lookup. */
export const FACTS_CACHE_ENTRIES = 128;

/** Cached types for the trailing hole of a half-written expression (interpreter/facts.ts).
 *
 *  Bigger than it looks like it needs to be, because the unit is a *keystroke*: typing `12 km / 3 `
 *  asks about every prefix of it that ends in an operand slot, and each is its own entry. What the
 *  size buys is that backspacing over a word finds every step of the way back already answered. */
export const HOLE_CACHE_ENTRIES = 64;

// THE CONTEXT POOL
// ================================================================================================

/**
 * How many used-but-unchanged interpreter contexts are kept for the next request at the same
 * prefix (interpreter/worker/engine.ts).
 *
 * The unit is a *note's scope*: a key is `(applyRates, preludeBefore, prefix)`, so a note being
 * rendered occupies exactly one entry however many blocks it has, and four covers a reader with a
 * few panes open before it starts evicting. The two costs are not symmetric as an eviction costs
 * one standard-library load, which is what every request paid before the pool existed, while an
 * entry costs 1.2 MiB of wasm heap that is never given back, since wasm memory only grows.
 *
 * Both numbers were measured rather than guessed: 1.2 MiB per live context, and 55 ms to build one
 * here against ~163 ms in Obsidian. Freed pages *are* reused so what this bounds is the high-water
 * mark.
 */
export const PRISTINE_POOL_ENTRIES = 4;

// PREAMBLE CACHES
// ================================================================================================
//
// Not evaluations but the derivation that precedes them (properties/preamble-cache.ts). An evicted
// entry costs one re-derivation — tens of microseconds, not an interpreter round trip — so the caps
// here exist to bound memory on a vault-wide render rather than to shape hit rates. The import
// walk is the exception, and says why below: evicting one of those loses an invalidation rather
// than a computation.
//
// Eviction is nonetheless by least recent *use*, as it is for the property outcomes below, and for
// the same reason rather than out of symmetry: the first of these caps is sized against a Bases
// table, and under write order a table longer than its cap evicts precisely the rows the reader is
// scrolling back to. A cheap miss repeated on every row of every scroll stops being cheap.

/** Preambles derived from the metadata cache, one per note. Sized for a Bases table: every visible
 *  row derives its own note's preamble, and scrolling back should not have to redo them. */
export const PREAMBLE_FILE_CACHE_ENTRIES = 128;

/** Preambles derived from frontmatter *text*, one per open editor's current content. Small because
 *  the key moves with every keystroke in frontmatter — the entries this holds are the surfaces of
 *  one note agreeing with each other, not a browsing history. */
export const PREAMBLE_BODY_CACHE_ENTRIES = 16;

/** What imported notes export, one per imported note. Sized against the notes being imported rather
 *  than the ones importing, because one importer can pull in many. */
export const PREAMBLE_EXPORT_CACHE_ENTRIES = 64;

/**
 * Flattened import walks, one per importing note.
 *
 * The one cap here that is not free to be small, because this cache has a second job: it is the
 * reverse index `invalidatePreamblesFor` scans to find the notes that imported the one that
 * changed. An evicted walk is therefore not a re-derivation but a lost invalidation — an importer
 * left holding a preamble built from the imports as they were. Nothing else would catch it: the two
 * preamble memos hit on the *importer's own* frontmatter, which an edit to a note it imports does
 * not touch.
 *
 * So it is derived from the two caps above rather than chosen: room for one live walk per note
 * those two can be holding at once, doubled so a note whose `numbat-use` moved — leaving an entry
 * filed under its old targets until it ages out — cannot push a live one out. Written as the sum so
 * that raising either of them cannot silently invert the relationship.
 *
 * What this pays for is a linear scan, on a note change rather than a keystroke, over entries that
 * are one small array each.
 */
export const IMPORT_WALK_CACHE_ENTRIES = 2 * (PREAMBLE_FILE_CACHE_ENTRIES + PREAMBLE_BODY_CACHE_ENTRIES);

// PROPERTY OUTCOME CACHES
// ================================================================================================
//
// What the Numbat property widget paints while it is not evaluating (properties/outcome-cache.ts).
//
// Two caches rather than one, because they hold two different things: the note cache holds one
// entry per *property* of a note whose value is the committed one, filled a whole note at a time;
// the live cache holds the keystroke history of the row being typed into, which is one row.

/**
 * Cached committed-value outcomes, across notes.
 *
 * Sized against the *note*, not against the screen: a pass fills an entry for every numbat property
 * of the note it ran on, not only for the ones on show. A Bases table is therefore rows times the
 * note's whole property count.
 *
 * Generous because an entry is a small display object and a miss is a standard-library load. The
 * cap is a backstop against a session that visits thousands of notes; eviction is by least recent
 * *use*, so what stays is the working set rather than whatever arrived last.
 */
export const PROPERTY_NOTE_OUTCOME_ENTRIES = 2048;

/**
 * Cached outcomes for text that is not (yet) the note's.
 *
 * Mostly the keystroke history of the row being typed into. But an array *item* has no binding of
 * its own, so it never matches one and lives on this path permanently.
 */
export const PROPERTY_LIVE_OUTCOME_ENTRIES = 512;

/**
 * How long the note batch waits before it starts.
 *
 * Obsidian renders a whole note's property rows in one pass, and a Bases table a whole column, so
 * every widget asks for its note's outcomes within a frame or two of the others. This is what turns
 * those N asks into one evaluation. Short enough not to be seen, as the widgets have already
 * painted whatever they had cached, and long enough to cover a render pass.
 */
export const PROPERTY_BATCH_COALESCE_MS = 24;

// IMPURITY
// ================================================================================================
//
// Numbat has exactly two builtins whose answer depends on something outside the program — `now()`
// and `random()` (interpreter/purity.ts) — and every cache in the plugin is keyed by text and by
// interpreter generation, neither of which moves when the clock does. This is the one constant that
// exists because of that.

/**
 * How long an answer that *could* have changed stands in for the evaluation that produced it.
 *
 * Inside it, a hit is the whole answer and the surface schedules no evaluation at all. This ensures
 * that scrolling back and forth over the same rows is free rather than simply _flicker_-free.
 * Outside that, the hit is still painted but the evaluation runs anyway, so anything reading the
 * clock always moves.
 *
 * Ten seconds is chosen against the gesture, not the value: it comfortably covers scrolling a
 * column and coming back, and it is short enough that a `now()` property in a Base reads as live.
 *
 * It applies **only** to scopes that read the clock or the RNG. Everything else is cached until its
 * key moves, because there is no newer answer to go and get: a window on a value that cannot change
 * is a re-evaluation with a guaranteed identical result. Named for that condition rather than for
 * the property outcomes it started in, since every evaluation cache reads it now.
 */
export const IMPURE_FRESH_MS = 10_000;

// THE EVALUATION LIMIT
// ================================================================================================
//
// What keeps a note full of Numbat from locking up the app (interpreter/budget.ts).
//
// None of these is the limit itself as that is a user setting, because how long a note may take is
// a judgement about the reader's machine and not something this file can know. These instead
// describe the surrounding mechanics: what counts as one note's evaluation, and how long a note
// that could not finish is left alone afterwards.

/**
 * How long a gap between two evaluations of the same note means a new one has begun.
 *
 * The limit is a note's allowance, not a task's, because reading view renders a note one code block
 * at a time — each an independent post-processor call with no pass around it, so a per-task budget
 * would hand a two-hundred-block note two hundred budgets and bound nothing. Tasks sharing a note
 * therefore draw on one allowance, and this is what says when that allowance is spent on something
 * new rather than on more of the same.
 *
 * A second is far longer than the gap between two blocks of one render, which is a frame at most,
 * and far shorter than a reader going away and coming back. And a gap this long can only have
 * elapsed if the main thread was free during it, which is exactly the condition under which nobody
 * minds paying again.
 */
export const BUDGET_REFILL_IDLE_MS = 1_000;

/** Notes with an allowance part-spent, one entry each. Only notes being evaluated right now hold
 *  one — an entry outlives its burst by {@link BUDGET_REFILL_IDLE_MS} and is then meaningless — so
 *  this is sized against the surfaces rendering at once, not against a browsing session. */
export const BUDGET_BUCKET_ENTRIES = 16;

/**
 * How long a note that ran out of time is left alone before it is tried again.
 *
 * Most surfaces need no such rule: their answers are cached against the note's own text, so a
 * refusal filed there is found again on the next render and costs a map lookup. Two are not covered
 * by their own key (the property outcomes *age* (see {@link IMPURE_FRESH_MS}) and that the reading
 * view caches nothing at all) and without this those two would pay the whole limit again on every
 * freshness tick and every render.
 *
 * Deliberately much longer than the freshness window it has to dominate: freshness exists so a
 * property that reads the clock keeps moving, and a property that cannot be evaluated at all has no
 * clock to read. A minute is short enough to feel like a retry rather than a wall, and every other
 * route back is immediate anyway — editing the note, changing the limit, or clearing the caches.
 */
export const OVER_BUDGET_COOLDOWN_MS = 60_000;

/**
 * How long after telling the reader that a note ran out of time before saying so again.
 *
 * The message itself already reaches them, beside the line that has no value as that is what
 * `hintsForBlock`'s error hint and the property row's error text are. What this adds is _which_
 * note, how long it was given, and where the setting is. It also covers the one reader the in-place
 * message does not reach, the one who has switched result hints off.
 *
 * Rate-limited because the trip is per block, not per note: a reading-view render of a note full of
 * fences can reach the limit two hundred times, and two hundred identical toasts is a worse failure
 * than the one being reported. A minute is long enough that a burst collapses to one and short
 * enough that a note opened later still gets an answer. The `console.warn` beside it is
 * *un*throttled, so nothing is actually lost: this is what "Copy debug info" ends up carrying.
 */
export const EVALUATION_LIMIT_NOTICE_MS = 60_000;

/** Notes waiting out a cool-down, one entry each. Small because a note that cannot finish is rare,
 *  and because an evicted entry is a retry rather than a wrong answer. */
export const REFUSAL_LEDGER_ENTRIES = 32;

// THE INTERPRETER'S THREAD
// ================================================================================================
//
// What `interpreter/host.ts` needs in order to decide that a worker is not going to work here.
// Nothing in this repository can tell you whether a blob worker runs inside Obsidian on a phone,
// which is why there is a ladder at all and why every rung on it has a clock.

/**
 * How long a worker has to answer before the ladder gives up on it.
 *
 * The wait is for its `ready` message, not for the constructor: a content-security policy that
 * refuses `blob:` frequently manifests as a construction that succeeds and a worker that never
 * speaks, and a hang there is indistinguishable from a broken plugin.
 *
 * Generous, because what it is really waiting for is a 1.9 MB wasm module to compile on whatever
 * the reader is holding. The cost of being wrong in this direction is one slow first evaluation;
 * the cost of being wrong in the other is falling back on a device where the worker would have
 * worked, and thereby losing the only evaluation ceiling the platform offers.
 */
export const WORKER_READY_TIMEOUT_MS = 5_000;

/** How many restarts inside {@link RESPAWN_STORM_WINDOW_MS} mean something is wrong with the setup
 *  rather than with one note. Above this the host stops trying the same thing again — see
 *  `host.ts`, which has two quite different answers depending on whether a personal prelude is
 *  configured. */
export const RESPAWN_STORM_LIMIT = 3;

/** The window the restarts above are counted in. A minute is long enough that two unrelated crashes
 *  in one session do not add up, and short enough that a genuine storm trips it at once. */
export const RESPAWN_STORM_WINDOW_MS = 60_000;

/**
 * The shortest time the REPL leaves its "interpreter is starting" cue up.
 *
 * A floor rather than a delay anybody wants: starting is usually far quicker than this, and a cue
 * that appears and vanishes inside one frame reads as a flicker rather than as progress. This
 * leaves a reader who pressed nothing wondering what just happened. Long enough to be seen as an
 * event; short enough that a respawn is still over before anyone reaches for the input.
 *
 * It applies **only** to the starting cue. An evaluation shows its own, and holding that one open
 * after the answer arrived would be adding two seconds to every line the reader types.
 */
export const REPL_STARTING_CUE_MIN_MS = 2_000;

/**
 * How many items a looping task gets through between chances to be stopped.
 *
 * A boundary is a macrotask hop, which costs a fraction of a millisecond on an idle thread, so what
 * this trades is not throughput against latency but **granularity against overhead**: it is how
 * stale an answer may be before the task producing it learns that nobody wants it. Thirty-two spans
 * is well under a frame's worth of interpreting, and a note with fewer than that never reaches a
 * second boundary at all.
 *
 * The per-block passes do not use this: a block is a whole standard-library load, so each one is
 * already worth a boundary of its own.
 */
export const TASK_YIELD_ITEMS = 32;

/**
 * How long "stop all evaluations" waits after canceling the queue before terminating the worker.
 *
 * The cooperative rung reaches everything that has not started, which for the common case — a note
 * pass grinding through two hundred blocks — is nearly all of it, and it keeps the wasm instance,
 * the context pool, the applied rates and the REPL session. The grace period is what gives it a
 * chance to be enough. Short, because the reader has just told the plugin to stop.
 */
export const STOP_GRACE_MS = 250;

// DEBOUNCING INTERVALS
// ================================================================================================

/** How long to wait after the last edit before re-evaluating changed blocks. */
export const INLAY_DEBOUNCE_MS = 200;

/** How long to wait after the last edit before re-evaluating the note's inline expressions. Matches
 *  {@link INLAY_DEBOUNCE_MS}: both react to typing in the editor, and a shared value keeps the two
 *  updates visually simultaneous. */
export const INLINE_EVAL_DEBOUNCE_MS = 200;

/** How long after the last keystroke a property widget re-evaluates. Longer than the editor
 *  debounces: a property is a single short expression being typed in full, so re-evaluating
 *  mid-word is noise rather than feedback. */
export const PROPERTY_EVAL_DEBOUNCE_MS = 300;

/**
 * How long a burst of property-type assignments is collected before the note scope is refreshed.
 *
 * Obsidian's `metadataTypeManager` fires "changed" per assignment, and a plugin that installs its
 * own types (this one included) fires it on registration too so this is several events for one user
 * action. Non-restarting, like the module graph's own refresh: a burst should still be answered
 * promptly, just **once** rather than a bunch of times.
 */
export const TYPE_CHANGE_COALESCE_MS = 50;

// DWELL INTERVALS
// ================================================================================================

/** How long a completion or search result must stay selected before its documentation opens.
 *
 *  Genuinely shared: the code-block completer, the Numbat input's completer and the scope inspector
 *  are one interaction to a user, and three different delays would read as a bug. */
export const COMPLETION_DWELL_MS = 500;
