// The facts cache: what a synchronous surface can read without an interpreter, what it has to ask
// for, and the rules that decide which of the two an answer is.
//
// Four things here are load-bearing rather than incidental, and each has its own group below. The
// reader is **never** called on the asking tick, because a surface that could be answered inline
// once would come to expect it and then break when the answer moved to another thread. Two asks for
// the same batch are **one** call, because the two triggers and the prewarm all fire on the same
// caret move. A name whose answer can change is cached **conditionally**, because a card showing
// what `now()` said a minute ago is worse than a card that took a moment. And an entry filled for
// one purpose is a **miss** for a wider one, because a completion row's signature is not an answer
// to a card, and treating it as one would show an empty card that never refilled.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  clearFacts,
  ensureFacts,
  ensureHoleType,
  type FactsFill,
  knownFacts,
  knownHoleType,
  scopeCanChange,
  scopeKey,
  type SymbolFacts,
  WANT_CARD,
  WANT_FIELDS,
  WANT_INFO,
  WANT_SIGNATURE,
  WANT_VALUE,
} from "../../../src/interpreter/facts.ts";
import { FACTS_CACHE_ENTRIES, HOLE_CACHE_ENTRIES, IMPURE_FRESH_MS } from "../../../src/tuning.ts";

/** A record distinguishable from every other by its signature. */
function facts(signature: string, fields: readonly string[] | null = null): SymbolFacts {
  return { signature, info: null, valueHtml: null, fields };
}

/** A reader that answers every probe it is given, recording the batches and the purposes it was
 *  asked for. */
function stubReader(impure = false): {
  read: (probes: readonly string[], want: number) => Promise<FactsFill | null>;
  batches: string[][];
  wants: number[];
} {
  const batches: string[][] = [];
  const wants: number[] = [];
  return {
    batches,
    wants,
    read: (probes, want) => {
      batches.push([...probes]);
      wants.push(want);
      return Promise.resolve({
        facts: new Map(probes.map((probe): [string, SymbolFacts] => [probe, facts(`type of ${probe}`)])),
        impure,
      });
    },
  };
}

const SCOPE = scopeKey({ chunks: ["let x = 5"], applyRates: false }, 1);

beforeEach(() => {
  clearFacts();
});

describe("the scope key", () => {
  test("is the same for the same scope in the same interpreter", () => {
    const spec = { chunks: ["let x = 5"], applyRates: true };
    assert.equal(scopeKey(spec, 3), scopeKey({ ...spec }, 3));
  });

  test("moves with the interpreter generation", () => {
    const spec = { chunks: ["let x = 5"], applyRates: true };
    assert.notEqual(scopeKey(spec, 3), scopeKey(spec, 4));
  });

  test("distinguishes the exchange rates being applied", () => {
    const chunks = ["let x = 5"];
    assert.notEqual(scopeKey({ chunks, applyRates: true }, 1), scopeKey({ chunks, applyRates: false }, 1));
  });

  test("distinguishes the prelude file a scope stops before", () => {
    const chunks = ["let x = 5"];
    assert.notEqual(
      scopeKey({ chunks, applyRates: false }, 1),
      scopeKey({ chunks, applyRates: false, preludeBefore: "units.nbt" }, 1),
    );
  });

  test("distinguishes the order the chunks are replayed in", () => {
    assert.notEqual(
      scopeKey({ chunks: ["let x = 1", "let y = 2"], applyRates: false }, 1),
      scopeKey({ chunks: ["let y = 2", "let x = 1"], applyRates: false }, 1),
    );
  });

  test("does not run two chunks together into one", () => {
    // The separator has to be something a document cannot contain, or two chunks that happen to
    // concatenate to a third scope's text would share its answers.
    assert.notEqual(
      scopeKey({ chunks: ["a", "b"], applyRates: false }, 1),
      scopeKey({ chunks: ["ab"], applyRates: false }, 1),
    );
  });
});

