// A stateful Numbat REPL hosted in a sidebar panel.

import { ItemView, Platform, setIcon, type WorkspaceLeaf } from "obsidian";
import {
  type CompletionVocabulary,
  type ExprCategories,
  type ExprCategory,
  type ExprCompletion,
  expressionCompletions,
} from "../completion/expressions";
import { factsSource } from "../hover/card";
import { symbolCard } from "../hover/content";
import type { HoverSymbol } from "../hover/parse";
import { WANT_CARD } from "../interpreter/facts";
import { sessionFactsHost, type SessionScope } from "../interpreter/live-facts";
import { escapeHtml, jqueryTerminalToHtml } from "../interpreter/markup";
import {
  ask,
  describeError,
  ensureNumbatReady,
  interpreterCanBeStopped,
  interpreterGeneration,
  interpreterProblem,
  isNumbatReady,
  preludeReadsClockOrRandom,
  restartNumbat,
  stopEvaluations,
  watchInterpreter,
} from "../interpreter/numbat";
import { readsClockOrRandom } from "../interpreter/purity";
import { setNumbatHtml } from "../interpreter/render";
import type SymbatPlugin from "../main";
import { isValidCssFontSize } from "../settings/util";
import { REPL_STARTING_CUE_MIN_MS } from "../tuning";
import { fuzzyFilter } from "./fuzzy";
import { type HoverCard, NumbatInput } from "./input";
import { SoftKeyboardTracker } from "./soft-keyboard";

/**
 * Persisted in the vault's `workspace.json` — see the note on `VIEW_TYPE_NUMBAT_FILE` in
 * views/nbt.ts. Renaming it orphans open REPL panes.
 */
export const VIEW_TYPE_NUMBAT_REPL = "numbat-repl";

/**
 * The ghost text the empty input shows while it is the reader's turn — and only then, which is
 * why it is named rather than written at the one place that installs it. See `applyInputState`.
 */
const REPL_PLACEHOLDER = "Enter a Numbat expression…";

/**
 * What the input row is showing.
 *
 * `open` is the reader's turn. The other two are not: `starting` is an interpreter that is not
 * there yet, `busy` is one that is answering. They overlap — an interpreter can die *during* an
 * evaluation — and two flags would leave the row showing whichever was written last rather than
 * whichever is true.
 */
