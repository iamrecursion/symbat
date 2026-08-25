// Expression-completion popover for the editor, using Obsidian's native completer UI:
// `NumbatExprEditorSuggest` (an `EditorSuggest`) offers Numbat identifiers, operators, and types
// inside `numbat` / `numbat-shared` blocks — and inside an inline-eval span's expression (`` n`…`
// ``) — as you type: two characters into a word, or straight after `.`, `:`, a generic's `<`, a
// declaration's return `->`, or a decorator's `@`. Selecting a row inserts the name (a decorator
// also gets the punctuation its grammar requires). It is the code-block counterpart of
// the REPL completer (see views/input.ts), sharing the categorization and trigger logic in
// completion/expressions.ts; only the scope differs (the code above the cursor here, the live
// session in the REPL).
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
import { type ScopeSpec, WANT_INFO, WANT_SIGNATURE } from "../interpreter/facts";
import { scopeFactsHost } from "../interpreter/live-facts";
import { ask, ensureNumbatReady, isNumbatReady, touchCompletionIdle } from "../interpreter/numbat";
import type { CompletionsReply } from "../interpreter/protocol";
import type SymbatPlugin from "../main";
import { type PropertyValueSite } from "../properties/parse";
import { numbatPropertySiteAt, replayChunksAt } from "../scope/replay";
import { COMPLETION_DWELL_MS } from "../tuning";
import { unicodePrefixAt } from "../unicode/codes";
import { chooserOf, registerSuggestKeys } from "../unicode/suggest";
import { declaredInfo, declaredTypeHtml, decoratorInfo } from "./docs";
import {
  allowedCategoriesAt,
  boundCompletions,
  declaredNameCompletions,
  decoratorCompletions,
  type ExprCategories,
  type ExprCompletion,
  expressionCompletions,
  exprTriggerAt,
  isInterpreterKnown,
  memberBaseAt,
  typeVariableCompletions,
} from "./expressions";
import { isVisibleAnchor } from "./placement";
import { buildDocPopupContent, DocPopup, renderExprSuggestion } from "./render";

/**
 * Maximum rows shown at once. Also exactly how many rows are asked about: Obsidian truncates the
 * list to this, so probing further would be filling facts for rows that cannot be drawn.
 */
const SUGGESTION_LIMIT = 60;

/** What the documentation popup asks about a row: the body, and the type line above it. */
const WANT_DWELL = WANT_INFO | WANT_SIGNATURE;

// CORE TYPES
// ================================================================================================

/** A non-actionable placeholder row shown while the wasm is still loading. */
interface LoadingSuggestion {
  /**
   * A literal discriminant, so {@link isLoading} can narrow the union without a field that a real
   * completion might also carry.
   */
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

/**
 * The editor's maintained fence index, when it has one. Obsidian's `Editor` wraps a CodeMirror
 * view (`.cm`, undocumented but relied on elsewhere in this plugin); without it — a mobile or
 * legacy editor — the caller scans instead.
 */
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

  /**
   * The scope the current popover's rows were resolved against, or `null` when they were served
   * without one. Named rather than held: what the renderer and the dwell popup need is a key to
   * read facts under, and a key cannot be freed behind their backs the way a context can.
   */
  private lastScope: ScopeSpec | null = null;

  /**
   * Facts about the names in {@link lastScope} — read synchronously by the renderer, filled by
   * {@link getSuggestions} before the rows are handed over.
   */
  private readonly facts = scopeFactsHost(
    () => this.lastScope,
    () => this.plugin.settings.completionIdleSeconds * 1000,
  );

  /** The suggestions currently shown, so a selected index maps back to its name. */
  private shown: ExprSuggestion[] = [];

  /** The shared floating documentation popup shown on dwell. */
  private readonly docPopup = new DocPopup();

  /** The pending dwell timer, and the `.is-selected` observer driving it. */
  private dwellTimer: number | null = null;

  /**
   * Watches the popover for `.is-selected` moving, which is the only signal Obsidian gives that
   * the highlighted row changed.
   */
  private observer: MutationObserver | null = null;

