import assert from "node:assert/strict";
import { test } from "node:test";
import { breath } from "../../../src/interpreter/worker/cooperative.ts";
import { createQueue, type Priority } from "../../../src/interpreter/worker/queue.ts";

/** A job whose completion the test controls, so ordering can be observed rather than raced. */
function deferred(): { promise: Promise<void>; resolve: () => void; } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A job that records that it ran and answers `label`. */
function job(
  label: string,
  ran: string[],
  options: { priority?: Priority; group?: string; generation?: number; } = {},
) {
  return {
    priority: options.priority ?? "visible",
    group: options.group,
    generation: options.generation ?? 0,
    run: () => {
      ran.push(label);
      return Promise.resolve(label);
    },
  };
}

/**
 * Let every already-resolved promise settle. Two turns, because the queue defers its own pump by
 * one and a job's `.then` chain takes another.
 */
async function settle(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

// --- running at all -----------------------------------------------------------

test("a submitted job runs and its answer comes back", async () => {
  const queue = createQueue();
  assert.equal(await queue.submit({ priority: "visible", generation: 0, run: () => Promise.resolve(41 + 1) }), 42);
});

// The engine is one instance with one heap: two jobs in flight would be two passes interleaving
// into the same contexts.
test("only one job runs at a time", async () => {
  const queue = createQueue();
  const first = deferred();
  const ran: string[] = [];

  const a = queue.submit({
    priority: "visible",
    generation: 0,
    run: async () => {
      ran.push("a:start");
      await first.promise;
      ran.push("a:end");
      return "a";
    },
  });

  // A turn before `b` is submitted, so that `a` is the one already in flight. Submitted together
  // they would queue together, and the newest of a class runs first — see the LIFO case below.
  await settle();
  const b = queue.submit(job("b", ran));
  await settle();
  assert.deepEqual(ran, ["a:start"], "b must not have started while a is in flight");

  first.resolve();
  assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
  assert.deepEqual(ran, ["a:start", "a:end", "b"]);
});

// --- priority and order -------------------------------------------------------

test("a higher-priority job goes first whatever the submission order", async () => {
  const queue = createQueue();
  const ran: string[] = [];
  const block = deferred();

  // Something in flight, so everything below queues rather than running as it arrives.
  const held = queue.submit({ priority: "visible", generation: 0, run: () => block.promise.then(() => "held") });
  await settle();

  const jobs = [
    queue.submit(job("bg", ran, { priority: "background" })),
    queue.submit(job("vis", ran, { priority: "visible" })),
    queue.submit(job("int", ran, { priority: "interactive" })),
  ];

  block.resolve();
  await Promise.all([held, ...jobs]);
  assert.deepEqual(ran, ["int", "vis", "bg"]);
});

// LIFO, and it is safe only because supersession keeps at most one live request per surface — see
// the module doc. The newest question is the one about what is on screen.
test("within a class the newest job runs first", async () => {
  const queue = createQueue();
  const ran: string[] = [];
  const block = deferred();
  const held = queue.submit({ priority: "visible", generation: 0, run: () => block.promise.then(() => "held") });
  await settle();

  const jobs = [queue.submit(job("first", ran)), queue.submit(job("second", ran)), queue.submit(job("third", ran))];

  block.resolve();
  await Promise.all([held, ...jobs]);
  assert.deepEqual(ran, ["third", "second", "first"]);
});

// --- supersession -------------------------------------------------------------

test("a newer job in the same group cancels the queued older one", async () => {
  const queue = createQueue();
  const ran: string[] = [];
  const block = deferred();
  const held = queue.submit({ priority: "visible", generation: 0, run: () => block.promise.then(() => "held") });
  await settle();

  const stale = queue.submit(job("stale", ran, { group: "note.md" }));
  const fresh = queue.submit(job("fresh", ran, { group: "note.md" }));

  assert.equal(await stale, null, "the superseded job answers nothing rather than hanging");

  block.resolve();
  await Promise.all([held, fresh]);
  assert.deepEqual(ran, ["fresh"], "the superseded job never ran at all");
});

test("groups do not supersede each other", async () => {
  const queue = createQueue();
  const ran: string[] = [];
  const block = deferred();
  const held = queue.submit({ priority: "visible", generation: 0, run: () => block.promise.then(() => "held") });
  await settle();

  const a = queue.submit(job("a", ran, { group: "a.md" }));
  const b = queue.submit(job("b", ran, { group: "b.md" }));

  block.resolve();
  assert.deepEqual(await Promise.all([held, a, b]), ["held", "a", "b"]);
});

// A job already running cannot be stopped from here — only by a thread that is not the one running
// it — so supersession must not pretend otherwise by dropping its answer.
test("a job already running is not superseded", async () => {
  const queue = createQueue();
  const block = deferred();
  const running = queue.submit({
    priority: "visible",
    generation: 0,
    group: "note.md",
    run: () => block.promise.then(() => "running"),
  });
  await settle();

  const next = queue.submit(job("next", [], { group: "note.md" }));
  block.resolve();

  assert.equal(await running, "running");
  assert.equal(await next, "next");
});

// --- obsolescence -------------------------------------------------------------

test("a job queued under an older generation is dropped rather than run", async () => {
  const queue = createQueue();
  const ran: string[] = [];
  const block = deferred();
  const held = queue.submit({ priority: "visible", generation: 0, run: () => block.promise.then(() => "held") });
  await settle();

  const old = queue.submit(job("old", ran, { generation: 0 }));
  queue.setGeneration(1);
  const fresh = queue.submit(job("fresh", ran, { generation: 1 }));

  assert.equal(await old, null);
  block.resolve();
  await Promise.all([held, fresh]);
  assert.deepEqual(ran, ["fresh"]);
});

test("a job submitted under a generation already left behind never queues", async () => {
  const queue = createQueue();
  const ran: string[] = [];
  queue.setGeneration(3);

  assert.equal(await queue.submit(job("stale", ran, { generation: 2 })), null);
  assert.deepEqual(ran, []);
  assert.equal(queue.pending(), 0);
});

// --- cancellation -------------------------------------------------------------

test("cancel drops a group's queued jobs and leaves the rest", async () => {
  const queue = createQueue();
  const ran: string[] = [];
  const block = deferred();
  const held = queue.submit({ priority: "visible", generation: 0, run: () => block.promise.then(() => "held") });
  await settle();

  const dropped = queue.submit(job("dropped", ran, { group: "a.md" }));
  const kept = queue.submit(job("kept", ran, { group: "b.md" }));
  queue.cancel("a.md");

  assert.equal(await dropped, null);
  block.resolve();
  await Promise.all([held, kept]);
  assert.deepEqual(ran, ["kept"]);
});

test("cancelAll empties the queue", async () => {
  const queue = createQueue();
  const ran: string[] = [];
  const block = deferred();
  const held = queue.submit({ priority: "visible", generation: 0, run: () => block.promise.then(() => "held") });
  await settle();

  const a = queue.submit(job("a", ran));
  const b = queue.submit(job("b", ran, { priority: "interactive" }));
  assert.equal(queue.pending(), 2);
  queue.cancelAll();
  assert.equal(queue.pending(), 0);

  assert.deepEqual(await Promise.all([a, b]), [null, null]);
  block.resolve();
  await held;
  assert.deepEqual(ran, []);
});

// --- failure ------------------------------------------------------------------

// A throwing job is a bug in a task, not an answer. Every caller's recovery is the same, so a
// rejection would be one more thing each of them had to remember.
test("a throwing job settles empty and the queue carries on", async () => {
  const queue = createQueue();
  const ran: string[] = [];
  const block = deferred();
  const held = queue.submit({ priority: "visible", generation: 0, run: () => block.promise.then(() => "held") });
  await settle();

  const failing = queue.submit({
    priority: "visible",
    generation: 0,
    run: () => Promise.reject(new Error("boom")),
  });
  const after = queue.submit(job("after", ran));

  block.resolve();
  assert.deepEqual(await Promise.all([held, failing, after]), ["held", null, "after"]);
  assert.deepEqual(ran, ["after"]);
});

// --- bookkeeping --------------------------------------------------------------

test("nothing starts on the submitting tick, so a burst supersedes itself", async () => {
  const queue = createQueue();
  const ran: string[] = [];

  const a = queue.submit(job("a", ran, { group: "note.md" }));
  const b = queue.submit(job("b", ran, { group: "note.md" }));
  const c = queue.submit(job("c", ran, { group: "note.md" }));

  assert.deepEqual(ran, [], "submitting must not run anything inline");
  assert.deepEqual(await Promise.all([a, b, c]), [null, null, "c"]);
  assert.deepEqual(ran, ["c"], "three keystrokes cost one pass, not three");
});

test("pending and busy report what the queue is doing", async () => {
  const queue = createQueue();
  const block = deferred();
  assert.equal(queue.busy(), false);

  const held = queue.submit({ priority: "visible", generation: 0, run: () => block.promise.then(() => "held") });
  await settle();
  const waiting = queue.submit(job("waiting", []));
  await settle();

  assert.equal(queue.busy(), true);
  assert.equal(queue.pending(), 1);

  block.resolve();
  await Promise.all([held, waiting]);
  assert.equal(queue.busy(), false);
  assert.equal(queue.pending(), 0);
});

// --- stopping a job that has already started ----------------------------------
//
// Before there were boundaries, everything below ran to the end: a queue entry is the only thing
// `cancel` could reach, and a running job is precisely the thing that is no longer an entry.

/** A job that reports what its abort signal said, at a boundary the test controls. */
function watcher(
  gate: { promise: Promise<void>; resolve: () => void; },
  seen: boolean[],
  options: { group?: string; generation?: number; } = {},
) {
  return {
    priority: "visible" as Priority,
    group: options.group,
    generation: options.generation ?? 0,
    run: async (shouldAbort: () => boolean) => {
      seen.push(shouldAbort());
      await gate.promise;
      seen.push(shouldAbort());
      return "done";
    },
  };
}

test("canceling a group reaches the job in that group that is already running", async () => {
  const queue = createQueue();
  const gate = deferred();
  const seen: boolean[] = [];

  const answer = queue.submit(watcher(gate, seen, { group: "note.md" }));
  await settle();

  queue.cancel("note.md");
  gate.resolve();

  assert.equal(await answer, "done");
  assert.deepEqual(seen, [false, true], "the signal must flip while the job is between boundaries");
});

test("canceling another group leaves the running job alone", async () => {
  const queue = createQueue();
  const gate = deferred();
  const seen: boolean[] = [];

  const answer = queue.submit(watcher(gate, seen, { group: "note.md" }));
  await settle();

  queue.cancel("other.md");
  gate.resolve();
  await answer;

  assert.deepEqual(seen, [false, false]);
});

test("canceling everything reaches the running job whatever its group", async () => {
  const queue = createQueue();
  const gate = deferred();
  const seen: boolean[] = [];

  const answer = queue.submit(watcher(gate, seen));
  await settle();

  queue.cancelAll();
  gate.resolve();
  await answer;

  assert.deepEqual(seen, [false, true]);
});

// The case supersession was written for: three keystrokes in, the pass in flight is describing a
// document that no longer exists.
test("a newer job in the same group tells the running one to stop", async () => {
  const queue = createQueue();
  const gate = deferred();
  const seen: boolean[] = [];
  const ran: string[] = [];

  const first = queue.submit(watcher(gate, seen, { group: "note.md" }));
  await settle();

  void queue.submit(job("second", ran, { group: "note.md" }));
  gate.resolve();
  await first;

  assert.deepEqual(seen, [false, true]);
});

test("moving the generation on tells a running job of an older one to stop", async () => {
  const queue = createQueue();
  const gate = deferred();
  const seen: boolean[] = [];

  const answer = queue.submit(watcher(gate, seen, { generation: 3 }));
  await settle();

  queue.setGeneration(4);
  gate.resolve();
  await answer;

  assert.deepEqual(seen, [false, true]);
});

test("moving the generation to the running job's own leaves it alone", async () => {
  const queue = createQueue();
  const gate = deferred();
  const seen: boolean[] = [];

  const answer = queue.submit(watcher(gate, seen, { generation: 3 }));
  await settle();

  queue.setGeneration(3);
  gate.resolve();
  await answer;

  assert.deepEqual(seen, [false, false]);
});

// A job that unwinds because it was told to stop is the queue working, so it settles the same
// `null` a job dropped before it started would have — and, unlike a real failure, says nothing on
// the console.
test("a job that unwinds after being stopped settles null without being logged", async () => {
  const queue = createQueue();
  const gate = deferred();
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args);

  try {
    const answer = queue.submit({
      priority: "visible",
      group: "note.md",
      generation: 0,
      run: async (shouldAbort: () => boolean) => {
        await gate.promise;
        await breath(shouldAbort);
        return "unreachable";
      },
    });

    await settle();
    queue.cancel("note.md");
    gate.resolve();

    assert.equal(await answer, null);
    assert.deepEqual(logged, []);
  } finally {
    console.error = original;
  }
});

