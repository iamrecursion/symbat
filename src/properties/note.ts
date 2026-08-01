// Bridges the pure preamble derivation (properties/parse.ts) to Obsidian: YAML parsing, the
// vault-wide property-type assignments (the undocumented `metadataTypeManager`, the same registry
// Obsidian's own property widgets and Better Properties use), the prelude-name reservation check,
// and the settings gates. Every evaluation surface funnels through {@link notePreamble} + {@link
// replayPreamble}, so property bindings behave identically in code blocks, inline spans, inlay
// hints, and completion.

import { type App, type EventRef, parseYaml } from "obsidian";
import { collectImports, type ImportResolver, parseNumbatUse } from "../imports/parse";
import {
  ensureExpressionContext,
  getExpressionVocabulary,
  interpret,
  isNumbatReady,
  type Numbat,
} from "../interpreter/numbat";
import type SymbatPlugin from "../main";
import { derivePreamble, EMPTY_PREAMBLE, frontmatterBody, type NotePreamble } from "./parse";

export { EMPTY_PREAMBLE, frontmatterBody, type NotePreamble };

// THE NUMBAT PROPERTY TYPE
// ================================================================================================

/** The id the numbat property type registers under — namespaced (like Better Properties'
 *  `better-properties:*` types) so it can never collide with a core type. Persisted by Obsidian in
 *  `types.json` per assigned property name. */
export const NUMBAT_PROPERTY_TYPE = "numbat:expression";

/** The slice of Obsidian's undocumented `metadataTypeManager` this plugin touches. Every access is
 *  optional — a future Obsidian that renames any of it degrades to "no numbat-typed properties",
 *  never a crash. */
export interface PropertyTypeManager {
  /** The widget registry, keyed by type name — where the Numbat type is installed. */
  registeredTypeWidgets?: Record<string, unknown>;

  /** The type assigned to a property name, or `null` when it has none. This is the only way to tell
   *  a Numbat-typed property from an ordinary one. */
  getAssignedWidget?: (key: string) => string | null;

  /** Fire a manager event; used to announce a newly registered widget. */
  trigger?: (name: string) => void;

  /** Subscribe to type-assignment changes, so the plugin can re-evaluate when a property is
   *  retyped. */
  on?: (name: "changed", callback: () => void) => EventRef;
}

/** The metadata type manager, or `null` on an Obsidian without one. */
export function propertyTypeManager(app: App): PropertyTypeManager | null {
  const manager = (app as App & { metadataTypeManager?: PropertyTypeManager; }).metadataTypeManager;
  return typeof manager === "object" && manager !== null ? manager : null;
}

/** Whether this property name is assigned the numbat type (vault-wide). */
export function isNumbatTypedKey(app: App, key: string): boolean {
  return propertyTypeManager(app)?.getAssignedWidget?.(key) === NUMBAT_PROPERTY_TYPE;
}

// The prelude's name set (units ∪ functions ∪ variables ∪ dimensions, including the user prelude
// and currency units) — a property binding one of these is skipped rather than shadowing it: `m: 5`
// would silently turn `5 m` into arithmetic. Built once off-path by {@link primeReservedNames} and
// cached as plain strings, so the *synchronous* preamble derivation (and the cache signatures built
// from it) stays stable even after the completion contexts are idle-released. Until it is primed
// nothing reads as reserved — which only matters before any evaluation can happen anyway; the
// preamble source shifts when the names arrive and the affected notes re-evaluate.
let reservedNames: Set<string> | null = null;

// RESERVED NAMES
// ================================================================================================

/**
 * Build the reserved-name set if it is missing, on the shared expression context (created on
 * demand, ~70 ms once). Call from an async evaluation path — after `ensureNumbatReady()` — never
 * from a synchronous one.
 */
export function primeReservedNames(applyRates: boolean): void {
  if (reservedNames !== null || !isNumbatReady()) {
    return;
  }

  ensureExpressionContext(applyRates);
  const vocab = getExpressionVocabulary();
  if (vocab === null) {
    return;
  }

  reservedNames = new Set([...vocab.functions, ...vocab.units, ...vocab.variables, ...vocab.dimensions]);
}

/** Drop the cached reserved names (the prelude or exchange-rate settings changed — the set bakes
 *  both in). Rebuilt on the next evaluation. */
export function invalidateReservedNames(): void {
  reservedNames = null;
}

/** Whether the identifier is a prelude name (per the primed set). */
function isReservedName(name: string): boolean {
  return reservedNames?.has(name) ?? false;
}

/** Keys Obsidian's frontmatter cache mixes into the record that are not properties (the parse
 *  position). */
const NON_PROPERTY_KEYS = new Set(["position"]);

/** {@link derivePreamble} over an already-parsed frontmatter record. `sourcePath` namespaces the
 *  struct types an object property generates, so a note and the notes it imports never define the
 *  same struct name twice. */
