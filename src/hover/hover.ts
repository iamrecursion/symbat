// The hover popup's CodeMirror wiring: two ways to ask what a symbol is, one card to answer with.
//
//   * **Mouse** — the pointer resting on a symbol.
//   * **Caret dwell** — the caret moving to one and settling. Editing never arms it: a popup
//     opening every time a typist pauses would be a nuisance, not a feature. The same path serves
//     the Vim normal-mode key and the command, which show the card immediately.
//
// The surface supplies a {@link HoverSource}: how to resolve a position into a card (hover/note.ts
// for the editor, the `NumbatInput` host for the REPL and the property field) and whether a
// completer is currently open — while one is, hover stands aside, since the completer opens this
// very card on its own dwell.
//
// **Resolution is synchronous, deliberately.** An asynchronous answer is one the pointer has
// usually moved away from by the time it arrives. Everything a card needs is available
// synchronously once the interpreter is warm; the surfaces warm it in the background and answer
// with a miss until it is.
//
// **One state field, module-scope, never replaced.** Both triggers drive the same field.
// CodeMirror's own `hoverTooltip` was used for the pointer at first, but it builds a *new* state
// field and view plugin on every construction, keeps a listener on the tooltip element that
// outlives the plugin, and reads its field without the "absent is fine" flag
// (`this.view.state.field(this.field)`) — so rebuilding the hover extension while a tooltip was
// open threw `RangeError: Field is not present in this state` from a listener nothing here could
// wrap, and a throw inside a view plugin makes CodeMirror disable it for the life of the editor.
// Driving the pointer here costs about fifty lines and removes that whole class of failure.

import { Facet, Prec, StateEffect, StateField } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Tooltip, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { Notice } from "obsidian";
import type SymbatPlugin from "../main";
import { dwellCountsIn, inVimNormalMode, vimKeyAsKeymapKey } from "./vim";

/** A resolved hover: the card, and the document range it belongs to (the tooltip's anchor). */
export interface HoverResolution {
  /** Document offset the described symbol starts at. */
  from: number;

  /** Document offset one past its last character. */
  to: number;

  /** The card's rendered content. */
  dom: HTMLElement;
}

/** Why there is no card here. A trigger the user did not ask for (the pointer, the dwell) shows
 *  nothing; one they *did* — the command, the Vim key — says this instead, because a key that
 *  silently does nothing is indistinguishable from a broken one. */
export interface HoverMiss {
  /** The message to show, phrased for a user who explicitly asked. */
  miss: string;
}

/** What a resolve produced. */
export type HoverOutcome = HoverResolution | HoverMiss;

/** Whether an outcome is a miss (there is no card). */
export function isMiss(outcome: HoverOutcome): outcome is HoverMiss {
  return "miss" in outcome;
}

/** What one surface must supply for its text to be hoverable. */
export interface HoverSource {
  /** The card for the symbol at document position `pos`, or why there is none — not Numbat code,
   *  not a symbol, or a name nothing knows about. */
  resolve(view: EditorView, pos: number): HoverOutcome;

  /** Whether a completion popover is open on this surface (hover stands aside). */
  completerOpen(view: EditorView): boolean;

  /** Whether a caret dwell counts right now — Vim's insert mode, on the surface's own Vim instance.
   *  Defaults to {@link dwellCountsIn}, which reads Obsidian's. */
  dwellAllowed?(view: EditorView): boolean;
}

/** The surface's source, reachable from the module-scope plugin (and so from the Vim key and the
 *  command, which act on whatever view has focus). */
const hoverSource = Facet.define<
  { plugin: SymbatPlugin; source: HoverSource; },
  { plugin: SymbatPlugin; source: HoverSource; } | null
>({
  combine: (values) => values[0] ?? null,
});

/** Show (or clear, with `null`) the card. */
const setCard = StateEffect.define<CardState | null>();

/** The card currently shown: its tooltip, the element it renders (for pointer containment), the
 *  range it describes, and which trigger opened it. */
interface CardState {
  /** The CodeMirror tooltip being shown. */
  tooltip: Tooltip;

