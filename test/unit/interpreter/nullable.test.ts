import assert from "node:assert/strict";
import { test } from "node:test";
import { readableNullables } from "../../../src/interpreter/nullable-display.ts";
import {
  definedValue,
  NULLABLE_ABSENT,
  NULLABLE_DECLARATIONS,
  NULLABLE_NAMES,
  NULLABLE_PRELUDE,
  NULLABLE_STRUCT,
  NULLABLE_STRUCT_DOC,
} from "../../../src/interpreter/nullable.ts";

// --- the injected vocabulary --------------------------------------------------

/** The head of a declaration: its last line, the decorators above it stripped off. */
const head = (declaration: string) => declaration.split("\n").at(-1) ?? "";

test("the prelude binds every documented name, one declaration apiece", () => {
  assert.equal(NULLABLE_DECLARATIONS[0], `struct ${NULLABLE_STRUCT}<T> { value: List<T> }`);
  assert.equal(NULLABLE_PRELUDE, NULLABLE_DECLARATIONS.join("\n"));

  for (const name of NULLABLE_NAMES) {
    // `nil` is a `let`, `undefined` its alias, and the rest are `fn`s — a generic one but for
    // `some`'s own argument, which fixes nothing, so every spelling of the head is accepted.
    const binds = (declaration: string) =>
      [`fn ${name}<`, `fn ${name}(`, `let ${name} =`].some((form) => head(declaration).startsWith(form))
      || declaration.includes(`@aliases(${name})`);
    assert.equal(NULLABLE_DECLARATIONS.filter(binds).length, 1, `${name} is bound other than once`);
  }
});

