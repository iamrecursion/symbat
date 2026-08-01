import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDocumentScopeTree, scopeEntries } from "../../../src/scope/model.ts";

// A `.nbt` file's worth of declarations: the four kinds the inspector lists, a multi-line one (so
// the statement grouping matters), a bare expression that declares nothing, and a redefinition that
// shadows an earlier binding.
const LINES = [
  "# A personal prelude",
  "dimension Effort",
  "unit widget: Effort",
  "",
  "let rate = 3 widget / hour",
  "",
  "fn total(",
  "  hours: Time,",
  ") -> Effort = rate * hours",
  "",
  "total(2 hour)",
  "let rate = 4 widget / hour",
];

function tree(lines: string[] = LINES, prelude: { label: string; path: string; lines: string[]; }[] = []) {
  return buildDocumentScopeTree({ file: "prelude.nbt", label: "prelude", lines, preludeFiles: prelude });
}

/** Each entry as a readable tuple. */
function entries(lines?: string[]) {
  return scopeEntries(tree(lines)).map((entry) => [entry.declKind, entry.name, entry.defsite.line, entry.shadowed]);
}

test("every declaration in the file becomes an entry, at its own line", () => {
  assert.deepEqual(entries(), [
    ["dimension", "Effort", 1, false],
    ["unit", "widget", 2, false],
    // Shadowed by the redefinition on the last line.
    ["let", "rate", 4, true],
    // The defsite is the declaration's first line, not the statement's last.
    ["fn", "total", 6, false],
    ["let", "rate", 11, false],
  ]);
});

test("a defsite points into the file itself, so a jump stays in it", () => {
  const found = scopeEntries(tree()).find((entry) => entry.name === "widget");
  assert.deepEqual(found?.defsite, { notePath: null, line: 2, ch: 0 });
  assert.equal(found?.sourceKind, "file");
});

test("the whole file is one node, spanning every line", () => {
  const node = tree().nodes.find((candidate) => candidate.kind === "file");
  assert.equal(node?.label, "prelude");
  assert.deepEqual(node?.range, { fromLine: 0, toLine: LINES.length - 1 });
  assert.equal(node?.entries.length, 5);
});

test("a multi-line declaration replays as one statement, not three", () => {
  const total = tree().blocks[0].statements.find((statement) => statement.entry?.name === "total");
  assert.equal(total?.code, "fn total(\n  hours: Time,\n) -> Effort = rate * hours");
});

test("the prelude files ahead of this one are listed, and only those", () => {
  const built = tree(LINES, [{ label: "base", path: "base.nbt", lines: ["let g = 9.81 m / s^2"] }]);
  assert.deepEqual(built.prelude.map((file) => file.label), ["base"]);
  assert.deepEqual(built.prelude[0].entries.map((entry) => entry.name), ["g"]);
  // The prelude node precedes the file's own, as it does for a note.
  assert.deepEqual(built.nodes.map((node) => node.kind), ["prelude", "file"]);
});

test("a file with nothing to declare is empty, and one with a prelude is not", () => {
  assert.equal(tree(["# just a comment", "2 + 2"]).empty, true);
  assert.equal(
    buildDocumentScopeTree({
      file: "a.nbt",
      label: "a",
      lines: ["2 + 2"],
      preludeFiles: [{ label: "base", path: "base.nbt", lines: ["let g = 1"] }],
    }).empty,
    false,
  );
});

test("the signature moves with the file and with the prelude ahead of it", () => {
  const base = tree().signature;
  assert.notEqual(tree([...LINES, "let extra = 1"]).signature, base);
  assert.notEqual(tree(LINES, [{ label: "base", path: "base.nbt", lines: ["let g = 1"] }]).signature, base);
});
