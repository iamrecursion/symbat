import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowedCategoriesAt,
  boundCompletions,
  BUILTIN_TYPE_NAMES,
  classifyCompletion,
  type CompletionVocabulary,
  declaredNameCompletions,
  declaredNamesIn,
  decoratorCompletions,
  decoratorDoc,
  enclosingDeclarationAt,
  type ExprCategory,
  expressionCompletions,
  exprTriggerAt,
  exprWordPrefixAt,
  isInterpreterKnown,
  isTypePosition,
  memberBaseAt,
  parseListNames,
  pluginTypeCandidates,
  structFieldNames,
  typeDoc,
  typeVariableCompletions,
  typeVariablesInScopeAt,
} from "../../../src/completion/expressions.ts";
import { NULLABLE_STRUCT, NULLABLE_STRUCT_DOC } from "../../../src/interpreter/nullable.ts";

/** Build a vocabulary from plain name lists (the shape interpreter/numbat.ts assembles from the
 *  `list functions|units|variables|dimensions` commands). */
function vocab(
  { dimensions = [], units = [], functions = [], variables = [] }: {
    dimensions?: string[];
    units?: string[];
    functions?: string[];
    variables?: string[];
  },
): CompletionVocabulary {
  return {
    dimensions: new Set(dimensions),
    units: new Set(units),
    functions: new Set(functions),
    variables: new Set(variables),
  };
}

// --- parseListNames ----------------------------------------------------------

test("parseListNames extracts every class-tagged name, ignoring layout whitespace", () => {
  // A `list functions` output: names in the identifier class, column-padded.
  const markup = "[[;;;hl-identifier]sin]  [[;;;hl-identifier]cos]   [[;;;hl-identifier]atan2]";
  assert.deepEqual(parseListNames(markup), ["sin", "cos", "atan2"]);
});

test("parseListNames decodes entities and skips empty spans", () => {
  const markup = "[[;;;hl-unit]&#91;x&#93;]  [[;;;hl-identifier]a &amp; b]  [[;;;hl-identifier]]";
  assert.deepEqual(parseListNames(markup), ["[x]", "a & b"]);
});

// --- classifyCompletion ------------------------------------------------------

const V = vocab({
  dimensions: ["Length", "Time"],
  units: ["meter", "second"],
  functions: ["sin", "atan2"],
  variables: ["pi", "income"],
});

test("classifyCompletion distinguishes built-in types from physical dimensions", () => {
  // Built-in / structural types.
  assert.equal(classifyCompletion("Bool", V), "type");
  assert.equal(classifyCompletion("String", V), "type");
  assert.equal(classifyCompletion("List", V), "type");
  // Physical dimensions.
  assert.equal(classifyCompletion("Length", V), "dimension");
  assert.equal(classifyCompletion("Time", V), "dimension");
});

test("classifyCompletion recognizes keywords", () => {
  assert.equal(classifyCompletion("to", V), "keyword");
  assert.equal(classifyCompletion("per", V), "keyword");
  assert.equal(classifyCompletion("let", V), "keyword");
});

test("classifyCompletion distinguishes functions, variables, and units", () => {
  assert.equal(classifyCompletion("sin", V), "function");
  assert.equal(classifyCompletion("atan2", V), "function");
  assert.equal(classifyCompletion("pi", V), "variable");
  assert.equal(classifyCompletion("income", V), "variable");
  assert.equal(classifyCompletion("meter", V), "unit");
});

test("classifyCompletion recognizes metric-prefixed units", () => {
  assert.equal(classifyCompletion("kilometer", V), "unit");
  assert.equal(classifyCompletion("millisecond", V), "unit");
  // A prefix alone, or a prefix on an unknown unit, is not a unit.
  assert.equal(classifyCompletion("kilo", V), null);
  assert.equal(classifyCompletion("kilofoo", V), null);
});

test("classifyCompletion drops names in no category (e.g. LaTeX patterns)", () => {
  // `alpha` is a `\code` pattern, not a defined name, so it is dropped — but `pi`, which is both a
  // pattern and a real constant, is kept as a variable (above).
  assert.equal(classifyCompletion("alpha", V), null);
  assert.equal(classifyCompletion("nope", V), null);
});

// --- expressionCompletions ---------------------------------------------------

const ALL_CATEGORIES = { identifiers: true, keywords: true, units: true, dimensions: true, types: true };

