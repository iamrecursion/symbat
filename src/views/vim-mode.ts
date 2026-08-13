// Which mode Vim is in, named once.
//
// `@replit/codemirror-vim` says this two different ways: a `vim-mode-change` event carrying a mode
// and a sub-mode, and a set of booleans on its own state object. A consumer needs both — the event
// for every change after it subscribes, the booleans for the mode it is already in when it does —
// and neither shape is one you want to branch on at the call site.
//
// Deliberately import-free, so it can be unit-tested without loading CodeMirror.

/** The mode a Numbat editor's Vim is in. */
export type VimMode =
  | "normal"
  | "insert"
  | "replace"
  | "visual"
  | "visual-line"
  | "visual-block";

/** The payload `@replit/codemirror-vim` signals with `vim-mode-change`. Both fields are optional
 *  here because the library omits `subMode` outside visual mode, and this is an undocumented shape
 *  crossing a package boundary. */
export interface VimModeEvent {
  /** `"normal"`, `"insert"`, `"replace"` or `"visual"`. */
  mode?: string;

  /** Visual mode's flavor: `"blockwise"`, `"linewise"`, or `""` for charwise. */
  subMode?: string;
}

/** The subset of the library's vim state this reads: the mode booleans. */
export interface VimModeFlags {
  insertMode?: boolean;
  visualMode?: boolean;
  visualLine?: boolean;
  visualBlock?: boolean;
}

/** The mode a `vim-mode-change` event announces. An unrecognized mode reads as normal — that is
 *  where a Vim session sits by default, and it is the mode in which no button lights up. */
export function vimModeFrom(event: VimModeEvent): VimMode {
  switch (event.mode) {
    case "insert":
      return "insert";
    case "replace":
      return "replace";
    case "visual":
      return event.subMode === "blockwise"
        ? "visual-block"
        : event.subMode === "linewise"
        ? "visual-line"
        : "visual";
    default:
      return "normal";
  }
}

/**
 * The mode a vim state object is in, for reading the mode already in force (no event fires when a
 * watcher subscribes). Missing state — Vim off, or not yet initialized — reads as normal.
 *
 * Replace mode cannot be recovered this way: the library models it as insert mode plus the
 * editor's `overwrite` flag, which is not part of vim's own state. It is reported as `insert`,
 * which is what it behaves as for anything asking this question.
 */
export function vimModeOf(state: VimModeFlags | null | undefined): VimMode {
  if (state == null) {
    return "normal";
  }

  if (state.insertMode === true) {
    return "insert";
  }

  if (state.visualMode !== true) {
    return "normal";
  }

  return state.visualBlock === true ? "visual-block" : state.visualLine === true ? "visual-line" : "visual";
}
