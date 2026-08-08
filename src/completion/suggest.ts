// Expression-completion popover for the editor, using Obsidian's native completer UI:
// `NumbatExprEditorSuggest` (an `EditorSuggest`) offers Numbat identifiers, operators, and types
// inside `numbat` / `numbat-shared` blocks — and inside an inline-eval span's expression (`` n`…`
// ``) — as you type: two characters into a word, or straight after `.`, `:`, a generic's `<`, a
// declaration's return `->`, or a decorator's `@`. Selecting a row inserts the name (a decorator
// also gets the punctuation its grammar requires). It is the code-block counterpart of
// the REPL completer (see views/input.ts), sharing the categorization and trigger logic in
// completion/expressions.ts; only the source context differs (a shared prelude context here, the
// live session context in the REPL).
//
// It stands aside for the `\code` completer (unicode/suggest.ts) whenever the caret sits in a code,
// so the two never both fire.

import { type EditorView } from "@codemirror/view";
import {
  type App,
  type Editor,
  type EditorPosition,
  EditorSuggest,
  type EditorSuggestContext,
  type EditorSuggestTriggerInfo,
} from "obsidian";
import { type FenceSpan, inNumbatBody, numbatFenceState } from "../document/fence-state";
import { insideNumbatFence } from "../document/fences";
import { inlineSpanAtCursor } from "../evaluation/inline";
import {
  completionInfo,
  completionSignature,
  contextGeneration,
  ensureBlockCompletion,
  ensureNumbatReady,
  expressionCompletionCandidates,
  isNumbatReady,
  type Numbat,
  structFields,
  touchCompletionIdle,
} from "../interpreter/numbat";
import type SymbatPlugin from "../main";
import { type PropertyValueSite } from "../properties/parse";
import { numbatPropertySiteAt, replayChunksAt } from "../scope/replay";
import { COMPLETION_DWELL_MS } from "../tuning";
import { unicodePrefixAt } from "../unicode/codes";
import { chooserOf, registerSuggestKeys } from "../unicode/suggest";
import { decoratorInfo } from "./docs";
import {
  allowedCategoriesAt,
  boundCompletions,
  decoratorCompletions,
  type ExprCompletion,
  expressionCompletions,
  exprTriggerAt,
  memberBaseAt,
  typeVariableCompletions,
} from "./expressions";
import { buildDocPopupContent, DocPopup, renderExprSuggestion } from "./render";

/** Maximum rows shown at once. */
const SUGGESTION_LIMIT = 60;

// CORE TYPES
// ================================================================================================

/** A non-actionable placeholder row shown while the wasm is still loading. */
interface LoadingSuggestion {
  /** A literal discriminant, so {@link isLoading} can narrow the union without a field that a real
   *  completion might also carry. */
  loading: true;
}

/** A completer row: either a real completion or the loading placeholder. */
type ExprSuggestion = ExprCompletion | LoadingSuggestion;

// The one placeholder instance; it carries no per-use state.
const LOADING: LoadingSuggestion = { loading: true };

/** Whether a row is the placeholder rather than a real completion. */
function isLoading(suggestion: ExprSuggestion): suggestion is LoadingSuggestion {
  return "loading" in suggestion;
}

/** The editor's maintained fence index, when it has one. Obsidian's `Editor` wraps a CodeMirror
 *  view (`.cm`, undocumented but relied on elsewhere in this plugin); without it — a mobile or
 *  legacy editor — the caller scans instead. */
function fenceSpansOf(editor: Editor): readonly FenceSpan[] | undefined {
  const view = (editor as unknown as { cm?: EditorView; }).cm;
  return view?.state.field(numbatFenceState, false) ?? undefined;
}

/** The lines above `line` (0-indexed), for the scanning fallback. */
function precedingLines(editor: Editor, line: number): string[] {
  const lines: string[] = [];
  for (let n = 0; n < line; n += 1) {
    lines.push(editor.getLine(n));
  }

  return lines;
}

// EDITOR SUGGESTER
// ================================================================================================

