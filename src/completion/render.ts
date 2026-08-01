// Shared DOM for the completer surfaces — the editor `EditorSuggest` (completion/suggest.ts), the
// REPL CM6 autocomplete (views/input.ts), and the scope inspector's search box (views/scope.ts):
// the completion row itself (name, muted inline signature, category tag), and the floating "dwell"
// popup showing the full `print_info` docs. Only the plumbing that knows *which* completion is
// selected and *where* the completer sits differs per surface; everything they have in common is
// built here so all three look and behave identically.

import { finishRenderMath, loadMathJax, renderMatches, renderMath } from "obsidian";
import { setNumbatHtml } from "../interpreter/render";
import { type CompletionInfo, formatDocBody } from "./docs";
import type { ExprCategory, ExprCompletion } from "./expressions";

// RENDERING HELPERS
// ================================================================================================

/** The short tag shown after each completion, by category. */
const CATEGORY_LABEL: Record<ExprCategory, string> = {
  variable: "variable",
  function: "function",
  unit: "unit",
  dimension: "dimension",
  type: "type",
  keyword: "keyword",
  field: "field",
};

/** The `numbat-*` syntax class each category's tag is colored with, so the tag reads in the same
 *  color the name highlights as in code. Each kind — including units and dimensions — has its own
 *  class and hue. */
const CATEGORY_CLASS: Record<ExprCategory, string> = {
  variable: "numbat-identifier",
  function: "numbat-identifier",
  unit: "numbat-unit",
  dimension: "numbat-dimension",
  type: "numbat-type-identifier",
  keyword: "numbat-keyword",
  field: "numbat-identifier",
};

/**
 * Render one completion row: the name, an optional muted `type()` signature, then a category tag
 * colored like the name's syntax highlighting.
 *
 * `matches` are character ranges within `value.name` to highlight (from a fuzzy search); `null`
 * renders the name as plain text. The name is deliberately plain text either way rather than
 * semantic Numbat HTML — match highlighting and {@link setNumbatHtml}'s spans cannot both style the
 * same string, and the category tag already carries the unit/dimension/function distinction in
 * color.
 */
export function renderExprSuggestion(
  el: HTMLElement,
  value: ExprCompletion,
  signatureHtml: string | null,
  matches: [number, number][] | null = null,
): void {
  el.addClass("numbat-expr-suggestion");
  const name = el.createSpan({ cls: "numbat-expr-suggestion-name" });

  if (matches === null) {
    name.setText(value.name);
  } else {
    renderMatches(name, value.name, matches);
  }

  if (signatureHtml !== null) {
    el.append(renderSignature(signatureHtml));
  }

  el.append(renderCategoryTag(value.category));
}

/** A detached span holding the muted category tag that trails a completion row, colored with the
 *  category's own syntax class. Detached so a surface that builds the rest of the row itself can
 *  place it (the REPL renders into CM6's row). */
export function renderCategoryTag(category: ExprCategory): HTMLElement {
  return createSpan({
    cls: `numbat-expr-suggestion-kind ${CATEGORY_CLASS[category]}`,
    text: CATEGORY_LABEL[category],
  });
}

/**
 * A detached span holding the muted inline signature for a completion row (the `type(<name>)` HTML,
 * rendered through the shared semantic pipeline). The caller inserts it between the name and the
 * category tag; the muting/truncation is CSS (`.numbat-signature`).
 */
export function renderSignature(signatureHtml: string): HTMLElement {
  const span = createSpan({ cls: "numbat-signature" });
  setNumbatHtml(span, signatureHtml);
  return span;
}

/** One `$…$` segment of inline math in a description's text. */
const INLINE_MATH = /\$([^$\n]+)\$/;

/**
 * Replace `$…$` segments in the element's text with MathJax-rendered math — Numbat's docstrings
 * write math this way (`$|x|$`). Best-effort: when MathJax is not loaded yet, the plain `$…$` text
 * stays and a load is kicked off so the next popup renders. The caller flushes the MathJax
 * stylesheet afterwards (`finishRenderMath`).
 */
