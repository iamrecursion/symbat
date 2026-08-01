import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dimBoundNames,
  escapeHtml,
  escapeHtmlStrict,
  jqueryTerminalToHtml,
  refinedNumbatClass,
} from "../../../src/interpreter/markup.ts";

test("escapeHtml escapes &, < and >", () => {
  assert.equal(escapeHtml("a < b & c > d \"e\""), "a &lt; b &amp; c &gt; d \"e\"");
});

test("escapeHtmlStrict also escapes both quote characters", () => {
  assert.equal(
    escapeHtmlStrict("a < b & c > d \"e\" 'f'"),
    "a &lt; b &amp; c &gt; d &quot;e&quot; &#39;f&#39;",
  );
});

test("escapeHtmlStrict escapes the ampersands it introduces exactly once", () => {
  // `&` must be replaced first, or the entities the later replacements produce get re-escaped into
  // `&amp;lt;`.
  assert.equal(escapeHtmlStrict("&lt;"), "&amp;lt;");
  assert.equal(escapeHtmlStrict("<>"), "&lt;&gt;");
});

test("maps an hl- class span onto a numbat- class span", () => {
  assert.equal(
    jqueryTerminalToHtml("[[;;;hl-unit]km/h]"),
    "<span class=\"numbat-unit\">km/h</span>",
  );
});

test("passes plain text and newlines through unchanged", () => {
  assert.equal(jqueryTerminalToHtml("plain text\n  two"), "plain text\n  two");
});

test("handles multiple spans interleaved with plain text", () => {
  const input = "  [[;;;hl-identifier]abs]   [[;;;hl-identifier]acos]\n";
  assert.equal(
    jqueryTerminalToHtml(input),
    "  <span class=\"numbat-identifier\">abs</span>   <span class=\"numbat-identifier\">acos</span>\n",
  );
});

test("maps diagnostic classes", () => {
  assert.equal(
    jqueryTerminalToHtml("[[;;;hl-diagnostic-red]error]"),
    "<span class=\"numbat-diagnostic-red\">error</span>",
  );
});

test("does not throw on unterminated markup", () => {
  assert.doesNotThrow(() => jqueryTerminalToHtml("[[;;;hl-unit]km"));
});

test("empty input yields empty output", () => {
  assert.equal(jqueryTerminalToHtml(""), "");
});

// --- refinedNumbatClass (rendered-view corrections) --------------------------

const isDimension = (name: string): boolean => name === "Length" || name === "Time";

test("refinedNumbatClass recolors a string's quote delimiters as string", () => {
  // Numbat emits the `"` delimiters as operators; color them like the string body.
  assert.equal(refinedNumbatClass("numbat-operator", "\"", false, isDimension), "numbat-string");
  // Other operators are untouched.
  assert.equal(refinedNumbatClass("numbat-operator", "=", false, isDimension), null);
  assert.equal(refinedNumbatClass("numbat-operator", "{", false, isDimension), null);
});

test("refinedNumbatClass recolors a known dimension (emitted as a type) distinctly", () => {
  assert.equal(refinedNumbatClass("numbat-type-identifier", "Length", false, isDimension), "numbat-dimension");
  // A real type stays a type.
  assert.equal(refinedNumbatClass("numbat-type-identifier", "String", false, isDimension), null);
});

test("refinedNumbatClass recognizes a dimension carrying a superscript exponent", () => {
  // In a compound dimension (Mass / Length³) the exponent is inside the name's span.
  assert.equal(refinedNumbatClass("numbat-type-identifier", "Length³", false, isDimension), "numbat-dimension");
  assert.equal(refinedNumbatClass("numbat-type-identifier", "Length⁴", false, isDimension), "numbat-dimension");
  assert.equal(refinedNumbatClass("numbat-type-identifier", "Time⁻¹", false, isDimension), "numbat-dimension");
  // The base must still be a known dimension — a superscript alone does not qualify.
  assert.equal(refinedNumbatClass("numbat-type-identifier", "String²", false, isDimension), null);
});

test("refinedNumbatClass recolors a `dimension <Name>` declaration name syntactically", () => {
  // Right after the `dimension` keyword the name is a dimension even if unknown.
  assert.equal(refinedNumbatClass("numbat-type-identifier", "Foo", true, isDimension), "numbat-dimension");
  // The flag only affects a type-identifier span, not e.g. an operator.
  assert.equal(refinedNumbatClass("numbat-operator", "=", true, isDimension), null);
});

test("refinedNumbatClass leaves everything else unchanged", () => {
  assert.equal(refinedNumbatClass("numbat-unit", "metre", false, isDimension), null);
  assert.equal(refinedNumbatClass("numbat-value", "42", false, isDimension), null);
  assert.equal(refinedNumbatClass("numbat-string", "hello", false, isDimension), null);
});

test("refinedNumbatClass recolors the Dim bound as a dimension", () => {
  assert.equal(refinedNumbatClass("numbat-type-identifier", "Dim", false, isDimension), "numbat-dimension");
  // Only as a type-identifier span — `Dim` inside e.g. a string stays put.
  assert.equal(refinedNumbatClass("numbat-string", "Dim", false, isDimension), null);
});

// --- dimBoundNames (Dim-bounded type parameters in formatter output) ---------

test("dimBoundNames collects the parameters bounded by Dim", () => {
  // The span run of a rendered `fn abs<T: Dim>(x: T)` header.
  const spans = [
    { cls: "numbat-keyword", text: "fn" },
    { cls: "numbat-identifier", text: "abs" },
    { cls: "numbat-operator", text: "<" },
    { cls: "numbat-type-identifier", text: "T" },
    { cls: "numbat-operator", text: ":" },
    { cls: "numbat-type-identifier", text: "Dim" },
    { cls: "numbat-operator", text: ">" },
    { cls: "numbat-type-identifier", text: "T" },
  ];
  assert.deepEqual([...dimBoundNames(spans)], ["T"]);
});

test("dimBoundNames ignores plain annotations and unbounded parameters", () => {
  // `x: Length` — an identifier, not a type identifier, before the colon.
  assert.deepEqual(
    dimBoundNames([
      { cls: "numbat-identifier", text: "x" },
      { cls: "numbat-operator", text: ":" },
      { cls: "numbat-type-identifier", text: "Length" },
    ]).size,
    0,
  );
  assert.deepEqual(dimBoundNames([]).size, 0);
});
