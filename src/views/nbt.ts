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

import { TextFileView, type WorkspaceLeaf } from "obsidian";
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

/** Persisted in the vault's `workspace.json`, so this string is a compatibility contract, not a
 *  name: changing it turns every open `.nbt` pane into a "No view of type…" placeholder. It keeps
 *  the `numbat-` prefix for that reason alone. */
export const VIEW_TYPE_NUMBAT_FILE = "numbat-file";

/** How long after the last edit the prelude banner re-checks the file. */
const BANNER_DEBOUNCE_MS = 400;

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

    // Obsidian's editor settings ("Vim key bindings", "Show line number") fire no event of their
    // own, but closing the settings pane lays the workspace out again — so re-reading them there is
    // what makes a change apply without a reload. Both applications are no-ops when the value has
    // not moved.
    this.registerEvent(this.app.workspace.on("layout-change", () => this.applyEditorConfig()));
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

    this.scheduleBanner();
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

  /** Reflect Obsidian's own Vim setting, which this editor follows. */
  applyVim(): void {
    const on = this.plugin.vimModeEnabled();
    if (on !== this.vimOn) {
      this.vimOn = on;
      this.input?.setVim(on);
    }
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

  /** Re-check the prelude banner (the prelude files, or their contents, changed). */
  refreshBanner(): void {
    this.scheduleBanner();
  }

  // THE EDITOR
  // ==============================================================================================

  /** Build (or rebuild) the editor over the current `data`. */
  private buildInput(): void {
    this.input?.destroy();
    this.editorEl.empty();
    this.vimOn = this.plugin.vimModeEnabled();
    this.gutterOn = this.plugin.lineNumbersEnabled();
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

  /** Debounce the prelude check, restarting the wait on each call so a burst of typing costs one
   *  pass. */
  private scheduleBanner(): void {
    this.clearBannerTimer();
    this.bannerTimer = window.setTimeout(() => {
      this.bannerTimer = null;
      void this.checkPrelude();
    }, BANNER_DEBOUNCE_MS);
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
