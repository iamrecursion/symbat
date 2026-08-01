// A CodeMirror 6 editor for Numbat code, shared by every surface where the user writes it outside a
// note: the REPL input (views/repl.ts), the Numbat property field (properties/type.ts), and — in
// `document` mode — a whole `.nbt` file (views/nbt.ts). It hosts Numbat syntax highlighting, the
// `\code` completer, expression completion with signatures and documentation, the
// incomplete-expression hint, and — when Obsidian's Vim mode is on — vim key bindings. It exposes a
// small, textarea-like surface (value get/set, focus, highlight toggle) and reports input events
// back through a host interface.
//
// What differs between the consumers is the *host*, not the editor: the REPL supplies history
// recall and Ctrl+L, the property field supplies neither and asks for `singleLine` (a YAML value is
// one line, and Enter commits it), and a `.nbt` file asks for `document` (Enter is a newline, there
// is nothing to submit to, and the hints cover every line rather than the last).
//
// Behavior parity with the old textarea:
//   * Enter submits, Shift+Enter inserts a newline; while the soft keyboard is up Enter inserts a
//     newline (there is no Shift key — submission is via the mobile button), matching
//     `softKeyboardUp`.
//   * Arrow Up/Down recall history, but only when the caret is on the first/last line, so arrows
//     still move within a multi-line entry.
//   * A completed `\code` expands to its glyph as you type (fence-free — the whole input is
//     Numbat), and a completer offers `\code`s and, behind the history leader, previous inputs.

import {
  acceptCompletion,
  autocompletion,
  type Completion,
  completionKeymap,
  type CompletionResult,
  type CompletionSource,
  completionStatus,
  moveCompletionSelection,
  selectedCompletion,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, insertNewlineAndIndent } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { drawSelection, EditorView, keymap, lineNumbers, placeholder, tooltips } from "@codemirror/view";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
import { type CompletionInfo } from "../completion/docs";
import {
  allowedCategoriesAt,
  boundCompletions,
  type ExprCategories,
  type ExprCategory,
  type ExprCompletion,
  exprTriggerAt,
  memberBaseAt,
  typeVariableCompletions,
} from "../completion/expressions";
import { buildDocPopupContent, DocPopup, renderCategoryTag, renderSignature } from "../completion/render";
import { numbatDocumentInlays, numbatReplHoleHint } from "../evaluation/inlay";
import { type HoverOutcome, numbatHover } from "../hover/hover";
import { type HoverSymbol, hoverSymbolAt } from "../hover/parse";
import { listUnicodeCompletions, primeUnicodeCompletion } from "../interpreter/numbat";
import type SymbatPlugin from "../main";
import { numbatReplHighlight } from "../syntax/highlight";
import { numbatLanguage } from "../syntax/language";
import { COMPLETION_DWELL_MS } from "../tuning";
import { unicodePrefixAt } from "../unicode/codes";
import { numbatUnicodeInput } from "../unicode/input";
import { fuzzyFilter } from "./fuzzy";

/** The `userEvent` tagged on programmatic value changes (recall, clear) so the update listener can
 *  tell them apart from the user's own edits. */
const SET_INPUT_EVENT = "numbat.set";

// THE HOST CONTRACT
// ================================================================================================

/** The events a consumer handles for its Numbat input. Only `submit` and the completion lookups
 *  are required; the rest are the REPL's, and a surface without a history or a log simply omits
 *  them. */
export interface NumbatInputHost {
  /** Accept the current text — evaluate it (REPL) or commit it (a property). */
  submit(value: string): void;

  /** Recall an older history entry (Arrow Up on the first line). */
  recallOlder?(): void;

  /** Recall a newer history entry (Arrow Down on the last line). */
  recallNewer?(): void;

  /** The user edited the input (a programmatic set does not count). The REPL uses it to drop an
   *  in-progress arrow-key recall; the property field re-evaluates. */
  changed?(): void;

  /** The input lost focus. */
  blurred?(): void;

  /** The caret moved to a new 0-indexed line. Only a `.nbt` file uses it, to report its caret to
   *  the scope inspector — a custom view carries no `editorInfoField`, so the plugin's own editor
   *  listener cannot see it. */
  caretMoved?(line: number): void;

  /** Whether the on-screen soft keyboard is up (so Enter inserts a newline). */
  softKeyboardUp?(): boolean;

  /** The current input history, oldest-first. */
  history?(): readonly string[];

