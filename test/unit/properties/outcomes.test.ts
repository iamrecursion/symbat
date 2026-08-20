// The shared property evaluation: the order the interpreter is driven in, what `from` does and does
// not skip, and the two projections' deliberate divergence — the place where the inlay and the
// widget are allowed to disagree, and every other place they are not.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hintFromOutcome } from "../../../src/properties/frontmatter-inlay.ts";
import {
  type BindingOutcome,
  definesNames,
  displayFromOutcome,
  evaluateBindings,
} from "../../../src/properties/outcomes.ts";
import type { NotePreamble, PropertyBinding } from "../../../src/properties/parse.ts";

/** A binding whose chunks name themselves, so a recording run reads as a script. */
function binding(key: string, extra: Partial<PropertyBinding> = {}): PropertyBinding {
  return {
    key,
    path: [key],
    name: key,
    expr: `${key}-expr`,
    defs: [],
    code: `${key}-code`,
    kind: "expression",
    ...extra,
  };
}

function preambleOf(bindings: PropertyBinding[], imports?: string[]): NotePreamble {
  return { bindings, skips: [], source: bindings.map((entry) => entry.code).join("\n"), imports };
}

/** A `LineInterpret` that records what it was asked and answers with a value-less statement, so
 *  `inlineResultFor` runs its one call and probes no further. */
function recording(): ((code: string) => { output: string; isError: boolean; }) & { seen: string[]; } {
  const run = (code: string) => {
    run.seen.push(code);
    return { output: "", isError: false };
  };
  run.seen = [] as string[];
  return run;
}

/** A `BindingOutcome` with everything absent, for the projections to be given one field at a
 *  time. */
function outcome(extra: Partial<BindingOutcome> = {}): BindingOutcome {
  return {
    key: "total",
    kind: "none",
    resultHtml: null,
    valueHtml: null,
    plain: null,
    holeType: null,
    errorText: null,
    warning: null,
    written: "total-expr",
    ...extra,
  };
}

describe("evaluateBindings", () => {
  it("drives one context: imports, then each binding's defs, its expression, then its statement", () => {
    const run = recording();
    const preamble = preambleOf(
      [binding("a", { defs: ["a-def"] }), binding("b")],
      ["import-1", "import-2"],
    );

    const outcomes = evaluateBindings(run, preamble);

    assert.deepEqual(run.seen, [
      "import-1",
      "import-2",
      "a-def",
      "a-expr",
      "a-code",
      "b-expr",
      "b-code",
    ]);
    assert.deepEqual(outcomes.map((entry) => entry.key), ["a", "b"]);
  });

  it("still replays the bindings above `from`, and only skips probing their values", () => {
    const run = recording();
    const preamble = preambleOf([binding("a", { defs: ["a-def"] }), binding("b"), binding("c")]);

    const outcomes = evaluateBindings(run, preamble, 2);

    // `a-expr` and `b-expr` are gone — that is the saving — but their defs and statements are not:
    // they are what `c` sees.
    assert.deepEqual(run.seen, ["a-def", "a-code", "b-code", "c-expr", "c-code"]);
    assert.deepEqual(outcomes.map((entry) => entry.key), ["c"]);
  });

  it("reports no outcomes for a `from` past the last binding, and still replays the note", () => {
    const run = recording();

    const outcomes = evaluateBindings(run, preambleOf([binding("a"), binding("b")]), 2);

    assert.deepEqual(outcomes, []);
    assert.deepEqual(run.seen, ["a-code", "b-code"]);
  });

  it("carries the binding's warning and the value as written", () => {
    const preamble = preambleOf([
      binding("zero", { expr: "0 // Scalar", written: "(0)", warning: "read as a Scalar" }),
      binding("plain"),
    ]);

    const [zero, plain] = evaluateBindings(recording(), preamble);

    assert.equal(zero.warning, "read as a Scalar");
    assert.equal(zero.written, "(0)");
    // No `written` of its own: the expression is what is on the page.
    assert.equal(plain.warning, null);
    assert.equal(plain.written, "plain-expr");
  });
});

