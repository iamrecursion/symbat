// The interpreter's vocabulary for *semantic* syntax highlighting: which names are types, which are
// dimensions, and which are units. Kept in its own module — with no Obsidian or wasm imports — so
// the tokenizer and the REPL language can consult it without pulling the interpreter in (which
// would make them impossible to unit-test in isolation).
//
// interpreter/numbat.ts feeds it names as it learns them: the standard library and custom prelude
// are captured from the first prelude context, and any dimensions/units the completion vocabulary
// discovers (block-local or REPL-session definitions) are merged in as they are seen. The sets only
// ever grow, so this is additive across notes; each growth notifies subscribers (the open editors)
// to re-highlight. Until a name is known, the tokenizer falls back to a capitalization heuristic
// (see syntax/tokenizer.ts) so capitalized identifiers still read as types.

import { BUILTIN_TYPE_NAMES } from "../completion/expressions";

/** The semantic kinds this module recognizes — a subset of the tokenizer's kinds. */
export type SemanticKind = "type" | "dimension" | "unit";

// Types are seeded with the built-ins (always known); dimensions and units arrive as they are
// captured. Session-lived (just strings), so not part of context disposal.
const types = new Set<string>(BUILTIN_TYPE_NAMES);

/** Dimension names (`Length`, `Time`, and any the user declares). */
const dimensions = new Set<string>();

/** Unit names, both prelude and user-defined — by far the largest of the three. */
const units = new Set<string>();

/** Open editors waiting to re-highlight when any of the sets grows. */
const listeners = new Set<() => void>();

/**
 * The semantic kind of `word` — `type`, `dimension`, or `unit` — or `null` when it is none of those
 * (a function, variable, or unknown name the tokenizer will color by other means). Synchronous, so
 * the tokenizer can call it per token.
 */
export function semanticKind(word: string): SemanticKind | null {
  if (units.has(word)) {
    return "unit";
  }
  if (dimensions.has(word)) {
    return "dimension";
  }
  if (types.has(word)) {
    return "type";
  }

  return null;
}

/**
 * Merge captured dimension and unit names in; if any are new, notify subscribers so open editors
 * re-highlight. Called by interpreter/numbat.ts with the standard library and prelude names, and
 * again with whatever the completion vocabulary turns up.
 */
export function recordSemanticNames(newDimensions: Iterable<string>, newUnits: Iterable<string>): void {
  let changed = false;

  for (const name of newDimensions) {
    if (!dimensions.has(name)) {
      dimensions.add(name);
      changed = true;
    }
  }

  for (const name of newUnits) {
    if (!units.has(name)) {
      units.add(name);
      changed = true;
    }
  }

  if (changed) {
    // Copy first: a listener may unsubscribe (edit its set) while iterating.
    for (const listener of [...listeners]) {
      listener();
    }
  }
}

/**
 * Forget every captured name, notifying subscribers if there were any.
 *
 * The sets only ever grow as names are learned, which is right while the vocabulary is fixed — but
 * the user prelude can *remove* a `unit` or `dimension`, and a wasm restart replaces the standard
 * library wholesale. Without this, a name deleted from the prelude kept highlighting as a unit for
 * the rest of the session.
 */
export function forgetSemanticNames(): void {
  if (dimensions.size === 0 && units.size === 0) {
    return;
  }
  dimensions.clear();
  units.clear();

  // Copy first: a listener may unsubscribe (edit its set) while iterating.
  for (const listener of [...listeners]) {
    listener();
  }
}

/** Subscribe to be notified whenever the known names grow, returning an unsubscribe function.
 *  Editors use this to re-highlight as names are learned. */
export function subscribeSemanticNames(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
