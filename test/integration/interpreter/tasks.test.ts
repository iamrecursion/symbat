// The seam, checked against itself: every task driven through `worker/tasks.ts` against real
// Numbat, beside the pure evaluation module driven directly over a context of the test's own.
//
// This is the one shape that can check the seam, and nothing else provides it. The surfaces are
// Obsidian-importing and unit-testable only in pieces; the pure evaluators already have their own
// tests. What neither can see is the part the seam actually changed — **which context answered, and
// what was left in it**. A pool that reuses a context between two notes, or a replay that runs the
// preamble in the wrong order, produces a note that reads differently with nothing failing
// anywhere. So each case below states the answer twice, by two routes, and compares them.
//
// Requires the wasm to be built; self-skips otherwise.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { hintsForBlock, type LineInterpret } from "../../../src/evaluation/inlay-parse.ts";
import { DEFAULT_INLINE_CONFIG, inlineResultFor, scanNote } from "../../../src/evaluation/inline-parse.ts";
import {
  type TaskMap,
  type TaskName,
  WANT_CARD,
  WANT_FIELDS,
  WANT_SIGNATURE,
} from "../../../src/interpreter/protocol.ts";
import { EVALUATION_STOPPED_RESULT, EVALUATION_STOPPED_TEXT } from "../../../src/interpreter/refusals.ts";
import { createQueue } from "../../../src/interpreter/worker/queue.ts";
import { runTask } from "../../../src/interpreter/worker/tasks.ts";
import { evaluateBindings } from "../../../src/properties/outcomes.ts";
import { derivePreamble, EMPTY_PREAMBLE, PLAIN_ALL, preambleChunks } from "../../../src/properties/parse.ts";
import { loadEngine, skip } from "../wasm-pkg.ts";
import { startWorker, type WorkerHarness } from "./worker-harness.ts";

const NO_BUDGET = { budgetMs: 0, key: null };
const RATES = false;

// The worker, started once for the file and asked everything the in-process engine is asked. Lazy
// rather than a `before` hook, so a file run with the wasm missing never builds a bundle it is
// going to skip.
let worker: WorkerHarness | null = null;
let starting: Promise<WorkerHarness> | null = null;

async function liveWorker(): Promise<WorkerHarness> {
  starting ??= startWorker().then((started) => {
    worker = started;
    return started;
  });
  return starting;
}

after(async () => {
  await worker?.stop();
});

/**
 * Numbat's "Did you mean" suggestion, blanked.
 *
 * **Found by this comparison, and a genuine property of the interpreter rather than of the seam.**
 * Two instances given the same undefined name suggested different corrections — `darcies` in one
 * and `calories` in the other, both the same edit distance from `carried` — so the tie is broken by
 * the iteration order of a hash map, which Rust seeds per instance. It is stable within one
 * interpreter and not across two.
 *
 * Nothing in the plugin depends on which suggestion appears, and no surface would be wrong if it
 * changed. Recorded here rather than worked around silently, because "the same input gives the same
 * answer" is the assumption every evaluation cache in the plugin is keyed on, and this is the one
 * place it is known not to hold across instances — which matters the day two instances can exist.
 */
function stable(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/Did you mean '[^']*'/g, "Did you mean '…'");
  }

  if (Array.isArray(value)) {
    return value.map(stable);
  }

  if (value instanceof Map) {
    return new Map([...value].map(([key, held]) => [key, stable(held)]));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, held]) => [key, stable(held)]));
  }

  return value;
}

/**
 * The task's answer, from **both** paths, asserted to agree.
 *
 * Every case below already states its answer twice — once through the pure evaluation module the
 * test drives itself, once through the task — and this makes it three, the third being the same
 * task in a real thread, reached by a real message. That is not ceremony. The worker's answer has
 * been through `structuredClone` in both directions, was produced by a second wasm instance with
 * its own contexts and its own session table, and was scheduled by a queue nothing here can see
 * into. A `Map` that does not survive the wire, a reply that carries a handle rather than data, a
 * session id that means something different over there: each of those is invisible in process and
 * each is a note that reads differently for the reader.
 *
 * The two engines stay in step because every call that *changes* interpreter state goes through
 * here, so both see the same sequence. The few cases that deliberately want a `null` answer call
 * `runTask` directly and are in process only — there is nothing for a second path to agree about.
 *
 * Only `value` is compared, and it is compared through {@link stable}. The rest of the envelope
 * legitimately differs: `names` is drained per call, and in this process the reference contexts
 * drain it too.
 */
