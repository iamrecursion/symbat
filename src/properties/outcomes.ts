// One note's property bindings, evaluated in order in a single interpreter context. This is the
// shared substrate for every surface that shows a property's value.
//
// The surfaces disagree about presentation, but never about evaluation. A source-mode frontmatter
// inlay reads `= 9.828 km` beside the YAML while the property widget's Bases cell reads `9.828 km`
// on its own, but the two must **never** disagree about what the value *is*. Thus, the evaluation
// happens once, and each surface projects the result its own way — {@link hintFromOutcome} in
// properties/frontmatter-inlay.ts, {@link displayFromOutcome} below.
//
// The projections deliberately differ, and the differences are today's behavior rather than a
// simplification waiting to happen:
//
//   - The inlay drops a result that merely restates its source (`weight: 80.5` needs no `= 80.5`);
//     a cell does not, because there the value *is* the cell's content and dropping it leaves a
//     blank column.
//   - The inlay shows a binding's {@link PropertyBinding.warning} ahead of its value; the widget
//     judges its warning against the *live* text instead, which is a keystroke ahead of the
//     binding, so folding it in here would change what the widget shows while it is being typed
//     into (properties/type.ts says which text each outcome is judged from).
//
// No Obsidian, CodeMirror or wasm imports — like properties/parse.ts and evaluation/inlay-parse.ts,
// so the whole evaluation order is testable against the real wasm with no editor around it.

import type { LineInterpret } from "../evaluation/inlay-parse";
import { inlineResultFor } from "../evaluation/inline-parse";
import type { PropertyDisplay } from "./display";
import type { NotePreamble, PropertyBinding } from "./parse";

/**
 * What one evaluation produced, as far as *showing* it is concerned.
 *
 * Deliberately the shape `InlineResult` (evaluation/inline-parse.ts) already has rather than either
 * surface's own, so the two paths a property's value can be evaluated by (a note at a time, or one
 * property on its own) reach the same projection instead of each carrying a copy of it.
 */
export interface EvaluatedValue {
  /** Which outcome this is, and so which of the fields below are populated. */
  kind: "value" | "binding" | "hole" | "error" | "none";

  /** The `= value` fragment (HTML), what an annotation beside an expression shows. */
  resultHtml: string | null;

  /** The bare value (HTML), what a cell showing no expression shows. */
  valueHtml: string | null;

  /** The missing operand's type, for an incomplete expression (`3 m +` → `Length`). */
  holeType: string | null;

  /** The diagnostic's summary line, plain text. */
  errorText: string | null;
}

/** What evaluating one property *binding* produced: the value, plus what the note's derivation has
 *  to say about the property it came from. */
export interface BindingOutcome extends EvaluatedValue {
  /** The property this is the outcome of: its dotted key, as {@link PropertyBinding.key}. */
  key: string;

  /** The bare value as plain text, for comparing a value against its own source. */
  plain: string | null;

  /** The binding's derivation advisory, if it has one. See {@link PropertyBinding.warning}. */
  warning: string | null;

  /** The value as the reader wrote it ({@link PropertyBinding.written}, falling back to the
   *  expression): what "the value restates its source" is judged against, since a substituted zero
   *  is still restating itself on the page whatever it was rewritten to underneath. */
  written: string;
}

/**
 * Evaluate a note's property bindings in document order in one accumulating context, so each sees
 * the ones above it, and report what each produced.
 *
 * `run` must carry interpreter state across calls. The context is left holding the whole preamble
 * on return, whatever `from` was. A caller that wants the scope at a particular property should ask
 * for it before calling this.
 *
 * `from` is where *reporting* starts, not where evaluating does: the bindings above it are still
 * replayed (they are what the ones below them see), but only their definitions and statements, the
 * same one-call-per-chunk replay `replayScopeAbove` performs. What is skipped is the value probing
 * (`inlineResultFor` runs several interpret calls per binding to recover a `let`'s value or a typed
 * hole's type) which is the expensive half and the only part that produces an outcome. That is what
 * makes editing the last property of a long note cost one property's worth of evaluation rather
 * than the note's.
 *
 * The returned array is the *suffix*: one entry per binding from `from` onward, in order. Each
 * entry names its own key, so a caller never has to index back into the bindings to know what it
 * has.
 */
