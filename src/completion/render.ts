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
import { type AnchorRect, popupPlacement } from "./placement";

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
  parameter: "parameter",
  local: "local",
  decorator: "decorator",
};

/**
 * The `numbat-*` syntax class each category's tag is colored with, so the tag reads in the same
 * color the name highlights as in code. Each kind — including units and dimensions — has its own
 * class and hue.
 */
const CATEGORY_CLASS: Record<ExprCategory, string> = {
  variable: "numbat-identifier",
  function: "numbat-identifier",
  unit: "numbat-unit",
  dimension: "numbat-dimension",
  type: "numbat-type-identifier",
  keyword: "numbat-keyword",
  field: "numbat-identifier",
  parameter: "numbat-identifier",
  local: "numbat-identifier",
  decorator: "numbat-decorator",
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

/**
 * A detached span holding the muted category tag that trails a completion row, colored with the
 * category's own syntax class. Detached so a surface that builds the rest of the row itself can
 * place it (the REPL renders into CM6's row).
 */
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

// DOC POPUP
// ================================================================================================

/**
 * A single floating documentation popup, shared by both completer surfaces. It owns one
 * fixed-position element (created lazily under `document.body`) and positions it against a given
 * anchor rectangle (the completer's popover) clamping to the viewport so it never overflows the
 * screen, and flipping below only when there is genuinely no room above. The popup may be wider
 * than the completer (its own `max-width` bounds it). Callers show it on dwell and hide it on
 * selection change / close.
 *
 * The element sits under `document.body` rather than inside whatever opened it, which is what makes
 * a *stale* show permanent: nothing sweeps the body, so a popup put up after its owner has gone has
 * nobody left to take it down. The two guards below do their best to prevent this: a dead anchor is
 * refused (see {@link popupPlacement}), and a destroyed popup stays destroyed.
 */
export class DocPopup {
  /**
   * The popup element, created on first show and reused thereafter; `null` until then, so a
   * session that never opens one touches the DOM not at all.
   */
  private el: HTMLElement | null = null;

  /**
   * Set by {@link destroy}, and never cleared. {@link el} is `null` both before the first show and
   * after the last, so it cannot tell those apart on its own, and {@link ensureEl} would otherwise
   * build a replacement on behalf of an owner that has already torn itself down.
   */
  private destroyed = false;

  /** Warms MathJax so the first popup's math renders without a flash of source. */
  constructor() {
    // Warm MathJax so a description's `$…$` math renders from the first popup (idempotent; usually
    // already loaded by the app for note previews).
    void loadMathJax();
  }

  /** The popup element, creating it on first use; `null` once the popup has been destroyed. */
  private ensureEl(): HTMLElement | null {
    if (this.destroyed) {
      return null;
    }
    if (this.el === null) {
      this.el = document.body.createDiv({ cls: "numbat-doc-popup" });
    }
    return this.el;
  }

  /**
   * Show `content` against `anchor` (the completer's bounding rect), clamped on-screen. Above it
   * where there is room, below it where there is not — see {@link popupPlacement}.
   *
   * An anchor with no place on the screen shows nothing, and takes down whatever was already up. A
   * detached element measures as an all-zero rect, and placing a card against that would put it in
   * the corner of the window where, being nobody's child, nothing would ever take it down again.
   */
  show(anchor: AnchorRect, content: HTMLElement): void {
    const el = this.ensureEl();
    if (el === null) {
      return;
    }

    el.empty();
    el.append(content);
    el.toggleClass("is-visible", true); // display via the `.is-visible` CSS class

    // Measure after the content is in place, and *at the origin*: the element is `position: fixed`
    // with a `left` but no width, so the room it has to lay itself out in is whatever is to the
    // right of that `left`. Left where the previous card was put, a card opened near the right
    // edge measures shrink-wrapped: too narrow for the clamp below and, having wrapped more lines
    // than it will really need, too tall for the flip.
    el.setCssStyles({ left: "0px", top: "0px" });

    // Position from the measurement (fixed → viewport coords).
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const placement = popupPlacement(anchor, el.getBoundingClientRect(), viewport);
    if (placement === null) {
      this.hide();
      return;
    }

    el.style.left = `${placement.left}px`;
    el.style.top = `${placement.top}px`;
  }

  /** Hide the popup (kept in the DOM for reuse). */
  hide(): void {
    if (this.el !== null) {
      this.el.toggleClass("is-visible", false);
      this.el.empty();
    }
  }

  /** Remove the popup element entirely, and for good (on teardown). */
  destroy(): void {
    this.destroyed = true;
    this.el?.remove();
    this.el = null;
  }
}