async function ask<K extends TaskName>(name: K, request: TaskMap[K]["request"]): Promise<TaskMap[K]["response"]> {
  const reply = await runTask(name, request);
  assert.notEqual(reply.value, null, `the ${name} task answered nothing`);
  assert.equal(reply.faulted, false, `the ${name} task recorded a wasm panic`);

  if (!skip) {
    const remote = await (await liveWorker()).ask(name, request);
    assert.notEqual(remote, null, `the ${name} task answered nothing in the worker`);
    assert.equal(remote?.faulted, false, `the ${name} task recorded a wasm panic in the worker`);
    assert.deepEqual(
      stable(remote?.value),
      stable(reply.value),
      `the worker and the in-process path disagree about ${name}`,
    );
  }

  return reply.value as TaskMap[K]["response"];
}

/**
 * A fresh context of the test's own, and `run` over it — the reference route. Freed by `use`'s
 * return, so a leak here would be the test's rather than the engine's.
 */
async function reference<T>(use: (run: LineInterpret) => T, preludeBefore?: string): Promise<T> {
  const engine = await loadEngine();
  const context = engine.createContext(RATES, preludeBefore === undefined ? {} : { preludeBefore });
  try {
    return use((code) => engine.interpret(context, code));
  } finally {
    engine.freeQuietly(context);
  }
}

/** Replay a preamble's statements, then hand `run` back — what every evaluating task does first. */
function opened(run: LineInterpret, preamble: Parameters<typeof preambleChunks>[0]): LineInterpret {
  for (const chunk of preambleChunks(preamble)) {
    run(chunk);
  }
  return run;
}

const PREAMBLE = derivePreamble(
  { total: "3 m * 4", label: "2 kg" },
  { isNumbatTyped: () => true, isReserved: () => false, plain: PLAIN_ALL },
);

const plain = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ");

// --- a rendered code block ----------------------------------------------------

test("evalCodeBlock matches a context the test opens itself", { skip }, async () => {
  const source = "let side = 3 m\nside^2";
  const expected = await reference((run) => opened(run, PREAMBLE)(source));
  const actual = await ask("evalCodeBlock", {
    source,
    before: [],
    preamble: PREAMBLE,
    applyRates: RATES,
    budget: NO_BUDGET,
  });

  assert.deepEqual(actual.value, expected);
  assert.equal(actual.exceeded, false);
  assert.equal(plain(actual.value.output).includes("9"), true);
});

test("evalCodeBlock sees the note preamble", { skip }, async () => {
  const actual = await ask("evalCodeBlock", {
    source: "total * 2",
    before: [],
    preamble: PREAMBLE,
    applyRates: RATES,
    budget: NO_BUDGET,
  });

  assert.equal(actual.value.isError, false);
  assert.equal(plain(actual.value.output).includes("24"), true);
});

test("a shared block sees the blocks before it, in order", { skip }, async () => {
  const before = ["let base = 10 m", "let base2 = base * 2"];
  const source = "base2 + base";
  const expected = await reference((run) => {
    const open = opened(run, PREAMBLE);
    for (const chunk of before) {
      open(chunk);
    }
    return open(source);
  });

  assert.deepEqual(
    (await ask("evalCodeBlock", { source, before, preamble: PREAMBLE, applyRates: RATES, budget: NO_BUDGET })).value,
    expected,
  );
});

// **The case nothing else can see.** A context reused between two blocks would answer this one, and
// answer it correctly, while quietly making a note depend on a note rendered before it.
test("a block does not see a definition from the block evaluated before it", { skip }, async () => {
  await ask("evalCodeBlock", {
    source: "let leaked = 99 m",
    before: [],
    preamble: EMPTY_PREAMBLE,
    applyRates: RATES,
    budget: NO_BUDGET,
  });

  const after = await ask("evalCodeBlock", {
    source: "leaked",
    before: [],
    preamble: EMPTY_PREAMBLE,
    applyRates: RATES,
    budget: NO_BUDGET,
  });

  assert.equal(after.value.isError, true, "the second block was answered out of the first one's context");
});

// --- the editor's inlay pass --------------------------------------------------

