// Pure helpers for note-property bindings — turning a note's parsed frontmatter into the Numbat
// `let` bindings that open the note's evaluation scope (the "note preamble"). A property opts in by
// being assigned the plugin's `numbat` property type (its value is then a Numbat expression), and
// an untyped property rides along as the plain value it holds — a number, a string, a date, a
// boolean — as far as the reader's settings allow (see {@link PlainBindings}).
//
// A property nested inside a YAML object participates too: an object binds a Numbat *struct* under
// its own key, so `costs.total` is the name everywhere — the same dotted path Obsidian's property
// UI shows. See {@link derivePreamble}.
//
// A YAML *array* binds as a Numbat list. Its items share the *property key* `<key>.#` — Better
// Properties' spelling for the sub-property every item of an Array shares, and a name in Obsidian's
// registry rather than in Numbat — so that is where an item's type assignment is looked up, and an
// array of objects binds as a list of one struct type. See {@link ARRAY_ITEM}.
//
// Everything here is data-only — no Obsidian, CodeMirror, or wasm imports, and the three modules it
// does import (completion/expressions.ts, document/frontmatter.ts, syntax/identifier.ts) are
// equally pure — so it is unit-testable in isolation (like evaluation/inline-parse.ts /
// document/shared-blocks.ts). The YAML parsing, the property-type lookups, and the interpreter live
// in the thin bridge (properties/note.ts).

import { BUILTIN_TYPE_NAMES, KEYWORDS } from "../completion/expressions";
import { FRONTMATTER_CLOSE, FRONTMATTER_OPEN } from "../document/frontmatter";
import { definedValue, NULLABLE_ABSENT, NULLABLE_STRUCT } from "../interpreter/nullable";
import { WORD_CHAR } from "../syntax/identifier";

// THE MODEL
// ================================================================================================

/** How one frontmatter property became (or failed to become) a binding. */
export interface PropertyBinding {
  /** The property name as written in the frontmatter — the dotted path for a nested one
   *  (`costs.total`), matching how Obsidian's property UI keys it. */
  key: string;

  /** The frontmatter keys leading to the property, outermost first. A top-level property's path is
   *  `[key]`, so `key === dottedKey(path)` throughout. */
  path: string[];

  /** What the binding is addressed by in Numbat: an identifier per {@link sanitizeIdentifier} at
   *  the top level, and a dotted *field path* into the object's struct when nested (`costs.total`)
   *  — so this is a Numbat expression, not necessarily an identifier. */
  name: string;

  /** The expression text the binding evaluates (the property's value). */
  expr: string;

  /** The value as the reader wrote it, present only where {@link expr} is *not* it — today the only
   *  cause is a substituted zero, whether {@link groundZero} did it to the value itself or
   *  {@link groundItemZero} to something inside a list. Consumers that reason about what is on the
   *  page rather than what is evaluated want this: it is why a grounded `0` still counts as
   *  restating its own source, and so still shows no `= 0` beside it. */
  written?: string;

  /** The `struct` definitions {@link expr} itself needs — the element type of an array of objects,
   *  and nothing else, so this is empty for almost every binding. Replayed immediately *before*
   *  {@link code} by every surface that replays a preamble.
   *
   *  Kept out of `code` rather than folded into it because the two surfaces that show a binding's
   *  value (the frontmatter inlays and the scope inspector) evaluate `expr` on its own and *then*
   *  run `code`: a definition living in both would be declared twice, which Numbat rejects. */
  defs: string[];

  /** The complete statement replayed into the note scope: a `let` for a top-level property, and the
   *  struct definition(s) plus the rebuilt `let` of the whole object for a nested one. */
  code: string;

  /** Whether the property is numbat-typed (its value is an expression), or the kind of untyped
   *  value it rode along as. */
  kind: "expression" | PlainKind;

  /**
   * A diagnostic about a binding that *did* bind — shown where its value would be, since there is
   * something to say about it and nothing useful to show.
   *
   * Distinct from a {@link PropertySkip}, and the distinction is the point: a skip says a property
   * contributed no binding, and every consumer reads it that way (the scope tree lists it apart,
   * the widget reports it in place of a value). This one is a property that bound perfectly well
   * and will still not work, which is a state the skip vocabulary cannot express.
   *
   * It exists for exactly one condition today — see {@link zeroFieldWarning} — and the reason it is
   * a field here rather than an error raised at evaluation time is placement: by the time Numbat
   * objects, the only thing it knows is that some struct's type never resolved, so its complaint
   * lands on whatever line read the object and never on the line that caused it. Deciding it here
   * is what puts the message on the property at fault.
   */
  warning?: string;
}

/** Why a property contributed no binding. `reserved` and `unsupported` are surfaced as errors on
 *  numbat-typed properties; the rest are quiet. */
export type PropertySkipReason = "reserved" | "invalid-name" | "duplicate" | "unsupported";

/** A property that contributed no binding, and why — for the property widget (and, later, the
 *  note-scope inspector) to surface. */
export interface PropertySkip {
  /** The property's own key, as written in the frontmatter. */
  key: string;

  /** The frontmatter keys leading to the property, as on {@link PropertyBinding}. An object skipped
   *  as a whole reports the object's own path. */
  path: string[];

  /** Why it bound nothing, as a machine-readable tag. */
  reason: PropertySkipReason;

  /** Human-readable one-liner, shown like an evaluation error. */
  message: string;
}

/** The note preamble: every property-derived binding in frontmatter order, the properties that were
 *  skipped, and the signature component that keys the evaluation caches. */
export interface NotePreamble {
  /** The bindings the frontmatter contributed, in the order they were written — which is the order
   *  they must be replayed in, since a later one may use an earlier one's name. */
  bindings: PropertyBinding[];

  /** The properties that contributed nothing, each with its reason. */
  skips: PropertySkip[];

  /** The binding statements joined with newlines — `""` when there are none. Part of every
   *  evaluation cache key, so a property edit re-evaluates. */
  source: string;

  /** The cross-note import chunks replayed *before* the bindings (transitively gathered
   *  `numbat-shared` blocks + typed properties of `numbat-use` targets), each interpreted
   *  separately so one broken import cannot sink the rest. Attached by the Obsidian bridge
   *  (properties/note.ts) — the pure derivation never sets it. Folded into {@link source} so an
   *  import change re-evaluates. */
  imports?: string[];
}

/** The preamble of a note with no contributing properties. */
export const EMPTY_PREAMBLE: NotePreamble = { bindings: [], skips: [], source: "" };

// NUMBAT NAMES FROM YAML KEYS
// ================================================================================================

/** Numbat identifiers may not *begin* with a digit, so {@link sanitizeIdentifier} guards a leading
 *  one with an underscore. */
const DIGIT = /[0-9]/;

/**
 * The Numbat identifier for a property name: identifier characters are kept, every run of anything
 * else (spaces, hyphens, punctuation) becomes a single underscore, and a leading digit is guarded
 * with an underscore (`2nd try` → `_2nd_try`). Returns `null` when nothing usable remains.
 */
export function sanitizeIdentifier(key: string): string | null {
  let name = "";
  let gap = false;

  for (const ch of key.trim()) {
    if (WORD_CHAR.test(ch)) {
      if (gap && name !== "") {
        name += "_";
      }
      gap = false;
      name += ch;
    } else {
      gap = true;
    }
  }

  if (name === "") {
    return null;
  }

  if (DIGIT.test(name[0])) {
    name = "_" + name;
  }

  return name;
}

/** The dotted form of a property path — how a nested property is named, both in Numbat (a field
 *  path into the object's struct) and in Obsidian's property UI. */
export function dottedKey(path: readonly string[]): string {
  return path.join(".");
}

/**
 * The path segment that stands for "an item of this array".
 *
 * **This is a key in Obsidian's property registry, never a Numbat name.** `#` is not Numbat syntax,
 * and an array item has no Numbat name at all: the list binds under the array's own key and an item
 * is reached with `element_at`. The distinction is easy to lose because the two kinds of dotted
 * name look alike — `costs.total` really is both a property key *and* a Numbat field path, which is
 * what makes nested properties read the same in the frontmatter and in a block. `rates.#` is only
 * ever the property key, and nothing in this file ever emits one into Numbat source.
 *
 * The spelling is Better Properties': an **Array** property renders each of its items as if it were
 * a property named `<parent>.#`, so a type assigned there applies to *every* item — exactly the
 * homogeneity a Numbat list needs. So `rates.#` is the key whose type assignment governs `rates`'
 * items, `people.#.pace` the key governing the `pace` field of every object in `people`, and
 * `grid.#.#` an item of a nested array.
 *
 * An assignment on the array's *own* key (`rates`) is honored too, since that is how a list bound
 * before this spelling existed and how one binds without Better Properties installed.
 */
export const ARRAY_ITEM = "#";

/**
 * The property key whose *binding* a property key belongs to: an array item names no binding of its
 * own — the array binds as a single list — so `rates.#` and `people.#.pace` both resolve to their
 * array, and every other key resolves to itself. Keys throughout, never Numbat names (see {@link
 * ARRAY_ITEM}).
 *
 * This is what lets the surfaces that are handed an item's key (the property widget, which Better
 * Properties renders once per item, and the Source-mode completer) find the binding it is part of:
 * its scope, and any skip reported against it.
 */
export function bindingKey(key: string): string {
  const parts = key.split(".");
  const item = parts.indexOf(ARRAY_ITEM);
  return item === -1 ? key : parts.slice(0, item).join(".");
}

/**
 * Words Numbat's grammar refuses in *field* position, so a property nested under one of these names
 * cannot become a struct field and is skipped instead. This is its keyword table plus the built-in
 * type names plus `and` — verified by trying every name in the interpreter's completion vocabulary
 * as a field name against the built wasm (v1.23.0), and pinned by a unit test so a Numbat bump that
 * moves the grammar shows up as a failure rather than as broken notes.
 *
 * The same words are already illegal at the top level (`let type = 5` does not parse), so nesting
 * neither adds nor removes a class of failure. Unit names are *not* here: struct fields have their
 * own namespace, so `si: {m: 5}` binds `si.m` and leaves `metre` alone (which is why {@link
 * PreambleRules.isReserved} applies to an object's own key only).
 */
export const FIELD_KEYWORDS: ReadonlySet<string> = new Set([
  ...KEYWORDS,
  ...BUILTIN_TYPE_NAMES,
  "and",
]);

/** How deep the descent goes before giving up. Frontmatter this deep is already past the point of
 *  being readable; the cap is a backstop against pathological input, paired with (not a substitute
 *  for) the cycle guard. */
export const MAX_PROPERTY_DEPTH = 8;

/**
 * Whether a frontmatter value is an object whose entries are properties in their own right.
 * Deliberately strict, because every other `typeof value === "object"` shape is a trap: `empty:`
 * parses to `null` (and `Object.entries(null)` throws), a date parses to a `Date`, and an array is
 * not a mapping — it binds as one list rather than as a property apiece, since no struct field can
 * name an index and a sequence item has no `key:` line of its own to anchor a result on.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A short, identifier-safe digest (FNV-1a, base36) used to keep generated struct names from
 *  colliding — see {@link PreambleRules.namespace}. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(36);
}

// THE DERIVATION'S STATE
// ================================================================================================

/**
 * Which kinds of *untyped* value ride along as bindings, each its own setting — a property that is
 * assigned the Numbat type is an expression regardless of these.
 *
 * They are separate because they differ in how much they put into a note's namespace. A number is
 * almost always arithmetic; text is almost always prose, and turning it all on means every `title`
 * and `status` in the vault becomes a Numbat name.
 */
export interface PlainBindings {
  /** A plain finite number binds as a dimensionless scalar. */
  numbers: boolean;

  /** A string binds as a Numbat `String`. */
  text: boolean;

  /** A value under a property assigned Obsidian's Date type binds as a Numbat `DateTime`. */
  dates: boolean;

  /** A boolean binds as a Numbat `Bool` — and an unset checkbox as `false`. */
  booleans: boolean;
}

/** No untyped value rides along — what a note exports to the notes that `numbat-use` it, which only
 *  ever see its *typed* properties. */
export const PLAIN_NONE: PlainBindings = { numbers: false, text: false, dates: false, booleans: false };

/** Every untyped value rides along — the shipped default, and what the whole of this file is
 *  described against. */
export const PLAIN_ALL: PlainBindings = { numbers: true, text: true, dates: true, booleans: true };

/** What {@link derivePreamble} needs to know about the world: which property names are assigned the
 *  numbat type, whether a candidate identifier is already taken by the prelude, and which untyped
 *  values ride along. */
export interface PreambleRules {
  /** Whether this property name (as written) is assigned the numbat type. A nested property is
   *  asked about under its dotted path (`costs.total`), which is how Obsidian's property UI
   *  addresses it. */
  isNumbatTyped: (key: string) => boolean;

  /** Whether this identifier already names a prelude unit / function / variable / dimension — such
   *  a property is skipped rather than shadowing it (`m: 5` would otherwise silently turn `5 m`
   *  into arithmetic). Asked about top-level property names and object keys; struct field names
   *  have their own namespace and are checked against {@link FIELD_KEYWORDS} instead. */
  isReserved: (name: string) => boolean;

  /** Which untyped values ride along as bindings. */
  plain: PlainBindings;

  /**
   * Which untyped values ride along *below the top level* — inside an object property, or inside an
   * array's items. Defaults to {@link plain}, so a caller that does not set it sees one rule at
   * every depth.
   *
   * It exists because the two levels are not the same question. At the top level a plain value is
   * its own binding, and keeping it out keeps a name out of the namespace. Below it, a plain value
   * is a *field of a value that is being bound anyway* — and its typed siblings may refer to it by
   * its dotted name (`costs.total = costs.materials * 1.2`). Dropping it there does not withhold a
   * name, it hands back a different object than the one that was written, and breaks every sibling
   * that reads the missing field.
   *
   * Both callers set it to {@link PLAIN_ALL}, differing only in the *top-level* rule they pair it
   * with: a note reads its own properties under the reader's settings, and exports them under
   * {@link PLAIN_NONE} so incidental metadata stays private. Either way an object that binds at all
   * binds whole. See `properties/note.ts`'s `preambleFromRecord` and `importedPropsChunks`.
   *
   * Setting it also turns on the gate that keeps the nested rule from binding everything: an object
   * binds only if at least one leaf under it would have bound *at the top level* — typed, or of a
   * plain kind {@link plain} allows (see {@link hasBindableLeaf}). So an object of nothing but text
   * still stays out of a namespace that binds no text, and off the export path, where nothing
   * untyped binds at the top level, that reduces to "something under it is numbat-typed". Without a
   * nested rule there is no gate, and an object binds whatever its leaves bind, as always.
   */
  plainNested?: PlainBindings;