describe("reading what is known", () => {
  test("knows nothing before anything is filled", () => {
    assert.equal(knownFacts(SCOPE, "sin", WANT_CARD), undefined);
  });

  test("knows what a fill put there", async () => {
    const reader = stubReader();
    await ensureFacts(SCOPE, ["sin"], WANT_CARD, reader.read);

    assert.deepEqual(knownFacts(SCOPE, "sin", WANT_CARD), facts("type of sin"));
  });

  test("keeps each scope's answers apart", async () => {
    const other = scopeKey({ chunks: ["let x = 6"], applyRates: false }, 1);
    await ensureFacts(SCOPE, ["x"], WANT_CARD, stubReader().read);

    assert.notEqual(knownFacts(SCOPE, "x", WANT_CARD), undefined);
    assert.equal(knownFacts(other, "x", WANT_CARD), undefined);
  });

  test("cannot have one scope's answer read as another's", async () => {
    // The probe and the scope key are joined into one string, so the separator has to be something
    // a probe cannot contain. With an ordinary character it could: name `b` in scope `x y` and name
    // `b x` in scope `y` both spell `b x y`, and each would then answer for the other.
    await ensureFacts("x y", ["b"], WANT_CARD, stubReader().read);

    assert.notEqual(knownFacts("x y", "b", WANT_CARD), undefined);
    assert.equal(knownFacts("y", "b x", WANT_CARD), undefined);
  });

  test("forgets everything when it is cleared", async () => {
    await ensureFacts(SCOPE, ["sin"], WANT_CARD, stubReader().read);
    clearFacts();

    assert.equal(knownFacts(SCOPE, "sin", WANT_CARD), undefined);
  });
});

describe("what a lookup is for", () => {
  test("tells the reader what to fill", async () => {
    const reader = stubReader();
    await ensureFacts(SCOPE, ["sin"], WANT_SIGNATURE, reader.read);

    assert.deepEqual(reader.wants, [WANT_SIGNATURE]);
  });

  test("a row's signature is no answer to a card", async () => {
    await ensureFacts(SCOPE, ["sin"], WANT_SIGNATURE, stubReader().read);

    assert.notEqual(knownFacts(SCOPE, "sin", WANT_SIGNATURE), undefined);
    assert.equal(knownFacts(SCOPE, "sin", WANT_CARD), undefined, "a card wants more than was filled");
  });

  test("a card's answer serves a row that wants less of it", async () => {
    const reader = stubReader();
    await ensureFacts(SCOPE, ["sin"], WANT_CARD, reader.read);
    await ensureFacts(SCOPE, ["sin"], WANT_SIGNATURE, reader.read);

    assert.notEqual(knownFacts(SCOPE, "sin", WANT_SIGNATURE), undefined);
    assert.equal(reader.batches.length, 1, "the wider fill already answered this");
  });

  test("asks again for a name known only for a narrower purpose", async () => {
    const reader = stubReader();
    await ensureFacts(SCOPE, ["sin"], WANT_SIGNATURE, reader.read);
    await ensureFacts(SCOPE, ["sin"], WANT_CARD, reader.read);

    assert.deepEqual(reader.batches, [["sin"], ["sin"]]);
    assert.deepEqual(reader.wants, [WANT_SIGNATURE, WANT_CARD]);
  });

  test("two purposes asked for at once are two requests, not one shared", async () => {
    const reader = stubReader();
    const row = ensureFacts(SCOPE, ["sin"], WANT_SIGNATURE, reader.read);
    const card = ensureFacts(SCOPE, ["sin"], WANT_CARD, reader.read);

    assert.notEqual(row, card, "coalescing these would answer the card with the row's record");
    await Promise.all([row, card]);
  });

  test("a later fill replaces what an earlier one left, rather than merging", async () => {
    // Deliberate: merging would carry a fact filled a minute ago forward under a fresh timestamp,
    // which for a name that reads the clock is the one thing the freshness rule exists to stop.
    await ensureFacts(SCOPE, ["sin"], WANT_SIGNATURE, stubReader().read);
    await ensureFacts(SCOPE, ["sin"], WANT_INFO, stubReader().read);

    assert.notEqual(knownFacts(SCOPE, "sin", WANT_INFO), undefined);
    assert.equal(knownFacts(SCOPE, "sin", WANT_SIGNATURE), undefined, "the narrower fill is gone");
  });

  test("carries a struct's fields like any other fact", async () => {
    await ensureFacts(SCOPE, ["costs"], WANT_FIELDS, (probes) =>
      Promise.resolve({
        facts: new Map(probes.map((probe): [string, SymbolFacts] => [probe, facts("", ["total", "vat"])])),
        impure: false,
      }));

    assert.deepEqual(knownFacts(SCOPE, "costs", WANT_FIELDS)?.fields, ["total", "vat"]);
  });

  test("a card wants the three facts a card is built from", () => {
    assert.equal(WANT_CARD, WANT_SIGNATURE | WANT_INFO | WANT_VALUE);
    assert.equal(WANT_CARD & WANT_FIELDS, 0, "fields are member completion's, not a card's");
  });
});

