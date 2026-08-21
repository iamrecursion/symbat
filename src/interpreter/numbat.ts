// The plugin's face on the interpreter: the two things only the main thread can do, and the names
// the rest of the plugin knows the interpreter by.
//
// After the seam, almost nothing is left here. Evaluation happens behind `interpreter/host.ts`,
// which puts a request to `interpreter/worker/*`, which is the only code that touches the wasm.
// What stays is what genuinely cannot move:
//
//   * **The exchange rates**, because they arrive over `requestUrl`, which is Obsidian's and is
//     main-thread-only. The XML is fetched here and posted; the interpreter never makes a request.
//   * **The user prelude**, because the files come from the vault. The parts are held here, posted
//     as part of the environment, and scanned once per change for whether they read the clock.
//
// Everything else is a re-export, and deliberately so: thirty modules say `from
// "../interpreter/numbat"` and none of them cares which side of a boundary the answer comes from.
// That is the façade earning its place rather than an indirection nobody removed.

import { requestUrl } from "obsidian";
import type { PreludePart } from "../settings/util";
import { forgetSemanticNames } from "../syntax/type-names";
import {
  allowInterpreterSpawn,
  ask,
  describeInterpreterPath,
  disposeInterpreter,
  ensureInterpreter,
  interpreterCanBeStopped,
  interpreterProblem,
  interpreterReady,
  invalidateCachedEvaluations,
  refillEvaluationBudget,
  releaseInterpreterContexts,
  restartInterpreter,
  setInterpreterEnv,
  setInterpreterThread,
  stopEvaluations,
  touchInterpreterIdle,
  watchInterpreter,
} from "./host";
import { readsClockOrRandom } from "./purity";

export { interpreterGeneration } from "./host";
export type { NumbatResult } from "./protocol";
export { describeError } from "./protocol";
export {
  allowInterpreterSpawn,
  ask,
  describeInterpreterPath,
  disposeInterpreter,
  ensureInterpreter as ensureNumbatReady,
  interpreterCanBeStopped,
  interpreterProblem,
  interpreterReady as isNumbatReady,
  invalidateCachedEvaluations,
  refillEvaluationBudget,
  releaseInterpreterContexts,
  restartInterpreter as restartNumbat,
  setInterpreterThread,
  stopEvaluations,
  touchInterpreterIdle as touchCompletionIdle,
  watchInterpreter,
};
export type { PreludePart };

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
      // The environment goes across before the generation moves, so that nothing can read the new
      // generation and be answered out of the old environment. Replacing rates on an instance that
      // has already applied some means replacing the instance; the host is told, and works out that
      // it needs a fresh one.
      publishEnvironment();
      invalidateCachedEvaluations();
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
    publishEnvironment();
    invalidateCachedEvaluations();
  }
}

/** Drop any cached exchange rates (e.g. when the setting is turned off). */
export function clearExchangeRates(): void {
  const had = exchangeRatesXml !== null;
  exchangeRatesXml = null;
  exchangeRatesFetchedAt = 0;

  if (had) {
    publishEnvironment();
    invalidateCachedEvaluations();
  }
}

// USER PRELUDE (OPT-IN)
// ================================================================================================

// The user's personal prelude (see `setUserPrelude`), one entry per configured `.nbt` file in load
// order, replayed into every new context. Empty when no prelude is configured. Kept per file rather
// than pre-joined so a context can be built with only the files loaded *before* a given one, which
// is what the file itself sees when the prelude loads.
let userPreludeParts: PreludePart[] = [];

// Whether that prelude reads the clock or the RNG (interpreter/purity.ts) — decided here, once per
// prelude change, because a prelude can be a personal library and the alternative is scanning the
// whole of it on every note pass.
let userPreludeImpure = false;

/**
 * Set the personal prelude replayed into every new interpreter context, or clear it. Parts are
 * given in load order; whitespace-only ones are dropped, and an empty list (or `null`) disables the
 * prelude.
 *
 * Each part's source is applied verbatim when a context is built; the plugin caches the file
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
    userPreludeImpure = next.some((part) => readsClockOrRandom(part.source));

    // The prelude can declare — or stop declaring — units and dimensions, so the captured names are
    // re-enumerated from the next context rather than kept.
    forgetSemanticNames();
    publishEnvironment();
    invalidateCachedEvaluations();
  }
}

/**
 * Whether the personal prelude puts an impure name into every context's scope.
 *
 * A prelude that defines `fn t() = now()` makes a note reading `t()` clock-dependent without the
 * note writing an impure token anywhere. Consulted by the evaluation caches to decide what may be
 * cached forever; see `impureBindings` (interpreter/purity.ts) for why they take the answer rather
 * than the text.
 *
 * `false` while no prelude is configured, and re-decided whenever {@link setUserPrelude} sees the
 * parts actually change — the same moment that bumps the generation, so nothing can be holding a
 * cached answer from the previous belief.
 */
export function preludeReadsClockOrRandom(): boolean {
  return userPreludeImpure;
}

/** Hand the interpreter everything it cannot find out for itself. Called from each of the four
 *  places that can change it, rather than assembled at the point of use, so the two halves of the
 *  environment can never be posted separately. */
function publishEnvironment(): void {
  setInterpreterEnv({ ratesXml: exchangeRatesXml, prelude: userPreludeParts });
}

// STARTING THE INTERPRETER FOR ITS SIDE EFFECT
// ================================================================================================

// Whether a background context build is in flight, so a burst of editors opening asks once.
let warming = false;

/**
 * Read the prelude's dimension and unit names into syntax/type-names.ts so the editor highlights
 * them distinctly.
 *
 * Only for the case where no context exists yet and none is about to: a `numbat` block viewed in
 * pure source mode, with nothing rendered. A render, a REPL or a completion enumerates the names on
 * the way past, because every reply carries whatever its work turned up.
 */
export function primeSemanticNames(): void {
  if (warming) {
    return;
  }

  warming = true;
  void ensureNumbatReadyThen(() => ask("warm", { applyRates: false }, { priority: "background" }))
    .catch((error: unknown) => {
      console.error("Symbat: could not initialize semantic-name capture", error);
    })
    .finally(() => {
      warming = false;
    });
}

/**
 * What the context pool has done this session, as one line for the settings' debug info.
 *
 * The counters are where the interpreter is, so since the worker is not where the settings tab
 * is we have to ask. An interpreter that never started has nothing to report and says so, which is
 * a more useful line in a bug report than a row of zeroes.
 */
export async function poolReport(): Promise<string> {
  const counts = await ensureNumbatReadyThen(() => ask("poolStats", {}, { priority: "interactive" }));
  if (counts === null) {
    return "Contexts: the interpreter has not run";
  }

  const asked = counts.hits + counts.misses + counts.refused;
  const share = asked === 0 ? 0 : Math.round((counts.hits / asked) * 100);
  return `Contexts: ${String(asked)} asked, ${String(share)}% reused; ${String(counts.misses)} built, `
    + `${String(counts.refused)} could read the last result; ${String(counts.recycled)} kept, `
    + `${String(counts.freed)} released`;
}

/** Start the interpreter and then do `then`, as a single promise the caller can attach to. */
async function ensureNumbatReadyThen<T>(then: () => Promise<T>): Promise<T | null> {
  await ensureInterpreter();
  return interpreterReady() ? then() : null;
}
