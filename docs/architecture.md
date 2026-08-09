# Architecture

This document is the map that describes the various typescript modules that make up the plugin. It
describes what each folder holds, how the modules are layered, why the layering takes this shape,
and the two things that are hard to learn from the source alone: the interpreter's cached state, and
agreement between Obsidian's surfaces.

Every module carries a header comment saying what it is and, usually, why it is separate from its
neighbors. Those headers are the primary navigation aid; this document explains the system they sit
in.

## A Précis

Numbat provides a string-y interface at its WebAssembly boundary. Almost everything in this codebase
is thus either **deciding what to send in** or **turning the HTML output into the right UI**. This
is why the parsing modules are pure and the rendering modules aren't, and why so much of the design
is about _scope replay_ (the art of reconstructing, for a given cursor position, the exact program
that has to run before the expression under the cursor means anything).

## The Shape of `src/`

The `src/` directory is separated by concern into folders. Each holds _every_ layer of its concern,
from the pure parser, to the CodeMirror extension, to the Obsidian bridge. We do it this way because
these are the files that change together.

| Folder         | What lives there                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| `interpreter/` | the wasm façade, and the two modules that read its formatter output back                                   |
| `syntax/`      | Numbat as a language: tokenizer, CM6 language mode, identifiers, semantic name classes, fence highlighting |
| `document/`    | finding Numbat inside a Markdown note: fenced blocks, frontmatter fences, where the caret counts as code   |
| `completion/`  | what to offer and when, the documentation behind each row, and the editor's completer                      |
| `unicode/`     | LaTeX-style `\code` → glyph expansion, both eager and popover                                              |
| `hover/`       | what the symbol under the pointer or caret is, and the card that answers                                   |
| `scope/`       | what a position can see: the tree, the replay, value probing, search, go-to-definition                     |
| `properties/`  | frontmatter → Numbat bindings, and the `Numbat` property type                                              |
| `imports/`     | `numbat-use`: the graph walk, and the note cache behind it                                                 |
| `evaluation/`  | running Numbat and showing the answer: code blocks, inlay hints, inline `` n`…` `` spans                   |
| `views/`       | the REPL, the scope inspector, the `.nbt` editor, and the CodeMirror host all three share                  |
| `settings/`    | the descriptor table, the single renderer that consumes it, and pure helpers                               |

`main.ts` and `tuning.ts` stay at the root, along with the generated `wasm/` bindings.

## Layers

```
                            ┌──────────────────────────────┐
main.ts                     │  plugin lifecycle, commands, │
                            │  events, invalidation fan-out│
                            └──────────────┬───────────────┘
                                           │
      ┌─────────────────┬──────────────────┼──────────────────┬─────────────────┐
      │                 │                  │                  │                 │
 ┌────┴─────┐    ┌──────┴──────┐   ┌───────┴──────┐   ┌───────┴──────┐  ┌───────┴──────┐
 │  views/  │    │ CM6 editor  │   │   reading    │   │ properties/  │  │  settings/   │
 │          │    │ extensions  │   │     view     │   │              │  │              │
 │ repl,    │    │ syntax/,    │   │ evaluation/  │   │ parse,       │  │ tab.ts       │
 │ scope,   │    │ evaluation/,│   │  codeblock,  │   │ note,        │  │ (renderer)   │
 │ nbt,     │    │ hover/,     │   │  inline-     │   │ type,        │  │ defs.ts      │
 │ input    │    │ unicode/,   │   │  reading     │   │ frontmatter- │  │ (pure table) │
 │          │    │ completion/,│   │ interpreter/ │   │ inlay        │  │              │
 │          │    │ document/   │   │  render      │   │              │  │              │
 └────┬─────┘    └──────┬──────┘   └───────┬──────┘   └───────┬──────┘  └──────────────┘
      │                 │                  │                  │
      └─────────────────┴─────────┬────────┴──────────────────┘
                                  │
                      ┌───────────┴────────────┐
                      │  Obsidian bridges      │   scope/source, scope/replay,
                      │  (vault + app APIs)    │   imports/graph, properties/note,
                      └───────────┬────────────┘   document/editor-file, hover/note
                                  │
                      ┌───────────┴────────────┐
                      │  interpreter/numbat.ts │   the only module that touches
                      │  the wasm façade       │   src/wasm/pkg
                      └───────────┬────────────┘
                                  │
                      ┌───────────┴────────────┐
                      │  pure modules          │   each folder's parse/model half:
                      │  (no imports at all,   │   scope/model, properties/parse,
                      │   or only pure ones)   │   completion/expressions, tuning …
                      └────────────────────────┘
```

