// LaTeX-style `\code` completion popover for the editor, using Obsidian's native completer UI:
// `NumbatUnicodeEditorSuggest` (an `EditorSuggest`) offers codes in `numbat` / `numbat-shared`
// blocks — and in inline-eval spans' expressions — as you type `<leader><prefix>`. Selecting a row
// inserts the glyph, replacing the typed `<leader>code`. It complements the eager as-you-type
// expansion (unicode/input.ts): the popover helps while a code is still partial; eager expansion
// fires the instant it is complete.
//
// The REPL input's equivalent completer (the `\code` and history completions) is a CodeMirror 6
// autocomplete source instead, since the REPL is now a CM6 editor (see views/input.ts).

import {
  type App,
  type Editor,
  type EditorPosition,
  EditorSuggest,
  type EditorSuggestContext,
  type EditorSuggestTriggerInfo,
  type PopoverSuggest,
} from "obsidian";
import { insideNumbatFence } from "../document/fences";
import { inlineSpanAtCursor } from "../evaluation/inline";
import { listUnicodeCompletions, primeUnicodeCompletion } from "../interpreter/numbat";
import type SymbatPlugin from "../main";
import { type UnicodeCode, unicodePrefixAt } from "./codes";

/** Maximum rows shown at once (both popovers). */
const SUGGESTION_LIMIT = 50;

/** Render one code completion row: the glyph, then its `<leader>code`. */
function renderUnicodeSuggestion(el: HTMLElement, code: UnicodeCode, leader: string): void {
  el.addClass("numbat-unicode-suggestion");
  el.createSpan({ cls: "numbat-unicode-suggestion-glyph", text: code.replacement });
  el.createSpan({ cls: "numbat-unicode-suggestion-code", text: `${leader}${code.name}` });
}

/** The subset of Obsidian's internal suggestion chooser we drive: the selected index, its container
 *  element (for the dwell-popup observer), and methods to move or accept it. Undocumented, hence
 *  accessed defensively. */
export interface SuggestChooser {
  /** Index of the highlighted row — read to decide what the dwell popup documents. */
  selectedItem: number;

  /** The popover's scrolling container (holds the `.is-selected` row). */
  containerEl?: HTMLElement;

  /** Move the highlight, as the arrow keys do. */
  setSelectedItem(index: number, event?: KeyboardEvent): void;

  /** Accept the highlighted row, as Enter does. */
  useSelectedItem(event: KeyboardEvent): void;
}

/** The internal chooser backing a suggest popover, if present. Exported so the expression
 *  completer can read the selected item for its documentation popup, reusing this one defensive
 *  access point. */
export function chooserOf<T>(suggest: PopoverSuggest<T>): SuggestChooser | undefined {
  return (suggest as unknown as { suggestions?: SuggestChooser; }).suggestions;
}

/**
 * Give a suggest popover its full keybinding set, so the editor and REPL completers behave
 * identically. Enter/arrows/Escape are built into the base scope; this adds Tab (accept) and Ctrl-N
 * / Ctrl-P (move down / up, emacs style). The chooser is an Obsidian internal, so each handler
 * degrades to a no-op (leaving the key to its default) if it is unavailable.
 */
export function registerSuggestKeys<T>(suggest: PopoverSuggest<T>): void {
  const accept = (evt: KeyboardEvent): boolean => {
    const chooser = chooserOf(suggest);
    if (!chooser?.useSelectedItem) {
      return true;
    }
    chooser.useSelectedItem(evt);
    return false; // handled: consume the key (no indent / focus change)
  };

  const move = (delta: number) => (evt: KeyboardEvent): boolean => {
    const chooser = chooserOf(suggest);
    if (!chooser?.setSelectedItem) {
      return true;
    }
    // `setSelectedItem` wraps out-of-range indices, matching the arrow keys.
    chooser.setSelectedItem(chooser.selectedItem + delta, evt);
    return false;
  };

  suggest.scope.register([], "Tab", accept);
  suggest.scope.register(["Ctrl"], "N", move(1));
  suggest.scope.register(["Ctrl"], "P", move(-1));
}

/** Editor completer: `\code` suggestions inside `numbat`/`numbat-shared` blocks and inline-eval
 *  spans. */
export class NumbatUnicodeEditorSuggest extends EditorSuggest<UnicodeCode> {
  /** Read live for the expansion setting and the configured leader, so a settings change takes
   *  effect without re-registering the completer. */
  private readonly plugin: SymbatPlugin;

  /** @param app Obsidian's app, for `EditorSuggest`. @param plugin the plugin to read. */
  constructor(app: App, plugin: SymbatPlugin) {
    super(app);
    this.plugin = plugin;
    this.limit = SUGGESTION_LIMIT;
    registerSuggestKeys(this);
  }

  /**
   * Decide whether the caret sits in a `<leader>code` worth completing, and if so what range the
   * accepted glyph replaces. Runs on every keypress, so the cheap prefix test comes before the
   * fence scan — which is the expensive half.
   */
  onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
    if (!this.plugin.settings.unicodeExpansion) {
      return null;
    }
    const leader = this.plugin.settings.unicodeLeader;

    // Cheap check first (runs on every keypress): is the caret in a `<leader>code`?
    const prefix = unicodePrefixAt(editor.getLine(cursor.line).slice(0, cursor.ch), leader);
    if (prefix === null) {
      return null;
    }

    // Only inside a numbat block or an inline-eval span's expression. Both read the lines before
    // the cursor, which is why the prefix check is done first — this runs only on leader input.
    const preceding: string[] = [];
    for (let n = 0; n < cursor.line; n += 1) {
      preceding.push(editor.getLine(n));
    }

    if (!insideNumbatFence(preceding) && inlineSpanAtCursor(this.plugin, editor, cursor) === null) {
      return null;
    }
    primeUnicodeCompletion();

    return {
      start: { line: cursor.line, ch: cursor.ch - prefix.length - leader.length }, // the leader + code
      end: cursor,
      query: prefix,
    };
  }

  /** The codes matching what has been typed, capped at `SUGGESTION_LIMIT`. */
  getSuggestions(context: EditorSuggestContext): UnicodeCode[] {
    return listUnicodeCompletions(context.query);
  }

  /** Draw one row: the glyph, its code name, and the configured leader. */
  renderSuggestion(value: UnicodeCode, el: HTMLElement): void {
    renderUnicodeSuggestion(el, value, this.plugin.settings.unicodeLeader);
  }

  /** Replace the typed code with its glyph and put the caret after it. */
  selectSuggestion(value: UnicodeCode): void {
    const { context } = this;
    if (context === null) {
      return;
    }

    context.editor.replaceRange(value.replacement, context.start, context.end);
    const ch = context.start.ch + value.replacement.length;
    context.editor.setCursor({ line: context.start.line, ch });

    this.close();
  }
}
