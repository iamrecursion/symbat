// Time zones for frontmatter dates: parsing a date or datetime value into its calendar fields plus
// an optional UTC offset, writing it back, and resolving a named IANA zone to the offset it had at
// a given moment.
//
// The wire format is always a **numeric offset**, never a zone name. A YAML scalar has nowhere to
// put `Europe/Berlin`, and Numbat reaches IANA names only through `-> tz(...)` on the display side
// — never inside `datetime("...")`. A zone name is therefore an input method (see {@link
// zoneForName}), and what lands in the note is the offset that zone had at the value's own wall
// clock. That is what makes a date in January and one in July read correctly under one choice.
//
// Everything here is pure: `Intl` and `Date` are platform built-ins, not Obsidian and not wasm, so
// this module is unit-testable in isolation. The zone field, its type-ahead, and the registry work
// live in properties/date-type.ts and properties/zone-editor.ts; the binding side lives in
// properties/parse.ts, whose {@link DATE_TEXT} is the one grammar both sides share.

import { DATE_TEXT } from "./parse";

// THE VALUE
// ================================================================================================

/** A frontmatter date or datetime, split into the parts YAML can hold. */
export interface ZonedValue {
  /** `YYYY-MM-DD`. Always present — a value with no date is not one of these. */
  date: string;

  /** `HH:MM`, or `null` for a date with no time of day. Seconds are dropped; see {@link
   *  plainForm}. */
  time: string | null;

  /** A normalized `±HH:MM`, or `null` when the value carries no offset of its own and the reader's
   *  default zone therefore applies. */
  offset: string | null;

  /**
   * An IANA zone name from an RFC 9557 suffix (`[Europe/Berlin]`), or `null`.
   *
   * This is the difference between a value that **floats** and one that is pinned. A name says
   * which zone was meant, so moving the date across a daylight saving boundary moves the instant
   * with it; an offset says which instant was meant, and stays that instant forever. Both can be
   * present, as RFC 9557 allows, and the name is the one that survives an edit.
   */
  zone: string | null;
}

/** The widest and the narrowest offsets in real-world use (Etc/GMT-14 and Etc/GMT+12). Values
 *  outside this are a typo rather than a zone, and are rejected rather than carried. */
const MIN_OFFSET_MINUTES = -12 * 60;
const MAX_OFFSET_MINUTES = 14 * 60;

/** `Z`, `+02:00` or `+0200` — the three spellings YAML, ISO 8601 and Numbat's own examples use. */
const OFFSET_TEXT = /^(?:([Zz])|([+-])(\d{2}):?(\d{2}))$/;

/**
 * An offset in its canonical spelling, or `null` when it is not one.
 *
 * **`Z` is canonical, not a synonym for `+00:00`.** The two denote the same offset, and collapsing
 * one into the other would be tidier — but it would also mean the widget silently rewriting a
 * hand-written `Z` the first time anyone touched the row, which is the exact complaint this whole
 * feature exists to answer. They are kept as two spellings of one offset, and whichever was written
 * is what stays written. A negative zero is a different matter and does fold into `+00:00`: nobody
 * means anything by it.
 */
export function normalizeOffset(raw: string): string | null {
  const match = OFFSET_TEXT.exec(raw.trim());
  if (match === null) {
    return null;
  }

  const [, zulu, sign, hours, minutes] = match;
  if (zulu !== undefined) {
    return "Z";
  }

  if (Number(minutes) > 59) {
    return null;
  }

  const magnitude = Number(hours) * 60 + Number(minutes);
  const total = sign === "-" ? -magnitude : magnitude;
  return total < MIN_OFFSET_MINUTES || total > MAX_OFFSET_MINUTES ? null : formatOffset(total);
}

