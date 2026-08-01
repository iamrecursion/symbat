// Pure helpers for Numbat's formatter output. This module deliberately has no imports so it can be
// unit-tested without pulling in Obsidian or the wasm bindings.

/** Escape `&`, `<` and `>` so a plain string is safe to render as HTML text. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * As {@link escapeHtml}, and also `"` and `'` — so the result is safe inside a quoted attribute
 * value, not only in text position. Use this whenever the escaped text is interpolated into markup
 * being assembled as a string, where whether a given interpolation lands in text or in an attribute
 * is not obvious from the call site.
 */
export function escapeHtmlStrict(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A trailing run of Unicode superscript digits (and the superscript minus) — Numbat prints a
 *  dimension's exponent this way (`Length³`, `Time⁻¹`), inside the same span as the dimension name,
 *  so it is stripped before recognizing the name. */
const SUPERSCRIPT_TAIL = /[⁰¹²³⁴-⁹⁻]+$/;

/**
 * The corrected CSS class for one span of Numbat-formatter output, or `null` to leave it unchanged.
 * Numbat's HTML formatter colors a few things differently from the editor's tokenizer; these bring
 * the rendered view into line with it:
 *
 *   * a string's `"` delimiters are emitted as `numbat-operator` (while the body is
 *     `numbat-string`) — color the quotes as the string they delimit, so a string reads all one
 *     color as it does in a code block;
 *   * a physical dimension is emitted as `numbat-type-identifier`, the same class as a real type —
 *     color known dimensions (and the name a `dimension <Name>` declaration introduces) as
 *     `numbat-dimension` instead. In a compound dimension (`Mass / Length³`) Numbat appends the
 *     exponent to the name inside one span, so a trailing superscript is stripped before the name
 *     is matched;
 *   * `Dim` — the type-parameter bound all dimensions satisfy — reads as a dimension too (Numbat
 *     emits it as a plain type identifier).
 *
 * `afterDimensionKeyword` is true when the previous span was the `dimension` keyword, so this span
 * is the declared name. `isDimension` recognizes names the interpreter has recorded as dimensions
 * (see syntax/type-names.ts) — callers fold in any `Dim`-bounded type parameters of the output (see
 * {@link dimBoundNames}). Pure, so the caller (interpreter/render.ts) does only the DOM walk.
 */
export function refinedNumbatClass(
  cls: string,
  text: string,
  afterDimensionKeyword: boolean,
  isDimension: (name: string) => boolean,
): string | null {
  if (cls === "numbat-operator" && text === "\"") {
    return "numbat-string";
  }

  if (
    cls === "numbat-type-identifier"
    && (text === "Dim" || afterDimensionKeyword || isDimension(text.replace(SUPERSCRIPT_TAIL, "")))
  ) {
    return "numbat-dimension";
  }

  return null;
}

/**
 * The `Dim`-bounded type-parameter names in one run of Numbat-formatter spans — `T` in a rendered
 * `fn abs<T: Dim>(x: T) -> T` — so their uses color as dimensions throughout the output. The
 * formatter emits the bound as the span sequence `[type-identifier X][operator ":"][type-identifier
 * "Dim"]` (layout whitespace lives between spans, not in them), which is matched here; `spans` is
 * the class/text of each span in visual order. Pure, so the caller (interpreter/render.ts) does
 * only the DOM walk.
 */
export function dimBoundNames(spans: readonly { cls: string; text: string; }[]): Set<string> {
  const names = new Set<string>();

  for (let i = 0; i + 2 < spans.length; i += 1) {
    if (
      spans[i].cls === "numbat-type-identifier"
      && spans[i + 1].cls === "numbat-operator" && spans[i + 1].text === ":"
      && spans[i + 2].cls === "numbat-type-identifier" && spans[i + 2].text === "Dim"
    ) {
      names.add(spans[i].text);
    }
  }

  return names;
}

/**
 * Convert Numbat's jQuery-terminal markup to HTML.
 *
 * `try_run_command` (used for REPL commands like `list`) always formats its output as
 * jQuery-terminal markup of the form `[[;;;hl-CLASS]escaped-text]`, regardless of the requested
 * format. The text is already HTML-escaped (with `[`/`]` written as entities), so we only need to
 * translate the markup tags, mapping `hl-*` classes onto the `numbat-*` classes used everywhere
 * else.
 */
export function jqueryTerminalToHtml(input: string): string {
  let out = "";

  let i = 0;
  while (i < input.length) {
    if (input.startsWith("[[", i)) {
      const specEnd = input.indexOf("]", i + 2);

      if (specEnd !== -1) {
        // Style spec is `text;background;other;classes`.
        const spec = input.slice(i + 2, specEnd);
        const parts = spec.split(";");
        const classSpec = parts.length >= 4 ? parts.slice(3).join(" ").trim() : "";
        const contentStart = specEnd + 1;

        let contentEnd = input.indexOf("]", contentStart);
        if (contentEnd === -1) {
          contentEnd = input.length;
        }

        const content = input.slice(contentStart, contentEnd);
        const cls = classSpec.replace(/hl-/g, "numbat-");
        out += cls ? `<span class="${cls}">${content}</span>` : content;
        i = contentEnd + 1;

        continue;
      }
    }

    out += input[i];
    i += 1;
  }

  return out;
}