  /**
   * The property type assigned to a key, as the registry's own id (`checkbox`, `date`,
   * `better-properties:toggle`, …), or `null` for an untyped property. Optional: without it the two
   * bindings that need to know a property's *declared* kind simply do not happen.
   *
   * They need it because the value alone is not enough. An unset checkbox parses to `null` — and so
   * does every other empty property, so binding `null` as `false` without asking would make
   * `summary:` mean `false`. And a date reaches the derivation as text on the surfaces that read
   * Obsidian's metadata cache rather than the note's YAML, where prose and a date are the same
   * shape.
   */
  assignedType?: (key: string) => string | null;

  /**
   * The UTC offset to read a date by, when the value does not carry one of its own — asked for the
   * wall clock the value names (`2026-07-27`, `2026-07-27T10:30`), because a zone's offset depends
   * on the date it is asked about and half the world's do change twice a year.
   *
   * Optional, and without it a date binds the way it always did: at whatever the interpreter calls
   * local. `properties/note.ts` supplies one built from the reader's setting, falling back to their
   * own zone — so in practice every binding is explicitly zoned, and the surfaces cannot disagree
   * about what a note's dates mean. Kept as a callback rather than a zone name so this file stays
   * free of `Intl` and of the settings that choose it; `properties/zone.ts` does that resolving.
   */
  defaultOffset?: (isoLocal: string) => string | null;

  /**
   * The UTC offset a *named* zone was at a given wall clock — what resolves the `[Europe/Berlin]`
   * of a floating value into something Numbat can read, since `datetime("…")` takes an offset and
   * never a name.
   *
   * Asked per value, which is the whole point of storing a name instead of an offset: the same zone
   * owes a date in January and one in July different answers. Optional and a callback for the same
   * reasons as {@link defaultOffset} — this file holds no `Intl` and no settings.
   */
  zoneOffset?: (zone: string, isoLocal: string) => string | null;

  /** Disambiguates the struct type names an object binding generates. A note's properties and those
   *  of every note it imports replay into one interpreter, and a repeated `struct` definition is a
   *  hard error (where a repeated `let` is harmless), so the emitting note's path goes here.
   *  Defaults to `""`, which is safe for a note that imports nothing. */
  namespace?: string;
}

/** Property types whose value is a checkbox — the tri-state core one, whose *unset* state is a
 *  `null` that binds `false`, and Better Properties' two-state toggle. */
const CHECKBOX_TYPES: ReadonlySet<string> = new Set(["checkbox", "better-properties:toggle"]);

/**
 * This plugin's own date type, whose values are `YYYY-MM-DD` with an optional `±HH:MM` suffix —
 * the one shape that can name a zone and still be a date. It is not Obsidian's `date`, and that is
 * deliberate: a suffixed date is not a YAML timestamp and not valid ISO 8601, so putting it under
 * Obsidian's type would hand a broken value to everything that reads dates natively. Under our own
 * type there is no such contract to break. The widget is in properties/date-type.ts.
 *
 * A compatibility contract once shipped, like the `VIEW_TYPE_*` ids: it is persisted in the vault's
 * `types.json` against every property assigned it, so renaming it silently un-types them all.
 */
export const ZONED_DATE_TYPE = "numbat:zoneddate";

/**
 * The datetime counterpart, whose values are full RFC 9557: an RFC 3339 timestamp followed by the
 * zone name, `2026-07-27T10:30:00+02:00[Europe/Berlin]`.
 *
 * Both halves earn their place. The bracketed name is what makes the value *float* — move its date
 * across a daylight saving boundary and the instant moves with it, where a bare offset would pin
 * the old one. The offset in front keeps the value **lexically sortable** and makes its prefix a
 * valid RFC 3339 timestamp, so a reader that stops at the bracket still gets the right instant.
 *
 * It exists for the same reason {@link ZONED_DATE_TYPE} does: neither moment (frozen at 2.29, years
 * before RFC 9557) nor `new Date` will parse the bracketed form, so under Obsidian's own Datetime
 * type the value would be an invalid date to Bases, to sorting, and to every other plugin. A value
 * that needs to stay legible to those belongs under Obsidian's own Datetime type, which this plugin
 * reads and never writes.
 */
export const ZONED_DATETIME_TYPE = "numbat:zoneddatetime";

/**
 * Property types whose value is a date, so text under one reads as a date rather than as text.
 *
 * {@link ZONED_DATE_TYPE} is this plugin's own, and the only one of them whose values can carry a
 * zone without also carrying a time of day. The rest are Obsidian's and Better Properties'.
 */
const DATE_TYPES: ReadonlySet<string> = new Set([
  "date",
  "datetime",
  "better-properties:datecustom",
  ZONED_DATE_TYPE,
  ZONED_DATETIME_TYPE,
]);

/**
 * Top-level keys that never ride along untyped: this plugin's own `numbat-use`, which names the
 * notes to import rather than holding data, and the three Obsidian keeps for itself. They are vault
 * machinery, they are on a great many notes, and binding them would put `tags` and `aliases` into
 * the namespace of nearly every note that has any frontmatter at all.
 *
 * Assigning one the Numbat type still binds it — an explicit choice beats this default — and the
 * names are only special at the top level, so a `meta.tags` of your own is your data.
 */
export const UNBOUND_KEYS: ReadonlySet<string> = new Set(["numbat-use", "tags", "aliases", "cssclasses"]);

/** The value of a numbat-typed property as an expression string, or `null` when the value's shape
 *  cannot hold one (a list, an object, a boolean toggle). */
function expressionText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

// PLAIN VALUES AS NUMBAT LITERALS
// ================================================================================================

/** Which kind of untyped value a binding rode along as — one per {@link PlainBindings} setting. */
export type PlainKind = "number" | "text" | "date" | "boolean";

/**
 * A string as a Numbat string literal.
 *
 * `\` and `"` escape as they do everywhere, but the one that matters is **`{`**: Numbat strings
 * interpolate, so an unescaped `"cost {rate}"` would evaluate `rate` — or fail to compile against a
 * name that happens not to exist. Braces double to escape, and a literal newline or tab is written
 * as its escape so the emitted statement stays one line.
 *
 * The backslash pass runs first, so the backslashes the later passes introduce are not doubled in
 * turn; the brace passes introduce none.
 */
function stringLiteral(text: string): string {
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\{/g, "{{")
    .replace(/\}/g, "}}")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");

  return `"${escaped}"`;
}

/**
 * A date, optionally with a time, and optionally zoned two different ways — `2026-07-27`,
 * `2026-07-27 10:30`, `2026-07-27T10:30:00.5+02:00`, `2026-07-27 +02:00`,
 * `2026-07-27 [Europe/Berlin]`. Matched textually rather than parsed into a `Date`, so no timezone
 * conversion can happen behind the scenes.
 *
 * Two things here are wider than ISO 8601, and each buys something:
 *
 *  - **The offset sits outside the time group**, so a date can carry one without a time of day,
 *    with optional space between (`2026-07-27 +02:00`). The space is what properties/zone.ts's
 *    `applyZone` writes, since `2026-07-27-07:00` is a counting exercise; the form without it is
 *    what it used to write, and is admitted so that every value already in a vault reads.
 *  - **A bracketed IANA name** (`[Europe/Berlin]`) is RFC 9557's spelling — the standard for
 *    attaching a zone to a timestamp, and what `Temporal.ZonedDateTime` round-trips. It says
 *    something an offset cannot: that the value *floats*, so moving its date across a daylight
 *    saving boundary moves the instant with it. An offset pins one instant forever.
 *
 * Both may appear, as RFC 9557 allows, and a name present wins: it is the more specific statement,
 * and it is the only one of the two that can still be right after the date beside it changes.
 *
 * A **lowercase `z`** is admitted alongside `Z` for the same reason the compact `+0200` is: this is
 * the grammar for what someone may have typed, and reading a value is not the place to be strict
 * about a spelling that means exactly one thing. Numbat itself takes either. Both are canonicalized
 * the moment a widget writes the value back — properties/zone.ts's `normalizeOffset` is where that
 * happens, and it accepts precisely these spellings, which is what makes the two grammars one.
 *
 * The zone forms are written by the `numbat:zoneddate` and `numbat:zoneddatetime` property types.
 * Neither is a YAML timestamp, which is exactly why they live under types of ours rather than under
 * Obsidian's Date and Datetime — see properties/date-type.ts.
 */
export const DATE_TEXT =
  /^(\d{4}-\d{2}-\d{2})(?:[T\x20](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?)?\x20*([Zz]|[+-]\d{2}:?\d{2})?(?:\[([^\]\x20]+)\])?$/;

/**
 * The Numbat expression for a date written as `date`, `time` and `zone` parts, in the *calendar
 * fields as written* — no conversion, ever.
 *
 * The zone is the one thing that can be filled in rather than read off, and there are four places
 * it comes from, in order:
 *
 *  - **A bracketed zone name in the value** (`[Europe/Berlin]`) is resolved through {@link
 *    PreambleRules.zoneOffset} *at this value's own wall clock*. It comes first because it is the
 *    more specific statement: a name says which zone was meant, so it stays right after the date
 *    beside it changes, where the offset RFC 9557 writes in front of it would go stale.
 *  - **An offset in the value** is kept verbatim, in the `T` form that requires one. This is the
 *    only case that reads the same whatever the reader's settings.
 *  - **Otherwise {@link PreambleRules.defaultOffset}**, asked for this value's own wall clock so a
 *    date in January and one in July get the offset their zone actually had. A date with no time is
 *    that zone's midnight — a `due:` on a note is a day in someone's life, not a day in UTC.
 *  - **Otherwise nothing**, and the value binds the way it did before there was a setting for it:
 *    `date("2026-07-27")` for a date, which Numbat reads as local midnight, and the *space*
 *    -separated `datetime("2026-07-27 10:30:00")` for a time, which it reads as local wall clock.
 *    (The `T`-separated form is a runtime error without an offset, which is exactly the shape
 *    Better Properties writes, so the separator is swapped.)
 *
 * A name that will not resolve — an unknown zone, or a caller that supplied no resolver — falls
 * through to the cases below it rather than failing the binding. The value still names a moment;
 * only the reader's opinion of which one is less certain.
 *
 * **A value that carries a zone is also displayed in it**, through `-> tz(...)`. Numbat renders
 * every `DateTime` in the machine's own zone, so without this a note saying
 * `2026-07-27T09:00-07:00` reads back `17:00` in Berlin — the same instant, correctly converted,
 * and not the appointment the note is about. The conversion returns a `DateTime`, so this is a
 * display concern only: the value stays the same moment, and arithmetic against it is untouched.
 *
 * It applies only to a zone the *value* carries, never to {@link PreambleRules.defaultOffset}. A
 * value read by default is being read in the reader's own zone, which is the one Numbat would show
 * it in anyway. What each case can name is {@link namedDisplayZone} and {@link fixedDisplayZone}.
 *
 * Numbat wants whole seconds, so a bare `HH:MM` is filled out and a fractional second dropped —
 * frontmatter that carries one is being read as a moment, not as a measurement.
 */
function dateExpression(
  date: string,
  time: string | undefined,
  zone: string | undefined,
  name: string | undefined,
  rules: PreambleRules,
): string {
  const seconds = time === undefined ? "00:00:00" : time.length === 5 ? `${time}:00` : time;
  const wall = time === undefined ? date : `${date}T${time}`;
  const named = name === undefined ? null : rules.zoneOffset?.(name, wall) ?? null;
  const offset = named ?? zone ?? rules.defaultOffset?.(wall) ?? null;

  if (offset !== null) {
    const stamp = `datetime("${date}T${seconds}${offset}")`;
    // Only from a zone the *value itself* carries. A default-offset value is being read in the
    // reader's own zone, which is the one Numbat shows it in already.
    const shown = named !== null && name !== undefined ? namedDisplayZone(name) : fixedDisplayZone(zone);
    return shown === null ? stamp : `${stamp} -> tz("${shown}")`;
  }

  return time === undefined ? `date("${date}")` : `datetime("${date} ${seconds}")`;
}

/**
 * A zone name safe to write into generated Numbat source.
 *
 * {@link DATE_TEXT} accepts anything without a space or a `]` between the brackets, which includes
 * a quote — and a quote would close the string literal this goes into and turn a note's frontmatter
 * into arbitrary Numbat. In practice a name that got this far already resolved through {@link
 * PreambleRules.zoneOffset}, so `Intl` has vouched for it; this is the belt to that's braces, and
 * it costs one regex.
 */
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/** A fixed offset in either spelling {@link DATE_TEXT} admits. */
const PLAIN_OFFSET = /^(?:([Zz])|([+-])(\d{2}):?(\d{2}))$/;

/** The `Etc/GMT±H` zones exist for whole hours from −14 through +12 — those are the bounds, and
 *  they are the *offset's*, so they read backwards from the names. See {@link fixedDisplayZone}. */
const MAX_EAST_HOURS = 14;
const MAX_WEST_HOURS = 12;

/** {@link dateExpression}'s display zone for a value that names one. */
function namedDisplayZone(name: string): string | null {
  return ZONE_NAME.test(name) ? name : null;
}

/**
 * {@link dateExpression}'s display zone for a value that carries only an **offset**, as the IANA
 * name of the zone fixed at it — or `null` when there is none.
 *
 * `Etc/GMT+7` **is** UTC−07:00. The sign is inverted, which looks like a bug and is POSIX's rule,
 * kept by the IANA database ever since. It is what makes these usable here: they are fixed by
 * definition, so displaying a value in one cannot move its wall clock the way a populated zone with
 * a daylight saving rule could.
 *
 * They exist only for whole hours, so `+05:45` and `+03:30` get nothing and their values stay in
 * the reader's own zone. The alternative would be to name a *place* at that offset —
 * `Asia/Kathmandu` for `+05:45` — which would put a location into a value that never claimed one,
 * and for the ones that observe daylight saving would show the wrong clock half the year.
 */
