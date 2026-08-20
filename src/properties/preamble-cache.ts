// Memos for the note-preamble derivation and the cross-note import walk.
//
// Deriving a preamble is not expensive on its own (tens of microseconds), but nothing calls it only
// once. A keystroke in an open note runs it from the inlay plugin, the inline-eval plugin twice
// more, and the scope inspector; a property widget runs it per property, so a note with forty of
// them derives the same preamble forty times; a Bases table renders one widget per numbat column
// per row, each deriving its own note's. And with `numbat-use` in play each derivation also walks
// the import graph transitively, deriving a preamble for every imported note as it goes, the
// multiplier that turns a small cost into a visible one.
//
// The memos below make each of those repetitions a map lookup. They are deliberately dumb: no
// incremental recomputation, no partial reuse, just "this exact input was asked for a moment ago".
//
// # What makes a hit safe
//
// Two mechanisms, and the difference between them matters:
//
//   - **Content keys** — {@link cachedForBody} and {@link cachedImportWalk} key on the frontmatter
//     text and on the `numbat-use` targets respectively. These are exact: equal key, equal input.
//   - **Record identity** — {@link cachedForRecord} and {@link cachedExports} derive from
//     Obsidian's parsed `frontmatter` object, which has no cheap content key, so they hit only
//     while the *same object* comes back from the metadata cache. Obsidian replaces it on
//     re-parse, so a changed note misses by construction.
//
// Identity is the primary guard rather than a bonus, and that is the deliberate choice: relying on
// invalidation alone would mean an event this plugin failed to hear became a permanently stale
// reading, while relying on identity alone can only cost a recomputation. The explicit invalidation
// below is therefore belt-and-braces — dropping an entry early is always safe.
//
// **With one exception.** Neither guard is about the notes a preamble *imports*: an edit to an
// imported note moves neither the importer's frontmatter text nor its record object, so both memos
// go on hitting. For an importing note the invalidation below is the only possible guard. This is
// what the cap on the walk memo is really protecting (see `IMPORT_WALK_CACHE_ENTRIES`), and why
// that one number is derived from the others rather than chosen.
//
// The consequence to know when measuring: if a future Obsidian ever hands back a fresh frontmatter
// object per call, those two memos quietly stop hitting rather than going wrong. Count calls to
// `derivePreamble` if the widget path ever looks slower than it should.
//
// # Invalidation
//
// {@link invalidatePreamblesFor} is path-scoped, because a global bump on every note change would
// defeat the memo for every row of a Bases table while you type in one note. It drops the note's
// own entries *and* every note that imported it — the import walk's `order` is the record of who
// imported whom, and it is transitive, so a change three notes deep drops the whole chain.
//
// That makes {@link walks} the reverse index, which is the second job it does and the one that
// sizes it: an importer whose walk has been evicted is an importer this cannot find, and per the
// exception above nothing else would. `IMPORT_WALK_CACHE_ENTRIES` is therefore large enough to hold
// one entry for every note the two preamble memos can be holding at once: a relationship written
// into the constant rather than left to two numbers agreeing by luck.
//
// Not covered, and unchanged from before this module existed: creating a note that makes a
// previously-dangling `[[link]]` resolve does not re-run the importers' walks. The module graph has
// the same gap (`ModuleGraph.noteChanged` ignores a path it holds nothing for), so this adds no new
// staleness — it just persists it until the next edit rather than until the next render.
//
// # Sharing
//
// Results are handed out, not copied, so **callers must treat a `NotePreamble` as immutable**.
// Nothing mutates one today — `scope/model.ts` maps into fresh entries and `attachImports` spreads
// into a new object — but that was incidental before and is load-bearing now.

import {
  IMPORT_WALK_CACHE_ENTRIES,
  PREAMBLE_BODY_CACHE_ENTRIES,
  PREAMBLE_EXPORT_CACHE_ENTRIES,
  PREAMBLE_FILE_CACHE_ENTRIES,
} from "../tuning";
import type { NotePreamble, PropertyBinding } from "./parse";

// The key separator: a NUL, which cannot occur in a vault path, in note text, or in a settings
// value the user can type. Built with `fromCharCode` so no literal NUL byte is ever written into
// this source file.
const SEP = String.fromCharCode(0);

/** What a note contributes to the notes that `numbat-use` it — see `importedPropsChunks`. */
export interface ExportedProps {
  /** The chunks to replay, in order. */
  chunks: string[];

