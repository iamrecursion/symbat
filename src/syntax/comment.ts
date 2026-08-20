// Make the editor's comment key produce Numbat `#` comments inside a `numbat` / `numbat-shared`
// fenced block.
//
// Obsidian's "Toggle comment" cannot be suppressed by intercepting the key (it is handled before
// any listener a plugin can register). So instead of racing the key, {@link numbatCommentFilter} is
// a CodeMirror transaction filter: when Obsidian's command inserts its `%%` comment markers inside
// a numbat block, the filter rewrites that whole transaction into the equivalent `#` line-comment
// toggle. Outside a numbat block the transaction passes through untouched, so Obsidian's Markdown
// comments still work everywhere else.
//
// The edit computation is a pure function (numbatCommentChanges), unit-tested in isolation; only
// the transaction inspection/rewrite depends on CodeMirror.

import { EditorState, type Transaction, type TransactionSpec } from "@codemirror/state";
import { blockRangesOf } from "../document/doc-cache";
import { type NumbatBlockRange } from "../document/fences";

/** Obsidian's Markdown comment marker, inserted by its Toggle comment command. */
const OBSIDIAN_COMMENT_MARKER = "%%";

/** A line's document offset and text, the input to {@link numbatCommentChanges}. */
export interface LineSlice {
  /** Document offset of the line's first character. */
  from: number;

  /** The line's text (without the trailing newline). */
  text: string;
}

/** A single CodeMirror change: an insertion (`insert`) or a deletion (`to`). */
export interface CommentChange {
  /** Document offset the change starts at. */
  from: number;

  /** Document offset the change ends at; omitted for a pure insertion. */
  to?: number;

  /** Text to insert; omitted for a pure deletion. */
  insert?: string;
}

// A leading `#` line comment: the indentation, then `#` and an optional single space (the space
// this toggle inserts, removed symmetrically on uncomment).
const LINE_COMMENT = /^(\s*)(#\s?)/;

/**
 * Compute the edits to toggle `#` line comments across `lines` (blank lines are ignored). If every
 * non-blank line is already commented, they are uncommented; otherwise a `# ` prefix is inserted
 * after each line's indentation. Returns an empty array when there is nothing to toggle.
 */
export function numbatCommentChanges(lines: readonly LineSlice[]): CommentChange[] {
  const nonBlank = lines.filter((line) => line.text.trim() !== "");
  if (nonBlank.length === 0) {
    return [];
  }

  const allCommented = nonBlank.every((line) => LINE_COMMENT.test(line.text));
  const changes: CommentChange[] = [];
  for (const line of nonBlank) {
    if (allCommented) {
      const match = LINE_COMMENT.exec(line.text);
      if (match === null) {
        continue;
      }

      const start = line.from + match[1].length;
      changes.push({ from: start, to: start + match[2].length });
    } else {
      const indent = (/^\s*/.exec(line.text)?.[0] ?? "").length;
      changes.push({ from: line.from + indent, insert: "# " });
    }
  }
  return changes;
}

/**
 * The 1-indexed document lines a `#` toggle should affect: every line the selection touches,
 * clipped to `block`'s body.
 *
 * The clip is the point. Obsidian's command fires on the whole selection, so a selection running
 * from mid-block past the closing fence into prose would otherwise comment the fence line (leaving
 * the block unterminated) and prefix the prose with `# `.
 *
 * `selectionLines` are 1-indexed inclusive line spans; `block`'s own line numbers are 0-indexed,
 * hence the conversions.
 */
export function toggledLineNumbers(
  selectionLines: readonly { first: number; last: number; }[],
  block: NumbatBlockRange,
): number[] {
  const firstBody = block.bodyStartLine + 1;

  // `closeLine` is the 0-indexed closing fence, so the last body line 1-indexed is that same number
  // (and for an unclosed block, the document's last line).
  const lastBody = block.closeLine;
  const lines = new Set<number>();
  for (const { first, last } of selectionLines) {
    for (let n = Math.max(first, firstBody); n <= Math.min(last, lastBody); n += 1) {
      lines.add(n);
    }
  }

  return [...lines].sort((a, b) => a - b);
}

/**
 * The `numbat` block whose body `tr` inserts an Obsidian comment marker (`%%`) into — i.e.
 * Obsidian's Toggle comment firing in a block — or `null`. The (per-document) block scan runs only
 * once a `%%` insertion is seen, so the common no-op transaction stays cheap.
 */
function obsidianCommentTarget(tr: Transaction): NumbatBlockRange | null {
  // A paste or drop of `%%` is text the user meant to insert, not the comment command; only the
  // command's own synthetic insertion should be rewritten.
  if (tr.isUserEvent("input.paste") || tr.isUserEvent("input.drop")) {
    return null;
  }

  let insertPos = -1;
  tr.changes.iterChanges((fromA, _toA, _fromB, _toB, inserted) => {
    if (insertPos !== -1) {
      return;
    }

    // Only a pure marker insertion (`%%`, possibly with whitespace) is the comment command; a paste
    // that merely contains `%%` amid other text is left alone.
    const text = inserted.toString();
    if (text.includes(OBSIDIAN_COMMENT_MARKER) && /^[%\s]+$/.test(text)) {
      insertPos = fromA;
    }
  });

  if (insertPos === -1) {
    return null;
  }

  const { doc } = tr.startState;
  const blocks = blockRangesOf(doc);
  const index = doc.lineAt(insertPos).number - 1; // 0-indexed for the block ranges.

  return blocks.find((block) => index >= block.bodyStartLine && index < block.closeLine) ?? null;
}

/** The `#` line-comment toggle for `state`'s current selection within `block`, or `null` when there
 *  is nothing to toggle. */
function numbatToggleSpec(state: EditorState, block: NumbatBlockRange): TransactionSpec | null {
  const { doc } = state;
  const selectionLines = state.selection.ranges.map((range) => ({
    first: doc.lineAt(range.from).number,
    last: doc.lineAt(range.to).number,
  }));
  const lines = toggledLineNumbers(selectionLines, block).map((n) => {
    const line = doc.line(n);
    return { from: line.from, text: line.text };
  });
  const changes = numbatCommentChanges(lines);

  return changes.length === 0 ? null : { changes, userEvent: "input.comment" };
}

/**
 * The transaction filter that turns Obsidian's Toggle comment into a Numbat `#` toggle inside a
 * numbat block. When a transaction inserts Obsidian's `%%` markers within a block, it is replaced
 * by the `#` toggle computed on the pre-transaction state (which decides comment vs uncomment from
 * the lines' current state); every other transaction — including the replacement, which inserts
 * `#`, not `%%` — is returned unchanged.
 */
export const numbatCommentFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) {
    return tr;
  }

  const block = obsidianCommentTarget(tr);
  if (block === null) {
    return tr;
  }

  return numbatToggleSpec(tr.startState, block) ?? tr;
});
