// Which surface a property widget has been rendered into, and so how much room it has.
//
// Obsidian draws a note's properties through one registry (`metadataTypeManager`), and Bases draws
// a table or card cell through the *same* one — so a single `render(el, value, ctx)` serves the
// frontmatter editor, the Properties sidebar, a hover popover, and a Base cell, with nothing in the
// context to say which. The two want opposite things. A property row is a line of its own and can
// afford an always-live editor with its value beside it; a Base cell is a box in a grid, and an
// editor that wraps in one shows the vertical middle of its own value.
//
// This is the whole of the distinction, in one place, because it is a guess about undocumented DOM
// and should be one guess rather than three.

/** Where a property widget is being drawn. */
export type PropertyHost =
  /** A property *row* — the note's frontmatter editor, the Properties sidebar, a hover popover.
   *  Full width, its own line, and the widget it has always had. */
  | "panel"
  /** Anything else, which today means a Bases table or card cell: a box with a fixed width, where
   *  the widget shows a value until it is clicked into. */
  | "compact";

/**
 * What the metadata editor wraps every property row in. Obsidian's own long-standing class names —
 * far more stable than anything Bases-side, which is why the test is written as "is this the
 * properties panel?" rather than "is this a Base?".
 */
const PANEL_MARKERS = ".metadata-property, .metadata-properties, .metadata-container";

/**
 * The host `el` is being rendered into.
 *
 * **This answers correctly while `el` is still detached**, which is the only reason it can be
 * called from `render` at all: Obsidian renders a property row into a detached element and inserts
 * it afterwards (properties/type.ts's `liveEditors` note is the long version). `closest` walks
 * `parentElement` links rather than the document, so a row already built around the widget's
 * element is found whether or not the tree it is in has been inserted yet.
 *
 * **The guess is deliberately biased to `compact`**, and the asymmetry is load-bearing. Answering
 * `panel` for what is really a Base cell builds a full CodeMirror editor per visible row, on every
 * scroll pass, and throws each away a frame later. Answering `compact` for what is really a panel
 * row costs one frame of text before the editor is built. The first is a table nobody can scroll;
 * the second is invisible. So an inconclusive DOM answers `compact`, and callers correct in the
 * other direction only.
 */
export function hostFor(el: HTMLElement): PropertyHost {
  return el.closest(PANEL_MARKERS) === null ? "compact" : "panel";
}

/**
 * The host `el` is in: answered now, and answered again once the tree it sits in is certainly
 * complete.
 *
 * {@link hostFor} is documented to work on a detached element, and as far as anyone can tell it
 * does — but "as far as anyone can tell" is the whole problem with a registry Obsidian does not
 * document. Being in the document is the first moment the question has an answer that cannot be a
 * guess, so it is asked again there, and only ever revised the safe way round (see the bias above).
 *
 * **Every widget must resolve its host through this**, not through `hostFor` directly. The two
 * widgets that draw property values are the same guess about the same undocumented DOM; one of them
 * quietly not correcting is how a Zoned Date ends up as a click-to-edit cell in the properties
 * panel, and how nobody notices for a release.
 *
 * Returns a **thunk**, because the answer moves under its callers: a handler written against a
 * captured value would go on behaving as a cell after the row it is in turned out to be a panel
 * row. `corrected` runs once at most, and only for `compact` → `panel`.
 */
export function resolveHost(el: HTMLElement, corrected: () => void): () => PropertyHost {
  let host = hostFor(el);
  const win = windowFor(el);
  if (host === "panel" || win === null) {
    return () => host;
  }

  // Asked over a few frames rather than one. A row that is *not yet* in the document is not a row
  // that never will be, and giving up on the first frame would leave a property panel that Obsidian
  // took two frames to insert behaving as a click-to-edit cell for the rest of its life.
  let frames = HOST_RETRY_FRAMES;
  const recheck = (): void => {
    // A row Obsidian discarded before it ever reached the document is not in a host at all — and
    // its ancestors may still answer, detached, whatever they would have answered. Correcting one
    // builds an editor into an element nothing will ever show, focus, or sweep — and nothing will
    // ever sweep the editor either, since the sweep keys off having been seen in the document.
    if (!el.isConnected) {
      frames -= 1;
      if (frames > 0) {
        win.requestAnimationFrame(recheck);
      }
      return;
    }

    if (hostFor(el) === "panel") {
      host = "panel";
      corrected();
    }
  };

  win.requestAnimationFrame(recheck);
  return () => host;
}

/** How many frames {@link resolveHost} waits for a row to reach the document before concluding it
 *  never will. Enough for an insertion a frame or two behind the render, few enough that a widget
 *  Obsidian threw away is not held for any length of time. */
const HOST_RETRY_FRAMES = 3;