  /** The bindings those chunks came from, so the scope inspector can list an imported object one
   *  row per leaf instead of re-parsing the chunk text. */
  bindings: PropertyBinding[];
}

/** A flattened transitive import walk — see `collectImports`. */
export interface ImportWalk {
  /** Every imported chunk, in replay order. */
  chunks: string[];

  /** The notes visited, deepest dependency first. Doubles as this entry's dependency list. */
  order: string[];
}

/**
 * The settings the preamble derivation reads. Structural rather than `SymbatSettings` so this
 * module needs nothing from `main.ts` and a test can hand it a literal; `plugin.settings` satisfies
 * it.
 */
export interface PreambleSettings {
  noteProperties: boolean;
  notePropertyNumbers: boolean;
  notePropertyText: boolean;
  notePropertyDates: boolean;
  notePropertyBooleans: boolean;
  noteImports: boolean;
  notePropertyDefaultZone: string;
}

// Bumped when the prelude's reserved-name set arrives or is dropped. It is not a setting, but the
// derivation reads it (a property named after a prelude unit is skipped), and it moves *silently* —
// `primeReservedNames` fills the set from an evaluation path, announcing nothing.
let reservedEpoch = 0;

/**
 * Everything outside the note itself that the derivation depends on, as one comparable string.
 *
 * Cheap enough to build per call — seven field reads against a derivation that walks all of a
 * note's frontmatter — which is what lets the memos be self-invalidating for settings rather than
 * relying on every settings write path remembering to clear them.
 *
 * Type *assignments* are the one input not folded in here: they live in Obsidian's registry, keyed
 * by property name, with no summary to read. {@link invalidateAllPreambles} covers them, from the
 * `metadataTypeManager` "changed" handler.
 */
export function preambleStamp(settings: PreambleSettings): string {
  return [
    settings.noteProperties ? "1" : "0",
    settings.notePropertyNumbers ? "1" : "0",
    settings.notePropertyText ? "1" : "0",
    settings.notePropertyDates ? "1" : "0",
    settings.notePropertyBooleans ? "1" : "0",
    settings.noteImports ? "1" : "0",
    String(reservedEpoch),
    // Free text, so it goes last — everything before it is a fixed-shape field.
    settings.notePropertyDefaultZone,
  ].join(SEP);
}

/** Note that the prelude's reserved names have arrived or been dropped, so every memoized
 *  derivation made under the old set is stale. */
export function bumpReservedEpoch(): void {
  reservedEpoch += 1;
}

// THE MEMOS
// ================================================================================================

/** A memo of something derived from a frontmatter record, valid while that object comes back. */
interface RecordEntry<T> {
  record: object;
  stamp: string;
  value: T;
}

/** Note path → its preamble, as derived from the metadata cache's record. */
const byRecord = new Map<string, RecordEntry<NotePreamble>>();

/** `path SEP stamp SEP frontmatterText` → the preamble derived from that text. */
const byBody = new Map<string, NotePreamble>();

/** Note path → what it exports to its importers. */
const exported = new Map<string, RecordEntry<ExportedProps>>();

/** `path SEP stamp SEP uses` → that note's flattened import walk, with the importer kept beside it
 *  so an invalidation can find the entry's owner from the entry. */
const walks = new Map<string, { importer: string; value: ImportWalk; }>();

/**
 * The preamble for a note's parsed frontmatter record, derived once per record object.
 *
 * `record` is the hit condition, not part of the key: see the header on why identity leads here.
 */
export function cachedForRecord(
  path: string,
  record: object,
  stamp: string,
  compute: () => NotePreamble,
): NotePreamble {
  const hit = byRecord.get(path);
  if (hit !== undefined && hit.record === record && hit.stamp === stamp) {
    promote(byRecord, path, hit);
    return hit.value;
  }

  const value = compute();
  remember(byRecord, path, { record, stamp, value }, PREAMBLE_FILE_CACHE_ENTRIES);
  return value;
}

/**
 * The preamble for a note's frontmatter *text* — the buffer-accurate path, and the one a keystroke
 * runs several times over identical input.
 */
export function cachedForBody(
  path: string,
  body: string[],
  stamp: string,
  compute: () => NotePreamble,
): NotePreamble {
  const key = bodyKey(path, stamp, body);
  const hit = byBody.get(key);
  if (hit !== undefined) {
    promote(byBody, key, hit);
    return hit;
  }

  const value = compute();
  remember(byBody, key, value, PREAMBLE_BODY_CACHE_ENTRIES);
  return value;
}

