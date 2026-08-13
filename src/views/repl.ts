// A stateful Numbat REPL hosted in a sidebar panel.

import { ItemView, Platform, setIcon, type WorkspaceLeaf } from "obsidian";
import {
  type CompletionVocabulary,
  type ExprCategories,
  type ExprCategory,
  type ExprCompletion,
  expressionCompletions,
} from "../completion/expressions";
import { holeForm, parseHoleType } from "../evaluation/inlay-parse";
import { symbolCard } from "../hover/content";
import { escapeHtml, jqueryTerminalToHtml } from "../interpreter/markup";
import {
  buildCompletionVocabulary,
  completionInfo,
  completionSignature,
  createContext,
  describeError,
  ensureNumbatReady,
  expressionCompletionCandidates,
  freeQuietly,
  getLastPreludeError,
  interpret,
  isNumbatReady,
  type Numbat,
  readableOutput,
  restartNumbat,
  structFields,
} from "../interpreter/numbat";
import { setNumbatHtml } from "../interpreter/render";
import type SymbatPlugin from "../main";
import { isValidCssFontSize } from "../settings/util";
import { fuzzyFilter } from "./fuzzy";
import { NumbatInput } from "./input";
import { SoftKeyboardTracker } from "./soft-keyboard";

/** Persisted in the vault's `workspace.json` — see the note on `VIEW_TYPE_NUMBAT_FILE` in
 *  views/nbt.ts. Renaming it orphans open REPL panes. */
export const VIEW_TYPE_NUMBAT_REPL = "numbat-repl";

/** Count the display lines contributed by a log entry's text (min 1). */
function countLines(text: string): number {
  const stripped = text.replace(/\n+$/, "");
  return stripped === "" ? 1 : stripped.split("\n").length;
}

/**
 * A stateful Numbat REPL: one persistent interpreter context, prefix fuzzy-searchable input history
 * (arrow keys or the history completer), and a visible output log bounded to a configurable number
 * of lines.
 */
export class NumbatReplView extends ItemView {
  /** Read for settings and the prelude; also what the input editor is built against. */
  private readonly plugin: SymbatPlugin;

  /** The session's interpreter context — persistent, so each line sees what earlier ones defined.
   *  `null` before it is built and after a restart frees it. */
  private context: Numbat | null = null;

  /** Categorized completion vocabulary for the current session context, built on demand and
   *  invalidated whenever the context changes or a line is evaluated (which may define a new
   *  name). */
  private completionVocab: CompletionVocabulary | null = null;

  /** The scrolling output log. Definitely assigned in `onOpen`. */
  private logEl!: HTMLElement;

  /** The CodeMirror 6 input editor (syntax highlighting, `\code` expansion and completer, history
   *  recall, and — when Obsidian's Vim mode is on — vim key bindings); undefined until the view is
   *  built. */
  private input?: NumbatInput;

  /** The mobile-only "evaluate" button, shown only while the soft keyboard is up (see
   *  syncSubmitButton); null on desktop and until the view is built. */
  private submitButtonEl: HTMLButtonElement | null = null;

  /** The mobile-only Vim "Esc" button, shown when Vim is on and the soft keyboard is up (which has
   *  no Esc key); null on desktop and until the view is built. */
  private escButtonEl: HTMLButtonElement | null = null;

  /** Whether Vim key bindings are currently active in the input (the resolved `replVimMode`); gates
   *  the mobile Esc button. */
  private replVimOn = false;

  /** Submitted inputs, oldest-first, capped to the configured history limit. */
  private readonly history: string[] = [];

  /** Running count of visible lines in the log (for buffer trimming). */
  private visibleLines = 0;

  /** Whatever overlaps the view's bottom edge — the mobile keyboard, or the desktop status bar
   *  under the sidebar's bottom split. Built in `onOpen`, since it measures `contentEl`. */
  private keyboard?: SoftKeyboardTracker;

  // Prefix history-recall state (arrow keys). `recallIndex === -1` means no recall is in progress
  // and the input holds the user's own text.
  private recallMatches: string[] = [];

  /** Position in {@link recallMatches}, or `-1` when no recall is in progress. */
  private recallIndex = -1;

  /** The text the user had typed when recall began, restored on stepping back past the newest
   *  match. */
  private recallQuery = "";

