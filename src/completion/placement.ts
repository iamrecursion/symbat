// Where the documentation popup goes: prefer above the thing it describes, flip below when there is
// no room, clamp to both axes of the viewport, and refuse an anchor that is not a rectangle.
//
// The popup is a fixed-position element under `document.body`, so a degenerate anchor does not make
// it disappear but instead it makes it land in the corner of the window and stay there, outliving
// whatever opened it. A completer that has closed hands back exactly that: Obsidian detaches the
// popover element, and a detached element measures as all zeros.

/** Gap between the popup and the thing it is anchored to, in px. */
export const POPUP_GAP = 6;

/** Minimum inset from the viewport edges when clamping, in px. */
export const VIEWPORT_MARGIN = 8;

/** The part of a `DOMRect` an anchor is read for. */
export interface AnchorRect {
  /** Distance from the viewport's left edge to the anchor's left, in px. */
  left: number;

  /** Distance from the viewport's top edge to the anchor's top, in px. */
  top: number;

  /** Distance from the viewport's top edge to the anchor's bottom, in px. */
  bottom: number;

  /** The anchor's width, in px. */
  width: number;

  /** The anchor's height, in px. */
  height: number;
}

/** A measured size, in px. */
export interface Size {
  /** Width in px. */
  width: number;

  /** Height in px. */
  height: number;
}

/** The area the popup has to fit inside, in px. */
export interface Viewport {
  /** The viewport's width in px, i.e. `window.innerWidth`. */
  width: number;

  /** The viewport's height in px, i.e. `window.innerHeight`. */
  height: number;
}

/** Viewport coordinates for the popup's top-left corner, in px. */
export interface Placement {
  /** Distance from the viewport's left edge, in px. */
  left: number;

  /** Distance from the viewport's top edge, in px. */
  top: number;
}

/**
 * Whether `anchor` describes something with a place on the screen.
 *
 * An all-zero rect is what a detached — or `display: none` — element measures as, and it is not a
 * position near the origin, it is the absence of one. Rejecting it here is what keeps a popup from
 * being placed against a thing that is no longer there.
 *
 * Only the *both* zero case is rejected, deliberately: this is the last line of defense rather than
 * the first, and a caller in a better position to tell open from closed (completion/suggest.ts asks
 * the popover directly) can be stricter without this having to guess on its behalf. The stricter
 * test those callers reach for is {@link isVisibleAnchor}, and the two thresholds differing is the
 * point rather than an oversight.
 */
export function isLiveAnchor(anchor: AnchorRect): boolean {
  return anchor.width > 0 || anchor.height > 0;
}

/**
 * Whether `anchor` is somewhere the reader can actually see, in a viewport `viewportHeight` tall.
 *
 * Stronger than {@link isLiveAnchor} in the way a caller holding the element can afford to be: it
 * demands real height, and it demands that the anchor overlap the screen vertically rather than
 * merely have a size.
 *
 * That second demand is what catches a *parked* anchor, which is a live element in a stale place.
 * CodeMirror does not remove a completion tooltip when its editor scrolls out of view; it moves it
 * to `top: -10000px` and leaves it in the document, so it still answers a `querySelector` and still
 * measures as a perfectly good rectangle. Anchoring a card to that puts the card ten thousand
 * pixels above the screen — no more use than the corner of the window, and just as hard to notice
 * in testing.
 */
export function isVisibleAnchor(anchor: AnchorRect, viewportHeight: number): boolean {
  return anchor.height > 0 && anchor.bottom > 0 && anchor.top < viewportHeight;
}

/**
 * Where a popup of `size` goes when anchored to `anchor` inside `viewport`, or `null` when `anchor`
 * is not on the screen and there is nowhere to put it.
 *
 * Both axes end in the same clamp, and for the same reason: the popup is `position: fixed`, so an
 * edge it runs past is an edge nothing can scroll it back from. The axes differ only in what they
 * clamp — the horizontal one clamps the single candidate the anchor's left edge offers, while the
 * vertical one first picks between above and below.
 */
export function popupPlacement(anchor: AnchorRect, size: Size, viewport: Viewport): Placement | null {
  if (!isLiveAnchor(anchor)) {
    return null;
  }

  const maxLeft = viewport.width - size.width - VIEWPORT_MARGIN;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(anchor.left, maxLeft));

  // Prefer above; drop below only when it would clip off the top of the screen.
  const above = anchor.top - size.height - POPUP_GAP;
  if (above >= VIEWPORT_MARGIN) {
    return { left, top: above }; // already clear of the top, and it ends no lower than the anchor
  }

  // Below, pulled back up if the popup would run off the bottom. A tall popup under a tall anchor
  // can be too big for either margin to be honored, and the top wins that: a popup pulled up over
  // its anchor is at least readable from its first line, whereas one hanging off the bottom is
  // clipped by the viewport with nothing left to scroll it into view.
  const maxTop = viewport.height - size.height - VIEWPORT_MARGIN;
  return { left, top: Math.max(VIEWPORT_MARGIN, Math.min(anchor.bottom + POPUP_GAP, maxTop)) };
}
