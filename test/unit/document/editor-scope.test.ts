import { EditorState } from "@codemirror/state";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cursorInFrontmatter,
  cursorInInlineExpr,
  cursorInNumbatCode,
  cursorInNumbatFence,
} from "../../../src/document/editor-scope.ts";
import { DEFAULT_INLINE_CONFIG } from "../../../src/evaluation/inline-parse.ts";

const cfg = DEFAULT_INLINE_CONFIG;

/** The document position of `needle`'s first character in `doc`. */
function posOf(doc: string, needle: string): number {
  const at = doc.indexOf(needle);
  assert.notEqual(at, -1, `expected the document to contain ${JSON.stringify(needle)}`);
  return at;
}

test("cursorInNumbatFence: inside a numbat or numbat-shared block, not in prose", () => {
  const doc = ["prose", "```numbat", "3 m * 2", "```", "after"].join("\n");
  const state = EditorState.create({ doc });
  assert.equal(cursorInNumbatFence(state.doc, posOf(doc, "3 m")), true);
  assert.equal(cursorInNumbatFence(state.doc, posOf(doc, "prose")), false);
  assert.equal(cursorInNumbatFence(state.doc, posOf(doc, "after")), false);
});

test("cursorInInlineExpr: inside a span's expression, not its value or the prose", () => {
  const doc = "cost nc`4 m * 2 ⇒ 8 m` and n`x_1` here";
  const state = EditorState.create({ doc });
  assert.equal(cursorInInlineExpr(state.doc, posOf(doc, "4 m"), cfg), true);
  assert.equal(cursorInInlineExpr(state.doc, posOf(doc, "8 m"), cfg), false, "the materialized value");
  assert.equal(cursorInInlineExpr(state.doc, posOf(doc, "x_1"), cfg), true);
  assert.equal(cursorInInlineExpr(state.doc, posOf(doc, "and"), cfg), false, "prose between spans");
});

test("cursorInInlineExpr: a span inside a numbat block is not an inline scope", () => {
  const doc = ["```numbat", "x n`3 m`", "```"].join("\n");
  const state = EditorState.create({ doc });
  assert.equal(cursorInInlineExpr(state.doc, posOf(doc, "3 m"), cfg), false);
});

test("cursorInFrontmatter: between the delimiters, not on them and not below", () => {
  const doc = ["---", "speed: 80 km/h", "cost: 3 €", "---", "prose"].join("\n");
  const state = EditorState.create({ doc });
  assert.equal(cursorInFrontmatter(state.doc, posOf(doc, "80 km/h")), true);
  assert.equal(cursorInFrontmatter(state.doc, posOf(doc, "3 €")), true);
  assert.equal(cursorInFrontmatter(state.doc, 0), false, "the opening delimiter");
  assert.equal(cursorInFrontmatter(state.doc, posOf(doc, "prose")), false, "below the close");
});

test("cursorInFrontmatter: no opener on line 1, and `...` as the close", () => {
  const prose = EditorState.create({ doc: ["prose", "---", "speed: 3 m", "---"].join("\n") });
  assert.equal(cursorInFrontmatter(prose.doc, prose.doc.line(3).from), false, "not frontmatter at all");
  const dots = ["---", "speed: 3 m", "...", "after"].join("\n");
  const closed = EditorState.create({ doc: dots });
  assert.equal(cursorInFrontmatter(closed.doc, posOf(dots, "3 m")), true);
  assert.equal(cursorInFrontmatter(closed.doc, posOf(dots, "after")), false);
});

test("cursorInNumbatCode: fences always count; spans only with a config", () => {
  const doc = ["```numbat", "2 * 3", "```", "prose n`4 * 5` end"].join("\n");
  const state = EditorState.create({ doc });
  assert.equal(cursorInNumbatCode(state.doc, posOf(doc, "2 * 3"), null), true, "fence, inline eval off");
  assert.equal(cursorInNumbatCode(state.doc, posOf(doc, "4 * 5"), cfg), true, "span, inline eval on");
  assert.equal(cursorInNumbatCode(state.doc, posOf(doc, "4 * 5"), null), false, "span, inline eval off");
  assert.equal(cursorInNumbatCode(state.doc, posOf(doc, "prose"), cfg), false);
});
