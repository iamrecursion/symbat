// Pure helper for the source-mode frontmatter inlays (evaluation/inlay.ts): given a note's property
// bindings and an interpreter, evaluate each in note order and report the inlay to show on its YAML
// line — the same `= value` the property-editor widget shows in Live Preview, so the two surfaces
// agree.
//
// No Obsidian, CodeMirror, or wasm imports (like evaluation/inlay-parse.ts / properties/parse.ts),
// so it is unit-testable against the real wasm in isolation; the editor-coupled pieces (locating
// the property's line, placing the widget) stay in evaluation/inlay.ts.

import type { LineInterpret } from "../evaluation/inlay-parse";
import { inlineResultFor } from "../evaluation/inline-parse";
import type { NotePreamble } from "./parse";

/** One frontmatter property's evaluated inlay — its `= value` (or a typed-hole / error
 *  placeholder), keyed by property name so the editor can anchor it on the property's line.
 *  `content` is formatter HTML for a result, plain text otherwise. */
export interface FmHint {
  /** The property name the hint belongs to — how the editor finds its line. */
  key: string;

  /** What the hint reports, selecting its CSS class and how `content` is rendered. */
  kind: "result" | "hole" | "error";

  /** Formatter HTML for a `result`, plain text for a `hole` type or `error` summary. */
  content: string;
}

/**
 * Evaluate a note's property bindings in order, in one accumulating context, returning the inlay to
 * show on each: the `= value` an expression produces, a typed-hole placeholder for an incomplete
 * one, or its error summary. A binding whose value merely restates its source (an untyped number,
 * or an expression that evaluates to itself) contributes none — the raw YAML already shows it.
 * `run` must carry interpreter state across calls, so a later property sees the earlier lets.
 */
export function frontmatterHints(run: LineInterpret, preamble: NotePreamble): FmHint[] {
  const hints: FmHint[] = [];

  // Cross-note imports open the scope, so a property can reference an import.
  for (const chunk of preamble.imports ?? []) {
    run(chunk);
  }

  for (const binding of preamble.bindings) {
    const result = inlineResultFor(run, binding.expr);
    if ((result.kind === "value" || result.kind === "binding") && result.resultHtml !== null) {
      if (!valueRepeatsExpr(result.plain, binding.expr)) {
        hints.push({ key: binding.key, kind: "result", content: result.resultHtml });
      }
    } else if (result.kind === "hole" && result.holeType !== null) {
      hints.push({ key: binding.key, kind: "hole", content: result.holeType });
    } else if (result.kind === "error" && result.errorText !== null) {
      hints.push({ key: binding.key, kind: "error", content: result.errorText });
    }

    // Define the binding so a later property in the note can reference it.
    run(binding.code);
  }

  return hints;
}

/** Whether an evaluated value merely restates its source expression (`80.5` → `80.5`), so showing
 *  it would be noise. Whitespace-insensitive. */
export function valueRepeatsExpr(plain: string | null, expr: string): boolean {
  return plain !== null && plain.replace(/\s+/g, "") === expr.replace(/\s+/g, "");
}
