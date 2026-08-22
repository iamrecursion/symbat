// The evaluation limit's arithmetic: when work is refused, when a note's allowance carries over,
// and when it starts again. The clock is injected throughout, so none of this needs an interpreter,
// a timer, or a note.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  clearNoteBudgets,
  outOfBudget,
  releaseNote,
  suspendBudget,
  withBudget,
  withBudgetAsync,
} from "../../../src/interpreter/budget.ts";
import { BUDGET_BUCKET_ENTRIES, BUDGET_REFILL_IDLE_MS } from "../../../src/tuning.ts";

/**
 * A clock the test moves by hand, counting how often it was read — the second is what makes "an
 * unarmed budget reads no clock" an assertion rather than a claim.
 */
function stubClock() {
  const state = { t: 0, reads: 0 };
  const clock = () => {
    state.reads += 1;
    return state.t;
  };
  return { state, clock };
}

/** Stands in for a call into the interpreter: counts only the calls a budget would have allowed. */
function probe() {
  const state = { calls: 0 };
  const run = () => {
    if (outOfBudget()) {
      return;
    }
    state.calls += 1;
  };
  return { state, run };
}

beforeEach(() => {
  clearNoteBudgets();
});

describe("outOfBudget", () => {
  it("answers false with nothing armed, without reading a clock", () => {
    const { state, clock } = stubClock();

    // Armed and disarmed, so the clock this test can see is the one a leaked arm would still hold.
    withBudget(100, () => {}, { clock });
    const before = state.reads;

    for (let i = 0; i < 10; i += 1) {
      assert.equal(outOfBudget(), false);
    }

    assert.equal(state.reads, before, "an unarmed check must not reach the clock at all");
  });

  it("refuses once the deadline has passed, and not before", () => {
    const { state, clock } = stubClock();
    const seen: boolean[] = [];

    withBudget(100, () => {
      seen.push(outOfBudget());
      state.t = 99;
      seen.push(outOfBudget());
      state.t = 100;
      seen.push(outOfBudget());
    }, { clock });

    assert.deepEqual(seen, [false, false, true]);
  });
});

describe("withBudget", () => {
  it("runs the task unbudgeted when the limit is off", () => {
    const { state, clock } = stubClock();
    let ran = false;

    const result = withBudget(0, () => {
      ran = true;
      state.t = 10 ** 9;
      return outOfBudget();
    }, { clock });

    assert.equal(ran, true);
    assert.equal(result.value, false, "nothing is armed, so nothing can be refused");
    assert.equal(result.exceeded, false);
  });

  // The distinction the whole caching story rests on: work that merely finished late is complete
  // and may be filed, while work that was turned away is missing whatever came after.
  it("reports a task that overran but was never refused as complete", () => {
    const { state, clock } = stubClock();

    const result = withBudget(100, () => {
      state.t = 5_000;
      return "done";
    }, { clock });

    assert.equal(result.value, "done");
    assert.equal(result.exceeded, false);
  });

  it("reports a task that was refused as cut short", () => {
    const { state, clock } = stubClock();

    const result = withBudget(100, () => {
      state.t = 5_000;
      return outOfBudget();
    }, { clock });

    assert.equal(result.value, true);
    assert.equal(result.exceeded, true);
  });

  it("takes the earlier deadline when nested, whichever side it is on", () => {
    const { state, clock } = stubClock();

    // The inner budget is enormous; it must not buy itself past the outer one.
    const outer = withBudget(100, () => {
      const inner = withBudget(10 ** 6, () => {
        state.t = 150;
        return outOfBudget();
      }, { clock });
      return inner.value;
    }, { clock });

    assert.equal(outer.value, true, "the inner work is refused at the outer deadline");
    assert.equal(outer.exceeded, true, "and the refusal is the outer work's too");

    state.t = 0;
    const other = withBudget(10 ** 6, () => {
      const inner = withBudget(50, () => {
        state.t = 60;
        return outOfBudget();
      }, { clock });
      return { inner: inner.value, exceeded: inner.exceeded };
    }, { clock });

    assert.deepEqual(other.value, { inner: true, exceeded: true }, "the inner deadline binds too");
  });

  it("restores the outer arm when the task throws, and lets the throw through", () => {
    const { state, clock } = stubClock();
    const boom = new Error("boom");

    assert.throws(
      () =>
        withBudget(100, () => {
          withBudget(50, () => {
            throw boom;
          }, { clock });
        }, { clock }),
      /boom/,
    );

    state.t = 10;
    assert.equal(outOfBudget(), false, "no arm may survive the unwind");
  });

  it("says so when handed an asynchronous task, and still returns", () => {
    const { clock } = stubClock();
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args[0]);

    try {
      const result = withBudget(100, () => Promise.resolve(1), { clock });
      assert.equal(result.value instanceof Promise, true);
      assert.equal(errors.length, 1);
      assert.match(String(errors[0]), /asynchronous task/);
    } finally {
      console.error = original;
    }
  });
});