  /** Its rendered element, kept for pointer-containment tests. */
  dom: HTMLElement;

  /** Document offset the described symbol starts at. */
  from: number;

  /** Document offset one past its last character. */
  to: number;

  /** What opened the card, which decides when it closes: a `caret` card follows the caret off its
   *  symbol, a `mouse` card ignores the caret entirely. */
  trigger: "caret" | "mouse";
}

/**
 * The card currently shown. A caret card is dropped when the caret leaves the symbol it describes —
 * but *not* on every selection transaction, because Vim re-dispatches the selection while handling
 * a key and the card would vanish the instant its own key opened it. A mouse card ignores the caret
 * entirely (the caret is elsewhere, by definition); the pointer logic below closes it.
 */
const hoverCard = StateField.define<CardState | null>({
  create: () => null,

  /** Adopt whatever a `setCard` effect carries; otherwise drop a card the document or the caret has
   *  moved out from under. */
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCard)) {
        return effect.value;
      }
    }

    if (value === null || tr.docChanged) {
      return null;
    }
    if (value.trigger === "mouse") {
      return value;
    }

    const head = tr.state.selection.main.head;
    return head < value.from || head > value.to ? null : value;
  },

  provide: (field) => showTooltip.from(field, (value) => value?.tooltip ?? null),
});

/** How far outside the card (or the hovered word) the pointer may stray before it counts as having
 *  left, in px. Bridges the gap between the text and the card. */
const POINTER_MARGIN = 8;

/** Build a tooltip from a resolution — anchored to the symbol, preferring above (the card is tall,
 *  and below would cover the lines being read). The wrapper carries the completer popup's own
 *  styling, so the two surfaces are one card. */
function cardState(resolution: HoverResolution, trigger: "caret" | "mouse"): CardState {
  const dom = createDiv({ cls: "numbat-hover-tooltip" });
  dom.append(resolution.dom);

  return {
    tooltip: { pos: resolution.from, end: resolution.to, above: true, create: () => ({ dom }) },
    dom,
    from: resolution.from,
    to: resolution.to,
    trigger,
  };
}

/** Whether a point is inside `rect`, allowing {@link POINTER_MARGIN} of slack. */
function nearRect(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left - POINTER_MARGIN && x <= rect.right + POINTER_MARGIN
    && y >= rect.top - POINTER_MARGIN && y <= rect.bottom + POINTER_MARGIN;
}

/**
 * The hover driver: both triggers, one card. Every entry point is wrapped, because CodeMirror
 * **disables a view plugin whose `update` throws** for the life of the editor — a single bad update
 * would not degrade hover, it would end it, silently and permanently, while every other surface
 * carried on working.
 */
class HoverDriver {
  /** The pending caret-dwell resolve, or `null` when none is scheduled. */
  private caretTimer: number | null = null;

  /** The pending pointer-dwell resolve, or `null` when none is scheduled. */
  private pointerTimer: number | null = null;

  /** The deferred close scheduled by `clearSoon`; cleared on teardown. */
  private clearTimer: number | null = null;

  /** The last pointer position seen, used to decide whether it is still over the card or its
   *  symbol; `null` before the pointer has moved over this editor. */
  private pointer: { x: number; y: number; } | null = null;

  /** @param view the editor this driver serves; one instance per editor. */
  constructor(private readonly view: EditorView) {}

  /**
   * CodeMirror's update hook. The `try` is load-bearing rather than defensive: a view plugin whose
   * `update` throws is disabled for the life of the editor, so an unhandled error here would end
   * hovering permanently and silently.
   */
  update(update: ViewUpdate): void {
    try {
      this.onUpdate(update);
    } catch (error) {
      console.error("Symbat: the hover failed to update", error);
    }
  }

