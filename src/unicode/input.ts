// Editor-side (CodeMirror 6) LaTeX-style Unicode expansion for `numbat` / `numbat-shared` fenced
// blocks, inline-eval spans, and a Numbat-typed property's value in frontmatter: typing a known
// `\code` (e.g. `\alpha`) inside one replaces it with the corresponding Unicode character (`α`) on
// the keystroke that completes it, backed by the wasm's `get_unicode_completion`.
//
// The expansion is applied through a high-precedence `EditorView.inputHandler`. When it fires it
// suppresses the default character insertion, so the completing keystroke never reaches other
// editor extensions — notably the Typing Transformer plugin, whose own `\`-prefixed rules would
// otherwise also match. When there is *no* Numbat match the handler returns `false`, so the
// keystroke proceeds normally and those other extensions still see it (the "swallow, else re-emit"
// behavior).
//
// The scope check and offset arithmetic live in unicode/edit.ts (wasm-free and unit-tested); this
// module only wires that to the live interpreter and editor.

import { type Extension, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Platform } from "obsidian";
import { cursorInNumbatProperty } from "../document/editor-property";
import { numbatFenceState } from "../document/fence-state";
import { inlineConfig } from "../evaluation/inline";
import { getUnicodeCompletion, primeUnicodeCompletion } from "../interpreter/numbat";
import type SymbatPlugin from "../main";
import { replUnicodeExpansionEdit, unicodeExpansionEdit } from "./edit";

/**
 * The editor extension: a high-precedence input handler that expands a completed `\code` to its
 * Unicode character (when enabled), and otherwise defers so normal typing — and other plugins — are
 * unaffected. `fenced` gates the expansion to the note's Numbat regions (for `\code` typed in a
 * Markdown document); the REPL, whose whole input is Numbat, passes `false` to expand anywhere.
 */
export function numbatUnicodeInput(plugin: SymbatPlugin, fenced = true): Extension {
  // Resolve a code and, on plausibly relevant input (a `\code` tail — the point at which the
  // expansion edit calls this), warm the wasm up so later keystrokes resolve even if this one is
  // too early. Keeping the prime here (rather than per keystroke) preserves the plugin's lazy
  // start.
  const lookup = (textBeforeCursor: string) => {
    primeUnicodeCompletion();
    return getUnicodeCompletion(textBeforeCursor, plugin.settings.unicodeLeader);
  };

  return Prec.highest(
    EditorView.inputHandler.of((view, from, to, text) => {
      if (!plugin.settings.unicodeExpansion) {
        return false;
      }

      // Stand aside during IME composition and in a read-only editor, exactly as CodeMirror's own
      // `closeBrackets` handler does: CM6 consults input handlers from `applyDOMChange` *including*
      // mid-composition, and replacing the composition range with a hand-built transaction desyncs
      // the DOM from the document (duplicated or dropped characters, and a stuck composition).
      if ((Platform.isAndroidApp ? view.composing : view.compositionStarted) || view.state.readOnly) {
        return false;
      }

      // A single expansion edit only rewrites one spot; with multiple cursors, defer to the default
      // multi-caret insertion instead of editing just one.
      if (view.state.selection.ranges.length !== 1) {
        return false;
      }
      const { doc } = view.state;
      const leader = plugin.settings.unicodeLeader;

      // In a Markdown document the expansion is scoped to numbat blocks and — when inline
      // evaluation is on — inline-eval spans; the REPL expands anywhere.
      const edit = fenced
        ? unicodeExpansionEdit(
          doc,
          from,
          to,
          text,
          leader,
          lookup,
          plugin.settings.inlineEval ? inlineConfig(plugin) : null,
          () => cursorInNumbatProperty(plugin, view, from),
          view.state.field(numbatFenceState, false) ?? undefined,
        )
        : replUnicodeExpansionEdit(doc, from, to, text, leader, lookup);

      if (edit === null) {
        return false;
      }
      view.dispatch({
        changes: { from: edit.from, to: edit.to, insert: edit.insert },
        selection: { anchor: edit.from + edit.insert.length },
        // Not an `input.type` event: keeps other input-driven extensions from treating the
        // expansion itself as freshly typed text.
        userEvent: "numbat.unicode",
        scrollIntoView: true,
      });

      return true;
    }),
  );
}
