// The spawn ladder's policy, driven by stub rungs and a clock that does not tick.
//
// The case worth having a test for is the middle one: a rung that opens without complaint and then
// says nothing. A real `Worker` behaves exactly like that when a content-security policy refuses a
// blob URL, and it is indistinguishable from a slow start until somebody puts a clock on it — so
// the whole point of `climb` is that it does, and the whole point of these is that they check it
// without waiting five real seconds to find out.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Attempt,
  climb,
  type Countdown,
  describeRejections,
  type Rejection,
  type Rung,
} from "../../../src/interpreter/ladder.ts";

/** A rung that answers. */
function answers(detail: string, opened: string[], abandoned: string[]): Rung<string> {
  return {
    detail,
    open: (): Attempt<string> => {
      opened.push(detail);
      return {
        value: detail,
        ready: Promise.resolve(),
        abandon: () => abandoned.push(detail),
      };
    },
  };
}

/** A rung that opens and then never speaks — the failure the ladder exists for. */
function silent(detail: string, opened: string[], abandoned: string[]): Rung<string> {
  return {
    detail,
    open: (): Attempt<string> => {
      opened.push(detail);
      return {
        value: detail,
        ready: new Promise<void>(() => {}),
        abandon: () => abandoned.push(detail),
      };
    },
  };
}

/** A rung whose construction throws. */
function throws(detail: string, opened: string[]): Rung<string> {
  return {
    detail,
    open: (): Attempt<string> => {
      opened.push(detail);
      throw new TypeError("refused");
    },
  };
}

/** A rung that opens and then reports its own failure. */
function rejects(detail: string, opened: string[], abandoned: string[]): Rung<string> {
  return {
    detail,
    open: (): Attempt<string> => {
      opened.push(detail);
      return {
        value: detail,
        ready: Promise.reject(new Error("failed to load")),
        abandon: () => abandoned.push(detail),
      };
    },
  };
}

/** A timeout that expires immediately, so the whole ladder is climbed in microtasks. */
const now = (): Countdown => ({ expired: Promise.resolve(), cancel: () => {} });

/** A timeout that never expires, so only a rung's own answer decides. */
const never = (): Countdown => ({ expired: new Promise<void>(() => {}), cancel: () => {} });

test("the first rung that answers wins, and nothing below it is opened", async () => {
  const opened: string[] = [];
  const abandoned: string[] = [];
  const climbed = await climb(
    [answers("blob URL", opened, abandoned), answers("data: URL", opened, abandoned)],
    5,
    never,
  );

  assert.deepEqual(climbed, { value: "blob URL", detail: "blob URL" });
  assert.deepEqual(opened, ["blob URL"], "the second rung was never tried");
  assert.deepEqual(abandoned, [], "a rung that answered is not abandoned");
});

// The one that cannot be tested through a real Worker, and the one that actually happens.
test("a rung that opens and stays silent is abandoned and the next one is tried", async () => {
  const opened: string[] = [];
  const abandoned: string[] = [];
  const rejections: Rejection[] = [];
  const climbed = await climb(
    [silent("blob URL", opened, abandoned), answers("in process", opened, abandoned)],
    5_000,
    now,
    rejections,
  );

  assert.equal(climbed?.detail, "in process");
  assert.deepEqual(opened, ["blob URL", "in process"]);
  assert.deepEqual(abandoned, ["blob URL"], "a silent rung must be disposed of, not merely ignored");
  assert.deepEqual(rejections, [{ detail: "blob URL", reason: "no answer within 5000 ms" }]);
});

test("a rung whose construction throws does not stop the climb", async () => {
  const opened: string[] = [];
  const abandoned: string[] = [];
  const rejections: Rejection[] = [];
  const climbed = await climb(
    [throws("blob URL", opened), answers("data: URL", opened, abandoned)],
    5,
    never,
    rejections,
  );

  assert.equal(climbed?.detail, "data: URL");
  assert.deepEqual(rejections, [{ detail: "blob URL", reason: "TypeError: refused" }]);
});

test("a rung that reports its own failure is abandoned and recorded", async () => {
  const opened: string[] = [];
  const abandoned: string[] = [];
  const rejections: Rejection[] = [];
  const climbed = await climb(
    [rejects("blob URL", opened, abandoned), answers("in process", opened, abandoned)],
    5,
    never,
    rejections,
  );

  assert.equal(climbed?.detail, "in process");
  assert.deepEqual(abandoned, ["blob URL"]);
  assert.deepEqual(rejections, [{ detail: "blob URL", reason: "Error: failed to load" }]);
});

test("every rung failing answers null, with one rejection each in order", async () => {
  const opened: string[] = [];
  const abandoned: string[] = [];
  const rejections: Rejection[] = [];
  const climbed = await climb(
    [
      throws("blob URL", opened),
      silent("data: URL", opened, abandoned),
      rejects("in process", opened, abandoned),
    ],
    250,
    now,
    rejections,
  );

  assert.equal(climbed, null);
  assert.deepEqual(opened, ["blob URL", "data: URL", "in process"]);
  assert.deepEqual(rejections.map((rejection) => rejection.detail), ["blob URL", "data: URL", "in process"]);
});

test("an empty ladder answers null rather than hanging", async () => {
  assert.equal(await climb([], 5, never), null);
});

test("the rejections read as one line a person can be handed", () => {
  assert.equal(
    describeRejections([
      { detail: "blob URL", reason: "SecurityError: Failed to construct 'Worker'" },
      { detail: "data: URL", reason: "no answer within 5000 ms" },
    ]),
    "blob URL: SecurityError: Failed to construct 'Worker'; data: URL: no answer within 5000 ms",
  );
  assert.equal(describeRejections([]), "");
});
