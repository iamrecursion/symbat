// Where the symbol under the cursor is defined, for the hover popup's go-to-definition
// (hover/hover.ts).
//
// The note's scope tree already knows: the inspector aggregates every source a note draws on —
// cross-note imports, frontmatter properties, blocks, inline spans, the user prelude — and tags
// each binding with its definition site (scope/model.ts). This is the bridge: build that tree for a
// note (structure only, no values) and ask it (findDefinition). A symbol the tree does not know is
// a bundled one, and gets no link.
//
// It answers **synchronously**, which is the whole reason it does not simply call `gatherScope`:
// CodeMirror's hover machinery drops a pending asynchronous result the moment the pointer twitches
// or the view updates, so a card that has to await anything is a card that mostly never appears.
// Everything the tree needs is synchronous except reading the user's `.nbt` prelude files, which
// are therefore read *ahead* of the question and cached.

import { inlineConfig } from "../evaluation/inline";
import { interpreterGeneration } from "../interpreter/numbat";
import type SymbatPlugin from "../main";
import { importGroups, notePreamble } from "../properties/note";
import { frontmatterBody } from "../properties/parse";
import {
  buildScopeTree,
  type DefinitionMatch,
  findDefinition,
  type PreludeFileLines,
  type ScopeTree,
} from "../scope/model";
import { frontmatterRecord, preludeFiles } from "../scope/source";

/** One note's structural scope tree, cached against the text it was built from — hovering
 *  repeatedly in an unchanged note parses it once. One entry is enough: hovers happen where the
 *  cursor is, which is one note at a time. */
let cached: { path: string; text: string; tree: ScopeTree; } | null = null;

/** The user prelude's files, read in the background so the lookup can stay synchronous. Empty until
 *  the first read completes — a prelude binding then simply has no jump for a moment, which is the
 *  right trade for a card that appears. */
let prelude: PreludeFileLines[] = [];
// Guards against stacking reads: the lookup is called per hover, and each miss would otherwise
// start another pass over the same files.
let preludeLoading = false;

/** Drop the cached tree and prelude (plugin unload, a prelude change, or a settings change that
 *  alters what the note's scope contains). */
export function invalidateDefinitions(): void {
  cached = null;
  prelude = [];
}

/** Read the prelude files if they are not to hand yet; returns immediately. */
function ensurePreludeFiles(plugin: SymbatPlugin): void {
  if (preludeLoading || prelude.length > 0 || plugin.preludeFileList().length === 0) {
    return;
  }

  preludeLoading = true;
  void preludeFiles(plugin)
    .then((files) => {
      prelude = files;
    })
    .catch(() => {
      // Unreadable — the inspector reports prelude problems; a hover just has no jump for those
      // bindings.
    })
    .finally(() => {
      preludeLoading = false;
    });
}

/**
 * Where `probe` (the whole member chain) / `name` (the bare word) hovered on 0-indexed `line` of
 * `path` is defined, or `null` when nothing in the note's scope defines it — a bundled prelude
 * name, or a name that does not resolve at all.
 *
 * `text` is the note as it currently stands, so the tree matches what is on screen mid-edit; it is
 * also the cache key.
 */
export function definitionAt(
  plugin: SymbatPlugin,
  path: string | null,
  text: string,
  probe: string,
  name: string,
  line: number,
): DefinitionMatch | null {
  if (path === null) {
    return null;
  }

  ensurePreludeFiles(plugin);

  if (cached === null || cached.path !== path || cached.text !== text) {
    cached = { path, text, tree: buildTree(plugin, path, text) };
  }

  return findDefinition(cached.tree, probe, name, line);
}

/** The note's structural scope tree, from the text alone. Mirrors `gatherScope`
 *  (scope/source.ts) minus the interpreter and the value probing, both of which a definition
 *  lookup has no use for. */
function buildTree(plugin: SymbatPlugin, path: string, text: string): ScopeTree {
  const lines = text.split("\n");
  const body = frontmatterBody(lines);

  return buildScopeTree({
    generation: interpreterGeneration(),
    file: path,
    lines,
    config: inlineConfig(plugin),
    preamble: notePreamble(plugin, body, path),
    importGroups: importGroups(plugin, path, frontmatterRecord(body)),
    preludeFiles: prelude,
  });
}