describe("asking", () => {
  test("never answers on the asking tick", () => {
    const reader = stubReader();
    void ensureFacts(SCOPE, ["sin"], WANT_CARD, reader.read);

    // Not "has not resolved" — the reader has not even been *called*. A synchronous reader would
    // otherwise answer inline here, which is exactly the shape this module exists to rule out.
    assert.deepEqual(reader.batches, []);
    assert.equal(knownFacts(SCOPE, "sin", WANT_CARD), undefined);
  });

  test("asks only for the names it does not have", async () => {
    const reader = stubReader();
    await ensureFacts(SCOPE, ["sin"], WANT_CARD, reader.read);
    await ensureFacts(SCOPE, ["sin", "cos"], WANT_CARD, reader.read);

    assert.deepEqual(reader.batches, [["sin"], ["cos"]]);
  });

  test("does not ask at all when everything is known", async () => {
    const reader = stubReader();
    await ensureFacts(SCOPE, ["sin", "cos"], WANT_CARD, reader.read);
    await ensureFacts(SCOPE, ["cos", "sin"], WANT_CARD, reader.read);

    assert.equal(reader.batches.length, 1);
  });

  test("asks once for two askers wanting the same batch", async () => {
    const reader = stubReader();
    const first = ensureFacts(SCOPE, ["sin"], WANT_CARD, reader.read);
    const second = ensureFacts(SCOPE, ["sin"], WANT_CARD, reader.read);

    assert.equal(first, second, "the second asker should be handed the first ask");
    await Promise.all([first, second]);
    assert.deepEqual(reader.batches, [["sin"]]);
  });

  test("asks for the same batch again once the first ask is over", async () => {
    // Only *concurrent* asks share. An answer that did not arrive must be askable for again, or a
    // failed lookup would be remembered as a permanent absence.
    const reader = {
      batches: [] as string[][],
      read: (probes: readonly string[]) => {
        reader.batches.push([...probes]);
        return Promise.resolve(null);
      },
    };

    await ensureFacts(SCOPE, ["sin"], WANT_CARD, reader.read);
    await ensureFacts(SCOPE, ["sin"], WANT_CARD, reader.read);

    assert.deepEqual(reader.batches, [["sin"], ["sin"]]);
  });

  test("caches nothing when the reader cannot answer", async () => {
    await ensureFacts(SCOPE, ["sin"], WANT_CARD, () => Promise.resolve(null));
    assert.equal(knownFacts(SCOPE, "sin", WANT_CARD), undefined);
  });

  test("leaves a name the reader skipped unknown", async () => {
    await ensureFacts(
      SCOPE,
      ["sin", "cos"],
      WANT_CARD,
      () => Promise.resolve({ facts: new Map([["sin", facts("Fn")]]), impure: false }),
    );

    assert.notEqual(knownFacts(SCOPE, "sin", WANT_CARD), undefined);
    assert.equal(knownFacts(SCOPE, "cos", WANT_CARD), undefined);
  });

  test("settles when the reader throws, and can be asked again", async () => {
    let calls = 0;
    const throwing = () => {
      calls += 1;
      throw new Error("the context went away");
    };

    await ensureFacts(SCOPE, ["sin"], WANT_CARD, throwing);
    await ensureFacts(SCOPE, ["sin"], WANT_CARD, throwing);

    assert.equal(calls, 2, "a throw must not leave the ask stuck in flight");
    assert.equal(knownFacts(SCOPE, "sin", WANT_CARD), undefined);
  });
});

