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
import type { ImportGroup } from "../scope/model";
import {
  bindingKey,
  derivePreamble,
  EMPTY_PREAMBLE,
  frontmatterBody,
  type NotePreamble,
  PLAIN_ALL,
  PLAIN_NONE,
  type PlainBindings,
  type PropertyBinding,
  quoteZonedTimestamps,
} from "./parse";
import { localZoneName, normalizeOffset, offsetForWallClock } from "./zone";

export { bindingKey, EMPTY_PREAMBLE, frontmatterBody, type NotePreamble };

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

/** The slice of the (undocumented) render context Obsidian passes a property widget. Every field is
 *  optional and accessed defensively. */
export interface PropertyWidgetContext {
  /** The frontmatter key this widget is editing. */
  key?: string;

  /** Report a new value back to Obsidian, which writes it to the note. */
  onChange?: (value: unknown) => void;

  /** Vault path of the note being edited, needed to resolve its imports. */
  sourcePath?: string;
}

/**
 * One entry of {@link PropertyTypeManager.registeredTypeWidgets} — what this plugin's own types are
 * built as, and what Obsidian's built-in ones are read back as.
 *
 * Every field is optional for the same reason the manager's are: these are read off objects
 * Obsidian owns and documents nowhere, and a release that adds, drops or renames one should cost a
 * feature rather than the plugin. `render` in particular is called through only after a null check,
 * and never assumed to return anything in particular.
 */
export interface PropertyWidget {
  /** The registry id, repeated inside the entry. */
  type?: string;

  /** Lucide icon name for the type menu. */
  icon?: string;

  /** The type's display name. */
  name?: () => string;

  /** Whether a value is assignable to this type. */
  validate?: (value: unknown) => boolean;

  /** Draw the editor into `el`. Documented as returning `{ focus }`, but treated as returning
   *  whatever it returns — see properties/date-type.ts. */
  render?: (el: HTMLElement, value: unknown, ctx: PropertyWidgetContext) => unknown;
}

/** The metadata type manager, or `null` on an Obsidian without one. */
export function propertyTypeManager(app: App): PropertyTypeManager | null {
  const manager = (app as App & { metadataTypeManager?: PropertyTypeManager; }).metadataTypeManager;
  return typeof manager === "object" && manager !== null ? manager : null;
}

/** The property type assigned to this name (vault-wide), as the registry's own id, or `null`. */
export function assignedPropertyType(app: App, key: string): string | null {
  return propertyTypeManager(app)?.getAssignedWidget?.(key) ?? null;
}

/** Whether this property name is assigned the numbat type (vault-wide). */
export function isNumbatTypedKey(app: App, key: string): boolean {
  return assignedPropertyType(app, key) === NUMBAT_PROPERTY_TYPE;
}

/** Which untyped values ride along, per the settings — one sub-toggle each, since they differ in
 *  how much of a note's frontmatter they put into its namespace. */
function plainBindings(plugin: SymbatPlugin): PlainBindings {
  return {
    numbers: plugin.settings.notePropertyNumbers,
    text: plugin.settings.notePropertyText,
    dates: plugin.settings.notePropertyDates,
    booleans: plugin.settings.notePropertyBooleans,
  };
}

/**
 * The offset to read a date by when its value carries none of its own, per the reader's setting.
 *
 * A *named* zone is resolved per value rather than once, because half the world's zones change
 * offset twice a year: `Europe/Berlin` owes a date in January `+01:00` and one in July `+02:00`,
 * and a single snapshot would be wrong for half the notes in a vault. A literal offset in the
 * setting is that offset whatever the date, which is the point of writing one. A blank setting is
 * the reader's own zone — the same instant a bare `date("…")` used to denote, but stated, so every
 * surface agrees on it and a vault carried to another zone still reads as it was written.
 */