function preambleFromRecord(
  plugin: SymbatPlugin,
  record: Record<string, unknown>,
  sourcePath: string | null,
): NotePreamble {
  const frontmatter = Object.fromEntries(
    Object.entries(record).filter(([key]) => !NON_PROPERTY_KEYS.has(key)),
  );

  return derivePreamble(frontmatter, {
    isNumbatTyped: (key) => isNumbatTypedKey(plugin.app, key),
    isReserved: isReservedName,
    bindNumbers: plugin.settings.notePropertyNumbers,
    namespace: sourcePath ?? "",
  });
}

// CROSS-NOTE IMPORTS
// ================================================================================================

// The cache-key separator between the import code and the property bindings in NotePreamble.source
// — a NUL, which never occurs in Numbat code. Built with fromCharCode so no literal NUL byte is
// ever written into this source file.
const SCOPE_SEPARATOR = String.fromCharCode(0);

/**
 * The code chunks a note's `numbat-use` targets contribute, ready to replay (each in its own
 * `interpret` call) before the note's own bindings: each target's typed-property bindings and
 * `numbat-shared` blocks, gathered transitively in dependency order with a cycle guard (see {@link
 * collectImports}). Empty when imports are off, the note names none, or none resolve. `sourcePath`
 * roots link resolution and the cycle guard; `record` is the note's own frontmatter.
 */
// The resolver `collectImports` walks with — link resolution and a note's own `numbat-use` +
// contributed chunks (typed properties first, then shared blocks), shared by the flattened {@link
// importChunksFor} and the per-note {@link importGroups}. The moduleGraph is captured optionally so
// a re-resolve of an already-emitted note stays a no-throw even if the graph is gone.
function buildImportResolver(plugin: SymbatPlugin): ImportResolver {
  const { app } = plugin;
  const graph = plugin.moduleGraph;

  return {
    resolve: (linkpath, fromId) => app.metadataCache.getFirstLinkpathDest(linkpath, fromId)?.path ?? null,
    node: (id) => {
      const frontmatter = app.metadataCache.getCache(id)?.frontmatter;
      const uses = parseNumbatUse(frontmatter?.["numbat-use"]);

      // A target exports its typed properties (never its untyped numbers) and its shared blocks —
      // properties first, matching a note's own replay order.
      const propsChunks = frontmatter === undefined ? [] : importedPropsChunks(plugin, frontmatter, id);
      const chunks = [...propsChunks, ...(graph?.sharedBlocks(id) ?? [])];
      return { uses, chunks };
    },
  };
}

/**
 * The shared-block sources a note's `numbat-use` property pulls in, in replay order. Empty when
 * note imports are off, the graph is unavailable, or the note imports nothing — so the caller can
 * treat "no imports" and "imports disabled" alike.
 */
function importChunksFor(plugin: SymbatPlugin, sourcePath: string, record: Record<string, unknown>): string[] {
  const graph = plugin.moduleGraph;
  if (!plugin.settings.noteImports || graph === undefined) {
    return [];
  }

  const rootUses = parseNumbatUse(record["numbat-use"]);
  if (rootUses.length === 0) {
    return [];
  }

  return collectImports(rootUses, sourcePath, buildImportResolver(plugin)).chunks;
}

/** The note's cross-note imports grouped by source note, in the same dependency order {@link
 *  importChunksFor} flattens — each note's contributed chunks (typed properties then
 *  `numbat-shared` blocks) kept under its own path. For the note scope inspector, which lists
 *  imported bindings under the note they came from. Empty when imports are off, none are named, or
 *  none resolve. */
export function importGroups(
  plugin: SymbatPlugin,
  sourcePath: string,
  record: Record<string, unknown>,
): { notePath: string; chunks: string[]; }[] {
  const graph = plugin.moduleGraph;
  if (!plugin.settings.noteImports || graph === undefined) {
    return [];
  }

  const rootUses = parseNumbatUse(record["numbat-use"]);
  if (rootUses.length === 0) {
    return [];
  }

  const resolver = buildImportResolver(plugin);

  // `order` visits each imported note once, deepest dependency first (matching the flattened chunk
  // order); re-resolving each yields that note's own chunks.
  return collectImports(rootUses, sourcePath, resolver).order.map((notePath) => ({
    notePath,
    chunks: resolver.node(notePath)?.chunks ?? [],
  }));
}

/** The `let` statements for a target note's numbat-*typed* properties (only — `bindNumbers: false`,
 *  so incidental numeric metadata never leaks into an importer), each its own chunk, skipping
 *  reserved/duplicate/unusable names as everywhere else. */
function importedPropsChunks(
  plugin: SymbatPlugin,
  frontmatter: Record<string, unknown>,
  notePath: string,
): string[] {
  const record = Object.fromEntries(
    Object.entries(frontmatter).filter(([key]) => !NON_PROPERTY_KEYS.has(key)),
  );

  const preamble = derivePreamble(record, {
    isNumbatTyped: (key) => isNumbatTypedKey(plugin.app, key),
    isReserved: isReservedName,
    bindNumbers: false,
    namespace: notePath,
  });

  return preamble.bindings.map((binding) => binding.code);
}

