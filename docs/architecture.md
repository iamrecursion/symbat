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
| `interpreter/` | the façade, the seam (`host`, `protocol`, `worker/`), and the modules that read the formatter output back  |
| `syntax/`      | Numbat as a language: tokenizer, CM6 language mode, identifiers, semantic name classes, fence highlighting |
| `document/`    | finding Numbat inside a Markdown note: fenced blocks, frontmatter fences, where the caret counts as code   |
| `completion/`  | what to offer and when, the documentation behind each row, and the editor's completer                      |
| `unicode/`     | LaTeX-style `\code` → glyph expansion, both eager and popover, over a committed code table                 |
| `hover/`       | what the symbol under the pointer or caret is, and the card that answers                                   |
| `scope/`       | what a position can see: the tree, the replay, value probing, search, go-to-definition                     |
| `properties/`  | frontmatter → Numbat bindings, the `Numbat` and `Zoned Date` property types, and time zones                |
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
 │ repl,    │    │ syntax/,    │   │ evaluation/  │   │ parse, zone, │  │ tab.ts       │
 │ scope,   │    │ evaluation/,│   │  codeblock,  │   │ note, type,  │  │ (renderer)   │
 │ nbt,     │    │ hover/,     │   │  inline-     │   │ date-type,   │  │ defs.ts      │
 │ input    │    │ unicode/,   │   │  reading     │   │ zone-editor, │  │ (pure table) │
 │          │    │ completion/,│   │ interpreter/ │   │ frontmatter- │  │              │
 │          │    │ document/   │   │  render      │   │ inlay        │  │              │
 │          │    │             │   │              │   │              │  │              │
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
                      │  interpreter/numbat.ts │   the façade: exchange rates,
                      │  interpreter/host.ts   │   the user prelude, the request
                      └───────────┬────────────┘
                                  │   plain data, one whole job at a time
                      ┌───────────┴────────────┐
                      │  interpreter/transport │   a Worker where one can be built,
                      │  + worker-transport    │   a direct call where one cannot
                      └───────────┬────────────┘
                                  │   …and on the far side of that,
                      ┌───────────┴────────────┐
                      │  interpreter/worker/   │   boot → entry → queue → tasks →
                      │  the answering side    │   engine; only engine sees the wasm
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
(frontmatter → Numbat bindings), `properties/zone.ts` (offsets, and resolving a named zone to the
one it had on a given date — `Intl` is a platform built-in, so this stays pure and testable),
`scope/model.ts` (every source a note's scope draws on), `hover/parse.ts`, `hover/card.ts` (what a
hover card should say, decided without building any of it), `imports/parse.ts`, `scope/search.ts`,
`syntax/identifier.ts`, `interpreter/markup.ts`, `properties/reserved-names.ts` (the stamp on the
persisted prelude vocabulary, and the validation that decides whether a stored one still stands),
`interpreter/facts.ts` (what the interpreter has already said about a name, cached — it takes the
thing that _asks_ as an injected reader, so the cache and the coalescer are testable without a wasm
handle anywhere near them), `interpreter/nullable.ts` (the injected nullable vocabulary and the two
literals written with it), `interpreter/nullable-display.ts` (reading one back out of formatter
output), `properties/type-order.ts` (where this plugin's types sit in the type menu),
`properties/icon-svg.ts` (the markup of its copies of Obsidian's icons), `document/frontmatter.ts`,
`views/fuzzy.ts`, `settings/defs.ts`.

The rule is not a convention that could quietly rot, but instead is **self-enforcing**. `test/unit/`
runs under **plain Node** with no access to Obsidian, so a unit test can only load its module if
that module's entire transitive import graph is Obsidian-free. Add an
`import { Notice } from "obsidian"` to a pure module and its test stops loading.

That is why the helper extractions in `syntax/identifier.ts`, `document/frontmatter.ts`,
`document/editor-file.ts`, `views/mobile-keyboard.ts`, and `views/vim-mode.ts` are split the way
they are: `document/editor-file.ts` needs Obsidian and `document/editor-scope.ts` must not, so they
are two files rather than one, and each header says so. The same line runs between
`views/mobile-keyboard.ts` (the event names and the height reader — no imports at all) and
`views/soft-keyboard.ts` (the tracker built on them, which needs `Platform`), and between
`views/vim-mode.ts` (what mode Vim is in, as a value) and the watcher in `views/input.ts` that
subscribes for it. `hover/card.ts` and `hover/content.ts` are the same split applied to one card:
deciding what it says needs nothing, and building it needs Obsidian's element helpers and MathJax.

`test/integration/` is the other half: it loads the real wasm and asserts against actual Numbat
behavior. Modules that need an interpreter but not Obsidian, such as `scope/eval.ts` and
`properties/frontmatter-inlay.ts`, take the interpreter as an _injected factory_ rather than
importing `interpreter/numbat.ts`, so they are testable there.

`scope/search.ts` does the same trick with ranking: it takes a `FuzzyScorer` that Obsidian's
`prepareFuzzySearch` satisfies structurally.

### Three Import Doors, Not One

Everything that touches the interpreter goes through **one call**, `ask` (`interpreter/host.ts`),
and the module that actually holds a wasm handle is reachable from nowhere else. Three files are
doors, and each is a door for a different reason:

| Module                         | What only it may import         | Why it is on its own                                                                                                                                                                     |
| ------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interpreter/wasm-binary.ts`   | the `.wasm` file                | esbuild inlines it as a 2.5 MB base64 literal. A second importer is a second copy, and nothing in the build says so.                                                                     |
| `interpreter/worker/engine.ts` | `src/wasm/pkg/numbat_wasm.js`   | the bindings carry the module's process-global state. A second importer is a second interpreter — and, once the engine runs off the main thread, one that has been dragged back onto it. |
| `interpreter/host.ts`          | `symbat:worker-source`          | the built worker bundle, injected as a string. A second importer is a second copy in `main.js` and, worse, two places that believe they own the one instance Numbat permits.             |
| `interpreter/numbat.ts`        | `obsidian`, for the rates fetch | `requestUrl` is main-thread-only, so the ECB document is fetched here and _posted_. The interpreter never makes a request.                                                               |

`make doors` asserts the first three by grep, and CI runs it. The rule is "exactly this file", not
"at most one": a door that has moved is as much a problem as one that has been duplicated.

The door has a matching rule pointing the other way. `eslint.config.mjs` forbids
`src/interpreter/worker/**` from importing Obsidian, Electron, CodeMirror, Lezer, Node built-ins or
the plugin object at all. That is what keeps the answering side loadable from `test/integration`,
and it is what keeps the worker bundle buildable at all: a stray `import { Notice } from "obsidian"`
yields a worker that throws on load, which — since the in-process path is opt-in — is a plugin that
evaluates nothing and reports it as the device's fault. The worker build makes the same assertion a
second time as a build error, because ESLint is skippable and the failure is not visible at runtime.

The reason the first two are separate files rather than one is testability. `wasm-binary.ts` can
only be loaded by a bundler; `engine.ts` imports no Obsidian and no DOM, so `test/integration/` can
start it against the real bindings and drive the whole answering side through it. That is what
`test/integration/interpreter/tasks.test.ts` does, and it is the only place a leak between two
notes' contexts can be seen at all.

**Every one of those cases states its answer three times.** Once through the pure evaluation module
the test drives itself, once through the task in this process, and once through the same task in a
real `node:worker_threads` thread running the **built** worker bundle
(`test/integration/interpreter/worker-harness.ts`), reached by a real message. The third is not
ceremony: that answer has been through `structuredClone` in both directions, was produced by a
second wasm instance with its own contexts and its own session table, and was scheduled by a queue
the test cannot see into. A `Map` that does not survive the wire, a reply that carries a handle
rather than data, a session id that means something different over there — each of those is
invisible in process, and each is a note that reads differently for the reader.

What it still cannot test is a **blob** worker, because node has no blob-URL `Worker` and nothing in
this repository executes inside Obsidian. That gap is covered by the spawn ladder, the status line
and a device pass, not by a test.

The WASM's process-global state is also why centralizing it matters more than the usual
encapsulation argument: a Rust panic poisons the whole module until it is re-initialized, and only a
single owner can make that recoverable.

The build produces those bindings from pinned upstream source; see
[CONTRIBUTING](CONTRIBUTING.md#the-wasm-build).

**One thing is deliberately copied out rather than asked.** `unicode/table.ts` holds Numbat's
`\code` table — every `\alpha` → `α` the interpreter knows — transcribed from the pinned source. The
expansion runs inside CodeMirror's `inputHandler`, whose contract is
`(view, from, to, text) => boolean`: there is nowhere in that signature to await anything, so the
answer has to exist on the keystroke itself. Asking the wasm meant an interpreter instance kept
alive on the main thread purely to consult a constant, an expansion that silently did nothing until
that instance had loaded, and a popover list that cost one wasm call per name in Numbat's whole
vocabulary. The table depends on neither the prelude nor the reader's settings, so it does not go
stale within a session — only across a `NUMBAT_TAG` bump, which is what
`test/integration/unicode/table.test.ts` is for: it compares the transcription against the shipped
interpreter in both directions, so drift fails a test rather than quietly dropping a glyph.

### The Seam: One Whole Job at a Time

Every interpreter call in the plugin is now a **request**: plain data out, plain data back, and no
surface holds anything it could call into. Five modules make that up, and the split between them is
the whole design:

| Module                            | Role                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `interpreter/numbat.ts`           | the façade: the exchange rates and the user prelude, which are the only two things that cannot move, plus the names the rest of the plugin knows it by |
| `interpreter/host.ts`             | `ask` — the one call. Owns the instance, the generation, and the idle policy; acts on everything a reply carries                                       |
| `interpreter/protocol.ts`         | the vocabulary that crosses: request and response types, the purpose mask, the scope key. Pure, and `import type` only                                 |
| `interpreter/worker/entry.ts`     | the answering side's front door: control messages, and the queue in front of the tasks                                                                 |
| `interpreter/worker/tasks.ts`     | one function per whole job — a note's blocks, a note's inline spans, a property batch, a scope tree, a point query about a name                        |
| `interpreter/worker/engine.ts`    | the interpreter itself; the only place a context exists                                                                                                |
| `interpreter/transport.ts`        | the two ways a request reaches it, behind one interface — and the in-process one, which is a call                                                      |
| `interpreter/worker-transport.ts` | the other one: a `Worker`, its correlation table, and the two URL rungs it can be built from                                                           |
| `interpreter/wire.ts`             | the envelope those requests travel in: correlation ids, the lifecycle messages, the two things the answering side says unasked                         |
| `interpreter/ladder.ts`           | trying several ways of starting in order, and remembering why each failed. Pure, and the only part of the spawn policy a test can drive                |

**The seam is coarse on purpose.** A note's inlay pass is around a hundred `interpret` calls. A
per-call proxy would be a hundred round trips per debounce tick per open editor, and "this note's
pass has been superseded" has no representation in a stream of calls but is trivial as a task id.

Three things a reply carries that no caller should have to remember, and that `ask` therefore acts
on for all of them:

- **the dimension and unit names a context build enumerated.** Nothing else announces them, and
  without them every unit silently stops being syntax-highlighted — no error, no missing feature to
  report, just prose-colored code.
- **a panic.** The answering side records one and carries on; it cannot restart itself. `ask`
  schedules the restart.
- **the prelude error.** It used to be read out of module state immediately after `createContext`.
  The tasks that need it carry it in their own answers instead (`ScopeSnapshot`, `ReplSession`,
  `preludeCheck`), because that ordering is exactly what a message does not preserve.

`ask` answers `null` for every way a request can come to nothing — the interpreter is down, the
request was superseded, the world moved on. All three mean the same thing to a surface: keep
painting what you have, and ask again if you still care.

`interpreter/worker/queue.ts` is what makes supersession possible. A job names a **group** (a
surface and a document) and a newer job in the same group cancels the queued older one outright, so
a reader typing costs one pass rather than one per keystroke. It runs the newest job of the highest
class first; that LIFO starves under sustained load and is only safe _because_ supersession keeps at
most one live request per surface, which is the kind of invariant that rots quietly and is therefore
written down in the module.

**No handle appears in any request or response, and the REPL is the proof.** A REPL session is the
one context that outlives the call that built it, and the protocol names it by an **integer** the
interpreter validates against its own table. An id that outlived a restart is a miss the view
recovers from; a pointer into a replaced heap is a "null pointer passed to Rust" that the layer
above cannot tell from a crash.

### Where the Interpreter Runs

The interpreter runs in a Web Worker where one can be constructed, and on the main thread where one
cannot. **The former is strictly stornger than the latter.** Numbat's VM has no fuel, no interrupt
hook and no depth cap, and its call stack is a heap `Vec` rather than the wasm stack, so an
expression that will never finish cannot be stopped from inside as no `try` rescues it and no
deadline reaches it once it has started. `worker.terminate()` is the only mechanism the platform
offers that does, and it exists on exactly one of the two paths.

So the main-thread path is not merely slower; it is a **weaker guarantee**, and every part of the
design that touches it says so out loud rather than papering over it:

- the `interpreterThread` setting's own copy names the trade;
- the version card and **Copy debug info** both report the path actually in force, which on a phone
  is the only diagnostic anybody can hand you;
- off the worker path neither stop affordance can do anything, since while a main-thread evaluation
  runs the main thread _is_ the evaluation and no click is ever dispatched — so the **Stop all
  running evaluations** command is hidden outright, and the REPL's ■ button grays out with a label
  saying why.

The two surfaces are treated differently on purpose. An inert entry in the command palette is a
support ticket: it is found by searching for it, so its presence is a promise. A button in a fixed
row is read by position, so removing it reflows the row around the reader at the two moments they
can least absorb it — as an evaluation starts, and as one ends — and leaves nowhere to look for the
control _before_ it is wanted, which on a fast machine is the only time it would ever be seen.

That button lives in the REPL's input row, beside the Esc and evaluate buttons, and **not** in the
view header. It was a header action added with `addAction`, and on desktop it never rendered; the
icon id, the show/hide timing and the signal driving it were each ruled out in turn, and no
explanation was established. `views/scope.ts` had already reached the same arrangement from the
other direction, building its expand/collapse controls into the panel. The rule the two share: a
load-bearing affordance does not depend on a surface whose behavior nobody can account for.

**Starting is a ladder, not a try/catch.** `interpreter/ladder.ts` takes the first rung that
_answers_ — a blob URL, then a `data:` URL for a policy that refuses `blob:` — and abandons any that
does not answer within `WORKER_READY_TIMEOUT_MS`. Waiting for the answer rather than for the
constructor is the whole point: a content-security policy that refuses a worker frequently manifests
as a construction that succeeds and a worker that then says nothing, and a hang there is
indistinguishable from a broken plugin. Every rung that fails is recorded with its reason, and those
reasons are what the status line shows.

**The in-process path is not the bottom of that ladder.** It was, and the effect was that "Worker
thread" quietly meant "worker thread if it happens to work" — a different setting, with a different
guarantee, and no way for a reader to tell which one they had. So a ladder that runs out ends in a
sticky, reported state: a `Notice` that does not expire, a status line, and `interpreterProblem()`
for the REPL, all of them naming the setting that moves. The in-process transport is still built,
still what the whole test suite drives, and still what serves a request that arrives before
`onLayoutReady` — it is simply never _entered_ without the reader deciding it should be.

**A respawn does not move `interpreterGeneration()`.** A crash does not change what a note _means_,
and that number is folded into every evaluation cache key in the vault; bumping it would turn a
crash storm into a vault-wide re-evaluation storm.

**Restarting has a limit, and two quite different answers past it.** More than `RESPAWN_STORM_LIMIT`
restarts inside `RESPAWN_STORM_WINDOW_MS` means something is wrong with the setup rather than with
one note. If a personal prelude is configured it is suspended and the reader is told — a prelude is
replayed into _every_ context, so it is the only thing that can make every task fail, and moving a
bomb onto the thread with no way to survive it is not a fix. Otherwise the worker path is latched
off for the session, with a `console.warn` and a line in the status and deliberately no `Notice`: a
toast storm on top of a crash storm is a second failure, not a diagnosis.

**Stopping escalates.** Canceling the queue reaches every request that has not started, which for
the shapes the plugin actually produces is nearly all of it (a reading-view render is one task per
code block, not one long one) and it keeps the wasm instance, the context pool, the applied rates
and any REPL session. Terminating loses all four and is the only thing that stops a call already
inside Numbat, so it is the second rung and never the first.

The REPL button is the exception and goes straight there: a REPL submission is a _single_
`interpret`, with no boundary inside it for a cancellation to land on. Whatever was still running
when the terminate happened has a refusal filed against its note, or the render that was hanging
re-fires the moment the interpreter is back and the reader stops the same note over and over.

## Interpreter State and its Invalidation

This is the hardest part of the codebase to hold in your head, so it gets its own section.

`interpreter/worker/engine.ts` keeps module-level caches because building a Numbat context is
expensive (measured at **163 ms** with the full prelude) and the editor surfaces would otherwise
build one per keystroke. The caches differ in what they bake in, which is exactly what decides when
each has to be thrown away.

| Cache                                         | Where              | What it bakes in                                         | Discarded when                                                        |
| --------------------------------------------- | ------------------ | -------------------------------------------------------- | --------------------------------------------------------------------- |
| `starting` / `up`                             | `host.ts`          | the wasm instance itself                                 | a reply reports a panic; the next `ensureInterpreter()` reinitializes |
| `expressionContext`, `expressionVocab`        | `worker/engine.ts` | the **prelude**                                          | a reset, an environment change, or the idle policy                    |
| `blockContext`, `blockVocab`, `blockCacheKey` | `worker/engine.ts` | the prelude **plus the code replayed above the cursor**  | its key (rates + replayed chunks) changes, or the above               |
| `pool`                                        | `worker/engine.ts` | the prelude **plus a prefix already replayed into it**   | a definition ran in it, an eviction, a reset, or the idle policy      |
| `sessions`                                    | `worker/tasks.ts`  | a REPL's accumulated definitions, per integer id         | the view closes it, or the instance is replaced                       |
| `exchangeRatesXml`, `exchangeRatesFetchedAt`  | `numbat.ts`        | a fetched ECB document                                   | age exceeds the configured max, or the setting is turned off          |
| `ratesApplied`                                | `worker/engine.ts` | that the `OnceLock` has been written                     | a reset, and only then                                                |
| `preludeParts`, `preludeError`                | `worker/engine.ts` | the user's `.nbt` files, **kept per file in load order** | the environment is posted again                                       |
| `signatureCaches`                             | `worker/engine.ts` | per-context `type()` results                             | with the context (a `WeakMap`)                                        |

Three of these have non-obvious reasons for their shape, all crucial to understand:

- **The Restart is Deferred:** a reply that reports a panic sets a flag rather than reinitializing
  at once, so the render already in flight finishes against the instance it started on rather than
  having it swapped out underneath.
- **The prelude is Stored Per File:** A `.nbt` file that is _itself_ part of your prelude must be
  evaluated against only the files loaded _before_ it — every context already loads the whole
  prelude, so evaluating a prelude file naively would define everything in it twice, and a repeated
  `unit` or `dimension` is an error. That is what `createContext`'s `preludeBefore` is for.
- **The idle release is a policy, not a cache rule.** The engine owns the contexts and has no clock
  worth reading; `host.ts` owns the timer, because the clock that matters is the one the reader is
  looking at. `touchInterpreterIdle` re-arms it and the engine is simply told to let go.

### The Context Pool: Reuse Without a Clone

A Numbat context is **consumed by use**. The wasm surface is `new`/`interpret`/`free` (no clone, no
snapshot, no scope-pop) so a context accumulates whatever runs in it, and the only way back to a
known state is to build another. That build is the single largest cost in the plugin: measured here,
`Numbat.new(true, …)` is 55 ms against 2.6 ms for a replay and 0.0 ms for a context with no standard
library, so the standard-library load is the main cost and there is nothing to shave off it.

This matters because the evaluating tasks fan out. `evalBlocks` builds one context per block,
because blocks must not see each other's definitions; the reading view renders one _task_ per block
on top of that. Twenty blocks was twenty standard-library loads.

The pool avoids builds rather than moving them. Nothing is built ahead of a request (a context
nobody claims would be pure waste, which on a phone is battery is even worse) so what it does is
take contexts back after use, when it can prove they came back unchanged. Two lexical predicates in
`interpreter/reuse.ts` decide, one at each end:

- **`definesNames`** gates the return. A context that gained a name would hand that name to an
  unrelated block, which is a wrong answer with nothing wrong on its face. It was already in the
  codebase, written for the property field's reused context, and its own doc already called itself
  "the question a reused context has to ask".
- **`readsLastAnswer`** gates the take, and is the residue the pool introduces. Numbat's
  `LAST_RESULT_IDENTIFIERS` is `["ans", "_"]`, and the type checker binds them from
  `Statement::Expression` and from no other statement kind — so a context that ran only expressions
  differs from a fresh one in exactly those two names. `ans` at the top of a block is an error today
  and must not quietly become the block before it.

Both err towards refusing, which is what makes them safe to write lexically: a wrong `true` costs
one standard-library load, which is what every caller paid before the pool existed.

Two structural decisions are worth knowing before changing it. **The prefix replay lives with the
pool**, in `positionedContext`, not with the caller. A hit that re-ran its prefix is invisible from
outside, since a doubled `unit` or `struct` errors on the redundant chunk and leaves the answer
intact, so owning both halves is what makes the mistake unrepresentable rather than merely unlikely.
And **a pooled context is handed over, not lent**: the pool forgets it entirely, so a task that dies
still holds the only reference and frees it in its own `finally`. Its sibling `scopeContext` does
the opposite, caching and lending a context its callers may only read.

The key is `(applyRates, preludeBefore, prefix)`, which is why a note with no shared blocks shares
one entry between its inline spans and its code blocks: in live preview both passes run over one
note, and the second of them costs nothing.

### Caching Results, and What Can Change Underneath One

The table above is about interpreter **contexts**. Separately, every surface that shows a value
caches the **result**, keyed by a signature of the text it evaluated plus `interpreterGeneration()`
— so an edit, a prelude change or a rate refetch moves the key and the answer is worked out again.

That key cannot see the one input that is not in it: the clock. Numbat has exactly two impure
builtins, `now()` and `random()` (`interpreter/purity.ts` pins the closure of the sixteen prelude
names that reach them, and `test/integration/interpreter/purity.test.ts` re-checks it against the
real wasm on a `NUMBAT_TAG` bump). So each entry records whether its **scope** can produce a
different answer next time, and only those entries expire — after `IMPURE_FRESH_MS`. Everything else
is cached until its key moves.

Both directions of that were wrong before, in opposite places: the property outcomes aged _every_
note every ten seconds, so a Bases table paid a standard-library load per note per window forever;
every other cache aged _nothing_, so `` n`now()` `` was frozen until the note was edited.

Three shapes are worth knowing, because each is a bug if it is got wrong:

- **Stale is not absent.** `EvaluationCache.get` returns the value _and_ whether it is fresh. The
  two editor extensions paint the stale value and schedule a fresh evaluation; treating it as a miss
  would blank every hint in a note containing `now()` for the length of a context build, once per
  window. The reading view and the inspector re-evaluate in place, so for them stale is a miss.
- **`hasFresh`, not `has`.** An evaluation pass tests the cache before doing the work, to dedupe
  within a pass. As a presence test it would find the stale entry and skip the work it was scheduled
  for.
- **A refused answer never ages** when [cut](./features.md#evaluation-time-limit) short by the
  evaluation limit. Re-asking would spend the note's whole allowance again for the same refusal and
  create a freeze once per window, forever, which is the failure the limit exists to prevent. Where
  the pass knows it exceeded before it writes, that is one `&&`; where it does not (the inlay block
  loop and the reading view write from _inside_ the budget) the cache has `freeze(keys)` to say so
  afterwards.

The purity predicates live with the shapes they read rather than in one place: `impureBindings`
(`interpreter/purity.ts`) for a note preamble, `noteReadsClockOrRandom`
(`evaluation/inline-parse.ts`) for scanned note units, `treeReadsClockOrRandom` (`scope/model.ts`)
for a scope tree. All three are pure and unit-tested.

### Asking What a Name Is, Without Holding a Handle

A card saying what `sin` or `costs.total` is used to be built by handing `symbolCard` the wasm
handle and calling into it while the reader waited. That works only while the interpreter is on this
thread: **an answer can cross a message boundary, a handle cannot.** So the hover asks a cache
instead, and the shape it now has is the shape every synchronous interpreter call has to end up in.

`interpreter/facts.ts` holds one `SymbolFacts` record per (scope, name) — the signature, the
documentation, the value — under a `scopeKey` that folds in the replayed chunks, the exchange-rate
flag and `interpreterGeneration()`. Two entry points, and the split between them is the whole
design:

- `knownFacts(key, probe, want)` is **synchronous** and is the only thing on a resolve or a render
  path: a map lookup, no interpreter, no clock.
- `ensureFacts(key, probes, want, read)` is **asynchronous**, coalesces concurrent asks for the same
  batch, and fills what is missing. It waits a turn before calling the reader even when the reader
  answers instantly, so a surface can never be handed an answer inline and come to depend on it.

`want` is a bitmask saying what the lookup is _for_, and an entry filled for a narrow purpose is a
miss for a wider one. It exists because the facts cost different amounts. A card wants the
signature, the documentation and the value; a completion row wants the signature and nothing else.
Filling a card's worth for every visible row would run an _evaluation_ per row on every keystroke,
which is the cost this layer exists to remove rather than to relocate.

The reader is injected rather than imported, which is what keeps the cache loadable under plain
Node. `interpreter/live-facts.ts` is the implementation, and it is now exactly one thing: the
mapping from "which scope is this surface's cursor in _now_" to a request. It comes in two shapes,
because two kinds of scope do: a **scope spec**, which the interpreter can rebuild from text
whenever it likes, and a **session**, which accumulates definitions and therefore cannot be rebuilt
from anything. Only the REPL has one. Within one mask the fill is eager, where a card asks for one
fact or two depending on what the first answer says; that over-fetching is deliberate, because once
asking costs a round trip one over-full answer beats two exchanges.

A miss is not a dead end. `HoverSource.resolve` may return a `HoverPending` (the lookup it started,
plus what to say if it comes to nothing) and `hover/hover.ts` waits on it and asks again, provided
the caret has not moved or the pointer left. Keeping that policy in the driver rather than in each
surface is what makes the two triggers agree about it. The wasm still loading is the other thing an
attempt can wait for, which is why it is bounded at two waits rather than left open.

`HoverSource.prewarm` is what usually makes the wait invisible: the caret dwell arms it, so the
lookup runs _inside_ a delay the reader is already having. It is on a short settle of its own, since
a caret arrowing down a block would otherwise start one scope build per line it passed.

**The same shape, five more surfaces.** `NumbatInputHost` (in`views/input.ts`), the contract behind
the REPL, the Numbat property field and the `.nbt` editor, used to carry three members that each
called into a wasm handle synchronously, once per visible completion row: `completionSignature`,
`completionInfo` and `memberFields`. It extends `FactsHost` now, which is those same two entry
points, so the completion source is `async` and the rows read a map. The editor's own completer
(`completion/suggest.ts`) and the scope inspector's search (`views/scope.ts`) shared the _functions_
rather than the contract, and were converted the same way.

Two host shapes cover all five. `scopeFactsHost` names a scope by the ingredients
`ensureBlockCompletion` would build it from (the property above, the caret's line, the code above
the cursor) and rebuilds nothing to answer a read. `contextFactsHost` names a context somebody else
owns, for the two surfaces that cannot be described by replayable text: the REPL, whose session
_accumulates_ definitions (so its key moves on every line it evaluates, and the handle is re-checked
after the wait in case a crash freed it), and the inspector's prelude context, which is deliberately
used only when it already exists because building one loads the whole standard library.

**A renderer is the sharp case, and there are three of them.** `renderSuggestion`, `NumbatInput`'s
row map and the inspector's `signatureFor` each drew one row at a time with no way to wait and no
second chance to draw, which is why the signature was fetched from a stashed handle inside them.
Each now reads the cache, and the async path that produced the rows fills a screenful first —
`SUGGESTION_LIMIT` rows for the editor completer, `MAX_RESULT_ROWS` for the inspector, since a fact
about a row that cannot be drawn is a fact nobody sees. The stashed handle went with it, along with
the freed-context guard it needed: leaving a popover open past `completionIdleSeconds` used to
release the completion contexts underneath it, and calling into the freed handle threw "null pointer
passed to Rust", which downstream read as a crash and restarted the engine. There is no handle to
free now.

A documentation popup is the other sharp case: a dwell is the reader having _stopped_, so unlike a
row there is no next keystroke to be corrected on. All three start their lookup when the dwell timer
is armed — the scope is warm, the query that produced the row just used it — and come back at most
once if the answer was not there.

**The typed-hole hint is a second cache, not a fifth mask bit.** What `12 km /` is still waiting for
is a question about arbitrary half-written text, answered by evaluating a hole form rather than by
looking a name up, so `knownHoleType` / `ensureHoleType` sit beside the other pair rather than
inside it. Nothing there ages: a hole form is a type error _before_ execution, so what it reports
cannot depend on the clock but only on the scope and the generation, both of which are in the key.
The reader is a CodeMirror decoration builder, which is the one kind of caller that can neither wait
nor be given a second chance, so it reads, and a miss asks and repaints. It asks at most once per
distinct line, or a scope that cannot answer would loop between asking and repainting.

**What the prelude reserves is restored from disk, not waited for.** The names Numbat's prelude
defines decide how a note's frontmatter reads and building the set needs an interpreter. Until one
exists nothing reads as reserved, and when the set arrives it moves `reservedEpoch`, which every
preamble cache key folds in, so every open note re-derives. That is one storm per session today and
one _plus a round trip_ behind a worker, so the set is written into the plugin's data beside the
settings and read back synchronously at load (`properties/reserved-names.ts`).

The seed is deliberately **provisional**: its stamp covers the plugin version, the prelude files and
the exchange-rate flag, but not the _contents_ of those files, which are not read from the vault
until later. A prelude edited while the vault was closed seeds a set that is subtly wrong, but is
corrected by the very next thing that happens, since `ensureReservedNames` asks anyway and bumps the
epoch when the answer differs. It only bumps when it differs, which is what makes the seed worth
having: a correct seed means the storm never happens at all.

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

| Module                      | The surfaces it keeps in step                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope/replay.ts`           | the editor completer and the hover                                                                                                                                                                                  |
| `completion/render.ts`      | the editor `EditorSuggest`, the REPL completer, and the inspector's search results — three copies of the row renderer existed, and a fourth was imminent                                                            |
| `hover/content.ts`          | the editor hover, the REPL, the `.nbt` editor, and the property field: one card, four surfaces                                                                                                                      |
| `interpreter/facts.ts`      | every surface that shows what a name _is_ — both hovers, all three completers and the inspector's search — on one cache and one coalescer                                                                           |
| `interpreter/protocol.ts`   | the two sides of the seam, on what a request and a reply are: one definition of the purpose mask, the scope key and the reply envelope, checked against both the host and the tasks                                 |
| `scope/goto-definition.ts`  | the inspector's rows and the hover popup's jump link                                                                                                                                                                |
| `views/input.ts`            | the REPL input, the property field, and the whole `.nbt` editor are one CodeMirror host in three configurations                                                                                                     |
| `document/frontmatter.ts`   | the five modules that independently scanned for `---` fences; two of them disagreeing means one reads YAML as Numbat                                                                                                |
| `interpreter/reuse.ts`      | the context pool and the property field, on what makes a used context safe to hand on — `definesNames` served the second alone until the first needed the same question asked from the other end                    |
| `syntax/identifier.ts`      | the tokenizer and the hover, on what a Unicode-aware Numbat word is — a `µm` unit once colored as `m` because they had separate copies                                                                              |
| `tuning.ts`                 | four `MAX_CACHE_ENTRIES` under one name holding three different values, and three `EVALUATE_DEBOUNCE_MS` holding two                                                                                                |
| `interpreter/eval-cache.ts` | the six caches of evaluated results — inlay blocks, `.nbt` whole-file, editor inline, reading-view inline, inspector values, and the facts about a name — which were five copies of one `Map` and one eviction loop |

`tuning.ts` deliberately does **not** unify the values it collects, only the names. The spread is
intentional as a per-block cache, a per-note cache, and a per-render cache have no reason to be the
same size, and naming each for its consumer is what makes the difference reviewable.

The counterexample is just as instructive: the soft-keyboard tracking is merged **only where the
behavior actually matches**. The REPL and the `.nbt` editor both ask the same question — how far
does the thing at the bottom of the screen reach into this view — so that is one
`SoftKeyboardTracker` in `views/soft-keyboard.ts`, driving the REPL's input row and the file
editor's key bar alike. The scope inspector is left out of it: it pads its own element instead of
insetting the view and measures no viewport at all, because Obsidian's mobile shell already reflows
the drawer it lives in. Folding it in would mean picking one behavior on the platform hardest to
test, so it keeps the leaf helpers in `views/mobile-keyboard.ts` and none of the tracker.

## Things Obsidian Does not Officially Support

Six features **reach past the public API**. They are defensive where they have to be, and each
carries a comment saying what it depends on:

- **Syntax Highlighting Inside a Fence:** Obsidian exposes no way to bind a CodeMirror 6 language to
  a fence info-string, so `syntax/highlight.ts` detects the fences and tokenizes their contents
  itself, painting `Decoration.mark` ranges.
- **The `Numbat` Property Type:** This is directly registered into
  `metadataTypeManager.registeredTypeWidgets`, the undocumented registry Obsidian's own widgets and
  the Better Properties plugin both use. Better Properties prefixes its ids, so the two coexist. The
  same registry is how a _sub_-property is typed: Better Properties keys an object's fields
  `<parent>.<field>` and an array's items `<parent>.#`, which is the spelling `properties/parse.ts`
  reads the assignment of a nested property or a list item under. The `Zoned Date` and
  `Zoned Datetime` types (`properties/date-type.ts`) are registered exactly the same way, and _read_
  Obsidian's own `date` and `datetime` widgets back out of the registry to draw their calendar
  halves — a read, so there is nothing to restore, and whatever another plugin has wrapped one with
  is called through as it stands. The row's calendar `<input>` is found by
  `input:not(.numbat-property-zone)`, because the zone field is an `<input>` in the same row and a
  built-in that drew none of its own would otherwise have a zone _label_ written back as the value's
  wall clock. All three registrations are removed on unload **only if the entry is still the one
  they installed**, so a plugin that wrapped one of ours keeps its wrapper.
- **The Type Menu's Order and Its Icons:** Obsidian builds the property-type menu by iterating that
  same registry, so its **key order is the menu's order** — and everything registered during
  `onload` lands after everything Obsidian ships. `properties/registry.ts` rewrites that key order
  in place (the same object, since Obsidian and every other plugin hold the reference), sorting
  every entry by the name it shows under, which is what Better Properties does to the same record;
  it re-sorts when the manager announces a change, deliberately never announces one itself (two
  plugins sorting on each other's event would hand it back and forth forever), and restores the
  order it found on unload. The types' icons are the plugin's own `addIcon` copies of Obsidian's
  Lucide glyphs, scaled out of Lucide's 24-unit box into the 100-unit one `addIcon` wraps them in
  and marked with a class of the plugin's, so `styles.css` can tint them green — the "not a built-in
  type" tell. That tint applies **inside a menu only**, which is worth saying while a type is being
  chosen and is noise once one has been: in a property row or a Bases cell the icon draws like any
  other. Scoping it is also the one rule in the stylesheet that names a class of Obsidian's, because
  Obsidian draws these icons itself, into DOM the plugin never sees — so unlike a widget of its own,
  which is told which surface it is on in TypeScript, an icon can be told only by what it sits
  inside. `addIcon` has no counterpart, so those three ids are the one thing here that outlives
  unload; with the stylesheet gone they draw in the same color as any other icon.
- **No Monkey-Patching of Property Widgets:** An earlier version replaced the `datetime` registry
  entry outright, behind a setting, to add the same zone field to Obsidian's own widget. It was
  removed in favor of the `Zoned Datetime` type, which covers the same ground: a patch inherits
  every change Obsidian makes to the widget it wraps, has to be undone exactly on unload, and has to
  coexist with whatever else has wrapped the same entry — three standing risks the type does not
  carry. `docs/design/property-timezones.md` records what it did and why it went.
- **A Worker Built From a Blob URL.** Obsidian ships no worker API and makes no promise that one can
  be constructed, and nothing in this repository can tell you whether a blob worker runs inside
  Obsidian on a phone. So the interpreter is _tried_ on a worker and never assumed onto one: the
  ladder in `interpreter/ladder.ts` falls to a `data:` URL and then to the main thread, a rung that
  constructs and then stays silent counts as a failure, and the version card names the path actually
  in force. `docs/design/worker.md` records the invariants the move had to preserve.
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

**There are two passes, not one.** The interpreter's worker is bundled separately
(`scripts/worker-bundle.mjs`) and injected into the main pass through a virtual module,
`symbat:worker-source`, as an ordinary string. A virtual module rather than `define`, which would
need a `declare const` and a 70 KB literal in an options object, and rather than `banner`, which
cannot be referenced as a value.

Four things about that pass are crucial and each is lost time if changed without sufficient
understanding:

- **`format: "iife"`, and `external: []`.** A classic `Worker` cannot load ESM, and module workers
  from blob URLs are the least portable option available. An external in an iife bundle becomes a
  bare `require()` that throws the moment the worker loads — which looks exactly like a platform
  that does not support workers.
- **`target: "es2020"`,** one step below the main bundle. The one public report of wasm-in-a-worker
  failing inside Obsidian was fixed by dropping to es2020; free insurance on the platform this
  repository cannot test.
- **No `charset: "utf8"`.** esbuild's default escapes non-ASCII, which is what keeps the `data:` URL
  rung small and encodable.
- **`watchFiles`.** The worker's sources are not in `main.js`'s dependency graph, so without them
  `make dev` serves whatever worker existed when the watcher started — you would edit worker code,
  reload, see no change, and conclude the worker was broken.

Two guards and two budgets fire in that pass, but none of them is visible to tsc, ESLint or the
tests. The guards refuse a worker that imports the wasm binary (a second 2.5 MB base64 copy) or any
host package (a worker that throws on load, and so a plugin that evaluates nothing). The budgets are
split rather than one number on `main.js`, because a flat ceiling there is 88% a budget on the wasm
module: it moves whenever `NUMBAT_TAG` moves and says nothing about the code. So the worker's own
code and `main.js`-minus-the-inlined-module are bounded separately, and each failure names its
likely cause.

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
