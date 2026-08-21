// The refusal ledger: who is held out, for how long, and what each of them is shown.
//
// A file of its own because the module is one: the arm is spent where the interpreter is and the
// ledger is read where the surfaces are, which after the move are two threads. The clock is passed
// in throughout, so none of this needs an interpreter, a timer, or a note.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { EVALUATION_LIMIT_RESULT, releaseNote } from "../../../src/interpreter/budget.ts";
import {
  clearRefusals,
  describeLimit,
  EVALUATION_STOPPED_RESULT,
  forgetRefusal,
  refusalResult,
  refusedRecently,
  rememberRefusal,
  rememberStop,
  shouldAnnounceLimit,
} from "../../../src/interpreter/refusals.ts";
import { EVALUATION_LIMIT_NOTICE_MS, OVER_BUDGET_COOLDOWN_MS, REFUSAL_LEDGER_ENTRIES } from "../../../src/tuning.ts";

beforeEach(() => {
  clearRefusals();
});

describe("the refusal ledger", () => {
  // The stamp is the interpreter generation; 7 is an arbitrary one.
  const GEN = 7;

  it("holds a note out for the cool-down and no longer", () => {
    rememberRefusal("note.md", GEN, 0);

    assert.equal(refusedRecently("note.md", GEN, 0), true);
    assert.equal(refusedRecently("note.md", GEN, OVER_BUDGET_COOLDOWN_MS), true);
    assert.equal(refusedRecently("note.md", GEN, OVER_BUDGET_COOLDOWN_MS + 1), false);
  });

  it("says nothing about a note that never ran out of time", () => {
    rememberRefusal("note.md", GEN, 0);
    assert.equal(refusedRecently("other.md", GEN, 0), false);
  });

  // What a prelude edit, an exchange-rate refresh or a settings change buys: the expression may
  // mean something else now, so last time's verdict is not evidence about this time.
  it("says nothing under a different interpreter, however recent", () => {
    rememberRefusal("note.md", GEN, 0);
    assert.equal(refusedRecently("note.md", GEN + 1, 0), false);
    assert.equal(refusedRecently("note.md", GEN, 0), true, "and the entry is not destroyed by asking");
  });

  // The route back for a reader who fixes the expression that would not finish: the edit is not a
  // new interpreter, so only this can lift the cool-down.
  it("lets a note back in as soon as it changes", () => {
    rememberRefusal("note.md", GEN, 0);
    forgetRefusal("note.md");
    assert.equal(refusedRecently("note.md", GEN, 0), false);
  });

  // The split this module exists for, stated as a test. A refill has two halves and they are on two
  // threads: posting only the far one is what left a note the reader had just fixed still saying it
  // had run out of time, for the whole cool-down, on every worker-path vault.
  it("is not reached by the half of a refill that crosses the boundary", () => {
    rememberRefusal("note.md", GEN, 0);
    releaseNote("note.md");

    assert.equal(refusedRecently("note.md", GEN, 0), true, "the bucket is the other half");
    forgetRefusal("note.md");
    assert.equal(refusedRecently("note.md", GEN, 0), false);
  });

  it("forgets everything when the caches are cleared", () => {
    rememberRefusal("note.md", GEN, 0);
    clearRefusals();
    assert.equal(refusedRecently("note.md", GEN, 0), false);
  });

  // Two ways into a cool-down, one ledger, and two sentences: "time limit reached" names a setting
  // the reader did not trip and would send them to Runtime to raise a number that was never the
  // problem. The surfaces read the result rather than deciding it, so this is where the difference
  // actually lives.
  it("remembers which of the two refusals a note got", () => {
    rememberRefusal("timed-out.md", GEN, 0);
    rememberStop("stopped.md", GEN, 0);

    assert.equal(refusalResult("timed-out.md", GEN, 0), EVALUATION_LIMIT_RESULT);
    assert.equal(refusalResult("stopped.md", GEN, 0), EVALUATION_STOPPED_RESULT);
  });

  it("has nothing to paint for a note that may be tried", () => {
    rememberStop("note.md", GEN, 0);

    assert.equal(refusalResult("other.md", GEN, 0), null, "a note that was never refused");
    assert.equal(refusalResult("note.md", GEN + 1, 0), null, "a different interpreter");
    assert.equal(refusalResult("note.md", GEN, OVER_BUDGET_COOLDOWN_MS + 1), null, "past the cool-down");
  });

  // A stop is filed in the same ledger for the same reason a refusal is: without an entry, the
  // render that was hanging re-fires the moment the interpreter is back.
  it("holds a stopped note out on the same terms as one that ran out of time", () => {
    rememberStop("note.md", GEN, 0);

    assert.equal(refusedRecently("note.md", GEN, OVER_BUDGET_COOLDOWN_MS), true);
    assert.equal(refusedRecently("note.md", GEN, OVER_BUDGET_COOLDOWN_MS + 1), false);

    forgetRefusal("note.md");
    assert.equal(refusedRecently("note.md", GEN, 0), false, "and an edit lifts it as it lifts the other");
  });

  it("evicts the oldest refusal past the cap", () => {
    for (let i = 0; i <= REFUSAL_LEDGER_ENTRIES; i += 1) {
      rememberRefusal(`note-${i}.md`, GEN, 0);
    }

    assert.equal(refusedRecently("note-0.md", GEN, 0), false, "the oldest went");
    assert.equal(refusedRecently(`note-${REFUSAL_LEDGER_ENTRIES}.md`, GEN, 0), true, "the newest stands");
  });
});

describe("telling the reader", () => {
  it("says how long the limit was the way a sentence needs it", () => {
    assert.equal(describeLimit(10_000), "10 s", "not 10.0");
    assert.equal(describeLimit(2_500), "2.5 s");
    assert.equal(describeLimit(1_000), "1 s");
    assert.equal(describeLimit(999), "999 ms", "below a second, milliseconds are what the reader set");
    assert.equal(describeLimit(1_234), "1.2 s");
  });

  // The whole point: a reading-view render trips the limit once per *block*, so without this a note
  // of two hundred fences would stack two hundred identical toasts on top of the stall.
  it("announces once a window however many times it is asked", () => {
    assert.equal(shouldAnnounceLimit(0), true);

    for (let i = 1; i < 200; i += 1) {
      assert.equal(shouldAnnounceLimit(i), false);
    }

    assert.equal(shouldAnnounceLimit(EVALUATION_LIMIT_NOTICE_MS - 1), false, "still inside the window");
    assert.equal(shouldAnnounceLimit(EVALUATION_LIMIT_NOTICE_MS), true, "and open again at the edge");
  });

  it("starts announcing again once the caches are cleared", () => {
    assert.equal(shouldAnnounceLimit(0), true);
    assert.equal(shouldAnnounceLimit(1), false);

    clearRefusals();
    assert.equal(shouldAnnounceLimit(2), true, "a reader who asked for a reset is owed the answer again");
  });
});
