// Whether focus leaving a property widget means the reader has left it.
//
// A compact widget (properties/host.ts) tears its editor down when focus leaves, so that a Base
// cell goes back to showing its value. The trouble is that "focus left" is not what a `blur` event
// means. Half of what a Numbat editor offers is drawn *outside* the widget — CodeMirror parents its
// tooltips on `document.body` (views/input.ts), the documentation popup is a `div` there
// (completion/render.ts), Obsidian's suggesters and menus are too — so clicking a completion's
// padding, dragging the doc popup's scrollbar, or reading a hover card all blur the editor while
// the reader is plainly still using it. Alt-tabbing blurs it as well.
//
// Tearing down in any of those cases would destroy the editor mid-edit, which is why this exists.
// Nothing here decides *what* to do; it only answers whether the reader has gone.
//
// **Every question is asked of the row's own window**, never of the module's. A leaf can be popped
// out into a second window with a document of its own, and a `document.hasFocus()` asked of the
// main one is false for the entire time the reader is working in the popout — which would answer
// "not gone" to every departure and leave a cell open for good.

import type SymbatPlugin from "../main";

/**
 * Surfaces that live outside a widget's row but belong to it.
 *
 * `.cm-tooltip` covers the completion popup and the hover card (both CodeMirror tooltips, parented
 * on `document.body` by `tooltips({ parent: document.body })` in views/input.ts);
 * `.numbat-doc-popup` is the dwell documentation popup; the rest are Obsidian's own — the zone
 * field's suggester, a context menu, a modal, the command palette.
 */
const FLOATERS =
  ".cm-tooltip, .numbat-doc-popup, .numbat-hover-tooltip, .suggestion-container, .menu, .modal-container, .prompt";

/**
 * Where the last pointer press landed, anywhere in the app.
 *
 * The only witness to *why* focus left. A press on something unfocusable — a tooltip's padding, a
 * popup's scrollbar, a section header in the completion list — moves `document.activeElement` to
 * `body`, which says nothing about where the reader actually is. The press target says it exactly.
 *
 * Captured, so it is recorded before any handler can stop the event. One witness across every
 * window: there is one reader, and they press in one place at a time.
 */
let lastPointer: Element | null = null;

/** When that press happened. See {@link POINTER_GRACE_MS}. */
let lastPointerAt = 0;

/**
 * How recent a press has to be to be evidence about *this* blur.
 *
 * A press that causes a blur causes it in the same task, so the real gap is a fraction of a
 * millisecond and this is pure headroom. What it rules out is a press from some earlier gesture
 * being read as the cause: click into a cell, type, press **Enter** — the blur is the keypress's,
 * and the last press is the one that opened the cell, still sitting inside the row. Without a
 * deadline that reads as "the reader is still in there" and the cell never closes.
 *
 * The deadline is not the whole answer, because a reader who presses **Enter** within it would fall
 * into exactly that hole — and no second blur would ever come to correct it. So a keystroke retires
 * the witness outright ({@link watchPointerDown}); this covers the pointer gestures that are slow
 * enough to overlap each other, and nothing else has to.
 */
const POINTER_GRACE_MS = 100;

/**
 * Checks this file has undertaken to make later — a deferred question, or one parked until the
 * window comes back or the reader presses somewhere. Each entry cancels its own timer and listener.
 *
 * Held so they can be dropped on unload. A parked question can outlive the plugin by any amount of
 * time (a window the reader never returns to is a listener that never fires), and one that *does*
 * fire afterwards would call back into a widget whose plugin has been torn down.
 */
const pending = new Set<() => void>();

/** Start recording pointer presses, in every window the app has open and any it opens later.
 *  Called once from the plugin's `onload`; the listeners, the witness and any parked question are
 *  all released on unload. */
export function watchPointerDown(plugin: SymbatPlugin): void {
  // Per call rather than module-level, so that re-enabling the plugin re-registers rather than
  // finding every document already "watched" by listeners that unload has since removed.
  const watched = new WeakSet<Document>();
  let loaded = true;
  const watch = (doc: Document): void => {
    // `onLayoutReady` below cannot be cancelled, and a plugin disabled in the moment before the
    // workspace settles would otherwise register listeners into a component with no unload left to
    // remove them.
    if (!loaded || watched.has(doc)) {
      return;
    }

    watched.add(doc);
    plugin.registerDomEvent(doc, "pointerdown", (event) => {
      lastPointer = event.target instanceof Element ? event.target : null;
      lastPointerAt = performance.now();
    }, { capture: true });

    // A keystroke is its own reason for whatever blur follows it, so the press that came before is
    // no longer evidence about anything. See {@link POINTER_GRACE_MS}.
    plugin.registerDomEvent(doc, "keydown", () => {
      lastPointer = null;
    }, { capture: true });
  };

  watch(document);

  // Windows already open when the plugin loads, and windows opened after it.
  plugin.app.workspace.onLayoutReady(() => {
    plugin.app.workspace.iterateAllLeaves((leaf) => watch(leaf.view.containerEl.ownerDocument));
  });
  plugin.registerEvent(plugin.app.workspace.on("window-open", (_leaf, opened) => watch(opened.document)));

  plugin.register(() => {
    loaded = false;
    for (const cancel of [...pending]) {
      cancel();
    }

    lastPointer = null;
  });
}

