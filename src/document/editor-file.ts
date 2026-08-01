// Which note a CodeMirror editor is showing.
//
// Kept apart from document/editor-scope.ts deliberately: that module is unit-tested, and a test can
// only load it because it does not import `obsidian`. This one must.

import type { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";

/**
 * The vault-relative path of the note this editor is editing, or `null` when the editor is not
 * backed by a file — an unsaved buffer, or a CodeMirror instance embedded somewhere without an
 * editor context. Callers need the path to resolve a note's scope and its imports, so "no path"
 * means "no scope", not an error.
 */
export function sourcePathOf(view: EditorView): string | null {
  return view.state.field(editorInfoField, false)?.file?.path ?? null;
}
