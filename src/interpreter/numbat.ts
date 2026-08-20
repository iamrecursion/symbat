// Thin wrapper around the Numbat WebAssembly interpreter.
//
// The generated bindings (`wasm/pkg`) are produced from the pinned `sharkdp/numbat` source by
// `scripts/build-wasm.xsh`. The whole Numbat standard library is embedded in the `.wasm`, so
// nothing else needs to be shipped.

import { requestUrl } from "obsidian";
import { completionCard, type CompletionInfo, signatureFromTypeOutput } from "../completion/docs";
import {
  type CompletionVocabulary,
  parseListNames,
  pluginTypeCandidates,
  structFieldNames,
} from "../completion/expressions";
import { plainText } from "../evaluation/inlay-parse";
import { type PreludePart, preludeSourceBefore } from "../settings/util";
import { forgetSemanticNames, recordSemanticNames } from "../syntax/type-names";
import { buildUnicodeCodeList, codesMatching, type UnicodeCode, unicodePrefixAt } from "../unicode/codes";
import init, { __numbat_reset, FormatType, Numbat, setup_panic_hook } from "../wasm/pkg/numbat_wasm.js";
import wasmBase64 from "../wasm/pkg/numbat_wasm_bg.wasm";
import { escapeHtml } from "./markup";
import { NULLABLE_PRELUDE } from "./nullable";
import { readableNullables } from "./nullable-display";

export { FormatType, Numbat };
export type { PreludePart, UnicodeCode };

/** The outcome of one {@link interpret} call. */
export interface NumbatResult {
  /** Numbat's rendered output — HTML when the context formats as HTML, and an error message rather
   *  than a value when {@link isError}. */
  output: string;

  /** Whether Numbat rejected the input (a parse, type, or runtime error). */
  isError: boolean;
}

// The in-flight (or completed) wasm initialization, so concurrent callers of `ensureNumbatReady`
// share one init rather than racing to instantiate. Nulled on restart, which is what lets the next
// caller start a fresh one.
let readyPromise: Promise<void> | null = null;

// A synchronous mirror of `readyPromise` having resolved: `true` once the wasm module is
// initialized and safe to call. Editor input handling needs to know this without awaiting (see
// `getUnicodeCompletion`); cleared on restart.
let wasmReady = false;

// Set when a wasm call throws (a Rust panic). Reinitialization is deferred to the next
// `ensureNumbatReady()` so the current render can still free its contexts on the (panic-surviving)
// instance before it is swapped out.
let needsRestart = false;

// A dedicated context reused for Unicode-completion lookups (see `getUnicodeCompletion`), created
// lazily and discarded on a wasm restart.
let completionContext: Numbat | null = null;

// The full `\code` → glyph list for the completion popover (see `listUnicodeCompletions`), built
// once from the static Unicode table and discarded on a wasm restart.
let unicodeCodeList: UnicodeCode[] | null = null;

// The shared, prelude-loaded context used for expression completion in code blocks (see
// `ensureExpressionContext`), and its categorized vocabulary (see `getExpressionVocabulary`). Both
// are discarded on a wasm restart or when the prelude changes (see
// `invalidateExpressionCompletion`).
let expressionContext: Numbat | null = null;
let expressionVocab: CompletionVocabulary | null = null;

// The single-entry cache for block completion that also replays the code above the cursor (see
// `ensureBlockCompletion`): the context, its vocabulary, and the key (rates + replayed chunks) they
// were built for. Rebuilt when that key changes, and discarded alongside `expressionContext`.
let blockContext: Numbat | null = null;
let blockVocab: CompletionVocabulary | null = null;
let blockKey: string | null = null;

// Numbat stores exchange rates in a process-global `OnceLock`; calling `set_exchange_rates` more
// than once panics, so we apply them once per instance.
let exchangeRatesApplied = false;

// The user's personal prelude (see `setUserPrelude`), one entry per configured `.nbt` file in load
// order, replayed into every new context. Empty when no prelude is configured. Kept per file rather
// than pre-joined so a context can be built with only the files loaded *before* a given one — which
// is what the file itself sees when the prelude loads (see `createContext`'s `preludeBefore`).
let userPreludeParts: PreludePart[] = [];

// The HTML-formatted error from the most recent context's prelude application, or `null` if it
// applied cleanly (or there was no prelude). Reset at the start of every `createContext`, so a
// caller reads it immediately after.
let lastPreludeError: string | null = null;

// Bumped whenever something a fresh context bakes in changes — the user prelude, the exchange
// rates. See `interpreterGeneration`.
let generation = 1;

// Bumped whenever the contexts this module owns are freed. See `contextGeneration`.
let contextEpoch = 1;

/**
 * A stamp identifying what a context built *now* would contain, beyond the code fed to it: the user
 * prelude and the exchange rates.
 *
 * Surfaces that cache evaluation results fold this into their cache key. Keying on the note's own
 * text alone is not enough — the same block evaluates differently after a prelude edit or a rate
 * refresh — and enumerating the environment at each cache site is how three of them came to
 * disagree about it. One number, bumped here, is the whole contract: a caller cannot forget a
 * component it never has to name.
 */
export function interpreterGeneration(): number {
  return generation;
}

