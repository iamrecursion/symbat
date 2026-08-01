// Pins the real Numbat wasm behavior that decides how refreshed exchange rates reach the
// interpreter (see interpreter/numbat.ts's `exchangeRatesApplied` and `loadExchangeRates`).
//
// Numbat stores rates in a `static EXCHANGE_RATES: OnceLock<…>` and its setter is
// `EXCHANGE_RATES.set(…).unwrap()` — so `set_exchange_rates` is a set-*once* operation per wasm
// instance, and calling it twice panics on the Rust side. That is why the plugin tracks whether it
// has applied them, and why replacing the rates mid-session means restarting the instance rather
// than setting them again.
//
// If a wasm bump ever made the setter idempotent, the restart would become unnecessary rather than
// load-bearing, and this test would say so.
//
// Requires the wasm to be built; self-skips otherwise.

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadNumbat, skip } from "../wasm-pkg.ts";

/** A minimal ECB reference-rate document, with one rate we can assert on. */
function ratesXml(usdPerEur: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01"
                 xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube><Cube time="2026-01-01">
    <Cube currency="USD" rate="${usdPerEur}"/>
  </Cube></Cube>
</gesmes:Envelope>`;
}

test("applying exchange rates twice to one instance panics", { skip }, async () => {
  const mod = await loadNumbat();
  const first = mod.Numbat.new(true, true, mod.FormatType.Html);
  first.set_exchange_rates(ratesXml("2.0"));
  first.free();

  // A *different* context on the same wasm instance: the store is a process global, so the second
  // set is what fails, not the second context.
  const second = mod.Numbat.new(true, true, mod.FormatType.Html);
  assert.throws(
    () => second.set_exchange_rates(ratesXml("3.0")),
    "set_exchange_rates is set-once per instance; the plugin must restart to replace rates",
  );
  // The wasm has panicked, so this instance is finished — as it would be in the plugin, where the
  // catch in `createContext` schedules a restart. Nothing else may share it, which is why this
  // assertion lives in a file of its own: the test runner gives each file its own process, and
  // `loadNumbat` caches the instance within one. Adding another test to this file would run it
  // against a dead heap.
});