  /** The real update logic, wrapped by {@link update}. */
  private onUpdate(update: ViewUpdate): void {
    const config = update.state.facet(hoverSource);
    if (config === null) {
      return;
    }

    // A completer opening over a shown card leaves two popups stacked; the completer wins, since it
    // shows this card on its own dwell.
    if (update.state.field(hoverCard, false) != null && config.source.completerOpen(this.view)) {
      this.clearSoon();
      return;
    }

    if (!update.selectionSet && !update.docChanged && !update.focusChanged) {
      return;
    }
    this.cancelCaret();

    if (!update.selectionSet || update.docChanged || !this.view.hasFocus) {
      return; // editing, or a move we did not make — never arm on a doc change
    }

    if (!config.plugin.settings.hover || !config.plugin.settings.hoverDwell) {
      return;
    }

    const allowed = (view: EditorView) =>
      config.source.dwellAllowed === undefined ? dwellCountsIn(view) : config.source.dwellAllowed(view);
    if (!this.view.state.selection.main.empty || !allowed(this.view)) {
      return;
    }

    this.caretTimer = window.setTimeout(() => {
      this.caretTimer = null;
      this.show();
    }, this.delay(config.plugin));
  }

  // THE POINTER
  // ==============================================================================================

  /** Track the pointer: keep a card while it is over the card or the word it describes, drop it
   *  when it leaves, and arm the delay wherever it settles. */
  onMouseMove(event: MouseEvent): void {
    try {
      const config = this.view.state.facet(hoverSource);
      if (config === null || !config.plugin.settings.hover || !config.plugin.settings.hoverMouse) {
        return;
      }

      this.pointer = { x: event.clientX, y: event.clientY };
      const card = this.view.state.field(hoverCard, false);

      if (card != null && card.trigger === "mouse") {
        if (this.pointerOn(card, event.clientX, event.clientY)) {
          return; // still on the word, or moved into the card to click it
        }
        this.clear();
      }
      this.cancelPointer();
      this.pointerTimer = window.setTimeout(() => {
        this.pointerTimer = null;
        try {
          this.showAtPointer();
        } catch (error) {
          // A timer's throw is uncaught, and an uncaught throw here is what a broken hover looks
          // like from the outside.
          console.error("Symbat: the hover popup failed", error);
        }
      }, this.delay(config.plugin));
    } catch (error) {
      console.error("Symbat: the hover failed to track the pointer", error);
    }
  }

  /** The pointer left the text: drop the card unless it went into the card itself (which is how its
   *  go-to-definition gets clicked). */
  onMouseLeave(event: MouseEvent): void {
    try {
      this.cancelPointer();
      const card = this.view.state.field(hoverCard, false);
      if (card == null || card.trigger !== "mouse") {
        return;
      }

      const into = event.relatedTarget;
      const intoCard = into instanceof Node
        && (card.dom.contains(into) || card.dom.parentElement?.contains(into) === true);
      if (intoCard || this.pointerOn(card, event.clientX, event.clientY)) {
        return;
      }
      this.clear();
    } catch (error) {
      console.error("Symbat: the hover failed to close", error);
    }
  }

  /** Whether the pointer is still on the card's own word, or on the card itself. */
  private pointerOn(card: CardState, x: number, y: number): boolean {
    if (card.dom.isConnected && nearRect(card.dom.getBoundingClientRect(), x, y)) {
      return true;
    }

    const start = this.view.coordsAtPos(card.from);
    const end = this.view.coordsAtPos(card.to);
    if (start === null || end === null) {
      return false;
    }

    return x >= start.left - POINTER_MARGIN && x <= end.right + POINTER_MARGIN
      && y >= start.top - POINTER_MARGIN && y <= end.bottom + POINTER_MARGIN;
  }

  /** Resolve and show at the pointer's last position, if it is on a character. */
  private showAtPointer(): void {
    const at = this.pointer;
    if (at === null) {
      return;
    }
    const pos = this.view.posAtCoords(at);
    if (pos === null) {
      return;
    }

    // `posAtCoords` snaps to the nearest position, so the empty space past the end of a line
    // resolves to its last character. Only a pointer actually over the glyph counts (the same check
    // CodeMirror's own hover makes).
    const coords = this.view.coordsAtPos(pos);
    if (
      coords === null || at.y < coords.top - POINTER_MARGIN || at.y > coords.bottom + POINTER_MARGIN
      || at.x < coords.left - this.view.defaultCharacterWidth || at.x > coords.right + this.view.defaultCharacterWidth
    ) {
      return;
    }

    this.open(pos, "mouse", false);
  }