  /** @param leaf the workspace leaf to mount in. @param plugin the plugin to read. */
  constructor(leaf: WorkspaceLeaf, plugin: SymbatPlugin) {
    super(leaf);
    this.plugin = plugin;

    // A tool panel, not a file-backed document: mark it non-navigable (like the file explorer or
    // calendar views) so Obsidian — notably its mobile shell — does not try to resolve an active
    // file for it. Otherwise dismissing the on-screen keyboard surfaces a "could not resolve active
    // file" error.
    this.navigation = false;
  }

  /** Obsidian's identifier for this view type. */
  getViewType(): string {
    return VIEW_TYPE_NUMBAT_REPL;
  }

  /** The tab title. */
  getDisplayText(): string {
    return "Symbat REPL";
  }

  /** The tab icon. */
  getIcon(): string {
    return "calculator";
  }

  /** Build the REPL UI and lazily start the interpreter. */
  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("numbat-repl");
    this.applyFont();

    this.addAction("rotate-ccw", "Reset REPL", () => this.resetRepl());

    this.logEl = root.createDiv({ cls: "numbat-repl-log" });

    const inputRow = root.createDiv({ cls: "numbat-repl-input-row" });
    this.replVimOn = this.plugin.resolveReplVim();

    // On mobile, a leftmost Esc button: the soft keyboard has no Esc key, so this lets Vim users
    // leave insert mode. Shown only when Vim is on and the soft keyboard is up (see syncEscButton).
    // Built before the prompt so it sits left.
    if (Platform.isMobile) {
      const escButton = inputRow.createEl("button", {
        cls: "numbat-repl-esc-button",
        text: "⎋",
        attr: { type: "button", "aria-label": "Exit Vim insert mode" },
      });

      // Keep focus (and the keyboard) on the input when tapped.
      this.registerDomEvent(escButton, "mousedown", (evt) => evt.preventDefault());
      this.registerDomEvent(escButton, "click", () => {
        this.input?.exitInsertMode();
        this.input?.focus();
      });
      this.escButtonEl = escButton;
      this.syncEscButton();
    }

    inputRow.createSpan({ cls: "numbat-repl-prompt", text: ">>>" });

    // The CodeMirror 6 input editor mounts into the row after the prompt. It reports submit and
    // history recall back to this view, reads the current history for its completer, and honors the
    // live-highlighting and Vim settings.
    this.input = new NumbatInput(
      inputRow,
      this.plugin,
      {
        submit: (value) => this.evaluate(value),
        recallOlder: () => this.recall(1),
        recallNewer: () => this.recall(-1),
        changed: () => {
          this.recallIndex = -1;
        },
        softKeyboardUp: () => this.softKeyboardUp(),
        history: () => this.history,
        clearScreen: () => this.clearScreen(),
        exprCompletions: (query, enabled, allowed) => this.exprCompletions(query, enabled, allowed),
        // Signature (inline) and full documentation (dwell popup) for a completion, resolved
        // against the live session context so REPL-defined names work too.
        memberFields: (base) => (this.context ? structFields(this.context, base) : []),
        completionSignature: (name) => (this.context ? completionSignature(this.context, name) : null),
        completionInfo: (name) => (this.context ? completionInfo(this.context, name) : null),
        // The hover card for a symbol already typed into the input — the same card, against the
        // same session context.
        hoverCard: (symbol) => (this.context ? symbolCard(this.context, symbol) : null),
        holeType: (input) => this.holeTypeFor(input),
        // Vim's command line replaces the input line rather than stacking beneath it; styles.css
        // does that from this class. It goes on the row, not the editor, because the prompt it
        // restyles is the editor's sibling.
        vimPanelChanged: (open) => {
          inputRow.toggleClass("numbat-repl-vim-panel", open);
        },
      },
      {
        highlight: this.plugin.settings.liveReplHighlight,
        vimMode: this.replVimOn,
        inlayHoles: this.inlayHolesOn(),
        hover: this.plugin.settings.hover,
        placeholder: "Enter a Numbat expression…",
      },
    );

