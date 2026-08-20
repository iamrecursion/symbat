// The editor for a standalone `.nbt` file: a whole Numbat program, edited like a live `numbat` code
// block.
//
// `.nbt` files have been part of the plugin since custom preludes shipped — the settings point at
// them, every interpreter context loads them, the scope inspector lists their declarations, and
// go-to-definition offers to jump into them. What was missing was any way to *open* one: Obsidian
// has no view for an extension no plugin registers, so a prelude file was invisible in the explorer
// and a jump into one landed on an unsupported-format screen.
//
// The editor itself is the shared `NumbatInput` in `document` mode, so highlighting, completion,
// hover, `\code` expansion and Vim are the same code the REPL and the property field run. What this
// view adds is the file: loading and saving it, resolving names against *this document's* scope
// rather than a session, and — for a file that is part of the user prelude — saying so when the
// prelude it builds on is broken.

import { Platform, setIcon, TextFileView, type WorkspaceLeaf } from "obsidian";
import {
  type CompletionVocabulary,
  type ExprCategories,
  type ExprCategory,
  type ExprCompletion,
  expressionCompletions,
} from "../completion/expressions";
import { groupStatements } from "../evaluation/inlay-parse";
import { appendDefinitionLink, declarationCard, symbolCard } from "../hover/content";
import { declaredSymbolAt } from "../hover/declarations";
import type { HoverSymbol } from "../hover/parse";
import {
  completionInfo,
  completionSignature,
  createContext,
  ensureBlockCompletion,
  ensureNumbatReady,
  expressionCompletionCandidates,
  freeQuietly,
  getLastPreludeError,
  interpret,
  isNumbatReady,
  type Numbat,
  restartNumbat,
  structFields,
} from "../interpreter/numbat";
import { setNumbatHtml } from "../interpreter/render";
import type SymbatPlugin from "../main";
import { scopeDeclaration } from "../scope/model";
import { NumbatInput } from "./input";
import { SoftKeyboardTracker } from "./soft-keyboard";
import type { VimMode } from "./vim-mode";

/** Persisted in the vault's `workspace.json`, so this string is a compatibility contract, not a
 *  name: changing it turns every open `.nbt` pane into a "No view of type…" placeholder. It keeps
 *  the `numbat-` prefix for that reason alone. */
export const VIEW_TYPE_NUMBAT_FILE = "numbat-file";

/**
 * How long the prelude banner waits when the cause was not typing.
 *
 * Short, and deliberately not the configured delay: the reader is not mid-line, so there is no
 * half-written state to avoid reporting and no jump to spare them. The two cases are a file
 * arriving in the view, where nothing is on screen to disturb yet and a prelude file that will not
 * load should say so as the reader arrives; and the prelude configuration moving underneath a file
 * that has not itself changed, where the banner is answering a question the reader just asked
 * somewhere else.
 *
 * The configured delay is about typing, which is the only time the banner's height is disruptive.
 */
const BANNER_PROMPT_DELAY_MS = 400;

/**
 * Give `el` Obsidian's `icon`, falling back to the `text` glyph when there is no such icon.
 *
 * `setIcon` is silent about a name the bundled Lucide set does not have — it simply leaves the
 * element empty — and the two names the key bar wants are recent additions, so an older Obsidian
 * would render blank buttons. Checking for the SVG afterwards is the only way to tell.
 */
function setIconOrText(el: HTMLElement, icon: string, text: string): void {
  setIcon(el, icon);
  if (el.querySelector("svg") === null) {
    el.setText(text);
  }
}

/**
 * Move the caret in an already-open `.nbt` file, for go-to-definition (see
 * scope/goto-definition.ts, which is handed this at load). Returns whether a view for `path` was
 * found — a caller that gets `false` falls back to opening the file.
 */
export function focusNumbatFile(plugin: SymbatPlugin, path: string, line: number, ch: number): boolean {
  for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_NUMBAT_FILE)) {
    const { view } = leaf;
    if (view instanceof NumbatFileView && view.file?.path === path) {
      view.focusLine(line, ch);
      void plugin.app.workspace.revealLeaf(leaf);
      return true;
    }
  }
  return false;
}

/** A Numbat source file, edited with the plugin's own CodeMirror editor. */
export class NumbatFileView extends TextFileView {
  /** Read for settings and the interpreter; also what the editor is built against. */
  private readonly plugin: SymbatPlugin;