describe("answers that can change", () => {
  // The clock is read *after* the fill throughout: an entry is stamped when it is written, so a
  // reading taken before that is a window one fill's duration short of the one under test.
  test("a pure answer in a pure scope is kept indefinitely", async () => {
    await ensureFacts(SCOPE, ["sin"], WANT_CARD, stubReader().read);
    const at = performance.now();

    assert.notEqual(knownFacts(SCOPE, "sin", WANT_CARD, at + IMPURE_FRESH_MS * 100), undefined);
  });

  test("an answer from a scope that reads the clock is asked for again", async () => {
    await ensureFacts(SCOPE, ["elapsed"], WANT_CARD, stubReader(true).read);
    const at = performance.now();

    assert.notEqual(knownFacts(SCOPE, "elapsed", WANT_CARD, at), undefined);
    assert.equal(knownFacts(SCOPE, "elapsed", WANT_CARD, at + IMPURE_FRESH_MS + 1), undefined);
  });

  test("a name that reads the clock is asked for again, whatever its scope", async () => {
    // The scope may never mention `now` — hovering the prelude's own name still reads the clock.
    await ensureFacts(SCOPE, ["now()"], WANT_CARD, stubReader().read);
    const at = performance.now();

    assert.equal(knownFacts(SCOPE, "now()", WANT_CARD, at + IMPURE_FRESH_MS + 1), undefined);
  });

  test("a scope reads the clock when any of its chunks does", () => {
    assert.equal(scopeCanChange({ chunks: ["let x = 5"], applyRates: false }, false), false);
    assert.equal(scopeCanChange({ chunks: ["let x = 5", "let t = now()"], applyRates: false }, false), true);
  });

  test("a scope reads the clock when the user prelude does", () => {
    assert.equal(scopeCanChange({ chunks: ["let x = 5"], applyRates: false }, true), true);
  });
});

describe("bounds", () => {
  test("keeps at most its share of names", async () => {
    const probes = Array.from({ length: FACTS_CACHE_ENTRIES + 8 }, (_, n) => `name${String(n)}`);
    await ensureFacts(SCOPE, probes, WANT_CARD, stubReader().read);

    assert.equal(knownFacts(SCOPE, "name0", WANT_CARD), undefined, "the oldest should have been evicted");
    assert.notEqual(knownFacts(SCOPE, probes[probes.length - 1], WANT_CARD), undefined);
  });
});

