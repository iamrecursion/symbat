// The note scope inspector: a right-sidebar panel listing every binding the active note sees —
// cross-note imports, frontmatter properties (and the ones skipped, and why), `numbat` /
// `numbat-shared` blocks, and inline `let` spans — as a hierarchical, collapsible tree, each
// binding with its evaluated value and a jump-to-definition. Everything is collapsed by default
// except the node the caret sits in, which auto-expands and follows the caret live.
//
// The view is the only stateful piece: the aggregation (scope/model.ts), the value probing
// (scope/eval.ts), and the vault bridge (scope/source.ts) around it are all separately testable.

import {
  ItemView,
  MarkdownView,
  Platform,
  prepareFuzzySearch,
  SearchComponent,
  setIcon,
  TFile,
  type WorkspaceLeaf,
} from "obsidian";
import type { CompletionVocabulary } from "../completion/expressions";
import { buildDocPopupContent, DocPopup, renderExprSuggestion } from "../completion/render";
import {
  completionInfo,
  completionSignature,
  ensureExpressionContext,
  ensureNumbatReady,
  getExpressionVocabulary,
  type Numbat,
  touchCompletionIdle,
} from "../interpreter/numbat";
import { setNumbatHtml } from "../interpreter/render";
import type SymbatPlugin from "../main";
import { jumpToDefinition } from "../scope/goto-definition";
import {
  currentNodePath,
  declarationHeadHtml,
  isActiveLine,
  scopeEntries,
  type ScopeEntry,
  type ScopeNode,
  type ScopeTree,
  type ScopeValue,
  type SkipEntry,
} from "../scope/model";
import {
  rankSearchCandidates,
  scopeSearchCandidates,
  type SearchCandidate,
  type SearchHit,
  searchRowKey,
} from "../scope/search";
import { evaluateScope, gatherDocumentScope, gatherScope } from "../scope/source";
import { COMPLETION_DWELL_MS, SCOPE_VALUE_CACHE_ENTRIES } from "../tuning";
import { KEYBOARD_EVENTS, keyboardHeightOf } from "./mobile-keyboard";

/** Persisted in the vault's `workspace.json` — see the note on `VIEW_TYPE_NUMBAT_FILE` in
 *  views/nbt.ts. Renaming it orphans open inspector panes. */
export const VIEW_TYPE_NUMBAT_SCOPE = "numbat-scope";

/** Debounce for rebuilding after an edit / note switch (ms). */
const REFRESH_DELAY = 150;

/** Debounce between a keystroke in the search box and re-ranking (ms). Ranking itself is cheap;
 *  this batches the tree repaint a selection change triggers. */
const QUERY_DELAY = 50;

/** How many result rows to draw. Ranking covers every match — this only bounds the DOM (and the
 *  `type()` lookups the bundled-prelude rows need); the remainder is reported rather than dropped
 *  silently. */
const MAX_RESULT_ROWS = 25;

/** The gap left between the search bar and the soft keyboard (px), matching the REPL's input row
 *  (see {@link NumbatScopeView.trackSoftKeyboard}). */
const KEYBOARD_GAP_PX = 8;

/** The `: ` a scope type fragment opens with (see scope-eval's `COLON_SPAN`). The shared
 *  `.numbat-signature` styling supplies its own, so it is stripped before a type is reused as a
 *  completer-style signature. */
const LEADING_COLON = /^\s*<span class="numbat-operator">:<\/span>\s*/;

/**
 * The scope inspector: a sidebar panel showing everything in the active note's Numbat scope — its
 * imports, frontmatter bindings, blocks, inline spans and the user prelude — with each binding's
 * evaluated value, and a search over both those bindings and the interpreter's builtins.
 *
 * Structure is rebuilt on every refresh; values are cached against the tree's signature, so an edit
 * that cannot change what a binding evaluates to does not re-run the interpreter.
 */
export class NumbatScopeView extends ItemView {
  /** Read for settings, the prelude, and the vault; also the source of the tree. */
  private readonly plugin: SymbatPlugin;
  /** The container the tree rows are rendered into. Definitely assigned in {@link onOpen}, which
   *  Obsidian calls before anything can reach the view. */
  private treeEl!: HTMLElement;

  /** The note currently displayed, or null when none is. */
  private currentPath: string | null = null;

  /** The current note's scope tree (structure + any filled values), or null. */
  private tree: ScopeTree | null = null;

  /** The caret's 0-indexed line in the current note, or null (not in its editor). */
  private caretLine: number | null = null;

  /** The id of the node the caret is in — always highlighted, and force-expanded and scrolled to
   *  while revealing is on. */
  private currentId: string | null = null;

  /** The current node's ancestors, itself included — a nested node is only visible if every node
   *  containing it is expanded too. */
  private currentTrail: Set<string> | null = null;

  /** Whether the interpreter was ready last refresh (else values are absent). */
  private wasmReady = true;

  /** Per-node expansion overrides (a header click); while revealing, the caret still force-expands
   *  its node. Keyed by the stable node id so it survives a refresh. */
  private readonly expanded = new Map<string, boolean>();

  /** Cached values by tree signature (values only — structure is always rebuilt). */
  private readonly valueCache = new Map<string, (ScopeValue | undefined)[]>();

  /** Whether the caret's node is revealed — force-expanded and scrolled to (the "reveal active
   *  line" toggle). The highlight follows the caret either way. */
  private trackCursor = true;

  /** The reveal toggle button, so its active state can be re-styled. */
  private trackButtonEl: HTMLElement | null = null;

  /** Who the next render should scroll to. Two things want to scroll the tree — the caret and the
   *  search selection — so the owner is explicit rather than a flag. */
  private pendingReveal: "caret" | "search" | null = null;

  /** The pending debounced refresh, or `null` when none is scheduled. */
  private refreshTimer: number | null = null;

  /** Bumped on each refresh; a stale async refresh checks it and bails. */
  private generation = 0;

  // SEARCH STATE
  // ==============================================================================================

  /** The results list and the query field, both pinned below the tree. */
  private resultsEl!: HTMLElement;

  /** Obsidian's search component wrapping the query field. */
  private searchEl!: SearchComponent;

  /** The query field itself, for focus and key handling the component does not expose. */
  private inputEl!: HTMLInputElement;