  /**
   * Bumped whenever the dwell is abandoned — the popover closing, a new query, or the selection
   * moving — so an answer arriving afterwards knows the card it belonged to is no longer wanted.
   *
   * The retry in {@link showDwellPopup} arrives on a promise rather than on {@link dwellTimer}, so
   * {@link teardownDwell} cannot cancel it, and its own guard reads a selection that closing the
   * popover leaves exactly as it was. This is the part a teardown *can* invalidate.
   *
   * A selection move bumps it as well as a teardown, so that arrowing off a row and back onto it
   * does not let the first dwell's answer land as though it were the second's: the row is the same
   * object either side, so the identity check alone would pass.
   */
  private dwellAttempt = 0;

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

  /**
   * The Numbat-typed property whose value the caret sits in, or `null` — the third completable
   * position, beside a `numbat` fence and an inline span (see {@link numbatPropertySiteAt}, shared
   * with the hover).
   */
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
      // No scope is named for these, and none should be: they are served without touching the wasm,
      // so nothing about them is to be read out of a scope some earlier query left behind.
      this.lastScope = null;
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
      this.lastScope = null;
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

    // The code the user has already written above the cursor, named rather than replayed here, so
    // their own definitions complete. The interpreter caches the context it builds from that name,
    // so it only rebuilds when the code above changes instead of on every keystroke.
    const scope: ScopeSpec = {
      chunks: this.codeBeforeCursor(context),
      applyRates: settings.fetchExchangeRates,
    };
    // Name the scope the rows belong to, so the renderer and the dwell popup can read facts about
    // them without a handle of their own.
    this.lastScope = scope;

    // Keep the scope's context warm while completing, and schedule its release once idle.
    touchCompletionIdle(settings.completionIdleSeconds * 1000);

    // Member position: Numbat's own completer offers nothing after a `.`, so the struct's fields
    // are supplied here — and *instead of* the engine's candidates, which in member position are
    // all names that cannot legally appear there. A base that is not a struct falls through to the
    // ordinary behavior.
    const memberBase = enabled.identifiers ? memberBaseAt(beforeAnchor) : null;
    const reply = await ask("completions", {
      ref: { kind: "scope", spec: scope },
      query: context.query,
      ...(memberBase === null ? {} : { memberBase }),
    }, { priority: "interactive", group: "completions" });
    if (reply === null) {
      return [];
    }

    if (memberBase !== null && reply.fields !== null) {
      const query = context.query.toLowerCase();
      const fields = reply.fields
        .filter((field) => field.toLowerCase().startsWith(query))
        .map((field) => ({ name: field, category: "field" as const, probeName: `${memberBase}.${field}` }));
      if (fields.length > 0) {
        this.shown = fields;
        await this.fillSignatures(fields);
        return fields;
      }
    }

