// The settings tab: one renderer, driven by the descriptor table in settings/defs.ts.
//
// Obsidian 1.13 introduced a declarative settings API — the plugin returns a description of its
// settings and Obsidian renders and persists them — and the plugin's `minAppVersion` requires it.
// Before that this file carried a second, imperative `display()` renderer for older builds, and a
// third copy of the settings for their side effects; the copies drifted and produced two real bugs
// (see settings/defs.ts). One table and one renderer make that class of bug unrepresentable.
//
// What is left here is only what genuinely needs Obsidian: turning descriptors into settings
// definitions, and mapping an effect name onto the plugin method that performs it.

import {
  apiVersion,
  type App,
  Notice,
  Platform,
  PluginSettingTab,
  Setting,
  type SettingDefinitionItem,
  type SettingGroupItem,
} from "obsidian";
import { invalidateExpressionCompletion } from "../interpreter/numbat";
import type SymbatPlugin from "../main";
import { invalidateReservedNames } from "../properties/note";
import {
  ADD_PRELUDE_NAME,
  COPY_DEBUG_INFO,
  type DEFAULT_SETTINGS,
  EFFECTS_BY_KEY,
  normalizeSettings,
  PRELUDE_EMPTY,
  PRELUDE_LIST_DESC,
  PRELUDE_LIST_HEADING,
  PRELUDE_NAME_PLACEHOLDER,
  PRELUDE_PATH_PLACEHOLDER,
  SETTING_BLOCKS,
  type SettingDescriptor,
  type SettingEffect,
} from "./defs";
import { moveItem, parseCodeSpans, type PreludeFile } from "./util";

// Re-exported so the rest of the plugin keeps importing its settings from "./settings", which is
// where they conceptually live.
export {
  DEFAULT_REPL_FONT_SIZE,
  DEFAULT_SETTINGS,
  type InlineReadingStyle,
  normalizeSettings,
  type ReplVimMode,
  type SymbatSettings,
} from "./defs";

/**
 * Undocumented Obsidian internals read only to enrich the debug-info card. Every field is optional
 * and accessed defensively, so a missing one just yields a placeholder rather than an error.
 */
interface InternalApp {
  /** The Obsidian installer version (desktop); not part of the public API. */
  installerVersion?: string;

  /** The plugin registry, read only to report this plugin's own version on the version card. */
  plugins?: {
    manifests?: Record<string, { id?: string; version?: string; }>;
    enabledPlugins?: Set<string>;
  };
}

/** The plugin's settings tab, on Obsidian's declarative settings API. */
export class SymbatSettingTab extends PluginSettingTab {
  /** The plugin whose settings this reads, writes, and dispatches effects against. */
  private readonly plugin: SymbatPlugin;