test("expressionCompletions categorizes and keeps only enabled category groups", () => {
  const raw = ["String", "Length", "to", "meter", "alpha", "sin", "pi"];
  const all = expressionCompletions(raw, V, ALL_CATEGORIES);
  assert.deepEqual(all, [
    { name: "String", category: "type" }, // built-in type
    { name: "Length", category: "dimension" }, // physical dimension
    { name: "to", category: "keyword" },
    { name: "meter", category: "unit" },
    { name: "sin", category: "function" }, // `alpha` dropped (no category)
    { name: "pi", category: "variable" },
  ]);

  // Each of the five toggles gates exactly one group. Identifiers covers variables and functions
  // only (not units, which have their own toggle now).
  const off = { identifiers: false, keywords: false, units: false, dimensions: false, types: false };
  const idsOnly = expressionCompletions(raw, V, { ...off, identifiers: true });
  assert.deepEqual(idsOnly.map((c) => c.name), ["sin", "pi"]);

  const unitsOnly = expressionCompletions(raw, V, { ...off, units: true });
  assert.deepEqual(unitsOnly.map((c) => c.name), ["meter"]);

  const dimensionsOnly = expressionCompletions(raw, V, { ...off, dimensions: true });
  assert.deepEqual(dimensionsOnly.map((c) => c.name), ["Length"]);

  // The types toggle covers built-in / structural types only (dimensions are separate).
  const typesOnly = expressionCompletions(raw, V, { ...off, types: true });
  assert.deepEqual(typesOnly.map((c) => c.name), ["String"]);

  const keywordsOnly = expressionCompletions(raw, V, { ...off, keywords: true });
  assert.deepEqual(keywordsOnly.map((c) => c.name), ["to"]);
});

test("expressionCompletions de-duplicates and preserves input order", () => {
  const raw = ["meter", "meter", "", "sin"];
  const out = expressionCompletions(raw, V, ALL_CATEGORIES);
  assert.deepEqual(out.map((c) => c.name), ["meter", "sin"]);
});

// --- exprWordPrefixAt --------------------------------------------------------

test("exprWordPrefixAt reads the trailing identifier word", () => {
  assert.equal(exprWordPrefixAt("1 + me"), "me");
  assert.equal(exprWordPrefixAt("sin"), "sin");
  assert.equal(exprWordPrefixAt("foo.ba"), "ba");
  assert.equal(exprWordPrefixAt("x_2"), "x_2");
});

test("exprWordPrefixAt ignores numbers and non-word tails", () => {
  assert.equal(exprWordPrefixAt("42"), ""); // a number is not a word
  assert.equal(exprWordPrefixAt("3.5"), "");
  assert.equal(exprWordPrefixAt("2 + "), "");
  assert.equal(exprWordPrefixAt(""), "");
});

// --- exprTriggerAt -----------------------------------------------------------

test("exprTriggerAt fires on a two-character word", () => {
  assert.deepEqual(exprTriggerAt("me"), { query: "me", replaceLength: 2 });
  assert.deepEqual(exprTriggerAt("1 + met"), { query: "met", replaceLength: 3 });
});

test("exprTriggerAt does not fire on a single character alone", () => {
  assert.equal(exprTriggerAt("m"), null);
  assert.equal(exprTriggerAt("1 + x"), null);
  assert.equal(exprTriggerAt(""), null);
});

test("exprTriggerAt fires straight after `.` or `:` following an expression", () => {
  assert.deepEqual(exprTriggerAt("foo."), { query: "", replaceLength: 0 });
  assert.deepEqual(exprTriggerAt("foo:"), { query: "", replaceLength: 0 });
  assert.deepEqual(exprTriggerAt(")."), { query: "", replaceLength: 0 });
  // …and keeps completing the member/type word as it is typed.
  assert.deepEqual(exprTriggerAt("foo.b"), { query: "b", replaceLength: 1 });
});

test("exprTriggerAt does not treat a decimal point or stray colon as a trigger", () => {
  assert.equal(exprTriggerAt("3."), null); // decimal, not member access
  assert.equal(exprTriggerAt("3:"), null);
  assert.equal(exprTriggerAt(" ."), null); // no expression before the dot
  assert.equal(exprTriggerAt("."), null);
});

test("exprTriggerAt keeps a `:` type position open across the conventional space", () => {
  // `: Type` is the usual style, so the completer must not close on the space.
  assert.deepEqual(exprTriggerAt("let x: "), { query: "", replaceLength: 0 });
  assert.deepEqual(exprTriggerAt("let x: L"), { query: "L", replaceLength: 1 }); // single char completes
  assert.deepEqual(exprTriggerAt("fn f(a: Ti"), { query: "Ti", replaceLength: 2 });
  // A `.` member position is not relaxed across a space, and once the type name is written the
  // trailing space no longer triggers.
  assert.equal(exprTriggerAt("foo. "), null);
  assert.equal(exprTriggerAt("let x: Length "), null);
});

// --- isTypePosition ----------------------------------------------------------

test("isTypePosition detects a `:` type annotation, including across a space", () => {
  assert.equal(isTypePosition("let x:"), true);
  assert.equal(isTypePosition("let x: "), true); // trailing space skipped
  assert.equal(isTypePosition("fn f(a:"), true);
  assert.equal(isTypePosition("(x + y):"), true); // closing bracket counts as an expression tail
});

