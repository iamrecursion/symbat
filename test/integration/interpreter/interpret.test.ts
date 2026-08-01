// Exercises the actual Numbat WebAssembly interpreter through the generated bindings — the same
// code path the plugin bundles. Requires the wasm to have been built (`make wasm`); the suite
// self-skips otherwise so unit runs never need the build.

import assert from "node:assert/strict";
import { test } from "node:test";
import { jqueryTerminalToHtml, refinedNumbatClass } from "../../../src/interpreter/markup.ts";
import { buildUnicodeCodeList } from "../../../src/unicode/codes.ts";
import { loadNumbat, reinitNumbat, skip } from "../wasm-pkg.ts";

test("evaluates a unit conversion to highlighted HTML", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);
  const result = nb.interpret("2 km + 3 m -> m");
  assert.equal(result.is_error, false);
  assert.match(result.output, /numbat-value">2003</);
  assert.match(result.output, /numbat-unit">m</);
  result.free();
  nb.free();
});

test("flags a parse error", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);
  const result = nb.interpret("2 +* 3");
  assert.equal(result.is_error, true);
  result.free();
  nb.free();
});

test("keeps interpreter state across calls within a context", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);
  nb.interpret("let x = 5 metre").free();
  const result = nb.interpret("x + 1 m");
  assert.equal(result.is_error, false);
  assert.match(result.output, /numbat-value">6</);
  assert.match(result.output, /numbat-unit">m</);
  result.free();
  nb.free();
});

// The rendered-view refinement (interpreter/render.ts) relies on how Numbat's HTML formatter
// classes two things: a string's `"` delimiters as `numbat-operator`, and a physical dimension as
// `numbat-type-identifier` (the same class as a real type). Pin those invariants so a future wasm
// bump that changes them fails loudly here rather than silently regressing the string-quote /
// dimension coloring.
test("HTML formatter emits quotes as operators and dimensions as type identifiers", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  const str = nb.interpret("\"hi\"");
  assert.equal(str.is_error, false);
  // The `"` delimiters are operators; the body is a string.
  assert.match(str.output, /<span class="numbat-operator">"<\/span>/);
  assert.match(str.output, /<span class="numbat-string">hi<\/span>/);
  str.free();

  const dim = nb.interpret("type(2 metre)");
  assert.equal(dim.is_error, false);
  // The dimension `Length` is emitted as a type identifier (not a distinct class).
  assert.match(dim.output, /<span class="numbat-type-identifier">Length<\/span>/);
  dim.free();

  // A compound dimension prints its base dimensions as type identifiers, with the exponent inside
  // the name's span (`Length⁴`, not a separate token).
  const compound = nb.interpret("1 kg / metre^4");
  assert.equal(compound.is_error, false);
  assert.match(compound.output, /<span class="numbat-type-identifier">Length⁴<\/span>/);
  compound.free();

  // The pure refiner turns all of those into the editor's colors — including the exponent-bearing
  // name, whose superscript is stripped before the name is matched.
  const isDimension = (name: string): boolean => name === "Length";
  assert.equal(refinedNumbatClass("numbat-operator", "\"", false, isDimension), "numbat-string");
  assert.equal(refinedNumbatClass("numbat-type-identifier", "Length", false, isDimension), "numbat-dimension");
  assert.equal(refinedNumbatClass("numbat-type-identifier", "Length⁴", false, isDimension), "numbat-dimension");

  nb.free();
});

test("REPL command output converts from jQuery markup to numbat- classes", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);
  const command = nb.try_run_command("list functions");
  assert.equal(command.is_command, true);
  const html = jqueryTerminalToHtml(command.output);
  assert.match(html, /<span class="numbat-identifier">/);
  assert.doesNotMatch(html, /\[\[;;;hl-/);
  command.free();
  nb.free();
});

