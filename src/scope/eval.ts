// Value probing for the note scope inspector: given the pure scope tree (scope/model.ts) and a way
// to make fresh interpreter contexts, fill in each binding's evaluated value + inferred type,
// mirroring what the inlay surfaces show. No Obsidian or direct wasm imports — the interpreter is
// injected as a context factory (`makeContext`) — so it is integration-testable against the real
// wasm like properties/frontmatter-inlay.ts, without the editor/plugin layers.
//
// It reuses the inlay/inline value helpers but deliberately drops their "value repeats its source"
// suppression: the inspector lists every binding, so `let x = 5 m` must show `5 m` where the inlay
// shows nothing.

import { signatureFromTypeOutput } from "../completion/docs";
import {
  declarationSite,
  declarationTypeHtml,
  errorSummary,
  holeForm,
  type LineInterpret,
  parseHoleType,
  plainText,
  resultValueHtml,
  splitInterpretOutput,
} from "../evaluation/inlay-parse";
import { inlineValueHtml } from "../evaluation/inline-parse";
import type { ScopeEntry, ScopeTree, ScopeValue } from "./model";

/** A fresh interpreter context: an injected `run` carrying its own accumulating state, and a `free`
 *  to release it. scope/source.ts supplies this over the real wasm (createContext / interpret /
 *  freeQuietly); tests supply it over a test context. */
export interface ScopeContextFactory {
  (): { run: LineInterpret; free: () => void; };
}

// SCOPE VALUES
// ================================================================================================

/** A value result from a formatter fragment (`= value [Dim]`), with an optional inferred type
 *  fragment. Reconstructs what evaluation/inline.ts's private `valueResult` builds, from the
 *  exported helpers. */
function valueResult(result: string, type: string | null): ScopeValue {
  const valueHtml = inlineValueHtml(result);
  return {
    kind: "value",
    resultHtml: resultValueHtml(result),
    valueHtml,
    plain: plainText(valueHtml),
    holeType: null,
    errorText: null,
    type,
  };
}

/** The separator a type fragment opens with, matching `declarationTypeHtml`'s `: Type` shape so a
 *  function's signature aligns with a `let`'s inferred type. */
const COLON_SPAN = `<span class="numbat-operator">:</span>`;

// A binding that produced nothing to show. Shared rather than rebuilt per entry: it is by far the
// most common outcome, and nothing mutates a ScopeValue.
const NONE_VALUE: ScopeValue = {
  kind: "none",
  resultHtml: null,
  valueHtml: null,
  plain: null,
  holeType: null,
  errorText: null,
  type: null,
};

/** An incomplete expression, shown as its missing operand's `type`. */
function holeValue(type: string): ScopeValue {
  return { kind: "hole", resultHtml: null, valueHtml: null, plain: null, holeType: type, errorText: null, type: null };
}

/** A binding that failed, shown as its diagnostic summary (`null` when there was no usable line to
 *  show). */
function errorValue(text: string | null): ScopeValue {
  return { kind: "error", resultHtml: null, valueHtml: null, plain: null, holeType: null, errorText: text, type: null };
}

/** A binding whose declaration ran but produced no probeable value — shown with its type when one
 *  is known, else nothing. */
function typeOnly(type: string | null): ScopeValue {
  return type === null ? NONE_VALUE : { ...NONE_VALUE, type };
}

// PROBING A BINDING
// ================================================================================================

/**
 * Derive the value from an interpreter output already obtained for `code`. A bare expression keeps
 * its `= value` fragment; a `let` declaration reads its inferred type from the echo and probes the
 * bound name for the value (no suppression); an incomplete expression recovers the missing-operand
 * type from a Numbat typed hole; anything else that errored yields its diagnostic summary.
 */
function valueFromOutput(run: LineInterpret, code: string, out: { output: string; isError: boolean; }): ScopeValue {
  if (!out.isError) {
    const { echo, result } = splitInterpretOutput(out.output);
    if (result !== null) {
      return valueResult(result, null); // a bare expression with a value
    }

    const site = declarationSite(code);
    if (site !== null && site.keyword === "let") {
      const type = declarationTypeHtml(echo);
      const bound = run(site.name);
      if (!bound.isError) {
        const boundResult = splitInterpretOutput(bound.output).result;
        if (boundResult !== null) {
          return valueResult(boundResult, type);
        }
      }

      return typeOnly(type);
    }

    return NONE_VALUE;
  }

  const hole = holeForm(code);
  if (hole !== null) {
    const type = parseHoleType(run(hole).output);
    if (type !== null) {
      return holeValue(type);
    }
  }

  return errorValue(errorSummary(out.output));
}

/** Evaluate one statement/expression against `run`, returning its display value + type. Runs `code`
 *  once, then delegates to {@link valueFromOutput}. */
export function deriveScopeValue(run: LineInterpret, code: string): ScopeValue {
  return valueFromOutput(run, code, run(code));
}

/** A property's value: probe the RHS expression (matching the frontmatter inlays — a value, an
 *  incomplete hole, or an error), then define the binding so later properties see it, capturing the
 *  inferred type from the definition's echo. */
