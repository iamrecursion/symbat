// Computes the document edit for a LaTeX-style Unicode expansion inside Numbat code, independent of
// the editor and the wasm interpreter. The completion lookup is injected (in production, the wasm's
// `get_unicode_completion`; see unicode/input.ts), as is the one scope test that needs Obsidian —
// whether the caret is in a Numbat-typed property's value — so this module imports neither and can
// be exercised against a real CodeMirror `EditorState` in tests.

import { type Text } from "@codemirror/state";
import { cursorInNumbatCode } from "../document/editor-scope";
import { type FenceSpan } from "../document/fence-state";
import { type InlineEvalConfig } from "../evaluation/inline-parse";
import { unicodePrefixAt } from "./codes";

/** A completed `\code`: `replaceLength` chars (including the backslash) → text. */
export interface CodeCompletion {
  /** How many characters before the caret the code occupies, leader included. */
  replaceLength: number;

  /** The Unicode text to put in their place. */
  replacement: string;
}

/** The resolved expansion as a document edit: replace `[from, to)` with `insert`. */
export interface UnicodeEdit {
  /** Document offset the replaced range starts at. */
  from: number;

  /** Document offset one past its end. */
  to: number;

  /** The text to insert there. */
  insert: string;
}

/**
 * The edit expanding a completed `\code` typed at `[from, to)` with `text`, or `null` when nothing
 * should happen: not a single-character insertion at a collapsed cursor, no `\code` tail,
 * `requireScope` is set and the cursor is in none of the note's Numbat regions, or `lookup` finds
 * no known code.
 *
 * The typed character forms the final character of the matched code but is not in the document yet,
 * so the returned edit removes the preceding characters of the `\code` and inserts the replacement
 * in their place, dropping the typed one.
 */
function expansionEdit(
  doc: Text,
  from: number,
  to: number,
  text: string,
  leader: string,
  lookup: (textBeforeCursor: string) => CodeCompletion | null,
  requireScope: boolean,
  inline: InlineEvalConfig | null,
  inProperty: (() => boolean) | null,
  spans: readonly FenceSpan[] | undefined,
): UnicodeEdit | null {
  if (from !== to || text.length !== 1) {
    return null;
  }
  const line = doc.lineAt(from);

  // Prospective text before the cursor, on this line, including the char about to be inserted
  // (which is not in the document yet).
  const before = line.text.slice(0, from - line.from) + text;

  // A cheap necessary condition: the caret sits in a `<leader>code` run. Codes never contain
  // whitespace, so this filters out almost every keystroke before the fence scan or a lookup is
  // attempted.
  if (unicodePrefixAt(before, leader) === null) {
    return null;
  }

  // The document walk decides the two regions written in the text; a Numbat-typed property's value
  // needs Obsidian, so the caller injects that answer and it is asked for last — after the `\code`
  // tail above has already ruled out almost every keystroke.
  if (requireScope && !cursorInNumbatCode(doc, from, inline, spans) && inProperty?.() !== true) {
    return null;
  }

  const completion = lookup(before);
  if (completion === null) {
    return null;
  }

  const deleteBefore = completion.replaceLength - text.length;
  if (deleteBefore < 0 || from - deleteBefore < line.from) {
    return null;
  }

  const start = from - deleteBefore;
  return { from: start, to: from, insert: completion.replacement };
}

/**
 * The expansion edit for `\code` typed inside a `numbat`/`numbat-shared` block in a Markdown
 * document — or, when an inline-eval config is given, inside an inline-eval span's expression, or
 * when `inProperty` reports it, inside a Numbat-typed property's value: gated to those scopes,
 * since the surrounding prose is not Numbat.
 *
 * `inProperty` is a predicate rather than a flag because answering it costs a read of the whole
 * note (document/editor-property.ts); passing it lazily keeps that off every keystroke that is not
 * a completed `\code` in the first place.
 *
 * `spans` is the editor's maintained fence index, when the caller has one. It matters here: the
 * `\code` gate above passes on any line holding a backslash with no space after it, which is the
 * normal state of a line containing LaTeX or a Windows path — so without it those lines paid for a
 * full document walk per keystroke.
 */
export function unicodeExpansionEdit(
  doc: Text,
  from: number,
  to: number,
  text: string,
  leader: string,
  lookup: (textBeforeCursor: string) => CodeCompletion | null,
  inline: InlineEvalConfig | null = null,
  inProperty: (() => boolean) | null = null,
  spans: readonly FenceSpan[] | undefined = undefined,
): UnicodeEdit | null {
  return expansionEdit(doc, from, to, text, leader, lookup, true, inline, inProperty, spans);
}

/**
 * The expansion edit for `\code` typed in the REPL input. The whole input is Numbat, so — unlike
 * {@link unicodeExpansionEdit} — there is no scope to be inside; otherwise the two are identical.
 */
export function replUnicodeExpansionEdit(
  doc: Text,
  from: number,
  to: number,
  text: string,
  leader: string,
  lookup: (textBeforeCursor: string) => CodeCompletion | null,
): UnicodeEdit | null {
  return expansionEdit(doc, from, to, text, leader, lookup, false, null, null, undefined);
}
