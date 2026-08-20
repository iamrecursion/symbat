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

/**
 * How long an outcome stands in for the evaluation that produced it.
 *
 * Inside it, a hit is the whole answer and the widget schedules no evaluation at all. This ensures
 * that scrolling back and forth over the same rows is free rather than simply _flicker_-free.
 * Outside that, the hit is still painted but the evaluation runs anyway, so anything reading the
 * clock always moves.
 *
 * Ten seconds is chosen against the gesture, not the value: it comfortably covers scrolling a
 * column and coming back, and it is short enough that a `now()` property in a Base reads as live.
 */
export const OUTCOME_FRESH_MS = 10_000;

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
