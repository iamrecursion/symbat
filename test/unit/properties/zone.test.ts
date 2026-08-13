// The DST cases below rely on the platform's bundled ICU. They pin zones whose rules have been
// stable for decades (and, for Lord Howe, the only half-hour DST shift in use), so a failure here
// means the ICU data is missing rather than that the zone moved.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyZone,
  availableZones,
  fixedOffsetChoices,
  formatOffset,
  formatZoned,
  knownZone,
  normalizeOffset,
  offsetAtInstant,
  offsetChoice,
  offsetForWallClock,
  offsetMinutes,
  parseZoned,
  plainForm,
  selectedChoice,
  zoneChoices,
  zoneForName,
} from "../../../src/properties/zone.ts";

const JAN = Date.parse("2026-01-15T12:00:00Z");
const JUL = Date.parse("2026-07-15T12:00:00Z");

// --- normalizeOffset ----------------------------------------------------------

test("normalizeOffset canonicalizes every spelling of an offset", () => {
  assert.equal(normalizeOffset("+02:00"), "+02:00");
  assert.equal(normalizeOffset("+0200"), "+02:00");
  assert.equal(normalizeOffset("-05:30"), "-05:30");
  assert.equal(normalizeOffset("  +05:45  "), "+05:45");
});

test("Z is canonical, and is not folded into +00:00", () => {
  // Two spellings of one offset, deliberately. Collapsing them would mean the widget rewriting a
  // hand-written `Z` the first time anyone touched the row.
  assert.equal(normalizeOffset("Z"), "Z");
  assert.equal(normalizeOffset("z"), "Z");
  assert.equal(normalizeOffset("+00:00"), "+00:00");
  assert.equal(offsetMinutes("Z"), offsetMinutes("+00:00"), "the same offset, whichever way it is written");
});

test("a negative zero does fold, because nobody means anything by it", () => {
  assert.equal(normalizeOffset("-00:00"), "+00:00");
});

test("normalizeOffset accepts the real-world extremes and rejects beyond them", () => {
  assert.equal(normalizeOffset("+14:00"), "+14:00");
  assert.equal(normalizeOffset("-12:00"), "-12:00");
  assert.equal(normalizeOffset("+15:00"), null);
  assert.equal(normalizeOffset("-13:00"), null);
});

test("normalizeOffset rejects what only looks like an offset", () => {
  assert.equal(normalizeOffset("+02:60"), null);
  assert.equal(normalizeOffset("+2:00"), null);
  assert.equal(normalizeOffset("Europe/Paris"), null);
  assert.equal(normalizeOffset(""), null);
});

// --- offsetMinutes / formatOffset ---------------------------------------------

test("offsetMinutes and formatOffset are inverses", () => {
  for (const offset of ["+00:00", "+02:00", "-05:00", "+05:45", "-03:30", "+14:00", "-12:00"]) {
    const minutes = offsetMinutes(offset);
    assert.notEqual(minutes, null, offset);
    assert.equal(formatOffset(minutes as number), offset);
  }
});

test("offsetMinutes signs sub-hour offsets as a whole", () => {
  assert.equal(offsetMinutes("-03:30"), -210, "not -3 hours plus 30 minutes");
  assert.equal(offsetMinutes("+05:45"), 345);
  assert.equal(offsetMinutes("Z"), 0);
});

test("formatOffset writes zero as positive", () => {
  assert.equal(formatOffset(0), "+00:00");
  assert.equal(formatOffset(-0), "+00:00");
});

// --- parseZoned / formatZoned -------------------------------------------------

test("parseZoned round-trips every canonical form", () => {
  for (
    const text of [
      "2026-07-27",
      "2026-07-27 +02:00",
      "2026-07-27 -05:30",
      "2026-07-27T10:30",
      "2026-07-27T10:30+02:00",
    ]
  ) {
    const parsed = parseZoned(text);
    assert.notEqual(parsed, null, text);
    assert.equal(formatZoned(parsed!), text);
  }
});

test("parseZoned canonicalizes the non-canonical spellings", () => {
  assert.equal(formatZoned(parseZoned("2026-07-27T10:30:00+0200")!), "2026-07-27T10:30+02:00");
  assert.equal(formatZoned(parseZoned("2026-07-27 10:30")!), "2026-07-27T10:30");
  assert.equal(formatZoned(parseZoned("2026-07-27T10:30:00Z")!), "2026-07-27T10:30Z", "Z stays Z");
  assert.equal(formatZoned(parseZoned("2026-07-27T10:30:00.5+02:00")!), "2026-07-27T10:30+02:00");
});