  /** The selected result's row key, and the node ids that must be force-expanded to reveal it. Held
   *  *outside* `expanded` so clearing the query restores the tree exactly as the user had it. */
  private searchKey: string | null = null;

  /** The node ids to force-expand so {@link searchKey}'s row is visible. */
  private searchTrail: Set<string> | null = null;

  /** The current query's matches, best first. */
  private hits: SearchHit[] = [];

  /** Index into {@link hits} of the highlighted result. */
  private selected = 0;

  /** Candidates, and the tree/vocabulary they were built from — rebuilt only when one of those
   *  changes, not per keystroke. */
  private candidates: SearchCandidate[] | null = null;

  /** The tree {@link candidates} was built from; a different one rebuilds them. */
  private candidateTree: ScopeTree | null = null;

  /** The builtin vocabulary {@link candidates} was built from. */
  private candidateVocab: CompletionVocabulary | null = null;

  /** Whether a bundled-prelude vocabulary load is in flight. */
  private loadingVocab = false;

  /** The rendered tree rows by stable key, for revealing a search hit. Rebuilt each render; keys
   *  (not entry objects) because a refresh replaces every entry. */
  private readonly rows = new Map<string, { el: HTMLElement; entry: ScopeEntry | null; }>();

  /** The shared floating documentation popup, shown on dwell. */
  private readonly docPopup = new DocPopup();

  /** The pending dwell before the documentation popup opens. */
  private dwellTimer: number | null = null;

  /** The result whose docs are showing or pending, so the same row is not re-armed. */
  private dwellIndex: number | null = null;

  /** The pending debounced re-query, so typing a word scores the candidates once. */
  private queryTimer: number | null = null;

  /** Height (CSS px) of the soft keyboard from Obsidian's mobile keyboard events; `0` while it is
   *  closed (see {@link trackSoftKeyboard}). */
  private keyboardHeight = 0;

  // LIFECYCLE
  // ==============================================================================================

  /** @param leaf the workspace leaf to mount in. @param plugin the plugin to read. */
  constructor(leaf: WorkspaceLeaf, plugin: SymbatPlugin) {
    super(leaf);
    this.plugin = plugin;

    // A tool panel, not a file-backed document (see the REPL view): don't let the shell try to
    // resolve an active file for it.
    this.navigation = false;
  }

  /** Obsidian's identifier for this view type. */
  getViewType(): string {
    return VIEW_TYPE_NUMBAT_SCOPE;
  }

  /** The tab title. */
  getDisplayText(): string {
    return "Symbat inspector";
  }

  /** The tab icon. */
  getIcon(): string {
    return "list-tree";
  }

  /** Build the panel's DOM and subscribe to the workspace events that drive it. */
  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("numbat-scope-inspector");
    this.addAction("rotate-ccw", "Refresh", () => this.requestRefresh());
    this.buildControls(root);
    this.treeEl = root.createDiv({ cls: "numbat-scope-tree" });
    this.buildSearch(root);

    // One delegated listener per container rather than one per row: the tree is re-rendered on
    // every caret move, and `registerDomEvent` holds each listener (and so each detached row) for
    // the view's lifetime.
    this.registerDomEvent(this.treeEl, "click", (event) => this.onTreeClick(event));
    this.registerDomEvent(this.treeEl, "scroll", () => this.cancelDwell());