  /** @param app Obsidian's app. @param plugin the plugin whose settings to edit. */
  constructor(app: App, plugin: SymbatPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** Re-render the tab if it is currently open (e.g. after a prelude path is updated by a file
   *  rename). Safe to call whether or not it is displayed. */
  refresh(): void {
    this.update();
  }

  /**
   * Obsidian reads and writes `this.plugin.settings` through `setControlValue` and renders from
   * these definitions. Dependent rows are revealed by the `visible` predicate (re-evaluated by
   * `refreshDomState`), and the prelude files use a mutable `list` group whose rows are rendered
   * imperatively — two fields on one row is not something a plain descriptor can express — with
   * reorder/delete/add affordances.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const items: SettingDefinitionItem[] = [];
    for (const block of SETTING_BLOCKS) {
      if (block.kind === "group") {
        items.push({
          type: "group",
          heading: block.heading,
          items: block.settings.map((descriptor) => this.declarativeItem(descriptor)),
        });
      } else if (block.kind === "prelude-list") {
        items.push({
          type: "list",
          heading: PRELUDE_LIST_HEADING,
          desc: PRELUDE_LIST_DESC,
          visible: () => this.isVisible(block.visibleWhen),
          emptyState: PRELUDE_EMPTY,
          items: this.preludeListItems(),
          onReorder: (oldIndex, newIndex) => this.mutatePrelude((files) => moveItem(files, oldIndex, newIndex)),
          onDelete: (index) => this.mutatePrelude((files) => files.filter((_, i) => i !== index)),
          addItem: {
            name: ADD_PRELUDE_NAME,
            action: () => this.mutatePrelude((files) => [...files, { name: "", path: "" }]),
          },
        });
      } else {
        items.push({ name: "", render: (setting: Setting) => this.renderVersionCard(setting) });
      }
    }
    return withDescFragments(items);
  }

  /** One descriptor as a declarative settings item. Typed as a `SettingGroupItem` rather than the
   *  wider `SettingDefinitionItem`: a group's items are plain settings, never nested groups or
   *  pages. */
  private declarativeItem(descriptor: SettingDescriptor): SettingGroupItem {
    const control = { ...descriptor.control };
    if (control.type === "number") {
      // Derived rather than declared per control, so a number setting cannot be added without its
      // message. This only *tells* the user; `normalizeSettings` is what keeps the out-of-range
      // value from reaching the consumers.
      const { min, max } = control;
      const message = max === undefined
        ? `Enter a number of at least ${min}.`
        : `Enter a number between ${min} and ${max}.`;
      (control as { validate?: (value: number) => string | undefined; }).validate = (value: number) =>
        Number.isFinite(value) && value >= min && (max === undefined || value <= max) ? undefined : message;
    }

    const item: SettingGroupItem = {
      name: descriptor.name,
      desc: descriptor.desc,
      control,
    };

    const visible = descriptor.visibleWhen;
    if (visible !== undefined) {
      item.visible = () => this.isVisible(visible);
    }

    return item;
  }

  /** Whether a row gated on a boolean setting is currently shown. */
  private isVisible(visibleWhen: keyof typeof DEFAULT_SETTINGS): boolean {
    return Boolean(this.plugin.settings[visibleWhen]);
  }

  /** Obsidian's write path: persist the new value, then rebuild whatever the setting declares it
   *  invalidates. */
  async setControlValue(key: string, value: unknown): Promise<void> {
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
    // Obsidian's `validate` shows a message but stores the value regardless, so the bounds a
    // control declares are enforced here — before `saveSettings` persists it and before the effects
    // below rebuild anything against it.
    this.plugin.settings = normalizeSettings(this.plugin.settings as unknown as Record<string, unknown>);
    await this.plugin.saveSettings();
    for (const effect of EFFECTS_BY_KEY.get(key) ?? []) {
      this.applyEffect(effect);
    }

    // Cheap, and unconditional so a new dependent row cannot be forgotten: the `visible` predicates
    // are re-evaluated and rows revealed or hidden.
    this.refreshDomState();
  }

  /**
   * Perform one named effect. The single place where "a setting changed" meets "what has to be
   * rebuilt" — every effect name in the table resolves here, so adding one without handling it is a
   * compile error rather than a silently inert setting.
   */
  private applyEffect(effect: SettingEffect): void {
    switch (effect) {
      case "ensureExchangeRates":
        // Called unconditionally, not only when switching the toggle on: turning it *off* has to
        // clear the rates, which this already does internally.
        void this.plugin.ensureExchangeRates();
        break;
      case "invalidateCompletionVocabulary":
        invalidateExpressionCompletion();
        invalidateReservedNames();
        break;
      case "markPreludeDirty":
        this.plugin.markPreludeDirty();
        break;
      case "refreshHover":
        this.plugin.refreshHover();
        break;
      case "refreshIndentWidth":
        this.plugin.refreshIndentWidth();
        break;
      case "refreshInlayHints":
        this.plugin.refreshInlayHints();
        break;
      case "refreshInlineEval":
        this.plugin.refreshInlineEval();
        break;
      case "refreshNoteScope":
        this.plugin.refreshNoteScope();
        break;
      case "refreshReplFont":
        this.plugin.refreshReplFont();
        break;
      case "refreshReplHighlight":
        this.plugin.refreshReplHighlight();
        break;
      case "refreshReplVim":
        this.plugin.refreshReplVim();
        break;
    }
  }

  // THE PRELUDE FILE LIST
  // ==============================================================================================

  /** One name+path row per configured prelude file (rendered imperatively so a single list item
   *  carries both fields). */
  private preludeListItems(): SettingGroupItem[] {
    return this.plugin.settings.preludeFiles.map((file) => ({
      name: "",
      render: (setting: Setting) => this.renderPreludeRow(setting, file),
    }));
  }

  /** Populate a prelude row's setting with a name field and a path field. */
  private renderPreludeRow(setting: Setting, file: PreludeFile): void {
    setting.addText((text) =>
      text.setPlaceholder(PRELUDE_NAME_PLACEHOLDER).setValue(file.name).onChange(async (value) => {
        // The name is a label only; it does not affect what is loaded.
        file.name = value;
        await this.plugin.saveSettings();
      })
    );

    setting.addText((text) =>
      text.setPlaceholder(PRELUDE_PATH_PLACEHOLDER).setValue(file.path).onChange(async (value) => {
        file.path = value.trim();
        await this.plugin.saveSettings();
        this.plugin.markPreludeDirty();
      })
    );
  }

  /**
   * Add, remove, or reorder the prelude files, then persist and rebuild. `update()` re-runs
   * `getSettingDefinitions` so the rendered rows match — a structural change, not just a visibility
   * one.
   */
  private mutatePrelude(mutator: (files: PreludeFile[]) => PreludeFile[]): void {
    this.plugin.settings.preludeFiles = mutator(this.plugin.settings.preludeFiles);
    void this.plugin.saveSettings();
    this.plugin.markPreludeDirty();
    this.update();
  }

  // THE VERSION CARD
  // ==============================================================================================

  /**
   * A debug-info card at the bottom of the settings: the plugin/Obsidian versions with a button
   * that copies a fuller report (versions, platform, and the other installed community plugins) for
   * pasting into bug reports.
   */
  private renderVersionCard(setting: Setting): void {
    setting
      .setClass("numbat-version-card")
      .setName(`Symbat ${this.plugin.manifest.version}`)
      .setDesc(`Obsidian ${apiVersion}`)
      .addButton((button) =>
        button.setIcon("copy").setButtonText(COPY_DEBUG_INFO).onClick(() => void this.copyDebugInfo())
      );
  }

  /** A copyable block of version/platform info for bug reports. */
  private debugInfo(): string {
    const internal = this.app as unknown as InternalApp;
    const os = Platform.isMacOS
      ? "macOS"
      : Platform.isWin
      ? "Windows"
      : Platform.isLinux
      ? "Linux"
      : Platform.isIosApp
      ? "iOS"
      : Platform.isAndroidApp
      ? "Android"
      : "unknown";
    const kind = Platform.isDesktopApp ? "desktop" : Platform.isMobileApp ? "mobile" : "other";

    const lines = [
      `Symbat plugin: ${this.plugin.manifest.version}`,
      `Obsidian version: ${apiVersion}`,
      `Obsidian installer version: ${internal.installerVersion ?? "unknown"}`,
      `Obsidian API version: ${apiVersion}`,
      `Platform: ${os} (${kind})`,
      "",
      "Community plugins:",
    ];
    const manifests = internal.plugins?.manifests ?? {};
    const enabled = internal.plugins?.enabledPlugins;
    const others = Object.values(manifests)
      .map((manifest) => ({ id: String(manifest.id ?? ""), version: String(manifest.version ?? "?") }))
      .filter((manifest) => manifest.id !== "" && manifest.id !== this.plugin.manifest.id)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (others.length === 0) {
      lines.push("- (none)");
    } else {
      for (const manifest of others) {
        const state = enabled && !enabled.has(manifest.id) ? " [disabled]" : "";
        lines.push(`- ${manifest.id} ${manifest.version}${state}`);
      }
    }
    return lines.join("\n");
  }

  /** Copy the debug info to the clipboard and confirm with a notice. */
  private async copyDebugInfo(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.debugInfo());
      new Notice("Copied Symbat debug info to the clipboard.");
    } catch (error) {
      console.error("Symbat: failed to copy debug info", error);
      new Notice("Could not copy debug info — clipboard unavailable.");
    }
  }
}