Dependencies point downward. The one systematic exception is `import type … from "./main"`: many
lower modules take the plugin object as a parameter and import its _type_ only. TypeScript erases
type-only imports entirely, so these create no runtime module edge and no cycle.

### A Pure Bottom Layer

Roughly half the modules import nothing at all, or import only other modules that import nothing.

They are the parsers, the models, and the decision procedures: `completion/expressions.ts` (what to
offer and when), `evaluation/inlay-parse.ts` (what a line of interpreter output means),
`evaluation/inline-parse.ts` (finding and reading `` n`…` `` spans), `properties/parse.ts`
(frontmatter → Numbat bindings), `scope/model.ts` (every source a note's scope draws on),
`hover/parse.ts`, `imports/parse.ts`, `scope/search.ts`, `syntax/identifier.ts`,
`interpreter/markup.ts`, `interpreter/nullable.ts` (the injected nullable vocabulary and the two
literals written with it), `interpreter/nullable-display.ts` (reading one back out of formatter
output), `document/frontmatter.ts`, `views/fuzzy.ts`, `settings/defs.ts`.

The rule is not a convention that could quietly rot, but instead is **self-enforcing**. `test/unit/`
runs under **plain Node** with no access to Obsidian, so a unit test can only load its module if
that module's entire transitive import graph is Obsidian-free. Add an
`import { Notice } from "obsidian"` to a pure module and its test stops loading.

That is why the four helper extractions in `syntax/identifier.ts`, `document/frontmatter.ts`,
`document/editor-file.ts`, and `views/mobile-keyboard.ts` are split the way they are:
`document/editor-file.ts` needs Obsidian and `document/editor-scope.ts` must not, so they are two
files rather than one, and each header says so.

`test/integration/` is the other half: it loads the real wasm and asserts against actual Numbat
behavior. Modules that need an interpreter but not Obsidian, such as `scope/eval.ts` and
`properties/frontmatter-inlay.ts`, take the interpreter as an _injected factory_ rather than
importing `interpreter/numbat.ts`, so they are testable there.

`scope/search.ts` does the same trick with ranking: it takes a `FuzzyScorer` that Obsidian's
`prepareFuzzySearch` satisfies structurally.

### `interpreter/numbat.ts` is the Only Door to the WASM

`interpreter/numbat.ts` is the **single module** that can import `src/wasm/pkg`. Everything else has
to ask this module for a context and hands it strings.

This is important for more than the usual encapsulation argument, because the WASM has
process-global state which panics on misuse. Because a Rust panic poisons the whole module until it
is re-initialized, centralizing it like this is necessary to make the failure recoverable.

The build produces those bindings from pinned upstream source; see
[CONTRIBUTING](CONTRIBUTING.md#the-wasm-build).

## Interpreter State and its Invalidation

This is the hardest part of the codebase to hold in your head, so it gets its own section.

`interpreter/numbat.ts` keeps module-level caches because building a Numbat context is expensive
(measured at **163 ms** with the full prelude) and the editor surfaces would otherwise build one per
keystroke. The caches differ in what they bake in, which is exactly what decides when each has to be
thrown away.

| Cache                                        | What it bakes in                                         | Discarded when                                                                 |
| -------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `readyPromise` / `wasmReady`                 | the wasm instance itself                                 | a Rust panic sets `needsRestart`; the next `ensureNumbatReady()` reinitializes |
| `completionContext`, `unicodeCodeList`       | nothing but the instance                                 | wasm restart                                                                   |
| `expressionContext`, `expressionVocab`       | the **prelude**                                          | wasm restart, or `invalidateExpressionCompletion()`                            |
| `blockContext`, `blockVocab`, `blockKey`     | the prelude **plus the code replayed above the cursor**  | its key (rates + replayed chunks) changes, or the above                        |
| `exchangeRatesXml`, `exchangeRatesFetchedAt` | a fetched ECB document                                   | age exceeds the configured max, or the setting is turned off                   |
| `exchangeRatesApplied`                       | that the `OnceLock` has been written                     | wasm restart, and only then                                                    |
| `userPreludeParts`, `lastPreludeError`       | the user's `.nbt` files, **kept per file in load order** | `setUserPrelude()`                                                             |
| `signatureCaches`                            | per-context `type()` results                             | with the context (a `WeakMap`)                                                 |

Two of these have non-obvious reasons for their shape, both crucial to understand:

- **`needsRestart` Defers the Restart:** A wasm call that throws sets the flag but does not
  reinitialize immediately, so the render that crashed can still free its contexts on the surviving
  instance before it is swapped out.
- **The prelude is Stored Per File:** A `.nbt` file that is _itself_ part of your prelude must be
  evaluated against only the files loaded _before_ it — every context already loads the whole
  prelude, so evaluating a prelude file naively would define everything in it twice, and a repeated
  `unit` or `dimension` is an error. That is what `createContext`'s `preludeBefore` is for.

### The Invalidation Cascade

Settings changes and vault events do not touch these caches directly. They call one of the plugin's
named invalidators, which fan out:

```
prelude settings change
  └─ plugin.markPreludeDirty()
       ├─ invalidateExpressionCompletion()   → drops expression + block contexts
       ├─ invalidateReservedNames()          → drops the property name-collision set
       ├─ refreshScopeViews()
       └─ each .nbt view's refreshBanner()   → "is this file still a prelude file?"

property type (re)assigned, or a Note properties setting changes
  └─ plugin.refreshNoteScope()
       ├─ refreshInlayHints()      ┐ rebuild the CM6 extensions, so their
       ├─ refreshInlineEval()      ┘ fresh caches key off the new preamble
       ├─ refreshScopeViews()
       └─ invalidateDefinitions()  → the note's text is unchanged, its scope is not

an imported note's content changes
  └─ plugin.refreshImportDependents()
       └─ refreshNumbatInlays(view) + refreshNumbatInline(view), per open editor
```

The last one is _deliberately_ weaker than the others. It dispatches a CodeMirror effect rather than
calling `updateOptions()`, so the extensions are _not_ rebuilt: caches survive, only the notes whose
imports actually moved re-evaluate, and unaffected panes do not flicker. A plain effect dispatch
also repaints an inactive split, which `updateOptions()` does not.

Every settings control declares its effects by **name** in `settings/defs.ts`, and one switch in
`settings/tab.ts` dispatches them. That is what keeps the descriptor table free of Obsidian imports,
and therefore unit-testable. `test/unit/settings/defs.test.ts` pins the whole effect table as a
golden value, which is precisely the test that can catch subtle drift bugs.

## Scope Replay

Numbat has no notion of a "note", it being a purely Obsidian concept. A name means something _only_
because the code that defines it has run in the same context. So every surface that has to answer a
question about a name — what does it complete to, what is its type, what is its value, where is it
defined — first has to reconstruct the program that precedes it.

`scope/replay.ts` implements that reconstruction, and it exists in only one copy on purpose: the
expression completer asks "what is in scope here" and the hover asks "what is this name", and if
those two ever disagreed, a name would mean one thing when completed and another when hovered. They
differ in **a single flag**, `includeCurrentLine`, and in **nothing else**.

What gets replayed, in order:

1. The user's prelude `.nbt` files, in configured order;
2. `numbat-use` imports, walked transitively with a cycle guard (`imports/parse.ts`), each
   contributing its `numbat-shared` blocks and Numbat-typed properties;
3. The note's own frontmatter bindings, in frontmatter order, so a later property can use an earlier
   one;
4. The `numbat-shared` blocks above this position, in document order;
5. The inline `` n`…` `` spans above this position, in document order.

`scope/model.ts` builds the same picture as a _tree_ rather than a program and `hover/definition.ts`
reuses that tree to answer "where is this defined", which is why go-to-definition and the inspector
can never disagree about a definition site.

Plain `numbat` blocks are absent from that list by design: each is its **own fresh context** and
**exports nothing**.

## Shared abstractions, and the drift each one prevents

Several modules exist for no reason other than that two surfaces had to agree, and had stopped
agreeing. Each is worth knowing about because it is where a change has to go:

| Module                     | The surfaces it keeps in step                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope/replay.ts`          | the editor completer and the hover                                                                                                                       |
| `completion/render.ts`     | the editor `EditorSuggest`, the REPL completer, and the inspector's search results — three copies of the row renderer existed, and a fourth was imminent |
| `hover/content.ts`         | the editor hover, the REPL, and the property field: one card, three contexts                                                                             |
| `scope/goto-definition.ts` | the inspector's rows and the hover popup's jump link                                                                                                     |
| `views/input.ts`           | the REPL input, the property field, and the whole `.nbt` editor are one CodeMirror host in three configurations                                          |
| `document/frontmatter.ts`  | the five modules that independently scanned for `---` fences; two of them disagreeing means one reads YAML as Numbat                                     |
| `syntax/identifier.ts`     | the tokenizer and the hover, on what a Unicode-aware Numbat word is — a `µm` unit once colored as `m` because they had separate copies                   |
| `tuning.ts`                | four `MAX_CACHE_ENTRIES` under one name holding three different values, and three `EVALUATE_DEBOUNCE_MS` holding two                                     |

`tuning.ts` deliberately does **not** unify the values it collects, only the names. The spread is
intentional as a per-block cache, a per-note cache, and a per-render cache have no reason to be the
same size, and naming each for its consumer is what makes the difference reviewable.

The counterexample is just as instructive: the soft-keyboard tracking in `views/repl.ts` and
`views/scope.ts` is _not_ merged. The two behave genuinely differently (one measures the visual
viewport and dodges the status bar; the other does no measuring at all, because Obsidian's mobile
shell already reflows the drawer). Unifying them would mean picking one behavior on the platform
hardest to test. Only the leaf helpers moved, into `views/mobile-keyboard.ts`.

## Things Obsidian Does not Officially Support

Four features **reach past the public API**. They are defensive where they have to be, and each
carries a comment saying what it depends on:

- **Syntax Highlighting Inside a Fence:** Obsidian exposes no way to bind a CodeMirror 6 language to
  a fence info-string, so `syntax/highlight.ts` detects the fences and tokenizes their contents
  itself, painting `Decoration.mark` ranges.
- **The `Numbat` Property Type:** This is directly registered into
  `metadataTypeManager.registeredTypeWidgets`, the undocumented registry Obsidian's own widgets and
  the Better Properties plugin both use. Better Properties prefixes its ids, so the two coexist. The
  same registry is how a _sub_-property is typed: Better Properties keys an object's fields
  `<parent>.<field>` and an array's items `<parent>.#`, which is the spelling `properties/parse.ts`
  reads the assignment of a nested property or a list item under.
- **Toggle Comment Interception:** It cannot be intercepted by a key handler by default as Obsidian
  handles it before any listener a plugin can register. `syntax/comment.ts` is therefore a
  CodeMirror _transaction filter_: when the built-in command inserts `%%` markers inside a numbat
  block, the filter rewrites that whole transaction into `#` line comments.
- **Vim:** Obsidian runs its own copy of the CodeMirror Vim extension, not the one this plugin
  bundles for the REPL input, so `getCM` cannot see it. `hover/vim.ts` reaches it through the
  CM5-compatibility object and the `CodeMirrorAdapter` global, both undocumented, both guarded.

## The Build

`esbuild` bundles `src/main.ts` to a single CommonJS `main.js`. The `.wasm` binary is inlined by a
custom `binary` loader, so there is no second file to ship and no fetch at runtime. The plugin is
`main.js`, `manifest.json`, and `styles.css`, and nothing else.

Every `@codemirror/*` and `@lezer/*` package is an esbuild **external**: Obsidian supplies one copy
of each at runtime, at the versions it pins as peer dependencies. `package.json` forces those
versions flat with `overrides`, so the plugin type-checks against what will actually be there rather
than against a nested copy that `npm` was free to install.

CSS classes are `numbat-*` prefixed throughout, including the ones the plugin defines itself. That
is **not an oversight*** of the rename: Numbat's HTML formatter emits its own `hl-*` classes and
`interpreter/markup.ts` rewrites them wholesale to `numbat-*`, so the token classes are derived from
what the wasm produces and are not ours to rename. Renaming only the rest would leave most rules
mixing two prefixes for no gain.

Three identifier strings are compatibility contracts rather than names, and are marked as such in
the source: `VIEW_TYPE_NUMBAT_FILE`, `VIEW_TYPE_NUMBAT_REPL`, and `VIEW_TYPE_NUMBAT_SCOPE` are
persisted in the vault's `workspace.json`, so changing one turns every open pane of that type into a
"No view of type…" placeholder.