// A user prelude is applied by interpreting its whole source into a fresh context (see
// `createContext`/`applyUserPrelude`); its definitions must then be visible to later evaluations in
// that same context.
test("a prelude's units, constants, and functions are visible to later evaluations", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  // Names deliberately avoid clashes with Numbat's own prelude (e.g. `dozen`, `double`): a user
  // prelude layers on top of the standard prelude.
  const prelude = nb.interpret(["let my_answer = 42", "unit sqoot = 12 metre", "fn quintuple(x) = 5 * x"].join("\n"));
  assert.equal(prelude.is_error, false);
  prelude.free();

  const constant = nb.interpret("my_answer");
  assert.equal(constant.is_error, false);
  assert.match(constant.output, /numbat-value">42</);
  constant.free();

  const unit = nb.interpret("2 sqoot -> m");
  assert.equal(unit.is_error, false);
  assert.match(unit.output, /numbat-value">24</);
  assert.match(unit.output, /numbat-unit">m</);
  unit.free();

  const fn = nb.interpret("quintuple(my_answer)");
  assert.equal(fn.is_error, false);
  assert.match(fn.output, /numbat-value">210</);
  fn.free();

  nb.free();
});

// A broken prelude reports `is_error` rather than throwing; the plugin records that output
// (`getLastPreludeError`) and surfaces it in the REPL.
test("a prelude parse error is reported via is_error, not a panic", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);
  const bad = nb.interpret("let broken =");
  assert.equal(bad.is_error, true);
  bad.free();
  nb.free();
});

// The plugin's Unicode expansion relies on this contract: a match returns `[patternLength,
// replacement]` (the length counts the leading backslash), and a non-match returns an empty array.
// See `getUnicodeCompletion`.
test("get_unicode_completion returns [length, replacement] for a known code", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  const alpha = nb.get_unicode_completion("x = \\alpha");
  assert.deepEqual(alpha, [6, "α"]);

  // Only the tail matters: a code mid-string with trailing text does not match.
  assert.deepEqual(nb.get_unicode_completion("\\alpha + 1"), []);
  // A plain word with no leading backslash is not a code.
  assert.deepEqual(nb.get_unicode_completion("alpha"), []);
  // An unknown code does not match.
  assert.deepEqual(nb.get_unicode_completion("\\notacode"), []);

  nb.free();
});

// The completion popover enumerates codes by filtering Numbat's completion vocabulary
// (`get_completions_for`) through `get_unicode_completion`. This pins that pipeline against the
// real wasm (see `listUnicodeCompletions`).
test("get_completions_for feeds buildUnicodeCodeList a usable code list", { skip }, async () => {
  const { Numbat, FormatType } = await loadNumbat();
  const nb = Numbat.new(true, true, FormatType.Html);

  // Prefix completion includes the unicode code name.
  const forAl = (nb.get_completions_for("al") as unknown[]).map((v) => String(v));
  assert.ok(forAl.includes("alpha"), "expected 'alpha' among completions for 'al'");

  // Build the full \code list exactly as the plugin does.
  const names = (nb.get_completions_for("") as unknown[]).map((v) => String(v));
  const codes = buildUnicodeCodeList(names, (code) => {
    const r = nb.get_unicode_completion(code) as unknown[];
    return Array.isArray(r) && r.length === 2 ? String(r[1]) : null;
  });
  const byName = new Map(codes.map((c) => [c.name, c.replacement]));
  assert.equal(byName.get("alpha"), "α");
  assert.equal(byName.get("pi"), "π");
  // Keywords and functions that are not codes are filtered out.
  assert.equal(byName.has("let"), false);
  assert.equal(byName.has("sin"), false);

  nb.free();
});

const ECB_XML = `<?xml version="1.0"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
<Cube><Cube time="2026-07-08"><Cube currency="USD" rate="1.14"/></Cube></Cube>
</gesmes:Envelope>`;

// This exercises the wasm-level behavior the plugin's crash handling relies on. Kept last because
// it resets/reinitializes the shared module.
test("exchange rates: set once, reuse, panic on double set, and reset recovery", { skip }, async () => {
  const mod = await loadNumbat();
  const { Numbat, FormatType } = mod;

  // First set enables currency conversion.
  const a = Numbat.new(true, true, FormatType.Html);
  a.set_exchange_rates(ECB_XML);
  const conv = a.interpret("100 USD -> EUR");
  assert.equal(conv.is_error, false);
  assert.match(conv.output, /€|euro/);
  conv.free();
  a.free();

  // A later context reuses the global rates via `use units::currencies`.
  const b = Numbat.new(true, true, FormatType.Html);
  b.interpret("use units::currencies").free();
  const conv2 = b.interpret("100 USD -> EUR");
  assert.equal(conv2.is_error, false);
  conv2.free();
  b.free();

  // A second set_exchange_rates panics (the OnceLock double-set the plugin guards).
  const c = Numbat.new(true, true, FormatType.Html);
  assert.throws(() => c.set_exchange_rates(ECB_XML));
  // After a panic the object is left "borrowed" and cannot be freed (the plugin uses freeQuietly
  // for exactly this); skip freeing it.

  // The instance survives the panic.
  const d = Numbat.new(true, true, FormatType.Html);
  const survive = d.interpret("2 + 2");
  assert.equal(survive.is_error, false);
  survive.free();
  d.free();

  // Reset + reinit gives a fresh instance where set_exchange_rates works again.
  mod.__numbat_reset();
  await reinitNumbat(mod);
  const e = Numbat.new(true, true, FormatType.Html);
  e.set_exchange_rates(ECB_XML);
  const conv3 = e.interpret("100 USD -> EUR");
  assert.equal(conv3.is_error, false);
  conv3.free();
  e.free();
});
