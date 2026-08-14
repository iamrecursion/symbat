// The rule that decides which boxes a focused property widget is let out of. The walk itself is
// DOM, but what it asks of each box on the way up is not, and it is the part with a trap in it:
// a computed style with one axis `visible` and the other not turns the visible one into `auto`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { overflowRole } from "../../../src/properties/host.ts";

test("a box that lets its contents out needs nothing done to it", () => {
  assert.equal(overflowRole("visible", "visible"), "visible");
});

test("a box that cuts its contents off on both axes is one to lift", () => {
  assert.equal(overflowRole("hidden", "hidden"), "clips");
  assert.equal(overflowRole("clip", "clip"), "clips");
  // `clip` and `hidden` differ in whether the box could be scrolled programmatically, which is not
  // a difference to a value being drawn outside it.
  assert.equal(overflowRole("hidden", "clip"), "clips");
});

test("a box that clips one axis and leaves the other alone still clips", () => {
  // `clip` is exempt from the coercion the next test describes — it is not `visible`, so it neither
  // forces the other axis to `auto` nor becomes `auto` itself. So this pair survives the cascade
  // exactly as written, and it cuts a focused row off in the one direction the row grows in.
  assert.equal(overflowRole("clip", "visible"), "clips");
  assert.equal(overflowRole("visible", "clip"), "clips");
});

test("a scroll container is left alone, on either axis", () => {
  assert.equal(overflowRole("auto", "auto"), "scrolls");
  assert.equal(overflowRole("scroll", "scroll"), "scrolls");
  assert.equal(overflowRole("auto", "visible"), "scrolls");
  assert.equal(overflowRole("visible", "scroll"), "scrolls");
});

test("clipping on one axis alone is scrolling, because that is what the cascade made of it", () => {
  // `overflow-x: hidden; overflow-y: visible` does not compute to what it was written as: the
  // visible axis becomes `auto`. So this pair is what a *scroll container* looks like from here,
  // and lifting it would destroy the scrolling rather than reveal anything.
  assert.equal(overflowRole("hidden", "auto"), "scrolls");
  assert.equal(overflowRole("auto", "hidden"), "scrolls");
  assert.equal(overflowRole("clip", "auto"), "scrolls");
});

test("a box that clips one axis and scrolls the other is a scroll container", () => {
  // These are the pairs that make the order of the two tests load-bearing: both `isScroll` and
  // `isClip` hold of them, and scrolling is asked first, because a box that scrolls at all is one
  // whose clipping *is* its scrolling.
  assert.equal(overflowRole("hidden", "scroll"), "scrolls");
  assert.equal(overflowRole("scroll", "hidden"), "scrolls");
  assert.equal(overflowRole("clip", "scroll"), "scrolls");
});
