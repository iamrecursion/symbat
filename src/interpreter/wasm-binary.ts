// The one module in the plugin that imports the Numbat WebAssembly module.
//
// esbuild inlines it as a base64 string literal (see src/wasm.d.ts): 2.5 MB of a 2.9 MB bundle. A
// second importer is a second inlined copy meaning `main.js` roughly doubles, and nothing else in
// the build says so.
//
// It is deliberately *not* the module that instantiates: `worker/engine.ts` owns the bindings, and
// the two are separated so the engine stays loadable outside a bundle. That is what lets the
// integration suite drive worker-side code against the real interpreter.

import wasmBase64 from "../wasm/pkg/numbat_wasm_bg.wasm";

/**
 * The inlined module, base64-encoded, exactly as esbuild wrote it into the bundle.
 *
 * Handed across the boundary as the literal rather than decoded first, and that is the whole reason
 * this module holds nothing else. The decode is the expensive half — 2.5 million characters — and
 * the side that instantiates is the side that should pay for it. It is also why the engine takes
 * base64 rather than bytes: a decoder over here would have to be imported over there.
 */
export const WASM_BASE64: string = wasmBase64;
