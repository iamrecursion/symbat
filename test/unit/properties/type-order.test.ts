// The order Obsidian's property-type menu lists types in, which is the key order of a record the
// plugin does not own — so the interesting parts are that the sort is stable enough to re-run on
// every registry event, and that the rewrite refuses anything that would lose an entry.

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyKeyOrder, plannedOrder, restoredOrder } from "../../../src/properties/type-order.ts";

/** The registry as Obsidian leaves it, with this plugin's three types appended — display names and
 *  all. Ordered as it would actually be found: built-ins first, in Obsidian's own order. */
const NAMES: Record<string, string> = {
  text: "Text",
  multitext: "List",
  number: "Number",
  checkbox: "Checkbox",
  date: "Date",
  datetime: "Date & time",
  "numbat:expression": "Numbat",
  "numbat:zoneddate": "Zoned Date",
  "numbat:zoneddatetime": "Zoned Datetime",
};

const nameOf = (key: string) => NAMES[key] ?? key;

test("types sort by the name they show under, not by their id", () => {
  // Checkbox, Date, Date & time, List, Numbat, Number, Text, Zoned Date, Zoned Datetime — note
  // that `multitext` sorts under "List" and `numbat:expression` between "List" and "Number".
  assert.deepEqual(plannedOrder(Object.keys(NAMES), nameOf), [
    "checkbox",
    "date",
    "datetime",
    "multitext",
    "numbat:expression",
    "number",
    "text",
    "numbat:zoneddate",
    "numbat:zoneddatetime",
  ]);
});

test("a type that will not say its name sorts under its id", () => {
  const order = plannedOrder(["text", "aliases"], (key) => NAMES[key] ?? key);
  assert.deepEqual(order, ["aliases", "text"]);
});

test("two types showing one name order by id, so the sort cannot flip between runs", () => {
  const names: Record<string, string> = { "b:date": "Date", "a:date": "Date" };
  assert.deepEqual(plannedOrder(["b:date", "a:date"], (key) => names[key] ?? key), ["a:date", "b:date"]);
});

test("sorting an already-sorted registry changes nothing", () => {
  // The property the `changed` re-apply rests on: it runs on every registry event, and a sort that
  // could keep finding new orders would keep rewriting the record.
  const once = plannedOrder(Object.keys(NAMES), nameOf);
  assert.deepEqual(plannedOrder(once, nameOf), once);
});

test("applying an order rewrites the keys of the same object", () => {
  const record: Record<string, unknown> = { text: 1, date: 2, checkbox: 3 };
  const before = record;

  assert.equal(applyKeyOrder(record, ["checkbox", "date", "text"]), true);
  assert.equal(record, before, "the object others hold a reference to must be the one rewritten");
  assert.deepEqual(Object.keys(record), ["checkbox", "date", "text"]);
  assert.deepEqual(record, { checkbox: 3, date: 2, text: 1 });
});

test("an order the record is already in is left alone", () => {
  const record: Record<string, unknown> = { text: 1, date: 2 };
  assert.equal(applyKeyOrder(record, ["text", "date"]), false);
  assert.deepEqual(Object.keys(record), ["text", "date"]);
});

test("an order that is not a permutation of the record is refused outright", () => {
  // A stale order — built before another plugin registered a type, or after one went away. Applying
  // it would drop whatever it does not mention.
  const record: Record<string, unknown> = { text: 1, date: 2, checkbox: 3 };

  assert.equal(applyKeyOrder(record, ["date", "text"]), false);
  assert.equal(applyKeyOrder(record, ["date", "text", "checkbox", "gone"]), false);
  assert.deepEqual(Object.keys(record), ["text", "date", "checkbox"]);
});

test("unloading puts the keys back in the order they were found in", () => {
  const pristine = ["text", "date", "checkbox"];
  assert.deepEqual(restoredOrder(["checkbox", "date", "text"], pristine), pristine);
});

test("types registered since unloading are kept, after the ones that were there first", () => {
  const restored = restoredOrder(["other:kind", "checkbox", "date", "text"], ["text", "date", "checkbox"]);
  assert.deepEqual(restored, ["text", "date", "checkbox", "other:kind"]);
});

test("this plugin's own types are tolerated in the restore, whenever its disposers run", () => {
  // Obsidian gives no guarantee about the order registered disposers run in. If the restore runs
  // before the types are unregistered they are still present, and land in the tail — where they are
  // deleted a moment later; if it runs after, they are already gone. Both leave the reader with the
  // order they had before the plugin was enabled.
  const pristine = ["text", "date"];
  assert.deepEqual(restoredOrder(["date", "numbat:expression", "text"], pristine), [
    "text",
    "date",
    "numbat:expression",
  ]);
  assert.deepEqual(restoredOrder(["date", "text"], pristine), pristine);
});