  // THE CARET
  // ==============================================================================================

  /**
   * Resolve at the caret and show the card. `explain` is set when the user asked outright (the
   * command, the Vim key): a miss then says why, rather than looking like a key that does nothing.
   */
  show(explain = false): void {
    try {
      this.open(this.view.state.selection.main.head, "caret", explain);
    } catch (error) {
      console.error("Symbat: the hover popup failed", error);
      if (explain) {
        new Notice("Symbat: the hover popup failed — see the console");
      }
    }
  }

  /** Show the card once the interpreter is ready, if the caret has not moved — so the very first
   *  hover of a session, which lands while the wasm is still loading, still ends in a card instead
   *  of nothing. */
  retryWhenReady(ready: Promise<void>): void {
    const pos = this.view.state.selection.main.head;
    void ready.then(() => {
      if (this.view.state.selection.main.head === pos && this.view.hasFocus) {
        this.show();
      }
    });
  }

  /**
   * Resolve at `pos` and show the card, or explain the miss.
   *
   * Every early return here is explainable, deliberately. A gate that quietly stops an explicit
   * request is indistinguishable from a broken feature — which is exactly how a completer-open
   * check that never went false again presented: no error, no card, no clue.
   */
  private open(pos: number, trigger: "caret" | "mouse", explain: boolean): void {
    const config = this.view.state.facet(hoverSource);
    if (config === null) {
      return;
    }

    if (!config.plugin.settings.hover) {
      this.explain(explain, "hover is switched off");
      return;
    }

    if (config.source.completerOpen(this.view)) {
      this.explain(explain, "a completer is open — hover stands aside for it");
      return;
    }

    const outcome = config.source.resolve(this.view, pos);
    if (isMiss(outcome)) {
      this.explain(explain, outcome.miss);
      return;
    }

    const card = cardState(outcome, trigger);
    if (trigger === "mouse") {
      // Once the pointer is over the card there are no more editor mouse events, so the card
      // watches for the pointer leaving *it* — otherwise a card entered and then abandoned would
      // stay on screen. The listener dies with the element.
      card.dom.addEventListener("mouseleave", () => this.clear());
    }

    this.view.dispatch({ effects: setCard.of(card) });
  }

  /** Say why there is no card, but only to a trigger that asked outright. */
  private explain(explain: boolean, reason: string): void {
    if (explain) {
      new Notice(`Symbat: ${reason}`);
    }
  }

  /** Drop a shown card (Escape, a completer taking over, the pointer leaving). */
  clear(): void {
    this.cancelCaret();
    this.cancelPointer();
    if (this.view.state.field(hoverCard, false) != null) {
      this.view.dispatch({ effects: setCard.of(null) });
    }
  }

  /** {@link clear}, deferred — a view plugin must not dispatch while updating. */
  private clearSoon(): void {
    // Tracked, not fire-and-forget: `onUpdate` reaches this on every update while a card and a
    // completer overlap, and an untracked timer can outlive `destroy` and dispatch into a torn-down
    // view.
    if (this.clearTimer !== null) {
      return;
    }

    this.clearTimer = window.setTimeout(() => {
      this.clearTimer = null;
      try {
        this.clear();
      } catch (error) {
        console.error("Symbat: could not close the hover popup", error);
      }
    }, 0);
  }

  /** Abandon a deferred close, when something re-establishes the card first. */
  private cancelClear(): void {
    if (this.clearTimer !== null) {
      window.clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }
  }

  /** The configured dwell, floored at zero — the setting is clamped on read, and a negative value
   *  would make `setTimeout` fire immediately. */
  private delay(plugin: SymbatPlugin): number {
    return Math.max(0, plugin.settings.hoverDelayMs);
  }

