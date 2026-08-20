// The property outcome caches: what counts as a hit, what the keys make incremental, and the
// coalescing — the part with a race in it, which is why the pass and its clock are injected.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { PropertyDisplay } from "../../../src/properties/display.ts";
import {
  type BatchDriver,
  cancelBatches,
  clearPropertyOutcomes,
  firstStale,
  liveKey,
  liveOutcome,
  noteOutcome,
  outcomeEpoch,
  outcomeKeys,
  rememberLiveOutcome,
  rememberNoteOutcome,
  requestBatch,
  scopeKey,
} from "../../../src/properties/outcome-cache.ts";
import type { BindingOutcome } from "../../../src/properties/outcomes.ts";
import { type NotePreamble, type PropertyBinding, scopeChunksAbove } from "../../../src/properties/parse.ts";
import { OUTCOME_FRESH_MS, PROPERTY_LIVE_OUTCOME_ENTRIES, PROPERTY_NOTE_OUTCOME_ENTRIES } from "../../../src/tuning.ts";

// The note cache stores the outcome itself, so the two surfaces that read it can each project it
// their own way. Nothing here cares which field carries the marker, only that it comes back intact.
const outcomeOf = (text: string): BindingOutcome => ({
  key: "k",
  kind: "error",
  resultHtml: null,
  valueHtml: null,
  holeType: null,
  errorText: text,
  plain: null,
  warning: null,
  written: text,
});

const shown = (text: string): PropertyDisplay => ({ kind: "error", text });

function binding(key: string, expr: string, extra: Partial<PropertyBinding> = {}): PropertyBinding {
  return { key, path: [key], name: key, expr, defs: [], code: `let ${key} = (${expr})`, kind: "expression", ...extra };
}

function preambleOf(bindings: PropertyBinding[], imports?: string[]): NotePreamble {
  return { bindings, skips: [], source: bindings.map((entry) => entry.code).join("\n"), imports };
}

beforeEach(() => {
  cancelBatches();
  clearPropertyOutcomes();
});

describe("the note cache", () => {
  it("answers for the text it was told about, and only that one", () => {
    rememberNoteOutcome("k", "2 + 2", outcomeOf("four"));

    assert.deepEqual(noteOutcome("k", "2 + 2")?.outcome, outcomeOf("four"));
    // The row has been edited since: a display computed for the old value is not this one's answer.
    assert.equal(noteOutcome("k", "2 + 3"), null);
    assert.equal(noteOutcome("other", "2 + 2"), null);
  });

  it("keeps one entry per property, replacing what that scope held before", () => {
    const last = PROPERTY_NOTE_OUTCOME_ENTRIES + 9;
    for (let i = 0; i <= last; i += 1) {
      rememberNoteOutcome("k", `expr ${i}`, outcomeOf(`v${i}`));
    }

    // Well past the cap, and one key: a property has one committed value, so an older entry for it
    // is out of date rather than another entry.
    assert.deepEqual(noteOutcome("k", `expr ${last}`)?.outcome, outcomeOf(`v${last}`));
    assert.equal(noteOutcome("k", "expr 0"), null);
  });

  it("evicts least-recently-used past the cap", () => {
    for (let i = 0; i <= PROPERTY_NOTE_OUTCOME_ENTRIES; i += 1) {
      rememberNoteOutcome(`k${i}`, "e", outcomeOf("v"));
    }

    assert.equal(noteOutcome("k0", "e"), null, "with nothing read, the first written is the first dropped");
    assert.notEqual(noteOutcome("k1", "e"), null);
    assert.notEqual(noteOutcome(`k${PROPERTY_NOTE_OUTCOME_ENTRIES}`, "e"), null);
  });

  // The Bases case: a table longer than the cap scrolls back to rows it has already shown, and
  // under write order those are precisely the ones evicted — so the cells fell back to painting
  // their raw expressions and the note re-evaluated from scratch. Reading is what says "still in
  // use"; writing says only "arrived".
  it("keeps an entry that is still being read, whatever it was written", () => {
    for (let i = 0; i < PROPERTY_NOTE_OUTCOME_ENTRIES; i += 1) {
      rememberNoteOutcome(`k${i}`, "e", outcomeOf("v"));
    }

    // The oldest write, read once — as a re-rendered row reads it.
    assert.notEqual(noteOutcome("k0", "e"), null);
    rememberNoteOutcome("fresh", "e", outcomeOf("v"));

    assert.notEqual(noteOutcome("k0", "e"), null, "the entry that was read survives");
    assert.equal(noteOutcome("k1", "e"), null, "and the one that was not is what goes");
  });

  // A re-answered property arrives through a *miss* — the row's text moved, so the read that
  // preceded the write returned nothing and promoted nothing. Under `Map.set` the new answer would
  // then inherit the position the old one held and be evicted ahead of entries nobody has looked at
  // since, which is the one entry in the cache that certainly is not stale.
  it("moves a re-answered property to the young end, not the position its old answer held", () => {
    for (let i = 0; i < PROPERTY_NOTE_OUTCOME_ENTRIES; i += 1) {
      rememberNoteOutcome(`k${i}`, "e", outcomeOf("v"));
    }

    rememberNoteOutcome("k0", "edited", outcomeOf("v2"));
    rememberNoteOutcome("fresh", "e", outcomeOf("v"));

    assert.deepEqual(noteOutcome("k0", "edited")?.outcome, outcomeOf("v2"), "the answer just written survives");
    assert.equal(noteOutcome("k1", "e"), null, "and the one nobody has touched is what goes");
  });

  it("stops being fresh once it is older than the window", () => {
    const at = performance.now();
    rememberNoteOutcome("k", "e", outcomeOf("v"));

    assert.equal(noteOutcome("k", "e", at + OUTCOME_FRESH_MS - 1)?.fresh, true);
    assert.equal(noteOutcome("k", "e", at + OUTCOME_FRESH_MS + 1)?.fresh, false);
    // Still the answer to paint, though — an old value beats a raw expression.
    assert.deepEqual(noteOutcome("k", "e", at + OUTCOME_FRESH_MS + 1)?.outcome, outcomeOf("v"));
  });
});