/**
 * The window `el` belongs to, which is not always the one this module was loaded into: a leaf
 * popped out into a second window draws its property widgets in a document of its own, and a frame
 * or a timer asked of the main window is the wrong window's.
 *
 * `null` for a document detached from any window — nothing drawn there will ever be shown, so a
 * caller that cannot schedule its work has nothing to do.
 */
export function windowFor(el: HTMLElement): Window | null {
  return el.ownerDocument.defaultView;
}

/** The class a compact widget carries, and the only thing styles.css keys off. The stylesheet
 *  never names an Obsidian DOM class: everything it needs to know is decided here. */
export const COMPACT_CLASS = "numbat-property-compact";

/** The class a compact widget carries *while it holds a live editor* — the "clicked into" state.
 *  Idle is the absence of it. */
export const ACTIVE_CLASS = "is-active";

/**
 * How far up to look for the boxes that cut a focused widget off at its cell's edge. Enough for a
 * cell inside a row inside a body inside a table, and few enough that a stylesheet nothing to do
 * with this can never be reached.
 */
const UNCLIP_DEPTH = 6;

/**
 * Let a focused widget overflow the cell it sits in, and give back the undo.
 *
 * A focused editor is wider than the column it lives in — a date picker has no useful narrow form,
 * and squeezing one produces a date with the digits crushed out of it. Sizing the widget to its
 * content is only half the answer: a Bases cell clips, so the part that does not fit is simply not
 * drawn. No stylesheet of ours can say otherwise, because the box doing the clipping is Obsidian's,
 * and naming it is exactly what this file exists to avoid.
 *
 * So the boxes are found by *behavior* rather than by name — walking up and asking each what it
 * computes to — and marked with a class of ours for as long as the widget is focused. **The walk
 * stops at anything that scrolls.** A scroll container clips because that is what scrolling *is*:
 * making one `visible` would not reveal what lies outside it, it would destroy the scrolling. The
 * table's own viewport is left alone, and a value wide enough to reach it is cut off there, which
 * is correct.
 *
 * **The marks are counted** ({@link mark}), because the boxes above the innermost one are shared:
 * two cells in a row have every ancestor in common but their own. Two can be focused at once, for
 * one turn of the event loop — pressing a second cell builds and focuses it before the first one's
 * deferred departure check runs — and an uncounted undo would then strip the mark the *second* one
 * is relying on. The returned undo is idempotent for the same reason it is counted: a row can be
 * swept and then deactivate anyway, and a second undo must not decrement a third row's mark.
 */
export function unclipHost(el: HTMLElement): () => void {
  const marked: Array<[HTMLElement, string]> = [];
  const win = windowFor(el);
  if (win === null) {
    return () => {};
  }

  const body = el.ownerDocument.body;
  let node = el.parentElement;
  for (let depth = 0; node !== null && node !== body && depth < UNCLIP_DEPTH; depth += 1) {
    const style = win.getComputedStyle(node);
    const role = overflowRole(style.overflowX, style.overflowY);
    if (role === "scrolls") {
      break;
    }

    if (role === "clips") {
      // The innermost box that clips is the cell itself — the one drawing the border and the focus
      // ring around what the reader is editing. Letting its contents out is only half of it: a
      // border still ends where its box ends, so a cell left at the column's width draws a ring
      // through the middle of the value it now contains. It grows too.
      if (marked.length === 0) {
        // Its width now — before it is marked, since the mark is what grows it — so that growing to
        // fit the value cannot also *shrink* it below the column it belongs to. Measured rather
        // than written as `min-width: 100%`, because a percentage resolves against the containing
        // block, which for a cell in a flex row is the whole row, and asks for a cell as wide as
        // the table.
        if (markCount(node, UNCLIPPED_CELL_CLASS) === 0) {
          node.setCssProps({ [UNCLIPPED_FLOOR_PROP]: `${node.getBoundingClientRect().width}px` });
        }

        mark(node, UNCLIPPED_CELL_CLASS);
        marked.push([node, UNCLIPPED_CELL_CLASS]);

        // Growing it makes it overlap the cell beside it, and an overlap is decided by paint order:
        // a later sibling's background covers an earlier sibling's border. Lifting it out of that
        // order needs it positioned — but only where it is not already, since replacing whatever
        // positioning a virtualised table gave its cells would move them.
        if (style.position === "static") {
          mark(node, UNCLIPPED_LIFT_CLASS);
          marked.push([node, UNCLIPPED_LIFT_CLASS]);
        }
      }

      mark(node, UNCLIPPED_CLASS);
      marked.push([node, UNCLIPPED_CLASS]);
    }

    node = node.parentElement;
  }

  return () => {
    for (const [target, cls] of marked) {
      // The floor goes with the class that reads it, once the last row wanting it has gone.
      if (unmark(target, cls) && cls === UNCLIPPED_CELL_CLASS) {
        target.setCssProps({ [UNCLIPPED_FLOOR_PROP]: "" });
      }
    }

    marked.length = 0;
  };
}