function evaluateProperty(run: LineInterpret, entry: ScopeEntry): void {
  // What the expression itself needs (an array of objects' element type) is declared first, and
  // exactly once — it is deliberately not part of `code`.
  for (const def of entry.defs ?? []) {
    run(def);
  }

  const value = deriveScopeValue(run, entry.expr);
  const def = run(entry.code);
  if (!def.isError && value.kind === "value" && value.type === null) {
    value.type = declarationTypeHtml(splitInterpretOutput(def.output).echo);
  }
  entry.value = value;
}

/**
 * A function's type signature as its type fragment: `type(<name>)` — the same form the completer
 * shows on each row (`Fn[(Length) -> Length]`, or a `forall`-bound one for a generic function) —
 * behind the usual `:` separator. A function has no value, so the signature is all a `fn` row
 * carries; when Numbat cannot type the name the row falls back to a bare `fn` marker.
 */
function functionSignature(run: LineInterpret, name: string): ScopeValue {
  const out = run(`type(${name})`);
  const signature = out.isError ? null : signatureFromTypeOutput(out.output);
  return typeOnly(signature === null ? null : `${COLON_SPAN} ${signature}`);
}

/** The value of an already-defined binding (an import chunk replayed, or a prelude loaded into the
 *  context): probe the bound name. A `fn` carries its signature instead of a value; a `dimension`
 *  is neither (probing one errors), so it shows by name alone. No type fragment for the rest
 *  (re-running the `let` to read the echo would clash with the already-defined name). */
function probeBoundEntry(run: LineInterpret, entry: ScopeEntry): void {
  if (entry.declKind === "fn") {
    entry.value = functionSignature(run, entry.name);
    return;
  }

  if (entry.declKind === "dimension") {
    entry.value = NONE_VALUE;
    return;
  }

  const bound = run(entry.name);
  if (bound.isError) {
    entry.value = NONE_VALUE;
    return;
  }

  const result = splitInterpretOutput(bound.output).result;
  entry.value = result !== null ? valueResult(result, null) : NONE_VALUE;
}

// EVALUATING THE TREE
// ================================================================================================

/**
 * Fill every binding in `tree` with its evaluated value + type, using the same scope semantics as
 * the note's other surfaces:
 *
 *  - **imports + properties** share one base context (imports' chunks replayed whole, then each
 *    property probed and defined);
 *  - **each block** gets its own context seeded with the base + earlier *shared* blocks, so a plain
 *    (`local`) block's bindings never leak into scope and each block's values match its own inlay;
 *  - **inline `let`s** replay the base + the document-order interleave of shared blocks (matching
 *    the inline evaluation surface);
 *  - **user prelude** bindings are already loaded into every context (createContext replays the
 *    user prelude), so they are probed directly in the base context.
 *
 * `makeContext` builds and the caller frees each context; a per-binding error is isolated to that
 * binding (only a wasm panic, caught by the caller, aborts).
 */
export function evaluateScopeTree(makeContext: ScopeContextFactory, tree: ScopeTree): void {
  const importChunks = tree.imports.flatMap((group) => group.chunks);
  const baseCodes = [...importChunks, ...tree.properties.flatMap((entry) => [...(entry.defs ?? []), entry.code])];

  // Phase A — imports, properties, and the (already-loaded) user prelude.
  const base = makeContext();
  try {
    for (const chunk of importChunks) {
      base.run(chunk);
    }

    for (const group of tree.imports) {
      for (const entry of group.entries) {
        probeBoundEntry(base.run, entry);
      }
    }

    for (const entry of tree.properties) {
      evaluateProperty(base.run, entry);
    }

    for (const file of tree.prelude) {
      for (const entry of file.entries) {
        probeBoundEntry(base.run, entry);
      }
    }
  } finally {
    base.free();
  }

  // Phase B — each block in its own context (base + earlier shared blocks).
  const earlierShared: string[] = [];
  for (const block of tree.blocks) {
    const ctx = makeContext();
    try {
      for (const code of baseCodes) {
        ctx.run(code);
      }

      for (const body of earlierShared) {
        ctx.run(body);
      }

      for (const statement of block.statements) {
        const out = ctx.run(statement.code);
        const entry = statement.entry;
        if (entry === null) {
          continue;
        }

        // A function that defined cleanly shows its signature; one that failed falls through so its
        // diagnostic surfaces like any other statement's.
        entry.value = entry.declKind === "fn" && !out.isError
          ? functionSignature(ctx.run, entry.name)
          : valueFromOutput(ctx.run, statement.code, out);
      }
    } finally {
      ctx.free();
    }

    if (block.exported) {
      earlierShared.push(block.wholeBody);
    }
  }

  // Phase C — inline lets (base + document-order shared blocks).
  if (tree.inline.length > 0) {
    const ctx = makeContext();
    try {
      for (const code of baseCodes) {
        ctx.run(code);
      }

      let index = 0;
      for (const unit of tree.units) {
        if (unit.kind === "shared") {
          ctx.run(unit.code);
          continue;
        }

        const entry = tree.inline[index];
        if (entry !== undefined && entry.defsite.line === unit.line && entry.code === unit.span.expr) {
          entry.value = deriveScopeValue(ctx.run, entry.code);
          index += 1;
        }
      }
    } finally {
      ctx.free();
    }
  }
}
