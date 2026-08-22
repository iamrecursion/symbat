// What actually travels between the two sides once they are two threads.
//
// It is deliberately a different thing from `protocol.ts`. That file describes the *questions* —
// what a task takes and what it gives back — and is written as though the answer arrived by return.
// This one describes the *envelope* those questions travel in: correlation ids, the lifecycle
// messages that are not tasks at all, and the two things the answering side says without being
// asked. Keeping them apart is what lets the in-process transport skip this file entirely.
//
// Everything here **must** survive `structuredClone`.
//
// Pure: `import type` only, no wasm, no DOM, no Obsidian. Both sides of the boundary import it.

import type { EngineEnv, TaskMap, TaskName, TaskReply } from "./protocol";
import type { Schedule } from "./worker/entry";

/** What the asking side sends. */
export type HostMessage =
  /**
   * Instantiate. The base64 module travels once, at start; see wasm-binary.ts for why it is the
   * literal rather than the bytes.
   */
  | { readonly kind: "init"; readonly base64: string; }
  /** One request, to be answered with a `reply` carrying the same `id`. */
  | {
    readonly kind: "task";
    readonly id: number;
    readonly name: TaskName;
    readonly request: unknown;
    readonly schedule: Schedule;
  }
  /** Replace the environment a context is built in. */
  | { readonly kind: "env"; readonly env: EngineEnv; }
  /** Declare everything queued under an earlier generation obsolete. */
  | { readonly kind: "generation"; readonly generation: number; }
  /** Drop the replayed completion contexts now. */
  | { readonly kind: "release"; }
  /** Refill one note's evaluation allowance, or every note's. */
  | { readonly kind: "refill"; readonly key: string | null; }
  /**
   * Drop everything queued in `group`, or everything queued. Work already running is unaffected —
   * there is no way to stop that from here, which is why the stop command has a second rung.
   */
  | { readonly kind: "cancel"; readonly group: string | null; };

/** What the answering side sends. */
export type WorkerMessage =
  /**
   * Instantiated and serving. The asking side waits for this rather than for the constructor to
   * return: a blocked or sandboxed worker constructs perfectly well and then says nothing.
   */
  | { readonly kind: "ready"; }
  /**
   * One answer. `reply` is `null` when the request came to nothing (superseded, obsolete, or the
   * engine down) which the asking side treats exactly as the in-process queue's `null`.
   */
  | { readonly kind: "reply"; readonly id: number; readonly reply: TaskReply<unknown> | null; }
  /**
   * The environment it was last given cannot be applied to the instance it is running: Numbat's
   * exchange-rate store is set once per module, so replacing rates means replacing the module.
   *
   * Unsolicited, because it is an answer to a message that has no reply, and because making the
   * environment update a round trip would mean either an await on a path that has none today, or a
   * window in which the asking side believes the interpreter is ready and it is not.
   */
  | { readonly kind: "stale"; }
  /**
   * It broke in a way it cannot serve through: the module failed to instantiate, or the message
   * loop itself threw. A panic inside a task is *not* this: that rides back on the reply.
   */
  | { readonly kind: "fault"; readonly message: string; };

/**
 * The response type of task `K`, as it comes back over the wire. Written out because the wire
 * erases the name-to-type link and the transport has to put it back.
 */
export type WireReply<K extends TaskName> = TaskReply<TaskMap[K]["response"]> | null;
