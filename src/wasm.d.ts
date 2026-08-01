// Ambient declaration for the esbuild `binary` loader: importing a `.wasm` file yields its bytes as
// a Uint8Array (inlined into the bundle at build time).
declare module "*.wasm" {
  const bytes: Uint8Array;
  export default bytes;
}
