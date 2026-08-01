// Pure helpers for cross-note imports (the `numbat-use` frontmatter property): reading the
// property's link targets, and walking the import graph in dependency order with a cycle guard. The
// vault-facing side — resolving a link to a note, reading a note's shared blocks and typed
// properties — is injected as an `ImportResolver`, so this stays free of Obsidian / wasm imports
// and unit-testable in isolation (like properties/parse.ts / document/fences.ts). The stateful
// resolver lives in imports/graph.ts.

/**
 * The link targets named by a `numbat-use` frontmatter value: a single value or a list, each a bare
 * note name / path or an Obsidian `[[wikilink]]` (its `#subpath` and `|alias` stripped). Non-string
 * entries are ignored, so a malformed value simply yields fewer targets rather than throwing.
 */
export function parseNumbatUse(value: unknown): string[] {
  const items: unknown[] = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const targets: string[] = [];

  for (const item of items) {
    if (typeof item !== "string") {
      continue;
    }
    const linkpath = extractLinkpath(item);
    if (linkpath !== null) {
      targets.push(linkpath);
    }
  }

  return targets;
}

// A `[[wikilink]]` wrapper, captured to its (possibly empty) inner target.
const WIKILINK = /^\[\[(.*)\]\]$/;

/** The note path a `numbat-use` entry points at: the inside of a `[[wikilink]]` (or the bare
 *  string), with any `|alias` and `#subpath` removed. `null` when nothing usable remains — an empty
 *  value, or malformed bracket junk. */
function extractLinkpath(raw: string): string | null {
  const trimmed = raw.trim();
  const wiki = WIKILINK.exec(trimmed);
  const inner = wiki !== null ? wiki[1] : trimmed;

  // Drop a display alias (`|…`) then a subpath (`#…`); a note import cares only about the note
  // itself.
  const path = inner.split("|")[0].split("#")[0].trim();
  return path === "" || path.includes("[") || path.includes("]") ? null : path;
}

/** What the graph walk needs from the vault, injected so the walk stays pure. */
export interface ImportResolver {
  /** The canonical id (note path) a link target resolves to from `fromId`, or `null` when it
   *  resolves to nothing (a broken link). */
  resolve(linkpath: string, fromId: string): string | null;

  /** A resolved note's own `numbat-use` targets and the code chunks it contributes to an importer —
   *  each independently interpretable (a typed-property binding, a `numbat-shared` block), typed
   *  properties first — or `null` when the note cannot be read. */
  node(id: string): { uses: string[]; chunks: string[]; } | null;
}

/** The ordered result of a graph walk: the contribution chunks (each replayed in its own
 *  `interpret` call, so one broken import cannot sink the rest — Numbat rejects a whole
 *  multi-statement program on any error), flattened across notes in dependency order, and the note
 *  ids in that same order (for tests and, later, the scope inspector). */
export interface ImportCollection {
  /** The shared-block sources to replay, in dependency order — each its own `interpret` call. */
  chunks: string[];

  /** The note ids the chunks came from, in that same order. */
  order: string[];
}

/**
 * Gather the transitive imports of a note, given its own `numbat-use` targets and the resolver.
 * Walks depth-first so a dependency's chunks land before the note that uses it, emitting each note
 * once (later re-encounters are skipped) and breaking cycles: a target already on the current path
 * — or the importing note (`rootId`) itself — is not re-entered. The importing note's own bindings
 * are *not* part of the result; the caller replays those after these imports.
 */
export function collectImports(rootUses: string[], rootId: string, resolver: ImportResolver): ImportCollection {
  const emitted = new Set<string>();
  const onPath = new Set<string>();
  const order: string[] = [];
  const chunks: string[] = [];

  const visit = (id: string): void => {
    // Skip an already-emitted note (dedupe), a note on the current path (a cycle), and the
    // importing note itself (its scope is replayed separately).
    if (id === rootId || emitted.has(id) || onPath.has(id)) {
      return;
    }

    const node = resolver.node(id);
    if (node === null) {
      return;
    }

    onPath.add(id);
    for (const use of node.uses) {
      const target = resolver.resolve(use, id);
      if (target !== null) {
        visit(target);
      }
    }

    onPath.delete(id);
    emitted.add(id);
    order.push(id);
    chunks.push(...node.chunks);
  };

  for (const use of rootUses) {
    const target = resolver.resolve(use, rootId);
    if (target !== null) {
      visit(target);
    }
  }

  return { chunks, order };
}