  /** The vault path of the file being edited, in `document` mode — so a file that is part of the
   *  user prelude evaluates against the prelude *before* it rather than one that already defines
   *  everything in it. `null` when unknown. */
  filePath?(): string | null;

  /** Ctrl+L: scroll the visible log off-screen, shell-style (keeps scrollback). */
  clearScreen?(): void;

  /** Categorized expression completions for `query`, from the live session context: `enabled` is
   *  the user's category toggles, `allowed` restricts to what the cursor position accepts (e.g.
   *  types/dimensions/units after a `:`), or is null to accept all. */
  exprCompletions(
    query: string,
    enabled: ExprCategories,
    allowed: ReadonlySet<ExprCategory> | null,
  ): ExprCompletion[];

  /** The field names of the struct `base` evaluates to, in declaration order, or an empty list when
   *  it is not one. Drives member completion after a `.`, which Numbat's own completer does not
   *  offer. */
  memberFields?(base: string): string[];

  /** The hover card for `symbol` (see hover/content.ts), or `null` when there is nothing to show. A
   *  surface that omits it simply does not hover; no card carries a go-to-definition here, since
   *  neither the REPL session nor a property field has a note position to jump *from*. */
  hoverCard?(symbol: HoverSymbol): HTMLElement | null;

  /** The inline `type()` signature HTML for a completion, or `null` if it has none. */
  completionSignature(name: string): string | null;

  /** The full documentation for a completion (the dwell popup), or `null` if none. */
  completionInfo(name: string): CompletionInfo | null;

  /** For an incomplete input, the type of the operand it is still missing — evaluated against the
   *  live session context via a typed hole — or `null` when the input is complete, empty, or its
   *  type cannot be recovered. */
  holeType(input: string): string | null;
}

/** How one consumer wants its input to behave. */
export interface NumbatInputOptions {
  /** Numbat syntax highlighting as you type. */
  highlight: boolean;

  /** Obsidian's Vim key bindings. */
  vimMode: boolean;

  /** The incomplete-expression (typed-hole) hint at the end of the input. */
  inlayHoles: boolean;

  /** The hover card on a symbol (mouse or caret dwell), when the host can build one. */
  hover: boolean;

  /** Ghost text for an empty input. */
  placeholder: string;

  /** One line only: newlines are refused, so Enter always means "accept". A YAML property value
   *  cannot contain one, and Shift-Enter would silently produce a value the frontmatter could not
   *  hold. */
  singleLine?: boolean;

  /** A whole Numbat document rather than one expression (a `.nbt` file). Enter inserts a newline
   *  and there is nothing to submit to, find/replace is available (Obsidian's own does not reach
   *  a custom view), and the inlay hints cover every line instead of just the last one's typed
   *  hole. */
  document?: boolean;

  /** A line-number gutter. Follows Obsidian's own "Show line number" editor setting, so a Numbat
   *  file looks like every other editor in the app; meaningless for a one-expression input, which
   *  never sets it. */
  lineNumbers?: boolean;
}

/** True when the primary caret sits on the document's first line. */
function caretOnFirstLine(state: EditorState): boolean {
  return state.doc.lineAt(state.selection.main.from).number === 1;
}

/** True when the primary caret sits on the document's last line. */
function caretOnLastLine(state: EditorState): boolean {
  return state.doc.lineAt(state.selection.main.to).number === state.doc.lines;
}

/** A REPL completion. At most one of the extra fields is set, tagging the row's kind for styling:
 *  `numbatGlyph` (a `\code` glyph gutter) or `numbatCategory` (an expression completion's category
 *  tag) — see the autocompletion config. */
interface ReplCompletion extends Completion {
  /** The Unicode glyph a `\code` completion expands to, shown in a gutter. */
  numbatGlyph?: string;

  /** An expression completion's category, shown as a trailing tag. */
  numbatCategory?: ExprCategory;

  /** The inline `type()` signature HTML, on expression completions that have one. */
  numbatSignature?: string;
}

// COMPLETION
// ================================================================================================

/**
 * The REPL completer: one source serving both completions the old native popover did. The `\code`
 * completer wins when the caret sits in a code; otherwise, when the whole input opens with the
 * history leader, previous inputs are offered (fuzzy-filtered by the text after the leader).
 * Results are pre-filtered, so `filter: false` shows them as-is.
 */