test("isTypePosition rejects non-annotation colons and other positions", () => {
  assert.equal(isTypePosition("units::"), false); // module path, not an annotation
  assert.equal(isTypePosition("3:"), false); // a digit is not an identifier tail
  assert.equal(isTypePosition("1 + me"), false); // an ordinary word position
  assert.equal(isTypePosition("foo."), false); // member access, not a type
  assert.equal(isTypePosition(""), false);
});

// --- allowedCategoriesAt -----------------------------------------------------

/**
 * The allowed set at `source`, asserted to be a restriction rather than `null` (which means
 * "everything"), sorted so the comparison is order-independent.
 */
function narrowedAt(source: string): string[] {
  const allowed = allowedCategoriesAt(source);
  assert.ok(allowed, `expected ${JSON.stringify(source)} to restrict the allowed categories`);
  return [...allowed].sort();
}

test("allowedCategoriesAt returns null (all allowed) outside a `:` position", () => {
  assert.equal(allowedCategoriesAt("1 + me"), null);
  assert.equal(allowedCategoriesAt("foo."), null);
});

test("allowedCategoriesAt offers types, dimensions, and units at a `:` annotation", () => {
  assert.deepEqual(narrowedAt("let x: "), ["dimension", "type", "unit"]);
});

test("allowedCategoriesAt narrows a `unit <name>:` declaration to dimensions", () => {
  assert.deepEqual(narrowedAt("unit foo: "), ["dimension"]);
  // …including when the declaration is decorated.
  assert.deepEqual(narrowedAt("@metric_prefixes unit foo: "), ["dimension"]);
  // A plain let/fn annotation is not narrowed to dimensions.
  assert.notDeepEqual(narrowedAt("let unitPrice: "), ["dimension"]);
});

test("allowedCategoriesAt narrows a `dimension <name> = …` body to dimensions", () => {
  assert.deepEqual(narrowedAt("dimension Force = Mass * "), ["dimension"]);
  assert.deepEqual(narrowedAt("dimension Speed = "), ["dimension"]);
  // Before the `=` (still naming the dimension) it is not a dimension expression.
  assert.equal(allowedCategoriesAt("dimension Fo"), null);
  // A `let` whose value mentions a dimension is not a dimension declaration.
  assert.equal(allowedCategoriesAt("let dimension_count = "), null);
});

test("expressionCompletions filters by the allowed set as well as the toggles", () => {
  const raw = ["String", "Length", "meter", "sin", "to"];
  // At a `:` annotation: types, dimensions, units — but not functions or keywords.
  const atColon = expressionCompletions(raw, V, ALL_CATEGORIES, allowedCategoriesAt("let x: "));
  assert.deepEqual(atColon.map((c) => c.name), ["String", "Length", "meter"]);
  // At a `unit foo:` position: dimensions only.
  const atUnit = expressionCompletions(raw, V, ALL_CATEGORIES, allowedCategoriesAt("unit foo: "));
  assert.deepEqual(atUnit.map((c) => c.name), ["Length"]);

  // The allowed set and the toggles compose: turning off dimensions removes them even at a `:`
  // position that would otherwise allow them.
  const noDimensions = { ...ALL_CATEGORIES, dimensions: false };
  const atColonNoDims = expressionCompletions(raw, V, noDimensions, allowedCategoriesAt("let x: "));
  assert.deepEqual(atColonNoDims.map((c) => c.name), ["String", "meter"]);
});

// --- Generic `<` and return-arrow positions ------------------------------------

test("exprTriggerAt fires inside a just-opened generic parameter list", () => {
  assert.deepEqual(exprTriggerAt("List<"), { query: "", replaceLength: 0 });
  assert.deepEqual(exprTriggerAt("xs: List<S"), { query: "S", replaceLength: 1 });
  assert.deepEqual(exprTriggerAt("List< "), { query: "", replaceLength: 0 }); // trailing space skipped
});

test("exprTriggerAt does not read comparisons or lowercase names as generics", () => {
  assert.equal(exprTriggerAt("a<"), null); // lowercase: a comparison, not a generic
  assert.equal(exprTriggerAt("3<"), null);
  assert.equal(exprTriggerAt("a < "), null); // spaced comparison
  assert.equal(exprTriggerAt("Total < "), null); // capitalized but spaced: still a comparison
});

test("exprTriggerAt fires after a fn declaration's return arrow, but not a conversion", () => {
  assert.deepEqual(exprTriggerAt("fn f(x: Scalar) -> "), { query: "", replaceLength: 0 });
  assert.deepEqual(exprTriggerAt("fn f(x: Scalar) -> D"), { query: "D", replaceLength: 1 });
  assert.equal(exprTriggerAt("(2 + 3) -> "), null); // conversion, not a return type
  assert.equal(exprTriggerAt("fn f(x) = 3 m -> "), null); // conversion inside a body
});