/** What one imported note contributes, derived once per record object — the walk asks for this once
 *  per importer, so a note imported by five open notes would otherwise derive five times. */
export function cachedExports(
  path: string,
  record: object,
  stamp: string,
  compute: () => ExportedProps,
): ExportedProps {
  const hit = exported.get(path);
  if (hit !== undefined && hit.record === record && hit.stamp === stamp) {
    promote(exported, path, hit);
    return hit.value;
  }

  const value = compute();
  remember(exported, path, { record, stamp, value }, PREAMBLE_EXPORT_CACHE_ENTRIES);
  return value;
}

/**
 * One note's flattened transitive import walk.
 *
 * Keyed on the note's `numbat-use` targets rather than on its frontmatter, because those are the
 * only part of it the walk reads — so typing in *any other property* re-derives the note's own
 * bindings (which did change) without re-walking its imports (which did not). That is the whole
 * point of keeping this memo apart from the two above, which cache the finished preamble.
 */
export function cachedImportWalk(
  path: string,
  uses: string[],
  stamp: string,
  compute: () => ImportWalk,
): ImportWalk {
  const key = [path, stamp, uses.join("\n")].join(SEP);
  const hit = walks.get(key);
  if (hit !== undefined) {
    promote(walks, key, hit);
    return hit.value;
  }

  const value = compute();
  remember(walks, key, { importer: path, value }, IMPORT_WALK_CACHE_ENTRIES);
  return value;
}

// INVALIDATION
// ================================================================================================

/**
 * A note changed on disk (or in the metadata cache): drop what was derived from it, and what any
 * note that imported it derived *including* it.
 *
 * The reverse index is the walk memo itself, scanned linearly. A handful of entries makes that
 * cheaper than keeping a dependents map in step with eviction, and it cannot drift out of sync with
 * the thing it describes.
 */
export function invalidatePreamblesFor(path: string): void {
  dropNote(path);

  for (const [key, entry] of [...walks]) {
    // `order` is the transitive visit list, so a change three notes deep still reaches every
    // importer above it.
    if (entry.value.order.includes(path)) {
      walks.delete(key);
      dropNote(entry.importer);
    }
  }
}

/** Drop everything — the type assignments moved, a setting the stamp cannot see changed, or link
 *  resolution changed under a rename or delete. */
export function invalidateAllPreambles(): void {
  byRecord.clear();
  byBody.clear();
  exported.clear();
  walks.clear();
}

/** Everything memoized *about* one note, as opposed to everything derived *from* it. */
function dropNote(path: string): void {
  byRecord.delete(path);
  exported.delete(path);

  const prefix = path + SEP;
  for (const key of [...byBody.keys()]) {
    if (key.startsWith(prefix)) {
      byBody.delete(key);
    }
  }
  for (const [key, entry] of [...walks]) {
    if (entry.importer === path) {
      walks.delete(key);
    }
  }
}

// KEYS AND EVICTION
// ================================================================================================

/**
 * The {@link cachedForBody} key.
 *
 * The stamp contains separators of its own, which would make the split ambiguous but for the note
 * text coming last and containing no NUL — so the final separator is always the one before the
 * body, whatever shape the stamp has.
 */
function bodyKey(path: string, stamp: string, body: string[]): string {
  return [path, stamp, body.join("\n")].join(SEP);
}

/**
 * Move an entry to the young end, so {@link evict} reads as least-recently-*used* rather than
 * least-recently-*written*. The insertion order of a `Map` is the only order it has, so a re-insert
 * is the mechanism.
 *
 * Applied on a hit as well as on a write. `Map.set` on a key already present leaves it where it
 * was, so under write order a note derived once and then read all session keeps the position it was
 * first inserted at and is evicted ahead of notes nobody has looked at since. That is precisely the
 * wrong way round for the caps here, which are sized against a Bases table
 * (properties/outcome-cache.ts makes the same argument about the same shape).
 */
function promote<T>(cache: Map<string, T>, key: string, entry: T): void {
  cache.delete(key);
  cache.set(key, entry);
}

/** Record an entry at the young end and trim to the cap. */
function remember<T>(cache: Map<string, T>, key: string, entry: T, cap: number): void {
  promote(cache, key, entry);
  evict(cache, cap);
}

/** Trim a cache to its cap, least-recently-used first (see {@link promote}). An evicted entry costs
 *  one re-derivation, so the cap still matters more than the policy but not so much that the policy
 *  should be the one that thrashes. */
function evict<T>(cache: Map<string, T>, cap: number): void {
  while (cache.size > cap) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
}
