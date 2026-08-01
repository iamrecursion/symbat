import assert from "node:assert/strict";
import { test } from "node:test";
import {
  forgetSemanticNames,
  recordSemanticNames,
  semanticKind,
  subscribeSemanticNames,
} from "../../../src/syntax/type-names.ts";

// NOTE: the module holds process-global state (the sets only grow), so these run in order — the
// built-in types are known from the start, names accrue as recorded.

test("built-in types are known before any capture", () => {
  assert.equal(semanticKind("Bool"), "type");
  assert.equal(semanticKind("String"), "type");
  assert.equal(semanticKind("List"), "type");
  // Dimensions and units are unknown until captured.
  assert.equal(semanticKind("Length"), null);
  assert.equal(semanticKind("meter"), null);
});

test("recordSemanticNames notifies subscribers when names are new", () => {
  let notified = 0;
  const unsubscribe = subscribeSemanticNames(() => {
    notified += 1;
  });

  recordSemanticNames(["Length", "Time"], ["meter", "A"]);
  assert.equal(notified, 1); // new names → one notification

  recordSemanticNames(["Length"], ["meter"]); // all already known
  assert.equal(notified, 1); // no change → no further notification

  unsubscribe();
  recordSemanticNames(["Angle"], []); // new, but we unsubscribed
  assert.equal(notified, 1);
});

test("captured dimensions and units classify distinctly; types still win", () => {
  assert.equal(semanticKind("Length"), "dimension");
  assert.equal(semanticKind("Time"), "dimension");
  assert.equal(semanticKind("Angle"), "dimension"); // recorded after unsubscribe
  assert.equal(semanticKind("meter"), "unit");
  assert.equal(semanticKind("A"), "unit"); // a capitalized unit is a unit, not a type
  assert.equal(semanticKind("String"), "type"); // built-in type stays a type
  assert.equal(semanticKind("sin"), null); // a function is none of these
});

test("a user-defined dimension is highlighted once recorded (not the type heuristic)", () => {
  assert.equal(semanticKind("Foo"), null); // unknown → tokenizer falls back to heuristic
  recordSemanticNames(["Foo"], ["bar"]);
  assert.equal(semanticKind("Foo"), "dimension"); // now a real dimension
  assert.equal(semanticKind("bar"), "unit"); // a user-defined (lowercase) unit
});

// --- forgetSemanticNames -----------------------------------------------------
//
// Last, deliberately: it clears the process-global sets the tests above build up.

test("forgetSemanticNames drops captured names and notifies", () => {
  // The sets only ever grew, which is right while the vocabulary is fixed — but a prelude edit can
  // *remove* a unit, and a wasm restart replaces the standard library. Without this, a deleted
  // prelude unit kept highlighting all session.
  assert.equal(semanticKind("Length"), "dimension");
  let notified = 0;
  const unsubscribe = subscribeSemanticNames(() => {
    notified += 1;
  });
  forgetSemanticNames();
  assert.equal(notified, 1);
  assert.equal(semanticKind("Length"), null, "the captured dimension is gone");
  assert.equal(semanticKind("meter"), null, "and the captured unit");
  assert.equal(semanticKind("String"), "type", "but the built-in types remain");

  forgetSemanticNames();
  assert.equal(notified, 1, "and forgetting nothing notifies nobody");
  unsubscribe();
});

test("names captured after a forget are recorded again", () => {
  recordSemanticNames(["Length"], ["meter"]);
  assert.equal(semanticKind("Length"), "dimension");
  assert.equal(semanticKind("meter"), "unit");
});