function fixedDisplayZone(offset: string | undefined): string | null {
  const match = offset === undefined ? null : PLAIN_OFFSET.exec(offset);
  if (match === null) {
    return null;
  }

  const [, zulu, sign, hours, minutes] = match;
  if (zulu !== undefined) {
    return "UTC";
  }
  if (Number(minutes) !== 0) {
    return null;
  }

  const magnitude = Number(hours);
  if (magnitude === 0) {
    return "UTC";
  }

  // An offset outside the range the `Etc` zones cover is a typo rather than a zone, and naming a
  // zone that does not exist would fail the binding at runtime — where leaving it alone only shows
  // the value in the reader's own zone.
  const east = sign === "+";
  if (magnitude > (east ? MAX_EAST_HOURS : MAX_WEST_HOURS)) {
    return null;
  }

  return `Etc/GMT${east ? "-" : "+"}${magnitude}`;
}

/** The two-digit form of a date or clock field. */
function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * A YAML timestamp — which the note's own YAML parses to a `Date` — written back out as the text it
 * was, so a value that arrives parsed and the same value read from Obsidian's property cache (which
 * stores plain data, and hands the derivation text) go on to read *exactly* alike.
 *
 * Read in **UTC**, because that is the zone YAML assigns a timestamp written without one, so the
 * fields come back exactly as they were written. A value at midnight is taken to have been a date
 * with no time at all: that is what `due: 2026-07-27` is, and it is overwhelmingly more common than
 * an explicitly zoned midnight, which is the one reading this rounds off.
 *
 * A timestamp written *with* an offset is the other. Parsing has already collapsed it to an instant
 * by then, and `2026-07-27T10:30+02:00` is indistinguishable from a bare `2026-07-27 08:30` — so it
 * comes back as the latter, shifted from what the note says. Reading it the other way would cost
 * the local-wall-clock reading of the offset-less form, which is the far commoner shape, so this
 * takes the offset-less side. The cache keeps the offset verbatim, so a zoned timestamp is the one
 * value the two surfaces still read differently; `docs/roadmap.md` lists it.
 */
function dateFromValue(value: Date): string | null {
  const stamp = value.getTime();
  if (!Number.isFinite(stamp)) {
    return null;
  }

  const date = `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  if (date.length !== 10) {
    return null; // a year outside four digits is not a note's due date
  }

  const midnight = value.getUTCHours() === 0 && value.getUTCMinutes() === 0
    && value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0;

  return midnight
    ? date
    : `${date} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
}

/**
 * What an untyped value is read against: the {@link PlainBindings} in force at the depth being
 * read, and the rules behind them. A {@link Walk} is one — which is how the binding walk passes
 * itself — and {@link topLevelReading} builds the other, so the gate can ask what *would* have
 * bound at the top level using the same readings the walk uses.
 */
interface Reading {
  /** Which untyped values bind here. */
  plain: PlainBindings;

  /** The rules the walk runs under, for the type registry. */
  rules: PreambleRules;
}

/** The reading at the top level — where {@link PreambleRules.plain} is the rule, by definition. */
function topLevelReading(rules: PreambleRules): Reading {
  return { plain: rules.plain, rules };
}

/**
 * The Numbat literal an *untyped* value rides along as, or `null` when its kind does not bind —
 * either because the setting for it is off, or because nothing sensible could be written.
 *
 * `key` is the property's dotted path, which the two type-directed readings need: an unset checkbox
 * (a `null` that means `false`) and a date, which is only ever read as one under a property the
 * type menu says is a date.
 */
function plainExpression(reading: Reading, key: string, value: unknown): { expr: string; kind: PlainKind; } | null {
  const { plain } = reading;
  const declared = () => reading.rules.assignedType?.(key) ?? null;

  if (typeof value === "number") {
    return plain.numbers && Number.isFinite(value) ? { expr: String(value), kind: "number" } : null;
  }

  if (typeof value === "boolean") {
    return plain.booleans ? { expr: String(value), kind: "boolean" } : null;
  }

  // An empty property parses to `null` whatever it is, so only a *declared* checkbox reads as the
  // unticked box it is; everything else empty stays out.
  if (value === null) {
    return plain.booleans && CHECKBOX_TYPES.has(declared() ?? "") ? { expr: "false", kind: "boolean" } : null;
  }

  // A timestamp the note's own YAML parsed for us is read as the text it was written as, because
  // that is what every other surface is handed (see dateFromValue). From here the two are one path.
  const text = value instanceof Date ? dateFromValue(value) : typeof value === "string" ? value : null;
  if (text === null) {
    return null;
  }

  // A date is a date only under a property *explicitly* assigned Obsidian's Date type. Obsidian
  // shows its date picker for a date-shaped value without assigning anything, so the value's shape
  // is not the opt-in it looks like — and a version, an ID or a bare year would read as a moment on
  // the strength of looking like one. Text that is not a declared date is text.
  if (plain.dates && DATE_TYPES.has(declared() ?? "")) {
    const match = DATE_TEXT.exec(text.trim());
    if (match !== null) {
      return { expr: dateExpression(match[1], match[2], match[3], match[4], reading.rules), kind: "date" };
    }
  }

  return plain.text ? { expr: stringLiteral(text), kind: "text" } : null;
}

/** The {@link PlainBindings} in force below the top level — the nested rule when the caller set
 *  one, and otherwise the same rule as everywhere else. */
function nestedPlain(rules: PreambleRules): PlainBindings {
  return rules.plainNested ?? rules.plain;
}

/**
 * Whether anything under `value` would have bound *at the top level* — the gate {@link
 * PreambleRules.plainNested} turns on, so an object binds only when something in it was actually
 * asked for, rather than riding in whole on the nested rule.
 *
 * `reading` is therefore always {@link topLevelReading}: every leaf is put to the reading it would
 * have got as a property of its own, so the gate follows the reader's settings rather than a rule
 * of its own. On the export path, where nothing untyped binds at the top level, that reduces to
 * "some leaf under it is numbat-typed".
 *
 * An array counts through its item key (`legs.#`, {@link ARRAY_ITEM}) as well as its own, matching
 * how {@link leafExpression} reads one. `depth` is the depth the binding walk processes `value` at,
 * so the two agree on what is in reach: {@link MAX_PROPERTY_DEPTH} stops the *descent* into a
 * nested container (never a leaf, which the walk binds at any depth), and a cyclic YAML anchor is
 * guarded the same way {@link walkObject} guards it. Reporting less than the walk can bind would
 * drop a binding silently, so where the two could differ this errs towards saying yes.
 */
function hasBindableLeaf(
  reading: Reading,
  value: unknown,
  path: string[],
  depth: number,
  ancestors: Set<object>,
): boolean {
  const { rules } = reading;

  if (Array.isArray(value)) {
    // {@link leafExpression}'s own reading of an array: typed by its key or its item key, and
    // otherwise riding along exactly where a lone untyped value would.
    const { numbers, text, dates, booleans } = reading.plain;
    if (
      rules.isNumbatTyped(dottedKey(path)) || rules.isNumbatTyped(dottedKey([...path, ARRAY_ITEM]))
      || numbers || text || dates || booleans
    ) {
      return true;
    }

    return descend(reading, value.map((item) => [ARRAY_ITEM, item] as const), path, depth, ancestors);
  }

  if (isPlainObject(value)) {
    return descend(reading, Object.entries(value), path, depth, ancestors);
  }

  const key = dottedKey(path);
  if (rules.isNumbatTyped(key)) {
    return true;
  }

  // An empty property binds only where the type menu names its kind; a filled one wherever its own
  // kind is switched on. Both are the readings {@link leafExpression} makes of the same value.
  return isAbsent(reading, key, value, false)
    ? declaredKind(reading, key) !== null
    : plainExpression(reading, key, value) !== null;
}

/** The shared recursion of {@link hasBindableLeaf}: each child at its own path, with the walk's own
 *  two guards — the depth limit and a cyclic YAML anchor — applied where the walk applies them,
 *  which is to a nested container and never to a leaf. */
function descend(
  reading: Reading,
  children: readonly (readonly [string, unknown])[],
  path: string[],
  depth: number,
  ancestors: Set<object>,
): boolean {
  return children.some(([key, child]) => {
    const here = [...path, key];
    if (!Array.isArray(child) && !isPlainObject(child)) {
      return hasBindableLeaf(reading, child, here, depth + 1, ancestors);
    }

    if (depth >= MAX_PROPERTY_DEPTH || ancestors.has(child)) {
      return false;
    }

    ancestors.add(child);
    try {
      return hasBindableLeaf(reading, child, here, depth + 1, ancestors);
    } finally {
      ancestors.delete(child);
    }
  });
}

/** One bound field of an object under construction: a leaf (`children === null`) or a nested
 *  object, in the order the fields were bound. */
interface FieldNode {
  /** The field's Numbat-safe name within its parent struct. */
  name: string;

  /** The nested object's fields, or `null` when this is a leaf. */
  children: FieldNode[] | null;
}

/** An object property mid-derivation. The root name is claimed lazily — on the first leaf that
 *  actually binds — so an object holding nothing bindable stays silent instead of reserving a name
 *  or reporting a skip. */
interface ObjectState {
  /** The object's frontmatter key, as written. */
  rootKey: string;

  /** The Numbat name the object will bind, once a leaf claims it. */
  rootName: string;

  /** A digest of the object's shape, so two identically-shaped objects share one generated `struct`
   *  rather than declaring a duplicate. */
  hash: string;

  /** The fields bound so far, in binding order. */
  fields: FieldNode[];

  /** Distinguishes same-shaped objects that nonetheless need separate structs. */
  generation: number;

  /** Whether {@link rootName} has been reserved — deferred until the first leaf actually binds, so
   *  an object with nothing bindable reserves no name. */
  claimed: boolean;

  /** Whether derivation gave up on this object, so its remaining leaves are skipped rather than
   *  half-bound. */
  failed: boolean;
}

/** The derivation's running state, threaded through the walk. */
interface Walk {
  /** What the walk is allowed to bind — reserved names, the type registry. */
  rules: PreambleRules;

  /** The {@link PlainBindings} in force *here*: `rules.plain` at the top level, and
   *  `rules.plainNested` below it. Swapped by the two places that descend (an object property, and
   *  an array's items) and restored on the way out, so every reading of an untyped value asks about
   *  the depth it is actually at. */
  plain: PlainBindings;

  /** Bindings accumulated so far, in frontmatter order. */
  bindings: PropertyBinding[];

  /** Skips accumulated so far. */
  skips: PropertySkip[];

  /** Top-level Numbat names already bound — object roots included, since an object binds a `let` of
   *  its own name like any other property. */
  taken: Set<string>;
}

// ARRAYS AS LISTS
// ================================================================================================

/**
 * What one item of a list is, to the depth Numbat's list types care about — which is all the way
 * down, since a list is homogeneous at every level: a nested list's elements must agree, and so
 * must the fields of a struct element, or the list Numbat is handed does not type.
 *
 * Every item of a *typed* array is an `expression`, so the agreement check is vacuous there and the
 * type error stays Numbat's to report.
 */
interface ItemKind {
  /** What is held here, or `null` when nothing concrete has been seen yet: the element of an empty
   *  list, which has no element type to disagree with and so fits beside any list. */
  shape: ItemShape | null;

  /** Whether anything at this position was *absent*, so every item must write it as a nullable —
   *  see {@link renderNode}. This is what separates an absence (`shape: null, nullable: true`) from
   *  an empty list's element (`shape: null, nullable: false`), which are otherwise alike and must
   *  not merge: the first makes its neighbours nullable, the second must never make `[[], [1],
   *  ["a"]]` bind. */
  nullable: boolean;
}

/** What one item holds, to the depth Numbat's list types care about. */
type ItemShape =
  /** A scalar: the plain kind it rode along as, or an expression whose type only Numbat knows. */
  | { of: PlainKind | "expression"; }
  /** A list, and the kind of its own elements. */
  | { of: "list"; element: ItemKind; }
  /** An object, and the fields it bound. */
  | { of: "struct"; fields: ItemField[]; };

/** One bound field of an array element's struct type: its Numbat name, and what it holds — which
 *  every other element's field of that name is held to. */
interface ItemField {
  /** The field's Numbat name within its element's struct. */
  name: string;

  /** What the field holds, to the same depth as any other kind. */
  kind: ItemKind;
}

/**
 * One position of an array element as the walk found it, rendered to Numbat source afterwards.
 *
 * Deliberately free of type information: whether a position has to be written as a nullable is only
 * known once *every* sibling has been seen — a field written empty in item 1 and as a number in
 * item 3 has to be nullable in both — so the walk records what is there and {@link renderNode}
 * decides how it is written.
 */
type ItemNode =
  /** An explicit absence: an empty property at this position. */
  | { of: "absent"; }
  /** A leaf, as the Numbat literal or expression it rode along as. `written` is what stood here
   *  before {@link groundItemZero} substituted for it, and is present only where it did — see
   *  {@link PropertyBinding.written} for what wants it. */
  | { of: "scalar"; expr: string; written?: string; }
  /** A nested list. */
  | { of: "list"; items: ItemNode[]; }
  /** An object, at the dotted item path its struct type is minted under. */
  | { of: "struct"; path: string; fields: { name: string; node: ItemNode; }[]; };

/** One built array element: what was found, and what its siblings are held to. */
interface ItemValue {
  /** The element as found, awaiting rendering. */
  node: ItemNode;

  /** The kind every sibling must match, so an untyped `[1, "a"]` — or `[{a: 1}, {a: "x"}]`, which
   *  differs only under its field names — stays out rather than binding a list Numbat rejects. */
  kind: ItemKind;
}

/** An element position nothing concrete has reached: an empty list's element. */
const OPEN_KIND: ItemKind = { shape: null, nullable: false };

/** A position that held an absence. */
const ABSENT_KIND: ItemKind = { shape: null, nullable: true };

/** The kind of a position holding exactly `shape`, with nothing absent in it. */
function kindOf(shape: ItemShape): ItemKind {
  return { shape, nullable: false };
}