test("allowedCategoriesAt treats generic and return-arrow positions as type positions", () => {
  assert.deepEqual([...allowedCategoriesAt("xs: List<") ?? []].sort(), ["dimension", "type", "unit"]);
  assert.deepEqual([...allowedCategoriesAt("fn f(x: Scalar) -> ") ?? []].sort(), ["dimension", "type", "unit"]);
  assert.equal(allowedCategoriesAt("(2 + 3) -> "), null); // a conversion target is not narrowed
});

// --- typeVariablesInScopeAt ----------------------------------------------------

/** The scraped parameter names, for the scope-focused tests below. */
function scopedNames(before: string): string[] {
  return typeVariablesInScopeAt(before).map((parameter) => parameter.name);
}

test("typeVariablesInScopeAt reads the enclosing declaration's parameters and bounds", () => {
  assert.deepEqual(typeVariablesInScopeAt("fn foo<D: Dim>(xs: List<"), [{ name: "D", dimBound: true }]);
  assert.deepEqual(typeVariablesInScopeAt("fn foo<A, B: Dim, C>(x: "), [
    { name: "A", dimBound: false },
    { name: "B", dimBound: true },
    { name: "C", dimBound: false },
  ]);
  assert.deepEqual(scopedNames("struct Pair<L, R> { first: "), ["L", "R"]);
  assert.deepEqual(scopedNames("@name(\"x\") fn foo<D>(x: "), ["D"]);
  // A list still being typed is read as far as it goes.
  assert.deepEqual(scopedNames("fn foo<D: Dim, E"), ["D", "E"]);
});

test("typeVariablesInScopeAt spans a multi-line declaration", () => {
  assert.deepEqual(scopedNames("fn foo<D: Dim>(\n  xs: List<D>,\n  y: "), ["D"]);
  assert.deepEqual(scopedNames("fn foo<D: Dim>(\n  xs: List<D>\n) -> "), ["D"]);
});

test("typeVariablesInScopeAt keeps the variables through the body and where clauses", () => {
  // The body may start on the line after `=` (the parser skips those newlines)…
  assert.deepEqual(scopedNames("fn foo<D: Dim>(x: D) -> D =\n  x + "), ["D"]);
  // …and `where`/`and` local-variable clauses continue the declaration.
  assert.deepEqual(scopedNames("fn foo<D: Dim>(x: D) -> D = y\n  where y: "), ["D"]);
  assert.deepEqual(scopedNames("fn foo<D: Dim>(x: D) -> D = y\n  where y = x\n  and z: "), ["D"]);
});

test("typeVariablesInScopeAt drops the variables once the declaration has ended", () => {
  // A following statement line ends the declaration…
  assert.deepEqual(scopedNames("fn foo<D: Dim>(x: D) -> D = x\nlet y: "), []);
  // …as does a blank line before ordinary code…
  assert.deepEqual(scopedNames("fn foo<D: Dim>(x: D) -> D = x\n\n2 m + "), []);
  // …or any other non-continuing line.
  assert.deepEqual(scopedNames("fn foo<D: Dim>(x: D) -> D = x\nmax(1 m, "), []);
});

test("typeVariablesInScopeAt scopes struct parameters to the struct body", () => {
  assert.deepEqual(scopedNames("struct Pair<L, R> {\n  first: "), ["L", "R"]);
  assert.deepEqual(scopedNames("struct Pair<L, R> { first: L, second: R }\nlet x: "), []);
});

test("typeVariablesInScopeAt only sees the nearest declaration", () => {
  assert.deepEqual(scopedNames("fn foo<A: Dim>(x: A) -> A = x\nfn bar<B: Dim>(y: "), ["B"]);
  assert.deepEqual(scopedNames("let plain = 2\nlet x: "), []);
});

test("typeVariablesInScopeAt keeps the variables through a multi-line if", () => {
  // `then`/`else` open a line of their own as readily as `where` does.
  assert.deepEqual(scopedNames("fn foo<D: Dim>(x: D) -> D =\n  if x > 0 D\n  then x\n  else -"), ["D"]);
  assert.deepEqual(scopedNames("fn foo<D: Dim>(x: D) -> D = if x > 0 D then\n  x\nelse\n  -"), ["D"]);
});

// --- declaredNamesIn -----------------------------------------------------------

/** The names an enclosing declaration binds at the end of `before`, as readable tuples. */
function bound(before: string): [string, string, string | null][] | null {
  const declaration = enclosingDeclarationAt(before);
  return declaration === null
    ? null
    : declaredNamesIn(declaration).map((name) => [name.kind, name.name, name.type]);
}

