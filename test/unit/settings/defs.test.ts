// The settings descriptor table is the single description of every setting — its control, what
// reveals it, and what has to be rebuilt when it changes. It used to be three descriptions in
// settings/tab.ts, which drifted into real bugs, so these tests exist to keep the one description
// honest.
//
// The golden effect table below is the load-bearing one: both historical bugs were a setting whose
// effects were right in one copy and wrong in another, and both would have failed it.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allDescriptors,
  DEFAULT_SETTINGS,
  EFFECTS_BY_KEY,
  normalizeSettings,
  NUMBER_MAXIMUMS,
  NUMBER_MINIMUMS,
  SETTING_BLOCKS,
  type SettingDescriptor,
  type SettingEffect,
  validateTimeZone,
} from "../../../src/settings/defs.ts";

/**
 * Every setting, and exactly what changing it must rebuild. Deliberately spelled out rather than
 * derived: a golden table only catches drift if it is written independently of the thing it checks.
 * An empty array means "nothing", which is a real answer and not an oversight — see the comments.
 */
const EXPECTED_EFFECTS: Record<string, readonly SettingEffect[]> = {
  // Fetching and clearing the rates, *and* rebuilding the completion vocabulary that bakes in
  // currency units. Each path used to do only one of these. Repainting the open editors is
  // deliberately NOT an effect here: it has to happen after the async fetch resolves, so
  // `ensureExchangeRates` does it itself, gated on the rates having actually changed.
  fetchExchangeRates: ["ensureExchangeRates", "invalidateCompletionVocabulary"],
  // Read when the next refresh is due; nothing to rebuild now.
  exchangeRateRefreshHours: [],
  exchangeRateTimeoutSeconds: [],
  customPrelude: ["markPreludeDirty"],

  // The completer reads these live.
  unicodeExpansion: [],
  unicodeLeader: [],
  historyCompletion: [],
  historyLeader: [],
  exprCompletion: [],
  completeIdentifiers: [],
  completeKeywords: [],
  completeUnits: [],
  completeDimensions: [],
  completeTypes: [],

  hover: ["refreshHover"],
  // The two trigger toggles are read live, deliberately: swapping the editor extension is the risky
  // part, so they do not force a rebuild.
  hoverMouse: [],
  hoverDwell: [],
  // Baked into the extension when it is built, so it needs the rebuild. This is the setting that
  // did nothing at all on shipping builds.
  hoverDelayMs: ["refreshHover"],
  hoverVimKey: ["refreshHover"],

  inlayHints: ["refreshInlayHints"],
  inlayResults: ["refreshInlayHints"],
  inlayTypes: ["refreshInlayHints"],
  nbtIndentWidth: ["refreshIndentWidth"],
  replVimMode: ["refreshReplVim"],

  inlineEval: ["refreshInlineEval"],
  // Read on the next reading-view render; nothing open to reconfigure.
  inlineEvalReadingStyle: [],
  // Read at commit time.
  inlineEvalRetainExpr: [],
  inlineEvalLivePrefix: ["refreshInlineEval"],
  inlineEvalConcretePrefix: ["refreshInlineEval"],
  inlineEvalDecimalPlaces: ["refreshInlineEval"],
  inlineEvalFrontmatter: ["refreshInlineEval"],
  inlineEvalCodeBlocks: ["refreshInlineEval"],

  noteProperties: ["refreshNoteScope"],
  notePropertyNumbers: ["refreshNoteScope"],
  notePropertyText: ["refreshNoteScope"],
  notePropertyDates: ["refreshNoteScope"],
  notePropertyDefaultZone: ["refreshNoteScope"],
  notePropertyBooleans: ["refreshNoteScope"],
  noteImports: ["refreshNoteScope"],

  liveReplHighlight: ["refreshReplHighlight"],
  customReplFont: ["refreshReplFont"],
  replViewFontSize: ["refreshReplFont"],
  replInputFontSize: ["refreshReplFont"],
  // Read when the REPL next trims its history / log.
  replHistoryLimit: [],
  replMaxLines: [],

  completionIdleSeconds: [],
};