/** One array binding under construction. */
interface ListState {
  /** The `struct` definitions the array's element type needs, innermost first — empty unless the
   *  array holds objects. */
  defs: string[];

  /** A digest of the emitting note and the array's item path, keeping the generated struct names
   *  apart from every other property's (a repeated `struct` definition is a hard error). */
  hash: string;

  /** The struct name minted for each object position inside the array, by its dotted path. One type
   *  per position, shared by every element — which is what makes the list homogeneous. */
  structs: Map<string, string>;

  /** Field-level skips found while building, held back until the array binds: an array that binds
   *  nothing reports itself, and has no business also reporting its insides. */
  skips: PropertySkip[];

  /** Item paths already reported in {@link skips}, so a bad field name is reported once for the
   *  array rather than once per element. */
  reported: Set<string>;

  /** Why the array bound nothing — the first failure, reported on the array itself. */
  error: string | null;

  /** Whether anything inside bound as an expression — a field of an array of objects can carry the
   *  Numbat type even when the array itself does not. */
  expressions: boolean;

  /** The item paths where a **numbat-typed** bare zero was grounded (see {@link groundItemZero}),
   *  deduplicated — every element of an array shares one path, so a list of ten zeros has one entry
   *  and reports once. Empty for the plain numbers grounded beside them, which say nothing, exactly
   *  as {@link zeroWarning} explains for a lone one. */
  grounded: Set<string>;
}

/**
 * Whether two elements agree, at every depth — the homogeneity a Numbat list requires, and the one
 * an Array property already promises.
 *
 * Struct fields are matched by name rather than by position, because Numbat constructs a struct by
 * naming its fields and takes them in any order: two items that write the same keys in a different
 * order are the same element, and there is no reason to refuse them.
 *
 * The comparison goes all the way down rather than stopping at "both structs" / "both lists",
 * because that is where Numbat's own check goes: `[{a: 1}, {a: "x"}]` shares one generated element
 * type whose field cannot be both `Scalar` and `String`, and `[[1, 2], ["a"]]` is two lists that
 * cannot share an element type. Untyped, both must stay out — a property nobody opted in should
 * never volunteer an error.
 */
function sameKind(a: ItemKind, b: ItemKind): boolean {
  // A position nothing concrete has reached — an empty list's element — agrees with anything, and
  // Numbat gives it whatever its neighbours have.
  if (a.shape === null || b.shape === null) {
    return true;
  }

  return sameShape(a.shape, b.shape);
}

/** Whether two concrete shapes agree — {@link sameKind} once both sides are known. */
function sameShape(a: ItemShape, b: ItemShape): boolean {
  if (a.of === "list") {
    return b.of === "list" && sameKind(a.element, b.element);
  }

  if (a.of === "struct") {
    if (b.of !== "struct") {
      return false;
    }

    // A field only one side has is *absent* on the other, which is a hole like any other: an item
    // that leaves a key out binds alike, with that field undefined. Only a shared name whose
    // contents disagree is a real disagreement.
    return a.fields.every((field) => {
      const other = b.fields.find((candidate) => candidate.name === field.name);
      return other === undefined || sameKind(field.kind, other.kind);
    });
  }

  return a.of === b.of;
}

/** The name of the first field two struct shapes both have and disagree under, quoted for a
 *  message, or `null` when they do not disagree that way. Only for naming the culprit in
 *  {@link listItems}' error — the check itself is {@link sameShape}'s. */
function disagreeingField(a: ItemShape, b: ItemShape): string | null {
  if (a.of !== "struct" || b.of !== "struct") {
    return null;
  }

  for (const field of a.fields) {
    const other = b.fields.find((candidate) => candidate.name === field.name);
    if (other !== undefined && !sameKind(field.kind, other.kind)) {
      return `'${field.name}'`;
    }
  }

  return null;
}

/**
 * The more informative of two kinds that already {@link sameKind} — what the items seen so far
 * collectively hold.
 *
 * Only an empty list makes the two differ, and only by having no element type where the other has
 * one. Folding it in is what keeps the agreement check honest past the second item: every item is
 * compared against the first, so without this `[[], [1], ["a"]]` would pass twice over against an
 * element type that never became concrete, and bind a list Numbat rejects.
 */
function refine(a: ItemKind, b: ItemKind): ItemKind {
  return { shape: mergeShape(a.shape, b.shape), nullable: a.nullable || b.nullable };
}

/** The more informative of two shapes, either of which may still be unknown. */
function mergeShape(a: ItemShape | null, b: ItemShape | null): ItemShape | null {
  if (a === null || b === null) {
    return a ?? b;
  }

  if (a.of === "list" && b.of === "list") {
    return { of: "list", element: refine(a.element, b.element) };
  }

  if (a.of === "struct" && b.of === "struct") {
    // The union of both sides' fields, in `a`'s order — a field one side lacks held an absence
    // there, so it survives into the joined type as a nullable one.
    const fields = a.fields.map((field) => {
      const other = b.fields.find((candidate) => candidate.name === field.name);
      return { name: field.name, kind: refine(field.kind, other?.kind ?? ABSENT_KIND) };
    });

    for (const field of b.fields) {
      if (!a.fields.some((candidate) => candidate.name === field.name)) {
        fields.push({ name: field.name, kind: refine(field.kind, ABSENT_KIND) });
      }
    }

    return { of: "struct", fields };
  }

  return a;
}

/**
 * The joined kind with every struct field that carries no type removed, or `null` when nothing is
 * left to write at all.
 *
 * Three things need this. A field every item leaves empty has nothing to say, and would put a
 * column of `undefined` into the element type for no reason. It is what keeps the reader's
 * {@link PlainBindings} settings out of the shape: with text off, `[{w: 80, note: "am"}, {w: 81,
 * note: null}]` drops `note` from the first item as a non-participant and holds it as an absence in
 * the second, so without this the array would grow the `note` the setting exists to keep out. And —
 * the reason the test is {@link isTypeFree} rather than "was anything ever here" — a field that is
 * *typeless* rather than merely empty leaves the whole generated element type polymorphic, which
 * costs every **other** field of that element as well: `[{w: 80, marks: [,]}]` would bind a
 * `marks: List<Opt<A>>` for free `A`, and `element_at(0, legs).w` would then fail to typecheck.
 * That is the same failure {@link bindNested} refuses a type-free leaf to avoid.
 *
 * Only struct *fields* are dropped. A list element that was never filled is still an element —
 * `[null, null]` binds two undefined values, and no struct is involved for it to poison — and an
 * object left with no fields at all cannot be written as a Numbat struct, so it collapses to `null`
 * and takes its array with it, exactly as an element holding nothing bindable already does.
 */
function normalize(kind: ItemKind): ItemKind | null {
  const { shape } = kind;
  if (shape === null || shape.of !== "struct" && shape.of !== "list") {
    return kind;
  }

  if (shape.of === "list") {
    const element = normalize(shape.element);
    return element === null ? null : { shape: { of: "list", element }, nullable: kind.nullable };
  }

  const fields: ItemField[] = [];
  for (const field of shape.fields) {
    // A type-free field is one every item left empty (`shape === null`) or filled only with
    // emptiness (`[]`, `[,]`) — neither says what it holds, and a field that does not say cannot
    // be written here at all. See above.
    const kept = isTypeFree(field.kind) ? null : normalize(field.kind);
    if (kept !== null) {
      fields.push({ name: field.name, kind: kept });
    }
  }

  return fields.length === 0 ? null : { shape: { of: "struct", fields }, nullable: kind.nullable };
}

/**
 * The plain kind an untyped array's own binding reports — the scalar its items ultimately hold,
 * seen through any nesting — or `null` when there is nothing scalar in it to go on (an empty array,
 * or one of objects).
 */
function scalarKind(kind: ItemKind): PlainKind | null {
  const { shape } = kind;
  if (shape === null) {
    return null;
  }

  if (shape.of === "list") {
    return scalarKind(shape.element);
  }

  return shape.of === "struct" || shape.of === "expression" ? null : shape.of;
}

/**
 * A YAML array as a Numbat list literal, or `null` when it holds something a list cannot.
 *
 * `typed` is the numbat-typed reading, where each item is an expression in its own right
 * (`["5 EUR", "3 EUR"]` → `[(5 EUR), (3 EUR)]` — parenthesized for the same reason a scalar binding
 * is, so an item like `5 km + 3 mi` stays one element). Without it the items ride along under the
 * same rules a lone value does, so which kinds are in play is the reader's own settings.
 *
 * Every item must bind, and bind the same kind all the way down (see {@link sameKind}) — a list has
 * no room for a hole, and Numbat's lists are homogeneous. That check is deliberately vacuous for a
 * *typed* array, whose items are all expressions: `[1, "2 m"]` binds and Numbat's own type error is
 * a better message than anything guessable here. Untyped, the same array simply stays out: a
 * property nobody opted in should never volunteer an error.
 *
 * The element kind comes back with the literal, so a list nested inside another carries what it
 * holds into its own agreement check.
 */
function listItems(
  walk: Walk,
  state: ListState,
  path: string[],
  items: readonly unknown[],
  typed: boolean,
  depth: number,
  ancestors: Set<object>,
  inStruct: boolean,
): { items: ItemNode[]; element: ItemKind; } | null {
  const itemPath = [...path, ARRAY_ITEM];
  const nodes: ItemNode[] = [];

  // What the items seen so far collectively hold, which the next one is held to.
  let first: ItemKind | undefined;

  for (const [index, item] of items.entries()) {
    const built = itemValue(walk, state, itemPath, item, typed, depth + 1, ancestors, inStruct);
    if (built === null) {
      state.error ??= `item ${index + 1} holds nothing Numbat can bind`;
      return null;
    }

    if (first === undefined) {
      first = built.kind;
    } else if (!sameKind(first, built.kind)) {
      // A *missing* field is no longer a disagreement (it binds as undefined, see sameShape), so
      // two objects can only fall out here over a field they both have.
      state.error ??= first.shape?.of === "struct" && built.kind.shape?.of === "struct"
        ? `item ${index + 1} holds something different under ${
          disagreeingField(first.shape, built.kind.shape) ?? "one of its keys"
        } than item 1 does — every item of an array binds alike`
        : `item ${index + 1} is not the same kind of value as item 1 — a Numbat list holds one type`;
      return null;
    } else {
      // Each item is held to the first, so what the first is missing (the element type of an empty
      // list, or a field only a later item fills) has to be folded back in, or a third item could
      // disagree with the second unchecked.
      first = refine(first, built.kind);
    }

    nodes.push(built.node);
  }

  return { items: nodes, element: first ?? OPEN_KIND };
}

/**
 * Whether this position is *undefined* — the `null` an empty property parses to, or an empty
 * expression under a numbat-typed key — so it binds a hole rather than nothing at all.
 *
 * Three things that look like an absence are not one, and the distinctions are the whole of this
 * function:
 *
 *  - A value the reader's {@link PlainBindings} settings do not bind is a **non-participant**, not
 *    a hole. Binding it as `undefined` would put back exactly what the setting exists to keep out.
 *  - An **unset checkbox** is `false` (see {@link plainExpression}), which is what Obsidian's
 *    tri-state Checkbox means by an empty value, and it is a value rather than the lack of one.
 *  - A value of a **shape Numbat cannot hold** under a typed key — a boolean, an object — is still
 *    `unsupported`: the reader wrote something, and it is worth telling them it did not land.
 */
function isAbsent(reading: Reading, key: string, value: unknown, typed: boolean): boolean {
  if (typed) {
    return value === null || expressionText(value) === "";
  }

  return value === null && !CHECKBOX_TYPES.has(reading.rules.assignedType?.(key) ?? "");
}

/**
 * One element (or one field of one), built at its own path. `typed` is that path's reading, as
 * already resolved by the caller.
 *
 * `inStruct` is whether what is built here ends up **inside a generated struct**, which is the one
 * place a bare zero is fatal (see {@link groundZero}) and so the one place it is substituted. It
 * only ever goes false → true, at the two doors into a struct: an array that is itself an object's
 * field, and every field of an object found inside an array. A list that reaches neither keeps its
 * polymorphic zeros, for the same reason a lone top-level `0` does — `let weights = [0, 0]`
 * generalizes and reads back, so nothing is bought by narrowing it.
 */
function itemValue(
  walk: Walk,
  state: ListState,
  path: string[],
  value: unknown,
  typed: boolean,
  depth: number,
  ancestors: Set<object>,
  inStruct: boolean,
): ItemValue | null {
  if (Array.isArray(value) || isPlainObject(value)) {
    // A YAML anchor can make the value genuinely cyclic, and a deep one merely absurd; neither
    // guard covers the other.
    if (depth >= MAX_PROPERTY_DEPTH || ancestors.has(value)) {
      return null;
    }

    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const nested = listItems(
          walk,
          state,
          path,
          value,
          typed || walk.rules.isNumbatTyped(dottedKey([...path, ARRAY_ITEM])),
          depth,
          ancestors,
          inStruct,
        );
        return nested === null ? null : {
          node: { of: "list", items: nested.items },
          kind: kindOf({ of: "list", element: nested.element }),
        };
      }

      return structValue(walk, state, path, value, typed, depth, ancestors);
    } finally {
      ancestors.delete(value);
    }
  }

  if (isAbsent(walk, dottedKey(path), value, typed)) {
    return { node: { of: "absent" }, kind: ABSENT_KIND };
  }

  if (typed) {
    const text = expressionText(value);
    if (text === null) {
      return null;
    }

    state.expressions = true;
    const written = `(${text})`;
    const grounded = inStruct ? groundItemZero(state, path, text, true) : null;
    return {
      node: grounded === null ? { of: "scalar", expr: written } : { of: "scalar", expr: grounded, written },
      kind: kindOf({ of: "expression" }),
    };
  }

  const plain = plainExpression(walk, dottedKey(path), value);
  if (plain === null) {
    return null;
  }

  const grounded = inStruct ? groundItemZero(state, path, plain.expr, false) : null;
  return {
    node: grounded === null
      ? { of: "scalar", expr: plain.expr }
      : { of: "scalar", expr: grounded, written: plain.expr },
    kind: kindOf({ of: plain.kind }),
  };
}

