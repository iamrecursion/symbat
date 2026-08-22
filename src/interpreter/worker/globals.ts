// The handful of worker globals this side needs, declared by hand.
//
// The alternative is adding `WebWorker` to tsconfig's `lib`, which cannot be done: it collides with
// `DOM` on `self`, `postMessage`, `addEventListener` and half a dozen other names, and the whole of
// `src/` outside this directory is a DOM program. A second tsconfig would work and would change
// what ESLint's `projectService` resolves for every file in the repo, which is a large price for
// three members.
//
// So: three members, declared once, obtained by one cast in one place. If this file ever needs a
// fourth, that is the moment at which it may make sense to reconsider.

/** The parts of `DedicatedWorkerGlobalScope` the message loop uses. */
export interface WorkerScope {
  /**
   * The message loop's one input. Assigned as a listener so that there is provably one handler: a
   * second assignment replaces the first, where a second listener would quietly double every
   * message.
   */
  onmessage: ((event: { readonly data: unknown; }) => void) | null;

  /**
   * Send one message to whoever constructed this worker. The one-argument form, which is the
   * dedicated-worker signature; `Window.postMessage`'s second parameter is a different API that
   * happens to share a name.
   */
  postMessage(message: unknown): void;
}

/**
 * This worker's global scope.
 *
 * `self` rather than `globalThis`, and the choice is not stylistic. Obsidian's plugin review
 * rejects `globalThis` wherever it appears, on the grounds that a plugin reaching for the global
 * object wants `window` or `activeWindow` so that it keeps working in a popout window. Neither of
 * those exists here — this is the one directory in the repository that provably does not run
 * inside Obsidian — and `self` is a dedicated worker's own name for its scope, so it is at once
 * the idiom, the same object, and the spelling that review accepts.
 *
 * A cast, because under `lib: ["DOM"]` the checker believes `self` is a `Window`. It is not, and
 * the members above are the extent of the difference that matters here.
 */
export const workerScope = self as unknown as WorkerScope;