/** The key each descriptor is stored under. */
function keyOf(descriptor: SettingDescriptor): string {
  return descriptor.control.key;
}

test("every setting rebuilds exactly what it should", () => {
  const actual: Record<string, readonly SettingEffect[]> = {};
  for (const descriptor of allDescriptors()) {
    actual[keyOf(descriptor)] = descriptor.effects ?? [];
  }
  assert.deepEqual(actual, EXPECTED_EFFECTS);
});

test("the effect lookup agrees with the descriptors it is built from", () => {
  for (const descriptor of allDescriptors()) {
    const expected = descriptor.effects ?? [];
    assert.deepEqual(EFFECTS_BY_KEY.get(keyOf(descriptor)) ?? [], expected, keyOf(descriptor));
  }
});

test("every persisted setting has exactly one control", () => {
  const keys = allDescriptors().map(keyOf);
  assert.equal(new Set(keys).size, keys.length, "a settings key is bound to two controls");

  // `preludeFiles` is the one persisted key with no descriptor: it is the reorderable list, which
  // is a positional block rather than a uniform row.
  const described = new Set(keys);
  const persisted = Object.keys(DEFAULT_SETTINGS).filter((key) => key !== "preludeFiles");
  assert.deepEqual(persisted.filter((key) => !described.has(key)), [], "settings with no control");
  assert.deepEqual([...described].filter((key) => !(key in DEFAULT_SETTINGS)), [], "controls for no setting");
});

test("every visibility gate names a real boolean setting", () => {
  const gates = allDescriptors()
    .map((descriptor) => descriptor.visibleWhen)
    .filter((key): key is NonNullable<typeof key> => key !== undefined);
  for (const block of SETTING_BLOCKS) {
    if (block.kind === "prelude-list") {
      gates.push(block.visibleWhen);
    }
  }
  assert.ok(gates.length > 0, "the table should have dependent rows");
  for (const gate of gates) {
    assert.ok(gate in DEFAULT_SETTINGS, `${gate} is not a setting`);
    assert.equal(typeof DEFAULT_SETTINGS[gate], "boolean", `${gate} is not a boolean`);
  }
});

test("every default is a value its own control would accept", () => {
  for (const descriptor of allDescriptors()) {
    const control = descriptor.control;
    const key = control.key;
    const value = DEFAULT_SETTINGS[key];
    switch (control.type) {
      case "toggle":
        assert.equal(typeof value, "boolean", key);
        break;
      case "number":
        assert.equal(typeof value, "number", key);
        assert.ok(
          (value as number) >= control.min,
          `${key} defaults to ${String(value)}, below its own minimum of ${control.min}`,
        );
        assert.ok(
          control.max === undefined || (value as number) <= control.max,
          `${key} defaults to ${String(value)}, above its own maximum of ${String(control.max)}`,
        );
        break;
      case "text": {
        assert.equal(typeof value, "string", key);
        const message = control.validate?.(value as string);
        assert.equal(message, undefined, `${key} defaults to a value its validator rejects: ${String(message)}`);
        break;
      }
      case "dropdown":
        assert.ok(
          Object.keys(control.options).includes(value as string),
          `${key} defaults to ${String(value)}, which is not one of its options`,
        );
        break;
    }
  }
});

test("every row has a name and help text", () => {
  for (const descriptor of allDescriptors()) {
    assert.notEqual(descriptor.name.trim(), "", `${keyOf(descriptor)} has no name`);
    assert.notEqual(descriptor.desc.trim(), "", `${keyOf(descriptor)} has no description`);
  }
});

