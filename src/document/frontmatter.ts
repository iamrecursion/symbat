// The fences that delimit a note's YAML frontmatter.
//
// Five modules scanned for these independently — scope/model.ts, scope/replay.ts,
// properties/parse.ts, evaluation/inline-parse.ts and evaluation/inlay.ts (which spelled them
// `FM_OPEN`/`FM_CLOSE`) — each with its own byte-identical copy. They must agree: two modules
// disagreeing about where the frontmatter ends means one of them reads YAML as Numbat, or Numbat as
// YAML.
//
// No imports, so the pure `*-parse.ts` modules can use it and stay unit-testable without Obsidian
// or the wasm present.

/**
 * Opens frontmatter. Only ever meaningful on the note's first line — YAML permits a `---` document
 * separator, but Obsidian recognizes frontmatter only at the top.
 */
export const FRONTMATTER_OPEN = /^---\s*$/;

/**
 * Closes frontmatter. YAML ends a document with either `---` (start of the next) or `...` (explicit
 * end), and Obsidian accepts both.
 */
export const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)\s*$/;
