# Design Note: Moving the Interpreter Off the Main Thread

**Status:** Complete

Every evaluation Symbat performs needs a Numbat context, and building one is `Numbat.new(true, …)`,
which parses and type-checks the whole standard library. **163 ms, synchronously, on the main
thread** in Obsidian. Nothing in the plugin can make that cheaper: the wasm exposes `new`,
`interpret` and `free`, with no clone, no snapshot and no scope-pop, so a context cannot be shared
between two independent blocks.

Moving it to a Web Worker is the only way to really speed it up. It is also the only way to put a
**ceiling** on a single evaluation: Numbat's VM has no fuel, no interrupt hook and no depth cap, and
its call stack is a heap `Vec` rather than the wasm stack, so runaway recursion is minutes of
allocation rather than a trap the existing catch can rescue. `worker.terminate()` is the one
mechanism the platform offers that stops a Numbat evaluation that has already started.

## The Invariants

**Exactly one live wasm instance, ever.** Exchange rates are applied into a per-instance Rust
`OnceLock`, so two instances mean two rate states and two 1.9 MB modules. `host.ts` holds one
`Transport | null` and every transition goes through `resetInstance()`, which puts the old one down
before anything constructs a new one.

**No handle crosses the boundary, and none outlives the call that produced it.** This is what Stage
A was for. A `Numbat` is a pointer into the wasm heap; calling into a freed one throws "null pointer
passed to Rust", which the catch downstream cannot tell from a genuine crash and recovers from by
restarting the whole engine. As of Stage B there is no place in the plugin that borrows a context at
all: `borrowScopeContext` (`properties/note-outcomes.ts`) was the last one, and the reuse it
arranged for itself now happens inside the interpreter where nobody can reach it.

**A respawn does not move `interpreterGeneration()`.** A crash does not change what a note _means_,
and `interpreterGeneration()` is folded into every evaluation cache key in the plugin. Bumping it on
a respawn turns a crash storm into a vault-wide re-evaluation storm. The generation _is_ restated to
the fresh instance, along with the environment: a respawned worker is a module that has never heard
of either, and a prelude that quietly stops being applied reads as a broken note rather than a
broken restart.

**The rates are fetched on this thread.** `requestUrl` is main-thread-only, so the host fetches the
XML and posts it; `loadExchangeRates`, `primeExchangeRatesCache` and `clearExchangeRates` stay in
the façade. The base64 wasm module travels the same way, once, in the `init` message, so
`wasm-binary.ts` holds the literal rather than the decoded bytes: the side that instantiates is the
side that should pay for the decode.

**A panic is a message, never a throw.** The REPL used to depend on the throw and bypassed
`interpret()` deliberately, because the catch was what caused it to rebuild the context. That is an
explicit third response state now, beside `output` and `command`; without one a panic prints an
error line while the REPL keeps typing into a dead session.

**`initSync` in the worker, `__wbg_init` in the fallback.** `initSync` calls
`new WebAssembly.Module(bytes)`, the synchronous compiler, which V8 refuses on a document's main
thread above 4 KB. It is permitted in a worker and is the right choice there; the fallback must keep
the async form. `initEngine(base64, sync)` takes the choice as a parameter rather than guessing
where it is running — `boot.ts` passes `true` and `localAttempt` passes `false` — because getting it
backwards produces a plugin that throws on load for everyone.

## What Stage C Changed

Stage B built the boundary and moved nothing across it. Stage C moved the interpreter across it and
changed nothing else. Every module above `interpreter/host.ts` is untouched, which is the boundary
enforcing it architecturally.

The whole of the move is four new files and one rewritten one:

| Module                            | Role                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `interpreter/wire.ts`             | the envelope: correlation ids, the lifecycle messages that are not tasks, and the two things the answering side says unasked          |
| `interpreter/transport.ts`        | the interface, and the in-process implementation — which is a direct call and is what the whole test suite drives                     |
| `interpreter/worker-transport.ts` | the `Worker` implementation, its correlation table, and the blob / `data:` URLs it can be built from                                  |
| `interpreter/ladder.ts`           | trying rungs in order and recording why each failed. Pure, imports nothing, and is the only part of the spawn policy a test can drive |
| `interpreter/worker/boot.ts`      | the worker bundle's entry point: a message in, a call on `entry.ts`, an answer back out. Nothing below it knows it is being spoken to |

Six things Stage C settled that the plan did not have:

