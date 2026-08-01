import assert from "node:assert/strict";
import { test } from "node:test";
import { collectImports, type ImportResolver, parseNumbatUse } from "../../../src/imports/parse.ts";

// --- parseNumbatUse -----------------------------------------------------------

test("numbat-use reads a single string, a wikilink, and a list", () => {
  assert.deepEqual(parseNumbatUse("Lib"), ["Lib"]);
  assert.deepEqual(parseNumbatUse("[[Lib]]"), ["Lib"]);
  assert.deepEqual(parseNumbatUse(["[[A]]", "B", "[[C]]"]), ["A", "B", "C"]);
});

test("numbat-use strips a wikilink alias and subpath, and folder paths survive", () => {
  assert.deepEqual(parseNumbatUse("[[Lib|display]]"), ["Lib"]);
  assert.deepEqual(parseNumbatUse("[[Lib#Heading]]"), ["Lib"]);
  assert.deepEqual(parseNumbatUse("[[Lib#Heading|display]]"), ["Lib"]);
  assert.deepEqual(parseNumbatUse("folder/Lib"), ["folder/Lib"]);
});

test("numbat-use ignores non-strings and empties", () => {
  assert.deepEqual(parseNumbatUse(undefined), []);
  assert.deepEqual(parseNumbatUse(null), []);
  assert.deepEqual(parseNumbatUse([42, true, "Lib", "  ", "[[]]"]), ["Lib"]);
});

// --- collectImports -----------------------------------------------------------

function mockResolver(nodes: Record<string, { uses: string[]; chunks: string[]; }>): ImportResolver {
  return {
    resolve: (linkpath) => (linkpath in nodes ? linkpath : null),
    node: (id) => nodes[id] ?? null,
  };
}

const ROOT = "ROOT";

test("a single import contributes its chunks", () => {
  const r = mockResolver({ A: { uses: [], chunks: ["a"] } });
  const { chunks, order } = collectImports(["A"], ROOT, r);
  assert.deepEqual(chunks, ["a"]);
  assert.deepEqual(order, ["A"]);
});

test("a note's several chunks stay together and in order", () => {
  const r = mockResolver({ A: { uses: [], chunks: ["a1", "a2"] } });
  const { chunks } = collectImports(["A"], ROOT, r);
  assert.deepEqual(chunks, ["a1", "a2"]);
});

test("a dependency lands before the note that uses it", () => {
  const r = mockResolver({ A: { uses: ["B"], chunks: ["a"] }, B: { uses: [], chunks: ["b"] } });
  const { chunks, order } = collectImports(["A"], ROOT, r);
  assert.deepEqual(order, ["B", "A"]);
  assert.deepEqual(chunks, ["b", "a"]);
});

test("a diamond emits the shared dependency once", () => {
  const r = mockResolver({
    A: { uses: ["C"], chunks: ["a"] },
    B: { uses: ["C"], chunks: ["b"] },
    C: { uses: [], chunks: ["c"] },
  });
  const { chunks, order } = collectImports(["A", "B"], ROOT, r);
  assert.deepEqual(order, ["C", "A", "B"]);
  assert.deepEqual(chunks, ["c", "a", "b"]);
});

test("a cycle is broken, not looped", () => {
  const r = mockResolver({
    A: { uses: ["B"], chunks: ["a"] },
    B: { uses: ["A"], chunks: ["b"] },
  });
  const { chunks, order } = collectImports(["A"], ROOT, r);
  assert.deepEqual(order, ["B", "A"]);
  assert.deepEqual(chunks, ["b", "a"]);
});

test("an import pointing back at the importing note is skipped", () => {
  const r = mockResolver({ A: { uses: [ROOT], chunks: ["a"] } });
  const { chunks, order } = collectImports(["A", ROOT], ROOT, r);
  assert.deepEqual(order, ["A"]);
  assert.deepEqual(chunks, ["a"]);
});

test("a broken link and an unreadable node are skipped", () => {
  const r: ImportResolver = {
    resolve: (linkpath) => (linkpath === "missing" ? null : linkpath),
    node: (id) => (id === "unreadable" ? null : { uses: [], chunks: [id] }),
  };
  const { chunks, order } = collectImports(["missing", "unreadable", "ok"], ROOT, r);
  assert.deepEqual(order, ["ok"]);
  assert.deepEqual(chunks, ["ok"]);
});

test("a re-exporting note with no chunks of its own still orders its dependency", () => {
  const r = mockResolver({ A: { uses: ["B"], chunks: [] }, B: { uses: [], chunks: ["b"] } });
  const { chunks, order } = collectImports(["A"], ROOT, r);
  assert.deepEqual(order, ["B", "A"]);
  assert.deepEqual(chunks, ["b"]);
});
