// Obsidian's mobile soft-keyboard signals.
//
// The REPL and the scope inspector both dock a control above the keyboard, and both carried their
// own copy of the event list and the height reader. What they do with the height genuinely differs
// — the REPL prefers `visualViewport` and dodges the status bar, the inspector does not — so only
// the leaves are shared here, not the tracking logic.
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