- **The environment update needed a message with no reply, and therefore an unsolicited one.**
  Numbat's exchange-rate store is set once per module, so replacing rates means replacing the module
  — and the side that knows is the far one. Making it a round trip would have meant either an
  `await` on a path that has none, or a window in which the host believes the interpreter is ready
  and it is not. So the worker posts `stale` on its own initiative, and the in-process transport
  calls the same callback synchronously.
- **A panic in a task must not count toward the respawn-storm latch.** The latch's question is "can
  this thread host the interpreter", and a Numbat panic proves nothing about the thread; a note that
  panics three times in a minute would otherwise move the reader onto the path that has no way to
  stop an evaluation. Only transport-level faults count.
- **The prelude gets suspended rather than blamed on the thread.** More restarts than the latch
  allows, with a personal prelude configured, means the prelude is the prime suspect — it is
  replayed into every context, so it is the only thing that can make _every_ task fail. It is
  suspended and the reader is told; nothing else in the plugin could explain why their own file
  stopped being loaded.
- **The active path is remembered past a teardown.** Otherwise pressing "Stop evaluating" makes the
  stop button disappear, which is a poor reward for pressing it.
- **A user-initiated stop files a refusal against whatever was still running**, under its own
  sentence. "Time limit reached" names a setting the reader did not trip; and without an entry at
  all, the render that was hanging re-fires the moment the interpreter is back and the reader stops
  the same note over and over.
- **The stop button could not live in the view header.** It was added with `addAction`, beside the
  REPL's own "Reset REPL", and on desktop it never rendered. Three explanations were tried and
  disproved in turn — a Lucide icon rename (`x-octagon` → `octagon-x`, which the vault's own
  `getIconIds()` showed was not it), the show/hide timing, and the signal that decides whether the
  path can be stopped at all. Why that bar does not show its actions here was never established:
  Obsidian's defaults, `navigation = false` on this view, the theme and another plugin are all still
  live candidates. The button moved into the input row, next to the Esc and evaluate buttons, and
  the finding generalises past this bug — **a load-bearing affordance does not get to depend on a
  surface whose behaviour cannot be accounted for.** It is also drawn as a text glyph rather than
  through `setIcon`, since an unknown icon id renders as an empty button and reports nothing.
- **The `import.meta.url` in the generated bindings is defined away rather than tree-shaken.** The
  engine imports both initializers — `initSync` for the worker, the async one for the fallback — so
  the branch that resolves the module next to itself survives, and `import.meta` does not exist in
  an iife. Left alone esbuild warns and substitutes `{}` on every build; saying outright that there
  is no module URL here is the honest version of the same thing.

### Stopping Work That Has Already Started

Cancelling used to reach exactly one kind of thing: a job still in a queue. A job that had started
was, by construction, no longer in one — so "stop what you are doing" was a promise about the future
and nothing else, and an editor three keystrokes into a note went on paying for a pass describing a
document that no longer existed.

The three tasks that loop over items — the editor's inlay pass, a note's inline spans, and the
reading view's recovered expressions — now stand aside between them (`worker/cooperative.ts`), and
the queue hands each running job a signal saying whether anybody still wants it. A boundary checks,
yields, and checks again; the second check is crucial, because the message that cancels a job can
only be _delivered_ in the gap.

Four things this had to get right, each of which is a bug if it is not:

- **`MessageChannel` is not a preference, it is the only portable macrotask yield.** `setTimeout(0)`
  is clamped to 4 ms once nesting passes five, which over a hundred items is four hundred
  milliseconds of pure clamp; `requestIdleCallback` is off by default in Safari; and
  `scheduler.postTask` / `scheduler.yield` are unimplemented in WebKit, which is what Obsidian
  mobile runs on.
- **A yield must be free.** The evaluation allowance is a wall-clock deadline, so a task that
  stepped aside would otherwise be billed for however long somebody else spoke — which is the exact
  objection `withBudget`'s synchronous contract exists to raise. `suspendBudget()` answers it in
  both directions: it moves the deadline forward by the time spent away, and it clears the arm
  outright so that nothing running in the gap can be refused by a limit it was never given.
  `withBudgetAsync` is the arm around a task that yields, and it is sound only because the queue
  runs one job at a time — if that ever changes, it needs a stack of arms rather than one.
- **The `finally` that frees a context has to wait for the work.** `withContext`'s does not once
  `use` is asynchronous: it runs when `use` hands back a promise, not when that promise settles, so
  the context would be freed while the walk was still interpreting into it. What follows is a call
  into a freed handle — "null pointer passed to Rust" — read downstream as a crash and answered with
  a restart, at a distance from anything resembling a cause. Hence `withContextAsync`.