/**
 * An offset as signed minutes east of UTC, or `null` when it is not an offset.
 *
 * Unlike {@link normalizeOffset} this does **not** apply the ±14/−12 bounds: it is a reading of a
 * spelling, not a judgement about whether the spelling names a real zone. Its callers only ever
 * feed it an offset {@link offsetAtInstant} produced or {@link normalizeOffset} already vetted, so
 * the wider domain is unreachable today — but a caller reaching for it as a general parser wants
 * the vetted function instead.
 */
export function offsetMinutes(offset: string): number | null {
  const match = OFFSET_TEXT.exec(offset.trim());
  if (match === null) {
    return null;
  }

  const [, zulu, sign, hours, minutes] = match;
  if (zulu !== undefined) {
    return 0;
  }
  if (Number(minutes) > 59) {
    return null;
  }

  const magnitude = Number(hours) * 60 + Number(minutes);
  return sign === "-" ? -magnitude : magnitude;
}

/** Signed minutes east of UTC as `±HH:MM`. The inverse of {@link offsetMinutes}, and zero is
 *  positive. */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const magnitude = Math.abs(Math.trunc(minutes));
  return `${sign}${pad(Math.floor(magnitude / 60))}:${pad(magnitude % 60)}`;
}

/** The two-digit form of a clock field. */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}

// READING AND WRITING A VALUE
// ================================================================================================

/**
 * A frontmatter value as its calendar fields, or `null` when it is not a date at all.
 *
 * A `Date` is read in **UTC**, matching properties/parse.ts's `dateFromValue`: that is the zone
 * YAML assigns a timestamp written without one, so the fields come back as they were written. Such
 * a value has already lost any offset it had by the time it reaches here — which is exactly why the
 * widgets prefer the raw string Obsidian's property cache hands them.
 */
export function parseZoned(value: unknown): ZonedValue | null {
  if (value instanceof Date) {
    return fromDate(value);
  }
  if (typeof value !== "string") {
    return null;
  }

  const match = DATE_TEXT.exec(value.trim());
  if (match === null) {
    return null;
  }

  const [, date, time, rawOffset, rawZone] = match;
  const offset = rawOffset === undefined ? null : normalizeOffset(rawOffset);
  if (rawOffset !== undefined && offset === null) {
    return null; // matched the shape but not a real offset — `+02:99` is not a moment
  }

  // A zone name the platform cannot resolve is not a zone. Turning the whole value away is right:
  // the widgets would otherwise offer to edit something they cannot say the meaning of.
  if (rawZone !== undefined && !knownZone(rawZone)) {
    return null;
  }

  const parsed: ZonedValue = {
    date,
    time: time === undefined ? null : time.slice(0, 5),
    offset,
    zone: rawZone ?? null,
  };
  return instantOf(parsed) === null ? null : parsed;
}

/**
 * The moment a value's calendar fields name, **read as UTC** — the arithmetic base for {@link
 * offsetForWallClock}, and the check that the fields are a real date at all.
 *
 * This is stricter than {@link DATE_TEXT}, deliberately. That grammar is the frontmatter one, where
 * leniency costs nothing because a value that fails to bind simply does not bind. Here the fields
 * go on to fill a date picker and to be written back into a note, so `2026-07-27T25:00` and
 * `2026-02-30` have to be turned away rather than passed on to roll over into something else.
 */
function instantOf(value: ZonedValue): number | null {
  const [year, month, day] = value.date.split("-").map(Number);
  const [hours, minutes] = value.time === null ? [0, 0] : value.time.split(":").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hours > 23 || minutes > 59) {
    return null;
  }

  // Two-digit years are the reason for `setUTCFullYear` rather than `Date.UTC` alone: the latter
  // reads a year below 100 as 19xx, which would silently move the value four centuries.
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(hours, minutes, 0, 0);

  // A date that rolled over (February 30th becoming March 2nd) is not the date it claimed to be.
  return at.getUTCMonth() === month - 1 && at.getUTCDate() === day ? at.getTime() : null;
}

