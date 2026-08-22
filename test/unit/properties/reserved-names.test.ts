// The persisted reserved-name set: what its stamp covers, and what makes a stored one
// untrustworthy.
//
// Two things are load-bearing. The stamp has to move whenever the prelude's own vocabulary could
// have — otherwise a property named `m` reads as shadowing the metre when it no longer does, which
// is a silently wrong evaluation rather than an error. And a stored record is *validated* rather
// than trusted, because `data.json` is a file in the user's vault: hand-edited, synced between
// devices, and written by whichever plugin version happened to be installed last.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { reservedNamesDiffer, reservedNamesKey, seededReservedNames } from "../../../src/properties/reserved-names.ts";

const KEY = reservedNamesKey("1.1.1", ["prelude.nbt"], false);

describe("what the stamp covers", () => {
  test("is the same for the same plugin, prelude and rate setting", () => {
    assert.equal(reservedNamesKey("1.1.1", ["prelude.nbt"], false), KEY);
  });

  test("moves with the plugin version, which pins the bundled Numbat", () => {
    assert.notEqual(reservedNamesKey("1.1.2", ["prelude.nbt"], false), KEY);
  });

  test("moves with the prelude files", () => {
    assert.notEqual(reservedNamesKey("1.1.1", ["other.nbt"], false), KEY);
    assert.notEqual(reservedNamesKey("1.1.1", [], false), KEY);
  });

  test("moves with the order the prelude is applied in", () => {
    assert.notEqual(
      reservedNamesKey("1.1.1", ["a.nbt", "b.nbt"], false),
      reservedNamesKey("1.1.1", ["b.nbt", "a.nbt"], false),
    );
  });

  test("moves with the exchange-rate setting, which decides whether the currencies are there", () => {
    assert.notEqual(reservedNamesKey("1.1.1", ["prelude.nbt"], true), KEY);
  });

  test("does not run two prelude paths together into one", () => {
    assert.notEqual(
      reservedNamesKey("1.1.1", ["a.nbt", "b.nbt"], false),
      reservedNamesKey("1.1.1", ["a.nbtb.nbt"], false),
    );
  });
});

describe("restoring a stored set", () => {
  test("restores one stamped with the same key", () => {
    assert.deepEqual(seededReservedNames({ key: KEY, names: ["m", "sin"] }, KEY), ["m", "sin"]);
  });

  test("refuses one stamped with another", () => {
    const stale = reservedNamesKey("1.0.0", ["prelude.nbt"], false);
    assert.equal(seededReservedNames({ key: stale, names: ["m"] }, KEY), null);
  });

  test("refuses nothing at all", () => {
    assert.equal(seededReservedNames(undefined, KEY), null);
    assert.equal(seededReservedNames(null, KEY), null);
  });

  test("refuses something that is not a record", () => {
    assert.equal(seededReservedNames("m sin", KEY), null);
    assert.equal(seededReservedNames(42, KEY), null);
  });

  test("refuses a record whose names are not a list", () => {
    assert.equal(seededReservedNames({ key: KEY, names: "m" }, KEY), null);
    assert.equal(seededReservedNames({ key: KEY }, KEY), null);
  });

  test("refuses a list holding anything but names", () => {
    // A hand-edited file is the likely source, and a non-string here would reach `Set.has` and
    // quietly never match — an absence that looks like a decision.
    assert.equal(seededReservedNames({ key: KEY, names: ["m", 7] }, KEY), null);
  });

  test("restores an empty set, which is a real answer", () => {
    assert.deepEqual(seededReservedNames({ key: KEY, names: [] }, KEY), []);
  });
});

describe("whether an arriving set says anything new", () => {
  test("says no when it matches, whatever the order", () => {
    assert.equal(reservedNamesDiffer(new Set(["m", "sin"]), new Set(["sin", "m"])), false);
  });

  test("says yes when a name was added or dropped", () => {
    assert.equal(reservedNamesDiffer(new Set(["m"]), new Set(["m", "sin"])), true);
    assert.equal(reservedNamesDiffer(new Set(["m", "sin"]), new Set(["m"])), true);
  });

  test("says yes when a name was swapped for another", () => {
    // Same size, so the cheap check has to be backed by the membership one.
    assert.equal(reservedNamesDiffer(new Set(["m"]), new Set(["s"])), true);
  });
});
