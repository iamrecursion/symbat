import { EditorSelection, EditorState, type SelectionRange, type StateCommand } from "@codemirror/state";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  indentUnitFor,
  insertIndent,
  MAX_INDENT_WIDTH,
  MIN_INDENT_WIDTH,
  numbatIndentUnit,
  removeIndent,
} from "../../../src/views/indent.ts";

/** A document with `|` marking each caret, or `[` … `]` marking a selection range. */
interface Marked {
  doc: string;
  selection: EditorSelection;
}

/** Strip the caret/selection markers from `marked`, recording where they were. */
function parse(marked: string): Marked {
  const ranges: SelectionRange[] = [];
  let doc = "";
  let anchor: number | null = null;
  for (const char of marked) {
    if (char === "|") {
      ranges.push(EditorSelection.cursor(doc.length));
    } else if (char === "[") {
      anchor = doc.length;
    } else if (char === "]") {
      ranges.push(EditorSelection.range(anchor ?? doc.length, doc.length));
      anchor = null;
    } else {
      doc += char;
    }
  }
  return { doc, selection: EditorSelection.create(ranges) };
}

/** Run `command` over a marked document, returning the resulting text with the carets marked back
 *  in — so a test asserts on both the edit and where the cursor ended up. */
function run(command: StateCommand, marked: string, width = 2): string {
  const { doc, selection } = parse(marked);
  const state = EditorState.create({
    doc,
    selection,
    extensions: [numbatIndentUnit(width), EditorState.allowMultipleSelections.of(true)],
  });
  let result = state;
  command({ state, dispatch: (transaction) => void (result = transaction.state) });

  let out = "";
  let last = 0;
  for (const range of result.selection.ranges) {
    out += result.doc.sliceString(last, range.head) + "|";
    last = range.head;
  }
  return out + result.doc.sliceString(last);
}

test("a caret at the line start inserts a full indent, at the caret", () => {
  assert.equal(run(insertIndent, "|let x = 1"), "  |let x = 1");
  assert.equal(run(insertIndent, "|let x = 1", 4), "    |let x = 1");
});

test("a caret mid-line inserts at the caret, not at the start of the line", () => {
  // The whole reason this module exists: CodeMirror's own `indentMore` would put the spaces at
  // `line.from`, indenting the line instead of the cursor.
  assert.equal(run(insertIndent, "let| x = 1"), "let | x = 1");
});

test("a caret mid-line aligns to the next tab stop", () => {
  // Column 3, width 2 -> one space, landing on column 4.
  assert.equal(run(insertIndent, "let|  x = 1"), "let |  x = 1");

  // Already on a stop -> a full unit.
  assert.equal(run(insertIndent, "let |  x = 1"), "let   |  x = 1");

  // Column 3, width 4 -> one space, landing on column 4.
  assert.equal(run(insertIndent, "let|  x = 1", 4), "let |  x = 1");
});

test("each caret of a multiple selection gets its own indent", () => {
  assert.equal(run(insertIndent, "|a = 1\n|b = 2"), "  |a = 1\n  |b = 2");
});

test("a selection within one line indents the line from its start", () => {
  assert.equal(run(insertIndent, "let [x] = 1"), "  let x| = 1");
});

test("a multi-line selection indents every line it spans, once each", () => {
  assert.equal(run(insertIndent, "[a = 1\nb = 2\nc = 3]"), "  a = 1\n  b = 2\n  c = 3|");
});

test("Shift-Tab rounds the indentation down to the previous stop", () => {
  // A column already on a stop steps back a whole unit.
  assert.equal(run(removeIndent, "    let x = 1|"), "  let x = 1|");

  // One off the grid rounds down onto it, rather than subtracting a unit (which would give 1).
  assert.equal(run(removeIndent, "   let x = 1|"), "  let x = 1|");
  assert.equal(run(removeIndent, "   let x = 1|", 4), "let x = 1|");
  assert.equal(run(removeIndent, " let x = 1|"), "let x = 1|");
});

test("Shift-Tab dedents every line a selection spans", () => {
  assert.equal(run(removeIndent, "[    a = 1\n   b = 2\nc = 3]"), "  a = 1\n  b = 2\nc = 3|");
});

test("Shift-Tab leaves an unindented line alone, but still consumes the key", () => {
  // It reports that it handled the key either way (so Shift-Tab never moves focus backwards out of
  // the editor), which is why this asserts on the document rather than the return value.
  assert.equal(run(removeIndent, "let x = 1|"), "let x = 1|");
});

test("Tab then Shift-Tab round-trips the text", () => {
  for (const width of [2, 4]) {
    const once = run(insertIndent, "|let x = 1", width);
    assert.equal(run(removeIndent, once, width), "|let x = 1");
  }
});

test("indentUnitFor clamps to a usable width and is never empty", () => {
  assert.equal(indentUnitFor(2), "  ");
  assert.equal(indentUnitFor(MIN_INDENT_WIDTH), " ");
  assert.equal(indentUnitFor(MAX_INDENT_WIDTH), " ".repeat(MAX_INDENT_WIDTH));

  // An empty unit makes `indentUnit`'s combiner throw, so zero and below must clamp up.
  assert.equal(indentUnitFor(0), " ");
  assert.equal(indentUnitFor(-1), " ");
  assert.equal(indentUnitFor(Number.NaN), " ");
  assert.equal(indentUnitFor(Number.NEGATIVE_INFINITY), " ");
  assert.equal(indentUnitFor(Number.POSITIVE_INFINITY), " ".repeat(MAX_INDENT_WIDTH));
  assert.equal(indentUnitFor(99), " ".repeat(MAX_INDENT_WIDTH));
  assert.equal(indentUnitFor(2.7), "  ");
});

test("a nonsensical width still builds a state, rather than throwing on open", () => {
  // `EditorState.create` is called from the NumbatInput constructor: a throw here is a `.nbt` file
  // that will not open at all.
  for (const width of [0, -1, Number.NaN, 1000]) {
    assert.doesNotThrow(() => EditorState.create({ extensions: [numbatIndentUnit(width)] }));
  }
});
