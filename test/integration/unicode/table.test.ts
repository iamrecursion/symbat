// The golden test for the committed `\code` table (src/unicode/table.ts).
//
// The table is a hand-checked transcription of Numbat's `unicode_input.rs`, which means it can
// drift the moment `NUMBAT_TAG` moves — and the drift would be silent, since a missing code just
// stops expanding and a wrong glyph is a character nobody looks at twice. So this compares the
// committed table against the interpreter that ships beside it, in **both** directions: every row
// resolves in the wasm to the same replacement and the same length, and the wasm knows no code the
// table is missing.
//
// Reading the wasm's side out is indirect, because Numbat exposes no dump of the table. The
// completion vocabulary (`get_completions_for("")`) contains every code name — among keywords,
// units, functions and variables — and `get_unicode_completion` is what tells the codes apart from
// the rest. That is the same pipeline the plugin used before the table existed, kept here as the
// oracle rather than as production code.

import assert from "node:assert/strict";
import { test } from "node:test";
import { listUnicodeCompletions, unicodeExpansionAt } from "../../../src/unicode/expand.ts";
import { UNICODE_INPUT } from "../../../src/unicode/table.ts";
import { loadNumbat, skip } from "../wasm-pkg.ts";

/** The wasm's answer for one `\code` query: `[length, replacement]`, or `null` for a non-code. */
function wasmLookup(nb: any, query: string): { replaceLength: number; replacement: string; } | null {
  const result = nb.get_unicode_completion(query) as unknown[];
  return Array.isArray(result) && result.length === 2
    ? { replaceLength: Number(result[0]), replacement: String(result[1]) }
    : null;
}

// The contract the table's `replaceLength` is transcribed against: the length counts the leading
// backslash, only the tail matches, and a non-code gives an empty array rather than a null.
test("get_unicode_completion answers with [length, replacement]", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(false, false, FormatType.Html);

  assert.deepEqual(nb.get_unicode_completion("x = \\alpha"), [6, "α"]);
  assert.deepEqual(nb.get_unicode_completion("\\alpha + 1"), []);
  assert.deepEqual(nb.get_unicode_completion("alpha"), []);
  assert.deepEqual(nb.get_unicode_completion("\\notacode"), []);

  nb.free();
});

test("every committed code resolves in the wasm to the same expansion", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(false, false, FormatType.Html);

  for (const [codes, replacement] of UNICODE_INPUT) {
    for (const code of codes) {
      assert.deepEqual(
        wasmLookup(nb, `\\${code}`),
        { replaceLength: code.length + 1, replacement },
        `\\${code}`,
      );
      // And the plugin's own resolver agrees with the wasm on the same input.
      assert.deepEqual(unicodeExpansionAt(`\\${code}`, "\\"), { replaceLength: code.length + 1, replacement });
    }
  }

  nb.free();
});

test("the wasm knows no code the committed table is missing", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(false, false, FormatType.Html);

  // The vocabulary is much wider than the codes; the lookup is the filter.
  const vocabulary = (nb.get_completions_for("") as unknown[]).map((value) => String(value));
  assert.ok(vocabulary.includes("alpha"), "expected the vocabulary to carry code names at all");
  assert.ok(vocabulary.includes("let"), "expected the vocabulary to carry non-codes too");

  const found = new Map<string, string>();
  for (const name of vocabulary) {
    const hit = name === "" ? null : wasmLookup(nb, `\\${name}`);
    if (hit !== null) {
      found.set(name, hit.replacement);
    }
  }

  const committed = new Map(listUnicodeCompletions("").map((code) => [code.name, code.replacement]));
  assert.deepEqual([...found].sort(), [...committed].sort());

  nb.free();
});
