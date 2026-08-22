// The interpreter on a thread of its own, reached by posting to it.
//
// What this file adds over the in-process transport is not speed. It is the only place in the
// platform where a Numbat evaluation that has already started can be stopped: the VM has no fuel,
// no interrupt hook and no depth cap, and its call stack is a heap `Vec` rather than the wasm
// stack, so a runaway expression is minutes of allocation that no `try` can rescue.
// `worker.terminate()` is the way to handle it, and it exists only from over here.
//
// The two URL rungs are the same worker reached two ways. A blob URL is the ordinary route; a
// `data:` URL is the fallback for a content-security policy that refuses `blob:`. It is bigger on
// the wire and it is the reason the worker pass does not set `charset: "utf8"`, because escaping
// non-ASCII is what keeps the URL encodable at all.

import type { Attempt } from "./ladder";
import type { EngineEnv, TaskMap, TaskName, TaskReply } from "./protocol";
import type { InterpreterPath, Transport, TransportHost } from "./transport";
import type { HostMessage, WireReply, WorkerMessage } from "./wire";
import type { Schedule } from "./worker/entry";

/**
 * A worker's address, and how to give it back. `URL.createObjectURL` leaks until revoked, and a
 * respawn mints a fresh one. The pairing is carried together rather than left to a call site to
 * remember.
 */
interface WorkerUrl {
  readonly href: string;
  readonly revoke: () => void;
}

/**
 * A blob URL, revoked once the worker has loaded from it. Minted per spawn as revoking at
 * construction races the load, and revoking once for good leaves a later respawn with nothing to
 * construct from.
 */
export function blobWorkerUrl(source: string): WorkerUrl {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  return {
    href: url,
    revoke: () => {
      URL.revokeObjectURL(url);
    },
  };
}

/**
 * A `data:` URL, for a policy that refuses `blob:`. `encodeURIComponent` rather than `btoa`, which
 * throws on any character outside Latin-1 — and the worker bundle contains plenty.
 */
export function dataWorkerUrl(source: string): WorkerUrl {
  return {
    href: `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`,
    revoke: () => {},
  };
}

/**
 * Construct a worker from `url`, hand it the module, and give back a transport that communicates
 * with it.
 *
 * `ready` resolves on the worker's own `ready` message, never on the constructor returning. A
 * blocked or sandboxed worker constructs perfectly well and then says nothing at all, which is
 * indistinguishable from a slow one until somebody puts a clock on it — see `ladder.ts`.
 */
export function workerAttempt(url: WorkerUrl, base64: string, host: TransportHost): Attempt<Transport> {
  let worker: Worker;
  try {
    worker = new Worker(url.href);
  } catch (error) {
    url.revoke();
    throw error;
  }

  // Outstanding requests by correlation id. A terminate settles every one of them with `null`,
  // which is the same answer the in-process queue gives for a request it dropped, and which every
  // surface already handles: keep painting what you have, and ask again if you still care.
  const pending = new Map<number, (reply: TaskReply<unknown> | null) => void>();
  let nextId = 1;
  let live = true;
  let announced = false;

  let settleReady: () => void;
  let failReady: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    settleReady = resolve;
    failReady = reject;
  });

  const post = (message: HostMessage): void => {
    if (live) {
      worker.postMessage(message);
    }
  };

  const teardown = (): void => {
    live = false;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    url.revoke();

    // A rung the ladder abandoned for saying nothing would otherwise hold an unsettled `ready`
    // forever, which is the one promise in the plugin nothing could ever resolve. `climb` attaches
    // its swallow before it abandons, so this rejection has a handler by the time it is made.
    if (!announced) {
      announced = true;
      failReady(new Error("the worker was abandoned before it answered"));
    }

    const waiting = [...pending.values()];
    pending.clear();
    for (const settle of waiting) {
      settle(null);
    }
  };

  const broke = (message: string): void => {
    if (announced) {
      host.onFault(message);
    } else {
      // Before `ready`, the ladder owns the failure: it abandons this rung and tries the next one.
      // Telling the host as well would have it schedule a restart of a transport that never ran.
      failReady(new Error(message));
    }
  };

  worker.onmessage = (event: MessageEvent) => {
    const message = event.data as WorkerMessage;
    switch (message.kind) {
      case "ready":
        announced = true;
        settleReady();
        return;

      case "reply": {
        const settle = pending.get(message.id);
        if (settle !== undefined) {
          pending.delete(message.id);
          settle(message.reply);
        }
        return;
      }

      case "stale":
        host.onStale();
        return;

      case "fault":
        broke(message.message);
        return;
    }
  };

  // A blob worker's `onerror` carries almost nothing (frequently an empty message and no stack)
  // which is why the worker reports its own failures explicitly. This is the backstop for the ones
  // it cannot report: a syntax error in the bundle, a module that would not load at all.
  worker.onerror = (event: ErrorEvent | Event) => {
    const detail = "message" in event && typeof event.message === "string" && event.message !== ""
      ? event.message
      : "the worker failed to load";
    broke(detail);
  };

  post({ kind: "init", base64 });

  const path: InterpreterPath = "worker";
  const transport: Transport = {
    path,

    serve<K extends TaskName>(
      name: K,
      request: TaskMap[K]["request"],
      schedule: Schedule,
    ): Promise<WireReply<K>> {
      if (!live) {
        return Promise.resolve(null);
      }

      const id = nextId;
      nextId += 1;
      return new Promise<WireReply<K>>((resolve) => {
        pending.set(id, resolve as (reply: TaskReply<unknown> | null) => void);
        post({ kind: "task", id, name, request, schedule });
      });
    },

    updateEnv(env: EngineEnv): void {
      post({ kind: "env", env });
    },

    setGeneration(generation: number): void {
      post({ kind: "generation", generation });
    },

    releaseContexts(): void {
      post({ kind: "release" });
    },

    refill(key: string | null): void {
      post({ kind: "refill", key });
    },

    cancel(group: string | null): void {
      post({ kind: "cancel", group });
    },

    stop(): void {
      if (live) {
        teardown();
      }
    },
  };

  return { value: transport, ready, abandon: teardown };
}