    // The popup is a `document.body` child, so it survives anything that happens to this view
    // unless taken down explicitly. Switching note or pane is the clearest case: whatever it
    // described is no longer what is on screen. Dismissed here rather than in the (debounced)
    // refresh so it goes at once.
    this.registerEvent(this.app.workspace.on("file-open", () => {
      this.cancelDwell();
      this.requestRefresh();
    }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      this.cancelDwell();
      this.requestRefresh();
    }));
    this.watchVisibility();
    this.trackSoftKeyboard();
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file.path === this.currentPath) {
        this.requestRefresh();
      }
    }));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      if (file.path === this.currentPath) {
        this.requestRefresh();
      }
    }));

    this.requestRefresh();
  }

  /** Release everything the view holds: its three timers, the documentation popup, and the rendered
   *  rows. */
  async onClose(): Promise<void> {
    for (const timer of [this.refreshTimer, this.queryTimer, this.dwellTimer]) {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    }

    this.refreshTimer = null;
    this.queryTimer = null;
    this.dwellTimer = null;

    // The popup lives under `document.body`, so it outlives the panel otherwise.
    this.docPopup.destroy();
  }

  // BUILDING THE PANEL
  // ==============================================================================================

  /** The row of controls pinned above the tree: expand all, collapse all, and the
   *  reveal-active-line toggle. */
  private buildControls(root: HTMLElement): void {
    const controls = root.createDiv({ cls: "numbat-scope-controls" });
    const button = (icon: string, label: string, onClick: () => void): HTMLElement => {
      const el = controls.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
      setIcon(el, icon);
      this.registerDomEvent(el, "click", onClick);
      return el;
    };

    button("chevrons-up-down", "Expand all", () => this.setAllExpanded(true));
    button("chevrons-down-up", "Collapse all", () => this.setAllExpanded(false));
    this.trackButtonEl = button("locate-fixed", "Reveal active line", () => this.toggleTrackCursor());
    this.trackButtonEl.toggleClass("is-active", this.trackCursor);
  }

  /** The results list and the query input, pinned below the tree. Results grow upward from the
   *  input, compressing the tree rather than covering it, so a selection can be watched revealing
   *  itself above. */
  private buildSearch(root: HTMLElement): void {
    this.resultsEl = root.createDiv({ cls: "numbat-scope-results" });
    const bar = root.createDiv({ cls: "numbat-scope-searchbar" });
    const icon = bar.createSpan({ cls: "numbat-scope-search-icon" });
    setIcon(icon, "search");

    // Obsidian's own search field, so the clear button looks and behaves like every other one in
    // the app (and is themed with them).
    const search = new SearchComponent(bar);
    search.setPlaceholder("Search scope and prelude…");
    search.inputEl.setAttr("aria-label", "Search the Numbat scope");
    this.searchEl = search;
    this.inputEl = search.inputEl;
    search.onChange(() => this.requestQuery());

    // The clear button empties the field itself; take the query down with it and hand focus back,
    // so clearing leaves the box ready to type in again.
    this.registerDomEvent(search.clearButtonEl, "click", () => {
      this.clearSearch();
      this.inputEl.focus();
    });

    // Anything that takes focus out of the field puts the documentation away — clicking the note,
    // the tree, another pane, another sidebar tab. Only the popup goes: the results stay, so a
    // click that lands on a result still chooses it (blur runs first, then the click, which
    // re-opens the docs if it needs to).
    this.registerDomEvent(this.inputEl, "blur", () => this.cancelDwell());

    // A popup is positioned against a row's rectangle, so scrolling either list strands it
    // somewhere meaningless.
    this.registerDomEvent(this.resultsEl, "scroll", () => this.cancelDwell());
    this.registerDomEvent(this.inputEl, "keydown", (event) => this.onSearchKey(event));
    this.registerDomEvent(this.resultsEl, "click", (event) => this.onResultClick(event));

    // Hovering previews the docs but deliberately does not move the selection: selection reflows
    // the tree, and mouse drift should not do that.
    this.registerDomEvent(this.resultsEl, "mouseover", (event) => this.onResultHover(event));

    // Only the pending timer is dropped when the pointer leaves, not a popup already open: reaching
    // its reference link means leaving the list, and tearing the popup down on the way would make
    // the link unclickable. Any selection or query change replaces it, and Escape closes it.
    this.registerDomEvent(this.resultsEl, "mouseleave", () => {
      if (this.dwellTimer !== null) {
        window.clearTimeout(this.dwellTimer);
        this.dwellTimer = null;
      }
    });
  }

  /**
   * Put the documentation away whenever the panel itself stops being visible.
   *
   * The blur handler covers everything the user drives from the field, but the popup can also be
   * opened by hovering a result without ever focusing it — and then collapsing the sidebar, or
   * switching to another tab in it, leaves the popup floating over an unrelated pane (Obsidian
   * hides an inactive tab's content rather than closing the view, so no workspace event reliably
   * says "you are gone"). Observing visibility catches all of those at once, including the
   * hidden-tab case that `active-leaf-change` misses.
   */
  private watchVisibility(): void {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => !entry.isIntersecting)) {
        this.cancelDwell();
      }
    });

    observer.observe(this.contentEl);
    this.register(() => observer.disconnect());
  }

  /**
   * Hold the search bar just above the soft keyboard.
   *
   * On mobile the view's bottom padding is what lifts the bar clear of things: at rest Obsidian
   * sizes it to reserve the floating view-selector pill, and when the keyboard opens it grows to
   * cover the keyboard *plus* that pill — which is the dead space between the bar and the keys. So
   * while the keyboard is up this replaces the padding with the measured overlap (plus a small gap,
   * matching the REPL's input row), and on hide it removes the override, handing the pill's
   * reservation back.
   *
   * The overlap is the REPL's calculation (`syncBottomInset`), but applied to *this* element's
   * padding rather than added underneath Obsidian's — stacking the two is what made earlier
   * attempts overshoot.
   *
   * Driven by the Capacitor keyboard events Obsidian's mobile shell dispatches on `window`, whose
   * reported height is authoritative; its iOS WebView overlays the keyboard without shrinking the
   * visual viewport, and that viewport is a little shorter than `window.innerHeight` on mobile
   * anyway, so it cannot be used to detect a keyboard here.
   */
  private trackSoftKeyboard(): void {
    if (!Platform.isMobile) {
      return; // desktop zeroes this padding in CSS; there is no keyboard to dodge
    }

    for (const [name, open] of KEYBOARD_EVENTS) {
      const handler = (evt: Event): void => {
        this.keyboardHeight = open ? keyboardHeightOf(evt) : 0;
        this.syncKeyboardPadding();
      };
      window.addEventListener(name, handler);
      this.register(() => window.removeEventListener(name, handler));
    }

    // The overlap depends on the view's own rectangle, so re-measure when that moves.
    this.registerEvent(this.app.workspace.on("resize", () => this.syncKeyboardPadding()));
  }

  /** Pad the panel so the soft keyboard cannot cover its last rows. Recomputed whenever the
   *  keyboard or the view's own rectangle moves; a no-op on desktop, where the keyboard height
   *  stays zero. */
  private syncKeyboardPadding(): void {
    const el = this.contentEl;
    if (this.keyboardHeight <= 0) {
      el.style.removeProperty("padding-bottom");
      return;
    }

    const keyboardTop = window.innerHeight - this.keyboardHeight;
    const overlap = Math.max(0, Math.round(el.getBoundingClientRect().bottom - keyboardTop));
    el.style.paddingBottom = `${overlap + KEYBOARD_GAP_PX}px`;
  }

  /** Focus the query box (the plugin's "search the scope" command). */
  focusSearch(): void {
    this.inputEl?.focus();
    this.inputEl?.select();
  }

  // EXPANSION AND TRACKING
  // ==============================================================================================

  /** Every node id in the current tree, for the expand/collapse-all controls. */
  private allNodeIds(): string[] {
    const ids: string[] = [];
    const walk = (nodes: ScopeNode[]): void => {
      for (const node of nodes) {
        ids.push(node.id);
        walk(node.children);
      }
    };

    if (this.tree !== null) {
      walk(this.tree.nodes);
    }

    return ids;
  }

  /** Expand or collapse every node at once (the panel's two header actions). */
  private setAllExpanded(value: boolean): void {
    for (const id of this.allNodeIds()) {
      this.expanded.set(id, value);
    }
    this.renderTree();
  }

  /** Flip "reveal active line" and re-render, so the caret's node is force-expanded and scrolled to
   *  — or stops being. */
  private toggleTrackCursor(): void {
    this.trackCursor = !this.trackCursor;
    this.trackButtonEl?.toggleClass("is-active", this.trackCursor);

    // Re-picking the caret's node when turning revealing back on expands and scrolls to it
    // immediately, rather than waiting for the next cursor move.
    if (this.trackCursor && this.currentPath !== null && this.tree !== null) {
      this.caretLine = this.caretLineFor(this.currentPath);
      this.setCurrent(this.tree, this.caretLine);
      this.pendingReveal = "caret";
    }

    this.renderTree();
  }

  // REFRESHING
  // ==============================================================================================

  /** Rebuild on the next tick (coalescing a burst of events). Public so the plugin can nudge the
   *  view on an import / property-type change. */
  requestRefresh(): void {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, REFRESH_DELAY);
  }

  /** The caret moved in some editor (reported by the plugin's cursor listener). When it is the
   *  current note's, re-pick the current node and repaint expansion — no re-evaluation. */
  onCursor(path: string, line: number): void {
    if (path !== this.currentPath || this.tree === null || line === this.caretLine) {
      return;
    }

    this.caretLine = line;
    const previousTrail = this.currentTrail;
    this.setCurrent(this.tree, line);

    // The highlight always follows the caret, but the *scroll* does not while a search result is
    // selected — the caret only moved as a side effect of jumping there, and yanking the tree back
    // would fight the search.
    this.pendingReveal = this.trackCursor && this.searchKey === null ? "caret" : null;

    // A caret move usually only moves two classes: the current node's and the active row's.
    // Rebuilding the tree for that meant re-parsing and re-sanitising every entry's HTML on every
    // line crossed — holding ArrowDown through a note with a large shared block re-rendered the
    // whole panel per line. The tree is only rebuilt when the *expansion* changes, which is when
    // the chain of containing nodes moves and reveal is on.
    if (this.trackCursor && !sameTrail(previousTrail, this.currentTrail)) {
      this.renderTree();
      return;
    }
    this.repaintCurrentMarkers();
    this.resolveReveal();
  }

  /** Move the "current node" and "active row" classes to wherever the caret is now, without
   *  rebuilding any DOM. */
  private repaintCurrentMarkers(): void {
    for (const { el, entry } of this.rows.values()) {
      el.toggleClass("numbat-scope-current-row", entry !== null && isActiveLine(entry, this.caretLine));
    }

    for (const header of Array.from(this.treeEl.querySelectorAll<HTMLElement>(".numbat-scope-header"))) {
      const id = header.dataset.numbatNode;
      header.parentElement?.toggleClass("numbat-scope-current", id !== undefined && id === this.currentId);
    }
  }

  /** The active file when it has a Numbat scope to show — a note, or a standalone `.nbt` file —
   *  else null. */
  private activeFile(): TFile | null {
    const file = this.app.workspace.getActiveFile();
    return file !== null && (file.extension === "md" || file.extension === "nbt") ? file : null;
  }

  /** The caret line in the given note, if it is open in a pane. Searches every markdown leaf (not
   *  just the active one), so the current node still resolves when the scope panel itself holds
   *  focus. A `.nbt` file reports its own caret through the plugin instead (see {@link onCursor}),
   *  since it is not one. */
  private caretLineFor(path: string): number | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const { view } = leaf;
      if (view instanceof MarkdownView && view.file?.path === path) {
        return view.editor.getCursor().line;
      }
    }

    return path === this.currentPath ? this.caretLine : null;
  }

  /** Rebuild the tree for the active note and render it. Structure is always rebuilt fresh (so
   *  definition lines are current); values come from the cache when the signature is unchanged,
   *  else a fresh off-path evaluation. */
  private async refresh(): Promise<void> {
    const file = this.activeFile();
    const generation = ++this.generation;

    // The tree is about to be rebuilt, so any open popup describes a row that is being replaced
    // underneath it.
    this.cancelDwell();

    if (file === null) {
      this.currentPath = null;
      this.tree = null;

      // The same reset the "a different note" branch below performs: closing the last note is as
      // much a change of scope as switching to another one. Without it the results list kept
      // offering hits in a note that is no longer open, and `rows` retained every (now detached)
      // row element of the previous tree.
      this.endSearchSession();
      this.rows.clear();
      this.renderEmpty("Open a note to see its Numbat scope.");

      return;
    }

    // A `.nbt` file is its own scope — the file's declarations over the prelude loaded before it —
    // rather than a note's frontmatter, blocks and inline spans.
    const isDocument = file.extension === "nbt";
    const { tree, wasmReady } = isDocument
      ? await gatherDocumentScope(this.plugin, file)
      : await gatherScope(this.plugin, file);

    if (generation !== this.generation) {
      return; // a newer refresh started while we awaited
    }

    // Following a result into another note leaves the selection describing a scope that is no
    // longer on screen, so the session ends here. The query text stays, ready to be re-run against
    // the note just opened.
    if (file.path !== this.currentPath) {
      this.endSearchSession();
    }

    this.currentPath = file.path;
    this.tree = tree;
    this.wasmReady = wasmReady;
    this.caretLine = this.caretLineFor(file.path);
    this.setCurrent(tree, this.caretLine);

    if (!tree.empty) {
      const cached = this.valueCache.get(tree.signature);
      if (cached !== undefined) {
        scopeEntries(tree).forEach((entry, index) => {
          entry.value = cached[index];
        });
      } else if (wasmReady) {
        this.wasmReady = evaluateScope(this.plugin, tree, isDocument ? file.path : undefined);
        this.cacheValues(tree.signature, scopeEntries(tree).map((entry) => entry.value));
      }
    }

    this.renderTree();
  }

  /** Remember a tree's evaluated values against its signature, evicting the oldest entries past the
   *  cap. Values are stored positionally, in `scopeEntries` order, since the entry objects
   *  themselves are replaced on every refresh. */
  private cacheValues(signature: string, values: (ScopeValue | undefined)[]): void {
    this.valueCache.set(signature, values);

    while (this.valueCache.size > SCOPE_VALUE_CACHE_ENTRIES) {
      const oldest = this.valueCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }

      this.valueCache.delete(oldest);
    }
  }

  // RENDERING THE TREE
  // ==============================================================================================

  /** Replace the tree with a single explanatory line — no note open, an empty scope, or the
   *  interpreter unavailable. */
  private renderEmpty(message: string): void {
    this.treeEl.empty();
    this.treeEl.createDiv({ cls: "numbat-scope-empty", text: message });
  }

  /** End the search session: the selection describes a scope that is no longer on screen. The query
   *  text stays, ready to be re-run against whatever opens next. */
  private endSearchSession(): void {
    this.hits = [];
    this.selected = 0;
    this.searchKey = null;
    this.searchTrail = null;

    // A caret reported by a `.nbt` editor persists in this field (it has no leaf to read back), so
    // a different file must not inherit the previous one's line.
    this.caretLine = null;
    this.cancelDwell();
    this.resultsEl.empty();
  }

  /** Redraw the whole tree from {@link tree}, rebuilding the row index as it goes. */
  private renderTree(): void {
    const tree = this.tree;
    if (tree === null) {
      // Nothing to draw, but the previous note's rows must still go: whoever set `tree = null`
      // emptied `treeEl`, so every element in `rows` is detached and would otherwise be retained —
      // along with the entries and tree behind it.
      this.rows.clear();
      return;
    }
    this.treeEl.empty();
    this.rows.clear();

    if (tree.empty) {
      this.renderEmpty("No Numbat bindings in this note.");
      return;
    }

    if (!this.wasmReady) {
      this.treeEl.createDiv({ cls: "numbat-scope-banner", text: "Numbat is starting — values will appear shortly." });
    }

    for (const node of tree.nodes) {
      this.renderNode(this.treeEl, node);
    }

    this.resolveReveal();
  }

  /** Scroll whoever owns this render into view: the selected search result, or the active row (or,
   *  when its node is collapsed, that node's header). Only just after the caret moved or the
   *  selection changed, so a plain refresh never yanks the panel away from where the user scrolled
   *  it. */
  private resolveReveal(): void {
    const reveal = this.pendingReveal;
    this.pendingReveal = null;

    if (reveal === "search") {
      const key = this.searchKey;
      if (key !== null) {
        this.rows.get(key)?.el.scrollIntoView({ block: "nearest" });
      }
      return;
    }

    if (reveal === "caret") {
      const target = this.treeEl.querySelector(".numbat-scope-current-row")
        ?? this.treeEl.querySelector(".numbat-scope-current > .numbat-scope-header");
      target?.scrollIntoView({ block: "nearest" });
    }
  }

  /** Record which node the caret is in, and the chain of nodes containing it. */
  private setCurrent(tree: ScopeTree, caretLine: number | null): void {
    const trail = currentNodePath(tree, caretLine);
    this.currentId = trail.length === 0 ? null : trail[trail.length - 1];
    this.currentTrail = trail.length === 0 ? null : new Set(trail);
  }

  /** Whether the caret is in `node` — the "current" node. Highlighting is unconditional: knowing
   *  where you are does not depend on the reveal toggle, which only controls whether the node is
   *  force-expanded and scrolled to. */
  private isCurrent(node: ScopeNode): boolean {
    return this.currentId !== null && node.id === this.currentId;
  }

  /** Whether `node` should be drawn expanded. */
  private isExpanded(node: ScopeNode): boolean {
    // Three sources, none of which writes to the others: revealing force-expands the node the caret
    // is in, a search selection force-expands the chain down to its row, and a header click wins
    // otherwise — defaulting to collapsed. Keeping the search's expansion out of `expanded` is what
    // lets clearing the query restore the tree exactly as the user had arranged it.
    return (this.trackCursor && (this.currentTrail?.has(node.id) ?? false))
      || (this.searchTrail?.has(node.id) ?? false)
      || (this.expanded.get(node.id) ?? false);
  }

  /** Draw one group and, when it is expanded, its entries, skips and child groups. */
  private renderNode(container: HTMLElement, node: ScopeNode): void {
    const nodeEl = container.createDiv({ cls: "numbat-scope-node" });
    if (this.isCurrent(node)) {
      nodeEl.addClass("numbat-scope-current");
    }

    const expanded = this.isExpanded(node);
    if (expanded) {
      nodeEl.addClass("is-expanded");
    }

    const header = nodeEl.createDiv({ cls: "numbat-scope-header" });
    header.dataset.numbatNode = node.id;

    const twisty = header.createSpan({ cls: "numbat-scope-twisty" });
    setIcon(twisty, "chevron-right");

    header.createSpan({ cls: "numbat-scope-label", text: node.label });
    if (node.badge !== null) {
      header.createSpan({ cls: "numbat-scope-badge", text: node.badge });
    }

    // Row keys mirror scope-search's candidate walk exactly, so a hit addresses its row by key —
    // entry objects are replaced wholesale on every refresh.
    const childrenEl = nodeEl.createDiv({ cls: "numbat-scope-children" });
    node.entries.forEach((entry, index) => {
      this.renderEntry(childrenEl, entry, searchRowKey(node.id, "entry", index));
    });
    node.skips.forEach((skip, index) => {
      this.renderSkip(childrenEl, skip, searchRowKey(node.id, "skip", index));
    });

    for (const child of node.children) {
      this.renderNode(childrenEl, child);
    }
  }

  /** Draw one binding's row and index it under `key`, which is what search-reveal and the
   *  `data-numbat-key` attribute both look it up by. */
  private renderEntry(container: HTMLElement, entry: ScopeEntry, key: string): void {
    const row = container.createDiv({ cls: "numbat-scope-row" });
    row.dataset.numbatKey = key;
    this.rows.set(key, { el: row, entry });

    if (entry.shadowed) {
      row.addClass("numbat-scope-shadowed");
    }

    if (isActiveLine(entry, this.caretLine)) {
      row.addClass("numbat-scope-current-row");
    }

    if (key === this.searchKey) {
      row.addClass("numbat-scope-search-row");
    }

    // A `unit` / `dimension` reads as its declaration (`unit U`, keyword-colored); a `let` and a
    // `fn` as a bare name — the `fn` followed by its signature.
    const head = declarationHeadHtml(entry);
    if (head === null) {
      row.createSpan({ cls: "numbat-scope-name", text: entry.label });
    } else {
      setNumbatHtml(row.createSpan({ cls: "numbat-scope-name" }), head);
    }

    // Only a function Numbat could not type still needs a kind marker; every other declaration now
    // says what it is through its head or its signature.
    if (entry.declKind === "fn" && entry.value?.type == null) {
      row.createSpan({ cls: "numbat-scope-kind", text: "fn" });
    }

    if (entry.value?.type != null) {
      setNumbatHtml(row.createSpan({ cls: "numbat-scope-type" }), entry.value.type);
    }

    this.renderValue(row.createSpan({ cls: "numbat-scope-value" }), entry.value);
  }

  /** A click anywhere in the tree: a header toggles its node, a row jumps to its binding. Delegated
   *  — see the listener registration in `onOpen`. */
  private onTreeClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    const row = target?.closest<HTMLElement>("[data-numbat-key]");
    const key = row?.dataset.numbatKey;
    if (key !== undefined) {
      const entry = this.rows.get(key)?.entry;
      if (entry != null) {
        this.jumpTo(entry);
      }
      return;
    }

    const nodeId = target?.closest<HTMLElement>("[data-numbat-node]")?.dataset.numbatNode;
    if (nodeId !== undefined && this.tree !== null) {
      const node = this.findNode(nodeId);
      if (node !== null) {
        this.expanded.set(nodeId, !this.isExpanded(node));
        this.renderTree();
      }
    }
  }

  /** The node with `id` anywhere in the tree, or `null` when it holds none. */
  private findNode(id: string): ScopeNode | null {
    const walk = (nodes: ScopeNode[]): ScopeNode | null => {
      for (const node of nodes) {
        if (node.id === id) {
          return node;
        }

        const found = walk(node.children);
        if (found !== null) {
          return found;
        }
      }

      return null;
    };

    return this.tree === null ? null : walk(this.tree.nodes);
  }

  /** Draw a binding's evaluated value into `el` — its result, a typed-hole placeholder, or an error
   *  summary. Draws nothing when the binding has no value yet, which is the case whenever the
   *  interpreter was unavailable. */
  private renderValue(el: HTMLElement, value: ScopeValue | undefined): void {
    if (value === undefined) {
      return; // not evaluated (wasm not ready)
    }

    if (value.kind === "value" && value.valueHtml !== null) {
      el.createSpan({ cls: "numbat-scope-eq", text: "= " });
      setNumbatHtml(el.createSpan(), value.valueHtml);
    } else if (value.kind === "hole" && value.holeType !== null) {
      el.addClass("numbat-scope-hole");
      el.setText(`⟨${value.holeType}⟩`);
    } else if (value.kind === "error" && value.errorText !== null) {
      el.addClass("numbat-scope-error");
      el.setText(value.errorText);
    }
  }

  /** Draw a skipped property's row — the key and why it bound nothing — and index it under `key` so
   *  search can still reveal it. */
  private renderSkip(container: HTMLElement, skip: SkipEntry, key: string): void {
    const row = container.createDiv({ cls: "numbat-scope-skip" });

    // A skip binds nothing, so it has no entry to jump to — but it is searchable, so it still needs
    // a row the search can reveal.
    this.rows.set(key, { el: row, entry: null });
    if (key === this.searchKey) {
      row.addClass("numbat-scope-search-row");
    }

    row.createSpan({ cls: "numbat-scope-name", text: skip.key });
    row.createSpan({ cls: "numbat-scope-skip-reason", text: skip.reason });
    row.createSpan({ cls: "numbat-scope-skip-message", text: skip.message });
  }

  // SEARCH
  // ==============================================================================================

  /** Re-rank on the next tick, coalescing a burst of keystrokes. */
  private requestQuery(): void {
    if (this.queryTimer !== null) {
      window.clearTimeout(this.queryTimer);
    }

    this.queryTimer = window.setTimeout(() => {
      this.queryTimer = null;
      this.runQuery();
    }, QUERY_DELAY);
  }

  /** Score the candidates against the query box and show the results. Called off the debounce, so a
   *  typed word is ranked once rather than per character. */
  private runQuery(): void {
    const query = this.inputEl.value.trim();
    if (query === "") {
      this.clearSearch();
      return;
    }

    this.hits = rankSearchCandidates(this.ensureCandidates(), query, prepareFuzzySearch(query));
    this.selected = 0;
    this.renderResults();
    this.applySelection(false);
  }

  /** The candidate set, rebuilt only when the tree or the vocabulary behind it changes — not per
   *  keystroke. */
  private ensureCandidates(): SearchCandidate[] {
    const vocab = getExpressionVocabulary();
    if (vocab === null) {
      void this.loadVocabulary();
    } else {
      // Keep the prelude context from being released mid-session, as the completer does.
      touchCompletionIdle(this.plugin.settings.completionIdleSeconds * 1000);
    }
    if (this.candidates === null || this.candidateTree !== this.tree || this.candidateVocab !== vocab) {
      this.candidates = scopeSearchCandidates(this.tree, vocab);
      this.candidateTree = this.tree;
      this.candidateVocab = vocab;
    }

    return this.candidates;
  }

  /**
   * The prelude context for signature / documentation lookups — but only if it already exists.
   * Building one loads the whole standard library (~150 ms of synchronous wasm), which must happen
   * on the background path in {@link loadVocabulary}, never while rendering a keystroke's results.
   *
   * Re-read every time rather than held in a field: the idle timer and a prelude change both free
   * it.
   */
  private preludeContext(): Numbat | null {
    if (getExpressionVocabulary() === null) {
      return null; // no context yet — loadVocabulary is (or will be) building one
    }
    return ensureExpressionContext(this.plugin.settings.fetchExchangeRates);
  }

  /** Load the bundled prelude's vocabulary in the background (creating the context costs ~150 ms,
   *  so it happens on first search rather than on panel open), then re-run the query so the
   *  built-ins appear. */
  private async loadVocabulary(): Promise<void> {
    if (this.loadingVocab) {
      return;
    }
    this.loadingVocab = true;

    try {
      await ensureNumbatReady();
      await this.plugin.ensureExchangeRates();
      await this.plugin.ensurePrelude();
      ensureExpressionContext(this.plugin.settings.fetchExchangeRates);
    } catch (error) {
      console.error("Symbat: the scope search could not load the prelude vocabulary", error);
    } finally {
      this.loadingVocab = false;
    }

    if (this.inputEl.value.trim() !== "") {
      this.runQuery();
    }
  }

  /** Drop the query and its selection, restoring the tree to exactly the shape the user had it in
   *  (search expansion never touched `expanded`). */
  private clearSearch(): void {
    this.hits = [];
    this.selected = 0;
    this.searchKey = null;
    this.searchTrail = null;
    this.cancelDwell();
    this.resultsEl.empty();
    // Nothing is selected any more, so the caret owns the reveal again.
    this.pendingReveal = this.trackCursor ? "caret" : null;
    this.renderTree();
  }

  /** Drive the results list from the query box: arrows (or Ctrl-N/P) move the selection, Enter
   *  accepts it, Escape ends the search session. */
  private onSearchKey(event: KeyboardEvent): void {
    const down = event.key === "ArrowDown" || (event.ctrlKey && event.key === "n");
    const up = event.key === "ArrowUp" || (event.ctrlKey && event.key === "p");

    if (down || up) {
      event.preventDefault();
      this.moveSelection(down ? 1 : -1);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      this.applySelection(true);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      this.resetQuery();
    }
  }

  /** Move the selection, clamped at both ends — wrapping while the tree scrolls to follow would be
   *  disorienting. */
  private moveSelection(delta: number): void {
    const shown = Math.min(this.hits.length, MAX_RESULT_ROWS);
    if (shown === 0) {
      return;
    }

    const next = Math.min(Math.max(this.selected + delta, 0), shown - 1);
    if (next === this.selected) {
      return;
    }

    this.selected = next;
    this.renderResults();
    this.applySelection(false);
  }

  /**
   * Reveal the selected result in the tree: force-expand its ancestors, highlight its row, and
   * scroll it into view. With `jump`, also go to the definition.
   *
   * The expansion is an overlay (`searchTrail`), never a write to `expanded`, so clearing the query
   * puts the tree back exactly as it was.
   */
  private applySelection(jump: boolean): void {
    const hit = this.hits[this.selected];
    if (hit === undefined) {
      // Narrowed down to nothing: drop the previous selection rather than leaving a stale row
      // highlighted and its node held open.
      if (this.searchKey !== null || this.searchTrail !== null) {
        this.searchKey = null;
        this.searchTrail = null;
        this.cancelDwell();
        this.renderTree();
      }
      return;
    }

    const { candidate } = hit;
    this.searchKey = candidate.key === "" ? null : candidate.key;
    this.searchTrail = candidate.trail.length === 0 ? null : new Set(candidate.trail);
    this.pendingReveal = this.searchKey === null ? null : "search";
    this.armDwell();
    this.renderTree();

    if (!jump) {
      return;
    }

    const entry = this.searchKey === null ? undefined : this.rows.get(this.searchKey)?.entry;
    if (entry == null) {
      // Nothing to go to — a bundled-prelude item, or a skipped property that bound nothing. Its
      // documentation is the whole payload, so open that at once rather than waiting out the dwell,
      // and leave the query up to keep browsing from.
      this.cancelDwell();
      this.dwellIndex = this.selected;
      this.showDwell(this.selected);
      return;
    }
    this.jumpTo(entry);

    // Going somewhere ends the search: put the box back to rest behind the user.
    this.resetQuery();
  }

  /** Empty the query and take the results down with it, keeping Obsidian's own field (and so its
   *  clear button) in step. */
  private resetQuery(): void {
    this.searchEl.setValue("");
    this.searchEl.onChanged();
    this.clearSearch();
  }

  /** Redraw the results list, or the note that stands in for it — nothing while the query is empty,
   *  "No matches", or the vocabulary-still-loading message. */
  private renderResults(): void {
    this.resultsEl.empty();
    if (this.inputEl.value.trim() === "") {
      return;
    }

    if (this.hits.length === 0) {
      this.resultsEl.createDiv({
        cls: "numbat-scope-results-note",
        text: this.loadingVocab ? "Loading the Numbat prelude…" : "No matches.",
      });
      return;
    }

    const shown = this.hits.slice(0, MAX_RESULT_ROWS);
    const context = this.preludeContext();
    shown.forEach((hit, index) => {
      const { candidate } = hit;
      const row = this.resultsEl.createDiv({ cls: "numbat-scope-result" });
      row.dataset.numbatResult = String(index);
      row.toggleClass("is-selected", index === this.selected);

      // A built-in the note also binds: still listed, but muted.
      row.toggleClass("is-shadowed", candidate.shadowedByScope);
      renderExprSuggestion(
        row,
        { name: candidate.text, category: candidate.category },
        this.signatureFor(hit, context),
        hit.matches,
      );
      row.createSpan({
        cls: "numbat-scope-result-source",
        text: candidate.origin === "builtin" ? "prelude" : candidate.nodeLabel,
      });
    });

    if (this.hits.length > shown.length) {
      this.resultsEl.createDiv({
        cls: "numbat-scope-results-note",
        text: `+${this.hits.length - shown.length} more — keep typing to narrow`,
      });
    }

    // The list scrolls independently of the tree, so arrowing past its edge has to bring the
    // selection back into view here as well.
    this.resultsEl.querySelector(".numbat-scope-result.is-selected")?.scrollIntoView({ block: "nearest" });
  }

  /** The muted inline signature for a result row. A binding in the tree already has its type from
   *  the evaluation pass, so only a built-in costs a `type()` call. */
  private signatureFor(hit: SearchHit, context: Numbat | null): string | null {
    const { candidate } = hit;
    if (candidate.target.kind === "entry") {
      // `.numbat-signature` supplies its own leading `": "`, so drop the one the scope's type
      // fragment carries or it would read `: : Length`.
      return candidate.target.entry.value?.type?.replace(LEADING_COLON, "") ?? null;
    }

    if (candidate.target.kind === "builtin" && context !== null) {
      return completionSignature(context, candidate.text);
    }

    return null;
  }

  /** Select the clicked result and act on it — reveal its tree row, or jump to its definition. */
  private onResultClick(event: MouseEvent): void {
    const index = this.resultIndexFrom(event);
    if (index === null) {
      return;
    }

    this.selected = index;
    this.renderResults();
    this.applySelection(true);
  }

  /** Arm the documentation dwell for the row under the pointer. */
  private onResultHover(event: MouseEvent): void {
    // Preview the docs under the pointer without moving the selection.
    const index = this.resultIndexFrom(event);
    if (index !== null) {
      this.armDwell(index);
    }
  }

  /** The index into {@link hits} of the result row an event landed on, or `null` when it landed
   *  somewhere that is not a row. */
  private resultIndexFrom(event: MouseEvent): number | null {
    const target = event.target as HTMLElement | null;
    const row = target?.closest<HTMLElement>("[data-numbat-result]");
    const raw = row?.dataset.numbatResult;
    return raw === undefined ? null : Number(raw);
  }

  // THE DOCUMENTATION POPUP
  // ==============================================================================================

  /** Abandon a pending documentation popup and forget which row it was for. */
  private cancelDwell(): void {
    if (this.dwellTimer !== null) {
      window.clearTimeout(this.dwellTimer);
      this.dwellTimer = null;
    }

    this.dwellIndex = null;
    this.docPopup.hide();
  }

  /** Open the docs for a result once it has stayed put for {@link COMPLETION_DWELL_MS}. A row
   *  already showing (or waiting to show) is left alone, so drifting across a row's spans does not
   *  tear its popup down and rebuild it. */
  private armDwell(index: number = this.selected): void {
    if (index === this.dwellIndex) {
      return;
    }

    this.cancelDwell();
    this.dwellIndex = index;
    this.dwellTimer = window.setTimeout(() => {
      this.dwellTimer = null;
      this.showDwell(index);
    }, COMPLETION_DWELL_MS);
  }

  /** Show the documentation popup above result `index`, once its dwell elapses. Does nothing if the
   *  row or the hit has gone while the timer ran. */
  private showDwell(index: number): void {
    const hit = this.hits[index];
    const row = this.resultsEl.querySelector<HTMLElement>(`[data-numbat-result="${index}"]`);
    if (hit === undefined || row === null) {
      return;
    }

    const content = this.dwellContent(hit);
    if (content !== null) {
      this.docPopup.showAbove(row.getBoundingClientRect(), content);
    }
  }

  /**
   * What to show for a result: Numbat's own `print_info` documentation for a bundled item or a
   * user-prelude declaration (both live in the prelude context), and a card describing the binding
   * for everything the note itself defines.
   *
   * The `print_info` lookup is deliberately *not* attempted for a note's own binding: the prelude
   * context has never seen it, so it would either find nothing or — where the name collides with a
   * prelude entity, as `m` does with the metre — show that entity's documentation on the user's
   * row.
   */
  private dwellContent(hit: SearchHit): HTMLElement | null {
    const { candidate } = hit;
    const fromPrelude = candidate.origin === "builtin"
      || (candidate.target.kind === "entry" && candidate.target.entry.sourceKind === "prelude");
    if (fromPrelude) {
      const context = this.preludeContext();
      const info = context === null ? null : completionInfo(context, candidate.text);

      if (info !== null) {
        // A function's `print_info` already prints its signature; anything else gains one.
        const signature = candidate.category === "function" || context === null
          ? null
          : completionSignature(context, candidate.text);
        return buildDocPopupContent(info, signature);
      }
    }

    return candidate.target.kind === "builtin" ? null : this.scopeCard(candidate);
  }

  /** A documentation card for one of the note's own rows: where it comes from, where it is defined,
   *  what it says, and what it evaluated to. */
  private scopeCard(candidate: SearchCandidate): HTMLElement {
    const content = createDiv({ cls: "numbat-doc-popup-content" });
    const field = (label: string, fill: (el: HTMLElement) => void): void => {
      const line = content.createDiv({ cls: "numbat-scope-card-field" });
      line.createSpan({ cls: "numbat-doc-label", text: `${label}: ` });
      fill(line.createSpan());
    };

    if (candidate.target.kind === "skip") {
      const { skip } = candidate.target;
      field("Property", (el) => el.setText(skip.key));
      field("Skipped", (el) => el.setText(skip.reason));
      field("Reason", (el) => el.setText(skip.message));
      return content;
    }

    if (candidate.target.kind !== "entry") {
      return content; // a bundled item has no scope card (the caller shows its docs)
    }

    const { entry } = candidate.target;
    field("Name", (el) => el.setText(entry.name));
    if (entry.label !== entry.name) {
      field("Property", (el) => el.setText(entry.label));
    }

    field("From", (el) => el.setText(candidate.nodeLabel));
    const { notePath, line } = entry.defsite;
    if (notePath !== null) {
      field("Defined in", (el) => el.setText(notePath));
    } else if (line !== null) {
      field("Line", (el) => el.setText(String(line + 1)));
    }

    // What the note says, not what was derived from it: a row whose value the derivation
    // substituted for (a grounded `0`) would otherwise show a generated name the reader never
    // wrote. The same choice properties/frontmatter-inlay.ts makes, for the same reason.
    field("Definition", (el) => el.setText(entry.written ?? entry.expr));
    const { value } = entry;
    if (value?.type != null) {
      field("Type", (el) => setNumbatHtml(el, (value.type ?? "").replace(LEADING_COLON, "")));
    }

    if (value?.kind === "value" && value.valueHtml !== null) {
      field("Value", (el) => setNumbatHtml(el, value.valueHtml ?? ""));
    } else if (value?.kind === "hole" && value.holeType !== null) {
      field("Incomplete", (el) => el.setText(`⟨${value.holeType ?? ""}⟩`));
    } else if (value?.kind === "error" && value.errorText !== null) {
      field("Error", (el) => el.setText(value.errorText ?? ""));
    }

    if (entry.shadowed) {
      field("Shadowed", (el) => el.setText("a later binding of this name supersedes it"));
    }

    return content;
  }

  // NAVIGATION
  // ==============================================================================================

  /** Jump to a binding's definition (see {@link jumpToDefinition}, shared with the hover popup): a
   *  same-note binding moves the editor cursor; a binding from another file (an import, a prelude
   *  file) opens that file, at its line when known. */
  private jumpTo(entry: ScopeEntry): void {
    jumpToDefinition(this.app, entry.defsite, this.currentPath);
  }
}

/** Whether two node trails name the same set — i.e. the caret stayed within the same chain of
 *  containing nodes, so nothing about the tree's expansion moved. */
function sameTrail(a: ReadonlySet<string> | null, b: ReadonlySet<string> | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }

  return a.size === b.size && [...a].every((id) => b.has(id));
}