describe("one allowance per note", () => {
  // Reading view renders a note one code block at a time, each an independent call. This is the
  // case a per-task budget would not bound at all.
  it("spends one allowance across the separate calls of one burst", () => {
    const { state, clock } = stubClock();
    const first = probe();
    const second = probe();
    const third = probe();

    withBudget(100, () => {
      first.run();
      state.t += 60;
    }, { key: "note.md", clock });

    withBudget(100, () => {
      second.run();
      state.t += 60;
    }, { key: "note.md", clock });

    const last = withBudget(100, () => {
      third.run();
    }, { key: "note.md", clock });

    assert.equal(first.state.calls, 1);
    assert.equal(second.state.calls, 1, "still inside the allowance when this one started");
    assert.equal(third.state.calls, 0, "the note's allowance was gone before this one built anything");
    assert.equal(last.exceeded, true);
  });

  it("keeps notes apart", () => {
    const { state, clock } = stubClock();
    const other = probe();

    withBudget(100, () => {
      state.t += 500;
    }, { key: "spent.md", clock });

    withBudget(100, () => other.run(), { key: "fresh.md", clock });

    assert.equal(other.state.calls, 1);
  });

  it("starts a new allowance once the burst is over", () => {
    const { state, clock } = stubClock();
    const later = probe();

    withBudget(100, () => {
      state.t += 500;
    }, { key: "note.md", clock });

    state.t += BUDGET_REFILL_IDLE_MS + 1;
    const result = withBudget(100, () => later.run(), { key: "note.md", clock });

    assert.equal(later.state.calls, 1);
    assert.equal(result.exceeded, false);
  });

  it("gives a note its whole allowance back when it changes", () => {
    const { state, clock } = stubClock();
    const after = probe();

    withBudget(100, () => {
      state.t += 500;
    }, { key: "note.md", clock });

    releaseNote("note.md");
    withBudget(100, () => after.run(), { key: "note.md", clock });

    assert.equal(after.state.calls, 1);
  });

  it("evicts the oldest allowance past the cap", () => {
    const { state, clock } = stubClock();
    const revisited = probe();

    // Every one of these spends its whole allowance, so a surviving entry refuses on sight.
    for (let i = 0; i <= BUDGET_BUCKET_ENTRIES; i += 1) {
      withBudget(100, () => {
        state.t += 500;
      }, { key: `note-${i}.md`, clock });
    }

    withBudget(100, () => revisited.run(), { key: "note-0.md", clock });
    assert.equal(revisited.state.calls, 1, "the oldest entry went, so the note is tried again");

    const stillHeld = probe();
    withBudget(100, () => stillHeld.run(), { key: `note-${BUDGET_BUCKET_ENTRIES}.md`, clock });
    assert.equal(stillHeld.state.calls, 0, "the newest entry is still holding its note out");
  });

  it("forgets every allowance when the caches are cleared", () => {
    const { state, clock } = stubClock();
    const after = probe();

    withBudget(100, () => {
      state.t += 500;
    }, { key: "note.md", clock });

    clearNoteBudgets();
    withBudget(100, () => after.run(), { key: "note.md", clock });

    assert.equal(after.state.calls, 1);
  });
});

