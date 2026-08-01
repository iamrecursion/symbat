// The fence index skips a rescan for most edits, so what it must never do is answer from a stale
// index. Each test below drives a real transaction through the field and compares it against a
// fresh scan of the resulting document — the index is only sound if the two never disagree.

import { EditorState, type TransactionSpec } from "@codemirror/state";
import assert from "node:assert/strict";
import { test } from "node:test";
import { type FenceSpan, inNumbatBody, numbatFenceState } from "../../../src/document/fence-state.ts";
import { numbatBlockRanges } from "../../../src/document/fences.ts";

/** The spans a fresh scan of `state` would produce — the ground truth. */
function scanned(state: EditorState): FenceSpan[] {
  return numbatBlockRanges(state.doc.iterLines(1, state.doc.lines + 1)).map((block) => ({
    shared: block.shared,
    bodyStartLine: block.bodyStartLine,
    closeLine: block.closeLine,
  }));
}

function stateOf(lines: string[]): EditorState {
  return EditorState.create({ doc: lines.join("\n"), extensions: [numbatFenceState] });
}

/** Apply a change and assert the maintained index still agrees with a fresh scan. */
function applyAndCheck(state: EditorState, spec: TransactionSpec, what: string): EditorState {
  const next = state.update(spec).state;
  assert.deepEqual(next.field(numbatFenceState), scanned(next), what);
  return next;
}

const DOC = [
  "prose", // 0
  "```numbat", // 1
  "let x = 1", // 2
  "let y = 2", // 3
  "```", // 4
  "more prose", // 5
  "```numbat-shared", // 6
  "let z = 3", // 7
  "```", // 8
];

test("the initial index matches a full scan", () => {
  const state = stateOf(DOC);
  assert.deepEqual(state.field(numbatFenceState), scanned(state));
  assert.deepEqual(state.field(numbatFenceState), [
    { shared: false, bodyStartLine: 2, closeLine: 4 },
    { shared: true, bodyStartLine: 7, closeLine: 8 },
  ]);
});

test("inNumbatBody covers the body and excludes the fences", () => {
  const spans = stateOf(DOC).field(numbatFenceState);
  assert.equal(inNumbatBody(spans, 0), false, "prose");
  assert.equal(inNumbatBody(spans, 1), false, "the opening fence");
  assert.equal(inNumbatBody(spans, 2), true);
  assert.equal(inNumbatBody(spans, 3), true);
  assert.equal(inNumbatBody(spans, 4), false, "the closing fence");
  assert.equal(inNumbatBody(spans, 5), false, "prose between blocks");
  assert.equal(inNumbatBody(spans, 7), true, "the shared block's body");
});

test("typing inside a line leaves the index correct", () => {
  const state = stateOf(DOC);
  const line = state.doc.line(3); // `let x = 1`, inside the block
  applyAndCheck(state, { changes: { from: line.to, insert: "0" } }, "editing block content");
  const prose = state.doc.line(1);
  applyAndCheck(state, { changes: { from: prose.to, insert: " more" } }, "editing prose");
});

test("inserting a line shifts every block below it", () => {
  const state = stateOf(DOC);
  const prose = state.doc.line(1);
  const next = applyAndCheck(state, { changes: { from: prose.to, insert: "\nextra" } }, "a new prose line");
  assert.deepEqual(next.field(numbatFenceState), [
    { shared: false, bodyStartLine: 3, closeLine: 5 },
    { shared: true, bodyStartLine: 8, closeLine: 9 },
  ]);
});

test("deleting a line shifts them back", () => {
  const state = stateOf(DOC);
  const first = state.doc.line(1);
  applyAndCheck(state, { changes: { from: first.from, to: first.to + 1 } }, "removing a prose line");
});

test("turning a prose line into a fence is picked up", () => {
  // The line count is unchanged, so only the fence-ish check can catch this.
  const state = stateOf(["prose", "x", "y"]);
  const line = state.doc.line(2);
  const next = applyAndCheck(
    state,
    { changes: { from: line.from, to: line.to, insert: "```numbat" } },
    "a line becoming an opening fence",
  );
  assert.equal(next.field(numbatFenceState).length, 1);
});

test("removing a closing fence is picked up", () => {
  const state = stateOf(DOC);
  const close = state.doc.line(5); // the ``` closing the first block
  applyAndCheck(state, { changes: { from: close.from, to: close.to, insert: "text" } }, "unclosing a block");
});

test("editing the info string of an existing fence is picked up", () => {
  const state = stateOf(DOC);
  const open = state.doc.line(2); // ```numbat
  applyAndCheck(state, { changes: { from: open.from, to: open.to, insert: "```js" } }, "numbat becoming js");
});

test("adding frontmatter that swallows a fence is picked up", () => {
  const state = stateOf(["---", "title: x", "---", "```numbat", "1 + 1", "```"]);
  assert.equal(state.field(numbatFenceState).length, 1);
  const close = state.doc.line(3); // the frontmatter's closing ---
  const next = applyAndCheck(
    state,
    { changes: { from: close.from, to: close.to, insert: "other: y" } },
    "frontmatter left open",
  );
  assert.deepEqual(next.field(numbatFenceState), [], "everything is frontmatter now");
});

test("a multi-line replacement that keeps the line count is picked up", () => {
  const state = stateOf(["a", "b", "c"]);
  applyAndCheck(
    state,
    { changes: { from: state.doc.line(1).from, to: state.doc.line(2).to, insert: "```numbat\nx" } },
    "two lines replaced, one becoming a fence",
  );
});