export function evaluateBindings(run: LineInterpret, preamble: NotePreamble, from = 0): BindingOutcome[] {
  // Cross-note imports open the scope, so a property can reference an import.
  for (const chunk of preamble.imports ?? []) {
    run(chunk);
  }

  const outcomes: BindingOutcome[] = [];
  for (const [index, binding] of preamble.bindings.entries()) {
    // The expression's own definitions (an array of objects' element type) must exist before it can
    // be evaluated, and are kept out of `code` so they are declared exactly once.
    for (const def of binding.defs) {
      run(def);
    }

    if (index >= from) {
      outcomes.push(outcomeFor(binding, inlineResultFor(run, binding.expr)));
    }

    // Define the binding so a later property in the note can reference it.
    run(binding.code);
  }

  return outcomes;
}

/** One binding's {@link BindingOutcome}, from the binding and what evaluating its expression
 *  produced. */
function outcomeFor(binding: PropertyBinding, result: ReturnType<typeof inlineResultFor>): BindingOutcome {
  return {
    key: binding.key,
    kind: result.kind,
    resultHtml: result.resultHtml,
    valueHtml: result.valueHtml,
    plain: result.plain,
    holeType: result.holeType,
    errorText: result.errorText,
    warning: binding.warning ?? null,
    written: binding.written ?? binding.expr,
  };
}

/**
 * What the property widget shows for an evaluation (properties/display.ts).
 *
 * Two things the inlay projection does are deliberately absent, both because the widget judges them
 * against its *live* text rather than against the binding, which is a keystroke behind:
 * {@link BindingOutcome.warning} (shown only while the text is still the value it was raised
 * about), and the "restates its source" suppression (a cell showing `80.5` *is* the cell's
 * content). properties/note-outcomes.ts applies the warning rule; nothing applies the suppression.
 */
export function displayFromOutcome(outcome: EvaluatedValue): PropertyDisplay {
  if (outcome.kind === "error") {
    return { kind: "error", text: outcome.errorText ?? "evaluation failed" };
  }
  if (outcome.kind === "hole" && outcome.holeType !== null) {
    return { kind: "hole", type: outcome.holeType };
  }
  if ((outcome.kind === "value" || outcome.kind === "binding") && outcome.resultHtml !== null) {
    return {
      kind: outcome.kind,
      resultHtml: outcome.resultHtml,
      valueHtml: outcome.valueHtml ?? outcome.resultHtml,
    };
  }

  return { kind: "empty" };
}

// REUSING A CONTEXT
// ================================================================================================

// A statement that puts a name into the environment.
//
// Numbat's five declaration forms plus `use`, which pulls a module's worth of them in. Decorators
// may precede a declaration on the same line (`@aliases(m) unit metre = …`), so they are skipped
// over rather than matched.
const DEFINITION = /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:let|unit|fn|dimension|struct|use)\b/;

// A decorator on a line of its own, which only ever precedes a declaration.
const DECORATOR_LINE = /^\s*@\w+(?:\([^)]*\))?\s*$/;

/**
 * Whether evaluating this text could leave anything behind in the context it is evaluated in.
 *
 * The question a **reused** context has to ask. Evaluating an expression is pure so a property's
 * value can be evaluated in a context that is already positioned at its scope and thus saves a
 * standard-library load per keystroke (properties/note-outcomes.ts). A *declaration* is not pure,
 * and hence one evaluated into a shared context is visible to every other reader of it, and would
 * collide with itself on the next keystroke.
 *
 * Deliberately conservative and textual: a `true` costs one fresh context, and the shapes it can
 * misjudge are ones a property has no business holding anyway. It errs towards `true`: a keyword
 * inside a string or a comment is read as a definition rather than looked through, since blanking
 * those to be sure would cost more than the context it saves.
 */
export function definesNames(text: string): boolean {
  return text.split("\n").some((line) => DEFINITION.test(line) || DECORATOR_LINE.test(line));
}