describe("the live cache", () => {
  it("keeps one entry per keystroke and evicts least-recently-used", () => {
    for (let i = 0; i <= PROPERTY_LIVE_OUTCOME_ENTRIES; i += 1) {
      rememberLiveOutcome(liveKey("scope", `3 m +${i}`), shown(`v${i}`));
    }

    assert.equal(liveOutcome(liveKey("scope", "3 m +0")), null);
    assert.deepEqual(liveOutcome(liveKey("scope", "3 m +1"))?.display, shown("v1"));
  });

  it("moves a re-answered keystroke to the young end", () => {
    for (let i = 0; i < PROPERTY_LIVE_OUTCOME_ENTRIES; i += 1) {
      rememberLiveOutcome(liveKey("scope", `3 m +${i}`), shown(`v${i}`));
    }

    // The same text answered again — an entry that aged out of the freshness window and was
    // re-evaluated, which is a write onto a key that is already there.
    rememberLiveOutcome(liveKey("scope", "3 m +0"), shown("v0 again"));
    rememberLiveOutcome(liveKey("scope", "fresh"), shown("v"));

    assert.deepEqual(liveOutcome(liveKey("scope", "3 m +0"))?.display, shown("v0 again"));
    assert.equal(liveOutcome(liveKey("scope", "3 m +1")), null);
  });

  it("separates two texts in one scope, and one text in two scopes", () => {
    rememberLiveOutcome(liveKey("scope", "a"), shown("1"));
    rememberLiveOutcome(liveKey("other", "a"), shown("2"));

    assert.deepEqual(liveOutcome(liveKey("scope", "a"))?.display, shown("1"));
    assert.deepEqual(liveOutcome(liveKey("other", "a"))?.display, shown("2"));
    assert.equal(liveOutcome(liveKey("scope", "b")), null);
  });
});

