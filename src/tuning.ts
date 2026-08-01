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

// DWELL INTERVALS
// ================================================================================================

/** How long a completion or search result must stay selected before its documentation opens.
 *
 *  Genuinely shared: the code-block completer, the Numbat input's completer and the scope inspector
 *  are one interaction to a user, and three different delays would read as a bug. */
export const COMPLETION_DWELL_MS = 500;