test("declaredNamesIn reads a function's parameters, typed and untyped", () => {
  assert.deepEqual(bound("fn f(a: Money, b: Money) -> Scalar = "), [
    ["parameter", "a", "Money"],
    ["parameter", "b", "Money"],
  ]);
  assert.deepEqual(bound("fn f(a, b) = "), [["parameter", "a", null], ["parameter", "b", null]]);
  // A generic's type parameters are not value parameters, and a type holding commas stays whole.
  assert.deepEqual(bound("fn mean<D: Dim>(xs: List<D>) -> D =\n  "), [["parameter", "xs", "List<D>"]]);
  assert.deepEqual(bound("fn apply(cb: Fn[(Scalar) -> Scalar], x: Scalar) = "), [
    ["parameter", "cb", "Fn[(Scalar) -> Scalar]"],
    ["parameter", "x", "Scalar"],
  ]);
});

test("declaredNamesIn reads the `where` and `and` locals of the body", () => {
  assert.deepEqual(bound("fn f(a: Scalar) = r + s\n  where r = a\n  and s: Scalar = a * 2\n  "), [
    ["parameter", "a", "Scalar"],
    ["local", "r", null],
    ["local", "s", "Scalar"],
  ]);
});

test("declaredNamesIn reads a struct's fields, and a struct has no locals", () => {
  assert.deepEqual(bound("struct Costs {\n  total: Money,\n  tax: Money,\n  "), [
    ["field", "total", "Money"],
    ["field", "tax", "Money"],
  ]);
});

test("declaredNamesIn reads a half-typed signature as far as it goes", () => {
  assert.deepEqual(bound("fn f(a: Money, b"), [["parameter", "a", "Money"], ["parameter", "b", null]]);
  // Nothing yet is nothing, rather than a guess.
  assert.deepEqual(bound("fn f"), []);
});

test("declaredNamesIn is not fooled by a comment or a decorator's own text", () => {
  assert.deepEqual(bound("@example(\"where q = 1\")\nfn f(a: Scalar) = r\n  where r = a\n  "), [
    ["parameter", "a", "Scalar"],
    ["local", "r", null],
  ]);
  assert.deepEqual(bound("fn f(a: Scalar) = r # where q = 1\n  where r = a\n  "), [
    ["parameter", "a", "Scalar"],
    ["local", "r", null],
  ]);
});

test("enclosingDeclarationAt reports the nearest open declaration, and nothing once it closes", () => {
  assert.deepEqual(enclosingDeclarationAt("fn f(a: Scalar) = a\nfn g(b: Scalar) = ")?.owner, "g");
  assert.equal(enclosingDeclarationAt("fn f(a: Scalar) = a\n1 + "), null);
  assert.equal(enclosingDeclarationAt("let x = 2\n"), null);
});

// --- declaredNameCompletions ---------------------------------------------------

test("declaredNameCompletions offers the parameters and locals of the enclosing function", () => {
  assert.deepEqual(
    declaredNameCompletions("fn f(a: Money, b: Money) = r\n  where r = ", "", ALL_CATEGORIES, null),
    [
      { name: "a", category: "parameter", declared: { kind: "parameter", type: "Money", owner: "f" } },
      { name: "b", category: "parameter", declared: { kind: "parameter", type: "Money", owner: "f" } },
      { name: "r", category: "local", declared: { kind: "local", type: null, owner: "f" } },
    ],
  );
  // Prefix-filtered against the typed query, which the engine could not do — it knows no such name.
  assert.deepEqual(
    declaredNameCompletions("fn f(local_price: Money, bench: Money) = ", "loc", ALL_CATEGORIES, null)
      .map((completion) => completion.name),
    ["local_price"],
  );
});

test("declaredNameCompletions stays out of type positions and off closed declarations", () => {
  // A type position is where the *type* variables go; a parameter is a value.
  assert.deepEqual(declaredNameCompletions("fn f(a: Money, b: ", "", ALL_CATEGORIES, AT_TYPE), []);
  // Past the end of the declaration the names it bound are gone.
  assert.deepEqual(declaredNameCompletions("fn f(a: Money) = a\n1 + ", "", ALL_CATEGORIES, null), []);
  // A struct's fields are reached through a value of it, never bare.
  assert.deepEqual(declaredNameCompletions("struct S {\n  x: Scalar,\n  ", "", ALL_CATEGORIES, null), []);
  // And the whole group is gated on the identifiers toggle.
  assert.deepEqual(
    declaredNameCompletions("fn f(a: Money) = ", "", { ...ALL_CATEGORIES, identifiers: false }, null),
    [],
  );
});

test("isInterpreterKnown is false for exactly the names no context has heard of", () => {
  const own: ExprCategory[] = ["decorator", "parameter", "local"];
  const engine: ExprCategory[] = ["variable", "function", "unit", "dimension", "type", "keyword", "field"];
  assert.deepEqual(own.map(isInterpreterKnown), own.map(() => false));
  assert.deepEqual(engine.map(isInterpreterKnown), engine.map(() => true));
});

