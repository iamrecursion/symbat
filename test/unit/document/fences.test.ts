import assert from "node:assert/strict";
import { test } from "node:test";
import { insideNumbatFence, numbatBlockRanges, numbatFenceContext } from "../../../src/document/fences.ts";

/** Is the 0-indexed `line` of `doc` inside a `numbat`/`numbat-shared` block body? */
function insideAt(doc: string, line: number): boolean {
  // The lines strictly before the target line (mirrors what the editor feeds in via
  // `Text.iterLines(1, cursorLine)`).
  return insideNumbatFence(doc.split("\n").slice(0, line));
}

/** The fence context for the 0-indexed `line` of `doc` (lines strictly before it). */
function contextAt(doc: string, line: number) {
  return numbatFenceContext(doc.split("\n").slice(0, line));
}

test("a content line inside a numbat block is inside", () => {
  const doc = ["```numbat", "1 + 1", "```"].join("\n");
  assert.equal(insideAt(doc, 1), true);
});

test("a content line inside a numbat-shared block is inside", () => {
  const doc = ["```numbat-shared", "let x = 5 m", "```"].join("\n");
  assert.equal(insideAt(doc, 1), true);
});

test("the opening fence line is not inside", () => {
  const doc = ["```numbat", "1 + 1", "```"].join("\n");
  assert.equal(insideAt(doc, 0), false);
});

test("prose before, between, and after blocks is outside", () => {
  const doc = [
    "intro", // 0
    "```numbat", // 1
    "1 + 1", // 2
    "```", // 3
    "middle", // 4
    "```numbat-shared", // 5
    "let a = 1", // 6
    "```", // 7
    "outro", // 8
  ].join("\n");
  assert.equal(insideAt(doc, 0), false);
  assert.equal(insideAt(doc, 2), true);
  assert.equal(insideAt(doc, 4), false);
  assert.equal(insideAt(doc, 6), true);
  assert.equal(insideAt(doc, 8), false);
});

test("a non-numbat fence is not a numbat scope", () => {
  const doc = ["```js", "const x = 1;", "```"].join("\n");
  assert.equal(insideAt(doc, 1), false);
});

test("an info string that only starts with numbat does not match", () => {
  const doc = ["```numbatx", "1 + 1", "```"].join("\n");
  assert.equal(insideAt(doc, 1), false);
});

test("supports tilde fences and indentation", () => {
  const doc = ["  ~~~numbat", "  1 + 1", "  ~~~"].join("\n");
  assert.equal(insideAt(doc, 1), true);
});

test("a longer fence is not closed by a shorter run of the same character", () => {
  const doc = ["````numbat", "1 + 1", "```", "still inside", "````"].join("\n");
  // The three-backtick line cannot close a four-backtick fence, so both the line after it and the
  // line before the real close remain inside.
  assert.equal(insideAt(doc, 1), true);
  assert.equal(insideAt(doc, 3), true);
});

test("an unclosed block keeps following lines inside (to end of document)", () => {
  const doc = ["```numbat", "1 + 1", "2 + 2"].join("\n");
  assert.equal(insideAt(doc, 2), true);
});

// --- numbatFenceContext ------------------------------------------------------

test("numbatFenceContext returns the block kind, opening line, and body-so-far", () => {
  const doc = [
    "intro", // 0
    "```numbat", // 1
    "let x = 5 m", // 2
    "let y = 3 s", // 3
    "x /", // 4  <- cursor on line 5
  ].join("\n");
  assert.deepEqual(contextAt(doc, 5), {
    shared: false,
    openLine: 1,
    body: ["let x = 5 m", "let y = 3 s", "x /"],
  });
});

test("numbatFenceContext recognizes a shared block and stops the body at the cursor", () => {
  const doc = ["```numbat-shared", "let a = 1", "let b = 2"].join("\n");
  // Cursor on line 2 (the `let b` line): the body is only what precedes it.
  assert.deepEqual(contextAt(doc, 2), { shared: true, openLine: 0, body: ["let a = 1"] });
});

test("numbatFenceContext returns null outside a block and after it closes", () => {
  const doc = ["```numbat", "1 + 1", "```", "after"].join("\n");
  assert.equal(contextAt(doc, 0), null); // before the block
  assert.equal(contextAt(doc, 3), null); // the closing fence line
  assert.equal(contextAt(doc, 4), null); // after the block
  assert.deepEqual(contextAt(doc, 2), { shared: false, openLine: 0, body: ["1 + 1"] });
});

test("numbatFenceContext body is empty on the first line inside a fresh block", () => {
  const doc = ["prose", "```numbat", "first"].join("\n");
  assert.deepEqual(contextAt(doc, 2), { shared: false, openLine: 1, body: [] });
});

// --- Nesting: a numbat fence quoted inside another fence is example text ------
//
// This repo's own docs/features.md quotes numbat blocks inside ````markdown fences. Treating those
// as live blocks painted inlay hints inside documentation and — for a quoted `numbat-shared` block
// — exported its bindings to every note importing that one.

test("a numbat fence nested inside another fence is not a numbat scope", () => {
  const doc = [
    "````markdown", // 0
    "```numbat", // 1
    "3 miles / 40 min -> km/h", // 2
    "```", // 3
    "````", // 4
    "after", // 5
  ].join("\n");
  assert.equal(insideAt(doc, 2), false, "the quoted block's body is example text");
  assert.equal(contextAt(doc, 2), null);
  assert.deepEqual(numbatBlockRanges(doc.split("\n")), [], "no block to evaluate");
  assert.equal(insideAt(doc, 5), false, "the outer fence still closes");
});

test("a nested numbat-shared block exports nothing", () => {
  const doc = ["~~~~text", "```numbat-shared", "let x = 1", "```", "~~~~"].join("\n");
  assert.deepEqual(numbatBlockRanges(doc.split("\n")), []);
});

test("a real numbat block after a quoted one is still found", () => {
  const doc = [
    "````markdown", // 0
    "```numbat", // 1
    "quoted", // 2
    "```", // 3
    "````", // 4
    "```numbat", // 5
    "1 + 1", // 6
    "```", // 7
  ].join("\n");
  const blocks = numbatBlockRanges(doc.split("\n"));
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], {
    shared: false,
    openLine: 5,
    closeLine: 7,
    bodyStartLine: 6,
    body: ["1 + 1"],
  });
  assert.equal(insideAt(doc, 6), true);
});

test("a fence inside frontmatter opens nothing", () => {
  const doc = [
    "---", // 0
    "note: |", // 1
    "  ```numbat", // 2
    "  1 + 1", // 3
    "---", // 4
    "prose", // 5
  ].join("\n");
  assert.equal(insideAt(doc, 3), false);
  assert.equal(insideAt(doc, 5), false, "the frontmatter close ends the region");
  assert.deepEqual(numbatBlockRanges(doc.split("\n")), []);
});

test("a numbat block below frontmatter is unaffected", () => {
  const doc = ["---", "title: x", "---", "```numbat", "1 + 1", "```"].join("\n");
  assert.equal(insideAt(doc, 4), true);
  assert.equal(numbatBlockRanges(doc.split("\n")).length, 1);
});

test("an inline code span is not a fence opener", () => {
  // Backticks with a backtick in the info string are inline code, not a fence (CommonMark) —
  // otherwise this line would open a block swallowing the rest.
  const doc = ["prose ```code``` prose", "still prose"].join("\n");
  assert.equal(insideAt(doc, 1), false);
});
