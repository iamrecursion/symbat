// The vault bridge for the note scope inspector (views/scope.ts): read the active note, derive its
// scope tree (scope/model.ts), and fill in each binding's value off the render path
// (scope/eval.ts). This is the only scope-inspector module that touches Obsidian and the wasm; the
// model and the value probing stay pure.

import { MarkdownView, parseYaml, type TFile } from "obsidian";
import { inlineConfig } from "../evaluation/inline";
import {
  createContext,
  ensureNumbatReady,
  freeQuietly,
  interpret,
  interpreterGeneration,
  isNumbatReady,
  restartNumbat,
} from "../interpreter/numbat";
import type SymbatPlugin from "../main";
import { importGroups, notePreamble, primeReservedNames } from "../properties/note";
import { frontmatterBody } from "../properties/parse";
import { VIEW_TYPE_NUMBAT_FILE } from "../views/nbt";
import { evaluateScopeTree } from "./eval";
import { buildDocumentScopeTree, buildScopeTree, type PreludeFileLines, type ScopeTree } from "./model";

/** The active note's text: the live editor buffer when the note is open (accurate mid-edit), else
 *  the vault's last-saved copy — mirroring ModuleGraph.read's `cachedRead`. */
async function noteText(plugin: SymbatPlugin, file: TFile): Promise<string> {
  for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
    const { view } = leaf;
    if (view instanceof MarkdownView && view.file?.path === file.path) {
      return view.editor.getValue();
    }
  }
  return plugin.app.vault.cachedRead(file);
}

/** The user prelude's `.nbt` files with their content, for the inspector's User prelude node — and,
 *  read ahead of time, for the hover's definition lookup (hover/definition.ts), which has to answer
 *  synchronously. A file that cannot be read is skipped (it just won't be listed). `adapter.read`
 *  mirrors how {@link SymbatPlugin.ensurePrelude} loads them. */
export async function preludeFiles(plugin: SymbatPlugin): Promise<PreludeFileLines[]> {
  const { adapter } = plugin.app.vault;
  const files: PreludeFileLines[] = [];
  for (const file of plugin.preludeFileList()) {
    try {
      if (await adapter.exists(file.path)) {
        files.push({ label: file.label, path: file.path, lines: (await adapter.read(file.path)).split("\n") });
      }
    } catch {
      // Unreadable — skip it (ensurePrelude logs the same case).
    }
  }

  return files;
}

/** The parsed top-level frontmatter record (for {@link importGroups}), or an empty record when the
 *  note has no frontmatter or its YAML is malformed. */