    // While the soft keyboard is up Enter inserts a newline, so an explicit submit button is needed
    // there. It is shown only while the soft keyboard is up (see syncSubmitButton): with a hardware
    // keyboard attached the soft keyboard never appears and a hardware Enter submits, so the button
    // would be redundant.
    if (Platform.isMobile) {
      const submitButton = inputRow.createEl("button", {
        cls: "numbat-repl-submit-button",
        attr: { type: "button", "aria-label": "Evaluate" },
      });
      setIcon(submitButton, "corner-down-left");

      // Pressing the button must not pull focus off the input, or the soft keyboard dismisses;
      // preventDefault on pointer-down keeps the caret there.
      this.registerDomEvent(submitButton, "mousedown", (evt) => evt.preventDefault());
      this.registerDomEvent(submitButton, "click", () => {
        this.evaluate(this.input?.getValue() ?? "");
        this.input?.focus();
      });
      this.submitButtonEl = submitButton;

      // Start hidden — no soft keyboard is up yet; the keyboard events reveal it.
      this.syncSubmitButton();
    }

    // Keep the input row clear of whatever overlaps the view's bottom edge — the on-screen keyboard
    // on mobile, or Obsidian's status bar when the view is docked in the sidebar's bottom split on
    // desktop — by padding the view's bottom (see styles.css), and reveal the mobile buttons that
    // only make sense while the soft keyboard is up.
    this.keyboard = new SoftKeyboardTracker(this, {
      target: this.contentEl,
      statusBar: true,
      changed: () => this.applyBottomInset(),
    });

    // The tracker sees the keyboard and the viewport itself; these are the moves only the workspace
    // reports.
    this.registerEvent(this.app.workspace.on("resize", () => this.keyboard?.remeasure()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.keyboard?.remeasure()));

    // Apply the initial inset (e.g. when opened already docked under the status bar).
    this.applyBottomInset();

    const loading = this.logEl.createDiv({ cls: "numbat-repl-loading", text: "Loading Numbat…" });
    try {
      await ensureNumbatReady();
      await this.plugin.ensureExchangeRates();
      await this.plugin.ensurePrelude();
      this.context = createContext(this.plugin.settings.fetchExchangeRates);
    } catch (error) {
      restartNumbat();
      loading.remove();
      this.appendOutput(escapeHtml(`Numbat failed to start: ${describeError(error)}`), true);
      this.input?.focus();
      return;
    }

