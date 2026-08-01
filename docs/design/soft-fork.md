# Design Note: What a Soft Fork Would Buy Today

**Status:** Not Started

That note argues for a close fork of Numbat on the strength of features that already exist. Several
things the plugin already ships are built the way they are because of what the WebAssembly boundary
hands over — not because of anything Numbat cannot do, and not because of anything the plugin got
wrong. They would each be simpler, cheaper, or less fragile behind a handful of **additive
exports**.

Taken one at a time, none of them justifies carrying a fork. The point of collecting them is that
the case is cumulative, and that it is much stronger than "we would like a CAS".

## The Boundary is Narrower than the Interpreter

The reason that most of what follows is small:

`Context::interpret` returns `(Vec<typed_ast::Statement>, InterpreterResult)` — the caller is handed
the **typed AST** and a `Value`. `numbat-wasm`'s `interpret` receives both and renders them, plus
anything the statement printed, into one concatenated HTML string. Everything structural is
discarded at the wrapper, one function call after it was produced.

The same is true of the environment. `numbat/src/lib.rs` publicly exposes `functions()` —
`FunctionInfo { signature_str, description, url, examples, code_source }` — along with
`variable_names()`, `unit_names()`, `dimension_names()`, `list_modules()`, `base_units()`,
`unit_representations()` and `dimension_registry()`. Of that, the wasm exports a flat
`get_completions_for` and an HTML `print_info`.

So the recurring shape below is not "teach Numbat something". It is **stop discarding what Numbat
already computed**, which is what makes these plausible as upstream contributions rather than a
private divergence. Everything here is checkable against the pinned checkout that `make wasm` leaves
in `.build/numbat/`.

## Already Computed, Not Exported

### Vocabulary with Structure and Provenance

**Now:** `interpreter/numbat.ts`'s `buildCompletionVocabulary` runs four REPL commands —
`list functions`, `list units`, `list variables`, `list dimensions` — and parses the names out of
the resulting HTML with regex in `parseListNames`.

This is four commands instead of one because functions and variables come back in the same CSS class
and are otherwise indistinguishable. `properties/note.ts` then unions all four into a reserved-name
set, which is how the plugin knows that `let m = 5` would clash with a unit.

**A fork:** one export returning the structured vocabulary.

This is the cheapest tweak in the document and it removes **three of the roadmap's known limitations
at once**, each of which is a boundary artifact rather than a real constraint:

- _"The bundled prelude has no structure to browse"_ — `list_modules()` exists.
- _"`m`, `meter`, `metre`, `meters`, `metres` are five separate vocabulary entries"_ —
  `unit_names()` returns `&[Vec<CompactString>]`. The aliases are **already grouped per unit**; the
  flat completion list is what loses the grouping.
- _"A user-prelude `@aliases(…)` name is mislabeled as bundled"_ — `FunctionInfo` carries
  `code_source`. The inspector distinguishes user names from the built-ins by set difference only
  because provenance does not _currently_ cross the boundary.

### The Standard Library's Source

**Now:** the plugin can jump to a definition in a vault note or a user-prelude `.nbt` file, and
nowhere else. A built-in like `sqrt` has no definition site it can offer, and the scope inspector
lists the bundled prelude as a flat ranked search rather than a module tree.

**A fork:** `BuiltinModuleImporter` embeds Numbat's `modules/` directory with `rust_embed`, and its
`import()` returns the module **source** as a string. That source is already inside the `.wasm` this
plugin ships — it is what `use prelude` reads at startup. It is simply not reachable from outside.

Exposing it gives the module tree and, with `FunctionInfo`'s `code_source` plus the
`definition_span` on a function's signature, go-to-definition into the standard library itself.

This one _corrects_ a note in the roadmap, which records that a real module tree "would need
Numbat's module sources embedded at build time". They are embedded already, at no additional cost;
the missing piece is an accessor, not an asset.

### Signatures and Documentation without Per-Name Probes

**Now:** `completionSignature` evaluates `type(<name>)` — a full interpreter call — for every name
whose signature is shown, then recovers the type from the HTML. Results are cached in a `WeakMap`
keyed by the context, because the same name legitimately has different types in different contexts.
`completionInfo` calls `print_info` and parses the HTML back into a body and a reference URL.

**A fork:** hand over `FunctionInfo`. The signature, description, URL and examples are all in it
_already_, assembled by the same code that renders them.

### Struct Introspection

**Now:** the plugin evaluates `<expr>._numbat_member_probe` — a member access it knows will fail —
and reads the field list out of the resulting "field does not exist" diagnostic.

This is the plugin's most fragile dependency on upstream, as it depends on **prose**: if upstream
rewords the diagnostic then member completion just stops working. `completion/expressions.ts` says
so where it is implemented, and the unit tests pin the current wording so a Numbat bump fails loudly
rather than quietly. It is not an oversight — that diagnostic really is the only place Numbat spells
a value's fields out, `get_completions_for("costs.")` returns nothing, and `print_info` on a struct
type is `Not found`.

**A fork:** `fields_of(expr)`. The type checker has access to this trivially.

### Cloning a Loaded Context