type InputState = "open" | "starting" | "busy";

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

  /**
   * The session the interpreter is keeping for this view — persistent, so each line sees what
   * earlier ones defined. `null` before it is opened and after a restart discards it.
   *
   * **An integer, never a handle**, and that is the design rule the whole conversion rests on. The
   * interpreter validates it against its own table, so an id that outlived a restart is a miss the
   * view recovers from; a pointer into a heap that has been replaced is a crash it cannot.
   */
  private sessionId: number | null = null;

  /**
   * Categorized completion vocabulary for the current session context, built on demand and
   * invalidated whenever the context changes or a line is evaluated (which may define a new
   * name).
   */
  private completionVocab: CompletionVocabulary | null = null;

  /**
   * How many times this session's context has changed. Part of the key every fact about a name in
   * it is filed under, and the whole reason that key can be trusted: a REPL context accumulates
   * definitions, so anything evaluated here may have changed what every name already asked about
   * means.
   */
  private factsEpoch = 0;

  /**
   * Whether anything this session has evaluated reads the clock or the RNG. Latched rather than
   * re-derived, because it stays true: `fn t() = now()` leaves nothing impure-looking in a later
   * line, and a fact about `t` that never expired would freeze at whatever it first said.
   */
  private sessionImpure = false;

  /**
   * What the interpreter has said about the names in this session — the completer's signatures,
   * the dwell popup's documentation and the hover card, all read from one place.
   */
  private readonly facts = sessionFactsHost(() => this.session());

  /** The scrolling output log. Definitely assigned in `onOpen`. */
  private logEl!: HTMLElement;

  /**
   * The CodeMirror 6 input editor (syntax highlighting, `\code` expansion and completer, history
   * recall, and — when Obsidian's Vim mode is on — vim key bindings); undefined until the view is
   * built.
   */
  private input?: NumbatInput;

  /**
   * The mobile-only "evaluate" button, shown only while the soft keyboard is up (see
   * syncSubmitButton); null on desktop and until the view is built.
   */
  private submitButtonEl: HTMLButtonElement | null = null;

  /**
   * The mobile-only Vim "Esc" button, shown when Vim is on and the soft keyboard is up (which has
   * no Esc key); null on desktop and until the view is built.
   */
  private escButtonEl: HTMLButtonElement | null = null;

  /** The input row, so it can be dimmed while the interpreter is not there to answer. */
  private inputRowEl: HTMLElement | null = null;

  /** The sentence shown in place of the input while it is closed. */
  private statusTextEl: HTMLElement | null = null;

  /**
   * The stop control. Present in the input row whenever this interpreter can be stopped at all,
   * and enabled only while there is something running to stop.
   */
  private stopButtonEl: HTMLButtonElement | null = null;

  /**
   * What the input row is currently showing. Held so a burst of announcements costs one CodeMirror
   * transaction rather than one each.
   */
  private inputState: InputState = "open";

  /** When the starting cue went up, so it can be held for {@link REPL_STARTING_CUE_MIN_MS}. */
  private startingSince = 0;

  /** The pending "the cue has been up long enough" timer. */
  private cueTimer: number | null = null;

  /**
   * Whether a line is in flight. Not derived from anything: the interpreter has no notion of which
   * view asked, and two REPLs are two independent answers to this.
   */
  private evaluating = false;

  /**
   * Whether a session rebuild is already in flight, so a burst of announcements opens one session
   * rather than several.
   */
  private rebuilding = false;

  /**
   * Whether the interpreter was announced while a rebuild was in flight, and the view therefore
   * still owes itself a look. See {@link finishRebuild}.
   */
  private resyncWanted = false;

  /**
   * Whether Vim key bindings are currently active in the input (the resolved `replVimMode`); gates
   * the mobile Esc button.
   */
  private replVimOn = false;

  /** Submitted inputs, oldest-first, capped to the configured history limit. */
  private readonly history: string[] = [];

  /** Running count of visible lines in the log (for buffer trimming). */
  private visibleLines = 0;

  /**
   * Whatever overlaps the view's bottom edge — the mobile keyboard, or the desktop status bar
   * under the sidebar's bottom split. Built in `onOpen`, since it measures `contentEl`.
   */
  private keyboard?: SoftKeyboardTracker;

  // Prefix history-recall state (arrow keys). `recallIndex === -1` means no recall is in progress
  // and the input holds the user's own text.
  private recallMatches: string[] = [];

  /** Position in {@link recallMatches}, or `-1` when no recall is in progress. */
  private recallIndex = -1;

  /**
   * The text the user had typed when recall began, restored on stepping back past the newest
   * match.
   */
  private recallQuery = "";

  /**
   * Whether the input held keyboard focus when it was last hidden, and so should get it back when
   * it returns. See {@link applyInputState}.
   */
  private refocusWhenOpen = false;

  /**
   * How many times the reader has stopped an evaluation in this view. Read by {@link evaluate}
   * across its `await`, so a submission can tell "the answer never came" from "the answer was
   * thrown away, by the person now reading the screen".
   */
  private stopEpoch = 0;

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

    this.addAction("rotate-ccw", "Reset REPL", () => void this.resetRepl());

    // Whether this view gets a stop control at all is *watched* rather than decided once, because
    // the answer legitimately moves under an open view: a REPL restored with the workspace opens
    // before `onLayoutReady` permits spawning, so it sees the in-process path and is overtaken by
    // the worker a moment later. Deciding once meant the button was missing for the whole session
    // in exactly the common case.
    this.register(watchInterpreter(() => void this.syncInterpreter()));

    this.logEl = root.createDiv({ cls: "numbat-repl-log" });

    const inputRow = root.createDiv({ cls: "numbat-repl-input-row" });
    this.inputRowEl = inputRow;
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

    // What stands in for the input whenever it is not the reader's turn — the interpreter starting,
    // and an evaluation in flight. Built once and shown by a class on the row rather than created
    // and destroyed, so nothing has to be rebuilt on a path that runs on every respawn.
    // `role=status` so a screen reader is told too: the visible cue is a spinner, which announces
    // nothing at all on its own.
    const status = inputRow.createDiv({ cls: "numbat-repl-status", attr: { role: "status" } });
    status.createSpan({ cls: "numbat-repl-spinner" });
    this.statusTextEl = status.createSpan({ cls: "numbat-repl-status-text" });

    // The CodeMirror 6 input editor mounts into the row after the prompt. It reports submit and
    // history recall back to this view, reads the current history for its completer, and honors the
    // live-highlighting and Vim settings.
    this.input = new NumbatInput(
      inputRow,
      this.plugin,
      {
        submit: (value) => void this.evaluate(value),
        recallOlder: () => this.recall(1),
        recallNewer: () => this.recall(-1),
        changed: () => {
          this.recallIndex = -1;
        },
        softKeyboardUp: () => this.softKeyboardUp(),
        history: () => this.history,
        clearScreen: () => this.clearScreen(),
        exprCompletions: (query, enabled, allowed) => this.exprCompletions(query, enabled, allowed),
        // Signatures (inline) and documentation (the dwell popup) for a completion, asked of the
        // live session context so REPL-defined names are answered for too.
        ...this.facts,
        // The hover card for a symbol already typed into the input — the same card as a note's,
        // about the same session the completer asks.
        hoverCard: (symbol) => this.hoverCard(symbol),
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
        placeholder: REPL_PLACEHOLDER,
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
        void this.evaluate(this.input?.getValue() ?? "");
        this.input?.focus();
      });
      this.submitButtonEl = submitButton;

      // Start hidden — no soft keyboard is up yet; the keyboard events reveal it.
      this.syncSubmitButton();
    }

    // **The stop control is a member of the input row, not an action in the view header.** It sits
    // next to the Esc and evaluate buttons because this is where a reader would look for it for it,
    // and it sits opposite the button that started the thing it stops.
    //
    // A text glyph rather than `setIcon`, for the same reason the header lost it: an icon id the
    // set does not know renders as an empty button and says nothing about why. `⎋` on the Esc
    // button next to it is the precedent.
    //
    // Always in the row and only ever dimmed — `syncStopButton` says why it never comes and goes.
    const stopButton = inputRow.createEl("button", {
      cls: "numbat-repl-stop-button",
      text: "■",
      // Disabled from birth, and the label is restated by `syncStopButton`: nothing has started the
      // interpreter at this point, so there is neither something to stop nor an answer yet to where
      // it would be stopped.
      attr: { type: "button", disabled: "", "aria-label": "Stop evaluating" },
    });

    // Keep focus (and the soft keyboard) on the input when tapped, as the Esc button does.
    this.registerDomEvent(stopButton, "mousedown", (evt) => evt.preventDefault());
    this.registerDomEvent(stopButton, "click", () => void this.stopEvaluating());
    this.stopButtonEl = stopButton;

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

    // Closed until there is something behind it. The interpreter is started lazily and may be
    // replaced once more before the workspace has finished loading, so "ready" is not a state this
    // view can assume on the way in. This is also the only cue that it is starting: the log used to
    // carry one too, and two of them for one event is one too many.
    this.applyInputState("starting");
    this.syncStopButton();

    let opened;
    this.rebuilding = true;
    try {
      opened = await this.openFresh();
    } catch (error) {
      restartNumbat();
      this.appendOutput(escapeHtml(`Numbat failed to start: ${describeError(error)}`), true);
      this.input?.focus();
      return;
    } finally {
      this.finishRebuild();
    }

    if (opened === null) {
      // The specific reason where there is one. "Failed to start" is true and useless when the
      // cause is a setting the reader can change, and the REPL is where somebody goes to find out
      // why nothing is happening.
      this.appendOutput(escapeHtml(interpreterProblem() ?? "Numbat failed to start."), true);
      this.input?.focus();
      return;
    }

    this.appendInfo("Symbat REPL — type an expression, or `list`, `help`, `clear`, `reset`.");
    this.reportPreludeError(opened.preludeError);
    this.input?.focus();
  }

  /**
   * Open a fresh session and adopt its id, closing whatever this view had.
   *
   * The close goes out first and is not waited on: it is a message the interpreter acts on in
   * order, and the view has nothing to do with the answer. `null` when the interpreter would not
   * open one, which every caller shows as a failure to start rather than retrying: a REPL with no
   * session cannot be typed into, and the next reset is the reader's own retry.
   */
  private async openSession(): Promise<{ preludeError: string | null; } | null> {
    this.closeSession();
    const session = await ask("replOpen", { applyRates: this.plugin.settings.fetchExchangeRates }, {
      priority: "interactive",
    });
    if (session === null) {
      return null;
    }

    this.sessionId = session.id;
    this.sessionImpure = false;
    this.sessionChanged();
    this.syncStopButton();
    this.refreshInputState();
    return { preludeError: session.preludeError };
  }

  /**
   * Tell the interpreter this view is done with its session. Fire-and-forget: the id is dropped
   * here and now, so nothing can ask about it again whatever the answer.
   */
  private closeSession(): void {
    const id = this.sessionId;
    this.sessionId = null;
    this.sessionChanged();
    if (id !== null) {
      void ask("replClose", { id }, { priority: "background" });
    }
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

  /**
   * Whether the REPL input should show the incomplete-expression inlay hint: the master inlay
   * toggle plus the type-hint sub-toggle (a hole is a type hint).
   */
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
   * Surface a context build's prelude error, if any.
   *
   * The error is *passed in* rather than read back, and that is the whole shape of the change: it
   * used to be module state read immediately after `createContext`, an ordering a message does not
   * preserve. Every reply that builds a context carries its own, so what is reported here can only
   * ever be this REPL's — a broken personal prelude is otherwise an invisible failure.
   */
  private reportPreludeError(error: string | null): void {
    if (error !== null) {
      this.appendInfo("User prelude failed to load:");
      this.appendOutput(error, true);
    }
  }

  /** Rebuild the session after a crash (reinitializing the interpreter first). */
  private async rebuildContext(): Promise<void> {
    // One at a time, because two rebuilds each begin by closing whatever the view holds, and with
    // both starting from nothing, neither closes the other's. The loser's session is then a context
    // left alive in the interpreter with nobody holding its id. The one in flight takes this over
    // when it lands.
    if (this.rebuilding) {
      this.resyncWanted = true;
      return;
    }

    // What replaces it is a *fresh* session, so whatever this one had defined — including anything
    // that read the clock — is gone with the one that crashed.
    this.closeSession();
    this.sessionImpure = false;

    this.rebuilding = true;
    try {
      const opened = await this.openFresh();
      if (opened === null) {
        this.appendOutput(escapeHtml("Numbat failed to restart."), true);
        return;
      }

      this.reportPreludeError(opened.preludeError);
    } catch (error) {
      this.appendOutput(escapeHtml(`Numbat failed to restart: ${describeError(error)}`), true);
    } finally {
      this.finishRebuild();
    }
  }

  /**
   * Start the interpreter, publish what a context is built in, and open a session in it.
   *
   * **The one path that opens a session**, because two of them racing leaks one: each begins by
   * closing whatever the view held, and with both starting from nothing neither closes the other's,
   * so the loser is a context left alive in the interpreter for as long as the view is open.
   *
   * The order is crucial as the rates and the prelude are baked into a context when it is built, so
   * a session opened ahead of them is a session the reader's own definitions are missing from but
   * about which nothing is immediately obviously wrong.
   */
  private async openFresh(): Promise<{ preludeError: string | null; } | null> {
    await ensureNumbatReady();
    await this.plugin.ensureExchangeRates();
    await this.plugin.ensurePrelude();
    return this.openSession();
  }

  /**
   * Leave the rebuild, and take up any announcement that arrived while it was in flight. Skipping
   * those outright would lose the one that matters: the interpreter being replaced *during* the
   * rebuild is exactly when the session just opened is already stale.
   */
  private finishRebuild(): void {
    this.rebuilding = false;
    if (this.resyncWanted) {
      this.resyncWanted = false;
      void this.syncInterpreter();
    }
  }

  /**
   * Bring the view into line with whatever interpreter is live now.
   *
   * Called on every replacement: a start, a restart after a panic, a move between threads, the
   * reader stopping everything. Three things follow from one, which is why they are done together
   * rather than each hung off its own signal:
   *
   *   * the stop button exists only on the worker path, and the path is not settled when the view
   *     opens;
   *   * the session id names a table inside the instance that has just been replaced, so it is a
   *     miss and must be dropped rather than discovered;
   *   * with no session there is nothing to submit to, so the input closes until there is.
   *
   * a fresh instance compiles 1.9 MB of wasm and loads a standard library, so this is the
   * difference between an input that waits and an input that accepts a line and answers "Numbat is
   * restarting; please try again".
   */
  private async syncInterpreter(): Promise<void> {
    this.syncStopButton();

    if (!isNumbatReady()) {
      // Dropped rather than closed: `closeSession` would post a `replClose` naming a table that no
      // longer exists, to an instance that is no longer there to hear it.
      this.sessionId = null;
      this.sessionChanged();
      this.refreshInputState();
      return;
    }

    if (this.sessionId !== null) {
      this.refreshInputState();
      return;
    }

    if (this.rebuilding) {
      this.resyncWanted = true;
      return;
    }

    // The instance is back and this view has no session in it. The full rebuild rather than a bare
    // `openSession`, because that is what republishes the environment first.
    await this.rebuildContext();
  }

  /**
   * Work out what the input row should be showing, and show it.
   *
   * Derived rather than set, and every path that could change the answer calls this instead of
   * writing a state directly. The two conditions genuinely overlap asthe interpreter can be
   * replaced *while* a line is in flight, and separate setters would leave the row showing
   * whichever ran last rather than whichever is true.
   */
  private refreshInputState(): void {
    if (!isNumbatReady() || this.sessionId === null) {
      this.showInputState("starting");
    } else if (this.evaluating) {
      this.showInputState("busy");
    } else {
      this.showInputState("open");
    }
  }

  /**
   * Put the input row into `state`, holding the starting cue open for its minimum.
   *
   * The content and the scroll position are **kept, only hidden**: this is a surface waiting for
   * something, not a surface being reset, and a reader who half-typed a line before a respawn
   * should still have it when the interpreter comes back. So the editor is hidden by a class rather
   * than emptied, and nothing here touches the document.
   */
  private showInputState(state: InputState): void {
    if (this.cueTimer !== null) {
      window.clearTimeout(this.cueTimer);
      this.cueTimer = null;
    }

    // The starting cue is held for a moment even once the interpreter is up. A cue that appears and
    // vanishes inside one frame reads as a flicker rather than as progress, and a reader who
    // pressed nothing is left wondering what happened. Only the *starting* cue: holding the
    // evaluating one would add two seconds to every line typed.
    if (state !== "starting" && this.inputState === "starting") {
      const held = REPL_STARTING_CUE_MIN_MS - (Date.now() - this.startingSince);
      if (held > 0) {
        this.cueTimer = window.setTimeout(() => {
          this.cueTimer = null;
          this.applyInputState(state);
        }, held);
        return;
      }
    }

    this.applyInputState(state);
  }

  private applyInputState(state: InputState): void {
    if (state === this.inputState) {
      return;
    }

    if (state === "starting") {
      this.startingSince = Date.now();
    }

    // Hiding a focused element drops focus to `<body>`, so submitting a line would otherwise cost
    // the caret: press Enter, the editor goes away for as long as the answer takes, and it comes
    // back with the keyboard pointing at nothing.
    //
    // Recorded here, but *not* sufficient on its own as we have to restore it. This only says the
    // input was where the keyboard was when it went away; where the keyboard is when it comes back
    // is a different question, and the reader gets to answer it.
    if (this.inputState === "open" && state !== "open") {
      this.refocusWhenOpen = this.input?.hasFocus() ?? false;
    }

    this.inputState = state;
    const open = state === "open";
    this.input?.setEditable(open);

    // The invitation goes with the turn. `numbat-repl-waiting` hides the whole editor, so this is
    // usually invisible, but the placeholder is the one part of a hidden editor that still reads
    // as an instruction if any rule anywhere gives `.cm-editor` a `display` back, and "enter a
    // Numbat expression" is false while the interpreter is busy or starting.
    this.input?.setPlaceholder(open ? REPL_PLACEHOLDER : null);
    this.inputRowEl?.toggleClass("numbat-repl-waiting", !open);
    if (this.submitButtonEl !== null) {
      this.submitButtonEl.disabled = !open;
    }
    if (this.statusTextEl !== null) {
      this.statusTextEl.setText(state === "busy" ? "Evaluating…" : "Interpreter is starting…");
    }

    this.syncStopButton();

    // The editor is hidden outright while it is closed, so CodeMirror has been laying out inside a
    // zero-height box and its cached measurements are stale. Asking for a measure on the way back
    // is what keeps the caret and the scroll position where the reader left them.
    if (open) {
      this.input?.remeasure();
      this.restoreFocus();
    }
  }

  /**
   * Give the input the keyboard back after it was hidden — but only if nobody else has taken it.
   *
   * Both halves matter. Restoring unconditionally means a reader who submits a slow line and clicks
   * into a note to read something while they wait has the caret yanked out from under them the
   * moment the answer lands, which is worse than the lost focus it fixes: the first costs a click,
   * the second can eat keystrokes into the wrong document.
   *
   * "Nobody else" is read off the document rather than tracked, because a blur can happen for
   * reasons this view never hears about. Hiding the editor drops focus to `<body>`, so *still on
   * body* means the reader has not gone anywhere; anything inside this view (the stop button they
   * just pressed, say) has not gone anywhere either. A note they clicked into is neither, and keeps
   * the caret. `ownerDocument` rather than the global, so this stays right in a popped-out window.
   */
  private restoreFocus(): void {
    if (!this.refocusWhenOpen) {
      return;
    }

    this.refocusWhenOpen = false;
    const active = this.contentEl.ownerDocument.activeElement;
    if (active === null || active === this.contentEl.ownerDocument.body || this.contentEl.contains(active)) {
      this.input?.focus();
    }
  }

  /**
   * Enable the stop button when there is something running that stopping would actually stop.
   *
   * **The button never comes and goes.** Two separate things decide whether pressing it would do
   * anything: whether this interpreter can be stopped at all (a property of the device and the
   * setting, not known when the view opens because the interpreter starts lazily, and liable to
   * change under an open view), and whether a line is in flight. Both of them move on their own,
   * and a control that appeared and vanished as they did would reflow the row underneath the
   * reader's thumb at the two moments they are least able to absorb it.
   *
   * It also has to be somewhere to look _before_ the moment it is wanted, and an affordance that
   * exists only while you are already waiting is one that a fast machine never shows at all.
   *
   * The label carries what the graying cannot: off the worker path the button is permanently dim,
   * because a REPL submission there runs inline and while it is running the main thread _is_ the
   * evaluation, so no click would ever be dispatched. That is a real property of the path the
   * reader chose, not a fault, and it is what the setting's own description promises.
   *
   * The REPL is the one surface the evaluation limit deliberately leaves unbudgeted (pressing Enter
   * at a prompt is the reader saying _run this_), so it is also the one place with no automatic
   * ceiling at all: without this, somebody who typed a runaway recursion has no way out but
   * restarting Obsidian.
   */
  private syncStopButton(): void {
    const button = this.stopButtonEl;
    if (button === null) {
      return;
    }

    const stoppable = interpreterCanBeStopped();
    button.disabled = !stoppable || this.inputState !== "busy";
    button.setAttribute(
      "aria-label",
      stoppable ? "Stop evaluating" : "Stop evaluating — not possible on the main thread",
    );
  }

  /**
   * Stop whatever the interpreter is doing, now.
   *
   * Always the hard rung, and not as a shortcut: a REPL submission is a *single* `interpret` call,
   * so there is no chunk boundary inside it for a cancellation to land on. Terminating is the only
   * thing that stops it, and it takes the session with it — which is a state the view already knows
   * how to be in, since a panic leaves it in the same one.
   */
  private async stopEvaluating(): Promise<void> {
    // Bumped *before* the terminate, not after it. The line in flight settles as `null` the moment
    // the worker dies, which can be ahead of this function's next line, and the whole point of the
    // epoch is that the submission recognizes its own answer as one the reader threw away.
    this.stopEpoch += 1;

    if (!await stopEvaluations(true)) {
      return;
    }

    // Cleared, not kept. The session those lines were evaluated in is gone, so a log that still
    // shows the definitions above the prompt is describing a scope the next line cannot use. The
    // recall history (up-arrow) is deliberately untouched, so getting back to where you were is a
    // keypress rather than retyping.
    this.clearLog();
    this.appendInfo("Evaluation stopped — the interpreter was reset.");
    await this.rebuildContext();
    this.input?.focus();
  }

  /** Reset the REPL: discard interpreter state and clear the visible log. */
  private async resetRepl(): Promise<void> {
    const opened = this.sessionId === null
      ? null
      : await ask("replReset", { id: this.sessionId, applyRates: this.plugin.settings.fetchExchangeRates }, {
        priority: "interactive",
      });

    if (opened === null) {
      // No session to reset, or the interpreter would not give one back. Build a new one from
      // scratch, which is also the recovery path a crash takes.
      this.clearLog();
      this.appendInfo("REPL reset — fresh interpreter.");
      await this.rebuildContext();
      this.input?.focus();
      return;
    }

    this.sessionImpure = false;
    this.sessionChanged();
    this.clearLog();
    this.appendInfo("REPL reset — fresh interpreter.");
    this.reportPreludeError(opened.preludeError);
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
    this.closeSession();
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
   * Categorized expression completions for `query` against this session, so REPL-defined names
   * complete alongside the prelude, restricted to `categories` (already narrowed for the cursor's
   * position by the input). Empty when there is no session or the feature is off.
   *
   * The vocabulary comes back with the candidates and is cached here until the next evaluation or
   * reset, because a session's is not something the interpreter can key: a REPL scope is built a
   * line at a time and there is no text to name it by. `factsEpoch` is what says it has moved.
   */
  private async exprCompletions(
    query: string,
    enabled: ExprCategories,
    allowed: ReadonlySet<ExprCategory> | null,
  ): Promise<ExprCompletion[]> {
    const id = this.sessionId;
    if (id === null || !this.plugin.settings.exprCompletion) {
      return [];
    }

    const epoch = this.factsEpoch;
    const reply = await ask("completions", { ref: { kind: "session", id }, query }, {
      priority: "interactive",
      group: "repl-completions",
    });

    // The session may have been reset, or a line evaluated into it, while the answer was coming.
    // Its vocabulary would then describe a scope that is gone, and caching it would leave the
    // completer offering names the reader can no longer use.
    if (reply === null || this.factsEpoch !== epoch) {
      return [];
    }

    this.completionVocab = reply.vocab ?? this.completionVocab;
    if (this.completionVocab === null) {
      return [];
    }

    return expressionCompletions([...reply.candidates], this.completionVocab, enabled, allowed);
  }

  // EVALUATION
  // ==============================================================================================

  /**
   * Evaluate a submitted line: run it as a command or interpret it.
   *
   * **A panic arrives as an outcome rather than as a throw**, which is the one thing about the REPL
   * the seam genuinely changed. This view used to bypass the shared `interpret` deliberately,
   * because the throw was what told it to rebuild — and across a boundary a panic is always a
   * message. Without a name for that case a crash would print an error line while the REPL went on
   * typing into a session that no longer exists.
   */
  private async evaluate(raw: string): Promise<void> {
    const input = raw.trim();
    if (input === "") {
      return;
    }
    this.pushHistory(raw);
    this.sessionImpure ||= readsClockOrRandom(input);
    this.recallIndex = -1;
    this.appendInput(raw);
    this.input?.setValue("");

    // `isNumbatReady()` as well as the session id: a pending restart (a panic elsewhere, or
    // refreshed exchange rates, which can only be applied to a fresh instance) means every session
    // is about to be discarded, this one included.
    const id = this.sessionId;
    if (id === null || !isNumbatReady()) {
      this.appendInfo("Numbat is restarting; please try again.");
      void this.rebuildContext();
      return;
    }

    // A definition (`let`, `unit`, `fn`, `dimension`) may change what completes, and what every
    // name already asked about means. Retired *before* the answer arrives, not after: the line has
    // been submitted, so anything filed against the old epoch is already describing a scope that is
    // on its way out, and a completion racing this must not be answered from it.
    this.sessionChanged();

    // From here until the answer lands the row shows what is happening and, where the interpreter
    // can be stopped, the button that does it. This is the whole reason the REPL needs one: a
    // submission is deliberately exempt from the evaluation time limit, so it is the one place with
    // no ceiling at all.
    this.evaluating = true;
    this.refreshInputState();

    const stopsBefore = this.stopEpoch;

    let outcome;
    try {
      outcome = await ask("replEval", {
        id,
        input,
        applyRates: this.plugin.settings.fetchExchangeRates,
      }, { priority: "interactive" });
    } finally {
      this.evaluating = false;
      this.refreshInputState();
    }

    if (outcome === null) {
      // A `null` answer usually means the interpreter went away underneath this line, which the
      // reader did not ask for and has to be told about. If they pressed stop it means the exact
      // opposite: it worked. `stopEvaluating` has already said so and is already rebuilding, so
      // adding "Numbat is restarting; please try again" here reports the reader's own successful
      // action as a fault, and invites them to retry the thing they just canceled.
      if (this.stopEpoch !== stopsBefore) {
        return;
      }

      this.appendInfo("Numbat is restarting; please try again.");
      void this.rebuildContext();
      return;
    }

    if (outcome.kind === "crashed") {
      this.appendOutput(escapeHtml(`Numbat crashed and restarted: ${outcome.message}`), true);
      restartNumbat();
      void this.rebuildContext();
      this.scrollToBottom();
      return;
    }

    if (outcome.kind === "command") {
      if (outcome.shouldReset) {
        this.sessionImpure = false;
      }

      if (outcome.shouldClear) {
        this.clearLog();
      } else if (outcome.output.trim() !== "") {
        this.appendOutput(jqueryTerminalToHtml(outcome.output), false);
      }

      if (outcome.shouldReset) {
        this.reportPreludeError(outcome.preludeError);
      }
    } else {
      this.appendOutput(outcome.output, outcome.isError);
    }

    this.sessionChanged();
    this.scrollToBottom();
  }

  /**
   * The hover card for a symbol in the input, the lookup that would produce one, or why there is
   * none. No declaration card and no go-to-definition: a REPL line is not a document, so there is
   * nothing above the caret to declare a name and nowhere to jump to.
   */
  private hoverCard(symbol: HoverSymbol): HoverCard {
    const known = this.facts.knownFacts(symbol.probe, WANT_CARD);
    if (known === undefined) {
      return {
        pending: this.facts.facts([symbol.probe], WANT_CARD),
        miss: "could not look that name up — try again in a moment",
      };
    }

    const dom = symbolCard(factsSource(known), symbol);
    return dom === null ? { miss: `nothing known about \`${symbol.probe}\` here` } : { dom };
  }

  /**
   * This session as the facts layer sees it (interpreter/live-facts.ts): its id, what identifies
   * its exact state, and whether an answer drawn from it could move.
   *
   * `null` while there is no session, and also while the interpreter is mid-restart. This is the
   * same pair of checks {@link evaluate} makes, and for the same reason: a restart discards every
   * session, so answers about this one would describe a scope that no longer exists.
   */
  private session(): SessionScope | null {
    if (this.sessionId === null || !isNumbatReady()) {
      return null;
    }

    return {
      key: `repl\u0000${String(interpreterGeneration())}\u0000${String(this.factsEpoch)}`,
      id: this.sessionId,
      impure: this.sessionImpure || preludeReadsClockOrRandom(),
    };
  }

  /**
   * Note that the session's context has moved on: drop the cached vocabulary, and retire every fact
   * already filed about a name in it.
   *
   * Called wherever the context is built, replaced or evaluated into. The epoch rather than a cache
   * flush, because the facts cache is shared with every other surface and a REPL line is no reason
   * to make a note's hover ask again.
   */
  private sessionChanged(): void {
    this.completionVocab = null;
    this.factsEpoch += 1;
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

  /**
   * Append a plugin message — a command's response, or a status note — which is plain text and
   * styled apart from interpreter output.
   */
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