/**
 * Declare that every cached evaluation is out of date, whether or not anything actually changed.
 *
 * Deliberately a *claim* rather than an observation, and the only caller is the reset command.
 * Every surface that caches an evaluation folds {@link interpreterGeneration} into its key, so
 * moving it is the one action that reaches all of them at once — including the per-view caches this
 * module has no reference to and could not empty if it wanted to.
 *
 * Nothing is freed here: the entries are not deleted, they simply stop being found, and are evicted
 * in the ordinary way as new ones arrive.
 */
export function invalidateCachedEvaluations(): void {
  generation += 1;
}

/**
 * A stamp for the interpreter contexts this module hands out ({@link ensureExpressionContext},
 * {@link ensureBlockCompletion}). It moves whenever they are freed — the idle release, a prelude
 * change, a wasm restart.
 *
 * A caller that keeps a context past the call that produced it must record this alongside it and
 * stop using the handle once it moves. The contexts are wasm objects: calling into a freed one
 * throws "null pointer passed to Rust", and the catch that follows cannot tell that from a real
 * interpreter crash — so it restarts the whole engine to recover from what was only a dangling JS
 * handle.
 */
export function contextGeneration(): number {
  return contextEpoch;
}

/**
 * Initialize the WebAssembly module (once), reinitializing first if a previous crash requested a
 * restart.
 */
export function ensureNumbatReady(): Promise<void> {
  if (needsRestart) {
    needsRestart = false;
    wasmReady = false;
    exchangeRatesApplied = false;
    readyPromise = null;

    // A fresh instance means a fresh standard library, so the captured dimension/unit names must be
    // recaptured rather than carried over.
    preludeSemanticsCaptured = false;
    forgetSemanticNames();
    contextEpoch += 1;

    // The completion context lives on the old instance; drop it (and the code list built from it)
    // so the next lookup rebuilds them on the fresh one.
    freeQuietly(completionContext);
    completionContext = null;
    unicodeCodeList = null;

    // Likewise the expression-completion contexts (and their vocabularies).
    freeQuietly(expressionContext);
    expressionContext = null;
    expressionVocab = null;
    freeQuietly(blockContext);
    blockContext = null;
    blockVocab = null;
    blockKey = null;

    try {
      __numbat_reset();
    } catch (error) {
      console.error("Symbat: could not reset the wasm module", error);
    }
  }

  if (!readyPromise) {
    readyPromise = (async () => {
      await init({ module_or_path: wasmBytes() });
      setup_panic_hook();
      wasmReady = true;
    })();
  }

  return readyPromise;
}

/**
 * Decode the inlined module (see `src/wasm.d.ts`) into the bytes `init` instantiates from.
 *
 * Deliberately not memoized, and deliberately called only from inside {@link ensureNumbatReady}'s
 * promise. `WebAssembly.instantiate` copies what it needs, so holding the 1.9 MB array afterwards
 * would keep a compiled-and-discarded buffer alive for the session to save a decode that happens at
 * most twice (at first use and if a panic forces a reinit).
 */
