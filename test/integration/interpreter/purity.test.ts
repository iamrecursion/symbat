// Pins the purity name table (src/interpreter/purity.ts) against the real interpreter.
//
// The table is a closure computed over `numbat/modules` at a particular NUMBAT_TAG, and the wasm
// exposes the standard library as a flat list of names with no module structure — so nothing at
// runtime can re-derive it. What *can* be checked is that every pinned name still exists and still
// has the shape the closure assumed, which is what makes a tag bump that renames or removes one
// fail here rather than silently freeze a clock.
//
// The gap this cannot close, stated rather than hidden: a *new* impure builtin upstream would be
// cached as pure. Numbat exposes no purity information, and the obvious probe — evaluate twice and
// compare — is unsound, since `today()` returns the same value twice within a day. That rests on
// the CONTRIBUTING checklist for NUMBAT_TAG bumps. The failure mode is "no better than today",
// where every such value is already frozen, rather than a regression.

import assert from "node:assert/strict";
import { test } from "node:test";
import { IMPURE_NAMES, readsClockOrRandom } from "../../../src/interpreter/purity.ts";
import { loadNumbat, skip } from "../wasm-pkg.ts";

test("every pinned impure name still resolves in the interpreter", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  const missing: string[] = [];
  for (const name of IMPURE_NAMES) {
    const result = nb.interpret(`type(${name})`);
    if (result.is_error) {
      missing.push(name);
    }
    result.free();
  }

  nb.free();
  assert.deepEqual(
    missing,
    [],
    `these names are pinned as impure but no longer exist — NUMBAT_TAG moved under the table in `
      + `src/interpreter/purity.ts, and every scope that used them is now cached as pure`,
  );
});

test("the two FFI roots really are impure", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  // `random()` is the only root whose impurity is observable within one test run: `now()` can
  // legitimately return the same instant twice, and `today()` returns the same value all day. Two
  // hundred draws make a false failure impossible in practice.
  const draws = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const result = nb.interpret("random()");
    draws.add(result.output as string);
    result.free();
  }

  nb.free();
  assert.ok(draws.size > 1, "random() returned the same value 200 times, so it is no longer impure");
});

test("the near-misses are still near-misses", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  // `exchange_rate` is not in the default prelude at all — `units::currencies` is the one unit
  // module Numbat leaves out, precisely because loading it fires a rate lookup per unit — so a note
  // reaches it only by asking. Pinned all the same: it is excluded from the table because a rate
  // change bumps the interpreter generation instead, and that reasoning needs redoing if it moves.
  const used = nb.interpret("use units::currencies");
  used.free();

  // `get_local_timezone` is excluded because it returns a stable zone name rather than an instant.
  for (const name of ["exchange_rate", "get_local_timezone"]) {
    const result = nb.interpret(`type(${name})`);
    const failed = result.is_error as boolean;
    result.free();
    assert.equal(failed, false, `${name} no longer exists; re-check why it is excluded from IMPURE_NAMES`);
  }

  nb.free();
  assert.equal(readsClockOrRandom("exchange_rate(\"EUR\") + get_local_timezone()"), false);
});

test("the duration family stays pure, parameter named `time` and all", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  // `human` reads `time` throughout its body as its own parameter, which shadows the prelude
  // function of that name. It is the one place the whole-word test is measurably wrong about
  // Numbat's own source, so pin that it still takes an argument rather than reading the clock.
  const same = nb.interpret("human(90 minutes) == human(90 minutes)");
  const output = same.output as string;
  const failed = same.is_error as boolean;
  same.free();
  nb.free();

  assert.equal(failed, false, output);
  assert.match(output, /true/);
});