describe("the keys", () => {
  const note = () => preambleOf([binding("a", "1"), binding("b", "a * 2"), binding("c", "b + 1")], ["import-1"]);

  it("keys each binding by the scope above it — the same key a widget builds for that property", () => {
    const preamble = note();
    const keys = outcomeKeys(true, preamble);

    // What resolveOutcome computes for property `b`: its imports, then the bindings above it.
    assert.equal(keys[1], scopeKey(true, "b", null, null, ["import-1", "let a = (1)"]));
    assert.equal(keys[0], scopeKey(true, "a", null, null, ["import-1"]));
  });

  it("moves the keys below an edited property and leaves the ones above it alone", () => {
    const before = outcomeKeys(true, note());
    const edited = note();
    edited.bindings[1] = binding("b", "a * 3");
    const after = outcomeKeys(true, edited);

    assert.equal(after[0], before[0], "the property above the edit is untouched");
    assert.equal(after[1], before[1], "and so is the edited property's own key — its text is not in it");
    assert.notEqual(after[2], before[2], "the property below it may have depended on what changed");
  });

  it("agrees with the scope a widget builds for a nested property", () => {
    // The two sides of the note cache: the batch writes these keys, a widget reads one back. They
    // are the same function now, so this is pinning the *contract* rather than an implementation.
    const preamble = preambleOf([binding("costs.materials", "20"), binding("costs.total", "costs.materials * 1.2")]);
    const keys = outcomeKeys(false, preamble);

    assert.equal(keys[1], scopeKey(false, "costs.total", null, null, scopeChunksAbove(preamble, "costs.total")));
    assert.notEqual(keys[0], keys[1]);
  });

  it("has no key for an array item, which binds through its list rather than on its own", () => {
    // The known gap: `rates.#` never matches a key the batch wrote, so such a widget stays on the
    // live path. What matters here is that it does not match the *wrong* one.
    const preamble = preambleOf([binding("rates", "[5, 3]"), binding("total", "sum(rates)")]);
    const keys = outcomeKeys(false, preamble);

    assert.equal(keys.includes(scopeKey(false, "rates.#", null, null, scopeChunksAbove(preamble, "rates.#"))), false);
  });

  it("separates the exchange-rate setting and a binding's warning", () => {
    assert.notEqual(scopeKey(true, "a", null, null, []), scopeKey(false, "a", null, null, []));
    assert.notEqual(scopeKey(true, "a", null, null, []), scopeKey(true, "a", null, "a bare 0", []));
    assert.notEqual(scopeKey(true, "a", null, null, []), scopeKey(true, "a", "reserved", null, []));
  });
});

describe("firstStale", () => {
  const note = () => preambleOf([binding("a", "1"), binding("b", "a * 2"), binding("c", "b + 1")]);

  /** Fill the cache as a completed pass would. */
  function fill(preamble: NotePreamble): string[] {
    const keys = outcomeKeys(true, preamble);
    for (const [index, key] of keys.entries()) {
      rememberNoteOutcome(key, preamble.bindings[index].expr, outcomeOf(preamble.bindings[index].key));
    }
    return keys;
  }

  it("is null for a note that is answered from top to bottom", () => {
    const preamble = note();
    assert.equal(firstStale(fill(preamble), preamble.bindings), null);
  });

  it("starts at the edited property, so everything above it is left alone", () => {
    const preamble = note();
    const keys = fill(preamble);

    const edited = note();
    edited.bindings[1] = binding("b", "a * 3");

    assert.equal(firstStale(outcomeKeys(true, edited), edited.bindings), 1);
    // And the entries above it are still there to be read, which is what makes it incremental
    // rather than merely late.
    assert.deepEqual(noteOutcome(keys[0], "1")?.outcome, outcomeOf("a"));
  });

  it("starts at the top when the note has never been evaluated", () => {
    const preamble = note();
    assert.equal(firstStale(outcomeKeys(true, preamble), preamble.bindings), 0);
  });

  it("counts an entry that is merely old as unanswered, so a clock-reading property moves again", () => {
    const preamble = note();
    const keys = fill(preamble);

    assert.equal(firstStale(keys, preamble.bindings, performance.now() + OUTCOME_FRESH_MS + 1), 0);
  });
});

describe("clearPropertyOutcomes", () => {
  it("empties both caches and moves the epoch, so a pass in flight knows to drop what it has", () => {
    rememberNoteOutcome("k", "e", outcomeOf("v"));
    rememberLiveOutcome(liveKey("k", "e"), shown("v"));
    const before = outcomeEpoch();

    clearPropertyOutcomes();

    assert.equal(noteOutcome("k", "e"), null);
    assert.equal(liveOutcome(liveKey("k", "e")), null);
    assert.notEqual(outcomeEpoch(), before);
  });
});

