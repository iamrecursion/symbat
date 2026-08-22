// Ambient declaration for the virtual module the build injects the worker bundle through (see
// esbuild.config.mjs).
//
// A virtual module rather than `define`, which would need a `declare const` and a 70 KB string
// literal sitting in a build-options object, and rather than `banner`, which cannot be referenced
// as a value at all. This way the worker's source is an ordinary import with an ordinary type, with
// its unusual esbuild origin stated here.
declare module "symbat:worker-source" {
  /** The worker bundle, as a self-contained classic script. */
  const source: string;
  export default source;
}