/**
 * The `Scalar` zero to write at `path` in place of a bare one, or `null` when the value is not a
 * bare zero and nothing is owed.
 *
 * This is {@link groundZero} for everything an array holds, and it exists separately for one
 * reason: an array's leaves are built by {@link itemValue}, which returns a node rather than a
 * {@link Leaf}, and carries its definitions on the shared {@link ListState} rather than per value.
 * The substitution itself is identical, and so is the reason for it — a polymorphic zero anywhere
 * inside a generated struct leaves the whole type unsolved, and Numbat can then read *none* of that
 * object's fields, which costs every property of the note that touches it.
 *
 * The definition is pushed once per array, not once per zero: it is one name for the whole
 * preamble, and a `let` Numbat is happy to see redefined.
 */
function groundItemZero(state: ListState, path: readonly string[], expr: string, typed: boolean): string | null {
  if (!isBareZero(expr)) {
    return null;
  }

  if (!state.defs.includes(ZERO_DEF)) {
    state.defs.push(ZERO_DEF);
  }
  if (typed) {
    state.grounded.add(dottedKey(path));
  }
  return ZERO_NAME;
}

/**
 * One object inside an array, as a Numbat struct literal — or `null` when nothing in it binds.
 *
 * The struct type is minted once per *position* — the property keys `people.#`, `people.#.address`
 * — and reused by all
 * elements, which is what makes the list homogeneous: the type is generic in each field, so Numbat
 * infers the field types at the first element and holds the rest to them. A field whose name Numbat
 * cannot take is dropped with a skip, exactly as in a plain object property — and since every
 * element drops the same key, the elements still agree.
 */
function structValue(
  walk: Walk,
  state: ListState,
  path: string[],
  record: Record<string, unknown>,
  typed: boolean,
  depth: number,
  ancestors: Set<object>,
): ItemValue | null {
  const fields: { name: string; node: ItemNode; }[] = [];
  const bound: ItemField[] = [];

  for (const [key, value] of Object.entries(record)) {
    const here = [...path, key];
    const built = itemValue(
      walk,
      state,
      here,
      value,
      typed || walk.rules.isNumbatTyped(dottedKey(here)),
      depth + 1,
      ancestors,
      // Whatever this field holds is about to become a struct field, which is where a bare zero
      // costs the whole object — so from here down every zero is grounded, however deeply it is
      // nested (a list inside this field poisons the type exactly as a bare one does).
      true,
    );

    if (built === null) {
      continue; // not a participant, as anywhere else
    }

    const name = fieldName(walk, state, here, bound);
    if (name === null) {
      continue;
    }

    fields.push({ name, node: built.node });
    bound.push({ name, kind: built.kind });
  }

  if (fields.length === 0) {
    return null; // an element with nothing bindable in it
  }

  return {
    node: { of: "struct", path: dottedKey(path), fields },
    kind: kindOf({ of: "struct", fields: bound }),
  };
}

// RENDERING WHAT THE WALK FOUND
// ================================================================================================

/**
 * Which of a leaf's two spellings a render writes.
 *
 * `bound` is the one that goes to Numbat, with every {@link groundItemZero} substitution in place.
 * `written` is the same literal with the zeros the reader actually typed back in it — not source to
 * evaluate, but what a consumer reasoning about the page needs (see {@link PropertyBinding.written}
 * and `properties/frontmatter-inlay.ts`, which is why a grounded list still counts as restating
 * itself). A second pass costs nothing and mints nothing: {@link renderStruct} caches its type
 * names on the state and pushes a definition only when it mints one.
 */
type RenderAs = "bound" | "written";

/** The items of one list as a Numbat list literal, every item written to the *joined* element kind
 *  — which is what makes a position that was absent anywhere nullable everywhere. */
function renderList(state: ListState, items: readonly ItemNode[], element: ItemKind, as: RenderAs): string {
  return `[${items.map((item) => renderNode(state, item, element, as)).join(", ")}]`;
}

/** One position as Numbat source, wrapped as a nullable when anything at this position, in any
 *  item, was absent. */
function renderNode(state: ListState, node: ItemNode, kind: ItemKind, as: RenderAs): string {
  if (!kind.nullable) {
    return renderShape(state, node, kind.shape, as);
  }

  return node.of === "absent" ? NULLABLE_ABSENT : definedValue(renderShape(state, node, kind.shape, as));
}

/**
 * The value itself, with the nullability already decided by {@link renderNode}.
 *
 * The two fallbacks for a shape that does not match the node are unreachable, like the `absent`
 * case below: a node is only ever rendered against the kind its own position joined to, and a
 * position holding a list or a struct has that shape. They are written as the emptiest thing of
 * the right kind rather than thrown — but nothing here is a tested path, and the struct one in
 * particular would mint `struct X<> { }`, which Numbat does not parse. Reaching either means the
 * walk and the joined kind have come apart, which is a bug in this file.
 */
function renderShape(state: ListState, node: ItemNode, shape: ItemShape | null, as: RenderAs): string {
  switch (node.of) {
    case "absent":
      // Unreachable: refine marks every position an absence reached as nullable, and renderNode
      // takes an absence down its own branch. Written out rather than thrown, since a hole is
      // always the right answer for an absence.
      return NULLABLE_ABSENT;
    case "scalar":
      return as === "written" ? node.written ?? node.expr : node.expr;
    case "list":
      return renderList(state, node.items, shape?.of === "list" ? shape.element : OPEN_KIND, as);
    case "struct":
      return renderStruct(state, node, shape?.of === "struct" ? shape.fields : [], as);
  }
}

/**
 * One object as a Numbat struct literal, minting the element type for its position on the way.
 *
 * The type is minted once per *position* — the property keys `people.#`, `people.#.address` — and
 * reused by every element, which is what makes the list homogeneous. Its fields come from the
 * **joined** kind rather than from this element, so every element writes the same type even when
 * one of them left a field out; the fields are written in this element's own order, since Numbat
 * constructs a struct by naming its fields and takes them in any order.
 */
function renderStruct(
  state: ListState,
  node: Extract<ItemNode, { of: "struct"; }>,
  fields: readonly ItemField[],
  as: RenderAs,
): string {
  const parts: string[] = [];
  for (const field of node.fields) {
    // A field the joined type does not have is one no item ever filled (see normalize) — dropped
    // for every element alike, so the elements still agree.
    const joined = fields.find((candidate) => candidate.name === field.name);
    if (joined !== undefined) {
      parts.push(`${field.name}: (${renderNode(state, field.node, joined.kind, as)})`);
    }
  }

  // A field this element does not have at all, which some other one did: absent here.
  for (const field of fields) {
    if (!node.fields.some((candidate) => candidate.name === field.name)) {
      parts.push(`${field.name}: (${NULLABLE_ABSENT})`);
    }
  }

  // Minted after the fields are rendered, so a nested type is still declared before the type that
  // holds it (a Numbat `struct` must be declared before it is named).
  let name = state.structs.get(node.path);
  if (name === undefined) {
    // The generation slot is a constant `0`: unlike an object property, whose `let` is rebuilt (and
    // retyped) once per leaf, an array's element type is declared once.
    name = `_Nb_${structLabel(node.path)}_${state.hash}_0_${state.structs.size}`;
    state.structs.set(node.path, name);

    const params = fields.map((_, index) => `T${index}`);
    const decls = fields.map((field, index) => `${field.name}: T${index}`);
    state.defs.push(`struct ${name}<${params.join(", ")}> { ${decls.join(", ")} }`);
  }

  return `${name} { ${parts.join(", ")} }`;
}

/**
 * Whether a value of this kind carries no type at all — a hole nothing ever said anything about.
 *
 * Such a value leaves a type *variable* behind, which is harmless on its own (`let x = nil`
 * generalizes to `forall A. Opt<A>`, `let x = []` to `forall A. List<A>`, and both read back
 * happily) and fatal in one place: inside a generated `struct`. Numbat cannot solve a `HasField`
 * constraint against a type that is still polymorphic, so one of these costs the reader **every**
 * field of the object holding it, not just the empty one — see {@link bindNested} and
 * {@link normalize}, which are what act on this.
 *
 * Both ways a position can fail to say what it holds count, and they are otherwise distinguished
 * everywhere else in this file: an **absence** (`[,]`, `nullable`) and an **empty list**'s element
 * (`[]`, which is not nullable — it is not a hole, it is nothing at all). They part company in
 * {@link sameKind}, which lets an empty list stand beside any list, and meet again here, where the
 * question is only whether Numbat will be left with a type variable.
 *
 * A list is followed into, because a list of nothing but holes is type-free in the same way
 * (`List<Opt<A>>`) and just as fatal in a field. A list anything at all filled is not, and neither
 * is a struct — {@link normalize} has already dropped the fields that would have made one so.
 */
function isTypeFree(kind: ItemKind): boolean {
  if (kind.shape === null) {
    return true;
  }

  return kind.shape.of === "list" && isTypeFree(kind.shape.element);
}

/**
 * The Numbat type each plain kind binds as — which an *empty* property of that kind can be declared
 * at, since the type menu said what it would hold whether or not anything was written.
 *
 * `boolean` is here for completeness rather than use: an unticked checkbox is `false`, a value like
 * any other, so a boolean property is never empty and never reaches the hole path.
 */
const PLAIN_TYPE: Record<PlainKind, string> = {
  number: "Scalar",
  text: "String",
  date: "DateTime",
  boolean: "Bool",
};

/**
 * A hole of a known type, as a definition to replay and the name to write in its place.
 *
 * The type cannot be put where it belongs — on the struct field — because Numbat expands a declared
 * field of a generic type without substituting into it (it expects
 * `Opt<DateTime> {value: List<T>}`) and then rejects the very value that matches. So the field is
 * left generic, as every other field is, and the *value* carries the type instead: an annotated
 * `let` types cleanly, and the field infers from it.
 *
 * The definition rides in the binding's `defs`, which the scope inspector does not list (it reads
 * binding names, not context bindings — see scope/model.ts), so this stays out of the reader's way
 * exactly as the generated `struct` definitions beside it do. One name per type, redefined as often
 * as it is needed, which Numbat allows for a `let`.
 */
function typedHole(kind: PlainKind): { def: string; name: string; } {
  const type = PLAIN_TYPE[kind];
  const name = `_Nb_hole_${type}`;
  return { def: `let ${name}: ${NULLABLE_STRUCT}<${type}> = ${NULLABLE_ABSENT}`, name };
}

/** The Numbat field name for a key inside an array element, or `null` — with the skip that says why
 *  — when it cannot have one. Reported once per position, not once per element. */
function fieldName(walk: Walk, state: ListState, path: string[], bound: readonly ItemField[]): string | null {
  const key = dottedKey(path);
  const report = (reason: PropertySkipReason, message: string): null => {
    if (!state.reported.has(key)) {
      state.reported.add(key);
      state.skips.push({ key, path, reason, message });
    }
    return null;
  };

  const name = sanitizeIdentifier(path[path.length - 1]);
  if (name === null) {
    return report("invalid-name", `property '${key}' has no usable Numbat name`);
  }

  if (FIELD_KEYWORDS.has(name)) {
    return report("reserved", `property '${key}': '${name}' is a Numbat keyword — rename the property`);
  }

  if (bound.some((field) => field.name === name)) {
    return report("duplicate", `property '${key}': '${name}' is already bound by an earlier property`);
  }

  return name;
}

/** The list a whole array property binds, or `null` when it binds nothing. */
function arrayExpression(
  walk: Walk,
  path: string[],
  value: readonly unknown[],
  typed: boolean,
  depth: number,
  inObject: boolean,
): {
  expr: string;
  written: string | null;
  defs: string[];
  expressions: boolean;
  plainKind: PlainKind;
  typeFree: boolean;
  grounded: Set<string>;
} | null {
  const key = dottedKey(path);
  const state: ListState = {
    defs: [],
    // NUL separates the fields because it can occur in neither, so no pair of values can collide by
    // straddling the separator. The item path, not the array's own, keeps these names clear of the
    // ones an object property of the same key would generate.
    hash: digest(`${walk.rules.namespace ?? ""}\x00${dottedKey([...path, ARRAY_ITEM])}`),
    structs: new Map<string, string>(),
    skips: [],
    reported: new Set<string>(),
    error: null,
    expressions: false,
    grounded: new Set<string>(),
  };

  // The items sit below the top level even when the array itself is a top-level property, so they
  // read untyped values under the nested rule (see PreambleRules.plainNested).
  const outerPlain = walk.plain;
  walk.plain = nestedPlain(walk.rules);
  const built = depth >= MAX_PROPERTY_DEPTH
    ? null
    // An array that is itself an object's field puts everything it holds inside that object's
    // struct, so its zeros are grounded from the first item down (see itemValue's `inStruct`); one
    // standing on its own grounds only what reaches a struct of its own.
    : listItems(walk, state, path, value, typed, depth, new Set<object>([value]), inObject);
  walk.plain = outerPlain;

  // An element left with no fields at all — every item wrote every one of them empty — cannot be a
  // Numbat struct, so the array binds nothing, as one holding nothing bindable already does.
  const element = built === null ? null : normalize(built.element);
  if (built === null || element === null) {
    if (built !== null) {
      state.error ??= "no item holds anything Numbat can bind";
    }
    if (typed) {
      walk.skips.push({
        key,
        path,
        reason: "unsupported",
        message: `property '${key}': ${state.error ?? "a Numbat list holds expressions"}`,
      });
    }
    return null;
  }

  // A field the elements had to drop is only worth saying when something in the array was opted
  // into; an array that rode along untyped reports nothing, as any other plain value does.
  if (typed || state.expressions) {
    walk.skips.push(...state.skips);
  }

  // The struct definitions are minted here rather than during the walk, so a failed array leaves
  // none behind, and every element writes the joined element type rather than its own.
  const expr = renderList(state, built.items, element, "bound");

  // The same literal with the grounded zeros back as the reader typed them, and only where one was
  // grounded — so an array that lost nothing carries nothing extra.
  const written = state.defs.includes(ZERO_DEF) ? renderList(state, built.items, element, "written") : null;

  return {
    expr,
    written,
    defs: state.defs,
    expressions: state.expressions,
    // `number` for a list with nothing scalar in it to go on — an empty array, or one of objects.
    plainKind: scalarKind(element) ?? "number",
    // True only for a list of nothing but holes, which carries no type just as a lone hole does.
    typeFree: isTypeFree({ shape: { of: "list", element }, nullable: false }),
    grounded: state.grounded,
  };
}