/** Build a settings-description fragment, rendering backtick spans as monospaced `<code>` (see
 *  {@link parseCodeSpans}) rather than showing literal backticks. */
function descFragment(markup: string): DocumentFragment {
  return createFragment((frag) => {
    for (const segment of parseCodeSpans(markup)) {
      if (segment.code) {
        frag.createEl("code", { text: segment.text });
      } else {
        frag.appendText(segment.text);
      }
    }
  });
}

/** A minimal view of a settings definition for the description walk below. */
interface DescNode {
  /** The node's help text; a `string` is what gets converted to a fragment. */
  desc?: string | DocumentFragment;

  /** Nested definitions — a group's settings, a list's items, a page's contents. */
  items?: DescNode[];
}

/**
 * Convert every string `desc` in a settings-definition tree into a code-span {@link descFragment}
 * (so backtick spans render as monospaced `<code>`), recursing into groups, lists, and pages.
 * Mutates and returns the same array — safe because `getSettingDefinitions` builds it fresh on each
 * call, so each render gets its own single-use fragments.
 */
function withDescFragments(items: SettingDefinitionItem[]): SettingDefinitionItem[] {
  const walk = (nodes: DescNode[]): void => {
    for (const node of nodes) {
      if (typeof node.desc === "string") {
        node.desc = descFragment(node.desc);
      }

      if (Array.isArray(node.items)) {
        walk(node.items);
      }
    }
  };

  walk(items);
  return items;
}
