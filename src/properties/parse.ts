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
}

/** Why a property contributed no binding. `reserved` and `unsupported` are surfaced as errors on
 *  numbat-typed properties; the rest are quiet. */
export type PropertySkipReason = "reserved" | "invalid-name" | "duplicate" | "empty" | "unsupported";

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

  /** Disambiguates the struct type names an object binding generates. A note's properties and those
   *  of every note it imports replay into one interpreter, and a repeated `struct` definition is a
   *  hard error (where a repeated `let` is harmless), so the emitting note's path goes here.
   *  Defaults to `""`, which is safe for a note that imports nothing. */
  namespace?: string;
}

/** Property types whose value is a checkbox — the tri-state core one, whose *unset* state is a
 *  `null` that binds `false`, and Better Properties' two-state toggle. */
const CHECKBOX_TYPES: ReadonlySet<string> = new Set(["checkbox", "better-properties:toggle"]);

/** Property types whose value is a date, so text under one reads as a date rather than as text. */
const DATE_TYPES: ReadonlySet<string> = new Set(["date", "datetime", "better-properties:datecustom"]);

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

/** A date, optionally with a time and an explicit UTC offset — `2026-07-27`, `2026-07-27 10:30`,
 *  `2026-07-27T10:30:00.5+02:00`. Matched textually rather than parsed into a `Date`, so no
 *  timezone conversion can happen behind the scenes. */