function defaultOffsetFor(plugin: SymbatPlugin): (isoLocal: string) => string | null {
  const setting = plugin.settings.notePropertyDefaultZone.trim();
  const fixed = setting === "" ? null : normalizeOffset(setting);
  if (fixed !== null) {
    return () => fixed;
  }

  const zone = setting === "" ? localZoneName() : setting;
  return (isoLocal) => offsetForWallClock(zone, isoLocal);
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

/**
 * {@link derivePreamble} over an already-parsed frontmatter record. `sourcePath` namespaces the
 * struct types an object property generates, so a note and the notes it imports never define the
 * same struct name twice.
 *
 * The plain sub-toggles are about *top-level* properties — how much of the frontmatter lands in the
 * note's namespace — so they gate whether an object binds at all, and not which of its fields come
 * with it (`plainNested: PLAIN_ALL`). A field is part of a value that is being bound anyway, and a
 * typed leaf may read a plain sibling by its dotted name (`costs.total = costs.materials * 1.2`);
 * dropping it withholds no name, it hands back a different object than the one that was written and
 * breaks the sibling. This is the same reading a note's exports get — see {@link
 * importedPropsChunks}, which pairs the identical nested rule with a top-level {@link PLAIN_NONE}.
 */
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
    plain: plainBindings(plugin),
    plainNested: PLAIN_ALL,
    assignedType: (key) => assignedPropertyType(plugin.app, key),
    defaultOffset: defaultOffsetFor(plugin),
    zoneOffset: offsetForWallClock,
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
function buildImportResolver(plugin: SymbatPlugin): {
  resolver: ImportResolver;
  /** Each visited note's contribution, kept as it is built so {@link importGroups} needs no second
   *  pass — `collectImports` calls `node` exactly once per note it emits, and deriving a preamble
   *  is the expensive half of that. Populated as `node` is called. */
  contributions: Map<string, ImportGroup>;
} {
  const { app } = plugin;
  const graph = plugin.moduleGraph;
  const contributions = new Map<string, ImportGroup>();

  const resolver: ImportResolver = {
    resolve: (linkpath, fromId) => app.metadataCache.getFirstLinkpathDest(linkpath, fromId)?.path ?? null,
    node: (id) => {
      const frontmatter = app.metadataCache.getCache(id)?.frontmatter;
      const uses = parseNumbatUse(frontmatter?.["numbat-use"]);

      // A target exports its typed properties (never its untyped numbers) and its shared blocks —
      // properties first, matching a note's own replay order.
      const props = frontmatter === undefined
        ? { chunks: [], bindings: [] }
        : importedPropsChunks(plugin, frontmatter, id);
      const sharedChunks = graph?.sharedBlocks(id) ?? [];
      const chunks = [...props.chunks, ...sharedChunks];
      contributions.set(id, {
        notePath: id,
        chunks,
        contribution: { properties: props.bindings, sharedChunks },
      });
      return { uses, chunks };
    },
  };

  return { resolver, contributions };
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

  return collectImports(rootUses, sourcePath, buildImportResolver(plugin).resolver).chunks;
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
): ImportGroup[] {
  const graph = plugin.moduleGraph;
  if (!plugin.settings.noteImports || graph === undefined) {
    return [];
  }

  const rootUses = parseNumbatUse(record["numbat-use"]);
  if (rootUses.length === 0) {
    return [];
  }

  const { resolver, contributions } = buildImportResolver(plugin);

  // `order` visits each imported note once, deepest dependency first (matching the flattened chunk
  // order), and the walk already recorded what each one contributed — a note in `order` is one
  // `node` returned for, so the lookup always hits.
  return collectImports(rootUses, sourcePath, resolver).order
    .map((notePath) => contributions.get(notePath))
    .filter((group): group is ImportGroup => group !== undefined);
}

/**
 * The `let` statements for a target note's numbat-*typed* properties (only — `PLAIN_NONE`, so
 * incidental numeric metadata never leaks into an importer), each its own chunk, skipping
 * reserved/duplicate/unusable names as everywhere else.
 *
 * `PLAIN_NONE` applies to the *top level* only. An object property that exports exports whole
 * (`plainNested: PLAIN_ALL`), because its fields are not separate bindings that could be withheld
 * one by one: a typed leaf may read a plain sibling by its dotted name (`costs.total =
 * costs.materials * 1.2`), and handing the importer an object with that field missing breaks the
 * sibling rather than keeping a name private. An object with no typed leaf at all is still
 * private — that is the gate `plainNested` turns on.
 */
function importedPropsChunks(
  plugin: SymbatPlugin,
  frontmatter: Record<string, unknown>,
  notePath: string,
): { chunks: string[]; bindings: PropertyBinding[]; } {
  const record = Object.fromEntries(
    Object.entries(frontmatter).filter(([key]) => !NON_PROPERTY_KEYS.has(key)),
  );

  const preamble = derivePreamble(record, {
    isNumbatTyped: (key) => isNumbatTypedKey(plugin.app, key),
    isReserved: isReservedName,
    plain: PLAIN_NONE,
    plainNested: PLAIN_ALL,
    assignedType: (key) => assignedPropertyType(plugin.app, key),
    defaultOffset: defaultOffsetFor(plugin),
    zoneOffset: offsetForWallClock,
    namespace: notePath,
  });

  return {
    chunks: preamble.bindings.flatMap((binding) => [...binding.defs, binding.code]),
    // Kept beside the chunks so the scope inspector can show an imported object the way a local one
    // reads — one row per leaf — instead of re-parsing the chunk text and finding one anonymous
    // `let` per generation of the object's progressive build. See scope/model.ts's buildImports.
    bindings: preamble.bindings,
  };
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
    // Zoned timestamps are quoted first, so the parser hands them back as written instead of as
    // instants that have already lost their offset. Without it this path reads a zoned value
    // differently from every surface that goes through Obsidian's property cache.
    parsed = parseYaml(quoteZonedTimestamps(body).join("\n"));
  } catch {
    try {
      // The quoting pass rewrites one value site at a time, and a value site is not always the
      // whole value: the first line of a multi-line plain scalar is one, and quoting it strands the
      // continuation lines outside the string they belonged to. Re-parsing what the note actually
      // says turns that into "a zoned timestamp there reads two ways", which is the pre-existing
      // limitation `docs/roadmap.md` records, rather than "the note has no properties at all" —
      // which is what an unhandled throw here means, since Obsidian's own cache path still has
      // them. Any future shape the quoter mishandles lands here too, by construction.
      parsed = parseYaml(body.join("\n"));
    } catch {
      return EMPTY_PREAMBLE; // genuinely malformed, as Obsidian itself shows it
    }
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
    // The definitions the binding's own expression needs (an array of objects' element type) come
    // first; almost every binding has none.
    for (const def of binding.defs) {
      interpret(context, def);
    }
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
 * top-level one. An array *item*'s key (`rates.#`) stops at its array, which is the binding it is
 * part of — so an item is written against the scope its whole list has, not against the list's own
 * previous value.
 *
 * Shared by the three surfaces that must agree on what a property can see: the widget's evaluation,
 * the widget's completer, and the Source-mode completer.
 */
export function scopeChunksAbove(preamble: NotePreamble, key: string): string[] {
  const stop = bindingKey(key);
  const chunks = [...(preamble.imports ?? [])];
  for (const binding of preamble.bindings) {
    if (binding.key === stop) {
      break;
    }
    chunks.push(...binding.defs, binding.code);
  }

  return chunks;
}

/** {@link scopeChunksAbove}, replayed into `context`. */
export function replayScopeAbove(context: Numbat, preamble: NotePreamble, key: string): void {
  for (const chunk of scopeChunksAbove(preamble, key)) {
    interpret(context, chunk);
  }
}