// --- typeVariableCompletions ---------------------------------------------------

// A plain `:` annotation position: types, dimensions, and units allowed.
const AT_TYPE = allowedCategoriesAt("let x: ");

test("typeVariableCompletions categorizes Dim-bounded variables as dimensions", () => {
  // A `Dim`-bounded parameter is a dimension variable; an unbounded one a type.
  assert.deepEqual(
    typeVariableCompletions("fn foo<D: Dim>(xs: List<", "", ALL_CATEGORIES, AT_TYPE),
    [{ name: "D", category: "dimension" }],
  );
  assert.deepEqual(
    typeVariableCompletions("fn foo<A, B: Dim>(x: ", "", ALL_CATEGORIES, AT_TYPE),
    [{ name: "A", category: "type" }, { name: "B", category: "dimension" }],
  );
  // Prefix-filtered against the typed query (the engine cannot: it does not know these names).
  assert.deepEqual(
    typeVariableCompletions("fn foo<Din: Dim>(x: ", "Di", ALL_CATEGORIES, AT_TYPE),
    [{ name: "Din", category: "dimension" }],
  );
  assert.deepEqual(typeVariableCompletions("fn foo<D: Dim>(x: ", "L", ALL_CATEGORIES, AT_TYPE), []);
});

test("typeVariableCompletions stays out of value positions and respects the toggles", () => {
  // `allowed === null` is an unrestricted (value) position: a type variable is meaningless there.
  assert.deepEqual(typeVariableCompletions("fn foo<D: Dim>(x: D) -> D = 1 + ", "", ALL_CATEGORIES, null), []);
  // Each variable is gated by its own category's toggle.
  assert.deepEqual(
    typeVariableCompletions("fn foo<A, B: Dim>(x: ", "", { ...ALL_CATEGORIES, types: false }, AT_TYPE),
    [{ name: "B", category: "dimension" }],
  );
  assert.deepEqual(
    typeVariableCompletions("fn foo<A, B: Dim>(x: ", "", { ...ALL_CATEGORIES, dimensions: false }, AT_TYPE),
    [{ name: "A", category: "type" }],
  );
});

// --- boundCompletions ----------------------------------------------------------

test("boundCompletions offers exactly Dim on a type-parameter bound", () => {
  assert.deepEqual(boundCompletions("fn foo<D: ", "", ALL_CATEGORIES), [{ name: "Dim", category: "dimension" }]);
  assert.deepEqual(boundCompletions("fn foo<D:", "", ALL_CATEGORIES), [{ name: "Dim", category: "dimension" }]);
  assert.deepEqual(boundCompletions("fn foo<A, B: ", "Di", ALL_CATEGORIES), [{ name: "Dim", category: "dimension" }]);
  assert.deepEqual(boundCompletions("struct Pair<L: ", "", ALL_CATEGORIES), [{ name: "Dim", category: "dimension" }]);
});

test("boundCompletions filters by the query and the dimensions toggle", () => {
  assert.deepEqual(boundCompletions("fn foo<D: ", "L", ALL_CATEGORIES), []); // not a prefix of Dim
  assert.deepEqual(boundCompletions("fn foo<D: ", "", { ...ALL_CATEGORIES, dimensions: false }), []);
});

test("boundCompletions stands aside outside a bound position", () => {
  assert.equal(boundCompletions("let x: ", "", ALL_CATEGORIES), null);
  assert.equal(boundCompletions("fn foo<D: Dim>(x: ", "", ALL_CATEGORIES), null); // list already closed
  assert.equal(boundCompletions("1 + me", "me", ALL_CATEGORIES), null);
});

// --- decoratorCompletions ------------------------------------------------------

test("decoratorCompletions offers the whole set on a bare `@`, with what to insert", () => {
  const all = decoratorCompletions("@", "", ALL_CATEGORIES, true);
  assert.ok(all !== null);
  assert.deepEqual(all.map((c) => c.name).sort(), [
    "abbreviation",
    "aliases",
    "binary_prefixes",
    "description",
    "example",
    "metric_prefixes",
    "name",
    "url",
  ]);
  assert.ok(all.every((c) => c.category === "decorator"));

  // A string-argument decorator writes its quotes and puts the caret between them; a bare one
  // writes just its name, caret at the end.
  const byName = new Map(all.map((c) => [c.name, c.applied]));
  assert.deepEqual(byName.get("name"), { text: "name(\"\")", caret: 6 });
  assert.deepEqual(byName.get("aliases"), { text: "aliases()", caret: 8 });
  assert.deepEqual(byName.get("metric_prefixes"), { text: "metric_prefixes", caret: 15 });
});