test("evalBlocks matches hintsForBlock, block by block", { skip }, async () => {
  const blocks = [
    { id: "a", body: ["let width = 2 m", "width * 3"], before: [] },
    { id: "b", body: ["total / 2"], before: [] },
  ];

  const expected = [];
  for (const block of blocks) {
    expected.push(await reference((run) => hintsForBlock(opened(run, PREAMBLE), [...block.body])));
  }

  const actual = await ask("evalBlocks", { blocks, preamble: PREAMBLE, applyRates: RATES, budget: NO_BUDGET });
  assert.equal(actual.exceeded, false);
  assert.deepEqual(actual.value.map((entry) => entry.id), ["a", "b"]);
  assert.deepEqual(actual.value.map((entry) => entry.evaluated), [true, true]);
  assert.deepEqual(actual.value.map((entry) => [...entry.hints]), expected);
});

// Cancellation reaching work that has *started*, which is the whole of the cooperative rung and the
// one thing no unit test can show against a real interpreter: the boundaries are inside
// `evalBlocks`, the contexts are real, and each block is a whole standard-library load.
//
// Deterministic rather than timed. The first boundary is before the first block, so once the job
// has been given a turn it is parked in the yield; the cancellation lands while it is there, and
// the check on the far side of the yield is what sees it.
test("a running pass stops at its next boundary when its group is canceled", { skip }, async () => {
  const queue = createQueue();
  const blocks = Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, body: ["1 + 1"], before: [] }));

  const answer = queue.submit({
    priority: "visible",
    group: "note.md",
    generation: 0,
    run: (shouldAbort) =>
      runTask("evalBlocks", { blocks, preamble: EMPTY_PREAMBLE, applyRates: RATES, budget: NO_BUDGET }, shouldAbort),
  });

  // Enough turns for the queue to pump and the task to reach its first yield, and no more.
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }

  queue.cancel("note.md");

  assert.equal(await answer, null, "a stopped pass must answer nothing, not a partial answer");
});

// The same interpreter answers normally afterwards: an unwound task frees its context on the way
// out, so a stop is not a leak and not a fault.
test("the interpreter still answers after a pass has been stopped", { skip }, async () => {
  const actual = await ask("evalCodeBlock", {
    source: "2 + 2",
    before: [],
    preamble: EMPTY_PREAMBLE,
    applyRates: RATES,
    budget: NO_BUDGET,
  });

  assert.equal(actual.value.isError, false);
});

test("one block's definitions do not reach the next in the same pass", { skip }, async () => {
  const actual = await ask("evalBlocks", {
    blocks: [
      { id: "a", body: ["let shared_only = 7"], before: [] },
      { id: "b", body: ["shared_only"], before: [] },
    ],
    preamble: EMPTY_PREAMBLE,
    applyRates: RATES,
    budget: NO_BUDGET,
  });

  assert.equal(actual.value[1].hints.every((hint) => hint.kind === "error"), true);
});

// **The pool, which the two leak tests above cannot see.** They prove a reused context carries
// nothing across; they would go on proving it if the pool never handed one out. So this one asserts
// the reuse is *live*: two blocks at the same scope, the first non-defining, and the second served
// out of the first one's context rather than a second standard-library load.
test("a second block at the same scope is answered from the first one's context", { skip }, async () => {
  const engine = await loadEngine();

  // Emptied first, or an earlier case in this file has already left a context under this very key —
  // which is the pool working, and would make the counts below depend on test order.
  engine.releasePool();
  const before = engine.poolStats();

  const actual = await ask("evalBlocks", {
    blocks: [
      { id: "a", body: ["2 m + 3 m"], before: [] },
      { id: "b", body: ["10 kg"], before: [] },
    ],
    preamble: EMPTY_PREAMBLE,
    applyRates: RATES,
    budget: NO_BUDGET,
  });

  const now = engine.poolStats();
  assert.equal(now.misses - before.misses, 1, "the first block should have found an empty pool");
  assert.equal(now.hits - before.hits, 1, "the second block built its own context instead of taking the first's");
  assert.equal(actual.value[1].hints.some((hint) => hint.kind === "error"), false, "and answered wrongly");
});

