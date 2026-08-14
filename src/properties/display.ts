// What an evaluated property is *shown* as — the pure half of the Numbat property widget
// (properties/type.ts), which is where the evaluating and the DOM writing live.
//
// One evaluation is shown in two different places that want two different things of it. Beside an
// expression the reader can already see — a property row, with its editor — it is an annotation on
// that expression, and reads `= 9.828 km`. In a Bases cell that shows no expression until it is
// clicked into, it is the cell's *content*, and reads `9.828 km`. Same outcome, two readings, and
// the difference is small enough to get wrong quietly, which is why it is stated once, here, where
// it can be tested without a DOM.

/** What the widget shows for one evaluation pass. */
export type PropertyDisplay =
  | { kind: "empty"; }
  | { kind: "error"; text: string; }
  /** The property bound and produced a value, under a reading of it worth declaring. */
  | { kind: "warning"; text: string; }
  | { kind: "hole"; type: string; }
  /**
   * A value, in both the shapes it is shown in: the `= value` fragment and the bare value.
   *
   * Carried together so that clicking into a cell repaints rather than evaluating again — a fresh
   * interpreter context is the entire standard library, and a click should not cost one. Both are
   * Numbat formatter HTML, so a value keeps its own colors either way.
   */
  | { kind: "value" | "binding"; resultHtml: string; valueHtml: string; };

/** How an outcome is to be read: the same evaluation says one thing beside an editor and another in
 *  a cell that has none. */
export interface DisplayMode {
  /**
   * Show the **bare value** rather than the `= value` fragment.
   *
   * True where the widget is showing no expression — an idle compact cell, where the value is the
   * cell's content rather than an annotation on something the reader can already see. The `=` is
   * what ties the annotation to the expression beside it, and with nothing beside it, it is noise.
   */
  bare: boolean;

  /**
   * What to show when the outcome has nothing of its own to say. Only used when {@link bare}: an
   * annotation with nothing to annotate should be silent, but a *cell* with nothing in it reads as
   * an empty property rather than as one still being evaluated — or as one whose feature is turned
   * off. The widget passes its expression text, so a Base column of Numbat properties falls back to
   * showing the expressions rather than a column of blanks.
   */
  fallback: string;
}

/** What the widget is to write. Separated from the writing so the decision — which is all of the
 *  display behavior worth testing — can be tested without a DOM. */
export type DisplayPlan =
  | { paint: "none"; }
  | { paint: "text"; text: string; cls: "error" | "warning" | null; }
  /** Numbat formatter HTML, so a value keeps its own colors. */
  | { paint: "html"; html: string; };

/** How to show an outcome in a given mode. */
export function displayPlan(outcome: PropertyDisplay, mode: DisplayMode): DisplayPlan {
  switch (outcome.kind) {
    case "empty":
      return mode.bare && mode.fallback !== "" ? { paint: "text", text: mode.fallback, cls: null } : { paint: "none" };
    case "error":
      return { paint: "text", text: outcome.text, cls: "error" };
    case "warning":
      return { paint: "text", text: outcome.text, cls: "warning" };
    case "hole":
      return { paint: "text", text: `⟨${outcome.type}⟩`, cls: null };
    default:
      return { paint: "html", html: mode.bare ? outcome.valueHtml : outcome.resultHtml };
  }
}