test("a job that fails for any other reason is still logged", async () => {
  const queue = createQueue();
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args);

  try {
    const answer = queue.submit({
      priority: "visible",
      generation: 0,
      run: () => Promise.reject(new Error("boom")),
    });

    assert.equal(await answer, null);
    assert.equal(logged.length, 1);
  } finally {
    console.error = original;
  }
});

// The signal latches: two cancellations arriving in one turn must not un-cancel each other, and a
// job must not be able to outlast a stop by reaching a boundary between them.
test("the abort signal does not clear until the next job starts", async () => {
  const queue = createQueue();
  const gate = deferred();
  const seen: boolean[] = [];

  const answer = queue.submit(watcher(gate, seen, { group: "note.md" }));
  await settle();

  queue.cancel("note.md");
  queue.cancel("other.md");
  gate.resolve();
  await answer;

  assert.deepEqual(seen, [false, true]);
});

test("a job that starts after a cancellation is not told to stop", async () => {
  const queue = createQueue();
  const gate = deferred();
  const seen: boolean[] = [];
  const later: boolean[] = [];

  const first = queue.submit(watcher(gate, seen, { group: "note.md" }));
  await settle();
  queue.cancel("note.md");

  const second = queue.submit({
    priority: "visible",
    generation: 0,
    run: (shouldAbort: () => boolean) => {
      later.push(shouldAbort());
      return Promise.resolve("second");
    },
  });

  gate.resolve();
  await first;
  assert.equal(await second, "second");
  assert.deepEqual(later, [false], "the fresh job inherited the stopped one's signal");
});
