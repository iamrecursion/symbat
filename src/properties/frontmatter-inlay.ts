// Pure helper for the source-mode frontmatter inlays (evaluation/inlay.ts): given a note's property
// bindings and an interpreter, evaluate each in note order and report the inlay to show on its YAML
// line — the same `= value` the property-editor widget shows in Live Preview, so the two surfaces
// agree.
//
// The evaluation itself lives in properties/outcomes.ts, shared with the property widget so the two
// surfaces cannot disagree about what a value is; this file is the inlay's own reading of it.
//
// No Obsidian, CodeMirror, or wasm imports (like evaluation/inlay-parse.ts / properties/parse.ts),
// so it is unit-testable against the real wasm in isolation; the editor-coupled pieces (locating
// the property's line, placing the widget) stay in evaluation/inlay.ts.

import type { LineInterpret } from "../evaluation/inlay-parse";
import { type BindingOutcome, evaluateBindings } from "./outcomes";
import type { NotePreamble } from "./parse";

/** One frontmatter property's evaluated inlay — its `= value` (or a typed-hole / error
 *  placeholder), keyed by property name so the editor can anchor it on the property's line.
 *  `content` is formatter HTML for a result, plain text otherwise. */
export interface FmHint {
  /** The property name the hint belongs to — how the editor finds its line. */
  key: string;

  /**
   * What the hint reports, selecting its CSS class and how `content` is rendered.
   *
   * `warning` is the one that is not about failure: the property bound, and produced a value, under
   * a reading of its data worth declaring — see {@link PropertyBinding.warning}. It is kept apart
   * from `error` so a note that works does not look like a note that does not.
   */
  kind: "result" | "hole" | "error" | "warning";

  /** Formatter HTML for a `result`, plain text for a `hole` type, an `error` summary or a
   *  `warning`. */
  content: string;
}

/**
 * The inlays to show for a note's evaluated bindings: the `= value` an expression produces, a
 * typed-hole placeholder for an incomplete one, or its error summary. A binding whose value merely
 * restates its source (an untyped number, or an expression that evaluates to itself) contributes
 * none as it's already visible in the raw YAML.
 *
 * What evaluation/inlay.ts calls, over the outcomes the property batch cached
 * (properties/outcome-cache.ts). The drop is here rather than at the call site so that the surface
 * reading cached outcomes and {@link frontmatterHints}, which evaluates them, cannot come to
 * disagree about which lines get an inlay at all.
 */
export function hintsFromOutcomes(outcomes: readonly BindingOutcome[]): FmHint[] {
  return outcomes
    .map(hintFromOutcome)
    .filter((hint): hint is FmHint => hint !== null);
}

/**
 * {@link hintsFromOutcomes} over a note evaluated from scratch, in order, in one accumulating
 * context. `run` must carry interpreter state across calls, so a later property sees the earlier
 * lets.
 *
 * Nothing in the plugin takes this route any more: the shipping surface reads outcomes the batch
 * already computed, and evaluating a whole note to paint one is exactly the cost that work removed.
 * It stays because it is the composition the integration tests drive against the real wasm — which
 * is worth having as long as it is *this* composition, of the two functions that do ship, rather
 * than a second implementation of them.
 */
export function frontmatterHints(run: LineInterpret, preamble: NotePreamble): FmHint[] {
  return hintsFromOutcomes(evaluateBindings(run, preamble));
}

/**
 * The inlay to show for one evaluated binding, or `null` where the line is better left alone.
 *
 * The order is the whole of the rule. A binding the derivation has something to say about outranks
 * its own value, which is why the warning comes first rather than filling in behind a missing
 * result: the one case today is a bare `0`, whose value would in any case be dropped just below as
 * merely restating its source.
 */
export function hintFromOutcome(outcome: BindingOutcome): FmHint | null {
  if (outcome.warning !== null) {
    return { key: outcome.key, kind: "warning", content: outcome.warning };
  }

  if ((outcome.kind === "value" || outcome.kind === "binding") && outcome.resultHtml !== null) {
    // Against the value as *written*, not as evaluated: a property the derivation rewrote (a
    // grounded `0`) is still restating itself on the page, whatever name it was given underneath.
    return valueRepeatsExpr(outcome.plain, outcome.written)
      ? null
      : { key: outcome.key, kind: "result", content: outcome.resultHtml };
  }

  if (outcome.kind === "hole" && outcome.holeType !== null) {
    return { key: outcome.key, kind: "hole", content: outcome.holeType };
  }

  if (outcome.kind === "error" && outcome.errorText !== null) {
    return { key: outcome.key, kind: "error", content: outcome.errorText };
  }

  return null;
}

/** Whether an evaluated value merely restates its source expression (`80.5` → `80.5`), so showing
 *  it would be noise. Whitespace-insensitive. */
export function valueRepeatsExpr(plain: string | null, expr: string): boolean {
  return plain !== null && plain.replace(/\s+/g, "") === expr.replace(/\s+/g, "");
}

/**
 * Whether a hint belongs on the property's key line, given where that key's value is written.
 *
 * A property whose value occupies the lines *below* its key — a block sequence, the only shape that
 * binds this way — has already shown you its contents, item by item, right there. Restating the
 * assembled list at the end of the `key:` line adds nothing, and for a list of objects it is a
 * screenful of struct literals. So a **result** is dropped there, for the same reason an object
 * property shows nothing on its own key line while its leaves each show their own.
 *
 * An **error**, a **warning** or an incomplete **hole** still places: none restates data you can
 * read, and they are the only sign that something in the block below wants attention. And a value
 * written on the key line itself (`rates: [5 EUR, 3 EUR]`) keeps its result, because there the line
 * *is* the value.
 */
export function hintPlacesOnKey(kind: FmHint["kind"], site: { line: number; endLine: number; }): boolean {
  return kind !== "result" || site.endLine === site.line;
}