test("a date written before the space was, reads as itself and is rewritten with one", () => {
  // The old spelling ran the offset straight onto the date, where `-` reads as a fourth dash and
  // the eye has to count digits. Both forms parse — the frontmatter grammar always allowed the
  // space — so nothing in anyone's vault stops working; it is only re-spelled when next written.
  for (const text of ["2026-07-27+02:00", "2026-07-27-07:00", "2026-07-27[Europe/Berlin]"]) {
    assert.notEqual(parseZoned(text), null, text);
  }
  assert.equal(formatZoned(parseZoned("2026-07-27-07:00")!), "2026-07-27 -07:00");
  assert.equal(formatZoned(parseZoned("2026-07-27[Europe/Berlin]")!), "2026-07-27 [Europe/Berlin]");
});

test("parseZoned drops seconds, because the input that edits it cannot show them", () => {
  assert.deepEqual(parseZoned("2026-07-27T10:30:45"), { date: "2026-07-27", time: "10:30", offset: null, zone: null });
  assert.equal(plainForm(parseZoned("2026-07-27T10:30:45")!), "2026-07-27T10:30");
});

test("a date with no offset stays a bare date", () => {
  assert.deepEqual(parseZoned("2026-07-27"), { date: "2026-07-27", time: null, offset: null, zone: null });
  assert.equal(plainForm(parseZoned("2026-07-27")!), "2026-07-27");
  assert.equal(formatZoned(parseZoned("2026-07-27")!), "2026-07-27");
});

test("a date carries an offset without acquiring a time", () => {
  assert.deepEqual(parseZoned("2026-07-27 +05:45"), { date: "2026-07-27", time: null, offset: "+05:45", zone: null });
  assert.deepEqual(parseZoned("2026-07-27 -05:00"), { date: "2026-07-27", time: null, offset: "-05:00", zone: null });
  assert.equal(plainForm(parseZoned("2026-07-27 +05:45")!), "2026-07-27", "the picker never sees the offset");
});

test("parseZoned reads a Date in UTC, as the note's own YAML wrote it", () => {
  assert.deepEqual(parseZoned(new Date("2026-07-27T00:00:00Z")), {
    date: "2026-07-27",
    time: null,
    offset: null,
    zone: null,
  });
  assert.deepEqual(parseZoned(new Date("2026-07-27T10:30:00Z")), {
    date: "2026-07-27",
    time: "10:30",
    offset: null,
    zone: null,
  });
  assert.equal(parseZoned(new Date("nope")), null);
});

test("a Date whose year is not four digits is turned away, on either side of the range", () => {
  // A year below 1000 pads and is fine; one outside the range has no `YYYY-MM-DD` to be written as.
  // The negative case is the one worth pinning: `String(-123)` is already four characters wide, so
  // a length check made after padding lets it through and builds `-123-07-27`, which every reader
  // downstream splits on `-` into four fields.
  const at = (year: number): Date => {
    const date = new Date(0);
    date.setUTCFullYear(year, 6, 27);
    return date;
  };

  assert.equal(parseZoned(at(-123)), null, "a negative year");
  assert.equal(parseZoned(at(12345)), null, "a five-digit year");
  assert.equal(parseZoned(at(76))?.date, "0076-07-27", "but a short one pads");
});

test("a lowercase z is the same offset as Z, and is written back as one", () => {
  // The frontmatter grammar is for what someone may have typed, and `z` means exactly one thing —
  // Numbat itself reads either. It is canonicalized on the way back out, as `+0200` already is.
  assert.equal(parseZoned("2026-07-27T10:30:00z")?.offset, "Z");
  assert.equal(formatZoned(parseZoned("2026-07-27T10:30:00z")!), "2026-07-27T10:30Z");
  assert.equal(parseZoned("2026-07-27 z")?.offset, "Z", "on a date as much as on a clock");
});

test("parseZoned rejects what is not a date", () => {
  for (const value of ["tomorrow", "", "1.5", "v2026-07-27", null, undefined, 42, {}]) {
    assert.equal(parseZoned(value), null, JSON.stringify(value));
  }
});