function renderInlineMath(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (INLINE_MATH.test(node.nodeValue ?? "")) {
      nodes.push(node as Text);
    }
  }

  for (const node of nodes) {
    // Split on the math segments: even parts are plain text, odd parts math.
    const parts = (node.nodeValue ?? "").split(new RegExp(INLINE_MATH.source, "g"));
    const replacement = createFragment();

    parts.forEach((part, index) => {
      if (index % 2 === 0) {
        if (part !== "") {
          replacement.append(part);
        }
        return;
      }

      try {
        replacement.append(renderMath(part, false));
      } catch {
        void loadMathJax(); // not ready — render this one plain, load for the next
        replacement.append(`$${part}$`);
      }
    });

    node.replaceWith(replacement);
  }
}

/**
 * The content for the dwell popup: the `print_info` body (semantic HTML, its line structure
 * preserved by the `pre-wrap` styling), its field labels bolded, inline `$…$` math rendered, and —
 * for a non-function entry — a `Type:` field carrying `typeSignatureHtml` (the `type(<name>)`
 * result; see {@link formatDocBody}). When Numbat cites a reference for the entry, it is appended
 * as a link (the popup takes pointer events, so it is clickable). Returned detached for {@link
 * DocPopup} to show.
 */
export function buildDocPopupContent(info: CompletionInfo, typeSignatureHtml: string | null = null): HTMLElement {
  const content = createDiv({ cls: "numbat-doc-popup-content" });
  const body = content.createDiv({ cls: "numbat-doc-body" });

  setNumbatHtml(body, formatDocBody(info.bodyHtml, typeSignatureHtml));
  renderInlineMath(body);
  void finishRenderMath();

  if (info.referenceUrl !== null) {
    content.createEl("a", {
      cls: "numbat-doc-reference",
      text: info.referenceUrl,
      href: info.referenceUrl,
      attr: { target: "_blank", rel: "noopener" },
    });
  }

  return content;
}

/** Gap between the popup and the completer it is anchored to, in px. */
const POPUP_GAP = 6;

/** Minimum inset from the viewport edges when clamping, in px. */
const VIEWPORT_MARGIN = 8;

// DOC POPUP
// ================================================================================================

/**
 * A single floating documentation popup, shared by both completer surfaces. It owns one
 * fixed-position element (created lazily under `document.body`) and positions it above a given
 * anchor rectangle — the completer's popover — clamping to the viewport so it never overflows the
 * screen, and flipping below only when there is genuinely no room above. The popup may be wider
 * than the completer (its own `max-width` bounds it). Callers show it on dwell and hide it on
 * selection change / close.
 */
export class DocPopup {
  /** The popup element, created on first show and reused thereafter; `null` until then, so a
   *  session that never opens one touches the DOM not at all. */
  private el: HTMLElement | null = null;

  /** Warms MathJax so the first popup's math renders without a flash of source. */
  constructor() {
    // Warm MathJax so a description's `$…$` math renders from the first popup (idempotent; usually
    // already loaded by the app for note previews).
    void loadMathJax();
  }

  /** The popup element, creating it on first use. */
  private ensureEl(): HTMLElement {
    if (this.el === null) {
      this.el = document.body.createDiv({ cls: "numbat-doc-popup" });
    }
    return this.el;
  }

  /** Show `content` above `anchor` (the completer's bounding rect), clamped on-screen. */
  showAbove(anchor: DOMRect, content: HTMLElement): void {
    const el = this.ensureEl();
    el.empty();
    el.append(content);
    el.toggleClass("is-visible", true); // display via the `.is-visible` CSS class

    // Measure after the content is in place, then position (fixed → viewport coords).
    const rect = el.getBoundingClientRect();
    const maxLeft = window.innerWidth - rect.width - VIEWPORT_MARGIN;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(anchor.left, maxLeft));
    const above = anchor.top - rect.height - POPUP_GAP;

    // Prefer above; drop below only when it would clip off the top of the screen.
    const top = above >= VIEWPORT_MARGIN ? above : anchor.bottom + POPUP_GAP;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  /** Hide the popup (kept in the DOM for reuse). */
  hide(): void {
    if (this.el !== null) {
      this.el.toggleClass("is-visible", false);
      this.el.empty();
    }
  }

  /** Remove the popup element entirely (on teardown). */
  destroy(): void {
    this.el?.remove();
    this.el = null;
  }
}