// Yielding under a budget: the two things that have to hold for withBudgetAsync to be anything
// other than the mistake withBudget's own doc warns about.
describe("standing aside without being charged for it", () => {
  beforeEach(() => {
    clearNoteBudgets();
  });

  it("suspends the deadline, so time spent away is not the note's", () => {
    const { state, clock } = stubClock();
    const { state: calls, run } = probe();

    withBudget(100, () => {
      run();
      const resume = suspendBudget();
      state.t = 5_000; // an age, spent somewhere else entirely
      resume();
      run();
    }, { clock });

    assert.equal(calls.calls, 2, "the second call was refused for time the interpreter did not spend");
  });

  it("refuses nothing at all while suspended", () => {
    const { state, clock } = stubClock();

    withBudget(100, () => {
      const resume = suspendBudget();
      state.t = 5_000;
      assert.equal(outOfBudget(), false, "an unrelated caller was refused by a limit it never had");
      resume();

      // The deadline came back, moved forward by exactly the time spent away — so it is still not
      // out at the instant of the resume, and is as soon as it spends anything of its own.
      assert.equal(outOfBudget(), false);
      state.t = 5_101;
      assert.equal(outOfBudget(), true, "the deadline did not come back at all");
    }, { clock });
  });

  it("still refuses once the time it did spend runs out", () => {
    const { state, clock } = stubClock();
    const { state: calls, run } = probe();

    withBudget(100, () => {
      run();
      const resume = suspendBudget();
      state.t = 5_000;
      resume();
      state.t = 5_101; // 101 ms of its own, which is over
      run();
    }, { clock });

    assert.equal(calls.calls, 1);
  });

  it("charges the note only for the time it was running", () => {
    const { state, clock } = stubClock();

    withBudget(1_000, () => {
      const resume = suspendBudget();
      state.t = 10_000;
      resume();
      state.t = 10_400;
    }, { key: "note.md", clock });

    // 400 ms of its own out of 1000. Were the suspension billed, the allowance would be long gone.
    const { state: calls, run } = probe();
    withBudget(1_000, () => {
      run();
      state.t = 10_999;
      run();
    }, { key: "note.md", clock });

    assert.equal(calls.calls, 2);
  });

  it("resuming twice is not resuming twice", () => {
    const { state, clock } = stubClock();

    withBudget(100, () => {
      const resume = suspendBudget();
      state.t = 1_000;
      resume();
      resume();

      // One suspension of 1000 ms moves a deadline of 100 to 1100. Two would move it to 2100, so
      // the instant that tells them apart is between the two — an assertion at 1050 would pass
      // either way and say nothing.
      state.t = 1_150;
      assert.equal(outOfBudget(), true, "the second resume bought a second extension");
    }, { clock });
  });

  it("suspending with nothing armed is a no-op", () => {
    const resume = suspendBudget();
    assert.equal(outOfBudget(), false);
    resume();
    assert.equal(outOfBudget(), false);
  });

  it("runs an asynchronous task under a deadline it can yield across", async () => {
    const { state, clock } = stubClock();
    const { state: calls, run } = probe();

    const result = await withBudgetAsync(100, async () => {
      run();
      const resume = suspendBudget();
      await Promise.resolve();
      state.t = 5_000;
      resume();
      run();
      return "done";
    }, { clock });

    assert.equal(result.value, "done");
    assert.equal(result.exceeded, false);
    assert.equal(calls.calls, 2);
  });

  it("reports an asynchronous task that was refused", async () => {
    const { state, clock } = stubClock();
    const { state: calls, run } = probe();

    const result = await withBudgetAsync(100, async () => {
      await Promise.resolve();
      state.t = 200;
      run();
      return "done";
    }, { clock });

    assert.equal(result.exceeded, true);
    assert.equal(calls.calls, 0);
  });

  it("takes the deadline back down when an asynchronous task throws", async () => {
    const { state, clock } = stubClock();

    await assert.rejects(
      withBudgetAsync(100, async () => {
        await Promise.resolve();
        throw new Error("boom");
      }, { clock }),
    );

    state.t = 10_000;
    assert.equal(outOfBudget(), false, "the arm outlived the task that set it");
  });

  it("runs an unbudgeted asynchronous task unbudgeted", async () => {
    const { state, clock } = stubClock();
    const { state: calls, run } = probe();

    const result = await withBudgetAsync(0, async () => {
      state.t = 10_000;
      await Promise.resolve();
      run();
      return 7;
    }, { clock });

    assert.equal(result.value, 7);
    assert.equal(result.exceeded, false);
    assert.equal(calls.calls, 1);
  });
});