/**
 * Ask, on the next turn of the event loop, whether the reader has gone from `row` — and call `left`
 * if they have.
 *
 * **This is how a blur handler must ask**, never {@link focusLeft} directly. At the moment a blur
 * fires, `document.activeElement` is still `body` — focus has left the old element and not yet
 * reached the new one — so every check below would answer "gone" for a click that is about to land
 * inside the widget.
 *
 * `ready` is for a host with a reason of its own to say "not yet": the Numbat widget asks it
 * whether its completion popup is open. Answering `false` drops the question rather than deferring
 * it again — the popup owns the field until it closes, and closing it blurs the editor afresh.
 */
export function deferFocusCheck(row: HTMLElement, left: () => void, ready: () => boolean = ALWAYS): void {
  const win = row.ownerDocument.defaultView;
  if (win === null) {
    return; // a document with no window is one nothing will ever be shown in
  }

  let timer = 0;
  const cancel = (): void => {
    win.clearTimeout(timer);
    pending.delete(cancel);
  };

  timer = win.setTimeout(() => {
    cancel();
    if (ready()) {
      whenFocusLeaves(row, left);
    }
  }, 0);
  pending.add(cancel);
}

/** The default {@link deferFocusCheck} gate: nothing to wait for. */
const ALWAYS = (): boolean => true;

/**
 * Whether focus leaving `row` should be read as the reader leaving the field.
 *
 * **Call this from {@link deferFocusCheck}, not from the `blur` handler itself**, for the reason
 * given there.
 *
 * Three ways the answer is no: the window itself lost focus (alt-tab, devtools — the field is still
 * the reader's place and will be there when they come back); focus landed inside the row or on one
 * of the widget's own floating surfaces; or the press that just caused this landed there, whether
 * or not anything focusable was under it.
 */
export function focusLeft(row: HTMLElement): boolean {
  const doc = row.ownerDocument;
  if (!doc.hasFocus()) {
    return false;
  }

  const pressed = performance.now() - lastPointerAt <= POINTER_GRACE_MS ? lastPointer : null;
  return !belongs(row, doc.activeElement) && !belongs(row, pressed);
}

/**
 * Call `left` once it is clear the reader has gone from `row` — now, or at the next moment the
 * question has a better answer than it has today.
 *
 * That second half is what {@link focusLeft} on its own cannot do, because the blur that asked the
 * question has already happened and no second one will follow: the element is blurred and stays
 * blurred. There are two ways to be left holding an answer that is right now and wrong later, and
 * both park rather than conclude:
 *
 *  - **The window is not the reader's.** Answering "not gone" is right, but a field left open by an
 *    alt-tab would stay open for good, and clicking into another cell on the way back would leave
 *    two of them open at once. Asked again on the window's `focus`, the question has a real answer.
 *  - **Focus is parked outside the row.** A press on a floating surface that took the focus with it
 *    — the command palette over an open cell — is not a departure, but nothing about it will ever
 *    become one on its own. The next press anywhere is the moment to ask again: by then the reader
 *    has either come back to the field or gone somewhere that says they have not.
 *
 * Both are asked again from a timeout, for the reason {@link deferFocusCheck} gives.
 */
export function whenFocusLeaves(row: HTMLElement, left: () => void): void {
  const doc = row.ownerDocument;
  const win = doc.defaultView;
  if (win === null) {
    return;
  }

  if (!doc.hasFocus()) {
    askAgainOn(win, "focus", row, left);
    return;
  }

  if (focusLeft(row)) {
    left();
    return;
  }

  // Focus inside the row is the ordinary "not gone": an ordinary blur will follow later, as usual,
  // and there is nothing to park.
  if (!row.contains(doc.activeElement)) {
    askAgainOn(win, "pointerdown", row, left);
  }
}

/** Park the question until `type` fires on `win`, then ask it again. Registered in {@link pending},
 *  so unload drops it — listener, timer and all. */
function askAgainOn(win: Window, type: "focus" | "pointerdown", row: HTMLElement, left: () => void): void {
  // Captured for `pointerdown`, matching the witness above, so the press cannot be swallowed before
  // this sees it. `once` does the removal in the ordinary case; `cancel` covers unload.
  const capture = type === "pointerdown";
  let timer = 0;

  const cancel = (): void => {
    win.removeEventListener(type, fired, capture);
    win.clearTimeout(timer);
    pending.delete(cancel);
  };

  // Deferred rather than answered here: this runs *before* the witness above (a window handler
  // captures ahead of a document one), and before focus has landed anywhere.
  const fired = (): void => {
    timer = win.setTimeout(() => {
      cancel();
      whenFocusLeaves(row, left);
    }, 0);
  };

  pending.add(cancel);
  win.addEventListener(type, fired, { once: true, capture });
}

/** Whether an element is part of `row` or of a surface drawn on its behalf. */
function belongs(row: HTMLElement, target: Element | null): boolean {
  return target !== null && (row.contains(target) || target.closest(FLOATERS) !== null);
}