test("parseZoned rejects fields that are not a real moment, though the grammar admits them", () => {
  // DATE_TEXT is the lenient frontmatter grammar; these have to be turned away before they reach a
  // date picker or roll over into a different day.
  assert.equal(parseZoned("2026-07-27T25:00"), null, "no 25th hour");
  assert.equal(parseZoned("2026-07-27T10:99"), null, "no 99th minute");
  assert.equal(parseZoned("2026-13-45"), null, "no thirteenth month");
  assert.equal(parseZoned("2026-02-30"), null, "February has no 30th, and must not become March 2nd");
  assert.equal(parseZoned("2028-02-29")?.date, "2028-02-29", "but a real leap day stands");
});

// --- RFC 9557 named zones -----------------------------------------------------

test("a bracketed IANA name round-trips as itself", () => {
  assert.deepEqual(parseZoned("2026-07-27[Europe/Berlin]"), {
    date: "2026-07-27",
    time: null,
    offset: null,
    zone: "Europe/Berlin",
  });
  assert.equal(formatZoned(parseZoned("2026-07-27[Europe/Berlin]")!), "2026-07-27 [Europe/Berlin]");
});

test("the RFC 9557 extended form keeps both halves, and each does a job", () => {
  const parsed = parseZoned("2026-07-27T10:30:00+02:00[Europe/Berlin]")!;
  assert.equal(parsed.offset, "+02:00", "sortable, and a valid RFC 3339 prefix");
  assert.equal(parsed.zone, "Europe/Berlin", "and this is what makes it float");
  assert.equal(formatZoned(parsed), "2026-07-27T10:30:00+02:00[Europe/Berlin]");
});

test("a name-only datetime round-trips, rather than growing seconds it cannot justify", () => {
  // The bug this pins: padding seconds onto a value with no offset produced
  // `2026-07-27T10:30:00[Europe/Berlin]` — neither what was written nor a valid RFC 9557 extended
  // form, and a value that no longer equalled itself through its own parser.
  for (const text of ["2026-07-27T10:30[Europe/Berlin]", "2026-07-27 [Europe/Berlin]"]) {
    assert.equal(formatZoned(parseZoned(text)!), text, text);
  }
  // Seconds appear exactly when an offset does, which is what makes that form RFC 3339.
  assert.equal(applyZone("2026-07-27T10:30", "Europe/Berlin", null), "2026-07-27T10:30[Europe/Berlin]");
  assert.equal(
    applyZone("2026-07-27T10:30", "Europe/Berlin", "+02:00"),
    "2026-07-27T10:30:00+02:00[Europe/Berlin]",
  );
});

test("the picker never sees the zone, only the clock", () => {
  assert.equal(plainForm(parseZoned("2026-07-27 [Europe/Berlin]")!), "2026-07-27");
  assert.equal(plainForm(parseZoned("2026-07-27T10:30:00+02:00[Europe/Berlin]")!), "2026-07-27T10:30");
});

test("plainForm can be asked for a clock a date does not have, and never for one it should not grow", () => {
  // The datetime editor needs something to put in a `datetime-local` input; the date editor must
  // not be handed a time, or editing a date would silently give it one.
  assert.equal(plainForm(parseZoned("2026-07-27")!, true), "2026-07-27T00:00");
  assert.equal(plainForm(parseZoned("2026-07-27T10:30")!, false), "2026-07-27");
});

test("a zone name the platform cannot resolve is not a zone", () => {
  assert.equal(parseZoned("2026-07-27[Not/AZone]"), null);
  assert.equal(parseZoned("2026-07-27[]"), null);
  // A real one stands, aliases included.
  assert.notEqual(parseZoned("2026-07-27[Etc/GMT+5]"), null);
});

test("parseZoned rejects a date-shaped value whose offset is not real", () => {
  assert.equal(parseZoned("2026-07-27T10:30+02:99"), null);
  assert.equal(parseZoned("2026-07-27+15:00"), null);
});

test("applyZone leaves a value alone when there is no zone to apply", () => {
  assert.equal(applyZone("2026-07-27", null, null), "2026-07-27");
  assert.equal(applyZone("2026-07-27", null, "+02:00"), "2026-07-27 +02:00");
  assert.equal(applyZone("2026-07-27T10:30", null, "+02:00"), "2026-07-27T10:30+02:00");
});

