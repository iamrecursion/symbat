// How far whatever sits at the bottom of the mobile screen reaches into a view.
//
// The REPL docks its input row above the on-screen keyboard, and the `.nbt` editor docks its key
// bar there; both need the same measurement, and both need to know whether that keyboard is up at
// all. This is that, once. The leaf helpers it reads events with are in `views/mobile-keyboard.ts`,
// which stays free of `obsidian` so it can be unit-tested; this file cannot, since the answer
// depends on `Platform` and the listeners outlive nothing but their `Component`.
//
// The scope inspector deliberately does not use this — see docs/architecture.md.

import { type Component, Platform } from "obsidian";
import { KEYBOARD_EVENT_NAMES, keyboardHeightOf } from "./mobile-keyboard";

/** What a {@link SoftKeyboardTracker} is measuring, and who to tell when it moves. */
export interface SoftKeyboardTrackerOptions {
  /** The element whose bottom edge the obstruction is measured against — the view's `contentEl`. */
  target: HTMLElement;

  /** Also dodge Obsidian's desktop status bar, which floats over the bottom-right of the workspace
   *  and so covers a view docked in the sidebar's bottom split. Off by default: a view that only
   *  ever fills the main area has nothing to dodge there. */
  statusBar?: boolean;

  /** Called when {@link SoftKeyboardTracker.inset} or {@link SoftKeyboardTracker.isUp} moved —
   *  never for a re-measurement that landed on the same values. Both read back off the tracker, and
   *  both are already the new ones by the time this runs. */
  changed(): void;
}

/**
 * How far whatever sits at the bottom of the screen reaches into a view, tracked live.
 *
 * Two obstructions are handled:
 *
 *   * The on-screen keyboard on mobile. Preferred from the visual viewport where it shrinks for the
 *     keyboard; otherwise from the height Capacitor reports, since Obsidian's iOS WebView overlays
 *     the keyboard without shrinking anything.
 *   * Obsidian's status bar on desktop, with `statusBar` — and only when it actually floats over
 *     the target horizontally.
 *
 * The larger overlap wins. The tracker owns its listeners (torn down with the `owner` component)
 * and the change detection; what to *do* with the inset — which CSS variable to write, what else to
 * re-sync — is the caller's, in `changed`.
 *
 * The window-level listeners are registered on every platform, because `visualViewport` is also how
 * a desktop window resize is noticed; only {@link isUp} is mobile-gated.
 */
export class SoftKeyboardTracker {
  /** What is being measured, and who to notify. */
  private readonly options: SoftKeyboardTrackerOptions;

  /** Height (CSS px) of the on-screen keyboard from Capacitor's keyboard events; `0` while it is
   *  closed, and always `0` on desktop (the events never fire there). */
  private keyboardHeight = 0;

  /** The overlap as of the last measurement — what {@link inset} answers with, and what `changed`
   *  fires on a move away from. Seeded in the constructor so the caller's opening read is a real
   *  measurement rather than a zero it would have to correct. */
  private lastInset: number;

  /** The last `isUp()` reported, so `changed` fires only on a real move: the keyboard's height can
   *  change (a predictive-text row appearing) without the inset moving, and vice versa. */
  private lastUp = false;

  /** @param owner the component whose lifetime the listeners share.
   *  @param options what to measure, and who to tell. */
  constructor(owner: Component, options: SoftKeyboardTrackerOptions) {
    this.options = options;
    this.lastInset = this.measure();

    // The visual viewport shrinks for the keyboard where the platform supports it (Android, and
    // some iOS), and moves for a desktop window resize.
    const viewport = window.visualViewport;
    if (viewport) {
      const onViewportChange = (): void => this.remeasure();
      viewport.addEventListener("resize", onViewportChange);
      viewport.addEventListener("scroll", onViewportChange);
      owner.register(() => {
        viewport.removeEventListener("resize", onViewportChange);
        viewport.removeEventListener("scroll", onViewportChange);
      });
    }

    // Obsidian's iOS WebView overlays the keyboard without reflowing the layout or shrinking the
    // visual viewport, so the reliable signal there is the Capacitor keyboard events it dispatches
    // on `window`, which carry the exact height. The one handler serves show and hide (hide events
    // report no height, i.e. `0`).
    if (Platform.isMobile) {
      const onKeyboard = (evt: Event): void => {
        this.keyboardHeight = keyboardHeightOf(evt);
        this.remeasure();
      };

      for (const name of KEYBOARD_EVENT_NAMES) {
        window.addEventListener(name, onKeyboard);
        owner.register(() => window.removeEventListener(name, onKeyboard));
      }
    }
  }

  /**
   * Whether the on-screen soft keyboard is currently up. `false` on desktop and, on mobile,
   * whenever a hardware keyboard is used (which keeps the soft one hidden) — which is what makes it
   * the right gate for a control that only exists because the soft keyboard lacks a key.
   */
  isUp(): boolean {
    return Platform.isMobile && this.keyboardHeight > 0;
  }

  /**
   * The current overlap (px, `0` when nothing overlaps): how far the obstruction rises above the
   * target's bottom edge.
   *
   * The value from the last measurement, not a fresh one. Reading it is what a caller does from
   * inside `changed`, which runs *because* a measurement just happened — so measuring again there
   * would lay the document out twice per keyboard event to learn the number it was already told.
   * {@link remeasure} is how a caller asks for a new one.
   */
  inset(): number {
    return this.lastInset;
  }

  /** Measure the overlap now. Private because a caller wanting a fresh number wants the change
   *  detection around it — see {@link remeasure}. */
  private measure(): number {
    const rect = this.options.target.getBoundingClientRect();
    let inset = 0;

    // Mobile keyboard: how far its top edge rises above the target's bottom edge.
    const viewport = window.visualViewport;
    if (viewport && viewport.height < window.innerHeight - 1) {
      inset = Math.max(inset, rect.bottom - (viewport.offsetTop + viewport.height));
    } else if (this.keyboardHeight > 0) {
      inset = Math.max(inset, rect.bottom - (window.innerHeight - this.keyboardHeight));
    }

    // Desktop status bar: only when it actually floats over the target horizontally.
    if (this.options.statusBar === true) {
      const statusBar = this.options.target.ownerDocument.body.querySelector<HTMLElement>(".status-bar");
      if (statusBar) {
        const bar = statusBar.getBoundingClientRect();
        if (bar.width > 0 && bar.left < rect.right && bar.right > rect.left) {
          inset = Math.max(inset, rect.bottom - bar.top);
        }
      }
    }

    return Math.max(0, Math.round(inset));
  }

  /**
   * Re-measure and notify if anything moved. Called automatically for the keyboard and the
   * viewport; a caller drives it for the events only it sees — its view resizing, or the workspace
   * being laid out again around it.
   */
  remeasure(): void {
    const inset = this.measure();
    const up = this.isUp();
    if (inset === this.lastInset && up === this.lastUp) {
      return;
    }

    // Both recorded before `changed` runs, since what it does with them is read them back off this
    // object rather than being handed them.
    this.lastInset = inset;
    this.lastUp = up;
    this.options.changed();
  }
}