/** Attach the note's cross-note imports to its preamble (folding the import chunks into {@link
 *  NotePreamble.source} so every evaluation cache key invalidates when an import changes). A no-op
 *  without a `sourcePath` (some surfaces have none) or when nothing is imported. */
function attachImports(
  plugin: SymbatPlugin,
  preamble: NotePreamble,
  sourcePath: string | null,
  record: Record<string, unknown>,
): NotePreamble {
  if (sourcePath === null) {
    return preamble;
  }

  const imports = importChunksFor(plugin, sourcePath, record);
  if (imports.length === 0) {
    return preamble;
  }

  const importSource = imports.join(SCOPE_SEPARATOR);
  return { ...preamble, imports, source: importSource + SCOPE_SEPARATOR + preamble.source };
}

// THE NOTE PREAMBLE
// ================================================================================================

/**
 * The note preamble for a frontmatter body (see {@link frontmatterBody}), per the current settings
 * and type assignments. Malformed YAML — which Obsidian itself shows as raw text — yields no
 * bindings.
 */
export function notePreamble(
  plugin: SymbatPlugin,
  body: string[] | null,
  sourcePath: string | null = null,
): NotePreamble {
  if (!plugin.settings.noteProperties || body === null || body.length === 0) {
    return EMPTY_PREAMBLE;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(body.join("\n"));
  } catch {
    return EMPTY_PREAMBLE;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return EMPTY_PREAMBLE;
  }

  const record = parsed as Record<string, unknown>;
  return attachImports(plugin, preambleFromRecord(plugin, record, sourcePath), sourcePath, record);
}

/** {@link notePreamble} from a whole document's text (reading view, code-block post-processors —
 *  wherever `getSectionInfo` provides it). `sourcePath`, when known, roots the note's cross-note
 *  imports. */
export function preambleForDoc(plugin: SymbatPlugin, docText: string, sourcePath: string | null = null): NotePreamble {
  return notePreamble(plugin, frontmatterBody(docText.split("\n")), sourcePath);
}

/**
 * {@link notePreamble} from the metadata cache — for surfaces with no document text at hand (a code
 * block whose section info is unavailable, the property widget). Cache-backed, so it can briefly
 * trail an in-flight edit; the text-based paths above are buffer-accurate and preferred.
 */
export function preambleForFile(plugin: SymbatPlugin, sourcePath: string): NotePreamble {
  if (!plugin.settings.noteProperties) {
    return EMPTY_PREAMBLE;
  }

  const cache = plugin.app.metadataCache.getCache(sourcePath);
  const record = cache?.frontmatter;
  if (record === undefined) {
    return EMPTY_PREAMBLE;
  }

  return attachImports(plugin, preambleFromRecord(plugin, record, sourcePath), sourcePath, record);
}

// REPLAY
// ================================================================================================

/**
 * Replay the preamble into a fresh context, before anything else the surface evaluates. Errors are
 * absorbed (matching chunk replay everywhere else): the bindings that parsed remain in scope, and
 * the property widget surfaces a binding's own error where the user can see it.
 */
export function replayPreamble(context: Numbat, preamble: NotePreamble): void {
  // Cross-note imports open the scope, before this note's own bindings — each chunk in its own
  // call, so one broken import does not sink the rest.
  for (const chunk of preamble.imports ?? []) {
    interpret(context, chunk);
  }
  for (const binding of preamble.bindings) {
    interpret(context, binding.code);
  }
}

/**
 * The code that is in scope *at* one property: the note's cross-note imports, then the bindings of
 * the properties written above it — never the ones below, and never the note's blocks (the preamble
 * evaluates before them). One chunk per statement, matching how every other replay absorbs a broken
 * one.
 *
 * `key` is the property's dotted path (`costs.total`), the form both {@link PropertyBinding.key}
 * and Obsidian's property UI use, so the stop applies to a nested property as exactly as to a
 * top-level one.
 *
 * Shared by the three surfaces that must agree on what a property can see: the widget's evaluation,
 * the widget's completer, and the Source-mode completer.
 */
export function scopeChunksAbove(preamble: NotePreamble, key: string): string[] {
  const chunks = [...(preamble.imports ?? [])];
  for (const binding of preamble.bindings) {
    if (binding.key === key) {
      break;
    }
    chunks.push(binding.code);
  }

  return chunks;
}

/** {@link scopeChunksAbove}, replayed into `context`. */
export function replayScopeAbove(context: Numbat, preamble: NotePreamble, key: string): void {
  for (const chunk of scopeChunksAbove(preamble, key)) {
    interpret(context, chunk);
  }
}
