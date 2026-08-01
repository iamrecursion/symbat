// Whether a CodeMirror position sits in a Numbat-typed property's value — the one Numbat region of
// a note that the document text alone cannot decide, since the property's type lives in Obsidian's
// registry rather than in the YAML.
//
// It is a leaf for the same reason document/editor-file.ts is: the answer needs Obsidian (the app's
// property-type registry, and the note's editor behind the view), so it cannot live in
// document/editor-scope.ts, whose whole point is being pure and unit-testable. The two editor
// affordances that treat this region as Numbat — the Markdown auto-pair guard
// (document/markdown-pair.ts) and Unicode expansion (unicode/input.ts) — share it here rather than
// each asking their own way, which is what keeps them from drifting apart on what counts as a
// property value.
//
// The classification itself is scope/replay.ts's `numbatPropertySiteAt`, which the hover already
// uses; this only bridges a CodeMirror view to it.

import { type EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import type SymbatPlugin from "../main";
import { numbatPropertySiteAt } from "../scope/replay";
import { cursorInFrontmatter } from "./editor-scope";

/**
 * Whether `pos` sits in the value of a Numbat-typed frontmatter property.
 *
 * False when property bindings are off (a property's value is only an expression while they are),
 * and in a view with no note editor behind it — the REPL input and the property widget host their
 * own CodeMirror, where neither Obsidian's Markdown pairing nor the document-scoped expansion
 * applies.
 *
 * Runs on keystroke paths, so the cheap frontmatter walk comes first: it declines on the first line
 * for a note without frontmatter, and at the closing delimiter for every position below it, leaving
 * the whole-document read and the registry lookup to the positions that really are in frontmatter.
 */
export function cursorInNumbatProperty(plugin: SymbatPlugin, view: EditorView, pos: number): boolean {
  if (!plugin.settings.noteProperties || !cursorInFrontmatter(view.state.doc, pos)) {
    return false;
  }

  const editor = view.state.field(editorInfoField, false)?.editor;
  if (editor === undefined) {
    return false;
  }

  const line = view.state.doc.lineAt(pos);
  const position = { line: line.number - 1, ch: pos - line.from };

  // The lines above, taken from the document we already hold. Without them `numbatPropertySiteAt`
  // rebuilds the same array with a `getLine` call per line; and the position is inside frontmatter,
  // so this is a handful of lines from the top of the note rather than a walk.
  const preceding = [...view.state.doc.iterLines(1, line.number)];

  return numbatPropertySiteAt(plugin.app, editor, position, preceding) !== null;
}