    loading.remove();
    this.appendInfo("Symbat REPL — type an expression, or `list`, `help`, `clear`, `reset`.");
    this.reportPreludeError();
    this.input?.focus();
  }

  /**
   * Apply the REPL font-size settings to this view's root as CSS variables (for the log "view" and
   * the input line). When custom fonts are off — or a value is not a valid CSS size — the variable
   * is cleared so the stylesheet falls back to the theme's code size.
   */
  applyFont(): void {
    const { style } = this.contentEl;
    const custom = this.plugin.settings.customReplFont;
    const set = (property: string, value: string): void => {
      if (custom && isValidCssFontSize(value)) {
        style.setProperty(property, value);
      } else {
        style.removeProperty(property);
      }
    };

    set("--numbat-repl-view-font-size", this.plugin.settings.replViewFontSize);
    set("--numbat-repl-input-font-size", this.plugin.settings.replInputFontSize);
  }

  /**
   * Reflect the "Live REPL highlighting" setting on this view by toggling the input editor's
   * syntax-highlighting extension. Called on open and whenever the setting changes (see
   * SymbatPlugin.refreshReplHighlight).
   */
  applyHighlight(): void {
    this.input?.setHighlight(this.plugin.settings.liveReplHighlight);
  }

  /**
   * Reflect the resolved Vim-mode setting on this view: toggle the input editor's Vim bindings and
   * re-evaluate the mobile Esc button's visibility. Called on open and whenever the setting changes
   * (see SymbatPlugin.refreshReplVim).
   */
  applyVim(): void {
    this.replVimOn = this.plugin.resolveReplVim();
    this.input?.setVim(this.replVimOn);
    this.syncEscButton();
  }

  /** Whether the REPL input should show the incomplete-expression inlay hint: the master inlay
   *  toggle plus the type-hint sub-toggle (a hole is a type hint). */
  private inlayHolesOn(): boolean {
    return this.plugin.settings.inlayHints && this.plugin.settings.inlayTypes;
  }

  /**
   * Reflect the inlay settings on this view by toggling the input editor's incomplete-expression
   * hint. Called on open and whenever an inlay setting changes (see
   * SymbatPlugin.refreshInlayHints).
   */
  applyInlayHints(): void {
    this.input?.setInlayHoles(this.inlayHolesOn());
  }

  /**
   * Reflect the hover settings on this view by rebuilding the input editor's hover extension (which
   * is where the triggers and the delay are baked in). Called on open and whenever a hover setting
   * changes (see SymbatPlugin.refreshHover).
   */
  applyHover(): void {
    this.input?.setHover(this.plugin.settings.hover);
  }

  /**
   * The type of the operand an incomplete input is still missing, for the REPL inlay hint —
   * recovered by evaluating the input's typed-hole form against the live session context (a hole
   * always type-errors before execution, so it never mutates the session). `null` when the input is
   * complete or its type cannot be recovered, or before the context exists.
   */
  private holeTypeFor(input: string): string | null {
    if (!this.context) {
      return null;
    }

    const hole = holeForm(input);
    if (hole === null) {
      return null;
    }

    return parseHoleType(interpret(this.context, hole).output);
  }

  /** Re-measure the bottom inset on view resize (covers window resize and drags). */
  onResize(): void {
    super.onResize();
    this.keyboard?.remeasure();
  }

  /**
   * Pad the view's bottom by whatever overlaps its bottom edge, so the input row rises to sit just
   * above it (see styles.css), and re-evaluate the two mobile buttons that exist only while the
   * soft keyboard is up.
   *
   * The measurement is the tracker's; this is what the REPL does with it. Called on open and
   * whenever the tracker reports a move, so the CSS variable is written only when it changed.
   */
  private applyBottomInset(): void {
    this.contentEl.style.setProperty("--numbat-repl-bottom-inset", `${this.keyboard?.inset() ?? 0}px`);

    // Keep the newest output in view as the visible area resizes around the obstruction.
    this.scrollToBottom();

    this.syncSubmitButton();
    this.syncEscButton();
  }

  /**
   * Surface the most recent context's prelude error, if any. Called right after each
   * `createContext` (a fresh context resets the recorded error), so it reports only this REPL's
   * prelude — a broken personal prelude is otherwise an invisible failure.
   */
  private reportPreludeError(): void {
    const error = getLastPreludeError();
    if (error !== null) {
      this.appendInfo("User prelude failed to load:");
      this.appendOutput(error, true);
    }
  }

  /** Rebuild the interpreter context after a crash (reinitializing the wasm). */
  private async rebuildContext(): Promise<void> {
    freeQuietly(this.context);
    this.context = null;
    this.completionVocab = null;

    try {
      await ensureNumbatReady();
      await this.plugin.ensureExchangeRates();
      await this.plugin.ensurePrelude();
      this.context = createContext(this.plugin.settings.fetchExchangeRates);
      this.reportPreludeError();
    } catch (error) {
      this.appendOutput(escapeHtml(`Numbat failed to restart: ${describeError(error)}`), true);
    }
  }

  /** Reset the REPL: discard interpreter state and clear the visible log. */
  private resetRepl(): void {
    try {
      freeQuietly(this.context);
      this.completionVocab = null;
      this.context = createContext(this.plugin.settings.fetchExchangeRates);
      this.clearLog();
      this.appendInfo("REPL reset — fresh interpreter.");
      this.reportPreludeError();
    } catch (error) {
      restartNumbat();
      this.clearLog();
      this.appendOutput(escapeHtml(`Numbat failed to reset: ${describeError(error)}`), true);
      void this.rebuildContext();
    }

    this.input?.focus();
  }

  /** Free the interpreter context and tear down the input editor when the view closes. */
  async onClose(): Promise<void> {
    this.input?.destroy();
    this.input = undefined;
    this.submitButtonEl = null;
    this.escButtonEl = null;

    // The tracker's listeners are unregistered with this component; dropping the reference keeps a
    // late workspace event from measuring a detached element.
    this.keyboard = undefined;
    freeQuietly(this.context);
    this.context = null;
  }

  /**
   * Whether the on-screen soft keyboard is currently up (see views/soft-keyboard.ts). Lets the
   * input distinguish a soft-keyboard Return (newline) from a hardware Enter (submit), and gates
   * the two mobile buttons.
   */
  private softKeyboardUp(): boolean {
    return this.keyboard?.isUp() ?? false;
  }

  /**
   * Show the mobile submit button only while the soft keyboard is up. That is exactly when it is
   * needed: a soft-keyboard Return inserts a newline rather than submitting. With a hardware
   * keyboard attached the soft keyboard never appears (so this stays hidden) and a hardware Enter
   * submits directly, making the button redundant — the same `softKeyboardUp` signal that routes
   * Enter.
   */
  private syncSubmitButton(): void {
    this.submitButtonEl?.toggle(this.softKeyboardUp());
  }

  /**
   * Show the mobile Vim Esc button only while Vim is on and the soft keyboard is up: that is when a
   * hardware Esc is unavailable, so leaving insert mode needs a button. Hidden when Vim is off, or
   * when a hardware keyboard (with its own Esc) is in use — the same `softKeyboardUp` signal used
   * elsewhere.
   */
  private syncEscButton(): void {
    this.escButtonEl?.toggle(this.replVimOn && this.softKeyboardUp());
  }

  /**
   * Step through history entries fuzzy-matching the current input prefix, filling the input with
   * each match. Submit, newline, and the caret-position gating of this recall now live in the CM6
   * input (see views/input.ts); this view only holds the recall state and is called back on Arrow
   * Up/Down.
   *
   * @param step `+1` for an older entry (Arrow Up), `-1` for a newer one.
   */
  private recall(step: number): void {
    if (this.recallIndex === -1) {
      this.recallQuery = this.input?.getValue() ?? "";
      this.recallMatches = fuzzyFilter([...this.history].reverse(), this.recallQuery);
    }

    if (this.recallMatches.length === 0) {
      return;
    }

    const next = this.recallIndex + step;
    if (next < 0) {
      // Newer than the newest match: restore the user's own text.
      this.recallIndex = -1;
      this.input?.setValue(this.recallQuery);
      return;
    }

    this.recallIndex = Math.min(next, this.recallMatches.length - 1);
    this.input?.setValue(this.recallMatches[this.recallIndex]);
  }

  /**
   * Categorized expression completions for `query` against the live session context, so
   * REPL-defined names complete alongside the prelude, restricted to `categories` (already narrowed
   * for the cursor's position by the input). The vocabulary (which names are
   * types/units/identifiers) is built lazily from the context and cached until the next evaluation
   * or reset. Empty when the context is not ready or the feature is off.
   */
  private exprCompletions(
    query: string,
    enabled: ExprCategories,
    allowed: ReadonlySet<ExprCategory> | null,
  ): ExprCompletion[] {
    if (!this.context || !this.plugin.settings.exprCompletion) {
      return [];
    }

    if (this.completionVocab === null) {
      this.completionVocab = buildCompletionVocabulary(this.context);
    }

    if (this.completionVocab === null) {
      return [];
    }

    const raw = expressionCompletionCandidates(this.context, query);
    return expressionCompletions(raw, this.completionVocab, enabled, allowed);
  }

  // EVALUATION
  // ==============================================================================================

  /** Evaluate a submitted line: run it as a command or interpret it. */
  private evaluate(raw: string): void {
    const input = raw.trim();
    if (input === "") {
      return;
    }
    this.pushHistory(raw);
    this.recallIndex = -1;
    this.appendInput(raw);
    this.input?.setValue("");

    // `isNumbatReady()` as well as the handle: a pending restart (a wasm panic elsewhere, or
    // refreshed exchange rates, which can only be applied to a fresh instance) leaves
    // `this.context` pointing into an instance that is about to be replaced. Calling into it after
    // the reset addresses a dead heap.
    if (!this.context || !isNumbatReady()) {
      this.appendInfo("Numbat is restarting; please try again.");
      void this.rebuildContext();
      return;
    }

    try {
      // Commands (`list`, `clear`, `reset`, …) are tried first.
      const command = this.context.try_run_command(input);
      const isCommand = command.is_command;
      const shouldClear = command.should_clear;
      const shouldReset = command.should_reset;

      // `try_run_command` bypasses `interpret`, so it needs the same rewrite: `info costs` on a
      // nested property would otherwise show the raw generated type name.
      const commandOutput = readableOutput(command.output);
      command.free();

      if (isCommand) {
        if (shouldReset) {
          freeQuietly(this.context);
          this.context = createContext(this.plugin.settings.fetchExchangeRates);
        }

        if (shouldClear) {
          this.clearLog();
        } else if (commandOutput.trim() !== "") {
          this.appendOutput(jqueryTerminalToHtml(commandOutput), false);
        }

        if (shouldReset) {
          this.reportPreludeError();
        }
      } else {
        // Deliberately not `interpret()`: that turns a wasm panic into an error *result*, and the
        // catch below is what rebuilds this view's context — swallowing the throw would leave the
        // REPL typing into a dead one. So the rewrites it would have applied are applied here.
        const result = this.context.interpret(input);
        const output = readableOutput(result.output);
        const isError = result.is_error;
        result.free();
        this.appendOutput(output, isError);
      }
    } catch (error) {
      // A wasm panic: surface it, restart the engine, and rebuild the context.
      restartNumbat();
      this.appendOutput(escapeHtml(`Numbat crashed and restarted: ${describeError(error)}`), true);
      void this.rebuildContext();
    }

    // A definition (`let`, `unit`, `fn`, `dimension`) may have changed what completes; drop the
    // cached vocabulary so the next completion rebuilds it.
    this.completionVocab = null;
    this.scrollToBottom();
  }

  /** Append a submitted input to the capped history list. */
  private pushHistory(entry: string): void {
    this.history.push(entry);
    while (this.history.length > this.plugin.settings.replHistoryLimit) {
      this.history.shift();
    }
  }

  // LOG RENDERING (BOUNDED BUFFER)
  // ==============================================================================================

  /** Echo a submitted line into the log, behind a `>>>` prompt. */
  private appendInput(text: string): void {
    const line = this.logEl.createDiv({ cls: "numbat-repl-entry numbat-repl-command" });
    line.createSpan({ cls: "numbat-repl-prompt", text: ">>>" });
    line.createSpan({ cls: "numbat-repl-echo", text: ` ${text}` });
    this.registerEntry(line, countLines(text));
  }

  /** Append the interpreter's rendered output, styled as an error when it is one. */
  private appendOutput(html: string, isError: boolean): void {
    const entry = this.logEl.createEl("pre", { cls: "numbat-repl-entry numbat-output" });
    if (isError) {
      entry.addClass("numbat-error");
    }

    setNumbatHtml(entry, html);
    this.registerEntry(entry, countLines(entry.textContent ?? ""));
  }

  /** Append a plugin message — a command's response, or a status note — which is plain text and
   *  styled apart from interpreter output. */
  private appendInfo(text: string): void {
    const entry = this.logEl.createDiv({ cls: "numbat-repl-entry numbat-repl-info", text });
    this.registerEntry(entry, countLines(text));
  }

  /** Record an entry's line count and trim the log to the configured maximum. */
  private registerEntry(el: HTMLElement, lines: number): void {
    el.dataset.numbatLines = String(lines);
    this.visibleLines += lines;
    this.trimLog();
  }

  /**
   * Drop the oldest visible entries until the log is within `replMaxLines`. Only the visible DOM is
   * trimmed — the interpreter session is untouched, so variables defined by scrolled-off lines
   * remain available.
   */
  private trimLog(): void {
    const max = this.plugin.settings.replMaxLines;
    while (this.visibleLines > max && this.logEl.childElementCount > 1) {
      const first = this.logEl.firstElementChild as HTMLElement | null;
      if (!first) {
        break;
      }

      this.visibleLines -= Number(first.dataset.numbatLines ?? "1");
      first.remove();
    }
  }

  /** Discard the whole log (the `clear` command), unlike {@link clearScreen}. */
  private clearLog(): void {
    this.logEl.empty();
    this.visibleLines = 0;
  }

  /**
   * Ctrl+L: scroll the current log up off-screen, shell-style. Unlike the `clear` command, nothing
   * is discarded — a blank spacer the height of the visible log is appended so the existing entries
   * scroll above the viewport (still reachable by scrolling up), and subsequent output appends
   * below it. Idempotent: a second press with no output since just re-scrolls rather than stacking
   * spacers.
   */
  private clearScreen(): void {
    const last = this.logEl.lastElementChild;
    if (!(last instanceof HTMLElement && last.hasClass("numbat-repl-clear-spacer"))) {
      const spacer = this.logEl.createDiv({ cls: "numbat-repl-clear-spacer" });
      spacer.setCssStyles({ height: `${this.logEl.clientHeight}px` });
    }

    this.scrollToBottom();
    this.input?.focus();
  }

  /** Pin the log to its newest entry. */
  private scrollToBottom(): void {
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}
