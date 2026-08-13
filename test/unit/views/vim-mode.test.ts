import assert from "node:assert/strict";
import { test } from "node:test";
import { vimModeFrom, vimModeOf } from "../../../src/views/vim-mode.ts";

test("vimModeFrom reads the plain modes", () => {
  assert.equal(vimModeFrom({ mode: "normal" }), "normal");
  assert.equal(vimModeFrom({ mode: "insert" }), "insert");
  assert.equal(vimModeFrom({ mode: "replace" }), "replace");
});

test("vimModeFrom splits visual mode by its sub-mode", () => {
  assert.equal(vimModeFrom({ mode: "visual", subMode: "blockwise" }), "visual-block");
  assert.equal(vimModeFrom({ mode: "visual", subMode: "linewise" }), "visual-line");
  assert.equal(vimModeFrom({ mode: "visual", subMode: "" }), "visual"); // charwise
  assert.equal(vimModeFrom({ mode: "visual" }), "visual"); // the library omits it outside visual
});

test("vimModeFrom falls back to normal for anything unrecognized", () => {
  assert.equal(vimModeFrom({}), "normal");
  assert.equal(vimModeFrom({ mode: "something-new" }), "normal");
  // A sub-mode without visual mode is not a visual mode.
  assert.equal(vimModeFrom({ mode: "normal", subMode: "blockwise" }), "normal");
});

test("vimModeOf reads the mode already in force off vim's state", () => {
  assert.equal(vimModeOf({}), "normal");
  assert.equal(vimModeOf({ insertMode: true }), "insert");
  assert.equal(vimModeOf({ visualMode: true }), "visual");
  assert.equal(vimModeOf({ visualMode: true, visualBlock: true }), "visual-block");
  assert.equal(vimModeOf({ visualMode: true, visualLine: true }), "visual-line");
});

test("vimModeOf treats missing state as normal", () => {
  assert.equal(vimModeOf(null), "normal"); // vim is off
  assert.equal(vimModeOf(undefined), "normal"); // vim is on but not initialized yet
});

test("vimModeOf ignores a stale visual flavor once visual mode is over", () => {
  // The library leaves `visualBlock` set after leaving the mode; `visualMode` is the gate.
  assert.equal(vimModeOf({ visualMode: false, visualBlock: true }), "normal");
  assert.equal(vimModeOf({ insertMode: true, visualBlock: true }), "insert");
});
