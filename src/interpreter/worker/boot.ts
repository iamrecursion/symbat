// The worker bundle's entry point containing the message loop.
//
// This is the only file in the repository that is not part of `main.js`. esbuild builds it as a
// second, self-contained pass whose output is injected into the main bundle as a *string* (see
// esbuild.config.mjs), then used to construct a `Worker`.
//
// It is deliberately thin. Everything it does is translate: a message into a call on `entry.ts`,
// and a call's answer back into a message.
//
// Two things it must never grow:
//
//   * **A decision.** Whether to restart, whether to stop trying, how long to wait all belong to
//     `host.ts`, which is the side that can act on them. A worker cannot terminate a worker.
//   * **An import from above.** Obsidian, the DOM host, CodeMirror, the plugin object; a stray one
//     yields a worker that throws on load. Since the in-process path is opt-in, that is a plugin
//     which evaluates nothing at all and reports it as the reader's device being at fault. Two
//     guards ensure this: the ESLint block over this directory, and a build-time check in the
//     worker pass.

import { describeError } from "../protocol";
import type { HostMessage, WorkerMessage } from "../wire";
import * as server from "./entry";
import { workerScope } from "./globals";

function post(message: WorkerMessage): void {
  workerScope.postMessage(message);
}

/** Report something that broke the loop itself, as distinct from a panic inside a task — which
 *  rides back on that task's reply envelope and is the host's cue to restart, not to give up. */
function fault(error: unknown, what: string): void {
  post({ kind: "fault", message: `${what}: ${describeError(error)}` });
}

function handle(message: HostMessage): void {
  switch (message.kind) {
    case "init":
      // `sync: true` — `initSync` uses the synchronous WebAssembly compiler, which is permitted
      // here and refused on a document's main thread above 4 KB. See `initEngine`.
      server.start(message.base64, true).then(
        () => {
          post({ kind: "ready" });
        },
        (error: unknown) => {
          fault(error, "the interpreter failed to start");
        },
      );
      return;

    case "task":
      void server.serveErased(message.name, message.request, message.schedule)
        .then(
          (reply) => {
            post({ kind: "reply", id: message.id, reply });
          },
          // The queue is documented never to reject, and today it does not. But the asking side
          // holds one entry per correlation id and settles it only on a reply, so if that ever
          // stops being true the surface waits for an answer nobody is going to send — with no
          // error anywhere, because a rejection here has nowhere to go. Answering `null` is what
          // every other way of coming to nothing already answers, and it is one line.
          (error: unknown) => {
            console.error("Symbat: an interpreter task could not be served", error);
            post({ kind: "reply", id: message.id, reply: null });
          },
        );
      return;

    case "env":
      if (server.updateEnv(message.env)) {
        // Unsolicited, because the message it answers has no reply. See `WorkerMessage`.
        post({ kind: "stale" });
      }
      return;

    case "generation":
      server.setGeneration(message.generation);
      return;

    case "release":
      server.releaseContexts();
      return;

    case "refill":
      server.refill(message.key);
      return;

    case "cancel":
      server.cancel(message.group);
      return;
  }
}

workerScope.onmessage = (event) => {
  try {
    handle(event.data as HostMessage);
  } catch (error) {
    // The loop must not die of one bad message: the host would see silence, which is
    // indistinguishable from a worker that never started, and would spend its whole ready timeout
    // finding out.
    fault(error, "the interpreter's message loop threw");
  }
};
