// Pure helpers for note-property bindings — turning a note's parsed frontmatter into the Numbat
// `let` bindings that open the note's evaluation scope (the "note preamble"). A property opts in by
// being assigned the plugin's `numbat` property type (its value is then a Numbat expression), and
// untyped properties whose value is a plain number ride along as scalars.
//
// A property nested inside a YAML object participates too: an object binds a Numbat *struct* under
// its own key, so `costs.total` is the name everywhere — the same dotted path Obsidian's property
// UI shows. See {@link derivePreamble}.
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

  /** The complete statement replayed into the note scope: a `let` for a top-level property, and the
   *  struct definition(s) plus the rebuilt `let` of the whole object for a nested one. */
  code: string;

  /** Whether the property is numbat-typed (an expression) or an untyped plain number (a scalar). */
  kind: "expression" | "number";
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
 * not descended by design — a sequence item has no `key:` line to anchor an inlay or a jump on, and
 * no struct field can name an index.
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

/** What {@link derivePreamble} needs to know about the world: which property names are assigned the
 *  numbat type, whether a candidate identifier is already taken by the prelude, and whether plain
 *  numbers bind at all. */
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

  /** Whether untyped plain-number properties bind as scalars. */
  bindNumbers: boolean;

  /** Disambiguates the struct type names an object binding generates. A note's properties and those
   *  of every note it imports replay into one interpreter, and a repeated `struct` definition is a
   *  hard error (where a repeated `let` is harmless), so the emitting note's path goes here.
   *  Defaults to `""`, which is safe for a note that imports nothing. */
  namespace?: string;
}

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

// DERIVING ONE BINDING
// ================================================================================================

/**
 * A YAML array as a Numbat list literal, or `null` when it holds something a list cannot: `[70,
 * 72]` → `[70, 72]`, nesting recursively so `[[1, 2], [3]]` binds.
 *
 * `expressions` is the numbat-typed reading, where each item is an expression in its own right
 * (`["5 EUR", "3 EUR"]` → `[(5 EUR), (3 EUR)]` — parenthesized for the same reason a scalar binding
 * is, so an item like `5 km + 3 mi` stays one element). Without it only plain finite numbers
 * qualify, which is the untyped rule: an array of strings is metadata, not arithmetic, and binding
 * it would put a lot of incidental prose into the note's namespace.
 *
 * Numbat lists are homogeneous, so a mixed array yields a list Numbat rejects. That is deliberate
 * for a typed property — its own type error is a better message than anything guessable here — and
 * unreachable for an untyped one, which never gets past the all-numbers test.
 */
function listExpression(value: readonly unknown[], expressions: boolean): string | null {
  const items: string[] = [];
  for (const item of value) {
    if (Array.isArray(item)) {
      const nested = listExpression(item, expressions);
      if (nested === null) {
        return null;
      }

      items.push(nested);
      continue;
    }

    if (isPlainObject(item)) {
      return null; // a list of structs needs one shared struct type
    }

    if (expressions) {
      const text = expressionText(item);
      if (text === null || text === "") {
        return null;
      }

      items.push(`(${text})`);
      continue;
    }

    if (typeof item !== "number" || !Number.isFinite(item)) {
      return null;
    }

    items.push(String(item));
  }

  return `[${items.join(", ")}]`;
}

/** The expression a property contributes, or `null` when it contributes nothing — either quietly
 *  (the common case: an untyped non-number) or as a pushed skip. */
function leafExpression(
  walk: Walk,
  path: string[],
  value: unknown,
): { expr: string; kind: "expression" | "number"; } | null {
  const key = dottedKey(path);
  if (walk.rules.isNumbatTyped(key)) {
    if (Array.isArray(value)) {
      const expr = listExpression(value, true);

      if (expr === null) {
        walk.skips.push({
          key,
          path,
          reason: "unsupported",
          message: `property '${key}': a Numbat list holds expressions, not objects`,
        });
        return null;
      }

      return { expr, kind: "expression" };
    }

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

    return { expr, kind: "expression" };
  }

  if (!walk.rules.bindNumbers) {
    return null;
  }

  if (Array.isArray(value)) {
    // An array of plain numbers rides along as a list, exactly as a lone number rides along as a
    // scalar; anything else is quietly not a participant.
    const expr = listExpression(value, false);
    return expr === null ? null : { expr, kind: "number" };
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null; // not a participant — no skip entry, this is the common case
  }

  return { expr: String(value), kind: "number" };
}

/** Resolve a top-level Numbat name for `key`, claiming it, or push the skip that says why it could
 *  not be had. */
