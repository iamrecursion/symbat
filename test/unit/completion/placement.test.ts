import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AnchorRect,
  isLiveAnchor,
  isVisibleAnchor,
  POPUP_GAP,
  popupPlacement,
  type Viewport,
  VIEWPORT_MARGIN,
} from "../../../src/completion/placement.ts";

/** An anchor rectangle, as a `DOMRect` would report one. */
function anchor(left: number, top: number, width: number, height: number): AnchorRect {
  return { left, top, bottom: top + height, width, height };
}

/** The popup's own measured size; tall enough that "is there room above" is a real question. */
const CARD = { width: 320, height: 200 };

/** A comfortably large viewport, so a case has to opt in to being clamped on either axis. */
const WIDE: Viewport = { width: 1600, height: 1200 };

/** {@link WIDE} narrowed, for the cases that clamp horizontally. */
function widthOf(width: number): Viewport {
  return { width, height: WIDE.height };
}

/** {@link WIDE} shortened, for the cases that clamp vertically. */
function heightOf(height: number): Viewport {
  return { width: WIDE.width, height };
}

// --- the anchor has to be somewhere ------------------------------------------

// The regression test for the stranded card: a completer that has closed hands back a detached
// element, and a detached element measures as all zeros. Placed rather than refused, that lands the
// card in the corner of the window, where nothing is left watching to take it down.
test("an all-zero anchor is not a position, and has no placement", () => {
  assert.equal(isLiveAnchor(anchor(0, 0, 0, 0)), false);
  assert.equal(popupPlacement(anchor(0, 0, 0, 0), CARD, WIDE), null);
});

test("an anchor genuinely at the origin still places, so long as it has extent", () => {
  const at = anchor(0, 0, 240, 30);
  assert.equal(isLiveAnchor(at), true);
  assert.notEqual(popupPlacement(at, CARD, WIDE), null);
});

// Only both-zero is refused: this is the last line of defense, and the callers that can tell open
// from closed properly are stricter on their own behalf.
test("extent in one dimension is enough to count as on-screen", () => {
  assert.equal(isLiveAnchor(anchor(40, 400, 240, 0)), true);
  assert.equal(isLiveAnchor(anchor(40, 400, 0, 30)), true);
});

// --- above, or below when there is no room -----------------------------------

test("the popup prefers to sit above the anchor, one gap clear of it", () => {
  const placement = popupPlacement(anchor(500, 700, 240, 30), CARD, WIDE);

  assert.deepEqual(placement, { left: 500, top: 700 - CARD.height - POPUP_GAP });
});

test("it flips below when sitting above would clip off the top of the screen", () => {
  const at = anchor(500, 100, 240, 30);
  const placement = popupPlacement(at, CARD, WIDE);

  assert.deepEqual(placement, { left: 500, top: at.bottom + POPUP_GAP });
});

// The boundary itself belongs to `above`: landing exactly on the margin is still on-screen.
test("an anchor leaving exactly the margin above it does not flip", () => {
  const top = VIEWPORT_MARGIN + CARD.height + POPUP_GAP;
  const placement = popupPlacement(anchor(500, top, 240, 30), CARD, WIDE);

  assert.deepEqual(placement, { left: 500, top: VIEWPORT_MARGIN });
});

// --- clamping to the viewport ------------------------------------------------

test("a popup wider than the space to the anchor's right is pulled back onto the screen", () => {
  const viewport = widthOf(900);
  const placement = popupPlacement(anchor(800, 700, 60, 30), CARD, viewport);

  assert.equal(placement?.left, viewport.width - CARD.width - VIEWPORT_MARGIN);
});

test("an anchor near the left edge does not push the popup past the margin", () => {
  const placement = popupPlacement(anchor(2, 700, 60, 30), CARD, WIDE);

  assert.equal(placement?.left, VIEWPORT_MARGIN);
});

// A viewport too narrow to hold the popup at all: the left margin wins over the right one, so the
// card starts on-screen and overflows to the right rather than starting off it.
test("a viewport narrower than the popup keeps the left margin rather than the right", () => {
  const placement = popupPlacement(anchor(40, 700, 60, 30), CARD, widthOf(200));

  assert.equal(placement?.left, VIEWPORT_MARGIN);
});

// --- and to the bottom, once it has flipped ----------------------------------

// The flip only fires near the top of the screen, so overflowing the bottom takes a tall anchor as
// well as a tall card — a full-height completer, which is exactly what the popover can be.
test("a flipped popup that would hang off the bottom is pulled back up", () => {
  const viewport = heightOf(500);
  const placement = popupPlacement(anchor(500, 20, 240, 400), CARD, viewport);

  assert.equal(placement?.top, viewport.height - CARD.height - VIEWPORT_MARGIN);
});

// Neither margin can be honored when the card does not fit below the anchor at all. The top wins,
// so the card is readable from its first line rather than clipped by an edge nothing can scroll.
test("a viewport too short to hold the flipped popup keeps the top margin rather than the bottom", () => {
  const placement = popupPlacement(anchor(500, 20, 240, 100), CARD, heightOf(150));

  assert.equal(placement?.top, VIEWPORT_MARGIN);
});

// --- the stricter test the callers holding the element use -------------------

// A parked anchor: CodeMirror moves a completion tooltip to `top: -10000px` when its editor scrolls
// out of view rather than removing it, so it is live, measurable, and nowhere the reader can see.
test("an anchor parked off the top of the screen is live but not visible", () => {
  const parked = anchor(0, -10000, 240, 30);

  assert.equal(isLiveAnchor(parked), true);
  assert.equal(isVisibleAnchor(parked, WIDE.height), false);
});

test("an anchor below the bottom of the screen is not visible either", () => {
  assert.equal(isVisibleAnchor(anchor(500, WIDE.height + 40, 240, 30), WIDE.height), false);
});

test("an anchor with no height is not visible, whatever its width", () => {
  assert.equal(isVisibleAnchor(anchor(500, 400, 240, 0), WIDE.height), false);
});

test("an anchor straddling an edge is still visible, being partly on screen", () => {
  assert.equal(isVisibleAnchor(anchor(500, -10, 240, 30), WIDE.height), true);
  assert.equal(isVisibleAnchor(anchor(500, WIDE.height - 10, 240, 30), WIDE.height), true);
});

test("an ordinary on-screen anchor is visible", () => {
  assert.equal(isVisibleAnchor(anchor(500, 400, 240, 30), WIDE.height), true);
});
