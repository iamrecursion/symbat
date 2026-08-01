import { EditorState } from "@codemirror/state";
import assert from "node:assert/strict";
import { test } from "node:test";
import { type CodeCompletion, replUnicodeExpansionEdit, unicodeExpansionEdit } from "../../../src/unicode/edit.ts";

// A stand-in for the wasm's `get_unicode_completion`: matches a `\code` at the very end of the
// text, returning [length-including-backslash, replacement].
const CODES: Record<string, string> = { "\\alpha": "α", "\\pi": "π" };
function lookup(before: string): CodeCompletion | null {
  for (const [code, replacement] of Object.entries(CODES)) {
    if (before.endsWith(code)) {
      return { replaceLength: code.length, replacement };
    }
  }
  return null;
}

/** Compute the edit for typing `text` at the end of 1-indexed `lineNo` of `doc`. */
function editAtEndOfLine(doc: string, lineNo: number, text: string, leader = "\\") {
  const state = EditorState.create({ doc });
  const from = state.doc.line(lineNo).to;
  return { state, from, edit: unicodeExpansionEdit(state.doc, from, from, text, leader, lookup) };
}

test("expands a completed code inside a numbat block and drops the typed char", () => {
  const doc = ["```numbat", "x = \\alph", "```"].join("\n");
  const { state, from, edit } = editAtEndOfLine(doc, 2, "a");
  assert.notEqual(edit, null);
  // Replaces the `\alph` already present (the typed `a` is dropped) with `α`.
  assert.deepEqual(edit, { from: from - 5, to: from, insert: "α" });
  // Applying it yields the expected document.
  const next = state.update({ changes: edit }).state;
  assert.equal(next.doc.toString(), ["```numbat", "x = α", "```"].join("\n"));
});

test("expands inside a numbat-shared block too", () => {
  const doc = ["```numbat-shared", "\\p", "```"].join("\n");
  const { state, edit } = editAtEndOfLine(doc, 2, "i");
  assert.notEqual(edit, null);
  const next = state.update({ changes: edit! }).state;
  assert.equal(next.doc.toString(), ["```numbat-shared", "π", "```"].join("\n"));
});

test("does not expand outside a numbat block", () => {
  const doc = ["prose", "x = \\alph", "more"].join("\n");
  const { edit } = editAtEndOfLine(doc, 2, "a");
  assert.equal(edit, null);
});

test("handles a cursor on the first line (no preceding lines) without throwing", () => {
  // Exercises the `iterLines(1, 1)` empty-range path: line 1 has nothing before it, so it can never
  // be inside a fence.
  const doc = ["\\alph", "```numbat", "```"].join("\n");
  const { edit } = editAtEndOfLine(doc, 1, "a");
  assert.equal(edit, null);
});

test("does not expand an unknown code", () => {
  const doc = ["```numbat", "\\xy", "```"].join("\n");
  const { edit } = editAtEndOfLine(doc, 2, "z"); // "\\xyz" is not in CODES
  assert.equal(edit, null);
});

test("ignores a non-code tail (no leading backslash)", () => {
  const doc = ["```numbat", "alph", "```"].join("\n");
  const { edit } = editAtEndOfLine(doc, 2, "a"); // "alpha", no backslash
  assert.equal(edit, null);
});

test("ignores multi-character insertions (e.g. paste)", () => {
  const doc = ["```numbat", "\\alp", "```"].join("\n");
  const { edit } = editAtEndOfLine(doc, 2, "ha");
  assert.equal(edit, null);
});

test("ignores insertions over a non-empty selection", () => {
  const doc = ["```numbat", "x = \\alph", "```"].join("\n");
  const state = EditorState.create({ doc });
  const line = state.doc.line(2);
  // A range selection (from < to) rather than a collapsed cursor.
  const edit = unicodeExpansionEdit(state.doc, line.from, line.to, "a", "\\", lookup);
  assert.equal(edit, null);
});

// The frontmatter property scope is injected (only Obsidian knows a property's assigned type), so
// these pin the wiring: the same keystroke expands or not purely by what the predicate answers, and
// it is never consulted for a keystroke the cheaper tests have already rejected.

