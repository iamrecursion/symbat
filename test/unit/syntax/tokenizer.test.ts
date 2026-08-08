import assert from "node:assert/strict";
import { test } from "node:test";
import { tokensForLine } from "../../../src/syntax/tokenizer.ts";

// Map a line to [substring, class] pairs for concise assertions.
function tag(line: string): Array<[string, string]> {
  return tokensForLine(line).map((t) => [line.slice(t.start, t.end), t.cls]);
}

test("classifies keywords, identifiers, values and operators", () => {
  assert.deepEqual(tag("let x = 5 metre"), [
    ["let", "numbat-keyword"],
    ["x", "numbat-identifier"],
    ["=", "numbat-operator"],
    ["5", "numbat-value"],
    ["metre", "numbat-identifier"],
  ]);
});

test("treats a whole line comment as a comment", () => {
  assert.deepEqual(tag("# a comment"), [["# a comment", "numbat-comment"]]);
});

test("classifies strings and decorators", () => {
  assert.deepEqual(tag("@name \"Hz\""), [
    ["@name", "numbat-decorator"],
    ["\"Hz\"", "numbat-string"],
  ]);
});

test("a decorator's parentheses and argument are not part of its token", () => {
  // Only `@name` takes the decorator color; the string stays a string and the parens stay
  // unclassed, which is how Numbat's own formatter splits them too.
  assert.deepEqual(tag("@name(\"Foo\")"), [
    ["@name", "numbat-decorator"],
    ["\"Foo\"", "numbat-string"],
  ]);
  assert.deepEqual(tag("@aliases(m: short)"), [
    ["@aliases", "numbat-decorator"],
    ["m", "numbat-identifier"],
    ["short", "numbat-keyword"], // an alias suffix is a keyword of the decorator's own grammar
  ]);
});

test("handles the -> conversion operator and units", () => {
  assert.deepEqual(tag("3 mile -> km"), [
    ["3", "numbat-value"],
    ["mile", "numbat-identifier"],
    ["-", "numbat-operator"],
    [">", "numbat-operator"],
    ["km", "numbat-identifier"],
  ]);
});

test("emits no tokens for a blank line", () => {
  assert.deepEqual(tokensForLine("   "), []);
});

test("offsets are correct within the line", () => {
  const tokens = tokensForLine("  let");
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].start, 2);
  assert.equal(tokens[0].end, 5);
});

test("statically, a capitalized identifier reads as a type (no vocab)", () => {
  assert.deepEqual(tag("let x: Length = 5 m"), [
    ["let", "numbat-keyword"],
    ["x", "numbat-identifier"],
    ["Length", "numbat-type-identifier"], // capitalized → type heuristic
    ["=", "numbat-operator"],
    ["5", "numbat-value"],
    ["m", "numbat-identifier"], // lowercase, no vocab → identifier
  ]);
});

test("a wordKind classifier colors types, dimensions, and units distinctly", () => {
  const wordKind = (w: string) => (w === "Length" ? "dimension" : w === "m" ? "unit" : null);
  const line = "let x: Length = 5 m";
  const tagged = tokensForLine(line, wordKind).map((t) => [line.slice(t.start, t.end), t.cls]);
  assert.deepEqual(tagged, [
    ["let", "numbat-keyword"],
    ["x", "numbat-identifier"],
    ["Length", "numbat-dimension"], // known dimension
    ["=", "numbat-operator"],
    ["5", "numbat-value"],
    ["m", "numbat-unit"], // known unit
  ]);
});

test("wordKind overrides the capitalization heuristic (capitalized unit → unit)", () => {
  const wordKind = (w: string) => (w === "A" ? "unit" : null);
  // `A` is a capitalized unit — semantic wins over the type heuristic; `Foo` is an unknown
  // capitalized word, so it falls back to the type heuristic.
  assert.deepEqual(tokensForLine("A + Foo", wordKind).map((t) => t.cls), [
    "numbat-unit",
    "numbat-operator",
    "numbat-type-identifier",
  ]);
});

test("keywords still win over the classifier and the heuristic", () => {
  const wordKind = () => "type" as const;
  assert.deepEqual(tokensForLine("let", wordKind).map((t) => t.cls), ["numbat-keyword"]);
});

// --- Eager declaration-site coloring (LexState) -----------------------------