test("the table renders as one prelude list and one version card, in order", () => {
  const kinds = SETTING_BLOCKS.map((block) => block.kind);
  assert.equal(kinds.filter((kind) => kind === "prelude-list").length, 1);
  assert.equal(kinds.filter((kind) => kind === "version-card").length, 1);
  assert.equal(kinds.at(-1), "version-card", "the version card goes last");
  // The prelude list belongs with the toggle that reveals it, in the first group.
  assert.equal(kinds.indexOf("prelude-list"), 1);
});

// --- normalizeSettings -------------------------------------------------------
//
// Obsidian's `validate` shows a message but stores the value anyway, so the bounds the table
// declares are enforced here or nowhere. Each case below is a value a consumer genuinely cannot
// handle.

/** The minimum each number setting declares, as the consumers rely on it. Spelled out rather than
 *  read from the table, so a bound loosened by accident fails. */
const EXPECTED_MINIMUMS: Record<string, number> = {
  exchangeRateRefreshHours: 1,
  exchangeRateTimeoutSeconds: 1,
  hoverDelayMs: 0,
  // Not a preference: CodeMirror's `indentUnit` throws on an empty string, and it does so while the
  // `.nbt` editor is being constructed — a width of zero is a file that will not open.
  nbtIndentWidth: 1,
  replHistoryLimit: 1,
  replMaxLines: 1,
  completionIdleSeconds: 0,
};

/** The maximum each number setting declares. Sparse: only where a large value is actively harmful
 *  rather than merely odd. */
const EXPECTED_MAXIMUMS: Record<string, number> = {
  // Every indented line carries this many spaces.
  nbtIndentWidth: 8,
};

test("every number setting declares the minimum its consumers assume", () => {
  assert.deepEqual(Object.fromEntries(NUMBER_MINIMUMS), EXPECTED_MINIMUMS);
});

test("a number setting declares a maximum exactly where one is load-bearing", () => {
  assert.deepEqual(Object.fromEntries(NUMBER_MAXIMUMS), EXPECTED_MAXIMUMS);
});

test("a zero timeout is clamped: a non-positive one means *no* timeout", () => {
  // fetchExchangeRatesXml takes the `timeoutMs <= 0` branch and waits forever — the exact inverse
  // of what the setting says it does.
  const settings = normalizeSettings({ exchangeRateTimeoutSeconds: 0 });
  assert.equal(settings.exchangeRateTimeoutSeconds, 1);
});

test("out-of-range numbers are clamped to their declared minimum", () => {
  const settings = normalizeSettings({
    exchangeRateRefreshHours: 0, // would request rates on every interpreter use
    replHistoryLimit: 0, // would drain the history on every submit
    replMaxLines: -5, // would trim the log to one entry per append
  });
  assert.equal(settings.exchangeRateRefreshHours, 1);
  assert.equal(settings.replHistoryLimit, 1);
  assert.equal(settings.replMaxLines, 1);
});

test("an indent width outside its bounds is clamped at both ends", () => {
  // Zero makes `indentUnit` throw inside `EditorState.create`, so the `.nbt` view fails to open at
  // all; an unbounded width puts that many spaces on every indented line.
  assert.equal(normalizeSettings({ nbtIndentWidth: 0 }).nbtIndentWidth, 1);
  assert.equal(normalizeSettings({ nbtIndentWidth: -4 }).nbtIndentWidth, 1);
  assert.equal(normalizeSettings({ nbtIndentWidth: 1000 }).nbtIndentWidth, 8);
  assert.equal(normalizeSettings({ nbtIndentWidth: 4 }).nbtIndentWidth, 4, "an in-range width survives");
});

test("a persisted null falls back to the default rather than beating it", () => {
  // `JSON.stringify(NaN)` is `null`, so a number field the user clears can persist as one — and a
  // plain merge over the defaults would keep it, permanently.
  const settings = normalizeSettings({ replMaxLines: null, unicodeLeader: null });
  assert.equal(settings.replMaxLines, DEFAULT_SETTINGS.replMaxLines);
  assert.equal(settings.unicodeLeader, DEFAULT_SETTINGS.unicodeLeader);
});

