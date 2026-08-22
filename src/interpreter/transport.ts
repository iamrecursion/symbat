// How a request reaches the interpreter.
//
// Outside of this file nothing should know which transport is in use: `host.ts` holds a `Transport`
// and asks it things. Below it, `worker/entry.ts` does not know it is being reached at all. The
// pair of implementations is intended to be transparent to every other module.
//
// **The in-process one is not a stub.** It's what runs when a worker cannot be constructed, and
// it's what the whole test suite drives. It is also strictly weaker: an evaluation that has started
// cannot be stopped on this path, because the thread running it is the thread that would have to do
// the stopping. That asymmetry is stated to the reader in the setting's own copy, and is why the
// setting names the two threads rather than offering to choose between them.

import type { Attempt } from "./ladder";
import type { EngineEnv, TaskMap, TaskName } from "./protocol";
import type { WireReply } from "./wire";
import * as server from "./worker/entry";
import type { Schedule } from "./worker/entry";

/**
 * Where the interpreter is running. The same two words the `interpreterThread` setting stores, and
 * a separate type on purpose: that one is a request, and a request for a worker can fail.
 */
export type InterpreterPath = "worker" | "main";

/**
 * The two things a transport says without being asked. Both are the asking side's to act on, which
 * is why they are callbacks rather than return values: the answering side cannot restart itself,
 * and across a boundary it could not even if it wanted to.
 */
export interface TransportHost {
  /** The environment cannot be applied to the instance that is running: replace it. */
  onStale(): void;

  /**
   * It broke in a way it cannot serve through: the module failed to instantiate, the message loop
   * threw, the worker died. Distinct from a panic inside one task, which rides back on that task's
   * reply and is recoverable by restarting on the next use.
   */
  onFault(message: string): void;
}

/**
 * One way of reaching the interpreter. Deliberately the same shape as `worker/entry.ts`'s exports,
 * plus the two lifecycle members only the asking side can have an opinion about.
 */
export interface Transport {
  readonly path: InterpreterPath;

  serve<K extends TaskName>(
    name: K,
    request: TaskMap[K]["request"],
    schedule: Schedule,
  ): Promise<WireReply<K>>;

  updateEnv(env: EngineEnv): void;
  setGeneration(generation: number): void;
  releaseContexts(): void;
  refill(key: string | null): void;

  /** Drop what is queued for `group`, or everything queued. Never reaches work already running. */
  cancel(group: string | null): void;

  /**
   * Release everything and become unusable. Every request still outstanding settles with `null`,
   * which is what every surface already does something sensible with.
   */
  stop(): void;
}

/**
 * The interpreter on this thread, reached by calling it.
 *
 * Written as a ladder rung so that it composes with the worker ones rather than being a special
 * case beneath them: it can fail too (the wasm module may refuse to instantiate) and when it does
 * the reader deserves the same account of what was tried as when a worker fails.
 */
export function localAttempt(base64: string, host: TransportHost): Attempt<Transport> {
  const transport: Transport = {
    path: "main",
    serve: (name, request, schedule) => server.serve(name, request, schedule),
    updateEnv: (env) => {
      if (server.updateEnv(env)) {
        host.onStale();
      }
    },
    setGeneration: (generation) => {
      server.setGeneration(generation);
    },
    releaseContexts: () => {
      server.releaseContexts();
    },
    refill: (key) => {
      server.refill(key);
    },
    cancel: (group) => {
      server.cancel(group);
    },
    stop: () => {
      server.stop();
    },
  };

  return {
    value: transport,
    // `false` — the asynchronous WebAssembly compiler. `initSync` calls the synchronous one, which
    // V8 refuses on a document's main thread above 4 KB, so getting this backwards produces a
    // plugin that throws on load for everyone. See `initEngine`.
    ready: server.start(base64, false),
    abandon: () => {
      server.stop();
    },
  };
}