test("a dimension declaration colors its name a dimension, eagerly (no vocab)", () => {
  // Without the semantic vocab, `Foo` would fall to the capitalization heuristic (type); the
  // `dimension` keyword marks it as the declared dimension instead.
  assert.deepEqual(tag("dimension Foo"), [
    ["dimension", "numbat-keyword"],
    ["Foo", "numbat-dimension"],
  ]);
  // And with a `= …` body: only the declared name is forced; the body still uses the heuristic
  // (`Length` → type here, absent the vocab).
  assert.deepEqual(tag("dimension Speed = Length / Time").slice(0, 2), [
    ["dimension", "numbat-keyword"],
    ["Speed", "numbat-dimension"],
  ]);
});

test("a unit declaration colors its name a unit, eagerly, even when decorated", () => {
  assert.deepEqual(tag("unit baz = 5 metre").slice(0, 2), [
    ["unit", "numbat-keyword"],
    ["baz", "numbat-unit"], // lowercase name would otherwise be a plain identifier
  ]);
  // Decorators precede the keyword; the name after `unit` is still the one marked, and the `:`
  // annotation that follows is a dimension (see the dedicated case below).
  assert.deepEqual(tag("@metric_prefixes unit foo: Length"), [
    ["@metric_prefixes", "numbat-decorator"],
    ["unit", "numbat-keyword"],
    ["foo", "numbat-unit"],
    ["Length", "numbat-dimension"], // the `unit …:` annotation is a dimension
  ]);
});

test("the declaration name mark applies only to the immediately following identifier", () => {
  // `dimension` on its own line does not bleed into the next line's first word.
  assert.deepEqual(tag("dimension"), [["dimension", "numbat-keyword"]]);
  assert.deepEqual(tag("Foo"), [["Foo", "numbat-type-identifier"]]); // heuristic, not forced
  // Only the first identifier is the declared name; a second one (before any `=` body) is not
  // forced — it falls back to the heuristic.
  assert.deepEqual(tag("dimension Foo Bar"), [
    ["dimension", "numbat-keyword"],
    ["Foo", "numbat-dimension"], // declared name
    ["Bar", "numbat-type-identifier"], // not forced (no `=` body yet)
  ]);
});

test("a `unit <name>:` annotation colors its dimension type, even when unknown", () => {
  // The `:` of a unit declaration introduces a dimension — a position we know statically, so
  // `MyDim` reads as a dimension without the interpreter's vocab.
  assert.deepEqual(tag("unit MyFoo: MyDim"), [
    ["unit", "numbat-keyword"],
    ["MyFoo", "numbat-unit"], // the declared unit name
    ["MyDim", "numbat-dimension"], // the annotation is a dimension, forced
  ]);
  // A compound annotation up to the `=`; the value after `=` is ordinary again.
  assert.deepEqual(tag("unit rho: Mass / Length = 1 kg / meter"), [
    ["unit", "numbat-keyword"],
    ["rho", "numbat-unit"],
    ["Mass", "numbat-dimension"],
    ["/", "numbat-operator"],
    ["Length", "numbat-dimension"],
    ["=", "numbat-operator"],
    ["1", "numbat-value"],
    ["kg", "numbat-identifier"], // value part: ordinary (no vocab → identifier)
    ["/", "numbat-operator"],
    ["meter", "numbat-identifier"],
  ]);
});

test("a `dimension <name> = …` body colors its dimension expression", () => {
  assert.deepEqual(tag("dimension Speed = Length / Time"), [
    ["dimension", "numbat-keyword"],
    ["Speed", "numbat-dimension"], // declared name
    ["=", "numbat-operator"],
    ["Length", "numbat-dimension"], // body: forced dimensions
    ["/", "numbat-operator"],
    ["Time", "numbat-dimension"],
  ]);
});

test("a `let x: Type` annotation is NOT forced to a dimension (only unit declarations are)", () => {
  // A plain `:` type annotation stays a type/identifier position — the dimension forcing is
  // specific to `unit <name>:` and `dimension <name> =`.
  assert.deepEqual(tag("let x: Length = 5 m"), [
    ["let", "numbat-keyword"],
    ["x", "numbat-identifier"],
    ["Length", "numbat-type-identifier"], // heuristic, not forced to a dimension
    ["=", "numbat-operator"],
    ["5", "numbat-value"],
    ["m", "numbat-identifier"],
  ]);
});

test("Dim and the type parameters it bounds color as dimensions", () => {
  assert.deepEqual(tag("fn abs<T: Dim>(x: T) -> T = x"), [
    ["fn", "numbat-keyword"],
    ["abs", "numbat-identifier"],
    ["<", "numbat-operator"],
    ["T", "numbat-dimension"], // declaration site, spotted by the `: Dim` lookahead
    ["Dim", "numbat-dimension"], // the bound itself
    [">", "numbat-operator"],
    ["x", "numbat-identifier"],
    ["T", "numbat-dimension"], // a later use, via the recorded set
    ["-", "numbat-operator"],
    [">", "numbat-operator"],
    ["T", "numbat-dimension"],
    ["=", "numbat-operator"],
    ["x", "numbat-identifier"],
  ]);
});