const DATE_TEXT = /^(\d{4}-\d{2}-\d{2})(?:[T\x20](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?\x20*(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * The Numbat expression for a date written as `date`, `time` and `zone` parts, in the *calendar
 * fields as written* — no conversion, ever.
 *
 * Which function is emitted carries the meaning:
 *
 *  - **A date alone** is `date("2026-07-27")`, which Numbat reads as local midnight. A `due:` on a
 *    note is a day in the reader's life, not a day in UTC.
 *  - **A time with no offset** is `datetime("2026-07-27 10:30:00")` — the *space*-separated form,
 *    which Numbat reads as local wall-clock. (The `T`-separated form is a runtime error without an
 *    offset, which is exactly the shape Better Properties writes, so the separator is swapped.)
 *  - **An explicit offset** is kept verbatim, in the `T` form that requires one.
 *
 * Numbat wants whole seconds, so a bare `HH:MM` is filled out and a fractional second dropped —
 * frontmatter that carries one is being read as a moment, not as a measurement.
 */
function dateExpression(date: string, time: string | undefined, zone: string | undefined): string {
  if (time === undefined) {
    return `date("${date}")`;
  }

  const seconds = time.length === 5 ? `${time}:00` : time;
  return zone === undefined
    ? `datetime("${date} ${seconds}")`
    : `datetime("${date}T${seconds}${zone}")`;
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
 * The Numbat literal an *untyped* value rides along as, or `null` when its kind does not bind —
 * either because the setting for it is off, or because nothing sensible could be written.
 *
 * `key` is the property's dotted path, which the two type-directed readings need: an unset checkbox
 * (a `null` that means `false`) and a date, which is only ever read as one under a property the
 * type menu says is a date.
 */
function plainExpression(walk: Walk, key: string, value: unknown): { expr: string; kind: PlainKind; } | null {
  const { plain } = walk.rules;
  const declared = () => walk.rules.assignedType?.(key) ?? null;

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
      return { expr: dateExpression(match[1], match[2], match[3]), kind: "date" };
    }
  }

  return plain.text ? { expr: stringLiteral(text), kind: "text" } : null;
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
type ItemKind =
  /** A scalar: the plain kind it rode along as, or an expression whose type only Numbat knows. */
  | { of: PlainKind | "expression"; }
  /** A list, and the kind of its own elements — `null` for an empty one, which has no element type
   *  to disagree with and so fits beside any list. */
  | { of: "list"; element: ItemKind | null; }
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

/** One built array element: the Numbat literal to write into the list, and what its siblings are
 *  held to. */
interface ItemValue {
  /** The element as Numbat source. */
  expr: string;

  /** The kind every sibling must match, so an untyped `[1, "a"]` — or `[{a: 1}, {a: "x"}]`, which
   *  differs only under its field names — stays out rather than binding a list Numbat rejects. */
  kind: ItemKind;
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
  if (a.of === "list") {
    // An empty list has no element type of its own; Numbat gives it whatever its neighbours have.
    return b.of === "list" && (a.element === null || b.element === null || sameKind(a.element, b.element));
  }

  if (a.of === "struct") {
    if (b.of !== "struct" || a.fields.length !== b.fields.length) {
      return false;
    }

    return a.fields.every((field) => {
      const other = b.fields.find((candidate) => candidate.name === field.name);
      return other !== undefined && sameKind(field.kind, other.kind);
    });
  }

  return a.of === b.of;
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
  if (a.of === "list" && b.of === "list") {
    const element = a.element === null || b.element === null
      ? a.element ?? b.element
      : refine(a.element, b.element);
    return { of: "list", element };
  }

  if (a.of === "struct" && b.of === "struct") {
    const fields = a.fields.map((field) => {
      const other = b.fields.find((candidate) => candidate.name === field.name);
      return other === undefined ? field : { name: field.name, kind: refine(field.kind, other.kind) };
    });
    return { of: "struct", fields };
  }

  return a;
}

/**
 * The plain kind an untyped array's own binding reports — the scalar its items ultimately hold,
 * seen through any nesting — or `null` when there is nothing scalar in it to go on (an empty array,
 * or one of objects).
 */
function scalarKind(kind: ItemKind | null): PlainKind | null {
  if (kind === null) {
    return null;
  }

  if (kind.of === "list") {
    return scalarKind(kind.element);
  }

  return kind.of === "struct" || kind.of === "expression" ? null : kind.of;
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
function listExpression(
  walk: Walk,
  state: ListState,
  path: string[],
  items: readonly unknown[],
  typed: boolean,
  depth: number,
  ancestors: Set<object>,
): { expr: string; element: ItemKind | null; } | null {
  const itemPath = [...path, ARRAY_ITEM];
  const parts: string[] = [];

  // What the items seen so far collectively hold, which the next one is held to.
  let first: ItemKind | undefined;

  for (const [index, item] of items.entries()) {
    const built = itemValue(walk, state, itemPath, item, typed, depth + 1, ancestors);
    if (built === null) {
      state.error ??= `item ${index + 1} holds nothing Numbat can bind`;
      return null;
    }

    if (first === undefined) {
      first = built.kind;
    } else if (!sameKind(first, built.kind)) {
      state.error ??= first.of === "struct" && built.kind.of === "struct"
        ? `item ${index + 1} does not have the fields item 1 has — every item of an array binds alike`
        : `item ${index + 1} is not the same kind of value as item 1 — a Numbat list holds one type`;
      return null;
    } else {
      // Each item is held to the first, so what the first is missing (the element type of an empty
      // list) has to be folded back in, or a third item could disagree with the second unchecked.
      first = refine(first, built.kind);
    }

    parts.push(built.expr);
  }

  return { expr: `[${parts.join(", ")}]`, element: first ?? null };
}

/** One element (or one field of one), built at its own path. `typed` is that path's reading, as
 *  already resolved by the caller. */
function itemValue(
  walk: Walk,
  state: ListState,
  path: string[],
  value: unknown,
  typed: boolean,
  depth: number,
  ancestors: Set<object>,
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
        const nested = listExpression(
          walk,
          state,
          path,
          value,
          typed || walk.rules.isNumbatTyped(dottedKey([...path, ARRAY_ITEM])),
          depth,
          ancestors,
        );
        return nested === null ? null : { expr: nested.expr, kind: { of: "list", element: nested.element } };
      }

      return structValue(walk, state, path, value, typed, depth, ancestors);
    } finally {
      ancestors.delete(value);
    }
  }

  if (typed) {
    const text = expressionText(value);
    if (text === null || text === "") {
      return null;
    }

    state.expressions = true;
    return { expr: `(${text})`, kind: { of: "expression" } };
  }

  const plain = plainExpression(walk, dottedKey(path), value);
  if (plain === null) {
    return null;
  }

  return { expr: plain.expr, kind: { of: plain.kind } };
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
  const fields: string[] = [];
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
    );

    if (built === null) {
      continue; // not a participant, as anywhere else
    }

    const name = fieldName(walk, state, here, bound);
    if (name === null) {
      continue;
    }

    fields.push(`${name}: (${built.expr})`);
    bound.push({ name, kind: built.kind });
  }

  if (fields.length === 0) {
    return null; // an element with nothing bindable in it
  }

  const dotted = dottedKey(path);
  let name = state.structs.get(dotted);
  if (name === undefined) {
    // The generation slot is a constant `0`: unlike an object property, whose `let` is rebuilt (and
    // retyped) once per leaf, an array's element type is declared once.
    name = `_Nb_${structLabel(dotted)}_${state.hash}_0_${state.structs.size}`;
    state.structs.set(dotted, name);

    const params = bound.map((_, index) => `T${index}`);
    const decls = bound.map((field, index) => `${field.name}: T${index}`);
    state.defs.push(`struct ${name}<${params.join(", ")}> { ${decls.join(", ")} }`);
  }

  return { expr: `${name} { ${fields.join(", ")} }`, kind: { of: "struct", fields: bound } };
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
): { expr: string; defs: string[]; expressions: boolean; plainKind: PlainKind; } | null {
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
  };

  const list = depth >= MAX_PROPERTY_DEPTH
    ? null
    : listExpression(walk, state, path, value, typed, depth, new Set<object>([value]));

  if (list === null) {
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

  return {
    expr: list.expr,
    defs: state.defs,
    expressions: state.expressions,
    // `number` for a list with nothing scalar in it to go on — an empty array, or one of objects.
    plainKind: scalarKind(list.element) ?? "number",
  };
}

