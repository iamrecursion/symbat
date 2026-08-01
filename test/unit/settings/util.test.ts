import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isValidCssFontSize,
  moveItem,
  normalizePreludeFiles,
  parseCodeSpans,
  preludeSourceBefore,
} from "../../../src/settings/util.ts";

test("moveItem moves an item earlier and returns a new array", () => {
  const input = ["a", "b", "c"];
  assert.deepEqual(moveItem(input, 2, 0), ["c", "a", "b"]);
  assert.deepEqual(input, ["a", "b", "c"], "input is not mutated");
});

test("moveItem moves an item later", () => {
  assert.deepEqual(moveItem(["a", "b", "c"], 0, 1), ["b", "a", "c"]);
});

test("moveItem clamps the destination into range", () => {
  assert.deepEqual(moveItem(["a", "b", "c"], 0, 99), ["b", "c", "a"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 2, -5), ["c", "a", "b"]);
});

test("moveItem is a no-op when source is out of range", () => {
  assert.deepEqual(moveItem(["a", "b"], 5, 0), ["a", "b"]);
  assert.deepEqual(moveItem([], 0, 0), []);
});

test("moveItem to the same index is a no-op copy", () => {
  assert.deepEqual(moveItem(["a", "b", "c"], 1, 1), ["a", "b", "c"]);
});

test("isValidCssFontSize accepts var() references", () => {
  assert.equal(isValidCssFontSize("var(--code-size)"), true);
  assert.equal(isValidCssFontSize("var(--code-size, 0.9em)"), true);
  assert.equal(isValidCssFontSize("  var(--my-size)  "), true);
});

test("isValidCssFontSize accepts numeric lengths with a unit", () => {
  for (const v of ["14px", "0.9em", "1.25rem", "100%", "12pt", "3vh", "4vw"]) {
    assert.equal(isValidCssFontSize(v), true, v);
  }
});

test("isValidCssFontSize rejects unitless, empty, and unsafe values", () => {
  for (const v of ["", "14", "14 px", "red", "calc(1em + 2px)", "var(--x); color:red", "16px;"]) {
    assert.equal(isValidCssFontSize(v), false, v);
  }
});

test("normalizePreludeFiles keeps and coerces the current {name, path} shape", () => {
  assert.deepEqual(
    normalizePreludeFiles([{ name: "SI", path: "prelude.nbt" }, { name: "", path: "b.nbt" }]),
    [{ name: "SI", path: "prelude.nbt" }, { name: "", path: "b.nbt" }],
  );
  assert.deepEqual(normalizePreludeFiles([{ path: "x.nbt" }]), [{ name: "", path: "x.nbt" }]);
  assert.deepEqual(normalizePreludeFiles([]), []);
});

test("normalizePreludeFiles migrates the legacy string-path array", () => {
  assert.deepEqual(
    normalizePreludeFiles(undefined, ["a.nbt", "sub/b.nbt"]),
    [{ name: "", path: "a.nbt" }, { name: "", path: "sub/b.nbt" }],
  );
});

test("normalizePreludeFiles returns empty for missing or junk data", () => {
  assert.deepEqual(normalizePreludeFiles(undefined), []);
  assert.deepEqual(normalizePreludeFiles(null, null), []);
  assert.deepEqual(normalizePreludeFiles("nope"), []);
  assert.deepEqual(normalizePreludeFiles([null, 3, "x"]), []);
});

// --- parseCodeSpans ----------------------------------------------------------

test("parseCodeSpans splits prose from backtick code spans", () => {
  assert.deepEqual(parseCodeSpans("Types such as `Bool` and `String`."), [
    { text: "Types such as ", code: false },
    { text: "Bool", code: true },
    { text: " and ", code: false },
    { text: "String", code: true },
    { text: ".", code: false },
  ]);
});

test("parseCodeSpans returns plain text unchanged (no backticks)", () => {
  assert.deepEqual(parseCodeSpans("A CSS size such as 14px."), [{ text: "A CSS size such as 14px.", code: false }]);
});

test("parseCodeSpans handles a leading code span and back-to-back spans", () => {
  assert.deepEqual(parseCodeSpans("`to` `per`"), [
    { text: "to", code: true },
    { text: " ", code: false },
    { text: "per", code: true },
  ]);
});

test("parseCodeSpans treats an unpaired backtick as literal text", () => {
  assert.deepEqual(parseCodeSpans("a `b"), [{ text: "a `b", code: false }]);
});

test("parseCodeSpans treats a backtick run with no matching closer as literal text", () => {
  // A lone `` `` `` never finds a second run of exactly two, so it stays prose.
  assert.deepEqual(parseCodeSpans("a `` b"), [{ text: "a `` b", code: false }]);
});

test("parseCodeSpans shows literal backticks inside a double-backtick span", () => {
  // The settings descriptions write inline-eval examples this way; the rendered <code> must keep
  // the inner backticks the user is meant to type.
  assert.deepEqual(parseCodeSpans("Type `` n`5 km + 3 mi` `` for a result."), [
    { text: "Type ", code: false },
    { text: "n`5 km + 3 mi`", code: true },
    { text: " for a result.", code: false },
  ]);
});

test("parseCodeSpans keeps a run of a different length as span content", () => {
  // A single-backtick run inside a double-backtick span is content, not a closer.
  assert.deepEqual(parseCodeSpans("`` a ` b ``"), [{ text: "a ` b", code: true }]);
});

// The user prelude, as loaded: three files in the order they apply.
const PARTS = [
  { path: "base.nbt", source: "let g = 9.81 m / s^2" },
  { path: "units.nbt", source: "unit widget" },
  { path: "extra.nbt", source: "let answer = 42" },
];

test("preludeSourceBefore applies every part when nothing is named", () => {
  assert.equal(preludeSourceBefore(PARTS), "let g = 9.81 m / s^2\n\nunit widget\n\nlet answer = 42");
});

test("preludeSourceBefore stops at the named file, which is what that file sees", () => {
  assert.equal(preludeSourceBefore(PARTS, "units.nbt"), "let g = 9.81 m / s^2");
  // The first file sees nothing but Numbat's own prelude.
  assert.equal(preludeSourceBefore(PARTS, "base.nbt"), null);
  assert.equal(preludeSourceBefore(PARTS, "extra.nbt"), "let g = 9.81 m / s^2\n\nunit widget");
});

test("preludeSourceBefore applies everything for a file outside the prelude", () => {
  // The ordinary case: a `.nbt` file that is not configured as a prelude, and every caller that
  // names no file at all. Pinned against the concatenation itself rather than against
  // `preludeSourceBefore(PARTS)` — comparing the function to itself would hold just as well if it
  // always returned null.
  const whole = PARTS.map((part) => part.source).join("\n\n");
  assert.equal(preludeSourceBefore(PARTS, "scratch.nbt"), whole);
  assert.equal(preludeSourceBefore(PARTS), whole);
});

test("preludeSourceBefore reports no prelude rather than an empty one", () => {
  assert.equal(preludeSourceBefore([]), null);
  assert.equal(preludeSourceBefore([], "base.nbt"), null);
});