function numbatCompletionSource(plugin: SymbatPlugin, host: NumbatInputHost): CompletionSource {
  return (context): CompletionResult | null => {
    const { settings } = plugin;

    // Unicode `\code` completion, when the caret is inside a code.
    if (settings.unicodeExpansion && settings.unicodeLeader !== "") {
      const before = context.state.sliceDoc(0, context.pos);
      const prefix = unicodePrefixAt(before, settings.unicodeLeader);
      if (prefix !== null) {
        primeUnicodeCompletion();
        const from = context.pos - settings.unicodeLeader.length - prefix.length;

        // `numbatGlyph` drives the glyph gutter (see the autocompletion config); the label is the
        // `\code`, and selecting inserts the glyph.
        const options: ReplCompletion[] = listUnicodeCompletions(prefix).map((code) => ({
          label: `${settings.unicodeLeader}${code.name}`,
          apply: code.replacement,
          numbatGlyph: code.replacement,
        }));

        return { from, to: context.pos, options, filter: false };
      }
    }

    // When the input opens with the history leader, offer past inputs. This is checked before
    // expression completion so the leader wins (the "disambiguated with the leaders" rule); the
    // `\code` completer above already had priority.
    if (host.history !== undefined && settings.historyCompletion && settings.historyLeader !== "") {
      const whole = context.state.doc.toString();
      if (whole.startsWith(settings.historyLeader)) {
        // Trim a leading space so `?: foo` filters the same as `?:foo`.
        const query = whole.slice(settings.historyLeader.length).trimStart();
        const past = [...host.history()].reverse();
        const options: Completion[] = fuzzyFilter(past, query).map((entry) => ({
          label: entry,
          apply: entry, // selecting fills the whole input (from 0 to end)
        }));

        return { from: 0, to: whole.length, options, filter: false };
      }
    }

    // Otherwise, expression completion: identifiers/operators/types, two characters into a word or
    // straight after `.`/`:`/a generic's `<`/a declaration's `->`. The host classifies against the
    // live session context, so REPL-defined names complete too.
    if (
      settings.exprCompletion
      && (settings.completeIdentifiers || settings.completeKeywords || settings.completeUnits
        || settings.completeDimensions || settings.completeTypes)
    ) {
      const before = context.state.sliceDoc(0, context.pos);
      const trigger = exprTriggerAt(before);
      if (trigger !== null) {
        const from = context.pos - trigger.replaceLength;

        // Member position wins outright: after a `.` every engine candidate is a name that cannot
        // legally appear there. A base that is not a struct falls through to the ordinary behavior.
        const base = settings.completeIdentifiers ? memberBaseAt(before.slice(0, from)) : null;
        if (base !== null && host.memberFields !== undefined) {
          const query = trigger.query.toLowerCase();
          const fields = host.memberFields(base)
            .filter((field) => field.toLowerCase().startsWith(query))
            .map((field): ReplCompletion => ({
              label: field,
              numbatCategory: "field",
              numbatSignature: host.completionSignature(`${base}.${field}`) ?? undefined,
            }));

          if (fields.length > 0) {
            return { from, to: context.pos, options: fields, filter: false };
          }
        }

        // A `:`/`<`/`->` position offers types/dimensions/units (narrowed by syntax); the host
        // classifies against the live session context and the user's toggles.
        const enabled = {
          identifiers: settings.completeIdentifiers,
          keywords: settings.completeKeywords,
          units: settings.completeUnits,
          dimensions: settings.completeDimensions,
          types: settings.completeTypes,
        };

        const beforeAnchor = before.slice(0, from);
        // A type-parameter bound position (`fn foo<D: `) admits exactly one name — `Dim` — so it
        // bypasses the engine (whose candidates are all parse errors there); otherwise the
        // enclosing declaration's type variables, which the engine does not know, complete ahead of
        // its candidates.
        let completions = boundCompletions(beforeAnchor, trigger.query, enabled);
        if (completions === null) {
          const allowed = allowedCategoriesAt(beforeAnchor);
          const typeVars = typeVariableCompletions(beforeAnchor, trigger.query, enabled, allowed);
          const injected = new Set(typeVars.map((completion) => completion.name));
          completions = [
            ...typeVars,
            ...host.exprCompletions(trigger.query, enabled, allowed).filter((c) => !injected.has(c.name)),
          ];
        }

        const options: ReplCompletion[] = completions.map((completion) => ({
          label: completion.name,
          numbatCategory: completion.category,
          numbatSignature: host.completionSignature(completion.name) ?? undefined,
        }));
        if (options.length === 0) {
          return null;
        }

        // No `filter: false`: the source is recomputed on each keystroke (candidates are
        // re-fetched, prefix-filtered, per query), and CM scores what remains.
        return { from, to: context.pos, options };
      }
    }

    return null;
  };
}