// DERIVING ONE BINDING
// ================================================================================================

/** The expression a property contributes, or `null` when it contributes nothing — either quietly
 *  (the common case: an untyped non-number) or as a pushed skip. */
function leafExpression(
  walk: Walk,
  path: string[],
  value: unknown,
  depth: number,
): { expr: string; defs: string[]; kind: "expression" | PlainKind; } | null {
  const key = dottedKey(path);
  const typed = walk.rules.isNumbatTyped(key);

  if (Array.isArray(value)) {
    // An array is typed by its own key (a type menu applied to the whole property) or by its item
    // key (`rates.#`, which is where Better Properties keeps it) — either way, every item is then
    // an expression. Untyped, its items ride along under the same rules a lone value does, so a
    // reader who binds no plain value at all binds no list either — including the empty one, which
    // has no item to say so on its behalf.
    const items = typed || walk.rules.isNumbatTyped(dottedKey([...path, ARRAY_ITEM]));
    const { numbers, text, dates, booleans } = walk.rules.plain;
    if (!items && !(numbers || text || dates || booleans)) {
      return null;
    }

    const list = arrayExpression(walk, path, value, items, depth);
    if (list === null) {
      return null;
    }

    return {
      expr: list.expr,
      defs: list.defs,
      kind: items || list.expressions ? "expression" : list.plainKind,
    };
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

    if (expr === "") {
      walk.skips.push({ key, path, reason: "empty", message: `property '${key}' is empty` });
      return null;
    }

    return { expr, defs: [], kind: "expression" };
  }

  const plain = plainExpression(walk, key, value);
  if (plain === null) {
    return null; // not a participant — no skip entry, this is the common case
  }

  return { expr: plain.expr, defs: [], kind: plain.kind };
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
 * nothing here has to know a dimension.
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

  const leaf = leafExpression(walk, path, value, depth);
  if (leaf === null) {
    return;
  }

  // Only a numbat-typed leaf is owed the reason a name could not be had; see claimName.
  const report = leaf.kind === "expression";

  const key = dottedKey(path);
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
  });
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
  const walk: Walk = { rules, bindings: [], skips: [], taken: new Set<string>() };
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
      const state: ObjectState = {
        rootKey: key,
        rootName: "",
        hash: "",
        fields: [],
        generation: 0,
        claimed: false,
        failed: false,
      };

      walkObject(walk, state, value, [key], new Set<object>([value]), 1);
      continue;
    }

    const path = [key];
    const leaf = leafExpression(walk, path, value, 1);
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
    });
  }

  return {
    bindings: walk.bindings,
    skips: walk.skips,
    source: walk.bindings.flatMap((binding) => [...binding.defs, binding.code]).join("\n"),
  };
}

// YAML frontmatter delimiters, exactly as NoteWalk (evaluation/inline-parse.ts) tracks them: a
// `---` line at the very top, closed by `---` or `...`.

// LOCATING KEYS IN THE SOURCE
// ================================================================================================

/**
 * The YAML body of a note's frontmatter — the lines between the opening `---` and its closing
 * delimiter, both excluded — or `null` when the note has none (no opener on the first line, or an
 * opener that never closes). Accepts any iterable of lines and stops reading at the close, so the
 * editor can pass a document's line cursor without walking the whole note.
 */
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
  const body = frontmatterBody(lines);
  if (body === null) {
    return { keys, items };
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

  return { keys, items };
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

/**
 * The lines between a note's frontmatter delimiters, or `null` when it has no frontmatter (nothing
 * on line 0 that opens it, or nothing that closes it).
 *
 * Accepts any iterable so the editor can pass a CodeMirror line cursor straight through, as
 * elsewhere in the plugin.
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
