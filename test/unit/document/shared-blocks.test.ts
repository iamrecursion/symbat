import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSharedBlocks } from "../../../src/document/shared-blocks.ts";

test("extracts a single block with its content and start line", () => {
  const doc = ["# note", "", "```numbat-shared", "let x = 5 m", "```", ""].join("\n");
  const blocks = extractSharedBlocks(doc);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].startLine, 2);
  assert.equal(blocks[0].content, "let x = 5 m");
});

test("returns multiple blocks in document order", () => {
  const doc = [
    "```numbat-shared", // 0
    "let a = 1", // 1
    "```", // 2
    "prose", // 3
    "```numbat-shared", // 4
    "a + 1", // 5
    "a + 2", // 6
    "```", // 7
  ].join("\n");
  const blocks = extractSharedBlocks(doc);
  assert.equal(blocks.length, 2);
  assert.deepEqual(
    blocks.map((b) => b.startLine),
    [0, 4],
  );
  assert.equal(blocks[1].content, "a + 1\na + 2");
});

test("supports tilde fences and indentation", () => {
  const doc = ["  ~~~numbat-shared", "  let y = 2", "  ~~~"].join("\n");
  const blocks = extractSharedBlocks(doc);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].content, "  let y = 2");
});

test("ignores plain numbat fences", () => {
  const doc = ["```numbat", "1 + 1", "```"].join("\n");
  assert.deepEqual(extractSharedBlocks(doc), []);
});

test("returns nothing for a document with no shared blocks", () => {
  assert.deepEqual(extractSharedBlocks("just prose\nmore prose"), []);
});

test("ignores a shared block quoted inside another fence", () => {
  // Documentation quoting a shared block must not export its bindings to every note that imports
  // the documenting note.
  const doc = ["````markdown", "```numbat-shared", "let x = 1", "```", "````"].join("\n");
  assert.deepEqual(extractSharedBlocks(doc), []);
});
