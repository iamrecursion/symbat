// The shared evaluation cache: what counts as a hit, what stops counting as a fresh one, and the
// eviction the five surfaces used to each own a copy of.
//
// The distinction under test throughout is hit-but-stale versus miss. They are the same thing to a
// surface that re-evaluates synchronously and very different to one that paints first and schedules
// after: a miss has nothing to show, a stale hit has last second's answer. Collapsing the two is
// what would make an editor with `now()` in it flicker every ten seconds.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EvaluationCache } from "../../../src/interpreter/eval-cache.ts";
import { IMPURE_FRESH_MS } from "../../../src/tuning.ts";

describe("hits and misses", () => {
  test("returns null for a key it was never given", () => {
    const cache = new EvaluationCache<string>(4);
    assert.equal(cache.get("absent"), null);
    assert.equal(cache.hasFresh("absent"), false);
  });

  test("returns what it was given", () => {
    const cache = new EvaluationCache<string>(4);
    cache.set("k", "answer", false);
    assert.deepEqual(cache.get("k"), { value: "answer", fresh: true });
  });

  test("replaces the value under a key it already holds", () => {
    const cache = new EvaluationCache<string>(4);
    cache.set("k", "first", false);
    cache.set("k", "second", false);

    assert.equal(cache.get("k")?.value, "second");
    assert.equal(cache.size, 1);
  });
});

describe("freshness", () => {
  test("a pure entry never goes stale", () => {
    const cache = new EvaluationCache<string>(4);
    const at = performance.now();
    cache.set("k", "4 m", false);

    assert.equal(cache.get("k", at + IMPURE_FRESH_MS + 1)?.fresh, true);
    assert.equal(cache.get("k", at + IMPURE_FRESH_MS * 1000)?.fresh, true);
  });

  test("an impure entry goes stale once it is older than the window", () => {
    const cache = new EvaluationCache<string>(4);
    const at = performance.now();
    cache.set("k", "12:04", true);

    assert.equal(cache.get("k", at + IMPURE_FRESH_MS - 1)?.fresh, true);
    assert.equal(cache.get("k", at + IMPURE_FRESH_MS + 1)?.fresh, false);
  });

  // The flicker case. A surface that treated stale as absent would paint nothing for the length of
  // a standard-library load, every ten seconds, on any note containing `now()`.
  test("a stale entry is still a hit, carrying the value it always did", () => {
    const cache = new EvaluationCache<string>(4);
    const at = performance.now();
    cache.set("k", "12:04", true);

    const stale = cache.get("k", at + IMPURE_FRESH_MS + 1);
    assert.equal(stale?.value, "12:04");
    assert.equal(stale?.fresh, false);
  });

  test("judges each entry by its own scope", () => {
    const cache = new EvaluationCache<string>(4);
    const at = performance.now();
    cache.set("clock", "12:04", true);
    cache.set("sum", "4 m", false);

    const later = at + IMPURE_FRESH_MS + 1;
    assert.equal(cache.get("clock", later)?.fresh, false);
    assert.equal(cache.get("sum", later)?.fresh, true);
  });

  test("re-answering an entry restarts its window", () => {
    const cache = new EvaluationCache<string>(4);
    const at = performance.now();
    cache.set("k", "12:04", true);
    assert.equal(cache.get("k", at + IMPURE_FRESH_MS + 1)?.fresh, false);

    cache.set("k", "12:05", true);
    assert.equal(cache.get("k", performance.now() + IMPURE_FRESH_MS - 1)?.fresh, true);
  });
});

describe("hasFresh", () => {
  // Why it is not a presence test: a pass runs *because* something went stale, so a pass that
  // skipped every key it already held would skip the work it was scheduled for.
  test("is false for a stale entry, so the pass that was scheduled for it does the work", () => {
    const cache = new EvaluationCache<string>(4);
    const at = performance.now();
    cache.set("k", "12:04", true);

    assert.equal(cache.hasFresh("k", at + IMPURE_FRESH_MS - 1), true);
    assert.equal(cache.hasFresh("k", at + IMPURE_FRESH_MS + 1), false);
  });

  // And why it is not simply `false`: within one pass the same scope can be asked for twice, and
  // the second ask must find the first one's answer rather than build a second context for it.
  test("is true for an entry this pass just wrote", () => {
    const cache = new EvaluationCache<string>(4);
    cache.set("k", "12:04", true);
    assert.equal(cache.hasFresh("k"), true);
  });
});