    // A base that is not a struct falls through to the ordinary behavior, which the same answer
    // already carries the candidates for.
    return this.ordinaryCompletions(context, beforeAnchor, scope, enabled, reply);
  }

  /**
   * The name completions for a non-member position: what the engine offers, plus what the enclosing
   * declaration itself binds.
   *
   * Split out from {@link getSuggestions} only because the member branch falls through into it —
   * a `.` after something that turns out not to be a struct.
   */
  private async ordinaryCompletions(
    context: EditorSuggestContext,
    beforeAnchor: string,
    scope: ScopeSpec,
    enabled: ExprCategories,
    reply: CompletionsReply,
  ): Promise<ExprSuggestion[]> {
    if (reply.vocab === null) {
      return [];
    }

    const allowed = allowedCategoriesAt(beforeAnchor);
    const engine = expressionCompletions([...reply.candidates], reply.vocab, enabled, allowed);

    // What the enclosing declaration itself binds completes first — its type variables at a type
    // position, its parameters and `where`/`and` locals in a value one. They are the most
    // contextual names there are, and the engine knows none of them. The declaration header may sit
    // several lines above the cursor, so the scope text spans the replayed code as well as the
    // current line.
    const scopeText = `${scope.chunks.join("\n")}\n${beforeAnchor}`;
    const local = [
      ...typeVariableCompletions(scopeText, context.query, enabled, allowed),
      ...declaredNameCompletions(scopeText, context.query, enabled, allowed),
    ];
    const injected = new Set(local.map((completion) => completion.name));
    const suggestions = [...local, ...engine.filter((completion) => !injected.has(completion.name))];
    this.shown = suggestions;
    await this.fillSignatures(suggestions);

    return suggestions;
  }

  /**
   * Ask for the signatures the rows about to be drawn will want, in one batch.
   *
   * **This is what A4b is for.** The signature used to be fetched inside `renderSuggestion`, once
   * per visible row, synchronously, from a stashed handle — a renderer being the one place in the
   * plugin with no way to wait for anything and no second chance to draw. Asking here instead puts
   * the whole popover's worth of questions into one request, on a path that is already `async`, and
   * leaves the renderer a map read.
   *
   * Only what can be drawn is asked about: Obsidian truncates the list to {@link SUGGESTION_LIMIT},
   * and a row past that is a fact nobody sees. Rows the interpreter has never heard of — a
   * decorator, a parameter, a `where` local — are not asked about at all; their signature comes
   * from the declaration that binds them.
   */
  private async fillSignatures(rows: readonly ExprCompletion[]): Promise<void> {
    await this.facts.facts(
      rows.slice(0, SUGGESTION_LIMIT)
        .filter((row) => isInterpreterKnown(row.category))
        .map((row) => row.probeName ?? row.name),
      WANT_SIGNATURE,
    );
  }

  /**
   * The code to replay so completions see the user's own definitions — the shared position-scope
   * walk (see {@link replayChunksAt}). The caret's own line is left out: completion asks what is
   * in scope *so far*, and that line is half-typed.
   */
  private codeBeforeCursor(context: EditorSuggestContext): string[] {
    return replayChunksAt(this.plugin, context.editor, context.file?.path ?? null, context.start);
  }

  /**
   * Draw one row: its name, category icon and signature — or the loading placeholder. Also the
   * point at which the popover first exists in the DOM, so the dwell observer is attached here
   * rather than on trigger.
   */
  renderSuggestion(value: ExprSuggestion, el: HTMLElement): void {
    if (isLoading(value)) {
      el.addClass("numbat-expr-loading");
      el.setText("Loading Numbat…");
      return;
    }

    // A row the interpreter has never heard of must not be asked about, or a binding that happens
    // to share the name would put its signature on the row. A parameter still shows a signature,
    // which is the type its own declaration writes.
    //
    // `undefined` here means the fill did not answer for this row, which is the same situation the
    // freed-context check used to describe and is handled the same way: fall back to what the
    // declaration says, and failing that show no signature at all.
    const known = isInterpreterKnown(value.category)
      ? this.facts.knownFacts(value.probeName ?? value.name, WANT_SIGNATURE)
      : undefined;
    const declaredType = value.declared?.type ?? null;
    const signature = known !== undefined
      ? known.signature
      : declaredType === null
      ? null
      : declaredTypeHtml(declaredType);
    renderExprSuggestion(el, value, signature);

    // The popover exists now, so its container is reachable for the dwell observer.
    this.ensureDwellObserver();
  }

  /**
   * Insert the chosen name over the triggering range and put the caret after it — or, for a
   * decorator, its name plus the punctuation its grammar requires, caret at the argument.
   */
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

  /**
   * The popover's container element, from the internal chooser or the suggest's own popover root —
   * both undocumented, so accessed defensively (null → no popup).
   */
  private popoverContainer(): HTMLElement | null {
    return chooserOf(this)?.containerEl
      ?? (this as unknown as { suggestEl?: HTMLElement; }).suggestEl
      ?? null;
  }

  /**
   * The rectangle to anchor a card to: the popover's container measured while the popover is
   * actually **on screen**, which is the only state in which it can anchor anything, and `null`
   * otherwise.
   *
   * Kept apart from {@link popoverContainer} rather than folded into it: the observer is attached
   * from `renderSuggestion`, mid-way through Obsidian building the popover, and a container not yet
   * laid out is one the observer still wants. Only the anchor needs the stricter answer.
   *
   * The check is about the reference being *stale*, not about the internals being unavailable.
   * Obsidian detaches the popover element on close and goes on handing the same reference back, and
   * a detached element measures as an all-zero rect. This places the card at the top-left corner of
   * the window, where nothing that could close it is watching any more. Asking the element whether
   * it is on screen rather than trusting a flag is what `completerOpen` in hover/note.ts does.
   *
   * The question itself is {@link isVisibleAnchor}'s, so this popover and the REPL's own put the
   * same one, and so a *parked* popover — one still in the document but moved off-screen — is
   * refused here too rather than only a detached one.
   */
  private popoverAnchor(): DOMRect | null {
    const container = this.popoverContainer();
    if (container === null || !container.isConnected) {
      return null;
    }

    // The rect is returned rather than the element so the anchor is measured once, and so the rect
    // that was checked for life is the one the card is placed against.
    const rect = container.getBoundingClientRect();
    return isVisibleAnchor(rect, window.innerHeight) ? rect : null;
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

  /**
   * A selection move (or list change): abandon the dwell in flight, hide the current popup, and
   * re-arm.
   */
  private onSelectionChanged(): void {
    this.dwellAttempt += 1;
    this.docPopup.hide();
    if (this.dwellTimer !== null) {
      window.clearTimeout(this.dwellTimer);
    }

    // Start the lookup with the timer rather than after it, so the answer is usually there by the
    // time the dwell elapses. The scope is warm as the query that produced these rows just used it.
    const selected = this.selectedRow();
    if (selected !== null && selected.doc === undefined && selected.declared === undefined) {
      void this.facts.facts([selected.name], WANT_DWELL);
    }

    this.dwellTimer = window.setTimeout(() => this.showDwellPopup(), COMPLETION_DWELL_MS);
  }

  /** The completion the popover is highlighting, or `null` when there is none to answer for. */
  private selectedRow(): ExprCompletion | null {
    const value = this.shown[chooserOf(this)?.selectedItem ?? -1];
    return value === undefined || isLoading(value) ? null : value;
  }

  /**
   * Show the documentation popup for the highlighted row, once the dwell elapses. Silently does
   * nothing if anything it needs has gone as the popover may have closed while the timer ran.
   *
   * A dwell is the reader having *stopped*, so unlike the rows there is no next keystroke to be
   * corrected on: a row the facts layer cannot answer for yet is asked about and comes back here,
   * at most once. What used to guard this was a freed-context check. The idle release frees the
   * completion contexts while a popover sits open, and calling into the freed handle threw "null
   * pointer passed to Rust", which downstream read as a crash and restarted the whole engine. There
   * is no handle to free now, so that hazard is gone rather than guarded.
   */
  private showDwellPopup(retried = false): void {
    if (!retried) {
      this.dwellTimer = null;
    }
    const chooser = chooserOf(this);
    const anchor = this.popoverAnchor();
    if (chooser == null || anchor === null) {
      return;
    }
    const value = this.shown[chooser.selectedItem];
    if (value === undefined || isLoading(value)) {
      return;
    }

    // A row carrying its own card is one the interpreter cannot answer for — a decorator, which no
    // context has heard of, or a name the enclosing declaration binds, which only its own source
    // describes — so it needs neither a live context nor a `type()` probe.
    if (value.doc !== undefined) {
      const card = buildDocPopupContent(decoratorInfo(value.name, value.doc));
      this.docPopup.show(anchor, card);
      return;
    }
    if (value.declared !== undefined) {
      const { kind, type, owner } = value.declared;
      const card = buildDocPopupContent(
        declaredInfo(kind, value.name, owner),
        type === null ? null : declaredTypeHtml(type),
      );
      this.docPopup.show(anchor, card);
      return;
    }

    const known = this.facts.knownFacts(value.name, WANT_DWELL);
    if (known === undefined) {
      if (retried) {
        return;
      }

      const attempt = this.dwellAttempt;
      void this.facts.facts([value.name], WANT_DWELL).then(() => {
        // Still the same dwell, and still the row being dwelt on: the reader may have arrowed on,
        // or closed the popover, in the meantime.
        if (this.dwellAttempt === attempt && this.selectedRow() === value) {
          this.showDwellPopup(true);
        }
      });
      return;
    }
    if (known.info === null) {
      return;
    }

    // A non-function entry gets a `Type:` field from `type(<name>)` (functions already carry a
    // `Signature:` line; see formatDocBody). The signature is the *row's* probe, which for a member
    // row is the whole chain, so it is read separately from the body's name.
    const probeName = value.probeName ?? value.name;
    const typeSignature = value.category === "function"
      ? null
      : this.facts.knownFacts(probeName, WANT_SIGNATURE)?.signature ?? null;
    this.docPopup.show(anchor, buildDocPopupContent(known.info, typeSignature));
  }

  /**
   * Cancel the dwell timer, disconnect the observer, hide the popup, and abandon an answer still on
   * its way.
   */
  private teardownDwell(): void {
    this.dwellAttempt += 1;
    if (this.dwellTimer !== null) {
      window.clearTimeout(this.dwellTimer);
      this.dwellTimer = null;
    }
    this.observer?.disconnect();
    this.observer = null;
    this.docPopup.hide();
  }
}