function claimName(walk: Walk, key: string, path: string[]): string | null {
  const name = sanitizeIdentifier(key);
  if (name === null) {
    walk.skips.push({
      key,
      path,
      reason: "invalid-name",
      message: `property '${key}' has no usable Numbat name`,
    });
    return null;
  }

  if (walk.rules.isReserved(name)) {
    walk.skips.push({
      key,
      path,
      reason: "reserved",
      message: `property '${key}': '${name}' is already a Numbat name — rename the property`,
    });
    return null;
  }

  if (walk.taken.has(name)) {
    walk.skips.push({
      key,
      path,
      reason: "duplicate",
      message: `property '${key}': '${name}' is already bound by an earlier property`,
    });
    return null;
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
function bindNested(walk: Walk, state: ObjectState, path: string[], value: unknown): void {
  if (state.failed) {
    return;
  }

  const leaf = leafExpression(walk, path, value);
  if (leaf === null) {
    return;
  }

  const key = dottedKey(path);
  if (!state.claimed) {
    const rootPath = [state.rootKey];
    const rootName = claimName(walk, state.rootKey, rootPath);

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
      walk.skips.push({
        key,
        path,
        reason: "invalid-name",
        message: `property '${key}' has no usable Numbat name`,
      });
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
      bindNested(walk, state, here, value);
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
 */
export function derivePreamble(frontmatter: Record<string, unknown>, rules: PreambleRules): NotePreamble {
  const walk: Walk = { rules, bindings: [], skips: [], taken: new Set<string>() };
  for (const [key, value] of Object.entries(frontmatter)) {
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
    const leaf = leafExpression(walk, path, value);
    if (leaf === null) {
      continue;
    }

    const name = claimName(walk, key, path);
    if (name === null) {
      continue;
    }

    walk.bindings.push({
      key,
      path,
      name,
      expr: leaf.expr,
      code: `let ${name} = (${leaf.expr})`,
      kind: leaf.kind,
    });
  }

  return {
    bindings: walk.bindings,
    skips: walk.skips,
    source: walk.bindings.map((binding) => binding.code).join("\n"),
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

/**
 * Every frontmatter key, indexed by its dotted path — `costs`, `costs.total`, and so on — with the
 * line, column and extent of each. One pass over the lines, so a note's whole set of property
 * defsites and inlay anchors comes from a single call.
 *
 * The scan is an indent stack governed by two rules:
 *
 *  1. **Only a key with no value text opens a block of child keys.** That is what separates a real
 *     nested key from the three things that merely look like one: a flow mapping (`costs: {total:
 *     2}`), a `|` or `>` block scalar whose body happens to contain `total: 5`, and the
 *     continuation lines of a multi-line plain scalar. Each has value text on its key line, so
 *     nothing beneath it is read as a key.
 *  2. **Only a line at exactly the open block's own indent is a candidate key.** A deeper line is
 *     inside the previous key's value; a shallower one closes blocks until it is not.
 *
 * Everything else — a sequence item, a tab in the indentation, an anchored or aliased value, an
 * explicit `? ` key — is simply not a key line, and is skipped without disturbing the blocks around
 * it. A key that is skipped has no site, which degrades to what a note gets today: no source-mode
 * inlay, and a scope entry that cannot be jumped to. Nested properties under such a key still
 * *bind* — they just have no line to point at.
 */
export function frontmatterKeySites(lines: Iterable<string>): Map<string, KeySite> {
  const sites = new Map<string, KeySite>();
  const body = frontmatterBody(lines);
  if (body === null) {
    return sites;
  }

  // Open mappings, outermost first. `indent` is the column this mapping's keys sit at, unknown
  // (`null`) between the `key:` that opened it and its first child. The root is the entry with an
  // empty path.
  interface Block {
    /** Column this mapping's keys sit at, or `null` before its first child is seen. */
    indent: number | null;

    /** Line of the `key:` that opened it; `-1` for the root. */
    openedAt: number;

    /** The keys leading to it; empty for the root. */
    path: string[];
  }

  const stack: Block[] = [{ indent: null, openedAt: -1, path: [] }];
  let lastContent = 0;
  const close = (block: Block): void => {
    const site = sites.get(dottedKey(block.path));
    if (site !== undefined) {
      site.endLine = lastContent;
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

    // A mapping whose first child never arrived at a deeper indent was empty.
    while (stack.length > 1 && stack[stack.length - 1].indent === null) {
      const pending = stack[stack.length - 1];
      if (indent > pending.openedAt) {
        pending.indent = indent;
        break;
      }
      close(stack.pop() as Block);
    }

    while (stack.length > 1 && indent < (stack[stack.length - 1].indent ?? indent)) {
      close(stack.pop() as Block);
    }

    const block = stack[stack.length - 1];
    block.indent ??= indent; // the root takes the indent of its first key

    lastContent = line;
    if (indent > block.indent) {
      return; // inside the previous key's value
    }

    const match = SEQUENCE_ITEM.test(text) ? null : KEY_LINE.exec(text);
    if (match === null) {
      return; // a sequence item, or something that is not a key line
    }

    const [, , doubled, singled, bare, value] = match;
    const key = doubled !== undefined
      ? unquote(doubled, "\"")
      : singled !== undefined
      ? unquote(singled, "'")
      : (bare ?? "").trim();
    const path = [...block.path, key];
    sites.set(dottedKey(path), { line, ch: indent, endLine: line });

    if (valueText(value) === "") {
      stack.push({ indent: null, openedAt: indent, path });
    }
  });

  while (stack.length > 0) {
    close(stack.pop() as Block);
  }

  return sites;
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
 * wanted — but the caret must be past the colon.
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

  for (const [key, site] of frontmatterKeySites(lines)) {
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

  return null;
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