function wasmBytes(): Uint8Array {
  const binary = atob(wasmBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

/**
 * Request that the interpreter be reinitialized before its next use. Called after a wasm panic; the
 * actual reset happens in `ensureNumbatReady()`.
 */
export function restartNumbat(): void {
  needsRestart = true;
}

/**
 * Whether the wasm module is initialized and safe to call synchronously. Lets the completer decide,
 * without awaiting, whether it can return results now or must show a loading placeholder while
 * {@link ensureNumbatReady} runs.
 *
 * A pending restart (after a crash) counts as not ready: `wasmReady` is still set until the reset
 * actually runs, so the completer must defer to {@link ensureNumbatReady} — which performs the
 * restart — rather than call into the poisoned instance and get stuck.
 */
export function isNumbatReady(): boolean {
  return wasmReady && !needsRestart;
}

/** A one-line description of a caught error, for surfacing to the user. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0];
}

/**
 * Free a wasm object, ignoring errors. After a panic the object is left "borrowed" and cannot be
 * freed; the subsequent wasm reset discards it anyway.
 */
export function freeQuietly(value: { free: () => void; } | null | undefined): void {
  try {
    value?.free();
  } catch {
    // Object poisoned by a panic — nothing to do.
  }
}

// EXCHANGE RATES (OPT-IN)
// ================================================================================================

// Numbat parses the European Central Bank's daily reference-rate XML directly. `requestUrl` is used
// so the request works from Obsidian without CORS issues and on mobile.
const ECB_RATES_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

// The most recent rates document and when it arrived, held in memory so a note re-opened within the
// refresh interval does not re-request it. Seeded from the copy persisted in settings at startup,
// which is what makes rates work offline.
let exchangeRatesXml: string | null = null;

// Epoch milliseconds of the last successful fetch; `0` means "never this session".
let exchangeRatesFetchedAt = 0;

/** The outcome of {@link loadExchangeRates}. */
export interface ExchangeRatesLoad {
  /** Whether rates are available for conversions — freshly fetched, or a still-valid in-memory/disk
   *  cache. */
  available: boolean;

  /** The XML fetched on this call (for the caller to persist to disk), or `null` when nothing new
   *  was fetched — a cache hit, a timeout, or a failed request. */
  fetched: string | null;
}

/**
 * Fetch the ECB rates XML, rejecting if it takes longer than `timeoutMs`. Numbat's `requestUrl`
 * cannot be canceled, so on timeout the request is simply abandoned (it completes harmlessly in the
 * background) and the caller falls back to the cache. A non-positive `timeoutMs` waits
 * indefinitely.
 */
async function fetchExchangeRatesXml(timeoutMs: number): Promise<string> {
  const request = requestUrl({ url: ECB_RATES_URL }).then((response) => response.text);
  if (timeoutMs <= 0) {
    return request;
  }

  let timer: number | undefined;
  const timeout = new Promise<string>((_resolve, reject) => {
    timer = window.setTimeout(
      () => reject(new Error(`exchange-rate fetch timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
  }
}

/**
 * Ensure live exchange rates are cached and no older than `maxAgeMs`, giving up a refetch after
 * `timeoutMs` and keeping whatever is cached.
 *
 * The rates are (re)fetched only when nothing fresh is cached; on success the new XML is returned
 * in `fetched` for the caller to persist to disk. On a timeout or failure any previously cached
 * value — in memory, or seeded from disk via {@link primeExchangeRatesCache} — is kept, so
 * conversions still work offline.
 *
 * @param maxAgeMs Maximum age of the cached rates before a refetch, in ms.
 * @param timeoutMs How long to wait for the fetch before falling back, in ms.
 */
export async function loadExchangeRates(maxAgeMs: number, timeoutMs: number): Promise<ExchangeRatesLoad> {
  if (exchangeRatesXml !== null && Date.now() - exchangeRatesFetchedAt < maxAgeMs) {
    return { available: true, fetched: null };
  }

  try {
    const xml = await fetchExchangeRatesXml(timeoutMs);
    const changed = xml !== exchangeRatesXml;
    exchangeRatesXml = xml;
    exchangeRatesFetchedAt = Date.now();

    if (changed) {
      generation += 1;
      if (exchangeRatesApplied) {
        // Numbat's rate store is a `OnceLock` whose setter unwraps the `Err`, so
        // `set_exchange_rates` panics if called twice on one instance — which is why
        // `exchangeRatesApplied` exists. Replacing the rates therefore means replacing the
        // instance. Without this the refresh interval had no in-session effect at all: a session
        // left open for days kept converting at day-one rates while cheerfully re-downloading fresh
        // ones.
        restartNumbat();
      }
    }
    return { available: true, fetched: xml };
  } catch (error) {
    console.error("Symbat: failed to fetch exchange rates", error);

    // Keep any cached rates (in-memory, or seeded from disk) rather than dropping them on a
    // transient network failure or timeout.
    return { available: exchangeRatesXml !== null, fetched: null };
  }
}

/**
 * Seed the in-memory rate cache from a value persisted on disk (see main.ts), so currency
 * conversions work offline before — or without — a successful fetch. Only fills an empty cache, and
 * deliberately leaves the freshness timestamp at 0 so the disk cache still counts as stale: a
 * refresh is attempted per the schedule, and this value is the fallback if it times out or fails.
 */
export function primeExchangeRatesCache(xml: string | null): void {
  if (exchangeRatesXml === null && xml !== null && xml.trim() !== "") {
    exchangeRatesXml = xml;
    generation += 1;
  }
}

/** Drop any cached exchange rates (e.g. when the setting is turned off). */
export function clearExchangeRates(): void {
  if (exchangeRatesXml !== null) {
    generation += 1;
  }

  exchangeRatesXml = null;
  exchangeRatesFetchedAt = 0;
}

// USER PRELUDE (OPT-IN)
// ================================================================================================

/**
 * Set the personal prelude replayed into every new interpreter context, or clear it. Parts are
 * given in load order; whitespace-only ones are dropped, and an empty list (or `null`) disables the
 * prelude.
 *
 * Each part's source is applied verbatim by {@link createContext}; the plugin caches the file
 * contents and calls this when they change.
 */
export function setUserPrelude(parts: readonly PreludePart[] | null): void {
  const next = parts === null ? [] : parts.filter((part) => part.source.trim() !== "");

  // Compared rather than assumed changed: this is called on every prelude reload, including the
  // many that re-read identical files, and a bumped generation invalidates every cached evaluation
  // in the vault.
  const changed = next.length !== userPreludeParts.length
    || next.some((part, i) => part.path !== userPreludeParts[i].path || part.source !== userPreludeParts[i].source);
  userPreludeParts = next;

  if (changed) {
    generation += 1;

    // The prelude can declare — or stop declaring — units and dimensions, so the captured names are
    // recaptured from the next context rather than kept.
    preludeSemanticsCaptured = false;
    forgetSemanticNames();
  }
}

/**
 * The HTML-formatted error (if any) from the most recently created context's prelude application.
 * Reflects the last {@link createContext} call, so read it immediately afterwards; `null` means the
 * prelude applied cleanly or is unset.
 */
export function getLastPreludeError(): string | null {
  return lastPreludeError;
}

/**
 * Replay the user prelude into a fresh context, recording any error. A parse or evaluation error is
 * captured in `lastPreludeError` (and logged); a wasm panic is caught and schedules a restart,
 * mirroring the exchange-rate handling.
 */
function applyUserPrelude(context: Numbat, source: string): void {
  try {
    const result = context.interpret(source);

    if (result.is_error) {
      lastPreludeError = result.output;
      console.error("Symbat: user prelude failed to load:\n" + result.output.replace(/<[^>]+>/g, ""));
    }
    result.free();
  } catch (error) {
    lastPreludeError = escapeHtml(`User prelude crashed the interpreter: ${describeError(error)}`);
    console.error("Symbat: user prelude crashed the interpreter", error);
    restartNumbat();
  }
}

/**
 * Apply the nullable vocabulary (see interpreter/nullable.ts) to a fresh context.
 *
 * Unlike the user prelude, a failure here is a plugin bug rather than something the reader wrote,
 * so it is logged and never routed to {@link getLastPreludeError} — which the REPL and the `.nbt`
 * editor show as *the user's* prelude error.
 */
function applyNullablePrelude(context: Numbat): void {
  try {
    const result = context.interpret(NULLABLE_PRELUDE);
    if (result.is_error) {
      console.error("Symbat: the nullable vocabulary failed to load:\n" + result.output.replace(/<[^>]+>/g, ""));
    }
    result.free();
  } catch (error) {
    console.error("Symbat: the nullable vocabulary crashed the interpreter", error);
    restartNumbat();
  }
}

/**
 * Create a fresh interpreter context with the prelude loaded, rendering to HTML.
 *
 * Every context gets the nullable vocabulary (see interpreter/nullable.ts) first, so the bindings
 * an undefined frontmatter property emits type, and `get_or` and friends are callable everywhere.
 *
 * When `applyRates` is set and rates are cached, they are made available for currency conversions.
 * Because Numbat's rate store is a set-once global, the rates are applied via `set_exchange_rates`
 * only on the first context of a wasm instance; later contexts merely `use units::currencies`.
 *
 * If a user prelude is configured (see {@link setUserPrelude}) it is replayed into the context
 * after exchange rates; any prelude error is recorded in {@link getLastPreludeError}.
 *
 * `options.preludeBefore` names a prelude file whose own scope is wanted: only the prelude files
 * ahead of it apply, so evaluating that file's contents does not define everything in it a second
 * time (a repeated `unit` or `dimension` is an error). Absent — every caller but the `.nbt` editor
 * — the whole prelude applies, as before.
 */
export function createContext(applyRates: boolean, options: { preludeBefore?: string; } = {}): Numbat {
  const context = Numbat.new(true, true, FormatType.Html);
  lastPreludeError = null;

  // Before both of the below: a user prelude that defines its own `get` should *shadow* ours
  // (Numbat lets a later `fn` replace an earlier one), not be replaced by it.
  applyNullablePrelude(context);

  if (applyRates && exchangeRatesXml !== null) {
    try {
      if (exchangeRatesApplied) {
        context.interpret("use units::currencies").free();
      } else {
        context.set_exchange_rates(exchangeRatesXml);
        exchangeRatesApplied = true;
      }
    } catch (error) {
      console.error("Symbat: applying exchange rates failed", error);
      restartNumbat();
    }
  }

  // The prelude is applied after exchange rates so it may reference currencies.
  const prelude = preludeSourceBefore(userPreludeParts, options.preludeBefore);
  if (prelude !== null) {
    applyUserPrelude(context, prelude);
  }

  // The first prelude context anywhere seeds the dimension/unit names for highlighting.
  captureSemanticNamesFrom(context);
  return context;
}

/** The struct types a nested frontmatter property generates (properties/parse.ts's
 *  `_Nb_<Label>_<hash>_<generation>_<index>`). Numbat prints the type name in front of every struct
 *  value, so `costs` would otherwise show as `_Nb_CostsStruct_1uy683r_4_1 { materials: 500 € }`. */
const GENERATED_STRUCT = /_Nb_([\p{L}\p{N}]+)_[0-9a-z]+_\d+_\d+/gu;

/**
 * Rewrite generated struct names to the readable label they carry, so a value reads `CostsStruct {
 * materials: 500 € }` and its type reads `CostsStruct<Money, Money>` — the generation counter and
 * the note-scoped hash that keep the definitions distinct are an implementation detail.
 *
 * Applied to every output the user can see: interpreter results, `print_info` docs, and REPL
 * command output.
 */
export function readableStructNames(output: string): string {
  return output.includes("_Nb_") ? output.replace(GENERATED_STRUCT, "$1") : output;
}

/**
 * Every rewrite formatter output gets before the reader sees it: readable struct names, then
 * nullable values (`Opt { value: [] }` → `nil`, `Opt { value: [70] }` → `70`). The one door for
 * anything that reaches the DOM.
 */
export function readableOutput(output: string): string {
  return readableNullables(readableStructNames(output));
}

/**
 * Run `code` in `context` and return its rendered result. The single funnel every evaluating
 * surface goes through, so all of them get the same three guarantees: the wasm-side result object
 * is freed rather than leaked, generated struct names are made readable, and a Rust panic becomes
 * an error result plus a scheduled restart instead of an exception thrown into a render pass.
 *
 * A panic leaves `context` unusable — the caller should stop using it, as the restart will not free
 * it for them.
 */
export function interpret(context: Numbat, code: string): NumbatResult {
  try {
    const output = context.interpret(code);
    const result: NumbatResult = { output: readableOutput(output.output), isError: output.is_error };
    output.free();
    return result;
  } catch (error) {
    restartNumbat();
    return { output: escapeHtml(`Numbat crashed and will restart: ${describeError(error)}`), isError: true };
  }
}

// UNICODE INPUT COMPLETION
// ================================================================================================

/**
 * A pending LaTeX-style Unicode expansion returned by {@link getUnicodeCompletion}: the matched
 * `\code` occupies the final `replaceLength` characters of the queried text and expands to
 * `replacement` (e.g. `\alpha` → `α`, with `replaceLength` 6).
 */
export interface UnicodeCompletion {
  /** Length of the matched `\code`, including the leading backslash, in chars. */
  replaceLength: number;

  /** The Unicode text the `\code` expands to. */
  replacement: string;
}

/**
 * Lazily create the context used solely for Unicode-completion lookups. It needs no prelude or
 * exchange rates — `get_unicode_completion` consults a static `\code` table independent of
 * interpreter state — and is reused across calls; a wasm restart discards it (see {@link
 * ensureNumbatReady}).
 */
function ensureCompletionContext(): Numbat | null {
  if (completionContext === null) {
    try {
      // No prelude and no pretty-printing: `get_unicode_completion` reads a static `\code` table,
      // so neither affects the result and skipping the prelude keeps context creation cheap.
      completionContext = Numbat.new(false, false, FormatType.Html);
    } catch (error) {
      console.error("Symbat: could not create the completion context", error);
      restartNumbat();
    }
  }
  return completionContext;
}

/**
 * Warm up the wasm module and the completion context in the background so the first Unicode
 * expansion resolves without a wait. Idempotent and cheap to call repeatedly (e.g. whenever the
 * cursor enters a numbat scope).
 */
export function primeUnicodeCompletion(): void {
  if (wasmReady) {
    ensureCompletionContext();
    return;
  }

  void ensureNumbatReady()
    .then(() => {
      ensureCompletionContext();
    })
    .catch((error) => {
      console.error("Symbat: could not initialize Unicode completion", error);
    });
}

/**
 * Look up the Unicode expansion for text ending at the cursor via the interpreter's
 * `get_unicode_completion`. Returns the replacement when the text ends with a known code introduced
 * by `leader`, or `null` when nothing matches.
 *
 * The wasm's completion is LaTeX-based (a `\code`). For the default `\` leader the text is passed
 * straight through, so behavior is unchanged. For a custom leader the code name is looked up under
 * a synthetic backslash and the match length is re-expanded to cover the actual leader
 * (`get_unicode_completion`'s length counts the one-character backslash, so it grows by
 * `leader.length - 1`).
 *
 * This runs inside synchronous editor input handling, so it never initializes the wasm itself:
 * until {@link primeUnicodeCompletion} (or another use) has readied the module it simply reports no
 * match. A crash drops the poisoned context and schedules a restart, mirroring {@link interpret}.
 */
export function getUnicodeCompletion(textBeforeCursor: string, leader: string): UnicodeCompletion | null {
  if (!wasmReady) {
    return null;
  }

  const context = ensureCompletionContext();
  if (context === null) {
    return null;
  }

  let query = textBeforeCursor;
  let leaderAdjust = 0;
  if (leader !== "\\") {
    const name = unicodePrefixAt(textBeforeCursor, leader);
    if (name === null) {
      return null;
    }
    query = "\\" + name;
    leaderAdjust = leader.length - 1;
  }

  try {
    // `get_unicode_completion` returns `[replaceLength, replacement]` on a match and `[]` otherwise
    // (a `Vec<JsValue>` marshalled to a JS array).
    const result = context.get_unicode_completion(query);
    if (!Array.isArray(result) || result.length !== 2) {
      return null;
    }

    const replaceLength = Number(result[0]) + leaderAdjust;
    const replacement = String(result[1]);
    if (!Number.isInteger(replaceLength) || replaceLength <= 0 || replacement === "") {
      return null;
    }

    return { replaceLength, replacement };
  } catch (error) {
    console.error("Symbat: unicode completion crashed", error);
    dropCompletionState();
    return null;
  }
}

/**
 * Discard the completion context and the cached code list after a crash, and schedule a wasm
 * restart. The next lookup rebuilds them on the fresh instance.
 */
function dropCompletionState(): void {
  freeQuietly(completionContext);
  completionContext = null;
  unicodeCodeList = null;
  restartNumbat();
}

/**
 * The full set of `\code` completions, built once and cached. Numbat exposes no dump of its Unicode
 * table, so the list is derived from the interpreter's completion vocabulary
 * (`get_completions_for("")`) filtered down to the entries that resolve as codes via {@link
 * getUnicodeCompletion} — which also yields each glyph. The result is static (independent of
 * prelude and user state), so it is cached until a wasm restart. Empty until the module is ready.
 */
function ensureUnicodeCodeList(): UnicodeCode[] {
  if (unicodeCodeList !== null) {
    return unicodeCodeList;
  }

  if (!wasmReady) {
    return [];
  }

  const context = ensureCompletionContext();
  if (context === null) {
    return [];
  }

  try {
    const names = context.get_completions_for("").map((value) => String(value));
    unicodeCodeList = buildUnicodeCodeList(names, (code) => {
      const result = context.get_unicode_completion(code);
      return Array.isArray(result) && result.length === 2 ? String(result[1]) : null;
    });
    return unicodeCodeList;
  } catch (error) {
    console.error("Symbat: could not build the unicode code list", error);
    dropCompletionState();
    return [];
  }
}

/**
 * The `\code` completions whose name starts with `prefix` (the text after the backslash, e.g.
 * `"al"` → `\alpha`), for the completion popover. Returns an empty list when the wasm module is not
 * ready yet.
 */
export function listUnicodeCompletions(prefix: string): UnicodeCode[] {
  return codesMatching(ensureUnicodeCodeList(), prefix);
}

// EXPRESSION COMPLETION
// ================================================================================================

/**
 * The shared interpreter context used for expression completion while editing `numbat` code blocks.
 * It is created lazily with the full prelude (and the user prelude / exchange rates, exactly like a
 * rendered block) and reused across keystrokes, so completions reflect the loaded standard library
 * and any personal prelude. Discarded on a wasm restart or when the prelude changes (see {@link
 * invalidateExpressionCompletion}). Returns `null` if the wasm is not ready yet or context creation
 * fails — the caller primes it via {@link ensureNumbatReady}.
 *
 * The REPL does not use this context; it completes against its own live session context, so
 * REPL-defined names complete too.
 */
export function ensureExpressionContext(applyRates: boolean): Numbat | null {
  if (!wasmReady) {
    return null;
  }

  if (expressionContext === null) {
    try {
      expressionContext = createContext(applyRates);
    } catch (error) {
      console.error("Symbat: could not create the expression completion context", error);
      restartNumbat();
      return null;
    }
  }

  return expressionContext;
}

/**
 * Discard the shared expression-completion context and its cached vocabulary, so the next
 * completion rebuilds them. Called when the prelude or exchange-rate settings change (the cached
 * context would otherwise hold a stale prelude).
 */
export function invalidateExpressionCompletion(): void {
  contextEpoch += 1;
  freeQuietly(expressionContext);
  expressionContext = null;
  expressionVocab = null;
  freeQuietly(blockContext);
  blockContext = null;
  blockVocab = null;
  blockKey = null;
}

// Per-context cache of `type(<name>)` signatures for the completion popover (see
// `completionSignature`). Keyed by the interpreter context, so a name resolves to the right type in
// each one (a block context, the REPL session) rather than colliding by name — and it is released
// with the context: a rebuilt context is a fresh object with an empty cache. `null` caches "no
// signature" (a keyword/dimension/type, for which `type(…)` errors) so it is not retried on every
// render.
const signatureCaches = new WeakMap<Numbat, Map<string, string | null>>();

/**
 * The inline signature for `name` — the HTML from `type(<name>)`, e.g. `forall A: Dim. Fn[(A) ->
 * A]` for a function, `Scalar`/`Length` for a variable/unit — or `null` when it has none (a
 * keyword/dimension/type, or on error). Computed on (and cached against) the completer's `context`,
 * so user-defined names resolve.
 */
export function completionSignature(context: Numbat, name: string): string | null {
  let cache = signatureCaches.get(context);
  if (cache === undefined) {
    cache = new Map();
    signatureCaches.set(context, cache);
  }

  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }

  // `interpret` traps wasm panics and returns an error result; `type(…)` of a
  // keyword/dimension/type is a normal (non-panic) error, yielding no signature.
  const result = interpret(context, `type(${name})`);
  const signature = result.isError ? null : signatureFromTypeOutput(result.output);
  cache.set(name, signature);

  return signature;
}

/** A field name no note or prelude will ever define, so accessing it on a struct reliably produces
 *  the "field does not exist" diagnostic that names the struct's actual fields (see {@link
 *  structFieldNames}). */
const FIELD_PROBE = "_numbat_member_probe";

/**
 * The field names of the struct `base` evaluates to, in declaration order — or an empty list when
 * it is not a struct, does not evaluate, or Numbat has reworded its diagnostic. Costs one
 * `interpret` on the completer's own context, which is already built by the time this is asked.
 *
 * Numbat exposes no other route: `get_completions_for("costs.")` returns nothing and `print_info`
 * on a struct type is "Not found", but a missing-field error spells the whole struct out.
 */
export function structFields(context: Numbat, base: string): string[] {
  const result = interpret(context, `${base}.${FIELD_PROBE}`);
  return result.isError ? structFieldNames(plainText(result.output)) : [];
}

/**
 * The full documentation for `name` for the dwell popup — parsed from `print_info(<name>)` into its
 * body HTML and reference URL — or `null` when there is nothing to show. Not cached: it is only
 * called when a completion has been hovered/selected for a moment.
 *
 * A **type** falls through to the plugin's own table (completion/expressions.ts): `print_info`
 * answers `Not found` for `List` and `Bool` as readily as for a word it has never heard, so without
 * this a type name is the one thing in the language that hovers to nothing. The interpreter is
 * asked first and kept if it answers, so a reader's own `let List = 5` still describes itself.
 *
 * Every surface that opens a card goes through here — the hover popup, the editor completer, the
 * REPL and property-field completer — so all four learn about types at once.
 */
export function completionInfo(context: Numbat, name: string): CompletionInfo | null {
  try {
    const raw = context.print_info(name);

    // `print_info` bypasses `interpret`, so it needs the same rewrite: a nested property's docs
    // would otherwise show the raw generated type name.
    return completionCard(typeof raw === "string" ? readableOutput(raw) : null, name);
  } catch (error) {
    console.error("Symbat: print_info crashed", error);
    restartNumbat();
    return null;
  }
}

// The pending idle-release timer (see `touchCompletionIdle`). Held at module scope so any
// completion resets it and `disposeCompletionContexts` can cancel it.
let idleTimer: number | null = null;

/**
 * Keep the completion contexts warm while they are in active use, but release the prelude-loaded
 * ones after `timeoutMs` with no completion — reclaiming the memory a large replayed block context
 * can hold in the background. Called on each completion to (re)arm the timer; when it fires it
 * frees the expression and block contexts (they rebuild on next use, ~70 ms). A non-positive
 * `timeoutMs` disables the release, keeping the contexts loaded indefinitely.
 */
export function touchCompletionIdle(timeoutMs: number): void {
  if (idleTimer !== null) {
    window.clearTimeout(idleTimer);
    idleTimer = null;
  }

  if (timeoutMs <= 0) {
    return;
  }

  idleTimer = window.setTimeout(() => {
    idleTimer = null;
    invalidateExpressionCompletion();
  }, timeoutMs);
}

/**
 * Release every cached completion context — the unicode, expression, and block contexts — and
 * cancel the idle timer. For plugin unload, so the wasm allocations they hold are not left
 * dangling. (The REPL frees its own context on view close, and code-block render contexts are freed
 * per render.)
 */
export function disposeCompletionContexts(): void {
  if (idleTimer !== null) {
    window.clearTimeout(idleTimer);
    idleTimer = null;
  }

  freeQuietly(completionContext);
  completionContext = null;
  unicodeCodeList = null;
  invalidateExpressionCompletion();
}

/**
 * A completion context (and its vocabulary) that reflects the code the user has already written
 * above the cursor in a code block: `chunks` are replayed on top of the prelude, in order — for a
 * `numbat` block, just that block's body-so-far; for a `numbat-shared` block, the preceding shared
 * blocks followed by this block's body-so-far. Each chunk is interpreted independently and errors
 * are ignored, so a half-written statement does not wipe the definitions that parsed.
 *
 * Building a prelude context costs ~70 ms (the whole standard library reloads), whereas replaying
 * the chunks and re-listing the vocabulary is cheap, so the result is cached against `chunks` (and
 * `applyRates`): typing within a line reuses it, and only moving to a new line (or editing the code
 * above) rebuilds. When there is nothing to replay it falls back to the shared prelude-only
 * context, so an empty block stays on the fast path. Returns `null` if the wasm is not ready.
 *
 * `options.preludeBefore` is passed through to {@link createContext} (and folded into the cache
 * key) for the `.nbt` editor, whose file may itself be part of the prelude. It also bypasses the
 * empty-chunk fast path, since the shared prelude-only context is built with the *whole* prelude.
 */
export function ensureBlockCompletion(
  chunks: readonly string[],
  applyRates: boolean,
  options: { preludeBefore?: string; } = {},
): { context: Numbat; vocab: CompletionVocabulary; } | null {
  if (!wasmReady) {
    return null;
  }

  const { preludeBefore } = options;
  const nonEmpty = chunks.filter((chunk) => chunk.trim() !== "");
  if (nonEmpty.length === 0 && preludeBefore === undefined) {
    const context = ensureExpressionContext(applyRates);
    const vocab = getExpressionVocabulary();
    return context !== null && vocab !== null ? { context, vocab } : null;
  }

  // A NUL never occurs in a text document, so it is a safe key/chunk separator.
  const key = `${applyRates ? "1" : "0"}\u0000${preludeBefore ?? ""}\u0000${nonEmpty.join("\u0000")}`;
  if (blockContext !== null && blockVocab !== null && blockKey === key) {
    return { context: blockContext, vocab: blockVocab };
  }

  freeQuietly(blockContext);
  blockContext = null;
  blockVocab = null;
  blockKey = null;

  try {
    const context = createContext(applyRates, options);
    for (const chunk of nonEmpty) {
      // interpret() absorbs errors (and wasm panics, scheduling a restart); the definitions from
      // chunks that did parse remain in the context.
      interpret(context, chunk);
    }

    const vocab = buildCompletionVocabulary(context);
    if (vocab === null) {
      freeQuietly(context);
      return null;
    }

    blockContext = context;
    blockVocab = vocab;
    blockKey = key;
    return { context, vocab };
  } catch (error) {
    console.error("Symbat: could not build the block completion context", error);
    restartNumbat();
    return null;
  }
}

/**
 * The completion candidates for `query` from `context`, via the wasm's `get_completions_for` — a
 * flat, prefix-filtered, sorted list mixing keywords, `\code` patterns, variables, functions,
 * dimensions and units (categorized by {@link
 * import("../completion/expressions").expressionCompletions}). Empty when the wasm is not ready; a
 * crash drops the context and schedules a restart.
 *
 * The plugin's own type names are appended, since the engine does not know them (see {@link
 * import("../completion/expressions").pluginTypeCandidates}). After the engine's own, so a name it
 * offers keeps the position its sorting gave it; a duplicate is dropped downstream.
 *
 * The one funnel all four completing surfaces draw from — the editor, the REPL, the `.nbt` view and
 * the property field — so they offer the same names without four copies of this.
 */
export function expressionCompletionCandidates(context: Numbat, query: string): string[] {
  if (!wasmReady) {
    return [];
  }

  try {
    const engine = context.get_completions_for(query).map((value) => String(value));
    return [...engine, ...pluginTypeCandidates(query)];
  } catch (error) {
    console.error("Symbat: expression completion crashed", error);
    invalidateExpressionCompletion();
    restartNumbat();
    return [];
  }
}

/** Run a `list <what>` command and return the names it lists (freeing the wasm result). Functions
 *  and variables share a CSS class, so they are read from separate commands rather than
 *  distinguished by class. */
function listNames(context: Numbat, what: "functions" | "units" | "variables" | "dimensions"): string[] {
  const command = context.try_run_command(`list ${what}`);
  const output = command.output;
  command.free();
  return parseListNames(output);
}

/**
 * Build the categorized completion vocabulary for `context` from its `list` commands — one each for
 * functions, units, variables, and dimensions, so functions and variables (which share a display
 * class) stay distinct. Returns `null` on failure. The REPL calls this directly for its live
 * context (caching the result itself and refreshing it after each evaluation); the shared
 * code-block context is cached here (see {@link getExpressionVocabulary}).
 */
export function buildCompletionVocabulary(context: Numbat): CompletionVocabulary | null {
  try {
    const vocab: CompletionVocabulary = {
      functions: new Set(listNames(context, "functions")),
      units: new Set(listNames(context, "units")),
      variables: new Set(listNames(context, "variables")),
      dimensions: new Set(listNames(context, "dimensions")),
    };

    // This context may be a block's or the REPL session's, so its dimensions/units include
    // user-defined ones; feed them to highlighting (re-highlights on change).
    recordSemanticNames(vocab.dimensions, vocab.units);
    return vocab;
  } catch (error) {
    console.error("Symbat: could not build the completion vocabulary", error);
    invalidateExpressionCompletion();
    restartNumbat();
    return null;
  }
}

/**
 * The cached categorized vocabulary for the shared code-block completion context, built on first
 * use and kept until the context is invalidated. Returns `null` before {@link
 * ensureExpressionContext} has created the context.
 */
export function getExpressionVocabulary(): CompletionVocabulary | null {
  if (expressionContext === null) {
    return null;
  }
  if (expressionVocab === null) {
    expressionVocab = buildCompletionVocabulary(expressionContext);
  }
  return expressionVocab;
}

// SEMANTIC NAMES (FOR SYNTAX HIGHLIGHTING)
// ================================================================================================

// Whether the standard-library / prelude dimension and unit names have been read into
// syntax/type-names.ts, and whether a background read is in flight. User-defined names
// (block-local, REPL session) are merged in separately, as the completion vocabulary turns them up
// (see buildCompletionVocabulary). The name sets, and the read side the tokenizer uses, live in
// syntax/type-names.ts (wasm-free).
let preludeSemanticsCaptured = false;
let capturingSemanticNames = false;

/**
 * Read the prelude's dimension and unit names into syntax/type-names.ts so the editor highlights
 * them distinctly. Only for the case where no context exists yet (a numbat block viewed in pure
 * source mode, with nothing rendered): it builds a throwaway prelude context in the background,
 * whose creation captures the names (see createContext). A render, REPL, or completion captures
 * them without this.
 */
export function primeSemanticNames(): void {
  if (preludeSemanticsCaptured || capturingSemanticNames) {
    return;
  }

  capturingSemanticNames = true;
  void ensureNumbatReady()
    .then(() => {
      try {
        if (!preludeSemanticsCaptured) {
          freeQuietly(createContext(false));
        }
      } catch (error) {
        console.error("Symbat: could not capture semantic names", error);
        restartNumbat();
      } finally {
        capturingSemanticNames = false;
      }
    })
    .catch((error) => {
      capturingSemanticNames = false;
      console.error("Symbat: could not initialize semantic-name capture", error);
    });
}

/**
 * Read the prelude's dimension and unit names from `context` into syntax/type-names.ts, once.
 * Called from {@link createContext} so the first prelude context anywhere — a rendered block, the
 * REPL, a completion — seeds the standard library and custom prelude names; user-defined names are
 * picked up later from the completion vocabulary. Records through {@link recordSemanticNames},
 * which re-highlights any open editors when the names are new.
 */
function captureSemanticNamesFrom(context: Numbat): void {
  if (preludeSemanticsCaptured) {
    return;
  }

  try {
    recordSemanticNames(listNames(context, "dimensions"), listNames(context, "units"));
    preludeSemanticsCaptured = true;
  } catch (error) {
    console.error("Symbat: could not capture semantic names", error);
  }
}
