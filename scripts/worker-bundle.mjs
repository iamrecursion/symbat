// Building the interpreter's worker bundle: the second esbuild pass, its two guards, and the budget
// the result has to fit in.
//
// A module of its own rather than a section of esbuild.config.mjs, because the integration suite
// builds the same bundle and runs it in a `node:worker_threads` worker. That test is the only thing
// in the repo that executes worker code at all, and it would be worth very little if it built the
// bundle a different way from the plugin.

import esbuild from "esbuild";
import { builtinModules } from "node:module";

/**
 * The host packages the plugin is compiled against rather than bundled with. Obsidian provides all
 * of them at runtime, which is exactly why the worker may import none of them: over there nothing
 * provides anything.
 */
export const HOST_PACKAGES = [
  "obsidian",
  "electron",
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
];

// The worker is a *classic* script, not a module, and must stay one. A classic `Worker` cannot load
// ESM, and module workers constructed from blob URLs are the least portable thing available. So:
// `format: "iife"`, and if that ever looks like the awkward choice, read this comment before
// changing it.
//
// `external` is empty and must stay empty. An external in an iife bundle becomes a bare `require()`
// that throws the moment the worker loads, and the failure looks exactly like a platform that does
// not support workers.
const WORKER_ENTRY = "src/interpreter/worker/boot.ts";

/**
 * A second inlined copy of the 1.9 MB module would take `main.js` from ~2.9 MB to ~5.5 MB, and
 * nothing else in the build would say so. The worker is handed the base64 at `init` instead.
 */
export const forbidWasmBinary = {
  name: "forbid-wasm-binary",
  setup(build) {
    build.onResolve({ filter: /\.wasm$/ }, (args) => ({
      errors: [{
        text: `The worker bundle must not import the wasm binary (${args.path}).`,
        notes: [{
          text: "It would inline a second 2.5 MB base64 copy into main.js. The module is posted to "
            + "the worker in the `init` message instead; see src/interpreter/wasm-binary.ts.",
        }],
      }],
    }));
  },
};

/**
 * A stray `import { Notice } from "obsidian"` yields a worker that throws on load, and a host that
 * falls back silently and forever. ESLint says so too; this is the half that survives someone
 * running the build without it.
 */
export const forbidHostImports = {
  name: "forbid-host-imports",
  setup(build) {
    const forbidden = new Set([...HOST_PACKAGES, ...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
    // Bare specifiers only. `/.*/` would work too, at the cost of routing every relative import in
    // the worker's graph through a JS callback for a set that can only ever contain package names.
    build.onResolve({ filter: /^(?:node:)?[^./]/ }, (args) => {
      if (!forbidden.has(args.path)) {
        return undefined;
      }
      return {
        errors: [{
          text: `The worker bundle must not import "${args.path}".`,
          notes: [{
            text: "Nothing provides it inside a Worker, so the whole worker throws on load and the "
              + "plugin falls back to the main thread silently. Move whatever needs it to the "
              + "asking side of the seam (src/interpreter/host.ts and above).",
          }],
        }],
      };
    });
  },
};

/**
 * Build the worker and return its source, plus the files it was built from.
 *
 * The second return value is what `watchFiles` needs: the worker's sources are not in `main.js`'s
 * dependency graph, so without it `make dev` serves whatever worker existed when the watcher
 * started. You would edit worker code, reload, see no change, and conclude the worker was broken.
 */
export async function buildWorker(minify = false) {
  const result = await esbuild.build({
    entryPoints: [WORKER_ENTRY],
    bundle: true,
    external: [],
    format: "iife",
    // One step below the main bundle's es2021, and deliberately: the one public report of
    // wasm-in-a-worker failing inside Obsidian was fixed by dropping to es2020. Free insurance on
    // the platform this repo cannot test.
    target: "es2020",
    platform: "browser",
    write: false,
    metafile: true,
    logLevel: "silent",
    treeShaking: true,
    minify,
    // Off in both modes. An inline map would be a map inside a string inside main.js's own map,
    // which no tool reads; the `sourceURL` footer below is what actually makes the worker findable.
    sourcemap: false,
    // Deliberately NOT `charset: "utf8"`. esbuild's default escapes non-ASCII, which is what keeps
    // the `data:` URL rung of the spawn ladder small and, more to the point, encodable at all.
    //
    // `numbat_wasm.js`'s async initializer resolves the module next to itself when it is not handed
    // one. It never is handed nothing here, so the branch is dead — but `import.meta` does not
    // exist in an iife, and left alone esbuild warns and substitutes `{}` on every build. Saying
    // outright that there is no module URL here is the honest version of the same thing.
    define: { "import.meta.url": JSON.stringify("symbat:worker") },
    plugins: [forbidWasmBinary, forbidHostImports],
  });

  const [output] = result.outputFiles;
  // Without this a blob worker shows in DevTools as `blob:app://<uuid>` with no way to find it.
  const source = `${output.text}\n//# sourceURL=symbat-interpreter-worker.js\n`;
  return { source, inputs: Object.keys(result.metafile.inputs) };
}
