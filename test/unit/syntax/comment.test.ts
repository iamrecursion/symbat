import { EditorState } from "@codemirror/state";
import assert from "node:assert/strict";
import { test } from "node:test";
import { type LineSlice, numbatCommentChanges, numbatCommentFilter } from "../../../src/syntax/comment.ts";

/** Build LineSlices for consecutive lines starting at document offset 0. */
function slices(...texts: string[]): LineSlice[] {
  const lines: LineSlice[] = [];
  let from = 0;
  for (const text of texts) {
    lines.push({ from, text });
    from += text.length + 1; // + newline
  }
  return lines;
}

/** Apply computed changes to the joined document, to assert the toggled text. */
function apply(texts: string[]): string {
  const doc = texts.join("\n");
  const changes = numbatCommentChanges(slices(...texts));
  // Apply right-to-left so earlier offsets stay valid.
  let out = doc;
  for (const change of [...changes].sort((a, b) => b.from - a.from)) {
    const to = change.to ?? change.from;
    out = out.slice(0, change.from) + (change.insert ?? "") + out.slice(to);
  }
  return out;
}

test("comments an uncommented line, after its indentation", () => {
  assert.equal(apply(["1 + 1"]), "# 1 + 1");
  assert.equal(apply(["  2 km"]), "  # 2 km");
});

test("uncomments when every non-blank line is already commented", () => {
  assert.equal(apply(["# 1 + 1"]), "1 + 1");
  assert.equal(apply(["  # 2 km"]), "  2 km");
});

test("uncomment removes a `#` with no following space too", () => {
  assert.equal(apply(["#1 + 1"]), "1 + 1");
});

test("a mixed block comments the whole selection (not all were commented)", () => {
  assert.equal(apply(["# a", "b"]), "# # a\n# b");
});

test("blank lines are skipped, and drive neither the decision nor an edit", () => {
  // Both non-blank lines are commented, so the block uncomments; the blank line in the middle is
  // untouched.
  assert.equal(apply(["# a", "", "# b"]), "a\n\nb");
  assert.equal(numbatCommentChanges(slices("", "  ")).length, 0);
});

// The transaction filter simulates Obsidian's Toggle comment by inserting `%%` markers, then
// asserts the filter rewrote them into a `#` toggle (or not).
function stateWithCursorOn(needle: string, doc: string) {
  return EditorState.create({
    doc,
    selection: { anchor: doc.indexOf(needle) },
    extensions: [numbatCommentFilter],
  });
}

function insertMarkers(state: EditorState): string {
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  // Wrap the line in `%%`, as Obsidian's Markdown Toggle comment does.
  return state
    .update({ changes: [{ from: line.from, insert: "%%" }, { from: line.to, insert: "%%" }] })
    .state.doc.toString();
}

test("filter rewrites Obsidian's %% into a # comment inside a numbat block", () => {
  const doc = ["```numbat", "1 + 1", "```"].join("\n");
  const out = insertMarkers(stateWithCursorOn("1 + 1", doc));
  assert.match(out, /```numbat\n# 1 \+ 1\n```/);
  assert.doesNotMatch(out, /%%/);
});

test("filter uncomments a #-commented numbat line when Obsidian's %% fires", () => {
  const doc = ["```numbat", "# 1 + 1", "```"].join("\n");
  const out = insertMarkers(stateWithCursorOn("# 1 + 1", doc));
  assert.match(out, /```numbat\n1 \+ 1\n```/);
  assert.doesNotMatch(out, /%%/);
});

test("filter leaves %% untouched outside a numbat block", () => {
  const doc = ["Just prose.", "```numbat", "1 + 1", "```"].join("\n");
  const out = insertMarkers(stateWithCursorOn("Just prose.", doc));
  assert.match(out, /%%Just prose\.%%/);
});

test("filter rewrites a %%…%% wrap around a multi-line selection into per-line #", () => {
  const doc = ["```numbat", "1 + 1", "2 + 2", "```"].join("\n");
  const from = doc.indexOf("1 + 1");
  const to = doc.indexOf("2 + 2") + "2 + 2".length;
  const state = EditorState.create({
    doc,
    selection: { anchor: from, head: to },
    extensions: [numbatCommentFilter],
  });
  // Obsidian's wrap: `%%` before the selection and `%%` after it, in one transaction.
  const out = state
    .update({ changes: [{ from, insert: "%%" }, { from: to, insert: "%%" }] })
    .state.doc.toString();
  assert.match(out, /```numbat\n# 1 \+ 1\n# 2 \+ 2\n```/);
  assert.doesNotMatch(out, /%%/);
});

test("filter ignores a paste that merely contains %% (not the comment command)", () => {
  const doc = ["```numbat", "1 + 1", "```"].join("\n");
  const state = stateWithCursorOn("1 + 1", doc);
  const pos = state.selection.main.head;
  // A single insertion of arbitrary text containing `%%` — a paste, not a toggle.
  const out = state.update({ changes: [{ from: pos, insert: "a %% b" }] }).state.doc.toString();
  assert.match(out, /a %% b1 \+ 1/); // inserted verbatim, not rewritten to a `#` toggle
});

test("filter clips the toggle to the block body when the selection runs past the fence", () => {
  const doc = [
    "```numbat", // 0
    "1 + 1", // 1
    "2 + 2", // 2
    "```", // 3
    "prose one", // 4
    "prose two", // 5
  ].join("\n");
  const from = doc.indexOf("2 + 2");
  const to = doc.indexOf("prose two") + "prose two".length;
  const state = EditorState.create({
    doc,
    selection: { anchor: from, head: to },
    extensions: [numbatCommentFilter],
  });
  const out = state
    .update({ changes: [{ from, insert: "%%" }, { from: to, insert: "%%" }] })
    .state.doc.toString();
  // Only the in-block line is toggled; the closing fence and the prose below it are left exactly as
  // they were.
  assert.equal(out, ["```numbat", "1 + 1", "# 2 + 2", "```", "prose one", "prose two"].join("\n"));
});

test("filter leaves a pasted %% alone inside a numbat block", () => {
  const doc = ["```numbat", "1 + 1", "```"].join("\n");
  const at = doc.indexOf("1 + 1");
  const state = EditorState.create({ doc, selection: { anchor: at }, extensions: [numbatCommentFilter] });
  const out = state
    .update({ changes: { from: at, insert: "%%" }, userEvent: "input.paste" })
    .state.doc.toString();
  assert.match(out, /```numbat\n%%1 \+ 1\n```/, "the paste lands as typed");
  assert.doesNotMatch(out, /#/, "and is not turned into a comment toggle");
});
