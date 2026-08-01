// The one fenced-code-block scanner. Locates `numbat` / `numbat-shared` blocks in a document for
// the editor-side surfaces (Unicode expansion, completion, inlay hints, the scope tree, the import
// scan, comment toggling, highlighting).
//
// It tracks *every* fence, not only the numbat ones, because a `numbat` fence nested inside another
// fence is quoted example text, not code to evaluate — a note documenting the plugin will contain
// one. Four scanners used to answer this question independently and only
// evaluation/inline-parse.ts's got nesting right, so hints were painted inside quoted examples and
// a nested `numbat-shared` example exported its bindings to every note importing that one. They now
// share {@link FenceWalk}.
//
// Frontmatter is tracked for the same reason: a fence inside a YAML block scalar opens nothing.
//
// Only imports document/frontmatter.ts (itself import-free), so this stays unit-testable without
// Obsidian, CodeMirror, or the wasm bindings.

import { FRONTMATTER_CLOSE, FRONTMATTER_OPEN } from "./frontmatter";

// Any fenced block opener: three-or-more backticks or tildes, then an info string.
const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;

/** How a fence's info string classifies the block it opens. */
export type FenceKind = "numbat" | "shared" | "other";

/** Whether a line is the delimiter of the region it belongs to, or its content. */
export type FenceRole = "open" | "body" | "close";

/**
 * {@link FenceWalk.step}'s verdict for one line. Discriminated so a consumer cannot silently
 * conflate the regions — treating a frontmatter line as prose is the bug class this module exists
 * to prevent.
 */
export type FenceLine =
  | { region: "prose"; }
  | { region: "frontmatter"; role: FenceRole; }
  | {
    region: "fence";
    role: FenceRole;
    kind: FenceKind;
    /** 0-indexed document line of the enclosing block's opening fence. */
    openLine: number;
  };

// Prose carries no per-line data, so every prose verdict can share one frozen object rather than
// allocating per line of a document.
const PROSE: FenceLine = { region: "prose" };

// THE WALKER
// ================================================================================================

/**
 * The line-by-line fence and frontmatter tracker every scanner in this module is built on. Feed it
 * a document's lines in order, from line 0; each {@link step} reports what that line is.
 *
 * A block is closed by an equal-or-longer run of its own fence character, so a
 * ```` ``` ```` cannot close a ```` ```` ```` fence. Following CommonMark, a
 * backtick fence's info string may not itself contain a backtick — that is inline
 * code, not a fence.
 */
export class FenceWalk {
  /** Matches the fence that would close the block currently open, or `null` when no block is open.
   *  Built per opener, since the closer must be the same character and at least as long. Doubles as
   *  the "inside a fence" flag. */
  private closeFence: RegExp | null = null;

  /** How the open block's info string classified it; `"other"` when none is open. */
  private kind: FenceKind = "other";

  /** The open block's opening-fence line, or `-1` when none is open. */
  private openLine = -1;

  /** Whether the walk is between the note's frontmatter delimiters. */
  private inFrontmatter = false;

  /** How many lines have been consumed — the 0-indexed number of the next one. */
  private index = 0;

  /** Consume the next line. */
  step(text: string): FenceLine {
    const index = this.index;
    this.index += 1;

    // Frontmatter is only frontmatter at the very top of the note.
    if (index === 0 && FRONTMATTER_OPEN.test(text)) {
      this.inFrontmatter = true;
      return { region: "frontmatter", role: "open" };
    }

    if (this.inFrontmatter) {
      if (FRONTMATTER_CLOSE.test(text)) {
        this.inFrontmatter = false;
        return { region: "frontmatter", role: "close" };
      }
      return { region: "frontmatter", role: "body" };
    }

    if (this.closeFence === null) {
      const open = FENCE_OPEN.exec(text);
      if (open === null || (open[2][0] === "`" && open[3].includes("`"))) {
        return PROSE;
      }
      const fenceChar = open[2][0];
      this.closeFence = new RegExp(`^\\s*\\${fenceChar}{${open[2].length},}\\s*$`);
      const info = open[3].trim();
      this.kind = info === "numbat-shared" ? "shared" : info === "numbat" ? "numbat" : "other";
      this.openLine = index;
      return { region: "fence", role: "open", kind: this.kind, openLine: index };
    }

    if (this.closeFence.test(text)) {
      const closed: FenceLine = {
        region: "fence",
        role: "close",
        kind: this.kind,
        openLine: this.openLine,
      };
      this.closeFence = null;
      this.kind = "other";
      this.openLine = -1;
      return closed;
    }

    return { region: "fence", role: "body", kind: this.kind, openLine: this.openLine };
  }