  /** The container the CodeMirror editor is mounted in. Definitely assigned in {@link onOpen},
   *  which Obsidian calls before the file is loaded. */
  private editorEl!: HTMLElement;

  /** The strip above the editor that reports the file's own evaluation errors. */
  private bannerEl!: HTMLElement;

  /** The editor itself; absent before {@link onOpen} and after {@link onClose}, and replaced
   *  outright when a different file is loaded into this view. */
  private input?: NumbatInput;

  /** The mobile key bar below the editor, shown only while the soft keyboard is up; null on desktop
   *  and until the view is built. */
  private keyBarEl: HTMLElement | null = null;

  /** The key bar's Vim buttons — Escape and the visual-block toggle — shown only while Vim is on.
   *  The third button (hide the keyboard) needs no reference: with the bar up it is never
   *  hidden. */
  private escButtonEl: HTMLButtonElement | null = null;
  private blockButtonEl: HTMLButtonElement | null = null;

  /** The on-screen keyboard overlapping this view's bottom edge, which is both what the bar is
   *  lifted clear of and the signal for showing it at all. Built in {@link onOpen}. */
  private keyboard?: SoftKeyboardTracker;

  /** The editor's current Vim mode, or `null` when Vim is off — reported by the editor, and read to
   *  light up the visual-block button. */
  private vimMode: VimMode | null = null;

  /** The pending debounced banner evaluation, or `null` when none is scheduled. */
  private bannerTimer: number | null = null;

  /** Whether the current editor was built with Vim bindings on. Held so re-reading Obsidian's
   *  editor settings on a layout change only dispatches when one moved. */
  private vimOn = false;

  /** Whether the current editor was built with the line-number gutter on. */
  private gutterOn = false;

