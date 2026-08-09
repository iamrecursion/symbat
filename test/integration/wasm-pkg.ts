// Locates and instantiates the generated Numbat wasm bindings for the integration suite.
//
// The bindings are build output (`make wasm`), not source, so `make test-unit` never needs them and
// every integration file self-skips when they are absent. That is a convenience locally and a
// hazard in CI, where a suite that skipped every test is indistinguishable from one that passed —
// so under `CI` their absence is a hard error at module load instead.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NULLABLE_PRELUDE } from "../../src/interpreter/nullable.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "../../src/wasm/pkg");
const pkgJs = resolve(pkgDir, "numbat_wasm.js");
const pkgWasm = resolve(pkgDir, "numbat_wasm_bg.wasm");

// Checking both files also catches a half-written output directory, which a single existence check
// would report as built.
const built = existsSync(pkgJs) && existsSync(pkgWasm);

if (!built && process.env.CI) {
  throw new Error(
    `The Numbat wasm bindings are missing from ${pkgDir}, so every integration test would skip `
      + "and the suite would pass without exercising the interpreter. Run `make wasm` first.",
  );
}

/**
 * Pass as node:test's `skip` option — `false` to run, or the reason to skip.
 */
export const skip = built ? false : "wasm not built (run `make wasm`)";

/**
 * Imports the bindings and instantiates the wasm module, returning the module namespace.
 * wasm-bindgen caches the instance, so repeated calls are cheap and every caller shares one
 * interpreter — which is what the plugin does too.
 */
export async function loadNumbat(): Promise<any> {
  // eslint-disable-next-line no-unsanitized/method -- the rule guards HTML sinks and misreads a dynamic import() as one; the specifier is a path this module computed, not input
  const mod: any = await import(pathToFileURL(pkgJs).href);
  await mod.default({ module_or_path: readFileSync(pkgWasm) });
  mod.setup_panic_hook();
  return mod;
}

/**
 * A prelude-loaded context with the nullable vocabulary applied — what `createContext`
 * (interpreter/numbat.ts) builds, for the tests that need a context rather than a bare instance.
 *
 * Without this a test would hand-roll `Numbat.new` and get a context the plugin never creates: one
 * where the bindings a note's frontmatter emits do not type, because nothing has defined the struct
 * they are written with. The tests that deliberately want a bare instance (exchange rates, crash
 * recovery) call `Numbat.new` themselves.
 */
export function newContext(mod: any): any {
  const context = mod.Numbat.new(true, true, mod.FormatType.Html);
  context.interpret(NULLABLE_PRELUDE).free();
  return context;
}

/**
 * Rebuilds the wasm instance after `__numbat_reset()`, mirroring how the plugin recovers from a
 * Rust panic. Only the crash-recovery test needs this.
 */
export async function reinitNumbat(mod: any): Promise<void> {
  await mod.default({ module_or_path: readFileSync(pkgWasm) });
  mod.setup_panic_hook();
}