// **The residue the pool introduces, and the only thing a reused context carries.** Numbat binds
// `ans` and `_` from an expression statement and from nothing else, so a context that ran only
// expressions differs from a fresh one in exactly those two names. A block that could read one is
// given a fresh context, or `ans` at the top of a block would stop being the error it is today and
// silently become whatever the block before it worked out.
test("a block that mentions the last result is not given a used context", { skip }, async () => {
  await ask("evalBlocks", {
    blocks: [{ id: "a", body: ["2 m + 3 m"], before: [] }],
    preamble: EMPTY_PREAMBLE,
    applyRates: RATES,
    budget: NO_BUDGET,
  });

  const actual = await ask("evalBlocks", {
    blocks: [{ id: "b", body: ["ans"], before: [] }],
    preamble: EMPTY_PREAMBLE,
    applyRates: RATES,
    budget: NO_BUDGET,
  });

  assert.equal(
    actual.value[0].hints.every((hint) => hint.kind === "error"),
    true,
    "`ans` resolved to a value from a block it has nothing to do with",
  );
});

// --- the whole-file pass ------------------------------------------------------

test("evalDocument matches hintsForBlock over the same lines", { skip }, async () => {
  const text = "unit widget\nlet count = 12 widget\ncount / 4";
  const expected = await reference((run) => hintsForBlock(run, text.split("\n")));
  const actual = await ask("evalDocument", { text, applyRates: RATES, preludeBefore: null, budget: NO_BUDGET });

  assert.deepEqual([...actual.value], expected);
  assert.equal(actual.exceeded, false);
});

// --- inline spans -------------------------------------------------------------

test("evalNoteUnits matches an inline replay the test drives", { skip }, async () => {
  const lines = ["Cost is n`total * 2`.", "```numbat-shared", "let rate = 5", "```", "Rate n`rate + 1`."];
  const units = scanNote(lines, DEFAULT_INLINE_CONFIG);

  const expected = await reference((run) => {
    const open = opened(run, PREAMBLE);
    const results = [];
    for (const unit of units) {
      if (unit.kind === "shared") {
        open(unit.code);
      } else {
        results.push(inlineResultFor(open, unit.span.expr, null));
      }
    }
    return results;
  });

  const actual = await ask("evalNoteUnits", {
    units,
    applyRates: RATES,
    config: DEFAULT_INLINE_CONFIG,
    preamble: PREAMBLE,
    budget: NO_BUDGET,
  });

  assert.deepEqual([...actual.value], expected);
});

// **The claim the inline pass's conversion rests on**, and the one thing that makes it worth more
// than a saved build per render: a note with no shared blocks keys the same for its inline spans as
// for its code blocks — the same preamble, an empty `before` — so in live preview, where both run
// over one note, the second of them costs nothing.
test("the inline pass and the block pass share one context at the same scope", { skip }, async () => {
  const engine = await loadEngine();
  engine.releasePool();
  const before = engine.poolStats();

  await ask("evalNoteUnits", {
    units: scanNote(["Cost is n`2 m + 3 m`."], DEFAULT_INLINE_CONFIG),
    applyRates: RATES,
    config: DEFAULT_INLINE_CONFIG,
    preamble: EMPTY_PREAMBLE,
    budget: NO_BUDGET,
  });

  const between = engine.poolStats();
  assert.equal(between.misses - before.misses, 1, "the inline pass should have found an empty pool");

  await ask("evalBlocks", {
    blocks: [{ id: "a", body: ["4 m"], before: [] }],
    preamble: EMPTY_PREAMBLE,
    applyRates: RATES,
    budget: NO_BUDGET,
  });

  assert.equal(
    engine.poolStats().hits - between.hits,
    1,
    "the block pass built its own context instead of taking the inline pass's",
  );
});

// A shared block defines, so the note that had one must not leave it lying about for the next.
test("a note's shared block does not reach the note evaluated after it", { skip }, async () => {
  const shared = ["```numbat-shared", "let inline_leak = 42", "```", "Value n`inline_leak`."];
  const first = await ask("evalNoteUnits", {
    units: scanNote(shared, DEFAULT_INLINE_CONFIG),
    applyRates: RATES,
    config: DEFAULT_INLINE_CONFIG,
    preamble: EMPTY_PREAMBLE,
    budget: NO_BUDGET,
  });
  assert.equal(first.value[0].kind, "value", "the note that defines it should see it");

  const second = await ask("evalNoteUnits", {
    units: scanNote(["Value n`inline_leak`."], DEFAULT_INLINE_CONFIG),
    applyRates: RATES,
    config: DEFAULT_INLINE_CONFIG,
    preamble: EMPTY_PREAMBLE,
    budget: NO_BUDGET,
  });
  assert.equal(second.value[0].kind, "error", "the next note was answered out of the first one's context");
});

