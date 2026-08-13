// Obsidian's mobile soft-keyboard signals: what its shell dispatches, and how to read a height out
// of one.
//
// Three surfaces dock a control above the keyboard, and each carried its own copy of this. What
// they then *do* with the height differs, and the two that agree share `views/soft-keyboard.ts`
// instead — which needs Obsidian, while this must not: these are leaves, and a leaf that imports
// `obsidian` can never be unit-tested (see docs/architecture.md).
//
// No imports: `Event` is a DOM global.

/** Obsidian's mobile keyboard events, paired with whether each means "up". */
export const KEYBOARD_EVENTS: readonly (readonly [string, boolean])[] = [
  ["keyboardWillShow", true],
  ["keyboardDidShow", true],
  ["keyboardWillHide", false],
  ["keyboardDidHide", false],
];

/** Just the event names, for a listener that reads the height from the event itself rather than
 *  from whether the event means "up". */
export const KEYBOARD_EVENT_NAMES: readonly string[] = KEYBOARD_EVENTS.map(([name]) => name);

/**
 * The keyboard height (CSS px) carried by a Capacitor keyboard event, or `0` when absent (e.g. the
 * hide events). Obsidian's mobile shell dispatches these on `window`; `keyboardHeight` sits either
 * directly on the event or under `detail`, depending on the version, so both are checked.
 */
export function keyboardHeightOf(evt: Event): number {
  const source = evt as { keyboardHeight?: unknown; detail?: { keyboardHeight?: unknown; }; };
  const height = source.keyboardHeight ?? source.detail?.keyboardHeight;
  return typeof height === "number" && height > 0 ? height : 0;
}