// THE INPUT EDITOR
// ================================================================================================

/**
 * The CodeMirror 6 input for the REPL. Owns the editor and its extensions; the view drives it
 * through the methods below and receives events via {@link NumbatInputHost}.
 */
export class NumbatInput {
  /** The CodeMirror editor this wraps. */
  private readonly view: EditorView;

  /** Read live for the settings the extensions consult. */
  private readonly plugin: SymbatPlugin;

  /** Holds the (optional) syntax-highlighting extension so it can be toggled live. */
  private readonly highlightCompartment = new Compartment();

  /** Holds the (optional) Vim extension so the mode can be toggled live. */
  private readonly vimCompartment = new Compartment();

  /** Holds the (optional) incomplete-expression inlay hint so it can toggle live. */
  private readonly inlayCompartment = new Compartment();

  /** Holds the (optional) hover extension; rebuilt to pick up a changed delay. */
  private readonly hoverCompartment = new Compartment();

  /** Holds the (optional) line-number gutter, so Obsidian's setting applies live. */
  private readonly gutterCompartment = new Compartment();

  /** The host, for documentation lookups on the dwell popup. */
  private readonly host: NumbatInputHost;

  /** Whether this editor holds a whole Numbat document (see the `document` option), which changes
   *  which inlay-hint extension the compartment carries. */
  private readonly documentMode: boolean;

  /** The shared floating documentation popup, its dwell timer, and the completion it is (or will
   *  be) showing — so re-selecting the same row does not re-arm it. */
  private readonly docPopup = new DocPopup();

  /** The pending dwell before the documentation popup opens. */
  private dwellTimer: number | null = null;

  /** The completion the popup is showing or about to show, so re-selecting the same row does not
   *  re-arm the dwell. */
  private dwellLabel: string | null = null;

