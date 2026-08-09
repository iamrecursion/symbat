// The nullable value the plugin injects into every Numbat context, and the two literals the
// property derivation writes with it.
//
// A frontmatter property that is *undefined* — an empty `key:`, an item written as nothing, a field
// one element of an array leaves out — used to be dropped, and dropped the structure around it with
// it (see properties/parse.ts). It binds one of these instead, so the list or the object survives
// and the reader decides what the hole means (`get_or(x, 0)`).
//
// No imports, so this is unit-testable without Obsidian or the wasm bindings, and the (equally
// pure) properties/parse.ts can import it without giving up being data-only.

/**
 * The struct every nullable value is built with — and, unlike the rest of the plugin's generated
 * vocabulary, a name meant to be read *and written*.
 *
 * It was `_Symbat_Nullable` while the display rewrote it away: a type showed as `T?` and the name
 * was machinery kept out of the reader's way. That sugar is gone. `?` is Numbat's own typed-hole
 * syntax, so `T?` could never have been accepted back on input — what was shown could not be
 * written, which is worse than a long name is. So the type is shown as it is, under a name short
 * enough to live with and writable in an annotation: `fn spend(b: Opt<Money>) -> Money`.
 *
 * It is not `__Nullable` as the roadmap proposed — Numbat's parser refuses a double-underscore name
 * in *type* position ("Double-underscore type names are reserved for internal use"), so the
 * utilities below could not have been written against one. The cost of a name this friendly is that
 * a reader's own `struct Opt<T> { value: List<T> }` would be read as this one by the display
 * rewrite; a name they would rather have than not is worth that.
 */
export const NULLABLE_STRUCT = "Opt";

/**
 * What {@link NULLABLE_STRUCT} means, for the hover and completion card.
 *
 * It lives here, beside the thing it describes, but it is *shown* by the completer's type table
 * (completion/expressions.ts) — because a `struct` takes no decorators, so unlike every name in
 * {@link NULLABLE_PRELUDE} this one cannot be handed to the interpreter to read back.
 */
export const NULLABLE_STRUCT_DOC =
  "A value that may be absent, as an empty frontmatter property is. Write one with `some` or `nil`,"
  + " and read one with `get_or`.";

/**
 * The absent value: an empty list, which is what makes the whole encoding work.
 *
 * The roadmap asked for `struct __Nullable<T> { present: bool, value: T }`, and that cannot be
 * built. Numbat evaluates eagerly and has no polymorphic bottom, so there is simply no value to put
 * in `value` when the property is absent — `{ value: error("undefined") }` raises where it is
 * *constructed*, not where it is read. A `List<T>` has one: `[]` unifies with any element type, so
 * an absence sits beside its siblings (`[N { value: [1] }, N { value: [] }]` types as
 * `List<N<Scalar>>`) and a lone one types as `forall A. N<A>`. It also hands
 * {@link NULLABLE_PRELUDE} the runtime error `get` is specified to raise, for free: `head([])` is
 * one already.
 *
 * The `present: Bool` the roadmap paired with it is left out because the list's own state is that
 * bit, and two ways to say the same thing is one way to disagree with yourself.
 *
 * Written as a struct literal rather than as the `nil` {@link NULLABLE_PRELUDE} now declares, and
 * {@link definedValue} as one rather than as `some(…)`, for the same reason: the vocabulary is
 * applied *before* the user prelude so that a reader may shadow any of it, and what a frontmatter
 * property binds must not depend on whether they have. The literal is the encoding itself, which
 * only redefining the struct could change.
 */
export const NULLABLE_ABSENT = `${NULLABLE_STRUCT} { value: [] }`;

/** The nullable value holding `expr` — parenthesized, as every emitted value is, so that an
 *  expression like `5 km + 3 mi` stays one element. */
export function definedValue(expr: string): string {
  return `${NULLABLE_STRUCT} { value: [(${expr})] }`;
}

/**
 * Every name {@link NULLABLE_PRELUDE} binds — `undefined` among them, which is an *alias* of `nil`
 * rather than a declaration of its own but costs a reader exactly as much as one. Written out so a
 * test can hold the prelude and the documentation to each other: that every name promised here is
 * really bound, and that each really lands in the reserved set.
 *
 * Nothing in `src/` reads it. The reserved set is derived from the live interpreter's own
 * vocabulary (properties/note.ts), so these names are claimed there for free — at the cost of a
 * frontmatter property called `get` now being skipped as reserved, exactly like one called `pi`.
 * That cost is what makes the list worth stating somewhere a test can reach.
 *
 * {@link NULLABLE_STRUCT} is not in it: the reserved set is built from the interpreter's functions,
 * units, variables and dimensions, and a struct *type* name is none of those — so `Opt` costs a
 * reader nothing, where `nil` and `some` cost what `get` does.
 */
