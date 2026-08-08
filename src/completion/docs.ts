// Pure helpers for extracting completion documentation from Numbat's formatter output — the inline
// signature (from `type(<name>)`) and the full docs (from `print_info(<name>)`). No Obsidian or
// wasm imports, so this is unit-testable in isolation like completion/expressions.ts.
// interpreter/numbat.ts runs the interpreter and `print_info` and feeds the HTML here;
// completion/render.ts turns the results into DOM.

import { escapeHtml } from "../interpreter/markup";

/** The marker Numbat's pretty-printer emits before a result value. `type(x)` echoes the input, then
 *  prints `<dimmed>=</dimmed> <the type>`; the signature is whatever follows this marker. */
const RESULT_MARKER = "<span class=\"numbat-dimmed\">=</span>";

/**
 * The signature HTML from a `type(<name>)` interpret output — everything after the result marker
 * (the `= …` line), with its `numbat-*` spans intact — or `null` when the marker is absent (an
 * error output, e.g. `type` of a keyword or dimension).
 *
 * e.g. `type(abs)` → `forall A: Dim. Fn[(A) -> A]`, `type(pi)` → `Scalar`.
 */
export function signatureFromTypeOutput(html: string): string | null {
  const at = html.indexOf(RESULT_MARKER);
  if (at === -1) {
    return null;
  }

  const signature = html.slice(at + RESULT_MARKER.length).trim();
  return signature === "" ? null : signature;
}

/** The parsed `print_info` documentation for the dwell popup. */
export interface CompletionInfo {
  /** The documentation HTML (labeled lines with `numbat-*` spans), minus the reference URL, which
   *  is surfaced separately as a link. */
  bodyHtml: string;

  /** The reference URL (e.g. a Wikipedia link), or `null` when none is present. */
  referenceUrl: string | null;
}

/** Decode the few HTML entities Numbat escapes into, for the extracted URL. */
function decodeEntities(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** Matches the reference-URL span Numbat puts in a `print_info` header line: `(<span
 *  class="numbat-string">https://…</span>)`. */
const URL_SPAN = /<span class="numbat-string">(https?:\/\/[^<]*)<\/span>/;

/** The same span with its wrapping ` (…)`, for removing it from the body. */
const URL_SPAN_WRAPPED = /\s*\(<span class="numbat-string">https?:\/\/[^<]*<\/span>\)/;

/**
 * Parse a `print_info(<name>)` output into its body HTML and reference URL, or `null` when there is
 * nothing to show — Numbat returns the literal `Not found` for an unknown name (or a keyword), and
 * a `Usage: …` line for an empty query.
 *
 * The reference URL is lifted out of the header line and removed, along with its surrounding
 * parentheses, from the body (the popup shows no links, so it is dropped — kept on the result for
 * callers that want it). The remaining `numbat-*` HTML renders through the usual setNumbatHtml
 * pipeline, after {@link formatDocBody}.
 */
export function parsePrintInfo(html: string): CompletionInfo | null {
  const plain = html.replace(/<[^>]*>/g, "").trim();
  if (plain === "" || plain === "Not found" || plain.startsWith("Usage:")) {
    return null;
  }

  const match = URL_SPAN.exec(html);
  const referenceUrl = match ? decodeEntities(match[1]) : null;
  const bodyHtml = html
    .replace(URL_SPAN_WRAPPED, "")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");

  return { bodyHtml, referenceUrl };
}

/** A field label `print_info` writes at a line's start (`Function:`, `A unit of:`, …), captured
 *  with the alignment padding after its colon. The tail of the list is the plugin's own — `Field`
 *  through `Declared in` from {@link describedInfo}, and `Decorator` from {@link decoratorInfo} —
 *  styled to match the rest. */
const DOC_LABEL =
  /^(Function|Signature|Description|Unit|Aliases|A unit of|Variable|Dimension|Units|Field|Parameter|Type parameter|Quantity|Declared in|Decorator)(:)[^\S\n]*/;

/**
 * A card for something Numbat's own `print_info` cannot describe, in the shape {@link
 * parsePrintInfo} produces so it renders identically:
 *
 *   * a **struct field** (`costs.total`) — `print_info` answers `Not found` for a member path,
 *     since it exposes docs by name, while `type()` and evaluation both resolve it;
 *   * a **parameter**, **type parameter**, or **field declaration** — these exist only inside the
 *     declaration that introduces them, so no context has ever heard of them (see
 *     hover/declarations.ts);
 *   * a **literal** — `21.1 km` is not a name at all, but it has a dimension and a value, which is
 *     exactly what one hovers it to learn.
 *
 * Modeled on the `Variable:` card print_info writes, so these read like every other card; the
 * caller's `type()` result is spliced in as the `Type:` line by {@link formatDocBody}. `valueHtml`
 * is the evaluated value, when there is one, and `note` a trailing detail line (which declaration
 * it came from).
 */
export function describedInfo(
  label: string,
  subject: string,
  valueHtml: string | null = null,
  note: string | null = null,
): CompletionInfo {
  const lines = [`${label}: ${escapeHtml(subject)}`];

  if (note !== null) {
    lines.push(`Declared in: ${escapeHtml(note)}`);
  }
  if (valueHtml !== null) {
    lines.push("", `      <span class="numbat-dimmed">=</span> ${valueHtml}`);
  }

  return { bodyHtml: lines.join("\n"), referenceUrl: null };
}

/**
 * A card for a decorator, in the same shape as {@link describedInfo}'s. Decorators are the one part
 * of Numbat's grammar with no runtime existence at all — no context has heard of `@name`, and
 * `print_info` answers `Not found` — so the text comes from the completer's own table
 * (completion/expressions.ts) rather than from the interpreter.
 */
export function decoratorInfo(name: string, description: string): CompletionInfo {
  return {
    bodyHtml: `Decorator: @${escapeHtml(name)}\nDescription: ${escapeHtml(description)}`,
    referenceUrl: null,
  };
}

/**
 * Format a parsed `print_info` body for the documentation popup:
 *
 *   * the two-space indent `print_info` puts on every line is stripped (with `pre-wrap` styling a
 *     wrapped line is not indented, so the lead-in read oddly), deeper indents keeping their
 *     remainder;
 *   * each field label is wrapped in a `numbat-doc-label` span (bolded by CSS), its alignment
 *     padding collapsed to one space;
 *   * a `Type:` field with the `type(<name>)` result (`typeHtml`, when the caller has one —
 *     non-function entries) is inserted after the header line. It stays even beside a unit's `A
 *     unit of:` line: the two are often stated in different terms, and both are useful.
 */
export function formatDocBody(bodyHtml: string, typeHtml: string | null = null): string {
  const lines = bodyHtml.split("\n").map((line) =>
    line.replace(/^ {1,2}/, "").replace(DOC_LABEL, "<span class=\"numbat-doc-label\">$1$2</span> ")
  );

  if (typeHtml !== null) {
    lines.splice(1, 0, `<span class="numbat-doc-label">Type:</span> ${typeHtml}`);
  }

  return lines.join("\n");
}