  /**
   * The unclosed `numbat` / `numbat-shared` block whose body the *next* line would fall inside, or
   * `null` — outside any block, inside a non-numbat one, or inside frontmatter. The fence lines
   * themselves count as outside.
   */
  openNumbat(): { kind: "numbat" | "shared"; openLine: number; } | null {
    return this.closeFence !== null && this.kind !== "other"
      ? { kind: this.kind, openLine: this.openLine }
      : null;
  }
}

// THE SCANNERS
// ================================================================================================

/**
 * Whether the line following `precedingLines` falls inside the *body* of a `numbat` /
 * `numbat-shared` fenced block. `precedingLines` are the document lines strictly before the line in
 * question, in order from line 0.
 *
 * It accepts any iterable so the editor can pass a CodeMirror line cursor (`Text.iterLines`)
 * straight through — an O(n) sequential scan with no intermediate array — while tests pass a plain
 * array.
 */
export function insideNumbatFence(precedingLines: Iterable<string>): boolean {
  const walk = new FenceWalk();
  for (const text of precedingLines) {
    walk.step(text);
  }

  return walk.openNumbat() !== null;
}

/** The open `numbat` block containing the line after `precedingLines`. */
export interface NumbatFenceContext {
  /** `true` for a `numbat-shared` block, `false` for a plain `numbat` block. */
  shared: boolean;

  /** 0-indexed document line of the opening fence. */
  openLine: number;

  /** The block's body lines so far (after the opening fence, before the cursor line). */
  body: string[];
}

/**
 * Like {@link insideNumbatFence}, but returns the enclosing block's kind, opening line, and
 * body-so-far when the line after `precedingLines` sits inside a block, or `null` when it does not.
 * Used by expression completion to replay the code the user has already written above the cursor.
 * `precedingLines` must start at document line 0, so `openLine` is a true document line number.
 */
export function numbatFenceContext(precedingLines: Iterable<string>): NumbatFenceContext | null {
  const walk = new FenceWalk();

  let body: string[] = [];
  for (const text of precedingLines) {
    const line = walk.step(text);
    if (line.region !== "fence") {
      continue;
    }
    if (line.role === "open") {
      body = [];
    } else if (line.role === "body") {
      body.push(text);
    }
  }

  const open = walk.openNumbat();

  return open === null ? null : { shared: open.kind === "shared", openLine: open.openLine, body };
}

/** A complete `numbat` / `numbat-shared` block located in a document. */
export interface NumbatBlockRange {
  /** `true` for a `numbat-shared` block, `false` for a plain `numbat` block. */
  shared: boolean;

  /** 0-indexed document line of the opening fence. */
  openLine: number;

  /** 0-indexed document line of the closing fence, or the count of lines when the block runs to the
   *  end of the document without a closing fence. */
  closeLine: number;

  /** 0-indexed document line of the first body line (`openLine + 1`). */
  bodyStartLine: number;

  /** The block's body lines (between the fences), in order. */
  body: string[];
}

/**
 * Locate every `numbat` / `numbat-shared` block in a document, in order. Unlike {@link
 * numbatFenceContext} (which describes the single block a cursor sits in), this enumerates all of
 * them — the inlay-hint pass walks the list to decide which blocks are visible and evaluates each
 * one. `lines` are the document's lines, in order, from line 0; an unclosed final block is returned
 * with its body running to the end of the document.
 */
export function numbatBlockRanges(lines: Iterable<string>): NumbatBlockRange[] {
  const walk = new FenceWalk();
  const blocks: NumbatBlockRange[] = [];
  let current: NumbatBlockRange | null = null;
  let index = 0;

  for (const text of lines) {
    const line = walk.step(text);
    if (line.region === "fence") {
      if (line.role === "open" && line.kind !== "other") {
        current = {
          shared: line.kind === "shared",
          openLine: index,
          closeLine: index,
          bodyStartLine: index + 1,
          body: [],
        };
      } else if (current !== null && line.role === "body") {
        current.body.push(text);
      } else if (current !== null && line.role === "close") {
        // Finalize the open block at its closing fence.
        current.closeLine = index;
        blocks.push(current);
        current = null;
      }
    }
    index += 1;
  }

  // A block left open at end-of-document runs to the last line.
  if (current !== null) {
    current.closeLine = index;
    blocks.push(current);
  }

  return blocks;
}