export const NULLABLE_NAMES: readonly string[] = [
  "nil",
  "undefined",
  "some",
  "get",
  "get_or",
  "get_or_else",
  "is_defined",
  "is_undefined",
];

/**
 * One `@description` line, as Numbat's grammar takes it.
 *
 * Every declaration below carries one, because a decorator is the only way the plugin can put words
 * into a card the *interpreter* answers for: `print_info` reads them back, and the hover popup and
 * both completers show whatever it returns. The struct gets none — Numbat refuses a decorator on a
 * `struct` ("Decorators can only be used on unit, let or function definitions") — so `Opt`'s own
 * card is written on the plugin's side instead (completion/expressions.ts's type table).
 *
 * Quotes are the one thing a description cannot contain, being a plain string literal; backticks
 * stand in where a name wants marking off.
 */
function described(description: string, declaration: string): string {
  return `@description("${description}")\n${declaration}`;
}

/**
 * The prelude as separate declarations, each with its decorators attached. Joined into {@link
 * NULLABLE_PRELUDE}; kept apart so a test can walk them one at a time, which a line-per-statement
 * split stopped being able to do once decorators gave a declaration more than one line.
 */
export const NULLABLE_DECLARATIONS: readonly string[] = [
  `struct ${NULLABLE_STRUCT}<T> { value: List<T> }`,
  described(
    "The absent value — what a property with nothing after it binds. Fits any type, and is also"
      + " written `undefined`.",
    `@aliases(undefined)\nlet nil = ${NULLABLE_ABSENT}`,
  ),
  described(
    "The value `x`, present. The counterpart to `nil`.",
    `fn some<T>(x: T) -> ${NULLABLE_STRUCT}<T> = ${NULLABLE_STRUCT} { value: [x] }`,
  ),
  described(
    "The value held, or a runtime error when there is none. Prefer `get_or`.",
    `fn get<T>(n: ${NULLABLE_STRUCT}<T>) -> T = head(n.value)`,
  ),
  described(
    "The value held, or `fallback` when there is none.",
    `fn get_or<T>(n: ${NULLABLE_STRUCT}<T>, fallback: T) -> T`
      + " = if is_empty(n.value) then fallback else head(n.value)",
  ),
  described(
    "The value held, or the result of calling `fallback` when there is none — called only if it is"
      + " needed, so an expensive or failing fallback is safe.",
    `fn get_or_else<T>(n: ${NULLABLE_STRUCT}<T>, fallback: Fn[() -> T]) -> T`
      + " = if is_empty(n.value) then fallback() else head(n.value)",
  ),
  described(
    "Whether a value is held.",
    `fn is_defined<T>(n: ${NULLABLE_STRUCT}<T>) -> Bool = !is_empty(n.value)`,
  ),
  described(
    "Whether no value is held.",
    `fn is_undefined<T>(n: ${NULLABLE_STRUCT}<T>) -> Bool = is_empty(n.value)`,
  ),
];

/**
 * The source applied to every context by `createContext`.
 *
 * `nil` and `some` write a value. `nil` is a plain `let` rather than a `fn` because a `let` fully
 * generalizes — it types as `forall A. Opt<A>` and so serves at every element type in one session,
 * with no parentheses and no type argument to write. That is also why it is not `none`, which is a
 * Numbat *keyword* and cannot be bound at all. `undefined` is an alias of it, for readers who would
 * rather say the long word; the display rewrite still shows `nil`, since one of the two has to be
 * the one shown and the shorter reads better inside a list.
 *
 * `get` is the unguarded read, and errors on an absent value — `head`'s own "Empty list", which
 * names the problem better than anything written here could. `get_or` takes the fallback as a
 * value; `get_or_else` takes it as a function and calls it only when there is nothing to return,
 * which is what makes an expensive or failing fallback safe to write. Numbat's `if` is lazy in its
 * branches, so neither form evaluates the side it does not return.
 *
 * Numbat has no anonymous functions, so `get_or_else`'s argument is a *named* zero-argument `fn`.
 */
export const NULLABLE_PRELUDE = NULLABLE_DECLARATIONS.join("\n");
