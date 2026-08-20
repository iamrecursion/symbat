// The per-document scan memos: that a repeat ask is served without rescanning, that a different
// document (or a different inline configuration) is not, and that the memoized answer is the one
// the underlying scan would have given.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blockRangesOf, frontmatterBodyOf, type ScannedDoc, scannedNote } from "../../../src/document/doc-cache.ts";
import { numbatBlockRanges } from "../../../src/document/fences.ts";
import { DEFAULT_INLINE_CONFIG, scanNote } from "../../../src/evaluation/inline-parse.ts";
import { frontmatterBody } from "../../../src/properties/parse.ts";

/**
 * A document that counts the walks made over it — the whole point of the memo is that this stays at
 * one however many times a scan is asked for.
 */
function countingDoc(text: string): ScannedDoc & { walks: number; } {
  const lines = text.split("\n");
  return {
    lines: lines.length,
    walks: 0,
    iterLines(from: number, to: number): Iterable<string> {
      this.walks += 1;
      return lines.slice(from - 1, to - 1);
    },
  };
}

const NOTE = [
  "---",
  "budget: 100 EUR",
  "spent: 40 EUR",
  "---",
  "",
  "Some prose with n`2 m + 3 m` in it.",
  "",
  "```numbat",
  "let x = 5 m",
  "```",
  "",
  "More prose.",
].join("\n");

describe("blockRangesOf", () => {
  it("walks the document once however many times it is asked", () => {
    const doc = countingDoc(NOTE);
    const first = blockRangesOf(doc);
    const second = blockRangesOf(doc);

    assert.equal(doc.walks, 1);
    assert.equal(first, second, "the same array is handed back, not an equal copy");
  });

  it("agrees with an unmemoized scan", () => {
    assert.deepEqual(blockRangesOf(countingDoc(NOTE)), numbatBlockRanges(NOTE.split("\n")));
  });

  it("does not serve one document's answer for another", () => {
    const withBlock = blockRangesOf(countingDoc(NOTE));
    const withoutBlock = blockRangesOf(countingDoc("just prose\n"));

    assert.equal(withBlock.length, 1);
    assert.equal(withoutBlock.length, 0);
  });
});

describe("frontmatterBodyOf", () => {
  it("walks the document once however many times it is asked", () => {
    const doc = countingDoc(NOTE);
    assert.deepEqual(frontmatterBodyOf(doc), ["budget: 100 EUR", "spent: 40 EUR"]);
    assert.deepEqual(frontmatterBodyOf(doc), ["budget: 100 EUR", "spent: 40 EUR"]);
    assert.equal(doc.walks, 1);
  });

  it("agrees with an unmemoized scan", () => {
    assert.deepEqual(frontmatterBodyOf(countingDoc(NOTE)), frontmatterBody(NOTE.split("\n")));
  });

  // The regression this guards: `null` is an answer ("this note has no frontmatter"), not a miss,
  // so a memo that tests the slot for emptiness rather than for having been filled would rescan on
  // every call for exactly the notes it most wants to make cheap.
  it("remembers that a note has no frontmatter", () => {
    const doc = countingDoc("just prose\nand more\n");
    assert.equal(frontmatterBodyOf(doc), null);
    assert.equal(frontmatterBodyOf(doc), null);
    assert.equal(doc.walks, 1);
  });
});

describe("scannedNote", () => {
  it("walks the document once however many times it is asked", () => {
    const doc = countingDoc(NOTE);
    const first = scannedNote(doc, DEFAULT_INLINE_CONFIG);
    const second = scannedNote(doc, DEFAULT_INLINE_CONFIG);

    assert.equal(doc.walks, 1);
    assert.equal(first, second);
  });

  it("agrees with an unmemoized scan", () => {
    assert.deepEqual(
      scannedNote(countingDoc(NOTE), DEFAULT_INLINE_CONFIG),
      scanNote(NOTE.split("\n"), DEFAULT_INLINE_CONFIG),
    );
  });

  it("rescans when the configuration changes, and not when an equal one is passed", () => {
    const doc = countingDoc(NOTE);
    scannedNote(doc, DEFAULT_INLINE_CONFIG);
    scannedNote(doc, { ...DEFAULT_INLINE_CONFIG }); // equal by value, different object
    assert.equal(doc.walks, 1, "the stamp compares configurations, not identities");

    scannedNote(doc, { ...DEFAULT_INLINE_CONFIG, live: "q" });
    assert.equal(doc.walks, 2);
  });

  // The prefixes and the separator are user-set, so a stamp joined on a space would let
  // `{live: "n x", concrete: "y"}` and `{live: "n", concrete: "x y"}` collide.
  it("does not confuse configurations whose fields contain spaces", () => {
    const doc = countingDoc(NOTE);
    scannedNote(doc, { ...DEFAULT_INLINE_CONFIG, live: "n x", concrete: "y" });
    scannedNote(doc, { ...DEFAULT_INLINE_CONFIG, live: "n", concrete: "x y" });
    assert.equal(doc.walks, 2);
  });
});