test("the space is a date's alone — a clock keeps the RFC 3339 form other software reads", () => {
  // `2026-07-27-07:00` is four dashes and a counting exercise; `2026-07-27 -07:00` is not. Nothing
  // outside this plugin reads a suffixed *date*, so the space costs nobody anything.
  assert.equal(applyZone("2026-07-27", null, "-07:00"), "2026-07-27 -07:00");
  assert.equal(applyZone("2026-07-27", "Europe/Berlin", "+02:00"), "2026-07-27 [Europe/Berlin]");

  // After a clock there is no such confusion, and the form is real ISO 8601 that Bases, sorting and
  // every other plugin read — so it stays exactly as it was.
  assert.equal(applyZone("2026-07-27T10:30", null, "-07:00"), "2026-07-27T10:30-07:00");
  assert.equal(applyZone("2026-07-27T10:30", "Europe/Berlin", "+02:00"), "2026-07-27T10:30:00+02:00[Europe/Berlin]");
});

test("a named zone writes RFC 9557, with the offset in front where there is a clock", () => {
  // The extended form on a datetime: the offset keeps it lexically sortable and its prefix a valid
  // RFC 3339 timestamp, and the bracket is what makes it float.
  assert.equal(
    applyZone("2026-07-27T10:30", "Europe/Berlin", "+02:00"),
    "2026-07-27T10:30:00+02:00[Europe/Berlin]",
  );
  // Seconds are filled in for RFC 3339, and not doubled on a value that has them.
  assert.equal(
    applyZone("2026-07-27T10:30:45", "Europe/Berlin", "+02:00"),
    "2026-07-27T10:30:45+02:00[Europe/Berlin]",
  );
  // A date has no clock to put an offset on, and must not grow one — the bracket alone. It still
  // sorts lexically, the date being the prefix.
  assert.equal(applyZone("2026-07-27", "Europe/Berlin", "+02:00"), "2026-07-27 [Europe/Berlin]");
});

// --- zones --------------------------------------------------------------------

test("knownZone asks the platform, so aliases and UTC answer correctly", () => {
  assert.equal(knownZone("UTC"), true);
  assert.equal(knownZone("Europe/Berlin"), true);
  assert.equal(knownZone("Etc/GMT+5"), true);
  assert.equal(knownZone("Not/AZone"), false);
  assert.equal(knownZone(""), false);
});

test("an offset is not a name, whatever the engine's Intl says", () => {
  // From Node 24 on, `Intl` accepts ECMA-402 offset time zone identifiers, so it answers yes to
  // these — including `+15:00`, which is past the widest offset in use. Reading an offset is
  // normalizeOffset's job, bounds and all, so they are turned away here whether or not the platform
  // would take them.
  for (const offset of ["+02:00", "+15:00", "-13:00", "+0530", "+05", "−05"]) {
    assert.equal(knownZone(offset), false, offset);
  }
  assert.equal(knownZone("Etc/GMT+5"), true, "a name whose sign is not the first character stands");
});

test("availableZones offers a real list", () => {
  const zones = availableZones();
  assert.ok(zones.length > 100, `expected a full zone list, got ${zones.length}`);
  assert.ok(zones.includes("Europe/Berlin"));
});

test("offsetAtInstant follows daylight saving", () => {
  assert.equal(offsetAtInstant("Europe/London", JAN), "+00:00");
  assert.equal(offsetAtInstant("Europe/London", JUL), "+01:00");
  assert.equal(offsetAtInstant("Europe/Berlin", JAN), "+01:00");
  assert.equal(offsetAtInstant("Europe/Berlin", JUL), "+02:00");
});

test("offsetAtInstant handles half-hour shifts and sub-hour zones", () => {
  assert.equal(offsetAtInstant("Australia/Lord_Howe", JAN), "+11:00");
  assert.equal(offsetAtInstant("Australia/Lord_Howe", JUL), "+10:30", "the only half-hour DST shift in use");
  assert.equal(offsetAtInstant("Asia/Kolkata", JAN), "+05:30");
  assert.equal(offsetAtInstant("Asia/Kolkata", JUL), "+05:30", "no DST, so the same all year");
  assert.equal(offsetAtInstant("Asia/Kathmandu", JAN), "+05:45");
});

test("offsetAtInstant reports zero as an offset, not as a bare GMT", () => {
  assert.equal(offsetAtInstant("UTC", JAN), "+00:00");
});

test("offsetAtInstant reads a pre-standard-time offset to the minute", () => {
  // Before the railways there was no standard time: a zone's offset was its town's solar mean, and
  // ICU still reports it — `GMT+00:53:28` for Berlin in 1880. There is nowhere to put the seconds,
  // so they go; refusing the whole reading over them would make every date this old answer `null`,
  // which reads as "this platform does not know Europe/Berlin".
  assert.equal(offsetAtInstant("Europe/Berlin", Date.UTC(1880, 0, 1)), "+00:53");
  assert.equal(offsetAtInstant("Asia/Calcutta", Date.UTC(1850, 5, 1)), "+05:53");
});

