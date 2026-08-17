import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  type Editor,
  editorInfoField,
  MarkdownView,
  normalizePath,
  Notice,
  Plugin,
  type TAbstractFile,
  TFolder,
  type WorkspaceLeaf,
} from "obsidian";
import { NumbatExprEditorSuggest } from "./completion/suggest";
import { sourcePathOf } from "./document/editor-file";
import { numbatFenceState } from "./document/fence-state";
import { numbatMarkdownPairGuard } from "./document/markdown-pair";
import { registerCodeBlocks } from "./evaluation/codeblock";
import { numbatInlayHints, refreshNumbatInlays } from "./evaluation/inlay";
import {
  commitText,
  evaluateNoteUnits,
  inlineConfig,
  numbatInlineEval,
  refreshNumbatInline,
} from "./evaluation/inline";
import { scanNote } from "./evaluation/inline-parse";
import { registerInlineEvalReading } from "./evaluation/inline-reading";
import { invalidateDefinitions } from "./hover/definition";
import { dismissHover, showHoverAtCursor } from "./hover/hover";
import { noteHoverExtension } from "./hover/note";
import { mapVimHoverKey, unmapVimHoverKey } from "./hover/vim";
import { ModuleGraph } from "./imports/graph";
import {
  clearExchangeRates,
  disposeCompletionContexts,
  ensureNumbatReady,
  interpreterGeneration,
  invalidateExpressionCompletion,
  isNumbatReady,
  loadExchangeRates,
  type PreludePart,
  primeExchangeRatesCache,
  restartNumbat,
  setUserPrelude,
} from "./interpreter/numbat";
import { VersionedLoad } from "./interpreter/versioned-load";
import { registerZonedDateTypes } from "./properties/date-type";
import { watchPointerDown } from "./properties/focus-guard";
import {
  frontmatterBody,
  invalidateReservedNames,
  notePreamble,
  primeReservedNames,
  propertyTypeManager,
} from "./properties/note";
import { installTypeOrder } from "./properties/registry";
import { clearPropertyOutcomes, disposePropertyEditors, registerNumbatPropertyType } from "./properties/type";
import { disposeZoneEditors, sweepZoneUnclips } from "./properties/zone-editor";
import { setCaretTarget } from "./scope/goto-definition";
import { normalizeSettings, type SymbatSettings, SymbatSettingTab } from "./settings/tab";
import { normalizePreludeFiles } from "./settings/util";
import { numbatCommentFilter } from "./syntax/comment";
import { registerHighlighting } from "./syntax/highlight";
import { numbatUnicodeInput } from "./unicode/input";
import { NumbatUnicodeEditorSuggest } from "./unicode/suggest";
import { focusNumbatFile, NumbatFileView, VIEW_TYPE_NUMBAT_FILE } from "./views/nbt";
import { NumbatReplView, VIEW_TYPE_NUMBAT_REPL } from "./views/repl";
import { NumbatScopeView, VIEW_TYPE_NUMBAT_SCOPE } from "./views/scope";

/**
 * The plugin itself: owns the settings, the interpreter's shared state (the user prelude, the
 * exchange rates, the import graph), and the registration of every surface — editor extensions,
 * views, commands, the property type and the completers.
 *
 * It is also the single object the surfaces read their configuration from, which is why so much of
 * the codebase takes a `SymbatPlugin`: settings are read live at use time rather than captured, so
 * a toggle takes effect by reconfiguring the editors rather than by rebuilding anything.
 */
export default class SymbatPlugin extends Plugin {
  /** The plugin's settings, accessible through the plugin instance. */
  settings!: SymbatSettings;

  /** The cross-note import graph: caches each note's `numbat-shared` block code so the note-scope
   *  preamble can gather `numbat-use` imports synchronously. Created in {@link onload}; read by
   *  properties/note.ts. */
  moduleGraph?: ModuleGraph;

  /** Reload guard for the user prelude. Versioned rather than a dirty flag because the read is
   *  async and several surfaces await it at once — see {@link VersionedLoad}. */
  private readonly prelude = new VersionedLoad(() => this.loadPrelude());

  /** Whether the on-disk exchange-rate cache has been read into memory yet (once). */
  private exchangeRatesSeeded = false;

  /** The settings tab, kept so a prelude path rewritten by a vault rename can re-render it in
   *  place. Definitely assigned in {@link onload}. */
  private settingTab!: SymbatSettingTab;

  /** The editor expression completer, kept so its floating popup can be freed on unload — and so
   *  the hover can tell whether it is open (hover stands aside for a completer, which shows the
   *  same card on its own dwell). */
  exprSuggest?: NumbatExprEditorSuggest;

  /** The registered inlay-hint editor extension, mutated in place and flushed with
   *  `updateOptions()` so the "Inline results and type hints" toggles apply live. */
  private readonly inlayExtension: Extension[] = [];