  /** Abandon a pending caret-dwell resolve. */
  private cancelCaret(): void {
    if (this.caretTimer !== null) {
      window.clearTimeout(this.caretTimer);
      this.caretTimer = null;
    }
  }

  /** Abandon a pending pointer-dwell resolve. */
  private cancelPointer(): void {
    if (this.pointerTimer !== null) {
      window.clearTimeout(this.pointerTimer);
      this.pointerTimer = null;
    }
  }

  /** Drop all three timers with the view, so none can fire into a torn-down editor. */
  destroy(): void {
    this.cancelCaret();
    this.cancelPointer();
    this.cancelClear();
  }
}

/** The hover extension: one {@link HoverDriver} per editor. */
const hoverPlugin = ViewPlugin.fromClass(HoverDriver);

/** Open the hover popup at the caret right now, bypassing the dwell — the Vim normal-mode key and
 *  the **Show info at the cursor** command. Both were asked for outright, so a miss explains
 *  itself. */
export function showHoverAtCursor(view: EditorView): void {
  const driver = view.plugin(hoverPlugin);
  if (driver === null) {
    // The extension is not in this editor: hover is switched off, this is not an editor hover
    // applies to, or the plugin was disabled by an error. Saying so distinguishes those from a key
    // that never arrived at all.
    new Notice("Symbat: hover is not active in this editor");
    return;
  }
  driver.show(true);
}

/** Re-show at the caret once `ready` settles (the interpreter warming up on the very first hover),
 *  if nothing has moved meanwhile. */
export function showHoverWhenReady(view: EditorView, ready: Promise<void>): void {
  view.plugin(hoverPlugin)?.retryWhenReady(ready);
}

/** Close a shown card — after its go-to-definition has been taken, so it does not linger over the
 *  place it just left. */
export function dismissHover(view: EditorView): void {
  try {
    view.plugin(hoverPlugin)?.clear();
  } catch (error) {
    console.error("Symbat: could not close the hover popup", error);
  }
}

/**
 * The hover extension for one surface. Returns nothing when hover is switched off, so the feature
 * costs the editor nothing at all. Only the master toggle, the delay and the Vim key are read at
 * build time (the caller rebuilds for those); the two trigger toggles are read live, so switching
 * them swaps no state field.
 */
export function numbatHover(plugin: SymbatPlugin, source: HoverSource) {
  if (!plugin.settings.hover) {
    return [];
  }
  const extensions = [
    hoverSource.of({ plugin, source }),
    hoverCard,
    hoverPlugin,
    EditorView.domEventHandlers({
      mousemove: (event, view) => {
        view.plugin(hoverPlugin)?.onMouseMove(event);
        return false;
      },
      mouseleave: (event, view) => {
        view.plugin(hoverPlugin)?.onMouseLeave(event);
        return false;
      },
      // Escape dismisses a shown card. Handled rather than bound so Vim (and anything else) still
      // receives the key; nothing else is intercepted, and a caret move or an edit clears the card
      // through the state field.
      keydown: (event, view) => {
        if (event.key === "Escape") {
          view.plugin(hoverPlugin)?.clear();
        }
        return false;
      },
      blur: (_event, view) => {
        view.plugin(hoverPlugin)?.clear();
        return false;
      },
    }),
  ];
  // The Vim normal-mode key, as an editor binding as well as a Vim mapping. The mapping lives in
  // Obsidian's own Vim — which this plugin does not own, cannot inspect, and has already been seen
  // to lose it — so the same key is bound here too, gated on Vim actually being in normal mode.
  // Whichever handler sees the key first serves it; only one can, so the card never opens twice.
  const keymapKey = vimKeyAsKeymapKey(plugin.settings.hoverVimKey.trim());
  if (keymapKey !== null) {
    extensions.push(Prec.highest(keymap.of([{
      key: keymapKey,
      run: (view) => {
        if (!inVimNormalMode(view)) {
          return false; // an ordinary keystroke; never intercept it
        }
        showHoverAtCursor(view);
        return true;
      },
    }])));
  }
  return extensions;
}