test("a pre-standard-time offset still reaches a wall clock, and is a real offset", () => {
  const offset = offsetForWallClock("Europe/Berlin", "1880-05-01T10:30");
  assert.equal(offset, "+00:53");
  // Which is the point of truncating rather than rejecting: what comes back has to be something the
  // widgets can write and this module can read back.
  assert.equal(normalizeOffset(offset ?? ""), "+00:53");
});

test("offsetAtInstant returns null rather than throwing on a zone or moment it cannot read", () => {
  assert.equal(offsetAtInstant("Not/AZone", JAN), null);
  assert.equal(offsetAtInstant("UTC", Number.NaN), null);
});

// --- offsetForWallClock -------------------------------------------------------

test("offsetForWallClock resolves a wall clock, not an instant", () => {
  // A one-pass implementation reading the wall clock as UTC gets July right and January wrong,
  // because the first pass lands on the far side of the transition.
  assert.equal(offsetForWallClock("Europe/London", "2026-01-15T12:00"), "+00:00");
  assert.equal(offsetForWallClock("Europe/London", "2026-07-15T12:00"), "+01:00");
  assert.equal(offsetForWallClock("Europe/Berlin", "2026-01-15T12:00"), "+01:00");
  assert.equal(offsetForWallClock("Europe/Berlin", "2026-07-15T12:00"), "+02:00");
});

test("offsetForWallClock accepts a bare date as that day's midnight", () => {
  assert.equal(offsetForWallClock("Europe/Berlin", "2026-01-15"), "+01:00");
  assert.equal(offsetForWallClock("Europe/Berlin", "2026-07-15"), "+02:00");
});

test("offsetForWallClock lands on a side of each DST transition", () => {
  // Europe/London springs forward at 01:00 UTC on 2026-03-29 and falls back on 2026-10-25.
  assert.equal(offsetForWallClock("Europe/London", "2026-03-28T12:00"), "+00:00");
  assert.equal(offsetForWallClock("Europe/London", "2026-03-30T12:00"), "+01:00");
  assert.equal(offsetForWallClock("Europe/London", "2026-10-24T12:00"), "+01:00");
  assert.equal(offsetForWallClock("Europe/London", "2026-10-26T12:00"), "+00:00");
});

test("offsetForWallClock returns null on a zone or wall clock it cannot read", () => {
  assert.equal(offsetForWallClock("Not/AZone", "2026-07-27T10:30"), null);
  assert.equal(offsetForWallClock("UTC", "tomorrow"), null);
});

// --- the choice list ----------------------------------------------------------

test("zoneChoices leads with the reader's own zone and UTC", () => {
  const choices = zoneChoices("Europe/Berlin");
  assert.equal(choices[0].id, "local");
  assert.equal(choices[0].label, "Local (Europe/Berlin)");
  assert.equal(choices[1].id, "UTC");
  assert.ok(choices.length > 2, "the fixed offsets follow");
});

test("fixedOffsetChoices offers no zone name, so nothing it offers can write RFC 9557", () => {
  // The invariant that makes patching Obsidian's *own* Datetime widget defensible: a value under a
  // core type has to stay standard ISO 8601, and the bracketed form is read by neither moment nor
  // `Date`. Nothing else pins this — the widgets themselves import Obsidian and cannot be unit
  // tested — so a choice list growing a named entry has to fail here.
  const choices = fixedOffsetChoices();
  assert.deepEqual(choices.filter((choice) => choice.zone !== null), [], "every entry is a bare offset");
  for (const choice of choices) {
    assert.equal(
      applyZone("2026-07-27T10:30", choice.zone, choice.offsetAt("2026-07-27T10:30")).includes("["),
      false,
      choice.id,
    );
  }

  // And it is the tail of the floating list, so the two cannot drift apart on which offsets exist.
  assert.deepEqual(
    zoneChoices("Europe/Berlin").filter((choice) => choice.zone === null).map((choice) => choice.id),
    choices.map((choice) => choice.id),
  );
});

test("the local choice is a zone, not a snapshot of today's offset", () => {
  const [local] = zoneChoices("Europe/Berlin");
  assert.equal(local.offsetAt("2026-01-15T12:00"), "+01:00");
  assert.equal(local.offsetAt("2026-07-15T12:00"), "+02:00");
});