export function frontmatterRecord(body: string[] | null): Record<string, unknown> {
  if (body === null || body.length === 0) {
    return {};
  }

  try {
    const parsed: unknown = parseYaml(body.join("\n"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed YAML — Obsidian itself shows it as raw text; no imports.
  }

  return {};
}

/** The result of {@link gatherScope}: the structural tree (no values yet) and whether the
 *  interpreter is ready for {@link evaluateScope} to fill values. */
export interface ScopeResult {
  /** The scope tree, structure only — its entries carry no `value` yet. */
  tree: ScopeTree;

  /** Whether the interpreter came up. When false the caller renders the structure without values
   *  rather than showing nothing. */
  wasmReady: boolean;
}

/**
 * Build the active note's scope tree — structure only. Readies the interpreter and primes the
 * reserved-name set **before** the preamble is derived (so reserved-name skips are correct), then
 * reads the note text and aggregates every scope source. A wasm failure leaves `wasmReady` false;
 * the caller then renders the structure (bindings, skips, defsites) without values.
 */
export async function gatherScope(plugin: SymbatPlugin, file: TFile): Promise<ScopeResult> {
  let wasmReady = true;
  try {
    await ensureNumbatReady();
    await plugin.ensureExchangeRates();
    await plugin.ensurePrelude();
  } catch (error) {
    console.error("Symbat: could not start the interpreter for the scope inspector", error);
    restartNumbat();
    wasmReady = false;
  }
  if (wasmReady && isNumbatReady()) {
    primeReservedNames(plugin.settings.fetchExchangeRates);
  } else {
    wasmReady = false;
  }

  const text = await noteText(plugin, file);
  const lines = text.split("\n");
  const body = frontmatterBody(lines);
  const preamble = notePreamble(plugin, body, file.path);
  const groups = importGroups(plugin, file.path, frontmatterRecord(body));
  const prelude = await preludeFiles(plugin);
  const tree = buildScopeTree({
    generation: interpreterGeneration(),
    file: file.path,
    lines,
    config: inlineConfig(plugin),
    preamble,
    importGroups: groups,
    preludeFiles: prelude,
  });

  return { tree, wasmReady };
}

/**
 * Build the scope tree for a standalone `.nbt` file. The live editor buffer is preferred over the
 * vault's copy, exactly as {@link noteText} does for a note, so the inspector tracks what is on
 * screen rather than what was last saved.
 *
 * The prelude files listed are the ones loaded *before* this one: they are what the file's own
 * names resolve against, and a file that included itself would report its declarations twice.
 */
export async function gatherDocumentScope(plugin: SymbatPlugin, file: TFile): Promise<ScopeResult> {
  let wasmReady = true;
  try {
    await ensureNumbatReady();
    await plugin.ensureExchangeRates();
    await plugin.ensurePrelude();
  } catch (error) {
    console.error("Symbat: could not start the interpreter for the scope inspector", error);
    restartNumbat();
    wasmReady = false;
  }
  if (!isNumbatReady()) {
    wasmReady = false;
  }

  const text = numbatFileText(plugin, file) ?? await plugin.app.vault.cachedRead(file);
  const prelude = await preludeFiles(plugin);
  const cut = prelude.findIndex((entry) => entry.path === file.path);
  const tree = buildDocumentScopeTree({
    file: file.path,
    label: file.basename,
    lines: text.split("\n"),
    preludeFiles: cut === -1 ? prelude : prelude.slice(0, cut),
  });

  return { tree, wasmReady };
}

/** The live buffer of an open `.nbt` editor for `file`, or `null` when none is open. The view is
 *  duck-typed rather than imported as a class, so this module does not depend on the view layer;
 *  only the view-type id is imported, so a rename of that id cannot silently orphan this lookup. */
function numbatFileText(plugin: SymbatPlugin, file: TFile): string | null {
  for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_NUMBAT_FILE)) {
    const view = leaf.view as { file?: { path?: string; }; getViewData?: () => string; };
    if (view.file?.path === file.path && typeof view.getViewData === "function") {
      return view.getViewData();
    }
  }
  return null;
}

/**
 * Fill every binding in `tree` with its evaluated value, off the render path. Returns whether
 * evaluation completed — false on a wasm failure, in which case the caller renders the structure
 * without values. Each interpreter context is built and freed here; a per-binding error is
 * isolated, a wasm panic caught (and a restart scheduled).
 */
export function evaluateScope(plugin: SymbatPlugin, tree: ScopeTree, preludeBefore?: string): boolean {
  if (!isNumbatReady()) {
    return false;
  }

  const applyRates = plugin.settings.fetchExchangeRates;
  try {
    evaluateScopeTree(() => {
      // `preludeBefore` (a `.nbt` file being inspected) keeps the file's own declarations from
      // arriving twice — once from the prelude, once from the replay — which a repeated `unit` or
      // `dimension` would reject.
      const context = createContext(applyRates, preludeBefore === undefined ? {} : { preludeBefore });
      return { run: (code) => interpret(context, code), free: () => freeQuietly(context) };
    }, tree);
    return true;
  } catch (error) {
    console.error("Symbat: the scope inspector's evaluation crashed", error);
    restartNumbat();
    return false;
  }
}