test("every declaration the interpreter can describe carries a description", () => {
  // The struct is the exception, and not by choice: Numbat rejects a decorator on a `struct`, which
  // is why `Opt` is documented on the plugin's side instead.
  const [struct, ...documented] = NULLABLE_DECLARATIONS;
  assert.equal(struct.includes("@description"), false);
  assert.equal(documented.length, NULLABLE_DECLARATIONS.length - 1);

  for (const declaration of documented) {
    assert.match(declaration, /^@description\("[^"]+"\)\n/, declaration);
    // A description is a plain string literal, so a quote inside one would end it early.
    assert.equal((declaration.match(/"/g) ?? []).length, 2, declaration);
  }

  assert.ok(NULLABLE_STRUCT_DOC.length > 0);
  assert.equal(NULLABLE_STRUCT_DOC.includes("\""), false);
});

test("the constructors are the two literals, under names the reader can write", () => {
  const heads = NULLABLE_DECLARATIONS.map(head);
  assert.ok(heads.includes(`let nil = ${NULLABLE_ABSENT}`), NULLABLE_PRELUDE);
  assert.ok(
    heads.includes(`fn some<T>(x: T) -> ${NULLABLE_STRUCT}<T> = ${NULLABLE_STRUCT} { value: [x] }`),
    NULLABLE_PRELUDE,
  );

  // `nil` has to follow the struct it is built from, so it cannot come first.
  assert.ok(heads.findIndex((line) => line.startsWith("let nil")) > 0);

  // `undefined` is an alias rather than a second binding: one value, two spellings, so they cannot
  // drift apart.
  assert.match(NULLABLE_PRELUDE, /@aliases\(undefined\)\nlet nil = /);
});

test("the two literals are the two states of one list", () => {
  assert.equal(NULLABLE_ABSENT, `${NULLABLE_STRUCT} { value: [] }`);
  // Parenthesized: an item like `5 km + 3 mi` must stay one element of the list, not two.
  assert.equal(definedValue("5 km + 3 mi"), `${NULLABLE_STRUCT} { value: [(5 km + 3 mi)] }`);
});

// --- the display rewrite ------------------------------------------------------

/** Numbat's formatter emits one span per token, which is what the rewrite matches on. */
const op = (text: string) => `<span class="numbat-operator">${text}</span>`;
const type = (text: string) => `<span class="numbat-type-identifier">${text}</span>`;
const value = (text: string) => `<span class="numbat-value">${text}</span>`;
const ident = (text: string) => `<span class="numbat-identifier">${text}</span>`;

/** A nullable value as Numbat prints it: `Opt { value: [ … ] }`. */
const nullable = (held: string) =>
  `${type(NULLABLE_STRUCT)} ${op("{")} ${ident("value")}${op(":")} ${op("[")}${held}${op("]")} ${op("}")}`;

/** The rewritten output with its markup removed, for assertions about what the reader sees. */
const plain = (html: string) => html.replace(/<[^>]+>/g, "");

test("output holding no nullable is returned unchanged", () => {
  const untouched = `${value("2003")} ${op("+")} ${value("1")}`;
  assert.equal(readableNullables(untouched), untouched);
});

test("a present value reads as the value it holds, spans and all", () => {
  const held = `${value("70")} ${op("kg")}`;
  const rewritten = readableNullables(nullable(held));

  assert.equal(rewritten, held);
  // The inner value keeps its own classes, so it colors as it would anywhere else.
  assert.match(rewritten, /class="numbat-value">70</);
});

test("an absent value reads as nil", () => {
  // A class of its own, not `numbat-dimmed`: that one marks where a result's `[Dimension]`
  // annotation begins, and inlay-parse.ts cuts the value there.
  assert.equal(readableNullables(nullable("")), "<span class=\"numbat-undefined\">nil</span>");
  assert.equal(plain(readableNullables(nullable(" "))), "nil");
});

test("a list of both reads as a list with a hole in it", () => {
  const list = `${op("[")}${nullable(value("70"))}${op(",")} ${nullable("")}${op("]")}`;
  assert.equal(plain(readableNullables(list)), "[70, nil]");
});

test("a nullable type is shown as it is written", () => {
  // The type is left alone on purpose: `Opt<Scalar>` is what the reader would write in an
  // annotation, so it is what they are shown. There is no `?` sugar to undo, and none to accept.
  const scalar = `${type(NULLABLE_STRUCT)}${op("&lt;")}${type("Scalar")}${op("&gt;")}`;
  assert.equal(readableNullables(scalar), scalar);

  const inList = `${type("List")}${op("&lt;")}${scalar}${op("&gt;")}`;
  assert.equal(readableNullables(inList), inList);

  const forall = `<span class="numbat-keyword">forall</span> ${type("A")}${op(".")} ${type(NULLABLE_STRUCT)}${
    op("&lt;")
  }${type("A")}${op("&gt;")}`;
  assert.equal(plain(readableNullables(forall)), "forall A. Opt&lt;A&gt;");
});

test("a brace written inside a string cannot break the match", () => {
  // The formatter puts a string's body in its own span, so a `{` in it is never an operator — which
  // is the whole reason this works on spans rather than on text.
  const held = `${op("\"")}<span class="numbat-string">a{b</span>${op("\"")}`;
  assert.equal(plain(readableNullables(nullable(held))), "\"a{b\"");
});

test("nullables nest", () => {
  assert.equal(plain(readableNullables(nullable(nullable(value("70"))))), "70");
  assert.equal(plain(readableNullables(nullable(nullable("")))), "nil");
});

test("rewriting twice changes nothing further", () => {
  const once = readableNullables(nullable(value("70")));
  assert.equal(readableNullables(once), once);
});

test("the bare name is left alone", () => {
  // Nothing to rewrite it into, and nothing that wants rewriting: it is the name the reader writes.
  const bare = `<span class="numbat-diagnostic-red">${NULLABLE_STRUCT}</span>`;
  assert.equal(readableNullables(bare), bare);
  assert.equal(readableNullables(type(NULLABLE_STRUCT)), type(NULLABLE_STRUCT));
});

test("a word that merely starts with the name is not the name", () => {
  // `Opt` is three letters, so the cheap `includes` guard lets this through — and both passes have
  // to be exact enough that nothing happens to it anyway.
  const prose = `<span class="numbat-diagnostic-red">Options&lt;Scalar&gt; is not a type</span>`;
  assert.equal(readableNullables(prose), prose);
  assert.equal(readableNullables(type("Optional")), type("Optional"));
});

// --- the diagnostic rewrite ---------------------------------------------------

/** An error message as Numbat renders one: prose inside a single span, with the type argument's
 *  angle brackets left *unescaped* — which is why the span matching cannot reach it. */
const diagnostic = (text: string) => `<span class="numbat-diagnostic-red">${text}</span>`;

/** The struct as an error message dumps it: the type argument, then the body holding it again. */
const dump = (arg: string) => `${NULLABLE_STRUCT}<${arg}> {value: List<${arg}>}`;

test("a type error names the type without restating how it is built", () => {
  // Escaped on the way out though it was raw on the way in: Numbat's brackets never reach the
  // reader, since the sanitizer parses `<Scalar>` as an element. See escapeAngles.
  assert.equal(
    readableNullables(diagnostic(`Expected dimension type, got ${dump("Scalar")} instead`)),
    diagnostic("Expected dimension type, got Opt&lt;Scalar&gt; instead"),
  );

  // An argument that nests, so the scan has to count rather than stop at the first `>`.
  assert.equal(
    readableNullables(diagnostic(`got ${dump("List<Scalar>")} instead`)),
    diagnostic("got Opt&lt;List&lt;Scalar&gt;&gt; instead"),
  );

  // Nothing fixed the type, so the argument is still Numbat's own variable — but the message is now
  // one line about one type rather than that type followed by its own definition.
  assert.equal(
    readableNullables(diagnostic(`got ${dump("T389")} instead`)),
    diagnostic("got Opt&lt;T389&gt; instead"),
  );

  // The constraint form, where what follows the dump is punctuation rather than prose.
  assert.equal(
    readableNullables(diagnostic(`Could not solve the following constraint: ${dump("Scalar")}: DType`)),
    diagnostic("Could not solve the following constraint: Opt&lt;Scalar&gt;: DType"),
  );
});

test("only an exact repeat of the type argument is rewritten", () => {
  // The two halves disagreeing means this is not the struct dump, whatever else it is.
  const mismatched = diagnostic(`${NULLABLE_STRUCT}<A> {value: List<B>}`);
  assert.equal(readableNullables(mismatched), mismatched);

  // The prelude's own source, which an arity error quotes to show where `get` is defined. A
  // definition rather than a type being reported, so rewriting it would misquote the plugin to the
  // reader.
  const source = diagnostic(`fn get<T>(n: ${NULLABLE_STRUCT}<T>) -> T = head(n.value)`);
  assert.equal(readableNullables(source), source);
});

test("a dump inside a dump collapses innermost first", () => {
  const once = readableNullables(diagnostic(`got ${dump(dump("Scalar"))} instead`));
  assert.equal(once, diagnostic("got Opt&lt;Opt&lt;Scalar&gt;&gt; instead"));

  // Escaping is not applied twice: what the inner rewrite already escaped is left as it is, which
  // is also what makes a second pass over the whole thing a no-op.
  assert.equal(readableNullables(once), once);
});