  /**
   * Build the editor and mount it under `parent`. `options` decides which optional extensions are
   * installed; each lives in its own compartment so a settings change can reconfigure it without
   * rebuilding the editor.
   */
  constructor(
    parent: HTMLElement,
    plugin: SymbatPlugin,
    host: NumbatInputHost,
    options: NumbatInputOptions,
  ) {
    const { highlight, vimMode, inlayHoles, hover, singleLine = false, document: documentMode = false } = options;
    this.plugin = plugin;
    this.host = host;
    this.documentMode = documentMode;

    // Enter/Shift-Enter/arrows. Sits below the completion keymap (so an open popup owns
    // Enter/arrows) and below Vim (so Vim owns normal-mode keys), but above the default keymap (so
    // Enter submits rather than inserting a newline). See the precedence ordering in the extensions
    // list below.
    const submitKeymap = keymap.of([
      {
        key: "Enter",
        run: (view) => {
          if (!singleLine && (host.softKeyboardUp?.() ?? false)) {
            return false; // let the newline be inserted (mobile: submit via button)
          }
          host.submit(view.state.doc.toString());
          return true;
        },
      },
      {
        key: "Shift-Enter",
        run: (view) => singleLine ? true : insertNewlineAndIndent(view),
      },
      {
        key: "ArrowUp",
        run: (view) => {
          if (host.recallOlder === undefined || !caretOnFirstLine(view.state)) {
            return false;
          }
          host.recallOlder();
          return true;
        },
      },
      {
        key: "ArrowDown",
        run: (view) => {
          if (host.recallNewer === undefined || !caretOnLastLine(view.state)) {
            return false;
          }
          host.recallNewer();
          return true;
        },
      },
    ]);

    // Completion popup keys: Enter/arrows/Escape (built in) plus Tab (accept) and Ctrl-N/Ctrl-P
    // (move), matching the old completer. Each is a no-op when the popup is closed, so the keys
    // fall through to submit/recall/editing.
    const completionKeys = keymap.of([
      { key: "Tab", run: acceptCompletion },
      { key: "Ctrl-n", run: moveCompletionSelection(true) },
      { key: "Ctrl-p", run: moveCompletionSelection(false) },
      ...completionKeymap,
    ]);

    // Ctrl+L clears the screen, shell-style (scrolls the log off-screen, keeping scrollback).
    // Highest precedence and above Vim so it works in any mode.
    const clearKeymap = keymap.of([{
      key: "Ctrl-l",
      run: () => {
        if (host.clearScreen === undefined) {
          return false;
        }
        host.clearScreen();
        return true;
      },
    }]);

    // One line only: refuse any change that would introduce a newline, however it arrives — a
    // pasted multi-line value would otherwise become YAML the frontmatter cannot hold.
    const singleLineFilter = EditorState.transactionFilter.of((tr) => tr.docChanged && tr.newDoc.lines > 1 ? [] : tr);

    this.view = new EditorView({
      parent,
      extensions: [
        ...(singleLine ? [singleLineFilter] : []),
        Prec.highest(clearKeymap),

        // Vim next (highest), per the library's contract: it intercepts keys it maps and passes the
        // rest through, so in insert mode Enter/arrows/Tab still reach the keymaps below.
        // Compartmentalized so it can toggle live.
        Prec.highest(this.vimCompartment.of(vimMode ? vim() : [])),
        numbatLanguage,
        this.gutterCompartment.of(options.lineNumbers === true ? lineNumbers() : []),
        this.highlightCompartment.of(highlight ? numbatReplHighlight : []),

        // The incomplete-expression (typed-hole) inlay hint at the end of the input;
        // compartmentalized so the inlay settings can toggle it live.
        this.inlayCompartment.of(inlayHoles ? this.inlayExtension() : []),

        // The hover card, on the same terms as everywhere else — and standing aside for this
        // input's own completion popup rather than the editor's completer.
        this.hoverCompartment.of(hover ? this.hoverExtension() : []),
        history(),

        // CodeMirror draws the selection and the caret itself, rather than leaving them to the
        // browser. Vim requires it: in normal and visual modes the vim extension forces the
        // *native* selection transparent (it expects a drawn one), and the browser can only ever
        // show a single range anyway — so blockwise visual, which is several ranges, has nothing to
        // render without this. It is also what Obsidian's own editors use, so one implementation
        // now covers every surface and can be themed in one place.
        drawSelection(),
        EditorView.lineWrapping,

        // Render the completion popup on `document.body` (like the dwell popup and Obsidian's own
        // suggesters) so it is not clipped by, or painted under, the main editor when it overflows
        // the narrow sidebar — the REPL sits in a sidebar stacking context that the workspace
        // paints over otherwise.
        tooltips({ parent: document.body }),
        placeholder(options.placeholder),
        autocompletion({
          override: [numbatCompletionSource(plugin, host)],

          // A scoped class on the popup, so its z-index/width can be styled without touching any
          // other CodeMirror tooltip.
          tooltipClass: () => "numbat-repl-completions",

          // The REPL input sits at the bottom of the panel, above the on-screen keyboard on mobile,
          // so prefer the popup above the cursor — below would be hidden by the keyboard.
          aboveCursor: true,

          // Tag each option's row for styling: a glyph gutter on `\code` rows, a category tag on
          // expression rows, and monospace history rows — so the popup matches the editor's
          // completers.
          optionClass: (completion) => {
            const repl = completion as ReplCompletion;
            if (repl.numbatGlyph != null) {
              return "numbat-repl-code-completion";
            }
            if (repl.numbatCategory != null) {
              return "numbat-repl-expr-completion";
            }
            return "numbat-repl-history-completion";
          },

          // No type icons; the glyph gutter (below) is our leading column instead.
          icons: false,
          addToOptions: [
            {
              position: 20,
              render: (completion) => {
                const glyph = (completion as ReplCompletion).numbatGlyph;
                return glyph == null ? null : createSpan({ cls: "numbat-unicode-suggestion-glyph", text: glyph });
              },
            },
            {
              // The muted `type()` signature, between the label (50) and the tag (80).
              position: 60,
              render: (completion) => {
                const signature = (completion as ReplCompletion).numbatSignature;
                return signature == null ? null : renderSignature(signature);
              },
            },
            {
              // A muted category tag trailing each expression completion.
              position: 80,
              render: (completion) => {
                const category = (completion as ReplCompletion).numbatCategory;
                return category == null ? null : renderCategoryTag(category);
              },
            },
          ],
        }),

        // `\code` → glyph as you type; fence-free (the whole input is Numbat).
        numbatUnicodeInput(plugin, false),

        // Find/replace, for a document only: Obsidian's own Ctrl+F is bound to the Markdown editor
        // and never reaches a custom view, so without this a `.nbt` file would be the one place in
        // the app you cannot search.
        ...(documentMode ? [search({ top: true }), Prec.high(keymap.of(searchKeymap))] : []),

        // Below Vim; among these: completion popup keys, then submit/recall, then editing.
        Prec.high(completionKeys),

        // A document has nothing to submit to, so Enter falls through to the default keymap's
        // newline; the recall keys go with it (the host offers no history).
        ...(documentMode ? [] : [submitKeymap]),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.domEventHandlers({
          blur: () => {
            host.blurred?.();
            return false;
          },
        }),

        // Numbat is code, not prose: no autocapitalize/-correct/spellcheck.
        EditorView.contentAttributes.of({
          spellcheck: "false",
          autocapitalize: "off",
          autocorrect: "off",
          "aria-label": documentMode ? "Numbat file" : "Numbat expression",
        }),

        // A user edit invalidates any in-progress arrow-key recall; a programmatic set
        // (recall/clear, tagged SET_INPUT_EVENT) does not.
        EditorView.updateListener.of((update) => {
          if (
            update.docChanged
            && !update.transactions.every((tr) => tr.isUserEvent(SET_INPUT_EVENT))
          ) {
            host.changed?.();
          }
          if (host.caretMoved !== undefined && (update.selectionSet || update.docChanged)) {
            host.caretMoved(update.state.doc.lineAt(update.state.selection.main.head).number - 1);
          }

          // Drive the documentation dwell popup off the completion selection.
          this.trackCompletionDwell(update.state);
        }),
      ],
    });
  }

