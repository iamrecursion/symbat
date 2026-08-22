// The two shapes a surface's facts host comes in, and the one thing they have in common: neither of
// them holds a context.
//
// Before the seam this module was where the wasm handle lived — the only one in the facts layer,
// and the part that had to move. It moved. What is left is the mapping from "which scope is this
// surface's cursor in *now*" to a request, which is a question only the surface can answer and only
// on the tick it is asked.
//
// The two shapes exist because two kinds of scope do:
//
//   * a **scope spec** — the code above the cursor — which the interpreter can rebuild from text
//     whenever it likes, and does, and caches;
//   * a **session**, which _accumulates_ definitions and therefore cannot be rebuilt from anything.
//     Only the REPL has one, and it is named by an integer the interpreter validates rather than by
//     anything this side could dereference.
//
// Both re-read their scope on every call rather than capturing it, because it moves: a property
// field's scope changes with the property above it, a `.nbt` file's with the caret, and a REPL
// session's with every line submitted. `null` from the getter means there is nothing to ask — the
// interpreter is still loading, or the feature is off — and both methods then answer as though
// nothing were known, which every consumer already handles.

import {
  ensureFacts,
  ensureHoleType,
  type FactsHost,
  type FactsReader,
  type HoleReader,
  knownFacts,
  knownHoleType,
  scopeCanChange,
} from "./facts";
import { ask, interpreterGeneration, preludeReadsClockOrRandom, touchCompletionIdle } from "./numbat";
import type { ContextRef, ScopeSpec } from "./protocol";
import { scopeKey } from "./protocol";

/**
 * A reader over the scope `spec` describes, built — or, far more often, reused — by the
 * interpreter's own replayed-scope cache.
 *
 * `null` when there is no answer to be had: the interpreter is down, or the scope would not build.
 * Nothing is cached then, so the next ask tries again rather than remembering an absence as an
 * answer.
 *
 * The lookups of one batch are one request, and they are `interactive`: somebody is looking at a
 * cursor waiting for this.
 */
export function scopeFactsReader(spec: ScopeSpec, idleMs: number): FactsReader {
  return async (probes, want) => {
    // **Ungrouped, deliberately.** A group here would look right and be wrong: two batches about
    // the same scope are two different questions — a screenful of signatures, and one name's
    // documentation for a dwell — and letting the second cancel the first would drop the
    // signatures off every visible row the moment the reader paused on one. The coalescing that
    // matters is already done by `ensureFacts`, which drops the probes it would only re-answer.
    const filled = await ask("facts", { ref: { kind: "scope", spec }, probes, want }, {
      priority: "interactive",
    });
    if (filled === null) {
      return null;
    }

    // The scope this used is the completer's own cached one, and it is released after an idle
    // period like any other use of it: a reader hovering their way down a block is using it.
    touchCompletionIdle(idleMs);

    return { facts: filled, impure: scopeCanChange(spec, preludeReadsClockOrRandom()) };
  };
}

/**
 * The facts half of a {@link import("../views/input").NumbatInputHost}, answered from whichever
 * scope the surface's cursor is in _now_.
 */
export function scopeFactsHost(scope: () => ScopeSpec | null, idleMs: () => number): FactsHost {
  const keyOf = (spec: ScopeSpec) => scopeKey(spec, interpreterGeneration());
  const holeReader = (spec: ScopeSpec): HoleReader => async (input) => {
    const typed = await ask("holeType", { ref: { kind: "scope", spec }, input }, { priority: "interactive" });
    if (typed === null) {
      return null;
    }

    touchCompletionIdle(idleMs());
    return typed;
  };

  return {
    facts: (names, want) => {
      const spec = scope();
      return spec === null
        ? Promise.resolve()
        : ensureFacts(keyOf(spec), names, want, scopeFactsReader(spec, idleMs()));
    },
    knownFacts: (name, want) => {
      const spec = scope();
      return spec === null ? undefined : knownFacts(keyOf(spec), name, want);
    },
    holeType: (input) => {
      const spec = scope();
      return spec === null ? Promise.resolve() : ensureHoleType(keyOf(spec), input, holeReader(spec));
    },
    knownHoleType: (input) => {
      const spec = scope();
      return spec === null ? undefined : knownHoleType(keyOf(spec), input);
    },
  };
}

/** A REPL session, as the facts layer sees it. */
export interface SessionScope {
  /**
   * What identifies this session's exact state. It has to move whenever anything could have
   * changed what a name in it means — for the REPL, every line it evaluates.
   */
  readonly key: string;

  /**
   * The integer the interpreter knows this session by. Not a handle: an id the interpreter has
   * forgotten is a miss, where a pointer into a heap that has been replaced is a crash.
   */
  readonly id: number;

  /**
   * Whether an answer from it could differ next time — the prelude, or the session's own
   * definitions, reading the clock (interpreter/purity.ts).
   */
  readonly impure: boolean;
}

/**
 * A facts host over a session: a scope that cannot be rebuilt from text, because the reader built
 * it a line at a time.
 *
 * The scope is re-read _after_ the answer arrives and its key re-checked, not captured. A REPL that
 * was reset in the meantime has the same session id and a different context, and an answer about
 * what that name used to mean is worse than no answer at all. A moved key is simply no answer,
 * which leaves the next ask to try again against whatever exists now.
 */
export function sessionFactsHost(scope: () => SessionScope | null): FactsHost {
  const readerFor = (asked: SessionScope): FactsReader => async (probes, want) => {
    const ref: ContextRef = { kind: "session", id: asked.id };
    const filled = await ask("facts", { ref, probes, want }, { priority: "interactive" });
    if (filled === null || scope()?.key !== asked.key) {
      return null;
    }

    return { facts: filled, impure: asked.impure };
  };

  const holeReaderFor = (asked: SessionScope): HoleReader => async (input) => {
    const ref: ContextRef = { kind: "session", id: asked.id };
    const typed = await ask("holeType", { ref, input }, { priority: "interactive" });
    return typed === null || scope()?.key !== asked.key ? null : typed;
  };

  return {
    facts: (names, want) => {
      const live = scope();
      return live === null ? Promise.resolve() : ensureFacts(live.key, names, want, readerFor(live));
    },
    knownFacts: (name, want) => {
      const live = scope();
      return live === null ? undefined : knownFacts(live.key, name, want);
    },
    holeType: (input) => {
      const live = scope();
      return live === null ? Promise.resolve() : ensureHoleType(live.key, input, holeReaderFor(live));
    },
    knownHoleType: (input) => {
      const live = scope();
      return live === null ? undefined : knownHoleType(live.key, input);
    },
  };
}