/**
 * Expression completion inside `numbat` blocks and inline-eval spans: names, keywords, units,
 * dimensions and types, drawn from the interpreter's own vocabulary plus whatever the note has
 * bound above the cursor.
 *
 * The vocabulary needs the wasm, which may not be up when the user starts typing, so a cold trigger
 * shows a placeholder row and warms up in the background rather than showing nothing.
 */
export class NumbatExprEditorSuggest extends EditorSuggest<ExprSuggestion> {
  /** Read live for the completion settings and the note's scope. */
  private readonly plugin: SymbatPlugin;

  /** Whether a background warm-up is already in flight (avoids piling them up). */
  private warming = false;

  /** The block-completion context of the current popover, for signature/info lookups, with the
   *  {@link contextGeneration} it was obtained at. Read only through {@link liveBlockContext} — the
   *  interpreter frees these behind our back (the idle release, a prelude change, a restart). */
  private lastBlockContext: Numbat | null = null;

  /** The {@link contextGeneration} {@link lastBlockContext} was obtained at; when the module's
   *  generation moves past it, that pointer is into a freed context. */
  private lastBlockGeneration = 0;

  /** The suggestions currently shown, so a selected index maps back to its name. */
  private shown: ExprSuggestion[] = [];

  /** The shared floating documentation popup shown on dwell. */
  private readonly docPopup = new DocPopup();

  /** The pending dwell timer, and the `.is-selected` observer driving it. */
  private dwellTimer: number | null = null;

  /** Watches the popover for `.is-selected` moving, which is the only signal Obsidian gives that
   *  the highlighted row changed. */
  private observer: MutationObserver | null = null;

  /** @param app Obsidian's app, for `EditorSuggest`. @param plugin the plugin to read. */
  constructor(app: App, plugin: SymbatPlugin) {
    super(app);
    this.plugin = plugin;
    this.limit = SUGGESTION_LIMIT;
    registerSuggestKeys(this);
  }

  /**
   * Initialize the wasm, exchange rates, and prelude in the background so a later keystroke finds
   * everything ready. Guarded so concurrent keystrokes share one warm-up rather than starting
   * several.
   */
  private async warmUp(): Promise<void> {
    if (this.warming) {
      return;
    }
    this.warming = true;

    try {
      await ensureNumbatReady();
      await this.plugin.ensureExchangeRates();
      await this.plugin.ensurePrelude();
    } catch (error) {
      console.error("Symbat: expression completion failed to initialize", error);
    } finally {
      this.warming = false;
    }
  }

  /**
   * Decide whether the caret is somewhere Numbat completion applies, and if so what the accepted
   * completion replaces.
   *
   * This runs on every keystroke, including in ordinary prose, so the order of the checks is
   * deliberate: the settings gates and the trigger-shape test come first, and the document scan
   * that decides "is this Numbat code" runs only once those have passed.
   */
  onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
    const { settings } = this.plugin;
    if (!settings.exprCompletion) {
      return null;
    }

    if (
      !settings.completeIdentifiers && !settings.completeKeywords && !settings.completeUnits
      && !settings.completeDimensions && !settings.completeTypes
    ) {
      return null;
    }

    // Cheap checks first (they run on every keypress). Defer to the `\code` completer when the
    // caret sits in a code (the unicode leader wins).
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    if (
      settings.unicodeExpansion
      && settings.unicodeLeader !== ""
      && unicodePrefixAt(before, settings.unicodeLeader) !== null
    ) {
      return null;
    }

    const trigger = exprTriggerAt(before);
    if (trigger === null) {
      return null;
    }

    // Only inside a numbat block or an inline-eval span's expression. The trigger above rejects far
    // less than it looks like it does — it fires on any two-letter word, i.e. ordinary prose — so
    // this is where the cost of a keystroke in a long note used to be, at two whole-document line
    // arrays each. The fence answer comes from the maintained index when there is one.
    const spans = fenceSpansOf(editor);
    const inFence = spans === undefined
      ? insideNumbatFence(precedingLines(editor, cursor.line))
      : inNumbatBody(spans, cursor.line);
    if (
      !inFence
      && inlineSpanAtCursor(this.plugin, editor, cursor) === null
      && this.frontmatterSiteAt(editor, cursor) === null
    ) {
      return null;
    }

