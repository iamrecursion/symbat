// Ambient declaration for the esbuild `base64` loader: importing a `.wasm` file yields its bytes
// base64-encoded, as a string literal inlined into the bundle at build time.
//
// Deliberately *not* the `binary` loader, which would be the obvious choice. `binary` emits the
// same base64 literal wrapped in esbuild's `__toBinary` helper — a hand-rolled per-character
// decoder — and assigns the result to a top-level `var`. That makes decoding the 1.9 MB module a
// 2.5 million-iteration loop that runs the moment Obsidian `require()`s the plugin, on the main
// thread, before `onload` returns, whether or not the interpreter is ever used. Handing over the
// string instead lets `ensureNumbatReady()` decode it lazily, with the platform's own `atob`.
declare module "*.wasm" {
  const base64: string;
  export default base64;
}