- **A task unwinding because it was told to stop is not a fault.** It settles the same `null` a job
  dropped before it started would have, and says nothing on the console. Reported as a panic it
  would restart a healthy interpreter every time somebody typed over a pass in flight.

**One of those four was found by the tests rather than by reading**, and it was a deadlock. A single
reused `MessageChannel` starves everything else on node's event loop: a port drains its own queue in
a loop with microtasks between messages, so a resolver that yields again posts straight back into
the drain that is still running, which picks it up without ever going round the loop. The `cancel`
message it was standing aside for sat in the parent port's queue for the whole pass. Measured: forty
items with one channel ran to the end undelivered; alternating two channels, the cancellation landed
on the fifth. A browser is thought not to need the alternation — a posted message is its own task
there — but that is an inference about an engine this suite cannot run, and the second channel costs
one allocation for the life of the worker.

What none of this touches is a single `interpret` call. Numbat has no fuel, no interrupt hook and no
depth cap, so one expression that will not finish is stoppable only by terminating the thread — this
is the rung below that, not a replacement for it. The tasks that were left alone were left alone for
a reason: `evalBindings`, `evalScopeTree` and `evalDocument` drive pure modules the whole test suite
calls synchronously, and each is bounded by a note's property list or by a single file.

## The Fallback Is Opt-In

The in-process path used to be the last rung of the spawn ladder, so asking for a worker fell to it
whenever no worker answered — which is why the setting's stored value used to read `auto`. That was
wrong, and not by a little: **the two paths are not two speeds.** Only a worker can be terminated,
and terminating is the only mechanism the platform offers that stops a Numbat evaluation which has
already started. A reader who set a ten-second limit and silently landed in process had a setting
that was, for the case they most likely set it for, a lie — and the status line that would have told
them is one nobody opens until something is already wrong.

It is the same standard the build already holds itself to. `forbidHostImports` is a build _error_
rather than a warning precisely because "a worker that throws on load and falls back silently,
forever" is expensive and invisible; the runtime should not be more relaxed about the same outcome.

So a ladder that runs out now ends in a reported state rather than a quieter interpreter:

- nothing is evaluated, and `interpreterReady()` stays false, which every surface already checks;
- one `Notice` per session, **with no timeout**, naming what is lost and where the setting is — an
  explanation that vanishes while the reader is looking at a note that will not evaluate is no
  explanation;
- the version card and **Copy debug info** carry the same line for as long as it is true;
- `interpreterProblem()` gives the REPL a sentence to print, since the REPL is where somebody goes
  to find out why nothing is happening.

The respawn-storm latch ends in the same state, for the same reason: handing the reader a weaker
guarantee at the exact moment something is already going wrong is the worst time to do it silently.

Two things deliberately did **not** change. The in-process transport is still built and is still
what the whole test suite drives — it is not entered without a decision, which is not the same as
being gone. And a request that arrives before `onLayoutReady` is still served in process, because
spawning a thread during Obsidian's own startup on the strength of one early question is a bad
trade; that instance is replaced by a worker as soon as spawning is permitted.

The evidence this rests on is a device pass on macOS desktop and iOS, which bracket the two browser
engines Obsidian runs on. **Android is unverified, for want of a device.** If it turns out that a
whole platform cannot construct a worker, the answer is a notice those readers will actually see and
a dropdown one click away — which is what this is — rather than a guarantee that quietly does not
hold.

## What Stage B Changed

Stage B built the boundary and moved nothing across it. Every evaluation in the plugin is now a
request: plain data out, plain data back, one whole job at a time, through `ask`
(`interpreter/host.ts`). The interpreter is still on the main thread and still called synchronously
by the module that owns it. **Any regression this stage produces is attributable to the API change
alone**, because the only other thing that changed is which module holds the handle.

