// What happens to a task that is still in the air when the interpreter instance is replaced.
//
// A file of its own because it is the one test that deliberately resets the wasm module: the
// counters, the pool and the applied rates all belong to an instance, so a case that discards one
// cannot share a process with cases that assume theirs is still there. `node --test` runs each file
// in its own process, which is what makes this safe rather than merely tidy.
//
// The hazard is specific to the in-process transport, and it is not a hypothetical: a `Numbat`
// handle is a pointer into the module's linear memory, so calling into one from a discarded
// instance is a wild pointer read in the instance that replaced it. On the worker path the thread
// is terminated instead, and every handle it held goes with it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { EVALUATION_LIMIT_TEXT } from "../../../src/interpreter/budget.ts";
import * as server from "../../../src/interpreter/worker/entry.ts";
import { EMPTY_PREAMBLE } from "../../../src/properties/parse.ts";
import { loadEngine, skip, wasmBase64 } from "../wasm-pkg.ts";

const SCHEDULE = { priority: "visible", generation: 0 } as const;

/** A pass with two expressions, which is enough for one cooperative boundary and for a pooled
 *  context to be taken and given back. */
function pass(expr: string) {
  return {
    entries: [
      { expr, dp: null, error: null },
      { expr, dp: null, error: null },
    ],
    applyRates: false,
    preamble: EMPTY_PREAMBLE,
    budget: { budgetMs: 0, key: null },
  };
}

/**
 * A task caught mid-flight by a reset must let its context go, not offer it back.
 *
 * The pass is suspended at a cooperative boundary when `stop()` lands, so it resumes *after*
 * `resetEngine` has emptied the pool and replaced the module, unwinds, and runs its `finally`. That
 * `finally` used to recycle: the pool the reset had just cleared gained a handle into the heap it
 * had just discarded, and the next request at the same key was answered from it — `hits: 1`, and a
 * `RuntimeError: memory access out of bounds` raised inside the fresh instance.
 */
test("a task unwinding after a reset does not re-fill the pool", { skip }, async () => {
  const engine = await loadEngine();

  const inFlight = server.serve("evalExprs", pass("1 m"), SCHEDULE);

  // A macrotask, which is what the boundary yields to: enough for the queue to start the job, build
  // its context and stand aside.
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  server.stop();
  assert.equal(await inFlight, null, "the interrupted pass should have no answer");
  assert.equal(engine.poolStats().recycled, 0, "a context from the discarded instance was offered to the pool");

  // And the instance that replaces it answers from its own contexts.
  await server.start(wasmBase64(), false);
  const reply = await server.serve("evalExprs", pass("1 m"), SCHEDULE);
  const results = reply?.value?.value ?? [];

  assert.equal(engine.poolStats().hits, 0, "the fresh instance took a context from the old one");
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.isError, false, `unexpected error: ${JSON.stringify(result)}`);
    assert.equal(result.plain?.includes(EVALUATION_LIMIT_TEXT) ?? false, false);
  }
});