describe("hintFromOutcome", () => {
  it("puts a warning ahead of the value it was raised about", () => {
    const hint = hintFromOutcome(outcome({
      kind: "value",
      resultHtml: "<span>0</span>",
      plain: "0",
      warning: "read as a Scalar",
    }));

    assert.deepEqual(hint, { key: "total", kind: "warning", content: "read as a Scalar" });
  });

  it("drops a result that merely restates what is written, whitespace aside", () => {
    const repeats = { kind: "value", resultHtml: "<span>80.5</span>", plain: "80.5" } as const;

    assert.equal(hintFromOutcome(outcome({ ...repeats, written: "80.5" })), null);
    assert.equal(hintFromOutcome(outcome({ ...repeats, written: "80. 5" })), null);
    assert.equal(hintFromOutcome(outcome({ ...repeats, written: "40.25 * 2" }))?.kind, "result");
  });

  it("reports a hole, an error, and nothing at all", () => {
    assert.deepEqual(
      hintFromOutcome(outcome({ kind: "hole", holeType: "Length" })),
      { key: "total", kind: "hole", content: "Length" },
    );
    assert.deepEqual(
      hintFromOutcome(outcome({ kind: "error", errorText: "unexpected end of input" })),
      { key: "total", kind: "error", content: "unexpected end of input" },
    );
    assert.equal(hintFromOutcome(outcome()), null);
  });
});

describe("displayFromOutcome", () => {
  it("shows a value in both of its shapes", () => {
    assert.deepEqual(
      displayFromOutcome(outcome({ kind: "binding", resultHtml: "= 4", valueHtml: "4" })),
      { kind: "binding", resultHtml: "= 4", valueHtml: "4" },
    );
  });

  it("keeps a value that restates its source — in a cell the value is the content", () => {
    const display = displayFromOutcome(outcome({
      kind: "value",
      resultHtml: "= 80.5",
      valueHtml: "80.5",
      plain: "80.5",
      written: "80.5",
    }));

    assert.equal(display.kind, "value");
    assert.equal(
      hintFromOutcome(outcome({ kind: "value", resultHtml: "= 80.5", plain: "80.5", written: "80.5" })),
      null,
    );
  });

  it("does not apply the binding's warning — the widget judges that against its live text", () => {
    const display = displayFromOutcome(outcome({
      kind: "value",
      resultHtml: "= 0",
      valueHtml: "0",
      warning: "read as a Scalar",
    }));

    assert.equal(display.kind, "value");
  });

  it("reports an error, a hole, and an outcome with nothing to show", () => {
    assert.deepEqual(
      displayFromOutcome(outcome({ kind: "error", errorText: "unexpected end of input" })),
      { kind: "error", text: "unexpected end of input" },
    );
    // An error with no summary still reads as an error rather than as an empty property.
    assert.deepEqual(displayFromOutcome(outcome({ kind: "error" })), { kind: "error", text: "evaluation failed" });
    assert.deepEqual(displayFromOutcome(outcome({ kind: "hole", holeType: "Length" })), {
      kind: "hole",
      type: "Length",
    });
    assert.deepEqual(displayFromOutcome(outcome()), { kind: "empty" });
  });
});

describe("definesNames", () => {
  it("passes the expressions a property is actually for", () => {
    for (const text of ["2 + 2", "rate * n_hours", "3 m -> ft", "  now()  ", "sum([1, 2])", "# a comment"]) {
      assert.equal(definesNames(text), false, text);
    }
  });

  it("catches every form that would leave something behind in a borrowed context", () => {
    for (
      const text of [
        "let x = 5",
        "unit foo = 2 m",
        "fn double(x: Scalar) = 2 x",
        "dimension Money",
        "struct Point { x: Length }",
        "use units::si",
        "@aliases(m) unit metre = 1 m",
        "1 + 1\nlet x = 5",
        "@metric_prefixes",
      ]
    ) {
      assert.equal(definesNames(text), true, text);
    }
  });

  it("reads a keyword, not a prefix of one", () => {
    assert.equal(definesNames("let_me_be * 2"), false, "a name that merely starts like a keyword");
    assert.equal(definesNames("units_sold * 3"), false);
  });

  it("errs towards refusing, since a wrong `false` is the expensive one", () => {
    // A line of a *string* that reads like a declaration is answered as one. The cost of that is a
    // single interpreter context; the cost of the opposite mistake is a shared context quietly
    // gaining a name, so the reading is not worth the blanking pass it would take to be sure.
    assert.equal(definesNames("\"one\nlet two\""), true);
    // On one line there is no such doubt: the statement is an expression, whatever the string says.
    assert.equal(definesNames("\"let x = 5\""), false);
  });
});