The six modules and what each is for are in
[architecture.md](../architecture.md#the-seam-one-whole-job-at-a-time). What matters here is the
list of invariants above, and where each of them now lives:

| Invariant                        | Where it is enforced                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| exactly one live wasm instance   | `host.ts` owns the start, the restart and the dispose; `worker/engine.ts` has no way to instantiate itself                                        |
| no handle crosses                | `protocol.ts` names a **scope** or a **session id**; `borrowScopeContext`, the last borrow in the plugin, is gone                                 |
| a respawn bumps the worker's gen | `host.ts`'s `restartInterpreter` does not touch `interpreterGeneration()`, which only the environment moves                                       |
| rates are fetched on this thread | `numbat.ts` still owns `requestUrl`; the XML is posted as part of `EngineEnv`                                                                     |
| a panic is a message             | `worker/engine.ts` records a fault instead of throwing; every reply carries it, `ask` acts on it, and the REPL has a `crashed` outcome of its own |
| `initSync` in the worker         | `initEngine(base64, sync)` takes the choice as a parameter rather than guessing, and the in-process path passes `false`                           |

Two things the seam made possible that could not have been written before it:

- **The REPL's crash arm.** `views/repl.ts` used to bypass the shared `interpret` deliberately,
  because the _throw_ was what told it to rebuild its context. Across a boundary a panic is always a
  message, so `ReplOutcome` has an explicit third state. Without it a panic prints an error line
  while the REPL goes on typing into a session that no longer exists.
- **The prelude error.** `getLastPreludeError()` was module state read immediately after
  `createContext`. That ordering does not survive a message, so the three answers that need it —
  `ScopeSnapshot`, `ReplSession`, `preludeCheck` — carry it themselves.

And one that was blocked at Stage A and is now closed: **the dimension and unit names a context
build enumerates ride out on every reply**, and `host.ts` records them into `syntax/type-names.ts`.
Miss that and every unit silently stops being syntax-highlighted: no error, no missing feature to
report.

### What Stage C Inherited

A few things Stage B put in place that Stage C used unchanged.

- `worker/entry.ts` was already the whole message surface. Wrapping it in an `onmessage` handler was
  the change; nothing above it moved.
- The evaluation allowance is armed on the **answering** side, and the refusal ledger is consulted
  on the **asking** side. They were two halves of `interpreter/budget.ts` in one module instance and
  are two module instances now, which is why `refillEvaluationBudget` goes through the host rather
  than calling `releaseNote` directly. It read as a needless hop right up until it was not.
- The queue was already worker-side, which is where it belongs: it schedules what the interpreter
  does next, and the interpreter is over there.

## What Stage A Changed

Stage A moved every synchronous interpreter call off the paths that cannot wait, without moving
anything between threads. Seven steps:

|         | what it dissolved                                                                                                                                                                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1**  | `\code` expansion, which ran inside CodeMirror's `inputHandler` — a `(view, from, to, text) => boolean` contract with nowhere to put a promise. The table is transcribed into `unicode/table.ts` and pinned by a golden test against the real wasm. |
| **A2**  | The hover card builder, which was handed the context itself. `hover/card.ts` decides what a card says as a pure function of three named facts.                                                                                                      |
| **A3**  | The facts cache (`interpreter/facts.ts`): a synchronous map read, an asynchronous batched fill, and — at the time — a simulated round trip to measure against.                                                                                      |
| **A4a** | `NumbatInputHost` — the REPL, the property field and the `.nbt` editor — and the purpose mask that keeps a completion row from costing an evaluation.                                                                                               |
| **A4b** | The editor completer and the scope inspector: the two renderers that probed per visible row.                                                                                                                                                        |
| **A5**  | The remaining two synchronous questions — the hover card behind those hosts, and the typed-hole hint — plus `contextGeneration()`, which had nothing left to guard.                                                                                 |
| **A6**  | The prelude's reserved-name set, which every preamble cache key folds in, and which is now restored from disk rather than waited for.                                                                                                               |

The shape they all end up in is the same: **read what is known synchronously, ask for what is not,
and let the surface's own retry bring the answer back.**

## What A3 Measured

`FACTS_LATENCY_MS` made every lookup pretend to take a round trip. A build with it at **150 ms**,
the cold-scope number, charged to every lookup including ones a real worker serves in a few
milliseconds, was used in a real vault on macOS desktop, Obsidian 1.13.7:

```
Facts: 4 asked, 75% known; 1 filled in 1 lookups (latency 150 ms)
Cards: p50 9 ms, p90 246 ms, max 246 ms over 3; 1 after a wait, 0 abandoned
```

Read carefully: one cold lookup and two warm ones. `0 abandoned` is the headline: the card always
arrived. `p50 9 ms` says a second hover of the same name is indistinguishable from today.

Two numbers worth carrying:

- **246 ms** is the whole cost of a cold hover, and that clock starts when the card is already
  _due_. It was judged acceptable and it was a _mouse_ hover, the path with no prewarm, which makes
  it the design's worst case rather than its typical one.
- **~96 ms** is what is left after subtracting the simulated 150: the real context build plus three
  probes. The budget was 163 ms, so the seam has margin it did not know it had. One sample;
  re-measure before relying on it.

## What Stage D Measured

Stage D was planned as a pre-built context pool refilled while the worker was idle. Measuring first
sent it the other way, and the numbers are worth keeping because they bound what any future scheme
here can be worth.

|                                                |                                     |
| ---------------------------------------------- | ----------------------------------- |
| `Numbat.new(true, …)`                          | **55 ms** here, ≈163 ms in Obsidian |
| the nullable prelude on top                    | 2.4 ms                              |
| `buildVocabulary` on top                       | 4.0 ms                              |
| `Numbat.new(false, …)`, no standard library    | **0.0 ms**                          |
| replaying four chunks into an existing context | 2.6 ms                              |
| a live context, in wasm heap                   | **1.2 MiB**                         |
| sixteen held, freed, held again                | 23.6 → 25.1 MiB, not 47             |

Three conclusions:

- **The standard-library load is the whole cost.** Everything else is noise beside it, so there is
  nothing to shave, only builds to avoid.
- **Heap is not the constraint.** Freed pages are reused, so `PRISTINE_POOL_ENTRIES` bounds a
  high-water mark that is set once. The plan's `POOL_TARGET = 1` was caution the numbers do not
  support; it is 4.
- **Pre-building moves work rather than removing it**, and speculates: a context nobody claims is
  waste. So the pool recycles instead. See _The Context Pool_ in `architecture.md` for how it
  decides.

What it is worth, over a twelve-block, twelve-span note — one live-preview render, both passes:

|                               |                               |
| ----------------------------- | ----------------------------- |
| before Stage D (13 contexts)  | ≈715 ms                       |
| cold pool                     | **169 ms** (12 hits, 1 build) |
| warm pool, every render after | **16 ms** (13 hits, 0 builds) |

### What Stage D Didn't Do

- **The property batch, the `.nbt` passes and a defining property row keep building.**
  `evaluateBindings` writes a `let` per binding, so its context can never come back unchanged; a
  `.nbt` file defines by definition and its key carries `preludeBefore`, so nothing else produces
  one. Each is recorded at `withContext`, which is what they still use.
- **The scope inspector was left out for a contract reason, not a value one.** It builds a context
  per block, so it would be worth converting, but `evaluateScopeTree`'s factory takes no argument —
  what is about to be replayed is not knowable where the context is made. That is a change to a pure
  module's API rather than to the task layer.
- **`recycle`'s fault guard has no test**, and cannot have one here: the only way to panic the real
  wasm from this harness is applying exchange rates twice, which finishes the instance for every
  test after it — which is why `exchange-rates.test.ts` holds exactly one test and says so.

### A Hazard This Stage Named

**Three existing tests turned out to be timing tests in disguise, and the pool falsified all
three.** Two cancellation cases in `worker-source.test.ts` built forty blocks of `1 + 1` on the
stated assumption that forty standard-library loads is "seconds of work" but the pool answers
thirty-nine of them in microseconds and the pass was over before the wait. The 1 ms-budget case in
`tasks.test.ts` blew its allowance on the first block's build and stopped doing so. All three were
repaired by making their blocks **define** a name (the one shape that cannot be pooled) so each pays
for a real build and the premise holds again for a stated reason. Any fixture whose cost is its
premise is worth checking against this.

The other side of that: **the evaluation limit now bites much later** on a note of simple blocks,
because the note gets much further through its allowance. That is the intended direction, and it is
worth knowing when reading a report that says the limit did not fire.

## The Knob, and Where it Went

`FACTS_LATENCY_MS`, the counters behind `factsReport()`, and the two lines they added to **Copy
debug info** were always temporary. They existed so the question the branch rested on was settled by
measurement on a real device — including a phone, where nothing in this repo can predict whether a
blob worker runs at all — rather than by argument.

**All of it was removed on 2026-08-22**, once the latency had stopped being imaginary. The numbers
above are what it was for, and they are kept; the instrument is not. Two pieces of state in
`hover/hover.ts` went with it, because they existed only to feed a counter: the `askedAt` field, and
`giveUp`'s `waits` parameter. `waits` itself stays in `open()`, where it bounds the retry chain.

What replaced it in **Copy debug info** is one line from the context pool, `Contexts:`, which
answers a live question rather than a settled one — whether the reuse rate measured in this
container holds in a real vault.
