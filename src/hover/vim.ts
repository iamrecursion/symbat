// The Vim side of the hover: whether a caret dwell counts, and the normal-mode key that opens the
// popup on demand.
//
// Obsidian runs its own copy of the CodeMirror vim extension, not the one this plugin bundles for
// the REPL input, so `getCM` cannot see it and neither can any exported API. Both accesses below
// are therefore undocumented and defensive: the CM5-compatibility object the vim extension hangs
// off the editor view, and the `CodeMirrorAdapter` global that Obsidian exposes (the same one
// vimrc-style plugins map keys through). When either is missing, hover simply keeps working the way
// it does with vim off — the mouse and the command are unaffected.

import type { EditorView } from "@codemirror/view";
import { Vim as bundledVim } from "@replit/codemirror-vim";

/** The shape we read off the CM5-compat object: vim's own state, when vim is on. */
interface VimCompat {
  /** Vim's per-editor state; `insertMode` is what distinguishes normal mode, where the hover key is
   *  bound, from insert mode, where it must type a character. */
  state?: { vim?: { insertMode?: boolean; }; };
}

/** Vim's key-mapping API, as exposed on `window.CodeMirrorAdapter`. */
interface VimApi {
  /** Register a named action. Global to the vim adapter and with no counterpart to remove it, which
   *  is why the action here closes over a module-level reference rather than the plugin — see
   *  {@link refreshHover}. */
  defineAction?: (name: string, action: (cm: unknown) => void) => void;

  /** Bind a key sequence to a registered action, in a given mode context. */
  mapCommand?: (
    keys: string,
    type: string,
    name: string,
    args: unknown,
    extra: { context?: string; },
  ) => void;

  /** Remove a binding; `true` when one was actually removed. */
  unmap?: (keys: string, context?: string) => boolean;
}

/** The CM5-compat object for `view`, or `null` when vim is not active on it. Its mere presence *is*
 *  the "vim is on" signal — the vim extension attaches it when it loads and deletes it when it
 *  unloads (which is also what `getCM` reads). */
function vimCompat(view: EditorView): VimCompat | null {
  const compat = (view as unknown as { cm?: VimCompat; }).cm;
  return compat != null && typeof compat === "object" ? compat : null;
}

/**
 * Whether a caret dwell should count as a hover in `view`.
 *
 * With vim off every dwell counts. With vim on, only **insert** mode does: in normal mode the caret
 * is a cursor being moved around, not a pointer, and a popup opening under every `j` would be
 * unusable — that is what the normal-mode key is for. Vim being on but its state not yet readable
 * counts as normal mode, since that is where a session starts.
 */
export function dwellCountsIn(view: EditorView): boolean {
  const compat = vimCompat(view);
  return compat === null || compat.state?.vim?.insertMode === true;
}

/** Whether `view` is in Vim's **normal** mode right now — Vim is on, and not inserting. Gates the
 *  editor-level fallback for the normal-mode key, so it never swallows an ordinary keystroke. */
export function inVimNormalMode(view: EditorView): boolean {
  const compat = vimCompat(view);
  return compat !== null && compat.state?.vim?.insertMode !== true;
}

/**
 * The configured Vim key as a CodeMirror key name, or `null` when it is not a plain letter this can
 * express (`<C-h>`, a two-key sequence — those are Vim's own notation, and only the Vim mapping
 * serves them).
 *
 * This is what lets the key keep working when the Vim mapping is not there to serve it: a mapping
 * lives in Obsidian's Vim, which the plugin does not own and cannot inspect, while a CodeMirror
 * keymap lives in the extension beside everything else.
 */
export function vimKeyAsKeymapKey(key: string): string | null {
  if (!/^\p{L}$/u.test(key)) {
    return null;
  }

  return key === key.toUpperCase() && key !== key.toLowerCase() ? `Shift-${key.toLowerCase()}` : key;
}

/**
 * Every Vim the plugin can map a key in: Obsidian's own (through the undocumented global — the same
 * one vimrc-style plugins use), and the copy bundled for the REPL input and the property field,
 * which is a separate instance with its own keymap. Mapping both is what makes the key work in an
 * editor *and* in an input.
 */
function vimApis(): VimApi[] {
  const global = (window as unknown as { CodeMirrorAdapter?: { Vim?: VimApi; }; }).CodeMirrorAdapter?.Vim;
  const apis: VimApi[] = [bundledVim as unknown as VimApi];

  if (global != null && global !== apis[0]) {
    apis.push(global);
  }

  return apis;
}

/** The action name registered with vim; also the id it is mapped by. */
const ACTION = "numbatShowHover";

/** The key currently bound, so it can be unmapped before another takes its place; `null` when
 *  nothing is bound. */
let mappedKey: string | null = null;

/** What the setting last asked for — including `""`, which means "no key". Kept apart from {@link
 *  mappedKey} so the no-key case engages the fast path too, instead of re-running the unmap loop on
 *  every `refreshHover()`. */
let requestedKey: string | null = null;

/**
 * The `show` the defined action delegates to, or `null` when unmapped.
 *
 * Obsidian's Vim API offers `defineAction` with no matching *un*define, so the action outlives the
 * plugin — it lives in the app's global vim instance. Defining it with a closure over the current
 * `show` therefore pinned an unloaded plugin's bundle for the life of the app. The closure below is
 * stable and reads this instead, so unmapping releases everything it held.
 */
let showHover: ((view: EditorView) => void) | null = null;

/**
 * Map `key` in vim's **normal** mode to open the hover popup, replacing any key this previously
 * mapped. An empty `key` (or a missing vim API) just unmaps.
 *
 * The action is defined once and calls `show` with the view it fires on; `mapCommand` has no
 * implicit unmap, so changing the key without {@link Vim.unmap} would leave the old one bound as
 * well.
 */
export function mapVimHoverKey(key: string, show: (view: EditorView) => void): void {
  if (requestedKey === key) {
    return;
  }

  unmapVimHoverKey();
  requestedKey = key;
  showHover = show;
  if (key === "") {
    return;
  }

  for (const vim of vimApis()) {
    try {
      // A stable closure over module state — see `showHover` for why it must not capture `show` (or
      // anything else from this plugin instance) directly.
      vim.defineAction?.(ACTION, (cm) => {
        const view = (cm as { cm6?: EditorView; }).cm6;
        if (view !== undefined) {
          showHover?.(view);
        }
      });
      vim.mapCommand?.(key, "action", ACTION, {}, { context: "normal" });
    } catch (error) {
      console.error("Symbat: could not map the Vim hover key", error);
    }
  }

  mappedKey = key;
}

/** Remove the mapping (plugin unload, or the feature being switched off). */
export function unmapVimHoverKey(): void {
  // Always released, even when no key is bound: this is the only reference the undefinable action
  // retains, so dropping it is what un-pins the plugin.
  showHover = null;
  requestedKey = null;

  if (mappedKey === null) {
    return;
  }

  for (const vim of vimApis()) {
    try {
      vim.unmap?.(mappedKey, "normal");
    } catch (error) {
      console.error("Symbat: could not unmap the Vim hover key", error);
    }
  }

  mappedKey = null;
}