test("values of the wrong type are discarded", () => {
  const settings = normalizeSettings({ replMaxLines: "lots", hover: "yes", unicodeLeader: 7 });
  assert.equal(settings.replMaxLines, DEFAULT_SETTINGS.replMaxLines);
  assert.equal(settings.hover, DEFAULT_SETTINGS.hover);
  assert.equal(settings.unicodeLeader, DEFAULT_SETTINGS.unicodeLeader);
});

test("a dropdown value that is not one of its options is discarded", () => {
  const settings = normalizeSettings({ replVimMode: "sometimes" });
  assert.equal(settings.replVimMode, DEFAULT_SETTINGS.replVimMode);
  assert.equal(normalizeSettings({ replVimMode: "on" }).replVimMode, "on", "a real option survives");
});

test("a text value its own validator rejects is discarded", () => {
  // A leader containing whitespace can never be typed as a completion trigger.
  const settings = normalizeSettings({ unicodeLeader: " ", replViewFontSize: "not a size" });
  assert.equal(settings.unicodeLeader, DEFAULT_SETTINGS.unicodeLeader);
  assert.equal(settings.replViewFontSize, DEFAULT_SETTINGS.replViewFontSize);
  assert.equal(normalizeSettings({ unicodeLeader: "\\\\" }).unicodeLeader, "\\\\", "a valid one survives");
});

test("in-range values and the defaults themselves pass through untouched", () => {
  const settings = normalizeSettings({ replMaxLines: 500, hover: false, exchangeRateRefreshHours: 12 });
  assert.equal(settings.replMaxLines, 500);
  assert.equal(settings.hover, false);
  assert.equal(settings.exchangeRateRefreshHours, 12);
  // Round-tripping the defaults must be the identity, or a fresh install would silently differ from
  // the table.
  assert.deepEqual(normalizeSettings({ ...DEFAULT_SETTINGS }), DEFAULT_SETTINGS);
});

test("null data yields the defaults", () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
});

// --- validateTimeZone --------------------------------------------------------
//
// The one setting whose validity is the *platform's* answer rather than the table's, so what counts
// is asked of the same `Intl` the bindings ask (properties/zone.ts). The generic pass above only
// ever checks that the default — blank — is accepted.

test("a blank default zone is the reader's own, and valid", () => {
  assert.equal(validateTimeZone(""), undefined);
  assert.equal(validateTimeZone("   "), undefined, "and so is whitespace, which trims to blank");
});

test("an IANA name the platform knows is a zone", () => {
  for (const zone of ["Europe/Berlin", "UTC", "America/New_York", "Etc/GMT+5"]) {
    assert.equal(validateTimeZone(zone), undefined, zone);
  }
  assert.equal(validateTimeZone("  Europe/Berlin  "), undefined, "surrounding space is trimmed");
});

test("a literal offset is a zone, in every spelling normalizeOffset admits", () => {
  for (const offset of ["+02:00", "-05:00", "Z", "+0530", "+05:45"]) {
    assert.equal(validateTimeZone(offset), undefined, offset);
  }
});

test("a name the platform does not know, or an impossible offset, is rejected with advice", () => {
  // `+15:00` is past the widest offset in use, and `Europe/Berlim` is the typo it looks like. Both
  // have to fail: a zone that does not resolve would silently leave every date read at the
  // interpreter's own local, which is the ambiguity the setting exists to remove.
  for (const bad of ["Europe/Berlim", "not a zone", "+15:00", "-13:00", "+02:99", "02:00"]) {
    const message = validateTimeZone(bad);
    assert.notEqual(message, undefined, `${bad} should be rejected`);
    assert.match(message ?? "", /Europe\/Berlin/, "and the message shows a spelling that works");
  }
});