test("evalExprs runs its entries in order, in one scope", { skip }, async () => {
  const actual = await ask("evalExprs", {
    entries: [
      { expr: "let step = 4 m", dp: null, error: null },
      { expr: "step * 3", dp: null, error: null },
    ],
    applyRates: RATES,
    preamble: EMPTY_PREAMBLE,
    budget: NO_BUDGET,
  });

  assert.equal(actual.value[1].kind, "value");
  assert.equal(plain(actual.value[1].valueHtml ?? "").includes("12"), true);
});

// --- the property batch -------------------------------------------------------

test("evalBindings matches evaluateBindings over the same preamble", { skip }, async () => {
  const expected = await reference((run) => evaluateBindings(run, PREAMBLE, 0));
  const actual = await ask("evalBindings", {
    preamble: PREAMBLE,
    from: 0,
    applyRates: RATES,
    budget: NO_BUDGET,
    refuseWith: null,
  });

  assert.deepEqual([...actual.value], expected);
});

test("evalBindings resumes from an index, and the bindings above it still define", { skip }, async () => {
  const expected = await reference((run) => evaluateBindings(run, PREAMBLE, 1));
  const actual = await ask("evalBindings", {
    preamble: PREAMBLE,
    from: 1,
    applyRates: RATES,
    budget: NO_BUDGET,
    refuseWith: null,
  });

  assert.deepEqual([...actual.value], expected);
  assert.equal(actual.value.length, PREAMBLE.bindings.length - 1);
});

// A note inside its cool-down is *answered*, not skipped: a widget told nothing keeps asking. And
// the sentence comes from the asking side, because the two ways into a cool-down — the note ran out
// of time, and the reader stopped it — read very differently to whoever is looking at the row.
test("refuseWith answers every binding without touching the interpreter", { skip }, async () => {
  const actual = await ask("evalBindings", {
    preamble: PREAMBLE,
    from: 0,
    applyRates: RATES,
    budget: NO_BUDGET,
    refuseWith: EVALUATION_STOPPED_RESULT,
  });

  assert.equal(actual.value.length, PREAMBLE.bindings.length);
  assert.equal(actual.value.every((outcome) => outcome.kind === "error"), true);
  assert.equal(
    actual.value.every((outcome) => outcome.kind === "error" && outcome.errorText === EVALUATION_STOPPED_TEXT),
    true,
    "the caller's own sentence, not the limit's",
  );
  assert.equal(actual.exceeded, false, "a refusal from the ledger is not the limit being exceeded");
});

// --- one property row ---------------------------------------------------------

test("evalProperty evaluates in the scope of the chunks above it", { skip }, async () => {
  const chunks = ["let above = 6 m"];
  const expected = await reference((run) => {
    for (const chunk of chunks) {
      run(chunk);
    }
    return inlineResultFor(run, "above * 2");
  });

  assert.deepEqual(await ask("evalProperty", { chunks, text: "above * 2", applyRates: RATES }), expected);
});

// The scope context is *cached* by the engine: a keystroke costs an interpret rather than a
// standard-library load. What must not happen is one row's text defining a name the next row can
// see.
test("a reused scope context is not polluted by what was evaluated in it", { skip }, async () => {
  const chunks = ["let anchor = 1"];
  await ask("evalProperty", { chunks, text: "let sneaky = 5", applyRates: RATES });
  const after = await ask("evalProperty", { chunks, text: "sneaky", applyRates: RATES });

  assert.equal(after.kind, "error");
});

// --- point queries ------------------------------------------------------------

test("facts fills exactly the mask it was asked for", { skip }, async () => {
  const ref = { kind: "scope" as const, spec: { chunks: ["let speed = 3 m/s"], applyRates: RATES } };

  const narrow = await ask("facts", { ref, probes: ["speed"], want: WANT_SIGNATURE });
  const speed = narrow.get("speed");
  assert.notEqual(speed?.signature, null);
  assert.equal(speed?.info, null, "a signature-only lookup must not run print_info");
  assert.equal(speed?.valueHtml, null, "a signature-only lookup must not evaluate the name");

  const wide = (await ask("facts", { ref, probes: ["speed"], want: WANT_CARD })).get("speed");
  assert.equal(wide?.signature, speed?.signature, "the two masks agree about the fact they share");
  assert.notEqual(wide?.valueHtml, null);
});

