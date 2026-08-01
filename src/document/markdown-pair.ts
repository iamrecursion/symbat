// Suppress Obsidian's "Auto pair Markdown syntax" inside Numbat code. In prose, typing `*` or `_`
// inserts a closing partner and places the caret between the pair — but in a `numbat` /
// `numbat-shared` block, an inline-eval span's expression, or a Numbat-typed property's value in
// frontmatter, those characters are multiplication and an identifier character, and the phantom
// partner is a nuisance.
//
// The three regions are the same three hover/note.ts distinguishes, and for the same reason: they
// are everywhere a note's text is Numbat source. The property value is the odd one out mechanically
// — whether it is Numbat depends on the property's assigned type, which only Obsidian's registry
// knows — so it is checked through document/editor-property.ts, and only after the cheap document
// walks have declined.
//
// The guard is a highest-precedence `EditorView.inputHandler` (the same swallow-the-keystroke
// mechanism as unicode/input.ts): when one of the guarded characters is typed with the caret in
// Numbat code, it inserts the character literally and reports the input handled, so Obsidian's
// pairing never sees the keystroke. Everywhere else it declines, and typing — pairing included —
// behaves exactly as before.

import { type Extension, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Platform } from "obsidian";
import { inlineConfig } from "../evaluation/inline";
import type SymbatPlugin from "../main";
import { cursorInNumbatProperty } from "./editor-property";
import { cursorInNumbatCode } from "./editor-scope";
import { numbatFenceState } from "./fence-state";

/** The characters Obsidian pairs as Markdown emphasis which are Numbat syntax instead (`*`
 *  multiplication / exponent, `_` in identifiers). */
const GUARDED = new Set(["*", "_"]);

/** The Markdown auto-pair guard editor extension. Reads the inline-eval settings live, so no
 *  re-registration is needed when they change. */
export function numbatMarkdownPairGuard(plugin: SymbatPlugin): Extension {
  return Prec.highest(
    EditorView.inputHandler.of((view, from, to, text) => {
      if (!GUARDED.has(text)) {
        return false;
      }

      // Stand aside during IME composition and in a read-only editor, exactly as CodeMirror's own
      // `closeBrackets` handler does: CM6 consults input handlers from `applyDOMChange` *including*
      // mid-composition, and replacing the composition range with a hand-built transaction desyncs
      // the DOM from the document (duplicated or dropped characters, and a stuck composition).
      if ((Platform.isAndroidApp ? view.composing : view.compositionStarted) || view.state.readOnly) {
        return false;
      }

      // With multiple cursors, defer to the default multi-caret insertion instead of editing just
      // one spot.
      if (view.state.selection.ranges.length !== 1) {
        return false;
      }
      const inline = plugin.settings.inlineEval ? inlineConfig(plugin) : null;

      // Every `*` and `_` typed anywhere in a note reaches here — including one starting a bullet,
      // or one inside `snake_case` prose — so the fence question is answered from the maintained
      // index rather than by rescanning.
      const spans = view.state.field(numbatFenceState, false) ?? undefined;
      if (
        !cursorInNumbatCode(view.state.doc, from, inline, spans)
        && !cursorInNumbatProperty(plugin, view, from)
      ) {
        return false;
      }
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },

        // An `input.type` sub-event, deliberately. `@codemirror/commands` joins adjacent typing
        // into one undo entry only for user events matching `/^(input\.type|delete)($|\.)/`, so a
        // bare `numbat.literal` made every guarded `*` and `_` start a fresh entry *and* broke the
        // run before it — typing `2*3*4` in a block took three undos where plain typing takes one.
        // The `.numbat` suffix still marks it, and nothing re-processes it: what is being
        // suppressed is Obsidian's auto-pairing, which never sees the keystroke because this
        // handler returned `true`.
        userEvent: "input.type.numbat",
        scrollIntoView: true,
      });

      return true;
    }),
  );
}
