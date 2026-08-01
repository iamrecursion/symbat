// Helpers for turning Numbat's formatter output into DOM.

import { sanitizeHTMLToDom } from "obsidian";
import { semanticKind } from "../syntax/type-names";
import { dimBoundNames, refinedNumbatClass } from "./markup";

/**
 * Post-process the rendered spans so the rendered view matches the editor's highlighting: string
 * quotes read as string (not operator), and physical dimensions — including `Dim` and the type
 * parameters it bounds — read distinctly from types (see {@link refinedNumbatClass}). Numbat's
 * formatter emits a flat run of single-class spans, so `querySelectorAll` visits them in visual
 * order and the span after a `dimension` keyword is its declared name; a first pass over the same
 * run collects the `Dim`-bounded names.
 */
function refineNumbatSpans(el: HTMLElement): void {
  const spans = Array.from(el.querySelectorAll("span"), (span) => ({
    span,
    cls: span.className,
    text: span.textContent ?? "",
  }));
  const bound = dimBoundNames(spans);
  let afterDimensionKeyword = false;

  for (const { span, cls, text } of spans) {
    const refined = refinedNumbatClass(
      cls,
      text,
      afterDimensionKeyword,
      (name) => bound.has(name) || semanticKind(name) === "dimension",
    );
    if (refined !== null) {
      span.className = refined;
    }
    afterDimensionKeyword = cls === "numbat-keyword" && text === "dimension";
  }
}

/**
 * Render Numbat formatter HTML into an element.
 *
 * The HTML comes from Numbat's own `HtmlFormatter` (only `<span class="numbat-…">` tags around
 * HTML-escaped text). It is parsed through Obsidian's sanitizer rather than assigned to
 * `innerHTML`, both for safety and per the plugin guidelines, then refined so dimensions and string
 * quotes color as they do in the editor (see {@link refineNumbatSpans}).
 */
export function setNumbatHtml(el: HTMLElement, html: string): void {
  el.empty();

  // Numbat's pretty-printer wraps its output in leading/trailing newlines, which would render as
  // blank lines; strip them (interior blank lines are kept).
  el.append(sanitizeHTMLToDom(html.replace(/^\n+/, "").replace(/\n+$/, "")));
  refineNumbatSpans(el);
}