/**
 * How many focused rows are currently relying on `cls` being on `node`.
 *
 * Kept here rather than read back off the element, because the class is the *effect* and this is
 * the count: `hasClass` cannot tell one row's mark from two rows' marks, which is the entire
 * question.
 *
 * The elements counted are **Obsidian's own**, and a virtualised table discards them freely — so
 * this holds them weakly, and drops each as its last mark goes. Neither on its own would be enough:
 * the entries are cleaned up because leaving a stale count would be wrong, and the map is weak
 * because a cell thrown away mid-edit is a cell whose count is never given back.
 */
const markCounts = new WeakMap<HTMLElement, Map<string, number>>();

/** Count of the rows relying on `cls` on `node`. */
function markCount(node: HTMLElement, cls: string): number {
  return markCounts.get(node)?.get(cls) ?? 0;
}

/** Take a mark on `node`, adding the class if this is the first. */
function mark(node: HTMLElement, cls: string): void {
  let counts = markCounts.get(node);
  if (counts === undefined) {
    counts = new Map();
    markCounts.set(node, counts);
  }

  const next = markCount(node, cls) + 1;
  counts.set(cls, next);
  if (next === 1) {
    node.addClass(cls);
  }
}

/** Give a mark back. Returns whether that was the last one, and so whether the class came off. */
function unmark(node: HTMLElement, cls: string): boolean {
  const counts = markCounts.get(node);
  const count = counts?.get(cls) ?? 0;
  if (counts === undefined || count === 0) {
    return false;
  }

  if (count > 1) {
    counts.set(cls, count - 1);
    return false;
  }

  counts.delete(cls);
  if (counts.size === 0) {
    markCounts.delete(node);
  }

  node.removeClass(cls);
  return true;
}

/** The class {@link unclipHost} marks a clipping ancestor with. Carried by elements this plugin
 *  does not own, so it is removed again exactly, and its rule in styles.css is deliberately
 *  narrow. */
export const UNCLIPPED_CLASS = "numbat-unclipped";

/** {@link UNCLIPPED_CLASS} for the innermost clipping box — the cell, which grows with its contents
 *  so that its border and focus ring still describe them. */
export const UNCLIPPED_CELL_CLASS = "numbat-unclipped-cell";

/** Applied beside {@link UNCLIPPED_CELL_CLASS} on a cell that is not already positioned, so it can
 *  paint over the one it now overlaps. Separate because positioning a cell that a table has
 *  positioned itself would move it. */
export const UNCLIPPED_LIFT_CLASS = "numbat-unclipped-lift";

/** The width a grown cell may not go below: whatever it was before it grew, in pixels. Carried as a
 *  custom property because only this side knows the number — see {@link unclipHost}. */
const UNCLIPPED_FLOOR_PROP = "--numbat-unclipped-floor";

/** What a box does with contents that do not fit, as far as {@link unclipHost} cares. */
export type OverflowRole =
  /** Scrolls on at least one axis. Its clipping *is* its scrolling, so it is never lifted, and the
   *  walk stops at it: nothing outside it would be revealed by going further. */
  | "scrolls"
  /** Cuts its contents off without scrolling them — the boxes this lifts. */
  | "clips"
  /** Lets its contents out already, and needs nothing. */
  | "visible";

/**
 * How a box treats what does not fit, from its two computed overflow values.
 *
 * **Scrolling is asked first, and it settles the mixed cases.** A computed style with one axis
 * `visible` and the other neither `visible` nor `clip` turns the visible one into `auto` — so
 * `overflow-x: hidden` alone reaches here as `hidden`/`auto`, and that pair is a scroll container
 * rather than a clipping box, whatever the stylesheet said. Testing for a scroll before testing for
 * a clip is what tells the two apart, and it is why *either* axis clipping is then enough: by that
 * point nothing that scrolls is left to mistake for a box that merely cuts its contents off.
 *
 * That last part is not a generalization for its own sake. `clip` is **exempt** from the coercion
 * above — it is not `visible`, so it does not force the other axis to `auto`, and it does not
 * become `auto` itself — which makes `overflow-x: clip; overflow-y: visible` a real computed pair
 * that reaches here intact. It clips horizontally, which is the one direction a focused row grows
 * in, and demanding both axes would wave it through as `visible` and leave the row cut off at the
 * cell's edge with nothing to say so.
 *
 * Taken as two strings rather than a `CSSStyleDeclaration` so the rule can be stated — and tested —
 * without a DOM.
 */
export function overflowRole(overflowX: string, overflowY: string): OverflowRole {
  if (isScroll(overflowX) || isScroll(overflowY)) {
    return "scrolls";
  }

  return isClip(overflowX) || isClip(overflowY) ? "clips" : "visible";
}

function isScroll(value: string): boolean {
  return value === "auto" || value === "scroll";
}

function isClip(value: string): boolean {
  return value === "hidden" || value === "clip";
}
