// An incrementally-maintained index of a document's `numbat` block *structure*, so the editor's
// per-keystroke scope checks stop rescanning the whole note.
//
// "Is the caret inside a numbat block?" is asked on every keystroke by several handlers at once —
// the Markdown auto-pair guard (every `*` and `_`), Unicode expansion (every line containing a
// backslash, which is any line with LaTeX or a Windows path), and expression completion (any
// two-letter word, i.e. ordinary prose). Each answered by walking the document from line 0, so
// typing in a long note cost several full scans per character.
//
// The field recomputes only when an edit could have moved a fence: the line count changed, or a
// touched line looks like a fence or frontmatter delimiter. Typing inside a line — the overwhelming
// majority of keystrokes — leaves it alone.
//
// It deliberately holds *structure*, not content: editing a line inside a block changes that
// block's body while leaving these spans identical, so a consumer that needs bodies (the inlay
// pass, the import scan, the scope tree) must still scan for itself. Answering "which lines are
// numbat code" is the whole contract.

import { StateField, type Transaction } from "@codemirror/state";
import { numbatBlockRanges } from "./fences";

/** One block's extent, without its text. Lines are 0-indexed, as elsewhere. */
export interface FenceSpan {
  /** Whether this is a `numbat-shared` block, whose bindings other notes can import. */
  shared: boolean;

  /** First body line (the line after the opening fence). */
  bodyStartLine: number;

  /** The closing fence's line, or the document's line count when unclosed — so the body is
   *  `[bodyStartLine, closeLine)`. */
  closeLine: number;
}

// A line that could open or close a fence, or delimit frontmatter. Deliberately loose: a false
// positive costs one rescan, a false negative would leave the index wrong. Anything starting (after
// indentation) with a backtick, a tilde, or the `---` / `...` frontmatter delimiters qualifies.
const FENCE_ISH = /^\s*(?:`|~|---|\.\.\.)/;

/**
 * Project a document's numbat blocks down to their extents. Structurally typed on `doc` rather than
 * taking a CM6 `Text`, so the tests can drive it with a plain object; `iterLines` is the O(n)
 * sequential cursor, as opposed to `line(n)`'s per-call B-tree descent.
 */
function scan(doc: { lines: number; iterLines: (from: number, to: number) => Iterable<string>; }): FenceSpan[] {
  return numbatBlockRanges(doc.iterLines(1, doc.lines + 1)).map((block) => ({
    shared: block.shared,
    bodyStartLine: block.bodyStartLine,
    closeLine: block.closeLine,
  }));
}

/** Whether `tr` could have changed where the fences are. */
function mayMoveFences(tr: Transaction): boolean {
  // Inserting or removing a line shifts every block below it.
  if (tr.startState.doc.lines !== tr.state.doc.lines) {
    return true;
  }

  let suspect = false;
  tr.changes.iterChanges((fromA, toA, fromB, toB) => {
    if (suspect) {
      return;
    }

    // The line count is unchanged, so both ranges span the same few lines; a single-character
    // insertion is one line on each side.
    for (const [doc, from, to] of [[tr.startState.doc, fromA, toA], [tr.state.doc, fromB, toB]] as const) {
      const first = doc.lineAt(from).number;
      const last = doc.lineAt(to).number;
      for (let n = first; n <= last; n += 1) {
        if (FENCE_ISH.test(doc.line(n).text)) {
          suspect = true;
          return;
        }
      }
    }
  });

  return suspect;
}

/**
 * The block spans of the editor's current document. Register {@link numbatFenceState} for a
 * document to have one; consumers that may run without it fall back to a fresh scan.
 */
export const numbatFenceState = StateField.define<readonly FenceSpan[]>({
  create: (state) => scan(state.doc),
  update: (value, tr) => (tr.docChanged && mayMoveFences(tr) ? scan(tr.state.doc) : value),
});

/**
 * Whether the 0-indexed `line` is inside a numbat block's body. The fence lines themselves, and
 * everything outside a block, count as outside — matching {@link insideNumbatFence}, which this
 * replaces on the keystroke paths.
 */
export function inNumbatBody(spans: readonly FenceSpan[], line: number): boolean {
  return spans.some((span) => line >= span.bodyStartLine && line < span.closeLine);
}