test("decoratorCompletions filters by the query and the keywords toggle", () => {
  assert.deepEqual(decoratorCompletions("@", "me", ALL_CATEGORIES, true)?.map((c) => c.name), ["metric_prefixes"]);
  assert.deepEqual(decoratorCompletions("@", "zz", ALL_CATEGORIES, true), []);
  assert.deepEqual(decoratorCompletions("@", "", { ...ALL_CATEGORIES, keywords: false }, true), []);
});

test("decoratorCompletions recognizes an `@` after earlier decorators, on any line", () => {
  assert.ok(decoratorCompletions("@metric_prefixes @", "", ALL_CATEGORIES, true) !== null);
  assert.ok(decoratorCompletions("@name(\"Foo\") @", "", ALL_CATEGORIES, true) !== null);
  assert.ok(decoratorCompletions("let x = 1\n@", "", ALL_CATEGORIES, true) !== null);
  assert.ok(decoratorCompletions("  @", "", ALL_CATEGORIES, true) !== null);
});

test("decoratorCompletions stands aside where an `@` does not open a decorator", () => {
  assert.equal(decoratorCompletions("1 + @", "", ALL_CATEGORIES, true), null);
  assert.equal(decoratorCompletions("let x = @", "", ALL_CATEGORIES, true), null);
  assert.equal(decoratorCompletions("@name", "name", ALL_CATEGORIES, true), null); // past the name, not at it
  assert.equal(decoratorCompletions("me", "me", ALL_CATEGORIES, true), null);
});

test("decoratorCompletions offers nothing on a surface that holds only an expression", () => {
  // An inline span and a frontmatter value have no statement for a decorator to annotate. The
  // position is still claimed — an empty list, not `null` — so the caller shows nothing rather than
  // falling through to engine names, which are just as illegal after the `@`.
  assert.deepEqual(decoratorCompletions("@", "", ALL_CATEGORIES, false), []);
  assert.deepEqual(decoratorCompletions("@", "na", ALL_CATEGORIES, false), []);
  // Somewhere that is not a decorator position at all still stands aside, so ordinary completion
  // carries on as before.
  assert.equal(decoratorCompletions("1 + me", "me", ALL_CATEGORIES, false), null);
});

test("decoratorDoc answers for Numbat's decorators and nothing else", () => {
  assert.match(decoratorDoc("description") ?? "", /describing/);
  assert.equal(decoratorDoc("nonexistent"), null);
  assert.equal(decoratorDoc("name "), null);
});

test("typeDoc answers for every type name the completer offers, plus Opt", () => {
  // The built-ins are documented because Numbat documents none of them — so if the completer offers
  // a type name, hovering it has something to say.
  for (const name of BUILTIN_TYPE_NAMES) {
    assert.match(typeDoc(name) ?? "", /\S/, `${name} has no description`);
  }
  assert.equal(typeDoc(NULLABLE_STRUCT), NULLABLE_STRUCT_DOC);

  assert.equal(typeDoc("Length"), null, "a dimension is not a type the plugin describes");
  assert.equal(typeDoc("nonexistent"), null);
  assert.equal(typeDoc("list"), null, "the lookup is exact, and Numbat's type names are capitalized");
});

test("pluginTypeCandidates offers Opt the way Numbat offers its own type names", () => {
  // Case-sensitive, as the engine is: `Bool` completes from `Bo` and not from `bo`, and a name
  // standing beside it in the same list should not behave differently.
  assert.deepEqual(pluginTypeCandidates("Op"), [NULLABLE_STRUCT]);
  assert.deepEqual(pluginTypeCandidates("Opt"), [NULLABLE_STRUCT]);
  assert.deepEqual(pluginTypeCandidates("op"), []);
  assert.deepEqual(pluginTypeCandidates("Opz"), []);

  // An empty query offers it: that is a just-opened type position (`List<`, or a `:` annotation),
  // which is exactly where it is worth suggesting.
  assert.deepEqual(pluginTypeCandidates(""), [NULLABLE_STRUCT]);

  // The built-ins are not repeated here — the engine already returns them.
  for (const name of BUILTIN_TYPE_NAMES) {
    assert.deepEqual(pluginTypeCandidates(name), [], `${name} is offered twice`);
  }
});

test("an injected type name classifies as a type, and survives to the completer", () => {
  assert.equal(classifyCompletion(NULLABLE_STRUCT, V), "type");

  // The whole path: the engine's list plus the injected name, categorized and gated as one.
  const raw = ["Length", ...pluginTypeCandidates("")];
  assert.deepEqual(expressionCompletions(raw, V, ALL_CATEGORIES), [
    { name: "Length", category: "dimension" },
    { name: NULLABLE_STRUCT, category: "type" },
  ]);

  // Gated by the types toggle, like every other type.
  const off = { identifiers: false, keywords: false, units: false, dimensions: false, types: false };
  assert.deepEqual(expressionCompletions(raw, V, off).map((c) => c.name), []);
  assert.deepEqual(expressionCompletions(raw, V, { ...off, types: true }).map((c) => c.name), [NULLABLE_STRUCT]);

  // And offered at a type position, where a variable or a function would not be.
  const atType = expressionCompletions(raw, V, ALL_CATEGORIES, new Set<ExprCategory>(["type", "dimension", "unit"]));
  assert.deepEqual(atType.map((c) => c.name), ["Length", NULLABLE_STRUCT]);
});