// DERIVING ONE BINDING
// ================================================================================================

/**
 * The kind an *empty* untyped property binds as, from the type its type menu declares, or `null`
 * when it declares none that binds (or the reader has that kind switched off).
 *
 * This is the opt-in that makes a lone undefined property a binding at all: with no value there is
 * nothing to read the kind off, so the declared type is the only thing that says a Numbat value was
 * ever wanted here. Checkbox is deliberately not here — an unset one is `false`, a value rather
 * than the lack of one (see {@link plainExpression}).
 */
function declaredKind(reading: Reading, key: string): PlainKind | null {
  const declared = reading.rules.assignedType?.(key) ?? null;
  if (declared === null) {
    return null;
  }

  // The reading in force *here*, not the top-level one: an empty property inside an object is a
  // *field* of a value being bound anyway, and reads at the depth it sits at exactly as a filled
  // one does (see plainExpression and PreambleRules.plainNested). Withholding it would hand back an
  // object with the field missing, which is the one thing the nested rule exists to prevent.
  const { plain } = reading;
  if (DATE_TYPES.has(declared)) {
    return plain.dates ? "date" : null;
  }
  if (declared === "number") {
    return plain.numbers ? "number" : null;
  }
  if (declared === "text") {
    return plain.text ? "text" : null;
  }

  return null;
}

/** One bound leaf as {@link leafExpression} resolves it: the Numbat expression to bind, whatever
 *  definitions that expression needs replayed first, and how it was read. */
interface Leaf {
  /** The expression the binding evaluates. */
  expr: string;

  /** Definitions `expr` depends on — an annotated `let` for a typed hole or a grounded zero, and
   *  the element type of an array of objects. */
  defs: string[];

  /** Whether the leaf is numbat-typed, or the plain kind it rode along as. */
  kind: "expression" | PlainKind;

  /** The value as written, where `expr` is a substitution for it — see
   *  {@link PropertyBinding.written}. */
  written?: string;

  /** What the derivation has to say about this leaf — see {@link PropertyBinding.warning}. */
  warning?: string;

  /** Whether the value says nothing about its own type, so it cannot become a struct field at all
   *  (see {@link isTypeFree}). */
  typeFree?: true;
}

/** The expression a property contributes, or `null` when it contributes nothing — either quietly
 *  (the common case: an untyped non-number) or as a pushed skip. */
function leafExpression(
  walk: Walk,
  path: string[],
  value: unknown,
  depth: number,
  inObject: boolean,
): Leaf | null {
  const key = dottedKey(path);
  const typed = walk.rules.isNumbatTyped(key);

  if (Array.isArray(value)) {
    // An array is typed by its own key (a type menu applied to the whole property) or by its item
    // key (`rates.#`, which is where Better Properties keeps it) — either way, every item is then
    // an expression. Untyped, its items ride along under the same rules a lone value does, so a
    // reader who binds no plain value at all binds no list either — including the empty one, which
    // has no item to say so on its behalf.
    const items = typed || walk.rules.isNumbatTyped(dottedKey([...path, ARRAY_ITEM]));
    const { numbers, text, dates, booleans } = walk.plain;

    // On export an array rides in on a typed leaf anywhere inside it, the same gate an object
    // passes — otherwise a list of objects whose *fields* carry the type (`legs.#.distance`, where
    // Better Properties keeps it) would reach no importer at all, since the top-level rule binds no
    // untyped value to let it in. Off the export path there is no nested rule and nothing changes.
    const gated = walk.rules.plainNested !== undefined
      && hasBindableLeaf(topLevelReading(walk.rules), value, path, depth, new Set<object>([value]));

    if (!items && !gated && !(numbers || text || dates || booleans)) {
      return null;
    }

    const list = arrayExpression(walk, path, value, items, depth, inObject);
    if (list === null) {
      return null;
    }

    const grounded = listZeroWarning(key, list.grounded);
    return {
      expr: list.expr,
      defs: list.defs,
      kind: items || list.expressions ? "expression" : list.plainKind,
      ...list.written === null ? {} : { written: list.written },
      ...grounded === null ? {} : { warning: grounded },
      ...list.typeFree ? { typeFree: true as const } : {},
    };
  }

  // A property with no value is undefined rather than absent from the scope — but only where it was
  // opted into. An empty property is on a great many notes, and binding every one of them would put
  // a `summary` and a `description` into nearly every note's namespace (and claim those names
  // against the properties below them) to say nothing but `undefined`. Inside an array a sibling
  // gives the position its meaning; here only the type menu does.
  if (isAbsent(walk, key, value, typed)) {
    // The two kinds of empty property differ in exactly what this file needs. The **numbat** type
    // menu describes the value's *syntax*, not its type, so an empty one says nothing at all —
    // `typeFree`, and inside an object it cannot be bound. A **number**, **text** or **date** menu
    // names the type outright, so an empty one of those is a hole of a known type and binds
    // wherever a filled one would.
    if (typed) {
      return { expr: NULLABLE_ABSENT, defs: [], kind: "expression", typeFree: true };
    }

    const declared = declaredKind(walk, key);
    if (declared === null) {
      return null;
    }

    // Inside an object the hole has to carry its type, or the struct it lands in stays polymorphic
    // and none of its fields can be read. On its own it needs no such help: `let x = nil`
    // generalizes and reads back, so the plain literal is left alone rather than narrowed.
    if (!inObject) {
      return { expr: NULLABLE_ABSENT, defs: [], kind: declared };
    }

    const hole = typedHole(declared);
    return { expr: hole.name, defs: [hole.def], kind: declared };
  }

  if (typed) {
    const expr = expressionText(value);
    if (expr === null) {
      walk.skips.push({
        key,
        path,
        reason: "unsupported",
        message: `property '${key}': a Numbat property holds an expression as text`,
      });
      return null;
    }

    return groundZero(key, { expr, defs: [], kind: "expression" }, inObject);
  }

  const plain = plainExpression(walk, key, value);
  if (plain === null) {
    return null; // not a participant — no skip entry, this is the common case
  }

  return groundZero(key, { expr: plain.expr, defs: [], kind: plain.kind }, inObject);
}

/** A bare zero, in any spelling YAML or a Numbat expression can write one — `0`, `0.0`, `-0`,
 *  `+0.00`. A plain number always arrives as `String(0)`, so the wider forms are for a value
 *  written under the Numbat type. */
const ZERO_LITERAL = /^[+-]?0+(?:\.0*)?$/;

/** Whether an expression is a bare zero — the value {@link groundZero} substitutes. Exported for
 *  the property widget, which judges the text being *typed* rather than the derived binding, so an
 *  advisory clears the moment the value stops being one. */
export function isBareZero(expr: string): boolean {
  return ZERO_LITERAL.test(expr.trim());
}

/** The `Scalar` zero {@link groundZero} substitutes, and its definition. One name for the whole
 *  preamble, redefined as often as it is needed — which Numbat allows for a `let`, and which
 *  {@link typedHole} already relies on. */
const ZERO_NAME = "_Nb_zero_Scalar";
const ZERO_DEF = `let ${ZERO_NAME}: ${PLAIN_TYPE.number} = 0`;

/**
 * A leaf with a bare `0` replaced by a `Scalar` zero — but only where it is about to become a
 * **struct field**, which is the one place the difference is fatal.
 *
 * `0` is the single literal Numbat gives no type of its own: it is zero of *any* dimension
 * (`type(0)` is `forall A: Dim. A`), where `1` is a `Scalar`. At the top level that is a feature
 * and is left alone — `let x = 0` still adds to `5 m` and to `5 seconds` alike. Inside a generated
 * struct it leaves the whole type polymorphic, and Numbat can then read **none** of that object's
 * fields: one `0` in one corner costs every property of the object, of every note that imports it,
 * and reports itself only on whatever unrelated line happened to read one.
 *
 * Substituting is a *faithful* reading rather than a liberty, which is what makes it the right
 * answer and not merely the convenient one. Every other plain number in a note binds as a `Scalar`
 * already; `0` binding as one is what makes it behave like `1` instead of like a hole. The
 * polymorphism it gives up could not have been used from a struct field anyway — the field was
 * unreadable while it had it.
 *
 * The mechanism is {@link typedHole}'s exactly: an annotated `let` in the binding's `defs`, whose
 * name goes in the value's place. A struct field cannot carry the annotation itself (see that
 * function), and an arithmetic dodge that types as `Scalar` — `0 + (1 - 1)` — would read as a
 * puzzle wherever the expression is shown.
 *
 * What this cannot reach is an expression that merely *evaluates* to a polymorphic zero (`0 * 2`,
 * `x - x`); no static rule can. Those still fail, and `evaluation/inlay-parse.ts`'s
 * `unsolvedFieldSummary` is what makes Numbat's complaint about them legible.
 *
 * This is the substitution for a value bound as a leaf in its own right. A zero inside an **array**
 * reaches a struct by a different road and is grounded by {@link groundItemZero}, on the same rule
 * and for the same reason.
 */
function groundZero(key: string, leaf: Leaf, inObject: boolean): Leaf {
  if (!inObject || !isBareZero(leaf.expr)) {
    return leaf;
  }

  const grounded: Leaf = { ...leaf, expr: ZERO_NAME, written: leaf.expr, defs: [...leaf.defs, ZERO_DEF] };
  const warning = leaf.kind === "expression" ? zeroWarning(key, "object") : null;
  return warning === null ? grounded : { ...grounded, warning };
}

/**
 * Resolve a top-level Numbat name for `key`, claiming it, or push the skip that says why it could
 * not be had.
 *
 * `report` is what the caller opted into: a numbat-typed property is owed the reason its value did
 * not reach the scope, but a plain value that rode along was never asked for, and a name it cannot
 * have makes it a non-participant rather than a problem. That distinction matters more than it
 * looks: `id`, `date`, `time`, `year`, `day`, `month`, `week`, `hour`, `min` and `people` are all
 * prelude names *and* ordinary frontmatter keys, so reporting them would put a row in the scope
 * inspector on a great many notes that never opted into anything.
 */
function claimName(walk: Walk, key: string, path: string[], report: boolean): string | null {
  const skip = (reason: PropertySkipReason, message: string): null => {
    if (report) {
      walk.skips.push({ key, path, reason, message });
    }
    return null;
  };

  const name = sanitizeIdentifier(key);
  if (name === null) {
    return skip("invalid-name", `property '${key}' has no usable Numbat name`);
  }

  if (walk.rules.isReserved(name)) {
    return skip("reserved", `property '${key}': '${name}' is already a Numbat name — rename the property`);
  }

  if (walk.taken.has(name)) {
    return skip("duplicate", `property '${key}': '${name}' is already bound by an earlier property`);
  }

  walk.taken.add(name);
  return name;
}

/** Add the field path to the object's field tree, or `false` when something is already bound there
 *  (two keys that sanitize alike, or a leaf and an object competing for one field name). */
function insertField(fields: FieldNode[], segments: readonly string[]): boolean {
  let level = fields;
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    const existing = level.find((node) => node.name === segment);

    if (existing === undefined) {
      const node: FieldNode = { name: segment, children: last ? null : [] };
      level.push(node);
      if (last) {
        return true;
      }

      level = node.children as FieldNode[];
      continue;
    }

    if (last || existing.children === null) {
      return false; // already bound here, or a leaf in the way of a sub-object
    }

    level = existing.children;
  }
  return false;
}

/**
 * The readable type name for the object at `access` (a dotted path of already sanitized names):
 * each `.`- and `_`-separated part capitalized, run together, with a `Struct` suffix — `costs` →
 * `CostsStruct`, `costs.breakdown` → `CostsBreakdownStruct`, `total_cost` → `TotalCostStruct`.
 *
 * This is what the user reads whenever Numbat prints the type of an object property (`costs` shows
 * as `CostsStruct { materials: 500 € }`). It is carried *inside* the generated name rather than
 * being the whole name, so the disambiguating hash survives — two notes may each have a `costs:`
 * object, and a repeated `struct` definition is a hard error. Deliberately free of `_` so the
 * display transform in interpreter/numbat.ts can lift it back out unambiguously.
 */
function structLabel(access: string): string {
  const alphanumeric = /[\p{L}\p{N}]/u;
  const parts = access.split(".").flatMap((segment) => segment.split("_"));
  const label = parts
    .map((part) => [...part].filter((ch) => alphanumeric.test(ch)).join(""))
    .filter((part) => part !== "")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
  return `${label}Struct`;
}

/**
 * The statement that binds one nested leaf: a struct definition per object in the tree, then the
 * object's `let` rebuilt with the new field added. Every field that was already bound is
 * reconstructed by reading it back off the object's previous value (`costs.materials`), which is
 * what makes a later sibling able to reference an earlier one by its natural dotted name, at any
 * depth.
 *
 * The struct types are generic, so Numbat infers each field's type at the construction site and
 * nothing here has to know a dimension. That every field *can* be inferred is what {@link
 * bindNested} guarantees by refusing the type-free ones.
 */
function generationCode(state: ObjectState, segments: readonly string[], expr: string): string {
  const defs: string[] = [];
  let index = 0;

  const build = (nodes: readonly FieldNode[], access: string, fresh: readonly string[]): string => {
    const fields = nodes.map((node) => {
      const isFresh = fresh.length > 0 && fresh[0] === node.name;
      const path = `${access}.${node.name}`;

      if (isFresh && fresh.length === 1) {
        return `${node.name}: (${expr})`;
      }

      if (node.children === null) {
        return `${node.name}: ${path}`;
      }

      return `${node.name}: ${build(node.children, path, isFresh ? fresh.slice(1) : [])}`;
    });

    const name = `_Nb_${structLabel(access)}_${state.hash}_${state.generation}_${index}`;
    index += 1;

    const params = nodes.map((_, i) => `T${i}`);
    const decls = nodes.map((node, i) => `${node.name}: T${i}`);
    defs.push(`struct ${name}<${params.join(", ")}> { ${decls.join(", ")} }`);

    return `${name} { ${fields.join(", ")} }`;
  };

  const literal = build(state.fields, state.rootName, segments);
  return [...defs, `let ${state.rootName} = ${literal}`].join("\n");
}

