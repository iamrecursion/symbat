// The markup of this plugin's own copies of Obsidian's icons. Two coordinate systems meet in it,
// and the attributes that make a glyph visible live on a root that copying its markup leaves
// behind — so both are pinned here.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ICON_SCALE, ICON_TINT_CLASS, tintedIconContent } from "../../../src/properties/icon-svg.ts";

/** What Obsidian's Lucide roots carry, as `getIcon` hands them over. */
const LUCIDE_ROOT = {
  "fill": "none",
  "stroke": "currentColor",
  "stroke-width": "2",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
  "stroke-miterlimit": null,
};

test("the copy is scaled from Lucide's box into the one addIcon wraps it in", () => {
  assert.equal(ICON_SCALE, 100 / 24);
  assert.match(tintedIconContent("<path d='M0 0' />", LUCIDE_ROOT), /transform="scale\(4\.166667\)"/);
});

test("the stroke width is copied across untouched", () => {
  // Deliberately *not* divided by the scale. The transform makes the group's user space Lucide's
  // own 24-unit space, and a stroke width is a length in that space — so `2` is the native weight,
  // and a "helpful" rescale to 0.48 would draw hairlines. This test is the guard against that.
  assert.match(tintedIconContent("", LUCIDE_ROOT), /stroke-width="2"/);
});

test("the attributes a bare copy would lose are carried over", () => {
  const content = tintedIconContent("", LUCIDE_ROOT);
  // `fill` defaults to black and `stroke` to none, so dropping either turns the glyph into a
  // silhouette or into nothing at all.
  assert.match(content, /fill="none"/);
  assert.match(content, /stroke="currentColor"/);
  assert.match(content, /stroke-linecap="round"/);
  assert.match(content, /stroke-linejoin="round"/);
});

test("an attribute the source does not carry is left out rather than guessed at", () => {
  const content = tintedIconContent("", LUCIDE_ROOT);
  assert.equal(content.includes("stroke-miterlimit"), false);
  assert.equal(tintedIconContent("", {}), `<g class="${ICON_TINT_CLASS}" transform="scale(4.166667)"></g>`);
});

test("the copy carries the class the stylesheet tints", () => {
  assert.match(tintedIconContent("", LUCIDE_ROOT), new RegExp(`<g class="${ICON_TINT_CLASS}"`));
});

test("the source's own markup is passed through as it stands", () => {
  const inner = "<path d=\"M8 2v4\" /><circle cx=\"12\" cy=\"12\" r=\"3\" />";
  assert.equal(tintedIconContent(inner, {}).includes(inner), true);
});

test("an attribute value that could close the tag early is escaped", () => {
  const content = tintedIconContent("", { stroke: "\"><script>", fill: "a & b" });
  assert.equal(content.includes("<script>"), false);
  assert.match(content, /stroke="&quot;&gt;&lt;script&gt;"/);
  assert.match(content, /fill="a &amp; b"/);
});
