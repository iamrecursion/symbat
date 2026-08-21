// The built worker bundle, actually loaded and actually asked something.
//
// What it catches is the half that is deterministic and that fails *silently* in production — a
// stray `obsidian` import, a broken `init` handshake, the tree-shaken `import.meta` branch coming
// back to life, and an `external` turning into a bare `require()` that throws the moment the worker
// loads. What it cannot catch is whether a blob-URL worker runs inside Obsidian; see
// `worker-harness.ts` for why, and `docs/roadmap.md` for what stands in its place.
//
// The differential cases — every task answering the same thing over the wire as it does in process
// — live in `tasks.test.ts`, which drives both paths from one set of assertions.

import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_PREAMBLE } from "../../../src/properties/parse.ts";
import { buildDocumentScopeTree, scopeEntries } from "../../../src/scope/model.ts";
import { skip } from "../wasm-pkg.ts";
import { startWorker } from "./worker-harness.ts";

test("the built worker instantiates the module and answers a task", { skip }, async () => {
  // `startWorker` asserts the `ready` handshake itself, so reaching here is half the test.
  const worker = await startWorker();
  try {
    const reply = await worker.ask("evalCodeBlock", {
      source: "2 m + 3 m",
      before: [],
      preamble: EMPTY_PREAMBLE,
      applyRates: false,
      budget: { budgetMs: 0, key: null },
    });

    assert.equal(reply?.value?.value.output.includes("5"), true, `unexpected answer: ${JSON.stringify(reply)}`);
  } finally {
    await worker.stop();
  }
});

// The names a context build enumerates ride out on the envelope, and nothing else announces them.
// Miss it and every unit silently stops being syntax-highlighted, with no error to go on.
test("the built worker carries the semantic names out on the envelope", { skip }, async () => {
  const worker = await startWorker();
  try {
    const reply = await worker.ask("warm", { applyRates: false }, { priority: "background" });
    assert.equal((reply?.names?.units.length ?? 0) > 0, true, "the prelude's units");
    assert.equal((reply?.names?.dimensions.length ?? 0) > 0, true, "the prelude's dimensions");
  } finally {
    await worker.stop();
  }
});

// **The end-to-end proof that the cooperative rung works**, and the one thing only a real thread
// can show. A `cancel` sitting in the port's queue is not delivered while the worker is busy, so
// before the looping tasks learned to stand aside between items this could not have passed: the
// pass would have run all forty blocks and answered them.
//
// Forty blocks is forty standard-library loads, which is seconds of work — so the cancel lands
// mid-pass without the test having to guess at a delay.
//
// Each block **defines a name**, and that is what makes it forty rather than one: a block that
// leaves something behind cannot be served from the context pool, so every one of these pays its
// own standard-library load. Bodies of `1 + 1` used to do the same job and stopped: the pool
// answers thirty-nine of forty such blocks in microseconds, and the pass was over before the wait
// below had elapsed.
test("a pass already running in the worker stops when a cancel is posted", { skip }, async () => {
  const worker = await startWorker();
  try {
    const blocks = Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, body: [`let n${i} = 1 + 1`], before: [] }));
    const answer = worker.ask("evalBlocks", {
      blocks,
      preamble: EMPTY_PREAMBLE,
      applyRates: false,
      budget: { budgetMs: 0, key: null },
    }, { group: "note.md" });

    // Long enough for the pass to have started and be somewhere in the middle of it. The task is
    // running on the other thread, so this is a real wait rather than a turn of this one's loop.
    await new Promise((resolve) => setTimeout(resolve, 200));
    worker.post({ kind: "cancel", group: "note.md" });

    // The whole reply, not its `value`: a job the queue never finished settles as `null` outright,
    // which is the same thing a surface is told when its request was superseded before it started.
    assert.equal(await answer, null, "a stopped pass must answer nothing, not a partial answer");
  } finally {
    await worker.stop();
  }
});

// And the interpreter is still there afterwards: an unwound task frees its context on the way out,
// so a stop is not a leak and not a fault.
test("the worker still answers after a pass has been stopped", { skip }, async () => {
  const worker = await startWorker();
  try {
    // Defining, for the reason the case above gives: a pass of poolable blocks finishes too fast to
    // be caught in the middle of.
    const blocks = Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, body: [`let n${i} = 1 + 1`], before: [] }));
    const stopped = worker.ask("evalBlocks", {
      blocks,
      preamble: EMPTY_PREAMBLE,
      applyRates: false,
      budget: { budgetMs: 0, key: null },
    }, { group: "note.md" });

    await new Promise((resolve) => setTimeout(resolve, 200));
    worker.post({ kind: "cancel", group: "note.md" });
    await stopped;

    const reply = await worker.ask("evalCodeBlock", {
      source: "2 + 2",
      before: [],
      preamble: EMPTY_PREAMBLE,
      applyRates: false,
      budget: { budgetMs: 0, key: null },
    });

    assert.equal(reply?.value?.value.isError, false);
    assert.equal(reply?.faulted, false, "the stop was reported as a crash");
  } finally {
    await worker.stop();
  }
});

// **A request does not come back changed, and that is the only thing separating the two
// transports.** Everything else about them is arranged to be indistinguishable, which is why this
// difference is the one that gets missed: in process a task and its caller share every object it
// was handed, so a task that writes its answer into the request works perfectly, and goes on
// working right up until there is a thread between them.
//
// `evalScopeTree` is the one task shaped that way — the values belong in the entries of the tree
// that was sent, and the walk that computes them is what knows where each one goes. It returns the
// filled tree for exactly this reason, and `scope/source.ts` copies the values back off the reply.
// Sent here rather than asserted there because the reply is where the difference is visible: the
// scope inspector rendering every binding without a value is what the omission actually looks like,
// and nothing about it fails.
test("the built worker fills a copy, not the tree it was sent", { skip }, async () => {
  const worker = await startWorker();
  try {
    const tree = buildDocumentScopeTree({ file: "a.nbt", label: "a", lines: ["let answer = 41"] });
    const reply = await worker.ask("evalScopeTree", {
      tree,
      applyRates: false,
      preludeBefore: null,
      budget: { budgetMs: 0, key: null },
    });

    assert.deepEqual(
      scopeEntries(reply?.value?.value ?? tree).map((entry) => entry.value?.plain),
      ["41"],
      "the reply did not carry the filled tree",
    );
    assert.deepEqual(
      scopeEntries(tree).map((entry) => entry.value),
      [undefined],
      "the request was mutated in place, so this transport cannot show the difference any more",
    );
  } finally {
    await worker.stop();
  }
});