  /** The registered inline-evaluation editor extension, mutated in place and flushed with
   *  `updateOptions()` so the "Inline expression evaluation" toggle (and prefix changes) apply
   *  live. */
  private readonly inlineEvalExtension: Extension[] = [];

  /** The registered hover extension, mutated in place and flushed with `updateOptions()` so the
   *  "Hover information" settings apply live. */
  private readonly hoverExtension: Extension[] = [];

  // LIFECYCLE
  // ==============================================================================================

  /** Register the REPL view, code-block processors, highlighting, commands and the settings tab.
   * The interpreter itself is initialized lazily on first use. */
  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_NUMBAT_REPL, (leaf) => new NumbatReplView(leaf, this));

    // The note scope inspector (a right-sidebar tree of the active note's bindings).
    this.registerView(VIEW_TYPE_NUMBAT_SCOPE, (leaf) => new NumbatScopeView(leaf, this));

    // The `.nbt` file editor. Registering the extension is what makes Numbat files openable at all
    // — and, as a side effect, visible in the file explorer and the quick switcher, where an
    // unregistered extension is hidden entirely.
    this.registerView(VIEW_TYPE_NUMBAT_FILE, (leaf) => new NumbatFileView(leaf, this));
    try {
      this.registerExtensions(["nbt"], VIEW_TYPE_NUMBAT_FILE);
    } catch (error) {
      // Another plugin may already have claimed the extension; that is its vault to share, and
      // everything else here still works.
      console.error("Symbat: could not register the .nbt file extension", error);
    }

    // Go-to-definition into a `.nbt` file that is already open moves its caret rather than
    // reopening it; the target is handed in so scope/goto-definition.ts stays a leaf.
    setCaretTarget((path, line, ch) => focusNumbatFile(this, path, line, ch));

    // The cross-note import graph (numbat-use); its cache is invalidated by the vault events
    // registered below. When an imported note changes, it nudges the open editors to recompute (a
    // light effect dispatch, not an extension rebuild, so only the notes whose imports moved
    // re-evaluate — and background panes still repaint) and refreshes any open scope inspector.
    this.moduleGraph = new ModuleGraph(this, () => {
      this.refreshImportDependents();
      this.refreshScopeViews();
    });

    registerCodeBlocks(this);

    // Where the reader last pressed, which is what tells a property widget in a Bases cell whether
    // a blur means they have left the field or merely reached for its completion popup
    // (properties/focus-guard.ts). Registered before the types that consult it.
    watchPointerDown(this);

    // The `Numbat` property type (assignable from a property's type menu); a property so typed
    // binds its value into the note's scope (properties/note.ts).
    registerNumbatPropertyType(this);

    // The `Zoned Date` and `Zoned Datetime` types — a date or a moment that can carry a time zone,
    // which Obsidian's own Date type has nowhere to put and its Datetime type discards. Both add a
    // type to the menu rather than replacing one, so neither is gated on a setting.
    registerZonedDateTypes(this);

    // The type menu lists types in the order the registry holds them, which puts everything a
    // plugin registers after everything Obsidian ships. Sort the registry by name instead, so the
    // three above sit among the built-in types rather than behind them (properties/registry.ts).
    installTypeOrder(this);

    // A type (re)assignment changes which properties bind — re-evaluate open editors. The event is
    // undocumented (like the registry); a missing `on` just means stale hints until the next edit.
    const typeEvents = propertyTypeManager(this.app)?.on?.("changed", () => this.refreshNoteScope());
    if (typeEvents !== undefined && typeEvents !== null) {
      this.registerEvent(typeEvents);
    }
    void registerHighlighting(this);

    // LaTeX-style Unicode expansion (`\alpha` → `α`) inside numbat code — blocks, inline-eval
    // spans, and a Numbat-typed property's value; the handler reads `settings.unicodeExpansion`
    // live, so the toggle takes effect without re-registering. The REPL wires up its own textarea
    // (see views/repl.ts). The fence index every per-keystroke scope check reads
    // (document/fence-state.ts). Registered before the handlers that consume it; without it they
    // fall back to scanning, so ordering is a matter of cost, not correctness.
    this.registerEditorExtension(numbatFenceState);
    this.registerEditorExtension(numbatUnicodeInput(this));

    // Typing `*` or `_` inside numbat code (blocks, inline-eval spans, or a Numbat-typed property's
    // value) inserts the character literally, pre-empting Obsidian's Markdown auto-pairing — those
    // characters are Numbat syntax there, not emphasis markers.
    this.registerEditorExtension(numbatMarkdownPairGuard(this));

    // The matching `\code` completion popover in numbat blocks. The REPL attaches its own popover
    // to the input textarea (see views/repl.ts).
    this.registerEditorSuggest(new NumbatUnicodeEditorSuggest(this.app, this));

    // Expression completion (identifiers/operators/types) in numbat blocks; it reads its settings
    // live and stands aside for the `\code` completer, so it needs no re-registration when the
    // toggles change. The REPL wires the same completions into its own CM6 input (see
    // views/input.ts).
    this.exprSuggest = new NumbatExprEditorSuggest(this.app, this);
    this.registerEditorSuggest(this.exprSuggest);

    // Inline results and inferred type hints in numbat blocks (Source mode / Live Preview).
    // Registered through a mutable array so the toggles can add or remove it live (see
    // refreshInlayHints); populated from the current setting now.
    this.registerEditorExtension(this.inlayExtension);
    this.refreshInlayHints();

    // Inline expression evaluation in prose (`` n`expr` `` / `` nc`expr` ``): the editor extension
    // paints highlights + result widgets and materializes concrete spans (see
    // evaluation/inline.ts), while the post-processor renders the computed value in reading view
    // (see evaluation/inline-reading.ts). The extension is registered through a mutable array so
    // the toggle can add or remove it live.
    this.registerEditorExtension(this.inlineEvalExtension);
    this.refreshInlineEval();
    registerInlineEvalReading(this);

    // Hover information: the completer's documentation card, opened by pointing at a symbol rather
    // than by completing one. Registered through a mutable array (like the two above) so the
    // toggles, the delay, and the Vim key apply live.
    this.registerEditorExtension(this.hoverExtension);
    this.refreshHover();

    // Rewrite Obsidian's Toggle comment into a Numbat `#` toggle inside a numbat block (a
    // transaction filter, since the key itself cannot be intercepted before Obsidian's command);
    // elsewhere Obsidian's Markdown comments are left untouched.
    this.registerEditorExtension(numbatCommentFilter);

    // Report the caret's position to any open scope inspector so it can expand and highlight the
    // node the cursor is in, live as it moves. A lightweight listener (it no-ops when no scope view
    // is open).
    this.registerEditorExtension(EditorView.updateListener.of((update) => {
      if (!update.selectionSet && !update.docChanged) {
        return;
      }
      const path = update.state.field(editorInfoField, false)?.file?.path;
      if (path === undefined || path === null) {
        return;
      }
      this.reportCursor(path, update.state.doc.lineAt(update.state.selection.main.head).number - 1);
    }));

    // The ribbon icons and commands are for convenience.
    this.addRibbonIcon("calculator", "Open Symbat REPL", () => {
      void this.activateReplView();
    });
    this.addRibbonIcon("list-tree", "Open Symbat scope inspector", () => {
      void this.activateScopeView();
    });
    this.addCommand({
      id: "open-repl",
      name: "Open REPL",
      callback: () => {
        void this.activateReplView();
      },
    });
    this.addCommand({
      id: "open-scope",
      name: "Open note scope inspector",
      callback: () => {
        void this.activateScopeView();
      },
    });
    this.addCommand({
      id: "create-file",
      // Named for the extension rather than the language: Obsidian shows the plugin name beside a
      // command, so "Create a Numbat file" would read as "Symbat: Create a Numbat file" — two names
      // for one thing, in the one place the distinction helps least.
      name: "Create a .nbt file",
      callback: () => {
        void this.createNumbatFile(this.app.workspace.getActiveFile()?.parent ?? null);
      },
    });

    // The same, from a folder's context menu in the file explorer — where "New note" already lives,
    // and where you actually think about creating one.
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFolder)) {
        return;
      }
      menu.addItem((item) => {
        item.setTitle("New Numbat file").setIcon("calculator").onClick(() => {
          void this.createNumbatFile(file);
        });
      });
    }));
    this.addCommand({
      id: "search-scope",
      name: "Search the note scope and prelude",
      callback: () => {
        void this.activateScopeView().then(() => {
          this.forEachScopeView((view) => view.focusSearch());
        });
      },
    });

    // Open the hover card at the cursor, without waiting for a dwell. Bindable to any hotkey — and
    // the way to reach the feature with Vim's normal-mode key left unmapped. Hidden when hover is
    // disabled.
    this.addCommand({
      id: "show-hover",
      name: "Show info at the cursor",
      editorCheckCallback: (checking: boolean, editor: Editor) => {
        if (!this.settings.hover) {
          return false;
        }
        const view = (editor as unknown as { cm?: EditorView; }).cm;
        if (!view) {
          return false;
        }
        if (!checking) {
          showHoverAtCursor(view);
        }
        return true;
      },
    });

    // Bake every live inline evaluation currently on screen into the note as plain text. Hidden
    // when inline evaluation is disabled.
    this.addCommand({
      id: "commit-visible-inline",
      name: "Commit all visible inline evaluations",
      editorCheckCallback: (checking: boolean, editor: Editor) => {
        if (!this.settings.inlineEval) {
          return false;
        }
        const view = (editor as unknown as { cm?: EditorView; }).cm;
        if (!view) {
          return false;
        }
        if (!checking) {
          void this.commitVisibleInline(view);
        }
        return true;
      },
    });

    this.settingTab = new SymbatSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // Reload the cached prelude when a prelude file changes on disk, and follow moves/renames by
    // rewriting the stored path (see `onVaultRename`), so later blocks and the REPL keep finding
    // the file automatically.
    this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultChange(file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultChange(file.path)));
    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => this.onVaultRename(file.path, oldPath)),
    );

    // Re-read an imported note whose content or frontmatter changed, so notes that `numbat-use` it
    // re-evaluate. Both events are wired: `vault.modify` fires on every content save (including
    // edits confined to a code block, which the metadata cache does not treat as a change) with a
    // fresh `cachedRead`, and `metadataCache.changed` fires after a re-parse (so a typed-property
    // change is reflected). Rename/delete can change link resolution anywhere, so those clear the
    // whole import cache.
    this.registerEvent(this.app.vault.on("modify", (file) => this.moduleGraph?.noteChanged(file.path)));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => this.moduleGraph?.noteChanged(file.path)));
    this.registerEvent(this.app.vault.on("delete", () => this.moduleGraph?.reset()));
    this.registerEvent(this.app.vault.on("rename", () => this.moduleGraph?.reset()));

    // A focused zoned property in a Bases cell marks Obsidian's own cell so the picker can overflow
    // it, and puts the mark back when it closes — but a view that goes while a cell is open never
    // closes it. This is the event that says so (properties/zone-editor.ts).
    this.registerEvent(this.app.workspace.on("layout-change", () => sweepZoneUnclips()));

    // We explicitly avoid initializing the WASM interpreter on load, as we do it lazily instead to
    // conserve memory and compute.
  }

  /**
   * Free the cached completion contexts (and cancel the idle-release timer) when the plugin is
   * disabled or reloaded, so their wasm allocations are not left dangling. Open REPL views free
   * their own context on close, and code-block render contexts are freed per render, so nothing
   * else needs tearing down here.
   */
  onunload(): void {
    this.exprSuggest?.destroy();
    setCaretTarget(null);

    // Vim mappings live in Obsidian's own vim instance, not in an extension we own, so they outlast
    // the plugin unless removed explicitly.
    unmapVimHoverKey();
    invalidateDefinitions();
    disposePropertyEditors();
    clearPropertyOutcomes();
    disposeZoneEditors();
    this.moduleGraph?.dispose();
    disposeCompletionContexts();
  }

  // VAULT EVENTS
  // ==============================================================================================

  /** Mark the prelude for reload if the changed vault path is one of its files. */
  private onVaultChange(path: string): void {
    if (this.preludeFiles().includes(path)) {
      // The same invalidation as a prelude *settings* change: editing a prelude file and
      // reconfiguring which files are the prelude have identical consequences, and this path used
      // to do strictly less — leaving the completion vocabulary and the property reserved-name set
      // stale, so a new prelude unit neither completed nor blocked a property from shadowing it.
      this.markPreludeDirty();
    }
  }

  /**
   * Follow moves and renames of prelude files: when a configured prelude path matches the file's
   * old path, rewrite it to the new path so the plugin keeps finding it, then reload and refresh an
   * open settings tab. A rename that touches no prelude file is treated as an ordinary change.
   */
  private onVaultRename(newPath: string, oldPath: string): void {
    let updated = false;

    for (const file of this.settings.preludeFiles) {
      if (file.path.trim() === "") {
        continue;
      }

      const normalized = normalizePath(file.path);
      if (normalized === oldPath) {
        file.path = newPath;
        updated = true;
      } else if (normalized.startsWith(`${oldPath}/`)) {
        // A containing folder was moved/renamed; rewrite just the path prefix.
        file.path = newPath + normalized.slice(oldPath.length);
        updated = true;
      }
    }

    if (updated) {
      void this.saveSettings();
      this.markPreludeDirty();
      this.settingTab.refresh();
    } else {
      this.onVaultChange(newPath);
      this.onVaultChange(oldPath);
    }
  }

  // INVALIDATION
  // ==============================================================================================

  /**
   * Mark the cached prelude stale — because the prelude settings changed, or because one of its
   * files was edited — and rebuild everything derived from it.
   *
   * The prelude is baked into every interpreter context, so this is the widest invalidation the
   * plugin performs: the completion context and vocabulary, the property reserved-name set (without
   * which a note property can silently shadow a newly-declared prelude unit), and every open
   * editor's hints and inline results. `refreshNoteScope` covers the scope inspector too.
   */
  markPreludeDirty(): void {
    this.prelude.invalidate();
    invalidateExpressionCompletion();
    invalidateReservedNames();
    this.refreshNoteScope();

    // Re-check whether an open `.nbt` file is (still) a prelude file, and whether its banner should
    // still report a prelude error.
    this.forEachFileView((view) => view.refreshBanner());
  }

  /**
   * Re-evaluate every open editor after something note-scope-wide changed — a property-type
   * (re)assignment or a Note properties setting. Rebuilding the inlay and inline-eval extensions
   * recreates their view plugins, whose fresh caches then key off the new preamble; rendered views
   * refresh on their next render as usual.
   */
  refreshNoteScope(): void {
    // The property widgets' evaluated outcomes are keyed on the scope they were evaluated in, and
    // this is exactly the event that says that scope has moved (properties/type.ts).
    clearPropertyOutcomes();
    this.refreshInlayHints();
    this.refreshInlineEval();
    this.refreshScopeViews();

    // The hover's definition tree is keyed on the note's text, which has not changed — but what its
    // scope contains has.
    invalidateDefinitions();
  }

  /**
   * Nudge every open Markdown editor to recompute its Numbat decorations, without rebuilding the
   * extensions (so caches survive — only the notes whose cross-note imports actually moved
   * re-evaluate, and unaffected panes do not flicker). Called when an imported note changes (see
   * the module graph). A plain effect dispatch, unlike `updateOptions()`, also repaints an inactive
   * split.
   */
  private refreshImportDependents(): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!(leaf.view instanceof MarkdownView)) {
        return;
      }
      const view = (leaf.view.editor as unknown as { cm?: EditorView; }).cm;
      if (view !== undefined) {
        refreshNumbatInlays(view);
        refreshNumbatInline(view);
      }
    });
  }

  // THE USER PRELUDE
  // ==============================================================================================

  /**
   * The configured prelude files as normalized, de-duplicated, non-empty vault paths — in load
   * order, or empty when custom preludes are disabled.
   */
  private preludeFiles(): string[] {
    return this.preludeFileList().map((file) => file.path);
  }

  /**
   * The configured prelude files as `{ path, label }`, in load order, deduped — label the file's
   * configured name, else its basename. Empty when custom preludes are off. For the scope
   * inspector, which lists the user prelude's definitions.
   */
  preludeFileList(): { path: string; label: string; }[] {
    if (!this.settings.customPrelude) {
      return [];
    }

    const seen = new Set<string>();
    const files: { path: string; label: string; }[] = [];
    for (const entry of this.settings.preludeFiles) {
      const path = normalizePath(entry.path.trim());
      if (entry.path.trim() === "" || seen.has(path)) {
        continue;
      }
      seen.add(path);
      files.push({ path, label: entry.name.trim() || (path.split("/").pop() ?? path) });
    }

    return files;
  }

  /**
   * Reload the user prelude into {@link setUserPrelude} if it is stale. Reads the configured `.nbt`
   * files from the vault and concatenates them in order; a missing or unreadable file is skipped
   * (logged, non-fatal). Called before each interpreter context is built, alongside {@link
   * ensureExchangeRates}.
   *
   * Concurrent callers share one load. Every surface that builds a context awaits this first, and a
   * note with both a `numbat` block and a Numbat-typed property starts two of them at once:
   * clearing the dirty flag before the vault reads would let the second caller return to a prelude
   * that had not been applied yet, and the empty-scope result it then cached would stick.
   */
  async ensurePrelude(): Promise<void> {
    await this.prelude.ensure();
  }

  /** Read and apply the configured prelude files. Only {@link VersionedLoad} calls this, one pass
   *  at a time. */
  private async loadPrelude(): Promise<void> {
    const files = this.preludeFiles();
    if (files.length === 0) {
      setUserPrelude(null);
      return;
    }
    const { adapter } = this.app.vault;

    // Kept per file, in load order: a context for one prelude file replays only the files ahead of
    // it (see createContext's `preludeBefore`), which the `.nbt` editor needs and a pre-joined
    // string cannot express.
    const parts: PreludePart[] = [];
    for (const path of files) {
      try {
        if (await adapter.exists(path)) {
          parts.push({ path, source: await adapter.read(path) });
        } else {
          console.error(`Symbat: user prelude file not found: ${path}`);
        }
      } catch (error) {
        console.error(`Symbat: failed to read user prelude file: ${path}`, error);
      }
    }

    setUserPrelude(parts);
  }

  // OPEN VIEWS AND EDITOR SETTINGS
  // ==============================================================================================

  /** Run a callback for each open REPL view (used to push live setting changes). */
  private forEachReplView(fn: (view: NumbatReplView) => void): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_NUMBAT_REPL)) {
      const { view } = leaf;
      if (view instanceof NumbatReplView) {
        fn(view);
      }
    }
  }

  /** Run a callback for each open `.nbt` file editor. */
  private forEachFileView(fn: (view: NumbatFileView) => void): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_NUMBAT_FILE)) {
      const { view } = leaf;
      if (view instanceof NumbatFileView) {
        fn(view);
      }
    }
  }

  /**
   * Whether Obsidian's own "Vim key bindings" editor setting is on, read through the undocumented
   * `getConfig("vimMode")` (a missing API reads as off). The `.nbt` editor follows it directly: it
   * is a file you edit, so it should behave like every other editor in the app — unlike the REPL,
   * which is a tool panel and has its own three-way setting layered over this (see {@link
   * resolveReplVim}).
   */
  vimModeEnabled(): boolean {
    return this.editorConfig("vimMode") === true;
  }

  /** Whether Obsidian's own "Show line number" editor setting is on. The `.nbt` editor follows it
   *  for the same reason it follows Vim: it is an editor in this app, and should look like the
   *  others. */
  lineNumbersEnabled(): boolean {
    return this.editorConfig("showLineNumber") === true;
  }

  /** One of Obsidian's editor settings, through the undocumented `getConfig` (a missing API reads
   *  as unset, so every caller degrades to "off"). */
  private editorConfig(key: string): unknown {
    const config = this.app.vault as unknown as { getConfig?: (key: string) => unknown; };
    return config.getConfig?.(key);
  }

  /** Run a callback for each open scope inspector view. */
  private forEachScopeView(fn: (view: NumbatScopeView) => void): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_NUMBAT_SCOPE)) {
      const { view } = leaf;
      if (view instanceof NumbatScopeView) {
        fn(view);
      }
    }
  }

  /** Rebuild every open scope inspector (after an import, property-type, or scope setting change).
   */
  refreshScopeViews(): void {
    this.forEachScopeView((view) => view.requestRefresh());
  }

  /** Forward a caret move to every open scope inspector (from the cursor listener). */
  reportCursor(path: string, line: number): void {
    this.forEachScopeView((view) => view.onCursor(path, line));
  }

  // LIVE RECONFIGURATION
  // ==============================================================================================

  /** Re-apply the configured REPL font sizes to every open REPL view. */
  refreshReplFont(): void {
    this.forEachReplView((view) => view.applyFont());
  }

  /** Re-apply the live-highlighting setting to every open REPL view. */
  refreshReplHighlight(): void {
    this.forEachReplView((view) => view.applyHighlight());
  }

  /** Re-apply the resolved Vim-mode setting to every open REPL view, and Obsidian's own to every
   *  open `.nbt` editor (which follows it directly). */
  refreshReplVim(): void {
    this.forEachReplView((view) => view.applyVim());
    this.forEachFileView((view) => view.applyVim());
  }

  /** Re-apply the configured Tab indent width to every open `.nbt` editor. Nothing to do on load:
   *  the editor reads the setting as it is built. */
  refreshIndentWidth(): void {
    this.forEachFileView((view) => view.applyIndentWidth());
  }

  /**
   * Apply the inlay-hint settings to every open editor: rebuild the registered extension (present
   * only when `inlayHints` is on, and reading the sub-toggles live) and flush the change to all
   * editors via `updateOptions()`. Called on load and whenever an inlay setting changes.
   */
  refreshInlayHints(): void {
    this.inlayExtension.length = 0;
    if (this.settings.inlayHints) {
      this.inlayExtension.push(numbatInlayHints(this));
    }
    this.app.workspace.updateOptions();

    // The REPL input hosts its own inlay hint (the incomplete-expression one) and a `.nbt` editor
    // its whole-document ones, so push the change to those views too.
    this.forEachReplView((view) => view.applyInlayHints());
    this.forEachFileView((view) => view.applyInlayHints());
  }

  /**
   * Apply the hover settings to every open editor: rebuild the registered extension (empty when
   * hover is off — the two triggers and the delay are baked in when it is built) and re-map the Vim
   * normal-mode key. Called on load and whenever a hover setting changes.
   */
  refreshHover(): void {
    // Close anything open first: rebuilding replaces the mouse tooltip's own state field, and a
    // tooltip still in flight across that swap is how CodeMirror comes to read a field its state no
    // longer has.
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!(leaf.view instanceof MarkdownView)) {
        return;
      }
      const view = (leaf.view.editor as unknown as { cm?: EditorView; }).cm;
      if (view !== undefined) {
        dismissHover(view);
      }
    });

    this.hoverExtension.length = 0;
    if (this.settings.hover) {
      this.hoverExtension.push(noteHoverExtension(this));
    }
    this.app.workspace.updateOptions();

    if (this.settings.hover) {
      mapVimHoverKey(this.settings.hoverVimKey.trim(), (view) => showHoverAtCursor(view));
    } else {
      unmapVimHoverKey();
    }

    // The REPL input, the property fields and the `.nbt` editor build their own.
    this.forEachReplView((view) => view.applyHover());
    this.forEachFileView((view) => view.applyHover());
  }

  /**
   * Apply the inline-evaluation setting to every open editor: rebuild the registered extension
   * (present only when `inlineEval` is on, and reading the prefixes live) and flush the change via
   * `updateOptions()`. Called on load and whenever an inline-evaluation setting changes.
   */
  refreshInlineEval(): void {
    this.inlineEvalExtension.length = 0;

    if (this.settings.inlineEval) {
      this.inlineEvalExtension.push(numbatInlineEval(this));
    }

    this.app.workspace.updateOptions();
  }

  // COMMITTING INLINE RESULTS
  // ==============================================================================================

  /**
   * Commit every *live* inline evaluation currently within the editor's viewport, replacing each ``
   * n`expr` `` span with its computed plain text (`expr = value` or just `value`, per the
   * retain-expression setting) in a single edit. Errors and off-screen spans are left untouched.
   */
  private async commitVisibleInline(view: EditorView): Promise<void> {
    try {
      await ensureNumbatReady();
      await this.ensureExchangeRates();
      await this.ensurePrelude();
    } catch (error) {
      console.error("Symbat: could not start the interpreter to commit inline results", error);
      new Notice("Symbat: couldn't start the interpreter.");
      return;
    }

    if (!isNumbatReady()) {
      return;
    }

    const config = inlineConfig(this);
    const { doc } = view.state;
    primeReservedNames(this.settings.fetchExchangeRates);
    const units = scanNote(doc.iterLines(1, doc.lines + 1), config);

    // The source path is what attaches `numbat-use` imports; without it this pass would evaluate in
    // a narrower scope than the widgets it is committing, and silently skip every span that depends
    // on an import.
    const preamble = notePreamble(this, frontmatterBody(doc.iterLines(1, doc.lines + 1)), sourcePathOf(view));
    let results;
    try {
      results = evaluateNoteUnits(units, this.settings.fetchExchangeRates, config, preamble);
    } catch (error) {
      console.error("Symbat: inline evaluation crashed while committing", error);
      restartNumbat();
      new Notice("Symbat: evaluation failed.");
      return;
    }

    const changes: { from: number; to: number; insert: string; }[] = [];
    let inlineIndex = -1;
    for (const unit of units) {
      if (unit.kind !== "inline") {
        continue;
      }
      inlineIndex += 1;
      if (unit.span.variant !== "live" || unit.line + 1 > doc.lines) {
        continue;
      }
      const line = doc.line(unit.line + 1);
      const from = line.from + unit.span.prefixStart;
      const to = line.from + unit.span.closeEnd;
      const onScreen = view.visibleRanges.some((range) => from <= range.to && to >= range.from);
      const result = results[inlineIndex];
      // Only committable values: a binding's hint is informational (committing it would delete the
      // definition), and errors/holes have nothing to write.
      if (!onScreen || result === undefined || result.kind !== "value" || result.plain === null) {
        continue;
      }
      changes.push({ from, to, insert: commitText(unit.span.expr, result.plain, this.settings.inlineEvalRetainExpr) });
    }

    if (changes.length === 0) {
      new Notice("Symbat: no inline results to commit here.");
      return;
    }

    view.dispatch({ changes });
  }

  // COMMANDS AND VIEW ACTIVATION
  // ==============================================================================================

  /**
   * Whether the REPL input should enable Vim key bindings: forced on/off by the `replVimMode`
   * setting, or — when set to "match" — following Obsidian's own "Vim key bindings" editor setting.
   * That setting is read through the undocumented `getConfig("vimMode")`, defensively (a missing
   * API reads as off).
   */
  resolveReplVim(): boolean {
    const mode = this.settings.replVimMode;

    if (mode === "on") {
      return true;
    }
    if (mode === "off") {
      return false;
    }

    const config = this.app.vault as unknown as { getConfig?: (key: string) => unknown; };
    return config.getConfig?.("vimMode") === true;
  }

  /**
   * Create an empty `.nbt` file in `folder` (the vault root when null) and open it. The name is
   * `Untitled`, suffixed if that is taken — matching how Obsidian names a new note. Without this
   * there is no way to make a Numbat file from inside Obsidian at all: its "New note" only ever
   * creates Markdown.
   */
  private async createNumbatFile(folder: TFolder | null): Promise<void> {
    const dir = folder === null || folder.isRoot() ? "" : `${folder.path}/`;

    let path = normalizePath(`${dir}Untitled.nbt`);
    for (let n = 1; this.app.vault.getAbstractFileByPath(path) !== null; n += 1) {
      path = normalizePath(`${dir}Untitled ${n}.nbt`);
    }

    try {
      const file = await this.app.vault.create(path, "");
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (error) {
      console.error("Symbat: could not create a Numbat file", error);
      new Notice("Symbat: couldn't create the file.");
    }
  }

  /** Reveal the REPL view, reusing an existing leaf or opening one in the right sidebar. */
  async activateReplView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_NUMBAT_REPL);
    let leaf: WorkspaceLeaf | null;

    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) {
        return;
      }
      await leaf.setViewState({ type: VIEW_TYPE_NUMBAT_REPL, active: true });
    }

    await workspace.revealLeaf(leaf);
  }

  /** Reveal the scope inspector, reusing an existing leaf or opening one in the right sidebar. */
  async activateScopeView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_NUMBAT_SCOPE);
    let leaf: WorkspaceLeaf | null;

    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) {
        return;
      }
      await leaf.setViewState({ type: VIEW_TYPE_NUMBAT_SCOPE, active: true });
    }

    await workspace.revealLeaf(leaf);
  }

  // EXCHANGE RATES
  // ==============================================================================================

  /**
   * Ensure live exchange rates reflect the current setting: when enabled, seed the cache from disk
   * (once), (re)fetch if the cache is older than the configured refresh frequency — giving up after
   * the configured timeout and falling back to the cache — and persist a fresh fetch to disk. When
   * disabled, drop the rates. Called on interpreter use.
   */
  async ensureExchangeRates(): Promise<void> {
    // The rates are baked into every context, so a change to them invalidates every cached
    // evaluation in the vault. The interpreter reports that as a bumped generation; comparing it
    // here covers both the setting being toggled and a scheduled refetch hours into a session,
    // which no setting effect could catch.
    const before = interpreterGeneration();
    if (!this.settings.fetchExchangeRates) {
      clearExchangeRates();
    } else {
      await this.seedExchangeRatesCache();

      const load = await loadExchangeRates(
        this.settings.exchangeRateRefreshHours * 60 * 60 * 1000,
        this.settings.exchangeRateTimeoutSeconds * 1000,
      );

      if (load.fetched !== null) {
        await this.writeExchangeRatesCache(load.fetched);
      }
    }

    if (interpreterGeneration() !== before) {
      // Safe to call from inside an in-flight evaluation: rebuilding the extensions destroys the
      // running view plugin, which checks `destroyed` after each await.
      this.refreshNoteScope();
    }
  }

  /** The vault path of the on-disk exchange-rate cache (inside the plugin folder), or `null` if the
   *  plugin directory is unknown. */
  private exchangeRatesCachePath(): string | null {
    const dir = this.manifest.dir;
    return dir != null && dir !== "" ? normalizePath(`${dir}/exchange-rates.xml`) : null;
  }

  /** Read the on-disk exchange-rate cache into memory, once, so conversions work offline before the
   *  first successful fetch. Missing/unreadable is non-fatal. */
  private async seedExchangeRatesCache(): Promise<void> {
    if (this.exchangeRatesSeeded) {
      return;
    }
    this.exchangeRatesSeeded = true;

    const path = this.exchangeRatesCachePath();
    if (path === null) {
      return;
    }

    try {
      const { adapter } = this.app.vault;
      if (await adapter.exists(path)) {
        primeExchangeRatesCache(await adapter.read(path));
      }
    } catch (error) {
      console.error("Symbat: failed to read cached exchange rates", error);
    }
  }

  /** Persist freshly fetched exchange rates to the plugin folder, as the fallback for a future
   *  fetch that times out or fails. Write failures are non-fatal. */
  private async writeExchangeRatesCache(xml: string): Promise<void> {
    const path = this.exchangeRatesCachePath();
    if (path === null) {
      return;
    }

    try {
      await this.app.vault.adapter.write(path, xml);
    } catch (error) {
      console.error("Symbat: failed to cache exchange rates", error);
    }
  }

  // SETTINGS
  // ==============================================================================================

  /** Load persisted settings, filling in defaults for any missing keys. */
  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as (Record<string, unknown> | null);

    // Not a plain merge over the defaults: a persisted value can be out of range, the wrong type,
    // or `null` — see `normalizeSettings`, which is what actually enforces the bounds the controls
    // declare.
    this.settings = normalizeSettings(loaded);

    // Normalize the prelude list into a fresh, well-formed array (migrating the earlier
    // `preludePaths` shape); `Object.assign` would otherwise alias the shared
    // `DEFAULT_SETTINGS.preludeFiles` and later mutations would touch it.
    this.settings.preludeFiles = normalizePreludeFiles(loaded?.preludeFiles, loaded?.preludePaths);
  }

  /** Persist the current settings to Obsidian's plugin data. */
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
