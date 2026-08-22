// The built worker bundle, running in a real thread, behind the same call shape the tests use for
// the in-process path.
//
// **This cannot test a *blob* worker**, and the distinction matters enough to say twice: node has
// no blob-URL `Worker`, and nothing in this repository can tell you whether one runs inside
// Obsidian on a phone. What it can test is everything on the other side of the message: that the
// bundle loads at all, that the wire framing carries a request and brings an answer back, that a
// task answers the same thing over there as it does here, and that a `cancel` posted while a pass
// is running is actually delivered.
//
// The shim is what makes a `node:worker_threads` worker look like a dedicated web worker:
// `postMessage` on the global rather than on a port, and `onmessage` as an assignable property.
// Anything the bundle needs beyond that — `atob`, `WebAssembly`, `TextDecoder` — node already has.

import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
// The plugin builds the worker through this same function, which is the whole point: a test that
// bundled it a second way would be checking a bundle nothing ships.
import { buildWorker } from "../../../scripts/worker-bundle.mjs";
import type { TaskMap, TaskName, TaskReply } from "../../../src/interpreter/protocol.ts";
import type { HostMessage, WorkerMessage } from "../../../src/interpreter/wire.ts";
import { wasmBase64 } from "../wasm-pkg.ts";

const SHIM = `
const { parentPort } = require("node:worker_threads");
globalThis.postMessage = (message) => parentPort.postMessage(message);
parentPort.on("message", (data) => { globalThis.onmessage?.({ data }); });
`;

/** A live worker, and the four things a test does with one. */
export interface WorkerHarness {
  /**
   * Ask it to run a task, correlated by id.
   *
   * By id and not by arrival order, because the two are not the same thing once anything is posted
   * that does not reply — and `cancel` is exactly that.
   */
  ask<K extends TaskName>(
    name: K,
    request: TaskMap[K]["request"],
    schedule?: { priority?: "interactive" | "visible" | "background"; group?: string; generation?: number; },
  ): Promise<TaskReply<TaskMap[K]["response"]> | null>;

  /** Post something with no answer — `cancel`, `generation`, `refill`. */
  post(message: HostMessage): void;

  /** The next message the worker sent unasked: `ready`, `stale` or `fault`. */
  unsolicited(): Promise<WorkerMessage>;

  stop(): Promise<void>;
}

/**
 * Build the worker, start it in a thread, and wait for it to say it is ready.
 *
 * The wasm is compiled inside the worker from the same base64 the plugin posts, so this exercises
 * the `init` handshake rather than working around it.
 */
export async function startWorker(): Promise<WorkerHarness> {
  const { source } = await buildWorker(false) as { source: string; };
  const worker = new Worker(`${SHIM}\n${source}`, { eval: true });

  let nextId = 0;
  const replies = new Map<number, (reply: TaskReply<unknown> | null) => void>();
  const spontaneous: WorkerMessage[] = [];
  const listeners: ((message: WorkerMessage) => void)[] = [];

  worker.on("message", (message: WorkerMessage) => {
    if (message.kind === "reply") {
      const settle = replies.get(message.id);
      replies.delete(message.id);
      settle?.(message.reply);
      return;
    }

    const next = listeners.shift();
    if (next === undefined) {
      spontaneous.push(message);
    } else {
      next(message);
    }
  });

  worker.on("error", (error) => {
    // A load failure lands here rather than as a message, and without this it would show up as the
    // test timing out with nothing at all to read.
    assert.fail(`the worker bundle failed to load: ${error.message}`);
  });

  const harness: WorkerHarness = {
    ask(name, request, schedule) {
      nextId += 1;
      const id = nextId;
      return new Promise((resolve) => {
        replies.set(id, resolve as (reply: TaskReply<unknown> | null) => void);
        worker.postMessage(
          {
            kind: "task",
            id,
            name,
            request,
            schedule: {
              priority: schedule?.priority ?? "visible",
              group: schedule?.group,
              generation: schedule?.generation ?? 0,
            },
          } satisfies HostMessage,
        );
      });
    },

    post(message) {
      worker.postMessage(message);
    },

    unsolicited() {
      const held = spontaneous.shift();
      if (held !== undefined) {
        return Promise.resolve(held);
      }

      return new Promise<WorkerMessage>((resolve) => listeners.push(resolve));
    },

    stop: async () => {
      await worker.terminate();
    },
  };

  harness.post({ kind: "init", base64: wasmBase64() });
  const ready = await harness.unsolicited();
  assert.equal(ready.kind, "ready", `the worker did not start: ${JSON.stringify(ready)}`);
  return harness;
}