/** Bind one leaf found inside an object, or report why it could not be. */
function bindNested(walk: Walk, state: ObjectState, path: string[], value: unknown, depth: number): void {
  if (state.failed) {
    return;
  }

  const leaf = leafExpression(walk, path, value, depth, true);
  if (leaf === null) {
    return;
  }

  // Only a numbat-typed leaf is owed the reason it did not reach the scope; see claimName.
  const report = leaf.kind === "expression";
  const key = dottedKey(path);

  // A value nothing said anything about (see isTypeFree) binds nothing *here*, where a lone one of
  // the same kind binds happily. The difference is the struct: a field with no type leaves the
  // whole generated type polymorphic, and Numbat cannot read *any* field of a polymorphic struct —
  // so keeping this one would cost the reader every sibling it sits beside, to say only that a
  // property they can already see is empty is empty. Dropping it is the same answer an array
  // already gives a field no item ever fills.
  //
  // Said out loud, though, unlike the array's silent drop: this one is a property the reader
  // *opted in*, and it would otherwise disappear with no binding, no inlay and no row to explain
  // why — leaving `costs.foo` reporting only that the field does not exist. A plain value that
  // rode along was never asked for and stays quiet, exactly as claimName's does.
  if (leaf.typeFree) {
    if (report) {
      walk.skips.push({
        key,
        path,
        reason: "unsupported",
        message: `property '${key}': nothing here says what type it holds, so it cannot be a field`
          + " — write a value, or use the number, text or date type instead",
      });
    }
    return;
  }

  if (!state.claimed) {
    const rootPath = [state.rootKey];
    const rootName = claimName(walk, state.rootKey, rootPath, report);

    if (rootName === null) {
      state.failed = true; // one skip for the object, not one per leaf under it
      return;
    }
    state.rootName = rootName;

    // NUL separates the two fields because it can occur in neither, so no pair of (namespace, key)
    // values can collide by straddling the separator.
    state.hash = digest(`${walk.rules.namespace ?? ""}\x00${state.rootKey}`);
    state.claimed = true;
  }

  const segments: string[] = [];
  for (const raw of path.slice(1)) {
    const segment = sanitizeIdentifier(raw);
    if (segment === null) {
      if (report) {
        walk.skips.push({
          key,
          path,
          reason: "invalid-name",
          message: `property '${key}' has no usable Numbat name`,
        });
      }
      return;
    }

    if (FIELD_KEYWORDS.has(segment)) {
      walk.skips.push({
        key,
        path,
        reason: "reserved",
        message: `property '${key}': '${segment}' is a Numbat keyword — rename the property`,
      });
      return;
    }

    segments.push(segment);
  }
  if (!insertField(state.fields, segments)) {
    walk.skips.push({
      key,
      path,
      reason: "duplicate",
      message: `property '${key}': '${segments.join(".")}' is already bound by an earlier property`,
    });
    return;
  }
  state.generation += 1;
  walk.bindings.push({
    key,
    path,
    name: [state.rootName, ...segments].join("."),
    expr: leaf.expr,
    defs: leaf.defs,
    code: generationCode(state, segments, leaf.expr),
    kind: leaf.kind,
    ...leaf.written === undefined ? {} : { written: leaf.written },
    ...leaf.warning === undefined ? {} : { warning: leaf.warning },
  });
}

/**
 * The notice a grounded zero earns, phrased for where it was found.
 *
 * Said out loud rather than done quietly, because under the Numbat type the value is an
 * *expression*, where a polymorphic zero is a real thing to have written and useful at the top
 * level: `let x = 0` adds to `5 m` and to `5 seconds` alike. Substituting takes that away, so
 * someone who meant a zero *quantity* is told how to say it — with a unit, which only the Numbat
 * type has room for.
 *
 * A **plain** number says nothing of the sort. `0` there is a YAML number among numbers, no more
 * asking to be dimensionless than `1` beside it is, and every other one of them already binds as a
 * `Scalar`. Grounding it is what the property meant in the first place, not a liberty taken with
 * it, so it is done in silence — the same distinction {@link bindNested}'s `report` draws, for the
 * same reason: a value that merely rode along was never asked for. Neither caller reaches this for
 * one, so everything below is written for a value under the Numbat type.
 *
 * `holds` is what stays readable because of the substitution, and it is all the two callers differ
 * on: {@link groundZero}'s notice sits on the property it was done to, where {@link
 * listZeroWarning}'s sits on the array *containing* it — a list item has no binding of its own to
 * carry one — and appends where inside it to look.
 */
function zeroWarning(key: string, holds: "object" | "list"): string {
  return `property '${key}': a bare 0 has no dimension of its own in Numbat, so it is read here as`
    + ` a dimensionless Scalar — which is what keeps the rest of this ${holds} readable. Write it`
    + " with a unit (0 m) if you meant a zero quantity.";
}

/**
 * The notice an array carries for the numbat-typed zeros grounded inside it, or `null` when there
 * were none.
 *
 * It lands on the **array** rather than on the item, and that is a limitation stated rather than a
 * choice: an array binds as one value, so a position inside it has no {@link PropertyBinding} to
 * hang a notice on and no line of its own for a surface to place it against. The item paths are
 * appended for exactly that reason — `rates.#` for a list of expressions, `crew.#.score` for a
 * field of a list of objects — since the message can no longer simply point at itself.
 *
 * One entry per position, not per element: every item of an array shares a path, so a list of ten
 * zeros says this once.
 */
function listZeroWarning(key: string, grounded: ReadonlySet<string>): string | null {
  if (grounded.size === 0) {
    return null;
  }

  const where = [...grounded].map((path) => `'${path}'`).join(", ");
  return `${zeroWarning(key, "list")} Found under ${where}.`;
}

/** Walk one object's entries in document order, descending into sub-objects. */
function walkObject(
  walk: Walk,
  state: ObjectState,
  record: Record<string, unknown>,
  path: string[],
  ancestors: Set<object>,
  depth: number,
): void {
  for (const [key, value] of Object.entries(record)) {
    const here = [...path, key];
    if (!isPlainObject(value)) {
      bindNested(walk, state, here, value, depth);
      continue;
    }

    // A YAML anchor can make the record genuinely cyclic, and a deep one can make it merely absurd;
    // neither guard covers the other.
    if (depth >= MAX_PROPERTY_DEPTH || ancestors.has(value)) {
      continue;
    }

    ancestors.add(value);
    walkObject(walk, state, value, here, ancestors, depth + 1);
    ancestors.delete(value);
  }
}

// DERIVING THE PREAMBLE
// ================================================================================================

/**
 * Derive the note preamble from parsed frontmatter, walking the properties in document order (later
 * bindings may reference earlier ones, mirroring the shared-block and inline-span replay). A
 * numbat-typed property binds its value as an expression; an untyped property whose value is a
 * plain finite number binds it as a scalar (when `rules.bindNumbers`); everything else is skipped.
 * The binding is `let <name> = (<expr>)` — the parentheses make the whole value one expression, so
 * `5 km + 3 mi` binds as a sum, not a chain.
 *
 * An object value is not a property itself: the walk descends into it and binds its leaves, under
 * the same rules, as fields of a Numbat struct bound to the object's own key. So
 *
 * ```yaml
 * costs:
 *   materials: 500 EUR
 *   total: costs.materials * 1.2
 * ```
 *
 * binds `costs.materials` and `costs.total`, and `costs` itself is a value. The descent is
 * depth-first pre-order, which *is* document order for YAML (nesting is textual containment), so
 * "everything written above me is in scope" holds at every depth with no extra machinery.
 *
 * One consequence worth knowing: because each leaf rebuilds the object from the previous one, a
 * leaf that fails to evaluate leaves the object frozen at the fields bound before it. The failed
 * property reports its own error as always, and the later ones still evaluate — but they can no
 * longer be reached through the object until the broken one is fixed.
 *
 * An array value is one binding, not several: it binds the Numbat list of its items, whose type
 * assignment lives at `<key>.#` (see {@link ARRAY_ITEM}). An array of objects binds a list of one
 * generated struct type, so
 *
 * ```yaml
 * legs:
 *   - distance: 5 km      # the property key `legs.#.distance` carries the type
 *     time: 21 min
 *   - distance: 10 km
 *     time: 46 min
 * ```
 *
 * binds `legs` as a two-element list, so `element_at(0, legs).distance` reads a field and a `fn`
 * over the element type maps across the whole of it. Every item must bind, and bind the same fields
 * — which is what an Array property already guarantees, and what a homogeneous Numbat list needs.
 * An array that cannot manage it binds nothing, reporting one skip on the array itself rather than
 * one per item. Fields that *disagree dimensionally* between items are left to Numbat, whose own
 * type error on the property says it better than a guess here could.
 */
export function derivePreamble(frontmatter: Record<string, unknown>, rules: PreambleRules): NotePreamble {
  const walk: Walk = { rules, plain: rules.plain, bindings: [], skips: [], taken: new Set<string>() };
  for (const [key, value] of Object.entries(frontmatter)) {
    // Vault machinery, not note data — unless it is explicitly Numbat-typed, on its own key or (for
    // the three that are lists) on its items'. See UNBOUND_KEYS.
    if (
      UNBOUND_KEYS.has(key) && !rules.isNumbatTyped(key)
      && !rules.isNumbatTyped(dottedKey([key, ARRAY_ITEM]))
    ) {
      continue;
    }

    if (isPlainObject(value)) {
      // The gate that keeps `plainNested` from turning every object into an export: with a nested
      // rule set, an object rides in only when something under it was actually asked for. Without
      // one there is nothing to gate — the leaves bind under the same rule they always did.
      if (
        rules.plainNested !== undefined
        && !hasBindableLeaf(topLevelReading(rules), value, [key], 1, new Set<object>([value]))
      ) {
        continue;
      }

      const state: ObjectState = {
        rootKey: key,
        rootName: "",
        hash: "",
        fields: [],
        generation: 0,
        claimed: false,
        failed: false,
      };

      // Everything under an object property is below the top level, so its untyped values read
      // under the nested rule: an object that binds at all binds the shape that was written, and a
      // typed leaf can still reach a plain sibling by its dotted name.
      const outerPlain = walk.plain;
      walk.plain = nestedPlain(rules);
      walkObject(walk, state, value, [key], new Set<object>([value]), 1);
      walk.plain = outerPlain;
      continue;
    }

    const path = [key];
    const leaf = leafExpression(walk, path, value, 1, false);
    if (leaf === null) {
      continue;
    }

    // Only a numbat-typed property is owed the reason a name could not be had; see claimName.
    const name = claimName(walk, key, path, leaf.kind === "expression");
    if (name === null) {
      continue;
    }

    walk.bindings.push({
      key,
      path,
      name,
      expr: leaf.expr,
      defs: leaf.defs,
      code: `let ${name} = (${leaf.expr})`,
      kind: leaf.kind,
      // A top-level leaf is never grounded (see groundZero), but a top-level *array* can hold an
      // object whose fields are — so both of these reach this push as well as the nested one.
      ...leaf.written === undefined ? {} : { written: leaf.written },
      ...leaf.warning === undefined ? {} : { warning: leaf.warning },
    });
  }

  return {
    bindings: walk.bindings,
    skips: walk.skips,
    source: walk.bindings.flatMap((binding) => [...binding.defs, binding.code]).join("\n"),
  };
}

// LOCATING KEYS IN THE SOURCE
// ================================================================================================

/** Where a frontmatter key is written: the 0-indexed line of the `key:` itself, the column the key
 *  starts at (its indent), and the last line its value occupies — for a mapping, the last line of
 *  the block it opens. */
export interface KeySite {
  /** 0-indexed line the `key:` is written on. */
  line: number;

  /** Column the key starts at — its indent. */
  ch: number;

  /** Last line the key's value occupies; equal to {@link line} for a scalar. */
  endLine: number;
}

/** A `key:` line: the indent, the key (bare, double- or single-quoted), and whatever follows the
 *  colon. */
