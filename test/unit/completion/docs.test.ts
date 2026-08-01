import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDocBody, parsePrintInfo, signatureFromTypeOutput } from "../../../src/completion/docs.ts";

// --- signatureFromTypeOutput -------------------------------------------------

// A faithful `type(abs)` output: the echoed input, then the `= …` result line.
const TYPE_ABS =
  "\n<span class=\"numbat-identifier\">type</span><span class=\"numbat-operator\">(</span><span class=\"numbat-identifier\">abs</span><span class=\"numbat-operator\">)</span>\n\n"
  + "<span class=\"numbat-dimmed\">=</span> <span class=\"numbat-keyword\">forall</span> <span class=\"numbat-type-identifier\">A</span><span class=\"numbat-operator\">:</span> <span class=\"numbat-type-identifier\">Dim</span><span class=\"numbat-operator\">.</span> <span class=\"numbat-type-identifier\">Fn</span><span class=\"numbat-operator\">[(</span><span class=\"numbat-type-identifier\">A</span><span class=\"numbat-operator\">)</span> <span class=\"numbat-operator\">-&gt;</span> <span class=\"numbat-type-identifier\">A</span><span class=\"numbat-operator\">]</span>\n";

test("signatureFromTypeOutput returns the HTML after the result marker", () => {
  const sig = signatureFromTypeOutput(TYPE_ABS);
  assert.ok(sig);
  // Starts at the signature (the echo and the `=` marker are dropped).
  assert.ok(sig.startsWith("<span class=\"numbat-keyword\">forall</span>"), sig ?? "");
  assert.ok(sig.endsWith("<span class=\"numbat-operator\">]</span>"));
  // The echoed input is gone.
  assert.ok(!sig.includes(">type<"));
  // Its `numbat-*` spans are preserved for semantic coloring.
  assert.ok(sig.includes("numbat-type-identifier"));
});

test("signatureFromTypeOutput returns null on error output (no result marker)", () => {
  // `type(to)` is a parse error — diagnostic spans, no dimmed `=`.
  const err = "<span class=\"numbat-diagnostic-red\">error</span>: while parsing";
  assert.equal(signatureFromTypeOutput(err), null);
  assert.equal(signatureFromTypeOutput(""), null);
});

test("signatureFromTypeOutput returns null when nothing follows the marker", () => {
  assert.equal(signatureFromTypeOutput("<span class=\"numbat-dimmed\">=</span>   "), null);
});

// --- parsePrintInfo ----------------------------------------------------------

const INFO_SQRT =
  "  Function:    Square root (<span class=\"numbat-string\">https://en.wikipedia.org/wiki/Square_root</span>)\n"
  + "  Signature:   <span class=\"numbat-keyword\">fn</span> <span class=\"numbat-identifier\">sqrt</span> ...\n"
  + "  Description: Return the square root of the input.\n  ";

test("parsePrintInfo extracts the reference URL and strips it from the body", () => {
  const info = parsePrintInfo(INFO_SQRT);
  assert.ok(info);
  assert.equal(info.referenceUrl, "https://en.wikipedia.org/wiki/Square_root");
  // The URL span (and its parentheses) are removed from the body…
  assert.ok(!info.bodyHtml.includes("numbat-string"));
  assert.ok(!info.bodyHtml.includes("https://"));
  assert.ok(!info.bodyHtml.includes("()"));
  // …but the rest (title, signature spans, description) remains.
  assert.ok(info.bodyHtml.includes("Square root"));
  assert.ok(info.bodyHtml.includes("Signature:"));
  assert.ok(info.bodyHtml.includes("numbat-keyword"));
  assert.ok(info.bodyHtml.includes("Return the square root"));
});

test("parsePrintInfo decodes entities in the URL", () => {
  const html = "  Function: X (<span class=\"numbat-string\">https://e.org/a?b&amp;c=d</span>)\n";
  const info = parsePrintInfo(html);
  assert.equal(info?.referenceUrl, "https://e.org/a?b&c=d");
});

test("parsePrintInfo returns null for `Not found` and `Usage:` outputs", () => {
  assert.equal(parsePrintInfo("Not found"), null);
  assert.equal(parsePrintInfo("Usage: info &lt;unit or variable&gt;"), null);
  assert.equal(parsePrintInfo("   "), null);
});

test("parsePrintInfo keeps the body when there is no reference URL", () => {
  const html = "  Dimension:   <span class=\"numbat-type-identifier\">Length</span> (Base dimension)\n";
  const info = parsePrintInfo(html);
  assert.ok(info);
  assert.equal(info.referenceUrl, null);
  assert.ok(info.bodyHtml.includes("Length"));
  assert.ok(info.bodyHtml.includes("Base dimension"));
});

// --- formatDocBody (popup formatting) -----------------------------------------

test("formatDocBody strips the indent and bolds the field labels", () => {
  const body = "  Function:    Absolute value\n  Signature:   <span class=\"numbat-keyword\">fn</span>\n"
    + "  Description: Return the absolute value.";
  assert.equal(
    formatDocBody(body),
    "<span class=\"numbat-doc-label\">Function:</span> Absolute value\n"
      + "<span class=\"numbat-doc-label\">Signature:</span> <span class=\"numbat-keyword\">fn</span>\n"
      + "<span class=\"numbat-doc-label\">Description:</span> Return the absolute value.",
  );
});

test("formatDocBody keeps a deeper indent's remainder", () => {
  // A variable's `= value` line is indented past the standard two spaces.
  assert.equal(
    formatDocBody("  Variable: Pi\n      = 3.14"),
    "<span class=\"numbat-doc-label\">Variable:</span> Pi\n    = 3.14",
  );
});

test("formatDocBody inserts a Type: field after the header when given one", () => {
  const type = "<span class=\"numbat-type-identifier\">Scalar</span>";
  assert.equal(
    formatDocBody("  Variable: Pi\n  Aliases: π, pi", type),
    "<span class=\"numbat-doc-label\">Variable:</span> Pi\n"
      + `<span class="numbat-doc-label">Type:</span> ${type}\n`
      + "<span class=\"numbat-doc-label\">Aliases:</span> π, pi",
  );
});

test("formatDocBody adds the Type: field even beside a unit's `A unit of:`", () => {
  // The two are often stated in different terms, so both are shown.
  const type = "<span class=\"numbat-type-identifier\">Length</span>";
  const formatted = formatDocBody("  Unit: Metre\n  A unit of: Length", type);
  assert.ok(formatted.includes(">Type:"));
  assert.ok(formatted.includes(">A unit of:"));
  // With nothing to insert (a function — the caller passes null), no field appears.
  assert.ok(!formatDocBody("  Function: f\n  Signature: fn f", null).includes(">Type:"));
});