test("facts answers about the scope's own definitions, not just the prelude", { skip }, async () => {
  const filled = await ask("facts", {
    ref: { kind: "scope", spec: { chunks: ["let only_here = 42 m"], applyRates: RATES } },
    probes: ["only_here"],
    want: WANT_CARD,
  });

  assert.equal(plain(filled.get("only_here")?.valueHtml ?? "").includes("42"), true);
});

test("facts reports a struct's fields under WANT_FIELDS", { skip }, async () => {
  const filled = await ask("facts", {
    ref: {
      kind: "scope",
      spec: {
        chunks: ["struct Costs { parts: Scalar, labor: Scalar }", "let c = Costs { parts: 1, labor: 2 }"],
        applyRates: RATES,
      },
    },
    probes: ["c"],
    want: WANT_FIELDS,
  });

  assert.deepEqual([...(filled.get("c")?.fields ?? [])], ["parts", "labor"]);
});

test("holeType recovers the operand an incomplete line is waiting for", { skip }, async () => {
  const ref = { kind: "scope" as const, spec: { chunks: [], applyRates: RATES } };
  assert.equal((await ask("holeType", { ref, input: "3 m +" })).type, "Length");
  assert.equal((await ask("holeType", { ref, input: "3 m + 2 m" })).type, null, "a complete line has no hole");
});

test("a hole probe leaves nothing behind in the scope it was typed against", { skip }, async () => {
  const ref = { kind: "scope" as const, spec: { chunks: ["let anchor2 = 1"], applyRates: RATES } };
  await ask("holeType", { ref, input: "let planted = 5 +" });

  assert.equal(
    (await ask("facts", { ref, probes: ["planted"], want: WANT_SIGNATURE })).get("planted")?.signature,
    null,
  );
});

test("completions offers the scope's own names alongside the prelude's", { skip }, async () => {
  const reply = await ask("completions", {
    ref: { kind: "scope", spec: { chunks: ["let velocity_here = 2 m/s"], applyRates: RATES } },
    query: "velocity_",
  });

  assert.equal(reply.candidates.includes("velocity_here"), true);
  assert.notEqual(reply.vocab, null);
  assert.equal(reply.vocab?.variables.has("velocity_here"), true);
});

// The fields and the names come back together, so a base that turns out not to be a struct falls
// through to ordinary completion without a second round trip on the typing path.
test("a member completion answers with the fields and the names at once", { skip }, async () => {
  const spec = {
    chunks: ["struct Pair { left: Scalar, right: Scalar }", "let p = Pair { left: 1, right: 2 }"],
    applyRates: RATES,
  };

  const struct = await ask("completions", { ref: { kind: "scope", spec }, query: "sq", memberBase: "p" });
  assert.deepEqual([...(struct.fields ?? [])], ["left", "right"]);
  assert.equal(struct.candidates.includes("sqrt"), true, "the names came back beside the fields");

  const notAStruct = await ask("completions", { ref: { kind: "scope", spec }, query: "sq", memberBase: "sqrt" });
  assert.deepEqual([...(notAStruct.fields ?? [])], [], "a base that is not a struct has no fields");
  assert.equal(notAStruct.candidates.includes("sqrt"), true, "and falls through on the same answer");
});

test("a snapshot carries the vocabulary and the prelude's verdict", { skip }, async () => {
  const snapshot = await ask("snapshot", { kind: "scope", spec: { chunks: [], applyRates: RATES } });
  assert.equal(snapshot.vocab.units.has("meter"), true);
  assert.equal(snapshot.preludeError, null, "no user prelude is configured in the test engine");
});

// --- the REPL session ---------------------------------------------------------