**Now:** building a context with the prelude costs roughly 70 ms. Nearly all of
`interpreter/numbat.ts`'s caching exists to avoid paying it: a shared `expressionContext`, a
`blockContext` keyed on the exact chunks replayed into it, an idle-release timer, and the
`preludeBefore` machinery that builds a context holding only the prelude files ahead of a given one.

**A fork:** `Context` is `#[derive(Clone)]` at the pinned v1.23.0, but WASM gives us no access to
this.

An export is close to one line of Rust, and turns "fork the prelude context" from re-parsing and
re-type-checking the whole standard library into a memory copy. How much that actually saves should
be **measured** as a deep copy of a loaded environment is not free, but it seems likely to be far
cheaper than our current state of affairs.

## Needs New Code

### Results and Errors as Data

**Now:** every result crosses as HTML and is taken apart again on the plugin's side.

`evaluation/inlay-parse.ts`'s `splitInterpretOutput` re-splits the concatenated output on its blank
line; `declarationTypeHtml` finds a declaration's inferred type by searching for the literal string
`<span class="numbat-operator">:</span>`; and `errorSummary` parses rendered diagnostic art — gutter
bars, caret rows, `= note:` lines — back down to one line of text. `interpreter/markup.ts` then
corrects the formatter's own classes, because a string's quotes arrive as `numbat-operator` and a
dimension as `numbat-type-identifier`.

None of this is unreasonable, and the integration suite exists in large part to pin these shapes so
that a version bump breaks noisily. Fundamentally it is still a formatter's output being read as an
API.

**A fork:** the value, its type, and its spans as data so the plugin can handle formatting. This
also relates to the [CAS design](./cas.md) so bears designing together.

Two things fall out of it directly:

- **Real Error Ranges:** Numbat's errors carry a `Span { start, end, code_source_id }`, and
  `ErrorDiagnostic::diagnostics()` turns them into labeled diagnostics — which is what gets rendered
  into the art the plugin currently parses. Today an error becomes a summary string anchored to
  whichever statement the plugin fed in; with spans it could underline the sub-range that actually
  failed. Those are **byte** indices, so they would need converting for JavaScript's UTF-16
  positions — and this plugin's whole reason for existing includes typing `α` and `m³`, so that
  conversion is not theoretical.
- **One Call Per Block:** `hintsForBlock` currently interprets statement by statement, and
  `groupStatements` re-implements Numbat's own bracket-balance statement splitting to do it, because
  a whole-block call returns a single blob with no way to attribute a result to a line. A structured
  per-statement result removes both the re-implementation and the boundary crossings.

### Note Properties without Generated Struct Names

**Now:** a nested frontmatter property is compiled into generated Numbat **source**: a `struct`
definition named `_Nb_<Label>_<hash>_<generation>_<index>`, plus a `let` that constructs it. The
hash disambiguates two notes that both have a `costs:` object, the generation counter handles
re-evaluation, and `readableStructNames` rewrites the whole thing back out of every user-visible
string so nobody sees it. All of that exists because a repeated `struct` definition is a hard error
and there is no way to put a **value** into a context except by generating source that builds one.

**A fork:** an injection export. The hash, the counter, and the display rewrite all go with it.

### A Vault-Backed Module Importer

**Now:** `numbat-use` is an import system the plugin implements itself. `imports/parse.ts` walks the
graph in dependency order with a cycle guard, `imports/graph.ts` caches each note's shared blocks,
and the result is replayed as concatenated source into a fresh context. Numbat's own `use` cannot
see a vault note, because `numbat-wasm` hardcodes the `BuiltinModuleImporter`.

**A fork:** `ModuleImporter` is a public trait with two methods, `import` and `list_modules`. An
importer delegating to a JavaScript callback would make a note a real module — `use` inside a block,
real module paths, and Numbat's own resolution and cycle handling instead of ours.

**This needs actual design thinking** as `import` is synchronous and reading a note in the vault is
not. The callback would have to be served from the plugin's sync cache, with all of the
eventual-consistency behavior that carries, and a miss would have to mean something sensible.

### Failures that are not Panics

**Now:** `Context::set_exchange_rates` is an associated function over a process-global cache, so a
second call panics; the plugin applies rates once per wasm instance and has later contexts say
`use units::currencies` instead. `Numbat::new` unwraps its `use prelude`. A panic anywhere poisons
the instance, which is why `freeQuietly` exists for objects that can no longer be freed — and why
`scripts/build-wasm.xsh` **patches a `__numbat_reset()` export into the generated glue**.

The build already forks Numbat's output, by two lines, because the boundary offers no way to recover
from a panic. It is the smallest possible enhancement to Numbat that would make Symbat's work
easier.

**A fork:** rates held per context, and `Result` where the wrapper currently unwraps.

## What this Changes about the Fork Decision

Many of the features here could be upstreamed, code-owners willing. This has a major impact, as if
they are open to exposing internals then we potentially could build the CAS **entirely as a crate**
on top of Numbat's API, potentially with its own WASM bindings.

If exactly one thing lands, it should be the **structured result**. Everything else on this page is
a convenience or an improvement, but that one is a wall that the plugin runs into constantly, and
that future CAS work cannot avoid.