    return {
      start: { line: cursor.line, ch: cursor.ch - trigger.replaceLength },
      end: cursor,
      query: trigger.query,
    };
  }

  /** The Numbat-typed property whose value the caret sits in, or `null` — the third completable
   *  position, beside a `numbat` fence and an inline span (see {@link numbatPropertySiteAt}, shared
   *  with the hover). */
  private frontmatterSiteAt(
    editor: Editor,
    cursor: EditorPosition,
    preceding?: readonly string[],
  ): PropertyValueSite | null {
    return numbatPropertySiteAt(this.plugin.app, editor, cursor, preceding);
  }

  /**
   * The rows to show for the current query. Async because a cold start has to wait for the wasm;
   * when it is not ready yet this returns the placeholder row and warms up, so the popover appears
   * immediately rather than after the load.
   */
  async getSuggestions(context: EditorSuggestContext): Promise<ExprSuggestion[]> {
    const { settings } = this.plugin;

    // Reset the dwell state for this new query: hide any open popup and drop the observer
    // (renderSuggestion re-attaches it to the current popover), and clear the shown-rows map
    // (repopulated below when real completions are returned).
    this.teardownDwell();
    this.shown = [];

    // Belt and braces: onTrigger already gates on this, so the code above is never replayed while
    // the feature is off, but re-check in case the setting changed.
    if (!settings.exprCompletion) {
      return [];
    }

    // A `:`/`<`/`->` position offers types/dimensions/units, narrowed by the surrounding syntax;
    // the text before the query anchor is where that sits. In an inline span the Numbat source
    // starts at the span's content, so the syntax checks must not see the prefix and backticks
    // before it.
    const anchorLine = context.editor.getLine(context.start.line).slice(0, context.start.ch);
    const inlineSpan = inlineSpanAtCursor(this.plugin, context.editor, context.start);

    // In a frontmatter value the Numbat source starts after `key:`, exactly as an inline span's
    // starts after its backtick — the syntax checks must not see the YAML key, or `total: costs.`
    // would read as a `:` type annotation.
    const fmSite = inlineSpan === null ? this.frontmatterSiteAt(context.editor, context.start) : null;
    const beforeAnchor = inlineSpan !== null
      ? anchorLine.slice(inlineSpan.contentStart)
      : fmSite !== null
      ? anchorLine.slice(fmSite.valueCh)
      : anchorLine;
    const enabled = {
      identifiers: settings.completeIdentifiers,
      keywords: settings.completeKeywords,
      units: settings.completeUnits,
      dimensions: settings.completeDimensions,
      types: settings.completeTypes,
    };

    // A type-parameter bound position (`fn foo<D: `) admits exactly one name — `Dim` — and every
    // engine candidate is a parse error there, so it is served without touching the wasm at all.
    const bound = boundCompletions(beforeAnchor, context.query, enabled);
    if (bound !== null) {
      this.shown = bound;
      return bound;
    }

    // A decorator position (`@`) is the same story: a closed set the interpreter has no vocabulary
    // for, and every engine candidate is a parse error after the `@`. Only a fence body takes
    // statements, though — an inline span and a frontmatter value each hold a single expression,
    // which a decorator has nothing to annotate in.
    const decorators = decoratorCompletions(
      beforeAnchor,
      context.query,
      enabled,
      inlineSpan === null && fmSite === null,
    );
    if (decorators !== null) {
      this.shown = decorators;
      return decorators;
    }

    // The wasm can take a moment to initialize on first use. Rather than block the popover
    // silently, warm it up in the background and show a placeholder row; a subsequent keystroke,
    // once ready, shows real completions.
    if (!isNumbatReady()) {
      void this.warmUp();
      return [LOADING];
    }
    try {
      // The prelude must be applied before the context is built (a fast vault read, a no-op once
      // loaded); exchange rates settle in the background.
      await this.plugin.ensurePrelude();
    } catch (error) {
      console.error("Symbat: expression completion failed to initialize", error);
      return [];
    }
    void this.plugin.ensureExchangeRates();

    // Replay the code the user has already written above the cursor, so their own definitions
    // complete. `ensureBlockCompletion` caches the built context, so this only rebuilds when the
    // code above changes — not on every keystroke.
    const chunks = this.codeBeforeCursor(context);
    const built = ensureBlockCompletion(chunks, settings.fetchExchangeRates);
    if (built === null) {
      return [];
    }

    // Stash the context so renderSuggestion / the dwell popup can look up signatures and
    // documentation against it.
    this.lastBlockContext = built.context;
    this.lastBlockGeneration = contextGeneration();

    // Keep the context warm while completing, and schedule its release once idle.
    touchCompletionIdle(settings.completionIdleSeconds * 1000);

    // Member position: Numbat's own completer offers nothing after a `.`, so the struct's fields
    // are supplied here — and *instead of* the engine's candidates, which in member position are
    // all names that cannot legally appear there. A base that is not a struct falls through to the
    // ordinary behavior.
    const memberBase = enabled.identifiers ? memberBaseAt(beforeAnchor) : null;
    if (memberBase !== null) {
      const query = context.query.toLowerCase();
      const fields = structFields(built.context, memberBase)
        .filter((field) => field.toLowerCase().startsWith(query))
        .map((field) => ({ name: field, category: "field" as const, probeName: `${memberBase}.${field}` }));
      if (fields.length > 0) {
        this.shown = fields;
        return fields;
      }
    }

    const allowed = allowedCategoriesAt(beforeAnchor);
    const raw = expressionCompletionCandidates(built.context, context.query);
    const engine = expressionCompletions(raw, built.vocab, enabled, allowed);

    // The enclosing declaration's type variables complete first — they are the most contextual, and
    // the engine does not know them. The declaration header may sit on a line above the cursor, so
    // the scope text spans the replayed code as well as the current line.
    const scopeText = `${chunks.join("\n")}\n${beforeAnchor}`;
    const typeVars = typeVariableCompletions(scopeText, context.query, enabled, allowed);
    const injected = new Set(typeVars.map((completion) => completion.name));
    const suggestions = [...typeVars, ...engine.filter((completion) => !injected.has(completion.name))];
    this.shown = suggestions;

    return suggestions;
  }

  /** The code to replay so completions see the user's own definitions — the shared position-scope
   *  walk (see {@link replayChunksAt}). The caret's own line is left out: completion asks what is
   *  in scope *so far*, and that line is half-typed. */
  private codeBeforeCursor(context: EditorSuggestContext): string[] {
    return replayChunksAt(this.plugin, context.editor, context.file?.path ?? null, context.start);
  }

  /** Draw one row: its name, category icon and signature — or the loading placeholder. Also the
   *  point at which the popover first exists in the DOM, so the dwell observer is attached here
   *  rather than on trigger. */
  renderSuggestion(value: ExprSuggestion, el: HTMLElement): void {
    if (isLoading(value)) {
      el.addClass("numbat-expr-loading");
      el.setText("Loading Numbat…");
      return;
    }
    // A decorator has no type — and must not be probed, or a binding that happens to share the name
    // would put its signature on the row.
    const probe = value.probeName ?? value.name;
    const live = value.category === "decorator" ? null : this.liveBlockContext();
    const signature = live !== null ? completionSignature(live, probe) : null;
    renderExprSuggestion(el, value, signature);
    // The popover exists now, so its container is reachable for the dwell observer.
    this.ensureDwellObserver();
  }

  /** Insert the chosen name over the triggering range and put the caret after it — or, for a
   *  decorator, its name plus the punctuation its grammar requires, caret at the argument. */
  selectSuggestion(value: ExprSuggestion): void {
    const { context } = this;
    if (context === null || isLoading(value)) {
      return; // the placeholder is not actionable
    }

    // A decorator writes the punctuation its grammar requires, and puts the caret where its arg
    // goes rather than after the closing paren.
    const { text, caret } = value.applied ?? { text: value.name, caret: value.name.length };
    context.editor.replaceRange(text, context.start, context.end);
    context.editor.setCursor({ line: context.start.line, ch: context.start.ch + caret });
    this.close();
  }

  /** Tear down the dwell popup along with the popover. */
  close(): void {
    this.teardownDwell();
    super.close();
  }

  /** Free the floating popup element (called on plugin unload). */
  destroy(): void {
    this.teardownDwell();
    this.docPopup.destroy();
  }

  // --- Documentation dwell popup --------------------------------------------
  //
  // Obsidian's EditorSuggest exposes no "selection changed" hook, so we observe the popover's
  // `.is-selected` class (via the same internal chooser used for Ctrl-N/P) and, after the selection
  // has settled for COMPLETION_DWELL_MS, show the shared `print_info` popup above the completer.
  // Every internal access is defensive — if the internals are unavailable the popup simply never
  // shows; the inline signature is unaffected.

  /** The popover's container element, from the internal chooser or the suggest's own popover root —
   *  both undocumented, so accessed defensively (null → no popup). */
  private popoverContainer(): HTMLElement | null {
    return chooserOf(this)?.containerEl
      ?? (this as unknown as { suggestEl?: HTMLElement; }).suggestEl
      ?? null;
  }

  /** Attach the `.is-selected` observer once the popover container exists. */
  private ensureDwellObserver(): void {
    if (this.observer !== null) {
      return;
    }
    const container = this.popoverContainer();
    if (container == null) {
      return;
    }
    this.observer = new MutationObserver(() => this.onSelectionChanged());
    this.observer.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  }

  /** A selection move (or list change): hide the current popup and re-arm the dwell. */
  private onSelectionChanged(): void {
    this.docPopup.hide();
    if (this.dwellTimer !== null) {
      window.clearTimeout(this.dwellTimer);
    }
    this.dwellTimer = window.setTimeout(() => this.showDwellPopup(), COMPLETION_DWELL_MS);
  }

  /** Show the documentation popup for the currently-selected completion. */
  /**
   * The stashed block context, or `null` if the interpreter has freed it since.
   *
   * Leaving a popover open for `completionIdleSeconds` releases the completion contexts — only
   * `getSuggestions` re-arms that timer, so simply reading the list does not. Calling into the
   * freed handle throws "null pointer passed to Rust", which the catch downstream treats as an
   * interpreter crash and recovers from by restarting the whole engine. Dropping the reference
   * instead costs a signature line on one popover.
   */
  private liveBlockContext(): Numbat | null {
    if (this.lastBlockContext !== null && this.lastBlockGeneration !== contextGeneration()) {
      this.lastBlockContext = null;
    }
    return this.lastBlockContext;
  }

  /** Show the documentation popup for the highlighted row, once the dwell elapses. Silently does
   *  nothing if anything it needs has gone — the popover may have closed, or the context been
   *  freed, while the timer ran. */
  private showDwellPopup(): void {
    this.dwellTimer = null;
    const chooser = chooserOf(this);
    const container = this.popoverContainer();
    if (chooser == null || container == null) {
      return;
    }
    const value = this.shown[chooser.selectedItem];
    if (value === undefined || isLoading(value)) {
      return;
    }

    // A row carrying its own description is one the interpreter cannot answer for — a decorator,
    // which no context has heard of — so it needs neither a live context nor a `type()` probe.
    if (value.doc !== undefined) {
      const card = buildDocPopupContent(decoratorInfo(value.name, value.doc));
      this.docPopup.showAbove(container.getBoundingClientRect(), card);
      return;
    }

    const live = this.liveBlockContext();
    if (live === null) {
      return;
    }
    const info = completionInfo(live, value.name);
    if (info === null) {
      return;
    }
    // A non-function entry gets a `Type:` field from `type(<name>)` (functions already carry a
    // `Signature:` line; see formatDocBody).
    const probeName = value.probeName ?? value.name;
    const typeSignature = value.category === "function" ? null : completionSignature(live, probeName);
    this.docPopup.showAbove(container.getBoundingClientRect(), buildDocPopupContent(info, typeSignature));
  }

  /** Cancel the dwell timer, disconnect the observer, and hide the popup. */
  private teardownDwell(): void {
    if (this.dwellTimer !== null) {
      window.clearTimeout(this.dwellTimer);
      this.dwellTimer = null;
    }
    this.observer?.disconnect();
    this.observer = null;
    this.docPopup.hide();
  }
}