  /** @param leaf the workspace leaf to mount in. @param plugin the plugin to read. */
  constructor(leaf: WorkspaceLeaf, plugin: SymbatPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  /** Obsidian's identifier for this view type — what `.nbt` files are opened with. */
  getViewType(): string {
    return VIEW_TYPE_NUMBAT_FILE;
  }

  /** The tab icon. */
  getIcon(): string {
    return "calculator";
  }

  /** Build the banner and the editor, and start following Obsidian's editor settings. */
  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("numbat-file-view");
    this.bannerEl = root.createDiv({ cls: "numbat-file-banner" });
    this.bannerEl.hide();
    this.editorEl = root.createDiv({ cls: "numbat-file-editor" });
    this.buildInput();
    this.buildKeyBar(root);

    // Hold the key bar clear of the on-screen keyboard by insetting the view's bottom (see
    // styles.css), and show it only while that keyboard is up.
    this.keyboard = new SoftKeyboardTracker(this, {
      target: this.contentEl,
      changed: () => this.applyBottomInset(),
    });

    // Obsidian's editor settings ("Vim key bindings", "Show line number") fire no event of their
    // own, but closing the settings pane lays the workspace out again — so re-reading them there is
    // what makes a change apply without a reload. Both applications are no-ops when the value has
    // not moved. The same layout change is also the one move of this view's own rectangle that the
    // keyboard tracker cannot see for itself.
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      this.applyEditorConfig();
      this.keyboard?.remeasure();
    }));

    // Apply the initial inset: opening a file from the quick switcher while the keyboard is already
    // up gives the tracker nothing to report, and the bar would sit behind the keyboard until the
    // next time one of them moved.
    this.applyBottomInset();
  }

  /** Re-measure the keyboard overlap when this view's own rectangle moves. */
  onResize(): void {
    super.onResize();
    this.keyboard?.remeasure();
  }

  /** Re-read Obsidian's own editor settings and apply any that moved. */
  private applyEditorConfig(): void {
    this.applyVim();
    this.applyLineNumbers();
  }

  /** Tear the editor down with the view, cancelling the pending banner evaluation. */
  async onClose(): Promise<void> {
    this.clearBannerTimer();
    this.input?.destroy();
    this.input = undefined;
    this.keyBarEl = null;
    this.escButtonEl = null;
    this.blockButtonEl = null;

    // The tracker's listeners are unregistered with this component; dropping the reference keeps a
    // late workspace event from measuring a detached element.
    this.keyboard = undefined;
  }

  // THE FILE (TEXTFILEVIEW'S CONTRACT)
  // ==============================================================================================

  /** The text to save: the editor's current content, falling back to the last text loaded when
   *  there is no editor (before open, after close). */
  getViewData(): string {
    return this.input?.getValue() ?? this.data;
  }

  /**
   * Load a file's text into the editor. A different file (`clear`) gets a fresh editor rather than
   * a replaced document: CodeMirror's undo history is per-view, and reusing it would let Ctrl+Z
   * "undo" the load and write the *previous* file's contents into this one.
   */
  setViewData(data: string, clear: boolean): void {
    this.data = data;
    if (this.input === undefined) {
      return;
    }

    if (clear) {
      this.buildInput();
    } else {
      this.input.setDocument(data);
    }

    // A different file has just arrived and its banner is whatever the previous file left; report
    // on the new one promptly. A same-file reload is an edit landing from elsewhere, and waits.
    this.scheduleBanner(clear ? BANNER_PROMPT_DELAY_MS : undefined);
  }

  /** Empty the view, as Obsidian does before loading a different file. */
  clear(): void {
    this.data = "";
    this.input?.setDocument("");
    this.showBanner(null);
  }

  /** Move the caret to a 0-indexed line (go-to-definition landing in this file). */
  focusLine(line: number, ch = 0): void {
    this.input?.setCaret(line, ch);
  }

  /**
   * Honor the `eState: { line }` Obsidian carries through `openFile` — which is how a
   * go-to-definition from a note reaches a line inside a prelude file. Without this the file opens
   * at the top and the line number is silently dropped.
   */
  setEphemeralState(state: unknown): void {
    super.setEphemeralState(state);
    const line = (state as { line?: unknown; } | null)?.line;
    if (typeof line === "number") {
      // The editor is built in `onOpen`, which may not have run yet on a cold open.
      window.setTimeout(() => this.focusLine(line), 0);
    }
  }

  /** Rebuild the editor's hover extension after a hover setting changed. */
  applyHover(): void {
    this.input?.setHover(this.plugin.settings.hover);
  }

  /** Reflect the inlay settings (the per-line results and type hints). */
  applyInlayHints(): void {
    this.input?.setInlayHoles(this.plugin.settings.inlayHints);
  }

  /** Recompute this file's inlay hints because what they *mean* changed (e.g. a change to a prelude
   * or the exchange rates) rather than because the file did. */
  refreshInlays(): void {
    this.input?.refreshInlays();
  }

  /** Reflect Obsidian's own Vim setting, which this editor follows. */
  applyVim(): void {
    const on = this.plugin.vimModeEnabled();
    if (on !== this.vimOn) {
      this.vimOn = on;
      this.input?.setVim(on);
    }

    // Unconditional: the key bar's Vim buttons also depend on the keyboard being up, which moves
    // without the setting moving.
    this.syncKeyBar();
  }

  /** Reflect the configured Tab indent width. */
  applyIndentWidth(): void {
    this.input?.setIndentWidth(this.plugin.settings.nbtIndentWidth);
  }

  /** Reflect Obsidian's own "Show line number" setting. */
  applyLineNumbers(): void {
    const on = this.plugin.lineNumbersEnabled();
    if (on !== this.gutterOn) {
      this.gutterOn = on;
      this.input?.setLineNumbers(on);
    }
  }

  /** Re-check the prelude banner (the prelude files, or their contents, changed). Not typing, so
   *  it reports promptly — see {@link BANNER_PROMPT_DELAY_MS}. */
  refreshBanner(): void {
    this.scheduleBanner(BANNER_PROMPT_DELAY_MS);
  }

  // THE EDITOR
  // ==============================================================================================

  /** Build (or rebuild) the editor over the current `data`. */
  private buildInput(): void {
    this.input?.destroy();
    this.editorEl.empty();
    this.vimOn = this.plugin.vimModeEnabled();
    this.gutterOn = this.plugin.lineNumbersEnabled();

    // A fresh editor starts in whatever mode Vim starts in, and reports it as soon as it is built;
    // clearing this first keeps the previous editor's mode from lingering on the key bar in
    // between.
    this.setVimMode(null);

    this.input = new NumbatInput(
      this.editorEl,
      this.plugin,
      {
        // A file has nothing to submit to; `document` mode drops the Enter binding that would call
        // this, so it exists only to satisfy the host interface.
        submit: () => {},
        changed: () => {
          this.requestSave();
          this.scheduleBanner();
        },
        caretMoved: (line) => {
          const path = this.file?.path;
          if (path !== undefined) {
            this.plugin.reportCursor(path, line);
          }
        },
        filePath: () => this.file?.path ?? null,
        exprCompletions: (query, enabled, allowed) => this.exprCompletions(query, enabled, allowed),
        memberFields: (base) => {
          const resolved = this.contextAbove();
          return resolved === null ? [] : structFields(resolved.context, base);
        },
        completionSignature: (name) => {
          const resolved = this.contextAbove();
          return resolved === null ? null : completionSignature(resolved.context, name);
        },
        completionInfo: (name) => {
          const resolved = this.contextAbove();
          return resolved === null ? null : completionInfo(resolved.context, name);
        },
        hoverCard: (symbol) => this.hoverCard(symbol),
        // Document mode shows every line's result instead of the last line's hole.
        holeType: () => null,
        // What lights up the key bar's visual-block button while that mode is live.
        vimModeChanged: (mode) => this.setVimMode(mode),
      },
      {
        highlight: true,
        vimMode: this.plugin.vimModeEnabled(),
        inlayHoles: this.plugin.settings.inlayHints,
        hover: this.plugin.settings.hover,
        placeholder: "A Numbat file — let, fn, unit, dimension…",
        document: true,
        lineNumbers: this.plugin.lineNumbersEnabled(),
        indentWidth: this.plugin.settings.nbtIndentWidth,
      },
    );
    this.input.setDocument(this.data);
  }

  // THE MOBILE KEY BAR
  // ==============================================================================================

  /**
   * Build the mobile-only bar below the editor: the keys a soft keyboard does not have.
   *
   * A phone keyboard has no `Esc`, which strands a Vim user in insert mode, and no `Ctrl-V`, which
   * puts blockwise visual out of reach entirely — the two things a whole Numbat program is most
   * awkward to edit without. The third button dismisses the keyboard, which is worth a button of
   * its own on a screen where the only other way is to tap something unrelated.
   *
   * Every button keeps focus where it is (`preventDefault` on pointer-down), or the keyboard would
   * dismiss itself on the way to being used — which for the first two buttons is precisely wrong.
   * The bar starts hidden; {@link syncKeyBar} reveals it when the keyboard comes up.
   */
  private buildKeyBar(root: HTMLElement): void {
    if (!Platform.isMobile) {
      return;
    }

    const bar = root.createDiv({ cls: "numbat-file-keybar" });
    bar.hide();
    this.keyBarEl = bar;

    const button = (cls: string, label: string, onClick: () => void): HTMLButtonElement => {
      const el = bar.createEl("button", { cls, attr: { type: "button", "aria-label": label } });
      this.registerDomEvent(el, "mousedown", (evt) => evt.preventDefault());
      this.registerDomEvent(el, "click", onClick);
      return el;
    };

    // Escape, leftmost: the whole key, not just "leave insert mode" — it also leaves the visual
    // block the next button starts, and cancels a half-typed operator.
    this.escButtonEl = button("numbat-file-keybar-esc", "Escape", () => {
      this.input?.pressEscape();
      this.input?.focus();
    });
    this.escButtonEl.setText("⎋");

    // Blockwise visual, beside it. A toggle in both directions, and lit while it is on.
    this.blockButtonEl = button("numbat-file-keybar-block", "Toggle visual block", () => {
      this.input?.toggleVisualBlock();
      this.input?.focus();
    });
    setIconOrText(this.blockButtonEl, "box-select", "▦");

    // Everything above is Vim's; the spacer pushes what is not to the far right.
    bar.createDiv({ cls: "numbat-file-keybar-spacer" });

    // Dismiss the keyboard. The one button that must *not* put focus back, since dropping it is
    // what closes the keyboard; the bar then hides itself along with it.
    const hide = button("numbat-file-keybar-hide", "Hide keyboard", () => this.input?.blur());
    setIconOrText(hide, "keyboard-off", "⌄");

    // The editor is built before the bar is, so its first mode report arrived with no button to
    // put it on; this applies what was recorded then.
    this.setVimMode(this.vimMode);
    this.syncKeyBar();
  }

  /**
   * Inset the view's bottom by the keyboard's overlap, so the key bar rises to sit just above it
   * (see styles.css), and show or hide the bar with the keyboard itself. Called on open and
   * whenever the tracker reports a move.
   */
  private applyBottomInset(): void {
    this.contentEl.style.setProperty("--numbat-file-bottom-inset", `${this.keyboard?.inset() ?? 0}px`);
    this.syncKeyBar();
  }

  /**
   * Show the key bar only while the soft keyboard is up — that is exactly when the keys it carries
   * are missing, and with a hardware keyboard attached (which keeps the soft one hidden) every one
   * of them is redundant.
   *
   * Its two Vim buttons additionally need Vim to be on. Dismissing the keyboard does not, so the
   * bar still appears for it alone.
   *
   * The bar floats over the editor, so showing it also has to give the document somewhere to go:
   * its height becomes both trailing scroll room (styles.css) and the caret's scroll margin, or the
   * end of the file would sit permanently under a button. That height is measured rather than
   * assumed, since the buttons are sized in the theme's own units.
   */
  private syncKeyBar(): void {
    const up = this.keyboard?.isUp() ?? false;
    this.keyBarEl?.toggle(up);
    this.escButtonEl?.toggle(this.vimOn);
    this.blockButtonEl?.toggle(this.vimOn);

    // Read after the toggle above, so a hidden bar is not measured as zero-height while it is about
    // to be shown.
    const height = up ? (this.keyBarEl?.offsetHeight ?? 0) : 0;
    this.contentEl.toggleClass("numbat-file-keybar-up", up);
    this.contentEl.style.setProperty("--numbat-file-keybar-height", `${height}px`);
    this.input?.setScrollBottomMargin(height);
  }

  /** Record the editor's Vim mode and light the visual-block button while that mode is the live
   *  one — a toggle that does not say which way it is toggled is a guess. */
  private setVimMode(mode: VimMode | null): void {
    this.vimMode = mode;
    this.blockButtonEl?.toggleClass("is-active", mode === "visual-block");
  }

  // SCOPE AT THE CARET
  // ==============================================================================================

  /**
   * The document's lines, and the 0-indexed line the caret is on. The editor is the live buffer, so
   * this is what the user sees rather than what is on disk.
   */
  private documentLines(): { lines: string[]; caret: number; } | null {
    if (this.input === undefined) {
      return null;
    }
    return { lines: this.input.getValue().split("\n"), caret: this.input.caretLine() };
  }

  /**
   * An interpreter context holding everything in scope above the caret: the file's statements up to
   * (and, with `includeCaretLine`, including) the caret's line.
   *
   * Each statement is its own replay chunk, so a half-written line leaves the definitions above it
   * intact — and the whole thing is memoized by {@link ensureBlockCompletion}, which the note's
   * completer shares. `preludeBefore` keeps a file that is itself part of the prelude from being
   * defined twice.
   */
  private contextAbove(includeCaretLine = false): { context: Numbat; vocab: CompletionVocabulary; } | null {
    const document = this.documentLines();
    if (document === null) {
      return null;
    }

    const above = document.lines.slice(0, includeCaretLine ? document.caret + 1 : document.caret);
    const chunks = groupStatements(above).map((statement) => statement.text);
    const path = this.file?.path ?? null;

    return ensureBlockCompletion(chunks, this.plugin.settings.fetchExchangeRates, {
      preludeBefore: path ?? undefined,
    });
  }

  /**
   * Categorized expression completions for `query` against the scope above the caret. Empty when
   * the interpreter is not ready or completion is switched off.
   */
  private exprCompletions(
    query: string,
    enabled: ExprCategories,
    allowed: ReadonlySet<ExprCategory> | null,
  ): ExprCompletion[] {
    if (!this.plugin.settings.exprCompletion) {
      return [];
    }

    const resolved = this.contextAbove();
    if (resolved === null) {
      return [];
    }

    const raw = expressionCompletionCandidates(resolved.context, query);
    return expressionCompletions(raw, resolved.vocab, enabled, allowed);
  }

  /**
   * The hover card for a symbol in this file: the interpreter's own documentation where it has
   * some, else what the enclosing declaration says about the name (a parameter, a type parameter, a
   * struct field), plus a go-to-definition row when the file declares the name itself.
   */
  private hoverCard(symbol: HoverSymbol): HTMLElement | null {
    const document = this.documentLines();
    if (document === null) {
      return null;
    }

    // A parameter, a type parameter or a struct field is asked about first: it shadows, and the
    // interpreter — which knows nothing about it — may well know an outer name that matches. A
    // member chain is excluded, since its `name` is only the last component and a declaration
    // elsewhere could introduce that.
    const declared = symbol.kind === "name"
      ? declaredSymbolAt(document.lines, document.caret, symbol.name)
      : null;

    // The caret's own line counts: hovering `speed` on its own `let speed = …` must resolve it, and
    // that line falls below the completion cut.
    const resolved = declared !== null ? null : this.contextAbove(true);
    const content = declared !== null
      ? declarationCard(declared)
      : resolved === null
      ? null
      : symbolCard(resolved.context, symbol);
    if (content === null) {
      return null;
    }

    // A declared name's definition is the declaration the pointer is already inside; linking would
    // lead to the outer binding it shadows, which is the one place it must not go.
    const line = declared !== null ? null : this.declaringLine(document.lines, symbol.name, document.caret);
    const path = this.file?.path ?? null;
    if (line !== null && path !== null) {
      appendDefinitionLink(
        content,
        this.app,
        { defsite: { notePath: null, line, ch: 0 }, entry: null, where: "this file" },
        path,
        () => {},
      );
    }

    return content;
  }

  /**
   * The line that declares `name` — the nearest `let`/`fn`/`unit`/`dimension` at or above `caret`,
   * else the last one in the file (a name used before its definition still has one worth jumping
   * to). `null` when the file does not declare it.
   */
  private declaringLine(lines: readonly string[], name: string, caret: number): number | null {
    let last: number | null = null;
    for (let i = 0; i < lines.length; i += 1) {
      if (scopeDeclaration(lines[i])?.name !== name) {
        continue;
      }

      if (i <= caret) {
        last = i;
      } else if (last === null) {
        return i;
      }
    }

    return last;
  }

  // THE PRELUDE BANNER
  // ==============================================================================================

  /** Abandon a pending banner evaluation. */
  private clearBannerTimer(): void {
    if (this.bannerTimer !== null) {
      window.clearTimeout(this.bannerTimer);
      this.bannerTimer = null;
    }
  }

  /**
   * Debounce the prelude check, restarting the wait on each call so a burst of typing costs one
   * pass.
   *
   * Restarting is what makes one interval enough for what look like two decisions. The banner takes
   * vertical space, so it must not appear while a half-written line is momentarily invalid but it
   * must not flicker away and back either, and a wait that restarts does both. While the file is
   * being typed nothing changes at all, and what is on screen when the typing stops is what the
   * file says once it is still. Showing and hiding cannot be given different delays without
   * evaluating more often than the banner changes, and each evaluation is a standard-library load.
   *
   * `delayMs` defaults to the configured one because typing is the case that matters; the callers
   * that are not typing pass {@link BANNER_PROMPT_DELAY_MS} instead.
   */
  private scheduleBanner(delayMs = this.plugin.settings.preludeErrorDelaySeconds * 1000): void {
    this.clearBannerTimer();
    this.bannerTimer = window.setTimeout(() => {
      this.bannerTimer = null;
      void this.checkPrelude();
    }, delayMs);
  }

  /**
   * For a file that is part of the user prelude, report the two failures that are otherwise
   * invisible: the prelude files *before* it failing to load (so nothing in this file resolves
   * against what it expects), and this file itself failing to apply as a whole — which is what
   * would happen to every note in the vault, with no error shown anywhere.
   *
   * A file that is not in the prelude list has no such contract, and gets no banner.
   */
  private async checkPrelude(): Promise<void> {
    const path = this.file?.path ?? null;
    if (path === null || !this.plugin.preludeFileList().some((file) => file.path === path)) {
      this.showBanner(null);
      return;
    }

    try {
      await ensureNumbatReady();
      await this.plugin.ensureExchangeRates();
      await this.plugin.ensurePrelude();
    } catch (error) {
      console.error("Symbat: could not start the interpreter to check the prelude", error);
      return;
    }

    if (!isNumbatReady() || this.input === undefined) {
      return;
    }

    const context = createContext(this.plugin.settings.fetchExchangeRates, { preludeBefore: path });
    try {
      const earlier = getLastPreludeError();
      if (earlier !== null) {
        this.showBanner("The prelude loaded before this file failed:", earlier);
        return;
      }

      const result = interpret(context, this.input.getValue());
      this.showBanner(result.isError ? "This file will not load as a prelude:" : null, result.output);
    } catch (error) {
      console.error("Symbat: checking the prelude crashed the interpreter", error);
      restartNumbat();
    } finally {
      freeQuietly(context);
    }
  }

  /** Show (or, with a null label, hide) the banner above the editor. */
  private showBanner(label: string | null, html = ""): void {
    this.bannerEl.empty();
    if (label === null) {
      this.bannerEl.hide();
      return;
    }

    this.bannerEl.createDiv({ cls: "numbat-file-banner-label", text: label });
    setNumbatHtml(this.bannerEl.createEl("pre", { cls: "numbat-output numbat-error" }), html);
    this.bannerEl.show();
  }
}