test("a reader's own binding outranks the injected type name", () => {
  // `Opt` is bindable (unlike `List`), so if the vocabulary has one it is theirs, and the row says
  // so — the same rule the hover card follows. This is why the plugin's set is checked last.
  const bound = { ...V, variables: new Set([...V.variables, NULLABLE_STRUCT]) };
  assert.equal(classifyCompletion(NULLABLE_STRUCT, bound), "variable");

  // Offered once, not twice, when the engine returns it as well.
  const raw = ["Opt", ...pluginTypeCandidates("Op")];
  assert.deepEqual(expressionCompletions(raw, bound, ALL_CATEGORIES), [{ name: "Opt", category: "variable" }]);
});

test("Opt is described but is not one of the grammar's reserved words", () => {
  // The two sets are deliberately separate: BUILTIN_TYPE_NAMES doubles as the blocklist of words
  // Numbat's grammar refuses as a struct field (properties/parse.ts), and `Opt` is an ordinary name
  // there. Putting it in would skip a frontmatter property called `opt` for no reason.
  assert.equal(BUILTIN_TYPE_NAMES.has(NULLABLE_STRUCT), false);
  assert.notEqual(typeDoc(NULLABLE_STRUCT), null);
});

test("exprTriggerAt fires on a decorator's `@` before the two-character minimum", () => {
  // The `@` is not replaced — only the name typed after it.
  assert.deepEqual(exprTriggerAt("@"), { query: "", replaceLength: 0 });
  assert.deepEqual(exprTriggerAt("@n"), { query: "n", replaceLength: 1 });
  assert.deepEqual(exprTriggerAt("@metric_prefixes\n@d"), { query: "d", replaceLength: 1 });
  // Not a decorator position: the ordinary rules apply, so a single character does not fire.
  assert.equal(exprTriggerAt("1 + @"), null);
});

// --- member access ------------------------------------------------------------

test("memberBaseAt finds the struct being completed, or nothing", () => {
  assert.equal(memberBaseAt("costs."), "costs");
  assert.equal(memberBaseAt("costs.ma"), "costs");
  assert.equal(memberBaseAt("costs.inner."), "costs.inner");
  assert.equal(memberBaseAt("let x = 2 + costs."), "costs");
  assert.equal(memberBaseAt("3."), null); // a decimal point, not member access
  assert.equal(memberBaseAt("costs"), null); // no dot yet
  assert.equal(memberBaseAt("foo(bar)."), null); // only name paths are bases
  assert.equal(memberBaseAt(""), null);
});

// Numbat names the whole struct in its missing-field diagnostic — the only place it exposes a
// value's fields. These are real messages, captured from the built wasm (v1.23.0) after
// `plainText`; if a future Numbat rewords them the parse yields nothing and member completion
// quietly stops.
const MISSING = "  │ ----- ^^^ Field '_numbat_member_probe' does not exist in struct "
  + "'C {materials: Money, labor: Length}'";
const MISSING_NESTED = "  │ ----- ^^^ Field '_numbat_member_probe' does not exist in struct "
  + "'Outer {doubled: Scalar}> {materials: Money, labor: Length, breakdown: Inner {doubled: Scalar}}'";

test("structFieldNames reads the field list out of a missing-field diagnostic", () => {
  assert.deepEqual(structFieldNames(MISSING), ["materials", "labor"]);
});

test("structFieldNames takes the outer struct's fields, not a nested one's", () => {
  // `plainText` eats the `<…>` type parameters as if they were HTML tags, which is why the captured
  // message reads oddly — the trailing brace group is what counts.
  assert.deepEqual(structFieldNames(MISSING_NESTED), ["materials", "labor", "breakdown"]);
});

test("structFieldNames handles a field whose type contains commas and arrows", () => {
  assert.deepEqual(
    structFieldNames("Field 'x' does not exist in struct 'S {f: Fn[(A, B) -> C], n: Scalar}'"),
    ["f", "n"],
  );
});

test("structFieldNames yields nothing for anything that is not that diagnostic", () => {
  assert.deepEqual(structFieldNames("error: while parsing"), []);
  assert.deepEqual(structFieldNames(""), []);
  assert.deepEqual(structFieldNames("Field 'x' does not exist in struct 'S'"), []);
});