  /**
   * Watch the completion selection and, once it has settled on an expression completion for {@link
   * COMPLETION_DWELL_MS}, show its documentation popup above the completer. `\code`/history rows
   * (no `numbatCategory`) are ignored; a selection change or the popup closing hides it and re-arms
   * the timer. Public CM6 API only.
   */
  private trackCompletionDwell(state: EditorState): void {
    const active = completionStatus(state) === "active";

    // `Completion` is assignable to `ReplCompletion` (its extra fields are optional), so this needs
    // no cast — and a cast would be flagged as redundant.
    const selected: ReplCompletion | null = active ? selectedCompletion(state) : null;
    const label = selected?.numbatCategory != null ? selected.label : null;
    if (label === this.dwellLabel) {
      return; // no change (or still the same row) — leave the timer/popup as-is
    }

    this.dwellLabel = label;
    this.docPopup.hide();
    if (this.dwellTimer !== null) {
      window.clearTimeout(this.dwellTimer);
      this.dwellTimer = null;
    }

    if (label !== null) {
      const category = selected?.numbatCategory ?? null;
      this.dwellTimer = window.setTimeout(() => this.showDwellPopup(label, category), COMPLETION_DWELL_MS);
    }
  }

  /** Show the documentation popup for the dwelt-on completion, above the completer. */
  private showDwellPopup(label: string, category: ExprCategory | null): void {
    this.dwellTimer = null;
    const info = this.host.completionInfo(label);
    if (info === null) {
      return;
    }

    const tooltip = this.view.dom.querySelector(".cm-tooltip-autocomplete")
      ?? document.querySelector(".cm-tooltip-autocomplete");
    if (tooltip === null) {
      return;
    }

    // A non-function entry gets a `Type:` field from `type(<name>)` (functions already carry a
    // `Signature:` line; see formatDocBody).
    const typeSignature = category === "function" ? null : this.host.completionSignature(label);
    this.docPopup.showAbove(tooltip.getBoundingClientRect(), buildDocPopupContent(info, typeSignature));
  }

  /** The editor's root element, for placement within the input row. */
  get dom(): HTMLElement {
    return this.view.dom;
  }

  /** The current input text. */
  getValue(): string {
    return this.view.state.doc.toString();
  }