test("a fixed-offset choice is itself whatever the date", () => {
  const choice = offsetChoice("+05:45");
  assert.equal(choice.offsetAt("2026-01-15T12:00"), "+05:45");
  assert.equal(choice.offsetAt("2026-07-15T12:00"), "+05:45");
});

test("zoneForName refuses a zone the platform does not know", () => {
  assert.notEqual(zoneForName("Pacific/Auckland"), null);
  assert.equal(zoneForName("Not/AZone"), null);
});

test("every choice offered writes a valid offset", () => {
  for (const choice of zoneChoices("Europe/Berlin")) {
    const offset = choice.offsetAt("2026-07-27T10:30");
    assert.notEqual(offset, null, choice.id);
    assert.equal(normalizeOffset(offset as string), offset, choice.id);
  }
});

// --- selectedChoice -----------------------------------------------------------

test("a value written with a name reads back as that name, whatever offset it is at today", () => {
  const choices = zoneChoices("Europe/Berlin");
  // The whole reason for storing a name. Matching on the number would have shown Europe/Paris half
  // the time and a bare +01:00 the rest.
  assert.equal(selectedChoice(choices, parseZoned("2026-07-27T10:30[Europe/Berlin]")!)?.id, "local");
  assert.equal(selectedChoice(choices, parseZoned("2026-01-27T10:30[Europe/Berlin]")!)?.id, "local");
  assert.equal(selectedChoice(choices, parseZoned("2026-07-27T10:30[UTC]")!)?.id, "UTC");
});

test("a name the reader has no entry for is unmatched, so the caller can add one", () => {
  // Someone else's note, opened in Berlin. Reported rather than flattened onto whichever fixed
  // offset happens to equal it — that would silently turn a floating value into a pinned one.
  assert.equal(selectedChoice(zoneChoices("Europe/Berlin"), parseZoned("2026-07-27[Pacific/Auckland]")!), null);
});

test("an offset-only value matches a fixed offset, never a named zone", () => {
  const choices = zoneChoices("Europe/Berlin");
  // +02:00 in July *is* Berlin's offset, but the value did not say Berlin. Selecting `local` would
  // offer to rewrite a pinned value as a floating one the moment anything was touched.
  assert.equal(selectedChoice(choices, parseZoned("2026-07-27T10:30+02:00")!)?.id, "+02:00");
  assert.equal(selectedChoice(choices, parseZoned("2026-07-27T10:30+00:00")!)?.id, "+00:00");
  assert.equal(selectedChoice(choices, parseZoned("2026-07-27T10:30+05:45")!)?.id, "+05:45");
});

test("selectedChoice is null for a value naming no zone at all", () => {
  assert.equal(selectedChoice(zoneChoices("UTC"), parseZoned("2026-07-27")!), null);
  assert.equal(selectedChoice(zoneChoices("UTC"), parseZoned("2026-07-27T10:30")!), null);
});

test("an offset no choice produces is reported as unmatched rather than rewritten", () => {
  const choices = zoneChoices("Europe/Berlin").filter((choice) => choice.id !== "+05:45");
  assert.equal(selectedChoice(choices, parseZoned("2026-07-27+05:45")!), null);
});

test("a value written Z round-trips as Z, and picks the Z entry rather than +00:00", () => {
  const choices = zoneChoices("Europe/Berlin");
  assert.equal(formatZoned(parseZoned("2026-07-27T10:30Z")!), "2026-07-27T10:30Z");
  assert.equal(selectedChoice(choices, parseZoned("2026-07-27T10:30Z")!)?.id, "Z");
  // …and a value written +00:00 keeps *that* spelling, rather than being pulled onto Z.
  assert.equal(selectedChoice(choices, parseZoned("2026-07-27T10:30+00:00")!)?.id, "+00:00");
});

test("Z, +00:00 and UTC are three answers, and each writes its own", () => {
  const byId = new Map(zoneChoices("Europe/Berlin").map((choice) => [choice.id, choice]));
  const write = (id: string): string => {
    const choice = byId.get(id)!;
    return applyZone("2026-07-27T10:30", choice.zone, choice.offsetAt("2026-07-27T10:30"));
  };
  assert.equal(write("Z"), "2026-07-27T10:30Z", "pinned, and the short spelling");
  assert.equal(write("+00:00"), "2026-07-27T10:30+00:00", "pinned, spelled out");
  assert.equal(write("UTC"), "2026-07-27T10:30:00+00:00[UTC]", "a name, so it floats — and UTC never moves");
});