// A driver whose pass and whose coalescing window are both under the test's control: `start()`
// fires the window, `settle()` completes the pass in flight.
function stubDriver() {
  const state = {
    runs: 0,
    starts: 0,
    cancels: 0,
    start: null as (() => void) | null,
    settle: null as (() => void) | null,
  };

  const driver: BatchDriver = {
    run: () => {
      state.runs += 1;
      return new Promise<void>((resolve) => {
        state.settle = () => {
          state.settle = null;
          resolve();
        };
      });
    },
    delay: (start) => {
      state.starts += 1;
      state.start = () => {
        state.start = null;
        start();
      };
      return () => {
        state.cancels += 1;
        state.start = null;
      };
    },
  };

  return { state, driver };
}

/** Let every pending microtask run, so a settled pass reaches its `finally`. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("requestBatch", () => {
  it("collapses a note's widgets into one pass and tells them all", async () => {
    const { state, driver } = stubDriver();
    const told = [0, 0, 0];
    told.forEach((_, index) => requestBatch("v1", driver, () => (told[index] += 1)));

    assert.equal(state.starts, 1, "one coalescing window for the three of them");
    state.start?.();
    assert.equal(state.runs, 1);

    state.settle?.();
    await flush();
    assert.deepEqual(told, [1, 1, 1]);
  });

  // The key is what a pass is about, so an edit landing mid-pass is not something the pass has to
  // notice: it is a second scope, evaluated on its own, and the first pass's answers stay true of
  // the scope they describe.
  it("runs a second pass for the scope an edit moved the note to, and keeps the first", async () => {
    const first = stubDriver();
    const second = stubDriver();
    let told = 0;
    requestBatch("v1", first.driver, () => (told += 1));
    first.state.start?.();

    // The reader committed an edit while the first pass was running.
    requestBatch("v2", second.driver, () => (told += 1));
    second.state.start?.();

    assert.equal(first.state.runs, 1);
    assert.equal(second.state.runs, 1, "the new scope is its own pass, not a re-run of the old one");

    first.state.settle?.();
    second.state.settle?.();
    await flush();
    assert.equal(told, 2);
  });

  it("does not re-run for a request that arrives against the same scope", async () => {
    const { state, driver } = stubDriver();
    requestBatch("v1", driver, () => {});
    state.start?.();
    requestBatch("v1", driver, () => {});

    state.settle?.();
    await flush();
    assert.equal(state.runs, 1);
  });

  // Two surfaces reading one note by different routes — an editor from its buffer, a widget from
  // the metadata cache — agree on the scope while the note is still, and that agreement is the
  // whole mechanism: same key, one evaluation.
  it("shares one pass between two surfaces that derived the same scope", async () => {
    const { state, driver } = stubDriver();
    const told: string[] = [];
    requestBatch("v1", driver, () => told.push("inlay"));
    requestBatch("v1", driver, () => told.push("widget"));

    state.start?.();
    assert.equal(state.runs, 1);

    state.settle?.();
    await flush();
    assert.deepEqual(told, ["inlay", "widget"]);
  });

  it("cancels a pass nobody is waiting for any more", () => {
    const { state, driver } = stubDriver();
    const first = requestBatch("v1", driver, () => {});
    const second = requestBatch("v1", driver, () => {});

    first();
    assert.equal(state.cancels, 0, "the other row still wants it");
    second();
    assert.equal(state.cancels, 1);
    assert.equal(state.runs, 0);
  });

  it("does not tell a row that stopped waiting", async () => {
    const { state, driver } = stubDriver();
    let told = 0;
    const stop = requestBatch("v1", driver, () => (told += 1));
    requestBatch("v1", driver, () => {});
    state.start?.();

    stop();
    state.settle?.();
    await flush();

    assert.equal(told, 0);
  });

  it("starts a fresh pass once the last one is done", async () => {
    const { state, driver } = stubDriver();
    requestBatch("v1", driver, () => {});
    state.start?.();
    state.settle?.();
    await flush();

    requestBatch("v1", driver, () => {});
    assert.equal(state.starts, 2, "a new window rather than joining the finished pass");
    state.start?.();
    assert.equal(state.runs, 2);
  });
});

describe("cancelBatches", () => {
  it("drops a pending pass and everyone waiting on it", () => {
    const { state, driver } = stubDriver();
    let told = 0;
    requestBatch("v1", driver, () => (told += 1));

    cancelBatches();

    assert.equal(state.cancels, 1);
    assert.equal(state.runs, 0);
    assert.equal(told, 0);
  });
});