describe("freeze", () => {
  // What a pass cannot know while it writes: whether it is about to run out of the note's
  // evaluation allowance. Without this, a note that both reads `now()` and exceeds the limit spends
  // the whole limit again every window, forever, to be told the same thing.
  test("stops an entry aging, after the fact", () => {
    const cache = new EvaluationCache<string>(4);
    const at = performance.now();
    cache.set("k", "12:04", true);
    assert.equal(cache.get("k", at + IMPURE_FRESH_MS + 1)?.fresh, false);

    cache.freeze(["k"]);
    assert.equal(cache.get("k", at + IMPURE_FRESH_MS + 1)?.fresh, true);
    assert.equal(cache.get("k", at + IMPURE_FRESH_MS * 1000)?.fresh, true);
  });

  test("leaves the value and the other entries alone", () => {
    const cache = new EvaluationCache<string>(4);
    const at = performance.now();
    cache.set("frozen", "12:04", true);
    cache.set("other", "12:05", true);

    cache.freeze(["frozen"]);
    assert.equal(cache.get("frozen")?.value, "12:04");
    assert.equal(cache.get("other", at + IMPURE_FRESH_MS + 1)?.fresh, false);
  });

  test("ignores a key it never held, since a cut-off pass may not have written one", () => {
    const cache = new EvaluationCache<string>(4);
    cache.freeze(["never", "written"]);
    assert.equal(cache.size, 0);
  });

  // Re-answering is what an edit produces, and an edit is the one thing that *can* change the
  // answer — so a later write must not inherit the frozen entry's refusal to age.
  test("does not survive the entry being written again", () => {
    const cache = new EvaluationCache<string>(4);
    cache.set("k", "12:04", true);
    cache.freeze(["k"]);

    cache.set("k", "12:05", true);
    assert.equal(cache.get("k", performance.now() + IMPURE_FRESH_MS + 1)?.fresh, false);
  });
});

describe("eviction", () => {
  test("keeps the cap and drops the oldest written", () => {
    const cache = new EvaluationCache<number>(3);
    for (let i = 0; i < 5; i += 1) {
      cache.set(`k${i}`, i, false);
    }

    assert.equal(cache.size, 3);
    assert.equal(cache.get("k0"), null);
    assert.equal(cache.get("k1"), null);
    assert.equal(cache.get("k2")?.value, 2);
    assert.equal(cache.get("k4")?.value, 4);
  });

  test("reading does not save an entry from eviction", () => {
    // Deliberate, and the difference from the property outcome cache: these keys move with the
    // note's own text, so an entry nobody asks for again is usually one whose note was edited.
    const cache = new EvaluationCache<number>(2);
    cache.set("a", 1, false);
    cache.set("b", 2, false);
    cache.get("a");
    cache.set("c", 3, false);

    assert.equal(cache.get("a"), null);
    assert.equal(cache.get("b")?.value, 2);
  });

  test("re-answering a held key does not grow the cache past its cap", () => {
    const cache = new EvaluationCache<number>(2);
    cache.set("a", 1, false);
    cache.set("a", 2, false);
    cache.set("b", 3, false);

    assert.equal(cache.size, 2);
    assert.equal(cache.get("a")?.value, 2);
  });

  test("re-answering a held key moves it to the back of the eviction order", () => {
    // The impure path is the one that writes the same key twice on purpose: an entry that reads the
    // clock is re-evaluated and re-filed under exactly the same key every freshness window, for as
    // long as the reader keeps looking at it. `Map.set` alone leaves such an entry where it first
    // landed, so the entry being kept current is the one evicted first.
    const cache = new EvaluationCache<number>(2);
    cache.set("a", 1, true);
    cache.set("b", 2, false);
    cache.set("a", 3, true); // re-answered, so `b` is now the older write
    cache.set("c", 4, false);

    assert.equal(cache.get("a")?.value, 3, "the re-answered entry was evicted while it was in use");
    assert.equal(cache.get("b"), null);
    assert.equal(cache.get("c")?.value, 4);
  });
});