test("a session accumulates, resets, and stops existing when closed", { skip }, async () => {
  const opened = await ask("replOpen", { applyRates: RATES });
  const { id } = opened;

  const defined = await ask("replEval", { id, input: "let carried = 8 m", applyRates: RATES });
  assert.equal(defined.kind, "value");

  const recalled = await ask("replEval", { id, input: "carried * 2", applyRates: RATES });
  assert.equal(recalled.kind, "value");
  assert.equal(recalled.kind === "value" && recalled.isError, false);
  assert.equal(recalled.kind === "value" && plain(recalled.output).includes("16"), true);

  await ask("replReset", { id, applyRates: RATES });
  const afterReset = await ask("replEval", { id, input: "carried", applyRates: RATES });
  assert.equal(afterReset.kind === "value" && afterReset.isError, true, "a reset session forgot its definitions");

  await ask("replClose", { id });
  assert.equal((await runTask("replEval", { id, input: "1 + 1", applyRates: RATES })).value, null);
});

test("two sessions do not see each other", { skip }, async () => {
  const a = await ask("replOpen", { applyRates: RATES });
  const b = await ask("replOpen", { applyRates: RATES });

  await ask("replEval", { id: a.id, input: "let private_to_a = 3", applyRates: RATES });
  const fromB = await ask("replEval", { id: b.id, input: "private_to_a", applyRates: RATES });
  assert.equal(fromB.kind === "value" && fromB.isError, true);

  await ask("replClose", { id: a.id });
  await ask("replClose", { id: b.id });
});

test("a REPL command is reported as a command, not as a value", { skip }, async () => {
  const opened = await ask("replOpen", { applyRates: RATES });
  const listed = await ask("replEval", { id: opened.id, input: "list functions", applyRates: RATES });

  assert.equal(listed.kind, "command");
  assert.equal(listed.kind === "command" && listed.output.length > 0, true);
  await ask("replClose", { id: opened.id });
});

// The vocabulary for a session is cached where the session is, because there is no text to key it
// by — and it has to be retired by every submission, since a `let` or a `unit` changes what
// completes. Both halves are checked here: the name appears, and it appears without the caller
// having said anything about caching.
test("a session's completions follow what it has just defined", { skip }, async () => {
  const opened = await ask("replOpen", { applyRates: RATES });
  const ref = { kind: "session" as const, id: opened.id };

  const before = await ask("completions", { ref, query: "freshly_" });
  assert.equal(before.candidates.includes("freshly_defined"), false);

  await ask("replEval", { id: opened.id, input: "let freshly_defined = 1", applyRates: RATES });

  const after = await ask("completions", { ref, query: "freshly_" });
  assert.equal(after.candidates.includes("freshly_defined"), true);
  assert.equal(after.vocab?.variables.has("freshly_defined"), true, "the vocabulary was retired too");

  await ask("replClose", { id: opened.id });
});

test("facts about a session answer from what that session defined", { skip }, async () => {
  const opened = await ask("replOpen", { applyRates: RATES });
  await ask("replEval", { id: opened.id, input: "let session_local = 5 kg", applyRates: RATES });

  const filled = await ask("facts", {
    ref: { kind: "session", id: opened.id },
    probes: ["session_local"],
    want: WANT_CARD,
  });
  assert.equal(plain(filled.get("session_local")?.valueHtml ?? "").includes("5"), true);

  await ask("replClose", { id: opened.id });
  assert.equal(
    (await runTask("facts", {
      ref: { kind: "session", id: opened.id },
      probes: ["session_local"],
      want: WANT_CARD,
    })).value,
    null,
    "a closed session is a miss, not a crash",
  );
});

// --- the allowance ------------------------------------------------------------

// Each block **defines a name**, which is what makes the allowance run out: a defining block cannot
// be served from the context pool, so every one of these pays a standard-library load and the first
// alone is tens of milliseconds against a budget of one. Bodies of `${i} m + 1 m` used to do the
// same job and stopped — the pool answers them in microseconds, and twelve of them can finish
// inside a millisecond, so what got refused depended on how warm the pool happened to be.
test("a budget of one millisecond refuses the rest of a note and says so", { skip }, async () => {
  const blocks = Array.from({ length: 12 }, (_, i) => ({
    id: `block-${String(i)}`,
    body: [`let budgeted_${String(i)} = ${String(i + 1)} m + 1 m`],
    before: [],
  }));

  const actual = await ask("evalBlocks", {
    blocks,
    preamble: EMPTY_PREAMBLE,
    applyRates: RATES,
    budget: { budgetMs: 1, key: "budgeted.md" },
  });

  assert.equal(actual.exceeded, true);
  assert.equal(actual.value.some((entry) => !entry.evaluated), true, "some block was answered without a context");

  // A block the pass never opened still carries the limit's own sentence on every line, so the
  // reader sees why rather than an absence to interpret.
  const refused = actual.value.find((entry) => !entry.evaluated);
  assert.equal(refused?.hints.every((hint) => hint.kind === "error"), true);
});