test("expands in a frontmatter property's value when the caller says it is Numbat", () => {
  const doc = ["---", "angle: \\alph", "---", "prose"].join("\n");
  const state = EditorState.create({ doc });
  const from = state.doc.line(2).to;
  const edit = unicodeExpansionEdit(state.doc, from, from, "a", "\\", lookup, null, () => true);
  assert.deepEqual(edit, { from: from - 5, to: from, insert: "α" });
  const next = state.update({ changes: edit }).state;
  assert.equal(next.doc.toString(), ["---", "angle: α", "---", "prose"].join("\n"));
});

test("does not expand in frontmatter when the property is not Numbat-typed", () => {
  const doc = ["---", "title: \\alph", "---", "prose"].join("\n");
  const state = EditorState.create({ doc });
  const from = state.doc.line(2).to;
  assert.equal(unicodeExpansionEdit(state.doc, from, from, "a", "\\", lookup, null, () => false), null);
  // And with no predicate at all, frontmatter is prose like anywhere else.
  assert.equal(unicodeExpansionEdit(state.doc, from, from, "a", "\\", lookup), null);
});

test("the property scope is not consulted without a code tail to expand", () => {
  const doc = ["---", "angle: 90", "---"].join("\n");
  const state = EditorState.create({ doc });
  const from = state.doc.line(2).to;
  let asked = 0;
  const edit = unicodeExpansionEdit(state.doc, from, from, "x", "\\", lookup, null, () => {
    asked += 1;
    return true;
  });
  assert.equal(edit, null);
  assert.equal(asked, 0, "the whole-note read stays off ordinary keystrokes");
});

test("uses the completion's replaceLength for a multi-character leader", () => {
  // A stand-in mirroring getUnicodeCompletion's leader translation: for the `;;` leader it reports
  // the length of the whole `;;alpha` (leader + name).
  const leaderLookup = (before: string): CodeCompletion | null =>
    before.endsWith(";;alpha") ? { replaceLength: 7, replacement: "α" } : null;
  const doc = ["```numbat", "x = ;;alph", "```"].join("\n");
  const state = EditorState.create({ doc });
  const from = state.doc.line(2).to;
  const edit = unicodeExpansionEdit(state.doc, from, from, "a", ";;", leaderLookup);
  assert.notEqual(edit, null);
  // Deletes leader.length + name.length - 1 = 2 + 5 - 1 = 6 chars (`;;alph`).
  assert.deepEqual(edit, { from: from - 6, to: from, insert: "α" });
  const next = state.update({ changes: edit }).state;
  assert.equal(next.doc.toString(), ["```numbat", "x = α", "```"].join("\n"));
});

// --- replUnicodeExpansionEdit: fence-free (the REPL input is wholly Numbat) ----

/** Compute the REPL expansion for typing `text` at the end of a bare `doc`. */
function replEditAtEnd(doc: string, text: string, leader = "\\") {
  const state = EditorState.create({ doc });
  const from = state.doc.length;
  return { state, from, edit: replUnicodeExpansionEdit(state.doc, from, from, text, leader, lookup) };
}

test("REPL variant expands a completed code with no surrounding fence", () => {
  // The plain, un-fenced text that the fenced variant refuses (see below).
  const { state, from, edit } = replEditAtEnd("x = \\alph", "a");
  assert.notEqual(edit, null);
  assert.deepEqual(edit, { from: from - 5, to: from, insert: "α" });
  const next = state.update({ changes: edit }).state;
  assert.equal(next.doc.toString(), "x = α");
});

test("fenced and REPL variants differ only on the fence requirement", () => {
  const doc = "\\p";
  const state = EditorState.create({ doc });
  const from = state.doc.length;
  // Same input: the fenced variant declines (no fence), the REPL variant expands.
  assert.equal(unicodeExpansionEdit(state.doc, from, from, "i", "\\", lookup), null);
  assert.deepEqual(replUnicodeExpansionEdit(state.doc, from, from, "i", "\\", lookup), {
    from: from - 2,
    to: from,
    insert: "π",
  });
});

test("REPL variant still ignores a non-code tail and unknown codes", () => {
  assert.equal(replEditAtEnd("alph", "a").edit, null); // no leading backslash
  assert.equal(replEditAtEnd("\\xy", "z").edit, null); // "\\xyz" is unknown
});