describe("the hole type", () => {
  /** A reader that types every hole as `Length`, recording what it was asked about. */
  function stubHoles(
    type: string | null = "Length",
  ): { read: (input: string) => Promise<{ type: string | null; } | null>; asked: string[]; } {
    const asked: string[] = [];
    return {
      asked,
      read: (input) => {
        asked.push(input);
        return Promise.resolve({ type });
      },
    };
  }

  test("knows nothing before anything is filled", () => {
    assert.equal(knownHoleType(SCOPE, "12 km /"), undefined);
  });

  test("knows what a fill put there", async () => {
    await ensureHoleType(SCOPE, "12 km /", stubHoles().read);
    assert.equal(knownHoleType(SCOPE, "12 km /"), "Length");
  });

  test("tells having no type apart from not having been asked", async () => {
    // The two call for opposite things in the decoration builder that reads this — paint nothing
    // and stop, versus paint nothing and ask — so `null` has to be cached rather than skipped.
    await ensureHoleType(SCOPE, "wat +", stubHoles(null).read);

    assert.equal(knownHoleType(SCOPE, "wat +"), null);
    assert.equal(knownHoleType(SCOPE, "never asked +"), undefined);
  });

  test("never answers on the asking tick", () => {
    const reader = stubHoles();
    void ensureHoleType(SCOPE, "12 km /", reader.read);

    assert.deepEqual(reader.asked, []);
    assert.equal(knownHoleType(SCOPE, "12 km /"), undefined);
  });

  test("does not evaluate again for something already known", async () => {
    const reader = stubHoles();
    await ensureHoleType(SCOPE, "12 km /", reader.read);
    await ensureHoleType(SCOPE, "12 km /", reader.read);

    assert.deepEqual(reader.asked, ["12 km /"]);
  });

  test("does not evaluate again for something known to have no type", async () => {
    const reader = stubHoles(null);
    await ensureHoleType(SCOPE, "wat +", reader.read);
    await ensureHoleType(SCOPE, "wat +", reader.read);

    assert.equal(reader.asked.length, 1, "a cached null is an answer, not an absence");
  });

  test("evaluates once for two askers", async () => {
    const reader = stubHoles();
    const first = ensureHoleType(SCOPE, "12 km /", reader.read);
    const second = ensureHoleType(SCOPE, "12 km /", reader.read);

    assert.equal(first, second);
    await Promise.all([first, second]);
    assert.deepEqual(reader.asked, ["12 km /"]);
  });

  test("caches nothing when the reader cannot answer, and can be asked again", async () => {
    let calls = 0;
    const silent = () => {
      calls += 1;
      return Promise.resolve(null);
    };

    await ensureHoleType(SCOPE, "12 km /", silent);
    assert.equal(knownHoleType(SCOPE, "12 km /"), undefined);

    await ensureHoleType(SCOPE, "12 km /", silent);
    assert.equal(calls, 2);
  });

  test("settles when the reader throws, and can be asked again", async () => {
    let calls = 0;
    const throwing = () => {
      calls += 1;
      throw new Error("the context went away");
    };

    await ensureHoleType(SCOPE, "12 km /", throwing);
    await ensureHoleType(SCOPE, "12 km /", throwing);

    assert.equal(calls, 2, "a throw must not leave the ask stuck in flight");
  });

  test("keeps each scope's answers apart", async () => {
    const other = scopeKey({ chunks: ["let x = 6"], applyRates: false }, 1);
    await ensureHoleType(SCOPE, "x +", stubHoles().read);

    assert.equal(knownHoleType(SCOPE, "x +"), "Length");
    assert.equal(knownHoleType(other, "x +"), undefined);
  });

  test("is forgotten when the caches are cleared", async () => {
    await ensureHoleType(SCOPE, "12 km /", stubHoles().read);
    clearFacts();

    assert.equal(knownHoleType(SCOPE, "12 km /"), undefined);
  });

  test("keeps at most its share of inputs", async () => {
    for (let n = 0; n < HOLE_CACHE_ENTRIES + 4; n += 1) {
      await ensureHoleType(SCOPE, `${String(n)} +`, stubHoles().read);
    }

    assert.equal(knownHoleType(SCOPE, "0 +"), undefined, "the oldest should have been evicted");
    assert.equal(knownHoleType(SCOPE, `${String(HOLE_CACHE_ENTRIES + 3)} +`), "Length");
  });

  test("is not aged, whatever the scope", async () => {
    // A hole form is a type error before execution, so what it reports cannot depend on the clock.
    await ensureHoleType(SCOPE, "12 km /", stubHoles().read);
    const at = performance.now();

    assert.equal(knownHoleType(SCOPE, "12 km /", at + IMPURE_FRESH_MS * 100), "Length");
  });
});
