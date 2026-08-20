import assert from "node:assert/strict";
import { test } from "node:test";
import { VersionedLoad } from "../../../src/interpreter/versioned-load.ts";

/** Let every already-runnable microtask settle. Counting individual ticks would couple the tests to
 *  the length of the guard's internal promise chain. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** A deferred promise, so a test can hold a load open across an await. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void; } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("loads once, then not again until invalidated", async () => {
  let runs = 0;
  const guard = new VersionedLoad(() => {
    runs += 1;
    return Promise.resolve();
  });
  await guard.ensure();
  await guard.ensure();
  assert.equal(runs, 1);
  guard.invalidate();
  await guard.ensure();
  assert.equal(runs, 2);
});

// Load-bearing for main.ts: `invalidate()` is a *claim*, not a trigger. Everything a reload
// announces — `setUserPrelude`'s interpreter-generation bump above all — happens when someone
// awaits `ensure()`, so an invalidation whose whole point is to make the open editors re-evaluate
// has to move the generation itself. Leaving it to the reload inverts the order: the editors
// rebuild first, hit their caches against the old generation, schedule nothing, and so never reach
// the `ensure()` that would have moved it.
test("invalidate alone runs nothing", async () => {
  let runs = 0;
  const guard = new VersionedLoad(() => {
    runs += 1;
    return Promise.resolve();
  });

  guard.invalidate();
  await flush();
  assert.equal(runs, 0, "no load without an ensure");

  await guard.ensure();
  assert.equal(runs, 1);

  guard.invalidate();
  await flush();
  assert.equal(runs, 1, "and none after one, either");
});

test("stale reports whether a reload is outstanding", async () => {
  const guard = new VersionedLoad(() => Promise.resolve());
  assert.equal(guard.stale, true, "nothing loaded yet");
  await guard.ensure();
  assert.equal(guard.stale, false);
  guard.invalidate();
  assert.equal(guard.stale, true);
});

test("concurrent callers share one load, and all wait for it to be applied", async () => {
  // The bug this guards: a dirty flag cleared *before* the read let the second caller return
  // immediately, then build an interpreter context against a prelude that had not been applied —
  // and cache the empty-scope result.
  const gate = deferred();
  let runs = 0;
  let applied = false;
  const guard = new VersionedLoad(async () => {
    runs += 1;
    await gate.promise;
    applied = true;
  });

  let firstDone = false;
  let secondDone = false;
  const first = guard.ensure().then(() => {
    firstDone = true;
  });
  const second = guard.ensure().then(() => {
    secondDone = true;
  });

  await flush();
  assert.equal(runs, 1, "the second caller joins the in-flight load rather than starting another");
  assert.equal(firstDone, false);
  assert.equal(secondDone, false, "and does not return early");

  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(applied, true);
  assert.equal(runs, 1);
});

test("an invalidation during a load is not swallowed by it", async () => {
  // The mirror bug: clearing the flag *after* the read would mark the state current even though the
  // sources changed while it was being read.
  const first = deferred();
  const gates = [first, deferred()];
  let runs = 0;
  const guard = new VersionedLoad(async () => {
    const gate = gates[runs];
    runs += 1;
    await gate.promise;
  });

  let done = false;
  const ensure = guard.ensure().then(() => {
    done = true;
  });
  await flush();
  assert.equal(runs, 1);

  guard.invalidate(); // e.g. the user saves a prelude file mid-read
  first.resolve();
  await flush();
  assert.equal(done, false, "the caller does not settle on the superseded read");
  assert.equal(runs, 2, "a second pass picks up the change");

  gates[1].resolve();
  await ensure;
  assert.equal(guard.stale, false);
});

test("a failed load leaves the state stale and reaches every caller", async () => {
  let runs = 0;
  const guard = new VersionedLoad(() => {
    runs += 1;
    return runs === 1 ? Promise.reject(new Error("read failed")) : Promise.resolve();
  });
  await assert.rejects(() => guard.ensure(), /read failed/);
  assert.equal(guard.stale, true, "so the next caller retries rather than trusting it");
  await guard.ensure();
  assert.equal(runs, 2);
  assert.equal(guard.stale, false);
});