const KEY_LINE = /^(\x20*)(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#:][^:]*?))\x20*:(?:\x20(.*))?$/;

/** A sequence item — never a key line, whatever follows the dash. */
const SEQUENCE_ITEM = /^\x20*-(?:\x20|$)/;

/** Unescape a double-quoted YAML key. A single-quoted one only needs `''` → `'`. */
function unquote(text: string, quote: "\"" | "'"): string {
  return quote === "\"" ? text.replace(/\\(.)/g, "$1") : text.replace(/''/g, "'");
}

/** The value text on a key line, with any trailing comment removed — so `costs: # rough` still
 *  reads as having no value. */
function valueText(value: string | undefined): string {
  return (value ?? "").replace(/(^|\x20)#.*$/, "$1").trim();
}

/** What one pass over a note's frontmatter finds: the keys, and the array-item values that have no
 *  key of their own. */
interface FrontmatterScan {
  /** Every key by its dotted path — see {@link frontmatterKeySites}. */
  keys: Map<string, KeySite>;

  /** Every array-item value, by the line it is written on. Keyed by line rather than by path
   *  because a path (`rates.#`, `people.#.pace`) names one position and repeats once per item. */
  items: Map<number, PropertyValueSite>;

  /**
   * Where the value starts on every line that has one, keyed by line — a key's and an item's alike,
   * since {@link quoteZonedTimestamps} cares only that there is a scalar there and not what it is
   * called.
   *
   * Only lines the scan accepted as key or item lines appear, which is the whole point of deriving
   * this here rather than matching the text again: a `2026-07-27T10:30:00+02:00` inside a `|` block
   * scalar, a flow mapping, or the continuation of a multi-line plain scalar has no entry, and so
   * cannot be rewritten by something that has no idea it is inside a string.
   */
  values: Map<number, number>;
}

/**
 * One pass over a note's frontmatter, locating everything a surface can anchor on.
 *
 * The scan is an indent stack governed by two rules:
 *
 *  1. **Only a key with no value text opens a block of children.** That is what separates a real
 *     nested key from the three things that merely look like one: a flow mapping (`costs: {total:
 *     2}`), a `|` or `>` block scalar whose body happens to contain `total: 5`, and the
 *     continuation lines of a multi-line plain scalar. Each has value text on its key line, so
 *     nothing beneath it is read as a key.
 *  2. **Only a line at exactly the open block's own indent is a candidate.** A deeper line is
 *     inside the previous key's value; a shallower one closes blocks until it is not.
 *
 * A block of children is either a mapping of keys or a **sequence** of items, decided by its first
 * child — a sequence because YAML lets `- ` sit at its key's own indent, where a mapping's keys
 * never can. An item's value is placed under `<key>.#`, and an item that is itself a mapping (`-
 * name: Sandy`) opens one whose keys are placed under `<key>.#.<name>`: the position each item
 * shares, which is exactly how the type assignment for it is keyed.
 *
 * Everything else — a tab in the indentation, an anchored or aliased value, an explicit `? ` key —
 * is simply not a key line, and is skipped without disturbing the blocks around it. A key that is
 * skipped has no site, which degrades to no source-mode inlay and a scope entry that cannot be
 * jumped to. Properties under such a key still *bind* — they just have no line to point at.
 */
function scanFrontmatter(lines: Iterable<string>): FrontmatterScan {
  const keys = new Map<string, KeySite>();
  const items = new Map<number, PropertyValueSite>();
  const values = new Map<number, number>();
  const body = frontmatterBody(lines);
  if (body === null) {
    return { keys, items, values };
  }

  // Open blocks, outermost first. `indent` is the column this block's children sit at, unknown
  // (`null`) between the `key:` that opened it and its first child. The root is the entry with an
  // empty path.
  interface Block {
    /** Column this block's children sit at, or `null` before its first child is seen. */
    indent: number | null;

    /** Line of the `key:` that opened it; `-1` for the root. */
    openedAt: number;

    /** The keys leading to it; empty for the root. */
    path: string[];

    /** Whether its children are sequence items rather than keys. */
    sequence: boolean;
  }

  const stack: Block[] = [{ indent: null, openedAt: -1, path: [], sequence: false }];
  let lastContent = 0;
  const close = (block: Block): void => {
    const site = keys.get(dottedKey(block.path));
    if (site !== undefined) {
      site.endLine = lastContent;
    }
  };

  // Place one `key:` line inside `block` — `text` runs from column `offset` of the real line, so a
  // key opened by a sequence dash (`- name: Sandy`) places exactly as one on its own line does.
  // Returns whether it was a key line at all.
  const placeKey = (block: Block, line: number, text: string, offset: number): boolean => {
    const match = KEY_LINE.exec(text);
    if (match === null) {
      return false;
    }

    const [, pad, doubled, singled, bare, value] = match;
    const key = doubled !== undefined
      ? unquote(doubled, "\"")
      : singled !== undefined
      ? unquote(singled, "'")
      : (bare ?? "").trim();

    const ch = pad.length;
    const path = [...block.path, key];
    if (path.includes(ARRAY_ITEM)) {
      const colon = text.indexOf(":", ch);
      items.set(line, {
        key: dottedKey(path),
        valueCh: offset + Math.min(colon + 2, text.length),
      });
    } else {
      keys.set(dottedKey(path), { line, ch: offset + ch, endLine: line });
    }

    if (valueText(value) === "") {
      stack.push({ indent: null, openedAt: offset + ch, path, sequence: false });
    } else if (value !== undefined) {
      // Measured from the match rather than by searching for the colon, so a quoted key with a
      // colon in it (`"a:b": 5`) still reports where its *value* starts.
      values.set(line, offset + text.length - value.length);
    }
    return true;
  };

  // Place one `- ` line of the sequence `block` opens.
  const placeItem = (block: Block, line: number, indent: number, text: string): void => {
    const valueCh = Math.min(indent + 2, text.length);
    const path = [...block.path, ARRAY_ITEM];
    const rest = text.slice(valueCh);

    if (rest.trim() === "" || rest.trimStart().startsWith("#")) {
      stack.push({ indent: null, openedAt: indent, path, sequence: false }); // written below the dash
      return;
    }

    if (SEQUENCE_ITEM.test(rest)) {
      return; // a sequence nested straight into a sequence has nothing to place
    }

    const nested: Block = { indent: valueCh, openedAt: valueCh, path, sequence: false };
    stack.push(nested);
    if (!placeKey(nested, line, rest, valueCh)) {
      stack.pop(); // not a mapping — the item *is* the value
      items.set(line, { key: dottedKey(path), valueCh });
      values.set(line, valueCh);
    }
  };

  body.forEach((text, index) => {
    const line = index + 1; // the body starts one line below the opening `---`
    if (text.trim() === "" || text.trimStart().startsWith("#")) {
      return; // blank and comment lines belong to whatever encloses them
    }

    const indent = text.length - text.trimStart().length;
    if (/^\x20*\t/.test(text)) {
      lastContent = line;
      return; // YAML forbids tabs in indentation; do not guess at the structure
    }

    const item = SEQUENCE_ITEM.test(text);

    // A block whose first child never arrived was empty — except that a sequence's items may sit at
    // the opening key's own indent, which is what distinguishes the two kinds of child.
    while (stack.length > 1 && stack[stack.length - 1].indent === null) {
      const pending = stack[stack.length - 1];
      if (item && indent >= pending.openedAt) {
        pending.indent = indent;
        pending.sequence = true;
        break;
      }

      if (indent > pending.openedAt) {
        pending.indent = indent;
        break;
      }

      close(stack.pop() as Block);
    }

    // Close what this line has left: whatever it has outdented past, and a sequence that a line
    // other than an item has ended at its own indent.
    while (stack.length > 1) {
      const top = stack[stack.length - 1];
      const at = top.indent ?? indent;
      if (indent < at || (top.sequence && indent === at && !item)) {
        close(stack.pop() as Block);
        continue;
      }
      break;
    }

    const block = stack[stack.length - 1];
    block.indent ??= indent; // the root takes the indent of its first key

    lastContent = line;
    if (indent > block.indent) {
      return; // inside the previous key's (or item's) value
    }

    if (block.sequence) {
      placeItem(block, line, indent, text);
      return;
    }

    if (!item) {
      placeKey(block, line, text, 0);
    }
  });

  while (stack.length > 0) {
    close(stack.pop() as Block);
  }

  return { keys, items, values };
}

/**
 * Every frontmatter key, indexed by its dotted path — `costs`, `costs.total`, and so on — with the
 * line, column and extent of each. One pass over the lines (see {@link scanFrontmatter}), so a
 * note's whole set of property defsites and inlay anchors comes from a single call.
 *
 * Array *items* are deliberately absent: they share one position (`rates.#`) rather than having a
 * key each, so they cannot be indexed this way — and they bind through their array, which does have
 * a site here.
 */
export function frontmatterKeySites(lines: Iterable<string>): Map<string, KeySite> {
  return scanFrontmatter(lines).keys;
}

// LOCATING A PROPERTY'S VALUE
// ================================================================================================

/** A caret sitting in a frontmatter property's *value*: which property it is, and where on the line
 *  that value starts. */
export interface PropertyValueSite {
  /** The property's dotted path, as {@link PropertyBinding.key} and Obsidian's property UI spell
   *  it. */
  key: string;

  /** The column the value text begins at (just past `key:` and one space). */
  valueCh: number;
}

/**
 * The property whose value the caret is inside, or `null` when it is anywhere else — a different
 * line, the key half, or a note with no frontmatter.
 *
 * This is what lets the editor's completer treat a Numbat-typed property's value as Numbat code:
 * the caller maps the key to a type assignment and slices the line at `valueCh`, so the completion
 * logic sees the expression alone and not the YAML around it (`total: costs.` must not read as a
 * `:` type annotation).
 *
 * A key with no value text yet (`total:`) still counts — that is exactly when completion is most
 * wanted — but the caret must be past the colon. An **array item** counts too, under the key its
 * type assignment lives at: the caret in `- 5 EUR` under `rates:` is in `rates.#`, and in `- pace:
 * 5 min/km` it is in `people.#.pace`.
 */
export function propertyValueAt(
  lines: readonly string[],
  line: number,
  ch: number,
): PropertyValueSite | null {
  const text = lines[line];
  if (text === undefined) {
    return null;
  }

  const scan = scanFrontmatter(lines);
  for (const [key, site] of scan.keys) {
    if (site.line !== line) {
      continue;
    }

    // Everything up to and including the colon is the key half; the value begins after the single
    // space YAML writes (or at the colon for a bare `key:`).
    const colon = text.indexOf(":", site.ch);
    if (colon === -1) {
      return null;
    }

    const valueCh = Math.min(colon + 2, text.length);
    return ch >= valueCh ? { key, valueCh } : null;
  }

  // An item's value starts past the dash (or past its own `key:` within the item), and it has no
  // key half of its own to guard.
  const item = scan.items.get(line);
  return item !== undefined && ch >= item.valueCh ? item : null;
}

/** A trailing YAML comment: a `#` at the start of the value or preceded by whitespace. **A tab
 *  counts**, which is why this is a character class rather than the literal space it reads as —
 *  a comment {@link quoteZonedTimestamps} fails to strip makes the value in front of it match
 *  nothing, and the timestamp then goes unquoted and reads two ways. */
const COMMENT_TAIL = /(^|[\x20\t])#.*$/;

/**
 * A frontmatter body with every **zoned** timestamp quoted, so the YAML parser hands it back as the
 * text it was written as rather than as an instant.
 *
 * This exists because a note is read two ways. Obsidian's property cache stores plain data and
 * keeps a zoned timestamp verbatim; the note's own YAML is parsed, and a parser turns
 * `2026-07-27T10:30:00+02:00` into a `Date` — at which point the offset is gone and the value is
 * indistinguishable from a bare `2026-07-27 08:30`. The same note therefore bound one thing in
 * Source mode and another in the widget, the scope inspector, and every import. Quoting first makes
 * both surfaces read the same string, and the disagreement stops existing rather than being
 * documented.
 *
 * **Only a value carrying an offset is touched.** A bare `due: 2026-07-27` and an offset-less
 * `when: 2026-07-27 10:30` have nothing to lose to the parser and are returned exactly as they
 * came — which is what keeps a date a date. Quoting is also a no-op for the shapes a parser already
 * declines to read as timestamps (`2026-07-27+02:00`, and any time without seconds); they are
 * quoted anyway, because "has an offset" is a rule about the value and not about one parser's
 * table.
 *
 * The lines to consider come from {@link scanFrontmatter}, not from matching the text again. That
 * is the whole safety argument: a timestamp inside a `|` block scalar, a flow mapping, or the
 * continuation of a multi-line plain scalar is not a value site, gets no entry, and so cannot be
 * rewritten by something with no idea it is inside a string.
 */
export function quoteZonedTimestamps(body: string[]): string[] {
  // `scanFrontmatter` reads a whole note and strips the delimiters itself, so they go back on; its
  // line numbers then line up with `body` one-indexed.
  const { values } = scanFrontmatter(["---", ...body, "---"]);
  if (values.size === 0) {
    return body;
  }

  return body.map((text, index) => {
    const valueCh = values.get(index + 1);
    if (valueCh === undefined) {
      return text;
    }

    const raw = text.slice(valueCh);
    const stripped = raw.replace(COMMENT_TAIL, "$1");
    const scalar = stripped.trim();
    if (scalar.startsWith("\"") || scalar.startsWith("'")) {
      return text; // already a string, whatever it looks like
    }

    const match = DATE_TEXT.exec(scalar);
    if (match === null || match[3] === undefined) {
      return text; // not a date, or a date with no offset to protect
    }

    // A single-quoted YAML scalar spells its own quote `''`, and {@link DATE_TEXT}'s bracketed zone
    // group admits one — `[Africa/N'Djamena]`, a plausible misremembering of the real
    // `Africa/Ndjamena`. Unescaped, that would close the string early and leave the *whole note* as
    // unparseable YAML, which {@link notePreamble} absorbs into an empty preamble: every binding in
    // the note would vanish in Source mode while the cache path still had them, which is precisely
    // the disagreement this function exists to end. The inverse is {@link unquote}.
    const quoted = scalar.replace(/'/g, "''");

    // Sliced out of `raw` rather than `stripped`: the two agree up to the comment, so this keeps
    // the value's own leading space and everything after it — the comment included — as written.
    const lead = stripped.length - stripped.trimStart().length;
    return `${text.slice(0, valueCh)}${raw.slice(0, lead)}'${quoted}'${raw.slice(stripped.trimEnd().length)}`;
  });
}

/**
 * The lines between a note's frontmatter delimiters, both excluded, or `null` when it has no
 * frontmatter (nothing on line 0 that opens it, or nothing that closes it).
 *
 * Accepts any iterable so the editor can pass a CodeMirror line cursor straight through, as
 * elsewhere in the plugin, and returns at the closing delimiter rather than draining it, so a
 * whole-document cursor costs the frontmatter rather than the note.
 */
export function frontmatterBody(lines: Iterable<string>): string[] | null {
  const body: string[] = [];
  let first = true;

  for (const text of lines) {
    if (first) {
      first = false;
      if (!FRONTMATTER_OPEN.test(text)) {
        return null;
      }
      continue;
    }

    if (FRONTMATTER_CLOSE.test(text)) {
      return body;
    }

    body.push(text);
  }
  return null; // no opener, or an opener that never closed
}

/**
 * The code that is in scope *at* one property: the note's cross-note imports, then the bindings of
 * the properties written above it.
 *
 * This is never the properties below it, and never the note's blocks (as the preamble evaluates
 * before them). One chunk per statement, matching how every other replay absorbs a broken one.
 *
 * `key` is the property's dotted path (`costs.total`), the form both {@link PropertyBinding.key}
 * and Obsidian's property UI use, so the stop applies to a nested property as exactly as to a
 * top-level one. An array *item*'s key (`rates.#`) stops at its array, which is the binding it is
 * part of so an item is written against the scope its whole list has, not against the list's own
 * previous value.
 *
 * Shared by the three surfaces that must agree on what a property can see: the widget's evaluation,
 * the widget's completer, and the Source-mode completer.
 */
export function scopeChunksAbove(preamble: NotePreamble, key: string): string[] {
  const stop = bindingKey(key);
  const chunks = [...(preamble.imports ?? [])];
  for (const binding of preamble.bindings) {
    if (binding.key === stop) {
      break;
    }
    chunks.push(...binding.defs, binding.code);
  }

  return chunks;
}