/** {@link parseZoned} for a `Date` the note's own YAML already parsed. */
function fromDate(value: Date): ZonedValue | null {
  if (!Number.isFinite(value.getTime())) {
    return null;
  }

  const year = String(value.getUTCFullYear()).padStart(4, "0");
  if (year.length !== 4) {
    return null; // a year outside four digits is not a note's due date
  }

  const date = `${year}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  const midnight = value.getUTCHours() === 0 && value.getUTCMinutes() === 0;
  return {
    date,
    time: midnight ? null : `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}`,
    offset: null,
    zone: null,
  };
}

/**
 * The value without its offset — what a built-in `<input type="date">` or `<input
 * type="datetime-local">` is fed, and what it hands back on change.
 *
 * **Seconds are dropped.** A `datetime-local` input with no `step` attribute shows minutes only, so
 * a value carrying `:45` would lose it silently the moment the user touched the field. Truncating
 * here makes that loss explicit and one-way rather than a surprise, and it is what Obsidian's own
 * widget already does to a hand-written seconds value.
 */
export function plainForm(value: ZonedValue, withTime = value.time !== null): string {
  if (!withTime) {
    return value.date;
  }
  return `${value.date}T${value.time ?? "00:00"}`;
}

/**
 * A plain form (from {@link plainForm} or straight out of an `<input>`) with a zone re-attached —
 * the text that goes into the note.
 *
 * The two spellings say different things and both are written:
 *
 *  - **A named zone** writes RFC 9557. On a value with a time it is the full extended form,
 *    `2026-07-27T10:30:00+02:00[Europe/Berlin]`: the offset in front keeps the value lexically
 *    sortable and makes its prefix a valid RFC 3339 timestamp, and the bracket is what makes it
 *    float. On a date there is no time to write and adding one would change what the value *is*, so
 *    it is `2026-07-27 [Europe/Berlin]` — which still sorts, the date being the prefix.
 *  - **A fixed offset** writes just the offset, which is all it has to say.
 *
 * **On a date, the zone is separated by a space** ({@link ZONE_GAP}); on a value with a clock it is
 * not. A date is the only case where the two run together illegibly: `2026-07-27-07:00` reads as
 * four dash-separated numbers, and the eye has to count digits to find where the date stops. After
 * a clock there is no such confusion — and no room for a space either, since that form is valid ISO
 * 8601 and other software reads it. The space costs nothing here because a suffixed date is already
 * this plugin's own spelling, valid to nothing else (properties/date-type.ts opens with why).
 *
 * Note that the offset-only form is written **without seconds** (`2026-07-27T10:30+02:00`), so it
 * is ISO 8601 but not RFC 3339, which requires them. That is deliberate on both counts: `moment`
 * and `new Date` read it, and it is what the `<input>` handed back, so nothing is added to a value
 * that did not say it. Only the RFC 9557 form below pads seconds, because there the *prefix* has to
 * be a valid RFC 3339 timestamp for a reader that stops at the bracket.
 */
export function applyZone(plain: string, zone: string | null, offset: string | null): string {
  const gap = plain.includes("T") ? "" : ZONE_GAP;
  if (zone !== null) {
    // Seconds are RFC 3339's requirement, so they are filled in only when there is an offset to
    // make that form — and only on a value with a clock to put them on. Padding them onto a
    // name-only value would produce `…T10:30:00[Europe/Berlin]`: neither what was written nor a
    // valid extended form, and a value that no longer round-trips through its own parser.
    const stamp = offset !== null && plain.includes("T") ? `${withSeconds(plain)}${offset}` : plain;
    return `${stamp}${gap}[${zone}]`;
  }
  return offset === null ? plain : `${plain}${gap}${offset}`;
}

/** What separates a date from the zone written after it. See {@link applyZone} for why it is only
 *  ever a date, and properties/parse.ts's `DATE_TEXT` for the grammar that already admitted it —
 *  which is what makes every value written before this still read as itself. */
const ZONE_GAP = " ";

/** `2026-07-27T10:30` → `2026-07-27T10:30:00`, leaving a value that already has seconds alone. */
function withSeconds(plain: string): string {
  return /T\d{2}:\d{2}$/.test(plain) ? `${plain}:00` : plain;
}

/** The canonical written form of a whole value. */
export function formatZoned(value: ZonedValue): string {
  return applyZone(plainForm(value), value.zone, value.offset);
}

// ZONES
// ================================================================================================

/** The reader's own zone, as an IANA name. */
export function localZoneName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Answers already had from `Intl`, keyed by zone name.
 *
 * Constructing an `Intl.DateTimeFormat` is not cheap, and both callers below ask repeatedly about a
 * handful of zones: a note's every date binding resolves the default zone as the preamble is
 * re-derived, which happens on edit, and the settings tab validates its zone field on every
 * keystroke. The answers cannot go stale — ICU data does not change inside a session — so they are
 * kept.
 *
 * Two maps rather than one because they ask different questions of `Intl`: {@link knownZone} probes
 * with the plainest options there are, and would otherwise inherit {@link offsetAtInstant}'s
 * dependence on `longOffset` support and report every zone as unknown on an engine without it.
 *
 * Cleared wholesale past a bound that no real vault reaches, because the validating caller feeds in
 * a prefix of whatever is being typed and those are not worth remembering.
 */
const KNOWN_ZONES = new Map<string, boolean>();
const ZONE_FORMATTERS = new Map<string, Intl.DateTimeFormat | null>();
const ZONE_CACHE_LIMIT = 512;

/** Read a memoized `Intl` answer, computing and storing it on a miss. */
function memoized<T>(cache: Map<string, T>, zone: string, compute: () => T): T {
  const cached = cache.get(zone);
  if (cached !== undefined) {
    return cached;
  }

  if (cache.size >= ZONE_CACHE_LIMIT) {
    cache.clear();
  }

  const value = compute();
  cache.set(zone, value);
  return value;
}

/**
 * A leading sign, which is what an *offset* identifier starts with and a zone name never does.
 *
 * ECMA-402 offset time zone identifiers (`+05`, `+05:30`, `+0530`, and the U+2212 spelling) are
 * accepted by `Intl` from Node 24 on, so "did not throw" stopped meaning "is a name" — `+15:00`
 * resolves there, past the widest offset anyone is at. Offsets are {@link normalizeOffset}'s to
 * judge, bounds and all, and are turned away here so that every caller keeps asking the one
 * question this answers. `Etc/GMT+5` is unaffected: its sign is not the first character.
 */
const OFFSET_IDENTIFIER = /^[+−-]/;

/** Whether the platform's ICU knows this zone **name**. Asked of `Intl` rather than of {@link
 *  availableZones} so that aliases (`Etc/GMT+5`) and `UTC` itself answer correctly. */
export function knownZone(zone: string): boolean {
  if (OFFSET_IDENTIFIER.test(zone.trim())) {
    return false; // not a name, and not cached: an offset is a different question — see above
  }

  return memoized(KNOWN_ZONES, zone, () => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  });
}

/** The answer {@link availableZones} keeps, or `null` before it has been asked for. */
let ALL_ZONES: readonly string[] | null = null;

/**
 * Every zone name the platform knows, for the search list. Empty on a platform without
 * `Intl.supportedValuesOf`, which degrades the search to nothing rather than throwing.
 *
 * Held rather than re-asked, for the same reason as the two maps above and one more: the caller is
 * a type-ahead, so this runs on every keystroke, and `supportedValuesOf` builds a fresh four-
 * hundred-entry array each time it is called. `readonly` because the one list is now shared — a
 * caller that sorts or splices in place would be editing every later caller's copy.
 */
export function availableZones(): readonly string[] {
  if (ALL_ZONES === null) {
    try {
      ALL_ZONES = Intl.supportedValuesOf?.("timeZone") ?? [];
    } catch {
      ALL_ZONES = [];
    }
  }
  return ALL_ZONES;
}

/** `GMT+02:00`, `GMT-03:30`, or a bare `GMT` on an ICU that abbreviates the zero case. */
const GMT_OFFSET = /^GMT(?:([+-]\d{2}:\d{2}))?$/;

/**
 * The offset `zone` was at `atMs`, or `null` when the platform does not know the zone.
 *
 * DST is the whole reason this is a function of a moment rather than a constant: `Europe/London` is
 * `+00:00` in January and `+01:00` in July, and `Australia/Lord_Howe` shifts by half an hour.
 */
export function offsetAtInstant(zone: string, atMs: number): string | null {
  if (!Number.isFinite(atMs)) {
    return null;
  }

  const formatter = memoized(ZONE_FORMATTERS, zone, () => {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" });
    } catch {
      return null;
    }
  });
  if (formatter === null) {
    return null;
  }

  // The formatter is reused; only `formatToParts` runs per call, and it holds no state between
  // them.
  const name = formatter.formatToParts(new Date(atMs)).find((part) => part.type === "timeZoneName")?.value;
  const match = name === undefined ? null : GMT_OFFSET.exec(name);
  if (match === null) {
    return null;
  }

  return match[1] === undefined ? "+00:00" : match[1];
}

/**
 * The offset `zone` was at a **wall clock** — `2026-07-27T00:00`, as written in a note — rather
 * than at a known instant.
 *
 * That needs two passes, because the instant a wall clock names depends on the very offset being
 * looked up. Read the offset as if the wall clock were UTC, subtract it to get a candidate instant,
 * then read the offset again there. The first pass can only be wrong by less than the DST shift it
 * is resolving, so the second pass lands on the right side of a transition for every wall clock
 * except the hour that a spring-forward skips and the hour an autumn-back repeats. Those two
 * resolve to whichever side the second pass reaches, which is a rounding rather than an error:
 * neither has a single correct answer to give.
 */
export function offsetForWallClock(zone: string, isoLocal: string): string | null {
  const wall = parseZoned(isoLocal);
  const asUtc = wall === null ? null : instantOf(wall);
  if (asUtc === null) {
    return null;
  }

  const first = offsetAtInstant(zone, asUtc);
  const minutes = first === null ? null : offsetMinutes(first);
  if (minutes === null) {
    return null;
  }

  return offsetAtInstant(zone, asUtc - minutes * 60_000);
}

// THE CHOICES A WIDGET OFFERS
// ================================================================================================

/** One entry of a zone picker. A named zone resolves its offset per value (so DST is right for
 *  the date in hand); a fixed offset is itself, whatever the date. */
export interface ZoneChoice {
  /** Stable identity — an IANA name, an offset, or `local`. What the `<option>` carries. */
  id: string;

  /** What the reader sees. */
  label: string;

  /** The IANA name this writes into the value, or `null` for a fixed offset. This is what decides
   *  whether the value floats. */
  zone: string | null;

  /** The offset to write for a value at this wall clock, or `null` if it cannot be resolved. */
  offsetAt: (isoLocal: string) => string | null;
}

/**
 * The offsets in real-world use, as the canonical vocabulary of the picker. Deliberately a list
 * rather than every quarter-hour from −12:00 to +14:00: two thirds of those have never been
 * anyone's zone, and a menu of 105 entries is worse at the job than one of 38.
 */
export const OFFSET_CHOICES: readonly string[] = [
  "-12:00",
  "-11:00",
  "-10:00",
  "-09:30",
  "-09:00",
  "-08:00",
  "-07:00",
  "-06:00",
  "-05:00",
  "-04:00",
  "-03:30",
  "-03:00",
  "-02:00",
  "-01:00",
  "+00:00",
  "+01:00",
  "+02:00",
  "+03:00",
  "+03:30",
  "+04:00",
  "+04:30",
  "+05:00",
  "+05:30",
  "+05:45",
  "+06:00",
  "+06:30",
  "+07:00",
  "+08:00",
  "+08:45",
  "+09:00",
  "+09:30",
  "+10:00",
  "+10:30",
  "+11:00",
  "+12:00",
  "+12:45",
  "+13:00",
  "+14:00",
];

/** A choice that writes one offset whatever the date — a value pinned to an instant. */
export function offsetChoice(offset: string, label = offset): ZoneChoice {
  return { id: offset, label, zone: null, offsetAt: () => offset };
}

/** A choice for a named zone, resolving DST per value and writing the name so the value floats.
 *  `null` when the platform cannot read it. */
export function zoneForName(zone: string, label = zone): ZoneChoice | null {
  if (!knownZone(zone)) {
    return null;
  }
  return { id: zone, label, zone, offsetAt: (isoLocal) => offsetForWallClock(zone, isoLocal) };
}

/**
 * The picker's standing list where a *floating* value is allowed: the reader's own zone first, then
 * UTC, then the fixed offsets.
 *
 * `local` is a *named* choice rather than a snapshot of today's offset, so a note dated in another
 * season still gets the offset the reader's zone had then. It keeps the id `local` so that the one
 * choice whose meaning follows the reader stays selected when they travel.
 */
export function zoneChoices(local: string = localZoneName()): ZoneChoice[] {
  const choices: ZoneChoice[] = [];
  const here = zoneForName(local, `Local (${local})`);
  if (here !== null) {
    choices.push({ ...here, id: "local" });
  }

  const utc = zoneForName("UTC", "UTC");
  if (utc !== null) {
    choices.push(utc);
  }

  // `Z` and `UTC` are both zero, and are still two different answers. `UTC` is a *name*, so it
  // writes the floating `+00:00[UTC]`; `Z` is the pinned spelling, and the short one people
  // actually write. Offering both is what lets either round-trip as itself.
  return [...choices, ...fixedOffsetChoices()];
}

/**
 * The fixed-offset half of the standing list: `Z`, then every offset in real-world use.
 *
 * Kept separate from {@link zoneChoices}, which is its only caller, because the two halves say
 * different things. A named zone **floats** — the value follows that zone across a daylight saving
 * boundary — where an offset **pins** one instant forever, and a reader who picks `+02:00` from
 * this list is asking for exactly that. Both are offered because both are things people mean.
 */
export function fixedOffsetChoices(): ZoneChoice[] {
  return [offsetChoice("Z", "Z (UTC)"), ...OFFSET_CHOICES.map((offset) => offsetChoice(offset))];
}

/**
 * The choice a value is already written in, or `null` when it names no zone at all.
 *
 * **A name is matched by name**, which is the whole reason for storing one: a value written
 * `[Europe/Berlin]` reads back as Europe/Berlin whatever offset that zone happens to be at today,
 * where matching on the number would have shown `Europe/Paris` half the time and a bare `+01:00`
 * the rest. The reader's own zone wins a tie with the same name, so `local` stays selected for
 * someone editing their own notes.
 *
 * Failing that, a value with only an **offset** is matched by the offset each choice resolves to at
 * this value's own wall clock, first match in list order. An offset no choice produces is the
 * caller's cue to add one of its own ({@link offsetChoice}) rather than silently rewriting what the
 * note says.
 */
export function selectedChoice(choices: readonly ZoneChoice[], value: ZonedValue): ZoneChoice | null {
  if (value.zone !== null) {
    return choices.find((choice) => choice.zone === value.zone) ?? null;
  }
  if (value.offset === null) {
    return null;
  }

  const wall = plainForm(value);
  return choices.find((choice) => choice.zone === null && choice.offsetAt(wall) === value.offset) ?? null;
}