test("an unbounded type parameter keeps reading as a type", () => {
  assert.deepEqual(tag("fn id<A>(x: A) -> A = x").filter(([w]) => w === "A"), [
    ["A", "numbat-type-identifier"],
    ["A", "numbat-type-identifier"],
    ["A", "numbat-type-identifier"],
  ]);
});

test("struct type-parameter bounds color like fn ones", () => {
  assert.deepEqual(tag("struct Pair<L: Dim, R> { x: L }").filter(([w]) => w === "L" || w === "Dim" || w === "R"), [
    ["L", "numbat-dimension"],
    ["Dim", "numbat-dimension"],
    ["R", "numbat-type-identifier"], // unbounded → type heuristic
    ["L", "numbat-dimension"],
  ]);
});

test("comparisons outside a declaration are untouched by the bound lookahead", () => {
  assert.deepEqual(tag("let y = a < b"), [
    ["let", "numbat-keyword"],
    ["y", "numbat-identifier"],
    ["=", "numbat-operator"],
    ["a", "numbat-identifier"],
    ["<", "numbat-operator"],
    ["b", "numbat-identifier"],
  ]);
});

// --- currency symbols and Unicode identifiers ---------------------------------

test("currency symbols color as units, wherever they appear", () => {
  // Every `\p{Sc}` symbol is a unit name in Numbat and nothing else, so this needs no vocabulary —
  // which is what makes a rounded value (re-tokenized here) agree with an unrounded one (colored by
  // Numbat's own formatter).
  assert.deepEqual(tag("9600.000 €"), [["9600.000", "numbat-value"], ["€", "numbat-unit"]]);
  assert.deepEqual(tag("12 $"), [["12", "numbat-value"], ["$", "numbat-unit"]]);
  assert.deepEqual(tag("3 £"), [["3", "numbat-value"], ["£", "numbat-unit"]]);
  assert.deepEqual(tag("100 ¥"), [["100", "numbat-value"], ["¥", "numbat-unit"]]);
  assert.deepEqual(tag("500 ₹"), [["500", "numbat-value"], ["₹", "numbat-unit"]]);
});

test("an identifier may start with a non-ASCII letter", () => {
  // `[A-Za-z_]` + `\w` used to drop the leading character and tokenize the tail, so `µm` colored as
  // a bare `m`.
  assert.deepEqual(tag("1 µm"), [["1", "numbat-value"], ["µm", "numbat-identifier"]]);
  // One token, not a dropped `Δ` and a lone `t`. It reads as a type because `Δ` is an uppercase
  // letter — the same capitalization heuristic any `let Foo` gets.
  assert.deepEqual(tag("let Δt = 2"), [
    ["let", "numbat-keyword"],
    ["Δt", "numbat-type-identifier"],
    ["=", "numbat-operator"],
    ["2", "numbat-value"],
  ]);
});

// --- Numeric literals --------------------------------------------------------
//
// The scanner used to eat an exponent sign unconditionally (so `2+3` was one token) and to accept
// hex digits with no `0x` prefix (so `5cm` was `5c` + `m`).

test("a number does not swallow a following operator", () => {
  assert.deepEqual(tag("2+3"), [
    ["2", "numbat-value"],
    ["+", "numbat-operator"],
    ["3", "numbat-value"],
  ]);
  assert.deepEqual(tag("5-3"), [
    ["5", "numbat-value"],
    ["-", "numbat-operator"],
    ["3", "numbat-value"],
  ]);
});

test("a unit written against a number is its own token", () => {
  for (
    const [line, num, unit] of [["5cm", "5", "cm"], ["2bar", "2", "bar"], ["100ohm", "100", "ohm"], ["5ft", "5", "ft"]]
  ) {
    assert.deepEqual(tag(line), [[num, "numbat-value"], [unit, "numbat-identifier"]], line);
  }
});

test("exponents, radix prefixes and digit separators are single tokens", () => {
  for (const literal of ["1e10", "1.5e-3", "2E+8", "0x1f", "0o755", "0b1011", "1_000", "3.25"]) {
    assert.deepEqual(tag(literal), [[literal, "numbat-value"]], literal);
  }
});

test("a bare exponent letter is not part of the number", () => {
  assert.deepEqual(tag("2e"), [["2", "numbat-value"], ["e", "numbat-identifier"]]);
});