  /** Replace the whole input and move the caret to the end. Tagged as a programmatic set so it does
   *  not cancel an in-progress recall. */
  setValue(value: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: value },
      selection: { anchor: value.length },
      userEvent: SET_INPUT_EVENT,
    });
  }

  /** Replace the whole document and put the caret at the top — how a file is loaded into a
   *  `document`-mode editor, where the end is the wrong place to land. */
  setDocument(value: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: value },
      selection: { anchor: 0 },
      userEvent: SET_INPUT_EVENT,
    });
  }

  /** The caret's 0-indexed line, for a consumer that tracks it. */
  caretLine(): number {
    const { state } = this.view;
    return state.doc.lineAt(state.selection.main.head).number - 1;
  }

  /** Move the caret to a 0-indexed line/column and scroll it into view. */
  setCaret(line: number, ch = 0): void {
    const { doc } = this.view.state;
    const target = doc.line(Math.min(Math.max(line + 1, 1), doc.lines));
    const pos = Math.min(target.from + ch, target.to);
    this.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    this.view.focus();
  }

  /** Re-measure, for a consumer whose element was not in the document when the editor was built (a
   *  property widget: Obsidian renders the row detached and inserts it afterwards, so the first
   *  layout happens against nothing). */
  refresh(): void {
    this.view.requestMeasure();
  }

  /** Drop focus, which is what commits a property value. */
  blur(): void {
    this.view.contentDOM.blur();
  }

  /** Put keyboard focus in the editor. */
  focus(): void {
    this.view.focus();
  }

  /** Toggle live syntax highlighting without rebuilding the editor. */
  setHighlight(on: boolean): void {
    this.view.dispatch({
      effects: this.highlightCompartment.reconfigure(on ? numbatReplHighlight : []),
    });
  }

  /** Toggle the line-number gutter without rebuilding the editor. */
  setLineNumbers(on: boolean): void {
    this.view.dispatch({
      effects: this.gutterCompartment.reconfigure(on ? lineNumbers() : []),
    });
  }

  /** Toggle Vim key bindings without rebuilding the editor. */
  setVim(on: boolean): void {
    this.view.dispatch({
      effects: this.vimCompartment.reconfigure(on ? vim() : []),
    });
  }

  /** The hover extension for this input: the symbol under the pointer or the caret, carded by the
   *  host against whatever context it evaluates in. */
  private hoverExtension() {
    return numbatHover(this.plugin, {
      completerOpen: (view) => completionStatus(view.state) === "active",
      resolve: (view, pos) => this.resolveHover(view, pos),
    });
  }

  /** The card for the symbol at `pos`, or why there is none. */
  private resolveHover(view: EditorView, pos: number): HoverOutcome {
    if (this.host.hoverCard === undefined) {
      return { miss: "nothing to hover here" };
    }

    const line = view.state.doc.lineAt(pos);
    const symbol = hoverSymbolAt(line.text, pos - line.from);
    if (symbol === null) {
      return { miss: "nothing to hover at the cursor" };
    }

    const dom = this.host.hoverCard(symbol);
    return dom === null
      ? { miss: `nothing known about \`${symbol.probe}\` here` }
      : { from: line.from + symbol.from, to: line.from + symbol.to, dom };
  }

  /** Toggle (or re-read the settings of) the hover card without rebuilding the editor. */
  setHover(on: boolean): void {
    this.view.dispatch({
      effects: this.hoverCompartment.reconfigure(on ? this.hoverExtension() : []),
    });
  }

  /** This editor's inlay hints: every line's result and type for a document, and for an expression
   *  just the incomplete-input hole at the end. */
  private inlayExtension() {
    return this.documentMode
      ? numbatDocumentInlays(this.plugin, () => this.host.filePath?.() ?? null)
      : numbatReplHoleHint(this.plugin, (input) => this.host.holeType(input));
  }

  /** Toggle the inlay hints without rebuilding the editor. */
  setInlayHoles(on: boolean): void {
    this.view.dispatch({
      effects: this.inlayCompartment.reconfigure(on ? this.inlayExtension() : []),
    });
  }

  /** Leave Vim insert mode (for the mobile Esc button — a soft keyboard has no Esc key). A no-op
   *  when Vim is off or already in normal mode. */
  exitInsertMode(): void {
    const cm = getCM(this.view);
    if (cm) {
      // `getCM` types `state.vim` as nullable while `exitInsertMode` wants it non-null; the runtime
      // object is the same, so narrow via the param type.
      Vim.exitInsertMode(cm as Parameters<typeof Vim.exitInsertMode>[0]);
    }
  }

  /** Tear the editor down, along with the dwell timer and the documentation popup. */
  destroy(): void {
    if (this.dwellTimer !== null) {
      window.clearTimeout(this.dwellTimer);
    }
    this.docPopup.destroy();
    this.view.destroy();
  }
}
