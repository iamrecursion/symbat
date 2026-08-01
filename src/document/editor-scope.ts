// Where in a Markdown document the caret counts as "inside Numbat code": within a `numbat` /
// `numbat-shared` fenced block, or within an inline-eval span's expression. Shared by the editor
// affordances that behave differently there — unicode expansion (unicode/edit.ts) and the Markdown
// auto-pair guard (document/markdown-pair.ts). Pure (a CodeMirror `Text` and a position, no
// Obsidian or wasm imports), so it is unit-testable in isolation.
//
// A note's third Numbat region — a Numbat-typed property's value — cannot be decided from the text
// alone, since the type lives in Obsidian's registry; what belongs here is the half that can,
// {@link cursorInFrontmatter}.

import { type Text } from "@codemirror/state";
import { type InlineEvalConfig, inlineScopeAt, spanAtColumn } from "../evaluation/inline-parse";
import { type FenceSpan, inNumbatBody } from "./fence-state";
import { insideNumbatFence } from "./fences";
import { FRONTMATTER_CLOSE, FRONTMATTER_OPEN } from "./frontmatter";

/**
 * Whether document position `pos` sits inside a `numbat`/`numbat-shared` block.
 *
 * `spans` is the editor's maintained fence index (document/fence-state.ts) when the caller has one,
 * making this O(blocks) instead of a walk from line 0 — which is what keeps these checks off the
 * cost of every keystroke. Omitted (tests, and any caller without an editor), it falls back to
 * scanning.
 */
export function cursorInNumbatFence(doc: Text, pos: number, spans?: readonly FenceSpan[]): boolean {
  const cursorLine = doc.lineAt(pos).number; // 1-indexed
  if (spans !== undefined) {
    return inNumbatBody(spans, cursorLine - 1);
  }

  // `iterLines(1, cursorLine)` yields the lines strictly before the cursor line as a sequential
  // O(n) cursor (no per-line `doc.line(n)` tree walk, no array).
  return insideNumbatFence(doc.iterLines(1, cursorLine));
}

/** Whether document position `pos` sits inside an inline-eval span's expression region, on a line
 *  that is in an inline-eval scope (prose, or frontmatter / a non-numbat fence per the config). */
export function cursorInInlineExpr(doc: Text, pos: number, config: InlineEvalConfig): boolean {
  const line = doc.lineAt(pos);
  if (spanAtColumn(line.text, pos - line.from, config) === null) {
    return false;
  }

  // `iterLines(1, line.number + 1)` yields every line up to and including the cursor line, which is
  // what the scope walk expects.
  return inlineScopeAt(doc.iterLines(1, line.number + 1), config);
}

/**
 * Whether position `pos` sits inside the note's frontmatter: an opening `---` on the first line,
 * and no closing delimiter between it and the position's line.
 *
 * This is the cheap half of "is the caret in a Numbat-typed property's value"
 * (document/markdown-pair.ts). It answers on the first line for a note with no frontmatter and at
 * the closing delimiter for everything below it, which is what keeps reading the whole document —
 * and asking Obsidian for a property's assigned type — off the keystroke path for every position
 * that is not in frontmatter.
 */
export function cursorInFrontmatter(doc: Text, pos: number): boolean {
  let seen = 0;

  // As above, the lines strictly before the position's own line.
  for (const text of doc.iterLines(1, doc.lineAt(pos).number)) {
    if (seen === 0 && !FRONTMATTER_OPEN.test(text)) {
      return false;
    }
    if (seen > 0 && FRONTMATTER_CLOSE.test(text)) {
      return false;
    }
    seen += 1;
  }

  return seen > 0; // the opening delimiter itself is not inside
}

/** Either of the first two: the caret is somewhere the text alone says is Numbat, not Markdown
 *  prose. `inline` is `null` when inline evaluation is disabled (then only the fenced blocks
 *  count). */
export function cursorInNumbatCode(
  doc: Text,
  pos: number,
  inline: InlineEvalConfig | null,
  spans?: readonly FenceSpan[],
): boolean {
  return cursorInNumbatFence(doc, pos, spans) || (inline !== null && cursorInInlineExpr(doc, pos, inline));
}