// **The allowance meeting the pool**, which neither of them can see on its own.
//
// A task head-checks the budget before it asks for a context, but the deadline can fall *inside*
// the prefix replay that building one performs — and from there every remaining chunk is refused
// without running. What comes out is a context that never heard the note's shared blocks, filed in
// the pool under a key that promises it did.
//
// The damage is not to the pass that caused it, which refuses everything and says so. It is to the
// *next* pass at the same scope, by which time the note's allowance has refilled: that one takes
// the context, evaluates against a note missing its own definitions, and reports the result as an
// ordinary answer — `evaluated`, not `exceeded`, and cached as truth.
//
// One millisecond is enough because the standard-library load alone is tens of them, so the first
// chunk is already past the deadline.
test("a prefix replay cut short by the allowance is not offered to the pool", { skip }, async () => {
  const engine = await loadEngine();
  const blocks = [{ id: "reader", body: ["poisoned_x"], before: ["let poisoned_x = 41"] }];

  // Emptied first, or an earlier case has left a context under a key this one counts against.
  engine.releasePool();

  const refused = await ask("evalBlocks", {
    blocks,
    preamble: EMPTY_PREAMBLE,
    applyRates: RATES,
    budget: { budgetMs: 1, key: "poisoned.md" },
  });
  assert.equal(refused.exceeded, true, "the pass was meant to run out of its allowance");

  const before = engine.poolStats();

  // The same scope again, with the allowance back. The `before` chunk has to be replayed for this
  // to answer at all, so a pooled context that skipped it shows up as an unknown identifier.
  const actual = await ask("evalBlocks", {
    blocks,
    preamble: EMPTY_PREAMBLE,
    applyRates: RATES,
    budget: NO_BUDGET,
  });

  assert.equal(engine.poolStats().hits - before.hits, 0, "a context built under a spent allowance was recycled");
  assert.equal(actual.value[0].evaluated, true);
  assert.equal(
    actual.value[0].hints.some((hint) => hint.kind === "error"),
    false,
    `the block was answered against a context missing its prefix: ${JSON.stringify(actual.value[0].hints)}`,
  );
});

test("no budget refuses nothing", { skip }, async () => {
  const actual = await ask("evalBlocks", {
    blocks: [{ id: "only", body: ["1 m + 1 m"], before: [] }],
    preamble: EMPTY_PREAMBLE,
    applyRates: RATES,
    budget: NO_BUDGET,
  });

  assert.equal(actual.exceeded, false);
  assert.equal(actual.value[0].evaluated, true);
});

// --- the envelope -------------------------------------------------------------

// The one thing an evaluation learns that somebody else has to be told. Miss it and every unit
// silently stops being syntax-highlighted, with no error and no missing feature to report.
//
// Asserted on a reply that enumerates a *vocabulary*, because that is the route the names actually
// take: the prelude's own are enumerated once per instance and are long since drained by the tests
// above, but a scope's own units and dimensions ride out every time one is listed. That is also the
// case that matters, since a unit a note declares is one the highlighter has never heard of.
test("a scope's own dimensions and units ride out on the reply", { skip }, async () => {
  const reply = await runTask("completions", {
    ref: {
      kind: "scope",
      spec: { chunks: ["dimension Widgetness", "unit widget: Widgetness"], applyRates: RATES },
    },
    query: "widg",
  });

  assert.notEqual(reply.names, null, "the reply carried no semantic names at all");
  assert.equal(reply.names?.dimensions.includes("Widgetness"), true);
  assert.equal(reply.names?.units.includes("widget"), true);
});

test("a prelude check reports the file's own verdict and the one before it", { skip }, async () => {
  const good = await ask("preludeCheck", { text: "let ok = 1", applyRates: RATES, preludeBefore: "Prelude.nbt" });
  assert.equal(good.earlier, null);
  assert.equal(good.result.isError, false);

  const bad = await ask("preludeCheck", { text: "let = ", applyRates: RATES, preludeBefore: "Prelude.nbt" });
  assert.equal(bad.result.isError, true);
});
