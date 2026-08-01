// Going to where a binding is defined. One implementation for the two surfaces that offer it — the
// scope inspector's rows (views/scope.ts) and the hover popup (hover/hover.ts) — so they cannot
// disagree about what a {@link DefSite} means.

import { type App, MarkdownView, TFile } from "obsidian";
import type { DefSite } from "./model";

/** Moves the caret in an already-open editor that is not a Markdown note — today just the `.nbt`
 *  file editor. Returns whether it found one for `path`. */
type CaretTarget = (path: string, line: number, ch: number) => boolean;

// Registered by the plugin at load (and cleared on unload). It is handed in rather than imported so
// this module stays a leaf: the `.nbt` view builds hover cards, which append the very links this
// module resolves.
let caretTarget: CaretTarget | null = null;

/** Register (or, with `null`, clear) the non-Markdown caret target. */
export function setCaretTarget(target: CaretTarget | null): void {
  caretTarget = target;
}

/**
 * Go to `defsite`: a binding in the note it was derived from (`notePath === null`) moves that
 * editor's cursor, scrolls it into view and focuses the leaf; a binding from another file (an
 * import, a user-prelude `.nbt`) opens that file, at its line when one is known.
 *
 * `fromPath` is the note the defsite was resolved against — both the note a same-note jump lands in
 * and the source path a bare note name is resolved as a link from. Returns whether anything could
 * be done, so a caller can decline to offer the jump at all.
 */
export function jumpToDefinition(app: App, defsite: DefSite, fromPath: string | null): boolean {
  if (defsite.notePath !== null) {
    return openFileAt(app, defsite.notePath, defsite.line, fromPath);
  }

  if (fromPath === null || defsite.line === null) {
    return false;
  }

  const position = { line: defsite.line, ch: defsite.ch };
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const { view } = leaf;
    if (view instanceof MarkdownView && view.file?.path === fromPath) {
      view.editor.setCursor(position);
      view.editor.scrollIntoView({ from: position, to: position }, true);
      app.workspace.setActiveLeaf(leaf, { focus: true });
      return true;
    }
  }

  // A `.nbt` file is not a Markdown leaf, so it needs asking separately — without this, jumping
  // within one would reopen the file instead of moving its caret.
  if (caretTarget?.(fromPath, defsite.line, defsite.ch) === true) {
    return true;
  }

  return openFileAt(app, fromPath, defsite.line, fromPath);
}

/** Open a vault file (an import note, a prelude `.nbt`), scrolling to `line` when set. */
function openFileAt(app: App, path: string, line: number | null, fromPath: string | null): boolean {
  const file = app.vault.getAbstractFileByPath(path);
  if (file instanceof TFile) {
    void app.workspace.getLeaf(false).openFile(file, line !== null ? { eState: { line } } : {});
    return true;
  }

  // Not a direct vault path (a bare note name) — resolve it as a link instead.
  void app.workspace.openLinkText(path, fromPath ?? "", false);
  return true;
}

/** Whether {@link jumpToDefinition} has anywhere to go — a defsite in another file, or a located
 *  line in the note it came from. */
export function hasDefinitionTarget(defsite: DefSite, fromPath: string | null): boolean {
  return defsite.notePath !== null || (fromPath !== null && defsite.line !== null);
}
